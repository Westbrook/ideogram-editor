import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';import {createHash} from 'node:crypto';
import {fixture,prepare,enqueue,auth,encode,envelope} from '../queue/helpers.mjs';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';import {ResultObserver} from '../../dist/local/server/provider/observer.js';
import {emulator,fixtureProfile} from '../provider/emulator.mjs';import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import {resolveInactive} from '../../dist/local/src/request/core.js';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readFile,unlink} from 'node:fs/promises';
import {unpack,records} from '../portable/archive-fixture.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {pair,call,cookieFrom,readHeaders} from '../session/helpers.mjs';
import {PRODUCTION_PROFILE,productionAcknowledgement} from '../../dist/local/server/provider/production-profile.js';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {privacyPolicy} from '../../dist/local/server/portable/provenance.js';
import {ZipIndex,spool} from '../../dist/local/server/portable/zip.js';
async function owned(f){await f.close();const owner=await acquireRoot(f.root),db=new StoreDatabase(f.root,()=>{});let closed=false;return {db,close:async()=>{if(closed)return;closed=true;await db.candidates.close();await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();owner.close();}};}
async function setup(t,{count=1,flags=[false],prompt='Returned Café 東京 https://user-authored.test/path',bad=false,operation='generate',mutate=v=>v,secrets=[],promptRepeat=null,privacyProfile=null,acknowledgement=undefined}={}){
 const cleanup=[],closures=[];let o,server,observer;const f=await fixture({name:t.name,after:fn=>cleanup.push(fn)});t.after(async()=>{observer?.close();for(const close of closures)await close();await o?.close();if(server?.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));for(const fn of cleanup)await fn();});const p=await prepare(f.writer,d=>{d.fields.count=String(count);d.operation=operation;if(operation==='fast'){d.fields.acceleration='none';resolveInactive(d,'acceleration');}if(operation==='instant'){resolveInactive(d,'acceleration');resolveInactive(d,'speed');}}),q=await enqueue(f.writer,p.body);o=await owned(f);const originalPrepare=o.db.rasters.prepareDocument.bind(o.db.rasters);o.db.rasters.prepareDocument=async(...args)=>{try{return await originalPrepare(...args);}catch(error){const rasterRead=o.db.rasters.readDiagnostics();try{t.diagnostic(JSON.stringify({phase:'raster-prepare',code:error.code,message:error.message,rss:process.memoryUsage().rss,resources:rasterRead.value}));}finally{rasterRead.release();}throw error;}};
 const png=await sharp({create:{width:512,height:512,channels:4,background:'#2468ac'}}).png().toBuffer(),effects=[],controls={status:'COMPLETED',resultStatus:200,mediaStatus:200,body:null};let origin='';
 server=createServer(async(req,res)=>{const bytes=Buffer.concat(await Array.fromAsync(req));effects.push({method:req.method,path:req.url,bytes:bytes.length});res.setHeader('Content-Type','application/json');if(req.method==='POST'){const base=origin+req.url+'/requests/fixture_result';res.end(JSON.stringify({request_id:'fixture_result',status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));}else if(req.url.endsWith('/status'))res.end(JSON.stringify({request_id:'fixture_result',status:controls.status}));else if(req.url.startsWith('/image')){res.statusCode=controls.mediaStatus;res.setHeader('Content-Type','image/png');res.end(bad&&req.url==='/image1'?Buffer.from('broken'):png);}else{res.statusCode=controls.resultStatus;const value=mutate({images:Array.from({length:count},(_,i)=>({url:origin+'/image'+i,width:512,height:512,content_type:'image/png'})),has_nsfw_concepts:flags,prompt,seed:31,timings:{inference:0.4}});if(promptRepeat&&controls.body===null){delete value.prompt;const prefix=JSON.stringify(value).slice(0,-1)+',\"prompt\":\"',unit=JSON.stringify(promptRepeat.unit).slice(1,-1);res.setHeader('Content-Length',Buffer.byteLength(prefix)+Buffer.byteLength(unit)*promptRepeat.count+2);res.write(prefix);for(let at=0;at<promptRepeat.count;at+=50000){const chunk=unit.repeat(Math.min(50000,promptRepeat.count-at));if(!res.write(chunk))await once(res,'drain');}res.end('\"}');}else res.end(controls.body??JSON.stringify(value));}});
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 const profile=privacyProfile??fixtureProfile({endpoint:q.job.review.endpoint}),provider=emulator({queueOrigin:origin,mediaOrigin:origin,profiles:[profile]}),dispatcher=new QueueDispatcher(o.db.queue,provider,{queueOrigin:origin,profileId:profile.id,acknowledgement});observer=new ResultObserver(o.db.candidates,provider,dispatcher,profile.id,secrets,acknowledgement);
 await dispatcher.submit(q.job.id);return {f,q,o,provider,dispatcher,observer,png,effects,controls,closures};
}
test('completed Base becomes retained prepared candidate without changing document pixels',async t=>{
 const x=await setup(t),before=x.o.db.document('document_1');await x.observer.tick();const view=x.o.db.candidates.view(x.q.job.id),c=view.items[0];assert.equal(c.state,'prepared');assert.equal(view.provenance.complete,true);assert.equal(view.provenance.timingUnits,'unknown');assert.deepEqual(x.o.db.document('document_1'),before);assert.equal(x.o.db.queue.view().counts.active,0);assert.equal(x.o.db.queue.view().counts.dispatched,1);
 const asset=x.o.db.assets.asset(c.encodedAssetId);assert.equal(asset.blob.hash,'sha256:'+createHash('sha256').update(x.png).digest('hex'));assert.throws(()=>x.o.db.assets.safeAsset(c.encodedAssetId),e=>e.code==='CONTENT_WITHHELD');assert.equal(x.o.db.assets.safeAsset(c.preparedAssetId).safety,'safe');
 const page=x.o.db.candidates.prompt(x.q.job.id,c.attemptId,'returned','0');assert.equal(Buffer.from(page.bytes).toString(),'Returned Café 東京 https://user-authored.test/path');await x.observer.tick(Date.now()+5000);assert.equal(x.effects.filter(e=>e.method==='POST').length,1);assert.equal(x.effects.filter(e=>e.path.endsWith('/status')).length,1);
});
test('independent slots preserve usable image when a different decode fails',async t=>{const x=await setup(t,{count:2,flags:[false,false],bad:true});await x.observer.tick();const v=x.o.db.candidates.view(x.q.job.id);assert.equal(v.items.find(c=>c.outputIndex===0).state,'prepared');const bad=v.items.find(c=>c.outputIndex===1);assert.equal(bad.state,'preparation-failed');assert(bad.encodedAssetId);assert.equal(x.effects.filter(e=>e.method==='POST').length,1);});
test('missing or flagged safety retains protected bytes without public raster',async t=>{const x=await setup(t,{count:2,flags:[true]});await x.observer.tick();for(const c of x.o.db.candidates.view(x.q.job.id).items){assert.equal(c.state,'withheld');assert.equal(c.safety,'unknown');assert(c.encodedAssetId);assert.equal(c.preparedAssetId,null);assert.throws(()=>x.o.db.assets.safeAsset(c.encodedAssetId),e=>e.code==='CONTENT_WITHHELD');}});
test('hide is a visibility tombstone and keeps exact retained bytes',async t=>{const x=await setup(t);await x.observer.tick();const c=x.o.db.candidates.view(x.q.job.id).items[0],original=x.o.db.assets.asset(c.encodedAssetId).blob;const receipt=await x.o.db.queue.command(encode(envelope({type:'HideCandidate',candidateId:c.id,expectedVersion:c.version})),auth());assert.equal(receipt.status,'accepted');assert.equal(x.o.db.candidates.view(x.q.job.id).items[0].hidden,true);assert.deepEqual(x.o.db.assets.asset(c.encodedAssetId).blob,original);x.o.db.objects.verify(original);});

async function portable(db,body,documentId=null,expected='accepted'){const c=envelope(body);c.command.documentId=documentId;c.command.expectedDocumentRevision=documentId?db.document(documentId).revision:null;db.portables.command(encode(c),auth());let record;for(let i=0;i<1000;i++){record=db.lookup(c.command.commandId);if(record)break;await new Promise(r=>setTimeout(r,10));}assert.equal(record?.receipt.status,expected,JSON.stringify(record??db.portables.inventory(auth(),'')));if(expected!=='accepted')return record;const events=db.events(String(BigInt(record.receipt.fromSeq)-1n),100);return events.events.find(e=>e.commandId===c.command.commandId);}
test('full copy includes hidden candidate and import remains inert with remapped identities',async t=>{
 const x=await setup(t);await x.observer.tick();const c=x.o.db.candidates.view(x.q.job.id).items[0];await x.o.db.queue.command(encode(envelope({type:'HideCandidate',candidateId:c.id,expectedVersion:c.version})),auth());
 const prepared=await portable(x.o.db,{type:'SaveCopy'},'document_1'),bundle=prepared.payload.bundle;assert.equal(bundle.status,'copy-ready');const bytes=await readFile(x.o.db.objects.path(bundle.blob)),stagingId=randomUUID(),a=auth();
 x.o.db.assets.create({protocolVersion:1,stagingId,purpose:'bundle',expectedBytes:String(bytes.length),sha256:bundle.blob.hash,mediaType:'application/x-ideogram-project'},a);
 for(let offset=0;offset<bytes.length;offset+=1048576){const chunk=bytes.subarray(offset,offset+1048576),token=x.o.db.assets.beginChunk(stagingId,String(offset),chunk.length,a);x.o.db.assets.chunk(token,chunk,a);}
 const event=await portable(x.o.db,{type:'PreviewBundleImport',stagingId,expectedSha256:bundle.blob.hash}),review=x.o.db.portables.review(event.payload.reviewId,a);assert.equal(review.editable,true);assert.equal(review.formatVersion,9);const mapping=x.o.db.portables.mapping(review.reviewId,a,'job','').items;assert.equal(mapping.length,1);assert.notEqual(mapping[0].localId,x.q.job.id);
 const imported=await portable(x.o.db,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash}),v=x.o.db.candidates.view(mapping[0].localId);assert.equal(v.inert,true);assert.equal(v.items[0].hidden,true);assert.notEqual(v.items[0].id,c.id);assert.notEqual(v.items[0].attemptId,c.attemptId);assert.equal(x.o.db.queue.view().jobs.length,1);await x.observer.tick(Date.now()+5000);assert.equal(x.effects.filter(e=>e.method==='POST').length,1);assert(x.o.db.document(imported.payload.document.id));
 const again=await portable(x.o.db,{type:'SaveCopy'},imported.payload.document.id);assert.equal(again.payload.bundle.status,'copy-ready');
});
test('acknowledged public delivery remains observation-only through completed candidate copy and restore',async t=>{
 // Only the transport mode changes for loopback; persisted policy is exactly the
 // shipped production fallback, resolved by the real dispatcher and observer.
 const acknowledgement=(_jobId,attemptId)=>productionAcknowledgement({id:'public_fallback_observation',attemptId,profileId:PRODUCTION_PROFILE.id,profileVersion:PRODUCTION_PROFILE.version,disclosureDigest:PRODUCTION_PROFILE.fallback.disclosureDigest});
 const x=await setup(t,{privacyProfile:{...PRODUCTION_PROFILE,mode:'fixture'},acknowledgement});await x.observer.tick();const view=x.o.db.candidates.view(x.q.job.id),candidate=view.items[0];assert.equal(candidate.state,'prepared');
 const applied=resolvePrivacy(PRODUCTION_PROFILE,'ideogram/v4',candidate.attemptId,acknowledgement(x.q.job.id,candidate.attemptId)).applied,expected={...applied,evidenceDigest:'sha256:'+applied.evidenceDigest};assert.equal(expected.appliedACL,'public');assert.equal(expected.fallbackAcknowledgementId,'public_fallback_observation');
 assert.deepEqual(JSON.parse(await readFile(x.o.db.objects.path(view.provenance.privacyPolicy))),expected);assert.throws(()=>privacyPolicy({...expected,fallbackAcknowledgementId:null}));assert.throws(()=>privacyPolicy({...expected,authorization:{enabled:true}}));
 const verifyCopy=async(db,documentId)=>{const copy=await portable(db,{type:'SaveCopy'},documentId),bytes=await readFile(db.objects.path(copy.payload.bundle.blob)),entries=await unpack(x.f.root,bytes),entity=records(entries).values.find(r=>r.kind==='entity'&&r.entityType==='portable-provider');assert(entity);const observation=JSON.parse(entries.get('objects/'+entity.payloadRef.hash.slice(7)));assert.deepEqual(JSON.parse(entries.get('objects/'+observation.privacyPolicyRef.hash.slice(7))),expected);assert.equal(entries.get('objects/'+observation.requestedPromptRef.hash.slice(7)).toString(),'Queue exact Café 東京');assert.equal(entries.get('objects/'+observation.returnedPromptRef.hash.slice(7)).toString(),'Returned Café 東京 https://user-authored.test/path');return {copy,bytes};};
 const {copy,bytes}=await verifyCopy(x.o.db,'document_1'),stagingId=randomUUID(),a=auth();x.o.db.assets.create({protocolVersion:1,stagingId,purpose:'bundle',expectedBytes:String(bytes.length),sha256:copy.payload.bundle.blob.hash,mediaType:'application/x-ideogram-project'},a);
 for(let offset=0;offset<bytes.length;offset+=1048576){const chunk=bytes.subarray(offset,offset+1048576),token=x.o.db.assets.beginChunk(stagingId,String(offset),chunk.length,a);x.o.db.assets.chunk(token,chunk,a);}
 const preview=await portable(x.o.db,{type:'PreviewBundleImport',stagingId,expectedSha256:copy.payload.bundle.blob.hash}),review=x.o.db.portables.review(preview.payload.reviewId,a);assert.equal(review.editable,true);const mapping=x.o.db.portables.mapping(review.reviewId,a,'job','').items;assert.equal(mapping.length,1);assert.notEqual(mapping[0].localId,x.q.job.id);
 const imported=await portable(x.o.db,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});assert.equal(x.o.db.candidates.view(mapping[0].localId).inert,true);assert.equal(x.o.db.queue.view().jobs.length,1);await x.observer.tick(Date.now()+5000);const effectCount=x.effects.length;assert.equal(x.effects.filter(e=>e.method==='POST').length,1);
 x.observer.close();await x.o.close();const reopened=await owned(x.f);x.closures.push(reopened.close);assert.equal(reopened.db.candidates.view(mapping[0].localId).inert,true);assert.equal(reopened.db.queue.view().jobs.length,1);await verifyCopy(reopened.db,imported.payload.document.id);assert.equal(x.effects.length,effectCount);
});
for(const operation of ['fast','instant'])test(operation+' uses its exact emulator route and retains one candidate',async t=>{const x=await setup(t,{operation});await x.observer.tick();assert.equal(x.o.db.candidates.view(x.q.job.id).items[0].state,'prepared');assert.equal(x.effects.filter(e=>e.method==='POST')[0].path,operation==='fast'?'/ideogram/v4/fast':'/ideogram/v4/instant');});


test('poll cadence backoff and phase progression persist independently',async t=>{
 const x=await setup(t),now=Date.now();x.controls.status='IN_PROGRESS';await x.observer.tick(now);let v=x.o.db.candidates.view(x.q.job.id);assert.equal(v.observation.nextPollAt,now+2000);await x.observer.tick(now+1000);assert.equal(x.effects.filter(e=>e.path.endsWith('/status')).length,1);
 x.controls.status='IN_QUEUE';await x.observer.tick(now+2000);assert.equal(x.o.db.candidates.view(x.q.job.id).observation.phase,'running');const f=x.o.db.queue.resultFence(x.q.job.id,x.q.job.attempts[0].id);x.o.db.candidates.backoff(f,now+3000,60000,true,0);v=x.o.db.candidates.view(x.q.job.id);assert.equal(v.observation.mode,'offline');assert.equal(v.observation.nextPollAt,now+63000);x.controls.status='COMPLETED';await x.observer.tick(now+63000);assert.equal(x.o.db.candidates.view(x.q.job.id).items[0].state,'prepared');
});
test('contradictory result cannot overwrite a ready original and revokes public access',async t=>{
 const x=await setup(t);await x.observer.tick();const first=x.o.db.candidates.view(x.q.job.id),c=first.items[0],f=x.o.db.queue.resultFence(x.q.job.id,c.attemptId);x.controls.body=JSON.stringify({images:[],seed:19,timings:{},prompt:'contradiction',has_nsfw_concepts:[]});const response=await x.dispatcher.readKnown(f.jobId,f.attemptId,'result'),policy=x.provider.policy({attemptId:f.attemptId,identity:{endpoint:x.q.job.review.endpoint,requestId:f.requestId},profileId:'local-fixture-v1'}).applied;x.o.db.candidates.receive(f,response.evidence,policy,[]);const next=x.o.db.candidates.view(f.jobId);assert.equal(next.observation.phase,'quarantined');assert.equal(next.items[0].encodedAssetId,c.encodedAssetId);assert.throws(()=>x.o.db.assets.safeAsset(c.preparedAssetId),e=>e.code==='CONTENT_WITHHELD');
});
test('old job version and a retained document tombstone block publication without resurrection',async t=>{
 const x=await setup(t),f=x.o.db.queue.resultFence(x.q.job.id,x.q.job.attempts[0].id);await x.observer.tick();assert.throws(()=>x.o.db.queue.assertResult(f),e=>e.code==='STALE_EPOCH');x.o.db.db.prepare('INSERT INTO candidate_document_tombstones VALUES (?,?)').run('document_1','1');assert.throws(()=>x.o.db.queue.resultFence(f.jobId,f.attemptId),e=>e.code==='STALE_EPOCH');assert.deepEqual(x.o.db.candidates.due(Date.now()+5000),[]);assert.throws(()=>x.o.db.candidates.view(f.jobId),e=>e.code==='NOT_FOUND');assert.equal(x.o.db.db.prepare('SELECT count(*) n FROM candidates').get().n,1);
});
for(const [name,mutate,state]of [
 ['missing output',v=>({...v,images:[]}), 'missing'],
 ['invalid optional caption',v=>({...v,prompt:{future:true}}),'prepared'],
 ['wrong image dimensions',v=>({...v,images:v.images.map(i=>({...i,width:513}))}),'prepared'],
 ['string image dimensions',v=>({...v,images:v.images.map(i=>({...i,width:'512'}))}),'preparation-failed'],
 ['flagged safety',v=>({...v,has_nsfw_concepts:[true]}),'withheld'],
 ['malformed timings',v=>({...v,timings:{inference:-1}}),'withheld']
])test(name+' preserves independent owned outcome',async t=>{const x=await setup(t,{mutate});await x.observer.tick();const v=x.o.db.candidates.view(x.q.job.id);assert.equal(v.items[0].state,state);if(name==='wrong image dimensions'){assert(v.items[0].encodedAssetId);assert(v.items[0].preparedAssetId);assert.match(v.items[0].warning,/dimensions differ/);}assert.equal(x.o.db.document('document_1').revision,'1');assert.equal(x.effects.filter(e=>e.method==='POST').length,1);});
test('explicit transfer retry uses the same candidate and never repeats inference',async t=>{
 const x=await setup(t);x.controls.mediaStatus=503;await x.observer.tick();let c=x.o.db.candidates.view(x.q.job.id).items[0];assert.equal(c.state,'transfer-failed');const id=c.id;x.controls.mediaStatus=200;const receipt=await x.o.db.queue.command(encode(envelope({type:'RetryCandidateImport',candidateId:c.id,expectedVersion:c.version})),auth());assert.equal(receipt.status,'accepted');await x.observer.tick();c=x.o.db.candidates.view(x.q.job.id).items[0];assert.equal(c.id,id);assert.equal(c.state,'prepared');assert.equal(x.effects.filter(e=>e.method==='POST').length,1);assert.equal(x.effects.filter(e=>e.path==='/image0').length,2);
});
test('unregistered media origin refuses transfer locally and releases its protected sink reservation',async t=>{
 const x=await setup(t,{mutate:value=>({...value,images:value.images.map(image=>({...image,url:'https://unregistered.example.test/output.png'}))})});
 await x.observer.tick();const candidate=x.o.db.candidates.view(x.q.job.id).items[0];
 assert.equal(candidate.state,'transfer-failed');assert.equal(candidate.safety,'safe');assert.equal(candidate.encodedAssetId,null);assert.equal(candidate.preparedAssetId,null);assert.match(candidate.warning,/same output/);
 assert.equal(x.effects.filter(effect=>effect.path.startsWith('/image')).length,0);assert.equal(x.effects.filter(effect=>effect.method==='POST').length,1);assert.deepEqual(x.o.db.objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});
});
test('known transport secret blocks exact prompt and complete copy but preserves protected original',async t=>{
 const secret='fixture-secret-7fc31',x=await setup(t,{prompt:'Returned '+secret,secrets:[secret]});await x.observer.tick();const v=x.o.db.candidates.view(x.q.job.id),c=v.items[0];assert.equal(v.provenance.quarantined,true);assert.equal(c.state,'prepared');assert.throws(()=>x.o.db.candidates.prompt(v.jobId,c.attemptId,'returned','0'),e=>e.code==='CONTENT_WITHHELD');assert.throws(()=>x.o.db.portables.command(encode({...envelope({type:'SaveCopy'}),command:{...envelope({type:'SaveCopy'}).command,documentId:'document_1',expectedDocumentRevision:'1'}}),auth()),e=>e.code==='CONTENT_WITHHELD');const r=await x.dispatcher.readKnown(v.jobId,c.attemptId,'result');assert(Buffer.concat([...x.o.db.queue.evidence.read(r.evidence.recordId)]).includes(Buffer.from(secret)));
});

test('larger than 16MiB exact Unicode prompt streams into bounded pages and a complete copy',async t=>{
 const expectedBytes=18200000,expectedHash='93ffdb8d229eecfc6962a14294ccc605d629ade05f8e9dcefae0f605a7ec8780';assert(expectedBytes>16*1024*1024);const x=await setup(t,{promptRepeat:{unit:'Café 東京\n',count:1400000}});await x.observer.tick();const v=x.o.db.candidates.view(x.q.job.id),c=v.items[0];assert.equal(c.state,'prepared');assert.equal(v.provenance.returnedBytes,String(expectedBytes));assert.equal(v.provenance.inspection,'opaque');let offset='0',hash=createHash('sha256'),total=0;do{const p=x.o.db.candidates.prompt(v.jobId,c.attemptId,'returned',offset);assert(p.bytes.length<=32768);hash.update(p.bytes);total+=p.bytes.length;offset=p.nextOffset;}while(offset);assert.equal(total,expectedBytes);assert.equal(hash.digest('hex'),expectedHash);const result=await portable(x.o.db,{type:'SaveCopy'},'document_1');assert.equal(result.payload.bundle.complete,true);
 // Reread the copied object through the production disk index and bounded chunks.
 const index=spool(join(x.f.root,randomUUID()+'.sqlite'));let copy;
 try{
  copy=new ZipIndex(x.o.db.objects.path(result.payload.bundle.blob),index);await copy.headers(()=>{});
  const entry=copy.entry('objects/'+expectedHash),copiedHash=createHash('sha256');let copiedBytes=0;
  assert.equal(entry.bytes,BigInt(expectedBytes));
  for await(const chunk of copy.chunks(entry,()=>{})){assert(chunk.length<=1048576);copiedHash.update(chunk);copiedBytes+=chunk.length;}
  assert.equal(copiedBytes,expectedBytes);assert.equal(copiedHash.digest('hex'),expectedHash);
 }finally{try{copy?.close();}finally{index.close();}}
 const rasterRead=x.o.db.rasters.readDiagnostics();try{t.diagnostic(JSON.stringify({fixture:'bounded prompt response; independent literal UTF-8 hash',expectedBytes,expectedHash,raster:rasterRead.value}));}finally{rasterRead.release();}
});
test('reopening rebuilds candidate assets and preserves hidden state and exact prompts',async t=>{
 const x=await setup(t);await x.observer.tick();let v=x.o.db.candidates.view(x.q.job.id),c=v.items[0];await x.o.db.queue.command(encode(envelope({type:'HideCandidate',candidateId:c.id,expectedVersion:c.version})),auth());await x.o.close();const reopened=await owned(x.f);x.closures.push(reopened.close);v=reopened.db.candidates.view(x.q.job.id);assert.equal(v.items[0].hidden,true);assert.equal(reopened.db.assets.safeAsset(c.preparedAssetId).safety,'safe');assert.deepEqual(reopened.db.candidates.history('document_1').items,[{jobId:x.q.job.id,attemptId:c.attemptId,inert:false}]);assert.equal(Buffer.from(reopened.db.candidates.prompt(x.q.job.id,c.attemptId,'requested','0').bytes).toString(),'Queue exact Café 東京');assert.equal(reopened.db.objects.reservationInventory().activeTransfers,0);
});
test('actual HTTP denies original safety bypasses and protected evidence by guessed routes',async t=>{
 const x=await setup(t,{flags:[true]});await x.observer.tick();const c=x.o.db.candidates.view(x.q.job.id).items[0];await x.o.close();const server=await startLocalServer({root:x.f.root});x.closures.push(()=>server.close());const paired=await pair(server),headers=readHeaders(cookieFrom(paired));for(const suffix of ['content','raster'])for(const Range of [undefined,'bytes=0-7']){const r=await call(server.origin,'/api/v1/assets/'+c.encodedAssetId+'/'+suffix,{headers:{...headers,...(Range?{Range}:{})}});assert([403,404].includes(r.status),JSON.stringify({suffix,status:r.status}));}for(const path of ['/backend-transport','/api/v1/backend-transport','/api/v1/assets/'+c.outputIdentity.slice(7)+'/content'])assert([400,403,404,503].includes((await call(server.origin,path,{headers})).status));const thumbnail=await call(server.origin,'/api/v1/assets/'+c.encodedAssetId+'/thumbnail',{headers});assert.equal(thumbnail.status,503);assert(thumbnail.json.error);const view=await call(server.origin,'/api/v1/jobs/'+c.jobId+'/candidates?attempt='+c.attemptId,{headers});assert.equal(view.status,200);assert(!view.text.includes('/image0'));assert(!view.text.includes('fixture-key'));assert.equal((await call(server.origin,'/api/v1/documents/document_1/candidates',{headers})).json.items.length,1);
});

test('unfinished request copies as inert history with exact request prompt and no outbox authority',async t=>{
 const x=await setup(t),copy=await portable(x.o.db,{type:'SaveCopy'},'document_1'),entries=await unpack(x.f.root,await readFile(x.o.db.objects.path(copy.payload.bundle.blob)));const all=records(entries).values,job=all.find(r=>r.kind==='entity'&&r.entityType==='job-result');assert(job);const value=JSON.parse(entries.get('objects/'+job.payloadRef.hash.slice(7)));assert.equal(value.inert,true);assert.equal(value.provenance,null);assert.equal(entries.get('objects/'+value.request.prompt.hash.slice(7)).toString(),'Queue exact Café 東京');assert(!JSON.stringify(all).includes('outbox'));assert(!JSON.stringify(all).includes('status_url'));assert.equal(x.effects.filter(e=>e.method==='POST').length,1);
});
test('missing retained image bytes refuse a complete copy without generating replacements',async t=>{
 const x=await setup(t);await x.observer.tick();const c=x.o.db.candidates.view(x.q.job.id).items[0],a=x.o.db.assets.asset(c.encodedAssetId);await unlink(x.o.db.objects.path(a.blob));const result=await portable(x.o.db,{type:'SaveCopy'},'document_1','rejected');assert.equal(result.receipt.code,'MISSING_ASSET');assert.equal(x.effects.filter(e=>e.method==='POST').length,1);
});
test('caption above control JSON size remains exact opaque text without blocking the image',async t=>{
 const prompt='opaque文'.repeat(16000),x=await setup(t,{prompt});assert(Buffer.byteLength(prompt)>65536);assert(Buffer.byteLength(prompt)<262144);await x.observer.tick();const v=x.o.db.candidates.view(x.q.job.id);assert.equal(v.items[0].state,'prepared');assert.equal(v.provenance.inspection,'opaque');assert.equal(v.provenance.returnedPrompt.hash,'sha256:'+createHash('sha256').update(prompt).digest('hex'));
});

test('background cadence survives writer restart without restarting inference',async t=>{
 const x=await setup(t),now=Date.now();x.controls.status='IN_PROGRESS';await x.observer.tick(now,true);const before=x.o.db.candidates.view(x.q.job.id);assert.equal(before.observation.nextPollAt,now+15000);await x.o.close();const next=await owned(x.f);x.closures.push(next.close);assert.deepEqual(next.db.candidates.view(x.q.job.id).observation,before.observation);assert.equal(next.db.candidates.due(now+14000).length,0);assert.equal(next.db.candidates.due(now+15000).length,0);const job=next.db.queue.view().jobs[0];assert.equal(job.attempts[0].recoveryRequired,true);await next.db.queue.command(encode(envelope({type:'RecoverJob',jobId:job.id,attemptId:job.attempts[0].id,expectedVersion:job.version})),auth());assert.equal(next.db.candidates.due(now+15000).length,1);assert.equal(x.effects.filter(e=>e.method==='POST').length,1);
});
test('actual versus requested count is retained in stable bounded output pages',async t=>{
 const x=await setup(t,{mutate:v=>({...v,images:Array.from({length:40},()=>v.images[0]),has_nsfw_concepts:Array(40).fill(false)})});let f=x.o.db.queue.resultFence(x.q.job.id,x.q.job.attempts[0].id);const status=await x.dispatcher.readKnown(f.jobId,f.attemptId,'status');f=x.o.db.candidates.observe(f,status.evidence,Date.now()).fence;const result=await x.dispatcher.readKnown(f.jobId,f.attemptId,'result'),policy=x.provider.policy({attemptId:f.attemptId,identity:{endpoint:x.q.job.review.endpoint,requestId:f.requestId},profileId:'local-fixture-v1'}).applied;x.o.db.candidates.receive(f,result.evidence,policy,[]);const first=x.o.db.candidates.view(f.jobId),second=x.o.db.candidates.view(f.jobId,f.attemptId,first.nextCursor);assert.equal(first.requestedCount,1);assert.equal(first.actualCount,40);assert.equal(first.items.length,32);assert.equal(second.items.length,8);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.items,...second.items].map(c=>c.id)).size,40);assert(Buffer.byteLength(JSON.stringify(first))<65536);assert.equal(x.effects.filter(e=>e.path.startsWith('/image')).length,0);
});

// These controls declare synthetic external reservation pressure; they allocate
// no pressure buffer and make no native-RSS or 99-asset campaign claim. The real
// preflight/decoder, retained original, command admission and fences stay active.
const syntheticRetryReservation=512*1024*1024;
function syntheticRetryCandidate(x){
 const view=x.o.db.candidates.view(x.q.job.id);assert.equal(view.items.length,1);return view.items[0];
}
function syntheticRetryTransient(x){
 const raster=x.o.db.rasters.resourceOwnership();
 return {objects:x.o.db.objects.resourceOwnership(),proofs:x.o.db.objects.proofInventory(),reservations:x.o.db.objects.reservationInventory(),candidates:x.o.db.candidates.resourceOwnership(),queue:x.o.db.queue.resourceOwnership(),raster:{running:raster.running,documentBusy:raster.documentBusy,activeWorkers:raster.activeWorkers,bookedCPUBytes:raster.bookedCPUBytes,approvalAuthorities:raster.approvalAuthorities}};
}
function syntheticRetryRefusals(x,id){
 const read=x.o.db.rasters.readDiagnostics();
 try{return read.value.observations.filter(row=>row.phase==='resource-preflight'&&row.slot==='candidate-prepare:'+id).map(row=>structuredClone(row));}
 finally{read.release();}
}
function syntheticRetryPreparedRoots(x){
 return Number(x.o.db.db.prepare("SELECT count(*) n FROM roots WHERE owner LIKE 'candidate-prepared:%'").get().n);
}
function syntheticRetryQueueIdentity(x){
 const view=x.o.db.queue.view();
 return {totalJobs:view.totalJobs,counts:view.counts,jobs:view.jobs.map(job=>({id:job.id,attempts:job.attempts.map(attempt=>({id:attempt.id,previousAttemptId:attempt.previousAttemptId,requestId:attempt.requestId,count:attempt.count,spendSessionId:attempt.spendSessionId}))}))};
}
function syntheticRetryAssertDrained(s){
 assert.deepEqual(syntheticRetryTransient(s.x),s.transient);
 assert.equal(s.x.o.db.rasters.resourceOwnership().activeWorkers,0);
 assert.equal(s.x.o.db.candidates.resourceOwnership().transfers,0);
 // A successfully used idle worker may remain resident until normal owned close.
 // Neither activeJobs===0 nor close() proves physical native allocator release.
}
async function syntheticRetryAssertRetained(s){
 const {x}=s,c=syntheticRetryCandidate(x);
 for(const key of ['id','documentId','jobId','attemptId','requestId','outputIndex','outputIdentity','encodedAssetId'])assert.deepEqual(c[key],s.candidate[key],key);
 const asset=x.o.db.assets.asset(c.encodedAssetId);assert.deepEqual(asset,s.original);
 assert.deepEqual(await readFile(x.o.db.objects.path(asset.blob)),x.png);
 assert.equal(asset.blob.hash,'sha256:'+createHash('sha256').update(x.png).digest('hex'));
 assert.throws(()=>x.o.db.assets.safeAsset(c.encodedAssetId),error=>error.code==='CONTENT_WITHHELD');
 assert.deepEqual(x.o.db.document('document_1'),s.document);
 assert.deepEqual(x.o.db.histories.state('document_1'),s.image);
 assert.deepEqual(syntheticRetryQueueIdentity(x),s.queueIdentity);
 assert.deepEqual(x.effects,s.effects,'retained retry must not submit, upload or read status/result/media');
 syntheticRetryAssertDrained(s);return c;
}
async function syntheticRetryAssertUnpublished(s){
 const c=await syntheticRetryAssertRetained(s);assert.equal(c.state,'preparation-failed');assert.equal(c.safety,'safe');assert.equal(c.preparedAssetId,null);
 assert.equal(syntheticRetryPreparedRoots(s.x),s.preparedRoots);
 assert.deepEqual(s.x.o.db.candidates.retries(),[]);return c;
}
async function syntheticRetryRequest(s){
 const {x}=s,before=syntheticRetryCandidate(x),receipt=await x.o.db.queue.command(encode(envelope({type:'RetryCandidateImport',candidateId:before.id,expectedVersion:before.version})),auth());
 assert.equal(receipt.status,'accepted');const intent=syntheticRetryCandidate(x);
 assert.equal(intent.id,before.id);assert.equal(intent.version,String(BigInt(before.version)+1n));
 assert.equal(intent.state,'preparation-failed');assert.equal(intent.preparedAssetId,null);
 assert.deepEqual(x.o.db.candidates.retries().map(candidate=>candidate.id),[before.id]);
 return intent;
}
async function withSyntheticRetryRefusal(t,run){
 const x=await setup(t),rasters=x.o.db.rasters,externalCPU=rasters.externalCPU;
 const document=structuredClone(x.o.db.document('document_1')),image=structuredClone(x.o.db.histories.state('document_1')),transient=syntheticRetryTransient(x),worker=rasters.resourceOwnership().workerService,preparedRoots=syntheticRetryPreparedRoots(x);
 assert.equal(preparedRoots,0);
 const restore=()=>{rasters.externalCPU=externalCPU;};
 rasters.externalCPU=function(){return externalCPU.call(this)+syntheticRetryReservation;};
 try{
  t.diagnostic('Synthetic external-reservation refusal: real 128MiB decode preflight, unchanged 512MiB cap; no allocated pressure buffer or native-RSS reproduction.');
  await x.observer.tick();const candidate=syntheticRetryCandidate(x);
  assert.equal(candidate.state,'preparation-failed');assert.equal(candidate.safety,'safe');assert(candidate.encodedAssetId);assert.equal(candidate.preparedAssetId,null);
  assert.match(candidate.warning,/Preparation failed; encoded original retained\. Retry prepares the same candidate\./);
  const rows=syntheticRetryRefusals(x,candidate.id);assert.equal(rows.length,1);const row=rows[0];
  assert.equal(row.job,'decode');assert.equal(row.admitted,false);assert.equal(row.limit,syntheticRetryReservation);assert.equal(row.preflightCPU,128*1024*1024);
  assert(row.externalCPU>=syntheticRetryReservation);assert(Number.isSafeInteger(row.processRSS)&&row.processRSS>0);
  assert.equal(row.combinedReservedBytes,row.processRSS+row.externalCPU+row.preflightCPU);assert(row.combinedReservedBytes>row.limit);
  assert.deepEqual(rasters.resourceOwnership().workerService,worker,'preflight refusal must precede native worker admission');
  assert.equal(x.effects.filter(effect=>effect.method==='POST').length,1);assert.equal(x.effects.filter(effect=>effect.path==='/image0').length,1);
  const s={x,restore,externalCPU,document,image,transient,worker,preparedRoots,candidate:structuredClone(candidate),original:structuredClone(x.o.db.assets.asset(candidate.encodedAssetId)),effects:structuredClone(x.effects),queueIdentity:structuredClone(syntheticRetryQueueIdentity(x)),initialRefusals:rows};
  await syntheticRetryAssertUnpublished(s);await run(s);
 }finally{restore();}
}

test('synthetic external-reservation refusal permits one explicit retained-original retry without provider work',async t=>{
 await withSyntheticRetryRefusal(t,async s=>{
  const {x}=s;s.restore();assert.strictEqual(x.o.db.rasters.externalCPU,s.externalCPU);
  // Merely removing pressure cannot create retry intent or preparation work.
  await x.observer.tick();assert.deepEqual(syntheticRetryRefusals(x,s.candidate.id),s.initialRefusals);assert.equal((await syntheticRetryAssertUnpublished(s)).version,s.candidate.version);
  const intent=await syntheticRetryRequest(s);await x.observer.tick();
  const prepared=await syntheticRetryAssertRetained(s);assert.equal(prepared.state,'prepared');assert(BigInt(prepared.version)>BigInt(intent.version));assert(prepared.preparedAssetId);
  const asset=x.o.db.assets.safeAsset(prepared.preparedAssetId);assert.equal(asset.qualification,'canonical-raster');assert.equal(asset.safety,'safe');assert.equal(asset.raster.width,512);assert.equal(asset.raster.height,512);
  x.o.db.objects.verify(asset.blob);for(const ref of asset.dependencies)x.o.db.objects.verify(ref);
  assert(syntheticRetryPreparedRoots(x)>s.preparedRoots);assert.deepEqual(x.o.db.candidates.retries(),[]);
  assert.equal(x.o.db.rasters.resourceOwnership().workerService.completedJobs,s.worker.completedJobs+1);
  assert.deepEqual(syntheticRetryRefusals(x,s.candidate.id),s.initialRefusals);
 });
});
test('synthetic external-reservation pressure still refuses one explicit retry and does not retry itself',async t=>{
 await withSyntheticRetryRefusal(t,async s=>{
  const {x}=s,intent=await syntheticRetryRequest(s);await x.observer.tick();
  const failed=await syntheticRetryAssertUnpublished(s);assert(BigInt(failed.version)>BigInt(intent.version));
  const rows=syntheticRetryRefusals(x,s.candidate.id);assert.equal(rows.length,2);assert.deepEqual(rows[0],s.initialRefusals[0]);
  assert.equal(rows[1].job,'decode');assert.equal(rows[1].admitted,false);assert.equal(rows[1].limit,syntheticRetryReservation);assert.equal(rows[1].preflightCPU,128*1024*1024);assert(rows[1].externalCPU>=syntheticRetryReservation);assert.equal(rows[1].combinedReservedBytes,rows[1].processRSS+rows[1].externalCPU+rows[1].preflightCPU);assert(rows[1].combinedReservedBytes>rows[1].limit);
  await x.observer.tick();assert.deepEqual(syntheticRetryRefusals(x,s.candidate.id),rows);assert.equal((await syntheticRetryAssertUnpublished(s)).version,failed.version);
  assert.deepEqual(x.o.db.rasters.resourceOwnership().workerService,s.worker);
 });
});
test('synthetic external-reservation refusal does not admit a stale-version RetryCandidateImport',async t=>{
 await withSyntheticRetryRefusal(t,async s=>{
  const {x}=s;s.restore();assert(BigInt(s.candidate.version)>0n);
  const receipt=await x.o.db.queue.command(encode(envelope({type:'RetryCandidateImport',candidateId:s.candidate.id,expectedVersion:String(BigInt(s.candidate.version)-1n)})),auth());
  assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'STALE_REVISION');
  const detail=JSON.parse(await readFile(x.o.db.objects.path(receipt.details),'utf8'));
  assert.deepEqual(detail,{kind:'fields',issues:[{path:'command.body',code:'CANDIDATE_CHANGED'}]});
  assert.deepEqual(await syntheticRetryAssertUnpublished(s),s.candidate);assert.deepEqual(syntheticRetryRefusals(x,s.candidate.id),s.initialRefusals);
  assert.deepEqual(x.o.db.rasters.resourceOwnership().workerService,s.worker);
 });
});

function syntheticRetryHoldOriginal(s){
 const rasters=s.x.o.db.rasters,original=rasters.prepareDocument;let release,entered,calls=0;
 const released=new Promise(resolve=>{release=resolve;}),entry=new Promise(resolve=>{entered=resolve;});
 rasters.prepareDocument=async function(...args){
  if(args[0]?.type==='PrepareCandidate'&&args[0].assetId===s.candidate.encodedAssetId&&args[2]==='candidate-prepare:'+s.candidate.id){
   calls++;assert.equal(calls,1,'one explicit retry may enter original preparation only once');entered();await released;
  }
  return Reflect.apply(original,this,args);
 };
 return {entry,release,restore:()=>{rasters.prepareDocument=original;},calls:()=>calls};
}
async function syntheticRetryHeldControl(t,action){
 await withSyntheticRetryRefusal(t,async s=>{
  const {x}=s;s.restore();const hold=syntheticRetryHoldOriginal(s);let settled;
  try{
   await syntheticRetryRequest(s);
   // Attach rejection handling immediately, before awaiting entry or assertions.
   settled=x.observer.tick().then(value=>({status:'fulfilled',value}),error=>({status:'rejected',error}));
   assert.equal(await Promise.race([hold.entry.then(()=> 'entered'),settled.then(()=> 'settled')]),'entered','tick settled before the selected original preparation entry');
   assert.equal(hold.calls(),1);assert.equal(x.o.db.candidates.resourceOwnership().transfers,1);assert.deepEqual(x.o.db.candidates.retries(),[]);
   assert.equal(x.o.db.rasters.resourceOwnership().documentBusy,false,'barrier precedes original prepareDocument');
   assert.equal(x.o.db.objects.reservationInventory().activeTransfers,s.transient.reservations.activeTransfers+1);
   if(action==='cancel'){
    const job=x.o.db.queue.view().jobs.find(job=>job.id===s.candidate.jobId);assert(job);
    const receipt=await x.o.db.queue.command(encode(envelope({type:'CancelJob',jobId:job.id,attemptId:s.candidate.attemptId,expectedVersion:job.version})),auth());
    assert.equal(receipt.status,'accepted');assert.equal(x.o.db.queue.view().jobs.find(current=>current.id===job.id)?.disposition,'cancel-requested');
   }else if(action==='observer-close')x.observer.close();
   else{assert.equal(action,'candidates-close');await x.o.db.candidates.close();}
   hold.release();const outcome=await settled;
   if(action==='cancel'){assert.equal(outcome.status,'rejected');assert.equal(outcome.error.code,'STALE_EPOCH');}
   else assert.equal(outcome.status,'fulfilled');
   // Close flags are not drains: these reads happen only after the held tick.
   await syntheticRetryAssertUnpublished(s);assert.equal(hold.calls(),1);
   assert.deepEqual(syntheticRetryRefusals(x,s.candidate.id),s.initialRefusals);
   assert.deepEqual(x.o.db.rasters.resourceOwnership().workerService,s.worker);
   // A truthful failed-state version/warning is allowed. No further tick is run:
   // after CancelJob it could legitimately deliver a separate provider cancel.
  }finally{
   // Always release even when command/entry/assertion checks fail. Drain the same
   // promptly handled tick before restoring methods and before setup's teardown.
   hold.release();try{if(settled)await settled;}finally{hold.restore();s.restore();}
  }
 });
}
test('synthetic external-reservation retry held at original entry is fenced by CancelJob',async t=>{
 await syntheticRetryHeldControl(t,'cancel');
});
test('synthetic external-reservation retry held at original entry cannot publish after observer close',async t=>{
 await syntheticRetryHeldControl(t,'observer-close');
});
test('synthetic external-reservation retry held at original entry cannot publish after candidate owner close',async t=>{
 await syntheticRetryHeldControl(t,'candidates-close');
});

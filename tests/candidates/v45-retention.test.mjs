// Staged storage/observer integration fixtures. No network, provider or decoder execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Candidates} from '../../dist/local/server/storage/candidates.js';
import {Objects} from '../../dist/local/server/storage/objects.js';
import {Assets} from '../../dist/local/server/storage/assets.js';
import {TransportEvidenceStore,r31Reservation} from '../../dist/local/server/provider/evidence.js';
import {ResultObserver} from '../../dist/local/server/provider/observer.js';
import {reviewedResponseProfile} from '../../dist/local/server/provider/response-profile.js';
import {scanEnvelope} from '../../dist/local/server/provider/provenance.js';
import {newV45Draft,resolve,bodyTemplate,requestRoute} from '../../dist/local/src/request/family.js';
import {providerReviewV45,verifyRequestReviewV45} from '../../dist/local/src/request/review.js';
import {canonical,hashBytes} from '../../dist/local/server/storage/canonical.js';
import {StoreError} from '../../dist/local/server/storage/errors.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mxQAAAAASUVORK5CYII=','base64');
const policy={profileId:'fixture_v45_metadata',profileVersion:1,evidenceDigest:'a'.repeat(64),requestedStoreIO:'0',requestedAccess:'most-private-compatible',appliedLifecycleSeconds:60,appliedACL:'fixture-private',enforcement:'observed',fallbackAcknowledgementId:null};
const url='https://v3b.fal.media/fixture.png?token=protected-fixture-url';

function fixture(t,{legacy=false,promptText='Exact fixture prompt',seed=''}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'v45-result-')));chmodSync(root,0o700);
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE candidate_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,family TEXT,id TEXT,json TEXT);CREATE TABLE candidate_jobs(job_id TEXT PRIMARY KEY,json TEXT);CREATE TABLE candidates(id TEXT PRIMARY KEY,document_id TEXT,job_id TEXT,json TEXT);CREATE TABLE candidate_private(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE queue_jobs(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE documents(id TEXT PRIMARY KEY);CREATE TABLE candidate_document_tombstones(document_id TEXT);CREATE TABLE roots(owner TEXT,hash TEXT);CREATE TABLE portable_rows(kind TEXT,id TEXT,json TEXT);');
 db.prepare('INSERT INTO documents VALUES (?)').run('document_1');
 const objects=new Objects(root,()=>{},()=>{}),evidence=new TransportEvidenceStore(root);
 const put=(bytes,media='application/json')=>{const value=Buffer.from(bytes),stage=objects.begin(String(value.length),media);objects.chunk(stage,value);return objects.finish(stage);};
 const prompt=put(promptText,'text/plain'),attemptId=randomUUID();
 let review;
 if(legacy)review={kind:'request-review-1',endpoint:'ideogram/v4',prompt,request:{kind:'generate',settings:{prompt:{mode:'plain',text:prompt,projection:null,composition:null},seed:{kind:'provider-random'},count:1},size:{kind:'custom',width:1,height:1}}};
 else {
  const draft=newV45Draft(prompt);draft.fields.seed=seed;const request=resolve(draft,promptText),route=requestRoute(request);
  const binding={kind:'request-review-v45-1',id:'review_1',owner:hashBytes('owner'),draft:{sessionId:'session_1',draftId:'draft_1',generation:'1'},draftAsset:'draft_asset_1',documentId:'document_1',documentRevision:'1',request,endpoint:route.endpoint,schemaHash:route.schemaHash,routeHash:hashBytes(canonical(route)),dependencyHash:hashBytes('dependencies'),template:put(bodyTemplate(request,promptText)),prompt,conversion:null,inactive:{},destination:'retained-candidates',privacy:'minimum-retention-unqualified',estimate:request.modelRequest.estimate,dispatch:false,providerReview:providerReviewV45(request)};
  review={...binding,token:hashBytes(canonical(binding))};
 }
 const job={id:'job_1',documentId:'document_1',version:'1',review,disposition:'active',attempts:[{id:attemptId,requestId:'request_1',state:'acknowledged',recoveryRequired:false}]};
 db.prepare('INSERT INTO queue_jobs VALUES (?,?)').run(job.id,canonical(job));
 const fence={jobId:job.id,attemptId,requestId:'request_1',epoch:'epoch_1',jobVersion:'1'};
 const assertResult=f=>{if(canonical(f)!==canonical(fence)||db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(job.documentId))throw new StoreError('STALE_EPOCH');return job;};
 const sink=()=>evidence.begin(attemptId,'response',r31Reservation(objects,randomUUID(),'provider-response',()=>{}),policy);
 const capture=(value,{complete=true,media='application/json'}={})=>{const s=sink();s.recordHeaders({'Content-Type':media});s.append(Buffer.from(value));return s.finish(complete);};
 // Captured bodies are semantic fixture records, never executed transport proof.
 const queue={evidence,assertResult,resultTransaction(f,fn){assertResult(f);return fn(job);},resultFence(){return {...fence};},recovery(){return {epoch:fence.epoch,endpoint:review.endpoint,documentId:job.documentId,attempt:job.attempts[0],outbox:{urls:null}};},runtimeWireRef(){return null;},sink(){return sink();},view(){return {jobs:[job],nextCursor:null};},deleted(){return false;},recoveryWork(){return [];},controlWork(){return [];},resultTerminal(_job,_id,phase){job.attempts[0].state='provider-terminal';job.attempts[0].terminal=phase;}};
 const assets={asset(id){const row=db.prepare('SELECT json FROM assets WHERE id=?').get(id);return row?JSON.parse(row.json):null;},safeAsset(id){return Assets.prototype.safeAsset.call(this,id);}};
 let decodeCalls=0,mediaCalls=0;
 const rasters={async prepareDocument(){decodeCalls++;throw Error('This fixture must never decode withheld output.');}};
 const register=(owner,ref)=>{objects.verify(ref);db.prepare('INSERT INTO roots VALUES (?,?)').run(owner,ref.hash);};
 let candidates=new Candidates(db,objects,assets,rasters,queue,()=>{},register);
 const provider={policy(){return {applied:policy};},async media(_url,s,{signal}={}){mediaCalls++;assert.equal(_url,url);assert(!signal?.aborted);s.recordHeaders({'Content-Type':'image/png'});s.append(png);const body=s.finish(true);return {outcome:'complete',failure:null,status:200,receivedBytes:String(png.length),storedBytes:String(png.length),etag:null,declaredBytes:null,sha256:body.sha256,evidence:body,providerCancelled:false};}};
 t.after(async()=>{await candidates.close();assert.equal(objects.reservationInventory().activeTransfers,0);objects.close();db.close();rmSync(root,{recursive:true});});
 return {db,objects,evidence,queue,job,review,fence,assets,provider,capture,policy,get candidates(){return candidates;},get decodeCalls(){return decodeCalls;},get mediaCalls(){return mediaCalls;},async reopen({clearProjections=false}={}){await candidates.close();if(clearProjections)db.exec('DELETE FROM candidate_jobs;DELETE FROM candidates;DELETE FROM assets;');candidates=new Candidates(db,objects,assets,rasters,queue,()=>{},register);return candidates;}};
}
function minimal(extra=''){return '{"images":[{"url":'+JSON.stringify(url)+',"file_name":"fixture.png","content_type":"image/png","file_size":'+png.length+'}],"seed":900719925474099312345'+extra+'}';}

function assertV45FirstResult(x,source,raw,phase){
 const view=x.candidates.view(x.job.id),candidate=view.items[0];assert.equal(view.observation.phase,phase);assert.equal(view.items.length,1);assert.equal(view.actualCount,1);
 assert.equal(candidate.safety,'unknown');assert.equal(candidate.state,'withheld');assert.equal(candidate.preparedAssetId,null);assert.deepEqual(view.repair,{});assert.equal(x.decodeCalls,0);
 assert.equal(view.provenance.schemaVersion,2);assert.equal(view.provenance.availability.resultContract,'valid');assert.equal(view.provenance.availability.safety,'unavailable-by-contract');assert.equal(view.provenance.complete,false);
 assert.equal(view.provenance.sourceBodyHash,hashBytes(raw));assert.equal(view.provenance.returnedSeed,'900719925474099312345');assert.deepEqual(view.provenance.requestedPrompt,x.review.prompt);assert.deepEqual(view.provenance.submittedPrompt,x.review.prompt);assert.equal(view.provenance.returnedPrompt,null);
 assert.equal(Buffer.concat([...x.evidence.read(source.recordId)]).toString(),raw);assert.equal(x.evidence.inspect(source.recordId).sha256,source.sha256);x.objects.verify(view.provenance.privacyPolicy);
 const retained=JSON.parse(x.db.prepare('SELECT json FROM candidate_jobs WHERE job_id=?').get(x.fence.attemptId).json),slot=JSON.parse(x.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(candidate.id).json);
 assert.equal(retained.observation.resultDigest,source.sha256);assert.equal(retained.wireEvidence?.status??null,null);assert.equal(retained.wireEvidence?.result??null,null);assert.equal(Object.hasOwn(slot,'outputEvidence'),false);assert.equal(Object.hasOwn(slot,'mediaEvidence'),false);
 return {view,candidate,retained,slot};
}

for(const prior of ['failed','cancelled','quarantined'])test('V45 '+prior+' observation cannot be replaced by its first schema-valid result',async t=>{
 const x=fixture(t),status={request_id:x.fence.requestId,...(prior==='failed'?{status:'COMPLETED',error:'Fixture provider failure'}:prior==='cancelled'?{status:'CANCELLED'}:{status:'UNRECOGNIZED_FIXTURE_STATUS'})};
 const statusRaw=JSON.stringify(status),statusSource=x.capture(statusRaw),observed=x.candidates.observe(x.fence,statusSource,1000);
 assert.equal(observed.view.observation.phase,prior);assert.equal(observed.view.observation.resultDigest,null);assert.deepEqual(observed.view.items,[]);
 if(prior!=='quarantined')assert.equal(x.job.attempts[0].terminal,prior);
 const raw=minimal(),source=x.capture(raw),received=x.candidates.receive(observed.fence,source,policy,[]);assert.equal(received.observation.phase,'quarantined');
 const first=assertV45FirstResult(x,source,raw,'quarantined');assert(first.retained.wireEvidence.contradictions.length>0);
 await x.candidates.transfer(x.queue.resultFence(),first.candidate.id,x.provider,policy);
 const held=assertV45FirstResult(x,source,raw,'quarantined');assert(held.candidate.encodedAssetId);assert.equal(x.assets.asset(held.candidate.encodedAssetId).blob.hash,hashBytes(png));
 assert.throws(()=>x.assets.safeAsset(held.candidate.encodedAssetId),error=>error.code==='CONTENT_WITHHELD');
 await assert.rejects(x.candidates.reviewAdoption(held.candidate.id,'full-candidate','adopt_after_terminal','no-slot',()=>{}),error=>error.code==='INCOMPATIBLE');
 assert.throws(()=>x.queue.candidateAction({type:'RetryCandidateImport',candidateId:held.candidate.id,expectedVersion:held.candidate.version},'no-slot'),error=>error.code==='INCOMPATIBLE');
 x.candidates.observe(x.queue.resultFence(),x.capture(JSON.stringify({request_id:x.fence.requestId,status:'COMPLETED'})),2000);
 const before=assertV45FirstResult(x,source,raw,'quarantined');assert.equal(before.candidate.id,first.candidate.id);assert.equal(before.candidate.outputIdentity,first.candidate.outputIdentity);assert.equal(before.candidate.encodedAssetId,held.candidate.encodedAssetId);assert.deepEqual(before.view.provenance,first.view.provenance);
 x.candidates.receive(x.queue.resultFence(),source,policy,[]);x.candidates.receive(x.queue.resultFence(),x.capture(raw),policy,[]);assert.deepEqual(x.candidates.view(x.job.id),before.view);
 await x.reopen({clearProjections:true});const replayed=assertV45FirstResult(x,source,raw,'quarantined');assert.deepEqual(replayed.view,before.view);assert.deepEqual(replayed.retained.wireEvidence,before.retained.wireEvidence);assert.deepEqual(replayed.slot,before.slot);
 x.candidates.receive(x.queue.resultFence(),x.capture(raw),policy,[]);assert.deepEqual(x.candidates.view(x.job.id),before.view);assert.equal(Buffer.concat([...x.evidence.read(statusSource.recordId)]).toString(),statusRaw);assert.equal(x.mediaCalls,1);assert.deepEqual(x.candidates.due(Date.now()),[]);
});

for(const cancel of ['requested','acknowledged'])test('V45 local cancel '+cancel+' allows completed result retention without provider cancellation authority',async t=>{
 const x=fixture(t);x.job.disposition='cancel-requested';x.job.attempts[0].cancel=cancel;x.db.prepare('UPDATE queue_jobs SET json=? WHERE id=?').run(canonical(x.job),x.job.id);
 const observed=x.candidates.observe(x.fence,x.capture(JSON.stringify({request_id:x.fence.requestId,status:'COMPLETED'})),1000);assert.equal(observed.view.observation.phase,'completed');assert.equal(x.job.attempts[0].terminal,'completed');
 const raw=minimal(),source=x.capture(raw);x.candidates.receive(observed.fence,source,policy,[]);const first=assertV45FirstResult(x,source,raw,'completed');assert.deepEqual(first.retained.wireEvidence?.contradictions??[],[]);
 await x.candidates.transfer(x.queue.resultFence(),first.candidate.id,x.provider,policy);const held=assertV45FirstResult(x,source,raw,'completed');assert(held.candidate.encodedAssetId);assert.throws(()=>x.assets.safeAsset(held.candidate.encodedAssetId),error=>error.code==='CONTENT_WITHHELD');
 x.candidates.receive(x.queue.resultFence(),x.capture(raw),policy,[]);assert.deepEqual(x.candidates.view(x.job.id),held.view);
 await x.reopen({clearProjections:true});const replayed=assertV45FirstResult(x,source,raw,'completed');assert.deepEqual(replayed.view,held.view);assert.deepEqual(replayed.slot,held.slot);assert.equal(x.job.disposition,'cancel-requested');assert.equal(x.job.attempts[0].cancel,cancel);assert.equal(x.job.attempts[0].terminal,'completed');assert.equal(x.mediaCalls,1);
});

test('V45 receive, protected transfer and journal replay retain no public image capability',async t=>{
 const x=fixture(t),source=x.capture(minimal()),before=x.objects.reservationInventory();
 const view=x.candidates.receive(x.fence,source,policy,[]),c=view.items[0];
 assert.equal(view.observation.phase,'completed');assert.equal(view.provenance.schemaVersion,2);
 assert.equal(view.provenance.availability.resultContract,'valid');assert.equal(view.provenance.returnedSeed,'900719925474099312345');
 assert.equal(view.provenance.returnedPrompt,null);assert.equal(view.provenance.complete,false);assert.equal(view.provenance.timings,null);assert.equal(view.provenance.timingUnits,null);
 assert.equal(c.state,'withheld');assert.equal(c.safety,'unknown');
 await x.candidates.transfer(x.fence,c.id,x.provider,policy);
 const retained=x.candidates.view(x.job.id),output=retained.items[0];assert.equal(x.mediaCalls,1);assert.equal(x.decodeCalls,0);
 assert(output.encodedAssetId);assert.equal(output.preparedAssetId,null);assert.equal(output.state,'withheld');assert.equal(output.safety,'unknown');
 assert.equal(x.assets.asset(output.encodedAssetId).blob.hash,hashBytes(png));
 assert.throws(()=>x.assets.safeAsset(output.encodedAssetId),e=>e.code==='CONTENT_WITHHELD');
 await assert.rejects(x.candidates.reviewAdoption(output.id,'full-candidate','adopt_1','no-slot',()=>{}),e=>e.code==='INCOMPATIBLE');
 assert.throws(()=>x.candidates.prompt(x.job.id,x.fence.attemptId,'returned','0'),e=>e.code==='NOT_FOUND');
 assert.throws(()=>x.queue.candidateAction({type:'RetryCandidateImport',candidateId:output.id,expectedVersion:output.version},'no-slot'),e=>e.code==='INCOMPATIBLE');
 const after=canonical(retained);await x.reopen();assert.equal(canonical(x.candidates.view(x.job.id)),after);
 assert.equal(x.decodeCalls,0);assert.deepEqual(x.objects.reservationInventory(),before);
});

test('V45 undeclared false flags, prompt and dimensions never acquire V4 authority',async t=>{
 const x=fixture(t),source=x.capture(minimal(',"has_nsfw_concepts":[false],"prompt":"invented provider extra","timings":{"inference":1}').replace('"file_name":"fixture.png"','"width":4096,"height":8192,"file_name":"fixture.png"'));
 const view=x.candidates.receive(x.fence,source,policy,[]);assert.equal(view.provenance.returnedPrompt,null);assert.equal(view.provenance.timings,null);assert.equal(view.items[0].safety,'unknown');
 const slot=JSON.parse(x.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(view.items[0].id).json);assert.equal(slot.width,null);assert.equal(slot.height,null);
 await x.candidates.transfer(x.fence,view.items[0].id,x.provider,policy);assert.equal(x.decodeCalls,0);assert.equal(x.candidates.view(x.job.id).items[0].preparedAssetId,null);
});

test('V45 malformed File metadata, partial body and missing exact seed remain quarantined',t=>{
 for(const raw of [minimal().replace('"fixture.png"','[]'),minimal().replace('900719925474099312345','1.5'),'{"images":[]}',minimal().slice(0,-1)]){
  const x=fixture(t),view=x.candidates.receive(x.fence,x.capture(raw),policy,[]);assert.equal(view.observation.phase,'quarantined');assert.equal(view.provenance.availability.resultContract,'invalid');assert(view.items.every(c=>c.safety==='unknown'&&c.preparedAssetId===null));
 }
 const x=fixture(t),view=x.candidates.receive(x.fence,x.capture(minimal(),{complete:false}),policy,[]);assert.equal(view.actualCount,null);assert.equal(view.items[0].state,'missing');
});

test('V45 immutable profile mismatch, changed approval and stale owner fail before receive',t=>{
 const x=fixture(t),source=x.capture(minimal());
 assert.throws(()=>x.candidates.receive(x.fence,source,policy,[],{profile:'ideogram-v4-result-1',endpoint:'ideogram/v4'}),e=>e.code==='STALE_EPOCH');
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM candidates').get().n,0);
 x.review.providerReview.admission.ordinaryDisplay=true;
 assert.throws(()=>x.candidates.receive(x.fence,source,policy,[]));
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM candidates').get().n,0);
});

test('V45 contradictory completion keeps the owned original and remains withheld',async t=>{
 const x=fixture(t),view=x.candidates.receive(x.fence,x.capture(minimal()),policy,[]);await x.candidates.transfer(x.fence,view.items[0].id,x.provider,policy);
 const original=x.candidates.view(x.job.id).items[0].encodedAssetId;
 x.candidates.receive(x.fence,x.capture('{"images":[],"seed":1}'),policy,[]);
 const retained=x.candidates.view(x.job.id);assert.equal(retained.observation.phase,'quarantined');assert.equal(retained.items[0].encodedAssetId,original);assert.equal(retained.items[0].state,'withheld');assert.throws(()=>x.assets.safeAsset(original),e=>e.code==='CONTENT_WITHHELD');assert.equal(x.mediaCalls,1);assert.equal(x.decodeCalls,0);
});

test('V45 protected-transfer failure stays withheld with no ordinary import retry',async t=>{
 const x=fixture(t),view=x.candidates.receive(x.fence,x.capture(minimal()),policy,[]);
 const provider={async media(_url,s){const body=s.finish(false);return {outcome:'interrupted',failure:'INTERRUPTED',status:503,receivedBytes:'0',storedBytes:'0',etag:null,declaredBytes:null,sha256:body.sha256,evidence:body,providerCancelled:false};}};
 await x.candidates.transfer(x.fence,view.items[0].id,provider,policy);
 const c=x.candidates.view(x.job.id).items[0];assert.equal(c.state,'withheld');assert.equal(c.encodedAssetId,null);assert.match(c.warning,/Protected original transfer failed/);assert.throws(()=>x.queue.candidateAction({type:'RetryCandidateImport',candidateId:c.id,expectedVersion:c.version},'no-slot'),e=>e.code==='INCOMPATIBLE');assert.equal(x.decodeCalls,0);
});

test('observer uses immutable response profile while retaining unknown output without decoder',async t=>{
 const x=fixture(t),calls=[];
 const dispatcher={async readKnown(_job,_attempt,action){calls.push(action);const evidence=x.capture(action==='status'?JSON.stringify({request_id:x.fence.requestId,status:'COMPLETED'}):minimal());return {outcome:'complete',status:200,evidence};},recoverRetained(){throw Error('No recovery work in this fixture.');}};
 const observer=new ResultObserver(x.candidates,x.provider,dispatcher,policy.profileId);t.after(()=>observer.close());
 await observer.tick();assert.deepEqual(calls,['status','result']);assert.equal(x.mediaCalls,1);assert.equal(x.decodeCalls,0);assert.equal(x.candidates.view(x.job.id).items[0].state,'withheld');
 await observer.tick(Date.now()+5000);assert.deepEqual(calls,['status','result']);
});

test('default V4 scanner and retained identity ignore filename exactly as before',t=>{
 const x=fixture(t,{legacy:true}),image={url,content_type:'image/png',file_size:png.length,width:1,height:1},raw=JSON.stringify({images:[{...image,file_name:'new-extra.png'}],prompt:'Original returned prompt',seed:17,timings:{inference:1},has_nsfw_concepts:[false]});
 const scan=scanEnvelope([Buffer.from(raw)],()=>{});assert.deepEqual(scan.images,[image]);
 const view=x.candidates.receive(x.fence,x.capture(raw),policy,[]),c=view.items[0];
 assert.equal(c.outputIdentity,hashBytes(canonical([x.fence.requestId,0,image])));assert.equal(c.safety,'safe');assert.equal(c.state,'received');assert.equal(view.provenance.complete,true);assert.equal(Object.hasOwn(view.provenance,'schemaVersion'),false);assert.equal(Object.hasOwn(view.provenance,'availability'),false);assert.deepEqual(view.provenance.timings,{inference:1});assert.equal(view.provenance.timingUnits,'unknown');
 assert.deepEqual(reviewedResponseProfile(x.review),{profile:'ideogram-v4-result-1',endpoint:'ideogram/v4'});
});

test('V45 scanner preserves malformed filename type while legacy scanner bytes remain unchanged',()=>{
 const raw=Buffer.from('{"images":[{"url":"https://v3b.fal.media/x","file_name":[]}],"seed":900719925474099312345}');
 const legacy=scanEnvelope([raw],()=>{}),v45=scanEnvelope([raw],()=>{},{profile:'ideogram-v45-result-1'});
 assert.equal(Object.hasOwn(legacy.images[0],'file_name'),false);assert.deepEqual(v45.images[0].file_name,{invalid:true});assert.equal(v45.seed,'900719925474099312345');
});


test('V45 ref-only review selects withholding without duplicating maximum scalar prompt',t=>{
 const promptText='😀'.repeat(10000),x=fixture(t,{promptText});
 assert.equal(x.review.prompt.byteLength,'40000');
 assert.equal(Object.hasOwn(x.review.request.modelRequest.body,'prompt'),false);
 assert.equal(Object.hasOwn(x.review.request.modelRequest,'seed'),false);
 assert(Buffer.byteLength(canonical(x.review))<60000);
 assert.deepEqual(reviewedResponseProfile(x.review),{profile:'ideogram-v45-result-1',endpoint:'ideogram/v4.5'});
 assert.doesNotThrow(()=>verifyRequestReviewV45(x.review,promptText));
 assert.throws(()=>verifyRequestReviewV45(x.review,promptText+'x'));
 const view=x.candidates.receive(x.fence,x.capture(minimal()),policy,[]);
 assert.equal(view.items[0].safety,'unknown');assert.equal(view.items[0].state,'withheld');
 assert.equal(view.provenance.returnedPrompt,null);assert.equal(x.decodeCalls,0);
});


test('V45 maximum exact seed is retained while max plus one is quarantined',t=>{
 const seed='9'.repeat(16384),x=fixture(t,{seed});
 assert(Buffer.byteLength(canonical(x.review))<60000);
 assert.equal(x.review.request.settings.seed.decimal,seed);
 const raw=minimal().replace('900719925474099312345',seed),source=x.capture(raw);
 assert.equal(source.sha256,hashBytes(raw).slice(7));
 const view=x.candidates.receive(x.fence,source,policy,[]);
 assert.equal(view.observation.phase,'completed');assert.equal(view.provenance.returnedSeed,seed);
 assert.equal(view.provenance.requestedSeed,seed);assert.equal(view.items[0].safety,'unknown');
 assert(Buffer.byteLength(canonical(view.provenance))<65536);
 const y=fixture(t),tooLong=minimal().replace('900719925474099312345',seed+'9');
 const rejected=y.candidates.receive(y.fence,y.capture(tooLong),policy,[]);
 assert.equal(rejected.observation.phase,'quarantined');assert.equal(rejected.provenance.returnedSeed,null);
 assert(rejected.items.every(item=>item.preparedAssetId===null));
});

test('V45 seed exception preserves nested, duplicate-key, and legacy scanner boundaries',()=>{
 const profile={profile:'ideogram-v45-result-1'},long='9'.repeat(16384),scan=(raw,options)=>scanEnvelope([Buffer.from(raw)],()=>{},options);
 assert.equal(scan('{"images":[],"seed":'+long+'}',profile).seed,long);
 assert.throws(()=>scan('{"images":[],"seed":'+long+'}'));
 assert.throws(()=>scan('{"images":[],"seed":1,"extra":{"seed":'+long+'}}',profile));
 assert.throws(()=>scan('{"images":[{"file_size":'+long+'}],"seed":1}',profile));
 assert.throws(()=>scan('{"images":[],"seed":1,"seed":2}',profile));
 assert.equal(scan('{"images":[],"seed":'+'9'.repeat(257)+'}').seed.length,257);
 assert.throws(()=>scan('{"images":[],"seed":'+'9'.repeat(258)+'}'));
});

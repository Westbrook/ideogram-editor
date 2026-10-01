import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import sharp from 'sharp';
import {fixture,prepare,enqueue,auth,envelope,encode} from '../queue/helpers.mjs';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {ProviderExecution} from '../../dist/local/server/provider/runtime-core.js';
import {PRODUCTION_PROFILE,PRODUCTION_PRIVACY,productionAcknowledgement} from '../../dist/local/server/provider/production-profile.js';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {resolveInactive} from '../../dist/local/src/request/core.js';
import {emulator,fixtureProfile,SENTINEL_KEY} from './emulator.mjs';
import {egressAttempts} from './no-egress.mjs';

function configuration(changes={}){
 const manifest={schemaVersion:1,id:'fixture_authorization',approvedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),endpoint:'ideogram/v4',operation:'generate',maxRequests:3,maxImages:3,output:{width:512,height:512,count:1,format:'png'},expansion:'None',profileId:PRODUCTION_PROFILE.id,profileVersion:PRODUCTION_PROFILE.version,evidenceDigest:PRODUCTION_PROFILE.evidenceDigest,disclosureDigest:PRODUCTION_PRIVACY.disclosureDigest,acknowledgeChargeAndPrivacy:true,...changes};
 return {mode:'fal',manifest,manifestHash:createHash('sha256').update(canonical(manifest)).digest('hex'),key:SENTINEL_KEY};
}
async function owned(f){
 await f.close();const owner=await acquireRoot(f.root),db=new StoreDatabase(f.root,()=>{});let closed=false;
 return {db,async close(){if(closed)return;closed=true;await db.candidates.close();await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();owner.close();}};
}
async function setup(t,{drafts=[()=>{}],config=configuration(),status='IN_QUEUE',dropAcknowledgement=false,streamMedia=false}={}){
 const cleanup=[],closures=[],clock={now:Date.now()},streams=new Map(),f=await fixture({name:t.name,after:fn=>cleanup.push(fn)},{width:512,height:512});let o,runtime,server,origin='',mediaStartedResolve;
 const mediaStarted=new Promise(resolve=>{mediaStartedResolve=resolve;}),stopStreams=()=>{for(const [response,timer] of streams){clearInterval(timer);response.destroy();}streams.clear();};
 t.after(async()=>{stopStreams();await runtime?.close();for(const close of closures)await close();await o?.close();if(server?.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));for(const fn of cleanup)await fn();assert.deepEqual(egressAttempts(),[]);});
 const queued=[];for(let i=0;i<drafts.length;i++){const p=await prepare(f.writer,d=>{d.fields.width='512';d.fields.height='512';d.fields.expansion='None';d.guidanceAcknowledged=true;drafts[i](d);},String(i+1));queued.push(await enqueue(f.writer,p.body));}
 o=await owned(f);const effects=[],requests=new Map(),controls={status,dropAcknowledgement,streamMedia,mediaChunks:0},png=await sharp({create:{width:512,height:512,channels:4,background:'#2468ac'}}).png().toBuffer();
 server=createServer(async(req,res)=>{
  const bytes=Buffer.concat(await Array.fromAsync(req));effects.push({method:req.method,path:req.url,headers:req.headers,body:bytes.toString()});res.setHeader('Content-Type','application/json');
  if(req.method==='POST'){
   const id='runtime_'+(requests.size+1),value=JSON.parse(bytes.toString());requests.set(id,value);
   if(controls.dropAcknowledgement){res.destroy();return;}
   const base=origin+'/ideogram/v4/requests/'+id;res.end(JSON.stringify({request_id:id,status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));return;
  }
  if(req.url.startsWith('/image/')){
   res.setHeader('Content-Type','image/png');
   if(!controls.streamMedia){res.end(png);return;}
   res.write(png.subarray(0,8));controls.mediaChunks++;
   const timer=setInterval(()=>{res.write(png.subarray(8,16));if(++controls.mediaChunks===3)mediaStartedResolve();},15);streams.set(res,timer);res.once('close',()=>{clearInterval(timer);streams.delete(res);});return;
  }
  const id=/\/requests\/([^/?]+)/.exec(req.url)?.[1];
  if(!requests.has(id)){res.statusCode=404;res.end('{}');return;}
  if(req.url.endsWith('/status'))res.end(JSON.stringify({request_id:id,status:controls.status}));
  else if(req.url.endsWith('/cancel'))res.end(JSON.stringify({status:'CANCELLATION_REQUESTED'}));
  else res.end(JSON.stringify({images:[{url:origin+'/image/'+id,content_type:'image/png',...(!controls.streamMedia?{file_size:png.length}:{}),width:512,height:512}],prompt:requests.get(id).prompt,seed:31,timings:{inference:0.4},has_nsfw_concepts:[false]}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 const provider=emulator({queueOrigin:origin,mediaOrigin:origin,profiles:[fixtureProfile({...PRODUCTION_PROFILE,mode:'fixture'})]});
 const start=()=>new ProviderExecution(o.db,config,{provider,queueOrigin:origin,now:()=>clock.now,automatic:false});runtime=start();
 return {f,queued,effects,controls,png,config,clock,mediaStarted,stopStreams,get db(){return o.db;},get runtime(){return runtime;},async reopen(){await runtime.close();await o.close();o=await owned(f);runtime=start();},job(index=0){const id=queued[index].job.id;let view=o.db.queue.view();while(!view.jobs.some(j=>j.id===id)&&view.nextCursor)view=o.db.queue.view(view.nextCursor);return view.jobs.find(j=>j.id===id);}};
}
function requestFor(x,job=x.job()){
 const view=x.runtime.view();return {type:'AuthorizeProviderJob',jobId:job.id,attemptId:job.attempts.at(-1).id,expectedVersion:job.version,reviewToken:job.review.token,configurationId:view.configurationId,configurationHash:view.configurationHash,epoch:view.epoch,profileId:view.profile.id,profileVersion:view.profile.version,disclosureDigest:view.profile.disclosureDigest,acknowledgeChargeAndPrivacy:true};
}
async function send(x,body){return x.db.queue.command(encode(envelope(body)),auth());}
async function authorize(x,index=0,changes={}){return send(x,{...requestFor(x,x.job(index)),...changes});}
const posts=x=>x.effects.filter(e=>e.method==='POST');

test('production runtime is inert until an exact queued attempt is explicitly authorized',async t=>{
 const x=await setup(t),before=x.job();await x.runtime.tick();await x.runtime.tick();
 assert.equal(posts(x).length,0);assert.deepEqual(x.job(),before);assert.equal(x.runtime.view().ready,true);assert.equal(JSON.stringify(x.runtime.view()).includes(SENTINEL_KEY),false);
 assert.equal((await authorize(x)).status,'accepted');await x.runtime.tick();const job=x.job();assert.equal(posts(x).length,1);assert.equal(job.attempts[0].state,'acknowledged');assert.equal(job.attempts[0].requestId,'runtime_1');
 const payload=JSON.parse(posts(x)[0].body);assert.equal(posts(x)[0].path,'/ideogram/v4');assert.equal(payload.num_images,1);assert.deepEqual(payload.image_size,{width:512,height:512});assert.equal(payload.output_format,'png');assert.equal(payload.expansion_model,'None');
 assert.equal(posts(x)[0].headers['x-fal-store-io'],'0');assert.equal(posts(x)[0].headers['x-fal-no-retry'],'1');assert.equal(posts(x)[0].headers['x-app-fal-disable-fallback'],'true');assert.equal(JSON.parse(posts(x)[0].headers['x-fal-object-lifecycle-preference']).expiration_duration_seconds,3600);
 assert.equal(x.runtime.view().limits.usedRequests,1);assert.equal(x.runtime.view().limits.usedImages,1);await x.runtime.tick();assert.equal(posts(x).length,1);
});

test('disabled provider runtime cannot authorize or submit queued work',async t=>{
 const x=await setup(t,{config:{mode:'disabled'}}),before=x.job();await x.runtime.tick();assert.equal(x.runtime.view().state,'disabled');assert.equal(x.runtime.view().credentialConfigured,false);
 const receipt=await send(x,{type:'AuthorizeProviderJob',jobId:before.id,attemptId:before.attempts[0].id,expectedVersion:before.version,reviewToken:before.review.token,configurationId:'disabled',configurationHash:'a'.repeat(64),epoch:x.db.epoch,profileId:PRODUCTION_PROFILE.id,profileVersion:PRODUCTION_PROFILE.version,disclosureDigest:PRODUCTION_PRIVACY.disclosureDigest,acknowledgeChargeAndPrivacy:true});
 assert.equal(receipt.status,'rejected');assert.deepEqual(x.job(),before);assert.equal(posts(x).length,0);
});

test('production authorization binds current configuration epoch and privacy disclosure',async t=>{
 const x=await setup(t),before=x.job();
 for(const changes of [{configurationId:'other'},{configurationHash:'b'.repeat(64)},{epoch:'0'},{profileId:'other'},{profileVersion:2},{disclosureDigest:'b'.repeat(64)}]){const receipt=await authorize(x,0,changes);assert.equal(receipt.status,'rejected',JSON.stringify(changes));assert.deepEqual(x.job(),before);}
 await x.runtime.tick();assert.equal(posts(x).length,0);assert.equal(x.db.queue.view().counts.active,0);
});

test('only the exact approved Generate image shape can receive production authorization',async t=>{
 const x=await setup(t,{drafts:[d=>d.fields.width='528',d=>d.fields.count='2',d=>d.fields.format='jpeg',d=>d.fields.expansion='Medium',d=>{d.fields.size='square';},d=>{d.operation='fast';resolveInactive(d,'acceleration');}]});
 for(let i=0;i<x.queued.length;i++){const receipt=await authorize(x,i);assert.equal(receipt.status,'rejected','draft '+i);assert.equal(x.job(i).attempts[0].providerAuthorization,undefined);}
 await x.runtime.tick();assert.equal(posts(x).length,0);assert.equal(x.db.queue.view().counts.reserved,0);
});

test('one active remote request prevents a second authorized job from dispatching',async t=>{
 const x=await setup(t,{drafts:[()=>{},()=>{}]});assert.equal((await authorize(x,0)).status,'accepted');assert.equal((await authorize(x,1)).status,'accepted');
 await Promise.all([x.runtime.tick(),x.runtime.tick()]);await x.runtime.tick();assert.equal(posts(x).length,1);assert.equal(x.db.queue.view().counts.active,1);assert.equal(x.db.queue.view().jobs.filter(j=>j.attempts[0].state==='not-started').length,1);
});

test('authorization cap survives a new spend session and reopening the writer',async t=>{
 const x=await setup(t,{drafts:[()=>{},()=>{}],config:configuration({maxRequests:1,maxImages:1}),status:'COMPLETED'});assert.equal((await authorize(x,0)).status,'accepted');await x.runtime.tick();await x.runtime.tick();
 assert.equal(posts(x).length,1);assert.equal(x.db.queue.view().counts.active,0);assert.equal(x.runtime.view().state,'limit-reached');
 const current=x.db.queue.view().session;assert.equal((await send(x,{type:'StartSpendSession',previousSessionId:current.id,cap:null,acknowledgeUnresolvedAttempts:false})).status,'accepted');assert.equal(x.db.queue.view().counts.dispatched,0);
 assert.equal(x.runtime.view().limits.usedRequests,1);assert.equal((await authorize(x,1)).status,'rejected');await x.runtime.tick();assert.equal(posts(x).length,1);
 await x.reopen();assert.equal(x.runtime.view().state,'limit-reached');assert.equal(x.runtime.view().limits.usedRequests,1);assert.equal(x.runtime.view().limits.usedImages,1);assert.equal((await authorize(x,1)).status,'rejected');await x.runtime.tick();assert.equal(posts(x).length,1);
});

test('expiry after explicit authorization prevents reservation and submission',async t=>{
 const expires=Date.now()+60000,x=await setup(t,{config:configuration({expiresAt:new Date(expires).toISOString()})});assert.equal((await authorize(x)).status,'accepted');
 x.clock.now=expires+1;await x.runtime.tick();assert.equal(x.runtime.view().state,'expired');assert.equal(posts(x).length,0);assert.equal(x.job().attempts[0].state,'not-started');assert.equal(x.db.queue.view().counts.active,0);assert.equal(x.runtime.view().limits.usedRequests,0);
});

test('existing authorized work can finish retention after submission approval expires',async t=>{
 const expires=Date.now()+60000,x=await setup(t,{config:configuration({expiresAt:new Date(expires).toISOString()})});assert.equal((await authorize(x)).status,'accepted');await x.runtime.tick();assert.equal(x.job().attempts[0].state,'acknowledged');
 x.clock.now=expires+1;x.controls.status='COMPLETED';await x.runtime.tick();assert.equal(x.runtime.view().state,'expired');assert.equal(posts(x).length,1);assert.equal(x.db.candidates.view(x.job().id).items[0].state,'prepared');assert.equal(x.db.queue.view().counts.active,0);
});

test('previous writer authorization never starts queued work after reopening',async t=>{
 const x=await setup(t);assert.equal((await authorize(x)).status,'accepted');const authorization=x.job().attempts[0].providerAuthorization;await x.reopen();assert.notEqual(x.runtime.view().epoch,authorization.epoch);
 await x.runtime.tick();await x.runtime.tick();assert.equal(posts(x).length,0);assert.deepEqual(x.job().attempts[0].providerAuthorization,authorization);assert.equal(x.job().attempts[0].state,'not-started');
});

test('lost submission acknowledgement remains uncertain without repeat POST after restart',async t=>{
 const x=await setup(t,{dropAcknowledgement:true});assert.equal((await authorize(x)).status,'accepted');await x.runtime.tick();assert.equal(posts(x).length,1);const uncertain=x.job().attempts[0];assert.equal(uncertain.state,'submission-uncertain');assert.equal(uncertain.hold,true);assert.equal(uncertain.requestId,null);
 await x.runtime.tick();await x.runtime.tick();assert.equal(posts(x).length,1);await x.reopen();await x.runtime.tick();assert.equal(posts(x).length,1);assert.equal(x.job().attempts.length,1);assert.equal(x.job().attempts[0].state,'submission-uncertain');assert.equal(x.runtime.view().limits.usedRequests,1);
});

test('completed authorized output becomes a retained safe candidate without document mutation',async t=>{
 const x=await setup(t,{status:'COMPLETED'}),before=x.db.document('document_1');assert.equal((await authorize(x)).status,'accepted');await x.runtime.tick();await x.runtime.tick();
 const candidate=x.db.candidates.view(x.job().id).items[0];assert.equal(candidate.state,'prepared');assert.equal(candidate.safety,'safe');assert.equal(x.db.assets.safeAsset(candidate.preparedAssetId).safety,'safe');
 assert.equal(x.db.assets.asset(candidate.encodedAssetId).blob.hash,'sha256:'+createHash('sha256').update(x.png).digest('hex'));assert.throws(()=>x.db.assets.safeAsset(candidate.encodedAssetId),e=>e.code==='CONTENT_WITHHELD');assert.deepEqual(x.db.document('document_1'),before);
 const media=x.effects.filter(e=>e.path.startsWith('/image/'));assert.equal(media.length,1);assert.equal(media[0].headers.authorization,undefined);assert.equal(media[0].headers.cookie,undefined);assert.equal(posts(x).length,1);assert.equal(x.db.queue.view().counts.active,0);
});

test('runtime close aborts a continuously progressing media transfer and preserves retry state',async t=>{
 const x=await setup(t,{status:'COMPLETED',streamMedia:true});assert.equal((await authorize(x)).status,'accepted');const pending=x.runtime.tick();let timeout;
 try{
  await Promise.race([x.mediaStarted,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('media fixture did not start')),2000);})]);clearTimeout(timeout);assert(x.controls.mediaChunks>=3);
  await Promise.race([x.runtime.close(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('runtime close did not abort progressing media within two seconds')),2000);})]);clearTimeout(timeout);await pending;
  const candidate=x.db.candidates.view(x.job().id).items[0],attempt=x.job().attempts[0];assert.equal(candidate.state,'transfer-failed');assert.equal(candidate.encodedAssetId,null);assert.match(candidate.warning,/Retry/);assert.equal(attempt.state,'provider-terminal');assert.equal(attempt.terminal,'completed');assert.equal(attempt.cancel,undefined);
  assert.equal(posts(x).length,1);assert.equal(x.effects.some(e=>e.path.endsWith('/cancel')),false);const reservations=x.db.objects.reservationInventory();assert.equal(reservations.activeTransfers,0);assert.equal(reservations.reservedBytes,'0');
 }finally{clearTimeout(timeout);x.stopStreams();await pending;}
});

test('sealed production privacy requires the exact disclosed fallback acknowledgement',()=>{
 assert.throws(()=>resolvePrivacy(PRODUCTION_PROFILE,'ideogram/v4','attempt'),e=>e.code==='POLICY');
 const authorization={id:'approval',configurationId:'fixture_authorization',configurationHash:'a'.repeat(64),epoch:'1',jobId:'job',attemptId:'attempt',reviewToken:'sha256:'+'b'.repeat(64),profileId:PRODUCTION_PROFILE.id,profileVersion:PRODUCTION_PROFILE.version,disclosureDigest:PRODUCTION_PRIVACY.disclosureDigest,authorizedAt:new Date().toISOString()},ack=productionAcknowledgement(authorization);
 const resolved=resolvePrivacy(PRODUCTION_PROFILE,'ideogram/v4','attempt',ack);assert.equal(resolved.applied.fallbackAcknowledgementId,'approval');assert.equal(resolved.applied.enforcement,'documented');assert.equal(resolved.headers['X-Fal-Store-IO'],'0');
 assert.deepEqual(JSON.parse(resolved.headers['X-Fal-Object-Lifecycle-Preference']),{expiration_duration_seconds:3600,initial_acl:{default:'allow',rules:[]}});
 for(const changed of [{attemptId:'other'},{profileVersion:2},{disclosureDigest:'b'.repeat(64)},{evidenceDigest:'b'.repeat(64)}])assert.throws(()=>resolvePrivacy(PRODUCTION_PROFILE,'ideogram/v4','attempt',{...ack,...changed}),e=>e.code==='POLICY');
});

// Source-only packet. The scheduler cases use an explicit contract harness;
// they do not qualify real-queue V45 execution. The writer case proves its denial.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,caption,ui,accept,enqueue,auth,envelope,encode} from '../queue/helpers.mjs';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {ProviderExecution} from '../../dist/local/server/provider/runtime-core.js';
import {ProviderRuntime} from '../../dist/local/server/provider/runtime.js';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {loadProviderConfiguration,validateProviderRuntimeConfiguration} from '../../dist/local/server/provider/config.js';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {PRODUCTION_PROFILE,PRODUCTION_PRIVACY} from '../../dist/local/server/provider/production-profile.js';
import {V45_GENERATION_DISCLOSURE,V45_GENERATION_MEDIA_ORIGINS_PROPOSAL,V45_GENERATION_EVIDENCE_DIGEST,V45_GENERATION_PROFILE_PROPOSAL,V45_GENERATION_PRIVACY_PROPOSAL,V45_GENERATION_FIXTURE_PROFILE,validateV45FixtureRuntimeConfiguration,v45GenerationMatches,v45GenerationAcknowledgement} from '../../dist/local/server/provider/v45-generation-execution.js';
import {newV45Draft,resolve,bodyTemplate,requestRoute} from '../../dist/local/src/request/family.js';
import {providerReviewV45,V45_ADMISSION,validateRequestReviewV45Identity} from '../../dist/local/src/request/review.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {queueModelAdmission} from '../../dist/local/src/protocol/queue.js';
import {emulator,SENTINEL_KEY} from './emulator.mjs';
import {egressAttempts} from './no-egress.mjs';

const NOW=Date.UTC(2026,8,30,12),ORIGIN='http://127.0.0.1:12345';
const digest=value=>createHash('sha256').update(value).digest('hex');
const sha=value=>'sha256:'+digest(value);
const blob=(value,mediaType='application/json')=>({hash:sha(value),byteLength:String(Buffer.byteLength(value)),mediaType});
const invalid={code:'PROVIDER_CONFIGURATION_INVALID'};
function configuration(changes={},now=NOW){
 const manifest={schemaVersion:2,id:'v45_fixture_authorization',approvedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),endpoint:'ideogram/v4.5',operation:'generate-v45',maxRequests:3,maxImages:3,output:{width:1024,height:1024,count:1,size:'square_hd',format:'provider-controlled'},quality:'medium',enablePromptExpansion:true,resultContract:'ideogram-v45-result-1',admissionPolicy:'unknown-withheld-1',profileId:V45_GENERATION_PROFILE_PROPOSAL.id,profileVersion:V45_GENERATION_PROFILE_PROPOSAL.version,evidenceDigest:V45_GENERATION_EVIDENCE_DIGEST,disclosureDigest:V45_GENERATION_PRIVACY_PROPOSAL.disclosureDigest,acknowledgeChargeAndPrivacy:true,...changes};
 return {mode:'fal-v45-fixture',manifest,manifestHash:digest(canonical(manifest)),key:SENTINEL_KEY};
}
function review(fields={}){
 const text='Exact retained Café 東京 prompt',prompt=blob(text,'text/plain'),draft=newV45Draft(prompt);Object.assign(draft.fields,fields);
 const request=resolve(draft,text),route=requestRoute(request),binding={kind:'request-review-v45-1',id:'review_1',owner:sha('owner'),draft:{sessionId:'session_1',draftId:'draft_1',generation:'1'},draftAsset:'draft_asset_1',documentId:'document_1',documentRevision:'1',request,endpoint:route.endpoint,schemaHash:route.schemaHash,routeHash:sha(canonical(route)),dependencyHash:sha('dependencies'),template:blob(bodyTemplate(request,text)),prompt,conversion:null,inactive:{},destination:'retained-candidates',privacy:'minimum-retention-unqualified',estimate:request.modelRequest.estimate,dispatch:false,providerReview:providerReviewV45(request)};
 const value={...binding,token:sha(canonical(binding))};validateRequestReviewV45Identity(value);return value;
}
function retoken(value){const {token,...binding}=value;return {...binding,token:sha(canonical(binding))};}
function requestFor(store,config,job){const m=config.manifest,a=job.attempts.at(-1);return {type:'AuthorizeProviderJob',jobId:job.id,attemptId:a.id,expectedVersion:job.version,reviewToken:job.review.token,configurationId:m.id,configurationHash:config.manifestHash,epoch:store.epoch,profileId:m.profileId,profileVersion:m.profileVersion,disclosureDigest:m.disclosureDigest,acknowledgeChargeAndPrivacy:true};}

test('fixture manifest accepts only the exact V45 milestone and freezes a detached copy',()=>{
 for(const enablePromptExpansion of [false,true]){
  const input=configuration({enablePromptExpansion}),value=validateV45FixtureRuntimeConfiguration(input,ORIGIN,NOW);
  assert.deepEqual(value,input);assert.notEqual(value,input);assert.notEqual(value.manifest,input.manifest);assert.notEqual(value.manifest.output,input.manifest.output);
  assert(Object.isFrozen(value));assert(Object.isFrozen(value.manifest));assert(Object.isFrozen(value.manifest.output));
  input.manifest.output.width=2048;assert.equal(value.manifest.output.width,1024);
 }
 for(const changes of [{schemaVersion:1},{id:''},{endpoint:'ideogram/v4'},{endpoint:'ideogram/v4.5/edit'},{operation:'generate'},{operation:'transform-v45'},{quality:'low'},{quality:'high'},{enablePromptExpansion:'true'},{resultContract:'ideogram-v4-result-1'},{admissionPolicy:'allow-unknown'},{profileId:PRODUCTION_PROFILE.id},{profileVersion:2},{evidenceDigest:'a'.repeat(64)},{disclosureDigest:PRODUCTION_PRIVACY.disclosureDigest},{acknowledgeChargeAndPrivacy:false},{maxRequests:0},{maxRequests:101},{maxRequests:1.5},{maxImages:0},{maxImages:401},{approvedAt:new Date(NOW+1).toISOString()},{expiresAt:new Date(NOW-1000).toISOString()},{approvedAt:'2026-09-30T11:59:59Z'},{extra:true}]){
  assert.throws(()=>validateV45FixtureRuntimeConfiguration(configuration(changes),ORIGIN,NOW),invalid,JSON.stringify(changes));
 }
 for(const changes of [{width:512},{height:2048},{count:2},{size:'square'},{format:'png'},{extra:true}]){
  const value=configuration();Object.assign(value.manifest.output,changes);value.manifestHash=digest(canonical(value.manifest));assert.throws(()=>validateV45FixtureRuntimeConfiguration(value,ORIGIN,NOW),invalid,JSON.stringify(changes));
 }
 for(const field of Object.keys(configuration().manifest)){const value=configuration();delete value.manifest[field];value.manifestHash=digest(canonical(value.manifest));assert.throws(()=>validateV45FixtureRuntimeConfiguration(value,ORIGIN,NOW),invalid,field);}
 for(const changes of [{mode:'fal'},{manifestHash:'0'.repeat(64)},{key:''},{key:'with space'},{key:'x'.repeat(4097)},{extra:true}])assert.throws(()=>validateV45FixtureRuntimeConfiguration({...configuration(),...changes},ORIGIN,NOW),invalid);
 assert.throws(()=>validateV45FixtureRuntimeConfiguration(configuration(),ORIGIN,NaN),invalid);
 // An expired identity remains parseable for observation; new submission is an engine gate.
 assert.equal(validateV45FixtureRuntimeConfiguration(configuration(),ORIGIN,NOW+7200000).manifest.id,'v45_fixture_authorization');
});

test('fixture configuration requires exact literal IPv4 loopback and cannot enter normal configuration',async()=>{
 for(const origin of [undefined,'https://queue.fal.run','https://127.0.0.1:12345','http://localhost:12345','http://127.1:12345','http://[::1]:12345','http://127.0.0.1','http://127.0.0.1:80','http://127.0.0.1:12345/','http://127.0.0.1:12345/path','http://127.0.0.1:12345?x=1','http://user@127.0.0.1:12345'])assert.throws(()=>validateV45FixtureRuntimeConfiguration(configuration(),origin,NOW),invalid,String(origin));
 const config=configuration();let installed=0;const store={epoch:'fixture_epoch',queue:{set authorizeProvider(_){installed++;throw Error('Normal runtime must reject before installing an authorizer');}}};
 assert.throws(()=>validateProviderRuntimeConfiguration(config,NOW),invalid);assert.throws(()=>new ProviderRuntime(store,config),invalid);assert.equal(installed,0);
 assert.throws(()=>new ProviderExecution(store,config,{provider:{},queueOrigin:'http://localhost:12345',automatic:false,now:()=>NOW}),invalid);assert.equal(installed,0);
 assert.throws(()=>new ProviderExecution(store,{mode:'fal-v45-untrusted'},{provider:{},queueOrigin:ORIGIN,automatic:false}),/PROVIDER_UNAVAILABLE/);assert.equal(installed,0);
 for(const mode of ['fal-v45-fixture','fal','disabled']){
  const reads=[],env={IDEOGRAM_PROVIDER_MODE:mode,IDEOGRAM_PROVIDER_MODEL:'ideogram/v4.5'};
  for(const key of ['FAL_KEY','FAL_KEY_FILE','IDEOGRAM_FAL_APPROVAL_FILE'])Object.defineProperty(env,key,{get(){reads.push(key);throw Error('Credential or approval read');}});
  if(mode==='fal-v45-fixture')assert.throws(()=>loadProviderConfiguration(env,NOW),invalid);
  else assert.deepEqual(loadProviderConfiguration(env,NOW),{mode:'fal-v45-blocked',requestedMode:mode});
  assert.deepEqual(reads,[]);
 }
 const normal=new ProviderRuntime(store,{mode:'fal-v45-blocked',requestedMode:'fal'});await normal.tick();await normal.close();assert.equal(installed,0);assert.equal(normal.view().ready,false);assert.deepEqual(egressAttempts(),[]);
});

test('privacy proposal is frozen and needs an exact fixture acknowledgement while production still refuses it',()=>{
 const p=V45_GENERATION_PROFILE_PROPOSAL,view=V45_GENERATION_PRIVACY_PROPOSAL,copy=V45_GENERATION_FIXTURE_PROFILE;
 assert.equal(p.mode,'production');assert.equal(copy.mode,'fixture');assert.notEqual(p.id,PRODUCTION_PROFILE.id);assert.equal(p.endpoint,'ideogram/v4.5');assert.deepEqual(copy,{...p,mode:'fixture'});
 const visit=value=>{if(value&&typeof value==='object'){assert(Object.isFrozen(value));for(const child of Object.values(value))visit(child);}};for(const value of [p,view,copy,V45_GENERATION_DISCLOSURE,V45_GENERATION_MEDIA_ORIGINS_PROPOSAL])visit(value);
 assert.deepEqual(V45_GENERATION_MEDIA_ORIGINS_PROPOSAL,['https://v3b.fal.media']);
 assert.equal(view.disclosureDigest,digest(canonical(V45_GENERATION_DISCLOSURE)));assert.equal(p.evidenceDigest,V45_GENERATION_EVIDENCE_DIGEST);
 const disclosure=V45_GENERATION_DISCLOSURE.join('\n');for(const expression of [/Partner retention.*remain unknown/s,/unknown and withheld/,/do not authorize live use/,/not.*minimum compatible lifetime/])assert.match(disclosure,expression);
 const authorization={id:'approval_1',configurationId:'config_1',configurationHash:'a'.repeat(64),epoch:'1',jobId:'job_1',attemptId:'attempt_1',reviewToken:sha('review'),profileId:p.id,profileVersion:p.version,disclosureDigest:view.disclosureDigest,authorizedAt:new Date(NOW).toISOString()},ack=v45GenerationAcknowledgement(authorization);
 assert.throws(()=>resolvePrivacy(p,p.endpoint,authorization.attemptId,ack),{code:'POLICY'});assert.throws(()=>resolvePrivacy(copy,p.endpoint,authorization.attemptId),{code:'POLICY'});
 const result=resolvePrivacy(copy,p.endpoint,authorization.attemptId,ack);assert.equal(result.applied.fallbackAcknowledgementId,authorization.id);assert.equal(result.applied.appliedLifecycleSeconds,3600);assert.equal(result.applied.appliedACL,'public');assert.equal(result.headers['X-Fal-Store-IO'],'0');
 for(const change of [{attemptId:'other'},{profileId:PRODUCTION_PROFILE.id},{profileVersion:2},{evidenceDigest:'b'.repeat(64)},{fallbackId:'other'},{disclosureDigest:'b'.repeat(64)}])assert.throws(()=>resolvePrivacy(copy,p.endpoint,authorization.attemptId,{...ack,...change}),{code:'POLICY'});
});

test('V45 identity matching preserves blocked review bytes and rejects changed model, policy or token',()=>{
 const config=configuration(),value=review({seed:'900719925474099312345'}),before=canonical(value);
 assert.equal(v45GenerationMatches(value,config.manifest),true);assert.equal(canonical(value),before);assert.equal(queueModelAdmission(value),'blocked-unavailable-evidence');assert.deepEqual(value.providerReview.admission,V45_ADMISSION);assert.equal(value.providerReview.privacyProfile,null);
 for(const fields of [{quality:'low'},{quality:'high'},{count:'2'},{size:'landscape_16_9'},{promptExpansion:'disabled'}])assert.equal(v45GenerationMatches(review(fields),config.manifest),false,JSON.stringify(fields));
 assert.equal(v45GenerationMatches(review({promptExpansion:'disabled'}),configuration({enablePromptExpansion:false}).manifest),true);
 const wrongToken={...structuredClone(value),token:sha('other')};assert.equal(v45GenerationMatches(wrongToken,config.manifest),false);assert.equal(v45GenerationMatches(retoken(wrongToken),config.manifest),true);
 for(const mutate of [v=>v.endpoint='ideogram/v4',v=>v.providerReview.resultContract='ideogram-v4-result-1',v=>v.providerReview.admission.ordinaryDisplay=true,v=>v.providerReview.privacyProfile={},v=>v.request.modelRequest.body.output_format='png']){
  const changed=structuredClone(value);mutate(changed);assert.equal(v45GenerationMatches(changed,config.manifest),false);assert.equal(v45GenerationMatches(retoken(changed),config.manifest),false);
 }
 assert.equal(v45GenerationMatches({kind:'request-review-1',request:{kind:'generate'}},config.manifest),false);
});

// The following harness deliberately replaces QueueDispatcher.submit. It tests
// the real engine's authorization/scheduling decisions, never queue durability,
// provider transport, admission, candidate retention or an in-app workflow.
function scheduler(t,{config=configuration(),fields=[{}],submit}={}){
 const jobs=fields.map((values,i)=>({id:'job_'+(i+1),documentId:'document_1',version:'1',disposition:'eligible',local:'accepted-local-queue',stagePlan:[],review:review(values),attempts:[{id:'attempt_'+(i+1),state:'not-started',count:'none',hold:false}]})),calls=[],observations=[],clock={now:NOW};
 const queue={view(){return {jobs,nextCursor:null};},deleted(){return false;},recoveryWork(){observations.push('recovery');return [];},controlWork(){observations.push('control');return [];}};
 const candidates={queue,due(now){observations.push(['due',now]);return [];},retries(){observations.push('retries');return [];}};
 const store={epoch:'epoch_1',queue,candidates};
 t.mock.method(QueueDispatcher.prototype,'submit',async id=>{calls.push(id);const job=jobs.find(j=>j.id===id);if(submit)await submit(job);else Object.assign(job.attempts.at(-1),{state:'acknowledged',count:'dispatched',hold:true});return null;});
 const ports={provider:{policy(){assert.fail('The scheduler contract harness must not call transport policy');}},queueOrigin:ORIGIN,automatic:false,now:()=>clock.now};
 let runtime=new ProviderExecution(store,config,ports);
 t.after(async()=>{await runtime.close();assert.equal(queue.authorizeProvider,undefined);assert.deepEqual(egressAttempts(),[]);});
 return {store,queue,jobs,calls,observations,clock,config,get runtime(){return runtime;},request(index=0){return requestFor(store,config,jobs[index]);},authorize(index=0,changes={}){const job=jobs[index],a=job.attempts.at(-1),body={...requestFor(store,config,job),...changes},authorization=queue.authorizeProvider(structuredClone(job),structuredClone(a),body);a.providerAuthorization=authorization;return authorization;},async reopen(){await runtime.close();assert.equal(queue.authorizeProvider,undefined);store.epoch='epoch_2';runtime=new ProviderExecution(store,config,ports);}};
}

test('isolated scheduler harness requires exact V45 approval and exposes only the blocked public capability',async t=>{
 const x=scheduler(t),before=structuredClone(x.jobs);await x.runtime.tick();assert.deepEqual(x.calls,[]);assert.deepEqual(x.jobs,before);
 for(const changes of [{configurationId:'other'},{configurationHash:'b'.repeat(64)},{epoch:'other'},{jobId:'other'},{attemptId:'other'},{reviewToken:sha('other')},{profileId:PRODUCTION_PROFILE.id},{profileVersion:2},{disclosureDigest:PRODUCTION_PRIVACY.disclosureDigest},{acknowledgeChargeAndPrivacy:false}]){
  assert.throws(()=>x.authorize(0,changes),/PROVIDER_APPROVAL_CHANGED/,JSON.stringify(changes));assert.deepEqual(x.jobs,before);
 }
 const view=x.runtime.view();assert.equal(view.operation,'generate-v45');assert.equal(view.ready,false);assert.equal(view.state,'admission-blocked');assert.deepEqual(view.admission,V45_ADMISSION);assert.equal(JSON.stringify(view).includes(SENTINEL_KEY),false);
 x.authorize();await x.runtime.tick();await x.runtime.tick();assert.deepEqual(x.calls,['job_1']);assert.equal(x.runtime.view().limits.usedRequests,1);assert.equal(x.runtime.view().limits.usedImages,1);assert.equal(x.runtime.view().ready,false);assert.deepEqual(x.jobs[0].review,before[0].review);
});

test('isolated scheduler harness rejects non-milestone drafts and staged attachments',async t=>{
 const x=scheduler(t,{fields:[{quality:'high'},{count:'2'},{promptExpansion:'disabled'},{size:'landscape_16_9'},{}]});x.jobs[4].stagePlan.push({role:'source'});
 for(let i=0;i<x.jobs.length;i++)assert.throws(()=>x.authorize(i),/PROVIDER_REQUEST_OUTSIDE_APPROVAL/);
 await x.runtime.tick();assert.deepEqual(x.calls,[]);assert(x.jobs.every(job=>!job.attempts[0].providerAuthorization));
});

for(const limit of [{maxRequests:1,maxImages:3},{maxRequests:3,maxImages:1}])test('isolated scheduler harness rechecks '+Object.keys(limit).find(k=>limit[k]===1)+' at dispatch and counts retained attempts across epochs',async t=>{
 const x=scheduler(t,{config:configuration(limit),fields:[{},{}]});x.authorize(0);x.authorize(1);
 await Promise.all([x.runtime.tick(),x.runtime.tick()]);assert.deepEqual(x.calls,['job_1']);assert.equal(x.jobs[1].attempts[0].state,'not-started');assert.equal(x.runtime.view().state,'limit-reached');
 assert.throws(()=>x.authorize(1),/PROVIDER_AUTHORIZATION_LIMIT/);await x.reopen();await x.runtime.tick();assert.deepEqual(x.calls,['job_1']);assert.equal(x.runtime.view().limits.usedRequests,1);assert.equal(x.runtime.view().limits.usedImages,1);assert.throws(()=>x.authorize(1),/PROVIDER_AUTHORIZATION_LIMIT/);
});

test('isolated scheduler harness expires new work and refuses stale-epoch authorization after reopening',async t=>{
 const x=scheduler(t);x.authorize();const authorization=structuredClone(x.jobs[0].attempts[0].providerAuthorization);await x.reopen();await x.runtime.tick();assert.deepEqual(x.calls,[]);assert.deepEqual(x.jobs[0].attempts[0].providerAuthorization,authorization);
 x.authorize();x.clock.now=Date.parse(x.config.manifest.expiresAt);await x.runtime.tick();assert.deepEqual(x.calls,[]);assert.equal(x.jobs[0].attempts[0].count,'none');assert.equal(x.runtime.view().state,'expired');assert.throws(()=>x.authorize(),/PROVIDER_AUTHORIZATION_EXPIRED/);
});

test('isolated scheduler harness never schedules an uncertain attempt again',async t=>{
 const x=scheduler(t,{submit:job=>{Object.assign(job.attempts[0],{state:'submission-uncertain',count:'dispatched',hold:true});throw Error('Fixture lost acknowledgement');}});x.authorize();await x.runtime.tick();await x.runtime.tick();await x.reopen();await x.runtime.tick();assert.deepEqual(x.calls,['job_1']);assert.equal(x.jobs[0].attempts.length,1);assert.equal(x.jobs[0].attempts[0].hold,true);assert.equal(x.runtime.view().limits.usedRequests,1);
});

async function owned(f){
 await f.close();const owner=await acquireRoot(f.root);let db;try{db=new StoreDatabase(f.root,()=>{});}catch(error){owner.close();throw error;}let closed=false;
 return {db,async close(){if(closed)return;closed=true;await db.candidates.close();await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();owner.close();}};
}
test('actual writer keeps V45 authorization, reservation and final dispatch blocked with a valid fixture engine',async t=>{
 const cleanup=[];let o,runtime;
 t.after(async()=>{await runtime?.close();await o?.close();for(const fn of cleanup)await fn();assert.deepEqual(egressAttempts(),[]);});
 const f=await fixture({name:t.name,after:fn=>cleanup.push(fn)}),text=await caption(f.writer,'Actual retained V45 draft'),draft=newV45Draft(text.blob),asset=await caption(f.writer,JSON.stringify(draft));
 assert.equal((await ui(f.writer,{type:'SaveDraft',draft:{id:'queue_draft',generation:'1',kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:await f.writer.documentRevision('document_1'),assetId:asset.id,composing:false}})).status,'accepted');
 const prepared=await accept(f.writer),queued=await enqueue(f.writer,prepared.body);o=await owned(f);
 const config=configuration({},Date.now()),provider=emulator({queueOrigin:ORIGIN,mediaOrigin:ORIGIN,profiles:[V45_GENERATION_FIXTURE_PROFILE]});
 runtime=new ProviderExecution(o.db,config,{provider,queueOrigin:ORIGIN,automatic:false});assert.equal(runtime.view().ready,false);assert.deepEqual(runtime.view().admission,V45_ADMISSION);
 const before=o.db.queue.view(),job=before.jobs.find(value=>value.id===queued.job.id),outbox=o.db.db.prepare('SELECT * FROM queue_outbox').all();let authorizations=0;
 const installed=o.db.queue.authorizeProvider;o.db.queue.authorizeProvider=(...args)=>{authorizations++;return installed(...args);};
 try{
  const receipt=await o.db.queue.command(encode(envelope(requestFor(o.db,config,job))),auth());assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'INCOMPATIBLE');
  const detail=JSON.parse(Buffer.from(o.db.objects.verify(receipt.details,true)).toString());assert.equal(detail.issues[0].code,'V45_SAFETY_ADMISSION_BLOCKED');assert.equal(authorizations,0);
  assert.equal(o.db.queue.reserve(job.id),null);await runtime.tick();assert.deepEqual(o.db.queue.view(),before);assert.deepEqual(o.db.db.prepare('SELECT * FROM queue_outbox').all(),outbox);
  // Fault injection only: even a fabricated reserved durable row cannot reach
  // transport. Restore it before cleanup and do not treat it as fixture authority.
  const forged=structuredClone(job);Object.assign(forged.attempts[0],{count:'reserved',hold:true});
  o.db.db.prepare('UPDATE queue_jobs SET json=? WHERE id=?').run(JSON.stringify(forged),forged.id);
  try{assert.throws(()=>o.db.queue.dispatch(job.id,job.attempts[0].id,{},{}),/V45_SAFETY_ADMISSION_BLOCKED/);assert.deepEqual(o.db.db.prepare('SELECT * FROM queue_outbox').all(),outbox);}
  finally{o.db.db.prepare('UPDATE queue_jobs SET json=? WHERE id=?').run(JSON.stringify(job),job.id);}
  assert.deepEqual(o.db.queue.view(),before);
 }finally{o.db.queue.authorizeProvider=installed;}
 await runtime.close();assert.equal(o.db.queue.authorizeProvider,undefined);
});

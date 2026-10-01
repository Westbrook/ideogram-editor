import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,prepare,enqueue,auth,envelope,encode} from '../queue/helpers.mjs';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {AssetRejection} from '../../dist/local/server/storage/assets.js';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {fixtureProfile} from './emulator.mjs';
import {egressAttempts} from './no-egress.mjs';

const digest='a'.repeat(64),configurationHash=digest;
const policy=resolvePrivacy(fixtureProfile(),'ideogram/v4','fixture').applied;
async function owned(f){
 await f.close();const owner=await acquireRoot(f.root),db=new StoreDatabase(f.root,()=>{});let closed=false;
 return {db,async close(){if(closed)return;closed=true;await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();owner.close();}};
}
function body(job,epoch){return {type:'AuthorizeProviderJob',jobId:job.id,attemptId:job.attempts.at(-1).id,expectedVersion:job.version,reviewToken:job.review.token,configurationId:'test_configuration',configurationHash,epoch,profileId:'test_profile',profileVersion:1,disclosureDigest:digest,acknowledgeChargeAndPrivacy:true};}
function authorization(job,attempt,request){return {id:randomUUID(),configurationId:request.configurationId,configurationHash:request.configurationHash,epoch:request.epoch,jobId:job.id,attemptId:attempt.id,reviewToken:request.reviewToken,profileId:request.profileId,profileVersion:request.profileVersion,disclosureDigest:request.disclosureDigest,authorizedAt:new Date().toISOString()};}
function rows(root,sql){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}}
function detail(db,receipt){return JSON.parse(Buffer.from(db.objects.verify(receipt.details,true)).toString());}
async function send(db,request){return db.queue.command(encode(envelope(request)),auth());}

test('provider authorization stays unavailable without an explicit runtime capability',async t=>{
 const f=await fixture(t),p=await prepare(f.writer),q=await enqueue(f.writer,p.body),o=await owned(f);
 try{
  const before=o.db.queue.view(),outbox=rows(f.root,'SELECT * FROM queue_outbox');
  const receipt=await send(o.db,body(before.jobs[0],o.db.epoch));
  assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'INCOMPATIBLE');
  assert.equal(detail(o.db,receipt).issues[0].code,'PROVIDER_UNAVAILABLE');
  assert.deepEqual(o.db.queue.view(),before);assert.deepEqual(rows(f.root,'SELECT * FROM queue_outbox'),outbox);
  assert.equal(q.job.attempts[0].providerAuthorization,undefined);assert.deepEqual(egressAttempts(),[]);
 }finally{await o.close();}
});

test('provider authorization is immutable durable attempt state with idempotent delivery',async t=>{
 const f=await fixture(t),p=await prepare(f.writer),q=await enqueue(f.writer,p.body),o=await owned(f);let saved,calls=0;
 try{
  const initial=o.db.queue.view().jobs[0],outbox=rows(f.root,'SELECT * FROM queue_outbox');
  o.db.queue.authorizeProvider=(job,attempt,request)=>{calls++;saved=authorization(job,attempt,request);job.disposition='deleted';attempt.hold=true;request.configurationId='mutated_callback_input';return saved;};
  const request=envelope(body(initial,o.db.epoch)),receipt=await o.db.queue.command(encode(request),auth());
  assert.equal(receipt.status,'accepted');const current=o.db.queue.view().jobs[0];
  assert.equal(current.version,String(BigInt(initial.version)+1n));assert.equal(current.attempts[0].version,String(BigInt(initial.attempts[0].version)+1n));
  assert.deepEqual(current.attempts[0].providerAuthorization,saved);assert.equal(current.disposition,'eligible');assert.equal(current.attempts[0].hold,false);
  assert.equal(current.attempts[0].state,'not-started');assert.equal(current.attempts[0].count,'none');assert.deepEqual(rows(f.root,'SELECT * FROM queue_outbox'),outbox);
  saved.configurationId='mutated_result';assert.equal(o.db.queue.view().jobs[0].attempts[0].providerAuthorization.configurationId,'test_configuration');
  o.db.queue.authorizeProvider=undefined;assert.deepEqual(await o.db.queue.command(encode(request),auth()),receipt);assert.equal(calls,1);
  const repeat=await send(o.db,body(current,o.db.epoch));assert.equal(repeat.status,'rejected');assert.equal(detail(o.db,repeat).issues[0].code,'PROVIDER_AUTHORIZATION_ALREADY_RECORDED');
  assert.equal(rows(f.root,"SELECT * FROM events_v2 WHERE json_extract(json,'$.type')='QueueStateChanged'").length,1);
  assert.equal(rows(f.root,"SELECT * FROM queue_journal WHERE json_extract(json,'$.event')='AuthorizeProviderJob'").length,1);
  await o.close();await f.reopen();const restored=(await f.writer.queueView()).jobs.find(j=>j.id===q.job.id);
  assert.deepEqual(restored,current);assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);assert.deepEqual(egressAttempts(),[]);
 }finally{await o.close();}
});

test('stale queue review and attempt fences reject authorization before runtime policy',async t=>{
 const f=await fixture(t),p=await prepare(f.writer),q=await enqueue(f.writer,p.body),o=await owned(f);let calls=0;
 try{
  o.db.queue.authorizeProvider=(...args)=>{calls++;return authorization(...args);};
  const initial=o.db.queue.view().jobs[0],request=body(initial,o.db.epoch);
  for(const [changes,reason] of [[{expectedVersion:'0'},'JOB_CHANGED'],[{attemptId:'wrong_attempt'},'ATTEMPT_CHANGED'],[{reviewToken:'sha256:'+'b'.repeat(64)},'REVIEW_CHANGED']]){
   const receipt=await send(o.db,{...request,...changes});assert.equal(receipt.status,'rejected');assert.equal(detail(o.db,receipt).issues[0].code,reason);assert.deepEqual(o.db.queue.view().jobs[0],initial);
  }
  const cancel=await send(o.db,{type:'CancelUnstartedJob',jobId:q.job.id,expectedVersion:initial.version});assert.equal(cancel.status,'accepted');
  const cancelled=o.db.queue.view().jobs[0],receipt=await send(o.db,body(cancelled,o.db.epoch));assert.equal(receipt.status,'rejected');assert.equal(detail(o.db,receipt).issues[0].code,'ATTEMPT_CHANGED');assert.equal(calls,0);
 }finally{await o.close();}
});

test('set-aside and deleted jobs cannot acquire provider authorization',async t=>{
 const f=await fixture(t),p=await prepare(f.writer),q1=await enqueue(f.writer,p.body),q2=await enqueue(f.writer,p.body),o=await owned(f);let calls=0;
 try{
  o.db.queue.authorizeProvider=(...args)=>{calls++;return authorization(...args);};
  const initial=o.db.queue.view().jobs.find(j=>j.id===q1.job.id);
  assert.equal((await send(o.db,{type:'RedoPendingJob',jobId:initial.id,attemptId:initial.attempts[0].id,expectedVersion:initial.version})).status,'accepted');
  const setAside=o.db.queue.view().jobs.find(j=>j.id===q1.job.id),denied=await send(o.db,body(setAside,o.db.epoch));assert.equal(denied.status,'rejected');assert.equal(detail(o.db,denied).issues[0].code,'JOB_NOT_ELIGIBLE');
  o.db.db.prepare('INSERT INTO candidate_document_tombstones VALUES (?,?)').run('document_1','1');const deleted=o.db.queue.view().jobs.find(j=>j.id===q2.job.id),receipt=await send(o.db,body(deleted,o.db.epoch));
  assert.equal(receipt.status,'rejected');assert.equal(detail(o.db,receipt).issues[0].code,'DOCUMENT_DELETED');assert.equal(deleted.attempts[0].state,'not-started');assert.equal(calls,0);
 }finally{await o.close();}
});

test('runtime authorization rejection leaves queue and outbox untouched',async t=>{
 const f=await fixture(t),p=await prepare(f.writer);await enqueue(f.writer,p.body);const o=await owned(f);
 try{
  const before=o.db.queue.view(),outbox=rows(f.root,'SELECT * FROM queue_outbox');let calls=0;
  o.db.queue.authorizeProvider=()=>{calls++;throw new AssetRejection('STALE_REVISION','PROVIDER_CONFIGURATION_CHANGED');};
  const receipt=await send(o.db,body(before.jobs[0],o.db.epoch));assert.equal(receipt.status,'rejected');assert.equal(detail(o.db,receipt).issues[0].code,'PROVIDER_CONFIGURATION_CHANGED');
  assert.equal(calls,1);assert.deepEqual(o.db.queue.view(),before);assert.deepEqual(rows(f.root,'SELECT * FROM queue_outbox'),outbox);assert.deepEqual(egressAttempts(),[]);
 }finally{await o.close();}
});

test('an explicit uncertain retry starts without the previous attempt authorization',async t=>{
 const f=await fixture(t),p=await prepare(f.writer),q=await enqueue(f.writer,p.body),o=await owned(f);
 try{
  o.db.queue.authorizeProvider=authorization;assert.equal((await send(o.db,body(o.db.queue.view().jobs[0],o.db.epoch))).status,'accepted');
  const reserved=o.db.queue.reserve(q.job.id),dispatched=o.db.queue.dispatch(q.job.id,reserved.attempt.id,{},policy);
  o.db.queue.outcome(q.job.id,reserved.attempt.id,dispatched.epoch,{kind:'uncertain',reason:'fixture response lost'});
  let job=o.db.queue.view().jobs[0];assert.equal((await send(o.db,{type:'OverrideUncertainHold',jobId:job.id,attemptId:job.attempts[0].id,expectedVersion:job.version,acknowledgeOverlapAndChargeRisk:true})).status,'accepted');
  job=o.db.queue.view().jobs[0];assert.equal((await send(o.db,{type:'RetryUncertainJob',jobId:job.id,attemptId:job.attempts[0].id,expectedVersion:job.version,acknowledgeDuplicateWorkAndChargeRisk:true})).status,'accepted');
  job=o.db.queue.view().jobs[0];assert.equal(job.attempts.length,2);assert(job.attempts[0].providerAuthorization);assert.equal(job.attempts[1].providerAuthorization,undefined);
  const oldAttempt=await send(o.db,{...body(job,o.db.epoch),attemptId:job.attempts[0].id});assert.equal(oldAttempt.status,'rejected');assert.equal(detail(o.db,oldAttempt).issues[0].code,'ATTEMPT_CHANGED');
  assert.equal((await send(o.db,body(job,o.db.epoch))).status,'accepted');const next=o.db.queue.view().jobs[0].attempts[1];assert.equal(next.providerAuthorization.attemptId,next.id);assert.notEqual(next.providerAuthorization.id,job.attempts[0].providerAuthorization.id);assert.deepEqual(egressAttempts(),[]);
 }finally{await o.close();}
});

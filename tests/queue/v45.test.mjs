// Staged integration tests for promotion into tests/queue; not executed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,caption,ui,accept,enqueue,auth,encode,envelope,prepare} from './helpers.mjs';
import {newV45Draft,resolve,bodyTemplate} from '../../dist/local/src/request/family.js';
import {queueModelAdmission} from '../../dist/local/src/protocol/queue.js';
import {materializeTransportTemplate} from '../../dist/local/server/storage/queue-transport.js';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';

const prompt='A retained Café 東京 prompt';
const objectPath=(root,ref)=>join(root,'objects/sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function prepareV45(w,fields={}){
 const text=await caption(w,prompt),draft=newV45Draft(text.blob);Object.assign(draft.fields,fields);
 const asset=await caption(w,JSON.stringify(draft));
 const saved=await ui(w,{type:'SaveDraft',draft:{id:'queue_draft',generation:'1',kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:await w.documentRevision('document_1'),assetId:asset.id,composing:false}});
 assert.equal(saved.status,'accepted',JSON.stringify(saved));return {...await accept(w),draft};
}
async function owned(f){
 await f.close();const owner=await acquireRoot(f.root),db=new StoreDatabase(f.root,()=>{});let closed=false;
 return {db,async close(){if(closed)return;closed=true;await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();owner.close();}};
}

test('V45 local enqueue retains exact request and policy identities through duplicate delivery and reopen',async t=>{
 const f=await fixture(t),prepared=await prepareV45(f.writer,{quality:'high',promptExpansion:'disabled',count:'2',seed:'900719925474099312345'}),queued=await enqueue(f.writer,prepared.body);
 assert.equal(queued.job.review.kind,'request-review-v45-1');assert.equal(queued.job.review.endpoint,'ideogram/v4.5');
 assert.deepEqual(queued.job.review,prepared.review);assert.deepEqual(queued.job.stagePlan,[]);
 assert.equal(Object.hasOwn(queued.job.review.request.modelRequest.body,'prompt'),false);assert.equal(Object.hasOwn(queued.job.review.request.modelRequest,'seed'),false);
 assert.deepEqual(queued.job.review.request.settings.seed,{kind:'integer',decimal:'900719925474099312345'});
 assert.equal(queued.job.review.providerReview.resultContract,'ideogram-v45-result-1');
 assert.equal(queued.job.review.providerReview.admission.policy,'unknown-withheld-1');assert.equal(queued.job.review.providerReview.admission.state,'blocked');
 assert.equal(queued.job.review.providerReview.privacyProfile,null);assert.equal(queued.job.review.providerReview.dispatch,false);
 assert.equal(queueModelAdmission(queued.job.review),'blocked-unavailable-evidence');
 const template=await readFile(objectPath(f.root,queued.job.review.template),'utf8');
 assert.equal(template,bodyTemplate(resolve(prepared.draft,prompt),prompt));assert.match(template,/"seed":900719925474099312345/);
 assert.doesNotMatch(template,/"(?:expansion_model|rendering_speed|acceleration|output_format|enable_safety_checker|strength)":/);
 assert.deepEqual(await f.writer.queueCommand(encode(queued.request),auth()),queued.receipt);
 assert.equal(queued.job.attempts[0].providerAuthorization,undefined);assert.equal(queued.job.attempts[0].count,'none');assert.equal(queued.job.attempts[0].hold,false);
 const writer=await f.reopen(),restored=(await writer.queueView()).jobs.find(job=>job.id===queued.job.id);
 assert.deepEqual(restored,queued.job);assert.deepEqual(await writer.queueCommand(encode(queued.request),auth()),queued.receipt);
});

test('V45 queue refuses authorization and reservations before provider capability or transport evidence',async t=>{
 const f=await fixture(t),prepared=await prepareV45(f.writer),queued=await enqueue(f.writer,prepared.body),o=await owned(f);let authorizations=0;
 try{
  o.db.queue.authorizeProvider=()=>{authorizations++;throw Error('Provider capability must not be reached');};
  const before=o.db.queue.view(),job=before.jobs.find(value=>value.id===queued.job.id),attempt=job.attempts[0];
  const outbox=o.db.db.prepare('SELECT * FROM queue_outbox').all();
  const body={type:'AuthorizeProviderJob',jobId:job.id,attemptId:attempt.id,expectedVersion:job.version,reviewToken:job.review.token,configurationId:'fixture_config',configurationHash:'a'.repeat(64),epoch:o.db.epoch,profileId:'fixture_profile',profileVersion:1,disclosureDigest:'b'.repeat(64),acknowledgeChargeAndPrivacy:true};
  const denied=await o.db.queue.command(encode(envelope(body)),auth());assert.equal(denied.status,'rejected');assert.equal(denied.code,'INCOMPATIBLE');
  const details=JSON.parse(Buffer.from(o.db.objects.verify(denied.details,true)).toString());assert.equal(details.issues[0].code,'V45_SAFETY_ADMISSION_BLOCKED');
  assert.equal(authorizations,0);assert.equal(o.db.queue.reserve(job.id),null);assert.deepEqual(o.db.queue.view(),before);
  assert.deepEqual(o.db.db.prepare('SELECT * FROM queue_outbox').all(),outbox);
  // A fabricated reserved record cannot bypass the final dispatch boundary.
  const forged=structuredClone(job);forged.attempts[0].count='reserved';forged.attempts[0].hold=true;
  o.db.db.prepare('UPDATE queue_jobs SET json=? WHERE id=?').run(JSON.stringify(forged),forged.id);
  let transportReads=0;o.db.queue.evidence.begin=()=>{transportReads++;throw Error('Evidence sink must not be reached');};
  assert.throws(()=>o.db.queue.dispatch(forged.id,attempt.id,{},{}),/V45_SAFETY_ADMISSION_BLOCKED/);assert.equal(transportReads,0);
  assert.deepEqual(o.db.db.prepare('SELECT * FROM queue_outbox').all(),outbox);
 }finally{await o.close();}
});

test('V45 transport materialization preserves exact seed bytes and refuses additions or changed templates',async t=>{
 const f=await fixture(t),prepared=await prepareV45(f.writer,{seed:'900719925474099312345'}),request=prepared.review.request;
 const template=await readFile(objectPath(f.root,prepared.review.template),'utf8');
 assert.equal(materializeTransportTemplate(template,request,[],{},prompt),template);
 assert.throws(()=>materializeTransportTemplate(template,request,[],{}),error=>error.code==='CORRUPT_OBJECT');
 assert.throws(()=>materializeTransportTemplate(template,request,[],{},prompt+' changed'));
 assert.throws(()=>materializeTransportTemplate(template,request,[],{source:'https://fixture.invalid/source'},prompt),error=>error.code==='MALFORMED_REQUEST');
 const attachment={role:'source',original:prepared.review.prompt,transport:prepared.review.prompt,width:1,height:1,conversion:null};
 assert.throws(()=>materializeTransportTemplate(template,request,[attachment],{source:'https://fixture.invalid/source'},prompt),error=>error.code==='MALFORMED_REQUEST');
 assert.throws(()=>materializeTransportTemplate(template.replace('"quality":"medium"','"quality":"high"'),request,[],{},prompt),error=>error.code==='CORRUPT_OBJECT');
 const changed=structuredClone(request);changed.settings.count=2;
 assert.throws(()=>materializeTransportTemplate(template,changed,[],{},prompt));
});

test('explicit V4 compatibility keeps its established envelope, template and admission boundary',async t=>{
 const f=await fixture(t),prepared=await prepare(f.writer,draft=>draft.fields.seed='900719925474099312345'),queued=await enqueue(f.writer,prepared.body);
 assert.equal(queued.job.review.kind,'request-review-1');assert.equal(queued.job.review.endpoint,'ideogram/v4');assert.equal('modelRequest' in queued.job.review.request,false);assert.equal('providerReview' in queued.job.review,false);
 assert.equal(queueModelAdmission(queued.job.review),'provider-profile-required');
 const template=await readFile(objectPath(f.root,queued.job.review.template),'utf8');assert.equal(materializeTransportTemplate(template,queued.job.review.request,[],{}),template);
 assert.match(template,/"seed":900719925474099312345/);assert.match(template,/"enable_safety_checker":true/);assert.match(template,/"expansion_model":"Medium"/);
 assert.equal(queued.job.attempts[0].providerAuthorization,undefined);
});

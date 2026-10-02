import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,prepare,enqueue,ui,auth,envelope,encode,command,EMPTY_EXPECTED_VERSIONS,legacyAcknowledgement} from './helpers.mjs';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {serverPhases} from '../../dist/local/server/observability/phases.js';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {fixtureProfile} from '../provider/emulator.mjs';

async function traceHighWater(writer){const read=await writer.readDiagnostics();try{return highWater(read.value.observations.phases);}finally{read.release();}}
async function inspectTrace(writer,inspect){const read=await writer.readDiagnostics();try{await inspect(read.value.observations.phases);}finally{read.release();}}
const highWater=snapshot=>snapshot.records.at(-1)?.sequence??0;
const transitions=(snapshot,after)=>snapshot.records.filter(row=>row.sequence>after&&row.phase==='job.eligible');
const move=(view,job,neighbor,direction)=>envelope({type:'ReorderLocalQueue',jobId:job.id,expectedVersion:job.version,neighborId:neighbor.id,expectedNeighborVersion:neighbor.version,expectedOrderVersion:view.orderVersion,direction});
async function jobs(writer,count=3){const review=await prepare(writer),result=[];for(let index=0;index<count;index++)result.push((await enqueue(writer,review.body)).job);return result;}
function transition(row,job,commandId){assert.equal(row.outcome,'ok');assert.equal(row.startedMs,row.endedMs);assert.equal(row.durationMs,0);assert.equal(row.context.eligibility,'local-order');assert.equal(row.context.boundary,'authority-durable');assert.equal(row.context.jobId,job.id);assert.equal(row.context.attemptId,job.attempts.at(-1).id);assert.equal(row.context.documentId,job.documentId);assert.equal(row.context.commandId,commandId);}
async function close(store,owner){if(store){await store.displays.close();await store.candidates.close();await store.queue.close();await store.portables.close();await store.histories.close();await store.rasters.close();await store.assets.close();await store.recovery.settle();store.close();}owner.close();}

test('eligibility traces only the final durable head change, not a tail reorder or duplicate delivery',async t=>{
 const f=await fixture(t),created=await jobs(f.writer),before=await traceHighWater(f.writer);let view=await f.writer.queueView();
 const tail=move(view,view.jobs[2],view.jobs[1],'up');assert.equal((await f.writer.queueCommand(encode(tail),auth())).status,'accepted');await inspectTrace(f.writer,snapshot=>assert.deepEqual(transitions(snapshot,before),[]));
 view=await f.writer.queueView();const final=move(view,view.jobs[1],view.jobs[0],'up'),receipt=await f.writer.queueCommand(encode(final),auth());assert.equal(receipt.status,'accepted');
 await inspectTrace(f.writer,async snapshot=>{const observed=transitions(snapshot,before);assert.equal(observed.length,1);transition(observed[0],created[2],final.command.commandId);assert.equal((await f.writer.lookup(final.command.commandId)).receipt.status,'accepted');assert.equal((await f.writer.queueView()).jobs[0].id,created[2].id);
  assert.deepEqual(await f.writer.queueCommand(encode(final),auth()),receipt);await inspectTrace(f.writer,later=>assert.deepEqual(transitions(later,before),observed));
 });
});

test('rejected reorder cannot emit an eligibility observation or change the head',async t=>{
 const f=await fixture(t);await jobs(f.writer);const view=await f.writer.queueView(),before=await traceHighWater(f.writer),request=move(view,view.jobs[1],{...view.jobs[0],version:'0'},'up');
 const receipt=await f.writer.queueCommand(encode(request),auth());assert.equal(receipt.status,'rejected');assert.deepEqual(await f.writer.queueView(),view);await inspectTrace(f.writer,snapshot=>assert.deepEqual(transitions(snapshot,before),[]));assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);await inspectTrace(f.writer,snapshot=>assert.deepEqual(transitions(snapshot,before),[]));
});

test('reservation is distinct from eligibility and safe cancellation links the newly eligible head to its durable command',async t=>{
 const f=await fixture(t),created=await jobs(f.writer,2),before=await traceHighWater(f.writer);assert(await f.writer.queueReserve(created[0].id));await inspectTrace(f.writer,snapshot=>assert.deepEqual(transitions(snapshot,before),[]));
 const held=(await f.writer.queueView()).jobs.find(job=>job.id===created[0].id),request=envelope({type:'CancelUnstartedJob',jobId:held.id,expectedVersion:held.version});assert.equal((await f.writer.queueCommand(encode(request),auth())).status,'accepted');
 await inspectTrace(f.writer,snapshot=>{const observed=transitions(snapshot,before);assert.equal(observed.length,1);transition(observed[0],created[1],request.command.commandId);});const view=await f.writer.queueView();assert.equal(view.counts.active,0);assert.equal(view.counts.dispatched,0);assert.equal(view.jobs.find(job=>job.id===held.id).local,'locally-cancelled');
});

test('terminal reconciliation emits the next exact attempt without inventing a command identity',async t=>{
 const f=await fixture(t),created=await jobs(f.writer,2),policy=resolvePrivacy(fixtureProfile(),'ideogram/v4','eligibility').applied,reservation=await f.writer.queueReserve(created[0].id),dispatch=await f.writer.queueDispatch(created[0].id,reservation.attempt.id,{},policy);assert(dispatch);
 const ack=legacyAcknowledgement(f.root,reservation.attempt.id,'existing_provider_request',{status:'http://127.0.0.1:1/status',result:'http://127.0.0.1:1/result',cancel:'http://127.0.0.1:1/cancel'},policy);await f.writer.queueOutcome(created[0].id,reservation.attempt.id,dispatch.epoch,ack);
 const acknowledged=await f.writer.queueRecovery(created[0].id,reservation.attempt.id);assert.equal(acknowledged.outbox.wireEvidence.submission,null);assert.equal(acknowledged.outbox.responseRecord,ack.responseRecord);
 const before=await traceHighWater(f.writer);await f.writer.queueOutcome(created[0].id,reservation.attempt.id,dispatch.epoch,{kind:'terminal',status:'COMPLETED'});
 await inspectTrace(f.writer,snapshot=>{const observed=transitions(snapshot,before);assert.equal(observed.length,1);transition(observed[0],created[1],undefined);assert.equal(Object.hasOwn(observed[0].context,'commandId'),false);});assert.equal((await f.writer.queueView()).counts.dispatched,1);
});

test('deleting the head document emits the next document head only after the deletion command commits',async t=>{
 const f=await fixture(t),prepared=await prepare(f.writer),first=await enqueue(f.writer,prepared.body);assert.equal((await f.writer.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{documentId:'document_2'})),f.writer.epoch)).status,'accepted');
 assert.equal((await ui(f.writer,{type:'SaveDraft',draft:{id:'document_two_request',generation:'1',kind:'request',documentId:'document_2',targetLayerId:null,expectedDocumentRevision:'1',assetId:prepared.review.draftAsset,composing:false}})).status,'accepted');
 const review=await ui(f.writer,{type:'PrepareRequestReview',draftId:'document_two_request',generation:'1'});assert.equal(review.status,'accepted');const accepted=await ui(f.writer,{type:'AcceptRequestReview',reviewId:review.review.id,token:review.review.token});assert.equal(accepted.status,'accepted');const second=await enqueue(f.writer,{type:'QueueInference',reviewId:review.review.id,token:review.review.token,acceptanceId:accepted.requestId});
 assert(await f.writer.queueReserve(first.job.id));assert.equal((await f.writer.queueCommand(encode(envelope({type:'PreviewDocumentDeletion',documentId:'document_1',expectedRevision:'1'})),auth())).status,'accepted');const plan=(await f.writer.deletionView('document_1',auth())).plan,request=envelope({type:'DeleteDocument',documentId:plan.documentId,planId:plan.id,planHash:plan.planHash,rootGeneration:plan.rootGeneration,expectedRevision:plan.documentRevision,acknowledgeRunningAndUncertain:true}),before=await traceHighWater(f.writer);
 const receipt=await f.writer.queueCommand(encode(request),auth());assert.equal(receipt.status,'accepted');await inspectTrace(f.writer,snapshot=>{const observed=transitions(snapshot,before);assert.equal(observed.length,1);transition(observed[0],second.job,request.command.commandId);});assert.equal((await f.writer.lookup(request.command.commandId)).receipt.status,'accepted');assert.equal((await f.writer.queueView()).counts.active,0);assert.equal(await f.writer.documentRevision('document_1'),null);
});

test('a transaction that fails before COMMIT leaves no eligibility artifact',async t=>{
 const f=await fixture(t);await jobs(f.writer,2);await f.close();const owner=await acquireRoot(f.root);let store,armed=false;
 try{store=new StoreDatabase(f.root,phase=>{if(armed&&phase==='asset-before-commit')throw Error('fixture before commit');});const view=store.queue.view(),request=move(view,view.jobs[1],view.jobs[0],'up');let before;{const phaseRead=serverPhases.readSnapshot();try{before=highWater(phaseRead.value);}finally{phaseRead.release();}}armed=true;
  await assert.rejects(store.queue.command(encode(request),auth()),/fixture before commit/);armed=false;assert.deepEqual(store.queue.view(),view);assert.equal(store.lookup(request.command.commandId),null);{const phaseRead=serverPhases.readSnapshot();try{assert.deepEqual(transitions(phaseRead.value,before),[]);}finally{phaseRead.release();}}
 }finally{armed=false;await close(store,owner);}
});

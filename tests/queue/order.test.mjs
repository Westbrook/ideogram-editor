import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,prepare,accept,enqueue,config,auth,envelope,encode,legacyAcknowledgement} from './helpers.mjs';
import {childFor} from '../store/helpers.mjs';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {inspectTree} from '../../dist/local/server/storage/files.js';
import {QUEUE_ADMISSION_BYTES} from '../../dist/local/server/storage/queue.js';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {fixtureProfile} from '../provider/emulator.mjs';
import {canonical} from '../../dist/local/src/protocol/json.js';

const sql=(root,query)=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return db.prepare(query).all();}finally{db.close();}};
const ids=view=>view.jobs.map(job=>job.id);
const reorder=(view,job,neighbor,direction)=>envelope({type:'ReorderLocalQueue',jobId:job.id,expectedVersion:job.version,neighborId:neighbor.id,expectedNeighborVersion:neighbor.version,expectedOrderVersion:view.orderVersion,direction});
async function acceptedJobs(writer,count){const prepared=await prepare(writer),jobs=[];for(let i=0;i<count;i++)jobs.push((await enqueue(writer,prepared.body)).job);return jobs;}

test('local queue follows durable acceptance order across pages and restart',async t=>{
 const f=await fixture(t),jobs=await acceptedJobs(f.writer,23),expected=jobs.map(job=>job.id);
 assert.deepEqual(jobs.map(job=>job.order.insertionOrdinal),jobs.map((_,index)=>String(index+1)));
 assert(jobs.every(job=>job.order.origin==='accepted'));
 for(let reopen=0;reopen<2;reopen++){
  if(reopen)await f.reopen();
  const found=[];let cursor='',version,epoch;
  do{const page=await f.writer.queueView(cursor);assert(page.jobs.length<=20);version??=page.orderVersion;epoch??=page.orderEpoch;assert.equal(page.orderVersion,version);assert.equal(page.orderEpoch,epoch);found.push(...ids(page));cursor=page.nextCursor??'';}while(cursor);
  assert.deepEqual(found,expected);assert.equal(new Set(found).size,expected.length);
 }
});

test('legacy order uses the first immutable creation record and labels records without creation evidence',async t=>{
 const f=await fixture(t),[source]=await acceptedJobs(f.writer,1),outbox=JSON.parse(sql(f.root,'SELECT json FROM queue_outbox')[0].json);await f.close();
 // This isolated migration fixture only appends old-format records. Existing
 // immutable evidence and its update/delete triggers remain untouched.
 const legacy=id=>{const value=structuredClone(source);delete value.order;delete value.ownerClientId;value.id=id;value.version='1';value.attempts[0].id=id+'_attempt';return value;};
 const first=legacy('legacy_z'),second=legacy('legacy_a'),fallbackZ=legacy('fallback_z'),fallbackA=legacy('fallback_a'),db=new DatabaseSync(join(f.root,'metadata.sqlite'));
 try{db.exec('BEGIN IMMEDIATE');for(const job of [first,second,fallbackZ,fallbackA]){db.prepare('INSERT INTO queue_outbox VALUES (?,?,?)').run(job.attempts[0].id,job.id,canonical(outbox));db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family:'job',event:job.id.startsWith('legacy_')?'JobQueued':'LegacyStateRetained',epoch:f.writer.epoch,at:'2000-01-01T00:00:00.000Z',value:job}));}db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family:'job',event:'LegacyStateRetained',epoch:f.writer.epoch,at:'1999-01-01T00:00:00.000Z',value:{...first,version:'2'}}));db.exec('COMMIT');}finally{db.close();}
 const original=sql(f.root,'SELECT * FROM queue_journal ORDER BY seq');await f.reopen();const view=await f.writer.queueView();assert.deepEqual(ids(view),[source.id,first.id,second.id,fallbackA.id,fallbackZ.id]);
 for(const id of [first.id,second.id]){const job=view.jobs.find(item=>item.id===id);assert.equal(job.order.origin,'journal-unplaced');assert.equal(job.order.insertionOrdinal,null);assert.equal(job.ownerClientId,null);assert.equal(view.waiting[id].editable,false);assert.deepEqual(job.review,source.review);}
 for(const id of [fallbackA.id,fallbackZ.id]){const job=view.jobs.find(item=>item.id===id);assert.equal(job.order.origin,'legacy-id-order');assert.equal(job.order.insertionOrdinal,null);}
 assert.deepEqual(sql(f.root,'SELECT * FROM queue_journal ORDER BY seq').slice(0,original.length),original);await f.reopen();assert.deepEqual(await f.writer.queueView(),view);
});

test('adjacent reorder is atomic, durable and idempotent without changing frozen inputs or counts',async t=>{
 const f=await fixture(t),jobs=await acceptedJobs(f.writer,3),before=await f.writer.queueView(),outboxes=sql(f.root,'SELECT * FROM queue_outbox ORDER BY attempt_id');
 const request=reorder(before,before.jobs[2],before.jobs[1],'up'),receipt=await f.writer.queueCommand(encode(request),auth());
 assert.equal(receipt.status,'accepted');const after=await f.writer.queueView();assert.deepEqual(ids(after),[jobs[0].id,jobs[2].id,jobs[1].id]);assert.notEqual(after.orderVersion,before.orderVersion);assert.notEqual(after.orderEpoch,before.orderEpoch);assert.deepEqual(after.counts,before.counts);
 for(const old of before.jobs){const next=after.jobs.find(job=>job.id===old.id);assert.deepEqual(next.review,old.review);assert.deepEqual(next.stagePlan,old.stagePlan);assert.deepEqual(next.attempts,old.attempts);assert.equal(next.order.insertionOrdinal,old.order.insertionOrdinal);if(old.id!==jobs[0].id)assert(BigInt(next.version)>BigInt(old.version));}
 assert.deepEqual(sql(f.root,'SELECT * FROM queue_outbox ORDER BY attempt_id'),outboxes);
 assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);assert.deepEqual(await f.writer.queueView(),after);
 await f.reopen();assert.deepEqual(ids(await f.writer.queueView()),ids(after));assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);
 const reordered=await f.writer.queueView(),back=reorder(reordered,reordered.jobs[1],reordered.jobs[2],'down');assert.equal((await f.writer.queueCommand(encode(back),auth())).status,'accepted');assert.deepEqual(ids(await f.writer.queueView()),ids(before));
});

test('stale order, stale neighbor, nonadjacent and unavailable neighbors cannot publish a partial swap',async t=>{
 const f=await fixture(t);await acceptedJobs(f.writer,3);const original=await f.writer.queueView(),first=reorder(original,original.jobs[2],original.jobs[1],'up');assert.equal((await f.writer.queueCommand(encode(first),auth())).status,'accepted');
 const current=await f.writer.queueView(),attempts=[
  reorder(original,original.jobs[1],original.jobs[0],'up'),
  reorder(current,current.jobs[2],{...current.jobs[1],version:'0'},'up'),
  reorder(current,current.jobs[2],current.jobs[0],'up'),
  reorder(current,current.jobs[2],{id:'unavailable_job',version:'1'},'up'),
 ];
 const journal=sql(f.root,'SELECT * FROM queue_journal ORDER BY seq'),outboxes=sql(f.root,'SELECT * FROM queue_outbox ORDER BY attempt_id');
 for(const request of attempts){assert.equal((await f.writer.queueCommand(encode(request),auth())).status,'rejected');assert.deepEqual(await f.writer.queueView(),current);assert.deepEqual(sql(f.root,'SELECT * FROM queue_journal ORDER BY seq'),journal);assert.deepEqual(sql(f.root,'SELECT * FROM queue_outbox ORDER BY attempt_id'),outboxes);}
});

test('order cursor rejects a changed order instead of skipping or duplicating a page',async t=>{
 const f=await fixture(t);await acceptedJobs(f.writer,22);const first=await f.writer.queueView();assert(first.nextCursor);const second=await f.writer.queueView(first.nextCursor),request=reorder(first,first.jobs[19],second.jobs[0],'down');
 assert.equal((await f.writer.queueCommand(encode(request),auth())).status,'accepted');await assert.rejects(f.writer.queueView(first.nextCursor),error=>error.code==='STALE_EPOCH');
 const after=await f.writer.queueView(),tail=await f.writer.queueView(after.nextCursor);assert.equal(new Set([...ids(after),...ids(tail)]).size,22);assert.equal(after.jobs[19].id,second.jobs[0].id);assert.equal(tail.jobs[0].id,first.jobs[19].id);
 await assert.rejects(f.writer.queueView('x'.repeat(257)),error=>error.code==='MALFORMED_REQUEST');
});

test('spend configuration does not invalidate a position cursor when order is unchanged',async t=>{
 const f=await fixture(t);await acceptedJobs(f.writer,21);const before=await f.writer.queueView(),tail=await f.writer.queueView(before.nextCursor);assert.equal((await config(f.writer,1)).status,'accepted');
 const after=await f.writer.queueView();assert.equal(after.orderEpoch,before.orderEpoch);assert.deepEqual(ids(await f.writer.queueView(before.nextCursor)),ids(tail));
});

test('reservation honors local order and a held waiting attempt cannot be reordered',async t=>{
 const f=await fixture(t);await acceptedJobs(f.writer,3);const initial=await f.writer.queueView();assert.equal(await f.writer.queueReserve(initial.jobs[2].id),null);
 assert.equal((await f.writer.queueCommand(encode(reorder(initial,initial.jobs[1],initial.jobs[0],'up')),auth())).status,'accepted');const reordered=await f.writer.queueView();assert(await f.writer.queueReserve(reordered.jobs[0].id));const held=await f.writer.queueView(),request=reorder(held,held.jobs[0],held.jobs[1],'down');
 assert.equal((await f.writer.queueCommand(encode(request),auth())).status,'rejected');assert.deepEqual(await f.writer.queueView(),held);assert.equal(held.counts.active,1);assert.equal(held.counts.reserved,1);
});

test('a safe reservation released by a lowered cap remains ordered and can resume after the cap rises',async t=>{
 const f=await fixture(t),jobs=await acceptedJobs(f.writer,2),policy=resolvePrivacy(fixtureProfile(),'ideogram/v4','queue-order-cap').applied;assert.equal((await config(f.writer,2)).status,'accepted');
 const first=await f.writer.queueReserve(jobs[0].id),dispatch=await f.writer.queueDispatch(jobs[0].id,first.attempt.id,{},policy);assert(dispatch);const ack=legacyAcknowledgement(f.root,first.attempt.id,'ordered_request',{status:'http://127.0.0.1:1/status',result:'http://127.0.0.1:1/result',cancel:'http://127.0.0.1:1/cancel'},policy);await f.writer.queueOutcome(jobs[0].id,first.attempt.id,dispatch.epoch,ack);
 const acknowledged=await f.writer.queueRecovery(jobs[0].id,first.attempt.id);assert.equal(acknowledged.outbox.wireEvidence.submission,null);assert.equal(acknowledged.outbox.responseRecord,ack.responseRecord);await f.writer.queueOutcome(jobs[0].id,first.attempt.id,dispatch.epoch,{kind:'terminal',status:'COMPLETED'});
 const next=await f.writer.queueReserve(jobs[1].id);assert(next);assert.equal((await config(f.writer,1)).status,'accepted');assert.equal(await f.writer.queueDispatch(jobs[1].id,next.attempt.id,{},policy),null);
 const paused=await f.writer.queueView(),released=paused.jobs.find(job=>job.id===jobs[1].id);assert.equal(released.attempts[0].count,'released');assert.equal(released.attempts[0].hold,false);assert.equal(released.local,'paused-spend-cap');assert(paused.waiting[released.id]);assert.equal(paused.counts.active,0);assert.equal(paused.counts.dispatched,1);
 assert.equal((await config(f.writer,2)).status,'accepted');const resumed=await f.writer.queueReserve(jobs[1].id);assert(resumed);assert.equal(resumed.attempt.id,next.attempt.id);assert.equal(resumed.attempt.count,'reserved');assert.deepEqual(ids(await f.writer.queueView()),jobs.map(job=>job.id));
});

test('real metadata reservation pressure rejects acceptance without consuming queue order and permits a fresh retry',async t=>{
 const f=await fixture(t);await prepare(f.writer);await f.close();
 const margin=1024n**3n,emergency=64n*1024n**2n,quota=inspectTree(f.root)+margin+emergency+32n*1024n**2n,owner=await acquireRoot(f.root);let store;
 try{
  store=new StoreDatabase(f.root,()=>{},{quotaBytes:String(quota)});
  const facade={uiRead:(...args)=>store.ui.read(...args),uiPersist:(...args)=>store.ui.persist(...args)},prepared=await accept(facade),draft=store.ui.read('request_session',auth()),before=store.queue.view(),outbox=sql(f.root,'SELECT * FROM queue_outbox');
  // Fill the actual Objects reservation ledger, retaining less than the queue
  // admission allowance. No write or capacity method is replaced by a mock.
  const headroom=quota-inspectTree(f.root)-margin-emergency,pressure=(headroom-QUEUE_ADMISSION_BYTES/2n)*4n/5n;assert(pressure>0n);store.objects.reserve('queue-test-pressure',pressure);
  const reservation=store.objects.reservationInventory(),request=envelope(prepared.body),receipt=await store.queue.command(encode(request),auth());assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'CAPACITY');assert.deepEqual(store.queue.view(),before);assert.deepEqual(store.ui.read('request_session',auth()),draft);assert.deepEqual(sql(f.root,'SELECT * FROM queue_outbox'),outbox);assert.deepEqual(store.objects.reservationInventory(),reservation);assert.equal(store.objects.proofInventory().retained,0);
  store.objects.unreserve('queue-test-pressure');assert.deepEqual(store.objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});assert.deepEqual(await store.queue.command(encode(request),auth()),receipt);
  const retry=await store.queue.command(encode(envelope(prepared.body)),auth());assert.equal(retry.status,'accepted');assert.equal(store.queue.view().jobs[0].order.insertionOrdinal,'1');assert.equal(store.queue.view().totalJobs,1);assert.deepEqual(store.objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});
 }finally{if(store){store.objects.unreserve('queue-test-pressure');await store.displays.close();await store.candidates.close();await store.queue.close();await store.portables.close();await store.histories.close();await store.rasters.close();await store.assets.close();await store.recovery.settle();store.close();}owner.close();}
});

for(const [phase,accepted]of [['asset-before-commit',false],['asset-after-commit',true]])test('reorder crash at '+phase+' recovers both positions or neither',async t=>{
 const f=await fixture(t);await acceptedJobs(f.writer,2);const before=await f.writer.queueView(),request=reorder(before,before.jobs[1],before.jobs[0],'up');await f.close();const child=await childFor(t,f.root,{phase}),pending=child.call('queueCommand',encode(request),auth()).catch(error=>error);await child.wait('barrier');await child.assertNoEffects();await child.kill();await pending;
 await f.reopen();const receipt=await f.writer.lookup(request.command.commandId),after=await f.writer.queueView();assert.equal(!!receipt,accepted);assert.deepEqual(ids(after),accepted?ids(before).reverse():ids(before));assert.deepEqual(after.counts,before.counts);if(accepted)assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt.receipt);
});

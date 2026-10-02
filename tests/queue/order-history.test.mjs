import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {fixture,prepare,enqueue,config,auth,envelope,encode} from './helpers.mjs';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {fixtureProfile} from '../provider/emulator.mjs';

function rows(root,query,...args){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return db.prepare(query).all(...args);}finally{db.close();}}
async function seeded(t,{historical=0,waiting=0,paused=false}={}){
 const f=await fixture(t),prepared=await prepare(f.writer),{job:source}=await enqueue(f.writer,prepared.body),session=(await f.writer.queueView()).session;
 assert.equal((await f.writer.queueCommand(encode(envelope({type:'CancelUnstartedJob',jobId:source.id,expectedVersion:source.version})),auth())).status,'accepted');await f.close();
 const db=new DatabaseSync(join(f.root,'metadata.sqlite')),expected=[];
 try{db.exec('BEGIN IMMEDIATE');for(let index=0;index<historical+waiting;index++){
   const job=structuredClone(source),terminal=index<historical,id=(terminal?'retained_':'waiting_')+String(index).padStart(5,'0'),position=String(index+2);job.id=id;job.version='1';job.order={position,insertionOrdinal:position,origin:'accepted'};job.ownerClientId='client_1';job.local=terminal?'ready-to-dispatch':paused?'paused-spend-cap':'accepted-local-queue';job.disposition='eligible';
   const attempt=job.attempts[0];attempt.id=id+'_attempt';attempt.version='1';attempt.state=terminal?'provider-terminal':'not-started';attempt.hold=false;attempt.count=terminal?'dispatched':'none';attempt.spendSessionId=terminal?session.id:null;attempt.requestId=terminal?id+'_provider':null;attempt.terminal=terminal?'COMPLETED':null;
   const outbox={state:terminal?'terminal':'safe-unstarted',epoch:null,endpoint:job.review.endpoint,mapping:{},bodyRecord:null,payloadHash:null,requestId:attempt.requestId,urls:null,responseRecord:null};
   db.prepare('INSERT INTO queue_outbox VALUES (?,?,?)').run(attempt.id,id,canonical(outbox));db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family:'job',event:'RetainedFixtureState',epoch:f.writer.epoch,at:'2020-01-01T00:00:00.000Z',value:job}));expected.push({id,position,terminal});
  }db.exec('COMMIT');}finally{db.close();}
 await f.reopen();return {f,source,expected};
}

test('more than 1000 retained historical jobs remain traversable in bounded ordered pages with exact waiting neighbors',async t=>{
 const {f,source,expected}=await seeded(t,{historical:1200,waiting:41}),seen=[],waiting=[];let cursor='',pages=0;
 do{const page=await f.writer.queueView(cursor);assert(page.jobs.length<=20);assert(Object.keys(page.waiting).length<=20);assert.equal(page.totalJobs,1242);assert.equal(page.counts.dispatched,1200);assert.equal(page.counts.active,0);assert.equal(page.counts.reserved,0);
  for(const job of page.jobs){seen.push(job.id);const item=page.waiting[job.id];if(item)waiting.push({id:job.id,...item});}cursor=page.nextCursor??'';pages++;
 }while(cursor);
 assert.equal(pages,63);assert.deepEqual(seen,[source.id,...expected.map(job=>job.id)]);assert.equal(new Set(seen).size,seen.length);assert.equal(waiting.length,41);
 for(let index=0;index<waiting.length;index++){assert.equal(waiting[index].position,index+1);assert.equal(waiting[index].previous?.id??null,waiting[index-1]?.id??null);assert.equal(waiting[index].next?.id??null,waiting[index+1]?.id??null);}
 const current=await f.writer.queueView();assert.equal(current.orderEpoch,'0');
});

test('startup recovery and paused-job updates visit every indexed job exactly once across keyset pages',async t=>{
 const {f,expected}=await seeded(t,{historical:65,waiting:65,paused:true});
 const recovery=rows(f.root,"SELECT json_extract(json,'$.value.id') AS id,COUNT(*) AS n FROM queue_journal WHERE json_extract(json,'$.event')='RecoveryRequiresExplicitAction' GROUP BY json_extract(json,'$.value.id')");assert.equal(recovery.length,65);assert(recovery.every(row=>row.n===1));
 assert.equal((await config(f.writer,100)).status,'accepted');
 const changed=rows(f.root,"SELECT json_extract(json,'$.value.id') AS id,COUNT(*) AS n FROM queue_journal WHERE json_extract(json,'$.family')='job' AND json_extract(json,'$.event')='SpendGuardChanged' GROUP BY json_extract(json,'$.value.id')");assert.equal(changed.length,65);assert(changed.every(row=>row.n===1));assert.deepEqual(changed.map(row=>row.id).sort(),expected.filter(job=>!job.terminal).map(job=>job.id).sort());
 const waiting=rows(f.root,"SELECT json FROM queue_jobs WHERE json_extract(json,'$.attempts[0].state')='not-started'").map(row=>JSON.parse(row.json));assert.equal(waiting.length,65);assert(waiting.every(job=>job.version==='2'&&job.local==='accepted-local-queue'));
 await f.reopen();assert.deepEqual(rows(f.root,"SELECT json_extract(json,'$.value.id') AS id,COUNT(*) AS n FROM queue_journal WHERE json_extract(json,'$.event')='RecoveryRequiresExplicitAction' GROUP BY json_extract(json,'$.value.id')"),recovery);
});

test('document detachment visits every waiting job once without an active SQLite read over rewritten rows',async t=>{
 const {f,source,expected}=await seeded(t,{waiting:65}),revision=await f.writer.documentRevision('document_1');
 assert.equal((await f.writer.queueCommand(encode(envelope({type:'PreviewDocumentDeletion',documentId:'document_1',expectedRevision:revision})),auth())).status,'accepted');const plan=(await f.writer.deletionView('document_1',auth())).plan;
 const receipt=await f.writer.queueCommand(encode(envelope({type:'DeleteDocument',documentId:plan.documentId,planId:plan.id,planHash:plan.planHash,rootGeneration:plan.rootGeneration,expectedRevision:plan.documentRevision,acknowledgeRunningAndUncertain:true})),auth());assert.equal(receipt.status,'accepted');
 const detached=rows(f.root,"SELECT json_extract(json,'$.value.id') AS id,COUNT(*) AS n FROM queue_journal WHERE json_extract(json,'$.event')='DocumentDetached' GROUP BY json_extract(json,'$.value.id')");assert.equal(detached.length,66);assert(detached.every(row=>row.n===1));assert.deepEqual(detached.map(row=>row.id).sort(),[source.id,...expected.map(job=>job.id)].sort());
 for(const row of rows(f.root,'SELECT json FROM queue_jobs')){const job=JSON.parse(row.json);assert.equal(job.disposition,'deleted');assert.equal(job.local,'locally-cancelled');assert.equal(job.attempts[0].hold,false);assert.equal(job.attempts[0].state,'locally-cancelled');}
});

test('legacy jobs recover accepted-event chronology and owner while mixed journal-only evidence remains explicitly unplaced',async t=>{
 const f=await fixture(t),prepared=await prepare(f.writer),created=[];for(let index=0;index<3;index++)created.push((await enqueue(f.writer,prepared.body)).job);await f.close();
 const immutable=rows(f.root,'SELECT * FROM events_v2 ORDER BY length(seq),seq'),db=new DatabaseSync(join(f.root,'metadata.sqlite'));let journalOnly;
 try{db.exec('BEGIN IMMEDIATE');for(const original of [...created].reverse()){const job=structuredClone(original);delete job.order;delete job.ownerClientId;db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family:'job',event:'LegacyProjectionFixture',epoch:f.writer.epoch,at:'1990-01-01T00:00:00.000Z',value:job}));}
  journalOnly=structuredClone(created[0]);delete journalOnly.order;delete journalOnly.ownerClientId;journalOnly.id='unplaced_legacy';journalOnly.attempts[0].id='unplaced_legacy_attempt';db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family:'job',event:'JobQueued',epoch:f.writer.epoch,at:'1980-01-01T00:00:00.000Z',value:journalOnly}));const out=rows(f.root,'SELECT json FROM queue_outbox WHERE job_id=?',created[0].id)[0].json;db.prepare('INSERT INTO queue_outbox VALUES (?,?,?)').run(journalOnly.attempts[0].id,journalOnly.id,out);db.exec('COMMIT');
 }finally{db.close();}
 await f.reopen();const view=await f.writer.queueView();assert.deepEqual(view.jobs.map(job=>job.id),[...created.map(job=>job.id),journalOnly.id]);
 for(let index=0;index<3;index++){const job=view.jobs[index];assert.equal(job.order.origin,'accepted-event');assert.equal(job.order.insertionOrdinal,String(index+1));assert.equal(job.ownerClientId,'client_1');assert.equal(view.waiting[job.id].editable,true);}
 const unknown=view.jobs.at(-1);assert.equal(unknown.order.origin,'journal-unplaced');assert.equal(unknown.order.insertionOrdinal,null);assert.equal(unknown.ownerClientId,null);assert.equal(view.waiting[unknown.id].editable,false);assert.deepEqual(rows(f.root,'SELECT * FROM events_v2 ORDER BY length(seq),seq'),immutable);await f.reopen();assert.deepEqual(await f.writer.queueView(),view);
});

test('order migration cannot consume the metadata space needed to cancel a near-limit legacy job',async t=>{
 const f=await fixture(t),prepared=await prepare(f.writer),{job}=await enqueue(f.writer,prepared.body);await f.close();const legacy=structuredClone(job);delete legacy.order;delete legacy.ownerClientId;legacy.attempts[0].controlWarning='';
 const oldBytes=65500,padding=oldBytes-Buffer.byteLength(canonical(legacy));assert(padding>0);legacy.attempts[0].controlWarning='x'.repeat(padding);assert.equal(Buffer.byteLength(canonical(legacy)),oldBytes);
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family:'job',event:'LegacyProjectionFixture',epoch:f.writer.epoch,at:'1990-01-01T00:00:00.000Z',value:legacy}));}finally{db.close();}
 await f.reopen();const migrated=(await f.writer.queueView()).jobs[0];assert(Buffer.byteLength(canonical(migrated))>65536);assert.equal(migrated.order.origin,'accepted-event');assert.equal(migrated.ownerClientId,'client_1');
 const request=envelope({type:'CancelUnstartedJob',jobId:migrated.id,expectedVersion:migrated.version}),receipt=await f.writer.queueCommand(encode(request),auth());assert.equal(receipt.status,'accepted');const cancelled=(await f.writer.queueView()).jobs[0];assert.equal(cancelled.local,'locally-cancelled');assert.deepEqual(cancelled.order,migrated.order);assert.equal(cancelled.ownerClientId,migrated.ownerClientId);assert.equal(cancelled.attempts[0].controlWarning,legacy.attempts[0].controlWarning);assert.deepEqual(cancelled.review,legacy.review);
 const fact=(await f.writer.events(String(BigInt(receipt.fromSeq)-1n))).events.find(event=>event.commandId===request.command.commandId),ref=fact.payload.state;assert(BigInt(ref.byteLength)<=65536n);const stored=JSON.parse(await readFile(join(f.root,'objects/sha256',ref.hash.slice(7,9),ref.hash.slice(7)),'utf8')),{order,ownerClientId,...legacyProjection}=cancelled;assert.deepEqual(stored,legacyProjection);
 await f.reopen();assert.deepEqual((await f.writer.queueView()).jobs[0],cancelled);assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);
});

test('a retry that exceeds the retained job budget returns typed capacity without publishing an attempt or outbox',async t=>{
 const f=await fixture(t),prepared=await prepare(f.writer),{job}=await enqueue(f.writer,prepared.body),reservation=await f.writer.queueReserve(job.id),policy=resolvePrivacy(fixtureProfile(),'ideogram/v4','retry-growth').applied,dispatch=await f.writer.queueDispatch(job.id,reservation.attempt.id,{},policy);assert(dispatch);
 await f.writer.queueOutcome(job.id,reservation.attempt.id,dispatch.epoch,{kind:'uncertain',reason:'Fixture lost acknowledgment'});let current=(await f.writer.queueView()).jobs[0];assert.equal((await f.writer.queueCommand(encode(envelope({type:'OverrideUncertainHold',jobId:current.id,attemptId:current.attempts[0].id,expectedVersion:current.version,acknowledgeOverlapAndChargeRisk:true})),auth())).status,'accepted');current=(await f.writer.queueView()).jobs[0];await f.close();
 const retained=structuredClone(current);retained.attempts[0].controlWarning='';const padding=65500-Buffer.byteLength(canonical(retained));assert(padding>0);retained.attempts[0].controlWarning='x'.repeat(padding);assert.equal(Buffer.byteLength(canonical(retained)),65500);
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family:'job',event:'RetainedFixtureState',epoch:f.writer.epoch,at:'2020-01-01T00:00:00.000Z',value:retained}));}finally{db.close();}
 await f.reopen();const before=await f.writer.queueView(),outbox=rows(f.root,'SELECT * FROM queue_outbox ORDER BY attempt_id'),journal=rows(f.root,'SELECT * FROM queue_journal ORDER BY seq'),events=rows(f.root,'SELECT * FROM events_v2 ORDER BY length(seq),seq'),request=envelope({type:'RetryUncertainJob',jobId:retained.id,attemptId:retained.attempts[0].id,expectedVersion:retained.version,acknowledgeDuplicateWorkAndChargeRisk:true}),receipt=await f.writer.queueCommand(encode(request),auth());
 assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'CAPACITY');const detail=JSON.parse(await readFile(join(f.root,'objects/sha256',receipt.details.hash.slice(7,9),receipt.details.hash.slice(7)),'utf8'));assert.equal(detail.issues[0].code,'QUEUE_METADATA_LIMIT');assert.deepEqual(await f.writer.queueView(),before);assert.deepEqual(rows(f.root,'SELECT * FROM queue_outbox ORDER BY attempt_id'),outbox);assert.deepEqual(rows(f.root,'SELECT * FROM queue_journal ORDER BY seq'),journal);assert.deepEqual(rows(f.root,'SELECT * FROM events_v2 ORDER BY length(seq),seq'),events);
 await f.reopen();assert.deepEqual(await f.writer.queueView(),before);assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);assert.equal((await f.writer.queueView()).jobs[0].attempts.length,1);
});

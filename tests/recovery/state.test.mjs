import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';import {readFile,access,mkdir,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {fixture,prepare,enqueue,auth,envelope,encode,command,EMPTY_EXPECTED_VERSIONS} from '../queue/helpers.mjs';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';import {fixtureProfile} from '../provider/emulator.mjs';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
const policy=resolvePrivacy(fixtureProfile(),'ideogram/v4','fixture').applied;
const send=(w,body)=>w.queueCommand(encode(envelope(body)),auth());
const current=async w=>(await w.queueView()).jobs[0];
async function pending(f,ack=false){let {job}=await enqueue(f.writer,(await prepare(f.writer)).body);const r=await f.writer.queueReserve(job.id),d=await f.writer.queueDispatch(job.id,r.attempt.id,{},policy);if(ack)await f.writer.queueOutcome(job.id,r.attempt.id,d.epoch,{kind:'ack',requestId:'known',urls:{status:'http://127.0.0.1:1/status',result:'http://127.0.0.1:1/result',cancel:'http://127.0.0.1:1/cancel'},responseRecord:'fixture'});return current(f.writer);}
async function preview(w,id='document_1'){const receipt=await send(w,{type:'PreviewDocumentDeletion',documentId:id,expectedRevision:await w.documentRevision(id)});assert.equal(receipt.status,'accepted',JSON.stringify(receipt));return (await w.deletionView(id,auth())).plan;}
function deletion(plan,ack=false){return {type:'DeleteDocument',documentId:plan.documentId,planId:plan.id,planHash:plan.planHash,rootGeneration:plan.rootGeneration,expectedRevision:plan.documentRevision,acknowledgeRunningAndUncertain:ack};}
function sql(root,query){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return db.prepare(query).all();}finally{db.close();}}
test('cancel safe reservation and redo preserve no-submit state and release only unspent count',async t=>{const f=await fixture(t),q=await enqueue(f.writer,(await prepare(f.writer)).body);await f.writer.queueReserve(q.job.id);let j=await current(f.writer);assert.equal((await send(f.writer,{type:'UndoPendingJob',jobId:j.id,attemptId:j.attempts[0].id,expectedVersion:j.version})).status,'accepted');j=await current(f.writer);assert.equal(j.disposition,'suppressed-by-undo');assert.equal(j.attempts[0].state,'locally-cancelled');assert.equal((await send(f.writer,{type:'RedoPendingJob',jobId:j.id,attemptId:j.attempts[0].id,expectedVersion:j.version})).status,'accepted');assert.equal(await f.writer.queueReserve(j.id),null);assert.equal((await f.writer.queueView()).counts.active,0);await f.reopen();assert.equal((await current(f.writer)).attempts.length,1);});
test('reopen known job requires explicit same-identity recovery without a new attempt or released hold',async t=>{const f=await fixture(t);await pending(f,true);await f.reopen();let j=await current(f.writer),a=j.attempts[0];assert.equal(a.recoveryRequired,true);assert.equal(a.requestId,'known');assert.equal(a.hold,true);assert.equal((await send(f.writer,{type:'RecoverJob',jobId:j.id,attemptId:a.id,expectedVersion:j.version})).status,'accepted');j=await current(f.writer);assert.equal(j.attempts.length,1);assert.equal(j.attempts[0].recoveryRequired,false);assert.equal(j.attempts[0].count,'dispatched');});
test('uncertain recovery never creates an identifier or releases its original reservation',async t=>{const f=await fixture(t);await pending(f);await f.reopen();let j=await current(f.writer),a=j.attempts[0];assert.equal(a.state,'submission-uncertain');await send(f.writer,{type:'RecoverJob',jobId:j.id,attemptId:a.id,expectedVersion:j.version});j=await current(f.writer);assert.equal(j.attempts[0].requestId,null);assert.equal(j.attempts[0].hold,true);assert.equal(j.attempts.length,1);assert.match(j.attempts[0].controlWarning,/No durable provider identifier/);});
test('cancel intent keeps the dispatched count and hold; duplicate command returns the same receipt',async t=>{const f=await fixture(t),j=await pending(f,true),a=j.attempts[0],c=envelope({type:'CancelJob',jobId:j.id,attemptId:a.id,expectedVersion:j.version});const receipt=await f.writer.queueCommand(encode(c),auth());assert.equal(receipt.status,'accepted');assert.deepEqual(await f.writer.queueCommand(encode(c),auth()),receipt);const next=await current(f.writer);assert.equal(next.attempts[0].cancel,'requested');assert.equal(next.attempts[0].hold,true);assert.equal(next.attempts[0].count,'dispatched');assert.equal((await send(f.writer,{...c.command.body})).code,'STALE_REVISION');});
test('deletion preview is durable and a changed document invalidates confirmation',async t=>{const f=await fixture(t),p=await preview(f.writer);assert.equal(p.histories,1);await f.writer.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{expectedDocumentRevision:'1',body:{type:'SaveCheckpoint',name:'keep'}})),f.writer.epoch);const r=await send(f.writer,deletion(p));assert.equal(r.status,'rejected');assert.equal(r.code,'STALE_REVISION');assert(await f.writer.document('document_1'));});
test('changed roots invalidate confirmation even when document revision is unchanged',async t=>{const f=await fixture(t),p=await preview(f.writer);await prepare(f.writer);assert.equal((await send(f.writer,deletion(p))).code,'STALE_REVISION');assert(await f.writer.document('document_1'));});
test('deletion atomically cancels unstarted work and duplicate receipt cannot resurrect a namespace',async t=>{const f=await fixture(t);const q=await enqueue(f.writer,(await prepare(f.writer)).body),p=await preview(f.writer),c=envelope(deletion(p));const r=await f.writer.queueCommand(encode(c),auth());assert.equal(r.status,'accepted',JSON.stringify(r));assert.deepEqual(await f.writer.queueCommand(encode(c),auth()),r);assert.equal(await f.writer.document('document_1'),null);assert.equal(await f.writer.queueReserve(q.job.id),null);assert.equal((await current(f.writer)).attempts[0].state,'locally-cancelled');await f.reopen();assert.equal(await f.writer.document('document_1'),null);assert.equal((await current(f.writer)).disposition,'deleted');const newDoc=await f.writer.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{})),f.writer.epoch);assert.equal(newDoc.status,'rejected');assert.equal((await f.writer.deletionView('document_1',auth())).receipt.actualFreedBytes,'0');});
test('deletion needs running acknowledgement and preserves conservative uncertainty and charge holds',async t=>{const f=await fixture(t);await pending(f);await f.reopen();let j=await current(f.writer),p=await preview(f.writer);assert.equal(p.unresolvedAttempts.length,1);assert.equal((await send(f.writer,deletion(p))).status,'rejected');p=await preview(f.writer);assert.equal((await send(f.writer,deletion(p,true))).status,'accepted');j=await current(f.writer);assert.equal(j.attempts[0].hold,true);assert.equal(j.attempts[0].state,'submission-uncertain');assert.equal((await send(f.writer,{type:'OverrideUncertainHold',jobId:j.id,attemptId:j.attempts[0].id,expectedVersion:j.version,acknowledgeOverlapAndChargeRisk:true})).status,'accepted');assert.equal((await f.writer.queueView()).counts.dispatched,1);});
test('reclamation reports only actual unlink bytes and retained independent roots survive reopen',async t=>{const f=await fixture(t);await enqueue(f.writer,(await prepare(f.writer)).body);const p=await preview(f.writer);assert(BigInt(p.exclusiveBytes)>0n);assert.equal((await send(f.writer,deletion(p))).status,'accepted');const before=(await f.writer.deletionView('document_1',auth())).receipt;assert.equal(before.actualFreedBytes,'0');const r=await send(f.writer,{type:'CollectDocumentGarbage',documentId:'document_1'});assert.equal(r.status,'accepted');const receipt=(await f.writer.deletionView('document_1',auth())).receipt;assert.equal(receipt.status,'cleanup-complete');assert(BigInt(receipt.actualFreedBytes)>0n);for(const row of sql(f.root,"SELECT * FROM deletion_objects WHERE state='freed'"))await assert.rejects(access(join(f.root,'objects/sha256',row.hash.slice(7,9),row.hash.slice(7))));await f.reopen();assert.equal(await f.writer.document('document_1'),null);assert.equal((await f.writer.deletionView('document_1',auth())).receipt.actualFreedBytes,receipt.actualFreedBytes);assert.equal((await send(f.writer,{type:'CollectDocumentGarbage',documentId:'document_1'})).status,'accepted');assert.equal((await f.writer.deletionView('document_1',auth())).receipt.actualFreedBytes,receipt.actualFreedBytes);});
test('rejected garbage collection preserves pending objects and accounting before a valid collection',async t=>{
 const f=await fixture(t);await enqueue(f.writer,(await prepare(f.writer)).body);const p=await preview(f.writer);
 const deleted=await send(f.writer,deletion(p));assert.equal(deleted.status,'accepted');
 const before=(await f.writer.deletionView('document_1',auth())).receipt;
 const rows=sql(f.root,"SELECT * FROM deletion_objects WHERE document_id='document_1' ORDER BY hash");assert(rows.length>0);assert(BigInt(before.pendingBytes)>0n);
 const bytes=await Promise.all(rows.map(row=>readFile(join(f.root,'objects/sha256',row.hash.slice(7,9),row.hash.slice(7)))));
 const events=sql(f.root,'SELECT count(*) n FROM events_v2')[0].n;
 const cases=[
  ['document-scoped envelope','INVALID_INPUT',c=>{c.documentId='document_1';c.expectedDocumentRevision='1';}],
  ['missing version manifest','MISSING_ASSET',c=>{c.expectedEntityVersions={...EMPTY_EXPECTED_VERSIONS,hash:'sha256:'+'0'.repeat(64)};}],
  ['reused transaction identity','INVALID_INPUT',c=>{c.transactionId=deleted.transactionId;}],
 ];
 for(const [label,code,change] of cases){
  const c=envelope({type:'CollectDocumentGarbage',documentId:'document_1'});change(c.command);
  const rejected=await f.writer.queueCommand(encode(c),auth());assert.equal(rejected.status,'rejected',label);assert.equal(rejected.code,code,label);
  assert.deepEqual(await f.writer.queueCommand(encode(c),auth()),rejected,label+' duplicate');
  assert.deepEqual((await f.writer.deletionView('document_1',auth())).receipt,before,label+' accounting');
  assert.deepEqual(sql(f.root,"SELECT * FROM deletion_objects WHERE document_id='document_1' ORDER BY hash"),rows,label+' intents');
  assert.deepEqual(await Promise.all(rows.map(row=>readFile(join(f.root,'objects/sha256',row.hash.slice(7,9),row.hash.slice(7))))),bytes,label+' physical bytes');
  assert.equal(sql(f.root,'SELECT count(*) n FROM events_v2')[0].n,events,label+' events');
 }
 assert.equal((await send(f.writer,{type:'CollectDocumentGarbage',documentId:'document_1'})).status,'accepted');
 const after=(await f.writer.deletionView('document_1',auth())).receipt;assert.equal(after.status,'cleanup-complete');assert(BigInt(after.actualFreedBytes)>0n);
});

async function directDeletionFixture(t,withJob=false){
 const cleanup=[],f=await fixture({name:t.name,after:fn=>cleanup.push(fn)}),q=withJob?await enqueue(f.writer,(await prepare(f.writer)).body):null;await f.close();let db,owner;
 async function close(){if(db){await db.candidates.close();await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();db=null;}owner?.close();owner=null;}
 async function open(){owner=await acquireRoot(f.root);db=new StoreDatabase(f.root,()=>{});}
 t.after(async()=>{await close();for(const fn of cleanup)await fn();});await open();
 return {root:f.root,q,get db(){return db;},async reopen(){await close();await open();}};
}
async function directSend(x,body){const r=await x.db.queue.command(encode(envelope(body)),auth());assert.equal(r.status,'accepted',JSON.stringify(r));return r;}
async function directPreview(x,documentId='document_1'){await directSend(x,{type:'PreviewDocumentDeletion',documentId,expectedRevision:x.db.document(documentId).revision});return x.db.deletions.view(documentId,auth()).plan;}
async function portableWork(x){
 const directory=join(x.root,'portable','backup-gc-fixture');await mkdir(directory,{mode:0o700});
 const kept={path:join(directory,'retained-capture.bin'),bytes:Buffer.from('Exact capture bytes retained for the schema16 backup.\n')};
 const disposable={path:join(directory,'disposable-capture.bin'),bytes:Buffer.from('Unprotected document work can be reclaimed.\n')};
 for(const file of [kept,disposable])await writeFile(file.path,file.bytes,{mode:0o600});
 x.db.db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(directory,'document_1');
 return {kept,disposable};
}
test('migration backup pins retain portable work without queuing it for deletion',async t=>{
 const x=await directDeletionFixture(t),before=await directPreview(x),{kept,disposable}=await portableWork(x);
 x.db.db.prepare('INSERT INTO deletion_backup_files VALUES (?)').run(kept.path);
 const plan=await directPreview(x);assert.equal(BigInt(plan.retainedBytes),BigInt(before.retainedBytes)+BigInt(kept.bytes.length));assert.equal(BigInt(plan.exclusiveBytes),BigInt(before.exclusiveBytes)+BigInt(disposable.bytes.length));
 await directSend(x,deletion(plan));await directSend(x,{type:'CollectDocumentGarbage',documentId:'document_1'});
 const receipt=x.db.deletions.receipt('document_1');assert.equal(receipt.status,'cleanup-complete');assert.equal(receipt.pendingBytes,'0');assert.equal(receipt.retainedBytes,plan.retainedBytes);assert.equal(receipt.actualFreedBytes,plan.exclusiveBytes);
 assert.equal(x.db.db.prepare('SELECT state FROM deletion_files WHERE path=?').get(kept.path),undefined);assert.equal(x.db.db.prepare('SELECT state FROM deletion_files WHERE path=?').get(disposable.path).state,'freed');
 assert.deepEqual(await readFile(kept.path),kept.bytes);await assert.rejects(access(disposable.path),{code:'ENOENT'});
 await directSend(x,{type:'CollectDocumentGarbage',documentId:'document_1'});assert.deepEqual(x.db.deletions.receipt('document_1'),receipt);await x.reopen();assert.deepEqual(x.db.deletions.receipt('document_1'),receipt);assert.deepEqual(await readFile(kept.path),kept.bytes);
});
for(const state of ['quarantined','unlinking'])test('new migration backup pins rescue '+state+' portable files with retained bytes counted once',async t=>{
 const x=await directDeletionFixture(t);await directSend(x,deletion(await directPreview(x)));await directSend(x,{type:'CollectDocumentGarbage',documentId:'document_1'});
 const before=x.db.deletions.receipt('document_1'),{kept,disposable}=await portableWork(x);
 for(const file of [kept,disposable])x.db.db.prepare('INSERT INTO deletion_files VALUES (?,?,?,?,?)').run('document_1',file.path,String(file.bytes.length),createHash('sha256').update(file.bytes).digest('hex'),state);
 // A verified migration may add protection after an earlier writer left an unlink intent.
 x.db.db.prepare('INSERT INTO deletion_backup_files VALUES (?)').run(kept.path);
 await x.reopen();
 const receipt=x.db.deletions.receipt('document_1');assert.equal(receipt.status,'cleanup-complete');assert.equal(receipt.pendingBytes,'0');assert.equal(BigInt(receipt.retainedBytes),BigInt(before.retainedBytes)+BigInt(kept.bytes.length));assert.equal(BigInt(receipt.actualFreedBytes),BigInt(before.actualFreedBytes)+BigInt(disposable.bytes.length));
 assert.equal(x.db.db.prepare('SELECT state FROM deletion_files WHERE path=?').get(kept.path).state,'rescued');assert.equal(x.db.db.prepare('SELECT state FROM deletion_files WHERE path=?').get(disposable.path).state,'freed');assert.deepEqual(await readFile(kept.path),kept.bytes);await assert.rejects(access(disposable.path),{code:'ENOENT'});
 await directSend(x,{type:'CollectDocumentGarbage',documentId:'document_1'});assert.deepEqual(x.db.deletions.receipt('document_1'),receipt);await x.reopen();assert.deepEqual(x.db.deletions.receipt('document_1'),receipt);assert.deepEqual(await readFile(kept.path),kept.bytes);
});

async function inheritedTransportFixture(t,deleteAdopterFirst=false){
 const x=await directDeletionFixture(t,true),job=x.q.job,attemptId=job.attempts[0].id;
 assert.equal(x.db.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{documentId:'document_2'})),x.db.epoch).status,'accepted');
 assert(x.db.queue.reserve(job.id));const dispatched=x.db.queue.dispatch(job.id,attemptId,{},policy);assert(dispatched);
 const sink=x.db.queue.sink(attemptId,'response',policy),body=Buffer.from(JSON.stringify({request_id:'retained_fixture',status:'COMPLETED',private_result:'Exact terminal response evidence Café 東京'}));sink.append(body);const response=sink.finish(true);
 x.db.queue.outcome(job.id,attemptId,dispatched.epoch,{kind:'ack',requestId:'retained_fixture',urls:{status:'http://127.0.0.1:1/status',result:'http://127.0.0.1:1/result',cancel:'http://127.0.0.1:1/cancel'},responseRecord:response.recordId});
 x.db.queue.outcome(job.id,attemptId,dispatched.epoch,{kind:'terminal',status:'completed'});assert.equal(x.db.queue.view().jobs[0].attempts[0].hold,false);
 const files=[];for(const id of [dispatched.bodyRecord,response.recordId])for(const suffix of ['.body','.json']){const path=join(x.db.queue.evidence.directory,id+suffix);files.push({path,bytes:await readFile(path)});}
 const rawBytes=files.reduce((sum,file)=>sum+BigInt(file.bytes.length),0n),before=await directPreview(x),beforeAdopter=await directPreview(x,'document_2');
 // Trusted local adoption edge only: actual adoption admission and import isolation are tested separately.
 x.db.db.prepare('INSERT INTO candidate_adoption_evidence VALUES (?,?)').run('document_2',attemptId);
 const sourcePlan=await directPreview(x);assert.equal(BigInt(sourcePlan.retainedBytes),BigInt(before.retainedBytes)+rawBytes);assert.equal(BigInt(sourcePlan.exclusiveBytes),BigInt(before.exclusiveBytes)-rawBytes);
 const plan=deleteAdopterFirst?await directPreview(x,'document_2'):sourcePlan;
 if(deleteAdopterFirst){assert.equal(BigInt(plan.retainedBytes),BigInt(beforeAdopter.retainedBytes)+rawBytes);assert.equal(plan.exclusiveBytes,beforeAdopter.exclusiveBytes);}
 await directSend(x,deletion(plan));await directSend(x,{type:'CollectDocumentGarbage',documentId:plan.documentId});
 assert.equal(x.db.deletions.receipt(plan.documentId).retainedBytes,plan.retainedBytes);for(const file of files)assert.deepEqual(await readFile(file.path),file.bytes);
 const remainingDocumentId=deleteAdopterFirst?'document_1':'document_2';await x.reopen();for(const file of files)assert.deepEqual(await readFile(file.path),file.bytes);assert(x.db.document(remainingDocumentId));
 return {...x,get db(){return x.db;},files,rawBytes,remainingDocumentId};
}
for(const mode of ['document_1 collects first','document_2 collects first','restart resumes shared unlink intent','source outlives adopted document'])test('trusted adoption evidence survives first owner deletion and frees once after final owner deletion: '+mode,async t=>{
 const x=await inheritedTransportFixture(t,mode==='source outlives adopted document');await directSend(x,deletion(await directPreview(x,x.remainingDocumentId)));
 if(mode==='restart resumes shared unlink intent'){
  for(const documentId of ['document_1','document_2'])for(const file of x.files)x.db.db.prepare('INSERT INTO deletion_files VALUES (?,?,?,?,?)').run(documentId,file.path,String(file.bytes.length),createHash('sha256').update(file.bytes).digest('hex'),documentId==='document_1'?'unlinking':'quarantined');
  await x.reopen();
 }
 const first=['document_2 collects first','source outlives adopted document'].includes(mode)?'document_2':'document_1',second=first==='document_1'?'document_2':'document_1';
 for(const documentId of [first,second])await directSend(x,{type:'CollectDocumentGarbage',documentId});
 for(const file of x.files){await assert.rejects(access(file.path),{code:'ENOENT'});const rows=x.db.db.prepare('SELECT state,bytes FROM deletion_files WHERE path=?').all(file.path);assert.equal(rows.length,1,file.path);assert.equal(rows[0].state,'freed');assert.equal(rows[0].bytes,String(file.bytes.length));}
 const fileBytes=x.db.db.prepare("SELECT bytes FROM deletion_files WHERE state='freed'").all().reduce((sum,row)=>sum+BigInt(row.bytes),0n);assert.equal(fileBytes,x.rawBytes);
 const objectBytes=x.db.db.prepare("SELECT byte_length FROM deletion_objects WHERE state='freed'").all().reduce((sum,row)=>sum+BigInt(row.byte_length),0n),receipts=['document_1','document_2'].map(id=>x.db.deletions.receipt(id));
 assert.equal(receipts.reduce((sum,receipt)=>sum+BigInt(receipt.actualFreedBytes),0n),objectBytes+x.rawBytes);for(const receipt of receipts){assert.equal(receipt.pendingBytes,'0');assert.equal(receipt.status,'cleanup-complete');}
 for(const documentId of [second,first])await directSend(x,{type:'CollectDocumentGarbage',documentId});await x.reopen();assert.deepEqual(['document_1','document_2'].map(id=>x.db.deletions.receipt(id)),receipts);
});

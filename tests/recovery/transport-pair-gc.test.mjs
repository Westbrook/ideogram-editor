import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,prepare,enqueue,auth,envelope,encode,command,EMPTY_EXPECTED_VERSIONS} from '../queue/helpers.mjs';
import {emulator,fixtureProfile} from '../provider/emulator.mjs';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {syncDirectory} from '../../dist/local/server/storage/files.js';

const options={timeout:60_000};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const provenance=error=>error?.code==='PROVENANCE';
const collect=x=>send(x,{type:'CollectDocumentGarbage',documentId:'document_1'});
async function send(x,body){
 const receipt=await x.db.queue.command(encode(envelope(body)),auth());
 assert.equal(receipt.status,'accepted',JSON.stringify(receipt));return receipt;
}
async function preview(x,documentId='document_1'){
 await send(x,{type:'PreviewDocumentDeletion',documentId,expectedRevision:x.db.document(documentId).revision});
 return x.db.deletions.view(documentId,auth()).plan;
}
async function remove(x,documentId='document_1'){
 const plan=await preview(x,documentId);
 await send(x,{type:'DeleteDocument',documentId,planId:plan.id,planHash:plan.planHash,
  rootGeneration:plan.rootGeneration,expectedRevision:plan.documentRevision,acknowledgeRunningAndUncertain:false});
 assert.equal(x.db.document(documentId),null);return plan;
}

// The dispatcher performs one actual loopback POST. Its request and response
// acquire their wire identities from production transport code, not fixture JSON.
// Terminal completion below is a semantic fixture transition; no inference or
// production-provider success is claimed by these deletion tests.
async function setup(t){
 const cleanup=[],sockets=new Set();let db,rootOwner,dispatcher,server,pending,barrier=()=>{};
 async function closeDatabase(){
  const errors=[];
  if(db){
   const current=db;db=null;
   for(const close of [()=>current.displays.close(),()=>current.candidates.close(),()=>current.queue.close(),
    ()=>current.portables.close(),()=>current.histories.close(),()=>current.rasters.close(),
    ()=>current.assets.close(),()=>current.recovery.settle(),()=>current.close()]){
    try{await close();}catch(error){errors.push(error);}
   }
  }
  try{rootOwner?.close();}catch(error){errors.push(error);}rootOwner=null;
  if(errors.length)throw new AggregateError(errors,'Transport pair database cleanup failed');
 }
 t.after(async()=>{
  const errors=[];barrier=()=>{};dispatcher?.close();
  if(pending)await Promise.allSettled([pending]);
  if(server){
   const closed=server.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve();
   for(const socket of sockets)socket.destroy();
   await closed;
  }
  try{await closeDatabase();}catch(error){errors.push(error);}
  for(const close of cleanup)try{await close();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Transport pair fixture cleanup failed');
 });
 const f=await fixture({name:t.name,after:close=>cleanup.push(close)},{width:512,height:512});
 const q=await enqueue(f.writer,(await prepare(f.writer)).body);await f.close();
 async function open(){
  rootOwner=await acquireRoot(f.root);
  try{db=new StoreDatabase(f.root,phase=>barrier(phase));}
  catch(error){rootOwner.close();rootOwner=null;throw error;}
 }
 await open();
 let origin='',posts=0;
 server=createServer((req,res)=>{
  req.on('error',()=>{});res.on('error',()=>{});req.resume();
  req.once('end',()=>{
   if(req.method!=='POST'||req.url!=='/ideogram/v4'){res.writeHead(404);res.end();return;}
   posts++;const base=origin+'/ideogram/v4/requests/pair_fixture';
   res.writeHead(200,{'Content-Type':'application/json'});
   res.end(JSON.stringify({request_id:'pair_fixture',status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));
  });
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 origin='http://127.0.0.1:'+server.address().port;
 const provider=emulator({queueOrigin:origin,mediaOrigin:origin,uploadOrigin:origin,profiles:[fixtureProfile({endpoint:q.job.review.endpoint})]});
 dispatcher=new QueueDispatcher(db.queue,provider,{queueOrigin:origin,mediaOrigin:origin,uploadURL:origin+'/upload',profileId:'local-fixture-v1'});
 pending=dispatcher.submit(q.job.id);const acknowledged=await pending;pending=null;
 assert.equal(posts,1);assert.equal(acknowledged.attempts[0].state,'acknowledged');
 const attemptId=q.job.attempts[0].id,recovery=db.queue.recovery(q.job.id,attemptId),pair=recovery.outbox.wireEvidence.submission;
 assert(pair,'Real submission must own both wire records');
 for(const ref of [pair.body,pair.response]){
  const meta=db.queue.evidence.inspect(ref.recordId);
  assert.equal(meta.wireExecution.boundary,'loopback-fixture-1');
  assert.equal(meta.wireBodyIdentity.kind,'provider-wire-body-identity-1');
  assert.equal(meta.attemptId,attemptId);assert.equal(meta.completeness,'complete');
 }
 db.queue.outcome(q.job.id,attemptId,recovery.epoch,{kind:'terminal',status:'completed'});
 assert.equal(db.queue.recovery(q.job.id,attemptId).attempt.hold,false);
 assert.equal(db.objects.reservationInventory().activeTransfers,0);
 const directory=db.queue.evidence.directory,recordId=pair.response.recordId;
 const files=readdirSync(directory).filter(name=>/\.(body|json)$/.test(name)).sort().map(name=>{
  const path=join(directory,name),bytes=readFileSync(path);return {path,bytes,hash:sha(bytes)};
 });
 assert(files.length>=6,'Dispatch snapshot and both actual wire records are retained');
 return {root:f.root,q,attemptId,recordId,directory,files,bodyPath:join(directory,recordId+'.body'),metadataPath:join(directory,recordId+'.json'),
  get db(){return db;},setBarrier(next){barrier=next;},async reopen(){await closeDatabase();await open();}};
}
const row=(x,path)=>x.db.db.prepare('SELECT * FROM deletion_files WHERE document_id=? AND path=?').get('document_1',path);
const original=(x,path)=>x.files.find(file=>file.path===path).bytes;
function removeBody(x){unlinkSync(x.bodyPath);syncDirectory(x.directory);}

async function interrupt(x,state){
 const stop=new Error('Exact transport pair interruption');let hit=false;
 x.setBarrier(phase=>{
  const body=row(x,x.bodyPath),metadata=row(x,x.metadataPath);
  const reached=state==='unlinking'
   ?phase==='deletion-work-after-unlink'&&body?.state==='unlinking'&&!existsSync(x.bodyPath)
   :phase==='deletion-work-unlink-intent'&&body?.state==='freed'&&metadata?.state==='unlinking';
  if(reached){hit=true;throw stop;}
 });
 try{await assert.rejects(collect(x),error=>error===stop);}finally{x.setBarrier(()=>{});}
 assert.equal(hit,true);assert.equal(row(x,x.bodyPath).state,state);
 assert.equal(existsSync(x.bodyPath),false);
 assert.deepEqual(readFileSync(x.metadataPath),original(x,x.metadataPath));
 assert.throws(()=>x.db.queue.evidence.inspect(x.recordId),provenance,'Live evidence must still reject a GC half-pair');
}
function assertCollected(x){
 for(const file of x.files){
  assert.equal(existsSync(file.path),false,file.path);
  const rows=x.db.db.prepare('SELECT * FROM deletion_files WHERE path=?').all(file.path);
  assert.equal(rows.length,1,file.path);assert.equal(rows[0].state,'freed');
  assert.equal(rows[0].bytes,String(file.bytes.length));assert.equal(rows[0].hash,file.hash);
 }
 const freedFiles=x.db.db.prepare("SELECT bytes FROM deletion_files WHERE state='freed'").all();
 assert.equal(freedFiles.length,x.files.length);
 const rawBytes=x.files.reduce((sum,file)=>sum+BigInt(file.bytes.length),0n);
 assert.equal(freedFiles.reduce((sum,file)=>sum+BigInt(file.bytes),0n),rawBytes);
 const objectBytes=x.db.db.prepare("SELECT byte_length FROM deletion_objects WHERE state='freed'").all().reduce((sum,r)=>sum+BigInt(r.byte_length),0n);
 const receipt=x.db.deletions.receipt('document_1');
 assert.equal(receipt.actualFreedBytes,String(objectBytes+rawBytes));
 assert.equal(receipt.pendingBytes,'0');assert.equal(receipt.status,'cleanup-complete');
 assert.equal(x.db.db.prepare("SELECT count(*) n FROM deletion_files WHERE state!='freed'").get().n,0);
 return receipt;
}

for(const state of ['uninterrupted','unlinking','freed'])test('wire transport pair collection resumes '+state+' and credits each physical file once',options,async t=>{
 const x=await setup(t);await remove(x);
 if(state==='uninterrupted')await collect(x);
 else{await interrupt(x,state);await x.reopen();}
 const receipt=assertCollected(x);
 await collect(x);assert.deepEqual(assertCollected(x),receipt);
 await x.reopen();await collect(x);assert.deepEqual(assertCollected(x),receipt);
});

for(const state of ['no intent','quarantined','rescued'])test('missing wire body with '+state+' cannot authorize deleting surviving metadata',options,async t=>{
 const x=await setup(t);await remove(x);
 if(state!=='no intent'){
  // Capture real paired hashes and an actual intent, then explicitly withdraw
  // its started state. Neither an inventory row nor rescue permits an unlink.
  const stop=new Error('Stop before body unlink');let hit=false;
  x.setBarrier(phase=>{if(phase==='deletion-work-unlink-intent'&&row(x,x.bodyPath)?.state==='unlinking'&&existsSync(x.bodyPath)){hit=true;throw stop;}});
  try{await assert.rejects(collect(x),error=>error===stop);}finally{x.setBarrier(()=>{});}
  assert.equal(hit,true);
  x.db.db.prepare('UPDATE deletion_files SET state=? WHERE document_id=? AND path=?').run(state,'document_1',x.bodyPath);
 }
 removeBody(x);assert.throws(()=>x.db.queue.evidence.inspect(x.recordId),provenance);
 await assert.rejects(collect(x),provenance);
 assert.deepEqual(readFileSync(x.metadataPath),original(x,x.metadataPath));
 assert.notEqual(row(x,x.metadataPath)?.state,'freed');
 assert.equal(row(x,x.bodyPath)?.state,state==='no intent'?undefined:state);
});

test('a present wire body with a changed completion stamp cannot use the GC missing-body fallback',options,async t=>{
 const x=await setup(t);await remove(x);
 const changed=Buffer.from(original(x,x.bodyPath));changed[0]^=1;writeFileSync(x.bodyPath,changed);
 assert.throws(()=>x.db.queue.evidence.inspect(x.recordId),provenance);
 await assert.rejects(collect(x),provenance);
 assert.deepEqual(readFileSync(x.bodyPath),changed);
 assert.deepEqual(readFileSync(x.metadataPath),original(x,x.metadataPath));
 assert.equal(row(x,x.metadataPath),undefined);
});

test('edited metadata cannot authenticate a body already unlinked by GC',options,async t=>{
 const x=await setup(t);await remove(x);await interrupt(x,'unlinking');
 const saved=JSON.parse(original(x,x.metadataPath)),changed=Buffer.from(JSON.stringify({...saved,sha256:'0'.repeat(64)}));
 assert.equal(changed.length,original(x,x.metadataPath).length,'Hash tampering preserves metadata length');
 writeFileSync(x.metadataPath,changed);
 await assert.rejects(collect(x),error=>error?.code==='CORRUPT_OBJECT');
 assert.deepEqual(readFileSync(x.metadataPath),changed);
 assert.equal(row(x,x.metadataPath).state,'quarantined');
 assert.equal(row(x,x.bodyPath).state,'unlinking');
 assert.throws(()=>x.db.queue.evidence.inspect(x.recordId),provenance);
});

test('a live local adopter protects genuine wire pairs until the final owner is deleted',options,async t=>{
 const x=await setup(t);
 assert.equal(x.db.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{documentId:'document_2'})),x.db.epoch).status,'accepted');
 // This is the existing trusted local relation, not imported scalar lineage;
 // candidate admission is covered by the real adoption suites.
 x.db.db.prepare('INSERT INTO candidate_adoption_evidence VALUES (?,?)').run('document_2',x.attemptId);
 await remove(x);await collect(x);
 for(const file of x.files)assert.deepEqual(readFileSync(file.path),file.bytes);
 assert.equal(x.db.db.prepare('SELECT count(*) n FROM deletion_files').get().n,0);
 assert.equal(x.db.queue.evidence.inspect(x.recordId).wireExecution.boundary,'loopback-fixture-1');
 await x.reopen();for(const file of x.files)assert.deepEqual(readFileSync(file.path),file.bytes);
 await remove(x,'document_2');await collect(x);
 const receipt=assertCollected(x);await collect(x);assert.deepEqual(assertCollected(x),receipt);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setup, call, pair, mutationHeaders, cookieFrom } from '../protocol/helpers.mjs';
import { importRaster, terminal, binary } from '../raster/helpers.mjs';
import { command, encode, childFor } from '../store/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';

const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
const pathFor=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const route=id=>'/api/v1/commands/'+id+'/cancel-export';
const encoder={format:'jpeg',resize:{width:6,height:4},matte:'#ffffff',quality:0.9,scope:{kind:'visible-document'}};
const body=d=>({type:'ExportDocument',historyHead:d.historyHead,options:encoder});
function sql(root,read){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return read(db);}finally{db.close();}}
function countEvents(root,id){return Number(sql(root,db=>db.prepare('SELECT count(*) AS n FROM events_v2 WHERE command_id=?').get(id).n));}
async function eventually(read,message){for(let n=0;n<2000;n++){const value=await read();if(value)return value;await pause();}throw Error(message);}
async function record(w,id){return eventually(async()=>(await w.commandState(id)).record,'Export did not become terminal');}
function own(t){
 const cleanup=[];t.after(async()=>{const failures=[];for(const close of cleanup.reverse())try{await close();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'Export cancellation cleanup failed');});
 return {after:close=>cleanup.push(close)};
}
async function writer(f,options={},testing,unblock){
 const w=await openWriter({root:f.root,...options},testing);
 // Register before defaults, assertions, reader acquisition or any other await.
 f.owner.after(async()=>{try{await unblock?.();}finally{await w.close();}});
 await w.protocolDefaults();return w;
}
async function reader(f,w){const value=await w.assetVerify(f.imported.asset.id);f.owner.after(async()=>{if(w.available)await w.assetRelease(value.handle);});return value;}
async function seed(t){
 const owner=own(t),f=await setup(owner),created=f.command({}, {width:3,height:2});assert.equal((await terminal(f,created)).json.receipt.status,'accepted');
 const imported=await importRaster(f,'hidden-alpha.png'),edit=f.command({expectedDocumentRevision:'1',body:{type:'ImportAsset',assetId:imported.asset.id,layerId:'picture',name:'Picture',draft:null}});assert.equal((await terminal(f,edit)).json.receipt.status,'accepted');
 const checkpoint=f.command({expectedDocumentRevision:'2',body:{type:'SaveCheckpoint',name:'Before export cancellation'}});assert.equal((await terminal(f,checkpoint)).json.receipt.status,'accepted');
 const document=(await f.read('/api/v1/documents/document_1')).json.projection.value,image=(await f.read('/api/v1/documents/document_1/image')).json;
 const sourceBytes=await readFile(pathFor(f.root,imported.input.blob)),sourcePixels=await readFile(pathFor(f.root,imported.asset.raster.pixels));
 return {...f,owner,created,imported,document,image,sourceBytes,sourcePixels,auth:{clientId:f.paired.json.clientId,sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000}};
}
const make=(f,id)=>command(f.ref,{commandId:id,clientId:f.auth.clientId,expectedDocumentRevision:f.document.revision,body:body(f.document)});
async function canceled(f,w,c,result){
 assert.equal(result.status,'canceled');assert.equal(result.commandId,c.command.commandId);assert.equal(result.receipt.status,'rejected');assert.equal(result.receipt.code,'INVALID_INPUT');
 const details=JSON.parse(await readFile(pathFor(f.root,result.receipt.details),'utf8'));assert.ok(details.issues.some(issue=>issue.code==='EXPORT_CANCELED'));
 const saved=await record(w,c.command.commandId);assert.deepEqual(saved.receipt,result.receipt);assert.deepEqual(saved.command,c.command);assert.equal(countEvents(f.root,c.command.commandId),0);assert.equal((await w.commandState(c.command.commandId)).pending,null);
 assert.deepEqual(await w.document('document_1'),f.document);assert.deepEqual(await w.imageState('document_1'),f.image);
 assert.deepEqual(await readFile(pathFor(f.root,f.imported.input.blob)),f.sourceBytes);assert.deepEqual(await readFile(pathFor(f.root,f.imported.asset.raster.pixels)),f.sourcePixels);
}
async function arm(f,phase,id){await writeFile(join(f.root,'export-cancellation-control.json'),JSON.stringify({phase,commandId:id}),{mode:0o600});}
async function reached(f){return eventually(async()=>{try{return JSON.parse(await readFile(join(f.root,'export-cancellation-reached.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}},'Export fixture did not reach the real work boundary');}
async function release(f){await writeFile(join(f.root,'export-cancellation-release'),'release',{mode:0o600});}
async function workNames(f,id){return (await readdir(join(f.root,'raster-work'))).filter(name=>name.startsWith('export-'+id+'.'));}
const fixture=new URL('./export-cancellation-fixture.mjs',import.meta.url).href;

test('HTTP export cancellation requires owner and CSRF, rejects unknown/wrong commands and preserves a committed export',async t=>{
 const f=await seed(t),c=f.command({expectedDocumentRevision:f.document.revision,body:body(f.document)}),done=await terminal(f,c),receipt=done.json.receipt;assert.equal(receipt.status,'accepted');
 const event=(await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n))).json.batches[0].events.at(-1),asset=event.payload.asset,bytes=(await binary(f,asset.id)).bytes;
 const foreign=await pair(f.server);assert.notEqual(foreign.json.clientId,f.paired.json.clientId);
 for(const [headers,status] of [[{Origin:f.server.origin,Cookie:cookieFrom(f.paired)},403],[{...mutationHeaders(f.server,f.paired),Origin:'http://evil.invalid'},403],[mutationHeaders(f.server,foreign),403]]){const r=await call(f.server.origin,route(c.command.commandId),{method:'POST',headers,body:{protocolVersion:1}});assert.equal(r.status,status,r.text);}
 assert.equal((await f.post(route('unknown_export'),{protocolVersion:1})).status,404);assert.equal((await f.post(route(f.created.command.commandId),{protocolVersion:1})).status,400);
 for(const invalid of [null,{},[],{protocolVersion:2},{protocolVersion:1,commandId:c.command.commandId}])assert.equal((await f.post(route(c.command.commandId),invalid)).status,400);
 const result=await f.post(route(c.command.commandId),{protocolVersion:1});assert.equal(result.status,200,result.text);assert.equal(result.json.status,'completed');assert.deepEqual(result.json.receipt,receipt);assert.deepEqual((await f.post(route(c.command.commandId),{protocolVersion:1})).json,result.json);assert.deepEqual((await terminal(f,c)).json.receipt,receipt);
 assert.deepEqual((await binary(f,asset.id)).bytes,bytes);assert.deepEqual((await f.read('/api/v1/documents/document_1')).json.projection.value,f.document);assert.equal(countEvents(f.root,c.command.commandId),1);
});

test('cancel before compute is terminal, exact retries and restart cannot resurrect it, and held readers remain valid',async t=>{
 const f=await seed(t),source=await readFile(pathFor(f.root,f.imported.asset.raster.pixels));await f.server.close();let w=await writer(f);
 const first=await reader(f,w),second=await reader(f,w),c=make(f,'cancel_before_compute');await w.historyCommand(encode(c),f.auth);{const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.activeWorkers,0);}finally{diagnosticRead.release();}}assert.equal((await w.commandState(c.command.commandId)).pending.phase,'preparing');
 await assert.rejects(w.cancelExport(c.command.commandId,{...f.auth,clientId:'foreign_client'}),{code:'OWNER_REQUIRED'});assert.equal((await w.lookup(c.command.commandId)),null);
 const result=await w.cancelExport(c.command.commandId,f.auth);await canceled(f,w,c,result);assert.deepEqual(await w.cancelExport(c.command.commandId,f.auth),result);assert.deepEqual(await w.historyCommand(encode(c),f.auth),result.receipt);assert.deepEqual(await workNames(f,c.command.commandId),[]);
 await assert.rejects(w.historyCommand(encode({...c,command:{...c.command,body:{...c.command.body,options:{...encoder,matte:'#000000'}}}}),f.auth),{code:'COMMAND_ID_REUSE'});
 const encoded=await readFile(pathFor(f.root,f.imported.asset.blob));for(const reader of [first,second])assert.deepEqual(Buffer.from(await w.assetContent(f.imported.asset.id,reader.handle,'0',8)),encoded.subarray(0,8));
 await w.assetRelease(first.handle);await w.assetRelease(second.handle);assert.deepEqual(await readFile(pathFor(f.root,f.imported.asset.raster.pixels)),source);
 await w.close();w=await writer(f);assert.deepEqual(await w.cancelExport(c.command.commandId,f.auth),result);assert.deepEqual(await w.historyCommand(encode(c),f.auth),result.receipt);assert.equal((await w.commandState(c.command.commandId)).pending,null);
 const fresh=make(f,'fresh_after_cancel');await w.historyCommand(encode(fresh),f.auth);assert.equal((await record(w,fresh.command.commandId)).receipt.status,'accepted');assert.deepEqual(await w.document('document_1'),f.document);
});

test('resource-paused export can be canceled without retrying admission or changing source/checkpoint state',async t=>{
 const f=await seed(t);await f.server.close();const w=await writer(f,{quotaBytes:'1073741824'});const c=make(f,'cancel_waiting_resources');await w.historyCommand(encode(c),f.auth);
 await eventually(async()=>(await w.commandState(c.command.commandId)).pending?.phase==='waiting-for-resources','Export did not pause at real disk admission');
 const result=await w.cancelExport(c.command.commandId,f.auth);await canceled(f,w,c,result);assert.deepEqual(await workNames(f,c.command.commandId),[]);{const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.activeWorkers,0);}finally{diagnosticRead.release();}}
});

test('an exact export retry survives another running export after restart and leaves unrelated waiting work paused',async t=>{
 const f=await seed(t),running=make(f,'a_export_retry_running'),unrequested=make(f,'m_export_still_waiting'),target=make(f,'z_export_retry_target'),commands=[running,unrequested,target];await f.server.close();
 const guarded=async options=>{
  const child=await childFor(f.owner,f.root,options);let closing;
  const close=()=>closing??=(async()=>{try{await child.assertNoEffects();}finally{await child.close();}})();
  f.owner.after(async()=>{try{if(options?.setupModule)await release(f);}finally{await close();}});
  assert.equal(child.startup.type,'ready');await child.call('protocolDefaults');return {child,close};
 };
 let owned=await guarded({quotaBytes:'1073741824'}),w=owned.child;
 const state=id=>w.call('commandState',id),terminalState=id=>eventually(async()=>(await state(id)).record,'Export did not become terminal');
 const preparations=()=>sql(f.root,db=>db.prepare('SELECT * FROM history_preparations ORDER BY id').all()).map(row=>({...row}));
 for(const c of commands){assert.equal(await w.call('historyCommand',encode(c),f.auth),null);await eventually(async()=>(await state(c.command.commandId)).pending?.phase==='waiting-for-resources','Export did not pause at real disk admission');}
 const saved=preparations();assert.equal(saved.length,3);for(const [index,c] of commands.entries()){assert.equal(saved[index].id,c.command.commandId);assert.equal(saved[index].original,encode(c).toString('utf8'));assert.equal(saved[index].phase,'waiting-for-resources');assert.deepEqual(JSON.parse(saved[index].frozen),f.document);assert.equal(countEvents(f.root,c.command.commandId),0);}
 await owned.close();await arm(f,'worker-admission',running.command.commandId);owned=await guarded({setupModule:fixture});w=owned.child;
 const marker=await reached(f);assert.equal(marker.slot,'history:'+running.command.commandId);assert.ok(marker.threadId>0);assert.ok(Number.isSafeInteger(marker.jobId)&&marker.jobId>0);assert.deepEqual(preparations(),saved);
 await assert.rejects(w.call('historyCommand',encode(target),{...f.auth,clientId:'foreign_client'}),{code:'OWNER_REQUIRED'});
 await assert.rejects(w.call('historyCommand',encode({...target,command:{...target.command,body:{...target.command.body,options:{...encoder,matte:'#000000'}}}}),f.auth),{code:'COMMAND_ID_REUSE'});assert.deepEqual(preparations(),saved);
 // Equivalent wire whitespace cannot replace the original command or frozen inputs.
 assert.equal(await w.call('historyCommand',Buffer.from(JSON.stringify(target,null,2)),f.auth),null);
 const pending=(await state(target.command.commandId)).pending;assert.equal(pending.phase,'preparing');assert.equal(pending.hash,saved[2].hash);assert.equal(pending.operationId,saved[2].operation_id);assert.deepEqual(pending.command,target.command);
 assert.deepEqual(preparations(),saved.map(row=>row.id===target.command.commandId?{...row,phase:'preparing'}:row));
 {const raster=JSON.parse(await w.call('diagnosticJSON','all')).rasters;assert.equal(raster.activeWorkers,1);assert.equal(raster.workerService.slot,marker.slot);assert.equal(raster.workerService.identity.threadId,marker.threadId);assert.equal(raster.workerService.identity.generation,marker.generation);}
 await w.assertNoEffects();
 for(const c of commands){assert.equal((await state(c.command.commandId)).record,null);assert.equal(countEvents(f.root,c.command.commandId),0);}
 await release(f);const first=await terminalState(running.command.commandId),accepted=await terminalState(target.command.commandId);assert.equal(first.receipt.status,'accepted');assert.equal(accepted.receipt.status,'accepted');assert.equal(accepted.receipt.documentRevision,f.document.revision);assert.equal(accepted.hash,saved[2].hash);assert.deepEqual(accepted.command,target.command);
 const terminalRow=sql(f.root,db=>db.prepare('SELECT original,canonical,hash FROM commands WHERE id=?').get(target.command.commandId));for(const key of ['original','canonical','hash'])assert.equal(terminalRow[key],saved[2][key]);
 assert.deepEqual(preparations(),[saved[1]]);assert.equal((await state(unrequested.command.commandId)).record,null);assert.equal(countEvents(f.root,unrequested.command.commandId),0);assert.equal(countEvents(f.root,running.command.commandId),1);assert.equal(countEvents(f.root,target.command.commandId),1);
 const event=sql(f.root,db=>JSON.parse(db.prepare('SELECT json FROM events_v2 WHERE command_id=?').get(target.command.commandId).json));assert.equal(event.type,'AssetRegistered');assert.equal(event.payload.asset.id,saved[2].operation_id);const exported=await readFile(pathFor(f.root,event.payload.asset.blob));assert.ok(exported.length>0);
 assert.deepEqual(await w.call('historyCommand',encode(target),f.auth),accepted.receipt);assert.deepEqual(await w.call('document','document_1'),f.document);assert.deepEqual(await w.call('imageState','document_1'),f.image);assert.deepEqual(await readFile(pathFor(f.root,f.imported.input.blob)),f.sourceBytes);assert.deepEqual(await readFile(pathFor(f.root,f.imported.asset.raster.pixels)),f.sourcePixels);
 const canceledWaiting=await w.call('cancelExport',unrequested.command.commandId,f.auth);assert.equal(canceledWaiting.status,'canceled');assert.deepEqual((await state(unrequested.command.commandId)).record.receipt,canceledWaiting.receipt);assert.equal(countEvents(f.root,unrequested.command.commandId),0);
 await owned.close();owned=await guarded();w=owned.child;assert.deepEqual(await w.call('historyCommand',encode(target),f.auth),accepted.receipt);assert.equal((await state(target.command.commandId)).pending,null);assert.equal(countEvents(f.root,target.command.commandId),1);assert.deepEqual(await readFile(pathFor(f.root,event.payload.asset.blob)),exported);assert.deepEqual(await w.call('document','document_1'),f.document);await w.assertNoEffects();
});

test('cancel at real raster worker admission terminates only its worker and removes its work after drain',async t=>{
 const f=await seed(t),c=make(f,'cancel_running_worker'),source=await readFile(pathFor(f.root,f.imported.asset.raster.pixels));await f.server.close();await arm(f,'worker-admission',c.command.commandId);const w=await writer(f,{}, {setupModule:fixture},()=>release(f));
 await w.historyCommand(encode(c),f.auth);const marker=await reached(f);assert.equal(marker.phase,'worker-admission');assert.equal(marker.slot,'history:'+c.command.commandId);assert.ok(marker.threadId>0);assert.ok(Number.isSafeInteger(marker.jobId)&&marker.jobId>0);{const diagnosticRead=await w.readDiagnostics();try{const raster=diagnosticRead.value.rasters;assert.equal(raster.activeWorkers,1);assert.equal(raster.workerService.slot,marker.slot);assert.equal(raster.workerService.identity.threadId,marker.threadId);assert.equal(raster.workerService.identity.generation,marker.generation);}finally{diagnosticRead.release();}}assert.ok((await workNames(f,c.command.commandId)).length>0);
 const result=await w.cancelExport(c.command.commandId,f.auth);await canceled(f,w,c,result);{const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.activeWorkers,0);}finally{diagnosticRead.release();}}assert.deepEqual(await workNames(f,c.command.commandId),[]);assert.deepEqual(await readFile(pathFor(f.root,f.imported.asset.raster.pixels)),source);
});

test('cancellation publishes its receipt before proof drain, then releases only its temporary directory',async t=>{
 const f=await seed(t),c=make(f,'cancel_after_proofs');await f.server.close();await arm(f,'after-proofs',c.command.commandId);const w=await writer(f,{}, {setupModule:fixture},()=>release(f));
 const unrelated=join(f.root,'raster-work','unrelated-export-sentinel');await mkdir(unrelated,{mode:0o700});await writeFile(join(unrelated,'keep'),'unrelated',{mode:0o600});
 await w.historyCommand(encode(c),f.auth);const marker=await reached(f);assert.ok(marker.proofCount>0);assert.equal(marker.phase,'after-proofs');const before=await workNames(f,c.command.commandId);assert.ok(before.length>0);
 let completed=false;const cancel=w.cancelExport(c.command.commandId,f.auth).then(result=>{completed=true;return result;});try{const saved=await record(w,c.command.commandId);assert.equal(saved.receipt.status,'rejected');assert.equal(completed,false);assert.deepEqual(await workNames(f,c.command.commandId),before);assert.equal(countEvents(f.root,c.command.commandId),0);}finally{await release(f);}
 const result=await cancel;await canceled(f,w,c,result);assert.deepEqual(await workNames(f,c.command.commandId),[]);assert.equal(await readFile(join(unrelated,'keep'),'utf8'),'unrelated');assert.deepEqual(await w.cancelExport(c.command.commandId,f.auth),result);
});

test('canceling another queued export does not terminate an unrelated live worker or remove its files',async t=>{
 const f=await seed(t),running=make(f,'a_export_kept_running'),canceledCommand=make(f,'z_export_cancel_queued');await f.server.close();await arm(f,'worker-admission',running.command.commandId);const w=await writer(f,{}, {setupModule:fixture},()=>release(f));
 await w.historyCommand(encode(running),f.auth);const marker=await reached(f);assert.equal(marker.slot,'history:'+running.command.commandId);assert.ok(Number.isSafeInteger(marker.jobId)&&marker.jobId>0);const runningNames=await workNames(f,running.command.commandId);assert.ok(runningNames.length>0);await w.historyCommand(encode(canceledCommand),f.auth);
 const result=await w.cancelExport(canceledCommand.command.commandId,f.auth);await canceled(f,w,canceledCommand,result);{const diagnosticRead=await w.readDiagnostics();try{const raster=diagnosticRead.value.rasters;assert.equal(raster.activeWorkers,1);assert.equal(raster.workerService.slot,marker.slot);assert.equal(raster.workerService.identity.threadId,marker.threadId);assert.equal(raster.workerService.identity.generation,marker.generation);}finally{diagnosticRead.release();}}assert.deepEqual(await workNames(f,running.command.commandId),runningNames);assert.equal((await w.commandState(running.command.commandId)).record,null);
 await release(f);const accepted=(await record(w,running.command.commandId)).receipt;assert.equal(accepted.status,'accepted');assert.equal(countEvents(f.root,running.command.commandId),1);assert.equal((await w.cancelExport(running.command.commandId,f.auth)).status,'completed');assert.deepEqual(await w.document('document_1'),f.document);
});

test('an export committed before a racing cancel keeps its single accepted receipt and exact bytes',async t=>{
 const f=await seed(t),c=make(f,'export_commit_wins');await f.server.close();const gate=new SharedArrayBuffer(4);let hit;const barrier=new Promise(resolve=>hit=resolve),releaseGate=()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);},w=await writer(f,{}, {phase:'history-after-commit',gate,onBarrier:hit},releaseGate);
 await w.historyCommand(encode(c),f.auth);await barrier;
 const accepted=sql(f.root,db=>JSON.parse(db.prepare('SELECT receipt FROM commands WHERE id=?').get(c.command.commandId).receipt)),asset=sql(f.root,db=>JSON.parse(db.prepare('SELECT json FROM events_v2 WHERE command_id=? ORDER BY length(seq) DESC,seq DESC LIMIT 1').get(c.command.commandId).json).payload.asset),bytes=await readFile(pathFor(f.root,asset.blob));assert.equal(accepted.status,'accepted');
 const cancel=w.cancelExport(c.command.commandId,f.auth);releaseGate();const result=await cancel;assert.equal(result.status,'completed');assert.deepEqual(result.receipt,accepted);assert.deepEqual(await w.historyCommand(encode(c),f.auth),accepted);assert.equal(countEvents(f.root,c.command.commandId),1);assert.deepEqual(await readFile(pathFor(f.root,asset.blob)),bytes);assert.deepEqual(await w.document('document_1'),f.document);
});

test('restart finishes terminal export scratch cleanup while preserving unrelated and backup-pinned files',async t=>{
 const f=await seed(t),c=make(f,'cancel_restart_cleanup');await f.server.close();let w=await writer(f);const one=await reader(f,w),two=await reader(f,w);await w.historyCommand(encode(c),f.auth);const result=await w.cancelExport(c.command.commandId,f.auth);await w.assetRelease(one.handle);await w.assetRelease(two.handle);await w.close();
 const removed=join(f.root,'raster-work','export-'+c.command.commandId+'.'+randomUUID()),pinned=join(f.root,'raster-work','export-'+c.command.commandId+'.'+randomUUID()),unrelated=join(f.root,'raster-work','export-another_command.'+randomUUID());
 for(const path of [removed,pinned,unrelated]){await mkdir(path,{mode:0o700});await writeFile(join(path,'keep'),'retained',{mode:0o600});}
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{for(const path of [removed,pinned,unrelated])db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(path,'document_1');db.prepare('INSERT INTO deletion_backup_files VALUES (?)').run(join(pinned,'keep'));}finally{db.close();}
 w=await writer(f);await assert.rejects(access(removed),{code:'ENOENT'});assert.equal(await readFile(join(pinned,'keep'),'utf8'),'retained');assert.equal(await readFile(join(unrelated,'keep'),'utf8'),'retained');assert.deepEqual(await w.cancelExport(c.command.commandId,f.auth),result);assert.deepEqual(await w.document('document_1'),f.document);
});

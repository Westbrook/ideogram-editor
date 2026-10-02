import {compileLegacy} from '../../tooling/qualification/legacy-compiler.mjs';
import {installSchema18Packet} from '../recovery/schema18-packet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,symlink,cp,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {rootFor,command,encode,childFor} from '../store/helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {setup} from '../protocol/helpers.mjs';
import {original,importRaster,operate,envelope,digest,layer} from './helpers.mjs';
const auth={clientId:'client_1',sessionHash:'s',now:Date.now(),expires:Date.now()+43200000};
const pause=()=>new Promise(r=>setTimeout(r,5));
async function settled(w,id){const deadline=performance.now()+30000;while(performance.now()<deadline){const state=await w.commandState(id);if(state.record)return state.record.receipt;await pause();}const diagnosticRead=await w.readDiagnostics();try{const d=diagnosticRead.value.rasters;throw new Error('Raster did not finish '+JSON.stringify({commandId:id,preparations:d.preparations,activeWorkers:d.activeWorkers,reservedCPU:d.reservedCPU,latest:d.observations.slice(-2)}));}finally{diagnosticRead.release();}}
async function source(w){const b=await readFile(new URL('./fixtures/white.png',import.meta.url)),s={protocolVersion:1,stagingId:randomUUID(),purpose:'image',expectedBytes:String(b.length),sha256:digest(b),mediaType:'image/png'};await w.assetCreate(s,auth);const token=await w.assetBeginChunk(s.stagingId,'0',b.length,auth);await w.assetChunk(token,b,auth);const c=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}});await w.assetCommand(encode(c),auth);const receipt=await settled(w,c.command.commandId);return (await w.events(String(BigInt(receipt.fromSeq)-1n))).events[0].payload.asset;}
test('shared two IO slots, combined64 preparations, exact pending identity and conflicting writer command',async t=>{
 let w;t.after(()=>w?.close());const root=await rootFor(t);w=await openWriter({root});await w.protocolDefaults();const a=await source(w),holds=[];
 for(let i=0;i<2;i++){const s={protocolVersion:1,stagingId:randomUUID(),purpose:'caption',expectedBytes:'1',sha256:digest('x'),mediaType:'text/plain'};await w.assetCreate(s,auth);holds.push(await w.assetBeginChunk(s.stagingId,'0',1,auth));}
 const commands=[];for(let i=0;i<64;i++){const c=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'PrepareRaster',assetId:a.id}});assert.equal(await w.rasterCommand(encode(c),auth),null);commands.push(c);}
 const extra=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'PrepareRaster',assetId:a.id}});await assert.rejects(w.rasterCommand(encode(extra),auth),{code:'QUEUE_FULL'});assert.equal((await w.commandState(extra.command.commandId)).pending,null);
 const first=commands[0],pending=(await w.commandState(first.command.commandId)).pending;assert.equal(pending.phase,'preparing');{const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.activeWorkers,0);}finally{diagnosticRead.release();}}
 await assert.rejects(w.submit(encode({...first,command:{...first.command,documentId:'wrong',body:{type:'NewDocument',width:1,height:1,color:'sRGB',depth:8}}}),w.epoch),{code:'COMMAND_ID_REUSE'});
 await assert.rejects(w.rasterCommand(encode({...first,command:{...first.command,sessionId:'changed'}}),auth),{code:'COMMAND_ID_REUSE'});
 for(const h of holds)await w.assetAbortChunk(h);
 for(const c of commands)assert.equal((await settled(w,c.command.commandId)).status,'accepted');
 assert.equal((await w.assetProjection(pending.operationId)).asset.qualification,'raster-preview');const diagnosticRead=await w.readDiagnostics();try{const d=diagnosticRead.value.rasters;assert.equal(d.preparations,0);assert.ok(d.observations.every(x=>!x.plan||x.plan.cpuBytes<=512*1024*1024));
 assert.equal(d.workerPhases.length,16);assert.ok(d.droppedWorkerPhases>=48);
 for(const snapshot of d.workerPhases){assert.equal(snapshot.lane,'raster-worker');assert.equal(snapshot.clockUncertaintyMs,null);assert.ok(snapshot.records.length<=64);assert.ok(snapshot.records.every(r=>r.durationMs>=0&&r.endedMs>=r.startedMs));assert.ok(snapshot.records.some(r=>r.phase==='raster.decode'&&r.outcome==='ok'));assert.ok(snapshot.records.some(r=>r.phase==='raster.encode'&&r.outcome==='ok'));assert.ok(snapshot.records.some(r=>r.phase==='raster.prepare'&&r.outcome==='incomplete'&&r.context.boundary==='observed'));}
 for(const snapshot of d.workerPhases){const active=snapshot.activeCompute;assert.equal(active?.kind,'raster-active-compute-1');assert.equal(active.complete,true);assert.equal(active.outcome,'completed');assert.equal(active.invalid,0);assert.equal(active.intervalCount,0);assert.equal(active.unionMs,0);assert.equal(active.startedMs,null);assert.deepEqual(active.intervals,[]);assert.ok(snapshot.records.every(r=>r.context.commandId===active.context.commandId));}
 const latest=d.workerPhases.at(-1);assert.ok(commands.some(c=>latest.records.every(r=>r.context.commandId===c.command.commandId)));assert.equal(JSON.stringify(d.workerPhases).includes(root),false);
 }finally{diagnosticRead.release();}
});
test('disk admission retains pending identity and later resumes same operation; original bytes are retained',async t=>{
 const root=await rootFor(t);let w=await openWriter({root});await w.protocolDefaults();const a=await source(w);await w.close();
 w=await openWriter({root,quotaBytes:'1073741824'});const c=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'PrepareRaster',assetId:a.id}});await w.rasterCommand(encode(c),auth);
 let p;for(let n=0;n<300;n++){p=(await w.commandState(c.command.commandId)).pending;if(p.phase==='waiting-for-resources')break;await pause();}assert.equal(p.phase,'waiting-for-resources');assert.equal(await w.lookup(c.command.commandId),null);await w.close();
 w=await openWriter({root});t.after(()=>w.close());const receipt=await settled(w,c.command.commandId);assert.equal(receipt.status,'accepted');assert.equal((await w.assetProjection(p.operationId)).asset.qualification,'raster-preview');assert.deepEqual((await w.lookup(c.command.commandId)).command,c.command);
});
test('raster typed snapshots retain full closure and exact pixels after full-log and snapshot reopen',async t=>{
 const f=await setup(t),image=await importRaster(f,'hidden-alpha.png');await f.server.close();let w=await openWriter({root:f.root});
 const c=command(EMPTY_EXPECTED_VERSIONS);await w.submit(encode(c),w.epoch);for(let i=1;i<251;i++)await w.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'raster snapshot'}})),w.epoch);
 const captured=await w.capture();assert.equal(captured.snapshot.seq,'250');{const diagnosticRead=await w.readDiagnostics();try{const snapshotPhase=diagnosticRead.value.observations.phases.records.find(r=>r.phase==='document.snapshot'&&r.context.snapshotId===captured.snapshot.id);assert.ok(snapshotPhase);assert.equal(snapshotPhase.outcome,'ok');assert.equal(snapshotPhase.context.workspaceSeq,'250');assert.equal(snapshotPhase.context.assetHash,captured.snapshot.content.blob.hash);assert.equal(snapshotPhase.context.boundary,'authority-durable');}finally{diagnosticRead.release();}}await w.close();w=await openWriter({root:f.root});assert.deepEqual((await w.assetProjection(image.asset.id)).asset,image.asset);assert.equal((await w.rasterManifest(image.asset.id)).pixels.hash,image.asset.raster.pixels.hash);await w.close();
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'));assert.ok(db.prepare('SELECT count(*) AS n FROM snapshot_roots WHERE hash=?').get(image.asset.raster.pixels.hash).n>0);db.exec('DELETE FROM snapshot_roots; DELETE FROM snapshots;');db.close();w=await openWriter({root:f.root});assert.deepEqual((await w.assetProjection(image.asset.id)).asset,image.asset);assert.equal((await w.rasterManifest(image.asset.id)).pixels.hash,image.asset.raster.pixels.hash);await w.close();
});
test('schema4 migration preserves exact approvede8b9f1a data and its prior-code rollback',async t=>{
 const root=await rootFor(t),old=await rootFor(t);compileLegacy(old,'e8b9f1a379becd97365242cc0a3b1c9d703bcfcb');
 const c=command(EMPTY_EXPECTED_VERSIONS);await writeFile(join(old,'seed.mjs'),`import{openWriter}from'./dist/local/server/storage/writer.js';const w=await openWriter({root:process.argv[2]});await w.protocolDefaults();await w.submit(Buffer.from(${JSON.stringify(JSON.stringify(c))}),w.epoch);await w.close();`);execFileSync(process.execPath,[join(old,'seed.mjs'),root]);
 let db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);const tables=['objects','commands','events','events_v2','documents','history','checkpoints','roots','snapshots','snapshot_roots','staged_assets','asset_preparations','assets','asset_dependencies'];const before=Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()]));db.close();
 await installSchema18Packet(root);const w=await openWriter({root});assert.equal((await w.lookup(c.command.commandId)).receipt.status,'accepted');await w.close();db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,19);for(const table of tables)assert.deepEqual(db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),before[table]);const migration=JSON.parse(db.prepare('SELECT receipt FROM schema_migrations WHERE version=4').get().receipt);db.close();
 const backup=new DatabaseSync(join(root,migration.backup),{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,3);assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');for(const table of tables)assert.deepEqual(backup.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),before[table]);backup.close();
 const rollback=await rootFor(t);await cp(join(root,'objects'),join(rollback,'objects'),{recursive:true});await writeFile(join(rollback,'metadata.sqlite'),await readFile(join(root,migration.backup)),{mode:0o600});await writeFile(join(old,'rollback.mjs'),`import{openWriter}from'./dist/local/server/storage/writer.js';const w=await openWriter({root:process.argv[2]});if((await w.lookup('${c.command.commandId}')).receipt.fromSeq!=='1')throw Error('lost receipt');await w.close();`);execFileSync(process.execPath,[join(old,'rollback.mjs'),rollback]);
});


test('exact nonfirst raster retry survives restart and occupied IO slots without retrying other waiting work',async t=>{
 const root=await rootFor(t);let child;
 const open=async options=>{child=await childFor(t,root,options);assert.equal(child.startup.type,'ready');};
 const close=async()=>{const owned=child;child=undefined;if(owned)try{await owned.assertNoEffects();}finally{await owned.close();}};
 const eventually=async(read,message)=>{const deadline=performance.now()+30000;while(performance.now()<deadline){const value=await read();if(value)return value;await pause();}throw Error(message);};
 const terminal=id=>eventually(async()=> (await child.call('commandState',id)).record,'Exact raster command did not become terminal');
 const requests=[];
 const rows=()=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return Object.fromEntries(requests.map(c=>{const row=db.prepare('SELECT * FROM raster_preparations WHERE id=?').get(c.command.commandId);return [c.command.commandId,row?{...row}:null];}));}finally{db.close();}};
 try{
  await open();await child.call('protocolDefaults');
  const bytes=await readFile(new URL('./fixtures/white.png',import.meta.url)),stage={protocolVersion:1,stagingId:randomUUID(),purpose:'image',expectedBytes:String(bytes.length),sha256:digest(bytes),mediaType:'image/png'};
  await child.call('assetCreate',stage,auth);const token=await child.call('assetBeginChunk',stage.stagingId,'0',bytes.length,auth);await child.call('assetChunk',token,bytes,auth);
  const finalized=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256}});
  await child.call('assetCommand',encode(finalized),auth);const registered=await terminal(finalized.command.commandId),source=(await child.call('events',String(BigInt(registered.receipt.fromSeq)-1n))).events[0].payload.asset;
  await close();await open({quotaBytes:'1073741824'});
  for(const commandId of ['retry_raster_a','retry_raster_b','retry_raster_c']){
   const c=command(EMPTY_EXPECTED_VERSIONS,{commandId,documentId:null,body:{type:'PrepareRaster',assetId:source.id}});requests.push(c);
   assert.equal(await child.call('rasterCommand',encode(c),auth),null);
   await eventually(async()=> (await child.call('commandState',commandId)).pending?.phase==='waiting-for-resources','Real disk admission did not retain the raster');
   assert.equal(await child.call('lookup',commandId),null);
  }
  const persisted=rows();await close();await open();
  const first=await terminal(requests[0].command.commandId);assert.equal(first.receipt.status,'accepted');
  const middle=requests[1],selected=requests[2],middleId=middle.command.commandId,selectedId=selected.command.commandId;
  assert.deepEqual(rows()[middleId],persisted[middleId]);assert.deepEqual(rows()[selectedId],persisted[selectedId]);
  await assert.rejects(child.call('rasterCommand',encode(selected),{...auth,clientId:'other'}),{code:'OWNER_REQUIRED'});
  await assert.rejects(child.call('rasterCommand',encode({...selected,command:{...selected.command,clientId:'other'}}),{...auth,clientId:'other'}),{code:'COMMAND_ID_REUSE'});
  await assert.rejects(child.call('rasterCommand',encode({...selected,command:{...selected.command,sessionId:'changed'}}),auth),{code:'COMMAND_ID_REUSE'});
  assert.deepEqual(rows()[selectedId],persisted[selectedId]);
  // Retrying C must not spend the retry on the lexicographically earlier B.
  assert.equal(await child.call('rasterCommand',encode(selected),auth),null);
  const selectedRecord=await terminal(selectedId);assert.equal(selectedRecord.receipt.status,'accepted');assert.deepEqual(selectedRecord.command,selected.command);
  assert.equal((await child.call('assetProjection',persisted[selectedId].operation_id)).asset.qualification,'raster-preview');assert.deepEqual(rows()[middleId],persisted[middleId]);
  await eventually(async()=>JSON.parse(await child.call('diagnosticJSON','all')).assets.activeTransfers===0,'Completed raster did not release IO');
  const holds=[];
  try{
   for(let i=0;i<2;i++){const s={protocolVersion:1,stagingId:randomUUID(),purpose:'caption',expectedBytes:'1',sha256:digest('x'),mediaType:'text/plain'};await child.call('assetCreate',s,auth);holds.push(await child.call('assetBeginChunk',s.stagingId,'0',1,auth));}
   assert.equal(await child.call('rasterCommand',encode(middle),auth),null);
   assert.equal((await child.call('commandState',middleId)).pending.phase,'preparing');
   assert.deepEqual(rows()[middleId],{...persisted[middleId],phase:'preparing'});
   assert.equal(await child.call('lookup',middleId),null);
   await child.call('assetAbortChunk',holds.shift());
   const record=await terminal(middleId);assert.equal(record.receipt.status,'accepted');assert.deepEqual(record.command,middle.command);
   assert.equal((await child.call('assetProjection',persisted[middleId].operation_id)).asset.qualification,'raster-preview');
  }finally{for(const hold of holds)await child.call('assetAbortChunk',hold);}
  for(const c of requests){const record=await terminal(c.command.commandId);assert.deepEqual(record.command,c.command);assert.equal(record.hash,persisted[c.command.commandId].hash);assert.deepEqual(await child.call('rasterCommand',encode(c),auth),record.receipt);}
  {const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{for(const c of requests){assert.equal(db.prepare('SELECT original FROM commands WHERE id=?').get(c.command.commandId).original,persisted[c.command.commandId].original);assert.equal(db.prepare('SELECT count(*) AS n FROM events_v2 WHERE command_id=?').get(c.command.commandId).n,1);}}finally{db.close();}}
  const receipts=await Promise.all(requests.map(c=>child.call('lookup',c.command.commandId)));await close();await open();
  for(let i=0;i<requests.length;i++){assert.deepEqual(await child.call('lookup',requests[i].command.commandId),receipts[i]);assert.deepEqual(await child.call('rasterCommand',encode(requests[i]),auth),receipts[i].receipt);}
  assert.deepEqual((await child.call('assetProjection',source.id)).asset,source);
  assert.deepEqual(await readFile(join(root,'objects','sha256',source.blob.hash.slice(7,9),source.blob.hash.slice(7))),bytes);
 }finally{await close();}
});

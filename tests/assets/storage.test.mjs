import {compileLegacy} from '../../tooling/qualification/legacy-compiler.mjs';
import {installSchema18Packet} from '../recovery/schema18-packet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { writeFile,readFile,symlink,unlink,mkdir,readdir,truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rootFor,command,encode,expectedBytes,refFor,childFor } from '../store/helpers.mjs';
import { setup,pair,call,cookieFrom,readHeaders,mutationHeaders } from '../protocol/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { inspectTree } from '../../dist/local/server/storage/files.js';
import { startLocalServer } from '../../dist/local/server/http.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const auth={clientId:'client_1',sessionHash:'a'.repeat(64),expires:Date.now()+43200000,now:Date.now()};
const upload=b=>({protocolVersion:1,stagingId:randomUUID(),purpose:'caption',expectedBytes:String(b.length),sha256:hash(b),mediaType:'text/plain'});
async function own(w,b){const s=upload(b);await w.assetCreate(s,auth);if(b.length){const token=await w.assetBeginChunk(s.stagingId,'0',b.length,auth);await w.assetChunk(token,b,auth);}const c=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}});await w.assetCommand(encode(c),auth);for(let i=0;i<200;i++){const r=await w.lookup(c.command.commandId);if(r)return {s,c,r};await new Promise(r=>setTimeout(r,5));}throw new Error('No receipt');}

test('actual7ef07dd migration preserves all retained tables and verified rollback database',async t=>{
  const root=await rootFor(t);const source=await rootFor(t);compileLegacy(source,'7ef07dda92279cc632d82e18d008c74ff99ee851');
  const c=command(refFor(expectedBytes));const seed=`import{openWriter}from'./dist/local/server/storage/writer.js';const w=await openWriter({root:process.argv[2]});await w.protocolDefaults();const c=${JSON.stringify(c)};await w.submit(Buffer.from(JSON.stringify(c)),w.epoch);for(let i=1;i<252;i++){const n={...c,command:{...c.command,commandId:'checkpoint_'+i,transactionId:'tx_'+i,expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'retained '+i}}};await w.submit(Buffer.from(JSON.stringify(n)),w.epoch);}await w.capture();await w.close();`;
  await writeFile(join(source,'seed.mjs'),seed,{mode:0o600});execFileSync(process.execPath,[join(source,'seed.mjs'),root],{env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR}});
  let db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);const tables=['objects','commands','events','events_v2','documents','history','checkpoints','roots','snapshots','snapshot_roots','client_bindings','read_releases'];const baseline=Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()]));db.close();
  await installSchema18Packet(root);const w=await openWriter({root});assert.equal((await w.document('document_1')).revision,'252');assert.equal((await w.capture()).snapshot.seq,'250');assert.equal((await w.lookup(c.command.commandId)).receipt.fromSeq,'1');await w.close();
  db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,19);for(const table of tables)assert.deepEqual(db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),baseline[table]);const migration=JSON.parse(db.prepare('SELECT receipt FROM schema_migrations WHERE version=3').get().receipt);assert.equal(migration.manifest.events_v2.count,'252');const backup=new DatabaseSync(join(root,migration.backup),{readOnly:true});assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(backup.prepare('PRAGMA user_version').get().user_version,2);for(const table of tables)assert.deepEqual(backup.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),baseline[table]);backup.close();db.close();
  // Open the retained backup with the exact prior code in an isolated copied root.
  const rollback=await rootFor(t);const {cp}=await import('node:fs/promises');await cp(join(root,'objects'),join(rollback,'objects'),{recursive:true});await writeFile(join(rollback,'metadata.sqlite'),await readFile(join(root,migration.backup)),{mode:0o600});
  await writeFile(join(source,'rollback.mjs'),`import{openWriter}from'./dist/local/server/storage/writer.js';const w=await openWriter({root:process.argv[2]});if((await w.document('document_1')).revision!=='252')throw Error('lost history');if((await w.lookup('${c.command.commandId}')).receipt.fromSeq!=='1')throw Error('lost receipt');await w.close();`,{mode:0o600});execFileSync(process.execPath,[join(source,'rollback.mjs'),rollback],{env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR}});
});

test('asset event replay and snapshots keep original bytes and dependencies across restart',async t=>{
  const root=await rootFor(t);let w=await openWriter({root});await w.protocolDefaults();const first=await own(w,Buffer.from('same bytes'));assert.equal(first.r.receipt.status,'accepted');const asset=(await w.events('0')).events[0].payload.asset;
  const doc=command(EMPTY_EXPECTED_VERSIONS);await w.submit(encode(doc),w.epoch);for(let i=1;i<251;i++)await w.submit(encode(command(EMPTY_EXPECTED_VERSIONS,{expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'asset retained '+i}})),w.epoch);
  const capture=await w.capture();assert.equal(capture.snapshot.seq,'250');const proof=await w.assetVerify(asset.id);assert.equal(Buffer.from(await w.assetContent(asset.id,proof.handle,'0',10)).toString(),'same bytes');await w.assetRelease(proof.handle);await w.close();
  w=await openWriter({root});assert.deepEqual((await w.assetProjection(asset.id)).asset,asset);assert.deepEqual((await w.lookup(first.c.command.commandId)).receipt,first.r.receipt);await w.close();
  const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM asset_dependencies WHERE asset_id=?').get(asset.id).n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM roots WHERE owner=?').get('asset:'+asset.id).n,1);assert.ok(db.prepare('SELECT count(*) AS n FROM snapshot_roots WHERE owner=?').get('asset:'+asset.id).n>=1);db.close();
});

test('staging symlinks are rejected without writing the target, and reservation pressure retains data',async t=>{
  const root=await rootFor(t);const w=await openWriter({root});t.after(()=>w.close());const b=Buffer.from('private');const s=upload(b);await w.assetCreate(s,auth);const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});const filename=db.prepare('SELECT filename FROM staged_assets WHERE id=?').get(s.stagingId).filename;db.close();
  const outside=await rootFor(t);const sentinel=join(outside,'sentinel');await writeFile(sentinel,'untouched',{mode:0o600});await unlink(join(root,'uploads',filename));await symlink(sentinel,join(root,'uploads',filename));const token=await w.assetBeginChunk(s.stagingId,'0',b.length,auth);await assert.rejects(w.assetChunk(token,b,auth),{code:'ROOT_UNSAFE'});assert.equal(await readFile(sentinel,'utf8'),'untouched');assert.equal((await w.assetGet(s.stagingId,auth)).committedOffset,'0');
  await assert.rejects(w.assetCreate({...upload(b),expectedBytes:'999999999999999999999'},auth),{code:'CAPACITY'});
  const inventory=await w.assetInventory(null,auth);assert.equal(inventory.items.length,1);
});

test('journal capacity failure cannot invent a pending command or replace its original rejection',async t=>{
  const f=await setup(t);const b=Buffer.from('journal test');const s=upload(b);await f.post('/api/v1/assets/staging',s);await call(f.server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:b,headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Upload-Offset':'0'}});const cookie=cookieFrom(f.paired);await f.server.close();const w=await openWriter({root:f.root});let pages;{const diagnosticRead=await w.readDiagnostics();try{pages=diagnosticRead.value.settings.page_count;}finally{diagnosticRead.release();}}await w.close();
  const full=await startLocalServer({root:f.root},{writer:{maxPageCount:pages}});t.after(()=>full.close());const paired=await call(full.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:full.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(full.issuePairingURL()).hash.slice(9)}});assert.equal(paired.status,200);
  const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,documentId:null,correlationId:'x'.repeat(128),body:{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}});
  // Fill SQLite's allocated pages with retained private preparation metadata.
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'));db.exec('CREATE TABLE fault_fill (id INTEGER PRIMARY KEY, b BLOB)');db.exec('PRAGMA max_page_count='+pages);let actual;try{for(let i=0;;i++)db.prepare('INSERT INTO fault_fill(b) VALUES(?)').run(Buffer.alloc(2000));}catch(e){actual=e.errcode;}db.close();assert.equal(actual,13);
  const result=await call(full.origin,'/api/v1/commands',{method:'POST',raw:Buffer.from(' '.repeat(60000)+JSON.stringify(c)),headers:mutationHeaders(full,paired)});assert.equal(result.status,507,result.text);const lookup=await call(full.origin,'/api/v1/commands/'+c.command.commandId,{headers:readHeaders(cookieFrom(paired))});assert.equal(lookup.status,404,lookup.text);
});

test('recovery inventory paginates minimal metadata and content pins detect later file changes',async t=>{
  const root=await rootFor(t);const w=await openWriter({root});t.after(()=>w.close());await w.protocolDefaults();for(let i=0;i<320;i++)await w.assetCreate({...upload(Buffer.alloc(0)),stagingId:'stage_'+String(i).padStart(4,'0')},auth);
  const first=await w.assetInventory(null,auth);assert.ok(first.nextCursor);assert.ok(Buffer.byteLength(JSON.stringify(first))<=65536);await assert.rejects(w.assetInventory(first.nextCursor,{...auth,clientId:'other'}),{code:'MALFORMED_REQUEST'});const second=await w.assetInventory(first.nextCursor,auth);assert.equal(first.items.length+second.items.length,320);assert.equal(second.nextCursor,null);
  const owned=await own(w,Buffer.from('reader pin'));const asset=(await w.events(String(BigInt(owned.r.receipt.fromSeq)-1n))).events[0].payload.asset;const opened=await w.assetVerify(asset.id);const path=join(root,'objects','sha256',asset.blob.hash.slice(7,9),asset.blob.hash.slice(7));await writeFile(path,'changed !!');await assert.rejects(w.assetContent(asset.id,opened.handle,'0',2),{code:'CORRUPT_OBJECT'});await w.assetRelease(opened.handle);
});

test('durable preparation waits for shared reader slots and retains original command ownership',async t=>{
  const root=await rootFor(t);const w=await openWriter({root});t.after(()=>w.close());await w.protocolDefaults();const original=await own(w,Buffer.from('reader slots'));const asset=(await w.events('0')).events[0].payload.asset;const one=await w.assetVerify(asset.id);const two=await w.assetVerify(asset.id);
  const s=upload(Buffer.alloc(0));await w.assetCreate(s,auth);const c=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}});assert.equal(await w.assetCommand(encode(c),auth),null);const pending=await w.assetPending(c.command.commandId);assert.equal(pending.command.commandId,c.command.commandId);
  await assert.rejects(w.assetCommand(encode({...c,command:{...c.command,clientId:'other'}}),{...auth,clientId:'other'}),{code:'OWNER_REQUIRED'});
  // Exercise the sole writer directly: no HTTP precheck may enforce identity for it.
  const conflicting=command(EMPTY_EXPECTED_VERSIONS,{commandId:c.command.commandId});
  await assert.rejects(w.submit(encode(conflicting),w.epoch),{code:'COMMAND_ID_REUSE'});
  assert.deepEqual(await w.assetPending(c.command.commandId),pending);
  assert.equal(await w.lookup(c.command.commandId),null);
  await w.assetRelease(one.handle);await w.assetRelease(two.handle);let result;for(let i=0;i<200;i++){result=await w.lookup(c.command.commandId);if(result)break;await new Promise(r=>setTimeout(r,5));}assert.equal(result.receipt.status,'accepted');assert.equal((await w.events('1')).events[0].payload.asset.id,pending.operationId);
  assert.deepEqual((await w.lookup(original.c.command.commandId)).receipt,original.r.receipt);
});

test('exact asset retry survives restart and occupied slots without rearming unrelated waiting commands',async t=>{
  const root=await rootFor(t);let w;t.after(()=>w?.close());
  const writer=async(options={})=>{
    const child=await childFor(t,root,options);assert.equal(child.startup.type,'ready');
    const methods=['protocolDefaults','assetCreate','assetBeginChunk','assetChunk','assetCommand','assetPending','commandState','assetGet','lookup','events','assetVerify','assetRelease','assetContent','assetProjection','originalCommand'];
    return {...Object.fromEntries(methods.map(method=>[method,(...args)=>child.call(method,...args)])),close:async()=>{await child.assertNoEffects();await child.close();}};
  };
  w=await writer();await w.protocolDefaults();
  const readerBytes=Buffer.from('retry reader slots'),original=await own(w,readerBytes),reader=(await w.events('0')).events[0].payload.asset;
  const entries=[];
  for(const suffix of ['a','b','c']){
    const bytes=Buffer.from('retained retry '+suffix),stage=upload(bytes);await w.assetCreate(stage,auth);
    const token=await w.assetBeginChunk(stage.stagingId,'0',bytes.length,auth);await w.assetChunk(token,bytes,auth);
    const request=command(EMPTY_EXPECTED_VERSIONS,{commandId:'retry_asset_'+suffix,documentId:null,body:{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256}});
    entries.push({bytes,stage,request,encoded:Buffer.from(' \n'+JSON.stringify(request,null,2)+'\n')});
  }
  const rows=()=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM asset_preparations ORDER BY id').all().map(row=>({...row}));}finally{db.close();}};
  const until=async(read,ready,label)=>{for(let i=0;i<200;i++){const value=await read();if(ready(value))return value;await new Promise(r=>setTimeout(r,5));}assert.fail(label);};
  const waiting=async()=>{for(const entry of entries)await until(()=>w.assetPending(entry.request.command.commandId),value=>value?.phase==='waiting-for-resources','Asset did not reach real quota pressure');};
  const accepted=entry=>until(()=>w.lookup(entry.request.command.commandId),value=>value?.receipt.status==='accepted','Exact asset retry did not finish');
  await w.close();w=undefined;
  // Derive quota from retained bytes plus production's 1 GiB margin and 64 MiB
  // emergency reserve. Keep 8 MiB for journal growth; a 16 MiB private sparse
  // filler triggers real admission without filling the host or editing rows.
  const limited={quotaBytes:String(inspectTree(root)+1024n**3n+64n*1024n**2n+8n*1024n**2n)};
  const filler=join(root,'asset-retry-quota-filler');await writeFile(filler,'',{mode:0o600});await truncate(filler,16*1024**2);
  w=await writer(limited);
  for(const entry of entries)assert.equal(await w.assetCommand(entry.encoded,auth),null);
  await waiting();const before=rows();assert.equal(before.length,3);
  for(const entry of entries){
    const row=before.find(value=>value.id===entry.request.command.commandId);assert.equal(row.original,entry.encoded.toString());assert.equal(row.hash,hash(Buffer.from(row.canonical)));
    assert.deepEqual(JSON.parse(row.canonical),entry.request);assert.equal(row.staging_id,entry.stage.stagingId);
    assert.equal(await w.lookup(row.id),null);assert.equal((await w.assetGet(entry.stage.stagingId,auth)).state,'complete');
  }
  await w.close();w=undefined;w=await writer(limited);await waiting();assert.deepEqual(rows(),before);
  const [first,middle,last]=entries;
  // Failed authority/identity checks must not alter any pending phase or bytes.
  await assert.rejects(w.assetCommand(encode({...last.request,command:{...last.request.command,clientId:'other'}}),{...auth,clientId:'other'}),{code:'OWNER_REQUIRED'});
  await assert.rejects(w.assetCommand(encode({...last.request,command:{...last.request.command,sessionId:'changed'}}),auth),{code:'COMMAND_ID_REUSE'});
  assert.deepEqual(rows(),before);
  await unlink(filler);
  assert.equal(await w.assetCommand(middle.encoded,auth),null);const middleResult=await accepted(middle);
  assert.deepEqual(rows(),before.filter(row=>row.id!==middle.request.command.commandId));
  assert.equal(await w.lookup(first.request.command.commandId),null);assert.equal(await w.lookup(last.request.command.commandId),null);
  // Both real content handles own shared IO slots before the last row is retried.
  const one=await w.assetVerify(reader.id),two=await w.assetVerify(reader.id);
  assert.equal(await w.assetCommand(last.encoded,auth),null);
  assert.equal((await w.commandState(last.request.command.commandId)).pending.phase,'preparing');
  const deferred=await w.assetPending(last.request.command.commandId),lastBefore=before.find(row=>row.id===last.request.command.commandId);
  assert.equal(deferred.phase,'preparing');assert.equal(deferred.operationId,lastBefore.operation_id);
  assert.deepEqual(rows(),before.filter(row=>row.id!==middle.request.command.commandId).map(row=>row.id===last.request.command.commandId?{...row,phase:'preparing'}:row));
  assert.equal(await w.lookup(last.request.command.commandId),null);
  // A normal slot-release callback, with no second retry, must finish this row.
  await w.assetRelease(one.handle);const lastResult=await accepted(last);
  assert.deepEqual(rows(),before.filter(row=>row.id===first.request.command.commandId));assert.equal(await w.lookup(first.request.command.commandId),null);
  assert.deepEqual(Buffer.from(await w.assetContent(reader.id,two.handle,'0',readerBytes.length)),readerBytes);await w.assetRelease(two.handle);
  assert.equal(await w.assetCommand(first.encoded,auth),null);const firstResult=await accepted(first);
  assert.deepEqual(rows(),[]);
  const results=[firstResult,middleResult,lastResult];
  for(let i=0;i<entries.length;i++){
    const entry=entries[i],row=before.find(value=>value.id===entry.request.command.commandId),result=results[i];
    assert.equal(result.hash,row.hash);assert.deepEqual(result.command,entry.request.command);assert.equal(await w.originalCommand(row.id,auth.clientId),entry.encoded.toString());
    assert.deepEqual(await w.assetCommand(entry.encoded,auth),result.receipt);
    const asset=(await w.assetProjection(row.operation_id)).asset;assert.equal(asset.blob.hash,entry.stage.sha256);assert.equal(asset.blob.byteLength,String(entry.bytes.length));
    assert.equal((await w.assetGet(entry.stage.stagingId,auth)).state,'finalized');
    const proof=await w.assetVerify(asset.id);assert.deepEqual(Buffer.from(await w.assetContent(asset.id,proof.handle,'0',entry.bytes.length)),entry.bytes);await w.assetRelease(proof.handle);
  }
  assert.deepEqual((await w.lookup(original.c.command.commandId)).receipt,original.r.receipt);
  const events=(await w.events('0')).events;assert.equal(events.length,4);
  for(const row of before){const owned=events.filter(event=>event.commandId===row.id);assert.equal(owned.length,1);assert.equal(owned[0].type,'AssetRegistered');assert.equal(owned[0].payload.asset.id,row.operation_id);}
  await w.close();w=undefined;w=await writer(limited);
  for(let i=0;i<entries.length;i++){assert.deepEqual((await w.lookup(entries[i].request.command.commandId)).receipt,results[i].receipt);assert.equal(await w.originalCommand(entries[i].request.command.commandId,auth.clientId),entries[i].encoded.toString());}
  assert.deepEqual((await w.events('0')).events,events);assert.deepEqual(rows(),[]);
});

test('malformed owned manifest is a durable rejection and does not strand or accept the pending original',async t=>{
  const root=await rootFor(t);const w=await openWriter({root});t.after(()=>w.close());await w.protocolDefaults();const invalid=await own(w,Buffer.from('{bad'));const asset=(await w.events('0')).events[0].payload.asset;const s=upload(Buffer.alloc(0));await w.assetCreate(s,auth);
  const c=command({...asset.blob,mediaType:'application/json'},{documentId:null,body:{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}});await w.assetCommand(encode(c),auth);let result;for(let i=0;i<200;i++){result=await w.lookup(c.command.commandId);if(result)break;await new Promise(r=>setTimeout(r,5));}assert.equal(result.receipt.code,'INVALID_INPUT');assert.equal(await w.assetPending(c.command.commandId),null);assert.deepEqual(await w.assetCommand(encode(c),auth),result.receipt);assert.equal((await w.assetGet(s.stagingId,auth)).state,'complete');
  const next=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:c.command.body});await w.assetCommand(encode(next),auth);for(let i=0;i<200;i++){result=await w.lookup(next.command.commandId);if(result)break;await new Promise(r=>setTimeout(r,5));}assert.equal(result.receipt.status,'accepted');assert.equal((await w.lookup(invalid.c.command.commandId)).receipt.status,'accepted');
});

import {compileLegacy} from '../../tooling/qualification/legacy-compiler.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { writeFile,readFile,symlink,unlink,mkdir,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rootFor,command,encode,expectedBytes,refFor } from '../store/helpers.mjs';
import { setup,pair,call,cookieFrom,readHeaders,mutationHeaders } from '../protocol/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
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
  const w=await openWriter({root});assert.equal((await w.document('document_1')).revision,'252');assert.equal((await w.capture()).snapshot.seq,'250');assert.equal((await w.lookup(c.command.commandId)).receipt.fromSeq,'1');await w.close();
  db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,16);for(const table of tables)assert.deepEqual(db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),baseline[table]);const migration=JSON.parse(db.prepare('SELECT receipt FROM schema_migrations WHERE version=3').get().receipt);assert.equal(migration.manifest.events_v2.count,'252');const backup=new DatabaseSync(join(root,migration.backup),{readOnly:true});assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(backup.prepare('PRAGMA user_version').get().user_version,2);for(const table of tables)assert.deepEqual(backup.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),baseline[table]);backup.close();db.close();
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
  const f=await setup(t);const b=Buffer.from('journal test');const s=upload(b);await f.post('/api/v1/assets/staging',s);await call(f.server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:b,headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Upload-Offset':'0'}});const cookie=cookieFrom(f.paired);await f.server.close();const w=await openWriter({root:f.root});const pages=(await w.diagnostics()).settings.page_count;await w.close();
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

test('malformed owned manifest is a durable rejection and does not strand or accept the pending original',async t=>{
  const root=await rootFor(t);const w=await openWriter({root});t.after(()=>w.close());await w.protocolDefaults();const invalid=await own(w,Buffer.from('{bad'));const asset=(await w.events('0')).events[0].payload.asset;const s=upload(Buffer.alloc(0));await w.assetCreate(s,auth);
  const c=command({...asset.blob,mediaType:'application/json'},{documentId:null,body:{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}});await w.assetCommand(encode(c),auth);let result;for(let i=0;i<200;i++){result=await w.lookup(c.command.commandId);if(result)break;await new Promise(r=>setTimeout(r,5));}assert.equal(result.receipt.code,'INVALID_INPUT');assert.equal(await w.assetPending(c.command.commandId),null);assert.deepEqual(await w.assetCommand(encode(c),auth),result.receipt);assert.equal((await w.assetGet(s.stagingId,auth)).state,'complete');
  const next=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:c.command.body});await w.assetCommand(encode(next),auth);for(let i=0;i<200;i++){result=await w.lookup(next.command.commandId);if(result)break;await new Promise(r=>setTimeout(r,5));}assert.equal(result.receipt.status,'accepted');assert.equal((await w.lookup(invalid.c.command.commandId)).receipt.status,'accepted');
});

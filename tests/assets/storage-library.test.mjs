import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {allocationLedger} from '../../dist/local/src/observability/allocations.js';
import {CompositionMemory} from '../../dist/local/server/storage/composition-memory.js';
import {StorageLibraryMemory,STORAGE_REGISTRY_BYTES,STORAGE_OPERATION_BYTES} from '../../dist/local/server/storage/library-memory.js';
import {DatabaseSync} from 'node:sqlite';
import {StorageLibrary} from '../../dist/local/server/storage/library.js';
import {Objects} from '../../dist/local/server/storage/objects.js';
import {Displays} from '../../dist/local/server/storage/display.js';
import {validateStorageSummary,validateStorageAssetPage,validateStorageDependencyPage,validateStorageCacheClearResult,STORAGE_CLEAR_SCOPE} from '../../dist/local/src/protocol/storage.js';
import {rootFor} from '../store/helpers.mjs';
import {setup,call,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';

// Actual SQLite/Object/Displays implementations, with only persisted metadata
// fixtures inserted directly. No fake query/parser/accounting result is supplied.
async function fixture(t){
  const root=await rootFor(t),db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO meta VALUES ('highWater','0');
    CREATE TABLE client_bindings(cookie_hash TEXT PRIMARY KEY,client_id TEXT,expires INTEGER);
    CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE objects(hash TEXT PRIMARY KEY,byte_length TEXT);
    CREATE TABLE asset_dependencies(asset_id TEXT,hash TEXT);CREATE TABLE roots(owner TEXT,hash TEXT,media_type TEXT);
    CREATE TABLE snapshot_roots(snapshot_id TEXT,owner TEXT,hash TEXT,media_type TEXT);CREATE TABLE portable_pins(operation_id TEXT,hash TEXT,media_type TEXT);CREATE TABLE deletion_backup_pins(hash TEXT);
    CREATE TABLE candidate_asset_evidence(asset_id TEXT);CREATE TABLE staged_assets(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE documents(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE history(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE checkpoints(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE queue_jobs(id TEXT PRIMARY KEY,json TEXT);`);
  const auth={clientId:'client',sessionHash:'a'.repeat(64),expires:Date.now()+600000,now:Date.now()};
  db.prepare('INSERT INTO client_bindings VALUES (?,?,?)').run(auth.sessionHash,auth.clientId,auth.expires);
  const objects=new Objects(root,()=>{},()=>{}),displays=new Displays(objects,{}, {},root,()=>{});
  // Test-owned central grants remain live through every retained test result;
  // the actual writer mirror validates the same storage-family capabilities.
  const registryId=randomUUID(),loanId=randomUUID(),registry=allocationLedger.reserve({owner:'storage-test-registry',kind:'control',cpuBytes:STORAGE_REGISTRY_BYTES,handles:1});
  let request;try{request=allocationLedger.reserve({owner:'storage-test-request',kind:'control',cpuBytes:STORAGE_OPERATION_BYTES.dependencies,handles:1});}catch(error){registry.release();await displays.close();objects.close();db.close();throw error;}
  let mirror;mirror=new CompositionMemory(()=>mirror.bytes,()=>0);mirror.resize(registryId,STORAGE_REGISTRY_BYTES,'storage-registry');mirror.resize(loanId,STORAGE_OPERATION_BYTES.dependencies,'storage-read');
  const memory=new StorageLibraryMemory(mirror),actual=new StorageLibrary(db,objects,displays,root,'1',()=>{},memory);
  const scope=kind=>Object.freeze({registryId,loanId,kind});
  const library={summary:auth=>actual.summary(auth,scope('summary')),assets:(category,cursor,auth)=>actual.assets(category,cursor,auth,scope('assets')),dependencies:(id,cursor,auth)=>actual.dependencies(id,cursor,auth,scope('dependencies')),clear:auth=>actual.clear(auth,scope('clear')),close:()=>actual.close()};
  t.after(async()=>{library.close();memory.close();await displays.close();objects.close();db.close();mirror.drop(loanId,()=>{});mirror.drop(registryId,()=>{});request.release();registry.release();});
  const blob={hash:'sha256:'+'1'.repeat(64),byteLength:'17',mediaType:'image/png'};
  const asset=id=>({id,version:'1',purpose:'image',qualification:'pending-decoder',availability:'available',blob,dependencies:[],safety:'unknown',measuredMediaType:'image/png'});
  db.prepare('INSERT INTO objects VALUES (?,?)').run(blob.hash,blob.byteLength);
  const add=id=>{const value=asset(id);db.prepare('INSERT INTO assets VALUES (?,?)').run(id,JSON.stringify(value));db.prepare('INSERT INTO asset_dependencies VALUES (?,?)').run(id,blob.hash);return value;};
  return {root,db,auth,objects,displays,library,blob,add};
}

test('storage pages stay bounded through more than128 continuations, authenticate cursors and refuse source drift',async t=>{
  const f=await fixture(t);for(let i=0;i<2621;i++)f.add('image_'+String(i).padStart(5,'0'));
  const other={...f.auth,clientId:'other',sessionHash:'b'.repeat(64)};f.db.prepare('INSERT INTO client_bindings VALUES (?,?,?)').run(other.sessionHash,other.clientId,other.expires);
  const first=validateStorageAssetPage(f.library.assets('originals',null,f.auth));assert.equal(first.items.length,20);assert.equal(first.items[0].recordedAvailability,'available');assert.equal(first.items[0].availability,'missing');assert.equal(first.items[0].availabilityScope,'primary-object-only');
  assert.ok(Buffer.byteLength(JSON.stringify(first))<60*1024);
  assert.throws(()=>f.library.assets('originals',first.nextCursor,other),{code:'OFFSET_MISMATCH'});
  let total=first.items.length,page=first,pages=1;const ids=new Set(first.items.map(a=>a.id));
  while(page.nextCursor){page=validateStorageAssetPage(f.library.assets('originals',page.nextCursor,f.auth));assert.ok(page.items.length<=20);for(const item of page.items){assert.ok(!ids.has(item.id));ids.add(item.id);}total+=page.items.length;pages++;}
  assert.equal(total,2621);assert.ok(pages>128);
  const changed=f.library.assets('originals',null,f.auth);f.db.prepare('INSERT INTO queue_jobs VALUES (?,?)').run('job',JSON.stringify({assetId:'image_00000'}));
  assert.throws(()=>f.library.assets('originals',changed.nextCursor,f.auth),{code:'OFFSET_MISMATCH'});
  const stale=f.library.assets('originals',null,f.auth);f.db.prepare("UPDATE meta SET value='1' WHERE key='highWater'").run();
  assert.throws(()=>f.library.assets('originals',stale.nextCursor,f.auth),{code:'OFFSET_MISMATCH'});
  assert.throws(()=>f.library.summary({...f.auth,expires:Date.now()-1}),{code:'OWNER_REQUIRED'});
  f.db.prepare('DELETE FROM client_bindings WHERE cookie_hash=?').run(f.auth.sessionHash);
  assert.throws(()=>f.library.summary(f.auth),{code:'OWNER_REQUIRED'});
});

test('logical accounting deduplicates shared category objects and keeps unmeasured scopes explicit',async t=>{
  const f=await fixture(t);f.add('one');f.add('two');
  const summary=validateStorageSummary(f.library.summary(f.auth)),originals=summary.categories.find(c=>c.id==='originals');
  assert.equal(originals.assetCount,2);assert.equal(originals.objectCount,1);assert.equal(originals.knownBytes,'17');
  assert.equal(summary.registeredObjects.knownBytes,'17');assert.equal(summary.appPhysicalBytes,null);
  assert.equal(summary.categories.find(c=>c.id==='datasets').complete,false);
  assert.equal(summary.categories.find(c=>c.id==='history').complete,false);
  assert.ok(BigInt(summary.filesystem.totalBytes)>=BigInt(summary.filesystem.availableBytes));
  assert.throws(()=>validateStorageSummary({...summary,appPhysicalBytes:'17'}),/STORAGE_RESPONSE/);
});

test('dependency pages retain missing secondary objects and distinguish exact IDs from shared bytes',async t=>{
  const f=await fixture(t),a=f.add('chosen'),secondary={...f.blob,hash:'sha256:'+'2'.repeat(64),byteLength:'12',mediaType:'application/x-ideogram-rgba8'};
  a.dependencies=[secondary];f.db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify(a),a.id);
  f.db.prepare('INSERT INTO objects VALUES (?,?)').run(secondary.hash,secondary.byteLength);
  f.db.prepare('INSERT INTO asset_dependencies VALUES (?,?)').run(a.id,secondary.hash);
  f.db.prepare('INSERT INTO documents VALUES (?,?)').run('doc',JSON.stringify({assetId:a.id}));
  f.db.prepare('INSERT INTO roots VALUES (?,?,?)').run('history-command:shared',secondary.hash,secondary.mediaType);
  f.db.prepare('INSERT INTO snapshot_roots VALUES (?,?,?,?)').run('snap','checkpoint:old',secondary.hash,secondary.mediaType);
  f.db.prepare('INSERT INTO portable_pins VALUES (?,?,?)').run('copy',secondary.hash,secondary.mediaType);
  f.db.prepare('INSERT INTO deletion_backup_pins VALUES (?)').run(secondary.hash);
  const items=[];let cursor=null;do{const page=validateStorageDependencyPage(f.library.dependencies(a.id,cursor,f.auth));items.push(...page.items);cursor=page.nextCursor;}while(cursor);
  assert.equal(items.find(i=>i.kind==='object'&&i.ref.hash===secondary.hash).availability,'missing');
  assert.equal(items.find(i=>i.id==='documents:doc').relation,'asset-reference');
  assert.equal(items.find(i=>i.label==='history-command:shared').relation,'shared-dependency-root');
  for(const label of ['snapshot:snap:checkpoint:old','portable:copy','migration-backup'])assert.equal(items.find(i=>i.label===label).relation,'shared-dependency-root');
  assert.throws(()=>validateStorageDependencyPage({...f.library.dependencies(a.id,null,f.auth),items:Array(21).fill(items[0])}),/STORAGE_RESPONSE/);
});

test('actual HTTP storage routes preserve authentication, mutation CSRF and strict registered scope',async t=>{
  const f=await setup(t),summary=await f.read('/api/v1/storage');assert.equal(summary.status,200,summary.text);validateStorageSummary(summary.json);
  assert.equal((await call(f.server.origin,'/api/v1/storage',{headers:readHeaders('')})).status,401);
  const body={protocolVersion:1,scope:STORAGE_CLEAR_SCOPE},headers=mutationHeaders(f.server,f.paired);delete headers['X-App-CSRF'];
  assert.notEqual((await call(f.server.origin,'/api/v1/storage/preview-cache/clear',{method:'POST',body,headers})).status,200);
  assert.equal((await f.post('/api/v1/storage/preview-cache/clear',{...body,scope:'all'})).status,400);
  const cleared=await f.post('/api/v1/storage/preview-cache/clear',body);assert.equal(cleared.status,200,cleared.text);validateStorageCacheClearResult(cleared.json);
  assert.equal(cleared.json.removedEntries,0);assert.equal(cleared.json.untrackedScope,'retained-not-enumerated');
  assert.equal((await f.read('/api/v1/storage/assets?category=unknown')).status,400);
});


test('All registered assets discovers fonts, native text and metadata outside raster category filters',async t=>{
  const f=await fixture(t);
  for(const [id,purpose,qualification] of [['font','font','font'],['native-text','text','pending-text'],['metadata','caption','opaque-text']]){
    const a=f.add(id);a.purpose=purpose;a.qualification=qualification;f.db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify(a),id);
  }
  const summary=validateStorageSummary(f.library.summary(f.auth));
  assert.equal(summary.categories[0].id,'all');assert.equal(summary.categories[0].label,'All registered assets');assert.equal(summary.categories[0].assetCount,3);
  const all=validateStorageAssetPage(f.library.assets('all',null,f.auth));assert.deepEqual(all.items.map(a=>a.id),['font','metadata','native-text']);
  assert.deepEqual(f.library.assets('originals',null,f.auth).items,[]);
  assert.equal(all.items.find(a=>a.id==='font').purpose,'font');
});

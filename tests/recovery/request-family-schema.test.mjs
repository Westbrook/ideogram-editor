import {ownTestRoot} from '../../tooling/qualification/owned-test-roots.mjs';
import {installSchema18Packet} from './schema18-packet.mjs';
// STAGED SOURCE ONLY. Retain schema18 activation assertions when promoting schema19, build once, then run through the
// coordinated no-network gate. No execution or rollback-packet qualification
// is asserted by the presence of this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile,readdir,mkdir,cp,rename} from 'node:fs/promises';
import {priorWriter} from '../text-state/prior-writer.mjs';
import {rootFor,encode} from '../store/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {assertRequestFamilyMigrationReady,assertV45LegacyCompatibility,REQUEST_FAMILY_SCHEMA17_EXECUTABLE} from '../../dist/local/server/storage/schema.js';

const priorCommit='5650326b623d4aa2080772307708aa9f1854aa52';
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
let old,queue;
test.before(async t=>{old=await priorWriter(t,priorCommit);queue=await import(pathToFileURL(join(old.directory,'tests/queue/helpers.mjs')).href);});
function inspect(root){
 const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
 try{return {version:db.prepare('PRAGMA user_version').get().user_version,integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,
 migrations:db.prepare('SELECT version,receipt FROM schema_migrations ORDER BY version').all(),
 commands:db.prepare('SELECT * FROM commands ORDER BY id').all(),events:db.prepare('SELECT * FROM events_v2 ORDER BY seq').all(),
 uiReceipts:db.prepare('SELECT * FROM ui_receipts ORDER BY client_id,id').all(),queueJournal:db.prepare('SELECT * FROM queue_journal ORDER BY seq').all(),
 history:db.prepare('SELECT * FROM history ORDER BY document_id,id').all()};}finally{db.close();}
}
async function seed(t){
 const root=await rootFor(t),writer=await old.openWriter({root});let queued;
 try{await writer.protocolDefaults();await writer.rememberClient(queue.auth().sessionHash,'client_1',Date.now()+3600000);
 assert.equal((await writer.submit(encode(queue.command(queue.EMPTY_EXPECTED_VERSIONS,{}, {width:512,height:512})),writer.epoch)).status,'accepted');
 queued=await queue.enqueue(writer,(await queue.prepare(writer,d=>{d.fields.seed='9007199254740993';})).body);
 }finally{await writer.close();}
 const refs=[queued.job.review.prompt,queued.job.review.template],bytes=await Promise.all(refs.map(ref=>readFile(objectPath(root,ref))));
 assert.equal(inspect(root).version,16);return {root,queued,refs,bytes,before:inspect(root)};
}
function assertObservations(after,before){for(const key of ['commands','events','uiReceipts','queueJournal','history'])assert.deepEqual(after[key],before[key],key);assert.equal(after.integrity,'ok');}
async function proveBytes(f){for(const [i,ref]of f.refs.entries()){const actual=await readFile(objectPath(f.root,ref));assert.deepEqual(actual,f.bytes[i]);assert.equal(hash(actual),ref.hash);}}
function paused(root,phase){
 const gate=new SharedArrayBuffer(4);let reached,fail,timer;
 const barrier=new Promise((resolve,reject)=>{reached=resolve;fail=reject;timer=setTimeout(()=>reject(Error('Missing '+phase)),15000);});
 const opening=openWriter({root},{phase,gate,onBarrier:actual=>{clearTimeout(timer);assert.equal(actual,phase);reached();}});
 opening.catch(error=>{clearTimeout(timer);fail(error);});
 return {opening,barrier,release(){Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);}};
}

test('accepted schema16 activates18 atomically, retains true16 rollback, refuses old writer and restores exact V4 state',async t=>{
 const f=await seed(t);await installSchema18Packet(f.root);const p=paused(f.root,'p2-semantic-schema-after-activation');let receipt,manifest;
 try{await p.barrier;const state=inspect(f.root);assert.equal(state.version,18);assertObservations(state,f.before);
 const p17=JSON.parse(state.migrations.find(row=>row.version===17).receipt);receipt=JSON.parse(state.migrations.find(row=>row.version===18).receipt);
 assert.equal(receipt.capability,'editor-contracts-18-v1');assert.equal(receipt.rollback.storageVersion,16);assert.equal(receipt.rollback.compatibleExecutable,priorCommit);
 assert.equal(receipt.backup,p17.backup);assert.match(receipt.backup,/^schema16-backup-/);assert.equal(receipt.rollback.kind,'inherited-schema-migration');
 assert(!(await readdir(f.root)).some(name=>name.startsWith('schema17-backup-')));
 const backup=await readFile(join(f.root,receipt.backup));assert.equal(hash(backup),receipt.backupHash);
 const manifestBytes=await readFile(join(f.root,receipt.manifestFile));assert.equal(hash(manifestBytes),receipt.rollback.manifestHash);manifest=JSON.parse(manifestBytes);
 assert.equal(manifest.storageVersion,16);assert.equal(manifest.compatibleExecutable,priorCommit);await proveBytes(f);
 }finally{p.release();const writer=await p.opening;try{assert.equal(inspect(f.root).version,19);}finally{await writer.close();}}
 // Inspect after current-writer close, before the refusal snapshot, as in the
 // p2 fixture. Frozen 5650326 directly opens SQLite and can create WAL/SHM on
 // an uninspected closed root; this assertion covers an already-inspected root.
 const refusalState=inspect(f.root),names=(await readdir(f.root)).sort();
 assert.equal(refusalState.version,19);
 const sqliteNames=['metadata.sqlite','metadata.sqlite-shm','metadata.sqlite-wal'];
 for(const name of sqliteNames)assert(names.includes(name),'Inspected fixture contains '+name);
 const priorBytes=await Promise.all(sqliteNames.map(name=>readFile(join(f.root,name))));
 await assert.rejects(old.openWriter({root:f.root}),{code:'UNSUPPORTED_STORAGE'});
 assert.deepEqual((await readdir(f.root)).sort(),names);
 for(const [i,name]of sqliteNames.entries())assert.deepEqual(await readFile(join(f.root,name)),priorBytes[i],name+' unchanged through historical refusal');
 assert.deepEqual(inspect(f.root),refusalState);await proveBytes(f);
 const archive=join(await rootFor(t),'upgraded');await rename(f.root,archive);await mkdir(f.root,{mode:0o700});
 // The archive remains beneath its owned parent; the original path now has a
 // deliberately created new directory identity, as in the p2 restore fixture.
 ownTestRoot(f.root);
 await cp(join(archive,'objects'),join(f.root,'objects'),{recursive:true});
 for(const [directory,copy]of Object.entries(manifest.retainedDirectoryCopies))await cp(join(archive,copy),join(f.root,directory),{recursive:true});
 await writeFile(join(f.root,'metadata.sqlite'),await readFile(join(archive,receipt.backup)),{mode:0o600});
 assert.deepEqual(inspect(f.root),f.before);const restored=await old.openWriter({root:f.root});
 try{assert.deepEqual((await restored.queueView()).jobs,[f.queued.job]);assert.deepEqual(await restored.queueCommand(encode(f.queued.request),queue.auth()),f.queued.receipt);await proveBytes(f);}
 finally{await restored.close();}
});

async function killAt(t,root,phase){
 await installSchema18Packet(root);
 const script=join(await rootFor(t),'schema18-kill.mjs');
 await writeFile(script,`import {openWriter} from ${JSON.stringify(new URL('../../dist/local/server/storage/writer.js',import.meta.url).href)};\nawait openWriter({root:process.argv[2]},{phase:process.argv[3],gate:new SharedArrayBuffer(4),onBarrier:phase=>process.send({phase})});\n`);
 const child=fork(script,[root,phase],{execArgv:['--import',resolve('tests/store/no-network.mjs')],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc']}),ended=once(child,'exit');let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(stderr||'Missing barrier')),15000);child.once('message',message=>{clearTimeout(timer);message.phase===phase?resolve():reject(Error('Wrong phase'));});child.once('exit',()=>{clearTimeout(timer);reject(Error(stderr||'Early exit'));});});}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;}
}
for(const suffix of ['before-activation','after-activation'])test('schema16 chain crash at '+suffix+' never strands root at17',async t=>{
 const f=await seed(t);await killAt(t,f.root,'p2-semantic-schema-'+suffix);const after=inspect(f.root);
 assert.equal(after.version,suffix==='before-activation'?16:18);assertObservations(after,f.before);await proveBytes(f);
 const writer=await openWriter({root:f.root});try{
  assert.equal(inspect(f.root).version,19);
  // Only completed current-writer startup initializes durable queue order;
  // the activation-barrier and restored old-writer comparisons stay exact.
  assert.equal(f.queued.job.version,'1');
  assert.deepEqual((await writer.queueView()).jobs,[{...f.queued.job,
   version:'2',order:{position:'1',insertionOrdinal:'1',origin:'accepted-event'},
   ownerClientId:f.queued.request.command.clientId,
  }]);
  await proveBytes(f);
 }finally{await writer.close();}
});

test('existing17 requires actual sealed executable rather than invented source identity',async t=>{
 const root=await rootFor(t);
 if(REQUEST_FAMILY_SCHEMA17_EXECUTABLE===null)assert.throws(()=>assertRequestFamilyMigrationReady(17,root),{code:'UNSUPPORTED_STORAGE'});
 else await assert.rejects(Promise.resolve().then(()=>assertRequestFamilyMigrationReady(17,root)));
 for(const version of [0,1,16,18])assert.doesNotThrow(()=>assertRequestFamilyMigrationReady(version,root));
});

const futureMarkers=[
 {kind:'request-draft-v45-1'},{kind:'request-review-v45-1'},{kind:'v45-edit-inputs-1'},{kind:'v45-edit-mask-v1'},{type:'PrepareV45EditInputs'},{request:{kind:'generate-v45'}},{request:{kind:'transform-v45'}},
 {endpoint:'ideogram/v4.5/edit'},{providerReview:{contract:'fal-ideogram-v45-edit-1'}},{protocolVersion:1,formatVersion:10,documentSchema:10},
 {inputs:{encodedRebuild:{kind:'encoded-adoption-inputs-1'}}},{codec:'r16le-deflate-v1'},
 {mediaType:'application/x-ideogram-r16le-deflate'},{type:'ReviewCandidatePlacement',preparation:'encoded-rebuild'},
];
for(const value of futureMarkers)test('readonly semantic fence detects '+JSON.stringify(value),async t=>{
 const root=await rootFor(t),path=join(root,'metadata.sqlite');let db=new DatabaseSync(path);db.exec('CREATE TABLE image_edit_reviews(json TEXT NOT NULL) STRICT; PRAGMA user_version=17');db.prepare('INSERT INTO image_edit_reviews VALUES (?)').run(JSON.stringify(value));db.close();
 const before=await readFile(path),names=await readdir(root);db=new DatabaseSync(path,{readOnly:true});
 try{assert.throws(()=>assertV45LegacyCompatibility(db,root),{code:'UNSUPPORTED_STORAGE'});}finally{db.close();}
 assert.deepEqual(await readFile(path),before);assert.deepEqual(await readdir(root),names);
});

test('typed saved-draft reference fences V45; same unattached caption bytes remain ordinary',async t=>{
 const root=await rootFor(t),bytes=Buffer.from('{"kind":"request-draft-v45-1"}'),ref={hash:hash(bytes),byteLength:String(bytes.length),mediaType:'text/plain'},path=objectPath(root,ref);
 await mkdir(join(root,'objects'),{mode:0o700});await mkdir(join(root,'objects','sha256'),{mode:0o700});await mkdir(join(root,'objects','sha256',ref.hash.slice(7,9)),{mode:0o700});await writeFile(path,bytes,{mode:0o600});
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT; CREATE TABLE ui_receipts(json TEXT NOT NULL) STRICT');db.prepare('INSERT INTO assets VALUES (?,?)').run('caption_1',JSON.stringify({id:'caption_1',purpose:'caption',blob:ref}));
 try{assert.doesNotThrow(()=>assertV45LegacyCompatibility(db,root));db.prepare('INSERT INTO ui_receipts VALUES (?)').run(JSON.stringify({draft:{kind:'request',assetId:'caption_1'}}));assert.throws(()=>assertV45LegacyCompatibility(db,root),{code:'UNSUPPORTED_STORAGE'});assert.deepEqual(await readFile(path),bytes);}finally{db.close();}
});

test('insufficient migration capacity leaves accepted16 state and V4 object bytes unchanged',async t=>{
 const f=await seed(t);await installSchema18Packet(f.root);await assert.rejects(openWriter({root:f.root,quotaBytes:'1'}),{code:'CAPACITY'});
 assert.deepEqual(inspect(f.root),f.before);await proveBytes(f);
 assert(!(await readdir(f.root)).some(name=>name.startsWith('schema16-backup-')||name.startsWith('schema17-backup-')));
});

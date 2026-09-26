import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, fork} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,symlink,cp,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {rootFor} from '../store/helpers.mjs';
import {digest} from './helpers.mjs';
const dfa='dfa383d56d21bc9c7bb40248db8a503fe33e6e46', correction='7388d1e625a6ac2c563bc64cca6318d264649acc';
const noEgress=resolve('tests/session/no-egress.mjs');
const executables=new Map();
const pause=()=>new Promise(r=>setTimeout(r,5));
const release=gate=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);};
function inspect(root){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{
 const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(x=>x.name);
 return {version:db.prepare('PRAGMA user_version').get().user_version,tables:Object.fromEntries(tables.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY 1,2').all().map(row=>({...row}))]))};
}finally{db.close();}}
async function bytes(root){const result={};async function visit(dir){for(const f of await readdir(join(root,dir),{withFileTypes:true})){const path=join(dir,f.name);if(f.isDirectory())await visit(path);else result[path]=digest(await readFile(join(root,path)));}}await visit('objects');return result;}
async function preserved(root,before){for(const [path,hash] of Object.entries(before))assert.equal(digest(await readFile(join(root,path))),hash,path);}
function sameTables(actual,before,except=[]){for(const [name,rows] of Object.entries(before.tables))if(!except.includes(name))assert.deepEqual(actual.tables[name],rows,name);}
async function settled(w,id){for(let i=0;i<1000;i++){const s=await w.commandState(id);if(s.record)return s.record;await pause();}throw Error('pending did not settle');}
const seedScript=String.raw`
import {openWriter} from './dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from './dist/local/src/protocol/store.js';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
const [root,fixture,approval]=process.argv.slice(2),w=await openWriter({root});
const auth={clientId:'client_1',sessionHash:'d'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
const command=body=>({protocolVersion:1,command:{schemaVersion:1,commandId:randomUUID(),clientId:auth.clientId,sessionId:'session_1',correlationId:'correlation_1',causationId:null,transactionId:randomUUID(),documentId:null,expectedDocumentRevision:null,expectedEntityVersions:EMPTY_EXPECTED_VERSIONS,issuedAt:'2026-09-26T03:00:00.000Z',body}});
const enc=c=>Buffer.from(JSON.stringify(c)),hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
async function finish(c,kind='rasterCommand'){let r=await w[kind](enc(c),auth);for(let i=0;!r&&i<1000;i++){r=(await w.commandState(c.command.commandId)).record?.receipt;await new Promise(r=>setTimeout(r,5));}if(r?.status!=='accepted')throw Error(JSON.stringify(r));return (await w.events(String(BigInt(r.fromSeq)-1n))).events[0].payload;}
try{
 await w.protocolDefaults();await w.rememberClient(auth.sessionHash,auth.clientId,auth.expires);
 const doc=command({type:'NewDocument',width:10,height:10,color:'sRGB',depth:8});doc.command.documentId='document_1';const receipt=await w.submit(enc(doc),w.epoch);
 const data=await readFile(fixture),s={protocolVersion:1,stagingId:randomUUID(),purpose:'image',expectedBytes:String(data.length),sha256:hash(data),mediaType:'image/png'};
 await w.assetCreate(s,auth);const token=await w.assetBeginChunk(s.stagingId,'0',data.length,auth);await w.assetChunk(token,data,auth);
 const input=(await finish(command({type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}),'assetCommand')).asset;
 const preview=(await finish(command({type:'PrepareRaster',assetId:input.id}))).asset;
 const review=await finish(command({type:'ReviewRaster',assetId:preview.id}));
 for(let i=0;i<2;i++){const id=randomUUID();await w.assetCreate({protocolVersion:1,stagingId:id,purpose:'caption',expectedBytes:'1',sha256:hash('x'),mediaType:'text/plain'},auth);await w.assetBeginChunk(id,'0',1,auth);}
 const c=command(approval==='approval'?{type:'ApproveRaster',assetId:preview.id,reviewId:review.reviewId,reviewHash:review.reviewHash}:{type:'PrepareRaster',assetId:input.id});
 if(await w.rasterCommand(enc(c),auth)!==null)throw Error('expected durable pending command');const pending=(await w.commandState(c.command.commandId)).pending;
 console.log(JSON.stringify({command:c,pending,doc,receipt,input,preview}));
}finally{await w.close();}
`;
async function build(t,commit){const dir=await rootFor(t),archive=execFileSync('git',['archive',commit,'server','src','tooling','tsconfig.server.json']);await writeFile(join(dir,'source.tar'),archive,{mode:0o600});execFileSync('tar',['-xf',join(dir,'source.tar'),'-C',dir]);await symlink(resolve('node_modules'),join(dir,'node_modules'));await writeFile(join(dir,'package.json'),'{"type":"module"}');execFileSync(resolve('node_modules/.bin/tsc'),['-p',join(dir,'tsconfig.server.json')]);await writeFile(join(dir,'seed.mjs'),seedScript);await writeFile(join(dir,'open.mjs'),`import {openWriter} from './dist/local/server/storage/writer.js'; let w;try{w=await openWriter({root:process.argv[2]});const id=process.argv[3];let s;for(let i=0;i<1000;i++){s=await w.commandState(id);if(s.record)break;await new Promise(r=>setTimeout(r,5));}console.log(JSON.stringify({epoch:w.epoch,state:s}));}catch(e){console.log(JSON.stringify({code:e.code}));}finally{if(w)await w.close();}`);return dir;}
test.before(async t=>{for(const commit of [dfa,correction])executables.set(commit,await build(t,commit));});
async function seed(t,approval){const root=await rootFor(t),old=executables.get(approval?correction:dfa);const value=JSON.parse(execFileSync(process.execPath,['--import',noEgress,join(old,'seed.mjs'),root,resolve('tests/raster/fixtures/orientation-6.png'),approval?'approval':'ordinary'],{encoding:'utf8'}));return {root,...value};}
function oldOpen(commit,root,id){return JSON.parse(execFileSync(process.execPath,['--import',noEgress,join(executables.get(commit),'open.mjs'),root,id],{encoding:'utf8'}));}
async function rollback(t,root,migration){const out=await rootFor(t);for(const dir of ['objects','staging','uploads'])await cp(join(root,dir),join(out,dir),{recursive:true});await writeFile(join(out,'metadata.sqlite'),await readFile(join(root,migration.backup)),{mode:0o600});return out;}
for(const approval of [false,true])test('schema5 preserves '+(approval?'7388d1e pending approval':'dfa383d compatible schema4')+' and names an actually usable rollback executable',async t=>{
 const f=await seed(t,approval),before=inspect(f.root),originals=await bytes(f.root),gate=new SharedArrayBuffer(4);assert.equal(before.version,4);
 let reached;const barrier=new Promise(r=>reached=r),opening=openWriter({root:f.root},{phase:'approval-schema-after-activation',gate,onBarrier:reached});
 await barrier;
 let migration;try{const after=inspect(f.root);assert.equal(after.version,5);sameTables(after,before,['schema_migrations']);assert.deepEqual(after.tables.schema_migrations.slice(0,-1),before.tables.schema_migrations);
 migration=JSON.parse(after.tables.schema_migrations.at(-1).receipt);assert.equal(migration.capability,'raster-pending-approval-v1');assert.equal(migration.rollback.compatibleExecutable,approval?correction:dfa);assert.equal(migration.rollback.pendingApprovals,approval?1:0);
 const manifest=JSON.parse(await readFile(join(f.root,migration.manifestFile)));assert.equal(manifest.backupHash,digest(await readFile(join(f.root,migration.backup))));assert.equal(manifest.compatibleExecutable,migration.rollback.compatibleExecutable);
 const backup=new DatabaseSync(join(f.root,migration.backup),{readOnly:true});try{assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');for(const [name,rows]of Object.entries(before.tables))assert.deepEqual(backup.prepare('SELECT * FROM '+name+' ORDER BY 1,2').all().map(x=>({...x})),rows,name);}finally{backup.close();}
 await preserved(f.root,originals);
 }finally{release(gate);}
 const w=await opening;try{const result=await settled(w,f.command.command.commandId);assert.equal(result.receipt.status,approval?'rejected':'accepted');assert.deepEqual(result.command,f.command.command);assert.equal(result.hash,f.pending.hash);if(approval){const b=await w.readMetadata(result.receipt.details);assert.equal(JSON.parse(Buffer.from(b)).issues[0].code,'RASTER_REVIEW_EXPIRED');}assert.deepEqual((await w.lookup(f.doc.command.commandId)).receipt,f.receipt);}finally{await w.close();}
 const protectedState=inspect(f.root);for(const old of [dfa,correction]){assert.deepEqual(oldOpen(old,f.root,f.command.command.commandId),{code:'CORRUPT_STORE'});assert.deepEqual(inspect(f.root),protectedState);await preserved(f.root,originals);}
 const restored=await rollback(t,f.root,migration);const oldResult=oldOpen(migration.rollback.compatibleExecutable,restored,f.command.command.commandId);assert.equal(oldResult.state.record.receipt.status,approval?'rejected':'accepted');assert.equal(oldResult.state.record.hash,f.pending.hash);assert.deepEqual(oldResult.state.record.command,f.command.command);await preserved(restored,originals);
 t.diagnostic(JSON.stringify({case:approval?'existing-7388d1e-approval':'compatible-dfa383d',pending:f.pending,originalCommand:f.command,migration,originalHashes:originals,oldWriterRefusals:[dfa,correction],rollbackResult:oldResult}));
 const reopened=await openWriter({root:f.root});assert.deepEqual((await reopened.lookup(f.doc.command.commandId)).receipt,f.receipt);await reopened.close();
});
test('unknown future storage is inspected without mutation and returns explicit recovery guidance',async t=>{
 const f=await seed(t,false),db=new DatabaseSync(join(f.root,'metadata.sqlite'));db.exec('PRAGMA user_version=999');db.close();const before=inspect(f.root),originals=await bytes(f.root),databaseHash=digest(await readFile(join(f.root,'metadata.sqlite')));
 await assert.rejects(openWriter({root:f.root}),e=>e.code==='UNSUPPORTED_STORAGE'&&e.detail.issues[0].code==='USE_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP');assert.deepEqual(inspect(f.root),before);assert.equal(digest(await readFile(join(f.root,'metadata.sqlite'))),databaseHash);await preserved(f.root,originals);
});
test('schema5 capacity failure retains schema4 and every request, then retries safely',async t=>{
 const f=await seed(t,true),before=inspect(f.root);await assert.rejects(openWriter({root:f.root,quotaBytes:'1'}),{code:'CAPACITY'});assert.deepEqual(inspect(f.root),before);
 const w=await openWriter({root:f.root});assert.equal((await settled(w,f.command.command.commandId)).receipt.status,'rejected');await w.close();assert.equal(inspect(f.root).version,6);
});
test('backup corruption fails verification before activation, retains evidence, and retries without changing requests',async t=>{
 const f=await seed(t,true),before=inspect(f.root),gate=new SharedArrayBuffer(4);let reached;const barrier=new Promise(r=>reached=r),opening=openWriter({root:f.root},{phase:'approval-schema-backup-written',gate,onBarrier:reached});const rejected=assert.rejects(opening,{code:'CORRUPT_STORE'});await barrier;
 const name=(await readdir(f.root)).find(x=>/^schema4-backup-.*\.sqlite$/.test(x));const db=new DatabaseSync(join(f.root,name));db.prepare("UPDATE meta SET value='999' WHERE key='writerEpoch'").run();db.close();release(gate);await rejected;assert.deepEqual(inspect(f.root),before);
 const failedHash=digest(await readFile(join(f.root,name))),w=await openWriter({root:f.root});await settled(w,f.command.command.commandId);await w.close();assert.equal(digest(await readFile(join(f.root,name))),failedHash);assert.equal(inspect(f.root).version,6);
});
for(const target of ['database','manifest'])test('activation rechecks the verified '+target+' backup before publishing schema5',async t=>{
 const f=await seed(t,true),before=inspect(f.root),gate=new SharedArrayBuffer(4);let reached;const barrier=new Promise(r=>reached=r),opening=openWriter({root:f.root},{phase:'approval-schema-before-activation',gate,onBarrier:reached});const rejected=assert.rejects(opening,{code:'CORRUPT_STORE'});await barrier;
 const name=(await readdir(f.root)).find(x=>target==='database'?/^schema4-backup-.*\.sqlite$/.test(x):x.endsWith('.manifest.json'));
 if(target==='database'){const db=new DatabaseSync(join(f.root,name));db.prepare("UPDATE meta SET value='999' WHERE key='writerEpoch'").run();db.close();}else await writeFile(join(f.root,name),'{}');
 release(gate);await rejected;assert.deepEqual(inspect(f.root),before);
 const w=await openWriter({root:f.root});assert.equal((await settled(w,f.command.command.commandId)).receipt.status,'rejected');await w.close();
});
async function killedMigration(t,root,phase){const dir=await rootFor(t),file=join(dir,'kill.mjs');await writeFile(file,`import{openWriter}from ${JSON.stringify(new URL('../../dist/local/server/storage/writer.js',import.meta.url).href)}; await openWriter({root:process.argv[2]},{phase:process.argv[3],gate:new SharedArrayBuffer(4),onBarrier:phase=>process.send({phase})});`);const child=fork(file,[root,phase],{execArgv:['--import',noEgress],stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr.on('data',b=>errors+=b);const ended=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('migration barrier timeout '+errors)),10000);child.once('message',m=>{clearTimeout(timer);assert.equal(m.phase,phase);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(Error('early exit '+errors));});});child.kill('SIGKILL');await ended;}
for(const phase of ['approval-schema-before-backup','approval-schema-backup-written','approval-schema-backup-verified','approval-schema-before-activation','approval-schema-after-activation'])test('SIGKILL '+phase+' preserves pending approval and restarts exactly',async t=>{
 const f=await seed(t,true),before=inspect(f.root),originals=await bytes(f.root);await killedMigration(t,f.root,phase);const interrupted=inspect(f.root),activated=phase.endsWith('after-activation');assert.equal(interrupted.version,activated?5:4);sameTables(interrupted,before,activated?['schema_migrations']:[]);await preserved(f.root,originals);
 const saved=Object.fromEntries(await Promise.all((await readdir(f.root)).filter(x=>x.startsWith('schema4-backup-')).map(async n=>[n,digest(await readFile(join(f.root,n)))])));
 const w=await openWriter({root:f.root});const result=await settled(w,f.command.command.commandId);assert.equal(result.receipt.status,'rejected');assert.equal(result.hash,f.pending.hash);assert.deepEqual(result.command,f.command.command);await w.close();for(const [n,hash]of Object.entries(saved))assert.equal(digest(await readFile(join(f.root,n))),hash);await preserved(f.root,originals);
});

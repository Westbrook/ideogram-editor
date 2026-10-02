/** Actual compiled validators; synthetic descriptors never grant authority. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {assertRequestFamilyMigrationReady} from '../../dist/local/server/storage/schema.js';
import {installedSchema16Maintenance,schema16MaintenanceIdentity,schema16MaintenanceFileProof,copySchema16Maintenance} from '../../dist/local/server/storage/schema16-maintenance.js';

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
async function inventory(root){
  const rows=[];async function visit(path,prefix=''){
    for(const name of (await readdir(path)).sort()){
      const full=join(path,name),s=await stat(full),key=prefix+name;
      if(s.isDirectory()){rows.push([key,'directory',s.mode]);await visit(full,key+'/');}
      else rows.push([key,'file',s.mode,hash(await readFile(full))]);
    }
  }await visit(root);return rows;
}
async function owned(t){const root=await realpath(await mkdtemp(join(tmpdir(),'linux16-authority-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function descriptor(root){
  const file={path:join(root,'rollback-executables','maintenance_fixture','000.sealed'),hash:hash('synthetic'),byteLength:'9'};
  return {kind:'schema16-maintenance-executable-packet-1',storageVersion:16,packetId:'maintenance_fixture',
    compatibilityContract:'schema16-linux-raster-maintenance-1',historicalBase:'5650326b623d4aa2080772307708aa9f1854aa52',
    maintenancePatchHash:'sha256:77f7fddc26a02bc9c4e613de72f47d213fa58bee9846ff84717cdece58214958',sourceIdentity:hash('maintenance source'),
    sourceArchive:file,sourceManifest:file,compiler:{name:'typescript',version:'7.0.2',identity:hash('compiler')},
    toolchain:{node:'26.10.0',npm:'12.1.0',identity:hash('tools')},dependencies:{lockfileHash:hash('lock'),vendorManifestHash:hash('vendor'),identity:hash('dependencies')},
    native:{profileHash:hash('native'),artifactManifestHash:hash('native artifacts')},platform:{os:'linux',arch:process.arch,identity:hash('fixture platform')},
    compiledClosures:[{name:'application-runtime',archive:file,manifest:file},{name:'qualification-evidence',archive:file,manifest:file}],
    verifiedFreshRestore:{receipt:file,sourceArchiveHash:file.hash,compiledClosureHash:hash('invalid synthetic closure'),result:'verified'}};
}
function pinFor(packet){return {kind:'schema16-maintenance-executable-pin-1',storageVersion:16,packetId:packet.packetId,
  compatibilityContract:packet.compatibilityContract,historicalBase:packet.historicalBase,maintenancePatchHash:packet.maintenancePatchHash,
  sourceIdentity:packet.sourceIdentity,identityHash:schema16MaintenanceIdentity(packet),platform:packet.platform};}

test('fresh version0 needs no historical16 rollback authority and creates no backup',async t=>{
  const root=await owned(t),before=await inventory(root);assert.doesNotThrow(()=>assertRequestFamilyMigrationReady(0,root));assert.deepEqual(await inventory(root),before);
});
if(process.platform==='linux')test('existing Linux1..16 refuses missing authority without creating a writable store',async t=>{
  const root=await owned(t);await writeFile(join(root,'untouched-original'),Buffer.from('original'),{mode:0o600});const before=await inventory(root);
  for(let version=1;version<=16;version++)assert.throws(()=>assertRequestFamilyMigrationReady(version,root),error=>error.code==='UNSUPPORTED_STORAGE');
  assert.deepEqual(await inventory(root),before);
});
for(const kind of ['absent','platform','schema','contract','historical-base','patch'])test('maintenance authority refuses '+kind+' before file access',async t=>{
  const root=await owned(t),packet=descriptor(root),pin=pinFor(packet),before=await inventory(root);
  if(kind==='platform')pin.platform={...pin.platform,os:'darwin'};
  if(kind==='schema')pin.storageVersion=17;
  if(kind==='contract')pin.compatibilityContract='unknown-maintenance-contract';
  if(kind==='historical-base')pin.historicalBase='0'.repeat(40);
  if(kind==='patch')pin.maintenancePatchHash=hash('different patch');
  assert.throws(()=>installedSchema16Maintenance(root,kind==='absent'?null:pin),error=>error.code==='UNSUPPORTED_STORAGE');
  assert.deepEqual(await inventory(root),before);
});
if(process.platform==='linux')test('exact packet pin cannot relabel another maintenance source',async t=>{
  const root=await owned(t),packet=descriptor(root),pin=pinFor(packet);pin.sourceIdentity=hash('other source');
  const directory=join(root,'rollback-executables',packet.packetId);await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,'packet.json'),JSON.stringify(packet),{mode:0o600});const before=await inventory(root);
  assert.throws(()=>installedSchema16Maintenance(root,pin),error=>error.code==='CORRUPT_STORE');assert.deepEqual(await inventory(root),before);
});

// Synthetic descriptor only exercises negative filesystem cleanup. It is never
// installed, selected by a registry, or represented as executable qualification.
async function copyDescriptor(root){
  const packet=descriptor(root),file={path:join(root,'source.sealed'),hash:hash('source'),byteLength:'6'};
  await writeFile(file.path,'source',{mode:0o600});packet.sourceArchive=file;packet.sourceManifest=file;
  packet.compiledClosures=packet.compiledClosures.map(row=>({...row,archive:file,manifest:file}));
  const closures=packet.compiledClosures.map(row=>({name:row.name,archive:{hash:row.archive.hash,byteLength:row.archive.byteLength},manifest:{hash:row.manifest.hash,byteLength:row.manifest.byteLength}}));
  const {canonical}=await import('../../dist/local/server/storage/canonical.js');
  const compiledClosureHash=hash(canonical(closures));
  const receipt={kind:'schema16-maintenance-fresh-restore-1',storageVersion:16,result:'verified',sourceArchiveHash:file.hash,compiledClosureHash,
    toolchainIdentity:packet.toolchain.identity,dependencyIdentity:packet.dependencies.identity,nativeProfileHash:packet.native.profileHash,platformIdentity:packet.platform.identity,
    checks:{freshRestore:true,openExistingSchema16:true,replayByteIdentity:true,nativeRasterInitialized:true,independentPixelGoldens:true,futureSchemaRefusal:true,networkEffects:0},evidence:{syntheticCleanupFixture:true}};
  const bytes=Buffer.from(canonical(receipt)),proof={path:join(root,'receipt.json'),hash:hash(bytes),byteLength:String(bytes.length)};
  await writeFile(proof.path,bytes,{mode:0o600});packet.verifiedFreshRestore={receipt:proof,sourceArchiveHash:file.hash,compiledClosureHash,result:'verified'};return packet;
}
function trackedReads(path,action){
  const originalOpen=fs.openSync,originalClose=fs.closeSync,held=new Set();let reads=0;
  fs.openSync=(...args)=>{const fd=originalOpen(...args);if(args[0]===path){held.add(fd);reads++;}return fd;};
  fs.closeSync=fd=>{const result=originalClose(fd);held.delete(fd);return result;};syncBuiltinESMExports();
  try{action();assert.ok(reads>0,'the actual source descriptor was opened');assert.equal(held.size,0,'every opened source descriptor was closed');}
  finally{for(const fd of held)originalClose(fd);fs.openSync=originalOpen;fs.closeSync=originalClose;syncBuiltinESMExports();}
}
test('file proof closes its source when bounded buffer allocation fails',async t=>{
  const root=await owned(t),path=join(root,'source.sealed');await writeFile(path,'source',{mode:0o600});
  const original=Buffer.alloc,failure=new Error('bounded allocation refused');
  trackedReads(path,()=>{try{Buffer.alloc=size=>{assert.equal(size,1048576);throw failure;};assert.throws(()=>schema16MaintenanceFileProof({path,hash:hash('source'),byteLength:'6'}),error=>error===failure);}
    finally{Buffer.alloc=original;}});
});
if(process.platform==='linux')for(const code of ['EEXIST','ENOSPC'])test('maintenance copy closes source when destination open fails with '+code,async t=>{
  const root=await owned(t),packet=await copyDescriptor(root),destination=join(root,'retained'),target=join(destination,'000.sealed'),failure=Object.assign(new Error('destination refused'),{code});let attempted=false;
  trackedReads(packet.sourceArchive.path,()=>{
    const original=fs.openSync;fs.openSync=(...args)=>{if(args[0]===target){attempted=true;throw failure;}return original(...args);};syncBuiltinESMExports();
    try{assert.throws(()=>copySchema16Maintenance(packet,destination),error=>error===failure);assert.equal(attempted,true,'reached actual destination creation after source verification');}
    finally{fs.openSync=original;syncBuiltinESMExports();}
  });
  assert.equal(await readFile(packet.sourceArchive.path,'utf8'),'source');assert.deepEqual(await readdir(destination),[]);
});

// Darwin does not report skipped Linux requirements as completed qualification.
// Its actual branch proves refusal before access; Linux registers both real
// destination-failure cases and the existing authority/source-negative cases.
if(process.platform!=='linux')test('non-Linux historical preflight does not open a Linux maintenance capsule',async t=>{
  const root=await owned(t),before=await inventory(root),original=fs.openSync;let opened=0;
  fs.openSync=()=>{opened++;throw new Error('unexpected capsule open');};syncBuiltinESMExports();
  try{for(let version=1;version<=16;version++)assert.doesNotThrow(()=>assertRequestFamilyMigrationReady(version,root));assert.equal(opened,0);}
  finally{fs.openSync=original;syncBuiltinESMExports();}
  assert.deepEqual(await inventory(root),before);
});
if(process.platform!=='linux')test('non-Linux installed and copy boundaries refuse Linux authority before opening or writing',async t=>{
  const root=await owned(t),packet=descriptor(root),pin=pinFor(packet),destination=join(root,'must-not-create'),before=await inventory(root),original=fs.openSync;let opened=0;
  fs.openSync=()=>{opened++;throw new Error('unexpected capsule open');};syncBuiltinESMExports();
  try{assert.throws(()=>installedSchema16Maintenance(root,pin),error=>error.code==='UNSUPPORTED_STORAGE');assert.throws(()=>copySchema16Maintenance(packet,destination),error=>error.code==='CORRUPT_STORE');assert.equal(opened,0);}
  finally{fs.openSync=original;syncBuiltinESMExports();}
  assert.deepEqual(await inventory(root),before);
});

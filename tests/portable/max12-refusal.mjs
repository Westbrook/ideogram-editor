import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open,lstat,realpath,readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedChild} from '../../tooling/qualification/container/bounded-child.mjs';

const keys=['IE_PORTABLE_MAX12_RECEIPT','IE_PORTABLE_MAX12_RECEIPT_SHA256','IE_PORTABLE_MAX12_FINALIZATION','IE_PORTABLE_MAX12_FINALIZATION_SHA256'];
const formatSourceHash='63c436a409d91c5b357c9ce9454607af0af16c7b5643984d26f8e142e8aee473';
const nodeRelative='.toolchain/node-v26.10.0-darwin-arm64/bin/node';
const sourceRelative='server/portable/format.ts';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,path)=>path===root||path.startsWith(root+'/');
const fileRef=(path,bytes)=>({path,hash:'sha256:'+sha(bytes),byteLength:String(bytes.length)});
const record=async(path,value)=>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return fileRef(path,bytes);};
const normalized=ref=>'hash' in ref?ref:{path:ref.path,hash:'sha256:'+ref.sha256,byteLength:String(ref.bytes)};
function sameRef(a,b){assert.equal(a.hash,b.hash);assert.equal(a.byteLength,b.byteLength);}
function relativeName(name){assert.equal(typeof name,'string');assert(!isAbsolute(name)&&!name.includes('\\')&&name.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Unsafe retained member');return name;}
async function canonical(path){assert.equal(typeof path,'string');assert(isAbsolute(path)&&resolve(path)===path,'Expected a canonical absolute path');assert.equal(await realpath(path),path,'Symlink or alias in retained path');return path;}
async function identity(path,scratch,{maximum=8589934592n,collect=false}={}){
 await canonical(path);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await handle.stat({bigint:true});assert(before.isFile()&&before.nlink===1n,'Expected single-link regular evidence');
  assert(before.size<=maximum,'Evidence exceeds its byte bound');const digest=createHash('sha256'),parts=[];let total=0;
  for(;;){const {bytesRead}=await handle.read(scratch,0,scratch.length,null);if(!bytesRead)break;digest.update(scratch.subarray(0,bytesRead));total+=bytesRead;assert(BigInt(total)<=maximum,'Evidence grew beyond its byte bound');if(collect)parts.push(Buffer.from(scratch.subarray(0,bytesRead)));}
  const after=await handle.stat({bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'])assert.equal(after[key],before[key],'Evidence changed while reading');assert.equal(BigInt(total),before.size);
  return {path,hash:'sha256:'+digest.digest('hex'),byteLength:String(total),...(collect?{bytes:Buffer.concat(parts)}:{})};
 }finally{await handle.close();}
}
async function reference(ref,scratch,{json=false}={}){
 assert(ref&&typeof ref.path==='string'&&/^sha256:[0-9a-f]{64}$/.test(ref.hash)&&/^(0|[1-9][0-9]*)$/.test(ref.byteLength),'Malformed retained reference');
 const maximum=json?67108864n:8589934592n;assert(BigInt(ref.byteLength)<=maximum,'Retained reference exceeds its byte bound');const actual=await identity(ref.path,scratch,{maximum,collect:json});sameRef(actual,ref);
 return json?JSON.parse(actual.bytes):actual;
}
async function anchored(path,hash,scratch){
 assert(/^[0-9a-f]{64}$/.test(hash),'Root must supply an independent lowercase SHA-256 anchor');
 const {bytes,...ref}=await identity(path,scratch,{maximum:67108864n,collect:true});assert.equal(ref.hash,'sha256:'+hash,'Root-supplied receipt identity differs');return {ref,value:JSON.parse(bytes)};
}
async function runtimeTree(root,original,installed,scratch){
 await canonical(root);const names=Object.keys(original).sort();assert(names.length>0&&names.length<=200000);assert.deepEqual(Object.keys(installed).sort(),names);
 const actual=[];async function walk(directory,prefix=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){const name=prefix+entry.name;relativeName(name);actual.push(name);assert(actual.length<=200000,'Unexpected retained runtime expansion');if(entry.isDirectory())await walk(join(directory,entry.name),name+'/');else assert(entry.isFile(),'Unexpected link or special runtime member');}
 }
 await walk(root);assert.deepEqual(actual.sort(),names,'Retained runtime membership differs');
 for(const name of names){
  relativeName(name);const old=original[name],row=installed[name],path=join(root,name),stat=await lstat(path);assert.equal(row.type,old.type);assert.equal(row.mode,old.mode);assert.equal(stat.mode&0o7777,row.mode);
  if(row.type==='directory'){assert(stat.isDirectory());continue;}
  assert.equal(row.type,'file');assert(stat.isFile());assert.equal(row.nlink,1);assert.equal(stat.nlink,1);assert.equal(row.bytes,old.bytes);assert.equal(row.sha256,old.sha256);
  const ref=await identity(path,scratch);assert.equal(ref.byteLength,String(row.bytes));assert.equal(ref.hash,'sha256:'+row.sha256);
 }
 return {entries:names.length,files:names.filter(name=>original[name].type==='file').length};
}
async function retainedRuntime(env,scratch){
 const receipt=await anchored(env[keys[0]],env[keys[1]],scratch),finalization=await anchored(env[keys[2]],env[keys[3]],scratch),final=finalization.value;
 assert.equal(final.kind,'fixed-max12-retention-finalization-1');assert.equal(final.status,'PASS');for(const key of ['runtimeDrained','monitorDrained','timingLockReleased'])assert.equal(final[key],true);assert.deepEqual(final.errors,[]);assert.equal(final.audit?.status,'PASS');assert.equal(final.verification?.status,'PASS');
 const executionRef=normalized(final.receipt),execution=await reference(executionRef,scratch,{json:true});
 assert.equal(execution.kind,'fixed-max12-retention-execution-1');assert.equal(execution.status,'PASS');assert.equal(execution.runtimeDrained,true);assert.equal(execution.sourcePinsStable,true);assert.equal(execution.processObservationUncertain,false);assert.deepEqual(execution.errors,[]);assert.deepEqual(execution.signals,[]);assert(execution.networkEffects&&['fetch','socket','dns','datagram'].every(key=>execution.networkEffects[key]===0)&&Object.values(execution.networkEffects).every(value=>value===0));
 sameRef(normalized(execution.captureReceipt),receipt.ref);assert.equal(execution.captureReceipt.path,receipt.ref.path);
 const value=receipt.value;assert.equal(value.kind,'portable-max12-copy-only-retention-1');assert.equal(value.status,'COPIED_AND_FRESH_RESTORE_VERIFIED');assert.equal(value.originalsUnchanged,true);assert.equal(value.productRuntimeExecuted,false);assert.equal(value.publicPF13RefusalObserved,false);assert.equal(value.originalDeletionAuthorized,false);
 const closure=value.closure,manifest=await reference(closure.manifest,scratch,{json:true});await reference(closure.archive,scratch);
 assert.equal(manifest.kind,'schema17-closure-transport-2');assert.equal(manifest.role,'actual-built-portable-max12-runtime');assert.equal(manifest.metadataPolicy,'schema17-executable-metadata-2');assert.equal(manifest.originalsUnchanged,true);sameRef(manifest.archive,closure.archive);
 assert.equal(manifest.provenance.portableMaximumClaim,12);assert.equal(manifest.provenance.storageVersion,19);
 const restore=await reference(value.restore,scratch,{json:true});assert.equal(restore.kind,'schema17-closure-restore-2');assert.equal(restore.result,'verified');assert.equal(restore.contentVerified,true);assert.equal(restore.metadataPolicyVerified,true);assert.equal(restore.nonProvenanceMetadataVerified,true);assert.equal(restore.originalMetadataRetained,true);assert(!('metadataVerified' in restore));sameRef(restore.archive,closure.archive);sameRef(restore.manifest,closure.manifest);
 const installed=await reference(restore.installedManifest,scratch,{json:true});assert.equal(installed.kind,'schema17-installed-metadata-2');assert.equal(installed.sourceArchiveHash,closure.archive.hash);assert.equal(installed.sourceManifestHash,closure.manifest.hash);await reference(restore.originCalibration,scratch,{json:true});
 const retainedRoot=await canonical(value.restoredRoot);assert.equal(restore.restoredRoot,retainedRoot);assert.equal(retainedRoot,join(dirname(value.restore.path),'payload'));assert.equal(restore.entries,Object.keys(manifest.entries).length);
 const inventory=await runtimeTree(retainedRoot,manifest.entries,installed.entries,scratch);
 assert.equal(manifest.entries[sourceRelative].sha256,formatSourceHash,'This probe requires the actual sealed pre-PF13 max12 decoder');
 const buildRef=manifest.provenance.buildReceipt,name=relativeName(relative(manifest.sourceRoot,buildRef.path)),build=await reference({...buildRef,path:join(retainedRoot,name)},scratch,{json:true});
 assert.equal(build.kind,'development-validation-run-1');assert.equal(build.sourceStable,true);assert.equal(build.dependenciesUnchanged,true);assert.deepEqual(build.before,build.after);assert.equal(build.before.digest,manifest.provenance.buildSourceDigest);assert.equal(build.before.files.find(row=>row.path===sourceRelative)?.sha256,formatSourceHash);
 for(const id of ['build-server','build-app']){
  const gates=build.gates.filter(gate=>gate.observation.id===id);assert.equal(gates.length,1);const gate=gates[0];assert.equal(gate.mode,'executed');assert.equal(gate.observation.outcome,'PASS');assert.equal(gate.observation.exitCode,0);assert.equal(gate.observation.signal,null);assert.equal(gate.observation.timedOut,false);assert.equal(gate.observation.interrupted,false);assert(gate.outputs.trees.length>0);
  for(const tree of gate.outputs.trees){const output=relativeName(tree.path),expected=tree.tree.files.map(row=>output+'/'+relativeName(row.path)).sort(),members=Object.keys(manifest.entries).filter(name=>name.startsWith(output+'/')&&manifest.entries[name].type==='file').sort();assert.deepEqual(members,expected);for(const row of tree.tree.files){const member=manifest.entries[output+'/'+row.path];for(const key of ['sha256','bytes','mode'])assert.equal(member[key],row[key]);}}
 }
 const node=join(retainedRoot,nodeRelative),guard=join(retainedRoot,'tests/session/no-egress.mjs');assert(manifest.entries[nodeRelative]&&manifest.entries['tests/session/no-egress.mjs']);
 return {retainedRoot,node,guard,inventory,manifest,installed,anchors:{receipt:receipt.ref,finalization:finalization.ref,execution:executionRef,closure,restore:value.restore,installedManifest:restore.installedManifest,originCalibration:restore.originCalibration,sourceDigest:build.before.digest,formatSourceHash}};
}

// Optional observation within the existing whole-file native writer gate. Its
// absence is explicitly unexecuted and never counts as a compatibility pass.
export async function probeMax12Refusal(t,{bytes,comparisonManifestHashes,root,env=process.env}){
 const supplied=keys.filter(key=>env[key]!==undefined);
 if(!supplied.length){t.diagnostic('PF13 actual retained max12 public refusal: NOT EXECUTED (four root-pinned retention inputs absent)');return {status:'NOT_EXECUTED'};}
 assert.equal(supplied.length,keys.length,'All four root-pinned retention inputs are required');assert.equal(comparisonManifestHashes.length,3);assert(comparisonManifestHashes.every(hash=>/^sha256:[0-9a-f]{64}$/.test(hash)));
 const scratch=Buffer.allocUnsafe(1048576),runtime=await retainedRuntime(env,scratch),output=join(env.IE_HISTORY_OUTPUT??root,'portable-max12-refusal-'+randomUUID());assert(!inside(runtime.retainedRoot,resolve(output)));
 await mkdir(output,{recursive:true,mode:0o700});const nonce=randomUUID(),source=await record(join(output,'source-provenance.json'),{kind:'actual-native-comparison-pf13-source-1',comparisonManifestHashes,archive:{hash:'sha256:'+sha(bytes),byteLength:String(bytes.length)}}),archivePath=join(output,'actual-native-comparison.ideogram');await writeFile(archivePath,bytes,{flag:'wx',mode:0o600});
 const input={kind:'portable-max12-public-refusal-input-1',nonce,parentPid:process.pid,retainedRoot:runtime.retainedRoot,source:fileRef(archivePath,bytes),storeRoot:join(output,'private'),resultPath:join(output,'observation.json')},inputRef=await record(join(output,'input.json'),input),driver=fileURLToPath(new URL('./max12-refusal-driver.mjs',import.meta.url));
 const controller=new AbortController(),abort=()=>controller.abort('Parent test cancelled');t.signal.addEventListener('abort',abort,{once:true});if(t.signal.aborted)abort();
 let stdout='',stderr='',child,observation,failure,runtimeContentsUnchanged=false;
 const append=which=>chunk=>{const text=chunk.toString();if(which==='stdout')stdout=(stdout+text).slice(-65536);else stderr=(stderr+text).slice(-65536);};
 try{
  child=await boundedChild(runtime.node,['--import',runtime.guard,driver,inputRef.path],{cwd:runtime.retainedRoot,env:{PATH:dirname(runtime.node)+':/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:env.TMPDIR??'/private/tmp',LANG:'C',LC_ALL:'C',NO_COLOR:'1'},timeoutMs:120000,graceMs:5000,abortSignal:controller.signal,onStdout:append('stdout'),onStderr:append('stderr')});
  assert.equal(child.code,0,'Retained max12 probe exited unsuccessfully');assert.equal(child.signal,null);assert.equal(child.timedOut,false);assert.equal(child.interrupted,false);
  observation=JSON.parse(await readFile(input.resultPath,'utf8'));assert.equal(observation.kind,'portable-max12-public-refusal-observation-1');assert.equal(observation.status,'PASS');assert.equal(observation.nonce,nonce);assert.equal(observation.parentPid,process.pid);assert.equal(observation.execPath,runtime.node);assert.equal(observation.nodeVersion,'26.10.0');assert.equal(observation.serverClosed,true);assert.equal(observation.source.hash,input.source.hash);assert.equal(observation.source.byteLength,input.source.byteLength);
 }catch(error){failure=error;}finally{
  t.signal.removeEventListener('abort',abort);
  try{await runtimeTree(runtime.retainedRoot,runtime.manifest.entries,runtime.installed.entries,scratch);for(const ref of [runtime.anchors.receipt,runtime.anchors.finalization,runtime.anchors.execution,runtime.anchors.closure.archive,runtime.anchors.closure.manifest,runtime.anchors.restore,runtime.anchors.installedManifest,runtime.anchors.originCalibration])await reference(ref,scratch);runtimeContentsUnchanged=true;}catch(error){failure??=error;}
  await writeFile(join(output,'child.stdout.log'),stdout,{flag:'wx',mode:0o600});await writeFile(join(output,'child.stderr.log'),stderr,{flag:'wx',mode:0o600});
 }
 const result={kind:'actual-max12-pf13-refusal-1',qualification:false,status:failure?'FAIL':'PASS',sourceProvenance:source,source:input.source,retained:runtime.anchors,runtimeInventory:runtime.inventory,child:child??null,observation:observation??null,runtimeContentsUnchanged,metadataDisclosure:'Live probe verifies exact members, hashes and modes; calibrated metadata proof remains the pinned fresh-restore observation'};
 const receipt=await record(join(output,'receipt.json'),result);t.diagnostic(JSON.stringify({kind:result.kind,status:result.status,receipt}));if(failure)throw failure;return result;
}

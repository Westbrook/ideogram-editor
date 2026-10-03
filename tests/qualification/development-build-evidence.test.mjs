import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,lstat,rename,symlink,open} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {digestJSON,sha256} from '../../tooling/qualification/core.mjs';
import {outputIdentityAsync} from '../../tooling/qualification/development-cache.mjs';
import {needsRetainedBuildEvidence,retainDevelopmentBuildEvidence} from '../../tooling/qualification/development-build-evidence.mjs';
import {readEvidenceJSON,startEvidenceMonitor,retainEvidenceAudit,verifyEvidenceAudit} from '../../tooling/qualification/evidence-volume.mjs';

const sources=['index.html','vite.app.config.ts','tsconfig.json','tsconfig.app.json','package.json','package-lock.json','.progress-report/project.json','tooling/build-evidence.ts','vendor/text/manifest.json','src/text/client.ts','tooling/theme/tokens.mjs'];
const native=['node_modules/canvaskit-wasm/package.json','node_modules/canvaskit-wasm/bin/canvaskit.js','node_modules/canvaskit-wasm/bin/canvaskit.wasm'];
const pin=(path,bytes)=>({path,bytes:bytes.length,sha256:sha256(bytes)});
// Explicitly synthetic provenance and tiny outputs exercise identity joins,
// not a native build, compiled-worker correctness or ownership approval.
async function fixture(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'build-evidence-retention-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=join(root,'repo'),volume=join(root,'volume'),directory=join(volume,'run');
  await mkdir(cwd);await mkdir(volume,{mode:0o700});await mkdir(directory,{mode:0o700});
  const put=async(path,bytes)=>{const target=join(cwd,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);};
  const files=[];for(const path of [...sources,'tests/unrelated.test.mjs']){const bytes=Buffer.from('// synthetic '+path+'\n');await put(path,bytes);files.push(pin(path,bytes));}
  const source={head:'a'.repeat(40),files,digest:digestJSON(files)};
  const emitted=[];
  for(const [file,text] of [['index.html','<!doctype html>'],['main.js','// synthetic application'],['worker.js','// synthetic worker'],['.vite/manifest.json','{}']]){
    const bytes=Buffer.from(text);await put('dist/app/'+file,bytes);
    if(file!=='.vite/manifest.json')emitted.push({file,bytes:bytes.length,sha256:sha256(bytes),modules:[],imports:[],entry:file==='main.js'});
  }
  const worker=emitted.find(row=>row.file==='worker.js');
  worker.modules=['src/text/worker.ts',native[1]];
  worker.workerBundle={schema:1,phase:'generateBundle',format:'iife',entry:'src/text/worker.ts',chunkEntry:true,facade:'src/text/worker.ts',file:worker.file,bytes:worker.bytes,sha256:worker.sha256,modules:[...worker.modules],imports:[]};
  const value={schema:1,capture:{phase:'writeBundle',finalized:true},toolchain:{node:'26.10.0',npm:'12.1.0'},sourceInputs:files.filter(row=>sources.includes(row.path)),nativeInputs:native.map(path=>pin(path,Buffer.from('synthetic native'))),dependencyInputs:[pin('node_modules/synthetic/index.js',Buffer.from('synthetic dependency'))],compilation:{schema:1,profile:'reviewed-vite-app-2',configInputs:files.filter(row=>['.progress-report/project.json','tooling/build-evidence.ts','vite.app.config.ts'].includes(row.path))},outputs:emitted};
  const f={root,cwd,volume,directory,source,value,put,original:join(cwd,'dist/app/build-evidence.json'),retained:join(directory,'app-build/build-evidence.json')};
  f.seal=async()=>{f.bytes=Buffer.from('\n\t'+JSON.stringify(value,null,1)+' \n');await put('dist/app/build-evidence.json',f.bytes);f.outputs=await outputIdentityAsync(cwd,{id:'build-app'});};
  await f.seal();return f;
}
const absent=async path=>assert.rejects(lstat(path),error=>error.code==='ENOENT');

test('retention selects only actual text/native test steps and preserves unrelated selections',()=>{
  for(const family of ['text','editor-native-text'])assert.equal(needsRetainedBuildEvidence({browserPlan:{steps:[{family,config:'actual.config.ts'}]}}),true);
  for(const plan of [{},{browserPlan:null},{browserPlan:{steps:[]}},{browserPlan:{steps:[{family:'text',config:null}]}},{browserPlan:{steps:[{family:'editor-recovery',config:'actual.config.ts'}]}},{browserPlan:{steps:[{family:'text-extra',config:'actual.config.ts'}]}}])assert.equal(needsRetainedBuildEvidence(plan),false);
  assert.equal(needsRetainedBuildEvidence({browserPlan:{steps:[{family:'fixture-build',config:null},{family:'text',config:'actual.config.ts'}]}}),true);
});
test('retained body is byte-identical including whitespace, bound to complete source/build identities and private',async t=>{
  const f=await fixture(t),original=await readFile(f.original),result=await retainDevelopmentBuildEvidence(f);
  assert.deepEqual(await readFile(f.retained),original);assert.deepEqual(await readFile(f.original),original);
  assert.notDeepEqual(original,Buffer.from(JSON.stringify(f.value)));
  assert.deepEqual(result,{kind:'retained-development-build-evidence-1',sourcePath:'dist/app/build-evidence.json',path:'app-build/build-evidence.json',bytes:original.length,sha256:sha256(original),sourceDigest:f.source.digest,buildOutputsDigest:f.outputs.digest,qualification:false});
  assert.equal((await lstat(f.retained)).mode&0o777,0o600);
  assert.equal((await lstat(dirname(f.retained))).mode&0o777,0o700);
});

for(const [label,mutate,pattern] of [
  ['stale source',f=>{f.value.sourceInputs[0]={...f.value.sourceInputs[0],sha256:'b'.repeat(64)};},/source closure/],
  ['omitted source',f=>{f.value.sourceInputs.pop();},/source closure/],
  ['duplicate source',f=>{f.value.sourceInputs.push({...f.value.sourceInputs[0]});},/Duplicate/],
  ['pre-finalization body',f=>{f.value.capture.finalized=false;},/Finalized pinned/],
  ['wrong toolchain',f=>{f.value.toolchain.node='other';},/Finalized pinned/],
  ['omitted native input',f=>{f.value.nativeInputs.pop();},/native input inventory/],
  ['missing compilation',f=>{delete f.value.compilation;},/compilation provenance/],
  ['missing compilation input',f=>{f.value.compilation.configInputs.pop();},/compilation input closure/],
  ['missing invocation inputs',f=>{delete f.value.dependencyInputs;},/Missing bounded/],
  ['missing worker provenance',f=>{delete f.value.outputs.find(row=>row.file==='worker.js').workerBundle;},/worker bundle provenance/],
  ['different worker output identity',f=>{f.value.outputs.find(row=>row.file==='worker.js').workerBundle.sha256='d'.repeat(64);},/worker output identity/],
  ['omitted emitted file',f=>{f.value.outputs.pop();},/emitted output closure/],
  ['different emitted bytes',f=>{f.value.outputs[0].sha256='c'.repeat(64);},/emitted output closure/],
  ['escaping emitted path',f=>{f.value.outputs[0].file='../escape.js';},/Malformed/],
])test('retention refuses '+label+' even when the altered body has a fresh exact build pin',async t=>{
  const f=await fixture(t);mutate(f);await f.seal();await assert.rejects(retainDevelopmentBuildEvidence(f),pattern);await absent(f.retained);
});
test('a new application input cannot hide behind an unchanged body or a partial source inventory',async t=>{
  const f=await fixture(t);f.source.files.push(pin('src/new.ts',Buffer.from('new')));f.source.digest=digestJSON(f.source.files);
  await assert.rejects(retainDevelopmentBuildEvidence(f),/source closure/);await absent(f.retained);
  f.source.files=f.source.files.filter(row=>row.path!=='index.html');f.source.digest=digestJSON(f.source.files);
  await assert.rejects(retainDevelopmentBuildEvidence(f),/Incomplete application source/);
});
test('source and output aggregate digests, unique trees and raw-body pins are required',async t=>{
  const f=await fixture(t);
  await assert.rejects(retainDevelopmentBuildEvidence({...f,source:{...f.source,digest:'a'.repeat(64)}}),/source identity/);
  await assert.rejects(retainDevelopmentBuildEvidence({...f,outputs:{...f.outputs,digest:'a'.repeat(64)}}),/output tree/);
  const extra=structuredClone(f.outputs);extra.trees.push(extra.trees[0]);extra.digest=digestJSON(extra.trees);
  await assert.rejects(retainDevelopmentBuildEvidence({...f,outputs:extra}),/output tree/);
  await writeFile(f.original,Buffer.concat([f.bytes,Buffer.from(' ')]));
  await assert.rejects(retainDevelopmentBuildEvidence(f),/raw body/);await absent(f.retained);
});
test('a file above the unchanged 16 MiB JSON limit is rejected before retention',async t=>{
  const f=await fixture(t),handle=await open(f.original,'r+');try{await handle.truncate(16*1024*1024+1);}finally{await handle.close();}
  await assert.rejects(retainDevelopmentBuildEvidence(f),/Bounded regular JSON/);await absent(f.retained);
});
for(const location of ['source-file','source-parent','destination-parent','output-root'])test('retention refuses '+location+' aliases',async t=>{
  const f=await fixture(t);
  if(location==='source-file'){await rename(f.original,join(f.root,'body.json'));await symlink(join(f.root,'body.json'),f.original);}
  if(location==='source-parent'){await rename(join(f.cwd,'dist/app'),join(f.root,'app'));await symlink(join(f.root,'app'),join(f.cwd,'dist/app'));}
  if(location==='destination-parent'){await mkdir(join(f.root,'elsewhere'));await symlink(join(f.root,'elsewhere'),dirname(f.retained));}
  if(location==='output-root'){await symlink(f.directory,join(f.volume,'alias'));f.directory=join(f.volume,'alias');}
  await assert.rejects(retainDevelopmentBuildEvidence(f),/alias|symlink|Canonical/);
});
test('an existing destination is never overwritten or adopted',async t=>{
  const f=await fixture(t);await mkdir(dirname(f.retained));await writeFile(f.retained,'prior failure');
  await assert.rejects(retainDevelopmentBuildEvidence(f),error=>error.code==='EEXIST');assert.equal(await readFile(f.retained,'utf8'),'prior failure');
});
for(const replacement of ['changed-bytes','same-bytes-new-inode'])test('original '+replacement+' after bounded read refuses authority and retains diagnostic bytes',async t=>{
  const f=await fixture(t);
  await assert.rejects(retainDevelopmentBuildEvidence(f,{readJSON:async(path,options)=>{
    const read=await readEvidenceJSON(path,options),next=join(f.root,'replacement.json');
    await writeFile(next,replacement==='changed-bytes'?Buffer.concat([read.bytes,Buffer.from(' ')]):read.bytes);await rename(next,path);return read;
  }}),/original raw body|changed during retention/);
  assert.deepEqual(await readFile(f.retained),f.bytes);
});
test('growth beyond 16 MiB after the first read is refused by bounded final verification',async t=>{
  const f=await fixture(t);let initialReads=0;
  await assert.rejects(retainDevelopmentBuildEvidence(f,{readJSON:async(path,options)=>{
    initialReads++;const read=await readEvidenceJSON(path,options),handle=await open(path,'r+');
    try{await handle.truncate(16*1024*1024+1);}finally{await handle.close();}return read;
  }}),/Bounded regular JSON/);
  assert.equal(initialReads,1);assert.deepEqual(await readFile(f.retained),f.bytes);
  assert.equal((await lstat(f.original)).size,16*1024*1024+1);
});
test('interruption before publication cannot return a retained success',async t=>{
  const f=await fixture(t),controller=new AbortController();
  await assert.rejects(retainDevelopmentBuildEvidence({...f,signal:controller.signal},{readJSON:async(path,options)=>{const read=await readEvidenceJSON(path,options);controller.abort(Error('retention interrupted'));return read;}}),/retention interrupted/);
  await absent(f.retained);
});

for(const outcome of ['PASS','FAIL'])test('the ordinary monitor seals exact raw sidecar and receipt before '+outcome+' retention finalization',async t=>{
  const f=await fixture(t),allocationPath=join(f.root,'allocation.json'),receiptPath=join(f.directory,'receipt.json');
  await writeFile(allocationPath,JSON.stringify({kind:'evidence-volume-allocation-1',allocationId:'test-retention',purpose:'qualification-evidence-only',capacityBytes:1024*1024*1024,root:f.volume,issuedAt:'2025-01-01T00:00:00.000Z',owner:'Build'}));
  const monitor=await startEvidenceMonitor({allocationPath,output:f.directory,campaignId:'test-retention',intervalMs:30000});let closed=false;
  try{
  const retainedBuildEvidence=await retainDevelopmentBuildEvidence(f);
  const receipt={kind:'development-validation-run-1',id:'test-retention',outcome,qualification:false,evidenceStorage:monitor.reference,gates:[{observation:{id:'build-app',outcome:'PASS'},retainedBuildEvidence}]};
  await writeFile(receiptPath,JSON.stringify(receipt)+'\n');await monitor.checkpoint();closed=true;
  const audit=await monitor.finish({receiptPath,outcome});assert.equal(audit.status,'PASS');assert.equal(audit.outcome,outcome);
  await retainEvidenceAudit(monitor.reference,f.directory);assert.equal((await verifyEvidenceAudit(monitor.reference,receiptPath)).status,'PASS');
  const index=JSON.parse(await readFile(join(f.directory,'evidence-storage/retention.json'),'utf8'));
  const body=index.entries.find(row=>row.path==='run/app-build/build-evidence.json');assert(body);
  assert.deepEqual(body.identity,{bytes:f.bytes.length,sha256:sha256(f.bytes)});
  assert(index.entries.some(row=>row.path==='run/receipt.json'));
  assert.deepEqual(await readFile(f.retained),f.bytes);assert.equal(JSON.parse(await readFile(receiptPath)).outcome,outcome);
  }finally{if(!closed){closed=true;await monitor.finish({outcome:'FAIL'});}}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nodeGroups} from '../../tooling/qualification/suite-prerequisites.mjs';
import {executeDevelopment,argumentsFor} from '../../tooling/qualification/development.mjs';
import {gateInputKey,treeIdentity,outputIdentity,reusable} from '../../tooling/qualification/development-cache.mjs';
import {sha256,digestJSON} from '../../tooling/qualification/core.mjs';
import {developmentPlan} from '../../tooling/qualification/development-plan.mjs';
import {createBrowserPlan} from '../../tooling/qualification/container/browser-plan.mjs';

import {acquireTimingLock} from '../../tooling/qualification/campaigns/host.mjs';

function fixture(t){
 const cwd=mkdtempSync(join(tmpdir(),'validation-development-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 for(const group of Object.values(nodeGroups).flat()){mkdirSync(join(cwd,'tests',group),{recursive:true});writeFileSync(join(cwd,'tests',group,'fixture.test.mjs'),'// fixture');}
 const files=[{path:'src/test.ts',sha256:'a',bytes:1}];
 return {cwd,files,hostLeaseProvider:id=>acquireTimingLock(cwd,{receiptId:id}),sourceProvider:()=>({head:'fixture',files,digest:digestJSON(files)}),dependencyProvider:()=>({digest:'fixture-dependencies'})};
}
function executor(calls,fail){return async(gate,directory)=>{
 calls.push(gate.id);const log=gate.id.replaceAll(':','-')+'.log',isTest=gate.id.startsWith('node:');
 const bytes=Buffer.from(isTest?'# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n':'checked\n');writeFileSync(join(directory,log),bytes);
 const counts=isTest?{tests:1,pass:1,fail:0,cancelled:0,skipped:0,todo:0}:{};
 return {id:gate.id,command:gate.command,counts,exitCode:gate.id===fail?1:0,outcome:gate.id===fail?'FAIL':'PASS',elapsedMs:1,log:{path:log,bytes:bytes.length,sha256:sha256(bytes)}};
};}
test('runner stops on failure, retains its log and releases only its lock',async t=>{
 const f=fixture(t),calls=[];const result=await executeDevelopment({...f,options:{groups:'base',browsers:'none',workers:1,fresh:true},gateExecutor:executor(calls,'preflight')});
 assert.deepEqual(calls,['typecheck','preflight']);assert.equal(result.outcome,'FAIL');assert.ok(result.pending.includes('build-server'));assert.ok(existsSync(result.gates[1].logPath));assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
});
test('unchanged successful prerequisites reuse evidence, changed inputs invalidate it',async t=>{
 const f=fixture(t),options={groups:'preflight',browsers:'none',workers:1};
 const a=[];await executeDevelopment({...f,options,gateExecutor:executor(a)});assert.deepEqual(a,['typecheck','preflight']);
 const b=[];const second=await executeDevelopment({...f,options,gateExecutor:executor(b)});assert.deepEqual(b,['preflight']);assert.equal(second.gates[0].mode,'reused');
 f.files[0]={...f.files[0],sha256:'b'};const c=[];await executeDevelopment({...f,options,gateExecutor:executor(c)});assert.deepEqual(c,['typecheck','preflight']);
});
test('tampered receipts and changed dependencies cannot reuse a successful result',async t=>{
 const f=fixture(t),options={groups:'preflight',browsers:'none',workers:1};
 const first=await executeDevelopment({...f,options,gateExecutor:executor([])});writeFileSync(first.gates[0].logPath,'tampered');
 const calls=[];await executeDevelopment({...f,options,gateExecutor:executor(calls)});assert.deepEqual(calls,['typecheck','preflight']);
 let n=0;const changed=await executeDevelopment({...f,dependencyProvider:()=>({digest:String(n++)}),options,gateExecutor:executor([])});assert.equal(changed.outcome,'INCONCLUSIVE');
});
test('source drift never publishes reusable success',async t=>{
 const f=fixture(t),run=executor([]);const result=await executeDevelopment({...f,options:{groups:'preflight',browsers:'none',workers:1},gateExecutor:async(...args)=>{const r=await run(...args);f.files.push({path:'src/drift.ts',sha256:'c'});return r;}});
 assert.equal(result.outcome,'INCONCLUSIVE');assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);
});
test('build reuse verifies existing output bytes and dependency identity',t=>{
 const f=fixture(t),gate={id:'build-app',command:['build'],dependencies:[]};mkdirSync(join(f.cwd,'dist/app'),{recursive:true});writeFileSync(join(f.cwd,'dist/app/main.js'),'one');
 const source=f.sourceProvider(),key=gateInputKey(gate,source,{dependencies:'a'}),entry={key,observation:{outcome:'PASS'},outputs:outputIdentity(f.cwd,gate)};
 assert.ok(reusable(entry,key,f.cwd,gate));writeFileSync(join(f.cwd,'dist/app/main.js'),'two');assert.equal(reusable(entry,key,f.cwd,gate),false);
 assert.notEqual(key,gateInputKey(gate,source,{dependencies:'b'}));
});
test('development browser batching preserves exact engine/file selections',()=>{
 const a=createBrowserPlan({output:'/tmp/old',selection:'all'}),b=createBrowserPlan({output:'/tmp/new',selection:'all',batchEditor:true});
 const cells=plan=>plan.steps.flatMap(step=>step.files.map(file=>`${step.browser}:${file}`)).sort();assert.deepEqual(cells(a),cells(b));
 assert.equal(a.steps.filter(s=>s.config).length-b.steps.filter(s=>s.config).length,51);
 assert.ok(b.steps.filter(s=>s.family==='editor-batch').every(s=>s.env.IE_VALIDATION_BATCH==='1'));
 assert.throws(()=>argumentsFor(['run','--workers']),/incomplete/);assert.throws(()=>argumentsFor(['run','--unknown','x']),/Unknown/);
});

test('focused browser selection builds only its fixtures and rejects unknown families',t=>{
 const f=fixture(t),plan=developmentPlan(f.cwd,{groups:'preflight',browsers:'chromium',browserGroups:'consumer',output:'/tmp/selected'});
 assert.deepEqual(plan.browserPlan.steps.map(s=>s.id),['build-consumer','consumer-chromium']);
 assert.equal(plan.gates.some(g=>g.id==='build-app'||g.id==='build-server'),false);
 assert.throws(()=>developmentPlan(f.cwd,{browsers:'all',browserGroups:'typo',output:'/tmp/selected'}),/Unknown/);
});

test('explicit resume reuses successful tests only and still executes the failed gate',async t=>{
 const f=fixture(t),options={groups:'tooling',browsers:'none',workers:1};
 const failed=await executeDevelopment({...f,options,gateExecutor:executor([],'node:tooling')});
 assert.equal(failed.outcome,'FAIL');
 const calls=[],resumed=await executeDevelopment({...f,options:{...options,resume:join(failed.directory,'receipt.json')},gateExecutor:executor(calls)});
 assert.equal(resumed.outcome,'PASS');assert.ok(!calls.includes('node:qualification'));assert.ok(calls.includes('node:tooling'));
 assert.equal(JSON.parse(readFileSync(join(failed.directory,'receipt.json'))).outcome,'FAIL');
});
test('execution environment changes invalidate cached prerequisite results',async t=>{
 const f=fixture(t),options={groups:'preflight',browsers:'none',workers:1};
 await executeDevelopment({...f,options,environment:{LANG:'C'},gateExecutor:executor([])});
 const calls=[];await executeDevelopment({...f,options,environment:{LANG:'en_US.UTF-8'},gateExecutor:executor(calls)});
 assert.deepEqual(calls,['typecheck','preflight']);
});

test('reviewed completion source fails before builds only for selections that need it',t=>{
 const f=fixture(t),plan=developmentPlan(f.cwd,{groups:'preflight',browsers:'chromium',browserGroups:'shell',output:'/tmp/selected'});
 assert.ok(plan.gates.findIndex(g=>g.id==='completion-source')<plan.gates.findIndex(g=>g.id==='build-app'));
 assert.ok(!developmentPlan(f.cwd,{groups:'preflight'}).gates.some(g=>g.id==='completion-source'));
});

test('a timing owner prevents correctness gates and failure releases checkout ownership',async t=>{
 const f=fixture(t),owner=await acquireTimingLock(f.cwd,{receiptId:'timing-owner'}),calls=[];
 try{
  const result=await executeDevelopment({...f,options:{groups:'preflight',browsers:'none',workers:1},gateExecutor:executor(calls)});
  assert.equal(result.outcome,'FAIL');assert.match(result.error,/EEXIST/);assert.deepEqual(calls,[]);
  assert.ok(existsSync(owner.path));assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
 }finally{await owner.release();}
 const result=await executeDevelopment({...f,options:{groups:'preflight',browsers:'none',workers:1},gateExecutor:executor(calls)});
 assert.equal(result.outcome,'PASS');assert.deepEqual(calls,['typecheck','preflight']);assert.equal(existsSync(result.hostExclusion.path),false);
});

test('UI, server, storage and sweeping edits invalidate build inputs; test-only changes retain builds',()=>{
 const environment={node:'pinned',dependencies:'sealed'};
 const base={files:[{path:'src/ui.ts',sha256:'ui'},{path:'server/domain.ts',sha256:'domain'},{path:'server/storage/store.ts',sha256:'store'},{path:'tests/store/case.test.mjs',sha256:'case'}]};
 for(const id of ['build-app','build-server']){
  const gate={id},key=gateInputKey(gate,base,environment);
  for(const path of ['src/ui.ts','server/domain.ts','server/storage/store.ts']){
   const changed=structuredClone(base);changed.files.find(file=>file.path===path).sha256+='-changed';
   assert.notEqual(gateInputKey(gate,changed,environment),key,path);
  }
  const sweeping={files:base.files.map(file=>({...file,sha256:file.sha256+'-changed'}))};assert.notEqual(gateInputKey(gate,sweeping,environment),key);
  assert.notEqual(gateInputKey(gate,base,{...environment,dependencies:'new-vendor-or-install'}),key);
  const tests=structuredClone(base);tests.files.at(-1).sha256='new-case';assert.equal(gateInputKey(gate,tests,environment),key);
 }
});

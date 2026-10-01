import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nodeGroups,fastNodeFiles,buildFreeFastNodeFiles} from '../../tooling/qualification/suite-prerequisites.mjs';
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

test('explicit browser case filter stays in development selection and subprocess argv',t=>{
 const f=fixture(t),plan=developmentPlan(f.cwd,{groups:'preflight',browsers:'chromium',browserGroups:'editor-composition',browserGrep:'Composition links',output:'/tmp/focused'});
 assert.equal(plan.browserGrep,'Composition links');assert.deepEqual(plan.browserPlan.steps.find(s=>s.config).args.slice(-2),['--grep','Composition links']);
 assert.throws(()=>developmentPlan(f.cwd,{groups:'preflight',browserGrep:'case'}),/browser selection/);
});

test('vendor/import prerequisite keys ignore unrelated edits but include their complete reviewed closure',()=>{
 const paths=['src/ui.ts','server/domain.ts','tests/editor/case.spec.ts','vendor/text/manifest.json','src/text/profile.json','tooling/verify-vendor.py','tooling/verify-imports.mjs','tsconfig.app.json','package-lock.json','tooling/qualification/development.mjs'];
 const source={files:paths.map(path=>({path,sha256:'old'}))},env={dependencies:'installed'};
 for(const id of ['vendor','imports']){
  const gate={id},key=gateInputKey(gate,source,env);
  const required=id==='vendor'?['vendor/text/manifest.json','src/text/profile.json','tooling/verify-vendor.py','package-lock.json','tooling/qualification/development.mjs']:['src/ui.ts','src/text/profile.json','tooling/verify-imports.mjs','tsconfig.app.json','package-lock.json','tooling/qualification/development.mjs'];
  for(const path of paths){const changed=structuredClone(source);changed.files.find(f=>f.path===path).sha256='new';assert.equal(gateInputKey(gate,changed,env)!==key,required.includes(path),id+':'+path);}
  assert.notEqual(gateInputKey(gate,source,{dependencies:'changed'}),key);
 }
});

test('focused editor batching preserves exactly the selected files and engines',()=>{
 const options={groups:'preflight',browsers:'all',output:'/tmp/validation-plan',browserGroups:'editor-composition,editor-native-text,editor-tool-rail'};
 const serial=developmentPlan(process.cwd(),options),batch=developmentPlan(process.cwd(),{...options,batchEditor:true});
 const membership=p=>p.browserPlan.steps.filter(s=>s.config).flatMap(s=>s.files.map(f=>s.browser+':'+f)).sort();
 assert.deepEqual(membership(batch),membership(serial));assert.equal(batch.browserPlan.steps.filter(s=>s.config).length,3);
 assert.throws(()=>developmentPlan(process.cwd(),{...options,browserGroups:'editor-typo',batchEditor:true}),/Unknown/);
});

test('focused Node files preserve guards, all cases in each file and late browser ownership',()=>{
 const options={groups:'store,history',nodeFiles:'tests/store/proof-budget.test.mjs,tests/history/mask-text-compatibility.test.mjs',output:'/tmp/validation-plan'};
 const plan=developmentPlan(process.cwd(),options),store=plan.gates.find(g=>g.id==='node:store'),late=plan.gates.find(g=>g.id==='node:history:browser');
 assert.deepEqual(store.files,['tests/store/proof-budget.test.mjs']);assert(store.command.includes('./tests/store/no-network.mjs'));assert(store.command.includes('--test-concurrency=1'));
 assert.deepEqual(late.files,['tests/history/mask-text-compatibility.test.mjs']);assert(late.browserPrerequisites);assert(!plan.gates.some(g=>g.id==='node:history'));
 for(const nodeFiles of ['', 'tests/session/http.test.mjs','tests/store/proof-budget.test.mjs,tests/store/proof-budget.test.mjs'])assert.throws(()=>developmentPlan(process.cwd(),{...options,nodeFiles}),/Node file selection/);
});


test('reviewed fast controllers execute once before app build and real integrations',()=>{
 const plan=developmentPlan(process.cwd(),{groups:'all',output:'/tmp/validation-plan'}),ids=plan.gates.map(g=>g.id),fast=plan.gates.find(g=>g.id==='node:request:fast');
 assert.deepEqual(fast.files,[...fastNodeFiles].sort());
 assert(ids.indexOf('build-server')<ids.indexOf(fast.id));
 assert(ids.indexOf(fast.id)<ids.indexOf('build-app'));
 for(const id of ['node:store','node:provider','node:request'])assert(ids.indexOf(fast.id)<ids.indexOf(id));
 for(const file of fastNodeFiles)assert.equal(plan.selectedFiles.filter(f=>f===file).length,1);
 assert(fast.command.includes('./tests/session/no-egress.mjs'));assert(fast.command.includes('--test-concurrency=1'));assert(!fast.browserPrerequisites);
 const focused=developmentPlan(process.cwd(),{groups:'request',nodeFiles:fastNodeFiles[0],output:'/tmp/validation-plan'});
 assert.deepEqual(focused.selectedFiles,[fastNodeFiles[0]]);assert(!focused.gates.some(g=>g.id==='node:request'||g.id==='build-app'));
});
test('a fast controller failure prevents app build and integration dispatch',async t=>{
 const f=fixture(t);for(const file of fastNodeFiles)writeFileSync(join(f.cwd,file),'// reviewed fixture');
 const calls=[],receipt=await executeDevelopment({...f,options:{groups:'all',browsers:'none',workers:1,fresh:true},gateExecutor:executor(calls,'node:request:fast')});
 assert.equal(receipt.outcome,'FAIL');assert(calls.includes('build-server'));assert(!calls.includes('build-app'));assert(!calls.includes('node:store'));assert(receipt.pending.includes('node:request'));
});


test('build-free export controllers run before all builds with exact guarded membership',async t=>{
 const plan=developmentPlan(process.cwd(),{groups:'all',output:'/tmp/validation-plan'}),ids=plan.gates.map(g=>g.id),fast=plan.gates.find(g=>g.id==='node:export:fast');
 assert.deepEqual(fast.files,[...buildFreeFastNodeFiles].sort());assert.deepEqual(fast.dependencies,['preflight']);
 for(const id of ['vendor','build-server','build-app','node:store'])assert(ids.indexOf(fast.id)<ids.indexOf(id));
 assert(!ids.includes('node:export'));for(const file of buildFreeFastNodeFiles)assert.equal(plan.selectedFiles.filter(f=>f===file).length,1);
 assert(fast.command.includes('./tests/session/no-egress.mjs'));assert(fast.command.includes('--test-concurrency=1'));assert(!fast.browserPrerequisites);
 const focused=developmentPlan(process.cwd(),{groups:'export',output:'/tmp/validation-plan'});assert.deepEqual(focused.gates.map(g=>g.id),['typecheck','preflight','node:export:fast']);
 const f=fixture(t);for(const file of buildFreeFastNodeFiles)writeFileSync(join(f.cwd,file),'// reviewed fixture');
 const calls=[],receipt=await executeDevelopment({...f,options:{groups:'all',browsers:'none',workers:1,fresh:true},gateExecutor:executor(calls,'node:export:fast')});
 assert.equal(receipt.outcome,'FAIL');assert(!calls.includes('build-server'));assert(!calls.includes('vendor'));assert(receipt.pending.includes('node:store'));
});

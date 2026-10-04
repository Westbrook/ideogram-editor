import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync,symlinkSync,unlinkSync,realpathSync,statSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {nodeGroups,fastNodeFiles,buildFreeFastNodeFiles} from '../../tooling/qualification/suite-prerequisites.mjs';
import {executeDevelopment,argumentsFor} from '../../tooling/qualification/development.mjs';
import {gateInputKey,treeIdentity,treeIdentityAsync,outputIdentity,outputIdentityAsync,reusable,reusableAsync} from '../../tooling/qualification/development-cache.mjs';
import {sha256,digestJSON,sourceIdentity,sourceIdentityAsync} from '../../tooling/qualification/core.mjs';
import {developmentPlan} from '../../tooling/qualification/development-plan.mjs';
import {selectedFastSetup, fastSetupPlan, provisionFastSetup, fastBrowserFamilies, selectedFastBrowserSetup, fastBrowserSetupPlan, selectedFastDispatchSetup, provisionFastBrowserSetup, stagePinnedAdapterResponse, publishPinnedAdapterFile, provisionFastAdapterFixture} from '../../tooling/qualification/fast-ci-setup.mjs';
import {rendererReceiptOwner, rendererReceiptRequirement} from '../../tooling/qualification/r18-ci-inputs.mjs';
import {functionalGates} from '../../tooling/qualification/manifest.mjs';
import {createBrowserPlan} from '../../tooling/qualification/container/browser-plan.mjs';

import {acquireTimingLock} from '../../tooling/qualification/campaigns/host.mjs';

function fixture(t){
 const cwd=mkdtempSync(join(tmpdir(),'validation-development-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 for(const group of Object.values(nodeGroups).flat()){
  const directory=group==='editor-capability-preflight'?'recovery':group;
  const file=group==='editor-capability-preflight'?'editor-capability-preflight.test.mjs':'fixture.test.mjs';
  mkdirSync(join(cwd,'tests',directory),{recursive:true});writeFileSync(join(cwd,'tests',directory,file),'// fixture');
 }
 const files=[{path:'src/test.ts',sha256:'a',bytes:1}];
 const evidence=evidenceFixture(cwd);
 return {cwd,files,...evidence,hostLeaseProvider:id=>acquireTimingLock(cwd,{receiptId:id}),sourceProvider:()=>({head:'fixture',files:structuredClone(files),digest:digestJSON(files)}),dependencyProvider:()=>({digest:'fixture-dependencies'})};
}
// Synthetic observer uses real retained JSON and receipt-byte binding. It never
// samples the host volume; production defaults remain the existing strict helpers.
function evidenceFixture(cwd){
 const evidence={events:[],runs:new Map(),status:'PASS',initialAlarm:{status:'PASS',level:'normal',percent:1}};
 const identity=bytes=>({bytes:bytes.length,sha256:sha256(bytes)});
 const monitorFactory=async options=>{
  evidence.events.push('start');assert.equal(options.allowUnavailable,false);
  evidence.lastOptions=options;
  // Initial admission and final audit are independent synthetic observations:
  // a later audit failure must not turn this fixture's initial sample into one.
  const initialAlarm=evidence.initialAlarm?{allocationId:'synthetic',campaignId:options.campaignId,...evidence.initialAlarm}:null;
  if(initialAlarm)options.onAlarm(initialAlarm);
  const reference={kind:'evidence-volume-reference-1',root:cwd,auditPath:'synthetic/audit.json',retainedPath:'evidence-storage/audit.json',auditId:options.campaignId,campaignId:options.campaignId,status:'PENDING'};
  return {reference,async finish({receiptPath,outcome}){
   evidence.events.push('finish');const bytes=receiptPath?readFileSync(receiptPath):null;
   const audit={status:evidence.status,auditId:reference.auditId,receipt:bytes?identity(bytes):null,outcome,initialAlarm};
   evidence.runs.set(options.output,{audit,bytes,receiptPath});return audit;
  }};
 };
 const auditRetainer=async(reference,directory)=>{
  evidence.events.push('retain');const entry=evidence.runs.get(directory);assert.ok(entry);
  const target=join(directory,'evidence-storage');mkdirSync(target);writeFileSync(join(target,'audit.json'),JSON.stringify(entry.audit));
  return [{path:'evidence-storage/audit.json'}];
 };
 const auditVerifier=async(reference,receiptPath)=>{
  evidence.events.push('verify');const audit=JSON.parse(readFileSync(join(receiptPath,'..','evidence-storage/audit.json')));
  assert.equal(audit.auditId,reference.auditId);assert.deepEqual(identity(readFileSync(receiptPath)),audit.receipt);
  return {status:audit.status,qualification:audit.status==='PASS'};
 };
 return {evidence,monitorFactory,auditRetainer,auditVerifier};
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
 assert.equal(a.steps.filter(s=>s.config).length-b.steps.filter(s=>s.config).length,63);
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
 const failed=await executeDevelopment({...f,options,gateExecutor:executor([],'node:qualification')});
 assert.equal(failed.outcome,'FAIL');
 const calls=[],resumed=await executeDevelopment({...f,options:{...options,resume:join(failed.directory,'receipt.json')},gateExecutor:executor(calls)});
 assert.equal(resumed.outcome,'PASS');assert.ok(!calls.includes('node:tooling'));assert.ok(calls.includes('node:qualification'));
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

test('build-free tooling stays early while managed qualification retains its server build',t=>{
 const f=fixture(t),plan=developmentPlan(f.cwd,{groups:'tooling',browsers:'none'}),ids=plan.gates.map(g=>g.id);
 const qualification=plan.gates.find(g=>g.id==='node:qualification');
 assert.deepEqual(qualification.dependencies,['build-server']);
 for(const id of ['typecheck','preflight','node:tooling','vendor','imports','build-server','node:qualification'])assert.ok(ids.includes(id),id);
 assert.ok(ids.indexOf('preflight')<ids.indexOf('node:tooling'));
 assert.ok(ids.indexOf('node:tooling')<ids.indexOf('build-server'));
 assert.ok(ids.indexOf('build-server')<ids.indexOf('node:qualification'));
 assert.equal(plan.browserPlan,null);
});

test('ordinary editor completion preparation keeps an app build before its Node gate',t=>{
 const f=fixture(t),directory=join(f.cwd,'tests/editor/completion');mkdirSync(directory,{recursive:true});
 writeFileSync(join(directory,'protocol-membership.test.mjs'),'// Discovery fixture only.');
 const plan=developmentPlan(f.cwd,{groups:'editor',browsers:'none'}),editor=plan.gates.find(g=>g.id==='node:editor');
 assert.ok(editor.completionPrerequisites);assert.ok(editor.dependencies.includes('build-app'));
 const appIndex=plan.gates.findIndex(g=>g.id==='build-app'),editorIndex=plan.gates.findIndex(g=>g.id==='node:editor');
 assert.ok(appIndex>=0);assert.ok(appIndex<editorIndex);assert.equal(plan.browserPlan,null);
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


test('allocated output is fresh, allocation environment is explicit, and audit binds an immutable raw receipt',async t=>{
 const f=fixture(t),output=join(f.cwd,'allocated','run'),options={groups:'preflight',browsers:'none',workers:1,output};
 const held=()=>{assert.ok(existsSync(join(f.cwd,'artifacts/qualification/active.lock')));assert.ok(existsSync(lease.path));};let lease;
 const result=await executeDevelopment({...f,options,environment:{IE_EVIDENCE_ALLOCATION:'/provided/allocation.json'},hostLeaseProvider:async id=>{lease=await f.hostLeaseProvider(id);return lease;},
  monitorFactory:async args=>{held();assert.equal(args.allocationPath,'/provided/allocation.json');return f.monitorFactory(args);},
  auditRetainer:async(...args)=>{held();return f.auditRetainer(...args);},auditVerifier:async(...args)=>{held();return f.auditVerifier(...args);},gateExecutor:executor([])});
 assert.equal(result.directory,output);assert.equal(result.rawOutcome,'PASS');assert.equal(result.effectiveOutcome,'PASS');
 const raw=readFileSync(result.receiptPath);assert.deepEqual(raw,f.evidence.runs.get(output).bytes);
 const parsed=JSON.parse(raw);assert.equal(parsed.evidenceStorage.status,'PENDING');assert.equal(Object.hasOwn(parsed,'effectiveOutcome'),false);
 assert.deepEqual(f.evidence.events.slice(0,4),['start','finish','retain','verify']);assert.equal(existsSync(lease.path),false);
 const cache=JSON.parse(readFileSync(join(f.cwd,'artifacts/validation/cache.json')));assert.deepEqual(cache.entries.typecheck.origin,{receiptPath:result.receiptPath,receiptIdentity:{bytes:raw.length,sha256:sha256(raw)}});
 await assert.rejects(executeDevelopment({...f,options,gateExecutor:executor([])}),/EEXIST/);
 assert.equal(argumentsFor(['run','--output',output]).output,output);assert.throws(()=>argumentsFor(['run','--output']),/incomplete/);
});

test('strict production monitor rejects missing allocation before any source or gate work',async t=>{
 const f=fixture(t),calls=[];let reads=0;
 const result=await executeDevelopment({...f,monitorFactory:undefined,environment:{},options:{groups:'preflight'},sourceProvider:()=>{reads++;return f.sourceProvider();},gateExecutor:executor(calls)});
 assert.equal(result.effectiveOutcome,'FAIL');assert.match(result.error,/IE_EVIDENCE_ALLOCATION/);assert.deepEqual(calls,[]);
 assert.equal(reads,0,'allocation refusal precedes all source hashing');
 assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
});

for(const initial of [{status:'INCONCLUSIVE',level:'unknown',percent:null},{status:'FAIL',level:'ceiling',percent:90},null])test(`initial evidence ${initial?.status??'UNAVAILABLE'} refuses work but retains the original admission and releases ownership`,async t=>{
 const f=fixture(t),calls=[],options={groups:'preflight',browsers:'chromium',browserGroups:'consumer',workers:1,fresh:true};let sourceReads=0,dependencyReads=0;
 f.evidence.initialAlarm=initial;f.evidence.status=initial?.status??'INCONCLUSIVE';
 const original=f.monitorFactory;
 const result=await executeDevelopment({...f,options,
  monitorFactory:async args=>{const monitor=await original(args);if(initial)args.onAlarm({allocationId:'synthetic',campaignId:args.campaignId,status:'PASS',level:'normal',percent:1});return monitor;},
  sourceProvider:()=>{sourceReads++;return f.sourceProvider();},dependencyProvider:()=>{dependencyReads++;return f.dependencyProvider();},gateExecutor:executor(calls)});
 assert.equal(result.rawOutcome,initial?.status??'INCONCLUSIVE');assert.equal(result.effectiveOutcome,initial?.status??'INCONCLUSIVE');assert.match(result.error,/Initial evidence storage .*validation was not started/);
 assert.equal(sourceReads,0);assert.equal(dependencyReads,0);assert.deepEqual(calls,[]);assert.deepEqual(result.gates,[]);assert.deepEqual(result.browsers,[]);
 assert.deepEqual(result.pending,result.plan.gates.map(gate=>gate.id));assert.deepEqual(result.pendingBrowsers,['build-consumer','consumer-chromium']);
 assert.deepEqual(f.evidence.events,['start','finish','retain','verify']);assert.deepEqual(readFileSync(result.receiptPath),f.evidence.runs.get(result.directory).bytes);
 const retained=JSON.parse(readFileSync(join(result.directory,'evidence-storage/audit.json')));assert.equal(retained.outcome,result.rawOutcome);
 assert.deepEqual(retained.initialAlarm,initial?{allocationId:'synthetic',campaignId:result.id,...initial}:null);
 assert.equal(result.sourceStable,false);assert.equal(result.dependenciesUnchanged,false);assert.deepEqual(result.finalizationErrors,[]);assert.deepEqual(result.lifecycleErrors,[]);
 assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);assert.equal(existsSync(result.hostExclusion.path),false);
});

for(const [level,percent]of [['normal',1],['target',80]])test(`initial evidence PASS at ${level} admits the full selected gate flow and retained audit`,async t=>{
 const f=fixture(t),calls=[];let sourceReads=0,dependencyReads=0;f.evidence.initialAlarm={status:'PASS',level,percent};
 const result=await executeDevelopment({...f,options:{groups:'preflight',browsers:'none',workers:1,fresh:true},
  sourceProvider:()=>{sourceReads++;return f.sourceProvider();},dependencyProvider:()=>{dependencyReads++;return f.dependencyProvider();},gateExecutor:executor(calls)});
 assert.equal(result.rawOutcome,'PASS');assert.equal(result.effectiveOutcome,'PASS');assert.deepEqual(calls,['typecheck','preflight']);assert.deepEqual(result.pending,[]);assert.deepEqual(result.pendingBrowsers,[]);
 assert.equal(sourceReads,2);assert.equal(dependencyReads,2);assert.equal(result.sourceStable,true);assert.equal(result.dependenciesUnchanged,true);
 assert.equal(f.evidence.events.filter(value=>value==='finish').length,1);assert.equal(f.evidence.events.filter(value=>value==='retain').length,1);assert.deepEqual(f.evidence.events.slice(0,4),['start','finish','retain','verify']);
 assert.deepEqual(readFileSync(result.receiptPath),f.evidence.runs.get(result.directory).bytes);assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),true);
 assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);assert.equal(existsSync(result.hostExclusion.path),false);
});

for(const auditStatus of ['FAIL','INCONCLUSIVE'])test(`audit ${auditStatus} prevents effective PASS and cache publication`,async t=>{
 const f=fixture(t);f.evidence.status=auditStatus;
 const result=await executeDevelopment({...f,options:{groups:'preflight'},gateExecutor:executor([])});
 assert.equal(result.rawOutcome,'PASS');assert.equal(result.effectiveOutcome,auditStatus);
 assert.equal(JSON.parse(readFileSync(result.receiptPath)).outcome,'PASS');assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);
 assert.deepEqual(readFileSync(result.receiptPath),f.evidence.runs.get(result.directory).bytes);
});

test('functional FAIL wins over audit uncertainty and retains its passing prefix without relabeling',async t=>{
 const f=fixture(t);f.evidence.status='INCONCLUSIVE';
 const result=await executeDevelopment({...f,options:{groups:'preflight'},gateExecutor:executor([],'preflight')});
 assert.equal(result.rawOutcome,'FAIL');assert.equal(result.effectiveOutcome,'FAIL');assert.equal(result.gates[0].observation.outcome,'PASS');
 assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);
});

for(const stage of ['finish','retain','verify'])test(`${stage} failure attempts audit shutdown/retention, releases ownership and prevents cache`,async t=>{
 const f=fixture(t),options={groups:'preflight'};let retained=0;
 const original=f.monitorFactory;
 if(stage==='finish')f.monitorFactory=async args=>{const monitor=await original(args);return {...monitor,async finish(args){await monitor.finish(args);throw Error('finish fault');}};};
 const retainer=f.auditRetainer;f.auditRetainer=async(...args)=>{retained++;if(stage==='retain')throw Error('retain fault');return retainer(...args);};
 if(stage==='verify')f.auditVerifier=async()=>{throw Error('verify fault');};
 const result=await executeDevelopment({...f,options,gateExecutor:executor([])});
 assert.equal(result.rawOutcome,'PASS');assert.equal(result.effectiveOutcome,'FAIL');assert.equal(retained,1);
 assert.equal(f.evidence.events.filter(x=>x==='finish').length,1);assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
 assert.equal(existsSync(result.hostExclusion.path),false);assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);
 assert.deepEqual(readFileSync(result.receiptPath),f.evidence.runs.get(result.directory).bytes);
});

for(const identityKind of ['source','dependency'])test(`final ${identityKind} identity failure still seals and audits an inconclusive raw receipt`,async t=>{
 const f=fixture(t);let reads=0;const key=identityKind==='source'?'sourceProvider':'dependencyProvider',read=f[key];
 f[key]=()=>{if(++reads===2)throw Error(`${identityKind} final fault`);return read();};
 const result=await executeDevelopment({...f,options:{groups:'preflight'},gateExecutor:executor([])});
 assert.equal(result.rawOutcome,'INCONCLUSIVE');assert.equal(result.effectiveOutcome,'INCONCLUSIVE');assert.equal(result.finalizationErrors.length,1);
 assert.deepEqual(f.evidence.events.slice(0,4),['start','finish','retain','verify']);assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);
 assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
});

test('a final receipt-save failure cannot skip monitor finish, retention attempt or lock release',async t=>{
 const f=fixture(t);let reads=0,retained=0;const provider=f.sourceProvider;
 f.sourceProvider=()=>{if(++reads===2){const file=join(f.evidence.lastOptions.output,'receipt.json');rmSync(file);mkdirSync(file);}return provider();};
 f.auditRetainer=async()=>{retained++;throw Error('raw receipt unavailable');};
 const result=await executeDevelopment({...f,options:{groups:'preflight'},gateExecutor:executor([])});
 assert.equal(result.effectiveOutcome,'FAIL');assert.equal(retained,1);assert.equal(f.evidence.events.filter(x=>x==='finish').length,1);
 assert.equal(f.evidence.runs.get(result.directory).receiptPath,null);assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
 assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);
});

for(const corruption of ['legacy','null-entries','malformed-entry','origin-identity','gate-metadata','unrelated-audit'])test(`cache ${corruption} is refused as credit and the gate executes`,async t=>{
 const f=fixture(t),options={groups:'preflight'};const first=await executeDevelopment({...f,options,gateExecutor:executor([])});
 const path=join(f.cwd,'artifacts/validation/cache.json'),cache=JSON.parse(readFileSync(path));
 if(corruption==='legacy')delete cache.entries.typecheck.origin;
 if(corruption==='null-entries')cache.entries=null;
 if(corruption==='malformed-entry')delete cache.entries.typecheck.observation;
 if(corruption==='origin-identity')cache.entries.typecheck.origin.receiptIdentity.sha256='0'.repeat(64);
 if(corruption==='gate-metadata')cache.entries.typecheck.elapsedMs++;
 if(corruption==='unrelated-audit'){const audit=join(first.directory,'evidence-storage/audit.json'),record=JSON.parse(readFileSync(audit));record.auditId='another-run';writeFileSync(audit,JSON.stringify(record));}
 writeFileSync(path,JSON.stringify(cache));const calls=[],next=await executeDevelopment({...f,options,gateExecutor:executor(calls)});
 assert.equal(next.effectiveOutcome,'PASS');assert.ok(calls.includes('typecheck'));assert.equal(next.gates[0].mode,'executed');
});

test('explicit resume refuses an unaudited legacy receipt and a non-PASS originating audit',async t=>{
 const f=fixture(t),options={groups:'tooling'},first=await executeDevelopment({...f,options,gateExecutor:executor([],'node:qualification')});
 const raw=JSON.parse(readFileSync(first.receiptPath));delete raw.evidenceStorage;
 const legacy=join(f.cwd,'legacy.json');writeFileSync(legacy,JSON.stringify(raw));const calls=[];
 const invalid=await executeDevelopment({...f,options:{...options,resume:legacy},gateExecutor:executor(calls)});
 assert.equal(invalid.effectiveOutcome,'FAIL');assert.deepEqual(calls,[]);
 const audit=join(first.directory,'evidence-storage/audit.json'),record=JSON.parse(readFileSync(audit));record.status='INCONCLUSIVE';writeFileSync(audit,JSON.stringify(record));
 const denied=await executeDevelopment({...f,options:{...options,resume:first.receiptPath},gateExecutor:executor(calls)});
 assert.equal(denied.effectiveOutcome,'FAIL');assert.deepEqual(calls,[]);
});


test('an inconclusive raw gate outcome preserves existing cache rather than publishing unusable credit',async t=>{
 const f=fixture(t),options={groups:'preflight'},first=await executeDevelopment({...f,options,gateExecutor:executor([])});
 const cachePath=join(f.cwd,'artifacts/validation/cache.json'),before=readFileSync(cachePath),run=executor([]);
 const result=await executeDevelopment({...f,options:{...options,fresh:true},gateExecutor:async(...args)=>{const value=await run(...args);return args[0].id==='preflight'?{...value,outcome:'INCONCLUSIVE'}:value;}});
 assert.equal(result.rawOutcome,'INCONCLUSIVE');assert.equal(result.effectiveOutcome,'INCONCLUSIVE');assert.deepEqual(readFileSync(cachePath),before);
});


for(const identityKind of ['source','dependency'])test(`initial ${identityKind} identity failure still finishes the owned evidence observer`,async t=>{
 const f=fixture(t),calls=[];let reads=0;const key=identityKind==='source'?'sourceProvider':'dependencyProvider',read=f[key];
 f[key]=()=>{if(++reads===1)throw Error(`${identityKind} initial fault`);return read();};
 const result=await executeDevelopment({...f,options:{groups:'preflight'},gateExecutor:executor(calls)});
 assert.equal(result.effectiveOutcome,'FAIL');assert.deepEqual(calls,[]);assert.equal(reads,2);
 assert.deepEqual(f.evidence.events.slice(0,4),['start','finish','retain','verify']);assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);
 assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
});

test('cache publication failure is reported after the raw receipt is audited without rewriting it',async t=>{
 const f=fixture(t),retainer=f.auditRetainer,cachePath=join(f.cwd,'artifacts/validation/cache.json');
 f.auditRetainer=async(...args)=>{const retained=await retainer(...args);mkdirSync(cachePath);return retained;};
 const result=await executeDevelopment({...f,options:{groups:'preflight'},gateExecutor:executor([])});
 assert.equal(result.rawOutcome,'PASS');assert.equal(result.effectiveOutcome,'FAIL');assert.ok(result.lifecycleErrors.some(error=>error.stage==='cache-publish'));
 assert.deepEqual(readFileSync(result.receiptPath),f.evidence.runs.get(result.directory).bytes);assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
});

test('a host release error preserves audited raw bytes and still releases the checkout lock',async t=>{
 const f=fixture(t),provider=f.hostLeaseProvider;
 f.hostLeaseProvider=async id=>{const lease=await provider(id);return {...lease,async release(){await lease.release();throw Error('release report fault');}};};
 const result=await executeDevelopment({...f,options:{groups:'preflight'},gateExecutor:executor([])});
 assert.equal(result.rawOutcome,'PASS');assert.equal(result.effectiveOutcome,'FAIL');assert.ok(result.lifecycleErrors.some(error=>error.stage==='host-release'));
 assert.deepEqual(readFileSync(result.receiptPath),f.evidence.runs.get(result.directory).bytes);assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);
 assert.equal(existsSync(result.hostExclusion.path),false);
});


// Independent caller inventory: 18 direct installer files, including portable
// compatibility's two additional legacyMigration prior-writer reopens. This is fixture scheduling, not packet credit.
const schema18Consumers = [
 'tests/assets/storage.test.mjs',
 'tests/candidates/compatibility.test.mjs',
 'tests/composition/schema.test.mjs',
 'tests/history/mask-schema.test.mjs',
 'tests/history/retained-mask-schema.test.mjs',
 'tests/history/schema.test.mjs',
 'tests/portable/compatibility.test.mjs',
 'tests/portable/legacy.test.mjs',
 'tests/portable/schema.test.mjs',
 'tests/portable/transaction-schema.test.mjs',
 'tests/protocol/recovery.test.mjs',
 'tests/raster/schema.test.mjs',
 'tests/raster/storage.test.mjs',
 'tests/recovery/compatibility.test.mjs',
 'tests/recovery/p2-schema.test.mjs',
 'tests/recovery/request-family-schema.test.mjs',
 'tests/text-state/placement-schema.test.mjs',
 'tests/text-state/schema.test.mjs',
];
function addSchema18DiscoveryFiles(cwd){
 for(const file of schema18Consumers)writeFileSync(join(cwd,file),'// Exact migration discovery fixture.');
}

test('only exact schema18 fixture consumers require fresh execution in formal and split development gates',t=>{
 const f=fixture(t);addSchema18DiscoveryFiles(f.cwd);
 for(const file of ['tests/history/mask-text-compatibility.test.mjs','tests/text-state/native.test.mjs','tests/portable/compatibility-copy.test.mjs','tests/recovery/unrelated.test.mjs'])writeFileSync(join(f.cwd,file),'// Discovery fixture.');
 const formal=functionalGates(f.cwd),plan=developmentPlan(f.cwd,{groups:'all',browsers:'none'});
 for(const gates of [formal,plan.gates]){
  assert.deepEqual(gates.flatMap(gate=>gate.freshFixtureFiles??[]).sort(),schema18Consumers);
  for(const gate of gates)for(const file of gate.freshFixtureFiles??[])assert.ok(gate.files.includes(file));
  assert.equal(gates.find(gate=>gate.id==='node:store').guard,'tests/store/no-network.mjs');
  assert.equal(gates.find(gate=>gate.id==='node:assets').guard,'tests/session/no-egress.mjs');
  assert.equal(gates.find(gate=>gate.id==='node:editor-capability-preflight').freshFixtureFiles,undefined);
 }
 for(const id of ['node:history:browser','node:text-state:browser']){
  const hosted=plan.gates.find(gate=>gate.id===id);assert.ok(hosted.browserPrerequisites);assert.equal(hosted.freshFixtureFiles,undefined);
 }
 assert.ok(plan.gates.find(gate=>gate.id==='node:text-state:browser').fixtureBuild);
 assert.equal(plan.selectedFiles.length,new Set(plan.selectedFiles).size);
});

test('audited resume reruns all schema18 prepared fixture gates and cannot reuse their prior installer success',async t=>{
 const f=fixture(t);addSchema18DiscoveryFiles(f.cwd);
 const options={groups:'all',browsers:'none',workers:1},environment={IE_SCHEMA18_EXECUTABLE_PACKET:'/synthetic/schema18/packet.json'};
 const prepared=[],run=executor([]);
 const gateExecutor=async(gate,directory,env,...args)=>{
  assert.equal(env.IE_SCHEMA18_EXECUTABLE_PACKET,environment.IE_SCHEMA18_EXECUTABLE_PACKET);
  prepared.push(...(gate.freshFixtureFiles??[]));return run(gate,directory,env,...args);
 };
 const first=await executeDevelopment({...f,options,environment,gateExecutor});assert.equal(first.effectiveOutcome,'PASS');
 assert.deepEqual(prepared.sort(),schema18Consumers);prepared.length=0;
 const resumed=await executeDevelopment({...f,options:{...options,resume:first.receiptPath},environment,gateExecutor});
 assert.equal(resumed.effectiveOutcome,'PASS');assert.deepEqual(prepared.sort(),schema18Consumers);
 for(const gate of resumed.plan.gates.filter(gate=>gate.freshFixtureFiles?.length))assert.equal(resumed.gates.find(entry=>entry.observation.id===gate.id).mode,'executed');
 assert.equal(resumed.gates.find(entry=>entry.observation.id==='node:store').mode,'reused');
 // The path and source identities stay the same, but current preparation now fails.
 // Its old PASS cannot bypass execution or grant packet admission.
 const calls=[],failed=await executeDevelopment({...f,options:{...options,resume:first.receiptPath},environment,gateExecutor:executor(calls,'node:assets')});
 assert.equal(failed.effectiveOutcome,'FAIL');assert.ok(calls.includes('node:assets'));
 assert.equal(failed.gates.find(entry=>entry.observation.id==='node:assets').mode,'executed');
 assert.equal(JSON.parse(readFileSync(first.receiptPath)).outcome,'PASS');
});


test('development text verification precedes each product build and consumer-only preparation without repeating types',t=>{
 const f=fixture(t);
 for(const groups of ['portable','qualification','session']){
  const plan=developmentPlan(f.cwd,{groups,browsers:'none'}),ids=plan.gates.map(gate=>gate.id);
  assert.equal(ids.filter(id=>id==='typecheck').length,1);assert.equal(ids.filter(id=>id==='text-inputs').length,1);
  assert.ok(ids.indexOf('vendor')<ids.indexOf('text-inputs'));assert.ok(ids.indexOf('text-inputs')<ids.indexOf('imports'));
  for(const build of ['build-app','build-server'])if(ids.includes(build))assert.ok(ids.indexOf('text-inputs')<ids.indexOf(build));
 }
 const consumer=developmentPlan(f.cwd,{groups:'preflight',browsers:'chromium',browserGroups:'consumer',output:'/synthetic/text-inputs'});
 assert.ok(consumer.gates.some(gate=>gate.id==='text-inputs'));assert.equal(consumer.gates.some(gate=>gate.id==='build-app'||gate.id==='build-server'),false);
 assert.deepEqual(consumer.browserPlan.steps.map(step=>step.id),['build-consumer','consumer-chromium']);
 assert.deepEqual(developmentPlan(f.cwd,{groups:'preflight',browsers:'none'}).gates.map(gate=>gate.id),['typecheck','preflight']);
});

test('text input cache binds profile, complete recipe source and installed CanvasKit bytes',t=>{
 const f=fixture(t),gate={id:'text-inputs',command:['npm','run','verify:text'],dependencies:['vendor']};
 const paths=['src/text/profile.json','vendor/text/manifest.json','src/text/returned-description.ts','server/storage/text.ts','tests/text-state/verifier.vite.config.ts','src/text/retained-profiles/68efa85f.json','tooling/text/verify.mjs','tooling/text/source-closure.json','tooling/text/canvaskit-registry.json','vendor/text/FILES.json','vendor/text/font-records.json','vendor/text/canvaskit-wasm-0.40.0-ideogram.3.tgz'];
 const source={files:paths.map((path,index)=>({path,bytes:index+1,sha256:String(index)}))};
 const dependencyRoot=join(f.cwd,'node_modules/canvaskit-wasm');mkdirSync(join(dependencyRoot,'bin'),{recursive:true});mkdirSync(join(dependencyRoot,'types'));
 const installed=['bin/canvaskit.js','bin/canvaskit.wasm','types/index.d.ts'];for(const path of installed)writeFileSync(join(dependencyRoot,path),'synthetic sealed bytes');
 const environment=()=>({dependencies:treeIdentity(join(f.cwd,'node_modules')).digest}),key=gateInputKey(gate,source,environment());
 for(const path of paths){const changed=structuredClone(source);changed.files.find(file=>file.path===path).sha256+='-changed';assert.notEqual(gateInputKey(gate,changed,environment()),key,path);}
 for(const path of installed){writeFileSync(join(dependencyRoot,path),'different installed bytes');assert.notEqual(gateInputKey(gate,source,environment()),key,path);writeFileSync(join(dependencyRoot,path),'synthetic sealed bytes');}
 const entry={key,observation:{outcome:'PASS'}};assert.equal(reusable(entry,key,f.cwd,gate),true);assert.equal(reusable(entry,'different',f.cwd,gate),false);
 assert.equal(reusable({...entry,observation:{outcome:'FAIL'}},key,f.cwd,gate),false);
});

test('a text verification failure stops before imports, app/server builds and selected tests',async t=>{
 const f=fixture(t),calls=[],result=await executeDevelopment({...f,options:{groups:'session',browsers:'none'},gateExecutor:executor(calls,'text-inputs')});
 assert.equal(result.effectiveOutcome,'FAIL');assert.equal(calls.at(-1),'text-inputs');assert.equal(calls.filter(id=>id==='typecheck').length,1);
 for(const id of ['imports','build-app','build-server','node:session']){assert.equal(calls.includes(id),false);assert.ok(result.pending.includes(id));}
 const cache=JSON.parse(readFileSync(join(f.cwd,'artifacts/validation/cache.json')));assert.equal(cache.entries['text-inputs'],undefined);
});

test('text verification reuse requires unchanged profile and dependency identity with an audited origin',async t=>{
 const f=fixture(t),options={groups:'store',browsers:'none'};f.files.push({path:'src/text/profile.json',bytes:1,sha256:'sealed-profile'});
 const first=await executeDevelopment({...f,options,gateExecutor:executor([])});assert.equal(first.effectiveOutcome,'PASS');
 const calls=[],second=await executeDevelopment({...f,options,gateExecutor:executor(calls)});assert.equal(second.effectiveOutcome,'PASS');
 assert.equal(calls.includes('text-inputs'),false);assert.equal(second.gates.find(entry=>entry.observation.id==='text-inputs').mode,'reused');
 const cache=JSON.parse(readFileSync(join(f.cwd,'artifacts/validation/cache.json')));assert.ok(cache.entries['text-inputs'].origin.receiptIdentity);
 f.files.find(file=>file.path==='src/text/profile.json').sha256='changed-profile';const profileCalls=[];
 await executeDevelopment({...f,options,gateExecutor:executor(profileCalls)});assert.ok(profileCalls.includes('text-inputs'));
 const dependencyCalls=[];await executeDevelopment({...f,options,dependencyProvider:()=>({digest:'changed-installed-bytes'}),gateExecutor:executor(dependencyCalls)});assert.ok(dependencyCalls.includes('text-inputs'));
});


// Real small local fixtures; these check identity equivalence and event-loop
// progress, not a performance pass or an invented sampling-time tolerance.
function identityFixture(t){
 const cwd=realpathSync(mkdtempSync(join(tmpdir(),'development-identity-')));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Identity Fixture','-c','user.email=fixture@invalid',...args],{cwd,stdio:'pipe'});
 git('init','--quiet');mkdirSync(join(cwd,'src'));mkdirSync(join(cwd,'docs'));mkdirSync(join(cwd,'docs/spec'));
 writeFileSync(join(cwd,'src/kept.ts'),'retained source');writeFileSync(join(cwd,'src/deleted.ts'),'deleted source');
 writeFileSync(join(cwd,'docs/spec/input.md'),'included');writeFileSync(join(cwd,'docs/other.md'),'excluded');
 git('add','.');git('commit','--quiet','-m','synthetic identity fixture');unlinkSync(join(cwd,'src/deleted.ts'));
 writeFileSync(join(cwd,'src/untracked.ts'),'included untracked');
 return {cwd,git};
}
test('async source identity preserves exact synchronous membership, ordering, hashes and deletion markers',async t=>{
 const {cwd}=identityFixture(t),expected=sourceIdentity(cwd),actual=await sourceIdentityAsync(cwd);
 assert.deepEqual(actual,expected);assert.deepEqual(actual.files.find(row=>row.path==='src/deleted.ts'),{path:'src/deleted.ts',deleted:true});
 assert.ok(actual.files.some(row=>row.path==='src/untracked.ts'));assert.equal(actual.files.some(row=>row.path==='docs/other.md'),false);
 symlinkSync('kept.ts',join(cwd,'src/link.ts'));assert.throws(()=>sourceIdentity(cwd),/regular file/);await assert.rejects(sourceIdentityAsync(cwd),/Regular evidence file/);
 await assert.rejects(sourceIdentityAsync(join(cwd,'missing')),/Cannot enumerate source identity/);
});
test('async dependency and output identities preserve modes, internal links and cache refusals',async t=>{
 const {cwd}=identityFixture(t),tree=join(cwd,'node_modules'),directory=join(tree,'package');mkdirSync(directory,{recursive:true});
 writeFileSync(join(directory,'main.js'),'retained dependency');chmodSync(join(directory,'main.js'),0o755);symlinkSync('package/main.js',join(tree,'internal'));
 assert.deepEqual(await treeIdentityAsync(tree),treeIdentity(tree));assert.equal(await treeIdentityAsync(join(cwd,'absent')),null);
 const app=join(cwd,'dist/app');mkdirSync(app,{recursive:true});writeFileSync(join(app,'main.js'),'retained output');
 const gate={id:'build-app'},outputs=outputIdentity(cwd,gate),entry={key:'same',observation:{outcome:'PASS'},outputs};
 assert.deepEqual(await outputIdentityAsync(cwd,gate),outputs);assert.equal(await reusableAsync(entry,'same',cwd,gate),true);
 writeFileSync(join(app,'main.js'),'changed output');assert.equal(await reusableAsync(entry,'same',cwd,gate),false);assert.equal(await reusableAsync(entry,'other',cwd,gate),false);
 assert.equal(await reusableAsync(entry,'same',cwd,{...gate,files:['owned.test.mjs']}),false);
 symlinkSync('../src/kept.ts',join(tree,'external'));assert.throws(()=>treeIdentity(tree),/External dependency link/);await assert.rejects(treeIdentityAsync(tree),/External dependency link/);
});
test('actual async identity reads allow a pending monitor timer to run before hashing finishes',async t=>{
 const {cwd}=identityFixture(t),tree=join(cwd,'node_modules');mkdirSync(tree);
 const data=Buffer.alloc(2*1024*1024,37);writeFileSync(join(cwd,'src/large.ts'),data);writeFileSync(join(tree,'large.bin'),data);
 for(const read of [()=>sourceIdentityAsync(cwd),()=>treeIdentityAsync(tree)]){
  let finished=false,observedDuringRead=false;const timer=setTimeout(()=>{observedDuringRead=!finished;},0);
  try{await read();}finally{finished=true;clearTimeout(timer);}
  assert.equal(observedDuringRead,true,'real pending timer must interleave with identity reads');
 }
});
test('development awaits asynchronous source identities before gates and before immutable receipt finalization',async t=>{
 const f=fixture(t),events=[],source=f.sourceProvider,dependency=f.dependencyProvider,monitor=f.monitorFactory;
 let reads=0;
 const result=await executeDevelopment({...f,options:{groups:'preflight',browsers:'none',fresh:true},
  sourceProvider:async()=>{const phase=++reads===1?'before':'after';events.push(phase+'-start');await new Promise(resolve=>setImmediate(resolve));events.push(phase+'-end');return source();},
  dependencyProvider:async()=>{events.push('dependency');return dependency();},
  monitorFactory:async options=>{const owner=await monitor(options);return {...owner,async finish(args){events.push('finish');assert.ok(events.includes('after-end'));return owner.finish(args);}};},
  gateExecutor:async(...args)=>{assert.ok(events.includes('before-end'));return executor([])(...args);}});
 assert.equal(result.effectiveOutcome,'PASS');assert.deepEqual(events,['before-start','before-end','dependency','after-start','after-end','dependency','finish']);
 const receipt=JSON.parse(readFileSync(result.receiptPath));assert.deepEqual(receipt.before,receipt.after);assert.ok(Array.isArray(receipt.after.files));
});
test('an asynchronous final source identity refusal still drains audit ownership and cannot publish reuse',async t=>{
 const f=fixture(t),source=f.sourceProvider;let reads=0;
 const result=await executeDevelopment({...f,options:{groups:'preflight',browsers:'none',fresh:true},sourceProvider:async()=>{if(++reads===2)throw Error('synthetic asynchronous source-after refusal');return source();},gateExecutor:executor([])});
 assert.equal(result.effectiveOutcome,'INCONCLUSIVE');assert.equal(result.finalizationErrors[0].stage,'source-after');assert.ok(f.evidence.events.includes('finish'));assert.ok(f.evidence.events.includes('retain'));
 assert.equal(existsSync(join(f.cwd,'artifacts/qualification/active.lock')),false);assert.equal(existsSync(join(f.cwd,'artifacts/validation/cache.json')),false);
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
 for(const file of buildFreeFastNodeFiles)assert.equal(plan.selectedFiles.filter(f=>f===file).length,1);
 assert(fast.command.includes('./tests/session/no-egress.mjs'));assert(fast.command.includes('--test-concurrency=1'));assert(!fast.browserPrerequisites);
 const focused=developmentPlan(process.cwd(),{groups:'export',nodeFiles:buildFreeFastNodeFiles.join(','),output:'/tmp/validation-plan'});assert.deepEqual(focused.gates.map(g=>g.id),['typecheck','preflight','node:export:fast']);
 const f=fixture(t);for(const file of buildFreeFastNodeFiles)writeFileSync(join(f.cwd,file),'// reviewed fixture');
 const calls=[],receipt=await executeDevelopment({...f,options:{groups:'all',browsers:'none',workers:1,fresh:true},gateExecutor:executor(calls,'node:export:fast')});
 assert.equal(receipt.outcome,'FAIL');assert(!calls.includes('build-server'));assert(!calls.includes('vendor'));assert(receipt.pending.includes('node:store'));
});


test('focused editor batching retains dedicated managed browser fixture ownership',()=>{
 const options={groups:'preflight',browsers:'all',browserGroups:'editor-composition,editor-display-image,editor-candidate-comparison,editor-document-creation,editor-command-search',output:'/tmp/mixed-editor-fixtures'};
 const serial=developmentPlan(process.cwd(),options),batch=developmentPlan(process.cwd(),{...options,batchEditor:true});
 const membership=plan=>plan.browserPlan.steps.filter(step=>step.config).flatMap(step=>step.files.map(file=>step.browser+':'+file)).sort();
 assert.deepEqual(membership(batch),membership(serial));
 for(const step of batch.browserPlan.steps.filter(step=>step.family==='editor-batch'))assert.deepEqual(step.files,['tests/editor/composition.spec.ts']);
 for(const family of ['editor-display-image','editor-candidate-comparison','editor-document-creation','editor-command-search'])assert.deepEqual(batch.browserPlan.steps.filter(step=>step.family===family),serial.browserPlan.steps.filter(step=>step.family===family));
 const all=developmentPlan(process.cwd(),{groups:'preflight',browsers:'all',batchEditor:true,output:'/tmp/full-editor-fixtures'});
 assert.equal(all.browserPlan.steps.filter(step=>step.family==='editor-batch').length,3);
 for(const step of all.browserPlan.steps.filter(step=>step.family==='editor-batch'))assert.equal(step.files.some(file=>['display-image','candidate-comparison','document-creation','command-search'].some(name=>file==='tests/editor/'+name+'.spec.ts')),false);
});

test('committed selectors retain allocated output and managed fixture freshness',()=>{
 const args=argumentsFor(['run','--groups','assets','--node-files','tests/assets/storage.test.mjs','--output','/tmp/allocated-fresh','--browsers','chromium','--browser-groups','editor-composition','--browser-grep','Composition']);
 assert.equal(args.output,'/tmp/allocated-fresh');assert.equal(args.nodeFiles,'tests/assets/storage.test.mjs');assert.equal(args.browserGrep,'Composition');
 const plan=developmentPlan(process.cwd(),{groups:'assets',nodeFiles:args.nodeFiles,output:'/tmp/fixture-freshness'}),gate=plan.gates.find(gate=>gate.id==='node:assets');
 assert.deepEqual(gate.files,['tests/assets/storage.test.mjs']);assert.deepEqual(gate.freshFixtureFiles,['tests/assets/storage.test.mjs']);
});


test('focused eager completion consumers prepare current issuers without independent capture',t=>{
 const f=fixture(t),directory=join(f.cwd,'tests/editor/completion');mkdirSync(directory,{recursive:true});
 const names=['ancillary-favicon','busy-state','candidate-corrections','font-state','header-receipt','host-final','operation','protocol-membership','receipts','restored-native','handler-source'];
 for(const name of names)writeFileSync(join(directory,`${name}.test.mjs`),'// Discovery fixture only; never imported.');
 for(const name of names){
  const file=`tests/editor/completion/${name}.test.mjs`,plan=developmentPlan(f.cwd,{groups:'editor',browsers:'none',nodeFiles:file});
  const gate=plan.gates.find(g=>g.id==='node:editor');
  assert.deepEqual(gate.files,[file]);assert.deepEqual(plan.selectedFiles,[file]);
  assert.deepEqual(gate.command,['node','--import','./tests/session/no-egress.mjs','--test','--test-reporter=tap','--test-concurrency=1',file]);
  assert.deepEqual(gate.completionPrerequisites,{kind:['protocol-membership','handler-source'].includes(name)?'current-issuers-original-monitor-independent-capture-1':'current-issuers-1'});
  assert.ok(gate.dependencies.includes('build-app'));
  assert.ok(plan.gates.findIndex(g=>g.id==='completion-source')<plan.gates.findIndex(g=>g.id==='build-app'));
  assert.ok(plan.gates.findIndex(g=>g.id==='build-app')<plan.gates.indexOf(gate));assert.equal(plan.browserPlan,null);
 }
 assert.equal(functionalGates(f.cwd).find(g=>g.id==='node:editor').completionPrerequisites.kind,'current-issuers-original-monitor-independent-capture-1');
});

test('focused unrelated editor files do not inherit another file completion preparation',t=>{
 const f=fixture(t),directory=join(f.cwd,'tests/editor/completion');mkdirSync(directory,{recursive:true});
 writeFileSync(join(directory,'protocol-membership.test.mjs'),'// Discovery fixture only.');
 const plan=developmentPlan(f.cwd,{groups:'editor',browsers:'none',nodeFiles:'tests/editor/fixture.test.mjs'}),gate=plan.gates.find(g=>g.id==='node:editor');
 assert.equal(gate.completionPrerequisites,undefined);assert.equal(gate.dependencies.includes('build-app'),false);
 assert.equal(plan.gates.some(g=>g.id==='completion-source'||g.id==='build-app'),false);
 assert.deepEqual(gate.files,['tests/editor/fixture.test.mjs']);
});


function campaignGuardSelectionFixture(t){
 const f=fixture(t),strict='tests/campaigns/backend-composition-warm.test.mjs',ordinary='tests/campaigns/backend-queue-product.test.mjs',sameBasename='tests/campaigns/nested/backend-composition-warm.test.mjs';
 mkdirSync(join(f.cwd,'tests/campaigns/nested'));
 for(const file of [strict,ordinary,sameBasename])writeFileSync(join(f.cwd,file),'// Guard-routing discovery fixture only.\n');
 return {...f,strict,ordinary,sameBasename};
}

test('development campaign parent aliases preserve formal guard ownership, complete inventory and prerequisite order',t=>{
 const f=campaignGuardSelectionFixture(t),formal=functionalGates(f.cwd),family=['node:campaigns','node:campaigns:store'];
 const formalFamily=formal.filter(gate=>family.includes(gate.id));
 assert.deepEqual(formalFamily.map(gate=>gate.id),family);
 const project=gate=>({id:gate.id,files:gate.files,guard:gate.guard,command:gate.command,requiredEnvironment:gate.requiredEnvironment,selectionGroup:gate.selectionGroup});
 for(const groups of ['campaigns','helpers','all']){
  const plan=developmentPlan(f.cwd,{groups,browsers:'none'}),ids=plan.gates.map(gate=>gate.id),actual=plan.gates.filter(gate=>family.includes(gate.id));
  assert.deepEqual(actual.map(project),formalFamily.map(project),groups);
  assert.equal(plan.selectedFiles.length,new Set(plan.selectedFiles).size,groups);
  assert.equal(ids.length,new Set(ids).size,groups);
  for(const file of formalFamily.flatMap(gate=>gate.files))assert.equal(plan.selectedFiles.filter(value=>value===file).length,1,file);
  const ordinary=actual.find(gate=>gate.id==='node:campaigns'),strict=actual.find(gate=>gate.id==='node:campaigns:store');
  assert.ok(ordinary.files.includes(f.ordinary));assert.ok(ordinary.files.includes(f.sameBasename),'Only the exact declared path acquires the strict guard');
  assert.equal(ordinary.guard,'tests/session/no-egress.mjs');assert.equal(strict.guard,'tests/store/no-network.mjs');
  assert.deepEqual(strict.files,[f.strict]);assert.deepEqual(strict.requiredEnvironment,{IE_CAMPAIGN_PRODUCT_INTEGRATION:'1'});
  assert.deepEqual(strict.command,['node','--import','./tests/store/no-network.mjs','--test','--test-reporter=tap','--test-concurrency=1',f.strict]);
  assert.ok(ids.indexOf('typecheck')<ids.indexOf('preflight'));
  assert.ok(ids.indexOf('preflight')<ids.indexOf('build-server'));
  assert.ok(ids.indexOf('build-server')<ids.indexOf('node:campaigns'));
  assert.equal(ids.indexOf('node:campaigns:store'),ids.indexOf('node:campaigns')+1);
  for(const id of ['typecheck','preflight','build-server'])assert.equal(ids.filter(value=>value===id).length,1,id);
 }
});

test('focused campaign selection accepts strict, ordinary and mixed whole files after expanding their parent',t=>{
 const f=campaignGuardSelectionFixture(t),family=['node:campaigns','node:campaigns:store'];
 const scenarios=[
  {files:[f.strict],ids:['node:campaigns:store'],ordered:[f.strict]},
  {files:[f.ordinary],ids:['node:campaigns'],ordered:[f.ordinary]},
  {files:[f.strict,f.ordinary],ids:family,ordered:[f.ordinary,f.strict]},
  {files:[f.ordinary,f.strict],ids:family,ordered:[f.ordinary,f.strict]},
 ];
 for(const groups of ['campaigns','helpers','all'])for(const scenario of scenarios){
  const plan=developmentPlan(f.cwd,{groups,browsers:'none',nodeFiles:scenario.files.join(',')}),nodes=plan.gates.filter(gate=>gate.files);
  assert.deepEqual(nodes.map(gate=>gate.id),scenario.ids,groups+':'+scenario.files.join(','));
  assert.deepEqual(plan.selectedFiles,scenario.ordered);
  assert.equal(plan.selectedFiles.length,new Set(plan.selectedFiles).size);
  for(const gate of nodes){
   const expected=gate.id==='node:campaigns:store'?{file:f.strict,guard:'tests/store/no-network.mjs'}:{file:f.ordinary,guard:'tests/session/no-egress.mjs'};
   assert.deepEqual(gate.files,[expected.file]);assert.equal(gate.guard,expected.guard);
   assert.deepEqual(gate.command,['node','--import','./'+expected.guard,'--test','--test-reporter=tap','--test-concurrency=1',expected.file]);
   assert.deepEqual(gate.requiredEnvironment,{IE_CAMPAIGN_PRODUCT_INTEGRATION:'1'});
   assert.equal(gate.command.some(arg=>arg.startsWith('--test-name-pattern')||arg.startsWith('--input-type')),false);
  }
  assert.equal(plan.gates.some(gate=>gate.id==='build-app'),false,'These focused files require no browser/app preparation');
 }
 for(const nodeFiles of [f.strict+','+f.strict,'tests/session/fixture.test.mjs'])assert.throws(()=>developmentPlan(f.cwd,{groups:'campaigns',nodeFiles}),/Node file selection/);
 assert.throws(()=>developmentPlan(f.cwd,{groups:'store',nodeFiles:f.strict}),/Node file selection/,'The override does not transfer logical ownership into the store group');
});


import {selectGates as selectWarmGuardGates} from '../../tooling/qualification/manifest.mjs';

test('strict-only campaign discovery retains its virtual parent in formal and development selectors',t=>{
 const f=fixture(t),strict='tests/campaigns/backend-composition-warm.test.mjs';
 rmSync(join(f.cwd,'tests/campaigns/fixture.test.mjs'));
 writeFileSync(join(f.cwd,strict),'// Sole campaign discovery fixture.\n');
 const formal=functionalGates(f.cwd);
 assert.equal(formal.some(gate=>gate.id==='node:campaigns'),false,'An empty ordinary gate cannot acquire test credit');
 assert.deepEqual(formal.find(gate=>gate.id==='node:campaigns:store').files,[strict]);
 for(const selector of ['node:campaigns','helpers','all','node:campaigns:store'])for(const includeDependencies of [true,false]){
  const selected=selectWarmGuardGates(formal,selector,{includeDependencies});
  assert.deepEqual(selected.filter(gate=>gate.selectionGroup==='node:campaigns'||gate.id==='node:campaigns').map(gate=>gate.id),['node:campaigns:store']);
  assert.equal(selected.flatMap(gate=>gate.files??[]).filter(file=>file===strict).length,1);
 }
 for(const groups of ['campaigns','helpers','all'])for(const nodeFiles of [null,strict]){
  const plan=developmentPlan(f.cwd,{groups,browsers:'none',nodeFiles});
  assert.equal(plan.gates.some(gate=>gate.id==='node:campaigns'),false);
  assert.deepEqual(plan.gates.find(gate=>gate.id==='node:campaigns:store').files,[strict]);
  assert.equal(plan.selectedFiles.filter(file=>file===strict).length,1);
  assert.equal(plan.selectedFiles.length,new Set(plan.selectedFiles).size);
  if(nodeFiles)assert.deepEqual(plan.selectedFiles,[strict]);
 }
});

test('strict campaign launch identity cannot resume a same-file PASS obtained with the historical loopback guard',async t=>{
 const f=campaignGuardSelectionFixture(t),options={groups:'campaigns',nodeFiles:f.strict,browsers:'none',workers:1};
 const first=await executeDevelopment({...f,options,gateExecutor:executor([])});
 assert.equal(first.effectiveOutcome,'PASS');
 const strict=first.plan.gates.find(gate=>gate.id==='node:campaigns:store');
 const commandOnly={...strict,command:strict.command.map(arg=>arg==='./tests/store/no-network.mjs'?'./tests/session/no-egress.mjs':arg)};
 const currentKey=gateInputKey(strict,first.before,first.environment);
 assert.notEqual(gateInputKey(commandOnly,first.before,first.environment),currentKey,'The actual preload command belongs to the gate input identity');
 const historical={...commandOnly,guard:'tests/session/no-egress.mjs'},historicalKey=gateInputKey(historical,first.before,first.environment);
 assert.notEqual(historicalKey,currentKey);assert.deepEqual(historical.files,strict.files);
 // A valid unchanged strict receipt is the control: Node tests can resume only
 // with their identical gate key and exact audited receipt/log bindings.
 const unchangedCalls=[],unchanged=await executeDevelopment({...f,options:{...options,resume:first.receiptPath},gateExecutor:executor(unchangedCalls)});
 assert.equal(unchanged.effectiveOutcome,'PASS');
 assert.equal(unchanged.gates.find(entry=>entry.observation.id===strict.id).mode,'reused');
 assert.equal(unchangedCalls.includes(strict.id),false);
 // This is a synthetic harness receipt, never product test evidence. Retain a
 // separate, self-consistent historical command/key and rebind its audit bytes.
 const originalBytes=readFileSync(first.receiptPath),prior=JSON.parse(originalBytes),directory=join(f.cwd,'historical-loopback-guard');
 mkdirSync(directory);mkdirSync(join(directory,'evidence-storage'));
 prior.id+='-historical-loopback';prior.directory=directory;
 prior.evidenceStorage={...prior.evidenceStorage,campaignId:prior.id,auditId:prior.id,auditPath:'synthetic/'+prior.id};
 const planIndex=prior.plan.gates.findIndex(gate=>gate.id===strict.id);prior.plan.gates[planIndex]=historical;
 for(const entry of prior.gates){
  const target=join(directory,entry.observation.log.path);writeFileSync(target,readFileSync(entry.logPath));entry.logPath=target;
  if(entry.observation.id===strict.id){entry.key=historicalKey;entry.observation.command=historical.command;}
 }
 const receiptPath=join(directory,'receipt.json'),bytes=Buffer.from(JSON.stringify(prior));writeFileSync(receiptPath,bytes);
 writeFileSync(join(directory,'evidence-storage/audit.json'),JSON.stringify({status:'PASS',auditId:prior.id,receipt:{bytes:bytes.length,sha256:sha256(bytes)},outcome:'PASS'}));
 const calls=[],resumed=await executeDevelopment({...f,options:{...options,resume:receiptPath},gateExecutor:executor(calls)});
 assert.equal(resumed.effectiveOutcome,'PASS');assert.ok(calls.includes(strict.id));
 const actual=resumed.gates.find(entry=>entry.observation.id===strict.id);
 assert.equal(actual.mode,'executed');assert.equal(actual.key,currentKey);assert.deepEqual(actual.observation.command,strict.command);
 assert.deepEqual(readFileSync(first.receiptPath),originalBytes,'The valid strict receipt remains unchanged');
});

// Discovery-only fixtures have no dist tree and never import a product test.
function d11ApplicationSelectionFixture(t){
 const f=fixture(t),file='tests/campaigns/browser-d11-build.test.mjs',unrelated='tests/campaigns/fixture.test.mjs';
 const sameBasename='tests/campaigns/nested/browser-d11-build.test.mjs';
 mkdirSync(join(f.cwd,'tests/campaigns/nested'));
 for(const path of [file,sameBasename])writeFileSync(join(f.cwd,path),'// Discovery fixture only.\n');
 assert.equal(existsSync(join(f.cwd,'dist')),false);
 return {...f,file,unrelated,sameBasename};
}

test('actual D11 build consumer requires one app build after focused selection on a clean checkout',t=>{
 const f=d11ApplicationSelectionFixture(t);
 for(const options of [
  {groups:'campaigns',nodeFiles:f.file},
  {groups:'campaigns',nodeFiles:[f.file,f.unrelated].join(',')},
  {groups:'campaigns'},
  {groups:'helpers'},
  {groups:'all'},
 ]){
  const plan=developmentPlan(f.cwd,{...options,browsers:'none'}),ids=plan.gates.map(gate=>gate.id);
  const gate=plan.gates.find(gate=>gate.id==='node:campaigns');
  assert.ok(gate.files.includes(f.file));
  assert.deepEqual(gate.requiredEnvironment,{IE_CAMPAIGN_PRODUCT_INTEGRATION:'1'});
  assert.ok(gate.dependencies.includes('build-app'));
  for(const id of ['build-server','build-app']){
   assert.equal(ids.filter(value=>value===id).length,1);
   assert.ok(ids.indexOf('imports')<ids.indexOf(id));
   assert.ok(ids.indexOf(id)<ids.indexOf(gate.id));
  }
  assert.equal(plan.browserPlan,null);
  assert.equal(gate.completionPrerequisites,undefined,'Reading finalized output does not require issuer preparation');
  assert.equal(gate.guard,'tests/session/no-egress.mjs');
  assert.ok(gate.command.includes('--test-concurrency=1'));
  if(options.nodeFiles)assert.deepEqual(gate.files,[...options.nodeFiles.split(',')].sort());
 }
 assert.equal(existsSync(join(f.cwd,'dist')),false,'Planning does not create or trust output');
});

test('focused unrelated and same-basename campaign files do not inherit D11 app preparation',t=>{
 const f=d11ApplicationSelectionFixture(t);
 for(const file of [f.unrelated,f.sameBasename]){
  const plan=developmentPlan(f.cwd,{groups:'campaigns',nodeFiles:file,browsers:'none'});
  const gate=plan.gates.find(gate=>gate.id==='node:campaigns');
  assert.deepEqual(gate.files,[file]);
  assert.equal(gate.dependencies.includes('build-app'),false);
  assert.equal(plan.gates.some(gate=>gate.id==='build-app'),false);
  assert.deepEqual(gate.requiredEnvironment,{IE_CAMPAIGN_PRODUCT_INTEGRATION:'1'});
 }
});

test('a failed required app build stops the selected D11 product integration before dispatch',async t=>{
 const f=d11ApplicationSelectionFixture(t),calls=[];
 const result=await executeDevelopment({...f,options:{groups:'campaigns',nodeFiles:f.file,browsers:'none',workers:1,fresh:true},
  gateExecutor:executor(calls,'build-app')});
 assert.equal(result.outcome,'FAIL');
 assert.equal(calls.filter(id=>id==='build-app').length,1);
 assert.ok(calls.includes('build-server'));
 assert.equal(calls.includes('node:campaigns'),false);
 assert.ok(result.pending.includes('node:campaigns'));
 assert.equal(result.plan.gates.find(gate=>gate.id==='node:campaigns').files[0],f.file);
 assert.equal(existsSync(join(f.cwd,'dist')),false,'The synthetic failure does not fabricate a finalized application');
});


test('reviewed renderer ownership integration retains the real application build under focused selection', t => {
 const f=d11ApplicationSelectionFixture(t),file='tests/campaigns/renderer-ownership-approved.test.mjs';
 const lookalike='tests/campaigns/nested/renderer-ownership-approved.test.mjs';
 for(const path of [file,lookalike])writeFileSync(join(f.cwd,path),'// Discovery fixture only; no renderer approval or runtime.\n');
 for(const options of [
  {groups:'campaigns',nodeFiles:file},
  {groups:'campaigns',nodeFiles:[file,f.unrelated].join(',')},
  {groups:'campaigns'}, {groups:'helpers'}, {groups:'all'},
 ]){
  const plan=developmentPlan(f.cwd,{...options,browsers:'none'}),ids=plan.gates.map(gate=>gate.id);
  const gate=plan.gates.find(gate=>gate.id==='node:campaigns');
  assert.ok(gate.files.includes(file));
  assert.deepEqual(gate.requiredEnvironment,{IE_CAMPAIGN_PRODUCT_INTEGRATION:'1'});
  assert.ok(gate.dependencies.includes('build-app'));
  for(const id of ['build-server','build-app']){
   assert.equal(ids.filter(value=>value===id).length,1);
   assert.ok(ids.indexOf('imports')<ids.indexOf(id));
   assert.ok(ids.indexOf(id)<ids.indexOf(gate.id));
  }
 }
 for(const nodeFiles of [lookalike,f.unrelated]){
  const plan=developmentPlan(f.cwd,{groups:'campaigns',nodeFiles,browsers:'none'});
  assert.equal(plan.gates.some(gate=>gate.id==='build-app'),false,'Only the exact actual-build consumer requires app output');
 }
});


const fastHostedSelection = [
 'tests/history/mask-text-compatibility.test.mjs',
 'tests/composition/retained-text.test.mjs',
 'tests/text-state/native.test.mjs',
 'tests/text-state/placement-text-compatibility.test.mjs',
];
test('Fast hosted setup follows actual selected historical executables and existing whole-gate deadlines',()=>{
 const setup=selectedFastSetup(process.cwd(),fastHostedSelection.join(','));
 assert.deepEqual([...setup.selectedFiles].sort(),[...fastHostedSelection].sort());
 assert.deepEqual(setup.requiredBrowsers,['chromium']);
 assert.deepEqual(setup.history.map(row=>row.commit).sort(),[
  '4b2c82ccc41dd72c3f83480f23481b7b62135d23','d3b8e5f5ec4568547f21a2826792450367144a17',
  'd3c6046a44d29d89ccdcb219cc37d40f02bad84f','dcd5f11dbd57cd7ed00c8ddf410857ce4700440e',
 ].sort());
 assert.equal(setup.gates.reduce((n,g)=>n+g.timeoutMs,0),7_335_000);
 assert.equal(setup.gates.filter(g=>g.id.endsWith(':browser')).length,3);
 assert.equal(setup.jobMinutes,180);assert(setup.totalBudgetMs<180*60_000);
 assert(setup.sources.some(row=>row.path==='tests/text-state/prior-writer.mjs'));
 for(const row of setup.history)assert.deepEqual(row.paths,['server','src','tests','tooling','tsconfig.server.json']);
 const one=selectedFastSetup(process.cwd(),fastHostedSelection[0]);
 assert.deepEqual(one.history.map(row=>row.commit),['4b2c82ccc41dd72c3f83480f23481b7b62135d23']);
 const ordinary=selectedFastSetup(process.cwd(),'tests/portable/failure.test.mjs');
 assert.deepEqual(ordinary.history,[]);assert.deepEqual(ordinary.sources,[]);assert.deepEqual(ordinary.requiredBrowsers,[]);
});
test('Fast setup refuses unknown or duplicate owners, unprovisioned browsers and missing genuine packet inputs',()=>{
 for(const selection of ['', 'tests/not-a-file.test.mjs',fastHostedSelection[0]+','+fastHostedSelection[0]])assert.throws(()=>selectedFastSetup(process.cwd(),selection));
 assert.throws(()=>selectedFastSetup(process.cwd(),'tests/editor/model-memory-browser.test.mjs'),/not provisioned/);
 const plan=developmentPlan(process.cwd(),{groups:'all',nodeFiles:fastHostedSelection[0],browsers:'none'});
 const fresh=structuredClone(plan);fresh.gates[0].freshFixtureFiles=['tests/portable/fixture.test.mjs'];
 assert.throws(()=>fastSetupPlan(fresh),/genuine schema18/);
 const tooLarge=structuredClone(plan);tooLarge.gates[0].timeoutMs=180*60_000;
 assert.throws(()=>fastSetupPlan(tooLarge),/exceeds the 180-minute/);
 const unbounded=structuredClone(plan);delete unbounded.gates[0].timeoutMs;
 assert.throws(()=>fastSetupPlan(unbounded),/bounded deadline/);
});
test('Fast setup fails changed historical declarations, calls and archive authority before provisioning',()=>{
 const owner=fastHostedSelection[0],prior='tests/text-state/prior-writer.mjs';
 const plan=developmentPlan(process.cwd(),{groups:'all',nodeFiles:owner,browsers:'none'});
 const sourceFor=path=>readFileSync(path,'utf8');
 for(const [target,from,to,expected] of [
  [owner,"const oldCommit='4b2c82ccc41dd72c3f83480f23481b7b62135d23'","const oldCommit='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",/not admitted/],
  [owner,'priorWriter(t,oldCommit)','priorWriter(t)',/call changed/],
  [owner,"from '../text-state/prior-writer.mjs'","from '../different-writer.mjs'",/import changed/],
  [prior,"['server','src','tests','tooling','tsconfig.server.json']","['server','src']",/archive closure changed/],
  [prior,'commit=priorCommit','commit=otherCommit',/signature changed/],
 ])assert.throws(()=>fastSetupPlan(plan,{sourceFor:path=>{
   const text=sourceFor(path);if(path!==target)return text;assert(text.includes(from));return text.replace(from,to);
 }}),expected);
 assert.throws(()=>fastSetupPlan(plan,{sourceFor,history:[]}),/not admitted/);
 const native=developmentPlan(process.cwd(),{groups:'all',nodeFiles:'tests/text-state/native.test.mjs',browsers:'none'});
 assert.throws(()=>fastSetupPlan(native,{sourceFor:path=>path===prior?sourceFor(path).replace("export const priorCommit=", "const copy='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; export const priorCommit=copy; const unused="):sourceFor(path)}),/literal historical/);
});
test('Fast provisioning fetches only selected literal commits, verifies archive bytes and preserves HEAD',()=>{
 const plan=selectedFastSetup(process.cwd(),fastHostedSelection[0]),commands=[],records=[],head='f'.repeat(40),archive=Buffer.from('synthetic archive bytes');
 const execute=(command,args,options)=>{
  commands.push({command,args,options});
  if(command===process.execPath){assert.deepEqual(args.slice(1),['install','--with-deps','chromium']);return Buffer.alloc(0);}
  assert.equal(command,'git');const operation=args[4];
  if(operation==='rev-parse')return Buffer.from(head+'\n');
  if(operation==='cat-file')return Buffer.from('commit\n');
  if(operation==='archive')return archive;
  assert.equal(operation,'fetch');return Buffer.alloc(0);
 };
 const result=provisionFastSetup(process.cwd(),plan,{execute,record:value=>records.push(structuredClone(value))});
 assert.equal(result.status,'PASS');assert.equal(result.headBefore,head);assert.equal(result.headAfter,head);
 const fetch=commands.filter(row=>row.args[4]==='fetch');assert.equal(fetch.length,1);
 assert.deepEqual(fetch[0].args.slice(4),['fetch','--no-tags','--depth=1','--no-recurse-submodules','origin','4b2c82ccc41dd72c3f83480f23481b7b62135d23']);
 assert.deepEqual(commands.find(row=>row.args[4]==='archive').args.slice(4),['archive','--format=tar','4b2c82ccc41dd72c3f83480f23481b7b62135d23','--','server','src','tests','tooling','tsconfig.server.json']);
 assert.deepEqual(result.history[0].archive,{bytes:archive.length,sha256:sha256(archive)});
 assert.equal(records.at(-1).status,'PASS');
});
test('Fast provisioning retains failure without fallback fetch or browser install and rejects HEAD drift',()=>{
 const plan=selectedFastSetup(process.cwd(),fastHostedSelection[0]);
 for(const phase of ['fetch','archive','head']){
  const records=[],commands=[];let heads=0;
  const execute=(command,args)=>{
   commands.push([command,...args]);
   if(command===process.execPath){assert.equal(phase,'head');return Buffer.alloc(0);}
   assert.equal(command,'git');const operation=args[4];
   if(operation==='rev-parse')return Buffer.from((phase==='head'&&++heads===2?'b':'a').repeat(40));
   if(operation===phase)throw Error('actual setup refusal: '+phase);
   if(operation==='cat-file')return Buffer.from('commit');
   if(operation==='archive')return Buffer.from('archive');
   assert.equal(operation,'fetch');return Buffer.alloc(0);
  };
  // Even otherwise successful provisioning must reject changed HEAD; failed
  // fetch/archive paths never install browsers or try an alternate commit.
  assert.throws(()=>provisionFastSetup(process.cwd(),plan,{execute,record:r=>records.push(structuredClone(r))}));
  assert.equal(records.at(-1).status,'FAIL');
  assert.equal(commands.filter(row=>row[5]==='fetch').length,1);
  assert.deepEqual(records.at(-1).plan.selectedFiles,plan.selectedFiles);
 }
 const ordinary=selectedFastSetup(process.cwd(),'tests/portable/failure.test.mjs'),commands=[];
 const result=provisionFastSetup(process.cwd(),ordinary,{execute:(command,args)=>{commands.push([command,...args]);assert.equal(args[4],'rev-parse');return Buffer.from('a'.repeat(40));}});
 assert.equal(result.status,'PASS');assert.equal(commands.length,2);assert.equal(result.browser,null);
});


test('Fast ordinary R33 setup provisions the actual prior reader without a browser or invented archive',()=>{
 const owner='tests/history/returned-description.test.mjs',plan=developmentPlan(process.cwd(),{groups:'all',nodeFiles:owner,browsers:'none'});
 const setup=selectedFastSetup(process.cwd(),owner);
 assert.deepEqual(setup.requiredBrowsers,[]);assert.deepEqual(setup.history,[{commit:'8901d923f309125c5bc19605efe76a871a7ee1df',paths:['server','src','tooling','tsconfig.server.json'],owners:[owner]}]);
 assert.deepEqual(setup.sources.map(row=>row.path),[owner]);
 const sourceFor=path=>readFileSync(path,'utf8');
 for(const [from,to,expected] of [
  ["'8901d923f309125c5bc19605efe76a871a7ee1df'","'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",/not admitted/],
  ["['server','src','tooling','tsconfig.server.json']","['server','src']",/declaration changed/],
  ["from '../../tooling/qualification/legacy-compiler.mjs'","from './different-compiler.mjs'",/import changed/],
 ])assert.throws(()=>fastSetupPlan(plan,{sourceFor:path=>{const text=sourceFor(path);assert(text.includes(from));return text.replace(from,to);}}),expected);
});


test('Fast historical AST parsing ignores commented declarations and refuses malformed or nonliteral authority',()=>{
 const owner='tests/history/mask-text-compatibility.test.mjs';
 const plan=developmentPlan(process.cwd(),{groups:'all',nodeFiles:owner,browsers:'none'});
 const sourceFor=path=>readFileSync(path,'utf8');
 const expected=selectedFastSetup(process.cwd(),owner);
 const comments=fastSetupPlan(plan,{sourceFor:path=>sourceFor(path)+"\n/* const oldCommit='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; priorWriter(t,other); compileLegacy(directory,other,[]); */\n"});
 assert.deepEqual(comments.history,expected.history);
 assert.notDeepEqual(comments.sources,expected.sources,'observed source identity still retains the comments');
 assert.throws(()=>fastSetupPlan(plan,{sourceFor:path=>sourceFor(path)+(path===owner?'\nconst = ;':'')}),/does not parse/);
 assert.throws(()=>fastSetupPlan(plan,{sourceFor:path=>path===owner?sourceFor(path).replace("const oldCommit='4b2c82ccc41dd72c3f83480f23481b7b62135d23'","const oldCommit=`4b2c82ccc41dd72c3f83480f23481b7b62135d23`"):sourceFor(path)}),/literal historical/);
 const direct='tests/history/returned-description.test.mjs';
 const directPlan=developmentPlan(process.cwd(),{groups:'all',nodeFiles:direct,browsers:'none'});
 assert.throws(()=>fastSetupPlan(directPlan,{sourceFor:path=>sourceFor(path).replace("compileLegacy(directory,'8901d923f309125c5bc19605efe76a871a7ee1df'","compileLegacy(directory,`8901d923f309125c5bc19605efe76a871a7ee1df`")}),/declaration changed/);
});

const fastBrowserPlan = (family = 'editor-document-creation', engine = 'chromium') => developmentPlan(process.cwd(), {
 groups:'preflight',browsers:engine,browserGroups:family,workers:1,batchEditor:false,output:join(process.cwd(),'artifacts/validation/run/browser'),
});
const browserDeadlineSource = path => readFileSync(path,'utf8');
test('Fast browser selection preserves every reviewed whole family on exactly one pinned engine',()=>{
 assert.equal(fastBrowserFamilies.length,37);assert.equal(new Set(fastBrowserFamilies).size,37);
 for(const engine of ['chromium','firefox','webkit'])for(const family of fastBrowserFamilies){
  if((family==='adapters'||family==='shell')&&engine!=='chromium'){assert.throws(()=>selectedFastBrowserSetup(process.cwd(),family,engine),/requires Chromium/);continue;}
  const plan=fastBrowserPlan(family,engine),setup=selectedFastBrowserSetup(process.cwd(),family,engine);
  const original=createBrowserPlan({selection:engine,scope:'features',output:plan.browserPlan.output}).steps.find(step=>step.family===family);
  assert(original);assert.deepEqual(setup.selectedFiles,original.files);
  assert.deepEqual(setup.requiredBrowsers,[engine]);assert.deepEqual(setup.history,[]);
  assert.deepEqual(plan.browserPlan.steps.filter(step=>step.config),[original]);
  assert.equal(setup.browserSteps.filter(step=>step.id===original.id).length,1);
  const ids=setup.gates.map(gate=>gate.id);assert.deepEqual(ids.slice(0,2),['typecheck','preflight']);
  assert(ids.indexOf('vendor')<ids.indexOf('text-inputs'));assert(ids.indexOf('text-inputs')<ids.indexOf('imports'));
  if(family==='editor-display-image'){
   assert.equal(ids.includes('build-app'),false);assert.equal(ids.includes('build-server'),false);assert.deepEqual(setup.issuers,[]);
  }else{
   assert(ids.includes('build-app'));assert(ids.includes('build-server'));assert(ids.includes('storage-environment'));
   if(family==='text'){assert.equal(ids.includes('completion-source'),false);assert.deepEqual(setup.issuers,[]);}
   else assert.deepEqual(setup.issuers,[{id:'browser-completion-issuers',timeoutMs:300000,graceMs:5000,exitObservationMs:100}]);
  }
  const units=[...setup.gates,...setup.browserSteps,...setup.issuers];
  assert.equal(setup.totalBudgetMs,units.reduce((sum,row)=>sum+row.timeoutMs+row.graceMs+row.exitObservationMs,0)+40*60_000+15*60_000);
  assert.equal(setup.jobMinutes,180);assert(setup.totalBudgetMs<=180*60_000);
  assert.equal(setup.qualification,false);assert.equal(plan.selectedFiles.length,0);
 }
});
test('Fast request and recovery dispatch preserves the exact existing full contracts without extra fixtures or authority',()=>{
 const owners=[
  ['request-review','tests/request/playwright.config.ts','tests/request/review.spec.ts',[]],
  ['queue','tests/queue/playwright.config.ts','tests/queue/public.spec.ts',[]],
  ['e2','tests/candidates/playwright.config.ts','tests/candidates/public.spec.ts',['E2']],
  ['request-v45-generation','tests/request/v45-generation.config.ts','tests/request/v45-generation.spec.ts',[]],
  ['request-v45-edit','tests/request-edits/v45.config.ts','tests/request-edits/v45-public.spec.ts',[]],
  ['e3','tests/request-edits/playwright.config.ts','tests/request-edits/public.spec.ts',['E3']],
  ['e4','tests/recovery/p25.config.ts','tests/recovery/e4.spec.ts',['E4']],
 ];
 for(const [family,config,file,contracts] of owners)for(const engine of ['chromium','firefox','webkit']){
  const plan=fastBrowserPlan(family,engine),setup=selectedFastDispatchSetup(process.cwd(),{
   SELECTED_NODE_FILES:'',SELECTED_BROWSER_FAMILY:family,SELECTED_BROWSER:engine,
  });
  const destination=join(plan.browserPlan.output,`${family}-${engine}`);
  assert.equal(plan.browserPlan.steps.length,1,'no historical, prompt, native or extra-engine fixture is injected');
  const [step]=plan.browserPlan.steps;
  assert.equal(step.id,`${family}-${engine}`);assert.equal(step.config,config);assert.deepEqual(step.files,[file]);
  assert.deepEqual(step.contracts,contracts);assert.deepEqual(step.prerequisites,[]);
  assert.deepEqual(step.args,['exec','--','playwright','test','--config',config,file,
   '--forbid-only','--max-failures=1','--reporter','list,json,./tooling/qualification/developer-campaigns/browser-reporter.mjs']);
  assert.deepEqual(step.env,{EDITOR_RECEIPT:destination,EDITOR_BROWSER:engine,
   PLAYWRIGHT_JSON_OUTPUT_FILE:join(destination,'browser.json'),QUALIFICATION_CASE_REPORT:join(destination,'cases.ndjson')});
  assert.deepEqual(plan.browserPlan.prerequisites,['build-app','build-server','raster-inputs']);
  assert.deepEqual(setup.gates.map(gate=>gate.id),['typecheck','preflight','completion-source','storage-environment',
   'vendor','text-inputs','imports','raster-inputs','build-server','build-app']);
  assert.deepEqual(setup.selectedFiles,[file]);assert.deepEqual(plan.selectedFiles,[]);
  assert.deepEqual(setup.requiredBrowsers,[engine]);assert.deepEqual(setup.history,[]);
  assert.deepEqual(setup.browserSteps,[{id:`${family}-${engine}`,timeoutMs:1800000,graceMs:5000,exitObservationMs:100}]);
  assert.equal(setup.totalBudgetMs,7456200);assert.equal(setup.qualification,false);
  for(const mutate of [
   changed=>{changed.browserPlan.steps[0].files=['tests/editor/authoring.spec.ts'];},
   changed=>{changed.browserPlan.steps[0].env.EDITOR_BROWSER=engine==='chromium'?'firefox':'chromium';},
   changed=>{changed.browserPlan.steps[0].contracts=['unreviewed-contract'];},
   changed=>{changed.browserPlan.steps[0].args.push('--grep','one case');},
  ]){const changed=structuredClone(plan);mutate(changed);assert.throws(()=>fastBrowserSetupPlan(changed,{sourceFor:browserDeadlineSource}),/complete maintained family/);}
 }
});
test('Fast browser admission refuses mixed, partial, unknown or widened selections while preserving the Node branch',()=>{
 for(const family of ['','none','all','editor-batch','editor-image-import,editor-zoom-tool','editor-image-import;echo x'])assert.throws(()=>selectedFastBrowserSetup(process.cwd(),family,'chromium'),/one reviewed whole editor family/);
 for(const engine of ['','none','all','chromium,webkit','webkit;echo x'])assert.throws(()=>selectedFastBrowserSetup(process.cwd(),'e1',engine),/one reviewed whole editor family/);
 assert.throws(()=>selectedFastDispatchSetup(process.cwd(),{SELECTED_NODE_FILES:'tests/portable/failure.test.mjs',SELECTED_BROWSER_FAMILY:'e1',SELECTED_BROWSER:'chromium'}),/either whole Node files/);
 for(const family of [undefined,'','none'])assert.deepEqual(selectedFastDispatchSetup(process.cwd(),{SELECTED_NODE_FILES:'tests/portable/failure.test.mjs',SELECTED_BROWSER_FAMILY:family}),selectedFastSetup(process.cwd(),'tests/portable/failure.test.mjs'));
 assert.deepEqual(selectedFastDispatchSetup(process.cwd(),{SELECTED_BROWSER_FAMILY:'e1',SELECTED_BROWSER:'webkit'}),selectedFastBrowserSetup(process.cwd(),'e1','webkit'));
 const original=fastBrowserPlan();
 for(const mutate of [
  plan=>{plan.browserGrep='only one case';},plan=>{plan.batchEditor=true;},plan=>{plan.workers=2;},
  plan=>{plan.selectedFiles=['tests/portable/failure.test.mjs'];},
  plan=>{plan.browserPlan.steps.at(-1).files=[];},
  plan=>{plan.browserPlan.steps.at(-1).args.push('--grep','one case');},
  plan=>{plan.browserPlan.steps.at(-1).config='tests/editor/integration.config.ts';},
  plan=>{plan.browserPlan.steps.push(structuredClone(plan.browserPlan.steps.at(-1)));},
  plan=>{plan.requiredBrowsers.push('firefox');},
  plan=>{plan.gates[0].freshFixtureFiles=['tests/portable/legacy.test.mjs'];},
  plan=>{plan.gates=plan.gates.filter(gate=>gate.id!=='completion-source');},
 ]){const plan=structuredClone(original);mutate(plan);assert.throws(()=>fastBrowserSetupPlan(plan,{sourceFor:browserDeadlineSource}));}
});
test('Fast browser budget includes actual gates, browser deadline, issuer and drain intervals without increasing the job cap',()=>{
 const plan=fastBrowserPlan(),setup=fastBrowserSetupPlan(plan,{sourceFor:browserDeadlineSource});
 assert.equal(setup.browserBudgetMs,1_800_000+5000+100);assert.equal(setup.issuerBudgetMs,300000+5000+100);
 const limit=180*60_000,boundary=structuredClone(plan);boundary.gates[0].timeoutMs+=limit-setup.totalBudgetMs;
 assert.equal(fastBrowserSetupPlan(boundary,{sourceFor:browserDeadlineSource}).totalBudgetMs,limit);
 boundary.gates[0].timeoutMs++;
 assert.throws(()=>fastBrowserSetupPlan(boundary,{sourceFor:browserDeadlineSource}),/exceeds the 180-minute/);
 const unbounded=structuredClone(plan);delete unbounded.gates[0].timeoutMs;
 assert.throws(()=>fastBrowserSetupPlan(unbounded,{sourceFor:browserDeadlineSource}),/bounded deadline/);
 const changed=fastBrowserSetupPlan(plan,{sourceFor:path=>{
  const text=browserDeadlineSource(path);if(path!=='tooling/qualification/run.mjs')return text;
  assert(text.includes('graceMs: gate.graceMs ?? 5_000'));return text.replace('graceMs: gate.graceMs ?? 5_000','graceMs: gate.graceMs ?? 10_000');
 }});
 assert.equal(changed.totalBudgetMs-setup.totalBudgetMs,setup.gates.length*5000);
 assert.deepEqual(changed.browserSteps,setup.browserSteps);assert.deepEqual(changed.issuers,setup.issuers);
 assert.notDeepEqual(changed.sources,setup.sources);
});
test('Fast browser deadline source parsing rejects changed implicit authority and nonliteral limits before provisioning',()=>{
 for(const [target,from,to] of [
  ['tooling/qualification/development.mjs','timeoutMs:300000','timeoutMs:unknownTimeout'],
  ['tooling/qualification/container/bounded-child.mjs','graceMs = 5_000','graceMs = unknownGrace'],
  ['tooling/qualification/container/bounded-child.mjs','pause(100)','pause(unknownInterval)'],
  ['tooling/qualification/run.mjs','graceMs: gate.graceMs ?? 5_000','graceMs: other.graceMs ?? 5_000'],
  ['tooling/qualification/completion-issuers/prepare-child.mjs','timeoutMs:remaining','...unknownOptions,timeoutMs:remaining'],
 ])assert.throws(()=>fastBrowserSetupPlan(fastBrowserPlan(),{sourceFor:path=>{
  const text=browserDeadlineSource(path);if(path!==target)return text;assert(text.includes(from));return text.replace(from,to);
 }}));
});
test('Fast browser provisioning installs only the selected locked CLI engine and retains failure without fallback',()=>{
 for(const family of ['editor-display-image','text'])for(const engine of ['chromium','firefox','webkit']){
  const plan=selectedFastBrowserSetup(process.cwd(),family,engine),commands=[],records=[];
  const result=provisionFastBrowserSetup(process.cwd(),plan,{execute:(command,args,options)=>{
   commands.push([command,...args]);assert.equal(command,process.execPath);
   assert.deepEqual(args,[join(process.cwd(),'node_modules/playwright/cli.js'),'install','--with-deps',engine]);
   assert.equal(options.timeout,7*60_000);return Buffer.alloc(0);
  },record:row=>records.push(structuredClone(row))});
  assert.equal(commands.length,1);assert.equal(result.status,'PASS');assert.deepEqual(records.map(row=>row.status),['PENDING','PASS']);
  const failures=[],failedCommands=[];
  assert.throws(()=>provisionFastBrowserSetup(process.cwd(),plan,{execute:(...args)=>{failedCommands.push(args);throw Error('Pinned browser unavailable');},record:row=>failures.push(structuredClone(row))}),/Pinned browser unavailable/);
  assert.equal(failedCommands.length,1);assert.deepEqual(failures.map(row=>row.status),['PENDING','FAIL']);assert.equal(failures.at(-1).browser,null);
 }
});
test('Fast workflow offers the reviewed single-family choices and preserves quoted serial runner and existing default commands',()=>{
 const workflow=readFileSync('.github/workflows/validation.yml','utf8');
 const block=workflow.split('      browser_family:\n')[1].split('      browser:\n')[0];
 assert.deepEqual([...block.matchAll(/^          - (.+)$/gm)].map(match=>match[1]),['none',...fastBrowserFamilies]);
 assert(workflow.includes('npm run validate -- run --groups preflight --browsers "$SELECTED_BROWSER" --browser-groups "$SELECTED_BROWSER_FAMILY" --workers 1 --fresh --serial-browser --output "$IE_VALIDATION_OUTPUT"'));
 assert(workflow.includes('npm run validate -- run --groups all --node-files "$SELECTED_NODE_FILES" --browsers none --workers 1 --fresh --output "$IE_VALIDATION_OUTPUT"'));
 assert(workflow.includes('npm run validate -- run --groups tooling --browsers none --workers 1 --fresh --output "$IE_VALIDATION_OUTPUT"'));
 assert(workflow.includes("SELECTED_BROWSER_FAMILY: ${{ github.event_name == 'workflow_dispatch' && inputs.browser_family || 'none' }}"));
 assert(workflow.includes('retention-days: 90'));assert(workflow.includes('contents: read'));
 const uploads=workflow.split('      - name: Retain failure and success receipts\n');assert.equal(uploads.length,2);
 const uploadWith=uploads[1].split('        with:\n')[1].split('\n#')[0];
 assert.deepEqual([...uploadWith.matchAll(/^          (path|include-hidden-files): (.+)$/gm)].map(match=>[match[1],match[2]]),[['path','artifacts/validation'],['include-hidden-files','true']]);
 assert.equal((workflow.match(/^          include-hidden-files:/gm)||[]).length,1);
 assert.equal((workflow.match(/--browser-grep|--batch-browser/g)||[]).length,0);
});


const publicAdapterPath = 'artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors';
const adapterSetupOwners = ['tests/adapters/flow.test.mjs', 'tests/adapters/runtime-journal.test.mjs'];
function adapterSetupDirectory(t) {
 const directory = realpathSync(mkdtempSync(join(tmpdir(), 'fast-adapter-setup-')));
 t.after(() => rmSync(directory, {recursive:true, force:true}));
 return directory;
}
function adapterByteResponse(chunks, bytes, overrides = {}) {
 return {statusCode:200, headers:{'content-length':String(bytes)}, async *[Symbol.asyncIterator]() { yield* chunks; }, ...overrides};
}
test('Fast selected adapters require the original public fixture while other ordinary owners remain input-free', () => {
 const plan = selectedFastSetup(process.cwd(), adapterSetupOwners.join(','));
 assert.deepEqual(plan.history, []); assert.deepEqual(plan.requiredBrowsers, []);
 assert.deepEqual(plan.adapterFixture, {path:publicAdapterPath, bytes:85299896,
  sha256:'bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5',
  sourceURL:'https://v3b.fal.media/files/b/0a9dc89d/NkZw9CyYSB3ojbDx2a2s5_ideogram_v4_lora.safetensors', owners:adapterSetupOwners});
 const source = readFileSync('tooling/qualification/container/inputs.mjs');
 assert.deepEqual(plan.sources, [{path:'tooling/qualification/container/inputs.mjs', bytes:source.length, sha256:sha256(source)}]);
 assert.equal(selectedFastSetup(process.cwd(), 'tests/candidates/retention.test.mjs').adapterFixture, null);
 assert.deepEqual(plan.selectedFiles, adapterSetupOwners);
});
test('Fast adapter setup delegates one bounded fixed-input child and binds its actual receipt', () => {
 const root = process.cwd(), plan = selectedFastSetup(root, adapterSetupOwners.join(','));
 const {owners, ...expected} = plan.adapterFixture;
 const value = {kind:'fast-public-adapter-provisioning-1', status:'PASS', mode:'downloaded', expected,
  actual:{path:join(root, publicAdapterPath), bytes:expected.bytes, sha256:expected.sha256}};
 const commands = [], records = [];
 const execute = (command, args, options) => {
  commands.push({command,args,options});
  if (command === 'git') { assert.equal(args[4], 'rev-parse'); return Buffer.from('a'.repeat(40)); }
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [join(root, 'tooling/qualification/fast-ci-setup.mjs'), '--public-adapter', root]);
  assert.equal(options.timeout, 660000); assert.equal(options.maxBuffer, 65536);
  assert.deepEqual(options.stdio, ['ignore','pipe','pipe']);
  return Buffer.from(JSON.stringify(value));
 };
 const result = provisionFastSetup(root, plan, {execute, record:r => records.push(structuredClone(r))});
 assert.equal(result.status, 'PASS'); assert.equal(result.adapterFixture.actual.sha256, expected.sha256);
 assert.equal(commands.length, 3); assert.equal(records.at(-1).status, 'PASS');
 for (const change of [row => {row.actual.sha256 = 'a'.repeat(64);}, row => {row.actual.bytes--;}, row => {row.expected.sourceURL += '?other';}, row => {row.mode = 'unverified';}]) {
  const bad = structuredClone(value); change(bad); const failed = [];
  assert.throws(() => provisionFastSetup(root, plan, {execute:(command,args) => command === 'git' ? Buffer.from('a'.repeat(40)) : Buffer.from(JSON.stringify(bad)), record:r => failed.push(structuredClone(r))}), /receipt differs/);
  assert.equal(failed.at(-1).status, 'FAIL');
 }
});
test('Fast adapter setup refuses absent or changed authority before any provisioning command', () => {
 const plan = selectedFastSetup(process.cwd(), adapterSetupOwners.join(','));
 for (const mutate of [p => {delete p.adapterFixture;}, p => {p.adapterFixture.bytes--;}, p => {p.adapterFixture.sourceURL = 'https://example.invalid/weights';}, p => {p.adapterFixture.owners.reverse();}]) {
  const changed = structuredClone(plan); mutate(changed); let calls = 0;
  assert.throws(() => provisionFastSetup(process.cwd(), changed, {execute:() => {calls++; throw Error('must not execute');}}), /prerequisite differs/);
  assert.equal(calls, 0);
 }
 const ordinary = selectedFastSetup(process.cwd(), 'tests/candidates/retention.test.mjs');
 ordinary.adapterFixture = plan.adapterFixture;
 assert.throws(() => provisionFastSetup(process.cwd(), ordinary, {execute:() => {throw Error('must not execute');}}), /prerequisite differs/);
});
test('Pinned adapter streaming writes all ordered bytes exclusively and publishes without replacement', async t => {
 const root = adapterSetupDirectory(t), staged = join(root,'staged'), destination = join(root,'final');
 const bytes = Buffer.from('first chunk/second chunk/end'), expected = {bytes:bytes.length, sha256:sha256(bytes)};
 assert.deepEqual(await stagePinnedAdapterResponse(adapterByteResponse([bytes.subarray(0,4),bytes.subarray(4,17),bytes.subarray(17)],bytes.length), staged, expected), expected);
 assert.deepEqual(readFileSync(staged), bytes); assert.equal(statSync(staged).mode & 0o777, 0o600);
 await assert.rejects(stagePinnedAdapterResponse(adapterByteResponse([bytes],bytes.length), staged, expected), {code:'EEXIST'});
 await publishPinnedAdapterFile(staged, destination);
 assert.deepEqual(readFileSync(destination), bytes); assert.equal(statSync(destination).mode & 0o777, 0o444);
 const other = join(root,'other'); writeFileSync(other,'replacement');
 await assert.rejects(publishPinnedAdapterFile(other, destination), {code:'EEXIST'});
 assert.deepEqual(readFileSync(destination), bytes); assert.equal(readFileSync(other,'utf8'), 'replacement');
 const dangling = join(root,'dangling'); symlinkSync(join(root,'absent'), dangling);
 await assert.rejects(publishPinnedAdapterFile(other, dangling), {code:'EEXIST'});
 assert.equal(existsSync(join(root,'absent')), false);
});
test('Pinned adapter response rejects redirects, compression and mismatched declared size before opening a file', async t => {
 const root = adapterSetupDirectory(t), bytes = Buffer.from('small unit input'), expected = {bytes:bytes.length,sha256:sha256(bytes)};
 const changes = [{statusCode:302}, {statusCode:404}, {headers:{'content-length':String(bytes.length),'content-encoding':'gzip'}}, {headers:{}}, {headers:{'content-length':String(bytes.length+1)}}];
 for (const [index, change] of changes.entries()) {
  const path = join(root,String(index)); let consumed = false;
  const response = adapterByteResponse([], bytes.length, {...change, async *[Symbol.asyncIterator]() {consumed=true;yield bytes;}});
  await assert.rejects(stagePinnedAdapterResponse(response,path,expected), /status\/encoding\/length differs/);
  assert.equal(consumed,false); assert.equal(existsSync(path),false);
 }
});
test('Pinned adapter streaming bounds actual bytes and retains short or corrupt partial evidence', async t => {
 const root = adapterSetupDirectory(t), bytes = Buffer.from('abcdef'), expected = {bytes:bytes.length,sha256:sha256(bytes)};
 const overflow = join(root,'overflow');
 await assert.rejects(stagePinnedAdapterResponse(adapterByteResponse([bytes.subarray(0,2),Buffer.from('12345')],bytes.length),overflow,expected), /exceeds pinned length/);
 assert.equal(readFileSync(overflow,'utf8'),'ab','oversized chunk must not be written');
 const short = join(root,'short');
 await assert.rejects(stagePinnedAdapterResponse(adapterByteResponse([bytes.subarray(0,5)],bytes.length),short,expected), /downloaded identity differs/);
 assert.equal(readFileSync(short,'utf8'),'abcde');
 const corrupt = join(root,'corrupt');
 await assert.rejects(stagePinnedAdapterResponse(adapterByteResponse([Buffer.from('ABCDEF')],bytes.length),corrupt,expected), /downloaded identity differs/);
 assert.equal(readFileSync(corrupt,'utf8'),'ABCDEF'); assert.equal(existsSync(join(root,'final')),false);
});
test('Pinned adapter streaming observes abort before creation and at chunk boundaries', async t => {
 const root = adapterSetupDirectory(t), bytes = Buffer.from('abcdef'), expected = {bytes:bytes.length,sha256:sha256(bytes)};
 const before = new AbortController(); before.abort(Error('already cancelled'));
 const absent = join(root,'before');
 await assert.rejects(stagePinnedAdapterResponse(adapterByteResponse([bytes],bytes.length),absent,expected,before.signal), /already cancelled/);
 assert.equal(existsSync(absent),false);
 const during = new AbortController(), path = join(root,'during'); let returned = false;
 const response = adapterByteResponse([],bytes.length,{async *[Symbol.asyncIterator]() {
  try { yield bytes.subarray(0,2); during.abort(Error('cancelled during input')); yield bytes.subarray(2); }
  finally { returned = true; }
 }});
 await assert.rejects(stagePinnedAdapterResponse(response,path,expected,during.signal), /cancelled during input/);
 assert.equal(returned,true); assert.equal(readFileSync(path,'utf8'),'ab');
});
test('Actual public adapter provisioner refuses existing mismatches and symlinks before network setup', async t => {
 const root = adapterSetupDirectory(t), target = join(root,publicAdapterPath);
 mkdirSync(join(root,'artifacts/p27-evidence/fal-public-lora-example'),{recursive:true});
 writeFileSync(target,'retained wrong input');
 await assert.rejects(provisionFastAdapterFixture(root), /Adapter fixture seal mismatch/);
 assert.equal(readFileSync(target,'utf8'),'retained wrong input');
 assert.deepEqual(readdirSync(join(root,'artifacts/p27-evidence/fal-public-lora-example')),['provider-example.safetensors']);
 unlinkSync(target); symlinkSync(join(root,'absent'),target);
 await assert.rejects(provisionFastAdapterFixture(root), /real parent directories/);
 assert.equal(existsSync(join(root,'absent')),false);
 const linkedRoot = adapterSetupDirectory(t), outside = adapterSetupDirectory(t);
 symlinkSync(outside,join(linkedRoot,'artifacts'));
 await assert.rejects(provisionFastAdapterFixture(linkedRoot), /parent must be a real directory/);
 assert.deepEqual(readdirSync(outside),[]);
});


test('Fast adapters browser selection preserves both complete specs, original config, public fixture and bounded source plan',()=>{
 const plan=fastBrowserPlan('adapters','chromium'),setup=selectedFastDispatchSetup(process.cwd(),{SELECTED_NODE_FILES:'',SELECTED_BROWSER_FAMILY:'adapters',SELECTED_BROWSER:'chromium'});
 const [step]=plan.browserPlan.steps;assert.equal(plan.browserPlan.steps.length,1);assert.equal(step.family,'adapters');assert.equal(step.browser,'chromium');assert.equal(step.config,'tests/adapters/browser.config.ts');
 assert.deepEqual(step.files,['tests/adapters/browser.spec.ts','tests/adapters/successor.spec.ts']);assert.deepEqual(step.prerequisites,[]);assert.deepEqual(step.contracts,[]);
 assert.deepEqual(step.args,['exec','--','playwright','test','--config','tests/adapters/browser.config.ts',...step.files,'--forbid-only','--max-failures=1','--reporter','list,json,./tooling/qualification/developer-campaigns/browser-reporter.mjs']);
 assert.deepEqual(setup.selectedFiles,step.files);assert.deepEqual(setup.requiredBrowsers,['chromium']);assert.deepEqual(setup.history,[]);assert.equal(plan.selectedFiles.length,0);
 const ordinary=selectedFastSetup(process.cwd(),adapterSetupOwners.join(',')),{owners,...expected}=ordinary.adapterFixture;
 assert.deepEqual(setup.adapterFixture,{...expected,owners:step.files});assert.equal(expected.bytes,85299896);assert.equal(expected.sha256,'bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5');
 const bytes=readFileSync('tooling/qualification/container/inputs.mjs');assert.deepEqual(setup.sources.filter(row=>row.path==='tooling/qualification/container/inputs.mjs'),[{path:'tooling/qualification/container/inputs.mjs',bytes:bytes.length,sha256:sha256(bytes)}]);
 assert(setup.gates.some(gate=>gate.id==='completion-source'));assert(setup.gates.some(gate=>gate.id==='build-app'));assert(setup.gates.some(gate=>gate.id==='build-server'));assert.equal(setup.issuers.length,1);
 assert.equal(setup.setupReserveMs,40*60_000);assert.equal(setup.finalizationReserveMs,15*60_000);assert.equal(setup.jobMinutes,180);assert(setup.totalBudgetMs<=180*60_000);assert.equal(setup.qualification,false);
 assert.equal(selectedFastBrowserSetup(process.cwd(),'editor-native-text','chromium').adapterFixture,null);
 for(const engine of ['firefox','webkit']){assert.throws(()=>selectedFastBrowserSetup(process.cwd(),'adapters',engine),/requires Chromium/);const changed=structuredClone(plan);changed.browsers=engine;assert.throws(()=>fastBrowserSetupPlan(changed,{sourceFor:browserDeadlineSource}),/requires Chromium/);}
 for(const mutate of [p=>{p.browserPlan.steps[0].files.pop();},p=>{p.browserPlan.steps[0].files.reverse();},p=>{p.browserPlan.steps[0].config='tests/editor/integration.config.ts';},p=>{p.browserPlan.steps[0].args.push('--grep','pagination');}]){const changed=structuredClone(plan);mutate(changed);assert.throws(()=>fastBrowserSetupPlan(changed,{sourceFor:browserDeadlineSource}),/complete maintained family/);}
});
function adapterBrowserReceipt(plan,mode='downloaded'){
 const {owners,...expected}=plan.adapterFixture;
 return {kind:'fast-public-adapter-provisioning-1',status:'PASS',mode,expected,actual:{path:join(process.cwd(),publicAdapterPath),bytes:expected.bytes,sha256:expected.sha256}};
}
test('Fast adapters browser setup verifies the genuine fixed-input child before installing only pinned Chromium',()=>{
 const root=process.cwd(),plan=selectedFastBrowserSetup(root,'adapters','chromium');
 for(const mode of ['existing','downloaded']){
  const commands=[],records=[],value=adapterBrowserReceipt(plan,mode),result=provisionFastBrowserSetup(root,plan,{execute:(command,args,options)=>{
   assert.equal(command,process.execPath);commands.push(args);assert.equal(options.cwd,root);
   if(commands.length===1){assert.deepEqual(args,[join(root,'tooling/qualification/fast-ci-setup.mjs'),'--public-adapter',root]);assert.equal(options.timeout,660000);assert.equal(options.maxBuffer,65536);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);return Buffer.from(JSON.stringify(value));}
   assert.equal(commands.length,2);assert.deepEqual(args,[join(root,'node_modules/playwright/cli.js'),'install','--with-deps','chromium']);assert.equal(options.timeout,420000);return Buffer.alloc(0);
  },record:row=>records.push(structuredClone(row))});
  assert.equal(commands.length,2);assert.equal(result.status,'PASS');assert.equal(result.adapterFixture.mode,mode);assert.deepEqual(result.adapterFixture.actual,value.actual);assert.deepEqual(records.map(row=>row.status),['PENDING','PENDING','PASS']);assert.equal(records[0].adapterFixture,null);assert.equal(records[1].browser,null);assert.equal(records[1].adapterFixture.actual.sha256,value.actual.sha256);
 }
});
test('Fast adapters browser setup refuses changed or absent fixture authority and partial owners before any child',()=>{
 const root=process.cwd(),plan=selectedFastBrowserSetup(root,'adapters','chromium');
 for(const mutate of [p=>{delete p.adapterFixture;},p=>{p.adapterFixture.bytes--;},p=>{p.adapterFixture.sha256='a'.repeat(64);},p=>{p.adapterFixture.sourceURL='https://example.invalid/weights';},p=>{p.adapterFixture.owners.reverse();},p=>{p.selectedFiles.pop();},p=>{p.selectedFiles.reverse();},p=>{p.engine='firefox';p.requiredBrowsers=['firefox'];}]){
  const changed=structuredClone(plan);mutate(changed);let calls=0;assert.throws(()=>provisionFastBrowserSetup(root,changed,{execute:()=>{calls++;throw Error('must not execute');}}),/prerequisite differs|requires Chromium/);assert.equal(calls,0);
 }
 const unrelated=selectedFastBrowserSetup(root,'editor-display-image','chromium');unrelated.adapterFixture=plan.adapterFixture;let calls=0;assert.throws(()=>provisionFastBrowserSetup(root,unrelated,{execute:()=>{calls++;throw Error('must not execute');}}),/prerequisite differs/);assert.equal(calls,0);
});
test('Fast adapters browser setup retains fixture and browser failures without fallback or missing-body acceptance',()=>{
 const root=process.cwd(),plan=selectedFastBrowserSetup(root,'adapters','chromium');
 for(const mutate of [v=>{v.status='FAIL';},v=>{v.actual.sha256='a'.repeat(64);},v=>{v.actual.bytes--;},v=>{v.actual.path+='.other';},v=>{v.expected.sourceURL+='?other';},v=>{v.mode='unverified';}]){
  const value=adapterBrowserReceipt(plan);mutate(value);let calls=0;const records=[];assert.throws(()=>provisionFastBrowserSetup(root,plan,{execute:()=>{calls++;return Buffer.from(JSON.stringify(value));},record:row=>records.push(structuredClone(row))}),/receipt differs/);assert.equal(calls,1,'fixture mismatch prevents browser installation');assert.equal(records.at(-1).status,'FAIL');assert.equal(records.at(-1).browser,null);assert.equal(records.at(-1).adapterFixture,null);
 }
 for(const phase of ['fixture','browser']){
  let calls=0;const records=[];assert.throws(()=>provisionFastBrowserSetup(root,plan,{execute:()=>{calls++;if(phase==='fixture'||calls===2)throw Error('actual '+phase+' child failure');return Buffer.from(JSON.stringify(adapterBrowserReceipt(plan)));},record:row=>records.push(structuredClone(row))}),new RegExp('actual '+phase+' child failure'));
  assert.equal(calls,phase==='fixture'?1:2);assert.equal(records.at(-1).status,'FAIL');assert.equal(records.at(-1).browser,null);assert.equal(records.at(-1).adapterFixture!==null,phase==='browser');
 }
 const missing=[];let calls=0;assert.throws(()=>provisionFastBrowserSetup(root,plan,{execute:()=>{calls++;return Buffer.alloc(0);},record:row=>missing.push(structuredClone(row))}),SyntaxError);assert.equal(calls,1);assert.equal(missing.at(-1).status,'FAIL');
});


test('Fast request review, queue and candidate provisioning keep one pinned engine and refuse unrelated fixture authority',()=>{
 for(const family of ['request-review','queue','e2'])for(const engine of ['chromium','firefox','webkit']){
  const plan=selectedFastBrowserSetup(process.cwd(),family,engine),commands=[],records=[];
  assert.deepEqual(plan.history,[]);assert.equal(plan.adapterFixture,null);
  const result=provisionFastBrowserSetup(process.cwd(),plan,{execute:(command,args,options)=>{
   commands.push([command,...args]);assert.equal(command,process.execPath);assert.equal(options.cwd,process.cwd());
   assert.deepEqual(args,[join(process.cwd(),'node_modules/playwright/cli.js'),'install','--with-deps',engine]);
   assert.equal(options.timeout,7*60_000);return Buffer.alloc(0);
  },record:row=>records.push(structuredClone(row))});
  assert.equal(commands.length,1);assert.equal(result.status,'PASS');assert.equal(result.adapterFixture,null);
  assert.deepEqual(records.map(row=>row.status),['PENDING','PASS']);assert.equal(result.qualification,false);
  const changed=structuredClone(plan);changed.adapterFixture=selectedFastBrowserSetup(process.cwd(),'adapters','chromium').adapterFixture;
  let calls=0;assert.throws(()=>provisionFastBrowserSetup(process.cwd(),changed,{execute:()=>{calls++;throw Error('must not execute');}}),/prerequisite differs/);assert.equal(calls,0);
  const failures=[];let failedCalls=0;const unavailable=Error('Pinned '+engine+' unavailable for '+family);
  assert.throws(()=>provisionFastBrowserSetup(process.cwd(),plan,{execute:()=>{failedCalls++;throw unavailable;},record:row=>failures.push(structuredClone(row))}),error=>error===unavailable);
  assert.equal(failedCalls,1);assert.deepEqual(failures.map(row=>row.status),['PENDING','FAIL']);assert.equal(failures.at(-1).browser,null);assert.equal(failures.at(-1).adapterFixture,null);
 }
});


for(const engine of ['chromium','firefox','webkit']){
 test('Fast text admission retains both complete specs and the original fixture on '+engine,()=>{
  const plan=fastBrowserPlan('text',engine),setup=selectedFastDispatchSetup(process.cwd(),{
   SELECTED_NODE_FILES:'',SELECTED_BROWSER_FAMILY:'text',SELECTED_BROWSER:engine,
  }),files=['tests/text/renderer.spec.ts','tests/text/budget-boundary.spec.ts'];
  const textApp=join(plan.browserPlan.output,'text-app'),destination=join(plan.browserPlan.output,`text-${engine}`),[fixtureStep,step]=plan.browserPlan.steps;
  assert.deepEqual(plan.browserPlan.steps.map(row=>row.id),['build-text-consumer',`text-${engine}`]);
  assert.deepEqual(fixtureStep,{id:'build-text-consumer',family:'fixture-build',browser:null,executable:'npm',
   args:['exec','--','vite','build','--config','tests/text/vite.config.ts'],config:null,files:[],env:{TEXT_APP:textApp},
   outputRoot:textApp,output:textApp,reportFile:null,timeoutMs:300000});
  assert.equal(step.family,'text');assert.equal(step.browser,engine);assert.equal(step.executable,'npm');
  assert.equal(step.config,'tests/text/playwright.config.ts');assert.equal(step.project,engine);assert.deepEqual(step.files,files);
  assert.deepEqual(step.args,['exec','--','playwright','test','--config','tests/text/playwright.config.ts',...files,'--project',engine,
   '--forbid-only','--max-failures=1','--reporter','list,json,./tooling/qualification/developer-campaigns/browser-reporter.mjs']);
  assert.deepEqual(step.env,{TEXT_RECEIPT:destination,TEXT_APP:textApp,
   PLAYWRIGHT_JSON_OUTPUT_FILE:join(destination,'results.json'),QUALIFICATION_CASE_REPORT:join(destination,'cases.ndjson')});
  assert.equal(step.outputRoot,destination);assert.equal(step.output,destination);
  assert.equal(step.reportFile,join(destination,'results.json'));assert.equal(step.caseReportFile,join(destination,'cases.ndjson'));
  assert.deepEqual(step.prerequisites,['build-text-consumer']);assert.deepEqual(step.contracts,[]);assert.equal(step.timeoutMs,1800000);
  assert.deepEqual(plan.browserPlan.prerequisites,['build-app','build-server','raster-inputs']);
  assert.deepEqual(setup.gates.map(gate=>gate.id),['typecheck','preflight','storage-environment','vendor','text-inputs','imports','raster-inputs','build-server','build-app']);
  assert.deepEqual(setup.selectedFiles,files);assert.deepEqual(plan.selectedFiles,[]);assert.deepEqual(setup.requiredBrowsers,[engine]);
  assert.deepEqual(setup.history,[]);assert.equal(setup.adapterFixture,null);assert.deepEqual(setup.issuers,[]);assert.equal(setup.issuerBudgetMs,0);
  assert.deepEqual(setup.browserSteps,[{id:'build-text-consumer',timeoutMs:300000,graceMs:5000,exitObservationMs:100},
   {id:`text-${engine}`,timeoutMs:1800000,graceMs:5000,exitObservationMs:100}]);
  assert.equal(setup.gateBudgetMs,1980900);assert.equal(setup.browserBudgetMs,2110200);
  assert.equal(setup.setupReserveMs,2400000);assert.equal(setup.finalizationReserveMs,900000);
  assert.equal(setup.totalBudgetMs,7391100);assert.equal(setup.jobMinutes,180);assert.equal(setup.qualification,false);
 });
 test('Fast text admission refuses partial or changed whole-family plans on '+engine,()=>{
  const original=fastBrowserPlan('text',engine),mutations={
   'missing fixture':plan=>{plan.browserPlan.steps.shift();},
   'reordered steps':plan=>{plan.browserPlan.steps.reverse();},
   'missing spec':plan=>{plan.browserPlan.steps[1].files.pop();},
   'reordered specs':plan=>{plan.browserPlan.steps[1].files.reverse();},
   'foreign spec':plan=>{plan.browserPlan.steps[1].files[0]='tests/editor/native-text.spec.ts';},
   'changed config':plan=>{plan.browserPlan.steps[1].config='tests/editor/integration-regression.config.ts';},
   'changed project':plan=>{plan.browserPlan.steps[1].project=engine==='chromium'?'firefox':'chromium';},
   'missing fixture prerequisite':plan=>{plan.browserPlan.steps[1].prerequisites=[];},
   'changed fixture prerequisite':plan=>{plan.browserPlan.steps[1].prerequisites=['build-consumer'];},
   'changed fixture command':plan=>{plan.browserPlan.steps[0].args[5]='tests/recovery/vite.config.ts';},
   'changed fixture path':plan=>{plan.browserPlan.steps[0].env.TEXT_APP=join(plan.browserPlan.output,'other-app');},
   'extra grep':plan=>{plan.browserPlan.steps[1].args.push('--grep','one case');},
   'extra engine':plan=>{plan.requiredBrowsers.push(engine==='chromium'?'firefox':'chromium');},
  };
  for(const [label,mutate] of Object.entries(mutations)){const changed=structuredClone(original);mutate(changed);assert.throws(()=>fastBrowserSetupPlan(changed,{sourceFor:browserDeadlineSource}),/complete maintained family/,label);}
 });
 test('Fast text admission refuses an injected completion issuer prerequisite on '+engine,()=>{
  const plan=fastBrowserPlan('text',engine),issuer=fastBrowserPlan('editor-native-text',engine).gates.find(gate=>gate.id==='completion-source');
  assert(issuer);plan.gates.push(structuredClone(issuer));
  assert.throws(()=>fastBrowserSetupPlan(plan,{sourceFor:browserDeadlineSource}),/Browser issuer prerequisite changed/);
 });
}

test('Fast renderer transport is selected only for the genuine whole integration owner', () => {
 const selected = selectedFastSetup(process.cwd(), rendererReceiptOwner);
 assert.deepEqual(selected.rendererReceipts, rendererReceiptRequirement());
 assert(selected.gates.some(gate => gate.id === 'build-app'));
 assert.equal(selected.totalBudgetMs, selected.gateBudgetMs + 40*60_000 + 15*60_000);
 const unrelated = selectedFastSetup(process.cwd(), 'tests/campaigns/renderer-ownership.test.mjs');
 assert.equal(unrelated.rendererReceipts, null);
 let calls = 0;
 assert.throws(() => provisionFastSetup(process.cwd(), {...selected, rendererReceipts: null}, {execute: () => { calls++; }}), /Selected renderer receipt prerequisite/);
 assert.throws(() => provisionFastSetup(process.cwd(), {...unrelated, rendererReceipts: selected.rendererReceipts}, {execute: () => { calls++; }}), /Selected renderer receipt prerequisite/);
 assert.equal(calls, 0, 'Wrong selection must refuse before any child or Git command');
});
test('Fast renderer child is fixed and bounded and its retained result is authenticated before success', t => {
 const f=fixture(t), plan=selectedFastSetup(process.cwd(),rendererReceiptOwner), expected=plan.rendererReceipts;
 const leaf=join(f.cwd,'artifacts/validation/r18-inputs-fixture'),path=join(leaf,'receipt.json');mkdirSync(leaf,{recursive:true});
 const head='a'.repeat(40),recorded={kind:'fast-renderer-receipt-provisioning-1',qualification:false,status:'PASS',expected,headBefore:head,headAfter:head,transport:{copied:expected.files}};
 const bytes=Buffer.from(JSON.stringify(recorded));writeFileSync(path,bytes);
 const value={kind:recorded.kind,qualification:false,status:'PASS',expected,files:expected.files,receipt:{path,bytes:bytes.length,sha256:sha256(bytes)}};
 let children=0;
 const execute=(command,args,options)=>{
  if(command==='git'){assert.deepEqual(args.slice(4),['rev-parse','--verify','HEAD']);return Buffer.from(head+'\n');}
  assert.equal(command,process.execPath);assert(args[0].endsWith('/tooling/qualification/r18-ci-inputs.mjs'));assert.deepEqual(args.slice(1),[f.cwd]);
  assert.equal(options.timeout,11*60_000);assert.equal(options.maxBuffer,65536);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);children++;return Buffer.from(JSON.stringify(value));
 };
 const result=provisionFastSetup(f.cwd,plan,{execute});assert.equal(result.status,'PASS');assert.equal(children,1);assert.deepEqual(result.rendererReceipts.expected,expected);
 const observations=[];writeFileSync(path,Buffer.from(JSON.stringify({...recorded,status:'FAIL'})));
 assert.throws(()=>provisionFastSetup(f.cwd,plan,{execute,record:r=>observations.push(structuredClone(r))}),/readback differs/);
 assert.equal(observations.at(-1).status,'FAIL');assert.equal(observations.at(-1).headAfter,head);
});
test('Fast renderer child failure remains failure and still checks current checkout identity', t => {
 const f=fixture(t),plan=selectedFastSetup(process.cwd(),rendererReceiptOwner),observations=[];let heads=0;
 assert.throws(()=>provisionFastSetup(f.cwd,plan,{execute:(command,args)=>{
  if(command==='git'){heads++;return Buffer.from('b'.repeat(40)+'\n');}
  throw Error('fixed child interrupted; retained original failure');
 },record:r=>observations.push(structuredClone(r))}),/fixed child interrupted/);
 assert.equal(heads,2);assert.equal(observations.at(-1).status,'FAIL');assert.equal(observations.at(-1).rendererReceipts,null);
});


test('Fast shell dispatch retains the complete original Chromium suite and current-root prerequisites',()=>{
 const root=process.cwd(),plan=fastBrowserPlan('shell','chromium'),setup=selectedFastDispatchSetup(root,{
  SELECTED_NODE_FILES:'',SELECTED_BROWSER_FAMILY:'shell',SELECTED_BROWSER:'chromium',
 });
 const destination=join(plan.browserPlan.output,'shell-chromium'),[step]=plan.browserPlan.steps;
 assert.equal(plan.browserPlan.steps.length,1);assert.equal(step.id,'shell-chromium');assert.equal(step.family,'shell');assert.equal(step.browser,'chromium');
 assert.equal(step.config,'tests/browser/playwright.config.ts');assert.deepEqual(step.files,['tests/browser/shell.spec.ts']);assert.equal(Object.hasOwn(step,'project'),false);
 assert.equal(step.executable,'npm');assert.deepEqual(step.args,['exec','--','playwright','test','--config','tests/browser/playwright.config.ts','tests/browser/shell.spec.ts',
  '--forbid-only','--max-failures=1','--reporter','list,json,./tooling/qualification/developer-campaigns/browser-reporter.mjs']);
 assert.deepEqual(step.env,{IE_SHELL_OUTPUT:destination,PLAYWRIGHT_JSON_OUTPUT_FILE:join(destination,'shell-browser.json'),QUALIFICATION_CASE_REPORT:join(destination,'cases.ndjson')});
 assert.equal(step.outputRoot,destination);assert.equal(step.output,destination);assert.equal(step.reportFile,join(destination,'shell-browser.json'));assert.equal(step.caseReportFile,join(destination,'cases.ndjson'));
 assert.deepEqual(step.prerequisites,[]);assert.deepEqual(step.contracts,[]);assert.equal(step.timeoutMs,1800000);
 assert.deepEqual(plan.browserPlan.prerequisites,['build-app','build-server','raster-inputs']);
 assert.deepEqual(setup.selectedFiles,['tests/browser/shell.spec.ts']);assert.deepEqual(plan.selectedFiles,[]);assert.equal(plan.nodeFiles,null);
 assert.deepEqual(setup.requiredBrowsers,['chromium']);assert.deepEqual(setup.history,[]);assert.equal(setup.adapterFixture,null);assert.equal(setup.qualification,false);
 assert.deepEqual(setup.gates,[
  ['typecheck',300000],['preflight',60000],['completion-source',60000],['storage-environment',15000],
  ['vendor',300000],['text-inputs',300000],['imports',60000],['raster-inputs',300000],['build-server',300000],['build-app',300000],
 ].map(([id,timeoutMs])=>({id,timeoutMs,graceMs:5000,exitObservationMs:100})));
 assert.deepEqual(setup.browserSteps,[{id:'shell-chromium',timeoutMs:1800000,graceMs:5000,exitObservationMs:100}]);
 assert.deepEqual(setup.issuers,[{id:'browser-completion-issuers',timeoutMs:300000,graceMs:5000,exitObservationMs:100}]);
 assert.equal(setup.gateBudgetMs,2046000);assert.equal(setup.browserBudgetMs,1805100);assert.equal(setup.issuerBudgetMs,305100);
 assert.equal(setup.setupReserveMs,2400000);assert.equal(setup.finalizationReserveMs,900000);assert.equal(setup.totalBudgetMs,7456200);assert.equal(setup.jobMinutes,180);
 const boundary=structuredClone(plan);boundary.gates[0].timeoutMs+=180*60_000-setup.totalBudgetMs;
 assert.equal(fastBrowserSetupPlan(boundary,{sourceFor:browserDeadlineSource}).totalBudgetMs,180*60_000);
 boundary.gates[0].timeoutMs++;assert.throws(()=>fastBrowserSetupPlan(boundary,{sourceFor:browserDeadlineSource}),/exceeds the 180-minute/);
});
test('Fast shell rejects non-Chromium at selection, plan and provisioning before any installation',()=>{
 const root=process.cwd(),allowed=selectedFastBrowserSetup(root,'shell','chromium');
 for(const engine of ['firefox','webkit']){
  assert.throws(()=>selectedFastBrowserSetup(root,'shell',engine),/The complete shell family requires Chromium/);
  assert.throws(()=>selectedFastDispatchSetup(root,{SELECTED_BROWSER_FAMILY:'shell',SELECTED_BROWSER:engine}),/The complete shell family requires Chromium/);
  // The maintained shell is always Chromium. The selected engine must never be
  // silently replaced with it, even though the shared planner can describe it.
  const plan=fastBrowserPlan('shell',engine);let sourceReads=0;
  assert.throws(()=>fastBrowserSetupPlan(plan,{sourceFor:()=>{sourceReads++;throw Error('must reject before source/deadline work');}}),/The complete shell family requires Chromium/);
  assert.equal(sourceReads,0);
  const changed=structuredClone(allowed);changed.engine=engine;changed.requiredBrowsers=[engine];let executions=0;const records=[];
  assert.throws(()=>provisionFastBrowserSetup(root,changed,{execute:()=>{executions++;throw Error('must not install');},record:row=>records.push(row)}),/The complete shell family requires Chromium/);
  assert.equal(executions,0);assert.deepEqual(records,[]);
 }
});
test('Fast shell refuses partial, substituted or widened original-family plans',()=>{
 const root=process.cwd(),original=fastBrowserPlan('shell','chromium');
 for(const mutate of [
  plan=>{plan.browserPlan.steps[0].files=['tests/editor/authoring.spec.ts'];},
  plan=>{plan.browserPlan.steps[0].files=[];},
  plan=>{plan.browserPlan.steps[0].config='tests/editor/integration-regression.config.ts';},
  plan=>{plan.browserPlan.steps[0].args.push('--grep','B03');},
  plan=>{plan.browserPlan.steps[0].project='chromium';},
  plan=>{plan.browserPlan.steps[0].env.IE_SHELL_OUTPUT+='-other';},
  plan=>{plan.browserPlan.steps.push(structuredClone(plan.browserPlan.steps[0]));},
  plan=>{plan.requiredBrowsers.push('firefox');},
  plan=>{plan.browserGrep='B03';},plan=>{plan.batchEditor=true;},plan=>{plan.workers=2;},
  plan=>{plan.gates=plan.gates.filter(gate=>gate.id!=='completion-source');},
  plan=>{plan.gates[0].freshFixtureFiles=['tests/portable/legacy.test.mjs'];},
 ]){const plan=structuredClone(original);mutate(plan);assert.throws(()=>fastBrowserSetupPlan(plan,{sourceFor:browserDeadlineSource}));}
 for(const family of ['shell,queue','shell;echo x'])assert.throws(()=>selectedFastBrowserSetup(root,family,'chromium'),/one reviewed whole editor family/);
 assert.throws(()=>selectedFastDispatchSetup(root,{SELECTED_NODE_FILES:'tests/qualification/development.test.mjs',SELECTED_BROWSER_FAMILY:'shell',SELECTED_BROWSER:'chromium'}),/either whole Node files/);
});
test('Fast shell provisions only the pinned Chromium CLI and retains actual installation failure without fallback',()=>{
 const root=process.cwd(),plan=selectedFastBrowserSetup(root,'shell','chromium'),commands=[],records=[];
 const result=provisionFastBrowserSetup(root,plan,{execute:(command,args,options)=>{
  commands.push([command,...args]);assert.equal(command,process.execPath);assert.equal(options.cwd,root);assert.equal(options.timeout,7*60_000);assert.equal(options.stdio,'inherit');
  assert.deepEqual(args,[join(root,'node_modules/playwright/cli.js'),'install','--with-deps','chromium']);return Buffer.alloc(0);
 },record:row=>records.push(structuredClone(row))});
 assert.equal(commands.length,1);assert.equal(result.status,'PASS');assert.equal(result.qualification,false);assert.equal(result.adapterFixture,null);assert.equal(result.browser.status,'PASS');
 assert.deepEqual(result.browser.command,commands[0]);assert.deepEqual(records.map(row=>row.status),['PENDING','PASS']);
 const unexpected=structuredClone(plan);unexpected.adapterFixture=selectedFastBrowserSetup(root,'adapters','chromium').adapterFixture;let extraCalls=0;
 assert.throws(()=>provisionFastBrowserSetup(root,unexpected,{execute:()=>{extraCalls++;throw Error('must not install');}}),/prerequisite differs/);assert.equal(extraCalls,0);
 const unavailable=Error('Pinned Chromium unavailable for shell'),failedCommands=[],failures=[];
 assert.throws(()=>provisionFastBrowserSetup(root,plan,{execute:(command,args)=>{failedCommands.push([command,...args]);throw unavailable;},record:row=>failures.push(structuredClone(row))}),error=>error===unavailable);
 assert.deepEqual(failedCommands,commands);assert.deepEqual(failures.map(row=>row.status),['PENDING','FAIL']);assert.equal(failures.at(-1).browser,null);assert.equal(failures.at(-1).adapterFixture,null);
});


test('Fast native profiler boolean executes its actual workflow selection guard before provisioning',t=>{
 const workflow=readFileSync('.github/workflows/validation.yml','utf8');
 const input=workflow.split('      e4_firefox_profiler:\n')[1].split('      host:\n')[0];
 assert.match(input,/^        type: boolean$/m);assert.match(input,/^        default: false$/m);
 const step=workflow.split('      - name: Validate optional E4 native profiler selection\n')[1].split('      - name: Select pinned toolchain')[0];
 const script=step.split('        run: |\n')[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
 assert(step.includes("SELECTED_E4_FIREFOX_PROFILER: ${{ github.event_name == 'workflow_dispatch' && inputs.e4_firefox_profiler && 'true' || 'false' }}"));
 const directory=mkdtempSync(join(tmpdir(),'e4-profiler-selection-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let sequence=0;
 const check=(changes,accepted,forwarded)=>{
  const path=join(directory,'environment-'+sequence++);writeFileSync(path,'');
  const env={PATH:process.env.PATH,GITHUB_ENV:path,SELECTED_E4_FIREFOX_PROFILER:'true',SELECTED_NODE_FILES:'',SELECTED_BROWSER_FAMILY:'e4',SELECTED_BROWSER:'firefox',SELECTED_HOST:'ubuntu-24.04',...changes};
  if(accepted)assert.doesNotThrow(()=>execFileSync('/bin/sh',['-c',script],{env,stdio:'pipe',timeout:1000}));
  else assert.throws(()=>execFileSync('/bin/sh',['-c',script],{env,stdio:'pipe',timeout:1000}),error=>error.status===1&&error.stderr.toString()==='E4_PROFILER_SELECTION\n');
  assert.equal(readFileSync(path,'utf8'),forwarded?'IE_E4_FIREFOX_PROFILER=1\n':'');
 };
 check({},true,true);
 check({SELECTED_E4_FIREFOX_PROFILER:'false',SELECTED_BROWSER_FAMILY:'none',SELECTED_BROWSER:'chromium',SELECTED_HOST:'macos-15'},true,false);
 for(const changes of [{SELECTED_BROWSER_FAMILY:'e3'},{SELECTED_BROWSER:'chromium'},{SELECTED_BROWSER:'webkit'},{SELECTED_HOST:'macos-15'},{SELECTED_HOST:'ubuntu-latest'},{SELECTED_NODE_FILES:'tests/session/store.test.mjs'},{SELECTED_E4_FIREFOX_PROFILER:'1'},{SELECTED_E4_FIREFOX_PROFILER:'private'}])check(changes,false,false);
});

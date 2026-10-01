import assert from 'node:assert/strict';
import test from 'node:test';
import {derivedConfiguration,executedCommand,sessionFor,pipelineBoundaries} from '../../tooling/qualification/ci/execute.mjs';
const plan={digest:'a'.repeat(64),affectedQ3:{jobs:['I0']}};
const node={side:'C',role:'base',stage:'p-base-restC',campaign:'P',command:['node','tooling/qualification/campaigns/run.mjs','run','--configuration','/sealed/base.json','--jobs','C9']};
test('CI effective configuration admits only the declared state namespace and predecessor handoff',()=>{
  const base={developerStateRoot:'/owned/state',developerInstall:true,registry:'retained'};
  const result=derivedConfiguration(plan,node,base);
  assert.equal(result.developerStateDirectory,`/owned/state/${plan.digest}/C-p-base`);
  assert.equal(result.registry,'retained');assert.equal(base.developerStateDirectory,undefined);
  assert.throws(()=>derivedConfiguration(plan,node,{...base,ciHandoff:{manifestPath:'/arbitrary'}}),/derived only/);
  assert.throws(()=>derivedConfiguration(plan,node,{developerStateRoot:'relative'}),/canonical/);
  assert.equal(sessionFor(plan,{...node,role:'candidate',stage:'p-candidate-H',side:'H'}),'p-candidate');
  assert.equal(sessionFor(plan,{...node,stage:'q3-base-i0-normal-restC'}),'q3-base-i0-normal');
  assert.equal(sessionFor(plan,{...node,stage:'q3-base-C',campaign:'Q3'}),'q3-base-i0-cold');
  assert.equal(sessionFor(plan,{...node,stage:'a-base-C'}),'p-base');
});
test('execution argv preserves every planned value and adds only exact subject/configuration paths',()=>{
  const command=executedCommand(node,'/owned/subject','/owned/config.json');
  assert.deepEqual(command,['node','tooling/qualification/campaigns/run.mjs','run','--configuration','/owned/config.json','--jobs','C9','--repo','/owned/subject']);
  assert.equal(node.command[4],'/sealed/base.json');
  assert.throws(()=>executedCommand(node,'relative','/owned/config.json'),/absolute/);
});
test('pipeline boundary uses same C boot and first acknowledged C/H barrier, never sums child durations',()=>{
  const p={stages:[{key:'prepare',side:'C',dependencies:[]},{key:'rest',side:'C',dependencies:['prepare']},{key:'host',side:'H',dependencies:['prepare']},{key:'next',side:'C',dependencies:['rest','host']}],nodes:[{id:'prepare-C0',stage:'prepare',side:'C'}],boundaries:[{id:'I0',targetMs:5,ceilingMs:20,starts:[{cache:'normal',nodeIds:['prepare-C0'],terminalStages:['rest','host']}]}]};
  const point=n=>({kind:'same-host-monotonic-1',boot:'1'.repeat(64),nanoseconds:String(n*1e6),at:new Date(n).toISOString()});
  const records=[{stage:'prepare',clock:point(0),nodes:[{nodeId:'prepare-C0',pipelineStart:point(2)}]},{stage:'next',clock:point(14),nodes:[]}];
  const result=pipelineBoundaries(p,records,point(200));
  assert.equal(result[0].elapsedMs,12);assert.equal(result[0].status,'PASS');assert.equal(result[0].targetMiss,true);
  assert.equal(pipelineBoundaries(p,records.map(r=>r.stage==='next'?{...r,clock:{...r.clock,boot:'2'.repeat(64)}}:r),point(200))[0].status,'INCONCLUSIVE');
  assert.equal(pipelineBoundaries(p,[records[0]],point(200))[0].status,'FAIL');
  for(const malformed of [{nanoseconds:''},{nanoseconds:'01'},{boot:undefined},{kind:undefined},{at:'invalid'}]) {
    const copy=structuredClone(records);Object.assign(copy[0].nodes[0].pipelineStart,malformed);
    assert.equal(pipelineBoundaries(p,copy,point(200))[0].status,'INCONCLUSIVE');
  }
  assert.equal(pipelineBoundaries(p,[records[0]],{nanoseconds:''})[0].status,'INCONCLUSIVE');
  const wrongHost=structuredClone(p);wrongHost.stages.find(stage=>stage.key==='next').side='H';
  assert.equal(pipelineBoundaries(wrongHost,records,point(200))[0].status,'FAIL','H callback cannot replace the later C acknowledgment');
});

test('controller failures cannot be hidden by an otherwise passing child receipt',async()=>{
  const {controllerOutcome}=await import('../../tooling/qualification/ci/execute.mjs');
  const success={code:0,signal:null,timedOut:false,interrupted:false};
  assert.equal(controllerOutcome({provisioning:success,execution:success}),'PASS');
  for(const change of [{code:1},{signal:'SIGTERM'},{timedOut:true},{interrupted:true}]) for(const key of ['provisioning','execution'])
    assert.equal(controllerOutcome({provisioning:success,execution:success,[key]:{...success,...change}}),'FAIL');
  assert.equal(controllerOutcome({execution:success}),'FAIL');
});

test('C2 packet must match verified runtime observation and every metadata path must be sealed',async()=>{
  const {validateC2Transfer}=await import('../../tooling/qualification/ci/execute.mjs');
  const {sha256}=await import('../../tooling/qualification/ci/plan.mjs');
  const identity={bytes:4,sha256:'a'.repeat(64)},source={commit:'b'.repeat(40),digest:'c'.repeat(64)},node={id:'p-base-prepareC-C2',source};
  const stage={stage:'production-build',status:'completed',source:{head:source.commit,digest:source.digest},artifacts:{files:[{path:'app/a.js',...identity}]},buildProvenance:{path:'/original/provenance.json',...identity},commands:[{stdout:{path:'/original/stdout',...identity},stderr:{path:'/original/stderr',...identity}}]};
  const artifacts=[{path:'dist/app/a.js',...identity}],receiptLogs=['stdout','stderr'].map(stream=>({originalPath:`/original/${stream}`,path:`build-logs/${stream}.log`,...identity}));
  const packet={kind:'ci-c2-transfer-1',nodeId:node.id,source,c2Path:'c2-stage.json',buildProvenancePath:'build-provenance.json',artifacts:{files:artifacts,sha256:sha256(JSON.stringify(artifacts,null,2)+'\n')},receiptLogs,files:[...artifacts,{path:'c2-stage.json',...identity},{path:'build-provenance.json',...identity},...receiptLogs.map(({path,bytes,sha256})=>({path,bytes,sha256}))]};
  const receipt={groups:[{cell:{id:'C2/production-build'},attempts:[{prime:false,status:'PASS',result:{observations:stage}}]}]};
  assert.equal(validateC2Transfer(packet,stage,node,receipt),packet);
  const changed=structuredClone(stage);changed.artifacts.files[0].sha256='d'.repeat(64);
  assert.throws(()=>validateC2Transfer(packet,changed,node,receipt),/verified runtime/);
  for(const mutate of [p=>p.c2Path='../outside',p=>p.buildProvenancePath='not-sealed.json',p=>p.receiptLogs[0].path='../outside',p=>p.receiptLogs[0].originalPath='/replacement']) {
    const changed=structuredClone(packet);mutate(changed);assert.throws(()=>validateC2Transfer(changed,stage,node,receipt));
  }
});

test('D08 relative samples measure each revision from its own C start through both host completions',async()=>{
  const {pipelineComparisonSamples}=await import('../../tooling/qualification/ci/execute.mjs');
  const point=n=>({kind:'same-host-monotonic-1',boot:'1'.repeat(64),nanoseconds:String(n*1e6),at:new Date(n).toISOString()});
  const p={spec:{inputs:{C:{physicalHostId:'sha256:'+'a'.repeat(64)}},base:{commit:'base'},candidate:{commit:'candidate'}},boundaries:[],stages:[
    {key:'p-base-prepareC',side:'C',dependencies:[]},{key:'p-base-restC',side:'C',dependencies:['p-base-prepareC']},{key:'p-base-H',side:'H',dependencies:['p-base-prepareC']},
    {key:'p-candidate-prepareC',side:'C',dependencies:['p-base-restC','p-base-H']},{key:'p-candidate-restC',side:'C',dependencies:['p-candidate-prepareC']},{key:'p-candidate-H',side:'H',dependencies:['p-candidate-prepareC']},
    {key:'next',side:'C',dependencies:['p-candidate-restC','p-candidate-H']}],nodes:['base','candidate'].map(role=>({id:`p-${role}-prepareC-C0`,stage:`p-${role}-prepareC`,side:'C',job:'C0',cache:'normal'}))};
  const records=[{stage:'p-base-prepareC',clock:point(0),nodes:[{nodeId:'p-base-prepareC-C0',pipelineStart:point(2)}]},
    {stage:'p-candidate-prepareC',clock:point(14),nodes:[{nodeId:'p-candidate-prepareC-C0',pipelineStart:point(16)}]},{stage:'next',clock:point(30),nodes:[]}];
  const samples=pipelineComparisonSamples(p,records,point(200));
  assert.deepEqual(samples.map(({scope,role,elapsedMs})=>({scope,role,elapsedMs})),[{scope:'P-core',role:'base',elapsedMs:12},{scope:'P-core',role:'candidate',elapsedMs:14}]);
  assert.equal(samples[0].physicalHostId,p.spec.inputs.C.physicalHostId);
  const changed=structuredClone(records);changed[1].nodes[0].pipelineStart.boot='2'.repeat(64);
  assert.equal(pipelineComparisonSamples(p,changed,point(200))[1].status,'INCONCLUSIVE');
});

test('adapter audits use only coordinator-selected predecessor receipts',async()=>{
  const {expectedAuditJobs}=await import('../../tooling/qualification/ci/execute.mjs');
  assert.deepEqual(expectedAuditJobs({job:'AC3'}),['AC1','AC2']);assert.deepEqual(expectedAuditJobs({job:'AH3'}),['AH1','AH2']);assert.deepEqual(expectedAuditJobs({job:'AC1'}),[]);
  assert.throws(()=>derivedConfiguration(plan,node,{developerStateRoot:'/owned/state',auditReceipts:[]}),/derived only/);
  const receipts=[{job:'AC1',path:'/retained/ac1.json',sha256:'a'.repeat(64)},{job:'AC2',path:'/retained/ac2.json',sha256:'b'.repeat(64)}];
  assert.deepEqual(derivedConfiguration(plan,{...node,job:'AC3'},{developerStateRoot:'/owned/state'},null,receipts).auditReceipts,receipts);
  assert.throws(()=>derivedConfiguration(plan,{...node,job:'AC1'},{developerStateRoot:'/owned/state'},null,receipts),/Unexpected audit/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createCiPlan, validateCiPlan, workflowExport, executionState, selectAffectedQ3, orders, digest, sha256, runtime} from '../../tooling/qualification/ci/plan.mjs';
import {immutableSource, immutableDiff, verifyImmutablePlan, parseOptions, validateNodeReceiptIdentity} from '../../tooling/qualification/ci/run.mjs';
import {requiredCampaignJobs, makeCampaignPlan} from '../../tooling/qualification/campaigns/inventory.mjs';

const base = {commit: 'a'.repeat(40), tree: 'b'.repeat(40), digest: 'c'.repeat(64)};
const candidate = {commit: 'd'.repeat(40), tree: 'e'.repeat(40), digest: 'f'.repeat(64)};
function input(paths = ['src/new-feature.ts'], features = 'adapters') {
  const files = side => ({physicalHostId: 'sha256:' + (side === 'C' ? '1' : '2').repeat(64),
    ...Object.fromEntries(['hostAttestation','fixtureManifest','configuration'].map((name,index) => [name, {path: `/sealed/${side}/${name}.json`, sha256: String(index + 3).repeat(64)}]))});
  const sorted = [...new Set(paths)].sort();
  return {base, candidate, features, cache: 'normal', outputRoot: 'artifacts/ci-unique-run',
    diff: {base: base.commit, candidate: candidate.commit, paths: sorted, pathsDigest: digest(sorted), rawSha256: sha256(sorted.join('\0'))},
    inputs: {C: files('C'), H: files('H')}};
}
function observation(plan, node, index, outcome = 'PASS') {
  return {kind: 'ci-qualification-node-observation-1', planDigest: plan.digest, nodeId: node.id,
    source: node.source, side: node.side, physicalHostId: node.physicalHostId, inputs: node.inputs,
    command: node.command, output: node.output, receiptSha256: '1'.repeat(64), outcome,
    startedAt: new Date(index * 1000).toISOString(), finishedAt: new Date((index + 1) * 1000).toISOString()};
}

test('CI core pairs retain exact C/H serial order and H waits for its own C2 artifact', () => {
  const plan = createCiPlan(input([]));
  for (const role of ['base','candidate']) {
    assert.deepEqual(plan.nodes.filter(node => node.role === role && node.stage.startsWith('p-') && node.side === 'C').map(node => node.job), orders.C);
    assert.deepEqual(plan.nodes.filter(node => node.role === role && node.stage.startsWith('p-') && node.side === 'H').map(node => node.job), orders.H);
    const h0 = plan.nodes.find(node => node.id === `p-${role}-H-H0`);
    assert.deepEqual(h0.dependencies, [`p-${role}-prepareC-C2`]);
    assert.equal(h0.artifactFrom, `p-${role}-prepareC-C2`);
  }
  const candidateC0 = plan.nodes.find(node => node.id === 'p-candidate-prepareC-C0');
  assert.deepEqual(candidateC0.dependencies, ['p-base-restC-C8','p-base-H-H6']);
  assert.equal(plan.restrictions.providerCalls, 0);
  assert.equal(plan.restrictions.hostedTimingSubstitution, false);
});

test('both adapter branches always follow both core revisions; candidate A waits for entire base A', () => {
  const plan = createCiPlan(input([], 'adapters'));
  assert.deepEqual(plan.nodes.find(node=>node.id==='a-base-prepareC-AC0').dependencies,['p-candidate-restC-C8','p-candidate-H-H6']);
  assert.deepEqual(plan.nodes.find(node=>node.id==='a-candidate-prepareC-AC0').dependencies,['a-base-C-AC3','a-base-H-AH3']);
  for (const side of ['C','H']) {
    const firstJob=side==='C'?'AC1':'AH0';
    const original = plan.nodes.find(node => node.id === `a-base-${side}-${firstJob}`);
    assert.deepEqual(original.dependencies, ['a-base-prepareC-AC0']);
    const next = plan.nodes.find(node => node.id === `a-candidate-${side}-${firstJob}`);
    assert.deepEqual(next.dependencies, ['a-candidate-prepareC-AC0']);
  }
  assert.equal(createCiPlan(input([], 'core')).nodes.some(node => node.stage.startsWith('a-')), false);
  assert.throws(() => createCiPlan(input([], 'training')), /Only implemented/);
});

test('affected Q3 is a conservative immutable-path union; unknown and shared changes select every active job', () => {
  for (const features of ['core','adapters']) {
    const all = requiredCampaignJobs('Q3', features);
    for (const path of ['new-file.ts','src/raster-old/a.ts','docs/spec/testing.md','server/storage/new.ts','.github/workflows/qualification.yml']) assert.deepEqual(selectAffectedQ3([path], {features}).jobs, all);
    const selected = selectAffectedQ3(['server/provider/policy.ts'], {features}).jobs;
    assert.equal(selected.includes('I2'), false); assert.equal(selected.length, all.length - 1);
    assert.deepEqual(selectAffectedQ3(['server/provider/policy.ts','package-lock.json'], {features}).jobs, all);
    assert.deepEqual(selectAffectedQ3([], {features}).jobs, []);
  }
  for (const path of ['/absolute','../escape','src/../file','a\\b','src//file','a\nfile']) assert.throws(() => selectAffectedQ3([path]), /safe repository-relative/);
});

test('I0 expands exactly normal/cold fresh two-host core graphs; Q3 candidate follows all base work', () => {
  const plan = createCiPlan(input());
  assert.equal(plan.boundaries.length, 4);
  for (const role of ['base','candidate']) {
    const boundary = plan.boundaries.find(value => value.id === `q3-${role}-I0`);
    assert.deepEqual(boundary.starts.map(start => start.cache), ['normal','cold']);
    assert.deepEqual(boundary.starts.map(start => start.nodeIds.length), [22,22]);
    assert.equal(boundary.ceilingMs, 105 * 60_000);
    assert.equal(boundary.starts.some(start => start.nodeIds.some(id => id.includes('-AC') || id.includes('-AH'))), false);
  }
  assert.equal(plan.nodes.some(node => node.job === 'I0'), false, 'Never invoke a multi-host I0 as one runtime job');
  assert.deepEqual(plan.nodes.find(node => node.id === 'q3-candidate-i0-normal-prepareC-C0').dependencies, ['q3-base-C-I12C','q3-base-H-I13H']);
  assert.deepEqual(plan.nodes.filter(node => node.stage === 'q3-base-C').map(node => node.job), orders.QC);
  assert.deepEqual(plan.nodes.filter(node => node.stage === 'q3-base-H').flatMap(node => node.jobs), orders.QH);
});

test('workflow export preserves concurrent stage layers, exact runtime argv and isolated output roots', () => {
  const plan = createCiPlan(input()), exported = workflowExport(plan);
  assert.equal(exported.scheduleActivated, false); assert.equal(exported.qualification, false);
  assert.deepEqual(exported.layers[0], ['p-base-prepareC']);
  assert.deepEqual(exported.layers[1], ['p-base-restC','p-base-H']);
  assert.equal(new Set(plan.nodes.map(node => node.output)).size, plan.nodes.length);
  for (const node of plan.nodes) {
    assert.deepEqual(node.command.slice(0,3), ['node',runtime,'run']);
    assert.equal(node.command.includes('--diagnostic'), false);
    assert.deepEqual(node.runnerLabels, ['self-hosted',`ideogram-perf-${node.side}`]);
    const selected = makeCampaignPlan({campaign: node.campaign, features: plan.spec.features, cache: node.cache, jobs: node.jobs});
    assert.deepEqual(selected.jobs.map(job => job.id), node.jobs);
  }
});

test('canonical validator rejects altered graph, source, diff, command, output and host identities', () => {
  const plan = createCiPlan(input()); assert.equal(validateCiPlan(plan).digest, plan.digest);
  for (const mutate of [
    value => value.nodes[0].dependencies.push('not-real'), value => value.nodes.reverse(),
    value => value.nodes[0].command.push('--diagnostic'), value => value.nodes[0].source.commit = '0'.repeat(40),
    value => value.stages[0].nodeIds.pop(), value => value.nodes[0].output = 'artifacts/reused',
    value => value.spec.diff.paths.push('new-source'), value => value.digest = '0'.repeat(64),
  ]) { const altered = structuredClone(plan); mutate(altered); assert.throws(() => validateCiPlan(altered)); }
  const same = input(); same.candidate = same.base; assert.throws(() => createCiPlan(same), /distinct/);
  const sameHost = input(); sameHost.inputs.H.physicalHostId = sameHost.inputs.C.physicalHostId; assert.throws(() => createCiPlan(sameHost), /independent/);
  const badOutput = input(); badOutput.outputRoot = '../outside'; assert.throws(() => createCiPlan(badOutput));
});

test('execution ledger blocks missing/failed dependencies, duplicates, host overlap and receipt identity drift', () => {
  const plan = createCiPlan(input([], 'core'));
  assert.equal(executionState(plan).states[0].state, 'READY');
  const first = observation(plan, plan.nodes[0], 0);
  assert.equal(executionState(plan, [first]).states[1].state, 'READY');
  assert.throws(() => executionState(plan, [first, first]), /duplicate/);
  assert.throws(() => executionState(plan, [observation(plan, plan.nodes[1], 1)]), /dependency/);
  const failed = {...first, outcome: 'FAIL'};
  assert.equal(executionState(plan, [failed]).outcome, 'FAIL');
  assert.equal(executionState(plan, [failed]).states[1].state, 'BLOCKED');
  const altered = {...first, receiptSha256: '', qualification: true}; assert.throws(() => executionState(plan, [altered]), /receipt mismatch/);
  const complete = plan.nodes.map((node,index) => observation(plan,node,index));
  assert.equal(executionState(plan, complete).outcome, 'COMMANDS_COMPLETE');
  assert.equal(executionState(plan, complete).qualification, false, 'Command receipts alone do not close whole-pipeline/manual evidence');
  const overlap = structuredClone(complete); overlap[1].startedAt = overlap[0].startedAt; assert.throws(() => executionState(plan, overlap), /dependency|Competing/);
});

test('immutable Git discovery uses exact commits and preserves both sides of renames/deletions without working-tree inputs', () => {
  const calls = [], raw = Buffer.from('old/file.ts\0new/file.ts\0removed.ts\0');
  const diff = immutableDiff('/repository', base.commit, candidate.commit, (_root,args) => {calls.push(args); return raw;});
  assert.deepEqual(diff.paths, ['new/file.ts','old/file.ts','removed.ts']);
  assert.deepEqual(calls[0], ['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',base.commit,candidate.commit,'--']);
  assert.equal(diff.rawSha256, sha256(raw));
  assert.throws(() => immutableDiff('/repository','HEAD',candidate.commit), /immutable/);
  const bytes = Buffer.from('export const fixture = 1;\n'), blob = '1'.repeat(40);
  const identity = immutableSource('/repository',base.commit, (_root,args) => {
    if (args[0] === 'rev-parse') return Buffer.from(args.at(-1).endsWith('^{tree}') ? base.tree : base.commit);
    if (args[0] === 'ls-tree') return Buffer.from([`100644 blob ${blob}\tsrc/a.ts`, `100644 blob ${blob}\tunrelated.txt`, ''].join('\0'));
    assert.deepEqual(args,['cat-file','blob',blob]); return bytes;
  });
  assert.equal(identity.digest, digest([{path:'src/a.ts',bytes:bytes.length,sha256:sha256(bytes)}]));
});

test('CI CLI has read-only plan/export/verify modes and rejects duplicate or unknown switches', () => {
  assert.equal(parseOptions(['plan','--base',base.commit]).mode, 'plan');
  for (const args of [['run'],['plan','--base','a','--base','b'],['plan','--paid','yes'],['plan','--inputs']]) assert.throws(() => parseOptions(args));
});

test('actual child identity requires exact source, job plan, argv and consumed input hashes, not an outer PASS', () => {
  const value = input([], 'core');
  value.base = {...value.base, digest: digest([])}; value.candidate = {...value.candidate, digest: digest([])};
  const plan = createCiPlan(value), node = plan.nodes[0];
  const identity = {head: node.source.commit, files: [], digest: digest([])};
  const child = {kind: 'perf-runtime-campaign-1',
    plan: makeCampaignPlan({campaign: node.campaign, features: plan.spec.features, cache: node.cache, jobs: node.jobs}),
    argv: ['/pinned/node', runtime, ...node.command.slice(2)], identity: {before: identity, after: identity,controlBefore:{...identity,head:plan.spec.control.commit},controlAfter:{...identity,head:plan.spec.control.commit}},
    inputIdentities: Object.fromEntries(['hostAttestation','fixtureManifest','configuration'].map(key => [key, {path: node.inputs[key].path, bytes: 100, sha256: 'sha256:' + node.inputs[key].sha256}]))};
  assert.equal(validateNodeReceiptIdentity(plan,node.id,child).node.id,node.id);
  for (const change of [
    copy => {delete copy.inputIdentities; copy.qualification = true;},
    copy => copy.inputIdentities.configuration.sha256 = 'sha256:' + '0'.repeat(64),
    copy => copy.argv.push('--diagnostic'), copy => copy.identity.controlAfter.head='0'.repeat(40), copy => copy.identity.after = {...identity, head: candidate.commit},
    copy => copy.plan = makeCampaignPlan({campaign:'P',features:'core',jobs:['C1']}),
  ]) {const altered=structuredClone(child);change(altered);assert.throws(()=>validateNodeReceiptIdentity(plan,node.id,altered));}
});

test('ordinary P core and adapter pairs retain required whole-pipeline boundaries',()=>{
  const normal=createCiPlan(input([])),cold=createCiPlan({...input([]),cache:'cold'});
  assert.equal(normal.boundaries.find(row=>row.id==='p-core-pair').ceilingMs,100*60_000);
  assert.equal(cold.boundaries.find(row=>row.id==='p-core-pair').ceilingMs,120*60_000);
  const adapter=normal.boundaries.find(row=>row.id==='p-adapter-pair');
  assert.equal(adapter.ceilingMs,15*60_000);assert.deepEqual(adapter.starts[0].nodeIds,['a-base-prepareC-AC0']);
  assert.deepEqual(adapter.starts[0].terminalStages,['a-candidate-C','a-candidate-H']);
});


test('imported plan must reproduce actual immutable source and diff rather than only its self hash',()=>{
  const bytes=Buffer.from('source'),blob='1'.repeat(40),files=[{path:'src/a.ts',bytes:bytes.length,sha256:sha256(bytes)}];
  const spec=input([],'core');spec.base={...spec.base,digest:digest(files)};spec.candidate={...spec.candidate,digest:digest(files)};
  spec.diff.rawSha256=sha256(Buffer.alloc(0));const plan=createCiPlan(spec);
  const readGit=(_root,args)=>{
    if(args[0]==='rev-parse'){const revision=args.at(-1).split('^')[0];return Buffer.from(args.at(-1).endsWith('^{tree}')?(revision===base.commit?base.tree:candidate.tree):revision);}
    if(args[0]==='ls-tree')return Buffer.from(`100644 blob ${blob}\tsrc/a.ts\0`);
    if(args[0]==='cat-file')return bytes;
    if(args[0]==='diff')return Buffer.alloc(0);
    throw Error('unexpected git call');
  };
  assert.equal(verifyImmutablePlan('/repo',plan,readGit).digest,plan.digest);
  assert.throws(()=>verifyImmutablePlan('/repo',plan,(root,args)=>args[0]==='diff'?Buffer.from('src/new.ts\0'):readGit(root,args)),/Immutable diff/);
});

test('first baseline schedules exactly one candidate full Q3 with two independent I0 core starts',()=>{
  for(const features of ['core','adapters']) {
    const value={...input([],features),purpose:'initial-baseline',base:null,diff:null};
    const plan=createCiPlan(value);
    assert.equal(validateCiPlan(plan).digest,plan.digest);
    assert.equal(plan.spec.base,null);assert.equal(plan.spec.diff,null);
    assert.deepEqual(plan.affectedQ3.jobs,requiredCampaignJobs('Q3',features));
    assert.ok(plan.nodes.every(node=>node.role==='candidate'&&node.source.commit===candidate.commit));
    assert.equal(plan.stages.some(stage=>/^(p-|a-)/.test(stage.key)),false,'No extra paired campaign');
    assert.deepEqual(plan.boundaries.map(boundary=>boundary.id),['q3-candidate-I0']);
    assert.deepEqual(plan.boundaries[0].starts.map(start=>[start.cache,start.nodeIds.length]),[['normal',22],['cold',22]]);
    assert.deepEqual(plan.nodes[0].dependencies,[]);
    assert.deepEqual(plan.nodes.find(node=>node.id==='q3-candidate-i0-cold-prepareC-C0').dependencies,['q3-candidate-i0-normal-restC-C8','q3-candidate-i0-normal-H-H6']);
    assert.equal(plan.nodes.length,44+requiredCampaignJobs('Q3',features).length-2,'I0 is expanded and I5a/I5b share a node');
    assert.deepEqual([...plan.nodes.filter(node=>node.campaign==='Q3').flatMap(node=>node.jobs),'I0'].sort(),requiredCampaignJobs('Q3',features).sort(),'Grouping preserves every required job');
    assert.deepEqual(workflowExport(plan).layers[0],['q3-candidate-i0-normal-prepareC']);
    assert.equal(executionState(plan).states[0].state,'READY');
    assert.equal(executionState(plan,plan.nodes.map((node,index)=>observation(plan,node,index))).outcome,'COMMANDS_COMPLETE');
  }
});

test('initial baseline refuses invented prior state, narrowed jobs and altered absolute boundaries',()=>{
  const value={...input([]),purpose:'initial-baseline',base:null,diff:null};
  assert.throws(()=>createCiPlan({...value,base}),/must not invent/);
  assert.throws(()=>createCiPlan({...value,diff:input([]).diff}),/must not invent/);
  assert.throws(()=>createCiPlan({...value,purpose:'unknown'}),/purpose/);
  const plan=createCiPlan(value);
  for(const mutate of [copy=>copy.affectedQ3.jobs.pop(),copy=>copy.nodes.pop(),copy=>copy.boundaries[0].ceilingMs++,copy=>copy.spec.purpose='comparison']) {
    const changed=structuredClone(plan);mutate(changed);assert.throws(()=>validateCiPlan(changed));
  }
  assert.equal(parseOptions(['plan','--purpose','initial-baseline','--candidate',candidate.commit]).purpose,'initial-baseline');
});

test('initial source verification reads only its immutable candidate and never invents a Git diff',()=>{
  const calls=[],bytes=Buffer.from('export const fixture = 1;\n'),blob='1'.repeat(40);
  const readGit=(_repository,args)=>{
    calls.push(args);
    if(args[0]==='rev-parse')return Buffer.from(args.at(-1).endsWith('^{tree}')?candidate.tree:candidate.commit);
    if(args[0]==='ls-tree')return Buffer.from(`100644 blob ${blob}\tsrc/a.ts\0`);
    assert.deepEqual(args,['cat-file','blob',blob]);return bytes;
  };
  const source=immutableSource('/repository',candidate.commit,readGit);
  const plan=createCiPlan({...input([]),purpose:'initial-baseline',base:null,diff:null,candidate:source});
  calls.length=0;assert.equal(verifyImmutablePlan('/repository',plan,readGit).digest,plan.digest);
  assert.equal(calls.some(args=>args[0]==='diff'),false);
  assert.ok(calls.filter(args=>args[0]==='rev-parse').every(args=>args.at(-1).startsWith(candidate.commit)));
  const changed=structuredClone(plan.spec);changed.candidate.digest='0'.repeat(64);
  assert.throws(()=>verifyImmutablePlan('/repository',createCiPlan(changed),readGit),/Immutable source/);
});


test('I5a/I5b share one exact runtime invocation without dropping either required job',()=>{
  const plan=createCiPlan(input());
  for(const role of ['base','candidate']) {
    const nodes=plan.nodes.filter(node=>node.stage===`q3-${role}-H`&&node.jobs.some(job=>job==='I5a'||job==='I5b'));
    assert.equal(nodes.length,1);const node=nodes[0];assert.equal(node.job,'I5a');
    assert.deepEqual(node.jobs,['I5a','I5b']);assert.equal(node.command[node.command.indexOf('--jobs')+1],'I5a,I5b');
    const runtime=makeCampaignPlan({campaign:node.campaign,features:plan.spec.features,cache:node.cache,jobs:node.jobs});
    assert.deepEqual(runtime.jobs.map(job=>job.id),['I5a','I5b']);
    assert.equal(plan.nodes.some(other=>other.id===`q3-${role}-H-I5b`),false);
  }
  const changed=structuredClone(plan);changed.nodes.find(node=>node.jobs.length===2).jobs.pop();
  assert.throws(()=>validateCiPlan(changed),/mismatch/);
});

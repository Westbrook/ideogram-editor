import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal, readJournal, digest, sanitize, createOutput, PrerequisiteError } from '../../tooling/qualification/campaigns/common.mjs';
import { evaluateHost } from '../../tooling/qualification/campaigns/host.mjs';
import { executionGroups, summarize, runPlan, recoverAttempts, optionsFromArgs, evaluateInteractionCohort, summarizeRetainedCampaign } from '../../tooling/qualification/campaigns/run.mjs';
import { normalizeResult, runLifecycle } from '../../tooling/qualification/campaigns/worker.mjs';

function fixturePlan() {
  return { campaign: 'P', features: 'adapters', jobs: [{ id: 'H3', cells: [{ id: 'H3/O4', operation: 'raster.decode', workload: 'W1', handler: 'browser', host: 'H', kind: 'operation', cold: 3, warm: 3, primes: 1, requirements: {}, phaseBudgets: [{ id: 'R12', phase: 'raster.decode', targetMs: 100, ceilingMs: 250 }] }] }] };
}
function completeGroups(plan) {
  return executionGroups(plan).map(group => ({ ...group, status: 'PASS', attempts: group.attempts.map(attempt => ({ ...attempt, id: `${group.cell.id}/${group.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`, cache: group.cache, status: 'PASS', elapsedMs: 7, result: { elapsedMs: 6, phases: [{ name: 'raster.decode', durationMs: 4 }] } })) }));
}

test('fixed execution groups isolate each cold process and retain one ordered primed warm cohort', () => {
  const groups = executionGroups(fixturePlan());
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map(group => [group.cache, group.attempts.length]), [['cold', 1], ['cold', 1], ['cold', 1], ['warm', 4]]);
  assert.deepEqual(groups[3].attempts, [{ ordinal: 1, prime: true }, { ordinal: 1, prime: false }, { ordinal: 2, prime: false }, { ordinal: 3, prime: false }]);
  const bad = fixturePlan(); bad.jobs[0].cells[0].warm = 0; assert.throws(() => executionGroups(bad), /Prime without/);
});

test('count-complete traces still cannot qualify on the wrong host or changed executable inputs', () => {
  const plan = fixturePlan(), groups = completeGroups(plan);
  assert.equal(summarize(plan, groups).status, 'INCONCLUSIVE');
  assert.equal(summarize(plan, groups, { hostEligible: true, sourceStable: true }).status, 'PASS');
  assert.equal(summarize(plan, groups, { hostEligible: true, sourceStable: false }).status, 'INCONCLUSIVE');
  assert.equal(summarize(plan, groups, { hostEligible: true, sourceStable: true, runError: { message: 'lost evidence' } }).status, 'INCONCLUSIVE');
});

test('missing starts retain measured ceiling failure and do not substitute success-only counts', () => {
  const plan = fixturePlan(), groups = completeGroups(plan).slice(0, 1);
  groups[0].attempts[0].result.phases[0].durationMs = 251;
  const summary = summarize(plan, groups, { hostEligible: true, sourceStable: true });
  assert.equal(summary.status, 'FAIL'); assert.equal(summary.counts.plannedScored, 6); assert.equal(summary.counts.attempted, 1); assert.equal(summary.missing.length, 6);
  assert.equal(summary.cells[0].phaseBudgets[0].status, 'FAIL');
});

test('duplicate/orphan/cache-substituted attempts and late priming cannot grant a passing receipt', () => {
  for (const change of [
    groups => groups.push(structuredClone(groups[0])),
    groups => groups[0].attempts[0].id = 'another-cell/cold/scored/1',
    groups => groups[0].cell.workload = 'W0',
    groups => groups[3].attempts.push(groups[3].attempts.shift()),
  ]) {
    const plan = fixturePlan(), groups = completeGroups(plan); change(groups);
    const summary = summarize(plan, groups, { hostEligible: true, sourceStable: true });
    assert.equal(summary.qualification, false); assert(summary.integrityErrors.length > 0);
  }
});

test('failure stops execution and leaves every later required start explicitly missing', async () => {
  const plan = fixturePlan(), seen = [];
  const groups = await runPlan(plan, {}, async group => { seen.push(group.id); return { ...group, status: 'FAIL', attempts: [] }; });
  assert.equal(seen.length, 1); const summary = summarize(plan, groups);
  assert.equal(summary.status, 'FAIL'); assert.equal(summary.missing.length, 7);
});

test('journal is append-only and hash-chained; interrupted tail is distinct from complete-line tampering', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'campaign-journal-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl'), journal = await createJournal(path);
  await journal.append({ event: 'attempt-start', attempt: { id: 'sample-1', status: 'INCONCLUSIVE' } });
  await journal.append({ event: 'attempt-action-start', id: 'sample-1', startMs: 12, reset: { cold: true } });
  await journal.close();
  const text = await readFile(path, 'utf8'), recovered = readJournal(text + '{"truncated');
  assert.equal(recovered.incompleteTail, true); assert.equal(recoverAttempts(recovered.events)[0].startMs, 12);
  assert.throws(() => readJournal(text.replace('sample-1', 'sample-2')), /chain mismatch/);
  await assert.rejects(createJournal(path), /EEXIST/);
});

test('output protection rejects reusing evidence and symlink traversal', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'campaign-output-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await createOutput(directory, 'artifacts/run-1'); assert.equal(output, join(directory, 'artifacts/run-1'));
  await assert.rejects(createOutput(directory, 'artifacts/run-1'), /EEXIST/);
  await mkdir(join(directory, 'elsewhere')); await symlink(join(directory, 'elsewhere'), join(directory, 'artifacts/link'));
  await assert.rejects(createOutput(directory, 'artifacts/link/run-2'), /canonical nonsymlink/);
  await assert.rejects(createOutput(directory, '../outside'), /under artifacts/);
});

test('host attestation cannot override observed macOS or hardware mismatch', () => {
  const observed = { node: 'v26.10.0', memoryBytes: 16 * 1024 ** 3, platform: 'darwin', architecture: 'arm64', osVersion: '26.6.1', machineModel: 'Macmini9,1', cpuModel: 'Apple M1', physicalCPUs: 8, hostnameHash: digest('machine'), observedAt: '2026-09-30T12:00:00Z' };
  const attestation = { profile: 'H', observedAt: observed.observedAt, hostnameHash: observed.hostnameHash, exclusive: true, competingWork: false, gpuCores: 8, storage: 'internal-512GB-SSD', acPower: true, powerMode: 'normal', refreshHz: 60, dpr: 2, viewport: { width: 1440, height: 900 }, nativeGPU: true, syntheticThrottle: false };
  assert.deepEqual(evaluateHost(observed, 'H', attestation).mismatches, ['macOS 15.7']);
  assert.equal(evaluateHost({ ...observed, osVersion: '15.7' }, 'H', attestation).eligible, true);
  assert.equal(evaluateHost({ ...observed, osVersion: '15.7' }, 'H', null).eligible, false);
});

test('CLI does not accept arbitrary count, training, unknown or duplicate overrides', () => {
  for (const args of [['--cold', '1'], ['--campaign', 'P', '--campaign', 'Q3'], ['--features', 'training'], ['--timeout-ms', '0'], ['--jobs', 'C9,C9'], ['--repo', 'relative']]) assert.throws(() => optionsFromArgs(args));
  const parsed = optionsFromArgs(['run', '--campaign', 'Q3', '--jobs', 'I10C', '--diagnostic']); assert.deepEqual(parsed.jobs, ['I10C']); assert.equal(parsed.diagnostic, true);
});

test('private payloads and accidental assertion failures cannot disappear into passing metadata', () => {
  const value = sanitize({ prompt: 'private', cookie: 'secret', status: 'PASS', token: 'sensitive', nested: { authorization: 'Bearer secret' }, url: 'https://example.test/?token=foo' });
  assert(!JSON.stringify(value).includes('sensitive')); assert.equal(value.status, 'PASS');
  assert.equal(normalizeResult({ status: 'pass', assertions: [{ passed: false }], phases: [] }, 1, 2).status, 'FAIL');
  assert.equal(normalizeResult({ status: 'pass', missing: ['paint trace'], phases: [] }, 1, 2).status, 'INCONCLUSIVE');
  assert.throws(() => normalizeResult({ status: 'pass', phases: [{ name: 'decode', durationMs: -1 }] }, 1, 2));
});

test('paired proxy overhead uses an evidenced difference rather than a fabricated phase span', () => {
  const plan = fixturePlan(), cell = plan.jobs[0].cells[0];
  cell.phaseBudgets = [{ id: 'R26', phase: 'control.proxy-added-hop', measurement: 'R26ProxyAddedHopMs', ceilingMs: 30 }];
  const groups = completeGroups(plan);
  for (const group of groups) for (const attempt of group.attempts) attempt.result.measurements = {
    R26ProxyAddedHopMs: { value: 12, unit: 'ms', method: 'same-clock proxy minus direct elapsed', evidence: { directMs: 20, proxyMs: 32 } },
  };
  assert.equal(summarize(plan, groups, { hostEligible: true, sourceStable: true }).status, 'PASS');
  groups[0].attempts[0].result.measurements.R26ProxyAddedHopMs.value = 31;
  assert.equal(summarize(plan, groups, { hostEligible: true, sourceStable: true }).status, 'FAIL');
  delete groups[0].attempts[0].result.measurements.R26ProxyAddedHopMs.evidence;
  assert.equal(summarize(plan, groups, { hostEligible: true, sourceStable: true }).status, 'INCONCLUSIVE');
});

test('P interaction cannot borrow first-use or hot-edit observations from another engine', () => {
  const cell = { id: 'H2/native-I', operation: 'interaction.brush', workload: 'W1', parameters: { browser: 'chromium' } };
  const plan = { campaign: 'P', jobs: [{ id: 'H2', cells: [cell,
    { id: 'H2/foreign-first', operation: 'interaction.first-use', workload: 'W1', parameters: { browser: 'webkit' } },
    { id: 'H2/foreign-hot', operation: 'developer.hot-update', workload: 'W1', parameters: { browser: 'webkit' } },
  ] }] };
  const observations = [
    ...Array.from({ length: 10 }, (_, ordinal) => ({ id: `H2/foreign-first/cold/scored/${ordinal + 1}`, prime: false, result: { firstUse: { id: `first-${ordinal}` } } })),
    ...Array.from({ length: 3 }, (_, ordinal) => ({ id: `H2/foreign-hot/warm/scored/${ordinal + 1}`, prime: false, result: { hotEdit: { id: `hot-${ordinal}` } } })),
  ];
  const [result] = evaluateInteractionCohort(plan, cell, observations);
  assert.equal(result.outcome, 'INCONCLUSIVE');
  assert(result.missing.includes('ten-first-use-windows'));
  assert(result.missing.includes('three-warm-hot-edits'));
  assert(result.missing.includes('exact-I-session-inventory'));
});

test('late resource sampler errors retain the complete observed lifecycle and final byte proof', async () => {
  for (const [error, expectedStatus] of [[Error('allocation ledger failed'), 'FAIL'], [new PrerequisiteError('native allocation observer unavailable'), 'INCONCLUSIVE']]) {
    const events = [], phases = [];
    const result = await runLifecycle({ workload: 'WA', jobId: 'AC2', parameters: { cycles: 2 } }, {
      lifecycleIdentity: async () => ({ pid: 1, owner: 'unit-test-double' }),
      measureResources: async () => ({ observerOnly: true }),
      lifecycleCycle: async (_, { cycle }) => { phases.push(cycle); return { status: 'PASS', phases: [], resourceSamples: [] }; },
      finalizeLifecycle: async () => ({ status: 'PASS', proof: 'retained-final-proof', phases: [] }),
      resourceSamplingEvidence: async () => { throw error; },
    }, {
      fixture: { manifestHash: digest('test-fixture') },
      // This is a state-preservation unit test, not a timed lifecycle receipt.
      // The evaluator would reject these unelapsed idle test doubles.
      wait: async requestedMs => ({ requestedMs, startMs: performance.now(), endMs: performance.now() }),
      trace: async event => { events.push(event); },
    });
    assert.equal(result.status, expectedStatus);
    assert.deepEqual(phases, [1, 2]);
    assert.equal(result.cycles.length, 2);
    assert(result.B0 && result.cycles.every(cycle => cycle.idle && cycle.observation));
    assert.equal(result.finalization.proof, 'retained-final-proof');
    assert.equal(result.sampling, null);
    assert.equal(result.samplingError.message, error.message);
    assert.equal(events.filter(event => event.event === 'lifecycle-cycle-end').length, 2);
    assert.equal(events.at(-1).event, 'lifecycle-sampling');
  }
});


test('live H-WA publication actually replays retained bytes before classifying asserted claims', async t => {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'wa-live-replay-'))); t.after(() => rm(output, {recursive: true, force: true}));
  const evidencePath = join(output, 'wa-observation.json'); await writeFile(evidencePath, 'actual observed bytes');
  const cell = {id: 'AH2/WA-lifecycle', operation: 'adapter.lifecycle', workload: 'WA', handler: 'browser', host: 'H', kind: 'lifecycle', cold: 1, warm: 0, primes: 0, requirements: {}, phaseBudgets: [], metricBudgets: []};
  const plan = {campaign: 'P', features: 'adapters', jobs: [{id: 'AH2', cells: [cell]}]}, groups = completeGroups(plan);
  groups[0].attempts[0].result = {kind: 'lifecycle-observation-1', profile: 'P-A', cycles: [], forcedGC: false, processRestarted: false};
  const receipt = {plan, groups, inputIdentities: {}, identity: {}, evidence: [{path: 'wa-observation.json', bytes: 21, sha256: digest('forged bytes')}], runError: null};
  const summary = await summarizeRetainedCampaign(receipt, output, {hostEligible: true, sourceStable: true});
  assert.match(receipt.nativeReplayError.message, /Evidence changed/);
  assert.equal(receipt.runError, receipt.nativeReplayError); assert.equal(receipt.summary, summary);
  assert.equal(summary.status, 'INCONCLUSIVE'); assert.equal(summary.qualification, false);
  // A definite product failure keeps precedence over unavailable replay.
  groups[0].attempts[0].status = 'FAIL'; groups[0].status = 'FAIL';
  assert.equal((await summarizeRetainedCampaign(receipt, output, {hostEligible: true, sourceStable: true})).status, 'FAIL');
});

import {runInNewContext} from 'node:vm';
import {runWorker} from '../../tooling/qualification/campaigns/worker.mjs';
import {ORDINARY_TEXT_OPERATIONS} from '../../tooling/qualification/campaigns/browser-ordinary-text.mjs';
import {ORDINARY_COMPOSITION_OPERATIONS} from '../../tooling/qualification/campaigns/browser-ordinary-composition.mjs';
import {TEXT_RESOURCE_OPERATIONS} from '../../tooling/qualification/campaigns/browser-text-resources.mjs';

// launchGroup is private. Execute its exact body through its first exclusive
// input publication, then stop before spawn. This is a construction/forwarding
// control, not a process-lifecycle or fixture-admission substitute. runWorker
// below uses its supported factory injection and real journal/receipt handling.
async function capturedPortableInput({operation='portable.reopen',environment={sourceDigest:'test-source'},renderer={sourceDigest:'test-renderer'}}={}){
 const source=await readFile(new URL('../../tooling/qualification/campaigns/run.mjs',import.meta.url),'utf8');
 const begin='async function launchGroup(group, context) {',end='\nasync function evidenceFiles(output) {';
 assert.equal(source.split(begin).length,2);assert.equal(source.split(end).length,2);
 const body=source.slice(source.indexOf(begin),source.indexOf(end));
 const safeCell=source.match(/^const safeCell = [^\n]+$/gm);assert.equal(safeCell?.length,1);
 const stop=Error('test-input-publication-boundary'),directories=[],selected=[],writes=[];
 const fixture={workload:'WXn',testOnly:true},configuration={browser:{headless:true}},timingLease={testOnly:true};
 const context={repo:'/subject',subjectRepo:'/subject',output:'/evidence',fixture,configuration,browserCache:'/pinned-browser-cache',timingLease,nativeImeEnvironment:environment,rendererIdentity:renderer};
 const group={id:'portable/cold/1',cell:{id:'portable',handler:'browser',operation,kind:'operation'},cache:'cold',attempts:[{ordinal:1,prime:false}]};
 const scope={join,ORDINARY_TEXT_OPERATIONS,ORDINARY_COMPOSITION_OPERATIONS,TEXT_RESOURCE_OPERATIONS,
  mkdir:async(path,options)=>{directories.push({path,options});},
  selectFixture:async(value,cell)=>{selected.push({value,cell});return value;},
  exclusiveJSON:async(path,value)=>{writes.push({path,value});throw stop;},
  spawn(){assert.fail('construction control must not launch a process');},
 };
 const launch=runInNewContext(safeCell[0]+'\n('+body+')',scope);
 await assert.rejects(launch(group,context),error=>error===stop);
 assert.equal(writes.length,1);assert.equal(writes[0].path,'/evidence/portable_cold_1/input.json');
 assert.deepEqual(directories.map(value=>[value.path,value.options.mode]),[['/evidence/portable_cold_1',0o700]]);
 assert.equal(selected.length,1);assert.equal(selected[0].value,fixture);assert.equal(selected[0].cell,group.cell);
 return {spec:writes[0].value,context,group};
}

test('actual launchGroup input publishes the exact portable environment and independent renderer inputs only for their operation',async()=>{
 const environment=Object.freeze({sourceDigest:'source',buildDigest:'build',toolsDigest:'tools',controlDigest:'control',host:{platform:'darwin'}});
 const {spec,context,group}=await capturedPortableInput({environment});
 assert.equal(spec.reopenFontEnvironment,environment);assert.equal(spec.rendererIdentity,context.rendererIdentity);
 assert.equal(spec.ordinaryCompositionEnvironment,environment);assert.equal(spec.ordinaryTextEnvironment,null);
 assert.equal(spec.nativeImeEnvironment,null);assert.equal(spec.recoveryTextEnvironment,null);assert.equal(spec.navigationEnvironment,null);
 assert.equal(spec.fixture,context.fixture);assert.equal(spec.configuration,context.configuration);assert.equal(spec.timingLease,context.timingLease);
 assert.equal(spec.attempts,group.attempts);assert.equal(spec.browserCache,context.browserCache);
 for(const operation of ['text.font-set','navigation.ready','text.recovery']){
  const other=await capturedPortableInput({operation,environment});assert.equal(other.spec.reopenFontEnvironment,null);
 }
 const missing=await capturedPortableInput({environment:null,renderer:null});assert.equal(missing.spec.reopenFontEnvironment,null);assert.equal(missing.spec.rendererIdentity,null);
});

async function portableWorkerSpec(t,{environment={sourceDigest:'exact-test-environment'},cache='cold',attempts=[{ordinal:1,prime:false}]}={}){
 const output=await realpath(await mkdtemp(join(tmpdir(),'portable-worker-forwarding-')));t.after(()=>rm(output,{recursive:true,force:true}));
 return {cell:{id:'portable-worker',operation:'portable.reopen',handler:'browser',kind:'operation'},cache,attempts,output,repo:'/subject',
  fixture:{workload:'WXn'},configuration:{browser:{headless:true}},reopenFontEnvironment:environment,
  nativeImeEnvironment:{sourceDigest:'must-not-be-used-as-fallback'},ordinaryCompositionEnvironment:{sourceDigest:'independent-composition'},rendererIdentity:{sourceDigest:'independent-renderer'}};
}

test('actual worker forwards the same portable binding across its ordered warm cohort and retains real cleanup/journal closure',async t=>{
 const environment=Object.freeze({sourceDigest:'exact-source',host:{platform:'linux'}}),spec=await portableWorkerSpec(t,{environment,cache:'warm',attempts:[{ordinal:1,prime:true},{ordinal:1,prime:false},{ordinal:2,prime:false}]});
 const actions=[],resets=[];let captured,closed=0;
 const receipt=await runWorker(spec,async context=>{captured=context;return {
  prepareCell:async cell=>({operation:cell.operation}),
  resetCell:async(cell,sample)=>{resets.push({...sample});return {status:'PASS',cache:sample.cache};},
  execute:async(cell,sample)=>{assert.equal(context.reopenFontEnvironment,environment);actions.push([cell.operation,sample.cache,sample.ordinal,sample.prime]);return {status:'PASS',phases:[]};},
  close:async()=>{closed++;return {testOnly:true,closed:true};},
 };});
 assert.equal(captured.reopenFontEnvironment,environment);assert.equal(captured.ordinaryCompositionEnvironment,spec.ordinaryCompositionEnvironment);
 assert.equal(captured.rendererIdentity,spec.rendererIdentity);assert.equal(captured.fixture,spec.fixture);assert.equal(captured.configuration,spec.configuration);
 assert.deepEqual(actions,[['portable.reopen','warm',1,true],['portable.reopen','warm',1,false],['portable.reopen','warm',2,false]]);
 assert.deepEqual(resets,spec.attempts.map(value=>({cache:'warm',...value})));assert.equal(closed,1);assert.equal(receipt.status,'PASS');
 assert.equal(receipt.attempts.length,3);assert.deepEqual(receipt.cleanup,{testOnly:true,closed:true});
 const journal=readJournal(await readFile(join(spec.output,'events.jsonl'),'utf8'));assert.equal(journal.incompleteTail,false);
 assert.equal(journal.events.filter(event=>event.event==='attempt-end').length,3);assert.equal(journal.events.at(-2).event,'process-cleanup');assert.equal(journal.events.at(-1).event,'process-end');
 const retained=JSON.parse(await readFile(join(spec.output,'receipt.json'),'utf8'));assert.equal(retained.status,'PASS');assert.equal(retained.attempts.length,3);assert.deepEqual(retained.cleanup,receipt.cleanup);
});

test('actual worker does not borrow another observer environment when portable input is absent',async t=>{
 const spec=await portableWorkerSpec(t,{environment:null});delete spec.reopenFontEnvironment;let closed=0,captured;
 const receipt=await runWorker(spec,async context=>{captured=context;return {resetCell:async()=>({status:'PASS'}),execute:async()=>{throw new PrerequisiteError('portable environment unavailable');},close:async()=>{closed++;return {closed:true};}};});
 assert.equal(captured.reopenFontEnvironment,null);assert.equal(captured.nativeImeEnvironment,spec.nativeImeEnvironment);
 assert.equal(receipt.status,'INCONCLUSIVE');assert.equal(receipt.attempts[0].error.code,'CAMPAIGN_PREREQUISITE');assert.equal(closed,1);
 const journal=readJournal(await readFile(join(spec.output,'events.jsonl'),'utf8'));assert.equal(journal.events.at(-1).status,'INCONCLUSIVE');
 assert.equal(JSON.parse(await readFile(join(spec.output,'receipt.json'),'utf8')).status,'INCONCLUSIVE');
});

test('actual worker preserves portable action rejection classification, stops later starts and closes the adapter once',async t=>{
 for(const error of [new PrerequisiteError('stale portable source'),Object.assign(Error('portable retained observation failed'),{code:'PORTABLE_TEST_REPLAY'})]){
  const spec=await portableWorkerSpec(t,{attempts:[{ordinal:1,prime:false},{ordinal:2,prime:false}]});let actions=0,closed=0;
  const receipt=await runWorker(spec,async context=>({resetCell:async()=>({status:'PASS'}),execute:async()=>{assert.equal(context.reopenFontEnvironment,spec.reopenFontEnvironment);actions++;throw error;},close:async()=>{closed++;return {closed:true};}}));
  const expected=error.code==='CAMPAIGN_PREREQUISITE'?'INCONCLUSIVE':'FAIL';
  assert.equal(receipt.status,expected);assert.equal(actions,1);assert.equal(closed,1);assert.equal(receipt.attempts.length,1);
  assert.equal(receipt.attempts[0].error.message,error.message);assert.equal(receipt.attempts[0].error.code,error.code);
  const journal=readJournal(await readFile(join(spec.output,'events.jsonl'),'utf8'));
  assert.equal(journal.events.filter(event=>event.event==='attempt-start').length,1);assert.equal(journal.events.at(-1).status,expected);
 }
});

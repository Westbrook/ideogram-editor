import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ADAPTER_LIFECYCLE_PHASES,
  ADAPTER_LIFECYCLE_ASSERTIONS,
  adapterLifecycleResult,
  measureAdapterAction,
  selectedAdapterIdentity,
} from '../../tooling/qualification/campaigns/adapter-lifecycle.mjs';
import {
  adapterAuditJobs,
  checkAdapterAuditBinding,
  performAdapterAudit,
  sharedAuditConfiguration,
} from '../../tooling/qualification/campaigns/adapter-audit.mjs';

const hash = character => character.repeat(64);
const ref = character => ({ hash: 'sha256:' + hash(character), byteLength: '256', mediaType: 'application/octet-stream' });
const selected = (versionId = 'adapter-version-1', version = '1') => ({
  adapterId: 'adapter-1', versionId, version, weights: ref('a'), config: ref('b'),
});
const observedAssertions = () => Object.fromEntries(ADAPTER_LIFECYCLE_ASSERTIONS.map(name => [name, true]));

async function observedPhases() {
  const phases = [], children = [];
  for (const name of ADAPTER_LIFECYCLE_PHASES) await measureAdapterAction(phases, children, name, async () => {});
  return phases;
}

test('adapter parent clocks bracket the actual action and preserve only its detailed child spans', async () => {
  const earlierChild = { name: 'already-finished', startMs: 0, endMs: 0, outcome: 'expected' };
  const phases = [], children = [earlierChild];
  let resume, enteredMs, leavingMs;
  const held = new Promise(resolve => { resume = resolve; });
  const beforeMs = performance.now();
  const execution = measureAdapterAction(phases, children, 'import', async span => {
    enteredMs = performance.now();
    assert.equal(span, phases[0]);
    await held;
    const child = { name: 'adapter.import-durable', startMs: performance.now(), outcome: 'expected', evidence: ['exact-durable-receipt'] };
    child.endMs = performance.now(); child.durationMs = child.endMs - child.startMs;
    children.push(child);
    leavingMs = performance.now();
    return 'durable-result';
  });
  assert.equal(phases.length, 1);
  assert.equal(phases[0].outcome, 'running');
  assert.equal(phases[0].endMs, undefined);
  resume();
  assert.equal(await execution, 'durable-result');
  const afterMs = performance.now(), span = phases[0];
  assert.equal(span.name, 'import'); assert.equal(span.outcome, 'expected');
  assert(beforeMs <= span.startMs && span.startMs <= enteredMs);
  assert(leavingMs <= span.endMs && span.endMs <= afterMs);
  assert.equal(span.durationMs, span.endMs - span.startMs);
  assert.deepEqual(span.childPhases, children.slice(1));
  assert.equal(span.childPhases[0], children[1]);
  assert.equal(children[0], earlierChild);
  assert(span.startMs <= children[1].startMs && children[1].endMs <= span.endMs);
  await assert.rejects(measureAdapterAction(phases, children, 'import', () => { throw Error('must not execute twice'); }), /occurs once/);
});

test('a failed actual adapter action retains its child evidence and completed failure clock', async () => {
  const phases = [], children = [], error = Object.assign(Error('durability refused'), { code: 'ENOSPC' });
  await assert.rejects(measureAdapterAction(phases, children, 'release', async () => {
    children.push({ name: 'last-consumer-release', outcome: 'failed', receipt: 'retained-partial' });
    throw error;
  }), candidate => candidate === error);
  const span = phases[0];
  assert.equal(span.outcome, 'failed');
  assert.deepEqual(span.error, { message: 'durability refused', code: 'ENOSPC' });
  assert(Number.isFinite(span.startMs) && Number.isFinite(span.endMs) && span.endMs >= span.startMs);
  assert.equal(span.durationMs, span.endMs - span.startMs);
  assert.deepEqual(span.childPhases, children);
});

test('selected adapter identity binds immutable versions even when their weights and config are shared', () => {
  const first = selectedAdapterIdentity(selected()), second = selectedAdapterIdentity(selected('adapter-version-2', '2'));
  assert.equal(first.value.weights.hash, second.value.weights.hash);
  assert.equal(first.value.config.hash, second.value.config.hash);
  assert.notEqual(first.identity, second.identity);
  assert.equal(first.identity, 'sha256:' + createHash('sha256').update(JSON.stringify(first.value)).digest('hex'));
  assert.deepEqual(first.value, { kind: 'selected-immutable-adapter-version-1', versionId: 'adapter-version-1', adapterId: 'adapter-1', version: '1', weights: ref('a'), config: ref('b') });
  assert.equal(selectedAdapterIdentity({ ...selected(), label: 'display-only rename' }).identity, first.identity);
  assert.notEqual(selectedAdapterIdentity({ ...selected(), config: null }).identity, first.identity);
  assert.throws(() => selectedAdapterIdentity({ ...selected(), weights: { ...ref('a'), hash: 'unverified' } }));
  assert.throws(() => adapterLifecycleResult({ phases: [], childPhases: [], selectedEntries: [selected(), selected()] }), /duplicate an immutable version/);
});

test('unobserved adapter semantics and release duration remain inconclusive while known failures dominate', async () => {
  const phases = await observedPhases(), childPhases = [], entries = [selected(), selected('adapter-version-2', '2')];
  const result = adapterLifecycleResult({ phases, childPhases, selectedEntries: entries, assertions: { fixedArtifactsImported: true } });
  assert.equal(result.status, 'inconclusive'); assert.equal(result.releaseMs, null);
  for (const name of ADAPTER_LIFECYCLE_ASSERTIONS.filter(name => name !== 'fixedArtifactsImported')) {
    assert.equal(result.assertions[name], null);
    assert(result.missing.some(message => message.includes(name)));
  }
  assert(result.missing.some(message => message.includes('release duration')));
  assert.deepEqual(result.selectedIdentities, entries.map(entry => selectedAdapterIdentity(entry).identity));
  assert.equal(result.phases, phases); assert.equal(result.childPhases, childPhases);
  assert.equal(adapterLifecycleResult({ phases, childPhases, assertions: { selectionRestored: false } }).status, 'fail');
  assert.equal(adapterLifecycleResult({ phases: [{ ...phases[0], outcome: 'failed' }], childPhases, assertions: observedAssertions(), releaseMs: 1 }).status, 'fail');
  assert.equal(adapterLifecycleResult({ phases, childPhases, selectedEntries: entries, weightsIdentity: ref('a').hash, configIdentity: ref('b').hash, assertions: observedAssertions(), releaseMs: 0 }).status, 'pass');
  assert.equal(adapterLifecycleResult({ phases, childPhases, assertions: observedAssertions(), releaseMs: 1, missing: ['Full fixture closure remains unobserved.'] }).status, 'inconclusive');
  assert.throws(() => adapterLifecycleResult({ phases, childPhases, assertions: { selectionRestored: 'assumed' } }), /observed true\/false or unknown null/);
});

test('adapter lifecycle cannot pass with missing or invalid parent clocks, fixed identities, selection, or release evidence', async () => {
  const complete = { phases: await observedPhases(), childPhases: [], selectedEntries: [selected()],
    weightsIdentity: ref('a').hash, configIdentity: ref('b').hash, assertions: observedAssertions(), releaseMs: 1 };
  assert.equal(adapterLifecycleResult(complete).status, 'pass');
  for (const mutate of [
    input => { input.phases = []; },
    input => { input.phases.reverse(); },
    input => { input.phases[0].outcome = 'completed'; },
    input => { input.phases[0].startMs = NaN; },
    input => { input.phases[0].startMs = -1; },
    input => { input.phases[0].endMs = Infinity; },
    input => { input.phases[1].startMs = input.phases[0].endMs - 1; },
    input => { input.phases[0].endMs = input.phases[0].startMs - 1; },
    input => { input.selectedEntries = []; },
    input => { input.selectedEntries = [1, 2, 3, 4].map(value => selected('version-' + value, String(value))); },
    input => { input.weightsIdentity = null; },
    input => { input.configIdentity = hash('b'); },
    input => { input.releaseMs = null; },
    input => { input.releaseMs = NaN; },
    input => { input.releaseMs = Infinity; },
    input => { input.releaseMs = -1; },
  ]) {
    const input = structuredClone(complete); mutate(input);
    const result = adapterLifecycleResult(input);
    assert.equal(result.status, 'inconclusive'); assert(result.missing.length > 0);
  }
});

function binding(job = 'AC1') {
  const source = { digest: hash('a'), head: 'b'.repeat(40) }, control = { digest: hash('c'), head: 'd'.repeat(40) };
  const configuration = { cache: 'cold', loops: 3, developerStateDirectory: '/retained/state', ciHandoff: { stage: 'candidate' }, auditReceipts: [{ job: 'unused-current-descriptor' }] };
  const descriptor = { nodeId: 'candidate.' + job, job, path: '/retained/' + job + '/receipt.json', sha256: hash('f') };
  const receipt = { kind: 'perf-runtime-campaign-1', plan: { campaign: 'P', features: 'adapters', selectedJobIds: [job], cache: 'cold' },
    summary: { status: 'PASS', counts: { expected: 3, observed: 3 } }, groups: [{ id: job + '.WA' }],
    identity: { before: { ...source }, after: { ...source }, controlBefore: { ...control }, controlAfter: { ...control } } };
  const inputs = [{ cell: { jobId: job, workload: 'WA' }, fixtureIdentity: { sha256: 'sha256:' + hash('e') }, configuration: { ...structuredClone(configuration), auditReceipts: [] } }];
  return { receipt, descriptor, inputs, configuration, fixtureHash: hash('e'), source, control };
}

test('adapter audit binds only the prescribed AC and AH predecessor jobs', () => {
  assert.deepEqual(adapterAuditJobs('AC3'), ['AC1', 'AC2']);
  assert.deepEqual(adapterAuditJobs('AH3'), ['AH1', 'AH2']);
  for (const job of ['AC1', 'AH2', 'AW3', 'AC30', undefined]) assert.throws(() => adapterAuditJobs(job), /AC3 or AH3/);
  for (const job of ['AC1', 'AC2', 'AH1', 'AH2']) {
    const args = binding(job), result = checkAdapterAuditBinding(args);
    assert.equal(result.status, 'PASS'); assert.equal(result.job, job);
    assert.equal(result.receiptPath, args.descriptor.path); assert.equal(result.receiptSha256, args.descriptor.sha256);
    assert.equal(result.groups, 1); assert.deepEqual(result.counts, args.receipt.summary.counts);
    assert.equal(result.sourceHead, args.source.head); assert.equal(result.controlHead, args.control.head);
  }
  for (const job of ['AC3', 'AH3', 'unrelated']) assert.throws(() => checkAdapterAuditBinding(binding(job)));
  const extra = binding(); extra.receipt.plan.selectedJobIds.push('AC2'); assert.throws(() => checkAdapterAuditBinding(extra), /exactly its prescribed predecessor/);
  const wrong = binding(); wrong.inputs[0].cell.jobId = 'AH1'; assert.throws(() => checkAdapterAuditBinding(wrong));
});

test('adapter audit rejects drift in either subject or control revision and source digest', () => {
  for (const side of ['before', 'after', 'controlBefore', 'controlAfter']) {
    for (const key of ['head', 'digest']) {
      const args = binding(); args.receipt.identity[side][key] = 'changed-' + key;
      assert.throws(() => checkAdapterAuditBinding(args), /source changed|revision changed/, side + '.' + key);
    }
  }
  const args = binding(); args.receipt.summary.status = 'INCONCLUSIVE';
  assert.throws(() => checkAdapterAuditBinding(args), /failed or incomplete predecessor/);
});

test('adapter audit rejects crossed, duplicate, extra, or missing predecessor bindings before source or writer access', async () => {
  for (const [jobId, jobs] of [
    ['AC3', ['AC1', 'AH2']], ['AH3', ['AC1', 'AC2']],
    ['AC3', ['AC1', 'AC1']], ['AH3', ['AH1']], ['AC3', ['AC1', 'AC2', 'AH1']],
  ]) {
    const context = { fixtureIdentity: { sha256: hash('e') }, configuration: { auditReceipts: jobs.map(job => binding(job).descriptor) } };
    for (const key of ['repo', 'subjectRepo', 'writer']) Object.defineProperty(context, key, { get() { throw Error('Premature access: ' + key); } });
    await assert.rejects(performAdapterAudit(context, { jobId }), error => error.name === 'AssertionError');
  }
  const context = { fixtureIdentity: { sha256: hash('e') }, configuration: { auditReceipts: ['AC1', 'AC2'].map(job => ({ ...binding(job).descriptor, path: '/retained/same-receipt.json' })) } };
  Object.defineProperty(context, 'repo', { get() { throw Error('Premature source access'); } });
  await assert.rejects(performAdapterAudit(context, { jobId: 'AC3' }), error => error.name === 'AssertionError');
});

test('adapter audit requires the exact sealed fixture and all consumed shared configuration fields', () => {
  assert.deepEqual(sharedAuditConfiguration({ known: 1, auditReceipts: ['different'] }), { known: 1 });
  const fixtureDrift = binding(); fixtureDrift.inputs[0].fixtureIdentity.sha256 = hash('f');
  assert.throws(() => checkAdapterAuditBinding(fixtureDrift), /same sealed WA fixture/);
  const absentFixture = binding(); delete absentFixture.inputs[0].fixtureIdentity;
  assert.throws(() => checkAdapterAuditBinding(absentFixture), /same sealed WA fixture/);
  for (const mutate of [
    configuration => { configuration.loops += 1; },
    configuration => { configuration.developerStateDirectory = '/different/state'; },
    configuration => { configuration.ciHandoff.stage = 'baseline'; },
    configuration => { configuration.futureUnknownField = true; },
    configuration => { delete configuration.cache; },
  ]) {
    const args = binding(); mutate(args.inputs[0].configuration);
    assert.throws(() => checkAdapterAuditBinding(args), /only auditReceipts may differ/);
  }
  const missingGroup = binding(); missingGroup.inputs = []; assert.throws(() => checkAdapterAuditBinding(missingGroup));
  const wrongWorkload = binding(); wrongWorkload.inputs[0].cell.workload = 'WI'; assert.throws(() => checkAdapterAuditBinding(wrongWorkload));
});

test('absent predecessor descriptors produce inconclusive evidence without accessing a writer or scanning source', async () => {
  const context = { configuration: {}, fixtureIdentity: { sha256: hash('e') } };
  for (const key of ['repo', 'subjectRepo', 'writer', 'openWriter', 'output']) {
    Object.defineProperty(context, key, { get() { throw Error('Unexpected audit access: ' + key); } });
  }
  for (const jobId of ['AC3', 'AH3']) {
    const result = await performAdapterAudit(context, { jobId });
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.assertions[0].passed, null);
    assert.deepEqual(result.observations.expectedJobs, adapterAuditJobs(jobId));
    assert.equal(result.observations.unrelatedWriterOpened, false);
    assert.deepEqual(result.observations.verified, []); assert.deepEqual(result.evidence, []);
    assert(result.missing.some(message => message.includes('descriptors are absent')));
    assert.equal(result.phases[0].outcome, 'expected');
    assert.equal(result.phases[0].durationMs, result.phases[0].endMs - result.phases[0].startMs);
    assert(result.phases[0].durationMs >= 0);
  }
  const missingFixture = await performAdapterAudit({ configuration: { auditReceipts: [] } }, { jobId: 'AC3' });
  assert.equal(missingFixture.status, 'inconclusive');
  assert(missingFixture.missing.some(message => message.includes('fixture identity is unavailable')));
});

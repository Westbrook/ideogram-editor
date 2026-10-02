import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {extractBrowserMeasurements} from '../../tooling/qualification/campaigns/browser-measurements.mjs';
import {verifyOrdinaryTextResourceEvidence, verifyLifecycleTextResourceEvidence} from '../../tooling/qualification/campaigns/verification.mjs';
import {textResourceBinding, verifyTextResourceArtifact, TEXT_RESOURCE_OPERATIONS} from '../../tooling/qualification/campaigns/browser-text-resources.mjs';
import {TEXT_RESOURCE_OWNERSHIP_CONTRACT} from '../../tooling/qualification/campaigns/renderer-ownership.mjs';

// Synthetic replay specimens exercise the authority boundary. Their arithmetic
// is known independently; they are never renderer approvals or campaign data.
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const seal = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const clone = value => structuredClone(value);
const names = ['R35FontShapingCpuBytes', 'R35GlyphGpuBytes'];
const rules = names.map(name => ({name, unit: 'bytes', budgetId: 'R35'}));
const fixture = {seal: {sha256: hash('fixture'), bytes: 1}};
const executableIdentity = {sourceDigest: hash('source').slice(7), buildDigest: hash('build'), toolsDigest: hash('tools')};
const processIdentity = {pid: 2001, node: 'v26.10.0', startedAt: '2026-10-01T00:00:00.000Z'};
const output = '/retained/text-resource-group';
function envelope(binding) {
  const initial = {atMs: 1, ledgerSequence: 0, textSequence: 0, cpu: [100, 0, 0, 0, 0, 0, 0], poolTextBytes: 50, glyphGpuBytes: 0, sequence: 0};
  const row1 = {...clone(initial), atMs: 2, ledgerSequence: 1, cpu: [200, 0, 0, 0, 0, 0, 0], sequence: 1};
  const row2 = {...clone(row1), atMs: 3, textSequence: 1, poolTextBytes: 250, sequence: 2};
  const window = {kind: 'text-resource-window-1', schemaVersion: 1, scope: TEXT_RESOURCE_OWNERSHIP_CONTRACT.scope,
    ledgerInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', id: 'text-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ordinal: 1,
    clock: 'browser-performance', clockOriginMs: 2000, cpuKinds: [...TEXT_RESOURCE_OWNERSHIP_CONTRACT.cpuKinds],
    initial, final: {...clone(row2), atMs: 4}, rows: [row1, row2], peakCpu: {bytes: 450, sequence: 2},
    peakGlyphGpu: {bytes: 0, sequence: 0}, sealed: true, observationComplete: true, failures: [], dropped: 0, transitionCount: 2};
  const ack = boundary => {const p = boundary === 'begin' ? window.initial : window.final; return {kind: 'text-resource-window-ack-1', schemaVersion: 1,
    ledgerInstanceId: window.ledgerInstanceId, id: window.id, ordinal: window.ordinal, boundary, atMs: p.atMs,
    clockOriginMs: window.clockOriginMs, ledgerSequence: p.ledgerSequence, textSequence: p.textSequence, sealed: boundary === 'end'};};
  if (binding.operation === 'text.mixed-ready') {window.id = 'startup-' + window.ledgerInstanceId; window.clockOriginMs = 3000;}
  return {kind: 'text-resource-evidence-1', schemaVersion: 1, binding, begin: ack('begin'), end: ack('end'), window,
    realm: binding.operation === 'text.mixed-ready' ? {mode: 'new-realm-startup', prior: {ledgerInstanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clockOriginMs: 2000}, navigations: [40]} : {mode: 'explicit-window', prior: null, navigations: []},
    failed: false, rendererOwnershipProof: null, timing: {clock: 'runner-monotonic', originMs: 1000, startedMs: 20, endedMs: 70}};
}
async function packet({lifecycle = false, operation = 'text.font-set', highCpu = false} = {}) {
  const cell = {id: lifecycle ? 'H10/WXn' : 'H7/WXn-font-set', handler: 'browser', host: 'H', kind: lifecycle ? 'lifecycle' : 'operation',
    operation: lifecycle ? 'lifecycle.editor' : operation, workload: 'WXn', requiredMeasurements: clone(rules)};
  const attempt = {id: cell.id + '/cold/scored/1', cache: 'cold', ordinal: 1, prime: false, startMs: 10, endMs: 90, status: 'INCONCLUSIVE',
    result: {status: 'INCONCLUSIVE', measurements: []}};
  const owner = lifecycle ? JSON.stringify({browserPid: 2002, backendPid: 2003}) : processIdentity;
  const binding = textResourceBinding({cell, sample: attempt, serial: 1, ...(lifecycle ? {cycleOrdinal: 1} : {}),
    fixtureIdentity: fixture.seal.sha256, processIdentity: owner, executableIdentity, observerId: 'text-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
  const raw = envelope(binding), files = new Map();
  if (highCpu) {
    raw.window.rows[1].poolTextBytes = 128 * 1048576 + 1;
    raw.window.final.poolTextBytes = raw.window.rows[1].poolTextBytes;
    raw.window.peakCpu.bytes = 200 + raw.window.rows[1].poolTextBytes;
  }
  const put = (path, value) => {const bytes = seal(value); files.set(path, bytes); return {path, bytes: bytes.length, sha256: hash(bytes)};};
  const artifact = put(join(output, 'text-resources', binding.observerId + '.json'), raw);
  const journalEvents = [{event: 'text-resources-intent', observerId: binding.observerId, binding, startedMs: 20, monotonicMs: 21},
    {event: 'text-resources-begin', windowId: raw.begin.id, binding, begin: raw.begin, startedMs: 20, monotonicMs: operation === 'text.mixed-ready' ? 65 : 22},
    {event: 'text-resources-observed', windowId: raw.begin.id, binding, artifact, endedMs: 70, monotonicMs: 80}];
  const readRetained = async (path, {maximum} = {}) => {assert(path.startsWith(output + '/')); const bytes = files.get(path); assert(bytes, 'retained path'); assert(bytes.length <= maximum); return bytes;};
  const replay = await verifyTextResourceArtifact({artifact, binding, rendererOwnershipProof: null, readRetained, journalEvents});
  const {proof, ...observation} = replay; attempt.result.textResources = clone(observation);
  const args = {cell, attempt, serial: 1, fixture: clone(fixture), processIdentity: clone(processIdentity), executableIdentity: clone(executableIdentity),
    rendererOwnershipProof: null, readRetained, journalEvents};
  if (!lifecycle) return {args, raw, files, artifact, proof, put, observation};
  const counterRaw = {kind: 'lifecycle-counters-artifact-1', schemaVersion: 1, cellId: cell.id, cycleOrdinal: 1,
    fixtureIdentity: fixture.seal.sha256, processIdentity: owner, failed: false, startedMs: 15, endedMs: 85,
    clock: 'runner-monotonic', allocations: [{startMs: 25, endMs: 26, fontShapingCpuBytes: 150, glyphGpuBytes: 0}],
    evidence: {textResources: observation}, metrics: clone(observation.measurements)};
  if (highCpu) counterRaw.metrics.push({name: names[0], value: 150, unit: 'bytes', method: 'Endpoint reservation lower bound; synchronous text resource window unavailable', complete: false});
  let counter;
  const writeCounter = () => {
    const counterArtifact = put(join(output, 'lifecycle-counters/cycle-001.json'), counterRaw);
    const measurements = counterRaw.metrics.map(row => ({...row, evidence: {kind: 'lifecycle-measurement-evidence-1', cellId: cell.id,
      cycleOrdinal: 1, processIdentity: owner, fixtureIdentity: fixture.seal.sha256,
      coverage: row.complete ? 'complete-cycle-actions' : 'observed-partial-cycle-actions', artifact: counterArtifact}}));
    counter = {artifact: counterArtifact, measurements}; return counter;
  };
  const result = {status: 'INCONCLUSIVE', processIdentity: owner, fixtureIdentity: fixture.seal.sha256, cycles: [{ordinal: 1,
    processIdentity: owner, fixtureIdentity: fixture.seal.sha256, startMs: 10, endMs: 90,
    action: {status: 'INCONCLUSIVE', lifecycleCounterEvidence: writeCounter(), measurements: counter.measurements}}]};
  const lifecycleArgs = {cell, result, fixture: clone(fixture), executableIdentity: clone(executableIdentity), rendererOwnershipProof: null, readRetained, journalEvents};
  return {args: lifecycleArgs, raw, counterRaw, files, put, observation, writeCounter};
}

test('ordinary resource replay retains exact conservative arithmetic without authorizing an unreviewed renderer', async () => {
  const p = await packet();
  assert.deepEqual(p.observation.measurements.map(row => [row.value, row.complete]), [[450, false], [0, false]]);
  assert.deepEqual(await verifyOrdinaryTextResourceEvidence(p.args), {applicable: true, complete: false});
  const value = extractBrowserMeasurements({cell: p.args.cell, sample: p.args.attempt, textResourceProof: p.proof});
  assert.deepEqual(value.measurements, []); assert.equal(value.unavailable.length, 2);
});

test('serialized observation/complete flags cannot impersonate the runtime resource proof', async () => {
  const p = await packet();
  for (const proof of [clone(p.proof), p.observation, {...p.observation, complete: true}, {measurements: rules.map(rule => ({...rule, value: 0, complete: true}))}]) {
    assert.deepEqual(extractBrowserMeasurements({cell: p.args.cell, sample: p.args.attempt, textResourceProof: proof}).measurements, []);
  }
});

for (const [label, change] of [
  ['cell', p => p.args.cell.id += '-other'], ['operation', p => p.args.cell.operation = 'text.apply'],
  ['cache', p => p.args.attempt.cache = 'warm'], ['ordinal', p => p.args.attempt.ordinal = 2], ['prime', p => p.args.attempt.prime = true],
  ['serial', p => p.args.serial = 2], ['fixture', p => p.args.fixture.seal.sha256 = hash('other fixture')],
  ['process', p => p.args.processIdentity.pid++], ['source', p => p.args.executableIdentity.sourceDigest = hash('other source').slice(7)],
  ['build', p => p.args.executableIdentity.buildDigest = hash('other build')], ['tools', p => p.args.executableIdentity.toolsDigest = hash('other tools')],
]) test('ordinary resource replay rejects swapped ' + label + ' binding', async () => {
  const p = await packet(); change(p); await assert.rejects(verifyOrdinaryTextResourceEvidence(p.args), /binding/);
});

test('ordinary missing resource evidence cannot publish memory rows or a passing required boundary', async () => {
  const p = await packet(); delete p.args.attempt.result.textResources;
  assert.deepEqual(await verifyOrdinaryTextResourceEvidence(p.args), {applicable: true, complete: false});
  p.args.attempt.result.measurements = [{name: names[0], value: 0}];
  await assert.rejects(verifyOrdinaryTextResourceEvidence(p.args), /lack/);
  p.args.attempt.result.measurements = []; p.args.attempt.result.status = 'PASS';
  await assert.rejects(verifyOrdinaryTextResourceEvidence(p.args), /lack/);
});

test('ordinary replay rejects forged summary, publication and incomplete PASS independently', async () => {
  for (const change of [p => p.args.attempt.result.textResources.complete = true,
    p => p.args.attempt.result.textResources.measurements[0].value++,
    p => p.args.attempt.result.measurements.push({name: names[0], value: 0, unit: 'bytes', complete: true}),
    p => p.args.attempt.status = 'PASS']) {
    const p = await packet(); change(p); await assert.rejects(verifyOrdinaryTextResourceEvidence(p.args));
  }
});

test('raw artifacts must retain their exact hash and bounded length', async () => {
  const p = await packet(); p.files.set(p.artifact.path, Buffer.from('{}'));
  await assert.rejects(verifyOrdinaryTextResourceEvidence(p.args), /hash\/length/);
});

test('ordinary observer and journal closure must lie inside the runner action', async () => {
  for (const change of [p => p.args.attempt.startMs = 21, p => p.args.attempt.endMs = 69,
    p => p.args.journalEvents[0].monotonicMs = 19, p => p.args.journalEvents[2].monotonicMs = 91,
    p => p.args.journalEvents.pop(), p => p.args.journalEvents.push(clone(p.args.journalEvents[0]))]) {
    const p = await packet(); change(p); await assert.rejects(verifyOrdinaryTextResourceEvidence(p.args), /action|journal/);
  }
});

test('recovery has separate resource coverage without widening ordinary font authority', async () => {
  assert(TEXT_RESOURCE_OPERATIONS.includes('text.recovery'));
  const p = await packet({operation: 'text.recovery'});
  assert.equal((await verifyOrdinaryTextResourceEvidence(p.args)).complete, false);
  p.args.cell.requiredMeasurements.push({name: 'R35SilentFontSubstitutionCount', unit: 'violations', budgetId: 'R35'},
    {name: 'R35CurrentFontFaces', unit: 'count', budgetId: 'R35'});
  const value = extractBrowserMeasurements({cell: p.args.cell, sample: p.args.attempt, textResourceProof: p.proof});
  assert.deepEqual(value.measurements, []); assert.equal(value.unavailable.length, 4);
});

test('lifecycle replay checks both artifact layers and keeps unapproved memory rows diagnostic', async () => {
  const p = await packet({lifecycle: true});
  assert.deepEqual(await verifyLifecycleTextResourceEvidence(p.args), {applicable: true});
  assert(p.args.result.cycles[0].action.measurements.every(row => row.complete === false));
});

for (const [label, change] of [
  ['cycle', p => p.args.result.cycles[0].ordinal = 2], ['fixture', p => p.args.fixture.seal.sha256 = hash('other fixture')],
  ['cycle process', p => p.args.result.cycles[0].processIdentity = 'other process'], ['series process', p => p.args.result.processIdentity = 'other process'],
  ['source', p => p.args.executableIdentity.sourceDigest = hash('other source').slice(7)],
  ['action interval', p => p.args.result.cycles[0].endMs = 69],
]) test('lifecycle text resources reject swapped ' + label, async () => {
  const p = await packet({lifecycle: true}); change(p); await assert.rejects(verifyLifecycleTextResourceEvidence(p.args));
});

test('lifecycle raw metrics and published wrapped rows both must equal replay', async () => {
  const p = await packet({lifecycle: true}); p.counterRaw.metrics[0].value++;
  p.args.result.cycles[0].action.lifecycleCounterEvidence = p.writeCounter();
  await assert.rejects(verifyLifecycleTextResourceEvidence(p.args), /metrics differ/);
  const q = await packet({lifecycle: true}); q.args.result.cycles[0].action.measurements[0].value++;
  await assert.rejects(verifyLifecycleTextResourceEvidence(q.args), /publication differs/);
});

test('lifecycle failed-action evidence is replayed even without a returned action', async () => {
  const p = await packet({lifecycle: true}), cycle = p.args.result.cycles[0];
  cycle.failedActionEvidence = cycle.action.lifecycleCounterEvidence; cycle.action = null;
  assert.deepEqual(await verifyLifecycleTextResourceEvidence(p.args), {applicable: true});
  cycle.failedActionEvidence.measurements[0].complete = true;
  await assert.rejects(verifyLifecycleTextResourceEvidence(p.args), /publication differs/);
});

test('lifecycle absence and endpoint fallback cannot authorize complete resource rows', async () => {
  const p = await packet({lifecycle: true}), cycle = p.args.result.cycles[0];
  delete p.counterRaw.evidence.textResources;
  p.counterRaw.metrics = [
    {name: names[0], value: 150, unit: 'bytes', method: 'Endpoint reservation lower bound; synchronous text resource window unavailable', complete: false},
    {name: names[1], value: 0, unit: 'bytes', method: 'Endpoint glyph reservation lower bound; reviewed ownership window unavailable', complete: false},
  ];
  const counter = p.writeCounter(); cycle.action.lifecycleCounterEvidence = counter; cycle.action.measurements = counter.measurements;
  assert.deepEqual(await verifyLifecycleTextResourceEvidence(p.args), {applicable: true});
  cycle.action.measurements[0].complete = true;
  await assert.rejects(verifyLifecycleTextResourceEvidence(p.args), /publication differs/);
  const q = await packet({lifecycle: true}); delete q.args.result.cycles[0].action.lifecycleCounterEvidence;
  q.args.result.cycles[0].action.status = 'PASS';
  await assert.rejects(verifyLifecycleTextResourceEvidence(q.args), /lack/);
});


test('lifecycle endpoint lower bounds cannot forge failures by changing incomplete numbers', async () => {
  const p = await packet({lifecycle: true}); delete p.counterRaw.evidence.textResources;
  p.counterRaw.metrics = [{name: names[0], value: 900000000, unit: 'bytes', method: 'Endpoint reservation lower bound; synchronous text resource window unavailable', complete: false}];
  p.args.result.cycles[0].action.lifecycleCounterEvidence = p.writeCounter();
  await assert.rejects(verifyLifecycleTextResourceEvidence(p.args), /metrics differ/);
  const q = await packet({lifecycle: true}); delete q.args.result.cycles[0].action.lifecycleCounterEvidence;
  assert(q.args.result.cycles[0].action.measurements.every(row => row.complete === false));
  await assert.rejects(verifyLifecycleTextResourceEvidence(q.args), /lack/);
});

test('resource observer UUID must match its dedicated retained filename', async () => {
  const p = await packet(); p.args.attempt.result.textResources.artifact.path = join(output, 'text-resources/other.json');
  await assert.rejects(verifyOrdinaryTextResourceEvidence(p.args), /owned observer/);
});


test('mixed-ready keeps its distinct startup realm tied to the same attempt', async () => {
  const p = await packet({operation: 'text.mixed-ready'});
  assert.equal(p.raw.realm.mode, 'new-realm-startup');
  assert.notEqual(p.raw.begin.id, p.raw.binding.observerId);
  assert.deepEqual(await verifyOrdinaryTextResourceEvidence(p.args), {applicable: true, complete: false});
});

test('lifecycle fallback rejects missing, nonfinite or reversed parent action boundaries', async () => {
  for (const change of [cycle => delete cycle.startMs, cycle => cycle.endMs = NaN, cycle => cycle.startMs = 100, cycle => cycle.endMs = -1]) {
    const p = await packet({lifecycle: true}); delete p.counterRaw.evidence.textResources;
    p.args.result.cycles[0].action.lifecycleCounterEvidence = p.writeCounter();
    change(p.args.result.cycles[0]);
    await assert.rejects(verifyLifecycleTextResourceEvidence(p.args), /interval/);
  }
});


test('nested broad CPU upper bound preserves authentic endpoint fallback in collector order', async () => {
  const p = await packet({lifecycle: true, highCpu: true});
  assert(p.raw.window.peakCpu.bytes > 128 * 1048576);
  assert.deepEqual(p.observation.measurements.map(row => row.name), [names[1]]);
  assert(p.observation.missing.includes('conservative-shared-owner-upper-bound-exceeds-r35-ceiling-attribution-required'));
  assert.deepEqual(p.counterRaw.metrics.map(row => [row.name, row.value]), [[names[1], 0], [names[0], 150]]);
  assert.deepEqual(await verifyLifecycleTextResourceEvidence(p.args), {applicable: true});
  assert(p.args.result.cycles[0].action.measurements.every(row => row.complete === false));
});

test('nested upper-bound fallback rejects unverified endpoint amounts, ordering and passing claims', async () => {
  for (const change of [p => p.counterRaw.metrics[1].value++, p => p.counterRaw.metrics.reverse(),
    p => p.counterRaw.metrics[1].complete = true, p => p.counterRaw.metrics[1].method = 'invented upper-bound violation']) {
    const p = await packet({lifecycle: true, highCpu: true}); change(p);
    const counter = p.writeCounter(); p.args.result.cycles[0].action.lifecycleCounterEvidence = counter; p.args.result.cycles[0].action.measurements = counter.measurements;
    await assert.rejects(verifyLifecycleTextResourceEvidence(p.args), /metrics differ/);
  }
  const p = await packet({lifecycle: true, highCpu: true}); p.args.result.cycles[0].action.status = 'PASS';
  await assert.rejects(verifyLifecycleTextResourceEvidence(p.args), /reported passing/);
});

test('nested upper-bound fallback still needs a bounded exact endpoint interval', async () => {
  for (const change of [raw => delete raw.allocations, raw => raw.allocations[0].endMs = 86,
    raw => raw.startedMs = 5, raw => raw.clock = 'browser-performance']) {
    const p = await packet({lifecycle: true, highCpu: true}); change(p.counterRaw);
    const counter = p.writeCounter(); p.args.result.cycles[0].action.lifecycleCounterEvidence = counter; p.args.result.cycles[0].action.measurements = counter.measurements;
    await assert.rejects(verifyLifecycleTextResourceEvidence(p.args), /interval/);
  }
});

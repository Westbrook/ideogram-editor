import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {CompositionObservations} from '../../dist/local/src/observability/composition-observations.js';
import {AllocationLedger} from '../../dist/local/src/observability/allocations.js';
import {projectLifecycleComposition, verifyLifecycleCompositionEvidence, LIFECYCLE_COMPOSITION_NAMES} from '../../tooling/qualification/campaigns/browser-lifecycle-composition.mjs';

// Real production ledger mutations and CompositionObservations produce these
// retained journals. Numeric replay fixtures are not a memory qualification.
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const sizeNames = ['R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes', 'R38RawTruncationOrFalseCompletenessCount'];
const workspaceNames = ['R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes'];
function producer(t, {capacity = 64, rawReservation = 80} = {}) {
  let clock = 1;
  const observer = new CompositionObservations(capacity, () => ++clock, () => 1000 + clock);
  const ledger = new AllocationLedger(observer), leases = [];
  t.after(() => {for (const lease of leases) lease.release(); observer.dispose();});
  const reserve = (owner, cpuBytes, kind = 'prompt') => {const lease = ledger.reserve({owner, kind, cpuBytes}); leases.push(lease); return lease;};
  reserve('composition-initialized', 0).release();
  const snapshot = () => {const handle = observer.readSnapshot(); try {return clone(handle.value);} finally {handle.release();}};
  const before = snapshot();
  const prompt = reserve('composition-caption', 100), raw = reserve('composition-raw-page', rawReservation);
  // This real Composition control owner is absent from the prompt-only journal.
  const control = reserve('composition-response-model', 400, 'control');
  const caption = {text: 'é🖼'}, original = Buffer.from(JSON.stringify(caption));
  const source = {hash: hash(original), byteLength: String(original.length)};
  observer.parsed(original.length, {state: 'supported', issues: [], value: caption}, source);
  observer.page(source, 0, original.length);
  raw.release(); prompt.release(); control.release();
  const after = snapshot();
  return {observer, ledger, reserve, snapshot, before, after, caption, original,
    allocations: [
      {label: 'before-open', startMs: 20, endMs: 21, captionWorkspaceBytes: before.promptOwnedBytes, compositionObservations: before},
      {label: 'after-release', startMs: 70, endMs: 71, captionWorkspaceBytes: after.promptOwnedBytes, compositionObservations: after},
    ]};
}
function packet(t, {required = [...LIFECYCLE_COMPOSITION_NAMES], failed = false} = {}) {
  const p = producer(t), fixtureIdentity = hash('fixture'), processIdentity = JSON.stringify({browserPid: 41, backendPid: 42});
  const cell = {id: 'H10/WXn', handler: 'browser', host: 'H', kind: 'lifecycle', operation: 'lifecycle.editor',
    requiredMeasurements: required.map(name => ({name, budgetId: 'R38', unit: name.endsWith('Count') ? 'violations' : 'bytes'}))};
  if (failed) p.allocations.at(-1).label = 'failed-cycle';
  const projected = projectLifecycleComposition({allocations: p.allocations, required, failed});
  const raw = {kind: 'lifecycle-counters-artifact-1', schemaVersion: 1, cellId: cell.id, cycleOrdinal: 1,
    fixtureIdentity, processIdentity, failed, startedMs: 15, endedMs: 75, clock: 'runner-monotonic',
    allocations: p.allocations, evidence: {composition: projected.evidence}, metrics: projected.measurements};
  const cycle = {ordinal: 1, fixtureIdentity, processIdentity, startMs: 10, endMs: 90,
    action: {status: 'INCONCLUSIVE', measurements: []}};
  const result = {status: 'INCONCLUSIVE', fixtureIdentity, processIdentity, cycles: [cycle]}, files = new Map(), journalEvents = [];
  const args = {cell, result, fixture: {seal: {sha256: fixtureIdentity}}, journalEvents,
    readRetained: async (path, {maximum}) => {const bytes = files.get(path); assert(bytes); assert(bytes.length <= maximum); return bytes;}};
  const reseal = () => {
    const bytes = Buffer.from(JSON.stringify(raw)), path = '/retained/group/lifecycle-counters/cycle-001.json'; files.set(path, bytes);
    const artifact = {path, bytes: bytes.length, sha256: hash(bytes)};
    const measurements = raw.metrics.map(row => ({...clone(row), evidence: {kind: 'lifecycle-measurement-evidence-1', cellId: cell.id,
      cycleOrdinal: 1, fixtureIdentity, processIdentity, coverage: row.complete ? 'complete-cycle-actions' : 'observed-partial-cycle-actions', artifact}}));
    const counter = {artifact, measurements};
    if (cycle.action) {cycle.action.lifecycleCounterEvidence = counter; cycle.action.measurements = clone(measurements);} else cycle.failedActionEvidence = counter;
    journalEvents.splice(0, journalEvents.length, {event: 'lifecycle-composition-observed', cellId: cell.id, cycleOrdinal: 1,
      fixtureIdentity, processIdentity, startedMs: raw.startedMs, endedMs: raw.endedMs, artifact, monotonicMs: 80});
    return counter;
  };
  reseal(); return {...p, args, raw, cycle, files, reseal};
}

test('actual ledger journal preserves exact byte rows and withholds incomplete resident workspace claims', t => {
  const p = producer(t), result = projectLifecycleComposition({allocations: p.allocations, required: [...LIFECYCLE_COMPOSITION_NAMES]});
  assert.deepEqual(result.measurements.map(row => row.name), sizeNames);
  assert.deepEqual(result.measurements.map(row => row.value), [Buffer.byteLength(JSON.stringify(p.caption)), 2, p.original.length, 0]);
  assert(result.measurements.every(row => row.complete));
  const logical = result.evidence.logicalReservations;
  assert.deepEqual(logical.map(row => [row.name, row.value]), [[workspaceNames[0], 80], [workspaceNames[1], 180]]);
  assert(logical.every(row => row.complete === false && row.ceilingAssessment === 'unavailable'));
  assert(result.evidence.missing.some(reason => reason.startsWith(workspaceNames[1])));
  assert.equal(result.evidence.physicalMemoryComplete, false); assert.equal(result.evidence.originalRawHashVerification, false);
});

test('an actual conservative raw allowance above 16 MiB cannot manufacture a scored R38 breach', t => {
  const p = producer(t, {rawReservation: 20 * 1048576}), result = projectLifecycleComposition({allocations: p.allocations, required: [...LIFECYCLE_COMPOSITION_NAMES]});
  assert(result.evidence.logicalReservations.find(row => row.name === workspaceNames[0]).value > 16 * 1048576);
  assert(!result.measurements.some(row => workspaceNames.includes(row.name)));
  assert(result.measurements.find(row => row.name === 'R38RawPageBytes').value < 32768);
});

test('missing endpoint, overflow and failed action retain only incomplete byte observations', t => {
  for (const mutation of [p => {p.allocations[0].label = 'middle';}, p => {delete p.allocations[0].compositionObservations;}]) {
    const p = producer(t); mutation(p);
    const result = projectLifecycleComposition({allocations: p.allocations, required: [...LIFECYCLE_COMPOSITION_NAMES]});
    assert(!result.measurements.some(row => row.complete));
  }
  const overflow = producer(t, {capacity: 2});
  assert(!projectLifecycleComposition({allocations: overflow.allocations, required: sizeNames}).measurements.some(row => row.complete));
  const p = producer(t);
  assert(!projectLifecycleComposition({allocations: p.allocations, required: sizeNames, failed: true}).measurements.some(row => row.complete));
  const empty = projectLifecycleComposition({allocations: [], required: ['R21CommandUtf8Bytes']});
  assert.deepEqual(empty.measurements, []); assert.deepEqual(empty.evidence.missing, []);
});

test('endpoint workspace fallback remains a separate incomplete unscored diagnostic', () => {
  const result = projectLifecycleComposition({allocations: [{label: 'before-open', captionWorkspaceBytes: 90}, {label: 'after-release', captionWorkspaceBytes: 12}], required: workspaceNames});
  assert.deepEqual(result.measurements, []);
  assert.equal(result.evidence.logicalReservations[0].value, 90); assert.equal(result.evidence.logicalReservations[0].complete, false);
});

test('sealed lifecycle replay accepts exact byte coverage while keeping full R38 incomplete', async t => {
  const p = packet(t); assert.deepEqual(await verifyLifecycleCompositionEvidence(p.args), {applicable: true, complete: false});
  assert(!p.cycle.action.measurements.some(row => workspaceNames.includes(row.name)));
  const q = packet(t, {required: sizeNames}); q.cycle.action.status = 'PASS'; q.args.result.status = 'PASS';
  assert.deepEqual(await verifyLifecycleCompositionEvidence(q.args), {applicable: true, complete: true});
});

for (const [name, mutate] of [
  ['raw metric value', p => {p.raw.metrics[0].value++;}],
  ['workspace promotion', p => {p.raw.metrics.push({name: workspaceNames[1], value: 180, unit: 'bytes', method: 'forged complete workspace', complete: true});}],
  ['workspace scope promotion', p => {p.raw.evidence.composition.logicalReservations[0].complete = true;}],
  ['producer summary', p => {p.raw.evidence.composition.producer.recordCount++;}],
  ['changed realm', p => {p.raw.allocations[1].compositionObservations.instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';}],
  ['missing record', p => {p.raw.allocations[1].compositionObservations.records.pop();}],
  ['forged zero violations', p => {const row = p.raw.allocations[1].compositionObservations.records.find(row => row.kind === 'raw-page'); row.receivedBytes--; row.violations = 0;}],
  ['nonownership reservation change', p => {p.raw.allocations[1].compositionObservations.records.find(row => row.kind === 'raw-page').promptOwnedBytes++;}],
]) test('replay rejects resealed ' + name, async t => {
  const p = packet(t); mutate(p); p.reseal(); await assert.rejects(verifyLifecycleCompositionEvidence(p.args));
});

for (const [name, mutate] of [
  ['counter publication', p => {p.cycle.action.lifecycleCounterEvidence.measurements[0].value++;}],
  ['action publication', p => {p.cycle.action.measurements[0].value++;}],
  ['duplicated row', p => {p.cycle.action.measurements.push(clone(p.cycle.action.measurements[0]));}],
  ['omitted row', p => {p.cycle.action.measurements.shift();}],
  ['coverage flag', p => {p.cycle.action.measurements[0].evidence.coverage = 'observed-partial-cycle-actions';}],
  ['cycle', p => {p.cycle.ordinal++;}],
  ['fixture', p => {p.args.fixture.seal.sha256 = hash('other');}],
  ['process', p => {p.args.result.processIdentity = 'other';}],
  ['duplicated cycle', p => {p.args.result.cycles.push(clone(p.cycle));}],
  ['missing journal', p => {p.args.journalEvents.length = 0;}],
  ['duplicated journal', p => {p.args.journalEvents.push(clone(p.args.journalEvents[0]));}],
  ['retargeted journal', p => {p.args.journalEvents[0].fixtureIdentity = hash('other');}],
  ['early journal', p => {p.args.journalEvents[0].monotonicMs = 74;}],
  ['late journal', p => {p.args.journalEvents[0].monotonicMs = 91;}],
  ['artifact bytes', p => {p.files.set(p.cycle.action.lifecycleCounterEvidence.artifact.path, Buffer.from('{}'));}],
  ['artifact length', p => {p.cycle.action.lifecycleCounterEvidence.artifact.bytes++;}],
  ['artifact hash', p => {p.cycle.action.lifecycleCounterEvidence.artifact.sha256 = hash('other');}],
  ['artifact role', p => {p.cycle.action.lifecycleCounterEvidence.artifact.path = '/retained/group/other.json';}],
]) test('replay rejects substituted ' + name, async t => {
  const p = packet(t); mutate(p); await assert.rejects(verifyLifecycleCompositionEvidence(p.args));
});

for (const [name, mutate] of [
  ['counter before action', p => {p.raw.startedMs = 9;}],
  ['counter after action', p => {p.raw.endedMs = 91;}],
  ['reversed counter', p => {p.raw.startedMs = 76;}],
  ['observation before counter', p => {p.raw.allocations[0].startMs = 14;}],
  ['observation after counter', p => {p.raw.allocations[1].endMs = 76;}],
  ['overlapping observations', p => {p.raw.allocations[1].startMs = 20;}],
]) test('replay rejects ' + name, async t => {
  const p = packet(t); mutate(p); p.reseal(); await assert.rejects(verifyLifecycleCompositionEvidence(p.args), /interval/);
});

test('failed-action evidence is replayed and cannot be promoted to PASS', async t => {
  const p = packet(t, {failed: true}); p.cycle.action = null; p.reseal();
  assert.deepEqual(await verifyLifecycleCompositionEvidence(p.args), {applicable: true, complete: false});
  p.cycle.failedActionEvidence.measurements[0].complete = true;
  await assert.rejects(verifyLifecycleCompositionEvidence(p.args), /publication/);
  const q = packet(t, {failed: true}); q.cycle.action.status = 'PASS';
  await assert.rejects(verifyLifecycleCompositionEvidence(q.args), /reported passing/);
  const r = packet(t, {required: sizeNames}); r.cycle.action = null; r.reseal(); r.args.result.status = 'PASS';
  await assert.rejects(verifyLifecycleCompositionEvidence(r.args), /reported passing/);
});

test('omitted artifact or empty inventory cannot authorize passing R38 measurements', async t => {
  const p = packet(t); delete p.cycle.action.lifecycleCounterEvidence;
  await assert.rejects(verifyLifecycleCompositionEvidence(p.args), /lack/);
  p.cycle.action.measurements = [];
  assert.deepEqual(await verifyLifecycleCompositionEvidence(p.args), {applicable: true, complete: false});
  p.cycle.action.status = 'PASS'; await assert.rejects(verifyLifecycleCompositionEvidence(p.args), /lack/);
  const q = packet(t); q.args.result.cycles = []; q.args.result.status = 'PASS';
  await assert.rejects(verifyLifecycleCompositionEvidence(q.args), /inventory/);
});

test('an interrupted unpublished attempt or absent inventory remains incomplete without reading invented evidence', async t => {
  const p = packet(t); let reads = 0;
  p.args.readRetained = async () => {reads++; throw Error('No evidence was published');};
  p.args.attemptStatus = 'FAIL';
  for (const result of [null, undefined, {status: 'FAIL', missing: ['interrupted before publication']},
    {status: 'INCONCLUSIVE', cycles: null}, {status: 'FAIL', cycles: undefined, measurements: []}]) {
    p.args.result = result;
    assert.deepEqual(await verifyLifecycleCompositionEvidence(p.args), {applicable: true, complete: false});
  }
  assert.equal(reads, 0);
  p.args.result = null; p.args.attemptStatus = 'PASS';
  await assert.rejects(verifyLifecycleCompositionEvidence(p.args), /PASS/);
  p.args.attemptStatus = 'FAIL'; p.args.result = {status: 'PASS'};
  await assert.rejects(verifyLifecycleCompositionEvidence(p.args), /PASS/);
});

test('absence cannot hide a forged top-level publication or malformed supplied inventory', async t => {
  const p = packet(t);
  for (const result of [
    {status: 'FAIL', measurements: [{name: 'R38RawPageBytes', value: 0, complete: true}]},
    {status: 'INCONCLUSIVE', cycles: [], measurements: [{name: 'R38RawPageBytes', value: 0, complete: true}]},
    {status: 'FAIL', measurements: {name: 'R38RawPageBytes', value: 0}},
    {status: 'FAIL', lifecycleCounterEvidence: {artifact: {path: '/unbound'}}},
    {status: 'FAIL', failedActionEvidence: {measurements: [{name: 'R38RawPageBytes'}]}},
    ...[{}, 'missing', 0, false].map(cycles => ({status: 'FAIL', cycles})),
  ]) {
    p.args.result = result; await assert.rejects(verifyLifecycleCompositionEvidence(p.args), /publication|inventory/);
  }
  const q = packet(t); q.args.attemptStatus = 'PASS';
  await assert.rejects(verifyLifecycleCompositionEvidence(q.args), /reported passing/);
});

test('collector and campaign verifier use the shared projection and replay at the lifecycle boundary', async () => {
  const collector = await readFile(new URL('../../tooling/qualification/campaigns/browser-lifecycle-counters.mjs', import.meta.url), 'utf8');
  const verification = await readFile(new URL('../../tooling/qualification/campaigns/verification.mjs', import.meta.url), 'utf8');
  assert.match(collector, /projectLifecycleComposition\(\{allocations: owner\.allocations/);
  assert.match(collector, /event: 'lifecycle-composition-observed'/);
  assert.doesNotMatch(collector, /add\('R38TextCaptionWorkspaceBytes'/);
  assert.match(verification, /await verifyLifecycleCompositionEvidence\(\{cell: group\.cell, result: actual\.result/);
  assert.match(verification, /verifyLifecycleCompositionEvidence\(\{cell: group\.cell, result: actual\.result, attemptStatus: actual\.status/);
});

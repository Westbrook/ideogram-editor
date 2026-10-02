import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CompositionObservations} from '../../dist/local/src/observability/composition-observations.js';
import {TextResourceObservations, TEXT_RESOURCE_ROW_LIMIT} from '../../dist/local/src/observability/allocations.js';
import {inspectOrdinaryCompositionRaw, ordinaryCompositionMeasurement, verifyOrdinaryCompositionEvidence,
  ORDINARY_COMPOSITION_NAMES} from '../../tooling/qualification/campaigns/browser-ordinary-composition.mjs';

// Synthetic protocol controls use the actual producer class. They are not a
// browser capture, timing result, raw-byte integrity proof or qualification.
const source = {hash: 'sha256:' + 'a'.repeat(64), byteLength: '100'};
function fixture(t, {operation = 'fast.workflow', required = [...ORDINARY_COMPOSITION_NAMES], capacity = 64} = {}) {
  let at = 1;
  const producer = new CompositionObservations(capacity, () => at++, () => 10000);
  t.after(() => producer.dispose());
  const snapshot = (timeOrigin = 1000) => {
    const owner = producer.readSnapshot();
    try {return {timeOrigin, observedMs: at++, documentKind: 'other', composition: structuredClone(owner.value)};} finally {owner.release();}
  };
  const binding = {kind: 'ordinary-composition-binding-1', nonce: 'a'.repeat(32), operation, required,
    attempt: {cellId: 'H9/' + operation, id: 'sample-1', cache: 'cold', ordinal: 1, prime: false, serial: 1}};
  const raw = {kind: 'ordinary-composition-raw-1', nonce: binding.nonce, binding: binding.attempt,
    clock: 'runner-monotonic', startedMs: 0, endedMs: 100, actionStartedMs: 15, actionEndedMs: 19, actionCompleted: true, failed: false, missing: [], snapshots: [], navigations: [], resources: []};
  const capture = value => {const index = raw.snapshots.length; raw.snapshots.push({startedMs: 10 + index * 10, endedMs: 11 + index * 10, value: value ?? snapshot()}); if (index) raw.actionEndedMs = 9 + index * 10; return index;};
  const work = () => {
    producer.ownership('composition-raw-copy', 0, 100, 100);
    producer.parsed(100, {state: 'supported', issues: [], value: {caption: 'original'}}, source);
    producer.page(source, 0, 100);
    producer.ownership('composition-raw-copy', 100, 0, 0);
  };
  return {producer, binding, raw, snapshot, capture, work};
}
const names = result => result.measurements.map(row => row.name);

test('same-realm actual producer journal supplies observed sizes and preserves workspace scope gaps', t => {
  const f = fixture(t); f.capture(); f.work(); f.capture();
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.deepEqual(names(result), ['R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes', 'R38RawTruncationOrFalseCompletenessCount']);
  assert.equal(result.measurements.find(row => row.name === 'R38RawPageBytes').value, 100);
  assert.equal(result.measurements.find(row => row.name.endsWith('Count')).value, 0);
  assert.equal(result.logicalReservations.length, 2);
  assert(result.logicalReservations.every(row => row.complete === false));
  assert(result.missing.some(value => value.includes('resident Composition')));
  assert.equal(result.qualification, false); assert.equal(result.physicalMemoryComplete, false);
});

test('no executed operation supplies no invented zero rows', t => {
  const f = fixture(t); f.capture(); f.capture();
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.deepEqual(result.measurements, []); assert.deepEqual(result.logicalReservations, []);
  assert.equal(result.missing.filter(value => ORDINARY_COMPOSITION_NAMES.some(name => value.startsWith(name))).length, ORDINARY_COMPOSITION_NAMES.length);
});

test('portable navigation replays the actual new producer birth instead of the old realm baseline', t => {
  const f = fixture(t, {operation: 'portable.reopen'});
  const empty = {timeOrigin: 500, observedMs: 1, documentKind: 'owned-blank-candidate', composition: null};
  f.capture(empty); f.capture({...empty, observedMs: 2});
  f.work(); f.capture(); f.capture();
  f.raw.navigations.push({before: 1, after: 2, startedMs: 22, endedMs: 29, completed: true});
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.equal(result.intervals.length, 1); assert.equal(result.intervals[0].start, 'birth');
  assert.equal(result.intervals[0].evidence.fromCursor, 0);
  assert(names(result).includes('R38RawPageBytes'));
});

for (const kind of ['unrecorded-realm', 'same-realm-navigation', 'reused-instance', 'incomplete-navigation', 'backwards-boundary', 'outside-operation', 'false-birth']) {
  test('ordinary replay rejects ' + kind + ' coverage', t => {
    const f = fixture(t, {operation: 'portable.reopen'}), empty = {timeOrigin: 500, observedMs: 1, documentKind: 'owned-blank-candidate', composition: null};
    f.capture(empty); f.capture({...empty, observedMs: 2}); f.work(); f.capture(); f.capture();
    f.raw.navigations.push({before: 1, after: 2, startedMs: 22, endedMs: 29, completed: true});
    if (kind === 'unrecorded-realm') f.raw.navigations.length = 0;
    if (kind === 'same-realm-navigation') for (const row of f.raw.snapshots.slice(2)) row.value.timeOrigin = 500;
    if (kind === 'reused-instance') {f.raw.snapshots[0].value = f.snapshot(500); f.raw.snapshots[1].value = f.snapshot(500);}
    if (kind === 'incomplete-navigation') f.raw.navigations[0].completed = false;
    if (kind === 'backwards-boundary') f.raw.navigations[0].endedMs = 21;
    if (kind === 'outside-operation') f.raw.snapshots.at(-1).endedMs = 101;
    if (kind === 'false-birth') for (const row of f.raw.snapshots.slice(2)) row.value.composition.birth.promptOwnedBytes = 1;
    const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
    assert.deepEqual(result.measurements, []); assert(result.missing.length > 0);
  });
}

test('recorded page extent contradiction survives as a failure and nonzero row', t => {
  const f = fixture(t, {required: ['R38RawTruncationOrFalseCompletenessCount']});
  f.capture(); f.producer.page(source, 0, 99); f.capture();
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.equal(result.measurements[0].value, 1); assert.equal(result.failures.length, 1);
});

test('forged zero violation, incomplete source range and failed original action cannot pass', t => {
  for (const change of [
    f => {for (const row of f.raw.snapshots.at(-1).value.composition.records) if (row.kind === 'raw-page') {row.receivedBytes = 99; row.violations = 0;}},
    f => {f.raw.snapshots.at(-1).value.composition.records.pop();},
    f => {f.raw.failed = true;},
    f => {f.raw.actionCompleted = false;},
  ]) {
    const f = fixture(t); f.capture(); f.work(); f.capture(); change(f);
    const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
    assert.deepEqual(result.measurements, []); assert(result.missing.length > 0);
  }
});

test('copied flags cannot mint ordinary measurement authority', t => {
  const f = fixture(t); f.capture(); f.work(); f.capture();
  const analysis = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  const response = ordinaryCompositionMeasurement({cell: {id: f.binding.attempt.cellId, operation: 'fast.workflow'}, sample: {cache: 'cold', ordinal: 1},
    rule: {name: 'R38RawPageBytes', budgetId: 'R38', unit: 'bytes'}, proof: {binding: f.binding, analysis, measurements: analysis.measurements}});
  assert.equal(response.measurement, undefined); assert.match(response.reason, /proof is unavailable/);
});

test('retained verification rejects unbacked advertised measurements and mismatched artifact seals', async () => {
  const cell = {operation: 'fast.workflow'};
  await assert.rejects(verifyOrdinaryCompositionEvidence({cell, attempt: {result: {measurements: [{name: 'R38RawPageBytes', value: 0}]}}}), /lack replay evidence/);
  const observation = {kind: 'ordinary-composition-observation-1', nonce: 'a'.repeat(32), qualification: false, physicalMemoryComplete: false,
    binding: {path: 'ordinary-composition-' + 'a'.repeat(32) + '-binding.json', bytes: 1, sha256: 'sha256:' + 'b'.repeat(64)}};
  let read = false;
  await assert.rejects(verifyOrdinaryCompositionEvidence({cell, attempt: {result: {observations: {ordinaryComposition: observation}}}, retainedFiles: [],
    readRetained: async () => {read = true; return Buffer.from('{}');}}), /outer seal differs/);
  assert.equal(read, false);
});

async function replayFixture(t) {
  const {createHash} = await import('node:crypto');
  const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const f = fixture(t, {required: ['R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes', 'R38RawTruncationOrFalseCompletenessCount']});
  f.capture(); f.work(); f.capture();
  const root = '/fixture/source', groupOutput = '/fixture/group', browserCache = '/fixture/browsers';
  const environment = Object.fromEntries(['sourceDigest', 'buildDigest', 'toolsDigest', 'controlDigest'].map(key => [key, (['sourceDigest', 'controlDigest'].includes(key) ? '' : 'sha256:') + 'b'.repeat(64)]));
  const workerProcessIdentity = {pid: 200, node: 'v26.10.0', startedAt: '2026-10-01T00:00:00Z'};
  const fixtureValue = {seal: {sha256: 'sha256:' + 'c'.repeat(64)}, documentId: 'document_1'};
  const files = new Map(), retainedFiles = [], put = (path, value) => {
    const bytes = Buffer.from(JSON.stringify(value)), pin = {path, bytes: bytes.length, sha256: digest(bytes)};
    files.set(path, bytes); retainedFiles.push(pin); return pin;
  };
  const processes = [['browser', 201], ['backend', 202]].map(([kind, pid]) => {
    const path = 'owned-process-' + pid + '-12345678-1234-4567-8901-123456789abc.json';
    const value = {kind, pid, pgid: pid, startedAtIdentity: 'birth-' + pid, executable: kind === 'browser' ? browserCache + '/chromium/chrome' : root + '/node'};
    put(path, {kind: 'perf-owned-processes-1', ownerPid: 200, processes: [value]}); return {...value, registration: {path: groupOutput + '/' + path}};
  });
  const runtime = {engine: 'chromium', revision: '1234', version: '1.2.3', browserPid: 201, backendPid: 202,
    executable: processes[0].executable, executableIdentity: {sha256: 'sha256:' + 'd'.repeat(64), bytes: 100},
    playwrightModule: root + '/node_modules/playwright/index.mjs', fixtureSeal: fixtureValue.seal,
    ownedLaunch: {context: {createdBy: 'browser.newContext'}, process: processes[0]}};
  put('browser-runtime.json', runtime);
  Object.assign(f.binding, {environment, processIdentity: workerProcessIdentity, fixtureSeal: fixtureValue.seal, documentId: fixtureValue.documentId, runtime});
  const analysis = inspectOrdinaryCompositionRaw(f.raw, f.binding), prefix = 'ordinary-composition-' + f.binding.nonce;
  const bindingPin = put(prefix + '-binding.json', f.binding), rawPin = put(prefix + '-raw.json', f.raw);
  const observation = {kind: 'ordinary-composition-observation-1', nonce: f.binding.nonce, binding: bindingPin, raw: rawPin,
    analysis, qualification: false, physicalMemoryComplete: false};
  const measurements = analysis.measurements.map(row => ({...row, evidence: [{kind: 'ordinary-composition-retained-observation-1', artifact: {...rawPin, path: groupOutput + '/' + rawPin.path}}]}));
  const cell = {id: f.binding.attempt.cellId, operation: f.binding.operation,
    requiredMeasurements: f.binding.required.map(name => ({name, budgetId: 'R38', unit: name.endsWith('Count') ? 'violations' : 'bytes'}))};
  const state = {productRepo: root, sourceDigest: environment.sourceDigest, playwrightBrowsersPath: browserCache,
    h: {source: root, completed: true, failure: null, active: false, browserIdentity: {engines: [{engine: runtime.engine, executable: runtime.executable,
      version: runtime.version, revision: runtime.revision, bytes: runtime.executableIdentity.bytes, sha256: runtime.executableIdentity.sha256}]}}};
  const developerState = {kind: 'developer-runtime-state-1', state, sha256: digest(JSON.stringify(state, null, 2) + '\n')};
  const controlNames = ['browser.mjs', 'browser-driver.mjs', 'browser-queue.mjs', 'browser-phase-snapshot.mjs', 'browser-ordinary-composition.mjs',
    'browser-composition-counters.mjs', 'browser-text-resources.mjs', 'browser-measurements.mjs', 'worker.mjs', 'run.mjs', 'verification.mjs'];
  const sourceNames = ['src/observability/composition-observations.ts', 'src/observability/allocations.ts', 'src/observability/browser.ts',
    'src/observability/diagnostic-memory.ts', 'src/composition/memory.ts', 'src/composition/core.ts', 'src/ui/composition.ts', 'src/ui/request-edits.ts'];
  // Read the actual application inputs. An invented source row or an obsolete
  // compiled output must not make this source-closure fixture pass.
  const sourceFiles = await Promise.all(sourceNames.map(async path => ({path,
    sha256: digest(await readFile(new URL('../../' + path, import.meta.url))).slice(7)})));
  const args = {attempt: {id: f.binding.attempt.id, cache: 'cold', ordinal: 1, prime: false, startMs: 0, endMs: 110,
    status: 'INCONCLUSIVE', result: {status: 'INCONCLUSIVE', observations: {ordinaryComposition: observation}, measurements}},
    cell, serial: 1, fixture: fixtureValue, environment, workerProcessIdentity, groupOutput, retainedFiles,
    readRetained: async path => {assert(files.has(path), 'retained member exists'); return files.get(path);},
    controlFiles: controlNames.map(name => ({path: 'tooling/qualification/campaigns/' + name, sha256: environment.controlDigest})),
    sourceFiles, sourceRoot: root, browserCache,
    tools: {browserPins: {browsers: [{name: runtime.engine, revision: runtime.revision, browserVersion: runtime.version}]}},
    developerState, developerStateIdentity: {sha256: 'sha256:' + 'e'.repeat(64)},
    journalEvents: [{event: 'ordinary-composition-observed', nonce: f.binding.nonce, cellId: cell.id, monotonicMs: 105, binding: bindingPin, raw: rawPin}]};
  return {args, files, f};
}

test('exact retained byte, process, executable and attempt replay alone can issue a narrow row token', async t => {
  const {args} = await replayFixture(t), proof = await verifyOrdinaryCompositionEvidence(args);
  const request = {cell: args.cell, sample: args.attempt, rule: args.cell.requiredMeasurements.find(row => row.name === 'R38RawPageBytes'), proof};
  assert.equal(ordinaryCompositionMeasurement(request).measurement.value, 100);
  assert.equal(ordinaryCompositionMeasurement({...request, proof: {...proof}}).measurement, undefined);
  assert.equal(ordinaryCompositionMeasurement({...request, sample: {...args.attempt, ordinal: 2}}).measurement, undefined);
  assert.equal(ordinaryCompositionMeasurement({...request, rule: {...request.rule, unit: 'ms'}}).measurement, undefined);
});

test('the removed text-resource source cannot replace the current allocation producer binding', async t => {
  const {args} = await replayFixture(t);
  const current = args.sourceFiles.find(row => row.path === 'src/observability/allocations.ts');
  assert(current, 'The replay fixture binds the actual allocation producer');
  assert(!args.sourceFiles.some(row => row.path === 'src/observability/text-resource-observations.ts'));
  args.sourceFiles = args.sourceFiles.filter(row => row !== current);
  args.sourceFiles.push({...current, path: 'src/observability/text-resource-observations.ts'});
  await assert.rejects(verifyOrdinaryCompositionEvidence(args), /application source closure missing: src\/observability\/allocations\.ts/);
});

for (const mismatch of ['bytes', 'source', 'process', 'fixture', 'browser', 'scheduled-attempt', 'journal', 'metric', 'raw-flags']) {
  test('retained ordinary replay rejects changed ' + mismatch, async t => {
    const {args, files} = await replayFixture(t);
    if (mismatch === 'bytes') files.set(args.attempt.result.observations.ordinaryComposition.raw.path, Buffer.from('{}'));
    if (mismatch === 'source') args.sourceFiles.pop();
    if (mismatch === 'process') args.workerProcessIdentity = {...args.workerProcessIdentity, pid: 999};
    if (mismatch === 'fixture') args.fixture = {...args.fixture, documentId: 'other'};
    if (mismatch === 'browser') args.tools.browserPins.browsers[0].revision = 'other';
    if (mismatch === 'scheduled-attempt') args.attempt.ordinal = 2;
    if (mismatch === 'journal') args.journalEvents[0].monotonicMs = 111;
    if (mismatch === 'metric') args.attempt.result.measurements[0].value++;
    if (mismatch === 'raw-flags') args.attempt.result.observations.ordinaryComposition.physicalMemoryComplete = true;
    await assert.rejects(verifyOrdinaryCompositionEvidence(args));
  });
}

// These controls retain each actual producer's own lifetime. They do not
// pretend that a pre-navigation read captured the old realm's final work.
test('navigation from an instrumented application realm preserves its terminal coverage gap', t => {
  const prior = fixture(t), next = fixture(t);
  prior.capture(); prior.work(); prior.capture();
  next.work(); prior.capture(next.snapshot(2000)); prior.capture(next.snapshot(2000));
  prior.raw.navigations.push({before: 1, after: 2, startedMs: 22, endedMs: 29, completed: true});
  const result = inspectOrdinaryCompositionRaw(prior.raw, prior.binding);
  assert.equal(result.intervals.length, 2);
  assert(result.intervals.every(interval => interval.evidence.complete));
  assert.notEqual(result.intervals[0].instanceId, result.intervals[1].instanceId);
  assert(result.intervals.every(interval => interval.measurements.some(row => row.name === 'R38RawTruncationOrFalseCompletenessCount' && row.complete && row.value === 0)));
  assert.deepEqual(result.measurements, []);
  assert(result.missing.includes('Prior application realm terminal resource coverage is unavailable across navigation'));
});

test('a later retained-source realm cannot erase the preceding unbound inspection witness gap', t => {
  const required = ['R38RawTruncationOrFalseCompletenessCount'];
  const prior = fixture(t, {required}), next = fixture(t, {required});
  prior.capture();
  prior.producer.parsed(2, {state: 'supported', issues: [], value: {}});
  prior.capture(); next.work();
  prior.capture(next.snapshot(2000)); prior.capture(next.snapshot(2000));
  prior.raw.navigations.push({before: 1, after: 2, startedMs: 22, endedMs: 29, completed: true});
  const result = inspectOrdinaryCompositionRaw(prior.raw, prior.binding);
  assert.equal(result.intervals.length, 2);
  const [unbound, retained] = result.intervals;
  assert.equal(unbound.evidence.complete, true); assert.equal(unbound.evidence.rawInspections, 1);
  assert(!unbound.measurements.some(row => row.name === required[0]));
  assert(unbound.missing.some(value => value.startsWith(required[0])));
  assert.equal(retained.evidence.complete, true);
  assert(retained.measurements.some(row => row.name === required[0] && row.complete && row.value === 0));
  assert.deepEqual(result.measurements, []);
  assert(result.missing.some(value => value.startsWith(required[0])));
});

test('a missing observer in an arbitrary old document is not proof of an empty portable realm', t => {
  const f = fixture(t, {operation: 'portable.reopen'});
  const uninstrumented = {timeOrigin: 500, observedMs: 1, documentKind: 'other', composition: null};
  f.capture(uninstrumented); f.capture({...uninstrumented, observedMs: 2});
  f.work(); f.capture(); f.capture();
  f.raw.navigations.push({before: 1, after: 2, startedMs: 22, endedMs: 29, completed: true});
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.deepEqual(result.measurements, []);
  assert(result.missing.includes('Composition producer is missing inside the operation'));
});

// Synthetic ledger points feed the real bounded transition producer; it owns
// the resulting rows, acknowledgments and peak arithmetic. This does not claim
// actual browser allocations, a renderer review, or a physical-memory bound.
function reservationFixture(t, {overCeiling = false, incomplete = false, promptPeak = 0} = {}) {
  const f = fixture(t); f.capture();
  if (promptPeak) f.producer.ownership('composition-raw-copy', 0, promptPeak, promptPeak);
  f.producer.page(source, 0, 100);
  if (promptPeak) f.producer.ownership('composition-raw-copy', promptPeak, 0, 0);
  f.capture();
  const first = f.raw.snapshots[0], last = f.raw.snapshots[1], ledgerId = crypto.randomUUID();
  const producer = new TextResourceObservations(ledgerId, first.value.timeOrigin);
  const id = 'r38-' + f.raw.nonce + '-0'; let sequence = 0;
  const point = cpu => ({atMs: first.value.observedMs + 0.1 + sequence * 0.1, ledgerSequence: sequence,
    textSequence: 0, cpu, poolTextBytes: 2000, glyphGpuBytes: 0});
  // font and text-pool ownership is deliberately outside the five-kind sum.
  let current = point([1000, 0, 0, 0, 0, 0, 0]);
  const begin = producer.begin(id, current);
  const observe = cpu => {sequence++; current = point(cpu); producer.observe(current);};
  observe([1000, 0, 10, 0, 0, 0, 0]);
  observe([1000, 0, 10, 30, 0, 0, 0]);
  observe([1000, 0, 0, 30, 0, 0, 0]);
  observe([1000, 0, 0, 0, 0, 0, 0]);
  observe([1000, 0, 0, 0, overCeiling ? 64 * 1048576 + 1 : 90, 0, 0]);
  observe([1000, 0, 0, 0, 0, 0, 0]);
  if (incomplete) producer.fail('text-observer-fault');
  const end = producer.end(id, {...current, atMs: last.value.observedMs + 1});
  const resource = {mode: 'boundary', fromSnapshot: 0, toSnapshot: 1,
    startedMs: first.endedMs + 1, beginEndedMs: first.endedMs + 2,
    endStartedMs: last.endedMs + 0.1, endAcknowledgedMs: last.endedMs + 0.2, endedMs: last.endedMs + 0.3,
    begin: structuredClone(begin), end: structuredClone(end), window: structuredClone(producer.copy())};
  f.raw.resources.push(resource);
  return {...f, resource};
}

test('real central producer replay reports the simultaneous five-kind peak rather than adding disjoint peaks', t => {
  const f = reservationFixture(t), result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.equal(result.reservationObservations.length, 1);
  const row = result.reservationObservations[0];
  assert.equal(row.observedSupersetPeakBytes, 90);
  assert.notEqual(row.observedSupersetPeakBytes, 10 + 30 + 90);
  assert.equal(row.peakSequence, 5);
  assert.equal(f.resource.window.peakCpu.bytes, 3090, 'font/pool bytes remain visible in their original full producer scope');
  assert.equal(row.transitionCoverageComplete, true);
  assert.equal(row.bound, 'conservative-superset-upper-bound');
  assert.deepEqual(row.kinds, ['control', 'prompt', 'staging', 'scratch', 'copy']);
  assert.equal(row.r38CoverageComplete, false); assert.equal(row.physicalMemoryComplete, false);
  assert.equal(row.ceilingAssessment, 'unavailable');
});

test('a superset above the caption ceiling remains a diagnostic and cannot manufacture an R38 breach', t => {
  const f = reservationFixture(t, {overCeiling: true}), result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  const row = result.reservationObservations[0];
  assert.equal(row.observedSupersetPeakBytes, 64 * 1048576 + 1);
  assert.equal(row.ceilingAssessment, 'unavailable');
  assert.equal(row.r38CoverageComplete, false); assert.equal(row.physicalMemoryComplete, false);
  assert.deepEqual(result.failures, []);
  assert(!result.measurements.some(value => ['R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes'].includes(value.name)));
});

for (const mutation of ['begin-ack', 'end-ack', 'realm-clock', 'replayed-peak', 'end-before-snapshot', 'begin-after-last-snapshot', 'begin-after-action', 'begin-before-snapshot', 'end-before-snapshot-release', 'end-ack-before-call']) {
  test('ordinary central replay rejects ' + mutation, t => {
    const f = reservationFixture(t), {resource} = f;
    if (mutation === 'begin-ack') resource.begin.ledgerSequence++;
    if (mutation === 'end-ack') resource.end.ordinal++;
    if (mutation === 'realm-clock') {
      resource.window.clockOriginMs++; resource.begin.clockOriginMs++; resource.end.clockOriginMs++;
    }
    if (mutation === 'replayed-peak') resource.window.peakCpu.bytes++;
    if (mutation === 'begin-after-action') resource.beginEndedMs = f.raw.actionStartedMs + 0.1;
    if (mutation === 'begin-before-snapshot') resource.startedMs = f.raw.snapshots[0].endedMs - 0.1;
    if (mutation === 'end-before-snapshot-release') resource.endStartedMs = f.raw.snapshots[1].endedMs - 0.1;
    if (mutation === 'end-ack-before-call') resource.endAcknowledgedMs = resource.endStartedMs - 0.1;
    if (mutation === 'end-before-snapshot') {
      resource.window.final.atMs = f.raw.snapshots[1].value.observedMs - 1;
      resource.end.atMs = resource.window.final.atMs;
    }
    if (mutation === 'begin-after-last-snapshot') {
      const shift = f.raw.snapshots[1].value.observedMs + 10;
      for (const point of [resource.window.initial, ...resource.window.rows, resource.window.final]) point.atMs += shift;
      resource.begin.atMs = resource.window.initial.atMs; resource.end.atMs = resource.window.final.atMs;
    }
    const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
    assert.equal(result.reservationObservations.length, 0);
    assert(result.missing.includes('Composition central reservation replay is incomplete'));
  });
}

test('incomplete central transitions keep the actual observed value without complete coverage', t => {
  const f = reservationFixture(t, {incomplete: true}), result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.equal(result.reservationObservations.length, 1);
  const row = result.reservationObservations[0];
  assert.equal(row.observedSupersetPeakBytes, 90); assert.equal(row.transitionCoverageComplete, false);
  assert.equal(row.bound, 'retained-transition-lower-bound');
  assert(result.missing.includes('Composition central reservations retain only an incomplete operation transition range'));
  assert.equal(row.r38CoverageComplete, false); assert.equal(row.physicalMemoryComplete, false);
  assert.equal(row.ceilingAssessment, 'unavailable'); assert.deepEqual(result.failures, []);
});

test('duplicating a central resource window does not supply another realm or interval', t => {
  const f = reservationFixture(t); f.raw.resources.push(structuredClone(f.resource));
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.equal(result.reservationObservations.length, 1);
  assert(result.missing.includes('Composition central reservation replay is incomplete'));
});

test('central-resource capture failure preserves independent complete producer byte rows while leaving the attempt incomplete', t => {
  const f = fixture(t); f.capture(); f.work(); f.capture();
  f.raw.resourceMissing = ['Composition central reservation closure unavailable'];
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.deepEqual(names(result), ['R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes', 'R38RawTruncationOrFalseCompletenessCount']);
  assert(result.measurements.every(row => row.complete));
  assert(result.missing.includes(f.raw.resourceMissing[0]));
  assert.equal(result.qualification, false); assert.equal(result.physicalMemoryComplete, false);
  assert.deepEqual(result.reservationObservations, []);
});

test('a Composition snapshot gap still invalidates byte coverage regardless of separate resource diagnostics', t => {
  const f = reservationFixture(t); f.raw.missing.push('Composition diagnostic snapshot unavailable');
  f.raw.resourceMissing = [];
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.deepEqual(result.measurements, []);
  assert.equal(result.reservationObservations[0].transitionCoverageComplete, false);
  assert.equal(result.reservationObservations[0].bound, 'retained-transition-lower-bound');
});

test('individually valid producers cannot claim a central superset below an interior prompt reservation', t => {
  const f = reservationFixture(t, {promptPeak: 100});
  assert.equal(f.resource.window.observationComplete, true);
  assert.equal(f.resource.window.peakCpu.bytes, 3090, 'the real central producer peak is not tampered');
  const composition = f.raw.snapshots.at(-1).value.composition;
  assert(composition.records.some(row => row.promptOwnedBytes === 100 && row.atMs > f.resource.window.initial.atMs && row.atMs < f.resource.window.final.atMs));
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.equal(result.intervals[0].evidence.complete, true, 'the separate Composition journal is also structurally valid');
  assert.deepEqual(result.reservationObservations, []);
  assert(result.missing.includes('Composition central reservation replay is incomplete'));
});

test('an overflowed central journal retains a higher final point in its R38 lower bound', t => {
  const f = reservationFixture(t), {resource} = f;
  const first = f.raw.snapshots[0], last = f.raw.snapshots[1];
  const producer = new TextResourceObservations(resource.window.ledgerInstanceId, first.value.timeOrigin);
  const point = (sequence, bytes) => ({atMs: first.value.observedMs + 0.1 + sequence / 10000,
    ledgerSequence: sequence, textSequence: 0, cpu: [1000, 0, 0, 0, bytes, 0, 0], poolTextBytes: 2000, glyphGpuBytes: 0});
  const begin = producer.begin(resource.window.id, point(0, 0));
  for (let sequence = 1; sequence <= TEXT_RESOURCE_ROW_LIMIT; sequence++) producer.observe(point(sequence, 1 + sequence % 2));
  const end = producer.end(resource.window.id, {...point(TEXT_RESOURCE_ROW_LIMIT + 1, 150), atMs: last.value.observedMs + 1});
  resource.begin = structuredClone(begin); resource.end = structuredClone(end); resource.window = structuredClone(producer.copy());
  assert.equal(resource.window.rows.length, TEXT_RESOURCE_ROW_LIMIT);
  assert.equal(resource.window.dropped, 1); assert.equal(resource.window.observationComplete, false);
  assert(resource.window.rows.every(row => row.cpu[4] <= 2));
  assert.equal(resource.window.final.cpu[4], 150);
  assert.equal(resource.window.peakCpu.bytes, 3150, 'the actual final point owns the full producer peak');
  const result = inspectOrdinaryCompositionRaw(f.raw, f.binding);
  assert.equal(result.reservationObservations.length, 1);
  const row = result.reservationObservations[0];
  assert.equal(row.observedSupersetPeakBytes, 150);
  assert.equal(row.peakSequence, TEXT_RESOURCE_ROW_LIMIT + 1);
  assert.equal(row.transitionCoverageComplete, false); assert.equal(row.bound, 'retained-transition-lower-bound');
  assert.equal(row.r38CoverageComplete, false); assert.equal(row.physicalMemoryComplete, false);
  assert.equal(row.ceilingAssessment, 'unavailable'); assert.deepEqual(result.failures, []);
  assert(result.missing.includes('Composition central reservations retain only an incomplete operation transition range'));
  assert(!result.measurements.some(value => ['R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes'].includes(value.name)));
});

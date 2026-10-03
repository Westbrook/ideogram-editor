// Promotion target tests/campaigns/composition-observations.test.mjs. Root builds first.
import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import { CompositionObservations, jsonUtf8Bytes } from '../../dist/local/src/observability/composition-observations.js';
import { AllocationLedger } from '../../dist/local/src/observability/allocations.js';
import { deriveCompositionMeasurements } from '../../tooling/qualification/campaigns/browser-composition-counters.mjs';

const source = bytes => ({ hash: 'sha256:' + 'a'.repeat(64), byteLength: String(bytes) });
const owners=new Set();afterEach(()=>{for(const owner of owners)owner.dispose();owners.clear();});
const recorder = capacity => { let at = 0; const owner=new CompositionObservations(capacity, () => ++at, () => 10000);owners.add(owner);return owner; };
// The assertion runner owns this extracted copy; the product read ends only
// after the synchronous copy boundary, never before its allocation.
function snapshot(observer){const read=observer.readSnapshot();try{return structuredClone(read.value);}finally{read.release();}}

test('exact UTF8 JSON count handles escaping, lone surrogates, astral glyphs and number formatting', () => {
  for (const value of [null, true, false, 1e30, -0, NaN, { text: 'é🖼\u0000\n"\\', lone: '\ud800', omitted: undefined }, [null, undefined, '']]) assert.equal(jsonUtf8Bytes(value), Buffer.byteLength(JSON.stringify(value)));
  const circular = {}; circular.self = circular; assert.throws(() => jsonUtf8Bytes(circular));
  let getterRead = false; assert.throws(() => jsonUtf8Bytes({ get text() { getterRead = true; return 'secret'; } })); assert.equal(getterRead, false);
});

test('actual reserve/resize/release hooks retain overlapping owned peaks invisible at endpoints', () => {
  const observer = recorder(64), ledger = new AllocationLedger(observer);
  const held = ledger.reserve({ owner: 'request-prompt-retained', kind: 'prompt', cpuBytes: 10 });
  const before = snapshot(observer), first = ledger.reserve({ owner: 'composition-raw-copy', kind: 'prompt', cpuBytes: 30 });
  const second = ledger.reserve({ owner: 'composition-parse-model', kind: 'prompt', cpuBytes: 40 });
  const inspection = observer.beginRawInspection(source(12), 'parse');inspection.materialized(12);
  observer.parsed(12, { state: 'malformed', issues: [{ code: 'INVALID_JSON' }] }, source(12));
  inspection.finish('parsed', 'malformed');inspection.close();
  first.resize({ cpuBytes: 50 }); second.release(); first.release();
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(result.measurements.find(row => row.name === 'R38TextCaptionWorkspaceBytes').value, 100);
  assert.equal(result.measurements.find(row => row.name === 'R38MaterializedRawInspectionBytes').value, 12);
  assert.equal(result.evidence.rawInspectionReservations.observedPeakBytes, 90);
  assert(result.measurements.find(row => row.name === 'R38TextCaptionWorkspaceBytes').complete);
  held.release();
});

test('failed reservations and repeated release do not manufacture owner transitions', () => {
  const observer = recorder(16), ledger = new AllocationLedger(observer);
  const lease = ledger.reserve({ owner: 'composition-raw-copy', kind: 'prompt', cpuBytes: 5 });
  const cursor = snapshot(observer).cursor; assert.throws(() => lease.resize({ cpuBytes: 100 * 1048576 })); assert.equal(snapshot(observer).cursor, cursor);
  lease.release(); const released = snapshot(observer).cursor; lease.release(); assert.equal(snapshot(observer).cursor, released);
});

test('raw page bytes refer to original bounded bytes, including multibyte text and offsets', () => {
  const observer = recorder(16); observer.ownership('request-prompt-retained', 0, 1, 1); const before = snapshot(observer);
  observer.page(source(50000), 32768, 17232);
  const row = deriveCompositionMeasurements([before, snapshot(observer)]).measurements.find(value => value.name === 'R38RawPageBytes');
  assert.equal(row.value, 17232); assert.equal(row.complete, true);
});

test('over-limit raw input is never labeled a complete supported parse of its prefix', () => {
  const observer = recorder(32); observer.ownership('request-prompt-retained', 0, 1, 1); const before = snapshot(observer);
  observer.parsed(0, { state: 'over-limit', issues: [{ code: 'BYTE_LIMIT' }] }, source(20 * 1048576));
  observer.parsed(8, { state: 'supported', issues: [], value: {} }, source(20 * 1048576));
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(result.measurements.find(row => row.name === 'R38RawTruncationOrFalseCompletenessCount').value, 1);
});

test('unexercised raw/derived operations produce missing evidence instead of passing zero', () => {
  const observer = recorder(16); observer.ownership('request-prompt-retained', 0, 1, 1); const before = snapshot(observer);
  observer.ownership('request-prompt-retained', 1, 2, 2);
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert(!result.measurements.some(row => row.name === 'R38RawTruncationOrFalseCompletenessCount'));
  assert(!result.measurements.some(row => row.name === 'R38DerivedSnapshotBytes'));
  assert(result.missing.some(value => value.startsWith('R38RawPageBytes')));
});

test('bounded ring overflow refuses completeness, while retained intermediate cursors cover it', () => {
  const observer = recorder(2); observer.ownership('request-prompt-retained', 0, 1, 1); const before = snapshot(observer);
  observer.value('issues', [], 'ui-issues'); observer.value('issues', [{ code: 'one' }], 'ui-issues'); const middle = snapshot(observer);
  observer.value('issues', [{ code: 'two' }], 'ui-issues'); observer.value('issues', [{ code: 'three' }], 'ui-issues'); const after = snapshot(observer);
  assert.equal(deriveCompositionMeasurements([before, after]).evidence.complete, false);
  assert.equal(deriveCompositionMeasurements([before, middle, after]).evidence.complete, true);
});

test('diagnostics retain numeric facts and source hashes but no authored content', () => {
  const observer = recorder(16), secret = 'private prompt sentinel';
  observer.parsed(5, { state: 'supported', issues: [], value: { text: secret } });
  observer.value('issues', [{ message: secret }], 'ui-issues');
  assert(!JSON.stringify(snapshot(observer)).includes(secret));
  assert(snapshot(observer).records.every(row => !('value' in row) && !('text' in row)));
  assert.equal(snapshot(observer).observerMetadata.complete, true);
  assert.equal(snapshot(observer).observerMetadata.basis, 'admitted-application-diagnostic-payload-allowances');
});

test('failed cycles keep actual rows as incomplete observations', () => {
  const observer = recorder(16); observer.ownership('request-prompt-retained', 0, 1, 1); const before = snapshot(observer);
  observer.value('derived-snapshot', { caption: 'actual' }, 'serialize');
  const result = deriveCompositionMeasurements([before, snapshot(observer)], { failed: true });
  assert.equal(result.measurements[0].complete, false);
});

test('actual constructor birth anchors one fresh realm without manufacturing a zero snapshot', () => {
  const observer = recorder(32), ledger = new AllocationLedger(observer);
  const lease = ledger.reserve({ owner: 'composition-raw-copy', kind: 'prompt', cpuBytes: 17 });
  const inspection = observer.beginRawInspection(source(17), 'page');inspection.materialized(17);
  observer.page(source(17), 0, 17);inspection.finish('page');inspection.close();lease.release();
  const after = snapshot(observer), result = deriveCompositionMeasurements([after], { start: 'birth' });
  assert.equal(after.birth.kind, 'composition-observer-birth-1');
  assert.equal(after.birth.instanceId, after.instanceId);
  assert.equal(after.birth.cursor, 0); assert.equal(after.birth.promptOwnedBytes, 0);
  assert(after.birth.atMs < after.records[0].atMs && after.records.at(-1).atMs < after.atMs);
  assert.equal(result.evidence.complete, true); assert.equal(result.evidence.fromAtMs, after.birth.atMs);
  assert.equal(result.measurements.find(row => row.name === 'R38TextCaptionWorkspaceBytes').value, 17);
  assert.equal(result.measurements.find(row => row.name === 'R38MaterializedRawInspectionBytes').value, 17);
  assert(result.measurements.every(row => row.complete));
  assert.equal(deriveCompositionMeasurements([after]).evidence.complete, false);
});

test('unexercised actual birth never manufactures workspace or page zero measurements', () => {
  const observer = recorder(16), result = deriveCompositionMeasurements([snapshot(observer)], { start: 'birth' });
  assert.equal(result.evidence.complete, true);
  assert.deepEqual(result.measurements, []); assert.equal(result.missing.length, 6);
});

test('birth remains immutable and independent of a ring that has already overflowed', () => {
  const observer = recorder(2), first = snapshot(observer);
  observer.ownership('request-prompt-retained', 0, 1, 1); const middle = snapshot(observer);
  observer.value('issues', [], 'ui-issues'); observer.value('issues', [], 'ui-issues');
  const after = snapshot(observer); assert.deepEqual(after.birth, first.birth);
  assert.equal(deriveCompositionMeasurements([after], { start: 'birth' }).evidence.complete, false);
  assert.equal(deriveCompositionMeasurements([middle, after], { start: 'birth' }).evidence.complete, true);
  first.birth.promptOwnedBytes = 123;
  assert.equal(snapshot(observer).birth.promptOwnedBytes, 0, 'returned birth copy cannot mutate producer');
});

function completeInterval() {
  const observer = recorder(32), ledger = new AllocationLedger(observer);
  const held = ledger.reserve({ owner: 'request-prompt-retained', kind: 'prompt', cpuBytes: 3 });
  const before = snapshot(observer), control = ledger.reserve({ owner: 'composition-read-operation', kind: 'control', cpuBytes: 5 });
  const raw = ledger.reserve({ owner: 'composition-raw-copy', kind: 'prompt', cpuBytes: 10 });
  const inspection = observer.beginRawInspection(source(10), 'parse');observer.read('blob-read', 10, 10, inspection);
  observer.parsed(10, { state: 'supported', issues: [], value: {} }, source(10));
  inspection.finish('parsed', 'supported');inspection.close();
  const page = observer.beginRawInspection(source(10), 'page');page.materialized(10);
  observer.page(source(10), 0, 10);page.finish('page');page.close();raw.release();control.release();const after = snapshot(observer);held.release();
  const result = deriveCompositionMeasurements([before, after]);
  assert.equal(result.evidence.complete, true);assert(result.measurements.length > 0);assert(result.measurements.every(row => row.complete));
  return [before, after];
}
function mutateRow(snapshots, kind, mutate) {
  const sequence = snapshots.at(-1).records.find(row => row.kind === kind).sequence;
  for (const value of snapshots) for (const row of value.records) if (row.sequence === sequence) mutate(row);
}
const tampering = [
  ['invented page zero violation', values => mutateRow(values, 'raw-page', row => { row.receivedBytes = 9; })],
  ['invented over-limit supported parse', values => mutateRow(values, 'raw-inspection', row => { row.sourceBytes = 262145; })],
  ['supported parse without derived value', values => mutateRow(values, 'raw-inspection', row => { row.derivedPresent = false; })],
  ['invalid parse state', values => mutateRow(values, 'raw-inspection', row => { row.parseState = 'complete'; })],
  ['invented retained identity', values => mutateRow(values, 'raw-page', row => { delete row.sourceHash; })],
  ['invalid operation', values => mutateRow(values, 'derived-snapshot', row => { row.operation = 'blob-read'; })],
  ['hidden issue array', values => mutateRow(values, 'issues', row => { row.issueCount = 0; row.utf8Bytes = 3; })],
  ['unknown record kind', values => mutateRow(values, 'issues', row => { row.kind = 'invented'; })],
  ['incomplete operation hidden from maxima', values => mutateRow(values, 'raw-page', row => { row.complete = false; })],
  ['nonownership reservation change', values => mutateRow(values, 'issues', row => { row.promptOwnedBytes++; })],
  ['tampered first endpoint', values => { values[0].promptOwnedBytes++; }],
  ['raw count exceeds total', values => { values[0].rawInspectionOwnedBytes = values[0].promptOwnedBytes + 1; }],
  ['forged ring start', values => { values[1].oldestSequence++; }],
  ['forged dropped count', values => { values[1].dropped++; }],
  ['missing retained ring row', values => { values[1].records.splice(1, 1); }],
  ['duplicate retained ring row', values => { values[1].records[2] = structuredClone(values[1].records[1]); }],
  ['ring size change', values => { values[1].observerMetadata.ringCapacity++; values[1].observerMetadata.capacityBytes += 1024; }],
  ['record after snapshot boundary', values => { values[1].records.at(-1).atMs = values[1].atMs + 1; }],
  ['birth zero rewritten', values => { for (const value of values) value.birth.promptOwnedBytes = 1; }],
  ['birth identity rewritten', values => { values[1].birth.instanceId = crypto.randomUUID(); }],
  ['birth timestamp rewritten', values => { values[1].birth.atMs += 0.25; }],
  ['cross-realm snapshots despite equal clock origin', values => { values[1].instanceId = crypto.randomUUID(); values[1].birth.instanceId = values[1].instanceId; }],
  ['observer metadata count differs', values => { values[1].observerMetadata.snapshotRecords++; }],
  ['undeclared record contents', values => mutateRow(values, 'issues', row => { row.authoredText = 'must not be accepted'; })],
];
for (const [name, mutate] of tampering) test('strict composition replay rejects ' + name, () => {
  const values = completeInterval(); mutate(values); const result = deriveCompositionMeasurements(values);
  assert.equal(result.evidence.complete, false);
  assert(!result.measurements.some(row => row.complete));
});

test('intermediate invalid counters cannot be erased by a clean final snapshot', () => {
  const [before, after] = completeInterval(), middle = structuredClone(before); middle.invalid = 1;
  const result = deriveCompositionMeasurements([before, middle, after]);
  assert.equal(result.evidence.complete, false); assert(!result.measurements.some(row => row.complete));
});

test('intermediate cursor resets and contradictory duplicate rows are rejected', () => {
  const [before, after] = completeInterval();
  assert.equal(deriveCompositionMeasurements([before, after, before, after]).evidence.complete, false);
  const middle = structuredClone(after); middle.records.find(row => row.kind === 'derived-snapshot').utf8Bytes++;
  assert.equal(deriveCompositionMeasurements([before, middle, after]).evidence.complete, false);
});

test('valid partial raw reads remain diagnostics and cannot claim a completed full read', () => {
  const observer = recorder(16), before = snapshot(observer); observer.read('blob-read', 4, 10);
  const after = snapshot(observer), result = deriveCompositionMeasurements([before, after]);
  assert.equal(result.evidence.complete, true); assert.equal(result.measurements.length, 0);
  after.records[0].complete = true;
  assert.equal(deriveCompositionMeasurements([before, after]).evidence.complete, false);
});

test('correctly counted page and missing-derived violations remain visible failures', () => {
  const observer = recorder(32); observer.ownership('request-prompt-retained', 0, 1, 1); const before = snapshot(observer);
  observer.page(source(10), 0, 9); observer.parsed(10, { state: 'supported', issues: [] }, source(10));
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  const violations = result.measurements.find(row => row.name === 'R38RawTruncationOrFalseCompletenessCount');
  assert.equal(violations.value, 2); assert.equal(violations.complete, true);
});

test('birth does not turn an unbound conversion parse into retained-byte integrity evidence', () => {
  const observer = recorder(16), ledger = new AllocationLedger(observer);
  const lease = ledger.reserve({ owner: 'composition-raw-copy', kind: 'prompt', cpuBytes: 2 });
  observer.parsed(2, { state: 'supported', issues: [], value: {} }); lease.release();
  const result = deriveCompositionMeasurements([snapshot(observer)], { start: 'birth' });
  assert.equal(result.evidence.complete, true);
  assert(!result.measurements.some(row => row.name === 'R38RawTruncationOrFalseCompletenessCount'));
  assert(result.missing.some(value => value.startsWith('R38RawTruncationOrFalseCompletenessCount')));
});

test('actual snapshot and birth clocks fail closed before producing inconsistent boundaries', () => {
  let at = -1;
  assert.throws(() => new CompositionObservations(16, () => at, () => 10000), /COMPOSITION_OBSERVER_CLOCK/);
  at = 1; const observer = new CompositionObservations(16, () => at, () => 10000); owners.add(observer);
  at = 0; assert.throws(() => snapshot(observer), /COMPOSITION_OBSERVER_CLOCK/);
  at = 2; const after = snapshot(observer); assert.equal(after.invalid, 1);
  assert.equal(deriveCompositionMeasurements([after], { start: 'birth' }).evidence.complete, false);
});

// Workspace diagnostics replay simultaneous amounts. Separate prompt and
// control peaks cannot be added after the fact, and remain nonresident evidence.
test('real Composition control and prompt transitions yield a simultaneous workspace maximum', () => {
  const observer = recorder(64), ledger = new AllocationLedger(observer);
  const prompt = ledger.reserve({ owner: 'request-prompt-retained', kind: 'prompt', cpuBytes: 10 });
  const before = snapshot(observer), render = ledger.reserve({ owner: 'composition-render-payload', kind: 'control', cpuBytes: 40 });
  const read = ledger.reserve({ owner: 'composition-read-operation', kind: 'control', cpuBytes: 30 });
  const model = ledger.reserve({ owner: 'composition-response-model', kind: 'control', cpuBytes: 50 });
  prompt.resize({ cpuBytes: 20 });model.release();read.release();render.release();prompt.resize({ cpuBytes: 100 });prompt.release();
  const after = snapshot(observer), result = deriveCompositionMeasurements([before, after]);
  const workspace = result.measurements.find(row => row.name === 'R38TextCaptionWorkspaceBytes');
  assert.equal(workspace.value, 140);assert.equal(workspace.complete, true);assert.equal(result.evidence.complete, true);
  assert.equal(Math.max(...after.records.map(row => row.promptOwnedBytes)) + Math.max(...after.records.map(row => row.compositionControlOwnedBytes)), 220, 'sum of independent peaks differs from the simultaneous maximum');
  assert.deepEqual(after.records.filter(row => row.kind === 'control-ownership').map(row => row.compositionControlOwnedBytes), [40, 70, 120, 70, 40, 0]);
  assert.equal(after.compositionControlOwnedBytes, 0);assert.equal(after.promptOwnedBytes, 0);assert.equal(after.rawInspectionOwnedBytes, 0);
  assert.equal(after.physicalMemoryComplete, false);
  assert(!result.measurements.some(row => row.name === 'R38MaterializedRawInspectionBytes'), 'control reads do not create raw-inspection evidence');
});

test('only the three exact Composition control owners enter the producer journal', () => {
  const observer = recorder(32), ledger = new AllocationLedger(observer), before = snapshot(observer);
  for (const owner of ['composition-render-payload-extra', 'composition-read-operation-extra', 'composition-response-model-extra', 'composition-unrelated', 'request-prompt-page']) {
    const lease = ledger.reserve({ owner, kind: 'control', cpuBytes: 17 });lease.resize({ cpuBytes: 31 });lease.markUnused();lease.release();
  }
  for (const kind of ['scratch', 'copy', 'staging']) {
    const lease = ledger.reserve({ owner: 'composition-render-payload', kind, cpuBytes: 19 });lease.resize({ cpuBytes: 29 });lease.release();
  }
  const after = snapshot(observer);
  assert.equal(after.cursor, before.cursor);assert.equal(after.invalid, 0);assert.equal(after.ownershipStarted, false);
  assert.equal(after.promptOwnedBytes, 0);assert.equal(after.compositionControlOwnedBytes, 0);assert.equal(after.rawInspectionOwnedBytes, 0);
  assert.equal(after.birth.compositionControlOwnedBytes, 0);
});

test('refused control admission and resize, markUnused and repeated release add no fake transitions', () => {
  const observer = recorder(32), ledger = new AllocationLedger(observer);
  const lease = ledger.reserve({ owner: 'composition-render-payload', kind: 'control', cpuBytes: 5 }), admitted = snapshot(observer);
  assert.throws(() => ledger.reserve({ owner: 'composition-response-model', kind: 'control', cpuBytes: 512 * 1048576 }), /ALLOCATION_BUDGET/);
  assert.throws(() => lease.resize({ cpuBytes: 512 * 1048576 }), /ALLOCATION_BUDGET/);
  assert.throws(() => lease.resize({ cpuBytes: NaN }), /ALLOCATION_INVALID/);
  lease.markUnused();const refused = snapshot(observer);
  assert.equal(refused.cursor, admitted.cursor);assert.equal(refused.invalid, 0);assert.equal(refused.compositionControlOwnedBytes, 5);
  lease.release();const released = snapshot(observer);lease.release();
  assert.equal(released.cursor, admitted.cursor + 1);assert.equal(released.compositionControlOwnedBytes, 0);assert.equal(snapshot(observer).cursor, released.cursor);
});

test('control-only ownership supports actual birth and ordinary intervals without inventing raw inspection', () => {
  const observer = recorder(32), ledger = new AllocationLedger(observer), before = snapshot(observer);
  const render = ledger.reserve({ owner: 'composition-render-payload', kind: 'control', cpuBytes: 64 });render.release();
  const after = snapshot(observer);
  for (const [snapshots, options] of [[[after], { start: 'birth' }], [[before, after], {}]]) {
    const result = deriveCompositionMeasurements(snapshots, options), workspace = result.measurements.find(row => row.name === 'R38TextCaptionWorkspaceBytes');
    assert.equal(result.evidence.complete, true);assert.equal(workspace.value, 64);assert.equal(workspace.complete, true);
    assert(!result.measurements.some(row => row.name === 'R38MaterializedRawInspectionBytes'));
  }
  assert.equal(after.birth.compositionControlOwnedBytes, 0);after.birth.compositionControlOwnedBytes = 1;
  assert.equal(snapshot(observer).birth.compositionControlOwnedBytes, 0, 'returned birth cannot rewrite the actual producer zero');
});

test('control-only ring overflow remains incomplete until actual intermediate snapshots bridge the gap', () => {
  const observer = recorder(2), ledger = new AllocationLedger(observer), before = snapshot(observer);
  const render = ledger.reserve({ owner: 'composition-render-payload', kind: 'control', cpuBytes: 4 });render.resize({ cpuBytes: 8 });
  const middle = snapshot(observer);render.resize({ cpuBytes: 12 });render.release();const after = snapshot(observer);
  assert.equal(deriveCompositionMeasurements([before, after]).evidence.complete, false);
  const result = deriveCompositionMeasurements([before, middle, after]);
  assert.equal(result.evidence.complete, true);const workspace = result.measurements.find(row => row.name === 'R38TextCaptionWorkspaceBytes');assert.equal(workspace.value, 12);assert.equal(workspace.complete, true);
});

function mutateIntervalRow(values, kind, mutate) {
  const sequence = values.at(-1).records.find(row => row.sequence > values[0].cursor && row.kind === kind).sequence;
  for (const value of values) for (const row of value.records) if (row.sequence === sequence) mutate(row);
}
const controlTampering = [
  ['missing mandatory control counter on row', values => mutateIntervalRow(values, 'control-ownership', row => { delete row.compositionControlOwnedBytes; })],
  ['missing mandatory control counter on snapshot', values => { delete values[1].compositionControlOwnedBytes; }],
  ['missing mandatory control counter at birth', values => { for (const value of values) delete value.birth.compositionControlOwnedBytes; }],
  ['forged nonzero control birth', values => { for (const value of values) value.birth.compositionControlOwnedBytes = 1; }],
  ['control row mutating prompt', values => mutateIntervalRow(values, 'control-ownership', row => { row.promptOwnedBytes++; })],
  ['control row mutating raw inspection', values => mutateIntervalRow(values, 'control-ownership', row => { row.rawInspectionOwnedBytes++; })],
  ['prompt row mutating control', values => mutateIntervalRow(values, 'ownership', row => { row.compositionControlOwnedBytes++; })],
  ['nonownership row mutating control', values => mutateIntervalRow(values, 'issues', row => { row.compositionControlOwnedBytes++; })],
  ['control endpoint mismatch', values => { values[1].compositionControlOwnedBytes++; }],
  ['negative control amount', values => mutateIntervalRow(values, 'control-ownership', row => { row.compositionControlOwnedBytes = -1; })],
  ['fractional control amount', values => mutateIntervalRow(values, 'control-ownership', row => { row.compositionControlOwnedBytes = 0.5; })],
  ['prompt plus control exceeding safe integer', values => mutateIntervalRow(values, 'control-ownership', row => { row.compositionControlOwnedBytes = Number.MAX_SAFE_INTEGER; })],
  ['control transition disguised as prompt transition', values => mutateIntervalRow(values, 'control-ownership', row => { row.kind = 'ownership'; })],
  ['prompt transition disguised as control transition', values => mutateIntervalRow(values, 'ownership', row => { row.kind = 'control-ownership'; })],
  ['control row carrying undeclared owner text', values => mutateIntervalRow(values, 'control-ownership', row => { row.owner = 'composition-read-operation'; })],
  ['missing retained control transition', values => { const index = values[1].records.findIndex(row => row.kind === 'control-ownership');values[1].records.splice(index, 1); }],
];
for (const [name, mutate] of controlTampering) test('strict Composition control replay rejects ' + name, () => {
  const values = completeInterval();mutate(values);const result = deriveCompositionMeasurements(values);
  assert.equal(result.evidence.complete, false);assert(!result.measurements.some(row => row.complete));
});

for (const [name, promptBytes, controlBytes] of [['control-only', 0, 37], ['prompt-only', 31, 0], ['prompt plus control', 31, 37]]) {
  test('positive carried ' + name + ' reservations remain visible without an interval ownership transition', () => {
    const observer = recorder(32), ledger = new AllocationLedger(observer);
    const prompt = promptBytes ? ledger.reserve({owner: 'request-prompt-retained', kind: 'prompt', cpuBytes: promptBytes}) : null;
    const render = controlBytes ? ledger.reserve({owner: 'composition-render-payload', kind: 'control', cpuBytes: controlBytes}) : null;
    try {
      const before = snapshot(observer);observer.value('issues', [], 'ui-issues');const after = snapshot(observer);
      assert.deepEqual(after.records.filter(row => row.sequence > before.cursor).map(row => row.kind), ['issues']);
      assert.equal(before.promptOwnedBytes, promptBytes);assert.equal(before.compositionControlOwnedBytes, controlBytes);
      assert.equal(after.promptOwnedBytes, promptBytes);assert.equal(after.compositionControlOwnedBytes, controlBytes);
      const result = deriveCompositionMeasurements([before, after]), workspace = result.measurements.find(row => row.name === 'R38TextCaptionWorkspaceBytes');
      assert.equal(result.evidence.complete, true);assert.equal(result.evidence.ownershipUpdates, 0);
      assert.equal(workspace.value, promptBytes + controlBytes);assert.equal(workspace.complete, true);
      assert(!result.measurements.some(row => row.name === 'R38MaterializedRawInspectionBytes'));
      assert(result.missing.some(value => value.startsWith('R38MaterializedRawInspectionBytes: operation was not observed')));
      assert.equal(after.physicalMemoryComplete, false);
    } finally {render?.release();prompt?.release();}
  });
}

const inspectionMetric = result => result.measurements.find(row => row.name === 'R38MaterializedRawInspectionBytes');
const inspectionSource = (bytes, identity = 'b') => ({hash: 'sha256:' + identity.repeat(64), byteLength: String(bytes)});
function inspect(observer, {bytes, mode = 'parse', extent = bytes, offset = 0, outcome = 'parsed', state = mode === 'parse' ? 'supported' : undefined, identity = 'b'}) {
  const token = observer.beginRawInspection(inspectionSource(bytes, identity), mode, offset);
  try {token.materialized(extent);token.finish(outcome, state);} finally {token.close();}
}

test('inspection extent uses actual original bytes, independent of overlapping copies and parser allowances', () => {
  const observer = recorder(64), ledger = new AllocationLedger(observer), before = snapshot(observer);
  const allowance = ledger.reserve({owner: 'composition-parse-scratch', kind: 'prompt', cpuBytes: 20 * 1048576});
  const first = observer.beginRawInspection(inspectionSource(12), 'decode');first.materialized(12);
  const second = observer.beginRawInspection(inspectionSource(8, 'c'), 'parse');second.materialized(8);
  second.finish('parsed', 'supported');first.finish('decoded');second.close();first.close();allowance.release();
  const after = snapshot(observer), result = deriveCompositionMeasurements([before, after]);
  assert.equal(after.schemaVersion, 2);assert.equal(inspectionMetric(result).value, 12);assert.equal(inspectionMetric(result).complete, true);
  assert.equal(result.evidence.rawInspectionReservations.observedPeakBytes, 20 * 1048576);
  assert.equal(result.evidence.rawInspectionReservations.physicalMemoryComplete, false);
  assert.equal(result.evidence.rawInspection.materializedOperations, 2);
  assert.equal(after.activeInspections, 0);assert.equal(after.inspectionSerial, 2);
});

test('legacy reservation diagnostics retain an observed peak without claiming complete ownership coverage', () => {
  const observer = recorder(32), before = snapshot(observer);
  observer.ownership('composition-raw-copy', 0, 100, 100);observer.page(source(10), 0, 10);observer.ownership('composition-raw-copy', 100, 0, 0);
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(result.evidence.rawInspectionReservations.observedPeakBytes, 100);
  assert.equal(result.evidence.rawInspectionReservations.transitionCoverageComplete, false);
  assert.equal(inspectionMetric(result), undefined);
  const unexercised = recorder(16), absent = deriveCompositionMeasurements([snapshot(unexercised)], {start: 'birth'});
  assert.equal(absent.evidence.rawInspectionReservations.observedPeakBytes, null);
});

test('UTF8-trimmed page at a large source offset measures its page length, not source size or offset', () => {
  const observer = recorder(32), before = snapshot(observer);
  const token = observer.beginRawInspection(inspectionSource(70 * 1048576), 'page', 64 * 1048576);
  observer.read('stream-read', 32766, 32766, token);token.finish('page');token.close();
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(inspectionMetric(result).value, 32766);assert.equal(inspectionMetric(result).complete, true);
  assert.equal(result.evidence.rawInspection.unmatchedReads, 0);
});

for (const [name, input] of [
  ['complete boundary parse', {bytes: 262144}],
  ['opaque local depth or string rejection below the byte cap', {bytes: 128, outcome: 'opaque', state: 'over-limit'}],
  ['over-limit sentinel from a larger retained source', {bytes: 20 * 1048576, extent: 262145, outcome: 'opaque', state: 'over-limit'}],
  ['exact decode qualification boundary', {bytes: 16 * 1048576, mode: 'decode', outcome: 'decoded', state: undefined}],
]) test('source-bound inspection admits ' + name, () => {
  const observer = recorder(32), before = snapshot(observer);inspect(observer, input);
  const row = inspectionMetric(deriveCompositionMeasurements([before, snapshot(observer)]));
  assert.equal(row.value, input.extent ?? input.bytes);assert.equal(row.complete, true);
});

test('metadata-only opaque decision does not invent a materialization sample, while an actually read empty input does', () => {
  const observer = recorder(32), before = snapshot(observer);
  const token = observer.beginRawInspection(inspectionSource(20 * 1048576), 'opaque');token.finish('opaque', 'over-limit');token.close();
  const middle = snapshot(observer), absent = deriveCompositionMeasurements([before, middle]);
  assert.equal(inspectionMetric(absent), undefined);assert.equal(absent.evidence.rawInspection.completedOperations, 1);
  const empty = observer.beginRawInspection(inspectionSource(0, 'c'), 'parse');observer.read('blob-read', 0, 0, empty);empty.finish('parsed', 'malformed');empty.close();
  const row = inspectionMetric(deriveCompositionMeasurements([middle, snapshot(observer)]));
  assert.equal(row.value, 0);assert.equal(row.complete, true);
});

for (const [name, input] of [
  ['empty page before source end', {bytes: 10, mode: 'page', extent: 0, outcome: 'page', state: undefined}],
  ['page extending beyond source', {bytes: 10, mode: 'page', offset: 9, extent: 2, outcome: 'page', state: undefined}],
  ['truncated supposedly supported parse', {bytes: 100, extent: 99}],
  ['supported over-limit sentinel', {bytes: 262145}],
  ['partial decode', {bytes: 10, mode: 'decode', extent: 9, outcome: 'decoded', state: undefined}],
  ['parsed outcome for a page', {bytes: 10, mode: 'page'}],
]) test('inspection replay refuses ' + name + ' without removing unrelated byte evidence', () => {
  const observer = recorder(32), before = snapshot(observer);inspect(observer, input);observer.value('issues', [], 'ui-issues');
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(result.evidence.complete, true);assert(!inspectionMetric(result)?.complete);
  assert.equal(result.measurements.find(row => row.name === 'R38IssueBytes').complete, true);
  assert.equal(result.evidence.rawInspection.complete, false);
});

// A known oversized operation is evidence of its measured extent. Dropping it
// as an admission error would conceal a real resource-ceiling breach. These
// are numeric producer witnesses, not allocations of the described payloads.
for (const [name, input] of [
  ['page above its page limit', {bytes: 40000, mode: 'page', extent: 32769, outcome: 'page'}],
  ['page above the raw inspection ceiling', {bytes: 20 * 1048576, mode: 'page', extent: 16 * 1048576 + 1, outcome: 'page'}],
  ['whole decode above the raw inspection ceiling', {bytes: 16 * 1048576 + 1, mode: 'decode', outcome: 'decoded'}],
  ['whole over-limit parse above the raw inspection ceiling', {bytes: 16 * 1048576 + 1, outcome: 'opaque', state: 'over-limit'}],
  ['opaque prefix above the raw inspection ceiling', {bytes: 20 * 1048576, extent: 16 * 1048576 + 1, outcome: 'opaque', state: 'over-limit'}],
]) test('complete oversized inspection preserves the actual numeric result: ' + name, () => {
  const observer = recorder(32), before = snapshot(observer);inspect(observer, input);
  const result = deriveCompositionMeasurements([before, snapshot(observer)]), row = inspectionMetric(result);
  assert.equal(row.value, input.extent ?? input.bytes);assert.equal(row.complete, true);
  assert.equal(result.evidence.rawInspection.complete, true);
  assert(!result.missing.some(value => value.startsWith('R38MaterializedRawInspectionBytes:')));
  if (name !== 'page above its page limit') assert(row.value > 16 * 1048576, 'ordinary budget evaluation receives the actual breached ceiling');
});

test('an oversized inspected page retains its separate exact-page contradiction', () => {
  const observer = recorder(32), before = snapshot(observer), original = inspectionSource(40000);
  const token = observer.beginRawInspection(original, 'page');observer.read('blob-read', 32769, 40000, token);
  observer.page(original, 0, 32769);token.finish('page');token.close();
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(inspectionMetric(result).value, 32769);assert.equal(inspectionMetric(result).complete, true);
  assert.equal(result.measurements.find(row => row.name === 'R38RawPageBytes').value, 32769);
  assert.equal(result.measurements.find(row => row.name === 'R38RawTruncationOrFalseCompletenessCount').value, 1);
});

test('failed outer action retains a lower bound from a fully validated oversized inspection', () => {
  const observer = recorder(32), before = snapshot(observer), bytes = 16 * 1048576 + 1;
  inspect(observer, {bytes, mode: 'decode', outcome: 'decoded'});observer.value('issues', [], 'ui-issues');
  const after = snapshot(observer), result = deriveCompositionMeasurements([before, after], {failed: true}), row = inspectionMetric(result);
  assert.equal(row.value, bytes);assert.equal(row.complete, false);assert.equal(row.lowerBound, true);
  assert.equal(result.evidence.complete, false);assert.equal(result.evidence.rawInspection.complete, false);
  assert.equal(result.measurements.find(value => value.name === 'R38IssueBytes').lowerBound, undefined);
  assert.equal(inspectionMetric(deriveCompositionMeasurements([before, after])).lowerBound, undefined);
});

test('invalid or abandoned inspection evidence cannot acquire lower-bound authority from outer failure', () => {
  for (const defect of ['unmatched-read', 'abandoned-token', 'observer-misuse']) {
    const observer = recorder(32), before = snapshot(observer), bytes = 16 * 1048576 + 1;
    inspect(observer, {bytes, mode: 'decode', outcome: 'decoded'});
    if (defect === 'unmatched-read') observer.read('blob-read', 1, 1);
    else {const token = observer.beginRawInspection(inspectionSource(8, 'c'), 'page');token.materialized(8);if (defect === 'observer-misuse') {token.materialized(8);token.finish('page');}token.close();}
    const row = inspectionMetric(deriveCompositionMeasurements([before, snapshot(observer)], {failed: true}));
    assert(!row?.complete);assert.equal(row?.lowerBound, undefined);
  }
});

test('unfinished and abandoned inspections prevent an otherwise successful extent from qualifying', () => {
  for (const close of [false, true]) {
    const observer = recorder(32), before = snapshot(observer), token = observer.beginRawInspection(inspectionSource(10), 'page');token.materialized(10);
    if (close) token.close();inspect(observer, {bytes: 2, identity: 'c'});
    const result = deriveCompositionMeasurements([before, snapshot(observer)]);
    assert.equal(result.evidence.complete, true);assert(!inspectionMetric(result)?.complete);assert.equal(result.evidence.rawInspection.complete, false);
  }
});

test('an interval starting during an inspection is incomplete even when all operations later finish', () => {
  const observer = recorder(32), carried = observer.beginRawInspection(inspectionSource(10), 'page'), before = snapshot(observer);
  carried.materialized(10);carried.finish('page');inspect(observer, {bytes: 2, identity: 'c'});
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(result.evidence.complete, true);assert(!inspectionMetric(result)?.complete);
  assert.equal(result.evidence.rawInspection.activeAtStart, 1);
});

test('unmatched generic raw reads withhold only the inspection metric', () => {
  const observer = recorder(32), before = snapshot(observer);inspect(observer, {bytes: 8});observer.read('blob-read', 4, 10);observer.value('issues', [], 'ui-issues');
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(result.evidence.complete, true);assert.equal(inspectionMetric(result).value, 8);assert.equal(inspectionMetric(result).complete, false);
  assert.equal(result.evidence.rawInspection.unmatchedReads, 1);assert.equal(result.measurements.find(row => row.name === 'R38IssueBytes').complete, true);
});

test('read helper records exactly one bound materialization; repeated token use fails closed independently', () => {
  for (const misuse of ['duplicate-materialization', 'duplicate-finish', 'foreign-token']) {
    const observer = recorder(32), before = snapshot(observer), token = observer.beginRawInspection(inspectionSource(8), 'parse');
    observer.read('blob-read', 8, 8, token);
    if (misuse === 'duplicate-materialization') token.materialized(8);
    token.finish('parsed', 'supported');token.close();
    if (misuse === 'duplicate-finish') token.finish('parsed', 'supported');
    if (misuse === 'foreign-token') {const other = recorder(16), foreign = other.beginRawInspection(inspectionSource(8), 'page');observer.read('blob-read', 8, 8, foreign);foreign.close();}
    observer.value('issues', [], 'ui-issues');const after = snapshot(observer), result = deriveCompositionMeasurements([before, after]);
    assert.equal(after.invalid, 0);assert.equal(after.inspectionInvalid, 1);assert.equal(result.evidence.complete, true);
    assert(!inspectionMetric(result)?.complete);assert.equal(result.measurements.find(row => row.name === 'R38IssueBytes').complete, true);
    assert.equal(after.records.filter(row => row.kind === 'raw-inspection-read').length, 1);
  }
});

test('closing a completed token is idempotent and later intervals keep monotonic identities', () => {
  const observer = recorder(32), first = observer.beginRawInspection(inspectionSource(5), 'page');first.materialized(5);first.finish('page');first.close();
  const before = snapshot(observer);first.close();assert.equal(snapshot(observer).cursor, before.cursor);
  inspect(observer, {bytes: 8, identity: 'c'});const after = snapshot(observer), row = inspectionMetric(deriveCompositionMeasurements([before, after]));
  assert.equal(after.inspectionSerial, 2);assert.equal(row.value, 8);assert.equal(row.complete, true);
});

test('observer bounds concurrent inspection metadata and rejects invalid source input without product exceptions', () => {
  const observer = recorder(256), before = snapshot(observer), tokens = [];
  for (let index = 0; index < 64; index++) tokens.push(observer.beginRawInspection(inspectionSource(8), 'page'));
  const refused = observer.beginRawInspection(inspectionSource(8), 'page');assert.equal(refused.id, 0);
  const malformed = observer.beginRawInspection({hash: 'private prompt sentinel', byteLength: '8'}, 'page');assert.equal(malformed.id, 0);
  refused.close();malformed.close();for (const token of tokens) token.close();
  const after = snapshot(observer);assert.equal(after.inspectionSerial, 64);assert.equal(after.activeInspections, 0);assert.equal(after.inspectionInvalid, 2);
  assert(!JSON.stringify(after).includes('private prompt sentinel'));assert(!inspectionMetric(deriveCompositionMeasurements([before, after]))?.complete);
});

test('retained intermediate cursors can bridge inspection record overflow, but cannot invent missing begin records', () => {
  const observer = recorder(2), before = snapshot(observer), token = observer.beginRawInspection(inspectionSource(8), 'page');
  token.materialized(8);const middle = snapshot(observer);token.finish('page');const after = snapshot(observer);
  assert.equal(deriveCompositionMeasurements([before, after]).evidence.complete, false);
  const row = inspectionMetric(deriveCompositionMeasurements([before, middle, after]));assert.equal(row.value, 8);assert.equal(row.complete, true);
});

for (const [name, mutate] of [
  ['materialization shortened after capture', values => mutateIntervalRow(values, 'raw-inspection-read', row => {row.receivedBytes--;})],
  ['opaque terminal for complete parse', values => mutateIntervalRow(values, 'raw-inspection-end', row => {row.outcome = 'opaque';})],
  ['reused begin identity', values => mutateIntervalRow(values, 'raw-inspection-begin', row => {row.inspectionId = 0;})],
  ['forged active endpoint', values => {values.at(-1).activeInspections = 1;}],
  ['forged inspection serial endpoint', values => {values.at(-1).inspectionSerial++;}],
  ['foreign token on generic read', values => mutateIntervalRow(values, 'raw-read', row => {delete row.inspectionId;})],
  ['generic Blob source length differs from retained source', values => mutateIntervalRow(values, 'raw-read', row => {row.sourceBytes++;row.complete = false;})],
  ['generic stream body length differs from actual input', values => mutateIntervalRow(values, 'raw-read', row => {row.operation = 'stream-read';row.sourceBytes++;row.complete = false;})],
  ['legacy schema capture relabeled current', values => {values.at(-1).schemaVersion = 1;}],
]) test('retained inspection replay rejects ' + name, () => {
  const values = completeInterval();mutate(values);const result = deriveCompositionMeasurements(values);assert(!inspectionMetric(result)?.complete);
});

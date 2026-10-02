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
  observer.parsed(12, { state: 'malformed', issues: [{ code: 'INVALID_JSON' }] }, source(12));
  first.resize({ cpuBytes: 50 }); second.release(); first.release();
  const result = deriveCompositionMeasurements([before, snapshot(observer)]);
  assert.equal(result.measurements.find(row => row.name === 'R38TextCaptionWorkspaceBytes').value, 100);
  assert.equal(result.measurements.find(row => row.name === 'R38MaterializedRawInspectionBytes').value, 90);
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
  observer.page(source(17), 0, 17); lease.release();
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
  const before = snapshot(observer), raw = ledger.reserve({ owner: 'composition-raw-copy', kind: 'prompt', cpuBytes: 10 });
  observer.parsed(10, { state: 'supported', issues: [], value: {} }, source(10));
  observer.page(source(10), 0, 10); raw.release(); const after = snapshot(observer); held.release();
  assert(deriveCompositionMeasurements([before, after]).measurements.every(row => row.complete));
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

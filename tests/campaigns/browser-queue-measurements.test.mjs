import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectedDraftMeasurement } from '../../tooling/qualification/campaigns/browser-queue-measurements.mjs';

const cell = { operation: 'queue.fault', parameters: { scenario: 'disk-full-admission' }, requiredMeasurements: [{ name: 'R25RejectedDraftLossCount', budgetId: 'R25', unit: 'violations' }] };
const hash = letter => 'sha256:' + letter.repeat(64);
function proof() {
  const record = { draftId: 'draft_1', generation: '2', assetId: 'asset_1', blob: { hash: hash('a'), byteLength: '500', mediaType: 'application/json' }, rawHash: hash('a'), state: { kind: 'complete-saved-ui-sha256-1', complete: true, hash: hash('b'), byteLength: '800', visiblePrompt: { hash: hash('c'), byteLength: '40', characters: 40 } } };
  return { kind: 'rejected-draft-preservation-1', receipt: { commandId: 'command_1', reviewId: 'review_1', status: 'rejected', code: 'CAPACITY', reason: 'QUEUE_METADATA_ADMISSION', enqueueCommands: 1, valid: true }, before: record, after: structuredClone(record), comparison: { completeSavedUI: true, actualDraftText: true, visiblePrompt: true, equal: true } };
}
test('exact private comparison and digest proof emits only the requested R25 row', () => {
  const result = rejectedDraftMeasurement({ cell, proof: proof() });
  assert.equal(result.measurement.name, 'R25RejectedDraftLossCount'); assert.equal(result.measurement.unit, 'violations'); assert.equal(result.measurement.value, 0);
  assert.equal(result.measurement.evidence[0].before.state.complete, true);
});
test('missing after-byte verification, partial projection, changed prompt and extra authored content cannot manufacture zero loss', () => {
  for (const mutate of [
    p => { p.after.rawHash = hash('f'); }, p => { p.before.rawHash = hash('f'); },
    p => { p.after.state.visiblePrompt.hash = hash('f'); }, p => { p.after.state.hash = hash('f'); },
    p => { p.before.state.complete = p.after.state.complete = false; },
    p => { p.comparison.actualDraftText = false; }, p => { p.receipt.reason = 'LOCAL_QUEUE_CEILING'; },
    p => { p.before.state.prompt = p.after.state.prompt = 'Must never be exported'; },
    p => { p.before.blob.caption = p.after.blob.caption = 'Must never be exported'; },
    p => { p.receipt.rawBody = 'Must never be exported'; }, p => { p.receipt.enqueueCommands = 2; },
  ]) { const value = proof(); mutate(value); const result = rejectedDraftMeasurement({ cell, proof: value }); assert.equal(result.measurement, undefined); assert.equal(typeof result.reason, 'string'); }
});
test('unrelated specimens and mismatched or duplicate registry rows remain unavailable', () => {
  for (const changed of [
    { ...cell, operation: 'fast.workflow' }, { ...cell, parameters: { scenario: 'healthy-polling' } },
    { ...cell, requiredMeasurements: [] }, { ...cell, requiredMeasurements: [cell.requiredMeasurements[0], cell.requiredMeasurements[0]] },
    { ...cell, requiredMeasurements: [{ ...cell.requiredMeasurements[0], unit: 'bytes' }] },
    { ...cell, requiredMeasurements: [{ ...cell.requiredMeasurements[0], budgetId: 'R24' }] },
  ]) assert.equal(rejectedDraftMeasurement({ cell: changed, proof: proof() }).measurement, undefined);
});

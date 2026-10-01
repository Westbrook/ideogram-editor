import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeActiveEvidence } from '../../tooling/qualification/campaigns/raster-active-compute.mjs';
import { rasterPhaseEvidence } from '../../tooling/qualification/campaigns/backend-raster-state.mjs';

function specimen({ width = 128, height = 128, layerCount = 2, intervalCount } = {}) {
  const expected = { width, height, layerCount }, tiles = Math.ceil(width / 128) * Math.ceil(height / 128), multiple = layerCount > 1;
  const operations = { accumulator: multiple ? tiles : 0, contribution: tiles * layerCount, fold: multiple ? tiles * layerCount : 0, finish: multiple ? tiles : 0, preserve: 0, resample: 0, matte: 0, 'coverage-scan': 0 };
  intervalCount ??= Object.values(operations).reduce((sum, value) => sum + value, 0);
  const context = { commandId: 'command', transactionId: 'transaction', outputAssetId: 'result' };
  const activeCompute = { schemaVersion: 1, kind: 'raster-active-compute-1', lane: 'raster-worker', clockOriginUnixMs: 10000.25, clockUncertaintyMs: null, context,
    boundary: 'synchronous-kernel-elapsed-excluding-io', outcome: 'completed', complete: true, invalid: 0,
    startedMs: 10, endedMs: 10 + (intervalCount - 1) * 2 + 1, unionMs: intervalCount, totalMs: intervalCount, intervalCount,
    intervals: Array.from({ length: Math.min(128, intervalCount) }, (_, index) => ({ startMs: 10 + index * 2, endMs: 11 + index * 2 })), omittedIntervals: Math.max(0, intervalCount - 128), operations };
  const wall = { phase: 'raster.composite', startedMs: 1, endedMs: activeCompute.endedMs + 1000, durationMs: activeCompute.endedMs + 999, outcome: 'ok', context: { ...context, width, height, count: layerCount, boundary: 'observed' } };
  const snapshot = { schemaVersion: 1, lane: 'raster-worker', clockOriginUnixMs: 10000, clockUncertaintyMs: null, invalid: 0, dropped: 0, records: [wall], activeCompute };
  return { snapshot, wall, expected };
}

test('R10 uses exact synchronous union and retains a separate IO/yield wall diagnostic', () => {
  const { snapshot, wall, expected } = specimen(), missing = [], observations = {};
  const phases = rasterPhaseEvidence({ rasters: { workerPhases: [snapshot] } }, 'command', 'raster.composite', observations, missing, expected);
  assert.deepEqual(missing, []);
  assert.deepEqual(phases.map(phase => phase.name), ['raster.composite.wall', 'raster.composite']);
  assert.equal(phases[0].durationMs, wall.durationMs);
  assert.equal(phases[1].durationMs, 6);
  assert.equal(phases[1].startMs, undefined, 'A disjoint union has no fabricated contiguous start/end span');
  assert.equal(phases[1].endMs, undefined);
  assert.deepEqual(phases[1].evidence.envelope, { startMs: 10, endMs: 21 });
  assert.equal(observations.activeCompute, snapshot.activeCompute);
});

test('diagnostic interval truncation keeps the full scalar and all exact kernel counts', () => {
  const { snapshot, wall, expected } = specimen({ width: 2048, height: 2048, layerCount: 5 });
  const result = compositeActiveEvidence(snapshot, wall, expected);
  // 256 accumulator + 1280 contribution + 1280 fold + 256 finish intervals.
  assert.deepEqual(result.missing, []); assert.equal(result.phase.durationMs, 3072);
  assert.equal(result.phase.evidence.retainedIntervals, 128);
  assert.equal(result.phase.evidence.omittedIntervals, 2944);
  assert.equal(result.phase.evidence.operations.contribution, 1280);
  assert.equal(result.phase.evidence.operations.fold, 1280);
});

test('singleton compositions require their actual contribution-only kernel inventory', () => {
  const { snapshot, wall, expected } = specimen({ width: 257, height: 128, layerCount: 1 });
  assert.equal(compositeActiveEvidence(snapshot, wall, expected).phase.durationMs, 3);
  snapshot.activeCompute.operations.fold = 3;
  assert.equal(compositeActiveEvidence(snapshot, wall, expected).phase, null);
});

test('malformed, incomplete, wrong-command and unrelated kernel evidence never supplies R10', () => {
  for (const mutate of [
    value => { delete value.snapshot.activeCompute; },
    value => { value.snapshot.activeCompute.complete = false; },
    value => { value.snapshot.activeCompute.outcome = 'failed'; },
    value => { value.snapshot.activeCompute.invalid = 1; },
    value => { value.snapshot.activeCompute.context = { ...value.snapshot.activeCompute.context, commandId: 'other' }; },
    value => { value.snapshot.activeCompute.context = { ...value.snapshot.activeCompute.context, outputAssetId: 'other' }; },
    value => { value.snapshot.activeCompute.operations.contribution = 0; },
    value => { value.snapshot.activeCompute.operations.resample = 1; },
    value => { value.snapshot.activeCompute.operations.extra = 1; },
    value => { value.expected.width = 256; },
    value => { value.snapshot.activeCompute.intervalCount = 2; },
    value => { value.snapshot.activeCompute.omittedIntervals = 1; },
    value => { value.snapshot.activeCompute.intervals[1].startMs = 10; },
    value => { value.snapshot.activeCompute.intervals[1].endMs = Infinity; },
    value => { value.snapshot.activeCompute.intervals[1] = null; },
    value => { value.snapshot.activeCompute.totalMs += 1; },
    value => { value.snapshot.activeCompute.unionMs = value.snapshot.activeCompute.totalMs = 5; },
    value => { value.snapshot.activeCompute.endedMs = value.wall.endedMs + 1; },
    value => { value.snapshot.dropped = 1; },
  ]) {
    const value = specimen(); mutate(value);
    const result = compositeActiveEvidence(value.snapshot, value.wall, value.expected);
    assert.equal(result.phase, null); assert(result.missing.length > 0);
  }
});

test('absent active union cannot turn an over-budget wall parent into a compute ceiling failure', () => {
  const { snapshot, expected } = specimen(); delete snapshot.activeCompute;
  const missing = [], phases = rasterPhaseEvidence({ rasters: { workerPhases: [snapshot] } }, 'command', 'raster.composite', {}, missing, expected);
  assert.deepEqual(phases.map(phase => phase.name), ['raster.composite.wall']);
  assert(phases[0].durationMs > 400); assert(missing.length > 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainDiagnosticEvidence, diagnosticContext, diagnosticPhase, detachedRasterPhase } from '../../tooling/qualification/campaigns/diagnostic-evidence.mjs';

test('retains complete diagnostic bytes with a distinct immutable proof and no returned raw graph', async t => {
  const output = await mkdtemp(join(tmpdir(), 'diagnostic-evidence-')); t.after(() => rm(output, { recursive: true, force: true }));
  let live = true;
  const source = { records: [{ phase: 'raster.decode', durationMs: 12 }], get scopeWitness() { assert(live); return 'read-live-during-serialization'; } };
  const first = await retainDiagnosticEvidence(output, 'read', source);
  live = false;
  const bytes = await readFile(first.artifact.path);
  assert.equal(bytes.length, first.artifact.bytes);
  assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), first.artifact.sha256);
  assert.deepEqual(JSON.parse(bytes), { records: source.records, scopeWitness: 'read-live-during-serialization' });
  assert.deepEqual(Object.keys(first).sort(), ['artifact', 'kind']);
  const next = await retainDiagnosticEvidence(output, 'read', { changed: true });
  assert.notEqual(next.artifact.path, first.artifact.path);
  assert.deepEqual(await readFile(first.artifact.path), bytes);
});

test('thin phase context admits only fixed primitive fields and never calls arbitrary getters', () => {
  const context = { commandId: 'c1', count: 3, nested: { retained: true }, width: { invalid: true }, unknown: 'private' };
  Object.defineProperty(context, 'revision', { enumerable: true, get() { throw Error('getter must not execute'); } });
  const row = diagnosticPhase({ sequence: 1, phase: 'command.accept', startedMs: 1, endedMs: 2, durationMs: 1, outcome: 'ok', context });
  assert.deepEqual(row.context, { commandId: 'c1', count: 3 });
  context.commandId = 'c2'; context.count = 8;
  assert.equal(row.context.commandId, 'c1'); assert.equal(row.context.count, 3);
  assert.deepEqual(diagnosticContext({ commandId: 'x'.repeat(129), bytes: Infinity }), {});
  assert.equal(diagnosticPhase({ phase: { invalid: true } }).phase, undefined);
});

test('active compute phase summary keeps scalar evidence and no original context or operation object', () => {
  const source = { name: 'raster.composite', durationMs: 4, outcome: 'completed', clock: 'raster-worker', context: { commandId: 'c' }, aggregation: 'nonoverlapping-active-union', evidence: { kind: 'raster-active-compute-1', sha256: 'sha256:' + '1'.repeat(64), intervalCount: 2, retainedIntervals: 2, omittedIntervals: 0, operations: { accumulator: 1, contribution: 2, fold: 2, finish: 1, preserve: 0, resample: 0, matte: 0, 'coverage-scan': 0 }, envelope: { startMs: 1, endMs: 8 }, timing: 'actual elapsed' } };
  const result = detachedRasterPhase(source);
  assert.notEqual(result.context, source.context); assert.notEqual(result.evidence.operations, source.evidence.operations); assert.notEqual(result.evidence.envelope, source.evidence.envelope);
  source.context.commandId = 'changed'; source.evidence.operations.fold = 100; source.evidence.envelope.endMs = 100;
  assert.equal(result.context.commandId, 'c'); assert.equal(result.evidence.operations.fold, 2); assert.equal(result.evidence.envelope.endMs, 8);
  assert.equal(detachedRasterPhase({ name: { invalid: true }, evidence: { operations: { fold: { invalid: true } } } }).evidence.operations.fold, undefined);
});

test('unsafe evidence destinations fail before serializing raw diagnostic input', async () => {
  let touched = false; const value = { toJSON() { touched = true; return {}; } };
  await assert.rejects(retainDiagnosticEvidence('relative', 'read', value), /DESTINATION/);
  await assert.rejects(retainDiagnosticEvidence(tmpdir(), '../escape', value), /DESTINATION/);
  assert.equal(touched, false);
});

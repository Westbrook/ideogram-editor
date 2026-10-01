import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { identifyRasterStateCell, selectRasterSpecimen, rasterPhaseEvidence, readSnapshot, runCell, rasterStateOperations } from '../../tooling/qualification/campaigns/backend-raster-state.mjs';

const cell = (operation, parameters = {}, workload = 'W1') => ({ id: workload + '/' + operation, operation, workload, parameters });
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

test('all eight explicit raster/state operations reject unknown/scaled workload substitutions', () => {
  assert.equal(new Set(rasterStateOperations).size, 8);
  assert.throws(() => identifyRasterStateCell(cell('raster.fake')), { code: 'CELL_UNSUPPORTED' });
  assert.throws(() => identifyRasterStateCell(cell('raster.composite', {}, 'W0')), { code: 'FIXTURE_REQUIRED' });
  assert.throws(() => identifyRasterStateCell(cell('raster.decode', { format: 'png', width: 1, height: 1 }, 'WNarrow')));
  assert.equal(identifyRasterStateCell(cell('raster.decode', { format: 'png', width: 8192, height: 3000 }, 'WNarrow')).specification.width, 8192);
});

test('named persistence and replay cells preserve independent exact workload requirements', () => {
  assert.throws(() => identifyRasterStateCell(cell('asset.persist', { bytes: 1024, incompressible: true })));
  assert.throws(() => identifyRasterStateCell(cell('asset.persist', { bytes: 8388608, incompressible: false })));
  assert.equal(identifyRasterStateCell(cell('asset.persist', { bytes: 33554432, incompressible: true }, 'W2')).bytes, 33554432);
  assert.throws(() => identifyRasterStateCell(cell('state.replay', { mode: 'snapshot-tail', tailEvents: 499 })));
  assert.throws(() => identifyRasterStateCell(cell('state.replay', { mode: 'full', events: 100000, snapshot: false })));
  assert.equal(identifyRasterStateCell(cell('state.replay', { mode: 'full', events: 100000, snapshot: false }, 'W2')).mode, 'full');
});

test('decode and encode require exact admitted formats and JPEG quality', () => {
  assert.throws(() => identifyRasterStateCell(cell('raster.decode', { format: 'webp' })));
  assert.throws(() => identifyRasterStateCell(cell('raster.encode', { format: 'jpeg', quality: .8 })));
  assert.equal(identifyRasterStateCell(cell('raster.encode', { format: 'jpeg', quality: .9 })).quality, .9);
});

test('specimen selection uses actual matching corpus identity, shape and WebP codec without fallback', () => {
  const fixture = { root: '/sealed/root', corpus: { files: [
    { role: 'raster-original', format: 'png', width: 2048, height: 2048, path: 'checker.png', sha256: 'sha256:' + 'a'.repeat(64), byteLength: '100' },
    { role: 'raster-codec', format: 'webp', codec: 'lossy', width: 2048, height: 2048, path: '/sealed/corpus/alpha.webp', sha256: 'sha256:' + 'b'.repeat(64), byteLength: '200' },
  ] } };
  assert.equal(selectRasterSpecimen({ fixture }, cell('raster.decode', { format: 'png' })).path, '/sealed/root/checker.png');
  assert.equal(selectRasterSpecimen({ fixture }, cell('raster.decode', { format: 'webp', codec: 'lossy' })).path, '/sealed/corpus/alpha.webp');
  assert.throws(() => selectRasterSpecimen({ fixture }, cell('raster.decode', { format: 'jpeg' })), { code: 'FIXTURE_REQUIRED' });
  assert.throws(() => selectRasterSpecimen({ fixture }, cell('raster.decode', { format: 'webp', codec: 'lossless' })), { code: 'FIXTURE_REQUIRED' });
  assert.throws(() => selectRasterSpecimen({ fixture }, cell('raster.decode', { format: 'png' }, 'W2')), { code: 'FIXTURE_REQUIRED' });
});

function trace(commandId, overrides = {}) {
  return { schemaVersion: 1, lane: 'raster-worker', clockOriginUnixMs: 1234, invalid: 0, dropped: 0, records: [{ phase: 'raster.decode', startedMs: 10, endedMs: 30, durationMs: 20, outcome: 'ok', context: { commandId, boundary: 'decoded' } }], ...overrides };
}

test('phase extraction uses only exact-command worker clocks and retains full trace separately', () => {
  const observations = {}, missing = [], snapshots = [trace('older'), trace('current')];
  const rows = rasterPhaseEvidence({ rasters: { workerPhases: snapshots } }, 'current', 'raster.decode', observations, missing);
  assert.equal(rows.length, 1); assert.equal(rows[0].durationMs, 20); assert.equal(rows[0].clock, 'raster-worker');
  assert.deepEqual(missing, []); assert.deepEqual(observations.workerTelemetry, [snapshots[1]]);
});

for (const [name, snapshots] of [
  ['missing command', [trace('older')]], ['duplicate exact command', [trace('current'), trace('current')]],
  ['invalid clock', [trace('current', { invalid: 1 })]], ['dropped trace', [trace('current', { dropped: 1 })]],
]) test('phase evidence stays inconclusive with ' + name, () => {
  const missing = []; rasterPhaseEvidence({ rasters: { workerPhases: snapshots } }, 'current', 'raster.decode', {}, missing); assert(missing.length);
});

function snapshotWriter(bytes, overrides = {}) {
  const calls = [], content = { handle: 'snapshot_handle', blob: { hash: hash(bytes), byteLength: String(bytes.length), mediaType: 'application/x-ndjson' }, recordCount: String(bytes.toString().split('\n').filter(Boolean).length), ...overrides };
  return { calls, snapshotContent: async id => { calls.push(['open', id]); return content; }, content: async (handle, offset, length) => { calls.push(['content', handle, offset, length]); return bytes.subarray(Number(offset), Number(offset) + Math.min(length, 7)); }, dropContent: async handle => { calls.push(['drop', handle]); } };
}

test('snapshot read consumes and hashes bounded real byte chunks and releases its handle', async () => {
  const bytes = Buffer.from('{"kind":"header","entityCount":"0"}\n'), writer = snapshotWriter(bytes), actual = await readSnapshot(writer, 'snapshot_1');
  assert.equal(actual.hash, hash(bytes)); assert.equal(actual.rows, 1); assert.equal(actual.bytes, bytes.length);
  assert(writer.calls.filter(row => row[0] === 'content').length > 1); assert.deepEqual(writer.calls.at(-1), ['drop', 'snapshot_handle']);
});

test('snapshot hash/count/truncation failures release the handle and never pass', async () => {
  const bytes = Buffer.from('{"kind":"header"}\n');
  for (const overrides of [{ recordCount: '2' }, { blob: { hash: 'sha256:' + '0'.repeat(64), byteLength: String(bytes.length) } }]) {
    const writer = snapshotWriter(bytes, overrides); await assert.rejects(readSnapshot(writer, 'snapshot_1')); assert.equal(writer.calls.at(-1)[0], 'drop');
  }
  const writer = snapshotWriter(Buffer.from('{"kind":"header"}')); await assert.rejects(readSnapshot(writer, 'snapshot_1')); assert.equal(writer.calls.at(-1)[0], 'drop');
});

test('warm identity lookup calls metadata API only and never reads or refetches content', async () => {
  const asset = { id: 'canonical', blob: { hash: 'sha256:' + 'a'.repeat(64) } }, calls = [];
  const f = { root: '/owned/root', documentId: 'document', writer: { epoch: '3', assetProjection: async id => { calls.push(id); return { asset, highWater: '10000' }; }, assetContent: () => { throw Error('Unexpected byte read'); }, assetVerify: () => { throw Error('Unexpected asset fetch'); } }, rasterState: { serial: 1, originalSeal: { sha256: 'sealed' }, compositeAssetId: asset.id, composite: asset } };
  const actual = await runCell({ productFixture: f, sample: { cache: 'warm' } }, cell('asset.cache-lookup'));
  assert.equal(actual.status, 'pass'); assert.deepEqual(calls, ['canonical']); assert.equal(actual.phases[0].name, 'asset.cache-lookup'); assert.equal(actual.observations.contentReadCalls, 0);
});

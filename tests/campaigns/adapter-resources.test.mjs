import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterResourceProjection, adapterReleaseWitness } from '../../tooling/qualification/campaigns/adapter-resources.mjs';

const categories = ['processTree', 'workerThreads', 'stagingBuffers', 'hashBuffers', 'headerBuffers', 'configBuffers', 'ioCopies', 'metadataConsumers', 'assetReadHandles', 'proofHandles', 'streamHandles'];
function observation() {
  const aggregate = { kind: 'adapter-process-owned-resources-1', shared: true, pid: process.pid, aggregateId: 'unit-aggregate',
    window: 0, peakScope: 'process-lifetime', integrityComplete: true, coverageComplete: true, sequence: 1, currentCpuBytes: 80, peakCpuBytes: 256 };
  return { kind: 'adapter-resource-observation-1', main: { pid: process.pid, threadId: 0, cpuBytes: 32, peakCpuBytes: 128, aggregate: structuredClone(aggregate) },
    worker: { ledger: { pid: process.pid, threadId: 7, cpuBytes: 64, peakCpuBytes: 256, aggregate: structuredClone(aggregate) } }, aggregate,
    coverage: { ...Object.fromEntries(categories.map(key => [key, true])), handles: true }, unusedHandles: 0 };
}

test('backend ownership projection retains observed CPU totals and high water separately from RSS and browser resources', () => {
  const source = observation(), result = adapterResourceProjection(source, 'exact-process-identity', 4096);
  assert.equal(result.cpuBytes, 80, 'Actual shared current can differ from the sum of serial realm snapshots'); assert.equal(result.cpuHighWaterBoundBytes, 384); assert.equal(result.backendRssBytes, 4096); assert.equal(result.unusedHandles, 0);
  assert.equal(result.resourceScope, 'wa-backend-process-workers-allocations-1'); assert.equal(result.processIdentity, 'exact-process-identity');
  assert.equal(result.backendOwnership.processIdentity, result.processIdentity); assert.equal(result.backendOwnership.evidence, null);
  assert(categories.every(key => result.backendOwnership.coverage[key] === true));
  for (const key of ['browserRssBytes', 'gpuBytes', 'previewCacheBytes', 'settledBytes', 'textureSide', 'deviceTextureLimit']) assert.equal(result[key], null);
  assert.equal(result.forcedGC, false);
});

test('missing or crossed process/thread bindings cannot expose unbound allocation or handle values', () => {
  for (const mutate of [
    value => { value.kind = 'unrelated'; }, value => { value.main.pid = process.pid + 1; },
    value => { value.worker.ledger.pid = process.pid + 1; }, value => { value.main.threadId = 1; },
    value => { value.worker.ledger.threadId = 0; }, value => { value.worker.ledger.threadId = 0.5; },
    value => { value.worker.ledger.threadId = '7'; }, value => { delete value.worker.ledger; },
  ]) {
    const value = observation(); mutate(value); const result = adapterResourceProjection(value, 'identity', 4096);
    assert.equal(result.cpuBytes, null); assert.equal(result.cpuHighWaterBoundBytes, null); assert.equal(result.unusedHandles, null);
    assert(categories.every(key => result.backendOwnership.coverage[key] === false)); assert.equal(result.backendRssBytes, 4096);
  }
  const missing = adapterResourceProjection(null, 'identity', 4096);
  assert.equal(missing.cpuBytes, null); assert.equal(missing.unusedHandles, null);
});

test('each named ownership coverage category stays independently unknown when its producer does not attest it', () => {
  for (const key of categories) {
    const value = observation(); delete value.coverage[key]; const result = adapterResourceProjection(value, 'identity', 1);
    assert.equal(result.backendOwnership.coverage[key], false);
    for (const other of categories.filter(category => category !== key)) assert.equal(result.backendOwnership.coverage[other], true);
  }
  const value = observation(); value.coverage.handles = false;
  assert.equal(adapterResourceProjection(value, 'identity', 1).unusedHandles, null, 'A counted zero is unavailable without complete handle ownership coverage');
  delete value.coverage;
  const missing = adapterResourceProjection(value, 'identity', 1);
  assert(categories.every(key => missing.backendOwnership.coverage[key] === false)); assert.equal(missing.unusedHandles, null);
});

test('invalid actual current values and unsafe diagnostic peak sums remain unavailable', () => {
  for (const invalid of [-1, 0.25, NaN, Infinity, undefined, null, '64', Number.MAX_SAFE_INTEGER + 1]) {
    const value = observation(); value.aggregate.currentCpuBytes = invalid; value.worker.ledger.peakCpuBytes = invalid; value.unusedHandles = invalid;
    const result = adapterResourceProjection(value, 'identity', invalid);
    assert.equal(result.cpuBytes, null); assert.equal(result.cpuHighWaterBoundBytes, null); assert.equal(result.unusedHandles, null); assert.equal(result.backendRssBytes, null);
  }
  const overflow = observation(); overflow.main.cpuBytes = Number.MAX_SAFE_INTEGER; overflow.worker.ledger.cpuBytes = 1;
  overflow.main.peakCpuBytes = Number.MAX_SAFE_INTEGER; overflow.worker.ledger.peakCpuBytes = 1;
  const result = adapterResourceProjection(overflow, 'identity', 1);
  assert.equal(result.cpuBytes, 80, 'Unsafe serial sums cannot replace the independent simultaneous aggregate'); assert.equal(result.cpuHighWaterBoundBytes, null);
});

test('current allocation requires the exact shared simultaneous process aggregate', () => {
  for (const mutate of [
    value => { delete value.aggregate; }, value => { value.aggregate.shared = false; },
    value => { value.aggregate.pid += 1; }, value => { value.aggregate.integrityComplete = false; },
    value => { value.aggregate.window = 1; }, value => { value.aggregate.peakScope = 'realm-local'; },
    value => { value.aggregate.sequence = -1; }, value => { value.aggregate.aggregateId = ''; },
    value => { value.main.aggregate.aggregateId = 'another-shared-aggregate'; },
    value => { value.worker.ledger.aggregate.aggregateId = 'another-shared-aggregate'; },
  ]) {
    const value = observation(); mutate(value); const result = adapterResourceProjection(value, 'identity', 1);
    assert.equal(result.cpuBytes, null); assert.equal(result.cpuHighWaterBoundBytes, 384);
  }
});

test('known unused handles are preserved as failures for downstream limits rather than relabeled active or zero', () => {
  const value = observation(); value.unusedHandles = 3;
  assert.equal(adapterResourceProjection(value, 'identity', 1).unusedHandles, 3);
  value.unusedHandles = 0; value.worker.ledger.activeHandles = 7;
  assert.equal(adapterResourceProjection(value, 'identity', 1).unusedHandles, 0, 'Owned active handles are not automatically unused handles');
});

function releasedSample() {
  return { ...adapterResourceProjection(observation(), 'same-process', 4096),
    observation: { startMs: 30, endMs: 35 },
    campaignConsumers: { scopedSelectionReaders: 0, retainedOracleReaders: { openFiles: 0, openDatabases: 0, pendingObservation: false, ownedReadersReleased: true } } };
}
const release = resources => adapterReleaseWitness({ startMs: 10, scopedEndMs: 20, acquired: [{ acquiredMs: 1, assetId: 'actual-draft-asset', handleIdentity: 'sha256:' + '1'.repeat(64) }], resources, processIdentity: 'same-process' });

test('release duration ends at the actual complete zero-owner observation, preserving scoped duration separately', () => {
  const sample = releasedSample(), witness = release(sample);
  assert.equal(witness.durationMs, 25); assert.equal(witness.scopedSelectionReaderDurationMs, 10);
  assert.equal(witness.completeOwnerCoverage, true); assert.equal(witness.resourceObservation, sample);
  assert.equal(witness.endMs, 35); assert.equal(witness.remainingOwnedSelectionReaders, 0);
});

test('a local release cannot supply a scored duration for an unknown, crossed or still-active owner inventory', () => {
  for (const mutate of [
    value => { value.processIdentity = 'other'; }, value => { value.backendOwnership.processIdentity = 'other'; },
    value => { value.unusedHandles = null; }, value => { value.unusedHandles = 1; },
    value => { value.cpuBytes = null; }, value => { value.backendRssBytes = null; },
    value => { value.backendOwnership.coverage.metadataConsumers = false; },
    value => { value.campaignConsumers.scopedSelectionReaders = 1; },
    value => { value.campaignConsumers.retainedOracleReaders.openFiles = 1; },
    value => { value.campaignConsumers.retainedOracleReaders.openDatabases = 1; },
    value => { value.campaignConsumers.retainedOracleReaders.pendingObservation = true; },
    value => { delete value.campaignConsumers.retainedOracleReaders.ownedReadersReleased; },
    value => { value.observation.startMs = 15; }, value => { value.observation.endMs = 25; },
  ]) {
    const sample = releasedSample(); mutate(sample); const witness = release(sample);
    assert.equal(witness.durationMs, null); assert.equal(witness.completeOwnerCoverage, false);
    assert.equal(witness.scopedSelectionReaderDurationMs, 10);
  }
  const witness = adapterReleaseWitness({ startMs: 10, scopedEndMs: 20, acquired: [], resources: releasedSample(), processIdentity: 'same-process' });
  assert.equal(witness.completeOwnerCoverage, true); assert.equal(witness.durationMs, null, 'No acquired adapter reader means no measured adapter reader release');
});

test('a release duration requires actual prior distinct acquisition identities', () => {
  for (const acquired of [[], [null], [{ acquiredMs: 11, assetId: 'asset', handleIdentity: 'sha256:' + '1'.repeat(64) }],
    [{ acquiredMs: 1, assetId: 'asset', handleIdentity: 'unsealed-handle' }],
    Array.from({ length: 2 }, () => ({ acquiredMs: 1, assetId: 'asset', handleIdentity: 'sha256:' + '1'.repeat(64) }))]) {
    const witness = adapterReleaseWitness({ startMs: 10, scopedEndMs: 20, acquired, resources: releasedSample(), processIdentity: 'same-process' });
    assert.equal(witness.acquisitionComplete, false); assert.equal(witness.durationMs, null);
  }
});

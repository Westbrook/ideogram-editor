import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyAdapterResourceSampling } from '../../tooling/qualification/campaigns/adapter-resource-sampling-verification.mjs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest, sanitize} from '../../tooling/qualification/campaigns/common.mjs';
import {evaluateRequiredMeasurements} from '../../tooling/qualification/campaigns/run.mjs';
import {retainAdapterImportObservation, verifyAdapterImportObservation, verifiedAdapterImportMeasurements} from '../../tooling/qualification/campaigns/adapter-import-observation.mjs';

const processIdentity = JSON.stringify({ pid: 4207, startedAt: 'unit-process-start', writerEpoch: '1', root: '/unit/private-root' });
const categories = ['processTree', 'workerThreads', 'stagingBuffers', 'hashBuffers', 'headerBuffers', 'configBuffers', 'ioCopies', 'metadataConsumers', 'assetReadHandles', 'proofHandles', 'streamHandles'];
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
const contract = 'backend-adapter-owned-resources-1';
function ownerInventory() {
  return {
    assets: { chunkLeases: 0, runningPreparations: 0, preparationPromises: 0, contentReaders: 0, recoveryCursors: 0, pausedPreparations: 0 },
    objects: { stages: 0, slots: 0, proofReservations: 0, retainedProofs: 0, proofReaders: 0, proofWaiters: 0, proofWaitTimer: false, repairs: 0, repairReads: 0 },
    recovery: { readers: 0, maintenance: false, maintenanceReaders: 0 }, history: { running: false, authorities: 0, paused: 0,
      encodedReviewProofs: { leases: 0, proofs: 0, metadataBytes: 0 }, encodedAcceptances: 0 }, portable: { running: false, readers: 0, authorities: 0, paused: 0 },
    raster: { running: false, documentBusy: false, activeWorkers: 0, bookedCPUBytes: 0, approvalAuthorities: 0,
      compositionMemory: { loans: 0, loanBytes: 0, borrowers: 0, borrowedBytes: 0, contentReaders: 0,
        loanFamilies: { composition: 0, storageRead: 0, storageRegistry: 0 } },
      workerService: { generation: 0, identity: null, activeJobs: 0, slot: null, workerCount: 0, idleWorkers: 0, restarting: false,
        retainedJobReferences: 0, closed: false, nativeAllocatorReleaseClaim: false, completedJobs: 0, lastCompleted: null } },
    text: { verifying: false, bookedCPUBytes: 0, readyLoans: 0, browserAdmissions: 0, browserAdmissionInventoryObserved: true },
    display: { leases: 0, building: 0, cacheEntries: 0 }, candidates: { transfers: 0 },
    queue: { preparing: 0, inputStreams: 0, inputStreamsObserved: true, transportEvidenceObserved: false },
    provider: { disabled: true, pending: false, timer: false, dispatcher: false, resultObserver: false, transportHandlesObserved: true },
    activeMethods: [], unknown: [], quiescence: { kind: 'point-in-time-owner-inventory', complete: true, intervalWitness: false,
      witnesses: Object.fromEntries(['objects', 'recovery', 'history', 'portable', 'raster', 'text', 'display', 'candidates', 'queue', 'provider'].map(key => [key, true])) },
    residencyExcludedFromCPU: ['engine-private-V8-objects-and-strings', 'native-hash-state', 'native-ipc-queue', 'idle-native-allocator-residency'], residencyMetric: 'process-tree-RSS',
  };
}
function fixture({ current = [0, 32, 64, 0], continuous = [0, 128, 256, 256] } = {}) {
  const header = { kind: 'wa-backend-resource-stream-1', processIdentity, intervalMs: 100, startMs: 0,
    allocationSource: 'Unit-only producer records; no qualification claim.' };
  const records = [], peaks = { backendRssBytes: null, cpuBytes: null }, peakSamples = {};
  let allocationPeak = null, ordinal = 0;
  for (const [index, kind] of ['initial', 'manual', 'scheduled', 'final'].entries()) {
    const aggregate = { kind: 'adapter-process-owned-resources-1', shared: true, aggregateId: '4207:unit-shared-identity', pid: 4207,
      window: 0, peakScope: 'process-lifetime', sequence: index + 1, currentCpuBytes: current[index], peakCpuBytes: continuous[index],
      activeParticipants: 2, reservedParticipants: 0, droppedTransitions: 0, integrityComplete: true, coverageComplete: false, lifecycleWindow: null,
      coverageWitness: { kind: 'uncovered-owner-transitions-1', contract, activationCount: 0, activeUncoveredOwners: 0 } };
    const ledger = threadId => ({ kind: 'adapter-owned-resources-1', instanceId: threadId ? 'unit-worker-instance' : 'unit-main-instance',
      pid: 4207, parentPid: 4200, threadId, isMainThread: threadId === 0, window: 0, sequence: index + 1,
      cpuBytes: current[index] === 0 ? 0 : threadId ? 40 : 20, peakCpuBytes: Math.floor(continuous[index] * (threadId ? 0.75 : 0.5)),
      backingBytes: current[index] === 0 ? 0 : threadId ? 40 : 20, peakBackingBytes: Math.floor(continuous[index] * (threadId ? 0.75 : 0.5)),
      reservedBytes: 0, peakReservedBytes: 0, backingStores: current[index] === 0 ? 0 : 1, activeLeases: (current[index] === 0 ? 0 : 1) + (threadId ? 0 : 1), returnedBuffers: 0,
      droppedTransitions: 0, unscopedReturnedBuffers: 0, aggregate: copy(aggregate),
      groups: [{ owner: 'unit-owner', kind: 'retained-allocation', buffers: current[index] === 0 ? 0 : 1, handles: 0, reservedBytes: 0 },
        ...(threadId ? [] : [{ owner: 'owned-worker', kind: 'writer', buffers: 0, handles: 1, reservedBytes: 0 }])],
      ownedWorkerThreads: threadId ? [] : [{ kind: 'writer', pid: 4207, threadId: 7, parentThreadId: 0 }], uncoveredOwners: [], uncoveredActivations: 0 });
    const sample = { resourceScope: 'wa-backend-process-workers-allocations-1', processIdentity,
      backendRssBytes: [100, 200, 300, 200][index], cpuBytes: current[index],
      cpuHighWaterBoundBytes: Math.floor(continuous[index] * 0.75) + Math.floor(continuous[index] * 0.5), unusedHandles: 0,
      browserRssBytes: null, gpuBytes: null, previewCacheBytes: null, settledBytes: null, textureSide: null, deviceTextureLimit: null,
      backendOwnership: { kind: 'wa-backend-owner-evidence-1', processIdentity,
        coverage: Object.fromEntries(categories.map(key => [key, true])), evidence: null },
      producer: { kind: 'adapter-resource-observation-1', main: ledger(0), worker: { ledger: ledger(7), writerEpoch: 'unit-epoch', owners: ownerInventory(), coverage: Object.fromEntries(categories.map(key => [key, true])) }, aggregate,
        coverage: { ...Object.fromEntries(categories.map(key => [key, true])), handles: true }, unusedHandles: 0,
        scope: { kind: 'backend-owned-process-and-threads', processes: [{ pid: 4207, parentPid: 4200 }], completeScopedOwnerSnapshot: true, intervalQuiescenceProven: false },
        handleClassification: { kind: 'scoped-handle-classification-1', complete: true, settled: true, serviceHandles: { main: 1, worker: 0 },
          activeOwners: { mainHandles: 0, responseBuffers: 0, workerMethods: 0, assetPreparations: 0, preparationPromises: 0, assetChunkLeases: 0, assetContentReaders: 0 }, retainedHandles: 0 } },
      forcedGC: false, ordinal: ++ordinal, kind, observation: { startMs: 10 + index * 100, endMs: 11 + index * 100 },
      campaignConsumers: { scopedSelectionReaders: 0, retainedOracleReaders: { openFiles: 0, openDatabases: 0 } } };
    records.push(sample);
    for (const key of Object.keys(peaks)) if (peaks[key] === null || sample[key] > peaks[key]) { peaks[key] = sample[key]; peakSamples[key] = sample; }
    if (!allocationPeak || aggregate.peakCpuBytes > allocationPeak.value) {
      allocationPeak = { kind: 'owned-allocation-continuous-peak-1', value: aggregate.peakCpuBytes,
        scope: 'fresh-worker-process-lifetime-including-preparation', processIdentity, sharedIdentity: aggregate.aggregateId,
        sequence: aggregate.sequence, observation: copy(sample.observation), artifact: null, complete: false };
      records.push({ kind: 'producer-peak', ordinal: ++ordinal, sourceOrdinal: sample.ordinal, allocationPeak });
    }
  }
  const footer = { kind: 'wa-backend-resource-summary-1', startMs: 0, endMs: 312, samples: ordinal, peaks,
    allocationPeaks: { cpuBytes: allocationPeak }, maxGapMs: 100, missing: [] };
  const sampling = { kind: 'attributed-backend-process-and-allocation-ledger', complete: true, processIdentity,
    intervalMs: 100, startMs: 0, endMs: 312, counts: { samples: ordinal }, maximumGapMs: 100,
    peaks: copy(peaks), peakSamples: copy(peakSamples), allocationPeaks: copy(footer.allocationPeaks), missing: [], forcedGC: false };
  const selectedSamples = [copy(records.find(value => value.kind === 'manual'))];
  selectedSamples[0].action = 'after-import'; selectedSamples[0].observedMs = 112;
  return seal({ lines: [header, ...records, footer], sampling, selectedSamples });
}
function seal(packet) {
  packet.rawBytes = Buffer.from(packet.lines.map(value => JSON.stringify(value)).join('\n') + '\n');
  const artifact = { path: '/retained/relocated-original-path/resources.jsonl', bytes: packet.rawBytes.length, sha256: hash(packet.rawBytes) };
  packet.sampling.artifact = artifact; packet.sampling.sha256 = artifact.sha256;
  for (const value of [...Object.values(packet.sampling.peakSamples), ...packet.selectedSamples]) value.backendOwnership.evidence = copy(artifact);
  for (const value of Object.values(packet.sampling.allocationPeaks ?? {})) value.artifact = copy(artifact);
  return packet;
}
const verify = packet => verifyAdapterResourceSampling(packet.rawBytes, packet.sampling, { processIdentity, selectedSamples: packet.selectedSamples });
const currents = packet => packet.lines.filter(value => value.resourceScope);
const frames = packet => packet.lines.filter(value => value.kind === 'producer-peak');
function scoredFixture({ covered = true } = {}) {
  const packet = fixture({ continuous: [512, 512, 512, 512] }), records = [], samples = currents(packet);
  let ordinal = 0, allocationPeak = null;
  for (const [index, sample] of samples.entries()) {
    sample.ordinal = ++ordinal;
    sample.windowBoundary = index === 1 ? 'begin' : index === 3 ? 'end' : null;
    sample.scored = index === 1 || index === 2;
    const window = index === 0 ? null : { id: '4207:unit-shared-identity:1', scope: 'independent-B0-lifecycle-window',
      boundaryClockSemantics: 'post-linearization-monotonic-observations',
      startMonotonicNs: '10000000000', endMonotonicNs: index === 3 ? '10200000000' : null,
      currentCpuBytes: sample.cpuBytes, peakCpuBytes: index === 1 ? 32 : 96, sequence: index, sealed: index === 3, integrityComplete: true,
      coverage: { contract, startActivationCount: 0, startActiveUncoveredOwners: 0, endActivationCount: index === 3 ? covered ? 0 : 1 : null,
        endActiveUncoveredOwners: index === 3 ? 0 : null, complete: covered && index === 3 } };
    for (const aggregate of [sample.producer.aggregate, sample.producer.main.aggregate, sample.producer.worker.ledger.aggregate]) {
      aggregate.lifecycleWindow = copy(window); aggregate.coverageComplete = covered && index === 3;
      aggregate.coverageWitness.activationCount = !covered && index >= 2 ? 1 : 0;
    }
    sample.producer.scope.intervalQuiescenceProven = covered && index === 3;
    records.push(sample);
    if (window) {
      allocationPeak = { kind: 'owned-allocation-continuous-peak-1', value: window.peakCpuBytes, scope: window.scope,
        processIdentity, sharedIdentity: sample.producer.aggregate.aggregateId, sequence: window.sequence, windowId: window.id, sourceOrdinal: sample.ordinal,
        window: { startMonotonicNs: window.startMonotonicNs, endMonotonicNs: window.endMonotonicNs, sealed: window.sealed, integrityComplete: true },
        observation: copy(sample.observation), artifact: null, complete: window.sealed && covered };
      records.push({ kind: 'producer-peak', ordinal: ++ordinal, sourceOrdinal: sample.ordinal, allocationPeak });
    }
  }
  const observationWindow = { id: '4207:unit-shared-identity:1', scope: 'independent-B0-lifecycle-window', processIdentity,
    startObservation: copy(samples[1].observation), endObservation: copy(samples[3].observation) };
  const footer = packet.lines.at(-1); footer.samples = ordinal; footer.allocationPeaks = { cpuBytes: allocationPeak }; footer.observationWindow = observationWindow;
  packet.lines = [packet.lines[0], ...records, footer]; packet.sampling.counts.samples = ordinal;
  packet.sampling.allocationPeaks = copy(footer.allocationPeaks); packet.sampling.observationWindow = copy(observationWindow);
  for (const key of Object.keys(packet.sampling.peakSamples)) packet.sampling.peakSamples[key] = copy(samples[2]);
  packet.selectedSamples = [{ ...copy(samples[1]), action: 'after-import', observedMs: 112 }];
  return seal(packet);
}
function refreshMembers(packet) {
  for (const [key, value] of Object.entries(packet.sampling.peakSamples)) packet.sampling.peakSamples[key] = copy(packet.lines.find(sample => sample.ordinal === value.ordinal));
  packet.selectedSamples = packet.selectedSamples.map(value => ({ ...copy(packet.lines.find(sample => sample.ordinal === value.ordinal)), action: value.action, observedMs: value.observedMs }));
  return seal(packet);
}
function activeOwnedWork(sample) {
  const producer = sample.producer;
  producer.main.groups.push({ owner: 'writer-sender', kind: 'pending-request', buffers: 0, handles: 1, reservedBytes: 0 }); producer.main.activeLeases++;
  producer.worker.owners.activeMethods = [{ method: 'assetChunk', count: 1 }];
  producer.worker.owners.assets.chunkLeases = 1;
  producer.worker.ledger.groups.push({ owner: 'writer-rpc', kind: 'scope', buffers: 0, handles: 1, reservedBytes: 0 }); producer.worker.ledger.activeLeases++;
  producer.coverage.handles = false; producer.scope.completeScopedOwnerSnapshot = false;
  producer.handleClassification.complete = false; producer.handleClassification.settled = false;
  producer.handleClassification.activeOwners.mainHandles = 1; producer.handleClassification.activeOwners.workerMethods = 1; producer.handleClassification.activeOwners.assetChunkLeases = 1;
  producer.handleClassification.retainedHandles = null; delete producer.unusedHandles; sample.unusedHandles = null;
}

test('pure verifier independently replays current and continuous peaks without reopening retained absolute paths', () => {
  const packet = fixture(), result = verify(packet);
  assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.complete, false); assert.deepEqual(result.failures, []);
  assert.deepEqual(result.missing, ['Continuous producer allocation peak coverage is incomplete.', 'An independent B0 lifecycle allocation window is unavailable; process-lifetime peaks are diagnostic only.']);
  assert.deepEqual(result.counts, { samples: 7, currentSamples: 4, producerPeaks: 3, selectedSamples: 1 });
  assert.deepEqual(result.recomputed.peaks, { backendRssBytes: 300, cpuBytes: 64 });
  assert.equal(result.recomputed.continuousCpuPeakBytes, 256); assert.equal(result.recomputed.allocationPeaks.cpuBytes.value, 256);
  assert.equal(result.recomputed.peakSamples.cpuBytes.kind, 'scheduled'); assert.equal(result.recomputed.peakSamples.cpuBytes.backendOwnership.evidence, null);
  assert.equal(result.samples[1].cpuBytes, 32, 'Serial realm totals 20 + 40 are not the actual simultaneous current observation');
  assert.equal(result.rawSamples.length, 7); assert.deepEqual(result.artifact, packet.sampling.artifact);
});

test('every actual scheduled/final sample contributes to maxima and equal maxima retain their first witness', () => {
  for (const mutate of [
    packet => { currents(packet)[2].backendRssBytes = 999; seal(packet); },
    packet => { currents(packet)[3].backendRssBytes = 999; seal(packet); },
    packet => { packet.sampling.peaks.cpuBytes = 0; },
    packet => { packet.lines.at(-1).peaks.cpuBytes = 0; seal(packet); },
    packet => { currents(packet)[3].backendRssBytes = 300; packet.sampling.peakSamples.backendRssBytes = copy(currents(packet)[3]); seal(packet); },
  ]) {
    const packet = fixture(); mutate(packet); assert.equal(verify(packet).status, 'FAIL');
  }
});

test('selected membership permits only exact artifact attachment and documented action/clock wrappers', () => {
  for (const mutate of [
    value => { value.unlistedField = true; }, value => { delete value.campaignConsumers; },
    value => { value.producer.main.groups[0].count = 0; }, value => { value.producer.main.extraEvidence = { ignored: true }; },
    value => { value.campaignConsumers.retainedOracleReaders.openFiles = 9; },
    value => { value.backendOwnership.coverage.proofHandles = false; },
    value => { value.observation.endMs += 1; }, value => { value.ordinal = 2; }, value => { value.processIdentity = 'another-process'; },
    value => { value.backendOwnership.evidence.path = '/other/same-digest.jsonl'; }, value => { value.backendOwnership.evidence.bytes += 1; },
    value => { value.backendOwnership.evidence = null; }, value => { value.action = 'invented-action'; },
    value => { value.observedMs = -1; }, value => { value.observedMs = 100; }, value => { value.observedMs = 999; },
  ]) {
    const packet = fixture(); mutate(packet.selectedSamples[0]); assert.equal(verify(packet).status, 'FAIL');
  }
  const packet = fixture(); packet.selectedSamples[0] = Object.fromEntries(Object.entries(packet.selectedSamples[0]).reverse());
  assert.deepEqual(verify(packet).failures, [], 'Object property order is not resource identity');
});

test('bytes, JSONL structure, clocks, ordinals and stable producer identities are independently fenced', () => {
  for (const mutate of [
    packet => { packet.rawBytes = Buffer.concat([packet.rawBytes, Buffer.from(' ')]); },
    packet => { packet.lines.splice(2, 0, copy(packet.lines[2])); seal(packet); },
    packet => { currents(packet)[1].ordinal = 99; seal(packet); },
    packet => { currents(packet)[1].observation.startMs = 0; seal(packet); },
    packet => { currents(packet)[1].observation.endMs = 999; seal(packet); },
    packet => { currents(packet)[1].producer.worker.ledger.instanceId = 'replaced-worker'; seal(packet); },
    packet => { currents(packet)[1].producer.main.window = 1; seal(packet); },
    packet => { currents(packet)[1].producer.aggregate.aggregateId = 'different-aggregate'; seal(packet); },
    packet => { packet.sampling.counts.samples -= 1; }, packet => { packet.sampling.maximumGapMs = 0; },
  ]) {
    const packet = fixture(); mutate(packet); assert.equal(verify(packet).status, 'FAIL');
  }
  const packet = fixture(); assert.equal(verifyAdapterResourceSampling(packet.rawBytes, packet.sampling, { processIdentity: 'wrong-process' }).status, 'FAIL');
});

test('continuous peak frames bind the immediately preceding aggregate and cannot masquerade as current samples', () => {
  for (const mutate of [
    packet => { frames(packet)[1].sourceOrdinal = 1; seal(packet); },
    packet => { frames(packet)[1].allocationPeak.value = 129; seal(packet); },
    packet => { frames(packet)[1].allocationPeak.sequence = 999; seal(packet); },
    packet => { frames(packet)[1].allocationPeak.observation.startMs += 1; seal(packet); },
    packet => { frames(packet)[1].allocationPeak.extra = 'unlisted'; seal(packet); },
    packet => { frames(packet)[1].allocationPeak.artifact = { sha256: hash('unrelated') }; seal(packet); },
    packet => { packet.sampling.allocationPeaks.cpuBytes.value = 64; },
    packet => { packet.sampling.allocationPeaks.cpuBytes.artifact.path = '/another/artifact'; },
    packet => { packet.sampling.peakSamples.cpuBytes = { ...copy(frames(packet)[2]), backendOwnership: { evidence: copy(packet.sampling.artifact) } }; },
    packet => { currents(packet)[3].producer.aggregate.peakCpuBytes = 128; seal(packet); },
  ]) {
    const packet = fixture(); mutate(packet); assert.equal(verify(packet).status, 'FAIL');
  }
});

test('unknown aggregate coverage, missing continuous frames and missing bytes remain inconclusive', () => {
  const coveredUnknown = verify(scoredFixture({ covered: false }));
  assert.equal(coveredUnknown.status, 'INCONCLUSIVE'); assert.equal(coveredUnknown.complete, false);
  assert(coveredUnknown.missing.some(reason => reason.includes('peak coverage')));
  const packet = fixture(); packet.lines = packet.lines.filter(line => line.kind !== 'producer-peak');
  let ordinal = 0; for (const value of currents(packet)) value.ordinal = ++ordinal;
  packet.lines.at(-1).samples = ordinal; delete packet.lines.at(-1).allocationPeaks;
  packet.sampling.counts.samples = ordinal; delete packet.sampling.allocationPeaks;
  for (const key of ['cpuBytes', 'backendRssBytes']) packet.sampling.peakSamples[key] = copy(currents(packet)[2]);
  packet.selectedSamples = []; seal(packet);
  assert.equal(verify(packet).status, 'INCONCLUSIVE');
  assert.equal(verifyAdapterResourceSampling(null, packet.sampling, { processIdentity }).status, 'INCONCLUSIVE');
});

test('invalid current numeric values and falsely complete producer frames fail independently of claimed receipt completeness', () => {
  for (const mutate of [
    packet => { currents(packet)[1].cpuBytes = -1; },
    packet => { currents(packet)[1].cpuBytes = 0.5; },
    packet => { currents(packet)[1].cpuBytes = Number.MAX_SAFE_INTEGER + 1; },
    packet => { currents(packet)[1].cpuBytes = 60; },
    packet => { currents(packet)[1].producer.aggregate.coverageComplete = true; },
    packet => { currents(packet)[1].producer.aggregate.peakCpuBytes = 1; },
  ]) {
    const packet = fixture(); mutate(packet); seal(packet); assert.equal(verify(packet).status, 'FAIL');
  }
  const packet = fixture({ current: [0, 0, 0, 0], continuous: [0, 0, 0, 0] }), result = verify(packet);
  assert.equal(result.status, 'INCONCLUSIVE'); assert.deepEqual(result.failures, []); assert.equal(result.recomputed.peaks.cpuBytes, 0); assert.equal(result.recomputed.peakSamples.cpuBytes.kind, 'initial');
  assert.equal(result.recomputed.allocationPeaks.cpuBytes.value, 0);
});

test('incomplete later coverage and contradictory nested producer evidence cannot hide behind a prior complete peak', () => {
  const incomplete = fixture(), final = currents(incomplete).at(-1);
  final.producer.aggregate.coverageComplete = false; final.producer.main.aggregate.coverageComplete = false; seal(incomplete);
  assert.equal(verify(incomplete).status, 'INCONCLUSIVE', 'Unknown later coverage remains unknown even without a new maximum');
  for (const mutate of [
    packet => { currents(packet)[1].producer.main.aggregate.peakCpuBytes = 999; },
    packet => { currents(packet)[1].producer.worker.ledger.aggregate.peakCpuBytes = 999; },
    packet => { currents(packet)[1].producer.worker.ledger.aggregate.sequence = 999; },
    packet => { currents(packet)[1].producer.worker.coverage.proofHandles = false; },
    packet => { packet.lines.at(-1).allocationPeaks = copy(packet.lines.at(-1).allocationPeaks); packet.lines.at(-1).allocationPeaks.cpuBytes.value = 999; delete packet.sampling.allocationPeaks; },
  ]) {
    const packet = fixture(); mutate(packet); seal(packet); assert.equal(verify(packet).status, 'FAIL');
  }
});

test('an independently opened and sealed B0 window excludes a larger preparation peak without resetting lifetime evidence', () => {
  const packet = scoredFixture(), result = verify(packet);
  assert.equal(result.status, 'PASS'); assert.equal(result.complete, true); assert.deepEqual(result.missing, []); assert.deepEqual(result.failures, []);
  assert.equal(result.recomputed.continuousCpuPeakBytes, 96); assert.equal(result.recomputed.lifetimeCpuPeakBytes, 512);
  assert.equal(result.recomputed.allocationPeaks.cpuBytes.value, 96); assert.equal(result.recomputed.allocationPeaks.cpuBytes.window.sealed, true);
  assert.equal(result.counts.producerPeaks, 3, 'Final unchanged peak gets its own actual sealing frame');
  currents(packet)[0].backendRssBytes = 999; currents(packet)[3].backendRssBytes = 999; seal(packet);
  const outside = verify(packet); assert.equal(outside.status, 'PASS'); assert.equal(outside.recomputed.peaks.backendRssBytes, 300,
    'Preparation and current allocations after the end RPC stay outside scored current maxima');
});

test('B0 window identifiers, monotonic producer bounds, runner RPC brackets and final seal cannot drift', () => {
  for (const mutate of [
    packet => { frames(packet)[0].allocationPeak.windowId = 'another-window'; },
    packet => { frames(packet)[0].allocationPeak.window.startMonotonicNs = '9999999999'; },
    packet => { frames(packet)[2].allocationPeak.complete = false; },
    packet => { packet.sampling.observationWindow.startObservation.endMs = 112; },
    packet => { packet.sampling.observationWindow.endObservation.endMs = 999; },
    packet => { packet.sampling.observationWindow.id = 'another-window'; },
    packet => { currents(packet)[0].scored = true; },
    packet => { currents(packet)[3].scored = true; },
    packet => { currents(packet)[1].windowBoundary = null; },
    packet => { currents(packet)[2].producer.worker.ledger.aggregate.lifecycleWindow.startMonotonicNs = '9999999999'; },
    packet => { packet.lines.at(-1).observationWindow = copy(packet.lines.at(-1).observationWindow); packet.lines.at(-1).observationWindow.processIdentity = 'another-process'; delete packet.sampling.observationWindow; },
    packet => { const sample = currents(packet)[2]; for (const aggregate of [sample.producer.aggregate, sample.producer.main.aggregate, sample.producer.worker.ledger.aggregate]) aggregate.lifecycleWindow.id = '4207:unit-shared-identity:2'; },
    packet => { const sample = currents(packet)[3]; for (const aggregate of [sample.producer.aggregate, sample.producer.main.aggregate, sample.producer.worker.ledger.aggregate]) aggregate.lifecycleWindow.endMonotonicNs = '1'; },
    packet => {
      const sample = currents(packet)[3]; for (const aggregate of [sample.producer.aggregate, sample.producer.main.aggregate, sample.producer.worker.ledger.aggregate]) aggregate.lifecycleWindow.endMonotonicNs = '10900000000';
      frames(packet)[2].allocationPeak.window.endMonotonicNs = '10900000000'; packet.sampling.allocationPeaks.cpuBytes.window.endMonotonicNs = '10900000000';
    },
    packet => {
      const sample = currents(packet)[3]; for (const aggregate of [sample.producer.aggregate, sample.producer.main.aggregate]) {
        aggregate.lifecycleWindow.currentCpuBytes = null; aggregate.lifecycleWindow.peakCpuBytes = 999;
      }
    },
  ]) {
    const packet = scoredFixture(); mutate(packet); seal(packet); assert.equal(verify(packet).status, 'FAIL');
  }
});

test('legitimate active adapter handles remain classified while continuous CPU coverage stays independent', () => {
  const packet = scoredFixture(); activeOwnedWork(currents(packet)[2]); refreshMembers(packet);
  const result = verify(packet);
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.failures, []); assert.deepEqual(result.missing, []);
  assert.equal(result.samples[2].unusedHandles, null); assert.equal(result.recomputed.allocationPeaks.cpuBytes.complete, true);
  const boundary = scoredFixture(); activeOwnedWork(currents(boundary)[1]); refreshMembers(boundary);
  const incomplete = verify(boundary);
  assert.equal(incomplete.status, 'INCONCLUSIVE'); assert.deepEqual(incomplete.failures, []);
  assert(incomplete.missing.includes('The independent lifecycle boundary has no complete settled handle classification.'));
});

test('owner summaries cannot conceal concrete active inventories, retained handles or unknown writers', () => {
  for (const mutate of [
    sample => { sample.producer.worker.owners.recovery.readers = 1; },
    sample => { sample.producer.worker.owners.provider.disabled = false; },
    sample => { sample.producer.worker.owners.assets.contentReaders = 1; },
    sample => { sample.producer.worker.owners.objects.proofReservations = 1; },
    sample => { sample.producer.worker.owners.quiescence.intervalWitness = true; },
    sample => { sample.producer.worker.owners.unknown = ['unlisted-owner']; },
    sample => { sample.producer.worker.coverage.handles = true; },
    sample => { sample.producer.main.ownedWorkerThreads[0].threadId = 9; },
    sample => { sample.producer.main.ownedWorkerThreads = []; },
    sample => { sample.producer.main.groups[1].handles = 0; },
    sample => { sample.producer.main.groups[0].buffers = 0; },
    sample => { sample.producer.main.returnedBuffers = 2; },
    sample => { sample.producer.scope.processes[0].parentPid = 99; },
    sample => { sample.producer.handleClassification.serviceHandles.main = 0; },
    sample => { sample.producer.handleClassification.retainedHandles = 9; },
    sample => { sample.producer.unusedHandles = 9; sample.unusedHandles = 9; },
  ]) {
    const packet = scoredFixture(); mutate(currents(packet)[2]); refreshMembers(packet);
    assert.equal(verify(packet).status, 'FAIL');
  }
  const packet = scoredFixture(); activeOwnedWork(currents(packet)[2]);
  currents(packet)[2].producer.unusedHandles = 0; currents(packet)[2].unusedHandles = 0; refreshMembers(packet);
  assert.equal(verify(packet).status, 'FAIL', 'An active owner cannot be converted into an invented unused zero');
});

test('retained handle counts come from actual worker handles and proof reservations', () => {
  const packet = scoredFixture(), sample = currents(packet)[2];
  sample.producer.worker.ledger.groups.push({ owner: 'objects', kind: 'retained-proof', buffers: 0, handles: 2, reservedBytes: 0 });
  sample.producer.worker.ledger.activeLeases += 2; sample.producer.worker.owners.objects.proofReservations = 3;
  sample.producer.handleClassification.retainedHandles = 5; sample.producer.unusedHandles = 5; sample.unusedHandles = 5;
  refreshMembers(packet); assert.equal(verify(packet).status, 'PASS');
  sample.producer.handleClassification.retainedHandles = 0; sample.producer.unusedHandles = 0; sample.unusedHandles = 0;
  refreshMembers(packet); assert.equal(verify(packet).status, 'FAIL');
});

test('continuous coverage rejects crossed, stale and self-sealed activation evidence', () => {
  for (const mutate of [
    packet => { currents(packet)[2].producer.aggregate.coverageWitness.activationCount = 1; },
    packet => { currents(packet)[2].producer.worker.ledger.aggregate.coverageWitness.activationCount = 1; },
    packet => { currents(packet)[2].producer.worker.ledger.uncoveredActivations = 1; },
    packet => { currents(packet)[2].producer.main.uncoveredOwners = [{ owner: 'provider', count: 1 }]; },
    packet => { currents(packet)[3].producer.main.aggregate.lifecycleWindow.coverage.endActivationCount = 1; },
    packet => { currents(packet)[2].producer.worker.ledger.aggregate.lifecycleWindow.coverage.startActivationCount = 1; },
    packet => { currents(packet)[3].producer.aggregate.lifecycleWindow.coverage.complete = false; },
    packet => { currents(packet)[3].producer.scope.intervalQuiescenceProven = false; },
    packet => { currents(packet)[1].producer.main.aggregate.lifecycleWindow.coverage.endActivationCount = 0; },
    packet => { for (const aggregate of [currents(packet)[2].producer.aggregate, currents(packet)[2].producer.main.aggregate, currents(packet)[2].producer.worker.ledger.aggregate]) aggregate.coverageWitness.activationCount = 2; },
    packet => { for (const aggregate of [currents(packet)[3].producer.aggregate, currents(packet)[3].producer.main.aggregate, currents(packet)[3].producer.worker.ledger.aggregate]) {
      aggregate.coverageWitness.activationCount = 1; aggregate.lifecycleWindow.coverage.endActivationCount = 1;
    } },
  ]) {
    const packet = scoredFixture(); mutate(packet); refreshMembers(packet); assert.equal(verify(packet).status, 'FAIL');
  }
  const transient = verify(scoredFixture({ covered: false }));
  assert.equal(transient.status, 'INCONCLUSIVE'); assert.deepEqual(transient.failures, []);
  assert(transient.missing.some(reason => reason.includes('peak coverage')), 'Transient uncovered work between quiet samples invalidates the interval');
  for (const remove of [sample => { delete sample.producer.worker.owners; }, sample => { delete sample.producer.main.aggregate.coverageWitness; },
    sample => { delete sample.producer.main.aggregate.lifecycleWindow.coverage; }]) {
    const packet = scoredFixture(); remove(currents(packet)[2]); refreshMembers(packet);
    assert.equal(verify(packet).status, 'INCONCLUSIVE', 'Absent raw evidence cannot be promoted by complete summaries');
  }
});


const currentOwnerFields = [
  'objects.repairs', 'objects.repairReads', 'recovery.maintenanceReaders', 'history.encodedAcceptances',
  'history.encodedReviewProofs.leases', 'history.encodedReviewProofs.proofs', 'history.encodedReviewProofs.metadataBytes',
  'raster.compositionMemory.loans', 'raster.compositionMemory.loanBytes', 'raster.compositionMemory.borrowers',
  'raster.compositionMemory.borrowedBytes', 'raster.compositionMemory.contentReaders',
  'raster.compositionMemory.loanFamilies.composition', 'raster.compositionMemory.loanFamilies.storageRead',
  'raster.compositionMemory.loanFamilies.storageRegistry',
];
function ownerField(sample, path) {
  const parts = path.split('.'), key = parts.pop();
  return { record: parts.reduce((value, part) => value[part], sample.producer.worker.owners), key };
}
test('current owner counters cannot conceal active repair, recovery, encoded review or composition owners', () => {
  for (const path of currentOwnerFields) {
    const packet = scoredFixture(), { record, key } = ownerField(currents(packet)[2], path);
    record[key] = 1; refreshMembers(packet);
    assert.equal(verify(packet).status, 'FAIL', path + ' contradicts the claimed quiet owner snapshot');
  }
  for (const path of currentOwnerFields) for (const value of [-1, 0.5, null, '0']) {
    const packet = scoredFixture(), { record, key } = ownerField(currents(packet)[2], path);
    record[key] = value; refreshMembers(packet);
    assert.equal(verify(packet).status, 'FAIL', path + ' is present but malformed');
  }
});
test('older owner inventories without current counters remain inconclusive rather than assumed empty', () => {
  for (const path of [...currentOwnerFields, 'history.encodedReviewProofs', 'raster.compositionMemory', 'raster.compositionMemory.loanFamilies']) {
    const packet = scoredFixture(), { record, key } = ownerField(currents(packet)[2], path);
    delete record[key]; refreshMembers(packet);
    const result = verify(packet);
    assert.equal(result.status, 'INCONCLUSIVE', path + ' has no retained current owner evidence');
    assert.deepEqual(result.failures, []);
    assert(result.missing.some(reason => reason.startsWith('Current worker owner inventory is unavailable:')));
  }
});


function activeResponseBuffer(sample, owner) {
  const producer = sample.producer;
  producer.main.groups[0].owner = owner;
  producer.coverage.handles = false; producer.scope.completeScopedOwnerSnapshot = false;
  producer.handleClassification.complete = false; producer.handleClassification.settled = false;
  producer.handleClassification.activeOwners.responseBuffers = 1; producer.handleClassification.retainedHandles = null;
  delete producer.unusedHandles; sample.unusedHandles = null;
}
test('an actual pending response buffer prevents settled handles independently of continuous CPU coverage', () => {
  for (const owner of ['protocol-response', 'composition-response']) {
    const packet = scoredFixture(); activeResponseBuffer(currents(packet)[2], owner); refreshMembers(packet);
    const result = verify(packet);
    assert.equal(result.status, 'PASS'); assert.deepEqual(result.failures, []); assert.deepEqual(result.missing, []);
    assert.equal(result.samples[2].unusedHandles, null);
    const boundary = scoredFixture(); activeResponseBuffer(currents(boundary)[1], owner); refreshMembers(boundary);
    const incomplete = verify(boundary);
    assert.equal(incomplete.status, 'INCONCLUSIVE'); assert.deepEqual(incomplete.failures, []);
    assert(incomplete.missing.includes('The independent lifecycle boundary has no complete settled handle classification.'));
  }
});
test('response ownership cannot invent a settled unused zero or omit required current counters', () => {
  for (const owner of ['protocol-response', 'composition-response']) {
    const packet = scoredFixture(); currents(packet)[2].producer.main.groups[0].owner = owner; refreshMembers(packet);
    assert.equal(verify(packet).status, 'FAIL', 'A live response backing cannot inherit a settled zero');
  }
  for (const value of [1, -1, 0.5, null, '0']) {
    const packet = scoredFixture(); currents(packet)[2].producer.handleClassification.activeOwners.responseBuffers = value; refreshMembers(packet);
    assert.equal(verify(packet).status, 'FAIL', 'The response counter must match actual response buffer groups');
  }
  const packet = scoredFixture(); delete currents(packet)[2].producer.handleClassification.activeOwners.responseBuffers; refreshMembers(packet);
  const result = verify(packet);
  assert.equal(result.status, 'INCONCLUSIVE'); assert.deepEqual(result.failures, []);
  assert(result.missing.includes('Current worker owner inventory is unavailable: Response buffer owners.'));
});

const reference = (bytes, mediaType = 'application/octet-stream') => ({hash: digest(bytes), byteLength: String(bytes.length), mediaType});
function importFixture() {
  const data = {weights: Buffer.from('abcd'), config: Buffer.from('{}\n'), provenance: Buffer.from('{"origin":"unit"}'), validation: Buffer.from('{"valid":true}')};
  const refs = Object.fromEntries(Object.entries(data).map(([role, bytes]) => [role, reference(bytes, role === 'weights' ? 'application/octet-stream' : role === 'config' ? 'text/plain' : 'application/json')]));
  const asset = (id, blob) => ({id, version: '1', blob});
  const assets = {weights: asset('weights', refs.weights), config: asset('config', refs.config)};
  assets.registration = {...asset('registration', refs.weights), dependencies: [refs.config, refs.provenance, refs.validation], adapter: {
    weights: refs.weights, config: refs.config, sources: {weightsAssetId: 'weights', configAssetId: 'config', provenanceAssetId: null}, qualification: 'structurally-valid', origin: {kind: 'import', provenance: refs.provenance, original: null},
    validation: {runtimeVerified: false, locallyEligible: false, report: refs.validation}}};
  const view = {versionId: 'registration', available: true, qualification: 'structurally-valid', weights: refs.weights, config: refs.config, runtimeVerified: false, locallyEligible: false};
  const local = role => ({path: '/unit/' + role, hash: refs[role].hash, bytes: data[role].length, mediaType: refs[role].mediaType});
  const imported = {asset: assets.registration, view, fixture: local('weights'), config: local('config'), binding: null, storedAssets: assets};
  const phases = ['weights', 'config'].map((role, index) => ({name: 'local-' + role + '-hash', hash: refs[role].hash, bytes: data[role].length,
    chunks: 1, maxChunk: data[role].length, outcome: 'expected', startMs: 120 + index, endMs: 121 + index, durationMs: 1}));
  const names = ['weights-stage-hash-durable', 'config-stage-hash-durable', 'header-profile-config-inspection-and-registration-durable'];
  for (const [index, role] of ['weights','config','registration'].entries()) {
    const commandId = 'command-' + role, seq = String(index + 1), receipt = {status: 'accepted', commandId, fromSeq: seq, toSeq: seq};
    phases.push({name: names[index], commandId, commandType: index === 2 ? 'RegisterAdapterVersion' : 'FinalizeStaging', receipt, eventSeq: seq,
      event: {seq, commandId, type: 'AssetRegistered', payload: {asset: assets[role]}}, outcome: 'expected', startMs: 130 + index, endMs: 131 + index, durationMs: 1});
  }
  phases.push({name: 'durable-entry-observation', startMs: 140, endMs: 141, durationMs: 1, outcome: 'expected'});
  phases.push({name: 'adapter.import-durable', startMs: 119, endMs: 200, durationMs: 81, elapsedMs: 81, outcome: 'expected'});
  const counters = Object.fromEntries(['submit','upload','poll','cancel','fetch','socket','dns','datagram'].map(key => [key, 0]));
  const proof = {readBack: ['weights','config','registration'].map(role => ({role, assetId: assets[role].id, expected: assets[role].blob,
    hash: assets[role].blob.hash, bytes: Number(assets[role].blob.byteLength), chunks: 1, maxChunk: Number(assets[role].blob.byteLength)})),
    metadata: ['provenance','validation'].map(role => ({role, expected: refs[role], hash: refs[role].hash, bytes: data[role].length})),
    durability: phases.filter(value => value.commandId).map(value => ({phase: value.name, commandId: value.commandId, receipt: value.receipt, event: value.event})),
    ownedLookup: {before: copy(counters), after: copy(counters), expected: view, observed: view, scope: 'patched-network-APIs-main-and-writer'}};
  return {data, refs, imported, phases, proof};
}

function priorWindowFixture() {
  const packet = scoredFixture(), samples = currents(packet), previous = copy(samples.at(-1).producer.aggregate.lifecycleWindow);
  previous.id = '4207:unit-shared-identity:1'; previous.startMonotonicNs = '9000000000'; previous.endMonotonicNs = '9500000000';
  for (const sample of samples) {
    sample.producer.worker.writerEpoch = '1';
    for (const aggregate of [sample.producer.aggregate, sample.producer.main.aggregate, sample.producer.worker.ledger.aggregate]) {
      if (sample.kind === 'initial') {aggregate.lifecycleWindow = copy(previous); aggregate.coverageComplete = true;}
      else aggregate.lifecycleWindow.id = '4207:unit-shared-identity:2';
    }
    if (sample.kind === 'initial') sample.producer.scope.intervalQuiescenceProven = true;
  }
  for (const frame of frames(packet)) frame.allocationPeak.windowId = '4207:unit-shared-identity:2';
  packet.lines.at(-1).observationWindow.id = '4207:unit-shared-identity:2'; packet.sampling.observationWindow.id = '4207:unit-shared-identity:2';
  packet.sampling.allocationPeaks.cpuBytes.windowId = '4207:unit-shared-identity:2';
  return refreshMembers(packet);
}
const ordinaryReplay = packet => verifyAdapterResourceSampling(packet.rawBytes, packet.sampling, {processIdentity, selectedSamples: packet.selectedSamples, allowPriorSealedWindow: true});

test('ordinary warm replay retains the prior sealed generation without scoring its peak or relaxing lifecycle replay', () => {
  const packet = priorWindowFixture(), replay = ordinaryReplay(packet);
  assert.equal(replay.status, 'PASS'); assert.equal(replay.recomputed.allocationPeaks.cpuBytes.value, 96);
  assert.equal(replay.recomputed.lifetimeCpuPeakBytes, 512);
  assert.equal(replay.recomputed.observationWindow.id, '4207:unit-shared-identity:2');
  assert.equal(replay.samples[0].producer.aggregate.lifecycleWindow.id, '4207:unit-shared-identity:1');
  assert.equal(verify(packet).status, 'FAIL', 'Existing lifecycle default remains strict');
});

test('ordinary warm replay refuses active, incomplete, foreign, reused, skipped and time-reversed prior generations', () => {
  const mutations = [
    p => {for (const a of [currents(p)[0].producer.aggregate, currents(p)[0].producer.main.aggregate, currents(p)[0].producer.worker.ledger.aggregate]) a.lifecycleWindow.sealed = false;},
    p => {for (const a of [currents(p)[0].producer.aggregate, currents(p)[0].producer.main.aggregate, currents(p)[0].producer.worker.ledger.aggregate]) a.lifecycleWindow.integrityComplete = false;},
    p => {currents(p)[0].producer.worker.writerEpoch = 'foreign';},
    p => {for (const a of [currents(p)[0].producer.aggregate, currents(p)[0].producer.main.aggregate, currents(p)[0].producer.worker.ledger.aggregate]) a.lifecycleWindow.id = '4207:foreign:1';},
    p => {for (const a of [currents(p)[0].producer.aggregate, currents(p)[0].producer.main.aggregate, currents(p)[0].producer.worker.ledger.aggregate]) a.lifecycleWindow.id = '4207:unit-shared-identity:2';},
    p => {for (const a of [currents(p)[0].producer.aggregate, currents(p)[0].producer.main.aggregate, currents(p)[0].producer.worker.ledger.aggregate]) a.lifecycleWindow.id = '4207:unit-shared-identity:3';},
    p => {for (const a of [currents(p)[0].producer.aggregate, currents(p)[0].producer.main.aggregate, currents(p)[0].producer.worker.ledger.aggregate]) a.lifecycleWindow.endMonotonicNs = '10100000000';},
    p => {for (const a of [currents(p)[0].producer.aggregate, currents(p)[0].producer.main.aggregate, currents(p)[0].producer.worker.ledger.aggregate]) a.lifecycleWindow.coverage.complete = false;},
  ];
  for (const mutate of mutations) {const packet = priorWindowFixture(); mutate(packet); seal(packet); assert.notEqual(ordinaryReplay(packet).status, 'PASS');}
});

test('ordinary import R18 is derived from relocated raw bytes and its enclosing independent action window', async t => {
  const output = await mkdtemp(join(tmpdir(), 'ordinary-import-resource-unit-')); t.after(() => rm(output, {recursive:true,force:true}));
  const resource = scoredFixture(), original = join(output, 'resources.jsonl');
  for (const sample of currents(resource)) sample.producer.worker.writerEpoch = '1';
  refreshMembers(resource);
  resource.sampling.artifact.path = original;
  for (const peak of Object.values(resource.sampling.peakSamples)) peak.backendOwnership.evidence.path = original;
  for (const peak of Object.values(resource.sampling.allocationPeaks)) peak.artifact.path = original;
  await writeFile(original, resource.rawBytes);
  const f = importFixture(), cell = {id:'AC1/unit-import',handler:'adapters',host:'C',kind:'operation',workload:'WA',operation:'adapter.import',parameters:{bytes:4}};
  const worker = {pid:4207,startedAt:'unit-process-start',node:'v26.10.0'};
  const retained = await retainAdapterImportObservation({output,cell,sample:{cache:'cold',ordinal:1,prime:false},workerProcessIdentity:worker,processIdentity,
    imported:f.imported,phases:f.phases,proof:f.proof,sampling:resource.sampling,backendHighWaterRssBytes:300});
  assert.deepEqual(retained.missing, []);
  const result = sanitize({status:'PASS',phases:f.phases,adapterImport:retained.observation,measurements:retained.measurements});
  const packetBytes = await readFile(retained.observation.artifact.path), reads = [];
  const attempt = {id:'AC1/unit-import/cold/scored/1',result};
  const readRetained = async path => {reads.push(path); if (path===retained.observation.artifact.path) return packetBytes; if(path===original) return resource.rawBytes; throw Error('Unknown retained path');};
  await rm(original); // Verification must use retained packet membership, never old absolute files.
  const verified = await verifyAdapterImportObservation({cell,attempt,workerProcessIdentity:worker,readRetained});
  assert.equal(verified.complete,true); assert.equal(reads.length,2);
  const rows = verifiedAdapterImportMeasurements(result,cell);assert.equal(rows.length,6);
  assert.equal(rows.find(row=>row.name==='R18CpuAllocationBytes').value,96);
  assert.equal(rows.find(row=>row.name==='R17BackendRssBytes').value,300);
  const altered = JSON.parse(packetBytes); altered.sampling.allocationPeaks.cpuBytes.value=0;
  const changed = Buffer.from(JSON.stringify(altered,null,2)+'\n'), forged = copy(result);
  forged.adapterImport.artifact={...forged.adapterImport.artifact,bytes:changed.length,sha256:digest(changed)};
  for(const row of forged.measurements) row.evidence=copy(forged.adapterImport);
  await assert.rejects(verifyAdapterImportObservation({cell,attempt:{...attempt,result:forged},workerProcessIdentity:worker,
    readRetained:async path=>path===original?resource.rawBytes:changed}),/resource evidence contradicts/);
});


async function retainedIncompleteImportResource(t, windowPeak) {
  const output = await mkdtemp(join(tmpdir(), 'ordinary-import-incomplete-unit-')); t.after(() => rm(output, {recursive:true,force:true}));
  const resource = scoredFixture({covered:false}), original = join(output, 'resources.jsonl'), lifetime = Math.max(512, windowPeak);
  for (const sample of currents(resource)) {
    sample.producer.worker.writerEpoch = '1';
    for (const aggregate of [sample.producer.aggregate, sample.producer.main.aggregate, sample.producer.worker.ledger.aggregate]) {
      aggregate.peakCpuBytes = lifetime;
      if (sample.kind === 'scheduled' || sample.kind === 'final') aggregate.lifecycleWindow.peakCpuBytes = windowPeak;
    }
    for (const [ledger, factor] of [[sample.producer.main,0.5],[sample.producer.worker.ledger,0.75]]) {
      ledger.peakCpuBytes = Math.floor(lifetime * factor); ledger.peakBackingBytes = ledger.peakCpuBytes;
    }
    sample.cpuHighWaterBoundBytes = sample.producer.main.peakCpuBytes + sample.producer.worker.ledger.peakCpuBytes;
  }
  for (const frame of frames(resource).slice(1)) frame.allocationPeak.value = windowPeak;
  resource.sampling.allocationPeaks.cpuBytes.value = windowPeak;
  refreshMembers(resource);
  const rawReplay = ordinaryReplay(resource); assert.equal(rawReplay.status,'INCONCLUSIVE'); assert.deepEqual(rawReplay.failures,[]);
  assert.equal(rawReplay.recomputed.allocationPeaks.cpuBytes.value,windowPeak);
  resource.sampling.artifact.path = original;
  for (const peak of Object.values(resource.sampling.peakSamples)) peak.backendOwnership.evidence.path = original;
  for (const peak of Object.values(resource.sampling.allocationPeaks)) peak.artifact.path = original;
  await writeFile(original,resource.rawBytes);
  const f = importFixture(), cell = {id:'AC1/unit-import',handler:'adapters',host:'C',kind:'operation',workload:'WA',operation:'adapter.import',parameters:{bytes:4},
    requiredMeasurements:[{name:'R18CpuAllocationBytes',unit:'bytes',ceiling:512*1048576,target:512*1048576}]};
  const worker = {pid:4207,startedAt:'unit-process-start',node:'v26.10.0'};
  const retained = await retainAdapterImportObservation({output,cell,sample:{cache:'cold',ordinal:1,prime:false},workerProcessIdentity:worker,processIdentity,
    imported:f.imported,phases:f.phases,proof:f.proof,sampling:resource.sampling,backendHighWaterRssBytes:300});
  const result = sanitize({status:'INCONCLUSIVE',phases:f.phases,adapterImport:retained.observation,measurements:retained.measurements});
  const packetBytes = await readFile(retained.observation.artifact.path);
  const attempt = {id:'AC1/unit-import/cold/scored/1',cache:'cold',prime:false,status:'INCONCLUSIVE',result};
  await rm(original);
  const replay = await verifyAdapterImportObservation({cell,attempt,workerProcessIdentity:worker,
    readRetained:async path=>path===original?resource.rawBytes:packetBytes});
  assert.equal(replay.complete,false); assert.match(replay.missing.join(';'),/allocation/);
  return {rows:verifiedAdapterImportMeasurements(result,cell),evaluation:evaluateRequiredMeasurements(cell,[attempt])[0]};
}

test('incomplete resource coverage preserves an authenticated above-cap allocation lower bound as failure', async t => {
  const peak = 512*1048576+1, result = await retainedIncompleteImportResource(t,peak);
  const row = result.rows.find(value=>value.name==='R18CpuAllocationBytes');
  assert.equal(row.value,peak); assert.equal(row.lowerBound,true); assert.equal(result.evaluation.status,'FAIL');
});

test('incomplete resource coverage never qualifies a small or exactly-at-cap observed allocation subtotal', async t => {
  for (const peak of [96,512*1048576]) {
    const result = await retainedIncompleteImportResource(t,peak);
    assert(!result.rows.some(value=>value.name==='R18CpuAllocationBytes')); assert.equal(result.evaluation.status,'INCONCLUSIVE');
  }
});

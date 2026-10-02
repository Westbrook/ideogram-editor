import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const MAX_BYTES = 128 * 1048576, MAX_LINE_BYTES = 1048576, MAX_SAMPLES = 20_000;
const coverageKeys = ['processTree', 'workerThreads', 'stagingBuffers', 'hashBuffers', 'headerBuffers', 'configBuffers', 'ioCopies', 'metadataConsumers', 'assetReadHandles', 'proofHandles', 'streamHandles'];
const actions = new Set(['before-open', 'before-import', 'after-import', 'after-select', 'after-release']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => Number.isFinite(value) && value >= 0;
const nanoseconds = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.length <= MAX_SAMPLES && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 8192);
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const equal = (actual, expected, message) => assert(isDeepStrictEqual(actual, expected), message);
const sum = (left, right) => integer(left) && integer(right) && integer(left + right) ? left + right : null;
const coverageContract = 'backend-adapter-owned-resources-1';
class MissingResourceEvidence extends Error {}

function inventory(record, numeric, flags, label) {
  assert(object(record), label + ' inventory is unavailable');
  for (const key of numeric) assert(integer(record[key]), label + ' inventory has an invalid counter: ' + key);
  for (const key of flags) assert(typeof record[key] === 'boolean', label + ' inventory has an invalid flag: ' + key);
}

// New owner inventories are required evidence. Older records which omit them
// cannot inherit zero ownership from a current summary or coverage flag. Present
// but malformed counters remain a contradiction, not unavailable evidence.
function currentInventory(record, numeric, label) {
  if (record === undefined || object(record) && numeric.some(key => !Object.hasOwn(record, key)))
    throw new MissingResourceEvidence('Current worker owner inventory is unavailable: ' + label + '.');
  inventory(record, numeric, [], label);
}

function ledgerInventory(ledger) {
  assert(ledger.kind === 'adapter-owned-resources-1', 'Unknown raw ownership ledger');
  inventory(ledger, ['parentPid', 'sequence', 'cpuBytes', 'peakCpuBytes', 'backingBytes', 'peakBackingBytes', 'reservedBytes', 'peakReservedBytes',
    'backingStores', 'activeLeases', 'returnedBuffers', 'droppedTransitions', 'unscopedReturnedBuffers'], ['isMainThread'], 'Ledger');
  equal(ledger.isMainThread, ledger.threadId === 0, 'Ledger realm flag differs from its actual thread');
  equal(ledger.cpuBytes, sum(ledger.backingBytes, ledger.reservedBytes), 'Ledger CPU bytes differ from its raw backing/reservation counters');
  assert(ledger.peakCpuBytes >= ledger.cpuBytes && ledger.peakBackingBytes >= ledger.backingBytes && ledger.peakReservedBytes >= ledger.reservedBytes,
    'Ledger high-water counters are below current ownership');
  assert(Array.isArray(ledger.groups) && ledger.groups.length <= 128 && Array.isArray(ledger.ownedWorkerThreads) && ledger.ownedWorkerThreads.length <= 128,
    'Ledger group or owned-worker inventory is unavailable');
  const groups = new Set(), threads = new Set(); let buffers = 0, handles = 0, reservations = 0;
  for (const group of ledger.groups) {
    inventory(group, ['buffers', 'handles', 'reservedBytes'], [], 'Ledger group');
    assert([group.owner, group.kind].every(value => typeof value === 'string' && /^[a-zA-Z0-9:.-]{1,64}$/.test(value)), 'Ledger group identity is invalid');
    const key = group.owner + '/' + group.kind; assert(!groups.has(key), 'Ledger group identity is duplicated'); groups.add(key);
    buffers = sum(buffers, group.buffers); handles = sum(handles, group.handles); reservations = sum(reservations, group.reservedBytes);
    assert(buffers !== null && handles !== null && reservations !== null, 'Ledger inventory counter sum is unsafe');
  }
  equal(reservations, ledger.reservedBytes, 'Ledger reservations differ from their actual groups');
  assert(buffers + handles <= ledger.activeLeases && ledger.backingStores <= buffers, 'Ledger leases or backing stores contradict their actual groups');
  if (ledger.droppedTransitions === 0) assert(ledger.returnedBuffers <= buffers, 'Ledger returned buffers have no actual buffer lease');
  for (const thread of ledger.ownedWorkerThreads) {
    assert(object(thread) && ['writer', 'raster', 'text-font', 'text-verification'].includes(thread.kind) && integer(thread.threadId) && thread.threadId > 0
      && thread.pid === ledger.pid && thread.parentThreadId === ledger.threadId && !threads.has(thread.threadId), 'Owned worker registry has a crossed or duplicate thread identity');
    threads.add(thread.threadId);
    const group = ledger.groups.find(value => value.owner === 'owned-worker' && value.kind === thread.kind);
    assert(ledger.droppedTransitions !== 0 || group && group.handles === ledger.ownedWorkerThreads.filter(value => value.kind === thread.kind).length,
      'Owned worker registry differs from its actual service handles');
  }
  if (ledger.droppedTransitions === 0) for (const group of ledger.groups.filter(value => value.owner === 'owned-worker'))
    equal(group.handles, ledger.ownedWorkerThreads.filter(thread => thread.kind === group.kind).length, 'Service handle has no actual owned-worker registry entry');
  assert(Array.isArray(ledger.uncoveredOwners) && ledger.uncoveredOwners.length <= 128 && integer(ledger.uncoveredActivations),
    'Ledger uncovered owner inventory is unavailable');
  const uncovered = new Set(); let activeUncovered = 0;
  for (const entry of ledger.uncoveredOwners) {
    assert(object(entry) && typeof entry.owner === 'string' && /^[a-zA-Z0-9:.-]{1,64}$/.test(entry.owner) && integer(entry.count) && entry.count > 0
      && !uncovered.has(entry.owner), 'Ledger uncovered owner inventory has a duplicate or invalid entry');
    uncovered.add(entry.owner); activeUncovered += entry.count;
    const group = ledger.groups.find(value => value.owner === entry.owner && value.kind === 'uncovered-owner');
    assert(ledger.droppedTransitions !== 0 || group?.handles === entry.count, 'Uncovered owner inventory differs from its actual handle leases');
  }
  assert(activeUncovered <= ledger.uncoveredActivations && ledger.uncoveredActivations <= ledger.aggregate.coverageWitness?.activationCount
    && activeUncovered <= ledger.aggregate.coverageWitness?.activeUncoveredOwners, 'Realm uncovered owner counters escape their process aggregate');
  return ledger.groups.filter(group => group.owner !== 'owned-worker').reduce((total, group) => total + group.handles, 0);
}

function workerInventory(worker) {
  const { ledger, owners } = worker;
  assert(object(owners), 'Raw worker owner inventories are unavailable');
  const { assets, objects, recovery, history, portable, raster, text, display, candidates, queue, provider } = owners;
  inventory(assets, ['chunkLeases', 'runningPreparations', 'preparationPromises', 'contentReaders', 'recoveryCursors', 'pausedPreparations'], [], 'Assets');
  inventory(objects, ['stages', 'slots', 'proofReservations', 'retainedProofs', 'proofReaders', 'proofWaiters'], ['proofWaitTimer'], 'Objects');
  inventory(recovery, ['readers'], ['maintenance'], 'Recovery'); inventory(history, ['authorities', 'paused'], ['running'], 'History');
  currentInventory(objects, ['repairs', 'repairReads'], 'Object repairs');
  currentInventory(recovery, ['maintenanceReaders'], 'Recovery maintenance readers');
  currentInventory(history, ['encodedAcceptances'], 'History encoded acceptances');
  currentInventory(history.encodedReviewProofs, ['leases', 'proofs', 'metadataBytes'], 'History encoded review proofs');
  inventory(portable, ['readers', 'authorities', 'paused'], ['running'], 'Portable');
  inventory(raster, ['activeWorkers', 'bookedCPUBytes', 'approvalAuthorities'], ['running', 'documentBusy'], 'Raster');
  currentInventory(raster.compositionMemory, ['loans', 'loanBytes', 'borrowers', 'borrowedBytes', 'contentReaders'], 'Raster composition memory');
  currentInventory(raster.compositionMemory.loanFamilies, ['composition', 'storageRead', 'storageRegistry'], 'Raster loan families');
  const families = raster.compositionMemory.loanFamilies;
  equal(sum(sum(families.composition, families.storageRead), families.storageRegistry), raster.compositionMemory.loans,
    'Raster loan family counts differ from its actual retained loans');
  inventory(raster.workerService, ['generation', 'activeJobs', 'workerCount', 'idleWorkers', 'retainedJobReferences', 'completedJobs'],
    ['restarting', 'closed', 'nativeAllocatorReleaseClaim'], 'Raster service');
  inventory(text, ['bookedCPUBytes', 'readyLoans', 'browserAdmissions'], ['verifying', 'browserAdmissionInventoryObserved'], 'Text');
  inventory(display, ['leases', 'building', 'cacheEntries'], [], 'Display'); inventory(candidates, ['transfers'], [], 'Candidates');
  inventory(queue, ['preparing', 'inputStreams'], ['inputStreamsObserved', 'transportEvidenceObserved'], 'Queue');
  inventory(provider, [], ['disabled', 'pending', 'timer', 'dispatcher', 'resultObserver', 'transportHandlesObserved'], 'Provider');
  assert(Array.isArray(owners.activeMethods) && owners.activeMethods.length <= 128, 'Worker active method inventory is unavailable');
  const methods = new Set();
  for (const entry of owners.activeMethods) {
    assert(object(entry) && typeof entry.method === 'string' && entry.method.length > 0 && entry.method.length <= 128 && integer(entry.count) && entry.count > 0
      && !methods.has(entry.method), 'Worker active method inventory has a duplicate or invalid operation'); methods.add(entry.method);
  }
  const intact = ledger.droppedTransitions === 0 && ledger.unscopedReturnedBuffers === 0;
  const witnesses = {
    objects: objects.repairs === 0 && objects.repairReads === 0,
    recovery: recovery.readers === 0 && recovery.maintenanceReaders === 0 && !recovery.maintenance,
    history: !history.running && history.encodedReviewProofs.leases === 0 && history.encodedReviewProofs.proofs === 0
      && history.encodedReviewProofs.metadataBytes === 0 && history.encodedAcceptances === 0, portable: !portable.running && portable.readers === 0,
    raster: !raster.running && !raster.documentBusy && raster.activeWorkers === 0 && raster.bookedCPUBytes === 0 && !raster.workerService.restarting && raster.workerService.retainedJobReferences === 0
      && raster.compositionMemory.loans === 0 && raster.compositionMemory.loanBytes === 0 && raster.compositionMemory.borrowers === 0
      && raster.compositionMemory.borrowedBytes === 0 && raster.compositionMemory.contentReaders === 0,
    text: !text.verifying && text.bookedCPUBytes === 0 && text.readyLoans === 0 && text.browserAdmissions === 0 && !ledger.ownedWorkerThreads.some(thread => thread.kind.startsWith('text-')),
    display: display.leases === 0 && display.building === 0, candidates: candidates.transfers === 0, queue: queue.preparing === 0 && queue.inputStreams === 0,
    provider: provider.disabled && !provider.pending && provider.transportHandlesObserved,
  };
  const unrelatedQuiet = Object.values(witnesses).every(Boolean), rasterThreads = ledger.ownedWorkerThreads.filter(thread => thread.kind === 'raster');
  const knownThreads = rasterThreads.length === raster.workerService.workerCount && (!raster.workerService.identity || rasterThreads.some(thread => thread.threadId === raster.workerService.identity.threadId));
  const coverage = { processTree: intact, workerThreads: intact && knownThreads && witnesses.raster && witnesses.text,
    stagingBuffers: intact, hashBuffers: intact, headerBuffers: intact, configBuffers: intact, ioCopies: intact && unrelatedQuiet, metadataConsumers: intact && unrelatedQuiet,
    assetReadHandles: intact && witnesses.recovery && witnesses.portable && witnesses.display, proofHandles: intact, streamHandles: intact && witnesses.provider && witnesses.candidates && witnesses.queue };
  equal(owners.quiescence, { kind: 'point-in-time-owner-inventory', complete: intact && unrelatedQuiet, intervalWitness: false, witnesses },
    'Worker point-in-time quiescence differs from its actual owner inventories');
  equal(owners.unknown, Object.entries(witnesses).filter(([, quiet]) => !quiet).map(([owner]) => 'active-uncovered-owner:' + owner),
    'Worker unknown-owner disclosure differs from its actual inventories');
  return { coverage, intact, unrelatedQuiet };
}

function continuousCoverage(aggregate) {
  const witness = aggregate.coverageWitness;
  assert(object(witness) && witness.kind === 'uncovered-owner-transitions-1' && witness.contract === coverageContract,
    'Continuous coverage has no recognized raw owner-transition witness');
  equal(Object.keys(witness).sort(), ['activationCount', 'activeUncoveredOwners', 'contract', 'kind'], 'Continuous owner-transition witness has unknown fields');
  inventory(witness, ['activationCount', 'activeUncoveredOwners'], [], 'Continuous owner-transition');
  assert(witness.activeUncoveredOwners <= witness.activationCount, 'Active uncovered owners exceed their actual activations');
  const window = aggregate.lifecycleWindow;
  if (!window) return false;
  const coverage = window.coverage;
  if (coverage == null) throw new MissingResourceEvidence('Continuous lifecycle owner-transition coverage is unavailable.');
  assert(object(coverage) && coverage.contract === coverageContract && typeof coverage.complete === 'boolean', 'Lifecycle window has no recognized owner-transition coverage');
  equal(Object.keys(coverage).sort(), ['complete', 'contract', 'endActivationCount', 'endActiveUncoveredOwners', 'startActivationCount', 'startActiveUncoveredOwners'],
    'Lifecycle owner-transition coverage has unknown fields');
  inventory(coverage, ['startActivationCount', 'startActiveUncoveredOwners'], [], 'Lifecycle opening');
  assert(coverage.startActiveUncoveredOwners <= coverage.startActivationCount && coverage.startActivationCount <= witness.activationCount,
    'Lifecycle opening counters escape their actual aggregate witness');
  for (const key of ['endActivationCount', 'endActiveUncoveredOwners']) assert(coverage[key] === null || integer(coverage[key]), 'Lifecycle closing owner-transition counter is invalid');
  equal(coverage.endActivationCount === null, coverage.endActiveUncoveredOwners === null, 'Lifecycle closing owner-transition counters are partially absent');
  if (window.endMonotonicNs === null) equal(coverage.endActivationCount, null, 'An open lifecycle window invented closing owner-transition counters');
  else assert(coverage.endActivationCount !== null && coverage.endActivationCount >= coverage.startActivationCount && coverage.endActivationCount <= witness.activationCount
    && coverage.endActiveUncoveredOwners <= coverage.endActivationCount, 'Lifecycle closing counters escape their actual aggregate witness');
  const complete = window.sealed && window.integrityComplete && coverage.startActiveUncoveredOwners === 0 && coverage.endActiveUncoveredOwners === 0
    && coverage.startActivationCount === coverage.endActivationCount;
  equal(coverage.complete, complete, 'Lifecycle coverage self-seal differs from actual owner-transition counters');
  return complete;
}

function producerOwnership(producer) {
  const main = producer.main, worker = producer.worker, ledger = worker.ledger;
  if (!worker.owners || !main.aggregate?.coverageWitness || !ledger.aggregate?.coverageWitness || !producer.handleClassification
    || !Array.isArray(main.groups) || !Array.isArray(ledger.groups) || !Array.isArray(main.ownedWorkerThreads) || !Array.isArray(ledger.ownedWorkerThreads)
    || !Array.isArray(main.uncoveredOwners) || !Array.isArray(ledger.uncoveredOwners))
    throw new MissingResourceEvidence('Raw owner inventories, handle classification or continuous transition evidence are unavailable.');
  currentInventory(producer.handleClassification.activeOwners, ['responseBuffers'], 'Response buffer owners');
  const mainHandles = ledgerInventory(main), workerHandles = ledgerInventory(ledger), raw = workerInventory(worker);
  equal(worker.coverage, raw.coverage, 'Worker coverage differs from its actual owner inventories and ledger');
  const aggregate = main.aggregate;
  const aggregateBound = aggregate.shared === true && ledger.aggregate.shared === true && aggregate.aggregateId === ledger.aggregate.aggregateId;
  const writers = main.ownedWorkerThreads.filter(thread => thread.kind === 'writer');
  const knownWriter = writers.length === 1 && writers[0].threadId === ledger.threadId && ledger.pid === main.pid;
  const observed = main.droppedTransitions === 0 && main.unscopedReturnedBuffers === 0 && aggregate.integrityComplete === true && aggregateBound;
  const coverage = { ...raw.coverage, processTree: raw.coverage.processTree && knownWriter && observed, workerThreads: raw.coverage.workerThreads && knownWriter && observed,
    stagingBuffers: raw.coverage.stagingBuffers && observed, ioCopies: raw.coverage.ioCopies && observed, metadataConsumers: raw.coverage.metadataConsumers && observed,
    assetReadHandles: raw.coverage.assetReadHandles && observed, streamHandles: raw.coverage.streamHandles && observed };
  const activeOwners = { mainHandles, responseBuffers: main.groups.filter(group => ['protocol-response', 'composition-response'].includes(group.owner))
    .reduce((total, group) => total + group.buffers, 0), workerMethods: worker.owners.activeMethods.reduce((total, entry) => total + entry.count, 0),
    assetPreparations: worker.owners.assets.runningPreparations, preparationPromises: worker.owners.assets.preparationPromises,
    assetChunkLeases: worker.owners.assets.chunkLeases, assetContentReaders: worker.owners.assets.contentReaders };
  const settled = Object.values(activeOwners).every(value => value === 0);
  const complete = coverageKeys.every(key => coverage[key]) && worker.owners.quiescence.complete && settled;
  coverage.handles = complete;
  const serviceHandles = record => record.groups.filter(group => group.owner === 'owned-worker').reduce((total, group) => total + group.handles, 0);
  const retainedHandles = complete ? workerHandles + worker.owners.objects.proofReservations + main.returnedBuffers + ledger.returnedBuffers : null;
  equal(producer.coverage, coverage, 'Combined owner coverage differs from actual owner inventories, main ledger and known writer');
  equal(producer.handleClassification, { kind: 'scoped-handle-classification-1', complete, settled,
    serviceHandles: { main: serviceHandles(main), worker: serviceHandles(ledger) }, activeOwners, retainedHandles },
  'Handle classification differs from actual scopes, active owners and retained handles');
  equal(Object.hasOwn(producer, 'unusedHandles'), complete, 'Unused handle value is present without complete settled ownership, or absent despite complete classification');
  if (complete) equal(producer.unusedHandles, retainedHandles, 'Unused handle value differs from the actual retained owner inventory');
  return { coverage, complete, aggregateBound, retainedHandles };
}

function parseLines(bytes) {
  const lines = [], decoder = new TextDecoder('utf-8', { fatal: true });
  let position = 0;
  while (position < bytes.length) {
    const end = bytes.indexOf(10, position);
    assert(end !== -1, 'Resource JSONL ends with an incomplete record');
    assert(end > position && end - position <= MAX_LINE_BYTES, 'Resource JSONL record exceeds its bound or is empty');
    assert(lines.length < MAX_SAMPLES + 2, 'Resource JSONL exceeds its record bound');
    const line = JSON.parse(decoder.decode(bytes.subarray(position, end)));
    assert(object(line), 'Resource JSONL record must be an object'); lines.push(line); position = end + 1;
  }
  assert(lines.length >= 4, 'Resource JSONL must contain a header, initial/final observations and footer');
  return lines;
}

/** Pure retained-byte verification. The outer verifier supplies bytes already
 * found in its relocated evidence packet; this function never reopens an
 * absolute path and never observes the verifying machine's resource state. */
export function verifyAdapterResourceSampling(rawBytes, sampling, { processIdentity, selectedSamples = [], allowPriorSealedWindow = false } = {}) {
  const missing = new Set(), failures = [], rawSamples = [], samples = [], allocationFrames = [];
  let artifact = null, recomputed = null;
  const result = () => ({ status: failures.length ? 'FAIL' : missing.size ? 'INCONCLUSIVE' : 'PASS',
    complete: failures.length === 0 && missing.size === 0, missing: [...missing], failures, artifact,
    counts: { samples: rawSamples.length, currentSamples: samples.length, producerPeaks: allocationFrames.length,
      selectedSamples: Array.isArray(selectedSamples) ? selectedSamples.length : 0 }, rawSamples, samples, recomputed });
  if (!sampling || !Buffer.isBuffer(rawBytes)) { missing.add('Sealed backend resource bytes or sampling receipt are unavailable.'); return result(); }
  try {
    assert(rawBytes.length > 0 && rawBytes.length <= MAX_BYTES, 'Resource artifact exceeds its byte bound or is empty');
    assert(object(sampling), 'Resource sampling receipt must be an object');
    artifact = sampling.artifact;
    assert(object(artifact) && typeof artifact.path === 'string' && artifact.path.length <= 8192 && isAbsolute(artifact.path)
      && resolve(artifact.path) === artifact.path && artifact.bytes === rawBytes.length && artifact.sha256 === hash(rawBytes)
      && sampling.sha256 === artifact.sha256, 'Resource bytes differ from the exact retained artifact identity');
    equal(Object.keys(artifact).sort(), ['bytes', 'path', 'sha256'], 'Resource artifact identity has unknown fields');
    assert(typeof processIdentity === 'string' && processIdentity.length > 0 && sampling.processIdentity === processIdentity,
      'Resource receipt belongs to a different lifecycle process');
    let lifecyclePid = null;
    try { const identity = JSON.parse(processIdentity); if (integer(identity?.pid) && identity.pid > 0) lifecyclePid = identity.pid; } catch { /* An opaque old identity supplies no actual PID witness. */ }
    if (lifecyclePid === null) missing.add('The lifecycle process identity has no retained actual PID binding.');
    assert(sampling.kind === 'attributed-backend-process-and-allocation-ledger', 'Unknown backend resource sampling receipt');
    assert(Array.isArray(selectedSamples) && selectedSamples.length <= MAX_SAMPLES, 'Selected resource inventory exceeds its bound');
    const lines = parseLines(rawBytes), header = lines.shift(), footer = lines.pop(); rawSamples.push(...lines);
    assert(header.kind === 'wa-backend-resource-stream-1' && header.processIdentity === processIdentity && header.intervalMs === 100 && time(header.startMs),
      'Resource header identity, clock or interval is invalid');
    assert(footer.kind === 'wa-backend-resource-summary-1' && time(footer.endMs) && footer.endMs >= header.startMs,
      'Resource footer clock is invalid');
    assert(sampling.intervalMs === 100 && sampling.forcedGC === false, 'Resource receipt changed interval or forced GC');
    equal(footer.startMs, header.startMs, 'Resource footer start differs from its header');
    equal(sampling.startMs, header.startMs, 'Resource receipt start differs from its header');
    equal(sampling.endMs, footer.endMs, 'Resource receipt end differs from its footer');
    assert(strings(footer.missing) && strings(sampling.missing), 'Resource missing-evidence inventory is malformed');
    equal(sampling.missing, footer.missing, 'Resource receipt missing evidence differs from its footer');
    for (const reason of footer.missing) missing.add(reason);
    assert(typeof sampling.complete === 'boolean', 'Resource receipt has no completeness state');
    if (!sampling.complete) missing.add('The producer did not establish complete resource sampling.');
    const peaks = { backendRssBytes: null, cpuBytes: null }, peakSamples = {};
    let maximumGapMs = 0, previousEnd = header.startMs, previousStart = null, producerIdentity = null;
    let aggregateIdentity = null, previousAggregate = null, continuousCpuPeakBytes = null, previousSource = null, requiredPeak = null, allocationPeak = null;
    let priorSealedWindow = null;
    let lifetimeCpuPeakBytes = null, previousWindow = null, firstWindowSample = null, begunWindowId = null, firstManualSeen = false;
    const windowMode = footer.observationWindow != null || sampling.observationWindow != null
      || rawSamples.some(value => Object.hasOwn(value, 'windowBoundary') || Object.hasOwn(value, 'scored')
        || value.producer?.aggregate?.lifecycleWindow != null || value.allocationPeak?.scope === 'independent-B0-lifecycle-window');
    for (const [index, sample] of rawSamples.entries()) {
      assert(sample.ordinal === index + 1, 'Resource record ordinals are not unique and contiguous');
      if (sample.kind === 'producer-peak') {
        equal(Object.keys(sample).sort(), ['allocationPeak', 'kind', 'ordinal', 'sourceOrdinal'], 'Producer peak frame has unknown fields');
        assert(requiredPeak && previousSource && sample.sourceOrdinal === previousSource.ordinal && sample.sourceOrdinal === index,
          'Producer peak frame is not bound to its immediately preceding actual source');
        equal(sample.allocationPeak, requiredPeak, 'Producer peak frame differs from the exact continuous producer aggregate');
        assert(allocationPeak === null || sample.allocationPeak.value > allocationPeak.value
          || windowMode && sample.allocationPeak.window?.sealed === true && allocationPeak.window?.sealed === false,
        'Producer peak frame is stale or duplicates an earlier maximum');
        allocationPeak = sample.allocationPeak; allocationFrames.push(sample); requiredPeak = null;
        if (!windowMode && !allocationPeak.complete) missing.add('Continuous producer allocation peak coverage is incomplete.');
        continue;
      }
      if (requiredPeak) { missing.add('An increased continuous producer CPU peak lacks its retained frame.'); requiredPeak = null; }
      assert(sample.processIdentity === processIdentity && sample.resourceScope === 'wa-backend-process-workers-allocations-1',
        'Resource sample ordinal, process identity or scope differs');
      assert(['initial', 'scheduled', 'manual', 'final'].includes(sample.kind)
        && (samples.length === 0 ? sample.kind === 'initial' : sample.kind !== 'initial')
        && previousSource?.kind !== 'final', 'Resource sample sequence lacks exact initial/final boundaries');
      samples.push(sample); previousSource = sample;
      assert(time(sample.observation?.startMs) && time(sample.observation?.endMs) && sample.observation.startMs >= previousEnd
        && sample.observation.endMs >= sample.observation.startMs && sample.observation.endMs <= footer.endMs, 'Resource observation clocks overlap or escape the stream');
      if (previousStart !== null) maximumGapMs = Math.max(maximumGapMs, sample.observation.startMs - previousStart);
      previousStart = sample.observation.startMs; previousEnd = sample.observation.endMs;
      assert(sample.forcedGC === false, 'Resource sample performed forced GC');
      const ownership = sample.backendOwnership;
      assert(ownership?.kind === 'wa-backend-owner-evidence-1' && ownership.processIdentity === processIdentity && ownership.evidence === null,
        'Raw ownership evidence must refer implicitly to its enclosing sealed stream');
      equal(Object.keys(ownership.coverage ?? {}).sort(), [...coverageKeys].sort(), 'Unknown or absent ownership coverage categories');
      for (const key of ['backendRssBytes', 'cpuBytes', 'cpuHighWaterBoundBytes', 'unusedHandles'])
        assert(sample[key] === null || integer(sample[key]), 'Resource value is negative, unsafe or nonintegral: ' + key);
      for (const key of ['browserRssBytes', 'gpuBytes', 'previewCacheBytes', 'settledBytes', 'textureSide', 'deviceTextureLimit'])
        assert(sample[key] === null, 'Backend resource stream invented an unrelated observation: ' + key);
      const producer = sample.producer, main = producer?.main, worker = producer?.worker?.ledger;
      const bound = producer?.kind === 'adapter-resource-observation-1' && integer(main?.pid) && main.pid > 0 && worker?.pid === main.pid
        && main.threadId === 0 && integer(worker?.threadId) && worker.threadId > 0;
      const aggregate = producer?.aggregate;
      const rawOwnership = bound ? producerOwnership(producer) : null;
      if (windowMode) {
        const expectedBoundary = sample.kind === 'manual' && !firstManualSeen ? 'begin' : sample.kind === 'final' && firstManualSeen ? 'end' : null;
        equal(sample.windowBoundary, expectedBoundary, 'Current sample B0 boundary differs from the actual first-manual/final sequence');
        if (sample.kind === 'manual') firstManualSeen = true;
        const window = aggregate?.lifecycleWindow;
        if (expectedBoundary === 'begin' && typeof window?.id === 'string' && window.id && window.scope === 'independent-B0-lifecycle-window' && window.sealed === false) begunWindowId = window.id;
        equal(sample.scored, begunWindowId !== null && window?.id === begunWindowId && expectedBoundary !== 'end',
          'Current sample scoring includes preparation, terminal reply or a crossed B0 window');
      }
      const aggregateBound = bound && aggregate?.kind === 'adapter-process-owned-resources-1' && aggregate.shared === true && aggregate.pid === main.pid
        && typeof aggregate.aggregateId === 'string' && !!aggregate.aggregateId && aggregate.window === 0 && aggregate.peakScope === 'process-lifetime'
        && aggregate.integrityComplete === true && integer(aggregate.sequence) && main.aggregate?.aggregateId === aggregate.aggregateId && worker.aggregate?.aggregateId === aggregate.aggregateId;
      const expectedCoverage = Object.fromEntries(coverageKeys.map(key => [key, bound && producer.coverage?.[key] === true]));
      equal(ownership.coverage, expectedCoverage, 'Resource ownership coverage differs from its actual producer');
      equal(sample.cpuBytes, aggregateBound && integer(aggregate.currentCpuBytes) ? aggregate.currentCpuBytes : null, 'Current CPU projection differs from the simultaneous process-shared producer');
      equal(sample.cpuHighWaterBoundBytes, bound ? sum(main.peakCpuBytes, worker.peakCpuBytes) : null, 'Realm CPU upper bound differs from retained producer peaks');
      equal(sample.unusedHandles, bound && producer.coverage?.handles === true && integer(producer.unusedHandles) ? producer.unusedHandles : null,
        'Unused handle projection differs from explicit complete owner evidence');
      if (!bound || sample.cpuBytes === null || coverageKeys.some(key => ownership.coverage[key] !== true))
        missing.add('Actual adapter workflow allocation ownership coverage is incomplete.');
      if (windowMode && sample.windowBoundary !== null && sample.unusedHandles === null)
        missing.add('The independent lifecycle boundary has no complete settled handle classification.');
      if (sample.backendRssBytes === null) missing.add('Process RSS observation is unavailable.');
      if (bound) {
        if (lifecyclePid !== null) equal(main.pid, lifecyclePid, 'Producer PID differs from its actual lifecycle process');
        const currentIdentity = { pid: main.pid, main: { instanceId: main.instanceId, threadId: main.threadId, window: main.window },
          worker: { instanceId: worker.instanceId, threadId: worker.threadId, window: worker.window } };
        if ([main, worker].some(ledger => typeof ledger.instanceId !== 'string' || !ledger.instanceId || !integer(ledger.window)))
          missing.add('Stable producer instance and observation-window identities are unavailable.');
        else if (producerIdentity === null) producerIdentity = currentIdentity;
        else equal(currentIdentity, producerIdentity, 'Resource producer process, worker, instance or window changed');
        if ([main, worker].some(ledger => ledger.droppedTransitions !== 0 || ledger.unscopedReturnedBuffers !== 0))
          missing.add('The production ownership transition window was incomplete.');
        if (!aggregate) missing.add('Continuous process-shared producer CPU peak evidence is unavailable.');
        else {
          assert(aggregate.kind === 'adapter-process-owned-resources-1' && aggregate.pid === main.pid && typeof aggregate.aggregateId === 'string' && aggregate.aggregateId.length > 0
            && aggregate.window === 0 && aggregate.peakScope === 'process-lifetime', 'Continuous process CPU aggregate has invalid identity or peak scope');
          const identity = { pid: aggregate.pid, aggregateId: aggregate.aggregateId, window: aggregate.window, peakScope: aggregate.peakScope };
          if (aggregateIdentity === null) aggregateIdentity = identity; else equal(identity, aggregateIdentity, 'Continuous CPU aggregate identity changed');
          for (const ledger of [main, worker]) assert(ledger.aggregate?.aggregateId === aggregate.aggregateId && ledger.aggregate.pid === aggregate.pid,
            'A producer realm belongs to a different process CPU aggregate');
          const realmsBound = main.aggregate.shared === true && worker.aggregate.shared === true && main.aggregate.aggregateId === worker.aggregate.aggregateId;
          const mainIntervalComplete = continuousCoverage(main.aggregate), workerIntervalComplete = continuousCoverage(worker.aggregate);
          for (const [realm, complete] of [[main, mainIntervalComplete], [worker, workerIntervalComplete]])
            equal(realm.aggregate.coverageComplete, complete && integer(realm.aggregate.currentCpuBytes) && integer(realm.aggregate.peakCpuBytes),
              'Raw aggregate coverage differs from its own interval-transition witness');
          const intervalComplete = main.droppedTransitions === 0 && main.unscopedReturnedBuffers === 0 && main.aggregate.integrityComplete === true
            && realmsBound && coverageKeys.every(key => rawOwnership.coverage[key]) && mainIntervalComplete;
          equal(aggregate, { ...main.aggregate, integrityComplete: main.aggregate.integrityComplete === true && realmsBound, coverageComplete: intervalComplete },
            'Combined process aggregate differs from its actual later main-realm snapshot');
          equal(producer.scope, { kind: 'backend-owned-process-and-threads', processes: [{ pid: main.pid, parentPid: main.parentPid }],
            completeScopedOwnerSnapshot: rawOwnership.complete, intervalQuiescenceProven: intervalComplete },
          'Combined resource scope differs from actual process, handle and interval witnesses');
          if (integer(worker.aggregate.peakCpuBytes) && integer(aggregate.peakCpuBytes)) assert(worker.aggregate.peakCpuBytes <= aggregate.peakCpuBytes,
            'Earlier worker aggregate peak exceeds the later process-lifetime peak');
          if (integer(worker.aggregate.sequence) && integer(aggregate.sequence)) assert(worker.aggregate.sequence <= aggregate.sequence,
            'Earlier worker aggregate sequence exceeds the later process sequence');
          assert(worker.aggregate.coverageWitness.activationCount <= aggregate.coverageWitness.activationCount,
            'Earlier worker uncovered activation count exceeds the later process witness');
          if (aggregate.shared !== true || main.aggregate.shared !== true || worker.aggregate.shared !== true || aggregate.integrityComplete !== true || aggregate.droppedTransitions !== 0)
            missing.add('Continuous process CPU aggregate ownership is incomplete.');
          if ((!windowMode || aggregate.lifecycleWindow?.sealed) && aggregate.coverageComplete !== true) missing.add('Continuous producer allocation peak coverage is incomplete.');
          if (integer(aggregate.peakCpuBytes) && integer(aggregate.currentCpuBytes)) assert(aggregate.peakCpuBytes >= aggregate.currentCpuBytes, 'Continuous CPU peak is below its current value');
          if (previousAggregate) {
            if (integer(aggregate.sequence) && integer(previousAggregate.sequence)) assert(aggregate.sequence >= previousAggregate.sequence, 'Continuous CPU aggregate sequence regressed');
            if (integer(aggregate.peakCpuBytes) && integer(previousAggregate.peakCpuBytes)) assert(aggregate.peakCpuBytes >= previousAggregate.peakCpuBytes, 'Continuous process-lifetime peak regressed');
            assert(aggregate.coverageWitness.activationCount >= previousAggregate.activationCount, 'Continuous uncovered activation counter regressed');
            assert(main.uncoveredActivations >= previousAggregate.mainActivations && worker.uncoveredActivations >= previousAggregate.workerActivations,
              'Realm uncovered activation counter regressed');
          }
          previousAggregate = { sequence: integer(aggregate.sequence) ? aggregate.sequence : previousAggregate?.sequence,
            peakCpuBytes: integer(aggregate.peakCpuBytes) ? aggregate.peakCpuBytes : previousAggregate?.peakCpuBytes,
            activationCount: aggregate.coverageWitness.activationCount, mainActivations: main.uncoveredActivations, workerActivations: worker.uncoveredActivations };
          if (!integer(aggregate.currentCpuBytes) || !integer(aggregate.peakCpuBytes) || !integer(aggregate.sequence)) missing.add('Continuous process CPU aggregate values are unavailable.');
          else {
            if (sample.cpuBytes !== null && aggregate.integrityComplete === true)
              lifetimeCpuPeakBytes = lifetimeCpuPeakBytes === null ? aggregate.peakCpuBytes : Math.max(lifetimeCpuPeakBytes, aggregate.peakCpuBytes);
            if (!windowMode) continuousCpuPeakBytes = lifetimeCpuPeakBytes;
            if (!windowMode && sample.cpuBytes !== null && aggregate.integrityComplete === true && (allocationPeak === null || aggregate.peakCpuBytes > allocationPeak.value)) requiredPeak = {
              kind: 'owned-allocation-continuous-peak-1', value: aggregate.peakCpuBytes,
              scope: 'fresh-worker-process-lifetime-including-preparation', processIdentity, sharedIdentity: aggregate.aggregateId,
              sequence: aggregate.sequence, observation: sample.observation, artifact: null,
              complete: aggregate.coverageComplete === true && coverageKeys.every(key => ownership.coverage[key] === true),
            };
          }
            if (windowMode) {
              const window = aggregate.lifecycleWindow;
              if (window == null) {
                if (previousWindow !== null) assert.fail('The independent lifecycle allocation window disappeared');
                if (sample.kind === 'manual' || sample.kind === 'final') missing.add('The scored B0 lifecycle allocation window is unavailable.');
              } else {
                assert(object(window), 'Producer lifecycle allocation window is invalid');
                equal(Object.keys(window).sort(), ['boundaryClockSemantics', 'coverage', 'currentCpuBytes', 'endMonotonicNs', 'id', 'integrityComplete', 'peakCpuBytes', 'scope', 'sealed', 'sequence', 'startMonotonicNs'],
                  'Producer lifecycle allocation window contains unknown or absent fields');
                assert(typeof window.id === 'string' && window.id.startsWith(aggregate.aggregateId + ':') && window.scope === 'independent-B0-lifecycle-window'
                  && window.boundaryClockSemantics === 'post-linearization-monotonic-observations'
                  && nanoseconds(window.startMonotonicNs) && (window.endMonotonicNs === null || nanoseconds(window.endMonotonicNs))
                  && typeof window.sealed === 'boolean' && typeof window.integrityComplete === 'boolean', 'Producer lifecycle allocation window identity or clocks are invalid');
                if (window.endMonotonicNs !== null) assert(BigInt(window.endMonotonicNs) >= BigInt(window.startMonotonicNs), 'Producer lifecycle allocation window end precedes its start');
                // Ordinary warm imports keep the same writer. Its last sealed
                // generation can be observed before this attempt opens a new
                // window. Retain it diagnostically, never import its peak or
                // coverage into the new independent window. Lifecycle replay
                // keeps the original strict default.
                const prior = allowPriorSealedWindow && sample.kind === 'initial';
                if (prior) {
                  assert(previousWindow === null && priorSealedWindow === null && window.sealed === true && window.integrityComplete === true
                    && aggregate.coverageComplete === true && window.coverage?.complete === true && window.endMonotonicNs !== null
                    && JSON.parse(processIdentity).writerEpoch === producer.worker.writerEpoch,
                  'Initial prior allocation window is incomplete, active or belongs to another writer');
                  assert(/:[1-9][0-9]*$/.test(window.id), 'Prior allocation generation is invalid');
                  equal(worker.aggregate.lifecycleWindow, window, 'Prior allocation window differs across its exact bound writer');
                  assert(producer.scope.completeScopedOwnerSnapshot === true && sample.unusedHandles === 0, 'Prior window is observed with active or retained unclassified owners');
                  priorSealedWindow = window;
                } else {
                if (!previousWindow) {
                  firstWindowSample = sample; assert(sample.kind === 'manual', 'The scored lifecycle allocation window did not begin with the first B0 manual observation');
                  if (priorSealedWindow) {
                    assert(window.id.startsWith(aggregate.aggregateId + ':') && /:[1-9][0-9]*$/.test(window.id)
                      && BigInt(window.id.split(':').at(-1)) === BigInt(priorSealedWindow.id.split(':').at(-1)) + 1n
                      && BigInt(window.startMonotonicNs) >= BigInt(priorSealedWindow.endMonotonicNs),
                    'New ordinary allocation window is not the next independent generation');
                  }
                }
                else {
                  equal(window.id, previousWindow.id, 'Producer lifecycle allocation window identity changed');
                  equal(window.startMonotonicNs, previousWindow.startMonotonicNs, 'Producer lifecycle allocation window start changed');
                  for (const key of ['contract', 'startActivationCount', 'startActiveUncoveredOwners']) equal(window.coverage[key], previousWindow.coverage[key],
                    'Producer lifecycle coverage opening changed: ' + key);
                  if (previousWindow.sealed) equal(window, previousWindow, 'A sealed lifecycle allocation window changed');
                  if (integer(window.sequence) && integer(previousWindow.sequence)) assert(window.sequence >= previousWindow.sequence, 'Lifecycle allocation window sequence regressed');
                  if (integer(window.peakCpuBytes) && integer(previousWindow.peakCpuBytes)) assert(window.peakCpuBytes >= previousWindow.peakCpuBytes, 'Lifecycle allocation window peak regressed');
                }
                if (window.sealed) assert(window.endMonotonicNs !== null && sample.kind === 'final', 'Lifecycle allocation window was sealed outside the final observation');
                if (window.integrityComplete !== true) missing.add('The independent lifecycle allocation window is not intact.');
                if (integer(window.peakCpuBytes) && integer(window.currentCpuBytes)) assert(window.peakCpuBytes >= window.currentCpuBytes, 'Independent lifecycle peak is below its current value');
                if (integer(window.peakCpuBytes) && integer(aggregate.peakCpuBytes)) assert(window.peakCpuBytes <= aggregate.peakCpuBytes, 'Independent lifecycle peak exceeds its lifetime bound');
                const workerWindow = worker.aggregate.lifecycleWindow;
                if (workerWindow != null) {
                  for (const key of ['id', 'scope', 'boundaryClockSemantics', 'startMonotonicNs']) equal(workerWindow[key], window[key], 'Worker lifecycle allocation window immutable identity differs: ' + key);
                  for (const key of ['contract', 'startActivationCount', 'startActiveUncoveredOwners']) equal(workerWindow.coverage[key], window.coverage[key],
                    'Worker lifecycle coverage opening differs: ' + key);
                  if (workerWindow.sealed) equal(workerWindow, window, 'Earlier sealed worker window differs from the later immutable process window');
                  if (integer(workerWindow.peakCpuBytes) && integer(window.peakCpuBytes)) assert(workerWindow.peakCpuBytes <= window.peakCpuBytes, 'Earlier worker lifecycle peak exceeds the later shared window');
                  if (integer(workerWindow.sequence) && integer(window.sequence)) assert(workerWindow.sequence <= window.sequence, 'Earlier worker lifecycle sequence exceeds the later shared window');
                }
                if (!integer(window.currentCpuBytes) || !integer(window.peakCpuBytes) || !integer(window.sequence)) missing.add('Independent lifecycle allocation window values are unavailable.');
                else {
                  if (sample.cpuBytes !== null && window.integrityComplete === true) {
                    continuousCpuPeakBytes = continuousCpuPeakBytes === null ? window.peakCpuBytes : Math.max(continuousCpuPeakBytes, window.peakCpuBytes);
                    if (!allocationPeak || window.peakCpuBytes > allocationPeak.value || window.sealed && !allocationPeak.window?.sealed) requiredPeak = {
                      kind: 'owned-allocation-continuous-peak-1', value: window.peakCpuBytes, scope: window.scope,
                      processIdentity, sharedIdentity: aggregate.aggregateId, sequence: window.sequence, windowId: window.id, sourceOrdinal: sample.ordinal,
                      window: { startMonotonicNs: window.startMonotonicNs, endMonotonicNs: window.endMonotonicNs, sealed: window.sealed, integrityComplete: window.integrityComplete },
                      observation: sample.observation, artifact: null,
                      complete: window.sealed && window.integrityComplete && aggregate.coverageComplete === true && coverageKeys.every(key => ownership.coverage[key] === true),
                    };
                  }
                }
                previousWindow = window;
                }
              }
            }
        }
      }
      for (const key of Object.keys(peaks)) if ((!windowMode || sample.scored) && sample[key] !== null && (peaks[key] === null || sample[key] > peaks[key])) { peaks[key] = sample[key]; peakSamples[key] = sample; }
    }
    assert(samples.length >= 2 && samples.at(-1).kind === 'final', 'Resource stream has no final current observation');
    if (requiredPeak) missing.add('An increased continuous producer CPU peak lacks its retained frame.');
    equal(footer.samples, rawSamples.length, 'Footer sample count differs from actual contiguous records');
    equal(sampling.counts, { samples: rawSamples.length }, 'Receipt sample count differs from actual contiguous records');
    equal(footer.maxGapMs, maximumGapMs, 'Footer gap differs from actual observation clocks');
    equal(sampling.maximumGapMs, maximumGapMs, 'Receipt gap differs from actual observation clocks');
    equal(footer.peaks, peaks, 'Footer maxima differ from actual resource samples');
    equal(sampling.peaks, peaks, 'Receipt maxima differ from actual resource samples');
    if (maximumGapMs > 200 || samples[0].observation.startMs - header.startMs > 200 || footer.endMs - previousEnd > 200)
      missing.add('A resource observation gap exceeded two 100 ms intervals.');
    if (!allocationPeak) missing.add('An explicit retained continuous producer peak frame is unavailable.');
    if (footer.allocationPeaks === undefined) missing.add('The raw footer allocation peak inventory is unavailable.');
    else equal(footer.allocationPeaks, allocationPeak ? { cpuBytes: allocationPeak } : {}, 'Footer allocation peak differs from its actual retained producer frame');
    if (sampling.allocationPeaks === undefined) missing.add('The receipt allocation peak inventory is unavailable.');
    else {
      assert(object(sampling.allocationPeaks), 'Receipt allocation peak inventory is invalid');
      equal(Object.keys(sampling.allocationPeaks), allocationPeak ? ['cpuBytes'] : [], 'Receipt allocation peak inventory differs from actual retained producer frames');
      if (allocationPeak) {
        const returnedPeak = sampling.allocationPeaks.cpuBytes;
        assert(object(returnedPeak), 'Receipt allocation peak is unavailable');
        equal(returnedPeak.artifact, artifact, 'Receipt allocation peak belongs to another retained artifact');
        equal({ ...returnedPeak, artifact: null }, allocationPeak, 'Receipt allocation peak differs from its entire original producer frame');
      }
    }
    if (allocationPeak) equal(allocationPeak.value, continuousCpuPeakBytes, 'Retained producer frame does not witness the actual maximum continuous CPU peak');
    if (!windowMode) {
      // Preparation remains diagnostic and cannot prove a scored B0 cap.
      missing.add('An independent B0 lifecycle allocation window is unavailable; process-lifetime peaks are diagnostic only.');
    } else {
      if (!previousWindow?.sealed || !allocationPeak?.complete) missing.add('The independent B0 lifecycle allocation window has no complete final seal.');
      if (footer.observationWindow == null || sampling.observationWindow == null) missing.add('The scored allocation window runner boundary observations are unavailable.');
      if (footer.observationWindow != null && sampling.observationWindow != null) equal(sampling.observationWindow, footer.observationWindow,
        'Receipt allocation window runner boundaries differ from their raw footer');
      for (const descriptor of [footer.observationWindow, sampling.observationWindow].filter(value => value != null)) {
        assert(object(descriptor) && descriptor.scope === 'independent-B0-lifecycle-window' && descriptor.id === previousWindow?.id
          && descriptor.processIdentity === processIdentity, 'Scored allocation window descriptor differs from its actual producer window');
        equal(Object.keys(descriptor).sort(), ['endObservation', 'id', 'processIdentity', 'scope', 'startObservation'], 'Scored allocation window descriptor has unknown fields');
        const start = descriptor.startObservation, end = descriptor.endObservation;
        for (const bracket of [start, end]) {
          if (bracket == null) { missing.add('An allocation window boundary RPC has no real clock bracket.'); continue; }
          assert(object(bracket) && time(bracket.startMs) && time(bracket.endMs) && bracket.endMs >= bracket.startMs
            && bracket.startMs >= header.startMs && bracket.endMs <= footer.endMs, 'Allocation window boundary RPC escapes the sampling clock');
        }
        if (start && firstWindowSample) equal(start, firstWindowSample.observation, 'Allocation window opening differs from the exact B0 RPC observation');
        if (end) equal(end, samples.at(-1).observation, 'Allocation window closing differs from the exact final RPC observation');
        if (start && end && previousWindow?.endMonotonicNs !== null && previousWindow?.endMonotonicNs !== undefined) {
          // The clocks have different origins; their elapsed duration is
          // still enclosed by the same two real RPC observations.
          const durationMs = Number(BigInt(previousWindow.endMonotonicNs) - BigInt(previousWindow.startMonotonicNs)) / 1e6;
          assert(Number.isFinite(durationMs) && durationMs >= end.startMs - start.endMs - 0.001
            && durationMs <= end.endMs - start.startMs + 0.001, 'Producer lifecycle duration escapes its actual runner boundary brackets');
        }
      }
    }
    function member(value, label) {
      assert(object(value) && integer(value.ordinal) && value.ordinal > 0 && value.ordinal <= rawSamples.length, label + ' has no actual retained ordinal');
      const raw = rawSamples[value.ordinal - 1];
      assert(raw.kind !== 'producer-peak', label + ' confused a continuous producer peak with a current observation');
      assert(object(value.backendOwnership), label + ' has no owner evidence');
      equal(value.backendOwnership.evidence, artifact, label + ' belongs to another resource artifact');
      const normalized = { ...value, backendOwnership: { ...value.backendOwnership, evidence: null } };
      if (Object.hasOwn(normalized, 'action')) { assert(actions.has(normalized.action), label + ' has an unknown action wrapper'); delete normalized.action; }
      if (Object.hasOwn(normalized, 'observedMs')) {
        assert(time(normalized.observedMs) && normalized.observedMs >= raw.observation.endMs && normalized.observedMs <= footer.endMs,
          label + ' wrapper clock escapes its actual observation'); delete normalized.observedMs;
      }
      equal(normalized, raw, label + ' differs from its entire original raw sample');
      return raw;
    }
    assert(object(sampling.peakSamples), 'Receipt peak witness inventory is absent');
    equal(Object.keys(sampling.peakSamples).sort(), Object.keys(peakSamples).sort(), 'Receipt peak witness inventory differs from actual maxima');
    for (const key of Object.keys(peakSamples)) equal(member(sampling.peakSamples[key], key + ' peak'), peakSamples[key], key + ' peak is not the first actual maximum witness');
    for (const value of selectedSamples) member(value, 'Selected resource sample');
    recomputed = { peaks, peakSamples, allocationPeaks: { cpuBytes: allocationPeak }, maximumGapMs, startMs: header.startMs,
      endMs: footer.endMs, producerIdentity, aggregateIdentity, continuousCpuPeakBytes, lifetimeCpuPeakBytes,
      observationWindow: footer.observationWindow ?? null };
  } catch (error) {
    if (error instanceof MissingResourceEvidence) missing.add(error.message);
    else failures.push(error instanceof Error ? error.message : String(error));
  }
  return result();
}

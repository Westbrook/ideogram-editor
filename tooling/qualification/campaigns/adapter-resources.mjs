import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

const coverageKeys = ['processTree', 'workerThreads', 'stagingBuffers', 'hashBuffers', 'headerBuffers', 'configBuffers', 'ioCopies', 'metadataConsumers', 'assetReadHandles', 'proofHandles', 'streamHandles'];
const number = value => Number.isSafeInteger(value) && value >= 0;
const intervalMs = 100, maxSamples = 20_000, maxBytes = 128 * 1048576;

/** Current owned lease totals are distinct from process RSS. The producer's
 * continuous high-water counts survive intervals between these serial reads. */
export function adapterResourceProjection(observation, processIdentity, rss) {
  const main = observation?.main, worker = observation?.worker?.ledger;
  const bound = observation?.kind === 'adapter-resource-observation-1' && main?.pid === process.pid && worker?.pid === process.pid
    && main?.threadId === 0 && Number.isInteger(worker?.threadId) && worker.threadId > 0;
  const coverage = Object.fromEntries(coverageKeys.map(key => [key, bound && observation.coverage?.[key] === true]));
  const sum = (left, right) => number(left) && number(right) && number(left + right) ? left + right : null;
  const aggregate = observation?.aggregate;
  const aggregateBound = bound && aggregate?.kind === 'adapter-process-owned-resources-1' && aggregate.shared === true && aggregate.pid === process.pid
    && typeof aggregate.aggregateId === 'string' && !!aggregate.aggregateId && aggregate.window === 0 && aggregate.peakScope === 'process-lifetime'
    && aggregate.integrityComplete === true && number(aggregate.sequence) && main.aggregate?.aggregateId === aggregate.aggregateId && worker.aggregate?.aggregateId === aggregate.aggregateId;
  const cpuBytes = aggregateBound && number(aggregate.currentCpuBytes) ? aggregate.currentCpuBytes : null;
  const cpuHighWaterBoundBytes = bound ? sum(main.peakCpuBytes, worker.peakCpuBytes) : null;
  // A producer explicitly exposes unused handles only after checking all
  // active owners. Active handles are not automatically unused handles.
  const unusedHandles = bound && observation.coverage?.handles === true && number(observation.unusedHandles) ? observation.unusedHandles : null;
  return { resourceScope: 'wa-backend-process-workers-allocations-1', processIdentity, backendRssBytes: number(rss) ? rss : null,
    cpuBytes, cpuHighWaterBoundBytes, unusedHandles, browserRssBytes: null, gpuBytes: null, previewCacheBytes: null, settledBytes: null,
    textureSide: null, deviceTextureLimit: null,
    backendOwnership: { kind: 'wa-backend-owner-evidence-1', processIdentity, coverage, evidence: null },
    producer: observation ?? null, forcedGC: false };
}

/** The close/release timer ends at an actual zero-owner observation, not at
 * the last locally awaited release call. Unknown global coverage stays null. */
export function adapterReleaseWitness({ startMs, scopedEndMs, acquired, resources, processIdentity }) {
  assert(Number.isFinite(startMs) && startMs >= 0 && Number.isFinite(scopedEndMs) && scopedEndMs >= startMs);
  assert(Array.isArray(acquired));
  const acquisitionComplete = acquired.length > 0 && acquired.every(value => Number.isFinite(value?.acquiredMs) && value.acquiredMs >= 0 && value.acquiredMs <= startMs
    && typeof value.assetId === 'string' && !!value.assetId && /^sha256:[a-f0-9]{64}$/.test(value.handleIdentity ?? ''))
    && new Set(acquired.map(value => value.handleIdentity)).size === acquired.length;
  const observation = resources?.observation, consumers = resources?.campaignConsumers, readers = consumers?.retainedOracleReaders;
  const clockBound = Number.isFinite(observation?.startMs) && Number.isFinite(observation?.endMs)
    && observation.startMs >= scopedEndMs && observation.endMs >= observation.startMs;
  const completeOwnerCoverage = clockBound && typeof processIdentity === 'string' && !!processIdentity && resources?.processIdentity === processIdentity
    && resources?.resourceScope === 'wa-backend-process-workers-allocations-1'
    && number(resources.cpuBytes) && number(resources.backendRssBytes) && resources.unusedHandles === 0
    && resources.backendOwnership?.kind === 'wa-backend-owner-evidence-1' && resources.backendOwnership.processIdentity === processIdentity
    && coverageKeys.every(key => resources.backendOwnership.coverage?.[key] === true)
    && consumers?.scopedSelectionReaders === 0 && readers?.openFiles === 0 && readers?.openDatabases === 0
    && readers?.pendingObservation === false && readers?.ownedReadersReleased === true;
  return { kind: 'wa-backend-consumer-release-1', startMs, endMs: clockBound ? observation.endMs : null,
    durationMs: acquisitionComplete && completeOwnerCoverage ? observation.endMs - startMs : null,
    scopedSelectionReaderDurationMs: acquired.length ? scopedEndMs - startMs : null,
    acquired, acquisitionComplete, remainingOwnedSelectionReaders: consumers?.scopedSelectionReaders ?? null, completeOwnerCoverage,
    resourceObservation: resources,
    scope: 'Actual selection read release through the observed quiescent adapter workflow owner inventory and zero campaign/oracle readers.' };
}

/** A bounded real 100 ms sampler. It never requests GC, restarts a process,
 * settles recovery work, or invokes the expensive general diagnostics RPC. */
export function createAdapterResourceSampler({ writer, output, processIdentity, signal, readCampaignConsumers }) {
  let state = 'new', file = null, timer = null, tail = Promise.resolve(), ordinal = 0, bytes = 0, startMs = null, endMs = null, lastMs = null;
  let maxGapMs = 0, identity = null, seal = null, stopPromise = null, startPromise = null, pendingProduct = null;
  let beginAttempted = false, endAttempted = false, observationWindow = null;
  const hasher = createHash('sha256'), path = join(output, 'wa-backend-resources-' + randomUUID() + '.jsonl');
  const missing = new Set(), peaks = { backendRssBytes: null, cpuBytes: null }, peakSamples = {}, allocationPeaks = {}, returned = [];
  async function write(value) {
    const text = JSON.stringify(value) + '\n', count = Buffer.byteLength(text);
    if (bytes + count > maxBytes) throw Error('WA resource evidence exceeds its fixed byte bound');
    await file.writeFile(text); hasher.update(text); bytes += count;
  }
  async function productObservation(options) {
    const owner = writer();
    if (typeof owner?.adapterResourceSnapshot !== 'function') { missing.add('The current subject has no lightweight adapter allocation/handle observer.'); return null; }
    if (pendingProduct) { missing.add('A previous production resource observation is unresolved.'); return null; }
    const pending = Promise.resolve().then(() => owner.adapterResourceSnapshot(options)); pendingProduct = pending;
    pending.finally(() => { if (pendingProduct === pending) pendingProduct = null; }).catch(() => {});
    let deadline, abort;
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('Production allocation observation exceeded one second')), 1000);
        abort = () => reject(signal.reason ?? Error('Resource observation aborted'));
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); }
  }
  async function sample(kind) {
    signal?.throwIfAborted(); assert(state !== 'stopped', 'Resource sampler is stopped');
    if (ordinal >= maxSamples) throw Error('WA resource evidence exceeds its fixed observation bound');
    const observedStart = performance.now(); if (lastMs !== null) maxGapMs = Math.max(maxGapMs, observedStart - lastMs); lastMs = observedStart;
    let windowBoundary = null;
    if (kind === 'manual' && !beginAttempted) { beginAttempted = true; windowBoundary = 'begin'; }
    else if (kind === 'final' && beginAttempted && !endAttempted) { endAttempted = true; windowBoundary = 'end'; }
    let observed = null;
    try { observed = await productObservation(windowBoundary === 'begin' ? { beginLifecycleWindow: true } : windowBoundary === 'end' ? { endLifecycleWindow: true } : {}); }
    catch { missing.add('A production allocation/handle observation failed or exceeded its deadline.'); }
    const value = { ...adapterResourceProjection(observed, identity, process.memoryUsage().rss), ordinal: ++ordinal, kind,
      windowBoundary, campaignConsumers: readCampaignConsumers?.() ?? null };
    // The closing clock includes the real campaign/oracle inventory read.
    value.observation = { startMs: observedStart, endMs: performance.now() };
    const window = observed?.aggregate?.lifecycleWindow;
    if (windowBoundary === 'begin') {
      if (typeof window?.id === 'string' && window.id && window.scope === 'independent-B0-lifecycle-window' && window.sealed === false)
        observationWindow = { id: window.id, scope: window.scope, processIdentity: identity, startObservation: value.observation, endObservation: null };
      else missing.add('The independent B0 allocation window did not return an actual begin observation.');
    }
    if (windowBoundary === 'end') {
      if (observationWindow && window?.id === observationWindow.id && window.sealed === true) observationWindow.endObservation = value.observation;
      else missing.add('The independent B0 allocation window did not return an actual sealed end observation.');
    }
    const matchingWindow = observationWindow !== null && window?.id === observationWindow.id;
    // The end RPC seals before its reply. Its current reading is retained as
    // terminal evidence, while the sealed producer peak covers the window.
    value.scored = matchingWindow && windowBoundary !== 'end';
    if (!coverageKeys.every(key => value.backendOwnership.coverage[key]) || value.cpuBytes === null)
      missing.add('Actual adapter workflow allocation ownership coverage is incomplete.');
    if ((windowBoundary === 'begin' || windowBoundary === 'end') && value.unusedHandles === null)
      missing.add('The independent lifecycle boundary has no complete settled handle classification.');
    if (observed?.main?.droppedTransitions || observed?.worker?.ledger?.droppedTransitions) missing.add('The production ownership transition window was incomplete.');
    await write(value);
    for (const key of Object.keys(peaks)) if (value.scored && value[key] !== null && (peaks[key] === null || value[key] > peaks[key])) { peaks[key] = value[key]; peakSamples[key] = value; }
    const aggregate = observed?.aggregate;
    if (matchingWindow && value.cpuBytes !== null && aggregate.integrityComplete === true && window.integrityComplete === true
      && number(window.currentCpuBytes) && number(window.peakCpuBytes) && number(window.sequence) && window.peakCpuBytes >= window.currentCpuBytes) {
      if (!allocationPeaks.cpuBytes || window.peakCpuBytes > allocationPeaks.cpuBytes.value || windowBoundary === 'end') {
        if (ordinal >= maxSamples) throw Error('WA resource evidence exceeds its fixed observation bound');
        const allocationPeak = { kind: 'owned-allocation-continuous-peak-1', value: window.peakCpuBytes,
          scope: 'independent-B0-lifecycle-window', processIdentity: identity, sharedIdentity: aggregate.aggregateId, windowId: window.id,
          sourceOrdinal: value.ordinal, sequence: window.sequence, observation: value.observation,
          window: { startMonotonicNs: window.startMonotonicNs, endMonotonicNs: window.endMonotonicNs, sealed: window.sealed, integrityComplete: window.integrityComplete }, artifact: null,
          complete: window.sealed === true && aggregate.coverageComplete === true && coverageKeys.every(key => value.backendOwnership.coverage[key]) };
        await write({ kind: 'producer-peak', ordinal: ++ordinal, sourceOrdinal: value.ordinal, allocationPeak });
        allocationPeaks.cpuBytes = allocationPeak;
      }
    } else if (matchingWindow) missing.add('A bound integral continuous B0-window owned allocation peak is unavailable.');
    if (kind === 'manual') returned.push(value);
    return value;
  }
  function enqueue(kind) {
    const work = tail.then(() => { assert(state !== 'failed', 'The resource sampling stream already failed'); return sample(kind); });
    tail = work.catch(() => { missing.add('The resource sampling stream contains a failed observation; its possibly partial bytes cannot be sealed.'); state = 'failed'; clearTimeout(timer); timer = null; });
    return work;
  }
  function arm() {
    if (state !== 'running') return;
    timer = setTimeout(() => { timer = null; if (state === 'running') void enqueue('scheduled').catch(() => {}).finally(arm); }, intervalMs);
    timer.unref?.();
  }
  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      state = 'starting'; identity = typeof processIdentity === 'function' ? await processIdentity() : processIdentity;
      assert(typeof identity === 'string' && identity.length > 0);
      file = await open(path, 'wx', 0o600); startMs = performance.now();
      await write({ kind: 'wa-backend-resource-stream-1', processIdentity: identity, intervalMs, startMs, allocationSource: 'Actual production owned backing-store and booked reservation leases; process RSS is separate.' });
      state = 'running'; await enqueue('initial'); arm();
    })().catch(async error => {
      state = 'failed'; missing.add('The resource sampler failed to initialize and cannot seal its bytes.'); clearTimeout(timer); timer = null;
      if (file) { try { await file.close(); } finally { file = null; } } throw error;
    });
    return startPromise;
  }
  async function measure() { await start(); assert(state === 'running', 'Resource sampler is not running'); return enqueue('manual'); }
  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try {
        try { await start(); } catch { /* Start already recorded failure and closed its file. */ }
        clearTimeout(timer); timer = null; if (state !== 'failed') state = 'stopping'; await tail;
        if (state === 'failed') return { kind: 'attributed-backend-process-and-allocation-ledger', complete: false, sha256: null,
          artifact: { path, bytes: null, confirmedBytesWritten: bytes, sha256: null }, processIdentity: identity, counts: { samples: ordinal }, peaks, peakSamples, missing: [...missing] };
        state = 'stopping';
        await enqueue('final'); endMs = performance.now();
        if (!observationWindow?.endObservation || allocationPeaks.cpuBytes?.complete !== true) missing.add('The independent B0 continuous allocation window lacks complete sealed ownership evidence.');
        if (maxGapMs > intervalMs * 2) missing.add('A resource observation gap exceeded two 100 ms intervals.');
        await write({ kind: 'wa-backend-resource-summary-1', startMs, endMs, samples: ordinal, observationWindow, peaks, allocationPeaks, maxGapMs, missing: [...missing] });
        await file.sync(); await file.close(); file = null; seal = { path, bytes, sha256: 'sha256:' + hasher.digest('hex') };
        // A hash cannot embed itself in its stream. These receipt references
        // bind already captured samples to the now immutable enclosing stream.
        for (const value of new Set([...returned, ...Object.values(peakSamples)])) value.backendOwnership.evidence = seal;
        for (const value of Object.values(allocationPeaks)) value.artifact = seal;
        state = 'stopped';
        return { kind: 'attributed-backend-process-and-allocation-ledger', complete: missing.size === 0, sha256: seal.sha256, artifact: seal, processIdentity: identity,
          intervalMs, startMs, endMs, counts: { samples: ordinal }, maximumGapMs: maxGapMs, observationWindow, peaks, peakSamples, allocationPeaks, missing: [...missing], forcedGC: false };
      } finally { if (file) { await file.close(); file = null; } state = 'stopped'; }
    })();
    return stopPromise;
  }
  return { start, measure, stop };
}

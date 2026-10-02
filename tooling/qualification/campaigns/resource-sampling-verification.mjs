import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest } from './common.mjs';
import { RESOURCE_KEYS, createResourceObservationSummary } from './resource-observations.mjs';
import { validateAppOwnershipObservation, isAppOwnedAllocationPoint, isAppOwnedAllocationScope } from './renderer-ownership.mjs';
import { RESOURCE_SAMPLE_CODEC, createBrowserResourceSampleContext, createBrowserResourceSampleView } from './resource-sample-codec.mjs';

const MAX_BYTES = 256 * 1024 * 1024, MAX_SAMPLES = 100_000;
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => Number.isFinite(value) && value >= 0;
const equal = (actual, expected, message) => { if (!isDeepStrictEqual(actual, expected)) throw Error(message); };
const array = value => Array.isArray(value);
const strings = value => array(value) && value.every(item => typeof item === 'string' && item.length > 0);
const descriptorKeys = ['kind', 'id', 'cycleOrdinal', 'processIdentity', 'startMs', 'endMs', 'firstOrdinal', 'lastOrdinal', 'sampleCount', 'complete', 'missing'];
const descriptor = value => Object.fromEntries(descriptorKeys.map(key => [key, value[key]]));
function aggregate(samples) {
  const summary = createResourceObservationSummary();
  for (const sample of samples) summary.add(sample);
  return summary.snapshot();
}
function* sampleRange(samples, firstOrdinal, lastOrdinal) {
  for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal++) yield samples.at(ordinal - 1);
}

const cpuScope = 'independent-B0-browser-cpu-window';
const cpuMissing = ['app-payload-ownership-incomplete', 'native-image-and-canvas-implementation-overhead', 'native-blob-residency', 'engine-and-dom-allocations', 'renderer-ownership-proof-required'];
const cpuFailures = new Set(['text-observer-unavailable', 'text-observer-rebound', 'text-observer-disconnected', 'text-sequence-discontinuity', 'text-observer-fault', 'text-observation-invalid', 'clock-invalid', 'observer-reentrant']);
const cpuId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const cpuLedgerId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !array(value);
const fields = (value, names, label) => { if (!object(value)) throw Error(`Malformed ${label}`); equal(Object.keys(value).sort(), names.split(' ').sort(), `${label} fields differ`); };
const requireCpu = (valid, message) => { if (!valid) throw Error(message); };

function combinedObservation(value) {
  if (value === null) return null;
  fields(value, 'kind schemaVersion scope ledgerInstanceId sequence currentBytes observedPeakBytes observationComplete ownerCoverageComplete missing window', 'Combined CPU observation');
  requireCpu(value.kind === 'combined-cpu-observation-1' && value.schemaVersion === 1 && value.scope === 'browser-ledger-plus-text-reservations' && cpuLedgerId(value.ledgerInstanceId) &&
    integer(value.sequence) && integer(value.currentBytes) && integer(value.observedPeakBytes) && value.observedPeakBytes >= value.currentBytes &&
    value.observationComplete === false && value.ownerCoverageComplete === false, 'Malformed or overstated combined CPU observation');
  equal(value.missing, cpuMissing, 'Combined CPU ownership gaps differ');
  const window = value.window;
  if (window === null) return value;
  fields(window, 'kind schemaVersion ledgerInstanceId id ordinal clock clockOriginMs startMs endMs peakAtMs startSequence endSequence peakSequence currentBytes peakBytes ledgerBytesAtPeak textBytesAtPeak textStartSequence textEndSequence sealed observationComplete ownerCoverageComplete failures missing', 'Combined CPU window');
  requireCpu(window.kind === 'combined-cpu-window-1' && window.schemaVersion === 1 && window.ledgerInstanceId === value.ledgerInstanceId && cpuId(window.id) && integer(window.ordinal) && window.ordinal > 0 &&
    window.clock === 'browser-performance' && time(window.clockOriginMs) && time(window.startMs) && time(window.peakAtMs) &&
    ['startSequence', 'peakSequence', 'currentBytes', 'peakBytes', 'ledgerBytesAtPeak', 'textBytesAtPeak', 'textStartSequence'].every(key => integer(window[key])) &&
    window.startSequence <= window.peakSequence && window.peakSequence <= value.sequence && window.currentBytes <= window.peakBytes && window.peakBytes <= value.observedPeakBytes &&
    integer(window.ledgerBytesAtPeak + window.textBytesAtPeak) && window.ledgerBytesAtPeak + window.textBytesAtPeak === window.peakBytes &&
    typeof window.sealed === 'boolean' && typeof window.observationComplete === 'boolean' && window.ownerCoverageComplete === false &&
    strings(window.failures) && new Set(window.failures).size === window.failures.length && window.failures.every(reason => cpuFailures.has(reason)) &&
    window.observationComplete === (window.failures.length === 0), 'Malformed or overstated combined CPU window');
  equal(window.missing, cpuMissing, 'Combined CPU window ownership gaps differ');
  if (window.sealed) {
    requireCpu(time(window.endMs) && window.endMs >= window.startMs && integer(window.endSequence) && window.endSequence >= window.peakSequence && window.endSequence <= value.sequence && integer(window.textEndSequence), 'Malformed sealed combined CPU window');
  } else requireCpu(window.endMs === null && window.endSequence === null && window.textEndSequence === null, 'Open combined CPU window claims a seal');
  // A disclosed observer/clock fault is retainable diagnostic evidence, but
  // cannot support the scored lower-bound witness below.
  if (window.observationComplete) requireCpu(window.peakAtMs >= window.startMs && (!window.sealed || window.peakAtMs <= window.endMs && window.textEndSequence >= window.textStartSequence), 'Complete combined CPU window has contradictory time or text sequence');
  return value;
}

function cpuAck(value, boundary, window) {
  if (value === null) return null;
  fields(value, 'kind schemaVersion ledgerInstanceId id ordinal boundary sequence atMs clock clockOriginMs sealed', 'Combined CPU boundary acknowledgement');
  requireCpu(window && value.kind === 'combined-cpu-window-ack-1' && value.schemaVersion === 1 && value.boundary === boundary &&
    value.id === window.id && value.ledgerInstanceId === window.ledgerInstanceId && value.ordinal === window.ordinal &&
    value.clock === window.clock && value.clockOriginMs === window.clockOriginMs && value.sealed === (boundary === 'end') &&
    value.sequence === window[boundary === 'begin' ? 'startSequence' : 'endSequence'] && value.atMs === window[boundary === 'begin' ? 'startMs' : 'endMs'], 'Combined CPU acknowledgement differs from its actual producer window');
  return value;
}

const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };

/** A shared pure join for collection, retained replay and metric translation.
 * A structurally coherent but unreviewed witness remains diagnostic. Approval
 * comes only from the fixed source/native/build/runtime review registry. */
export function appOwnedCpuCandidate(begin, end, processIdentity, observationWindow) {
  try {
    if (!begin?.appOwnership || !end?.appOwnership || begin.kind !== 'manual' || end.kind !== 'final' ||
      typeof processIdentity !== 'string' || !processIdentity || begin.processIdentity !== processIdentity || end.processIdentity !== processIdentity ||
      !integer(begin.ordinal) || begin.ordinal < 1 || !integer(end.ordinal) || end.ordinal <= begin.ordinal) return null;
    const first = validateAppOwnershipObservation(begin.appOwnership, begin.combinedCpu), last = validateAppOwnershipObservation(end.appOwnership, end.combinedCpu);
    const start = first.window, finish = last.window, cpuStart = combinedObservation(begin.combinedCpu)?.window, cpuEnd = combinedObservation(end.combinedCpu)?.window;
    if (!start || !finish || !cpuStart || !cpuEnd || start.sealed || !finish.sealed || !cpuEnd.sealed ||
      begin.cpuWindowBoundary !== 'begin' || end.cpuWindowBoundary !== 'end') return null;
    if (!cpuAck(begin.cpuWindowAck, 'begin', cpuStart) || !cpuAck(end.cpuWindowAck, 'end', cpuEnd)) return null;
    for (const key of ['ledgerInstanceId', 'id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'cpuStartSequence', 'ledgerStartSequence']) equal(finish[key], start[key], 'App-owned CPU start identity changed');
    for (const key of ['ledgerInstanceId', 'id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'startSequence', 'textStartSequence']) equal(cpuEnd[key], cpuStart[key], 'App-owned CPU kernel start changed');
    equal(finish.kinds.map(row => ({ kind: row.kind, initial: row.initial })), start.kinds.map(row => ({ kind: row.kind, initial: row.initial })), 'App-owned initial kind inventory changed');
    equal(finish.text.initialBytes, start.text.initialBytes, 'App-owned initial text reservation changed');
    // Snapshot readers are real admitted owners created after begin ACK. Their
    // current state may differ from the exact retained window.initial state.
    const b0Cpu = start.kinds.reduce((sum, row) => sum + row.current.cpuBytes, 0) + start.text.currentBytes;
    if (!integer(start.text.currentBytes) || !integer(b0Cpu) || b0Cpu !== cpuStart.currentBytes || b0Cpu !== first.point.totals.cpuBytes || begin.cpuBytes !== b0Cpu) return null;
    for (const sample of [begin, end]) if (!time(sample.observation?.startMs) || !time(sample.observation?.endMs) || sample.observation.endMs < sample.observation.startMs) return null;
    if (end.observation.startMs < begin.observation.endMs) return null;
    const joined = { scope: cpuScope, id: cpuEnd.id, processIdentity, ledgerInstanceId: cpuEnd.ledgerInstanceId,
      startSourceOrdinal: begin.ordinal, endSourceOrdinal: end.ordinal, startObservation: begin.observation, endObservation: end.observation,
      beginAck: begin.cpuWindowAck, endAck: end.cpuWindowAck };
    equal(observationWindow, joined, 'App-owned CPU join differs from the original CPU boundaries');
    const proof = begin.rendererOwnershipProof ?? null;
    equal(end.rendererOwnershipProof ?? null, proof, 'App-owned CPU endpoints use different renderer proofs');
    const complete = start.observationComplete === true && finish.observationComplete === true && finish.reconciled === true &&
      cpuStart.observationComplete === true && cpuEnd.observationComplete === true &&
      isAppOwnedAllocationPoint(proof, { appOwnership: begin.appOwnership, combinedCpu: begin.combinedCpu, resourceKey: 'cpuBytes' }) &&
      isAppOwnedAllocationScope(proof, { appOwnership: end.appOwnership, combinedCpu: end.combinedCpu, resourceKey: 'cpuBytes' });
    return freeze(structuredClone({ kind: 'app-owned-reservation-cpu-peak-1', scope: cpuScope, value: cpuEnd.peakBytes, processIdentity,
      ledgerInstanceId: cpuEnd.ledgerInstanceId, windowId: cpuEnd.id, startSourceOrdinal: begin.ordinal, endSourceOrdinal: end.ordinal,
      startObservation: begin.observation, endObservation: end.observation,
      start: { appOwnership: begin.appOwnership, combinedCpu: begin.combinedCpu }, end: { appOwnership: end.appOwnership, combinedCpu: end.combinedCpu },
      rendererOwnershipProof: proof, complete: complete === true, artifact: null }));
  } catch { return null; }
}

function replayAppOwnership(samples, summary, sampling, observationWindow, processIdentity, artifact, absent) {
  const mode = Object.hasOwn(summary, 'appOwnedCpu') || Object.hasOwn(sampling, 'appOwnedCpu') || samples.some(sample => Object.hasOwn(sample, 'appOwnership'));
  if (!mode) return { appOwnedCpu: null };
  let previous = null;
  for (const sample of samples) {
    requireCpu(Object.hasOwn(sample, 'appOwnership'), 'App-owned sample witness is missing');
    if (sample.appOwnership === null) continue;
    const current = validateAppOwnershipObservation(sample.appOwnership, sample.combinedCpu), value = sample.appOwnership;
    for (const key of ['cpuBytes', 'gpuBytes', 'previewCacheBytes']) if (current.point.totals[key] != null && sample[key] != null) equal(sample[key], current.point.totals[key], 'App-owned point differs from its actual resource value');
    if (previous) {
      requireCpu(value.ledgerInstanceId === previous.value.ledgerInstanceId && value.transitionSequence >= previous.value.transitionSequence, 'App-owned ledger identity or transition sequence changed');
      if (previous.window && current.window) {
        const before = previous.window, after = current.window;
        for (const key of ['ledgerInstanceId', 'id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'cpuStartSequence', 'ledgerStartSequence']) equal(after[key], before[key], 'App-owned window identity changed');
        requireCpu(after.lastTransitionSequence >= before.lastTransitionSequence && after.budgetRefusals >= before.budgetRefusals && before.failures.every(reason => after.failures.includes(reason)), 'App-owned transition or failure history regressed');
        equal(after.text.initialBytes, before.text.initialBytes, 'App-owned initial text reservation changed');
        after.kinds.forEach((row, index) => {
          const prior = before.kinds[index]; equal(row.initial, prior.initial, 'App-owned initial kind reservation changed');
          for (const field of ['transitions', 'added', 'removed']) for (const key of Object.keys(prior[field])) requireCpu(row[field][key] >= prior[field][key], 'App-owned kind transition history regressed');
        });
        for (const key of ['gpuBytes', 'previewCacheBytes', 'handles']) requireCpu(after.peaks[key] >= before.peaks[key], 'App-owned reservation maximum regressed');
        if (before.sealed) equal(after, before, 'Sealed app-owned window changed');
      }
    }
    previous = { value, ...current };
  }
  const original = ordinal => integer(ordinal) && ordinal > 0 ? samples.at(ordinal - 1) : null;
  const begin = original(observationWindow?.startSourceOrdinal), end = original(observationWindow?.endSourceOrdinal);
  const candidate = appOwnedCpuCandidate(begin, end, processIdentity, observationWindow);
  equal(summary.appOwnedCpu, candidate, 'Raw app-owned CPU candidate differs from its original boundary samples');
  const appOwnedCpu = candidate ? { ...candidate, artifact: { path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 } } : null;
  equal(sampling.appOwnedCpu, appOwnedCpu, 'Returned app-owned CPU candidate differs from its retained artifact');
  if (!candidate) absent('app-owned-cpu-window-unavailable');
  else if (!candidate.complete) absent('reviewed-app-owned-cpu-coverage-unavailable');
  return { appOwnedCpu };
}

/** Retain the actual continuous producer witness separately from sampled
 * maxima. Browser and runner clocks are checked only within their own domains. */
function replayCombinedCpu(samples, summary, sampling, lifecycle, processIdentity, artifact, absent) {
  const mode = Object.hasOwn(summary, 'allocationPeaks') || Object.hasOwn(sampling, 'allocationPeaks') || Object.hasOwn(summary, 'observationWindow') ||
    Object.hasOwn(sampling, 'observationWindow') || samples.some(sample => ['combinedCpu', 'cpuWindowBoundary', 'cpuWindowAck'].some(key => Object.hasOwn(sample, key)));
  if (!mode) return { allocationPeaks: {}, observationWindow: null, continuousCpuLowerBound: null };
  let began = false, begin = null, end = null, previous = null;
  for (const sample of samples) {
    for (const key of ['combinedCpu', 'cpuWindowBoundary', 'cpuWindowAck']) requireCpu(Object.hasOwn(sample, key), 'Combined CPU sample witness is missing');
    const boundary = sample.kind === 'manual' && !began ? 'begin' : sample.kind === 'final' && began ? 'end' : null;
    if (boundary === 'begin') began = true;
    if (boundary === 'end') requireCpu(sample.ordinal === samples.length, 'Combined CPU end boundary is not the final retained sample');
    equal(sample.cpuWindowBoundary, boundary, 'Combined CPU boundary is not the first manual B0 or final sample');
    const value = combinedObservation(sample.combinedCpu), window = value?.window;
    if (boundary === null) requireCpu(sample.cpuWindowAck === null, 'Unrequested combined CPU boundary acknowledgement');
    const ack = boundary === null ? null : cpuAck(sample.cpuWindowAck, boundary, window);
    if (value && previous) {
      requireCpu(value.ledgerInstanceId === previous.ledgerInstanceId && value.sequence >= previous.sequence && value.observedPeakBytes >= previous.observedPeakBytes, 'Combined CPU ledger identity or sequence changed');
    }
    if (begin && window) {
      const first = begin.combinedCpu.window;
      for (const key of ['id', 'ordinal', 'ledgerInstanceId', 'clock', 'clockOriginMs', 'startMs', 'startSequence', 'textStartSequence']) equal(window[key], first[key], `Combined CPU window ${key} changed`);
      const prior = previous?.window;
      if (prior?.id === first.id) {
        requireCpu(window.peakBytes >= prior.peakBytes && prior.failures.every(reason => window.failures.includes(reason)), 'Combined CPU peak or failure history regressed');
        if (window.peakBytes === prior.peakBytes) for (const key of ['peakAtMs', 'peakSequence', 'ledgerBytesAtPeak', 'textBytesAtPeak']) equal(window[key], prior[key], 'Combined CPU tied maximum changed its original witness');
        if (prior.sealed) equal(window, prior, 'Sealed combined CPU window changed');
      }
    }
    if (boundary === 'begin' && ack && window?.sealed === false) begin = sample;
    if (boundary === 'end' && ack && window?.sealed === true && begin) end = sample;
    if (value) previous = value;
  }
  const observationWindow = begin ? { scope: cpuScope, id: begin.combinedCpu.window.id, processIdentity, ledgerInstanceId: begin.combinedCpu.ledgerInstanceId,
    startSourceOrdinal: begin.ordinal, endSourceOrdinal: end?.ordinal ?? null, startObservation: begin.observation, endObservation: end?.observation ?? null,
    beginAck: begin.cpuWindowAck, endAck: end?.cpuWindowAck ?? null } : null;
  equal(summary.observationWindow, observationWindow, 'Raw combined CPU observation window differs from retained boundary samples');
  equal(sampling.observationWindow, observationWindow, 'Returned combined CPU observation window differs from retained boundary samples');
  const window = end?.combinedCpu.window;
  const peak = end ? { kind: 'owned-allocation-continuous-peak-1', scope: cpuScope, value: window.peakBytes, processIdentity, sharedIdentity: window.ledgerInstanceId,
    sequence: window.endSequence, sourceOrdinal: end.ordinal, observation: end.observation, windowId: window.id, window,
    ownerCoverageComplete: false, complete: false, artifact: null } : null;
  equal(summary.allocationPeaks, peak ? { cpuBytes: peak } : {}, 'Raw continuous CPU peak differs from its final retained producer window');
  const retainedArtifact = { path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 };
  const allocationPeaks = peak ? { cpuBytes: { ...peak, artifact: retainedArtifact } } : {};
  equal(sampling.allocationPeaks, allocationPeaks, 'Returned continuous CPU peak differs from its retained window or artifact seal');
  const cleanup = summary.cpuWindowCleanup;
  fields(cleanup, 'attempted complete ack error', 'Combined CPU cleanup');
  equal(sampling.cpuWindowCleanup, cleanup, 'Returned combined CPU cleanup differs from its retained footer');
  requireCpu(typeof cleanup.attempted === 'boolean' && typeof cleanup.complete === 'boolean', 'Malformed combined CPU cleanup status');
  if (!cleanup.attempted) equal(cleanup, { attempted: false, complete: false, ack: null, error: null }, 'Unattempted combined CPU cleanup claims a result');
  else {
    requireCpu(!end, 'A retained final CPU sample cannot also claim independent cleanup');
    if (!cleanup.complete) equal(cleanup, { attempted: true, complete: false, ack: null, error: 'cpu-window-cleanup-unavailable' }, 'Failed combined CPU cleanup claims an acknowledgement');
    else {
      const ack = cleanup.ack;
      fields(ack, 'kind schemaVersion ledgerInstanceId id ordinal boundary sequence atMs clock clockOriginMs sealed', 'Combined CPU cleanup acknowledgement');
      requireCpu(cleanup.error === null && ack.kind === 'combined-cpu-window-ack-1' && ack.schemaVersion === 1 &&
        cpuLedgerId(ack.ledgerInstanceId) && cpuId(ack.id) && integer(ack.ordinal) && ack.ordinal > 0 && ack.boundary === 'end' &&
        integer(ack.sequence) && time(ack.atMs) && ack.clock === 'browser-performance' && time(ack.clockOriginMs) && ack.sealed === true,
      'Malformed combined CPU cleanup acknowledgement');
      if (begin) {
        const first = begin.combinedCpu.window;
        for (const key of ['ledgerInstanceId', 'id', 'ordinal', 'clock', 'clockOriginMs']) equal(ack[key], first[key], 'Combined CPU cleanup belongs to another window');
        requireCpu(ack.sequence >= first.startSequence && ack.atMs >= first.startMs, 'Combined CPU cleanup precedes its actual start');
      }
    }
  }
  let bound = !!(begin && end);
  if (begin && lifecycle) {
    equal(lifecycle.B0?.resources, begin, 'Combined CPU window does not begin at the exact independent B0 sample');
    const b0 = lifecycle.B0?.observation;
    requireCpu(time(b0?.startMs) && time(b0?.endMs) && b0.startMs <= begin.observation.startMs && b0.endMs >= begin.observation.endMs, 'Combined CPU start is outside the B0 runner observation');
    if (end) requireCpu(end.kind === 'final' && end.ordinal === samples.length && array(lifecycle.cycles) && lifecycle.cycles.length > 0 &&
      time(lifecycle.cycles.at(-1)?.endMs) && end.observation.startMs >= lifecycle.cycles.at(-1).endMs && time(lifecycle.endMs) && end.observation.endMs <= lifecycle.endMs,
    'Combined CPU final seal is outside the completed lifecycle runner interval');
  } else if (begin) { bound = false; absent('continuous-browser-cpu-lifecycle-binding-unavailable'); }
  if (!begin) absent('continuous-browser-cpu-window-start-unavailable');
  if (!end) absent('continuous-browser-cpu-window-end-unavailable');
  if (window && !window.observationComplete) absent('continuous-browser-cpu-observation-incomplete');
  absent('complete-browser-cpu-owner-coverage-unavailable');
  return { allocationPeaks, observationWindow, cpuWindowCleanup: cleanup, continuousCpuLowerBound: bound && window.observationComplete ? peak.value : null };
}

/** Replays only a sealed observation, never the current machine or product.
 * The caller also verifies outer evidence membership and the renderer proof's
 * retained bytes. Missing new witnesses preserve legacy incomplete evidence;
 * they cannot support a qualified complete claim. */
export function verifyResourceSamplingEvidence(rawBytes, sampling, { lifecycle = null } = {}) {
  if (!Buffer.isBuffer(rawBytes) || !rawBytes.length || rawBytes.length > MAX_BYTES || !sampling || typeof sampling !== 'object') throw Error('Invalid retained resource sampling input');
  const artifact = sampling.artifact;
  if (!artifact || typeof artifact.path !== 'string' || !isAbsolute(artifact.path) || resolve(artifact.path) !== artifact.path || artifact.bytes !== rawBytes.length || artifact.sha256 !== digest(rawBytes) || sampling.sha256 !== artifact.sha256) throw Error('Retained resource artifact differs from sampling identity');
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes));
  if (!['browser-resource-samples-1', 'browser-resource-samples-2'].includes(raw.schema) || raw.intervalMs !== 100 || !hash(raw.processIdentity) || !array(raw.roots) || raw.roots.length !== 3 || !time(raw.startMs) || !array(raw.samples) || raw.samples.length > MAX_SAMPLES || !raw.summary) throw Error('Malformed retained resource sampling schema');
  if (raw.schema === 'browser-resource-samples-2') {
    if (raw.sampleCodec !== RESOURCE_SAMPLE_CODEC) throw Error('Unknown retained resource sample codec');
    fields(raw.sampleContext, 'processIdentity rendererOwnershipProof', 'Resource sample codec context');
    equal(raw.sampleContext.processIdentity, raw.processIdentity, 'Resource codec context belongs to another process');
    const context = createBrowserResourceSampleContext(raw.sampleContext);
    // The fixed-cache view exposes exact originals to every existing check
    // without expanding the entire retained trace into long-lived objects.
    raw.samples = createBrowserResourceSampleView(raw.samples, context);
  }
  equal(raw.roots.map(root => root.kind), ['worker', 'browser', 'backend'], 'Resource process root roles differ');
  if (new Set(raw.roots.map(root => root.pid)).size !== 3 || raw.roots.some(root => !integer(root.pid) || root.pid === 0 || !integer(root.pgid) || root.pgid === 0 || typeof root.startedAtIdentity !== 'string' || !root.startedAtIdentity)) throw Error('Malformed retained resource process roots');
  equal(raw.processIdentity, digest({ schema: 'browser-resource-process-identity-1', roots: raw.roots }), 'Resource process identity differs from its retained roots');
  const missing = [], partialLifecycle = new Set(), summary = raw.summary, samples = raw.samples;
  const absent = (name, preserveFailure = false) => { missing.push(name); if (preserveFailure) partialLifecycle.add(name); };
  if (!time(summary.endMs) || summary.endMs < raw.startMs || sampling.kind !== 'attributed-process-tree-and-allocation-ledger' || sampling.intervalMs !== 100 || sampling.clock !== 'runner-monotonic' || sampling.forcedGC !== false || sampling.observedPeaksAreSampled !== true) throw Error('Malformed resource sampling clock or envelope');
  for (const [key, value] of Object.entries({ processIdentity: raw.processIdentity, roots: raw.roots, intervalMs: 100, startMs: raw.startMs, endMs: summary.endMs })) {
    equal(sampling[key], value, `Resource sampling ${key} differs from raw observations`);
    equal(summary[key], value, `Raw resource summary ${key} differs from its header`);
  }
  let scheduled = 0, manual = 0, failed = 0, maximumGapMs = 0, maximumSampleDurationMs = 0, lastScheduled = null, previousEnd = raw.startMs;
  for (const [index, sample] of samples.entries()) {
    if (!sample || sample.ordinal !== index + 1 || sample.processIdentity !== raw.processIdentity || !['scheduled', 'manual', 'final', 'window-start', 'window-end'].includes(sample.kind) ||
      !time(sample.sampleAtMs) || sample.sampleAtMs !== sample.observation?.startMs || !time(sample.observation.endMs) || sample.observation.endMs < sample.sampleAtMs || sample.sampleAtMs < previousEnd || sample.observation.endMs > summary.endMs ||
      !strings(sample.missing) || sample.forcedGC !== false) throw Error('Malformed resource sample ordinal, process identity or time enclosure');
    for (const key of RESOURCE_KEYS) if (sample[key] !== null && sample[key] !== undefined && !integer(sample[key])) throw Error('Malformed actual resource numeric observation');
    if (sample.kind === 'scheduled') {
      scheduled++;
      if (lastScheduled !== null) maximumGapMs = Math.max(maximumGapMs, sample.sampleAtMs - lastScheduled);
      lastScheduled = sample.sampleAtMs;
    } else manual++;
    if (sample.missing.length) failed++;
    maximumSampleDurationMs = Math.max(maximumSampleDurationMs, sample.observation.endMs - sample.observation.startMs);
    previousEnd = sample.observation.endMs;
  }
  if (!sampling.counts || !summary.counts || !integer(sampling.counts.missedIntervals)) throw Error('Resource sampling counts are unavailable');
  equal(summary.counts, sampling.counts, 'Resource sampling counts differ from the raw footer');
  equal(sampling.counts.samples, samples.length, 'Resource sample samples count differs');
  for (const [key, value] of Object.entries({ scheduled, manual, failedSamples: failed })) {
    const reported = sampling.counts[key];
    if (sampling.complete === true || reported === value) equal(reported, value, `Resource sample ${key} count differs`);
    else {
      if (!integer(reported) || reported < value) throw Error(`Resource sample ${key} count underreports retained observations`);
      absent(`unretained-resource-attempt-count:${key}`);
    }
  }
  for (const [key, value] of Object.entries({ maximumGapMs, maximumSampleDurationMs })) {
    equal(summary[key], sampling[key], `Raw resource ${key} differs from returned evidence`);
    if (sampling.complete === true || sampling[key] === value) equal(sampling[key], value, `Resource ${key} differs from actual sample intervals`);
    else {
      if (!time(sampling[key]) || sampling[key] < value) throw Error(`Resource ${key} underreports actual sample intervals`);
      absent(`unretained-resource-attempt-duration:${key}`);
    }
  }
  const observed = aggregate(samples);
  for (const key of ['peaks', 'peakSamples', 'textureLimits']) {
    if (sampling[key] === undefined || summary[key] === undefined) absent(`resource-${key}-witness-unavailable`);
    if (sampling[key] !== undefined) equal(sampling[key], observed[key], `Resource ${key} differs from actual retained samples`);
    if (summary[key] !== undefined) equal(summary[key], observed[key], `Raw resource summary ${key} differs from actual retained samples`);
  }
  if (!strings(sampling.missing) || !strings(summary.missing)) throw Error('Malformed resource missing-evidence inventory');
  equal(summary.missing, sampling.missing, 'Resource missing-evidence inventory differs from its footer');
  if (sampling.complete === true && (summary.dataComplete !== true || !observed.complete || samples.length === 0 || scheduled < 2 || sampling.counts.missedIntervals !== 0 || maximumGapMs > 200 ||
    lastScheduled === null || summary.endMs - lastScheduled > 200 || sampling.missing.length)) throw Error('Complete resource sampling contradicts its actual observations');

  function member(value, label, preserveFailure = false) {
    if (value == null) { absent(`${label}-raw-member-unavailable`, preserveFailure); return; }
    if (!integer(value.ordinal) || value.ordinal < 1 || value.ordinal > samples.length) throw Error(`${label} does not identify an actual retained resource sample`);
    equal(value, samples.at(value.ordinal - 1), `${label} differs from its exact original resource sample`);
  }
  const rawWindows = summary.windows, returnedWindows = sampling.windows;
  if (rawWindows === undefined || returnedWindows === undefined) absent('resource-window-inventory-unavailable');
  else {
    if (!array(rawWindows) || rawWindows.length > 100 || !array(returnedWindows)) throw Error('Malformed resource window inventory');
    equal(returnedWindows, rawWindows, 'Returned resource windows differ from the retained footer');
  }
  const descriptors = new Map();
  let lastOrdinal = 0, lastWindowEnd = raw.startMs, lastCycleOrdinal = 0;
  for (const entry of rawWindows ?? []) {
    if (!entry || entry.kind !== 'resource-observation-window-1' || typeof entry.id !== 'string' || !entry.id || descriptors.has(entry.id) || !integer(entry.cycleOrdinal) || entry.cycleOrdinal <= lastCycleOrdinal || entry.cycleOrdinal > 100 ||
      entry.processIdentity !== raw.processIdentity || !time(entry.startMs) || !time(entry.endMs) || entry.startMs < lastWindowEnd || entry.endMs < entry.startMs || entry.endMs > summary.endMs || !integer(entry.sampleCount) || !strings(entry.missing)) throw Error('Malformed resource window descriptor');
    let selected = [];
    if (entry.sampleCount === 0) {
      if (entry.firstOrdinal !== null || entry.lastOrdinal !== null || entry.complete !== false) throw Error('Empty resource window claims observations');
    } else {
      if (!integer(entry.firstOrdinal) || !integer(entry.lastOrdinal) || entry.firstOrdinal <= lastOrdinal || entry.lastOrdinal < entry.firstOrdinal || entry.lastOrdinal > samples.length || entry.sampleCount !== entry.lastOrdinal - entry.firstOrdinal + 1) throw Error('Resource window does not enclose an exact contiguous ordinal slice');
      for (const sample of sampleRange(samples, entry.firstOrdinal, entry.lastOrdinal)) {
        if (sample.observation.startMs < entry.startMs || sample.observation.endMs > entry.endMs) throw Error('Resource window time enclosure omits or crosses actual observations');
      }
      if (entry.firstOrdinal > 1 && samples.at(entry.firstOrdinal - 2).observation.endMs > entry.startMs ||
        entry.lastOrdinal < samples.length && samples.at(entry.lastOrdinal).observation.startMs < entry.endMs) throw Error('Resource window time enclosure omits or crosses actual observations');
      selected = sampleRange(samples, entry.firstOrdinal, entry.lastOrdinal);
      lastOrdinal = entry.lastOrdinal;
    }
    const replayed = aggregate(selected);
    if (entry.complete !== (replayed.complete && entry.missing.length === 0)) throw Error('Resource window completeness differs from actual observations');
    descriptors.set(entry.id, { descriptor: entry, replayed });
    lastWindowEnd = entry.endMs; lastCycleOrdinal = entry.cycleOrdinal;
  }
  const used = new Set();
  if (lifecycle) {
    member(lifecycle.B0?.resources, 'B0');
    if (!array(lifecycle.cycles)) throw Error('Malformed lifecycle resource cycle inventory');
    for (const cycle of lifecycle.cycles) {
      const failedCycle = ['FAIL', 'INCONCLUSIVE'].includes(lifecycle.status) && !!cycle.error;
      member(cycle.resources, `cycle-${cycle.ordinal}-resources`, failedCycle);
      if (cycle.resourceObservation?.resources !== undefined) member(cycle.resourceObservation.resources, `cycle-${cycle.ordinal}-resource-observation`);
      if (!array(cycle.resourceSamples)) absent(`cycle-${cycle.ordinal}-selected-resource-samples-unavailable`, failedCycle);
      else for (const point of cycle.resourceSamples) member(point, `cycle-${cycle.ordinal}-selected-resource-sample`);
      const window = cycle.resourceWindow;
      if (!window) {
        absent(`cycle-${cycle.ordinal}-resource-window-unavailable`, failedCycle);
        if (failedCycle) for (const [id, entry] of descriptors) if (entry.descriptor.cycleOrdinal === cycle.ordinal) used.add(id);
        continue;
      }
      const found = descriptors.get(window.id);
      if (!found || used.has(window.id) || window.cycleOrdinal !== cycle.ordinal) throw Error('Lifecycle resource window differs from its retained descriptor');
      used.add(window.id);
      equal(descriptor(window), found.descriptor, 'Lifecycle resource window boundary differs from retained footer');
      if (window.complete !== true) absent(`cycle-${cycle.ordinal}-resource-window-incomplete`, failedCycle);
      for (const key of ['sampleCount', 'firstOrdinal', 'lastOrdinal', 'peaks', 'peakSamples', 'textureLimits', 'samples']) equal(window[key], found.replayed[key], `Lifecycle resource window ${key} differs from actual retained interval`);
      if (array(cycle.resourceSamples)) equal(cycle.resourceSamples, window.samples, 'Cycle selected samples differ from original window witnesses');
      if (!time(cycle.startMs) || !time(cycle.endMs) || cycle.startMs > window.startMs || cycle.endMs < window.endMs ||
        time(cycle.action?.startMs) && cycle.action.startMs < window.startMs || time(cycle.action?.endMs) && cycle.action.endMs > window.endMs ||
        time(cycle.observation?.endMs) && cycle.observation.endMs > window.endMs) throw Error('Lifecycle resource window does not enclose its actual cycle action and settled observation');
      if (cycle.resources && (window.sampleCount === 0 || cycle.resources.ordinal < window.firstOrdinal || cycle.resources.ordinal > window.lastOrdinal)) {
        // Once a fixed evidence bound is exhausted the sampler can return its
        // last actual row. Preserve that exact member, but it cannot witness a
        // later settled endpoint or qualify an otherwise complete stream.
        if (sampling.complete === true) throw Error('Settled cycle observation is outside its own resource window');
        absent(`cycle-${cycle.ordinal}-settled-resource-outside-window`);
      }
    }
    if (used.size !== descriptors.size) throw Error('Retained resource window has no matching lifecycle cycle');
  } else if (descriptors.size) absent('resource-window-lifecycle-binding-unavailable');
  const continuousCpu = replayCombinedCpu(samples, summary, sampling, lifecycle, raw.processIdentity, artifact, absent);
  const appOwned = replayAppOwnership(samples, summary, sampling, continuousCpu.observationWindow, raw.processIdentity, artifact, absent);
  if (!observed.complete) absent('actual-resource-observations-incomplete');
  // The v1 global ownership gap remains disclosed in missing and its producer
  // flags remain false. Only the independently reviewed app scope can supply
  // this scoped allocation requirement; it does not supply missing RSS data.
  const requiresCompletion = reason => !(reason === 'complete-browser-cpu-owner-coverage-unavailable' && appOwned.appOwnedCpu?.complete === true);
  const requiredMissing = missing.filter(reason => requiresCompletion(reason) && !partialLifecycle.has(reason));
  if (sampling.complete === true && requiredMissing.length) throw Error('Complete resource sampling lacks required raw peak or window witnesses: ' + requiredMissing.join(', '));
  return { complete: sampling.complete === true && !missing.some(requiresCompletion), missing: [...new Set(missing)], samples,
    peaks: observed.peaks, peakSamples: observed.peakSamples, textureLimits: observed.textureLimits, ...continuousCpu, ...appOwned };
}

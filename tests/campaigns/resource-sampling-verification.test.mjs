import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../tooling/qualification/campaigns/common.mjs';
import { createResourceObservationSummary } from '../../tooling/qualification/campaigns/resource-observations.mjs';
import { verifyResourceSamplingEvidence, appOwnedCpuCandidate } from '../../tooling/qualification/campaigns/resource-sampling-verification.mjs';
import { appOwnershipSpecimen } from './app-ownership-specimen.mjs';
import { RESOURCE_SAMPLE_CODEC, encodeBrowserResourceSample } from '../../tooling/qualification/campaigns/resource-sample-codec.mjs';

const clone = structuredClone;
const descriptorKeys = ['kind', 'id', 'cycleOrdinal', 'processIdentity', 'startMs', 'endMs', 'firstOrdinal', 'lastOrdinal', 'sampleCount', 'complete', 'missing'];
const descriptor = window => Object.fromEntries(descriptorKeys.map(key => [key, window[key]]));
function aggregate(samples) { const summary = createResourceObservationSummary(); for (const sample of samples) summary.add(sample); return summary.snapshot(); }
function seal(state) {
  state.bytes = Buffer.from(JSON.stringify(state.raw));
  state.sampling.artifact = { path: '/retained/browser-resources-specimen.json', bytes: state.bytes.length, confirmedBytesWritten: state.bytes.length, sha256: digest(state.bytes) };
  state.sampling.sha256 = state.sampling.artifact.sha256;
  return state;
}

// Tiny fabricated serialization specimens exercise the verifier, not real OS
// observations, elapsed lifecycle idles, or product qualification.
function specimen({ textureViolation = false, incomplete = false } = {}) {
  const roots = ['worker', 'browser', 'backend'].map((kind, index) => ({ kind, pid: index + 10, pgid: index + 10, startedAtIdentity: 'Wed Sep 30 12:00:00 2026' }));
  const processIdentity = digest({ schema: 'browser-resource-process-identity-1', roots });
  const times = [0, 100, 110, 130, 150, 160, 190], kinds = ['scheduled', 'scheduled', 'window-start', 'manual', 'manual', 'window-end', 'final'];
  const samples = times.map((startMs, index) => ({ ordinal: index + 1, kind: kinds[index], sampleAtMs: startMs,
    observation: { startMs, endMs: startMs + 1 }, processIdentity,
    browserRssBytes: 20 + index, backendRssBytes: 10, settledBytes: 30 + index, cpuBytes: [5, 10, 12, 99, 99, 6, 4][index], gpuBytes: 8,
    previewCacheBytes: 4, unusedHandles: 0, textureSide: textureViolation && index === 3 ? 1500 : 1024,
    deviceTextureLimit: textureViolation && index === 3 ? 1000 : index === 2 ? 4096 : 2048,
    allocationCoverage: { complete: true, cpu: true, gpu: true, previewCache: true, handles: true, textureLimits: true },
    rendererOwnership: null, rendererOwnershipProof: null, browserProcesses: [], backendProcesses: [], missing: [], forcedGC: false }));
  if (incomplete) { samples[3].cpuBytes = null; samples[3].allocationCoverage.complete = false; samples[3].missing = ['cpu-observation-unavailable']; }
  const whole = aggregate(samples), selected = aggregate(samples.slice(2, 6));
  const window = { kind: 'resource-observation-window-1', id: 'cycle-window-1', cycleOrdinal: 1, processIdentity, startMs: 109, endMs: 162, ...selected, missing: [] };
  const summary = { kind: 'attributed-process-tree-and-allocation-ledger', processIdentity, roots: clone(roots), intervalMs: 100,
    startMs: 0, endMs: 195, counts: { samples: 7, scheduled: 2, manual: 5, missedIntervals: 0, failedSamples: incomplete ? 1 : 0 },
    maximumGapMs: 100, maximumSampleDurationMs: 1, peaks: whole.peaks, peakSamples: whole.peakSamples, textureLimits: whole.textureLimits,
    windows: [descriptor(window)], missing: incomplete ? ['complete-product-allocation-ledger-unavailable'] : [],
    clock: 'runner-monotonic', observedPeaksAreSampled: true, forcedGC: false };
  const raw = { schema: 'browser-resource-samples-1', intervalMs: 100, processIdentity, roots, startMs: 0, samples,
    identities: [], summary: { ...clone(summary), dataComplete: !incomplete } };
  const sampling = { ...clone(summary), complete: !incomplete };
  const lifecycle = { status: 'PASS', B0: { resources: clone(samples[1]) }, cycles: [{ ordinal: 1, startMs: 105, endMs: 170,
    action: { startMs: 113, endMs: 140 }, observation: { startMs: 149, endMs: 152 },
    resources: clone(samples[4]), resourceObservation: { resources: clone(samples[4]) }, resourceWindow: clone(window), resourceSamples: clone(window.samples) }] };
  return seal({ raw, sampling, lifecycle });
}
const verify = state => verifyResourceSamplingEvidence(state.bytes, state.sampling, { lifecycle: state.lifecycle });

test('resource replay returns original first-maximum samples and exact cycle windows', () => {
  const state = specimen(), result = verify(state);
  assert.equal(result.complete, true);
  assert.equal(result.peaks.cpuBytes, 99);
  assert.equal(result.peakSamples.cpuBytes.ordinal, 4);
  assert.deepEqual(result.peakSamples.cpuBytes, state.raw.samples[3]);
  assert.deepEqual(result.textureLimits, { complete: true, observedSamples: 7, violations: 0, notApplicableSamples: 0 });
});

test('resource replay rejects altered or unsealed artifact bytes', () => {
  const state = specimen();
  assert.throws(() => verifyResourceSamplingEvidence(Buffer.concat([state.bytes, Buffer.from(' ')]), state.sampling, { lifecycle: state.lifecycle }), /artifact/);
  state.sampling.sha256 = digest('another artifact');
  assert.throws(() => verify(state), /artifact/);
});

test('resource replay rejects resealed ordinal, process identity and time contradictions', () => {
  for (const change of [
    state => { state.raw.samples[3].ordinal = 3; },
    state => { state.raw.samples[3].processIdentity = digest('another owner'); },
    state => { state.raw.samples[3].sampleAtMs++; },
    state => { state.raw.samples[3].observation.endMs = 129; },
    state => { state.raw.samples[3].observation.endMs = 151; },
    state => { state.raw.summary.endMs = 180; state.sampling.endMs = 180; },
  ]) {
    const state = specimen(); change(state); seal(state);
    assert.throws(() => verify(state), Error);
  }
});

test('resource replay derives numeric maxima even after raw and returned summaries are both resealed', () => {
  const state = specimen();
  state.raw.summary.peaks.cpuBytes = state.sampling.peaks.cpuBytes = 1;
  seal(state); assert.throws(() => verify(state), /peaks/);
});

test('a later tied maximum cannot replace the first actual maximum witness', () => {
  const state = specimen();
  state.raw.summary.peakSamples.cpuBytes = clone(state.raw.samples[4]);
  state.sampling.peakSamples.cpuBytes = clone(state.raw.samples[4]);
  seal(state); assert.throws(() => verify(state), /peakSamples/);
});

test('composite peak observations cannot replace an actual retained sample', () => {
  const state = specimen();
  const composite = { ...clone(state.raw.samples[3]), browserRssBytes: state.sampling.peaks.browserRssBytes };
  state.raw.summary.peakSamples.cpuBytes = clone(composite); state.sampling.peakSamples.cpuBytes = composite;
  seal(state); assert.throws(() => verify(state), /peakSamples/);
});

test('texture limit replay detects the violating original pair despite safe independent maxima', () => {
  const state = specimen({ textureViolation: true }), result = verify(state);
  assert.equal(result.peaks.textureSide, 1500);
  assert.equal(result.peaks.deviceTextureLimit, 4096);
  assert.equal(result.textureLimits.violations, 1);
  assert(state.lifecycle.cycles[0].resourceSamples.some(sample => sample.ordinal === 4));
  state.raw.summary.textureLimits.violations = state.sampling.textureLimits.violations = 0;
  seal(state); assert.throws(() => verify(state), /textureLimits/);
});

test('resource sample counts and measured gap/duration summaries must reproduce raw rows', () => {
  for (const key of ['samples', 'scheduled', 'manual', 'failedSamples']) {
    const state = specimen(); state.raw.summary.counts[key]++; state.sampling.counts[key]++;
    seal(state); assert.throws(() => verify(state), /count/);
  }
  for (const key of ['maximumGapMs', 'maximumSampleDurationMs']) {
    const state = specimen(); state.raw.summary[key]++; state.sampling[key]++;
    seal(state); assert.throws(() => verify(state), /actual sample intervals/);
  }
});

test('B0, settled cycle and selected witnesses must be exact original raw members', () => {
  for (const locate of [
    state => state.lifecycle.B0.resources,
    state => state.lifecycle.cycles[0].resources,
    state => state.lifecycle.cycles[0].resourceObservation.resources,
    state => state.lifecycle.cycles[0].resourceSamples[0],
  ]) {
    const state = specimen(); locate(state).cpuBytes++;
    assert.throws(() => verify(state), /original resource sample/);
  }
});

test('cycle window bounds cannot drop an interior sample or exclude the actual action', () => {
  for (const change of [
    state => { state.lifecycle.cycles[0].resourceWindow.sampleCount--; },
    state => { state.lifecycle.cycles[0].resourceWindow.startMs = 111; },
    state => { state.lifecycle.cycles[0].action.startMs = 108; },
    state => { state.lifecycle.cycles[0].observation.endMs = 163; },
    state => { state.raw.summary.windows[0].lastOrdinal = 5; state.sampling.windows[0].lastOrdinal = 5; },
  ]) {
    const state = specimen(); change(state); seal(state);
    assert.throws(() => verify(state), /window/i);
  }
});

test('window peak and selected-point summaries cannot be reconstructed from invented points', () => {
  for (const change of [
    window => { window.peaks.cpuBytes = 0; },
    window => { window.peakSamples.cpuBytes = clone(window.samples[0]); },
    window => { window.samples = window.samples.filter(sample => sample.ordinal !== 4); },
    window => { window.textureLimits.observedSamples--; },
  ]) {
    const state = specimen(); change(state.lifecycle.cycles[0].resourceWindow);
    assert.throws(() => verify(state), /window/);
  }
});

test('first incomplete actual observations remain selected and never become complete evidence', () => {
  const state = specimen({ incomplete: true }), result = verify(state);
  assert.equal(result.complete, false);
  assert(result.missing.includes('actual-resource-observations-incomplete'));
  assert(state.lifecycle.cycles[0].resourceWindow.samples.some(sample => sample.ordinal === 4));
  state.sampling.complete = true;
  assert.throws(() => verify(state), /Complete resource sampling/);
});

test('legacy incomplete evidence remains retainable without new peak/window fields', () => {
  const state = specimen(); state.sampling.complete = false; state.raw.summary.dataComplete = false;
  for (const key of ['peakSamples', 'textureLimits', 'windows']) { delete state.sampling[key]; delete state.raw.summary[key]; }
  delete state.lifecycle.cycles[0].resourceWindow;
  seal(state);
  const result = verify(state);
  assert.equal(result.complete, false);
  assert(result.missing.includes('resource-peakSamples-witness-unavailable'));
  assert(result.missing.includes('cycle-1-resource-window-unavailable'));
  state.sampling.complete = true; state.raw.summary.dataComplete = true; seal(state);
  assert.throws(() => verify(state), /lacks required raw peak or window witnesses/);
});

test('retained footer windows require matching cycle identities and cannot be silently orphaned', () => {
  const state = specimen(); state.lifecycle.cycles[0].ordinal = 2;
  assert.throws(() => verify(state), /matching|differs/);
  const orphaned = specimen(); orphaned.lifecycle.cycles = [];
  assert.throws(() => verify(orphaned), /no matching lifecycle cycle/);
});

test('incomplete byte-limited evidence may retain higher attempted counters but never lower retained totals', () => {
  const state = specimen(); state.sampling.complete = false; state.raw.summary.dataComplete = false;
  state.sampling.counts.manual++; state.raw.summary.counts.manual++;
  state.sampling.maximumSampleDurationMs = state.raw.summary.maximumSampleDurationMs = 2;
  state.sampling.missing = state.raw.summary.missing = ['resource-byte-limit'];
  seal(state);
  const result = verify(state);
  assert.equal(result.complete, false);
  assert(result.missing.includes('unretained-resource-attempt-count:manual'));
  assert(result.missing.includes('unretained-resource-attempt-duration:maximumSampleDurationMs'));
  state.sampling.counts.manual = state.raw.summary.counts.manual = 4; seal(state);
  assert.throws(() => verify(state), /underreports retained observations/);
});

test('actual failed actions may retain a complete resource stream without a settled B_i claim', () => {
  const state = specimen(); state.lifecycle.status = 'FAIL';
  const cycle = state.lifecycle.cycles[0]; cycle.error = { message: 'Actual action failed' };
  delete cycle.resources; delete cycle.resourceObservation; delete cycle.observation; delete cycle.action;
  const result = verify(state);
  assert.equal(result.complete, false);
  assert(result.missing.includes('cycle-1-resources-raw-member-unavailable'));
  state.lifecycle.status = 'PASS';
  assert.throws(() => verify(state), /lacks required raw peak or window witnesses/);
});

test('an incomplete cycle endpoint cannot qualify through an otherwise complete stream', () => {
  const state = specimen(), cycle = state.lifecycle.cycles[0];
  cycle.resourceWindow.complete = false;
  cycle.resourceWindow.missing = ['resource-window-endpoint-unavailable'];
  state.raw.summary.windows = state.sampling.windows = [descriptor(cycle.resourceWindow)];
  seal(state);
  assert.throws(() => verify(state), /resource-window-incomplete/);
  state.lifecycle.status = 'FAIL'; cycle.error = { message: 'Actual action failed' };
  const retained = verify(state);
  assert.equal(retained.complete, false);
  assert(retained.missing.includes('cycle-1-resource-window-incomplete'));
});

test('bound exhaustion preserves an exact earlier sample without inventing a later empty-window peak', () => {
  const state = specimen(), prior = clone(state.raw.samples.at(-1));
  const window = { kind: 'resource-observation-window-1', id: 'cycle-window-2', cycleOrdinal: 2,
    processIdentity: state.raw.processIdentity, startMs: 201, endMs: 210, ...aggregate([]), missing: [] };
  state.lifecycle.cycles.push({ ordinal: 2, startMs: 200, endMs: 212, action: { startMs: 202, endMs: 205 },
    observation: { startMs: 206, endMs: 208 }, resources: prior, resourceObservation: { resources: clone(prior) },
    resourceWindow: window, resourceSamples: [] });
  state.sampling.complete = false; state.raw.summary.dataComplete = false;
  state.sampling.endMs = state.raw.summary.endMs = 215;
  state.sampling.missing = state.raw.summary.missing = ['resource-sample-limit'];
  state.sampling.windows.push(descriptor(window)); state.raw.summary.windows.push(descriptor(window));
  seal(state);
  const retained = verify(state);
  assert.equal(retained.complete, false);
  assert(retained.missing.includes('cycle-2-settled-resource-outside-window'));
  assert.equal(window.peaks.cpuBytes, null);
  assert.deepEqual(window.samples, []);
  state.lifecycle.cycles[1].resources.cpuBytes++;
  assert.throws(() => verify(state), /original resource sample/);
});

const ownershipGaps = ['app-payload-ownership-incomplete', 'native-image-and-canvas-implementation-overhead', 'native-blob-residency', 'engine-and-dom-allocations', 'renderer-ownership-proof-required'];
const cpuScope = 'independent-B0-browser-cpu-window';
function refreshCpuSpecimen(state) {
  const samples = state.raw.samples, whole = aggregate(samples), selected = aggregate(samples.slice(2, 6));
  const cycle = state.lifecycle.cycles[0], window = { kind: 'resource-observation-window-1', id: 'cycle-window-1', cycleOrdinal: 1,
    processIdentity: state.raw.processIdentity, startMs: 109, endMs: 162, ...selected, missing: [] };
  cycle.resources = clone(samples[4]); cycle.resourceObservation.resources = clone(samples[4]);
  cycle.resourceWindow = clone(window); cycle.resourceSamples = clone(window.samples);
  state.lifecycle.B0.resources = clone(samples[1]);
  for (const summary of [state.raw.summary, state.sampling]) {
    summary.peaks = clone(whole.peaks); summary.peakSamples = clone(whole.peakSamples); summary.textureLimits = clone(whole.textureLimits);
    summary.windows = [descriptor(window)]; summary.counts = { samples: samples.length, scheduled: 2, manual: 5, missedIntervals: 0, failedSamples: samples.filter(row => row.missing.length).length };
    summary.maximumGapMs = 130;
  }
  const begin = samples[1], end = samples[6], w = end.combinedCpu?.window;
  const observationWindow = begin.cpuWindowAck ? { scope: cpuScope, id: begin.combinedCpu.window.id, processIdentity: state.raw.processIdentity,
    ledgerInstanceId: begin.combinedCpu.ledgerInstanceId, startSourceOrdinal: begin.ordinal, endSourceOrdinal: end.cpuWindowAck ? end.ordinal : null,
    startObservation: begin.observation, endObservation: end.cpuWindowAck ? end.observation : null, beginAck: begin.cpuWindowAck, endAck: end.cpuWindowAck } : null;
  state.raw.summary.observationWindow = clone(observationWindow); state.sampling.observationWindow = clone(observationWindow);
  const peak = observationWindow?.endAck ? { kind: 'owned-allocation-continuous-peak-1', scope: cpuScope, value: w.peakBytes,
    processIdentity: state.raw.processIdentity, sharedIdentity: w.ledgerInstanceId, sequence: w.endSequence, sourceOrdinal: end.ordinal,
    observation: end.observation, windowId: w.id, window: w, ownerCoverageComplete: false, complete: false, artifact: null } : null;
  state.raw.summary.allocationPeaks = peak ? { cpuBytes: clone(peak) } : {};
  seal(state);
  const artifact = state.sampling.artifact;
  state.sampling.allocationPeaks = peak ? { cpuBytes: { ...clone(peak), artifact: { path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 } } } : {};
  return state;
}

function cpuSpecimen({ peak = 600 * 1024 ** 2, fault = null } = {}) {
  const state = specimen(), ledgerInstanceId = '7d11dc38-3c12-4a97-836f-61ecb6a22db1', id = 'cpu-window-1';
  const processIdentity = state.raw.processIdentity;
  state.raw.samples[1].kind = 'manual'; state.raw.samples[3].kind = 'scheduled';
  state.sampling.complete = false; state.raw.summary.dataComplete = false;
  state.sampling.missing = state.raw.summary.missing = ['complete-product-allocation-ledger-unavailable', 'complete-continuous-browser-cpu-window-unavailable'];
  state.raw.summary.cpuWindowCleanup = { attempted: false, complete: false, ack: null, error: null };
  state.sampling.cpuWindowCleanup = clone(state.raw.summary.cpuWindowCleanup);
  state.lifecycle.B0.observation = { startMs: 99, endMs: 102 }; state.lifecycle.endMs = 195;
  state.raw.samples.forEach((sample, index) => {
    const sealed = index === 6, maximum = index < 3 ? sample.cpuBytes : peak;
    const window = index === 0 ? null : { kind: 'combined-cpu-window-1', schemaVersion: 1, ledgerInstanceId, id, ordinal: 1,
      clock: 'browser-performance', clockOriginMs: 1234567890, startMs: 5, endMs: sealed ? 80 : null,
      peakAtMs: index < 3 ? index === 1 ? 5 : 20 : 40, startSequence: 11, endSequence: sealed ? 16 : null,
      peakSequence: index < 3 ? index + 10 : 13, currentBytes: sample.cpuBytes, peakBytes: maximum,
      ledgerBytesAtPeak: maximum - 4, textBytesAtPeak: 4, textStartSequence: 20, textEndSequence: sealed ? 26 : null,
      sealed, observationComplete: fault === null, ownerCoverageComplete: false, failures: fault ? [fault] : [], missing: clone(ownershipGaps) };
    sample.combinedCpu = { kind: 'combined-cpu-observation-1', schemaVersion: 1, scope: 'browser-ledger-plus-text-reservations',
      ledgerInstanceId, sequence: index + 10, currentBytes: sample.cpuBytes, observedPeakBytes: 2 * 1024 ** 3,
      observationComplete: false, ownerCoverageComplete: false, missing: clone(ownershipGaps), window };
    sample.cpuWindowBoundary = index === 1 ? 'begin' : sealed ? 'end' : null;
    sample.cpuWindowAck = sample.cpuWindowBoundary ? { kind: 'combined-cpu-window-ack-1', schemaVersion: 1,
      ledgerInstanceId, id, ordinal: 1, boundary: sample.cpuWindowBoundary, sequence: sealed ? 16 : 11,
      atMs: sealed ? 80 : 5, clock: 'browser-performance', clockOriginMs: 1234567890, sealed } : null;
    sample.allocationCoverage.complete = false; sample.allocationCoverage.cpu = false;
    sample.missing = ['complete-product-allocation-ledger-unavailable']; sample.processIdentity = processIdentity;
  });
  return refreshCpuSpecimen(state);
}

test('combined CPU replay retains a genuine scoped lower bound separately from lifetime and sampled peaks', () => {
  const state = cpuSpecimen(), result = verify(state);
  assert.equal(result.complete, false);
  assert.equal(result.continuousCpuLowerBound, 600 * 1024 ** 2);
  assert.equal(result.allocationPeaks.cpuBytes.value, 600 * 1024 ** 2);
  assert.equal(result.allocationPeaks.cpuBytes.complete, false);
  assert.equal(result.allocationPeaks.cpuBytes.ownerCoverageComplete, false);
  assert.equal(result.peaks.cpuBytes, 99); assert.equal(result.peakSamples.cpuBytes.ordinal, 4);
  assert.notEqual(result.continuousCpuLowerBound, state.raw.samples.at(-1).combinedCpu.observedPeakBytes);
  assert(result.missing.includes('complete-browser-cpu-owner-coverage-unavailable'));
  assert.deepEqual(result.samples, state.raw.samples);
});

test('an under-ceiling combined observation still cannot prove complete owner coverage', () => {
  const result = verify(cpuSpecimen({ peak: 100 }));
  assert.equal(result.continuousCpuLowerBound, 100); assert.equal(result.complete, false);
  assert.equal(result.allocationPeaks.cpuBytes.complete, false);
});

test('returned CPU seal and raw footer must bind the actual final sample in both directions', () => {
  for (const mutate of [
    state => { state.sampling.allocationPeaks.cpuBytes.artifact.sha256 = digest('other artifact'); },
    state => { state.sampling.allocationPeaks.cpuBytes.value++; },
    state => { state.raw.summary.allocationPeaks.cpuBytes.value++; seal(state); },
    state => { state.raw.summary.observationWindow.endSourceOrdinal--; seal(state); },
    state => { state.sampling.observationWindow.startObservation.endMs++; },
  ]) {
    const state = cpuSpecimen(); mutate(state);
    assert.throws(() => verify(state), /CPU|artifact seal/);
  }
});

test('resealed combined identities, arithmetic and boundary ACK contradictions are refused', () => {
  for (const mutate of [
    sample => { sample.combinedCpu.ledgerInstanceId = 'different-ledger'; },
    sample => { sample.combinedCpu.window.id = 'another-window'; },
    sample => { sample.combinedCpu.window.clockOriginMs++; },
    sample => { sample.combinedCpu.window.ledgerBytesAtPeak++; },
    sample => { sample.combinedCpu.window.peakSequence = 99; },
    sample => { sample.combinedCpu.window.endSequence = 12; },
    sample => { sample.combinedCpu.window.textEndSequence = 1; },
    sample => { sample.cpuWindowAck.sequence--; },
    sample => { sample.cpuWindowAck.atMs--; },
    sample => { sample.cpuWindowAck.clockOriginMs++; },
  ]) {
    const state = cpuSpecimen(); mutate(state.raw.samples.at(-1)); refreshCpuSpecimen(state);
    assert.throws(() => verify(state), /CPU/);
  }
});

test('complete owner or undeclared clean-observation claims never survive replay', () => {
  for (const mutate of [
    sample => { sample.combinedCpu.ownerCoverageComplete = true; },
    sample => { sample.combinedCpu.observationComplete = true; },
    sample => { sample.combinedCpu.window.ownerCoverageComplete = true; },
    sample => { sample.combinedCpu.window.failures = ['text-observer-fault']; },
    sample => { sample.combinedCpu.window.missing = []; },
    sample => { sample.combinedCpu.window.unknownProof = true; },
  ]) {
    const state = cpuSpecimen(); mutate(state.raw.samples.at(-1)); refreshCpuSpecimen(state);
    assert.throws(() => verify(state), /CPU/);
  }
  const state = cpuSpecimen(); state.sampling.complete = true;
  assert.throws(() => verify(state), /Complete resource sampling/);
});

test('peak history cannot regress or replace a tied actual witness between samples', () => {
  for (const mutate of [
    sample => { sample.combinedCpu.window.peakBytes--; sample.combinedCpu.window.ledgerBytesAtPeak--; },
    sample => { sample.combinedCpu.window.peakAtMs++; },
    sample => { sample.combinedCpu.sequence = 1; },
  ]) {
    const state = cpuSpecimen(); mutate(state.raw.samples[4]); refreshCpuSpecimen(state);
    assert.throws(() => verify(state), /CPU/);
  }
});

test('a retained producer fault preserves diagnostics but supplies no scored continuous lower bound', () => {
  const state = cpuSpecimen({ fault: 'text-sequence-discontinuity' });
  state.raw.samples.at(-1).combinedCpu.window.textEndSequence = 0;
  refreshCpuSpecimen(state);
  const result = verify(state);
  assert.equal(result.continuousCpuLowerBound, null);
  assert.equal(result.allocationPeaks.cpuBytes.value, 600 * 1024 ** 2);
  assert(result.missing.includes('continuous-browser-cpu-observation-incomplete'));
  const clock = cpuSpecimen({ fault: 'clock-invalid' });
  for (const sample of clock.raw.samples.slice(3)) sample.combinedCpu.window.peakAtMs = 1;
  refreshCpuSpecimen(clock);
  assert.equal(verify(clock).continuousCpuLowerBound, null);
});

test('missing end acknowledgement preserves only the actual partial start', () => {
  const state = cpuSpecimen(); state.raw.samples.at(-1).cpuWindowAck = null; refreshCpuSpecimen(state);
  const result = verify(state);
  assert.equal(result.observationWindow.startSourceOrdinal, 2); assert.equal(result.observationWindow.endSourceOrdinal, null);
  assert.equal(result.continuousCpuLowerBound, null); assert.deepEqual(result.allocationPeaks, {});
  assert(result.missing.includes('continuous-browser-cpu-window-end-unavailable'));
});

test('missing begin acknowledgement never borrows a sealed lifetime or later window', () => {
  const state = cpuSpecimen(); state.raw.samples[1].cpuWindowAck = null; refreshCpuSpecimen(state);
  const result = verify(state);
  assert.equal(result.observationWindow, null); assert.equal(result.continuousCpuLowerBound, null);
  assert.deepEqual(result.allocationPeaks, {});
});

test('best-effort CPU cleanup cannot become an unretained final sample or scored peak', () => {
  const state = cpuSpecimen(), ack = clone(state.raw.samples.at(-1).cpuWindowAck);
  state.raw.samples.at(-1).cpuWindowAck = null;
  state.raw.summary.cpuWindowCleanup = { attempted: true, complete: true, ack, error: null };
  state.sampling.cpuWindowCleanup = clone(state.raw.summary.cpuWindowCleanup); refreshCpuSpecimen(state);
  const result = verify(state);
  assert.equal(result.cpuWindowCleanup.complete, true); assert.equal(result.observationWindow.endSourceOrdinal, null);
  assert.equal(result.continuousCpuLowerBound, null); assert.deepEqual(result.allocationPeaks, {});
  state.sampling.cpuWindowCleanup.ack.id = 'another-window';
  assert.throws(() => verify(state), /cleanup/);
});

test('resealed cleanup from another ledger cannot close a retained partial CPU window', () => {
  const state = cpuSpecimen(), ack = clone(state.raw.samples.at(-1).cpuWindowAck);
  state.raw.samples.at(-1).cpuWindowAck = null; ack.ledgerInstanceId = '7d11dc38-3c12-4a97-836f-61ecb6a22db2';
  state.raw.summary.cpuWindowCleanup = { attempted: true, complete: true, ack, error: null };
  state.sampling.cpuWindowCleanup = clone(state.raw.summary.cpuWindowCleanup); refreshCpuSpecimen(state);
  assert.throws(() => verify(state), /cleanup belongs to another window/);
});

test('CPU runner brackets bind exact B0 and final join without converting browser clocks', () => {
  for (const mutate of [
    state => { state.lifecycle.B0.observation.startMs = 101; },
    state => { state.lifecycle.B0.resources = clone(state.raw.samples[0]); },
    state => { state.lifecycle.cycles[0].endMs = 192; },
    state => { state.lifecycle.endMs = 189; },
    state => { state.raw.samples[4].cpuWindowBoundary = 'end'; refreshCpuSpecimen(state); },
  ]) {
    const state = cpuSpecimen(); mutate(state);
    assert.throws(() => verify(state), /CPU/);
  }
  const state = cpuSpecimen();
  const result = verifyResourceSamplingEvidence(state.bytes, state.sampling);
  assert.equal(result.continuousCpuLowerBound, null);
  assert(result.missing.includes('continuous-browser-cpu-lifecycle-binding-unavailable'));
});

function sealAppSpecimen(state) {
  seal(state);
  const { path, bytes, sha256 } = state.sampling.artifact;
  if (state.sampling.allocationPeaks?.cpuBytes) state.sampling.allocationPeaks.cpuBytes.artifact = { path, bytes, sha256 };
  state.sampling.appOwnedCpu = state.raw.summary.appOwnedCpu ? { ...clone(state.raw.summary.appOwnedCpu), artifact: { path, bytes, sha256 } } : null;
  return state;
}
function refreshAppSpecimen(state) {
  refreshCpuSpecimen(state);
  state.raw.summary.appOwnedCpu = appOwnedCpuCandidate(state.raw.samples[1], state.raw.samples.at(-1), state.raw.processIdentity, state.sampling.observationWindow);
  return sealAppSpecimen(state);
}
function appSpecimen({ peak = 100, initialCpuBytes = 10 } = {}) {
  const state = cpuSpecimen({ peak });
  for (const [index, sample] of state.raw.samples.entries()) {
    if (initialCpuBytes !== 10 && index >= 1) {
      sample.combinedCpu.sequence++;
      sample.combinedCpu.window.peakSequence++;
      if (index === 1) sample.combinedCpu.window.peakAtMs++;
      if (sample.combinedCpu.window.sealed) { sample.combinedCpu.window.endSequence++; sample.cpuWindowAck.sequence++; }
    }
    sample.appOwnership = appOwnershipSpecimen(sample.combinedCpu, { initialCpuBytes, transitionCount: [0, 0, 1, 3, 3, 4, 5][index] + (initialCpuBytes === 10 ? 0 : 1) });
    sample.globalAllocationCoverage = { complete: false, cpu: false, gpu: false, previewCache: false, handles: false, textureLimits: false };
  }
  return refreshAppSpecimen(state);
}

test('app-owned replay retains exact unsigned boundary observations without global promotion', () => {
  const state = appSpecimen(), result = verify(state), candidate = result.appOwnedCpu;
  assert(candidate); assert.equal(candidate.complete, false); assert.equal(result.complete, false);
  assert.equal(candidate.value, 100); assert.equal(result.continuousCpuLowerBound, 100);
  assert.deepEqual(candidate.start.appOwnership, state.raw.samples[1].appOwnership);
  assert.deepEqual(candidate.end.combinedCpu, state.raw.samples.at(-1).combinedCpu);
  assert.equal(state.raw.summary.appOwnedCpu.artifact, null);
  assert.deepEqual(candidate.artifact, { path: state.sampling.artifact.path, bytes: state.sampling.artifact.bytes, sha256: state.sampling.artifact.sha256 });
  assert(result.missing.includes('reviewed-app-owned-cpu-coverage-unavailable'));
  assert.equal(state.raw.samples[1].appOwnership.globalCoverageComplete, undefined);
  assert.equal(state.raw.samples[1].appOwnership.point.globalCoverageComplete, false);
  assert.equal(state.raw.samples[1].globalAllocationCoverage.complete, false);
});

test('B0 read owners may mutate after the exact begin ACK without moving the boundary', () => {
  const state = appSpecimen({ initialCpuBytes: 8 }), result = verify(state);
  assert(result.appOwnedCpu); assert.equal(result.appOwnedCpu.complete, false);
  const row = result.appOwnedCpu.start.appOwnership.window.kinds.find(value => value.kind === 'prompt');
  assert.notDeepEqual(row.initial, row.current);
  assert.equal(result.appOwnedCpu.start.combinedCpu.window.startSequence, state.raw.samples[1].cpuWindowAck.sequence);
  assert(result.appOwnedCpu.start.combinedCpu.sequence > state.raw.samples[1].cpuWindowAck.sequence);
  assert(result.appOwnedCpu.start.combinedCpu.window.peakSequence > state.raw.samples[1].cpuWindowAck.sequence);
});

test('app-owned replay refuses resealed kind, sequence, amount and source contradictions', () => {
  for (const mutate of [
    app => { app.window.kinds.pop(); },
    app => { app.window.kinds[1].kind = app.window.kinds[0].kind; },
    app => { app.window.kinds[8].added.cpuBytes++; },
    app => { app.window.kinds[8].transitions.observed++; },
    app => { app.point.totals.cpuBytes++; },
    app => { app.window.cpuEndSequence--; },
    app => { app.window.text.endSequence--; },
    app => { app.window.globalCoverageComplete = true; },
    app => { app.point.globalCoverageComplete = true; },
    app => { app.window.kinds[8].current.records = -1; },
    app => { app.window.extraApproval = true; },
  ]) {
    const state = appSpecimen(); mutate(state.raw.samples.at(-1).appOwnership); refreshAppSpecimen(state);
    assert.throws(() => verify(state), /ownership|App-owned|application/i);
  }
});

test('app-owned candidate cannot exchange original endpoints, proofs, seals or approval flags', () => {
  for (const mutate of [
    state => { state.raw.summary.appOwnedCpu.complete = true; },
    state => { state.raw.summary.appOwnedCpu.endSourceOrdinal--; },
    state => { state.raw.summary.appOwnedCpu.start.appOwnership.point.totals.cpuBytes++; },
    state => { state.raw.summary.appOwnedCpu.value++; },
  ]) {
    const state = appSpecimen(); state.raw.summary.appOwnedCpu = clone(state.raw.summary.appOwnedCpu); mutate(state); sealAppSpecimen(state);
    assert.throws(() => verify(state), /app-owned CPU/i);
  }
  const changedSeal = appSpecimen(); changedSeal.sampling.appOwnedCpu.artifact.sha256 = digest('other resource bytes');
  assert.throws(() => verify(changedSeal), /app-owned CPU/i);
  const changedProof = appSpecimen(); changedProof.raw.samples.at(-1).rendererOwnershipProof = { kind: 'renderer-ownership-proof-2', reviewId: 'not-approved' }; refreshAppSpecimen(changedProof);
  assert.equal(verify(changedProof).appOwnedCpu, null);
});

test('absent app witnesses preserve v1 CPU failure evidence and never require a legacy schema upgrade', () => {
  assert.equal(appOwnedCpuCandidate({ combinedCpu: { malformedLegacy: true } }, null, 'legacy', null), null);
  const legacy = verify(cpuSpecimen()); assert.equal(legacy.appOwnedCpu, null);
  assert.equal(legacy.continuousCpuLowerBound, 600 * 1024 ** 2);
  const state = appSpecimen({ peak: 600 * 1024 ** 2 });
  state.raw.samples.at(-1).appOwnership = null; refreshAppSpecimen(state);
  const result = verify(state); assert.equal(result.appOwnedCpu, null); assert.equal(result.complete, false);
  assert.equal(result.continuousCpuLowerBound, 600 * 1024 ** 2);
});

function codecSpecimen() {
  const state = appSpecimen();
  for (const sample of state.raw.samples) sample.documentLifecycle = null;
  refreshAppSpecimen(state);
  state.originalSamples = clone(state.raw.samples);
  state.raw.schema = 'browser-resource-samples-2'; state.raw.sampleCodec = RESOURCE_SAMPLE_CODEC;
  state.raw.sampleContext = { processIdentity: state.raw.processIdentity, rendererOwnershipProof: null };
  state.raw.samples = state.raw.samples.map(sample => encodeBrowserResourceSample(sample, state.raw.sampleContext));
  return sealAppSpecimen(state);
}

test('versioned tuple retention replays exactly the original samples and unsigned app scope', () => {
  const state = codecSpecimen(), result = verify(state);
  assert.deepEqual([...result.samples], state.originalSamples);
  assert.equal(result.appOwnedCpu.complete, false); assert.equal(result.complete, false);
  assert.equal(result.appOwnedCpu.value, 100); assert.equal(result.continuousCpuLowerBound, 100);
  assert.equal(state.raw.samples.every(Array.isArray), true);
  assert.deepEqual(result.appOwnedCpu.artifact, { path: state.sampling.artifact.path, bytes: state.sampling.artifact.bytes, sha256: state.sampling.artifact.sha256 });
});

test('tuple retention refuses unknown codecs, substituted contexts and malformed rows', () => {
  for (const mutate of [
    state => { state.raw.schema = 'browser-resource-samples-3'; },
    state => { state.raw.sampleCodec = 'unknown-sample-codec'; },
    state => { state.raw.sampleContext.processIdentity = digest('another process'); },
    state => { state.raw.sampleContext.extraApproval = true; },
    state => { state.raw.samples[0].pop(); },
    state => { state.raw.samples[0].push(null); },
    state => { state.raw.samples[0] = state.originalSamples[0]; },
  ]) {
    const state = codecSpecimen(); mutate(state); sealAppSpecimen(state);
    assert.throws(() => verify(state), Error);
  }
});

test('a valid tuple encoding cannot bypass the original retained-sample equality checks', () => {
  const state = codecSpecimen(), changed = clone(state.originalSamples[3]);
  changed.appOwnership.point.totals.cpuBytes++;
  state.raw.samples[3] = encodeBrowserResourceSample(changed, state.raw.sampleContext);
  sealAppSpecimen(state);
  assert.throws(() => verify(state), Error);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBrowserResourceSampler, parseResourceBirths, parseResourceProcesses, resourceProcessTree, resourceProductProjection } from '../../tooling/qualification/campaigns/browser-resources.mjs';
import { RESOURCE_SAMPLE_CODEC, createBrowserResourceSampleContext, decodeBrowserResourceSample } from '../../tooling/qualification/campaigns/resource-sample-codec.mjs';

function decodedResourceArtifact(bytes) {
  const raw = JSON.parse(bytes);
  assert.equal(raw.schema, 'browser-resource-samples-2'); assert.equal(raw.sampleCodec, RESOURCE_SAMPLE_CODEC);
  assert.equal(raw.sampleContext.processIdentity, raw.processIdentity);
  raw.sampleContext = createBrowserResourceSampleContext(raw.sampleContext);
  for (let i = 0; i < raw.samples.length; i++) raw.samples[i] = decodeBrowserResourceSample(raw.samples[i], raw.sampleContext);
  return raw;
}
async function readResourceArtifact(path) { return decodedResourceArtifact(await readFile(path, 'utf8')); }

const birth = 'Wed Sep 30 12:34:56 2026';
const completeLedger = () => ({ cpuBytes: 100, gpuBytes: 200, previewCacheBytes: 300, unusedHandles: 0, textureSide: 512, deviceTextureLimit: 4096, complete: true, coverage: { cpu: true, gpu: true, previewCache: true, handles: true, textureLimits: true } });
const canvasLedger = () => ({ ...completeLedger(), textureSide: null, deviceTextureLimit: null,
  coverage: { cpu: true, gpu: true, previewCache: true, handles: true, textureLimits: false },
  rendererOwnership: { contract: 'canvas2d-owned-rgba-v1', backend: 'main-thread-canvas-2d', appOwnedTextureAPIs: [], appOwnedTextureCount: 0, textureLimitApplicability: 'not-applicable', rgbaBackingEstimateBytes: 200 } });

async function fakeSampler(t, options = {}) {
  const output = await mkdtemp(join(tmpdir(), 'browser-resources-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  let time = 0, sequence = 0, rootsChanged = false, recycleDescendant = false, rssReads = 0;
  const timers = new Map(), commands = [];
  const hooks = {
    workerPid: 90, now: () => time,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async execute(command, args) {
      assert.equal(command, '/bin/ps'); commands.push(args); time += 0.1;
      if (args[0] === '-e') { rssReads++; assert.deepEqual(args, ['-e', '-o', 'pid=,ppid=,rss=']); return { stdout: '90 1 7\n100 90 10\n101 100 11\n200 90 20\n201 200 21\n300 1 999\n' }; }
      assert.deepEqual(args.slice(2), ['-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=']);
      return { stdout: args[1].split(',').map(id => `${id} ${id === '100' || id === '101' ? '100' : '90'} ${rootsChanged && id === '100' || recycleDescendant && id === '101' && rssReads % 2 === 0 ? 'Wed Sep 30 12:35:56 2026' : birth}`).join('\n') };
    },
    productSnapshot: async () => ({ allocations: options.ledger?.() ?? null, lifecycle: { releasing: false, releases: 1, lastReleaseMilliseconds: 5, consumers: { 'editor-shell': { decodedBitmaps: 0, nativeWorkers: 0, privatePrompt: 'secret caption', unusedHandles: 0 } } } }),
    ...options.hooks,
  };
  const sampler = createBrowserResourceSampler({ browserPid: 100, backendPid: 200, page: {}, output, rendererOwnershipProof: options.rendererOwnershipProof ?? null }, hooks);
  async function runTimer(delay = 0) {
    const [id, value] = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0] ?? [];
    assert(value, 'scheduled sample exists'); timers.delete(id); time = value.due + delay;
    const previous = sampler.evidence().counts.samples; value.callback();
    for (let i = 0; i < 1000 && (sampler.evidence().counts.samples === previous || !timers.size); i++) await new Promise(resolve => setImmediate(resolve));
    assert(sampler.evidence().counts.samples > previous, 'scheduled sample finished');
  }
  return { sampler, commands, runTimer, recycleRoot: () => { rootsChanged = true; }, recycleDescendant: () => { recycleDescendant = true; } };
}

test('numeric RSS parser attributes both trees and rejects malformed or duplicate rows', () => {
  const rows = parseResourceProcesses('1 0 100\n10 1 200\n11 10 300\n20 1 400\n');
  assert.deepEqual(resourceProcessTree(rows, 10).map(row => row.pid), [10, 11]);
  assert.equal(resourceProcessTree(rows, 10).reduce((sum, row) => sum + row.rssBytes, 0), 500 * 1024);
  assert.deepEqual(resourceProcessTree(rows, 404), []);
  for (const bad of ['PID PPID RSS', '1 0 -1', '1 0 1.5', '1 0 NaN', '1 0 2\n1 0 3', '1 0 12 secret command']) assert.throws(() => parseResourceProcesses(bad));
});

test('birth identity parser accepts only fixed OS identity metadata', () => {
  assert.deepEqual(parseResourceBirths(`100 90 ${birth}`), [{ pid: 100, pgid: 90, startedAtIdentity: birth }]);
  for (const bad of ['100 90 secret command line', `100 90 ${birth}\n100 90 ${birth}`, `100 0 ${birth}`, `100 90 ${birth} secret`]) assert.throws(() => parseResourceBirths(bad));
});

test('document lifecycle zeros never masquerade as a complete CPU/GPU/handle ledger', () => {
  const projected = resourceProductProjection({ allocations: { cpuBytes: 12, unusedHandles: 0, gpuBytes: NaN }, lifecycle: { consumers: { 'editor-shell': { decodedBitmaps: 0, privatePrompt: 'secret' } } } });
  assert.equal(projected.values.cpuBytes, 12); assert.equal(projected.values.gpuBytes, null); assert.equal(projected.values.unusedHandles, null);
  assert.equal(projected.allocationCoverage.complete, false); assert(!JSON.stringify(projected).includes('secret'));
  const complete = resourceProductProjection({ allocations: completeLedger() }); assert.equal(complete.values.unusedHandles, 0); assert.equal(complete.allocationCoverage.complete, true);
});

test('Canvas2D declaration alone never substitutes for reviewed source and build evidence', () => {
  for (const proof of [null, { status: 'PASS' }, { kind: 'renderer-ownership-proof-1', contract: 'canvas2d-owned-rgba-v1' }]) {
    const projected = resourceProductProjection({ allocations: canvasLedger() }, proof);
    assert.equal(projected.values.textureSide, null); assert.equal(projected.values.deviceTextureLimit, null);
    assert.equal(projected.values.gpuBytes, 200); assert.equal(projected.values.unusedHandles, null);
    assert.equal(projected.allocationCoverage.complete, false); assert.equal(projected.allocationCoverage.textureLimits, false);
    assert.deepEqual(projected.rendererOwnership, canvasLedger().rendererOwnership);
  }
  const invented = canvasLedger(); invented.textureSide = 0; invented.deviceTextureLimit = 4096; invented.coverage.textureLimits = true;
  assert.equal(resourceProductProjection({ allocations: invented }).allocationCoverage.complete, false);
});

test('renderer diagnostics retain only bounded ownership fields without dropping an unknown API into an empty list', () => {
  const ledger = canvasLedger();
  ledger.rendererOwnership.appOwnedTextureAPIs = ['webgpu', 'private content'];
  ledger.rendererOwnership.privatePrompt = 'private content';
  const projected = resourceProductProjection({ allocations: ledger });
  assert.equal(projected.rendererOwnership.appOwnedTextureAPIs, null);
  assert(!JSON.stringify(projected).includes('private content'));
  assert.equal(projected.allocationCoverage.complete, false);
});

test('resource artifacts preserve Canvas2D N/A declarations without inventing a queried device limit', async t => {
  const { sampler, runTimer } = await fakeSampler(t, { ledger: canvasLedger });
  await sampler.start(); await runTimer(); const evidence = await sampler.stop();
  const saved = await readResourceArtifact(evidence.artifact.path);
  assert.equal(evidence.complete, false); assert.equal(evidence.peaks.textureSide, null); assert.equal(evidence.peaks.deviceTextureLimit, null);
  for (const sample of saved.samples) {
    assert.equal(sample.rendererOwnership.contract, 'canvas2d-owned-rgba-v1');
    assert.equal(sample.rendererOwnershipProof, null); assert.equal(sample.textureSide, null); assert.equal(sample.deviceTextureLimit, null);
    assert.equal(sample.allocationCoverage.complete, false);
  }
});

test('sampler seals exact metadata bytes and keeps absent ledgers explicitly incomplete', async t => {
  const { sampler, commands, runTimer } = await fakeSampler(t);
  assert.equal(sampler.identity(), null); await sampler.start(); const identity = sampler.identity(); assert.match(identity, /^sha256:[0-9a-f]{64}$/);
  await runTimer(); const measured = await sampler.measure();
  assert.equal(measured.browserRssBytes, 21 * 1024); assert.equal(measured.backendRssBytes, 41 * 1024); assert.equal(measured.settledBytes, 62 * 1024);
  assert.equal(measured.cpuBytes, null); assert.equal(measured.gpuBytes, null); assert.equal(measured.unusedHandles, null);
  assert.equal(sampler.evidence().sha256, null);
  const evidence = await sampler.stop(), bytes = await readFile(evidence.artifact.path), saved = decodedResourceArtifact(bytes);
  assert.equal(evidence.sha256, 'sha256:' + createHash('sha256').update(bytes).digest('hex')); assert.equal(evidence.artifact.bytes, bytes.length);
  assert.equal(evidence.complete, false); assert(evidence.missing.includes('complete-product-allocation-ledger-unavailable'));
  assert.equal(saved.roots.find(root => root.kind === 'worker').pid, 90); assert.equal(sampler.identity(), identity);
  assert(!bytes.includes(Buffer.from('secret caption'))); assert.equal(saved.samples.length, evidence.counts.samples);
  assert(commands.every(args => !args.join(',').match(/comm|args|command/)));
  assert.deepEqual(await sampler.stop(), evidence); await assert.rejects(sampler.measure(), /not running/);
});

test('PID reuse invalidates attribution rather than counting a replacement process', async t => {
  const { sampler, recycleRoot } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); const identity = sampler.identity(); recycleRoot(); const measured = await sampler.measure();
  assert.equal(measured.browserRssBytes, null); assert.equal(measured.backendRssBytes, null); assert.equal(measured.settledBytes, null);
  const evidence = await sampler.stop(); assert.equal(evidence.complete, false); assert.equal(sampler.identity(), identity);
  assert(evidence.missing.includes('process-tree-or-birth-observation-unavailable'));
});

test('descendant PID recycling between RSS and birth snapshots invalidates its sample', async t => {
  const { sampler, recycleDescendant } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); recycleDescendant(); const measured = await sampler.measure();
  assert.equal(measured.browserRssBytes, null); assert.equal(measured.settledBytes, null);
  const evidence = await sampler.stop(); assert.equal(evidence.complete, false);
  assert(evidence.missing.includes('process-tree-or-birth-observation-unavailable'));
});

test('actual scheduled gaps cannot be hidden by complete point-in-time ledgers', async t => {
  const { sampler, runTimer } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); await runTimer(350); const evidence = await sampler.stop();
  assert.equal(evidence.complete, false); assert(evidence.maximumGapMs >= 450); assert(evidence.counts.missedIntervals >= 3);
  assert(evidence.missing.includes('sampling-gap-over-two-intervals'));
});

test('sample bound retains existing observations and prevents a complete claim', async t => {
  const { sampler } = await fakeSampler(t, { ledger: completeLedger, hooks: { maxEntries: 2 } });
  await sampler.start(); await sampler.measure(); await sampler.measure(); const evidence = await sampler.stop();
  assert.equal(evidence.counts.samples, 2); assert.equal(evidence.complete, false); assert(evidence.missing.includes('resource-sample-limit'));
  assert.equal((await readResourceArtifact(evidence.artifact.path)).samples.length, 2);
});

test('sampled complete ledgers still require a separate sealed continuous CPU window', async t => {
  const { sampler, runTimer } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); await runTimer(); assert.equal(sampler.evidence().complete, false);
  const evidence = await sampler.stop(); assert.equal(evidence.complete, false); assert(evidence.missing.includes('complete-continuous-browser-cpu-window-unavailable')); assert.equal(evidence.observationWindow, null); assert.deepEqual(evidence.allocationPeaks, {});
});

test('an unresponsive renderer leaves one bounded observation and does not block sealing', async t => {
  let reads = 0;
  const { sampler } = await fakeSampler(t, { hooks: { productTimeoutMs: 5, productSnapshot: () => { reads++; return new Promise(() => {}); } } });
  await sampler.start(); await sampler.measure(); const evidence = await sampler.stop();
  assert.equal(reads, 1); assert.equal(evidence.complete, false);
  assert(evidence.missing.includes('read-only-product-resource-snapshot-unavailable'));
  assert.match(evidence.sha256, /^sha256:[0-9a-f]{64}$/);
});

test('a failed artifact seal closes the owned handle and cannot report complete evidence', async t => {
  let closes = 0;
  const { sampler } = await fakeSampler(t, { hooks: { open: async () => ({ writeFile: async () => {}, sync: async () => { throw Error('Injected sync failure'); }, close: async () => { closes++; } }) } });
  await sampler.start(); await assert.rejects(sampler.stop(), /Injected sync failure/);
  assert.equal(closes, 1); assert.equal(sampler.evidence().complete, false); assert.equal(sampler.evidence().sha256, null);
  assert(sampler.evidence().missing.includes('resource-artifact-seal-failed'));
  await assert.rejects(sampler.stop(), /Injected sync failure/); assert.equal(closes, 1);
});

test('a partially persisted sample is never sealed under a false successful-write hash', async t => {
  let fail = false, writes = 0, closes = 0, persisted = '';
  const { sampler } = await fakeSampler(t, { hooks: { open: async () => ({
    writeFile: async text => { writes++; persisted += fail ? text.slice(0, 12) : text; if (fail) throw Error('Injected partial write'); },
    sync: async () => { throw Error('Incomplete bytes must never be synced as a sealed artifact'); }, close: async () => { closes++; },
  }) } });
  await sampler.start(); fail = true; await assert.rejects(sampler.measure(), /Injected partial write/); const previousWrites = writes;
  const evidence = await sampler.stop();
  assert(persisted.length > 12); assert.equal(writes, previousWrites); assert.equal(closes, 1);
  assert.equal(evidence.sha256, null); assert.equal(evidence.artifact.bytes, null); assert.equal(evidence.complete, false); assert(evidence.missing.includes('resource-artifact-write-failed'));
});

test('cycle windows retain original peak witnesses and every pairwise texture violation', async t => {
  let index = 0;
  const { sampler, runTimer } = await fakeSampler(t, { ledger: () => {
    const n = index++;
    return { ...completeLedger(), cpuBytes: n === 2 ? 901 : 100, gpuBytes: n === 3 ? 902 : 200,
      textureSide: n === 2 ? 1024 : 512, deviceTextureLimit: n === 2 ? 512 : 4096 };
  } });
  await sampler.start(); const handle = await sampler.beginWindow({ cycleOrdinal: 1 });
  await runTimer(); await sampler.measure(); const window = await sampler.endWindow(handle), evidence = await sampler.stop();
  const raw = await readResourceArtifact(evidence.artifact.path);
  assert.equal(window.sampleCount, window.lastOrdinal - window.firstOrdinal + 1);
  assert.equal(window.textureLimits.violations, 1); assert.equal(evidence.textureLimits.violations, 1);
  assert.equal(evidence.textureLimits.observedSamples, raw.samples.length);
  assert.equal(window.peaks.cpuBytes, 901); assert.equal(window.peaks.gpuBytes, 902);
  assert.notEqual(window.peakSamples.cpuBytes.ordinal, window.peakSamples.gpuBytes.ordinal);
  for (const sample of window.samples) assert.deepEqual(sample, raw.samples[sample.ordinal - 1]);
  for (const sample of Object.values(evidence.peakSamples).filter(Boolean)) assert.deepEqual(sample, raw.samples[sample.ordinal - 1]);
  assert(window.samples.every(sample => sample.observation.startMs >= window.startMs && sample.observation.endMs <= window.endMs));
  assert.equal(raw.summary.windows.length, 1); assert.equal(raw.summary.windows[0].id, window.id);
  assert.deepEqual(raw.summary.peakSamples, evidence.peakSamples);
  await assert.rejects(sampler.endWindow(handle), /Unknown or already closed/);
});

test('resource windows preserve missing ledger observations and reject overlap or invented ownership', async t => {
  let reads = 0;
  const { sampler, runTimer } = await fakeSampler(t, { ledger: () => ++reads === 3 ? null : completeLedger() });
  await sampler.start(); const handle = await sampler.beginWindow({ cycleOrdinal: 1 });
  await assert.rejects(sampler.beginWindow({ cycleOrdinal: 2 }), /one running lifecycle/);
  await assert.rejects(sampler.endWindow({ ...handle }), /Unknown/);
  await runTimer(); const window = await sampler.endWindow(handle); const evidence = await sampler.stop();
  assert.equal(window.complete, false); assert.equal(window.textureLimits.complete, false);
  assert(window.samples.some(sample => sample.allocationCoverage.complete === false));
  assert.equal(evidence.complete, false);
});

test('leaving a cycle window open prevents a sealed complete sampling claim', async t => {
  const { sampler, runTimer } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); const handle = await sampler.beginWindow({ cycleOrdinal: 1 }); await runTimer();
  const evidence = await sampler.stop(); assert.equal(evidence.complete, false);
  assert(evidence.missing.includes('resource-window-left-open'));
  const window = await sampler.endWindow(handle), raw = await readResourceArtifact(evidence.artifact.path);
  assert.equal(window.complete, false); assert.equal(window.id, raw.summary.windows[0].id);
  assert(window.endMs <= evidence.endMs);
  assert.deepEqual(sampler.evidence(), evidence);
  await assert.rejects(sampler.endWindow(handle), /Unknown or already closed/);
});

// Synthetic control observations test receipt plumbing only; they are neither
// actual product allocation measurements nor qualification evidence.
const cpuMissing = ['app-payload-ownership-incomplete', 'native-image-and-canvas-implementation-overhead', 'native-blob-residency', 'engine-and-dom-allocations', 'renderer-ownership-proof-required'];
function syntheticCpuObserver({ brokenEnd = false, noBegin = false } = {}) {
  let window = null; const boundaries = [];
  return { boundaries, get window() { return window; }, read(boundary) {
    let cpuWindowAck = null;
    if (boundary) {
      boundaries.push({ ...boundary });
      if (boundary.boundary === 'begin' && !noBegin) window = { kind: 'combined-cpu-window-1', schemaVersion: 1, ledgerInstanceId: 'ledger-1', id: boundary.id, ordinal: 1,
        clock: 'browser-performance', clockOriginMs: 1000, startMs: 10, endMs: null, peakAtMs: 15, startSequence: 2, endSequence: null, peakSequence: 3,
        currentBytes: 100, peakBytes: 501, ledgerBytesAtPeak: 100, textBytesAtPeak: 401, textStartSequence: 1, textEndSequence: null,
        sealed: false, observationComplete: true, ownerCoverageComplete: false, failures: [], missing: [...cpuMissing] };
      if (window && boundary.boundary === 'end') window = { ...window, endMs: 20, endSequence: 5, textEndSequence: 4, sealed: true };
      if (window) cpuWindowAck = { kind: 'combined-cpu-window-ack-1', schemaVersion: 1, ledgerInstanceId: 'ledger-1', id: boundary.boundary === 'end' && brokenEnd ? 'unrelated-window' : boundary.id,
        ordinal: 1, boundary: boundary.boundary, sequence: boundary.boundary === 'begin' ? 2 : 5, atMs: boundary.boundary === 'begin' ? 10 : 20,
        clock: 'browser-performance', clockOriginMs: 1000, sealed: boundary.boundary === 'end' };
    }
    return { allocations: { ...completeLedger(), combinedCpu: { kind: 'combined-cpu-observation-1', schemaVersion: 1, scope: 'browser-ledger-plus-text-reservations', ledgerInstanceId: 'ledger-1',
      sequence: window?.endSequence ?? 3, currentBytes: 100, observedPeakBytes: 9999, observationComplete: false, ownerCoverageComplete: false, missing: [...cpuMissing], window } }, cpuWindowAck };
  } };
}

test('CPU projection detaches bounded primitives and keeps covered continuity separate from owner completeness', () => {
  const observer = syntheticCpuObserver(), raw = observer.read({ boundary: 'begin', id: 'fixed-window' });
  raw.allocations.combinedCpu.privatePrompt = 'do not retain'; raw.allocations.combinedCpu.window.privateModel = { prompt: 'do not retain' };
  const projected = resourceProductProjection(raw);
  assert.equal(projected.combinedCpu.window.peakBytes, 501); assert.equal(projected.combinedCpu.window.observationComplete, true);
  assert.equal(projected.combinedCpu.window.ownerCoverageComplete, false); assert.equal(projected.combinedCpu.observedPeakBytes, 9999);
  assert(!JSON.stringify(projected).includes('do not retain'));
  raw.allocations.combinedCpu.window.missing.push('later-change'); raw.allocations.combinedCpu.window.peakBytes = 700;
  assert.equal(projected.combinedCpu.window.peakBytes, 501); assert(!projected.combinedCpu.window.missing.includes('later-change'));
  assert.equal(projected.combinedCpu.window.endMs, null); assert.equal(projected.combinedCpu.window.endSequence, null);
  const invalid = observer.read(null); invalid.allocations.combinedCpu.window.failures = Array(17).fill('invalid');
  assert.equal(resourceProductProjection(invalid).combinedCpu.window.failures, null);
});

test('B0 and final samples bind exact CPU boundary ACKs without replacing actual sampled peaks', async t => {
  const observer = syntheticCpuObserver();
  const { sampler, runTimer } = await fakeSampler(t, { hooks: { productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); assert.deepEqual(observer.boundaries, []);
  const baseline = await sampler.measure(); await runTimer(); const evidence = await sampler.stop();
  const raw = await readResourceArtifact(evidence.artifact.path), final = raw.samples.at(-1), peak = evidence.allocationPeaks.cpuBytes;
  assert.equal(baseline.kind, 'manual'); assert.equal(baseline.cpuWindowBoundary, 'begin'); assert.equal(final.kind, 'final'); assert.equal(final.cpuWindowBoundary, 'end');
  assert.equal(observer.boundaries.length, 2); assert.equal(observer.boundaries[0].id, observer.boundaries[1].id);
  assert.equal(evidence.observationWindow.startSourceOrdinal, baseline.ordinal); assert.equal(evidence.observationWindow.endSourceOrdinal, final.ordinal);
  assert.deepEqual(evidence.observationWindow.startObservation, baseline.observation); assert.deepEqual(evidence.observationWindow.endObservation, final.observation);
  assert.deepEqual(evidence.observationWindow.beginAck, baseline.cpuWindowAck); assert.deepEqual(evidence.observationWindow.endAck, final.cpuWindowAck);
  assert.equal(peak.value, 501); assert.equal(peak.sourceOrdinal, final.ordinal); assert.equal(peak.sharedIdentity, 'ledger-1');
  assert.deepEqual(peak.window, final.combinedCpu.window); assert.deepEqual(peak.artifact, { path: evidence.artifact.path, bytes: evidence.artifact.bytes, sha256: evidence.artifact.sha256 });
  assert.equal(raw.summary.allocationPeaks.cpuBytes.artifact, null); assert.deepEqual(raw.summary.observationWindow, evidence.observationWindow);
  assert.equal(evidence.peaks.cpuBytes, 100); assert.equal(evidence.peakSamples.cpuBytes.cpuBytes, 100); assert.notEqual(peak.value, 9999);
  assert.equal(peak.complete, false); assert.equal(peak.ownerCoverageComplete, false); assert.equal(evidence.complete, false);
});

test('a mismatched final CPU ACK retains the actual partial start and no continuous peak', async t => {
  const observer = syntheticCpuObserver({ brokenEnd: true });
  const { sampler } = await fakeSampler(t, { hooks: { productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); const baseline = await sampler.measure(); const evidence = await sampler.stop();
  assert.equal(evidence.observationWindow.startSourceOrdinal, baseline.ordinal); assert.equal(evidence.observationWindow.endSourceOrdinal, null);
  assert.equal(evidence.observationWindow.endAck, null); assert.deepEqual(evidence.allocationPeaks, {});
  assert(evidence.missing.includes('continuous-browser-cpu-window-end-unavailable')); assert.equal(evidence.complete, false);
  const raw = await readResourceArtifact(evidence.artifact.path);
  assert.equal(raw.samples.at(-1).cpuWindowAck.id, 'unrelated-window'); assert.equal(raw.samples.at(-1).combinedCpu.window.sealed, true);
});

test('missing begin acknowledgement is not repaired by lifetime peaks or later point samples', async t => {
  const observer = syntheticCpuObserver({ noBegin: true });
  const { sampler } = await fakeSampler(t, { hooks: { productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); await sampler.measure(); await sampler.measure(); const evidence = await sampler.stop();
  assert.deepEqual(observer.boundaries.map(row => row.boundary), ['begin', 'end', 'end']);
  assert.equal(evidence.observationWindow, null); assert.deepEqual(evidence.allocationPeaks, {});
  assert(evidence.missing.includes('continuous-browser-cpu-window-start-unavailable')); assert.equal(evidence.complete, false);
});

test('a boundary read failure still attempts same-ID end cleanup and remains unavailable', async t => {
  const observer = syntheticCpuObserver(), calls = [];
  const { sampler } = await fakeSampler(t, { hooks: { productSnapshot: boundary => {
    if (boundary) calls.push({ ...boundary });
    const value = observer.read(boundary);
    if (boundary?.boundary === 'begin') throw Error('Synthetic lost acknowledgement');
    return value;
  } } });
  await sampler.start(); await sampler.measure(); const evidence = await sampler.stop();
  assert.equal(calls.length, 2); assert.equal(calls[0].id, calls[1].id); assert.equal(observer.window.sealed, true);
  assert.equal(evidence.observationWindow, null); assert.deepEqual(evidence.allocationPeaks, {}); assert.equal(evidence.complete, false);
  assert(evidence.missing.includes('read-only-product-resource-snapshot-unavailable'));
});


test('sample budget exhaustion still ends the same product window without inventing retained final membership', async t => {
  const observer = syntheticCpuObserver();
  const { sampler } = await fakeSampler(t, { hooks: { maxEntries: 2, productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); const baseline = await sampler.measure(); const evidence = await sampler.stop();
  assert.deepEqual(observer.boundaries.map(row => row.boundary), ['begin', 'end']); assert.equal(observer.window.sealed, true);
  assert.equal(evidence.counts.samples, 2); assert.equal(evidence.observationWindow.startSourceOrdinal, baseline.ordinal);
  assert.equal(evidence.observationWindow.endSourceOrdinal, null); assert.deepEqual(evidence.allocationPeaks, {});
  assert.equal(evidence.cpuWindowCleanup.complete, true); assert.equal(evidence.complete, false);
  const raw = await readResourceArtifact(evidence.artifact.path);
  assert.equal(raw.samples.length, 2); assert(!raw.samples.some(row => row.cpuWindowBoundary === 'end'));
  assert.deepEqual(raw.summary.cpuWindowCleanup, evidence.cpuWindowCleanup);
});

test('a failed sample write still attempts bounded window cleanup without sealing corrupt bytes', async t => {
  const observer = syntheticCpuObserver(); let writes = 0, closes = 0;
  const { sampler } = await fakeSampler(t, { hooks: { productSnapshot: boundary => observer.read(boundary), open: async () => ({
    writeFile: async () => { if (++writes === 3) throw Error('Synthetic B0 partial write'); }, sync: async () => assert.fail('corrupt output cannot seal'), close: async () => { closes++; },
  }) } });
  await sampler.start(); await assert.rejects(sampler.measure(), /Synthetic B0 partial write/); const evidence = await sampler.stop();
  assert.equal(observer.window.sealed, true); assert.equal(evidence.cpuWindowCleanup.complete, true); assert.equal(closes, 1);
  assert.equal(evidence.sha256, null); assert.equal(evidence.artifact.bytes, null); assert.equal(evidence.observationWindow, null); assert.deepEqual(evidence.allocationPeaks, {});
});

test('returned continuous peak evidence cannot mutate later evidence or its sealed raw witness', async t => {
  const observer = syntheticCpuObserver();
  const { sampler } = await fakeSampler(t, { hooks: { productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); await sampler.measure(); const evidence = await sampler.stop(), original = structuredClone(evidence.allocationPeaks.cpuBytes);
  evidence.allocationPeaks.cpuBytes.window.peakBytes = 0; evidence.allocationPeaks.cpuBytes.window.missing.length = 0;
  evidence.allocationPeaks.cpuBytes.observation.startMs = 999; evidence.allocationPeaks.cpuBytes.artifact.sha256 = 'mutated';
  assert.deepEqual(sampler.evidence().allocationPeaks.cpuBytes, original);
  const raw = await readResourceArtifact(evidence.artifact.path);
  assert.equal(raw.summary.allocationPeaks.cpuBytes.window.peakBytes, original.window.peakBytes);
});


// These synthetic records exercise bounded transport and evidence membership.
// Their unreviewed renderer proof can never qualify application ownership.
function syntheticAppObserver() {
  const ledgerInstanceId = 'a1234567-1234-4234-8234-123456789abc';
  const order = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
  const zero = () => ({ cpuBytes: 0, gpuBytes: 0, previewCacheBytes: 0, handles: 0 });
  const owned = (kind, active) => kind === 'control' ? { records: 1, cpuBytes: 100, gpuBytes: 200, previewCacheBytes: 300, handles: 1 }
    : kind === 'scratch' && active ? { records: 1, cpuBytes: 40, gpuBytes: 0, previewCacheBytes: 0, handles: 1 } : { records: 0, ...zero() };
  let id = null, sealed = false; const boundaries = [];
  return { boundaries, read(boundary) {
    let cpuWindowAck = null;
    if (boundary) {
      boundaries.push({ ...boundary });
      if (boundary.boundary === 'begin') id = boundary.id;
      if (boundary.boundary === 'end') sealed = true;
      if (id) cpuWindowAck = { kind: 'combined-cpu-window-ack-1', schemaVersion: 1, ledgerInstanceId, id, ordinal: 1,
        boundary: boundary.boundary, sequence: sealed ? 5 : 2, atMs: sealed ? 20 : 10, clock: 'browser-performance', clockOriginMs: 1000, sealed };
    }
    const active = id !== null && !sealed, cpuBytes = active ? 140 : 100, transitionSequence = id ? sealed ? 3 : 2 : 1;
    const sequence = id ? sealed ? 5 : 3 : 1, atMs = id ? sealed ? 20 : 12 : 1;
    const cpuWindow = id ? { kind: 'combined-cpu-window-1', schemaVersion: 1, ledgerInstanceId, id, ordinal: 1,
      clock: 'browser-performance', clockOriginMs: 1000, startMs: 10, endMs: sealed ? 20 : null, peakAtMs: 12,
      startSequence: 2, endSequence: sealed ? 5 : null, peakSequence: 3, currentBytes: cpuBytes, peakBytes: 140,
      ledgerBytesAtPeak: 140, textBytesAtPeak: 0, textStartSequence: 1, textEndSequence: sealed ? 1 : null,
      sealed, observationComplete: true, ownerCoverageComplete: false, failures: [], missing: [...cpuMissing] } : null;
    const combinedCpu = { kind: 'combined-cpu-observation-1', schemaVersion: 1, scope: 'browser-ledger-plus-text-reservations', ledgerInstanceId,
      sequence, currentBytes: cpuBytes, observedPeakBytes: 9999, observationComplete: false, ownerCoverageComplete: false, missing: [...cpuMissing], window: cpuWindow };
    const point = { kind: 'app-ownership-point-1', schemaVersion: 1, ledgerInstanceId, transitionSequence, cpuSequence: sequence,
      clock: 'browser-performance', clockOriginMs: 1000, atMs, totals: { cpuBytes, gpuBytes: 200, previewCacheBytes: 300, handles: active ? 2 : 1 },
      centralCpuBytes: cpuBytes, textBytes: 0, textSequence: 1, kinds: order.map(kind => ({ kind, ...owned(kind, active) })),
      observationComplete: true, globalCoverageComplete: false };
    const window = id ? { kind: 'app-ownership-window-1', schemaVersion: 1, scope: 'application-owned-conservative-reservations', ledgerInstanceId, id, ordinal: 1,
      clock: 'browser-performance', clockOriginMs: 1000, startMs: 10, endMs: sealed ? 20 : null,
      cpuStartSequence: 2, cpuEndSequence: sealed ? 5 : null, ledgerStartSequence: 1, ledgerEndSequence: sealed ? 3 : null, lastTransitionSequence: transitionSequence,
      sealed, budgetRefusals: 0, kinds: order.map(kind => ({ kind, initial: owned(kind, false), current: owned(kind, active),
        transitions: { reserved: kind === 'scratch' ? 1 : 0, resized: 0, released: kind === 'scratch' && sealed ? 1 : 0, observed: 0 },
        added: kind === 'scratch' ? { cpuBytes: 40, gpuBytes: 0, previewCacheBytes: 0, handles: 1 } : zero(),
        removed: kind === 'scratch' && sealed ? { cpuBytes: 40, gpuBytes: 0, previewCacheBytes: 0, handles: 1 } : zero() })),
      text: { initialBytes: 0, currentBytes: 0, startSequence: 1, endSequence: sealed ? 1 : null, observationComplete: true },
      peaks: { gpuBytes: 200, previewCacheBytes: 300, handles: 2 }, observationComplete: true, reconciled: true, failures: [], globalCoverageComplete: false } : null;
    return { allocations: { ...completeLedger(), cpuBytes, complete: false, coverage: { cpu: false, gpu: false, previewCache: false, handles: false, textureLimits: true },
      combinedCpu, appOwnership: { kind: 'app-ownership-observation-1', schemaVersion: 1, ledgerInstanceId, transitionSequence, point, window } }, cpuWindowAck };
  } };
}

test('app ownership projection retains a bounded detached point and exact global gaps before B0', () => {
  const raw = syntheticAppObserver().read(null), witness = raw.allocations.appOwnership;
  witness.privateText = 'do-not-retain'; witness.point.kinds[0].privateArray = ['do-not-retain'];
  const projected = resourceProductProjection(raw);
  assert.equal(projected.appOwnership.window, null); assert.equal(projected.appOwnership.point.totals.cpuBytes, 100);
  assert.deepEqual(projected.globalAllocationCoverage, { complete: false, cpu: false, gpu: false, previewCache: false, handles: false, textureLimits: true });
  assert.equal(projected.allocationCoverage.complete, false); assert.equal(projected.values.unusedHandles, null);
  assert(!JSON.stringify(projected).includes('do-not-retain'));
  witness.point.kinds[0].cpuBytes = 999; witness.point.totals.gpuBytes = 999;
  assert.equal(projected.appOwnership.point.kinds[0].cpuBytes, 0); assert.equal(projected.appOwnership.point.totals.gpuBytes, 200);
});

test('app ownership projection refuses an expanded or reordered kind inventory without granting coverage', () => {
  for (const mutate of [
    w => w.point.kinds.push({ ...w.point.kinds[0] }),
    w => w.point.kinds.reverse(),
    w => w.window.kinds.push({ ...w.window.kinds[0] }),
    w => { w.window.failures = Array(9).fill('observer-incomplete'); },
  ]) {
    const raw = syntheticAppObserver().read({ boundary: 'begin', id: 'bounded-window' }); mutate(raw.allocations.appOwnership);
    const projected = resourceProductProjection(raw, { status: 'PASS', appAllocation: { approved: true } });
    assert.equal(projected.allocationCoverage.complete, false); assert.equal(projected.values.unusedHandles, null);
    assert(projected.appOwnership.point.kinds === null || projected.appOwnership.window.kinds === null || projected.appOwnership.window.failures === null);
  }
});

test('unsigned app window binds actual post-begin read reservations and retains original raw artifact identity', async t => {
  const observer = syntheticAppObserver();
  const { sampler, runTimer } = await fakeSampler(t, { hooks: { productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); const baseline = await sampler.measure(); await runTimer(); const evidence = await sampler.stop();
  const raw = await readResourceArtifact(evidence.artifact.path), final = raw.samples.at(-1), candidate = evidence.appOwnedCpu;
  assert(candidate, 'coherent unreviewed scope remains an explicit diagnostic candidate');
  assert.equal(baseline.appOwnership.window.kinds[2].initial.cpuBytes, 0);
  assert.equal(baseline.appOwnership.window.kinds[2].current.cpuBytes, 40);
  assert.equal(candidate.value, 140); assert.notEqual(candidate.value, 9999); assert.equal(candidate.complete, false); assert.equal(evidence.complete, false);
  assert.deepEqual(candidate.start.appOwnership, baseline.appOwnership); assert.deepEqual(candidate.end.appOwnership, final.appOwnership);
  assert.equal(candidate.startSourceOrdinal, baseline.ordinal); assert.equal(candidate.endSourceOrdinal, final.ordinal);
  assert.deepEqual(candidate.artifact, { path: evidence.artifact.path, bytes: evidence.artifact.bytes, sha256: evidence.sha256 });
  assert.deepEqual(raw.summary.appOwnedCpu, { ...candidate, artifact: null });
  assert.deepEqual(raw.samples[baseline.ordinal - 1].globalAllocationCoverage, baseline.globalAllocationCoverage);
  assert.equal(raw.samples[0].appOwnership.window, null); assert.equal(evidence.peaks.cpuBytes, 140);
  assert(evidence.missing.includes('complete-product-allocation-ledger-unavailable'));
});

test('returned app windows cannot mutate later evidence or the retained raw witness', async t => {
  const observer = syntheticAppObserver();
  const { sampler } = await fakeSampler(t, { hooks: { productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); await sampler.measure(); const evidence = await sampler.stop(), original = structuredClone(evidence.appOwnedCpu);
  assert(original); evidence.appOwnedCpu.start.appOwnership.window.kinds[2].initial.cpuBytes = 12345;
  evidence.appOwnedCpu.end.combinedCpu.window.peakBytes = 0; evidence.appOwnedCpu.artifact.sha256 = 'mutated';
  assert.deepEqual(sampler.evidence().appOwnedCpu, original);
  const raw = await readResourceArtifact(evidence.artifact.path);
  assert.deepEqual(raw.summary.appOwnedCpu, { ...original, artifact: null });
});

test('sample limit cleanup cannot invent a final app scope or a scored peak', async t => {
  const observer = syntheticAppObserver();
  const { sampler } = await fakeSampler(t, { hooks: { maxEntries: 2, productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); await sampler.measure(); const evidence = await sampler.stop();
  assert.equal(evidence.appOwnedCpu, null); assert.equal(evidence.observationWindow.endSourceOrdinal, null);
  assert.equal(evidence.cpuWindowCleanup.complete, true); assert.equal(evidence.complete, false);
  const raw = await readResourceArtifact(evidence.artifact.path);
  assert.equal(raw.summary.appOwnedCpu, null); assert.equal(raw.samples.length, 2); assert(!raw.samples.some(row => row.kind === 'final'));
  assert.deepEqual(observer.boundaries.map(row => row.boundary), ['begin', 'end']);
});

test('contradictory final app kind arithmetic stays raw evidence and never becomes a scope candidate', async t => {
  const observer = syntheticAppObserver();
  const { sampler } = await fakeSampler(t, { hooks: { productSnapshot: boundary => {
    const result = observer.read(boundary);
    if (boundary?.boundary === 'end') result.allocations.appOwnership.window.kinds[2].removed.cpuBytes = 39;
    return result;
  } } });
  await sampler.start(); await sampler.measure(); const evidence = await sampler.stop();
  assert.equal(evidence.appOwnedCpu, null); assert.equal(evidence.complete, false);
  const raw = await readResourceArtifact(evidence.artifact.path);
  assert.equal(raw.samples.at(-1).appOwnership.window.kinds[2].removed.cpuBytes, 39);
  assert.equal(raw.summary.appOwnedCpu, null);
});


test('collection writes compact rows immediately with one exact immutable context', async t => {
  const observer = syntheticAppObserver();
  const { sampler } = await fakeSampler(t, { hooks: { productSnapshot: boundary => observer.read(boundary) } });
  await sampler.start(); const observed = await sampler.measure(); const evidence = await sampler.stop();
  const bytes = await readFile(evidence.artifact.path), raw = JSON.parse(bytes);
  assert.equal(raw.schema, 'browser-resource-samples-2'); assert.equal(raw.sampleCodec, RESOURCE_SAMPLE_CODEC);
  assert.deepEqual(raw.sampleContext, { processIdentity: sampler.identity(), rendererOwnershipProof: null });
  assert(raw.samples.every(Array.isArray));
  assert.deepEqual(decodeBrowserResourceSample(raw.samples[observed.ordinal - 1], raw.sampleContext), observed);
  assert.equal(evidence.sha256, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
  assert.equal(raw.summary.appOwnedCpu.artifact, null); assert.equal(evidence.complete, false);
});


test('failed product reads retain the immutable unapproved envelope proof with missing values', async t => {
  const hash = 'sha256:' + 'a'.repeat(64), proof = { kind: 'renderer-ownership-proof-2', reviewId: 'synthetic-unapproved', reviewSha256: hash,
    contract: 'canvas2d-owned-rgba-v1', executableIdentity: { sourceDigest: 'a'.repeat(64), buildDigest: hash, toolsDigest: hash },
    artifact: { path: '/synthetic/renderer-ownership-v2.json', retainedPath: 'renderer-ownership-v2.json', bytes: 1, sha256: hash } };
  const original = structuredClone(proof);
  const { sampler } = await fakeSampler(t, { rendererOwnershipProof: proof, hooks: { productSnapshot: () => { throw Error('Synthetic renderer read failure'); } } });
  await sampler.start(); proof.reviewId = 'caller-mutated'; proof.artifact.bytes = 999;
  await sampler.measure(); const evidence = await sampler.stop(), raw = await readResourceArtifact(evidence.artifact.path);
  assert.deepEqual(raw.sampleContext.rendererOwnershipProof, original);
  for (const sample of raw.samples) {
    assert.deepEqual(sample.rendererOwnershipProof, original); assert.equal(sample.cpuBytes, null); assert.equal(sample.appOwnership, null);
    assert(sample.missing.includes('read-only-product-resource-snapshot-unavailable'));
  }
  assert.equal(evidence.complete, false); assert.equal(evidence.appOwnedCpu, null);
});


test('context capture refuses accessor proofs before invoking them or opening the artifact', async t => {
  const hash = 'sha256:' + 'b'.repeat(64); let reads = 0;
  const proof = { kind: 'renderer-ownership-proof-2', get reviewId() { reads++; return 'untrusted'; }, reviewSha256: hash,
    contract: 'canvas2d-owned-rgba-v1', executableIdentity: { sourceDigest: 'b'.repeat(64), buildDigest: hash, toolsDigest: hash },
    artifact: { path: '/synthetic/renderer-ownership-v2.json', retainedPath: 'renderer-ownership-v2.json', bytes: 1, sha256: hash } };
  const { sampler } = await fakeSampler(t, { rendererOwnershipProof: proof, hooks: { open: async () => assert.fail('invalid context must precede artifact creation') } });
  await assert.rejects(sampler.start(), /data properties/); assert.equal(reads, 0); assert.equal(sampler.evidence().sha256, null);
});

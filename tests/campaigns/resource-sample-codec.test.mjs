import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOURCE_SAMPLE_CODEC, createBrowserResourceSampleContext,
  createBrowserResourceSampleView, encodeBrowserResourceSample, decodeBrowserResourceSample,
} from '../../tooling/qualification/campaigns/resource-sample-codec.mjs';

// These are synthetic storage-contract specimens. They establish no browser
// observation, approved renderer scope, campaign qualification, or full-run fit.
const copy = value => structuredClone(value);
const hash = letter => 'sha256:' + letter.repeat(64);
const ledgerId = 'a1234567-1234-4234-8234-123456789abc';
const windowId = 'b1234567-1234-4234-8234-123456789abc';
const kinds = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
const coverage = () => ({ complete: false, cpu: false, gpu: false, previewCache: false, handles: false, textureLimits: false });
const vector = () => ({ cpuBytes: 0, gpuBytes: 0, previewCacheBytes: 0, handles: 0 });
const amounts = () => ({ records: 0, ...vector() });

function proof() {
  return {
    kind: 'renderer-ownership-proof-2', reviewId: 'synthetic-review', reviewSha256: hash('d'),
    contract: 'canvas2d-owned-rgba-v1',
    executableIdentity: { sourceDigest: 'e'.repeat(64), buildDigest: hash('f'), toolsDigest: hash('a') },
    artifact: { path: '/synthetic/renderer-ownership-v2.json', retainedPath: 'renderer-ownership-v2.json', bytes: 1000, sha256: hash('b') },
  };
}

function sample() {
  return {
    ordinal: 45000, kind: 'scheduled', sampleAtMs: 4500000,
    observation: { startMs: 4500000, endMs: 4500001 }, processIdentity: hash('a'),
    browserRssBytes: 1024, backendRssBytes: 2048, cpuBytes: 0, gpuBytes: 0,
    previewCacheBytes: 0, unusedHandles: null, textureSide: null, deviceTextureLimit: null, settledBytes: 3072,
    browserProcesses: [{ pid: 100, ppid: 90, rssBytes: 1024, identity: hash('b') }],
    backendProcesses: [{ pid: 200, ppid: 90, rssBytes: 2048, identity: hash('c') }],
    allocationCoverage: coverage(), globalAllocationCoverage: coverage(),
    appOwnership: {
      kind: 'app-ownership-observation-1', schemaVersion: 1, ledgerInstanceId: ledgerId, transitionSequence: 2,
      point: {
        kind: 'app-ownership-point-1', schemaVersion: 1, ledgerInstanceId: ledgerId,
        transitionSequence: 2, cpuSequence: 3, clock: 'browser-performance', clockOriginMs: 1000,
        atMs: 12, totals: vector(), centralCpuBytes: 0, textBytes: 0, textSequence: 1,
        kinds: kinds.map(kind => ({ kind, ...amounts() })), observationComplete: true, globalCoverageComplete: false,
      },
      window: {
        kind: 'app-ownership-window-1', schemaVersion: 1, scope: 'application-owned-conservative-reservations',
        ledgerInstanceId: ledgerId, id: windowId, ordinal: 1, clock: 'browser-performance', clockOriginMs: 1000,
        startMs: 10, endMs: null, cpuStartSequence: 2, cpuEndSequence: null, ledgerStartSequence: 1,
        ledgerEndSequence: null, lastTransitionSequence: 2, sealed: false, budgetRefusals: 0,
        kinds: kinds.map(kind => ({ kind, initial: amounts(), current: amounts(),
          transitions: { reserved: 0, resized: 0, released: 0, observed: 0 }, added: vector(), removed: vector() })),
        text: { initialBytes: 0, currentBytes: 0, startSequence: 1, endSequence: null, observationComplete: true },
        peaks: { gpuBytes: 0, previewCacheBytes: 0, handles: 0 },
        observationComplete: true, reconciled: true, failures: [], globalCoverageComplete: false,
      },
    },
    rendererOwnership: { contract: 'canvas2d-owned-rgba-v1', backend: 'main-thread-canvas-2d',
      appOwnedTextureAPIs: [], appOwnedTextureCount: 0, textureLimitApplicability: 'not-applicable', rgbaBackingEstimateBytes: 0 },
    rendererOwnershipProof: proof(),
    documentLifecycle: { releasing: false, releases: 2, lastReleaseMilliseconds: 0.25,
      consumers: { 'editor-client': { uploads: 0, decodedBitmaps: 2, nativeTextActive: true },
        'editor-shell': { maskDrafts: 1, compositionModels: 0, nativeTextPending: false } } },
    combinedCpu: {
      kind: 'combined-cpu-observation-1', schemaVersion: 1, scope: 'browser-ledger-plus-text-reservations',
      ledgerInstanceId: ledgerId, sequence: 3, currentBytes: 0, observedPeakBytes: 0,
      observationComplete: false, ownerCoverageComplete: false,
      missing: ['app-payload-ownership-incomplete', 'native-image-and-canvas-implementation-overhead',
        'native-blob-residency', 'engine-and-dom-allocations', 'renderer-ownership-proof-required'],
      window: {
        kind: 'combined-cpu-window-1', schemaVersion: 1, ledgerInstanceId: ledgerId, id: windowId, ordinal: 1,
        clock: 'browser-performance', clockOriginMs: 1000, startMs: 10, endMs: null, peakAtMs: 12,
        startSequence: 2, endSequence: null, peakSequence: 3, currentBytes: 0, peakBytes: 0,
        ledgerBytesAtPeak: 0, textBytesAtPeak: 0, textStartSequence: 1, textEndSequence: null,
        sealed: false, observationComplete: true, ownerCoverageComplete: false, failures: [],
        missing: ['app-payload-ownership-incomplete', 'native-image-and-canvas-implementation-overhead',
          'native-blob-residency', 'engine-and-dom-allocations', 'renderer-ownership-proof-required'],
      },
    },
    cpuWindowBoundary: null, cpuWindowAck: null,
    missing: ['complete-product-allocation-ledger-unavailable'], forcedGC: false,
  };
}

const contextFor = value => ({ processIdentity: value.processIdentity, rendererOwnershipProof: copy(value.rendererOwnershipProof) });
const encode = value => encodeBrowserResourceSample(value, contextFor(value));
const wireRoundTrip = value => decodeBrowserResourceSample(JSON.parse(JSON.stringify(encode(value))), contextFor(value));
const at = (value, path) => path.reduce((parent, key) => parent[key], value);
function objectPaths(value, path = []) {
  if (!value || typeof value !== 'object') return [];
  const own = Array.isArray(value) ? [] : [path];
  return own.concat(Object.entries(value).flatMap(([key, item]) => objectPaths(item, [...path, key])));
}
function arrayPaths(value, path = []) {
  if (!value || typeof value !== 'object') return [];
  const own = Array.isArray(value) ? [path] : [];
  return own.concat(Object.entries(value).flatMap(([key, item]) => arrayPaths(item, [...path, key])));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function viewFixture(count = 6) {
  const values = Array.from({ length: count }, (_, index) => ({ ...sample(), ordinal: index + 1 }));
  const context = contextFor(values[0] ?? sample());
  const tuples = values.map(value => encodeBrowserResourceSample(value, context));
  return { values, context, tuples };
}

test('codec has an explicit version and a 25-entry context-free top-level tuple', () => {
  const value = sample(), tuple = encode(value);
  assert.equal(RESOURCE_SAMPLE_CODEC, 'browser-resource-sample-tuple-1');
  assert.equal(tuple.length, 25);
  assert.deepEqual(tuple.slice(0, 3), [45000, 'scheduled', 4500000]);
  assert.deepEqual(tuple[3], [4500000, 4500001]);
  assert.deepEqual(tuple.slice(4, 13), [1024, 2048, 0, 0, 0, null, null, null, 3072]);
  assert.equal(tuple[21], null);
  assert.equal(tuple[22], null);
  assert.deepEqual(tuple[23], value.missing);
  assert.equal(tuple[24], false);
  assert.ok(!JSON.stringify(tuple).includes(value.processIdentity));
  assert.ok(!JSON.stringify(tuple).includes('synthetic-review'));
});

test('complete nested diagnostic sample survives exact JSON wire round-trip', () => {
  const value = sample();
  assert.deepEqual(wireRoundTrip(value), value);
});

test('encoding and decoding accept deeply frozen input without mutation', () => {
  const value = freeze(sample()), context = freeze(contextFor(value));
  const tuple = encodeBrowserResourceSample(value, context), before = copy(tuple);
  assert.deepEqual(decodeBrowserResourceSample(freeze(tuple), context), value);
  assert.deepEqual(tuple, before);
});

test('decoded row owns its data and shares only the frozen envelope proof', () => {
  const value = sample(), context = createBrowserResourceSampleContext(contextFor(value));
  const tuple = encodeBrowserResourceSample(value, context);
  const decoded = decodeBrowserResourceSample(tuple, context), before = copy(decoded);
  value.appOwnership.point.totals.cpuBytes = 77;
  tuple[23].push('synthetic-extra-diagnostic');
  assert.deepEqual(decoded, before);
  assert.equal(decoded.rendererOwnershipProof, context.rendererOwnershipProof);
  assert.ok(Object.isFrozen(decoded.rendererOwnershipProof.artifact));
  assert.throws(() => { decoded.rendererOwnershipProof.artifact.bytes = 101; });
});

test('context factory creates an independent deeply frozen snapshot', () => {
  const original = contextFor(sample()), before = copy(original);
  const snapshot = createBrowserResourceSampleContext(original);
  assert.deepEqual(snapshot, before);
  assert.notEqual(snapshot, original);
  assert.notEqual(snapshot.rendererOwnershipProof, original.rendererOwnershipProof);
  assert.notEqual(snapshot.rendererOwnershipProof.artifact, original.rendererOwnershipProof.artifact);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.rendererOwnershipProof));
  assert.ok(Object.isFrozen(snapshot.rendererOwnershipProof.executableIdentity));
  assert.ok(Object.isFrozen(snapshot.rendererOwnershipProof.artifact));
  assert.equal(Object.isFrozen(original), false);
  assert.equal(Object.isFrozen(original.rendererOwnershipProof), false);
  original.processIdentity = hash('f');
  original.rendererOwnershipProof.artifact.bytes = 42;
  assert.deepEqual(snapshot, before);
  assert.throws(() => { snapshot.processIdentity = hash('b'); });
  assert.throws(() => { snapshot.rendererOwnershipProof.executableIdentity.sourceDigest = 'changed'; });
});

test('context factory reuses its immutable snapshot and decoded proofs across rows', () => {
  const value = sample(), original = contextFor(value), snapshot = createBrowserResourceSampleContext(original);
  assert.equal(createBrowserResourceSampleContext(original), snapshot);
  assert.equal(createBrowserResourceSampleContext(snapshot), snapshot);
  const tuple = encodeBrowserResourceSample(value, original);
  const first = decodeBrowserResourceSample(tuple, original), second = decodeBrowserResourceSample(tuple, snapshot);
  assert.equal(first.rendererOwnershipProof, snapshot.rendererOwnershipProof);
  assert.equal(second.rendererOwnershipProof, first.rendererOwnershipProof);
  assert.notEqual(first.rendererOwnershipProof, original.rendererOwnershipProof);
  const empty = createBrowserResourceSampleContext({ processIdentity: value.processIdentity, rendererOwnershipProof: null });
  assert.ok(Object.isFrozen(empty));
  assert.equal(empty.rendererOwnershipProof, null);
});

test('mutating a retained raw context rejects later calls without changing decoded evidence', () => {
  for (const modify of [context => { context.processIdentity = hash('f'); },
    context => { context.rendererOwnershipProof = null; },
    context => { context.rendererOwnershipProof.reviewId = 'changed-review'; },
    context => { context.rendererOwnershipProof.artifact.bytes++; },
    context => { context.rendererOwnershipProof.executableIdentity.toolsDigest = hash('d'); },
    context => { context.extra = true; }]) {
    const value = sample(), original = contextFor(value), tuple = encodeBrowserResourceSample(value, original);
    const decoded = decodeBrowserResourceSample(tuple, original), before = copy(decoded);
    modify(original);
    assert.throws(() => createBrowserResourceSampleContext(original));
    assert.throws(() => decodeBrowserResourceSample(tuple, original));
    assert.throws(() => encodeBrowserResourceSample(value, original));
    assert.deepEqual(decoded, before);
    assert.ok(Object.isFrozen(decoded.rendererOwnershipProof.artifact));
  }
});

test('cached raw context still rejects new accessors without evaluating them', () => {
  const value = sample(), original = contextFor(value), snapshot = createBrowserResourceSampleContext(original);
  const tuple = encodeBrowserResourceSample(value, snapshot); let invoked = false;
  Object.defineProperty(original.rendererOwnershipProof.artifact, 'bytes', {
    enumerable: true, get() { invoked = true; return snapshot.rendererOwnershipProof.artifact.bytes; },
  });
  assert.throws(() => createBrowserResourceSampleContext(original));
  assert.throws(() => decodeBrowserResourceSample(tuple, original));
  assert.equal(invoked, false);
  assert.deepEqual(decodeBrowserResourceSample(tuple, snapshot), value);
});

test('null-prototype context and proof records are rejected before snapshot normalization', () => {
  const value = sample(), tuple = encode(value);
  for (const path of [[], ['rendererOwnershipProof'], ['rendererOwnershipProof', 'artifact']]) {
    const context = contextFor(value);
    Object.setPrototypeOf(at(context, path), null);
    assert.throws(() => createBrowserResourceSampleContext(context));
    assert.throws(() => encodeBrowserResourceSample(value, context));
    assert.throws(() => decodeBrowserResourceSample(tuple, context));
  }
});

test('nullable whole observations, renderer, proof, lifecycle, and byte values remain null', () => {
  const value = sample();
  for (const key of ['appOwnership', 'rendererOwnership', 'rendererOwnershipProof', 'documentLifecycle', 'combinedCpu',
    'browserRssBytes', 'backendRssBytes', 'cpuBytes', 'gpuBytes', 'previewCacheBytes', 'unusedHandles', 'textureSide', 'deviceTextureLimit', 'settledBytes']) value[key] = null;
  value.browserProcesses = []; value.backendProcesses = [];
  assert.deepEqual(wireRoundTrip(value), value);
});

test('nullable nested fields preserve unavailable clocks, counts, scope, vectors, and windows', () => {
  const value = sample();
  Object.assign(value.appOwnership.point, { ledgerInstanceId: null, clock: null, clockOriginMs: null, atMs: null,
    transitionSequence: null, cpuSequence: null, totals: null, centralCpuBytes: null, textBytes: null, textSequence: null, kinds: null });
  Object.assign(value.appOwnership.window, { scope: null, clock: null, clockOriginMs: null, endMs: null, kinds: null, text: null, peaks: null, failures: null });
  Object.assign(value.combinedCpu, { ledgerInstanceId: null, sequence: null, currentBytes: null, observedPeakBytes: null, missing: null });
  Object.assign(value.combinedCpu.window, { clock: null, clockOriginMs: null, startMs: null, failures: null, missing: null });
  Object.assign(value.rendererOwnership, { contract: null, backend: null, appOwnedTextureAPIs: null,
    appOwnedTextureCount: null, textureLimitApplicability: null, rgbaBackingEstimateBytes: null });
  Object.assign(value.documentLifecycle, { releasing: null, releases: null, lastReleaseMilliseconds: null });
  assert.deepEqual(wireRoundTrip(value), value);
  value.appOwnership.point = null; value.appOwnership.window = null; value.combinedCpu.window = null;
  assert.deepEqual(wireRoundTrip(value), value);
});

test('lifecycle sparse known counters preserve absence separately from zero and false', () => {
  const value = sample();
  value.documentLifecycle.consumers = { 'editor-client': {}, 'editor-shell': { uploads: 0, nativeTextActive: false } };
  const decoded = wireRoundTrip(value);
  assert.deepEqual(decoded, value);
  assert.equal(Object.hasOwn(decoded.documentLifecycle.consumers['editor-client'], 'uploads'), false);
  assert.equal(Object.hasOwn(decoded.documentLifecycle.consumers['editor-shell'], 'uploads'), true);
  value.documentLifecycle.consumers = {};
  assert.deepEqual(wireRoundTrip(value), value);
});

test('manual, final, and lifecycle-boundary sample kinds are retained', () => {
  for (const kind of ['scheduled', 'manual', 'final', 'window-start', 'window-end']) {
    const value = sample(); value.kind = kind;
    assert.deepEqual(wireRoundTrip(value), value);
  }
});

test('CPU window acknowledgements retain begin/end, nullable diagnostic values, and sealed state', () => {
  for (const boundary of ['begin', 'end', null]) {
    const value = sample(); value.cpuWindowBoundary = boundary;
    value.cpuWindowAck = { kind: 'combined-cpu-window-ack-1', schemaVersion: 1,
      ledgerInstanceId: ledgerId, id: windowId, ordinal: 1, boundary, sequence: 3,
      atMs: 12.5, clock: 'browser-performance', clockOriginMs: 1000, sealed: boundary === 'end' };
    assert.deepEqual(wireRoundTrip(value), value);
    Object.assign(value.cpuWindowAck, { ledgerInstanceId: null, id: null, ordinal: null, sequence: null,
      atMs: null, clock: null, clockOriginMs: null });
    assert.deepEqual(wireRoundTrip(value), value);
  }
});

test('negative zero is tagged only in numeric slots and survives JSON exactly', () => {
  const value = sample();
  value.sampleAtMs = -0; value.observation.startMs = -0; value.browserRssBytes = -0;
  value.browserProcesses[0].rssBytes = -0; value.appOwnership.point.totals.cpuBytes = -0;
  value.combinedCpu.window.peakAtMs = -0; value.documentLifecycle.consumers['editor-client'].uploads = -0;
  value.rendererOwnershipProof.reviewId = '-0';
  const tuple = encode(value);
  assert.equal(tuple[2], '-0'); assert.equal(tuple[3][0], '-0'); assert.equal(tuple[4], '-0');
  const decoded = wireRoundTrip(value);
  assert.deepEqual(decoded, value);
  assert.ok(Object.is(decoded.sampleAtMs, -0));
  assert.ok(Object.is(decoded.appOwnership.point.totals.cpuBytes, -0));
  assert.equal(decoded.rendererOwnershipProof.reviewId, '-0');
});

test('largest exact count and finite fractional clock round-trip without rounding', () => {
  const value = sample();
  value.cpuBytes = Number.MAX_SAFE_INTEGER;
  value.appOwnership.point.totals.cpuBytes = Number.MAX_SAFE_INTEGER;
  value.sampleAtMs = 123456.123456789; value.observation.startMs = value.sampleAtMs;
  value.observation.endMs = value.sampleAtMs + 0.000001;
  assert.deepEqual(wireRoundTrip(value), value);
  value.sampleAtMs = Number.MAX_VALUE; value.observation.startMs = Number.MAX_VALUE;
  value.observation.endMs = Number.MAX_VALUE;
  assert.deepEqual(wireRoundTrip(value), value);
});

test('sample identity and proof must exactly match the shared context', () => {
  const value = sample(), context = contextFor(value);
  for (const modify of [v => { v.processIdentity = hash('f'); },
    v => { v.rendererOwnershipProof = null; }, v => { v.rendererOwnershipProof.artifact.bytes++; }]) {
    const changed = copy(value); modify(changed);
    assert.throws(() => encodeBrowserResourceSample(changed, context));
  }
});

test('context requires both exact fields and does not accept absent or unknown keys', () => {
  const value = sample(), tuple = encode(value);
  for (const bad of [undefined, null, [], {}, { processIdentity: value.processIdentity },
    { ...contextFor(value), extra: true }]) {
    assert.throws(() => createBrowserResourceSampleContext(bad));
    assert.throws(() => encodeBrowserResourceSample(value, bad));
    assert.throws(() => decodeBrowserResourceSample(tuple, bad));
    assert.throws(() => createBrowserResourceSampleView([], bad));
  }
});

test('unknown and missing object fields are rejected throughout the sample', () => {
  const value = sample();
  for (const path of objectPaths(value)) {
    const changed = copy(value); at(changed, path).unexpected = 1;
    assert.throws(() => encode(changed), `unknown field at ${path.join('.')}`);
  }
  for (const path of [[], ['observation'], ['allocationCoverage'], ['appOwnership'], ['appOwnership', 'point'],
    ['appOwnership', 'window'], ['combinedCpu'], ['combinedCpu', 'window'], ['rendererOwnership'], ['documentLifecycle']]) {
    const changed = copy(value), object = at(changed, path); delete object[Object.keys(object)[0]];
    assert.throws(() => encode(changed), `missing field at ${path.join('.')}`);
  }
});

test('unknown lifecycle consumer names and counters are rejected instead of dropped', () => {
  for (const modify of [v => { v.documentLifecycle.consumers.other = {}; },
    v => { v.documentLifecycle.consumers['editor-client'].unknown = 1; },
    v => { v.documentLifecycle.consumers['editor-shell'].maskDrafts = null; }]) {
    const value = sample(); modify(value); assert.throws(() => encode(value));
  }
});

test('invalid top-level tuple types and lengths are rejected', () => {
  const value = sample(), context = contextFor(value), tuple = encode(value);
  for (const bad of [null, {}, 'tuple', [], tuple.slice(0, -1), [...tuple, null]]) {
    assert.throws(() => decodeBrowserResourceSample(bad, context));
  }
});

test('nested fixed tuple lengths are checked rather than truncated or default-filled', () => {
  const value = sample(), context = contextFor(value), original = encode(value);
  for (const path of [[3], [13, 0], [14, 0], [15], [16]]) {
    for (const delta of ['short', 'long']) {
      const tuple = copy(original), nested = at(tuple, path);
      if (delta === 'short') nested.pop(); else nested.push(null);
      assert.throws(() => decodeBrowserResourceSample(tuple, context), `${path.join('.')} ${delta}`);
    }
  }
});

test('sparse arrays are rejected at every encoded array depth', () => {
  const value = sample(), context = contextFor(value), original = encode(value);
  for (const path of arrayPaths(original)) {
    const tuple = copy(original), array = at(tuple, path);
    if (array.length) delete array[0]; else array.length = 1;
    assert.throws(() => decodeBrowserResourceSample(tuple, context), `hole at ${path.join('.')}`);
  }
});

test('sparse and extra-property source arrays cannot silently lose data', () => {
  const original = sample();
  for (const path of arrayPaths(original)) {
    for (const mode of ['hole', 'property']) {
      const value = copy(original), array = at(value, path);
      if (mode === 'property') array.extra = true;
      else if (array.length) delete array[0]; else array.length = 1;
      assert.throws(() => encode(value), `${mode} at ${path.join('.')}`);
    }
  }
});

test('extra tuple array properties, symbols, and hidden fields are rejected', () => {
  const value = sample(), context = contextFor(value);
  for (const modify of [tuple => { tuple.extra = true; }, tuple => { tuple[Symbol('extra')] = 1; },
    tuple => { Object.defineProperty(tuple, 'extra', { value: 1 }); }]) {
    const tuple = encode(value); modify(tuple);
    assert.throws(() => decodeBrowserResourceSample(tuple, context));
  }
});

test('object symbols and hidden extra fields are not silently omitted', () => {
  for (const modify of [value => { value[Symbol('extra')] = 1; },
    value => { Object.defineProperty(value.observation, 'extra', { value: 1 }); }]) {
    const value = sample(); modify(value); assert.throws(() => encode(value));
  }
});

test('sample and context accessors are rejected without invoking their getters', () => {
  for (const target of ['sample', 'nested', 'context']) {
    const value = sample(), context = contextFor(value); let invoked = false;
    const object = target === 'context' ? context : target === 'nested' ? value.observation : value;
    const key = target === 'context' ? 'processIdentity' : target === 'nested' ? 'startMs' : 'sampleAtMs';
    Object.defineProperty(object, key, { enumerable: true, get() { invoked = true; return 0; } });
    assert.throws(() => encodeBrowserResourceSample(value, context));
    assert.equal(invoked, false);
  }
});

test('sample proof accessors cannot impersonate matching context data or execute during comparison', () => {
  for (const path of [['reviewId'], ['artifact', 'bytes'], ['executableIdentity', 'sourceDigest']]) {
    const value = sample(), context = contextFor(value), object = at(value.rendererOwnershipProof, path.slice(0, -1));
    const key = path.at(-1), expected = object[key]; let invoked = false;
    Object.defineProperty(object, key, { enumerable: true, get() { invoked = true; return expected; } });
    assert.throws(() => encodeBrowserResourceSample(value, context));
    assert.equal(invoked, false);
  }
});

test('tuple accessors are rejected without invoking their getters', () => {
  const value = sample(), context = contextFor(value);
  for (const nested of [false, true]) {
    const tuple = encode(value); let invoked = false;
    Object.defineProperty(nested ? tuple[3] : tuple, '0', { enumerable: true, get() { invoked = true; return 0; } });
    assert.throws(() => decodeBrowserResourceSample(tuple, context));
    assert.equal(invoked, false);
  }
});

test('nonstandard object and array prototypes are rejected', () => {
  const value = sample(), context = contextFor(value);
  const changed = copy(value); Object.setPrototypeOf(changed.observation, { inherited: true });
  assert.throws(() => encodeBrowserResourceSample(changed, context));
  const tuple = encode(value); Object.setPrototypeOf(tuple[3], { inherited: true });
  assert.throws(() => decodeBrowserResourceSample(tuple, context));
  const changedContext = copy(context); Object.setPrototypeOf(changedContext, { inherited: true });
  assert.throws(() => decodeBrowserResourceSample(encode(value), changedContext));
});

test('unsafe, fractional, negative, nonnumeric, and nonfinite counts are rejected', () => {
  const paths = [['ordinal'], ['cpuBytes'], ['browserProcesses', 0, 'rssBytes'],
    ['appOwnership', 'point', 'totals', 'handles'], ['appOwnership', 'window', 'budgetRefusals'],
    ['combinedCpu', 'window', 'peakSequence'], ['documentLifecycle', 'consumers', 'editor-client', 'uploads']];
  for (const path of paths) for (const bad of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, NaN, Infinity, -Infinity, '1', 1n]) {
    const value = sample(); at(value, path.slice(0, -1))[path.at(-1)] = bad;
    assert.throws(() => encode(value), `${path.join('.')} = ${String(bad)}`);
  }
});

test('nonfinite, negative, and nonnumeric clock observations are rejected', () => {
  for (const path of [['sampleAtMs'], ['observation', 'endMs'], ['appOwnership', 'point', 'atMs'],
    ['appOwnership', 'window', 'clockOriginMs'], ['combinedCpu', 'window', 'peakAtMs'], ['documentLifecycle', 'lastReleaseMilliseconds']]) {
    for (const bad of [NaN, Infinity, -Infinity, -1, '1', true]) {
      const value = sample(); at(value, path.slice(0, -1))[path.at(-1)] = bad;
      assert.throws(() => encode(value), `${path.join('.')} = ${String(bad)}`);
    }
  }
});

test('decode validates numeric slots and does not coerce strings or nonfinite values', () => {
  const value = sample(), context = contextFor(value);
  for (const index of [0, 2, 4, 6, 12]) for (const bad of [Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '-1', '0', true]) {
    if (index === 2 && bad === Number.MAX_SAFE_INTEGER + 1) continue;
    const tuple = encode(value); tuple[index] = bad;
    assert.throws(() => decodeBrowserResourceSample(tuple, context), `index ${index}: ${String(bad)}`);
  }
});

test('wrong fixed discriminants, schema versions, or fixed CPU scope cannot be omitted silently', () => {
  for (const path of [['appOwnership', 'kind'], ['appOwnership', 'point', 'kind'], ['appOwnership', 'window', 'kind'],
    ['combinedCpu', 'kind'], ['combinedCpu', 'window', 'kind'], ['combinedCpu', 'scope']]) {
    const value = sample(); at(value, path.slice(0, -1))[path.at(-1)] = 'other';
    assert.throws(() => encode(value), path.join('.'));
  }
  for (const path of [['appOwnership'], ['appOwnership', 'point'], ['appOwnership', 'window'], ['combinedCpu'], ['combinedCpu', 'window']]) {
    const value = sample(); at(value, path).schemaVersion = 2;
    assert.throws(() => encode(value), path.join('.'));
  }
});

test('fixed application ownership kind order rejects reordered, missing, or extra rows', () => {
  for (const section of ['point', 'window']) for (const mode of ['swap', 'short', 'long']) {
    const value = sample(), rows = value.appOwnership[section].kinds;
    if (mode === 'swap') [rows[0], rows[1]] = [rows[1], rows[0]];
    else if (mode === 'short') rows.pop(); else rows.push(copy(rows[0]));
    assert.throws(() => encode(value), `${section} ${mode}`);
  }
});

test('diagnostic list bounds and code types remain exact', () => {
  for (const [path, maximum] of [[['missing'], 3], [['combinedCpu', 'missing'], 16],
    [['combinedCpu', 'window', 'failures'], 16], [['appOwnership', 'window', 'failures'], 8]]) {
    const value = sample(), object = at(value, path.slice(0, -1)), key = path.at(-1);
    object[key] = Array(maximum).fill('synthetic-diagnostic');
    assert.deepEqual(wireRoundTrip(value), value);
    object[key].push('one-too-many');
    assert.throws(() => encode(value), `${path.join('.')} bound`);
    for (const bad of ['x'.repeat(97), 'invalid diagnostic', null, 1]) {
      object[key] = [bad]; assert.throws(() => encode(value), `${path.join('.')} code`);
    }
  }
});

test('booleans and arrays are validated without truthiness coercion', () => {
  for (const path of [['forcedGC'], ['allocationCoverage', 'cpu'], ['globalAllocationCoverage', 'complete'],
    ['appOwnership', 'point', 'observationComplete'], ['combinedCpu', 'ownerCoverageComplete']]) {
    for (const bad of [0, 1, 'false', null]) {
      const value = sample(); at(value, path.slice(0, -1))[path.at(-1)] = bad;
      assert.throws(() => encode(value), path.join('.'));
    }
  }
  for (const path of [['missing'], ['browserProcesses'], ['combinedCpu', 'missing']]) {
    const value = sample(); at(value, path.slice(0, -1))[path.at(-1)] = {};
    assert.throws(() => encode(value), path.join('.'));
  }
});

test('proof metadata remains diagnostic and does not gain approval from encoding', () => {
  const value = sample();
  value.rendererOwnershipProof.reviewSha256 = 'malformed-but-bounded';
  value.rendererOwnershipProof.executableIdentity.sourceDigest = 'not-a-source-hash';
  value.rendererOwnershipProof.artifact.path = 'diagnostic-relative-path';
  value.rendererOwnershipProof.artifact.sha256 = 'not-a-content-hash';
  assert.deepEqual(wireRoundTrip(value), value);
});

test('proof metadata exceeding the 1024-byte UTF-8 limit is rejected', () => {
  for (const text of ['x'.repeat(1025), 'é'.repeat(513)]) {
    const value = sample(); value.rendererOwnershipProof.reviewId = text;
    const context = contextFor(value);
    assert.throws(() => encodeBrowserResourceSample(value, context));
    assert.throws(() => decodeBrowserResourceSample(encode(sample()), context));
  }
});

test('negative zero in unchanged JSON context bytes is rejected instead of losing its sign', () => {
  const value = sample(); value.rendererOwnershipProof.artifact.bytes = -0;
  const context = contextFor(value), ordinaryTuple = encode(sample());
  assert.throws(() => encodeBrowserResourceSample(value, context));
  assert.throws(() => decodeBrowserResourceSample(ordinaryTuple, context));
  value.rendererOwnershipProof.artifact.bytes = 0;
  assert.deepEqual(wireRoundTrip(value), value);
});

test('process rows have no new codec-specific count cap', () => {
  const value = sample();
  value.browserProcesses = Array.from({ length: 257 }, (_, index) => ({ pid: index + 1000, ppid: 90, rssBytes: index, identity: hash('b') }));
  assert.deepEqual(wireRoundTrip(value), value);
});

test('representative tuple reduces retained row bytes without asserting campaign capacity', () => {
  const value = sample(), context = contextFor(value), tuple = encodeBrowserResourceSample(value, context);
  const objectBytes = Buffer.byteLength(JSON.stringify(value)), tupleBytes = Buffer.byteLength(JSON.stringify(tuple));
  const oneContextBytes = Buffer.byteLength(JSON.stringify(context));
  assert.ok(tupleBytes < objectBytes, `tuple ${tupleBytes} bytes; object ${objectBytes} bytes`);
  assert.ok(tupleBytes + oneContextBytes < objectBytes, 'one representative row plus context is smaller');
  assert.deepEqual(decodeBrowserResourceSample(JSON.parse(JSON.stringify(tuple)), context), value);
  // No multiplication by duration or guarantee about process growth, integer
  // widths, identities, footer bytes, or the unchanged 256 MiB artifact cap.
});

test('lazy resource view exposes only its frozen bounded read API', () => {
  const { values, context, tuples } = viewFixture(), view = createBrowserResourceSampleView(tuples, context);
  assert.equal(Array.isArray(view), false);
  assert.ok(Object.isFrozen(view));
  assert.equal(view.length, values.length);
  assert.deepEqual(Object.keys(view).sort(), ['at', 'entries', 'length', 'some']);
  assert.equal(typeof view[Symbol.iterator], 'function');
  for (const key of ['0', 'slice', 'map', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']) {
    assert.equal(view[key], undefined, key);
  }
  assert.equal(Object.freeze(view), view);
});

test('lazy resource view at reads exact positive and negative safe-integer positions', () => {
  const { values, context, tuples } = viewFixture(), view = createBrowserResourceSampleView(tuples, context);
  assert.deepEqual(view.at(0), values[0]);
  assert.equal(view.at(-0), view.at(0));
  assert.deepEqual(view.at(3), values[3]);
  assert.deepEqual(view.at(-1), values.at(-1));
  assert.deepEqual(view.at(-view.length), values[0]);
  for (const index of [view.length, -view.length - 1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    assert.equal(view.at(index), undefined);
  }
  for (const index of [undefined, null, '0', true, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 0n]) {
    assert.throws(() => view.at(index), String(index));
  }
});

test('lazy resource view iteration and entries preserve row order and exact values', () => {
  const { values, context, tuples } = viewFixture(), view = createBrowserResourceSampleView(tuples, context);
  assert.deepEqual([...view], values);
  assert.deepEqual([...view.entries()], values.map((value, index) => [index, value]));
  const iterator = view[Symbol.iterator]();
  assert.deepEqual(iterator.next(), { value: values[0], done: false });
  for (let index = 1; index < values.length; index++) assert.deepEqual(iterator.next().value, values[index]);
  assert.deepEqual(iterator.next(), { value: undefined, done: true });
});

test('lazy resource view some uses native-like callback arguments and short circuits', () => {
  const { values, context, tuples } = viewFixture(), view = createBrowserResourceSampleView(tuples, context);
  const receiver = { sentinel: true }, seen = [];
  const result = view.some(function (row, index, actualView) {
    assert.equal(this, receiver);
    assert.equal(actualView, view);
    assert.deepEqual(row, values[index]);
    seen.push(index);
    return index === 1 ? 'truthy' : 0;
  }, receiver);
  assert.equal(result, true);
  assert.deepEqual(seen, [0, 1]);
  assert.equal(view.some(() => false), false);
  for (const predicate of [undefined, null, false, 1, 'function', {}]) assert.throws(() => view.some(predicate));
  const error = Error('synthetic predicate failure');
  assert.throws(() => view.some(() => { throw error; }), failure => failure === error);
});

test('lazy resource view retains four recent rows and updates recency on cache hits', () => {
  const { values, context, tuples } = viewFixture(), view = createBrowserResourceSampleView(tuples, context);
  const first = view.at(0), second = view.at(1), third = view.at(2), fourth = view.at(3);
  assert.equal(view.at(0), first);
  const fifth = view.at(4);
  assert.equal(view.at(0), first);
  assert.equal(view.at(3), fourth);
  const secondAgain = view.at(1);
  assert.notEqual(secondAgain, second);
  assert.deepEqual(secondAgain, values[1]);
  assert.equal(view.at(4), fifth);
  const thirdAgain = view.at(2);
  assert.notEqual(thirdAgain, third);
  assert.deepEqual(thirdAgain, values[2]);
});

test('lazy decoded rows are deeply frozen and share one immutable context proof', () => {
  const { context, tuples } = viewFixture(), view = createBrowserResourceSampleView(tuples, context);
  const first = view.at(0), second = view.at(1);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.browserProcesses));
  assert.ok(Object.isFrozen(first.browserProcesses[0]));
  assert.ok(Object.isFrozen(first.appOwnership.window.kinds[0].current));
  assert.ok(Object.isFrozen(first.documentLifecycle.consumers['editor-client']));
  assert.equal(first.rendererOwnershipProof, second.rendererOwnershipProof);
  assert.notEqual(first.rendererOwnershipProof, context.rendererOwnershipProof);
  assert.ok(Object.isFrozen(first.rendererOwnershipProof.artifact));
  assert.throws(() => { first.cpuBytes = 100; });
  assert.throws(() => { first.appOwnership.point.totals.handles = 1; });
  assert.throws(() => { first.missing.push('synthetic-mutation'); });
});

test('lazy resource view isolates its context snapshot from later constructor-input mutations', () => {
  const { values, context, tuples } = viewFixture(), view = createBrowserResourceSampleView(tuples, context);
  const first = view.at(0), originalProof = first.rendererOwnershipProof;
  context.processIdentity = hash('f');
  context.rendererOwnershipProof.reviewId = 'changed-after-view-creation';
  context.rendererOwnershipProof.artifact.bytes = 9;
  assert.deepEqual(view.at(0), values[0]);
  assert.deepEqual(view.at(5), values[5]);
  assert.equal(view.at(5).rendererOwnershipProof, originalProof);
  assert.throws(() => createBrowserResourceSampleContext(context));
});

test('lazy resource view freezes tuple storage in place and accepts already frozen storage', () => {
  for (const alreadyFrozen of [false, true]) {
    const { values, context, tuples } = viewFixture(), firstTuple = tuples[0];
    if (alreadyFrozen) freeze(tuples);
    const view = createBrowserResourceSampleView(tuples, context);
    assert.equal(tuples[0], firstTuple);
    assert.ok(Object.isFrozen(tuples));
    assert.ok(Object.isFrozen(tuples[0]));
    assert.ok(Object.isFrozen(tuples[0][3]));
    assert.throws(() => { tuples[0] = null; });
    assert.throws(() => { tuples[0][0] = 0; });
    assert.throws(() => { tuples.push(firstTuple); });
    assert.deepEqual(view.at(0), values[0]);
    assert.deepEqual([...view.entries()], values.map((value, index) => [index, value]));
  }
});

test('lazy resource view defers row-schema failure until the affected row is reached', () => {
  const { values, context, tuples } = viewFixture(8);
  tuples[7][0] = 0; // Dense JSON data, but not a valid positive sample ordinal.
  const view = createBrowserResourceSampleView(tuples, context);
  assert.equal(view.length, 8);
  assert.deepEqual(view.at(0), values[0]);
  assert.equal(view.some((_row, index) => index === 1), true);
  const entries = view.entries();
  for (let index = 0; index < 7; index++) assert.deepEqual(entries.next().value, [index, values[index]]);
  assert.throws(() => entries.next());
  assert.throws(() => view.at(7));
  assert.throws(() => view.at(-1));
  assert.throws(() => view.some(() => false));
});

test('lazy resource view rejects malformed outer arrays without evaluating accessors', () => {
  const { context } = viewFixture();
  for (const value of [null, {}, 'samples', new Set(), new Array(1)]) {
    assert.throws(() => createBrowserResourceSampleView(value, context));
  }
  for (const modify of [rows => { rows.extra = true; }, rows => { rows[Symbol('extra')] = 1; },
    rows => { Object.setPrototypeOf(rows, null); }, rows => { Object.defineProperty(rows, 'extra', { value: true }); }]) {
    const { tuples } = viewFixture(); modify(tuples);
    assert.throws(() => createBrowserResourceSampleView(tuples, context));
  }
  for (const nested of [false, true]) {
    const { tuples } = viewFixture(); let invoked = false;
    Object.defineProperty(nested ? tuples[0] : tuples, '0', {
      enumerable: true, get() { invoked = true; return 1; },
    });
    assert.throws(() => createBrowserResourceSampleView(tuples, context));
    assert.equal(invoked, false);
  }
});

test('lazy resource view supports empty input and enforces its 100000-row outer bound', () => {
  const value = sample(), context = contextFor(value), empty = createBrowserResourceSampleView([], context);
  assert.equal(empty.length, 0);
  assert.equal(empty.at(0), undefined);
  assert.equal(empty.at(-1), undefined);
  assert.deepEqual([...empty], []);
  assert.deepEqual([...empty.entries()], []);
  let called = false;
  assert.equal(empty.some(() => { called = true; return true; }), false);
  assert.equal(called, false);
  // Compact placeholders test the outer bound without allocating or walking
  // an expanded campaign's worth of nested rows. Only the last row is visited.
  const tuple = encodeBrowserResourceSample(value, context);
  const rows = Array(100000).fill(null); rows[99999] = tuple;
  const view = createBrowserResourceSampleView(rows, context);
  assert.equal(view.length, 100000);
  assert.deepEqual(view.at(99999), value);
  assert.throws(() => createBrowserResourceSampleView(Array(100001).fill(null), context));
});

test('lazy resource view cannot be mutated or extended through ordinary object operations', () => {
  const { context, tuples } = viewFixture(), view = createBrowserResourceSampleView(tuples, context);
  for (const mutate of [() => { view.length = 0; }, () => { view.at = () => null; },
    () => { view[0] = null; }, () => { delete view.entries; },
    () => Object.defineProperty(view, 'extra', { value: true }),
    () => Object.setPrototypeOf(view, {})]) assert.throws(mutate);
  assert.ok(Object.isFrozen(view));
});

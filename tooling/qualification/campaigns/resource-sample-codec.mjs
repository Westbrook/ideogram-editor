import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';

/** A wire representation only: decoding neither approves ownership nor changes
 * clocks, observations, sample cadence, byte limits, or qualification rules.
 * The v2 envelope stores {sampleCodec: RESOURCE_SAMPLE_CODEC, sampleContext}
 * once; sampleContext is exactly {processIdentity, rendererOwnershipProof}.
 * Its values are constructor invariants, checked on every encoded sample.
 * Footer/B0/peak/final witnesses remain their original full objects.
 */
export const RESOURCE_SAMPLE_CODEC = 'browser-resource-sample-tuple-1';
export const RESOURCE_SAMPLE_TUPLE_LENGTH = 25;

const fail = message => { throw Error('Invalid browser resource sample: ' + message); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function record(value, keys, label, optional = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) fail(label + ' object');
  const actual = Reflect.ownKeys(value);
  if ((!optional && actual.length !== keys.length) || actual.some(key => typeof key !== 'string' || !keys.includes(key)) ||
    (!optional && keys.some(key => !own(value, key)))) fail(label + ' keys');
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !own(descriptor, 'value')) fail(label + ' data properties');
  }
  return value;
}
function array(value, length, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    (length !== null && value.length !== length) || Reflect.ownKeys(value).length !== value.length + 1) fail(label + ' tuple length');
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !own(descriptor, 'value')) fail(label + ' dense data entries');
  }
  return value;
}
const primitive = (accept, label) => ({
  encode(value) { if (!accept(value)) fail(label); return value; },
  decode(value) { if (!accept(value)) fail(label); return value; },
});
function numeric(accept, label) {
  return {
    encode(value) { if (!accept(value)) fail(label); return Object.is(value, -0) ? '-0' : value; },
    decode(value) { const number = value === '-0' ? -0 : value; if (!accept(number)) fail(label); return number; },
  };
}
const bool = primitive(value => typeof value === 'boolean', 'boolean');
const unsigned = numeric(value => Number.isSafeInteger(value) && value >= 0, 'safe unsigned integer');
const positive = numeric(value => Number.isSafeInteger(value) && value > 0, 'positive safe integer');
const time = numeric(value => typeof value === 'number' && Number.isFinite(value) && value >= 0, 'finite nonnegative clock');
const text = primitive(value => typeof value === 'string' && value.length <= 1024, 'bounded proof string');
const hash = primitive(value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), 'process identity');
const id = primitive(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value), 'observer identifier');
const code = primitive(value => typeof value === 'string' && /^[a-z0-9-]{1,96}$/.test(value), 'diagnostic code');
const label = primitive(value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value), 'renderer label');
const choice = values => primitive(value => values.includes(value), 'enum');
const nullable = codec => ({ encode: value => value === null ? null : codec.encode(value), decode: value => value === null ? null : codec.decode(value) });
const n = nullable(unsigned), t = nullable(time), identifier = nullable(id);
const clock = nullable(choice(['browser-performance']));
function list(codec, maximum = null) {
  function transform(value, direction) {
    if (!Array.isArray(value) || maximum !== null && value.length > maximum) fail('list bound');
    array(value, null, 'list');
    const result = new Array(value.length);
    for (let i = 0; i < value.length; i++) result[i] = codec[direction](value[i]);
    return result;
  }
  return { encode: value => transform(value, 'encode'), decode: value => transform(value, 'decode') };
}
// This small local table is the complete, closed sample schema. Constants are
// omitted only after exact validation and reconstructed without inference.
function object(fields, constants = {}) {
  const names = fields.map(([name]) => name), keys = [...names, ...Object.keys(constants)];
  return {
    encode(value) {
      record(value, keys, 'record');
      for (const [name, constant] of Object.entries(constants)) if (value[name] !== constant) fail(name + ' constant');
      return fields.map(([name, codec]) => codec.encode(value[name]));
    },
    decode(value) {
      array(value, fields.length, 'record');
      const result = { ...constants };
      for (let i = 0; i < fields.length; i++) result[fields[i][0]] = fields[i][1].decode(value[i]);
      return result;
    },
  };
}
const fields = (names, codec) => names.map(name => [name, codec]);
const amounts = ['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'handles'];
const vector = nullable(object(fields(amounts, n)));
const state = nullable(object(fields(['records', ...amounts], n)));
const transitions = nullable(object(fields(['reserved', 'resized', 'released', 'observed'], n)));
const kinds = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
function kindRows(window) {
  const codecs = kinds.map(kind => object(window ? [
    ['initial', state], ['current', state], ['transitions', transitions], ['added', vector], ['removed', vector],
  ] : fields(['records', ...amounts], n), { kind }));
  return nullable({
    encode(value) { array(value, kinds.length, 'kind rows'); return codecs.map((codec, index) => codec.encode(value[index])); },
    decode(value) { array(value, kinds.length, 'kind rows'); return codecs.map((codec, index) => codec.decode(value[index])); },
  });
}
const codes = nullable(list(code, 16));
const cpuWindow = nullable(object([
  ['ledgerInstanceId', identifier], ['id', identifier], ['ordinal', n], ['clock', clock],
  ...fields(['clockOriginMs', 'startMs', 'endMs', 'peakAtMs'], t),
  ...fields(['startSequence', 'endSequence', 'peakSequence', 'currentBytes', 'peakBytes', 'ledgerBytesAtPeak', 'textBytesAtPeak', 'textStartSequence', 'textEndSequence'], n),
  ...fields(['sealed', 'observationComplete', 'ownerCoverageComplete'], bool), ['failures', codes], ['missing', codes],
], { kind: 'combined-cpu-window-1', schemaVersion: 1 }));
const combinedCpu = nullable(object([
  ['ledgerInstanceId', identifier], ...fields(['sequence', 'currentBytes', 'observedPeakBytes'], n),
  ...fields(['observationComplete', 'ownerCoverageComplete'], bool), ['missing', codes], ['window', cpuWindow],
], { kind: 'combined-cpu-observation-1', schemaVersion: 1, scope: 'browser-ledger-plus-text-reservations' }));
const cpuAck = nullable(object([
  ['ledgerInstanceId', identifier], ['id', identifier], ['ordinal', n], ['boundary', nullable(choice(['begin', 'end']))],
  ['sequence', n], ['atMs', t], ['clock', clock], ['clockOriginMs', t], ['sealed', bool],
], { kind: 'combined-cpu-window-ack-1', schemaVersion: 1 }));
const appPoint = nullable(object([
  ['ledgerInstanceId', identifier], ...fields(['transitionSequence', 'cpuSequence'], n), ['clock', clock],
  ...fields(['clockOriginMs', 'atMs'], t), ['totals', vector], ...fields(['centralCpuBytes', 'textBytes', 'textSequence'], n),
  ['kinds', kindRows(false)], ...fields(['observationComplete', 'globalCoverageComplete'], bool),
], { kind: 'app-ownership-point-1', schemaVersion: 1 }));
const appWindow = nullable(object([
  ['scope', nullable(choice(['application-owned-conservative-reservations']))], ['ledgerInstanceId', identifier], ['id', identifier], ['ordinal', n], ['clock', clock],
  ...fields(['clockOriginMs', 'startMs', 'endMs'], t),
  ...fields(['cpuStartSequence', 'cpuEndSequence', 'ledgerStartSequence', 'ledgerEndSequence', 'lastTransitionSequence'], n),
  ['sealed', bool], ['budgetRefusals', n], ['kinds', kindRows(true)],
  ['text', nullable(object([...fields(['initialBytes', 'currentBytes', 'startSequence', 'endSequence'], n), ['observationComplete', bool]]))],
  ['peaks', nullable(object(fields(['gpuBytes', 'previewCacheBytes', 'handles'], n)))],
  ...fields(['observationComplete', 'reconciled'], bool), ['failures', nullable(list(code, 8))], ['globalCoverageComplete', bool],
], { kind: 'app-ownership-window-1', schemaVersion: 1 }));
const appOwnership = nullable(object([
  ['ledgerInstanceId', identifier], ['transitionSequence', n], ['point', appPoint], ['window', appWindow],
], { kind: 'app-ownership-observation-1', schemaVersion: 1 }));
const renderer = nullable(object([
  ['contract', nullable(label)], ['backend', nullable(label)], ['appOwnedTextureAPIs', nullable(list(label, 16))],
  ['appOwnedTextureCount', n], ['textureLimitApplicability', nullable(label)], ['rgbaBackingEstimateBytes', n],
]));
const consumerKeys = ['uploads', 'draftReads', 'decodedBitmaps', 'canvasReads', 'reviewObjectURLs', 'inspectorDrafts', 'promptCharacters', 'nativeTextActive', 'nativeTextPending', 'nativeTextCharacters', 'nativeTextFiles', 'nativePreviewBytes', 'nativeWorkers', 'fontBackingBytes', 'maskDrafts', 'compositionModels'];
const consumerValue = {
  encode: value => typeof value === 'boolean' ? value : unsigned.encode(value),
  decode: value => typeof value === 'boolean' ? value : unsigned.decode(value),
};
const consumer = {
  encode(value) { record(value, consumerKeys, 'consumer', true); return consumerKeys.map(key => own(value, key) ? consumerValue.encode(value[key]) : null); },
  decode(value) { array(value, consumerKeys.length, 'consumer'); const result = {}; for (let i = 0; i < value.length; i++) if (value[i] !== null) result[consumerKeys[i]] = consumerValue.decode(value[i]); return result; },
};
const consumerNames = ['editor-client', 'editor-shell'];
const consumers = {
  encode(value) { record(value, consumerNames, 'consumers', true); return consumerNames.map(key => own(value, key) ? consumer.encode(value[key]) : null); },
  decode(value) { array(value, consumerNames.length, 'consumers'); const result = {}; for (let i = 0; i < value.length; i++) if (value[i] !== null) result[consumerNames[i]] = consumer.decode(value[i]); return result; },
};
const lifecycle = nullable(object([
  ['releasing', nullable(bool)], ['releases', n], ['lastReleaseMilliseconds', t], ['consumers', consumers],
]));
const coverage = object(fields(['complete', 'cpu', 'gpu', 'previewCache', 'handles', 'textureLimits'], bool));
const processRow = object([['pid', positive], ['ppid', unsigned], ['rssBytes', unsigned], ['identity', hash]]);
// No invented process-count ceiling: existing artifact and sampler identity
// limits continue to bound retained evidence and report explicit incompleteness.
const processes = list(processRow);
const sampleFields = [
  ['ordinal', positive], ['kind', choice(['scheduled', 'manual', 'window-start', 'window-end', 'final'])], ['sampleAtMs', time],
  ['observation', object(fields(['startMs', 'endMs'], time))],
  ...fields(['browserRssBytes', 'backendRssBytes', 'cpuBytes', 'gpuBytes', 'previewCacheBytes', 'unusedHandles', 'textureSide', 'deviceTextureLimit', 'settledBytes'], n),
  ['browserProcesses', processes], ['backendProcesses', processes], ['allocationCoverage', coverage], ['globalAllocationCoverage', coverage],
  ['appOwnership', appOwnership], ['rendererOwnership', renderer], ['documentLifecycle', lifecycle], ['combinedCpu', combinedCpu],
  ['cpuWindowBoundary', nullable(choice(['begin', 'end']))], ['cpuWindowAck', cpuAck], ['missing', list(code, 3)], ['forcedGC', bool],
];
const sampleCodec = object(sampleFields);
const proof = object([
  ['kind', choice(['renderer-ownership-proof-1', 'renderer-ownership-proof-2'])], ['reviewId', text], ['reviewSha256', text], ['contract', text],
  ['executableIdentity', object(fields(['sourceDigest', 'buildDigest', 'toolsDigest'], text))],
  ['artifact', object([['path', text], ['retainedPath', text], ['bytes', primitive(value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0), 'context byte count')], ['sha256', text]])],
]);
const contexts = new WeakMap();
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function contextValues(context) {
  const cached = context && typeof context === 'object' ? contexts.get(context) : undefined;
  if (cached !== undefined && cached === context) return cached;
  record(context, ['processIdentity', 'rendererOwnershipProof'], 'sample context');
  hash.encode(context.processIdentity);
  if (context.rendererOwnershipProof !== null) {
    // Preserve bounded malformed semantic values for the independent proof
    // verifier. Shape validation here must never become ownership approval.
    proof.encode(context.rendererOwnershipProof);
    if (Buffer.byteLength(JSON.stringify(context.rendererOwnershipProof)) > 1024) fail('renderer proof byte bound');
  }
  if (cached) {
    if (!isDeepStrictEqual(context, cached)) fail('sample context changed');
    return cached;
  }
  const snapshot = freeze(structuredClone(context));
  contexts.set(context, snapshot); contexts.set(snapshot, snapshot);
  return snapshot;
}

/** Call once before writing the envelope. The private snapshot cannot change
 * when an external constructor-option object is later mutated. */
export function createBrowserResourceSampleContext(context) { return contextValues(context); }

export function encodeBrowserResourceSample(sample, context) {
  const fixed = contextValues(context);
  record(sample, [...sampleFields.map(([name]) => name), 'processIdentity', 'rendererOwnershipProof'], 'sample');
  if (sample.rendererOwnershipProof !== null) proof.encode(sample.rendererOwnershipProof);
  if (sample.processIdentity !== fixed.processIdentity || !isDeepStrictEqual(sample.rendererOwnershipProof, fixed.rendererOwnershipProof)) fail('sample context differs');
  const values = {};
  for (const [name] of sampleFields) values[name] = sample[name];
  return sampleCodec.encode(values);
}

export function decodeBrowserResourceSample(tuple, context) {
  const fixed = contextValues(context);
  const value = sampleCodec.decode(tuple);
  // Sharing immutable envelope metadata avoids copying a proof for every row.
  // Callers replace raw.samples[i] in place; never map a second decoded array.
  value.processIdentity = fixed.processIdentity;
  value.rendererOwnershipProof = fixed.rendererOwnershipProof;
  return value;
}

// The exact wire schema is at most seven object/array levels including the
// outer sample list. This defensive walk accepts one extra level, never invokes
// accessors, and never builds a second list of rows or decoded observations.
function freezeWire(value, depth = 0) {
  if (value === null || typeof value !== 'object') return;
  if (depth > 8) fail('wire nesting bound');
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) fail('wire prototype');
  for (const key of Reflect.ownKeys(value)) {
    if (isArray && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !own(descriptor, 'value')) fail('wire data properties');
    freezeWire(descriptor.value, depth + 1);
  }
  Object.freeze(value);
}

/** Read-only bounded replay over the original tuples. Only four expanded rows
 * are cached. Consumers use at/entries/iteration/some and must not materialize
 * the whole view merely to inspect it. Semantic tuple validation remains in the
 * decoder and therefore runs when a verifier actually visits each row.
 * The original wire tree is frozen in place; no second tuple array is made.
 */
export function createBrowserResourceSampleView(tuples, context) {
  if (!Array.isArray(tuples) || tuples.length > 100_000) fail('sample row bound');
  array(tuples, null, 'samples');
  const fixed = contextValues(context), length = tuples.length;
  freezeWire(tuples);
  const cache = new Map();
  const row = index => {
    if (cache.has(index)) { const value = cache.get(index); cache.delete(index); cache.set(index, value); return value; }
    const value = freeze(decodeBrowserResourceSample(tuples[index], fixed));
    if (cache.size === 4) cache.delete(cache.keys().next().value);
    cache.set(index, value);
    return value;
  };
  const view = {
    length,
    at(index) {
      if (!Number.isSafeInteger(index)) fail('sample index');
      const absolute = index < 0 ? length + index : index;
      return absolute < 0 || absolute >= length ? undefined : row(absolute);
    },
    *entries() { for (let index = 0; index < length; index++) yield [index, row(index)]; },
    *[Symbol.iterator]() { for (let index = 0; index < length; index++) yield row(index); },
    some(predicate, thisArg) {
      if (typeof predicate !== 'function') fail('sample predicate');
      for (let index = 0; index < length; index++) if (Reflect.apply(predicate, thisArg, [row(index), index, view])) return true;
      return false;
    },
  };
  return Object.freeze(view);
}

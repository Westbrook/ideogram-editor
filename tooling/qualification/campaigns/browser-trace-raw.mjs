import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, open, writeFile} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {createDisplayFeedbackCollector} from './display-feedback-collector.mjs';
import {decodeRawTraceEvents, isRawTraceNumber} from './display-feedback-json.mjs';
import {analyzeDisplayFeedbackTrace} from './display-feedback.mjs';

const MAX_RAW_BYTES = 128 * 1024 * 1024;

function bounded(promise, milliseconds, reason) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(reason)), milliseconds);})]).finally(() => clearTimeout(timer));
}

function canonicalDecimal(raw) {
  if (raw.length > 128) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match || (match[4] && match[4].replace(/^[+-]/, '').length > 3)) return null;
  let scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (Math.abs(scale) > 400) return null;
  let numerator = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`);
  if (scale < 0) {numerator *= 10n ** BigInt(-scale); scale = 0;}
  if (numerator === 0n) return '0:0';
  while (scale && numerator % 10n === 0n) {numerator /= 10n; scale--;}
  return `${numerator}:${scale}`;
}

// Legacy diagnostics use Number timestamps, but their decimal JSON value must
// round-trip exactly. Oversized integers stay strings so existing typed-ID
// sanitizers retain their exact identity. The raw artifact remains authoritative.
function compatible(value) {
  if (isRawTraceNumber(value)) {
    const numeric = Number(value.raw), original = canonicalDecimal(value.raw);
    return Number.isFinite(numeric) && Math.abs(numeric) <= Number.MAX_SAFE_INTEGER && original !== null && original === canonicalDecimal(String(numeric)) ? numeric : value.raw;
  }
  if (Array.isArray(value)) return value.map(compatible);
  if (value && typeof value === 'object') {
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) Object.defineProperty(result, key, {value: compatible(item), enumerable: true, configurable: true, writable: true});
    return result;
  }
  return value;
}

async function* rawFileBytes(path, expectedBytes) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let stream;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size !== expectedBytes || before.size > MAX_RAW_BYTES ||
        (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw Error('Raw artifact identity unavailable');
    stream = file.createReadStream({autoClose: false, highWaterMark: 16 * 1024});
    for await (const bytes of stream) yield bytes;
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Raw artifact changed during replay');
  } finally {stream?.destroy(); await file.close();}
}

/**
 * Shared bounded reader for retained-evidence replay. expectedPath must be
 * independently resolved from the owning producer/invocation closure; a path
 * taken only from this manifest does not establish that ownership. The caller
 * must exhaust analyzeDisplayFeedbackTrace with these chunks for content/hash
 * validation. This reader alone grants no evidence authority.
 */
export function rawDisplayFeedbackChunks({manifest, expectedPath} = {}) {
  const artifact = manifest?.artifact;
  if (manifest?.kind !== 'display-feedback-raw-trace-1' || typeof expectedPath !== 'string' || !isAbsolute(expectedPath) || resolve(expectedPath) !== expectedPath ||
      artifact?.path !== expectedPath || artifact.format !== 'json' || artifact.compression !== 'none' ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > MAX_RAW_BYTES || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw Error('Invalid independently bound raw feedback artifact');
  return rawFileBytes(expectedPath, artifact.bytes);
}

async function deriveSanitized(manifest, {maxEvents, maxBytes, sanitize, isWorkEvent, expectedPath}) {
  const events = [], reasons = new Set(), hash = createHash('sha256');
  let received = 0, retainedBytes = 0, rawBytes = 0, validated = false;
  async function* hashed() {
    for await (const bytes of rawDisplayFeedbackChunks({manifest, expectedPath})) {
      hash.update(bytes); rawBytes += bytes.byteLength; yield bytes;
    }
  }
  try {
    for await (const raw of decodeRawTraceEvents(hashed(), {maxEventBytes: 256 * 1024})) {
      received++;
      if (received > maxEvents) {reasons.add('event-limit'); continue;}
      if (reasons.has('byte-limit')) continue;
      const event = compatible(raw), sanitized = sanitize(event);
      if (!sanitized) {if (isWorkEvent(event)) reasons.add('malformed-work-event'); continue;}
      const size = Buffer.byteLength(JSON.stringify(sanitized)) + 1;
      if (retainedBytes + size > maxBytes - 4096) {reasons.add('byte-limit'); continue;}
      events.push(sanitized); retainedBytes += size;
    }
    validated = true;
  } catch {reasons.add('raw-feedback-replay-invalid');}
  const digest = hash.digest('hex');
  if (rawBytes !== manifest.artifact.bytes || digest !== manifest.artifact.sha256) reasons.add('raw-feedback-integrity-mismatch');
  if (!validated || reasons.has('raw-feedback-integrity-mismatch')) {events.length = 0; retainedBytes = 0;}
  return {events, received, retainedBytes, reasons: [...reasons], fullRawJsonValidated: validated};
}

/**
 * Optional single-owner replacement transport selected by createBrowserTrace.
 * Its result retains the legacy artifact/collection/analysis/presentation shape
 * and adds rawFeedback. No second CDP trace is started and no browser is closed.
 * The caller brackets the original full workload and always drains stop().
 */
export function createRawBrowserTrace(page, options) {
  const {artifactDirectory, artifactName, maxEvents, maxBytes, completionTimeoutMs, rawFeedback, sanitize, analyze, present, isWorkEvent} = options;
  if (!rawFeedback || typeof rawFeedback !== 'object' || Array.isArray(rawFeedback)) throw Error('Raw feedback selection requires explicit ownership');
  const rawName = rawFeedback.artifactName ?? artifactName.replace(/\.json$/, '.raw.json');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.json$/.test(rawName) || rawName === artifactName) throw Error('Invalid raw feedback artifact name');
  if (![sanitize, analyze, present, isWorkEvent].every(value => typeof value === 'function')) throw Error('Missing raw trace legacy adapters');
  const allowed = new Set(['ownership', 'artifactName']);
  if (Object.keys(rawFeedback).some(key => !allowed.has(key))) throw Error('Unsupported raw feedback option');
  let state = 'new', session, collector, stopPromise;
  const reasons = new Set();
  async function start() {
    if (state !== 'new') throw Error('Trace may start only once');
    state = 'starting';
    try {
      await mkdir(artifactDirectory, {recursive: true, mode: 0o700});
      const pending = Promise.resolve().then(() => page.context().newCDPSession(page));
      pending.then(value => {if (state === 'unavailable' || state === 'stopping' || state === 'stopped') void value.detach().catch(() => {});}, () => {});
      session = await bounded(pending, completionTimeoutMs, 'cdp-unavailable');
      collector = createDisplayFeedbackCollector({session, artifactPath: join(artifactDirectory, rawName), ownership: rawFeedback.ownership,
        commandTimeoutMs: Math.min(completionTimeoutMs, 10_000), completionTimeoutMs: Math.min(completionTimeoutMs, 10_000)});
      const result = await collector.start();
      state = result.status === 'active' ? 'active' : 'unavailable';
      if (state !== 'active') reasons.add('raw-feedback-start-unavailable');
      return {status: state, qualification: false, transport: 'ReturnAsStream', rawFeedback: true};
    } catch {
      reasons.add('raw-feedback-start-unavailable'); state = 'unavailable';
      if (session && !collector) await bounded(Promise.resolve().then(() => session.detach()), completionTimeoutMs, 'cdp-detach-timeout').catch(() => reasons.add('raw-feedback-detach-unavailable'));
      return {status: state, qualification: false, transport: 'ReturnAsStream', rawFeedback: true};
    }
  }
  function stop(analysisOptions = {}) {
    if (stopPromise) return stopPromise;
    if (state === 'starting') throw Error('Await trace start before stopping');
    stopPromise = (async () => {
      if (state === 'new') reasons.add('raw-feedback-not-started');
      const initialState = state; state = 'stopping';
      let manifest = null, feedbackAnalysis = null, derived = {events: [], received: 0, retainedBytes: 0, reasons: [], fullRawJsonValidated: false};
      if (collector) {
        try {manifest = await collector.stop();}
        catch {reasons.add('raw-feedback-closure-unavailable');}
      }
      if (manifest?.collection?.status === 'complete') {
        derived = await deriveSanitized(manifest, {maxEvents, maxBytes, sanitize, isWorkEvent, expectedPath: join(artifactDirectory, rawName)});
        if (derived.fullRawJsonValidated && !derived.reasons.includes('raw-feedback-integrity-mismatch')) {
          try {feedbackAnalysis = await analyzeDisplayFeedbackTrace({chunks: rawDisplayFeedbackChunks({manifest, expectedPath: join(artifactDirectory, rawName)}), manifest, cohort: analysisOptions.rawFeedbackCohort});}
          catch {reasons.add('raw-feedback-analysis-unavailable');}
          if (feedbackAnalysis && (!feedbackAnalysis.rawArtifact?.fullJsonValidated || !feedbackAnalysis.rawArtifact?.matchesCollectionManifest)) {
            reasons.add('raw-feedback-integrity-mismatch'); derived.events.length = 0; derived.retainedBytes = 0;
          }
        }
      } else reasons.add('raw-feedback-collection-incomplete');
      for (const value of derived.reasons) reasons.add(value);
      const collection = {status: initialState === 'new' || initialState === 'unavailable' ? 'unavailable' : reasons.size ? 'incomplete' : 'complete',
        reasons: [...reasons].sort(), completeEventReceived: manifest?.collection?.completeEventReceived === true,
        eventsReceived: derived.received, eventsRetained: derived.events.length, bytesRetained: derived.retainedBytes, maxEvents, maxBytes,
        transport: 'ReturnAsStream', derivedFromVerifiedRaw: derived.fullRawJsonValidated && !reasons.has('raw-feedback-integrity-mismatch')};
      const trace = {kind: 'sanitized-chromium-trace-1', clock: 'chromium-monotonic-microseconds', collection, events: derived.events};
      const bytes = Buffer.from(JSON.stringify(trace));
      if (bytes.length > maxBytes) throw Error('Trace artifact byte bound exceeded');
      await mkdir(artifactDirectory, {recursive: true, mode: 0o700});
      const path = join(artifactDirectory, artifactName);
      await writeFile(path, bytes, {flag: 'wx', mode: 0o600});
      state = 'stopped';
      return {artifact: {path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}, collection,
        analysis: analyze(trace, analysisOptions), presentation: present({...analysisOptions.presentation, trace}),
        rawFeedback: {kind: 'browser-raw-feedback-route-1', qualification: false, manifest, analysis: feedbackAnalysis,
          rawAndSanitizedShareOneTrace: manifest?.collection?.startOutcome === 'acknowledged', fullRawJsonValidated: derived.fullRawJsonValidated,
          missing: [...new Set([...(feedbackAnalysis?.reasons ?? ['raw-feedback-analysis-unavailable']), ...reasons])]}};
    })();
    return stopPromise;
  }
  return Object.freeze({start, stop});
}

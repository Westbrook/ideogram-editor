import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';

// Source references describe the transport, not the running browser's identity.
// A separate parser must validate the exact raw bytes and exact Chromium source.
export const DISPLAY_FEEDBACK_TRACE_SOURCES = Object.freeze({
  readOn: '2026-09-30',
  pinnedChromium: '153.0.8010.12',
  tracing: 'https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/third_party/blink/public/devtools_protocol/domains/Tracing.pdl',
  graphicsPipelineSubmit: 'https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/cc/trees/layer_tree_host_impl.cc',
  beginFrame: 'https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/components/viz/service/frame_sinks/compositor_frame_sink_support.cc',
  // These three references are HEAD observations, not pinned-binary proof.
  ioHEAD: 'https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/IO.pdl',
  eventLatencyHEAD: 'https://raw.githubusercontent.com/chromium/chromium/main/cc/metrics/event_latency_tracing_recorder.cc',
  graphicsPipelineDisplayHEAD: 'https://raw.githubusercontent.com/chromium/chromium/main/components/viz/service/display/display.cc',
});

// Fixed filters only. EventLatency uses cc/benchmark/input/input.scrolling;
// Graphics.Pipeline uses viz/benchmark/graphics.pipeline; BeginFrame uses viz
// and input.scrolling. No screenshots, netlog, memory dumps or JS stacks.
export const DISPLAY_FEEDBACK_TRACE_CATEGORIES = Object.freeze([
  'cc', 'benchmark', 'input', 'input.scrolling', 'viz', 'graphics.pipeline',
  'blink.user_timing', 'disabled-by-default-display.framedisplayed',
  // The single raw campaign trace also supplies the existing sanitized
  // main-thread/work-lane diagnostic output. Do not start a second trace.
  'toplevel', 'devtools.timeline', 'gpu',
]);
export const DISPLAY_FEEDBACK_TRACE_LIMITS = Object.freeze({
  maxBytes: 128 * 1024 * 1024, maxReadBytes: 64 * 1024, maxReadCalls: 8192,
  commandTimeoutMs: 10_000, completionTimeoutMs: 10_000,
  captureTimeoutMs: 75_000, streamTimeoutMs: 30_000,
  sinkTimeoutMs: 10_000, artifactCleanupTimeoutMs: 10_000,
});

class CaptureFailure extends Error {
  constructor(reason) {super(reason); this.reason = reason;}
}
function fail(reason) {throw new CaptureFailure(reason);}
function integer(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error(`Invalid ${name}`);
  return value;
}
function declaration(value) {
  if (value?.kind !== 'owned-isolated-synthetic-browser-1' || value.admittedBy !== 'root' ||
      value.owned !== true || value.isolated !== true || value.syntheticOnly !== true ||
      value.sessionOwned !== true || typeof value.browserInstanceId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.browserInstanceId)) {
    throw Error('An owned isolated synthetic browser and owned CDP session require explicit root admission');
  }
  return Object.freeze({kind: value.kind, admittedBy: 'root', owned: true, isolated: true,
    syntheticOnly: true, sessionOwned: true, browserInstanceId: value.browserInstanceId});
}
function bounded(operation, timeoutMs, timeoutReason) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {timer = setTimeout(() => reject(new CaptureFailure(timeoutReason)), timeoutMs);}),
  ]).finally(() => clearTimeout(timer));
}

async function privateRegularFile(path) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw Error('Private regular file required');
    return handle;
  } catch (error) {await handle.close(); throw error;}
}

// The parent directory must already exist, be canonical and be private to the
// current user. No directory creation, path repair, truncation or replacement.
// Sink injection is a test seam, not an alternate provenance/qualification path.
async function createPrivateSink(artifactPath) {
  const directory = dirname(artifactPath);
  if (await realpath(directory) !== directory) throw Error('Canonical artifact directory required');
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw Error('Private artifact directory required');
  const raw = await privateRegularFile(artifactPath);
  let closed = false;
  return {
    async write(bytes) {return (await raw.write(bytes)).bytesWritten;},
    async flush() {await raw.sync(); return {size: (await raw.stat()).size};},
    async close() {if (!closed) {closed = true; await raw.close();}},
    async saveManifest(manifest) {
      const file = await privateRegularFile(`${artifactPath}.manifest.json`);
      try {await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await file.sync();}
      finally {await file.close();}
    },
  };
}

// This decodes the CDP IO envelope only. It never parses the trace JSON, coerces
// IDs, normalizes whitespace or appends a newline. UTF-8 strings must be valid
// scalar sequences; otherwise re-encoding would silently replace source bytes.
function rawChunk(response, maxReadBytes) {
  if (!response || typeof response.data !== 'string' || typeof response.eof !== 'boolean' ||
      (response.base64Encoded !== undefined && typeof response.base64Encoded !== 'boolean')) fail('malformed-read-response');
  let bytes;
  if (response.base64Encoded) {
    if (response.data.length > 4 * Math.ceil(maxReadBytes / 3)) fail('read-chunk-limit');
    if (response.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.data)) fail('malformed-base64');
    bytes = Buffer.from(response.data, 'base64');
    if (bytes.toString('base64') !== response.data) fail('malformed-base64');
  } else {
    if (response.data.length > maxReadBytes) fail('read-chunk-limit');
    if (!response.data.isWellFormed()) fail('malformed-utf8-envelope');
    bytes = Buffer.from(response.data, 'utf8');
  }
  if (bytes.length > maxReadBytes) fail('read-chunk-limit');
  return bytes;
}

/**
 * Raw stock-CDP transport for a root-admitted, dedicated synthetic browser.
 * No browser launch, browser close, connection discovery or trace retry occurs.
 * The caller supplies a pre-existing *owned* session and remains responsible for
 * closing its browser, especially when a timed-out start cannot be acknowledged.
 * start(): active/incomplete transport status. stop(): idempotent final manifest.
 * A complete collection means transport completion only, never physical-display
 * qualification, valid JSON, causal attribution or independently proven origin.
 *
 * Tests may inject sinkFactory(path), returning write(Buffer)->bytesWritten,
 * flush()->{size}, close(), saveManifest(object). Production uses private files.
 * Every sink await has a deadline. Deadlines cannot cancel kernel I/O: a timed
 * out operation remains explicit, and a late factory result is closed through
 * a separately bounded cleanup. The returned receipt is a terminal snapshot;
 * late operations can never upgrade it. The saved sidecar is provisional until
 * paired with the returned save acknowledgement (embedded by the raw route).
 */
export function createDisplayFeedbackCollector(options = {}) {
  const {session, artifactPath, sinkFactory = createPrivateSink} = options;
  if (!session || !['send', 'on', 'off', 'detach'].every(name => typeof session[name] === 'function')) throw Error('An owned CDP session is required');
  if (typeof artifactPath !== 'string' || !isAbsolute(artifactPath) || resolve(artifactPath) !== artifactPath ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.json$/.test(basename(artifactPath))) throw Error('Invalid raw trace path');
  if (typeof sinkFactory !== 'function') throw Error('Invalid sink factory');
  const ownership = declaration(options.ownership);
  const limits = {};
  for (const [name, fallback] of Object.entries(DISPLAY_FEEDBACK_TRACE_LIMITS)) {
    limits[name] = integer(options[name] ?? fallback, name, fallback);
  }
  const reasons = new Set(), hash = createHash('sha256');
  let state = 'new', sink, startPromise, stopPromise, captureTimer;
  let startAcknowledged = false, startOutcome = 'not-sent', endRequested = false;
  let startPending = false, preStartInterference = false, foreignTraceObserved = false;
  let completionOwnership = 'none', unresolvedAdditionalStream = false;
  let completeEventReceived = false, dataLossOccurred = null, stream, eof = false;
  let bytes = 0, readCalls = 0, persistedSize = null, rawClosed = false;
  let streamCloseAttempted = false, streamClosed = false, detachAttempted = false, detached = false;
  let closingCollection = false, streamClosePromise;
  let attached = false, traceFormat = null, streamCompression = null, bufferUsagePeak = null;
  let browserVersion = {status: 'unavailable', source: 'supplied-session-Browser.getVersion'};
  let artifactCleanupRequired = false, rawMutationUncertain = false;
  const lateOperations = [];
  let finishCompletion;
  const completed = new Promise(resolveCompletion => {finishCompletion = resolveCompletion;});
  const reason = value => reasons.add(value);
  const captureError = (error, fallback) => reason(error instanceof CaptureFailure ? error.reason : fallback);
  const timeoutNames = {'IO.read': 'stream-read', 'Tracing.start': 'trace-start', 'Tracing.end': 'trace-end', 'IO.close': 'stream-close', 'Browser.getVersion': 'browser-version'};
  const command = (name, params, timeout = limits.commandTimeoutMs) => bounded(() => session.send(name, params), timeout, `${timeoutNames[name]}-timeout`);
  const traceConfig = {recordMode: 'recordUntilFull', traceBufferSizeInKb: Math.max(1, Math.ceil(limits.maxBytes / 1024)),
    enableSampling: false, enableSystrace: false, enableArgumentFilter: false,
    includedCategories: [...DISPLAY_FEEDBACK_TRACE_CATEGORIES], excludedCategories: ['*']};

  // Deliberately observe both late resolution and late rejection. A timeout is
  // not cancellation; neither the hash nor a returned receipt may be updated by
  // a subsequently acknowledged write. Only an arriving factory handle gets an
  // additional operation, one bounded close of that newly owned handle.
  function sinkCall(operation, action, timeoutMs = limits.sinkTimeoutMs) {
    const pending = Promise.resolve().then(action);
    let expired = false, record;
    return new Promise((resolveOperation, rejectOperation) => {
      const timer = setTimeout(() => {
        expired = true; artifactCleanupRequired = true;
        if (operation !== 'saveManifest') rawMutationUncertain = true;
        record = {operation, lateOutcome: 'pending', cancellable: false,
          disposition: operation === 'factory' ? 'bounded-close-if-factory-resolves' : 'observe-only-no-retry',
          cleanup: operation === 'factory' ? 'awaiting-owned-handle' : 'not-retried'};
        lateOperations.push(record);
        rejectOperation(new CaptureFailure(`artifact-${operation}-timeout`));
      }, timeoutMs);
      pending.then(value => {
        clearTimeout(timer);
        if (!expired) {resolveOperation(value); return;}
        record.lateOutcome = 'resolved';
        if (operation === 'factory') {
          record.cleanup = 'pending';
          // Attach rejection handling immediately; cleanup has its own deadline.
          void bounded(() => {
            if (!value || typeof value.close !== 'function') fail('late-factory-missing-close');
            return value.close();
          }, limits.artifactCleanupTimeoutMs, 'late-factory-close-timeout').then(
            () => {record.cleanup = 'closed';},
            error => {record.cleanup = error instanceof CaptureFailure ? error.reason : 'late-factory-close-failed';},
          );
        }
      }, error => {
        clearTimeout(timer);
        if (!expired) rejectOperation(error);
        else {record.lateOutcome = 'rejected'; if (operation === 'factory') record.cleanup = 'no-handle-returned';}
      });
    });
  }
  function foreignEvent() {
    foreignTraceObserved = true;
    if (!startPending && !startAcknowledged && startOutcome === 'not-sent') preStartInterference = true;
    reason('foreign-trace-event');
    void stop();
  }

  function complete(payload) {
    if (!startAcknowledged && !startPending) {foreignEvent(); return;}
    const handle = typeof payload?.stream === 'string' && payload.stream.length > 0 && payload.stream.length <= 4096 ? payload.stream : undefined;
    if (completeEventReceived) {
      reason('duplicate-completion');
      if (!handle || handle !== stream) {unresolvedAdditionalStream = true; reason('additional-stream-unresolved');}
      return;
    }
    completeEventReceived = true;
    completionOwnership = startAcknowledged && endRequested ? 'acknowledged-own-start' : 'unresolved';
    if (!startAcknowledged) {
      // CDP supplies no capture identity. A completion racing our pending start
      // may belong to an earlier trace; a later start acknowledgement cannot
      // establish ownership of that previously received stream.
      foreignTraceObserved = true; reason('completion-during-start-unresolved');
    } else if (!endRequested) {
      // An unsolicited completion after start acknowledgement still has no
      // generation identity and cannot discharge ownership of the active trace.
      foreignTraceObserved = true; reason('unrequested-completion-unresolved');
    }
    if (!endRequested) reason('unexpected-completion');
    dataLossOccurred = typeof payload?.dataLossOccurred === 'boolean' ? payload.dataLossOccurred : null;
    if (dataLossOccurred !== false) reason('browser-data-loss-or-unknown');
    traceFormat = payload?.traceFormat === undefined ? null : ['json', 'proto'].includes(payload.traceFormat) ? payload.traceFormat : 'invalid';
    streamCompression = payload?.streamCompression === undefined ? null : ['none', 'gzip'].includes(payload.streamCompression) ? payload.streamCompression : 'invalid';
    if (traceFormat !== null && traceFormat !== 'json') reason('unexpected-stream-format');
    if (streamCompression !== null && streamCompression !== 'none') reason('unexpected-stream-compression');
    if (handle) stream = handle;
    else {reason('missing-stream'); unresolvedAdditionalStream = true;}
    finishCompletion();
    // A late completion after the bounded wait may still arrive during detach.
    // Close its stream once; never reopen the collection or erase its timeout.
    if (closingCollection) void closeReturnedStream();
    if (!endRequested) void stop();
  }
  function dataCollected() {
    if (!startAcknowledged && !startPending) {foreignEvent(); return;}
    reason('unexpected-data-events'); void stop();
  }
  function bufferUsage(payload) {
    if (!startAcknowledged && !startPending) {foreignEvent(); return;}
    if ([payload?.percentFull, payload?.value].some(value => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))) {
      reason('malformed-buffer-usage'); void stop(); return;
    }
    const values = [payload?.percentFull, payload?.value].filter(value => Number.isFinite(value) && value >= 0 && value <= 1);
    if (values.length) bufferUsagePeak = Math.max(bufferUsagePeak ?? 0, ...values);
    if (values.some(value => value >= 0.9)) {
      reason('browser-buffer-limit'); void stop();
    }
  }
  function detachedEvent() {if (!detachAttempted) {reason('session-detached'); finishCompletion(); void stop();}}

  async function runStart() {
    state = 'starting';
    try {
      sink = await sinkCall('factory', () => sinkFactory(artifactPath));
      if (!sink || !['write', 'flush', 'close', 'saveManifest'].every(name => typeof sink[name] === 'function')) fail('invalid-sink');
    } catch (error) {captureError(error, 'artifact-open-failed'); state = 'incomplete'; return {status: state, reasons: [...reasons], qualification: false, provenanceRequired: true};}
    session.on('Tracing.tracingComplete', complete);
    session.on('Tracing.dataCollected', dataCollected);
    session.on('Tracing.bufferUsage', bufferUsage);
    session.on('Disconnected', detachedEvent);
    attached = true;
    try {
      try {
        const value = await command('Browser.getVersion');
        const fields = {protocolVersion: 64, product: 256, revision: 256, userAgent: 2048, jsVersion: 256};
        if (!Object.entries(fields).every(([key, limit]) => typeof value?.[key] === 'string' && value[key].length > 0 && value[key].length <= limit && !/[\u0000-\u001f\u007f]/.test(value[key]))) {
          browserVersion = {...browserVersion, reason: 'malformed-version-response'};
        } else browserVersion = {...browserVersion, status: 'observed', ...Object.fromEntries(Object.keys(fields).map(key => [key, value[key]]))};
      } catch {browserVersion = {...browserVersion, reason: 'version-unavailable'};}
      const parameters = {
        transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none',
        bufferUsageReportingInterval: 250,
        traceConfig: {...traceConfig, includedCategories: [...traceConfig.includedCategories], excludedCategories: [...traceConfig.excludedCategories]},
      };
      await bounded(() => {
        // A foreign trace may complete while Browser.getVersion is in flight.
        // Check at actual dispatch, not merely before scheduling this callback.
        if (preStartInterference) fail('pre-start-trace-interference');
        if (stopPromise) fail('trace-start-cancelled');
        startPending = true; startOutcome = 'sent';
        return session.send('Tracing.start', parameters);
      }, limits.commandTimeoutMs, 'trace-start-timeout');
      startPending = false; startAcknowledged = true; startOutcome = 'acknowledged';
      state = reasons.size || stopPromise ? 'incomplete' : 'active';
      if (state === 'active') captureTimer = setTimeout(() => {reason('capture-time-limit'); void stop();}, limits.captureTimeoutMs);
    } catch (error) {
      startPending = false;
      captureError(error, 'trace-start-rejected');
      startOutcome = startOutcome === 'not-sent' ? 'aborted-before-start' : error instanceof CaptureFailure ? 'unacknowledged-timeout' : 'rejected';
      if (completeEventReceived) {completionOwnership = 'unresolved'; foreignTraceObserved = true;}
      state = 'incomplete';
      // In particular, an overlapping existing trace must never be ended here.
    }
    return {status: state, reasons: [...reasons], qualification: false, provenanceRequired: true};
  }

  function start() {
    if (state !== 'new' || startPromise || stopPromise) throw Error('Trace may start only once');
    startPromise = runStart();
    void startPromise.then(result => {if (result.status !== 'active') void stop();});
    return startPromise;
  }

  async function drain() {
    const deadline = performance.now() + limits.streamTimeoutMs;
    while (!eof) {
      if (readCalls >= limits.maxReadCalls) fail('read-call-limit');
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) fail('stream-time-limit');
      // Read at most one byte beyond a full budget to distinguish exact EOF.
      const requested = Math.min(limits.maxReadBytes, Math.max(1, limits.maxBytes - bytes));
      readCalls++;
      const response = await command('IO.read', {handle: stream, size: requested}, Math.max(1, Math.min(limits.commandTimeoutMs, Math.ceil(remainingMs))));
      const chunk = rawChunk(response, requested);
      const retained = chunk.subarray(0, Math.max(0, limits.maxBytes - bytes));
      for (let offset = 0; offset < retained.length;) {
        const remainingWriteMs = Math.max(1, Math.ceil(deadline - performance.now()));
        const written = await sinkCall('write', () => sink.write(retained.subarray(offset)), Math.min(limits.sinkTimeoutMs, remainingWriteMs));
        if (!Number.isSafeInteger(written) || written <= 0 || written > retained.length - offset) fail('invalid-sink-write');
        hash.update(retained.subarray(offset, offset + written)); bytes += written; offset += written;
        if (performance.now() > deadline) fail('stream-time-limit');
      }
      if (chunk.length > retained.length) fail('byte-limit');
      eof = response.eof;
      if (chunk.length === 0 && !eof) fail('empty-read-without-eof');
    }
    if (bytes === 0) fail('empty-stream');
  }

  function closeReturnedStream() {
    if (!stream || !startAcknowledged || completionOwnership !== 'acknowledged-own-start') return Promise.resolve();
    if (streamClosePromise) return streamClosePromise;
    streamCloseAttempted = true;
    streamClosePromise = command('IO.close', {handle: stream}).then(
      () => {streamClosed = true;}, error => {captureError(error, 'stream-close-rejected');},
    );
    return streamClosePromise;
  }

  async function finish() {
    if (startPromise) await startPromise;
    else reason('trace-not-started');
    clearTimeout(captureTimer); state = 'stopping';
    if (startAcknowledged) {
      if (!completeEventReceived) {
        endRequested = true;
        try {await command('Tracing.end');} catch (error) {captureError(error, 'trace-end-rejected');}
        try {await bounded(() => completed, limits.completionTimeoutMs, 'trace-completion-timeout');}
        catch (error) {captureError(error, 'trace-completion-failed');}
      }
      // Only an explicit loss-free completion can authorize reading raw JSON.
      // Loss/format failures retain an empty raw file and an incomplete receipt.
      if (completionOwnership === 'acknowledged-own-start' && dataLossOccurred === false && stream && (traceFormat === null || traceFormat === 'json') && (streamCompression === null || streamCompression === 'none')) {
        try {await drain();} catch (error) {captureError(error, 'stream-read-or-write-failed');}
      }
    }
    closingCollection = true;
    await closeReturnedStream();
    detachAttempted = true;
    try {await bounded(() => session.detach(), limits.commandTimeoutMs, 'session-detach-timeout'); detached = true;}
    catch (error) {captureError(error, 'session-detach-failed');}
    if (attached) {
      session.off('Tracing.tracingComplete', complete); session.off('Tracing.dataCollected', dataCollected);
      session.off('Tracing.bufferUsage', bufferUsage); session.off('Disconnected', detachedEvent);
    }
    if (streamClosePromise) await streamClosePromise;
    if (sink) {
      if (!rawMutationUncertain) {
        try {const flushed = await sinkCall('flush', () => sink.flush()); persistedSize = flushed?.size;
          if (!Number.isSafeInteger(persistedSize) || persistedSize !== bytes) reason('persisted-size-mismatch');
        } catch (error) {captureError(error, 'artifact-flush-failed');}
      } else reason('artifact-flush-skipped-unsettled-operation');
      try {await sinkCall('close', () => sink.close(), limits.artifactCleanupTimeoutMs); rawClosed = true;}
      catch (error) {artifactCleanupRequired = true; captureError(error, 'artifact-close-failed');}
    }
    if (!completeEventReceived) reason('missing-completion');
    if (!eof) reason('missing-stream-eof');
    const manifest = {
      kind: 'display-feedback-raw-trace-1', qualification: false, provenanceRequired: true,
      ownership: {...ownership, validation: 'caller-declaration-only'},
      browserVersion,
      protocol: {transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none',
        enableArgumentFilter: false, categories: [...DISPLAY_FEEDBACK_TRACE_CATEGORIES], traceConfig,
        // Browser buffer capacity and retained raw JSON bytes are independent.
        // This protocol request cannot establish a browser/process RSS bound.
        browserBuffer: {requestedKiB: traceConfig.traceBufferSizeInKb, processRssBound: false}},
      limits: {...limits},
      collection: {status: reasons.size === 0 ? 'complete' : 'incomplete', reasons: [...reasons],
        startOutcome, completeEventReceived, completionOwnership, foreignTraceObserved, dataLossOccurred, streamReceived: Boolean(stream),
        returnedTraceFormat: traceFormat, returnedStreamCompression: streamCompression, eof, bytes, readCalls, bufferUsagePeak},
      artifact: {path: artifactPath, exists: Boolean(sink), bytes, persistedSize: rawMutationUncertain ? null : persistedSize, sha256: hash.digest('hex'),
        hashScope: rawMutationUncertain ? 'acknowledged-prefix' : reasons.size === 0 && persistedSize === bytes ? 'completed-file' : 'persisted-prefix',
        hashVerifiedAgainstSize: !rawMutationUncertain && persistedSize === bytes, fileMayChangeAfterReturn: rawMutationUncertain,
        format: 'json', compression: 'none', contentValidation: 'not-performed', rawClosed},
      cleanup: {endRequested, streamCloseAttempted, streamClosed, detachAttempted, detached, browserClosed: false,
        browserCleanupRequired: foreignTraceObserved || unresolvedAdditionalStream || startOutcome === 'unacknowledged-timeout' || (startAcknowledged && !completeEventReceived) || (Boolean(stream) && !streamClosed) || !detached,
        unresolvedAdditionalStream, artifactCleanupRequired, lateOperations: lateOperations.map(value => ({...value}))},
      manifest: {path: `${artifactPath}.manifest.json`, saved: false, sidecar: 'provisional-requires-returned-save-acknowledgement',
        returnedReceiptAuthority: 'requires-owning-producer-receipt'},
    };
    if (sink) {
      // An immutable provisional payload cannot become a false success if its
      // write finishes after our deadline. Only this returned receipt records a
      // timely save acknowledgement; the raw route retains that terminal receipt.
      const provisional = structuredClone(manifest);
      provisional.collection.status = 'incomplete';
      provisional.collection.reasons.push('manifest-save-unacknowledged');
      if (provisional.artifact.hashScope === 'completed-file') provisional.artifact.hashScope = 'persisted-prefix';
      try {await sinkCall('saveManifest', () => sink.saveManifest(provisional)); manifest.manifest.saved = true;}
      catch (error) {
        captureError(error, 'manifest-save-failed');
        manifest.collection.status = 'incomplete';
        if (manifest.artifact.hashScope === 'completed-file') manifest.artifact.hashScope = 'persisted-prefix';
        manifest.collection.reasons = [...reasons];
      }
    }
    manifest.cleanup.artifactCleanupRequired = artifactCleanupRequired;
    manifest.cleanup.lateOperations = lateOperations.map(value => ({...value}));
    state = 'stopped';
    return manifest;
  }
  function stop() {return stopPromise ??= finish();}
  return Object.freeze({start, stop});
}

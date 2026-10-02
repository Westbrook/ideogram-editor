import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {startWindowServerCapture} from './windowserver-process.mjs';
import {bracketWindowServerAction, joinHmrWindowServerPixels} from './windowserver-presentation.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const demand = (condition, message) => {if (!condition) throw Error(message);};
const errorInfo = error => ({name: String(error?.name ?? 'Error').slice(0, 64), message: String(error?.message ?? error).slice(0, 1024)});
const MAX_ORACLE = 8 * 1024 ** 2;

export async function readHmrOrdinaryInput(path, maximum) {
  demand(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_ORACLE, 'Invalid native input read bound');
  demand(isAbsolute(path ?? '') && resolve(path) === path && await realpath(path) === path, 'Native HMR input must be a canonical nonsymlink absolute path');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    demand(before.isFile() && before.size > 0 && before.size <= maximum, 'Native HMR input exceeds its ordinary-file bound');
    // Read at most the admitted size plus one byte, even if an attacker grows
    // the file after fstat. O_NONBLOCK also makes FIFO admission fail promptly.
    const storage = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < storage.length) {
      const read = await handle.read(storage, count, storage.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const bytes = storage.subarray(0, count), after = await handle.stat(), named = await lstat(path);
    demand(bytes.length === before.size && named.isFile() && !named.isSymbolicLink() && ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key] && after[key] === named[key]), 'Native HMR input changed while being read');
    return {bytes, identity: {path, bytes: bytes.length, sha256: hash(bytes)}};
  } finally {await handle.close();}
}

/** This is an explicit instrument selection, not permission or semantic-oracle
 * approval. Its sealed external inputs are retained in the campaign evidence. */
export function nativeHmrConfiguration(value, runtime) {
  if (value === undefined) return null;
  demand(object(value) && value.kind === 'windowserver-hmr-configuration-1' &&
    Object.keys(value).sort().join(',') === 'build,capture,displayID,kind,oracle,roi', 'Unsupported native HMR configuration');
  demand(runtime?.headless === false && integer(runtime.browserPid) && runtime.browserPid > 1 && ['chromium', 'firefox', 'webkit'].includes(runtime.engine), 'Native HMR requires the actual owned headed browser');
  demand(object(value.build) && Object.keys(value.build).sort().join(',') === 'receiptPath,receiptSha256' && isAbsolute(value.build.receiptPath ?? '') && sha(value.build.receiptSha256), 'Native collector build pin is unavailable');
  demand(object(value.oracle) && Object.keys(value.oracle).sort().join(',') === 'path,sha256' && isAbsolute(value.oracle.path ?? '') && sha(value.oracle.sha256), 'Native wordmark oracle pin is unavailable');
  demand(integer(value.displayID) && value.displayID > 0 && value.displayID <= 0xffffffff && object(value.roi) && Object.keys(value.roi).sort().join(',') === 'height,width,x,y' &&
    Object.values(value.roi).every(integer) && value.roi.width > 0 && value.roi.height > 0 && value.roi.width * value.roi.height * 4 <= MAX_ORACLE, 'Invalid bounded native HMR wordmark ROI');
  demand(object(value.capture) && Object.keys(value.capture).sort().join(',') === 'durationMs,maxBytes,maxFrames' && integer(value.capture.durationMs) && value.capture.durationMs >= 1 && value.capture.durationMs <= 75000 &&
    integer(value.capture.maxFrames) && value.capture.maxFrames >= 1 && value.capture.maxFrames <= 5000 && integer(value.capture.maxBytes) && value.capture.maxBytes >= value.roi.width * value.roi.height * 4 && value.capture.maxBytes <= 256 * 1024 ** 2, 'Invalid native capture limits');
  return {selection: structuredClone(value), config: {schemaVersion: 1, displayID: value.displayID, expectedBrowserPid: runtime.browserPid, roi: structuredClone(value.roi), ...value.capture}};
}

export function validateHmrOracle(oracle, pixels, {selection, sourceIdentity}) {
  demand(oracle?.kind === 'hmr-wordmark-oracle-1' && oracle.schemaVersion === 1 && oracle.subject === '.wordmark-secondary' && oracle.pixelFormat === 'BGRA8', 'Native HMR oracle describes another subject');
  demand(isDeepStrictEqual(oracle.roi, selection.roi) && oracle.display?.id === selection.displayID, 'Native HMR oracle geometry differs from selection');
  demand(sourceIdentity?.sourcePath === 'src/ui/shell-wordmark.ts' && oracle.source?.originalSha256 !== oracle.source?.changedSha256 &&
    sourceIdentity.original?.sha256 === 'sha256:' + oracle.source?.originalSha256 && sourceIdentity.changed?.sha256 === 'sha256:' + oracle.source?.changedSha256, 'Native HMR oracle source edit differs');
  demand(pixels instanceof Map && pixels.size === 2, 'Native HMR oracle pixel inventory differs');
  for (const [name, state, text] of [['before.bgra', oracle.before, 'Editor'], ['after.bgra', oracle.after, 'Editor updated']]) {
    const bytes = pixels.get(name);
    demand(state?.text === text && sha(state.sha256) && state.bytes === selection.roi.width * selection.roi.height * 4 && Buffer.isBuffer(bytes) && bytes.length === state.bytes && hash(bytes) === state.sha256, 'Native HMR oracle pixel bytes differ');
  }
  demand(oracle.before.sha256 !== oracle.after.sha256, 'Native HMR oracle contains no visible change');
  return true;
}

/** The native source path comes from the executing tool, never a configurable
 * arbitrary binary identity. No compiler, permission prompt or capture starts
 * until an explicit native selection has passed these prerequisites. */
export async function prepareHmrWindowServer({configuration, runtime, sourceIdentity, output, signal}) {
  const selected = nativeHmrConfiguration(configuration?.windowServerPresentation, runtime);
  if (!selected) return null;
  signal?.throwIfAborted();
  const {selection, config} = selected;
  sourceIdentity = structuredClone(sourceIdentity);
  runtime = structuredClone(runtime);
  const source = await readHmrOrdinaryInput(fileURLToPath(new URL('../native/windowserver-capture.swift', import.meta.url)), 1024 * 1024);
  const oracleFile = await readHmrOrdinaryInput(selection.oracle.path, 65536);
  demand(oracleFile.identity.sha256 === selection.oracle.sha256, 'Native HMR oracle manifest pin differs');
  const oracle = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(oracleFile.bytes));
  const pixels = new Map(), pixelIdentities = [];
  for (const name of ['before.bgra', 'after.bgra']) {
    const item = await readHmrOrdinaryInput(join(dirname(selection.oracle.path), name), MAX_ORACLE);
    pixels.set(name, item.bytes); pixelIdentities.push({...item.identity, path: name});
  }
  validateHmrOracle(oracle, pixels, {selection, sourceIdentity});
  const retained = join(output, 'native-wordmark-oracle');
  await mkdir(retained, {mode: 0o700});
  await writeFile(join(retained, 'oracle.json'), oracleFile.bytes, {flag: 'wx', mode: 0o600});
  for (const [name, bytes] of pixels) await writeFile(join(retained, name), bytes, {flag: 'wx', mode: 0o600});
  const binding = {kind: 'hmr-windowserver-input-binding-1', sourceIdentity: structuredClone(sourceIdentity),
    collectorSource: structuredClone(source.identity), build: structuredClone(selection.build), oracle: {path: join(retained, 'oracle.json'), bytes: oracleFile.bytes.length, sha256: oracleFile.identity.sha256, pixels: pixelIdentities},
    browser: {pid: runtime.browserPid, engine: runtime.engine, version: runtime.version, revision: runtime.revision, executable: runtime.executable, executableIdentity: runtime.executableIdentity,
      browserCache: runtime.browserCache, sourceRoot: runtime.sourceRoot, fixtureSeal: runtime.fixtureSeal, viewport: runtime.viewport, deviceScaleFactor: runtime.deviceScaleFactor}, config: structuredClone(config),
    semanticOracleReview: 'external-exact-pinned-oracle-required', historicalWindowOcclusion: 'adjacent-native-window-observations-not-atomic-at-frame-time'};
  await writeFile(join(retained, 'binding.json'), JSON.stringify(binding, null, 2) + '\n', {flag: 'wx', mode: 0o600});

  return {
    get binding() {return structuredClone(binding);},
    async begin(id) {
      demand(typeof id === 'string' && /^[A-Za-z0-9_-]{1,56}$/.test(id), 'Invalid native HMR transaction identity');
      signal?.throwIfAborted();
      let capture, baseline, failedProcess;
      const missing = [], failures = [];
      try {
        capture = await startWindowServerCapture({build: {...selection.build, sourceSha256: source.identity.sha256}, config,
          directory: join(output, 'native-' + id), processRecordDirectory: output, abortSignal: signal, readyTimeoutMs: 15000, clockTimeoutMs: 3000, stopTimeoutMs: 7000});
        baseline = await capture.waitForPixelHash(oracle.before.sha256, {timeoutMs: 3000});
      } catch (error) {
        failedProcess = error?.windowServerProcess ?? null;
        missing.push('native-baseline-capture-unavailable'); failures.push(errorInfo(error));
        if (signal?.aborted) await drainHmrCancellation(capture, signal);
      }
      return createHmrWindowServerTransaction({id, capture, baseline, failedProcess, missing, failures, signal,
        oracle, oracleBytes: oracleFile.bytes, pixels, oracleSha256: selection.oracle.sha256, sourceIdentity, binding});
    },
  };
}

/** Lifecycle protocol only. A supplied capture is not evidence authority: the
 * final pixel join still requires the verifier's private replay token. This
 * separation permits bounded control tests without native process execution. */
export function createHmrWindowServerTransaction(context) {
  const {id, capture, baseline, signal, oracle, oracleBytes, pixels, oracleSha256} = context;
  const sourceIdentity = structuredClone(context.sourceIdentity), binding = structuredClone(context.binding);
  let failedProcess = context.failedProcess ?? null, bracket, target, stopped;
  const missing = [...(context.missing ?? [])], failures = [...(context.failures ?? [])];
  let saveStarted = false, saveCompleted = false, observing = false, observed = false, closed = false, finished;
  return {
    async save(run) {
      demand(!closed && !saveStarted && typeof run === 'function', 'Native HMR save is single-use and requires an open transaction');
      saveStarted = true; // Set before awaiting: concurrent saves cannot dispatch.
      const value = await bracketWindowServerAction({actionId: id, run, captureClock: clockId => {
        if (!capture || !baseline) throw Error('Native baseline capture is unavailable');
        return capture.captureClock(clockId);
      }});
      bracket = structuredClone(value.bracket);
      saveCompleted = true;
      return {...value.value, nativePresentationBracket: structuredClone(bracket)};
    },
    async observeUpdated(saved) {
      demand(!closed && saveCompleted && !observing && !observed, 'Native HMR target observation requires one completed save');
      // Never accept an externally replaced bracket from the returned save data.
      demand(isDeepStrictEqual(saved?.nativePresentationBracket, bracket), 'Native HMR save bracket was replaced');
      observing = true;
      try {
        if (!capture || !baseline || bracket?.status !== 'complete') {missing.push('native-save-clock-or-baseline-unavailable'); return;}
        try {target = await capture.waitForPixelHash(oracle.after.sha256, {timeoutMs: 3000, minimumDisplayTimeMach: bracket.after.mach});}
        catch (error) {signal?.throwIfAborted(); missing.push('native-updated-pixels-unavailable'); failures.push(errorInfo(error));}
      } finally {observing = false; observed = true;}
    },
    finish() {
      if (finished) return finished.then(value => structuredClone(value));
      closed = true; // Closure is idempotent and synchronously prevents dispatch.
      finished = (async () => {
        try {if (capture) stopped = await capture.stop();}
        catch (error) {failedProcess = error?.windowServerProcess ?? failedProcess; missing.push('native-capture-closure-unavailable'); failures.push(errorInfo(error));}
        let joined = null;
        if (stopped?.capture && bracket?.status === 'complete' && baseline && target) {
          try {joined = joinHmrWindowServerPixels(stopped.capture, {oracleBytes, oraclePixels: pixels, oracleSha256, sourceIdentity, bracket});}
          catch (error) {missing.push('native-pixel-join-unavailable'); failures.push(errorInfo(error));}
        }
        return {kind: 'hmr-windowserver-observation-1', actionId: id, qualification: false, binding: structuredClone(binding),
          ready: capture?.ready ?? null, processIdentity: capture?.processIdentity ?? null, bracket: bracket ?? null,
          baseline: baseline?.sample ?? null, target: target?.sample ?? null, join: joined,
          evidence: stopped ? {manifest: stopped.manifest, process: stopped.process} : null, failedProcess,
          missing: [...new Set(missing)], failures};
      })();
      return finished.then(value => structuredClone(value));
    },
  };
}

/** Operational continuation check only. Serialized observations cannot qualify
 * a ceiling: the campaign verifier separately replays their sealed raw inputs. */
export function hmrWindowServerCeilingObserved(value) {
  const joined = value?.join;
  return value?.kind === 'hmr-windowserver-observation-1' && value.qualification === false &&
    Array.isArray(value.missing) && value.missing.length === 0 && Array.isArray(value.failures) && value.failures.length === 0 &&
    value.evidence?.manifest != null && value.evidence?.process != null && value.failedProcess == null &&
    joined?.kind === 'hmr-windowserver-pixel-join-1' && joined.status === 'observed' &&
    joined.endpoint === 'WindowServer-presented-pixels' && joined.ceilingAssessment === 'upper-bound-within-ceiling' && joined.ceilingMs === 500 &&
    Number.isFinite(joined.firstCorrectPaintUpperBoundMs) && joined.firstCorrectPaintUpperBoundMs >= 0 && joined.firstCorrectPaintUpperBoundMs <= 500 &&
    joined.firstCorrectPaintExactMs === null && joined.firstCorrectPaintLowerBoundMs === null &&
    joined.physicalScanout === 'unavailable' && joined.displaySlotCoverage === 'unavailable' && joined.qualification === false;
}

/** Cancellation must retain both the initiating reason and failed owned-group
 * cleanup, including the supervisor's process evidence when available. */
export async function drainHmrCancellation(capture, signal) {
  demand(signal?.aborted === true, 'Native HMR cancellation drain requires an aborted signal');
  try {await capture?.stop();}
  catch (error) {
    const failure = new AggregateError([signal.reason, error], 'Native HMR cancellation cleanup failed', {cause: signal.reason});
    failure.windowServerProcess = error?.windowServerProcess ?? null;
    throw failure;
  }
  signal.throwIfAborted();
}

import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {discreteInputDescriptor} from './browser-discrete-input.mjs';
import {startWindowServerCapture, validateWindowServerConfig} from './windowserver-process.mjs';
import {bracketWindowServerAction, firstUseNativeActionId, joinFirstUseWindowServerPixels} from './windowserver-presentation.mjs';
import {monotonic} from './common.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const MAX_ORACLE = 8 * 1024 ** 2;
const errorInfo = error => ({name: String(error?.name ?? 'Error').slice(0, 64), message: String(error?.message ?? error).slice(0, 1024)});
const rawSha = value => typeof value === 'string' ? value.replace(/^sha256:/, '') : null;
function keys(value, expected, label) {demand(object(value), 'Invalid ' + label); same(Object.keys(value).sort(), [...expected].sort(), 'Unsupported ' + label + ' fields');}
const nativeClock = (value, id) => value?.schemaVersion === 1 && value.event === 'clock' && value.id === id &&
  typeof value.mach === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value.mach) && BigInt(value.mach) <= 18446744073709551615n;

/** Causal lower anchor, not an exact window-start timestamp. The owned browser
 * calls its unchanged first-use action only after preparation returns. */
export async function captureFirstUseWindowAnchor(capture, requested) {
  const descriptor = discreteInputDescriptor(requested), nativeActionId = firstUseNativeActionId(descriptor);
  const ack = await capture.captureClock(nativeActionId + '-win-before');
  demand(nativeClock(ack, nativeActionId + '-win-before'), 'First-use window anchor ACK differs');
  return {kind: 'first-use-native-window-anchor-1', status: 'complete', descriptor, nativeActionId,
    relation: 'ack-before-driver-window-start', ack: structuredClone(ack)};
}

/** Stable rendering/fixture binding; fresh process IDs belong to invocation
 * admission, not an independently reviewed oracle made before that launch. */
export function firstUseEnvironmentBinding(runtime) {
  demand(runtime?.headless === false && Number.isSafeInteger(runtime.browserPid) && runtime.browserPid > 1 &&
    ['chromium', 'firefox', 'webkit'].includes(runtime.engine), 'First-use native capture requires the owned headed browser');
  const executableSha256 = rawSha(runtime.executableIdentity?.sha256), fixtureSha256 = rawSha(runtime.fixtureSeal?.sha256);
  demand(sha(executableSha256) && sha(fixtureSha256) && typeof runtime.version === 'string' && runtime.version.length > 0 &&
    typeof runtime.revision === 'string' && runtime.revision.length > 0, 'First-use runtime or fixture pins unavailable');
  demand(Number.isSafeInteger(runtime.viewport?.width) && runtime.viewport.width > 0 && Number.isSafeInteger(runtime.viewport?.height) && runtime.viewport.height > 0 &&
    Number.isFinite(runtime.deviceScaleFactor) && runtime.deviceScaleFactor > 0, 'First-use viewport identity unavailable');
  const environment = {engine: runtime.engine, version: runtime.version, revision: runtime.revision, executableSha256,
    viewport: {width: runtime.viewport.width, height: runtime.viewport.height}, deviceScaleFactor: runtime.deviceScaleFactor};
  return {fixtureSha256, browserEnvironmentSha256: hash(JSON.stringify(environment)), environment};
}

export function nativeFirstUseConfiguration(value, runtime) {
  if (value === undefined) return null;
  keys(value, ['kind', 'build', 'oracle', 'displayID', 'roi', 'capture'], 'first-use native selection');
  demand(value.kind === 'windowserver-first-use-configuration-1', 'Unsupported first-use native selection');
  const environment = firstUseEnvironmentBinding(runtime);
  keys(value.build, ['receiptPath', 'receiptSha256'], 'native build pin');
  keys(value.oracle, ['path', 'sha256'], 'native first-use oracle pin');
  demand(isAbsolute(value.build.receiptPath ?? '') && sha(value.build.receiptSha256) && isAbsolute(value.oracle.path ?? '') && sha(value.oracle.sha256), 'First-use build/oracle pins unavailable');
  keys(value.capture, ['durationMs', 'maxFrames', 'maxBytes'], 'native capture limits');
  const config = validateWindowServerConfig({schemaVersion: 1, displayID: value.displayID, expectedBrowserPid: runtime.browserPid, roi: value.roi, ...value.capture});
  demand(config.durationMs >= 1000 && config.roi.width * config.roi.height * 4 <= MAX_ORACLE, 'First-use selection cannot contain its bounded ROI/window');
  return {selection: structuredClone(value), config, environment};
}

export async function readFirstUseOrdinaryInput(path, maximum) {
  demand(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_ORACLE, 'Invalid first-use native input bound');
  demand(isAbsolute(path ?? '') && resolve(path) === path && await realpath(path) === path, 'First-use native input must be a canonical nonsymlink absolute file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); demand(before.isFile() && before.size > 0 && before.size <= maximum, 'First-use native input exceeds its ordinary-file bound');
    const storage = Buffer.alloc(before.size + 1); let count = 0;
    while (count < storage.length) {const read = await handle.read(storage, count, storage.length - count, count); if (!read.bytesRead) break; count += read.bytesRead;}
    const bytes = storage.subarray(0, count), after = await handle.stat(), named = await lstat(path);
    demand(bytes.length === before.size && named.isFile() && !named.isSymbolicLink() && ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key] && after[key] === named[key]), 'First-use native input changed during read');
    return {bytes, identity: {path, bytes: bytes.length, sha256: hash(bytes)}};
  } finally {await handle.close();}
}

export function validateFirstUseOracle(oracle, pixels, {feature, selection, environment}) {
  demand(['Mask', 'Adapter library'].includes(feature) && oracle?.kind === 'first-use-panel-oracle-1' && oracle.schemaVersion === 1 && oracle.feature === feature &&
    oracle.subject === (feature === 'Mask' ? 'mask-controls-panel' : 'local-adapter-library-panel') && oracle.pixelFormat === 'BGRA8', 'First-use oracle names another feature or subject');
  same(oracle.binding, {fixtureSha256: environment.fixtureSha256, browserEnvironmentSha256: environment.browserEnvironmentSha256}, 'First-use oracle fixture/browser environment differs');
  same(oracle.roi, selection.roi, 'First-use oracle ROI differs'); demand(oracle.display?.id === selection.displayID, 'First-use oracle display differs');
  demand(pixels instanceof Map && pixels.size === 2, 'First-use oracle pixel inventory differs');
  for (const [name, state, expected] of [['before.bgra', oracle.before, 'closed'], ['after.bgra', oracle.after, 'open']]) {
    const bytes = pixels.get(name);
    demand(state?.state === expected && sha(state.sha256) && state.bytes === selection.roi.width * selection.roi.height * 4 &&
      Buffer.isBuffer(bytes) && bytes.length === state.bytes && hash(bytes) === state.sha256, 'First-use oracle state or pixel bytes differ');
  }
  demand(oracle.before.sha256 !== oracle.after.sha256, 'First-use oracle contains no visible change');
  return true;
}

/** Explicit opt-in only; does not compile, grant capture permission, generate
 * oracle pixels, alter product state, or claim semantic review occurred. */
export async function prepareFirstUseWindowServer({configuration, runtime, feature, sessionId, output, signal}) {
  const selected = nativeFirstUseConfiguration(configuration, runtime);
  if (!selected) return null;
  signal?.throwIfAborted();
  demand(isAbsolute(output ?? '') && resolve(output) === output && await realpath(output) === output, 'First-use output must be a canonical owned directory');
  const outputInfo = await lstat(output);
  demand(outputInfo.isDirectory() && !outputInfo.isSymbolicLink() && typeof process.getuid === 'function' && outputInfo.uid === process.getuid() &&
    (outputInfo.mode & 0o777) === 0o700, 'First-use output must be a private owned directory');
  const {selection, config, environment} = selected;
  const descriptor = discreteInputDescriptor({sessionId, actionId: 'first-use', stepId: 'open-panel', family: 'first-use',
    target: {control: feature === 'Mask' ? 'mask-tool' : 'adapter-library'}, input: {kind: 'click'}});
  const source = await readFirstUseOrdinaryInput(fileURLToPath(new URL('../native/windowserver-capture.swift', import.meta.url)), 1024 * 1024);
  const oracleFile = await readFirstUseOrdinaryInput(selection.oracle.path, 65536);
  demand(oracleFile.identity.sha256 === selection.oracle.sha256, 'First-use oracle manifest pin differs');
  const oracle = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(oracleFile.bytes)), pixels = new Map(), pixelIdentities = [];
  for (const name of ['before.bgra', 'after.bgra']) {
    const item = await readFirstUseOrdinaryInput(join(dirname(selection.oracle.path), name), MAX_ORACLE);
    pixels.set(name, item.bytes); pixelIdentities.push({...item.identity, path: name});
  }
  validateFirstUseOracle(oracle, pixels, {feature, selection, environment});
  const nativeActionId = firstUseNativeActionId(descriptor), directory = join(output, 'native-' + nativeActionId), retained = join(output, 'oracle-' + nativeActionId);
  await mkdir(retained, {mode: 0o700});
  await writeFile(join(retained, 'oracle.json'), oracleFile.bytes, {flag: 'wx', mode: 0o600});
  for (const [name, bytes] of pixels) await writeFile(join(retained, name), bytes, {flag: 'wx', mode: 0o600});
  const binding = {kind: 'first-use-windowserver-input-binding-1', feature, descriptor, nativeActionId,
    collectorSource: source.identity, build: selection.build,
    oracle: {path: join(retained, 'oracle.json'), bytes: oracleFile.bytes.length, sha256: oracleFile.identity.sha256, pixels: pixelIdentities},
    browser: structuredClone(runtime), environment, config,
    semanticOracleReview: 'external-exact-pinned-oracle-required', historicalWindowOcclusion: 'adjacent-native-window-observations-not-atomic-at-frame-time'};
  await writeFile(join(retained, 'binding.json'), JSON.stringify(binding, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  const currentOutput = await lstat(output);
  demand(currentOutput.isDirectory() && currentOutput.dev === outputInfo.dev && currentOutput.ino === outputInfo.ino && await realpath(output) === output,
    'First-use output identity changed during retention');
  let capture, baseline, failedProcess;
  let windowStartAnchor = {kind: 'first-use-native-window-anchor-1', status: 'unavailable', descriptor, nativeActionId,
    relation: 'ack-before-driver-window-start', ack: null};
  const missing = [], failures = [];
  try {
    capture = await startWindowServerCapture({build: {...selection.build, sourceSha256: source.identity.sha256}, config, directory,
      processRecordDirectory: output, abortSignal: signal, readyTimeoutMs: 15000, clockTimeoutMs: 3000, stopTimeoutMs: 7000});
    same(capture.ready.display, oracle.display, 'First-use oracle native display geometry differs');
    baseline = await capture.waitForPixelHash(oracle.before.sha256, {timeoutMs: 3000});
    windowStartAnchor = await captureFirstUseWindowAnchor(capture, descriptor);
  } catch (error) {
    failedProcess = error?.windowServerProcess ?? null;
    missing.push('native-first-use-baseline-unavailable'); failures.push(errorInfo(error));
    if (signal?.aborted) {try {await capture?.stop();} catch {} signal.throwIfAborted();}
  }
  if (windowStartAnchor.status !== 'complete') missing.push('native-first-use-window-anchor-unavailable');
  return createFirstUseWindowServerTransaction({capture, baseline, windowStartAnchor, failedProcess, missing, failures, descriptor, binding,
    feature, oracleBytes: oracleFile.bytes, oraclePixels: pixels, oracleSha256: oracleFile.identity.sha256});
}

/** Tests may supply protocol doubles, but only the raw-byte replay verifier can
 * authorize a pixel join. This lifecycle object produces no evaluator proof. */
export function createFirstUseWindowServerTransaction(context) {
  const descriptor = discreteInputDescriptor(context.descriptor), binding = structuredClone(context.binding), feature = context.feature;
  const nativeActionId = firstUseNativeActionId(descriptor), capture = context.capture;
  const windowStartAnchor = context.windowStartAnchor ? structuredClone(context.windowStartAnchor) : null;
  let used = false, hookCompleted = false, readyUsed = false, closed = false, bracket = null, inputEvidence = null, readinessWitness = null, finished;
  const missing = [...(context.missing ?? [])], failures = [...(context.failures ?? [])];
  let failedProcess = context.failedProcess ?? null;
  return {
    async hook({descriptor: supplied, run}) {
      demand(!used && !closed && typeof run === 'function', 'First-use native dispatch hook is single-use');
      same(supplied, descriptor, 'First-use native hook descriptor differs'); used = true;
      const observed = await bracketWindowServerAction({actionId: nativeActionId, run, captureClock: clockId => {
        if (!capture || !context.baseline) throw Error('First-use native baseline unavailable');
        return capture.captureClock(clockId);
      }});
      bracket = structuredClone(observed.bracket); inputEvidence = observed.value.inputEvidence;
      hookCompleted = true;
      return observed;
    },
    async ready(value) {
      demand(!closed && hookCompleted && !readyUsed, 'First-use native ready witness requires one completed input and one ready call');
      keys(value, ['descriptor', 'readyMs', 'startMs', 'endMs', 'clock'], 'public first-use readiness');
      same(value.descriptor, descriptor, 'First-use native ready descriptor differs');
      demand(value.clock === 'runner-monotonic' && Number.isFinite(value.startMs) && value.startMs >= 0 && Number.isFinite(value.readyMs) &&
        value.readyMs >= value.startMs && value.endMs === value.startMs + 1000, 'First-use ready caller clock/window differs');
      readyUsed = true;
      const requestRunnerMs = monotonic();
      const witness = {kind: 'first-use-native-ready-1', status: 'unavailable', descriptor, nativeActionId,
        callerReadyMs: value.readyMs, windowStartMs: value.startMs, windowEndMs: value.endMs, requestRunnerMs,
        receivedRunnerMs: null, clock: 'runner-monotonic', ack: null};
      try {
        demand(requestRunnerMs >= value.readyMs, 'First-use native ready request precedes public readiness');
        demand(capture && context.baseline && bracket?.status === 'complete', 'First-use native input bracket unavailable for readiness');
        const ack = await capture.captureClock(nativeActionId + '-ready'), receivedRunnerMs = monotonic();
        demand(nativeClock(ack, nativeActionId + '-ready') &&
          BigInt(ack.mach) >= BigInt(bracket.after.mach) && receivedRunnerMs >= requestRunnerMs, 'First-use native ready ACK differs or reversed');
        readinessWitness = {...witness, status: 'complete', receivedRunnerMs, ack: structuredClone(ack)};
      } catch (error) {
        readinessWitness = {...witness, reason: 'native-ready-ack-unavailable'};
        missing.push('native-first-use-ready-ack-unavailable'); failures.push(errorInfo(error));
      }
      return structuredClone(readinessWitness);
    },
    finish({result, actionCompleted} = {}) {
      if (finished) return finished.then(value => structuredClone(value));
      closed = true;
      finished = (async () => {
        let stopped, joined = null;
        try {if (capture) stopped = await capture.stop();}
        catch (error) {failedProcess = error?.windowServerProcess ?? failedProcess; missing.push('native-first-use-capture-closure-unavailable'); failures.push(errorInfo(error));}
        const observations = result?.observations ?? result;
        const steps = observations?.discreteInput?.steps;
        const publicCompleted = actionCompleted === true && observations?.feature === feature && observations.meaningful === true &&
          observations.observationWindowMs === 1000 && observations.windowClock === 'runner-monotonic' && observations.readyClock === 'runner-monotonic' &&
          Number.isFinite(observations.startMs) && Number.isFinite(observations.readyMs) && observations.readyMs >= observations.startMs &&
          observations.endMs === observations.startMs + 1000 && Number.isFinite(observations.captureStoppedMs) && observations.captureStoppedMs >= observations.endMs;
        const inputBound = Array.isArray(steps) && steps.length === 1 && steps[0].dispatchCompleted === true && isDeepStrictEqual(steps[0].inputEvidence, inputEvidence) &&
          isDeepStrictEqual(steps[0].nativeBracket, bracket) && inputEvidence?.status === 'PASS';
        if (!publicCompleted) missing.push('public-first-use-completion-unavailable');
        if (!inputBound) missing.push('first-use-browser-input-binding-unavailable');
        const anchorBound = windowStartAnchor?.kind === 'first-use-native-window-anchor-1' && windowStartAnchor.status === 'complete' &&
          windowStartAnchor.relation === 'ack-before-driver-window-start' && isDeepStrictEqual(windowStartAnchor.descriptor, descriptor) &&
          windowStartAnchor.nativeActionId === nativeActionId && nativeClock(windowStartAnchor.ack, nativeActionId + '-win-before') &&
          bracket?.status === 'complete' && BigInt(windowStartAnchor.ack.mach) <= BigInt(bracket.before.mach);
        if (!anchorBound) missing.push('native-first-use-window-anchor-binding-unavailable');
        const readyBound = readinessWitness?.status === 'complete' && isDeepStrictEqual(observations?.nativeReadiness, readinessWitness) &&
          readinessWitness.callerReadyMs === observations?.readyMs && readinessWitness.windowStartMs === observations?.startMs && readinessWitness.windowEndMs === observations?.endMs;
        if (!readyBound) missing.push('native-first-use-readiness-binding-unavailable');
        if (stopped?.capture && bracket?.status === 'complete' && context.baseline && publicCompleted && inputBound) {
          try {joined = joinFirstUseWindowServerPixels(stopped.capture, {oracleBytes: context.oracleBytes, oraclePixels: context.oraclePixels, oracleSha256: context.oracleSha256,
            feature, expectedDescriptor: descriptor, inputEvidence, bracket,
            binding: {fixtureSha256: binding.environment.fixtureSha256, browserEnvironmentSha256: binding.environment.browserEnvironmentSha256,
              browserPid: binding.browser.browserPid, windowNumber: capture.ready.windowAdmission.windowNumber}});}
          catch (error) {missing.push('native-first-use-pixel-join-unavailable'); failures.push(errorInfo(error));}
        } else missing.push('native-first-use-join-prerequisites-unavailable');
        if (joined?.status === 'unavailable') missing.push('native-first-use-' + joined.reason);
        return {kind: 'first-use-windowserver-observation-1', feature, descriptor, nativeActionId, qualification: false, binding,
          ready: capture?.ready ?? null, processIdentity: capture?.processIdentity ?? null, baseline: context.baseline?.sample ?? null,
          bracket, inputEvidence, windowStartAnchor, readinessWitness, readinessBindingMatched: readyBound, join: joined,
          publicWitness: {kind: 'public-first-use-ready-1', completed: publicCompleted, feature, startMs: observations?.startMs ?? null,
            readyMs: observations?.readyMs ?? null, endMs: observations?.endMs ?? null, captureStoppedMs: observations?.captureStoppedMs ?? null,
            observationWindowMs: observations?.observationWindowMs ?? null, clock: 'runner-monotonic'},
          evidence: stopped ? {manifest: stopped.manifest, process: stopped.process} : null, failedProcess,
          missing: [...new Set(missing)], failures};
      })();
      return finished.then(value => structuredClone(value));
    },
  };
}

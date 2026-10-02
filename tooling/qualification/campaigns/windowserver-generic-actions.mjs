import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {firstUseEnvironmentBinding} from './windowserver-first-use.mjs';
import {startSessionWindowServerCapture} from './windowserver-session-process.mjs';
import {inspectSessionEvidenceBudget} from './windowserver-session-budget.mjs';
import {getWindowServerSessionObservations} from './windowserver-session.mjs';
import {startSessionWindowServerLosslessCapture} from './windowserver-session-lossless-process.mjs';
import {inspectSessionLosslessEvidenceBudget} from './windowserver-session-lossless-budget.mjs';
import {getWindowServerSessionLosslessObservations} from './windowserver-session-lossless.mjs';
import {GENERIC_PROFILE, genericInteractionInventory, genericNativeActionId, genericSessionNativeId, projectGenericInteraction} from './browser-generic-input.mjs';
import {joinGenericActionPixels, joinGenericActionLosslessPixels} from './generic-action-oracle.mjs';
import {validatePackedGenericOracle, replayPackedGenericOracle} from './generic-oracle-lossless.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const demand = (value, message) => {if (!value) throw Error(message);};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const info = error => ({name: String(error?.name ?? 'Error').slice(0, 64), message: String(error?.message ?? error).slice(0, 1024)});
const MAX_MANIFEST = 16 * 1024 ** 2, MAX_PIXEL = 256 * 1024 ** 2;
const keys = (value, expected, name) => {demand(object(value), 'Invalid ' + name); same(Object.keys(value).sort(), [...expected].sort(), 'Unsupported ' + name + ' fields');};
const ticks = value => {demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'Invalid native clock'); const n = BigInt(value); demand(n <= 18446744073709551615n, 'Native clock overflow'); return n;};

async function ownedDirectory(path) {
  demand(isAbsolute(path ?? '') && resolve(path) === path && await realpath(path) === path, 'Generic output must be canonical');
  const stat = await lstat(path);
  demand(stat.isDirectory() && !stat.isSymbolicLink() && typeof process.getuid === 'function' && stat.uid === process.getuid() &&
    (stat.mode & 0o777) === 0o700, 'Generic output must be a private owned directory');
  return stat;
}

/** Retain one independently supplied ordinary file with bounded memory. Pixel
 * bytes are never collected into a whole-session Map. */
async function ordinary(path, maximum, destination, allowEmpty = false, signal) {
  signal?.throwIfAborted();
  demand(isAbsolute(path ?? '') && resolve(path) === path && await realpath(path) === path, 'Generic input must be a canonical ordinary file');
  signal?.throwIfAborted();
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const before = await input.stat(); demand(before.isFile() && (allowEmpty || before.size > 0) && before.size <= maximum, 'Generic input exceeds ordinary-file bound');
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const digest = createHash('sha256'), chunk = Buffer.alloc(Math.min(1024 ** 2, before.size)), chunks = destination ? null : [];
    let position = 0;
    while (position < before.size) {
      signal?.throwIfAborted();
      const {bytesRead} = await input.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      signal?.throwIfAborted();
      demand(bytesRead > 0, 'Generic input truncated during read'); const bytes = chunk.subarray(0, bytesRead);
      digest.update(bytes); if (chunks) chunks.push(Buffer.from(bytes));
      if (output) {let offset = 0; while (offset < bytesRead) {signal?.throwIfAborted(); const written = await output.write(bytes, offset, bytesRead - offset, position + offset); demand(written.bytesWritten > 0, 'Generic input retention stalled'); offset += written.bytesWritten;}}
      position += bytesRead;
    }
    const after = await input.stat(), named = await lstat(path);
    demand(named.isFile() && !named.isSymbolicLink() && ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key] && after[key] === named[key]), 'Generic input changed during retention');
    signal?.throwIfAborted();
    if (output) await output.sync();
    signal?.throwIfAborted();
    return {bytes: chunks ? Buffer.concat(chunks) : null, identity: {path: destination ?? path, bytes: position, sha256: digest.digest('hex')}};
  } finally {await output?.close(); await input.close();}
}

export function genericNativeConfiguration(value, runtime) {
  const lossless = value?.kind === 'windowserver-generic-actions-configuration-2';
  keys(value, ['kind', 'build', 'oracle', 'displayID', 'roi', 'evidenceAllocation', 'evidenceReservation', ...(lossless ? ['storageFormat'] : [])], 'generic native selection');
  demand(lossless || value.kind === 'windowserver-generic-actions-configuration-1', 'Unsupported generic native selection');
  if (lossless) demand(value.storageFormat === 'rfc1951-previous-roi-1' && Number.isSafeInteger(value.evidenceReservation?.nativeArtifactBytes) &&
    value.evidenceReservation.nativeArtifactBytes > 0, 'Explicit lossless format and native artifact allowance required');
  const environment = firstUseEnvironmentBinding(runtime);
  keys(value.build, ['receiptPath', 'receiptSha256'], 'generic build pin'); keys(value.oracle, ['path', 'sha256', ...(lossless ? ['storage'] : [])], 'generic oracle pin');
  demand(isAbsolute(value.build.receiptPath ?? '') && sha(value.build.receiptSha256) && isAbsolute(value.oracle.path ?? '') && sha(value.oracle.sha256), 'Generic source/oracle pins missing');
  if (lossless) {
    keys(value.oracle.storage, ['kind', 'index', 'container', 'review'], 'packed independent oracle selection');
    demand(value.oracle.storage.kind === 'rfc1951-oracle-pixels-1', 'Explicit packed independent oracle format required');
    for (const name of ['index', 'container', 'review']) {
      const pin = value.oracle.storage[name]; keys(pin, ['path', 'bytes', 'sha256'], 'packed oracle ' + name + ' pin');
      demand(isAbsolute(pin.path ?? '') && sha(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes >= (name === 'container' ? 0 : 1) &&
        (name !== 'index' || pin.bytes <= 4 * 1024 ** 2) && (name !== 'review' || pin.bytes <= 65536), 'Invalid packed oracle input bound');
    }
  }
  demand(Number.isSafeInteger(value.displayID) && value.displayID > 0, 'Generic display identity missing');
  keys(value.roi, ['x', 'y', 'width', 'height'], 'generic ROI');
  demand(Object.values(value.roi).every(n => Number.isSafeInteger(n) && n >= 0) && value.roi.width > 0 && value.roi.height > 0 &&
    value.roi.width * value.roi.height * 4 <= MAX_PIXEL, 'Generic ROI is invalid');
  return {selection: structuredClone(value), environment, config: {schemaVersion: lossless ? 3 : 2, profile: GENERIC_PROFILE,
    ...(lossless ? {storageFormat: 'rfc1951-previous-roi-1'} : {}),
    displayID: value.displayID, expectedBrowserPid: runtime.browserPid, roi: structuredClone(value.roi)}};
}

/** Exact finite manifest census before storage is reserved. No supplied hash
 * is accepted as pixel evidence until ordinary() hashes its actual bytes. */
export function genericOracleInventory(oracle, {selection, environment}) {
  demand(oracle?.kind === 'generic-action-pixel-oracle-1' && oracle.schemaVersion === 1 && oracle.profile === GENERIC_PROFILE &&
    oracle.pixelFormat === 'BGRA8' && Array.isArray(oracle.actions) && oracle.actions.length === 100, 'Generic oracle does not cover the original inventory');
  same(oracle.binding, {fixtureSha256: environment.fixtureSha256, browserEnvironmentSha256: environment.browserEnvironmentSha256}, 'Generic oracle fixture/environment differs');
  same(oracle.roi, selection.roi, 'Generic oracle ROI differs'); demand(oracle.display?.id === selection.displayID, 'Generic oracle display differs');
  const files = new Map(), directories = new Set(['.']), inventory = genericInteractionInventory();
  const retainPixel = file => {
    keys(file, ['path', 'sha256', 'bytes'], 'generic oracle pixel');
    demand(typeof file.path === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]*\.bgra$/.test(file.path) && file.path.length <= 240 &&
      !file.path.split('/').some(part => !part || part === '.' || part === '..') && sha(file.sha256) && file.bytes === selection.roi.width * selection.roi.height * 4,
      'Generic oracle pixel path or extent differs');
    if (files.has(file.path)) same(files.get(file.path), file, 'Generic oracle path has conflicting pins'); else files.set(file.path, structuredClone(file));
    for (let dir = dirname(file.path); dir !== '.'; dir = dirname(dir)) directories.add(dir);
  };
  for (const [sequence, action] of oracle.actions.entries()) {
    const expected = inventory[sequence];
    demand(action.sequence === sequence && action.family === expected.kind && sha(action.stateSha256) && Array.isArray(action.endpoints) &&
      action.endpoints.length === (expected.kind === 'stroke' ? 120 : 1), 'Generic oracle action/state inventory differs');
    for (const [ordinal, endpoint] of action.endpoints.entries()) {
      demand(endpoint.ordinal === ordinal && endpoint.subject === (expected.kind === 'stroke' ? 'mask-stroke-prefix' : expected.kind + '-complete-action') &&
        ['pixels', 'unavailable'].includes(endpoint.kind), 'Generic oracle endpoint differs');
      if (endpoint.kind === 'unavailable') {demand(typeof endpoint.reason === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(endpoint.reason), 'Unavailable generic endpoint needs reason'); continue;}
      for (const file of [endpoint.before, endpoint.after]) retainPixel(file);
    }
    if (expected.kind === 'stroke') {
      const ack = action.acknowledgement;
      demand(['pixels', 'unavailable'].includes(ack?.kind), 'Stroke acknowledgement oracle is required or explicitly unavailable');
      if (ack.kind === 'unavailable') demand(typeof ack.reason === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ack.reason), 'Unavailable stroke acknowledgement needs reason');
      else {
        demand(ack.subject === 'mask-stroke-acknowledgement' && Number.isInteger(ack.prefixOrdinal) && ack.prefixOrdinal >= 1 && ack.prefixOrdinal <= 118 &&
          action.endpoints[ack.prefixOrdinal].kind === 'pixels', 'Stroke acknowledgement must name a reviewed interior prefix');
        same(ack.after, action.endpoints[ack.prefixOrdinal].after, 'Stroke acknowledgement must use the same reviewed prefix pixels');
        retainPixel(ack.before); retainPixel(ack.after);
      }
    }
  }
  demand(files.size <= 5000, 'Generic oracle pixel inventory exceeds exact endpoint and acknowledgement count');
  return {files: [...files.values()], directories: [...directories], pixelBytes: [...files.values()].reduce((n, file) => n + file.bytes, 0)};
}

function clock(ack, id, schemaVersion) {demand(ack?.schemaVersion === schemaVersion && ack.event === 'clock' && ack.id === id, 'Generic native ACK differs'); ticks(ack.mach); return ack;}

/** Native ACKs only enclose the existing dispatch. Product exceptions survive
 * clock failures and are not converted into successful input records. */
export async function bracketGenericAction({captureClock, descriptor, run}) {
  return bracketVersionedAction({captureClock, descriptor, run}, 2);
}

export async function bracketGenericLosslessAction({captureClock, descriptor, run}) {
  return bracketVersionedAction({captureClock, descriptor, run}, 3);
}

async function bracketVersionedAction({captureClock, descriptor, run}, schemaVersion) {
  const actionId = genericNativeActionId(descriptor); let before = null, after = null, reason = null;
  try {before = clock(await captureClock(actionId + '-before'), actionId + '-before', schemaVersion);} catch {reason = 'native-before-clock-unavailable';}
  const value = await run();
  try {after = clock(await captureClock(actionId + '-after'), actionId + '-after', schemaVersion);} catch {reason ??= 'native-after-clock-unavailable';}
  if (before && after && ticks(after.mach) < ticks(before.mach)) reason = 'native-action-clock-reversed';
  return {value, bracket: {kind: 'native-action-bracket-1', actionId, status: reason ? 'unavailable' : 'complete',
    actionCompleted: true, before, after, ...(reason ? {reason} : {})}};
}

/** Explicit selected source route, no compilation/TCC/oracle generation. Input
 * preparation occurs first; native capture starts immediately before the
 * existing scored window, and closure happens after it without pixel waits. */
export async function prepareGenericWindowServer({configuration, runtime, sessionId, invocation, output, signal}) {
  const selected = genericNativeConfiguration(configuration, runtime), {selection, config, environment} = selected;
  signal?.throwIfAborted(); const outputIdentity = await ownedDirectory(output);
  keys(invocation, ['cellId', 'operation', 'serial', 'sample', 'producerPath', 'tracePath', 'rawFeedback'], 'generic browser invocation');
  demand(typeof invocation.cellId === 'string' && invocation.cellId.length > 0 && invocation.cellId.length <= 256 &&
    invocation.operation === 'interaction.brush' && Number.isSafeInteger(invocation.serial) && invocation.serial > 0 && object(invocation.sample) &&
    invocation.producerPath === join(output, 'browser-cell-' + invocation.serial + '.json') &&
    invocation.tracePath === join(output, 'browser-trace-' + invocation.serial + '.json'), 'Generic browser invocation path or operation differs');
  keys(invocation.sample, ['cache', 'ordinal', 'prime'], 'generic scheduled sample');
  demand(['cold', 'warm'].includes(invocation.sample.cache) && Number.isSafeInteger(invocation.sample.ordinal) && invocation.sample.ordinal >= 0 &&
    typeof invocation.sample.prime === 'boolean', 'Generic original schedule identity unavailable');
  const lossless = config.schemaVersion === 3;
  const source = await ordinary(fileURLToPath(new URL(lossless ? '../native/windowserver-session-lossless-capture.swift' : '../native/windowserver-session-capture.swift', import.meta.url)), 1024 ** 2, undefined, false, signal);
  const oracleFile = await ordinary(selection.oracle.path, MAX_MANIFEST, undefined, false, signal);
  demand(oracleFile.identity.sha256 === selection.oracle.sha256, 'Generic oracle raw manifest pin differs');
  const oracle = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(oracleFile.bytes)), inventory = genericOracleInventory(oracle, selected);
  const nativeSessionId = genericSessionNativeId(sessionId), retained = join(output, 'oracle-' + nativeSessionId), directory = join(output, 'native-' + nativeSessionId);
  let packedIndex, reviewRecord, packedDescription;
  if (lossless) {
    packedIndex = await ordinary(selection.oracle.storage.index.path, 4 * 1024 ** 2, undefined, false, signal);
    reviewRecord = await ordinary(selection.oracle.storage.review.path, 65536, undefined, false, signal);
    for (const [name, value] of [['index', packedIndex], ['review', reviewRecord]]) demand(value.identity.bytes === selection.oracle.storage[name].bytes &&
      value.identity.sha256 === selection.oracle.storage[name].sha256, 'Packed oracle ' + name + ' pin differs');
    packedDescription = validatePackedGenericOracle({indexBytes: packedIndex.bytes, indexSha256: packedIndex.identity.sha256,
      oracleSha256: oracleFile.identity.sha256, pixelIdentities: inventory.files, containerPin: selection.oracle.storage.container, reviewPin: selection.oracle.storage.review});
  }
  const oracleCategory = selection.evidenceReservation?.oracle;
  const retainedOracleBytes = oracleFile.identity.bytes + (lossless ? packedIndex.identity.bytes + reviewRecord.identity.bytes + selection.oracle.storage.container.bytes : inventory.pixelBytes);
  demand(Number.isSafeInteger(oracleCategory?.bytes) && oracleCategory.bytes >= retainedOracleBytes &&
    Number.isSafeInteger(oracleCategory.files) && oracleCategory.files >= (lossless ? 4 : inventory.files.length + 1) &&
    Number.isSafeInteger(oracleCategory.directories) && oracleCategory.directories >= (lossless ? 1 : inventory.directories.length),
    'Explicit oracle evidence reservation does not contain independent full-workload bytes');
  const admission = await (lossless ? inspectSessionLosslessEvidenceBudget : inspectSessionEvidenceBudget)({config, evidenceAllocation: selection.evidenceAllocation,
    evidenceReservation: selection.evidenceReservation, outputDirectory: output});
  demand(admission?.status === 'admitted' && Buffer.isBuffer(admission.allocationSourceBytes), 'Owned evidence allocation admission unavailable');
  const binding = {kind: 'generic-windowserver-input-binding-1', profile: GENERIC_PROFILE, sessionId, nativeSessionId,
    invocation: structuredClone(invocation),
    collectorSource: source.identity, build: selection.build, browser: structuredClone(runtime), environment, config,
    evidenceAllocation: selection.evidenceAllocation, evidenceReservation: selection.evidenceReservation,
    oracle: {path: join(retained, 'oracle.json'), bytes: oracleFile.identity.bytes, sha256: oracleFile.identity.sha256, pixels: inventory.files,
      ...(lossless ? {storage: {kind: 'rfc1951-oracle-pixels-1',
        index: {...selection.oracle.storage.index, path: join(retained, 'oracle-pixels.json')},
        container: {...selection.oracle.storage.container, path: join(retained, 'oracle-pixels.bin')},
        review: {...selection.oracle.storage.review, path: join(retained, 'semantic-review.record')},
        reviewReference: packedDescription.reviewReference}} : {})},
    allocationAdmissionPath: join(retained, 'allocation-admission.json'), allocationSourcePath: join(retained, 'allocation.json'),
    semanticOracleReview: lossless ? {requirement: 'external-independently-reviewed-exact-pixels-required',
      reference: packedDescription.reviewReference, reviewSha256: selection.oracle.storage.review.sha256, generatedByCapture: false, authorityFromFlags: false} : 'external-independently-reviewed-exact-pixels-required',
    historicalWindowOcclusion: 'adjacent-native-observations-not-atomic-at-frame-time'};
  const bindingBytes = json(binding), admissionBytes = json(admission.admission), control = selection.evidenceReservation.control;
  demand(control.files >= 3 && control.bytes >= bindingBytes.length + admissionBytes.length + admission.allocationSourceBytes.length,
    'Explicit control evidence reservation does not contain binding/allocation records');
  const currentOutput = await ownedDirectory(output); demand(currentOutput.dev === outputIdentity.dev && currentOutput.ino === outputIdentity.ino, 'Generic output identity changed before retention');
  await mkdir(retained, {mode: 0o700});
  if (!lossless) for (const relative of inventory.directories.filter(value => value !== '.').sort((a, b) => a.length - b.length)) await mkdir(join(retained, relative), {mode: 0o700});
  await writeFile(join(retained, 'oracle.json'), oracleFile.bytes, {flag: 'wx', mode: 0o600});
  let pixelIdentities = [];
  if (lossless) {
    const container = await ordinary(selection.oracle.storage.container.path, selection.oracle.storage.container.bytes, join(retained, 'oracle-pixels.bin'), true, signal);
    demand(container.identity.bytes === selection.oracle.storage.container.bytes && container.identity.sha256 === selection.oracle.storage.container.sha256, 'Packed oracle container pin differs');
    await writeFile(join(retained, 'oracle-pixels.json'), packedIndex.bytes, {flag: 'wx', mode: 0o600});
    await writeFile(join(retained, 'semantic-review.record'), reviewRecord.bytes, {flag: 'wx', mode: 0o600});
    const replayed = await replayPackedGenericOracle({containerPath: container.identity.path, containerPin: container.identity,
      indexBytes: packedIndex.bytes, indexSha256: packedIndex.identity.sha256, oracleSha256: oracleFile.identity.sha256,
      pixelIdentities: inventory.files, reviewPin: selection.oracle.storage.review, signal});
    pixelIdentities = replayed.pixelIdentities;
  } else {
    for (const file of inventory.files) {
      signal?.throwIfAborted();
      const value = await ordinary(join(dirname(selection.oracle.path), file.path), MAX_PIXEL, join(retained, file.path), false, signal);
      demand(value.identity.bytes === file.bytes && value.identity.sha256 === file.sha256, 'Independent generic oracle bytes differ from review pin');
      pixelIdentities.push({...value.identity, path: file.path});
    }
  }
  for (const [name, bytes] of [['binding.json', bindingBytes], ['allocation-admission.json', admissionBytes], ['allocation.json', admission.allocationSourceBytes]])
    await writeFile(join(retained, name), bytes, {flag: 'wx', mode: 0o600});
  return createGenericWindowServerTransaction({sessionId, config, binding, oracle, oracleBytes: oracleFile.bytes,
    oracleSha256: oracleFile.identity.sha256, pixelIdentities,
    startCapture: () => (lossless ? startSessionWindowServerLosslessCapture : startSessionWindowServerCapture)({build: {...selection.build, sourceSha256: source.identity.sha256}, config,
      evidenceAllocation: selection.evidenceAllocation, evidenceReservation: selection.evidenceReservation, directory,
      processRecordDirectory: output, abortSignal: signal, readyTimeoutMs: 15000, clockTimeoutMs: 3000, stopTimeoutMs: 120000})});
}

export function createGenericWindowServerTransaction(context) {
  const sessionId = context.sessionId, nativeSessionId = genericSessionNativeId(sessionId), used = new Set(), dispatches = [];
  const schemaVersion = context.config?.schemaVersion ?? 2;
  demand(schemaVersion === 2 || schemaVersion === 3 && context.config.storageFormat === 'rfc1951-previous-roi-1', 'Unsupported generic native transaction protocol');
  const lossless = schemaVersion === 3;
  const missing = [], failures = []; let capture, stopPromise, startCalled = false, endCalled = false, closed = false, finished, startAnchor, endAnchor, failedProcess, evidenceAdmission, evidenceVolumeStatus;
  const anchor = async boundary => {
    const ack = clock(await capture.captureClock(nativeSessionId + '-' + boundary), nativeSessionId + '-' + boundary, schemaVersion);
    return {kind: 'generic-native-session-anchor-1', status: 'complete', boundary, sessionId, nativeSessionId, ack: structuredClone(ack)};
  };
  const stopCapture = () => {
    if (!stopPromise && capture) {
      stopPromise = Promise.resolve().then(() => capture.stop());
      // The native stream closes before subsequent raw trace parsing. Retain
      // and observe this exact promise until finish consumes its replay result.
      void stopPromise.catch(() => {});
    }
    return stopPromise;
  };
  return {
    async start() {
      demand(!startCalled && !closed, 'Generic native session start is single-use'); startCalled = true;
      try {
        capture = await context.startCapture(); same(capture.ready.display, context.oracle.display, 'Generic native display geometry differs');
        startAnchor = await anchor('begin');
      } catch (error) {
        failedProcess = error?.windowServerProcess ?? error?.sessionWindowServerProcess ?? null;
        evidenceAdmission = error?.sessionEvidenceAdmission ?? null; evidenceVolumeStatus = error?.evidenceVolumeStatus ?? null;
        missing.push('generic-native-session-start-unavailable'); failures.push(info(error));
        startAnchor = {kind: 'generic-native-session-anchor-1', status: 'unavailable', boundary: 'begin', sessionId, nativeSessionId, ack: null};
      }
      return structuredClone(startAnchor);
    },
    async hook({descriptor, run}) {
      const actionId = genericNativeActionId(descriptor);
      demand(!closed && startCalled && !endCalled && descriptor.sessionId === sessionId && !used.has(actionId), 'Generic dispatch identity or lifetime differs');
      used.add(actionId);
      const result = await (lossless ? bracketGenericLosslessAction : bracketGenericAction)({descriptor, run, captureClock: id => {
        demand(capture && startAnchor?.status === 'complete', 'Generic native capture is unavailable'); return capture.captureClock(id);
      }});
      dispatches.push({descriptor: structuredClone(descriptor), nativeActionId: actionId, bracket: structuredClone(result.bracket)});
      return result;
    },
    async end() {
      demand(!closed && startCalled && !endCalled, 'Generic native end is single-use'); endCalled = true;
      try {demand(capture, 'Generic capture unavailable'); endAnchor = await anchor('end');}
      catch (error) {missing.push('generic-native-session-end-unavailable'); failures.push(info(error));
        endAnchor = {kind: 'generic-native-session-anchor-1', status: 'unavailable', boundary: 'end', sessionId, nativeSessionId, ack: null};}
      stopCapture();
      return structuredClone(endAnchor);
    },
    finish({result, actionCompleted} = {}) {
      if (finished) return finished.then(value => structuredClone(value));
      closed = true;
      finished = (async () => {
        let stopped, projection = null, joined = null, lossObservations = null;
        try {if (capture) stopped = await stopCapture();}
        catch (error) {failedProcess = error?.windowServerProcess ?? error?.sessionWindowServerProcess ?? failedProcess;
          evidenceAdmission = error?.sessionEvidenceAdmission ?? evidenceAdmission; evidenceVolumeStatus = error?.evidenceVolumeStatus ?? evidenceVolumeStatus;
          missing.push('generic-native-closure-unavailable'); failures.push(info(error));}
        const raw = result?.observations ?? result;
        try {projection = projectGenericInteraction(raw, {sessionId});}
        catch (error) {missing.push('generic-input-projection-unavailable'); failures.push(info(error));}
        if (actionCompleted !== true) missing.push('generic-product-session-not-completed');
        const inputBound = projection && isDeepStrictEqual(raw?.nativeSessionStart, startAnchor) && isDeepStrictEqual(raw?.nativeSessionEnd, endAnchor) &&
          isDeepStrictEqual(projection.actions.flatMap(action => action.dispatches.map(step => ({descriptor: step.descriptor,
            nativeActionId: step.nativeActionId, bracket: step.bracket}))), dispatches);
        if (!inputBound) missing.push('generic-native-dispatch-invocation-binding-unavailable');
        if (stopped?.capture && projection && inputBound && actionCompleted === true) {
          try {
            const retained = (lossless ? getWindowServerSessionLosslessObservations : getWindowServerSessionObservations)(stopped.capture); lossObservations = retained.lossObservations;
            joined = (lossless ? joinGenericActionLosslessPixels : joinGenericActionPixels)(stopped.capture, {projection, oracle: context.oracle, oracleBytes: context.oracleBytes,
              oracleSha256: context.oracleSha256, pixelIdentities: context.pixelIdentities,
              binding: {fixtureSha256: context.binding.environment.fixtureSha256, browserEnvironmentSha256: context.binding.environment.browserEnvironmentSha256,
                browserPid: context.binding.browser.browserPid, windowNumber: capture.ready.windowAdmission.windowNumber}});
          } catch (error) {missing.push('generic-native-pixel-join-unavailable'); failures.push(info(error));}
        } else missing.push('generic-native-join-prerequisites-unavailable');
        if (projection) missing.push(...projection.missing);
        if (!joined || joined.status === 'INCONCLUSIVE') missing.push('generic-native-endpoint-coverage-incomplete');
        return {kind: 'generic-windowserver-observation-1', profile: GENERIC_PROFILE, sessionId, nativeSessionId, nativeSchemaVersion: schemaVersion, qualification: false,
          binding: context.binding, ready: capture?.ready ?? null, config: capture?.config ?? null, processIdentity: capture?.processIdentity ?? null,
          nativeSessionStart: startAnchor ?? null, nativeSessionEnd: endAnchor ?? null, inputBound: !!inputBound,
          projection, join: joined, lossObservations, evidence: stopped ? {manifest: stopped.manifest, process: stopped.process} : null,
          failedProcess, evidenceAdmission: evidenceAdmission ?? null, evidenceVolumeStatus: evidenceVolumeStatus ?? null,
          missing: [...new Set(missing)], failures,
          limitations: {physicalInput: false, firstPresentedFrame: false, physicalScanout: false, completeDisplaySlots: false,
            opaqueEvaluatorProof: false, browserNativeClockConversion: false}};
      })();
      return finished.then(value => structuredClone(value));
    },
  };
}

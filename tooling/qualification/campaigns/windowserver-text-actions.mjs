import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, writeFile} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {firstUseEnvironmentBinding} from './windowserver-first-use.mjs';
import {startTextSessionWindowServerLosslessCapture} from './windowserver-text-session-lossless-process.mjs';
import {inspectTextSessionLosslessEvidenceBudget} from './windowserver-text-session-lossless-budget.mjs';
import {getWindowServerTextSessionLosslessObservations} from './windowserver-text-session-lossless.mjs';
import {TEXT_INPUT_PROFILE, textInputIdentity, textSessionNativeId, projectTextInteraction} from './browser-text-input.mjs';
import {textOracleInventory, joinTextActionPixels} from './text-action-oracle.mjs';
import {validatePackedGenericOracle, replayPackedGenericOracle} from './generic-oracle-lossless.mjs';
import {buildTextInteractionPlan, inspectTextFixture} from './browser-text.mjs';
import {attemptIdentity} from './common.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const demand = (value, message) => {if (!value) throw Error(message);};
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const keys = (value, names, label) => demand(object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort()), 'Invalid ' + label + ' fields');
const info = error => ({name: String(error?.name ?? 'Error').slice(0, 64), message: String(error?.message ?? error).slice(0, 1024)});
const ticks = value => {demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'Invalid text native clock'); const result = BigInt(value); demand(result <= 18446744073709551615n, 'Text native clock overflow'); return result;};

async function ownedDirectory(path) {
  demand(isAbsolute(path ?? '') && resolve(path) === path && await realpath(path) === path, 'Text output must be canonical');
  const stat = await lstat(path);
  demand(stat.isDirectory() && !stat.isSymbolicLink() && typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
    'Text output must be a private owned directory'); return stat;
}
async function ordinary(path, maximum, destination, signal, allowEmpty = false) {
  signal?.throwIfAborted();
  demand(isAbsolute(path ?? '') && resolve(path) === path && await realpath(path) === path, 'Text input must be canonical');
  signal?.throwIfAborted(); const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let output;
  try {
    const before = await input.stat(); demand(before.isFile() && (allowEmpty || before.size > 0) && before.size <= maximum, 'Text input exceeds ordinary-file bound');
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const digest = createHash('sha256'), chunk = Buffer.alloc(Math.min(1024 ** 2, before.size)), chunks = destination ? null : []; let position = 0;
    while (position < before.size) {
      signal?.throwIfAborted(); const {bytesRead} = await input.read(chunk, 0, Math.min(chunk.length, before.size - position), position); signal?.throwIfAborted();
      demand(bytesRead > 0, 'Text input truncated'); const bytes = chunk.subarray(0, bytesRead); digest.update(bytes); if (chunks) chunks.push(Buffer.from(bytes));
      if (output) {let offset = 0; while (offset < bytesRead) {signal?.throwIfAborted(); const written = await output.write(bytes, offset, bytesRead - offset, position + offset); demand(written.bytesWritten > 0, 'Text retention stalled'); offset += written.bytesWritten;}}
      position += bytesRead;
    }
    const after = await input.stat(), named = await lstat(path);
    demand(named.isFile() && !named.isSymbolicLink() && ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key] && after[key] === named[key]), 'Text input changed during retention');
    signal?.throwIfAborted(); if (output) await output.sync(); signal?.throwIfAborted();
    return {bytes: chunks ? Buffer.concat(chunks) : null, identity: {path: destination ?? path, bytes: position, sha256: digest.digest('hex')}};
  } finally {await output?.close(); await input.close();}
}

export function textNativeConfiguration(value, runtime) {
  keys(value, ['kind', 'storageFormat', 'build', 'oracle', 'displayID', 'roi', 'evidenceAllocation', 'evidenceReservation'], 'text native selection');
  demand(value.kind === 'windowserver-text-actions-configuration-1' && value.storageFormat === 'rfc1951-previous-roi-1', 'Explicit text native lossless profile required');
  const environment = firstUseEnvironmentBinding(runtime);
  keys(value.build, ['receiptPath', 'receiptSha256'], 'text build'); keys(value.oracle, ['path', 'sha256', 'storage'], 'text oracle');
  demand(isAbsolute(value.build.receiptPath ?? '') && sha(value.build.receiptSha256) && isAbsolute(value.oracle.path ?? '') && sha(value.oracle.sha256), 'Text source/oracle pins missing');
  keys(value.oracle.storage, ['kind', 'index', 'container', 'review'], 'text packed oracle');
  demand(value.oracle.storage.kind === 'rfc1951-oracle-pixels-1', 'Explicit independent oracle format required');
  for (const name of ['index', 'container', 'review']) {
    const pin = value.oracle.storage[name]; keys(pin, ['path', 'bytes', 'sha256'], 'text oracle ' + name);
    demand(isAbsolute(pin.path ?? '') && sha(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes >= (name === 'container' ? 0 : 1) &&
      (name !== 'index' || pin.bytes <= 4 * 1024 ** 2) && (name !== 'review' || pin.bytes <= 65536), 'Invalid text oracle pin');
  }
  demand(Number.isSafeInteger(value.displayID) && value.displayID > 0 && Number.isSafeInteger(value.evidenceReservation?.nativeArtifactBytes) && value.evidenceReservation.nativeArtifactBytes > 0,
    'Text display/native allowance missing');
  keys(value.roi, ['x', 'y', 'width', 'height'], 'text ROI');
  demand(Object.values(value.roi).every(n => Number.isSafeInteger(n) && n >= 0) && value.roi.width > 0 && value.roi.height > 0 && value.roi.width * value.roi.height * 4 <= 256 * 1024 ** 2, 'Invalid text ROI');
  return {selection: structuredClone(value), environment, config: {schemaVersion: 4, profile: TEXT_INPUT_PROFILE,
    storageFormat: 'rfc1951-previous-roi-1', displayID: value.displayID, expectedBrowserPid: runtime.browserPid, roi: structuredClone(value.roi)}};
}

/** Independent recomputation of retained fixture metadata; no corpus strings
 * or fragment payloads enter the binding. The original fixture remains sealed. */
export function verifyTextAttempt(textAttempt, {fixture, runtime, sessionId}) {
  demand(textAttempt?.kind === 'text-campaign-attempt-1' && textAttempt.sessionId === sessionId && ['WXn', 'WXs'].includes(textAttempt.workload), 'Text attempt identity unavailable');
  demand(inspectTextFixture(fixture, 'text.interaction', textAttempt.workload).length === 0, 'Actual sealed text fixture unavailable');
  same(textAttempt.fixtureSeal, fixture.seal, 'Text fixture seal differs');
  demand(fixture.seal?.sha256?.replace(/^sha256:/, '') === runtime.fixtureSeal?.sha256?.replace(/^sha256:/, ''), 'Text launch fixture differs');
  const text = fixture.text, prefixed = value => 'sha256:' + hash(value);
  same(textAttempt.textFixture, {schema: text.schema, manifestHash: text.manifestHash,
    corpus: {sha256: text.corpus.sha256, bytes: Buffer.byteLength(text.corpus.text, 'utf8'), fragmentsHash: text.corpus.fragmentsHash,
      fragmentCount: text.corpus.fragments.length, scripts: [...text.corpus.scripts]},
    fonts: text.fonts.map(font => ({id: font.id, sha256: font.sha256, bytes: font.bytes, kind: font.kind, licenseSha256: font.licenseSha256 ?? null})),
    semanticItemIdsHash: prefixed(JSON.stringify(text.semanticItemIds)), activeLayerId: text.activeLayerId ?? null,
    activeLayerIndex: text.activeLayerIndex ?? null, fontSetPreseeded: text.fontSetPreseeded === true}, 'Text fixture metadata differs');
  const sourcePlan = buildTextInteractionPlan(), actions = sourcePlan.map(({key, ...row}) => key === undefined ? row : {...row, inputKey: key});
  same(textAttempt.actionPlan, {sha256: prefixed(JSON.stringify(actions)), sourcePlanSha256: prefixed(JSON.stringify(sourcePlan)), actions,
    durationMs: 60000, refreshHz: 60, observedExecution: false, physicalInput: false, compositionEvents: 'synthetic-app-handling'}, 'Text original plan differs');
  demand(typeof textAttempt.attemptId === 'string' && textAttempt.attemptId.length > 0 && Number.isSafeInteger(textAttempt.processIdentity?.pid) &&
    textAttempt.processIdentity.pid === process.pid && typeof textAttempt.processIdentity.startedAt === 'string' && Number.isFinite(Date.parse(textAttempt.processIdentity.startedAt)) &&
    textAttempt.processIdentity.node === process.version, 'Text original worker identity unavailable');
  return structuredClone(textAttempt);
}

function clock(ack, id) {demand(ack?.schemaVersion === 4 && ack.event === 'clock' && ack.id === id, 'Text native ACK differs'); ticks(ack.mach); return ack;}
export async function bracketTextAction({captureClock, descriptor, run}) {
  const {nativeActionId: actionId} = textInputIdentity(descriptor); let before = null, after = null, reason = null;
  try {before = clock(await captureClock(actionId + '-before'), actionId + '-before');} catch {reason = 'native-before-clock-unavailable';}
  const value = await run();
  try {after = clock(await captureClock(actionId + '-after'), actionId + '-after');} catch {reason ??= 'native-after-clock-unavailable';}
  if (before && after && ticks(after.mach) < ticks(before.mach)) reason = 'native-action-clock-reversed';
  return {value, bracket: {kind: 'native-action-bracket-1', actionId, status: reason ? 'unavailable' : 'complete', actionCompleted: true,
    before, after, ...(reason ? {reason} : {})}};
}

export async function prepareTextWindowServer({configuration, runtime, sessionId, invocation, fixture, textAttempt, output, signal}) {
  runtime = structuredClone(runtime); invocation = structuredClone(invocation);
  const selected = textNativeConfiguration(configuration, runtime), {selection, config, environment} = selected;
  const attempt = verifyTextAttempt(textAttempt, {fixture, runtime, sessionId});
  signal?.throwIfAborted(); const outputIdentity = await ownedDirectory(output);
  keys(invocation, ['cellId', 'operation', 'serial', 'sample', 'producerPath', 'tracePath', 'rawFeedback'], 'text invocation');
  demand(typeof invocation.cellId === 'string' && invocation.cellId.length > 0 && invocation.operation === 'text.interaction' && Number.isSafeInteger(invocation.serial) && invocation.serial > 0 &&
    invocation.producerPath === join(output, 'browser-cell-' + invocation.serial + '.json') && invocation.tracePath === join(output, 'browser-trace-' + invocation.serial + '.json'), 'Text original producer/trace path differs');
  keys(invocation.sample, ['cache', 'ordinal', 'prime'], 'text sample');
  demand(['cold', 'warm', 'single'].includes(invocation.sample.cache) && Number.isSafeInteger(invocation.sample.ordinal) && invocation.sample.ordinal >= 0 && typeof invocation.sample.prime === 'boolean', 'Text original schedule unavailable');
  demand(attempt.attemptId === attemptIdentity({id: invocation.cellId}, invocation.sample.cache, invocation.sample.ordinal, invocation.sample.prime), 'Text producer/attempt pairing differs');
  const source = await ordinary(fileURLToPath(new URL('../native/windowserver-text-session-lossless-capture.swift', import.meta.url)), 1024 ** 2, undefined, signal);
  const oracleFile = await ordinary(selection.oracle.path, 16 * 1024 ** 2, undefined, signal); demand(oracleFile.identity.sha256 === selection.oracle.sha256, 'Text oracle manifest pin differs');
  const oracle = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(oracleFile.bytes)), inventory = textOracleInventory(oracle, selected);
  const index = await ordinary(selection.oracle.storage.index.path, 4 * 1024 ** 2, undefined, signal), review = await ordinary(selection.oracle.storage.review.path, 65536, undefined, signal);
  for (const [name, value] of [['index', index], ['review', review]]) demand(value.identity.bytes === selection.oracle.storage[name].bytes && value.identity.sha256 === selection.oracle.storage[name].sha256, 'Text oracle ' + name + ' pin differs');
  const packed = validatePackedGenericOracle({indexBytes: index.bytes, indexSha256: index.identity.sha256, oracleSha256: oracleFile.identity.sha256,
    pixelIdentities: inventory.files, containerPin: selection.oracle.storage.container, reviewPin: selection.oracle.storage.review});
  const category = selection.evidenceReservation.oracle, required = oracleFile.identity.bytes + index.identity.bytes + review.identity.bytes + selection.oracle.storage.container.bytes;
  demand(Number.isSafeInteger(category?.bytes) && category.bytes >= required && Number.isSafeInteger(category.files) && category.files >= 4 && Number.isSafeInteger(category.directories) && category.directories >= 1, 'Text encoded oracle reservation insufficient');
  const admission = await inspectTextSessionLosslessEvidenceBudget({config, evidenceAllocation: selection.evidenceAllocation, evidenceReservation: selection.evidenceReservation, outputDirectory: output});
  demand(admission?.status === 'admitted' && Buffer.isBuffer(admission.allocationSourceBytes), 'Text owned evidence admission unavailable');
  const nativeSessionId = textSessionNativeId(sessionId), retained = join(output, 'oracle-' + nativeSessionId), directory = join(output, 'native-' + nativeSessionId);
  const binding = {kind: 'text-windowserver-input-binding-1', profile: TEXT_INPUT_PROFILE, sessionId, nativeSessionId, invocation: structuredClone(invocation), textAttempt: attempt,
    collectorSource: source.identity, build: selection.build, browser: structuredClone(runtime), environment, config,
    evidenceAllocation: selection.evidenceAllocation, evidenceReservation: selection.evidenceReservation,
    oracle: {path: join(retained, 'oracle.json'), bytes: oracleFile.identity.bytes, sha256: oracleFile.identity.sha256, pixels: inventory.files,
      storage: {kind: 'rfc1951-oracle-pixels-1', index: {...selection.oracle.storage.index, path: join(retained, 'oracle-pixels.json')},
        container: {...selection.oracle.storage.container, path: join(retained, 'oracle-pixels.bin')}, review: {...selection.oracle.storage.review, path: join(retained, 'semantic-review.record')}, reviewReference: packed.reviewReference}},
    allocationAdmissionPath: join(retained, 'allocation-admission.json'), allocationSourcePath: join(retained, 'allocation.json'),
    semanticOracleReview: {requirement: 'external-independently-reviewed-exact-pixels-required', reference: packed.reviewReference, reviewSha256: selection.oracle.storage.review.sha256, generatedByCapture: false, authorityFromFlags: false},
    historicalWindowOcclusion: 'adjacent-native-observations-not-atomic-at-frame-time'};
  const bindingBytes = json(binding), admissionBytes = json(admission.admission), control = selection.evidenceReservation.control;
  demand(control.files >= 3 && control.bytes >= bindingBytes.length + admissionBytes.length + admission.allocationSourceBytes.length, 'Text control reservation insufficient');
  const currentOutput = await ownedDirectory(output); demand(currentOutput.dev === outputIdentity.dev && currentOutput.ino === outputIdentity.ino, 'Text output changed before retention');
  signal?.throwIfAborted(); await mkdir(retained, {mode: 0o700});
  const container = await ordinary(selection.oracle.storage.container.path, selection.oracle.storage.container.bytes, join(retained, 'oracle-pixels.bin'), signal, true);
  demand(container.identity.bytes === selection.oracle.storage.container.bytes && container.identity.sha256 === selection.oracle.storage.container.sha256, 'Text encoded oracle bytes differ');
  const replayed = await replayPackedGenericOracle({containerPath: container.identity.path, containerPin: container.identity, indexBytes: index.bytes, indexSha256: index.identity.sha256,
    oracleSha256: oracleFile.identity.sha256, pixelIdentities: inventory.files, reviewPin: selection.oracle.storage.review, signal});
  for (const [name, bytes] of [['oracle.json', oracleFile.bytes], ['oracle-pixels.json', index.bytes], ['semantic-review.record', review.bytes],
    ['binding.json', bindingBytes], ['allocation-admission.json', admissionBytes], ['allocation.json', admission.allocationSourceBytes]]) {signal?.throwIfAborted(); await writeFile(join(retained, name), bytes, {flag: 'wx', mode: 0o600});}
  return createTextWindowServerTransaction({sessionId, config, binding, oracle, oracleBytes: oracleFile.bytes, oracleSha256: oracleFile.identity.sha256, pixelIdentities: replayed.pixelIdentities,
    startCapture: () => startTextSessionWindowServerLosslessCapture({build: {...selection.build, sourceSha256: source.identity.sha256}, config,
      evidenceAllocation: selection.evidenceAllocation, evidenceReservation: selection.evidenceReservation, directory, processRecordDirectory: output, abortSignal: signal,
      readyTimeoutMs: 15000, clockTimeoutMs: 3000, stopTimeoutMs: 120000})});
}

export function createTextWindowServerTransaction(context) {
  const sessionId = context.sessionId, nativeSessionId = textSessionNativeId(sessionId), used = new Set(), dispatches = [];
  demand(context.config?.schemaVersion === 4 && context.config.profile === TEXT_INPUT_PROFILE && context.config.storageFormat === 'rfc1951-previous-roi-1', 'Explicit text native protocol required');
  const missing = [], failures = []; let capture, stopPromise, started = false, ended = false, closed = false, finished, startAnchor, endAnchor, failedProcess, evidenceAdmission, evidenceVolumeStatus;
  const anchor = async boundary => {const id = nativeSessionId + (boundary === 'begin' ? '-win-before' : '-win-after'); return {
    kind: 'text-native-session-anchor-1', status: 'complete', boundary, sessionId, nativeSessionId, ack: structuredClone(clock(await capture.captureClock(id), id))};};
  const failed = error => {failedProcess = error?.windowServerProcess ?? error?.sessionWindowServerProcess ?? failedProcess;
    evidenceAdmission = error?.sessionEvidenceAdmission ?? evidenceAdmission; evidenceVolumeStatus = error?.evidenceVolumeStatus ?? evidenceVolumeStatus; failures.push(info(error));};
  const stopCapture = () => {
    if (!stopPromise && capture) {
      stopPromise = Promise.resolve().then(() => capture.stop());
      // Drain can continue while this promise retains the exact stop result.
      // Observe rejection immediately, including primitive/falsy failures.
      void stopPromise.catch(() => {});
    }
    return stopPromise;
  };
  return {
    async start() {
      demand(!started && !closed, 'Text native start is single-use'); started = true;
      try {capture = await context.startCapture(); same(capture.ready.display, context.oracle.display, 'Text native geometry differs'); startAnchor = await anchor('begin');}
      catch (error) {failed(error); missing.push('text-native-session-start-unavailable'); startAnchor = {kind: 'text-native-session-anchor-1', status: 'unavailable', boundary: 'begin', sessionId, nativeSessionId, ack: null};}
      return structuredClone(startAnchor);
    },
    async hook({descriptor, run}) {
      const {nativeActionId} = textInputIdentity(descriptor);
      demand(!closed && started && !ended && descriptor.sessionId === sessionId && !used.has(nativeActionId), 'Text native dispatch identity/lifetime differs'); used.add(nativeActionId);
      const result = await bracketTextAction({descriptor, run, captureClock: id => {demand(capture && startAnchor?.status === 'complete', 'Text capture unavailable'); return capture.captureClock(id);}});
      dispatches.push({descriptor: structuredClone(descriptor), nativeActionId, nativeBracket: structuredClone(result.bracket)}); return result;
    },
    async end() {
      demand(!closed && started && !ended, 'Text native end is single-use'); ended = true;
      try {demand(capture, 'Text capture unavailable'); endAnchor = await anchor('end');}
      catch (error) {failed(error); missing.push('text-native-session-end-unavailable'); endAnchor = {kind: 'text-native-session-anchor-1', status: 'unavailable', boundary: 'end', sessionId, nativeSessionId, ack: null};}
      stopCapture();
      return structuredClone(endAnchor);
    },
    finish({result, actionCompleted} = {}) {
      if (finished) return finished.then(value => structuredClone(value)); closed = true;
      finished = (async () => {
        let stopped, projection = null, joined = null, lossObservations = null;
        try {if (capture) stopped = await stopCapture();} catch (error) {failed(error); missing.push('text-native-closure-unavailable');}
        const raw = result?.observations ?? result;
        try {projection = projectTextInteraction(raw, {sessionId});} catch (error) {failures.push(info(error)); missing.push('text-input-projection-unavailable');}
        const inputBound = projection && isDeepStrictEqual(raw?.nativeSessionStart, startAnchor) && isDeepStrictEqual(raw?.nativeSessionEnd, endAnchor) &&
          isDeepStrictEqual(raw?.textFixture, context.binding.textAttempt.textFixture) && isDeepStrictEqual(projection.actions.flatMap(action => action.dispatches.map(step =>
            ({descriptor: step.descriptor, nativeActionId: step.nativeActionId, nativeBracket: step.nativeBracket}))), dispatches);
        if (actionCompleted !== true) missing.push('text-product-session-not-completed'); if (!inputBound) missing.push('text-native-input-binding-unavailable');
        if (stopped?.capture && projection && inputBound && actionCompleted === true) try {
          lossObservations = getWindowServerTextSessionLosslessObservations(stopped.capture).lossObservations;
          joined = joinTextActionPixels(stopped.capture, {raw, projection, oracle: context.oracle, oracleBytes: context.oracleBytes, oracleSha256: context.oracleSha256, pixelIdentities: context.pixelIdentities,
            binding: {fixtureSha256: context.binding.environment.fixtureSha256, browserEnvironmentSha256: context.binding.environment.browserEnvironmentSha256,
              browserPid: context.binding.browser.browserPid, windowNumber: capture.ready.windowAdmission.windowNumber}});
        } catch (error) {failures.push(info(error)); missing.push('text-native-pixel-join-unavailable');}
        else missing.push('text-native-join-prerequisites-unavailable');
        if (projection) missing.push(...projection.missing); if (!joined || joined.status === 'INCONCLUSIVE') missing.push('text-native-endpoint-coverage-incomplete');
        return {kind: 'text-windowserver-observation-1', profile: TEXT_INPUT_PROFILE, nativeSchemaVersion: 4, sessionId, nativeSessionId, qualification: false,
          binding: context.binding, ready: capture?.ready ?? null, config: capture?.config ?? null, processIdentity: capture?.processIdentity ?? null,
          nativeSessionStart: startAnchor ?? null, nativeSessionEnd: endAnchor ?? null, inputBound: !!inputBound, projection, join: joined, lossObservations,
          evidence: stopped ? {manifest: stopped.manifest, process: stopped.process} : null, failedProcess: failedProcess ?? null,
          evidenceAdmission: evidenceAdmission ?? null, evidenceVolumeStatus: evidenceVolumeStatus ?? null, missing: [...new Set(missing)], failures,
          limitations: {physicalInput: false, nativeIME: false, firstPresentedFrame: false, physicalScanout: false, completeDisplaySlots: false, opaqueEvaluatorProof: false, browserNativeClockConversion: false}};
      })(); return finished.then(value => structuredClone(value));
    }
  };
}

import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {validateWindowServerReady, verifyWindowServerCapture, firstUseNativeActionId, joinFirstUseWindowServerPixels} from './windowserver-presentation.mjs';
import {verifyWindowServerBuildEvidence} from '../native/windowserver-build.mjs';
import {nativeFirstUseConfiguration, validateFirstUseOracle} from './windowserver-first-use.mjs';
import {discreteInputDescriptor, validateDiscreteInput} from './browser-discrete-input.mjs';
import {normalizeResult} from './worker.mjs';
import {sanitize} from './common.mjs';

const proofs = new WeakMap();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const bare = value => typeof value === 'string' ? value.replace(/^sha256:/, '') : value;
const pin = value => typeof bare(value) === 'string' && /^[a-f0-9]{64}$/.test(bare(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const json = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const buildMembers = ['manifest.json', 'build-receipt.json', 'collector.swift', 'sdk-manifest.json', 'version.stdout.log', 'version.stderr.log', 'build.stdout.log', 'build.stderr.log', 'windowserver-capture'];
const unsupported = message => {throw Object.assign(Error(message), {code: 'FIRST_USE_REPLAY_UNAVAILABLE'});};

/** Add the finite first-use raw closure to the existing metadata/HMR union. */
export function isFirstUseNativeEvidencePath(path) {
  return /(?:^|\/)native-fu-[a-f0-9]{48}\/(?:stdout\.ndjson|capture\/(?:frames\.ndjson|frame-[1-9][0-9]*\.bgra)|build-evidence\/(?:collector\.swift|windowserver-capture))$/.test(path) ||
    /(?:^|\/)oracle-fu-[a-f0-9]{48}\/(?:before|after)\.bgra$/.test(path);
}
function comparable(record) {
  if (!record || typeof record !== 'object') return null;
  const {id, producerId, cache, ordinal, nativePresentationProof, ...value} = record;
  return value;
}
export function readVerifiedFirstUseBounds(proof, record) {
  const entry = proofs.get(proof);
  if (!entry || !record || (record.producerId !== undefined ? record.id !== entry.attemptId || record.producerId !== entry.producerId : record.id !== entry.producerId) ||
    record.cache !== undefined && record.cache !== entry.cache || record.ordinal !== undefined && record.ordinal !== entry.ordinal ||
    !isDeepStrictEqual(comparable(record), entry.record)) return null;
  return structuredClone(entry.value);
}
function nativeUpper(start, end, timebase) {
  demand(typeof start === 'string' && /^\d+$/.test(start) && typeof end === 'string' && /^\d+$/.test(end) &&
    integer(timebase?.numer) && timebase.numer > 0 && integer(timebase?.denom) && timebase.denom > 0, 'Native first-use clock arithmetic unavailable');
  const delta = BigInt(end) - BigInt(start); demand(delta >= 0n, 'Native first-use clocks reversed');
  const numerator = delta * BigInt(timebase.numer), denominator = BigInt(timebase.denom) * 1_000_000n;
  const micros = (numerator * 1000n + denominator - 1n) / denominator;
  demand(micros <= BigInt(Number.MAX_SAFE_INTEGER), 'Native first-use bound exceeds exact arithmetic');
  return Number(micros) / 1000;
}

/** Missing/unsupported evidence mints nothing. Contradictions to an available
 * sealed byte/identity remain errors. No serialized boolean can mint a proof. */
export async function verifyFirstUseWindowServerEvidence(context) {
  try {return await replay(context);}
  catch (error) {if (error?.code === 'FIRST_USE_REPLAY_UNAVAILABLE' || error?.code === 'ENOENT') return null; throw error;}
}
async function replay({attempt, cell, configuration, groupOutput, retainedPaths, readRetained, resolveRetained, controlFiles, sourceFiles, fixture,
  workerPid, sourceRoot, engine, developerState, developerStateIdentity, subjectDigest, browserCache, tools}) {
  const result = attempt?.result, record = result?.firstUse, observation = record?.nativePresentation;
  if (!observation || cell?.operation !== 'interaction.first-use' || !['Mask', 'Adapter library'].includes(record?.feature)) return null;
  if (result.status === 'FAIL' || attempt.status === 'FAIL' || record.outcome !== 'expected' || record.meaningful !== true) return null;
  if (observation.join?.status !== 'observed' || !observation.evidence || observation.missing?.length || observation.failures?.length) return null;
  demand(typeof attempt.id === 'string' && attempt.cache === 'cold' && attempt.prime === false && integer(attempt.ordinal) && attempt.ordinal > 0 &&
    isAbsolute(groupOutput) && resolve(groupOutput) === groupOutput && Array.isArray(retainedPaths) && integer(workerPid) && workerPid > 1,
  'First-use replay needs its actual cold scored attempt and worker');
  demand(attempt.id === `${cell.id}/cold/scored/${attempt.ordinal}`, 'First-use canonical attempt identity differs');
  const feature = cell.parameters?.feature === 'adapter' ? 'Adapter library' : 'Mask';
  demand(record.feature === feature && observation.feature === feature && record.id === String(cell.id) + ':' + String(attempt.ordinal), 'First-use feature or producer differs from its selected cell');
  const paths = new Set(retainedPaths);
  function local(path) {
    demand(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path.startsWith(groupOutput + sep), 'First-use reference leaves its original group');
    const value = relative(groupOutput, path).split(sep).join('/'); if (!paths.has(value)) unsupported('First-use member is not retained'); return value;
  }
  async function bytes(path, identity, maximum) {
    if (!paths.has(path)) unsupported('Missing first-use raw member: ' + path);
    if (identity) demand(integer(identity.bytes) && identity.bytes <= maximum && pin(identity.sha256), 'Invalid first-use artifact identity');
    const value = await readRetained(path, {maximum});
    demand(Buffer.isBuffer(value) && value.length <= maximum, 'First-use member exceeds its read bound');
    if (identity) demand(value.length === identity.bytes && hash(value) === bare(identity.sha256), 'First-use member differs from its pin');
    return value;
  }
  const producerPath = 'browser-cell-1.json', producer = json(await bytes(producerPath, null, 8 * 1024 ** 2));
  demand(producer.cellId === cell.id && producer.operation === 'interaction.first-use' && producer.timingSamplesReusable === true, 'First-use producer scope differs');
  const tracePin = producer.trace?.artifact;
  if (!tracePin || producer.trace?.segments) return null;
  same(sanitize(normalizeResult({...producer, artifacts: [join(groupOutput, producerPath), tracePin.path]}, attempt.startMs, attempt.endMs)), result, 'First-use attempt differs from retained producer');
  const raw = producer.observations;
  demand(raw && record.reset === true && record.presentedMs === null && raw.presentedMs === null &&
    record.resetEvidence?.freshBrowserContext === true && record.resetEvidence.fixtureCopiedBeforeLaunch === true &&
    raw.observationWindowMs === 1000 && raw.windowClock === 'runner-monotonic' && raw.readyClock === 'runner-monotonic' &&
    finite(raw.startMs) && finite(raw.readyMs) && raw.readyMs >= raw.startMs && raw.endMs === raw.startMs + 1000 &&
    finite(raw.captureStoppedMs) && raw.captureStoppedMs >= raw.endMs && finite(attempt.startMs) && finite(attempt.endMs) &&
    attempt.startMs <= raw.startMs && raw.captureStoppedMs <= attempt.endMs, 'First-use original window/public ready boundary differs');
  for (const key of ['feature', 'startMs', 'endMs', 'captureStoppedMs', 'inputMs', 'inputClock', 'inputTimeOrigin', 'discreteInput', 'nativeReadiness', 'readyMs', 'readyClock', 'windowClock', 'presentedMs', 'meaningful']) same(record[key], raw[key], 'First-use projection differs: ' + key);
  demand(raw.meaningful === true && raw.discreteInput?.status === 'PASS' && raw.discreteInput.steps?.length === 1, 'First-use actual input/public outcome unavailable');
  const step = raw.discreteInput.steps[0], descriptor = discreteInputDescriptor(observation.descriptor), actionId = firstUseNativeActionId(descriptor);
  demand(step.dispatchCompleted === true && actionId === observation.nativeActionId && observation.kind === 'first-use-windowserver-observation-1' && observation.qualification === false, 'First-use dispatch/native identity differs');
  same(step.inputEvidence, observation.inputEvidence, 'First-use input evidence aliases differ'); same(step.nativeBracket, observation.bracket, 'First-use native input bracket differs');
  same(validateDiscreteInput(observation.inputEvidence, descriptor), observation.inputEvidence, 'First-use passive input does not replay');
  const checkedInput = observation.inputEvidence;
  same(step.missing, [], 'First-use input step has unresolved evidence');
  demand(step.nativeBracketVerified === false, 'First-use producer cannot self-verify native input');
  same(raw.discreteInput, {kind: 'browser-discrete-action-1', schemaVersion: 1, sessionId: descriptor.sessionId, actionId: descriptor.actionId, family: descriptor.family,
    automation: checkedInput.automation, steps: [step], inputMs: checkedInput.inputMs, clock: 'browser-performance', timeOrigin: checkedInput.timeOrigin,
    status: 'PASS', failures: [], missing: [], qualification: false}, 'First-use action aggregate differs from its replayed step');
  demand(raw.inputClock === checkedInput.clock && raw.inputTimeOrigin === checkedInput.timeOrigin && raw.inputMs === checkedInput.inputMs &&
    raw.discreteInput.clock === checkedInput.clock && raw.discreteInput.timeOrigin === checkedInput.timeOrigin && raw.discreteInput.inputMs === checkedInput.inputMs &&
    raw.discreteInput.sessionId === descriptor.sessionId && raw.discreteInput.actionId === descriptor.actionId && raw.discreteInput.family === descriptor.family,
  'First-use browser clock or session aliases differ');
  same(observation.publicWitness, {kind: 'public-first-use-ready-1', completed: true, feature, startMs: raw.startMs, readyMs: raw.readyMs,
    endMs: raw.endMs, captureStoppedMs: raw.captureStoppedMs, observationWindowMs: 1000, clock: 'runner-monotonic'}, 'First-use public witness differs from actual producer');
  const trace = json(await bytes(local(tracePin.path), tracePin, 128 * 1024 ** 2));
  if (trace.kind !== 'sanitized-chromium-trace-1' || trace.collection?.status !== 'complete' || trace.collection.completeEventReceived !== true || trace.collection.reasons?.length) return null;
  same(record.trace, {kind: 'browser-diagnostic-trace', sha256: tracePin.sha256, attributionComplete: false}, 'First-use diagnostic trace alias differs');
  same(producer.trace.collection, trace.collection, 'First-use trace closure differs');
  // The trace is retained diagnostic context, never a fabricated EventLatency
  // or native clock conversion. Actual browser input is replayed above.
  const runtime = json(await bytes('browser-runtime.json', null, 1024 ** 2));
  demand(runtime.headless === false && runtime.browserPid > 1 && runtime.engine === engine && isAbsolute(sourceRoot ?? '') &&
    typeof runtime.playwrightModule === 'string' && runtime.playwrightModule.startsWith(join(sourceRoot, 'node_modules') + sep), 'First-use owned headed browser/source unavailable');
  same(runtime.fixtureSeal, fixture?.seal ?? null, 'First-use browser fixture differs');
  demand(record.resetEvidence.browserPid === runtime.browserPid && record.resetEvidence.backendPid === runtime.backendPid, 'First-use fresh process witness differs');
  // Admission is derived from the already consumed immutable preparation state.
  // Without such bytes this bounded route remains unqualified, never guessed.
  if (!developerState || !developerStateIdentity) return null;
  demand(developerState.kind === 'developer-runtime-state-1' && pin(developerState.sha256) &&
    hash(Buffer.from(JSON.stringify(developerState.state, null, 2) + '\n')) === bare(developerState.sha256) && pin(developerStateIdentity.sha256), 'First-use consumed developer state differs');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build') && workspace.completed.includes('browser-cache');
  demand(completed && !workspace.failure && !workspace.active && workspace.source === sourceRoot && state.productRepo === sourceRoot && state.sourceDigest === subjectDigest,
    'First-use prepared source/browser state differs');
  const expectedCache = state.playwrightBrowsersPath ?? workspace.browserCache;
  demand(isAbsolute(expectedCache ?? '') && browserCache === expectedCache && runtime.executable?.startsWith(expectedCache + sep), 'First-use browser cache differs from consumed preparation');
  const prepared = workspace.browserIdentity?.engines?.filter(value => value.engine === engine);
  if (prepared?.length !== 1) return null;
  demand(prepared[0].executable === runtime.executable && prepared[0].version === runtime.version && prepared[0].revision === runtime.revision &&
    prepared[0].bytes === runtime.executableIdentity?.bytes && pin(prepared[0].sha256) && bare(prepared[0].sha256) === bare(runtime.executableIdentity?.sha256), 'First-use actual browser differs from prepared executable');
  const browserPin = tools?.browserPins?.browsers?.filter(value => value.name === engine);
  if (browserPin?.length !== 1) return null;
  demand(runtime.revision === browserPin[0].revision && runtime.version === browserPin[0].browserVersion, 'First-use actual browser differs from pinned tool revision');
  const registrations = retainedPaths.filter(path => new RegExp('^owned-process-' + runtime.browserPid + '-[a-f0-9-]{36}\\.json$').test(path));
  if (registrations.length !== 1) return null;
  const registration = json(await bytes(registrations[0], null, 65536)), browserProcess = registration.processes?.[0];
  demand(registration.kind === 'perf-owned-processes-1' && registration.ownerPid === workerPid && registration.processes?.length === 1 &&
    browserProcess.kind === 'browser' && browserProcess.pid === runtime.browserPid && integer(browserProcess.pgid) && browserProcess.pgid > 1 &&
    browserProcess.executable === runtime.executable && typeof browserProcess.startedAtIdentity === 'string' && browserProcess.startedAtIdentity.length > 0, 'First-use browser ownership differs');
  const backends = retainedPaths.filter(path => new RegExp('^owned-process-' + runtime.backendPid + '-[a-f0-9-]{36}\\.json$').test(path));
  if (backends.length !== 1) return null;
  const backendOwner = json(await bytes(backends[0], null, 65536)), backend = backendOwner.processes?.[0];
  demand(backendOwner.kind === 'perf-owned-processes-1' && backendOwner.ownerPid === workerPid && backendOwner.processes?.length === 1 &&
    backend.kind === 'backend' && backend.pid === runtime.backendPid && integer(backend.pgid) && backend.pgid > 1 &&
    typeof backend.startedAtIdentity === 'string' && backend.startedAtIdentity.length > 0, 'First-use backend ownership differs');
  const selected = nativeFirstUseConfiguration(configuration?.browser?.windowServerFirstUse, runtime); if (!selected) return null;
  const oracleFolder = 'oracle-' + actionId, binding = json(await bytes(oracleFolder + '/binding.json', null, 1024 ** 2));
  same(sanitize(binding), observation.binding, 'First-use binding differs from retained raw authority');
  demand(binding.kind === 'first-use-windowserver-input-binding-1' && binding.feature === feature && binding.nativeActionId === actionId, 'First-use binding scope differs');
  same(binding.descriptor, descriptor, 'First-use binding descriptor differs'); same(binding.browser, runtime, 'First-use actual runtime differs from binding');
  same(binding.config, selected.config, 'First-use native configuration differs'); same(binding.environment, selected.environment, 'First-use environment binding differs'); same(binding.build, selected.selection.build, 'First-use build pin differs');
  const collector = controlFiles?.filter(file => file.path === 'tooling/qualification/native/windowserver-capture.swift');
  demand(collector?.length === 1 && collector[0].bytes === binding.collectorSource?.bytes && bare(collector[0].sha256) === bare(binding.collectorSource?.sha256), 'First-use collector is not bound to control source');
  demand(Array.isArray(sourceFiles) && sourceFiles.some(file => file.path === 'src/ui/shell.ts' && pin(file.sha256)), 'First-use selected subject source is unavailable');
  const oraclePath = oracleFolder + '/oracle.json';
  demand(binding.oracle?.path === join(groupOutput, oraclePath) && bare(binding.oracle.sha256) === selected.selection.oracle.sha256, 'First-use oracle differs from consumed pin');
  const oracleBytes = await bytes(oraclePath, binding.oracle, 65536), oracle = json(oracleBytes), oraclePixels = new Map();
  demand(Array.isArray(binding.oracle.pixels) && binding.oracle.pixels.length === 2, 'First-use oracle pixel pins unavailable');
  for (const name of ['before.bgra', 'after.bgra']) {
    const identities = binding.oracle.pixels.filter(value => value.path === name); demand(identities.length === 1, 'First-use oracle pixel identity differs');
    oraclePixels.set(name, await bytes(oracleFolder + '/' + name, identities[0], 8 * 1024 ** 2));
  }
  validateFirstUseOracle(oracle, oraclePixels, {feature, selection: selected.selection, environment: selected.environment});

  const transaction = 'native-' + actionId, captureFolder = transaction + '/capture', processPin = observation.evidence.process?.receipt;
  demand(processPin?.path === join(groupOutput, transaction, 'process.json'), 'First-use native process receipt differs');
  const processRecord = json(await bytes(transaction + '/process.json', processPin, 1024 ** 2));
  const {receipt: ignored, ...reportedProcess} = observation.evidence.process;
  same(sanitize(processRecord), reportedProcess, 'First-use native process observation differs');
  if (processRecord.outcome !== 'CAPTURE_REPLAYED' || processRecord.failure || processRecord.cleanupErrors?.length || processRecord.requestedSignals?.length ||
    processRecord.exit?.code !== 0 || processRecord.exit.signal !== null || processRecord.close?.code !== 0 || processRecord.close.signal !== null) return null;
  demand(processRecord.kind === 'windowserver-owned-process-1' && processRecord.schemaVersion === 1, 'First-use process protocol differs');
  const processIdentity = processRecord.processIdentity;
  demand(processIdentity?.kind === 'windowserver' && processIdentity.ownerPid === workerPid && processIdentity.pid > 1 && processIdentity.pgid === processIdentity.pid &&
    typeof processIdentity.startedAtIdentity === 'string' && processIdentity.startedAtIdentity.length > 0, 'First-use collector ownership differs');
  same(observation.processIdentity, processIdentity, 'First-use collector identity alias differs');
  const owned = json(await bytes(local(processRecord.registration?.path), processRecord.registration, 65536));
  same(owned, {kind: 'perf-owned-processes-1', ownerPid: workerPid, processes: [{kind: 'windowserver', pid: processIdentity.pid, pgid: processIdentity.pgid,
    startedAtIdentity: processIdentity.startedAtIdentity, executable: processIdentity.executable}]}, 'First-use collector registration differs');
  const configPath = transaction + '/config.json'; demand(processRecord.config?.path === 'config.json', 'First-use config member differs');
  same(json(await bytes(configPath, processRecord.config, 8192)), selected.config, 'First-use retained config differs');
  same(processRecord.build, {...selected.selection.build, sourceSha256: bare(binding.collectorSource.sha256)}, 'First-use native build invocation differs');
  const buildEvidence = processRecord.buildEvidence;
  demand(buildEvidence?.path === 'build-evidence/manifest.json' && buildEvidence.sourceSha256 === bare(binding.collectorSource.sha256) && buildEvidence.receiptSha256 === selected.selection.build.receiptSha256, 'First-use retained build pin differs');
  for (const member of buildMembers) if (!paths.has(transaction + '/build-evidence/' + member)) unsupported('Missing retained native build member');
  await bytes(transaction + '/' + buildEvidence.path, buildEvidence, 128 * 1024 ** 2);
  const relocatedBuild = await resolveRetained(transaction + '/build-evidence/manifest.json');
  const build = await verifyWindowServerBuildEvidence({directory: dirname(relocatedBuild), manifestSha256: bare(buildEvidence.sha256), sourceSha256: buildEvidence.sourceSha256});
  demand(build.receiptSha256 === selected.selection.build.receiptSha256 && build.binarySha256 === buildEvidence.binarySha256 && processRecord.executable?.sha256 === buildEvidence.binarySha256, 'First-use executed binary differs from build');
  await bytes(transaction + '/build-evidence/windowserver-capture', processRecord.executable, 64 * 1024 ** 2);
  same(processRecord.command, [processIdentity.executable, join(groupOutput, configPath), join(groupOutput, captureFolder)], 'First-use native invocation differs');
  demand(processRecord.executable.path === processIdentity.executable && processIdentity.executable === join(dirname(processRecord.build.receiptPath), 'windowserver-capture') &&
    processRecord.outputDirectory === join(groupOutput, captureFolder), 'First-use native executable/output differs');
  demand(processRecord.stdout?.path === 'stdout.ndjson' && processRecord.stderr?.path === 'stderr.log' && processRecord.manifest?.path === 'capture/manifest.json', 'First-use native artifact paths differ');
  const stdout = await bytes(transaction + '/stdout.ndjson', processRecord.stdout, 8 * 1024 ** 2 + 65536), stderr = await bytes(transaction + '/stderr.log', processRecord.stderr, 1024 ** 2);
  same(processRecord.streamBytesObserved, {stdout: stdout.length, stderr: stderr.length}, 'First-use native stream counts differ');
  const manifestBytes = await bytes(captureFolder + '/manifest.json', processRecord.manifest, 2 * 1024 ** 2), manifest = json(manifestBytes);
  same(manifest.config, selected.config, 'First-use capture config differs from actual invocation');
  same(observation.evidence.manifest, {path: join(groupOutput, captureFolder, 'manifest.json'), bytes: manifestBytes.length, sha256: hash(manifestBytes)}, 'First-use manifest pin differs');
  const framesBytes = await bytes(captureFolder + '/frames.ndjson', manifest.frames, 8 * 1024 ** 2);
  const decodeRows = value => {const text = new TextDecoder('utf-8', {fatal: true}).decode(value); demand(text.endsWith('\n'), 'First-use native NDJSON is incomplete');
    return text.slice(0, -1).split('\n').map(line => {demand(line.length > 0 && Buffer.byteLength(line) <= 16384, 'First-use native line bound exceeded'); return JSON.parse(line);});};
  const records = decodeRows(framesBytes), controlRows = decodeRows(stdout);
  demand(records.length <= selected.config.maxFrames + 256 && controlRows.length <= selected.config.maxFrames + 258, 'First-use native record bound exceeded');
  const ready = controlRows.filter(row => row.event === 'ready'), stopped = controlRows.filter(row => row.event === 'stopped');
  if (ready.length !== 1 || stopped.length !== 1 || controlRows.at(-1) !== stopped[0]) return null;
  same(ready[0], observation.ready, 'First-use ready alias differs'); validateWindowServerReady(ready[0], {config: selected.config, outputDirectory: join(groupOutput, captureFolder)});
  for (const key of ['config', 'display', 'captureGeometry', 'windowAdmission', 'timebase', 'startedMach']) same(ready[0][key], manifest[key], 'First-use native ready/capture differs: ' + key);
  same(ready[0].display, oracle.display, 'First-use native display differs from oracle');
  same(stopped[0], {schemaVersion: 1, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'}, 'First-use native stop differs');
  same(controlRows.filter(row => !['ready', 'stopped'].includes(row.event)), records.filter(row => row.event === 'clock' || row.event === 'sample' && row.retained === true), 'First-use native stdout differs from retained records');
  const pixels = new Map(); demand(Array.isArray(manifest.pixelFiles) && manifest.pixelFiles.length <= selected.config.maxFrames, 'First-use pixel inventory unavailable');
  let pixelBytes = 0;
  for (const member of manifest.pixelFiles) {
    demand(/^frame-[1-9][0-9]*\.bgra$/.test(member.path) && !pixels.has(member.path) && member.bytes === selected.config.roi.width * selected.config.roi.height * 4, 'First-use pixel member differs');
    pixelBytes += member.bytes; demand(pixelBytes <= selected.config.maxBytes, 'First-use pixel budget exceeded');
    pixels.set(member.path, await bytes(captureFolder + '/' + member.path, member, selected.config.maxBytes));
  }
  same(retainedPaths.filter(path => path.startsWith(captureFolder + '/')).sort(), [captureFolder + '/manifest.json', captureFolder + '/frames.ndjson', ...manifest.pixelFiles.map(member => captureFolder + '/' + member.path)].sort(), 'First-use native capture membership differs');
  const capture = verifyWindowServerCapture({manifestBytes, framesBytes, pixels}, {manifestSha256: hash(manifestBytes)});
  const joined = joinFirstUseWindowServerPixels(capture, {oracleBytes, oraclePixels, oracleSha256: selected.selection.oracle.sha256, feature,
    expectedDescriptor: descriptor, inputEvidence: checkedInput, bracket: observation.bracket,
    binding: {fixtureSha256: binding.environment.fixtureSha256, browserEnvironmentSha256: binding.environment.browserEnvironmentSha256,
      browserPid: runtime.browserPid, windowNumber: ready[0].windowAdmission.windowNumber}});
  same(sanitize(joined), observation.join, 'First-use native pixel join cannot be reproduced');
  if (joined.status !== 'observed') return null;
  const byOrdinal = new Map(records.filter(row => row.event === 'sample').map(row => [row.ordinal, row]));
  same(observation.baseline, byOrdinal.get(observation.baseline?.ordinal), 'First-use baseline is not retained');
  demand(observation.baseline.sha256 === oracle.before.sha256 && BigInt(observation.baseline.callbackMach) <= BigInt(observation.bracket.before.mach), 'First-use baseline did not precede input');
  const clocks = controlRows.filter(row => row.event === 'clock'), anchor = observation.windowStartAnchor, readyWitness = observation.readinessWitness;
  same(readyWitness ?? null, raw.nativeReadiness ?? null, 'First-use ready callback differs from native consumer witness');
  const expectedClocks = [];
  if (anchor?.status === 'complete') {
    demand(anchor.kind === 'first-use-native-window-anchor-1' && anchor.nativeActionId === actionId && anchor.relation === 'ack-before-driver-window-start' && anchor.ack?.id === actionId + '-win-before', 'First-use window anchor differs');
    same(anchor.descriptor, descriptor, 'First-use anchor input identity differs'); expectedClocks.push(anchor.ack);
    demand(BigInt(anchor.ack.mach) <= BigInt(observation.bracket.before.mach), 'First-use native window anchor follows input');
  }
  expectedClocks.push(observation.bracket.before, observation.bracket.after);
  let readiness = null;
  if (readyWitness?.status === 'complete') {
    demand(readyWitness.kind === 'first-use-native-ready-1' && readyWitness.nativeActionId === actionId && readyWitness.clock === 'runner-monotonic' &&
      readyWitness.ack?.id === actionId + '-ready' && readyWitness.callerReadyMs === raw.readyMs && readyWitness.windowStartMs === raw.startMs && readyWitness.windowEndMs === raw.endMs &&
      finite(readyWitness.requestRunnerMs) && finite(readyWitness.receivedRunnerMs) && raw.readyMs <= readyWitness.requestRunnerMs &&
      readyWitness.requestRunnerMs <= readyWitness.receivedRunnerMs && readyWitness.receivedRunnerMs <= raw.captureStoppedMs, 'First-use native readiness is not the actual public-ready callback');
    same(readyWitness.descriptor, descriptor, 'First-use readiness identity differs'); expectedClocks.push(readyWitness.ack);
    demand(BigInt(readyWitness.ack.mach) >= BigInt(observation.bracket.after.mach), 'First-use readiness ACK precedes completed input');
    const windowUpperBoundMs = anchor?.status === 'complete' ? nativeUpper(anchor.ack.mach, readyWitness.ack.mach, manifest.timebase) : null;
    readiness = {upperBoundMs: nativeUpper(observation.bracket.before.mach, readyWitness.ack.mach, manifest.timebase), ceilingMs: 750, targetMs: 250,
      endpoint: 'public-control-ready-following-native-ACK', withinWindow: windowUpperBoundMs !== null && windowUpperBoundMs <= 1000, windowUpperBoundMs};
  }
  same(clocks, expectedClocks, 'First-use actual native clock stream differs from its window/input/readiness brackets');
  const windowUpperBoundMs = anchor?.status === 'complete' ? nativeUpper(anchor.ack.mach, joined.observedDisplayTimeMach, manifest.timebase) : null;
  const value = {acknowledgement: {upperBoundMs: joined.firstMeaningfulPaintUpperBoundMs, ceilingMs: 100, targetMs: 50, endpoint: 'WindowServer-presented-pixels',
    withinWindow: windowUpperBoundMs !== null && windowUpperBoundMs <= 1000, windowUpperBoundMs}, readiness, exactLatency: false};
  const proof = Object.freeze({kind: 'verified-first-use-windowserver-bounds-1', qualification: false});
  proofs.set(proof, {attemptId: attempt.id, producerId: record.id, cache: attempt.cache, ordinal: attempt.ordinal, record: structuredClone(comparable(record)), value});
  return proof;
}

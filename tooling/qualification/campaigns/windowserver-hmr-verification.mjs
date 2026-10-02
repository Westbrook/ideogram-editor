import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {validateWindowServerReady, verifyWindowServerCapture, joinHmrWindowServerPixels} from './windowserver-presentation.mjs';
import {verifyWindowServerBuildEvidence} from '../native/windowserver-build.mjs';
import {nativeHmrConfiguration, validateHmrOracle} from './windowserver-hmr.mjs';
import {fixedHmrEdit, hotUpdateWitness} from './browser-hmr.mjs';
import {presentationClockBounds} from './browser-presentation.mjs';
import {sanitizeTraceEvent} from './browser-trace.mjs';
import {normalizeResult} from './worker.mjs';
import {sanitize} from './common.mjs';

const proofs = new WeakMap();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const bare = value => typeof value === 'string' ? value.replace(/^sha256:/, '') : value;
const pin = value => typeof bare(value) === 'string' && /^[a-f0-9]{64}$/.test(bare(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const json = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const buildMembers = ['manifest.json', 'build-receipt.json', 'collector.swift', 'sdk-manifest.json', 'version.stdout.log', 'version.stderr.log', 'build.stdout.log', 'build.stderr.log', 'windowserver-capture'];

/** Add only the native HMR raw closure and original source backup to the normal
 * metadata inventory. Unrelated fixture, raster and browser-profile trees keep
 * their existing independent seals. Paths are relative to the campaign root. */
export function isCampaignEvidencePath(path) {
  return /\.(?:json|jsonl|log|txt)$/.test(path) ||
    /(?:^|\/)native-hmr-[1-9][0-9]*\/(?:stdout\.ndjson|capture\/(?:frames\.ndjson|frame-[1-9][0-9]*\.bgra)|build-evidence\/(?:collector\.swift|windowserver-capture))$/.test(path) ||
    /(?:^|\/)native-wordmark-oracle\/(?:before|after)\.bgra$/.test(path) ||
    /(?:^|\/)hmr-original-[a-f0-9-]{36}\.ts$/.test(path);
}

function comparable(record) {
  return Object.fromEntries(['savedMs', 'presentedMs', 'documentPreserved', 'reload', 'trace', 'outcome', 'windowServerPresentation'].map(key => [key, record?.[key]]));
}

/** Only this module's successful raw replay mints a token. Serialized receipt
 * labels, copied tokens and caller-supplied upperBoundMs cannot satisfy D05. */
export function readVerifiedHmrCeiling(proof, record) {
  const entry = proofs.get(proof);
  if (!entry || !record || (record.producerId !== undefined ? record.id !== entry.attemptId || record.producerId !== entry.producerId : record.id !== entry.producerId) ||
    !isDeepStrictEqual(comparable(record), entry.record)) return null;
  return {...entry.value};
}

/** Replay only through the calling campaign's sealed, relocated evidence tree.
 * resolveRetained resolves an already sealed ordinary member; no historical
 * build/compiler/SDK/source absolute path is reopened. */
export async function verifyHmrWindowServerEvidence({attempt, configuration, groupOutput, retainedPaths, readRetained, resolveRetained, controlFiles, sourceFiles, fixture, workerPid, sourceRoot, engine, developerState, developerStateIdentity, subjectDigest}) {
  const result = attempt?.result, edit = result?.hotEdit, observation = edit?.windowServerPresentation;
  if (!observation) return null;
  // Known product failures remain failures without requiring a timing proof.
  if (result.status === 'FAIL' || edit.outcome !== 'expected' || edit.documentPreserved !== true || edit.reload !== false) return null;
  if (observation.join?.status !== 'observed' || !observation.evidence || observation.missing?.length || observation.failures?.length) {
    demand(result.status !== 'PASS', 'Passing native HMR result lacks its closed observed endpoint'); return null;
  }
  demand(typeof attempt.id === 'string' && isAbsolute(groupOutput) && resolve(groupOutput) === groupOutput && Array.isArray(retainedPaths) && integer(workerPid) && workerPid > 1, 'Native HMR replay ownership unavailable');
  const paths = new Set(retainedPaths);
  function local(path) {
    demand(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path.startsWith(groupOutput + sep), 'Native HMR reference leaves its original group');
    const value = relative(groupOutput, path).split(sep).join('/'); demand(paths.has(value), 'Native HMR reference is not sealed'); return value;
  }
  async function bytes(path, identity, maximum) {
    demand(paths.has(path), 'Required native HMR member is not sealed: ' + path);
    if (identity) demand(integer(identity.bytes) && identity.bytes <= maximum && pin(identity.sha256), 'Invalid native HMR artifact identity');
    const value = await readRetained(path, {maximum});
    demand(Buffer.isBuffer(value) && value.length <= maximum, 'Native HMR member exceeds its bound');
    if (identity) demand(value.length === identity.bytes && hash(value) === bare(identity.sha256), 'Native HMR member differs from its pin');
    return value;
  }
  demand(/^hmr-[1-9][0-9]*$/.test(edit.id), 'Native HMR producer identity unavailable');
  const producerPath = 'hmr-update-' + edit.id.slice(4) + '.json', producerPin = result.evidence?.receipt;
  demand(producerPin?.path === join(groupOutput, producerPath), 'Native HMR producer receipt path differs');
  const producer = json(await bytes(producerPath, producerPin, 8 * 1024 ** 2));
  demand(!Object.hasOwn(producer.evidence ?? {}, 'receipt'), 'HMR producer receipt contains a recursive self-pin');
  const normalized = normalizeResult({...producer, evidence: {...producer.evidence, receipt: producerPin}}, attempt.startMs, attempt.endMs);
  same(normalized, result, 'HMR attempt differs from its retained producer observation');
  const runtime = result.evidence?.runtime, source = result.evidence?.source;
  demand(runtime?.headless === false && runtime.browserPid > 1 && runtime.engine === engine && runtime.sourceRoot === sourceRoot && isAbsolute(sourceRoot ?? ''), 'Native HMR requires its owned headed browser and prepared product');
  same(await bytes('hmr-runtime.json', null, 1024 ** 2).then(json), runtime, 'Native HMR runtime differs from retained observation');
  demand(developerState?.kind === 'developer-runtime-state-1' && pin(developerState.sha256) &&
    hash(Buffer.from(JSON.stringify(developerState.state, null, 2) + '\n')) === bare(developerState.sha256) &&
    source?.developerState?.path === developerStateIdentity?.path && pin(developerStateIdentity?.sha256) &&
    bare(source.developerState.sha256) === bare(developerStateIdentity.sha256), 'Native HMR developer state differs from consumed input');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build');
  demand(completed && !workspace.failure && !workspace.active && workspace.source === sourceRoot && isAbsolute(workspace.workspace ?? '') &&
    join(workspace.workspace, 'source') === sourceRoot && state.productRepo === sourceRoot && state.sourceDigest === subjectDigest && state.buildProvenancePath,
  'Native HMR developer state does not identify the completed prepared source');
  same(source.browserCache, {path: workspace.browserCache, sha256: workspace.browserIdentity?.cache?.sha256 ?? null, engines: workspace.browserIdentity?.engines ?? []}, 'Native HMR browser identity differs from consumed developer state');
  const browserCache = source?.browserCache, browserEngines = browserCache?.engines?.filter(value => value.engine === runtime.engine);
  demand(isAbsolute(browserCache?.path ?? '') && pin(browserCache?.sha256) && runtime.browserCache?.path === browserCache.path &&
    bare(runtime.browserCache?.sha256) === bare(browserCache.sha256) && browserEngines?.length === 1, 'Native HMR prepared browser cache differs');
  const preparedBrowser = browserEngines[0];
  demand(preparedBrowser.executable === runtime.executable && preparedBrowser.version === runtime.version && preparedBrowser.revision === runtime.revision &&
    integer(preparedBrowser.bytes) && preparedBrowser.bytes > 0 && pin(preparedBrowser.sha256) && runtime.executableIdentity?.bytes === preparedBrowser.bytes &&
    bare(runtime.executableIdentity?.sha256) === bare(preparedBrowser.sha256), 'Native HMR executable differs from the prepared browser');
  const selected = nativeHmrConfiguration(configuration?.windowServerPresentation, runtime);
  demand(selected, 'Native HMR observation lacks its consumed configuration');
  const bindingPath = 'native-wordmark-oracle/binding.json', binding = await bytes(bindingPath, null, 1024 ** 2).then(json);
  // Campaign journals deliberately redact any property named pixels. Replay
  // its ordinary retained binding to recover the pinned pixel identities, and
  // require the serialized observation to match the same sanitizer projection.
  same(sanitize(binding), observation.binding, 'Native HMR input binding differs from retained bytes');
  same(binding.sourceIdentity, source, 'Native HMR source binding differs'); same(binding.config, selected.config, 'Native HMR collector config differs');
  same(binding.build, selected.selection.build, 'Native HMR build pin differs');
  const browserKeys = ['engine', 'version', 'revision', 'executable', 'executableIdentity', 'browserCache', 'sourceRoot', 'fixtureSeal', 'viewport', 'deviceScaleFactor'];
  same(binding.browser, {pid: runtime.browserPid, ...Object.fromEntries(browserKeys.map(key => [key, runtime[key]]))}, 'Native HMR browser binding differs');
  same(runtime.fixtureSeal, fixture?.seal ?? null, 'Native HMR fixture differs from selected fixture');
  const browserRegistrations = retainedPaths.filter(path => new RegExp('^owned-process-' + runtime.browserPid + '-[a-f0-9-]{36}\\.json$').test(path));
  demand(browserRegistrations.length === 1, 'Owned HMR browser registration is unavailable or ambiguous');
  const browserRegistration = json(await bytes(browserRegistrations[0], null, 65536));
  demand(browserRegistration.kind === 'perf-owned-processes-1' && browserRegistration.ownerPid === workerPid && browserRegistration.processes?.length === 1, 'HMR browser registration differs from the worker');
  const browserProcess = browserRegistration.processes[0];
  demand(browserProcess.kind === 'browser' && browserProcess.pid === runtime.browserPid && integer(browserProcess.pgid) && browserProcess.pgid > 1 &&
    browserProcess.executable === runtime.executable && typeof browserProcess.startedAtIdentity === 'string' && browserProcess.startedAtIdentity.length > 0, 'HMR browser process differs from the actual owned browser');
  demand(runtime.sourceRoot && source?.sourcePath === 'src/ui/shell-wordmark.ts', 'Native HMR source scope unavailable');
  const collector = controlFiles?.filter(file => file.path === 'tooling/qualification/native/windowserver-capture.swift');
  demand(collector?.length === 1 && collector[0].bytes === binding.collectorSource?.bytes && bare(collector[0].sha256) === bare(binding.collectorSource?.sha256), 'Collector source is not bound to trusted control source');
  const original = sourceFiles?.filter(file => file.path === source.sourcePath);
  demand(original?.length === 1 && original[0].bytes === source.original?.bytes && bare(original[0].sha256) === bare(source.original?.sha256), 'HMR original differs from the retained subject source');
  const originals = retainedPaths.filter(path => /^hmr-original-[a-f0-9-]{36}\.ts$/.test(path));
  demand(originals.length === 1, 'HMR original backup is missing or ambiguous');
  const originalBytes = await bytes(originals[0], source.original, 4 * 1024 ** 2), changed = fixedHmrEdit(originalBytes);
  demand(changed.length === source.changed?.bytes && hash(changed) === bare(source.changed?.sha256), 'HMR changed source differs from the actual fixed edit');
  const publicObservation = result.observations;
  demand(['cold', 'warm'].includes(attempt.cache) && Number.isSafeInteger(attempt.ordinal) && attempt.ordinal > 0 && typeof attempt.prime === 'boolean' &&
    publicObservation.cache === attempt.cache && publicObservation.ordinal === attempt.ordinal && publicObservation.prime === attempt.prime &&
    publicObservation.firstUpdate === false && publicObservation.scored === !attempt.prime, 'HMR producer is not the scheduled scored/prime update');
  const transactionPhases = result.phases?.filter(phase => phase.name === 'developer.hot-update-transaction');
  demand(transactionPhases?.length === 1, 'Actual HMR transaction phase is unavailable');
  const transactionPhase = transactionPhases[0];
  demand(Number.isFinite(attempt.startMs) && attempt.startMs >= 0 && Number.isFinite(attempt.endMs) && transactionPhase.clock === 'runner-monotonic' &&
    Number.isFinite(transactionPhase.startMs) && Number.isFinite(transactionPhase.endMs) && attempt.startMs <= transactionPhase.startMs &&
    transactionPhase.startMs <= publicObservation.saved?.startMs && publicObservation.saved.startMs <= publicObservation.saved.savedMs &&
    publicObservation.saved.savedMs <= transactionPhase.endMs && transactionPhase.endMs <= attempt.endMs &&
    transactionPhase.durationMs === transactionPhase.endMs - transactionPhase.startMs, 'HMR actual save/transaction is outside its scheduled attempt');
  same(publicObservation.windowServerPresentation, observation, 'HMR native observation aliases disagree');
  const preserved = hotUpdateWitness(publicObservation.before, publicObservation.after);
  demand(publicObservation.before.documentId === fixture?.documentId && preserved.documentPreserved && !preserved.reload, 'HMR public document witness differs');
  hotUpdateWitness(publicObservation.before, publicObservation.restoredAfter, {restored: true});
  same(publicObservation.saved?.nativePresentationBracket, observation.bracket, 'HMR native clock bracket differs from actual save');
  const restoration = publicObservation.restoration;
  demand(restoration?.restored === true && restoration.path === source.sourcePath && restoration.bytes === originalBytes.length && bare(restoration.sha256) === hash(originalBytes) && restoration.mode === source.original.mode, 'HMR source was not restored');
  demand(edit.id === observation.actionId && /^hmr-[1-9][0-9]*$/.test(edit.id) && publicObservation.id === edit.id && edit.presentedMs === null && publicObservation.presentedMs === null &&
    Number.isFinite(edit.savedMs) && edit.savedMs === publicObservation.saved.savedMs && publicObservation.saved.clock === 'runner-monotonic' &&
    Number.isFinite(publicObservation.saved.startMs) && publicObservation.saved.startMs >= 0 && publicObservation.saved.startMs <= edit.savedMs, 'HMR endpoint/actual-save identity differs');
  same(edit.trace, publicObservation.trace, 'HMR trace aliases differ');
  demand(edit.trace?.kind === 'browser-metadata-trace' && pin(edit.trace.sha256), 'Native HMR lacks browser trace evidence');
  const trace = json(await bytes(local(edit.trace.path), edit.trace, 128 * 1024 ** 2));
  const browserBracket = publicObservation.saved.presentationBracket, traceBounds = presentationClockBounds(trace, browserBracket);
  if (traceBounds.status !== 'bounded') return null;
  demand(trace.kind === 'sanitized-chromium-trace-1' && browserBracket.id === Number(edit.id.slice(4)) && browserBracket.browserTimeOrigin === publicObservation.before.timeOrigin, 'HMR browser trace bracket differs from actual edit');
  const marks = trace.events.map(sanitizeTraceEvent).filter(event => event?.name === 'product-mark' && event.id === browserBracket.id);
  const intents = marks.filter(event => event.kind === 'intent'), completions = marks.filter(event => event.kind === 'complete');
  if (intents.length !== 1 || completions.length !== 1) return null;
  const clockMarks = trace.events.map(sanitizeTraceEvent).filter(event => event?.name === 'presentation-clock-mark' && event.markId === browserBracket.id);
  demand(clockMarks.length === 2 && clockMarks.every(event => event.pid === intents[0].pid && event.tid === intents[0].tid), 'HMR app and save-clock marks use different renderer lanes');
  demand(intents[0].pid === completions[0].pid && intents[0].tid === completions[0].tid && intents[0].ts <= traceBounds.earliestUs && traceBounds.latestUs <= completions[0].ts, 'HMR app task marks do not enclose the actual save bracket');

  const oraclePath = 'native-wordmark-oracle/oracle.json';
  demand(binding.oracle?.path === join(groupOutput, oraclePath) && bare(binding.oracle.sha256) === selected.selection.oracle.sha256, 'HMR oracle differs from consumed pin');
  const oracleBytes = await bytes(oraclePath, binding.oracle, 65536), oracle = json(oracleBytes), oraclePixels = new Map();
  demand(Array.isArray(binding.oracle.pixels) && binding.oracle.pixels.length === 2, 'HMR oracle pixel identities unavailable');
  for (const name of ['before.bgra', 'after.bgra']) {
    const identities = binding.oracle.pixels.filter(value => value.path === name); demand(identities.length === 1, 'HMR oracle member is missing or duplicated');
    oraclePixels.set(name, await bytes('native-wordmark-oracle/' + name, identities[0], 8 * 1024 ** 2));
  }
  validateHmrOracle(oracle, oraclePixels, {selection: selected.selection, sourceIdentity: source});

  const transaction = 'native-' + edit.id, captureFolder = transaction + '/capture';
  const processPin = observation.evidence.process?.receipt;
  demand(processPin?.path === join(groupOutput, transaction, 'process.json'), 'Native process receipt path differs');
  const processRecord = json(await bytes(transaction + '/process.json', processPin, 1024 ** 2));
  const {receipt: ignored, ...reportedProcess} = observation.evidence.process;
  same(reportedProcess, processRecord, 'Native process observation differs from sealed receipt');
  demand(processRecord.kind === 'windowserver-owned-process-1' && processRecord.schemaVersion === 1 && processRecord.outcome === 'CAPTURE_REPLAYED' && processRecord.failure === null &&
    Array.isArray(processRecord.cleanupErrors) && processRecord.cleanupErrors.length === 0 && Array.isArray(processRecord.requestedSignals) && processRecord.requestedSignals.length === 0 &&
    processRecord.exit?.code === 0 && processRecord.exit.signal === null && processRecord.close?.code === 0 && processRecord.close.signal === null, 'Native process did not close successfully');
  const processIdentity = processRecord.processIdentity;
  demand(processIdentity?.kind === 'windowserver' && processIdentity.ownerPid === workerPid && processIdentity.pid > 1 && processIdentity.pgid === processIdentity.pid && typeof processIdentity.startedAtIdentity === 'string', 'Native process ownership differs');
  same(observation.processIdentity, processIdentity, 'Native process identity alias differs');
  demand(processRecord.registration?.path && /^owned-process-[1-9][0-9]*-[a-f0-9-]{36}\.json$/.test(relative(groupOutput, processRecord.registration.path)), 'Native process registration unavailable');
  const registration = json(await bytes(local(processRecord.registration.path), processRecord.registration, 65536));
  same(registration, {kind: 'perf-owned-processes-1', ownerPid: workerPid, processes: [{kind: 'windowserver', pid: processIdentity.pid, pgid: processIdentity.pgid, startedAtIdentity: processIdentity.startedAtIdentity, executable: processIdentity.executable}]}, 'Native process registration differs');
  const configPath = transaction + '/config.json';
  demand(processRecord.config?.path === 'config.json', 'Native process config member differs');
  same(json(await bytes(configPath, processRecord.config, 8192)), selected.config, 'Native retained config differs');
  same(processRecord.build, {...selected.selection.build, sourceSha256: bare(binding.collectorSource.sha256)}, 'Native build invocation pin differs');
  const buildEvidence = processRecord.buildEvidence;
  demand(buildEvidence?.path === 'build-evidence/manifest.json' && buildEvidence.sourceSha256 === bare(binding.collectorSource.sha256) && buildEvidence.receiptSha256 === selected.selection.build.receiptSha256, 'Native retained build identity differs');
  for (const member of buildMembers) demand(paths.has(transaction + '/build-evidence/' + member), 'Retained native build member lacks campaign seal');
  await bytes(transaction + '/' + buildEvidence.path, buildEvidence, 128 * 1024 ** 2);
  const relocatedBuildManifest = await resolveRetained(transaction + '/build-evidence/manifest.json');
  const retainedBuild = await verifyWindowServerBuildEvidence({directory: dirname(relocatedBuildManifest), manifestSha256: bare(buildEvidence.sha256), sourceSha256: buildEvidence.sourceSha256});
  demand(retainedBuild.receiptSha256 === selected.selection.build.receiptSha256 && retainedBuild.binarySha256 === buildEvidence.binarySha256 && processRecord.executable?.sha256 === buildEvidence.binarySha256, 'Executed binary differs from retained native build');
  await bytes(transaction + '/build-evidence/windowserver-capture', processRecord.executable, 64 * 1024 ** 2);
  demand(processRecord.command?.length === 3 && processRecord.command[0] === processRecord.executable.path && processRecord.command[0] === processIdentity.executable &&
    processRecord.command[0] === join(dirname(processRecord.build.receiptPath), 'windowserver-capture') && processRecord.command[1] === join(groupOutput, configPath) &&
    processRecord.command[2] === join(groupOutput, captureFolder) && processRecord.outputDirectory === join(groupOutput, captureFolder), 'Native invocation source/output binding differs');

  demand(processRecord.stdout?.path === 'stdout.ndjson' && processRecord.stderr?.path === 'stderr.log' && processRecord.manifest?.path === 'capture/manifest.json', 'Native process artifact paths differ');
  const stdout = await bytes(transaction + '/stdout.ndjson', processRecord.stdout, 8 * 1024 ** 2 + 65536);
  const stderr = await bytes(transaction + '/stderr.log', processRecord.stderr, 1024 ** 2);
  same(processRecord.streamBytesObserved, {stdout: stdout.length, stderr: stderr.length}, 'Native observed stream counts differ');
  const manifestBytes = await bytes(captureFolder + '/manifest.json', processRecord.manifest, 2 * 1024 ** 2), manifest = json(manifestBytes);
  same(observation.evidence.manifest, {path: join(groupOutput, captureFolder, 'manifest.json'), bytes: manifestBytes.length, sha256: hash(manifestBytes)}, 'Returned native manifest pin differs');
  const framesBytes = await bytes(captureFolder + '/frames.ndjson', manifest.frames, 8 * 1024 ** 2);
  const decodeRows = value => {const text = new TextDecoder('utf-8', {fatal: true}).decode(value); demand(text.endsWith('\n'), 'Native NDJSON tail is incomplete'); return text.slice(0, -1).split('\n').map(line => {demand(line.length > 0 && Buffer.byteLength(line) <= 16384, 'Native NDJSON line bound exceeded'); return JSON.parse(line);});};
  const records = decodeRows(framesBytes), controlRows = decodeRows(stdout);
  demand(records.length <= selected.config.maxFrames + 256 && controlRows.length <= selected.config.maxFrames + 258, 'Native record count exceeded');
  const clocks = controlRows.filter(row => row.event === 'clock');
  same(clocks, [observation.bracket?.before, observation.bracket?.after], 'Native stdout ACKs differ from actual save bracket');
  const ready = controlRows.filter(row => row.event === 'ready'), stopped = controlRows.filter(row => row.event === 'stopped');
  demand(ready.length === 1 && stopped.length === 1 && controlRows.at(-1) === stopped[0], 'Native ready/stopped closure is unavailable');
  same(ready[0], observation.ready, 'Native ready alias differs');
  validateWindowServerReady(ready[0], {config: selected.config, outputDirectory: join(groupOutput, captureFolder)});
  for (const name of ['config', 'display', 'captureGeometry', 'windowAdmission', 'timebase', 'startedMach']) same(manifest[name], ready[0][name], 'Native ready/manifest identity differs: ' + name);
  same(stopped[0], {schemaVersion: 1, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'}, 'Native stopped record differs from manifest');
  same(controlRows.filter(row => !['ready', 'stopped'].includes(row.event)), records.filter(row => row.event === 'clock' || row.event === 'sample' && row.retained === true), 'Native stdout differs from retained frames');
  demand(controlRows.indexOf(ready[0]) < controlRows.indexOf(clocks[0]), 'Native save clock preceded ready');
  const pixels = new Map(); demand(Array.isArray(manifest.pixelFiles) && manifest.pixelFiles.length <= selected.config.maxFrames, 'Native pixel inventory unavailable');
  let pixelBytes = 0;
  for (const member of manifest.pixelFiles) {
    demand(/^frame-[1-9][0-9]*\.bgra$/.test(member.path) && !pixels.has(member.path) && member.bytes === selected.config.roi.width * selected.config.roi.height * 4, 'Native pixel member is unsafe or duplicated');
    pixelBytes += member.bytes; demand(pixelBytes <= selected.config.maxBytes, 'Native retained pixel budget exceeded');
    pixels.set(member.path, await bytes(captureFolder + '/' + member.path, member, selected.config.maxBytes));
  }
  same(retainedPaths.filter(path => path.startsWith(captureFolder + '/')).sort(), [captureFolder + '/manifest.json', captureFolder + '/frames.ndjson', ...manifest.pixelFiles.map(member => captureFolder + '/' + member.path)].sort(), 'Native capture membership differs');
  const capture = verifyWindowServerCapture({manifestBytes, framesBytes, pixels}, {manifestSha256: hash(manifestBytes)});
  const joined = joinHmrWindowServerPixels(capture, {oracleBytes, oraclePixels, oracleSha256: selected.selection.oracle.sha256, sourceIdentity: source, bracket: observation.bracket});
  same(joined, observation.join, 'Native HMR upper bound cannot be reproduced');
  demand(joined.status === 'observed' && edit.presentedMs === null, 'Native HMR exact-time substitute is forbidden');
  const byOrdinal = new Map(records.filter(row => row.event === 'sample').map(row => [row.ordinal, row]));
  same(observation.baseline, byOrdinal.get(observation.baseline?.ordinal), 'Native baseline is not retained');
  same(observation.target, byOrdinal.get(observation.target?.ordinal), 'Native target is not retained');
  demand(observation.baseline.sha256 === oracle.before.sha256 && observation.target.sha256 === oracle.after.sha256 && BigInt(observation.baseline.callbackMach) <= BigInt(observation.bracket.before.mach) && BigInt(observation.target.displayTimeMach) >= BigInt(observation.bracket.after.mach), 'Native pre-save baseline/post-save target wait differs');
  const proof = Object.freeze({kind: 'verified-hmr-windowserver-ceiling-1', qualification: false});
  proofs.set(proof, {attemptId: attempt.id, producerId: edit.id, record: structuredClone(comparable(edit)), value: {upperBoundMs: joined.firstCorrectPaintUpperBoundMs, ceilingMs: 500, endpoint: 'WindowServer-presented-pixels'}});
  return proof;
}

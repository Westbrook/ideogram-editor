import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {validateWindowServerSessionReady, verifyWindowServerSessionCapture, getWindowServerSessionObservations} from './windowserver-session.mjs';
import {verifySessionEvidenceAdmission, verifySessionEvidenceFinalSample} from './windowserver-session-budget.mjs';
import {validateWindowServerSessionLosslessReady, verifyWindowServerSessionLosslessCapture, getWindowServerSessionLosslessObservations} from './windowserver-session-lossless.mjs';
import {verifySessionLosslessEvidenceAdmission, verifySessionLosslessEvidenceFinalSample} from './windowserver-session-lossless-budget.mjs';
import {replayPackedGenericOracle} from './generic-oracle-lossless.mjs';
import {genericNativeConfiguration, genericOracleInventory} from './windowserver-generic-actions.mjs';
import {GENERIC_PROFILE, genericSessionNativeId, projectGenericInteraction, genericRawFeedbackCohort} from './browser-generic-input.mjs';
import {joinGenericActionPixels, joinGenericActionLosslessPixels} from './generic-action-oracle.mjs';
import {planStrokeCoordinates, validateRecordedStroke} from './browser-gesture-state.mjs';
import {brushCorpus} from './fixtures.mjs';
import {interactionSession, genericRawFeedbackSelection} from './browser.mjs';
import {rawDisplayFeedbackChunks} from './browser-trace-raw.mjs';
import {analyzeDisplayFeedbackTrace} from './display-feedback.mjs';
import {verifyWindowServerBuildEvidence} from '../native/windowserver-build.mjs';
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
const unavailable = message => {throw Object.assign(Error(message), {code: 'SESSION_REPLAY_UNAVAILABLE'});};

/** Finite raw closure. Ordinary JSON/log evidence already belongs to the
 * campaign inventory. Pixel containers have a separately versioned replay. */
export function isSessionNativeEvidencePath(path) {
  if (/(?:^|\/)native-gis-[a-f0-9]{48}\/(?:stdout\.ndjson|capture\/(?:frames\.ndjson|frame-[1-9][0-9]{0,3}\.bgra|pixels\.bin)|build-evidence\/(?:collector\.swift|windowserver-capture))$/.test(path) ||
    /(?:^|\/)oracle-gis-[a-f0-9]{48}\/(?:oracle-pixels\.bin|semantic-review\.record)$/.test(path)) return true;
  const oracle = path.match(/(?:^|\/)oracle-gis-[a-f0-9]{48}\/(.+)$/)?.[1];
  return typeof oracle === 'string' && oracle.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9_./-]*\.bgra$/.test(oracle) &&
    !oracle.split('/').some(part => !part || part === '.' || part === '..');
}
function comparable(record) {
  if (!record || typeof record !== 'object') return null;
  const {id, producerId, nativePresentationProof, ...value} = record;
  return value;
}
/** The original private token and the unchanged session must travel together.
 * Repeated booleans, copied tokens, and another cohort cannot mint bounds. */
export function readVerifiedSessionBounds(proof, record) {
  const entry = proofs.get(proof);
  if (!entry || !record || (record.producerId !== undefined ? record.id !== entry.attemptId || record.producerId !== entry.producerId : record.id !== entry.producerId) ||
    !isDeepStrictEqual(comparable(record), entry.record)) return null;
  return structuredClone(entry.value);
}
export async function verifySessionWindowServerEvidence(context) {
  try {
    // Hold immutable-by-ownership admission inputs across every asynchronous
    // byte replay. Only the two existing retained readers remain callbacks.
    const {readRetained, resolveRetained, ...inputs} = context ?? {};
    return await replay({...structuredClone(inputs), readRetained, resolveRetained});
  }
  catch (error) {if (error?.code === 'SESSION_REPLAY_UNAVAILABLE' || error?.code === 'ENOENT') return null; throw error;}
}
async function replay({attempt, cell, serial, configuration, groupOutput, retainedPaths, retainedFiles, readRetained, resolveRetained,
  controlFiles, sourceFiles, fixture, workerPid, sourceRoot, engine, developerState, developerStateIdentity, subjectDigest, browserCache, tools, evidenceStorage}) {
  const result = attempt?.result, record = result?.session, observation = record?.nativePresentation;
  if (!observation || cell?.operation !== 'interaction.brush' || attempt.prime !== false) return null;
  if (result.status === 'FAIL' || attempt.status === 'FAIL' || result.error || record.correctnessViolation || record.capViolation) return null;
  if (!observation.evidence || !observation.projection || !observation.join || observation.failures?.length) return null;
  demand(typeof attempt.id === 'string' && ['cold', 'warm'].includes(attempt.cache) && integer(attempt.ordinal) && attempt.ordinal > 0 &&
    integer(serial) && serial > 0 && isAbsolute(groupOutput) && resolve(groupOutput) === groupOutput && Array.isArray(retainedPaths) &&
    Array.isArray(retainedFiles) && integer(workerPid) && workerPid > 1, 'Session actual attempt/retention scope unavailable');
  demand(attempt.id === `${cell.id}/${attempt.cache}/scored/${attempt.ordinal}` && attempt.reset?.status === 'PASS' && attempt.reset.cache === attempt.cache && !attempt.reset.missing?.length &&
    (attempt.cache !== 'cold' || serial === 1) && (attempt.cache !== 'warm' || attempt.reset.cacheInvalidated !== true) &&
    finite(attempt.startMs) && finite(attempt.endMs) && attempt.endMs >= attempt.startMs, 'Session actual scored/reset identity differs');
  const paths = new Set(retainedPaths), seals = new Map(retainedFiles.map(file => [file.path, file]));
  same([...seals.keys()].sort(), [...paths].sort(), 'Session retained identity inventory differs');
  function local(path) {
    demand(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path.startsWith(groupOutput + sep), 'Session reference leaves its original group');
    const value = relative(groupOutput, path).split(sep).join('/'); if (!paths.has(value)) unavailable('Session member is not retained'); return value;
  }
  function sealed(path, identity) {
    if (!paths.has(path)) unavailable('Missing session raw member: ' + path);
    const actual = seals.get(path);
    demand(integer(identity?.bytes) && pin(identity.sha256) && actual?.bytes === identity.bytes && bare(actual.sha256) === bare(identity.sha256), 'Session raw member differs from outer retained seal');
  }
  async function bytes(path, identity, maximum) {
    if (!paths.has(path)) unavailable('Missing session raw member: ' + path);
    if (identity) {sealed(path, identity); demand(identity.bytes <= maximum, 'Session artifact exceeds its declared read bound');}
    const retained = await readRetained(path, {maximum});
    demand(Buffer.isBuffer(retained) && retained.length <= maximum, 'Session member exceeds its read bound');
    const value = Buffer.from(retained);
    sealed(path, {bytes: value.length, sha256: hash(value)});
    if (identity) demand(value.length === identity.bytes && hash(value) === bare(identity.sha256), 'Session member differs from its pin');
    return value;
  }
  const producerPath = 'browser-cell-' + serial + '.json', producer = json(await bytes(producerPath, null, 128 * 1024 ** 2));
  demand(producer.cellId === cell.id && producer.operation === cell.operation && producer.timingSamplesReusable === true && producer.clocksJoinedBySubtraction === false, 'Session producer scope differs');
  const tracePin = producer.trace?.artifact;
  if (!tracePin || producer.trace?.segments) return null;
  same(sanitize(normalizeResult({...producer, artifacts: [join(groupOutput, producerPath), tracePin.path]}, attempt.startMs, attempt.endMs)), result, 'Session attempt differs from retained producer');
  const raw = producer.observations, sessionId = observation.sessionId, nativeSessionId = genericSessionNativeId(sessionId);
  demand(observation.kind === 'generic-windowserver-observation-1' && observation.profile === GENERIC_PROFILE && observation.nativeSessionId === nativeSessionId && observation.qualification === false, 'Session native protocol differs');
  const projection = projectGenericInteraction(raw, {sessionId});
  same(sanitize(projection), observation.projection, 'Session input/public-state projection cannot be reproduced');
  if (projection.status !== 'PASS') return null;
  same(observation.nativeSessionStart, projection.nativeSessionStart, 'Session begin anchor differs');
  same(observation.nativeSessionEnd, projection.nativeSessionEnd, 'Session end anchor differs');
  const expectedRecord = interactionSession(cell, {cache: attempt.cache, ordinal: attempt.ordinal}, raw, producer.trace, record.visibility);
  same(sanitize({...expectedRecord, nativePresentation: observation}), record, 'Session metric aliases differ from actual input source');
  demand(record.visibility === 'visible' && record.clock === 'browser-performance' && record.actions.every(action => action.presentedMs === null &&
    action.meaningful === true && action.outcome === 'expected' && (action.samples ?? []).every(point => point.presentedMs === null)), 'Session public outcomes or exact-null presentation differ');
  // Regenerate only the fixed generator's declared corpus. This is input
  // provenance, not pixel-oracle generation or a historical filesystem read.
  demand(raw.inputProtocol.document.id === fixture?.documentId && raw.inputProtocol.document.width === fixture?.definition?.width &&
    raw.inputProtocol.document.height === fixture.definition.height, 'Session input document differs from sealed fixture');
  const corpus = brushCorpus(fixture.definition.width, fixture.definition.height), corpusBytes = Buffer.from(JSON.stringify(corpus, null, 2) + '\n');
  const corpusPins = fixture.corpus?.files?.filter(file => file.role === 'gestures');
  demand(corpusPins?.length === 1 && corpusPins[0].id === 'brush-strokes' && bare(corpusPins[0].sha256) === hash(corpusBytes) &&
    String(corpusPins[0].byteLength ?? corpusPins[0].bytes) === String(corpusBytes.length), 'Session gestures differ from fixed sealed corpus');
  let priorCompletion = null, priorUndo = null;
  for (const action of raw.actions) {
    if (action.kind === 'stroke') {
      demand(action.specimenId === corpus[action.index]?.id, 'Session stroke specimen differs from fixed first twenty');
      same(planStrokeCoordinates(corpus[action.index], action.plan.state, {document: raw.inputProtocol.document,
        eligibleLayerIds: raw.inputProtocol.eligibleLayers.map(layer => layer.id)}), action.plan, 'Session scored geometry differs from sealed corpus');
      const validated = validateRecordedStroke({observation: action.native, plan: action.plan, completion: action.completion,
        priorCompletion, priorUndo, requireEmptyDraft: true});
      same(sanitize(validated), action.validation, 'Session retained stroke validation differs');
      same(sanitize(validated.samples), action.samples, 'Session metric samples differ from actual native inputs');
      demand(validated.status === 'PASS' && action.inputMs === action.native.firstInputMs && action.inputMs === validated.samples[0].inputMs,
        'Session initiating stroke input differs');
      same(action.productCompletion, action.completion.detail, 'Session product completion alias differs');
      for (const dispatch of action.pointerDispatches) {
        same(dispatch.missing, [], 'Session pointer hook has unresolved input evidence');
        same(dispatch.automation, projection.automation, 'Session pointer automation differs');
        demand(dispatch.nativeBracketVerified === false, 'Session producer cannot certify pointer native evidence');
      }
      priorCompletion = action.completion; priorUndo = null;
    } else {
      for (const dispatch of action.discreteInput.steps) {
        same(dispatch.missing, [], 'Session discrete hook has unresolved input evidence');
        demand(dispatch.nativeBracketVerified === false, 'Session producer cannot certify discrete native evidence');
      }
      if (action.kind === 'undo') priorUndo = {...action.semantic, native: action.native};
    }
  }
  const trace = json(await bytes(local(tracePin.path), tracePin, 128 * 1024 ** 2));
  if (trace.kind !== 'sanitized-chromium-trace-1' || trace.collection?.status !== 'complete' || trace.collection.completeEventReceived !== true || trace.collection.reasons?.length) return null;
  same(producer.trace.collection, trace.collection, 'Session diagnostic trace closure differs');
  // This trace supplies retained context only. Neither native clock conversion
  // nor application attribution can be inferred from its renderer events.
  const runtime = json(await bytes('browser-runtime.json', null, 1024 ** 2));
  demand(runtime.headless === false && runtime.browserPid > 1 && runtime.engine === engine && isAbsolute(sourceRoot ?? '') &&
    typeof runtime.playwrightModule === 'string' && runtime.playwrightModule.startsWith(join(sourceRoot, 'node_modules') + sep), 'Session owned headed browser/source unavailable');
  same(runtime.fixtureSeal, fixture?.seal ?? null, 'Session browser fixture differs');
  // Admission is derived from the already consumed immutable preparation state.
  // Without such bytes this bounded route remains unqualified, never guessed.
  if (!developerState || !developerStateIdentity) return null;
  demand(developerState.kind === 'developer-runtime-state-1' && pin(developerState.sha256) &&
    hash(Buffer.from(JSON.stringify(developerState.state, null, 2) + '\n')) === bare(developerState.sha256) && pin(developerStateIdentity.sha256), 'Session consumed developer state differs');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build') && workspace.completed.includes('browser-cache');
  demand(completed && !workspace.failure && !workspace.active && workspace.source === sourceRoot && state.productRepo === sourceRoot && state.sourceDigest === subjectDigest,
    'Session prepared source/browser state differs');
  const expectedCache = state.playwrightBrowsersPath ?? workspace.browserCache;
  demand(isAbsolute(expectedCache ?? '') && browserCache === expectedCache && runtime.executable?.startsWith(expectedCache + sep), 'Session browser cache differs from consumed preparation');
  const prepared = workspace.browserIdentity?.engines?.filter(value => value.engine === engine);
  if (prepared?.length !== 1) return null;
  demand(prepared[0].executable === runtime.executable && prepared[0].version === runtime.version && prepared[0].revision === runtime.revision &&
    prepared[0].bytes === runtime.executableIdentity?.bytes && pin(prepared[0].sha256) && bare(prepared[0].sha256) === bare(runtime.executableIdentity?.sha256), 'Session actual browser differs from prepared executable');
  const browserPin = tools?.browserPins?.browsers?.filter(value => value.name === engine);
  if (browserPin?.length !== 1) return null;
  demand(runtime.revision === browserPin[0].revision && runtime.version === browserPin[0].browserVersion, 'Session actual browser differs from pinned tool revision');
  const registrations = retainedPaths.filter(path => new RegExp('^owned-process-' + runtime.browserPid + '-[a-f0-9-]{36}\\.json$').test(path));
  if (registrations.length !== 1) return null;
  const registration = json(await bytes(registrations[0], null, 65536)), browserProcess = registration.processes?.[0];
  demand(registration.kind === 'perf-owned-processes-1' && registration.ownerPid === workerPid && registration.processes?.length === 1 &&
    browserProcess.kind === 'browser' && browserProcess.pid === runtime.browserPid && integer(browserProcess.pgid) && browserProcess.pgid > 1 &&
    browserProcess.executable === runtime.executable && typeof browserProcess.startedAtIdentity === 'string' && browserProcess.startedAtIdentity.length > 0, 'Session browser ownership differs');
  const backends = retainedPaths.filter(path => new RegExp('^owned-process-' + runtime.backendPid + '-[a-f0-9-]{36}\\.json$').test(path));
  if (backends.length !== 1) return null;
  const backendOwner = json(await bytes(backends[0], null, 65536)), backend = backendOwner.processes?.[0];
  demand(backendOwner.kind === 'perf-owned-processes-1' && backendOwner.ownerPid === workerPid && backendOwner.processes?.length === 1 &&
    backend.kind === 'backend' && backend.pid === runtime.backendPid && integer(backend.pgid) && backend.pgid > 1 &&
    typeof backend.startedAtIdentity === 'string' && backend.startedAtIdentity.length > 0, 'Session backend ownership differs');
  demand(runtime.ownedLaunch?.context?.createdBy === 'browser.newContext' && runtime.ownedLaunch.context.freshAtLaunch === true,
    'Session owned context admission unavailable');
  const launch = runtime.ownedLaunch.process;
  demand(launch?.pid === browserProcess.pid && launch.pgid === browserProcess.pgid && launch.startedAtIdentity === browserProcess.startedAtIdentity &&
    launch.executable === browserProcess.executable && local(launch.registration?.path) === registrations[0], 'Session actual browser launch differs from owned registration');
  await bytes(registrations[0], launch.registration, 65536);
  const selected = genericNativeConfiguration(configuration?.browser?.windowServerGenericActions, runtime);
  const nativeSchema = selected.config.schemaVersion, lossless = nativeSchema === 3;
  demand(nativeSchema === 2 || lossless && selected.config.storageFormat === 'rfc1951-previous-roi-1', 'Unsupported selected native protocol');
  demand(observation.nativeSchemaVersion === nativeSchema, 'Session observed protocol differs from explicit selection');
  // Closed, source-bound implementations only; callers cannot inject a replay
  // provider, decoder, admission verdict, getter or proof constructor.
  const route = lossless ? {
    source: 'windowserver-session-lossless-capture.swift', validateReady: validateWindowServerSessionLosslessReady,
    verifyCapture: verifyWindowServerSessionLosslessCapture, observations: getWindowServerSessionLosslessObservations,
    verifyAdmission: verifySessionLosslessEvidenceAdmission, verifyFinalSample: verifySessionLosslessEvidenceFinalSample, join: joinGenericActionLosslessPixels,
  } : {
    source: 'windowserver-session-capture.swift', validateReady: validateWindowServerSessionReady,
    verifyCapture: verifyWindowServerSessionCapture, observations: getWindowServerSessionObservations,
    verifyAdmission: verifySessionEvidenceAdmission, verifyFinalSample: verifySessionEvidenceFinalSample, join: joinGenericActionPixels,
  };
  const oracleFolder = 'oracle-' + nativeSessionId, bindingBytes = await bytes(oracleFolder + '/binding.json', null, 2 * 1024 ** 2), binding = json(bindingBytes);
  same(sanitize(binding), observation.binding, 'Session binding differs from retained raw authority');
  demand(binding.kind === 'generic-windowserver-input-binding-1' && binding.profile === GENERIC_PROFILE && binding.sessionId === sessionId &&
    binding.nativeSessionId === nativeSessionId, 'Session binding scope differs');
  same(binding.invocation, {cellId: String(cell.id), operation: cell.operation, serial, sample: {cache: attempt.cache, ordinal: attempt.ordinal, prime: false},
    producerPath: join(groupOutput, producerPath), tracePath: join(groupOutput, 'browser-trace-' + serial + '.json'), rawFeedback: binding.invocation?.rawFeedback ?? null},
    'Session invocation differs from original consumed schedule');
  demand(tracePin.path === binding.invocation.tracePath, 'Session trace belongs to another invocation');
  // The optional raw transport has its own complete returned manifest.
  // Its provisional on-disk sidecar never supplies successful closure.
  let rawTraceIdentity = null;
  if (configuration?.browser?.rawDisplayFeedback !== undefined) {
    const chosen = genericRawFeedbackSelection(configuration.browser.rawDisplayFeedback, runtime, runtime.browserPid);
    const rawPath = 'browser-feedback-' + serial + '.raw.json', expectedPath = join(groupOutput, rawPath);
    same(binding.invocation.rawFeedback, {...chosen, artifactPath: expectedPath}, 'Session raw trace selection differs from actual owned launch');
    const rawFeedback = producer.trace.rawFeedback, manifest = rawFeedback?.manifest, collection = manifest?.collection, artifact = manifest?.artifact, cleanup = manifest?.cleanup;
    if (!manifest || collection?.status !== 'complete' || collection.startOutcome !== 'acknowledged' || collection.completeEventReceived !== true ||
      collection.completionOwnership !== 'acknowledged-own-start' || collection.foreignTraceObserved !== false || collection.dataLossOccurred !== false ||
      collection.streamReceived !== true || collection.eof !== true || collection.reasons?.length || manifest.manifest?.saved !== true ||
      cleanup?.browserCleanupRequired !== false || cleanup.artifactCleanupRequired !== false || cleanup.unresolvedAdditionalStream !== false ||
      cleanup.lateOperations?.length !== 0 || artifact?.fileMayChangeAfterReturn !== false) return null;
    demand(manifest.kind === 'display-feedback-raw-trace-1' && artifact.path === expectedPath && artifact.rawClosed === true &&
      artifact.hashScope === 'completed-file' && artifact.hashVerifiedAgainstSize === true && artifact.persistedSize === artifact.bytes &&
      collection.bytes === artifact.bytes && rawFeedback.kind === 'browser-raw-feedback-route-1' && rawFeedback.qualification === false &&
      rawFeedback.rawAndSanitizedShareOneTrace === true && rawFeedback.fullRawJsonValidated === true && producer.trace.collection.derivedFromVerifiedRaw === true,
      'Session raw trace successful closure differs');
    same(manifest.manifest, {path: expectedPath + '.manifest.json', saved: true,
      sidecar: 'provisional-requires-returned-save-acknowledgement', returnedReceiptAuthority: 'requires-owning-producer-receipt'},
      'Session returned raw sidecar reference differs');
    const provisional = structuredClone(manifest);
    provisional.manifest.saved = false; provisional.collection.status = 'incomplete';
    provisional.collection.reasons.push('manifest-save-unacknowledged'); provisional.artifact.hashScope = 'persisted-prefix';
    same(json(await bytes(rawPath + '.manifest.json', null, 2 * 1024 ** 2)), provisional,
      'Session retained provisional sidecar differs from acknowledged producer closure');
    same(manifest.ownership, {...chosen.ownership, validation: 'caller-declaration-only'}, 'Session raw trace declaration differs from configured scope');
    demand(manifest.browserVersion?.status === 'observed' && manifest.browserVersion.product === 'Chrome/' + runtime.version,
      'Session raw trace browser version differs from owned executable');
    sealed(rawPath, artifact);
    const rawResolved = await resolveRetained(rawPath), relocatedManifest = {...manifest, artifact: {...artifact, path: rawResolved}};
    const cohort = genericRawFeedbackCohort(producer.observations, {sessionId});
    const analysis = await analyzeDisplayFeedbackTrace({chunks: rawDisplayFeedbackChunks({manifest: relocatedManifest, expectedPath: rawResolved}), manifest: relocatedManifest, cohort});
    if (!analysis.rawArtifact?.fullJsonValidated || !analysis.rawArtifact.matchesCollectionManifest) return null;
    same(sanitize(analysis), rawFeedback.analysis, 'Session raw display diagnostic replay differs');
    rawTraceIdentity = {path: rawPath, bytes: artifact.bytes, sha256: artifact.sha256};
    for (const name of ['browser-trace-raw.mjs', 'display-feedback-collector.mjs', 'display-feedback-json.mjs', 'display-feedback.mjs'])
      demand(controlFiles.some(file => file.path === 'tooling/qualification/campaigns/' + name && pin(file.sha256)), 'Session selected raw trace source unavailable');
  } else demand(binding.invocation.rawFeedback === null && producer.trace.rawFeedback === undefined, 'Session undeclared raw trace route differs');
  same(binding.browser, runtime, 'Session actual runtime differs from binding');
  same(binding.config, selected.config, 'Session raw native configuration differs');
  same(binding.environment, selected.environment, 'Session environment binding differs');
  same(binding.build, selected.selection.build, 'Session build selection differs');
  same(binding.evidenceAllocation, selected.selection.evidenceAllocation, 'Session allocation selection differs');
  same(binding.evidenceReservation, selected.selection.evidenceReservation, 'Session reservation selection differs');
  const collector = controlFiles?.filter(file => file.path === 'tooling/qualification/native/' + route.source);
  demand(collector?.length === 1 && collector[0].bytes === binding.collectorSource?.bytes && bare(collector[0].sha256) === bare(binding.collectorSource?.sha256),
    'Session collector is not bound to selected control source');
  for (const name of ['browser.mjs', 'browser-driver.mjs', 'browser-generic-input.mjs', 'browser-gesture-state.mjs', 'browser-discrete-input.mjs', 'generic-action-oracle.mjs',
    'windowserver-generic-actions.mjs', 'windowserver-session.mjs', 'windowserver-session-process.mjs', 'windowserver-session-budget.mjs', 'fixtures.mjs',
    ...(lossless ? ['windowserver-session-lossless.mjs', 'windowserver-session-lossless-process.mjs', 'windowserver-session-lossless-budget.mjs', 'generic-oracle-lossless.mjs'] : [])])
    demand(controlFiles.some(file => file.path === 'tooling/qualification/campaigns/' + name && pin(file.sha256)), 'Session executed source closure unavailable: ' + name);
  demand(Array.isArray(sourceFiles) && sourceFiles.some(file => file.path === 'src/ui/shell.ts' && pin(file.sha256)), 'Session subject source unavailable');
  const oraclePath = oracleFolder + '/oracle.json';
  demand(binding.oracle?.path === join(groupOutput, oraclePath) && bare(binding.oracle.sha256) === selected.selection.oracle.sha256, 'Session oracle differs from consumed pin');
  const oracleBytes = await bytes(oraclePath, binding.oracle, 16 * 1024 ** 2), oracle = json(oracleBytes), inventory = genericOracleInventory(oracle, selected);
  same(binding.oracle.pixels, inventory.files, 'Session retained oracle inventory differs');
  const oracleReservation = selected.selection.evidenceReservation.oracle;
  let pixelIdentities = [], oracleMembers;
  if (lossless) {
    const storage = binding.oracle.storage, chosen = selected.selection.oracle.storage;
    demand(storage?.kind === 'rfc1951-oracle-pixels-1', 'Session packed independent oracle format differs');
    for (const [key, name] of [['index', 'oracle-pixels.json'], ['container', 'oracle-pixels.bin'], ['review', 'semantic-review.record']]) {
      same(storage[key], {...chosen[key], path: join(groupOutput, oracleFolder, name)}, 'Session packed oracle selected pin differs');
      sealed(oracleFolder + '/' + name, storage[key]);
    }
    const indexBytes = await bytes(oracleFolder + '/oracle-pixels.json', storage.index, 4 * 1024 ** 2);
    await bytes(oracleFolder + '/semantic-review.record', storage.review, 65536);
    const packed = await replayPackedGenericOracle({containerPath: await resolveRetained(oracleFolder + '/oracle-pixels.bin'), containerPin: storage.container,
      indexBytes, indexSha256: storage.index.sha256, oracleSha256: selected.selection.oracle.sha256,
      pixelIdentities: inventory.files, reviewPin: storage.review});
    demand(storage.reviewReference === packed.semanticReview.reference, 'Session packed review reference differs from pinned index');
    same(binding.semanticOracleReview, {requirement: 'external-independently-reviewed-exact-pixels-required', reference: packed.semanticReview.reference,
      reviewSha256: storage.review.sha256, generatedByCapture: false, authorityFromFlags: false}, 'Session external semantic review provenance differs');
    // The opaque external review record is retained and selected by its owner.
    // Its content/flags are never parsed as a self-authorizing approval.
    pixelIdentities = packed.pixelIdentities;
    demand(oracleReservation.bytes >= oracleBytes.length + storage.index.bytes + storage.container.bytes + storage.review.bytes &&
      oracleReservation.files >= 4 && oracleReservation.directories >= 1, 'Session packed oracle reservation differs');
    oracleMembers = ['oracle-pixels.json', 'oracle-pixels.bin', 'semantic-review.record'];
  } else {
    demand(binding.oracle.storage === undefined && binding.semanticOracleReview === 'external-independently-reviewed-exact-pixels-required',
      'Session raw oracle route differs');
    demand(oracleReservation.bytes >= oracleBytes.length + inventory.pixelBytes && oracleReservation.files >= inventory.files.length + 1 &&
      oracleReservation.directories >= inventory.directories.length, 'Session oracle reservation does not cover retained independent bytes');
    for (const member of inventory.files) {
      // One bounded ROI at a time; no whole-session pixel buffer collection.
      const pixel = await bytes(oracleFolder + '/' + member.path, member, 256 * 1024 ** 2);
      pixelIdentities.push({path: member.path, bytes: pixel.length, sha256: hash(pixel)});
    }
    oracleMembers = inventory.files.map(file => file.path);
  }
  same(retainedPaths.filter(path => path.startsWith(oracleFolder + '/')).sort(),
    ['binding.json', 'oracle.json', 'allocation-admission.json', 'allocation.json', ...oracleMembers].map(path => oracleFolder + '/' + path).sort(),
    'Session independent oracle retained membership differs');
  const allocationIdentity = {bytes: selected.selection.evidenceAllocation.bytes, sha256: selected.selection.evidenceAllocation.sha256};
  demand(evidenceStorage?.kind === 'evidence-volume-reference-1', 'Session outer evidence audit reference unavailable');
  same(evidenceStorage.allocationIdentity, allocationIdentity, 'Session native allocation differs from outer controller authority');
  demand(binding.allocationAdmissionPath === join(groupOutput, oracleFolder, 'allocation-admission.json') &&
    binding.allocationSourcePath === join(groupOutput, oracleFolder, 'allocation.json'), 'Session initial allocation paths differ');
  const initialAllocation = await bytes(oracleFolder + '/allocation.json', allocationIdentity, 16 * 1024 ** 2);
  const initialAdmissionBytes = await bytes(oracleFolder + '/allocation-admission.json', null, 128 * 1024);
  const admissionInputs = {evidenceAllocation: selected.selection.evidenceAllocation, evidenceReservation: selected.selection.evidenceReservation, config: selected.config};
  const controlReservation = selected.selection.evidenceReservation.control;
  demand(controlReservation.files >= 3 && controlReservation.bytes >= bindingBytes.length + initialAdmissionBytes.length + initialAllocation.length,
    'Session control reservation does not cover retained binding and allocation');
  const traceReservation = selected.selection.evidenceReservation.trace;
  const traceMembers = [seals.get(local(tracePin.path)), ...(rawTraceIdentity ? [seals.get(rawTraceIdentity.path), seals.get(rawTraceIdentity.path + '.manifest.json')] : [])];
  if (traceMembers.some(member => !member)) return null;
  demand(traceReservation.bytes >= traceMembers.reduce((n, member) => n + member.bytes, 0) && traceReservation.files >= traceMembers.length,
    'Session trace reservation does not cover selected retained trace closure');
  const initialAdmission = route.verifyAdmission({...admissionInputs, admissionBytes: initialAdmissionBytes, allocationSourceBytes: initialAllocation,
    expectedAdmission: {bytes: initialAdmissionBytes.length, sha256: hash(initialAdmissionBytes)}, outputDirectory: groupOutput});

  const transaction = 'native-' + nativeSessionId, captureFolder = transaction + '/capture', processPin = observation.evidence.process?.receipt;
  demand(processPin?.path === join(groupOutput, transaction, 'process.json'), 'Session native process receipt differs');
  const processRecord = json(await bytes(transaction + '/process.json', processPin, 2 * 1024 ** 2));
  const {receipt: ignored, ...reportedProcess} = observation.evidence.process;
  same(sanitize(processRecord), reportedProcess, 'Session native process observation differs');
  if (processRecord.outcome !== 'CAPTURE_REPLAYED' || processRecord.failure || processRecord.cleanupErrors?.length || processRecord.requestedSignals?.length ||
    processRecord.exit?.code !== 0 || processRecord.exit.signal !== null || processRecord.close?.code !== 0 || processRecord.close.signal !== null) return null;
  demand(processRecord.kind === 'windowserver-session-owned-process-' + nativeSchema && processRecord.schemaVersion === nativeSchema && processRecord.qualification === false,
    'Session process protocol differs');
  const processIdentity = processRecord.processIdentity;
  demand(processIdentity?.kind === 'windowserver' && processIdentity.ownerPid === workerPid && processIdentity.pid > 1 && processIdentity.pgid === processIdentity.pid &&
    typeof processIdentity.startedAtIdentity === 'string' && processIdentity.startedAtIdentity.length > 0, 'Session collector ownership differs');
  same(observation.processIdentity, processIdentity, 'Session collector identity alias differs');
  const owned = json(await bytes(local(processRecord.registration?.path), processRecord.registration, 65536));
  same(owned, {kind: 'perf-owned-processes-1', ownerPid: workerPid, processes: [{kind: 'windowserver', pid: processIdentity.pid, pgid: processIdentity.pgid,
    startedAtIdentity: processIdentity.startedAtIdentity, executable: processIdentity.executable}]}, 'Session collector registration differs');
  same(processRecord.authorizedSource, binding.collectorSource, 'Session adjacent collector differs from retained source binding');
  same(processRecord.build, {...selected.selection.build, sourceSha256: bare(binding.collectorSource.sha256)}, 'Session native build invocation differs');
  const volume = processRecord.evidenceVolume;
  demand(volume?.kind === 'windowserver-session-evidence-reference-' + (lossless ? 2 : 1) && volume.qualification === false, 'Session budget reference protocol differs');
  same(volume.allocationIdentity, allocationIdentity, 'Session supervisor allocation identity differs');
  same(volume.selectedAllocation, selected.selection.evidenceAllocation, 'Session supervisor selected allocation differs');
  same(volume.selectedReservation, selected.selection.evidenceReservation, 'Session supervisor reservation differs');
  same(volume.requestedConfig, selected.config, 'Session supervisor requested native config differs');
  same(volume.requiredOuterAudit, {kind: 'evidence-volume-reference-1', allocationIdentity, qualification: false}, 'Session outer audit relation differs');
  for (const [key, filename] of [['allocation', 'allocation-source'], ['preparation', 'preparation'], ['admission', 'admission'], ['finalSample', 'final-sample']])
    demand(volume[key]?.path === 'evidence-budget/' + filename + '.json', 'Session supervisor budget member differs');
  const allocationBytes = await bytes(transaction + '/' + volume.allocation.path, volume.allocation, 16 * 1024 ** 2);
  same(allocationBytes, initialAllocation, 'Session allocation changed between oracle and native preparation');
  const verifyAdmission = async key => route.verifyAdmission({...admissionInputs,
    admissionBytes: await bytes(transaction + '/' + volume[key].path, volume[key], 128 * 1024), allocationSourceBytes: allocationBytes,
    expectedAdmission: {bytes: volume[key].bytes, sha256: volume[key].sha256}, outputDirectory: join(groupOutput, transaction)});
  const preparation = await verifyAdmission('preparation'), admission = await verifyAdmission('admission');
  same(preparation.admission.allocation.directoryIdentity, initialAdmission.admission.allocation.directoryIdentity, 'Session allocation directory changed before spawn');
  same(admission.admission.allocation.directoryIdentity, preparation.admission.allocation.directoryIdentity, 'Session allocation directory changed during preparation');
  same(admission.admission.directoryIdentity, preparation.admission.directoryIdentity, 'Session native directory changed during preparation');
  demand(volume.capacityBytes === admission.admission.allocation.capacityBytes, 'Session capacity differs from authenticated allocation');
  const finalSample = route.verifyFinalSample({sampleBytes: await bytes(transaction + '/' + volume.finalSample.path, volume.finalSample, 65536),
    expectedSample: {bytes: volume.finalSample.bytes, sha256: volume.finalSample.sha256}, allocationIdentity, capacityBytes: volume.capacityBytes});
  if (finalSample.status !== 'PASS') return null;
  const config = admission.admission.config, configPath = transaction + '/config.json';
  demand(processRecord.config?.path === 'config.json', 'Session config member differs');
  same(json(await bytes(configPath, processRecord.config, 8192)), config, 'Session retained config differs from actual admission');
  same(observation.config, config, 'Session derived config alias differs');
  const buildEvidence = processRecord.buildEvidence;
  demand(buildEvidence?.path === 'build-evidence/manifest.json' && buildEvidence.sourceSha256 === bare(binding.collectorSource.sha256) &&
    buildEvidence.receiptSha256 === selected.selection.build.receiptSha256, 'Session retained build pin differs');
  for (const member of buildMembers) if (!paths.has(transaction + '/build-evidence/' + member)) unavailable('Missing retained session build member');
  await bytes(transaction + '/' + buildEvidence.path, buildEvidence, 128 * 1024 ** 2);
  const relocatedBuild = await resolveRetained(transaction + '/build-evidence/manifest.json');
  const build = await verifyWindowServerBuildEvidence({directory: dirname(relocatedBuild), manifestSha256: bare(buildEvidence.sha256), sourceSha256: buildEvidence.sourceSha256});
  demand(build.receiptSha256 === selected.selection.build.receiptSha256 && build.binarySha256 === buildEvidence.binarySha256 &&
    processRecord.executable?.sha256 === buildEvidence.binarySha256, 'Session executed binary differs from build');
  await bytes(transaction + '/build-evidence/windowserver-capture', processRecord.executable, 64 * 1024 ** 2);
  // Reconcile every build member against the outer seal too, including source
  // and SDK bytes verified by the portable build helper.
  const buildManifest = json(await bytes(transaction + '/' + buildEvidence.path, buildEvidence, 128 * 1024 ** 2));
  for (const member of buildManifest.members ?? []) sealed(transaction + '/build-evidence/' + member.path, member);
  same(processRecord.command, [processIdentity.executable, join(groupOutput, configPath), join(groupOutput, captureFolder)], 'Session native invocation differs');
  demand(processRecord.executable.path === processIdentity.executable && processIdentity.executable === join(dirname(processRecord.build.receiptPath), 'windowserver-capture') &&
    processRecord.outputDirectory === join(groupOutput, captureFolder), 'Session native executable/output differs');
  demand(processRecord.stdout?.path === 'stdout.ndjson' && processRecord.stderr?.path === 'stderr.log' && processRecord.manifest?.path === 'capture/manifest.json',
    'Session native artifact paths differ');
  const stdout = await bytes(transaction + '/stdout.ndjson', processRecord.stdout, 64 * 1024 ** 2), stderr = await bytes(transaction + '/stderr.log', processRecord.stderr, 1024 ** 2);
  same(processRecord.streamBytesObserved, {stdout: stdout.length, stderr: stderr.length}, 'Session native stream counts differ');
  const manifestBytes = await bytes(captureFolder + '/manifest.json', processRecord.manifest, 4 * 1024 ** 2), manifest = json(manifestBytes);
  same(manifest.config, config, 'Session capture config differs from actual invocation');
  same(observation.evidence.manifest, {path: join(groupOutput, captureFolder, 'manifest.json'), bytes: manifestBytes.length, sha256: hash(manifestBytes)}, 'Session manifest pin differs');
  const framesBytes = await bytes(captureFolder + '/frames.ndjson', manifest.frames, 64 * 1024 ** 2);
  const decodeRows = value => {const text = new TextDecoder('utf-8', {fatal: true}).decode(value); demand(text.endsWith('\n'), 'Session native NDJSON incomplete');
    return text.slice(0, -1).split('\n').map(line => {demand(line.length > 0 && Buffer.byteLength(line) <= 16384, 'Session native line bound exceeded'); return JSON.parse(line);});};
  const records = decodeRows(framesBytes), controls = decodeRows(stdout);
  demand(records.length <= 9012 + 5114 && controls.length <= 9012 + 5114 + 2, 'Session native record bound exceeded');
  const ready = controls.filter(row => row.event === 'ready'), stopped = controls.filter(row => row.event === 'stopped');
  if (ready.length !== 1 || stopped.length !== 1 || controls.at(-1) !== stopped[0]) return null;
  same(ready[0], observation.ready, 'Session ready alias differs');
  route.validateReady(ready[0], {config, outputDirectory: join(groupOutput, captureFolder)});
  same(ready[0].display, oracle.display, 'Session display differs from independent oracle');
  same(stopped[0], {schemaVersion: nativeSchema, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'}, 'Session native stop differs');
  same(controls.filter(row => !['ready', 'stopped'].includes(row.event)), records.filter(row => row.event === 'clock' || row.event === 'sample' && row.retained === true),
    'Session native stdout differs from retained records');
  const pixelMembers = lossless ? manifest.pixelContainers : manifest.pixelFiles;
  demand(Array.isArray(pixelMembers) && (lossless ? !Object.hasOwn(manifest, 'pixelFiles') && pixelMembers.length === 1 && pixelMembers[0].path === 'pixels.bin' :
    !Object.hasOwn(manifest, 'pixelContainers')), 'Session selected pixel storage inventory differs');
  for (const member of pixelMembers) sealed(captureFolder + '/' + member.path, member);
  same(retainedPaths.filter(path => path.startsWith(captureFolder + '/')).sort(),
    ['manifest.json', 'frames.ndjson', ...pixelMembers.map(member => member.path)].map(path => captureFolder + '/' + path).sort(), 'Session capture retained membership differs');
  const relocatedCapture = dirname(await resolveRetained(captureFolder + '/manifest.json'));
  // Original output identity was validated above. Rebase only this detached
  // invocation path; all original retained bytes and their pins stay unchanged.
  const capture = await route.verifyCapture(relocatedCapture, {manifestSha256: hash(manifestBytes), expectedConfig: config,
    expectedReady: {...ready[0], outputDirectory: relocatedCapture}, expectedStopped: stopped[0], processExitCode: processRecord.exit.code});
  const replayed = route.observations(capture);
  same(replayed.manifest, manifest, 'Session replayed manifest differs'); same(replayed.records, records, 'Session replayed metadata differs');
  same(observation.lossObservations, replayed.lossObservations, 'Session unavailable native loss observations differ');
  const joined = route.join(capture, {projection, oracleBytes, oracleSha256: selected.selection.oracle.sha256, pixelIdentities,
    binding: {fixtureSha256: binding.environment.fixtureSha256, browserEnvironmentSha256: binding.environment.browserEnvironmentSha256,
      browserPid: runtime.browserPid, windowNumber: ready[0].windowAdmission.windowNumber}});
  same(sanitize(joined), observation.join, 'Session native pixel join cannot be reproduced');
  // Partial pixel coverage remains useful only after the complete actual input,
  // owned capture, independent oracle and storage closure above replayed.
  const bound = endpoint => ({status: endpoint.status, upperBoundMs: endpoint.firstMeaningfulPaintUpperBoundMs,
    exactMs: null, lowerMs: null, withinWindow: endpoint.status === 'OBSERVED', endpoint: 'WindowServer-presented-pixels',
    ceilingAssessment: endpoint.ceilingAssessment ?? 'unavailable', reason: endpoint.reason ?? null});
  const actions = joined.actions.map((action, sequence) => ({id: record.actions[sequence].id, sequence, family: action.identity.family,
    acknowledgement: {...bound(action.acknowledgement), ceilingMs: 100, targetMs: 50},
    pointer: action.identity.family === 'stroke' ? action.endpoints.map((endpoint, index) => ({id: record.actions[sequence].samples[index].id,
      ...bound(endpoint), referenceCeilingMs: 33.4})) : []}));
  const value = {actions, exactLatency: false, requiredActions: 100, requiredPointerSamples: 2400,
    replay: {protocol: nativeSchema, retainedManifestSha256: hash(manifestBytes), originalOutputDirectory: ready[0].outputDirectory,
      replayOutputDirectory: relocatedCapture, outputPathRebased: ready[0].outputDirectory !== relocatedCapture, rawTraceIdentity},
    limitations: {physicalInput: false, exactFirstPaint: false, physicalScanout: false, completeDisplaySlots: false, canonicalVisitINP: false, lazyReadiness: false,
      pointerScope: 'Exact reviewed prefix before next input only; coalesced or dropped prefixes stay unavailable and are not an R07 failure.'}};
  const proof = Object.freeze({kind: 'verified-session-windowserver-bounds-1', qualification: false});
  proofs.set(proof, {attemptId: attempt.id, producerId: record.id, record: structuredClone(comparable(record)), value});
  return proof;
}

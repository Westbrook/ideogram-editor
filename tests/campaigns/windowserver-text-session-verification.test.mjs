import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {verifyTextSessionWindowServerEvidence, readVerifiedTextSessionBounds, isTextSessionNativeEvidencePath} from '../../tooling/qualification/campaigns/windowserver-text-session-verification.mjs';
import {TEXT_INPUT_PROFILE, buildTextInputInventory, textInputDescriptor, textInputIdentity, textSessionNativeId, validateTextInput, projectTextInteraction} from '../../tooling/qualification/campaigns/browser-text-input.mjs';
import {buildTextInteractionPlan} from '../../tooling/qualification/campaigns/browser-text.mjs';
import {inspectTextPresentationWitness} from '../../tooling/qualification/campaigns/text-presentation-observation.mjs';
import {textActionOracleSubject, joinTextActionPixels} from '../../tooling/qualification/campaigns/text-action-oracle.mjs';
import {interactionSession, genericRawFeedbackSelection, textRawFeedbackCohort} from '../../tooling/qualification/campaigns/browser.mjs';
import {deriveTextSessionLosslessReservation} from '../../tooling/qualification/campaigns/windowserver-text-session-lossless-budget.mjs';
import {windowServerTextSessionLosslessCapacity, verifyWindowServerTextSessionLosslessCapture} from '../../tooling/qualification/campaigns/windowserver-text-session-lossless.mjs';
import {evaluateSession} from '../../tooling/qualification/campaigns/metrics.mjs';
import {evaluateInteractionCohort, executionGroups, summarize} from '../../tooling/qualification/campaigns/run.mjs';
import {isBrowserWALifecycle} from '../../tooling/qualification/campaigns/browser-wa-observation.mjs';
import {isOrdinaryAdapterImport} from '../../tooling/qualification/campaigns/adapter-import-observation.mjs';
import {normalizeResult} from '../../tooling/qualification/campaigns/worker.mjs';
import {digest, errorRecord, exclusiveJSON, sanitize} from '../../tooling/qualification/campaigns/common.mjs';
import {analyzeDisplayFeedbackTrace} from '../../tooling/qualification/campaigns/display-feedback.mjs';

// AUTHORED ONLY. Tiny literal pixels, synthetic build metadata and synthetic
// clocks exercise replay boundaries; they are never product/performance evidence.
// The full text receipt builder is copied as source from the producer tests,
// not imported from a test module, and bound to real fixture byte hashes here.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const ndjson = rows => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
const pin = (path, bytes) => ({path, bytes: bytes.length, sha256: sha(bytes)});
const file = (bytes, mode) => ({bytes: bytes.length, sha256: sha(bytes), mode});
const beforePixels = Buffer.from([0, 1, 2, 255, 3, 4, 5, 255]);
const afterPixels = Buffer.from([6, 7, 8, 255, 9, 10, 11, 255]);
const uuid = '11111111-1111-4111-8111-111111111111';

function syntheticBuild(sourceBytes, historicalRoot) {
  const scope = 'pinned source/compiler executable/SDK observed build';
  const directory = join(historicalRoot, 'build'), compilerPath = join(historicalRoot, 'compiler'), sdkPath = join(historicalRoot, 'sdk');
  const moduleCache = join(directory, 'module-cache');
  const sdk = {kind: 'windowserver-sdk-tree-1', entries: [{path: '.', type: 'directory', mode: 0o700}]};
  const sdkBytes = json(sdk), sdkTreeDigest = sha(JSON.stringify(sdk));
  const compiler = file(Buffer.from('synthetic compiler metadata; never executed\n'), 0o700), source = file(sourceBytes, 0o600);
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(2, 12);
  // Exact insertion order matches the build protocol's recorded environment.
  const environment = {PATH: dirname(compilerPath) + ':/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'),
    LANG: 'C', LC_ALL: 'C', SDKROOT: sdkPath, SWIFT_MODULECACHE_PATH: moduleCache, CLANG_MODULE_CACHE_PATH: moduleCache};
  const command = (stage, args) => ({stage, executable: compilerPath, args, cwd: directory, environment,
    result: {code: 0, signal: null, timedOut: false, interrupted: false, error: null, timeoutMs: 1000},
    logs: {stdout: pin(stage + '.stdout.log', Buffer.alloc(0)), stderr: pin(stage + '.stderr.log', Buffer.alloc(0))}});
  const receipt = {kind: 'windowserver-collector-build-1', schemaVersion: 1, scope, qualification: false, status: 'PASS',
    startedAt: '2026-09-30T00:00:00.000Z', endedAt: '2026-09-30T00:00:00.000Z', host: {platform: 'synthetic-test', arch: 'arm64', release: 'fixture'}, timeoutMs: 1000,
    pins: {sourceSha256: sha(sourceBytes), compilerSha256: compiler.sha256, sdkTreeDigest},
    source: {path: join(historicalRoot, 'capture.swift'), retainedPath: 'collector.swift', before: source, after: source, retained: source},
    compiler: {path: compilerPath, before: compiler, after: compiler},
    sdk: {path: sdkPath, manifestPath: 'sdk-manifest.json', manifest: {bytes: sdkBytes.length, sha256: sha(sdkBytes)}, beforeDigest: sdkTreeDigest, afterDigest: sdkTreeDigest, entryCount: 1},
    commands: [command('version', ['--driver-mode=swiftc', '--version']), command('build', ['--driver-mode=swiftc', '-O', '-target', 'arm64-apple-macosx15.0',
      '-sdk', sdkPath, '-module-cache-path', moduleCache, '-o', join(directory, 'windowserver-capture'), join(directory, 'collector.swift')])],
    binaryBefore: null, binary: file(binary, 0o700), error: null};
  const receiptBytes = json(receipt);
  const members = [['build-receipt.json', receiptBytes, 0o600], ['collector.swift', sourceBytes, 0o600], ['sdk-manifest.json', sdkBytes, 0o600],
    ...['version.stdout.log', 'version.stderr.log', 'build.stdout.log', 'build.stderr.log'].map(name => [name, Buffer.alloc(0), 0o600]),
    ['windowserver-capture', binary, 0o700]];
  const manifest = {kind: 'windowserver-build-evidence-1', schemaVersion: 1, scope, qualification: false,
    sourceSha256: sha(sourceBytes), receiptSha256: sha(receiptBytes), binarySha256: sha(binary), compilerSha256: compiler.sha256, sdkTreeDigest,
    members: members.map(([path, bytes, mode]) => ({path, ...file(bytes, mode)}))};
  const manifestBytes = json(manifest);
  return {members: [...members, ['manifest.json', manifestBytes, 0o600]], manifestBytes, receiptSha256: sha(receiptBytes), binaryBytes: binary.length, binarySha256: sha(binary),
    receiptPath: join(directory, 'build-receipt.json'), binaryPath: join(directory, 'windowserver-capture')};
}

const sessionId = 'text-test-session';
const copy = value => structuredClone(value);
const inventory = buildTextInputInventory();
const descriptor = (actionId = 'IText-001', stepId = 'focus') => textInputDescriptor({sessionId, actionId, stepId});
function rawInput(identity = descriptor(), start = 10, events = []) {
  return {descriptor: identity, clock: 'browser-performance', timeOrigin: 1700000000000, endedTimeOrigin: 1700000000000,
    armedMs: start, stoppedMs: start + 1, visibility: 'visible', endedVisibility: 'visible', targetConnectedAtArm: true,
    targetConnected: true, overflow: false, events: events.map((event, ordinal) => ({eventId: textInputIdentity(identity).localStepId + '/event-' + ordinal,
      ordinal, type: 'input', timeStampMs: start + 0.1 + ordinal * 0.01, observedMs: start + 0.2 + ordinal * 0.01,
      isTrusted: true, targetMatched: true, ...event}))};
}
// Pure receipt fixture, not generated oracle pixels or a native-capture claim.
// Deliberately allows no observed DOM event for a dispatch; inputMs stays null.
function textInteractionRawFixture() {
  const semanticItemIds = ['semantic-item-1', 'semantic-item-2'];
  let selected = semanticItemIds[0];
  let current = {connected: true, start: 0, end: 0, direction: 'none', units: 8, presentation: 'anchored',
    session: 'draft-fixture-1', revision: '7', textVersion: 3, focused: true, switch: {pending: '', request: 0, requestEpoch: 1,
      requestGeneration: 7, requestTextVersion: 3, settled: 0, rejected: 0, superseded: 0, rejectedEpoch: 0, rejectedGeneration: 0,
      rejectedCurrentEpoch: 0, rejectedCurrentGeneration: 0, rejectedTextVersion: 0, rejectedCurrentTextVersion: 0, rejectedGuards: 0, rejectedBoundary: '', reason: ''}};
  const witness = {kind: 'text-presentation-observation-1', requests: [], latest: null, cancellation: null};
  const state = (native, observedMs, terminal = false, selection = selected) => ({clock: 'browser-performance', timeOrigin: 1700000000000,
    observedMs, visibility: 'visible', native: copy(native), contentSha256: 'a'.repeat(64), semanticSelection: terminal ? null : selection,
    format: terminal ? {fontChoice: null, lineHeight: null, frameWidth: null, frameHeight: null} :
      {fontChoice: 'NotoSans', lineHeight: '1.2', frameWidth: '360', frameHeight: '180'}});
  const actions = inventory.map(plan => {
    const beforeSelection = selected;
    if (plan.kind === 'semantic-selection') selected = semanticItemIds[plan.index];
    const beforeNative = copy(current), afterNative = copy(current), browserStart = 100 + plan.sequence * 20;
    if (plan.kind === 'presentation') {
      const target = (current.switch.pending || current.presentation) === 'anchored' ? 'inspector' : 'anchored';
      afterNative.switch.request++;
      if (plan.mode === 'immediate') {afterNative.presentation = target; afterNative.switch.settled = afterNative.switch.request;}
      else {
        if (current.switch.pending) Object.assign(afterNative.switch, {superseded: current.switch.request, rejected: current.switch.request, reason: 'superseded'});
        afterNative.switch.pending = target;
      }
      witness.requests.push({actionId: plan.id, mode: plan.mode, target, before: copy(beforeNative), after: copy(afterNative)});
    }
    if (plan.kind === 'composition-end' && plan.sequenceInComposition === 8) {
      afterNative.presentation = current.switch.pending; afterNative.switch.pending = ''; afterNative.switch.settled = current.switch.request;
      witness.latest = {beforeEnd: copy(beforeNative), afterEnd: copy(afterNative)};
    }
    if (plan.cancelSession) {
      afterNative.session = ''; afterNative.revision = '8'; afterNative.textVersion = 4;
      Object.assign(afterNative.switch, {pending: '', rejected: current.switch.request, reason: 'cancelled',
        rejectedEpoch: current.switch.requestEpoch, rejectedGeneration: current.switch.requestGeneration, rejectedTextVersion: current.switch.requestTextVersion,
        rejectedCurrentEpoch: current.switch.requestEpoch + 1, rejectedCurrentGeneration: 8, rejectedCurrentTextVersion: 4,
        rejectedGuards: 7, rejectedBoundary: 'cancel-native-end'});
      witness.cancellation = {beforeCancel: copy(beforeNative), afterCancel: copy(afterNative)};
    }
    current = afterNative;
    const inputMs = 1000 + plan.scheduledMs;
    return {id: plan.id, kind: plan.kind, scheduledMs: plan.scheduledMs, scheduledAtMs: inputMs, inputLatenessMs: 0, inputMs, readyMs: inputMs + 10, durationMs: 10,
      outcome: 'completed', nativeInput: {before: state(beforeNative, browserStart, false, beforeSelection), after: state(afterNative, browserStart + 15, plan.cancelSession),
        dispatches: plan.steps.map((step, index) => {
          const identity = descriptor(plan.id, step.stepId);
          return {descriptor: identity, nativeActionId: textInputIdentity(identity).nativeActionId, dispatchCompleted: true,
            clock: 'runner-monotonic', dispatchStartedMs: inputMs + index, dispatchCompletedMs: inputMs + index + 0.5,
            inputEvidence: validateTextInput(rawInput(identity, browserStart + 1 + index * 2), identity),
            nativeBracket: {fixtureOnly: true}, nativeBracketVerified: false, missing: [], qualification: false};
        })}};
  });
  const textFixture = {schema: 'browser-text-fixture-1', manifestHash: 'sha256:' + 'b'.repeat(64),
    corpus: {sha256: 'sha256:' + 'a'.repeat(64), bytes: 8, fragmentsHash: 'sha256:' + 'c'.repeat(64), fragmentCount: 20,
      scripts: ['latin-combining', 'arabic-rtl', 'devanagari', 'cjk', 'emoji', 'newlines', 'unbroken']},
    fonts: ['NotoSans', 'NotoSansArabic', 'NotoSansDevanagari', 'NotoSansCJK'].map((id, index) => ({id, sha256: 'sha256:' + String(index + 1).repeat(64), bytes: 1024, kind: 'bundled', licenseSha256: null})),
    semanticItemIdsHash: 'sha256:' + createHash('sha256').update(JSON.stringify(semanticItemIds)).digest('hex'),
    activeLayerId: null, activeLayerIndex: null, fontSetPreseeded: false};
  return {textInputSessionId: sessionId, textFixture, semanticItemIds, sealedSemanticItemIds: [...semanticItemIds],
    native: {overflow: false, sameNode: true, sameConnectedParent: true, disconnected: false}, textPresentation: {sameConnectedNode: true}, actions, presentationWitness: witness,
    segment: {clock: 'runner-monotonic', startMs: 1000, endMs: 61000, requestedMs: 60000, captureStoppedMs: 61001,
      completedActionsAtMs: actions.at(-1).readyMs - 1000, actions: 106}};
}


const limitations = [
  'A fresh allocation sample is a non-atomic observation, not a storage reservation or filesystem quota.',
  'Logical file bounds, block rounding and directory allowances do not bound filesystem-wide metadata, snapshots or concurrent writers.',
  'The existing outer evidence monitor must remain active and its separately retained final audit must pass; this admission grants no qualification.',
];
function counter(overrides = {}) {
  return {kind: 'evidence-volume-sample-1', startedAt: '2026-09-30T12:00:00.000Z', finishedAt: '2026-09-30T12:00:00.001Z',
    startMs: 20, endMs: 21, method: 'bounded-nofollow-streaming-lstat', consistency: 'non-atomic-observation-window',
    completeTraversal: true, entries: 3, concurrentChanges: 0, uniqueFiles: 1, repeatedInodes: 0,
    observedLogicalBytes: 90000000, observedAllocatedBytes: 100000000, failures: [],
    limitations: ['Synthetic non-atomic sample; no live allocation was observed.'], ...overrides};
}
function expectedAlarm(sample, capacityBytes) {
  if (!sample.completeTraversal || sample.observedAllocatedBytes === null) return {status: 'INCONCLUSIVE', level: 'unknown', percent: null};
  const percent = sample.observedAllocatedBytes / capacityBytes * 100;
  return {status: percent >= 90 ? 'FAIL' : 'PASS', level: percent >= 90 ? 'ceiling' : percent >= 80 ? 'target' : 'normal', percent};
}

function admissionFor({authority, allocationBytes, evidenceAllocation, evidenceReservation, requestedConfig, outputDirectory, ino}) {
  const sample = counter(), capacityBytes = authority.capacityBytes, allocationIdentity = {bytes: allocationBytes.length, sha256: sha(allocationBytes)};
  const reservation = deriveTextSessionLosslessReservation({config: requestedConfig, evidenceReservation, filesystemBlockBytes: 4096, allocationSourceBytes: allocationBytes.length});
  return {kind: 'windowserver-text-session-evidence-admission-1', allocationPath: evidenceAllocation.path,
    allocation: {...authority, identity: allocationIdentity, directoryIdentity: {dev: '1', ino: '11', uid: '501', mode: String(0o40700)}},
    outputDirectory, directoryIdentity: {dev: '1', ino: String(ino), uid: '501', mode: String(0o40700)}, sample,
    alarm: expectedAlarm(sample, capacityBytes), filesystemBlockBytes: 4096, capacity: structuredClone(reservation.capacity),
    evidenceReservation: structuredClone(evidenceReservation), reservation,
    config: {...structuredClone(requestedConfig), evidenceBudget: {capacityBytes, observedAllocatedBytes: sample.observedAllocatedBytes,
      reservationBytes: evidenceReservation.bytes, allocationSha256: allocationIdentity.sha256,
      nativeArtifactBytes: evidenceReservation.nativeArtifactBytes}}, status: 'PASS', reason: null,
    qualification: false, limitations: [...limitations]};
}

async function fixture(t, {rawFeedback = false, cache = 'warm', ordinal = 1, acknowledgementMs = 25, lastAcknowledgementMs = acknowledgementMs,
  mutateProducer, mutateProcess, mutateBinding, mutateOracle, mutateBrowser, mutateAdmission, mutateFinalSample, mutateTrace, unavailableSequence, equalSequence} = {}) {
  const protocol = 4;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'text-retained-protocol-'))); await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  const groupOutput = join(root, 'absent-original-group'), historicalRoot = join(root, 'absent-build-inputs'), archive = join(root, 'relocated-evidence');
  await mkdir(archive, {mode: 0o700});
  const members = new Map(), modes = new Map(), put = (path, bytes, mode = 0o600) => {members.set(path, bytes); modes.set(path, mode); return pin(path, bytes);};
  const persist = async () => {for (const [path, bytes] of members) {const destination = join(archive, path);
    await mkdir(dirname(destination), {recursive: true, mode: 0o700}); await writeFile(destination, bytes, {mode: modes.get(path)}); await chmod(destination, modes.get(path));}};
  const raw = textInteractionRawFixture(), nativeSessionId = textSessionNativeId(sessionId), transaction = 'native-' + nativeSessionId,
    oracleFolder = 'oracle-' + nativeSessionId, captureFolder = transaction + '/capture';
  const cell = {id: 'Q3/text-interaction', operation: 'text.interaction', workload: 'WXn', handler: 'browser', kind: 'operation',
    parameters: {browser: 'chromium', durationMs: 60000, profile: TEXT_INPUT_PROFILE}};
  const attemptId = `${cell.id}/${cache}/scored/${ordinal}`, workerPid = 100, workerProcessIdentity = {pid: workerPid, startedAt: '2026-09-30T11:59:59.000Z', node: 'v26.10.0'};
  const collectorBytes = Buffer.from('// synthetic session collector protocol ' + protocol + '; never compiled\n'), build = syntheticBuild(collectorBytes, historicalRoot);
  for (const [name, bytes, mode] of build.members) put(transaction + '/build-evidence/' + name, bytes, mode);
  const textCorpus = 'abcdefgh', fragments = Array.from({length: 20}, (_, i) => 'fragment-' + i);
  raw.textFixture.corpus = {...raw.textFixture.corpus, sha256: 'sha256:' + sha(textCorpus), bytes: Buffer.byteLength(textCorpus),
    fragmentsHash: 'sha256:' + sha(JSON.stringify(fragments)), fragmentCount: fragments.length};
  raw.syntheticComposition = true;
  raw.segment.actualMs = raw.segment.captureStoppedMs - raw.segment.startMs; raw.segment.reservedFeedbackMs = 600;
  const presentation = inspectTextPresentationWitness(raw.presentationWitness);
  for (const name of ['latestDeferredOnlyAfterNativeEnd', 'cancelDropsDeferred', 'staleDeferredRequestRejected', 'deferredRequestRejection']) raw.textPresentation[name] = presentation[name];
  Object.assign(raw.textPresentation, {forwardRangePreserved: true, backwardRangePreserved: true, collapsedRangePreserved: true, observationBoundary: presentation.boundary});
  for (const action of raw.actions) {
    action.nativeSource = 'explicit-per-substep-delivery';
    action.nativeInput.before.contentSha256 = sha(textCorpus); action.nativeInput.after.contentSha256 = sha(textCorpus);
    for (const step of action.nativeInput.dispatches) {
      const delivery = step.descriptor.input.delivery, event = delivery === 'browser-input-api' ? {isTrusted: true} :
        delivery === 'synthetic-dom-event' ? {type: step.descriptor.input.eventType, isTrusted: false} : null;
      step.inputEvidence = validateTextInput(rawInput(step.descriptor, step.inputEvidence.armedMs, event ? [event] : []), step.descriptor);
    }
  }
  const selectedFixture = {workload: 'WXn', seal: {path: '/absent/fixture/manifest.json', sha256: 'f'.repeat(64)},
    text: {...raw.textFixture, corpus: {...raw.textFixture.corpus, text: textCorpus, fragments}, semanticItemIds: [...raw.sealedSemanticItemIds]}};
  const runtime = {headless: false, browserPid: 23, backendPid: 24, engine: 'chromium', version: 'fixture-version', revision: 'fixture-revision',
    executable: '/absent/browser-cache/chromium/browser', executableIdentity: {bytes: 1, sha256: 'sha256:' + 'e'.repeat(64)},
    playwrightModule: '/absent/prepared/source/node_modules/playwright/index.js', root: join(groupOutput, 'root'), fixtureSeal: selectedFixture.seal,
    viewport: {width: 1600, height: 1400}, deviceScaleFactor: 1, proxyRoute: {status: 'PASS'}, capabilitySetup: {status: 'PASS'}};
  const sourceRoot = '/absent/prepared/source', subjectDigest = 'sha256:' + 'c'.repeat(64), browserCache = '/absent/browser-cache';
  const state = {productRepo: sourceRoot, sourceDigest: subjectDigest, h: {source: sourceRoot, workspace: dirname(sourceRoot), completed: true, browserCache,
    browserIdentity: {cache: {sha256: 'sha256:' + 'd'.repeat(64)}, engines: [{engine: runtime.engine, executable: runtime.executable,
      version: runtime.version, revision: runtime.revision, ...runtime.executableIdentity}]}}};
  const developerState = {kind: 'developer-runtime-state-1', state, sha256: sha(json(state))}, developerStateIdentity = pin('/absent/prepared/state.json', json(developerState));
  const tools = {node: {executable: '/absent/node', version: '26.10.0'}, browserPins: {browsers: [{name: runtime.engine, browserVersion: runtime.version, revision: runtime.revision}]}};
  for (const [kind, pid, executable] of [['browser', runtime.browserPid, runtime.executable], ['backend', runtime.backendPid, tools.node.executable]]) {
    const registrationPath = 'owned-process-' + pid + '-' + uuid + '.json', process = {kind, pid, pgid: pid, startedAtIdentity: 'synthetic-' + kind + '-birth', executable};
    const registration = json({kind: 'perf-owned-processes-1', ownerPid: workerPid, processes: [process]}); put(registrationPath, registration);
    if (kind === 'browser') runtime.ownedLaunch = {context: {createdBy: 'browser.newContext', freshAtLaunch: true},
      process: {...process, registration: pin(join(groupOutput, registrationPath), registration)}};
  }
  mutateBrowser?.({runtime, state, developerState, developerStateIdentity, tools}); put('browser-runtime.json', json(runtime));
  const environmentValue = {engine: runtime.engine, version: runtime.version, revision: runtime.revision,
    executableSha256: runtime.executableIdentity.sha256.replace(/^sha256:/, ''), viewport: runtime.viewport, deviceScaleFactor: runtime.deviceScaleFactor};
  const environment = {fixtureSha256: selectedFixture.seal.sha256, browserEnvironmentSha256: sha(JSON.stringify(environmentValue)), environment: environmentValue};
  const roi = {x: 4, y: 3, width: 2, height: 1}, display = {id: 7, width: 100, height: 60}, bounds = {x: 0, y: 0, width: 100, height: 60};
  const requestedConfig = {schemaVersion: protocol, profile: TEXT_INPUT_PROFILE, storageFormat: 'rfc1951-previous-roi-1', displayID: display.id, expectedBrowserPid: runtime.browserPid, roi};
  const clock = (id, value) => ({schemaVersion: protocol, event: 'clock', id, mach: String(value)}), rows = [], images = [];
  const anchor = (boundary, value) => ({kind: 'text-native-session-anchor-1', status: 'complete', boundary, sessionId, nativeSessionId,
    ack: clock(nativeSessionId + (boundary === 'begin' ? '-win-before' : '-win-after'), value)});
  raw.nativeSessionStart = anchor('begin', 1000000000); raw.nativeSessionEnd = anchor('end', 63000000000); rows.push(raw.nativeSessionStart.ack);
  // Independent native test ticks, deliberately not converted from either the
  // runner or browser clock. Each original step keeps a distinct bracket.
  for (const [sequence, action] of raw.actions.entries()) for (const [index, step] of action.nativeInput.dispatches.entries()) {
    const nativeActionId = textInputIdentity(step.descriptor).nativeActionId;
    const a = 1010000000 + sequence * 550000000 + index * 1000000, before = clock(nativeActionId + '-before', a), after = clock(nativeActionId + '-after', a + 500000);
    step.nativeBracket = {kind: 'native-action-bracket-1', actionId: nativeActionId, status: 'complete', actionCompleted: true, before, after};
    rows.push(before, after);
  }
  rows.push(raw.nativeSessionEnd.ack);
  const projection = projectTextInteraction(raw, {sessionId}); assert.equal(projection.status, 'PASS', JSON.stringify({missing: projection.missing, failures: projection.failures}));
  const beforePin = pin('pixels/before.bgra', beforePixels), afterPin = pin('pixels/after.bgra', afterPixels);
  const oracle = {kind: 'text-action-pixel-oracle-1', schemaVersion: 1, profile: TEXT_INPUT_PROFILE,
    binding: {fixtureSha256: environment.fixtureSha256, browserEnvironmentSha256: environment.browserEnvironmentSha256}, display, roi, pixelFormat: 'BGRA8',
    actions: projection.actions.map((action, sequence) => ({sequence, actionId: action.identity.actionId, family: action.identity.family, stateSha256: action.stateSha256,
      subject: textActionOracleSubject(buildTextInputInventory()[sequence]), ...(sequence === unavailableSequence ? {kind: 'unavailable', reason: 'independent-pixels-not-supplied'} :
        {kind: 'pixels', before: beforePin, after: afterPin})}))};
  if (equalSequence !== undefined) oracle.actions[equalSequence].after = beforePin;
  const sample = (time, pixels) => {const ordinal = images.length + 1; images.push(pixels);
    return {schemaVersion: protocol, event: 'sample', ordinal, statusRaw: 0, status: 'complete', ownerPID: 23, windowNumber: 9,
      windowObservationMach: String(time + 101), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0,
      callbackMach: String(time + 100), displayTimeMach: String(time), pts: {value: '0', timescale: 1, flags: 0, epoch: '0'},
      pixelFormat: 1111970369, width: display.width, height: display.height, roi, retained: true, file: `frame-${ordinal}.bgra`,
      sha256: sha(pixels), byteLength: pixels.length, contentScale: 1, scaleFactor: 1};};
  for (const [sequence, action] of projection.actions.entries()) {
    const first = Number(action.dispatches[0].nativeBracket.before.mach);
    rows.push(sample(first - 2000000, beforePixels));
    rows.push(sample(first + Math.round((sequence === 105 ? lastAcknowledgementMs : acknowledgementMs) * 1000000), afterPixels));
  }
  rows.sort((a, b) => Number(BigInt(a.mach ?? a.callbackMach) - BigInt(b.mach ?? b.callbackMach)));
  const authority = {kind: 'evidence-volume-allocation-1', allocationId: 'synthetic-session', purpose: 'qualification-evidence-only',
    capacityBytes: 32 * 1024 ** 3, root, issuedAt: '2026-09-30T11:00:00.000Z', owner: 'synthetic-owner'};
  const allocationBytes = json(authority), allocationIdentity = {bytes: allocationBytes.length, sha256: sha(allocationBytes)},
    evidenceAllocation = {path: join(historicalRoot, 'allocation.json'), ...allocationIdentity};
  const evidenceReservation = {bytes: 2 * 1024 ** 3, nativeArtifactBytes: 128 * 1024 ** 2, trace: {bytes: 32 * 1024 ** 2, files: 3, directories: 2},
    oracle: {bytes: 16 * 1024 ** 2, files: 4, directories: 2}, control: {bytes: 8 * 1024 ** 2, files: 20, directories: 4}};
  const admissionInputs = {authority, allocationBytes, evidenceAllocation, evidenceReservation, requestedConfig};
  const initialAdmission = admissionFor({...admissionInputs, outputDirectory: groupOutput, ino: 22}),
    preparation = admissionFor({...admissionInputs, outputDirectory: join(groupOutput, transaction), ino: 33}),
    admission = admissionFor({...admissionInputs, outputDirectory: join(groupOutput, transaction), ino: 33}), config = structuredClone(admission.config);
  const capacity = windowServerTextSessionLosslessCapacity(roi, evidenceReservation.nativeArtifactBytes);
  const storageAdmission = {availableBytesBefore: String(authority.capacityBytes - counter().observedAllocatedBytes),
    reservedArtifactBytes: evidenceReservation.nativeArtifactBytes,
    evidenceBudget: {...config.evidenceBudget}, targetAlarmAtReservation: false};
  const encodedChunks = []; let encodedOffset = 0, duplicateFrames = 0, previousSample = null;
  for (const row of rows.filter(row => row.event === 'sample')) {
    row.file = 'pixels.bin';
    if (previousSample?.sha256 === row.sha256) {row.pixelStorage = {kind: 'reference', ordinal: previousSample.ordinal}; duplicateFrames++;}
    else {const encoded = deflateRawSync(images[row.ordinal - 1], {windowBits: 15}); encodedChunks.push(encoded);
      row.pixelStorage = {kind: 'deflate-raw', offset: encodedOffset, encodedBytes: encoded.length, encodedSha256: sha(encoded)}; encodedOffset += encoded.length;}
    previousSample = row;
  }
  const nativeContainer = Buffer.concat(encodedChunks);
  const geometry = {displayBoundsPoints: {...bounds}, backingScale: {x: 1, y: 1}, displayPoints: {...bounds}, modePixels: {width: 100, height: 60},
    filterPoints: {...bounds}, pointPixelScale: 1, scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'};
  const windowAdmission = {ownerPID: 23, windowNumber: 9, bounds, layer: 0, alpha: 1, onScreen: true, roiPoints: {...roi},
    aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0}, timebase = {numer: 1, denom: 1};
  const framesBytes = ndjson(rows), manifest = {kind: 'windowserver-text-session-capture-4', schemaVersion: protocol, config, capacity, storageAdmission, display,
    captureGeometry: geometry, windowAdmission, timebase, startedMach: '0', endedMach: '64000000000', terminalReason: 'requested-stop',
    lossObservations: {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null},
    counts: {sampleRecords: images.length, completeFrames: images.length, clockRecords: 496, pixelBytes: images.length * 8, unretainedSamples: 0,
      encodedPixelBytes: nativeContainer.length, duplicateFrames},
    frames: pin('frames.ndjson', framesBytes), pixelContainers: [pin('pixels.bin', nativeContainer)]};
  const manifestBytes = json(manifest), ready = {...structuredClone(manifest), event: 'ready', outputDirectory: join(groupOutput, captureFolder), roi,
    pixelByteLimit: capacity.maxEncodedPixelBytes, metadataByteLimit: capacity.metadataByteLimit, manifestByteLimit: capacity.manifestByteLimit,
    maxClockRecords: capacity.maxClockRecords, pointPixelScale: 1};
  for (const key of ['endedMach', 'terminalReason', 'counts', 'frames', 'pixelFiles', 'pixelContainers', 'lossObservations']) delete ready[key];
  const stopped = {schemaVersion: protocol, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'};
  const stdout = ndjson([ready, ...rows, stopped]), configBytes = json(config);
  put(captureFolder + '/manifest.json', manifestBytes); put(captureFolder + '/frames.ndjson', framesBytes);
  put(captureFolder + '/pixels.bin', nativeContainer);
  put(transaction + '/stdout.ndjson', stdout); put(transaction + '/stderr.log', Buffer.alloc(0)); put(transaction + '/config.json', configBytes);
  await persist();
  // This lower-level replay reconstructs the producer's repeated join from the
  // complete ordinary-file bytes. It cannot create a session evaluator proof.
  const captured = await verifyWindowServerTextSessionLosslessCapture(join(archive, captureFolder), {manifestSha256: sha(manifestBytes), expectedConfig: config,
    expectedReady: {...ready, outputDirectory: join(archive, captureFolder)}, expectedStopped: stopped, processExitCode: 0});
  const originalOracleBytes = json(oracle), joined = joinTextActionPixels(captured, {raw, projection, oracleBytes: originalOracleBytes, oracleSha256: sha(originalOracleBytes),
    pixelIdentities: [beforePin, afterPin], binding: {...oracle.binding, browserPid: 23, windowNumber: 9}});
  mutateOracle?.(oracle); const oracleBytes = json(oracle); put(oracleFolder + '/oracle.json', oracleBytes);
  let selectedOracleStorage = null, retainedOracleStorage = null;
  {
    const reviewBytes = Buffer.from('Synthetic independent oracle review provenance; protocol test fixture only.\n'), reviewReference = 'synthetic-independent-review';
    const encoded = [beforePixels, afterPixels].map(bytes => deflateRawSync(bytes, {windowBits: 15})), containerBytes = Buffer.concat(encoded);
    const index = {kind: 'rfc1951-oracle-pixels-1', schemaVersion: 1, oracleSha256: sha(oracleBytes), reviewSha256: sha(reviewBytes), reviewReference,
      pixels: [beforePin, afterPin].map((pixel, index) => ({...pixel, pixelStorage: {kind: 'deflate-raw', offset: index ? encoded[0].length : 0,
        encodedBytes: encoded[index].length, encodedSha256: sha(encoded[index])}}))};
    const indexBytes = json(index);
    selectedOracleStorage = {kind: 'rfc1951-oracle-pixels-1', index: pin(join(historicalRoot, 'oracle-pixels.json'), indexBytes),
      container: pin(join(historicalRoot, 'oracle-pixels.bin'), containerBytes), review: pin(join(historicalRoot, 'semantic-review.record'), reviewBytes)};
    retainedOracleStorage = {...selectedOracleStorage, index: pin(join(groupOutput, oracleFolder, 'oracle-pixels.json'), indexBytes),
      container: pin(join(groupOutput, oracleFolder, 'oracle-pixels.bin'), containerBytes), review: pin(join(groupOutput, oracleFolder, 'semantic-review.record'), reviewBytes), reviewReference};
    put(oracleFolder + '/oracle-pixels.json', indexBytes); put(oracleFolder + '/oracle-pixels.bin', containerBytes); put(oracleFolder + '/semantic-review.record', reviewBytes);
  }
  mutateAdmission?.({initialAdmission, preparation, admission});
  const initialBytes = json(initialAdmission), preparationBytes = json(preparation), admissionBytes = json(admission);
  put(oracleFolder + '/allocation.json', allocationBytes); put(oracleFolder + '/allocation-admission.json', initialBytes);
  put(transaction + '/evidence-budget/allocation-source.json', allocationBytes); put(transaction + '/evidence-budget/preparation.json', preparationBytes);
  put(transaction + '/evidence-budget/admission.json', admissionBytes);
  const finalValue = {kind: 'windowserver-session-evidence-final-sample-1', allocationIdentity, capacityBytes: authority.capacityBytes,
    sample: counter(), alarm: expectedAlarm(counter(), authority.capacityBytes)}; mutateFinalSample?.(finalValue);
  const finalBytes = json(finalValue); put(transaction + '/evidence-budget/final-sample.json', finalBytes);
  const buildSelection = {receiptPath: build.receiptPath, receiptSha256: build.receiptSha256};
  const selection = {kind: 'windowserver-text-actions-configuration-1', build: buildSelection,
    storageFormat: 'rfc1951-previous-roi-1',
    oracle: {path: join(historicalRoot, 'oracle.json'), sha256: sha(oracleBytes), storage: selectedOracleStorage}, displayID: 7, roi, evidenceAllocation, evidenceReservation};
  const rawOwnership = {kind: 'owned-isolated-synthetic-browser-1', admittedBy: 'root', owned: true, isolated: true,
    syntheticOnly: true, sessionOwned: true, browserInstanceId: 'synthetic-session-raw-1'};
  const configuration = {browser: {engine: 'chromium', windowServerTextActions: selection,
    ...(rawFeedback ? {rawDisplayFeedback: {ownership: rawOwnership}} : {})}};
  const rawSelection = rawFeedback ? {...genericRawFeedbackSelection(configuration.browser.rawDisplayFeedback, runtime, runtime.browserPid),
    artifactPath: join(groupOutput, 'browser-feedback-1.raw.json')} : null;
  const sourcePlan = buildTextInteractionPlan(), retainedPlan = sourcePlan.map(({key, ...row}) => key === undefined ? row : {...row, inputKey: key});
  const textAttempt = {kind: 'text-campaign-attempt-1', workload: cell.workload, sessionId, attemptId, processIdentity: workerProcessIdentity,
    fixtureSeal: selectedFixture.seal, textFixture: copy(raw.textFixture),
    actionPlan: {sha256: 'sha256:' + sha(JSON.stringify(retainedPlan)), sourcePlanSha256: 'sha256:' + sha(JSON.stringify(sourcePlan)), actions: retainedPlan,
      durationMs: 60000, refreshHz: 60, observedExecution: false, physicalInput: false, compositionEvents: 'synthetic-app-handling'}};
  const binding = {kind: 'text-windowserver-input-binding-1', profile: TEXT_INPUT_PROFILE, sessionId, nativeSessionId, textAttempt,
    invocation: {cellId: cell.id, operation: cell.operation, serial: 1, sample: {cache, ordinal, prime: false},
      producerPath: join(groupOutput, 'browser-cell-1.json'), tracePath: join(groupOutput, 'browser-trace-1.json'), rawFeedback: rawSelection},
    collectorSource: pin(join(historicalRoot, 'capture.swift'), collectorBytes), build: buildSelection, browser: runtime, environment, config: requestedConfig,
    evidenceAllocation, evidenceReservation, oracle: {...pin(join(groupOutput, oracleFolder, 'oracle.json'), oracleBytes), pixels: [beforePin, afterPin], storage: retainedOracleStorage},
    allocationAdmissionPath: join(groupOutput, oracleFolder, 'allocation-admission.json'), allocationSourcePath: join(groupOutput, oracleFolder, 'allocation.json'),
    semanticOracleReview: {requirement: 'external-independently-reviewed-exact-pixels-required', reference: retainedOracleStorage.reviewReference,
      reviewSha256: retainedOracleStorage.review.sha256, generatedByCapture: false, authorityFromFlags: false}, historicalWindowOcclusion: 'adjacent-native-observations-not-atomic-at-frame-time'};
  mutateBinding?.(binding); put(oracleFolder + '/binding.json', json(binding));
  const processIdentity = {kind: 'windowserver', ownerPid: workerPid, pid: 123, pgid: 123, startedAtIdentity: 'synthetic-native-birth', executable: build.binaryPath};
  const registrationPath = 'owned-process-123-' + uuid + '.json', registrationBytes = json({kind: 'perf-owned-processes-1', ownerPid: workerPid,
    processes: [{kind: 'windowserver', pid: 123, pgid: 123, startedAtIdentity: processIdentity.startedAtIdentity, executable: build.binaryPath}]}); put(registrationPath, registrationBytes);
  const volume = {kind: 'windowserver-text-session-evidence-reference-1', allocation: pin('evidence-budget/allocation-source.json', allocationBytes),
    preparation: pin('evidence-budget/preparation.json', preparationBytes), admission: pin('evidence-budget/admission.json', admissionBytes),
    finalSample: pin('evidence-budget/final-sample.json', finalBytes), allocationIdentity, capacityBytes: authority.capacityBytes,
    selectedAllocation: evidenceAllocation, selectedReservation: evidenceReservation, requestedConfig,
    requiredOuterAudit: {kind: 'evidence-volume-reference-1', allocationIdentity, qualification: false}, qualification: false};
  const processRecord = {kind: 'windowserver-text-session-owned-process-4', schemaVersion: protocol, qualification: false, outcome: 'CAPTURE_REPLAYED',
    startedAt: '2026-09-30T12:00:00.000Z', endedAt: '2026-09-30T12:01:02.000Z', runtime: {platform: 'synthetic-test', arch: 'arm64', release: 'fixture'},
    authorizedSource: binding.collectorSource, processIdentity, registration: pin(join(groupOutput, registrationPath), registrationBytes),
    build: {...buildSelection, sourceSha256: sha(collectorBytes)}, evidenceVolume: volume,
    buildEvidence: {...pin('build-evidence/manifest.json', build.manifestBytes), sourceSha256: sha(collectorBytes), receiptSha256: build.receiptSha256, binarySha256: build.binarySha256},
    executable: {path: build.binaryPath, bytes: build.binaryBytes, sha256: build.binarySha256},
    command: [build.binaryPath, join(groupOutput, transaction, 'config.json'), join(groupOutput, captureFolder)],
    config: pin('config.json', configBytes), outputDirectory: join(groupOutput, captureFolder), captureDirectoryIdentity: {dev: 1, ino: 44},
    exit: {code: 0, signal: null}, close: {code: 0, signal: null}, requestedSignals: [], cleanupErrors: [], failure: null,
    streamBytesObserved: {stdout: stdout.length, stderr: 0}, stdout: pin('stdout.ndjson', stdout), stderr: pin('stderr.log', Buffer.alloc(0)),
    manifest: pin('capture/manifest.json', manifestBytes)};
  mutateProcess?.(processRecord); const processBytes = json(processRecord); put(transaction + '/process.json', processBytes);
  const observation = {kind: 'text-windowserver-observation-1', nativeSchemaVersion: protocol, profile: TEXT_INPUT_PROFILE, sessionId, nativeSessionId, qualification: false,
    binding, ready, config, processIdentity, nativeSessionStart: raw.nativeSessionStart, nativeSessionEnd: raw.nativeSessionEnd, inputBound: true,
    projection, join: joined, lossObservations: manifest.lossObservations,
    evidence: {manifest: pin(join(groupOutput, captureFolder, 'manifest.json'), manifestBytes),
      process: {...processRecord, receipt: pin(join(groupOutput, transaction, 'process.json'), processBytes)}},
    failedProcess: null, evidenceAdmission: null, evidenceVolumeStatus: null, missing: joined.status === 'OBSERVED' ? [] : ['text-native-endpoint-coverage-incomplete'], failures: [],
    limitations: {physicalInput: false, firstPresentedFrame: false, physicalScanout: false, completeDisplaySlots: false, opaqueEvaluatorProof: false, browserNativeClockConversion: false}};
  const trace = {kind: 'sanitized-chromium-trace-1', clock: 'chromium-monotonic-microseconds', collection: {status: 'complete', completeEventReceived: true, reasons: []},
    events: [{cat: 'devtools.timeline', name: 'Paint', ph: 'X', pid: 50, tid: 51, ts: 100, dur: 1}]};
  let rawRoute = null;
  if (rawFeedback) {
    const rawBytes = Buffer.from(JSON.stringify({traceEvents: trace.events})), rawPath = 'browser-feedback-1.raw.json', artifactPath = join(groupOutput, rawPath);
    const manifest = {kind: 'display-feedback-raw-trace-1', qualification: false, provenanceRequired: true,
      ownership: {...rawOwnership, validation: 'caller-declaration-only'}, browserVersion: {status: 'observed', product: 'Chrome/' + runtime.version},
      protocol: {transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none', enableArgumentFilter: false},
      collection: {status: 'complete', reasons: [], startOutcome: 'acknowledged', completeEventReceived: true,
        completionOwnership: 'acknowledged-own-start', foreignTraceObserved: false, dataLossOccurred: false, streamReceived: true, eof: true, bytes: rawBytes.length},
      artifact: {...pin(artifactPath, rawBytes), exists: true, persistedSize: rawBytes.length, hashScope: 'completed-file', hashVerifiedAgainstSize: true,
        fileMayChangeAfterReturn: false, format: 'json', compression: 'none', contentValidation: 'not-performed', rawClosed: true},
      cleanup: {endRequested: true, streamCloseAttempted: true, streamClosed: true, detachAttempted: true, detached: true, browserClosed: false,
        browserCleanupRequired: false, unresolvedAdditionalStream: false, artifactCleanupRequired: false, lateOperations: []},
      manifest: {path: artifactPath + '.manifest.json', saved: true, sidecar: 'provisional-requires-returned-save-acknowledgement',
        returnedReceiptAuthority: 'requires-owning-producer-receipt'}};
    put(rawPath, rawBytes);
    // The standalone sidecar is deliberately provisional. Only the owning
    // producer's returned receipt can supply the successful save/close ACK.
    const sidecar = structuredClone(manifest); sidecar.manifest.saved = false; sidecar.collection.status = 'incomplete';
    sidecar.collection.reasons = ['manifest-save-unacknowledged']; sidecar.artifact.hashScope = 'persisted-prefix';
    put(rawPath + '.manifest.json', json(sidecar));
    const analysis = await analyzeDisplayFeedbackTrace({chunks: [rawBytes], manifest, cohort: textRawFeedbackCohort({segment: raw.segment, actions: raw.actions, plan: sourcePlan})});
    assert.equal(analysis.rawArtifact.fullJsonValidated, true); assert.equal(analysis.rawArtifact.matchesCollectionManifest, true);
    rawRoute = {kind: 'browser-raw-feedback-route-1', qualification: false, manifest, analysis, rawAndSanitizedShareOneTrace: true,
      fullRawJsonValidated: true, missing: analysis.reasons};
    trace.collection = {status: 'complete', reasons: [], completeEventReceived: true, eventsReceived: trace.events.length, eventsRetained: trace.events.length,
      bytesRetained: trace.events.reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)) + 1, 0),
      maxEvents: 150000, maxBytes: 16 * 1024 ** 2, transport: 'ReturnAsStream', derivedFromVerifiedRaw: true};
  }
  mutateTrace?.(trace); const traceBytes = json(trace); put('browser-trace-1.json', traceBytes);
  const traceSummary = {kind: 'browser-diagnostic-trace', collection: trace.collection, artifact: pin(join(groupOutput, 'browser-trace-1.json'), traceBytes),
    ...(rawFeedback ? {rawFeedback: rawRoute} : {})};
  const session = interactionSession(cell, {cache, ordinal}, raw, traceSummary, 'visible');
  let producer = {cellId: cell.id, operation: cell.operation, status: 'PASS', elapsedMs: 62000, phases: [], measurements: [], measurementUnavailable: [],
    observations: raw, session, nativeText: observation, textFeedback: {invocation: binding.invocation, textAttempt}, evidence: {productPhases: {phases: []}, observedCommandReceipts: [], rawVisits: [], replacedRealms: [], readiness: null},
    network: {counts: {accepted: 1}}, timingSamplesReusable: true, trace: traceSummary, missing: [], error: null,
    failureClassification: {productFailureSeen: false, firstFailureWasPrerequisite: false}, rawConsoleRetained: false, screenshotsRetained: false, clocksJoinedBySubtraction: false};
  // Tamper a serialized-style copy; production input descriptors remain immutable.
  if (mutateProducer) {producer = structuredClone(producer); mutateProducer(producer);}
  put('browser-cell-1.json', Buffer.from(JSON.stringify(sanitize(producer), null, 2)));
  const attempt = sanitize({id: attemptId, cache, ordinal, prime: false, startMs: 100, endMs: 62100, reset: {status: 'PASS', cache}, status: 'PASS',
    result: normalizeResult({...producer, artifacts: [join(groupOutput, 'browser-cell-1.json'), traceSummary.artifact.path]}, 100, 62100)});
  await persist();
  const reads = [], resolutions = [], retainedPaths = [...members.keys()], retainedFiles = [...members].map(([path, bytes]) => pin(path, bytes));
  function retainedPath(path) {assert.equal(isAbsolute(path), false); const actual = resolve(archive, path); assert.ok(actual.startsWith(archive + '/')); return actual;}
  const args = {attempt, cell, serial: 1, configuration, groupOutput, retainedPaths, retainedFiles,
    readRetained: async (path, {maximum}) => {const actual = retainedPath(path); assert.ok(Number.isSafeInteger(maximum) && maximum > 0);
      assert.ok((await stat(actual)).size <= maximum); reads.push(path); return readFile(actual);},
    resolveRetained: async path => {resolutions.push(path); return retainedPath(path);},
    controlFiles: [pin('tooling/qualification/native/windowserver-text-session-lossless-capture.swift', collectorBytes),
      ...['browser.mjs', 'browser-driver.mjs', 'browser-text.mjs', 'browser-text-input.mjs', 'text-action-oracle.mjs', 'text-presentation-observation.mjs',
        'windowserver-text-actions.mjs', 'windowserver-text-session-lossless.mjs', 'windowserver-text-session-lossless-process.mjs',
        'windowserver-text-session-lossless-budget.mjs', 'generic-oracle-lossless.mjs',
        ...(rawFeedback ? ['browser-trace-raw.mjs', 'display-feedback-collector.mjs', 'display-feedback-json.mjs', 'display-feedback.mjs'] : [])]
        .map(name => pin('tooling/qualification/campaigns/' + name, Buffer.from('// synthetic source pin ' + name + '\n')))],
    sourceFiles: [pin('src/ui/shell.ts', Buffer.from('// synthetic subject source\n'))], fixture: selectedFixture, workerPid, workerProcessIdentity, sourceRoot,
    engine: runtime.engine, developerState, developerStateIdentity, subjectDigest, browserCache, tools,
    evidenceStorage: {kind: 'evidence-volume-reference-1', status: 'PENDING', qualification: false, allocationIdentity, root,
      allocationId: authority.allocationId, auditId: 'synthetic-audit', campaignId: 'synthetic-session',
      auditPath: 'audits/synthetic-audit/audit.json', retainedPath: 'evidence-storage/audit.json', intervalMs: 1000}};
  return {root, archive, groupOutput, historicalRoot, transaction, captureFolder, oracleFolder, args, attempt, cell, raw, projection, observation, manifest, processRecord, captured,
    reads, resolutions, producer, members, persist, put, replay: () => verifyTextSessionWindowServerEvidence(args), path: retainedPath,
    record: proof => ({...attempt.result.session, nativePresentationProof: proof})};
}



// Re-seal only the outer inventory for a diagnosed retained corruption. Inner
// source/process/producer identities remain unchanged and must independently fail.
async function replaceOuter(value, path, data) {
  const bytes = Buffer.isBuffer(data) ? data : json(data);
  await writeFile(value.path(path), bytes);
  const index = value.args.retainedFiles.findIndex(file => file.path === path);
  assert.ok(index >= 0); value.args.retainedFiles[index] = pin(path, bytes);
}

test('full relocated text replay binds all 106 actions and 247 dispatches without exact or physical input claims', async t => {
  const value = await fixture(t), proof = await value.replay(); assert.ok(proof);
  const bounds = readVerifiedTextSessionBounds(proof, value.attempt.result.session);
  assert.equal(bounds.requiredActions, 106); assert.equal(bounds.requiredSubsteps, 247); assert.equal(bounds.requiredNativeClocks, 496);
  assert.equal(bounds.requiredPointerSamples, 0); assert.equal(bounds.actions.length, 106);
  assert.equal(bounds.actions.flatMap(action => action.input.dispatches).length, 247);
  assert.ok(bounds.actions.every(action => action.acknowledgement.status === 'OBSERVED' && action.acknowledgement.upperBoundMs === 25 &&
    action.acknowledgement.exactMs === null && action.acknowledgement.lowerMs === null && action.pointer.length === 0));
  assert.equal(bounds.replay.protocol, 4); assert.equal(bounds.replay.outputPathRebased, true);
  assert.equal(bounds.replay.originalOutputDirectory, join(value.groupOutput, value.captureFolder));
  assert.equal(bounds.replay.replayOutputDirectory, join(value.archive, value.captureFolder));
  assert.ok(value.resolutions.every(path => !path.startsWith(value.groupOutput)));
  assert.equal(bounds.limitations.nativeIME, false); assert.equal(bounds.limitations.browserNativeClockConversion, false);
  const dispatches = bounds.actions.flatMap(action => action.input.dispatches);
  assert.ok(dispatches.some(step => step.classification.declaredDelivery === 'browser-input-api' && step.classification.observed === 'trusted-events' && step.inputMs !== null));
  assert.ok(dispatches.some(step => step.classification.declaredDelivery === 'programmatic-dom-api' && step.classification.observed === 'none' && step.inputMs === null));
  assert.ok(dispatches.some(step => step.classification.declaredDelivery === 'synthetic-dom-event' && step.classification.observed === 'synthetic-events' && step.inputMs === null));
  assert.equal(bounds.actions.filter(action => action.input.compositionDelivery === 'synthetic-app-handling').length, 30);
  assert.ok(dispatches.every(step => step.classification.physicalInput === false));
  const evaluated = evaluateSession(value.record(proof), 'IText');
  assert.deepEqual(evaluated.acknowledgements, {n: 0, p95: null, max: null});
  assert.equal(evaluated.upperBounds.acknowledgements.required, 106); assert.equal(evaluated.upperBounds.acknowledgements.n, 106);
  assert.equal(evaluated.upperBounds.acknowledgements.ceilingAssessment, 'observed-upper-bounds-within-ceiling');
  assert.deepEqual(evaluated.upperBounds.acknowledgements.actions[0].input, bounds.actions[0].input);
  assert.equal(evaluated.upperBounds.pointer.required, 0); assert.equal(evaluated.outcome, 'INCONCLUSIVE');
  assert.deepEqual(evaluated.textGuardCoverage.witnessedGuards, ['stale-session', 'stale-generation', 'stale-version']);
  assert.deepEqual(evaluated.textGuardCoverage.unobservedGuards, []);
  assert.equal(evaluated.textGuardCoverage.versionMeaning, 'draft-text-version');
  assert.deepEqual(evaluated.textGuardCoverage.acceptedVersion, {scope: 'accepted-document-layer-version', invariantUnchanged: true, rejectionObserved: false});
  assert.ok(!evaluated.missing.includes('IText:stale-session-rejection-unobserved'));
  assert.ok(!evaluated.missing.includes('IText:stale-version-rejection-unobserved'));
  assert.equal(evaluated.droppedShare60SecondSession, null);
});

test('private text proof rejects copies, changed records, foreign tokens and inconsistent outer identities', async t => {
  const value = await fixture(t), proof = await value.replay(), record = value.attempt.result.session;
  for (const other of [{}, {...proof}, structuredClone(proof), JSON.parse(JSON.stringify(proof)), value.captured,
    {kind: 'verified-session-windowserver-bounds-1', qualification: false}]) assert.equal(readVerifiedTextSessionBounds(other, record), null);
  const changed = structuredClone(record); changed.actions[0].inputMs++;
  assert.equal(readVerifiedTextSessionBounds(proof, changed), null);
  assert.equal(readVerifiedTextSessionBounds(proof, {...record, id: 'another-session'}), null);
  assert.ok(readVerifiedTextSessionBounds(proof, {...record, id: value.attempt.id, producerId: record.id}));
  const detached = readVerifiedTextSessionBounds(proof, record); detached.actions[0].input.dispatches[0].classification.physicalInput = true;
  assert.equal(readVerifiedTextSessionBounds(proof, record).actions[0].input.dispatches[0].classification.physicalInput, false);
  value.args.retainedFiles.find(file => file.path === 'browser-cell-1.json').sha256 = '0'.repeat(64);
  await assert.rejects(value.replay(), /outer retained seal/);
});

test('retained worker, prepared browser, source, process and explicit schema-four selectors are independently required', async t => {
  for (const mutate of [
    args => {args.workerProcessIdentity.pid++;}, args => {args.workerProcessIdentity.startedAt = '2026-09-30T10:00:00Z';},
    args => {args.workerProcessIdentity.node = 'v26.9.0';}, args => {args.controlFiles = args.controlFiles.filter(file => !file.path.endsWith('/browser-text-input.mjs'));},
    args => {args.controlFiles.find(file => file.path.endsWith('.swift')).sha256 = '0'.repeat(64);},
    args => {args.configuration.browser.windowServerTextActions.kind = 'windowserver-generic-actions-configuration-2';},
    args => {args.configuration.browser.windowServerTextActions.storageFormat = 'raw';},
    args => {args.tools.browserPins.browsers[0].revision = 'another';},
  ]) {const value = await fixture(t); mutate(value.args); await assert.rejects(value.replay());}
  for (const mutateProcess of [p => {p.exit.code = 1;}, p => {p.requestedSignals.push('SIGTERM');}, p => {p.failure = {message: 'failed'};}]) {
    const value = await fixture(t, {mutateProcess}); assert.equal(await value.replay(), null);
  }
  for (const mutateBrowser of [({runtime}) => {runtime.headless = true;}, ({runtime}) => {runtime.ownedLaunch.context.freshAtLaunch = false;}]) {
    const value = await fixture(t, {mutateBrowser}); await assert.rejects(value.replay());
  }
});

test('complete text fixture metadata and both source-plan representations are bound to the original attempt', async t => {
  for (const mutate of [
    args => {args.fixture.text.corpus.text += 'changed';}, args => {args.fixture.text.corpus.fragments[0] = 'changed';},
    args => {args.fixture.text.fonts[0].sha256 = 'sha256:' + '0'.repeat(64);},
    args => {args.fixture.text.semanticItemIds.reverse();}, args => {args.fixture.text.activeLayerId = 'other';},
    args => {args.fixture.text.manifestHash = 'sha256:' + '0'.repeat(64);},
  ]) {const value = await fixture(t); mutate(value.args); await assert.rejects(value.replay());}
  for (const mutateBinding of [b => {b.textAttempt.actionPlan.sourcePlanSha256 = 'sha256:' + '0'.repeat(64);},
    b => {b.textAttempt.actionPlan.actions.find(action => action.inputKey).inputKey = 'End';},
    b => {b.textAttempt.actionPlan.durationMs = 59400;}, b => {b.textAttempt.attemptId = 'other/scored/1';},
    b => {b.textAttempt.textFixture.corpus.fragmentCount = 21;}]) {
    const value = await fixture(t, {mutateBinding}); await assert.rejects(value.replay(), /fixture|plan|worker|attempt/i);
  }
});

test('raw text input, census, classifiers and continuity cannot be replaced by producer projection flags', async t => {
  for (const mutateProducer of [p => {p.observations.actions.pop();}, p => {p.observations.actions[0].nativeInput.dispatches.pop();},
    p => {p.observations.actions[0].nativeInput.dispatches[0].descriptor.operation = 'invented';},
    p => {p.observations.actions[1].nativeInput.dispatches[1].inputEvidence.events[0].isTrusted = false;},
    p => {p.observations.actions[0].nativeInput.dispatches[0].nativeBracket.before.mach = '1';},
    p => {p.observations.native.sameNode = false;}, p => {p.observations.textPresentation.sameConnectedNode = false;},
    p => {p.observations.presentationWitness.cancellation.afterCancel.switch.reason = 'stale-session';},
    p => {p.observations.actions[0].nativeInput.after.contentSha256 = '0'.repeat(64);},
    p => {p.nativeText.projection.status = 'PASS'; p.nativeText.projection.actions = [];},
  ]) {const value = await fixture(t, {mutateProducer}); await assert.rejects(value.replay());}
  for (const mutateProducer of [p => {p.observations.actions[0].nativeInput.dispatches[0].nativeBracketVerified = true;},
    p => {p.observations.actions[0].nativeSource = 'playwright-native-input';},
    p => {p.failureClassification.productFailureSeen = true;},
    p => {p.failureClassification.firstFailureWasPrerequisite = true;}, p => {delete p.failureClassification;}]) {
    const value = await fixture(t, {mutateProducer}); await assert.rejects(value.replay());
  }
});

test('packed native and semantic-oracle bytes, state hashes and original allocation remain separate authorities', async t => {
  for (const pathOf of [v => v.captureFolder + '/pixels.bin', v => v.oracleFolder + '/oracle-pixels.bin',
    v => v.oracleFolder + '/semantic-review.record', v => v.transaction + '/build-evidence/collector.swift']) {
    const value = await fixture(t), path = pathOf(value), bytes = await readFile(value.path(path)); bytes[0] ^= 1;
    await replaceOuter(value, path, bytes); await assert.rejects(value.replay());
  }
  for (const mutateOracle of [o => {o.actions[0].stateSha256 = '0'.repeat(64);},
    o => {o.actions.find(action => action.subject === 'text-presentation-pending-feedback').subject = 'text-presentation-switch';}]) {
    const value = await fixture(t, {mutateOracle}); await assert.rejects(value.replay());
  }
  for (const mutateAdmission of [({admission}) => {admission.reservation.reservationBytes--;},
    ({initialAdmission}) => {initialAdmission.sample.completeTraversal = false;},
    ({preparation}) => {preparation.allocation.identity.sha256 = '0'.repeat(64);}]) {
    const value = await fixture(t, {mutateAdmission}); await assert.rejects(value.replay());
  }
  const failedVolume = await fixture(t, {mutateFinalSample: sample => {
    sample.sample.observedAllocatedBytes = sample.capacityBytes; sample.alarm = expectedAlarm(sample.sample, sample.capacityBytes);
  }}); assert.equal(await failedVolume.replay(), null);
  const outer = await fixture(t); outer.args.evidenceStorage.allocationIdentity.sha256 = '0'.repeat(64);
  await assert.rejects(outer.replay(), /outer controller authority/);
});

test('unavailable, identical, late and out-of-window pixels preserve exact-null and inconclusive outcomes', async t => {
  for (const options of [{unavailableSequence: 105}, {equalSequence: 105}, {lastAcknowledgementMs: 3000}]) {
    const value = await fixture(t, options), proof = await value.replay(); assert.ok(proof);
    const result = evaluateSession(value.record(proof), 'IText');
    assert.equal(result.upperBounds.acknowledgements.n, 105); assert.equal(result.upperBounds.acknowledgements.ceilingAssessment, 'unavailable');
    assert.equal(result.outcome, 'INCONCLUSIVE'); assert.deepEqual(result.acknowledgements, {n: 0, p95: null, max: null});
    assert.ok(!result.failures.includes('R04-acknowledgement-over-100ms'));
  }
  for (const lastAcknowledgementMs of [100, 100.001, 120]) {
    const value = await fixture(t, {lastAcknowledgementMs}), proof = await value.replay(); assert.ok(proof);
    const result = evaluateSession(value.record(proof), 'IText'); assert.equal(result.upperBounds.acknowledgements.n, 106);
    assert.equal(result.upperBounds.acknowledgements.max, lastAcknowledgementMs);
    assert.equal(result.upperBounds.acknowledgements.ceilingAssessment, lastAcknowledgementMs <= 100 ? 'observed-upper-bounds-within-ceiling' : 'unavailable');
    assert.equal(result.outcome, 'INCONCLUSIVE'); assert.ok(!result.failures.includes('R04-acknowledgement-over-100ms'));
  }
});

test('selected text raw feedback uses complete returned authority and reconstructed original cohort only', async t => {
  const value = await fixture(t, {rawFeedback: true}), proof = await value.replay(); assert.ok(proof);
  assert.equal(readVerifiedTextSessionBounds(proof, value.attempt.result.session).replay.rawTraceIdentity.path, 'browser-feedback-1.raw.json');
  const paths = ['browser-feedback-1.raw.json', 'browser-feedback-1.raw.json.manifest.json'];
  assert.ok(paths.every(path => value.reads.includes(path) || value.resolutions.includes(path)));
  for (const mutateProducer of [p => {p.trace.rawFeedback.manifest.collection.startOutcome = 'unavailable';},
    p => {p.trace.rawFeedback.manifest.manifest.saved = false;}, p => {p.trace.rawFeedback.manifest.cleanup.lateOperations.push('pending');}]) {
    const other = await fixture(t, {rawFeedback: true, mutateProducer}); assert.equal(await other.replay(), null);
  }
  for (const mutateProducer of [p => {p.trace.rawFeedback.manifest.manifest.path += '.wrong';},
    p => {p.trace.rawFeedback.analysis.cohort.declaredActions = 100;}]) {
    const other = await fixture(t, {rawFeedback: true, mutateProducer}); await assert.rejects(other.replay());
  }
  const sidecar = await fixture(t, {rawFeedback: true}), path = 'browser-feedback-1.raw.json.manifest.json';
  const bytes = JSON.parse(await readFile(sidecar.path(path), 'utf8')); bytes.manifest.saved = true;
  await replaceOuter(sidecar, path, bytes); await assert.rejects(sidecar.replay(), /provisional sidecar/);
});

test('context and reader buffers remain privately owned across asynchronous replay boundaries', async t => {
  const value = await fixture(t), original = structuredClone(value.attempt.result.session), reader = value.args.readRetained;
  let changed = false;
  value.args.readRetained = async (...args) => {const bytes = await reader(...args);
    if (!changed) {changed = true; value.args.attempt.result.session.actions[0].inputMs++; value.args.workerProcessIdentity.pid++;}
    return bytes;
  };
  const proof = await value.replay(); assert.ok(proof);
  assert.ok(readVerifiedTextSessionBounds(proof, original)); assert.equal(readVerifiedTextSessionBounds(proof, value.args.attempt.result.session), null);
  const bufferValue = await fixture(t), bufferReader = bufferValue.args.readRetained;
  bufferValue.args.readRetained = (...args) => ({then(resolve, reject) {
    bufferReader(...args).then(bytes => {resolve(bytes); queueMicrotask(() => bytes.fill(0));}, reject);
  }});
  assert.ok(await bufferValue.replay());
});

test('R04 runner and cohort joins preserve the same text proof and original unsuccessful-attempt status', async t => {
  const value = await fixture(t), proof = await value.replay(); assert.ok(proof);
  const cell = {...value.cell, host: 'H', cold: 0, warm: 1, primes: 0, requirements: {},
    phaseBudgets: [{id: 'R04', phase: 'ui.feedback', ceilingMs: 100, targetMs: 50}]};
  const plan = {campaign: 'Q3', features: 'adapters', jobs: [{id: 'Q3', cells: [cell]}]}, scheduled = executionGroups(plan);
  const groups = scheduled.map(group => ({...group, attempts: [value.attempt], status: 'PASS'}));
  const nativeSessions = new Map([[value.attempt.id, proof]]);
  const cohort = evaluateInteractionCohort(plan, cell, [value.attempt], new Map(), new Map(), nativeSessions)[0];
  assert.equal(cohort.sessions[0].upperBounds.acknowledgements.n, 106); assert.equal(cohort.outcome, 'INCONCLUSIVE');
  const summary = summarize(plan, groups, {nativeSessions}), phase = summary.cells[0].phaseBudgets[0];
  assert.equal(phase.maximumMs, null); assert.equal(phase.maximumUpperBoundMs, 25); assert.equal(phase.samples.length, 106);
  assert.equal(phase.ceilingAssessment, 'observed-upper-bounds-within-ceiling');
  assert.ok(phase.samples.every(sample => sample.input?.physicalInput === false));
  assert.ok(summary.cells[0].protocols.some(value => value.metric === 'INP' && value.outcome === 'INCONCLUSIVE'));
  const altered = status => summarize(plan, scheduled.map(group => ({...group, attempts: [{...value.attempt, status}], status})), {nativeSessions}).cells[0].phaseBudgets[0];
  assert.equal(altered('INCONCLUSIVE').status, 'INCONCLUSIVE');
  assert.equal(altered('INCONCLUSIVE').ceilingAssessment, 'observed-upper-bounds-within-ceiling');
  assert.equal(altered('FAIL').status, 'FAIL');
  const exactFailure = {...value.attempt, result: {...value.attempt.result, phases: [{name: 'ui.feedback', durationMs: 101}]}};
  assert.equal(summarize(plan, scheduled.map(group => ({...group, attempts: [exactFailure], status: 'PASS'})), {nativeSessions}).cells[0].phaseBudgets[0].status, 'FAIL');
  const copied = summarize(plan, groups, {nativeSessions: new Map([[value.attempt.id, {...proof}]])});
  assert.equal(copied.cells[0].phaseBudgets[0].status, 'INCONCLUSIVE');
});


test('live controller awaits text-only replay and publishes the returned private R04 bounds', async t => {
  const value = await fixture(t), cell = {...value.cell, host: 'H', cold: 0, warm: 1, primes: 0, requirements: {},
    phaseBudgets: [{id: 'R04', phase: 'ui.feedback', ceilingMs: 100, targetMs: 50}]};
  const plan = {campaign: 'Q3', features: 'adapters', jobs: [{id: 'Q3', cells: [cell]}]};
  const groups = executionGroups(plan).map(group => ({...group, attempts: [value.attempt], status: 'PASS'}));
  assert.ok(value.attempt.result.nativeText);
  assert.equal(value.attempt.result.hotEdit?.windowServerPresentation, undefined);
  assert.equal(value.attempt.result.firstUse?.nativePresentation, undefined);
  assert.equal(value.attempt.result.session?.nativePresentation, undefined);
  assert.equal(value.attempt.result.observations?.nativeIme, undefined);

  // Exercise main()'s actual publication call and its actual replay helpers,
  // including predicate, await, error handling, map projection and sanitization.
  // Unique source boundaries fail closed if either production block moves;
  // no copied predicate or stand-in wrapper can satisfy this regression.
  const source = await readFile(new URL('../../tooling/qualification/campaigns/run.mjs', import.meta.url), 'utf8');
  const helperBegin = 'export async function replayBeforeSummary(receipt, output) {';
  const helperEnd = 'export async function runPlan(plan, context, launch = launchGroup) {';
  const begin = '    const summary = await summarizeRetainedCampaign(receipt, output, {';
  const end = "    retainedReceiptPath = join(output, 'receipt.json'); storageOutcome = summary.status;";
  for (const boundary of [helperBegin, helperEnd, begin, end]) assert.equal(source.split(boundary).length, 2);
  const helperFirst = source.indexOf(helperBegin), helperLast = source.indexOf(helperEnd);
  const first = source.indexOf(begin), last = source.indexOf(end);
  assert.ok(helperLast > helperFirst); assert.ok(first > helperLast); assert.ok(last > first);
  const helpers = source.slice(helperFirst, helperLast).replace(/^export /gm, '');
  const body = source.slice(first, last);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const controller = new AsyncFunction('receipt', 'output', 'context', 'verifySealedEvidence', 'summarize', 'exclusiveJSON', 'sanitize', 'join', 'digest', 'errorRecord', 'isBrowserWALifecycle', 'isOrdinaryAdapterImport',
    'let {plan, groups, hostEligible, inputsValid, sourceStable, runError, byteAuditGroups, jobExecutions, controllerTiming, before, buildsBefore, tools} = context;\n' + helpers + body + '\nreturn receipt;');
  const output = join(value.root, 'live-controller'); await mkdir(output, {mode: 0o700});
  const receipt = {plan, groups, summary: null, runError: null, prompt: 'synthetic unit private text'};
  const context = {plan, groups, hostEligible: true, inputsValid: true, sourceStable: true, runError: null,
    byteAuditGroups: [], jobExecutions: [], controllerTiming: null, before: {digest: 'synthetic-source'}, buildsBefore: {digest: 'synthetic-build'}, tools: {synthetic: true}};
  const events = []; let proof, signalEntered, releaseReplay;
  const entered = new Promise(resolve => {signalEntered = resolve;});
  const gate = new Promise(resolve => {releaseReplay = resolve;});
  const replay = async (actualReceipt, actualOutput) => {
    events.push('replay-entered'); signalEntered('replay-entered');
    assert.equal(actualReceipt, receipt); assert.equal(actualOutput, output);
    assert.equal(actualReceipt.summary, null);
    await gate;
    // The callback controls scheduling only. Authority comes from the complete
    // retained schema4 archive and real verifier's private token, not a flag.
    proof = await value.replay(); assert.ok(readVerifiedTextSessionBounds(proof, value.attempt.result.session));
    events.push('replay-finished');
    return {groups: 1, attempts: 1, byteAuditGroups: 0, nativeHotEdits: new Map(), nativeFirstUses: new Map(), nativeSessions: new Map([[value.attempt.id, proof]]), nativeImes: new Map(), nativeNavigations: new Map()};
  };
  const evaluate = (actualPlan, actualGroups, options) => {
    events.push('summarize'); assert.equal(options.nativeSessions.get(value.attempt.id), proof); assert.ok(proof);
    assert.deepEqual(options.nativeImes, new Map()); assert.deepEqual(options.nativeNavigations, new Map());
    assert.equal(options.byteAuditGroups, context.byteAuditGroups, 'replay counters must not replace audit records');
    return summarize(actualPlan, actualGroups, options);
  };
  const publish = async (path, actualReceipt) => {
    events.push('publish'); assert.equal(path, join(output, 'receipt.json'));
    assert.equal(actualReceipt.summary.cells[0].phaseBudgets[0].maximumUpperBoundMs, 25);
    await exclusiveJSON(path, actualReceipt);
  };
  const running = controller(receipt, output, context, replay, evaluate, publish, sanitize, join, digest, errorRecord, isBrowserWALifecycle, isOrdinaryAdapterImport);
  try {
    assert.equal(await Promise.race([entered, running.then(() => 'controller-finished')]), 'replay-entered');
    assert.deepEqual(events, ['replay-entered']); assert.equal(receipt.summary, null);
    await assert.rejects(readFile(join(output, 'receipt.json')), {code: 'ENOENT'});
  } finally {releaseReplay(); await running;}
  assert.deepEqual(events, ['replay-entered', 'replay-finished', 'summarize', 'publish']);
  const published = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8')), phase = published.summary.cells[0].phaseBudgets[0];
  assert.equal(phase.maximumMs, null); assert.equal(phase.maximumUpperBoundMs, 25); assert.equal(phase.samples.length, 106);
  assert.equal(phase.ceilingAssessment, 'observed-upper-bounds-within-ceiling');
  assert.equal(published.summary.status, 'INCONCLUSIVE'); assert.equal(published.summary.qualification, false);
  assert.equal(published.nativeReplayError, undefined); assert.equal(published.runError, null);
  assert.equal(published.groups[0].attempts[0].result.session.nativePresentationProof, undefined);
  assert.equal(published.prompt, '[omitted: private payload]'); assert.equal(receipt.prompt, 'synthetic unit private text');

  const failedOutput = join(value.root, 'live-controller-replay-failure'); await mkdir(failedOutput, {mode: 0o700});
  const failedReceipt = {plan, groups: groups.map(group => ({...group, status: 'FAIL'})), summary: null, runError: null};
  const replayError = new Error('unit retained text replay rejected');
  const rejectReplay = async () => {throw replayError;};
  await controller(failedReceipt, failedOutput, context, rejectReplay, summarize, exclusiveJSON, sanitize, join, digest, errorRecord, isBrowserWALifecycle, isOrdinaryAdapterImport);
  const failedPublished = JSON.parse(await readFile(join(failedOutput, 'receipt.json'), 'utf8'));
  assert.deepEqual(failedPublished.nativeReplayError, errorRecord(replayError));
  assert.deepEqual(failedPublished.runError, failedPublished.nativeReplayError);
  assert.equal(failedPublished.summary.status, 'FAIL'); assert.equal(failedPublished.summary.qualification, false);
  const failedPhase = failedPublished.summary.cells[0].phaseBudgets[0];
  assert.equal(failedPhase.id, 'R04'); assert.equal(failedPhase.phase, 'ui.feedback');
  assert.equal(Object.hasOwn(failedPhase, 'maximumUpperBoundMs'), false, 'rejected replay publishes no native upper bound');
  assert.equal(failedPhase.status, 'INCONCLUSIVE'); assert.equal(failedPhase.maximumMs, null);
  assert.deepEqual(failedPhase.missing, [value.attempt.id]);
});

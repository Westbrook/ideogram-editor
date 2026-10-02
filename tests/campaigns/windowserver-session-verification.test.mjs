import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {verifySessionWindowServerEvidence, readVerifiedSessionBounds, isSessionNativeEvidencePath} from '../../tooling/qualification/campaigns/windowserver-session-verification.mjs';
import {GENERIC_AUTOMATION, GENERIC_PROFILE, genericInteractionInventory, genericNativeActionId, genericPointerDescriptor, genericSessionNativeId, projectGenericInteraction, genericRawFeedbackCohort} from '../../tooling/qualification/campaigns/browser-generic-input.mjs';
import {discreteInputDescriptor, validateDiscreteInput} from '../../tooling/qualification/campaigns/browser-discrete-input.mjs';
import {planStrokeCoordinates, validateRecordedStroke} from '../../tooling/qualification/campaigns/browser-gesture-state.mjs';
import {brushCorpus} from '../../tooling/qualification/campaigns/fixtures.mjs';
import {interactionSession, genericRawFeedbackSelection} from '../../tooling/qualification/campaigns/browser.mjs';
import {windowServerSessionCapacity, verifyWindowServerSessionCapture, getWindowServerSessionObservations} from '../../tooling/qualification/campaigns/windowserver-session.mjs';
import {deriveSessionReservation} from '../../tooling/qualification/campaigns/windowserver-session-budget.mjs';
import {deriveSessionLosslessReservation} from '../../tooling/qualification/campaigns/windowserver-session-lossless-budget.mjs';
import {windowServerSessionLosslessCapacity, verifyWindowServerSessionLosslessCapture, getWindowServerSessionLosslessObservations} from '../../tooling/qualification/campaigns/windowserver-session-lossless.mjs';
import {joinGenericActionPixels, joinGenericActionLosslessPixels} from '../../tooling/qualification/campaigns/generic-action-oracle.mjs';
import {evaluateSession} from '../../tooling/qualification/campaigns/metrics.mjs';
import {evaluateInteractionCohort, executionGroups, summarize} from '../../tooling/qualification/campaigns/run.mjs';
import {normalizeResult} from '../../tooling/qualification/campaigns/worker.mjs';
import {sanitize} from '../../tooling/qualification/campaigns/common.mjs';
import {analyzeDisplayFeedbackTrace, R07_MISSING_AUTHORITIES} from '../../tooling/qualification/campaigns/display-feedback.mjs';

// AUTHORED ONLY during staging. Literal tiny pixels, synthetic build metadata,
// browser events and retained protocol records are test inputs, never measured
// performance, real presentation evidence, or public evaluator proof minting.
// The full raw generic builder below was copied as source, not imported from a
// test module, then bound to the canonical sealed brush corpus.
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

const SESSION = 'input-generic-test', ORIGIN = 1_800_000_000_000;
const digest = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pointer = (extra = {}) => genericPointerDescriptor({schemaVersion: 1, sessionId: SESSION, actionSequence: 0,
  family: 'stroke', specimenId: 'stroke-000', sampleIndex: 0, type: 'pointerdown', x: 468, y: 308, ...extra});
const modifiers = (extra = {}) => ({control: false, meta: false, shift: false, alt: false, ...extra});
const keyDown = (keyName, extra = {}) => ({type: 'keydown', keyName, code: keyName, repeat: false, modifiers: modifiers(), ...extra});
const keyPair = keyName => [keyDown(keyName), {type: 'keyup', keyName}];

function discreteStep(requested, at) {
  const descriptor = discreteInputDescriptor(requested), operation = descriptor.input;
  let rows;
  if (operation.kind === 'click') rows = ['pointerdown', 'pointerup', 'click'].map((type, ordinal) => ({type,
    pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ordinal ? 0 : 1}));
  else if (operation.kind === 'press-sequentially') rows = [...operation.text].flatMap(keyPair);
  else if (operation.keyName === 'ControlOrMeta+A') rows = [keyDown('Meta', {modifiers: modifiers({meta: true})}),
    keyDown('A', {modifiers: modifiers({meta: true})}), {type: 'keyup', keyName: 'A'}, {type: 'keyup', keyName: 'Meta'}];
  else rows = keyPair(operation.keyName);
  const events = rows.map((row, ordinal) => ({eventId: `${descriptor.sessionId}/${descriptor.actionId}/${descriptor.stepId}/event-${ordinal}`,
    ordinal, timeStampMs: at + ordinal / 10, observedMs: at + ordinal / 10 + .01,
    isTrusted: true, targetMatched: true, ...row}));
  const raw = {descriptor, clock: 'browser-performance', timeOrigin: ORIGIN, endedTimeOrigin: ORIGIN,
    armedMs: at - .1, stoppedMs: at + rows.length / 10 + .1, visibility: 'visible', endedVisibility: 'visible',
    targetConnectedAtArm: true, targetConnected: true, overflow: false, events};
  return {dispatchCompleted: true, inputEvidence: validateDiscreteInput(raw, descriptor), nativeBracket: null,
    nativeBracketVerified: false, missing: []};
}

function publicState(values, at) {
  const box = {x: 100, y: 70, width: 1200, height: 1200};
  return {gesture: {clock: 'browser-performance', timeOrigin: ORIGIN, observedMs: at, box,
    viewport: {x: values.pan, y: -12, zoom: values.zoom, observedMs: at - .2},
    editor: {documentId: 'gesture_document', revision: '7', ready: true, busy: false, selected: [values.layer], observedMs: at - .1},
    tool: 'Mask', brushDiameter: 64, visibility: 'visible'},
  layout: {clock: 'browser-performance', timeOrigin: ORIGIN, observedMs: at, visibility: 'visible',
    appearance: values.appearance, densityTheme: values.density, prefersDark: false, density: values.density,
    splitter: values.splitter, boxes: {canvas: {...box}, layerTree: {x: 0, y: 70, width: 100, height: 1200},
      splitter: {x: values.splitter, y: 70, width: 4, height: 1200}},
    viewport: {width: 1600, height: 1400, devicePixelRatio: 1}}};
}

/** Full 60-second synthetic input receipt. The authored stroke geometry is
 * independent of pixels and uses the same public coordinate plan contract. */
function fullObservation() {
  const document = {id: 'gesture_document', revision: '7', width: 2048, height: 2048};
  const values = {pan: 18, zoom: .5, layer: 'image_a', appearance: 'light', density: 'comfortable', splitter: 320};
  const actions = []; let priorStroke;
  for (const [sequence, planned] of genericInteractionInventory().entries()) {
    const cycle = Math.floor(sequence / 5), position = sequence % 5, downMs = 100 + cycle * 2900;
    const at = position ? downMs + 2050 + (position - 1) * 180 : downMs;
    const before = publicState(values, at - 2);
    if (planned.kind === 'stroke') {
      const specimen = brushCorpus(document.width, document.height)[cycle];
      const plan = planStrokeCoordinates(specimen, before.gesture, {document, eligibleLayerIds: ['image_a', 'image_b']});
      const events = plan.points.map((point, index) => ({type: index === 0 ? 'pointerdown' : index === 119 ? 'pointerup' : 'pointermove',
        inputMs: at + point.plannedOffsetMs, observedMs: at + point.plannedOffsetMs + .25,
        trusted: true, primary: true, pointerType: 'mouse', pointerId: 7, buttons: index === 119 ? 0 : 1,
        clientX: point.x, clientY: point.y}));
      const native = {clock: 'browser-performance', timeOrigin: ORIGIN, armedMs: at - 1, stoppedMs: at + 1990,
        firstInputMs: at, canvasStillConnected: true, overflow: false, cancelled: false, events};
      const geometry = events.map(event => [
        (event.clientX - plan.state.box.x - plan.state.box.width / 2 - plan.state.viewport.x) / plan.state.viewport.zoom + document.width / 2,
        (event.clientY - plan.state.box.y - plan.state.box.height / 2 - plan.state.viewport.y) / plan.state.viewport.zoom + document.height / 2,
      ]);
      const completion = {startMs: events.at(-1).observedMs + 1, detail: {schemaVersion: 1, gestureOrdinal: cycle + 1,
        pointerId: 7, inputDownMs: events[0].inputMs, inputUpMs: events.at(-1).inputMs, trusted: true,
        documentId: document.id, revision: document.revision, draftId: 'mask_draft', targetLayerId: 'image_a', targetLayerVersion: '3',
        selectedLayerId: values.layer, sampleCount: 120, operationCount: 1, geometrySha256: digest(geometry), brushDiameter: 64}};
      const samples = plan.points.map((point, index) => ({index, scheduledMs: at + 100000 + point.plannedOffsetMs,
        dispatchStartedMs: at + 100000 + point.plannedOffsetMs + .5, dispatchCompletedMs: at + 100000 + point.plannedOffsetMs + 1}));
      const pointerDispatches = plan.points.map((point, sampleIndex) => {
        const descriptor = pointer({actionSequence: sequence, specimenId: specimen.id, sampleIndex, type: events[sampleIndex].type, x: point.x, y: point.y});
        return {descriptor, nativeActionId: genericNativeActionId(descriptor), dispatchCompleted: true,
          dispatchStartedMs: samples[sampleIndex].dispatchStartedMs, dispatchCompletedMs: samples[sampleIndex].dispatchCompletedMs,
          clock: 'runner-monotonic', nativeBracket: null, nativeBracketVerified: false, automation: GENERIC_AUTOMATION, missing: []};
      });
      priorStroke = {...planned, specimenId: specimen.id, selectedLayerId: values.layer, plan, native, completion,
        pointerSchedule: {clock: 'runner-monotonic', frequencyHz: 60, samples}, pointerDispatches,
        samples: events.map((event, index) => ({...event, index})), inputMs: at, outcome: 'completed', meaningful: true, nativeState: {before, after: publicState(values, at + 1992)}};
      actions.push(priorStroke); continue;
    }
    const specs = []; let semantic;
    const add = (stepId, control, input, extra = {}) => specs.push({schemaVersion: 1, sessionId: SESSION,
      actionId: 'action-' + planned.index, stepId, family: planned.kind, target: {control, ...extra}, input});
    if (planned.kind === 'undo') {
      semantic = {draftId: 'mask_draft', gestureOrdinal: priorStroke.completion.detail.gestureOrdinal,
        beforeOperationCount: 1, afterOperationCount: 0, buttonDisabled: true, observedMs: at + 2};
      add('activate', 'mask-undo', {kind: 'click'});
    } else if (planned.kind === 'layer') {
      const old = values.layer; values.layer = old === 'image_a' ? 'image_b' : 'image_a';
      semantic = {before: old, after: values.layer};
      add('activate', 'layer-row', {kind: 'click'}, {rowIndex: values.layer === 'image_a' ? 0 : 1, layerId: values.layer});
    } else if (planned.kind === 'zoom') {
      values.zoom = planned.variant ? .5 : .25; semantic = {zoom: values.zoom};
      add('select-all', 'zoom-percentage', {kind: 'press', key: 'ControlOrMeta+A'});
      add('enter-value', 'zoom-percentage', {kind: 'press-sequentially', text: String(values.zoom * 100)});
      add('commit', 'zoom-percentage', {kind: 'press', key: 'Tab'});
    } else if (planned.kind === 'pan') {
      const old = values.pan; values.pan += planned.variant ? -10 : 10; semantic = {before: old, after: values.pan};
      add('pan', 'document-canvas', {kind: 'press', key: planned.variant ? 'ArrowLeft' : 'ArrowRight'});
    } else if (planned.kind === 'split') {
      const old = values.splitter, direction = planned.variant ? -1 : 1; values.splitter += 10 * direction;
      semantic = {before: old, after: values.splitter, direction};
      add('resize', 'request-panel-width', {kind: 'press', key: direction === 1 ? 'ArrowRight' : 'ArrowLeft'});
    } else {
      const theme = planned.kind === 'theme', field = theme ? 'appearance' : 'density', old = values[field];
      values[field] = theme ? old === 'dark' ? 'light' : 'dark' : old === 'spacious' ? 'comfortable' : 'spacious';
      semantic = {before: old, after: values[field]};
      add('select-edge', field, {kind: 'press', key: ['dark', 'spacious'].includes(values[field]) ? 'End' : 'Home'});
      if (theme && values[field] === 'light') add('select-light', field, {kind: 'press', key: 'ArrowDown'});
      add('commit', field, {kind: 'press', key: 'Tab'});
    }
    const steps = specs.map((descriptor, index) => discreteStep(descriptor, at + index * 10));
    const first = steps[0].inputEvidence.events[0], native = {clock: 'browser-performance', timeOrigin: ORIGIN,
      armedMs: at - 1, stoppedMs: at + 1, firstInputMs: first.timeStampMs, canvasStillConnected: true,
      overflow: false, cancelled: false, events: [{type: first.type, inputMs: first.timeStampMs, observedMs: first.observedMs, trusted: true}]};
    actions.push({...planned, semantic, native, outcome: 'completed', meaningful: true, inputMs: steps[0].inputEvidence.inputMs,
      discreteInput: {kind: 'browser-discrete-action-1', schemaVersion: 1, sessionId: SESSION, actionId: 'action-' + planned.index,
        family: planned.kind, automation: steps[0].inputEvidence.automation, steps, inputMs: steps[0].inputEvidence.inputMs, timeOrigin: ORIGIN, clock: 'browser-performance',
        status: 'PASS', missing: [], failures: [], qualification: false},
      nativeState: {before, after: publicState(values, at + 50)}});
  }
  return {clock: 'browser-performance', timeOrigin: ORIGIN, startMs: 0, endMs: 60000, captureStoppedMs: 60000,
    inputProtocol: {document, eligibleLayers: [{id: 'image_a', rowIndex: 0}, {id: 'image_b', rowIndex: 1}], zoomPercentages: [25, 50]}, actions};
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
  const reservation = (requestedConfig.schemaVersion === 3 ? deriveSessionLosslessReservation : deriveSessionReservation)({config: requestedConfig, evidenceReservation, filesystemBlockBytes: 4096, allocationSourceBytes: allocationBytes.length});
  return {kind: requestedConfig.schemaVersion === 3 ? 'windowserver-session-evidence-admission-2' : 'windowserver-session-evidence-admission-1', allocationPath: evidenceAllocation.path,
    allocation: {...authority, identity: allocationIdentity, directoryIdentity: {dev: '1', ino: '11', uid: '501', mode: String(0o40700)}},
    outputDirectory, directoryIdentity: {dev: '1', ino: String(ino), uid: '501', mode: String(0o40700)}, sample,
    alarm: expectedAlarm(sample, capacityBytes), filesystemBlockBytes: 4096, capacity: structuredClone(reservation.capacity),
    evidenceReservation: structuredClone(evidenceReservation), reservation,
    config: {...structuredClone(requestedConfig), evidenceBudget: {capacityBytes, observedAllocatedBytes: sample.observedAllocatedBytes,
      reservationBytes: evidenceReservation.bytes, allocationSha256: allocationIdentity.sha256,
      ...(requestedConfig.schemaVersion === 3 ? {nativeArtifactBytes: evidenceReservation.nativeArtifactBytes} : {})}}, status: 'PASS', reason: null,
    qualification: false, limitations: [...limitations]};
}

async function fixture(t, {protocol = 2, rawFeedback = false, cache = 'warm', ordinal = 1, acknowledgementMs = 25, lastAcknowledgementMs = acknowledgementMs,
  mutateProducer, mutateProcess, mutateBinding, mutateOracle, mutateBrowser, mutateAdmission, mutateFinalSample, mutateTrace, unavailableSequence} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-retained-protocol-'))); await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  const groupOutput = join(root, 'absent-original-group'), historicalRoot = join(root, 'absent-build-inputs'), archive = join(root, 'relocated-evidence');
  await mkdir(archive, {mode: 0o700});
  const members = new Map(), modes = new Map(), put = (path, bytes, mode = 0o600) => {members.set(path, bytes); modes.set(path, mode); return pin(path, bytes);};
  const persist = async () => {for (const [path, bytes] of members) {const destination = join(archive, path);
    await mkdir(dirname(destination), {recursive: true, mode: 0o700}); await writeFile(destination, bytes, {mode: modes.get(path)}); await chmod(destination, modes.get(path));}};
  const raw = fullObservation(), sessionId = SESSION, nativeSessionId = genericSessionNativeId(sessionId), transaction = 'native-' + nativeSessionId,
    oracleFolder = 'oracle-' + nativeSessionId, captureFolder = transaction + '/capture';
  const cell = {id: 'Q3/interaction', operation: 'interaction.brush', workload: 'W1', handler: 'browser', kind: 'operation',
    parameters: {browser: 'chromium', durationMs: 60000, profile: 'interaction-100-2400-60hz-60s-1'}};
  const attemptId = `${cell.id}/${cache}/scored/${ordinal}`, workerPid = 100;
  const collectorBytes = Buffer.from('// synthetic session collector protocol ' + protocol + '; never compiled\n'), build = syntheticBuild(collectorBytes, historicalRoot);
  for (const [name, bytes, mode] of build.members) put(transaction + '/build-evidence/' + name, bytes, mode);
  const corpusBytes = json(brushCorpus(2048, 2048)), selectedFixture = {documentId: 'gesture_document', definition: {width: 2048, height: 2048},
    seal: {path: '/absent/fixture/manifest.json', sha256: 'f'.repeat(64)}, corpus: {files: [{id: 'brush-strokes', role: 'gestures', byteLength: corpusBytes.length, sha256: sha(corpusBytes)}]}};
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
  const requestedConfig = {schemaVersion: protocol, profile: GENERIC_PROFILE, ...(protocol === 3 ? {storageFormat: 'rfc1951-previous-roi-1'} : {}), displayID: display.id, expectedBrowserPid: runtime.browserPid, roi};
  const clock = (id, value) => ({schemaVersion: protocol, event: 'clock', id, mach: String(value)}), rows = [], images = [];
  const anchor = (boundary, value) => ({kind: 'generic-native-session-anchor-1', status: 'complete', boundary, sessionId, nativeSessionId,
    ack: clock(nativeSessionId + '-' + boundary, value)});
  raw.nativeSessionStart = anchor('begin', 1000000000); raw.nativeSessionEnd = anchor('end', 61001000000); rows.push(raw.nativeSessionStart.ack);
  // Native literals are independent test observations. No production code may
  // subtract browser timestamps or runner dispatch clocks from native ticks.
  for (const action of raw.actions) {
    const steps = action.kind === 'stroke' ? action.pointerDispatches : action.discreteInput.steps;
    for (const [index, step] of steps.entries()) {
      const descriptor = action.kind === 'stroke' ? step.descriptor : step.inputEvidence.descriptor;
      const nativeActionId = genericNativeActionId(descriptor), inputMs = action.kind === 'stroke' ? action.native.events[index].inputMs : step.inputEvidence.inputMs;
      const a = 1000000000 + Math.round(inputMs * 1000000), before = clock(nativeActionId + '-before', a), after = clock(nativeActionId + '-after', a + 1000000);
      step.nativeBracket = {kind: 'native-action-bracket-1', actionId: nativeActionId, status: 'complete', actionCompleted: true, before, after};
      rows.push(before, after);
    }
  }
  rows.push(raw.nativeSessionEnd.ack);
  let priorCompletion = null, priorUndo = null;
  for (const action of raw.actions) {
    if (action.kind === 'stroke') {
      action.validation = validateRecordedStroke({observation: action.native, plan: action.plan, completion: action.completion,
        priorCompletion, priorUndo, requireEmptyDraft: true});
      assert.equal(action.validation.status, 'PASS', action.validation.missing.join(','));
      action.samples = action.validation.samples; action.productCompletion = action.completion.detail;
      priorCompletion = action.completion; priorUndo = null;
    } else if (action.kind === 'undo') priorUndo = {...action.semantic, native: action.native};
  }
  const projection = projectGenericInteraction(raw, {sessionId}); assert.equal(projection.status, 'PASS', projection.missing.join(','));
  const beforePin = pin('pixels/before.bgra', beforePixels), afterPin = pin('pixels/after.bgra', afterPixels);
  const oracle = {kind: 'generic-action-pixel-oracle-1', schemaVersion: 1, profile: GENERIC_PROFILE,
    binding: {fixtureSha256: environment.fixtureSha256, browserEnvironmentSha256: environment.browserEnvironmentSha256}, display, roi, pixelFormat: 'BGRA8',
    actions: projection.actions.map(action => ({sequence: action.identity.sequence, family: action.identity.family, stateSha256: action.stateSha256,
      endpoints: action.endpoints.map(endpoint => ({ordinal: endpoint.ordinal, subject: endpoint.subject,
        ...(action.identity.family !== 'stroke' || endpoint.ordinal === 1 ? {kind: 'pixels', before: beforePin, after: afterPin} :
          {kind: 'unavailable', reason: 'independent-prefix-pixels-not-supplied'})})),
      ...(action.identity.family === 'stroke' ? {acknowledgement: {kind: 'pixels', subject: 'mask-stroke-acknowledgement', prefixOrdinal: 1, before: beforePin, after: afterPin}} : {})}))};
  if (unavailableSequence !== undefined) {const action = oracle.actions[unavailableSequence];
    action.endpoints = action.endpoints.map(endpoint => ({ordinal: endpoint.ordinal, subject: endpoint.subject, kind: 'unavailable', reason: 'independent-pixels-not-supplied'}));
    if (action.family === 'stroke') action.acknowledgement = {kind: 'unavailable', reason: 'independent-prefix-not-reviewed'};
  }
  const sample = (time, pixels) => {const ordinal = images.length + 1; images.push(pixels);
    return {schemaVersion: protocol, event: 'sample', ordinal, statusRaw: 0, status: 'complete', ownerPID: 23, windowNumber: 9,
      windowObservationMach: String(time + 101), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0,
      callbackMach: String(time + 100), displayTimeMach: String(time), pts: {value: '0', timescale: 1, flags: 0, epoch: '0'},
      pixelFormat: 1111970369, width: display.width, height: display.height, roi, retained: true, file: `frame-${ordinal}.bgra`,
      sha256: sha(pixels), byteLength: pixels.length, contentScale: 1, scaleFactor: 1};};
  for (const [sequence, action] of projection.actions.entries()) {
    const first = Number(action.dispatches[0].bracket.before.mach), stroke = action.identity.family === 'stroke';
    rows.push(sample(first - 2000000, beforePixels));
    // The interior prefix has its own immediately preceding baseline, while
    // the R04 whole-stroke acknowledgement retains the baseline before down.
    if (stroke) rows.push(sample(Number(action.dispatches[1].bracket.before.mach) - 2000000, beforePixels));
    rows.push(sample(first + Math.round((sequence === 99 ? lastAcknowledgementMs : acknowledgementMs) * 1000000), afterPixels));
  }
  rows.sort((a, b) => Number(BigInt(a.mach ?? a.callbackMach) - BigInt(b.mach ?? b.callbackMach)));
  const authority = {kind: 'evidence-volume-allocation-1', allocationId: 'synthetic-session', purpose: 'qualification-evidence-only',
    capacityBytes: 32 * 1024 ** 3, root, issuedAt: '2026-09-30T11:00:00.000Z', owner: 'synthetic-owner'};
  const allocationBytes = json(authority), allocationIdentity = {bytes: allocationBytes.length, sha256: sha(allocationBytes)},
    evidenceAllocation = {path: join(historicalRoot, 'allocation.json'), ...allocationIdentity};
  const evidenceReservation = {bytes: 2 * 1024 ** 3, ...(protocol === 3 ? {nativeArtifactBytes: 128 * 1024 ** 2} : {}), trace: {bytes: 32 * 1024 ** 2, files: 3, directories: 2},
    oracle: {bytes: 16 * 1024 ** 2, files: 4, directories: 2}, control: {bytes: 8 * 1024 ** 2, files: 20, directories: 4}};
  const admissionInputs = {authority, allocationBytes, evidenceAllocation, evidenceReservation, requestedConfig};
  const initialAdmission = admissionFor({...admissionInputs, outputDirectory: groupOutput, ino: 22}),
    preparation = admissionFor({...admissionInputs, outputDirectory: join(groupOutput, transaction), ino: 33}),
    admission = admissionFor({...admissionInputs, outputDirectory: join(groupOutput, transaction), ino: 33}), config = structuredClone(admission.config);
  const capacity = protocol === 3 ? windowServerSessionLosslessCapacity(roi, evidenceReservation.nativeArtifactBytes) : windowServerSessionCapacity(roi);
  const storageAdmission = {availableBytesBefore: String(authority.capacityBytes - counter().observedAllocatedBytes),
    ...(protocol === 3 ? {reservedArtifactBytes: evidenceReservation.nativeArtifactBytes} : {requiredArtifactBytes: capacity.requiredArtifactBytes}),
    evidenceBudget: {...config.evidenceBudget}, targetAlarmAtReservation: false};
  const encodedChunks = []; let encodedOffset = 0, duplicateFrames = 0, previousSample = null;
  if (protocol === 3) for (const row of rows.filter(row => row.event === 'sample')) {
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
  const framesBytes = ndjson(rows), manifest = {kind: 'windowserver-session-capture-' + protocol, schemaVersion: protocol, config, capacity, storageAdmission, display,
    captureGeometry: geometry, windowAdmission, timebase, startedMach: '0', endedMach: '61200000000', terminalReason: 'requested-stop',
    lossObservations: {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null},
    counts: {sampleRecords: images.length, completeFrames: images.length, clockRecords: 5052, pixelBytes: images.length * 8, unretainedSamples: 0,
      ...(protocol === 3 ? {encodedPixelBytes: nativeContainer.length, duplicateFrames} : {})},
    frames: pin('frames.ndjson', framesBytes), ...(protocol === 3 ? {pixelContainers: [pin('pixels.bin', nativeContainer)]} :
      {pixelFiles: images.map((pixels, index) => pin(`frame-${index + 1}.bgra`, pixels))})};
  const manifestBytes = json(manifest), ready = {...structuredClone(manifest), event: 'ready', outputDirectory: join(groupOutput, captureFolder), roi,
    pixelByteLimit: protocol === 3 ? capacity.maxEncodedPixelBytes : capacity.maxPixelBytes, metadataByteLimit: capacity.metadataByteLimit, manifestByteLimit: capacity.manifestByteLimit,
    maxClockRecords: capacity.maxClockRecords, pointPixelScale: 1};
  for (const key of ['endedMach', 'terminalReason', 'counts', 'frames', 'pixelFiles', 'pixelContainers', 'lossObservations']) delete ready[key];
  const stopped = {schemaVersion: protocol, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'};
  const stdout = ndjson([ready, ...rows, stopped]), configBytes = json(config);
  put(captureFolder + '/manifest.json', manifestBytes); put(captureFolder + '/frames.ndjson', framesBytes);
  if (protocol === 3) put(captureFolder + '/pixels.bin', nativeContainer);
  else for (const [index, pixels] of images.entries()) put(captureFolder + `/frame-${index + 1}.bgra`, pixels);
  put(transaction + '/stdout.ndjson', stdout); put(transaction + '/stderr.log', Buffer.alloc(0)); put(transaction + '/config.json', configBytes);
  await persist();
  // This lower-level replay reconstructs the producer's repeated join from the
  // complete ordinary-file bytes. It cannot create a session evaluator proof.
  const captured = await (protocol === 3 ? verifyWindowServerSessionLosslessCapture : verifyWindowServerSessionCapture)(join(archive, captureFolder), {manifestSha256: sha(manifestBytes), expectedConfig: config,
    expectedReady: {...ready, outputDirectory: join(archive, captureFolder)}, expectedStopped: stopped, processExitCode: 0});
  const originalOracleBytes = json(oracle), joined = (protocol === 3 ? joinGenericActionLosslessPixels : joinGenericActionPixels)(captured, {projection, oracleBytes: originalOracleBytes, oracleSha256: sha(originalOracleBytes),
    pixelIdentities: [beforePin, afterPin], binding: {...oracle.binding, browserPid: 23, windowNumber: 9}});
  mutateOracle?.(oracle); const oracleBytes = json(oracle); put(oracleFolder + '/oracle.json', oracleBytes);
  let selectedOracleStorage = null, retainedOracleStorage = null;
  if (protocol === 3) {
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
  } else {put(oracleFolder + '/pixels/before.bgra', beforePixels); put(oracleFolder + '/pixels/after.bgra', afterPixels);}
  mutateAdmission?.({initialAdmission, preparation, admission});
  const initialBytes = json(initialAdmission), preparationBytes = json(preparation), admissionBytes = json(admission);
  put(oracleFolder + '/allocation.json', allocationBytes); put(oracleFolder + '/allocation-admission.json', initialBytes);
  put(transaction + '/evidence-budget/allocation-source.json', allocationBytes); put(transaction + '/evidence-budget/preparation.json', preparationBytes);
  put(transaction + '/evidence-budget/admission.json', admissionBytes);
  const finalValue = {kind: 'windowserver-session-evidence-final-sample-1', allocationIdentity, capacityBytes: authority.capacityBytes,
    sample: counter(), alarm: expectedAlarm(counter(), authority.capacityBytes)}; mutateFinalSample?.(finalValue);
  const finalBytes = json(finalValue); put(transaction + '/evidence-budget/final-sample.json', finalBytes);
  const buildSelection = {receiptPath: build.receiptPath, receiptSha256: build.receiptSha256};
  const selection = {kind: protocol === 3 ? 'windowserver-generic-actions-configuration-2' : 'windowserver-generic-actions-configuration-1', build: buildSelection,
    ...(protocol === 3 ? {storageFormat: 'rfc1951-previous-roi-1'} : {}),
    oracle: {path: join(historicalRoot, 'oracle.json'), sha256: sha(oracleBytes), ...(protocol === 3 ? {storage: selectedOracleStorage} : {})}, displayID: 7, roi, evidenceAllocation, evidenceReservation};
  const rawOwnership = {kind: 'owned-isolated-synthetic-browser-1', admittedBy: 'root', owned: true, isolated: true,
    syntheticOnly: true, sessionOwned: true, browserInstanceId: 'synthetic-session-raw-1'};
  const configuration = {browser: {engine: 'chromium', windowServerGenericActions: selection,
    ...(rawFeedback ? {rawDisplayFeedback: {ownership: rawOwnership}} : {})}};
  const rawSelection = rawFeedback ? {...genericRawFeedbackSelection(configuration.browser.rawDisplayFeedback, runtime, runtime.browserPid),
    artifactPath: join(groupOutput, 'browser-feedback-1.raw.json')} : null;
  const binding = {kind: 'generic-windowserver-input-binding-1', profile: GENERIC_PROFILE, sessionId, nativeSessionId,
    invocation: {cellId: cell.id, operation: cell.operation, serial: 1, sample: {cache, ordinal, prime: false},
      producerPath: join(groupOutput, 'browser-cell-1.json'), tracePath: join(groupOutput, 'browser-trace-1.json'), rawFeedback: rawSelection},
    collectorSource: pin(join(historicalRoot, 'capture.swift'), collectorBytes), build: buildSelection, browser: runtime, environment, config: requestedConfig,
    evidenceAllocation, evidenceReservation, oracle: {...pin(join(groupOutput, oracleFolder, 'oracle.json'), oracleBytes), pixels: [beforePin, afterPin], ...(protocol === 3 ? {storage: retainedOracleStorage} : {})},
    allocationAdmissionPath: join(groupOutput, oracleFolder, 'allocation-admission.json'), allocationSourcePath: join(groupOutput, oracleFolder, 'allocation.json'),
    semanticOracleReview: protocol === 3 ? {requirement: 'external-independently-reviewed-exact-pixels-required', reference: retainedOracleStorage.reviewReference,
      reviewSha256: retainedOracleStorage.review.sha256, generatedByCapture: false, authorityFromFlags: false} : 'external-independently-reviewed-exact-pixels-required', historicalWindowOcclusion: 'adjacent-native-observations-not-atomic-at-frame-time'};
  mutateBinding?.(binding); put(oracleFolder + '/binding.json', json(binding));
  const processIdentity = {kind: 'windowserver', ownerPid: workerPid, pid: 123, pgid: 123, startedAtIdentity: 'synthetic-native-birth', executable: build.binaryPath};
  const registrationPath = 'owned-process-123-' + uuid + '.json', registrationBytes = json({kind: 'perf-owned-processes-1', ownerPid: workerPid,
    processes: [{kind: 'windowserver', pid: 123, pgid: 123, startedAtIdentity: processIdentity.startedAtIdentity, executable: build.binaryPath}]}); put(registrationPath, registrationBytes);
  const volume = {kind: protocol === 3 ? 'windowserver-session-evidence-reference-2' : 'windowserver-session-evidence-reference-1', allocation: pin('evidence-budget/allocation-source.json', allocationBytes),
    preparation: pin('evidence-budget/preparation.json', preparationBytes), admission: pin('evidence-budget/admission.json', admissionBytes),
    finalSample: pin('evidence-budget/final-sample.json', finalBytes), allocationIdentity, capacityBytes: authority.capacityBytes,
    selectedAllocation: evidenceAllocation, selectedReservation: evidenceReservation, requestedConfig,
    requiredOuterAudit: {kind: 'evidence-volume-reference-1', allocationIdentity, qualification: false}, qualification: false};
  const processRecord = {kind: 'windowserver-session-owned-process-' + protocol, schemaVersion: protocol, qualification: false, outcome: 'CAPTURE_REPLAYED',
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
  const observation = {kind: 'generic-windowserver-observation-1', nativeSchemaVersion: protocol, profile: GENERIC_PROFILE, sessionId, nativeSessionId, qualification: false,
    binding, ready, config, processIdentity, nativeSessionStart: raw.nativeSessionStart, nativeSessionEnd: raw.nativeSessionEnd, inputBound: true,
    projection, join: joined, lossObservations: manifest.lossObservations,
    evidence: {manifest: pin(join(groupOutput, captureFolder, 'manifest.json'), manifestBytes),
      process: {...processRecord, receipt: pin(join(groupOutput, transaction, 'process.json'), processBytes)}},
    failedProcess: null, evidenceAdmission: null, evidenceVolumeStatus: null, missing: ['generic-native-endpoint-coverage-incomplete'], failures: [],
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
    const cohort = genericRawFeedbackCohort(raw, {sessionId});
    const analysis = await analyzeDisplayFeedbackTrace({chunks: [rawBytes], manifest, cohort});
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
  const session = {...interactionSession(cell, {cache, ordinal}, raw, traceSummary, 'visible'), nativePresentation: observation};
  let producer = {cellId: cell.id, operation: cell.operation, status: 'PASS', elapsedMs: 62000, phases: [], measurements: [], measurementUnavailable: [],
    observations: raw, session, evidence: {productPhases: {phases: []}, observedCommandReceipts: [], rawVisits: [], replacedRealms: [], readiness: null},
    network: {counts: {accepted: 1}}, timingSamplesReusable: true, trace: traceSummary, missing: [], error: null,
    rawConsoleRetained: false, screenshotsRetained: false, clocksJoinedBySubtraction: false};
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
    controlFiles: [pin('tooling/qualification/native/' + (protocol === 3 ? 'windowserver-session-lossless-capture.swift' : 'windowserver-session-capture.swift'), collectorBytes),
      ...['browser.mjs', 'browser-driver.mjs', 'browser-generic-input.mjs', 'browser-gesture-state.mjs', 'browser-discrete-input.mjs', 'generic-action-oracle.mjs',
        'windowserver-generic-actions.mjs', 'windowserver-session.mjs', 'windowserver-session-process.mjs', 'windowserver-session-budget.mjs',
        ...(protocol === 3 ? ['windowserver-session-lossless.mjs', 'windowserver-session-lossless-process.mjs', 'windowserver-session-lossless-budget.mjs', 'generic-oracle-lossless.mjs'] : []),
        ...(rawFeedback ? ['browser-trace-raw.mjs', 'display-feedback-collector.mjs', 'display-feedback-json.mjs', 'display-feedback.mjs'] : []), 'fixtures.mjs']
        .map(name => pin('tooling/qualification/campaigns/' + name, Buffer.from('// synthetic source pin ' + name + '\n')))],
    sourceFiles: [pin('src/ui/shell.ts', Buffer.from('// synthetic subject source\n'))], fixture: selectedFixture, workerPid, sourceRoot,
    engine: runtime.engine, developerState, developerStateIdentity, subjectDigest, browserCache, tools,
    evidenceStorage: {kind: 'evidence-volume-reference-1', status: 'PENDING', qualification: false, allocationIdentity, root,
      allocationId: authority.allocationId, auditId: 'synthetic-audit', campaignId: 'synthetic-session',
      auditPath: 'audits/synthetic-audit/audit.json', retainedPath: 'evidence-storage/audit.json', intervalMs: 1000}};
  return {root, archive, groupOutput, historicalRoot, transaction, captureFolder, oracleFolder, args, attempt, cell, raw, projection, observation, manifest, processRecord, captured,
    reads, resolutions, replay: () => verifySessionWindowServerEvidence(args), path: retainedPath,
    record: proof => ({...attempt.result.session, nativePresentationProof: proof})};
}


test('complete relocated raw sessions admit detached private R04 bounds and preserve all exact nulls', async t => {
  for (const cache of ['cold', 'warm']) {
    const f = await fixture(t, {cache}), proof = await f.replay(), record = f.record(proof); assert.ok(proof); assert.equal(proof.qualification, false);
    const bounds = readVerifiedSessionBounds(proof, record);
    assert.equal(bounds.requiredActions, 100); assert.equal(bounds.requiredPointerSamples, 2400); assert.equal(bounds.exactLatency, false);
    assert.equal(bounds.actions.length, 100); assert.equal(bounds.actions.flatMap(action => action.pointer).length, 2400);
    assert.ok(bounds.actions.every(action => action.acknowledgement.status === 'OBSERVED' && action.acknowledgement.upperBoundMs === 25));
    assert.ok(bounds.actions.every(action => action.acknowledgement.exactMs === null && action.acknowledgement.lowerMs === null && action.acknowledgement.withinWindow));
    assert.deepEqual(bounds.replay, {protocol: 2, retainedManifestSha256: sha(json(f.manifest)), originalOutputDirectory: join(f.groupOutput, f.captureFolder),
      replayOutputDirectory: join(f.archive, f.captureFolder), outputPathRebased: true, rawTraceIdentity: null});
    assert.equal(bounds.limitations.canonicalVisitINP, false); assert.equal(bounds.limitations.lazyReadiness, false); assert.equal(bounds.limitations.completeDisplaySlots, false);
    assert.deepEqual(readVerifiedSessionBounds(proof, {...record, id: f.attempt.id, producerId: record.id}), bounds);
    assert.ok(record.actions.every(action => action.presentedMs === null && (action.samples ?? []).every(point => point.presentedMs === null)));
    assert.equal(f.observation.join.observedAcknowledgements, 100); assert.equal(f.observation.join.observedEndpoints, 100);
    assert.equal(f.manifest.counts.clockRecords, 5052); assert.equal(f.manifest.pixelFiles.length, 220);
    assert.equal(f.projection.counts.pointerDispatches, 2400); assert.equal(f.projection.counts.discreteDispatches, 125);
    assert.deepEqual(f.raw.actions.filter(action => action.kind === 'stroke').map(action => action.specimenId), brushCorpus().slice(0, 20).map(stroke => stroke.id));
    assert.equal(record.nativePresentation.binding.oracle.pixels, '[omitted: private payload]');
    assert.ok(f.reads.every(path => !isAbsolute(path))); assert.ok(f.resolutions.includes(f.captureFolder + '/manifest.json'));
    await assert.rejects(readFile(join(f.historicalRoot, 'compiler')), {code: 'ENOENT'});
    bounds.actions[0].acknowledgement.upperBoundMs = 0; bounds.actions[0].pointer[1].upperBoundMs = 0;
    assert.equal(readVerifiedSessionBounds(proof, record).actions[0].acknowledgement.upperBoundMs, 25);
    assert.equal(readVerifiedSessionBounds(proof, record).actions[0].pointer[1].upperBoundMs, 8.334);
    for (const token of [{...proof}, structuredClone(proof), JSON.parse(JSON.stringify(proof)), {kind: proof.kind, qualification: true}])
      assert.equal(readVerifiedSessionBounds(token, record), null);
    for (const mutate of [value => {value.id = 'another-session';}, value => {value.cache = cache === 'cold' ? 'warm' : 'cold';},
      value => {value.actions[0].samples[0].inputMs++;}, value => {value.actions[0].presentedMs = 1;}, value => {value.nativePresentation.join.observedAcknowledgements = 99;}]) {
      const changed = structuredClone(record); changed.nativePresentationProof = proof; mutate(changed); assert.equal(readVerifiedSessionBounds(proof, changed), null);
    }
  }
});

test('asynchronous retained readers cannot rewrite captured context or previously returned evidence buffers', async t => {
  const f = await fixture(t, {protocol: 3, rawFeedback: true}), stableRecord = structuredClone(f.attempt.result.session),
    reader = f.args.readRetained, exposed = [];
  let changed = false;
  f.args.readRetained = (path, options) => ({then(resolveRead, rejectRead) {
    reader(path, options).then(value => {
      exposed.push(value);
      if (!changed) {
        changed = true; f.attempt.status = 'FAIL'; f.attempt.result.session.actions[0].inputMs++;
        f.args.configuration.browser.windowServerGenericActions.oracle.storage.container.sha256 = '0'.repeat(64);
        f.args.fixture.corpus.files[0].sha256 = '0'.repeat(64); f.args.developerState.state.h.completed = false;
        f.args.controlFiles.length = 0; f.args.sourceFiles.length = 0; f.args.retainedPaths.length = 0;
        f.args.retainedFiles[0].sha256 = '0'.repeat(64); f.args.evidenceStorage.allocationIdentity.sha256 = '0'.repeat(64);
      }
      // Resolve queues bytes() first; its continuation checks/copies the raw
      // buffer and queues its caller. This microtask then runs before that
      // caller parses. Retained files stay untouched throughout the test.
      resolveRead(value); queueMicrotask(() => value.fill(0));
    }, rejectRead);
  }});
  const proof = await f.replay(); assert.ok(proof); assert.equal(changed, true); assert.ok(exposed.length > 10);
  const bounds = readVerifiedSessionBounds(proof, stableRecord);
  assert.equal(bounds.actions.length, 100); assert.equal(bounds.actions[0].acknowledgement.upperBoundMs, 25);
  assert.equal(bounds.replay.protocol, 3); assert.ok(bounds.replay.rawTraceIdentity);
  assert.equal(readVerifiedSessionBounds(proof, f.attempt.result.session), null);
});

test('scoped R04 metrics consume every original action while R07 and canonical visit measurements stay unavailable', async t => {
  const f = await fixture(t), proof = await f.replay(); assert.ok(proof); const record = f.record(proof), observed = evaluateSession(record);
  assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.equal(observed.qualification, false); assert.deepEqual(observed.failures, []);
  assert.deepEqual(observed.acknowledgements, {n: 0, p95: null, max: null}); assert.deepEqual(observed.pointer, {n: 0, p95: null, max: null});
  assert.equal(observed.upperBounds.acknowledgements.n, 100); assert.equal(observed.upperBounds.acknowledgements.max, 25);
  assert.equal(observed.upperBounds.acknowledgements.observedWithinCeiling, 100);
  assert.equal(observed.upperBounds.acknowledgements.ceilingAssessment, 'observed-upper-bounds-within-ceiling');
  assert.equal(observed.upperBounds.pointer.n, 20); assert.equal(observed.upperBounds.pointer.required, 2400); assert.equal(observed.upperBounds.pointer.diagnosticOnly, true);
  assert.equal(observed.upperBounds.pointer.max, 8.334); assert.equal(observed.upperBounds.exactLatency, false);
  assert.ok(observed.missing.includes('pointer-actual-presentation')); assert.ok(observed.missing.includes('validated-presentation-and-app-attribution-trace'));
  assert.equal(observed.droppedShare60SecondSession, null); assert.equal(observed.frameWork.n, 0); assert.equal(observed.targetMisses.acknowledgement, null);
  assert.equal(observed.upperBounds.limitations.canonicalVisitINP, false); assert.equal(observed.upperBounds.limitations.lazyReadiness, false);
});

test('native upper bounds on or beyond the R04 ceiling never invent exact latency failures', async t => {
  for (const lastAcknowledgementMs of [100, 100.001]) {
    const f = await fixture(t, {lastAcknowledgementMs}), proof = await f.replay(); assert.ok(proof);
    const observed = evaluateSession(f.record(proof)), bound = readVerifiedSessionBounds(proof, f.record(proof)).actions[99].acknowledgement;
    assert.equal(bound.upperBoundMs, lastAcknowledgementMs); assert.equal(bound.exactMs, null); assert.equal(bound.lowerMs, null);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []); assert.equal(observed.acknowledgements.n, 0);
    assert.equal(observed.upperBounds.acknowledgements.n, 100); assert.equal(observed.upperBounds.acknowledgements.max, lastAcknowledgementMs);
    assert.equal(observed.upperBounds.acknowledgements.observedWithinCeiling, lastAcknowledgementMs === 100 ? 100 : 99);
    assert.equal(observed.missing.includes('R04-earliest-acknowledgement-unavailable'), lastAcknowledgementMs > 100);
  }
  const f = await fixture(t, {unavailableSequence: 0}), proof = await f.replay(); assert.ok(proof);
  const observed = evaluateSession(f.record(proof)); assert.equal(observed.upperBounds.acknowledgements.n, 99);
  assert.equal(observed.upperBounds.acknowledgements.ceilingAssessment, 'unavailable'); assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
});

test('canonical attempt scope, selected fixture corpus and independent source pins cannot be substituted', async t => {
  const changes = [f => {f.attempt.id += '-changed';}, f => {f.attempt.cache = 'cold';}, f => {f.attempt.reset.cache = 'cold';},
    f => {f.args.serial = 0;}, f => {f.args.workerPid++;}, f => {f.args.fixture.corpus.files[0].sha256 = '0'.repeat(64);},
    f => {f.args.fixture.corpus.files[0].byteLength++;}, f => {f.args.fixture.definition.width++;}, f => {f.args.fixture.documentId += '-changed';},
    f => {f.args.controlFiles[0].sha256 = '0'.repeat(64);}, f => {f.args.controlFiles.pop();}, f => {f.args.sourceFiles = [];},
    f => {f.args.subjectDigest = 'sha256:' + '0'.repeat(64);}, f => {f.args.browserCache += '-changed';}];
  for (const mutate of changes) {const f = await fixture(t); mutate(f); await assert.rejects(f.replay());}
  for (const mutate of [f => {f.attempt.prime = true;}, f => {f.args.cell.operation = 'text.interaction';},
    f => {f.args.developerState = null;}, f => {f.args.tools.browserPins.browsers = [];}]) {
    const f = await fixture(t); mutate(f); assert.equal(await f.replay(), null);
  }
});

test('owned headed browser, consumed preparation and exact native process closure remain mandatory', async t => {
  for (const mutateBrowser of [({runtime}) => {runtime.headless = true;}, ({runtime}) => {runtime.ownedLaunch.context.freshAtLaunch = false;},
    ({runtime}) => {runtime.ownedLaunch.process.startedAtIdentity += '-changed';}, ({runtime}) => {runtime.executableIdentity.sha256 = '0'.repeat(64);},
    ({runtime}) => {runtime.playwrightModule = '/foreign/node_modules/playwright/index.js';}, ({state}) => {state.h.completed = false;}]) {
    const f = await fixture(t, {mutateBrowser}); await assert.rejects(f.replay());
  }
  for (const mutateProcess of [value => {value.exit.code = 1;}, value => {value.close.signal = 'SIGTERM';}, value => {value.requestedSignals.push('SIGKILL');},
    value => {value.cleanupErrors.push('unconfirmed exit');}]) {const f = await fixture(t, {mutateProcess}); assert.equal(await f.replay(), null);}
  for (const mutateProcess of [value => {value.processIdentity.ownerPid++;}, value => {value.kind = 'windowserver-owned-process-1';},
    value => {value.authorizedSource = {...value.authorizedSource, sha256: '0'.repeat(64)};}, value => {value.command[1] = '/outside/config.json';},
    value => {value.executable.sha256 = '0'.repeat(64);}, value => {value.evidenceVolume.requiredOuterAudit.qualification = true;}]) {
    const f = await fixture(t, {mutateProcess}); await assert.rejects(f.replay());
  }
});

test('three independently retained admissions and final samples preserve the original allocation authority', async t => {
  for (const mutateAdmission of [value => {value.initialAdmission.outputDirectory += '-changed';}, value => {value.preparation.directoryIdentity.ino = '99';},
    value => {value.admission.reservation.requiredReservationBytes--;}, value => {value.admission.allocation.capacityBytes *= 2;},
    value => {value.initialAdmission.limitations.pop();}, value => {value.admission.sample.completeTraversal = false;}]) {
    const f = await fixture(t, {mutateAdmission}); await assert.rejects(f.replay());
  }
  const wrongFinal = await fixture(t, {mutateFinalSample: value => {value.allocationIdentity.sha256 = '0'.repeat(64);}}); await assert.rejects(wrongFinal.replay());
  const finalFail = await fixture(t, {mutateFinalSample: value => {value.sample.observedAllocatedBytes = value.capacityBytes;
    value.alarm = expectedAlarm(value.sample, value.capacityBytes);}}); assert.equal(await finalFail.replay(), null);
  const outer = await fixture(t); outer.args.evidenceStorage.allocationIdentity = {...outer.args.evidenceStorage.allocationIdentity, sha256: '0'.repeat(64)};
  await assert.rejects(outer.replay());
});

test('resealed producer aliases cannot shorten input, exchange action identities or certify native input', async t => {
  for (const mutateProducer of [value => {value.observations.actions.pop();}, value => {value.observations.actions[0].native.events.pop();},
    value => {value.observations.actions[0].pointerDispatches[1].descriptor.sampleIndex = 0;},
    value => {value.observations.actions[0].validation.samples[0].inputMs++;}, value => {value.observations.actions[0].productCompletion.sampleCount--;},
    value => {value.observations.actions[0].pointerDispatches[0].nativeBracketVerified = true;},
    value => {value.observations.actions[0].pointerDispatches[0].missing.push('input-hook-failed');},
    value => {value.observations.actions[1].discreteInput.steps[0].nativeBracketVerified = true;},
    value => {value.observations.actions[1].discreteInput.steps[0].inputEvidence.events[0].isTrusted = false;},
    value => {value.observations.nativeSessionStart.ack.mach = '1000000001';}, value => {value.session.actions[0].samples[0].presentedMs = 1;},
    value => {value.session.actions[0].presentedMs = 1;}]) {const f = await fixture(t, {mutateProducer}); await assert.rejects(f.replay());}
  const f = await fixture(t); f.attempt.result.session.actions[0].inputMs++; await assert.rejects(f.replay());
});

test('independent oracle, binding and diagnostic trace cannot fabricate the complete input-to-pixel relation', async t => {
  for (const mutateOracle of [value => {value.binding.fixtureSha256 = '0'.repeat(64);}, value => {value.actions[0].stateSha256 = '0'.repeat(64);},
    value => {value.actions[1].endpoints[0].subject = 'unrelated-spinner';}, value => {value.actions[0].acknowledgement.prefixOrdinal = 0;}]) {
    const f = await fixture(t, {mutateOracle}); await assert.rejects(f.replay());
  }
  for (const mutateBinding of [value => {value.invocation.sample.ordinal++;}, value => {value.invocation.producerPath = '/outside/browser-cell-1.json';},
    value => {value.environment.browserEnvironmentSha256 = '0'.repeat(64);}, value => {value.config.expectedBrowserPid++;},
    value => {value.oracle.pixels = [...value.oracle.pixels, {...value.oracle.pixels[0], path: 'unrelated.bgra'}];}]) {
    const f = await fixture(t, {mutateBinding}); await assert.rejects(f.replay());
  }
  for (const mutateTrace of [value => {value.collection.completeEventReceived = false;}, value => {value.collection.reasons.push('data-loss');},
    value => {value.kind = 'unsupported-trace';}]) {const f = await fixture(t, {mutateTrace}); assert.equal(await f.replay(), null);}
});

test('raw capture and build files must agree with their separate outer seal after relocation', async t => {
  for (const select of [f => f.captureFolder + '/frame-1.bgra', f => f.captureFolder + '/frames.ndjson', f => f.transaction + '/build-evidence/sdk-manifest.json',
    f => f.transaction + '/build-evidence/windowserver-capture', f => f.oracleFolder + '/pixels/after.bgra', () => 'browser-cell-1.json', () => 'browser-runtime.json']) {
    const f = await fixture(t), path = select(f); await writeFile(f.path(path), Buffer.from('retained member changed\n')); await assert.rejects(f.replay());
  }
  const sealed = await fixture(t), member = sealed.args.retainedFiles.find(file => file.path === sealed.captureFolder + '/frame-1.bgra');
  member.sha256 = '0'.repeat(64); await assert.rejects(sealed.replay(), /outer retained seal/);
  const build = await fixture(t), sdk = build.args.retainedFiles.find(file => file.path === build.transaction + '/build-evidence/sdk-manifest.json');
  sdk.sha256 = '0'.repeat(64); await assert.rejects(build.replay(), /outer retained seal/);
  const inventory = await fixture(t); inventory.args.retainedFiles.pop(); await assert.rejects(inventory.replay(), /inventory/);
  const missing = await fixture(t), path = missing.captureFolder + '/frame-1.bgra';
  missing.args.retainedPaths.splice(missing.args.retainedPaths.indexOf(path), 1); missing.args.retainedFiles = missing.args.retainedFiles.filter(file => file.path !== path);
  assert.equal(await missing.replay(), null);
});

test('runner protocol and cohort paths preserve the same private session proof without accepting copied tokens', async t => {
  const f = await fixture(t), proof = await f.replay(); assert.ok(proof);
  const cell = {...f.cell, host: 'H', cold: 0, warm: 1, primes: 0, requirements: {}, phaseBudgets: [{id: 'R04', phase: 'ui.feedback', targetMs: 50, ceilingMs: 100}]};
  const plan = {campaign: 'Q3', features: 'adapters', jobs: [{id: 'Q3', cells: [cell]}]}, scheduled = executionGroups(plan),
    groups = scheduled.map(group => ({...group, attempts: [f.attempt], status: 'PASS'})), nativeSessions = new Map([[f.attempt.id, proof]]);
  const cohort = evaluateInteractionCohort(plan, cell, [f.attempt], new Map(), new Map(), nativeSessions)[0];
  assert.equal(cohort.outcome, 'INCONCLUSIVE'); assert.equal(cohort.sessions[0].upperBounds.acknowledgements.n, 100);
  const result = summarize(plan, groups, {nativeSessions}); assert.equal(result.qualification, false); assert.equal(result.cells[0].status, 'INCONCLUSIVE');
  const protocols = result.cells[0].protocols, direct = protocols.find(value => value.attempt === f.attempt.id && value.kind === 'perf-interaction-session-1');
  assert.equal(direct.upperBounds.acknowledgements.n, 100);
  const phase = result.cells[0].phaseBudgets[0]; assert.equal(phase.status, 'PASS'); assert.equal(phase.samples.length, 100);
  assert.equal(phase.maximumMs, null); assert.equal(phase.maximumUpperBoundMs, 25); assert.ok(phase.samples.every(value => value.durationMs === null && value.bound === 'upper'));
  assert.ok(protocols.some(value => value.metric === 'INP' && value.outcome === 'INCONCLUSIVE'));
  const withheld = summarize(plan, groups, {nativeSessions: new Map([[f.attempt.id, {...proof}]])});
  assert.equal(withheld.cells[0].phaseBudgets[0].status, 'INCONCLUSIVE');
  assert.equal(withheld.cells[0].protocols.find(value => value.attempt === f.attempt.id && value.kind === 'perf-interaction-session-1').upperBounds.acknowledgements.n, 0);
});

test('runner upper-bound phases retain inconclusive attempts and exact breach priority', async t => {
  const f = await fixture(t, {lastAcknowledgementMs: 100.001}), proof = await f.replay(); assert.ok(proof);
  const cell = {...f.cell, host: 'H', cold: 0, warm: 1, primes: 0, requirements: {}, phaseBudgets: [{id: 'R04', phase: 'ui.feedback', targetMs: 50, ceilingMs: 100}]};
  const plan = {campaign: 'Q3', features: 'adapters', jobs: [{id: 'Q3', cells: [cell]}]}, scheduled = executionGroups(plan), nativeSessions = new Map([[f.attempt.id, proof]]);
  const phase = attempt => summarize(plan, scheduled.map(group => ({...group, attempts: [attempt], status: 'PASS'})), {nativeSessions}).cells[0].phaseBudgets[0];
  const observed = phase(f.attempt); assert.equal(observed.status, 'INCONCLUSIVE'); assert.equal(observed.maximumUpperBoundMs, 100.001); assert.equal(observed.maximumMs, null);
  assert.equal(phase({...f.attempt, status: 'INCONCLUSIVE'}).status, 'INCONCLUSIVE');
  assert.equal(phase({...f.attempt, result: {...f.attempt.result, phases: [{name: 'ui.feedback', durationMs: 101}]}}).status, 'FAIL');
  assert.equal(phase({...f.attempt, status: 'FAIL'}).status, 'FAIL');
});

test('explicit lossless sessions replay packed native pixels and independent oracle review with unchanged R04 bounds', async t => {
  const f = await fixture(t, {protocol: 3}), proof = await f.replay(); assert.ok(proof);
  const record = f.record(proof), bounds = readVerifiedSessionBounds(proof, record), observed = evaluateSession(record);
  assert.equal(bounds.replay.protocol, 3); assert.equal(bounds.replay.outputPathRebased, true); assert.equal(bounds.requiredActions, 100);
  assert.equal(bounds.actions.flatMap(action => action.pointer).length, 2400); assert.ok(bounds.actions.every(action => action.acknowledgement.upperBoundMs === 25));
  assert.equal(f.manifest.counts.clockRecords, 5052); assert.equal(f.manifest.counts.duplicateFrames, 20);
  assert.equal(f.manifest.counts.pixelBytes, 1760); assert.equal(f.manifest.pixelFiles, undefined);
  assert.deepEqual(f.args.retainedPaths.filter(path => path.startsWith(f.captureFolder + '/')).sort(),
    ['frames.ndjson', 'manifest.json', 'pixels.bin'].map(path => f.captureFolder + '/' + path).sort());
  assert.ok(f.args.retainedPaths.includes(f.oracleFolder + '/oracle-pixels.bin')); assert.ok(f.args.retainedPaths.includes(f.oracleFolder + '/semantic-review.record'));
  assert.ok(!f.args.retainedPaths.some(path => path.startsWith(f.oracleFolder + '/') && path.endsWith('.bgra')));
  assert.equal(f.observation.nativeSchemaVersion, 3); assert.equal(f.observation.join.captureSchemaVersion, 3);
  assert.equal(f.processRecord.kind, 'windowserver-session-owned-process-3'); assert.equal(f.processRecord.evidenceVolume.kind, 'windowserver-session-evidence-reference-2');
  assert.equal(f.args.controlFiles[0].path, 'tooling/qualification/native/windowserver-session-lossless-capture.swift');
  assert.equal(f.observation.binding.semanticOracleReview.generatedByCapture, false); assert.equal(f.observation.binding.semanticOracleReview.authorityFromFlags, false);
  assert.equal(observed.upperBounds.acknowledgements.n, 100); assert.equal(observed.upperBounds.acknowledgements.max, 25);
  assert.deepEqual(observed.acknowledgements, {n: 0, p95: null, max: null}); assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
  assert.throws(() => getWindowServerSessionObservations(f.captured));
  assert.throws(() => getWindowServerSessionLosslessObservations({...f.captured}));
  const raw = await fixture(t); assert.throws(() => getWindowServerSessionLosslessObservations(raw.captured));
});

test('lossless encoded container, packed index and independent review retain distinct consumed pins', async t => {
  for (const select of [f => f.captureFolder + '/pixels.bin', f => f.oracleFolder + '/oracle-pixels.bin',
    f => f.oracleFolder + '/oracle-pixels.json', f => f.oracleFolder + '/semantic-review.record']) {
    const f = await fixture(t, {protocol: 3}), path = select(f); await writeFile(f.path(path), Buffer.from('changed encoded or review member\n')); await assert.rejects(f.replay());
  }
  for (const mutateBinding of [value => {value.oracle.storage.reviewReference = 'different-review';},
    value => {value.semanticOracleReview.authorityFromFlags = true;}, value => {value.oracle.storage.index.sha256 = '0'.repeat(64);},
    value => {value.oracle.storage.container.path = '/foreign/pixels.bin';}]) {
    const f = await fixture(t, {protocol: 3, mutateBinding}); await assert.rejects(f.replay());
  }
  const missing = await fixture(t, {protocol: 3}), path = missing.oracleFolder + '/semantic-review.record';
  missing.args.retainedPaths.splice(missing.args.retainedPaths.indexOf(path), 1); missing.args.retainedFiles = missing.args.retainedFiles.filter(file => file.path !== path);
  assert.equal(await missing.replay(), null);
});

test('schema two evidence cannot be relabelled as the separately selected lossless protocol', async t => {
  for (const protocol of [2, 3]) {
    const changed = await fixture(t, {protocol, mutateProducer: value => {value.session.nativePresentation.nativeSchemaVersion = protocol === 2 ? 3 : 2;}});
    await assert.rejects(changed.replay());
  }
  const process = await fixture(t, {protocol: 3, mutateProcess: value => {value.kind = 'windowserver-session-owned-process-2'; value.schemaVersion = 2;}});
  await assert.rejects(process.replay());
  const source = await fixture(t, {protocol: 3}); source.args.controlFiles[0].path = 'tooling/qualification/native/windowserver-session-capture.swift';
  await assert.rejects(source.replay());
  const allowance = await fixture(t, {protocol: 3}); delete allowance.args.configuration.browser.windowServerGenericActions.evidenceReservation.nativeArtifactBytes;
  await assert.rejects(allowance.replay());
});

test('selected raw display feedback replays one closed owned artifact while R07 remains unavailable', async t => {
  const f = await fixture(t, {protocol: 3, rawFeedback: true}), proof = await f.replay(); assert.ok(proof);
  const record = f.record(proof), bounds = readVerifiedSessionBounds(proof, record), rawPath = 'browser-feedback-1.raw.json';
  const identity = f.args.retainedFiles.find(file => file.path === rawPath);
  assert.deepEqual(bounds.replay.rawTraceIdentity, identity);
  assert.equal(record.trace.kind, 'browser-diagnostic-trace'); assert.equal(record.trace.attributionComplete, false);
  assert.equal(f.attempt.result.trace.rawFeedback.analysis.rawArtifact.fullJsonValidated, true);
  assert.equal(f.attempt.result.trace.rawFeedback.analysis.rawArtifact.matchesCollectionManifest, true);
  const analysis = f.attempt.result.trace.rawFeedback.analysis;
  assert.equal(analysis.status, 'INCONCLUSIVE'); assert.equal(analysis.qualification, false);
  assert.deepEqual(analysis.missingAuthorities, R07_MISSING_AUTHORITIES); assert.equal(analysis.missingAuthorities.length, 5);
  assert.equal(analysis.cohort.status, 'declaration-valid'); assert.equal(analysis.cohort.declaredActions, 100);
  assert.equal(analysis.cohort.declaredStrokePoints, 2400); assert.equal(analysis.cohort.observedExecution, false);
  assert.equal(analysis.cohort.qualification, false); assert.equal(analysis.cohort.expectedPhysicalSlots, null);
  assert.equal(analysis.reasons.includes('full-r07-cohort-declaration-invalid'), false);
  assert(analysis.reasons.includes('stock-trace-does-not-prove-full-r07-presentation'));
  assert(Object.values(analysis.metrics).every(value => value.status === 'unavailable'));
  const sidecar = JSON.parse(await readFile(f.path(rawPath + '.manifest.json'), 'utf8'));
  assert.equal(sidecar.manifest.saved, false); assert.equal(sidecar.collection.status, 'incomplete');
  assert.equal(f.attempt.result.trace.rawFeedback.manifest.manifest.saved, true);
  assert.ok(f.resolutions.includes(rawPath)); assert.equal(bounds.replay.protocol, 3);
  const observed = evaluateSession(record); assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
  assert.equal(observed.upperBounds.acknowledgements.n, 100); assert.deepEqual(observed.pointer, {n: 0, p95: null, max: null});
});

test('selected raw feedback cannot substitute its provisional sidecar or incomplete returned closure', async t => {
  for (const mutateProducer of [value => {delete value.trace.rawFeedback.manifest;},
    value => {value.trace.rawFeedback.manifest.manifest.saved = false;}, value => {value.trace.rawFeedback.manifest.collection.eof = false;},
    value => {value.trace.rawFeedback.manifest.collection.dataLossOccurred = true;},
    value => {value.trace.rawFeedback.manifest.cleanup.browserCleanupRequired = true;},
    value => {value.trace.rawFeedback.manifest.artifact.fileMayChangeAfterReturn = true;}]) {
    const f = await fixture(t, {protocol: 3, rawFeedback: true, mutateProducer}); assert.equal(await f.replay(), null);
  }
  const missing = await fixture(t, {protocol: 3, rawFeedback: true}), sidecar = 'browser-feedback-1.raw.json.manifest.json';
  missing.args.retainedPaths.splice(missing.args.retainedPaths.indexOf(sidecar), 1); missing.args.retainedFiles = missing.args.retainedFiles.filter(file => file.path !== sidecar);
  assert.equal(await missing.replay(), null);
  for (const mutateProducer of [value => {value.trace.rawFeedback.manifest.manifest.path = '/outside/raw.json.manifest.json';},
    value => {value.trace.rawFeedback.manifest.manifest.returnedReceiptAuthority = 'standalone-sidecar';}]) {
    const f = await fixture(t, {protocol: 3, rawFeedback: true, mutateProducer}); await assert.rejects(f.replay(), /sidecar reference/);
  }
  const resealed = await fixture(t, {protocol: 3, rawFeedback: true}), sidecarPath = 'browser-feedback-1.raw.json.manifest.json';
  const sidecarValue = JSON.parse(await readFile(resealed.path(sidecarPath), 'utf8'));
  sidecarValue.collection.reasons.push('contradictory-retained-sidecar'); const sidecarBytes = json(sidecarValue);
  await writeFile(resealed.path(sidecarPath), sidecarBytes);
  Object.assign(resealed.args.retainedFiles.find(file => file.path === sidecarPath), pin(sidecarPath, sidecarBytes));
  await assert.rejects(resealed.replay(), /provisional sidecar differs/);
  const changed = await fixture(t, {protocol: 3, rawFeedback: true}), rawPath = changed.path('browser-feedback-1.raw.json');
  const original = await readFile(rawPath), corrupted = Buffer.from(original.toString('utf8').replace('"Paint"', '"Other"'));
  assert.equal(corrupted.length, original.length); assert.notDeepEqual(corrupted, original); await writeFile(rawPath, corrupted);
  assert.equal(await changed.replay(), null);
});

test('session native inventory accepts only bounded members from the selected native and oracle namespaces', () => {
  const id = 'gis-' + 'a'.repeat(48);
  for (const path of [`worker/native-${id}/stdout.ndjson`, `worker/native-${id}/capture/frames.ndjson`, `worker/native-${id}/capture/frame-9012.bgra`,
    `worker/native-${id}/capture/pixels.bin`, `worker/native-${id}/build-evidence/collector.swift`, `worker/native-${id}/build-evidence/windowserver-capture`,
    `worker/oracle-${id}/pixels/prefix-1.bgra`, `worker/oracle-${id}/oracle-pixels.bin`, `worker/oracle-${id}/semantic-review.record`]) assert.equal(isSessionNativeEvidencePath(path), true, path);
  for (const path of [`worker/native-${id}/capture/frame-0.bgra`, `worker/native-${id}/capture/frame-10000.bgra`, `worker/native-${id}/capture/unknown.bin`,
    `worker/oracle-${id}/../other.bgra`, 'worker/native-gis-short/capture/frame-1.bgra', 'worker/unrelated/image.bgra']) assert.equal(isSessionNativeEvidencePath(path), false, path);
});


test('selected raw replay rejects substituted cohort declarations even when the raw artifact is unchanged', async t => {
  for (const mutateProducer of [value => {value.trace.rawFeedback.analysis.cohort.declaredActions = 99;},
    value => {value.trace.rawFeedback.analysis.cohort.observedExecution = true;},
    value => {value.trace.rawFeedback.analysis.cohort.expectedPhysicalSlots = 3600;},
    value => {value.trace.rawFeedback.analysis.missingAuthorities.pop();},
    value => {value.trace.rawFeedback.analysis.qualification = true;}]) {
    const f = await fixture(t, {protocol: 3, rawFeedback: true, mutateProducer});
    await assert.rejects(f.replay(), /raw display diagnostic replay differs/);
  }
});

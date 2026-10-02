import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {verifyFirstUseWindowServerEvidence, readVerifiedFirstUseBounds, isFirstUseNativeEvidencePath} from '../../tooling/qualification/campaigns/windowserver-first-use-verification.mjs';
import {discreteInputDescriptor, validateDiscreteInput} from '../../tooling/qualification/campaigns/browser-discrete-input.mjs';
import {evaluateFirstUse} from '../../tooling/qualification/campaigns/metrics.mjs';
import {evaluateInteractionCohort, executionGroups, summarize} from '../../tooling/qualification/campaigns/run.mjs';
import {normalizeResult} from '../../tooling/qualification/campaigns/worker.mjs';
import {sanitize} from '../../tooling/qualification/campaigns/common.mjs';

// Synthetic retained protocol fixtures, authored without execution. No browser,
// compiler, native process, or display capture is started. The tiny arrays and
// nonexecutable Mach-O header test byte admission only, never qualification.
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

function inputFor(descriptor) {
  return validateDiscreteInput({descriptor, clock: 'browser-performance', timeOrigin: 123000, endedTimeOrigin: 123000,
    armedMs: 10000, stoppedMs: 10004, visibility: 'visible', endedVisibility: 'visible', targetConnectedAtArm: true, targetConnected: true,
    events: ['pointerdown', 'pointerup', 'click'].map((type, ordinal) => ({
      eventId: `${descriptor.sessionId}/${descriptor.actionId}/${descriptor.stepId}/event-${ordinal}`, ordinal, type,
      timeStampMs: 10001 + ordinal, observedMs: 10001.25 + ordinal, isTrusted: true, targetMatched: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ordinal === 0 ? 1 : 0,
    })), overflow: false}, descriptor);
}

async function fixture(t, {feature = 'Mask', acknowledgementMs = 50, readinessMs = 250, ordinal = 1,
  attemptId = `H2/first-use/cold/scored/${ordinal}`, windowAnchorMach = '8000000',
  mutateCapture, mutateProcess, mutateOracle, mutateTrace, mutateBrowser, mutateProducer, mutateNative} = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'first-use-retained-protocol-')); await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  // Historical live inputs never exist. Replay may use only the relocated
  // retained files, not the vanished original compiler/browser/source roots.
  const groupOutput = join(root, 'absent-original-group'), historicalRoot = join(root, 'absent-build-inputs');
  const archive = join(root, 'relocated-evidence'); await mkdir(archive, {mode: 0o700});
  const members = new Map(), modes = new Map();
  const put = (path, bytes, mode = 0o600) => {members.set(path, bytes); modes.set(path, mode); return pin(path, bytes);};
  const descriptor = discreteInputDescriptor({sessionId: 'input-' + uuid, actionId: 'first-use', stepId: 'open-panel', family: 'first-use',
    target: {control: feature === 'Mask' ? 'mask-tool' : 'adapter-library'}, input: {kind: 'click'}});
  const nativeActionId = 'fu-' + sha(JSON.stringify(descriptor)).slice(0, 48), transaction = 'native-' + nativeActionId, oracleFolder = 'oracle-' + nativeActionId;
  const inputEvidence = inputFor(descriptor), collectorBytes = Buffer.from('// synthetic retained collector; never compiled\n');
  const build = syntheticBuild(collectorBytes, historicalRoot);
  for (const [name, bytes, mode] of build.members) put(transaction + '/build-evidence/' + name, bytes, mode);
  const roi = {x: 4, y: 3, width: 2, height: 1}, display = {id: 7, width: 100, height: 60};
  const config = {schemaVersion: 1, displayID: 7, expectedBrowserPid: 23, roi, durationMs: 2000, maxFrames: 60, maxBytes: 4096};
  const geometry = {displayBoundsPoints: {x: 0, y: 0, width: 100, height: 60}, displayPoints: {x: 0, y: 0, width: 100, height: 60},
    modePixels: {width: 100, height: 60}, filterPoints: {x: 0, y: 0, width: 100, height: 60}, pointPixelScale: 1, backingScale: {x: 1, y: 1},
    scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'};
  const admission = {ownerPID: 23, windowNumber: 9, bounds: {x: 0, y: 0, width: 100, height: 60}, layer: 0, alpha: 1, onScreen: true,
    roiPoints: {...roi}, aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0};
  const sample = (ordinal, displayTime, pixels) => ({schemaVersion: 1, event: 'sample', ordinal, statusRaw: 0, status: 'complete', ownerPID: 23, windowNumber: 9,
    callbackMach: String(displayTime + 1000000), windowObservationMach: String(displayTime + 1000001), displayTimeMach: String(displayTime),
    aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0, pts: {value: '0', timescale: 1, flags: 0, epoch: '0'}, pixelFormat: 1111970369,
    width: 100, height: 60, roi, retained: true, file: `frame-${ordinal}.bgra`, sha256: sha(pixels), byteLength: pixels.length, contentScale: 1, scaleFactor: 1});
  const clock = (suffix, mach) => ({schemaVersion: 1, event: 'clock', id: nativeActionId + suffix, mach: String(mach)});
  const anchor = clock('-win-before', windowAnchorMach), before = clock('-before', 10000000), after = clock('-after', 12000000);
  const targetTime = 10000000 + acknowledgementMs * 1000000, readyAck = clock('-ready', 10000000 + readinessMs * 1000000);
  const rows = [sample(1, 5000000, beforePixels), anchor, before, after, sample(2, targetTime, afterPixels), readyAck];
  rows.sort((a, b) => Number(BigInt(a.mach ?? a.windowObservationMach) - BigInt(b.mach ?? b.windowObservationMach)));
  mutateCapture?.({config, display, geometry, admission, rows, before, after, anchor, readyAck});
  const bracket = {kind: 'native-action-bracket-1', actionId: nativeActionId, status: 'complete', actionCompleted: true, before, after};
  const captureFolder = transaction + '/capture', timebase = {numer: 1, denom: 1};
  const framesBytes = ndjson(rows), manifest = {kind: 'windowserver-capture-1', schemaVersion: 1, config, display, captureGeometry: geometry, windowAdmission: admission,
    timebase, startedMach: '0', endedMach: '2000000000', terminalReason: 'requested-stop',
    counts: {sampleRecords: 2, completeFrames: 2, clockRecords: 4, pixelBytes: 16, unretainedSamples: 0},
    frames: pin('frames.ndjson', framesBytes), pixelFiles: [pin('frame-1.bgra', beforePixels), pin('frame-2.bgra', afterPixels)]};
  const manifestBytes = json(manifest);
  put(captureFolder + '/manifest.json', manifestBytes); put(captureFolder + '/frames.ndjson', framesBytes);
  put(captureFolder + '/frame-1.bgra', beforePixels); put(captureFolder + '/frame-2.bgra', afterPixels);
  const ready = {schemaVersion: 1, event: 'ready', kind: manifest.kind, config, outputDirectory: join(groupOutput, captureFolder), display, captureGeometry: geometry,
    windowAdmission: admission, roi, timebase, startedMach: '0', pixelByteLimit: config.maxBytes, metadataByteLimit: 8 * 1024 ** 2,
    manifestByteLimit: 2 * 1024 ** 2, maxClockRecords: 256, pointPixelScale: 1};
  const stopped = {schemaVersion: 1, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'};
  const stdout = ndjson([ready, ...rows, stopped]); put(transaction + '/stdout.ndjson', stdout); put(transaction + '/stderr.log', Buffer.alloc(0));
  const configBytes = json(config); put(transaction + '/config.json', configBytes);
  const selectedFixture = {documentId: 'document-fixture', seal: {path: '/absent/fixture/manifest.json', sha256: 'f'.repeat(64)}};
  const runtime = {headless: false, browserPid: 23, backendPid: 24, engine: 'chromium', version: 'fixture-version', revision: 'fixture-revision', executable: '/absent/browser-cache/chromium/browser',
    executableIdentity: {bytes: 1, sha256: 'sha256:' + 'e'.repeat(64)}, playwrightModule: '/absent/prepared/source/node_modules/playwright/index.js',
    root: join(groupOutput, 'root'), fixtureSeal: selectedFixture.seal, viewport: {width: 100, height: 60}, deviceScaleFactor: 1,
    proxyRoute: {status: 'PASS'}, capabilitySetup: {status: 'PASS'}};
  const browserIdentity = {cache: {sha256: 'sha256:' + 'd'.repeat(64)}, engines: [{engine: runtime.engine, executable: runtime.executable,
    version: runtime.version, revision: runtime.revision, ...runtime.executableIdentity}]};
  const sourceRoot = '/absent/prepared/source', subjectDigest = 'sha256:' + 'c'.repeat(64), browserCache = '/absent/browser-cache';
  const state = {productRepo: sourceRoot, sourceDigest: subjectDigest, buildProvenancePath: '/absent/prepared/build-provenance.json',
    h: {source: sourceRoot, workspace: dirname(sourceRoot), completed: true, browserCache, browserIdentity}};
  const developerState = {kind: 'developer-runtime-state-1', state, sha256: sha(json(state))};
  const developerStateIdentity = pin('/absent/prepared/bridge-state.json', json(developerState));
  const tools = {node: {executable: '/absent/node', version: '26.10.0'},
    browserPins: {browsers: [{name: runtime.engine, browserVersion: runtime.version, revision: runtime.revision}]}};
  mutateBrowser?.({runtime, state, developerState, developerStateIdentity, tools});
  put('browser-runtime.json', json(runtime));
  const environmentValue = {engine: runtime.engine, version: runtime.version, revision: runtime.revision,
    executableSha256: runtime.executableIdentity.sha256.replace(/^sha256:/, ''), viewport: runtime.viewport, deviceScaleFactor: runtime.deviceScaleFactor};
  const environment = {fixtureSha256: selectedFixture.seal.sha256, browserEnvironmentSha256: sha(JSON.stringify(environmentValue)), environment: environmentValue};
  const oracle = {kind: 'first-use-panel-oracle-1', schemaVersion: 1, feature,
    subject: feature === 'Mask' ? 'mask-controls-panel' : 'local-adapter-library-panel', pixelFormat: 'BGRA8', display, roi,
    binding: {fixtureSha256: environment.fixtureSha256, browserEnvironmentSha256: environment.browserEnvironmentSha256},
    before: {state: 'closed', bytes: beforePixels.length, sha256: sha(beforePixels)}, after: {state: 'open', bytes: afterPixels.length, sha256: sha(afterPixels)}};
  mutateOracle?.(oracle);
  const oracleBytes = json(oracle); put(oracleFolder + '/oracle.json', oracleBytes);
  put(oracleFolder + '/before.bgra', beforePixels); put(oracleFolder + '/after.bgra', afterPixels);
  const buildSelection = {receiptPath: build.receiptPath, receiptSha256: build.receiptSha256};
  const configuration = {browser: {engine: 'chromium', windowServerFirstUse: {kind: 'windowserver-first-use-configuration-1', build: buildSelection,
    oracle: {path: join(historicalRoot, 'oracle.json'), sha256: sha(oracleBytes)}, displayID: config.displayID, roi,
    capture: {durationMs: config.durationMs, maxFrames: config.maxFrames, maxBytes: config.maxBytes}}}};
  const binding = {kind: 'first-use-windowserver-input-binding-1', feature, descriptor, nativeActionId,
    collectorSource: pin(join(historicalRoot, 'capture.swift'), collectorBytes), build: buildSelection,
    oracle: {...pin(join(groupOutput, oracleFolder, 'oracle.json'), oracleBytes), pixels: [pin('before.bgra', beforePixels), pin('after.bgra', afterPixels)]},
    browser: runtime, environment, config, semanticOracleReview: 'external-exact-pinned-oracle-required',
    historicalWindowOcclusion: 'adjacent-native-window-observations-not-atomic-at-frame-time'};
  put(oracleFolder + '/binding.json', json(binding));
  const workerPid = 100, processIdentity = {kind: 'windowserver', ownerPid: workerPid, pid: 123, pgid: 123, startedAtIdentity: 'synthetic-birth', executable: build.binaryPath};
  for (const [kind, pid, executable] of [['browser', runtime.browserPid, runtime.executable], ['backend', runtime.backendPid, tools.node.executable]]) {
    put('owned-process-' + pid + '-' + uuid + '.json', json({kind: 'perf-owned-processes-1', ownerPid: workerPid,
      processes: [{kind, pid, pgid: pid, startedAtIdentity: 'synthetic-' + kind + '-birth', executable}]}));
  }
  const registrationPath = 'owned-process-123-' + uuid + '.json';
  const registrationBytes = json({kind: 'perf-owned-processes-1', ownerPid: workerPid, processes: [{kind: processIdentity.kind, pid: processIdentity.pid,
    pgid: processIdentity.pgid, startedAtIdentity: processIdentity.startedAtIdentity, executable: processIdentity.executable}]});
  put(registrationPath, registrationBytes);
  const processRecord = {kind: 'windowserver-owned-process-1', schemaVersion: 1, outcome: 'CAPTURE_REPLAYED', failure: null, cleanupErrors: [], requestedSignals: [],
    exit: {code: 0, signal: null}, close: {code: 0, signal: null}, processIdentity, registration: pin(join(groupOutput, registrationPath), registrationBytes),
    config: pin('config.json', configBytes), build: {...buildSelection, sourceSha256: sha(collectorBytes)},
    buildEvidence: {...pin('build-evidence/manifest.json', build.manifestBytes), sourceSha256: sha(collectorBytes), receiptSha256: build.receiptSha256, binarySha256: build.binarySha256},
    executable: {path: build.binaryPath, bytes: build.binaryBytes, sha256: build.binarySha256}, command: [build.binaryPath, join(groupOutput, transaction, 'config.json'), join(groupOutput, captureFolder)],
    outputDirectory: join(groupOutput, captureFolder), stdout: pin('stdout.ndjson', stdout), stderr: pin('stderr.log', Buffer.alloc(0)),
    streamBytesObserved: {stdout: stdout.length, stderr: 0}, manifest: pin('capture/manifest.json', manifestBytes)};
  mutateProcess?.(processRecord);
  const processBytes = json(processRecord); put(transaction + '/process.json', processBytes);
  const startMs = 100, readyMs = 200, endMs = 1100, captureStoppedMs = 1101;
  const windowStartAnchor = {kind: 'first-use-native-window-anchor-1', status: 'complete', descriptor, nativeActionId,
    relation: 'ack-before-driver-window-start', ack: anchor};
  const readinessWitness = {kind: 'first-use-native-ready-1', status: 'complete', descriptor, nativeActionId, callerReadyMs: readyMs,
    windowStartMs: startMs, windowEndMs: endMs, requestRunnerMs: 201, receivedRunnerMs: 202, clock: 'runner-monotonic', ack: readyAck};
  const observation = {kind: 'first-use-windowserver-observation-1', feature, descriptor, nativeActionId, qualification: false, binding,
    ready, processIdentity, baseline: rows.find(row => row.event === 'sample' && row.ordinal === 1), bracket, inputEvidence, windowStartAnchor, readinessWitness,
    readinessBindingMatched: true,
    join: {kind: 'first-use-windowserver-pixel-join-1', source: 'ScreenCaptureKit-full-display', endpoint: 'WindowServer-presented-pixels',
      feature, subject: oracle.subject, descriptor, automation: inputEvidence.automation, inputEvidence, nativeActionId,
      binding: {fixtureSha256: environment.fixtureSha256, browserEnvironmentSha256: environment.browserEnvironmentSha256, browserPid: runtime.browserPid, windowNumber: 9},
      oracleSha256: sha(oracleBytes), captureSha256: sha(manifestBytes), qualification: false,
      semanticReviewRequired: true, collectorSourceAndInvocationAdmissionRequired: true, browserInputInvocationAdmissionRequired: true,
      physicalScanout: 'unavailable', displaySlotCoverage: 'unavailable', firstPresentedFrameCoverage: 'unavailable', browserToNativeClockCorrelation: 'unavailable',
      firstMeaningfulPaintLowerBoundMs: null, firstMeaningfulPaintExactMs: null, firstMeaningfulPaintUpperBoundMs: acknowledgementMs,
      budget: 'R04', targetMs: 50, ceilingMs: 100, status: 'observed', baselineOrdinal: 1, matchedOrdinal: 2,
      observedDisplayTimeMach: String(targetTime), inputBracket: {earliestMach: before.mach, latestMach: after.mach},
      ceilingAssessment: acknowledgementMs <= 100 ? 'upper-bound-within-ceiling' : 'unavailable-earliest-frame-not-proven'},
    publicWitness: {kind: 'public-first-use-ready-1', completed: true, feature, startMs, readyMs, endMs, captureStoppedMs, observationWindowMs: 1000, clock: 'runner-monotonic'},
    evidence: {manifest: pin(join(groupOutput, captureFolder, 'manifest.json'), manifestBytes), process: {...processRecord, receipt: pin(join(groupOutput, transaction, 'process.json'), processBytes)}},
    failedProcess: null, missing: [], failures: []};
  mutateNative?.(observation);
  const discreteInput = {kind: 'browser-discrete-action-1', schemaVersion: 1, sessionId: descriptor.sessionId, actionId: descriptor.actionId,
    family: descriptor.family, automation: inputEvidence.automation, steps: [{dispatchCompleted: true, inputEvidence, nativeBracket: bracket, nativeBracketVerified: false, missing: []}],
    inputMs: inputEvidence.inputMs, clock: inputEvidence.clock, timeOrigin: inputEvidence.timeOrigin, status: 'PASS', failures: [], missing: [], qualification: false};
  const observations = {feature, startMs, inputMs: discreteInput.inputMs, inputClock: discreteInput.clock, inputTimeOrigin: discreteInput.timeOrigin,
    discreteInput, status: 'PASS', missing: [], readyMs, readyClock: 'runner-monotonic', nativeReadiness: readinessWitness,
    windowClock: 'runner-monotonic', endMs, captureStoppedMs, observationWindowMs: 1000, meaningful: true, presentedMs: null};
  const trace = {kind: 'sanitized-chromium-trace-1', clock: 'chromium-monotonic-microseconds', collection: {status: 'complete', completeEventReceived: true, reasons: []},
    events: [{cat: 'devtools.timeline', name: 'Paint', ph: 'X', pid: 50, tid: 51, ts: 100, dur: 1}]};
  mutateTrace?.(trace);
  const traceBytes = json(trace); put('browser-trace-1.json', traceBytes);
  const artifact = pin(join(groupOutput, 'browser-trace-1.json'), traceBytes);
  const cell = {id: 'H2/first-use', operation: 'interaction.first-use', workload: 'W1', handler: 'browser', kind: 'operation',
    parameters: {browser: 'chromium', feature: feature === 'Mask' ? 'mask' : 'adapter', windowMs: 1000}};
  const firstUse = {id: cell.id + ':' + ordinal, reset: true, startMs, endMs, captureStoppedMs,
    inputMs: observations.inputMs, inputClock: observations.inputClock, inputTimeOrigin: observations.inputTimeOrigin, discreteInput,
    nativePresentation: observation, nativeReadiness: readinessWitness, readyMs, readyClock: observations.readyClock,
    windowClock: observations.windowClock, presentedMs: null, meaningful: true, feature,
    trace: {kind: 'browser-diagnostic-trace', sha256: artifact.sha256, attributionComplete: false}, outcome: 'expected',
    resetEvidence: {freshBrowserContext: true, fixtureCopiedBeforeLaunch: true, browserPid: runtime.browserPid, backendPid: runtime.backendPid}};
  const producer = {cellId: cell.id, operation: cell.operation, status: 'PASS', elapsedMs: 1050,
    phases: [{name: 'browser.action', startMs: 95, endMs: 1145, durationMs: 1050, clock: 'runner-monotonic', scope: 'includes Playwright action/witness/trace overhead; never narrower child budget'}],
    measurements: [], measurementUnavailable: [], observations, evidence: {productPhases: {phases: []}, observedCommandReceipts: [], rawVisits: [], replacedRealms: [], readiness: null},
    network: {counts: {accepted: 1}}, firstUse, timingSamplesReusable: true, trace: {kind: 'browser-diagnostic-trace', collection: trace.collection, artifact}, missing: [], error: null,
    rawConsoleRetained: false, screenshotsRetained: false, clocksJoinedBySubtraction: false};
  mutateProducer?.(producer);
  // browser-cell bytes use sanitize(producer). The worker normalizes its live
  // return, then the journal applies sanitize to that complete attempt.
  put('browser-cell-1.json', Buffer.from(JSON.stringify(sanitize(producer), null, 2)));
  const attempt = sanitize({id: attemptId, cache: 'cold', ordinal, prime: false, startMs: 90, endMs: 1200,
    reset: {status: 'PASS', cache: 'cold'}, status: 'PASS',
    result: normalizeResult({...producer, artifacts: [join(groupOutput, 'browser-cell-1.json'), artifact.path]}, 90, 1200)});
  for (const [path, bytes] of members) {
    const destination = join(archive, path); await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeFile(destination, bytes, {flag: 'wx', mode: modes.get(path)}); await chmod(destination, modes.get(path));
  }
  const reads = [], resolutions = [], retainedPaths = [...members.keys()];
  function retainedPath(path) {assert.equal(isAbsolute(path), false); const actual = resolve(archive, path); assert.ok(actual.startsWith(archive + '/')); return actual;}
  const args = {attempt, cell, configuration, groupOutput, retainedPaths, readRetained: async (path, {maximum}) => {
      const actual = retainedPath(path); assert.ok(Number.isSafeInteger(maximum) && maximum > 0); assert.ok((await stat(actual)).size <= maximum);
      reads.push(path); return readFile(actual);
    }, resolveRetained: async path => {resolutions.push(path); return retainedPath(path);},
    controlFiles: [pin('tooling/qualification/native/windowserver-capture.swift', collectorBytes)], sourceFiles: [pin('src/ui/shell.ts', Buffer.from('// synthetic subject source\n'))],
    fixture: selectedFixture, workerPid, sourceRoot, engine: runtime.engine, developerState, developerStateIdentity, subjectDigest, browserCache, tools};
  return {root, archive, groupOutput, historicalRoot, transaction, oracleFolder, args, attempt, cell, observation, processRecord, reads, resolutions,
    replay: () => verifyFirstUseWindowServerEvidence(args), path: retainedPath,
    record: proof => ({...attempt.result.firstUse, id: attempt.id, producerId: attempt.result.firstUse.id, cache: attempt.cache, ordinal: attempt.ordinal, nativePresentationProof: proof})};
}

test('both fixed panels replay relocated raw evidence into a detached in-process bound', async t => {
  for (const feature of ['Mask', 'Adapter library']) {
    const f = await fixture(t, {feature}), proof = await f.replay(), record = f.record(proof);
    assert.ok(proof); assert.equal(proof.qualification, false);
    const bounds = readVerifiedFirstUseBounds(proof, record);
    assert.deepEqual(bounds, {acknowledgement: {upperBoundMs: 50, ceilingMs: 100, targetMs: 50, endpoint: 'WindowServer-presented-pixels', withinWindow: true, windowUpperBoundMs: 52},
      readiness: {upperBoundMs: 250, ceilingMs: 750, targetMs: 250, endpoint: 'public-control-ready-following-native-ACK', withinWindow: true, windowUpperBoundMs: 252}, exactLatency: false});
    assert.deepEqual(readVerifiedFirstUseBounds(proof, f.attempt.result.firstUse), bounds);
    bounds.acknowledgement.upperBoundMs = 0; bounds.readiness.withinWindow = false;
    assert.equal(readVerifiedFirstUseBounds(proof, record).acknowledgement.upperBoundMs, 50);
    assert.equal(readVerifiedFirstUseBounds(proof, record).readiness.withinWindow, true);
    assert.ok(f.reads.length > 10); assert.deepEqual(f.resolutions, [f.transaction + '/build-evidence/manifest.json']);
    assert.ok(f.reads.every(path => !isAbsolute(path))); assert.ok(!f.archive.startsWith(f.groupOutput + '/'));
    assert.equal(f.attempt.result.firstUse.nativePresentation.binding.oracle.pixels, '[omitted: private payload]');
    assert.equal(f.attempt.result.firstUse.presentedMs, null);
    assert.equal(f.attempt.result.firstUse.nativePresentation.join.firstMeaningfulPaintExactMs, null);
    assert.equal(f.attempt.result.firstUse.nativePresentation.join.firstMeaningfulPaintLowerBoundMs, null);
    await assert.rejects(readFile(join(f.historicalRoot, 'compiler')), {code: 'ENOENT'});
    for (const token of [{...proof}, structuredClone(proof), JSON.parse(JSON.stringify(proof)), {kind: proof.kind, qualification: true}]) {
      assert.equal(readVerifiedFirstUseBounds(token, record), null);
    }
    for (const alter of [
      value => {value.feature = feature === 'Mask' ? 'Adapter library' : 'Mask';}, value => {value.inputMs++;},
      value => {value.readyMs++;}, value => {value.reset = false;}, value => {value.presentedMs = 1;},
      value => {value.nativePresentation.join.firstMeaningfulPaintUpperBoundMs = 1;},
      value => {value.id = 'another-attempt';}, value => {value.producerId = 'another-producer';},
    ]) {const changed = structuredClone(record); changed.nativePresentationProof = proof; alter(changed); assert.equal(readVerifiedFirstUseBounds(proof, changed), null);}
  }
});

test('ten native windows satisfy only bound ceilings while exact metrics remain null', async t => {
  const records = [];
  for (let ordinal = 1; ordinal <= 10; ordinal++) {
    const f = await fixture(t, {ordinal, acknowledgementMs: ordinal === 10 ? 100 : 50, readinessMs: ordinal === 10 ? 750 : 250});
    records.push(f.record(await f.replay()));
  }
  const observed = evaluateFirstUse(records);
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.qualification, false); assert.deepEqual(observed.failures, []); assert.deepEqual(observed.missing, []);
  assert.deepEqual(observed.acknowledgements, {n: 0, p95: null, max: null}); assert.deepEqual(observed.readiness, {n: 0, p95: null, max: null});
  assert.equal(observed.upperBounds.acknowledgements.n, 10); assert.equal(observed.upperBounds.acknowledgements.max, 100);
  assert.equal(observed.upperBounds.readiness.n, 10); assert.equal(observed.upperBounds.readiness.max, 750);
  assert.equal(observed.upperBounds.acknowledgements.exactLatency, false); assert.equal(observed.upperBounds.readiness.exactLatency, false);
  assert.ok(records.every(value => value.presentedMs === null && value.inputClock === 'browser-performance' && value.readyClock === 'runner-monotonic'));
});

test('a late R04 or R06 upper bound remains inconclusive and never proves a miss', async t => {
  for (const late of [{acknowledgementMs: 100.001}, {readinessMs: 750.001}]) {
    const records = [];
    for (let ordinal = 1; ordinal <= 10; ordinal++) {
      const f = await fixture(t, {ordinal, ...(ordinal === 10 ? late : {})}); const proof = await f.replay(); assert.ok(proof); records.push(f.record(proof));
    }
    const observed = evaluateFirstUse(records);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []); assert.ok(observed.missing.length > 0);
    assert.equal(observed.acknowledgements.n, 0); assert.equal(observed.readiness.n, 0);
    assert.equal(observed.upperBounds.acknowledgements.n, 10); assert.equal(observed.upperBounds.readiness.n, 10);
  }
});

test('a late native window upper bound does not claim the reset window was missed', async t => {
  const records = [];
  for (let ordinal = 1; ordinal <= 10; ordinal++) {
    const f = await fixture(t, {ordinal, ...(ordinal === 10 ? {readinessMs: 999} : {})});
    const proof = await f.replay(); assert.ok(proof); const record = f.record(proof); records.push(record);
    if (ordinal === 10) {
      const bounds = readVerifiedFirstUseBounds(proof, record);
      assert.equal(bounds.readiness.windowUpperBoundMs, 1001); assert.equal(bounds.readiness.withinWindow, false);
    }
  }
  const observed = evaluateFirstUse(records); assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
});

test('runner handoff binds each canonical cold attempt to its own producer proof', async t => {
  const attempts = [], proofs = new Map(); let cell;
  for (let ordinal = 1; ordinal <= 10; ordinal++) {
    const f = await fixture(t, {ordinal}); cell = f.cell; attempts.push(f.attempt); proofs.set(f.attempt.id, await f.replay());
  }
  const evaluate = selected => evaluateInteractionCohort({campaign: 'P'}, cell, attempts, new Map(), selected)[0];
  const observed = evaluate(proofs); assert.equal(observed.outcome, 'PASS'); assert.equal(observed.upperBounds.acknowledgements.n, 10);
  const withheld = new Map(proofs); withheld.delete(attempts[0].id);
  const missing = evaluate(withheld); assert.equal(missing.outcome, 'INCONCLUSIVE'); assert.equal(missing.upperBounds.acknowledgements.n, 9);
  const swapped = new Map(proofs); swapped.set(attempts[0].id, proofs.get(attempts[1].id));
  assert.equal(evaluate(swapped).outcome, 'INCONCLUSIVE');
});

test('summary R04 consumes bounds without inventing exact duration or hiding an exact breach', async t => {
  const attempts = [], proofs = new Map(); let sourceCell;
  for (let ordinal = 1; ordinal <= 10; ordinal++) {
    const f = await fixture(t, {ordinal}); sourceCell = f.cell; attempts.push(f.attempt); proofs.set(f.attempt.id, await f.replay());
  }
  const cell = {...sourceCell, host: 'H', cold: 10, warm: 0, primes: 0, requirements: {},
    phaseBudgets: [{id: 'R04', phase: 'ui.feedback', targetMs: 50, ceilingMs: 100}]};
  const plan = {campaign: 'P', features: 'adapters', jobs: [{id: 'H2', cells: [cell]}]}, scheduled = executionGroups(plan);
  const groups = scheduled.map(group => ({...group, attempts: attempts.filter(attempt => group.attempts.some(planned => planned.ordinal === attempt.ordinal)), status: 'PASS'}));
  const phase = (selectedGroups, nativeFirstUses) => {
    const result = summarize(plan, selectedGroups, {nativeFirstUses}); assert.equal(result.qualification, false);
    return result.cells[0].phaseBudgets.find(value => value.id === 'R04');
  };
  const observed = phase(groups, proofs);
  assert.equal(observed.status, 'PASS'); assert.equal(observed.maximumMs, null); assert.equal(observed.maximumUpperBoundMs, 50);
  assert.ok(observed.samples.every(value => value.durationMs === null && value.bound === 'upper'));
  const withheld = new Map(proofs); withheld.delete(attempts[0].id);
  const unavailable = phase(groups, withheld); assert.equal(unavailable.status, 'INCONCLUSIVE'); assert.ok(unavailable.missing.includes(attempts[0].id));
  const late = await fixture(t, {ordinal: 10, acknowledgementMs: 101}), lateProofs = new Map(proofs); lateProofs.set(late.attempt.id, await late.replay());
  const lateGroups = groups.map(group => ({...group, attempts: group.attempts.map(attempt => attempt.id === late.attempt.id ? late.attempt : attempt)}));
  const latePhase = phase(lateGroups, lateProofs); assert.equal(latePhase.status, 'INCONCLUSIVE'); assert.equal(latePhase.maximumUpperBoundMs, 101);
  const exactBreach = groups.map(group => ({...group, attempts: group.attempts.map(attempt => attempt.id === attempts[0].id ? {
    ...attempt, result: {...attempt.result, phases: [...attempt.result.phases, {name: 'ui.feedback', durationMs: 101}]}} : attempt)}));
  assert.equal(phase(exactBreach, proofs).status, 'FAIL');
});

test('raw retained pixels, collector build, config, browser and trace pins cannot change', async t => {
  for (const name of ['capture/frame-2.bgra', 'build-evidence/windowserver-capture', 'config.json', 'stdout.ndjson']) {
    const f = await fixture(t); await writeFile(f.path(f.transaction + '/' + name), Buffer.from('tampered retained member\n')); await assert.rejects(f.replay());
  }
  for (const name of ['browser-trace-1.json', 'browser-runtime.json', 'browser-cell-1.json']) {
    const f = await fixture(t); await writeFile(f.path(name), Buffer.from('tampered retained member\n')); await assert.rejects(f.replay());
  }
  const oracle = await fixture(t); await writeFile(oracle.path(oracle.oracleFolder + '/after.bgra'), beforePixels); await assert.rejects(oracle.replay());
});

test('window ownership, sample geometry and exact native input ACKs are independently replayed', async t => {
  for (const mutateCapture of [
    value => {value.admission.intersectingAboveWindowCount = 1;},
    value => {value.rows.find(row => row.ordinal === 2).ownerPID++;}, value => {value.rows.find(row => row.ordinal === 2).windowNumber++;},
    value => {value.rows.find(row => row.ordinal === 2).intersectingAboveWindowCount = 1;},
    value => {value.after.mach = '9000000';}, value => {value.rows.find(row => row.ordinal === 2).windowObservationMach = '1';},
    value => {value.geometry.pointPixelScale = 2;},
  ]) {const f = await fixture(t, {mutateCapture}); await assert.rejects(f.replay());}
});

test('process closure and exact source, build, executable and worker ownership are mandatory', async t => {
  for (const mutateProcess of [
    value => {value.close.code = 1;}, value => {value.exit.signal = 'SIGTERM';}, value => {value.cleanupErrors.push({message: 'not closed'});},
    value => {value.requestedSignals.push('SIGKILL');},
  ]) {const f = await fixture(t, {mutateProcess}); assert.equal(await f.replay(), null);}
  for (const mutateProcess of [value => {value.processIdentity.ownerPid++;},
    value => {value.command[1] = '/outside/config.json';}, value => {value.executable.sha256 = '0'.repeat(64);},
    value => {value.build.sourceSha256 = '0'.repeat(64);},
  ]) {const f = await fixture(t, {mutateProcess}); await assert.rejects(f.replay());}
  for (const mutate of [
    f => {f.args.controlFiles[0].sha256 = '0'.repeat(64);}, f => {f.args.workerPid++;}, f => {f.args.sourceRoot = '/another/source';},
    f => {f.args.engine = 'firefox';}, f => {f.args.fixture.seal.sha256 = '0'.repeat(64);}, f => {f.args.subjectDigest = 'sha256:' + '0'.repeat(64);},
    f => {f.args.browserCache = '/another/cache';}, f => {f.args.developerState.state.h.completed = false;},
    f => {f.args.sourceFiles = [];}, f => {f.args.tools.browserPins.browsers[0].revision = 'another-revision';},
  ]) {const f = await fixture(t); mutate(f); await assert.rejects(f.replay());}
});

test('retained producer sanitation and worker normalization bind every public alias', async t => {
  for (const mutate of [
    f => {f.attempt.result.firstUse.readyMs++;}, f => {f.attempt.result.observations.startMs++;},
    f => {f.attempt.result.firstUse.resetEvidence.browserPid++;}, f => {f.attempt.result.firstUse.feature = 'Adapter library';},
    f => {f.attempt.result.firstUse.discreteInput.steps[0].inputEvidence.events[0].isTrusted = false;},
  ]) {const f = await fixture(t); mutate(f); await assert.rejects(f.replay());}
});

test('a resealed producer cannot exchange feature, cold reset, owned PID or browser input identities', async t => {
  for (const mutateProducer of [
    value => {value.firstUse.reset = false;}, value => {value.firstUse.resetEvidence.freshBrowserContext = false;},
    value => {value.firstUse.resetEvidence.fixtureCopiedBeforeLaunch = false;}, value => {value.firstUse.resetEvidence.backendPid++;},
    value => {value.firstUse.presentedMs = 1;}, value => {value.observations.presentedMs = 1;},
    value => {value.firstUse.inputTimeOrigin++;}, value => {value.firstUse.inputClock = 'runner-monotonic';},
    value => {value.firstUse.discreteInput.steps[0].dispatchCompleted = false;},
    value => {value.firstUse.discreteInput.failures.push('retained-product-failure');},
    value => {value.firstUse.discreteInput.missing.push('retained-input-gap');},
    value => {value.firstUse.discreteInput.automation = {...value.firstUse.discreteInput.automation, physicalInput: true};},
    value => {value.firstUse.discreteInput.qualification = true;},
    value => {value.firstUse.discreteInput.steps[0].missing.push('native-input-hook-failed');},
    value => {value.firstUse.discreteInput.steps[0].nativeBracketVerified = true;},
  ]) {const f = await fixture(t, {mutateProducer}); await assert.rejects(f.replay());}
  const failedPublic = await fixture(t, {mutateProducer: value => {value.firstUse.meaningful = value.observations.meaningful = false;}});
  assert.equal(await failedPublic.replay(), null);
  for (const mutate of [f => {f.attempt.cache = 'warm';}, f => {f.attempt.prime = true;}, f => {f.args.cell.parameters.feature = 'adapter';}]) {
    const f = await fixture(t); mutate(f); await assert.rejects(f.replay());
  }
});

test('oracle must describe the selected complete panel and independently pinned environment', async t => {
  for (const mutateOracle of [
    value => {value.subject = 'marker-square';}, value => {value.feature = 'Other';}, value => {value.after.state = 'pending';},
    value => {value.binding.fixtureSha256 = '0'.repeat(64);}, value => {value.binding.browserEnvironmentSha256 = '0'.repeat(64);},
    value => {value.display = {...value.display, id: 8};}, value => {value.roi = {...value.roi, x: 5};},
  ]) {const f = await fixture(t, {mutateOracle}); await assert.rejects(f.replay());}
});

test('incomplete or unsupported raw diagnostic trace remains unavailable without invented marks', async t => {
  for (const mutateTrace of [
    value => {value.collection.completeEventReceived = false;}, value => {value.collection.status = 'incomplete';},
    value => {value.collection.reasons = ['browser-data-loss'];}, value => {value.kind = 'unsupported-trace';},
  ]) {const f = await fixture(t, {mutateTrace}); assert.equal(await f.replay(), null);}
});

test('native ready and reset-window anchors require retained matching ACKs and causal public witnesses', async t => {
  for (const mutateNative of [
    value => {value.readinessWitness.ack.mach = '999999999';}, value => {value.readinessWitness.requestRunnerMs = 199;},
    value => {value.readinessWitness.receivedRunnerMs = 200;}, value => {value.readinessWitness.callerReadyMs++;},
    value => {value.readinessWitness.descriptor = {...value.descriptor, sessionId: 'other'};},
    value => {value.windowStartAnchor.ack = {...value.windowStartAnchor.ack, id: 'other'};},
    value => {value.windowStartAnchor.relation = 'window-start-exact';}, value => {value.publicWitness.captureStoppedMs = 1099;},
  ]) {const f = await fixture(t, {mutateNative}); await assert.rejects(f.replay());}
});

test('raw membership and every selected owned process remain mandatory after relocation', async t => {
  for (const select of [
    f => f.transaction + '/capture/frame-2.bgra', f => f.transaction + '/build-evidence/sdk-manifest.json',
    f => f.oracleFolder + '/after.bgra', () => 'owned-process-23-' + uuid + '.json',
    () => 'owned-process-24-' + uuid + '.json', () => 'browser-cell-1.json', () => 'browser-runtime.json',
  ]) {const f = await fixture(t), path = select(f); f.args.retainedPaths.splice(f.args.retainedPaths.indexOf(path), 1); assert.equal(await f.replay(), null);}
  const extra = await fixture(t), path = extra.transaction + '/capture/frame-3.bgra';
  extra.args.retainedPaths.push(path); await writeFile(extra.path(path), afterPixels); await assert.rejects(extra.replay(), /membership/);
  const escaped = await fixture(t, {mutateProducer: value => {value.firstUse.nativePresentation.evidence.process.receipt.path = '/outside/process.json';}});
  await assert.rejects(escaped.replay());
});

test('independent preparation and browser pin gaps cannot be replaced by producer labels', async t => {
  for (const mutate of [
    f => {f.args.developerState = null;}, f => {f.args.developerStateIdentity = null;},
    f => {f.args.tools.browserPins.browsers = [];}, f => {f.args.configuration.browser.windowServerFirstUse = undefined;},
  ]) {const f = await fixture(t); mutate(f); assert.equal(await f.replay(), null);}
  for (const mutateBrowser of [
    ({runtime}) => {runtime.headless = true;}, ({runtime}) => {runtime.playwrightModule = '/foreign/node_modules/playwright/index.js';},
    ({runtime}) => {runtime.executableIdentity.sha256 = 'sha256:' + '0'.repeat(64);},
    ({runtime}) => {runtime.version = 'another-version';}, ({runtime}) => {runtime.revision = 'another-revision';},
  ]) {const f = await fixture(t, {mutateBrowser}); await assert.rejects(f.replay());}
});

test('first-use evidence inventory admits only the fixed bounded native family', () => {
  const action = 'fu-' + 'a'.repeat(48);
  for (const path of [`worker/native-${action}/stdout.ndjson`, `worker/native-${action}/capture/frames.ndjson`,
    `worker/native-${action}/capture/frame-2.bgra`, `worker/native-${action}/build-evidence/collector.swift`,
    `worker/native-${action}/build-evidence/windowserver-capture`, `worker/oracle-${action}/before.bgra`]) assert.equal(isFirstUseNativeEvidencePath(path), true, path);
  for (const path of ['worker/native-fu-short/capture/frame-1.bgra', `worker/native-${action}/capture/extra.bin`,
    `worker/oracle-${action}/extra.bgra`, 'worker/unrelated/image.bgra', 'worker/fixture/windowserver-capture']) assert.equal(isFirstUseNativeEvidencePath(path), false, path);
});

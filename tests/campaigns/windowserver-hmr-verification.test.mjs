import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {verifyHmrWindowServerEvidence, readVerifiedHmrCeiling, isCampaignEvidencePath} from '../../tooling/qualification/campaigns/windowserver-hmr-verification.mjs';
import {evaluateHotEdit} from '../../tooling/qualification/campaigns/metrics.mjs';
import {normalizeResult} from '../../tooling/qualification/campaigns/worker.mjs';
import {sanitize} from '../../tooling/qualification/campaigns/common.mjs';
import {evaluateInteractionCohort, executionGroups, summarize} from '../../tooling/qualification/campaigns/run.mjs';

// Synthetic protocol fixtures only. No compiler, browser, native process or
// display capture is started. The tiny pixel arrays are not semantic oracles;
// the Mach-O header below is not executable native collector evidence. A
// passing replay here tests admission arithmetic, never real qualification.
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

async function fixture(t, {upperBoundMs = 290, attemptId = 'D05-attempt-1', cache = 'warm', ordinal = 1, prime = false,
  mutateCapture, mutateProcess, mutateOracle, mutateTrace, mutateBrowser, mutateProducer} = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hmr-retained-protocol-')); await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  // All historical paths deliberately remain absent. Only this relocated tree
  // is readable; neither compiler nor original SDK/source path is reopened.
  const groupOutput = join(root, 'absent-original-group'), historicalRoot = join(root, 'absent-build-inputs');
  const archive = join(root, 'relocated-evidence'); await mkdir(archive, {mode: 0o700});
  const members = new Map(), modes = new Map();
  const put = (path, bytes, mode = 0o600) => {members.set(path, bytes); modes.set(path, mode); return pin(path, bytes);};
  const collectorBytes = Buffer.from('// synthetic retained collector protocol fixture; never compiled\n');
  const build = syntheticBuild(collectorBytes, historicalRoot);
  for (const [name, bytes, mode] of build.members) put('native-hmr-1/build-evidence/' + name, bytes, mode);
  const originalBytes = Buffer.from("export const SHELL_WORDMARK = 'Editor';\n"), changedBytes = Buffer.from("export const SHELL_WORDMARK = 'Editor updated';\n");
  const source = {sourcePath: 'src/ui/shell-wordmark.ts', original: {...file(originalBytes, 0o644), sha256: 'sha256:' + sha(originalBytes)},
    changed: {bytes: changedBytes.length, sha256: 'sha256:' + sha(changedBytes)}};
  const originalPath = 'hmr-original-' + uuid + '.ts'; put(originalPath, originalBytes);
  const roi = {x: 4, y: 3, width: 2, height: 1}, display = {id: 7, width: 100, height: 60};
  const config = {schemaVersion: 1, displayID: 7, expectedBrowserPid: 23, roi, durationMs: 1000, maxFrames: 60, maxBytes: 4096};
  const geometry = {displayBoundsPoints: {x: 0, y: 0, width: 100, height: 60}, displayPoints: {x: 0, y: 0, width: 100, height: 60},
    modePixels: {width: 100, height: 60}, filterPoints: {x: 0, y: 0, width: 100, height: 60}, pointPixelScale: 1, backingScale: {x: 1, y: 1},
    scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'};
  const admission = {ownerPID: 23, windowNumber: 9, bounds: {x: 0, y: 0, width: 100, height: 60}, layer: 0, alpha: 1, onScreen: true,
    roiPoints: {...roi}, aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0};
  const sample = (ordinal, displayTime, pixels) => ({schemaVersion: 1, event: 'sample', ordinal, statusRaw: 0, status: 'complete', ownerPID: 23, windowNumber: 9,
    callbackMach: String(displayTime + 1000000), windowObservationMach: String(displayTime + 1000001), displayTimeMach: String(displayTime),
    aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0, pts: {value: '0', timescale: 1, flags: 0, epoch: '0'}, pixelFormat: 1111970369,
    width: 100, height: 60, roi, retained: true, file: `frame-${ordinal}.bgra`, sha256: sha(pixels), byteLength: pixels.length, contentScale: 1, scaleFactor: 1});
  const before = {schemaVersion: 1, event: 'clock', id: 'hmr-1-before', mach: '10000000'}, after = {schemaVersion: 1, event: 'clock', id: 'hmr-1-after', mach: '12000000'};
  const targetTime = 10000000 + upperBoundMs * 1000000, rows = [sample(1, 5000000, beforePixels), before, after, sample(2, targetTime, afterPixels)];
  mutateCapture?.({config, display, geometry, admission, rows, before, after});
  const bracket = {kind: 'native-action-bracket-1', actionId: 'hmr-1', status: 'complete', actionCompleted: true, before, after};
  const captureFolder = 'native-hmr-1/capture', timebase = {numer: 1, denom: 1};
  const framesBytes = ndjson(rows), manifest = {kind: 'windowserver-capture-1', schemaVersion: 1, config, display, captureGeometry: geometry, windowAdmission: admission,
    timebase, startedMach: '0', endedMach: '1000000000', terminalReason: 'requested-stop',
    counts: {sampleRecords: 2, completeFrames: 2, clockRecords: 2, pixelBytes: 16, unretainedSamples: 0},
    frames: pin('frames.ndjson', framesBytes), pixelFiles: [pin('frame-1.bgra', beforePixels), pin('frame-2.bgra', afterPixels)]};
  const manifestBytes = json(manifest);
  put(captureFolder + '/manifest.json', manifestBytes); put(captureFolder + '/frames.ndjson', framesBytes);
  put(captureFolder + '/frame-1.bgra', beforePixels); put(captureFolder + '/frame-2.bgra', afterPixels);
  const ready = {schemaVersion: 1, event: 'ready', kind: manifest.kind, config, outputDirectory: join(groupOutput, captureFolder), display, captureGeometry: geometry,
    windowAdmission: admission, roi, timebase, startedMach: '0', pixelByteLimit: config.maxBytes, metadataByteLimit: 8 * 1024 ** 2,
    manifestByteLimit: 2 * 1024 ** 2, maxClockRecords: 256, pointPixelScale: 1};
  const stopped = {schemaVersion: 1, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'};
  const stdout = ndjson([ready, ...rows, stopped]); put('native-hmr-1/stdout.ndjson', stdout); put('native-hmr-1/stderr.log', Buffer.alloc(0));
  const configBytes = json(config); put('native-hmr-1/config.json', configBytes);
  const oracle = {kind: 'hmr-wordmark-oracle-1', schemaVersion: 1, subject: '.wordmark-secondary', pixelFormat: 'BGRA8', display, roi,
    source: {originalSha256: sha(originalBytes), changedSha256: sha(changedBytes)},
    before: {text: 'Editor', bytes: beforePixels.length, sha256: sha(beforePixels)}, after: {text: 'Editor updated', bytes: afterPixels.length, sha256: sha(afterPixels)}};
  mutateOracle?.(oracle);
  const oracleBytes = json(oracle); put('native-wordmark-oracle/oracle.json', oracleBytes);
  put('native-wordmark-oracle/before.bgra', beforePixels); put('native-wordmark-oracle/after.bgra', afterPixels);
  const selectedFixture = {documentId: 'document-fixture', seal: 'sha256:' + 'f'.repeat(64)};
  const runtime = {headless: false, browserPid: 23, engine: 'chromium', version: 'fixture-version', revision: 'fixture-revision', executable: '/absent/browser',
    executableIdentity: {bytes: 1, sha256: 'e'.repeat(64)}, browserCache: {path: '/absent/browser-cache', sha256: 'sha256:' + 'd'.repeat(64)}, sourceRoot: '/absent/prepared/source', fixtureSeal: selectedFixture.seal,
    viewport: {width: 100, height: 60}, deviceScaleFactor: 1};
  const browserIdentity = {cache: {sha256: runtime.browserCache.sha256}, engines: [{engine: runtime.engine, executable: runtime.executable,
    version: runtime.version, revision: runtime.revision, ...runtime.executableIdentity}]};
  const subjectDigest = 'sha256:' + 'c'.repeat(64), state = {productRepo: runtime.sourceRoot, sourceDigest: subjectDigest,
    buildProvenancePath: '/absent/prepared/build-provenance.json', h: {source: runtime.sourceRoot, workspace: dirname(runtime.sourceRoot),
      completed: true, browserCache: runtime.browserCache.path, browserIdentity}};
  const developerState = {kind: 'developer-runtime-state-1', state, sha256: sha(json(state))};
  const developerStateIdentity = pin('/absent/prepared/bridge-state.json', json(developerState));
  source.developerState = {path: developerStateIdentity.path, sha256: 'sha256:' + developerStateIdentity.sha256};
  source.browserCache = structuredClone({path: state.h.browserCache, sha256: browserIdentity.cache.sha256, engines: browserIdentity.engines});
  mutateBrowser?.({runtime, source});
  put('hmr-runtime.json', json(runtime));
  const buildSelection = {receiptPath: build.receiptPath, receiptSha256: build.receiptSha256};
  const configuration = {browser: {engine: 'chromium'}, windowServerPresentation: {kind: 'windowserver-hmr-configuration-1', build: buildSelection,
    oracle: {path: join(historicalRoot, 'oracle.json'), sha256: sha(oracleBytes)}, displayID: config.displayID, roi,
    capture: {durationMs: config.durationMs, maxFrames: config.maxFrames, maxBytes: config.maxBytes}}};
  const binding = {kind: 'hmr-windowserver-input-binding-1', sourceIdentity: source, collectorSource: pin(join(historicalRoot, 'capture.swift'), collectorBytes), build: buildSelection,
    oracle: {...pin(join(groupOutput, 'native-wordmark-oracle/oracle.json'), oracleBytes), pixels: [pin('before.bgra', beforePixels), pin('after.bgra', afterPixels)]},
    browser: {pid: runtime.browserPid, ...Object.fromEntries(['engine', 'version', 'revision', 'executable', 'executableIdentity', 'browserCache', 'sourceRoot', 'fixtureSeal', 'viewport', 'deviceScaleFactor'].map(key => [key, runtime[key]]))},
    config, semanticOracleReview: 'external-exact-pinned-oracle-required', historicalWindowOcclusion: 'adjacent-native-window-observations-not-atomic-at-frame-time'};
  put('native-wordmark-oracle/binding.json', json(binding));
  const workerPid = 100, processIdentity = {kind: 'windowserver', ownerPid: workerPid, pid: 123, pgid: 123, startedAtIdentity: 'synthetic-birth', executable: build.binaryPath};
  put('owned-process-' + runtime.browserPid + '-' + uuid + '.json', json({kind: 'perf-owned-processes-1', ownerPid: workerPid,
    processes: [{kind: 'browser', pid: runtime.browserPid, pgid: runtime.browserPid, startedAtIdentity: 'synthetic-browser-birth', executable: runtime.executable}]}));
  const registrationPath = 'owned-process-123-' + uuid + '.json';
  const registrationBytes = json({kind: 'perf-owned-processes-1', ownerPid: workerPid, processes: [{kind: processIdentity.kind, pid: processIdentity.pid,
    pgid: processIdentity.pgid, startedAtIdentity: processIdentity.startedAtIdentity, executable: processIdentity.executable}]});
  put(registrationPath, registrationBytes);
  const processRecord = {kind: 'windowserver-owned-process-1', schemaVersion: 1, outcome: 'CAPTURE_REPLAYED', failure: null, cleanupErrors: [], requestedSignals: [],
    exit: {code: 0, signal: null}, close: {code: 0, signal: null}, processIdentity, registration: pin(join(groupOutput, registrationPath), registrationBytes),
    config: pin('config.json', configBytes), build: {...buildSelection, sourceSha256: sha(collectorBytes)},
    buildEvidence: {...pin('build-evidence/manifest.json', build.manifestBytes), sourceSha256: sha(collectorBytes), receiptSha256: build.receiptSha256, binarySha256: build.binarySha256},
    executable: {path: build.binaryPath, bytes: build.binaryBytes, sha256: build.binarySha256}, command: [build.binaryPath, join(groupOutput, 'native-hmr-1/config.json'), join(groupOutput, captureFolder)],
    outputDirectory: join(groupOutput, captureFolder), stdout: pin('stdout.ndjson', stdout), stderr: pin('stderr.log', Buffer.alloc(0)),
    streamBytesObserved: {stdout: stdout.length, stderr: 0}, manifest: pin('capture/manifest.json', manifestBytes)};
  mutateProcess?.(processRecord);
  const processBytes = json(processRecord); put('native-hmr-1/process.json', processBytes);
  const observation = {kind: 'hmr-windowserver-observation-1', actionId: 'hmr-1', qualification: false, binding, ready, processIdentity, bracket, baseline: rows[0], target: rows[3],
    join: {kind: 'hmr-windowserver-pixel-join-1', source: 'ScreenCaptureKit-full-display', endpoint: 'WindowServer-presented-pixels', qualification: false,
      oracleSha256: sha(oracleBytes), captureSha256: sha(manifestBytes), semanticReviewRequired: true, collectorSourceAndInvocationAdmissionRequired: true,
      physicalScanout: 'unavailable', displaySlotCoverage: 'unavailable', firstCorrectPaintLowerBoundMs: null, firstCorrectPaintExactMs: null,
      status: 'observed', baselineOrdinal: 1, matchedOrdinal: 2, observedDisplayTimeMach: String(targetTime), saveBracket: {earliestMach: before.mach, latestMach: after.mach},
      firstCorrectPaintUpperBoundMs: upperBoundMs, ceilingAssessment: upperBoundMs <= 500 ? 'upper-bound-within-ceiling' : 'unavailable-earliest-frame-not-proven', ceilingMs: 500},
    evidence: {manifest: pin(join(groupOutput, captureFolder, 'manifest.json'), manifestBytes), process: {...processRecord, receipt: pin(join(groupOutput, 'native-hmr-1/process.json'), processBytes)}},
    failedProcess: null, missing: [], failures: []};
  const witness = {timeOrigin: 123000, navigationCount: 1, mainFrameNavigations: 1, documentId: selectedFixture.documentId, revision: 1,
    documentSha256: 'sha256:' + 'a'.repeat(64), visibleDocumentSha256: 'sha256:' + 'b'.repeat(64), uiSha256: 'sha256:' + 'c'.repeat(64),
    shellConnected: true, canvasConnected: true, wordmark: 'Editor'};
  const trace = {kind: 'sanitized-chromium-trace-1', clock: 'chromium-monotonic-microseconds', collection: {status: 'complete', completeEventReceived: true, reasons: []},
    events: [['intent', 1], ['clock-before', 2], ['clock-after', 3], ['complete', 4]].map(([kind, ts]) => ({cat: 'blink.user_timing', name: 'ie.perf.v1:' + kind + ':1', ph: 'I', pid: 50, tid: 51, ts}))};
  mutateTrace?.(trace);
  const traceBytes = json(trace); put('hmr-trace-1.json', traceBytes);
  const tracePin = {kind: 'browser-metadata-trace', ...pin(join(groupOutput, 'hmr-trace-1.json'), traceBytes), attributionComplete: false};
  const hotEdit = {id: 'hmr-1', savedMs: 100, presentedMs: null, documentPreserved: true, reload: false, trace: tracePin, windowServerPresentation: observation, outcome: 'expected'};
  const publicObservation = {kind: 'actual-vite-hmr-1', id: 'hmr-1', cache, ordinal, prime, firstUpdate: false, scored: !prime,
    presentedMs: null, before: {...witness}, after: {...witness, wordmark: 'Editor updated'}, restoredAfter: {...witness},
    saved: {savedMs: 100, startMs: 99, clock: 'runner-monotonic', nativePresentationBracket: bracket, presentationBracket: {kind: 'browser-trace-action-bracket-1', id: 1,
      status: 'complete', actionCompleted: true, sameDocument: true, browserTimeOrigin: witness.timeOrigin, beforeBrowserMs: 1, afterBrowserMs: 2}},
    restoration: {path: source.sourcePath, bytes: originalBytes.length, sha256: 'sha256:' + sha(originalBytes), mode: source.original.mode, restored: true},
    trace: tracePin, windowServerPresentation: observation};
  // The producer seals its complete observation before the worker adds its
  // clock fields and the controller attaches the producer receipt identity.
  const producer = {status: upperBoundMs <= 500 ? 'PASS' : 'INCONCLUSIVE', hotEdit, observations: publicObservation, evidence: {runtime, source}, qualification: false,
    phases: [{name: 'developer.hot-update-transaction', startMs: 95, endMs: 800, durationMs: 705, clock: 'runner-monotonic'}]};
  mutateProducer?.(producer);
  const serializedProducer = sanitize(producer), producerPin = put('hmr-update-1.json', json(serializedProducer));
  const startMs = 90, endMs = 900;
  const attempt = {id: attemptId, cache, ordinal, prime, startMs, endMs, result: normalizeResult({...serializedProducer,
    evidence: {...serializedProducer.evidence, receipt: {...producerPin, path: join(groupOutput, producerPin.path)}}}, startMs, endMs)};
  for (const [path, bytes] of members) {
    const destination = join(archive, path); await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeFile(destination, bytes, {flag: 'wx', mode: modes.get(path)}); await chmod(destination, modes.get(path));
  }
  const reads = [], resolutions = [], retainedPaths = [...members.keys()];
  function retainedPath(path) {assert.equal(isAbsolute(path), false); const actual = resolve(archive, path); assert.ok(actual.startsWith(archive + '/')); return actual;}
  const args = {attempt, configuration, groupOutput, retainedPaths, readRetained: async (path, {maximum}) => {
      const actual = retainedPath(path); assert.ok(Number.isSafeInteger(maximum) && maximum > 0); assert.ok((await stat(actual)).size <= maximum);
      reads.push(path); return readFile(actual);
    },
    resolveRetained: async path => {resolutions.push(path); return retainedPath(path);},
    controlFiles: [pin('tooling/qualification/native/windowserver-capture.swift', collectorBytes)], sourceFiles: [pin(source.sourcePath, originalBytes)],
    fixture: selectedFixture, workerPid, sourceRoot: runtime.sourceRoot, engine: runtime.engine, developerState, developerStateIdentity, subjectDigest};
  return {root, archive, groupOutput, historicalRoot, originalPath, args, attempt, observation, processRecord, reads, resolutions,
    replay: () => verifyHmrWindowServerEvidence(args), path: retainedPath,
    record: proof => ({...attempt.result.hotEdit, id: attempt.id, producerId: attempt.result.hotEdit.id, cache: attempt.cache, ordinal: attempt.ordinal, nativePresentationProof: proof})};
}

test('full retained synthetic replay mints only an in-process proof and uses relocated files', async t => {
  const f = await fixture(t), proof = await f.replay(), record = f.record(proof);
  assert.ok(proof); assert.equal(proof.qualification, false);
  assert.equal(record.windowServerPresentation.binding.oracle.pixels, '[omitted: private payload]');
  assert.deepEqual(readVerifiedHmrCeiling(proof, record), {upperBoundMs: 290, ceilingMs: 500, endpoint: 'WindowServer-presented-pixels'});
  assert.deepEqual(readVerifiedHmrCeiling(proof, f.attempt.result.hotEdit), readVerifiedHmrCeiling(proof, record));
  assert.ok(f.reads.length > 10); assert.deepEqual(f.resolutions, ['native-hmr-1/build-evidence/manifest.json']);
  assert.ok(f.reads.every(path => !isAbsolute(path))); assert.ok(!f.archive.startsWith(f.groupOutput + '/'));
  await assert.rejects(readFile(join(f.historicalRoot, 'compiler')), {code: 'ENOENT'});
  await assert.rejects(readFile(join(f.groupOutput, 'hmr-runtime.json')), {code: 'ENOENT'});
  for (const copied of [{...proof}, structuredClone(proof), JSON.parse(JSON.stringify(proof)), {kind: proof.kind, qualification: true, upperBoundMs: 1}]) {
    assert.equal(readVerifiedHmrCeiling(copied, record), null);
  }
  for (const patch of [{id: 'another-attempt'}, {producerId: 'hmr-2'}, {savedMs: 101}, {presentedMs: 101}, {reload: true}, {outcome: 'unexpected'}]) {
    assert.equal(readVerifiedHmrCeiling(proof, {...record, ...patch}), null);
  }
  const altered = structuredClone(record); altered.windowServerPresentation.join.firstCorrectPaintUpperBoundMs = 1;
  assert.equal(readVerifiedHmrCeiling(proof, altered), null);
});

test('verified upper bounds through 500 satisfy only the D05 ceiling and remain separate statistics', async t => {
  const records = [];
  for (const [index, upperBoundMs] of [200, 290, 500].entries()) {
    const f = await fixture(t, {upperBoundMs, attemptId: 'D05-attempt-' + (index + 1), ordinal: index + 1}), proof = await f.replay();
    records.push(f.record(proof));
  }
  const observed = evaluateHotEdit(records);
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.qualification, false); assert.deepEqual(observed.failures, []); assert.deepEqual(observed.missing, []);
  assert.deepEqual(observed.elapsed, {n: 0, p95: null, max: null, pooledDiagnostic: true}); assert.equal(observed.caches.warm.n, 0);
  assert.equal(observed.upperBounds.n, 3); assert.equal(observed.upperBounds.max, 500); assert.equal(observed.upperBounds.caches.warm.n, 3);
  assert.equal(observed.upperBounds.exactLatency, false); assert.equal(observed.targetMissed, null);
  assert.ok(records.every(record => record.presentedMs === null));
});

test('a verified late upper bound is unavailable for earliest lateness and never becomes a target miss', async t => {
  const records = [];
  for (const [index, upperBoundMs] of [290, 500, 501].entries()) {
    const f = await fixture(t, {upperBoundMs, attemptId: 'D05-attempt-' + (index + 1), ordinal: index + 1}), proof = await f.replay();
    assert.ok(proof); records.push(f.record(proof));
  }
  const observed = evaluateHotEdit(records);
  assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
  assert.ok(observed.missing.includes('hot-update-earliest-presentation-unavailable'));
  assert.equal(observed.upperBounds.max, 501); assert.equal(observed.elapsed.n, 0); assert.equal(observed.targetMissed, null);
});

test('runner cohort handoff binds canonical attempts to producer proofs and retains Q3 cache ordinals', async t => {
  const cell = {id: 'D05-chromium', operation: 'developer.hot-update', parameters: {browser: 'chromium'}}, attempts = [], proofs = new Map();
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    const id = `${cell.id}/warm/scored/${ordinal}`, f = await fixture(t, {attemptId: id, cache: 'warm', ordinal, prime: false}), proof = await f.replay();
    attempts.push({...f.attempt, status: 'PASS'}); proofs.set(id, proof);
  }
  const [passing] = evaluateInteractionCohort({campaign: 'P'}, cell, attempts, proofs);
  assert.equal(passing.outcome, 'PASS'); assert.equal(passing.upperBounds.n, 3); assert.equal(passing.elapsed.n, 0);
  assert.ok(attempts.every(attempt => attempt.result.hotEdit.id === 'hmr-1'), 'Original producer IDs remain intact across distinct worker attempts');
  const withheld = new Map(proofs); withheld.delete(attempts[0].id);
  const [missing] = evaluateInteractionCohort({campaign: 'P'}, cell, attempts, withheld);
  assert.equal(missing.outcome, 'INCONCLUSIVE'); assert.equal(missing.upperBounds.n, 2); assert.ok(missing.missing.includes('hot-update-presented-completion'));
  const swapped = new Map(proofs); swapped.set(attempts[0].id, proofs.get(attempts[1].id));
  assert.equal(evaluateInteractionCohort({campaign: 'P'}, cell, attempts, swapped)[0].outcome, 'INCONCLUSIVE');

  // Reuse the three native fixtures; the remaining Q3 samples exercise the
  // unchanged exact branch, with cache/ordinal supplied by the runner attempt.
  const exact = (cache, ordinal) => ({id: `${cell.id}/${cache}/scored/${ordinal}`, cache, ordinal, prime: false, status: 'PASS', result: {hotEdit: {
    id: `legacy-${cache}-${ordinal}`, cache: 'producer-label-is-not-the-runner-cohort', ordinal: 999, savedMs: 0, presentedMs: 100,
    documentPreserved: true, reload: false, outcome: 'expected', trace: {kind: 'browser-presentation-trace', sha256: 'a'.repeat(64), attributionComplete: true}}}});
  const q3 = [...Array.from({length: 10}, (_, index) => exact('cold', index + 1)), ...attempts, ...Array.from({length: 7}, (_, index) => exact('warm', index + 4))];
  const [cohort] = evaluateInteractionCohort({campaign: 'Q3'}, cell, q3, proofs);
  assert.equal(cohort.outcome, 'PASS'); assert.equal(cohort.edits, 20); assert.equal(cohort.caches.cold.n, 10); assert.equal(cohort.caches.warm.n, 7);
  assert.equal(cohort.upperBounds.caches.cold.n, 0); assert.equal(cohort.upperBounds.caches.warm.n, 3);
  const duplicate = q3.map(attempt => ({...attempt})); duplicate.at(-1).ordinal = 9;
  assert.ok(evaluateInteractionCohort({campaign: 'Q3'}, cell, duplicate, proofs)[0].missing.includes('ten-cold-and-ten-warm-hot-edits'));
});

test('summary D05 phase budget consumes upper bounds without inventing exact durations or late failures', async t => {
  const cell = {id: 'H3/D05-native', operation: 'developer.hot-update', workload: 'W1', handler: 'browser', host: 'H', kind: 'operation',
    cold: 0, warm: 3, primes: 0, parameters: {browser: 'chromium'}, requirements: {},
    phaseBudgets: [{id: 'D05', phase: 'developer.hot-update-visible', targetMs: 200, ceilingMs: 500}]};
  const plan = {campaign: 'P', features: 'adapters', jobs: [{id: 'H3', cells: [cell]}]}, scheduled = executionGroups(plan)[0];
  const attempts = [], proofs = new Map();
  for (const [index, upperBoundMs] of [200, 290, 500].entries()) {
    const ordinal = index + 1, id = `${cell.id}/warm/scored/${ordinal}`, f = await fixture(t, {attemptId: id, upperBoundMs, cache: 'warm', ordinal, prime: false});
    proofs.set(id, await f.replay()); attempts.push({...f.attempt, status: 'PASS'});
  }
  const group = {...scheduled, attempts, status: 'PASS'};
  const phase = (groups, nativeHotEdits) => {
    const summary = summarize(plan, groups, {nativeHotEdits});
    // This is only the D05 phase seam. Host/job/complete-campaign admission
    // remains independent and this fixture never asserts overall qualification.
    assert.equal(summary.qualification, false);
    return summary.cells[0].phaseBudgets.find(budget => budget.id === 'D05');
  };
  const admitted = phase([group], proofs);
  assert.equal(admitted.status, 'PASS'); assert.equal(admitted.maximumMs, null); assert.equal(admitted.maximumUpperBoundMs, 500);
  assert.ok(admitted.samples.every(sample => sample.durationMs === null && sample.bound === 'upper'));
  const withheld = new Map(proofs); withheld.delete(attempts[0].id);
  const missing = phase([group], withheld);
  assert.equal(missing.status, 'INCONCLUSIVE'); assert.equal(missing.maximumMs, null); assert.ok(missing.missing.includes(attempts[0].id));
  const lateFixture = await fixture(t, {attemptId: attempts[2].id, upperBoundMs: 501, ordinal: 3}), lateProofs = new Map(proofs);
  lateProofs.set(lateFixture.attempt.id, await lateFixture.replay());
  const lateAttempts = [...attempts.slice(0, 2), {...lateFixture.attempt, status: 'INCONCLUSIVE'}];
  const late = phase([{...group, status: 'INCONCLUSIVE', attempts: lateAttempts}], lateProofs);
  assert.equal(late.status, 'INCONCLUSIVE'); assert.equal(late.maximumMs, null); assert.equal(late.maximumUpperBoundMs, 501);
  assert.equal(late.samples[2].missing, true); assert.equal(late.samples[2].durationMs, null);
});

test('retained raw pixels, source, binary, config and trace bytes cannot change behind their seals', async t => {
  for (const path of ['native-hmr-1/capture/frame-2.bgra', 'hmr-original-' + uuid + '.ts', 'native-hmr-1/build-evidence/windowserver-capture',
    'native-hmr-1/config.json', 'hmr-trace-1.json', 'native-wordmark-oracle/after.bgra']) {
    const f = await fixture(t); await writeFile(f.path(path), Buffer.from('tampered retained member\n'));
    await assert.rejects(f.replay(), undefined, path);
  }
});

test('resealed native window, sample and bracket inconsistencies cannot enter a proof', async t => {
  for (const mutateCapture of [
    value => {value.admission.intersectingAboveWindowCount = 1;},
    value => {value.rows[3].ownerPID++;},
    value => {value.rows[3].windowNumber++;},
    value => {value.rows[3].intersectingAboveWindowCount = 1;},
    value => {value.after.mach = '9000000';},
    value => {value.rows[3].windowObservationMach = '1';},
    value => {value.geometry.pointPixelScale = 2;},
  ]) {const f = await fixture(t, {mutateCapture}); await assert.rejects(f.replay());}
});

test('successful process closure requires its retained owned process and exact invocation', async t => {
  for (const mutateProcess of [
    value => {value.close.code = 1;},
    value => {value.exit.signal = 'SIGTERM';},
    value => {value.cleanupErrors.push({message: 'not closed'});},
    value => {value.requestedSignals.push('SIGKILL');},
    value => {value.processIdentity.ownerPid++;},
    value => {value.command[1] = '/outside/config.json';},
    value => {value.executable.sha256 = '0'.repeat(64);},
    value => {value.build.sourceSha256 = '0'.repeat(64);},
  ]) {const f = await fixture(t, {mutateProcess}); await assert.rejects(f.replay());}
});

test('result aliases, trusted source, selected PID and restored document must agree', async t => {
  for (const mutate of [
    f => {f.attempt.result.observations.windowServerPresentation = structuredClone(f.observation); f.attempt.result.observations.windowServerPresentation.target.ordinal = 1;},
    f => {f.attempt.result.observations.saved.nativePresentationBracket = structuredClone(f.observation.bracket); f.attempt.result.observations.saved.nativePresentationBracket.after.mach = '13000000';},
    f => {f.args.sourceFiles[0].sha256 = '0'.repeat(64);},
    f => {f.args.controlFiles[0].sha256 = '0'.repeat(64);},
    f => {f.args.sourceRoot = '/another/prepared-source';},
    f => {f.args.engine = 'firefox';},
    f => {f.attempt.result.evidence.runtime.browserPid++;},
    f => {f.attempt.result.observations.restoredAfter.wordmark = 'Editor updated';},
    f => {f.attempt.result.observations.restoration.sha256 = 'sha256:' + '0'.repeat(64);},
    f => {f.args.fixture.documentId = 'another-document';},
  ]) {const f = await fixture(t); mutate(f); await assert.rejects(f.replay());}
});

test('controller timing and native aliases cannot diverge from the sealed producer receipt', async t => {
  const f = await fixture(t); f.attempt.result.hotEdit.savedMs++;
  await assert.rejects(f.replay(), /retained producer observation/);
  const altered = await fixture(t); altered.attempt.result.observations.saved.startMs++;
  await assert.rejects(altered.replay(), /retained producer observation/);
});

test('resealed browser metadata cannot replace the consumed developer-state browser cache', async t => {
  const f = await fixture(t, {mutateBrowser: ({runtime, source}) => {
    runtime.browserCache.sha256 = source.browserCache.sha256 = 'sha256:' + '0'.repeat(64);
  }});
  await assert.rejects(f.replay(), /browser identity differs from consumed developer state/);
});

test('sealed preparation updates and transaction clocks outside the attempt cannot become scored updates', async t => {
  for (const mutateProducer of [
    value => {Object.assign(value.observations, {cache: 'first-update', ordinal: 1, prime: true, firstUpdate: true, scored: false});},
    value => {value.observations.firstUpdate = true;},
  ]) {
    const preparation = await fixture(t, {mutateProducer});
    await assert.rejects(preparation.replay(), /scheduled scored\/prime update/);
  }
  const outside = await fixture(t, {mutateProducer: value => {
    value.phases[0].endMs = 901; value.phases[0].durationMs = 901 - value.phases[0].startMs;
  }});
  await assert.rejects(outside.replay(), /outside its scheduled attempt/);
});

test('externally pinned oracle still has to describe the exact fixed wordmark edit', async t => {
  for (const mutateOracle of [
    value => {value.subject = 'marker-square';},
    value => {value.after.text = 'other';},
    value => {value.source.changedSha256 = '0'.repeat(64);},
    value => {value.display = {...value.display, id: 8};},
    value => {value.roi = {...value.roi, x: 5};},
  ]) {const f = await fixture(t, {mutateOracle}); await assert.rejects(f.replay());}
});

test('incomplete or missing causal browser marks cannot qualify an otherwise complete native replay', async t => {
  for (const mutateTrace of [
    value => {value.collection.completeEventReceived = false;},
    value => {value.events = value.events.filter(event => !event.name.includes('clock-before'));},
    value => {value.events = value.events.filter(event => !event.name.includes('complete'));},
    value => {value.events.push({...value.events[0]});},
  ]) {const f = await fixture(t, {mutateTrace}); assert.equal(await f.replay(), null);}
  const crossed = await fixture(t, {mutateTrace: value => {for (const event of value.events.filter(event => event.name.includes('clock-'))) event.pid++;}});
  await assert.rejects(crossed.replay(), /lane|marks|bracket/i);
});

test('capture membership is exact and all required retained members remain mandatory after relocation', async t => {
  for (const missing of ['native-hmr-1/capture/frame-2.bgra', 'native-hmr-1/build-evidence/sdk-manifest.json', 'native-wordmark-oracle/after.bgra',
    'hmr-original-' + uuid + '.ts', 'owned-process-23-' + uuid + '.json', 'hmr-update-1.json']) {
    const f = await fixture(t); f.args.retainedPaths.splice(f.args.retainedPaths.indexOf(missing), 1);
    await assert.rejects(f.replay());
  }
  const extra = await fixture(t); extra.args.retainedPaths.push('native-hmr-1/capture/frame-3.bgra'); await writeFile(extra.path('native-hmr-1/capture/frame-3.bgra'), afterPixels);
  await assert.rejects(extra.replay(), /membership/);
  const escaped = await fixture(t); escaped.attempt.result.hotEdit.windowServerPresentation.evidence.process.receipt.path = join(escaped.root, 'outside-process.json');
  await assert.rejects(escaped.replay());
});

test('campaign inventory includes raw native closure without absorbing unrelated binary trees', () => {
  for (const path of ['worker/native-hmr-1/stdout.ndjson', 'worker/native-hmr-1/capture/frames.ndjson', 'worker/native-hmr-1/capture/frame-2.bgra',
    'worker/native-hmr-1/build-evidence/collector.swift', 'worker/native-hmr-1/build-evidence/windowserver-capture',
    'worker/native-wordmark-oracle/before.bgra', 'worker/hmr-original-' + uuid + '.ts']) assert.equal(isCampaignEvidencePath(path), true, path);
  for (const path of ['worker/unrelated/image.bgra', 'worker/native-hmr-1/capture/extra.bin', 'worker/fixture/windowserver-capture']) assert.equal(isCampaignEvidencePath(path), false, path);
});

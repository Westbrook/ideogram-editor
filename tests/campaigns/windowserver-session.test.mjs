import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getWindowServerSessionObservations, validateWindowServerSessionConfig, validateWindowServerSessionReady, verifyWindowServerSessionCapture, windowServerSessionCapacity} from '../../tooling/qualification/campaigns/windowserver-session.mjs';

// Authored source-only; these fixtures have not been executed. Tiny synthetic
// images test replay admission, never real gesture or presentation coverage.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
function fixture({large = false} = {}) {
  const roi = large ? {x: 0, y: 0, width: 32768, height: 1} : {x: 4, y: 3, width: 2, height: 1};
  const display = {id: 7, width: large ? 32768 : 100, height: large ? 1 : 60};
  const pixels = [Buffer.alloc(roi.width * roi.height * 4, 3), Buffer.alloc(roi.width * roi.height * 4, 7)];
  const capacity = {durationMs: 75000, measurementDurationMs: 60000, refreshHz: 60, continuousGestures: 20, pointsPerGesture: 120,
    discreteGestures: 80, discreteSubsteps: 125, maxFrames: 9012, maxClockRecords: 5114, maxPixelBytes: pixels[0].length * 9012,
    metadataByteLimit: 9012 * 4096 + 5114 * 256, manifestByteLimit: 9012 * 256 + 32768};
  capacity.requiredArtifactBytes = capacity.maxPixelBytes + capacity.metadataByteLimit + capacity.manifestByteLimit;
  const evidenceBudget = {allocationSha256: 'a'.repeat(64), capacityBytes: 32 * 1024 ** 3, observedAllocatedBytes: 0, reservationBytes: capacity.requiredArtifactBytes};
  const bounds = {x: 0, y: 0, width: display.width, height: display.height};
  const sample = (ordinal, time, bytes) => ({schemaVersion: 2, event: 'sample', ordinal, statusRaw: 0, status: 'complete',
    ownerPID: 23, windowNumber: 9, windowObservationMach: String(time + 101), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0,
    callbackMach: String(time + 100), displayTimeMach: String(time), pts: {value: '0', timescale: 1, flags: 0, epoch: '0'},
    pixelFormat: 1111970369, width: display.width, height: display.height, roi: {...roi}, retained: true, file: `frame-${ordinal}.bgra`,
    sha256: hash(bytes), byteLength: bytes.length, contentScale: 1, scaleFactor: 1});
  const rows = [sample(1, 1000, pixels[0]), {schemaVersion: 2, event: 'clock', id: 'input-before', mach: '2000'},
    {schemaVersion: 2, event: 'clock', id: 'input-after', mach: '3000'}, sample(2, 4000, pixels[1])];
  const manifest = {kind: 'windowserver-session-capture-2', schemaVersion: 2,
    config: {schemaVersion: 2, profile: 'interaction-100-2400-60hz-60s-1', displayID: 7, expectedBrowserPid: 23, roi, evidenceBudget}, capacity,
    storageAdmission: {availableBytesBefore: String(capacity.requiredArtifactBytes), requiredArtifactBytes: capacity.requiredArtifactBytes, evidenceBudget: {...evidenceBudget}, targetAlarmAtReservation: false},
    display, captureGeometry: {displayBoundsPoints: {...bounds}, backingScale: {x: 1, y: 1}, displayPoints: {...bounds}, modePixels: {width: display.width, height: display.height},
      filterPoints: {...bounds}, pointPixelScale: 1, scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'},
    windowAdmission: {ownerPID: 23, windowNumber: 9, bounds: {...bounds}, layer: 0, alpha: 1, onScreen: true, roiPoints: {...roi}, aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0},
    timebase: {numer: 1, denom: 1}, startedMach: '0', endedMach: '10000', terminalReason: 'requested-stop',
    lossObservations: {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null},
    counts: {sampleRecords: 2, completeFrames: 2, clockRecords: 2, pixelBytes: pixels[0].length * 2, unretainedSamples: 0},
    frames: null, pixelFiles: rows.filter(row => row.file).map(row => ({path: row.file, bytes: row.byteLength, sha256: row.sha256}))};
  return {manifest, rows, pixels};
}
function invocation(directory, state, manifestSha256) {
  const manifest = state.manifest;
  const expectedReady = {...structuredClone(manifest), event: 'ready', outputDirectory: directory, roi: {...manifest.config.roi},
    pixelByteLimit: manifest.capacity.maxPixelBytes, metadataByteLimit: manifest.capacity.metadataByteLimit, manifestByteLimit: manifest.capacity.manifestByteLimit,
    maxClockRecords: manifest.capacity.maxClockRecords, pointPixelScale: manifest.captureGeometry.pointPixelScale};
  for (const key of ['endedMach', 'terminalReason', 'counts', 'frames', 'pixelFiles', 'lossObservations']) delete expectedReady[key];
  return {manifestSha256, expectedConfig: structuredClone(manifest.config), expectedReady,
    expectedStopped: {schemaVersion: 2, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'}, processExitCode: 0};
}
async function retain(t, state = fixture(), {framesBytes, manifestBytes} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'windowserver-session-source-test-'))), directory = join(root, 'capture');
  await mkdir(directory); t.after(() => rm(root, {recursive: true, force: true}));
  framesBytes ??= Buffer.from(state.rows.map(row => JSON.stringify(row) + '\n').join(''));
  state.manifest.frames = {path: 'frames.ndjson', bytes: framesBytes.length, sha256: hash(framesBytes)};
  manifestBytes ??= json(state.manifest);
  await writeFile(join(directory, 'manifest.json'), manifestBytes);
  await writeFile(join(directory, 'frames.ndjson'), framesBytes);
  for (let index = 0; index < state.pixels.length; index++) await writeFile(join(directory, state.pixelPaths?.[index] ?? `frame-${index + 1}.bgra`), state.pixels[index]);
  return {directory, state, options: invocation(directory, state, hash(manifestBytes))};
}
const replay = ({directory, options}) => verifyWindowServerSessionCapture(directory, options);

test('streamed bytes admit only opaque observations without a workload or presentation verdict', async t => {
  const retained = await retain(t, fixture({large: true})), capture = await replay(retained);
  assert.equal(capture.qualification, false); assert.equal(capture.invocationAdmission, 'caller-supplied');
  assert.equal(capture.collectorAuthenticity, 'unavailable'); assert.equal(capture.physicalScanout, 'unavailable');
  assert.equal(capture.displaySlotCoverage, 'unavailable'); assert.equal(capture.firstPresentedFrameCoverage, 'unavailable');
  const observations = getWindowServerSessionObservations(capture);
  assert.equal(observations.manifest.capacity.maxFrames, 9012); assert.equal(observations.manifest.capacity.maxClockRecords, 5114);
  assert.equal(observations.samples.length, 2); assert.equal(observations.clocks.length, 2);
  assert.equal(observations.samples[1].sha256, hash(retained.state.pixels[1]));
  assert.deepEqual(observations.lossObservations, {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null});
  assert.equal(observations.pixels, undefined); assert.equal(capture.firstCorrectPaintUpperBoundMs, undefined);
  assert.throws(() => getWindowServerSessionObservations({...capture}), /has not completed byte replay/);
  observations.samples[1].displayTimeMach = '1'; observations.manifest.config.roi.width = 1;
  assert.equal(getWindowServerSessionObservations(capture).samples[1].displayTimeMach, '4000');
  assert.equal(getWindowServerSessionObservations(capture).manifest.config.roi.width, 32768);
});

test('actual retained pixels override repeated caller and manifest hash claims', async t => {
  const retained = await retain(t);
  await writeFile(join(retained.directory, 'frame-2.bgra'), Buffer.alloc(8, 9));
  await assert.rejects(replay(retained), /differs from its seal/);
});

test('the full dispatch clock ledger exceeds the old 256-clock cap without claiming workload proof', async t => {
  const state = fixture(), last = state.rows[3];
  last.displayTimeMach = '8000'; last.callbackMach = '8100'; last.windowObservationMach = '8101';
  state.rows = [state.rows[0], ...Array.from({length: 5052}, (_, index) => ({schemaVersion: 2, event: 'clock', id: `dispatch-${index}`, mach: String(index + 2000)})), last];
  state.manifest.counts.clockRecords = 5052;
  const capture = await replay(await retain(t, state));
  assert.equal(getWindowServerSessionObservations(capture).clocks.length, 5052); assert.equal(capture.qualification, false);
});

test('a 5,115th distinct retained clock exceeds the fixed full-workload capacity', async t => {
  const state = fixture(), last = state.rows[3];
  last.displayTimeMach = '8000'; last.callbackMach = '8100'; last.windowObservationMach = '8101';
  state.rows = [state.rows[0], ...Array.from({length: 5115}, (_, index) => ({schemaVersion: 2, event: 'clock', id: `dispatch-${index}`, mach: String(index + 2000)})), last];
  state.manifest.counts.clockRecords = 5115;
  await assert.rejects(replay(await retain(t, state)), /native clock identity/);
});

test('unretained idle observations preserve nullable fields without inventing displayed pixels', async t => {
  const state = fixture(), idle = {...structuredClone(state.rows[0]), ordinal: 2, statusRaw: 1, status: 'idle',
    callbackMach: '2500', windowObservationMach: '2501', displayTimeMach: null, pixelFormat: null, width: null, height: null,
    retained: false, file: null, sha256: null, byteLength: null, contentScale: null, scaleFactor: null, unretainedReason: 'non-complete-status'};
  state.rows[3].ordinal = 3; state.rows[3].file = 'frame-3.bgra'; state.rows.splice(2, 0, idle);
  state.manifest.pixelFiles[1].path = 'frame-3.bgra'; state.pixelPaths = ['frame-1.bgra', 'frame-3.bgra'];
  state.manifest.counts.sampleRecords = 3; state.manifest.counts.unretainedSamples = 1;
  const samples = getWindowServerSessionObservations(await replay(await retain(t, state))).samples;
  assert.equal(samples[1].status, 'idle'); assert.equal(samples[1].displayTimeMach, null); assert.equal(samples[1].sha256, null);
});

test('missing process/ready/stopped admission and every cap terminal stay incomplete', async t => {
  const retained = await retain(t);
  for (const mutation of [
    options => {delete options.expectedConfig;}, options => {delete options.expectedReady;}, options => {delete options.expectedStopped;},
    options => {options.processExitCode = 1;}, options => {options.processExitCode = '0';}, options => {options.manifestSha256 = 'b'.repeat(64);},
    options => {options.expectedReady.startedMach = '1';}, options => {options.expectedStopped.endedMach = '9999';},
    ...['duration-limit', 'frame-limit', 'pixel-byte-limit', 'clock-record-limit', 'stdin-eof'].map(reason => options => {options.expectedStopped.terminalReason = reason;})
  ]) {
    const options = structuredClone(retained.options); mutation(options);
    await assert.rejects(verifyWindowServerSessionCapture(retained.directory, options));
  }
});

test('capacity and storage admission cannot shrink the fixed workload or weaken 90-percent ceiling', async t => {
  for (const mutation of [
    state => {state.manifest.capacity.maxFrames = 60;}, state => {state.manifest.capacity.maxClockRecords = 256;},
    state => {state.manifest.config.profile = 'smaller';}, state => {state.manifest.storageAdmission.availableBytesBefore = '0';},
    state => {state.manifest.config.evidenceBudget.reservationBytes--;}, state => {state.manifest.storageAdmission.targetAlarmAtReservation = true;},
    state => {state.manifest.config.evidenceBudget.allocationSha256 = 'not-a-seal';},
    state => {
      const budget = state.manifest.config.evidenceBudget;
      budget.capacityBytes = state.manifest.capacity.requiredArtifactBytes * 10; budget.reservationBytes = state.manifest.capacity.requiredArtifactBytes * 9;
      state.manifest.storageAdmission.evidenceBudget = {...budget}; state.manifest.storageAdmission.targetAlarmAtReservation = true;
    }
  ]) {const state = fixture(); mutation(state); const retained = await retain(t, state); await assert.rejects(replay(retained));}
});

test('an 80-percent reservation emits an alarm without bypassing strict 90-percent rejection', async t => {
  const state = fixture(), budget = state.manifest.config.evidenceBudget;
  budget.capacityBytes = state.manifest.capacity.requiredArtifactBytes * 10; budget.reservationBytes = state.manifest.capacity.requiredArtifactBytes * 8;
  state.manifest.storageAdmission.evidenceBudget = {...budget}; state.manifest.storageAdmission.targetAlarmAtReservation = true;
  const capture = await replay(await retain(t, state));
  assert.equal(getWindowServerSessionObservations(capture).manifest.storageAdmission.targetAlarmAtReservation, true);
});

test('geometry, ownership, pixel shape, clock enclosure and retained counts remain fail-closed', async t => {
  for (const mutation of [
    state => {state.manifest.captureGeometry.backingScale.x = 2;}, state => {state.manifest.windowAdmission.bounds.width = 1;},
    state => {state.manifest.display.width = 32769;}, state => {state.manifest.display.width = 32768; state.manifest.display.height = 32768;},
    state => {state.manifest.windowAdmission.intersectingAboveWindowCount = 1;}, state => {state.rows[3].ownerPID++;},
    state => {state.rows[3].intersectingAboveWindowCount = 1;}, state => {state.rows[3].width--;},
    state => {state.rows[3].contentScale = 0.5;}, state => {state.rows[3].roi.x++;}, state => {state.rows[3].pts.value = 0;},
    state => {state.rows[3].ordinal = 3;}, state => {state.rows[3].windowObservationMach = '4099';},
    state => {state.rows[3].displayTimeMach = '4200';}, state => {state.rows[2].id = state.rows[1].id;},
    state => {state.rows[2].mach = '18446744073709551616';}, state => {state.rows[2].mach = '1';},
    state => {state.manifest.counts.pixelBytes--;}, state => {state.rows[3].statusRaw = 1; state.rows[3].status = 'idle';}
  ]) {const state = fixture(); mutation(state); const retained = await retain(t, state); await assert.rejects(replay(retained));}
});

test('unknown capture loss is preserved and cannot become zero drops or complete display slots', async t => {
  for (const mutation of [
    state => {delete state.manifest.lossObservations;},
    state => {state.manifest.lossObservations.nativeDroppedFrames = 0;},
    state => {state.manifest.lossObservations.completeDisplaySlotSequence = true;},
    state => {state.manifest.lossObservations.streamError = {domain: 'SCStreamErrorDomain', code: -3801};}
  ]) {const state = fixture(); mutation(state); await assert.rejects(replay(await retain(t, state)), /loss observations/);}
});

test('canonical config admission exposes fixed capacity math without authenticating an allocation', () => {
  const state = fixture(), config = validateWindowServerSessionConfig(state.manifest.config);
  assert.deepEqual(windowServerSessionCapacity(config.roi), state.manifest.capacity); assert.notEqual(config, state.manifest.config);
  config.roi.width = 1; assert.equal(state.manifest.config.roi.width, 2);
  assert.throws(() => windowServerSessionCapacity({x: 0, y: 0, width: 0, height: 1}));
});

test('replay honors a pre-aborted signal and validates its explicit finite deadline', async t => {
  const retained = await retain(t), controller = new AbortController(); controller.abort(Error('cancelled by owner'));
  await assert.rejects(verifyWindowServerSessionCapture(retained.directory, {...retained.options, signal: controller.signal}), /cancelled by owner/);
  for (const timeoutMs of [0, -1, 300001, Infinity]) await assert.rejects(verifyWindowServerSessionCapture(retained.directory, {...retained.options, timeoutMs}), /bounded native replay/);
});

test('unlisted, duplicate, unreferenced and escaping files are rejected', async t => {
  const unlisted = await retain(t); await writeFile(join(unlisted.directory, 'extra.bgra'), Buffer.alloc(8)); await assert.rejects(replay(unlisted), /inventory/);
  for (const mutation of [
    state => {state.manifest.pixelFiles.push({...state.manifest.pixelFiles[0]});},
    state => {state.manifest.pixelFiles[0].path = '../frame-1.bgra';},
    state => {state.manifest.pixelFiles[0].path = '/frame-1.bgra';},
    state => {state.manifest.pixelFiles[0].path = 'nested/frame-1.bgra';},
    state => {state.rows.shift();},
    state => {state.rows[3].file = state.rows[0].file;}
  ]) {const state = fixture(); mutation(state); await assert.rejects(replay(await retain(t, state)));}
});

test('symlinked, hard-linked, missing and truncated retained files cannot supply pixels', async t => {
  for (const kind of ['symlink', 'hardlink', 'missing', 'truncated', 'directory']) {
    const retained = await retain(t), path = join(retained.directory, 'frame-2.bgra'); await rm(path);
    if (kind === 'symlink') await symlink('frame-1.bgra', path);
    if (kind === 'hardlink') await link(join(retained.directory, 'frame-1.bgra'), path);
    if (kind === 'truncated') await writeFile(path, Buffer.alloc(7));
    if (kind === 'directory') await mkdir(path);
    await assert.rejects(replay(retained));
  }
  const retained = await retain(t), alias = join(retained.directory, '..', 'alias'); await symlink(retained.directory, alias);
  const options = structuredClone(retained.options); options.expectedReady.outputDirectory = alias;
  await assert.rejects(verifyWindowServerSessionCapture(alias, options));
});

test('NDJSON requires a complete UTF-8 tail, bounded rows, unique keys and known sample schemas', async t => {
  const valid = fixture().rows.map(row => JSON.stringify(row) + '\n').join('');
  for (const framesBytes of [
    Buffer.from(valid.slice(0, -1)), Buffer.from(valid + '\n'), Buffer.concat([Buffer.from(valid), Buffer.from([0xff, 10])]),
    Buffer.from(valid.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2')),
    Buffer.from(valid.replace('"event":"sample"', '"event":"sample","extra":"' + 'x'.repeat(4096) + '"')),
    Buffer.from(valid.replace('"event":"sample"', '"event":"sample","extra":true')),
    Buffer.from('{"event":')
  ]) await assert.rejects(replay(await retain(t, fixture(), {framesBytes})));
});

test('ready snapshots are detached and pin the exact inherited limits', async t => {
  const retained = await retain(t), {expectedReady, expectedConfig} = retained.options;
  const admitted = validateWindowServerSessionReady(expectedReady, {config: expectedConfig, outputDirectory: retained.directory});
  assert.deepEqual(admitted, expectedReady); assert.notEqual(admitted, expectedReady);
  admitted.config.roi.width = 1; assert.equal(expectedReady.config.roi.width, 2);
  expectedReady.maxClockRecords = 256;
  assert.throws(() => validateWindowServerSessionReady(expectedReady, {config: expectedConfig, outputDirectory: retained.directory}));
  const bytes = await readFile(join(retained.directory, 'manifest.json'));
  assert.equal(hash(bytes), retained.options.manifestSha256);
});

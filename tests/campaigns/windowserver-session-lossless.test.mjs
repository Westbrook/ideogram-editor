import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {link, mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {getWindowServerSessionLosslessObservations, validateWindowServerSessionLosslessConfig, validateWindowServerSessionLosslessReady,
  verifyWindowServerSessionLosslessCapture, windowServerSessionLosslessCapacity} from '../../tooling/qualification/campaigns/windowserver-session-lossless.mjs';

// Authored source-only, not executed. Synthetic codec/protocol fixtures do not
// prove real interaction coverage, collector authenticity, or presentation.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
function fixture({large = false, onlyOne = false, level = 6} = {}) {
  const roi = large ? {x: 0, y: 0, width: 32768, height: 1} : {x: 4, y: 3, width: 2, height: 1};
  const display = {id: 7, width: large ? 32768 : 100, height: large ? 1 : 60};
  const raw = [Buffer.alloc(roi.width * roi.height * 4, 3), Buffer.alloc(roi.width * roi.height * 4, 7)];
  const encoded = raw.map(bytes => deflateRawSync(bytes, {windowBits: 15, level}));
  const rawFrameBytes = raw[0].length, maxEncodedFrameBytes = 2 * rawFrameBytes + 65536;
  const metadataByteLimit = 9012 * 4096 + 5114 * 256, manifestByteLimit = 9012 * 256 + 32768;
  const reservationBytes = metadataByteLimit + manifestByteLimit + maxEncodedFrameBytes;
  const capacity = {durationMs: 75000, measurementDurationMs: 60000, refreshHz: 60, continuousGestures: 20, pointsPerGesture: 120,
    discreteGestures: 80, discreteSubsteps: 125, maxFrames: 9012, maxClockRecords: 5114, rawFrameBytes, maxRawObservedBytes: rawFrameBytes * 9012,
    maxEncodedFrameBytes, maxEncodedPixelBytes: maxEncodedFrameBytes, metadataByteLimit, manifestByteLimit,
    minimumArtifactBytes: reservationBytes, reservedArtifactBytes: reservationBytes};
  const evidenceBudget = {allocationSha256: 'a'.repeat(64), capacityBytes: 32 * 1024 ** 3, observedAllocatedBytes: 0, reservationBytes, nativeArtifactBytes: reservationBytes};
  const bounds = {x: 0, y: 0, width: display.width, height: display.height};
  const blob = (index, offset) => ({kind: 'deflate-raw', offset, encodedBytes: encoded[index].length, encodedSha256: hash(encoded[index])});
  const sample = (ordinal, time, bytes, pixelStorage) => ({schemaVersion: 3, event: 'sample', ordinal, statusRaw: 0, status: 'complete',
    ownerPID: 23, windowNumber: 9, windowObservationMach: String(time + 101), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0,
    callbackMach: String(time + 100), displayTimeMach: String(time), pts: {value: '0', timescale: 1, flags: 0, epoch: '0'},
    pixelFormat: 1111970369, width: display.width, height: display.height, roi: {...roi}, retained: true, file: 'pixels.bin', pixelStorage,
    sha256: hash(bytes), byteLength: bytes.length, contentScale: 1, scaleFactor: 1});
  const rows = [sample(1, 1000, raw[0], blob(0, 0)), {schemaVersion: 3, event: 'clock', id: 'input-before', mach: '2000'},
    {schemaVersion: 3, event: 'clock', id: 'input-after', mach: '3000'}];
  if (!onlyOne) rows.push(sample(2, 4000, raw[0], {kind: 'reference', ordinal: 1}), sample(3, 5000, raw[1], blob(1, encoded[0].length)));
  const container = onlyOne ? encoded[0] : Buffer.concat(encoded), completeFrames = onlyOne ? 1 : 3;
  const manifest = {kind: 'windowserver-session-capture-3', schemaVersion: 3,
    config: {schemaVersion: 3, profile: 'interaction-100-2400-60hz-60s-1', storageFormat: 'rfc1951-previous-roi-1', displayID: 7, expectedBrowserPid: 23, roi, evidenceBudget}, capacity,
    storageAdmission: {availableBytesBefore: String(reservationBytes), reservedArtifactBytes: reservationBytes, evidenceBudget: {...evidenceBudget}, targetAlarmAtReservation: false},
    display, captureGeometry: {displayBoundsPoints: {...bounds}, backingScale: {x: 1, y: 1}, displayPoints: {...bounds}, modePixels: {width: display.width, height: display.height},
      filterPoints: {...bounds}, pointPixelScale: 1, scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'},
    windowAdmission: {ownerPID: 23, windowNumber: 9, bounds: {...bounds}, layer: 0, alpha: 1, onScreen: true, roiPoints: {...roi}, aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0},
    timebase: {numer: 1, denom: 1}, startedMach: '0', endedMach: '10000', terminalReason: 'requested-stop',
    lossObservations: {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null},
    counts: {sampleRecords: completeFrames, completeFrames, clockRecords: 2, unretainedSamples: 0, pixelBytes: completeFrames * rawFrameBytes,
      encodedPixelBytes: container.length, duplicateFrames: onlyOne ? 0 : 1},
    frames: null, pixelContainers: [{path: 'pixels.bin', bytes: container.length, sha256: hash(container)}]};
  return {manifest, rows, raw, encoded, container};
}
function sealContainer(state) {
  state.manifest.pixelContainers = [{path: 'pixels.bin', bytes: state.container.length, sha256: hash(state.container)}];
  state.manifest.counts.encodedPixelBytes = state.container.length;
}
function replaceOnlyBlob(state, bytes) {
  state.container = bytes; state.rows[0].pixelStorage = {kind: 'deflate-raw', offset: 0, encodedBytes: bytes.length, encodedSha256: hash(bytes)}; sealContainer(state);
}
function invocation(directory, state, manifestSha256) {
  const manifest = state.manifest;
  const expectedReady = {...structuredClone(manifest), event: 'ready', outputDirectory: directory, roi: {...manifest.config.roi},
    pixelByteLimit: manifest.capacity.maxEncodedPixelBytes, metadataByteLimit: manifest.capacity.metadataByteLimit, manifestByteLimit: manifest.capacity.manifestByteLimit,
    maxClockRecords: manifest.capacity.maxClockRecords, pointPixelScale: manifest.captureGeometry.pointPixelScale};
  for (const key of ['endedMach', 'terminalReason', 'counts', 'frames', 'pixelContainers', 'lossObservations']) delete expectedReady[key];
  return {manifestSha256, expectedConfig: structuredClone(manifest.config), expectedReady,
    expectedStopped: {schemaVersion: 3, event: 'stopped', terminalReason: manifest.terminalReason, endedMach: manifest.endedMach, manifest: 'manifest.json'}, processExitCode: 0};
}
async function retain(t, state = fixture(), {framesBytes} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'windowserver-lossless-source-test-'))), directory = join(root, 'capture');
  await mkdir(directory); t.after(() => rm(root, {recursive: true, force: true}));
  framesBytes ??= Buffer.from(state.rows.map(row => JSON.stringify(row) + '\n').join(''));
  state.manifest.frames = {path: 'frames.ndjson', bytes: framesBytes.length, sha256: hash(framesBytes)};
  const manifestBytes = json(state.manifest);
  await writeFile(join(directory, 'manifest.json'), manifestBytes); await writeFile(join(directory, 'frames.ndjson'), framesBytes);
  await writeFile(join(directory, 'pixels.bin'), state.container);
  return {directory, state, options: invocation(directory, state, hash(manifestBytes))};
}
const replay = ({directory, options}) => verifyWindowServerSessionLosslessCapture(directory, options);

test('streamed raw-DEFLATE and references preserve bytes and every independently timed observation', async t => {
  const retained = await retain(t, fixture({large: true, level: 0})), capture = await replay(retained);
  const value = getWindowServerSessionLosslessObservations(capture);
  assert.equal(value.samples.length, 3); assert.equal(value.samples[1].pixelStorage.kind, 'reference');
  assert.equal(value.samples[1].pixelStorage.ordinal, 1); assert.equal(value.samples[1].displayTimeMach, '4000');
  assert.equal(value.samples[2].sha256, hash(retained.state.raw[1])); assert.equal(value.samples[2].file, 'pixels.bin');
  assert.equal(value.samples[2].schemaVersion, 3); assert.equal(value.manifest.counts.duplicateFrames, 1);
  assert.equal(value.manifest.counts.pixelBytes, retained.state.raw[0].length * 3);
  for (const key of ['collectorAuthenticity', 'physicalScanout', 'displaySlotCoverage']) assert.equal(capture[key], 'unavailable');
  assert.equal(capture.qualification, false); assert.equal(value.pixels, undefined); assert.equal(capture.firstCorrectPaintUpperBoundMs, undefined);
  assert.throws(() => getWindowServerSessionLosslessObservations({...capture}), /has not completed byte replay/);
  value.samples[2].sha256 = 'b'.repeat(64); assert.equal(getWindowServerSessionLosslessObservations(capture).samples[2].sha256, hash(retained.state.raw[1]));
});

test('actual decompression checks raw hash and rejects both short and excessive output', async t => {
  const badHash = fixture({onlyOne: true}); badHash.rows[0].sha256 = 'b'.repeat(64);
  await assert.rejects(replay(await retain(t, badHash)), /reconstructed raw pixel identity/);
  for (const length of [4, 12]) {const state = fixture({onlyOne: true}); replaceOnlyBlob(state, deflateRawSync(Buffer.alloc(length, 3)));
    await assert.rejects(replay(await retain(t, state)), /raw frame length|reconstructed raw pixel identity/);}
});

test('an independently specified RFC 1951 stored block reconstructs exact BGRA bytes', async t => {
  // RFC 1951 sections 3.2.3/3.2.4: BFINAL=1, BTYPE=00, byte alignment,
  // little-endian LEN=8, NLEN=0xfff7, then eight literal bytes. This fixture
  // does not use Node's encoder to supply its compressed member.
  // https://www.rfc-editor.org/rfc/rfc1951.html#section-3.2.4
  const state = fixture({onlyOne: true}); replaceOnlyBlob(state, Buffer.from([1, 8, 0, 247, 255, 3, 3, 3, 3, 3, 3, 3, 3]));
  const row = getWindowServerSessionLosslessObservations(await replay(await retain(t, state))).samples[0];
  assert.equal(row.byteLength, 8); assert.equal(row.sha256, hash(Buffer.alloc(8, 3)));
});

test('truncated, corrupt, trailing-byte and concatenated compressed streams are rejected', async t => {
  for (const change of [bytes => bytes.subarray(0, -1), () => Buffer.from([255, 255, 255]),
    bytes => Buffer.concat([bytes, Buffer.from([0])]), bytes => Buffer.concat([bytes, bytes]), bytes => Buffer.concat([bytes, Buffer.alloc(65536)])
  ]) {const state = fixture({onlyOne: true}); replaceOnlyBlob(state, change(state.encoded[0])); await assert.rejects(replay(await retain(t, state)));}
});

test('whole-container and compressed-segment seals independently reject substitutions', async t => {
  const sealed = fixture({onlyOne: true}); sealed.manifest.pixelContainers[0].sha256 = 'b'.repeat(64);
  await assert.rejects(replay(await retain(t, sealed)), /whole pixel container seal/);
  const segment = fixture({onlyOne: true}); segment.rows[0].pixelStorage.encodedSha256 = 'b'.repeat(64);
  await assert.rejects(replay(await retain(t, segment)), /encoded segment/);
  const retained = await retain(t); await writeFile(join(retained.directory, 'pixels.bin'), Buffer.alloc(retained.state.container.length)); await assert.rejects(replay(retained));
});

test('blob layout rejects gaps, overlap, zero or oversized segments, and unreferenced tails', async t => {
  for (const mutation of [state => {state.rows[0].pixelStorage.offset = 1;}, state => {state.rows[4].pixelStorage.offset--;},
    state => {state.rows[4].pixelStorage.offset++;}, state => {state.rows[4].pixelStorage.encodedBytes = 0;},
    state => {state.rows[0].pixelStorage.encodedBytes = state.manifest.capacity.maxEncodedFrameBytes + 1;},
    state => {state.container = Buffer.concat([state.container, Buffer.from([0])]); sealContainer(state);}, state => {state.rows[4].pixelStorage.extra = true;}
  ]) {const state = fixture(); mutation(state); await assert.rejects(replay(await retain(t, state)));}
});

test('references require the previous complete ordinal and exact verified raw identity', async t => {
  for (const mutation of [state => {state.rows[0].pixelStorage = {kind: 'reference', ordinal: 0};},
    state => {state.rows[0].pixelStorage = {kind: 'reference', ordinal: 2}; state.rows[3].pixelStorage = {kind: 'reference', ordinal: 1};},
    state => {state.rows[3].pixelStorage.ordinal = 2;}, state => {state.rows[3].pixelStorage.ordinal = 3;},
    state => {state.rows[3].pixelStorage.ordinal = 0;}, state => {state.rows[3].sha256 = hash(state.raw[1]);},
    state => {state.rows[3].byteLength--;}, state => {state.rows[3].pixelStorage.offset = 0;}
  ]) {const state = fixture(); mutation(state); await assert.rejects(replay(await retain(t, state)));}
});

test('reference chains preserve every timestamp using bounded metadata', async t => {
  const state = fixture(); state.rows[4].pixelStorage = {kind: 'reference', ordinal: 2}; state.rows[4].sha256 = state.rows[3].sha256;
  state.container = state.encoded[0]; sealContainer(state); state.manifest.counts.duplicateFrames = 2;
  const samples = getWindowServerSessionLosslessObservations(await replay(await retain(t, state))).samples;
  assert.deepEqual(samples.map(row => row.displayTimeMach), ['1000', '4000', '5000']); assert.equal(samples[2].pixelStorage.ordinal, 2);
});

test('a sealed empty container is valid only when no complete frame is claimed', async t => {
  const state = fixture({onlyOne: true}); Object.assign(state.rows[0], {statusRaw: 1, status: 'idle', displayTimeMach: null, pixelFormat: null, width: null, height: null,
    retained: false, file: null, sha256: null, byteLength: null, pixelStorage: null, contentScale: null, scaleFactor: null, unretainedReason: 'non-complete-status'});
  state.container = Buffer.alloc(0); sealContainer(state); state.manifest.counts.completeFrames = 0; state.manifest.counts.pixelBytes = 0; state.manifest.counts.unretainedSamples = 1;
  assert.equal(getWindowServerSessionLosslessObservations(await replay(await retain(t, state))).samples[0].sha256, null);
  const invalid = fixture({onlyOne: true}); invalid.container = Buffer.alloc(0); sealContainer(invalid); await assert.rejects(replay(await retain(t, invalid)));
});

test('the full 5,052-clock ledger is retained and the 5,115th record exceeds capacity', async t => {
  for (const count of [5052, 5115]) {
    const state = fixture({onlyOne: true}); state.rows = [state.rows[0], ...Array.from({length: count}, (_, index) => ({schemaVersion: 3, event: 'clock', id: `dispatch-${index}`, mach: String(index + 2000)}))];
    state.manifest.counts.clockRecords = count; const retained = await retain(t, state);
    if (count === 5115) await assert.rejects(replay(retained), /native clock identity/);
    else assert.equal(getWindowServerSessionLosslessObservations(await replay(retained)).clocks.length, count);
  }
});

test('encoded reservations preserve the workload and original strict 90-percent ceiling', async t => {
  for (const mutation of [state => {state.manifest.capacity.maxFrames = 60;}, state => {state.manifest.capacity.maxClockRecords = 256;},
    state => {state.manifest.config.storageFormat = 'lossy';}, state => {state.manifest.storageAdmission.availableBytesBefore = '0';},
    state => {state.manifest.config.evidenceBudget.reservationBytes--;}, state => {state.manifest.storageAdmission.targetAlarmAtReservation = true;},
    state => {state.manifest.config.evidenceBudget.allocationSha256 = 'unsealed';},
    state => {const budget = state.manifest.config.evidenceBudget; budget.capacityBytes = budget.reservationBytes * 10; budget.observedAllocatedBytes = budget.reservationBytes * 8;
      state.manifest.storageAdmission.evidenceBudget = {...budget}; state.manifest.storageAdmission.targetAlarmAtReservation = true;}
  ]) {const state = fixture(); mutation(state); await assert.rejects(replay(await retain(t, state)));}
  const state = fixture(), budget = state.manifest.config.evidenceBudget; budget.capacityBytes = budget.reservationBytes * 10; budget.observedAllocatedBytes = budget.reservationBytes * 7;
  state.manifest.storageAdmission.evidenceBudget = {...budget}; state.manifest.storageAdmission.targetAlarmAtReservation = true;
  assert.equal(getWindowServerSessionLosslessObservations(await replay(await retain(t, state))).manifest.storageAdmission.targetAlarmAtReservation, true);
});

test('native allowance excludes independent overhead while free-space and thresholds cover the total', async t => {
  const state = fixture(), budget = state.manifest.config.evidenceBudget;
  budget.reservationBytes += 4096; state.manifest.storageAdmission.evidenceBudget = {...budget};
  state.manifest.storageAdmission.availableBytesBefore = String(budget.reservationBytes);
  const value = getWindowServerSessionLosslessObservations(await replay(await retain(t, state)));
  assert.equal(value.manifest.capacity.reservedArtifactBytes, budget.nativeArtifactBytes);
  assert.equal(value.manifest.capacity.maxEncodedPixelBytes, budget.nativeArtifactBytes - value.manifest.capacity.metadataByteLimit - value.manifest.capacity.manifestByteLimit);
  const insufficient = fixture(); insufficient.manifest.config.evidenceBudget.reservationBytes += 4096;
  insufficient.manifest.storageAdmission.evidenceBudget = {...insufficient.manifest.config.evidenceBudget};
  await assert.rejects(replay(await retain(t, insufficient)), /disk admission/);
  const missing = fixture(); delete missing.manifest.config.evidenceBudget.nativeArtifactBytes; await assert.rejects(replay(await retain(t, missing)));
  const oversized = fixture(); oversized.manifest.config.evidenceBudget.nativeArtifactBytes++; await assert.rejects(replay(await retain(t, oversized)));
});

test('geometry, ownership, clocks, counts and unknown native loss remain fail-closed', async t => {
  for (const mutation of [state => {state.manifest.captureGeometry.backingScale.x = 2;}, state => {state.manifest.windowAdmission.bounds.width = 1;},
    state => {state.manifest.display.width = 32769;}, state => {state.manifest.display.width = 32768; state.manifest.display.height = 32768;},
    state => {state.manifest.windowAdmission.intersectingAboveWindowCount = 1;}, state => {state.rows[4].ownerPID++;},
    state => {state.rows[4].intersectingAboveWindowCount = 1;}, state => {state.rows[4].contentScale = 0.5;}, state => {state.rows[4].roi.x++;},
    state => {state.rows[4].pts.value = 0;}, state => {state.rows[4].windowObservationMach = '5099';}, state => {state.rows[4].displayTimeMach = '5200';},
    state => {state.rows[2].id = state.rows[1].id;}, state => {state.rows[2].mach = '18446744073709551616';}, state => {state.manifest.counts.duplicateFrames--;},
    state => {state.manifest.counts.pixelBytes--;}, state => {state.manifest.lossObservations.nativeDroppedFrames = 0;},
    state => {state.manifest.lossObservations.completeDisplaySlotSequence = true;}, state => {state.manifest.lossObservations.streamError = {domain: 'SCStreamErrorDomain', code: -3801};}
  ]) {const state = fixture(); mutation(state); await assert.rejects(replay(await retain(t, state)));}
});

test('unlisted, duplicate, escaping and legacy per-frame inventories are rejected', async t => {
  const retained = await retain(t); await writeFile(join(retained.directory, 'frame-1.bgra'), Buffer.alloc(8)); await assert.rejects(replay(retained), /inventory/);
  for (const mutation of [state => {state.manifest.pixelContainers.push({...state.manifest.pixelContainers[0]});}, state => {state.manifest.pixelFiles = [];},
    state => {state.manifest.pixelContainers[0].path = '../pixels.bin';}, state => {state.manifest.pixelContainers[0].path = '/pixels.bin';}, state => {state.rows[0].file = '../pixels.bin';}
  ]) {const state = fixture(); mutation(state); await assert.rejects(replay(await retain(t, state)));}
});

test('symlinks, hard links, missing containers and truncated files cannot supply pixels', async t => {
  for (const kind of ['symlink', 'hardlink', 'missing', 'truncated', 'directory']) {
    const retained = await retain(t), path = join(retained.directory, 'pixels.bin'); await rm(path);
    if (kind === 'symlink') await symlink('frames.ndjson', path);
    if (kind === 'hardlink') await link(join(retained.directory, 'frames.ndjson'), path);
    if (kind === 'truncated') await writeFile(path, retained.state.container.subarray(0, -1));
    if (kind === 'directory') await mkdir(path); await assert.rejects(replay(retained));
  }
});

test('metadata requires complete UTF-8 lines, bounded records, unique keys and exact schema', async t => {
  const valid = fixture().rows.map(row => JSON.stringify(row) + '\n').join('');
  for (const framesBytes of [Buffer.from(valid.slice(0, -1)), Buffer.from(valid + '\n'), Buffer.concat([Buffer.from(valid), Buffer.from([255, 10])]),
    Buffer.from(valid.replace('"schemaVersion":3', '"schemaVersion":3,"schemaVersion":3')),
    Buffer.from(valid.replace('"event":"sample"', '"event":"sample","extra":"' + 'x'.repeat(4096) + '"')),
    Buffer.from(valid.replace('"event":"sample"', '"event":"sample","extra":true')), Buffer.from('{"event":')
  ]) await assert.rejects(replay(await retain(t, fixture(), {framesBytes})));
});

test('process exit, final stop, ready and manifest binding remain mandatory caller admissions', async t => {
  const retained = await retain(t);
  for (const mutation of [value => {delete value.expectedConfig;}, value => {delete value.expectedReady;}, value => {delete value.expectedStopped;},
    value => {value.processExitCode = 1;}, value => {value.manifestSha256 = 'b'.repeat(64);}, value => {value.expectedReady.startedMach = '1';}, value => {value.expectedStopped.endedMach = '9999';},
    ...['duration-limit', 'frame-limit', 'pixel-byte-limit', 'encoded-byte-limit', 'clock-record-limit', 'stdin-eof'].map(reason => value => {value.expectedStopped.terminalReason = reason;})
  ]) {const options = structuredClone(retained.options); mutation(options); await assert.rejects(verifyWindowServerSessionLosslessCapture(retained.directory, options));}
});

test('config and ready exports are detached and expose the encoded reservation', async t => {
  const retained = await retain(t), config = validateWindowServerSessionLosslessConfig(retained.state.manifest.config);
  assert.deepEqual(windowServerSessionLosslessCapacity(config.roi, config.evidenceBudget.nativeArtifactBytes), retained.state.manifest.capacity);
  assert.throws(() => windowServerSessionLosslessCapacity(config.roi, 0), /below minimum/);
  config.roi.width = 1; assert.equal(retained.state.manifest.config.roi.width, 2);
  const {expectedReady, expectedConfig} = retained.options;
  const ready = validateWindowServerSessionLosslessReady(expectedReady, {config: expectedConfig, outputDirectory: retained.directory});
  ready.config.roi.width = 1; assert.equal(expectedReady.config.roi.width, 2); expectedReady.maxClockRecords = 256;
  assert.throws(() => validateWindowServerSessionLosslessReady(expectedReady, {config: expectedConfig, outputDirectory: retained.directory}));
});

test('cancellation and finite replay deadlines never reduce the workload', async t => {
  const retained = await retain(t), controller = new AbortController(); controller.abort(Error('cancelled by owner'));
  await assert.rejects(verifyWindowServerSessionLosslessCapture(retained.directory, {...retained.options, signal: controller.signal}), /cancelled by owner/);
  for (const timeoutMs of [0, -1, 300001, Infinity]) await assert.rejects(verifyWindowServerSessionLosslessCapture(retained.directory, {...retained.options, timeoutMs}), /bounded native replay/);
});

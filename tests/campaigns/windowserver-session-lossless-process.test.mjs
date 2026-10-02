import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionWindowServerLosslessControl, validateSessionWindowServerLosslessConfig} from '../../tooling/qualification/campaigns/windowserver-session-lossless-process.mjs';
import {windowServerSessionLosslessCapacity} from '../../tooling/qualification/campaigns/windowserver-session-lossless.mjs';

// Synthetic control records only: no child, native capture, build admission or
// verified pixel token is produced by these tests. Authored, not executed.
const baselineHash = 'a'.repeat(64), targetHash = 'b'.repeat(64), encodedHash = 'd'.repeat(64);
function fixture({clockTimeoutMs = 2000, send} = {}) {
  const config = {schemaVersion: 3, profile: 'interaction-100-2400-60hz-60s-1', storageFormat: 'rfc1951-previous-roi-1', displayID: 7, expectedBrowserPid: 23,
    roi: {x: 4, y: 3, width: 2, height: 1}, evidenceBudget: {allocationSha256: 'c'.repeat(64), capacityBytes: 32 * 1024 ** 3, observedAllocatedBytes: 0, reservationBytes: 1024 ** 3, nativeArtifactBytes: 256 * 1024 ** 2}};
  const capacity = windowServerSessionLosslessCapacity(config.roi, config.evidenceBudget.nativeArtifactBytes);
  const outputDirectory = '/synthetic-windowserver/capture', sent = [], failures = [];
  const display = {id: 7, width: 100, height: 60};
  const geometry = {displayBoundsPoints: {x: 0, y: 0, width: 100, height: 60},
    displayPoints: {x: 0, y: 0, width: 100, height: 60}, modePixels: {width: 100, height: 60},
    filterPoints: {x: 0, y: 0, width: 100, height: 60}, pointPixelScale: 1, backingScale: {x: 1, y: 1},
    scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'};
  const ready = {kind: 'windowserver-session-capture-3', schemaVersion: 3, event: 'ready', config, outputDirectory, display, capacity,
    storageAdmission: {availableBytesBefore: String(32 * 1024 ** 3), reservedArtifactBytes: capacity.reservedArtifactBytes, evidenceBudget: {...config.evidenceBudget}, targetAlarmAtReservation: false},
    captureGeometry: geometry, windowAdmission: {ownerPID: 23, windowNumber: 9,
      bounds: {x: 0, y: 0, width: 100, height: 60}, layer: 0, alpha: 1, onScreen: true,
      roiPoints: {...config.roi}, aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0},
    roi: {...config.roi}, timebase: {numer: 1, denom: 1}, startedMach: '1000',
    pixelByteLimit: capacity.maxEncodedPixelBytes, metadataByteLimit: capacity.metadataByteLimit,
    manifestByteLimit: capacity.manifestByteLimit, maxClockRecords: capacity.maxClockRecords, pointPixelScale: 1};
  const sample = (ordinal, time = 2000, hash = baselineHash, pixelStorage = {kind: 'deflate-raw', offset: 0, encodedBytes: 8, encodedSha256: encodedHash}) => ({schemaVersion: 3, event: 'sample', ordinal,
    statusRaw: 0, status: 'complete', retained: true, file: 'pixels.bin', sha256: hash, byteLength: 8, pixelStorage,
    ownerPID: 23, windowNumber: 9, contentScale: 1, pixelFormat: 1111970369, width: 100, height: 60,
    roi: {...config.roi}, displayTimeMach: String(time), callbackMach: String(time + 10),
    windowObservationMach: String(time + 11), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0});
  const clock = (id, mach = '3000') => ({schemaVersion: 3, event: 'clock', id, mach});
  const stopped = (terminalReason = 'requested-stop') => ({schemaVersion: 3, event: 'stopped', terminalReason,
    endedMach: '10000', manifest: 'manifest.json'});
  const manifest = (terminalReason = 'requested-stop') => ({kind: ready.kind, schemaVersion: 3,
    ...Object.fromEntries(['config', 'capacity', 'storageAdmission', 'display', 'captureGeometry', 'windowAdmission', 'timebase', 'startedMach']
      .map(key => [key, structuredClone(ready[key])])), endedMach: '10000', terminalReason});
  const control = createSessionWindowServerLosslessControl({config, outputDirectory, clockTimeoutMs,
    send: command => {sent.push(structuredClone(command)); return send?.(command);}, onFailure: error => failures.push(error)});
  return {config, capacity, ready, sample, clock, stopped, manifest, control, sent, failures};
}

async function end(f) { await f.control.requestStop(); f.control.accept(f.stopped()); }

test('config bounds are exact and the admitted config cannot be rewritten by its caller', () => {
  const {config} = fixture(), admitted = validateSessionWindowServerLosslessConfig(config);
  assert.deepEqual(admitted, config); assert.notEqual(admitted, config); assert.notEqual(admitted.roi, config.roi);
  config.roi.width = 1; assert.equal(admitted.roi.width, 2);
  assert.throws(() => {admitted.roi.width = 1;}, TypeError);
  for (const mutate of [
    value => {value.qualification = true;}, value => {delete value.displayID;},
    value => {value.schemaVersion = 2;}, value => {value.displayID = 0x100000000;},
    value => {value.expectedBrowserPid = 0;}, value => {value.expectedBrowserPid = 0x80000000;},
    value => {value.roi.x = -1;}, value => {value.roi.y = 32769;}, value => {value.roi.width = 0;},
    value => {value.roi.height = 1.5;}, value => {value.roi.width = true;}, value => {value.roi.extra = 0;},
    value => {value.storageFormat = 'lossy';}, value => {value.profile = 'smaller-session';}, value => {value.maxFrames = 8;},
    value => {value.evidenceBudget.nativeArtifactBytes = 1;}, value => {value.evidenceBudget.nativeArtifactBytes = value.evidenceBudget.reservationBytes + 1;},
    value => {value.evidenceBudget.reservationBytes = 1;}, value => {value.evidenceBudget.capacityBytes = 1024;},
    value => {value.evidenceBudget.allocationSha256 = 'not-a-pin';}, value => {value.evidenceBudget.qualification = true;},
  ]) {const value = fixture().config; mutate(value); assert.throws(() => validateSessionWindowServerLosslessConfig(value));}
});

test('pre-ready complete samples are buffered and stdout ordinal gaps remain valid', async () => {
  const f = fixture(), first = f.sample(1), third = f.sample(3, 4000, targetHash, {kind: 'deflate-raw', offset: 8, encodedBytes: 8, encodedSha256: encodedHash});
  f.control.accept(first); f.control.accept(third);
  f.control.accept(f.ready); assert.deepEqual(await f.control.ready, f.ready);
  assert.deepEqual(f.control.snapshot().records, [first, third]);
  assert.equal(f.control.waitForPixelHash, undefined); assert.deepEqual(f.failures, []);
  const idle = {...f.sample(2, 3000), statusRaw: 1, status: 'idle', retained: false,
    file: null, sha256: null, byteLength: null, pixelStorage: null};
  await end(f);
  assert.doesNotThrow(() => f.control.assertReplay(f.manifest(), [first, idle, third]));
});

test('ready admission rechecks buffered samples and invalid admission is sticky', async () => {
  for (const mutate of [row => {row.windowNumber = 10;}, row => {row.width = 99;},
    row => {row.displayTimeMach = '999';}, row => {row.intersectingAboveWindowCount = 1;}]) {
    const f = fixture(), row = f.sample(1); mutate(row); f.control.accept(row);
    assert.throws(() => f.control.accept(f.ready));
    await assert.rejects(f.control.ready); assert.equal(f.failures.length, 1);
    assert.throws(() => f.control.accept(f.ready)); assert.equal(f.failures.length, 1);
  }
});

test('duplicate ready, sample ordinals and unsolicited ACKs poison the control once', async () => {
  for (const invalid of [f => f.ready, f => f.sample(1), f => f.clock('never-issued')]) {
    const f = fixture(); f.control.accept(f.ready); await f.control.ready; f.control.accept(f.sample(1));
    assert.throws(() => f.control.accept(invalid(f))); assert.equal(f.failures.length, 1);
    f.control.fail(Error('later failure')); assert.equal(f.failures.length, 1);
    await assert.rejects(f.control.captureClock('after-failure'));
  }
});

test('clock ACKs correlate concurrent commands and returned records are detached', async () => {
  const f = fixture(); f.control.accept(f.ready); await f.control.ready;
  const first = f.control.captureClock('save-before'), second = f.control.captureClock('save-after');
  await Promise.resolve();
  assert.deepEqual(f.sent, [{command: 'clock', id: 'save-before'}, {command: 'clock', id: 'save-after'}]);
  const after = f.clock('save-after', '3000'), before = f.clock('save-before', '4000');
  f.control.accept(after); f.control.accept(before);
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, before); assert.deepEqual(b, after);
  before.mach = '9999'; assert.equal(a.mach, '4000');
  assert.throws(() => {a.mach = '9999';}, TypeError);
  await end(f);
  assert.doesNotThrow(() => f.control.assertReplay(f.manifest(), [after, {...before, mach: '4000'}]));
});

test('clock IDs cannot be reused and the 5115th unique request is refused', async () => {
  const duplicate = fixture(); duplicate.control.accept(duplicate.ready);
  const observed = duplicate.control.captureClock('same'); await Promise.resolve();
  duplicate.control.accept(duplicate.clock('same')); await observed;
  await assert.rejects(duplicate.control.captureClock('same'), /repeated native clock ID/);
  assert.equal(duplicate.sent.length, 1); assert.equal(duplicate.failures.length, 1);
  const f = fixture(); f.control.accept(f.ready);
  for (let index = 0; index < 5114; index++) {
    const id = 'clock-' + index, pending = f.control.captureClock(id); await Promise.resolve();
    f.control.accept(f.clock(id, String(3000 + index))); await pending;
  }
  await assert.rejects(f.control.captureClock('clock-5114'), /native clock ID/);
  assert.equal(f.sent.length, 5114); assert.equal(f.failures.length, 1);
});

test('final replay binds ready, stopped and the full stdout observation sequence', async () => {
  const f = fixture(); f.control.accept(f.ready); f.control.accept(f.sample(1));
  const pending = f.control.captureClock('save'); await Promise.resolve();
  f.control.accept(f.clock('save')); await pending; await end(f);
  const records = f.control.snapshot().records, manifest = f.manifest();
  assert.doesNotThrow(() => f.control.assertReplay(manifest, records));
  for (const mutate of [value => {value.config.evidenceBudget.reservationBytes--;}, value => {value.display.width--;},
    value => {value.captureGeometry.showsCursor = false;}, value => {value.windowAdmission.windowNumber++;},
    value => {value.timebase.denom++;}, value => {value.startedMach = '1001';},
    value => {value.endedMach = '9999';}, value => {value.terminalReason = 'duration-limit';}]) {
    const changed = structuredClone(manifest); mutate(changed); assert.throws(() => f.control.assertReplay(changed, records));
  }
  for (const changed of [records.slice(1), [...records, records[0]], [...records].reverse(),
    records.map(row => row.event === 'clock' ? {...row, mach: '3001'} : row)]) {
    assert.throws(() => f.control.assertReplay(manifest, changed), /Stdout observations differ/);
  }
  assert.throws(() => f.control.accept(f.sample(2)), /after stopped/);
});

test('only an owned requested stop is admitted; natural limits remain incomplete', async () => {
  for (const reason of ['duration-limit', 'frame-limit', 'pixel-byte-limit', 'stdin-eof', 'requested-stop']) {
    const f = fixture(); f.control.accept(f.ready);
    if (reason !== 'requested-stop') await f.control.requestStop();
    assert.throws(() => f.control.accept(f.stopped(reason)), /Invalid native stopped/);
    assert.equal(f.failures.length, 1);
  }
  const f = fixture(); f.control.accept(f.ready); await end(f);
  await f.control.requestStop(); assert.equal(f.sent.filter(row => row.command === 'stop').length, 1);
  assert.doesNotThrow(() => f.control.assertReplay(f.manifest(), []));
});

test('clock deadline rejects every pending clock and retains the first failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture({clockTimeoutMs: 10}); f.control.accept(f.ready);
  const first = assert.rejects(f.control.captureClock('first'), /clock deadline/);
  const second = assert.rejects(f.control.captureClock('second'), /clock deadline/);
  await Promise.resolve(); t.mock.timers.tick(10); await Promise.all([first, second]);
  assert.equal(f.failures.length, 1);
  await assert.rejects(f.control.captureClock('later'), /clock deadline/);
  assert.throws(() => f.control.accept(f.clock('first')), /clock deadline/);
  f.control.fail(Error('replacement')); assert.equal(f.failures.length, 1);
});

test('stop and failure fence queued clock writes before dispatch', async () => {
  for (const terminal of ['stop', 'fail']) {
    const f = fixture(); f.control.accept(f.ready);
    const clock = assert.rejects(f.control.captureClock('queued'), terminal === 'stop' ? /stop requested/ : /owner cancelled/);
    if (terminal === 'stop') await f.control.requestStop(); else f.control.fail(Error('owner cancelled'));
    await clock; await Promise.resolve();
    assert.deepEqual(f.sent, terminal === 'stop' ? [{command: 'stop'}] : []);
    if (terminal === 'stop') {
      await f.control.requestStop(); assert.equal(f.sent.length, 1);
      f.control.accept(f.stopped('requested-stop'));
      assert.doesNotThrow(() => f.control.assertReplay(f.manifest('requested-stop'), []));
      assert.deepEqual(f.failures, []);
    } else assert.equal(f.failures.length, 1);
  }
});

test('a clock dispatched before stop may ACK during drain without reviving its cancelled waiter', async () => {
  const f = fixture(); f.control.accept(f.ready);
  const rejected = assert.rejects(f.control.captureClock('in-flight'), /stop requested/);
  await Promise.resolve(); assert.deepEqual(f.sent, [{command: 'clock', id: 'in-flight'}]);
  await f.control.requestStop(); await rejected;
  const ack = f.clock('in-flight');
  assert.doesNotThrow(() => f.control.accept(ack));
  f.control.accept(f.stopped('requested-stop'));
  assert.doesNotThrow(() => f.control.assertReplay(f.manifest('requested-stop'), [ack]));
  assert.deepEqual(f.failures, []);
});

test('control send failure is sticky and rejects every pending clock', async () => {
  const expected = Error('control pipe failed'), f = fixture({send: async () => {throw expected;}});
  f.control.accept(f.ready);
  const first = assert.rejects(f.control.captureClock('first'), /control pipe failed/);
  const second = assert.rejects(f.control.captureClock('second'), /control pipe failed/);
  await Promise.all([first, second]); assert.deepEqual(f.failures, [expected]);
  await assert.rejects(f.control.requestStop(), /control pipe failed/);
});

test('the full fixed profile capacity is retained without an HMR-sized clamp', () => {
  const f = fixture();
  assert.deepEqual({frames: f.capacity.maxFrames, clocks: f.capacity.maxClockRecords, duration: f.capacity.durationMs,
    measurement: f.capacity.measurementDurationMs, continuous: f.capacity.continuousGestures, points: f.capacity.pointsPerGesture,
    discrete: f.capacity.discreteGestures, substeps: f.capacity.discreteSubsteps, refresh: f.capacity.refreshHz},
  {frames: 9012, clocks: 5114, duration: 75000, measurement: 60000, continuous: 20, points: 120, discrete: 80, substeps: 125, refresh: 60});
  assert.equal(f.capacity.maxRawObservedBytes, 8 * 9012);
  assert.equal(f.capacity.rawFrameBytes, 8);
  assert.equal(f.capacity.maxEncodedFrameBytes, 2 * 8 + 65536);
  assert.equal(f.capacity.reservedArtifactBytes, f.config.evidenceBudget.nativeArtifactBytes);
  assert.equal(f.capacity.maxEncodedPixelBytes, f.config.evidenceBudget.nativeArtifactBytes - f.capacity.metadataByteLimit - f.capacity.manifestByteLimit);
  assert.equal(f.capacity.metadataByteLimit, 9012 * 4096 + 5114 * 256);
  assert.equal(f.capacity.manifestByteLimit, 9012 * 256 + 32768);
  f.control.accept(f.ready); f.control.accept(f.sample(9012));
  assert.throws(() => f.control.accept(f.sample(9013)), /sample ordinal/);
});

test('full config projection rejects exactly ninety percent and admits one byte below', () => {
  const f = fixture(), required = f.capacity.minimumArtifactBytes;
  const equal = structuredClone(f.config); equal.evidenceBudget.capacityBytes = required * 10;
  equal.evidenceBudget.reservationBytes = required * 9;
  assert.throws(() => validateSessionWindowServerLosslessConfig(equal), /90-percent/);
  equal.evidenceBudget.reservationBytes--;
  assert.equal(validateSessionWindowServerLosslessConfig(equal).evidenceBudget.reservationBytes, required * 9 - 1);
});


test('primitive and frozen owner failures preserve identity through every pending control', async () => {
  for (const reason of [undefined, null, false, 0, 'cancelled', Object.freeze(Error('frozen abort'))]) {
    const f = fixture();
    const readyFailure = f.control.ready.then(() => assert.fail('ready unexpectedly admitted'), actual => assert.equal(actual, reason));
    f.control.fail(reason); f.control.fail(Error('later replacement'));
    await readyFailure; assert.equal(f.failures.length, 1); assert.equal(f.failures[0], reason);
    await f.control.captureClock('after-failure').then(() => assert.fail('clock unexpectedly admitted'), actual => assert.equal(actual, reason));
    await f.control.requestStop().then(() => assert.fail('stop unexpectedly admitted'), actual => assert.equal(actual, reason));
    const active = fixture(); active.control.accept(active.ready);
    const clockFailure = active.control.captureClock('pending').then(() => assert.fail('clock unexpectedly acknowledged'), actual => assert.equal(actual, reason));
    active.control.fail(reason); await clockFailure;
    await Promise.resolve(); assert.deepEqual(active.sent, []);
  }
});


test('consecutive raw duplicates reference the previous complete sample while retaining their own times', async () => {
  const f = fixture(), first = f.sample(1), duplicate = f.sample(3, 3000, baselineHash, {kind: 'reference', ordinal: 1});
  const duplicateAgain = f.sample(5, 4000, baselineHash, {kind: 'reference', ordinal: 3});
  const changed = f.sample(6, 5000, targetHash, {kind: 'deflate-raw', offset: 8, encodedBytes: 8, encodedSha256: encodedHash});
  for (const row of [first, duplicate, duplicateAgain]) f.control.accept(row);
  f.control.accept(f.ready); await f.control.ready; f.control.accept(changed); await end(f);
  const records = [first, duplicate, duplicateAgain, changed];
  assert.doesNotThrow(() => f.control.assertReplay(f.manifest(), records));
  assert.deepEqual(f.control.snapshot().records.map(row => row.displayTimeMach), ['2000', '3000', '4000', '5000']);
  const altered = structuredClone(records); altered[3].pixelStorage.encodedSha256 = 'e'.repeat(64);
  assert.throws(() => f.control.assertReplay(f.manifest(), altered), /Stdout observations differ/);
  duplicate.pixelStorage.ordinal = 999; assert.equal(f.control.snapshot().records[1].pixelStorage.ordinal, 1);
});

test('malformed encoded intervals and raw references poison provisional control before private replay', async () => {
  const mutations = [
    (row, f) => {row.file = 'frame-1.bgra';},
    (row, f) => {row.pixelStorage.offset = 1;},
    (row, f) => {row.pixelStorage.encodedBytes = f.capacity.maxEncodedFrameBytes + 1;},
    (row, f) => {row.pixelStorage.offset = f.capacity.maxEncodedPixelBytes - 4;},
    (row, f) => {row.pixelStorage.encodedSha256 = 'unsealed';},
    (row, f) => {row.pixelStorage.extra = true;},
    (row, f) => {row.pixelStorage = {kind: 'reference', ordinal: 1};},
  ];
  for (const mutate of mutations) {
    const f = fixture(), row = f.sample(1); f.control.accept(f.ready); mutate(row, f);
    assert.throws(() => f.control.accept(row)); assert.equal(f.failures.length, 1);
    await assert.rejects(f.control.captureClock('after-invalid-storage'));
  }
  for (const mutate of [row => {row.sha256 = targetHash;}, row => {row.pixelStorage.ordinal = 2;}]) {
    const f = fixture(); f.control.accept(f.ready); f.control.accept(f.sample(1));
    const row = f.sample(3, 3000, baselineHash, {kind: 'reference', ordinal: 1}); mutate(row);
    assert.throws(() => f.control.accept(row), /previous complete raw identity/);
  }
  const f = fixture(); f.control.accept(f.ready); f.control.accept(f.sample(1));
  assert.throws(() => f.control.accept(f.sample(2)), /overlap or leave a gap/);
});

test('ready admission separates total free-space reservation from native container allowance', async () => {
  for (const mutate of [
    f => {f.ready.storageAdmission.availableBytesBefore = String(f.config.evidenceBudget.nativeArtifactBytes);},
    f => {f.ready.pixelByteLimit = f.config.evidenceBudget.reservationBytes;},
    f => {f.ready.capacity.reservedArtifactBytes = f.config.evidenceBudget.reservationBytes;},
  ]) {
    const f = fixture(); mutate(f); assert.throws(() => f.control.accept(f.ready));
    await assert.rejects(f.control.ready); assert.equal(f.failures.length, 1);
  }
  const f = fixture(); f.control.accept(f.ready); await f.control.ready;
  assert.equal(f.capacity.maxEncodedPixelBytes + f.capacity.metadataByteLimit + f.capacity.manifestByteLimit, f.config.evidenceBudget.nativeArtifactBytes);
  assert.ok(f.config.evidenceBudget.nativeArtifactBytes < f.config.evidenceBudget.reservationBytes);
});

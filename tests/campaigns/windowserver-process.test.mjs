import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowServerControl, validateWindowServerConfig} from '../../tooling/qualification/campaigns/windowserver-process.mjs';

// Synthetic control records only: no child, native capture, build admission or
// verified pixel token is produced by these tests. Authored, not executed.
const baselineHash = 'a'.repeat(64), targetHash = 'b'.repeat(64);
function fixture({clockTimeoutMs = 2000, send} = {}) {
  const config = {schemaVersion: 1, displayID: 7, expectedBrowserPid: 23,
    roi: {x: 4, y: 3, width: 2, height: 1}, durationMs: 1000, maxFrames: 8, maxBytes: 64};
  const outputDirectory = '/synthetic-windowserver/capture', sent = [], failures = [];
  const display = {id: 7, width: 100, height: 60};
  const geometry = {displayBoundsPoints: {x: 0, y: 0, width: 100, height: 60},
    displayPoints: {x: 0, y: 0, width: 100, height: 60}, modePixels: {width: 100, height: 60},
    filterPoints: {x: 0, y: 0, width: 100, height: 60}, pointPixelScale: 1, backingScale: {x: 1, y: 1},
    scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'};
  const ready = {kind: 'windowserver-capture-1', schemaVersion: 1, event: 'ready', config, outputDirectory, display,
    captureGeometry: geometry, windowAdmission: {ownerPID: 23, windowNumber: 9,
      bounds: {x: 0, y: 0, width: 100, height: 60}, layer: 0, alpha: 1, onScreen: true,
      roiPoints: {...config.roi}, aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0},
    roi: {...config.roi}, timebase: {numer: 1, denom: 1}, startedMach: '1000',
    pixelByteLimit: config.maxBytes, metadataByteLimit: 8 * 1024 ** 2,
    manifestByteLimit: 2 * 1024 ** 2, maxClockRecords: 256, pointPixelScale: 1};
  const sample = (ordinal, time = 2000, hash = baselineHash) => ({schemaVersion: 1, event: 'sample', ordinal,
    statusRaw: 0, status: 'complete', retained: true, file: `frame-${ordinal}.bgra`, sha256: hash, byteLength: 8,
    ownerPID: 23, windowNumber: 9, contentScale: 1, pixelFormat: 1111970369, width: 100, height: 60,
    roi: {...config.roi}, displayTimeMach: String(time), callbackMach: String(time + 10),
    windowObservationMach: String(time + 11), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0});
  const clock = (id, mach = '3000') => ({schemaVersion: 1, event: 'clock', id, mach});
  const stopped = (terminalReason = 'duration-limit') => ({schemaVersion: 1, event: 'stopped', terminalReason,
    endedMach: '10000', manifest: 'manifest.json'});
  const manifest = (terminalReason = 'duration-limit') => ({kind: ready.kind, schemaVersion: 1,
    ...Object.fromEntries(['config', 'display', 'captureGeometry', 'windowAdmission', 'timebase', 'startedMach']
      .map(key => [key, structuredClone(ready[key])])), endedMach: '10000', terminalReason});
  const control = createWindowServerControl({config, outputDirectory, clockTimeoutMs,
    send: command => {sent.push(structuredClone(command)); return send?.(command);}, onFailure: error => failures.push(error)});
  return {config, ready, sample, clock, stopped, manifest, control, sent, failures};
}

test('config bounds are exact and the admitted config cannot be rewritten by its caller', () => {
  const {config} = fixture(), admitted = validateWindowServerConfig(config);
  assert.deepEqual(admitted, config); assert.notEqual(admitted, config); assert.notEqual(admitted.roi, config.roi);
  config.roi.width = 1; assert.equal(admitted.roi.width, 2);
  assert.throws(() => {admitted.roi.width = 1;}, TypeError);
  for (const mutate of [
    value => {value.qualification = true;}, value => {delete value.displayID;},
    value => {value.schemaVersion = 2;}, value => {value.displayID = 0x100000000;},
    value => {value.expectedBrowserPid = 0;}, value => {value.expectedBrowserPid = 0x80000000;},
    value => {value.roi.x = -1;}, value => {value.roi.y = 32769;}, value => {value.roi.width = 0;},
    value => {value.roi.height = 1.5;}, value => {value.roi.width = true;}, value => {value.roi.extra = 0;},
    value => {value.durationMs = 75001;}, value => {value.maxFrames = 5001;},
    value => {value.maxBytes = 7;}, value => {value.maxBytes = 256 * 1024 ** 2 + 1;},
  ]) {const value = fixture().config; mutate(value); assert.throws(() => validateWindowServerConfig(value));}
});

test('pre-ready complete samples are buffered and stdout ordinal gaps remain valid', async () => {
  const f = fixture(), first = f.sample(1), third = f.sample(3, 4000, targetHash);
  f.control.accept(first); f.control.accept(third);
  f.control.accept(f.ready); assert.deepEqual(await f.control.ready, f.ready);
  const observed = await f.control.waitForPixelHash(targetHash);
  assert.deepEqual(observed, {sample: third, authenticated: false});
  assert.equal(observed.capture, undefined); assert.deepEqual(f.failures, []);
  const idle = {...f.sample(2, 3000), statusRaw: 1, status: 'idle', retained: false,
    file: null, sha256: null, byteLength: null};
  f.control.accept(f.stopped());
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
    await assert.rejects(f.control.waitForPixelHash(baselineHash));
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
  f.control.accept(f.stopped());
  assert.doesNotThrow(() => f.control.assertReplay(f.manifest(), [after, {...before, mach: '4000'}]));
});

test('clock IDs cannot be reused and the 257th unique request is refused', async () => {
  const duplicate = fixture(); duplicate.control.accept(duplicate.ready);
  const observed = duplicate.control.captureClock('same'); await Promise.resolve();
  duplicate.control.accept(duplicate.clock('same')); await observed;
  await assert.rejects(duplicate.control.captureClock('same'), /repeated native clock ID/);
  assert.equal(duplicate.sent.length, 1); assert.equal(duplicate.failures.length, 1);
  const f = fixture(); f.control.accept(f.ready);
  for (let index = 0; index < 256; index++) {
    const id = 'clock-' + index, pending = f.control.captureClock(id); await Promise.resolve();
    f.control.accept(f.clock(id, String(3000 + index))); await pending;
  }
  await assert.rejects(f.control.captureClock('clock-256'), /native clock ID/);
  assert.equal(f.sent.length, 256); assert.equal(f.failures.length, 1);
});

test('target observation ignores a match before the required native display boundary', async () => {
  const f = fixture(); f.control.accept(f.ready); f.control.accept(f.sample(1, 2000, targetHash));
  let settled = false;
  const pending = f.control.waitForPixelHash(targetHash, {minimumDisplayTimeMach: '4000'}).then(value => {settled = true; return value;});
  await Promise.resolve(); assert.equal(settled, false);
  f.control.accept(f.sample(2, 3999, targetHash)); await Promise.resolve(); assert.equal(settled, false);
  f.control.accept(f.sample(3, 4000, targetHash));
  const result = await pending; assert.equal(result.sample.ordinal, 3); assert.equal(result.authenticated, false);
  assert.throws(() => {result.sample.sha256 = baselineHash;}, TypeError);
  const snapshot = f.control.snapshot(); assert.throws(() => {snapshot.records.length = 0;}, TypeError);
  assert.equal(f.control.snapshot().records.length, 3);
});

test('pixel waits reject malformed tick boundaries and caller qualification options', async () => {
  for (const options of [{minimumDisplayTimeMach: 4000}, {minimumDisplayTimeMach: '04'},
    {minimumDisplayTimeMach: '18446744073709551616'}, {timeoutMs: 0}, {qualification: true}]) {
    const f = fixture(); f.control.accept(f.ready);
    await assert.rejects(f.control.waitForPixelHash(targetHash, options)); assert.equal(f.failures.length, 1);
  }
});

test('final replay binds ready, stopped and the full stdout observation sequence', async () => {
  const f = fixture(); f.control.accept(f.ready); f.control.accept(f.sample(1));
  const pending = f.control.captureClock('save'); await Promise.resolve();
  f.control.accept(f.clock('save')); await pending; f.control.accept(f.stopped());
  const records = f.control.snapshot().records, manifest = f.manifest();
  assert.doesNotThrow(() => f.control.assertReplay(manifest, records));
  for (const mutate of [value => {value.config.maxFrames--;}, value => {value.display.width--;},
    value => {value.captureGeometry.showsCursor = false;}, value => {value.windowAdmission.windowNumber++;},
    value => {value.timebase.denom++;}, value => {value.startedMach = '1001';},
    value => {value.endedMach = '9999';}, value => {value.terminalReason = 'requested-stop';}]) {
    const changed = structuredClone(manifest); mutate(changed); assert.throws(() => f.control.assertReplay(changed, records));
  }
  for (const changed of [records.slice(1), [...records, records[0]], [...records].reverse(),
    records.map(row => row.event === 'clock' ? {...row, mach: '3001'} : row)]) {
    assert.throws(() => f.control.assertReplay(manifest, changed), /Stdout observations differ/);
  }
  assert.throws(() => f.control.accept(f.sample(2)), /after stopped/);
});

test('natural stop rejects pending observations without claiming a control failure', async () => {
  const f = fixture(); f.control.accept(f.ready);
  const clock = assert.rejects(f.control.captureClock('pending'), /ended before/);
  const pixels = assert.rejects(f.control.waitForPixelHash(targetHash), /ended before/);
  await Promise.resolve(); f.control.accept(f.stopped()); await Promise.all([clock, pixels]);
  assert.deepEqual(f.failures, []); assert.equal(f.control.snapshot().failure, null);
  await f.control.requestStop(); assert.equal(f.sent.filter(row => row.command === 'stop').length, 0);
});

test('clock and pixel deadlines fail all pending observations and retain the first failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const kind of ['clock', 'pixel']) {
    const f = fixture({clockTimeoutMs: kind === 'clock' ? 10 : 100}); f.control.accept(f.ready);
    const clock = assert.rejects(f.control.captureClock('pending'), /deadline exceeded/);
    const pixels = assert.rejects(f.control.waitForPixelHash(targetHash, {timeoutMs: kind === 'pixel' ? 10 : 100}), /deadline exceeded/);
    await Promise.resolve(); t.mock.timers.tick(10); await Promise.all([clock, pixels]);
    assert.equal(f.failures.length, 1); assert.match(String(f.failures[0]), kind === 'clock' ? /clock deadline/ : /pixel observation deadline/);
    await assert.rejects(f.control.captureClock('pending'), /deadline exceeded/);
    assert.throws(() => f.control.accept(f.clock('pending')), /deadline exceeded/);
    f.control.fail(Error('replacement')); assert.equal(f.failures.length, 1);
  }
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

test('control send failure is sticky and rejects both clock and pixel waiters', async () => {
  const expected = Error('control pipe failed'), f = fixture({send: async () => {throw expected;}});
  f.control.accept(f.ready);
  const pixels = assert.rejects(f.control.waitForPixelHash(targetHash), /control pipe failed/);
  const clock = assert.rejects(f.control.captureClock('save'), /control pipe failed/);
  await Promise.all([pixels, clock]); assert.deepEqual(f.failures, [expected]);
  await assert.rejects(f.control.requestStop(), /control pipe failed/);
});

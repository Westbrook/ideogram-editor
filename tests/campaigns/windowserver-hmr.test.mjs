import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeHmrConfiguration, validateHmrOracle, readHmrOrdinaryInput, createHmrWindowServerTransaction, hmrWindowServerCeilingObserved, drainHmrCancellation} from '../../tooling/qualification/campaigns/windowserver-hmr.mjs';

// Synthetic protocol bytes only: no real pixel oracle or native execution.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function inputs() {
  const runtime = {headless: false, browserPid: 123, engine: 'chromium'};
  const selection = {kind: 'windowserver-hmr-configuration-1', build: {receiptPath: '/owned/build.json', receiptSha256: 'c'.repeat(64)},
    oracle: {path: '/owned/oracle.json', sha256: 'd'.repeat(64)}, displayID: 7, roi: {x: 4, y: 3, width: 2, height: 1},
    capture: {durationMs: 1000, maxFrames: 60, maxBytes: 4096}};
  const sourceIdentity = {sourcePath: 'src/ui/shell-wordmark.ts', original: {sha256: 'sha256:' + 'a'.repeat(64)}, changed: {sha256: 'sha256:' + 'b'.repeat(64)}};
  const before = Buffer.from([0, 1, 2, 255, 3, 4, 5, 255]), after = Buffer.from([6, 7, 8, 255, 9, 10, 11, 255]);
  const oracle = {kind: 'hmr-wordmark-oracle-1', schemaVersion: 1, subject: '.wordmark-secondary', pixelFormat: 'BGRA8',
    display: {id: 7, width: 100, height: 60}, roi: {...selection.roi}, source: {originalSha256: 'a'.repeat(64), changedSha256: 'b'.repeat(64)},
    before: {text: 'Editor', bytes: before.length, sha256: sha(before)}, after: {text: 'Editor updated', bytes: after.length, sha256: sha(after)}};
  return {runtime, selection, sourceIdentity, oracle, pixels: new Map([['before.bgra', before], ['after.bgra', after]])};
}

test('native capture is an explicit selection and its PID comes from the owned headed browser', () => {
  const {runtime, selection} = inputs();
  assert.equal(nativeHmrConfiguration(undefined, runtime), null);
  const selected = nativeHmrConfiguration(selection, runtime);
  assert.equal(selected.config.expectedBrowserPid, runtime.browserPid);
  assert.equal(selected.config.schemaVersion, 1);
  assert.deepEqual(selected.config.roi, selection.roi);
  selection.roi.x = 99;
  assert.equal(selected.config.roi.x, 4);
});

test('configuration cannot inject another process, arbitrary executable, or qualified flag', () => {
  for (const extra of [{expectedBrowserPid: 321}, {executable: '/arbitrary'}, {qualification: true}]) {
    const {runtime, selection} = inputs();
    assert.throws(() => nativeHmrConfiguration({...selection, ...extra}, runtime));
  }
  const {runtime, selection} = inputs();
  assert.throws(() => nativeHmrConfiguration(selection, {...runtime, headless: true}));
  assert.throws(() => nativeHmrConfiguration(selection, {...runtime, browserPid: 0}));
});

test('native input paths, hashes, display and retained capture bounds are mandatory', () => {
  for (const mutate of [
    value => {value.build.receiptPath = 'relative.json';},
    value => {value.build.receiptSha256 = 'unknown';},
    value => {value.oracle.sha256 = null;},
    value => {value.displayID = 0;},
    value => {value.roi.width = 0;},
    value => {value.capture.durationMs = 75001;},
    value => {value.capture.maxFrames = 5001;},
    value => {value.capture.maxBytes = 7;},
  ]) {const {selection, runtime} = inputs(); mutate(selection); assert.throws(() => nativeHmrConfiguration(selection, runtime));}
});

test('oracle validation requires exact before and after bytes for the actual fixed source edit', () => {
  const value = inputs();
  assert.equal(validateHmrOracle(value.oracle, value.pixels, value), true);
  const wrong = inputs(); wrong.pixels.set('after.bgra', Buffer.alloc(8));
  assert.throws(() => validateHmrOracle(wrong.oracle, wrong.pixels, wrong));
});

test('a different subject, display, ROI, source edit or unchanged pixels cannot substitute for the wordmark oracle', () => {
  for (const mutate of [
    value => {value.oracle.subject = 'marker-square';},
    value => {value.oracle.display.id++;},
    value => {value.oracle.roi.x++;},
    value => {value.sourceIdentity.changed.sha256 = 'sha256:' + 'e'.repeat(64);},
    value => {value.oracle.after = {...value.oracle.before, text: 'Editor updated'}; value.pixels.set('after.bgra', value.pixels.get('before.bgra'));},
    value => {value.pixels.set('extra.bgra', Buffer.alloc(8));},
  ]) {const value = inputs(); mutate(value); assert.throws(() => validateHmrOracle(value.oracle, value.pixels, value));}
});

function transaction(overrides = {}) {
  const value = inputs(), calls = [];
  const capture = {
    ready: {kind: 'test-unverified'}, processIdentity: {pid: 123},
    async captureClock(id) {calls.push(id); return {schemaVersion: 1, event: 'clock', id, mach: id.endsWith('-before') ? '10' : '20'};},
    async waitForPixelHash(hash, options) {calls.push({hash, options}); return {sample: {ordinal: 2}, authenticated: false};},
    async stop() {calls.push('stop'); return {manifest: {path: '/synthetic/manifest.json'}, process: {kind: 'test-unverified'}};},
    ...overrides,
  };
  const binding = {config: {expectedBrowserPid: 123}, build: {receiptPath: '/original/build.json'}};
  return {calls, binding, transaction: createHmrWindowServerTransaction({id: 'hmr-1', capture, baseline: {sample: {ordinal: 1}},
    oracle: value.oracle, oracleBytes: Buffer.from(JSON.stringify(value.oracle)), pixels: value.pixels, oracleSha256: 'a'.repeat(64), sourceIdentity: value.sourceIdentity, binding})};
}

test('ordinary native inputs reject symlinks and oversize files and retain exact admitted bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-hmr-read-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  // tmpdir may contain a platform symlink; the actual admitted path is canonical.
  const {realpath} = await import('node:fs/promises'), directory = await realpath(root);
  const path = join(directory, 'bytes');
  await writeFile(path, Buffer.from([1, 2, 3]));
  const admitted = await readHmrOrdinaryInput(path, 3);
  assert.deepEqual(admitted.bytes, Buffer.from([1, 2, 3]));
  assert.equal(admitted.identity.sha256, sha(admitted.bytes));
  await assert.rejects(readHmrOrdinaryInput(path, 2));
  await symlink(path, join(directory, 'link'));
  await assert.rejects(readHmrOrdinaryInput(join(directory, 'link'), 3));
  await mkdir(join(directory, 'directory'));
  await assert.rejects(readHmrOrdinaryInput(join(directory, 'directory'), 3));
});

test('each native transaction dispatches its actual save only once even while the first save is pending', async () => {
  const {transaction: action} = transaction();
  let calls = 0, release, enter;
  const entered = new Promise(resolve => {enter = resolve;});
  const pending = action.save(async () => {calls++; enter(); await new Promise(resolve => {release = resolve;}); return {saved: true};});
  await assert.rejects(action.save(() => {calls++; return {};}), /single-use/);
  await entered;
  release();
  const saved = await pending;
  assert.equal(calls, 1); assert.equal(saved.saved, true);
  await action.observeUpdated(saved);
  await action.finish();
  await assert.rejects(action.save(() => {calls++; return {};}), /single-use/);
  assert.equal(calls, 1);
});

test('missing clock evidence preserves one actual product operation and never claims a joined paint', async () => {
  const {transaction: action} = transaction({async captureClock() {throw Error('clock unavailable');}});
  let calls = 0;
  const saved = await action.save(() => {calls++; return {saved: true};});
  assert.equal(saved.nativePresentationBracket.status, 'unavailable');
  await action.observeUpdated(saved);
  const result = await action.finish();
  assert.equal(calls, 1); assert.equal(result.join, null); assert.equal(result.qualification, false);
  assert.ok(result.missing.includes('native-save-clock-or-baseline-unavailable'));
});

test('target wait uses the actual private after-clock before closure and rejects a replaced bracket', async () => {
  const {transaction: action, calls} = transaction();
  const saved = await action.save(() => ({saved: true}));
  const altered = structuredClone(saved); altered.nativePresentationBracket.after.mach = '0';
  await assert.rejects(action.observeUpdated(altered), /replaced/);
  await action.observeUpdated(saved);
  assert.equal(calls[2].options.minimumDisplayTimeMach, '20');
  assert.equal(calls.includes('stop'), false);
  await action.finish();
  assert.equal(calls.at(-1), 'stop');
});

test('closure and returned evidence are detached and repeated finish does not stop twice', async () => {
  const {transaction: action, binding, calls} = transaction();
  binding.config.expectedBrowserPid = 999;
  binding.build.receiptPath = '/substituted';
  const saved = await action.save(() => ({})); await action.observeUpdated(saved);
  const first = await action.finish();
  assert.equal(first.binding.config.expectedBrowserPid, 123);
  assert.equal(first.binding.build.receiptPath, '/original/build.json');
  first.binding.config.expectedBrowserPid = 456;
  const second = await action.finish();
  assert.equal(second.binding.config.expectedBrowserPid, 123);
  assert.equal(calls.filter(value => value === 'stop').length, 1);
});

test('failed closure keeps owned process failure evidence without a pixel or timing claim', async () => {
  const {transaction: action} = transaction({async stop() {const error = Error('drain failed'); error.windowServerProcess = {pid: 123, closed: false}; throw error;}});
  const saved = await action.save(() => ({})); await action.observeUpdated(saved);
  const result = await action.finish();
  assert.deepEqual(result.failedProcess, {pid: 123, closed: false});
  assert.equal(result.evidence, null); assert.equal(result.join, null);
  assert.ok(result.missing.includes('native-capture-closure-unavailable'));
});

test('frozen product exceptions are preserved and cannot be followed by a second save', async () => {
  const {transaction: action} = transaction();
  const failure = Object.freeze(Error('product failure'));
  await assert.rejects(action.save(() => {throw failure;}), error => error === failure);
  await assert.rejects(action.save(() => ({})), /single-use/);
  await action.finish();
});

test('an observed upper bound permits operational continuation only within the ceiling, without exact or physical timing claims', () => {
  const value = {kind: 'hmr-windowserver-observation-1', qualification: false, missing: [], failures: [], failedProcess: null,
    evidence: {manifest: {}, process: {}}, join: {kind: 'hmr-windowserver-pixel-join-1', status: 'observed', endpoint: 'WindowServer-presented-pixels',
      ceilingAssessment: 'upper-bound-within-ceiling', ceilingMs: 500, firstCorrectPaintUpperBoundMs: 500,
      firstCorrectPaintExactMs: null, firstCorrectPaintLowerBoundMs: null, physicalScanout: 'unavailable', displaySlotCoverage: 'unavailable', qualification: false}};
  assert.equal(hmrWindowServerCeilingObserved(value), true);
  for (const mutate of [v => {v.join.firstCorrectPaintUpperBoundMs = 500.001;}, v => {v.join.firstCorrectPaintExactMs = 499;},
    v => {v.join.physicalScanout = 'proven';}, v => {v.missing.push('incomplete');}, v => {v.failures.push({message: 'drain failed'});},
    v => {v.failedProcess = {closed: false};}, v => {v.evidence = null;}, v => {v.join.qualification = true;}]) {
    const changed = structuredClone(value); mutate(changed); assert.equal(hmrWindowServerCeilingObserved(changed), false);
  }
});

test('cancellation retains failed native cleanup and the original abort reason', async () => {
  const controller = new AbortController(), aborted = Object.freeze(Error('campaign cancelled'));
  controller.abort(aborted);
  const cleanup = Error('owned process drain failed'); cleanup.windowServerProcess = {pid: 123, closed: false};
  await assert.rejects(drainHmrCancellation({async stop() {throw cleanup;}}, controller.signal), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], aborted); assert.equal(error.errors[1], cleanup);
    assert.deepEqual(error.windowServerProcess, {pid: 123, closed: false}); return true;
  });
  await assert.rejects(drainHmrCancellation({async stop() {}}, controller.signal), error => error === aborted);
});

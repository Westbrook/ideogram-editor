import test from 'node:test';
import assert from 'node:assert/strict';
import {textNativeConfiguration, bracketTextAction, createTextWindowServerTransaction} from '../../tooling/qualification/campaigns/windowserver-text-actions.mjs';
import {TEXT_INPUT_PROFILE, textInputDescriptor, textSessionNativeId} from '../../tooling/qualification/campaigns/browser-text-input.mjs';

const runtime = () => ({engine: 'chromium', version: 'test', revision: 'test', browserPid: 123, headless: false,
  executableIdentity: {sha256: 'a'.repeat(64)}, fixtureSeal: {sha256: 'b'.repeat(64)}, viewport: {width: 1440, height: 900}, deviceScaleFactor: 2});
const pin = name => ({path: '/synthetic/' + name, bytes: 20, sha256: 'a'.repeat(64)});
const selection = () => ({kind: 'windowserver-text-actions-configuration-1', storageFormat: 'rfc1951-previous-roi-1',
  build: {receiptPath: '/synthetic/build.json', receiptSha256: 'a'.repeat(64)}, oracle: {path: '/synthetic/oracle.json', sha256: 'a'.repeat(64),
    storage: {kind: 'rfc1951-oracle-pixels-1', index: pin('index.json'), container: pin('pixels.bin'), review: pin('review.record')}},
  displayID: 1, roi: {x: 0, y: 0, width: 1, height: 2}, evidenceAllocation: pin('allocation.json'),
  evidenceReservation: {bytes: 100000000, nativeArtifactBytes: 50000000, trace: {bytes: 10000, files: 2, directories: 1},
    oracle: {bytes: 10000, files: 4, directories: 1}, control: {bytes: 10000, files: 3, directories: 1}}});
const descriptor = () => textInputDescriptor({sessionId: 'text-test', actionId: 'IText-001', stepId: 'focus'});
const config = () => textNativeConfiguration(selection(), runtime()).config;

test('text selection uses only explicit schema4 and unchanged text profile', () => {
  const result = textNativeConfiguration(selection(), runtime());
  assert.equal(result.config.schemaVersion, 4); assert.equal(result.config.profile, TEXT_INPUT_PROFILE);
  assert.equal(result.config.expectedBrowserPid, 123); assert.equal(result.selection.evidenceReservation.bytes, 100000000);
});
test('generic selection and implicit storage cannot select text native protocol', () => {
  for (const mutate of [v => {v.kind = 'windowserver-generic-actions-configuration-2';}, v => {delete v.storageFormat;},
    v => {delete v.evidenceReservation.nativeArtifactBytes;}, v => {delete v.oracle.storage.review;}]) {
    const value = selection(); mutate(value); assert.throws(() => textNativeConfiguration(value, runtime()));
  }
});
test('text native bracket preserves actual schema4 ACKs and dispatches once', async () => {
  let calls = 0, ticks = 0;
  const result = await bracketTextAction({descriptor: descriptor(), run: async () => {calls++; return 7;},
    captureClock: async id => ({schemaVersion: 4, event: 'clock', id, mach: String(++ticks)})});
  assert.equal(calls, 1); assert.equal(result.value, 7); assert.equal(result.bracket.status, 'complete');
  assert.equal(result.bracket.before.schemaVersion, 4);
});
test('generic schema3 ACKs do not qualify a text bracket', async () => {
  let calls = 0;
  const result = await bracketTextAction({descriptor: descriptor(), run: async () => {calls++;},
    captureClock: async id => ({schemaVersion: 3, event: 'clock', id, mach: '1'})});
  assert.equal(calls, 1); assert.equal(result.bracket.status, 'unavailable');
});
test('clock failure cannot replace a primitive product exception or repeat input', async () => {
  let calls = 0;
  await assert.rejects(bracketTextAction({descriptor: descriptor(), run: async () => {calls++; throw 'actual-product-error';},
    captureClock: async () => {throw Error('clock');}}), value => value === 'actual-product-error');
  assert.equal(calls, 1);
});
test('text transaction rejects another profile even with copied protocol flags', () => {
  assert.throws(() => createTextWindowServerTransaction({sessionId: 'text-test', config: {...config(), profile: 'interaction-100-2400-60hz-60s-1'}}));
});
test('start and end retain exact text anchors and cannot be repeated', async () => {
  const ids = [], display = {synthetic: true};
  const transaction = createTextWindowServerTransaction({sessionId: 'text-test', config: config(), oracle: {display},
    startCapture: async () => ({ready: {display}, captureClock: async id => {ids.push(id); return {schemaVersion: 4, event: 'clock', id, mach: String(ids.length)};}})});
  const begin = await transaction.start(), end = await transaction.end();
  assert.equal(begin.boundary, 'begin'); assert.equal(end.boundary, 'end');
  assert.deepEqual(ids, [textSessionNativeId('text-test') + '-win-before', textSessionNativeId('text-test') + '-win-after']);
  await assert.rejects(transaction.start()); await assert.rejects(transaction.end());
});
test('native startup failure preserves product dispatch and volume failure evidence', async () => {
  let calls = 0;
  const error = Object.assign(Error('volume full'), {evidenceVolumeStatus: 'FAIL', sessionEvidenceAdmission: {status: 'FAIL'}});
  const transaction = createTextWindowServerTransaction({sessionId: 'text-test', config: config(), binding: {textAttempt: {textFixture: {}}},
    startCapture: async () => {throw error;}});
  assert.equal((await transaction.start()).status, 'unavailable');
  const result = await transaction.hook({descriptor: descriptor(), run: async () => {calls++; return 8;}});
  assert.equal(calls, 1); assert.equal(result.value, 8); assert.equal(result.bracket.status, 'unavailable');
  const stopped = await transaction.finish({result: {}, actionCompleted: false});
  assert.equal(stopped.evidenceVolumeStatus, 'FAIL'); assert.deepEqual(stopped.evidenceAdmission, {status: 'FAIL'});
  assert.equal(stopped.qualification, false);
});
test('hook ledger rejects a duplicate descriptor before another product action', async () => {
  const display = {}, transaction = createTextWindowServerTransaction({sessionId: 'text-test', config: config(), oracle: {display},
    startCapture: async () => ({ready: {display}, captureClock: async id => ({schemaVersion: 4, event: 'clock', id, mach: '1'})})});
  await transaction.start(); let calls = 0;
  const request = {descriptor: descriptor(), run: async () => {calls++; return 1;}};
  await transaction.hook(request); await assert.rejects(transaction.hook(request)); assert.equal(calls, 1);
});
test('final anchor starts one native stop before long trace drain without awaiting replay', async () => {
  let calls = 0, release;
  const stopped = new Promise(resolve => {release = resolve;}), display = {};
  const transaction = createTextWindowServerTransaction({sessionId: 'text-test', config: config(), oracle: {display}, binding: {textAttempt: {textFixture: {}}},
    startCapture: async () => ({ready: {display}, captureClock: async id => ({schemaVersion: 4, event: 'clock', id, mach: '1'}), stop: () => {calls++; return stopped;}})});
  await transaction.start(); assert.equal((await transaction.end()).status, 'complete'); assert.equal(calls, 1);
  const first = transaction.finish({result: {}, actionCompleted: false}); release({manifest: {path: 'synthetic'}, process: {path: 'synthetic'}});
  const receipt = await first, repeated = await transaction.finish({result: {}, actionCompleted: false});
  assert.equal(calls, 1); assert.deepEqual(receipt, repeated); assert.equal(receipt.evidence.manifest.path, 'synthetic');
});
test('memoized early stop retains falsy rejection without a retry', async () => {
  let calls = 0; const display = {};
  const transaction = createTextWindowServerTransaction({sessionId: 'text-test', config: config(), oracle: {display}, binding: {textAttempt: {textFixture: {}}},
    startCapture: async () => ({ready: {display}, captureClock: async id => ({schemaVersion: 4, event: 'clock', id, mach: '1'}), stop: () => {calls++; return Promise.reject(null);}})});
  await transaction.start(); await transaction.end();
  const receipt = await transaction.finish({result: {}, actionCompleted: false});
  assert.equal(calls, 1); assert.ok(receipt.missing.includes('text-native-closure-unavailable'));
  assert.ok(receipt.failures.some(error => error.message === 'null'));
});

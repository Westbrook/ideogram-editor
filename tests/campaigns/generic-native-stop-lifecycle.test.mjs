import test from 'node:test';
import assert from 'node:assert/strict';
import {createGenericWindowServerTransaction} from '../../tooling/qualification/campaigns/windowserver-generic-actions.mjs';

function fixture(stop, {clockFailure = false, schemaVersion = 3} = {}) {
  const order = [], display = {}, config = {schemaVersion, ...(schemaVersion === 3 ? {storageFormat: 'rfc1951-previous-roi-1'} : {})};
  const transaction = createGenericWindowServerTransaction({sessionId: 'generic-stop', config, oracle: {display}, binding: {},
    startCapture: async () => ({ready: {display}, captureClock: async id => {
      order.push(id.endsWith('-end') ? 'end-anchor' : 'begin-anchor');
      if (clockFailure && id.endsWith('-end')) throw Error('clock unavailable');
      return {schemaVersion, event: 'clock', id, mach: '1'};
    }, stop: () => {order.push('native-stop'); return stop();}})});
  return {order, transaction};
}

test('both explicit protocols stop after end anchor and before raw trace drain without awaiting replay', async () => {
  for (const schemaVersion of [2, 3]) {
    let release, calls = 0;
    const replay = new Promise(resolve => {release = resolve;});
    const {order, transaction} = fixture(() => {calls++; return replay;}, {schemaVersion});
    await transaction.start(); assert.equal((await transaction.end()).status, 'complete'); order.push('raw-trace-drain');
    assert.deepEqual(order, ['begin-anchor', 'end-anchor', 'native-stop', 'raw-trace-drain']);
    const finishing = transaction.finish({result: {}, actionCompleted: false});
    release({manifest: {path: 'synthetic-manifest'}, process: {path: 'synthetic-process'}});
    const receipt = await finishing, repeated = await transaction.finish({result: {}, actionCompleted: false});
    assert.equal(calls, 1); assert.deepEqual(receipt, repeated); assert.equal(receipt.evidence.manifest.path, 'synthetic-manifest');
  }
});
test('early stop preserves primitive/falsy failure through final closure without retry', async () => {
  for (const failure of [null, false, 0, 'stop-failed']) {
    let calls = 0; const {transaction} = fixture(() => {calls++; return Promise.reject(failure);});
    await transaction.start(); await transaction.end();
    const receipt = await transaction.finish({result: {}, actionCompleted: false});
    assert.equal(calls, 1); assert.ok(receipt.missing.includes('generic-native-closure-unavailable'));
    assert.ok(receipt.failures.some(error => error.message === String(failure)));
  }
});
test('failed final anchor still starts cleanup and keeps the missing clock', async () => {
  let calls = 0; const {transaction} = fixture(async () => {calls++; return {manifest: {}, process: {}};}, {clockFailure: true});
  await transaction.start(); assert.equal((await transaction.end()).status, 'unavailable');
  const receipt = await transaction.finish({result: {}, actionCompleted: false});
  assert.equal(calls, 1); assert.ok(receipt.missing.includes('generic-native-session-end-unavailable'));
});
test('failed action cleanup without normal end still stops exactly once', async () => {
  let calls = 0; const {transaction} = fixture(async () => {calls++; return {manifest: {}, process: {}};});
  await transaction.start(); const first = await transaction.finish({result: {}, actionCompleted: false});
  const repeated = await transaction.finish({result: {}, actionCompleted: false});
  assert.equal(calls, 1); assert.deepEqual(first, repeated); assert.ok(first.missing.includes('generic-product-session-not-completed'));
});

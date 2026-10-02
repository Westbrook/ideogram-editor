import test from 'node:test';
import assert from 'node:assert/strict';
import {genericNativeConfiguration, bracketGenericAction, bracketGenericLosslessAction, createGenericWindowServerTransaction} from '../../tooling/qualification/campaigns/windowserver-generic-actions.mjs';
import {joinGenericActionPixels, joinGenericActionLosslessPixels} from '../../tooling/qualification/campaigns/generic-action-oracle.mjs';
import {genericRawFeedbackSelection} from '../../tooling/qualification/campaigns/browser.mjs';

const pin = name => ({path: '/synthetic/' + name, bytes: 20, sha256: 'a'.repeat(64)});
const runtime = () => ({engine: 'chromium', version: 'test', revision: 'test', browserPid: 123, headless: false,
  executableIdentity: {sha256: 'a'.repeat(64)}, fixtureSeal: {sha256: 'b'.repeat(64)}, viewport: {width: 1440, height: 900}, deviceScaleFactor: 2});
const descriptor = () => ({schemaVersion: 1, sessionId: 'input-test', actionSequence: 0, family: 'stroke', specimenId: 'stroke-000', sampleIndex: 0, type: 'pointerdown', x: 1, y: 2});
const selection = () => ({kind: 'windowserver-generic-actions-configuration-2', storageFormat: 'rfc1951-previous-roi-1',
  build: {receiptPath: '/synthetic/build.json', receiptSha256: 'a'.repeat(64)},
  oracle: {path: '/synthetic/oracle.json', sha256: 'a'.repeat(64), storage: {kind: 'rfc1951-oracle-pixels-1', index: pin('index.json'), container: pin('pixels.bin'), review: pin('review.record')}},
  displayID: 1, roi: {x: 0, y: 0, width: 1, height: 2}, evidenceAllocation: pin('allocation.json'),
  evidenceReservation: {bytes: 100000000, nativeArtifactBytes: 50000000, trace: {bytes: 10000, files: 2, directories: 1},
    oracle: {bytes: 10000, files: 4, directories: 1}, control: {bytes: 10000, files: 3, directories: 1}}});

test('schema3 selection requires explicit native and independent oracle storage', () => {
  const result = genericNativeConfiguration(selection(), runtime());
  assert.equal(result.config.schemaVersion, 3); assert.equal(result.config.storageFormat, 'rfc1951-previous-roi-1');
  assert.equal(result.selection.oracle.storage.kind, 'rfc1951-oracle-pixels-1');
});
test('schema3 selection cannot silently infer codec or native allowance', () => {
  for (const mutate of [v => {delete v.storageFormat;}, v => {v.storageFormat = 'gzip';},
    v => {delete v.evidenceReservation.nativeArtifactBytes;}, v => {delete v.oracle.storage;}, v => {v.oracle.storage.kind = 'current-capture-pixels';}]) {
    const value = selection(); mutate(value); assert.throws(() => genericNativeConfiguration(value, runtime()));
  }
});
test('schema2 selection remains explicit and cannot accept lossless fields', () => {
  const value = selection(); value.kind = 'windowserver-generic-actions-configuration-1';
  assert.throws(() => genericNativeConfiguration(value, runtime()));
  delete value.storageFormat; delete value.oracle.storage; delete value.evidenceReservation.nativeArtifactBytes;
  assert.equal(genericNativeConfiguration(value, runtime()).config.schemaVersion, 2);
});
test('schema3 bracket retains real schema3 ACKs and dispatches once', async () => {
  let calls = 0, count = 0;
  const result = await bracketGenericLosslessAction({descriptor: descriptor(), run: async () => {calls++; return 7;},
    captureClock: async id => ({schemaVersion: 3, event: 'clock', id, mach: String(++count)})});
  assert.equal(calls, 1); assert.equal(result.value, 7); assert.equal(result.bracket.status, 'complete');
});
test('a clock from the other protocol cannot make a complete bracket', async () => {
  for (const [hook, schemaVersion] of [[bracketGenericLosslessAction, 2], [bracketGenericAction, 3]]) {
    let calls = 0;
    const result = await hook({descriptor: descriptor(), run: async () => {calls++;}, captureClock: async id => ({schemaVersion, event: 'clock', id, mach: '1'})});
    assert.equal(calls, 1); assert.equal(result.bracket.status, 'unavailable');
  }
});
test('schema3 clock failure preserves a primitive product exception without retry', async () => {
  let calls = 0;
  await assert.rejects(bracketGenericLosslessAction({descriptor: descriptor(), run: async () => {calls++; throw 'product-failure';}, captureClock: async () => {throw Error('clock');}}), value => value === 'product-failure');
  assert.equal(calls, 1);
});
test('copied/public objects cannot enter either private native join route', () => {
  for (const join of [joinGenericActionPixels, joinGenericActionLosslessPixels]) assert.throws(() => join({kind: 'verified', schemaVersion: 3, qualification: true}));
});
test('transaction rejects unsupported or implicit schema3 format', () => {
  assert.throws(() => createGenericWindowServerTransaction({sessionId: 'input-test', config: {schemaVersion: 4}}));
  assert.throws(() => createGenericWindowServerTransaction({sessionId: 'input-test', config: {schemaVersion: 3}}));
});
test('raw trace scope token with colon is rejected before collector mismatch', () => {
  assert.throws(() => genericRawFeedbackSelection({ownership: {kind: 'owned-isolated-synthetic-browser-1', admittedBy: 'root',
    owned: true, isolated: true, syntheticOnly: true, sessionOwned: true, browserInstanceId: 'scope:invalid'}}, runtime(), 123), /selection/);
});

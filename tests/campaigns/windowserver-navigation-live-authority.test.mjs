import test from 'node:test';
import assert from 'node:assert/strict';
import {isNavigationNativeEvidencePath, readVerifiedNavigationBounds, navigationWindowServerMeasurement,
  verifyLiveNavigationWindowServerEvidence, verifyNavigationWindowServerEvidence, startNavigationWindowServerCapture}
  from '../../tooling/qualification/campaigns/windowserver-navigation-verification.mjs';

// These objects are invented protocol-shaped metadata. No browser, native
// executable, collector, build, or display is launched by these tests, and
// none of the objects can acquire the private live supervisor ownership seal.
const cell = {id: 'H1/chromium-W0-ready', jobId: 'H1', host: 'H', kind: 'navigation', operation: 'navigation.ready', workload: 'W0', parameters: {browser: 'chromium'}};
const sample = {cache: 'cold', ordinal: 1, prime: false};
const observation = {kind: 'navigation-windowserver-observation-1', qualification: false, navigationNonce: 'a'.repeat(48), nativeId: 'nv-' + 'a'.repeat(48),
  joins: {shell: {status: 'observed', upperBoundMs: 10}, canvas: {status: 'observed', upperBoundMs: 20}}, missing: [], failures: []};
const rule = {budgetId: 'R05', name: 'R05UsableCanvasColdMs', unit: 'ms', cache: 'cold', ceiling: 4000};

test('navigation proof readers reject copied, serialized and asserted proof metadata', () => {
  for (const proof of [undefined, null, {}, Object.freeze({kind: 'verified-navigation-windowserver-bounds-1', qualification: false}),
    {verified: true, owned: true, value: {shell: {upperBoundMs: 10}, canvas: {upperBoundMs: 20}}}]) {
    assert.equal(readVerifiedNavigationBounds(proof, observation, {cell, sample}), null);
    const row = navigationWindowServerMeasurement({cell, sample, rule, observation, proof});
    assert.equal(Object.hasOwn(row, 'measurement'), false);
    assert.match(row.reason, /independently replayed/);
  }
});

test('live navigation rejects arbitrary capture parser results before opening any paths', async () => {
  const fake = {capture: Object.freeze({kind: 'verified-windowserver-capture-1'}), manifest: {path: '/does-not-exist/manifest.json'}, process: {outcome: 'CAPTURE_REPLAYED'}};
  for (const captures of [undefined, {}, {anchor: fake, shell: fake, canvas: fake},
    {anchor: structuredClone(fake), shell: structuredClone(fake), canvas: structuredClone(fake)}]) {
    assert.equal(await verifyLiveNavigationWindowServerEvidence({cell, sample, observation, actionCompleted: true,
      output: '/does-not-exist', captures, invocation: {workerProcessIdentity: {pid: process.pid}}}), null);
  }
});

test('navigation authority is limited to the original H1 Chromium W0/W1 scope and real scheduled starts', async () => {
  for (const patch of [{id: 'H2/chromium-W0-ready'}, {host: 'C'}, {operation: 'portable.reopen'}, {kind: 'audit'},
    {workload: 'WXn'}, {parameters: {browser: 'firefox'}}]) {
    assert.equal(await verifyLiveNavigationWindowServerEvidence({cell: {...cell, ...patch}, sample, observation, actionCompleted: true}), null);
    assert.equal(await verifyNavigationWindowServerEvidence({cell: {...cell, ...patch}, attempt: {...sample, result: {nativeNavigation: observation}}}), null);
  }
  for (const patch of [{cache: 'single'}, {ordinal: 0}, {ordinal: 1.5}, {prime: undefined}]) {
    assert.equal(await verifyLiveNavigationWindowServerEvidence({cell, sample: {...sample, ...patch}, observation, actionCompleted: true}), null);
  }
  assert.equal(await verifyLiveNavigationWindowServerEvidence({cell, sample, observation, actionCompleted: false}), null);
});

test('native raw retention includes exactly the finite navigation capture and oracle byte families', () => {
  const nonce = 'b'.repeat(48);
  for (const stage of ['anchor', 'shell', 'canvas']) {
    for (const path of ['stdout.ndjson', 'capture/frames.ndjson', 'capture/frame-1.bgra', 'build-evidence/collector.swift', 'build-evidence/windowserver-capture']) {
      assert.equal(isNavigationNativeEvidencePath('group/native-nav-' + nonce + '-' + stage + '/' + path), true);
    }
  }
  for (const endpoint of ['shell', 'canvas']) for (const file of ['before.bgra', 'after.bgra']) {
    assert.equal(isNavigationNativeEvidencePath('group/oracle-nav-' + nonce + '-' + endpoint + '/' + file), true);
  }
  for (const path of ['native-nav-' + nonce + '-other/capture/frame-1.bgra', 'native-nav-' + nonce + '-shell/capture/frame-0.bgra',
    'native-nav-' + nonce + '-shell/capture/frame-1.png', 'native-nav-' + nonce.slice(1) + '-shell/stdout.ndjson',
    'oracle-nav-' + nonce + '-anchor/after.bgra', 'oracle-nav-' + nonce + '-canvas/other.bgra']) {
    assert.equal(isNavigationNativeEvidencePath(path), false);
  }
});

test('supervisor wrapper rejects malformed scope without launching a native capture', async () => {
  await assert.rejects(startNavigationWindowServerCapture(null), /options are required/);
  await assert.rejects(startNavigationWindowServerCapture({navigationBinding: {stage: 'replacement', navigationNonce: 'a'.repeat(48)}}),
    /pinned Node runtime|exact current worker and navigation binding/);
});

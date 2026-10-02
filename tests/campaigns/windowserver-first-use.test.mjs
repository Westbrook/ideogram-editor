import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createFirstUseWindowServerTransaction, firstUseEnvironmentBinding, nativeFirstUseConfiguration, prepareFirstUseWindowServer, validateFirstUseOracle} from '../../tooling/qualification/campaigns/windowserver-first-use.mjs';
import {discreteInputDescriptor, runDiscreteInputStep} from '../../tooling/qualification/campaigns/browser-discrete-input.mjs';
import {firstUseNativeActionId} from '../../tooling/qualification/campaigns/windowserver-presentation.mjs';
import {runBrowserAction} from '../../tooling/qualification/campaigns/browser-driver.mjs';

// Protocol doubles only. No native execution, real pixels, physical provenance,
// measured latency, oracle admission or private evaluator proof is created.
const hash = value => createHash('sha256').update(value).digest('hex');
const runtime = () => ({headless: false, browserPid: 321, engine: 'chromium', version: '1.2.3', revision: '123',
  executableIdentity: {sha256: 'sha256:' + 'a'.repeat(64)}, fixtureSeal: {sha256: 'b'.repeat(64)}, viewport: {width: 1440, height: 900}, deviceScaleFactor: 2});
const selection = () => ({kind: 'windowserver-first-use-configuration-1', build: {receiptPath: '/private/build/receipt.json', receiptSha256: 'c'.repeat(64)},
  oracle: {path: '/private/oracle/oracle.json', sha256: 'd'.repeat(64)}, displayID: 1, roi: {x: 10, y: 10, width: 1, height: 1}, capture: {durationMs: 5000, maxFrames: 300, maxBytes: 1200}});
const descriptor = () => discreteInputDescriptor({sessionId: 'input-test', actionId: 'first-use', stepId: 'open-panel', family: 'first-use', target: {control: 'mask-tool'}, input: {kind: 'click'}});
function raw(d) {
  return {descriptor: d, clock: 'browser-performance', timeOrigin: 100000, endedTimeOrigin: 100000, armedMs: 10, stoppedMs: 20,
    visibility: 'visible', endedVisibility: 'visible', targetConnectedAtArm: true, targetConnected: true, overflow: false,
    events: ['pointerdown', 'pointerup', 'click'].map((type, ordinal) => ({eventId: `${d.sessionId}/${d.actionId}/${d.stepId}/event-${ordinal}`,
      ordinal, type, timeStampMs: 11 + ordinal, observedMs: 11.5 + ordinal, isTrusted: true, targetMatched: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ordinal === 0 ? 1 : 0}))};
}
function lifecycle(capture, extra = {}) {
  const d = descriptor(), environment = firstUseEnvironmentBinding(runtime());
  return createFirstUseWindowServerTransaction({descriptor: d, feature: 'Mask', binding: {browser: runtime(), environment},
    capture, baseline: {sample: {ordinal: 1}}, oracleBytes: Buffer.from('{}'), oraclePixels: new Map(), oracleSha256: 'd'.repeat(64), ...extra});
}
const completed = step => ({feature: 'Mask', meaningful: true, startMs: 1, readyMs: 30, endMs: 1001, captureStoppedMs: 1001,
  observationWindowMs: 1000, windowClock: 'runner-monotonic', readyClock: 'runner-monotonic', discreteInput: {steps: [step]}});

test('native first-use selection is opt-in and bound to the actual headed owner', () => {
  assert.equal(nativeFirstUseConfiguration(undefined), null);
  const value = nativeFirstUseConfiguration(selection(), runtime()); assert.equal(value.config.expectedBrowserPid, 321);
  assert.throws(() => nativeFirstUseConfiguration(selection(), {...runtime(), headless: true}));
  assert.throws(() => nativeFirstUseConfiguration({...selection(), capture: {...selection().capture, durationMs: 999}}, runtime()));
  assert.throws(() => nativeFirstUseConfiguration({...selection(), arbitraryBinary: '/private/other'}, runtime()));
});

test('relative output is rejected before oracle reads, retention writes or native start', async () => {
  await assert.rejects(prepareFirstUseWindowServer({configuration: selection(), runtime: runtime(), feature: 'Mask', sessionId: 'input-test', output: 'relative-directory'}), /canonical owned directory/);
});

test('oracle environment is stable across fresh process IDs but changes with browser/fixture identity', () => {
  const before = firstUseEnvironmentBinding(runtime());
  assert.deepEqual(firstUseEnvironmentBinding({...runtime(), browserPid: 999}), before);
  assert.notEqual(firstUseEnvironmentBinding({...runtime(), version: '1.2.4'}).browserEnvironmentSha256, before.browserEnvironmentSha256);
  assert.notEqual(firstUseEnvironmentBinding({...runtime(), fixtureSeal: {sha256: 'e'.repeat(64)}}).fixtureSha256, before.fixtureSha256);
});

test('reviewed oracle prerequisite requires exact family, fixture, geometry and distinct before/after bytes', () => {
  const selected = selection(), environment = firstUseEnvironmentBinding(runtime());
  const pixels = new Map([['before.bgra', Buffer.from([0, 0, 0, 255])], ['after.bgra', Buffer.from([1, 1, 1, 255])]]);
  const oracle = {kind: 'first-use-panel-oracle-1', schemaVersion: 1, feature: 'Mask', subject: 'mask-controls-panel', pixelFormat: 'BGRA8',
    binding: {fixtureSha256: environment.fixtureSha256, browserEnvironmentSha256: environment.browserEnvironmentSha256}, display: {id: 1}, roi: selected.roi,
    before: {state: 'closed', bytes: 4, sha256: hash(pixels.get('before.bgra'))}, after: {state: 'open', bytes: 4, sha256: hash(pixels.get('after.bgra'))}};
  const options = {feature: 'Mask', selection: selected, environment};
  assert.equal(validateFirstUseOracle(oracle, pixels, options), true);
  for (const invalid of [{...oracle, feature: 'Adapter library'}, {...oracle, binding: {...oracle.binding, fixtureSha256: 'e'.repeat(64)}},
    {...oracle, roi: {...oracle.roi, x: 11}}, {...oracle, after: {...oracle.after, sha256: oracle.before.sha256}}]) assert.throws(() => validateFirstUseOracle(invalid, pixels, options));
});

test('hook encloses the existing click once; closure follows the public one-second result', async () => {
  const order = []; let clocks = 10;
  const capture = {ready: {windowAdmission: {windowNumber: 7}}, async captureClock(id) {order.push(id.endsWith('-before') ? 'A' : 'B'); return {schemaVersion: 1, event: 'clock', id, mach: String(++clocks)};},
    async stop() {order.push('stop'); return {manifest: {path: '/retained/manifest.json'}, process: {status: 'synthetic'}};}};
  const transaction = lifecycle(capture), d = descriptor();
  const step = await runDiscreteInputStep({descriptor: d, observer: {async begin() {order.push('arm');}, async end() {order.push('drain'); return raw(d);}}, target: {},
    async dispatch() {order.push('click');}, hook: transaction.hook});
  order.push('public-completion-and-window');
  const result = await transaction.finish({result: completed(step), actionCompleted: true});
  assert.deepEqual(order, ['A', 'arm', 'click', 'drain', 'B', 'public-completion-and-window', 'stop']);
  assert.equal(result.publicWitness.completed, true); assert.equal(result.nativeActionId, firstUseNativeActionId(d));
  assert.equal(result.join, null); assert.equal(result.qualification, false);
  await transaction.finish(); assert.equal(order.filter(value => value === 'stop').length, 1);
});

test('missing native baseline preserves one completed product input and records unavailable clock evidence', async () => {
  let calls = 0; const d = descriptor(), transaction = lifecycle(undefined, {baseline: null});
  const step = await runDiscreteInputStep({descriptor: d, observer: {async begin() {}, async end() {return raw(d);}}, target: {}, dispatch: async () => {calls++;}, hook: transaction.hook});
  const result = await transaction.finish({result: completed(step), actionCompleted: true});
  assert.equal(calls, 1); assert.equal(step.dispatchCompleted, true); assert.equal(result.bracket.status, 'unavailable');
  assert.equal(result.join, null); assert(result.missing.includes('native-first-use-join-prerequisites-unavailable'));
});

test('replaced browser input evidence and missing public completion cannot be joined', async () => {
  const d = descriptor(), transaction = lifecycle(undefined, {baseline: null});
  const step = await runDiscreteInputStep({descriptor: d, observer: {async begin() {}, async end() {return raw(d);}}, target: {}, dispatch: async () => {}, hook: transaction.hook});
  const altered = structuredClone(step); altered.inputEvidence.events[0].timeStampMs++;
  const result = await transaction.finish({result: completed(altered), actionCompleted: false});
  assert(result.missing.includes('first-use-browser-input-binding-unavailable'));
  assert(result.missing.includes('public-first-use-completion-unavailable')); assert.equal(result.join, null);
});

test('native closure failure retains the product result without manufacturing a pixel join', async () => {
  const capture = {async stop() {throw Error('native stop');}}, transaction = lifecycle(capture, {baseline: null}), d = descriptor();
  const step = await runDiscreteInputStep({descriptor: d, target: {}, dispatch: async () => {}, hook: transaction.hook});
  const result = await transaction.finish({result: completed(step), actionCompleted: true});
  assert.equal(step.dispatchCompleted, true); assert.equal(result.publicWitness.completed, true);
  assert(result.missing.includes('native-first-use-capture-closure-unavailable')); assert.equal(result.join, null);
});

test('cancellation during a native hook prevents a later first-use click', async () => {
  const controller = new AbortController(); let clicks = 0;
  const page = {async evaluate() {throw Error('no observer');}, getByRole() {return {async click() {clicks++;}};}};
  await assert.rejects(runBrowserAction({page, cell: {operation: 'interaction.first-use', parameters: {feature: 'mask'}}, signal: controller.signal,
    services: {discreteInputSessionId: 'input-test', async discreteInputHook({run}) {controller.abort(Error('cancelled')); return {value: await run(), bracket: {}};}}}), /cancelled/);
  assert.equal(clicks, 0);
});

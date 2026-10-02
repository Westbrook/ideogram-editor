import test from 'node:test';
import assert from 'node:assert/strict';
import {captureFirstUseWindowAnchor, createFirstUseWindowServerTransaction, firstUseEnvironmentBinding} from '../../tooling/qualification/campaigns/windowserver-first-use.mjs';
import {discreteInputDescriptor, runDiscreteInputStep} from '../../tooling/qualification/campaigns/browser-discrete-input.mjs';
import {firstUseNativeActionId} from '../../tooling/qualification/campaigns/windowserver-presentation.mjs';
import {runBrowserAction} from '../../tooling/qualification/campaigns/browser-driver.mjs';

// Source-authored protocol cases only. None has been executed for this packet.
// Clock ACKs are doubles, never hardware/native timing or evaluator authority.
const descriptor = () => discreteInputDescriptor({sessionId: 'input-ready-test', actionId: 'first-use', stepId: 'open-panel', family: 'first-use', target: {control: 'mask-tool'}, input: {kind: 'click'}});
const runtime = {headless: false, browserPid: 321, engine: 'chromium', version: '1.2.3', revision: '123',
  executableIdentity: {sha256: 'sha256:' + 'a'.repeat(64)}, fixtureSeal: {sha256: 'b'.repeat(64)}, viewport: {width: 1440, height: 900}, deviceScaleFactor: 2};
function input(d) {
  return {descriptor: d, clock: 'browser-performance', timeOrigin: 100000, endedTimeOrigin: 100000, armedMs: 10, stoppedMs: 20,
    visibility: 'visible', endedVisibility: 'visible', targetConnectedAtArm: true, targetConnected: true, overflow: false,
    events: ['pointerdown', 'pointerup', 'click'].map((type, ordinal) => ({eventId: `${d.sessionId}/${d.actionId}/${d.stepId}/event-${ordinal}`, ordinal, type,
      timeStampMs: 11 + ordinal, observedMs: 11.5 + ordinal, isTrusted: true, targetMatched: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ordinal === 0 ? 1 : 0}))};
}
async function setup({failReady = false} = {}) {
  const d = descriptor(), order = []; let tick = 10;
  const capture = {ready: {windowAdmission: {windowNumber: 7}},
    async captureClock(id) {order.push(id); if (failReady && id.endsWith('-ready')) throw Error('ready ACK failed'); return {schemaVersion: 1, event: 'clock', id, mach: String(++tick)};},
    async stop() {order.push('stop'); return {};}};
  const anchor = await captureFirstUseWindowAnchor(capture, d);
  const transaction = createFirstUseWindowServerTransaction({descriptor: d, feature: 'Mask', capture, baseline: {sample: {ordinal: 1}}, windowStartAnchor: anchor,
    binding: {browser: runtime, environment: firstUseEnvironmentBinding(runtime)}});
  const step = await runDiscreteInputStep({descriptor: d, target: {}, observer: {async begin() {}, async end() {return input(d);}}, dispatch: async () => {order.push('click');}, hook: transaction.hook});
  return {d, order, anchor, transaction, step};
}
function readyValue(d, {late = false} = {}) {
  const now = performance.now(), startMs = late ? Math.max(0, now - 2000) : now;
  return {descriptor: d, readyMs: now, startMs, endMs: startMs + 1000, clock: 'runner-monotonic'};
}
function completed(step, caller, witness) {
  return {feature: 'Mask', meaningful: true, startMs: caller.startMs, readyMs: caller.readyMs, endMs: caller.endMs,
    captureStoppedMs: Math.max(caller.endMs, performance.now()), observationWindowMs: 1000, windowClock: 'runner-monotonic', readyClock: 'runner-monotonic',
    nativeReadiness: witness, discreteInput: {steps: [step]}};
}

test('window lower anchor precedes input ACKs and keeps the existing native ID within64characters', async () => {
  const {d, order, anchor, transaction} = await setup(); const id = firstUseNativeActionId(d);
  assert.deepEqual(order, [id + '-win-before', id + '-before', 'click', id + '-after']);
  assert.equal(anchor.relation, 'ack-before-driver-window-start'); assert.equal(anchor.ack.mach, '11'); assert(anchor.ack.id.length <= 64);
  await transaction.finish();
});

test('window anchor refuses another ACK identity and numeric or overflow native ticks', async () => {
  const d = descriptor();
  for (const change of [{id: 'different'}, {mach: 1}, {mach: '18446744073709551616'}]) {
    const capture = {async captureClock(id) {return {schemaVersion: 1, event: 'clock', id, mach: '1', ...change};}};
    await assert.rejects(captureFirstUseWindowAnchor(capture, d), /anchor ACK differs/);
  }
});

test('ready ACK follows actual input and retains caller/window/request/receive fields without conversion', async () => {
  const {d, order, anchor, transaction, step} = await setup(), caller = readyValue(d);
  const witness = await transaction.ready(caller);
  assert.equal(witness.status, 'complete'); assert.equal(witness.ack.id, firstUseNativeActionId(d) + '-ready');
  assert(witness.requestRunnerMs >= caller.readyMs); assert(witness.receivedRunnerMs >= witness.requestRunnerMs);
  assert.equal(witness.windowStartMs, caller.startMs); assert.equal(witness.windowEndMs, caller.endMs);
  await assert.rejects(transaction.ready(caller), /one ready call/);
  const result = await transaction.finish({result: completed(step, caller, witness), actionCompleted: true});
  assert.equal(result.readinessBindingMatched, true); assert.deepEqual(result.windowStartAnchor, anchor);
  assert.deepEqual(result.readinessWitness, witness); assert.equal(result.join, null); assert.equal(result.qualification, false);
  assert.equal(order.filter(value => value.endsWith('-ready')).length, 1);
  assert.equal(Object.hasOwn(result, 'readyLatencyMs'), false);
});

test('ready ACK failure preserves completed input, original window and explicit unavailable evidence', async () => {
  const {d, transaction, step} = await setup({failReady: true}), caller = readyValue(d);
  const witness = await transaction.ready(caller);
  assert.equal(witness.status, 'unavailable'); assert.equal(witness.ack, null); assert.equal(witness.windowEndMs, caller.endMs);
  const result = await transaction.finish({result: completed(step, caller, witness), actionCompleted: true});
  assert.equal(step.dispatchCompleted, true); assert.equal(result.publicWitness.completed, true);
  assert.equal(result.readinessBindingMatched, false); assert(result.missing.includes('native-first-use-ready-ack-unavailable'));
});

test('replaced ready witness cannot bind to the actual retained native ACK', async () => {
  const {d, transaction, step} = await setup(), caller = readyValue(d), witness = await transaction.ready(caller);
  const replaced = structuredClone(witness); replaced.ack.mach = '9999';
  const result = await transaction.finish({result: completed(step, caller, replaced), actionCompleted: true});
  assert.equal(result.readinessBindingMatched, false); assert(result.missing.includes('native-first-use-readiness-binding-unavailable'));
  assert.equal(result.readinessWitness.ack.mach, witness.ack.mach);
});

test('ready service runs after awaited public controls and its failure keeps the one-second action window', async () => {
  const order = [];
  const page = {async evaluate() {throw Error('no observer');}, getByRole(role) {
    if (role === 'button') return {async click() {order.push('click');}};
    return {async waitFor() {order.push('visible');}, async isEnabled() {order.push('enabled'); return true;}};
  }};
  const value = await runBrowserAction({page, cell: {operation: 'interaction.first-use', parameters: {feature: 'mask'}}, services: {
    discreteInputSessionId: 'input-ready-test', async discreteFirstUseReady(witness) {
      order.push('native-ready'); assert.equal(witness.endMs, witness.startMs + 1000); assert(witness.readyMs >= witness.startMs); throw Error('ACK unavailable');
    },
  }});
  assert.deepEqual(order, ['click', 'visible', 'enabled', 'native-ready']);
  assert.equal(value.meaningful, true); assert.equal(value.endMs, value.startMs + 1000); assert(value.captureStoppedMs >= value.endMs);
  assert.equal(value.nativeReadiness.status, 'unavailable'); assert.equal(value.presentedMs, null);
});

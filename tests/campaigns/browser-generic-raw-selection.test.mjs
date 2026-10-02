import test from 'node:test';
import assert from 'node:assert/strict';
import {genericRawFeedbackSelection, genericRawFeedbackMissing, endGenericFeedbackSession} from '../../tooling/qualification/campaigns/browser.mjs';

// Authored only. These are synthetic selection records, never process or
// isolation proof, and do not launch a browser or raw collector.
const selection = () => ({ownership: {kind: 'owned-isolated-synthetic-browser-1', admittedBy: 'root', owned: true,
  isolated: true, syntheticOnly: true, sessionOwned: true, browserInstanceId: 'selected-fixture-1'}});
const runtime = () => ({engine: 'chromium', headless: false, browserPid: 123, executable: '/owned/chromium',
  executableIdentity: {sha256: 'sha256:' + 'a'.repeat(64)}, fixtureSeal: {sha256: 'b'.repeat(64)},
  ownedLaunch: {process: {pid: 123, startedAtIdentity: 'retained synthetic birth', executable: '/owned/chromium',
    registration: {path: '/owned/process.json', bytes: 120, sha256: 'sha256:' + 'c'.repeat(64)}},
    context: {createdBy: 'browser.newContext', freshAtLaunch: true}}});

test('raw selection is absent unless explicitly configured', () => assert.equal(genericRawFeedbackSelection(undefined), null));
test('raw selection retains exact configured scope and actual runtime separately', () => {
  const selected = selection(), actual = runtime(), result = genericRawFeedbackSelection(selected, actual, 123);
  assert.deepEqual(result.ownership, selected.ownership); assert.deepEqual(result.actualRuntime, actual);
  assert.equal(result.selectionProvenance, 'configured-campaign-local-scope-not-ownership-proof');
  selected.ownership.browserInstanceId = 'changed'; actual.browserPid = 999;
  assert.equal(result.ownership.browserInstanceId, 'selected-fixture-1'); assert.equal(result.actualRuntime.browserPid, 123);
});
test('bare fixture hashes from the actual fixture builder remain admissible', () => {
  assert.doesNotThrow(() => genericRawFeedbackSelection(selection(), runtime(), 123));
});
test('configured labels alone cannot replace missing actual launch facts', () => {
  for (const change of [value => delete value.ownedLaunch, value => delete value.ownedLaunch.process.registration,
    value => {value.ownedLaunch.context.freshAtLaunch = false;}, value => {value.ownedLaunch.process.pid = 999;},
    value => {value.ownedLaunch.process.executable = '/different';}, value => {value.fixtureSeal.sha256 = 'unverified';}]) {
    const value = runtime(); change(value); assert.throws(() => genericRawFeedbackSelection(selection(), value, 123));
  }
});
test('raw route rejects another actual browser PID, engine and headless invocation', () => {
  assert.throws(() => genericRawFeedbackSelection(selection(), runtime(), 999));
  for (const change of [{engine: 'firefox'}, {engine: 'webkit'}, {headless: true}])
    assert.throws(() => genericRawFeedbackSelection(selection(), {...runtime(), ...change}, 123));
});
test('raw scope fields cannot be silently omitted or broadened', () => {
  for (const change of [value => {value.ownership.syntheticOnly = false;}, value => {value.ownership.admittedBy = 'unselected';},
    value => {value.ownership.browserInstanceId = '../escape';}, value => {value.extra = true;}, value => {value.ownership.extra = true;}]) {
    const value = selection(); change(value); assert.throws(() => genericRawFeedbackSelection(value, runtime(), 123));
  }
});
test('an ordinary trace that ignores the selected raw option remains unavailable', () => {
  assert.deepEqual(genericRawFeedbackMissing({artifact: {path: '/synthetic/ordinary.json'}, collection: {complete: true}}), ['raw-feedback-consumer-unavailable']);
});
test('the raw successor must retain its own complete missing inventory', () => {
  assert.deepEqual(genericRawFeedbackMissing({rawFeedback: {manifest: null}}), ['raw-feedback-missing-inventory-unavailable']);
  const missing = ['unsupported-hardware-feedback'];
  assert.deepEqual(genericRawFeedbackMissing({rawFeedback: {missing}}), missing);
  assert.deepEqual(genericRawFeedbackMissing({rawFeedback: {missing: []}}), []);
});


test('generic end without selected raw feedback neither inspects observations nor stops a trace', async () => {
  const anchor = {status: 'complete'}, missing = []; let ended = 0;
  const observed = {get clock() {throw Error('Unselected observations must not be inspected');}};
  const result = await endGenericFeedbackSession({native: {end: async () => {ended++; return anchor;}},
    trace: {stop: async () => assert.fail('Unselected raw stop')}, rawFeedbackSelected: false, observed, missing});
  assert.equal(result, anchor); assert.equal(ended, 1); assert.deepEqual(missing, []);
});

test('generic end drains incomplete raw observations without inventing a cohort', async () => {
  const order = [], missing = [], anchor = {status: 'complete'};
  const result = await endGenericFeedbackSession({native: {end: async () => {order.push('native-end'); return anchor;}},
    trace: {stop: async options => {order.push('raw-stop'); assert.deepEqual(options, {});}},
    rawFeedbackSelected: true, sessionId: 'incomplete-session', observed: {actions: []}, missing});
  assert.equal(result, anchor); assert.deepEqual(order, ['native-end', 'raw-stop']);
  assert.deepEqual(missing, ['raw-feedback-original-generic-cohort-incomplete']);
});

test('generic native end rejection remains unchanged and leaves raw draining to the existing finally', async () => {
  const rejection = Error('Native end failed'), missing = []; let stops = 0;
  const trace = {stop: async options => {stops++; assert.equal(options, undefined);}};
  try {
    await assert.rejects(endGenericFeedbackSession({native: {end: async () => {throw rejection;}}, trace,
      rawFeedbackSelected: true, sessionId: 'incomplete-session', observed: null, missing}), error => error === rejection);
    assert.equal(stops, 0); assert.deepEqual(missing, []);
  } finally {await trace.stop();}
  assert.equal(stops, 1);
});

test('generic raw stop rejection is retained without replacing the native end receipt', async () => {
  const anchor = {status: 'unavailable'}, missing = [];
  const result = await endGenericFeedbackSession({native: {end: async () => anchor},
    trace: {stop: async () => {throw Error('Raw drain failed');}}, rawFeedbackSelected: true,
    sessionId: 'incomplete-session', observed: null, missing});
  assert.equal(result, anchor);
  assert.deepEqual(missing, ['raw-feedback-original-generic-cohort-incomplete', 'raw-feedback-stop-unavailable']);
});

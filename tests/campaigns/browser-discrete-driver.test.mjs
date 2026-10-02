import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionPlan, runBrowserAction, runDiscreteInteraction} from '../../tooling/qualification/campaigns/browser-driver.mjs';
import {interactionSession} from '../../tooling/qualification/campaigns/browser.mjs';

// Protocol mocks, never real browser/native execution or presentation evidence.
// This file is intended for the managed test route after owner integration.
function hookFor(order, descriptors) {
  return async ({descriptor, run}) => {
    descriptors.push(descriptor); order.push('before:' + descriptor.stepId);
    const value = await run(); order.push('after:' + descriptor.stepId);
    return {value, bracket: {actionId: descriptor.actionId, stepId: descriptor.stepId}};
  };
}

test('brush interaction inventory retains all 100 actions, including every counted undo', () => {
  const plan = interactionPlan(), counts = Object.fromEntries(['stroke', 'undo', 'pan', 'layer', 'density', 'zoom', 'theme', 'split'].map(kind => [kind, plan.filter(action => action.kind === kind).length]));
  assert.equal(plan.length, 100);
  assert.deepEqual(counts, {stroke: 20, undo: 20, pan: 10, layer: 10, density: 10, zoom: 10, theme: 10, split: 10});
  assert.equal(new Set(plan.filter(action => action.kind !== 'stroke').map(action => action.index)).size, 80);
  for (let index = 0; index < plan.length; index += 5) assert.deepEqual(plan.slice(index, index + 2).map(action => action.kind), ['stroke', 'undo']);
});

test('zoom preparation and semantic wait remain outside all three exact input substeps', async () => {
  const order = [], descriptors = [];
  const field = {async focus() {order.push('focus');}, async press(key) {order.push('press:' + key);}, async pressSequentially(text) {order.push('type:' + text);}};
  const page = {getByRole(role, options) {assert.equal(role, 'spinbutton'); assert.equal(options.name, 'Zoom percentage'); return field;},
    async waitForFunction(_predicate, zoom) {assert.equal(zoom, .125); order.push('semantic');}};
  const value = await runDiscreteInteraction(page, {kind: 'zoom', index: 10, variant: 0}, {zoomPercentages: [12.5, 25]}, {sessionId: 'input-test', hook: hookFor(order, descriptors)});
  assert.deepEqual(order, ['focus', 'before:select-all', 'press:ControlOrMeta+A', 'after:select-all', 'before:enter-value', 'type:12.5', 'after:enter-value', 'before:commit', 'press:Tab', 'after:commit', 'semantic']);
  assert.equal(value.discreteInput.steps.length, 3);
  assert.deepEqual(descriptors.map(value => value.stepId), ['select-all', 'enter-value', 'commit']);
  assert(descriptors.every(value => value.actionId === 'action-10' && value.family === 'zoom' && value.target.control === 'zoom-percentage'));
  assert.equal(value.discreteInput.status, 'INCONCLUSIVE'); // No real observer in this mock.
});

test('theme preserves Home, ArrowDown and Tab with public completion after the final bracket', async () => {
  const order = [], descriptors = []; let reads = 0;
  const field = {async count() {return 1;}, async focus() {order.push('focus');}, async press(key) {order.push('press:' + key);}, async inputValue() {order.push('value'); return reads++ ? 'light' : 'dark';}};
  const page = {getByRole(role, options) {assert.equal(role, 'combobox'); assert.equal(options.name, 'Appearance'); return field;}};
  const value = await runDiscreteInteraction(page, {kind: 'theme', index: 11, variant: 1}, {}, {sessionId: 'input-test', hook: hookFor(order, descriptors)});
  assert.deepEqual(order, ['value', 'focus', 'before:select-edge', 'press:Home', 'after:select-edge', 'before:select-light', 'press:ArrowDown', 'after:select-light', 'before:commit', 'press:Tab', 'after:commit', 'value', 'value']);
  assert.equal(value.after, 'light'); assert.equal(value.discreteInput.steps.length, 3);
});

test('driver side channel retains failed first-use input for primitive and frozen errors without replay', async () => {
  for (const failure of [undefined, Object.freeze(Error('frozen'))]) {
    let calls = 0, retained;
    const page = {async evaluate() {throw Error('observer unavailable');}, getByRole() {return {async click() {calls++; throw failure;}};}};
    let caught = false;
    try {await runBrowserAction({page, cell: {operation: 'interaction.first-use', parameters: {feature: 'mask'}}, services: {
      discreteInputSessionId: 'input-test', retainDiscreteInputFailure: value => {retained = value;},
    }});} catch (error) {caught = true; assert.equal(error, failure);}
    assert.equal(caught, true); assert.equal(calls, 1); assert.equal(retained.discreteInput.steps.length, 1);
    assert.equal(retained.discreteInput.steps[0].dispatchCompleted, false);
    assert.equal(retained.discreteInput.status, 'FAIL');
  }
});

test('session keeps full native records, observed pointer identities, 2400 points and discrete substeps', () => {
  const native = {clock: 'browser-performance', timeOrigin: 1234, events: [{type: 'pointerdown', inputMs: 1, pointerId: 7, trusted: true}]};
  const discreteInput = {kind: 'browser-discrete-action-1', steps: [{inputEvidence: {events: [{eventId: 'local/session/step/event-0', timeStampMs: 2, isTrusted: true}]}}], qualification: false};
  const actions = interactionPlan().map(action => ({...action, native, inputMs: 1, inputClock: 'browser-performance',
    ...(action.kind === 'stroke' ? {specimenId: 'stroke-' + action.index, samples: Array.from({length: 120}, (_, index) => ({index, inputMs: index + 1, pointerId: 7, trusted: true}))} : {discreteInput})}));
  const session = interactionSession({operation: 'interaction.brush', id: 'I'}, {cache: 'cold', ordinal: 1}, {actions, startMs: 0, endMs: 60000, clock: 'browser-performance', timeOrigin: 1234}, null, 'visible');
  assert.equal(session.actions.length, 100); assert.equal(session.actions.flatMap(action => action.samples ?? []).length, 2400);
  assert.equal(session.actions[0].native, native); assert.equal(session.actions[1].discreteInput, discreteInput);
  assert.equal(session.actions[0].samples[0].browserEvent.pointerId, 7);
  assert.equal(session.actions[0].samples[0].browserEvent.trusted, true);
  assert.equal(Object.hasOwn(session.actions[0].samples[0].browserEvent, 'eventId'), false);
  assert.equal(session.automation.physicalInput, false); assert.equal(session.trace.actualPresentation, false);
  assert.equal(session.actions[1].presentedMs, null);
});

test('text receipt retains its 106 actions without adding discrete collector evidence', () => {
  const session = interactionSession({operation: 'text.interaction'}, {cache: 'warm', ordinal: 1}, {actions: Array.from({length: 106}, () => ({kind: 'text', inputMs: 1})), segment: {startMs: 0, endMs: 60000}}, null, 'visible');
  assert.equal(session.actions.length, 106);
  assert(session.actions.every(action => !Object.hasOwn(action, 'discreteInput') && !Object.hasOwn(action, 'native')));
  assert.equal(Object.hasOwn(session, 'automation'), false);
});

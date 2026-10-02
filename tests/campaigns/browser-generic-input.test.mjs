import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  GENERIC_AUTOMATION, GENERIC_PROFILE, genericInteractionInventory, genericNativeActionId,
  genericPointerDescriptor, genericSessionNativeId, projectGenericInteraction, runGenericPointerDispatch, genericRawFeedbackCohort,
} from '../../tooling/qualification/campaigns/browser-generic-input.mjs';
import {discreteInputDescriptor, validateDiscreteInput} from '../../tooling/qualification/campaigns/browser-discrete-input.mjs';
import {planStrokeCoordinates} from '../../tooling/qualification/campaigns/browser-gesture-state.mjs';
import {endGenericFeedbackSession} from '../../tooling/qualification/campaigns/browser.mjs';
import {inspectR07Cohort} from '../../tooling/qualification/campaigns/display-feedback.mjs';

// AUTHORED ONLY during source staging. Synthetic protocol records exercise
// retained evidence; no browser, collector, oracle pixels, measured latency,
// physical provenance, or evaluator proof is created by these fixtures.
const SESSION = 'input-generic-test', ORIGIN = 1_800_000_000_000;
const copy = value => structuredClone(value);
const digest = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pointer = (extra = {}) => genericPointerDescriptor({schemaVersion: 1, sessionId: SESSION, actionSequence: 0,
  family: 'stroke', specimenId: 'stroke-000', sampleIndex: 0, type: 'pointerdown', x: 468, y: 308, ...extra});
const modifiers = (extra = {}) => ({control: false, meta: false, shift: false, alt: false, ...extra});
const keyDown = (keyName, extra = {}) => ({type: 'keydown', keyName, code: keyName, repeat: false, modifiers: modifiers(), ...extra});
const keyPair = keyName => [keyDown(keyName), {type: 'keyup', keyName}];

function discreteStep(requested, at) {
  const descriptor = discreteInputDescriptor(requested), operation = descriptor.input;
  let rows;
  if (operation.kind === 'click') rows = ['pointerdown', 'pointerup', 'click'].map((type, ordinal) => ({type,
    pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ordinal ? 0 : 1}));
  else if (operation.kind === 'press-sequentially') rows = [...operation.text].flatMap(keyPair);
  else if (operation.keyName === 'ControlOrMeta+A') rows = [keyDown('Meta', {modifiers: modifiers({meta: true})}),
    keyDown('A', {modifiers: modifiers({meta: true})}), {type: 'keyup', keyName: 'A'}, {type: 'keyup', keyName: 'Meta'}];
  else rows = keyPair(operation.keyName);
  const events = rows.map((row, ordinal) => ({eventId: `${descriptor.sessionId}/${descriptor.actionId}/${descriptor.stepId}/event-${ordinal}`,
    ordinal, timeStampMs: at + ordinal / 10, observedMs: at + ordinal / 10 + .01,
    isTrusted: true, targetMatched: true, ...row}));
  const raw = {descriptor, clock: 'browser-performance', timeOrigin: ORIGIN, endedTimeOrigin: ORIGIN,
    armedMs: at - .1, stoppedMs: at + rows.length / 10 + .1, visibility: 'visible', endedVisibility: 'visible',
    targetConnectedAtArm: true, targetConnected: true, overflow: false, events};
  return {dispatchCompleted: true, inputEvidence: validateDiscreteInput(raw, descriptor), nativeBracket: null,
    nativeBracketVerified: false, missing: []};
}

function publicState(values, at) {
  const box = {x: 100, y: 70, width: 800, height: 600};
  return {gesture: {clock: 'browser-performance', timeOrigin: ORIGIN, observedMs: at, box,
    viewport: {x: values.pan, y: -12, zoom: values.zoom, observedMs: at - .2},
    editor: {documentId: 'gesture_document', revision: '7', ready: true, busy: false, selected: [values.layer], observedMs: at - .1},
    tool: 'Mask', brushDiameter: 64, visibility: 'visible'},
  layout: {clock: 'browser-performance', timeOrigin: ORIGIN, observedMs: at, visibility: 'visible',
    appearance: values.appearance, densityTheme: values.density, prefersDark: false, density: values.density,
    splitter: values.splitter, boxes: {canvas: {...box}, layerTree: {x: 0, y: 70, width: 100, height: 600},
      splitter: {x: values.splitter, y: 70, width: 4, height: 600}},
    viewport: {width: 1440, height: 900, devicePixelRatio: 2}}};
}

/** Full 60-second synthetic input receipt. The authored stroke geometry is
 * independent of pixels and uses the same public coordinate plan contract. */
function fullObservation() {
  const document = {id: 'gesture_document', revision: '7', width: 1000, height: 800};
  const values = {pan: 18, zoom: .5, layer: 'image_a', appearance: 'light', density: 'comfortable', splitter: 320};
  const actions = []; let priorStroke;
  for (const [sequence, planned] of genericInteractionInventory().entries()) {
    const cycle = Math.floor(sequence / 5), position = sequence % 5, downMs = 100 + cycle * 2900;
    const at = position ? downMs + 2050 + (position - 1) * 180 : downMs;
    const before = publicState(values, at - 2);
    if (planned.kind === 'stroke') {
      const specimen = {id: 'stroke-' + String(cycle).padStart(3, '0'), brushDiameter: 64, sampleHz: 60,
        samples: Array.from({length: 120}, (_, index) => ({x: 400 + Math.min(index, 118) / 2,
          y: 300 + Math.min(index, 118) / 4, timeMs: index * 1000 / 60}))};
      const plan = planStrokeCoordinates(specimen, before.gesture, {document, eligibleLayerIds: ['image_a', 'image_b']});
      const events = plan.points.map((point, index) => ({type: index === 0 ? 'pointerdown' : index === 119 ? 'pointerup' : 'pointermove',
        inputMs: at + point.plannedOffsetMs, observedMs: at + point.plannedOffsetMs + .25,
        trusted: true, primary: true, pointerType: 'mouse', pointerId: 7, buttons: index === 119 ? 0 : 1,
        clientX: point.x, clientY: point.y}));
      const native = {clock: 'browser-performance', timeOrigin: ORIGIN, armedMs: at - 1, stoppedMs: at + 1990,
        firstInputMs: at, canvasStillConnected: true, overflow: false, cancelled: false, events};
      const geometry = events.map(event => [
        (event.clientX - plan.state.box.x - plan.state.box.width / 2 - plan.state.viewport.x) / plan.state.viewport.zoom + document.width / 2,
        (event.clientY - plan.state.box.y - plan.state.box.height / 2 - plan.state.viewport.y) / plan.state.viewport.zoom + document.height / 2,
      ]);
      const completion = {startMs: events.at(-1).observedMs + 1, detail: {schemaVersion: 1, gestureOrdinal: cycle + 1,
        pointerId: 7, inputDownMs: events[0].inputMs, inputUpMs: events.at(-1).inputMs, trusted: true,
        documentId: document.id, revision: document.revision, draftId: 'mask_draft', targetLayerId: 'image_a', targetLayerVersion: '3',
        selectedLayerId: values.layer, sampleCount: 120, operationCount: 1, geometrySha256: digest(geometry), brushDiameter: 64}};
      const samples = plan.points.map((point, index) => ({index, scheduledMs: at + 100000 + point.plannedOffsetMs,
        dispatchStartedMs: at + 100000 + point.plannedOffsetMs + .5, dispatchCompletedMs: at + 100000 + point.plannedOffsetMs + 1}));
      const pointerDispatches = plan.points.map((point, sampleIndex) => {
        const descriptor = pointer({actionSequence: sequence, specimenId: specimen.id, sampleIndex, type: events[sampleIndex].type, x: point.x, y: point.y});
        return {descriptor, nativeActionId: genericNativeActionId(descriptor), dispatchCompleted: true,
          dispatchStartedMs: samples[sampleIndex].dispatchStartedMs, dispatchCompletedMs: samples[sampleIndex].dispatchCompletedMs,
          clock: 'runner-monotonic', nativeBracket: null, nativeBracketVerified: false, automation: GENERIC_AUTOMATION, missing: []};
      });
      priorStroke = {...planned, specimenId: specimen.id, selectedLayerId: values.layer, plan, native, completion,
        pointerSchedule: {clock: 'runner-monotonic', frequencyHz: 60, samples}, pointerDispatches,
        inputMs: at, outcome: 'completed', meaningful: true, nativeState: {before, after: publicState(values, at + 1992)}};
      actions.push(priorStroke); continue;
    }
    const specs = []; let semantic;
    const add = (stepId, control, input, extra = {}) => specs.push({schemaVersion: 1, sessionId: SESSION,
      actionId: 'action-' + planned.index, stepId, family: planned.kind, target: {control, ...extra}, input});
    if (planned.kind === 'undo') {
      semantic = {draftId: 'mask_draft', gestureOrdinal: priorStroke.completion.detail.gestureOrdinal,
        beforeOperationCount: 1, afterOperationCount: 0, buttonDisabled: true, observedMs: at + 2};
      add('activate', 'mask-undo', {kind: 'click'});
    } else if (planned.kind === 'layer') {
      const old = values.layer; values.layer = old === 'image_a' ? 'image_b' : 'image_a';
      semantic = {before: old, after: values.layer};
      add('activate', 'layer-row', {kind: 'click'}, {rowIndex: values.layer === 'image_a' ? 0 : 1, layerId: values.layer});
    } else if (planned.kind === 'zoom') {
      values.zoom = planned.variant ? .5 : .25; semantic = {zoom: values.zoom};
      add('select-all', 'zoom-percentage', {kind: 'press', key: 'ControlOrMeta+A'});
      add('enter-value', 'zoom-percentage', {kind: 'press-sequentially', text: String(values.zoom * 100)});
      add('commit', 'zoom-percentage', {kind: 'press', key: 'Tab'});
    } else if (planned.kind === 'pan') {
      const old = values.pan; values.pan += planned.variant ? -10 : 10; semantic = {before: old, after: values.pan};
      add('pan', 'document-canvas', {kind: 'press', key: planned.variant ? 'ArrowLeft' : 'ArrowRight'});
    } else if (planned.kind === 'split') {
      const old = values.splitter, direction = planned.variant ? -1 : 1; values.splitter += 10 * direction;
      semantic = {before: old, after: values.splitter, direction};
      add('resize', 'request-panel-width', {kind: 'press', key: direction === 1 ? 'ArrowRight' : 'ArrowLeft'});
    } else {
      const theme = planned.kind === 'theme', field = theme ? 'appearance' : 'density', old = values[field];
      values[field] = theme ? old === 'dark' ? 'light' : 'dark' : old === 'spacious' ? 'comfortable' : 'spacious';
      semantic = {before: old, after: values[field]};
      add('select-edge', field, {kind: 'press', key: ['dark', 'spacious'].includes(values[field]) ? 'End' : 'Home'});
      if (theme && values[field] === 'light') add('select-light', field, {kind: 'press', key: 'ArrowDown'});
      add('commit', field, {kind: 'press', key: 'Tab'});
    }
    const steps = specs.map((descriptor, index) => discreteStep(descriptor, at + index * 10));
    const first = steps[0].inputEvidence.events[0], native = {clock: 'browser-performance', timeOrigin: ORIGIN,
      armedMs: at - 1, stoppedMs: at + 1, firstInputMs: first.timeStampMs, canvasStillConnected: true,
      overflow: false, cancelled: false, events: [{type: first.type, inputMs: first.timeStampMs, observedMs: first.observedMs, trusted: true}]};
    actions.push({...planned, semantic, native, outcome: 'completed', meaningful: true, inputMs: steps[0].inputEvidence.inputMs,
      discreteInput: {kind: 'browser-discrete-action-1', schemaVersion: 1, sessionId: SESSION, actionId: 'action-' + planned.index,
        family: planned.kind, steps, inputMs: steps[0].inputEvidence.inputMs, timeOrigin: ORIGIN, clock: 'browser-performance',
        status: 'PASS', missing: [], failures: [], qualification: false},
      nativeState: {before, after: publicState(values, at + 50)}});
  }
  return {clock: 'browser-performance', timeOrigin: ORIGIN, startMs: 0, endMs: 60000, captureStoppedMs: 60000,
    inputProtocol: {document, eligibleLayers: [{id: 'image_a', rowIndex: 0}, {id: 'image_b', rowIndex: 1}], zoomPercentages: [25, 50]}, actions};
}

const project = observed => projectGenericInteraction(observed, {sessionId: SESSION});
function notAccepted(observed) {let result; assert.doesNotThrow(() => {result = project(observed);}); assert.notEqual(result.status, 'PASS'); return result;}
function replaceStep(action, index, update) {
  const previous = action.discreteInput.steps[index], requested = copy(previous.inputEvidence.descriptor);
  update(requested); action.discreteInput.steps[index] = discreteStep(requested, previous.inputEvidence.events[0].timeStampMs);
}

test('fixed inventory has 100 ordered actions, 20 strokes, 80 discrete actions and 125 discrete dispatches', () => {
  const inventory = genericInteractionInventory(), counts = {};
  for (const action of inventory) counts[action.kind] = (counts[action.kind] ?? 0) + 1;
  assert.equal(inventory.length, 100);
  assert.deepEqual(counts, {stroke: 20, undo: 20, pan: 10, layer: 10, density: 10, zoom: 10, theme: 10, split: 10});
  assert.deepEqual(inventory.filter(action => action.kind === 'stroke').map(action => action.index), Array.from({length: 20}, (_, index) => index));
  assert.deepEqual(inventory.filter(action => action.kind !== 'stroke').map(action => action.index), Array.from({length: 80}, (_, index) => index));
  for (let cycle = 0; cycle < 20; cycle++) assert.deepEqual(inventory.slice(cycle * 5, cycle * 5 + 5).map(action => action.kind),
    ['stroke', 'undo', ...(cycle % 2 ? ['zoom', 'theme', 'split'] : ['pan', 'layer', 'density'])]);
  assert.equal(fullObservation().actions.filter(action => action.kind !== 'stroke').reduce((sum, action) => sum + action.discreteInput.steps.length, 0), 125);
});

test('pointer descriptor preserves sample boundaries and copies only admitted identity', () => {
  for (const [sampleIndex, type] of [[0, 'pointerdown'], [1, 'pointermove'], [118, 'pointermove'], [119, 'pointerup']]) {
    const result = pointer({sampleIndex, type, privateState: 'not-retained'});
    assert.equal(result.sampleIndex, sampleIndex); assert.equal(result.type, type); assert(Object.isFrozen(result));
    assert.equal(Object.hasOwn(result, 'privateState'), false);
  }
});

test('pointer identity rejects another action lane, invalid point index, type and coordinates', () => {
  for (const change of [{sessionId: '../escape'}, {actionSequence: 1}, {actionSequence: 100}, {actionSequence: -5},
    {sampleIndex: -1}, {sampleIndex: 120}, {sampleIndex: 1, type: 'pointerdown'}, {sampleIndex: 119, type: 'pointermove'},
    {specimenId: 'unsealed'}, {x: NaN}, {y: Infinity}, {family: 'layer'}, {schemaVersion: 2}]) assert.throws(() => pointer(change));
});

test('native correlation IDs bind the full pointer identity and session without claiming device identity', () => {
  const original = pointer(), id = genericNativeActionId(original);
  assert.equal(genericNativeActionId(copy(original)), id); assert.equal(id.length, 51);
  for (const change of [{sessionId: 'another-session'}, {actionSequence: 5}, {specimenId: 'stroke-001'},
    {sampleIndex: 1, type: 'pointermove'}, {x: original.x + 1}, {y: original.y + 1}]) assert.notEqual(genericNativeActionId(pointer(change)), id);
  assert.equal(genericSessionNativeId(SESSION), genericSessionNativeId(SESSION));
  assert.notEqual(genericSessionNativeId(SESSION), genericSessionNativeId('another-session'));
  assert.throws(() => genericSessionNativeId('../escape'));
});

test('plain pointer dispatch runs once and retains labelled runner timing without presentation proof', async () => {
  let calls = 0, retained;
  const result = await runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {calls++;}, retain: value => {retained = value;}});
  assert.equal(calls, 1); assert.equal(retained, result); assert.equal(result.dispatchCompleted, true);
  assert.equal(result.clock, 'runner-monotonic'); assert(result.dispatchCompletedMs >= result.dispatchStartedMs);
  assert.deepEqual(result.automation, GENERIC_AUTOMATION); assert.equal(result.nativeBracketVerified, false);
  assert.equal(result.nativeBracket, null); assert.equal(Object.hasOwn(result, 'presentedMs'), false);
});

test('hook brackets exactly the original pointer call and preserves its exact run value', async () => {
  const order = [], requested = pointer();
  const result = await runGenericPointerDispatch({descriptor: requested, dispatch: async () => {order.push('input');},
    hook: async ({descriptor, run}) => {assert.deepEqual(descriptor, requested); order.push('before'); const value = await run(); order.push('after'); return {value, bracket: {id: genericNativeActionId(descriptor)}};}});
  assert.deepEqual(order, ['before', 'input', 'after']); assert.deepEqual(result.missing, []);
  assert.equal(result.nativeBracket.id, genericNativeActionId(requested)); assert.equal(result.nativeBracketVerified, false);
});

test('hook failure before dispatch falls back to exactly one original pointer call', async () => {
  let calls = 0;
  const result = await runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {calls++;}, hook: async () => {throw Error('before ACK');}});
  assert.equal(calls, 1); assert.equal(result.dispatchCompleted, true); assert.equal(result.nativeBracket, null);
  assert(result.missing.includes('pointer-hook-failed')); assert(result.missing.includes('pointer-hook-did-not-dispatch'));
});

test('a hook which never calls run cannot suppress the original pointer dispatch', async () => {
  let calls = 0;
  const result = await runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {calls++;}, hook: async () => ({bracket: {}})});
  assert.equal(calls, 1); assert(result.missing.includes('pointer-hook-did-not-dispatch')); assert.equal(result.nativeBracket, null);
});

test('hook failure after input never replays a completed pointer call', async () => {
  let calls = 0;
  const result = await runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {calls++;}, hook: async ({run}) => {await run(); throw Error('after ACK');}});
  assert.equal(calls, 1); assert.equal(result.dispatchCompleted, true); assert(result.missing.includes('pointer-hook-failed'));
});

test('repeated hook invocation is rejected even when its exception is swallowed', async () => {
  let calls = 0;
  const result = await runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {calls++;},
    hook: async ({run}) => {const value = await run(); assert.throws(() => run()); return {value, bracket: {}};}});
  assert.equal(calls, 1); assert.equal(result.nativeBracket, null); assert(result.missing.includes('pointer-hook-repeated-or-late-dispatch'));
});

test('unawaited input is drained and a late saved run cannot mutate retained evidence', async () => {
  let saved, calls = 0, release;
  const gate = new Promise(resolve => {release = resolve;});
  const pending = runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {calls++; await gate;},
    hook: async ({run}) => {saved = run; run();}});
  release(); const result = await pending, before = copy(result);
  assert.equal(calls, 1); assert.equal(result.dispatchCompleted, true); assert.equal(result.nativeBracket, null);
  assert.throws(() => saved()); assert.equal(calls, 1); assert.deepEqual(result, before);
});

test('forged run values, missing brackets and oversized brackets stay unavailable without replay', async () => {
  for (const returned of [value => ({value: {...value}, bracket: {}}), value => ({value}), value => ({value, bracket: {padding: 'x'.repeat(16385)}})]) {
    let calls = 0;
    const result = await runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {calls++;}, hook: async ({run}) => returned(await run())});
    assert.equal(calls, 1); assert.equal(result.nativeBracket, null); assert(result.missing.includes('pointer-hook-evidence-unavailable'));
  }
});

test('primitive and frozen product failures survive swallowed hook errors and retain the failed dispatch', async () => {
  for (const failure of [undefined, null, false, 0, 'product failed', Object.freeze(Error('frozen product failure'))]) {
    let caught = false, calls = 0, retained;
    try {await runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {calls++; throw failure;}, retain: value => {retained = value;},
      hook: async ({run}) => {try {await run();} catch {} return {};}});} catch (error) {caught = true; assert.equal(error, failure);}
    assert.equal(caught, true); assert.equal(calls, 1); assert.equal(retained.dispatchCompleted, false);
    assert.equal(retained.descriptor.sampleIndex, 0); assert.equal(retained.nativeBracket, null);
  }
});

test('retention callback failure cannot replace either success or the original product error', async () => {
  const result = await runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {}, retain: () => {throw Error('retention');}});
  assert.equal(result.dispatchCompleted, true);
  const failure = Object.freeze(Error('product'));
  await assert.rejects(runGenericPointerDispatch({descriptor: pointer(), dispatch: async () => {throw failure;}, retain: () => {throw Error('retention');}}), error => error === failure);
});

test('a complete synthetic 100-action receipt projects all 2525 dispatches and 2480 endpoints without pixel proof', () => {
  const raw = fullObservation(), before = copy(raw), result = project(raw);
  assert.equal(result.status, 'PASS', JSON.stringify({missing: result.missing, failures: result.failures}));
  assert.deepEqual(result.counts, {actions: 100, discreteActions: 80, pointerDispatches: 2400, discreteDispatches: 125});
  assert.equal(result.actions.filter(action => action.identity.family === 'stroke').length, 20);
  assert.equal(result.actions.reduce((sum, action) => sum + action.dispatches.length, 0), 2525);
  assert.equal(result.actions.reduce((sum, action) => sum + action.endpoints.length, 0), 2480);
  assert.equal(result.profile, GENERIC_PROFILE); assert.equal(result.qualification, false); assert.deepEqual(result.automation, GENERIC_AUTOMATION);
  assert.equal(result.scope, 'browser-input-and-public-state-only'); assert.deepEqual(raw, before);
  assert.equal(Object.hasOwn(result, 'latencyMs'), false); assert.equal(Object.hasOwn(result, 'presentedMs'), false);
});

test('a truncated action list cannot qualify as the fixed workload', () => {
  const raw = fullObservation(); raw.actions.pop(); const result = notAccepted(raw);
  assert(result.missing.includes('complete-hundred-action-workload-unavailable'));
  assert(result.missing.includes('full-fixed-dispatch-inventory-unavailable'));
});

test('missing stroke dispatch, scheduled sample or delivered event cannot silently shrink a stroke', () => {
  for (const mutate of [action => action.pointerDispatches.pop(), action => action.pointerSchedule.samples.pop(), action => action.native.events.pop()]) {
    const raw = fullObservation(); mutate(raw.actions[0]); notAccepted(raw);
  }
});

test('inventory reorder, family replacement, source index drift and variant drift are rejected', () => {
  for (const mutate of [raw => {[raw.actions[2], raw.actions[3]] = [raw.actions[3], raw.actions[2]];},
    raw => {raw.actions[1].kind = 'layer';}, raw => {raw.actions[1].index++;}, raw => {raw.actions[2].variant = 1;}]) {
    const raw = fullObservation(); mutate(raw); const result = notAccepted(raw);
    assert(result.failures.includes('action-inventory-or-order-differs'));
  }
});

test('clock drift, hidden state and a shortened or unfinished observation window cannot pass', () => {
  for (const mutate of [raw => {raw.timeOrigin++;}, raw => {raw.actions[0].nativeState.before.layout.timeOrigin++;},
    raw => {raw.actions[0].nativeState.after.gesture.visibility = 'hidden';}, raw => {raw.endMs--;},
    raw => {raw.captureStoppedMs = raw.endMs - 1;}]) {const raw = fullObservation(); mutate(raw); notAccepted(raw);}
});

test('missing or malformed public state fails closed instead of throwing from replay', () => {
  for (const mutate of [raw => {delete raw.actions[0].nativeState;}, raw => {raw.actions[0].nativeState.after = null;},
    raw => {raw.actions[0].nativeState.before.gesture = null;}, raw => {delete raw.actions[0].nativeState.after.layout;}]) {
    const raw = fullObservation(); mutate(raw); notAccepted(raw);
  }
});

test('public state from a different document cannot bind the observed action', () => {
  for (const sequence of [0, 1, 3]) {
    const raw = fullObservation(); raw.actions[sequence].nativeState.after.gesture.editor.documentId = 'different_document'; notAccepted(raw);
  }
});

test('missing, extra or reordered numeric-entry substeps cannot stand for the complete action', () => {
  for (const mutate of [steps => steps.pop(), steps => steps.push(copy(steps[0])), steps => {[steps[0], steps[1]] = [steps[1], steps[0]];}]) {
    const raw = fullObservation(), action = raw.actions.find(row => row.kind === 'zoom'); mutate(action.discreteInput.steps); notAccepted(raw);
  }
});

test('a valid event sequence for another control or operation cannot impersonate Undo', () => {
  for (const mutate of [descriptor => {descriptor.target = {control: 'layer-row', rowIndex: 0, layerId: 'image_a'};},
    descriptor => {descriptor.input = {kind: 'press', keyName: 'Enter'};}]) {
    const raw = fullObservation(), undo = raw.actions.find(row => row.kind === 'undo'); replaceStep(undo, 0, mutate); notAccepted(raw);
  }
});

test('zoom entry must retain the numeric intent matching its semantic zoom', () => {
  const raw = fullObservation(), zoom = raw.actions.find(row => row.kind === 'zoom');
  replaceStep(zoom, 1, descriptor => {descriptor.input.text = '99';}); notAccepted(raw);
});

test('discrete session, action and substep identities cannot be replaced with another valid descriptor', () => {
  for (const mutate of [descriptor => {descriptor.sessionId = 'another-session';}, descriptor => {descriptor.actionId = 'action-999';}, descriptor => {descriptor.stepId = 'different';}]) {
    const raw = fullObservation(), undo = raw.actions.find(row => row.kind === 'undo'); replaceStep(undo, 0, mutate); notAccepted(raw);
  }
});

test('aggregate discrete input time cannot differ from its retained initiating event', () => {
  const raw = fullObservation(); raw.actions[1].discreteInput.inputMs += 1; notAccepted(raw);
});

test('failed product actions and failed substep dispatches cannot produce a passing projection', () => {
  for (const mutate of [raw => {raw.actions[0].outcome = 'failed';}, raw => {raw.actions[1].outcome = 'failed';},
    raw => {raw.actions[1].discreteInput.steps[0].dispatchCompleted = false;}]) {const raw = fullObservation(); mutate(raw); notAccepted(raw);}
});

test('stroke geometry, continuity and pointer dispatch identity are replayed rather than trusted', () => {
  for (const mutate of [raw => {raw.actions[0].completion.detail.geometrySha256 = 'sha256:' + '0'.repeat(64);},
    raw => {raw.actions[5].completion.detail.draftId = 'another_draft';},
    raw => {raw.actions[0].pointerDispatches[0].descriptor = pointer({sessionId: 'another-session'});},
    raw => {raw.actions[0].pointerDispatches[0].nativeActionId = 'gi-' + '0'.repeat(48);}]) {
    const raw = fullObservation(); mutate(raw); notAccepted(raw);
  }
});


test('completed generic raw cohort retains only original ordered action and sample identities', () => {
  const observed = fullObservation(), original = copy(observed), cohort = genericRawFeedbackCohort(observed, {sessionId: SESSION});
  assert.deepEqual(observed, original);
  assert.deepEqual(cohort.actions, original.actions.map(action => action.kind === 'stroke' ? {
    id: action.specimenId, kind: 'stroke', sampleHz: action.pointerSchedule.frequencyHz,
    sampleIds: action.pointerDispatches.map(step => step.nativeActionId),
  } : {id: action.discreteInput.actionId, kind: 'discrete'}));
  assert.equal(cohort.actions.length, 100); assert.equal(cohort.actions.filter(action => action.kind === 'stroke').length, 20);
  assert.equal(cohort.actions.filter(action => action.kind === 'discrete').length, 80);
  assert.equal(cohort.actions.reduce((count, action) => count + (action.sampleIds?.length ?? 0), 0), 2400);
  assert.equal(cohort.durationMs, 60000); assert.equal(cohort.refreshHz, 60);
  assert.equal(cohort.source, 'original-completed-action-receipt'); assert.equal(cohort.observedExecution, false); assert.equal(cohort.qualification, false);
  const declared = inspectR07Cohort(cohort);
  assert.equal(declared.status, 'declaration-valid'); assert.equal(declared.observedExecution, false);
  assert.equal(declared.qualification, false); assert.equal(declared.expectedPhysicalSlots, null);
  observed.actions[0].pointerDispatches[0].nativeActionId = 'changed'; observed.actions[1].discreteInput.actionId = 'changed';
  assert.equal(cohort.actions[0].sampleIds[0], original.actions[0].pointerDispatches[0].nativeActionId);
  assert.equal(cohort.actions[1].id, original.actions[1].discreteInput.actionId);
  cohort.actions[0].sampleIds.pop(); assert.equal(observed.actions[0].pointerDispatches.length, 120);
});

test('generic raw cohort refuses incomplete windows, failed actions and changed fixed inventory', () => {
  for (const change of [value => {value.endMs--;}, value => {value.captureStoppedMs = value.endMs - 1;},
    value => {value.timeOrigin = 0;}, value => {value.sessionId = 'other-session';}, value => {value.status = 'FAIL';},
    value => {value.actions.pop();}, value => {value.actions.push(value.actions[0]);}, value => {delete value.actions[0];},
    value => {value.actions[1].outcome = 'failed';}, value => {value.actions[0].meaningful = false;},
    value => {value.actions[0].validation = {status: 'FAIL'};},
    value => {[value.actions[1], value.actions[2]] = [value.actions[2], value.actions[1]];},
    value => {value.actions[1].ordinal++;}, value => {value.actions[1].variant = 1;}]) {
    const observed = copy(fullObservation()); change(observed);
    assert.throws(() => genericRawFeedbackCohort(observed, {sessionId: SESSION}));
  }
  const observed = fullObservation(); observed.sessionId = SESSION;
  assert.doesNotThrow(() => genericRawFeedbackCohort(observed, {sessionId: SESSION}));
  assert.throws(() => genericRawFeedbackCohort(observed, {sessionId: 'another-owned-session'}));
});

test('generic raw cohort refuses incomplete, duplicated or substituted stroke sample receipts', () => {
  for (const change of [value => {value.actions[0].pointerDispatches.pop();}, value => {delete value.actions[0].pointerDispatches[1];}, value => {value.actions[0].native.events.pop();},
    value => {value.actions[0].plan.points.push(value.actions[0].plan.points[0]);},
    value => {value.actions[0].pointerSchedule.samples.pop();}, value => {value.actions[0].pointerSchedule.frequencyHz = 30;},
    value => {value.actions[0].completion.detail.sampleCount = 119;}, value => {value.actions[0].completion.startMs = 60001;},
    value => {value.actions[0].pointerDispatches[0].dispatchCompleted = false;},
    value => {value.actions[0].pointerDispatches[1].nativeActionId = value.actions[0].pointerDispatches[0].nativeActionId;},
    value => {value.actions[0].pointerDispatches[0].nativeActionId = 'gi-' + 'a'.repeat(48);},
    value => {value.actions[5].specimenId = value.actions[0].specimenId;},
    value => {value.actions[0].pointerDispatches[0].descriptor = pointer({sessionId: 'other-session'});},
    value => {value.actions[0].pointerSchedule.samples[1].scheduledMs += 1;},
    value => {value.actions[0].native.events[1].inputMs = -1;}, value => {value.actions[95].native.events[119].inputMs = 60001;},
    value => {value.actions[0].native.overflow = true;}]) {
    const observed = copy(fullObservation()); change(observed);
    assert.throws(() => genericRawFeedbackCohort(observed, {sessionId: SESSION}));
  }
});

test('generic raw cohort refuses discrete receipt gaps and identities from another delivery', () => {
  for (const change of [value => {delete value.actions[1].discreteInput;},
    value => {value.actions[1].discreteInput.actionId = value.actions[2].discreteInput.actionId;},
    value => {value.actions[1].discreteInput.status = 'INCONCLUSIVE';}, value => {value.actions[1].discreteInput.steps.pop();},
    value => {value.actions[1].discreteInput.steps[0].dispatchCompleted = false;},
    value => {value.actions[1].discreteInput.steps[0].inputEvidence.timeOrigin++;},
    value => {value.actions[1].discreteInput.steps[0].inputEvidence.events[0].isTrusted = false;},
    value => {value.actions[1].inputMs++;},
    value => {replaceStep(value.actions[1], 0, descriptor => {descriptor.sessionId = 'other-session';});}]) {
    const observed = copy(fullObservation()); change(observed);
    assert.throws(() => genericRawFeedbackCohort(observed, {sessionId: SESSION}));
  }
});

test('generic end passes the completed declaration to the first raw stop after the actual native end', async () => {
  const observed = fullObservation(), original = copy(observed), order = [], missing = [], anchor = {status: 'complete'};
  let resolveEnd, stopOptions;
  const native = {end: () => {order.push('native-end'); return new Promise(resolve => {resolveEnd = resolve;});}};
  const trace = {stop: async options => {order.push('raw-stop'); stopOptions = options;}};
  const result = endGenericFeedbackSession({native, trace, rawFeedbackSelected: true, sessionId: SESSION, observed, missing});
  assert.deepEqual(order, ['native-end']); assert.equal(stopOptions, undefined);
  resolveEnd(anchor); assert.equal(await result, anchor);
  assert.deepEqual(order, ['native-end', 'raw-stop']); assert.deepEqual(missing, []);
  assert.deepEqual(stopOptions, {rawFeedbackCohort: genericRawFeedbackCohort(original, {sessionId: SESSION})});
  assert.deepEqual(observed, original); assert.equal(stopOptions.rawFeedbackCohort.observedExecution, false);
});

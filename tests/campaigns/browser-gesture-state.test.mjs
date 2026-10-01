import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brushCorpus, workloadDefinition } from '../../tooling/qualification/campaigns/fixtures.mjs';
import {
  chooseInteractionZoomPercentages, eligibleGestureLayers, planStrokeCoordinates,
  validateNativeDiscrete, validateNativeStroke, validateRecordedStroke,
} from '../../tooling/qualification/campaigns/browser-gesture-state.mjs';

// Synthetic reducer specimens only. These tests provide no browser execution,
// measured input latency, product append, or physical presentation evidence.
const copy = value => structuredClone(value);
const document = () => ({ id: 'gesture_document', revision: '7', width: 1000, height: 800 });
const state = () => ({
  clock: 'browser-performance', timeOrigin: 1_800_000_000_000, observedMs: 100,
  box: { x: 100, y: 70, width: 800, height: 600 },
  viewport: { zoom: 0.5, x: 18, y: -12, observedMs: 90 },
  editor: { documentId: 'gesture_document', revision: '7', ready: true, busy: false,
    selected: ['image_a'], observedMs: 95 },
  tool: 'Mask', brushDiameter: 64, visibility: 'visible',
});
const specimen = () => ({
  id: 'stroke-001', brushDiameter: 64, sampleHz: 60,
  samples: Array.from({ length: 120 }, (_, index) => ({
    x: 400 + Math.min(index, 118) / 2,
    y: 300 + Math.min(index, 118) / 4,
    timeMs: index * 1000 / 60,
  })),
});
const planFor = (current = state()) => planStrokeCoordinates(specimen(), current, {
  document: document(), eligibleLayerIds: ['image_a', 'image_b'],
});
function nativeObservation(plan = planFor(), downMs = 200) {
  const events = plan.points.map((point, index) => ({
    type: index === 0 ? 'pointerdown' : index === 119 ? 'pointerup' : 'pointermove',
    inputMs: downMs + point.plannedOffsetMs, observedMs: downMs + point.plannedOffsetMs + 0.25,
    trusted: true, primary: true, pointerType: 'mouse', pointerId: 7,
    buttons: index === 119 ? 0 : 1, clientX: point.x, clientY: point.y,
  }));
  return { clock: 'browser-performance', timeOrigin: plan.state.timeOrigin,
    armedMs: downMs - 1, stoppedMs: downMs + 2200, firstInputMs: downMs,
    canvasStillConnected: true, overflow: false, cancelled: false, events };
}
function consumedGeometryHash(observation, plan) {
  const { box, viewport } = plan.state;
  const points = observation.events.map(event => [
    (event.clientX - box.x - box.width / 2 - viewport.x) / viewport.zoom + plan.document.width / 2,
    (event.clientY - box.y - box.height / 2 - viewport.y) / viewport.zoom + plan.document.height / 2,
  ]);
  return 'sha256:' + createHash('sha256').update(JSON.stringify(points)).digest('hex');
}
function recorded(plan = planFor(), observation = nativeObservation(plan)) {
  return { startMs: observation.events.at(-1).observedMs + 1, detail: {
    schemaVersion: 1, gestureOrdinal: 1, pointerId: 7,
    inputDownMs: observation.events[0].inputMs, inputUpMs: observation.events.at(-1).inputMs,
    trusted: true, documentId: plan.documentId, revision: plan.revision,
    draftId: 'mask_draft', targetLayerId: plan.selectedLayerId, targetLayerVersion: '3',
    selectedLayerId: plan.selectedLayerId, sampleCount: 120, operationCount: 13,
    geometrySha256: consumedGeometryHash(observation, plan), brushDiameter: 64,
  } };
}
const prerequisite = work => assert.throws(work, error => error.code === 'CAMPAIGN_PREREQUISITE');

test('stroke coordinates use the exact current pan and zoom without mutating setup', () => {
  const current = state(), stroke = specimen(), before = copy({ current, stroke });
  const result = planStrokeCoordinates(stroke, current, { document: document(), eligibleLayerIds: ['image_a'] });
  assert.deepEqual(result.points[0], { index: 0, x: 468, y: 308, documentX: 400, documentY: 300, plannedOffsetMs: 0 });
  assert.equal(result.points.length, 120);
  assert.equal(result.selectedLayerId, 'image_a');
  assert.equal(result.actualInputClock, 'native-events-required');
  assert.deepEqual({ current, stroke }, before);
});

test('a changed split rectangle and pan are used directly instead of an inferred Fit', () => {
  const current = state();
  current.box = { x: 145, y: 90, width: 600, height: 400 };
  current.viewport = { zoom: 0.25, x: -14, y: 21, observedMs: 99 };
  const result = planFor(current);
  assert.equal(result.points[0].x, 406);
  assert.equal(result.points[0].y, 286);
  assert.equal(result.state.viewport.zoom, 0.25);
});

test('off-canvas geometry is refused without silently fitting or recentering it', () => {
  const current = state(); current.viewport.x = 1000;
  const before = copy(current);
  assert.throws(() => planFor(current), /no hidden viewport reset/);
  assert.deepEqual(current, before);
});

test('eligible image rows retain their actual reversed public tree indexes', () => {
  const image = { layers: [
    { id: 'bottom', kind: 'image', visible: true, locked: false },
    { id: 'text', kind: 'text', visible: true, locked: false },
    { id: 'hidden', kind: 'image', visible: false, locked: false },
    { id: 'locked', kind: 'image', visible: true, locked: true },
    { id: 'top', kind: 'image', visible: true, locked: false },
    { id: 'unknown-lock', kind: 'image', visible: true },
  ] }, before = copy(image);
  assert.deepEqual(eligibleGestureLayers(image).map(({ id, rowIndex }) => ({ id, rowIndex })), [
    { id: 'top', rowIndex: 1 }, { id: 'bottom', rowIndex: 5 },
  ]);
  assert.deepEqual(image, before);
  prerequisite(() => eligibleGestureLayers({}));
});

test('interaction zoom choices are distinct dyadic percentages with visible margin', () => {
  const current = state(); current.box = { x: 10, y: 20, width: 1000, height: 800 };
  const before = copy(current), choices = chooseInteractionZoomPercentages(current, document());
  assert.equal(choices.length, 2);
  assert.deepEqual(choices, [25, 50]);
  assert(choices[0] > 0 && choices[1] > choices[0] && choices[1] < 90);
  for (const value of choices) assert(Number.isInteger(Math.log2(value / 100)));
  assert.deepEqual(current, before);
  current.box.width = 70;
  prerequisite(() => chooseInteractionZoomPercentages(current, document()));
});

test('twenty W1 and W2 strokes survive native float32 transport exactly and fit the mask envelope', () => {
  for (const workload of ['W1', 'W2']) {
    const { width, height } = workloadDefinition(workload);
    const current = state(), doc = { ...document(), width, height };
    current.box = { x: 300.25, y: 200.5, width: 640.5, height: 500.25 };
    const zooms = chooseInteractionZoomPercentages(current, doc);
    const mask = { width, height, feather: 0, operations: [] };
    for (const [index, stroke] of brushCorpus(width, height).slice(0, 20).entries()) {
      current.viewport = { zoom: zooms[index % 2] / 100, x: index % 2 ? 10 : 0,
        y: index % 2 ? 0 : 10, observedMs: 90 };
      const plan = planStrokeCoordinates(stroke, current, { document: doc, eligibleLayerIds: ['image_a'] });
      const { box, viewport } = current;
      // Native Chromium transports CSS points through float32. Apply the
      // product CanvasView.point inverse without rounding authored coordinates.
      const delivered = plan.points.map(point => [
        (Math.fround(point.x) - box.x - box.width / 2 - viewport.x) / viewport.zoom + width / 2,
        (Math.fround(point.y) - box.y - box.height / 2 - viewport.y) / viewport.zoom + height / 2,
      ]);
      assert.deepEqual(delivered, stroke.samples.map(sample => [sample.x, sample.y]), workload + ' exact stroke ' + index);
      assert(delivered.every(point => point.every(Number.isInteger)), workload + ' acquired fractional point expansion');
      mask.operations.push({ kind: 'stroke', points: delivered, size: 64, hardness: 1, mode: 'add' });
    }
    assert.equal(mask.operations.length, 20);
    assert.equal(mask.operations.reduce((sum, operation) => sum + operation.points.length, 0), 2400);
    assert(Buffer.byteLength(JSON.stringify(mask), 'utf8') <= 48000, workload + ' exceeds the product MaskPlan envelope');
  }
});

test('missing transform clocks or invalid current editor preconditions cannot dispatch a stroke', () => {
  for (const mutate of [
    value => { value.viewport.zoom = NaN; },
    value => { value.viewport.observedMs = value.observedMs + 1; },
    value => { value.timeOrigin = 0; },
    value => { value.clock = 'runner-monotonic'; },
    value => { value.tool = 'Pan'; },
    value => { value.brushDiameter = 20; },
    value => { value.visibility = 'hidden'; },
    value => { value.editor.busy = true; },
    value => { value.editor.revision = '8'; },
    value => { value.editor.selected = ['image_a', 'image_b']; },
    value => { value.editor.selected = ['text_layer']; },
  ]) {
    const current = state(); mutate(current); prerequisite(() => planFor(current));
  }
});

test('a changed sealed count, schedule, extent or release coordinate is rejected', () => {
  for (const mutate of [
    value => { value.samples.pop(); },
    value => { value.sampleHz = 120; },
    value => { value.samples[10].timeMs += 1; },
    value => { value.samples[10].x = -1; },
    value => { value.samples[10].y = 801; },
    value => { value.samples[119].x += 1; },
  ]) {
    const stroke = specimen(); mutate(stroke);
    prerequisite(() => planStrokeCoordinates(stroke, state(), { document: document(), eligibleLayerIds: ['image_a'] }));
  }
});

test('exact trusted down plus 118 delivered moves plus up proves input only', () => {
  const plan = planFor(), observation = nativeObservation(plan), result = validateNativeStroke(observation, plan);
  assert.equal(result.status, 'PASS'); assert.equal(result.sampleCount, 120);
  assert.equal(result.samples.filter(event => event.type === 'pointermove').length, 118);
  assert(result.samples.every(event => event.presentedMs === null));
  assert.deepEqual(result.failures, []); assert.deepEqual(result.missing, []);
  assert.equal(result.productAppendQualified, false); assert.equal(result.physicalPresentationQualified, false);
});

test('missing or additional delivered events cannot be repaired with coalesced samples', () => {
  const plan = planFor();
  for (const mutate of [
    value => { value.events.splice(50, 1); value.events[49].coalescedEvents = [{ inputMs: 999 }, { inputMs: 1000 }]; },
    value => { value.events.splice(50, 0, copy(value.events[50])); },
  ]) {
    const observation = nativeObservation(plan); mutate(observation);
    const result = validateNativeStroke(observation, plan);
    assert.equal(result.status, 'FAIL'); assert(result.failures.includes('native-stroke-event-count'));
  }
});

test('untrusted input, another pointer, wrong buttons or nonmouse input cannot qualify a stroke', () => {
  const plan = planFor();
  for (const mutate of [
    value => { value.events[10].trusted = false; },
    value => { value.events[10].pointerId = 8; },
    value => { value.events[10].buttons = 0; },
    value => { value.events[10].primary = false; },
    value => { value.events[10].pointerType = 'pen'; },
    value => { value.events[119].type = 'pointermove'; },
  ]) {
    const observation = nativeObservation(plan); mutate(observation);
    const result = validateNativeStroke(observation, plan);
    assert.equal(result.status, 'FAIL'); assert(result.failures.includes('native-stroke-event-sequence'));
  }
});

test('cancel, overflow and canvas replacement remain failures when clock evidence is also missing', () => {
  const plan = planFor();
  for (const [field, value, reason] of [
    ['cancelled', true, 'native-pointer-cancelled'],
    ['overflow', true, 'native-event-overflow'],
    ['canvasStillConnected', false, 'native-canvas-replaced'],
  ]) {
    const observation = nativeObservation(plan); observation[field] = value; observation.timeOrigin++;
    const result = validateNativeStroke(observation, plan);
    assert.equal(result.status, 'FAIL'); assert(result.failures.includes(reason));
    assert(result.missing.includes('same-browser-input-clock'));
  }
});

test('clock-domain mismatch, invalid bounds and reordered native times remain inconclusive', () => {
  const plan = planFor();
  for (const mutate of [
    value => { value.clock = 'runner-monotonic'; },
    value => { value.timeOrigin++; },
    value => { value.armedMs = -1; },
    value => { value.stoppedMs = value.armedMs - 1; },
    value => { value.events[10].inputMs = value.events[9].inputMs - 1; },
    value => { value.events[10].observedMs = value.events[10].inputMs - 1; },
    value => { value.events[10].inputMs = NaN; },
    value => { value.firstInputMs++; },
  ]) {
    const observation = nativeObservation(plan); mutate(observation);
    const result = validateNativeStroke(observation, plan);
    assert.equal(result.status, 'INCONCLUSIVE'); assert(result.missing.length > 0);
    assert.equal(result.productAppendQualified, false); assert.equal(result.physicalPresentationQualified, false);
  }
});

test('small native fractional precision residuals are retained rather than rounded away', () => {
  const plan = planFor(), observation = nativeObservation(plan);
  observation.events[10].clientX += 0.00001;
  const result = validateNativeStroke(observation, plan);
  assert.equal(result.status, 'PASS');
  assert.equal(result.samples[10].clientX, observation.events[10].clientX);
  assert(result.coordinatePrecision.deviations[10].cssX > 0);
  assert.equal(result.coordinatePrecision.deviations[10].documentX,
    result.coordinatePrecision.deviations[10].cssX / plan.state.viewport.zoom);
});

test('a pixel-scale coordinate rewrite cannot qualify as the sealed native geometry', () => {
  const plan = planFor(), observation = nativeObservation(plan); observation.events[10].clientX += 1;
  const result = validateNativeStroke(observation, plan);
  assert.equal(result.status, 'FAIL'); assert(result.failures.includes('native-stroke-coordinate-mismatch'));
});

function discreteObservation() {
  return { clock: 'browser-performance', timeOrigin: state().timeOrigin, armedMs: 100, stoppedMs: 200,
    firstInputMs: 120, canvasStillConnected: true, cancelled: false, overflow: false,
    events: [{ type: 'keydown', inputMs: 120, observedMs: 120.5, trusted: true, key: 'ArrowLeft' }] };
}

test('a trusted discrete boundary retains its native timestamp without claiming presentation', () => {
  const observation = discreteObservation(), result = validateNativeDiscrete(observation, { timeOrigin: state().timeOrigin });
  assert.equal(result.status, 'PASS'); assert.equal(result.inputMs, 120);
  assert.equal(result.physicalPresentationQualified, false);
});

test('untrusted discrete events cannot supply a trusted input boundary', () => {
  const observation = discreteObservation(); observation.events[0].trusted = false;
  const result = validateNativeDiscrete(observation, { timeOrigin: state().timeOrigin });
  assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.inputMs, null);
  assert(result.missing.includes('actual-trusted-discrete-input'));
});

test('a synthetic precursor is retained but never replaces the later trusted input timestamp', () => {
  const observation = discreteObservation();
  observation.events.unshift({ type: 'change', inputMs: 110, observedMs: 110.5, trusted: false });
  const result = validateNativeDiscrete(observation, { timeOrigin: state().timeOrigin });
  assert.equal(result.status, 'PASS'); assert.equal(result.inputMs, 120);
  assert.equal(result.events[0].trusted, false);
  observation.firstInputMs = 110;
  assert.equal(validateNativeDiscrete(observation, { timeOrigin: state().timeOrigin }).status, 'INCONCLUSIVE');
});

test('discrete clock errors and unbounded or canceled collections cannot pass', () => {
  for (const [mutate, expected] of [
    [value => { value.timeOrigin++; }, 'INCONCLUSIVE'],
    [value => { value.events[0].observedMs = 119; }, 'INCONCLUSIVE'],
    [value => { value.events[0].type = 'pointerup'; }, 'INCONCLUSIVE'],
    [value => { value.events = []; }, 'INCONCLUSIVE'],
    [value => { value.overflow = true; }, 'FAIL'],
    [value => { value.cancelled = true; }, 'FAIL'],
    [value => { value.canvasStillConnected = false; }, 'FAIL'],
    [value => { value.events = Array.from({ length: 65 }, () => copy(value.events[0])); }, 'FAIL'],
  ]) {
    const observation = discreteObservation(); mutate(observation);
    assert.equal(validateNativeDiscrete(observation, { timeOrigin: state().timeOrigin }).status, expected);
  }
});

test('product completion binds the exact native geometry and initial draft owner', () => {
  const plan = planFor(), observation = nativeObservation(plan), completion = recorded(plan, observation);
  // Initial masks may already contain operations from their attached source.
  assert.equal(completion.detail.operationCount, 13);
  const result = validateRecordedStroke({ observation, plan, completion });
  assert.equal(result.status, 'PASS'); assert.equal(result.productAppendQualified, true);
  assert.equal(result.physicalPresentationQualified, false);
});

test('a stale or absent product mark cannot establish a completed stroke', () => {
  const plan = planFor(), observation = nativeObservation(plan);
  assert.equal(validateRecordedStroke({ observation, plan }).status, 'INCONCLUSIVE');
  for (const mutate of [
    value => { value.startMs = observation.events.at(-1).inputMs - 1; },
    value => { value.detail.inputDownMs--; },
    value => { value.detail.inputUpMs--; },
    value => { value.detail.pointerId++; },
    value => { value.detail.trusted = false; },
    value => { value.detail.schemaVersion = 2; },
  ]) {
    const completion = recorded(plan, observation); mutate(completion);
    const result = validateRecordedStroke({ observation, plan, completion });
    assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.productAppendQualified, false);
    assert(result.missing.includes('matching-successful-product-stroke-witness'));
  }
});

test('the product hash must describe delivered fractional coordinates rather than intended dispatches', () => {
  const plan = planFor(), observation = nativeObservation(plan), completion = recorded(plan, observation);
  observation.events[10].clientX += 0.00001;
  assert.equal(validateNativeStroke(observation, plan).status, 'PASS');
  const stale = validateRecordedStroke({ observation, plan, completion });
  assert.equal(stale.status, 'FAIL'); assert(stale.failures.includes('product-consumed-coordinate-hash'));
  completion.detail.geometrySha256 = consumedGeometryHash(observation, plan);
  assert.equal(validateRecordedStroke({ observation, plan, completion }).status, 'PASS');
});

test('wrong product sample count, geometry, document, selection or initial owner is a failure', () => {
  const plan = planFor(), observation = nativeObservation(plan);
  for (const mutate of [
    value => { value.detail.sampleCount = 119; },
    value => { value.detail.brushDiameter = 20; },
    value => { value.detail.geometrySha256 = 'sha256:' + '0'.repeat(64); },
    value => { value.detail.documentId = 'another_document'; },
    value => { value.detail.revision = '8'; },
    value => { value.detail.selectedLayerId = 'image_b'; },
    value => { value.detail.targetLayerId = 'image_b'; },
  ]) {
    const completion = recorded(plan, observation); mutate(completion);
    const result = validateRecordedStroke({ observation, plan, completion });
    assert.equal(result.status, 'FAIL'); assert.equal(result.productAppendQualified, false);
  }
});

test('missing draft ownership or a noncanonical target version stays inconclusive', () => {
  const plan = planFor(), observation = nativeObservation(plan);
  for (const mutate of [
    value => { value.detail.draftId = ''; },
    value => { value.detail.targetLayerVersion = '03'; },
    value => { value.detail.operationCount = 0; },
  ]) {
    const completion = recorded(plan, observation); mutate(completion);
    const result = validateRecordedStroke({ observation, plan, completion });
    assert.equal(result.status, 'INCONCLUSIVE'); assert(result.missing.includes('actual-bound-mask-draft-identity'));
  }
});

function continuedStroke() {
  const initialPlan = planFor(), initialObservation = nativeObservation(initialPlan);
  const priorCompletion = recorded(initialPlan, initialObservation);
  const current = state(); current.editor.selected = ['image_b'];
  const plan = planFor(current), observation = nativeObservation(plan, 3000), completion = recorded(plan, observation);
  Object.assign(completion.detail, { gestureOrdinal: 2, operationCount: 14, targetLayerId: 'image_a' });
  return { observation, plan, completion, priorCompletion };
}

test('selection changes preserve continuity of the original mask draft owner', () => {
  const input = continuedStroke(), before = copy(input), result = validateRecordedStroke(input);
  assert.equal(input.plan.selectedLayerId, 'image_b'); assert.equal(input.completion.detail.targetLayerId, 'image_a');
  assert.equal(result.status, 'PASS'); assert.equal(result.productAppendQualified, true);
  assert.equal(result.physicalPresentationQualified, false); assert.deepEqual(input, before);
});

test('a replaced draft, changed owner, duplicate ordinal or skipped operation breaks continuity', () => {
  for (const mutate of [
    value => { value.detail.draftId = 'replacement_draft'; },
    value => { value.detail.targetLayerId = 'image_b'; },
    value => { value.detail.targetLayerVersion = '4'; },
    value => { value.detail.gestureOrdinal = 1; },
    value => { value.detail.operationCount = 15; },
  ]) {
    const input = continuedStroke(); mutate(input.completion);
    const result = validateRecordedStroke(input);
    assert.equal(result.status, 'FAIL'); assert(result.failures.includes('mask-draft-continuity'));
  }
});

function strokeAfterCountedUndo() {
  const input = continuedStroke();
  input.requireEmptyDraft = true;
  input.priorCompletion.detail.operationCount = 1;
  input.completion.detail.operationCount = 1;
  const native = discreteObservation();
  Object.assign(native, { armedMs: 2250, stoppedMs: 2270, firstInputMs: 2260,
    events: [{ type: 'pointerdown', inputMs: 2260, observedMs: 2260.5, trusted: true }] });
  input.priorUndo = { draftId: 'mask_draft', gestureOrdinal: 1,
    beforeOperationCount: 1, afterOperationCount: 0, buttonDisabled: true,
    observedMs: 2271, native };
  return input;
}

test('a counted trusted Undo permits the next single stroke on the same draft after selection changes', () => {
  const input = strokeAfterCountedUndo(), before = copy(input);
  const result = validateRecordedStroke(input);
  assert.equal(result.status, 'PASS'); assert.equal(result.productAppendQualified, true);
  assert.equal(input.completion.detail.operationCount, 1);
  assert.equal(input.completion.detail.selectedLayerId, 'image_b');
  assert.equal(input.completion.detail.targetLayerId, 'image_a');
  assert.equal(result.physicalPresentationQualified, false);
  assert.deepEqual(input, before, 'Validation must not rewrite the retained prior completion');
});

test('an empty-draft protocol requires the preceding counted Undo evidence', () => {
  const input = strokeAfterCountedUndo(); delete input.priorUndo;
  const result = validateRecordedStroke(input);
  assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.productAppendQualified, false);
  assert(result.missing.includes('preceding-counted-mask-undo'));
});

test('forged Undo identity, counts, disabled state or timing cannot establish continuity', () => {
  for (const mutate of [
    value => { value.draftId = 'unrelated_draft'; },
    value => { value.gestureOrdinal = 2; },
    value => { value.beforeOperationCount = 2; },
    value => { value.afterOperationCount = 1; },
    value => { value.buttonDisabled = false; },
    value => { value.observedMs = 2259; },
    value => { value.observedMs = 3001; },
    value => { value.native.stoppedMs = 3001; },
    value => { value.native.events[0].trusted = false; },
    value => { value.native.timeOrigin++; },
    value => {
      Object.assign(value.native, { armedMs: 999, firstInputMs: 1000 });
      Object.assign(value.native.events[0], { inputMs: 1000, observedMs: 1000.5 });
    },
  ]) {
    const input = strokeAfterCountedUndo(); mutate(input.priorUndo);
    const result = validateRecordedStroke(input);
    assert.notEqual(result.status, 'PASS'); assert.equal(result.productAppendQualified, false);
    assert(result.missing.includes('observed-counted-mask-undo'));
  }
});

test('failed native Undo retains failure priority over missing Undo proof', () => {
  const input = strokeAfterCountedUndo(); input.priorUndo.native.cancelled = true;
  const result = validateRecordedStroke(input);
  assert.equal(result.status, 'FAIL'); assert(result.failures.includes('failed-counted-mask-undo'));
  assert.equal(result.productAppendQualified, false);
});

test('the empty-draft protocol rejects inherited operations before its first stroke', () => {
  const plan = planFor(), observation = nativeObservation(plan), completion = recorded(plan, observation);
  const input = { plan, observation, completion, requireEmptyDraft: true };
  const inherited = validateRecordedStroke(input);
  assert.equal(inherited.status, 'FAIL'); assert(inherited.failures.includes('prepared-empty-mask-draft'));
  completion.detail.operationCount = 1;
  assert.equal(validateRecordedStroke(input).status, 'PASS');
});

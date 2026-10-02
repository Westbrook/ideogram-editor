import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {monotonic} from './common.mjs';
import {readGestureState, validateRecordedStroke} from './browser-gesture-state.mjs';
import {discreteInputDescriptor, validateDiscreteInput} from './browser-discrete-input.mjs';

export const GENERIC_PROFILE = 'interaction-100-2400-60hz-60s-1';
export const GENERIC_AUTOMATION = Object.freeze({driver: 'playwright', delivery: 'browser-input-api', physicalInput: false});
const demand = (value, message) => {if (!value) throw Error(message);};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
function freeze(value) {if (value && typeof value === 'object') {for (const item of Object.values(value)) freeze(item); Object.freeze(value);} return value;}

/** This inventory is checked against retained driver receipts, not used to
 * create, replace, or shorten the product workload. */
export function genericInteractionInventory() {
  const seen = new Map();
  return Array.from({length: 20}, (_, index) => [{kind: 'stroke', index}, ...['undo', ...(index % 2 ? ['zoom', 'theme', 'split'] : ['pan', 'layer', 'density'])].map((kind, offset) => {
    const ordinal = (seen.get(kind) ?? 0) + 1; seen.set(kind, ordinal);
    return {kind, index: index * 4 + offset, ordinal, variant: (ordinal - 1) % 2};
  })]).flat();
}

export function genericPointerDescriptor(value) {
  demand(value?.schemaVersion === 1 && identifier(value.sessionId) && Number.isInteger(value.actionSequence) &&
    value.actionSequence >= 0 && value.actionSequence < 100 && value.actionSequence % 5 === 0 && value.family === 'stroke' &&
    /^stroke-\d{3}$/.test(value.specimenId ?? '') && Number.isInteger(value.sampleIndex) && value.sampleIndex >= 0 && value.sampleIndex < 120 &&
    value.type === (value.sampleIndex === 0 ? 'pointerdown' : value.sampleIndex === 119 ? 'pointerup' : 'pointermove') &&
    finite(value.x) && finite(value.y), 'Invalid generic pointer dispatch identity');
  return Object.freeze({schemaVersion: 1, sessionId: value.sessionId, actionSequence: value.actionSequence, family: 'stroke',
    specimenId: value.specimenId, sampleIndex: value.sampleIndex, type: value.type, x: value.x, y: value.y});
}

export function genericNativeActionId(value) {
  const descriptor = value?.family === 'stroke' ? genericPointerDescriptor(value) : discreteInputDescriptor(value);
  return 'gi-' + hash(descriptor).slice(0, 48);
}

export function genericSessionNativeId(sessionId) {
  demand(identifier(sessionId), 'Invalid generic session identity');
  return 'gis-' + hash(sessionId).slice(0, 48);
}

/** Exactly one existing pointer dispatch. Hook failures preserve the product
 * outcome and never retry input. Runner times describe dispatch only. */
export async function runGenericPointerDispatch({descriptor: requested, dispatch, hook, retain}) {
  const descriptor = genericPointerDescriptor(requested), missing = [];
  let promise, value, productError, failed = false, open = true, hookResult;
  const run = () => {
    if (!open) throw Error('Pointer input may dispatch once');
    if (promise) {missing.push('pointer-hook-repeated-or-late-dispatch'); throw Error('Pointer input may dispatch once');}
    promise = (async () => {
      const dispatchStartedMs = monotonic();
      try {await dispatch();} catch (error) {failed = true; productError = error;}
      value = Object.freeze({dispatchCompleted: !failed, dispatchStartedMs, dispatchCompletedMs: monotonic(), clock: 'runner-monotonic'});
      if (failed) throw productError;
      return value;
    })();
    promise.catch(() => {}); return promise;
  };
  if (hook) {
    try {hookResult = await hook({descriptor, run});} catch {missing.push('pointer-hook-failed');}
    if (!promise) missing.push('pointer-hook-did-not-dispatch');
  }
  if (!promise) run();
  open = false; try {await promise;} catch {}
  let nativeBracket = null;
  if (hook && !missing.length) try {
    demand(hookResult?.value === value, 'Pointer hook result differs');
    const bytes = JSON.stringify(hookResult.bracket);
    demand(typeof bytes === 'string' && bytes.length <= 16384, 'Pointer bracket is absent or oversized');
    nativeBracket = JSON.parse(bytes);
  } catch {missing.push('pointer-hook-evidence-unavailable');}
  const result = freeze({...value, descriptor, nativeActionId: genericNativeActionId(descriptor), nativeBracket, missing: [...missing],
    nativeBracketVerified: false, automation: GENERIC_AUTOMATION});
  try {retain?.(result);} catch {}
  if (failed) throw productError;
  return result;
}

/** Public observations only, outside input dispatch. They bind the independent
 * pixel oracle's expected state; they are never presentation evidence. */
export async function readGenericPublicState(page) {
  const gesture = await readGestureState(page);
  const layout = await page.evaluate(() => {
    const rectangle = element => {const r = element?.getBoundingClientRect(); return r ? {x: r.x, y: r.y, width: r.width, height: r.height} : null;};
    return {clock: 'browser-performance', timeOrigin: performance.timeOrigin, observedMs: performance.now(),
      appearance: document.documentElement.dataset.enAppearance ?? null, densityTheme: document.documentElement.dataset.enTheme ?? null,
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      density: document.querySelector('en-select[label="Density"]')?.value ?? null,
      splitter: document.querySelector('#left-divider')?.value ?? null,
      boxes: {canvas: rectangle(document.querySelector('#canvas')), layerTree: rectangle(document.querySelector('#layer-tree')),
        splitter: rectangle(document.querySelector('#left-divider'))},
      viewport: {width: innerWidth, height: innerHeight, devicePixelRatio}, visibility: document.visibilityState};
  });
  return {gesture, layout};
}

function stableState(value) {
  const g = value?.gesture, l = value?.layout;
  if (!g || !l) return null;
  return {box: g.box, viewport: g.viewport ? {x: g.viewport.x, y: g.viewport.y, zoom: g.viewport.zoom} : null,
    documentId: g.editor?.documentId ?? null, revision: g.editor?.revision ?? null, selected: g.editor?.selected ?? null,
    tool: g.tool, brushDiameter: g.brushDiameter, appearance: l.appearance, densityTheme: l.densityTheme,
    prefersDark: l.prefersDark, density: l.density, splitter: l.splitter, boxes: l.boxes, viewportPixels: l.viewport};
}

function semanticState(action, previousStroke) {
  const value = action.semantic ?? {};
  switch (action.kind) {
    case 'undo': return {priorSpecimenId: previousStroke?.specimenId ?? null, beforeOperationCount: value.beforeOperationCount,
      afterOperationCount: value.afterOperationCount, buttonDisabled: value.buttonDisabled};
    case 'layer': case 'theme': case 'density': return {before: value.before, after: value.after};
    case 'zoom': return {zoom: value.zoom};
    case 'pan': return {before: value.before, after: value.after};
    case 'split': return {before: value.before, after: value.after, direction: value.direction};
    default: return null;
  }
}

function validPublicState(s, observed) {
  const g = s?.gesture, l = s?.layout;
  return g && l && g.clock === 'browser-performance' && l.clock === 'browser-performance' &&
    g.timeOrigin === observed.timeOrigin && l.timeOrigin === observed.timeOrigin && g.visibility === 'visible' && l.visibility === 'visible' &&
    finite(g.observedMs) && finite(l.observedMs) && g.observedMs >= observed.startMs && l.observedMs >= g.observedMs && l.observedMs <= observed.endMs &&
    typeof g.editor?.documentId === 'string' && typeof g.editor.revision === 'string' && /^(0|[1-9][0-9]*)$/.test(g.editor.revision) && Array.isArray(g.editor.selected) && g.editor.selected.length === 1 &&
    typeof g.editor.selected[0] === 'string' && g.editor.ready === true && g.editor.busy === false &&
    g.box && [g.box.x, g.box.y, g.box.width, g.box.height].every(finite) && g.box.width > 0 && g.box.height > 0 &&
    g.viewport && [g.viewport.x, g.viewport.y, g.viewport.zoom].every(finite) && g.viewport.zoom > 0 &&
    ['auto', 'light', 'dark'].includes(l.appearance) && ['comfortable', 'compact', 'spacious'].includes(l.density) &&
    typeof l.prefersDark === 'boolean' && finite(l.splitter);
}

function stateTransitionMatches(action, previousStroke) {
  const before = action.nativeState?.before, after = action.nativeState?.after, a = before?.gesture, b = after?.gesture, value = action.semantic;
  if (!a || !b || a.editor?.documentId !== b.editor?.documentId || a.editor?.revision !== b.editor?.revision ||
    before.layout.observedMs > b.observedMs) return false;
  if (action.kind !== 'layer' && !isDeepStrictEqual(a.editor.selected, b.editor.selected)) return false;
  if (action.kind === 'stroke') return a.editor.documentId === action.plan?.documentId && a.editor.revision === action.plan.revision &&
    a.editor.selected[0] === action.plan.selectedLayerId && isDeepStrictEqual(a.box, action.plan.state?.box) &&
    a.viewport.x === action.plan.state?.viewport?.x && a.viewport.y === action.plan.state?.viewport?.y && a.viewport.zoom === action.plan.state?.viewport?.zoom &&
    a.tool === 'Mask' && b.tool === 'Mask' && a.brushDiameter === 64 && b.brushDiameter === 64;
  if (action.kind === 'undo') return value?.draftId === previousStroke?.completion?.detail?.draftId &&
    value?.gestureOrdinal === previousStroke?.completion?.detail?.gestureOrdinal && value?.beforeOperationCount === 1 && value?.afterOperationCount === 0 && value?.buttonDisabled === true;
  if (action.kind === 'layer') return a.editor.selected[0] === value?.before && b.editor.selected[0] === value?.after && value.before !== value.after;
  if (action.kind === 'pan') return a.viewport.x === value?.before && b.viewport.x === value?.after && value.after - value.before === (action.variant ? -10 : 10);
  if (action.kind === 'zoom') return b.viewport.zoom === value?.zoom && a.viewport.zoom !== b.viewport.zoom;
  if (action.kind === 'split') return before.layout.splitter === value?.before && after.layout.splitter === value?.after &&
    value.direction === (action.variant ? -1 : 1) && value.direction * (value.after - value.before) > 0;
  if (action.kind === 'theme') return before.layout.appearance === value?.before && after.layout.appearance === value?.after && value.before !== value.after;
  if (action.kind === 'density') return before.layout.density === value?.before && after.layout.density === value?.after && value.before !== value.after;
  return false;
}
const expectedSteps = action => action.kind === 'undo' || action.kind === 'layer' ? ['activate'] :
  action.kind === 'zoom' ? ['select-all', 'enter-value', 'commit'] : action.kind === 'pan' ? ['pan'] :
  action.kind === 'split' ? ['resize'] : action.kind === 'theme' && action.semantic?.after === 'light' ? ['select-edge', 'select-light', 'commit'] : ['select-edge', 'commit'];

function expectedDiscreteDescriptor(action, stepId, sessionId, protocol) {
  let target, input;
  if (action.kind === 'undo') {target = {control: 'mask-undo'}; input = {kind: 'click'};}
  else if (action.kind === 'layer') {
    const layer = protocol?.eligibleLayers?.find(value => value.id === action.semantic?.after);
    target = {control: 'layer-row', rowIndex: layer?.rowIndex, layerId: layer?.id}; input = {kind: 'click'};
  } else if (action.kind === 'zoom') {
    target = {control: 'zoom-percentage'};
    input = stepId === 'enter-value' ? {kind: 'press-sequentially', text: String(protocol?.zoomPercentages?.[action.variant])} :
      {kind: 'press', keyName: stepId === 'select-all' ? 'ControlOrMeta+A' : 'Tab'};
  } else if (action.kind === 'pan' || action.kind === 'split') {
    target = {control: action.kind === 'pan' ? 'document-canvas' : 'request-panel-width'};
    input = {kind: 'press', keyName: action.variant ? 'ArrowLeft' : 'ArrowRight'};
  } else {
    target = {control: action.kind === 'theme' ? 'appearance' : 'density'};
    input = {kind: 'press', keyName: stepId === 'commit' ? 'Tab' : stepId === 'select-light' ? 'ArrowDown' :
      ['dark', 'spacious'].includes(action.semantic?.after) ? 'End' : 'Home'};
  }
  return discreteInputDescriptor({sessionId, actionId: 'action-' + action.index, family: action.kind, stepId, target, input});
}

/** Declare the original completed P-I inventory using retained identities only.
 * This deliberately does not repeat the full input/public-state projection,
 * and supplies no input-to-frame join or physical refresh-slot authority. */
export function genericRawFeedbackCohort(observed, {sessionId}) {
  demand(identifier(sessionId) && (observed?.sessionId === undefined || observed.sessionId === sessionId), 'Generic cohort session identity differs');
  demand(observed?.clock === 'browser-performance' && finite(observed.timeOrigin) && observed.timeOrigin > 0 &&
    finite(observed.startMs) && observed.endMs === observed.startMs + 60000 && finite(observed.captureStoppedMs) &&
    observed.captureStoppedMs >= observed.endMs && observed.status !== 'FAIL', 'Incomplete original generic observation window');
  demand(Array.isArray(observed.actions) && observed.actions.length === 100, 'Incomplete generic action inventory');
  const inventory = genericInteractionInventory(), ids = new Set();
  let lastInputMs = observed.startMs;
  const retainedId = id => {
    demand(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(id) && !ids.has(id), 'Invalid or duplicate retained generic identity');
    ids.add(id); return id;
  };
  const input = value => {
    demand(finite(value) && value >= lastInputMs && value <= observed.endMs, 'Generic input outside original window or order');
    lastInputMs = value;
  };
  const actions = Array.from(observed.actions, (action, sequence) => {
    const expected = inventory[sequence];
    demand(action?.kind === expected.kind && action.index === expected.index &&
      (expected.ordinal === undefined || action.ordinal === expected.ordinal && action.variant === expected.variant) &&
      action.outcome === 'completed' && action.meaningful === true && action.validation?.status !== 'FAIL',
    'Generic action order or completion differs');
    if (action.kind === 'stroke') {
      const dispatches = action.pointerDispatches, schedule = action.pointerSchedule, native = action.native, completion = action.completion;
      demand(Array.isArray(dispatches) && dispatches.length === 120 && Array.isArray(schedule?.samples) && schedule.samples.length === 120 &&
        schedule.clock === 'runner-monotonic' && schedule.frequencyHz === 60 && Array.isArray(action.plan?.points) && action.plan.points.length === 120 &&
        native?.clock === observed.clock && native.timeOrigin === observed.timeOrigin && Array.isArray(native.events) && native.events.length === 120 &&
        native.overflow === false && native.cancelled === false && completion?.detail?.sampleCount === 120 &&
        completion.detail.inputDownMs === native.events[0]?.inputMs && completion.detail.inputUpMs === native.events[119]?.inputMs &&
        finite(completion.startMs) && completion.startMs >= native.events[119]?.inputMs && completion.startMs <= observed.endMs &&
        action.inputMs === native.events[0]?.inputMs, 'Incomplete original stroke receipts');
      const id = retainedId(action.specimenId);
      const sampleIds = Array.from(dispatches, (step, index) => {
        const descriptor = genericPointerDescriptor(step?.descriptor), timing = schedule.samples[index], point = action.plan.points[index], event = native.events[index];
        demand(descriptor.sessionId === sessionId && descriptor.actionSequence === sequence && descriptor.specimenId === id && descriptor.sampleIndex === index &&
          descriptor.x === point.x && descriptor.y === point.y && descriptor.type === event.type &&
          step.nativeActionId === genericNativeActionId(descriptor) && step.dispatchCompleted === true && step.clock === 'runner-monotonic' &&
          timing?.index === index && [timing.scheduledMs, timing.dispatchStartedMs, timing.dispatchCompletedMs].every(finite) &&
          timing.dispatchStartedMs >= timing.scheduledMs && timing.dispatchCompletedMs >= timing.dispatchStartedMs &&
          timing.dispatchStartedMs === step.dispatchStartedMs && timing.dispatchCompletedMs === step.dispatchCompletedMs &&
          (!index || timing.dispatchStartedMs >= schedule.samples[index - 1].dispatchCompletedMs &&
            Math.abs(timing.scheduledMs - schedule.samples[0].scheduledMs - index * 1000 / 60) <= 1e-7),
        'Incomplete or changed retained stroke dispatch');
        input(event.inputMs); return retainedId(step.nativeActionId);
      });
      return {id, kind: 'stroke', sampleHz: schedule.frequencyHz, sampleIds};
    }
    const receipt = action.discreteInput, steps = receipt?.steps, expectedIds = expectedSteps(action);
    demand(receipt?.sessionId === sessionId && receipt.actionId === 'action-' + action.index && receipt.family === action.kind &&
      receipt.clock === observed.clock && receipt.timeOrigin === observed.timeOrigin && receipt.status === 'PASS' &&
      Array.isArray(steps) && steps.length === expectedIds.length && action.inputMs === receipt.inputMs &&
      receipt.inputMs === steps[0]?.inputEvidence?.inputMs, 'Incomplete original discrete action receipt');
    for (const [index, step] of steps.entries()) {
      const descriptor = step.inputEvidence?.descriptor;
      demand(step.dispatchCompleted === true && Array.isArray(step.inputEvidence?.events) && step.inputEvidence.events.length <= 128 &&
        step.inputEvidence.timeOrigin === observed.timeOrigin &&
        isDeepStrictEqual(descriptor, expectedDiscreteDescriptor(action, expectedIds[index], sessionId, observed.inputProtocol)) &&
        validateDiscreteInput(step.inputEvidence, descriptor).status === 'PASS', 'Incomplete or changed retained discrete dispatch');
      for (const event of step.inputEvidence.events) input(event.timeStampMs);
    }
    return {id: retainedId(receipt.actionId), kind: 'discrete'};
  });
  return {profile: 'P-I', durationMs: observed.endMs - observed.startMs, refreshHz: 60, actions,
    source: 'original-completed-action-receipt', observedExecution: false, qualification: false};
}

/** Recompute input/state projection from full raw browser observations. A
 * PASS here means complete input binding only, never performance acceptance. */
export function projectGenericInteraction(observed, {sessionId}) {
  demand(identifier(sessionId), 'Generic projection session identity is absent');
  const missing = [], failures = [], actions = [], inventory = genericInteractionInventory();
  if (observed?.clock !== 'browser-performance' || !finite(observed.timeOrigin) || observed.timeOrigin <= 0 ||
    !finite(observed.startMs) || observed.endMs !== observed.startMs + 60000 ||
    !finite(observed.captureStoppedMs) || observed.captureStoppedMs < observed.endMs) missing.push('original-sixty-second-browser-window-unavailable');
  const raw = Array.isArray(observed?.actions) ? observed.actions : [];
  const protocol = observed?.inputProtocol;
  if (!protocol?.document || !Array.isArray(protocol.eligibleLayers) || protocol.eligibleLayers.length < 2 ||
    !Array.isArray(protocol.zoomPercentages) || protocol.zoomPercentages.length !== 2 || !protocol.zoomPercentages.every(finite)) missing.push('prepared-input-protocol-unavailable');
  if (raw.length !== 100) missing.push('complete-hundred-action-workload-unavailable');
  let previousStroke = null, priorUndo = null, priorCompletion = null, lastBrowserInput = observed?.startMs;
  for (const [sequence, action] of raw.entries()) {
    const planned = inventory[sequence];
    if (!planned || action.kind !== planned.kind || action.index !== planned.index || planned.ordinal !== undefined &&
      (action.ordinal !== planned.ordinal || action.variant !== planned.variant)) failures.push('action-inventory-or-order-differs');
    const identity = {sessionId, sequence, family: action.kind, sourceActionIndex: action.index,
      ...(action.kind === 'stroke' ? {specimenId: action.specimenId} : {})};
    const state = {sequence, family: action.kind, protocol, before: stableState(action.nativeState?.before), after: stableState(action.nativeState?.after),
      transition: action.kind === 'stroke' ? {specimenId: action.specimenId, document: action.plan?.document,
        selectedLayerId: action.plan?.selectedLayerId, points: action.plan?.points,
        geometrySha256: action.completion?.detail?.geometrySha256 ?? null,
        targetLayerId: action.completion?.detail?.targetLayerId ?? null, targetLayerVersion: action.completion?.detail?.targetLayerVersion ?? null} : semanticState(action, previousStroke)};
    const stateSha256 = hash(state), dispatches = [], endpoints = [];
    if (!state.before || !state.after) missing.push('public-action-state-binding-unavailable');
    const stateAvailable = ['before', 'after'].every(side => validPublicState(action.nativeState?.[side], observed));
    if (!stateAvailable) missing.push('same-visible-action-state-clock-unavailable');
    else if (!stateTransitionMatches(action, previousStroke)) failures.push('public-action-state-transition-differs');
    if (state.before?.documentId !== protocol?.document?.id || state.after?.documentId !== protocol?.document?.id ||
      state.before?.revision !== protocol?.document?.revision || state.after?.revision !== protocol?.document?.revision) missing.push('prepared-document-state-binding-unavailable');
    if (action.kind === 'stroke') {
      let checked;
      try {checked = validateRecordedStroke({observation: action.native, plan: action.plan, completion: action.completion,
        priorCompletion, priorUndo, requireEmptyDraft: true});} catch {checked = {status: 'INCONCLUSIVE', missing: ['stroke-replay-unavailable'], failures: []};}
      missing.push(...checked.missing); failures.push(...checked.failures);
      const schedule = action.pointerSchedule, points = action.pointerDispatches ?? [], events = action.native?.events ?? [];
      if (action.native?.timeOrigin !== observed.timeOrigin || schedule?.clock !== 'runner-monotonic' || schedule.frequencyHz !== 60 ||
        schedule.samples?.length !== 120 || points.length !== 120 || events.length !== 120) missing.push('complete-stroke-dispatch-event-binding-unavailable');
      for (let index = 0; index < 120; index++) {
        const step = points[index], event = events[index], timing = schedule?.samples?.[index], point = action.plan?.points?.[index];
        let descriptor;
        try {descriptor = genericPointerDescriptor({schemaVersion: 1, sessionId, actionSequence: sequence, family: 'stroke',
          specimenId: action.specimenId, sampleIndex: index, type: index === 0 ? 'pointerdown' : index === 119 ? 'pointerup' : 'pointermove', x: point?.x, y: point?.y});}
        catch {missing.push('stroke-point-identity-unavailable');}
        if (!step || !descriptor || !isDeepStrictEqual(step.descriptor, descriptor) || step.nativeActionId !== genericNativeActionId(descriptor) ||
          step.dispatchCompleted !== true) missing.push('stroke-dispatch-receipt-unavailable');
        if (!timing || timing.index !== index || ![timing.scheduledMs, timing.dispatchStartedMs, timing.dispatchCompletedMs].every(finite) ||
          timing.dispatchStartedMs < timing.scheduledMs || timing.dispatchCompletedMs < timing.dispatchStartedMs ||
          timing.dispatchStartedMs !== step?.dispatchStartedMs || timing.dispatchCompletedMs !== step?.dispatchCompletedMs ||
          index && Math.abs(timing.scheduledMs - schedule.samples[0].scheduledMs - index * 1000 / 60) > 1e-7) missing.push('original-pointer-schedule-unavailable');
        dispatches.push({nativeActionId: descriptor ? genericNativeActionId(descriptor) : null, descriptor: descriptor ?? null,
          bracket: step?.nativeBracket ?? null, event: event ? {...event, localEventId: sessionId + '/action-' + sequence + '/point-' + index,
            identityScope: 'campaign-local-ordered-delivery', physicalInput: false} : null, schedule: timing ?? null});
        endpoints.push({id: sessionId + '/action-' + sequence + '/point-' + index, subject: 'mask-stroke-prefix', ordinal: index,
          stateSha256: hash({stateSha256, prefixSamples: index + 1}), firstDispatch: index, lastDispatch: index,
          inputMs: event?.inputMs ?? null, inputClock: 'browser-performance', supported: true});
      }
      previousStroke = action; priorCompletion = action.completion; priorUndo = null;
    } else {
      const steps = action.discreteInput?.steps ?? [], expected = expectedSteps(action);
      if (steps.length !== expected.length) missing.push('complete-discrete-substep-chain-unavailable');
      for (const [index, step] of steps.entries()) {
        const descriptor = step.inputEvidence?.descriptor;
        let expectedDescriptor;
        try {expectedDescriptor = expectedDiscreteDescriptor(action, expected[index], sessionId, protocol);} catch {}
        let checked;
        try {checked = validateDiscreteInput(step.inputEvidence, descriptor);} catch {checked = {status: 'INCONCLUSIVE', failures: [], missing: ['discrete-input-replay-unavailable']};}
        missing.push(...checked.missing); failures.push(...checked.failures);
        if (!expectedDescriptor || !isDeepStrictEqual(descriptor, expectedDescriptor) || descriptor?.sessionId !== sessionId || descriptor.actionId !== 'action-' + action.index || descriptor.family !== action.kind ||
          descriptor.stepId !== expected[index] || step.dispatchCompleted !== true || step.inputEvidence?.timeOrigin !== observed.timeOrigin) missing.push('discrete-dispatch-identity-unavailable');
        dispatches.push({nativeActionId: descriptor ? genericNativeActionId(descriptor) : null, descriptor: descriptor ?? null,
          bracket: step.nativeBracket ?? null, inputEvidence: step.inputEvidence ?? null});
      }
      const actualInputMs = steps.find(step => step.inputEvidence?.inputMs !== null)?.inputEvidence?.inputMs ?? null;
      if (action.discreteInput?.inputMs !== actualInputMs || action.inputMs !== actualInputMs) missing.push('discrete-initiating-input-binding-unavailable');
      endpoints.push({id: sessionId + '/action-' + sequence, subject: action.kind + '-complete-action', ordinal: 0,
        stateSha256, firstDispatch: 0, lastDispatch: steps.length - 1, inputMs: action.discreteInput?.inputMs ?? null,
        inputClock: 'browser-performance', supported: true});
      if (action.kind === 'undo') priorUndo = {...action.semantic, native: action.native};
    }
    const inputTimes = dispatches.flatMap(step => step.event ? [step.event.inputMs] : step.inputEvidence?.events?.map(event => event.timeStampMs) ?? []);
    for (const time of inputTimes) {
      if (!finite(time) || time < lastBrowserInput || time > observed?.endMs) missing.push('input-outside-original-window-or-order');
      lastBrowserInput = time;
    }
    if (action.outcome !== 'completed') missing.push('product-action-completion-unavailable');
    actions.push({identity, state, stateSha256, dispatches, endpoints});
  }
  const counts = {actions: actions.length, discreteActions: actions.filter(a => a.identity.family !== 'stroke').length,
    pointerDispatches: actions.filter(a => a.identity.family === 'stroke').reduce((n, a) => n + a.dispatches.length, 0),
    discreteDispatches: actions.filter(a => a.identity.family !== 'stroke').reduce((n, a) => n + a.dispatches.length, 0)};
  if (!isDeepStrictEqual(counts, {actions: 100, discreteActions: 80, pointerDispatches: 2400, discreteDispatches: 125})) missing.push('full-fixed-dispatch-inventory-unavailable');
  return {kind: 'generic-browser-input-projection-1', profile: GENERIC_PROFILE, sessionId, status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS',
    scope: 'browser-input-and-public-state-only', qualification: false, automation: GENERIC_AUTOMATION,
    originalWindow: {startMs: observed?.startMs ?? null, endMs: observed?.endMs ?? null, captureStoppedMs: observed?.captureStoppedMs ?? null,
      clock: 'browser-performance', timeOrigin: observed?.timeOrigin ?? null},
    nativeSessionStart: observed?.nativeSessionStart ?? null, nativeSessionEnd: observed?.nativeSessionEnd ?? null,
    counts, actions, missing: [...new Set(missing)], failures: [...new Set(failures)]};
}

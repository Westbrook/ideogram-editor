import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {monotonic} from './common.mjs';
import {inspectTextPresentationWitness} from './text-presentation-observation.mjs';

export const TEXT_INPUT_PROFILE = 'interaction-text-106-247-60s-1';
export const TEXT_INPUT_COUNTS = Object.freeze({actions: 106, dispatches: 247, focus: 70, 'insert-delete': 40,
  caret: 10, 'semantic-selection': 10, 'text-format': 18, preedit: 70, 'composition-end': 23, presentation: 6,
  dispatchAcknowledgements: 494, windowAnchors: 2});
const demand = (value, reason) => {if (!value) throw Error(reason);};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const time = value => finite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_EVENTS = 128;
const EVENT_TYPES = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'beforeinput', 'input', 'change',
  'compositionstart', 'compositionupdate', 'compositionend', 'select', 'selectionchange', 'focus', 'blur', 'focusin', 'focusout'];
const KEY_NAMES = ['Backspace', 'Tab', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Shift', 'Control', 'Meta', 'Alt'];
const INPUT_TYPES = ['insertText', 'insertReplacementText', 'deleteContentBackward', 'deleteContentForward', 'insertCompositionText'];
const EVENT_FIELDS = ['eventId', 'ordinal', 'type', 'timeStampMs', 'observedMs', 'isTrusted', 'targetMatched', 'keyName', 'code', 'repeat', 'modifiers',
  'pointerId', 'pointerType', 'isPrimary', 'button', 'buttons', 'inputType', 'isComposing'];
const KEY_CODE = /^(?:Backspace|Tab|Home|End|ArrowLeft|ArrowRight|ShiftLeft|ShiftRight|ControlLeft|ControlRight|MetaLeft|MetaRight|AltLeft|AltRight|other)$/;
function freeze(value) {if (value && typeof value === 'object') {for (const item of Object.values(value)) freeze(item); Object.freeze(value);} return value;}

/** Fixed audit inventory only. It never supplies product text, dispatches an
 * event, inserts an action, or changes the original driver's cadence. */
export function buildTextInputInventory() {
  const actions = [];
  const step = (stepId, operation, control = 'text-content', input = {}, target = {}) => ({stepId, operation,
    target: {control, ...target}, input});
  const focus = () => step('focus', 'focus', 'text-content', {api: 'locator.focus', delivery: 'programmatic-focus'});
  const key = (stepId, operation, control, keyName) => step(stepId, operation, control, {api: 'locator.press', delivery: 'browser-input-api', keyName});
  const click = (stepId, operation, control, target = {}) => step(stepId, operation, control, {api: 'locator.click', delivery: 'browser-input-api'}, target);
  const synthetic = (stepId, operation, eventType) => step(stepId, operation, 'text-content',
    {api: 'locator.dispatchEvent', delivery: 'synthetic-dom-event', eventType});
  const evaluate = (stepId, operation, extra = {}) => step(stepId, operation, 'text-content',
    {api: 'locator.evaluate', delivery: 'programmatic-dom-api', ...extra});
  const add = (kind, details, steps) => actions.push({id: `IText-${String(actions.length + 1).padStart(3, '0')}`,
    sequence: actions.length, kind, ...details, scheduledMs: actions.length * 59400 / 106,
    steps: steps.map((value, sequence) => ({...value, sequence}))});
  for (let index = 0; index < 20; index++) {
    add('insert-delete', {mode: 'insert', fragment: index}, [focus(), step('edit', 'insert-text', 'text-content', {api: 'keyboard.insertText', delivery: 'browser-input-api'})]);
    add('insert-delete', {mode: 'delete'}, [focus(), key('edit', 'press-backspace', 'text-content', 'Backspace')]);
  }
  for (let index = 0; index < 10; index++) {
    const range = index < 3 ? ['forward', 'backward', 'none'][index] : null;
    const keyName = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Shift+ArrowLeft'][index % 5];
    add('caret', {range, keyName}, [focus(), range ? evaluate('caret', 'set-selection-range', {direction: range}) : key('caret', 'press-caret', 'text-content', keyName)]);
    if (range) add('presentation', {mode: 'immediate', range}, [click('switch', 'click-presentation', 'presentation-switch')]);
  }
  for (let index = 0; index < 10; index++) add('semantic-selection', {index: index % 2}, [click('activate', 'click-semantic', 'semantic-item', {rowIndex: index % 2})]);
  for (let index = 0; index < 10; index++) {
    let steps;
    if (index < 2) steps = [step('select-font', 'select-font', 'font-choice', {api: 'locator.selectOption', delivery: 'programmatic-control-api', option: ['NotoSans', 'NotoSansArabic'][index]}), click('apply-font', 'click-apply-font', 'use-selected-font')];
    else if (index < 8) {
      const control = ['line-height', 'frame-width', 'frame-height'][Math.floor((index - 2) / 2)];
      steps = [step('fill-format', 'fill-format', control, {api: 'locator.fill', delivery: 'browser-input-api', numericValue: ['1.3', '1.2', '350', '360', '170', '180'][index - 2]}), key('commit-format', 'press-tab', control, 'Tab')];
    } else steps = [key('adjust-bounds', 'press-bounds', 'semantic-bounds', index === 8 ? 'ArrowRight' : 'ArrowLeft')];
    add('text-format', {index}, steps);
  }
  for (let sequence = 0; sequence < 10; sequence++) {
    for (let index = 0; index < 2; index++) add('preedit', {sequenceInComposition: sequence, step: index}, [focus(),
      ...(index === 0 ? [synthetic('composition-start', 'dispatch-composition-start', 'compositionstart')] : []),
      evaluate('set-preedit', 'set-preedit-value'), synthetic('composition-update', 'dispatch-composition-update', 'compositionupdate'),
      synthetic('composition-input', 'dispatch-preedit-input', 'input')]);
    if (sequence === 8) {
      add('presentation', {mode: 'deferred'}, [click('switch', 'click-presentation', 'presentation-switch')]);
      add('presentation', {mode: 'deferred-latest'}, [click('switch', 'click-presentation', 'presentation-switch')]);
    }
    if (sequence === 9) add('presentation', {mode: 'deferred-cancelled'}, [click('switch', 'click-presentation', 'presentation-switch')]);
    const cancel = sequence === 7 || sequence === 9, cancelSession = sequence === 9;
    add('composition-end', {sequenceInComposition: sequence, mode: cancel ? 'cancel' : 'commit', cancelSession}, [
      ...(cancelSession ? [click('cancel-session', 'click-cancel-session', 'cancel-text-edit')] : []),
      ...(cancel ? [evaluate('restore-value', 'restore-composition-value')] : []),
      synthetic('composition-end', 'dispatch-composition-end', 'compositionend'), synthetic('composition-input', 'dispatch-composition-input', 'input')]);
  }
  return freeze(actions);
}
const INVENTORY = buildTextInputInventory();

/** Canonical finite identity. Caller-supplied operation/target/input fields may
 * confirm the inventory but cannot replace or extend it. */
export function textInputDescriptor(value) {
  demand(token(value?.sessionId), 'Invalid text input session identity');
  const action = INVENTORY.find(item => item.id === value.actionId);
  const step = action?.steps.find(item => item.stepId === value.stepId);
  demand(action && step, 'Unknown text action or substep identity');
  const result = {schemaVersion: 1, profile: TEXT_INPUT_PROFILE, sessionId: value.sessionId, actionId: action.id,
    actionSequence: action.sequence, family: action.kind, stepId: step.stepId, stepSequence: step.sequence,
    operation: step.operation, target: structuredClone(step.target), input: structuredClone(step.input)};
  for (const field of Object.keys(result)) if (value[field] !== undefined) demand(isDeepStrictEqual(value[field], result[field]), 'Text descriptor differs from fixed inventory: ' + field);
  return freeze(result);
}
export function textSessionNativeId(sessionId) {demand(token(sessionId), 'Invalid text input session identity'); return 'tis-' + digest(sessionId).slice(0, 48);}
export function textInputIdentity(requested) {
  const descriptor = textInputDescriptor(requested);
  return freeze({nativeSessionId: textSessionNativeId(descriptor.sessionId), nativeActionId: 'ti-' + digest(descriptor).slice(0, 48),
    localStepId: descriptor.sessionId + '/' + descriptor.actionId + '/' + descriptor.stepId});
}

const unavailable = (descriptor, reason) => freeze({kind: 'browser-text-input-1', schemaVersion: 1, descriptor,
  clock: 'browser-performance', status: 'INCONCLUSIVE', events: [], inputMs: null, initiatingEventIds: [],
  classification: {declaredDelivery: descriptor.input.delivery, observed: 'none', trustedEvents: 0, syntheticEvents: 0, physicalInput: false},
  missing: [reason], failures: [], qualification: false});

/** Replay actual event metadata; an empty observation is valid for a
 * programmatic call and never becomes invented browser-input provenance. */
export function validateTextInput(raw, requested) {
  const descriptor = textInputDescriptor(requested), missing = [], failures = [];
  const events = Array.isArray(raw?.events) ? raw.events.slice(0, MAX_EVENTS).map(event => event && typeof event === 'object' && !Array.isArray(event) ? event : {}) : [];
  if (!Array.isArray(raw?.events)) missing.push('text-event-records-unavailable');
  if (!isDeepStrictEqual(raw?.descriptor, descriptor)) failures.push('text-input-descriptor-mismatch');
  if (raw?.clock !== 'browser-performance' || !time(raw.timeOrigin) || raw.timeOrigin === 0 || raw.endedTimeOrigin !== raw.timeOrigin ||
    !time(raw.armedMs) || !time(raw.stoppedMs) || raw.stoppedMs < raw.armedMs) missing.push('same-browser-clock-unavailable');
  if (raw?.visibility !== 'visible' || raw?.endedVisibility !== 'visible') missing.push('visible-text-input-context-unavailable');
  if (raw?.targetConnectedAtArm !== true || typeof raw?.targetConnected !== 'boolean') missing.push('text-input-target-observation-unavailable');
  if (raw?.overflow || raw?.events?.length > MAX_EVENTS) failures.push('text-input-event-overflow');
  const prefix = textInputIdentity(descriptor).localStepId + '/event-';
  for (const [index, event] of events.entries()) {
    if (event.eventId !== prefix + index || event.ordinal !== index || !EVENT_TYPES.includes(event.type) || event.targetMatched !== true || typeof event.isTrusted !== 'boolean') failures.push('text-event-identity-or-target-invalid');
    if (!time(event.timeStampMs) || !time(event.observedMs) || event.timeStampMs < raw.armedMs || event.timeStampMs > event.observedMs || event.observedMs > raw.stoppedMs ||
      index && (event.timeStampMs < events[index - 1].timeStampMs || event.observedMs < events[index - 1].observedMs)) missing.push('ordered-text-event-times-unavailable');
    if (Object.keys(event).some(name => !EVENT_FIELDS.includes(name))) failures.push('text-content-payload-not-admitted');
    if (event.keyName !== undefined && ![...KEY_NAMES, 'other'].includes(event.keyName)) failures.push('unbounded-key-name');
    if (event.inputType !== undefined && ![...INPUT_TYPES, 'other'].includes(event.inputType)) failures.push('unbounded-input-type');
    if (event.code !== undefined && (typeof event.code !== 'string' || !KEY_CODE.test(event.code))) failures.push('unbounded-key-code');
    if (event.repeat !== undefined && typeof event.repeat !== 'boolean' || event.isComposing !== undefined && typeof event.isComposing !== 'boolean') failures.push('invalid-event-boolean');
    if (event.modifiers !== undefined && (!event.modifiers || Object.keys(event.modifiers).length !== 4 ||
      !['control', 'meta', 'shift', 'alt'].every(name => typeof event.modifiers[name] === 'boolean'))) failures.push('invalid-event-modifiers');
    if (event.pointerType !== undefined && !['mouse', 'pen', 'touch', ''].includes(event.pointerType) ||
      event.pointerId !== undefined && !Number.isSafeInteger(event.pointerId) || event.isPrimary !== undefined && typeof event.isPrimary !== 'boolean' ||
      event.button !== undefined && (!Number.isSafeInteger(event.button) || event.button < -1 || event.button > 5) ||
      event.buttons !== undefined && (!integer(event.buttons) || event.buttons > 63)) failures.push('invalid-pointer-metadata');
  }
  const canonicalEvents = events.map((event, index) => {
    const result = {eventId: event.eventId === prefix + index ? event.eventId : null, ordinal: integer(event.ordinal) ? event.ordinal : null,
      type: EVENT_TYPES.includes(event.type) ? event.type : 'other', timeStampMs: time(event.timeStampMs) ? event.timeStampMs : null,
      observedMs: time(event.observedMs) ? event.observedMs : null, isTrusted: typeof event.isTrusted === 'boolean' ? event.isTrusted : null,
      targetMatched: typeof event.targetMatched === 'boolean' ? event.targetMatched : null};
    if (event.keyName !== undefined) result.keyName = KEY_NAMES.includes(event.keyName) ? event.keyName : 'other';
    if (event.code !== undefined) result.code = typeof event.code === 'string' && KEY_CODE.test(event.code) ? event.code : 'other';
    for (const name of ['repeat', 'isComposing', 'isPrimary']) if (event[name] !== undefined) result[name] = typeof event[name] === 'boolean' ? event[name] : null;
    if (event.inputType !== undefined) result.inputType = INPUT_TYPES.includes(event.inputType) ? event.inputType : 'other';
    if (event.pointerType !== undefined) result.pointerType = ['mouse', 'pen', 'touch', ''].includes(event.pointerType) ? event.pointerType : '';
    for (const name of ['pointerId', 'button', 'buttons']) if (event[name] !== undefined) result[name] = Number.isSafeInteger(event[name]) ? event[name] : null;
    if (event.modifiers !== undefined) result.modifiers = Object.fromEntries(['control', 'meta', 'shift', 'alt'].map(name => [name, event.modifiers?.[name] === true]));
    return result;
  });
  const initiators = canonicalEvents.filter(event => event.isTrusted === true && ['pointerdown', 'keydown', 'beforeinput', 'input'].includes(event.type));
  const trustedEvents = events.filter(event => event.isTrusted === true).length, syntheticEvents = events.filter(event => event.isTrusted === false).length;
  return freeze({kind: 'browser-text-input-1', schemaVersion: 1, descriptor, clock: 'browser-performance',
    timeOrigin: raw?.timeOrigin ?? null, endedTimeOrigin: raw?.endedTimeOrigin ?? null, armedMs: raw?.armedMs ?? null, stoppedMs: raw?.stoppedMs ?? null,
    visibility: raw?.visibility ?? null, endedVisibility: raw?.endedVisibility ?? null,
    targetConnectedAtArm: raw?.targetConnectedAtArm === true, targetConnected: raw?.targetConnected === true, overflow: raw?.overflow === true,
    events: canonicalEvents,
    inputMs: initiators[0]?.timeStampMs ?? null, initiatingEventIds: initiators.map(event => event.eventId),
    classification: {declaredDelivery: descriptor.input.delivery, observed: trustedEvents && syntheticEvents ? 'mixed' : trustedEvents ? 'trusted-events' : syntheticEvents ? 'synthetic-events' : 'none', trustedEvents, syntheticEvents, physicalInput: false},
    status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS', missing: [...new Set(missing)], failures: [...new Set(failures)], qualification: false});
}

/** Passive document observer matches the explicit native/control element in
 * composedPath. Unrelated document traffic is ignored. Target departure and
 * zero events remain explicit. Nothing reads text/value/data or infers paint. */
export async function installTextInputObserver(page, {sessionId}) {
  demand(token(sessionId), 'Invalid text observer session');
  const key = '__IDEOGRAM_CAMPAIGN_TEXT_INPUT__';
  await page.evaluate(({key, sessionId, maxEvents, types, keys, inputTypes}) => {
    if (Object.hasOwn(globalThis, key)) throw Error('Text observer already installed');
    let current = null;
    const listener = event => {
      if (!current || !event.composedPath().includes(current.target)) return;
      if (current.events.length >= maxEvents) {current.overflow = true; return;}
      const ordinal = current.events.length;
      const row = {eventId: `${sessionId}/${current.descriptor.actionId}/${current.descriptor.stepId}/event-${ordinal}`, ordinal,
        type: event.type, timeStampMs: event.timeStamp, observedMs: performance.now(), isTrusted: event.isTrusted, targetMatched: true};
      if (event instanceof KeyboardEvent) Object.assign(row, {keyName: keys.includes(event.key) ? event.key : 'other',
        code: /^(?:Backspace|Tab|Home|End|ArrowLeft|ArrowRight|ShiftLeft|ShiftRight|ControlLeft|ControlRight|MetaLeft|MetaRight|AltLeft|AltRight)$/.test(event.code) ? event.code : 'other',
        repeat: event.repeat, modifiers: {control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey}});
      if (event instanceof PointerEvent) Object.assign(row, {pointerId: event.pointerId, pointerType: event.pointerType,
        isPrimary: event.isPrimary, button: event.button, buttons: event.buttons});
      if (event instanceof InputEvent) Object.assign(row, {inputType: inputTypes.includes(event.inputType) ? event.inputType : 'other', isComposing: event.isComposing});
      current.events.push(row);
    };
    for (const type of types) document.addEventListener(type, listener, {capture: true, passive: true});
    Object.defineProperty(globalThis, key, {configurable: true, value: {
      begin(target, descriptor) {
        if (current || descriptor.sessionId !== sessionId || !(target instanceof Element) || !target.isConnected) throw Error('Text observer cannot arm');
        current = {target, descriptor, events: [], overflow: false, clock: 'browser-performance', targetConnectedAtArm: true,
          timeOrigin: performance.timeOrigin, armedMs: performance.now(), visibility: document.visibilityState};
      },
      end() {
        if (!current) throw Error('Text observer is not armed');
        const {target, ...result} = current; current = null;
        return {...result, stoppedMs: performance.now(), endedTimeOrigin: performance.timeOrigin, endedVisibility: document.visibilityState, targetConnected: target.isConnected};
      },
      close() {for (const type of types) document.removeEventListener(type, listener, {capture: true}); current = null; delete globalThis[key];},
    }});
  }, {key, sessionId, maxEvents: MAX_EVENTS, types: EVENT_TYPES, keys: KEY_NAMES, inputTypes: INPUT_TYPES});
  return {
    async begin(target, requested) {
      const descriptor = textInputDescriptor(requested);
      demand(descriptor.sessionId === sessionId, 'Text observer session differs');
      await target.evaluate((element, {key, descriptor}) => globalThis[key].begin(element, descriptor), {key, descriptor});
    },
    end: () => page.evaluate(key => globalThis[key].end(), key),
    close: () => page.evaluate(key => globalThis[key]?.close(), key),
  };
}

/** hook({descriptor,run}) -> {value:await run(),bracket}. Dispatch executes once
 * even if instrumentation fails. Original primitive/frozen errors survive and
 * failed receipts reach retain. Late run calls cannot mutate frozen evidence. */
export async function runTextInputStep({observer, target, descriptor: requested, dispatch, hook, retain}) {
  const descriptor = textInputDescriptor(requested), missing = [];
  demand(typeof dispatch === 'function' && (hook === undefined || typeof hook === 'function'), 'Invalid text dispatch seam');
  let promise, value, productError, failed = false, open = true, started = false, hookResult;
  const run = () => {
    if (!open) throw Error('Text input may dispatch once');
    if (started) {missing.push('text-hook-repeated-dispatch'); throw Error('Text input may dispatch once');}
    started = true;
    promise = (async () => {
      let armed = false, raw;
      try {if (observer) {await observer.begin(target, descriptor); armed = true;}} catch {missing.push('text-observer-arm-failed');}
      const dispatchStartedMs = monotonic();
      let productValue;
      try {productValue = await dispatch();} catch (error) {failed = true; productError = error;}
      const dispatchCompletedMs = monotonic();
      if (armed) try {raw = await observer.end();} catch {missing.push('text-observer-drain-failed');}
      let inputEvidence;
      try {inputEvidence = raw ? validateTextInput(raw, descriptor) : unavailable(descriptor, 'text-observation-unavailable');}
      catch {inputEvidence = unavailable(descriptor, 'text-observation-validation-failed');}
      value = freeze({dispatchCompleted: !failed, dispatchStartedMs, dispatchCompletedMs, clock: 'runner-monotonic', inputEvidence});
      // The product value is kept outside serialized/frozen evidence.
      productResult = productValue;
      if (failed) throw productError;
      return value;
    })();
    promise.catch(() => {}); return promise;
  };
  let productResult;
  if (hook) {
    try {hookResult = await hook({descriptor, run});} catch {missing.push('text-hook-failed');}
    if (!promise) missing.push('text-hook-did-not-dispatch');
  }
  if (!promise) run();
  open = false; try {await promise;} catch {}
  let nativeBracket = null;
  if (hook && !missing.some(reason => reason.startsWith('text-hook'))) try {
    demand(hookResult?.value === value, 'Text hook result differs');
    const bytes = JSON.stringify(hookResult.bracket);
    demand(typeof bytes === 'string' && bytes.length <= 16384, 'Text native bracket is absent or oversized');
    nativeBracket = JSON.parse(bytes);
  } catch {missing.push('text-hook-evidence-unavailable');}
  const receipt = freeze({...value, descriptor, nativeActionId: textInputIdentity(descriptor).nativeActionId,
    nativeBracket, nativeBracketVerified: false, missing: [...missing], qualification: false});
  try {retain?.(receipt);} catch {}
  if (failed) throw productError;
  return {value: productResult, receipt};
}

const nativeFields = ['connected', 'start', 'end', 'direction', 'units', 'presentation', 'focused', 'textVersion', 'switch'];
const publicNativeFields = [...nativeFields, 'session', 'revision'];
const normalizeNative = native => native ? Object.fromEntries(nativeFields.map(name => [name, structuredClone(native[name])])) : null;
function stableWitness(value) {
  if (!value) return null;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
    ['before', 'after', 'beforeEnd', 'afterEnd', 'beforeCancel', 'afterCancel'].includes(name) ? normalizeNative(item) : structuredClone(item)]));
}
function stableState(state) {
  if (!state?.native || !state?.format) return null;
  return {native: normalizeNative(state.native),
    contentSha256: state.contentSha256, semanticSelection: state.semanticSelection,
    format: {fontChoice: state.format.fontChoice, lineHeight: state.format.lineHeight, frameWidth: state.format.frameWidth, frameHeight: state.format.frameHeight}};
}
function validState(state, terminal = false) {
  const native = state?.native, format = state?.format, sw = native?.switch;
  return state?.clock === 'browser-performance' && time(state.timeOrigin) && state.timeOrigin > 0 && time(state.observedMs) && state.visibility === 'visible' &&
    sha(state.contentSha256) && (state.semanticSelection === null || token(state.semanticSelection)) && native?.connected === true && integer(native.textVersion) &&
    integer(native.start) && integer(native.end) && integer(native.units) && native.start <= native.end && native.end <= native.units &&
    ['forward', 'backward', 'none'].includes(native.direction) && ['anchored', 'inspector'].includes(native.presentation) &&
    typeof native.session === 'string' && native.session.length <= 256 && typeof native.revision === 'string' && /^(0|[1-9][0-9]*)$/.test(native.revision) && native.revision.length <= 128 && typeof native.focused === 'boolean' &&
    sw && ['', 'anchored', 'inspector'].includes(sw.pending) && ['request', 'requestEpoch', 'requestGeneration', 'requestTextVersion', 'settled', 'rejected', 'superseded'].every(name => integer(sw[name])) &&
    ['rejectedEpoch', 'rejectedGeneration', 'rejectedCurrentEpoch', 'rejectedCurrentGeneration', 'rejectedTextVersion', 'rejectedCurrentTextVersion'].every(name => sw[name] === null || integer(sw[name])) &&
    integer(sw.rejectedGuards) && sw.rejectedGuards <= 15 && typeof sw.rejectedBoundary === 'string' && sw.rejectedBoundary.length <= 64 &&
    (sw.reason === null || typeof sw.reason === 'string' && sw.reason.length <= 128) &&
    (terminal && native.session === '' && format?.fontChoice === null || typeof format?.fontChoice === 'string' && format.fontChoice.length > 0 && format.fontChoice.length <= 128) &&
    ['lineHeight', 'frameWidth', 'frameHeight'].every(name => terminal && native.session === '' && format?.[name] === null ||
      typeof format?.[name] === 'string' && /^(?:[0-9]+)(?:\.[0-9]+)?$/.test(format[name]) && Number(format[name]) > 0);
}
// Existing witness reads occur inside added snapshots. Focus and revision can
// advance between those reads; bind meaningful state and enclose revisions.
function witnessBound(value, snapshot, before, after) {
  if (!value || !snapshot?.native || !before?.native || !after?.native) return false;
  const fields = publicNativeFields.filter(name => !['focused', 'revision'].includes(name));
  if (!fields.every(name => isDeepStrictEqual(value[name], snapshot.native[name]))) return false;
  return [value.revision, before.native.revision, after.native.revision].every(revision => typeof revision === 'string' && /^(0|[1-9][0-9]*)$/.test(revision)) &&
    BigInt(value.revision) >= BigInt(before.native.revision) && BigInt(value.revision) <= BigInt(after.native.revision);
}
function fixtureMetadata(value) {
  const prefixed = item => typeof item === 'string' && /^sha256:[a-f0-9]{64}$/.test(item);
  const corpus = value?.corpus, fonts = value?.fonts;
  if (value?.schema !== 'browser-text-fixture-1' || !prefixed(value.manifestHash) || !prefixed(corpus?.sha256) ||
    !integer(corpus?.bytes) || corpus.bytes === 0 || !prefixed(corpus?.fragmentsHash) || !integer(corpus?.fragmentCount) || corpus.fragmentCount < 20 ||
    !Array.isArray(corpus?.scripts) || corpus.scripts.length > 32 || !corpus.scripts.every(token) ||
    !['latin-combining', 'arabic-rtl', 'devanagari', 'cjk', 'emoji', 'newlines', 'unbroken'].every(script => corpus.scripts.includes(script)) ||
    !Array.isArray(fonts) || ![4, 16].includes(fonts.length) || fonts.some(font => !token(font?.id) || !prefixed(font.sha256) || !integer(font.bytes) || font.bytes === 0 ||
      !['bundled', 'local'].includes(font.kind) || !(font.licenseSha256 === null || prefixed(font.licenseSha256))) ||
    !prefixed(value.semanticItemIdsHash) || !(value.activeLayerId === null || token(value.activeLayerId)) ||
    !(value.activeLayerIndex === null || integer(value.activeLayerIndex)) || typeof value.fontSetPreseeded !== 'boolean') return null;
  return {schema: value.schema, manifestHash: value.manifestHash,
    corpus: {sha256: corpus.sha256, bytes: corpus.bytes, fragmentsHash: corpus.fragmentsHash, fragmentCount: corpus.fragmentCount, scripts: [...corpus.scripts]},
    fonts: fonts.map(font => ({id: font.id, sha256: font.sha256, bytes: font.bytes, kind: font.kind, licenseSha256: font.licenseSha256})),
    semanticItemIdsHash: value.semanticItemIdsHash, activeLayerId: value.activeLayerId, activeLayerIndex: value.activeLayerIndex, fontSetPreseeded: value.fontSetPreseeded};
}

/** Strict source receipt projection. PASS means complete input/state binding,
 * never display proof, native ACK verification, or performance acceptance. */
export function projectTextInteraction(raw, {sessionId}) {
  demand(token(sessionId), 'Invalid text projection session identity');
  const missing = [], failures = [], actions = [], segment = raw?.segment;
  if (segment?.clock !== 'runner-monotonic' || !time(segment.startMs) || segment.endMs !== segment.startMs + 60000 || segment.requestedMs !== 60000 ||
    !time(segment.captureStoppedMs) || segment.captureStoppedMs < segment.endMs || !time(segment.completedActionsAtMs) ||
    segment.completedActionsAtMs > 60000 || segment.actions !== 106) missing.push('original-sixty-second-runner-window-unavailable');
  const source = Array.isArray(raw?.actions) ? raw.actions : [];
  const textFixture = fixtureMetadata(raw?.textFixture);
  if (!textFixture || !isDeepStrictEqual(textFixture, raw?.textFixture)) missing.push('complete-sealed-text-fixture-metadata-unavailable');
  const semanticItemIds = Array.isArray(raw?.semanticItemIds) && raw.semanticItemIds.length >= 2 && raw.semanticItemIds.length <= 10000 && raw.semanticItemIds.every(token) ? [...raw.semanticItemIds] : null;
  const sealedSemanticItemIds = Array.isArray(raw?.sealedSemanticItemIds) && raw.sealedSemanticItemIds.length >= 2 && raw.sealedSemanticItemIds.length <= 10000 && raw.sealedSemanticItemIds.every(token) ? [...raw.sealedSemanticItemIds] : null;
  if (!semanticItemIds || !sealedSemanticItemIds || new Set(semanticItemIds).size !== semanticItemIds.length ||
    new Set(sealedSemanticItemIds).size !== sealedSemanticItemIds.length || 'sha256:' + digest(sealedSemanticItemIds) !== textFixture?.semanticItemIdsHash ||
    !sealedSemanticItemIds.every(id => semanticItemIds.includes(id)) || !sealedSemanticItemIds.slice(0, 2).every((id, index) => id === semanticItemIds[index])) missing.push('sealed-public-semantic-row-inventory-unavailable');
  if (raw?.native?.overflow === true) missing.push('original-text-native-observer-overflow');
  const nativeContinuity = {sameNode: raw?.native?.sameNode ?? null, sameConnectedParent: raw?.native?.sameConnectedParent ?? null,
    disconnected: raw?.native?.disconnected ?? null, sameConnectedNode: raw?.textPresentation?.sameConnectedNode ?? null};
  if (nativeContinuity.sameNode !== true || nativeContinuity.sameConnectedParent !== true || nativeContinuity.disconnected !== false ||
    nativeContinuity.sameConnectedNode !== true) missing.push('original-connected-text-node-continuity-unavailable');
  if (raw?.textInputSessionId !== sessionId) failures.push('text-input-session-binding-differs');
  if (source.length !== INVENTORY.length) missing.push('complete-text-action-inventory-unavailable');
  let previousRunnerEnd = segment?.startMs, previousBrowserEnd = null, browserOrigin = null, previousRevision = null, previousTextVersion = null, dispatchCount = 0;
  const initial = source[0]?.nativeInput?.before;
  const baseline = initial ? {session: initial.native?.session ?? null, revision: initial.native?.revision ?? null,
    switch: structuredClone(initial.native?.switch ?? null)} : null;
  if (initial?.contentSha256 !== textFixture?.corpus.sha256.slice(7)) failures.push('initial-text-content-fixture-identity-differs');
  const witness = raw?.presentationWitness;
  let presentation;
  try {presentation = inspectTextPresentationWitness(witness);} catch {presentation = {missing: ['text-presentation-witness-unavailable'], failures: []};}
  missing.push(...presentation.missing); failures.push(...presentation.failures);
  const expectedRequests = INVENTORY.filter(action => action.kind === 'presentation');
  if (!Array.isArray(witness?.requests) || witness.requests.length !== 6 || witness.requests.some((request, index) => request.actionId !== expectedRequests[index]?.id)) failures.push('text-presentation-request-action-identity-differs');
  for (const [sequence, action] of source.entries()) {
    const plan = INVENTORY[sequence];
    if (!plan || action.id !== plan.id || action.kind !== plan.kind || action.scheduledMs !== plan.scheduledMs) failures.push('text-action-inventory-or-order-differs');
    if (action.outcome !== 'completed') failures.push('text-product-action-incomplete');
    if (![action.inputMs, action.readyMs, action.durationMs].every(time) || action.inputMs < segment?.startMs + (plan?.scheduledMs ?? 0) ||
      action.inputMs < previousRunnerEnd || action.readyMs < action.inputMs || action.durationMs !== action.readyMs - action.inputMs || action.readyMs > segment?.endMs) missing.push('ordered-text-action-runner-times-unavailable');
    if (action.scheduledAtMs !== segment?.startMs + plan?.scheduledMs || action.inputLatenessMs !== Math.max(0, action.inputMs - action.scheduledAtMs)) missing.push('original-text-action-lateness-unavailable');
    previousRunnerEnd = action.readyMs;
    const before = action.nativeInput?.before, after = action.nativeInput?.after;
    if (!validState(before) || !validState(after, plan?.cancelSession === true)) missing.push('complete-public-text-state-unavailable');
    if (plan?.kind === 'semantic-selection' && (!semanticItemIds || after?.semanticSelection !== semanticItemIds[plan.index])) failures.push('text-semantic-clicked-row-state-differs');
    if (!baseline?.session || before?.native?.session !== baseline.session || after?.native?.session !== (plan?.cancelSession ? '' : baseline.session)) failures.push('text-native-session-continuity-differs');
    if (validState(before) && validState(after, plan?.cancelSession === true)) {
      if (BigInt(after.native.revision) < BigInt(before.native.revision) || previousRevision !== null && BigInt(before.native.revision) < previousRevision) failures.push('text-native-revision-order-differs');
      previousRevision = BigInt(after.native.revision);
      if (after.native.textVersion < before.native.textVersion || previousTextVersion !== null && before.native.textVersion < previousTextVersion) failures.push('text-native-text-version-order-differs');
      previousTextVersion = after.native.textVersion;
    }
    if (browserOrigin === null && finite(before?.timeOrigin)) browserOrigin = before.timeOrigin;
    if (before?.timeOrigin !== browserOrigin || after?.timeOrigin !== browserOrigin || !time(before?.observedMs) || !time(after?.observedMs) ||
      before.observedMs > after.observedMs || previousBrowserEnd !== null && before.observedMs < previousBrowserEnd) missing.push('ordered-public-text-state-clock-unavailable');
    previousBrowserEnd = after?.observedMs;
    const request = action.kind === 'presentation' ? witness?.requests?.find(value => value.actionId === action.id) : null;
    if (request && (!witnessBound(request.before, before, before, after) || !witnessBound(request.after, after, before, after))) failures.push('text-presentation-public-state-differs');
    const identity = {sessionId, sequence, actionId: action.id, family: action.kind};
    const {steps: ignored, ...stablePlan} = plan ?? {};
    const actionWitness = request ?? (action.kind === 'composition-end' && plan?.sequenceInComposition === 8 ? witness?.latest :
      action.kind === 'composition-end' && plan?.cancelSession ? witness?.cancellation : null);
    if (actionWitness && !request && (!witnessBound(actionWitness.beforeEnd ?? actionWitness.beforeCancel, before, before, after) ||
      !witnessBound(actionWitness.afterEnd ?? actionWitness.afterCancel, after, before, after))) failures.push('text-composition-boundary-public-state-differs');
    const state = {before: stableState(before), after: stableState(after), plan: stablePlan, presentationWitness: stableWitness(actionWitness)};
    const dispatches = [], receipts = Array.isArray(action.nativeInput?.dispatches) ? action.nativeInput.dispatches : [];
    if (receipts.length !== plan?.steps.length) missing.push('complete-text-substep-inventory-unavailable');
    let priorStepBrowserEnd = before?.observedMs, priorStepRunnerEnd = action.inputMs;
    for (const [index, receipt] of receipts.entries()) {
      dispatchCount++;
      let descriptor;
      try {descriptor = textInputDescriptor({sessionId, actionId: action.id, stepId: plan?.steps[index]?.stepId});}
      catch {failures.push('text-substep-identity-unavailable');}
      if (!descriptor || !isDeepStrictEqual(receipt.descriptor, descriptor) || receipt.nativeActionId !== textInputIdentity(descriptor).nativeActionId) failures.push('text-substep-identity-or-order-differs');
      if (receipt.dispatchCompleted !== true) failures.push('text-product-dispatch-incomplete');
      if (receipt.clock !== 'runner-monotonic' || !time(receipt.dispatchStartedMs) || !time(receipt.dispatchCompletedMs) ||
        receipt.dispatchStartedMs < priorStepRunnerEnd || receipt.dispatchCompletedMs < receipt.dispatchStartedMs || receipt.dispatchCompletedMs > action.readyMs) missing.push('ordered-text-dispatch-runner-times-unavailable');
      priorStepRunnerEnd = receipt.dispatchCompletedMs;
      missing.push(...(Array.isArray(receipt.missing) ? receipt.missing : ['text-dispatch-diagnostics-unavailable']));
      let inputEvidence;
      try {inputEvidence = descriptor ? validateTextInput(receipt.inputEvidence, descriptor) : null;} catch {inputEvidence = unavailable(descriptor, 'text-event-replay-unavailable');}
      if (!inputEvidence) {missing.push('text-event-replay-unavailable'); continue;}
      missing.push(...inputEvidence.missing); failures.push(...inputEvidence.failures);
      if (!isDeepStrictEqual(receipt.inputEvidence, inputEvidence)) failures.push('text-event-projection-differs');
      if (inputEvidence.timeOrigin !== browserOrigin || inputEvidence.armedMs < priorStepBrowserEnd || inputEvidence.stoppedMs > after?.observedMs) missing.push('ordered-text-dispatch-browser-clock-unavailable');
      priorStepBrowserEnd = inputEvidence.stoppedMs;
      if (!receipt.nativeBracket || typeof receipt.nativeBracket !== 'object') missing.push('text-native-dispatch-bracket-unavailable');
      dispatches.push({descriptor: descriptor ?? null, nativeActionId: receipt.nativeActionId ?? null, nativeBracket: receipt.nativeBracket ?? null,
        clock: receipt.clock, dispatchStartedMs: receipt.dispatchStartedMs, dispatchCompletedMs: receipt.dispatchCompletedMs, inputEvidence});
    }
    const copyRawState = value => value ? {clock: value.clock, timeOrigin: value.timeOrigin, observedMs: value.observedMs, visibility: value.visibility,
      ...stableState(value), native: value.native ? Object.fromEntries(publicNativeFields.map(name => [name, structuredClone(value.native[name])])) : null} : null;
    actions.push({identity, runnerSchedule: {clock: 'runner-monotonic', scheduledMs: action.scheduledMs, scheduledAtMs: action.scheduledAtMs,
      inputMs: action.inputMs, inputLatenessMs: action.inputLatenessMs, readyMs: action.readyMs, durationMs: action.durationMs},
      rawState: {before: copyRawState(before), after: copyRawState(after), presentationWitness: structuredClone(actionWitness ?? null)},
      state, stateSha256: digest(state), dispatches});
  }
  if (dispatchCount !== 247) missing.push('complete-247-text-dispatch-workload-unavailable');
  if (time(previousRunnerEnd) && segment?.completedActionsAtMs < previousRunnerEnd - segment?.startMs) missing.push('text-action-completion-outside-retained-window');
  return freeze({kind: 'text-interaction-input-1', schemaVersion: 1, profile: TEXT_INPUT_PROFILE, sessionId,
    status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS', counts: {...TEXT_INPUT_COUNTS, observedActions: source.length, observedDispatches: dispatchCount},
    clock: 'runner-monotonic', segment: segment ? structuredClone(segment) : null, browserClock: {clock: 'browser-performance', timeOrigin: browserOrigin},
    baseline, textFixture, semanticItemIds, sealedSemanticItemIds, nativeContinuity,
    nativeSessionStart: structuredClone(raw?.nativeSessionStart ?? null), nativeSessionEnd: structuredClone(raw?.nativeSessionEnd ?? null),
    actions, presentation: structuredClone(presentation), missing: [...new Set(missing)], failures: [...new Set(failures)], qualification: false});
}

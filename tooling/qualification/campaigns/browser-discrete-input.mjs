/** SOURCE-ONLY candidate. Browser-delivered automation input, never hardware
 * provenance or presentation evidence. No clock is assigned by this module. */
const TOKEN = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const TIME = value => Number.isFinite(value) && value >= 0;
const FAMILIES = new Set(['undo', 'layer', 'zoom', 'split', 'pan', 'theme', 'density', 'first-use']);
const TARGETS = new Set(['mask-undo', 'layer-row', 'zoom-percentage', 'request-panel-width', 'document-canvas', 'appearance', 'density', 'mask-tool', 'adapter-library']);
const KEYS = new Set(['ControlOrMeta+A', 'Tab', 'Enter', 'Escape', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const TYPES = new Set(['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'beforeinput', 'input', 'change']);
const MAX_EVENTS = 128;
const AUTOMATION = Object.freeze({driver: 'playwright', delivery: 'browser-input-api', physicalInput: false});
function freeze(value) {
  if (value && typeof value === 'object') {for (const item of Object.values(value)) freeze(item); Object.freeze(value);}
  return value;
}
function requireValue(condition, reason) {if (!condition) throw Error(reason);}
export function discreteInputDescriptor(value) {
  requireValue(value && TOKEN(value.sessionId) && TOKEN(value.actionId) && TOKEN(value.stepId) && FAMILIES.has(value.family), 'Invalid discrete input identity');
  requireValue(value.target && TARGETS.has(value.target.control), 'Invalid public input target');
  requireValue(['click', 'press', 'press-sequentially'].includes(value.input?.kind), 'Invalid discrete input operation');
  const keyName = value.input.keyName ?? value.input.key;
  if (value.input.kind === 'press') requireValue(KEYS.has(keyName) && (value.input.key === undefined || value.input.keyName === undefined || value.input.key === value.input.keyName), 'Unsupported or ambiguous discrete key');
  if (value.input.kind === 'press-sequentially') requireValue(typeof value.input.text === 'string' && /^[0-9.]{1,16}$/.test(value.input.text), 'Only bounded numeric entry is retained');
  if (value.target.rowIndex !== undefined) requireValue(Number.isSafeInteger(value.target.rowIndex) && value.target.rowIndex >= 0 && value.target.rowIndex < 100000, 'Invalid public row index');
  if (value.target.layerId !== undefined) requireValue(TOKEN(value.target.layerId), 'Invalid public layer identity');
  // Copy only the admitted fields: no arbitrary labels, editor state or input text.
  return freeze({schemaVersion: 1, sessionId: value.sessionId, actionId: value.actionId, stepId: value.stepId,
    family: value.family, target: {control: value.target.control,
      ...(value.target.rowIndex === undefined ? {} : {rowIndex: value.target.rowIndex}),
      ...(value.target.layerId === undefined ? {} : {layerId: value.target.layerId})},
    input: {kind: value.input.kind, ...(value.input.kind === 'press' ? {keyName} : {}),
      ...(value.input.kind === 'press-sequentially' ? {text: value.input.text} : {})}});
}
const identity = descriptor => `${descriptor.sessionId}/${descriptor.actionId}/${descriptor.stepId}`;
const unavailable = (descriptor, reason) => freeze({kind: 'browser-discrete-input-1', schemaVersion: 1,
  descriptor, automation: AUTOMATION, status: 'INCONCLUSIVE', clock: 'browser-performance',
  events: [], initiatingEventIds: [], inputMs: null, qualification: false, missing: [reason], failures: []});

/** Pure validation of retained input. IDs address this observation's records;
 * they have no relationship to Chromium EventLatency or physical device IDs. */
export function validateDiscreteInput(raw, requested) {
  const descriptor = discreteInputDescriptor(requested), failures = [], missing = [];
  const events = Array.isArray(raw?.events) ? raw.events : [];
  if (JSON.stringify(raw?.descriptor) !== JSON.stringify(descriptor)) failures.push('input-descriptor-mismatch');
  if (raw?.clock !== 'browser-performance' || !TIME(raw.timeOrigin) || raw.timeOrigin === 0 ||
      raw.timeOrigin !== raw.endedTimeOrigin || !TIME(raw.armedMs) || !TIME(raw.stoppedMs) || raw.stoppedMs < raw.armedMs) missing.push('same-browser-clock-unavailable');
  if (raw?.overflow || events.length > MAX_EVENTS) failures.push('input-event-overflow');
  if (raw?.targetConnectedAtArm !== true || typeof raw?.targetConnected !== 'boolean') missing.push('input-target-observation-unavailable');
  if (raw?.visibility !== 'visible' || raw?.endedVisibility !== 'visible') missing.push('visible-input-context-unavailable');
  const expectedPrefix = identity(descriptor) + '/event-';
  for (const [index, event] of events.entries()) {
    const dispatchedInput = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup'].includes(event.type);
    if (event.eventId !== expectedPrefix + index || event.ordinal !== index || !TYPES.has(event.type)) failures.push('input-event-identity-invalid');
    if (dispatchedInput && event.isTrusted !== true) failures.push('untrusted-input-event');
    if (!TIME(event.timeStampMs) || !TIME(event.observedMs) || event.timeStampMs < raw.armedMs || event.timeStampMs > event.observedMs ||
        event.observedMs > raw.stoppedMs || index && (event.timeStampMs < events[index - 1].timeStampMs || event.observedMs < events[index - 1].observedMs)) missing.push('ordered-browser-input-times-unavailable');
    // Tab keyup may legitimately be delivered to the next focus target. Other
    // input belonging to a different target is not silently discarded.
    // Components may emit synthetic input/change notifications on their host.
    // Retain their trust/target values, but never use them as input provenance.
    if (dispatchedInput && event.targetMatched !== true && !(descriptor.input.kind === 'press' && descriptor.input.keyName === 'Tab' && event.type === 'keyup' && event.keyName === 'Tab')) failures.push('unexpected-input-target');
  }
  let initiators = [];
  if (descriptor.input.kind === 'click') {
    const sequence = events.filter(event => ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup'].includes(event.type));
    if (sequence.map(event => event.type).join(',') !== 'pointerdown,pointerup,click') failures.push('click-sequence-incomplete-or-ambiguous');
    const [down, up, click] = sequence;
    if (down?.pointerType !== 'mouse' || down?.isPrimary !== true || down?.button !== 0 || down?.buttons !== 1 ||
        up?.pointerType !== 'mouse' || up?.isPrimary !== true || up?.button !== 0 || up?.buttons !== 0 ||
        click?.pointerType !== 'mouse' || click?.button !== 0 || click?.buttons !== 0 ||
        !Number.isSafeInteger(down?.pointerId) || down.pointerId !== up?.pointerId || down.pointerId !== click?.pointerId) failures.push('click-pointer-identity-invalid');
    initiators = sequence.filter(event => event.type === 'pointerdown');
  } else {
    const downs = events.filter(event => event.type === 'keydown');
    if (events.some(event => ['pointerdown', 'pointerup', 'click'].includes(event.type))) failures.push('unexpected-pointer-input');
    const expected = descriptor.input.kind === 'press-sequentially' ? [...descriptor.input.text] : [descriptor.input.keyName === 'ControlOrMeta+A' ? 'a' : descriptor.input.keyName];
    const ordinary = downs.filter(event => !['Control', 'Meta', 'Shift', 'Alt'].includes(event.keyName));
    if (ordinary.map(event => event.keyName === 'A' ? 'a' : event.keyName).join('\u0000') !== expected.join('\u0000')) failures.push('keyboard-sequence-incomplete-or-ambiguous');
    const shortcut = descriptor.input.kind === 'press' && descriptor.input.keyName === 'ControlOrMeta+A';
    for (const event of downs) {
      if (event.repeat || !event.modifiers || event.modifiers.alt || event.modifiers.shift) failures.push('unexpected-keyboard-modifiers-or-repeat');
      if (!shortcut && (event.modifiers?.control || event.modifiers?.meta || ['Control', 'Meta', 'Shift', 'Alt'].includes(event.keyName))) failures.push('unexpected-keyboard-modifiers-or-repeat');
      if (shortcut && !['Control', 'Meta', 'a', 'A'].includes(event.keyName)) failures.push('unexpected-shortcut-key');
    }
    if (shortcut && ordinary.some(event => !event.modifiers?.control && !event.modifiers?.meta)) failures.push('shortcut-modifier-missing');
    const keyboardEvents = events.filter(event => ['keydown', 'keyup'].includes(event.type));
    const modifier = downs[0]?.keyName;
    const expectedKeyEvents = shortcut ? [`keydown:${modifier}`, 'keydown:a', 'keyup:a', `keyup:${modifier}`] : expected.flatMap(key => [`keydown:${key}`, `keyup:${key}`]);
    if ((shortcut && !['Control', 'Meta'].includes(modifier)) || keyboardEvents.map(event => `${event.type}:${event.keyName === 'A' ? 'a' : event.keyName}`).join('\u0000') !== expectedKeyEvents.join('\u0000')) failures.push('keyboard-dispatch-sequence-invalid');
    const pressed = new Set();
    for (const event of keyboardEvents) {
      const key = event.keyName === 'A' ? 'a' : event.keyName;
      if (event.type === 'keydown') {
        if (pressed.has(key)) failures.push('keyboard-release-sequence-invalid');
        pressed.add(key);
      } else if (!pressed.delete(key)) failures.push('keyboard-release-sequence-invalid');
    }
    if (pressed.size) failures.push('keyboard-release-sequence-invalid');
    initiators = ordinary;
  }
  if (!initiators.length) missing.push('initiating-browser-input-unavailable');
  return freeze({kind: 'browser-discrete-input-1', schemaVersion: 1, descriptor, automation: AUTOMATION,
    clock: 'browser-performance', timeOrigin: raw?.timeOrigin ?? null, endedTimeOrigin: raw?.endedTimeOrigin ?? null,
    armedMs: raw?.armedMs ?? null, stoppedMs: raw?.stoppedMs ?? null,
    visibility: raw?.visibility ?? null, endedVisibility: raw?.endedVisibility ?? null,
    targetConnectedAtArm: raw?.targetConnectedAtArm === true, targetConnected: raw?.targetConnected === true, overflow: raw?.overflow === true,
    status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS',
    inputMs: initiators[0]?.timeStampMs ?? null, initiatingEventIds: initiators.map(event => event.eventId),
    events: structuredClone(events), failures: [...new Set(failures)], missing: [...new Set(missing)], qualification: false});
}

/** Passive public-element observer. No values/text/clipboard data, private
 * editor objects, event injection, timestamp assignment, or paint inference. */
export async function installDiscreteInputObserver(page, {sessionId}) {
  requireValue(TOKEN(sessionId), 'Invalid discrete input session identity');
  const key = '__IDEOGRAM_CAMPAIGN_DISCRETE_INPUT__';
  await page.evaluate(({key, sessionId, maxEvents}) => {
    if (Object.hasOwn(globalThis, key)) throw Error('Discrete input observer already installed');
    let current = null;
    const types = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'beforeinput', 'input', 'change'];
    const listener = event => {
      if (!current) return;
      if (current.events.length >= maxEvents) {current.overflow = true; return;}
      const ordinal = current.events.length;
      const row = {eventId: `${sessionId}/${current.descriptor.actionId}/${current.descriptor.stepId}/event-${ordinal}`, ordinal,
        type: event.type, timeStampMs: event.timeStamp, observedMs: performance.now(), isTrusted: event.isTrusted,
        targetMatched: event.composedPath().includes(current.target)};
      if (event instanceof PointerEvent) Object.assign(row, {pointerId: event.pointerId, pointerType: event.pointerType,
        isPrimary: event.isPrimary, button: event.button, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY});
      if (event instanceof KeyboardEvent) {
        // keyName avoids the shared receipt sanitizer's credential-key field;
        // the allowlisted value is read directly from KeyboardEvent.key.
        row.keyName = /^(?:[0-9.aA]|Control|Meta|Shift|Alt|Tab|Enter|Escape|Home|End|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(event.key) ? event.key : 'other';
        row.code = /^(?:Digit[0-9]|Numpad[0-9]|NumpadDecimal|Period|KeyA|ControlLeft|ControlRight|MetaLeft|MetaRight|ShiftLeft|ShiftRight|AltLeft|AltRight|Tab|Enter|Escape|Home|End|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(event.code) ? event.code : 'other';
        row.repeat = event.repeat;
        row.modifiers = {control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey};
      }
      if (event instanceof InputEvent) row.inputType = ['insertText', 'deleteContentBackward', 'deleteContentForward', 'insertReplacementText'].includes(event.inputType) ? event.inputType : 'other';
      current.events.push(row);
    };
    for (const type of types) document.addEventListener(type, listener, {capture: true, passive: true});
    Object.defineProperty(globalThis, key, {configurable: true, value: {
      begin(target, descriptor) {
        if (current || descriptor.sessionId !== sessionId || !(target instanceof Element) || !target.isConnected) throw Error('Discrete input cannot be armed');
        current = {target, descriptor, events: [], overflow: false, targetConnectedAtArm: true, clock: 'browser-performance',
          timeOrigin: performance.timeOrigin, armedMs: performance.now(), visibility: document.visibilityState};
      },
      end() {
        if (!current) throw Error('Discrete input observation not armed');
        const {target, ...value} = current; current = null;
        return {...value, stoppedMs: performance.now(), endedTimeOrigin: performance.timeOrigin,
          endedVisibility: document.visibilityState, targetConnected: target.isConnected};
      },
      close() {for (const type of types) document.removeEventListener(type, listener, {capture: true}); current = null; delete globalThis[key];},
    }});
  }, {key, sessionId, maxEvents: MAX_EVENTS});
  return {
    async begin(target, descriptor) {
      descriptor = discreteInputDescriptor(descriptor);
      requireValue(descriptor.sessionId === sessionId, 'Discrete input observer session differs');
      await target.evaluate((element, {key, descriptor}) => globalThis[key].begin(element, descriptor), {key, descriptor});
    },
    end: () => page.evaluate(key => globalThis[key].end(), key),
    close: () => page.evaluate(key => globalThis[key]?.close(), key),
  };
}

/** Optional hook contract: hook({descriptor,run}) -> {value:await run(),bracket}.
 * run dispatches at most once and drains the passive observer. Instrumentation
 * failure never replays a completed input or replaces a product exception. */
export async function runDiscreteInputStep({observer, target, descriptor: requested, dispatch, hook, onRetained}) {
  const descriptor = discreteInputDescriptor(requested);
  requireValue(typeof dispatch === 'function' && (hook === undefined || typeof hook === 'function'), 'Invalid discrete dispatch seam');
  let runPromise, runValue, productError, productFailed = false, acceptsRun = true;
  const missing = [];
  const run = () => {
    if (!acceptsRun) throw Error('Discrete input dispatch may run only once');
    if (runPromise) {missing.push('native-input-hook-repeated-or-late-dispatch'); throw Error('Discrete input dispatch may run only once');}
    runPromise = (async () => {
      let armed = false, raw, inputEvidence;
      try {await observer?.begin(target, descriptor); armed = !!observer;} catch {missing.push('input-observer-arm-failed');}
      try {await dispatch();}
      catch (error) {productError = error; productFailed = true;}
      finally {
        if (armed) try {raw = await observer.end();} catch {missing.push('input-observer-drain-failed');}
      }
      try {inputEvidence = raw ? validateDiscreteInput(raw, descriptor) : unavailable(descriptor, 'input-observation-unavailable');}
      catch {inputEvidence = unavailable(descriptor, 'input-observation-validation-failed');}
      runValue = freeze({dispatchCompleted: !productFailed, inputEvidence});
      if (productFailed) throw productError;
      return runValue;
    })();
    // A hook may fail without awaiting run; retain its rejection for the owner.
    runPromise.catch(() => {});
    return runPromise;
  };
  let hookResult;
  if (hook) {
    try {hookResult = await hook({descriptor, run});}
    catch {missing.push('native-input-hook-failed');}
    if (!runPromise) missing.push('native-input-hook-did-not-dispatch');
  }
  if (!runPromise) run();
  acceptsRun = false;
  try {await runPromise;} catch {}
  let nativeBracket = null;
  if (hook && !missing.some(reason => reason.startsWith('native-input-hook'))) {
    try {
      requireValue(hookResult?.value === runValue, 'Hook action result differs');
      const bytes = JSON.stringify(hookResult.bracket);
      requireValue(typeof bytes === 'string' && bytes.length <= 16384, 'Hook bracket missing or oversized');
      nativeBracket = JSON.parse(bytes);
      // Retained evidence only. Replay/admission belongs to the native owner.
    } catch {missing.push('native-input-hook-evidence-unavailable');}
  }
  const result = freeze({...runValue, nativeBracket, nativeBracketVerified: false, missing});
  // A separate sink retains failed observations even when the thrown value is
  // primitive/frozen and cannot receive a diagnostic property.
  try {onRetained?.(result);} catch { /* Retention must not replace the product outcome. */ }
  if (productFailed) {
    try {if (productError && typeof productError === 'object') productError.discreteInputStep = result;} catch {}
    throw productError;
  }
  return result;
}

export function createDiscreteActionRecorder({observer, sessionId, actionId, family, hook}) {
  const steps = [], used = new Set();
  const snapshot = () => {
    const observations = steps.map(step => step.inputEvidence);
    const failures = observations.flatMap(value => value.failures);
    const missing = [...observations.flatMap(value => value.missing), ...steps.flatMap(step => step.missing)];
    if (steps.some(step => step.dispatchCompleted !== true)) failures.push('product-input-dispatch-failed');
    if (observations.some(value => value.timeOrigin !== observations[0]?.timeOrigin)) missing.push('action-browser-clock-changed');
    if (observations.some((value, index) => index && value.armedMs < observations[index - 1].stoppedMs)) missing.push('action-browser-step-order-unavailable');
    if (!steps.length) missing.push('discrete-action-has-no-input-steps');
    return freeze({kind: 'browser-discrete-action-1', schemaVersion: 1, sessionId, actionId, family,
      automation: AUTOMATION, steps: [...steps], inputMs: observations.find(value => value.inputMs !== null)?.inputMs ?? null,
      clock: 'browser-performance', timeOrigin: observations[0]?.timeOrigin ?? null,
      status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS',
      failures: [...new Set(failures)], missing: [...new Set(missing)], qualification: false});
  };
  return {
    async step({stepId, target, targetIdentity, input, dispatch}) {
      requireValue(!used.has(stepId), 'Discrete input step identity reused'); used.add(stepId);
      const descriptor = discreteInputDescriptor({sessionId, actionId, family, stepId, target: targetIdentity, input});
      try {
        return await runDiscreteInputStep({observer, target, descriptor, dispatch, hook, onRetained: value => steps.push(value)});
      } catch (error) {
        try {if (error && typeof error === 'object') error.discreteInputObservation = snapshot();} catch {}
        throw error;
      }
    },
    snapshot,
  };
}

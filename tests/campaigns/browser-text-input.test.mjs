import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {TEXT_INPUT_PROFILE, TEXT_INPUT_COUNTS, buildTextInputInventory, textInputDescriptor, textInputIdentity,
  textSessionNativeId, validateTextInput, runTextInputStep, projectTextInteraction} from '../../tooling/qualification/campaigns/browser-text-input.mjs';

const sessionId = 'text-test-session';
const copy = value => structuredClone(value);
const inventory = buildTextInputInventory();
const descriptor = (actionId = 'IText-001', stepId = 'focus') => textInputDescriptor({sessionId, actionId, stepId});
function rawInput(identity = descriptor(), start = 10, events = []) {
  return {descriptor: identity, clock: 'browser-performance', timeOrigin: 1700000000000, endedTimeOrigin: 1700000000000,
    armedMs: start, stoppedMs: start + 1, visibility: 'visible', endedVisibility: 'visible', targetConnectedAtArm: true,
    targetConnected: true, overflow: false, events: events.map((event, ordinal) => ({eventId: textInputIdentity(identity).localStepId + '/event-' + ordinal,
      ordinal, type: 'input', timeStampMs: start + 0.1 + ordinal * 0.01, observedMs: start + 0.2 + ordinal * 0.01,
      isTrusted: true, targetMatched: true, ...event}))};
}
const observer = () => {let current; return {begin: async (_target, identity) => {current = identity;}, end: async () => rawInput(current)};};
const hook = async ({run}) => ({value: await run(), bracket: {fixtureOnly: true}});

// Pure receipt fixture, not generated oracle pixels or a native-capture claim.
// Deliberately allows no observed DOM event for a dispatch; inputMs stays null.
export function textInteractionRawFixture() {
  const semanticItemIds = ['semantic-item-1', 'semantic-item-2'];
  let selected = semanticItemIds[0];
  let current = {connected: true, start: 0, end: 0, direction: 'none', units: 8, presentation: 'anchored',
    session: 'draft-fixture-1', revision: '7', textVersion: 3, focused: true, switch: {pending: '', request: 0, requestEpoch: 1,
      requestGeneration: 7, requestTextVersion: 3, settled: 0, rejected: 0, superseded: 0, rejectedEpoch: 0, rejectedGeneration: 0,
      rejectedCurrentEpoch: 0, rejectedCurrentGeneration: 0, rejectedTextVersion: 0, rejectedCurrentTextVersion: 0, rejectedGuards: 0, rejectedBoundary: '', reason: ''}};
  const witness = {kind: 'text-presentation-observation-1', requests: [], latest: null, cancellation: null};
  const state = (native, observedMs, terminal = false, selection = selected) => ({clock: 'browser-performance', timeOrigin: 1700000000000,
    observedMs, visibility: 'visible', native: copy(native), contentSha256: 'a'.repeat(64), semanticSelection: terminal ? null : selection,
    format: terminal ? {fontChoice: null, lineHeight: null, frameWidth: null, frameHeight: null} :
      {fontChoice: 'NotoSans', lineHeight: '1.2', frameWidth: '360', frameHeight: '180'}});
  const actions = inventory.map(plan => {
    const beforeSelection = selected;
    if (plan.kind === 'semantic-selection') selected = semanticItemIds[plan.index];
    const beforeNative = copy(current), afterNative = copy(current), browserStart = 100 + plan.sequence * 20;
    if (plan.kind === 'presentation') {
      const target = (current.switch.pending || current.presentation) === 'anchored' ? 'inspector' : 'anchored';
      afterNative.switch.request++;
      if (plan.mode === 'immediate') {afterNative.presentation = target; afterNative.switch.settled = afterNative.switch.request;}
      else {
        if (current.switch.pending) Object.assign(afterNative.switch, {superseded: current.switch.request, rejected: current.switch.request, reason: 'superseded'});
        afterNative.switch.pending = target;
      }
      witness.requests.push({actionId: plan.id, mode: plan.mode, target, before: copy(beforeNative), after: copy(afterNative)});
    }
    if (plan.kind === 'composition-end' && plan.sequenceInComposition === 8) {
      afterNative.presentation = current.switch.pending; afterNative.switch.pending = ''; afterNative.switch.settled = current.switch.request;
      witness.latest = {beforeEnd: copy(beforeNative), afterEnd: copy(afterNative)};
    }
    if (plan.cancelSession) {
      afterNative.session = ''; afterNative.revision = '8'; afterNative.textVersion = 4;
      Object.assign(afterNative.switch, {pending: '', rejected: current.switch.request, reason: 'cancelled',
        rejectedEpoch: current.switch.requestEpoch, rejectedGeneration: current.switch.requestGeneration, rejectedTextVersion: current.switch.requestTextVersion,
        rejectedCurrentEpoch: current.switch.requestEpoch + 1, rejectedCurrentGeneration: 8, rejectedCurrentTextVersion: 4,
        rejectedGuards: 7, rejectedBoundary: 'cancel-native-end'});
      witness.cancellation = {beforeCancel: copy(beforeNative), afterCancel: copy(afterNative)};
    }
    current = afterNative;
    const inputMs = 1000 + plan.scheduledMs;
    return {id: plan.id, kind: plan.kind, scheduledMs: plan.scheduledMs, scheduledAtMs: inputMs, inputLatenessMs: 0, inputMs, readyMs: inputMs + 10, durationMs: 10,
      outcome: 'completed', nativeInput: {before: state(beforeNative, browserStart, false, beforeSelection), after: state(afterNative, browserStart + 15, plan.cancelSession),
        dispatches: plan.steps.map((step, index) => {
          const identity = descriptor(plan.id, step.stepId);
          return {descriptor: identity, nativeActionId: textInputIdentity(identity).nativeActionId, dispatchCompleted: true,
            clock: 'runner-monotonic', dispatchStartedMs: inputMs + index, dispatchCompletedMs: inputMs + index + 0.5,
            inputEvidence: validateTextInput(rawInput(identity, browserStart + 1 + index * 2), identity),
            nativeBracket: {fixtureOnly: true}, nativeBracketVerified: false, missing: [], qualification: false};
        })}};
  });
  const textFixture = {schema: 'browser-text-fixture-1', manifestHash: 'sha256:' + 'b'.repeat(64),
    corpus: {sha256: 'sha256:' + 'a'.repeat(64), bytes: 8, fragmentsHash: 'sha256:' + 'c'.repeat(64), fragmentCount: 20,
      scripts: ['latin-combining', 'arabic-rtl', 'devanagari', 'cjk', 'emoji', 'newlines', 'unbroken']},
    fonts: ['NotoSans', 'NotoSansArabic', 'NotoSansDevanagari', 'NotoSansCJK'].map((id, index) => ({id, sha256: 'sha256:' + String(index + 1).repeat(64), bytes: 1024, kind: 'bundled', licenseSha256: null})),
    semanticItemIdsHash: 'sha256:' + createHash('sha256').update(JSON.stringify(semanticItemIds)).digest('hex'),
    activeLayerId: null, activeLayerIndex: null, fontSetPreseeded: false};
  return {textInputSessionId: sessionId, textFixture, semanticItemIds, sealedSemanticItemIds: [...semanticItemIds],
    native: {overflow: false, sameNode: true, sameConnectedParent: true, disconnected: false}, textPresentation: {sameConnectedNode: true}, actions, presentationWitness: witness,
    segment: {clock: 'runner-monotonic', startMs: 1000, endMs: 61000, requestedMs: 60000, captureStoppedMs: 61001,
      completedActionsAtMs: actions.at(-1).readyMs - 1000, actions: 106}};
}

test('fixed inventory preserves 106 actions, 247 calls and exact category census', () => {
  assert.equal(TEXT_INPUT_PROFILE, 'interaction-text-106-247-60s-1');
  assert.equal(inventory.length, 106);
  assert.equal(inventory.flatMap(action => action.steps).length, 247);
  const counts = {};
  for (const action of inventory) for (const step of action.steps) {
    const category = step.operation === 'focus' ? 'focus' : action.kind;
    counts[category] = (counts[category] ?? 0) + 1;
  }
  assert.deepEqual(counts, {focus: 70, 'insert-delete': 40, caret: 10, presentation: 6, 'semantic-selection': 10,
    'text-format': 18, preedit: 70, 'composition-end': 23});
  assert.equal(TEXT_INPUT_COUNTS.dispatchAcknowledgements + TEXT_INPUT_COUNTS.windowAnchors, 496);
  assert.equal(inventory[0].scheduledMs, 0);
  assert.equal(inventory.at(-1).scheduledMs, 105 * 59400 / 106);
});

test('descriptors derive operation and safe target metadata from the fixed inventory', () => {
  const value = descriptor('IText-001', 'edit');
  assert.equal(value.operation, 'insert-text');
  assert.equal(value.input.api, 'keyboard.insertText');
  assert.equal(value.target.control, 'text-content');
  assert.throws(() => textInputDescriptor({...value, operation: 'press-backspace'}), /fixed inventory/);
  assert.throws(() => descriptor('IText-107'), /Unknown/);
  assert.throws(() => descriptor('IText-001', 'injected'), /Unknown/);
  assert.ok(Object.isFrozen(value.input));
});

test('local/native identities bind session and substep and leave ACK suffix capacity', () => {
  const a = textInputIdentity(descriptor()), b = textInputIdentity(descriptor('IText-001', 'edit'));
  assert.notEqual(a.nativeActionId, b.nativeActionId);
  assert.equal(a.nativeSessionId, textSessionNativeId(sessionId));
  assert.ok((a.nativeSessionId + '-win-before').length <= 64);
  assert.ok((a.nativeActionId + '-before').length <= 64);
  assert.notEqual(a.nativeActionId, textInputIdentity(textInputDescriptor({sessionId: 'other', actionId: 'IText-001', stepId: 'focus'})).nativeActionId);
});

test('observer replay preserves real timestamp/trust and does not promote synthetic input', () => {
  const identity = descriptor('IText-001', 'edit');
  const value = validateTextInput(rawInput(identity, 10, [{isTrusted: false, inputType: 'insertCompositionText', isComposing: true}]), identity);
  assert.equal(value.status, 'PASS'); assert.equal(value.events[0].timeStampMs, 10.1);
  assert.equal(value.classification.observed, 'synthetic-events'); assert.equal(value.inputMs, null);
  assert.equal(value.classification.physicalInput, false);
});

test('absent events remain explicit for focus, setters and browser API calls', () => {
  for (const identity of [descriptor(), descriptor('IText-001', 'edit'), descriptor('IText-041', 'caret')]) {
    const value = validateTextInput(rawInput(identity), identity);
    assert.equal(value.status, 'PASS'); assert.equal(value.inputMs, null);
    assert.deepEqual(value.initiatingEventIds, []); assert.equal(value.classification.observed, 'none');
  }
});

test('replay rejects wrong target, local identity, clock drift and overflow', () => {
  for (const mutate of [raw => {raw.events[0].targetMatched = false;}, raw => {raw.events[0].eventId = 'other';},
    raw => {raw.endedTimeOrigin++;}, raw => {raw.overflow = true;}, raw => {raw.events[0].timeStampMs = 9;}]) {
    const raw = rawInput(descriptor(), 10, [{}]); mutate(raw);
    assert.notEqual(validateTextInput(raw, descriptor()).status, 'PASS');
  }
});

test('replay refuses arbitrary payloads and removes extra content from retained rows', () => {
  const raw = rawInput(descriptor(), 10, [{payload: 'private text', code: {text: 'private text'}, modifiers: {control: true, meta: false, shift: false, alt: false, payload: 'private text'}}]);
  const result = validateTextInput(raw, descriptor());
  assert.equal(result.status, 'FAIL');
  assert.ok(!JSON.stringify(result.events).includes('private text'));
});

test('native hook dispatches once and retains the exact frozen run evidence', async () => {
  let calls = 0, retained;
  const result = await runTextInputStep({observer: observer(), descriptor: descriptor(), dispatch: async () => {calls++; return 42;}, hook,
    retain: value => {retained = value;}});
  assert.equal(calls, 1); assert.equal(result.value, 42); assert.equal(result.receipt, retained);
  assert.ok(Object.isFrozen(result.receipt)); assert.deepEqual(result.receipt.missing, []);
  assert.equal(result.receipt.inputEvidence.status, 'PASS');
});

test('hook failure before dispatch falls back once and records the instrumentation failure', async () => {
  let calls = 0;
  const result = await runTextInputStep({observer: observer(), descriptor: descriptor(), dispatch: async () => {calls++;}, hook: async () => {throw Error('hook');}});
  assert.equal(calls, 1); assert.ok(result.receipt.missing.includes('text-hook-did-not-dispatch'));
});

test('hook failure after dispatch never retries product input', async () => {
  let calls = 0;
  const result = await runTextInputStep({descriptor: descriptor(), dispatch: async () => {calls++;}, hook: async ({run}) => {await run(); throw Error('late hook');}});
  assert.equal(calls, 1); assert.ok(result.receipt.missing.includes('text-hook-failed'));
});

test('concurrent repeated hook run is rejected while the first call drains', async () => {
  let calls = 0;
  const result = await runTextInputStep({observer: observer(), descriptor: descriptor(), dispatch: async () => {calls++;},
    hook: async ({run}) => {const first = run(); assert.throws(run, /once/); return {value: await first, bracket: {}};}});
  assert.equal(calls, 1); assert.ok(result.receipt.missing.includes('text-hook-repeated-dispatch'));
});

test('synchronous dispatch reentry cannot run a second product call', async () => {
  let calls = 0, again;
  const result = await runTextInputStep({descriptor: descriptor(), dispatch: () => {calls++; assert.throws(again, /once/);},
    hook: async ({run}) => {again = run; return {value: await run(), bracket: {}};}});
  assert.equal(calls, 1); assert.ok(result.receipt.missing.includes('text-hook-repeated-dispatch'));
});

test('late hook run cannot mutate an already frozen receipt', async () => {
  let late, calls = 0;
  const result = await runTextInputStep({descriptor: descriptor(), dispatch: async () => {calls++;},
    hook: async ({run}) => {late = run; return {value: await run(), bracket: {}};}});
  const before = JSON.stringify(result.receipt);
  assert.throws(late, /once/); assert.equal(calls, 1); assert.equal(JSON.stringify(result.receipt), before);
});

test('primitive and frozen product errors survive hook/drain/retention failures', async () => {
  for (const error of ['primitive-product-error', Object.freeze(Error('frozen-product-error'))]) {
    let retained, thrown;
    try {await runTextInputStep({descriptor: descriptor(), observer: {begin: async () => {}, end: async () => {throw Error('drain');}},
      dispatch: async () => {throw error;}, hook, retain: receipt => {retained = receipt; throw Error('retention');}});} catch (value) {thrown = value;}
    assert.equal(thrown, error); assert.equal(retained.dispatchCompleted, false);
    assert.ok(retained.missing.includes('text-observer-drain-failed'));
  }
});

test('arm failure preserves one product call and explicit absent observation', async () => {
  let calls = 0;
  const result = await runTextInputStep({descriptor: descriptor(), observer: {begin: async () => {throw Error('arm');}}, dispatch: async () => {calls++;}, hook});
  assert.equal(calls, 1); assert.equal(result.receipt.inputEvidence.status, 'INCONCLUSIVE');
  assert.ok(result.receipt.missing.includes('text-observer-arm-failed'));
});

test('unrelated hook result cannot bind a native bracket to the dispatched step', async () => {
  const result = await runTextInputStep({descriptor: descriptor(), dispatch: async () => {},
    hook: async ({run}) => {await run(); return {value: {}, bracket: {forged: true}};}});
  assert.equal(result.receipt.nativeBracket, null); assert.ok(result.receipt.missing.includes('text-hook-evidence-unavailable'));
});

test('complete 106 action/247 step fixture projects without claiming event or display proof', () => {
  const result = projectTextInteraction(textInteractionRawFixture(), {sessionId});
  assert.equal(result.status, 'PASS', JSON.stringify({missing: result.missing, failures: result.failures}));
  assert.equal(result.actions.length, 106); assert.equal(result.counts.observedDispatches, 247);
  assert.equal(result.qualification, false);
  assert.ok(result.actions.every(action => action.dispatches.every(step => step.inputEvidence.inputMs === null)));
  assert.equal(result.actions.at(-1).rawState.after.native.session, '');
  assert.deepEqual(result.actions.at(-1).state.after.format, {fontChoice: null, lineHeight: null, frameWidth: null, frameHeight: null});
});

test('projection rejects truncation, reordered or extra steps without throwing', () => {
  for (const mutate of [raw => {raw.actions.pop();}, raw => {raw.actions[0].nativeInput.dispatches.reverse();},
    raw => {raw.actions[0].nativeInput.dispatches.push(copy(raw.actions[0].nativeInput.dispatches[0]));}]) {
    const raw = textInteractionRawFixture(); mutate(raw);
    assert.notEqual(projectTextInteraction(raw, {sessionId}).status, 'PASS');
  }
});

test('projection rejects changed schedule, runner window and cross-clock evidence', () => {
  for (const mutate of [raw => {raw.segment.endMs++;}, raw => {raw.actions[3].scheduledMs++;},
    raw => {raw.actions[3].nativeInput.before.timeOrigin++;}, raw => {raw.actions[0].nativeInput.dispatches[0].clock = 'browser-performance';}]) {
    const raw = textInteractionRawFixture(); mutate(raw);
    assert.notEqual(projectTextInteraction(raw, {sessionId}).status, 'PASS');
  }
});

test('projection rejects malformed state, original observer overflow and wrong session', () => {
  for (const mutate of [raw => {raw.actions[3].nativeInput.before.contentSha256 = null;}, raw => {raw.native.overflow = true;},
    raw => {raw.native.sameNode = false;}, raw => {raw.native.sameConnectedParent = false;},
    raw => {raw.native.disconnected = true;}, raw => {raw.textPresentation.sameConnectedNode = false;},
    raw => {raw.textInputSessionId = 'other';}, raw => {raw.actions[3].nativeInput.after.native.session = 'wrong-draft';},
    raw => {raw.actions[3].nativeInput.after.format.fontChoice = null;}]) {
    const raw = textInteractionRawFixture(); mutate(raw);
    assert.notEqual(projectTextInteraction(raw, {sessionId}).status, 'PASS');
  }
});

test('projection rejects cross-action revision regression', () => {
  const raw = textInteractionRawFixture(); raw.actions[1].nativeInput.before.native.revision = '6';
  raw.actions[1].nativeInput.after.native.revision = '6';
  assert.ok(projectTextInteraction(raw, {sessionId}).failures.includes('text-native-revision-order-differs'));
});

test('projection binds composition completion and cancellation witnesses to action states', () => {
  for (const name of ['latest', 'cancellation']) {
    const raw = textInteractionRawFixture();
    raw.presentationWitness[name][name === 'latest' ? 'afterEnd' : 'afterCancel'].units++;
    assert.ok(projectTextInteraction(raw, {sessionId}).failures.includes('text-composition-boundary-public-state-differs'));
  }
});

test('projection requires independent draft text-version scalars and their ordering', () => {
  for (const mutate of [raw => {delete raw.actions[3].nativeInput.before.native.textVersion;},
    raw => {raw.actions[3].nativeInput.before.native.textVersion = true;},
    raw => {delete raw.actions[3].nativeInput.before.native.switch.requestTextVersion;}]) {
    const raw = textInteractionRawFixture(); mutate(raw);
    assert.ok(projectTextInteraction(raw, {sessionId}).missing.includes('complete-public-text-state-unavailable'));
  }
  const raw = textInteractionRawFixture();
  raw.actions[1].nativeInput.before.native.textVersion = 2; raw.actions[1].nativeInput.after.native.textVersion = 2;
  assert.ok(projectTextInteraction(raw, {sessionId}).failures.includes('text-native-text-version-order-differs'));
  const mismatch = textInteractionRawFixture(); mismatch.actions.at(-1).nativeInput.after.native.textVersion++;
  assert.ok(projectTextInteraction(mismatch, {sessionId}).failures.includes('text-composition-boundary-public-state-differs'));
});

test('stable state omits dynamic draft/revision while rawState and baseline retain them', () => {
  const raw = textInteractionRawFixture(), before = projectTextInteraction(raw, {sessionId});
  for (const action of raw.actions) for (const state of [action.nativeInput.before, action.nativeInput.after]) {
    if (state.native.session) state.native.session = 'draft-fixture-2';
  }
  for (const request of raw.presentationWitness.requests) for (const native of [request.before, request.after]) {native.session = 'draft-fixture-2';}
  for (const boundary of [raw.presentationWitness.latest, raw.presentationWitness.cancellation]) for (const native of Object.values(boundary)) {
    if (native.session) native.session = 'draft-fixture-2';
  }
  // The first action has no presentation request. Its dynamic revision is
  // omitted from stable state; captured request/rejection counters stay exact.
  for (const state of [raw.actions[0].nativeInput.before, raw.actions[0].nativeInput.after]) state.native.revision = '6';
  const after = projectTextInteraction(raw, {sessionId});
  assert.equal(after.status, 'PASS'); assert.equal(after.baseline.session, 'draft-fixture-2');
  assert.equal(after.baseline.revision, '6');
  assert.deepEqual(before.actions.map(action => action.stateSha256), after.actions.map(action => action.stateSha256));
  assert.equal(after.actions[0].rawState.before.native.revision, '6');
});

test('state hash remains bound to actual content and draft text-version observations', () => {
  for (const mutate of [raw => {raw.actions[0].nativeInput.after.contentSha256 = 'b'.repeat(64);},
    raw => {raw.actions[0].nativeInput.after.native.textVersion++;}]) {
    const raw = textInteractionRawFixture(), original = projectTextInteraction(raw, {sessionId}); mutate(raw);
    const changed = projectTextInteraction(raw, {sessionId});
    assert.notEqual(original.actions[0].stateSha256, changed.actions[0].stateSha256);
  }
});

test('projection binds sealed fixture, clicked semantic row and original lateness', () => {
  for (const mutate of [raw => {raw.semanticItemIds.reverse();}, raw => {raw.textFixture.corpus.sha256 = 'sha256:' + 'b'.repeat(64);},
    raw => {raw.actions.find(action => action.kind === 'semantic-selection').nativeInput.after.semanticSelection = 'wrong-item';},
    raw => {raw.actions[0].inputLatenessMs = 1;}, raw => {raw.textFixture.corpus.text = 'private text';}]) {
    const raw = textInteractionRawFixture(); mutate(raw);
    assert.notEqual(projectTextInteraction(raw, {sessionId}).status, 'PASS');
  }
});

test('extra unselected semantic rows preserve the declared first two row identities', () => {
  const raw = textInteractionRawFixture(); raw.semanticItemIds.push('extra-unselected-item');
  assert.equal(projectTextInteraction(raw, {sessionId}).status, 'PASS');
});

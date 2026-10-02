import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscreteActionRecorder, discreteInputDescriptor, runDiscreteInputStep, validateDiscreteInput} from '../../tooling/qualification/campaigns/browser-discrete-input.mjs';
import {sanitize} from '../../tooling/qualification/campaigns/common.mjs';

// Synthetic protocol cases only. No browser/native calls, presentation pixels,
// measured latency, collector admission or physical-input provenance.
const descriptor = (input = {kind: 'click'}) => discreteInputDescriptor({sessionId: 'visit-01', actionId: 'action-04', stepId: 'activate', family: 'layer', target: {control: 'layer-row', rowIndex: 2, layerId: 'image-a'}, input});
const modifiers = (change = {}) => ({control: false, meta: false, shift: false, alt: false, ...change});
function observation(d = descriptor(), rows = null) {
  rows ??= [
    {type: 'pointerdown', pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1},
    {type: 'pointerup', pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0},
    {type: 'click', pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0},
  ];
  return {descriptor: d, clock: 'browser-performance', timeOrigin: 1800000000000, endedTimeOrigin: 1800000000000,
    armedMs: 10, stoppedMs: 30, visibility: 'visible', endedVisibility: 'visible', targetConnectedAtArm: true, targetConnected: true, overflow: false,
    events: rows.map((row, ordinal) => ({eventId: `${d.sessionId}/${d.actionId}/${d.stepId}/event-${ordinal}`, ordinal,
      timeStampMs: 12 + ordinal, observedMs: 12.5 + ordinal, isTrusted: true, targetMatched: true, ...row}))};
}
const observerFor = raw => ({async begin() {}, async end() {return structuredClone(raw);}});
const key = (keyName, extra = {}) => ({type: 'keydown', keyName, code: keyName, repeat: false, modifiers: modifiers(), ...extra});
const keyPair = value => [key(value), {type: 'keyup', keyName: value}];

test('retains ordered browser event identity and input queue interval without presentation or physical claims', () => {
  const d = descriptor(), raw = observation(d), result = validateDiscreteInput(raw, d);
  assert.equal(result.status, 'PASS'); assert.equal(result.inputMs, 12);
  assert.equal(result.events[0].observedMs - result.events[0].timeStampMs, .5);
  assert.equal(result.events.length, 3); assert.deepEqual(result.initiatingEventIds, ['visit-01/action-04/activate/event-0']);
  assert.equal(result.qualification, false); assert.equal(result.automation.physicalInput, false);
  assert.equal(Object.hasOwn(result, 'latencyId'), false); assert.equal(Object.hasOwn(result, 'presentedMs'), false);
  raw.events[0].timeStampMs = 999; assert.equal(result.events[0].timeStampMs, 12);
  assert(Object.isFrozen(result.events[0]));
});

test('wrong target, reused event identity, untrusted event and incomplete click cannot be accepted', () => {
  for (const mutate of [
    raw => {raw.events[0].targetMatched = false;}, raw => {raw.events[2].eventId = raw.events[1].eventId;},
    raw => {raw.events[0].isTrusted = false;}, raw => {raw.events.pop();},
    raw => {raw.events[1].pointerId = 8;}, raw => {raw.events[2].pointerId = 8;},
    raw => {raw.events[2].button = 2;}, raw => {raw.events[1].isPrimary = false;},
  ]) {
    const d = descriptor(), raw = observation(d); mutate(raw);
    assert.equal(validateDiscreteInput(raw, d).status, 'FAIL');
  }
});

test('clock-origin changes, reversed creation time and hidden observation stay inconclusive', () => {
  for (const mutate of [raw => {raw.endedTimeOrigin++;}, raw => {raw.events[1].timeStampMs = 1;}, raw => {raw.endedVisibility = 'hidden';}]) {
    const d = descriptor(), raw = observation(d); mutate(raw);
    assert.equal(validateDiscreteInput(raw, d).status, 'INCONCLUSIVE');
  }
});

test('exact shortcut keeps modifier and ordinary events and selects the actual A keydown as initiator', () => {
  const d = descriptor({kind: 'press', key: 'ControlOrMeta+A'});
  const rows = [key('Meta', {modifiers: modifiers({meta: true})}), key('A', {modifiers: modifiers({meta: true})}),
    {type: 'keyup', keyName: 'A'}, {type: 'keyup', keyName: 'Meta'}];
  const value = validateDiscreteInput(observation(d, rows), d);
  assert.equal(value.status, 'PASS'); assert.equal(value.events.length, 4);
  assert.equal(value.inputMs, 13); assert.deepEqual(value.initiatingEventIds, ['visit-01/action-04/activate/event-1']);
  rows[1].modifiers = modifiers(); assert.equal(validateDiscreteInput(observation(d, rows), d).status, 'FAIL');
});

test('numeric sequential entry preserves each key; missing or reordered characters fail', () => {
  const d = descriptor({kind: 'press-sequentially', text: '12.5'}), rows = [...'12.5'].flatMap(keyPair);
  const result = validateDiscreteInput(observation(d, rows), d);
  assert.equal(result.status, 'PASS'); assert.equal(result.initiatingEventIds.length, 4);
  assert.equal(validateDiscreteInput(observation(d, rows.slice(1)), d).status, 'FAIL');
  assert.equal(validateDiscreteInput(observation(d, rows.toReversed()), d).status, 'FAIL');
});

test('Tab release may move focus, while another target cannot receive the initiating key', () => {
  const d = descriptor({kind: 'press', key: 'Tab'}), rows = [key('Tab'), {type: 'keyup', keyName: 'Tab', targetMatched: false}];
  assert.equal(validateDiscreteInput(observation(d, rows), d).status, 'PASS');
  rows[0].targetMatched = false; assert.equal(validateDiscreteInput(observation(d, rows), d).status, 'FAIL');
});

test('descriptor retains only admitted public identity, bounded numeric text and known input operations', () => {
  const d = descriptor();
  assert.equal(Object.hasOwn(discreteInputDescriptor({...d, privateState: 'forbidden'}), 'privateState'), false);
  for (const input of [{kind: 'press-sequentially', text: 'private text'}, {kind: 'press', key: 'Paste'}, {kind: 'dispatchEvent'}]) assert.throws(() => descriptor(input));
});

test('hook encloses one real dispatch and passive drain, with semantic work explicitly outside', async () => {
  const d = descriptor(), order = [], raw = observation(d);
  const result = await runDiscreteInputStep({descriptor: d, target: {},
    observer: {async begin() {order.push('arm');}, async end() {order.push('drain'); return raw;}},
    async dispatch() {order.push('dispatch');},
    async hook({descriptor: supplied, run}) {assert.deepEqual(supplied, d); order.push('A'); const value = await run(); order.push('B'); return {value, bracket: {actionId: supplied.actionId, stepId: supplied.stepId}};},
  });
  order.push('semantic-observation');
  assert.deepEqual(order, ['A', 'arm', 'dispatch', 'drain', 'B', 'semantic-observation']);
  assert.equal(result.dispatchCompleted, true); assert.equal(result.nativeBracketVerified, false);
  assert.equal(result.nativeBracket.actionId, d.actionId); assert.equal(result.inputEvidence.status, 'PASS');
});

test('hook failure before dispatch still performs the product action exactly once', async () => {
  const d = descriptor(); let count = 0;
  const value = await runDiscreteInputStep({descriptor: d, observer: observerFor(observation(d)), target: {}, dispatch: async () => {count++;}, hook: async () => {throw Error('clock');}});
  assert.equal(count, 1); assert.equal(value.dispatchCompleted, true); assert.equal(value.nativeBracket, null);
  assert(value.missing.includes('native-input-hook-failed'));
});

test('hook failure after dispatch preserves successful product result without replay', async () => {
  const d = descriptor(); let count = 0;
  const value = await runDiscreteInputStep({descriptor: d, observer: observerFor(observation(d)), target: {}, dispatch: async () => {count++;}, hook: async ({run}) => {await run(); throw Error('after ACK');}});
  assert.equal(count, 1); assert.equal(value.dispatchCompleted, true); assert.equal(value.inputEvidence.status, 'PASS');
  assert.equal(value.nativeBracket, null); assert(value.missing.includes('native-input-hook-failed'));
});

test('a repeated hook dispatch is refused even if the hook swallows its error', async () => {
  const d = descriptor(); let count = 0;
  const result = await runDiscreteInputStep({descriptor: d, observer: observerFor(observation(d)), target: {}, dispatch: async () => {count++;},
    hook: async ({run}) => {const value = await run(); assert.throws(() => run()); return {value, bracket: {}};}});
  assert.equal(count, 1); assert.equal(result.nativeBracket, null);
  assert(result.missing.includes('native-input-hook-repeated-or-late-dispatch'));
});

test('a returned-but-unawaited run is drained before owner completion; later dispatch is refused', async () => {
  const d = descriptor(); let saved, count = 0;
  const result = await runDiscreteInputStep({descriptor: d, observer: observerFor(observation(d)), target: {}, dispatch: async () => {count++;}, hook: async ({run}) => {saved = run; run();}});
  assert.equal(count, 1); assert.equal(result.dispatchCompleted, true); assert.equal(result.nativeBracket, null);
  assert.throws(() => saved()); assert.equal(count, 1);
});

test('observer failure never skips or repeats the requested input', async () => {
  const d = descriptor(); let count = 0;
  for (const observer of [{async begin() {throw Error('arm');}}, {async begin() {}, async end() {throw Error('drain');}}]) {
    const result = await runDiscreteInputStep({descriptor: d, observer, target: {}, dispatch: async () => {count++;}});
    assert.equal(result.dispatchCompleted, true); assert.equal(result.inputEvidence.status, 'INCONCLUSIVE');
  }
  assert.equal(count, 2);
});

test('product exception survives a hook which swallows it, with retained input attached', async () => {
  const d = descriptor(), failure = Error('product failed'); let count = 0;
  await assert.rejects(runDiscreteInputStep({descriptor: d, observer: observerFor(observation(d)), target: {}, dispatch: async () => {count++; throw failure;},
    hook: async ({run}) => {try {await run();} catch {} return {};}}), error => error === failure);
  assert.equal(count, 1); assert.equal(failure.discreteInputStep.dispatchCompleted, false);
  assert.equal(failure.discreteInputStep.inputEvidence.events.length, 3);
});

test('a primitive undefined product exception is not mistaken for a successful dispatch', async () => {
  const d = descriptor(); let caught = false;
  try {await runDiscreteInputStep({descriptor: d, target: {}, dispatch: async () => {throw undefined;}});} catch (error) {caught = true; assert.equal(error, undefined);}
  assert.equal(caught, true);
});

test('action recorder preserves all keyboard substeps and prevents identity reuse', async () => {
  let current, offset = 0;
  const observer = {async begin(_target, d) {current = d;}, async end() {
    const raw = observation(current, keyPair(current.input.keyName));
    raw.armedMs += offset; raw.stoppedMs += offset;
    for (const event of raw.events) {event.timeStampMs += offset; event.observedMs += offset;}
    offset += 30; return raw;
  }};
  const recorder = createDiscreteActionRecorder({observer, sessionId: 'visit-01', actionId: 'action-04', family: 'zoom'});
  for (const stepId of ['home', 'commit']) await recorder.step({stepId, target: {}, targetIdentity: {control: 'zoom-percentage'}, input: {kind: 'press', key: stepId === 'home' ? 'Home' : 'Tab'}, dispatch: async () => {}});
  const result = recorder.snapshot(); assert.equal(result.steps.length, 2); assert.equal(result.status, 'PASS'); assert.equal(result.qualification, false);
  assert.deepEqual(result.steps.map(value => value.inputEvidence.descriptor.stepId), ['home', 'commit']);
  await assert.rejects(recorder.step({stepId: 'home'}), /identity reused/);
});

test('keyboard release must match a preceding down and every pressed key must be released', () => {
  const d = descriptor({kind: 'press', key: 'Enter'});
  for (const rows of [[key('Enter')], [key('Enter'), {type: 'keyup', keyName: 'Escape'}], [{type: 'keyup', keyName: 'Enter'}, key('Enter')]]) {
    assert.equal(validateDiscreteInput(observation(d, rows), d).status, 'FAIL');
  }
  const sequential = descriptor({kind: 'press-sequentially', text: '12'});
  assert.equal(validateDiscreteInput(observation(sequential, [key('1'), key('2'), {type: 'keyup', keyName: '1'}, {type: 'keyup', keyName: '2'}]), sequential).status, 'FAIL');
});

test('shared receipt sanitization preserves admitted keyboard identity for raw replay', () => {
  const d = descriptor({kind: 'press', key: 'Enter'}), raw = observation(d, keyPair('Enter'));
  const retained = sanitize(raw);
  assert.equal(retained.descriptor.input.keyName, 'Enter'); assert.equal(retained.events[0].keyName, 'Enter');
  assert.equal(validateDiscreteInput(retained, d).status, 'PASS');
  const normalized = sanitize(validateDiscreteInput(raw, d));
  assert.equal(normalized.endedTimeOrigin, raw.endedTimeOrigin);
  assert.equal(validateDiscreteInput(normalized, d).status, 'PASS');
});

test('component notifications retain their actual trust but cannot serve as initiating input', () => {
  const d = descriptor({kind: 'press', key: 'Enter'});
  const notification = {type: 'change', isTrusted: false, targetMatched: false};
  const value = validateDiscreteInput(observation(d, [...keyPair('Enter'), notification]), d);
  assert.equal(value.status, 'PASS'); assert.equal(value.events[2].isTrusted, false);
  assert.deepEqual(value.initiatingEventIds, ['visit-01/action-04/activate/event-0']);
  assert.equal(validateDiscreteInput(observation(d, [notification]), d).status, 'FAIL');
});

test('action aggregation refuses changed clock origins and overlapping step intervals', async () => {
  for (const changeOrigin of [true, false]) {
    let current, ordinal = 0;
    const observer = {async begin(_target, d) {current = d;}, async end() {
      const raw = observation(current, keyPair('Tab'));
      if (ordinal++ && changeOrigin) {raw.timeOrigin++; raw.endedTimeOrigin++;}
      return raw;
    }};
    const recorder = createDiscreteActionRecorder({observer, sessionId: 'visit-01', actionId: 'action-04', family: 'zoom'});
    for (const stepId of ['one', 'two']) await recorder.step({stepId, target: {}, targetIdentity: {control: 'zoom-percentage'}, input: {kind: 'press', key: 'Tab'}, dispatch: async () => {}});
    const value = recorder.snapshot(); assert.equal(value.status, 'INCONCLUSIVE');
    assert(value.missing.includes(changeOrigin ? 'action-browser-clock-changed' : 'action-browser-step-order-unavailable'));
  }
});

test('input target may be replaced after its matched event without rewriting that identity', () => {
  const d = descriptor(), raw = observation(d); raw.targetConnected = false;
  const result = validateDiscreteInput(raw, d); assert.equal(result.status, 'PASS'); assert.equal(result.targetConnected, false);
  raw.events[0].targetMatched = false; assert.equal(validateDiscreteInput(raw, d).status, 'FAIL');
});

test('recorder retains a failed dispatch independently of extensibility of its exception', async () => {
  for (const failure of [undefined, Object.freeze(Error('frozen'))]) {
    let current;
    const observer = {async begin(_target, d) {current = d;}, async end() {return observation(current);}};
    const recorder = createDiscreteActionRecorder({observer, sessionId: 'visit-01', actionId: 'action-04', family: 'layer'});
    let caught = false;
    try {await recorder.step({stepId: 'activate', target: {}, targetIdentity: {control: 'layer-row'}, input: {kind: 'click'}, dispatch: async () => {throw failure;}});}
    catch (error) {caught = true; assert.equal(error, failure);}
    assert.equal(caught, true); assert.equal(recorder.snapshot().steps.length, 1);
    assert.equal(recorder.snapshot().status, 'FAIL'); assert(recorder.snapshot().failures.includes('product-input-dispatch-failed'));
  }
});

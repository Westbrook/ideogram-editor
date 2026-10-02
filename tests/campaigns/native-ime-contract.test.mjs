import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildNativeImePlan, inspectNativeImeTrace} from '../../tooling/qualification/campaigns/native-ime-contract.mjs';

const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);

// Explicitly synthetic scalar trace. Its trusted flags test the structural
// validator only; this fixture cannot prove native OS input or qualification.
function traceFixture({workload = 'WXn', commitInputAfterEnd = false} = {}) {
  const fragments = Array.from({length: 20}, (_, index) => 'fragment-' + index);
  fragments[3] = '中文'; fragments[10] = '日本語';
  const corpus = 'Initial multilingual text 😀.';
  const fixture = {text: {corpus: {text: corpus, sha256: hash(corpus), fragments, fragmentsHash: hash(JSON.stringify(fragments))}}};
  const plan = buildNativeImePlan(fixture, workload), nonce = 'synthetic-native-ime-attempt';
  const acceptedBefore = {documentId: 'document', documentRevision: 'revision', imageDigest: hash('image'), layerId: 'layer', layerVersion: 'layer-version', sourceHash: hash('source')};
  const state = {connected: true, parentUnchanged: true, nodeId: 1, parentId: 1, visible: true, focused: true,
    start: 0, end: 2, direction: 'forward', scrollTop: 12, scrollLeft: 3, units: corpus.length, textHash: hash(corpus),
    presentation: 'anchored', session: 'draft-session', revision: '1', textVersion: 1,
    switch: {pending: '', request: 0, requestEpoch: 2, requestGeneration: 1, requestTextVersion: 1, settled: 0,
      rejected: 0, rejectedEpoch: 0, rejectedGeneration: 0, rejectedCurrentEpoch: 0, rejectedCurrentGeneration: 0,
      rejectedTextVersion: 0, rejectedCurrentTextVersion: 0, rejectedGuards: 0, rejectedBoundary: '', reason: '', superseded: 0}};
  const initial = clone(state), records = [];
  let now = 100, capture = 1, composing = false, currentText = corpus;
  const value = next => {
    if (next !== currentText) {state.revision = String(Number(state.revision) + 1); state.textVersion++;}
    currentText = next; state.textHash = hash(next); state.units = next.length;
    state.start = state.end = next.length; state.direction = 'none';
  };
  const event = (type, {control = 'text', inputType = null, data = null, change = () => {}} = {}) => {
    if (type === 'compositionstart') composing = true;
    if (type === 'compositionend') composing = false;
    const row = {ordinal: records.length, type, timeStampMs: now, observedMs: now, afterObservedMs: now + 1,
      beforeCaptureOrdinal: ++capture, afterCaptureOrdinal: null, isTrusted: true, composing, control,
      eventDataHash: data === null ? null : hash(data), inputType, before: clone(state), after: null};
    change(); row.afterCaptureOrdinal = ++capture; row.after = clone(state); records.push(row); now += 10;
    return row;
  };
  const stateRow = () => {
    const ordinal = ++capture, snapshot = clone(state);
    records.push({ordinal: records.length, type: 'state', timeStampMs: null, observedMs: now, afterObservedMs: now,
      beforeCaptureOrdinal: ordinal, afterCaptureOrdinal: ordinal, isTrusted: null, composing, control: 'text',
      eventDataHash: null, inputType: null, before: snapshot, after: clone(snapshot)}); now += 10;
  };
  const request = deferred => event('click', {control: 'presentation', change: () => {
    const target = (state.switch.pending || state.presentation) === 'anchored' ? 'inspector' : 'anchored';
    const prior = state.switch.request;
    Object.assign(state.switch, {request: prior + 1, requestEpoch: 2, requestGeneration: Number(state.revision), requestTextVersion: state.textVersion});
    if (deferred) {
      if (state.switch.pending) Object.assign(state.switch, {rejected: prior, superseded: prior, reason: 'superseded'});
      state.switch.pending = target;
    } else {state.presentation = target; state.switch.settled = state.switch.request;}
  }});
  event('pointerdown', {control: 'presentation'});
  for (const item of plan.sequences) {
    if (item.index < 3) {
      state.direction = item.presentations[0].range; state.start = item.index === 2 ? currentText.length : 0; state.end = item.index === 2 ? state.start : 2;
      request(false);
    } else {state.start = state.end = currentText.length; state.direction = 'none';}
    const previous = currentText, desired = previous.slice(0, state.start) + fragments[item.fragmentIndex] + previous.slice(state.end);
    // An unchanged final replacement still needs a distinct tentative edit
    // before commit; trusted events alone do not advance the observed version.
    const preedit = item.outcome === 'commit' && desired !== previous ? desired : previous.slice(0, state.start) + '仮' + previous.slice(state.end);
    event('compositionstart', {data: ''});
    event('input', {inputType: 'insertCompositionText', data: item.outcome === 'commit' && preedit === desired ? fragments[item.fragmentIndex] : '仮',
      change: () => value(preedit)});
    if (item.index === 8) {request(true); request(true);}
    if (item.index === 9) {request(true); event('click', {control: 'cancel'});}
    const terminalInput = () => event('input', {inputType: item.outcome === 'commit' ? 'insertFromComposition' : 'deleteCompositionText',
      data: item.outcome === 'commit' ? fragments[item.fragmentIndex] : '', change: () => value(item.outcome === 'commit' ? desired : previous)});
    if (!commitInputAfterEnd || item.outcome === 'cancel') terminalInput();
    event('compositionend', {data: item.outcome === 'commit' ? fragments[item.fragmentIndex] : '', change: () => {
      if (item.index === 8) {state.presentation = state.switch.pending; state.switch.pending = ''; state.switch.settled = 5;}
      if (item.index === 9) {
        const captured = state.switch;
        Object.assign(state.switch, {pending: '', rejected: 6, rejectedEpoch: captured.requestEpoch, rejectedCurrentEpoch: 3,
          rejectedGeneration: captured.requestGeneration, rejectedCurrentGeneration: Number(state.revision),
          rejectedTextVersion: captured.requestTextVersion, rejectedCurrentTextVersion: state.textVersion,
          rejectedGuards: 7, rejectedBoundary: 'cancel-native-end', reason: 'cancelled'});
        state.session = ''; state.visible = false; state.focused = false;
        currentText = ''; state.units = 0; state.textHash = hash(''); state.start = state.end = 0;
      }
    }});
    if (commitInputAfterEnd && item.outcome === 'commit') terminalInput();
    stateRow();
  }
  const raw = {kind: 'native-ime-raw-1', nonce, clock: 'browser-performance', timeOrigin: 1700000000000,
    armedMs: 90, startMs: 100, endMs: 60100, captureStoppedMs: 60101, durationMs: 60000,
    initial, final: clone(state), records, overflow: false, interruptions: [], cleanup: {removed: true}};
  return {fixture, plan, nonce, raw, acceptedBefore, acceptedAfter: clone(acceptedBefore)};
}
const inspect = value => inspectNativeImeTrace(value.raw, value);
const snapshots = value => value.raw.records.flatMap(row => [row.before, row.after]);

test('plan references the sealed Japanese and Chinese fragments with exact 10/8/2 and six existing requests', () => {
  for (const workload of ['WXn', 'WXs']) {
    const value = traceFixture({workload}), {plan} = value;
    assert.equal(plan.durationMs, 60000); assert.equal(plan.sequences.length, 10);
    assert.equal(plan.inputSource, workload === 'WXn' ? 'japanese' : 'simplified-chinese');
    assert.equal(plan.sequences.filter(item => item.outcome === 'commit').length, 8);
    assert.deepEqual(plan.sequences.filter(item => item.outcome === 'cancel').map(item => item.index), [7, 9]);
    assert.deepEqual(plan.sequences.flatMap(item => item.presentations.map(request => request.sequence)), [1, 2, 3, 4, 5, 6]);
    assert.ok(Object.isFrozen(plan.sequences[0]));
  }
  const value = traceFixture(); value.fixture.text.corpus.fragments[10] = 'changed';
  assert.throws(() => buildNativeImePlan(value.fixture, 'WXn'), /FRAGMENTS_HASH/);
  assert.throws(() => buildNativeImePlan(traceFixture().fixture, 'WXl'), /WORKLOAD/);
});

test('synthetic structural traces support input before or after native end without granting native authority', () => {
  for (const workload of ['WXn', 'WXs']) for (const commitInputAfterEnd of [false, true]) {
    const value = traceFixture({workload, commitInputAfterEnd}), result = inspect(value);
    assert.equal(result.status, 'PASS', JSON.stringify(result));
    assert.deepEqual(result.missing, []); assert.deepEqual(result.failures, []);
    assert.equal(result.observation.commits, 8); assert.equal(result.observation.cancels, 2);
    assert.equal(result.observation.presentationRequests, 6);
    if (workload === 'WXs') {
      const sequence = result.observation.sequences[1], start = value.raw.records[sequence.startOrdinal];
      const preedit = value.raw.records.slice(sequence.startOrdinal + 1, sequence.endOrdinal).find(row => row.type === 'input');
      const terminal = value.raw.records[sequence.terminal.ordinal][sequence.terminal.phase];
      assert.equal(sequence.expectedTextHash, sequence.startingTextHash);
      assert.notEqual(preedit.after.textHash, sequence.startingTextHash);
      assert.equal(terminal.textHash, sequence.expectedTextHash);
      assert.ok(terminal.textVersion > start.before.textVersion);
    }
    assert.equal(result.observation.presentation.deferredRequestRejection.guardMask, 7);
    assert.equal(result.observation.presentation.deferredRequestRejection.versionMeaning, 'draft-text-version');
    assert.equal(result.observation.presentation.deferredRequestRejection.acceptedVersion.rejectionObserved, false);
    for (const key of ['qualification', 'nativeImeAuthority', 'trustedEventsAreSufficient', 'physicalInput', 'physicalMetrics']) assert.equal(result.observation[key], false);
  }
});

test('state snapshots have no invented DOM timestamp and exact capture order survives equal clock values', () => {
  const value = traceFixture();
  for (const row of value.raw.records) {if (row.type !== 'state') row.timeStampMs = 100; row.observedMs = row.afterObservedMs = 100;}
  assert.equal(inspect(value).status, 'PASS');
  const row = value.raw.records.find(row => row.type === 'state');
  assert.equal(row.timeStampMs, null); row.timeStampMs = 100;
  assert.ok(inspect(value).missing.includes('complete-native-ime-event-state-unavailable'));
  const reordered = traceFixture(); reordered.raw.records[2].beforeCaptureOrdinal = reordered.raw.records[1].afterCaptureOrdinal;
  assert.ok(inspect(reordered).failures.includes('native-ime-snapshot-capture-order-differs'));
});

test('absence of real trusted composition input, cleanup, or a complete interval stays inconclusive', () => {
  for (const change of [value => {value.raw.startMs = null;}, value => {value.raw.cleanup.removed = false;},
    value => {value.raw.overflow = true;}, value => {value.raw.interruptions.push('aborted');},
    value => {for (const row of value.raw.records) if (row.type === 'input') row.type = 'beforeinput';}]) {
    const value = traceFixture(); change(value); assert.equal(inspect(value).status, 'INCONCLUSIVE');
  }
});

test('trusted metadata and empty compositionend do not substitute for exact committed and restored text', () => {
  const value = traceFixture(), starts = value.raw.records.filter(row => row.type === 'compositionstart');
  const from = starts[7].ordinal, until = starts[8].ordinal;
  for (const row of value.raw.records.slice(from + 1, until)) for (const state of [row.before, row.after]) state.textHash = hash('wrong restoration');
  const result = inspect(value); assert.notEqual(result.status, 'PASS');
  assert.ok(result.missing.includes('native-ime-outcome-state-unavailable'));
  const paste = traceFixture(); paste.raw.records.find(row => row.type === 'input').inputType = 'insertFromPaste';
  assert.ok(inspect(paste).failures.includes('native-ime-noncomposition-edit-observed'));
  const untrusted = traceFixture(); untrusted.raw.records.find(row => row.type === 'compositionstart').isTrusted = false;
  assert.ok(inspect(untrusted).failures.includes('untrusted-native-ime-event'));
});

test('same node, parent, focused composition and accepted document/layer identities are actual invariants', () => {
  for (const [edit, key] of [
    [value => {value.acceptedAfter.layerVersion = 'changed';}, 'accepted-document-layer-changed'],
    [value => {value.raw.records[4].after.nodeId = 2;}, 'native-ime-node-or-parent-changed'],
    [value => {value.raw.records[4].after.parentUnchanged = false;}, 'native-ime-node-or-parent-changed'],
    [value => {value.raw.records.find(row => row.type === 'compositionstart').after.focused = false;}, 'native-ime-focus-or-visibility-lost-during-composition'],
    [value => {value.raw.records[4].after.session = ''; value.raw.records[4].after.visible = false;}, 'native-ime-session-hidden-or-replaced-before-native-end']]) {
    const value = traceFixture(); edit(value); assert.ok(inspect(value).failures.includes(key), key);
  }
});

test('exact six requests and native latest/cancel settlements cannot be replaced by matching final presentation', () => {
  for (const patch of [{rejectedGuards: 3}, {rejectedGuards: 15}, {rejectedBoundary: 'restore-input'},
    {reason: 'stale-generation'}, {rejectedCurrentEpoch: 2}, {settled: 6}]) {
    const value = traceFixture();
    for (const state of snapshots(value)) if (state.session === '') Object.assign(state.switch, patch);
    assert.equal(inspect(value).status, 'FAIL');
  }
  const missing = traceFixture(); missing.raw.records.find(row => row.type === 'click' && row.before.switch.request === 3).control = 'text';
  assert.ok(inspect(missing).missing.includes('exact-six-native-presentation-clicks-unavailable'));
  const range = traceFixture(); range.raw.records.find(row => row.type === 'click').after.start++;
  assert.ok(inspect(range).failures.includes('native-ime-immediate-range-or-node-not-preserved'));
});

test('late posthandler or final grace snapshots cannot provide the final Cancel witness', () => {
  const value = traceFixture(), finalEnd = value.raw.records.filter(row => row.type === 'compositionend').at(-1);
  value.raw.records = value.raw.records.slice(0, finalEnd.ordinal + 1);
  finalEnd.afterObservedMs = value.raw.endMs + 1;
  assert.equal(value.raw.final.switch.rejectedGuards, 7);
  const result = inspect(value); assert.equal(result.status, 'INCONCLUSIVE');
  assert.ok(result.missing.includes('native-ime-native-end-settlement-unavailable'));
  const nonce = traceFixture(); nonce.nonce = 'another-attempt';
  assert.ok(inspect(nonce).failures.includes('native-ime-attempt-nonce-differs'));
});

test('bounded malformed and absent evidence does not gain defaults from a valid plan', () => {
  const value = traceFixture(); value.raw.records = Array(4097).fill(value.raw.records[0]);
  assert.equal(inspect(value).status, 'INCONCLUSIVE');
  const absent = traceFixture(); absent.raw.records[0].before.textVersion = null;
  assert.ok(inspect(absent).missing.includes('complete-native-ime-event-state-unavailable'));
  const changed = traceFixture(); changed.plan = clone(changed.plan); changed.plan.sequences[0].fragmentHash = hash('foreign');
  assert.ok(inspect(changed).failures.includes('native-ime-plan-differs'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPresentationTarget, inspectTextPresentationWitness } from '../../tooling/qualification/campaigns/text-presentation-observation.mjs';
import { buildTextInteractionPlan } from '../../tooling/qualification/campaigns/browser-text.mjs';

function witness() {
  let state = { presentation: 'anchored', session: 'draft', revision: '10', textVersion: 3, start: 0, end: 4, direction: 'forward',
    switch: { request: 0, requestEpoch: 2, requestGeneration: 10, requestTextVersion: 3, settled: 0, rejected: 0, rejectedEpoch: 0, rejectedGeneration: 0, rejectedCurrentEpoch: 0, rejectedCurrentGeneration: 0, rejectedTextVersion: 0, rejectedCurrentTextVersion: 0, rejectedGuards: 0, rejectedBoundary: '', superseded: 0, reason: '', pending: '' } };
  const result = { kind: 'text-presentation-observation-1', requests: [], latest: null, cancellation: null };
  const actions = buildTextInteractionPlan().filter(action => action.kind === 'presentation');
  for (let index = 0; index < 6; index++) {
    const before = structuredClone(state), target = nextPresentationTarget(before);
    state.switch.request++;
    if (index < 3) { state.presentation = target; state.switch.settled = state.switch.request; }
    else { state.switch.pending = target; if (index === 4) { state.switch.rejected = index; state.switch.superseded = index; state.switch.reason = 'superseded'; } }
    result.requests.push({ actionId: actions[index].id, mode: actions[index].mode, target, before, after: structuredClone(state) });
    if (index === 4) {
      const beforeEnd = structuredClone(state); state.presentation = target; state.switch.pending = ''; state.switch.settled = 5;
      result.latest = { beforeEnd, afterEnd: structuredClone(state) };
    }
    if (index === 5) {
      const beforeCancel = structuredClone(state); state.session = ''; state.revision = '11'; state.textVersion = 4; state.switch.pending = '';
      Object.assign(state.switch, { rejected: 6, rejectedEpoch: 2, rejectedCurrentEpoch: 3, rejectedGeneration: 10, rejectedCurrentGeneration: 11, rejectedTextVersion: 3, rejectedCurrentTextVersion: 4, rejectedGuards: 7, rejectedBoundary: 'cancel-native-end', reason: 'cancelled' });
      result.cancellation = { beforeCancel, afterCancel: structuredClone(state) };
    }
  }
  return result;
}

test('fixed six requests discriminate latest target even when it returns to the original presentation', () => {
  const value = witness(), result = inspectTextPresentationWitness(value);
  assert.notEqual(value.requests[3].target, value.requests[4].target);
  assert.equal(value.requests[4].before.presentation, value.latest.afterEnd.presentation);
  assert.deepEqual(result.missing, []); assert.deepEqual(result.failures, []);
  assert.equal(result.latestDeferredOnlyAfterNativeEnd, true); assert.equal(result.cancelDropsDeferred, true); assert.equal(result.staleDeferredRequestRejected, true);
  assert.deepEqual(result.deferredRequestRejection.witnessedGuards, ['stale-session', 'stale-generation', 'stale-version']);
  assert.deepEqual(result.deferredRequestRejection.unobservedGuards, []);
  assert.equal(result.deferredRequestRejection.versionMeaning, 'draft-text-version');
  assert.deepEqual(result.deferredRequestRejection.capturedState, {epoch: 2, generation: 10, textVersion: 3});
  assert.deepEqual(result.deferredRequestRejection.currentState, {epoch: 3, generation: 11, textVersion: 4});
  assert.deepEqual(result.deferredRequestRejection.acceptedVersion, {scope: 'accepted-document-layer-version', invariantUnchanged: true, rejectionObserved: false});
  assert.match(result.boundary, /physical.*independent/);
  assert.equal(buildTextInteractionPlan().length, 106);
});

test('matching final CSS presentation cannot substitute for superseding and settling the latest request', () => {
  for (const edit of [value => { value.latest.afterEnd.switch.settled = 4; }, value => { value.requests[4].after.switch.superseded = 0; }, value => { value.requests[4].target = value.requests[3].target; }, value => { value.latest.beforeEnd.switch.settled = 5; }]) {
    const value = witness(); edit(value); const result = inspectTextPresentationWitness(value);
    assert(result.failures.length > 0); assert.equal(result.latestDeferredOnlyAfterNativeEnd, false);
  }
});

test('existing Cancel binds each rejected guard to captured and current scalar identities', () => {
  for (const patch of [{ rejectedCurrentGeneration: 10 }, { rejectedCurrentEpoch: 2 }, { reason: 'stale-generation' },
    { rejected: 5 }, { settled: 6 }, { rejectedTextVersion: 2 }, { rejectedCurrentTextVersion: 3 },
    { rejectedGuards: 3 }, { rejectedGuards: 15 }, { rejectedBoundary: 'restore-input' }]) {
    const value = witness(); Object.assign(value.cancellation.afterCancel.switch, patch);
    const result = inspectTextPresentationWitness(value); assert.equal(result.staleDeferredRequestRejected, false); assert(result.failures.length);
    assert.deepEqual(result.deferredRequestRejection.witnessedGuards, []);
  }
  for (const edit of [value => { value.requests[5].after.textVersion++; }, value => { value.requests[5].after.switch.requestTextVersion++; },
    value => { value.cancellation.beforeCancel.session = 'foreign'; }, value => { value.cancellation.beforeCancel.textVersion++; },
    value => { value.cancellation.afterCancel.textVersion++; }, value => { value.cancellation.afterCancel.revision = '12'; }]) {
    const value = witness(); edit(value); const result = inspectTextPresentationWitness(value);
    assert.equal(result.staleDeferredRequestRejected, false); assert(result.failures.includes('existing-cancel-observes-session-generation-text-version-rejection'));
  }
  const missing = witness(); missing.cancellation.afterCancel.switch.rejectedGeneration = null;
  assert.equal(inspectTextPresentationWitness(missing).staleDeferredRequestRejected, null);
  assert(inspectTextPresentationWitness(missing).missing.includes('actual-stale-rejection-numeric-guard-tuple'));
});

test('historical generation-only rejection keeps session and draft-version evidence missing', () => {
  const value = witness(), after = value.cancellation.afterCancel;
  Object.assign(after.switch, {reason: 'stale-generation', rejectedCurrentEpoch: 2});
  for (const key of ['rejectedTextVersion', 'rejectedCurrentTextVersion', 'rejectedGuards', 'rejectedBoundary']) delete after.switch[key];
  const result = inspectTextPresentationWitness(value);
  assert.equal(result.staleDeferredRequestRejected, null);
  assert(result.missing.includes('actual-cancel-native-end-draft-guard-tuple'));
  assert.equal(result.deferredRequestRejection.kind, 'deferred-presentation-rejection-1');
  assert.deepEqual(result.deferredRequestRejection.witnessedGuards, ['stale-generation']);
  assert.deepEqual(result.deferredRequestRejection.unobservedGuards, ['stale-session', 'stale-version']);
});

test('absent request instrumentation and extra requests cannot be counted as a complete fixed specimen', () => {
  const missing = witness(); delete missing.requests[4].after.switch;
  assert(inspectTextPresentationWitness(missing).missing.includes('request-after-state'));
  const extra = witness(); extra.requests.push(structuredClone(extra.requests[5]));
  assert(inspectTextPresentationWitness(extra).missing.includes('exact-six-presentation-request-observations'));
  assert.throws(() => nextPresentationTarget({ presentation: null }), /unavailable/);
});

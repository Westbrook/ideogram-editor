import test from 'node:test';
import assert from 'node:assert/strict';
import {browserActionOutcome, retainBrowserActionFailure} from '../../tooling/qualification/campaigns/browser.mjs';
import {PrerequisiteError} from '../../tooling/qualification/campaigns/common.mjs';

const empty = () => ({caughtFailure: false, productFailureSeen: false});
const observe = (state, failure) => retainBrowserActionFailure(state, failure);
const outcome = state => browserActionOutcome({...state, resultStatus: 'INCONCLUSIVE', missing: ['raw-feedback-unavailable']});

test('a prerequisite followed by canonical cleanup or navigation failure becomes FAIL', () => {
  for (const message of ['Canonical visit cleanup failed', 'Navigation after the scored visit failed']) {
    const prerequisite = new PrerequisiteError('Native input evidence unavailable');
    const first = observe(empty(), prerequisite), final = observe(first, Error(message));
    assert.equal(outcome(first).status, 'INCONCLUSIVE'); assert.equal(first.productFailureSeen, false);
    assert.equal(final.failure, prerequisite); assert.equal(final.productFailureSeen, true);
    assert.equal(outcome(final).status, 'FAIL'); assert.equal(outcome(final).actionCompleted, false);
    assert.equal(outcome(final).error.message, prerequisite.message);
    assert.deepEqual(outcome(final).failureClassification, {productFailureSeen: true, firstFailureWasPrerequisite: true});
  }
});

test('a later unexpected browser or external-egress signal cannot hide behind a prerequisite', () => {
  const first = observe(empty(), new PrerequisiteError('Earlier unavailable measurement'));
  const signaled = observe(first, Error('Unexpected browser failure or attempted external request'));
  assert.equal(signaled.productFailureSeen, true);
  assert.equal(browserActionOutcome({...signaled, resultStatus: 'PASS', missing: []}).status, 'FAIL');
  assert.equal(browserActionOutcome({...signaled, byteAudit: true, missing: []}).status, 'FAIL');
});

test('an actual product failure remains FAIL after any later prerequisite', () => {
  for (const original of [Error('Product failed'), undefined, null, false, 0, '', 'product failure']) {
    let state = observe(empty(), original);
    state = observe(state, new PrerequisiteError('Later native capture missing'));
    state = observe(state, new PrerequisiteError('Later trace missing'));
    assert.equal(state.failure, original); assert.equal(state.productFailureSeen, true);
    assert.equal(outcome(state).status, 'FAIL'); assert.equal(outcome(state).actionCompleted, false);
    assert.deepEqual(outcome(state).failureClassification, {productFailureSeen: true, firstFailureWasPrerequisite: false});
  }
});

test('a later falsy rejection is a product failure even when the retained first diagnostic is a prerequisite', () => {
  for (const rejection of [undefined, null, false, 0, '']) {
    const prerequisite = new PrerequisiteError('First diagnostic');
    const state = observe(observe(empty(), prerequisite), rejection);
    assert.equal(state.failure, prerequisite); assert.equal(state.productFailureSeen, true);
    assert.equal(outcome(state).status, 'FAIL'); assert.equal(outcome(state).actionCompleted, false);
  }
});

test('prerequisite-only sequences retain INCONCLUSIVE and the first diagnostic', () => {
  const first = new PrerequisiteError('First missing prerequisite');
  const state = observe(observe(empty(), first), new PrerequisiteError('Second missing prerequisite'));
  assert.equal(state.failure, first); assert.equal(state.productFailureSeen, false);
  assert.equal(outcome(state).status, 'INCONCLUSIVE'); assert.equal(outcome(state).error.message, first.message);
  assert.deepEqual(outcome(state).failureClassification, {productFailureSeen: false, firstFailureWasPrerequisite: true});
});

test('later thrown accessors cannot run or prevent the failure latch', () => {
  let reads = 0;
  const failure = Object.defineProperties({}, Object.fromEntries(['name', 'message', 'code'].map(key => [key, {get() {reads++; throw Error('Must not evaluate accessor');}}])));
  const state = observe(observe(empty(), new PrerequisiteError('First prerequisite')), failure);
  assert.equal(reads, 0); assert.equal(state.productFailureSeen, true);
  assert.equal(outcome(state).status, 'FAIL'); assert.equal(reads, 0);
});

test('failure retention leaves previous snapshots unchanged and cannot clear a true latch', () => {
  const prior = Object.freeze(observe(empty(), new PrerequisiteError('First prerequisite')));
  const failed = observe(prior, Error('Cleanup failure'));
  assert.equal(prior.productFailureSeen, false); assert.notEqual(failed, prior);
  const later = observe(Object.freeze(failed), new PrerequisiteError('Later prerequisite'));
  assert.equal(later.productFailureSeen, true); assert.equal(outcome(later).status, 'FAIL');
});

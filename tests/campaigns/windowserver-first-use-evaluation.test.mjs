import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFirstUse, evaluateInteraction} from '../../tooling/qualification/campaigns/metrics.mjs';
import {readVerifiedFirstUseBounds} from '../../tooling/qualification/campaigns/windowserver-first-use-verification.mjs';

// Source-authored protocol cases. These tests never start a native collector,
// mint a private verifier token, or establish real panel/presentation evidence.
const trace = () => ({kind: 'browser-presentation-trace', sha256: 'a'.repeat(64), attributionComplete: true});
function legacy(ordinal = 1, acknowledgementMs = 50, readinessMs = 250) {
  return {id: `first-${ordinal}`, reset: true, startMs: 1000, endMs: 2000, inputMs: 1010,
    readyMs: 1010 + readinessMs, presentedMs: 1010 + acknowledgementMs, meaningful: true, feature: 'Mask', trace: trace(), outcome: 'expected'};
}
const ten = () => Array.from({length: 10}, (_, index) => legacy(index + 1));
const claimedProof = () => ({kind: 'verified-first-use-windowserver-bounds-1', qualification: true, verified: true,
  acknowledgement: {upperBoundMs: 1, ceilingMs: 100, withinWindow: true}, readiness: {upperBoundMs: 1, ceilingMs: 750, withinWindow: true}});
function unavailableNative() {
  return ten().map(value => ({...value, presentedMs: null, inputClock: 'browser-performance', inputTimeOrigin: 1000,
    readyClock: 'runner-monotonic', windowClock: 'runner-monotonic', trace: {kind: 'browser-diagnostic-trace', sha256: 'b'.repeat(64), attributionComplete: false},
    nativePresentation: {kind: 'first-use-windowserver-observation-1', qualification: true, join: {status: 'observed',
      firstMeaningfulPaintUpperBoundMs: 1, firstMeaningfulPaintExactMs: null, firstMeaningfulPaintLowerBoundMs: null,
      ceilingAssessment: 'upper-bound-within-ceiling', semanticReviewRequired: false, collectorSourceAndInvocationAdmissionRequired: false}}}));
}

test('legacy exact R04 and R06 boundaries retain their original failures and statistics', () => {
  const values = ten(); values[9] = legacy(10, 100, 750);
  const observed = evaluateFirstUse(values);
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.qualification, false);
  assert.deepEqual(observed.acknowledgements, {n: 10, p95: 100, max: 100});
  assert.deepEqual(observed.readiness, {n: 10, p95: 750, max: 750});
  assert.equal(observed.upperBounds.acknowledgements.n, 0); assert.equal(observed.upperBounds.acknowledgements.max, null);
  assert.equal(observed.upperBounds.readiness.n, 0); assert.equal(observed.upperBounds.readiness.max, null);
  values[9].presentedMs++;
  assert.ok(evaluateFirstUse(values).failures.includes('R04-first-use-acknowledgement'));
  values[9].readyMs++;
  const failed = evaluateFirstUse(values);
  assert.equal(failed.outcome, 'FAIL'); assert.ok(failed.failures.includes('R06-lazy-readiness'));
});

test('legacy inventory, reset window, meaningful acknowledgement and trace remain mandatory', () => {
  assert.ok(evaluateFirstUse(ten().slice(1)).missing.includes('ten-first-use-windows'));
  const duplicate = ten(); duplicate[1].id = duplicate[0].id;
  assert.ok(evaluateFirstUse(duplicate).missing.includes('ten-first-use-windows'));
  for (const mutate of [
    value => {value.reset = false;}, value => {value.endMs++;}, value => {value.inputMs = value.startMs - 1;},
    value => {value.readyMs = value.endMs + 1;}, value => {value.presentedMs = null;}, value => {value.meaningful = false;},
    value => {value.trace.kind = 'requestAnimationFrame';}, value => {value.trace.attributionComplete = false;},
  ]) {
    const values = ten(); mutate(values[0]);
    const observed = evaluateFirstUse(values); assert.notEqual(observed.outcome, 'PASS'); assert.ok(observed.missing.length > 0);
  }
});

test('unknown, copied and serialized private-looking tokens are unavailable', () => {
  const record = unavailableNative()[0], claimed = claimedProof();
  for (const token of [undefined, null, false, 1, 'verified', {}, claimed, {...claimed}, structuredClone(claimed), JSON.parse(JSON.stringify(claimed))]) {
    assert.equal(readVerifiedFirstUseBounds(token, record), null);
  }
  for (const token of [false, 1, 'verified', {}, claimed, {...claimed}, structuredClone(claimed), JSON.parse(JSON.stringify(claimed))]) {
    const values = unavailableNative(); for (const value of values) value.nativePresentationProof = token;
    const observed = evaluateFirstUse(values);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
    assert.ok(observed.missing.length > 0); assert.equal(observed.upperBounds.acknowledgements.n, 0); assert.equal(observed.upperBounds.readiness.n, 0);
    assert.deepEqual(observed.acknowledgements, {n: 0, p95: null, max: null});
    assert.deepEqual(observed.readiness, {n: 0, p95: null, max: null});
    assert.ok(values.every(value => value.presentedMs === null));
  }
});

test('serialized upper bounds, exact-looking fields and approval flags cannot forge admission', () => {
  for (const upperBoundMs of [undefined, null, 0, 1, 100, 101, 750, 751, -1, Number.NaN, Infinity]) {
    const values = unavailableNative();
    for (const value of values) {
      value.firstMeaningfulPaintUpperBoundMs = upperBoundMs; value.upperBoundMs = upperBoundMs;
      value.nativePresentationVerified = true; value.qualification = true;
      value.nativePresentation.join.firstMeaningfulPaintUpperBoundMs = upperBoundMs;
      value.nativePresentationProof = claimedProof();
    }
    const observed = evaluateFirstUse(values);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
    assert.equal(observed.upperBounds.acknowledgements.n, 0); assert.equal(observed.upperBounds.readiness.n, 0);
    assert.equal(observed.acknowledgements.n, 0); assert.equal(observed.readiness.n, 0);
  }
});

test('unverified mixed clock numbers never become R06 durations or lateness failures', () => {
  for (const [inputMs, readyMs] of [[1, 999999999], [999999999, 1], [0, 751]]) {
    const values = unavailableNative(); for (const value of values) {value.inputMs = inputMs; value.readyMs = readyMs;}
    const observed = evaluateFirstUse(values);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
    assert.equal(observed.readiness.n, 0); assert.equal(observed.upperBounds.readiness.n, 0);
  }
});

test('observed product failures and legacy exact misses retain FAIL priority', () => {
  const values = unavailableNative(); values[0].outcome = 'failed';
  assert.equal(evaluateFirstUse(values).outcome, 'FAIL');
  values[0] = {...legacy(1, 101, 751), nativePresentationProof: claimedProof()};
  const observed = evaluateFirstUse(values);
  assert.equal(observed.outcome, 'FAIL'); assert.ok(observed.failures.includes('R04-first-use-acknowledgement'));
  assert.ok(observed.failures.includes('R06-lazy-readiness'));
  const interaction = evaluateInteraction({profile: 'P', protocol: 'I', cohortKey: 'synthetic', sessions: [], firstUse: values, hotEdits: []});
  assert.equal(interaction.outcome, 'FAIL'); assert.ok(interaction.failures.includes('R04-first-use-acknowledgement'));
  assert.ok(interaction.failures.includes('R06-lazy-readiness'));
});

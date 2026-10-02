import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSession, evaluateInteraction} from '../../tooling/qualification/campaigns/metrics.mjs';
import * as sessionVerification from '../../tooling/qualification/campaigns/windowserver-session-verification.mjs';

// Arithmetic-only legacy fixtures, adapted by source copy from the maintained
// metrics suite. They do not establish actual input or native presentation.
// Positive private-proof replay belongs to the separate full retained fixture.
function legacySession() {
  const actions = [];
  for (let stroke = 0; stroke < 20; stroke++) {
    const inputMs = stroke * 2000;
    actions.push({id: `stroke-${stroke}`, kind: 'stroke', inputMs, presentedMs: inputMs + 10, meaningful: true,
      samples: Array.from({length: 120}, (_, index) => ({id: `${stroke}-${index}`, inputMs: inputMs + Math.round(index * 1000 / 60),
        presentedMs: inputMs + Math.round(index * 1000 / 60) + 10})),
      pointerSchedule: {clock: 'runner-monotonic', frequencyHz: 60, samples: Array.from({length: 120}, (_, index) => ({index,
        scheduledMs: 1000000 + inputMs + index * 1000 / 60, dispatchStartedMs: 1000000 + inputMs + index * 1000 / 60 + 2,
        dispatchCompletedMs: 1000000 + inputMs + index * 1000 / 60 + 3}))}});
  }
  for (let index = 0; index < 80; index++) actions.push({id: `discrete-${index}`, kind: 'discrete', inputMs: 40000 + index * 200,
    presentedMs: 40010 + index * 200, meaningful: true});
  return {id: 'session-warm-1', cache: 'warm', ordinal: 1, cohortKey: 'synthetic-session-cohort', clock: 'browser-performance',
    timeOrigin: 1800000000000, startMs: 0, endMs: 60000, visibility: 'visible', refreshHz: 60,
    trace: {kind: 'browser-presentation-trace', sha256: 'a'.repeat(64), attributionComplete: true}, actions,
    activeSegments: [{startMs: 0, endMs: 60000,
      mainThreadIntervals: Array.from({length: 3600}, (_, index) => ({startMs: index * 1000 / 60, endMs: index * 1000 / 60 + 1})),
      slots: Array.from({length: 3600}, (_, index) => ({index, presented: true}))}]};
}
function unavailableNative() {
  const session = legacySession();
  for (const action of session.actions) {
    action.presentedMs = null;
    for (const point of action.samples ?? []) point.presentedMs = null;
  }
  session.refreshHz = null; session.requestedRefreshHz = 60; session.activeSegments = [];
  session.trace = {kind: 'browser-diagnostic-trace', sha256: 'b'.repeat(64), attributionComplete: false};
  session.nativePresentation = {kind: 'generic-windowserver-observation-1', qualification: false,
    profile: 'interaction-100-2400-60hz-60s-1', join: {status: 'OBSERVED', qualification: false},
    lossObservations: {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null}};
  return session;
}
function claimedProof(session, upperBoundMs = 1) {
  const bound = {status: 'OBSERVED', upperBoundMs, exactMs: null, lowerMs: null, withinWindow: true,
    endpoint: 'WindowServer-presented-pixels', ceilingAssessment: 'upper-bound-within-ceiling'};
  return {kind: 'verified-session-windowserver-bounds-1', qualification: true, verified: true,
    exactLatency: false, requiredActions: 100, requiredPointerSamples: 2400,
    actions: session.actions.map((action, sequence) => ({id: action.id, sequence, family: action.kind,
      acknowledgement: {...bound, ceilingMs: 100, targetMs: 50},
      pointer: (action.samples ?? []).map(point => ({id: point.id, ...bound, referenceCeilingMs: 33.4}))}))};
}
function unavailableStats(observed) {
  assert.deepEqual(observed.acknowledgements, {n: 0, p95: null, max: null});
  assert.deepEqual(observed.pointer, {n: 0, p95: null, max: null});
  for (const key of ['acknowledgements', 'pointer']) {
    assert.equal(observed.upperBounds[key].n, 0);
    assert.equal(observed.upperBounds[key].p95, null);
    assert.equal(observed.upperBounds[key].max, null);
  }
  assert.equal(observed.upperBounds.exactLatency, false);
  assert.equal(observed.upperBounds.acknowledgements.required, 100);
  assert.equal(observed.upperBounds.acknowledgements.observedWithinCeiling, 0);
  assert.equal(observed.upperBounds.acknowledgements.ceilingAssessment, 'unavailable');
  assert.deepEqual(observed.upperBounds.acknowledgements.actions, []);
  assert.equal(observed.upperBounds.pointer.required, 2400);
  assert.equal(observed.upperBounds.pointer.diagnosticOnly, true);
}

test('legacy exact acknowledgement, pointer, work and drop ceilings retain their boundaries', () => {
  const session = legacySession(); session.actions.at(-1).presentedMs = session.actions.at(-1).inputMs + 100;
  session.activeSegments[0].mainThreadIntervals = [{startMs: 0, endMs: 10}];
  for (let index = 0; index < 180; index++) session.activeSegments[0].slots[index].presented = false;
  const observed = evaluateSession(session);
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.qualification, false);
  assert.deepEqual(observed.acknowledgements, {n: 100, p95: 10, max: 100});
  assert.deepEqual(observed.pointer, {n: 2400, p95: 10, max: 10});
  assert.equal(observed.frameWork.max, 10); assert.equal(observed.droppedShare60SecondSession, .05);
  assert.equal(observed.upperBounds.acknowledgements.n, 0); assert.equal(observed.upperBounds.pointer.n, 0);
  session.actions.at(-1).presentedMs++;
  assert.ok(evaluateSession(session).failures.includes('R04-acknowledgement-over-100ms'));
  // Use a common zero input for the isolated decimal threshold calculation;
  // adding 33.4 to large inputs would introduce subtraction rounding noise.
  const pointer = legacySession();
  for (const action of pointer.actions) for (const point of action.samples ?? []) {point.inputMs = 0; point.presentedMs = 33.4;}
  assert.equal(evaluateSession(pointer).outcome, 'PASS');
  for (const action of pointer.actions) for (const point of action.samples ?? []) point.presentedMs = 33.401;
  assert.ok(evaluateSession(pointer).failures.includes('R07-pointer-p95-over-33.4ms'));
});

test('legacy inventory, exact window, meaningful paint, actual cadence and complete trace remain mandatory', () => {
  for (const mutate of [
    value => {value.actions.pop();}, value => {value.actions[1].id = value.actions[0].id;}, value => {value.endMs++;},
    value => {value.actions[0].presentedMs = null;}, value => {value.actions[0].meaningful = false;},
    value => {value.actions[0].samples.pop();}, value => {value.actions[0].samples[0].id = '';},
    value => {value.actions[0].pointerSchedule.clock = 'browser-performance';},
    value => {value.trace.kind = 'requestAnimationFrame';}, value => {value.trace.attributionComplete = false;},
    value => {value.activeSegments[0].slots.pop();}, value => {delete value.activeSegments[0].mainThreadIntervals;},
  ]) {
    const session = legacySession(); mutate(session);
    const observed = evaluateSession(session); assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.ok(observed.missing.length > 0);
  }
});

test('private-looking tokens, cloned tokens and serialized tokens cannot mint session bounds', () => {
  assert.deepEqual(Object.keys(sessionVerification).sort(), ['isSessionNativeEvidencePath', 'readVerifiedSessionBounds', 'verifySessionWindowServerEvidence']);
  const session = unavailableNative(), claimed = claimedProof(session);
  for (const token of [undefined, null, false, 1, 'verified', {}, claimed, {...claimed}, structuredClone(claimed), JSON.parse(JSON.stringify(claimed))]) {
    assert.equal(sessionVerification.readVerifiedSessionBounds(token, session), null);
    session.nativePresentationProof = token;
    const observed = evaluateSession(session);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []); unavailableStats(observed);
  }
});

test('native summary approval flags cannot supply exact paint or the missing full R07 evidence', () => {
  const session = unavailableNative(); session.nativePresentationProof = claimedProof(session);
  session.nativePresentation.qualification = true; session.nativePresentation.verified = true;
  session.nativePresentation.join = {...session.nativePresentationProof, status: 'PASS'};
  session.nativePresentation.lossObservations = {nativeDroppedFrames: 0, completeDisplaySlotSequence: true, streamError: null};
  session.nativePresentation.refreshHz = 60; session.nativePresentation.attributionComplete = true;
  session.nativePresentationVerified = true; session.qualification = true;
  const observed = evaluateSession(session);
  assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.equal(observed.qualification, false); assert.deepEqual(observed.failures, []);
  unavailableStats(observed); assert.equal(observed.frameWork.n, 0); assert.equal(observed.frameWork.max, null);
  assert.equal(observed.expectedActiveSlots, 0); assert.equal(observed.droppedShare60SecondSession, null);
  for (const reason of ['visible-60Hz-display', 'validated-presentation-and-app-attribution-trace', 'active-frame-segments']) assert.ok(observed.missing.includes(reason));
  assert.ok(session.actions.every(action => action.presentedMs === null && (action.samples ?? []).every(point => point.presentedMs === null)));
});

test('forged early or late upper bounds remain unavailable and never become exact latency failures', () => {
  for (const upperBoundMs of [undefined, null, -1, 0, 1, 33.4, 100, 101, 60001, Number.NaN, Infinity]) {
    const session = unavailableNative(); session.nativePresentationProof = claimedProof(session, upperBoundMs);
    session.upperBoundMs = upperBoundMs; session.nativePresentation.join.firstMeaningfulPaintUpperBoundMs = upperBoundMs;
    for (const action of session.actions) {
      action.upperBoundMs = upperBoundMs; action.firstMeaningfulPaintUpperBoundMs = upperBoundMs;
      for (const point of action.samples ?? []) point.firstMeaningfulPaintUpperBoundMs = upperBoundMs;
    }
    const observed = evaluateSession(session);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []); unavailableStats(observed);
    assert.equal(observed.targetMisses.acknowledgement, false); assert.equal(observed.targetMisses.pointer, false);
  }
});

test('browser input, runner dispatch and native Mach numbers never become a cross-clock latency', () => {
  for (const [browserOffset, runnerOffset, nativeMach] of [[0, 900000000, '1'], [900000000, 0, '18446744073709551614']]) {
    const session = unavailableNative(); session.startMs += browserOffset; session.endMs += browserOffset;
    for (const action of session.actions) {
      action.inputMs += browserOffset;
      for (const point of action.samples ?? []) point.inputMs += browserOffset;
      for (const dispatch of action.pointerSchedule?.samples ?? []) {
        dispatch.scheduledMs += runnerOffset; dispatch.dispatchStartedMs += runnerOffset; dispatch.dispatchCompletedMs += runnerOffset;
      }
    }
    session.nativePresentation.join = {status: 'OBSERVED', inputMach: nativeMach, presentedMach: nativeMach,
      presentedMs: 1, firstMeaningfulPaintUpperBoundMs: 1, clock: 'mach-absolute'};
    session.nativePresentationProof = claimedProof(session);
    const observed = evaluateSession(session);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []); unavailableStats(observed);
    assert.equal(observed.pointerCadence.observedSchedules, 20);
    assert.equal(observed.pointerCadence.dispatchLateness.max, 2); assert.equal(observed.pointerCadence.dispatchDurations.max, 1);
  }
});

test('existing exact latency and frame failures retain priority alongside forged native claims', () => {
  const session = legacySession(); session.nativePresentationProof = claimedProof(session);
  session.actions.at(-1).presentedMs = session.actions.at(-1).inputMs + 101;
  for (const action of session.actions) for (const point of action.samples ?? []) point.presentedMs = point.inputMs + 34;
  session.activeSegments[0].mainThreadIntervals = [{startMs: 0, endMs: 11}];
  for (let index = 0; index < 181; index++) session.activeSegments[0].slots[index].presented = false;
  const observed = evaluateSession(session);
  assert.equal(observed.outcome, 'FAIL');
  for (const reason of ['R04-acknowledgement-over-100ms', 'R07-pointer-p95-over-33.4ms', 'R07-main-thread-slot-over-10ms', 'R07-dropped-slots-over-five-percent']) assert.ok(observed.failures.includes(reason));
  assert.equal(observed.upperBounds.acknowledgements.n, 0); assert.equal(observed.upperBounds.pointer.n, 0);
  const cohort = evaluateInteraction({profile: 'P', cohortKey: session.cohortKey, sessions: [session], firstUse: [], hotEdits: []});
  assert.equal(cohort.outcome, 'FAIL'); assert.ok(cohort.failures.includes('R04-acknowledgement-over-100ms'));
});

test('observed session, action and pointer product failures override unavailable presentation', () => {
  for (const [mutate, reason] of [
    [value => {value.outcome = 'timeout';}, 'unexpected-session-outcome'],
    [value => {value.correctnessViolation = true;}, 'session-correctness'],
    [value => {value.capViolation = true;}, 'session-resource-cap'],
    [value => {value.actions[0].outcome = 'failed';}, 'unexpected-action-outcome'],
    [value => {value.actions[0].capViolation = true;}, 'action-correctness-or-cap-violation'],
    [value => {value.actions[0].samples[0].correctnessViolation = true;}, 'pointer:correctness-or-cap-violation'],
  ]) {
    const session = unavailableNative(); session.nativePresentationProof = claimedProof(session); mutate(session);
    const observed = evaluateSession(session);
    assert.equal(observed.outcome, 'FAIL'); assert.ok(observed.failures.includes(reason)); assert.ok(observed.missing.length > 0); unavailableStats(observed);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSession, evaluateInteraction} from '../../tooling/qualification/campaigns/metrics.mjs';
import * as textVerification from '../../tooling/qualification/campaigns/windowserver-text-session-verification.mjs';

// Source-only authored arithmetic fixtures. Positive private evidence and all
// classification values are exercised by the complete retained archive suite.
function session({presented = false} = {}) {
  const kinds = {'insert-delete': 40, preedit: 20, 'composition-end': 10, caret: 10, 'semantic-selection': 10, 'text-format': 10, presentation: 6};
  const actions = Object.entries(kinds).flatMap(([kind, count]) => Array.from({length: count}, (_, index) => ({id: `${kind}-${index}`, kind})));
  actions.forEach((action, index) => Object.assign(action, {inputMs: index * 500, presentedMs: presented ? index * 500 + 10 : null, meaningful: true, outcome: 'expected'}));
  return {id: 'text-warm-1', cache: 'warm', ordinal: 1, cohortKey: 'text-fixture', startMs: 0, endMs: 60000,
    captureStoppedMs: 60001, clock: 'runner-monotonic-dispatch-observations', visibility: 'visible', refreshHz: null, requestedRefreshHz: 60,
    actions, activeSegments: [], trace: {kind: 'browser-diagnostic-trace', sha256: 'a'.repeat(64), attributionComplete: false},
    compositionEvents: 'synthetic-app-handling', textPresentation: {sameConnectedNode: true, forwardRangePreserved: true, backwardRangePreserved: true,
      collapsedRangePreserved: true, latestDeferredOnlyAfterNativeEnd: true, cancelDropsDeferred: true, staleDeferredRequestRejected: true,
      deferredRequestRejection: {kind: 'deferred-presentation-rejection-2', reason: 'cancelled', requestSequence: 6, requestEpoch: 1,
        currentEpoch: 2, requestGeneration: 10, currentGeneration: 11, requestTextVersion: 3, currentTextVersion: 4,
        capturedState: {epoch: 1, generation: 10, textVersion: 3}, currentState: {epoch: 2, generation: 11, textVersion: 4},
        presentationUnchanged: true, requestNotSettled: true, nativeBoundary: 'cancel-native-end', guardMask: 7, versionMeaning: 'draft-text-version',
        extraMutationOrRequest: false, witnessedGuards: ['stale-session', 'stale-generation', 'stale-version'], unobservedGuards: [],
        acceptedVersion: {scope: 'accepted-document-layer-version', invariantUnchanged: true, rejectionObserved: false}}}};
}
function fakeProof(value, upperBoundMs = 1) {
  return {kind: 'verified-text-session-windowserver-bounds-1', qualification: true, verified: true, requiredActions: 106, requiredSubsteps: 247,
    requiredNativeClocks: 496, actions: value.actions.map(action => ({id: action.id, acknowledgement: {status: 'OBSERVED', upperBoundMs,
      exactMs: null, lowerMs: null, withinWindow: true, endpoint: 'WindowServer-presented-pixels', ceilingMs: 100, targetMs: 50},
      input: {scope: 'original-automated-action-dispatch', physicalInput: false, dispatches: []}, pointer: []}))};
}
function unavailable(observed) {
  assert.equal(observed.qualification, false); assert.deepEqual(observed.acknowledgements, {n: 0, p95: null, max: null});
  assert.deepEqual(observed.pointer, {n: 0, p95: null, max: null});
  assert.equal(observed.upperBounds.acknowledgements.required, 106); assert.equal(observed.upperBounds.acknowledgements.n, 0);
  assert.equal(observed.upperBounds.acknowledgements.max, null); assert.equal(observed.upperBounds.acknowledgements.p95, null);
  assert.equal(observed.upperBounds.acknowledgements.ceilingAssessment, 'unavailable'); assert.deepEqual(observed.upperBounds.acknowledgements.actions, []);
  assert.equal(observed.upperBounds.pointer.required, 0); assert.equal(observed.upperBounds.pointer.n, 0);
  assert.equal(observed.droppedShare60SecondSession, null);
}

test('exact text acknowledgement ceilings and observed draft guards retain their independent meanings', () => {
  const value = session({presented: true}); value.actions[0].presentedMs = 100;
  const observed = evaluateSession(value, 'IText');
  assert.equal(observed.acknowledgements.n, 106); assert.equal(observed.acknowledgements.max, 100);
  assert.equal(observed.upperBounds.acknowledgements.n, 0); assert.equal(observed.outcome, 'INCONCLUSIVE');
  assert.deepEqual(observed.textGuardCoverage.witnessedGuards, ['stale-session', 'stale-generation', 'stale-version']);
  assert.deepEqual(observed.textGuardCoverage.unobservedGuards, []);
  assert.equal(observed.textGuardCoverage.versionMeaning, 'draft-text-version');
  assert.deepEqual(observed.textGuardCoverage.acceptedVersion, {scope: 'accepted-document-layer-version', invariantUnchanged: true, rejectionObserved: false});
  value.actions[0].presentedMs = 100.001;
  assert.ok(evaluateSession(value, 'IText').failures.includes('R04-acknowledgement-over-100ms'));
});

test('only the exact Cancel retirement tuple supplies all three draft guards', () => {
  for (const mutate of [r => {r.guardMask = 3;}, r => {r.nativeBoundary = 'restore-input';}, r => {r.reason = 'stale-generation';},
    r => {r.currentEpoch = r.requestEpoch;}, r => {r.currentGeneration = r.requestGeneration;}, r => {r.currentTextVersion = r.requestTextVersion;},
    r => {r.capturedState.textVersion++;}, r => {r.currentState.generation++;}, r => {delete r.currentState;}, r => {r.requestTextVersion = true;},
    r => {r.versionMeaning = 'accepted-layer-version';}, r => {r.acceptedVersion.rejectionObserved = true;}, r => {r.witnessedGuards.pop();}]) {
    const value = session(); mutate(value.textPresentation.deferredRequestRejection);
    const observed = evaluateSession(value, 'IText');
    assert.equal(observed.outcome, 'INCONCLUSIVE');
    assert(observed.missing.includes('IText:actual-cancel-native-end-draft-guard-tuple'));
    assert.deepEqual(observed.textGuardCoverage.witnessedGuards, []);
    assert.deepEqual(observed.textGuardCoverage.unobservedGuards, ['stale-session', 'stale-generation', 'stale-version']);
  }
});

test('historical generation-only records retain their explicit unobserved guards', () => {
  const value = session();
  value.textPresentation.deferredRequestRejection = {kind: 'deferred-presentation-rejection-1', reason: 'stale-generation', requestSequence: 6,
    requestEpoch: 1, currentEpoch: 1, requestGeneration: 10, currentGeneration: 11, presentationUnchanged: true, requestNotSettled: true,
    nativeBoundary: 'existing-final-composition-cancel', extraMutationOrRequest: false, witnessedGuards: ['stale-generation'],
    unobservedGuards: ['stale-session', 'stale-version']};
  const observed = evaluateSession(value, 'IText');
  assert.equal(observed.outcome, 'INCONCLUSIVE');
  assert.deepEqual(observed.textGuardCoverage.witnessedGuards, ['stale-generation']);
  assert.deepEqual(observed.textGuardCoverage.unobservedGuards, ['stale-session', 'stale-version']);
  assert(observed.missing.includes('IText:actual-cancel-native-end-draft-guard-tuple'));
  assert(observed.missing.includes('IText:stale-session-rejection-unobserved'));
  assert(observed.missing.includes('IText:stale-version-rejection-unobserved'));
  assert.deepEqual(observed.textGuardCoverage.acceptedVersion, {scope: 'accepted-document-layer-version', invariantUnchanged: null, rejectionObserved: false});
});

test('text still requires all 106 named intents and the original visible sixty-second context', () => {
  for (const [mutate, reason] of [
    [v => v.actions.pop(), 'exact-unique-action-inventory'], [v => {v.actions[1].id = v.actions[0].id;}, 'exact-unique-action-inventory'],
    [v => {v.actions[0].kind = 'stroke';}, 'unknown-action-kind'], [v => {v.endMs = 59400;}, 'exact-60-second-session'],
    [v => {v.visibility = 'hidden';}, 'visible-60Hz-display'], [v => {v.actions[0].inputMs = 60001;}, 'action-in-session'],
  ]) {const value = session(); mutate(value); const result = evaluateSession(value, 'IText'); assert.equal(result.outcome, 'INCONCLUSIVE'); assert.ok(result.missing.includes(reason));}
});

test('copied or public-looking text and generic tokens cannot supply native action evidence', () => {
  assert.deepEqual(Object.keys(textVerification).sort(), ['isTextSessionNativeEvidencePath', 'readVerifiedTextSessionBounds', 'verifyTextSessionWindowServerEvidence']);
  const value = session(), fake = fakeProof(value);
  for (const proof of [undefined, null, false, 1, {}, fake, {...fake}, structuredClone(fake), JSON.parse(JSON.stringify(fake)),
    {kind: 'verified-session-windowserver-bounds-1', qualification: false}, {kind: 'windowserver-text-session-capture-4'}]) {
    assert.equal(textVerification.readVerifiedTextSessionBounds(proof, value), null);
    const result = evaluateSession({...value, nativePresentationProof: proof}, 'IText'); unavailable(result);
    assert.equal(result.outcome, 'INCONCLUSIVE'); assert.deepEqual(result.failures, []);
  }
});

test('unadmitted early or late bounds do not become exact text measurements or latency failures', () => {
  for (const upperBoundMs of [null, -1, 0, 50, 100, 100.001, 1000, Infinity]) {
    const value = session(); value.nativePresentationProof = fakeProof(value, upperBoundMs);
    for (const action of value.actions) Object.assign(action, {firstMeaningfulPaintUpperBoundMs: upperBoundMs, qualification: true});
    const result = evaluateSession(value, 'IText'); unavailable(result); assert.deepEqual(result.failures, []);
    assert.equal(result.outcome, 'INCONCLUSIVE');
  }
});

test('known product, cap, exact latency and text presentation failures survive every missing native obligation', () => {
  for (const [mutate, reason] of [
    [v => {v.correctnessViolation = true;}, 'session-correctness'], [v => {v.capViolation = true;}, 'session-resource-cap'],
    [v => {v.actions[0].outcome = 'failed';}, 'unexpected-action-outcome'],
    [v => {v.actions[0].presentedMs = 101;}, 'R04-acknowledgement-over-100ms'],
    [v => {v.textPresentation.sameConnectedNode = false;}, 'IText:sameConnectedNode'],
    [v => {v.textPresentation.deferredRequestRejection.presentationUnchanged = false;}, 'IText:stale-request-restored-state-or-added-action'],
    [v => {v.textPresentation.deferredRequestRejection.guardMask = 15;}, 'IText:accepted-version-changed-in-fixed-specimen'],
    [v => {v.textPresentation.deferredRequestRejection.acceptedVersion.invariantUnchanged = false;}, 'IText:accepted-version-changed-in-fixed-specimen'],
  ]) {const value = session(); value.nativePresentationProof = fakeProof(value); mutate(value);
    const result = evaluateSession(value, 'IText'); assert.equal(result.outcome, 'FAIL'); assert.ok(result.failures.includes(reason));}
});

test('independent input clocks and text evidence paths cannot authorize physical IME, R02 or full R07', () => {
  const value = session(); value.nativePresentationProof = fakeProof(value);
  value.nativeText = {qualification: true, nativeIME: true, inputMs: 1, timeOrigin: 1800000000000, presentedMach: '18446744073709551614'};
  const result = evaluateSession(value, 'IText'); unavailable(result); assert.equal(result.outcome, 'INCONCLUSIVE');
  assert.ok(result.missing.includes('validated-presentation-and-app-attribution-trace'));
  assert.ok(result.missing.includes('active-frame-segments')); assert.equal(result.upperBounds.limitations, null);
  const cohort = evaluateInteraction({profile: 'P', protocol: 'IText', cohortKey: value.cohortKey, sessions: [value]});
  assert.equal(cohort.outcome, 'INCONCLUSIVE'); assert.equal(cohort.sessions[0].upperBounds.acknowledgements.n, 0);
  const id = 'a'.repeat(48), allow = textVerification.isTextSessionNativeEvidencePath;
  for (const path of [`native-tis-${id}/capture/pixels.bin`, `native-tis-${id}/capture/frames.ndjson`, `native-tis-${id}/stdout.ndjson`,
    `oracle-tis-${id}/oracle-pixels.bin`, `oracle-tis-${id}/semantic-review.record`]) assert.equal(allow(path), true);
  for (const path of [`native-gis-${id}/capture/pixels.bin`, `native-tis-${id}/capture/frame-1.bgra`, `oracle-tis-${id}/unexpected.bin`,
    `oracle-tis-${id}/../semantic-review.record`, `native-tis-${id}/capture/pixels.bin/extra`]) assert.equal(allow(path), false);
});

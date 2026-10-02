import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateHotEdit, evaluateInteraction} from '../../tooling/qualification/campaigns/metrics.mjs';
import {readVerifiedHmrCeiling} from '../../tooling/qualification/campaigns/windowserver-hmr-verification.mjs';

// Authored protocol/evaluator cases only. These fixtures never mint a private
// native proof, run a collector, or establish a semantic wordmark oracle.
const trace = () => ({kind: 'browser-presentation-trace', sha256: 'a'.repeat(64), attributionComplete: true});
function legacy(cache = 'warm', ordinal = 1, elapsedMs = 100) {
  return {id: `${cache}-${ordinal}`, cache, ordinal, savedMs: 1000, presentedMs: 1000 + elapsedMs,
    documentPreserved: true, reload: false, outcome: 'expected', trace: trace()};
}
const warm = () => Array.from({length: 3}, (_, index) => legacy('warm', index + 1));
const q3 = () => ['cold', 'warm'].flatMap(cache => Array.from({length: 10}, (_, index) => legacy(cache, index + 1, cache === 'cold' ? 400 : 100)));
const claimedProof = () => ({kind: 'verified-hmr-windowserver-ceiling-1', qualification: true, verified: true,
  upperBoundMs: 1, ceilingMs: 500, endpoint: 'WindowServer-presented-pixels'});
function unavailableNative() {
  return warm().map(value => ({...value, presentedMs: null, trace: null,
    windowServerPresentation: {qualification: true, join: {status: 'observed', firstCorrectPaintUpperBoundMs: 1,
      ceilingAssessment: 'upper-bound-within-ceiling', collectorSourceAndInvocationAdmissionRequired: false, semanticReviewRequired: false}}}));
}

test('legacy exact warm latency and target boundaries retain their original semantics', () => {
  const values = warm(); values[1].presentedMs = values[1].savedMs + 200; values[2].presentedMs = values[2].savedMs + 500;
  const observed = evaluateHotEdit(values);
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.qualification, false);
  assert.deepEqual(observed.elapsed, {n: 3, p95: 500, max: 500, pooledDiagnostic: true});
  assert.deepEqual(observed.caches.warm, {n: 3, p95: 500, max: 500}); assert.equal(observed.targetMissed, true);
  assert.equal(observed.upperBounds.n, 0); assert.equal(observed.upperBounds.max, null);
  assert.equal(observed.upperBounds.exactLatency, false); assert.equal(observed.upperBounds.semantics, 'conservative-first-correct-paint-upper-bound');
  values[2].presentedMs++;
  assert.ok(evaluateHotEdit(values).failures.includes('D05-hot-update-over-500ms'));
  assert.equal(evaluateHotEdit(warm()).targetMissed, false);
});

test('legacy P and Q3 inventory and separate cache statistics are preserved', () => {
  const values = q3(), observed = evaluateHotEdit(values, {profile: 'Q3'});
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.caches.cold.max, 400); assert.equal(observed.caches.warm.max, 100);
  assert.equal(observed.caches.cold.n, 10); assert.equal(observed.caches.warm.n, 10);
  assert.ok(evaluateHotEdit(values.slice(1), {profile: 'Q3'}).missing.includes('ten-cold-and-ten-warm-hot-edits'));
  const duplicate = q3(); duplicate[0].ordinal = duplicate[1].ordinal;
  assert.ok(evaluateHotEdit(duplicate, {profile: 'Q3'}).missing.includes('ten-cold-and-ten-warm-hot-edits'));
  const ids = warm(); ids[1].id = ids[0].id;
  assert.ok(evaluateHotEdit(ids).missing.includes('unique-hot-edit-identities'));
  assert.ok(evaluateHotEdit(warm().slice(1)).missing.includes('three-warm-hot-edits'));
  assert.ok(evaluateHotEdit(values.slice(0, 3)).missing.includes('three-warm-hot-edits'));
});

test('legacy presentation evidence is still required when no native proof exists', () => {
  const noTrace = warm(); noTrace[0].trace.kind = 'requestAnimationFrame';
  assert.ok(evaluateHotEdit(noTrace).missing.includes('hot-update-presentation-trace'));
  const noPaint = warm(); noPaint[0].presentedMs = null;
  const missing = evaluateHotEdit(noPaint);
  assert.equal(missing.outcome, 'INCONCLUSIVE'); assert.ok(missing.missing.includes('hot-update-presented-completion'));
  assert.equal(missing.elapsed.n, 2); assert.equal(missing.upperBounds.n, 0);
});

test('unknown, copied and serialized private-looking proof tokens are unavailable', () => {
  const record = unavailableNative()[0], claimed = claimedProof();
  for (const token of [undefined, null, false, 1, 'verified', {}, claimed, {...claimed}, structuredClone(claimed), JSON.parse(JSON.stringify(claimed))]) {
    assert.equal(readVerifiedHmrCeiling(token, record), null);
  }
  for (const token of [false, 1, 'verified', {}, claimed, {...claimed}, structuredClone(claimed), JSON.parse(JSON.stringify(claimed))]) {
    const values = unavailableNative(); for (const value of values) value.nativePresentationProof = token;
    const observed = evaluateHotEdit(values);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
    assert.ok(observed.missing.includes('hot-update-native-presentation-proof-unavailable'));
    assert.ok(observed.missing.includes('hot-update-presented-completion')); assert.ok(observed.missing.includes('hot-update-presentation-trace'));
    assert.equal(observed.upperBounds.n, 0); assert.equal(observed.elapsed.n, 0);
    assert.ok(values.every(value => value.presentedMs === null));
  }
});

test('serialized bound values and approval flags cannot supply a missing private proof', () => {
  for (const upperBoundMs of [undefined, null, 0, 1, 500, 501, 900, -1, Number.NaN, Infinity]) {
    const values = unavailableNative();
    for (const value of values) {
      value.firstCorrectPaintUpperBoundMs = upperBoundMs; value.upperBoundMs = upperBoundMs;
      value.nativePresentationVerified = true; value.qualification = true;
      value.windowServerPresentation.join.firstCorrectPaintUpperBoundMs = upperBoundMs;
    }
    const observed = evaluateHotEdit(values);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
    assert.equal(observed.upperBounds.n, 0); assert.equal(observed.elapsed.n, 0);
    assert.equal(observed.targetMissed, false); assert.ok(observed.missing.includes('hot-update-presented-completion'));
  }
});

test('conflicting native claims stay inconclusive and cannot erase measured exact failures', () => {
  const values = warm(); values[0].nativePresentationProof = claimedProof();
  const conflict = evaluateHotEdit(values);
  assert.equal(conflict.outcome, 'INCONCLUSIVE');
  assert.ok(conflict.missing.includes('hot-update-conflicting-exact-and-upper-bound-presentation'));
  assert.ok(conflict.missing.includes('hot-update-native-presentation-proof-unavailable'));
  assert.equal(conflict.upperBounds.n, 0); assert.equal(conflict.elapsed.n, 3);
  values[0].presentedMs = values[0].savedMs + 501;
  const late = evaluateHotEdit(values);
  assert.equal(late.outcome, 'FAIL'); assert.ok(late.failures.includes('D05-hot-update-over-500ms')); assert.equal(late.targetMissed, true);
});

test('missing native evidence cannot hide product, resource or document-preservation failures', () => {
  for (const patch of [{outcome: 'timeout'}, {correctnessViolation: true}, {capViolation: true}, {documentPreserved: false}, {reload: true}]) {
    const values = unavailableNative(); Object.assign(values[0], patch, {nativePresentationProof: claimedProof()});
    const observed = evaluateHotEdit(values);
    assert.equal(observed.outcome, 'FAIL'); assert.ok(observed.failures.length > 0);
    assert.ok(!observed.failures.includes('D05-hot-update-over-500ms'));
  }
  const infra = unavailableNative(); infra[0].outcome = 'infra-invalid'; infra[0].infraEvidence = {reason: 'documented fixture interruption'};
  const observed = evaluateHotEdit(infra);
  assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.deepEqual(observed.failures, []);
  assert.ok(observed.missing.includes('hot-update:documented-infrastructure-invalidation'));
});

test('P interaction evaluation consumes the same hot-edit proof and failure semantics', () => {
  // Deliberately omit the separate session/first-use inventories: this case
  // checks propagation and does not claim a complete interaction campaign.
  const hotEdits = unavailableNative(); hotEdits[0].nativePresentationProof = claimedProof();
  const input = {profile: 'P', protocol: 'I', cohortKey: 'fixture-H-chromium-warm', sessions: [], firstUse: [], hotEdits};
  const missing = evaluateInteraction(input);
  assert.equal(missing.outcome, 'INCONCLUSIVE'); assert.deepEqual(missing.failures, []);
  assert.ok(missing.missing.includes('hot-update-native-presentation-proof-unavailable'));
  hotEdits[0] = {...legacy('warm', 1, 501), nativePresentationProof: claimedProof()};
  const failed = evaluateInteraction(input);
  assert.equal(failed.outcome, 'FAIL'); assert.ok(failed.failures.includes('D05-hot-update-over-500ms'));
});

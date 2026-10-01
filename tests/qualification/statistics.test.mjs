import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nearestRank, completionQuantile, cohortTemplate, evaluateCohort, evaluateRegression} from '../../tooling/qualification/statistics.mjs';

const sample = (ordinal, elapsedMs = ordinal, overrides = {}) => ({id: `sample-${ordinal}`, phase: 'scored', ordinal, cohortKey: 'sealed-W1-H-cold', outcome: 'expected', elapsedMs, ...overrides});
const expanded = (overrides = {}) => ({profile: 'E-O', cache: 'cold', cohortKey: 'sealed-W1-H-cold', budgetId: 'R12', targetMs: 100, ceilingMs: 250, attempts: Array.from({length: 30}, (_, i) => sample(i + 1)), ...overrides});
const regression = (kind, base, candidate) => evaluateRegression({kind, base, candidate, matched: true, complete: true});

test('nearest rank follows the specified discrete index and leaves samples unchanged', () => {
  const unsorted = [8, 1, 7, 2, 6, 3, 5, 4];
  assert.equal(nearestRank(unsorted, 0.5), 4);
  assert.equal(nearestRank(unsorted, 0.75), 6);
  assert.equal(nearestRank(unsorted, 0.95), 8);
  assert.deepEqual(unsorted, [8, 1, 7, 2, 6, 3, 5, 4]);
  for (const p of [0, -1, 1.01, NaN]) assert.throws(() => nearestRank([1], p));
  for (const values of [[], [NaN], [Infinity], [-1]]) assert.throws(() => nearestRank(values, 0.95));
});

test('PERF paper examples retain distinct success-only and all-attempt ranks', () => {
  const receipt = expanded();
  let result = evaluateCohort(receipt);
  assert.equal(result.outcome, 'PASS');
  assert.deepEqual(result.allAttemptP95, {status: 'exact', n: 30, rank: 29, lower: 29, upper: 29});
  assert.equal(result.successOnly.p95, 29);
  receipt.attempts[29] = sample(30, 300, {outcome: 'timeout'});
  result = evaluateCohort(receipt);
  assert.equal(result.outcome, 'FAIL');
  assert.deepEqual(result.allAttemptP95, {status: 'exact', n: 30, rank: 29, lower: 29, upper: 29});
  assert.equal(result.successOnly.n, 29); assert.equal(result.successOnly.p95, 28);
  assert.equal(result.successOnly.diagnosticOnly, true); assert.equal(result.counts.timeout, 1);
  receipt.attempts[28] = sample(29, 280, {outcome: 'timeout'});
  result = evaluateCohort(receipt);
  assert.equal(result.outcome, 'FAIL');
  assert.deepEqual(result.allAttemptP95, {status: 'lower-bound-only', n: 30, rank: 29, lower: 280, upper: null});
  assert.equal(result.successOnly.n, 28); assert.equal(result.successOnly.p95, 27);
  assert.equal(result.counts.timeout, 2);
  assert.match(JSON.stringify(result), /lower-bound-only/); assert.doesNotMatch(JSON.stringify(result), /Infinity/);
});

test('finite censored interval is not reported as an exact percentile', () => {
  // Three completions 10,20,30 and one observation censored at 5: rank three
  // lower endpoints=20, upper endpoints=30, so p75 is only bounded [20,30].
  assert.deepEqual(completionQuantile([sample(1, 10), sample(2, 20), sample(3, 30), sample(4, 5, {outcome: 'timeout'})], 0.75), {status: 'bounded', n: 4, rank: 3, lower: 20, upper: 30});
});

test('invalid outputs and documented infrastructure cannot contribute completion durations', () => {
  for (const outcome of ['correctness-failure', 'cap-violation', 'unexpected-error', 'abort', 'infra-invalid']) {
    const receipt = expanded(); receipt.attempts[29] = sample(30, 0, {outcome, infraEvidence: 'runner-power-loss-receipt'});
    const result = evaluateCohort(receipt);
    assert.equal(result.outcome, outcome === 'infra-invalid' ? 'INCONCLUSIVE' : 'FAIL');
    assert.equal(result.allAttemptP95.status, 'unavailable'); assert.equal(result.successOnly.n, 29);
    if (outcome === 'infra-invalid') assert.deepEqual(result.replacement, {scope: 'entire-matched-cache-workload-cohort', scoredPerRevision: 30, primesPerRevision: 0, retainOriginal: true});
  }
  const receipt = expanded(); receipt.attempts[29] = sample(30, 0, {correctnessViolation: true});
  assert.equal(evaluateCohort(receipt).allAttemptP95.status, 'unavailable');
});

test('failure priority survives missing samples and infrastructure invalidation', () => {
  const receipt = expanded(); receipt.attempts.pop();
  assert.equal(evaluateCohort(receipt).outcome, 'INCONCLUSIVE');
  receipt.attempts[0] = sample(1, 0, {outcome: 'infra-invalid', infraEvidence: 'external-runner-receipt'});
  receipt.attempts[1] = sample(2, 0, {capViolation: true});
  assert.equal(evaluateCohort(receipt).outcome, 'FAIL');
  receipt.attempts[1] = sample(2);
  receipt.attempts[0] = sample(1, 0, {outcome: 'infra-invalid'});
  assert.equal(evaluateCohort(receipt).outcome, 'FAIL', 'a slow candidate cannot be relabelled as infrastructure without evidence');
});

test('prescribed profile counts, primes and gate statistics cannot be reduced', () => {
  assert.deepEqual(cohortTemplate('P-O', 'warm'), {profile: 'P-O', cache: 'warm', scored: 3, primes: 1, gateStatistic: 'max', targetStatistic: 'max', regressionStatistic: 'max'});
  assert.equal(cohortTemplate('Q3-O', 'warm').primes, 3);
  assert.equal(cohortTemplate('Q3-O', 'cold').scored, 10);
  assert.equal(cohortTemplate('E-Q', 'warm').primes, 0);
  assert.equal(cohortTemplate('E-Q', 'warm').scored, 30);
  assert.equal(cohortTemplate('S', 'warm', 'p75').scored, 30);
  assert.equal(cohortTemplate('D', 'cold').targetStatistic, 'p50');
  assert.throws(() => cohortTemplate('custom', 'cold'));
  assert.throws(() => cohortTemplate('P-O', 'warm', 'p95'));
  assert.throws(() => cohortTemplate('E-O', 'hot'));
  const result = evaluateCohort(expanded({attempts: [sample(1)]}));
  assert.equal(result.outcome, 'INCONCLUSIVE'); assert.equal(result.counts.missing, 29);
  assert.equal(result.successOnly.diagnosticOnly, true); assert.equal(result.qualification, false);
});

test('warm primes precede scored starts and cannot substitute for missing observations', () => {
  const primes = [1, 2, 3].map(n => sample(n, 10000, {id: `prime-${n}`, phase: 'prime'}));
  const receipt = expanded({cache: 'warm', attempts: [...primes, ...expanded().attempts]});
  assert.equal(evaluateCohort(receipt).outcome, 'PASS', 'unscored priming durations do not enter the latency statistic');
  assert.equal(evaluateCohort({...receipt, attempts: receipt.attempts.slice(1)}).outcome, 'INCONCLUSIVE');
  assert.equal(evaluateCohort({...receipt, attempts: [...expanded().attempts, ...primes]}).outcome, 'INCONCLUSIVE');
  const failed = [...receipt.attempts]; failed[0] = {...failed[0], outcome: 'timeout'};
  assert.equal(evaluateCohort({...receipt, attempts: failed}).outcome, 'FAIL');
});

test('duplicate, mixed and extra starts never pass even when all timing values are fast', () => {
  for (const amend of [
    attempts => attempts[1] = {...attempts[1], id: attempts[0].id},
    attempts => attempts[1] = {...attempts[1], ordinal: 1},
    attempts => attempts[1] = {...attempts[1], cohortKey: 'other-browser-or-cache'},
    attempts => attempts.push(sample(31)),
  ]) {
    const receipt = expanded(); amend(receipt.attempts);
    assert.equal(evaluateCohort(receipt).outcome, 'INCONCLUSIVE');
  }
});

test('planned fault responses can pass when their expected response boundary succeeds', () => {
  const receipt = expanded({profile: 'P-Q', budgetId: 'R30', targetMs: 50, ceilingMs: 100, attempts: [sample(1, 10), sample(2, 20), sample(3, 30)]});
  const result = evaluateCohort(receipt);
  assert.equal(result.outcome, 'PASS'); assert.equal(result.counts.expectedOutcome, 3);
  assert.equal(result.ceiling.statistic, 'max'); assert.equal(result.ceiling.observed.lower, 30);
});

test('ceiling equality passes, target miss is tracked, and D target uses median while ceiling uses max', () => {
  const receipt = expanded({profile: 'D', targetMs: 20, ceilingMs: 100, attempts: [sample(1, 1), sample(2, 10), sample(3, 25), sample(4, 90), sample(5, 100)]});
  const result = evaluateCohort(receipt);
  assert.equal(result.outcome, 'PASS'); assert.equal(result.target.observedMs, 25); assert.equal(result.target.missed, true);
  assert.equal(result.ceiling.observed.lower, 100);
  receipt.attempts[4].elapsedMs = 100.001;
  const exceeded = evaluateCohort(receipt);
  assert.equal(exceeded.outcome, 'FAIL'); assert.equal(exceeded.successOnly.diagnosticOnly, false);
  assert.equal(exceeded.target.observedMs, 25); assert.equal(exceeded.target.missed, true);
  assert.throws(() => evaluateCohort({...receipt, targetMs: 101}));
});

test('timing thresholds require strict relative increase and inclusive 5ms floor together', () => {
  assert.equal(regression('timing', 100, 110).outcome, 'PASS');
  assert.equal(regression('timing', 100, 111).outcome, 'BLOCKED');
  assert.equal(regression('timing', 10, 14.999).outcome, 'PASS');
  assert.equal(regression('timing', 10, 15).outcome, 'BLOCKED');
  assert.equal(regression('timing', 0, 4).outcome, 'PASS');
  assert.equal(regression('timing', 0, 5).outcome, 'BLOCKED');
  assert.equal(regression('timing', 200, 195).outcome, 'PASS');
  assert.equal(evaluateRegression({kind: 'timing', base: 100, candidate: 110, complete: false, matched: true}).outcome, 'INCONCLUSIVE');
  assert.equal(evaluateRegression({kind: 'timing', base: 100, candidate: 110, complete: true, matched: false}).outcome, 'INCONCLUSIVE');
});

test('byte and peak regressions block above 5%; CLS and frame-share trigger review only above their absolute threshold', () => {
  for (const kind of ['bytes', 'peak-memory']) {
    assert.equal(regression(kind, 100, 105).outcome, 'PASS');
    assert.equal(regression(kind, 100, 105.01).outcome, 'BLOCKED');
    assert.equal(regression(kind, 0, 1).outcome, 'BLOCKED');
  }
  for (const kind of ['cls', 'dropped-frame-share']) {
    assert.equal(regression(kind, 0.03, 0.04).outcome, 'PASS');
    assert.equal(regression(kind, 0.03, 0.041).outcome, 'REVIEW');
    assert.equal(regression(kind, 0.03, 0.041).requiresMatchedDiagnostic, false);
  }
  assert.throws(() => regression('dropped-frame-share', 1, 2));
  assert.throws(() => regression('unknown', 0, 1));
});


test('known ceiling breaches outrank infra, while an incomplete subset cannot change the prescribed percentile rank', () => {
  const receipt = expanded({profile: 'P-Q', targetMs: 50, ceilingMs: 100, attempts: [sample(1, 101), sample(2, 10, {outcome: 'infra-invalid', infraEvidence: 'runner-loss'}), sample(3, 20)]});
  const result = evaluateCohort(receipt);
  assert.equal(result.outcome, 'FAIL'); assert.equal(result.allAttemptP95.status, 'unavailable');
  assert.equal(result.ceiling.prescribedRankLowerBoundMs, 101);
  const incomplete = evaluateCohort(expanded({attempts: [sample(1, 1000)]}));
  assert.equal(incomplete.successOnly.p95, 1000);
  assert.equal(incomplete.ceiling.prescribedRankLowerBoundMs, 0);
  assert.equal(incomplete.outcome, 'INCONCLUSIVE', 'one observation does not establish rank 29 of the required 30');
  const proven = evaluateCohort(expanded({attempts: Array.from({length: 29}, (_, i) => sample(i + 1, 1000))}));
  assert.equal(proven.outcome, 'FAIL'); assert.equal(proven.ceiling.prescribedRankLowerBoundMs, 1000);
});


test('serialized decimal equality does not become a binary floating-point regression', () => {
  assert.equal(regression('timing', 100.1, 110.11).outcome, 'PASS');
  assert.equal(regression('timing', 100.1, 110.110000001).outcome, 'BLOCKED');
  assert.equal(regression('bytes', 100.1, 105.105).outcome, 'PASS');
  assert.equal(regression('bytes', 100.1, 105.105000001).outcome, 'BLOCKED');
  assert.equal(regression('timing', 0.1, 5.1).outcome, 'BLOCKED');
  assert.equal(regression('timing', 0.1, 5.099999999).outcome, 'PASS');
  assert.equal(regression('bytes', 1e-7, 1.05e-7).outcome, 'PASS');
  assert.equal(regression('cls', 0.07, 0.08).outcome, 'PASS');
});

test('duplicate identities cannot manufacture the required percentile rank for a failure proof', () => {
  const receipt = expanded();
  receipt.attempts[28] = sample(29, 1000, {id: 'duplicated'});
  receipt.attempts[29] = sample(30, 1000, {id: 'duplicated'});
  const result = evaluateCohort(receipt);
  assert.equal(result.outcome, 'INCONCLUSIVE');
  assert.equal(result.ceiling.prescribedRankLowerBoundMs, 27);
});

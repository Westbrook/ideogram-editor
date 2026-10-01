/** Pure PERF-8 §2/§7 timing receipt evaluation. This evaluates one declared cache
 * cell, never claims that a campaign inventory, runner or product is qualified.
 * Durations are elapsed milliseconds. Raw attempts must be retained by callers.
 */
const outcomes = new Set(['expected', 'unexpected-error', 'timeout', 'abort', 'infra-invalid', 'correctness-failure', 'cap-violation']);
const profiles = Object.freeze({
  'P-S': [3, 1, 'max'], 'P-O': [3, 1, 'max'], 'P-Q': [3, 0, 'max'],
  'Q3-O': [10, 3, 'max'], 'Q3-Q': [10, 0, 'max'],
  'E-O': [30, 3, 'p95'], 'E-Q': [30, 0, 'p95'],
  S: [30, 1, 'p95'], D: [5, 0, 'max'],
});
const finite = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite nonnegative number`);
};
const identifier = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
};
const quantileProbability = p => {
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p > 1) throw new TypeError('Quantile probability must be in (0, 1]');
};

export function nearestRank(values, p) {
  quantileProbability(p);
  if (!Array.isArray(values) || !values.length) throw new TypeError('A quantile requires at least one observation');
  values.forEach(value => finite(value, 'Observation'));
  return [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
}

function validateAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object' || !outcomes.has(attempt.outcome)) throw new TypeError('Unknown attempt outcome');
  finite(attempt.elapsedMs, 'Attempt elapsedMs');
  for (const flag of ['correctnessViolation', 'capViolation']) {
    if (attempt[flag] !== undefined && typeof attempt[flag] !== 'boolean') throw new TypeError(`${flag} must be boolean`);
  }
}
const invalidOutput = attempt => attempt.correctnessViolation || attempt.capViolation || attempt.outcome === 'correctness-failure' || attempt.outcome === 'cap-violation';

/** Infinity is encoded as upper:null, explicitly labelled lower-bound-only, so
 * JSON serialization never turns an infinite bound into an apparent exact time.
 * Invalid output, errors and infrastructure aborts make completion unavailable.
 */
export function completionQuantile(attempts, p = 0.95) {
  quantileProbability(p);
  if (!Array.isArray(attempts)) throw new TypeError('Attempts must be an array');
  attempts.forEach(validateAttempt);
  const n = attempts.length, rank = n ? Math.ceil(p * n) : null;
  if (!n || attempts.some(attempt => invalidOutput(attempt) || !['expected', 'timeout'].includes(attempt.outcome))) {
    return {status: 'unavailable', n, rank, lower: null, upper: null};
  }
  const lower = nearestRank(attempts.map(attempt => attempt.elapsedMs), p);
  const orderedUpper = attempts.map(attempt => attempt.outcome === 'timeout' ? Infinity : attempt.elapsedMs).sort((a, b) => a - b);
  const upper = orderedUpper[rank - 1];
  return {status: upper === Infinity ? 'lower-bound-only' : lower === upper ? 'exact' : 'bounded', n, rank, lower, upper: upper === Infinity ? null : upper};
}

/** No caller-supplied sample-count override: these are the specified per-cache
 * templates only. I/M/CW and row-specific extensions need their own evaluators.
 */
export function cohortTemplate(profile, cache, statistic) {
  if (!Object.hasOwn(profiles, profile)) throw new TypeError(`Unsupported timing profile: ${profile}`);
  if (!['cold', 'warm'].includes(cache)) throw new TypeError('Cache must be cold or warm');
  const [scored, warmPrimes, defaultStatistic] = profiles[profile];
  const gateStatistic = statistic ?? defaultStatistic;
  if (gateStatistic !== defaultStatistic && !(profile === 'S' && gateStatistic === 'p75')) throw new TypeError('Statistic does not match the selected PERF profile');
  return {profile, cache, scored, primes: cache === 'warm' ? warmPrimes : 0, gateStatistic, targetStatistic: profile === 'D' ? 'p50' : gateStatistic, regressionStatistic: profile === 'D' ? 'p50' : gateStatistic};
}
const probability = statistic => ({max: 1, p50: 0.5, p75: 0.75, p95: 0.95})[statistic];
const summarize = attempts => {
  const values = attempts.filter(attempt => attempt.outcome === 'expected' && !invalidOutput(attempt)).map(attempt => attempt.elapsedMs);
  return {n: values.length, p50: values.length ? nearestRank(values, 0.5) : null, p75: values.length ? nearestRank(values, 0.75) : null, p95: values.length ? nearestRank(values, 0.95) : null, max: values.length ? nearestRank(values, 1) : null};
};

/** Each attempt is {id, phase:'scored'|'prime', ordinal:1..N, cohortKey,
 * outcome, elapsedMs, [correctnessViolation], [capViolation], [infraEvidence]}.
 * cohortKey must identify the sealed environment/workload/settings/cache cell.
 * Planned cancellation/fault cases use outcome:'expected' only after all of their
 * specified assertions pass; elapsedMs measures that declared response boundary.
 */
export function evaluateCohort({profile, cache, statistic, cohortKey, budgetId, targetMs, ceilingMs, attempts}) {
  const template = cohortTemplate(profile, cache, statistic);
  identifier(cohortKey, 'cohortKey'); identifier(budgetId, 'budgetId');
  finite(targetMs, 'targetMs'); finite(ceilingMs, 'ceilingMs');
  if (targetMs > ceilingMs) throw new TypeError('Target cannot exceed ceiling');
  if (!Array.isArray(attempts)) throw new TypeError('Attempts must be an array');
  const reasons = [], failures = [], ids = new Map(), seen = {scored: new Set(), prime: new Set()};
  for (const attempt of attempts) {
    validateAttempt(attempt); identifier(attempt.id, 'Attempt id'); identifier(attempt.cohortKey, 'Attempt cohortKey');
    if (!['scored', 'prime'].includes(attempt.phase) || !Number.isInteger(attempt.ordinal) || attempt.ordinal < 1) throw new TypeError('Attempt requires phase and positive integer ordinal');
    if (ids.has(attempt.id)) reasons.push('duplicate-attempt-id');
    ids.set(attempt.id, (ids.get(attempt.id) ?? 0) + 1);
    if (attempt.cohortKey !== cohortKey) reasons.push('mixed-cohort-identity');
    const expected = attempt.phase === 'scored' ? template.scored : template.primes;
    if (attempt.ordinal > expected) reasons.push('unexpected-attempt-ordinal');
    if (seen[attempt.phase].has(attempt.ordinal)) reasons.push('duplicate-attempt-ordinal');
    seen[attempt.phase].add(attempt.ordinal);
    if (invalidOutput(attempt)) failures.push('correctness-or-cap-violation');
    if (['unexpected-error', 'timeout', 'abort'].includes(attempt.outcome)) failures.push(`app-${attempt.outcome}`);
    if (attempt.outcome === 'infra-invalid') {
      if (typeof attempt.infraEvidence !== 'string' || !attempt.infraEvidence.trim()) failures.push('unsupported-infrastructure-invalidation');
      else reasons.push('documented-infrastructure-invalidation');
    }
  }
  const scored = attempts.filter(attempt => attempt.phase === 'scored'), primes = attempts.filter(attempt => attempt.phase === 'prime');
  const missingOrdinals = (phase, expected) => Array.from({length: expected}, (_, index) => index + 1).filter(ordinal => !seen[phase].has(ordinal));
  const missing = {scored: missingOrdinals('scored', template.scored), prime: missingOrdinals('prime', template.primes)};
  if (missing.scored.length || missing.prime.length) reasons.push('missing-required-starts');
  if (scored.length !== template.scored || primes.length !== template.primes) reasons.push('wrong-start-count');
  // Priming is unscored but must precede every measured warm operation.
  if (template.primes && attempts.some((attempt, index) => attempt.phase === 'prime' && attempts.slice(0, index).some(previous => previous.phase === 'scored'))) reasons.push('late-priming');
  const counts = {
    attempted: scored.length,
    expectedOutcome: scored.filter(attempt => attempt.outcome === 'expected' && !invalidOutput(attempt)).length,
    unexpectedError: scored.filter(attempt => ['unexpected-error', 'abort', 'correctness-failure', 'cap-violation'].includes(attempt.outcome) || (attempt.outcome === 'expected' && invalidOutput(attempt))).length,
    timeout: scored.filter(attempt => attempt.outcome === 'timeout').length,
    infraInvalid: scored.filter(attempt => attempt.outcome === 'infra-invalid').length,
    missing: missing.scored.length,
    primingAttempted: primes.length,
    primingMissing: missing.prime.length,
  };
  const allAttempt = completionQuantile(scored), gate = completionQuantile(scored, probability(template.gateStatistic));
  // Establish a breach against the prescribed rank, never a smaller successful
  // subset's rank. Missing/invalid observations have only the trivial >=0 bound.
  // This is a ceiling proof, not an eligible all-attempt completion quantile. A
  // known max breach still fails when a different attempt lost its runner.
  const prescribedLower = Array.from({length: template.scored}, (_, index) => {
    const matches = scored.filter(attempt => attempt.ordinal === index + 1 && attempt.cohortKey === cohortKey && ids.get(attempt.id) === 1);
    return matches.length ? Math.min(...matches.map(attempt => !invalidOutput(attempt) && ['expected', 'timeout'].includes(attempt.outcome) ? attempt.elapsedMs : 0)) : 0;
  });
  const ceilingLowerBoundMs = nearestRank(prescribedLower, probability(template.gateStatistic));
  if (ceilingLowerBoundMs > ceilingMs) failures.push('measured-ceiling-breach');
  const complete = !reasons.length && attempts.every(attempt => attempt.outcome === 'expected' && !invalidOutput(attempt));
  const successOnly = {...summarize(scored), diagnosticOnly: !complete};
  const targetValue = complete ? successOnly[template.targetStatistic] : null;
  return {
    kind: 'perf-timing-cell-evaluation-1', budgetId, cohortKey, template,
    outcome: failures.length ? 'FAIL' : reasons.length ? 'INCONCLUSIVE' : 'PASS',
    qualification: false, scope: 'One declared timing cache cell; runner, manifest and full campaign inventory require independent verification.',
    reasons: [...new Set([...failures, ...reasons])], counts, missing,
    elapsedMsSum: attempts.reduce((total, attempt) => total + attempt.elapsedMs, 0),
    successOnly, allAttemptP95: allAttempt,
    ceiling: {statistic: template.gateStatistic, limitMs: ceilingMs, observed: gate, prescribedRankLowerBoundMs: ceilingLowerBoundMs},
    target: {statistic: template.targetStatistic, limitMs: targetMs, observedMs: targetValue, missed: targetValue === null ? null : targetValue > targetMs},
    replacement: reasons.includes('documented-infrastructure-invalidation') ? {scope: 'entire-matched-cache-workload-cohort', scoredPerRevision: template.scored, primesPerRevision: template.primes, retainOriginal: true} : null,
  };
}

// Compare the finite numbers' serialized decimal values exactly. Floating
// subtraction can turn an exact +10% (100.1 -> 110.11) into a false >10% breach.
function decimalComparison(terms) {
  const parts = terms.map(([value, multiplier]) => {
    const [mantissa, power = '0'] = value.toString().split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return {integer: BigInt(whole + fraction) * BigInt(multiplier), exponent: Number(power) - fraction.length};
  });
  const exponent = Math.min(...parts.map(part => part.exponent));
  const total = parts.reduce((sum, part) => sum + part.integer * 10n ** BigInt(part.exponent - exponent), 0n);
  return total < 0n ? -1 : total > 0n ? 1 : 0;
}

/** Compares already-matched, complete statistics, not arbitrary sample arrays.
 * A trigger remains blocked pending the PERF §7 owner/diagnostic disposition.
 * Values for dropped-frame-share are fractions (0.01 = one percentage point).
 */
export function evaluateRegression({kind, base, candidate, matched, complete}) {
  if (matched !== true || complete !== true) return {outcome: 'INCONCLUSIVE', action: 'block', reason: 'complete-matched-statistics-required'};
  finite(base, 'base'); finite(candidate, 'candidate');
  if (!['timing', 'bytes', 'peak-memory', 'cls', 'dropped-frame-share'].includes(kind)) throw new TypeError('Unknown regression kind');
  if (kind === 'dropped-frame-share' && (base > 1 || candidate > 1)) throw new TypeError('Dropped-frame share must be in [0, 1]');
  const delta = candidate - base;
  const triggered = kind === 'timing' ? decimalComparison([[candidate, 10], [base, -11]]) > 0 && decimalComparison([[candidate, 1], [base, -1], [5, -1]]) >= 0
    : ['bytes', 'peak-memory'].includes(kind) ? decimalComparison([[candidate, 20], [base, -21]]) > 0
      : decimalComparison([[candidate, 1], [base, -1], [0.01, -1]]) > 0;
  const review = kind === 'cls' || kind === 'dropped-frame-share';
  return {outcome: triggered ? review ? 'REVIEW' : 'BLOCKED' : 'PASS', action: triggered ? review ? 'review' : 'block' : 'none', kind, base, candidate, delta, relativeIncrease: base > 0 ? delta / base : candidate === 0 ? 0 : null, triggered, requiresMatchedDiagnostic: triggered && !review};
}

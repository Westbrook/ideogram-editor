import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePhaseBudgets, evaluateRequiredMeasurements, executionGroups, summarize,
} from '../../tooling/qualification/campaigns/run.mjs';
import {readVerifiedNavigationBounds}
  from '../../tooling/qualification/campaigns/windowserver-navigation-verification.mjs';
import {windowServerNavigationSpecimen} from './support/windowserver-navigation-specimen.mjs';

// Synthetic retained bytes exercise the actual offline verifier and its private
// proof map. No injected authority, browser, native process or physical timing
// qualification is used by this evaluator test.
const shellRule = () => ({id: 'R04', phase: 'ui.native-shell', targetMs: 500, ceilingMs: 750});
const canvasRule = cache => ({budgetId: 'R05', name: cache === 'cold' ? 'R05UsableCanvasColdMs' : 'R05UsableCanvasWarmMs',
  unit: 'ms', cache, ceiling: cache === 'cold' ? 4000 : 2000});
const semanticRule = () => ({budgetId: 'R04', name: 'R04FalsePendingOrCompletionCount', unit: 'violations', ceiling: 0});
const specimen = (t, options = {}) => windowServerNavigationSpecimen(t, {
  ...options, cell: {phaseBudgets: [shellRule()], ...options.cell},
});
const proofMap = (attempt, proof) => proof ? new Map([[attempt.id, proof]]) : new Map();
function evaluate(f, proof, {cell = f.cell, attempt = f.attempt} = {}) {
  const proofs = proofMap(attempt, proof);
  return {
    shell: evaluatePhaseBudgets(cell, [attempt], new Map(), new Map(), new Map(), proofs)[0],
    measurements: evaluateRequiredMeasurements(cell, [attempt], proofs),
  };
}
const canvas = result => result.measurements.find(row => row.budgetId === 'R05');
const semantic = result => result.measurements.find(row => row.name === semanticRule().name);
function unavailable(result) {
  assert.equal(result.shell.status, 'INCONCLUSIVE');
  assert.equal(result.shell.maximumMs, null);
  for (const row of result.measurements) assert.equal(row.status, 'INCONCLUSIVE', row.name);
}

test('H1 exact shell and cache-specific canvas ceilings admit only null-valued upper bounds', async t => {
  for (const workload of ['W0', 'W1']) for (const cache of ['cold', 'warm']) await t.test(workload + '/' + cache, async t => {
    const f = await specimen(t, {workload, cache, shellUpperBoundMs: 750, canvasUpperBoundMs: canvasRule(cache).ceiling});
    const proof = await f.replay(); assert.ok(proof); assert.equal(proof.qualification, false);
    const result = evaluate(f, proof), measured = canvas(result);
    assert.equal(result.shell.status, 'PASS');
    assert.equal(result.shell.maximumMs, null);
    assert.equal(result.shell.maximumUpperBoundMs, 750);
    assert.equal(result.shell.samples[0].durationMs, null);
    assert.equal(result.shell.samples[0].upperBoundMs, 750);
    assert.equal(result.shell.samples[0].bound, 'upper');
    assert.equal(result.shell.ceilingAssessment, 'observed-upper-bounds-within-ceiling');
    assert.equal(measured.status, 'PASS'); assert.equal(measured.maximumUpperBoundMs, canvasRule(cache).ceiling);
    assert.equal(measured.observations[0].value, null); assert.equal(measured.observations[0].bound, 'upper');
    assert.equal(measured.observations[0].valid, true); assert.equal(measured.cohortOwned, false);
    assert.equal(semantic(result).status, 'PASS'); assert.equal(semantic(result).observations[0].value, 0);
    const published = f.attempt.result.measurements.find(row => row.name === measured.name);
    assert.equal(published.value, null); assert.equal(published.evidence.exactLatencyMs, null);
  });
});

test('an over-ceiling shell or canvas upper bound remains inconclusive rather than an exact failure', async t => {
  for (const cache of ['cold', 'warm']) for (const endpoint of ['shell', 'canvas']) await t.test(cache + '/' + endpoint, async t => {
    const upper = (endpoint === 'shell' ? 750 : canvasRule(cache).ceiling) + 0.001;
    const f = await specimen(t, {cache, ...(endpoint === 'shell' ? {canvasUpperBoundMs: 1000} : {}),
      [endpoint + 'UpperBoundMs']: upper}), proof = await f.replay(); assert.ok(proof);
    const result = evaluate(f, proof), measured = endpoint === 'shell' ? result.shell : canvas(result);
    assert.equal(measured.status, 'INCONCLUSIVE'); assert.equal(measured.maximumUpperBoundMs, upper);
    assert.equal(measured.ceilingAssessment, 'unavailable');
    assert.equal(endpoint === 'shell' ? measured.samples[0].durationMs : measured.observations[0].value, null);
    assert.equal(endpoint === 'shell' ? canvas(result).status : result.shell.status, 'PASS');
    assert.equal(semantic(result).status, 'PASS');
  });
});

test('pre-existing failed attempt and result outcomes survive an admitted upper bound', async t => {
  const f = await specimen(t), proof = await f.replay(); assert.ok(proof);
  for (const field of ['attempt', 'result']) {
    const attempt = structuredClone(f.attempt);
    if (field === 'attempt') attempt.status = 'FAIL'; else attempt.result.status = 'FAIL';
    const result = evaluate(f, proof, {attempt});
    assert.equal(result.shell.status, 'FAIL'); assert.equal(canvas(result).status, 'FAIL');
    assert.equal(semantic(result).status, 'FAIL');
  }
});

test('unverified exact timing scalars cannot manufacture a physical breach or override private upper bounds', async t => {
  const f = await specimen(t), proof = await f.replay(); assert.ok(proof);
  const attempt = structuredClone(f.attempt), rule = canvasRule('cold');
  attempt.result.phases.push({name: 'ui.native-shell', durationMs: 751});
  attempt.result.measurements = attempt.result.measurements.filter(row => row.name !== rule.name);
  attempt.result.measurements.push({name: rule.name, value: 4001, unit: 'ms', method: 'caller-declared exact timing', evidence: {fixture: true}});
  // The supplied phase/scalar has no exact native endpoint authority. Without
  // proof neither success nor breach is established; a real admitted upper
  // bound remains the only native timing authority when proof is available.
  unavailable(evaluate(f, null, {attempt}));
  const admitted = evaluate(f, proof, {attempt});
  assert.equal(admitted.shell.status, 'PASS'); assert.equal(admitted.shell.maximumMs, null);
  assert.equal(admitted.shell.maximumUpperBoundMs, 50);
  assert.equal(canvas(admitted).status, 'PASS'); assert.equal(canvas(admitted).observations[0].value, null);
  assert.equal(canvas(admitted).maximumUpperBoundMs, 250);
  delete attempt.result.nativeNavigation;
  unavailable(evaluate(f, null, {attempt}));
});

test('missing, copied and serialized native authority cannot promote caller-published bounds or zero counts', async t => {
  const f = await specimen(t), proof = await f.replay(); assert.ok(proof);
  for (const value of [null, {...proof}, structuredClone(proof), JSON.parse(JSON.stringify(proof)),
    {kind: proof.kind, qualification: true, semantic: {complete: true, falsePendingOrCompletionCount: 0}}]) {
    unavailable(evaluate(f, value));
  }
  const forged = structuredClone(f.attempt);
  forged.result.measurements.find(row => row.name === semanticRule().name).value = 0;
  forged.result.nativeNavigation.verified = true;
  unavailable(evaluate(f, proof, {attempt: forged}));
  assert.ok(evaluateRequiredMeasurements(f.cell, [], new Map()).every(row => row.status === 'INCONCLUSIVE'));
});

test('absent H1 native evidence cannot unlock generic shell, canvas or zero-count success', async t => {
  const f = await specimen(t), proof = await f.replay(); assert.ok(proof);
  const attempt = structuredClone(f.attempt); delete attempt.result.nativeNavigation;
  attempt.result.phases = [{name: 'ui.native-shell', durationMs: 1}];
  attempt.result.measurements = [
    {name: canvasRule('cold').name, value: 1, unit: 'ms', method: 'caller scalar', evidence: {fixture: true}},
    {name: semanticRule().name, value: 0, unit: 'violations', method: 'caller scalar', evidence: {fixture: true}},
  ];
  for (const supplied of [null, proof]) unavailable(evaluate(f, supplied, {attempt}));
});

test('native observation tampering cannot reuse a genuine proof at the evaluator boundary', async t => {
  const f = await specimen(t), proof = await f.replay(); assert.ok(proof);
  for (const change of [
    value => {value.joins.canvas.upperBoundMs = 0;},
    value => {value.joins.shell.upperBoundMs = 0;},
    value => {value.artifact.sha256 = '0'.repeat(64);},
    value => {value.navigationNonce = 'b'.repeat(48);},
    value => {value.semanticWitness.status.rows[0].atMs++;},
  ]) {
    const attempt = structuredClone(f.attempt); change(attempt.result.nativeNavigation);
    unavailable(evaluate(f, proof, {attempt}));
  }
});

test('private authority binds cell, job, ordinal, cache and scored-versus-prime identity', async t => {
  const f = await specimen(t), proof = await f.replay(); assert.ok(proof);
  for (const cell of [
    {...f.cell, jobId: 'H2'},
    {...f.cell, id: 'H1/chromium-W1-ready', workload: 'W1'},
    {...f.cell, parameters: {browser: 'firefox'}},
  ]) unavailable(evaluate(f, proof, {cell}));
  for (const change of [
    attempt => {attempt.ordinal++;},
    attempt => {attempt.cache = 'warm';},
    attempt => {attempt.prime = true;},
  ]) {
    const attempt = structuredClone(f.attempt); change(attempt);
    attempt.id = `${f.cell.id}/${attempt.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`;
    unavailable(evaluate(f, proof, {attempt}));
  }
  const prime = await specimen(t, {cache: 'warm', prime: true}), primeProof = await prime.replay(); assert.ok(primeProof);
  unavailable(evaluate(prime, primeProof));
  const scored = structuredClone(prime.attempt); scored.prime = false; scored.id = `${prime.cell.id}/warm/scored/1`;
  unavailable(evaluate(prime, primeProof, {attempt: scored}));
});

test('native timing does not satisfy retagged phase rules or cache/ceiling/cohort measurement contracts', async t => {
  const f = await specimen(t), proof = await f.replay(); assert.ok(proof);
  for (const patch of [{ceilingMs: 751}, {cohorts: {cold: {ceilingMs: 750}}}, {measurement: 'R05UsableCanvasColdMs'}]) {
    const cell = {...f.cell, phaseBudgets: [{...shellRule(), ...patch}]};
    assert.equal(evaluate(f, proof, {cell}).shell.status, 'INCONCLUSIVE');
  }
  for (const patch of [{ceiling: 4001}, {cohorts: {cold: {ceiling: 4000}}}, {cache: 'warm'}, {budgetId: 'R04'}, {unit: 'seconds'}]) {
    const cell = {...f.cell, requiredMeasurements: [{...canvasRule('cold'), ...patch}]};
    const [row] = evaluateRequiredMeasurements(cell, [f.attempt], proofMap(f.attempt, proof));
    assert.equal(row.status, 'INCONCLUSIVE');
  }
});

test('a native-derived zero count cannot fall through generic admission after its registry rule is retagged', async t => {
  const f = await specimen(t), proof = await f.replay(); assert.ok(proof);
  for (const patch of [{ceiling: 1}, {cohorts: {cold: {ceiling: 0}}}, {budgetId: 'R05'}, {unit: 'count'}]) {
    const cell = {...f.cell, requiredMeasurements: [{...semanticRule(), ...patch}]};
    const [row] = evaluateRequiredMeasurements(cell, [f.attempt], proofMap(f.attempt, proof));
    assert.equal(row.status, 'INCONCLUSIVE');
    assert.notEqual(row.observations[0].valid, true);
  }
});

test('missing original raw membership and source closure cannot issue an evaluator proof', async t => {
  const missing = await specimen(t); missing.forget(missing.folders.shell + '/capture/frame-1.bgra');
  const absent = await missing.replay(); assert.equal(absent, null); unavailable(evaluate(missing, absent));
  const changed = await specimen(t); await changed.write(changed.rawName, Buffer.from('changed native authority\n'));
  await assert.rejects(changed.replay); unavailable(evaluate(changed, null));
  const source = await specimen(t); source.context.sourceFiles = [];
  await assert.rejects(source.replay, /application source closure/); unavailable(evaluate(source, null));
  const controls = await specimen(t); controls.context.controlFiles.pop();
  await assert.rejects(controls.replay, /control source closure/); unavailable(evaluate(controls, null));
});

test('a complete nonzero semantic ledger preserves real failure and cannot be replaced with serialized zero', async t => {
  for (const count of [1, 2]) {
    const f = await specimen(t, {falsePendingOrCompletionCount: count}), proof = await f.replay(); assert.ok(proof);
    const bounds = readVerifiedNavigationBounds(proof, f.attempt.result.nativeNavigation, {cell: f.cell, sample: f.sample});
    assert.equal(bounds.semantic.complete, true); assert.equal(bounds.semantic.falsePendingOrCompletionCount, count);
    assert.equal(f.attempt.status, 'FAIL'); assert.equal(f.attempt.result.status, 'FAIL');
    const result = evaluate(f, proof);
    assert.equal(semantic(result).status, 'FAIL'); assert.equal(semantic(result).observations[0].value, count);
    assert.equal(result.shell.status, 'FAIL'); assert.equal(canvas(result).status, 'FAIL');
    const copied = JSON.parse(JSON.stringify(proof));
    const forged = structuredClone(f.attempt); forged.status = 'PASS'; forged.result.status = 'PASS';
    forged.result.measurements.find(row => row.name === semanticRule().name).value = 0;
    const lostAuthority = evaluate(f, copied, {attempt: forged});
    assert.equal(semantic(lostAuthority).status, 'INCONCLUSIVE'); assert.equal(semantic(lostAuthority).observations[0].value, null);
    // Even an altered published scalar cannot override the original private count.
    const retained = evaluate(f, proof, {attempt: forged});
    assert.equal(semantic(retained).status, 'FAIL'); assert.equal(semantic(retained).observations[0].value, count);
  }
});

test('an incomplete semantic ledger never infers zero from native pixels or a ready final state', async t => {
  const f = await specimen(t, {mutateSemantic: ({status}) => {status.dropped = 1;}}), proof = await f.replay(); assert.ok(proof);
  const result = evaluate(f, proof);
  assert.equal(result.shell.status, 'PASS'); assert.equal(canvas(result).status, 'PASS');
  assert.equal(semantic(result).status, 'INCONCLUSIVE'); assert.equal(semantic(result).observations[0].value, null);
  assert.equal(f.attempt.result.measurements.some(row => row.name === semanticRule().name), false);
});

async function summarizedSpecimens(t) {
  // This reduced inventory is a summary-join regression, not the full P plan.
  // Omitted independent Web Vitals remain explicitly inconclusive below.
  const plan = {campaign: 'P', features: 'core', jobs: [{id: 'H1', cells: ['W0', 'W1'].map(workload => ({
    id: `H1/chromium-${workload}-ready`, host: 'H', kind: 'navigation', handler: 'browser', operation: 'navigation.ready',
    workload, parameters: {browser: 'chromium'}, cold: 1, warm: 1, primes: 1, phaseBudgets: [shellRule()],
    requiredMeasurements: [canvasRule('cold'), canvasRule('warm'), semanticRule()],
  }))}]};
  const groups = [], nativeNavigations = new Map();
  for (const group of executionGroups(plan)) {
    assert.equal(group.cell.jobId, 'H1'); assert.equal(Object.hasOwn(plan.jobs[0].cells[0], 'jobId'), false);
    const attempts = [];
    for (const [index, sample] of group.attempts.entries()) {
      const f = await specimen(t, {cell: group.cell, workload: group.cell.workload, cache: group.cache, ...sample, serial: index + 1});
      assert.deepEqual(f.cell, group.cell);
      const proof = await f.replay(); assert.ok(proof); nativeNavigations.set(f.attempt.id, proof); attempts.push(f.attempt);
    }
    groups.push({...group, status: 'PASS', attempts});
  }
  return {plan, groups, nativeNavigations};
}

test('summarize uses the exact executionGroups H1 cell including jobId for both caches and prime identity', async t => {
  const {plan, groups, nativeNavigations} = await summarizedSpecimens(t);
  const summary = summarize(plan, groups, {hostEligible: true, sourceStable: true, nativeNavigations});
  assert.deepEqual(summary.integrityErrors, []); assert.deepEqual(summary.missing, []); assert.deepEqual(summary.unexpected, []);
  assert.equal(summary.counts.plannedScored, 4); assert.equal(summary.counts.attempted, 4);
  assert.equal(summary.counts.plannedPrimes, 2); assert.equal(summary.counts.primesAttempted, 2);
  for (const cell of summary.cells) {
    assert.equal(cell.phaseBudgets[0].status, 'PASS'); assert.equal(cell.phaseBudgets[0].maximumMs, null);
    assert.equal(cell.phaseBudgets[0].samples.length, 2);
    assert.deepEqual(cell.measurements.map(row => row.status), ['PASS', 'PASS', 'PASS']);
    assert.ok(cell.measurements.filter(row => row.budgetId === 'R05').every(row => row.observations.every(value => value.value === null)));
    assert.equal(cell.protocols.length, 4); assert.ok(cell.protocols.every(row => row.outcome === 'INCONCLUSIVE'));
  }
  assert.equal(summary.status, 'INCONCLUSIVE'); assert.equal(summary.qualification, false);
  const missing = new Map(nativeNavigations); missing.delete(groups[0].attempts[0].id);
  const unavailable = summarize(plan, groups, {hostEligible: true, sourceStable: true, nativeNavigations: missing});
  assert.equal(unavailable.cells[0].phaseBudgets[0].status, 'INCONCLUSIVE');
  assert.equal(unavailable.cells[0].measurements[0].status, 'INCONCLUSIVE');
});

test('summarize cannot borrow P/H1 proofs for a retagged owning job, campaign or malformed cohort', async t => {
  const {plan, groups, nativeNavigations} = await summarizedSpecimens(t), options = {hostEligible: true, sourceStable: true, nativeNavigations};
  const foreign = structuredClone(plan); foreign.jobs[0].id = 'H2';
  const foreignGroups = groups.map(group => ({...group, cell: {...group.cell, jobId: 'H2'}}));
  for (const summary of [summarize(foreign, foreignGroups, options), summarize({...plan, campaign: 'Q3'}, groups, options)]) {
    assert.equal(summary.qualification, false);
    assert.ok(summary.cells.every(cell => cell.phaseBudgets[0].status === 'INCONCLUSIVE'));
    assert.ok(summary.cells.every(cell => cell.measurements.every(row => row.status === 'INCONCLUSIVE')));
  }
  const retagged = structuredClone(groups); retagged[0].attempts[0].cache = 'warm';
  const summary = summarize(plan, retagged, options);
  assert.equal(summary.qualification, false); assert.ok(summary.integrityErrors.some(value => /cache\/order differs/.test(value)));
});

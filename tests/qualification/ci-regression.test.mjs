import test from 'node:test';
import assert from 'node:assert/strict';
import {collectCellRows, compareCellRows, comparePipelineSamples, evaluatePaired} from '../../tooling/qualification/ci/regression.mjs';
import {createCiPlan, digest} from '../../tooling/qualification/ci/plan.mjs';
import {makeCampaignPlan} from '../../tooling/qualification/campaigns/inventory.mjs';
import {digest as campaignDigest} from '../../tooling/qualification/campaigns/common.mjs';
import {executionGroups, summarize} from '../../tooling/qualification/campaigns/run.mjs';
import {observeD11Build} from '../../tooling/qualification/developer-campaigns/commands.mjs';

const cell = (extra = {}) => ({id: 'C9/operation', operation: 'fixture.operation', workload: 'W1', cold: 3, warm: 3, primes: 1,
  phaseBudgets: [{id: 'R12', phase: 'raster.decode', targetMs: 100, ceilingMs: 1000}], ...extra});
function attempts(values, {cache = 'cold', name = 'raster.decode', prime = cache === 'warm', measurements = {}, visits} = {}) {
  const samples = values.map((durationMs, i) => ({id: `fixture/${cache}/scored/${i + 1}`, cache, ordinal: i + 1, prime: false, status: 'PASS', elapsedMs: durationMs,
    result: {status: 'PASS', elapsedMs: durationMs, phases: [{name, durationMs}], measurements: structuredClone(measurements), ...(visits ? {visits: visits(i)} : {})}}));
  if (prime) samples.unshift({id: 'fixture/warm/prime/1', cache, ordinal: 1, prime: true, status: 'PASS', result: {status: 'PASS'}});
  return samples;
}
const rows = (values, options = {}, contract = cell(), profile = 'P') => collectCellRows(contract, options.cache ?? 'cold', attempts(values, options), profile).rows;
const compare = (a, b, options, contract, profile) => compareCellRows(rows(a, options, contract, profile), rows(b, options, contract, profile))[0];

test('P timing uses prescribed maximum, exact threshold arithmetic and raw starts', () => {
  assert.equal(compare([1, 50, 100], [1, 50, 110]).outcome, 'PASS');
  const breach = compare([1, 50, 100], [1, 50, 111]);
  assert.equal(breach.outcome, 'BLOCKED'); assert.equal(breach.statistic, 'max');
  assert.equal(breach.base, 100); assert.equal(breach.candidate, 111);
  assert.equal(breach.disposition.repeatability, 'not-established');
  assert.equal(breach.disposition.maximumDiagnosticCohorts, 1);
  assert.equal(compare([10, 10, 10], [14.999, 14.999, 14.999]).outcome, 'PASS');
  assert.equal(compare([10, 10, 10], [15, 15, 15]).outcome, 'BLOCKED');
});

test('full D uses median independently of maximum while P-D remains single-value', () => {
  const contract = cell({id: 'I1/command-groups', operation: 'developer.command-group', handler: 'developer', cold: 5, warm: 5, primes: 0, phaseBudgets: []});
  const row = compare([10, 11, 12, 100, 200], [11, 12, 18, 100, 200], {name: 'developer.command.cold-build'}, contract, 'Q3');
  assert.equal(row.statistic, 'p50'); assert.equal(row.base, 12); assert.equal(row.candidate, 18); assert.equal(row.outcome, 'BLOCKED');
  const one = {...contract, id: 'C2/production-build', cold: 1};
  assert.equal(compare([100], [111], {name: 'developer.command.cold-build'}, one, 'P').statistic, 'max');
});

test('declared developer phases and D11 cannot disappear from both sides of the comparison', () => {
  const contract = cell({id: 'I1/command-groups', operation: 'developer.command-group', handler: 'developer', cold: 5, warm: 5, primes: 0,
    phaseBudgets: [], parameters: {commands: ['clean-install', 'full-types', 'production-build']}});
  const actual = collectCellRows(contract, 'cold', attempts([1, 1, 1, 1, 1], {name: 'developer.command.cold-build'}), 'Q3');
  assert.match(actual.missing.join(' '), /install-cold/); assert.equal(actual.rows[0].complete, false);
  const bytes = collectCellRows(cell({budgets: ['D11']}), 'cold', attempts([1, 1, 1]), 'P');
  assert.match(bytes.missing.join(' '), /D11/);
});

test('D11 compares complete actual scoped byte rows and refuses conservative build substitution', () => {
  const contract = cell({operation: 'navigation.ready', phaseBudgets: [], budgets: ['D11']});
  const names = ['D11StartupJsGzipBytes', 'D11StartupEvaluatedJsBytes', 'D11StartupUiCssAndFontsGzipBytes'];
  function observed(bytes) {
    const raw = attempts([1, 1, 1]);
    for (const attempt of raw) {
      Object.assign(attempt, {auditGroupId: `byte-audit/fixture/cold/${attempt.ordinal}`, auditGroupKind: 'perf-byte-audit-group-1', auditTimingSamplesReusable: false});
      attempt.result.timingSamplesReusable = false;
      attempt.result.d11 = {kind: 'd11-byte-observation-1', scope: 'startup', cache: 'cold', featureIds: ['shell'], status: 'PASS', missing: [],
      instrumentation: {coverage: 'precise-v8', resourceTiming: true}, timingSamplesReusable: false,
      measurements: names.map(name => ({name, value: bytes, unit: 'bytes', method: 'chromium-precise-coverage+resource-timing+verified-build-v1', evidence: {artifactSha256: 'a'.repeat(64)}}))};
    }
    return raw;
  }
  const read = audit => collectCellRows(contract, 'cold', attempts([1, 1, 1]), 'P', {byteAuditAttempts: audit});
  const a = read(observed(100)), b = read(observed(106));
  assert.equal(a.rows.length, 3); assert.ok(compareCellRows(a.rows, b.rows).every(row => row.outcome === 'BLOCKED'));
  assert.equal(a.rows[0].raw[0].auditGroupId, 'byte-audit/fixture/cold/1');
  assert.ok(collectCellRows(contract, 'cold', observed(100), 'P').rows.every(row => !row.complete), 'Instrumented timing rows cannot replace the independent byte cohort');
  const absent = observed(100); absent[0].result.d11.measurements.pop();
  assert.ok(read(absent).rows.some(row => !row.complete));
  const partial = observed(100); partial[0].result.d11.missing.push('evaluated-module list');
  assert.ok(read(partial).rows.every(row => !row.complete));
  const cacheDrift = observed(100); cacheDrift[0].result.d11.cache = 'warm';
  assert.ok(read(cacheDrift).rows.every(row => !row.complete));
  assert.match(collectCellRows({...contract, handler: 'developer', operation: 'developer.command'}, 'cold', observed(100), 'P').missing.join(' '), /artifact-build/);
});

test('C D11 preserves per-feature byte regressions beneath an unchanged aggregate maximum and uses full D medians', () => {
  const contract = cell({id: 'I1/command-groups', operation: 'developer.command-group', handler: 'developer', cold: 5, warm: 5, primes: 0, phaseBudgets: [], budgets: ['D11']});
  const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  function read(smallFeatureBytes, mutate = () => {}) {
    const raw = attempts(Array(5).fill(1), {name: 'developer.command.cold-build'});
    raw.forEach((attempt, index) => {
      const files = [['startup.js', 'js', 100], ['text.wasm', 'wasm', 100], ['ui.css', 'css', 100], ['small.js', 'js', smallFeatureBytes[index]], ['large.js', 'js', 1000]]
        .map(([file, kind, gzipBytes]) => ({file, kind, gzipBytes, rawBytes: 4000, sha256: campaignDigest(`${file}/${gzipBytes}`)}));
      const contents = {kind: 'perf-d11-build-1', files, textWasmHash: files[1].sha256, roles: {complete: true, missing: [],
        startupFiles: ['startup.js'], textEngineFiles: ['text.wasm'], uiCssFontFiles: ['ui.css'], lazyFeatures: [{id: 'large', files: ['large.js']}, {id: 'small', files: ['small.js']}]}};
      const inventory = {...contents, sha256: campaignDigest(canonical(contents))}, serialized = JSON.stringify(inventory, null, 2) + '\n';
      attempt.result.d11 = observeD11Build(inventory, {artifact: {path: '/retained/build.json', sha256: campaignDigest(serialized), bytes: Buffer.byteLength(serialized)}});
      mutate(attempt.result.d11);
    });
    return collectCellRows(contract, 'cold', raw, 'Q3').rows;
  }
  const compared = compareCellRows(read([100, 100, 100, 1000, 1000]), read([106, 106, 106, 1000, 1000]));
  assert.equal(compared.find(row => row.name === 'D11BuildLazyFeatureGzipBytes').outcome, 'PASS');
  const small = compared.find(row => row.name === 'D11BuildLazyFeatureGzipBytes:small');
  assert.equal(small.statistic, 'p50'); assert.equal(small.base, 100); assert.equal(small.candidate, 106); assert.equal(small.outcome, 'BLOCKED');
  for (const mutate of [value => value.measurements[0].value++, value => value.inventory.files[0].gzipBytes++, value => value.artifact.sha256 = 'sha256:' + '0'.repeat(64), value => value.features[0].files = ['small.js']]) {
    assert.ok(read([100, 100, 100, 100, 100], mutate).filter(row => row.budgetId === 'D11').every(row => !row.complete), 'Claimed byte rows must reproduce from the canonical sealed inventory');
  }
});

test('warm primes are required, unscored and cannot follow measured work', () => {
  const contract = cell(), values = attempts([10, 11, 12], {cache: 'warm'});
  values[0].result.elapsedMs = 100_000;
  const good = collectCellRows(contract, 'warm', values, 'P');
  assert.equal(good.rows[0].value, 12);
  assert.equal(collectCellRows(contract, 'warm', values.slice(1), 'P').rows[0].complete, false);
  assert.equal(collectCellRows(contract, 'warm', [...values.slice(1), values[0]], 'P').rows[0].complete, false);
  const duplicate = structuredClone(values); duplicate[2].ordinal = 1;
  assert.equal(collectCellRows(contract, 'warm', duplicate, 'P').rows[0].complete, false);
});

test('missing, failed and censored starts never become a success-only percentile', () => {
  assert.equal(compare([10, 20, 30], [10, 20]).outcome, 'INCONCLUSIVE');
  for (const change of [value => value.status = 'FAIL', value => value.timedOut = true, value => value.censor = {lowerMs: 20, upperMs: null}, value => value.status = 'INCONCLUSIVE']) {
    const raw = attempts([10, 20, 30]); change(raw[1]);
    const actual = collectCellRows(cell(), 'cold', raw, 'P');
    assert.equal(actual.rows[0].complete, false); assert.equal(actual.rows[0].value, null);
  }
});

test('byte and peak-memory comparisons block above five percent, not at equality', () => {
  for (const [name, kind] of [['payloadBytes', 'bytes'], ['R17BackendRssBytes', 'peak-memory']]) {
    const contract = cell({phaseBudgets: [], requiredMeasurements: [{name, budgetId: 'R17', unit: 'bytes'}]});
    const measured = value => ({[name]: {value, unit: 'bytes', method: 'actual byte counter', evidence: {sample: 'raw'}}});
    const a = rows([1, 1, 1], {measurements: measured(100)}, contract);
    const b = rows([1, 1, 1], {measurements: measured(105)}, contract);
    assert.equal(compareCellRows(a, b)[0].outcome, 'PASS');
    const result = compareCellRows(a, rows([1, 1, 1], {measurements: measured(105.01)}, contract))[0];
    assert.equal(result.outcome, 'BLOCKED'); assert.equal(result.kind, kind);
  }
});

test('method, statistic, cell and cache drift block a numerical comparison', () => {
  const a = rows([10, 20, 30]);
  for (const mutate of [b => b[0].cache = 'warm', b => b[0].statistic = 'p50', b => b[0].cellId = 'other', b => b[0].methods = ['different instrument']]) {
    const b = structuredClone(a); mutate(b); assert.equal(compareCellRows(a, b)[0].outcome, 'INCONCLUSIVE');
  }
  assert.equal(compareCellRows(a, [...a, ...a])[0].outcome, 'INCONCLUSIVE');
  const mixed = structuredClone(a); mixed[0].methods = ['instrument-a', 'instrument-b'];
  assert.equal(compareCellRows(mixed, mixed)[0].outcome, 'INCONCLUSIVE');
});

test('CLS uses finalized canonical visit p75 and triggers explicit review', () => {
  const contract = cell({id: 'I3/W1-navigation', operation: 'navigation.ready', cold: 30, warm: 30, phaseBudgets: [], requiredMeasurements: [{name: 'R03Cls', budgetId: 'R03', unit: 'ratio'}]});
  const library = {name: 'web-vitals', version: '5.1.0', sha256: 'a'.repeat(64)};
  function read(value) {
    return rows(Array(30).fill(1), {visits: index => ({library, cohortKey: 'fixture', expectedVisits: [`visit-${index}`], reports: [
      {metric: 'CLS', visitId: `visit-${index}`, navigationId: `navigation-${index}`, metricId: `metric-${index}`, sequence: 0, finalized: true,
        observerSupported: true, lifecycleComplete: true, visibility: 'visible', interactions: 0, value, cohortKey: 'fixture', cache: 'cold', libraryVersion: library.version},
      {metric: 'CLS', visitId: `visit-${index}`, navigationId: `navigation-${index}`, metricId: `metric-${index}`, sequence: 1, finalized: false,
        observerSupported: true, lifecycleComplete: true, visibility: 'visible', interactions: 0, value: 999, cohortKey: 'fixture', cache: 'cold', libraryVersion: library.version},
    ]})}, contract, 'Q3');
  }
  const compared = compareCellRows(read(.03), read(.041))[0];
  assert.equal(compared.outcome, 'REVIEW'); assert.equal(compared.statistic, 'p75');
  assert.equal(compared.base, .03); assert.equal(compared.candidate, .041);
  assert.match(compared.disposition.required, /row-owner review/);
});

test('claimed frame/visit summary cannot substitute for missing raw presentation/lifecycle evidence', () => {
  for (const [name, unit] of [['R07DroppedSlotShare', 'ratio'], ['R03Cls', 'ratio']]) {
    const contract = cell({phaseBudgets: [], requiredMeasurements: [{name, budgetId: 'R07', unit}]});
    const claimed = {[name]: {value: 0, unit, method: 'claimed summary', evidence: true}};
    const actual = rows([1, 1, 1], {measurements: claimed}, contract);
    assert.equal(actual[0].complete, false); assert.equal(actual[0].value, null);
  }
});

function ciPlan() {
  const base = {commit: 'a'.repeat(40), tree: 'b'.repeat(40), digest: 'c'.repeat(64)}, candidate = {commit: 'd'.repeat(40), tree: 'e'.repeat(40), digest: 'f'.repeat(64)};
  const inputs = Object.fromEntries(['C', 'H'].map((side, i) => [side, {physicalHostId: 'sha256:' + String(i + 1).repeat(64),
    ...Object.fromEntries(['hostAttestation', 'fixtureManifest', 'configuration'].map((name, j) => [name, {path: `/sealed/${side}/${name}.json`, sha256: String(j + 3).repeat(64)}]))}]));
  return createCiPlan({base, candidate, features: 'adapters', cache: 'normal', outputRoot: 'artifacts/ci-regression-fixture', inputs,
    diff: {base: base.commit, candidate: candidate.commit, paths: [], pathsDigest: digest([]), rawSha256: '9'.repeat(64)}});
}
function child(plan, node, value) {
  const campaign = makeCampaignPlan({campaign: node.campaign, features: plan.spec.features, cache: node.cache, jobs: node.jobs ?? [node.job]});
  const groups = executionGroups(campaign).map(group => ({...group, status: 'PASS', process: {elapsedMs: value + 5}, attempts: group.attempts.map(attempt => ({...attempt, id: `${group.cell.id}/${group.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`, cache: group.cache,
    status: 'PASS', elapsedMs: value, result: {status: 'PASS', elapsedMs: value, phases: [{name: 'developer.command.install-warm', durationMs: value}]}}))}));
  const job = campaign.jobs[0], stageMs = value + 10, elapsedMs = groups.length * stageMs + 1;
  const receipt = {kind: 'perf-runtime-campaign-1', receiptId: node.id, plan: campaign, groups, byteAuditGroups: [],
    controllerTiming: {kind: 'perf-campaign-controller-timing-1', clock: 'controller-monotonic', startMs: 0, endMs: elapsedMs, elapsedMs, through: 'retained-evidence-hash-completion'},
    jobExecutions: [{kind: 'perf-campaign-job-execution-1', jobId: job.id, clock: 'controller-monotonic', startMs: 0, endMs: elapsedMs, elapsedMs,
      targetMs: job.targetMs, ceilingMs: job.ceilingMs, includes: ['fixture-selection','scored-processes','scored-cleanup','byte-audit-processes','byte-audit-cleanup'],
      stages: groups.map((group, index) => ({kind: 'scored', groupId: group.id, startMs: index * stageMs, endMs: (index + 1) * stageMs}))}],
    startedAt: new Date(node.role === 'base' ? 1000 : 3000).toISOString(), finishedAt: new Date(node.role === 'base' ? 2000 : 4000).toISOString(),
    identity: {before: {head: node.source.commit, digest: node.source.digest}, after: {head: node.source.commit, digest: node.source.digest}, buildsBefore: {digest: 'sha256:' + '5'.repeat(64)}, tools: {node: {version: '26.10.0', executable: {sha256: 'a'.repeat(64)}}}},
    host: {observed: {hostnameHash: node.physicalHostId, observedAt: new Date().toISOString()}},
    inputIdentities: Object.fromEntries(['hostAttestation', 'fixtureManifest'].map(key => [key, {sha256: 'sha256:' + node.inputs[key].sha256}]))};
  receipt.summary = summary(receipt); return receipt;
}
function summary(receipt) {
  return summarize(receipt.plan, receipt.groups, {hostEligible: true, sourceStable: true,
    byteAuditGroups: receipt.byteAuditGroups, jobExecutions: receipt.jobExecutions, controllerTiming: receipt.controllerTiming,
    executableIdentity: {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: campaignDigest(receipt.identity.tools)}});
}
function onePair(plan, baseValue = 100, candidateValue = 111) {
  return new Map(plan.nodes.filter(node => node.job === 'C1').map(node => [node.id, child(plan, node, node.role === 'base' ? baseValue : candidateValue)]));
}

test('paired CI preserves a detected row trigger but cannot pass a partial core/feature graph', () => {
  const plan = ciPlan(), actual = evaluatePaired(plan, onePair(plan));
  assert.equal(actual.freshBaseOutcome, 'INCONCLUSIVE'); assert.equal(actual.qualification, false); assert.equal(actual.triggers, 1);
  assert.equal(actual.latestApprovedMain.outcome, 'INCONCLUSIVE');
  assert.equal(actual.diagnosticPolicy.nonreproducedBreachNeedsOwnerDisposition, true);
  assert.equal(actual.pairs.find(pair => pair.baseNodeId.includes('-AC2')).problems.some(problem => problem.includes('Missing child')), true);
});

test('paired CI rejects source/host/tool/time/receipt reuse and unreproducible summaries', () => {
  const plan = ciPlan();
  for (const change of [
    value => value.identity.after.head = '0'.repeat(40), value => value.host.observed.hostnameHash = 'sha256:' + '0'.repeat(64),
    value => value.identity.tools.node.version = '99', value => value.startedAt = new Date(1000).toISOString(),
    value => value.receiptId = 'p-base-prepareC-C1', value => value.summary.cells[0].cohorts[0].successOnly.max = 0,
    value => value.groups = null,
  ]) {
    const children = onePair(plan, 100, 100); change(children.get('p-candidate-prepareC-C1'));
    const actual = evaluatePaired(plan, children); assert.equal(actual.freshBaseOutcome, 'INCONCLUSIVE');
    assert.ok(actual.pairs.find(pair => pair.baseNodeId === 'p-base-prepareC-C1').problems.length > 0);
  }
});

test('known absolute failure outranks missing paired graph, and invalid plan never passes', () => {
  const plan = ciPlan(), children = onePair(plan);
  children.get('p-candidate-prepareC-C1').summary.status = 'FAIL';
  assert.equal(evaluatePaired(plan, children).outcome, 'FAIL');
  assert.equal(evaluatePaired({...plan, nodes: []}, children).outcome, 'INCONCLUSIVE');
  assert.equal(evaluatePaired(plan, {}).freshBaseOutcome, 'INCONCLUSIVE');
});

test('canonical initial baseline has no relative pass or invented history; incomplete/mutated plans cannot opt out', () => {
  const comparison = ciPlan(), initial = createCiPlan({...comparison.spec, purpose: 'initial-baseline', base: null, diff: null});
  const evaluated = evaluatePaired(initial, {});
  assert.equal(evaluated.freshBaseOutcome, 'NOT_APPLICABLE'); assert.equal(evaluated.outcome, 'NOT_APPLICABLE');
  assert.equal(evaluated.qualification, false); assert.match(evaluated.scope, /independently verify every required/);
  assert.equal(evaluatePaired({...comparison, spec: {...comparison.spec, purpose: 'initial-baseline'}}, {}).outcome, 'INCONCLUSIVE');
  const missingJob = structuredClone(initial); missingJob.nodes.pop();
  assert.equal(evaluatePaired(missingJob, {}).outcome, 'INCONCLUSIVE');
  assert.equal(evaluatePaired({...initial, spec: {...initial.spec, base: comparison.spec.base}}, {}).outcome, 'INCONCLUSIVE');
});

function approvedFixture() {
  const original = ciPlan(), oldBase = {commit: '8'.repeat(40), tree: '7'.repeat(40), digest: '6'.repeat(64)};
  const baseline = createCiPlan({...original.spec, base: oldBase, candidate: original.spec.base, outputRoot: 'artifacts/ci-historical-approved',
    diff: {...original.spec.diff, base: oldBase.commit, candidate: original.spec.base.commit}});
  const trust = {packet: {path: '/protected/approved-main.json', sha256: '5'.repeat(64)}, source: original.spec.base};
  const plan = createCiPlan({...original.spec, approvedMain: trust});
  const history = onePair(baseline, 90, 100);
  for (const [id, receipt] of history) {
    receipt.receiptId = `historical/${id}`;
    receipt.startedAt = new Date(id.includes('-base-') ? 10 : 30).toISOString();
    receipt.finishedAt = new Date(id.includes('-base-') ? 20 : 40).toISOString();
  }
  return {plan, children: onePair(plan, 100, 111), approvedMain: {packetSha256: trust.packet.sha256, plan: baseline, childReceiptsByNodeId: history}};
}

test('approved-main uses the controller-pinned packet/source and exact raw matched cohort', () => {
  const {plan, children, approvedMain} = approvedFixture();
  assert.equal(plan.spec.approvedMain.packet.sha256, approvedMain.packetSha256);
  const result = evaluatePaired(plan, children, {approvedMain});
  assert.equal(result.latestApprovedMain.triggers, 1);
  assert.equal(result.latestApprovedMain.outcome, 'INCONCLUSIVE', 'The rest of the historical graph is deliberately missing');
  const pair = result.latestApprovedMain.pairs.find(value => value.candidateNodeId === 'p-candidate-prepareC-C1');
  assert.equal(pair.rows[0].base, 100); assert.equal(pair.rows[0].candidate, 111);
  assert.equal(pair.rows[0].outcome, 'BLOCKED'); assert.equal(pair.rows[0].baseRow.raw.length, 1);
  assert.equal(result.qualification, false);
});

test('approval booleans, wrong packet hashes/sources and historical failures cannot produce approval', () => {
  const {plan, children, approvedMain} = approvedFixture();
  for (const change of [
    value => value.packetSha256 = '0'.repeat(64),
    value => value.plan.spec.candidate = {...value.plan.spec.candidate, commit: '0'.repeat(40)},
    value => value.childReceiptsByNodeId = new Map(),
  ]) {
    const copy = structuredClone(approvedMain); change(copy); copy.approved = true; copy.outcome = 'PASS';
    assert.equal(evaluatePaired(plan, children, {approvedMain: copy}).latestApprovedMain.outcome, 'INCONCLUSIVE');
  }
  const unconfigured = ciPlan();
  assert.match(evaluatePaired(unconfigured, onePair(unconfigured), {approvedMain}).latestApprovedMain.missing[0], /Protected controller/);
  const failed = structuredClone(approvedMain), bad = failed.childReceiptsByNodeId.get('p-candidate-prepareC-C1');
  bad.groups[0].attempts[0].status = 'FAIL';
  bad.summary = summary(bad);
  assert.equal(evaluatePaired(plan, children, {approvedMain: failed}).latestApprovedMain.outcome, 'FAIL');
});

test('approved-main does not translate initial Q3 or I0 pipeline contexts into ordinary P cohorts', () => {
  const {plan, children, approvedMain} = approvedFixture();
  const initial = createCiPlan({...approvedMain.plan.spec, purpose: 'initial-baseline', base: null, diff: null});
  const result = evaluatePaired(plan, children, {approvedMain: {...approvedMain, plan: initial, childReceiptsByNodeId: {}}});
  assert.equal(result.latestApprovedMain.outcome, 'INCONCLUSIVE');
  assert.match(result.latestApprovedMain.pairs.find(pair => pair.candidateNodeId === 'p-candidate-prepareC-C1').problems.join(' '), /no P\/Q3 or pipeline-context substitution/);
});

function pipelineSamples(plan, coreCandidateMs = 1000) {
  const point = ms => ({kind: 'same-host-monotonic-1', boot: '1'.repeat(64), nanoseconds: String(BigInt(Math.round(ms * 1e6))), at: new Date(ms).toISOString()});
  return [['P-core', 'base', 0], ['P-core', 'candidate', 5000], ['P-adapters', 'base', 10000], ['P-adapters', 'candidate', 15000]].map(([scope, role, start]) => {
    const elapsedMs = scope === 'P-core' && role === 'candidate' ? coreCandidateMs : 1000;
    return {scope, role, cache: 'normal', status: 'PASS', elapsedMs, begin: point(start), end: point(start + elapsedMs), physicalHostId: plan.spec.inputs.C.physicalHostId, source: plan.spec[role]};
  });
}

test('D08 compares actual whole-pipeline clocks, with core and adapter scopes separate', () => {
  const plan = ciPlan();
  assert.equal(comparePipelineSamples(plan, pipelineSamples(plan, 1100)).outcome, 'PASS');
  const result = comparePipelineSamples(plan, pipelineSamples(plan, 1111));
  assert.equal(result.outcome, 'BLOCKED'); assert.equal(result.triggers, 1); assert.equal(result.rows.length, 2);
  const core = result.rows.find(row => row.scope === 'P-core');
  assert.equal(core.budgetId, 'D08'); assert.equal(core.base, 1000); assert.equal(core.candidate, 1111);
  assert.equal(core.disposition.repeatability, 'not-established');
  assert.equal(result.rows.find(row => row.scope === 'P-adapters').budgetId, 'P-A-envelope');
  assert.equal(result.qualification, false);
});

test('missing, duplicated, reordered, cross-host/cache or invented pipeline durations cannot pass', () => {
  const plan = ciPlan();
  for (const mutate of [
    samples => samples.pop(), samples => samples.push(samples[0]),
    samples => samples[1].elapsedMs += 1,
    samples => samples[1].end.boot = '2'.repeat(64),
    samples => samples[1].physicalHostId = plan.spec.inputs.H.physicalHostId,
    samples => samples[1].source = plan.spec.base,
    samples => samples[1].cache = 'cold',
    samples => Object.assign(samples[1], {begin: samples[0].begin, end: samples[0].end}),
  ]) {
    const samples = pipelineSamples(plan); mutate(samples);
    assert.equal(comparePipelineSamples(plan, samples).outcome, 'INCONCLUSIVE');
  }
  assert.equal(comparePipelineSamples(plan, []).outcome, 'INCONCLUSIVE');
});

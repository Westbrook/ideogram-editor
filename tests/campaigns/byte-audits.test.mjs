import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../tooling/qualification/campaigns/common.mjs';
import { makeCampaignPlan } from '../../tooling/qualification/campaigns/inventory.mjs';
import { executionGroups, summarize } from '../../tooling/qualification/campaigns/run.mjs';
import { declareByteAuditCohorts, byteAuditExecutionGroups, byteAuditConfiguration, runByteAuditSchedule, evaluateByteAuditCohorts, evaluateJobExecutions } from '../../tooling/qualification/campaigns/byte-audits.mjs';

const identity = { sourceDigest: 'a'.repeat(64), buildDigest: digest('build'), toolsDigest: digest('tools') };
const rule = { budgetId: 'D11', name: 'D11TextEngineRawBytes', source: 'separate-byte-audit', scope: 'text-engine', unit: 'bytes', target: 500, ceiling: 1000 };
const controllerOf = records => ({ kind: 'perf-campaign-controller-timing-1', clock: 'controller-monotonic', startMs: records[0].startMs, endMs: records.at(-1).endMs, elapsedMs: records.at(-1).endMs - records[0].startMs, through: 'retained-evidence-hash-completion' });
function fixturePlan({ ceilingMs = 1000, second = false } = {}) {
  const jobs = [{ id: 'H10', targetMs: 500, ceilingMs, cells: [{ id: 'H10/WXn-mixed-ready', operation: 'text.mixed-ready', workload: 'WXn', handler: 'browser', kind: 'operation', cold: 1, warm: 1, primes: 1, parameters: { browser: 'chromium' }, requiredMeasurements: [rule] }] }];
  if (second) jobs.push({ id: 'H11', targetMs: 500, ceilingMs, cells: [{ id: 'H11/action', operation: 'raster.decode', workload: 'W1', handler: 'browser', kind: 'operation', cold: 1, warm: 0, primes: 0, parameters: {}, requiredMeasurements: [] }] });
  return { campaign: 'P', jobs, extraAuditCohorts: declareByteAuditCohorts(jobs) };
}
function complete(group, pid) {
  const audit = group.kind === 'perf-byte-audit-group-1';
  return { ...structuredClone(group), status: 'PASS', process: { elapsedMs: 10 }, processIdentity: { pid, startedAt: '2026-09-30T12:00:00.000Z', node: 'v26.10.0' }, attempts: group.attempts.map(attempt => ({
    ...attempt, id: `${group.cell.id}/${group.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`, cache: group.cache, status: 'PASS', elapsedMs: 10,
    result: { status: 'PASS', elapsedMs: 10, phases: [], timingSamplesReusable: !audit, ...(audit ? { auditAction: { operation: 'text.active-layout', scope: 'explicit-unscored-text-engine-byte-initialization', originalOperation: group.cell.operation, outcome: 'PASS' }, d11: {
      kind: 'd11-byte-observation-1', scope: 'text-engine', cache: group.cache, status: 'PASS', instrumentation: 'precise-coverage-byte-audit', timingSamplesReusable: false,
      buildSha256: digest('compiled-build'), missing: [], failures: [], artifact: { path: `/audit/${pid}-${attempt.prime}-${attempt.ordinal}.json`, sha256: digest('audit'), byteLength: '100' },
      measurements: [{ name: rule.name, value: 128, unit: 'bytes', method: 'precise-coverage+verified-resource-bytes', evidence: { buildSha256: digest('compiled-build') } }],
    } } : {}) },
  })) };
}
function completed(plan) {
  const expected = executionGroups(plan), groups = expected.map((group, index) => complete(group, 100 + index));
  const audits = byteAuditExecutionGroups(plan, expected, identity).map((group, index) => complete(group, 200 + index));
  return { expected, groups, audits };
}

test('immutable production plans predeclare every D11 audit start and prime without changing scored counts', () => {
  const plan = makeCampaignPlan({ campaign: 'P', features: 'core', jobs: ['H1'] }), expected = executionGroups(plan);
  const audits = byteAuditExecutionGroups(plan, expected, identity);
  assert.equal(plan.extraAuditCohorts.length, 2);
  assert.equal(expected.length, 8); assert.equal(audits.length, 8);
  assert.equal(audits.reduce((n, group) => n + group.attempts.length, 0), 14);
  assert.equal(audits.reduce((n, group) => n + group.attempts.filter(attempt => attempt.prime).length, 0), 2);
  for (const [index, group] of audits.entries()) {
    assert.equal(group.id, 'byte-audit/' + expected[index].id);
    assert.deepEqual(group.cell, expected[index].cell); assert.deepEqual(group.attempts, expected[index].attempts);
    assert.equal(group.byteAudit.timingSamplesReusable, false);
  }
  const changed = structuredClone(plan); changed.extraAuditCohorts[0].warm = 1;
  assert.throws(() => byteAuditExecutionGroups(changed, expected, identity), /immutable cells/);
});

test('schedule uses fresh audit launches after every scored group in the same job, before the next job', async () => {
  const plan = fixturePlan({ second: true }), expected = executionGroups(plan), calls = [], retained = [];
  const configuration = { browser: { headless: false }, operator: 'fixed' }; let now = 0;
  const result = await runByteAuditSchedule(plan, expected, { output: '/evidence', configuration, executableIdentity: identity }, async (group, context) => {
    calls.push({ id: group.id, configuration: structuredClone(context.configuration), remaining: context.maxGroupElapsedMs }); now += 20;
    return complete(group, 100 + calls.length);
  }, { clock: () => now, retain: async (path, record) => retained.push({ path, record }) });
  assert.deepEqual(calls.map(call => call.id), [expected[0].id, expected[1].id, 'byte-audit/' + expected[0].id, 'byte-audit/' + expected[1].id, expected[2].id]);
  assert.deepEqual(calls[0].configuration, configuration); assert.deepEqual(calls[2].configuration, byteAuditConfiguration(configuration));
  assert.equal(configuration.browser.byteAudit, undefined);
  assert.equal(result.jobExecutions[0].elapsedMs, 80); assert.equal(result.jobExecutions[1].elapsedMs, 20);
  assert.equal(retained.length, 2); assert.equal(result.groups.length, 3); assert.equal(result.byteAuditGroups.length, 2);
  assert.equal(evaluateJobExecutions(plan, result.groups, result.byteAuditGroups, result.jobExecutions, controllerOf(result.jobExecutions)).status, 'PASS');
  const compressed = structuredClone(result.jobExecutions); compressed[0].stages[0].endMs = compressed[0].stages[0].startMs + 1;
  assert.equal(evaluateJobExecutions(plan, result.groups, result.byteAuditGroups, compressed, controllerOf(result.jobExecutions)).status, 'INCONCLUSIVE');
  assert.equal(evaluateJobExecutions(plan, result.groups, result.byteAuditGroups, result.jobExecutions).status, 'INCONCLUSIVE');
});

test('audit time consumes the original whole-job ceiling and remaining child timeout', async () => {
  const plan = fixturePlan({ ceilingMs: 70, second: true }), limits = []; let now = 0;
  const result = await runByteAuditSchedule(plan, executionGroups(plan), { output: '/evidence', executableIdentity: identity }, async (group, context) => {
    limits.push(context.maxGroupElapsedMs); now += 20; return complete(group, 100 + limits.length);
  }, { clock: () => now, retain: async () => {} });
  assert.deepEqual(limits, [70, 50, 30, 10]);
  assert.equal(result.jobExecutions.length, 1);
  assert.equal(result.jobExecutions[0].elapsedMs, 80);
  assert.equal(evaluateJobExecutions(plan, result.groups, result.byteAuditGroups, result.jobExecutions, controllerOf(result.jobExecutions)).status, 'FAIL');
});

test('prelude and retained-evidence hashing are charged to the unchanged job budget', async () => {
  const plan = fixturePlan({ ceilingMs: 100 }); let now = 30, pid = 100; const remaining = [];
  const result = await runByteAuditSchedule(plan, executionGroups(plan), { output: '/evidence', executableIdentity: identity, controllerStartMs: 0 }, async (group, context) => {
    remaining.push(context.maxGroupElapsedMs); now += 10; return complete(group, ++pid);
  }, { clock: () => now, retain: async () => {} });
  assert.deepEqual(remaining, [70, 60, 50, 40]);
  const envelope = { ...controllerOf(result.jobExecutions), startMs: 0, endMs: 110, elapsedMs: 110 };
  const resultBudget = evaluateJobExecutions(plan, result.groups, result.byteAuditGroups, result.jobExecutions, envelope);
  assert.equal(resultBudget.status, 'FAIL'); assert.equal(resultBudget.jobs[0].scheduledElapsedMs, 40); assert.equal(resultBudget.jobs[0].elapsedMs, 110);
});

test('later launch errors preserve every already sealed scored or audit outcome', async () => {
  const plan = fixturePlan(), state = { groups: [], byteAuditGroups: [], jobExecutions: [] }; let now = 0, launches = 0;
  await assert.rejects(runByteAuditSchedule(plan, executionGroups(plan), { output: '/evidence', executableIdentity: identity }, async group => {
    now += 10; if (++launches === 4) throw Error('lost child setup'); return complete(group, 100 + launches);
  }, { clock: () => now, retain: async () => {}, state }), /lost child setup/);
  assert.equal(state.groups.length, 2); assert.equal(state.byteAuditGroups.length, 1);
  assert.notEqual(evaluateByteAuditCohorts(plan, executionGroups(plan), state.byteAuditGroups, identity, state.groups).status, 'PASS');
});

test('failed audit stops the schedule and leaves required later audits visibly missing', async () => {
  const plan = fixturePlan({ second: true }); let now = 0, pid = 100;
  const result = await runByteAuditSchedule(plan, executionGroups(plan), { output: '/evidence', executableIdentity: identity }, async group => {
    now += 10; const value = complete(group, ++pid); if (group.kind === 'perf-byte-audit-group-1') value.status = 'FAIL'; return value;
  }, { clock: () => now, retain: async () => {} });
  assert.equal(result.groups.length, 2); assert.equal(result.byteAuditGroups.length, 1); assert.equal(result.jobExecutions.length, 1);
  const audit = evaluateByteAuditCohorts(plan, executionGroups(plan), result.byteAuditGroups, identity, result.groups);
  assert.equal(audit.status, 'FAIL'); assert(audit.missing.some(value => value.startsWith('Missing byte audit group')));
  await assert.rejects(runByteAuditSchedule(plan, executionGroups(plan), { configuration: { browser: { byteAudit: true } } }, async () => {}), /Scored work/);
});

test('complete audits link byte measurements to audit group identity and exclude primes from samples', () => {
  const plan = fixturePlan(), { expected, groups, audits } = completed(plan);
  const summary = evaluateByteAuditCohorts(plan, expected, audits, identity, groups);
  assert.equal(summary.status, 'PASS'); assert.equal(summary.plannedScored, 2); assert.equal(summary.plannedPrimes, 1);
  const metric = summary.cells[0].measurements[0];
  assert.equal(metric.observations.length, 2); assert.equal(metric.timingSamplesReusable, false);
  assert(metric.observations.every(row => row.auditGroupId.startsWith('byte-audit/') && row.byteAudit.toolsDigest === identity.toolsDigest));
});

test('substituted counts, cache, process, executable identity and instrumentation cannot pass an audit', () => {
  for (const change of [
    ({ audits }) => audits.pop(),
    ({ audits }) => audits[1].attempts.shift(),
    ({ audits }) => audits[1].attempts.reverse(),
    ({ audits }) => audits[0].cache = 'warm',
    ({ audits }) => audits[0].byteAudit.toolsDigest = digest('other-tools'),
    ({ audits, groups }) => audits[0].processIdentity = groups[0].processIdentity,
    ({ audits }) => audits[0].processIdentity = {},
    ({ audits }) => audits[0].attempts[0].result.timingSamplesReusable = true,
    ({ audits }) => audits[0].attempts[0].result.d11.timingSamplesReusable = true,
    ({ audits }) => audits[0].attempts[0].result.d11.scope = 'startup',
    ({ audits }) => audits[0].attempts[0].result.d11.cache = 'warm',
    ({ audits }) => audits[0].attempts[0].result.d11.measurements.push(structuredClone(audits[0].attempts[0].result.d11.measurements[0])),
    ({ audits }) => audits[0].attempts[0].result.d11.artifact.sha256 = 'not-a-hash',
  ]) {
    const plan = fixturePlan(), packet = completed(plan); change(packet);
    assert.notEqual(evaluateByteAuditCohorts(plan, packet.expected, packet.audits, identity, packet.groups).status, 'PASS');
  }
});

test('the known byte ceiling still fails even when another audit is absent', () => {
  const plan = fixturePlan(), { expected, groups, audits } = completed(plan);
  audits[0].attempts[0].result.d11.measurements[0].value = 1001; audits.pop();
  assert.equal(evaluateByteAuditCohorts(plan, expected, audits, identity, groups).status, 'FAIL');
});

test('summary consumes separate D11 audit measurements and rejects coverage in the timing cohort', async () => {
  const plan = fixturePlan(); let now = 0, pid = 100;
  const result = await runByteAuditSchedule(plan, executionGroups(plan), { output: '/evidence', executableIdentity: identity }, async group => {
    now += 10; return complete(group, ++pid);
  }, { clock: () => now, retain: async () => {} });
  const options = { hostEligible: true, sourceStable: true, byteAuditGroups: result.byteAuditGroups, jobExecutions: result.jobExecutions, controllerTiming: controllerOf(result.jobExecutions), executableIdentity: identity };
  const before = structuredClone(result.groups);
  assert.equal(summarize(plan, result.groups, options).status, 'PASS');
  assert.deepEqual(result.groups, before, 'summary never rewrites scored attempt results');
  assert.equal(summarize(plan, result.groups, { ...options, byteAuditGroups: [] }).status, 'INCONCLUSIVE');
  result.groups[0].attempts[0].result.timingSamplesReusable = false;
  assert.equal(summarize(plan, result.groups, options).status, 'INCONCLUSIVE');
});

test('combined lifecycle budgets execute the selected pair without invented individual ceilings', async () => {
  const combinedBudget = { jobs: ['I5a', 'I5b'], targetMs: 150, ceilingMs: 200 };
  const jobs = combinedBudget.jobs.map(id => ({ id, combinedBudget, cells: [{ id: id + '/lifecycle', handler: 'browser', operation: 'lifecycle.editor', workload: 'W1', kind: 'lifecycle', cold: 1, warm: 0, primes: 0 }] }));
  const plan = { jobs, extraAuditCohorts: [] }; let now = 0, pid = 100;
  const execute = async (selected, duration) => runByteAuditSchedule(selected, executionGroups(selected), { output: '/evidence' }, async group => {
    now += duration; return complete(group, ++pid);
  }, { clock: () => now, retain: async () => {} });
  const pair = await execute(plan, 80);
  assert.equal(pair.groups.length, 2); assert(pair.jobExecutions.every(record => record.ceilingMs === null));
  const evaluated = evaluateJobExecutions(plan, pair.groups, [], pair.jobExecutions, controllerOf(pair.jobExecutions));
  assert.equal(evaluated.status, 'PASS'); assert.equal(evaluated.combined[0].elapsedMs, 160);
  now = 10000;
  const selected = { jobs: [jobs[0]], extraAuditCohorts: [] }, partial = await execute(selected, 80);
  const missing = evaluateJobExecutions(selected, partial.groups, [], partial.jobExecutions, controllerOf(partial.jobExecutions));
  assert.equal(partial.groups.length, 1); assert.equal(missing.status, 'INCONCLUSIVE'); assert.deepEqual(missing.combined[0].missingJobs, ['I5b']);
  const interruptedPair = evaluateJobExecutions(plan, partial.groups, [], partial.jobExecutions, controllerOf(partial.jobExecutions));
  assert.equal(interruptedPair.status, 'INCONCLUSIVE'); assert.equal(interruptedPair.combined[0].elapsedMs, 80, 'absent sibling does not turn a monotonic timestamp into elapsed time');
  const slow = await execute(plan, 110);
  assert.equal(evaluateJobExecutions(plan, slow.groups, [], slow.jobExecutions, controllerOf(slow.jobExecutions)).status, 'FAIL');
});

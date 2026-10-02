import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, exclusiveJSON, monotonic } from './common.mjs';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const safe = value => value.replace(/[^A-Za-z0-9_.-]/g, '_');
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const processKey = value => Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) && value.node === 'v26.10.0' ? `${value.pid}:${value.startedAt}` : null;
const rulesFor = cell => (cell.requiredMeasurements ?? []).filter(rule => rule.budgetId === 'D11');
const budgetFor = job => number(job.ceilingMs) ? { jobs: [job.id], targetMs: job.targetMs, ceilingMs: job.ceilingMs } : job.combinedBudget;
const attemptId = (group, attempt) => `${group.cell.id}/${group.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`;
export const byteAuditConfiguration = configuration => ({ ...configuration, browser: { ...(configuration?.browser ?? {}), byteAudit: true } });
export const jobExecutionPath = id => `job-execution-${safe(id)}.json`;

/** Supplemental byte proofs are actions in the immutable audit schedule. They
 * do not add a navigation, replace a startup receipt, or become timing samples. */
export function byteAuditFeatureActions(cell) {
  if (cell.operation !== 'navigation.ready' || !['W0', 'W1'].includes(cell.workload)) return [];
  return ['export.startup-absence', ...(cell.workload === 'W1' ? ['export.first-use-ready'] : [])];
}

/** Structural join for the live summary. Retained qualification additionally
 * replays both original raw envelopes and recomputes these supplemental proofs. */
export function evaluateByteAuditFeatureActions(cell, attempt, cache) {
  const actions = byteAuditFeatureActions(cell), result = attempt.result, startup = result?.d11;
  const absence = result?.featureAbsence, positive = result?.featureAudits, missing = [];
  if (!actions.length) return { status: absence || positive?.length ? 'INCONCLUSIVE' : 'PASS', missing: absence || positive?.length ? ['Undeclared feature byte audit action'] : [] };
  const clean = value => value?.status === 'PASS' && value.timingSamplesReusable === false && value.supplemental === true &&
    Array.isArray(value.missing) && !value.missing.length && Array.isArray(value.failures) && !value.failures.length;
  const artifact = value => typeof value?.path === 'string' && sha(value.sha256) && /^[1-9][0-9]*$/.test(String(value.byteLength));
  const absenceValid = clean(absence) && absence.kind === 'd11-feature-absence-1' && absence.observationId === attempt.id &&
    absence.workload === cell.workload && absence.cache === cache && absence.buildSha256 === startup?.buildSha256 &&
    sha(absence.fixtureSeal) && typeof absence.collectorSessionId === 'string' && absence.collectorSessionId.length > 0 &&
    Number.isSafeInteger(absence.documentNavigationId) && absence.documentNavigationId > 0 &&
    absence.boundary?.complete === true && typeof absence.boundary.featureId === 'string' && artifact(startup?.artifact);
  if (!absenceValid) missing.push('Required startup Export absence proof does not match this exact attempt');
  const count = cell.workload === 'W1' ? 1 : 0;
  if (!Array.isArray(positive) || positive.length !== count) missing.push('Separate Export first-use count differs from the declared workload');
  if (count === 1 && Array.isArray(positive) && positive.length === 1) {
    const first = positive[0], proof = first?.evidence, audit = first?.d11;
    const valid = first?.status === 'PASS' && first.timingSamplesReusable === false &&
      isDeepStrictEqual(first.action, { kind: 'export', completed: true }) && clean(proof) &&
      proof.kind === 'd11-feature-first-use-1' && proof.observationId === attempt.id + '/export-first-use' &&
      proof.baselineObservationId === attempt.id && proof.baselineArtifactSha256 === startup?.artifact?.sha256 && proof.baselineStatus === 'PASS' &&
      ['buildSha256', 'fixtureSeal', 'workload', 'cache', 'collectorSessionId', 'documentNavigationId'].every(key => proof[key] === absence?.[key]) &&
      isDeepStrictEqual(proof.boundary, absence?.boundary) &&
      isDeepStrictEqual(first.baselineReference, { artifactPath: startup?.artifact?.path, artifactSha256: startup?.artifact?.sha256 }) &&
      audit?.kind === 'd11-byte-observation-1' && audit.scope === 'lazy-feature' && audit.cache === cache && audit.status === 'PASS' &&
      audit.instrumentation === 'precise-coverage-byte-audit' && audit.timingSamplesReusable === false && audit.buildSha256 === startup?.buildSha256 &&
      isDeepStrictEqual(audit.featureIds, [absence?.boundary?.featureId]) && artifact(audit.artifact) &&
      audit.artifact.path !== startup?.artifact?.path && audit.artifact.sha256 !== startup?.artifact?.sha256 &&
      Array.isArray(audit.missing) && !audit.missing.length && Array.isArray(audit.failures) && !audit.failures.length;
    if (!valid) missing.push('Separate Export first-use proof does not bind its exact retained startup, session, navigation and artifact');
  }
  const failed = absence?.status === 'FAIL' || absence?.failures?.length || Array.isArray(positive) && positive.some(value => value?.status === 'FAIL' || value?.evidence?.status === 'FAIL' || value?.evidence?.failures?.length || value?.d11?.status === 'FAIL');
  return { status: failed ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS', missing };
}

/** The audit overhead is declared before any timed work. Cold starts remain
 * independent processes; the complete warm prime/sample cohort owns one new
 * process. No audit measurement can be reused as a latency observation. */
export function declareByteAuditCohorts(jobs) {
  return jobs.flatMap(job => job.cells.filter(cell => cell.handler === 'browser' && rulesFor(cell).length).map(cell => ({
    id: `D11/${cell.id}`, jobId: job.id, cellId: cell.id,
    cellDigest: digest({ ...cell, jobId: job.id }), workload: cell.workload,
    browser: cell.parameters?.browser ?? 'chromium', cold: cell.cold, warm: cell.warm, primes: cell.primes,
    scope: cell.operation === 'navigation.ready' ? 'startup' : 'text-engine',
    actionsPerStart: [cell.operation, ...(cell.operation === 'text.mixed-ready' ? ['text.active-layout'] : []), ...byteAuditFeatureActions(cell)],
    startupBootstrapPerProcess: cell.operation === 'text.mixed-ready' ? 1 : 0,
    measurementNames: rulesFor(cell).map(rule => rule.name),
    runAfter: 'all-scored-groups-in-same-job', separateProcesses: true, timingSamplesReusable: false,
    countsIncludedInJobBudget: true,
  })));
}

export function byteAuditExecutionGroups(plan, scoredGroups, identity) {
  const declarations = declareByteAuditCohorts(plan.jobs);
  if (!isDeepStrictEqual(plan.extraAuditCohorts ?? [], declarations)) throw Error('Declared byte audit cohorts differ from immutable cells');
  return scoredGroups.filter(group => declarations.some(cohort => cohort.cellId === group.cell.id)).map(group => {
    const cohort = declarations.find(value => value.cellId === group.cell.id);
    return { ...group, id: `byte-audit/${group.id}`, kind: 'perf-byte-audit-group-1',
      byteAudit: { cohortId: cohort.id, cellId: cohort.cellId, cellDigest: cohort.cellDigest,
        actionsPerStart: [...cohort.actionsPerStart],
        sourceDigest: identity?.sourceDigest ?? null, buildDigest: identity?.buildDigest ?? null,
        toolsDigest: identity?.toolsDigest ?? null, timingSamplesReusable: false } };
  });
}

/** A job owns one controller clock interval including both scored work and its
 * declared audit overhead. The next job cannot start while an audit is alive. */
export async function runByteAuditSchedule(plan, scoredGroups, context, launch, { clock = monotonic, retain = exclusiveJSON, state = { groups: [], byteAuditGroups: [], jobExecutions: [] } } = {}) {
  if (context.configuration?.browser?.byteAudit === true) throw Error('Scored work cannot enable byte-audit instrumentation');
  const expectedAudits = byteAuditExecutionGroups(plan, scoredGroups, context.executableIdentity);
  const { groups, byteAuditGroups, jobExecutions } = state, budgetStarts = new Map();
  if (![groups, byteAuditGroups, jobExecutions].every(value => Array.isArray(value) && !value.length)) throw Error('Campaign execution state must start empty');
  for (const job of plan.jobs) {
    const startMs = clock(), stages = [], budget = budgetFor(job), budgetKey = budget?.jobs?.join('/');
    if (!budget || !number(budget.ceilingMs) || !Array.isArray(budget.jobs) || !budget.jobs.includes(job.id)) throw Error('Job requires its declared individual or combined budget');
    if (!budgetStarts.has(budgetKey)) budgetStarts.set(budgetKey, jobExecutions.at(-1)?.endMs ?? (number(context.controllerStartMs) ? context.controllerStartMs : startMs));
    const budgetStart = budgetStarts.get(budgetKey);
    let stopped = false;
    for (const [kind, scheduled] of [['scored', scoredGroups], ['byte-audit', expectedAudits]]) {
      for (const group of scheduled.filter(value => value.cell.jobId === job.id)) {
        const remainingMs = budget.ceilingMs - (clock() - budgetStart);
        if (remainingMs <= 0) { stopped = true; break; }
        const stageStart = clock();
        const result = await launch(group, { ...context, maxGroupElapsedMs: remainingMs,
          configuration: kind === 'byte-audit' ? byteAuditConfiguration(context.configuration ?? {}) : context.configuration });
        stages.push({ kind, groupId: group.id, startMs: stageStart, endMs: clock() });
        (kind === 'byte-audit' ? byteAuditGroups : groups).push(result);
        if (result.status !== 'PASS' || clock() - budgetStart > budget.ceilingMs) { stopped = true; break; }
      }
      if (stopped) break;
    }
    const endMs = clock();
    const record = { kind: 'perf-campaign-job-execution-1', jobId: job.id, clock: 'controller-monotonic',
      startMs, endMs, elapsedMs: endMs - startMs, targetMs: job.targetMs ?? null, ceilingMs: job.ceilingMs ?? null,
      combinedBudget: job.combinedBudget ?? null,
      includes: ['fixture-selection', 'scored-processes', 'scored-cleanup', 'byte-audit-processes', 'byte-audit-cleanup',
        ...(job.cells.some(cell => rulesFor(cell).length && byteAuditFeatureActions(cell).length) ? ['declared-feature-boundary-actions', 'declared-feature-boundary-cleanup'] : [])], stages };
    jobExecutions.push(record);
    await retain(join(context.output, jobExecutionPath(job.id)), record);
    if (stopped) break;
  }
  return { groups, byteAuditGroups, jobExecutions };
}

export function evaluateByteAuditCohorts(plan, expectedScoredGroups, groups = [], identity = null, scoredGroups = []) {
  const errors = [], missing = [], expected = byteAuditExecutionGroups(plan, expectedScoredGroups, identity), seen = new Set(), observations = [];
  const declared = declareByteAuditCohorts(plan.jobs);
  const scopedProcesses = new Set(scoredGroups.map(group => processKey(group.processIdentity)).filter(Boolean));
  let failed = false;
  for (const [index, group] of groups.entries()) {
    if (group.status === 'FAIL' || group.timedOut || group.attempts?.some(attempt => attempt.status === 'FAIL')) failed = true;
    const scheduled = expected[index];
    if (!scheduled || seen.has(group.id) || group.id !== scheduled.id || group.kind !== scheduled.kind || !isDeepStrictEqual(group.byteAudit, scheduled.byteAudit) || !isDeepStrictEqual(group.cell, scheduled.cell) || group.cache !== scheduled.cache || !Array.isArray(group.attempts)) {
      errors.push(`Byte audit contract/order differs: ${group.id}`); continue;
    }
    seen.add(group.id);
    const process = processKey(group.processIdentity);
    if (!process || scopedProcesses.has(process)) errors.push(`Byte audit process is not independently identified: ${group.id}`);
    if (process) scopedProcesses.add(process);
    if (group.status === 'FAIL' || group.timedOut) failed = true;
    if (group.status !== 'PASS') missing.push(`Incomplete byte audit group: ${group.id}`);
    if (group.attempts.length !== scheduled.attempts.length) missing.push(`Byte audit attempt count differs: ${group.id}`);
    const cohort = declared.find(value => value.cellId === group.cell.id);
    for (const [ordinal, attempt] of group.attempts.entries()) {
      const planned = scheduled.attempts[ordinal];
      if (!planned || attempt.ordinal !== planned.ordinal || attempt.prime !== planned.prime || attempt.cache !== group.cache || attempt.id !== attemptId(group, planned)) { errors.push(`Byte audit attempt identity differs: ${group.id}`); continue; }
      if (attempt.status === 'FAIL') failed = true;
      const audit = attempt.result?.d11;
      const action = attempt.result?.auditAction;
      const featureActions = evaluateByteAuditFeatureActions(group.cell, attempt, group.cache);
      if (featureActions.status === 'FAIL') failed = true;
      missing.push(...featureActions.missing.map(reason => `${group.id}/${attempt.id}: ${reason}`));
      const actionComplete = group.cell.operation !== 'text.mixed-ready' || action?.operation === 'text.active-layout' && action.scope === 'explicit-unscored-text-engine-byte-initialization' && action.originalOperation === group.cell.operation && ['PASS', 'INCONCLUSIVE'].includes(String(action.outcome).toUpperCase());
      const valid = actionComplete && featureActions.status === 'PASS' && attempt.status === 'PASS' && attempt.result?.timingSamplesReusable === false && audit?.kind === 'd11-byte-observation-1' && audit.timingSamplesReusable === false && audit.instrumentation === 'precise-coverage-byte-audit' && audit.scope === cohort.scope && audit.cache === group.cache && audit.status === 'PASS' && Array.isArray(audit.measurements) && isDeepStrictEqual(audit.measurements.map(value => value.name).sort(), [...cohort.measurementNames].sort()) && Array.isArray(audit.missing) && !audit.missing.length && Array.isArray(audit.failures) && !audit.failures.length && sha(audit.buildSha256) && typeof audit.artifact?.path === 'string' && sha(audit.artifact.sha256) && Number.isSafeInteger(Number(audit.artifact.byteLength)) && Number(audit.artifact.byteLength) > 0;
      if (audit?.status === 'FAIL' || audit?.failures?.length) failed = true;
      if (!valid) missing.push(`Byte audit evidence incomplete: ${group.id}/${attempt.id}`);
      if (!attempt.prime) observations.push({ group, attempt, audit, valid });
    }
  }
  for (const group of expected) if (!seen.has(group.id)) missing.push(`Missing byte audit group: ${group.id}`);
  if (declared.length && (!/^(?:sha256:)?[a-f0-9]{64}$/.test(identity?.sourceDigest ?? '') || !['buildDigest', 'toolsDigest'].every(key => /^sha256:[a-f0-9]{64}$/.test(identity?.[key] ?? '')))) errors.push('Byte audits lack immutable executable identity');
  const cells = declared.map(cohort => {
    const cell = plan.jobs.flatMap(job => job.cells).find(value => value.id === cohort.cellId);
    const measurements = rulesFor(cell).map(rule => {
      const selected = observations.filter(row => row.group.cell.id === cell.id && (!rule.cache || rule.cache === row.group.cache));
      const values = selected.map(({ group, attempt, audit, valid }) => {
        const matches = audit?.measurements?.filter(value => value.name === rule.name) ?? [], metric = matches[0], limit = rule.cohorts?.[group.cache] ?? rule;
        const complete = valid && matches.length === 1 && number(metric?.value) && metric.unit === rule.unit && typeof metric.method === 'string' && metric.method.length > 0 && metric.evidence !== undefined;
        return { auditGroupId: group.id, attempt: attempt.id, cache: group.cache, value: metric?.value ?? null,
          target: limit.target, ceiling: limit.ceiling, valid: complete, byteAudit: group.byteAudit,
          ...(complete ? { method: metric.method, evidence: metric.evidence, artifact: audit.artifact } : { reason: 'Separately measured D11 audit evidence unavailable' }) };
      });
      const expectedCount = expected.filter(group => group.cell.id === cell.id && (!rule.cache || rule.cache === group.cache)).reduce((n, group) => n + group.attempts.filter(attempt => !attempt.prime).length, 0);
      return { ...rule, source: 'separate-byte-audit-cohort', timingSamplesReusable: false, observations: values,
        status: values.some(value => value.valid && value.value > value.ceiling) ? 'FAIL' : values.length === expectedCount && expectedCount > 0 && values.every(value => value.valid) ? 'PASS' : 'INCONCLUSIVE' };
    });
    return { cellId: cell.id, measurements };
  });
  if (cells.some(cell => cell.measurements.some(value => value.status === 'FAIL'))) failed = true;
  return { status: failed ? 'FAIL' : !errors.length && !missing.length && cells.every(cell => cell.measurements.every(value => value.status === 'PASS')) ? 'PASS' : 'INCONCLUSIVE',
    plannedGroups: expected.length, executedGroups: groups.length, plannedScored: expected.reduce((n, group) => n + group.attempts.filter(attempt => !attempt.prime).length, 0),
    plannedPrimes: expected.reduce((n, group) => n + group.attempts.filter(attempt => attempt.prime).length, 0), errors, missing, cells };
}

export function evaluateJobExecutions(plan, scoredGroups, auditGroups, records = [], controllerTiming = null) {
  const jobs = plan.jobs.filter(job => number(job.ceilingMs) || job.combinedBudget), errors = [];
  const outerValid = controllerTiming?.kind === 'perf-campaign-controller-timing-1' && controllerTiming.clock === 'controller-monotonic' && controllerTiming.through === 'retained-evidence-hash-completion' && number(controllerTiming.startMs) && number(controllerTiming.endMs) && controllerTiming.endMs >= controllerTiming.startMs && controllerTiming.elapsedMs === controllerTiming.endMs - controllerTiming.startMs && records.every(record => number(record.startMs) && number(record.endMs) && record.startMs >= controllerTiming.startMs && record.endMs <= controllerTiming.endMs);
  if (jobs.length && !outerValid) errors.push('Whole-job budgets require the outer controller interval through evidence hashing');
  const results = jobs.map(job => {
    const matches = records.filter(record => record.jobId === job.id), record = matches[0];
    const work = [...scoredGroups.filter(group => group.cell.jobId === job.id).map(group => ({ kind: 'scored', group })), ...auditGroups.filter(group => group.cell.jobId === job.id).map(group => ({ kind: 'byte-audit', group }))];
    const expectedStages = work.map(({ kind, group }) => ({ kind, groupId: group.id }));
    const valid = matches.length === 1 && record.kind === 'perf-campaign-job-execution-1' && record.clock === 'controller-monotonic' && number(record.startMs) && number(record.endMs) && record.endMs >= record.startMs && record.elapsedMs === record.endMs - record.startMs && record.targetMs === (job.targetMs ?? null) && record.ceilingMs === (job.ceilingMs ?? null) && isDeepStrictEqual(record.combinedBudget ?? null, job.combinedBudget ?? null) && Array.isArray(record.stages) && isDeepStrictEqual(record.stages.map(({ kind, groupId }) => ({ kind, groupId })), expectedStages) && record.stages.every((stage, index) => {
      const processMs = work[index].group.process?.elapsedMs ?? (work[index].group.fixturePreparationFailed ? 0 : null);
      return number(stage.startMs) && number(stage.endMs) && number(processMs) && stage.endMs - stage.startMs >= processMs && stage.startMs >= (index ? record.stages[index - 1].endMs : record.startMs) && stage.endMs <= record.endMs;
    });
    const index = records.indexOf(record), chargedStartMs = valid && outerValid ? index ? records[index - 1].endMs : controllerTiming.startMs : null;
    const chargedEndMs = valid && outerValid ? index === records.length - 1 ? controllerTiming.endMs : record.endMs : null;
    const elapsedMs = chargedStartMs !== null ? chargedEndMs - chargedStartMs : null;
    return { jobId: job.id, targetMs: job.targetMs ?? null, ceilingMs: job.ceilingMs ?? null, scheduledElapsedMs: valid ? record.elapsedMs : null, elapsedMs, chargedStartMs, chargedEndMs,
      includesByteAuditOverhead: true, includesControllerOverhead: true, status: number(job.ceilingMs) && (valid && record.elapsedMs > job.ceilingMs || number(elapsedMs) && elapsedMs > job.ceilingMs) ? 'FAIL' : valid && outerValid ? 'PASS' : 'INCONCLUSIVE' };
  });
  const combined = [...new Map(jobs.filter(job => job.combinedBudget).map(job => [job.combinedBudget.jobs.join('/'), job.combinedBudget])).values()].map(budget => {
    const selected = records.filter(record => budget.jobs.includes(record.jobId)), missingJobs = budget.jobs.filter(id => !results.some(result => result.jobId === id && result.status === 'PASS'));
    const valid = selected.length && selected.every(record => results.some(result => result.jobId === record.jobId && number(result.elapsedMs)));
    const charged = results.filter(result => budget.jobs.includes(result.jobId) && number(result.chargedStartMs) && number(result.chargedEndMs));
    const elapsedMs = valid ? Math.max(...charged.map(result => result.chargedEndMs)) - Math.min(...charged.map(result => result.chargedStartMs)) : null;
    return { ...budget, elapsedMs, missingJobs, includesByteAuditOverhead: true,
      status: number(elapsedMs) && elapsedMs > budget.ceilingMs ? 'FAIL' : missingJobs.length || elapsedMs === null ? 'INCONCLUSIVE' : 'PASS' };
  });
  if (records.some(record => !jobs.some(job => job.id === record.jobId)) || new Set(records.map(record => record.jobId)).size !== records.length) errors.push('Unexpected or duplicate whole-job execution record');
  if (records.some((record, index) => record.jobId !== jobs[index]?.id)) errors.push('Whole-job execution order differs from the plan');
  for (let index = 1; index < records.length; index++) if (records[index].startMs < records[index - 1].endMs) errors.push('Whole-job execution intervals overlap');
  return { status: [...results, ...combined].some(result => result.status === 'FAIL') ? 'FAIL' : errors.length || [...results, ...combined].some(result => result.status !== 'PASS') ? 'INCONCLUSIVE' : 'PASS', controllerTiming, jobs: results, combined, errors };
}

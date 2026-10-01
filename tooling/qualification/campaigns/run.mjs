#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity, executionEnvironment, digestJSON } from '../core.mjs';
import { completionQuantile, nearestRank } from '../statistics.mjs';
import { REVISION, createOutput, exclusiveJSON, digest, errorRecord, fileIdentity, monotonic, readJournal, readSealedJSON, sanitize, uniqueId } from './common.mjs';
import { acquireTimingLock, evaluateHost, loadHostAttestation, observeHost, timingLockDirectory, timingHostIdentity } from './host.mjs';
import { makeCampaignPlan } from './inventory.mjs';
import { buildIdentity, toolIdentity, validToolIdentity, CAMPAIGN_VITALS_SOURCE } from './identity.mjs';
import { evaluateSession, evaluateInteraction, evaluateFirstUse, evaluateHotEdit, evaluateLifecycle, evaluateAdapterLifecycle, evaluateVisits } from './metrics.mjs';
import { cleanupOwnedProcesses } from './processes.mjs';
import { resolveProduct, retainFile, validBuildProvenance, verifyPreparedSource } from './product.mjs';
import { verifySealedEvidence } from './verification.mjs';
import { selectFixture } from './fixture-catalog.mjs';
import { evaluateByteAuditCohorts, evaluateJobExecutions, runByteAuditSchedule } from './byte-audits.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKER = join(REPO, 'tooling/qualification/campaigns/worker.mjs');
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const safeCell = value => value.replace(/[^A-Za-z0-9_.-]/g, '_');

export function optionsFromArgs(args) {
  const values = { mode: 'plan', campaign: 'P', features: 'adapters', cache: 'normal', timeoutMs: 600000, diagnostic: false };
  if (args[0] && !args[0].startsWith('--')) values.mode = args.shift();
  if (!['plan', 'run', 'verify'].includes(values.mode)) throw Error('Expected plan, run or verify');
  const seen = new Set(), accepted = new Set(['campaign', 'features', 'cache', 'jobs', 'output', 'fixture-manifest', 'host-attestation', 'configuration', 'timeout-ms', 'diagnostic', 'receipt', 'repo']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !accepted.has(name) || seen.has(name)) throw Error('Unknown or duplicate campaign option');
    seen.add(name);
    if (name === 'diagnostic') { values.diagnostic = true; continue; }
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing --${name} value`);
    values[name] = args[++i];
  }
  if (!['P', 'Q3'].includes(values.campaign) || !['core', 'adapters'].includes(values.features) || !['normal', 'cold'].includes(values.cache)) throw Error('Unknown campaign/capability/cache selection; training is not implemented');
  if (values['timeout-ms'] !== undefined) {
    if (!/^\d+$/.test(values['timeout-ms'])) throw Error('Invalid timeout');
    values.timeoutMs = Number(values['timeout-ms']);
    if (values.timeoutMs < 1000 || values.timeoutMs > 12 * 60 * 60 * 1000) throw Error('Timeout must be 1 second through 12 hours');
  }
  if (values.jobs !== undefined) {
    values.jobs = values.jobs.split(',');
    if (!values.jobs.length || new Set(values.jobs).size !== values.jobs.length) throw Error('Require distinct selected jobs');
  }
  if (values.repo !== undefined && !values.repo.startsWith('/')) throw Error('--repo must be an absolute subject checkout path');
  return values;
}

/** Independent cold child per scored start; one additional fresh child owns
 * every prime and scored warm start for a cell. No cross-cell cache pooling. */
export function executionGroups(plan) {
  const groups = [];
  for (const job of plan.jobs) for (const cell of job.cells) {
    const selected = { ...cell, jobId: job.id };
    for (const field of ['cold', 'warm', 'primes']) if (!Number.isSafeInteger(cell[field]) || cell[field] < 0) throw Error(`Invalid ${field} count for ${cell.id}`);
    if (cell.primes && !cell.warm) throw Error(`Prime without warm scored cohort: ${cell.id}`);
    if (cell.kind === 'lifecycle') {
      if (cell.cold + cell.warm !== 1 || cell.primes !== 0) throw Error('A lifecycle is one independent continuous process');
      groups.push({ id: `${cell.id}/single`, cell: selected, cache: 'single', attempts: [{ ordinal: 1, prime: false }] });
      continue;
    }
    for (let ordinal = 1; ordinal <= cell.cold; ordinal++) groups.push({ id: `${cell.id}/cold/${ordinal}`, cell: selected, cache: 'cold', attempts: [{ ordinal, prime: false }] });
    if (cell.warm) groups.push({ id: `${cell.id}/warm`, cell: selected, cache: 'warm', attempts: [...Array.from({ length: cell.primes }, (_, i) => ({ ordinal: i + 1, prime: true })), ...Array.from({ length: cell.warm }, (_, i) => ({ ordinal: i + 1, prime: false }))] });
  }
  if (new Set(groups.map(group => group.id)).size !== groups.length) throw Error('Duplicate execution group');
  return groups;
}

function expectedAttemptIds(groups) { return groups.flatMap(group => group.attempts.map(attempt => `${group.cell.id}/${group.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`)); }

function evaluatePhaseBudgets(cell, attempts) {
  const requirements = cell.requirements ?? {}, rules = cell.phaseBudgets ?? requirements.phaseBudgets ?? [], evaluations = [];
  for (const rule of rules) {
    const samples = attempts.filter(a => !a.prime).map(attempt => {
      if (rule.measurement) {
        const measured = metricValue(attempt.result, rule.measurement), selectedRule = rule.cohorts?.[attempt.cache] ?? rule;
        const valid = measured && number(measured.value) && measured.unit === 'ms' && typeof measured.method === 'string' && measured.method && measured.evidence !== undefined;
        return { attempt: attempt.id, cache: attempt.cache, durationMs: valid ? measured.value : null, missing: !valid,
          status: attempt.status, ceilingMs: selectedRule.ceilingMs, targetMs: selectedRule.targetMs,
          ...(valid ? { measurement: rule.measurement, method: measured.method, evidence: measured.evidence } : {}) };
      }
      const phases = attempt.result?.phases?.filter(phase => phase.name === rule.phase) ?? [];
      if (!phases.length || phases.length !== 1 && rule.aggregation !== 'maximum') return { attempt: attempt.id, missing: true };
      const selectedRule = rule.cohorts?.[attempt.cache] ?? rule;
      const durations = phases.map(phase => phase.durationMs ?? phase.elapsedMs);
      return { attempt: attempt.id, cache: attempt.cache, durationMs: durations.every(number) ? Math.max(...durations) : null, status: attempt.status, ceilingMs: selectedRule.ceilingMs, targetMs: selectedRule.targetMs };
    });
    const values = samples.filter(sample => number(sample.durationMs)).map(sample => sample.durationMs), maximum = values.length ? Math.max(...values) : null;
    const missing = samples.filter(sample => sample.missing || !number(sample.durationMs)).map(sample => sample.attempt);
    evaluations.push({ ...rule, samples, maximumMs: maximum, status: samples.some(sample => number(sample.durationMs) && sample.durationMs > sample.ceilingMs) ? 'FAIL' : missing.length || attempts.some(a => a.status !== 'PASS') ? 'INCONCLUSIVE' : 'PASS', missing });
  }
  if (number(requirements.completionCeilingMs)) {
    const values = attempts.filter(a => !a.prime && a.result).map(a => a.result.elapsedMs).filter(number), maximum = values.length ? Math.max(...values) : null;
    evaluations.push({ phase: 'declared-completion', ceilingMs: requirements.completionCeilingMs, maximumMs: maximum, status: maximum !== null && maximum > requirements.completionCeilingMs ? 'FAIL' : maximum === null ? 'INCONCLUSIVE' : 'PASS' });
  }
  return evaluations;
}

function metricValue(result, name) {
  const raw = result?.measurements;
  if (Array.isArray(raw)) { const matches = raw.filter(item => item.name === name); return matches.length === 1 ? matches[0] : null; }
  const item = raw?.[name];
  return number(item) ? { name, value: item, missingMethod: true } : item ?? null;
}

export function evaluateRequiredMeasurements(cell, attempts) {
  return (cell.requiredMeasurements ?? []).filter(rule => rule.source !== 'separate-byte-audit').map(rule => {
    const observed = attempts.filter(attempt => !attempt.prime && (!rule.cache || rule.cache === attempt.cache)).map(attempt => {
      const metric = metricValue(attempt.result, rule.name), selected = rule.cohorts?.[attempt.cache] ?? rule;
      const valid = metric && number(metric.value) && metric.unit === rule.unit && typeof metric.method === 'string' && metric.method.length > 0 && metric.evidence !== undefined;
      return { attempt: attempt.id, cache: attempt.cache, value: metric?.value ?? null, ceiling: selected.ceiling, target: selected.target, valid, ...(valid ? { method: metric.method, evidence: metric.evidence } : { reason: 'Required measured value/unit/method/evidence unavailable' }) };
    });
    const cohortOwned = ['R01LcpMs', 'R03Cls', 'R02InpMs'].includes(rule.name);
    const failure = !cohortOwned && observed.some(item => item.valid && item.value > item.ceiling), complete = observed.length > 0 && observed.every(item => item.valid);
    return { ...rule, observations: observed, cohortOwned, status: failure ? 'FAIL' : complete ? 'PASS' : 'INCONCLUSIVE' };
  });
}

function evaluateProtocols(cell, attempts) {
  return attempts.filter(attempt => !attempt.prime).flatMap(attempt => {
    const raw = attempt.result, results = [];
    if (cell.kind === 'lifecycle') {
      const lifecycle = raw?.lifecycle ?? (raw?.kind === 'lifecycle-observation-1' ? raw : null);
      if (lifecycle) results.push(cell.workload === 'WA' ? evaluateAdapterLifecycle(lifecycle) : evaluateLifecycle(lifecycle));
      else results.push({ outcome: 'INCONCLUSIVE', missing: ['Actual continuous lifecycle trace'] });
    }
    if (['interaction.brush', 'text.interaction'].includes(cell.operation)) {
      const session = raw?.session ?? raw?.observations?.session;
      if (session) results.push(evaluateSession(session, cell.operation === 'text.interaction' ? 'IText' : 'I'));
      else results.push({ outcome: 'INCONCLUSIVE', missing: ['Actual 60-second interaction and presentation trace'] });
    }
    return results.map(result => ({ attempt: attempt.id, ...result }));
  });
}

function evaluateVisitCohorts(plan, cell, attempts) {
  const needed = cell.operation === 'navigation.ready' ? ['LCP', 'CLS'] : ['interaction.brush', 'text.interaction'].includes(cell.operation) ? ['INP'] : [];
  if (!needed.length) return [];
  return ['cold', 'warm'].flatMap(cache => {
    const samples = attempts.filter(attempt => !attempt.prime && attempt.cache === cache);
    if (!samples.length) return [];
    return needed.map(metric => {
      const rows = samples.map(attempt => attempt.result?.visits ?? attempt.result?.observations?.visits).filter(Boolean);
      if (rows.length !== samples.length) return { metric, cache, outcome: 'INCONCLUSIVE', missing: ['Every scored visit needs finalized Web Vitals observations'] };
      const library = rows[0].library, cohortKey = rows[0].cohortKey;
      if (rows.some(row => digest(row.library) !== digest(library) || row.cohortKey !== cohortKey)) return { metric, cache, outcome: 'INCONCLUSIVE', missing: ['Mixed visit observer library or cohort identities'] };
      if (library?.name !== 'web-vitals' || library.version !== CAMPAIGN_VITALS_SOURCE.version || library.bytes !== CAMPAIGN_VITALS_SOURCE.bytes || library.sha256 !== CAMPAIGN_VITALS_SOURCE.sha256.slice(7) || library.packageIntegrity !== CAMPAIGN_VITALS_SOURCE.integrity) return { metric, cache, outcome: 'INCONCLUSIVE', missing: ['Executed visit observer differs from the pinned canonical source bytes'] };
      const expectedVisits = rows.flatMap(row => row.expectedVisits ?? (row.visitId ? [row.visitId] : [])), reports = rows.flatMap(row => row.reports ?? []);
      const profile = cell.requirements?.compatibilitySmoke || cell.parameters?.compatibilitySmoke || ['firefox', 'webkit'].includes(cell.parameters?.browser) && plan.campaign === 'Q3' ? 'P' : plan.campaign;
      return evaluateVisits({ profile, metric, cache, cohortKey, library, expectedVisits, reports });
    });
  });
}

/** Interaction, first-use and development edits are separate executable cells,
 * but P-I owns all three. Join only sibling cells from the same job, workload
 * and engine; never borrow an action from another revision or session cohort. */
export function evaluateInteractionCohort(plan, cell, attempts) {
  const own = attempts.filter(attempt => !attempt.prime && attempt.id.startsWith(cell.id + '/'));
  if (cell.operation === 'interaction.first-use') return [evaluateFirstUse(own
    .map(attempt => attempt.result?.firstUse ?? attempt.result?.observations?.firstUse).filter(Boolean))];
  if (cell.operation === 'developer.hot-update') {
    const edits = own.flatMap(attempt => {
      const record = attempt.result?.hotEdit ?? attempt.result?.observations?.hotEdit;
      return record ? [{ ...record, cache: attempt.cache, ordinal: attempt.ordinal }] : [];
    });
    return [evaluateHotEdit(edits, { profile: plan.campaign === 'Q3' && (cell.parameters?.browser ?? 'chromium') === 'chromium' ? 'Q3' : 'P' })];
  }
  if (!['interaction.brush', 'text.interaction'].includes(cell.operation)) return [];
  const job = plan.jobs.find(item => item.cells.some(candidate => candidate.id === cell.id));
  const browser = cell.parameters?.browser ?? 'chromium';
  const protocol = cell.operation === 'text.interaction' ? 'IText' : 'I';
  const profile = plan.campaign === 'P' || browser !== 'chromium' ? 'P' : 'Q3';
  const sessions = own.map(attempt => attempt.result?.session ?? attempt.result?.observations?.session).filter(Boolean);
  const siblings = operation => (job?.cells ?? []).filter(candidate => candidate.operation === operation && candidate.workload === cell.workload && (candidate.parameters?.browser ?? 'chromium') === browser);
  const records = (operation, key) => {
    const ids = siblings(operation).map(candidate => candidate.id + '/');
    return attempts.filter(attempt => !attempt.prime && ids.some(id => attempt.id.startsWith(id)))
      .map(attempt => attempt.result?.[key] ?? attempt.result?.observations?.[key]).filter(Boolean);
  };
  return [evaluateInteraction({ profile, protocol, cohortKey: cell.id, sessions,
    firstUse: profile === 'P' && protocol === 'I' ? records('interaction.first-use', 'firstUse') : [],
    hotEdits: profile === 'P' && protocol === 'I' ? records('developer.hot-update', 'hotEdit') : [] })];
}

/** Missing observations block qualification; a known correctness, timeout,
 * allocation or ceiling failure takes priority over every missing field. */
export function summarize(plan, groups, { hostEligible = false, sourceStable = false, runError = null, byteAuditGroups = [], jobExecutions = [], controllerTiming = null, executableIdentity = null } = {}) {
  const expected = executionGroups(plan), requiredIds = expectedAttemptIds(expected), actualGroups = new Map(), attempts = [], errors = [];
  const byteAudits = evaluateByteAuditCohorts(plan, expected, byteAuditGroups, executableIdentity, groups);
  const jobBudgets = evaluateJobExecutions(plan, groups, byteAuditGroups, jobExecutions, controllerTiming);
  for (const group of groups) {
    if (actualGroups.has(group.id)) errors.push(`Duplicate group ${group.id}`);
    actualGroups.set(group.id, group);
    const scheduled = expected.find(item => item.id === group.id);
    if (!scheduled) { errors.push(`Orphan group ${group.id}`); continue; }
    if (digest(scheduled.cell) !== digest(group.cell) || scheduled.cache !== group.cache) errors.push(`Group contract differs: ${group.id}`);
    for (const [index, attempt] of (group.attempts ?? []).entries()) {
      if (attempt.result?.timingSamplesReusable === false || attempt.result?.d11?.instrumentation === 'precise-coverage-byte-audit') errors.push(`Byte audit instrumentation contaminated a scored attempt: ${attempt.id}`);
      const ordinal = scheduled.attempts.find(item => item.ordinal === attempt.ordinal && item.prime === attempt.prime);
      if (!ordinal || attempt.id !== `${scheduled.cell.id}/${scheduled.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`) errors.push(`Invalid attempt identity: ${attempt.id}`);
      if (attempt.cache !== scheduled.cache || attempt.ordinal !== scheduled.attempts[index]?.ordinal || attempt.prime !== scheduled.attempts[index]?.prime) errors.push(`Attempt cache/order differs: ${attempt.id}`);
      attempts.push(attempt);
    }
    const firstScored = (group.attempts ?? []).findIndex(attempt => !attempt.prime);
    if (firstScored >= 0 && group.attempts.slice(firstScored).some(attempt => attempt.prime)) errors.push(`Late prime: ${group.id}`);
  }
  if (new Set(attempts.map(a => a.id)).size !== attempts.length) errors.push('Duplicate attempt identity');
  const ids = new Set(attempts.map(attempt => attempt.id)), missing = requiredIds.filter(id => !ids.has(id));
  const unexpected = attempts.filter(attempt => !requiredIds.includes(attempt.id)).map(attempt => attempt.id);
  const cells = plan.jobs.flatMap(job => job.cells).map(cell => {
    const observations = attempts.filter(attempt => attempt.id.startsWith(cell.id + '/'));
    const cohorts = ['cold', 'warm', 'single'].flatMap(cache => {
      const samples = observations.filter(attempt => attempt.cache === cache), scored = samples.filter(attempt => !attempt.prime);
      if (!samples.length) return [];
      const timed = scored.map(attempt => ({ outcome: attempt.status === 'PASS' ? 'expected' : attempt.timedOut ? 'timeout' : attempt.status === 'FAIL' ? 'unexpected-error' : 'infra-invalid', elapsedMs: attempt.elapsedMs ?? 0 }));
      const completed = scored.filter(attempt => attempt.status === 'PASS' && number(attempt.result?.elapsedMs)).map(attempt => attempt.result.elapsedMs);
      return [{ cache, scored: scored.length, primes: samples.length - scored.length, rawAttemptIds: samples.map(sample => sample.id), allAttemptP95: completionQuantile(timed), successOnly: { diagnosticOnly: true, n: completed.length, p50: completed.length ? nearestRank(completed, 0.5) : null, p95: completed.length ? nearestRank(completed, 0.95) : null, max: completed.length ? Math.max(...completed) : null } }];
    });
    const budgets = evaluatePhaseBudgets(cell, observations), measurements = [...evaluateRequiredMeasurements(cell, observations), ...(byteAudits.cells.find(value => value.cellId === cell.id)?.measurements ?? [])];
    let protocols;
    try { protocols = [...evaluateProtocols(cell, observations), ...evaluateInteractionCohort(plan, cell, attempts), ...evaluateVisitCohorts(plan, cell, observations)]; }
    catch (error) { protocols = [{ outcome: 'INCONCLUSIVE', missing: ['Malformed or missing specialized protocol trace'], error: errorRecord(error) }]; }
    return { id: cell.id, operation: cell.operation, cohorts, phaseBudgets: budgets, measurements, protocols, status: observations.some(a => a.status === 'FAIL') || budgets.some(b => b.status === 'FAIL') || measurements.some(m => m.status === 'FAIL') || protocols.some(p => p.outcome === 'FAIL') ? 'FAIL' : !observations.length || budgets.some(b => b.status !== 'PASS') || measurements.some(m => m.status !== 'PASS') || protocols.some(p => p.outcome !== 'PASS') || observations.some(a => a.status !== 'PASS') ? 'INCONCLUSIVE' : 'PASS' };
  });
  const failed = groups.some(g => g.status === 'FAIL' || g.timedOut) || attempts.some(a => a.status === 'FAIL') || cells.some(c => c.status === 'FAIL') || byteAudits.status === 'FAIL' || jobBudgets.status === 'FAIL';
  const complete = !runError && !errors.length && !missing.length && !unexpected.length && actualGroups.size === expected.length && groups.every(g => g.status === 'PASS') && cells.every(c => c.status === 'PASS') && byteAudits.status === 'PASS' && jobBudgets.status === 'PASS';
  return {
    status: failed ? 'FAIL' : complete && hostEligible && sourceStable ? 'PASS' : 'INCONCLUSIVE',
    qualification: complete && hostEligible && sourceStable && !failed,
    scope: 'Only the selected exact job/cell/cache cohorts. Complete P/Q3 qualification requires the sealed graph and every independent C/H revision receipt.',
    counts: { plannedScored: expected.reduce((n, g) => n + g.attempts.filter(a => !a.prime).length, 0), plannedPrimes: expected.reduce((n, g) => n + g.attempts.filter(a => a.prime).length, 0), attempted: attempts.filter(a => !a.prime).length, expectedOutcome: attempts.filter(a => !a.prime && a.status === 'PASS').length, unexpectedError: attempts.filter(a => !a.prime && a.status === 'FAIL' && !a.timedOut).length, timeout: attempts.filter(a => a.timedOut).length, infraInvalid: attempts.filter(a => !a.prime && a.status === 'INCONCLUSIVE').length, missing: missing.length, primesAttempted: attempts.filter(a => a.prime).length },
    missing, unexpected, integrityErrors: errors, hostEligible, sourceStable, cells, byteAudits, jobBudgets,
  };
}

export function recoverAttempts(events) {
  const attempts = new Map();
  for (const event of events) {
    if (event.event === 'attempt-start') attempts.set(event.attempt.id, { ...event.attempt, status: 'INCONCLUSIVE' });
    if (event.event === 'attempt-action-start' && attempts.has(event.id)) Object.assign(attempts.get(event.id), { startMs: event.startMs, reset: event.reset, resetElapsedMs: event.resetElapsedMs });
    if (event.event === 'attempt-end') attempts.set(event.attempt.id, event.attempt);
  }
  return [...attempts.values()];
}

async function launchGroup(group, context) {
  const output = join(context.output, safeCell(group.id)); await mkdir(output, { mode: 0o700 });
  let fixture = context.fixture, fixtureIdentity = null;
  try {
    if (group.cell.handler !== 'developer') fixture = await selectFixture(context.fixture, group.cell);
    if (group.cell.handler !== 'developer' && fixture?.manifestPath && fixture?.seal) {
      const selected = await readSealedJSON(fixture.manifestPath, fixture.seal.sha256.startsWith('sha256:') ? fixture.seal.sha256 : 'sha256:' + fixture.seal.sha256);
      const retainedPath = 'selected-fixture-manifest.json'; await writeFile(join(output, retainedPath), selected.bytes, { flag: 'wx', mode: 0o600 });
      fixtureIdentity = { path: fixture.manifestPath, ...selected.identity, retainedPath };
    }
  }
  catch (error) {
    const result = { ...group, attempts: [], status: error.code === 'CAMPAIGN_PREREQUISITE' ? 'INCONCLUSIVE' : 'FAIL', error: errorRecord(error), output, fixturePreparationFailed: true };
    await exclusiveJSON(join(output, 'input.json'), { ...group, repo: context.repo, fixtureDescriptor: context.fixture, output });
    await writeFile(join(output, 'process.log'), '', { flag: 'wx', mode: 0o600 });
    await exclusiveJSON(join(output, 'controller.json'), sanitize(result)); return result;
  }
  const spec = { ...group, output, repo: context.repo, subjectRepo: context.subjectRepo ?? context.repo, browserCache: context.browserCache ?? null, timingLease: context.timingLease ?? null, fixture, fixtureIdentity, configuration: context.configuration,
    rendererIdentity: group.cell.handler === 'browser' && group.cell.kind === 'lifecycle' ? context.rendererIdentity ?? null : null };
  await exclusiveJSON(join(output, 'input.json'), spec);
  const loopbackBackend = group.cell.operation.startsWith('queue.') || ['fast.workflow', 'transfer.asset', 'state.command-accept-dispatch'].includes(group.cell.operation);
  const guard = group.cell.handler === 'adapters' ? group.cell.operation === 'adapter.transfer' ? 'tests/provider/no-egress.mjs' : 'tests/store/no-network.mjs' : group.cell.handler === 'backend' ? loopbackBackend ? 'tests/provider/no-egress.mjs' : 'tests/store/no-network.mjs' : 'tests/session/no-egress.mjs';
  const argv = ['--import', join(REPO, guard), WORKER, join(output, 'input.json')], log = openSync(join(output, 'process.log'), 'wx', 0o600);
  const started = monotonic(), startedAt = new Date().toISOString(); let timedOut = false, interrupted = false;
  const env = executionEnvironment(process.env, join(context.subjectRepo ?? context.repo, '.toolchain/bin'), output);
  if (context.browserCache) env.PLAYWRIGHT_BROWSERS_PATH = context.browserCache;
  const subprocess = spawn(process.execPath, argv, { cwd: context.repo, env, detached: process.platform !== 'win32', stdio: ['ignore', log, log] });
  const kill = signal => { try { if (process.platform !== 'win32') process.kill(-subprocess.pid, signal); else subprocess.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  let killTimer;
  const terminate = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1000); killTimer.unref(); };
  const declaredDuration = group.cell.kind === 'lifecycle' ? Math.max(context.timeoutMs, (group.cell.parameters?.cycles ?? 2) * 90000 + 30000 + 120000) : context.timeoutMs * group.attempts.length;
  const duration = number(context.maxGroupElapsedMs) ? Math.min(declaredDuration, context.maxGroupElapsedMs) : declaredDuration;
  const timer = setTimeout(() => { timedOut = true; terminate(); }, duration);
  const abort = () => { interrupted = true; terminate(); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const exit = await new Promise(resolve => { subprocess.once('error', error => resolve({ exitCode: null, signal: null, error: errorRecord(error) })); subprocess.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
  clearTimeout(timer); if (killTimer) clearTimeout(killTimer); closeSync(log); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  // A child can exit while its browser/server survives. Sweep only this owned
  // process group; unrelated services are never touched.
  kill('SIGKILL');
  let ownedCleanup = [], ownedCleanupError = null, sourceRecovery = null, sourceRecoveryError = null;
  try { ownedCleanup = await cleanupOwnedProcesses(output, subprocess.pid); }
  catch (error) { ownedCleanupError = errorRecord(error); }
  if (group.cell.operation === 'developer.hot-update') {
    try {
      if (ownedCleanupError) throw Error('HMR recovery requires confirmed owned process exit');
      const { recoverHmrSource } = await import('./browser-hmr.mjs');
      sourceRecovery = await recoverHmrSource({ repo: context.repo, subjectRepo: context.subjectRepo ?? context.repo, output, workerPid: subprocess.pid, configuration: context.configuration });
      await exclusiveJSON(join(output, 'source-recovery.json'), sourceRecovery);
    } catch (error) { sourceRecoveryError = errorRecord(error); }
  }
  let receipt;
  try { receipt = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8')); }
  catch (error) {
    let attempts = [], journal = null;
    try { journal = readJournal(await readFile(join(output, 'events.jsonl'), 'utf8')); attempts = recoverAttempts(journal.events); } catch {}
    receipt = { status: timedOut || interrupted || exit.exitCode === 1 ? 'FAIL' : 'INCONCLUSIVE', attempts, partial: true, error: errorRecord(error), journalHead: journal?.head ?? null };
  }
  if (timedOut || interrupted) {
    receipt.status = 'FAIL';
    const last = receipt.attempts?.at(-1);
    if (last && last.status !== 'PASS') {
      last.status = 'FAIL'; last.timedOut = timedOut;
      // A killed child's monotonic clock is not subtracted from this process.
      // Without its final local measurement the safe action lower bound is the
      // already-recorded local value (often zero), never whole-process elapsed.
      last.elapsedMs ??= 0;
      last.censor = { lowerMs: last.elapsedMs, upperMs: null, reason: timedOut ? 'process-timeout' : 'interrupted', timedBoundary: last.startMs === undefined ? 'reset-or-preparation' : 'action', durationUnavailable: last.elapsedMs === 0 };
    }
  }
  if (exit.exitCode !== 0 && receipt.status === 'PASS') receipt.status = 'FAIL';
  if (ownedCleanupError || sourceRecoveryError) receipt.status = 'FAIL';
  const result = { ...group, ...receipt, id: group.id, cell: group.cell, cache: group.cache, process: { argv, executable: process.execPath, ...exit, startedAt, elapsedMs: monotonic() - started, timedOut, interrupted, ownedCleanup, ownedCleanupError, sourceRecovery, sourceRecoveryError }, output, timedOut };
  await exclusiveJSON(join(output, 'controller.json'), sanitize(result)); return result;
}

async function evidenceFiles(output) {
  const files = [];
  // Private fixture/store bytes are measured by their own sealed manifests;
  // receipt sealing streams only named metadata, never loads full rasters.
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw Error('Symlink in receipt tree');
      if (item.isDirectory() && !['store', 'root', 'fixtures', 'browser-profile', 'profile'].includes(item.name)) await walk(path);
      else if (item.isFile() && /\.(?:json|jsonl|log|txt)$/.test(item.name)) files.push({ path: path.slice(output.length + 1), ...await fileIdentity(path) });
    }
  }
  await walk(output); return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function verifyCampaignReceipt(path) {
  const receipt = JSON.parse(await readFile(path, 'utf8')), output = dirname(path);
  if (receipt.kind !== 'perf-runtime-campaign-1' || receipt.revision !== REVISION || !Array.isArray(receipt.evidence)) throw Error('Unsupported campaign receipt');
  await verifySealedEvidence(receipt, output);
  for (const file of receipt.evidence) {
    if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split(/[\\/]/).includes('..')) throw Error('Unsafe receipt evidence path');
    const actual = await fileIdentity(join(output, file.path));
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw Error(`Evidence changed: ${file.path}`);
  }
  if (digest(receipt.plan) !== receipt.planDigest) throw Error('Plan digest mismatch');
  const reproducedPlan = makeCampaignPlan({ campaign: receipt.plan.campaign, features: receipt.plan.features, cache: receipt.plan.cache ?? 'normal', jobs: receipt.plan.selectedJobIds });
  if (digest(reproducedPlan) !== receipt.planDigest) throw Error('Receipt does not use the current exact campaign inventory');
  const evidencePaths = new Set(receipt.evidence.map(file => file.path));
  if (evidencePaths.size !== receipt.evidence.length) throw Error('Duplicate evidence path');
  for (const name of ['plan.json', 'source-before.json', 'source-after.json', 'host.json']) if (!evidencePaths.has(name)) throw Error(`Missing required sealed evidence: ${name}`);
  if (digest(JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'))) !== receipt.planDigest) throw Error('Sealed plan differs from receipt');
  for (const side of ['before', 'after']) {
    if (digestJSON(receipt.identity[side].files) !== receipt.identity[side].digest || digest(JSON.parse(await readFile(join(output, `source-${side}.json`), 'utf8'))) !== digest(receipt.identity[side])) throw Error('Subject source identity mismatch');
  }
  for (const side of ['controlBefore', 'controlAfter']) if (digestJSON(receipt.identity[side].files) !== receipt.identity[side].digest) throw Error('Control source identity mismatch');
  for (const side of ['buildsBefore', 'buildsAfter']) if (digest(receipt.identity[side].files) !== receipt.identity[side].digest) throw Error('Executable build identity mismatch');
  for (const group of receipt.groups) {
    const folder = safeCell(group.id), controllerPath = `${folder}/controller.json`, inputPath = `${folder}/input.json`;
    if (!evidencePaths.has(controllerPath) || !evidencePaths.has(inputPath) || !evidencePaths.has(`${folder}/process.log`)) throw Error('Required group controller/input/log evidence is absent');
    const controller = JSON.parse(await readFile(join(output, controllerPath), 'utf8'));
    if (digest(controller) !== digest(group)) throw Error('Raw group differs from sealed controller evidence');
    const input = JSON.parse(await readFile(join(output, inputPath), 'utf8'));
    if (digest(input.cell) !== digest(group.cell) || input.cache !== group.cache) throw Error('Executed group differs from its sealed input');
    const journalPath = `${folder}/events.jsonl`;
    if (evidencePaths.has(journalPath)) {
      const journal = readJournal(await readFile(join(output, journalPath), 'utf8')), recovered = recoverAttempts(journal.events);
      for (const attempt of recovered) {
        const actual = group.attempts.find(value => value.id === attempt.id);
        if (!actual || attempt.status === 'PASS' && digest(actual) !== digest(attempt)) throw Error('Attempt differs from append-only journal evidence');
      }
    } else if (group.status === 'PASS') throw Error('A passing group requires its append-only journal');
  }
  const preparedStable = !receipt.identity.preparedSource || receipt.identity.preparedSourceAfter?.digest === receipt.identity.preparedSource.digest;
  const sourceStable = receipt.identity.before.digest === receipt.identity.after.digest && receipt.identity.controlBefore.digest === receipt.identity.controlAfter.digest && preparedStable;
  const requiredProfiles = [...new Set(reproducedPlan.jobs.flatMap(job => job.cells.map(cell => cell.host)))];
  const runtimeOnly = reproducedPlan.jobs.every(job => job.cells.every(cell => cell.handler !== 'developer'));
  const toolsValid = validToolIdentity(receipt.identity.tools, reproducedPlan);
  const buildsValid = !runtimeOnly || !receipt.identity.buildsBefore.missing.length && receipt.identity.buildsBefore.files.length > 0 && receipt.identity.buildsBefore.digest === receipt.identity.buildsAfter.digest && validBuildProvenance(receipt.identity.buildProvenance, receipt.identity.before, receipt.identity.buildsBefore);
  const independentlyEligible = requiredProfiles.length > 0 && requiredProfiles.every(profile => evaluateHost(receipt.host.observed, profile, receipt.host.attestation).eligible) && toolsValid && buildsValid;
  const summary = summarize(receipt.plan, receipt.groups, { hostEligible: independentlyEligible, sourceStable, runError: receipt.runError,
    byteAuditGroups: receipt.byteAuditGroups ?? [], jobExecutions: receipt.jobExecutions ?? [], controllerTiming: receipt.controllerTiming ?? null, executableIdentity: { sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools) } });
  if (digest(summary) !== digest(receipt.summary)) throw Error('Campaign verdict cannot be reproduced');
  return { status: summary.status, qualification: summary.qualification, evidenceFiles: receipt.evidence.length };
}

export async function runPlan(plan, context, launch = launchGroup) {
  const groups = [];
  for (const group of executionGroups(plan)) {
    const result = await launch(group, context); groups.push(result);
    // Preserve every scheduled missing start; never rerun until green or convert
    // an unsupported action into a successful functional-test sample.
    if (result.status !== 'PASS') break;
  }
  return groups;
}

export async function main(args) {
  if (args.includes('--help')) { console.log('Usage: node tooling/qualification/campaigns/run.mjs plan|run --campaign P|Q3 --jobs C9,H3,... [--repo /subject/checkout] [--features adapters|core] [--cache normal|cold] [--diagnostic] [--host-attestation /sealed.json] [--fixture-manifest /sealed.json] [--configuration /sealed.json] --output artifacts/NEW; verify --receipt /absolute/receipt.json. Counts/cells are fixed by PERF-8+A3. Runtime handlers never build, install, call a real provider, or rewrite earlier evidence. Developer handlers retain their explicit command contracts.'); return; }
  const options = optionsFromArgs([...args]);
  if (options.mode === 'verify') { if (!options.receipt) throw Error('Verification requires --receipt'); console.log(JSON.stringify(await verifyCampaignReceipt(resolve(options.receipt)))); return; }
  const plan = makeCampaignPlan({ campaign: options.campaign, features: options.features, cache: options.cache, ...(options.jobs ? { jobs: options.jobs } : {}) });
  if (options.mode === 'plan') { console.log(JSON.stringify({ ...plan, groups: executionGroups(plan).map(group => ({ id: group.id, handler: group.cell.handler, attempts: group.attempts.length })) }, null, 2)); return; }
  if (process.versions.node !== '26.10.0') throw Error('Use pinned Node 26.10.0');
  const selectedHandlers = new Set(plan.jobs.flatMap(job => job.cells.map(cell => cell.handler)));
  if (selectedHandlers.has('developer') && selectedHandlers.size > 1) throw Error('Run developer and runtime jobs as separate invocations in the CI graph so C2/H0 product provenance is resolved after preparation');
  if (!options.output) throw Error('Run requires new --output artifacts/ directory');
  const repo = resolve(options.repo ?? REPO), profiles = [...new Set(plan.jobs.flatMap(job => job.cells.map(cell => cell.host)))];
  const output = await createOutput(repo, options.output), receiptId = uniqueId('perf');
  const lock = await acquireTimingLock(await timingLockDirectory(), { host: timingHostIdentity(), receiptId });
  try {
    const startedAt = new Date().toISOString(), began = monotonic();
    const observed = await observeHost(), loadedAttestation = await loadHostAttestation(options['host-attestation']);
    const { consumedBytes: attestationBytes, consumedPath: attestationPath, ...attestationFields } = loadedAttestation ?? {};
    const attestation = loadedAttestation ? attestationFields : null;
    const hostChecks = profiles.map(profile => evaluateHost(observed, profile, attestation)), hostEligible = hostChecks.every(check => check.eligible);
    if (!hostEligible && !options.diagnostic) throw Error('Host is not qualified for every selected cell. Use --diagnostic to execute while retaining an INCONCLUSIVE qualification verdict.');
    const before = sourceIdentity(repo), controlBefore = sourceIdentity(REPO);
    const inputIdentities = { hostAttestation: null, fixtureManifest: null, configuration: null, buildProvenance: null, developerState: null, ciHandoff: null, testInputPacket: null };
    const inputDirectory = join(output, 'input-manifests'); await mkdir(inputDirectory, { mode: 0o700 });
    if (attestationBytes) {
      const retainedPath = 'input-manifests/host-attestation.json';
      await writeFile(join(output, retainedPath), attestationBytes, { flag: 'wx', mode: 0o600 });
      inputIdentities.hostAttestation = { path: attestationPath, ...attestation.identity, retainedPath };
      for (let index = 0; index < attestation.evidence.length; index++) attestation.evidence[index] = await retainFile(attestation.evidence[index].path, output, `input-manifests/host-evidence-${index}.txt`, attestation.evidence[index]);
    }
    let groups = [], byteAuditGroups = [], jobExecutions = [], runError = null, fixture = null, configuration = {}, buildProvenance = null, productRepo = repo, preparedSource = null, browserCache = null, supplemental = [];
    let buildsBefore = null, tools = null;
    const runtimeOnly = plan.jobs.every(job => job.cells.every(cell => cell.handler !== 'developer'));
    await exclusiveJSON(join(output, 'plan.json'), plan); await exclusiveJSON(join(output, 'source-before.json'), before); await exclusiveJSON(join(output, 'host.json'), { observed, attestation, hostChecks });
    async function input(path, key, name) {
      const sealed = await readSealedJSON(resolve(path)), retainedPath = 'input-manifests/' + name;
      await writeFile(join(output, retainedPath), sealed.bytes, { flag: 'wx', mode: 0o600 });
      inputIdentities[key] = { path: resolve(path), ...sealed.identity, retainedPath }; return sealed.value;
    }
    try {
      if (options['fixture-manifest']) fixture = await input(options['fixture-manifest'], 'fixtureManifest', 'fixture-manifest.json');
      if (options.configuration) configuration = await input(options.configuration, 'configuration', 'configuration.json');
      const prepared = await resolveProduct({ repo, subject: before, configuration, input, output, runtimeOnly });
      ({ productRepo, provenance: buildProvenance, preparedSource, browserCache, supplemental } = prepared);
      buildsBefore = await buildIdentity(productRepo); tools = await toolIdentity(productRepo);
      ({ groups, byteAuditGroups, jobExecutions } = await runByteAuditSchedule(plan, executionGroups(plan), { repo: runtimeOnly ? productRepo : repo, subjectRepo: repo, browserCache, timingLease: lock.lease, output, fixture, configuration, timeoutMs: options.timeoutMs, controllerStartMs: began,
        executableIdentity: { sourceDigest: before.digest, buildDigest: buildsBefore.digest, toolsDigest: digest(tools) },
        rendererIdentity: { sourceFiles: before.files, buildFiles: buildsBefore.files, sourceDigest: before.digest, buildDigest: buildsBefore.digest, toolsDigest: digest(tools) } }, launchGroup, { state: { groups, byteAuditGroups, jobExecutions } }));
    } catch (error) { runError = errorRecord(error); }
    buildsBefore ??= await buildIdentity(productRepo); tools ??= await toolIdentity(productRepo);
    const after = sourceIdentity(repo), controlAfter = sourceIdentity(REPO), buildsAfter = await buildIdentity(productRepo); await exclusiveJSON(join(output, 'source-after.json'), after);
    let preparedSourceStable = true, preparedSourceAfter = null;
    if (preparedSource) { try { preparedSourceAfter = await verifyPreparedSource(productRepo, buildProvenance.sourceManifest, before.files, supplemental); preparedSourceStable = preparedSourceAfter.digest === preparedSource.digest; } catch (error) { preparedSourceStable = false; runError ??= errorRecord(error); } }
    const sourceStable = before.digest === after.digest && controlBefore.digest === controlAfter.digest && preparedSourceStable;
    const provenanceValid = validBuildProvenance(buildProvenance, before, buildsBefore);
    const inputsValid = validToolIdentity(tools, plan) && (!runtimeOnly || !buildsBefore.missing.length && buildsBefore.digest === buildsAfter.digest && provenanceValid);
    const evidence = await evidenceFiles(output), endMs = monotonic();
    const controllerTiming = { kind: 'perf-campaign-controller-timing-1', clock: 'controller-monotonic', startMs: began, endMs, elapsedMs: endMs - began, through: 'retained-evidence-hash-completion' };
    await exclusiveJSON(join(output, 'controller-timing.json'), controllerTiming);
    evidence.push({ path: 'controller-timing.json', ...await fileIdentity(join(output, 'controller-timing.json')) }); evidence.sort((a, b) => a.path.localeCompare(b.path));
    const summary = summarize(plan, groups, { hostEligible: hostEligible && inputsValid, sourceStable, runError, byteAuditGroups, jobExecutions, controllerTiming,
      executableIdentity: { sourceDigest: before.digest, buildDigest: buildsBefore.digest, toolsDigest: digest(tools) } });
    const receipt = { kind: 'perf-runtime-campaign-1', revision: REVISION, receiptId, startedAt, finishedAt: new Date().toISOString(), elapsedMs: monotonic() - began, argv: process.argv, subjectRepo: repo, controlRepo: REPO, productRepo, plan, planDigest: digest(plan), inputIdentities, identity: { before, after, controlBefore, controlAfter, buildsBefore, buildsAfter, tools, runtimeOnly, inputsValid, buildProvenance, provenanceValid, preparedSource, preparedSourceAfter, preparedSourceStable }, host: { observed, attestation, hostChecks }, groups, byteAuditGroups, jobExecutions, controllerTiming, summary, runError, evidence, retention: { rawDays: 90, aggregateDays: 365, releaseDefining: 'supported release lifetime plus 365 days', automaticPruning: false } };
    await exclusiveJSON(join(output, 'receipt.json'), sanitize(receipt));
    console.log(JSON.stringify({ output, status: summary.status, qualification: summary.qualification, counts: summary.counts, runError })); process.exitCode = summary.status === 'PASS' ? 0 : summary.status === 'FAIL' ? 1 : 2;
  } catch (error) {
    await exclusiveJSON(join(output, 'setup-failure.json'), { kind: 'perf-campaign-setup-failure-1', receiptId, status: 'INCONCLUSIVE', qualification: false, error: errorRecord(error), recordedAt: new Date().toISOString() });
    throw error;
  } finally { await lock.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

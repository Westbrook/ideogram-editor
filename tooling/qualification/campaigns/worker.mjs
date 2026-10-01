import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournal, exclusiveJSON, errorRecord, monotonic, intervalWait, PrerequisiteError, sanitize, attemptIdentity } from './common.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const factories = {
  backend: ['./backend.mjs', ['createBackendAdapter']],
  browser: ['./browser.mjs', ['createBrowserCampaign']],
  adapters: ['./adapters.mjs', ['createAdapterCampaign']],
  developer: ['../developer-campaigns/bridge.mjs', ['createDeveloperAdapter']],
};
const normalized = status => ({ pass: 'PASS', passed: 'PASS', completed: 'PASS', fail: 'FAIL', failed: 'FAIL', inconclusive: 'INCONCLUSIVE', incomplete: 'INCONCLUSIVE' })[status] ?? status;

/** All duration fields are local to this child. Cross-process phases must retain
 * their clock-domain identifier, never subtract remote clocks from this one. */
export function normalizeResult(value, startMs, endMs) {
  const result = value && typeof value === 'object' ? { ...value } : {};
  result.status = normalized(result.status ?? result.outcome);
  if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(result.status)) result.status = 'INCONCLUSIVE';
  result.elapsedMs ??= endMs - startMs;
  result.startMs ??= startMs; result.endMs ??= endMs;
  result.phases ??= []; result.missing ??= [];
  if (!Array.isArray(result.phases) || !Array.isArray(result.missing)) throw Error('Driver phases/missing must be arrays');
  if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) throw Error('Driver elapsed time must be nonnegative');
  result.phases = result.phases.map(phase => {
    if (typeof phase.name !== 'string' || !phase.name) throw Error('Driver phase lacks its boundary name');
    const duration = phase.durationMs ?? phase.elapsedMs ?? (phase.endMs - phase.startMs);
    if (!Number.isFinite(duration) || duration < 0) throw Error('Driver phase lacks a local duration');
    return { ...phase, durationMs: duration };
  });
  if (Array.isArray(result.assertions) && result.assertions.some(assertion => assertion.passed === false || assertion.ok === false || assertion.status === 'FAIL')) result.status = 'FAIL';
  if (result.correctnessViolation || result.capViolation) result.status = 'FAIL';
  if (result.status !== 'FAIL' && result.missing.length) result.status = 'INCONCLUSIVE';
  return result;
}

async function makeAdapter(spec, context) {
  const entry = factories[spec.cell.handler];
  if (!entry) throw new PrerequisiteError(`No runtime adapter for ${spec.cell.handler}; developer jobs use the developer campaign executable.`);
  const module = await import(new URL(entry[0], import.meta.url));
  const name = entry[1].find(name => typeof module[name] === 'function');
  if (!name) throw new PrerequisiteError(`Missing ${spec.cell.handler} adapter factory`);
  return module[name](context);
}

async function resourceObservation(adapter) {
  const startMs = monotonic();
  const resources = adapter.measureResources ? await adapter.measureResources() : null;
  return { observation: { startMs, endMs: monotonic() }, resources, observerRSS: process.memoryUsage().rss, observerHighWaterRSS: process.resourceUsage().maxRSS * 1024 };
}

/** The real idle is part of the protocol; no fake timers or forced GC. The same
 * driver/browser/backend lives from B0 through B_n. Actual window scheduling is
 * retained even if a slow cycle makes the prescribed window incomplete. */
export async function runLifecycle(cell, adapter, context) {
  const parameters = cell.parameters ?? {}, cycles = parameters.cycles ?? (cell.jobId?.startsWith('I') ? 100 : 2);
  const idleMs = parameters.idleMs ?? 30000, cycleBudgetMs = parameters.cycleBudgetMs ?? 90000;
  if (![2, 100].includes(cycles) || idleMs !== 30000 || cycleBudgetMs !== 90000) throw Error('Lifecycle counts/idles/budget cannot be overridden');
  if (typeof adapter.lifecycleCycle !== 'function' || typeof adapter.measureResources !== 'function') throw new PrerequisiteError('Driver must implement actual lifecycleCycle and process-tree/resource observation');
  const adapterLifecycle = cell.workload === 'WA', scheduledRestarts = adapterLifecycle ? [] : parameters.restarts ?? (cycles === 2 ? [1] : [20, 40, 60, 80]);
  const processIdentity = adapter.lifecycleIdentity ? JSON.stringify(await adapter.lifecycleIdentity()) : null, fixtureIdentity = adapter.fixtureIdentity ?? context.fixture?.manifestHash ?? context.fixture?.sha256 ?? null;
  const result = { status: 'PASS', kind: 'lifecycle-observation-1', profile: adapterLifecycle ? cell.jobId?.startsWith('I') ? 'Q3-A' : 'P-A' : cycles === 100 ? 'M' : 'P-M', workload: cell.workload, processIdentity, fixtureIdentity, weightsIdentity: adapter.weightsIdentity ?? null, configIdentity: adapter.configIdentity ?? null, startMs: monotonic(), B0: null, cycles: [], windows: [], phases: [], assertions: [], missing: [], forcedGC: false, processRestarted: false, protocol: { cycles, idleMs, cycleBudgetMs: adapterLifecycle ? null : cycleBudgetMs, restarts: scheduledRestarts, forcedGC: false, mainProcessRestart: false } };
  const baselineIdle = await context.wait(idleMs, context.signal);
  result.B0 = { idle: baselineIdle, ...await resourceObservation(adapter) };
  await context.trace({ event: 'lifecycle-baseline', observation: result.B0 });
  const seriesStart = result.B0.idle.endMs;
  for (let ordinal = 1; ordinal <= cycles; ordinal++) {
    const currentProcessIdentity = adapter.lifecycleIdentity ? JSON.stringify(await adapter.lifecycleIdentity()) : null;
    const cycle = { ordinal, processIdentity: currentProcessIdentity, fixtureIdentity, weightsIdentity: result.weightsIdentity, configIdentity: result.configIdentity, startMs: monotonic(), action: null, restart: null, idle: null, resources: null };
    if (processIdentity !== currentProcessIdentity) { result.processRestarted = true; result.status = 'FAIL'; }
    result.cycles.push(cycle);
    await context.trace({ event: 'lifecycle-cycle-start', ordinal });
    try {
      const start = monotonic();
      cycle.action = normalizeResult(await adapter.lifecycleCycle(cell, { cycle: ordinal, signal: context.signal }), start, monotonic());
      if (cycle.action.status === 'FAIL') result.status = 'FAIL';
      if (cycle.action.status === 'INCONCLUSIVE' && result.status !== 'FAIL') result.status = 'INCONCLUSIVE';
      if (scheduledRestarts.includes(ordinal)) {
        if (!adapter.restartWorker) {
          result.missing.push('Required worker restart is unavailable; main-process restart is forbidden');
          if (result.status !== 'FAIL') result.status = 'INCONCLUSIVE';
          cycle.restart = { required: true, observed: false };
        } else {
          const restartStart = monotonic(), evidence = await adapter.restartWorker({ cycle: ordinal });
          cycle.restart = { startMs: restartStart, endMs: monotonic(), before: evidence?.before ?? null, after: evidence?.after ?? null, evidence };
        }
      }
      // Every cycle still records its whole 30-second post-close idle after a
      // measured slow action; it cannot squeeze the idle to manufacture a pass.
      cycle.idle = await context.wait(idleMs, context.signal);
      const observation = await resourceObservation(adapter); cycle.resources = observation.resources; cycle.resourceObservation = observation;
      cycle.observation = observation.observation;
      cycle.releaseMs = cycle.action.releaseMs ?? null;
      cycle.resourceSamples = cycle.action.resourceSamples ?? [];
      cycle.endMs = monotonic(); cycle.elapsedMs = cycle.endMs - cycle.startMs;
      if (!adapterLifecycle && cycle.elapsedMs > cycleBudgetMs) { result.status = 'FAIL'; cycle.cycleBudgetExceeded = true; }
      if (cycles === 100) {
        const nextSlot = seriesStart + ordinal * cycleBudgetMs;
        if (ordinal % 20 === 0) { cycle.window = { ordinal: ordinal / 20, expectedEndMs: nextSlot, observedEndMs: cycle.endMs }; result.windows.push({ ordinal: ordinal / 20, startMs: seriesStart + (ordinal - 20) * cycleBudgetMs, endMs: nextSlot, observedLastCycleEndMs: cycle.endMs }); }
        // Five consecutive 30-minute windows, not 100 tightly compressed cycles.
        if (monotonic() < nextSlot) cycle.windowPadding = await context.wait(nextSlot - monotonic(), context.signal);
      }
    } catch (error) {
      cycle.error = errorRecord(error); cycle.endMs = monotonic();
      if (error?.code === 'CAMPAIGN_PREREQUISITE') { if (result.status !== 'FAIL') result.status = 'INCONCLUSIVE'; result.missing.push(error.message); }
      else result.status = 'FAIL';
    }
    await context.trace({ event: 'lifecycle-cycle-end', cycle });
    // Missing observation capabilities do not erase feasible later cycles.
    // An actual failed action or interrupted/incomplete cycle still stops the
    // workload; no later cycle is substituted for it.
    if (result.status === 'FAIL' || cycle.error) break;
  }
  if (typeof adapter.finalizeLifecycle === 'function') {
    const started = monotonic();
    try {
      result.finalization = normalizeResult(await adapter.finalizeLifecycle(cell), started, monotonic());
      if (result.finalization.status === 'FAIL') result.status = 'FAIL';
      else if (result.finalization.status !== 'PASS' && result.status !== 'FAIL') result.status = 'INCONCLUSIVE';
      result.missing.push(...result.finalization.missing);
    } catch (error) {
      result.finalization = { status: error?.code === 'CAMPAIGN_PREREQUISITE' ? 'INCONCLUSIVE' : 'FAIL', error: errorRecord(error), elapsedMs: monotonic() - started };
      if (result.finalization.status === 'FAIL') result.status = 'FAIL';
      else if (result.status !== 'FAIL') result.status = 'INCONCLUSIVE';
      result.missing.push('Lifecycle final byte proof did not complete');
    }
    await context.trace({ event: 'lifecycle-finalization', observation: result.finalization });
  }
  try { result.sampling = await adapter.resourceSamplingEvidence?.() ?? null; }
  catch (error) {
    // A late sampler failure must not discard the already observed B0/cycles
    // or their real timings. The retained series is still useful evidence, but
    // cannot qualify without its complete allocation/process sampling record.
    result.sampling = null; result.samplingError = errorRecord(error);
    if (error?.code === 'CAMPAIGN_PREREQUISITE') {
      if (result.status !== 'FAIL') result.status = 'INCONCLUSIVE';
      result.missing.push(error.message);
    } else result.status = 'FAIL';
  }
  await context.trace({ event: 'lifecycle-sampling', sampling: result.sampling, error: result.samplingError ?? null });
  result.endMs = monotonic(); result.elapsedMs = result.endMs - result.startMs;
  result.phases.push({ name: 'lifecycle.complete-series', startMs: result.startMs, endMs: result.endMs, durationMs: result.elapsedMs });
  if (result.cycles.length !== cycles && result.status !== 'FAIL') result.status = 'INCONCLUSIVE';
  return result;
}

export async function runWorker(spec, injectedFactory = null) {
  if (process.versions.node !== '26.10.0' && !injectedFactory) throw Error('Use pinned Node 26.10.0');
  if (!spec?.cell || !['cold', 'warm', 'single'].includes(spec.cache) || !Array.isArray(spec.attempts) || !spec.attempts.length) throw Error('Malformed campaign worker specification');
  const journal = await createJournal(join(spec.output, 'events.jsonl')), controller = new AbortController();
  const receipt = { kind: spec.kind === 'perf-byte-audit-group-1' ? 'perf-byte-audit-group-1' : 'perf-campaign-process-1', schemaVersion: 1, cell: spec.cell, cache: spec.cache, processIdentity: { pid: process.pid, startedAt: new Date().toISOString(), node: process.version }, startedAt: new Date().toISOString(), status: 'INCONCLUSIVE', preparation: null, attempts: [], cleanup: null };
  const context = { repo: spec.repo ?? REPO, subjectRepo: spec.subjectRepo ?? spec.repo ?? REPO, browserCache: spec.browserCache ?? null, timingLease: spec.timingLease ?? null, rendererIdentity: spec.rendererIdentity ?? null, output: spec.output, fixture: spec.fixture ?? null, configuration: spec.configuration ?? {}, signal: controller.signal, trace: event => journal.append(event), processIdentity: receipt.processIdentity, wait: intervalWait };
  let adapter;
  const abort = () => controller.abort(Error('Campaign interrupted'));
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  try {
    await journal.append({ event: 'process-start', cellId: spec.cell.id, processIdentity: receipt.processIdentity });
    adapter = injectedFactory ? await injectedFactory(context) : await makeAdapter(spec, context);
    if (typeof adapter.execute !== 'function' && typeof adapter.runCell === 'function') adapter.execute = adapter.runCell.bind(adapter);
    if (typeof adapter.execute !== 'function' && spec.cell.kind !== 'lifecycle') throw new PrerequisiteError('Driver has no executable cell action');
    receipt.preparation = adapter.prepareCell ? await adapter.prepareCell(spec.cell) : null;
    await journal.append({ event: 'cell-prepared', preparation: receipt.preparation });
    for (const planned of spec.attempts) {
      const attempt = { id: attemptIdentity(spec.cell, spec.cache, planned.ordinal, planned.prime), cache: spec.cache, ordinal: planned.ordinal, prime: planned.prime, status: 'INCONCLUSIVE', reset: null, result: null };
      receipt.attempts.push(attempt);
      await journal.append({ event: 'attempt-start', attempt });
      try {
        const resetStart = monotonic();
        attempt.reset = adapter.resetCell ? await adapter.resetCell(spec.cell, { cache: spec.cache, ordinal: planned.ordinal, prime: planned.prime }) : null;
        attempt.resetElapsedMs = monotonic() - resetStart;
        if (!attempt.reset && spec.cell.kind !== 'lifecycle' && spec.cell.kind !== 'audit' && spec.cell.kind !== 'setup') throw new PrerequisiteError('A scored start needs explicit cache/reset evidence');
        const resetStatus = attempt.reset?.status === undefined ? null : normalized(attempt.reset.status);
        if (resetStatus && resetStatus !== 'PASS') throw resetStatus === 'FAIL' ? Error('Required cache/reset failed') : new PrerequisiteError('Required cache/reset evidence is incomplete', attempt.reset);
        attempt.startMs = monotonic();
        await journal.append({ event: 'attempt-action-start', id: attempt.id, startMs: attempt.startMs, reset: attempt.reset, resetElapsedMs: attempt.resetElapsedMs });
        const value = spec.cell.kind === 'lifecycle' ? await runLifecycle(spec.cell, adapter, context) : await adapter.execute(spec.cell, { cache: spec.cache, ordinal: planned.ordinal, prime: planned.prime, signal: controller.signal });
        attempt.endMs = monotonic(); attempt.result = normalizeResult(value, attempt.startMs, attempt.endMs); attempt.elapsedMs = attempt.endMs - attempt.startMs; attempt.status = attempt.result.status;
      } catch (error) {
        attempt.endMs = monotonic(); attempt.elapsedMs = attempt.startMs === undefined ? 0 : attempt.endMs - attempt.startMs;
        attempt.status = error?.code === 'CAMPAIGN_PREREQUISITE' ? 'INCONCLUSIVE' : 'FAIL'; attempt.error = errorRecord(error);
      }
      await journal.append({ event: 'attempt-end', attempt });
      if (attempt.status !== 'PASS') break;
    }
    receipt.status = receipt.attempts.some(attempt => attempt.status === 'FAIL') ? 'FAIL' : receipt.attempts.length === spec.attempts.length && receipt.attempts.every(attempt => attempt.status === 'PASS') ? 'PASS' : 'INCONCLUSIVE';
  } catch (error) { receipt.error = errorRecord(error); receipt.status = error?.code === 'CAMPAIGN_PREREQUISITE' || error?.code === 'ERR_MODULE_NOT_FOUND' ? 'INCONCLUSIVE' : 'FAIL'; }
  finally {
    try { receipt.cleanup = await adapter?.close?.(); await journal.append({ event: 'process-cleanup', cleanup: receipt.cleanup }); }
    catch (error) { receipt.cleanupError = errorRecord(error); receipt.status = 'FAIL'; }
    receipt.finishedAt = new Date().toISOString();
    await journal.append({ event: 'process-end', status: receipt.status }); await journal.close();
    await exclusiveJSON(join(spec.output, 'receipt.json'), sanitize(receipt));
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Worker requires exactly one sealed specification file');
  const spec = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const result = await runWorker(spec); process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 2;
}

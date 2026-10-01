import assert from 'node:assert/strict';
import { intervalWait, monotonic, PrerequisiteError, fileIdentity } from './common.mjs';
import { acceptedCommand, numeric, openDocument, publicRead, ready } from './browser-driver.mjs';
import { fastManifest } from './backend-queue.mjs';

export const queueBrowserOperations = Object.freeze(['fast.workflow', 'queue.fault', 'queue.healthy-polling']);
export function queueBrowserScenario(cell) {
  const p = cell.parameters ?? {}, fast = cell.operation === 'fast.workflow';
  const manifest = fastManifest.find(item => item.caseId === p.caseId);
  const faults = { WF13: 'lost-ack', WF14: 'reconnect', WF15: 'cancel', WF16: 'late-result' };
  return { fast, manifest: manifest ?? { speed: 'BALANCED', expansion: 'None', width: 512, height: 512, count: 1, format: 'png' }, scenario: fast ? manifest ? 'valid' : faults[p.caseId] ?? 'invalid' : p.scenario ?? 'healthy-polling' };
}
export async function selectQueueResultFiles(cell, fixture) {
  const spec = queueBrowserScenario(cell), corpus = fixture?.corpus?.files ?? [];
  if (spec.scenario === 'invalid') return [];
  const files = [];
  if (spec.fast && spec.scenario === 'valid') {
    for (let index = 0; index < spec.manifest.count; index++) {
      const matches = corpus.filter(file => file.role === 'fast-candidate' && file.width === spec.manifest.width && file.height === spec.manifest.height && file.format === spec.manifest.format && file.index === index);
      if (matches.length !== 1) throw new PrerequisiteError('Exact sealed WF result format, dimensions, index and count are required');
      files.push(matches[0]);
    }
  } else {
    const selected = corpus.find(file => ['candidate-result', 'candidate', 'fast-fault-candidate'].includes(file.role) && Number(file.byteLength) === 8 * 1024 * 1024);
    if (!selected) throw new PrerequisiteError('Fault workflows require a sealed actual 8 MiB image, never an opaque transfer fixture');
    files.push(selected);
  }
  for (const file of files) {
    if (!['png', 'jpeg', 'webp'].includes(file.format) || !Number.isInteger(file.width) || !Number.isInteger(file.height)) throw new PrerequisiteError('Result image fixture metadata is incomplete');
    const identity = await fileIdentity(file.path);
    assert.equal(identity.sha256, file.sha256); assert.equal(String(identity.bytes), String(file.byteLength));
  }
  return files.map(({ path, width, height, format, index, byteLength, sha256 }) => ({ path, width, height, format, index, byteLength, sha256 }));
}
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
export async function showQueueJob(page, jobId) {
  await click(page, 'Refresh durable queue');
  const first = page.getByRole('button', { name: 'First retained jobs', exact: true });
  if (await first.count() === 1 && await first.isEnabled()) {
    await first.click(); await page.locator('#queue-page-status').filter({ hasText: /^Page 1:/ }).waitFor({ state: 'visible' });
  }
  const card = page.locator('#durable-queue > en-card').filter({ hasText: 'Job ' + jobId + ':' });
  const visited = new Set();
  for (let index = 0; index < 501; index++) {
    if (await card.count() === 1) return card;
    const jobs = page.locator('#durable-queue > en-card');
    const keys = await jobs.evaluateAll(nodes => nodes.map(node => /^Job ([^:]+):/.exec(node.querySelector('p')?.textContent ?? '')?.[1]).filter(Boolean));
    const key = keys.join('\0');
    if (visited.has(key)) throw new PrerequisiteError('Public queue pagination did not retain a new page');
    visited.add(key);
    const next = page.getByRole('button', { name: 'Next retained jobs', exact: true });
    if (await next.count() !== 1 || !await next.isEnabled()) throw Error('The durable job is absent from public queue pagination');
    await next.click();
    await page.waitForFunction(previous => {
      const keys = [...document.querySelectorAll('#durable-queue > en-card')].map(node => /^Job ([^:]+):/.exec(node.querySelector('p')?.textContent ?? '')?.[1]).filter(Boolean);
      return keys.join('\0') !== previous;
    }, key);
  }
  throw new PrerequisiteError('Queue pagination exceeded the fixed metadata envelope');
}
async function allJobs(page) {
  const jobs = []; let cursor = '';
  do { const value = await publicRead(page, '/api/v1/queue' + (cursor ? '?after=' + encodeURIComponent(cursor) : '')); jobs.push(...value.jobs); cursor = value.nextCursor ?? ''; if (jobs.length > 10000) throw Error('Queue witness exceeds sealed metadata envelope'); } while (cursor);
  return jobs;
}
async function until(work, accept, signal, timeout = 30000) {
  const start = monotonic();
  for (;;) { signal?.throwIfAborted(); const value = await work(); if (accept(value)) return value; if (monotonic() - start > timeout) throw Error('Queue workflow observation deadline'); await intervalWait(25, signal); }
}

export async function runQueueBrowserCell({ page, cell, fixture, server, controls, signal }) {
  const scenario = queueBrowserScenario(cell), phases = [], missing = [], milestones = [];
  if (scenario.scenario === 'invalid') {
    const { runFastRejection } = await import('./browser-fast-rejections.mjs');
    return runFastRejection({ page, cell, fixture, controls, signal });
  }
  const mark = (name, observation = {}) => milestones.push({ name, observedMs: monotonic(), presentedMs: null, ...observation });
  const timed = async (name, work) => { const row = { name, startMs: monotonic() }; phases.push(row); try { return await work(); } finally { row.endMs = monotonic(); row.durationMs = row.endMs - row.startMs; } };
  if (['backend-restart', 'disk-full-admission', 'invalid'].includes(scenario.scenario)) throw new PrerequisiteError('Browser ' + scenario.scenario + ' requires its separate persistent emulator/fault fixture; no substitute run is counted');
  const initialJobs = new Set((await allJobs(page)).map(job => job.id));
  const initialEffects = await controls.read();
  const submissionCount = value => value.counts.submissions - initialEffects.counts.submissions;
  const originalDocument = await publicRead(page, '/api/v1/documents/' + fixture.documentId);
  await controls.set({ paused: false, status: 'IN_QUEUE', dropAcknowledgement: scenario.scenario === 'lost-ack', mediaStatus: 200, offline: false, holdMedia: false });
  const manifest = scenario.manifest;
  await timed('browser.request-seed-review-accept', async () => {
    await page.getByRole('combobox', { name: 'Operation', exact: true }).selectOption(scenario.fast ? 'Generate with Fast' : 'Generate image');
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Sealed local campaign request');
    for (const [name, value] of [['Rendering speed', manifest.speed], ['Expansion', manifest.expansion], ['Output format', manifest.format], ['Request size', 'custom']]) await page.getByRole('combobox', { name, exact: true }).selectOption(value);
    for (const [name, value] of [['Output width', manifest.width], ['Output height', manifest.height], ['Output count', manifest.count]]) await numeric(page, name, value);
    await page.getByRole('textbox', { name: 'Exact seed (empty means Random)', exact: true }).fill('900719925474099312345');
    await click(page, 'Acknowledge prompt guidance and possible rewriting');
    if (scenario.fast) await click(page, 'Keep acceleration inactive in this draft');
    await click(page, 'Review current request document'); await click(page, 'Review exact request'); await click(page, 'Accept this exact review locally');
  });
  mark('submit-intent');
  const queued = await timed('browser.request-enqueue-to-durable-receipt', () => acceptedCommand(page, 'QueueInference', () => click(page, 'Enqueue accepted request'), signal));
  mark('seeded-state', { commandId: queued.commandId });
  const job = await until(() => allJobs(page), jobs => jobs.some(job => !initialJobs.has(job.id)), signal).then(jobs => jobs.find(job => !initialJobs.has(job.id)));
  const jobNow = () => allJobs(page).then(jobs => jobs.find(item => item.id === job.id));
  const acknowledged = await until(jobNow, job => ['acknowledged', 'submission-uncertain', 'provider-terminal'].includes(job?.attempts.at(-1)?.state), signal);
  const attemptId = acknowledged.attempts.at(-1).id;
  assert.equal(acknowledged.attempts.length, 1);
  const candidates = () => publicRead(page, '/api/v1/jobs/' + job.id + '/candidates?attempt=' + attemptId);
  let card = await showQueueJob(page, job.id);
  if (scenario.scenario === 'lost-ack') {
    assert.equal(acknowledged.attempts.at(-1).state, 'submission-uncertain');
    await card.getByText(/submission-uncertain/).first().waitFor({ state: 'visible' }); mark('uncertain-outcome');
    await intervalWait(200, signal); assert.equal(submissionCount(await controls.read()), 1);
  } else {
    if (scenario.scenario === 'browser-restart' || scenario.scenario === 'reconnect') {
      // Actual browser navigation retains the browser process; this is reload
      // recovery. A fresh browser process is separately required by the cell.
      await page.reload(); await ready(page); await openDocument(page, fixture);
      card = await showQueueJob(page, job.id); await card.getByRole('button', { name: 'Check existing request ' + attemptId, exact: true }).click();
      if (scenario.scenario === 'browser-restart') missing.push('This specimen exercised real page reload; full browser-process restart requires an external retained-server owner');
    }
    if (['duplicate-status', 'out-of-order-status'].includes(scenario.scenario)) {
      await controls.set({ status: 'IN_PROGRESS' }); await until(candidates, value => value.observation?.phase === 'running', signal);
      const before = (await controls.read()).counts.status;
      await controls.set({ status: scenario.scenario === 'duplicate-status' ? 'IN_PROGRESS' : 'IN_QUEUE' });
      await until(() => controls.read(), value => value.counts.status > before, signal);
      assert.equal((await candidates()).observation.phase, 'running'); mark('monotonic-running-state');
    }
    if (['cancel', 'cancel-late-result'].includes(scenario.scenario)) {
      mark('cancel-intent');
      card = await showQueueJob(page, job.id);
      await timed('browser.cancel-intent-to-durable-receipt', () => acceptedCommand(page, 'CancelJob', () => card.getByRole('button', { name: 'Request cancellation ' + attemptId, exact: true }).click(), signal));
      mark('cancel-requested'); await until(() => controls.read(), value => value.counts.cancel > 0, signal);
      card = await showQueueJob(page, job.id); await card.getByText('Cancellation requested; work may still finish.', { exact: true }).waitFor({ state: 'visible' });
    }
    if (scenario.scenario === 'healthy-polling') {
      const started = monotonic(); await intervalWait(10000, signal); mark('healthy-poll-window', { startMs: started, endMs: monotonic() });
    }
    if (scenario.scenario === 'offline-completion') {
      await page.context().setOffline(true);
      try { await controls.set({ status: 'COMPLETED' }); await until(() => controls.read(), value => value.counts.media > 0, signal); }
      finally { await page.context().setOffline(false); }
      await page.reload(); await ready(page); await openDocument(page, fixture); card = await showQueueJob(page, job.id); mark('reconnected');
    }
    if (scenario.scenario !== 'cancel') {
      const late = ['cancel-late-result', 'late-result'].includes(scenario.scenario);
      const authority = await controls.set({ status: 'COMPLETED', mediaStatus: scenario.scenario === 'expiry' ? 410 : 200, holdMedia: late });
      if (late) {
        try {
          await until(candidates, value => value.observation?.phase === 'completed' && !value.items.some(item => item.state === 'prepared'), signal);
          card = await showQueueJob(page, job.id); await card.getByRole('button', { name: 'Inspect retained results', exact: true }).click();
          await card.getByText('Late result available; retrieving and verifying owned image bytes.', { exact: true }).waitFor({ state: 'visible' });
          mark('late-availability-detected', { authorityClock: 'backend-worker-performance-milliseconds', authorityPublishedMs: authority.controlPublishedAtMs, independentlyObserved: true });
        } finally { await controls.set({ holdMedia: false }); }
      }
      const result = await until(candidates, value => value.items.length === manifest.count && value.items.every(item => item.state === (scenario.scenario === 'expiry' ? 'transfer-failed' : 'prepared')), signal);
      card = await showQueueJob(page, job.id); await card.getByRole('button', { name: 'Inspect retained results', exact: true }).click();
      await card.getByText(scenario.scenario === 'expiry' ? /transfer-failed/ : /Prepared image retained/).first().waitFor({ state: 'visible' });
      mark('owned-candidate', { candidates: result.items.map(item => ({ id: item.id, state: item.state, assetId: item.preparedAssetId ?? null })) });
    }
  }
  const latest = await jobNow(), effects = await controls.read();
  assert.equal(latest.attempts.length, 1); assert.equal(submissionCount(effects), 1); assert.deepEqual(effects.failures, []);
  assert.deepEqual((await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value.image, originalDocument.projection.value.image);
  return { status: missing.length ? 'INCONCLUSIVE' : 'PASS', phases, observations: { jobId: job.id, attemptId, scenario: scenario.scenario, caseId: cell.parameters?.caseId, manifest, effects, effectBaseline: initialEffects.counts, submissionsForThisSample: submissionCount(effects), milestones, independentHBackend: true, realNetwork: 'literal-loopback-emulator', physicalProviderCalls: 0, automaticRetries: 0 }, assertions: [{ name: 'one immutable attempt and one emulator submission', passed: true }, { name: 'returned outputs did not adopt pixels', passed: true }], missing };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { intervalWait, monotonic, PrerequisiteError, fileIdentity } from './common.mjs';
import { acceptedCommand, numeric, openDocument, publicRead, ready } from './browser-driver.mjs';
import { fastManifest } from './backend-queue.mjs';
import { verifyQueueProcessRestart, verifyQueueRestartRecovery } from './browser-queue-faults.mjs';
import { rejectedDraftMeasurement } from './browser-queue-measurements.mjs';
import { reorderQueueForFixture } from './browser-queue-order.mjs';

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

async function retainedRequestDraft(page, review) {
  if (!review?.draft?.sessionId || !review.draft.draftId || !review.draftAsset) throw new PrerequisiteError('Exact durable request-review draft identity is unavailable');
  const checkpoint = await publicRead(page, '/api/v1/ui/' + review.draft.sessionId);
  const saved = checkpoint.drafts.filter(draft => draft.id === review.draft.draftId);
  assert.equal(saved.length, 1); assert.equal(saved[0].generation, review.draft.generation); assert.equal(saved[0].assetId, review.draftAsset); assert.equal(saved[0].status, 'saved-unapplied');
  const asset = (await publicRead(page, '/api/v1/assets/' + review.draftAsset)).projection.value;
  const content = await page.evaluate(async ({ id, expected }) => {
    const response = await fetch('/api/v1/assets/' + id + '/content', { headers: { 'X-App-Client': 'LP-1' }, credentials: 'same-origin' });
    if (!response.ok || Number(response.headers.get('content-length')) !== Number(expected.byteLength) || Number(expected.byteLength) > 1024 * 1024) throw Error('Bounded durable draft witness unavailable');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== Number(expected.byteLength)) throw Error('Durable draft content length changed');
    return { byteLength: String(bytes.byteLength), hash: 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''), privateText: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }, { id: review.draftAsset, expected: asset.blob });
  assert.equal(content.hash, asset.blob.hash);
  const prompt = await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue();
  return { sessionId: checkpoint.sessionId, draft: saved[0], checkpoint, blob: asset.blob, actualBytes: content, privatePrompt: prompt, visiblePrompt: { hash: 'sha256:' + createHash('sha256').update(prompt).digest('hex'), byteLength: String(Buffer.byteLength(prompt)), characters: [...prompt].length } };
}

const canonicalState = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function retainedDraftProof(draft) {
  const full = canonicalState(draft.checkpoint);
  return { draftId: draft.draft.id, generation: draft.draft.generation, assetId: draft.draft.assetId, blob: draft.blob, rawHash: draft.actualBytes.hash,
    state: { kind: 'complete-saved-ui-sha256-1', hash: 'sha256:' + createHash('sha256').update(full).digest('hex'), byteLength: String(Buffer.byteLength(full)), complete: true, visiblePrompt: draft.visiblePrompt } };
}

async function runAdmissionRejection({ page, cell, fixture, controls, signal, timed, mark, phases, manifest }) {
  const review = JSON.parse(await page.locator('#request-review pre').textContent());
  const beforeDraft = await retainedRequestDraft(page, review), beforeJobs = await allJobs(page), beforeQueue = await publicRead(page, '/api/v1/queue');
  const beforeEffects = await controls.read(), beforeDocument = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
  let pressure, released, rejection, failure;
  try {
    const control = await controls.set({ paused: true, storagePressure: true }); pressure = control.storagePressure;
    if (pressure?.kind !== 'real-object-reservation-pressure-1' || pressure.active !== true || pressure.actualAdmissionRefused !== true || BigInt(pressure.held.reservedBytes) <= BigInt(pressure.before.reservedBytes)) throw new PrerequisiteError('Actual writer storage reservation pressure was not established');
    mark('capacity-admission-input');
    rejection = await timed('browser.capacity-admission-to-durable-rejection', async () => {
      let enqueueCommands = 0;
      const observedRequest = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/commands') { try { if (request.postDataJSON()?.command?.body?.type === 'QueueInference') enqueueCommands++; } catch {} } };
      page.on('request', observedRequest);
      try {
      const response = page.waitForResponse(value => {
        if (value.request().method() !== 'POST' || new URL(value.url()).pathname !== '/api/v1/commands') return false;
        try { return value.request().postDataJSON()?.command?.body?.type === 'QueueInference'; } catch { return false; }
      });
      response.catch(() => {}); await click(page, 'Enqueue accepted request');
      const reply = await response, command = reply.request().postDataJSON().command;
      assert.equal(command.body.reviewId, review.id); assert.equal(command.body.token, review.token);
      const immediate = await reply.json();
      const result = immediate.receipt ? immediate : await until(() => publicRead(page, '/api/v1/commands/' + command.commandId), value => !!value.receipt, signal);
      assert.equal(result.receipt.status, 'rejected'); assert.equal(result.receipt.code, 'CAPACITY'); assert.equal(result.receipt.commandId, command.commandId);
      assert.equal(result.rejectionDetails?.kind, 'inline');
      assert(result.rejectionDetails.value?.issues?.some(issue => issue.code === 'QUEUE_METADATA_ADMISSION'), 'A different capacity refusal cannot stand in for actual storage admission');
      await page.locator('#request-errors').filter({ hasText: /CAPACITY/ }).waitFor({ state: 'visible' });
      assert.equal(enqueueCommands, 1, 'Rejection action submitted more than one enqueue command');
      return { commandId: command.commandId, reviewId: review.id, status: 'rejected', code: 'CAPACITY', reason: 'QUEUE_METADATA_ADMISSION', enqueueCommands, valid: true };
      } finally { page.off('request', observedRequest); }
    });
    assert.equal(canonicalState(await retainedRequestDraft(page, review)) === canonicalState(beforeDraft), true, 'Capacity rejection lost or changed the saved request draft or visible prompt');
    assert.equal(canonicalState(await allJobs(page)) === canonicalState(beforeJobs), true, 'Capacity rejection changed durable jobs or attempts');
    assert.deepEqual((await publicRead(page, '/api/v1/queue')).counts, beforeQueue.counts, 'Capacity rejection changed spend or active counts');
    assert.deepEqual((await publicRead(page, '/api/v1/queue')).session, beforeQueue.session);
    assert.equal((await controls.read()).counts.submissions, beforeEffects.counts.submissions, 'Capacity rejection reached the provider');
    mark('capacity-rejection-visible', { commandId: rejection.commandId });
  } catch (error) { failure = error; } finally {
    // The same real reservation API must admit the queue bound after release.
    try { released = (await controls.set({ paused: true, storagePressure: false })).storagePressure; }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Capacity specimen and reservation cleanup failed') : error; }
  }
  try {
  if (failure) throw failure;
  if (!released || released.active !== false || released.actualAdmissionRecovered !== true) throw new PrerequisiteError('Real writer admission did not recover after reservation release');
  assert.equal(released.after.reservedBytes, pressure.before.reservedBytes);
  await intervalWait(200, signal);
  const effects = await controls.read(), document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
  assert.deepEqual(effects.failures, []); assert.equal(effects.counts.submissions, beforeEffects.counts.submissions);
  const afterDraft = await retainedRequestDraft(page, review);
  assert.equal(canonicalState(await allJobs(page)) === canonicalState(beforeJobs), true, 'Capacity rejection changed durable queue'); assert.equal(canonicalState(afterDraft) === canonicalState(beforeDraft), true, 'Capacity rejection changed private authored draft state'); assert.equal(canonicalState(document) === canonicalState(beforeDocument), true, 'Capacity rejection changed document');
  const rejectedDraftProof = { kind: 'rejected-draft-preservation-1', receipt: rejection, before: retainedDraftProof(beforeDraft), after: retainedDraftProof(afterDraft), comparison: { completeSavedUI: true, actualDraftText: true, visiblePrompt: true, equal: true } };
  const translated = rejectedDraftMeasurement({ cell, proof: rejectedDraftProof });
  if (!translated.measurement) throw new PrerequisiteError(translated.reason);
  return { status: 'PASS', phases, measurements: [translated.measurement], observations: { scenario: 'disk-full-admission', manifest, rejection,
    draft: retainedDraftProof(beforeDraft), rejectedDraftProof, rejectedDraftLossCount: 0, document: { id: fixture.documentId, revision: document.revision, unchanged: true }, storagePressure: released,
    effects: { queuedJobsAdded: 0, attemptsAdded: 0, enqueueCommands: rejection.enqueueCommands, submissions: 0, before: beforeEffects.counts, after: effects.counts },
    physicalProviderCalls: 0, automaticRetries: 0, fault: 'reservation-admission exhaustion; no physical ENOSPC injection', physicalPresentationClaim: false },
    assertions: [{ name: 'actual writer reservation budget rejects enqueue without changing draft, jobs, attempts or spend counts', passed: true }, { name: 'release restores actual queue reservation admission without retrying or submitting a request', passed: true }], missing: [] };
  } catch (error) {
    error.observations = { scenario: 'disk-full-admission', rejection: rejection ?? null, storagePressure: released ?? pressure ?? null, draftBefore: retainedDraftProof(beforeDraft), effectBaseline: beforeEffects.counts, qualification: false };
    throw error;
  }
}

export async function runQueueBrowserCell({ page, cell, fixture, server, controls, signal, services = {} }) {
  const scenario = queueBrowserScenario(cell), phases = [], missing = [], milestones = [];
  if (scenario.scenario === 'invalid') {
    const { runFastRejection } = await import('./browser-fast-rejections.mjs');
    return runFastRejection({ page, cell, fixture, controls, signal });
  }
  const progress = { scenario: scenario.scenario, caseId: cell.parameters?.caseId, phases, milestones, qualification: false };
  try {
  const mark = (name, observation = {}) => milestones.push({ name, observedMs: monotonic(), presentedMs: null, ...observation });
  const timed = async (name, work) => { const row = { name, startMs: monotonic() }; phases.push(row); try { return await work(); } finally { row.endMs = monotonic(); row.durationMs = row.endMs - row.startMs; } };
  if (['backend-restart', 'browser-restart'].includes(scenario.scenario) && typeof services[scenario.scenario === 'backend-restart' ? 'restartBackend' : 'restartBrowser'] !== 'function') throw new PrerequisiteError('The exact owned process restart capability is unavailable; no reload substitute is permitted');
  const initialJobs = new Set((await allJobs(page)).map(job => job.id));
  const initialEffects = await controls.read();
  const submissionCount = value => value.counts.submissions - initialEffects.counts.submissions;
  const originalDocument = await publicRead(page, '/api/v1/documents/' + fixture.documentId);
  const fixturePause = { kind: 'fixture-scheduler-drain-1', productPauseClaim: false, requestedMs: monotonic(), clock: 'campaign-runner-performance-milliseconds' };
  const drained = await controls.set({ paused: true, storagePressure: false, status: 'IN_QUEUE', dropAcknowledgement: scenario.scenario === 'lost-ack', mediaStatus: 200, offline: false, holdMedia: false });
  assert.equal(drained.quiescent, true);
  Object.assign(fixturePause, { pausedObservedMs: monotonic(), workerIdentity: drained.workerIdentity, controlSequence: drained.controlSequence });
  progress.fixturePause = fixturePause;
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
  if (scenario.scenario === 'disk-full-admission') return await runAdmissionRejection({ page, cell, fixture, controls, signal, timed, mark, phases, manifest });
  mark('submit-intent');
  const actualEnqueue = page.waitForRequest(request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/v1/commands') return false;
    try { return request.postDataJSON()?.command?.body?.type === 'QueueInference'; } catch { return false; }
  });
  actualEnqueue.catch(() => {});
  const queued = await timed('browser.request-enqueue-to-durable-receipt', () => acceptedCommand(page, 'QueueInference', () => click(page, 'Enqueue accepted request'), signal));
  const { clientId, sessionId, expectedEntityVersions } = (await actualEnqueue).postDataJSON().command;
  mark('seeded-state', { commandId: queued.commandId });
  const job = await until(() => allJobs(page), jobs => jobs.some(job => !initialJobs.has(job.id)), signal).then(jobs => jobs.find(job => !initialJobs.has(job.id)));
  const jobNow = () => allJobs(page).then(jobs => jobs.find(item => item.id === job.id));
  progress.jobId = job.id;
  const queueSetup = await timed('fixture.public-adjacent-queue-setup', () => reorderQueueForFixture({ page, jobId: job.id, provenance: { clientId, sessionId, expectedEntityVersions }, controls, signal }));
  progress.queueSetup = queueSetup;
  mark('oldest-waiting-order-observed', { commandId: queueSetup.eligibilityCommandId ?? queued.commandId, authoritativeClockClaim: false });
  fixturePause.resumeRequestedMs = monotonic();
  const resumed = await controls.set({ paused: false });
  fixturePause.resumedObservedMs = monotonic(); fixturePause.resumeControlSequence = resumed.controlSequence;
  phases.push({ name: 'fixture.scheduler-drain', startMs: fixturePause.requestedMs, endMs: fixturePause.resumedObservedMs, durationMs: fixturePause.resumedObservedMs - fixturePause.requestedMs, boundary: 'Actual fixture scheduler drain request through resume acknowledgement; includes all request setup and public adjacent reorder overhead; not a product pause' });
  const acknowledged = await until(jobNow, job => ['acknowledged', 'submission-uncertain', 'provider-terminal'].includes(job?.attempts.at(-1)?.state), signal);
  const attemptId = acknowledged.attempts.at(-1).id;
  Object.assign(progress, { jobId: job.id, attemptId });
  assert.equal(acknowledged.attempts.length, 1);
  const candidates = () => publicRead(page, '/api/v1/jobs/' + job.id + '/candidates?attempt=' + attemptId);
  let card = await showQueueJob(page, job.id), restart = null;
  if (scenario.scenario === 'lost-ack') {
    assert.equal(acknowledged.attempts.at(-1).state, 'submission-uncertain');
    await card.getByText(/submission-uncertain/).first().waitFor({ state: 'visible' }); mark('uncertain-outcome');
    await intervalWait(200, signal); assert.equal(submissionCount(await controls.read()), 1);
  } else {
    if (['browser-restart', 'backend-restart'].includes(scenario.scenario)) {
      const target = scenario.scenario === 'backend-restart' ? 'backend' : 'browser', beforeEffects = await controls.read();
      const beforeJob = await jobNow(), service = target === 'backend' ? services.restartBackend : services.restartBrowser;
      const replacement = await timed('browser.' + target + '-process-restart', () => service({ jobId: job.id, attemptId, providerIdentity: beforeEffects.providerIdentity }));
      const witness = verifyQueueProcessRestart(replacement?.witness, target, beforeEffects.providerIdentity);
      if (!replacement?.page || replacement.page.isClosed()) throw new PrerequisiteError('Restart did not return the actual replacement/reconnected public page');
      page = replacement.page;
      await ready(page); await openDocument(page, fixture);
      const restored = await jobNow(); verifyQueueRestartRecovery(beforeJob, restored, beforeEffects, await controls.read());
      card = await showQueueJob(page, job.id);
      if (target === 'backend') {
        assert.equal(restored.attempts[0].recoveryRequired, true, 'Restart did not require explicit existing-request recovery');
        const prior = await controls.read();
        assert.equal(prior.ownershipRestored, true, 'Replacement writer lost exact fixture attempt ownership');
        await intervalWait(200, signal);
        assert.deepEqual((await controls.read()).counts, prior.counts, 'Backend recovery performed network work before explicit public recovery');
      }
      const beforeRecovery = await controls.read(); mark('existing-request-recovery-input', { target });
      const receipt = await timed('browser.existing-request-recovery-to-durable-receipt', () => acceptedCommand(page, 'RecoverJob', () => card.getByRole('button', { name: 'Check existing request ' + attemptId, exact: true }).click(), signal));
      await until(() => controls.read(), value => value.counts.status > beforeRecovery.counts.status, signal);
      restart = { witness, receipt, recovery: verifyQueueRestartRecovery(beforeJob, await jobNow(), beforeEffects, await controls.read()) };
      mark('existing-request-recovery-observed', { target, commandId: receipt.commandId });
    }
    if (scenario.scenario === 'reconnect') {
      const navigation = async () => {
        await page.reload(); await ready(page); await openDocument(page, fixture);
        card = await showQueueJob(page, job.id); await card.getByRole('button', { name: 'Check existing request ' + attemptId, exact: true }).click();
      };
      if (services.compositionObservation) await services.compositionObservation.navigation(navigation); else await navigation();
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
      const navigation = async () => {
        await page.reload(); await ready(page); await openDocument(page, fixture); card = await showQueueJob(page, job.id); mark('reconnected');
      };
      if (services.compositionObservation) await services.compositionObservation.navigation(navigation); else await navigation();
    }
    if (scenario.scenario !== 'cancel') {
      const late = ['cancel-late-result', 'late-result'].includes(scenario.scenario);
      const authority = await controls.set({ status: 'COMPLETED', mediaStatus: scenario.scenario === 'expiry' ? 410 : 200, holdMedia: late });
      if (late) {
        try {
          await until(candidates, value => value.observation?.phase === 'completed' && !value.items.some(item => item.state === 'prepared'), signal);
          card = await showQueueJob(page, job.id); await card.getByRole('button', { name: 'Inspect retained results', exact: true }).click();
          await card.getByText('Late result available; retrieving and verifying owned image bytes.', { exact: true }).waitFor({ state: 'visible' });
          mark('late-availability-detected', { authorityClock: authority.controlClock ?? 'backend-worker-performance-milliseconds', authorityPublishedMs: authority.controlPublishedAtMs, independentlyObserved: true });
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
  return { status: missing.length ? 'INCONCLUSIVE' : 'PASS', phases, observations: { jobId: job.id, attemptId, scenario: scenario.scenario, caseId: cell.parameters?.caseId, manifest, effects, effectBaseline: initialEffects.counts, submissionsForThisSample: submissionCount(effects), milestones, restart, queueSetup, fixturePause, independentHBackend: true, realNetwork: 'literal-loopback-emulator', physicalProviderCalls: 0, automaticRetries: 0 }, assertions: [{ name: 'one immutable attempt and one emulator submission', passed: true }, { name: 'returned outputs did not adopt pixels', passed: true }, ...(restart ? [{ name: 'native process replaced, exact existing attempt explicitly recovered without resubmission', passed: true }] : [])], missing };
  } catch (error) { error.observations = { ...progress, ...(error.observations ?? {}) }; throw error; }
}

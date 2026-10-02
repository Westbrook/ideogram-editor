// Deliberate public protocol setup. These are not browser gestures or product
// pause controls. The fixture scheduler is drained by the caller throughout.
import assert from 'node:assert/strict';
import { publicRead } from './browser-driver.mjs';
import { intervalWait, monotonic, PrerequisiteError } from './common.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const version = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
export function publicQueueMove(view, jobId) {
  if (!id(jobId) || !version(view?.orderVersion) || !Array.isArray(view.jobs) || !view.waiting) throw new PrerequisiteError('Actual public versioned waiting order is required');
  const job = view.jobs.find(item => item.id === jobId), waiting = view.waiting[jobId];
  if (!job || !version(job.version) || !Number.isSafeInteger(waiting?.position) || waiting.position < 1 || job.attempts?.length !== 1 || job.attempts[0].state !== 'not-started' || job.attempts[0].hold || !['none', 'released'].includes(job.attempts[0].count)) throw new PrerequisiteError('The scenario must remain an actual unreserved waiting job during setup');
  if (waiting.position === 1) {
    if (waiting.previous !== null) throw new PrerequisiteError('Oldest waiting proof has a contradictory predecessor');
    return null;
  }
  const previous = waiting.previous, neighbor = view.jobs.find(item => item.id === previous?.id);
  if (!id(previous?.id) || !version(previous.version) || !neighbor || neighbor.version !== previous.version || view.waiting[neighbor.id]?.position !== waiting.position - 1) throw new PrerequisiteError('Exact current adjacent waiting neighbor is required');
  return { type: 'ReorderLocalQueue', jobId, expectedVersion: job.version, neighborId: neighbor.id, expectedNeighborVersion: neighbor.version, expectedOrderVersion: view.orderVersion, direction: 'up' };
}

async function readOrder(page, signal) {
  const jobs = [], waiting = {}, cursors = new Set(); let after = '', first;
  do {
    signal?.throwIfAborted();
    if (cursors.has(after) || cursors.size >= 501) throw new PrerequisiteError('Public waiting inventory exceeded its bounded stable pages');
    cursors.add(after);
    const value = await publicRead(page, '/api/v1/queue' + (after ? '?after=' + encodeURIComponent(after) : ''));
    if (!first) first = value;
    if (value.orderVersion !== first.orderVersion || value.orderEpoch !== first.orderEpoch || value.totalJobs !== first.totalJobs) throw new PrerequisiteError('Public waiting order changed during the drained setup read');
    jobs.push(...value.jobs); Object.assign(waiting, value.waiting); after = value.nextCursor ?? '';
  } while (after);
  assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length); assert.equal(jobs.length, first.totalJobs);
  return { jobs, waiting, orderVersion: first.orderVersion, orderEpoch: first.orderEpoch };
}

async function adjacentCommand(page, provenance, body, signal) {
  const startedMs = monotonic();
  const submitted = await page.evaluate(async ({ provenance, body }) => {
    // CSRF remains inside the browser realm and never enters the evidence.
    const sessionReply = await fetch('/api/v1/session', { headers: { 'X-App-Client': 'LP-1' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (!sessionReply.ok) throw Error('Public queue setup session unavailable');
    const session = await sessionReply.json();
    if (session.clientId !== provenance.clientId || typeof session.csrfToken !== 'string') throw Error('Public queue setup owner changed');
    const commandId = crypto.randomUUID();
    const command = { schemaVersion: 1, commandId, clientId: provenance.clientId, sessionId: provenance.sessionId,
      correlationId: crypto.randomUUID(), causationId: null, transactionId: crypto.randomUUID(), documentId: null,
      expectedDocumentRevision: null, expectedEntityVersions: provenance.expectedEntityVersions, issuedAt: new Date().toISOString(), body };
    const response = await fetch('/api/v1/commands', { method: 'POST', headers: { 'X-App-Client': 'LP-1', 'X-App-CSRF': session.csrfToken, 'Content-Type': 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: JSON.stringify({ protocolVersion: 1, command }) });
    if (!response.ok) throw Error('Public adjacent queue command refused at HTTP boundary: ' + response.status);
    const value = await response.json();
    return { commandId, receipt: value.receipt ?? null };
  }, { provenance, body });
  let receipt = submitted.receipt;
  while (!receipt) {
    signal?.throwIfAborted();
    if (monotonic() - startedMs > 30000) throw new PrerequisiteError('Public adjacent queue command durable receipt deadline');
    await intervalWait(10, signal); receipt = (await publicRead(page, '/api/v1/commands/' + submitted.commandId)).receipt;
  }
  assert.equal(receipt.commandId, submitted.commandId); assert.equal(receipt.status, 'accepted', 'Public adjacent reorder was rejected');
  return { body, commandId: submitted.commandId, receipt, inputMs: startedMs, receiptObservedMs: monotonic(), clock: 'campaign-runner-performance-milliseconds' };
}

export async function reorderQueueForFixture({ page, jobId, provenance, controls, signal }) {
  if (!id(provenance?.clientId) || !id(provenance.sessionId) || !provenance.expectedEntityVersions) throw new PrerequisiteError('Actual enqueue command public provenance is required');
  const beforeControl = await controls.read();
  if (beforeControl.quiescent !== true) throw new PrerequisiteError('Fixture scheduler must be explicitly drained before protocol queue setup');
  const initial = await readOrder(page, signal), moves = [], initialPosition = initial.waiting[jobId]?.position;
  let view = initial;
  try {
  if (!Number.isSafeInteger(initialPosition) || initialPosition > 10000) throw new PrerequisiteError('Scenario waiting position is outside the fixed fixture envelope');
  for (;;) {
    const body = publicQueueMove(view, jobId);
    if (!body) break;
    if (moves.length >= initialPosition - 1) throw new PrerequisiteError('Adjacent queue setup did not make exact bounded progress');
    moves.push(await adjacentCommand(page, provenance, body, signal));
    const next = await readOrder(page, signal);
    assert.equal(next.waiting[jobId]?.position, view.waiting[jobId].position - 1, 'Accepted reorder failed to move exactly one waiting neighbor');
    view = next;
  }
  const afterControl = await controls.read();
  assert.equal(afterControl.quiescent, true); assert.deepEqual(afterControl.counts, beforeControl.counts, 'Fixture setup performed provider work while drained');
  assert.equal(moves.length, initialPosition - 1);
  return { kind: 'public-adjacent-queue-setup-1', protocolSetup: true, uiGestureClaim: false, fixtureSchedulerDrainOnly: true,
    jobId, initialPosition, finalPosition: 1, initialOrderVersion: initial.orderVersion, finalOrderVersion: view.orderVersion, moves,
    eligibilityCommandId: moves.at(-1)?.commandId ?? null, eligibilityReceipt: moves.at(-1)?.receipt ?? null,
    eligibilityObservedMs: moves.at(-1)?.receiptObservedMs ?? null,
    eligibilityBoundary: 'Final accepted public neighbor reorder makes the actual scenario job oldest; observer receipt time is diagnostic and cannot replace the authoritative writer commit marker',
    noProviderWork: true, countsBefore: beforeControl.counts, countsAfter: afterControl.counts };
  } catch (error) {
    error.observations = { ...(error.observations ?? {}), queueSetup: { kind: 'public-adjacent-queue-setup-1', protocolSetup: true, uiGestureClaim: false, fixtureSchedulerDrainOnly: true, jobId, initialPosition, moves, qualification: false } };
    throw error;
  }
}

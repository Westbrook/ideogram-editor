// A warm reset is a real product workflow in the retained writer. It never
// rewrites SQLite, replaces an open root, or treats deletion as erased history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auth, encode, envelope, phase } from './backend-common.mjs';

const unsettled = new Set(['not-started', 'dispatching', 'acknowledged', 'submission-uncertain']);
const failure = (message, code = 'FIXTURE_REQUIRED') => Object.assign(Error(message), { code });
const abort = context => context.signal?.throwIfAborted();

async function jobs(writer, signal) {
  const values = [], ids = new Set(), cursors = new Set();
  let cursor = '';
  do {
    signal?.throwIfAborted();
    if (cursors.has(cursor)) throw failure('Queue pagination repeated a cursor', 'WARM_RESET_INVALID');
    cursors.add(cursor);
    const page = await writer.queueView(cursor);
    assert(Array.isArray(page.jobs), 'Queue view must include real jobs');
    for (const job of page.jobs) {
      assert(!ids.has(job.id), 'Queue pagination must not duplicate a job');
      ids.add(job.id); values.push(job);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

async function currentJob(writer, id, signal) {
  const job = (await jobs(writer, signal)).find(value => value.id === id);
  assert(job, 'Previously observed queue job must remain durable');
  return job;
}

async function command(writer, body, context, phases, receipts) {
  abort(context);
  const request = envelope(body);
  const receipt = await phase(phases, 'warm-reset.' + body.type, async () => {
    const value = await writer.queueCommand(encode(request), auth());
    assert.equal(value?.status, 'accepted', JSON.stringify(value));
    return value;
  });
  receipts.push({ commandId: request.command.commandId, body, receipt });
  return receipt;
}

function endpoint(job) {
  assert(typeof job.review?.endpoint === 'string' && job.review.endpoint.length > 0, 'Attempt must retain its reviewed endpoint');
  return job.review.endpoint;
}

function owns(snapshot, job, attempt) {
  // Enrollment alone is not evidence of a submitted request. The bridge records
  // its own successful submit invocation even if the HTTP acknowledgment drops.
  return Array.isArray(snapshot?.submittedJobIds) && snapshot.submittedJobIds.includes(job.id)
    && Array.isArray(snapshot.submittedAttemptIds) && snapshot.submittedAttemptIds.includes(attempt.id)
    && (!attempt.requestId || Array.isArray(snapshot.requestIds) && snapshot.requestIds.includes(attempt.requestId));
}

async function observeKnown(f, writer, context, phases, job, attempt, terminalStatus) {
  const observed = await phase(phases, 'warm-reset.known-request-terminal-observation', () => f.queueWorker.observeStatus(job.id, attempt.id, terminalStatus));
  const after = await currentJob(writer, job.id, context.signal), terminal = after.attempts.find(value => value.id === attempt.id);
  assert.equal(terminal.hold, false, 'Actual terminal evidence must release the known request hold');
  assert.equal(terminal.state, 'provider-terminal');
  assert.equal(terminal.terminal, terminalStatus.toLowerCase());
  return { jobId: job.id, attemptId: attempt.id, knownRequestId: attempt.requestId, outcome: 'observed-loopback-' + terminalStatus.toLowerCase(), observed };
}

async function collectDeleted(writer, documentId, context, phases, receipts) {
  await command(writer, { type: 'CollectDocumentGarbage', documentId }, context, phases, receipts);
  const deletion = (await writer.deletionView(documentId, auth())).receipt;
  assert(deletion?.accepted, 'Keep the actual deletion/cleanup receipt');
  if (deletion.status !== 'cleanup-complete' || deletion.pendingBytes !== '0') throw failure('Warm reset cannot reseed while actual document garbage collection remains pending');
  return deletion;
}

/** Cancel and reconcile only the prior document, then delete it through its
 * current public preview. Uncertain loopback submissions keep their uncertainty;
 * the explicit risk acknowledgment releases only their local scheduling hold.
 * This helper does not claim that cancellation prevents work or refunds charges.
 */
export async function disposeWarmDocument(f, context = {}, phases = []) {
  abort(context);
  const writer = f.writer, documentId = f.documentId, receipts = [], reconciliations = [];
  const initial = (await jobs(writer, context.signal)).filter(job => job.documentId === documentId);
  const document = await writer.document(documentId);
  if (!document) {
    assert(!initial.some(job => job.attempts.some(attempt => attempt.hold)), 'A missing warm document must not retain an unresolved active hold');
    assert(initial.every(job => job.disposition === 'deleted' && job.attempts.every(attempt => attempt.state !== 'not-started')), 'A missing document must not leave eligible queue work');
    const previous = (await writer.deletionView(documentId, auth())).receipt;
    // A prior attempt may have committed deletion and then refused because GC
    // was busy. Missing projection is not proof that its cleanup completed.
    const deletion = previous ? await collectDeleted(writer, documentId, context, phases, receipts) : null;
    assert.equal(f.writer, writer, 'Warm cleanup must retain the same LocalWriter capability');
    return { documentId, existed: false, receipts, reconciliations, deleted: !!deletion, deletion,
      retainedJobs: initial.length, resumedDeletion: !!previous };
  }
  // Validate every external ownership dependency before changing even the first
  // queued job. A copied seed may retain an unavailable earlier emulator URL.
  for (const job of initial) for (const attempt of job.attempts) {
    if (!attempt.hold || attempt.state === 'not-started') continue;
    if (!f.queueWorker?.snapshot) throw failure('A retained loopback provider controller is required to reconcile the warm sample');
    const snapshot = await f.queueWorker.snapshot(endpoint(job));
    if (!owns(snapshot, job, attempt)) throw failure('Warm reset cannot reconcile an attempt from a different provider lifetime: ' + attempt.id);
    if (attempt.requestId && snapshot.controls?.status === 'FAILED') throw failure('The fixture must expose a product-supported failed-terminal response before warm reconciliation');
    if (!['acknowledged', 'submission-uncertain'].includes(attempt.state)) throw failure('Wait for the bridge-owned dispatch to settle before warm reset: ' + attempt.id);
    const required = attempt.requestId ? ['configure', 'observeStatus'] : ['configure', 'tick', 'closeNamespace'];
    if (required.some(name => typeof f.queueWorker[name] !== 'function')) throw failure('The loopback bridge lacks the required real reconciliation or namespace-close capability');
  }
  for (const original of initial) for (const [attemptIndex, originalAttempt] of original.attempts.entries()) {
    abort(context);
    // Each distinct job is protected by its observed expectedVersion at the
    // public command boundary. Avoid rereading all 1,000 WQ jobs for each row;
    // only a subsequent attempt in the same changed job needs a fresh version.
    let job = attemptIndex === 0 ? original : await currentJob(writer, original.id, context.signal);
    let attempt = job.attempts.find(value => value.id === originalAttempt.id);
    assert(attempt, 'Observed attempt identity is immutable');
    if (attempt.state === 'not-started') {
      await command(writer, { type: 'CancelJob', jobId: job.id, attemptId: attempt.id, expectedVersion: job.version }, context, phases, receipts);
      continue;
    }
    if (!attempt.hold) continue;
    await command(writer, { type: 'CancelJob', jobId: job.id, attemptId: attempt.id, expectedVersion: job.version }, context, phases, receipts);
    job = await currentJob(writer, job.id, context.signal); attempt = job.attempts.find(value => value.id === attempt.id);
    if (attempt.recoveryRequired || !attempt.requestId) {
      await command(writer, { type: 'RecoverJob', jobId: job.id, attemptId: attempt.id, expectedVersion: job.version }, context, phases, receipts);
      job = await currentJob(writer, job.id, context.signal); attempt = job.attempts.find(value => value.id === attempt.id);
    }
    const route = endpoint(job);
    const beforeReconciliation = await f.queueWorker.snapshot(route);
    const terminalStatus = beforeReconciliation.controls?.status === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED';
    await phase(phases, 'warm-reset.loopback-terminal-control', () => f.queueWorker.configure(route, { status: terminalStatus, offline: false, jobIds: [job.id] }));
    if (attempt.requestId) {
      reconciliations.push(await observeKnown(f, writer, context, phases, job, attempt, terminalStatus));
    } else {
      assert.equal(attempt.state, 'submission-uncertain', 'Only an uncertain submission permits an explicit local risk override');
      await phase(phases, 'warm-reset.inspect-uncertain-submission', () => f.queueWorker.tick(route));
      job = await currentJob(writer, job.id, context.signal); attempt = job.attempts.find(value => value.id === attempt.id);
      const before = await f.queueWorker.snapshot(route);
      assert(owns(before, job, attempt), 'Uncertain submission must still belong to this retained loopback provider');
      // Recovery can discover an exact acknowledgment already retained by the
      // writer. That is a known request now; never close its provider namespace
      // or issue the uncertainty-only override using an earlier projection.
      if (attempt.requestId) {
        if (attempt.state === 'provider-terminal' && !attempt.hold) {
          assert(['completed', 'failed', 'cancelled'].includes(attempt.terminal));
          reconciliations.push({ jobId: job.id, attemptId: attempt.id, knownRequestId: attempt.requestId,
            outcome: 'recovered-loopback-' + attempt.terminal, recovery: before });
        } else reconciliations.push(await observeKnown(f, writer, context, phases, job, attempt, terminalStatus));
        continue;
      }
      assert.equal(attempt.state, 'submission-uncertain', 'Recovery must leave a real uncertain attempt before an override');
      // Closing its exact emulator namespace is not a fabricated provider
      // identifier or status acknowledgment. The durable uncertainty stays.
      if (typeof f.queueWorker.closeNamespace !== 'function') throw failure('The loopback bridge must close the exact uncertain namespace before releasing its local hold');
      const closure = await phase(phases, 'warm-reset.close-uncertain-loopback-namespace', () => f.queueWorker.closeNamespace(route));
      assert.equal(closure?.closed, true, 'Uncertain loopback namespace must actually close before a local risk override');
      job = await currentJob(writer, job.id, context.signal);
      await command(writer, { type: 'OverrideUncertainHold', jobId: job.id, attemptId: attempt.id, expectedVersion: job.version,
        acknowledgeOverlapAndChargeRisk: true }, context, phases, receipts);
      const after = await currentJob(writer, job.id, context.signal), uncertain = after.attempts.find(value => value.id === attempt.id);
      assert.equal(uncertain.state, 'submission-uncertain'); assert.equal(uncertain.requestId, null); assert.equal(uncertain.hold, false);
      reconciliations.push({ jobId: job.id, attemptId: attempt.id, outcome: 'uncertainty-retained-local-hold-explicitly-overridden', closure,
        remoteStatusKnown: false, actualChargeKnown: false, submittedAgain: false });
    }
  }
  const settled = (await jobs(writer, context.signal)).filter(job => job.documentId === documentId);
  assert(settled.every(job => job.attempts.every(attempt => !attempt.hold && attempt.state !== 'not-started')), 'Every previous sample hold and queued submission must be inactive before deletion');
  const revision = await writer.documentRevision(documentId);
  await command(writer, { type: 'PreviewDocumentDeletion', documentId, expectedRevision: revision }, context, phases, receipts);
  const view = await writer.deletionView(documentId, auth()), plan = view.plan;
  assert(plan?.documentId === documentId && plan.documentRevision === revision, 'Deletion requires the current exact preview');
  await command(writer, { type: 'DeleteDocument', documentId, planId: plan.id, planHash: plan.planHash,
    rootGeneration: plan.rootGeneration, expectedRevision: plan.documentRevision,
    acknowledgeRunningAndUncertain: plan.unresolvedAttempts.length > 0 }, context, phases, receipts);
  assert.equal(await writer.document(documentId), null, 'Accepted deletion must remove the old document projection');
  const deletion = await collectDeleted(writer, documentId, context, phases, receipts);
  const retained = (await jobs(writer, context.signal)).filter(job => job.documentId === documentId);
  assert(retained.every(job => job.disposition === 'deleted' && job.attempts.every(attempt => !attempt.hold)), 'Deleted sample queue history remains inert');
  assert.equal(f.writer, writer, 'Warm cleanup must retain the same LocalWriter capability');
  return { documentId, existed: true, deleted: true, receipts, reconciliations, deletion,
    retainedJobs: retained.length, unresolvedHistoricalAttempts: retained.flatMap(job => job.attempts).filter(attempt => unsettled.has(attempt.state)).length };
}

/** Reset receipt separates successful operational preparation from qualification
 * eligibility: global event and queue history correctly survive a warm reset.
 * The caller must carry qualification.missing into its measured result.
 */
export async function resetWarmProductFixture(f, context, cell, sample = {}) {
  abort(context);
  assert.equal(sample.cache, 'warm', 'Retained-writer reset is only a warm cohort operation');
  assert.equal(typeof f.setDocumentId, 'function', 'Fixture must allow selecting its new document identity');
  const writer = f.writer, epoch = writer.epoch, root = f.root, phases = [];
  const workload = cell.workload === 'WF' ? 'W0' : cell.workload;
  if (!['W0', 'WQ'].includes(workload)) throw failure('Retained-writer reset currently requires W0/WF or WQ; other workloads need a bridge-owned active/native seed');
  if (workload === 'WQ' && typeof f.queueWorker?.setSnapshotBoundary !== 'function') throw failure('The retained writer must expose its fixture-only recovery scheduling controller before a WQ reset');
  const corpus = context.fixture?.corpus ?? { files: [] };
  const { planProductFixture, buildProductFixture } = await import('./fixture-product.mjs');
  planProductFixture({ workload, corpus });
  const before = await phase(phases, 'warm-reset.capture-before', () => writer.capture());
  const disposal = await disposeWarmDocument(f, context, phases);
  if (f.queueWorker) await phase(phases, 'warm-reset.clear-settled-loopback-fixture', () => f.queueWorker.resetFixture());
  const retainedJobs = await jobs(writer, context.signal), currentSession = (await writer.queueView('')).session, sessionReceipts = [];
  assert(retainedJobs.every(job => job.attempts.every(attempt => !attempt.hold)), 'A warm reseed cannot overlap another document active hold');
  assert(currentSession?.id && Object.hasOwn(currentSession, 'cap'), 'Warm reseed must retain the real prior spend-session configuration');
  await command(writer, { type: 'StartSpendSession', previousSessionId: currentSession.id, cap: currentSession.cap,
    acknowledgeUnresolvedAttempts: retainedJobs.some(job => job.attempts.some(attempt => attempt.state === 'submission-uncertain')) }, context, phases, sessionReceipts);
  const baseline = await phase(phases, 'warm-reset.capture-after-disposal', () => writer.capture());
  const documentId = 'warm_' + workload.toLowerCase() + '_' + randomUUID().replaceAll('-', '');
  // Keep the identity before the first reseed mutation. If preparation fails,
  // the next reset cleans this partial document instead of forgetting it.
  f.setDocumentId(documentId);
  const rebuilt = await phase(phases, 'warm-reset.full-production-reseed', () => buildProductFixture({
    root, writer, repo: context.repo, documentId, workload, corpus, allowHeavy: true, signal: context.signal,
    retainedWriter: { baselineHighWater: baseline.highWater,
      snapshotBoundaryController: async ({ writer: selected, boundary }) => {
        assert.equal(selected, writer, 'Snapshot scheduling must belong to the same retained writer');
        await f.queueWorker.setSnapshotBoundary(boundary);
        return () => f.queueWorker.setSnapshotBoundary(null);
      } },
    onProgress: detail => context.trace?.({ event: 'warm-fixture-preparation', ...detail }),
  }));
  assert.equal(f.writer, writer, 'Warm reseed must not replace the LocalWriter');
  assert.equal(writer.epoch, epoch, 'Warm reseed must not restart the product writer epoch');
  assert.equal(rebuilt.documentId, documentId, 'Reseed must retain its new exact document identity');
  assert.equal(rebuilt.preparation?.retainedWriter, true, 'Reseed must explicitly attest it did not own or restart the writer');
  assert(rebuilt.criteria.every(row => row.met), 'Actual reseeded workload must satisfy every per-sample criterion');
  const after = await phase(phases, 'warm-reset.capture-after-reseed', () => writer.capture());
  const missing = ['Same-writer reset retains earlier global event and queue history; this is an accumulated-workspace diagnostic cohort, not the canonical fresh global inventory'];
  const value = { cellId: cell.id ?? cell.operation, status: 'pass', phases, assertions: [{ name: 'Real public cancellation, reconciliation, deletion, collection, and full reseed retain one LocalWriter', passed: true }],
    observations: { root, previousDocumentId: disposal.documentId, documentId, sample, writerEpoch: epoch,
      writerWorkerRestarted: false, directSQLWrites: false, oldRootOverwritten: false, operatingSystemPageCache: 'not purged or inferred',
      globalHighWater: { before: before.highWater, afterDisposal: baseline.highWater, afterReseed: after.highWater },
      disposal, spendSessionReset: sessionReceipts, rebuilt }, evidence: [], missing: [], qualification: { status: 'inconclusive', missing } };
  f.context.fixture = { ...context.fixture, ...rebuilt, corpus, resetQualification: value.qualification };
  return value;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { disposeWarmDocument, resetWarmProductFixture } from '../../tooling/qualification/campaigns/backend-reset.mjs';

const copy = value => structuredClone(value);
function queued(id, state = 'not-started', documentId = 'old_document') {
  return { id, documentId, version: '1', disposition: 'eligible', review: { endpoint: 'ideogram/v4' },
    attempts: [{ id: id + '_attempt', state, hold: ['acknowledged', 'submission-uncertain', 'dispatching'].includes(state),
      requestId: state === 'acknowledged' ? 'request_' + id : null, terminal: null, recoveryRequired: false }] };
}

// Deliberately strict protocol model: commands must name the currently observed
// version and current deletion preview. These tests exercise reset refusal and
// orchestration. They are not product performance or real provider evidence.
function fixture(values = [], options = {}) {
  const state = { jobs: copy(values), commands: [], bridge: [], document: { id: 'old_document', revision: '7' },
    receipt: null, plan: null, mutation: 0, pageCalls: [], rejected: options.rejected };
  const writer = {
    epoch: '29', root: '/unused/warm',
    queueView: async cursor => {
      state.pageCalls.push(cursor);
      const start = cursor ? Number(cursor) : 0, limit = options.pageSize ?? 2;
      return { jobs: copy(state.jobs.slice(start, start + limit)), nextCursor: start + limit < state.jobs.length ? String(start + limit) : null };
    },
    document: async id => id === state.document?.id ? copy(state.document) : null,
    documentRevision: async () => state.document.revision,
    deletionView: async () => ({ plan: copy(state.plan), receipt: copy(state.receipt) }),
    queueCommand: async bytes => {
      const request = JSON.parse(Buffer.from(bytes)), body = request.command.body;
      state.commands.push(copy(body));
      if (body.type === state.rejected) return { status: 'rejected', code: 'STALE_REVISION' };
      const job = state.jobs.find(value => value.id === body.jobId), attempt = job?.attempts.find(value => value.id === body.attemptId);
      if (job) {
        assert.equal(body.expectedVersion, job.version);
        assert(attempt);
        if (body.type === 'CancelJob') {
          job.disposition = 'cancel-requested'; attempt.cancel = 'requested';
          if (attempt.state === 'not-started') { attempt.state = 'locally-cancelled'; attempt.hold = false; }
        } else if (body.type === 'RecoverJob') { attempt.recoveryRequested = true; attempt.recoveryRequired = false; }
        else if (body.type === 'OverrideUncertainHold') {
          assert.equal(attempt.state, 'submission-uncertain'); assert.equal(body.acknowledgeOverlapAndChargeRisk, true);
          assert(state.bridge.includes('closeNamespace'), 'The exact loopback namespace must close before the local risk override');
          attempt.hold = false; attempt.override = true;
        } else assert.fail('Unexpected modeled job command');
        job.version = String(BigInt(job.version) + 1n);
      } else if (body.type === 'PreviewDocumentDeletion') {
        assert.equal(body.expectedRevision, state.document.revision);
        state.plan = { id: 'current_plan', documentId: state.document.id, documentRevision: state.document.revision,
          rootGeneration: 'root_generation_' + state.mutation, planHash: 'exact_plan_hash',
          unresolvedAttempts: state.jobs.filter(job => job.documentId === state.document.id).flatMap(job => job.attempts).filter(attempt => attempt.state === 'submission-uncertain').map(attempt => attempt.id) };
      } else if (body.type === 'DeleteDocument') {
        const plan = state.plan;
        assert.equal(body.planId, plan.id); assert.equal(body.planHash, plan.planHash);
        assert.equal(body.rootGeneration, plan.rootGeneration); assert.equal(body.expectedRevision, plan.documentRevision);
        assert.equal(body.acknowledgeRunningAndUncertain, plan.unresolvedAttempts.length > 0);
        for (const job of state.jobs.filter(job => job.documentId === state.document.id)) job.disposition = 'deleted';
        state.document = null; state.receipt = { accepted: true, status: 'cleanup-pending', actualFreedBytes: '0', pendingBytes: '16' };
      } else if (body.type === 'CollectDocumentGarbage') {
        if (!options.cleanupPending) state.receipt = { ...state.receipt, status: 'cleanup-complete', actualFreedBytes: '16', pendingBytes: '0' };
        options.afterCollect?.(f);
      } else assert.fail('Unexpected modeled document command');
      state.mutation++;
      return { status: 'accepted', commandId: request.command.commandId, fromSeq: String(state.mutation), toSeq: String(state.mutation) };
    },
  };
  const f = { root: writer.root, documentId: 'old_document', writer, context: {}, setDocumentId(id) { this.documentId = id; } };
  f.queueWorker = {
    snapshot: async () => ({ controls: { status: options.providerStatus ?? 'IN_QUEUE' }, submittedJobIds: options.unowned ? [] : state.jobs.map(job => job.id),
      submittedAttemptIds: options.submittedAttemptIds ?? state.jobs.flatMap(job => job.attempts.map(attempt => attempt.id)),
      requestIds: state.jobs.flatMap(job => job.attempts.map(attempt => attempt.requestId)).filter(Boolean) }),
    configure: async (route, controls) => { state.bridge.push('configure'); assert.equal(route, 'ideogram/v4'); assert.equal(controls.status, options.providerStatus === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED'); },
    observeStatus: async (id, attemptId, status) => {
      state.bridge.push('observeStatus'); assert.equal(status, options.providerStatus === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED');
      const job = state.jobs.find(job => job.id === id), attempt = job.attempts.find(attempt => attempt.id === attemptId);
      if (!options.leaveHeld) { attempt.hold = false; attempt.state = 'provider-terminal'; attempt.terminal = status.toLowerCase(); job.version = String(BigInt(job.version) + 1n); }
      return { outcome: 'complete', evidence: 'modeled-status-only' };
    },
    tick: async () => {
      state.bridge.push('tick');
      if (options.recoverKnown) {
        const job = state.jobs[0], attempt = job.attempts[0];
        attempt.requestId = 'recovered_request'; attempt.state = options.recoverTerminal ? 'provider-terminal' : 'acknowledged';
        if (options.recoverTerminal) { attempt.hold = false; attempt.terminal = 'cancelled'; }
        job.version = String(BigInt(job.version) + 1n);
      }
    },
    closeNamespace: async () => { state.bridge.push('closeNamespace'); return { closed: true, requestsRetained: true }; },
  };
  return { f, state };
}

test('warm cleanup traverses all pages, deactivates only the prior document, and preserves queue history', async () => {
  const { f, state } = fixture([queued('one'), queued('two'), queued('other', 'not-started', 'other_document')], { pageSize: 1 });
  const phases = [], receipt = await disposeWarmDocument(f, {}, phases);
  assert.deepEqual(state.commands.map(value => value.type), ['CancelJob', 'CancelJob', 'PreviewDocumentDeletion', 'DeleteDocument', 'CollectDocumentGarbage']);
  assert.equal(state.jobs.length, 3); assert.equal(state.jobs[2].attempts[0].state, 'not-started');
  assert.equal(state.jobs[2].disposition, 'eligible'); assert.equal(receipt.retainedJobs, 2);
  assert.equal(receipt.deletion.actualFreedBytes, '16'); assert.equal(receipt.deleted, true);
  assert(state.pageCalls.includes('2')); assert.equal(f.documentId, 'old_document');
  assert(phases.every(span => span.outcome === 'completed' && span.durationMs >= 0));
});

test('known loopback cancellation needs actual terminal observation before deleting the document', async () => {
  const { f, state } = fixture([queued('known', 'acknowledged')]);
  const receipt = await disposeWarmDocument(f);
  assert.deepEqual(state.bridge, ['configure', 'observeStatus']);
  assert.equal(state.jobs[0].attempts[0].state, 'provider-terminal');
  assert.equal(receipt.reconciliations[0].outcome, 'observed-loopback-cancelled');
  assert.equal(state.commands.some(command => command.type === 'OverrideUncertainHold'), false);
});

test('an already completed fixture outcome is observed without rewriting it as cancelled', async () => {
  const { f, state } = fixture([queued('known', 'acknowledged')], { providerStatus: 'COMPLETED' });
  const receipt = await disposeWarmDocument(f);
  assert.equal(state.jobs[0].attempts[0].terminal, 'completed');
  assert.equal(receipt.reconciliations[0].outcome, 'observed-loopback-completed');
});

test('an unsupported failed-terminal fixture response is not replaced with invented cancellation evidence', async () => {
  const { f, state } = fixture([queued('known', 'acknowledged')], { providerStatus: 'FAILED' });
  await assert.rejects(disposeWarmDocument(f), /failed-terminal response/); assert.deepEqual(state.commands, []);
});

test('a copied active provider lifetime rejects before changing even an earlier queued job', async () => {
  const { f, state } = fixture([queued('local'), queued('foreign', 'acknowledged')], { unowned: true });
  await assert.rejects(disposeWarmDocument(f), { code: 'FIXTURE_REQUIRED' });
  assert.deepEqual(state.commands, []); assert.deepEqual(state.bridge, []); assert(state.document);
});

test('lost acknowledgment keeps its durable uncertainty and uses only an explicit local hold override', async () => {
  const { f, state } = fixture([queued('uncertain', 'submission-uncertain')]);
  const receipt = await disposeWarmDocument(f);
  assert.deepEqual(state.commands.map(command => command.type), ['CancelJob', 'RecoverJob', 'OverrideUncertainHold', 'PreviewDocumentDeletion', 'DeleteDocument', 'CollectDocumentGarbage']);
  assert.deepEqual(state.bridge, ['configure', 'tick', 'closeNamespace']);
  const retained = state.jobs[0].attempts[0];
  assert.equal(retained.requestId, null); assert.equal(retained.state, 'submission-uncertain'); assert.equal(retained.hold, false);
  assert.equal(receipt.unresolvedHistoricalAttempts, 1);
  assert.equal(receipt.reconciliations[0].remoteStatusKnown, false); assert.equal(receipt.reconciliations[0].submittedAgain, false);
});

test('an uncertain submission cannot be overridden without a bridge namespace-close capability', async () => {
  const { f, state } = fixture([queued('uncertain', 'submission-uncertain')]); delete f.queueWorker.closeNamespace;
  await assert.rejects(disposeWarmDocument(f), /lacks the required/);
  assert.deepEqual(state.commands, []);
});

for (const terminal of [false, true]) test('recovery rereads an uncertain attempt that becomes ' + (terminal ? 'terminal' : 'known') + ' without closing its provider namespace', async () => {
  const { f, state } = fixture([queued('uncertain', 'submission-uncertain')], { recoverKnown: true, recoverTerminal: terminal });
  const receipt = await disposeWarmDocument(f);
  assert.equal(state.bridge.includes('closeNamespace'), false);
  assert.equal(state.commands.some(body => body.type === 'OverrideUncertainHold'), false);
  assert.equal(state.jobs[0].attempts[0].requestId, 'recovered_request');
  assert.equal(state.jobs[0].attempts[0].hold, false);
  assert.equal(receipt.reconciliations[0].outcome, terminal ? 'recovered-loopback-cancelled' : 'observed-loopback-cancelled');
});

test('a submitted earlier attempt does not authenticate a different uncertain retry on the same job', async () => {
  const value = queued('retry', 'submission-uncertain');
  value.attempts.unshift({ id: 'earlier_attempt', state: 'provider-terminal', terminal: 'completed', requestId: 'earlier_request', hold: false });
  const { f, state } = fixture([value], { submittedAttemptIds: ['earlier_attempt'] });
  await assert.rejects(disposeWarmDocument(f), /different provider lifetime/);
  assert.deepEqual(state.commands, []);
});

test('cancellation acknowledgment alone never clears a real scheduling hold', async () => {
  const { f, state } = fixture([queued('known', 'acknowledged')], { leaveHeld: true });
  await assert.rejects(disposeWarmDocument(f), /terminal evidence must release/);
  assert.deepEqual(state.commands.map(command => command.type), ['CancelJob']); assert(state.document);
});

test('failed current-preview deletion prevents garbage collection and exposes the failed reset phase', async () => {
  const { f, state } = fixture([], { rejected: 'DeleteDocument' }), phases = [];
  await assert.rejects(disposeWarmDocument(f, {}, phases), /STALE_REVISION/);
  assert.equal(state.commands.some(command => command.type === 'CollectDocumentGarbage'), false);
  assert(state.document); assert.equal(f.documentId, 'old_document');
  assert.equal(phases.at(-1).outcome, 'failed');
});

test('an accepted collection with pending readers or object leases is not a completed warm reset', async () => {
  const { f, state } = fixture([], { cleanupPending: true });
  await assert.rejects(disposeWarmDocument(f), /garbage collection remains pending/);
  assert.equal(state.receipt.status, 'cleanup-pending'); assert.equal(state.receipt.pendingBytes, '16');
  await assert.rejects(disposeWarmDocument(f), /garbage collection remains pending/);
  assert.equal(state.commands.filter(command => command.type === 'CollectDocumentGarbage').length, 2);
});

test('a retry with an already deleted document resumes real collection before accepting cleanup', async () => {
  const options = { cleanupPending: true }, { f, state } = fixture([], options);
  await assert.rejects(disposeWarmDocument(f), /garbage collection remains pending/);
  options.cleanupPending = false;
  const receipt = await disposeWarmDocument(f);
  assert.equal(receipt.resumedDeletion, true); assert.equal(receipt.deletion.status, 'cleanup-complete');
  assert.equal(state.commands.filter(command => command.type === 'DeleteDocument').length, 1);
  assert.equal(state.commands.filter(command => command.type === 'CollectDocumentGarbage').length, 2);
});

test('an already aborted reset issues no public command and does not select another document', async () => {
  const { f, state } = fixture([queued('local')]), controller = new AbortController(); controller.abort(Error('cancelled reset'));
  await assert.rejects(disposeWarmDocument(f, { signal: controller.signal }), /cancelled reset/);
  assert.deepEqual(state.commands, []); assert.equal(f.documentId, 'old_document');
});

test('warm cleanup refuses a swapped writer even when the public deletion succeeded', async () => {
  const { f } = fixture([], { afterCollect: f => { f.writer = { epoch: '30' }; } });
  await assert.rejects(disposeWarmDocument(f), /same LocalWriter/);
});

test('a missing document is harmless only if it has no remaining hold', async () => {
  const empty = fixture(); empty.state.document = null;
  assert.equal((await disposeWarmDocument(empty.f)).existed, false);
  const held = fixture([queued('known', 'acknowledged')]); held.state.document = null;
  await assert.rejects(disposeWarmDocument(held.f), /unresolved active hold/);
});

test('unsupported warm seeds and a missing WQ snapshot controller refuse before deletion', async () => {
  const { f, state } = fixture();
  await assert.rejects(resetWarmProductFixture(f, {}, { workload: 'W1' }, { cache: 'warm' }), /requires W0\/WF or WQ/);
  await assert.rejects(resetWarmProductFixture(f, {}, { workload: 'WQ' }, { cache: 'warm' }), /recovery scheduling controller/);
  assert.deepEqual(state.commands, []); assert(state.document);
});

test('repeated queue cursors refuse instead of looping or omitting a page', async () => {
  const { f, state } = fixture(); f.writer.queueView = async () => ({ jobs: [], nextCursor: 'same' });
  await assert.rejects(disposeWarmDocument(f), { code: 'WARM_RESET_INVALID' }); assert.deepEqual(state.commands, []);
});

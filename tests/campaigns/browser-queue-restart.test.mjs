import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyQueueProcessRestart, verifyQueueRestartRecovery } from '../../tooling/qualification/campaigns/browser-queue-faults.mjs';
import { restoreBrowserQueueOwnership } from '../../tooling/qualification/campaigns/browser-queue-worker.mjs';
import { queueEffectSnapshot, mergeBrowserQueueObservations, createBrowserQueueControls } from '../../tooling/qualification/campaigns/browser-queue-provider.mjs';
import { runQueueBrowserCell } from '../../tooling/qualification/campaigns/browser-queue.mjs';

const provider = { ownerPid: 20, instance: 'fixture_1', origin: 'http://127.0.0.1:4381' };
const witness = target => ({ kind: 'queue-process-restart-1', target,
  before: { pid: 30, pgid: 30, startedAtIdentity: 'Wed Sep 30 10:00:00 2026' }, after: { pid: 31, pgid: 31, startedAtIdentity: 'Wed Sep 30 10:00:01 2026' },
  oldExited: true, oldExit: { pid: 30, code: null, signal: 'SIGKILL', observedMs: 20 },
  rootBefore: '/owned/existing', rootAfter: '/owned/existing', rootRetained: true, providerBefore: provider, providerAfter: provider,
  workerBefore: { pid: 30, threadId: 1, epoch: '4' }, workerAfter: { pid: 31, threadId: 1, epoch: '5' } });

test('queue restart requires actual native replacement, same root and persistent provider', () => {
  for (const target of ['browser', 'backend']) assert.equal(verifyQueueProcessRestart(witness(target), target, provider).physicalPresentationClaim, false);
  for (const changed of [
    value => { value.after = { ...value.before }; },
    value => { value.oldExited = false; },
    value => { value.oldExit.pid = 99; },
    value => { value.rootAfter = '/replacement-fixture'; },
    value => { value.providerAfter = { ...provider, instance: 'another' }; },
    value => { value.workerAfter.epoch = value.workerBefore.epoch; },
    value => { value.workerAfter.pid = 99; },
  ]) { const value = structuredClone(witness('backend')); changed(value); assert.throws(() => verifyQueueProcessRestart(value, 'backend', provider)); }
});

test('queue restart preserves exact attempt, request, frozen body and zero additional POST', () => {
  const job = { id: 'job_1', review: { id: 'review_1', token: 'fixed' }, attempts: [{ id: 'attempt_1', requestId: 'request_1', payloadHash: 'sha256:' + 'a'.repeat(64) }] };
  const effects = { counts: { submissions: 1 }, providerIdentity: provider, failures: [] };
  assert.deepEqual(verifyQueueRestartRecovery(job, structuredClone(job), effects, effects), { jobId: 'job_1', attemptId: 'attempt_1', requestId: 'request_1', payloadHash: job.attempts[0].payloadHash, additionalAttempts: 0, additionalSubmissions: 0 });
  for (const changed of [value => value.attempts.push({ id: 'attempt_2' }), value => { value.attempts[0].requestId = 'new_request'; }, value => { value.review.id = 'new_review'; }]) {
    const after = structuredClone(job); changed(after); assert.throws(() => verifyQueueRestartRecovery(job, after, effects, effects));
  }
  assert.throws(() => verifyQueueRestartRecovery(job, job, effects, { ...effects, counts: { submissions: 2 } }));
});

test('backend ownership restore cannot enroll a foreign or missing attempt', () => {
  const jobs = [{ id: 'initial_job', attempts: [{ id: 'initial_attempt' }] }, { id: 'owned_job', attempts: [{ id: 'owned_attempt' }] }];
  const record = { kind: 'browser-queue-ownership-1', providerIdentity: provider, initialJobIds: ['initial_job'], attempts: [{ jobId: 'owned_job', attemptId: 'owned_attempt' }] };
  const restored = restoreBrowserQueueOwnership(record, provider, jobs);
  assert.deepEqual([...restored.initial], ['initial_job']); assert.deepEqual([...restored.owned], ['owned_job']); assert.deepEqual([...restored.ownedAttempts], ['owned_job\0owned_attempt']);
  assert.throws(() => restoreBrowserQueueOwnership(record, { ...provider, instance: 'replacement' }, jobs));
  assert.throws(() => restoreBrowserQueueOwnership({ ...record, attempts: [{ jobId: 'owned_job', attemptId: 'foreign' }] }, provider, jobs));
  assert.throws(() => restoreBrowserQueueOwnership({ ...record, attempts: [{ jobId: 'initial_job', attemptId: 'initial_attempt' }] }, provider, jobs));
  assert.throws(() => restoreBrowserQueueOwnership({ ...record, attempts: [...record.attempts, ...record.attempts] }, provider, jobs));
});

test('independent provider counters survive a replacement worker snapshot', () => {
  const actual = queueEffectSnapshot([{ method: 'POST', path: '/ideogram/v4', bytes: 300, atMs: 10 }, { method: 'GET', path: '/requests/1/status', bytes: 0, atMs: 20 }, { method: 'GET', path: '/requests/1', bytes: 0, atMs: 30 }, { method: 'GET', path: '/image/1/0', bytes: 0, atMs: 40 }, { method: 'PUT', path: '/requests/1/cancel', bytes: 0, atMs: 50 }]);
  assert.deepEqual(actual.counts, { submissions: 1, status: 1, cancel: 1, result: 1, media: 1 });
  const source = { ...actual, providerIdentity: provider, heldMedia: 0, failures: [], observedAtMs: 50 };
  const worker = { providerIdentity: provider, workerIdentity: { pid: 31, threadId: 1, epoch: '5' }, counts: { submissions: 0 }, failures: [], quiescent: true, pendingTick: false, controlSequence: 4, observedAtMs: 5 };
  const result = mergeBrowserQueueObservations(source, worker);
  assert.deepEqual(result.counts, actual.counts); assert.equal(result.workerIdentity.pid, 31); assert.equal(result.workerObservedAtMs, 5); assert.equal(result.controlSequence, 4); assert.equal(result.quiescent, true);
  assert.throws(() => mergeBrowserQueueObservations(source, { ...worker, providerIdentity: { ...provider, instance: 'foreign' } }));
  assert.equal(mergeBrowserQueueObservations({ ...source, heldMedia: 1 }, worker).quiescent, false);
});

test('missing native process controls refuse before UI input rather than reload', async () => {
  for (const scenario of ['backend-restart', 'browser-restart']) await assert.rejects(runQueueBrowserCell({ page: {}, cell: { operation: 'queue.fault', parameters: { scenario } }, fixture: {} }), error => error.code === 'CAMPAIGN_PREREQUISITE' && /no reload substitute/.test(error.message));
});

test('control owner creates the paused startup file before the backend can read it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'queue-control-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { read() { throw Error('Backend must not be read during controller preparation'); }, set() { throw Error('Provider must not be activated during controller preparation'); } };
  const controls = await createBrowserQueueControls({ root, provider: owner });
  assert.equal(typeof controls.read, 'function');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'campaign-provider-control.json'), 'utf8')), { paused: true, holdMedia: false, storagePressure: false, sequence: 0 });
  await assert.rejects(createBrowserQueueControls({ root, provider: owner }), error => error.code === 'EEXIST');
});

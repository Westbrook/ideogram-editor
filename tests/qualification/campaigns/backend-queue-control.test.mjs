// These are control-channel isolation tests with a deliberately small fake
// provider. Product dispatch/observation is covered by the backend campaigns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { FAST_QUEUE_FIXTURE_FAMILIES, prepareQueueWorker, connectQueueWorker, readPrivateJSON, QUEUE_CONFIG_FILE, QUEUE_READY_FILE } from '../../../tooling/qualification/campaigns/backend-queue-control.mjs';
import { scopeQueueStore, startQueueControl } from '../../../tooling/qualification/campaigns/backend-queue-worker.mjs';

test('worker configuration is owner-only, credential-free, and rejects unsafe file aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'queue-control-config-'));
  try {
    await prepareQueueWorker(root, { repo: process.cwd(), apiKey: 'must-not-cross', environment: { FAL_KEY: 'must-not-cross' },
      fixture: { root, corpus: { files: [{ role: 'fast-fault-candidate', path: 'result.png', byteLength: String(8 * 1024 * 1024), sha256: 'sha256:' + 'a'.repeat(64), width: 512, height: 512 }] } } });
    const path = join(root, QUEUE_CONFIG_FILE), value = await readPrivateJSON(path);
    assert.match(value.nonce, /^[a-f0-9]{64}$/); assert(!JSON.stringify(value).includes('must-not-cross'));
    assert.equal(value.fixture.corpus.files[0].role, 'fast-fault-candidate'); assert.equal(value.fixture.corpus.files[0].path, join(root, 'result.png'));
    await symlink(path, join(root, 'alias.json'));
    await assert.rejects(readPrivateJSON(join(root, 'alias.json')));
    await chmod(path, 0o644); await assert.rejects(readPrivateJSON(path), /Private regular/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixture selection filters before bounded production selectors, preserving the owned job after twenty foreign jobs', () => {
  const values = Array.from({ length: 21 }, (_, i) => ({ jobId: 'job_' + i, attemptId: 'attempt_' + i }));
  const limited = eligible => values.filter(item => eligible(item.jobId, item.attemptId)).slice(0, 20);
  const store = {
    queue: { view: () => ({ jobs: values.map(item => ({ id: item.jobId })), nextCursor: null }), controlWork: limited, recoveryWork: limited },
    candidates: { due: (_now, eligible) => limited(eligible), retries: limited },
  };
  const scoped = scopeQueueStore(store, new Set(['job_20']), new Set(['job_20\0attempt_20']));
  for (const found of [scoped.queue.controlWork(), scoped.queue.recoveryWork(), scoped.candidates.due(0), scoped.candidates.retries()]) assert.deepEqual(found, [values[20]]);
  assert.equal(scoped.candidates.queue, scoped.queue);
  assert.deepEqual(scoped.queue.view().jobs, [{ id: 'job_20' }]);
});

test('an enrolled new retry never selects an older foreign attempt in the same job', () => {
  const foreign = { jobId: 'same_job', attemptId: 'old_uncertain' }, owned = { jobId: 'same_job', attemptId: 'new_retry' };
  const selected = eligible => [foreign, owned].filter(item => eligible(item.jobId, item.attemptId));
  const store = { queue: { controlWork: selected, recoveryWork: selected }, candidates: { due: (_now, eligible) => selected(eligible), retries: selected } };
  const scoped = scopeQueueStore(store, new Set(['same_job']), new Set(['same_job\0new_retry']));
  for (const rows of [scoped.queue.controlWork(), scoped.queue.recoveryWork(), scoped.candidates.due(0), scoped.candidates.retries()]) assert.deepEqual(rows, [owned]);
});

function fakeStore(root) {
  const jobs = new Map([['owned', { id: 'owned', review: { endpoint: 'ideogram/v4' }, attempts: [{ id: 'attempt_owned', state: 'not-started', hold: false, requestId: null }] }],
    ['foreign', { id: 'foreign', review: { endpoint: 'ideogram/v4' }, attempts: [{ id: 'attempt_foreign', state: 'acknowledged', hold: true, requestId: 'foreign_request' }] }]]);
  let high = '1', snapshot = null, maintains = 0;
  const store = {
    root, epoch: 'worker_epoch_1', jobs,
    queue: { view: () => ({ jobs: [...jobs.values()], nextCursor: null }), resultFence: (jobId, attemptId) => ({ jobId, attemptId }),
      controlWork: eligible => [...jobs.values()].flatMap(job => job.attempts.filter(attempt => eligible(job.id, attempt.id)).map(attempt => ({ jobId: job.id, attemptId: attempt.id }))), recoveryWork: () => [] },
    candidates: { due: (_now, eligible) => [...jobs.values()].flatMap(job => job.attempts.filter(attempt => eligible(job.id, attempt.id)).map(attempt => ({ jobId: job.id, attemptId: attempt.id }))), retries: () => [],
      observe: (fence, evidence) => ({ fence, view: { evidence } }) },
    objects: { reservationInventory: () => ({ activeTransfers: 0, reservedBytes: '0' }) },
    rasters: { diagnostics: () => ({ activeWorkers: 0 }) },
    recovery: { highWater: () => high, latest: () => snapshot, maintain() { ++maintains; snapshot = { seq: high }; }, async settle(start) { if (start) this.maintain(); } },
    setHigh: value => { high = value; }, get maintains() { return maintains; },
  };
  return store;
}

function fakeProviderFactory(record) {
  return async (_context, store, endpoint, options) => {
    record.options = options;
    const requests = new Map(), effects = [], controls = { status: 'IN_QUEUE', offline: false, mediaStatus: 200, dropAcknowledgement: false };
    const fixture = {
      origin: 'http://127.0.0.1:1', profile: { id: 'test-only', endpoint }, image: { bytes: 1 }, errors: [], requests, effects, controls,
      dispatcher: { close() {}, async submit(jobId) {
        record.active++; record.maxActive = Math.max(record.maxActive, record.active);
        await new Promise(resolve => setTimeout(resolve, 5));
        const job = store.queue.view().jobs.find(item => item.id === jobId);
        effects.push({ method: 'POST', path: '/' + endpoint, atMs: performance.now() }); requests.set('request_' + jobId, {});
        Object.assign(job.attempts.at(-1), { state: 'acknowledged', hold: true, requestId: 'request_' + jobId });
        record.active--; return job;
      }, readKnown: async (_jobId, _attemptId, kind) => ({ outcome: 'complete', evidence: { kind, status: controls.status } }) },
      observer: { close() {}, async tick() {
        record.active++; record.maxActive = Math.max(record.maxActive, record.active);
        await new Promise(resolve => setTimeout(resolve, 5));
        record.ticks.push(store.candidates.due(Date.now()).map(item => item.jobId)); record.active--;
      } },
      async close() { record.closed++; },
    };
    return fixture;
  };
}

test('authenticated control stays scoped to owned submissions and serializes commands in one writer lifetime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'queue-control-http-'));
  let close;
  try {
    const fastFiles = Array.from({ length: 4 }, (_, index) => ({ id: `wf-1024-jpeg-${index}`, role: 'fast-candidate', path: `image-${index}.jpg`, format: 'jpeg', width: 1024, height: 1024,
      index, byteLength: '1024', sha256: 'sha256:' + String(index).repeat(64) }));
    await prepareQueueWorker(root, { queueFixtureCell: { operation: 'fast.workflow', parameters: { caseId: 'WF02' } },
      fixture: { root, seal: { sha256: 'sha256:' + 'a'.repeat(64) }, corpus: { files: fastFiles, fast: { validFamilies: FAST_QUEUE_FIXTURE_FAMILIES } } } });
    const config = await readPrivateJSON(join(root, QUEUE_CONFIG_FILE));
    const store = fakeStore(root), record = { active: 0, maxActive: 0, ticks: [], closed: 0 };
    store.jobs.get('owned').attempts.unshift({ id: 'older_foreign', state: 'submission-uncertain', hold: false, requestId: null, recoveryRequested: true });
    close = await startQueueControl(store, config, { startProvider: fakeProviderFactory(record) });
    const controller = await connectQueueWorker(root), ready = JSON.parse(await readFile(join(root, QUEUE_READY_FILE), 'utf8'));
    const denied = await fetch(ready.origin + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{}' });
    assert.equal(denied.status, 403); assert.deepEqual((await controller.snapshot()).routes, []);
    await assert.rejects(controller.configure('ideogram/v4', { jobIds: ['foreign'] }), /foreign attempt/);
    await controller.configure('ideogram/v4', { jobIds: ['owned'] });
    await controller.submit('owned'); await Promise.all(Array.from({ length: 3 }, () => controller.tick('ideogram/v4')));
    assert.deepEqual(record.ticks, [['owned'], ['owned'], ['owned']]);
    const snapshot = await controller.snapshot('ideogram/v4');
    assert.equal(snapshot.resultFixture.caseId, 'WF02'); assert.equal(snapshot.resultFixture.files.length, 4);
    assert.deepEqual(record.options.resultFiles, fastFiles.map(file => ({ ...file, path: join(root, file.path) })));
    assert.deepEqual(snapshot.submittedJobIds, ['owned']); assert.deepEqual(snapshot.requestIds, ['request_owned']);
    assert.deepEqual(snapshot.submittedAttemptIds, ['attempt_owned']); assert.deepEqual(snapshot.enrolledAttemptIds, ['attempt_owned']);
    assert.equal(snapshot.lastSubmit.jobId, 'owned'); assert.equal(snapshot.lastSubmit.attemptId, 'attempt_owned');
    assert(snapshot.lastSubmit.startedMs <= snapshot.lastSubmit.postObservedMs && snapshot.lastSubmit.postObservedMs <= snapshot.lastSubmit.completedMs);
    assert(snapshot.lastConfigured.startedMs <= snapshot.lastConfigured.completedMs);
    assert(snapshot.lastTick.startedMs <= snapshot.lastTick.completedMs);
    assert.equal(snapshot.worker.epoch, store.epoch); assert.equal(record.maxActive, 1);
    await assert.rejects(controller.readKnown('foreign', 'attempt_foreign', 'status'), /not been enrolled/);
    await assert.rejects(controller.readKnown('owned', 'older_foreign', 'status'), /Attempt has not been enrolled/);
    await assert.rejects(controller.resetFixture(), /release all owned holds/);
    await controller.configure('ideogram/v4', { status: 'CANCELLED' });
    assert.equal((await controller.observeStatus('owned', 'attempt_owned', 'CANCELLED')).view.evidence.status, 'CANCELLED');
    const observedSnapshot = await controller.snapshot('ideogram/v4');
    assert.deepEqual(observedSnapshot.lastConfigured.changed, { status: 'CANCELLED' });
    assert.equal(observedSnapshot.lastStatusObservation.status, 'CANCELLED'); assert.equal(observedSnapshot.lastKnownRead.kind, 'status');
    assert(observedSnapshot.lastStatusObservation.startedMs <= observedSnapshot.lastKnownRead.startedMs
      && observedSnapshot.lastKnownRead.completedMs <= observedSnapshot.lastStatusObservation.completedMs);
    const closure = await controller.closeNamespace('ideogram/v4'); assert.equal(closure.closed, true); assert.equal(record.closed, 1);
    await assert.rejects(controller.tick('ideogram/v4'), /not open/);
    // This fake change models the separate public cleanup owner's completion.
    store.jobs.get('owned').attempts.at(-1).hold = false;
    await assert.rejects(controller.resetFixture(), /document deletion/);
    store.jobs.get('owned').disposition = 'deleted';
    await controller.resetFixture(); assert.deepEqual((await controller.snapshot()).routes, []);
    assert.deepEqual((await controller.resources()).objects, { activeTransfers: 0, reservedBytes: '0' });
    controller.close(); await assert.rejects(controller.resources(), /controller closed/);
  } finally { await close?.(); await rm(root, { recursive: true, force: true }); }
});

test('proxy comparison measures direct and dispatcher reads in the same worker control operation without response bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'queue-control-proxy-')), seen = [];
  const bytes = Buffer.from(JSON.stringify({ request_id: 'request_owned', status: 'IN_QUEUE' }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const provider = createServer((req, res) => { seen.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end(bytes); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); const origin = 'http://127.0.0.1:' + provider.address().port;
  let close;
  try {
    await prepareQueueWorker(root); const store = fakeStore(root), config = await readPrivateJSON(join(root, QUEUE_CONFIG_FILE));
    const record = { active: 0, maxActive: 0, ticks: [], closed: 0 }, factory = fakeProviderFactory(record);
    close = await startQueueControl(store, config, { startProvider: async (...args) => {
      const fixture = await factory(...args); fixture.origin = origin;
      fixture.dispatcher.readKnown = async () => { const response = await fetch(origin + '/dispatcher-status'); await response.arrayBuffer(); return { outcome: 'complete', status: 200, sha256, evidence: { recordId: 'test-evidence' } }; };
      return fixture;
    } });
    const controller = await connectQueueWorker(root); await controller.submit('owned');
    const pair = await controller.proxyPair('owned', 'attempt_owned');
    assert.deepEqual(seen, ['/ideogram/v4/requests/request_owned/status', '/dispatcher-status']);
    assert.equal(pair.direct.sha256, 'sha256:' + sha256); assert.equal(pair.proxy.sha256, pair.direct.sha256);
    assert(pair.direct.startMs <= pair.direct.endMs && pair.direct.endMs <= pair.proxy.startMs && pair.proxy.startMs <= pair.proxy.endMs);
    assert.equal(pair.addedHopMs, Math.max(0, pair.proxy.durationMs - pair.direct.durationMs));
    assert.equal(pair.proxy.receipt.evidence.recordId, 'test-evidence'); assert(!JSON.stringify(pair).includes('IN_QUEUE'));
    await assert.rejects(controller.proxyPair('foreign', 'attempt_foreign'), /not been enrolled/);
    assert.equal(seen.length, 2);
  } finally { await close?.(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('fixture snapshot scheduling changes only the real scheduler boundary and restores its original methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'queue-control-snapshot-')); let close;
  try {
    await prepareQueueWorker(root); const store = fakeStore(root), config = await readPrivateJSON(join(root, QUEUE_CONFIG_FILE));
    close = await startQueueControl(store, config); const controller = await connectQueueWorker(root);
    const selected = await controller.setSnapshotBoundary('501'); assert.equal(selected.previous, null); assert.equal(selected.directSQLWrites, false);
    store.setHigh('300'); store.recovery.maintain(); assert.equal(store.maintains, 0);
    store.setHigh('501'); await store.recovery.settle(); assert.equal(store.recovery.latest().seq, '501');
    assert.equal((await controller.setSnapshotBoundary(null)).previous, '501');
    store.setHigh('600'); store.recovery.maintain(); assert.equal(store.recovery.latest().seq, '600');
    await assert.rejects(controller.setSnapshotBoundary('599'), /precedes live/);
  } finally { await close?.(); await rm(root, { recursive: true, force: true }); }
});

import { retainDiagnosticEvidence } from './diagnostic-evidence.mjs';
// Test-owned writer setup. Reachable only from the campaign child, never from
// production HTTP/environment configuration. Every socket remains loopback.
import { readFile, writeFile, rename } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { startFixtureProvider, connectFixtureProvider } from './backend-queue.mjs';
import { scopeQueueStore } from './backend-queue-worker.mjs';
import { createQueueAdmissionPressure } from './browser-queue-pressure.mjs';

export function restoreBrowserQueueOwnership(value, provider, jobs) {
  assert.equal(value?.kind, 'browser-queue-ownership-1');
  assert.deepEqual(value.providerIdentity, provider, 'Ownership belongs to another fixture provider');
  assert(Array.isArray(value.initialJobIds) && value.initialJobIds.length <= 10000);
  assert(Array.isArray(value.attempts) && value.attempts.length <= 10000);
  const initial = new Set(value.initialJobIds), owned = new Set(), ownedAttempts = new Set();
  assert.equal(initial.size, value.initialJobIds.length);
  const opaque = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  for (const id of initial) assert(opaque(id) && jobs.some(job => job.id === id), 'Baseline job disappeared');
  for (const entry of value.attempts) {
    assert(opaque(entry?.jobId) && opaque(entry.attemptId), 'Invalid owned attempt identity');
    const job = jobs.find(job => job.id === entry.jobId), key = entry.jobId + '\0' + entry.attemptId;
    assert(job?.attempts.some(attempt => attempt.id === entry.attemptId), 'Owned durable attempt disappeared');
    assert(!initial.has(entry.jobId) && !ownedAttempts.has(key), 'Ambiguous fixture ownership');
    owned.add(entry.jobId); ownedAttempts.add(key);
  }
  return { initial, owned, ownedAttempts };
}

export async function setup(store) {
  const config = JSON.parse(await readFile(join(store.root, 'campaign-provider-config.json'), 'utf8'));
  if (!['ideogram/v4', 'ideogram/v4/fast'].includes(config.endpoint)) throw Error('Unrecognized campaign provider route');
  let initial = new Set(), owned = new Set(), ownedAttempts = new Set();
  const failures = [], mediaWaiters = new Set(), external = config.externalProvider;
  let closing = false, pending, pendingControl, controlSequence = 0, controlPublishedAtMs = null, control = { paused: true, holdMedia: false }, recordTail = Promise.resolve(), pressure;
  const allJobs = () => {
    const jobs = []; let cursor = '';
    do { const page = store.queue.view(cursor); jobs.push(...page.jobs); cursor = page.nextCursor ?? ''; } while (cursor);
    return jobs;
  };
  const ownershipPath = join(store.root, 'campaign-provider-ownership.json');
  let restored = false;
  if (external) {
    assert(Number.isSafeInteger(external.ownerPid) && external.ownerPid > 0 && typeof external.instance === 'string');
    try { ({ initial, owned, ownedAttempts } = restoreBrowserQueueOwnership(JSON.parse(await readFile(ownershipPath, 'utf8')), external, allJobs())); restored = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!restored) for (const job of allJobs()) initial.add(job.id);
  const restoredAttempts = new Set(ownedAttempts);
  const persistOwnership = async () => {
    if (!external) return;
    const value = { kind: 'browser-queue-ownership-1', providerIdentity: external, initialJobIds: [...initial].sort(), attempts: [...ownedAttempts].sort().map(key => { const [jobId, attemptId] = key.split('\0'); return { jobId, attemptId }; }) };
    await writeFile(ownershipPath + '.tmp', JSON.stringify(value), { mode: 0o600 }); await rename(ownershipPath + '.tmp', ownershipPath);
  };
  await persistOwnership();
  const scoped = scopeQueueStore(store, owned, ownedAttempts);
  const provider = external ? await connectFixtureProvider({ repo: config.repo }, scoped, config.endpoint, external.origin) : await startFixtureProvider({ repo: config.repo, fixture: config.fixture }, scoped, config.endpoint, { resultFiles: config.resultFiles, beforeMedia: async () => {
    if (closing || !control.holdMedia) return;
    await new Promise(resolve => mediaWaiters.add(resolve));
  } });
  const record = () => recordTail = recordTail.then(async () => {
    const counts = { submissions: 0, status: 0, cancel: 0, result: 0, media: 0 };
    for (const effect of provider.effects) {
      if (effect.method === 'POST') counts.submissions++;
      else if (effect.path.endsWith('/status')) counts.status++;
      else if (effect.path.endsWith('/cancel')) counts.cancel++;
      else if (effect.path.startsWith('/image/')) counts.media++;
      else counts.result++;
    }
    const effects = provider.effects.slice(0, 10000).map(effect => ({ type: effect.method === 'POST' ? 'submit' : effect.path.endsWith('/status') ? 'status' : effect.path.endsWith('/cancel') ? 'cancel' : effect.path.startsWith('/image/') ? 'media' : 'result', requestBytes: effect.bytes, observedAtMs: effect.atMs }));
    let diagnosticRead = store.rasters.readDiagnostics();
    try {
    const raster = await retainDiagnosticEvidence(config.diagnosticOutput, 'browser-queue-raster', diagnosticRead.value);
    diagnosticRead.release(); diagnosticRead = undefined;
    const value = { controlSequence, controlPublishedAtMs, counts, effects, effectsOverflow: provider.effects.length > 10000, failures, heldMedia: mediaWaiters.size, pendingTick: !!pending, quiescent: control.paused && !pending && mediaWaiters.size === 0, closed: closing, observedAtMs: performance.now(), providerIdentity: external ?? null, workerIdentity: { pid: process.pid, threadId, epoch: store.epoch }, ownershipRestored: restored, storagePressure: pressure?.witness ?? null, jobs: allJobs().filter(job => owned.has(job.id)).map(job => ({ id: job.id, attempts: job.attempts.map(attempt => ({ id: attempt.id, state: attempt.state, terminal: attempt.terminal, cancel: attempt.cancel })) })), resources: { raster, objects: store.objects.reservationInventory() } };
    const path = join(store.root, 'campaign-provider-observation.json');
    await writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); await rename(path + '.tmp', path);
    } finally { diagnosticRead?.release(); }
  });
  const readControl = async () => {
    const next = JSON.parse(await readFile(join(store.root, 'campaign-provider-control.json'), 'utf8'));
    if (next.sequence === controlSequence) return;
    control = next;
    for (const key of ['status', 'dropAcknowledgement', 'mediaStatus', 'offline']) if (control[key] !== undefined) provider.controls[key] = control[key];
    if (!control.holdMedia) { for (const release of mediaWaiters) release(); mediaWaiters.clear(); }
    // Pause is a real drain barrier. Release gated network before waiting, then
    // acknowledge only after the current observer/download/preparation settles.
    if (control.paused) await pending;
    if (control.storagePressure === true && !pressure?.witness?.active) {
      assert(control.paused && !pending, 'Capacity fault requires the real observer drain barrier');
      const { QUEUE_ADMISSION_BYTES } = await import(pathToFileURL(join(config.repo, 'dist/local/server/storage/queue.js')).href);
      pressure ??= createQueueAdmissionPressure(store, QUEUE_ADMISSION_BYTES);
      pressure.activate();
    } else if (control.storagePressure === false && pressure?.witness?.active) pressure.release();
    controlSequence = control.sequence; controlPublishedAtMs = performance.now();
    await record();
  };
  const tick = async () => {
    if (!control.paused) {
      for (const job of allJobs()) {
        if (initial.has(job.id) || job.review.endpoint !== config.endpoint || job.attempts.at(-1)?.state !== 'not-started') continue;
        // A replacement backend cannot infer dispatch authorization from a
        // persisted fixture enrollment. Existing attempts require public recovery.
        if (restoredAttempts.has(job.id + '\0' + job.attempts.at(-1).id)) continue;
        owned.add(job.id);
        ownedAttempts.add(job.id + '\0' + job.attempts.at(-1).id);
        await persistOwnership(); // Must finish before the durable dispatch fence and POST.
        try { await provider.dispatcher.submit(job.id); }
        catch (error) { if (!(provider.controls.dropAcknowledgement && error.code === 'INTERRUPTED')) throw error; }
      }
      await provider.observer.tick();
    }
    await record();
  };
  await readControl();
  const timer = setInterval(() => {
    if (closing || pending || control.paused) return;
    pending = tick().catch(error => { failures.push({ name: error.name, code: error.code ?? null }); clearInterval(timer); }).finally(() => { pending = undefined; });
  }, 25);
  const controlTimer = setInterval(() => {
    if (closing || pendingControl) return;
    pendingControl = readControl().catch(error => { failures.push({ name: error.name, code: error.code ?? null }); clearInterval(controlTimer); clearInterval(timer); }).finally(() => { pendingControl = undefined; });
  }, 25);
  await record();
  return async () => {
    closing = true; clearInterval(timer); clearInterval(controlTimer);
    for (const release of mediaWaiters) release(); mediaWaiters.clear();
    // Abort owned network before waiting for a current observation to settle.
    provider.observer.close(); provider.dispatcher.close(); await Promise.all([pending, pendingControl]);
    try { await provider.close(); } finally { pressure?.release(); await record(); }
    if (failures.length) throw Error('Campaign provider worker failed');
  };
}

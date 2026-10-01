// Test-owned writer setup. Reachable only from the campaign child, never from
// production HTTP/environment configuration. Every socket remains loopback.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixtureProvider } from './backend-queue.mjs';
import { scopeQueueStore } from './backend-queue-worker.mjs';

export async function setup(store) {
  const config = JSON.parse(await readFile(join(store.root, 'campaign-provider-config.json'), 'utf8'));
  if (!['ideogram/v4', 'ideogram/v4/fast'].includes(config.endpoint)) throw Error('Unrecognized campaign provider route');
  const initial = new Set(), owned = new Set(), ownedAttempts = new Set(), failures = [], mediaWaiters = new Set();
  let closing = false, pending, pendingControl, controlSequence = 0, controlPublishedAtMs = null, control = { paused: true, holdMedia: false }, recordTail = Promise.resolve();
  const allJobs = () => {
    const jobs = []; let cursor = '';
    do { const page = store.queue.view(cursor); jobs.push(...page.jobs); cursor = page.nextCursor ?? ''; } while (cursor);
    return jobs;
  };
  for (const job of allJobs()) initial.add(job.id);
  const provider = await startFixtureProvider({ repo: config.repo, fixture: config.fixture }, scopeQueueStore(store, owned, ownedAttempts), config.endpoint, { resultFiles: config.resultFiles, beforeMedia: async () => {
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
    const value = { controlSequence, controlPublishedAtMs, counts, effects, effectsOverflow: provider.effects.length > 10000, failures, heldMedia: mediaWaiters.size, pendingTick: !!pending, quiescent: control.paused && !pending && mediaWaiters.size === 0, closed: closing, observedAtMs: performance.now(), jobs: allJobs().filter(job => owned.has(job.id)).map(job => ({ id: job.id, attempts: job.attempts.map(attempt => ({ id: attempt.id, state: attempt.state, terminal: attempt.terminal, cancel: attempt.cancel })) })), resources: { raster: store.rasters.diagnostics(), objects: store.objects.reservationInventory() } };
    const path = join(store.root, 'campaign-provider-observation.json');
    await writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); await rename(path + '.tmp', path);
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
    controlSequence = control.sequence; controlPublishedAtMs = performance.now();
    await record();
  };
  const tick = async () => {
    if (!control.paused) {
      for (const job of allJobs()) {
        if (initial.has(job.id) || job.review.endpoint !== config.endpoint || job.attempts.at(-1)?.state !== 'not-started') continue;
        owned.add(job.id);
        ownedAttempts.add(job.id + '\0' + job.attempts.at(-1).id);
        try { await provider.dispatcher.submit(job.id); }
        catch (error) { if (!(provider.controls.dropAcknowledgement && error.code === 'INTERRUPTED')) throw error; }
      }
      await provider.observer.tick();
    }
    await record();
  };
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
    await provider.close(); await record();
    if (failures.length) throw Error('Campaign provider worker failed');
  };
}

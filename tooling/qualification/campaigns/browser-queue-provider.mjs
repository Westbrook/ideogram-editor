// Campaign-owned HTTP fixture. Its request map and actual network counters live
// outside the product backend, so killing that backend cannot erase either.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixtureProvider } from './backend-queue.mjs';
import { intervalWait, monotonic, PrerequisiteError } from './common.mjs';

const statuses = new Set(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']);
export function queueEffectSnapshot(effects) {
  const counts = { submissions: 0, status: 0, cancel: 0, result: 0, media: 0 };
  const rows = [];
  for (const effect of effects) {
    const type = effect.method === 'POST' ? 'submit' : effect.path.endsWith('/status') ? 'status' : effect.path.endsWith('/cancel') ? 'cancel' : effect.path.startsWith('/image/') ? 'media' : 'result';
    counts[type === 'submit' ? 'submissions' : type]++;
    if (rows.length < 10000) rows.push({ type, requestBytes: effect.bytes, observedAtMs: effect.atMs });
  }
  return { counts, effects: rows, effectsOverflow: effects.length > rows.length };
}

export async function createBrowserQueueProvider({ repo, fixture, resultFiles, endpoint, signal }) {
  if (!['ideogram/v4', 'ideogram/v4/fast'].includes(endpoint)) throw new PrerequisiteError('Exact campaign provider endpoint is required');
  const waiters = new Set(); let holdMedia = false, closed = false, controlPublishedAtMs = null;
  const provider = await startFixtureProvider({ repo, fixture }, null, endpoint, { resultFiles, serveOnly: true, beforeMedia: async () => {
    if (!holdMedia || closed) return;
    await new Promise(resolve => waiters.add(resolve));
  } });
  const identity = Object.freeze({ ownerPid: process.pid, instance: randomUUID(), origin: provider.origin });
  const read = () => ({ ...queueEffectSnapshot(provider.effects), providerIdentity: identity, controlPublishedAtMs,
    controlClock: 'campaign-runner-performance-milliseconds', heldMedia: waiters.size, providerClosed: closed,
    failures: provider.errors.map(error => ({ name: 'FixtureHTTPError', code: null, message: error.message })), observedAtMs: monotonic() });
  return { origin: provider.origin, identity, read,
    set(change) {
      signal?.throwIfAborted(); if (closed) throw new PrerequisiteError('Persistent fixture provider is closed');
      if (change.status !== undefined) assert(statuses.has(change.status), 'Unknown fixture provider status');
      if (change.mediaStatus !== undefined) assert([200, 410].includes(change.mediaStatus), 'Unknown fixture media status');
      for (const key of ['dropAcknowledgement', 'offline', 'holdMedia']) if (change[key] !== undefined) assert.equal(typeof change[key], 'boolean');
      for (const key of ['status', 'mediaStatus', 'dropAcknowledgement', 'offline']) if (change[key] !== undefined) provider.controls[key] = change[key];
      if (change.holdMedia !== undefined) holdMedia = change.holdMedia;
      if (!holdMedia) { for (const release of waiters) release(); waiters.clear(); }
      controlPublishedAtMs = monotonic(); return read();
    },
    async close() { if (closed) return; closed = true; holdMedia = false; for (const release of waiters) release(); waiters.clear(); await provider.close(); },
  };
}

export function mergeBrowserQueueObservations(provider, worker) {
  if (!worker || worker.providerIdentity?.instance !== provider.providerIdentity?.instance || worker.providerIdentity?.origin !== provider.providerIdentity?.origin || worker.providerIdentity?.ownerPid !== provider.providerIdentity?.ownerPid) throw new PrerequisiteError('Writer is not attached to the exact persistent provider owner');
  return { ...worker, ...provider, failures: [...(worker.failures ?? []), ...(provider.failures ?? [])],
    quiescent: worker.quiescent === true && provider.heldMedia === 0, workerObservedAtMs: worker.observedAtMs,
    workerIdentity: worker.workerIdentity, controlSequence: worker.controlSequence };
}

/** One controller persists across replacement backend processes. Status/media
 * controls belong to the independent provider; pause/ownership belong to the
 * real writer. Acknowledgement requires both, never a stale old-worker file. */
export async function createBrowserQueueControls({ root, provider, signal }) {
  let sequence = 0, current = { paused: true, holdMedia: false }, tail = Promise.resolve();
  // The real setupModule reads this before announcing backend readiness.
  await writeFile(join(root, 'campaign-provider-control.json'), JSON.stringify({ ...current, storagePressure: false, sequence }), { mode: 0o600, flag: 'wx' });
  const read = async () => mergeBrowserQueueObservations(provider.read(), JSON.parse(await readFile(join(root, 'campaign-provider-observation.json'), 'utf8')));
  const set = change => {
    const work = tail.then(async () => {
      signal?.throwIfAborted(); provider.set(change);
      current = { ...current, ...change }; const update = { ...current, sequence: ++sequence }, path = join(root, 'campaign-provider-control.json');
      await writeFile(path + '.tmp', JSON.stringify(update), { mode: 0o600 }); await rename(path + '.tmp', path);
      const started = monotonic();
      for (;;) {
        signal?.throwIfAborted(); const value = await read();
        if (value.failures.length) throw Error('Persistent campaign provider or writer failed');
        if (value.controlSequence === sequence) return value;
        if (monotonic() - started > 10000) throw Error('Persistent provider control acknowledgement deadline');
        await intervalWait(25, signal);
      }
    });
    tail = work.catch(() => {}); return work;
  };
  return { read, set };
}

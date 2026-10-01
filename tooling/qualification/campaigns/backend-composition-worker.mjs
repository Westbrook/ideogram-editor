// Loaded only by openWriter's internal setupModule fixture hook. All dispatch
// remains in the live StoreDatabase; this transport creates no network effects.
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import {
  COMPOSITION_CONFIG_FILE, COMPOSITION_READY_FILE, COMPOSITION_JSON_LIMIT,
  compositionDirectory, compositionPayload, readCompositionJSON, writeCompositionJSON, validateCompositionConfig,
} from './backend-composition-control.mjs';

const safeError = (error, nonce) => ({
  name: String(error?.name ?? 'Error').replaceAll(nonce, '[redacted]').slice(0, 80),
  code: typeof error?.code === 'string' && !error.code.includes(nonce) && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'COMPOSITION_HANDLER',
  message: String(error?.message ?? error).replaceAll(nonce, '[redacted]').slice(0, 1024),
});
function equalNonce(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Injection is for focused transport tests only. setup always dispatches to the
 * allowlisted real campaign operations; no payload supplies a module or code.
 */
export async function startCompositionControl(store, config, { handler } = {}) {
  validateCompositionConfig(config, store.root);
  const identity = await compositionDirectory(config.root), mailbox = await compositionDirectory(join(config.root, config.mailbox));
  assert.equal((await readdir(mailbox.path)).length, 0, 'A composition worker requires its newly prepared, unused mailbox; earlier evidence is never replayed');
  assert(typeof store.epoch === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(store.epoch), 'Exact live writer epoch required');
  handler ??= (await import('./backend-composition.mjs')).runCompositionWorkerOperation;
  assert.equal(typeof handler, 'function', 'Composition worker operation handler required');
  const worker = { epoch: store.epoch, threadId };
  const subject = Object.freeze({ root: config.root, repo: config.repo });
  const diagnostics = new Set();
  let closing = false, faulted = false, lastSequence = 0n, pending = null, notifyAgain = false, invalidHash = null, errorSequence = 0;
  let timer, watcher, closePromise;
  const ready = closed => ({ schema: 'qualification-composition-ready-1', root: config.root, mailbox: config.mailbox,
    nonce: config.nonce, ...worker, lastSequence: String(lastSequence), closed, failed: faulted });
  async function retainedError(error, requestHash = null) {
    const record = { schema: 'qualification-composition-control-error-1', ...worker, afterSequence: String(lastSequence),
      requestHash, at: new Date().toISOString(), error: safeError(error, config.nonce) };
    const writing = writeCompositionJSON(join(mailbox.path, 'control-error-' + String(++errorSequence) + '.json'), record, { replace: false });
    diagnostics.add(writing);
    try { await writing; } finally { diagnostics.delete(writing); }
  }
  async function drain() {
    while (!closing) {
      const next = String(lastSequence + 1n), path = join(mailbox.path, 'request-' + next + '.json');
      let read;
      try {
        await compositionDirectory(identity.path, identity); await compositionDirectory(mailbox.path, mailbox);
        read = await readCompositionJSON(path, { withHash: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        // File security/read failures have no trusted association to a command.
        // Keep them in a separate bounded diagnostic rather than fabricating a
        // response for a request whose identity could not be established.
        const key = 'read:' + String(error.code ?? error.message);
        if (invalidHash !== key) { invalidHash = key; await retainedError(error); }
        return;
      }
      if (read.hash === invalidHash) return;
      const request = read.value;
      try {
        assert(request && Object.getPrototypeOf(request) === Object.prototype, 'Plain composition request required');
        assert.deepEqual(Object.keys(request).sort(), ['epoch', 'nonce', 'payload', 'schema', 'sequence']);
        assert.equal(request.schema, 'qualification-composition-request-1');
        assert(equalNonce(request.nonce, config.nonce), 'Composition request owner mismatch');
        assert.equal(request.epoch, worker.epoch, 'Composition request writer epoch mismatch');
        assert.equal(request.sequence, next, 'Composition request sequence mismatch');
      } catch (error) { invalidHash = read.hash; await retainedError(error, read.hash); return; }
      invalidHash = null;
      const startedMs = performance.now();
      const response = { schema: 'qualification-composition-response-1', nonce: config.nonce, ...worker,
        sequence: next, requestHash: read.hash, ok: false, startedMs, completedMs: null };
      try {
        compositionPayload(request.payload);
        const value = await handler(store, request.payload, subject);
        response.result = value ?? null; response.ok = true;
        response.completedMs = performance.now();
        assert(Buffer.byteLength(JSON.stringify(response)) <= COMPOSITION_JSON_LIMIT, 'Composition operation must return bounded observations or owned file references');
      } catch (error) {
        delete response.result; response.ok = false; response.error = safeError(error, config.nonce); response.completedMs = performance.now();
      }
      // An infrastructure failure after calling the handler permanently stops
      // this mailbox. Never rerun a possibly committed mutation to regenerate a
      // missing response. Reconnect only sees a completed sequence after its
      // exact response was safely retained.
      await compositionDirectory(identity.path, identity); await compositionDirectory(mailbox.path, mailbox);
      await writeCompositionJSON(join(mailbox.path, 'response-' + next + '.json'), response, { replace: false });
      lastSequence = BigInt(next);
      await writeCompositionJSON(join(mailbox.path, COMPOSITION_READY_FILE), ready(false));
    }
  }
  function kick() {
    if (closing || faulted) return;
    if (pending) { notifyAgain = true; return; }
    pending = drain().catch(async error => {
      faulted = true;
      try { await retainedError(error); } catch { /* Root failure is surfaced by the awaiting controller timeout. */ }
      try { await writeCompositionJSON(join(mailbox.path, COMPOSITION_READY_FILE), ready(false)); } catch { /* Preserve failure; never replay the operation. */ }
    }).finally(() => { pending = null; if (notifyAgain && !closing && !faulted) { notifyAgain = false; kick(); } });
  }
  try {
    try {
      watcher = watch(mailbox.path, { persistent: false }, (_event, file) => { if (file && /^request-[1-9][0-9]*\.json$/.test(String(file))) kick(); });
      watcher.on('error', error => { if (!closing) void retainedError(error).catch(() => {}); });
    } catch (error) {
      // Hosts can exhaust their watch limit even while ordinary private file
      // access remains available. Retain that fact and use the same poll path.
      await retainedError(error);
    }
    // fs.watch coalescing or a missed rename must never strand an owned command.
    timer = setInterval(kick, 50); timer.unref();
    await writeCompositionJSON(join(mailbox.path, COMPOSITION_READY_FILE), ready(false));
    kick();
  } catch (error) { watcher?.close(); clearInterval(timer); throw error; }
  return () => {
    if (closePromise) return closePromise;
    closing = true; watcher?.close(); clearInterval(timer);
    closePromise = (async () => {
      await pending;
      await Promise.allSettled([...diagnostics]);
      await compositionDirectory(identity.path, identity); await compositionDirectory(mailbox.path, mailbox);
      await writeCompositionJSON(join(mailbox.path, COMPOSITION_READY_FILE), ready(true));
      return { ...worker, lastSequence: String(lastSequence), closed: true };
    })();
    return closePromise;
  };
}

export async function setup(store) {
  const config = await readCompositionJSON(join(store.root, COMPOSITION_CONFIG_FILE));
  return startCompositionControl(store, config);
}

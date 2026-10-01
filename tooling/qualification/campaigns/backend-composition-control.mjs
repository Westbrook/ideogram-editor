// Internal qualification transport: filesystem only, including under the
// strict store no-network preload. The application never discovers this file.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, rename, unlink, lstat, realpath, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const COMPOSITION_CONFIG_FILE = 'qualification-composition-config.json';
export const COMPOSITION_READY_FILE = 'ready.json';
export const COMPOSITION_WORKER_MODULE = new URL('./backend-composition-worker.mjs', import.meta.url).href;
export const COMPOSITION_ACTIONS = Object.freeze(['native-admission', 'raw-ingest', 'partial-ingest', 'composition-state']);
export const COMPOSITION_JSON_LIMIT = 65536;
export const compositionHash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'COMPOSITION_CONTROL') => Object.assign(Error(message), { code });
const validSequence = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value);

export async function compositionDirectory(path, identity) {
  const actual = resolve(path), value = await lstat(actual);
  assert(value.isDirectory() && !value.isSymbolicLink() && (value.mode & 0o777) === 0o700, 'Private 0700 composition directory required');
  if (process.getuid) assert.equal(value.uid, process.getuid(), 'Composition directory owner mismatch');
  assert.equal(await realpath(actual), actual, 'Composition directory must use its canonical path');
  if (identity) assert(value.dev === identity.dev && value.ino === identity.ino, 'Composition directory identity changed');
  return { path: actual, dev: value.dev, ino: value.ino };
}

export async function readCompositionJSON(path, { withHash = false, allowReplacement = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
    const before = await file.stat();
    // A replaceable descriptor may be unlinked between open and the first stat.
    // Reopen only a different current inode; immutable and multi-link files
    // still take the strict refusal path below.
    if (allowReplacement && before.isFile() && before.nlink === 0 && attempt < 7) {
      const current = await lstat(path);
      if (before.dev !== current.dev || before.ino !== current.ino) continue;
    }
    assert(before.isFile() && before.nlink === 1 && (before.mode & 0o777) === 0o600, 'Private 0600 regular composition file required');
    if (process.getuid) assert.equal(before.uid, process.getuid(), 'Composition file owner mismatch');
    assert(before.size > 0 && before.size <= COMPOSITION_JSON_LIMIT, 'Composition JSON exceeds the bounded control size');
    const bytes = await file.readFile(), after = await file.stat(), current = await lstat(path);
    // ready.json is a replaceable snapshot. A bounded reopen handles the
    // legitimate old-fd/new-path race without weakening immutable commands.
    if (before.dev !== current.dev || before.ino !== current.ino) {
      if (allowReplacement && attempt < 7) continue;
      throw fail('Composition control file was replaced while reading', 'COMPOSITION_REPLACED');
    }
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.nlink === 1 && current.nlink === 1
      && (after.mode & 0o777) === 0o600 && (current.mode & 0o777) === 0o600, 'Composition control file changed while reading');
    assert.equal(bytes.length, before.size, 'Composition control byte count changed');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw fail('Composition control file contains malformed UTF-8 JSON', 'COMPOSITION_MALFORMED'); }
    return withHash ? { value, hash: compositionHash(bytes) } : value;
    } finally { await file.close(); }
  }
}

export async function writeCompositionJSON(path, value, { replace = true } = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  assert(bytes.length > 0 && bytes.length <= COMPOSITION_JSON_LIMIT, 'Composition JSON exceeds the bounded control size');
  if (!replace) {
    try { await lstat(path); throw fail('Composition sequence file already exists', 'COMPOSITION_SEQUENCE_USED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return compositionHash(bytes);
}

export function compositionPayload(payload) {
  assert(payload && Object.getPrototypeOf(payload) === Object.prototype, 'Plain composition payload required');
  assert(COMPOSITION_ACTIONS.includes(payload.action), 'Unsupported composition worker action');
  const seen = new Set();
  const visit = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { assert(Number.isFinite(value), 'Finite JSON number required'); return; }
    assert(value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype), 'Composition payload must contain only plain JSON values');
    assert(!seen.has(value), 'Cyclic composition payload refused'); seen.add(value);
    for (const item of Object.values(value)) visit(item);
    seen.delete(value);
  };
  visit(payload);
  assert(Buffer.byteLength(JSON.stringify(payload)) <= COMPOSITION_JSON_LIMIT - 1024, 'Composition payload must use bounded path references');
  return payload;
}

export function validateCompositionConfig(config, root) {
  assert.equal(config?.schema, 'qualification-composition-worker-1');
  assert.equal(config.root, resolve(root)); assert.equal(config.repo, resolve(config.repo));
  assert(typeof config.nonce === 'string' && /^[0-9a-f]{64}$/.test(config.nonce), 'Composition nonce format invalid');
  assert.match(config.mailbox, /^qualification-composition-mailbox-[0-9a-f-]{36}$/);
  return config;
}

export async function prepareCompositionWorker(root, context = {}) {
  const identity = await compositionDirectory(root), mailbox = 'qualification-composition-mailbox-' + randomUUID();
  await mkdir(join(identity.path, mailbox), { mode: 0o700 });
  const config = { schema: 'qualification-composition-worker-1', root: identity.path,
    repo: resolve(context.repo ?? process.cwd()), mailbox, nonce: randomBytes(32).toString('hex') };
  await compositionDirectory(root, identity);
  await writeCompositionJSON(join(identity.path, COMPOSITION_CONFIG_FILE), config);
  return { setupModule: COMPOSITION_WORKER_MODULE };
}

export async function connectCompositionWorker(root, { signal, timeoutMs = 300000 } = {}) {
  signal?.throwIfAborted();
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000, 'Bounded composition timeout required');
  const identity = await compositionDirectory(root), config = validateCompositionConfig(await readCompositionJSON(join(identity.path, COMPOSITION_CONFIG_FILE)), identity.path);
  const mailbox = await compositionDirectory(join(identity.path, config.mailbox));
  const ready = await readCompositionJSON(join(mailbox.path, COMPOSITION_READY_FILE), { allowReplacement: true });
  assert.equal(ready.schema, 'qualification-composition-ready-1'); assert(ready.nonce === config.nonce, 'Composition worker descriptor changed');
  assert(ready.closed !== true, 'Composition worker mailbox is closed');
  assert(ready.failed !== true, 'Composition worker mailbox has an unresolved control failure');
  assert.equal(ready.root, identity.path); assert.equal(ready.mailbox, config.mailbox);
  assert(validSequence(ready.epoch) && validSequence(ready.lastSequence), 'Exact composition worker epoch and sequence required');
  assert(Number.isSafeInteger(ready.threadId) && ready.threadId >= 0, 'Composition worker thread identity required');
  const lockPath = join(mailbox.path, 'controller.lock'), lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const lockIdentity = await lock.stat();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync();
    try { await lstat(join(mailbox.path, 'request-' + String(BigInt(ready.lastSequence) + 1n) + '.json')); throw fail('A prior composition controller left an unresolved request', 'COMPOSITION_PENDING'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch (error) { await lock.close(); await unlink(lockPath).catch(() => {}); throw error; }
  const stopped = new AbortController();
  let closed = false, sequence = BigInt(ready.lastSequence), tail = Promise.resolve(), closePromise, poisoned = null;
  const activeSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
  async function executeOne(payload) {
    activeSignal.throwIfAborted(); assert(!closed, 'Composition worker controller is closed');
    await compositionDirectory(identity.path, identity); await compositionDirectory(mailbox.path, mailbox);
    const next = String(++sequence);
    assert(validSequence(next), 'Composition sequence limit reached');
    const request = { schema: 'qualification-composition-request-1', nonce: config.nonce, epoch: ready.epoch, sequence: next, payload };
    const requestHash = await writeCompositionJSON(join(mailbox.path, 'request-' + next + '.json'), request, { replace: false });
    const began = performance.now(), responsePath = join(mailbox.path, 'response-' + next + '.json');
    for (;;) {
      activeSignal.throwIfAborted();
      await compositionDirectory(identity.path, identity); await compositionDirectory(mailbox.path, mailbox);
      let response;
      try { response = await readCompositionJSON(responsePath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const state = await readCompositionJSON(join(mailbox.path, COMPOSITION_READY_FILE), { allowReplacement: true });
      assert.equal(state.schema, 'qualification-composition-ready-1');
      assert(state.nonce === config.nonce && state.epoch === ready.epoch, 'Composition live mailbox owner changed');
      assert(validSequence(state.lastSequence), 'Composition completion sequence is invalid');
      if (state.failed === true) throw fail('Composition worker control failed after accepting work; inspect its retained private error receipt', 'COMPOSITION_CONTROL_FAILED');
      if (response) {
        assert.equal(response.schema, 'qualification-composition-response-1');
        assert(response.nonce === config.nonce, 'Composition response owner mismatch');
        assert.equal(response.epoch, ready.epoch, 'Composition response epoch mismatch');
        assert(response.threadId === ready.threadId, 'Composition response worker identity mismatch');
        assert.equal(response.sequence, next, 'Composition response sequence mismatch');
        assert.equal(response.requestHash, requestHash, 'Composition response request identity mismatch');
        // Both files form the completion handshake. Waiting for the published
        // sequence makes an immediate controller close/reconnect safe, while a
        // response-publication failure can never invite mutation replay.
        if (BigInt(state.lastSequence) >= BigInt(next)) {
          if (response.ok !== true) throw Object.assign(Error(response.error?.message ?? 'Composition worker operation failed'), {
            name: response.error?.name ?? 'Error', code: response.error?.code ?? 'COMPOSITION_HANDLER',
            compositionControl: { epoch: ready.epoch, threadId: ready.threadId, sequence: next, requestHash, responsePath },
          });
          return response.result;
        }
      }
      if (state.closed === true) throw fail('Composition worker closed before publishing this response', 'COMPOSITION_CLOSED');
      if (performance.now() - began >= timeoutMs) throw fail('Composition worker response timed out; no automatic retry was issued', 'COMPOSITION_TIMEOUT');
      await delay(5, undefined, { signal: activeSignal });
    }
  }
  return {
    descriptor: Object.freeze({ epoch: ready.epoch, threadId: ready.threadId }),
    execute(payload) {
      try { compositionPayload(payload); } catch (error) { return Promise.reject(error); }
      const captured = structuredClone(payload), operation = tail.then(async () => {
        if (poisoned) throw fail('Prior composition control has an unresolved outcome; no later command was issued', 'COMPOSITION_UNRESOLVED');
        try { return await executeOne(captured); }
        catch (error) { if (!error.compositionControl) poisoned = error; throw error; }
      });
      tail = operation.catch(() => {}); return operation;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true; stopped.abort(fail('Composition worker controller closed', 'COMPOSITION_CLOSED'));
      closePromise = (async () => {
        await tail; await lock.close();
        const current = await lstat(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (current?.dev === lockIdentity.dev && current.ino === lockIdentity.ino) await unlink(lockPath);
      })();
      return closePromise;
    },
  };
}

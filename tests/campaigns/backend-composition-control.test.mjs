// Filesystem transport regression tests, not product or performance qualification.
// The store guard forbids even loopback sockets for the entire test process.
import '../store/no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, realpath, readdir, readFile, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import {
  COMPOSITION_CONFIG_FILE, COMPOSITION_READY_FILE, COMPOSITION_JSON_LIMIT,
  prepareCompositionWorker,
  connectCompositionWorker,
  readCompositionJSON, writeCompositionJSON,
} from '../../tooling/qualification/campaigns/backend-composition-control.mjs';
import { startCompositionControl } from '../../tooling/qualification/campaigns/backend-composition-worker.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const options = { timeout: 5000 };

test('the worker passes its trusted selected subject separately from payload-controlled paths', options, async t => {
  const f = await fixture(t, async (store, payload, subject) => {
    assert.equal(subject.root, store.root);
    assert.equal(subject.repo, resolve(repo));
    assert.equal(Object.isFrozen(subject), true);
    assert.notEqual(subject.repo, payload.repo);
    return { repo: subject.repo, root: subject.root };
  });
  assert.deepEqual(await f.client.execute({ action: 'composition-state', repo: '/untrusted-payload-repo' }), { repo: resolve(repo), root: f.store.root });
});

function observe(promise) { promise.catch(() => {}); return promise; }

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const requestFor = (f, sequence, payload = { action: 'composition-state' }) => ({
  schema: 'qualification-composition-request-1', nonce: f.config.nonce,
  epoch: f.store.epoch, sequence: String(sequence), payload,
});

async function waitForJSON(path) {
  const deadline = performance.now() + 1000;
  for (;;) {
    try { return await readCompositionJSON(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(performance.now() < deadline, 'Timed out waiting for ' + path);
    await delay(5);
  }
}

async function waitForDiagnostic(mailbox, matches) {
  const deadline = performance.now() + 1000;
  for (;;) {
    for (const name of await readdir(mailbox)) {
      if (!/^control-error-[0-9]+\.json$/.test(name)) continue;
      const record = await readCompositionJSON(join(mailbox, name));
      if (matches(record)) return record;
    }
    assert(performance.now() < deadline, 'Timed out waiting for matching retained diagnostic');
    await delay(5);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function privateRoot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ideogram-composition-control-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, handler, { signal, timeoutMs = 1000 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ideogram-composition-control-')));
  const store = { root, epoch: '17', received: [], marker: Symbol('actual injected store') };
  const releases = [];
  let client, closeWorker;
  t.after(async () => {
    for (const release of releases) release();
    try { await client?.close(); } finally {
      try { await closeWorker?.(); } finally { await rm(root, { recursive: true, force: true }); }
    }
    assert.deepEqual(globalThis.__storeNetworkCounters.read(), {
      submit: 0, upload: 0, poll: 0, cancel: 0, fetch: 0, socket: 0, dns: 0, datagram: 0,
    });
  });
  const prepared = await prepareCompositionWorker(root, { repo });
  assert.equal(typeof prepared.setupModule, 'string');
  const config = await readCompositionJSON(join(root, COMPOSITION_CONFIG_FILE));
  closeWorker = await startCompositionControl(store, config, { handler });
  client = await connectCompositionWorker(root, { signal, timeoutMs });
  return { root, mailbox: join(root, config.mailbox), store, config, client, closeWorker, releases };
}

test('composition mailbox serializes operations on the same injected store without network effects', options, async t => {
  const started = deferred(), release = deferred();
  let active = 0, maximum = 0, observedStore;
  const f = await fixture(t, async (store, payload) => {
    observedStore ??= store;
    assert.equal(store, observedStore);
    active += 1; maximum = Math.max(maximum, active);
    store.received.push(payload.id);
    try {
      if (payload.id === 'first') { started.resolve(); await release.promise; }
      return { id: payload.id, previous: store.received.length - 1 };
    } finally { active -= 1; }
  });
  f.releases.push(release.resolve);
  assert.equal(typeof f.client.descriptor.epoch, 'string');
  assert(Number.isInteger(f.client.descriptor.threadId));
  await assert.rejects(connectCompositionWorker(f.root), { code: 'EEXIST' });
  const first = observe(f.client.execute({ action: 'composition-state', id: 'first' }));
  const second = observe(f.client.execute({ action: 'composition-state', id: 'second' }));
  const third = observe(f.client.execute({ action: 'composition-state', id: 'third' }));
  await started.promise;
  await nextTurn();
  assert.equal(active, 1);
  assert.deepEqual(f.store.received, ['first']);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [
    { id: 'first', previous: 0 }, { id: 'second', previous: 1 }, { id: 'third', previous: 2 },
  ]);
  assert.equal(observedStore, f.store);
  assert.equal(maximum, 1);
  assert.deepEqual(f.store.received, ['first', 'second', 'third']);
});

test('a handler rejection is retained without an automatic retry and later operations still execute', options, async t => {
  const f = await fixture(t, async (store, payload) => {
    store.received.push(payload.id);
    if (payload.id === 'rejected') throw Object.assign(new Error('deliberate retained failure'), { code: 'TEST_RETAINED_FAILURE' });
    return { id: payload.id };
  });
  let retainedPath;
  await assert.rejects(f.client.execute({ action: 'raw-ingest', id: 'rejected' }), error => {
    assert.match(error.message, /deliberate retained failure/);
    assert.equal(error.code, 'TEST_RETAINED_FAILURE');
    retainedPath = error.compositionControl.responsePath;
    return true;
  });
  assert.deepEqual(await f.client.execute({ action: 'composition-state', id: 'after' }), { id: 'after' });
  assert.deepEqual(await f.client.execute({ action: 'composition-state', id: 'last' }), { id: 'last' });
  assert.deepEqual(f.store.received, ['rejected', 'after', 'last']);
  const retained = await readCompositionJSON(retainedPath);
  assert.equal(retained.sequence, '1');
  assert.equal(retained.ok, false);
  assert.equal(retained.error.code, 'TEST_RETAINED_FAILURE');
  assert.equal(retained.requestHash, hash(await readFile(join(f.mailbox, 'request-1.json'))));
  await f.client.close();
  const reconnected = await connectCompositionWorker(f.root, { timeoutMs: 1000 });
  try { assert.deepEqual(await reconnected.execute({ action: 'composition-state', id: 'reconnected' }), { id: 'reconnected' }); }
  finally { await reconnected.close(); }
  assert.deepEqual(f.store.received, ['rejected', 'after', 'last', 'reconnected']);
  assert.deepEqual(await readCompositionJSON(retainedPath), retained);
});

test('composition JSON reads enforce private regular single-link bounded files', options, async t => {
  const root = await privateRoot(t);
  const valid = join(root, 'valid.json');
  await writeFile(valid, '{"valid":true}', { mode: 0o600 });
  assert.deepEqual(await readCompositionJSON(valid), { valid: true });
  await t.test('a directory cannot substitute for a JSON file', async () => { await assert.rejects(readCompositionJSON(root)); });
  await t.test('the byte limit includes multibyte UTF-8', async () => {
    const path = join(root, 'boundary.json');
    const prefix = '{\"text\":\"', suffix = '\"}';
    const textBytes = COMPOSITION_JSON_LIMIT - Buffer.byteLength(prefix + suffix);
    const boundary = prefix + 'é'.repeat(Math.floor(textBytes / 2)) + 'x'.repeat(textBytes % 2) + suffix;
    assert.equal(Buffer.byteLength(boundary), COMPOSITION_JSON_LIMIT);
    await writeFile(path, boundary, { mode: 0o600 });
    assert.equal(typeof (await readCompositionJSON(path)).text, 'string');
    await writeFile(path, boundary + ' ', { mode: 0o600 });
    await assert.rejects(readCompositionJSON(path));
  });
  await t.test('a symlink cannot redirect a control read', async () => {
    const path = join(root, 'symlink.json'); await symlink(valid, path);
    await assert.rejects(readCompositionJSON(path));
  });
  await t.test('a hard-linked file is rejected', async () => {
    const path = join(root, 'linked.json'), alias = join(root, 'linked-alias.json');
    await writeFile(path, '{}', { mode: 0o600 }); await link(path, alias);
    await assert.rejects(readCompositionJSON(path));
  });
  await t.test('group-readable JSON is rejected', async () => {
    const path = join(root, 'public.json'); await writeFile(path, '{}', { mode: 0o600 }); await chmod(path, 0o640);
    await assert.rejects(readCompositionJSON(path));
  });
  await t.test('empty, malformed, and oversized JSON is rejected', async () => {
    for (const [name, content] of [['empty', ''], ['malformed', '{'], ['oversized', JSON.stringify({ text: 'x'.repeat(65536) })]]) {
      const path = join(root, name + '.json'); await writeFile(path, content, { mode: 0o600 });
      await assert.rejects(readCompositionJSON(path));
    }
  });
});

test('worker preparation rejects a symlink root and a root accessible by other users', options, async t => {
  const root = await privateRoot(t), alias = root + '-alias';
  t.after(() => rm(alias, { force: true }));
  await symlink(root, alias);
  await assert.rejects(prepareCompositionWorker(alias, { repo }));
  await chmod(root, 0o755);
  await assert.rejects(prepareCompositionWorker(root, { repo }));
  await chmod(root, 0o700);
});

test('unsupported actions and oversized payloads never reach the handler', options, async t => {
  const f = await fixture(t, async (store, payload) => { store.received.push(payload); return { accepted: true }; });
  for (const payload of [null, {}, { action: 'arbitrary-module' }, { action: 'composition-state', text: 'x'.repeat(65536) }]) {
    await assert.rejects(f.client.execute(payload));
  }
  assert.deepEqual(f.store.received, []);
  assert.deepEqual(await f.client.execute({ action: 'composition-state' }), { accepted: true });
  assert.equal(f.store.received.length, 1);
});

test('controller close rejects a pending operation and further operations', options, async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, async store => { store.received.push('active'); started.resolve(); await release.promise; return { complete: true }; });
  f.releases.push(release.resolve);
  const pending = observe(f.client.execute({ action: 'composition-state' }));
  const queued = observe(f.client.execute({ action: 'composition-state' }));
  const rejected = assert.rejects(pending, /clos|abort|cancel/i);
  const queuedRejected = assert.rejects(queued, /clos|abort|cancel|unresolved outcome/i);
  await started.promise;
  const closing = f.client.close();
  assert.equal(f.client.close(), closing, 'close is idempotent while cancellation settles');
  await closing;
  await rejected;
  await queuedRejected;
  assert.deepEqual(f.store.received, ['active']);
  await assert.rejects(f.client.execute({ action: 'composition-state' }), /clos|abort|cancel|unresolved outcome/i);
  release.resolve();
});

test('an aborted signal rejects an operation already waiting for its response', options, async t => {
  const controller = new AbortController(), started = deferred(), release = deferred();
  const f = await fixture(t, async () => { started.resolve(); await release.promise; return { complete: true }; }, { signal: controller.signal });
  f.releases.push(release.resolve);
  const pending = observe(f.client.execute({ action: 'composition-state' }));
  const rejected = assert.rejects(pending, /abort/i);
  await started.promise;
  controller.abort(new Error('composition control aborted by test'));
  await rejected;
  await assert.rejects(f.client.execute({ action: 'composition-state' }), /abort|unresolved outcome/i);
  release.resolve();
});

test('worker close waits for the in-flight handler to finish', options, async t => {
  const started = deferred(), release = deferred();
  let completed = false;
  const f = await fixture(t, async () => { started.resolve(); await release.promise; completed = true; return { complete: true }; });
  f.releases.push(release.resolve);
  const pending = observe(f.client.execute({ action: 'composition-state' }));
  await started.promise;
  let closed = false;
  const closing = f.closeWorker().then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false);
  assert.equal(completed, false);
  release.resolve();
  await closing;
  assert.equal(completed, true);
  assert.equal(closed, true);
  assert.deepEqual(await pending, { complete: true });
});

test('worker serialization holds when multiple requests are already published', options, async t => {
  const started = deferred(), release = deferred();
  let active = 0, maximum = 0;
  const f = await fixture(t, async (store, payload) => {
    assert.equal(store, f.store);
    active += 1; maximum = Math.max(maximum, active); store.received.push(payload.id);
    try {
      if (payload.id === 'first') { started.resolve(); await release.promise; }
      return { id: payload.id };
    } finally { active -= 1; }
  });
  f.releases.push(release.resolve);
  await writeCompositionJSON(join(f.mailbox, 'request-1.json'), requestFor(f, 1, { action: 'composition-state', id: 'first' }));
  await started.promise;
  await writeCompositionJSON(join(f.mailbox, 'request-2.json'), requestFor(f, 2, { action: 'composition-state', id: 'second' }));
  assert.equal((await readCompositionJSON(join(f.mailbox, 'request-2.json'))).sequence, '2');
  await nextTurn();
  assert.deepEqual(f.store.received, ['first']);
  release.resolve();
  assert.equal((await waitForJSON(join(f.mailbox, 'response-1.json'))).ok, true);
  assert.equal((await waitForJSON(join(f.mailbox, 'response-2.json'))).ok, true);
  assert.deepEqual(f.store.received, ['first', 'second']);
  assert.equal(maximum, 1);
});

for (const [field, replacement, message] of [
  ['nonce', '0'.repeat(64), /owner|descriptor/i],
  ['epoch', '999', /epoch/i],
  ['sequence', '99', /sequence/i],
  ['requestHash', 'sha256:' + '0'.repeat(64), /request identity/i],
]) test('controller rejects a forged response with the wrong ' + field, options, async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, async store => { store.received.push('legitimate'); started.resolve(); await release.promise; return { legitimate: true }; });
  f.releases.push(release.resolve);
  const pending = observe(f.client.execute({ action: 'composition-state' }));
  const rejected = assert.rejects(pending, message);
  await started.promise;
  const response = {
    schema: 'qualification-composition-response-1', nonce: f.config.nonce,
    epoch: f.store.epoch, threadId: f.client.descriptor.threadId, sequence: '1',
    requestHash: hash(await readFile(join(f.mailbox, 'request-1.json'))), ok: true, result: { forged: true },
    [field]: replacement,
  };
  await writeCompositionJSON(join(f.mailbox, 'response-1.json'), response);
  await rejected;
  await assert.rejects(f.client.execute({ action: 'composition-state' }), /unresolved outcome/i);
  assert.deepEqual(f.store.received, ['legitimate']);
  release.resolve();
});

for (const [field, replacement, message] of [
  ['nonce', '0'.repeat(64), /owner/i],
  ['epoch', '999', /epoch/i],
  ['sequence', '99', /sequence/i],
]) test('worker refuses a mailbox request with a stale ' + field, options, async t => {
  const f = await fixture(t, async store => { store.received.push('executed'); return {}; });
  const path = join(f.mailbox, 'request-1.json');
  await writeCompositionJSON(path, { ...requestFor(f, 1), [field]: replacement });
  const expectedHash = hash(await readFile(path));
  const rejected = await waitForDiagnostic(f.mailbox, record => record.requestHash === expectedHash);
  assert.match(rejected.error.message, message);
  assert.equal(rejected.requestHash, hash(await readFile(path)));
  assert.equal(rejected.afterSequence, '0');
  assert.equal(JSON.stringify(rejected).includes(f.config.nonce), false);
  assert.deepEqual(f.store.received, []);
  assert.equal((await readCompositionJSON(join(f.mailbox, COMPOSITION_READY_FILE))).lastSequence, '0');
});

test('connecting rejects a descriptor from another nonce', options, async t => {
  const f = await fixture(t, async () => ({}));
  await f.client.close();
  const path = join(f.mailbox, COMPOSITION_READY_FILE), ready = await readCompositionJSON(path);
  await writeCompositionJSON(path, { ...ready, nonce: '0'.repeat(64) });
  await assert.rejects(connectCompositionWorker(f.root), /descriptor|nonce|owner/i);
});

test('worker independently rejects unsupported actions before invoking its handler', options, async t => {
  const f = await fixture(t, async store => { store.received.push('executed'); return {}; });
  await writeCompositionJSON(join(f.mailbox, 'request-1.json'), requestFor(f, 1, { action: 'arbitrary-module' }));
  const response = await waitForJSON(join(f.mailbox, 'response-1.json'));
  assert.equal(response.ok, false);
  assert.match(response.error.message, /unsupported.*action/i);
  assert.deepEqual(f.store.received, []);
});

for (const kind of ['oversized', 'symlink', 'hardlink', 'permissions']) {
  test('worker refuses an unsafe ' + kind + ' mailbox request file', options, async t => {
    const f = await fixture(t, async store => { store.received.push('executed'); return {}; });
    const path = join(f.mailbox, 'request-1.json'), target = join(f.root, 'unsafe-request.json');
    const request = requestFor(f, 1);
    if (kind === 'oversized') await writeFile(path, JSON.stringify({ ...request, padding: 'x'.repeat(COMPOSITION_JSON_LIMIT) }), { mode: 0o600 });
    else {
      await writeCompositionJSON(target, request);
      if (kind === 'symlink') await symlink(target, path);
      else if (kind === 'hardlink') await link(target, path);
      else { await chmod(target, 0o640); await writeFile(path, await readFile(target), { mode: 0o640 }); }
    }
    const rejected = await waitForDiagnostic(f.mailbox, record => /private|bounded|symbolic|symlink|loop/i.test(record.error.message));
    assert.equal(rejected.requestHash, null, 'unsafe bytes cannot receive a trusted request association');
    assert.equal(rejected.afterSequence, '0');
    assert.deepEqual(f.store.received, []);
  });
}

test('response publication failure permanently faults the mailbox without replaying the handler', options, async t => {
  let f;
  f = await fixture(t, async store => {
    store.received.push('executed-once');
    await writeCompositionJSON(join(f.mailbox, 'response-1.json'), { unavailable: true });
    return { effect: 'already happened' };
  });
  await assert.rejects(f.client.execute({ action: 'composition-state' }));
  const diagnostic = await waitForDiagnostic(f.mailbox, record => record.error.code === 'COMPOSITION_SEQUENCE_USED');
  assert.match(diagnostic.error.message, /sequence file already exists/i);
  await delay(120); // Crosses two fallback-poll intervals after the failed publication.
  const ready = await readCompositionJSON(join(f.mailbox, COMPOSITION_READY_FILE));
  assert.equal(ready.failed, true);
  assert.equal(ready.lastSequence, '0');
  assert.deepEqual(f.store.received, ['executed-once']);
  await assert.rejects(f.client.execute({ action: 'composition-state' }), /unresolved outcome/i);
  await f.client.close();
  await assert.rejects(connectCompositionWorker(f.root), /failed|failure/i);
});

test('a pre-aborted signal cannot acquire a controller', options, async t => {
  const f = await fixture(t, async () => ({}));
  await f.client.close();
  const controller = new AbortController(); controller.abort(new Error('already aborted'));
  await assert.rejects(connectCompositionWorker(f.root, { signal: controller.signal }), /already aborted/);
  const client = await connectCompositionWorker(f.root);
  await client.close();
});

for (const point of ['before-stat','after-read']) for (const allowReplacement of [false, true]) {
  test(point+' atomic descriptor replacement ' + (allowReplacement ? 'reopens a newly validated file' : 'stays forbidden for immutable records'), options, async t => {
    const root = await privateRoot(t), path = join(root, 'record.json'), replacement = join(root, 'replacement.json');
    await writeCompositionJSON(path, { generation: 'old' });
    await writeCompositionJSON(replacement, { generation: 'new' });
    const originalOpen = fsPromises.open;
    let reads = 0;
    const wrappedOpen = t.mock.method(fsPromises, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === path && reads++ === 0) {
        if(point==='before-stat'){await fsPromises.rename(replacement,path);return handle;}
        const originalRead = handle.readFile.bind(handle);
        handle.readFile = async (...readArgs) => {
          const bytes = await originalRead(...readArgs);
          await fsPromises.rename(replacement, path);
          return bytes;
        };
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      if (allowReplacement) {
        assert.deepEqual(await readCompositionJSON(path, { allowReplacement }), { generation: 'new' });
        assert.equal(reads, 2, 'replacement requires reopening and validating the new inode');
      } else {
        await assert.rejects(readCompositionJSON(path), point==='before-stat'?/Private 0600 regular/:{ code: 'COMPOSITION_REPLACED', message: 'Composition control file was replaced while reading' });
        assert.equal(reads, 1);
      }
    } finally { wrappedOpen.mock.restore(); syncBuiltinESMExports(); }
  });
}

test('a timed-out request is retained and blocks later mutations without an automatic retry', options, async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, async store => { store.received.push('once'); started.resolve(); await release.promise; return { complete: true }; }, { timeoutMs: 50 });
  f.releases.push(release.resolve);
  const pending = observe(f.client.execute({ action: 'composition-state' }));
  const rejected = assert.rejects(pending, { code: 'COMPOSITION_TIMEOUT' });
  await started.promise;
  await rejected;
  await assert.rejects(f.client.execute({ action: 'composition-state' }), /unresolved outcome/i);
  assert.deepEqual(f.store.received, ['once']);
  assert.equal((await readCompositionJSON(join(f.mailbox, 'request-1.json'))).sequence, '1');
  release.resolve();
  assert.equal((await waitForJSON(join(f.mailbox, 'response-1.json'))).ok, true);
  assert.deepEqual(f.store.received, ['once']);
});

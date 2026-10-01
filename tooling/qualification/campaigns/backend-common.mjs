import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { cp, mkdir, chmod, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const encode = value => Buffer.from(JSON.stringify(value));
export const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export const auth = () => ({ clientId: 'client_1', sessionHash: 'a'.repeat(64), now: Date.now(), expires: Date.now() + 12 * 3600000 });
export const expectedVersions = { hash: 'sha256:10584db4c85cf1d5cbd2eda3429934a693b7c26268e63be96dbdb23d6dd42069', byteLength: '33', mediaType: 'application/json' };

export async function product(context, relative) {
  return import(pathToFileURL(join(context.repo ?? process.cwd(), 'dist/local', relative)).href);
}

export function envelope(body, options = {}) {
  return { protocolVersion: 1, command: { schemaVersion: 1, commandId: randomUUID(), clientId: 'client_1', sessionId: 'session_1', correlationId: randomUUID(), causationId: null, transactionId: randomUUID(), documentId: null, expectedDocumentRevision: null, expectedEntityVersions: expectedVersions, issuedAt: new Date().toISOString(), body, ...options } };
}

export async function phase(phases, name, work) {
  const span = { name, startMs: performance.now(), endMs: null, durationMs: null, outcome: 'running' };
  phases.push(span);
  try { const result = await work(span); span.outcome = 'completed'; return result; }
  catch (error) { span.outcome = 'failed'; span.error = { name: error.name, code: error.code, message: error.message }; throw error; }
  finally { span.endMs = performance.now(); span.durationMs = span.endMs - span.startMs; }
}

export async function finish(writer, request, method = 'assetCommand', signal) {
  signal?.throwIfAborted();
  const immediate = await writer[method](encode(request), auth());
  if (immediate?.status === 'rejected') throw Object.assign(Error(JSON.stringify(immediate)), { code: immediate.code });
  const started = performance.now();
  for (;;) {
    signal?.throwIfAborted();
    const state = await writer.commandState(request.command.commandId);
    if (state.record) {
      const receipt = state.record.receipt;
      assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
      const events = (await writer.events(String(BigInt(receipt.fromSeq) - 1n))).events;
      return { receipt, events: events.filter(event => event.commandId === request.command.commandId) };
    }
    if (state.pending?.phase === 'waiting-for-resources') throw Object.assign(Error('Product resource admission pending'), { code: 'RESOURCE_PENDING' });
    if (performance.now() - started > 120000) throw Object.assign(Error('Product command did not settle'), { code: 'OPERATION_TIMEOUT' });
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

export async function createProductFixture(context = {}) {
  const requestedBase = resolve(context.output ?? join(context.repo ?? process.cwd(), 'artifacts/campaign-backend'));
  await mkdir(requestedBase, { recursive: true, mode: 0o700 });
  const base = await realpath(requestedBase);
  const root = join(base, 'private-' + randomUUID());
  const seed = context.fixture?.root;
  if (seed) await cp(seed, root, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  else await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  const { openWriter } = await product(context, 'server/storage/writer.js');
  const { EMPTY_EXPECTED_VERSIONS } = await product(context, 'src/protocol/store.js');
  Object.assign(expectedVersions, EMPTY_EXPECTED_VERSIONS);
  assert(!(context.queueFixture && context.compositionFixture), 'One internal writer fixture bridge per owned writer');
  let queueWorker = null, compositionWorker = null;
  const workerControl = context.queueFixture ? await import('./backend-queue-control.mjs') : null;
  const compositionControl = context.compositionFixture ? await import('./backend-composition-control.mjs') : null;
  async function writerTesting() {
    return { ...(globalThis.__storeNetworkCounters?.shared ? { effectCounters: globalThis.__storeNetworkCounters.shared } : {}),
      ...(workerControl ? await workerControl.prepareQueueWorker(root, context) : {}),
      ...(compositionControl ? await compositionControl.prepareCompositionWorker(root, context) : {}) };
  }
  let writer = await openWriter({ root, ...(context.quotaBytes ? { quotaBytes: context.quotaBytes } : {}) }, await writerTesting());
  try {
  if (workerControl) queueWorker = await workerControl.connectQueueWorker(root, { signal: context.signal });
  if (compositionControl) compositionWorker = await compositionControl.connectCompositionWorker(root, { signal: context.signal });
  let directOwner = null, directStore = null;
  let documentId = context.fixture?.documentId ?? 'document_1';
  async function prepareWriter() {
    const identity=auth();
    // Refresh only this fixture's existing binding, including after a restart
    // or an independent copy of its sealed seed. Production stays insert-only.
    await writer.rememberClient(identity.sessionHash, 'client_1', identity.expires, identity.sessionHash);
    await writer.protocolDefaults();
  }
  await prepareWriter();
  const f = {
    root, context, get documentId() { return documentId; },
    get queueWorker() { return queueWorker; },
    get compositionWorker() { return compositionWorker; },
    setDocumentId(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error('Invalid document identity'); documentId = id; },
    get writer() { if (!writer) throw Error('Writer capability is closed'); return writer; },
    async closeWriter() {
      if (!writer) return;
      const current = writer, composition = compositionWorker;
      writer = null; queueWorker?.close(); queueWorker = null; compositionWorker = null;
      try { await composition?.close(); } finally { await current.close(); }
    },
    async direct(options = {}) {
      await f.closeWriter();
      if (directStore) return directStore;
      const { acquireRoot } = await product(context, 'server/storage/ownership.js');
      const { StoreDatabase } = await product(context, 'server/storage/database.js');
      directOwner = await acquireRoot(root);
      try { directStore = new StoreDatabase(root, options.barrier ?? (() => {}), options); }
      catch (error) { directOwner.close(); directOwner = null; throw error; }
      return directStore;
    },
    async closeDirect() {
      if (!directStore) return;
      const store = directStore; directStore = null;
      try {
        await store.candidates.close(); await store.queue.close(); await store.portables.close();
        await store.histories.close(); await store.rasters.close(); await store.assets.close();
        await store.recovery.settle(); store.close();
      } finally { directOwner.close(); directOwner = null; }
    },
    async reopen(options = {}) {
      await f.closeDirect(); await f.closeWriter();
      writer = await openWriter({ root, ...options }, await writerTesting());
      if (workerControl) queueWorker = await workerControl.connectQueueWorker(root, { signal: context.signal });
      if (compositionControl) compositionWorker = await compositionControl.connectCompositionWorker(root, { signal: context.signal });
      await prepareWriter(); return writer;
    },
    async close() { await f.closeDirect(); await f.closeWriter(); },
  };
  await writeFile(join(base, 'fixture-' + root.split('/').at(-1) + '.json'), JSON.stringify({ root, documentId, seededFrom: seed ?? null, createdAt: new Date().toISOString(), pid: process.pid }), { mode: 0o600 });
  return f;
  } catch (error) {
    const cleanup=await Promise.allSettled([queueWorker?.close(),compositionWorker?.close()]);
    try { await writer?.close(); } catch (failure) { cleanup.push({status:'rejected',reason:failure}); }
    const failures=cleanup.filter(item=>item.status==='rejected').map(item=>item.reason);
    if(failures.length)throw new AggregateError([error,...failures],'Fixture initialization and cleanup failed');
    throw error;
  }
}

export async function createDocument(f, size = { width: 512, height: 512 }) {
  const existing = await f.writer.document(f.documentId);
  if (existing) return existing;
  const request = envelope({ type: 'NewDocument', ...size, color: 'sRGB', depth: 8 }, { documentId: f.documentId });
  const receipt = await f.writer.submit(encode(request), f.writer.epoch);
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  return f.writer.document(f.documentId);
}

export async function stageBlob(f, bytes, purpose = 'caption', mediaType = 'text/plain') {
  bytes = Buffer.from(bytes); const stagingId = randomUUID(), sha256 = hash(bytes), writer = f.writer;
  await writer.assetCreate({ protocolVersion: 1, stagingId, purpose, expectedBytes: String(bytes.length), sha256, mediaType }, auth());
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    f.context.signal?.throwIfAborted(); const chunk = bytes.subarray(offset, offset + 65536);
    const token = await writer.assetBeginChunk(stagingId, String(offset), chunk.length, auth());
    await writer.assetChunk(token, chunk, auth());
  }
  const result = await finish(writer, envelope({ type: 'FinalizeStaging', stagingId, expectedSha256: sha256 }), 'assetCommand', f.context.signal);
  const asset = result.events.find(event => event.payload?.asset)?.payload.asset;
  assert(asset, 'Finalization must emit owned asset'); return asset;
}

export const stageCaption = (f, text) => stageBlob(f, Buffer.from(text), 'caption', 'text/plain');

export async function ui(f, body) {
  const state = await f.writer.uiRead('request_session', auth());
  return f.writer.uiPersist(encode({ protocolVersion: 1, requestId: randomUUID(), sessionId: 'request_session', expectedUISeq: state.uiSeq, body }), auth());
}

export function result(cell, phases, observations = {}, assertions = [], missing = []) {
  return { cellId: cell.id ?? cell, status: missing.length ? 'inconclusive' : 'pass', phases, assertions, observations, evidence: [], missing };
}

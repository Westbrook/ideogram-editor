import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { lstat, realpath } from 'node:fs/promises';
import { rootFor, command, encode } from '../store/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { adapterResources } from '../../dist/local/server/observability/adapter-resources.js';
import { sendJSON } from '../../dist/local/server/protocol.js';

// Real writer/worker integration under the campaign runner's inherited
// no-egress guard. These small correctness fixtures are not WA measurements.
const options = { timeout: 30000, concurrency: false };
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const group = (ledger, owner, kind) => ledger.groups.find(value => value.owner === owner && value.kind === kind);

async function settled(writer) {
  let value;
  for (let attempt = 0; attempt < 200; attempt++) {
    value = await writer.adapterResourceSnapshot();
    if (value.scope.completeScopedOwnerSnapshot && value.aggregate.coverageWitness.activeUncoveredOwners === 0) return value;
    await pause();
  }
  assert.fail('Writer did not settle: ' + JSON.stringify({ owners: value.worker.owners, handles: value.handleClassification }));
}

async function fixture(t) {
  const root = await rootFor(t);
  assert.equal(await realpath(root), root);
  const identity = await lstat(root);
  assert.equal(identity.mode & 0o777, 0o700);
  assert.equal(identity.uid, process.getuid());
  let writer;
  const open = async () => {
    writer = await openWriter({ root });
    await writer.protocolDefaults();
    await settled(writer);
    return writer;
  };
  const close = async () => { if (writer) { await writer.close(); writer = undefined; } };
  t.after(async () => {
    try {
      const window = adapterResources.snapshot().aggregate.lifecycleWindow;
      if (window && window.endMonotonicNs === null) adapterResources.endLifecycleWindow();
    } finally { await close(); }
    // rootFor retains failure roots and removes successful roots only after
    // all teardown hooks, so an unsuccessful close cannot race root removal.
  });
  await open();
  return { root, get writer() { return writer; }, open, close };
}

function completeWindow(before, after) {
  const window = after.aggregate.lifecycleWindow;
  assert.equal(window.id, before.aggregate.lifecycleWindow.id);
  assert.equal(window.sealed, true);
  assert.equal(window.integrityComplete, true);
  assert.equal(window.coverage.complete, true);
  assert.equal(window.coverage.startActiveUncoveredOwners, 0);
  assert.equal(window.coverage.endActiveUncoveredOwners, 0);
  assert.equal(window.coverage.startActivationCount, window.coverage.endActivationCount);
  assert.equal(after.aggregate.integrityComplete, true);
  assert.equal(after.aggregate.coverageComplete, true);
  assert.equal(after.scope.intervalQuiescenceProven, true);
  assert.equal(after.scope.completeScopedOwnerSnapshot, true);
  assert.equal(after.unusedHandles, 0);
  assert.ok(Object.values(after.coverage).every(value => value === true));
}

async function caption(writer, bytes) {
  const now = Date.now(), auth = { clientId: 'client_1', sessionHash: 'a'.repeat(64), now, expires: now + 43200000 };
  const stage = { protocolVersion: 1, stagingId: randomUUID(), purpose: 'caption', expectedBytes: String(bytes.length), sha256: hash(bytes), mediaType: 'text/plain' };
  await writer.assetCreate(stage, auth);
  const token = await writer.assetBeginChunk(stage.stagingId, '0', bytes.length, auth);
  await writer.assetChunk(token, bytes, auth);
  const request = command(EMPTY_EXPECTED_VERSIONS, { documentId: null, body: { type: 'FinalizeStaging', stagingId: stage.stagingId, expectedSha256: stage.sha256 } });
  await writer.assetCommand(encode(request), auth);
  let retained;
  for (let attempt = 0; attempt < 200; attempt++) {
    retained = await writer.lookup(request.command.commandId);
    if (retained) break;
    await pause();
  }
  assert.ok(retained, 'Actual caption preparation must produce its receipt');
  assert.equal(retained.receipt.status, 'accepted');
  const event = (await writer.events(String(BigInt(retained.receipt.fromSeq) - 1n))).events[0];
  assert.equal(event.type, 'AssetRegistered');
  const asset = event.payload.asset;
  assert.equal(asset.purpose, 'caption');
  assert.equal(asset.qualification, 'opaque-text');
  assert.equal(asset.safety, 'safe');
  assert.equal(asset.blob.hash, stage.sha256);
  await settled(writer);
  return asset;
}

test('actual writer metadata ownership survives awaited consumers and releases on success and rejection', options, async t => {
  const f = await fixture(t), writer = f.writer;
  const before = await writer.adapterResourceSnapshot({ beginLifecycleWindow: true });
  const bytes = Buffer.from(JSON.stringify({ caption: 'retained metadata ' + 'x'.repeat(8192) }));
  const ref = await writer.putObject([bytes], { byteLength: String(bytes.length), mediaType: 'application/json', hash: hash(bytes) }, writer.epoch);
  assert.equal(ref.hash, hash(bytes));
  const value = await writer.consumeMetadata(ref, async received => {
    const held = await writer.adapterResourceSnapshot();
    assert.equal(Buffer.compare(received, bytes), 0);
    assert.equal(held.main.returnedBuffers, 1);
    assert.equal(group(held.main, 'writer-receiver', 'result-bytes').buffers, 1);
    assert.equal(group(held.main, 'writer-consumer', 'metadata').handles, 1);
    assert.ok(held.main.cpuBytes >= received.buffer.byteLength);
    assert.equal(held.handleClassification.settled, false);
    assert.equal(held.coverage.handles, false);
    return JSON.parse(Buffer.from(received).toString('utf8'));
  });
  assert.equal(value.caption.length, 'retained metadata '.length + 8192);
  const failure = Error('consumer rejected');
  await assert.rejects(writer.consumeMetadata(ref, async received => {
    assert.equal((await writer.adapterResourceSnapshot()).main.returnedBuffers, 1);
    assert.equal(Buffer.compare(received, bytes), 0);
    throw failure;
  }), error => error === failure);
  const released = await settled(writer);
  assert.equal(released.main.returnedBuffers, 0);
  assert.equal(group(released.main, 'writer-consumer', 'metadata').handles, 0);
  completeWindow(before, await writer.adapterResourceSnapshot({ endLifecycleWindow: true }));
});

test('actual caption proof and returned bytes have separate lifetimes inside complete finite coverage', options, async t => {
  const f = await fixture(t), writer = f.writer, original = Buffer.from('A real retained caption.');
  const asset = await caption(writer, original);
  const before = await writer.adapterResourceSnapshot({ beginLifecycleWindow: true });
  const proof = await writer.assetVerify(asset.id);
  let bytes;
  try {
    const reader = await writer.adapterResourceSnapshot();
    assert.equal(reader.worker.owners.assets.contentReaders, 1);
    assert.equal(reader.worker.owners.objects.proofReservations, 1);
    assert.equal(reader.worker.owners.objects.retainedProofs, 1);
    assert.equal(reader.handleClassification.activeOwners.assetContentReaders, 1);
    assert.equal(reader.handleClassification.settled, false);
    assert.equal(reader.coverage.handles, false);
    assert.equal(Object.hasOwn(reader, 'unusedHandles'), false);
    bytes = await writer.assetContent(asset.id, proof.handle, '0', original.length);
    assert.equal(Buffer.compare(bytes, original), 0);
    assert.equal((await writer.adapterResourceSnapshot()).main.returnedBuffers, 1);
    await writer.assetRelease(proof.handle);
    const retained = await settled(writer);
    assert.equal(retained.worker.owners.assets.contentReaders, 0);
    assert.equal(retained.worker.owners.objects.proofReservations, 0);
    assert.equal(retained.worker.owners.objects.retainedProofs, 0);
    assert.equal(retained.main.returnedBuffers, 1);
    assert.equal(retained.unusedHandles, 1);
    assert.ok(retained.main.cpuBytes >= bytes.buffer.byteLength);
    assert.equal(writer.releaseResourceBytes(bytes), true);
    assert.equal(writer.releaseResourceBytes(bytes), false);
  } finally {
    if (bytes) writer.releaseResourceBytes(bytes);
    await writer.assetRelease(proof.handle);
  }
  const after = await writer.adapterResourceSnapshot({ endLifecycleWindow: true });
  assert.equal(after.main.returnedBuffers, 0);
  completeWindow(before, after);
});

test('retained diagnostics deny interval coverage across RPC and actual exit; clean reopen leaves no stale ownership', options, async t => {
  const f = await fixture(t), baseline = adapterResources.snapshot();
  const read = await f.writer.readDiagnostics();
  try {
    assert.equal(read.value.observer.kind, 'adapter-resource-observation-1');
    // Delivery precedes ordinary RPC scope cleanup. Wait for that scope to
    // release while the independently retained consumer read stays owned.
    let ready;
    for (let attempt = 0; attempt < 200; attempt++) {
      ready = await f.writer.adapterResourceSnapshot();
      if (ready.worker.owners.activeMethods.length === 0 && ready.aggregate.coverageWitness.activeUncoveredOwners === 1) break;
      await pause();
    }
    assert.equal(ready.worker.owners.activeMethods.length, 0);
    assert.equal(ready.aggregate.coverageWitness.activeUncoveredOwners, 1);
    const held = await f.writer.adapterResourceSnapshot({ beginLifecycleWindow: true });
    assert.ok(held.main.uncoveredOwners.some(item => item.owner === 'writer-diagnostic-read' && item.count === 1));
    assert.equal(held.scope.completeScopedOwnerSnapshot, false);
    assert.equal(held.handleClassification.settled, false);
    const ended = await f.writer.adapterResourceSnapshot({ endLifecycleWindow: true });
    assert.equal(ended.aggregate.lifecycleWindow.coverage.complete, false);
    assert.equal(ended.aggregate.coverageComplete, false);
    assert.equal(ended.aggregate.lifecycleWindow.coverage.startActiveUncoveredOwners, 1);
    assert.equal(ended.aggregate.lifecycleWindow.coverage.endActiveUncoveredOwners, 1);
    await f.close();
    assert.equal(read.value.observer.kind, 'adapter-resource-observation-1', 'A ready read survives actual native exit');
    const exited = adapterResources.snapshot();
    assert.equal(exited.ownedWorkerThreads.filter(worker => worker.kind === 'writer').length, 0);
    assert.equal(exited.aggregate.activeParticipants, 1);
    assert.equal(exited.aggregate.reservedParticipants, 0);
    assert.equal(exited.aggregate.droppedTransitions, baseline.aggregate.droppedTransitions);
    assert.equal(exited.aggregate.coverageWitness.activeUncoveredOwners, 1);
  } finally { read.release(); }
  assert.throws(() => read.value, /DIAGNOSTIC_READ_RELEASED/);
  assert.equal(adapterResources.snapshot().aggregate.coverageWitness.activeUncoveredOwners, 0);
  for (let cycle = 0; cycle < 3; cycle++) {
    const writer = await f.open();
    const before = await writer.adapterResourceSnapshot({ beginLifecycleWindow: true });
    completeWindow(before, await writer.adapterResourceSnapshot({ endLifecycleWindow: true }));
    await f.close();
    const exited = adapterResources.snapshot();
    assert.equal(exited.aggregate.integrityComplete, true);
    assert.equal(exited.aggregate.droppedTransitions, baseline.aggregate.droppedTransitions);
    assert.equal(exited.aggregate.coverageWitness.activeUncoveredOwners, 0);
    assert.equal(exited.aggregate.activeParticipants, 1);
    assert.equal(exited.aggregate.reservedParticipants, 0);
    assert.equal(exited.activeLeases, 0);
    assert.equal(exited.returnedBuffers, 0);
  }
});

test('a real queued HTTP response remains an active owner after its writer RPC settles', options, async t => {
  const f = await fixture(t), held = Promise.withResolvers(), finished = Promise.withResolvers();
  let first;
  const server = createServer((request, response) => {
    if (request.url === '/first') { first = response; return; }
    response.once('finish', finished.resolve);
    sendJSON(response, 200, { caption: 'queued response' });
    held.resolve(response);
  });
  t.after(() => new Promise(resolve => { first?.end(); server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const socket = createConnection({ host: '127.0.0.1', port: server.address().port });
  socket.on('error', error => { held.reject(error); finished.reject(error); });
  held.promise.catch(() => {}); finished.promise.catch(() => {});
  t.after(() => socket.destroy());
  socket.resume(); await once(socket, 'connect');
  // The native HTTP pipeline queues the second small response behind the
  // first response. No fake response, socket, or buffer counter is installed.
  socket.write('GET /first HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /second HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  const response = await held.promise;
  assert.equal(response.writableFinished, false);
  const snapshot = await f.writer.adapterResourceSnapshot();
  assert.equal(snapshot.worker.owners.activeMethods.length, 0);
  assert.equal(snapshot.handleClassification.activeOwners.responseBuffers, 1);
  assert.equal(snapshot.handleClassification.settled, false);
  assert.equal(snapshot.scope.completeScopedOwnerSnapshot, false);
  assert.equal(snapshot.coverage.handles, false);
  assert.equal(Object.hasOwn(snapshot, 'unusedHandles'), false);
  first.end('first complete'); await finished.promise;
  const released = await settled(f.writer);
  assert.equal(released.handleClassification.activeOwners.responseBuffers, 0);
  assert.equal(released.unusedHandles, 0);
});


test('asset proof release stays admitted at the full writer RPC limit without widening ordinary admission', options, async t => {
  const f = await fixture(t), writer = f.writer, original = Buffer.from('Proof survives unrelated writer pressure.');
  const asset = await caption(writer, original);
  const first = await writer.assetVerify(asset.id), second = await writer.assetVerify(asset.id);
  let replacement, retainedBytes;
  try {
    // No await separates these calls: all 64 RPCs remain pending in this
    // sender turn even if the real worker has begun processing them.
    const pending = Array.from({ length: 64 }, () => writer.assetProjection(asset.id));
    const overflow = writer.assetProjection(asset.id);
    const released = writer.assetRelease(first.handle);
    const outcomes = await Promise.allSettled([...pending, overflow, released]);
    for (const outcome of outcomes.slice(0, 64)) {
      assert.equal(outcome.status, 'fulfilled');
      assert.equal(outcome.value.asset.id, asset.id);
      assert.equal(outcome.value.asset.blob.hash, asset.blob.hash);
    }
    assert.equal(outcomes[64].status, 'rejected');
    assert.equal(outcomes[64].reason.code, 'QUEUE_FULL', 'Ordinary RPC admission retains its exact limit');
    assert.equal(outcomes[65].status, 'fulfilled', 'Owned proof release must reach the worker while ordinary admission is full');
    const remaining = await writer.adapterResourceSnapshot();
    assert.equal(remaining.worker.owners.assets.contentReaders, 1);
    assert.equal(remaining.worker.owners.objects.retainedProofs, 1);
    // The released proof frees its real shared IO slot. A new proof can
    // coexist with the untouched second reader, whose original bytes remain valid.
    replacement = await writer.assetVerify(asset.id);
    const reused = await writer.adapterResourceSnapshot();
    assert.equal(reused.worker.owners.assets.contentReaders, 2);
    retainedBytes = await writer.assetContent(asset.id, second.handle, '0', original.length);
    assert.equal(Buffer.compare(retainedBytes, original), 0);
  } finally {
    if (retainedBytes) writer.releaseResourceBytes(retainedBytes);
    await writer.assetRelease(first.handle);
    await writer.assetRelease(second.handle);
    if (replacement) await writer.assetRelease(replacement.handle);
  }
  const after = await settled(writer);
  assert.equal(after.worker.owners.assets.contentReaders, 0);
  assert.equal(after.worker.owners.objects.retainedProofs, 0);
  assert.equal(after.worker.owners.objects.proofReservations, 0);
  assert.equal(after.unusedHandles, 0);
});

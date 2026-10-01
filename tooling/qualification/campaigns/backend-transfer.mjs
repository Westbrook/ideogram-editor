import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProductFixture, product, phase, result } from './backend-common.mjs';
import { startControlledNetwork } from './controlled-network.mjs';

export function identifyTransfer(cell) {
  const value = cell.parameters;
  if (cell.operation !== 'transfer.asset' || !['upload', 'download'].includes(value?.direction) || ![8 * 1024 ** 2, 32 * 1024 ** 2].includes(value.bytes)) throw Error('Expected an I7N 8/32MiB upload/download cell');
  return value;
}

export async function transferFixture(context, bytes) {
  const file = context.fixture?.corpus?.files?.find(file => Number(file.byteLength) === bytes && ['transfer', 'transfer-input', 'transfer-payload', 'opaque-transfer'].includes(file.role));
  if (!file) throw Object.assign(Error('Supply a sealed exact ' + bytes + '-byte transfer fixture'), { code: 'FIXTURE_REQUIRED' });
  const path = resolve(context.fixture.root ?? '', file.path), before = await lstat(path);
  assert(before.isFile() && !before.isSymbolicLink()); assert.equal(before.size, bytes);
  const hash = createHash('sha256'); let total = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) { context.signal?.throwIfAborted(); hash.update(chunk); total += chunk.length; }
  const after = await lstat(path), identity = 'sha256:' + hash.digest('hex');
  assert.equal(total, bytes); assert.equal(identity, String(file.sha256).startsWith('sha256:') ? file.sha256 : 'sha256:' + file.sha256);
  assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs], [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
  return { ...file, path, sha256: identity, bytes };
}

async function ownInput(objects, fixture, signal) {
  const id = objects.begin(String(fixture.bytes), 'application/octet-stream', fixture.sha256);
  try {
    for await (const chunk of createReadStream(fixture.path, { highWaterMark: 1024 * 1024 })) { signal?.throwIfAborted(); objects.chunk(id, chunk); }
    return objects.finish(id);
  } finally { objects.abort(id); }
}

/** One real store owner survives warm samples. Every network operation still
 * receives a fresh provider attempt and server transfer identity. */
export async function createTransferFixture(context, cell) {
  identifyTransfer(cell);
  const f = await createProductFixture({ ...context, fixture: undefined });
  let store, network, provider, profile;
  try {
    store = await f.direct();
    const helpers = await import(pathToFileURL(join(context.repo ?? process.cwd(), 'tests/provider/emulator.mjs')).href);
    network = await startControlledNetwork({ output: context.output, signal: context.signal });
    provider = helpers.emulator({ queueOrigin: network.origin, mediaOrigin: network.origin, uploadOrigin: network.origin });
    profile = helpers.fixtureProfile();
  } catch (error) { await network?.close(); await f.close(); throw error; }
  const epoch = store.epoch;
  let samples = 0, closed = false;
  f.transfer = { store, epoch, network, provider, profile };
  f.resetCell = async (nextCell, sample = {}) => {
    assert(!closed, 'Transfer fixture is closed'); identifyTransfer(nextCell);
    context.signal?.throwIfAborted();
    const phases = [];
    await phase(phases, 'transfer-owner-resource-boundary', async () => {
      assert.equal(await f.direct(), store, 'Warm samples retain the exact product store owner');
      assert.equal(store.epoch, epoch);
      assert.deepEqual(store.objects.reservationInventory(), { reservedBytes: '0', activeTransfers: 0 });
      assert.equal(store.objects.hasLeases(), false);
      assert.deepEqual(network.errors, []);
    });
    if (sample.cache === 'cold') assert.equal(samples, 0, 'Cold transfer sample requires a fresh process and store owner');
    const receipt = result(nextCell, phases, { ...sample, root: f.root, storeEpoch: epoch, retainedStore: samples > 0, priorSamples: samples,
      reset: 'Same live product store and emulator connection endpoint; fresh transfer identities are allocated for each operation',
      operatingSystemPageCache: 'not purged or inferred' });
    samples++;
    return receipt;
  };
  const close = f.close.bind(f);
  f.close = async () => { if (closed) return; closed = true; try { await network.close(); } finally { await close(); } };
  return f;
}

export async function runCell(context, cell) {
  const parameters = identifyTransfer(cell), phases = [], specimen = await transferFixture(context, parameters.bytes);
  const f = context.productFixture ?? await phase(phases, 'fresh-transfer-namespace-reset', () => createProductFixture({ ...context, fixture: undefined }));
  let network;
  try {
    const store = await f.direct();
    const { emulator, fixtureProfile } = await import(pathToFileURL(join(context.repo ?? process.cwd(), 'tests/provider/emulator.mjs')).href);
    network = f.transfer?.network ?? await startControlledNetwork({ output: context.output, signal: context.signal });
    const provider = f.transfer?.provider ?? emulator({ queueOrigin: network.origin, mediaOrigin: network.origin, uploadOrigin: network.origin }), profile = f.transfer?.profile ?? fixtureProfile();
    const effectsStart = network.effects.length;
    const downloadURL = parameters.direction === 'download' ? await network.addDownload(specimen.path, specimen.bytes, specimen.sha256) : null;
    const effects = () => network.effects.slice(effectsStart);
    const attempt = { attemptId: randomUUID(), identity: { endpoint: 'ideogram/v4' }, profileId: profile.id };
    const policy = provider.policy(attempt).applied, pacing = [];
    let input, receipt, retained;
    // The upload cell starts with owned immutable bytes. This explicit setup
    // phase is retained; it is never relabelled as network transfer time.
    if (parameters.direction === 'upload') input = await phase(phases, 'owned-input-materialization', () => ownInput(store.objects, specimen, context.signal));
    await phase(phases, 'asset.transfer-durable', async span => {
      if (parameters.direction === 'upload') {
        network.expectUpload({ bytes: specimen.bytes, hash: specimen.sha256 });
        const stream = store.queue.inputStream(input), requestSink = store.queue.sink(attempt.attemptId, 'request', policy), responseSink = store.queue.sink(attempt.attemptId, 'response', policy);
        receipt = await provider.upload(network.uploadURL, attempt, { byteLength: stream.byteLength, chunks: () => network.uploadChunks(stream.chunks(), pacing), evidence: requestSink }, responseSink, context.signal);
        retained = store.queue.evidence.inspect(receipt.evidence.recordId);
        assert.equal(effects()[0]?.bytes, specimen.bytes); assert.equal(effects()[0]?.hash, specimen.sha256.slice(7));
        span.durableOwner = 'Emulator upload file fsync and product response evidence fsync';
      } else {
        const responseSink = store.queue.sink(attempt.attemptId, 'response', policy);
        receipt = await provider.media(downloadURL, responseSink, { expectedBytes: BigInt(specimen.bytes), expectedHash: specimen.sha256.slice(7), signal: context.signal });
        retained = store.queue.evidence.inspect(receipt.evidence.recordId);
        assert.equal(retained.sha256, specimen.sha256.slice(7)); assert.equal(retained.retainedBytes, String(specimen.bytes));
        span.durableOwner = 'Product protected response file and identity metadata fsync';
      }
      assert.equal(receipt.outcome, 'complete'); assert.equal(receipt.status, 200); assert.equal(retained.completeness, 'complete');
    });
    await phase(phases, 'durable-transfer-hash-verification', () => {
      const body = createHash('sha256'); let actualBytes = 0;
      // For uploads, inspect the exact request stream instead of the small JSON
      // acknowledgement. No 32MiB Buffer is constructed by the harness.
      const meta = parameters.direction === 'download' ? retained : store.queue.evidence.inspect(
        receipt.evidence.recordId);
      if (parameters.direction === 'download') {
        for (const bytes of store.queue.evidence.read(meta.recordId)) { body.update(bytes); actualBytes += bytes.length; }
        assert.equal(actualBytes, specimen.bytes); assert.equal('sha256:' + body.digest('hex'), specimen.sha256);
      } else { store.objects.verify(input); assert.equal(effects()[0]?.hash, specimen.sha256.slice(7)); }
    });
    assert.deepEqual(store.objects.reservationInventory(), { reservedBytes: '0', activeTransfers: 0 });
    assert.equal(store.objects.hasLeases(), false);
    assert.equal(effects().length, 1, 'Every sample moves bytes over a fresh real transfer key'); assert.deepEqual(network.errors, []);
    const out = result(cell, phases, { root: f.root, storeEpoch: store.epoch, retainedStore: !!f.transfer, connectionEndpoint: network.origin, direction: parameters.direction, expectedBytes: specimen.bytes, expectedHash: specimen.sha256, transferKey: parameters.direction === 'download' ? downloadURL : attempt.attemptId, effects: effects(), pacing, policy: network.policy, receipt, retainedIdentity: retained, pid: process.pid }, [
      { name: 'Exact bytes cross real HTTP and reach owned durable storage', passed: true },
      { name: 'Fresh transfer identity and zero remaining IO reservations', passed: true },
    ], ['Application byte pacing is measured; the required N physical 40ms RTT and zero packet loss are not established by application response delay']);
    const proof = { expectedBytes: specimen.bytes, expectedHash: specimen.sha256, networkEffects: effects(), receipt, retainedIdentity: retained,
      durableBoundary: phases.find(span => span.name === 'asset.transfer-durable') };
    out.measurements = { R28ActualByteOrDurabilityMismatchCount: 0 };
    out.measurementDetails = { R28ActualByteOrDurabilityMismatchCount: { unit: 'violations', method: 'Compared exact streamed byte counts and SHA-256 against the sealed input, complete protected evidence, and owned storage durability', evidence: [proof] } };
    out.evidence.push({ kind: 'actual-transfer-durability', ...proof }); return out;
  } finally { if (!f.transfer) await network?.close(); if (!context.productFixture) await f.close(); }
}

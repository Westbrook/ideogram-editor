import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startControlledNetwork } from './controlled-network.mjs';

const product = (repo, path) => import(pathToFileURL(join(repo, 'dist/local', path)).href);
const profile = { id: 'local-fixture-v1', version: 1, evidenceDigest: 'a'.repeat(64), endpoint: 'ideogram/v4', mode: 'fixture', enforcement: 'observed', lifecycleSeconds: 60,
  minimumCompatibleSeconds: 60, acl: 'fixture-private', supportedLifetimes: [60, 120], supportedACLs: ['fixture-private', 'fixture-public'], mostPrivateACL: 'fixture-private',
  deferredFetch: 'bounded', requiredLifetimeSeconds: 60, renewalQualified: false };

/** Observe real production checks without adding capacity calls, timers or
 * synthetic checkpoints. The wrapped method keeps its original receiver. */
export function observeCapacityChecks(objects) {
  const descriptor = Object.getOwnPropertyDescriptor(objects, 'capacity'), original = objects.capacity, checks = [];
  assert.equal(typeof original, 'function'); let restored = false;
  Object.defineProperty(objects, 'capacity', { configurable: true, writable: true, value: function (...args) {
    const check = { startMs: performance.now(), requestedBytes: String(args[0]), outcome: 'running' }; checks.push(check);
    try { const answer = original.apply(this, args); check.outcome = 'expected'; return answer; }
    catch (error) { check.outcome = 'failed'; check.code = error?.code ?? null; throw error; }
    finally { check.endMs = performance.now(); }
  } });
  return { checks, restore() { if (restored) return; restored = true; if (descriptor) Object.defineProperty(objects, 'capacity', descriptor); else delete objects.capacity; } };
}

export function capacityRecheckGapMs(startMs, endMs, checks) {
  assert(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs);
  assert(Array.isArray(checks));
  const observed = checks.filter(check => check.outcome === 'expected' && Number.isFinite(check.startMs) && Number.isFinite(check.endMs)
    && check.startMs >= startMs && check.endMs >= check.startMs && check.endMs <= endMs).map(check => check.endMs);
  if (!observed.length) return null;
  assert(observed.every((value, index) => index === 0 || value >= observed[index - 1]), 'Actual capacity checks must retain chronological order');
  const boundaries = [startMs, ...observed, endMs];
  return Math.max(...boundaries.slice(1).map((value, index) => value - boundaries[index]));
}

export async function runAdapterTransfer({ context, cell, fixtures, root, io, phase, releaseWriter, resumeWriter }) {
  const input = cell.parameters ?? cell.input ?? cell, weights = fixtures.weights.find(item => item.bytes === input.bytes);
  assert(weights, 'An exact declared adapter transfer fixture is required'); assert(['upload', 'download'].includes(input.direction));
  const files = [{ ...weights, purpose: 'adapter' }, { ...fixtures.config, purpose: 'caption' }];
  let network, owner, db, capacityObserver, closed = false, latestIO = io;
  const transfers = [], observations = { direction: input.direction, bytes: input.bytes, configBytes: fixtures.config.bytes, transfers, fixtureHashes: files.map(file => file.hash), productionProviderCalls: 0 };
  async function closeDatabase() {
    if (!db) { owner?.close(); owner = null; return; } const current = db; db = null;
    try { await current.candidates.close(); await current.queue.close(); await current.portables.close(); await current.histories.close(); await current.rasters.close(); await current.assets.close(); await current.recovery.settle(); current.close(); }
    finally { capacityObserver?.restore(); capacityObserver = null; owner.close(); owner = null; }
  }
  async function close() {
    if (closed) return observations.cleanup; closed = true;
    try { observations.network = network ? { policy: network.policy, effects: network.effects, errors: network.errors } : null; observations.cleanup = await network?.close(); }
    finally { await closeDatabase(); }
    return observations.cleanup;
  }
  try {
    // Upload-ready owned bytes are prepared outside the first-transfer timing.
    const originals = [];
    if (input.direction === 'upload') for (const file of files) originals.push(await phase(file.purpose + '-upload-source-durable', detail => io.stage(file, file.purpose, detail)));
    await releaseWriter();
    const { acquireRoot } = await product(context.repo, 'server/storage/ownership.js'), { StoreDatabase } = await product(context.repo, 'server/storage/database.js');
    owner = await acquireRoot(root); db = new StoreDatabase(root, () => {}); capacityObserver = observeCapacityChecks(db.objects);
    network = await startControlledNetwork({ output: context.output, signal: context.signal });
    const { providerBoundary } = await product(context.repo, 'server/provider/client.js');
    const provider = providerBoundary({ mode: 'fixture', queueOrigin: network.origin, mediaOrigins: [network.origin], uploadOrigin: network.origin, profiles: [profile],
      credential: { queueKey: () => 'qualification-local-emulator-no-production-key' }, connection: { mode: 'fixture', fixtureOrigins: [network.origin], resolve: async () => [{ address: '127.0.0.1', family: 4 }] } });
    const downloaded = [];
    const firstTransferStartMs = performance.now();
    for (let index = 0; index < files.length; index++) {
      context.signal?.throwIfAborted(); const file = files[index], attempt = { attemptId: randomUUID(), identity: { endpoint: 'ideogram/v4' }, profileId: profile.id };
      const applied = provider.policy(attempt).applied;
      await phase(file.purpose + '-' + input.direction + '-first-byte-to-durable-evidence', async detail => {
        detail.attemptId = attempt.attemptId; detail.freshTransferIdentity = true; detail.expectedBytes = file.bytes; detail.expectedHash = file.hash;
        const checkStart = capacityObserver.checks.length, capacityWindowStartMs = performance.now();
        const response = db.queue.sink(attempt.attemptId, 'response', applied);
        let receipt, request, transferReturned = false;
        try {
        if (input.direction === 'upload') {
          network.expectUpload(file); request = db.queue.sink(attempt.attemptId, 'request', applied); const source = db.queue.inputStream(originals[index].blob), pacing = [];
          receipt = await provider.upload(network.uploadURL, attempt, { byteLength: source.byteLength, chunks: () => network.uploadChunks(source.chunks(), pacing), evidence: request }, response, context.signal);
          transferReturned = true;
          const metadata = db.queue.evidence.inspect(receipt.evidence.recordId), chunks = [...db.queue.evidence.read(receipt.evidence.recordId)];
          assert(BigInt(metadata.retainedBytes) <= 65536n); const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert.equal(new URL(answer.url).origin, network.origin); assert(network.effects.some(effect => effect.providerReadableURL === answer.url && effect.outcome === 'complete' && effect.hash === file.hash.slice(7)));
          detail.providerReadableURL = answer.url; detail.requestEvidence = request.finish(true); detail.pacing = pacing;
          assert.equal(detail.requestEvidence.sha256, file.hash.slice(7)); assert.equal(detail.requestEvidence.receivedBytes, String(file.bytes));
        } else {
          const url = await network.addDownload(file.path, file.bytes, file.hash); detail.transferURL = url;
          receipt = await provider.media(url, response, { expectedBytes: BigInt(file.bytes), expectedHash: file.hash.slice(7), signal: context.signal });
          transferReturned = true;
          assert.equal(receipt.sha256, file.hash.slice(7)); assert.equal(receipt.receivedBytes, String(file.bytes));
          downloaded.push({ ...file, path: join(root, 'backend-transport', receipt.evidence.recordId + '.body') });
        }
        assert.equal(receipt.outcome, 'complete'); assert.equal(receipt.status, 200); detail.receipt = receipt;
        } catch (error) {
          if (!transferReturned) { try { request?.finish(false); } finally { response.finish(false); } }
          throw error;
        } finally {
          const capacityWindowEndMs = performance.now(), checks = capacityObserver.checks.slice(checkStart);
          detail.capacity = { startMs: capacityWindowStartMs, endMs: capacityWindowEndMs, checks, maximumGapMs: capacityRecheckGapMs(capacityWindowStartMs, capacityWindowEndMs, checks),
            method: 'Actual production Objects.capacity completion clocks; maximum gap includes the active transfer leading and trailing intervals. The observer adds no capacity checks.' };
        }
        transfers.push({ role: file.purpose, ...detail });
      });
    }
    let firstTransferEndMs = performance.now();
    await closeDatabase(); latestIO = await resumeWriter();
    if (input.direction === 'download') {
      const weightsOriginal = await phase('downloaded-weights-owned-hash-durable', detail => latestIO.stage(downloaded[0], 'adapter', detail));
      const configOriginal = await phase('downloaded-config-owned-hash-durable', detail => latestIO.stage(downloaded[1], 'caption', detail));
      const registered = await phase('downloaded-header-profile-config-registration-durable', detail => latestIO.register(weightsOriginal, configOriginal, 'WA downloaded adapter', detail));
      assert.equal(registered.adapter.qualification, 'structurally-valid'); assert.equal(registered.adapter.validation.locallyEligible, false); observations.registered = registered;
      firstTransferEndMs = performance.now();
    }
    observations.firstTransferStartMs = firstTransferStartMs; observations.firstTransferEndMs = firstTransferEndMs;
    observations.firstTransferToBothDurableMs = firstTransferEndMs - firstTransferStartMs;
    observations.capacityRecheckGapMs = transfers.every(transfer => transfer.capacity.maximumGapMs !== null) ? Math.max(...transfers.map(transfer => transfer.capacity.maximumGapMs)) : null;
    observations.assertions = [
      { id: 'real-byte-transfer', passed: true, evidence: files.map(file => ({ bytes: file.bytes, hash: file.hash })) },
      { id: 'production-transport-and-r31', passed: true, evidence: 'Actual providerBoundary, queue.inputStream, queue sinks and durable protected bodies; local fixture credentials only.' },
      { id: 'independent-transfer-identities', passed: new Set(transfers.map(value => value.attemptId)).size === files.length, evidence: transfers.map(value => value.attemptId) },
    ];
    assert.deepEqual(network.errors, []);
    await close();
    return { observations, close, missing: ['20/100 Mbps pacing and 40 ms application response delay are observed; prescribed N physical RTT/loss shaping lacks independent host evidence.',
      ...(observations.capacityRecheckGapMs === null ? ['No complete actual production capacity-check observation covers every adapter transfer.'] : [])] };
  } catch (error) { await close(); throw error; }
}

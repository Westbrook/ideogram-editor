import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { command, encode } from '../store/helpers.mjs';
import { auth, caption, ui, enqueue, envelope } from '../queue/helpers.mjs';
import { emulator, fixtureProfile } from '../provider/emulator.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { StoreDatabase } from '../../dist/local/server/storage/database.js';
import { acquireRoot } from '../../dist/local/server/storage/ownership.js';
import { QueueDispatcher } from '../../dist/local/server/provider/dispatcher.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { newDraft, bindRequestMask, confirmRequestMask } from '../../dist/local/src/request/core.js';

// This is the unmodified public example retained from Fal's official V4 LoRA
// example. No download, credential lookup or production provider call occurs.
// A missing optional large fixture is an explicit skip, never synthetic evidence.
const fixturePath = resolve(process.env.IE_ADAPTER_FIXTURE ?? 'artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors');
const expectedWeights = { hash: 'sha256:bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5', byteLength: '85299896', mediaType: 'application/octet-stream' };
const chunkLimit = 1048576;
const objectPath = (root, ref) => join(root, 'objects', 'sha256', ref.hash.slice(7, 9), ref.hash.slice(7));
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

async function hashFile(path) {
  const digest = createHash('sha256'); let bytes = 0, maxChunk = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: chunkLimit })) { digest.update(chunk); bytes += chunk.length; maxChunk = Math.max(maxChunk, chunk.length); }
  return { hash: 'sha256:' + digest.digest('hex'), byteLength: String(bytes), maxChunk };
}
async function finish(w, c, method) {
  await w[method](encode(c), auth()); let record;
  for (let i = 0; i < 2000 && !record; i++) { record = await w.lookup(c.command.commandId); if (!record) await new Promise(r => setTimeout(r, 5)); }
  assert.equal(record?.receipt.status, 'accepted', JSON.stringify(record));
  return (await w.events(String(BigInt(record.receipt.fromSeq) - 1n))).events.find(e => e.commandId === c.command.commandId);
}
async function own(w, chunks, ref, purpose) {
  const stagingId = randomUUID();
  await w.assetCreate({ protocolVersion: 1, stagingId, purpose, expectedBytes: ref.byteLength, sha256: ref.hash, mediaType: ref.mediaType }, auth());
  let offset = 0;
  for await (const bytes of chunks) { assert(bytes.length <= chunkLimit); const token = await w.assetBeginChunk(stagingId, String(offset), bytes.length, auth()); await w.assetChunk(token, bytes, auth()); offset += bytes.length; }
  assert.equal(String(offset), ref.byteLength);
  return (await finish(w, envelope({ type: 'FinalizeStaging', stagingId, expectedSha256: ref.hash }), 'assetCommand')).payload.asset;
}
async function register(w, weights, patch = {}) {
  return (await finish(w, envelope({ type: 'RegisterAdapterVersion', adapterId: null, previousVersionId: null, weightsAssetId: weights.id,
    configAssetId: null, provenanceAssetId: null, name: 'Official Fal V4 example', declaredFamily: 'ideogram-v4', declaredFormat: 'fal',
    provenanceText: 'Unmodified official Fal Ideogram V4 LoRA example. Config not supplied by this example. Local structural eligibility only; no provider runtime verification.', ...patch }), 'adapterCommand')).payload.asset;
}
async function save(w, d, generation) {
  const asset = await caption(w, JSON.stringify(d));
  const result = await ui(w, { type: 'SaveDraft', draft: { id: 'adapter_flow_draft', generation, kind: 'request', documentId: 'document_1', targetLayerId: null,
    expectedDocumentRevision: await w.documentRevision('document_1'), assetId: asset.id, composing: false } });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  return asset;
}
async function review(w, generation) { return ui(w, { type: 'PrepareRequestReview', draftId: 'adapter_flow_draft', generation }); }
async function accepted(w, generation) {
  const p = await review(w, generation); assert.equal(p.status, 'accepted', JSON.stringify(p));
  const a = await ui(w, { type: 'AcceptRequestReview', reviewId: p.review.id, token: p.review.token });
  assert.equal(a.status, 'accepted', JSON.stringify(a)); assert.equal(a.acceptedReview, p.review.id);
  return { review: p.review, body: { type: 'QueueInference', reviewId: p.review.id, token: p.review.token, acceptanceId: a.requestId } };
}
async function sourceAndMask(w, root) {
  const bytes = await readFile(new URL('../raster/fixtures/hidden-alpha.png', import.meta.url));
  const original = await own(w, [bytes], { hash: sha(bytes), byteLength: String(bytes.length), mediaType: 'image/png' }, 'image');
  const prepared = (await finish(w, envelope({ type: 'PrepareRaster', assetId: original.id }), 'rasterCommand')).payload.asset;
  const reviewId = (await finish(w, envelope({ type: 'ReviewRaster', assetId: prepared.id }), 'rasterCommand')).payload.reviewId;
  const r = await w.rasterReview(reviewId, auth());
  const asset = (await finish(w, envelope({ type: 'ApproveRaster', assetId: prepared.id, reviewId, reviewHash: r.reviewHash }), 'rasterCommand')).payload.asset;
  const history = async body => {
    const c = envelope(body); c.command.documentId = 'document_1'; c.command.expectedDocumentRevision = await w.documentRevision('document_1');
    return finish(w, c, 'historyCommand');
  };
  await history({ type: 'ImportAsset', assetId: asset.id, layerId: 'adapter_source_layer', name: 'Adapter source', draft: null });
  const document = await w.document('document_1');
  const capture = (await history({ type: 'PrepareRequestSource', scope: 'single-layer', layerIds: ['adapter_source_layer'] })).payload.asset;
  const source = { assetId: capture.id, version: capture.version, blob: capture.blob, pixels: capture.raster.pixels, width: 3, height: 2,
    scope: 'single-layer', documentRevision: document.revision, capture: capture.raster.manifest };
  const retained = (await finish(w, envelope({ type: 'PrepareRequestMask', sourceAssetId: source.assetId,
    plan: { width: 3, height: 2, feather: 0, operations: [{ kind: 'shape', shape: { kind: 'rectangle', x: 1, y: 0, width: 1, height: 2 }, mode: 'replace' }] }, clip: null }), 'rasterCommand')).payload.asset;
  const manifest = JSON.parse(await readFile(objectPath(root, retained.raster.manifest), 'utf8'));
  const mask = { assetId: retained.id, version: retained.version, blob: retained.blob, pixels: retained.raster.pixels, width: 3, height: 2,
    sourceHash: source.pixels.hash, polarity: 'white-edit', fullAcknowledged: false, empty: false, full: false, plan: retained.raster.manifest, binding: bindRequestMask(source) };
  mask.requestPlan = confirmRequestMask(source, mask, manifest.plan.hard, manifest.plan.effective, 'adapter-flow-mask-review');
  assert.equal((await w.imageState('document_1')).layers[0].mask, null);
  return { source, mask, document };
}
async function localDatabase(root) {
  const owner = await acquireRoot(root), db = new StoreDatabase(root, () => {}); let closed = false;
  return { db, async close() { if (closed) return; closed = true; await db.queue.close(); await db.portables.close(); await db.histories.close(); await db.rasters.close(); await db.assets.close(); await db.recovery.settle(); db.close(); owner.close(); } };
}

test('official retained V4 LoRA flows through immutable library, acknowledged reviews, all adapter routes and bounded loopback dispatch', { timeout: 180000 }, async t => {
  let fixtureStat;
  try { fixtureStat = await stat(fixturePath); } catch (error) { if (error.code !== 'ENOENT') throw error; t.skip('The optional official 85,299,896-byte Fal LoRA fixture is absent; retain the verified artifact or set IE_ADAPTER_FIXTURE. No fixture is downloaded by this test.'); return; }
  assert.equal(fixtureStat.size, Number(expectedWeights.byteLength));
  const fixtureIdentity = await hashFile(fixturePath); assert.equal(fixtureIdentity.hash, expectedWeights.hash);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'p27-adapter-flow-'));
  let writer = await openWriter({ root }), owned = null, server = null;
  t.after(async () => { if (server) await new Promise(resolveClose => server.close(resolveClose)); if (owned) await owned.close(); if (writer) await writer.close(); await rm(root, { recursive: true, force: true }); });
  await writer.rememberClient(auth().sessionHash, 'client_1', auth().expires); await writer.protocolDefaults();
  assert.equal((await writer.submit(encode(command(EMPTY_EXPECTED_VERSIONS, {}, { width: 3, height: 2 })), writer.epoch)).status, 'accepted');
  const original = await own(writer, createReadStream(fixturePath, { highWaterMark: chunkLimit }), expectedWeights, 'adapter');
  const versions = [];
  await t.test('exact known weights are eligible with config absence recorded and immutable logical versioning', async () => {
    versions.push(await register(writer, original));
    versions.push(await register(writer, original, { adapterId: versions[0].adapter.adapterId, previousVersionId: versions[0].id, name: 'Official example metadata v2' }));
    versions.push(await register(writer, original, { name: 'Separate retained logical adapter' }));
    assert.equal(versions[1].adapter.version, '2'); assert.equal(versions[1].adapter.adapterId, versions[0].adapter.adapterId);
    assert.notEqual(versions[2].adapter.adapterId, versions[0].adapter.adapterId); assert.equal(new Set(versions.map(v => v.id)).size, 3);
    for (const version of versions) {
      assert.deepEqual(version.blob, expectedWeights); assert.deepEqual(version.adapter.weights, original.blob);
      assert.equal(version.adapter.config, null); assert.equal(version.adapter.sources.configAssetId, null);
      assert.equal(version.adapter.validation.locallyEligible, true); assert.equal(version.adapter.validation.profileId, 'v4-fal-public-example-1');
      assert.equal(version.adapter.validation.runtimeVerified, false); assert.equal(version.adapter.qualification, 'structurally-valid');
      const entry = await writer.adapterView(version.id); assert.equal(entry.locallyEligible, true); assert.equal(entry.runtimeVerified, false);
      const provenance = JSON.parse(await readFile(objectPath(root, version.adapter.origin.provenance), 'utf8'));
      assert.match(provenance.statement, /Config not supplied/); assert.equal(provenance.original, null);
      assert.deepEqual((await writer.assetProjection(version.id)).asset, version);
    }
    assert.equal((await hashFile(objectPath(root, original.blob))).hash, expectedWeights.hash);
  });
  const prompt = await caption(writer, 'A retained V4 example. Keep the literal word "loras" in this prompt.');
  const draft = newDraft(prompt.blob); draft.operation = 'generate-adapters'; draft.fields.seed = '900719925474099312345';
  draft.adapters = [versions[1], versions[0], versions[2]].map((v, i) => ({ version: v.id, hash: v.blob.hash, scale: ['0', '4', '0.125'][i], runtimeAcknowledged: false }));
  await t.test('saving preserves unacknowledged versions but review rejects before queue or provider effects', async () => {
    const saved = await save(writer, draft, '1'), p = await review(writer, '1');
    assert.equal(p.status, 'rejected'); assert.match(p.reason, /ADAPTER_RUNTIME_ACK_REQUIRED/);
    assert.deepEqual(JSON.parse(await readFile(objectPath(root, saved.blob), 'utf8')).adapters, draft.adapters);
    assert.equal((await writer.queueView()).jobs.length, 0);
  });
  const raster = await sourceAndMask(writer, root), jobs = [];
  await t.test('one, two and three exact versions prepare, accept and queue on source, mask and generation routes', async () => {
    for (const [index, operation] of ['transform-adapters', 'inpaint-adapters', 'generate-adapters'].entries()) {
      const d = structuredClone(draft); d.operation = operation; d.adapters = d.adapters.slice(0, index + 1).map(a => ({ ...a, runtimeAcknowledged: true }));
      if (operation !== 'generate-adapters') { d.source = raster.source; d.fields.size = 'auto'; d.fields.strength = '0.8'; }
      if (operation === 'inpaint-adapters') d.mask = raster.mask;
      const generation = String(index + 2); await save(writer, d, generation); const p = await accepted(writer, generation), q = await enqueue(writer, p.body);
      jobs.push(q.job); assert.deepEqual(q.job.review.request.adapters, d.adapters);
      assert.equal(q.job.review.endpoint, ['ideogram/v4/image-to-image/lora', 'ideogram/v4/inpaint/lora', 'ideogram/v4/lora'][index]);
      const stages = q.job.stagePlan.filter(s => s.role.startsWith('adapter:'));
      assert.equal(stages.length, index + 1);
      for (const [at, stage] of stages.entries()) { assert.equal(stage.role, 'adapter:' + at); assert.equal(stage.versionId, d.adapters[at].version); assert.deepEqual(stage.original, expectedWeights); assert.deepEqual(stage.transport, expectedWeights); }
      assert.equal(q.job.stagePlan.filter(s => s.role === 'source').length, operation === 'generate-adapters' ? 0 : 1);
      assert.equal(q.job.stagePlan.filter(s => s.role === 'mask').length, operation === 'inpaint-adapters' ? 1 : 0);
      const template = await readFile(objectPath(root, q.job.review.template), 'utf8'); assert.match(template, /"seed":900719925474099312345/);
      assert.deepEqual(JSON.parse(template).loras, d.adapters.map(a => ({ path: 'asset:' + a.hash, scale: Number(a.scale) })));
      if (operation === 'inpaint-adapters') { assert.deepEqual(q.job.review.request.mask.requestPlan, raster.mask.requestPlan); assert.equal(JSON.parse(template).mask_url, 'asset:' + raster.mask.blob.hash); }
    }
    assert.deepEqual(await writer.document('document_1'), raster.document);
  });
  await t.test('successor discovery leaves already queued exact adapter versions and transport stages unchanged', async () => {
    const beforeJobs = (await writer.queueView()).jobs, oldEntry = await writer.adapterView(versions[0].id);
    const successor = await register(writer, original, { adapterId: versions[1].adapter.adapterId, previousVersionId: versions[1].id, name: 'Later library version after queue acceptance' });
    const updates = await writer.adapterUpdates(versions[0].id);
    assert.deepEqual(updates.current, oldEntry); assert.equal(updates.latest.versionId, successor.id); assert.equal(updates.latest.version, '3');
    assert.equal((await writer.adapterUpdates(successor.id)).latest, null);
    assert.deepEqual((await writer.queueView()).jobs, beforeJobs);
    for (const version of versions) assert.deepEqual((await writer.assetProjection(version.id)).asset, version);
    for (const job of beforeJobs) assert.equal(job.stagePlan.some(stage => stage.versionId === successor.id), false);
  });
  await writer.close(); writer = await openWriter({ root });
  await t.test('restart preserves version identities, queue stages and accepted immutable requests', async () => {
    for (const version of versions) assert.deepEqual((await writer.assetProjection(version.id)).asset, version);
    const retained = (await writer.queueView()).jobs;
    for (const job of jobs) { const after = retained.find(v => v.id === job.id); assert.deepEqual(after.stagePlan, job.stagePlan); assert.deepEqual(after.review, job.review); }
  });
  await writer.close(); writer = null;
  owned = await localDatabase(root);
  const observed = [], streams = [], serverErrors = []; let origin = '';
  server = createServer(async (req, res) => {
    try {
      const digest = createHash('sha256'); let count = 0, bytes = 0, maxChunk = 0; const control = [];
      for await (const part of req) { digest.update(part); bytes += part.length; count++; maxChunk = Math.max(maxChunk, part.length); if (req.url !== '/upload') { assert(bytes <= 65536); control.push(part); } }
      const observation = { method: req.method, path: req.url, hash: 'sha256:' + digest.digest('hex'), byteLength: String(bytes), chunks: count, maxChunk,
        contentLength: req.headers['content-length'], storeIO: req.headers['x-fal-store-io'] };
      observed.push(observation); res.setHeader('Content-Type', 'application/json');
      if (req.url === '/upload') {
        assert.equal(req.method, 'POST'); assert.equal(observation.hash, expectedWeights.hash); assert.equal(observation.byteLength, expectedWeights.byteLength);
        assert.equal(observation.contentLength, expectedWeights.byteLength); assert.equal(observation.storeIO, '0');
        res.end(JSON.stringify({ url: origin + '/media/weights-' + observed.length }));
      } else {
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/ideogram/v4/lora');
        const text = Buffer.concat(control).toString('utf8'); observation.body = text; assert.match(text, /"seed":900719925474099312345/);
        assert.equal(req.headers['x-fal-no-retry'], '1'); assert.equal(req.headers['x-app-fal-disable-fallback'], 'true');
        assert.deepEqual(JSON.parse(text).loras, [0, 4, 0.125].map((scale, i) => ({ path: origin + '/media/weights-' + (i + 1), scale })));
        const base = origin + '/ideogram/v4/lora/requests/local_adapter_request';
        res.end(JSON.stringify({ request_id: 'local_adapter_request', status_url: base + '/status', response_url: base, cancel_url: base + '/cancel' }));
      }
    } catch (error) { serverErrors.push(error); res.statusCode = 500; res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port;
  await t.test('actual Dispatcher streams exact weights once per positional adapter with bounded chunks and no buffered upload API', async () => {
    const base = emulator({ queueOrigin: origin, mediaOrigin: origin, uploadOrigin: origin, profiles: [fixtureProfile({ endpoint: 'ideogram/v4/lora' })] });
    const provider = { ...base, async upload(url, attempt, request, sink) {
      assert.equal(Object.hasOwn(request, 'bytes'), false); assert.equal(typeof request.chunks, 'function'); assert.equal(request.byteLength, BigInt(expectedWeights.byteLength));
      const stream = { opens: 0, chunks: 0, maxChunk: 0, bytes: 0, hash: null }, digest = createHash('sha256'); streams.push(stream);
      const chunks = request.chunks;
      const result = await base.upload(url, attempt, { ...request, chunks: async function* () {
        stream.opens++; assert.equal(stream.opens, 1);
        for await (const part of chunks()) { assert(part instanceof Uint8Array); assert(part.length > 0 && part.length <= chunkLimit); stream.chunks++; stream.bytes += part.length; stream.maxChunk = Math.max(stream.maxChunk, part.length); digest.update(part); yield part; }
        stream.hash = 'sha256:' + digest.digest('hex');
      } }, sink);
      assert.equal(result.outcome, 'complete'); assert.equal(stream.hash, expectedWeights.hash); assert.equal(String(stream.bytes), expectedWeights.byteLength); assert(stream.chunks > 1);
      return result;
    } };
    // Any accidental use of the old whole-object request reader fails this test.
    owned.db.queue.input = () => { throw Error('Whole-object upload reader must not be used'); };
    const dispatcher = new QueueDispatcher(owned.db.queue, provider, { profileId: 'local-fixture-v1', queueOrigin: origin, uploadURL: origin + '/upload', mediaOrigin: origin });
    // The generation route is deliberately third in the retained queue. Move it
    // explicitly rather than bypassing the product's durable FIFO reservation.
    const beforeOrder = owned.db.queue.view();
    assert.deepEqual(beforeOrder.jobs.map(job => job.id), jobs.map(job => job.id));
    assert.equal(await dispatcher.submit(jobs[2].id), null);
    assert.equal(observed.length, 0); assert.equal(streams.length, 0); assert.deepEqual(owned.db.queue.view(), beforeOrder);
    for (const neighborId of [jobs[1].id, jobs[0].id]) {
      const current = owned.db.queue.view(), target = current.jobs.find(job => job.id === jobs[2].id), neighbor = current.jobs.find(job => job.id === neighborId);
      assert(target); assert(neighbor);
      const moved = await owned.db.queue.command(encode(envelope({ type: 'ReorderLocalQueue', jobId: target.id, expectedVersion: target.version,
        neighborId: neighbor.id, expectedNeighborVersion: neighbor.version, expectedOrderVersion: current.orderVersion, direction: 'up' })), auth());
      assert.equal(moved.status, 'accepted', JSON.stringify(moved));
    }
    const reordered = owned.db.queue.view();
    assert.deepEqual(reordered.jobs.map(job => job.id), [jobs[2].id, jobs[0].id, jobs[1].id]); assert.deepEqual(reordered.counts, beforeOrder.counts);
    for (const original of beforeOrder.jobs) {
      const current = reordered.jobs.find(job => job.id === original.id); assert(current);
      assert.deepEqual(current.review, original.review); assert.deepEqual(current.stagePlan, original.stagePlan); assert.deepEqual(current.attempts, original.attempts);
      assert.equal(current.order.insertionOrdinal, original.order.insertionOrdinal);
    }
    const result = await dispatcher.submit(jobs[2].id); assert.deepEqual(serverErrors, []); assert(result, 'Explicitly reordered generation job must be reservable'); assert.equal(result.attempts[0].state, 'acknowledged');
    assert.equal(result.attempts[0].requestId, 'local_adapter_request'); assert.equal(streams.length, 3); assert.equal(observed.length, 4);
    assert.equal(await dispatcher.submit(jobs[2].id), null); assert.equal(observed.length, 4);
    assert.equal(owned.db.queue.view().counts.dispatched, 1); assert.equal(owned.db.queue.view().jobs.filter(j => j.attempts[0].state === 'not-started').length, 2);
    assert.equal((await hashFile(objectPath(root, original.blob))).hash, expectedWeights.hash);
  });
  const out = resolve(process.env.ADAPTER_EVIDENCE ?? 'artifacts/p27-evidence/integration'); await mkdir(out, { recursive: true });
  await writeFile(join(out, 'flow-' + randomUUID() + '.json'), JSON.stringify({ kind: 'p27-local-adapter-flow-1', fixture: fixtureIdentity,
    versions: versions.map(v => v.adapter), requests: jobs.map(j => ({ id: j.id, endpoint: j.review.endpoint, request: j.review.request, stagePlan: j.stagePlan })),
    streams, observed, productionCalls: 0, runtimeVerified: false, limits: ['Loopback emulator transport proves no provider model behavior.', 'The exact public artifact profile grants local eligibility only.'] }, null, 2));
});

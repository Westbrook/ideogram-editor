// Small genuine seed component. Only the explicitly bounded literal-loopback
// provider is substituted; capture, review, queue, ingestion and decode are real.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startMaskedFixtureProvider} from './fixture-masked.mjs';

const MiB = 1048576, GRID = 512, ENDPOINT = 'ideogram/v4/inpaint';
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const abort = signal => signal?.throwIfAborted();
const eventAsset = result => {
  const asset = result.events.find(event => event.type === 'AssetRegistered')?.payload.asset;
  assert(asset?.raster && asset.availability === 'available' && asset.safety === 'safe', 'Real accepted canonical asset required');
  return asset;
};

async function verifyCandidate(candidate, signal) {
  assert(candidate && typeof candidate === 'object');
  assert.equal(candidate.width, GRID); assert.equal(candidate.height, GRID); assert.equal(candidate.format, 'png');
  assert(typeof candidate.path === 'string' && isAbsolute(candidate.path) && resolve(candidate.path) === candidate.path);
  assert.equal(await realpath(candidate.path), candidate.path, 'Candidate must have a direct local path');
  const sha256 = String(candidate.sha256).replace(/^sha256:/, ''); assert.match(sha256, /^[a-f0-9]{64}$/);
  const byteLength = String(candidate.byteLength); assert.match(byteLength, /^[1-9][0-9]*$/); assert(BigInt(byteLength) <= 32n * BigInt(MiB));
  const stat = await lstat(candidate.path); assert(stat.isFile() && !stat.isSymbolicLink()); assert.equal(String(stat.size), byteLength);
  const file = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash('sha256');
  const buffer = Buffer.alloc(MiB), header = Buffer.alloc(24); let bytes = 0, headerBytes = 0;
  try {
    const identity = await file.stat(); assert.equal(identity.ino, stat.ino); assert.equal(identity.dev, stat.dev);
    for (;;) {
      abort(signal); const {bytesRead} = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      const part = buffer.subarray(0, bytesRead); digest.update(part); bytes += bytesRead; assert(bytes <= 32 * MiB);
      const take = Math.min(part.length, header.length - headerBytes); if (take) { part.copy(header, headerBytes, 0, take); headerBytes += take; }
    }
    const final = await file.stat(); assert.equal(final.size, stat.size); assert.equal(final.mtimeMs, stat.mtimeMs); assert.equal(final.ctimeMs, stat.ctimeMs);
  } finally { await file.close(); }
  assert.equal(String(bytes), byteLength); assert.equal(digest.digest('hex'), sha256); assert.equal(headerBytes, header.length);
  assert(header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(header.readUInt32BE(8), 13); assert.equal(header.toString('ascii', 12, 16), 'IHDR');
  assert.equal(header.readUInt32BE(16), GRID); assert.equal(header.readUInt32BE(20), GRID);
  return {path: candidate.path, sha256: 'sha256:' + sha256, byteLength, width: GRID, height: GRID, format: 'png'};
}

async function findJob(writer, id, signal) {
  let cursor = '';
  do { abort(signal); const page = await writer.queueView(cursor), job = page.jobs.find(item => item.id === id); if (job) return job; cursor = page.nextCursor; } while (cursor);
  throw Error('The accepted seed queue command has no retained job');
}

function verifyContributions(store, capture, canonical, signal) {
  const manifest = store.rasters.manifest(capture.id), refs = new Map();
  assert.equal(manifest.plan.kind, 'request-source-capture-v1');
  const add = ref => { assert(ref && /^sha256:[a-f0-9]{64}$/.test(ref.hash)); refs.set(canonical(ref), ref); };
  const bytes = (ref, maximum) => {
    abort(signal); const length = BigInt(ref.byteLength); assert(length >= 0n && length <= BigInt(maximum));
    const value = Buffer.alloc(Number(length)), digest = createHash('sha256'); let offset = 0;
    // Pixel bodies exceed the returned-metadata cap. Owned ranges retain exact
    // object-size/EOF checks while each bounded chunk releases its reservation.
    do {
      abort(signal); const requested = Math.min(65536, value.length - offset);
      const range = store.objects.readRangeOwned(ref, String(offset), requested);
      try {
        assert.equal(range.bytes.byteLength, requested); value.set(range.bytes, offset);
        digest.update(range.bytes); offset += range.bytes.byteLength;
      } finally { range.release(); }
    } while (offset < value.length);
    assert.equal(String(offset), ref.byteLength); assert.equal(String(value.length), ref.byteLength);
    assert.equal('sha256:' + digest.digest('hex'), ref.hash); add(ref); return value;
  };
  const metadata = ref => { const value = bytes(ref, 65536), parsed = JSON.parse(value.toString('utf8')); assert.equal(canonical(parsed), value.toString('utf8')); return parsed; };
  const stack = metadata(manifest.plan.contributions);
  assert.equal(stack.kind, 'cp1-contribution-stack-v1'); assert.equal(stack.schemaVersion, 1);
  assert.equal(stack.pipeline, manifest.pipeline); assert.deepEqual([stack.width, stack.height], [GRID, GRID]);
  assert(Array.isArray(stack.contributions) && stack.contributions.length > 0 && stack.contributions.length === manifest.plan.layers.length);
  // Production verifies source/mask edges and every contribution manifest before
  // this independent exact-pixel/tile pass. Reads remain one 512-grid at a time.
  for (const ref of store.rasters.contributionRefs(manifest)) add(ref);
  for (const [index, entry] of stack.contributions.entries()) {
    const value = metadata(entry.manifest), pixels = bytes(entry.pixels, GRID * GRID * 4);
    assert.equal(pixels.length, GRID * GRID * 4); assert.equal(value.plan.kind, 'cp1-layer-contribution-v1');
    assert.equal(value.pipeline, stack.pipeline); assert.deepEqual([value.width, value.height], [GRID, GRID]);
    assert.deepEqual(value.plan.layer, manifest.plan.layers[index]); assert.deepEqual(value.pixels, entry.pixels);
    assert.equal(entry.pixelIdentity, hash(Buffer.from(canonical({pipeline: value.pipeline, width: value.width, height: value.height, tiles: value.tiles}))));
    for (const tile of value.tiles) {
      abort(signal); assert([tile.x, tile.y, tile.width, tile.height].every(Number.isSafeInteger));
      assert(tile.x >= 0 && tile.y >= 0 && tile.width > 0 && tile.height > 0 && tile.x + tile.width <= GRID && tile.y + tile.height <= GRID);
      const digest = createHash('sha256');
      for (let y = tile.y; y < tile.y + tile.height; y++) digest.update(pixels.subarray((y * GRID + tile.x) * 4, (y * GRID + tile.x + tile.width) * 4));
      assert.equal('sha256:' + digest.digest('hex'), tile.hash);
    }
  }
  return [...refs.values()];
}

async function closeOwned(store, provider, owner, priorError) {
  const errors = [];
  // Close the emitter first, then drain all real product owners before releasing
  // the root. A failed close must not prevent later cleanup or hide the cause.
  const closes = [
    () => provider?.close(),
    () => store?.storageRepairs.close(),
    () => store?.displays.close(),
    () => store?.candidates.close(),
    () => store?.queue.close(),
    () => store?.portables.close(),
    () => store?.histories.close(),
    () => store?.rasters.close(),
    () => store?.assets.close(),
    () => store?.recovery.settle(),
    () => store?.storageLibrary.close(),
    () => store?.storageMemory.close(),
  ];
  for (const close of closes) try { await close(); } catch (error) { errors.push(error); }
  if (store) try {
    assert.equal(store.objects.reservationInventory().activeTransfers, 0);
    assert.equal(store.texts.reservedCPU, 0);
    const raster = store.rasters.resourceOwnership(); assert.equal(raster.activeWorkers, 0); assert.equal(raster.bookedCPUBytes, 0);
    assert.equal(raster.compositionMemory.borrowers + raster.compositionMemory.loans + raster.compositionMemory.contentReaders, 0);
  } catch (error) { errors.push(error); }
  try { store?.close(); } catch (error) { errors.push(error); }
  try { owner?.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError([...(priorError ? [priorError] : []), ...errors], 'Mixed seed candidate preparation or owned cleanup failed');
}

/** Called after the seed's final document edit. The host supplies the ordinary
 * command/staging/UI helpers and closes/reopens its writer around the sole
 * explicit provider phase. No network policy or producer method is replaced. */
export async function seedMixedWCCandidate(ctx, {candidate, signal, onProgress} = {}) {
  abort(signal);
  for (const name of ['getwriter', 'auth', 'execute', 'stage', 'ui', 'withClosedWriter']) assert.equal(typeof ctx[name], 'function');
  assert(isAbsolute(ctx.repo) && resolve(ctx.repo) === ctx.repo && isAbsolute(ctx.root) && resolve(ctx.root) === ctx.root);
  assert.match(ctx.documentId, /^[A-Za-z0-9_-]+$/); assert.match(ctx.sessionId, /^[A-Za-z0-9_-]+$/);
  const report = async phase => { abort(signal); await onProgress?.({component: 'mixed-wc-candidate', phase}); abort(signal); };
  await report('verify-local-candidate'); const file = await verifyCandidate(candidate, signal);
  const load = path => import(pathToFileURL(join(ctx.repo, 'dist/local', path)).href);
  const [{newDraft, bindRequestMask, confirmRequestMask}, {canonical}, {acquireRoot}, {StoreDatabase}] = await Promise.all([
    load('src/request/core.js'), load('server/storage/canonical.js'), load('server/storage/ownership.js'), load('server/storage/database.js'),
  ]);
  const writer = ctx.getwriter(), before = await writer.document(ctx.documentId), sourceEpoch = writer.epoch;
  assert(before?.image?.compositeAssetId, 'Seed requires a real complete raster/native source document');
  assert.deepEqual([before.width, before.height], [GRID, GRID]);
  await report('capture-canonical-source');
  const capture = eventAsset(await ctx.execute({type: 'PrepareRequestSource', scope: 'visible-document', layerIds: []}, 'historyCommand', true));
  const captureManifest = await writer.rasterManifest(capture.id);
  assert.equal(captureManifest.plan.kind, 'request-source-capture-v1'); assert.equal(captureManifest.plan.capture.documentRevision, before.revision);
  assert.deepEqual(captureManifest.plan.capture.image, before.image); assert(captureManifest.plan.contributions);
  const composite = (await writer.assetProjection(before.image.compositeAssetId)).asset;
  assert.deepEqual(capture.raster.pixels, composite.raster.pixels);
  const source = {assetId: capture.id, version: capture.version, blob: capture.blob, pixels: capture.raster.pixels, width: GRID, height: GRID, scope: 'visible-document', documentRevision: before.revision, capture: capture.raster.manifest};
  await report('prepare-feathered-mask');
  const maskAsset = eventAsset(await ctx.execute({type: 'PrepareRequestMask', sourceAssetId: capture.id,
    plan: {width: GRID, height: GRID, feather: 16, operations: [{kind: 'shape', shape: {kind: 'rectangle', x: 128, y: 128, width: 256, height: 256}, mode: 'replace'}]}, clip: null}, 'rasterCommand', false));
  const maskManifest = await writer.rasterManifest(maskAsset.id), statistics = maskManifest.plan.statistics;
  assert(statistics.effectivePixels > 0 && statistics.effectivePixels < GRID * GRID); assert.notEqual(maskManifest.plan.hard.hash, maskManifest.plan.effective.hash);
  const mask = {assetId: maskAsset.id, version: maskAsset.version, blob: maskAsset.blob, pixels: maskAsset.raster.pixels, width: GRID, height: GRID, sourceHash: source.pixels.hash,
    polarity: 'white-edit', fullAcknowledged: false, empty: false, full: false, plan: maskAsset.raster.manifest, binding: bindRequestMask(source)};
  mask.requestPlan = confirmRequestMask(source, mask, maskManifest.plan.hard, maskManifest.plan.effective, randomUUID());
  await report('review-one-masked-request');
  const prompt = await ctx.stage(Buffer.from('Local mixed seed masked candidate. Preserve pixels outside the reviewed region.'), 'caption', 'text/plain');
  const draft = newDraft(prompt.blob); draft.operation = 'inpaint'; draft.source = source; draft.mask = mask; draft.guidanceAcknowledged = true;
  Object.assign(draft.fields, {size: 'auto', width: String(GRID), height: String(GRID), speed: 'BALANCED', strength: '1', count: '1', expansion: 'None', format: 'png', acceleration: 'none', seed: '31'});
  const draftAsset = await ctx.stage(Buffer.from(JSON.stringify(draft)), 'caption', 'text/plain'), draftId = 'mixed_seed_masked_' + randomUUID();
  const saved = await ctx.ui({type: 'SaveDraft', draft: {id: draftId, generation: '1', kind: 'request', documentId: ctx.documentId, targetLayerId: null, expectedDocumentRevision: before.revision, assetId: draftAsset.id, composing: false}});
  assert.equal(saved.status, 'accepted'); const reviewed = await ctx.ui({type: 'PrepareRequestReview', draftId, generation: '1'}); assert.equal(reviewed.status, 'accepted');
  assert.equal(reviewed.review.endpoint, ENDPOINT);
  const accepted = await ctx.ui({type: 'AcceptRequestReview', reviewId: reviewed.review.id, token: reviewed.review.token}); assert.equal(accepted.status, 'accepted');
  const queued = await ctx.execute({type: 'QueueInference', reviewId: reviewed.review.id, token: reviewed.review.token, acceptanceId: accepted.requestId}, 'queueCommand', false);
  const jobId = queued.events.find(event => event.type === 'JobQueued')?.payload.id; assert(jobId);
  const job = await findJob(writer, jobId, signal); assert.deepEqual(job.stagePlan.map(item => item.role).sort(), ['mask', 'source']);
  assert.equal(job.attempts.length, 1); assert.equal(job.attempts[0].state, 'not-started');
  let result;
  await report('complete-one-loopback-candidate');
  await ctx.withClosedWriter(async () => {
    abort(signal); let owner, store, provider, primaryError;
    const stop = () => { provider?.observer.close(); provider?.dispatcher.close(); };
    try {
      owner = await acquireRoot(ctx.root); abort(signal); store = new StoreDatabase(ctx.root, () => {});
      assert.deepEqual(store.document(ctx.documentId), before);
      const contributions = verifyContributions(store, capture, canonical, signal);
      const plan = {endpoint: ENDPOINT, count: 1, width: GRID, height: GRID, candidates: [file]};
      provider = await startMaskedFixtureProvider({repo: ctx.repo, signal}, store, plan, job.stagePlan);
      signal?.addEventListener('abort', stop, {once: true}); abort(signal); provider.jobIds.add(jobId);
      const acknowledgement = await provider.dispatcher.submit(jobId); assert.equal(acknowledgement.attempts.at(-1).state, 'acknowledged');
      provider.controls.status = 'COMPLETED'; await provider.observer.tick(); abort(signal);
      const view = store.candidates.view(jobId); assert.equal(view.items.length, 1); const retained = view.items[0];
      assert.equal(retained.state, 'prepared'); assert.equal(retained.safety, 'safe'); assert(retained.encodedAssetId && retained.preparedAssetId);
      const encoded = store.assets.asset(retained.encodedAssetId), prepared = store.assets.asset(retained.preparedAssetId);
      assert(encoded && prepared?.raster); assert.equal(encoded.blob.hash, file.sha256); assert.equal(encoded.blob.byteLength, file.byteLength);
      store.objects.verify(encoded.blob); store.objects.verify(prepared.blob); store.objects.verify(prepared.raster.pixels);
      assert.deepEqual([prepared.raster.width, prepared.raster.height], [GRID, GRID]); assert.equal(prepared.qualification, 'canonical-raster');
      const work = store.queue.recovery(jobId, retained.attemptId); assert.equal(work.attempt.hold, false); assert.equal(work.attempt.state, 'provider-terminal');
      assert.equal(work.attempt.terminal, 'completed'); assert.deepEqual(store.document(ctx.documentId), before);
      assert.equal(provider.uploads.length, 2); assert.deepEqual(provider.errors, []);
      const counts = {submissions: 0, uploads: 0, status: 0, results: 0, media: 0};
      for (const effect of provider.effects) {
        if (effect.method === 'POST' && effect.path === '/' + ENDPOINT) counts.submissions++;
        else if (effect.method === 'POST' && effect.path === '/upload') counts.uploads++;
        else if (effect.method === 'GET' && effect.path.endsWith('/status')) counts.status++;
        else if (effect.method === 'GET' && effect.path.startsWith('/image/')) counts.media++;
        else if (effect.method === 'GET' && effect.path.startsWith('/' + ENDPOINT + '/requests/')) counts.results++;
        else assert.fail('Unexpected local fixture operation');
      }
      assert.deepEqual(counts, {submissions: 1, uploads: 2, status: 1, results: 1, media: 1});
      const uploads = provider.uploads.map(({url, path: _path, ...entry}) => { const parsed = new URL(url); assert.equal(parsed.hostname, '127.0.0.1'); assert(parsed.port); return entry; });
      result = {kind: 'mixed-wc-candidate-component-1', qualification: false, documentId: ctx.documentId, sourceEpoch, providerEpoch: store.epoch,
        input: file, source, mask, requestPlan: mask.requestPlan, contributions, jobId, attemptId: retained.attemptId,
        candidate: {id: retained.id, jobId: retained.jobId, attemptId: retained.attemptId, encodedAssetId: retained.encodedAssetId, preparedAssetId: retained.preparedAssetId, state: retained.state, safety: retained.safety},
        assets: {encoded, prepared}, frozenReview: {id: reviewed.review.id, endpoint: reviewed.review.endpoint},
        localIO: {scope: 'literal-127.0.0.1-fixture', profileId: 'qualification-masked-v1', profileMode: 'fixture', counts, uploads,
          effects: provider.effects.map(({method, path, bytes, sha256, role}) => ({method, path, bytes, ...(sha256 ? {sha256} : {}), ...(role ? {role} : {})})),
          networkClaim: 'Explicit local HTTP fixture activity; no zero-network or live-provider qualification claim'},
        sourceDocumentUnchanged: true, closed: false};
    } catch (error) { primaryError = error; throw error; }
    finally { signal?.removeEventListener('abort', stop); await closeOwned(store, provider, owner, primaryError); }
    result.closed = true;
  });
  abort(signal); assert(result?.closed); assert.deepEqual(await ctx.getwriter().document(ctx.documentId), before);
  await report('candidate-component-closed'); return result;
}

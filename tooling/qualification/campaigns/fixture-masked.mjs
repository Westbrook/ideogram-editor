// Real public-command masked request fixture. The transport is a bounded local
// HTTP emulator; source capture, R16 mask, request review, uploads, durable queue
// fences, result ingestion and candidate decoding are all product operations.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { product, phase } from './backend-common.mjs';
import { fileIdentity } from './fixtures.mjs';

const ENDPOINT = 'ideogram/v4/inpaint';
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const assertAsset = completed => { const asset = completed.events.find(event => event.type === 'AssetRegistered')?.payload.asset; assert(asset?.raster, 'Real raster registration required'); return asset; };

export function maskedFixturePlan(specification, corpus) {
  assert(['W1', 'W2', 'WXn', 'WXs', 'WA'].includes(specification?.id), 'Masked fixture requires a named actual image workload');
  assert([1, 4].includes(specification.candidates));
  const { width, height } = specification;
  assert(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 256 && height > 256 && width <= 8192 && height <= 8192 && width * height <= 25000000);
  const candidates = corpus.files.filter(file => file.role === 'candidate').slice(0, specification.candidates);
  assert.equal(candidates.length, specification.candidates, 'Exact retained candidate count required');
  for (const file of candidates) {
    assert.equal(file.width, width); assert.equal(file.height, height); assert.equal(String(file.format).replace(/^image\//, ''), 'png');
    assert.match(file.sha256, /^sha256:[a-f0-9]{64}$/); assert.match(String(file.byteLength), /^[1-9][0-9]*$/);
  }
  return { endpoint: ENDPOINT, scope: 'visible-document', count: specification.candidates, width, height, candidates,
    maskPlan: { width, height, feather: 64, operations: [{ kind: 'shape', shape: { kind: 'rectangle', x: Math.floor(width / 4), y: Math.floor(height / 4), width: Math.floor(width / 2), height: Math.floor(height / 2) }, mode: 'replace' }] },
    representation: { original: 'authoritative canonical CP-1 capture plus encoded PNG', mask: 'authoritative retained hard/effective R16 plus encoded preview and binary upload', candidate: 'original encoded PNG plus authoritative normalized canonical raster', preservedComposite: 'absent until explicit preparation or acceptance', strictEncodedOnlyC: false } };
}

async function findJob(writer, id) { let cursor = ''; do { const page = await writer.queueView(cursor), job = page.jobs.find(job => job.id === id); if (job) return job; cursor = page.nextCursor; } while (cursor); throw Error('Queued fixture job is missing'); }
async function smallBody(request, maximum = 65536) { const chunks = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; assert(bytes <= maximum, 'Masked fixture control body exceeds its bound'); chunks.push(chunk); } return Buffer.concat(chunks); }
async function writeAll(file, bytes) { let offset = 0; while (offset < bytes.length) { const written = await file.write(bytes, offset, bytes.length - offset); assert(written.bytesWritten > 0); offset += written.bytesWritten; } }

/** Only declared frozen transport hashes are accepted. Upload bodies are written
 * in bounded chunks to owner-only files, never accumulated in a JS buffer. */
export async function startMaskedFixtureProvider(context, store, plan, stagePlan) {
  const { emulator, fixtureProfile } = await import(pathToFileURL(join(context.repo, 'tests/provider/emulator.mjs')).href);
  const { QueueDispatcher } = await product(context, 'server/provider/dispatcher.js');
  const { ResultObserver } = await product(context, 'server/provider/observer.js');
  assert.deepEqual(stagePlan.map(item => item.role).sort(), ['mask', 'source']);
  const transports = new Map(stagePlan.map(item => [item.role, item.transport]));
  const directory = join(store.root, 'qualification-masked-uploads-' + randomUUID()); await mkdir(directory, { mode: 0o700 });
  const effects = [], uploads = [], requests = new Map(), sockets = new Set(), pending = new Set(), errors = [];
  const controls = { status: 'IN_QUEUE' }; let origin = '', closing = false;
  const server = createServer(async (req, res) => {
    let settle; const work = new Promise(resolve => { settle = resolve; }); pending.add(work);
    try {
      const pathname = new URL(req.url, origin).pathname;
      if (req.method === 'POST' && pathname === '/upload') {
        const id = 'upload_' + randomUUID(), path = join(directory, id + '.png'), file = await open(path, 'wx', 0o600), digest = createHash('sha256'); let bytes = 0;
        try {
          for await (const chunk of req) { context.signal?.throwIfAborted(); bytes += chunk.length; assert(bytes <= 32 * 1048576, 'Masked source/mask upload exceeds its declared encoded envelope'); digest.update(chunk); await writeAll(file, chunk); }
          await file.sync();
        } finally { await file.close(); }
        const sha256 = 'sha256:' + digest.digest('hex'), roles = [...transports].filter(([, ref]) => ref.hash === sha256 && ref.byteLength === String(bytes)).map(([role]) => role);
        assert.equal(roles.length, 1, 'Upload must match exactly one immutable frozen source/mask transport');
        const upload = { id, role: roles[0], path, bytes, sha256, url: origin + '/uploaded/' + id }; uploads.push(upload); effects.push({ method: 'POST', path: pathname, bytes, sha256, role: upload.role, atMs: performance.now() });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: upload.url })); return;
      }
      const body = await smallBody(req); effects.push({ method: req.method, path: pathname, bytes: body.length, sha256: hash(body), atMs: performance.now() });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && pathname === '/' + ENDPOINT) {
        const value = JSON.parse(body.toString('utf8')), source = uploads.find(upload => upload.url === value.image_url), mask = uploads.find(upload => upload.url === value.mask_url);
        assert.equal(source?.role, 'source'); assert.equal(mask?.role, 'mask'); assert.notEqual(source.id, mask.id); assert.equal(value.num_images, plan.count); assert.equal(value.image_size, 'auto'); assert.equal(value.output_format, 'png');
        const requestId = 'masked_' + randomUUID(); requests.set(requestId, { requestId, prompt: value.prompt, sourceUploadId: source.id, maskUploadId: mask.id });
        const base = origin + '/' + ENDPOINT + '/requests/' + requestId;
        res.end(JSON.stringify({ request_id: requestId, status_url: base + '/status', response_url: base, cancel_url: base + '/cancel' })); return;
      }
      if (req.method === 'GET' && pathname.startsWith('/image/')) {
        const match = /^\/image\/([^/]+)\/([0-3])$/.exec(pathname); assert(match && requests.has(match[1])); const file = plan.candidates[Number(match[2])]; assert(file);
        res.setHeader('Content-Type', 'image/png'); res.setHeader('Content-Length', String(file.byteLength));
        await pipeline(createReadStream(file.path, { highWaterMark: 65536 }), res, context.signal ? { signal: context.signal } : {}); return;
      }
      const match = /^\/ideogram\/v4\/inpaint\/requests\/([^/]+)(\/status|\/cancel)?$/.exec(pathname); assert(match && requests.has(match[1]), 'Only owned inpaint identities are allowed');
      const request = requests.get(match[1]);
      if (match[2] === '/status') { assert.equal(req.method, 'GET'); res.end(JSON.stringify({ request_id: request.requestId, status: controls.status })); }
      else if (match[2] === '/cancel') res.end(JSON.stringify({ request_id: request.requestId, status: 'CANCELLING' }));
      else { assert.equal(req.method, 'GET'); res.end(JSON.stringify({ images: plan.candidates.map((file, index) => ({ url: origin + '/image/' + request.requestId + '/' + index, content_type: 'image/png', file_size: Number(file.byteLength), width: file.width, height: file.height })), prompt: request.prompt, seed: 31, has_nsfw_concepts: plan.candidates.map(() => false) })); }
    } catch (error) { if (!closing) errors.push({ code: error.code ?? error.name, message: error.message }); if (!res.headersSent) { res.statusCode = 500; res.end('{}'); } else res.destroy(); }
    finally { pending.delete(work); settle(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fixtureProfile({ id: 'qualification-masked-v1', endpoint: ENDPOINT });
  const provider = emulator({ queueOrigin: origin, mediaOrigin: origin, uploadOrigin: origin, profiles: [profile] });
  const dispatcher = new QueueDispatcher(store.queue, provider, { queueOrigin: origin, mediaOrigin: origin, uploadURL: origin + '/upload', profileId: profile.id });
  // Only the new local requests are observable; already-retained active jobs
  // from other fixture work cannot accidentally reach this temporary endpoint.
  const jobIds = new Set(), candidates = new Proxy(store.candidates, { get(target, key) {
    if (key === 'due') return now => target.due(now, jobId => jobIds.has(jobId));
    if (key === 'retries') return () => target.retries(jobId => jobIds.has(jobId));
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const observer = new ResultObserver(candidates, provider, dispatcher, profile.id);
  return { controls, effects, uploads, errors, jobIds, dispatcher, observer,
    async close() { if (closing) return; closing = true; observer.close(); dispatcher.close(); const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy(); await closed; await Promise.allSettled([...pending]); assert.deepEqual(errors, []); },
  };
}

/** fixture-product must invoke this AFTER its final document-changing padding.
 * Later workspace-only padding preserves the frozen source revision. */
export async function seedMaskedProductCandidates(input) {
  const plan = maskedFixturePlan(input.specification, input.corpus), phases = [], context = { repo: resolve(input.repo ?? process.cwd()), signal: input.signal };
  for (const file of plan.candidates) { const identity = await fileIdentity(file.path); assert.equal(identity.sha256, file.sha256); assert.equal(identity.byteLength, String(file.byteLength)); }
  const before = await input.writer.document(input.documentId); assert(before?.image?.compositeAssetId, 'Actual complete source document required');
  const captureAsset = assertAsset(await phase(phases, 'capture-canonical-visible-source', () => input.execute({ type: 'PrepareRequestSource', scope: 'visible-document', layerIds: [] }, 'historyCommand', true)));
  const captureManifest = await input.writer.rasterManifest(captureAsset.id); assert.equal(captureManifest.plan.kind, 'request-source-capture-v1');
  assert.equal(captureManifest.plan.capture.documentRevision, before.revision); assert.deepEqual(captureManifest.plan.capture.image, before.image);
  const completeComposite = (await input.writer.assetProjection(before.image.compositeAssetId)).asset; assert.deepEqual(captureAsset.raster.pixels, completeComposite.raster.pixels, 'Visible CP-1 capture must equal the actual complete document pixels');
  const source = { assetId: captureAsset.id, version: captureAsset.version, blob: captureAsset.blob, pixels: captureAsset.raster.pixels, width: plan.width, height: plan.height, scope: 'visible-document', documentRevision: before.revision, capture: captureAsset.raster.manifest };
  const maskAsset = assertAsset(await phase(phases, 'prepare-independent-feathered-request-mask', () => input.execute({ type: 'PrepareRequestMask', sourceAssetId: source.assetId, plan: plan.maskPlan, clip: null }, 'rasterCommand')));
  const manifest = await input.writer.rasterManifest(maskAsset.id), statistics = manifest.plan.statistics;
  assert(statistics.effectivePixels > 0 && statistics.effectivePixels < plan.width * plan.height); assert.notEqual(manifest.plan.hard.hash, manifest.plan.effective.hash, 'Feather64 must retain distinct authored/effective R16');
  const { newDraft, bindRequestMask, confirmRequestMask } = await product(context, 'src/request/core.js');
  const mask = { assetId: maskAsset.id, version: maskAsset.version, blob: maskAsset.blob, pixels: maskAsset.raster.pixels, width: plan.width, height: plan.height, sourceHash: source.pixels.hash, polarity: 'white-edit', fullAcknowledged: false, empty: false, full: false, plan: maskAsset.raster.manifest, binding: bindRequestMask(source) };
  mask.requestPlan = confirmRequestMask(source, mask, manifest.plan.hard, manifest.plan.effective, randomUUID());
  const prompt = await input.stage(Buffer.from('Local qualification of a frozen masked edit. Preserve pixels outside the reviewed region.'), 'caption'), draft = newDraft(prompt.blob);
  Object.assign(draft.fields, { size: 'auto', width: String(plan.width), height: String(plan.height), speed: 'BALANCED', strength: '1', count: String(plan.count), expansion: 'None', format: 'png', acceleration: 'none', seed: '900719925474099312345' });
  draft.operation = 'inpaint'; draft.source = source; draft.mask = mask; draft.guidanceAcknowledged = true;
  const draftAsset = await input.stage(Buffer.from(JSON.stringify(draft)), 'caption'), draftId = 'qualification_masked_' + randomUUID();
  await input.ui({ type: 'SaveDraft', draft: { id: draftId, generation: '1', kind: 'request', documentId: input.documentId, targetLayerId: null, expectedDocumentRevision: before.revision, assetId: draftAsset.id, composing: false } });
  const review = await input.ui({ type: 'PrepareRequestReview', draftId, generation: '1' }); assert.equal(review.status, 'accepted');
  const accepted = await input.ui({ type: 'AcceptRequestReview', reviewId: review.review.id, token: review.review.token }); assert.equal(accepted.status, 'accepted');
  const body = { type: 'QueueInference', reviewId: review.review.id, token: review.review.token, acceptanceId: accepted.requestId };
  const queue = async () => { const complete = await input.execute(body, 'queueCommand'), id = complete.events.find(event => event.type === 'JobQueued')?.payload.id; assert(id); return findJob(input.writer, id); };
  const completed = await phase(phases, 'queue-reviewed-masked-completed-request', queue), active = await phase(phases, 'queue-reviewed-masked-active-request', queue);
  assert.deepEqual(completed.stagePlan.map(item => item.role).sort(), ['mask', 'source']); assert.deepEqual(active.stagePlan, completed.stagePlan);
  let evidence;
  await input.withClosedWriter(async ({ configureSnapshotStore } = {}) => {
    const { acquireRoot } = await product(context, 'server/storage/ownership.js'), { StoreDatabase } = await product(context, 'server/storage/database.js');
    const owner = await acquireRoot(input.root); let store, provider, restoreSnapshotScheduler;
    try {
      store = new StoreDatabase(input.root, () => {}); restoreSnapshotScheduler = configureSnapshotStore?.(store);
      provider = await startMaskedFixtureProvider(context, store, plan, completed.stagePlan); provider.jobIds.add(completed.id); provider.jobIds.add(active.id);
      const acknowledged = await provider.dispatcher.submit(completed.id); assert.equal(acknowledged.attempts.at(-1).state, 'acknowledged');
      provider.controls.status = 'COMPLETED'; await provider.observer.tick();
      const view = store.candidates.view(completed.id); assert.equal(view.items.length, plan.count); assert(view.items.every(candidate => candidate.state === 'prepared' && candidate.preparedAssetId && candidate.encodedAssetId));
      provider.controls.status = 'IN_QUEUE'; await provider.dispatcher.submit(active.id); assert.equal(store.queue.recovery(active.id, active.attempts[0].id).attempt.hold, true);
      assert.equal(provider.effects.filter(effect => effect.method === 'POST' && effect.path === '/' + ENDPOINT).length, 2); assert.equal(provider.uploads.length, 4);
      assert.equal(store.document(input.documentId).revision, before.revision); assert.deepEqual(store.document(input.documentId).image, before.image);
      evidence = { kind: 'masked-candidate-fixture-1', requiresStableSourceRevision: true, capturedDocumentRevision: before.revision, captureImage: before.image, documentId: input.documentId,
        completedJobId: completed.id, activeJobId: active.id, candidateIds: view.items.map(candidate => candidate.id), candidates: view.items.map(candidate => ({ id: candidate.id, jobId: candidate.jobId, attemptId: candidate.attemptId, encodedAssetId: candidate.encodedAssetId, preparedAssetId: candidate.preparedAssetId })),
        source, mask, requestPlan: mask.requestPlan, frozenReview: { id: review.review.id, endpoint: review.review.endpoint }, stagePlan: completed.stagePlan,
        representation: plan.representation, preservedCompositePrepared: false, sourceScope: 'visible-document', recommendedPlacement: input.specification.layers >= 100 ? 'new-document' : 'current-document', effectiveMaskStatistics: statistics,
        uploads: provider.uploads.map(({ url: _url, ...upload }) => upload), effects: provider.effects, phases, providerCalls: 0, loopbackSubmissions: 2,
        activeRecoveryAfterSealing: 'Known local-emulator attempt stays held. The temporary endpoint closes after preparation.',
        readinessLimits: ['Prepared candidate is the retained normalized candidate, not a preserved result composite.', 'Canonical source/candidate/R16 bytes are authoritative and retained. This is not a strict encoded-only three-decode C fixture.', 'A/B require a separate explicit preserved-composite preparation and real viewport cache witness; C acceptance requires an explicit metadata-only placement review.'] };
    } finally {
      try { await provider?.close(); }
      finally {
        try {
          if (store) {
            let failure;
            for (const close of [() => store.candidates.close(), () => store.queue.close(), () => store.portables.close(), () => store.histories.close(), () => store.rasters.close(), () => store.assets.close(), () => store.recovery.settle()]) { try { await close(); } catch (error) { failure ??= error; } }
            try { store.close(); } catch (error) { failure ??= error; }
            if (failure) throw failure;
          }
        } finally { owner.close(); restoreSnapshotScheduler?.(); }
      }
    }
  });
  return evidence;
}
seedMaskedProductCandidates.requiresStableSourceRevision = true;

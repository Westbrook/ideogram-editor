// Read-only M-series byte witnesses. Verifies authored geometry, candidate-layer
// pixels and durable Undo; never claims native display or reference mask pixels.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { publicRead, prepareBrowserGestures } from './browser-driver.mjs';
import { validateRecordedStroke } from './browser-gesture-state.mjs';

const MiB = 1048576, MAX_PIXELS = 25000000, MAX_ENCODED = 128 * MiB;
const SHA = /^sha256:[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/;
const pixelKind = 'independent-png-decoded-canonical-rgba-1';
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const check = (condition, message) => { if (!condition) throw Error('LIFECYCLE_ORACLE: ' + message); };

export function validateLoopbackOrigin(origin) {
  const value = new URL(origin);
  check(value.protocol === 'http:' && value.hostname === '127.0.0.1' && value.port !== '' && !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash && value.origin === origin, 'only the exact owned literal-loopback origin is allowed');
  return value.origin;
}

export function validatedBlobRef(ref, maxBytes = Number.MAX_SAFE_INTEGER) {
  check(ref && SHA.test(ref.hash) && typeof ref.byteLength === 'string' && /^(0|[1-9][0-9]*)$/.test(ref.byteLength) && typeof ref.mediaType === 'string' && ref.mediaType.length > 0 && ref.mediaType.length <= 256, 'invalid blob identity');
  check(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && BigInt(ref.byteLength) <= BigInt(maxBytes), 'blob exceeds its bounded verification budget');
  return { hash: ref.hash, byteLength: ref.byteLength, mediaType: ref.mediaType };
}

async function* checkedChunks(source, expected, { signal, maxBytes = MAX_ENCODED } = {}) {
  const ref = validatedBlobRef(expected, maxBytes), digest = createHash('sha256');
  let length = 0;
  signal?.throwIfAborted();
  for await (const part of source) {
    signal?.throwIfAborted();
    check(part instanceof Uint8Array, 'byte stream produced a non-byte chunk');
    length += part.byteLength;
    check(length <= Number(ref.byteLength), 'content exceeded its declared byte length');
    digest.update(part); yield part;
  }
  signal?.throwIfAborted();
  check(String(length) === ref.byteLength && 'sha256:' + digest.digest('hex') === ref.hash, 'full content hash or byte length mismatch');
}

/** Hash actual bounded bytes; neither Content-Length nor ETag is a byte proof. */
export async function hashByteStream(source, expected, options = {}) {
  for await (const _part of checkedChunks(source, expected, options)) { /* consume the complete stream */ }
  return { ...validatedBlobRef(expected, options.maxBytes ?? MAX_ENCODED), verification: 'complete-stream-sha256' };
}

export function lifecyclePixelEquality(before, after) {
  const valid = value => value?.kind === pixelKind && value.decodedEntirePNG === true && value.canonicalPixelsFullyHashed === true &&
    Number.isSafeInteger(value.width) && value.width > 0 && value.width <= 8192 && Number.isSafeInteger(value.height) && value.height > 0 && value.height <= 8192 && value.width * value.height <= MAX_PIXELS &&
    value.channels === 4 && value.byteLength === String(value.width * value.height * 4) && SHA.test(value.sha256) && value.sha256 === value.canonicalSha256;
  check(valid(before) && valid(after), 'pixel equality requires two complete independent decode and canonical-byte witnesses');
  return before.width === after.width && before.height === after.height && before.byteLength === after.byteLength && before.sha256 === after.sha256;
}

/** The reviewed operation replaces one image slot. Its full document can still
 * contain other visible images/text and must never be equated to this layer. */
export function verifyReplacementState(before, after, replacement) {
  const id = replacement?.id ?? replacement?.layerId, version = replacement?.version ?? replacement?.layerVersion;
  check(ID.test(id ?? '') && /^(0|[1-9][0-9]*)$/.test(version ?? ''), 'replacement needs its exact prior layer/version');
  const index = before.layers.findIndex(layer => layer.id === id), target = after.layers[index], prior = before.layers[index];
  check(index >= 0 && prior.kind === 'image' && prior.visible === true && prior.locked === false && prior.version === version && target?.id === id, 'replacement target or slot changed');
  assert.deepEqual(after, { ...before, layers: before.layers.map((layer, at) => at !== index ? layer : { ...layer,
    version: String(BigInt(version) + 1n), name: target.name, assetId: target.assetId, layerToDocument: [1, 0, 0, 1, 0, 0], opacity: 1, mask: null }) }, 'Replacement changed another layer, order, extent, or target property');
  check(typeof target.name === 'string' && ID.test(target.assetId), 'replacement asset identity is absent');
  return { target, index };
}

/** Geometry uses actual delivered native coordinates, with the established
 * browser precision policy, and then exact equality to the persisted operation.
 * It is not a reference rasterization of the R16 mask or document pixels. */
export function verifyAuthoredStroke({ stroke, specimen, document, beforeImage, afterImage, manifest, baselineManifest }) {
  check(stroke?.accepted === true && stroke.receipt?.status === 'accepted' && stroke.receipt.documentId === document.id, 'durable accepted stroke receipt required');
  check(stroke.specimenId === specimen.id && specimen.samples.length === 120 && specimen.brushDiameter === 64, 'stroke differs from its sealed specimen');
  assert.deepEqual(stroke.plan?.points.map(point => [point.documentX, point.documentY]), specimen.samples.map(point => [point.x, point.y]), 'native input plan differs from the sealed document geometry');
  check(stroke.plan.documentId === document.id && stroke.plan.revision === document.revision && stroke.plan.document.width === document.width && stroke.plan.document.height === document.height, 'native stroke belongs to a different document revision');
  const recorded = validateRecordedStroke({ observation: stroke.native, plan: stroke.plan, completion: stroke.completion });
  check(recorded.status === 'PASS' && recorded.productAppendQualified === true, 'actual native stroke and successful authored append did not qualify');
  const targetId = stroke.target?.id, prior = beforeImage.layers.find(layer => layer.id === targetId), target = afterImage.layers.find(layer => layer.id === targetId), completion = stroke.completion.detail;
  check(prior?.kind === 'image' && prior.visible && !prior.locked && prior.version === stroke.target.version && completion.targetLayerId === targetId && completion.targetLayerVersion === prior.version, 'accepted authored mask targets another layer/version');
  check(target?.mask?.mapping === 'document-r16-v1' && target.mask.inverted === false, 'accepted stroke did not attach its authored R16 mask');
  assert.deepEqual(afterImage, { ...beforeImage, layers: beforeImage.layers.map(layer => layer.id !== targetId ? layer : { ...layer, version: String(BigInt(layer.version) + 1n), mask: target.mask }) }, 'stroke changed content outside the target layer mask');
  const authoring = manifest?.plan?.authoring;
  check(['authored-mask-v1', 'authored-mask-v2'].includes(manifest?.plan?.kind) && authoring?.width === document.width && authoring.height === document.height, 'accepted mask has no exact-grid authored plan');
  let prefix = [], feather = 0;
  if (prior.mask) {
    if (['retained-r16-v1', 'retained-luminance-alpha-v1'].includes(prior.mask.mapping)) {
      prefix = [{ kind: 'retained-hard-v1', mask: prior.mask, hard: prior.mask.mapping === 'retained-r16-v1' ? baselineManifest.plan.hard : null }];
      feather = baselineManifest.plan.authoring?.feather ?? 0;
    } else if (prior.mask.mapping === 'document-r16-v1' && baselineManifest?.plan?.authoring) {
      prefix = structuredClone(baselineManifest.plan.authoring.operations); feather = baselineManifest.plan.authoring.feather;
      if (prior.mask.inverted) prefix.push({ kind: 'invert' });
    } else prefix = [{ kind: 'import', assetId: prior.mask.assetId, x: 0, y: 0, width: document.width, height: document.height, inverted: prior.mask.inverted }];
  }
  assert.deepEqual(authoring.operations.slice(0, -1), prefix, 'stroke did not preserve its exact attached mask baseline');
  check(authoring.feather === feather && authoring.operations.length === prefix.length + 1 && completion.operationCount === authoring.operations.length, 'stroke added extra operations or changed feather');
  const operation = authoring.operations.at(-1);
  check(operation?.kind === 'stroke' && operation.points.length === 120 && operation.size === 64 && operation.hardness === 1 && operation.mode === 'add', 'authored stroke size, count, hardness or action changed');
  const geometrySha256 = hash(JSON.stringify(operation.points));
  check(geometrySha256 === completion.geometrySha256, 'durable authored mask differs from the actual consumed native geometry');
  return { targetLayerId: targetId, maskAssetId: target.mask.assetId, sampleCount: 120, brushDiameter: 64, geometrySha256,
    native: { clock: recorded.clock, timeOrigin: recorded.timeOrigin, coordinatePrecision: recorded.coordinatePrecision, productAppendQualified: true }, independentRasterization: false };
}

async function assetResponse(page, origin, asset, signal) {
  check(ID.test(asset.id), 'invalid public asset ID'); validatedBlobRef(asset.blob);
  signal?.throwIfAborted();
  // Cookies remain transient request authority. Neither cookie, URL nor headers
  // are returned in evidence, logged, persisted or copied to another origin.
  const cookies = await page.context().cookies(origin);
  const headers = { 'X-App-Client': 'LP-1', Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Accept-Encoding': 'identity', Cookie: cookies.map(cookie => cookie.name + '=' + cookie.value).join('; ') };
  const response = await new Promise((resolveResponse, reject) => {
    const pending = request(new URL('/api/v1/assets/' + asset.id + '/content', origin), { method: 'GET', headers, signal, agent: false }, resolveResponse);
    pending.once('error', () => reject(Error('LIFECYCLE_ORACLE: public asset content request failed')));
    pending.setTimeout(30000, () => pending.destroy(Error('Public asset read deadline exceeded'))); pending.end();
  });
  try {
    check(response.statusCode === 200, 'public asset content unavailable (' + response.statusCode + ')');
    check(response.headers.etag === '"' + asset.blob.hash + '"' && response.headers['content-length'] === asset.blob.byteLength && !response.headers['content-encoding'], 'public asset content identity headers changed');
    return response;
  } catch (error) { response.destroy(); throw error; }
}

/**
 * One instance belongs to one prepared M cell and survives its cycles. The
 * initial complete closure proof is retained using the production immutable
 * object stamp contract. Each current composite is independently decoded again.
 * completeSeries() rehashes every retained input; close() only releases proofs.
 * All spans are real elapsed observer work and MUST remain charged to the run.
 */
export async function createLifecycleOracle({ page, fixture, root, origin, repo = process.cwd(), signal }) {
  validateLoopbackOrigin(origin);
  check(root && root !== fixture?.root && ID.test(fixture?.documentId ?? ''), 'oracle requires the owned private fixture copy and document identity');
  check(fixture?.seal?.sha256 && fixture?.corpus?.files && fixture?.extensions?.candidates, 'sealed corpus and real masked candidate fixture required');
  const load = path => import(pathToFileURL(resolve(repo, 'dist/local', path)).href);
  const [{ Objects }, files, { retainedMetadataReferences }, { references }, validate] = await Promise.all([
    load('server/storage/objects.js'), load('server/storage/files.js'), load('server/portable/retained.js'), load('server/portable/format.js'), load('src/protocol/validate.js'),
  ]);
  // Objects' existing production constructor validates these directories. Check
  // existence first so this read-only observer can never create a missing tree.
  files.assertComponents(root);
  for (const directory of [root, join(root, 'objects'), join(root, 'objects', 'sha256'), join(root, 'staging')]) files.assertPrivate(directory, true);
  let closed = false, completed = false, baselineDocument, baselinePixels, candidatePixels, candidateAsset, gestures, cycleBefore, cycleBeforeImage, strokeImage, strokePixels, strokeGeometry, adoptionPixels, adoptionPlacement, undoAdoptionPixels = false, restored = false, cycle = 0;
  const checkOpen = () => { signal?.throwIfAborted(); check(!closed, 'oracle is closed'); };
  const objects = new Objects(root, checkOpen, () => { throw Error('LIFECYCLE_ORACLE: read-only object observer attempted a mutation'); });
  const assets = new Map(), refs = new Map(), proofs = new Map(), pendingAssets = new Set(), inspected = new Set(), inspectable = new Set();
  const spans = [], checkpoints = [];
  let cycleSpanStart = 0, totalPublicBytes = 0n, totalProvedBytes = 0n, finalClosure = null;
  const counts = () => ({ assets: assets.size, objects: refs.size, uniqueObjectBytes: String([...refs.values()].reduce((sum, ref) => sum + BigInt(ref.byteLength), 0n)), publicBytesRead: String(totalPublicBytes), objectBytesHashed: String(totalProvedBytes) });
  async function span(name, work) {
    checkOpen(); const value = { name, startMs: performance.now(), endMs: null, outcome: 'running', clock: 'runner-monotonic', chargedObserverWork: true }; spans.push(value);
    try { const result = await work(); value.outcome = 'ok'; return result; } catch (error) { value.outcome = 'failed'; throw error; } finally { value.endMs = performance.now(); }
  }
  const keyOf = ref => ref.hash + ':' + ref.mediaType;
  function addRef(input, inspect = false) {
    const ref = validatedBlobRef(input), key = keyOf(ref), old = refs.get(key);
    if (old) check(old.byteLength === ref.byteLength, 'conflicting retained object lengths'); else refs.set(key, ref);
    if (inspect && !inspectable.has(key)) { inspectable.add(key); inspected.delete(key); }
    return ref;
  }
  function addAsset(id) { check(ID.test(id ?? ''), 'retained graph has an invalid asset ID'); if (!assets.has(id)) pendingAssets.add(id); }
  async function fullProof(ref, retain = false) {
    checkOpen(); const token = await objects.prove(ref, checkOpen); totalProvedBytes += BigInt(ref.byteLength);
    if (retain) { const key = keyOf(ref), old = proofs.get(key); if (old) objects.releaseProof(old); proofs.set(key, token); }
    else objects.releaseProof(token);
  }
  async function publicAsset(id) {
    const value = (await publicRead(page, '/api/v1/assets/' + id)).projection.value;
    validate.asset(value); check(value.id === id && value.availability === 'available', 'retained asset is unavailable'); return value;
  }
  async function verifyAssetContent(asset) {
    const response = await assetResponse(page, origin, asset, signal);
    try { await hashByteStream(response, asset.blob, { signal, maxBytes: Number.MAX_SAFE_INTEGER }); totalPublicBytes += BigInt(asset.blob.byteLength); }
    finally { response.destroy(); }
  }
  async function candidateBindings() {
    const frozen = fixture.extensions.candidates, groups = new Map();
    check(Array.isArray(frozen.candidates) && frozen.candidates.length === fixture.definition.candidates && new Set(frozen.candidates.map(candidate => candidate.id)).size === frozen.candidates.length, 'complete unique frozen candidate batch is required');
    for (const candidate of frozen.candidates) {
      check([candidate.id, candidate.jobId, candidate.attemptId, candidate.encodedAssetId, candidate.preparedAssetId].every(value => ID.test(value ?? '')), 'candidate binding has an invalid identity');
      const key = candidate.jobId + '/' + candidate.attemptId;
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(candidate);
    }
    for (const candidates of groups.values()) {
      const { jobId, attemptId } = candidates[0], view = await publicRead(page, '/api/v1/jobs/' + jobId + '/candidates?attempt=' + attemptId);
      check(view.documentId === fixture.documentId && view.nextCursor === null, 'frozen candidate owner or bounded batch changed');
      for (const candidate of candidates) {
        const actual = view.items.find(value => value.id === candidate.id);
        check(actual?.state === 'prepared' && actual.jobId === jobId && actual.attemptId === attemptId && actual.encodedAssetId === candidate.encodedAssetId && actual.preparedAssetId === candidate.preparedAssetId, 'actual retained candidate no longer matches its sealed encoded/canonical binding');
      }
      assert.deepEqual(view.request?.raster?.source, frozen.source, 'Frozen public request source changed');
      assert.deepEqual(view.request?.raster?.mask, frozen.mask, 'Frozen public request mask changed');
    }
  }
  async function walkClosure(document, state) {
    addRef(document.image.state, true);
    addAsset(document.image.compositeAssetId);
    for (const layer of state.layers) { addAsset(layer.assetId); if (layer.mask) addAsset(layer.mask.assetId); if (layer.kind === 'text') addRef(layer.source, true); }
    const frozen = fixture.extensions.candidates;
    for (const id of [...(fixture.originalAssetIds ?? []), ...(fixture.rasterAssetIds ?? []), fixture.maskAssetId, frozen.source?.assetId, frozen.mask?.assetId, fixture.candidate?.encodedAssetId, fixture.candidate?.preparedAssetId].filter(Boolean)) addAsset(id);
    await candidateBindings();
    for (const candidate of frozen.candidates) { addAsset(candidate.encodedAssetId); addAsset(candidate.preparedAssetId); }
    references(frozen.source, addRef); references(frozen.mask, addRef);
    if (frozen.source?.capture) addRef(frozen.source.capture, true);
    if (frozen.mask?.plan) addRef(frozen.mask.plan, true);
    for (;;) {
      checkOpen();
      if (pendingAssets.size) {
        const id = pendingAssets.values().next().value; pendingAssets.delete(id);
        const asset = await publicAsset(id); assets.set(id, asset); references(asset, addRef);
        for (const sourceId of asset.raster?.sourceAssetIds ?? []) addAsset(sourceId);
        if (asset.raster) {
          addRef(asset.raster.manifest, true);
          const manifest = await publicRead(page, '/api/v1/assets/' + id + '/raster');
          validate.rasterManifest(manifest);
          check(manifest.width === asset.raster.width && manifest.height === asset.raster.height && canonical(manifest.pixels) === canonical(asset.raster.pixels), 'public raster metadata disagrees with its asset');
          references(manifest, addRef);
        }
        continue;
      }
      const entry = [...refs.entries()].find(([key]) => !inspected.has(key));
      if (!entry) break;
      const [key, ref] = entry; inspected.add(key); await fullProof(ref, true);
      if (inspectable.has(key)) {
        check(ref.mediaType === 'application/json' && BigInt(ref.byteLength) <= 65536n, 'retained typed metadata exceeds the production control bound');
        objects.proven(ref, proofs.get(key));
        const bytes = objects.readRange(ref, '0', Number(ref.byteLength));
        check(hash(bytes) === ref.hash, 'retained metadata changed while reading');
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        for (const child of retainedMetadataReferences(value)) addRef(child.ref, child.inspect);
        if (Array.isArray(value?.layers) && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)) {
          for (const layer of value.layers) { if (layer.assetId) addAsset(layer.assetId); if (layer.mask) addAsset(layer.mask.assetId); if (layer.kind === 'text') addRef(layer.source, true); }
        }
        objects.proven(ref, proofs.get(key));
      }
    }
    // Explicitly bind the complete public original inventory to the sealed
    // corpus, rather than calling a source/candidate subset the full original set.
    const originals = fixture.corpus.files.filter(file => file.role === 'raster-original');
    check(originals.length === fixture.definition.imageLayers && originals.length > 0, 'sealed raster original inventory is incomplete');
    for (const original of originals) check([...assets.values()].some(asset => asset.blob.hash === original.sha256 && asset.blob.byteLength === original.byteLength), 'a sealed original is absent from the actual retained asset closure');
    for (const input of [frozen.source, frozen.mask]) {
      const asset = assets.get(input.assetId);
      assert.deepEqual(asset.blob, input.blob); assert.deepEqual(asset.raster?.pixels, input.pixels);
      check(asset.version === input.version && asset.raster.width === input.width && asset.raster.height === input.height, 'frozen source/mask asset version or grid changed');
    }
    for (const candidate of fixture.corpus.files.filter(file => file.role === 'candidate')) check(frozen.candidates.some(value => { const asset = assets.get(value.encodedAssetId); return asset.blob.hash === candidate.sha256 && asset.blob.byteLength === candidate.byteLength; }), 'a sealed candidate original is absent from the retained batch');
    const streamed = new Set();
    for (const asset of assets.values()) if (!streamed.has(keyOf(asset.blob))) { await verifyAssetContent(asset); streamed.add(keyOf(asset.blob)); }
    for (const [key, ref] of refs) objects.proven(ref, proofs.get(key));
  }
  const closureIdentity = () => hash(canonical({ assets: [...assets].sort(([a], [b]) => a.localeCompare(b)), objects: [...refs.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b))) }));
  async function verifyRetained(full = false) {
    await candidateBindings();
    for (const [id, before] of assets) assert.deepEqual(await publicAsset(id), before, 'Retained input asset identity changed');
    for (const [key, ref] of refs) {
      if (full) await fullProof(ref, true);
      objects.proven(ref, proofs.get(key));
    }
    if (full) {
      const streamed = new Set();
      for (const asset of assets.values()) if (!streamed.has(keyOf(asset.blob))) { await verifyAssetContent(asset); streamed.add(keyOf(asset.blob)); }
    }
    return { scope: 'complete baseline layer/original plus frozen source, mask and candidate transitive retained-byte closure; excludes unrelated workspace history', verification: full ? 'complete-public-stream-and-production-object-sha256' : 'initial-complete-sha256-plus-production-immutable-object-stamps', closureSha256: closureIdentity(), ...counts(), finalFullRehashRequired: !full };
  }
  async function documentView() {
    const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    check(document?.id === fixture.documentId && document.image?.compositeAssetId, 'document has no actual retained composite');
    return document;
  }
  async function decodedAssetPixels(asset) {
    const info = asset.raster;
    check(info && asset.measuredMediaType === 'image/png' && asset.blob.mediaType === 'image/png', 'canonical document PNG required');
    check(Number.isSafeInteger(info.width) && info.width > 0 && Number.isSafeInteger(info.height) && info.height > 0 && info.width <= 8192 && info.height <= 8192 && info.width * info.height <= MAX_PIXELS, 'canonical raster dimensions exceed the workload envelope');
    check(info.pixels.mediaType === 'application/x-ideogram-rgba8' && info.pixels.byteLength === String(info.width * info.height * 4), 'canonical straight RGBA8 bytes required');
    validatedBlobRef(asset.blob, MAX_ENCODED);
    // Product's CP-1 encoder is independent of this existing pinned Sharp PNG
    // decoder. Streaming output avoids retaining another complete JS RGBA image.
    const sharp = createRequire(join(resolve(repo), 'package.json'))('sharp');
    const decoder = sharp({ limitInputPixels: MAX_PIXELS, failOn: 'warning', ignoreIcc: true, pages: 1 }).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' });
    let decodedInfo, bytes = 0; const digest = createHash('sha256');
    decoder.once('info', value => { decodedInfo = value; });
    const sink = new Writable({ write(chunk, _encoding, done) {
      try { checkOpen(); bytes += chunk.length; check(bytes <= MAX_PIXELS * 4 && bytes <= Number(info.pixels.byteLength), 'decoded output exceeded the canonical grid'); digest.update(chunk); done(); } catch (error) { done(error); }
    } });
    const response = await assetResponse(page, origin, asset, signal);
    try { await pipeline(Readable.from(checkedChunks(response, asset.blob, { signal, maxBytes: MAX_ENCODED })), decoder, sink, { signal }); totalPublicBytes += BigInt(asset.blob.byteLength); }
    finally { response.destroy(); decoder.destroy(); }
    check(decodedInfo?.width === info.width && decodedInfo?.height === info.height && decodedInfo?.channels === 4 && String(bytes) === info.pixels.byteLength, 'independent PNG decode dimensions/length disagree with canonical pixels');
    await fullProof(info.pixels);
    const sha256 = 'sha256:' + digest.digest('hex'); check(sha256 === info.pixels.hash, 'independently decoded PNG bytes differ from actual canonical RGBA pixels');
    return { kind: pixelKind, assetId: asset.id, encodedSha256: asset.blob.hash, width: info.width, height: info.height, channels: 4, byteLength: String(bytes), sha256, canonicalSha256: info.pixels.hash, decodedEntirePNG: true, canonicalPixelsFullyHashed: true, decoder: 'pinned Sharp ' + sharp.versions.sharp, nativeDisplayPixelsVerified: false };
  }
  async function decodedPixels(document, state) {
    const asset = await publicAsset(document.image.compositeAssetId);
    check(asset.raster?.width === document.width && asset.raster?.height === document.height, 'canonical document dimensions changed');
    const manifest = await publicRead(page, '/api/v1/assets/' + asset.id + '/raster'); validate.rasterManifest(manifest);
    check(manifest.plan.kind === 'cp1-composition', 'document composite has no retained CP-1 composition plan');
    assert.deepEqual(manifest.plan.layers, state.layers.filter(layer => layer.visible).map(layer => ({ assetId: layer.assetId, transform: layer.layerToDocument, opacity: layer.opacity, mask: layer.mask })), 'CP-1 composite is not bound to the actual visible layer state');
    return { ...await decodedAssetPixels(asset), compositionManifestSha256: asset.raster.manifest.hash };
  }
  const pixelCoverage = Object.freeze({ canonicalDocumentBytes: true, authoredStrokeGeometry: true, adoptedLayerPixels: true, undoRestoration: true, independentStrokeRasterization: false, wholeDocumentEqualsCandidate: false, nativeDisplayPixels: false });
  const lifecycleRaster = () => ({ schemaVersion: 1, scope: 'M-authored-mask-candidate-replacement-undo', strokeAuthoredGeometry: !!strokeGeometry,
    adoptedLayerPixelsEqualPreparedCandidate: !!adoptionPixels, otherLayersAndTargetSlotPreserved: !!adoptionPlacement,
    canonicalDocumentPixelsVerified: !!baselinePixels && !!strokePixels && !!adoptionPixels && restored,
    undoAdoptionPixelsRestored: undoAdoptionPixels, undoBaselinePixelsRestored: restored, retainedInputs: true,
    nativeDisplayPixels: false, independentStrokeRasterization: false });
  return {
    async baseline() {
      check(!baselineDocument, 'initial full baseline is established only once, before B0');
      return span('oracle-baseline', async () => {
        const document = await documentView(), state = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image');
        check(document.width === fixture.definition.width && document.height === fixture.definition.height && state.width === document.width && state.height === document.height && state.layers.length === fixture.definition.layers, 'actual baseline no longer matches the exact sealed workload');
        assert.deepEqual(state.layers.map(layer => layer.id), document.orderedLayerIds);
        assert.deepEqual(document.image, fixture.extensions.candidates.captureImage, 'actual baseline differs from the frozen source image');
        await walkClosure(document, state); baselineDocument = structuredClone(document);
        gestures = await prepareBrowserGestures(fixture);
        check(fixture.extensions.candidates.candidates.some(candidate => candidate.id === fixture.candidate?.id && candidate.preparedAssetId === fixture.candidate?.preparedAssetId), 'selected candidate is outside the sealed batch');
        candidateAsset = await publicAsset(fixture.candidate.preparedAssetId); candidatePixels = await decodedAssetPixels(candidateAsset);
        baselinePixels = await decodedPixels(document, state);
        return { beforeB0: true, pixels: baselinePixels, candidatePixels, retained: { verification: 'complete-initial-sha256-with-retained-production-proofs', closureSha256: closureIdentity(), ...counts() }, pixelCoverage };
      });
    },
    async checkpoint(label, details = {}) {
      check(baselinePixels && !completed, 'initial baseline must precede cycle checkpoints'); check(/^[a-z][a-z-]{0,63}$/.test(label), 'invalid checkpoint label');
      if (label === 'open') { check(!cycleBefore || restored, 'previous cycle did not restore its baseline'); cycle++; restored = false; strokePixels = undefined; strokeGeometry = undefined; adoptionPixels = undefined; adoptionPlacement = undefined; undoAdoptionPixels = false; cycleSpanStart = spans.length; }
      else check(cycleBefore && !restored, 'an open checkpoint must precede cycle work');
      return span('oracle-' + label, async () => {
        const document = await documentView(), state = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image'), pixels = await decodedPixels(document, state);
        if (label === 'open') {
          assert.deepEqual(document.image, baselineDocument.image); assert.deepEqual(document.orderedLayerIds, baselineDocument.orderedLayerIds);
          check(lifecyclePixelEquality(baselinePixels, pixels), 'next cycle did not start from baseline pixels'); cycleBefore = structuredClone(document); cycleBeforeImage = state;
        }
        if (label === 'after-stroke') {
          const prior = cycleBeforeImage.layers.find(layer => layer.id === details.stroke?.target?.id), target = state.layers.find(layer => layer.id === details.stroke?.target?.id);
          check(prior && target?.mask, 'actual accepted stroke target or mask is absent');
          const manifest = await publicRead(page, '/api/v1/assets/' + target.mask.assetId + '/raster'); validate.rasterManifest(manifest);
          const baselineManifest = prior.mask ? await publicRead(page, '/api/v1/assets/' + prior.mask.assetId + '/raster') : null;
          strokeGeometry = verifyAuthoredStroke({ stroke: details.stroke, specimen: gestures[cycle - 1], document: cycleBefore, beforeImage: cycleBeforeImage, afterImage: state, manifest, baselineManifest });
          await fullProof(manifest.plan.hard); await fullProof(manifest.plan.effective);
          strokeGeometry.retainedR16 = { hard: manifest.plan.hard, effective: manifest.plan.effective, verification: 'complete-production-object-sha256', independentRasterization: false };
          strokePixels = pixels; strokeImage = state;
        }
        if (label === 'after-adoption') {
          check(strokeImage && strokeGeometry, 'verified authored stroke must precede replacement');
          check(details.candidate?.id === fixture.candidate.id && details.candidate.preparedAssetId === candidateAsset.id, 'adoption selected another prepared candidate');
          const replacement = verifyReplacementState(strokeImage, state, details.replacement);
          check(replacement.target.id === strokeGeometry.targetLayerId, 'adoption replaced a different slot than the stroke');
          const asset = await publicAsset(replacement.target.assetId), manifest = await publicRead(page, '/api/v1/assets/' + asset.id + '/raster'); validate.rasterManifest(manifest);
          check(manifest.plan.kind === 'retained-candidate-v1', 'replacement is not a retained candidate layer');
          assert.deepEqual(manifest.plan.source, candidateAsset.raster.manifest); assert.deepEqual(asset.raster.sourceAssetIds, [candidateAsset.id]);
          adoptionPixels = await decodedAssetPixels(asset); check(lifecyclePixelEquality(candidatePixels, adoptionPixels), 'actual adopted layer pixels differ from the sealed prepared candidate');
          adoptionPlacement = { targetLayerId: replacement.target.id, targetIndex: replacement.index, priorVersion: details.replacement.version ?? details.replacement.layerVersion, layerCount: state.layers.length, otherLayersAndTargetSlotPreserved: true };
        }
        if (label === 'after-undo-adoption') { check(strokePixels && adoptionPixels, 'stroke/adoption byte witnesses required before Undo of adoption'); check(lifecyclePixelEquality(strokePixels, pixels), 'Undo of adoption did not restore actual stroked document pixels'); assert.deepEqual(state, strokeImage); undoAdoptionPixels = true; }
        const value = { cycle, label, pixels, sameAsBaselinePixels: lifecyclePixelEquality(baselinePixels, pixels), ...(label === 'after-stroke' ? { strokeGeometry } : {}), ...(label === 'after-adoption' ? { adoptedLayerPixels: adoptionPixels, adoptionPlacement } : {}) }; checkpoints.push(value); return value;
      });
    },
    async afterUndo() {
      check(cycleBefore, 'baseline must precede Undo verification');
      return span('oracle-after-undo', async () => {
        check(undoAdoptionPixels, 'actual Undo-of-adoption pixels must be verified first');
        const document = await documentView(), state = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image'), pixels = await decodedPixels(document, state);
        assert.deepEqual(document.image, cycleBefore.image, 'Undo did not restore the exact image version');
        assert.deepEqual(document.orderedLayerIds, cycleBefore.orderedLayerIds, 'Undo did not restore layer order');
        assert.equal(document.historyHead, cycleBefore.historyHead, 'Undo did not restore the history head');
        assert.deepEqual(state, cycleBeforeImage, 'Undo did not restore the complete baseline layer state');
        check(lifecyclePixelEquality(baselinePixels, pixels), 'Undo did not restore actual decoded canonical document pixels'); restored = true;
        return { canonicalPixelConsistency: true, undoPixelRestoration: true, undoRestored: true, pixels, pixelCoverage };
      });
    },
    async afterClose() {
      check(restored, 'close proof requires verified Undo restoration');
      const retained = await span('oracle-retained-after-close', () => verifyRetained());
      return { assertions: { lifecycleRaster: lifecycleRaster(), exactPixels: null, canonicalPixelConsistency: true, undoPixelRestoration: true, undoRestored: true, retainedInputs: true }, evidence: { cycle, retained, pixelCoverage, strokeGeometry, adoptionPlacement, adoptedLayerPixels: adoptionPixels, observerSpans: spans.slice(cycleSpanStart), observerWorkExcludedFromTiming: false }, missing: [] };
    },
    async completeSeries() {
      check(baselineDocument && restored, 'completed cycles required before final closure proof');
      if (!completed) { finalClosure = await span('oracle-final-full-closure', () => verifyRetained(true)); completed = true; }
      return { kind: 'lifecycle-series-retained-byte-proof-1', complete: true, cycles: cycle, retained: finalClosure, pixelCoverage, checkpoints, observerSpans: spans, observerWorkExcludedFromTiming: false, nativeDisplayPixelsVerified: false };
    },
    close() { if (closed) return; for (const token of proofs.values()) objects.releaseProof(token); proofs.clear(); objects.close(); closed = true; },
  };
}

// Real WC preparation. Every retained mutation uses the production writer; SQL
// below is read-only inspection or a disposable PF-1 validation index. Importing
// this module performs no IO and a missing mixed seed is never synthesized.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PORTABLE_WORKLOADS, fileIdentity, safeRelative, treeFiles, withClosedSeedDatabase } from './backend-portable.mjs';
export { withClosedSeedDatabase } from './backend-portable.mjs';

const MiB = 1048576;
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;
const rawHash = value => value.replace(/^sha256:/, '');
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = (message, code = 'FIXTURE_REQUIRED') => { throw Object.assign(Error(message), { code }); };
const requireValue = (value, message) => { if (!value) fail(message); };
const abort = signal => signal?.throwIfAborted();
const encode = value => Buffer.from(JSON.stringify(value));

export function portableFixturePlan({ workload, seed }) {
  const expected = PORTABLE_WORKLOADS[workload];
  requireValue(expected, 'WC workload must be exactly WC512 or WC4G');
  requireValue(seed && typeof seed.root === 'string' && typeof seed.documentId === 'string' && /^[A-Za-z0-9_-]+$/.test(seed.documentId),
    'Supply an existing real mixed native-text/candidate/CP-1 writer seed; a generated filler archive is not a substitute');
  requireValue(seed.archive && typeof seed.archive.path === 'string' && HASH.test(seed.archive.sha256) && /^[1-9][0-9]*$/.test(seed.archive.byteLength),
    'The mixed seed requires its own complete archive path, SHA-256, and byte length');
  return { workload, ...expected, heavy: true, preparationOnly: true, qualification: false,
    seed: structuredClone(seed), minimumFreeBytes: String(BigInt(expected.closureBytes) * 8n + 2n * 1024n * BigInt(MiB)),
    mutations: ['ImportBundle into an empty private root', 'ApprovePromptProjection with real raw/derived versions',
      'FinalizeStaging and SaveDraft for retained asset closure', 'SaveCheckpoint for full event history',
      'Replace one current unapplied draft to calibrate exact raw closure bytes', 'SaveCopy with full PF-1 verification'] };
}

async function modules(repo) {
  const load = path => import(pathToFileURL(join(repo, 'dist/local', path)).href);
  const entries = await Promise.all(['server/storage/writer.js', 'server/portable/zip.js', 'server/portable/format.js',
    'server/portable/closure.js', 'src/protocol/store.js', 'src/protocol/json.js', 'src/composition/core.js',
    'server/storage/composition-memory.js', 'server/storage/files.js'].map(load));
  return Object.assign({}, ...entries);
}

/** Call only after production decodeRecords + validateClosure. Their temporary
 * typed indexes establish reachability; arbitrary labels in a seal do not. */
export async function archiveFeatureEvidence(db, read, { seal } = {}) {
  const sets = Object.fromEntries(['originals', 'retainedCandidates', 'rawCaptions', 'derivedCaptions', 'editableText',
    'licensedFonts', 'frozenLayouts', 'contributions', 'adapters'].map(name => [name, new Set()]));
  const add = (name, ref) => {
    assert(ref && /^sha256:[a-f0-9]{64}$/.test(ref.hash), `Typed ${name} needs a BlobRef`);
    const row = db.prepare('SELECT bytes FROM refs WHERE hash=?').get(ref.hash);
    assert(row && String(row.bytes) === String(ref.byteLength), `Typed ${name} is outside the archive closure`);
    sets[name].add(ref.hash);
  };
  const asset = id => {
    const row = db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id);
    assert(row, `Missing typed asset ${id}`); return JSON.parse(String(row.json));
  };
  const data = async ref => JSON.parse(Buffer.from(await read(ref)).toString('utf8'));
  for (const row of db.prepare("SELECT json FROM entities WHERE kind='asset'").iterate()) {
    const a = JSON.parse(String(row.json));
    if (a.raster) {
      const manifest = await data(a.raster.manifest);
      if (manifest.plan?.kind === 'decoded-native') add('originals', asset(manifest.plan.sourceAssetId).blob);
      if (manifest.plan?.contributions) {
        const stack = await data(manifest.plan.contributions);
        assert.equal(stack.kind, 'cp1-contribution-stack-v1');
        assert(stack.contributions.length > 0);
        add('contributions', manifest.plan.contributions);
        for (const item of stack.contributions) {
          const contribution = await data(item.manifest);
          assert.equal(contribution.plan?.kind, 'cp1-layer-contribution-v1');
          add('contributions', item.manifest); add('contributions', item.pixels);
        }
      }
    }
    if (a.qualification === 'adapter-version') {
      assert(a.adapter?.validation && a.adapter.weights);
      add('adapters', a.adapter.weights);
      if (a.adapter.config) add('adapters', a.adapter.config);
    }
  }
  for (const row of db.prepare("SELECT json FROM entities WHERE kind='candidate-result'").iterate()) {
    const candidate = JSON.parse(String(row.json));
    assert.equal(candidate.safety, 'safe'); add('retainedCandidates', asset(candidate.encodedAssetId).blob);
    if (candidate.preparedAssetId) add('retainedCandidates', asset(candidate.preparedAssetId).blob);
  }
  for (const row of db.prepare('SELECT json FROM adopted_lineages').iterate()) {
    const lineage = JSON.parse(String(row.json)), candidate = lineage.candidate;
    add('retainedCandidates', asset(lineage.assetBindings[candidate.encodedAssetId]).blob);
    if (candidate.preparedAssetId) add('retainedCandidates', asset(lineage.assetBindings[candidate.preparedAssetId]).blob);
  }
  for (const row of db.prepare('SELECT hash,json FROM text_sources').iterate()) {
    const source = JSON.parse(String(row.json));
    add('editableText', { hash: row.hash, byteLength: db.prepare('SELECT bytes FROM refs WHERE hash=?').get(row.hash).bytes });
    add('editableText', source.text.textUtf8); add('frozenLayouts', source.render.layout);
    assert(source.text.fonts.length > 0);
    for (const font of source.text.fonts) {
      assert.equal(font.embedding, 'permitted'); add('licensedFonts', font.bytes); add('licensedFonts', font.licenseRecord);
    }
  }
  const captionIds = new Set();
  for (const row of db.prepare('SELECT id,ref FROM semantic_versions').iterate()) {
    const ref = JSON.parse(String(row.ref)), composition = await data(ref.value);
    if (!composition.raw?.length || !composition.review?.prompt) continue;
    assert.equal(composition.id, row.id);
    captionIds.add(row.id); add('derivedCaptions', ref.value); add('derivedCaptions', composition.review.prompt);
    composition.raw.forEach(ref => add('rawCaptions', ref));
  }
  const features = Object.fromEntries(Object.entries(sets).map(([key, values]) => [key, [...values].sort()]));
  if (seal) {
    for (const [name, hashes] of Object.entries(seal.features)) {
      assert(sets[name], `Unknown WC feature ${name}`);
      for (const expected of hashes) assert(sets[name].has('sha256:' + rawHash(expected)), `Claimed ${name} is not typed retained evidence`);
    }
    assert.equal(captionIds.size, seal.counts.captionVersions, 'Exact retained reviewed caption version count');
  }
  return { features, captionVersions: captionIds.size, typedFeaturesVerified: true };
}

export async function inspectPortableArchive({ repo, path, output, signal, product, seal, includeReopenFonts = false }) {
  product ??= await modules(repo);
  let compositionMemory; compositionMemory = new product.CompositionMemory(() => compositionMemory.bytes);
  const memoryBefore = compositionMemory.resourceOwnership();
  const db = product.spool(join(output, `inspect-${randomUUID()}.sqlite`));
  let zip;
  try {
    // Private preparation index only: retain the rollback journal across commits
    // and closure. Product spool durability/cache/temp settings stay unchanged.
    assert.equal(db.prepare('PRAGMA journal_mode=PERSIST').get().journal_mode, 'persist',
      'Private portable inspection spool requires PERSIST journaling');
    zip = new product.ZipIndex(path, db);
    const check = () => abort(signal);
    await zip.headers(check); await zip.hashes(check);
    let manifestBytes = 0n;
    for (const row of db.prepare("SELECT bytes FROM zip_entries WHERE name='manifest.json' OR name GLOB 'records/*.jsonl'").iterate()) manifestBytes += BigInt(row.bytes);
    assert(manifestBytes <= 128n * BigInt(MiB), 'Logical WC manifest and record segments exceed 128 MiB');
    const manifest = await product.decodeRecords(zip, db, check);
    assert.equal(manifest.unsupported, undefined); assert.equal(manifest.complete, true);
    const read = async ref => {
      assert(BigInt(ref.byteLength) <= 8n * BigInt(MiB), 'Only bounded typed metadata is materialized');
      const parts = []; for await (const chunk of zip.chunks(zip.entry('objects/' + rawHash(ref.hash)), check)) parts.push(chunk);
      return Buffer.concat(parts);
    };
    const document = await product.validateClosure(db, read, check, compositionMemory, manifest.formatVersion >= 4, manifest.formatVersion >= 5,
      manifest.formatVersion >= 6, manifest.formatVersion >= 7, manifest.formatVersion >= 9, manifest.formatVersion >= 10,
      manifest.formatVersion >= 10, manifest.formatVersion >= 12, manifest.formatVersion >= 13);
    const typed = await archiveFeatureEvidence(db, read, { seal });
    // This is the actual current imported graph, not the retained-history font
    // inventory or the original seed's identifiers. Read-only preparation adds
    // no command, preview, archive member or qualification authority.
    let reopen = {};
    if (includeReopenFonts) {
      try { reopen = await portableReopenFontProjection(db, read, document); }
      catch (error) { abort(signal); reopen = {reopenFontMissing: ['Current portable font projection unavailable: ' + String(error.message).slice(0, 256)]}; }
    }
    let closureBytes = 0n; for (const row of db.prepare('SELECT bytes FROM refs').iterate()) closureBytes += BigInt(row.bytes);
    return { document, counts: { closureBytes: String(closureBytes), events: db.prepare('SELECT count(*) n FROM events').get().n,
      assets: db.prepare("SELECT count(*) n FROM entities WHERE kind='asset'").get().n, captionVersions: typed.captionVersions, manifestBytes: String(manifestBytes) },
      features: typed.features, formatVersion: manifest.formatVersion, fullHashesVerified: true, semanticClosureVerified: true, typedFeaturesVerified: true, ...reopen };
  } finally {
    try { zip?.close(); } finally { db.close();
      assert.deepEqual(compositionMemory.resourceOwnership(), memoryBefore, 'Portable fixture closure releases every Composition borrower');
    }
  }
}

/** Only call after validateClosure. Bounded current graph metadata supplies
 * locator hints; the live observer still hashes every associated font file. */
export async function portableReopenFontProjection(db, read, document) {
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const metadata = async (ref, maximum) => {
    assert(ref && /^sha256:[a-f0-9]{64}$/.test(ref.hash) && /^(0|[1-9][0-9]*)$/.test(ref.byteLength) && Number(ref.byteLength) <= maximum && ref.mediaType === 'application/json', 'Bounded current metadata ref required');
    const bytes = await read(ref); assert.equal(bytes.length, Number(ref.byteLength)); assert.equal(hash(bytes), ref.hash);
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  };
  assert(identity(document?.id) && /^(0|[1-9][0-9]{0,19})$/.test(document.revision) && document.image && Array.isArray(document.orderedLayerIds) && document.orderedLayerIds.length <= 100, 'Current portable document required');
  const image = await metadata(document.image.state, MiB);
  assert(Array.isArray(image.layers) && image.layers.length <= 100);
  assert.deepEqual(image.layers.map(layer => layer.id), document.orderedLayerIds);
  const fonts = new Map(), textFacts = [];
  for (const layer of image.layers) {
    assert(identity(layer.id) && ['image', 'text'].includes(layer.kind));
    if (layer.kind !== 'text') continue;
    const source = await metadata(layer.source, 65536);
    assert(Array.isArray(source.text?.fonts) && source.text.fonts.length > 0 && source.text.fonts.length <= 16);
    for (const font of source.text.fonts) {
      assert(/^sha256:[a-f0-9]{64}$/.test(font.id));
      if (fonts.has(font.id)) assert.deepEqual(fonts.get(font.id), font); else fonts.set(font.id, font);
      assert(fonts.size <= 16, 'Current public font locator boundary exceeded');
    }
    textFacts.push({layerId: layer.id, sourceHash: layer.source.hash, textHash: source.text.textUtf8.hash, textBytes: Number(source.text.textUtf8.byteLength),
      layoutHash: source.render.layout.hash, pixelHash: source.render.pixels.hash, rendererHash: source.render.rendererProfile.id, fonts: source.text.fonts.map(font => font.bytes.hash)});
  }
  assert(textFacts.length > 0 && fonts.size > 0, 'Current portable native text is unavailable');
  const typed = [...fonts.values()].sort((a, b) => a.id.localeCompare(b.id)), fontAssetIds = [];
  for (const font of typed) {
    const row = db.prepare("SELECT id,json FROM entities WHERE kind='asset' AND json_extract(json,'$.font.id')=? ORDER BY id LIMIT 1").get(font.id);
    assert(row && identity(row.id) && typeof row.json === 'string' && Buffer.byteLength(row.json) <= 65536, 'Bounded current font locator required');
    const asset = JSON.parse(row.json);
    assert.equal(asset.id, row.id); assert.equal(asset.purpose, 'font'); assert.equal(asset.qualification, 'font');
    assert.equal(asset.safety, 'safe'); assert.equal(asset.availability, 'available'); assert.deepEqual(asset.font, font); assert.deepEqual(asset.blob, font.bytes);
    fontAssetIds.push(asset.id);
  }
  return {text: {schema: 'browser-reopen-text-fixture-1', documentId: document.id, revision: document.revision,
    imageState: document.image.state, semanticDigest: document.image.semanticDigest, orderedLayerIds: document.orderedLayerIds},
  native: {schema: 'browser-reopen-native-fixture-1', textFacts, fonts: typed, fontAssetIds}};
}

async function newOutput(repo, requested) {
  requireValue(typeof requested === 'string' && isAbsolute(requested), 'Fixture output must be an absolute new directory');
  const base = join(await realpath(repo), 'artifacts'), output = resolve(requested);
  requireValue(output.startsWith(base + sep), 'Fixture output must be below this checkout artifacts directory');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseInfo = await lstat(base);
  assert(baseInfo.isDirectory() && !baseInfo.isSymbolicLink() && await realpath(base) === base, 'Unsafe fixture artifacts root');
  let parent = base;
  for (const component of relative(base, dirname(output)).split(sep).filter(Boolean)) {
    parent = join(parent, component); await mkdir(parent, { recursive: true, mode: 0o700 });
    const info = await lstat(parent); assert(info.isDirectory() && !info.isSymbolicLink() && await realpath(parent) === parent, 'Unsafe fixture output parent');
  }
  await mkdir(output, { mode: 0o700 }); return output;
}

// Complete the fixed object-directory topology before starting the new writer.
// Otherwise growth introduces shard entries throughout traversal of their parent.
// These empty directories are real, private, durably created and fully accounted;
// they supply no object, asset, closure or qualification authority.
export async function openPortableFixtureWriter({ root, product, signal }) {
  abort(signal);
  requireValue(isAbsolute(root) && resolve(root) === root, 'Portable store root must be canonical and absolute');
  product.assertComponents(dirname(root));
  assert.equal(await realpath(dirname(root)), dirname(root), 'Portable store parent must be canonical');
  abort(signal);
  await mkdir(root, { mode: 0o700 }); // Exclusive: never prepare an existing or seed store.
  product.privateDirectory(root);
  product.syncDirectory(dirname(root));
  const objects = join(root, 'objects'), shards = join(objects, 'sha256');
  product.privateDirectory(objects); product.privateDirectory(shards);
  for (let prefix = 0; prefix < 256; prefix++) {
    abort(signal);
    product.privateDirectory(join(shards, prefix.toString(16).padStart(2, '0')));
  }
  abort(signal);
  const writer = await product.openWriter({ root }, { effectCounters: globalThis.__storeNetworkCounters?.shared });
  try { abort(signal); return writer; }
  catch (error) {
    try { await writer.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'Portable preparation cancelled and writer close failed'); }
    throw error;
  }
}

/** Heavy, explicitly invoked preparation. The real mixed seed is supplied by
 * the caller; missing native/candidate/font/contribution evidence is a durable
 * inconclusive result, never replaced with invented SQL rows or raster bytes. */
export async function buildPortableFixture(options = {}) {
  let plan;
  try { plan = portableFixturePlan(options); }
  catch (error) { if (error.code !== 'FIXTURE_REQUIRED') throw error; return { status: 'inconclusive', qualification: false, missing: [error.message] }; }
  requireValue(options.allowHeavy === true, 'Set allowHeavy:true for explicit full WC fixture preparation');
  const { repo, signal, onProgress = () => {} } = options, seed = plan.seed;
  requireValue(globalThis.__storeNetworkCounters?.shared, 'Use the inherited tests/store/no-network.mjs preload for WC preparation');
  abort(signal);
  const output = await newOutput(repo, options.output), root = join(output, 'store');
  const receipt = { kind: 'wc-fixture-preparation', schemaVersion: 1, workload: plan.workload, qualification: false,
    status: 'preparing', mutations: plan.mutations, exports: [], startedAt: new Date().toISOString(), missing: [] };
  let writer;
  try {
    const disk = await statfs(output, { bigint: true });
    requireValue(disk.bavail * disk.bsize >= BigInt(plan.minimumFreeBytes), 'Insufficient space for full WC preparation and preserved intermediate archives');
    const sourceRoot = await realpath(seed.root), sourceFiles = await treeFiles(sourceRoot, '', signal);
    requireValue(sourceFiles.some(f => f.path === 'metadata.sqlite') && !sourceFiles.some(f => /^metadata\.sqlite-(wal|shm)$/.test(f.path)), 'Mixed seed must be a clean closed writer root');
    const sourceArchive = await fileIdentity(seed.archive.path, signal);
    assert.equal(sourceArchive.sha256, rawHash(seed.archive.sha256)); assert.equal(sourceArchive.byteLength, seed.archive.byteLength);
    const product = await modules(repo), initial = await inspectPortableArchive({ repo, path: seed.archive.path, output, signal, product });
    assert.equal(initial.document.id, seed.documentId, 'Mixed seed archive identity matches selected document');
    await withClosedSeedDatabase({ root: sourceRoot, output, sourceFiles, signal }, sourceDatabase => {
      const local = sourceDatabase.prepare('SELECT json FROM documents WHERE id=?').get(seed.documentId);
      const retained = local ?? sourceDatabase.prepare("SELECT json FROM portable_rows WHERE kind='document' AND id=?").get(seed.documentId);
      assert.deepEqual(JSON.parse(retained?.json ?? 'null'), initial.document, 'Source writer and presealed archive retain the same document');
    });
    const featureNames = ['originals', 'retainedCandidates', 'rawCaptions', 'derivedCaptions', 'editableText', 'licensedFonts', 'frozenLayouts', 'contributions', 'adapters'];
    const missing = featureNames.filter(name => initial.features[name].length === 0);
    requireValue(missing.length === 0, 'Real mixed seed lacks typed retained features: ' + missing.join(', '));
    requireValue(plan.workload !== 'WC4G' || initial.counts.captionVersions <= plan.captionVersions, 'WC4G seed cannot exceed exactly 4096 retained caption versions');
    requireValue(initial.counts.assets < plan.assets && initial.counts.events < plan.events && BigInt(initial.counts.closureBytes) < BigInt(plan.closureBytes), 'Mixed seed must leave room for exact WC asset/event/byte growth');
    receipt.seed = { root: sourceRoot, documentId: seed.documentId, archive: { ...seed.archive, ...sourceArchive }, files: sourceFiles };
    writer = await openPortableFixtureWriter({ root, product, signal });
    const clientId = 'wc_fixture', sessionHash = createHash('sha256').update(randomUUID()).digest('hex');
    const auth = () => ({ clientId, sessionHash, now: Date.now(), expires: Date.now() + 7 * 86400000 });
    await writer.protocolDefaults(); await writer.rememberClient(sessionHash, clientId, auth().expires);
    let documentId;
    const command = (body, document) => ({ protocolVersion: 1, command: { schemaVersion: 1, commandId: randomUUID(), clientId,
      sessionId: 'wc_fixture', correlationId: randomUUID(), causationId: null, transactionId: randomUUID(),
      documentId: document?.id ?? null, expectedDocumentRevision: document?.revision ?? null,
      expectedEntityVersions: product.EMPTY_EXPECTED_VERSIONS, issuedAt: new Date().toISOString(), body } });
    async function execute(body, method, scoped = false) {
      abort(signal); const request = command(body, scoped ? await writer.document(documentId) : null), start = performance.now();
      let result = await writer[method](encode(request), auth());
      while (!result) {
        abort(signal); if (performance.now() - start > 300000) fail('Production command timed out: ' + body.type, 'OPERATION_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, 2)); result = (await writer.lookup(request.command.commandId))?.receipt;
        const pending = await writer.portableInventory('', auth());
        if (pending.items.some(item => item.commandId === request.command.commandId && item.phase === 'waiting-for-resources')) fail('Production command is waiting for resources', 'RESOURCE_PENDING');
      }
      if (result.status !== 'accepted') {
        const detail = result.details ? Buffer.from(await writer.readMetadata(result.details)).toString('utf8') : '';
        fail(`${body.type} rejected: ${result.code}: ${detail}`, 'PRODUCT_REJECTED');
      }
      const events = (await writer.events(String(BigInt(result.fromSeq) - 1n), 100)).events.filter(event => event.commandId === request.command.commandId);
      return { receipt: result, events };
    }
    async function stage(source, purpose, mediaType) {
      const bytes = Buffer.isBuffer(source) ? source : null, identity = bytes ? { byteLength: String(bytes.length), sha256: hash(bytes) } : source;
      const stagingId = randomUUID(), sha256 = 'sha256:' + rawHash(identity.sha256);
      await writer.assetCreate({ protocolVersion: 1, stagingId, purpose, expectedBytes: identity.byteLength, sha256, mediaType }, auth());
      let offset = 0;
      for await (const bytes of Buffer.isBuffer(source) ? [source] : createReadStream(source.path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, highWaterMark: MiB })) {
        for (let at = 0; at < bytes.length; at += MiB) {
          abort(signal); const part = bytes.subarray(at, at + MiB), token = await writer.assetBeginChunk(stagingId, String(offset), part.length, auth());
          try { await writer.assetChunk(token, part, auth()); } catch (error) { await writer.assetAbortChunk(token).catch(() => {}); throw error; }
          offset += part.length;
        }
      }
      assert.equal(String(offset), identity.byteLength);
      if (purpose === 'bundle') return { stagingId, expectedSha256: sha256 };
      return (await execute({ type: 'FinalizeStaging', stagingId, expectedSha256: sha256 }, 'assetCommand')).events.find(e => e.type === 'AssetRegistered').payload.asset;
    }
    const staged = await stage({ ...seed.archive, path: seed.archive.path }, 'bundle', 'application/x-ideogram-project');
    const preview = await execute({ type: 'PreviewBundleImport', ...staged }, 'portableCommand');
    const review = await writer.bundleReview(preview.events.find(e => e.type === 'BundleImportReviewed').payload.reviewId, auth());
    assert.equal(review.editable, true, JSON.stringify(review));
    await execute({ type: 'ImportBundle', reviewId: review.reviewId, reviewHash: review.reviewHash }, 'portableCommand');
    documentId = review.documentId;
    const metadata = async (value, mediaType = 'application/json') => {
      const bytes = Buffer.from(typeof value === 'string' ? value : product.canonical(value));
      assert(bytes.length <= 65536, 'Fixture metadata stays within writer metadata API');
      return writer.putObject([bytes], { byteLength: String(bytes.length), mediaType }, writer.epoch);
    };
    async function snapshot(label) {
      const start = performance.now(), saved = await execute({ type: 'SaveCopy' }, 'portableCommand', true);
      const bundle = saved.events.find(e => e.type === 'BundlePrepared').payload.bundle;
      const bare = rawHash(bundle.blob.hash), path = join(root, 'objects/sha256', bare.slice(0, 2), bare);
      const inspected = await inspectPortableArchive({ repo, path, output, signal, product, includeReopenFonts: true });
      receipt.exports.push({ label, preparationOnly: true, ms: performance.now() - start, bundle, counts: inspected.counts });
      await onProgress({ phase: label, workload: plan.workload, counts: inspected.counts });
      return { ...inspected, path, bundle };
    }
    let current = await snapshot('imported-seed-verified');
    requireValue(current.counts.assets < plan.assets && current.counts.events < plan.events, 'Imported seed exceeds exact WC inventory');
    for (let i = current.counts.captionVersions; i < plan.captionVersions; i++) {
      const document = await writer.document(documentId), composition = product.emptyComposition(document.width, document.height, randomUUID());
      composition.scene = `WC retained caption version ${String(i).padStart(5, '0')}`;
      const serialized = product.serialize(composition, [], {});
      const raw = await metadata(serialized.prompt + '\n', 'text/plain'), prompt = await metadata(serialized.prompt, 'text/plain');
      composition.raw = [raw]; composition.review = { serializer: 'caption-json-1', sourceId: composition.id, frame: composition.frame,
        request: composition.request, dependencies: serialized.dependencies, boxes: serialized.boxes, prompt };
      const value = await metadata(composition);
      await execute({ type: 'ApprovePromptProjection', composition: { id: composition.id, value, bindings: {} }, draft: null }, 'historyCommand', true);
      if (i % 128 === 0) await onProgress({ phase: 'retained-caption-versions', versions: i + 1, target: plan.captionVersions });
    }
    if (current.counts.captionVersions < plan.captionVersions) current = await snapshot('caption-versions-verified');
    requireValue(current.counts.assets < plan.assets && current.counts.events < plan.events, 'Caption history leaves insufficient WC inventory');
    const draftSlots = plan.assets - current.counts.assets;
    const document = await writer.document(documentId), generations = new Map();
    async function saveDraft(index, raw = []) {
      const sessionId = 'wc_drafts_' + String(Math.floor(index / 32)).padStart(4, '0'), draftId = 'wc_draft_' + String(index).padStart(5, '0');
      const composition = product.emptyComposition(document.width, document.height, draftId);
      composition.scene = 'Retained WC authoring draft ' + index; composition.raw = raw;
      const graph = await metadata({ composition, bindings: {} });
      const envelope = { schemaVersion: 1, kind: 'composition-draft-1', graph, raw, bindings: {} };
      const asset = await stage(Buffer.from(product.canonical(envelope)), 'caption', 'text/plain');
      const ui = await writer.uiRead(sessionId, auth()), generation = String((generations.get(index) ?? 0) + 1);
      const result = await writer.uiPersist(encode({ protocolVersion: 1, requestId: randomUUID(), sessionId, expectedUISeq: ui.uiSeq,
        body: { type: 'SaveDraft', draft: { id: draftId, generation, kind: 'composition', documentId, targetLayerId: null,
          expectedDocumentRevision: (await writer.document(documentId)).revision, assetId: asset.id, composing: false } } }), auth());
      assert.equal(result.status, 'accepted', JSON.stringify(result)); generations.set(index, Number(generation));
    }
    for (let i = 0; i < draftSlots; i++) { await saveDraft(i); if (i % 128 === 0) await onProgress({ phase: 'retained-draft-assets', added: i + 1, target: draftSlots }); }
    current = await snapshot('asset-inventory-verified');
    assert.equal(current.counts.assets, plan.assets);
    requireValue(current.counts.events <= plan.events, 'WC event count exceeds target before checkpoint growth');
    for (let i = current.counts.events; i < plan.events; i++) {
      await execute({ type: 'SaveCheckpoint', name: 'WC retained checkpoint ' + String(i).padStart(6, '0') }, 'historyCommand', true);
      if (i % 256 === 0) await onProgress({ phase: 'full-history-events', events: i + 1, target: plan.events });
    }
    current = await snapshot('event-inventory-verified');
    assert.equal(current.counts.events, plan.events); assert.equal(current.counts.assets, plan.assets);
    let paddingBytes = 0n;
    for (let attempt = 0; current.counts.closureBytes !== plan.closureBytes && attempt < 8; attempt++) {
      const delta = BigInt(plan.closureBytes) - BigInt(current.counts.closureBytes);
      paddingBytes += delta;
      requireValue(paddingBytes > 0n, 'Retained WC metadata is larger than the requested full closure');
      const padding = await writer.putObject((async function* () {
        const chunk = Buffer.alloc(MiB, 0x20);
        for (let offset = 0n; offset < paddingBytes;) {
          abort(signal); const length = Number(paddingBytes - offset < BigInt(MiB) ? paddingBytes - offset : BigInt(MiB));
          yield chunk.subarray(0, length); offset += BigInt(length);
        }
      })(), { byteLength: String(paddingBytes), mediaType: 'text/plain' }, writer.epoch);
      await saveDraft(draftSlots - 1, [padding]);
      current = await snapshot('exact-byte-calibration-' + (attempt + 1));
      assert.equal(current.counts.events, plan.events); assert.equal(current.counts.assets, plan.assets);
    }
    assert.equal(current.counts.closureBytes, plan.closureBytes, 'Full typed closure has exact byte count');
    if (plan.workload === 'WC4G') assert.equal(current.counts.captionVersions, plan.captionVersions, 'WC4G retains exactly 4096 caption versions');
    else assert(current.counts.captionVersions >= plan.captionVersions);
    assert(BigInt(current.counts.manifestBytes) <= 128n * BigInt(MiB), 'Final WC logical manifest respects 128 MiB ceiling');
    const archivePath = join(output, 'fixture.zip');
    await copyFile(current.path, archivePath, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    const archive = { path: 'fixture.zip', ...await fileIdentity(archivePath, signal) };
    await writer.close(); writer = undefined;
    const finalSourceFiles = await treeFiles(sourceRoot, '', signal); assert.deepEqual(finalSourceFiles, sourceFiles, 'Original source tree preserved byte-for-byte');
    assert.deepEqual(await fileIdentity(seed.archive.path, signal), sourceArchive, 'Original archive preserved');
    assert(Object.values(globalThis.__storeNetworkCounters.read()).every(n => n === 0), 'Preparation and writer workers made zero network attempts');
    const files = await treeFiles(root, '', signal);
    assert(!files.some(file => /^metadata\.sqlite-(wal|shm)$/.test(file.path)), 'Final writer must be cleanly closed before sealing');
    const manifest = { schemaVersion: 1, kind: 'ideogram-wc-fixture', workload: plan.workload, documentId,
      counts: current.counts, features: current.features, archive, files, preparedBy: 'production-writer-command-only',
      qualification: false, sourceArchive: sourceArchive.sha256, complete: true,
      ...(current.text && current.native ? {text: current.text, native: current.native} : {reopenFontMissing: current.reopenFontMissing}) };
    const sealPath = join(output, 'wc-seal.json'), sealBytes = Buffer.from(json(manifest));
    await writeFile(sealPath, sealBytes, { flag: 'wx', mode: 0o600 });
    const observed = { productionValidated: true, closureVerified: true, ...current.counts,
      features: { original: true, candidate: true, rawCaption: true, derivedCaption: true, nativeText: true,
        font: true, layout: true, contribution: true, adapter: current.features.adapters.length > 0 }, zeroNetworkEffects: true };
    const reopen = current.text && current.native ? {text: current.text, native: current.native} : {reopenFontMissing: current.reopenFontMissing};
    Object.assign(receipt, { status: 'pass', completedAt: new Date().toISOString(), root, documentId, archive, observed, missing: [], ...reopen });
    await writeFile(join(output, 'preparation.json'), json(receipt), { flag: 'wx', mode: 0o600 });
    return { status: 'pass', qualification: false, root, documentId, archive: { ...archive, path: archivePath },
      seal: { path: sealPath, sha256: hash(sealBytes) }, portableSeal: { path: sealPath, sha256: hash(sealBytes) }, observed, ...reopen };
  } catch (error) {
    receipt.status = error.code === 'FIXTURE_REQUIRED' ? 'inconclusive' : 'fail';
    receipt.error = { code: error.code ?? null, message: error.message };
    if (receipt.status === 'inconclusive') receipt.missing = [error.message];
    await writeFile(join(output, 'preparation.json'), json(receipt), { flag: 'wx', mode: 0o600 });
    return { status: receipt.status, qualification: false, root, missing: receipt.missing, error: receipt.error, preparation: join(output, 'preparation.json') };
  } finally { await writer?.close().catch(() => {}); }
}

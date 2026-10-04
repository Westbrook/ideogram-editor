import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { prepareMixedWCSeed } from '../../tooling/qualification/campaigns/fixture-portable-seed.mjs';
import { inspectPortableArchive } from '../../tooling/qualification/campaigns/fixture-portable.mjs';
import { fileIdentity, productFor, verifyArchive } from '../../tooling/qualification/campaigns/backend-portable.mjs';
import * as common from '../../tooling/qualification/campaigns/backend-common.mjs';
import { ownTestRoot } from '../../tooling/qualification/owned-test-roots.mjs';

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url))), MiB = 1048576;
const featureNames = ['originals', 'retainedCandidates', 'rawCaptions', 'derivedCaptions', 'editableText',
  'licensedFonts', 'frozenLayouts', 'contributions', 'adapters'];
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const objectPath = (root, ref) => join(root, 'objects', 'sha256', ref.hash.slice(7, 9), ref.hash.slice(7));

async function ownedOutput(t) {
  const allocation = process.env.EDITOR_RECEIPT;
  assert(typeof allocation === 'string' && isAbsolute(allocation) && resolve(allocation) === allocation &&
    allocation.startsWith(join(repo, 'artifacts') + sep), 'Canonical monitored EDITOR_RECEIPT allocation is required');
  assert.equal(await realpath(repo), repo);
  let parent = repo;
  for (const part of relative(repo, allocation).split(sep)) {
    parent = join(parent, part);
    await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(parent);
    assert(stat.isDirectory() && !stat.isSymbolicLink()); assert.equal(await realpath(parent), parent);
  }
  const root = ownTestRoot(await mkdtemp(join(allocation, 'mixed-wc-seed-writer-')));
  t.diagnostic('Owned mixed seed control: ' + root);
  return root;
}

function supportedAdapterPath() {
  const input = process.env.IE_ADAPTER_PROFILE_FIXTURE;
  assert(typeof input === 'string' && input.trim().length > 0, 'Maintained supported adapter fixture is required');
  return resolve(input);
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

async function metadata(root, ref, maximum = 65536) {
  assert.match(ref.hash, /^sha256:[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(Number(ref.byteLength)) && Number(ref.byteLength) <= maximum);
  const path = objectPath(root, ref), stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink()); assert.equal(String(stat.size), ref.byteLength);
  const bytes = await readFile(path);
  assert.equal(String(bytes.length), ref.byteLength); assert.equal(hash(bytes), ref.hash);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

async function currentSource(writer, ref) {
  return writer.consumeMetadata(ref, bytes => {
    assert(bytes.byteLength <= 65536); assert.equal(String(bytes.byteLength), ref.byteLength); assert.equal(hash(bytes), ref.hash);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  });
}

function assertFacts(source, fact) {
  assert.deepEqual(source.text.textUtf8, fact.text);
  assert.deepEqual(source.render.layout, fact.layout); assert.deepEqual(source.render.pixels, fact.pixels);
  assert.deepEqual(source.render.rendererProfile.manifest, fact.profile);
  assert.deepEqual(source.text.fonts.map(font => font.bytes), fact.fonts);
  assert.deepEqual(source.text.fonts.map(font => font.licenseRecord), fact.licenses);
  assert.equal(source.text.style.fill[3], 0);
}

async function sealedFiles(root, relative = '') {
  const result = [];
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative ? relative + '/' + entry.name : entry.name;
    assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) result.push(...await sealedFiles(root, path));
    else { assert(entry.isFile()); result.push({ path, ...await fileIdentity(join(root, path)) }); }
  }
  return result;
}

// Exercise the actual streaming upload contract. The complete archive, including
// the supported 85 MB adapter, never becomes one resident test Buffer.
async function stageArchive(fixture, archive) {
  const stagingId = randomUUID(), expectedSha256 = 'sha256:' + archive.sha256;
  await fixture.writer.assetCreate({ protocolVersion: 1, stagingId, purpose: 'bundle', expectedBytes: archive.byteLength,
    sha256: expectedSha256, mediaType: 'application/x-ideogram-project' }, common.auth());
  const digest = createHash('sha256'); let offset = 0;
  for await (const bytes of createReadStream(archive.path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, highWaterMark: MiB })) {
    assert(bytes.length > 0 && bytes.length <= MiB);
    const token = await fixture.writer.assetBeginChunk(stagingId, String(offset), bytes.length, common.auth());
    try { await fixture.writer.assetChunk(token, bytes, common.auth()); }
    catch (error) { await fixture.writer.assetAbortChunk(token); throw error; }
    digest.update(bytes); offset += bytes.length;
  }
  assert.equal(String(offset), archive.byteLength); assert.equal(digest.digest('hex'), archive.sha256);
  return { stagingId, expectedSha256 };
}

async function mappings(writer, reviewId, kind) {
  const result = new Map(); let after = '';
  do {
    const page = await writer.bundleMapping(reviewId, kind, after, common.auth());
    for (const item of page.items) { assert(!result.has(item.sourceId)); result.set(item.sourceId, item.localId); }
    after = page.next ?? '';
  } while (after);
  return result;
}

test('ordinary mixed seed preserves real native history, typed Composition/adapter closure and every byte through reviewed import', async t => {
  const output = await ownedOutput(t), phases = [];
  // The maintained adapters prerequisite verifies this exact input before and
  // after the file. Never download or substitute structural random weights.
  const result = await prepareMixedWCSeed({ repo, output: join(output, 'seed'), allowHeavy: true,
    officialAdapterPath: supportedAdapterPath(), onProgress: event => phases.push(event.phase) });
  assert.equal(result.status, 'complete'); assert.equal(result.qualification, false);
  const seed = JSON.parse(await readFile(result.seedPath, 'utf8'));
  const record = JSON.parse(await readFile(result.preparationPath, 'utf8'));
  assert.deepEqual(seed, result.seed); assert.deepEqual(record.seed, seed);
  assert.equal(record.status, 'complete'); assert.equal(record.preparationOnly, true);
  assert.equal(record.qualification, false); assert.equal(record.closed, true);
  assert(phases.includes('real-native-history') && phases.includes('real-local-candidate') && phases.includes('complete-portable-inspection'));
  assert.deepEqual(await fileIdentity(seed.archive.path), { sha256: seed.archive.sha256, byteLength: seed.archive.byteLength });
  assert(record.counts.events > 0 && record.counts.events < 10000);
  assert(record.counts.assets > 0 && record.counts.assets < 1000);
  assert(BigInt(record.counts.closureBytes) > 0n && BigInt(record.counts.closureBytes) < 512n * BigInt(MiB));
  assert.equal(record.counts.captionVersions, 2);

  const product = await productFor(repo), inspected = await inspectPortableArchive({ repo, path: seed.archive.path,
    output, product, includeReopenFonts: true });
  assert.deepEqual(inspected.counts, record.counts); assert.deepEqual(inspected.features, record.features);
  assert.equal(inspected.document.id, seed.documentId);
  assert.equal(inspected.fullHashesVerified, true); assert.equal(inspected.semanticClosureVerified, true);
  assert.equal(inspected.typedFeaturesVerified, true);
  assert.deepEqual(Object.keys(inspected.features).sort(), [...featureNames].sort());
  for (const name of featureNames) assert(inspected.features[name].length > 0, name);

  const native = record.native;
  assert.equal(native.alphaZero, true); assert.equal(native.visibleGlyphCredit, false);
  assert.equal(native.current.length, 2); assert.equal(native.historical.length, 2);
  assert.deepEqual(native.admissions, { acquired: 4, released: 4, active: 0 });
  assert.deepEqual([native.workers.started, native.workers.exited, native.workers.active], [4, 4, 0]);
  assert.equal(native.workers.runs.length, 4);
  for (const run of native.workers.runs) {
    assert(run.threadId > 0 && run.ready && run.admitted && run.result && run.exited);
    assert.equal(run.exitCode, 0); assert.equal(run.terminationRequested, false);
  }
  assert.notEqual(native.currentFont.font.bytes.hash, native.historyOnlyFont.font.bytes.hash);
  assert(inspected.features.licensedFonts.includes(native.historyOnlyFont.font.bytes.hash));
  assert(inspected.native.fonts.every(font => font.bytes.hash !== native.historyOnlyFont.font.bytes.hash));
  assert.deepEqual(inspected.native.fonts.map(font => font.bytes.hash), [native.currentFont.font.bytes.hash]);
  const sourceImage = (await metadata(seed.root, inspected.document.image.state, MiB)).value;
  assert.equal(sourceImage.layers.find(layer => layer.id === native.hiddenLayerId).visible, false);
  assert(!record.files.some(file => /^metadata\.sqlite-(wal|shm)$/.test(file.path)));
  assert.deepEqual(await sealedFiles(seed.root), record.files);
  // Query a private copy so the test's SQLite reader cannot mutate its subject.
  const sourceMetadata = join(seed.root, 'metadata.sqlite'), scratch = join(output, 'source-inspection');
  const stamp = value => ({ dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs });
  const sourceStamp = stamp(await lstat(sourceMetadata)), sourceIdentity = await fileIdentity(sourceMetadata);
  assert.deepEqual(record.files.find(file => file.path === 'metadata.sqlite'), { path: 'metadata.sqlite', ...sourceIdentity });
  await mkdir(scratch, { mode: 0o700 }); const copiedMetadata = join(scratch, 'metadata.sqlite');
  await copyFile(sourceMetadata, copiedMetadata, constants.COPYFILE_EXCL);
  assert.deepEqual(stamp(await lstat(sourceMetadata)), sourceStamp);
  assert.deepEqual(await fileIdentity(sourceMetadata), sourceIdentity);
  assert.deepEqual(await fileIdentity(copiedMetadata), sourceIdentity);
  const sourceDB = new DatabaseSync(copiedMetadata, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(sourceDB.prepare('SELECT json FROM documents WHERE id=?').get(seed.documentId).json), inspected.document);
    for (const fact of [...native.current, ...native.historical]) {
      const source = (await metadata(seed.root, fact.source)).value; assertFacts(source, fact);
      const layout = (await metadata(seed.root, fact.layout, 8 * MiB)).value;
      assert(layout.paragraphs.some(paragraph => paragraph.runs.length > 0));
      assert(inspected.features.editableText.includes(fact.source.hash));
      assert(inspected.features.frozenLayouts.includes(fact.layout.hash));
    }
    for (const fact of native.current) {
      const layer = sourceImage.layers.find(layer => layer.id === fact.layerId);
      assert.deepEqual(layer.source, fact.source); assert.equal(layer.visible, fact.visible);
      assert.equal(fact.fonts[0].hash, native.currentFont.font.bytes.hash);
    }
    for (const fact of native.historical) {
      assert.equal(fact.fonts[0].hash, native.historyOnlyFont.font.bytes.hash);
      assert(!sourceImage.layers.some(layer => layer.kind === 'text' && layer.source.hash === fact.source.hash));
      const history = JSON.parse(sourceDB.prepare('SELECT json FROM history WHERE id=?').get(fact.historyNode).json);
      const historicalImage = (await metadata(seed.root, history.after.state, MiB)).value;
      assert.deepEqual(historicalImage.layers.find(layer => layer.id === fact.layerId).source, fact.source);
    }
    for (const row of sourceDB.prepare('SELECT json FROM ui_checkpoints').iterate()) {
      assert(!JSON.parse(row.json).drafts.some(draft => draft.kind === 'text'), 'Cleared preparation drafts cannot supply historical font retention');
    }
  } finally { sourceDB.close(); }
  assert.deepEqual(await sealedFiles(seed.root), record.files, 'SQLite inspection leaves the sealed root unchanged');

  const { canonical } = await common.product({ repo }, 'src/protocol/json.js');
  for (const composition of record.compositions) {
    const stored = await metadata(seed.root, composition.ref.value, MiB);
    assert.equal(stored.bytes.toString('utf8'), canonical(stored.value));
    assert.equal(stored.value.id, composition.ref.id); assert.deepEqual(stored.value.raw, [composition.raw]);
    assert.deepEqual(stored.value.review, composition.review); assert.deepEqual(stored.value.review.prompt, composition.prompt);
    assert.deepEqual(stored.value.request, stored.value.review.request);
    assert(inspected.features.rawCaptions.includes(composition.raw.hash));
    assert(inspected.features.derivedCaptions.includes(composition.ref.value.hash));
    assert(inspected.features.derivedCaptions.includes(composition.prompt.hash));
  }
  const adapterDraft = (await metadata(seed.root, record.adapter.draft.blob)).value;
  assert.equal(record.adapter.submitted, false); assert.equal(record.adapter.view.locallyEligible, true);
  assert.equal(record.adapter.view.runtimeVerified, false);
  assert.equal(adapterDraft.operation, 'generate-adapters');
  assert.equal(adapterDraft.prompt.projection.request.operation, 'Generate with adapters');
  assert.equal(adapterDraft.fields.expansion, adapterDraft.prompt.projection.request.expansion);
  assert.deepEqual(adapterDraft.prompt.composition, record.compositions.at(-1).ref);
  assert.deepEqual(adapterDraft.prompt.text, record.compositions.at(-1).prompt);
  assert.equal(adapterDraft.adapters[0].version, record.adapter.view.versionId);
  assert.equal(adapterDraft.adapters[0].hash, record.adapter.view.weights.hash);
  assert(inspected.features.adapters.includes(record.adapter.view.weights.hash));
  assert.equal(record.candidate.closed, true); assert.equal(record.candidate.candidate.state, 'prepared');
  assert.equal(record.candidate.localIO.scope, 'literal-127.0.0.1-fixture');
  assert.deepEqual(record.candidate.localIO.counts, { submissions: 1, uploads: 2, status: 1, results: 1, media: 1 });

  const destination = await common.createProductFixture({ repo, output: join(output, 'import') });
  try {
    const staged = await stageArchive(destination, seed.archive);
    const preview = await common.finish(destination.writer, common.envelope({ type: 'PreviewBundleImport', ...staged }), 'portableCommand');
    const reviewed = preview.events.find(event => event.type === 'BundleImportReviewed'); assert(reviewed);
    const review = await destination.writer.bundleReview(reviewed.payload.reviewId, common.auth());
    assert.equal(review.editable, true); assert.equal(review.eventCount, String(record.counts.events));
    const imported = await common.finish(destination.writer, common.envelope({ type: 'ImportBundle', reviewId: review.reviewId,
      reviewHash: review.reviewHash }), 'portableCommand');
    assert(imported.events.some(event => event.type === 'BundleImported'));
    const local = await destination.writer.document(review.documentId), layerMap = await mappings(destination.writer, review.reviewId, 'layer');
    assert(local && local.id !== seed.documentId);
    assert.deepEqual(local.orderedLayerIds, inspected.document.orderedLayerIds.map(id => layerMap.get(id)));
    const image = await destination.writer.imageState(local.id);
    for (const fact of native.current) {
      const layer = image.layers.find(layer => layer.id === layerMap.get(fact.layerId)); assert(layer?.kind === 'text');
      assert.equal(layer.visible, fact.visible); assert.deepEqual(layer.source, fact.source);
      assertFacts(await currentSource(destination.writer, layer.source), fact);
    }
    assert.equal(image.layers.find(layer => layer.id === layerMap.get(native.hiddenLayerId)).visible, false);
    for (const fact of native.historical) assertFacts(await currentSource(destination.writer, fact.source), fact);
    assert.deepEqual(image.composition.value, record.compositions.at(-1).ref.value);
    const seal = { documentId: seed.documentId, counts: record.counts, features: record.features };
    const verified = await verifyArchive(product, seed.archive.path, output, seal, undefined,
      { root: destination.root, namespaceId: review.namespaceId });
    assert.equal(verified.fullHashesVerified, true); assert.equal(verified.semanticClosureVerified, true);
    assert.equal(verified.typedFeaturesVerified, true); assert.equal(verified.ownedClosureHashesVerified, true);
    assert.equal(verified.closureBytes, record.counts.closureBytes); assert.equal(verified.events, record.counts.events);
    assert.equal(verified.assets, record.counts.assets); assert.equal(verified.captionVersions, 2);
  } finally { await destination.close(); }
  // Reads/imports of the copied archive do not alter the clean source seed.
  assert(!record.files.some(file => /^metadata\.sqlite-(wal|shm)$/.test(file.path)));
  assert.deepEqual(await sealedFiles(seed.root), record.files);
  assert.deepEqual(await fileIdentity(seed.archive.path), { sha256: seed.archive.sha256, byteLength: seed.archive.byteLength });
});

test('pre-aborted mixed seed preparation creates no output or writer', async t => {
  const root = await ownedOutput(t), output = join(root, 'aborted'), controller = new AbortController();
  const reason = Error('Selected preparation cancelled before input work'); controller.abort(reason);
  await assert.rejects(prepareMixedWCSeed({ repo, output, allowHeavy: true, officialAdapterPath: join(root, 'absent-adapter'), signal: controller.signal }), error => error === reason);
  await absent(output); assert.deepEqual(await readdir(root), []);
});

test('post-raster preparation failure retains the original error and closed writer evidence without publishing a seed', async t => {
  const root = await ownedOutput(t), output = join(root, 'interrupted');
  const selected = Error('Selected stop after actual raster import'), observed = [];
  await assert.rejects(prepareMixedWCSeed({ repo, output, allowHeavy: true, officialAdapterPath: supportedAdapterPath(),
    onProgress(event) { observed.push(event.phase); if (event.phase === 'real-raster-import') throw selected; },
  }), error => error === selected);
  assert.deepEqual(observed, ['real-raster-import']);
  await absent(join(output, 'seed.json')); await absent(join(output, 'preparation.json'));
  const failurePath = join(output, 'preparation-failure.json'), failureStat = await lstat(failurePath);
  assert(failureStat.isFile() && !failureStat.isSymbolicLink() && failureStat.size > 0 && failureStat.size <= 65536);
  const record = JSON.parse(await readFile(failurePath, 'utf8'));
  assert.equal(record.kind, 'mixed-wc-seed-1'); assert.equal(record.status, 'incomplete');
  assert.equal(record.qualification, false); assert.equal(record.preparationOnly, true);
  assert.deepEqual(record.error, { name: selected.name, code: null, message: selected.message });
  assert.deepEqual(record.phases.map(phase => phase.name), ['real-raster-import']);
  assert.equal(record.native, undefined); assert.equal(record.candidate, undefined); assert.equal(record.seed, undefined);
  const writerOutput = join(output, 'writer');
  const retainedRoots = (await readdir(writerOutput, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^private-/.test(entry.name));
  assert.equal(retainedRoots.length, 1);
  const retained = join(writerOutput, retainedRoots[0].name);
  const { acquireRoot } = await common.product({ repo }, 'server/storage/ownership.js');
  const owner = await acquireRoot(retained);
  try {
    owner.check(); assert.equal(owner.path, retained);
    // Check producer closure before our own SQLite reader can create WAL auxiliaries.
    await absent(join(retained, 'metadata.sqlite-wal')); await absent(join(retained, 'metadata.sqlite-shm'));
    const db = new DatabaseSync(join(retained, 'metadata.sqlite'), { readOnly: true });
    try {
      const documents = db.prepare('SELECT json FROM documents').all(); assert.equal(documents.length, 1);
      const document = JSON.parse(documents[0].json), image = (await metadata(retained, document.image.state, MiB)).value;
      assert.deepEqual(image.layers.map(layer => [layer.id, layer.kind]), [['seed_picture', 'image']]);
      assert.equal(db.prepare("SELECT count(*) n FROM assets WHERE json_extract(json,'$.qualification')='font'").get().n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM queue_jobs').get().n, 0);
    } finally { db.close(); }
  } finally { owner.close(); }
  assert.deepEqual(JSON.parse(await readFile(failurePath, 'utf8')), record, 'Inspecting retained custody does not alter the failure record');
});

test('missing official adapter refuses preparation before any seed output exists', async t => {
  const root = await ownedOutput(t), output = join(root, 'missing-input');
  await assert.rejects(prepareMixedWCSeed({ repo, output, allowHeavy: true, officialAdapterPath: join(root, 'absent-adapter') }), { code: 'ENOENT' });
  await absent(output); assert.deepEqual(await readdir(root), []);
});

test('wrong adapter bytes remain untouched and cannot create a native or writer fixture', async t => {
  const root = await ownedOutput(t), output = join(root, 'wrong-input'), path = join(root, 'wrong-adapter.safetensors');
  const original = Buffer.from('This deliberately small input is not the pinned supported adapter.\n');
  await writeFile(path, original, { flag: 'wx', mode: 0o600 }); const before = await fileIdentity(path);
  await assert.rejects(prepareMixedWCSeed({ repo, output, allowHeavy: true, officialAdapterPath: path }), /supported adapter specimen/);
  await absent(output); assert.deepEqual(await readdir(root), ['wrong-adapter.safetensors']);
  assert.deepEqual(await fileIdentity(path), before); assert.deepEqual(await readFile(path), original);
});

test('existing mixed seed output is refused before input access and retains its original contents', async t => {
  const root = await ownedOutput(t), output = join(root, 'existing'); await mkdir(output, { mode: 0o700 });
  const marker = join(output, 'retained-owner.txt'), original = 'Existing owned evidence must remain unchanged.\n';
  await writeFile(marker, original, { flag: 'wx', mode: 0o600 }); const before = await fileIdentity(marker);
  await assert.rejects(prepareMixedWCSeed({ repo, output, allowHeavy: true, officialAdapterPath: join(root, 'absent-adapter') }), /output must be absent/);
  assert.deepEqual(await readdir(root), ['existing']); assert.deepEqual(await readdir(output), ['retained-owner.txt']);
  assert.equal(await readFile(marker, 'utf8'), original); assert.deepEqual(await fileIdentity(marker), before);
});

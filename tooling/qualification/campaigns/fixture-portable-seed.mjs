// Explicit small mixed seed preparation. This is not a WC workload or timing
// sample. Product mutations use ordinary APIs; only the transport is loopback.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {copyFile, lstat, mkdir, readFile, readdir, realpath, statfs, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as common from './backend-common.mjs';
import {fileIdentity, productFor} from './backend-portable.mjs';
import {inspectPortableArchive} from './fixture-portable.mjs';
import {writeRasterPNG} from './fixtures.mjs';
import {OFFICIAL_ADAPTER} from './adapters.mjs';
import {prepareMixedSeedNative} from './fixture-portable-seed-native.mjs';
import {seedMixedWCCandidate} from './fixture-portable-seed-candidate.mjs';

const MiB = 1048576;
const KIND = 'mixed-wc-seed-1';
const FEATURES = ['originals', 'retainedCandidates', 'rawCaptions', 'derivedCaptions', 'editableText', 'licensedFonts', 'frozenLayouts', 'contributions', 'adapters'];
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const check = signal => signal?.throwIfAborted();
// Diagnostic scalars only. RSS covers this OS process and all worker threads;
// heap/external counters describe the calling isolate, not a qualification cap.
const processMemory = () => ({atMs: performance.now(), ...process.memoryUsage()});
async function failureResources(fixture) {
  const result = {kind: 'mixed-seed-failure-resources-1', qualification: false, parent: processMemory()};
  let writer;
  try {writer = fixture?.writer; if (!writer?.available) return {...result, status: 'writer-unavailable'};}
  catch {return {...result, status: 'writer-unavailable'};}
  try {
    const page = await writer.portableInventory('', common.auth());
    result.portable = {complete: page.next === null, items: page.items.filter(item => item.operation === 'SaveCopy').slice(0, 8)
      .map(({commandId, operationId, phase, reason, operation}) => ({commandId, operationId, phase, reason, operation}))};
  } catch (error) {result.portable = {unavailable: true, code: error.code ?? error.name};}
  let read;
  try {
    read = await writer.readDiagnostics();
    const value = read.value;
    const selected = {writerEpoch: value.writerEpoch, processMemory: value.processMemory, filesystem: value.filesystem,
      owners: value.observer.worker.owners, activeOwners: value.observer.handleClassification.activeOwners};
    const encoded = JSON.stringify(selected); assert(Buffer.byteLength(encoded) <= 32768, 'Bounded failure owner snapshot required');
    result.writer = JSON.parse(encoded);
  } catch (error) {result.writer = {unavailable: true, code: error.code ?? error.name};}
  finally {read?.release();}
  result.afterRead = processMemory(); return result;
}
const assetOf = result => {const asset = result.events.find(event => event.type === 'AssetRegistered')?.payload.asset; assert(asset, 'Actual AssetRegistered event required'); return asset;};

export function mixedWCSeedPlan({repo, output, allowHeavy, officialAdapterPath} = {}) {
  assert.equal(allowHeavy, true, 'Mixed seed preparation requires explicit allowHeavy:true');
  assert(typeof repo === 'string' && isAbsolute(repo) && resolve(repo) === repo, 'Canonical absolute subject repo required');
  assert(typeof output === 'string' && isAbsolute(output) && resolve(output) === output && output.startsWith(join(repo, 'artifacts') + sep), 'Fresh absolute artifacts output required');
  if (officialAdapterPath !== undefined) assert(typeof officialAdapterPath === 'string' && isAbsolute(officialAdapterPath) && resolve(officialAdapterPath) === officialAdapterPath, 'Adapter input path must be canonical and absolute');
  return {kind: KIND, qualification: false, preparationOnly: true, repo, output,
    officialAdapterPath: officialAdapterPath ?? join(repo, 'artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors'),
    width: 512, height: 512, minimumFreeBytes: String(2 * 1024 * MiB),
    features: [...FEATURES], maximumExclusive: {closureBytes: String(512 * MiB), events: 10000, assets: 1000}};
}

async function freshOutput(plan) {
  assert.equal(await realpath(plan.repo), plan.repo, 'Subject repo cannot traverse symlinks');
  const base = join(plan.repo, 'artifacts');
  let at = plan.repo;
  for (const part of relative(plan.repo, plan.output).split(sep)) {
    at = join(at, part);
    const info = await lstat(at).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
    if (!info) continue;
    assert(at !== plan.output, 'Seed output must be absent');
    assert(info.isDirectory() && !info.isSymbolicLink() && await realpath(at) === at, 'Seed output ancestors must be private real directories');
  }
  assert(plan.output.startsWith(base + sep));
}

async function boundedJSON(path, maximum = MiB) {
  const info = await lstat(path); assert(info.isFile() && !info.isSymbolicLink() && info.size <= maximum);
  const bytes = await readFile(path); assert.equal(bytes.length, info.size); return {value: JSON.parse(bytes), bytes};
}

async function verifyInputs(plan, signal) {
  check(signal);
  const adapter = await fileIdentity(plan.officialAdapterPath, signal);
  assert.equal('sha256:' + adapter.sha256, OFFICIAL_ADAPTER.hash, 'Only the current supported adapter specimen is admitted');
  assert.equal(adapter.byteLength, OFFICIAL_ADAPTER.byteLength);
  const profile = await boundedJSON(join(plan.repo, 'src/text/profile.json'));
  const fonts = [];
  for (const id of ['NotoSans', 'NotoSansArabic']) {
    const font = profile.value.fonts.find(value => value.id === id); assert(font, 'Pinned seed font missing');
    for (const name of [font.file, font.licenseFile]) assert(typeof name === 'string' && !isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..'));
    const path = join(plan.repo, 'vendor/text', font.file), licensePath = join(plan.repo, 'vendor/text', font.licenseFile);
    const bytes = await fileIdentity(path, signal), license = await fileIdentity(licensePath, signal);
    assert.equal(bytes.sha256, font.sha256); assert.equal(bytes.byteLength, String(font.bytes)); assert.equal('sha256:' + license.sha256, font.licenseHash);
    fonts.push({id, path, ...bytes, license: {path: licensePath, ...license}});
  }
  return {adapter: {path: plan.officialAdapterPath, ...adapter}, profile: {path: 'src/text/profile.json', sha256: hash(profile.bytes), byteLength: String(profile.bytes.length)}, fonts};
}

async function filesIn(root, signal, directory = '') {
  const files = [];
  for (const item of (await readdir(join(root, directory), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    check(signal); const path = directory ? directory + '/' + item.name : item.name;
    assert(!item.isSymbolicLink(), 'Seed root cannot contain symlinks');
    if (item.isDirectory()) files.push(...await filesIn(root, signal, path));
    else {assert(item.isFile(), 'Seed entries must be ordinary files'); files.push({path, ...await fileIdentity(join(root, path), signal)});}
  }
  return files;
}

async function streamAsset(ctx, input, purpose, mediaType, signal) {
  const stagingId = randomUUID(), expectedSha256 = 'sha256:' + input.sha256;
  await ctx.writer.assetCreate({protocolVersion: 1, stagingId, purpose, expectedBytes: input.byteLength, sha256: expectedSha256, mediaType}, ctx.auth());
  let offset = 0; const digest = createHash('sha256');
  for await (const chunk of createReadStream(input.path, {flags: constants.O_RDONLY | constants.O_NOFOLLOW, highWaterMark: MiB})) {
    check(signal); digest.update(chunk);
    const token = await ctx.writer.assetBeginChunk(stagingId, String(offset), chunk.length, ctx.auth());
    try {await ctx.writer.assetChunk(token, chunk, ctx.auth());} catch (error) {await ctx.writer.assetAbortChunk(token); throw error;}
    offset += chunk.length;
  }
  assert.equal(String(offset), input.byteLength); assert.equal(digest.digest('hex'), input.sha256);
  return assetOf(await ctx.execute({type: 'FinalizeStaging', stagingId, expectedSha256}, 'assetCommand'));
}

async function compositionVersions(ctx) {
  const {emptyComposition, emptyElement, serialize} = await common.product(ctx, 'src/composition/core.js');
  const {canonical} = await common.product(ctx, 'src/protocol/json.js');
  const versions = [];
  for (let index = 0; index < 2; index++) {
    const value = emptyComposition(512, 512, randomUUID()), element = emptyElement('text', 'seed_caption_' + index);
    element.text.value = 'Retained mixed seed caption ' + index; value.elements = [element]; value.scene = 'Mixed portable seed ' + index;
    if (index === 1) value.request.operation = 'Generate with adapters';
    const raw = await ctx.stage(Buffer.from('Original retained caption ' + index + '\nCafé\n'), 'caption', 'text/plain'); value.raw = [raw.blob];
    const projection = serialize(value, [], {}), prompt = await ctx.stage(Buffer.from(projection.prompt), 'caption', 'text/plain');
    value.review = {serializer: 'caption-json-1', sourceId: value.id, frame: value.frame, request: value.request,
      dependencies: projection.dependencies, boxes: projection.boxes, prompt: prompt.blob};
    const stored = await ctx.stage(Buffer.from(canonical(value)), 'text', 'application/octet-stream');
    const ref = {id: value.id, value: {...stored.blob, mediaType: 'application/json'}, bindings: {}};
    await ctx.execute({type: 'ApprovePromptProjection', composition: ref, draft: null}, 'historyCommand', true);
    versions.push({ref, raw: raw.blob, prompt: prompt.blob, review: value.review});
  }
  return versions;
}

async function retainAdapter(ctx, input, composition, signal) {
  const weights = await streamAsset(ctx, input, 'adapter', 'application/octet-stream', signal);
  const asset = assetOf(await ctx.execute({type: 'RegisterAdapterVersion', adapterId: null, previousVersionId: null,
    weightsAssetId: weights.id, configAssetId: null, provenanceAssetId: null, name: 'Mixed WC seed supported local example',
    declaredFamily: 'ideogram-v4', declaredFormat: 'fal', provenanceText: 'Retained local functional fixture; provider runtime is unverified.'}, 'adapterCommand'));
  const view = await ctx.writer.adapterView(asset.id);
  assert.equal(view.locallyEligible, true); assert.equal(view.runtimeVerified, false); assert.equal(view.profileId, 'v4-fal-public-example-1');
  assert.equal(view.weights.hash, OFFICIAL_ADAPTER.hash);
  const {newDraft} = await common.product(ctx, 'src/request/core.js');
  const draft = newDraft(composition.prompt); draft.operation = 'generate-adapters';
  draft.prompt = {mode: 'composition', text: composition.prompt, projection: composition.review, composition: composition.ref};
  draft.adapters = [{version: view.versionId, hash: view.weights.hash, scale: '1', runtimeAcknowledged: true}];
  draft.fields.expansion = composition.review.request.expansion; draft.rewriteAcknowledged = composition.review.request.rewriteAcknowledged;
  const saved = await ctx.stage(Buffer.from(JSON.stringify(draft)), 'caption', 'text/plain');
  const result = await ctx.ui({type: 'SaveDraft', draft: {id: 'seed_adapter_selection', generation: '1', kind: 'request', documentId: ctx.documentId,
    targetLayerId: null, expectedDocumentRevision: await ctx.writer.documentRevision(ctx.documentId), assetId: saved.id, composing: false}});
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  return {asset, view, draft: {assetId: saved.id, blob: saved.blob, prompt: draft.prompt, adapters: draft.adapters}, submitted: false};
}

async function verifyRequiredMembers(product, archive, output, refs, signal) {
  const db = product.spool(join(output, 'required-members.sqlite')); let zip;
  try {zip = new product.ZipIndex(archive, db); await zip.headers(() => check(signal)); for (const ref of refs) assert.equal(String(zip.entry('objects/' + ref.hash.slice(7)).bytes), ref.byteLength, 'Required exact dependency remains in the validated archive');}
  finally {try {zip?.close();} finally {db.close();}}
}

export async function prepareMixedWCSeed(options = {}) {
  const plan = mixedWCSeedPlan(options), {signal, onProgress = () => {}} = options;
  const entryMemory = processMemory();
  check(signal); assert.equal(process.versions.node, '26.10.0', 'Pinned Node required'); await freshOutput(plan);
  const inputs = await verifyInputs(plan, signal); check(signal);
  await mkdir(dirname(plan.output), {recursive: true, mode: 0o700}); await freshOutput(plan);
  const space = await statfs(dirname(plan.output), {bigint: true}); assert(space.bavail * space.bsize >= BigInt(plan.minimumFreeBytes), 'Insufficient mixed-seed preparation space');
  await mkdir(plan.output, {mode: 0o700});
  const record = {kind: KIND, schemaVersion: 1, qualification: false, preparationOnly: true, status: 'preparing', inputs, phases: [],
    memory: {kind: 'mixed-seed-phase-memory-1', qualification: false, scope: 'RSS includes this process and all worker threads; isolate counters are local; no residency or qualification verdict', entry: entryMemory, afterInputVerification: processMemory()},
    limits: ['Small real seed only; not WC512/WC4G or I12C qualification.', 'Alpha-zero native text establishes real layout/source/font/admission, not visible glyph or presentation quality.', 'One literal-127.0.0.1 candidate emulator; external providers disabled; no zero-network-attempt claim.']};
  let fixture;
  try {
    const phase = async (name, work) => {
      check(signal); const started = performance.now(), span = {name, beforeMemory: processMemory(), outcome: 'running'};
      record.phases.push(span);
      try {const result = await work(); span.afterWorkMemory = processMemory(); await onProgress({phase: name}); span.outcome = 'complete'; return result;}
      catch (error) {span.outcome = 'failed'; throw error;}
      finally {span.durationMs = performance.now() - started; span.afterMemory = processMemory();}
    };
    const corpus = join(plan.output, 'corpus'); await mkdir(corpus, {mode: 0o700});
    for (const [name, index] of [['original', 17], ['candidate', 29]]) await writeRasterPNG(join(corpus, name + '.png'), {width: 512, height: 512, index, alpha: false, signal});
    record.memory.beforeWriterOpen = processMemory();
    fixture = await common.createProductFixture({repo: plan.repo, output: join(plan.output, 'writer'), signal});
    record.memory.afterWriterOpen = processMemory();
    const ctx = {repo: plan.repo, root: fixture.root, documentId: fixture.documentId, sessionId: 'session_1', get writer() {return fixture.writer;}, getwriter: () => fixture.writer,
      auth: common.auth, stage: (bytes, purpose, media) => common.stageBlob(fixture, bytes, purpose, media), registered: assetOf,
      async execute(body, method, scoped = false) {check(signal); return common.finish(fixture.writer, common.envelope(body, scoped ? {documentId: fixture.documentId, expectedDocumentRevision: await fixture.writer.documentRevision(fixture.documentId)} : {}), method, signal);},
      async ui(body) {check(signal); const ui = await fixture.writer.uiRead('session_1', common.auth()); return fixture.writer.uiPersist(common.encode({protocolVersion: 1, requestId: randomUUID(), sessionId: 'session_1', expectedUISeq: ui.uiSeq, body}), common.auth());},
      async withClosedWriter(work) {await fixture.closeWriter(); const result = await work(); await fixture.reopen(); return result;}};
    await common.createDocument(fixture, {width: 512, height: 512});
    record.original = await phase('real-raster-import', async () => {
      const original = await ctx.stage(await readFile(join(corpus, 'original.png')), 'image', 'image/png');
      const prepared = assetOf(await ctx.execute({type: 'PrepareRaster', assetId: original.id}, 'rasterCommand'));
      const reviewed = await ctx.execute({type: 'ReviewRaster', assetId: prepared.id}, 'rasterCommand');
      const reviewId = reviewed.events.find(event => event.type === 'RasterReviewPrepared').payload.reviewId, review = await ctx.writer.rasterReview(reviewId, ctx.auth());
      const approved = assetOf(await ctx.execute({type: 'ApproveRaster', assetId: prepared.id, reviewId, reviewHash: review.reviewHash}, 'rasterCommand'));
      await ctx.execute({type: 'ImportAsset', assetId: approved.id, layerId: 'seed_picture', name: 'Original mixed seed image', draft: null}, 'historyCommand', true);
      return {original, prepared: approved};
    });
    record.native = await phase('real-native-history', () => prepareMixedSeedNative(ctx, {signal, onProgress}));
    record.compositions = await phase('canonical-reviewed-compositions', () => compositionVersions(ctx));
    const candidatePath = join(corpus, 'candidate.png'), candidate = {path: candidatePath, ...await fileIdentity(candidatePath, signal), width: 512, height: 512, format: 'png'};
    record.candidate = await phase('real-local-candidate', () => seedMixedWCCandidate(ctx, {candidate, signal, onProgress}));
    record.adapter = await phase('referenced-supported-adapter', () => retainAdapter(ctx, inputs.adapter, record.compositions.at(-1), signal));
    const expectedDocument = await ctx.writer.document(ctx.documentId), expectedImage = await ctx.writer.imageState(ctx.documentId);
    const saved = await phase('ordinary-save-copy', () => ctx.execute({type: 'SaveCopy'}, 'portableCommand', true));
    const bundle = saved.events.find(event => event.type === 'BundlePrepared')?.payload.bundle; assert.equal(bundle?.status, 'copy-ready');
    record.copyReceipt = saved.receipt;
    const bare = bundle.blob.hash.slice(7), storedArchive = join(ctx.root, 'objects', 'sha256', bare.slice(0, 2), bare), archivePath = join(plan.output, 'seed.zip');
    await copyFile(storedArchive, archivePath, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    await fixture.close(); fixture = undefined; record.memory.afterWriterClose = processMemory();
    const archive = {path: archivePath, ...await fileIdentity(archivePath, signal)};
    assert.deepEqual({hash: 'sha256:' + archive.sha256, byteLength: archive.byteLength, mediaType: 'application/x-ideogram-project'}, bundle.blob);
    const product = await productFor(plan.repo), inspected = await phase('complete-portable-inspection', () => inspectPortableArchive({repo: plan.repo, path: archivePath, output: plan.output, signal, product, includeReopenFonts: true}));
    assert.deepEqual(inspected.document, expectedDocument); assert(inspected.text && inspected.native, 'Current native font locator projection required');
    for (const name of FEATURES) assert(inspected.features[name].length > 0, 'Actual typed feature missing: ' + name);
    assert(inspected.counts.events < 10000 && inspected.counts.assets < 1000 && BigInt(inspected.counts.closureBytes) < 512n * BigInt(MiB));
    assert.equal(inspected.counts.captionVersions, 2);
    const refs = [...record.native.current, ...record.native.historical].flatMap(value => [value.source, value.text, value.layout, value.pixels, value.profile, ...value.fonts, ...value.licenses]);
    refs.push(record.adapter.asset.blob, ...record.candidate.contributions, ...record.compositions.flatMap(value => [value.ref.value, value.raw, value.prompt]));
    await verifyRequiredMembers(product, archivePath, plan.output, refs, signal);
    assert(inspected.features.adapters.includes(record.adapter.view.weights.hash));
    assert(inspected.features.licensedFonts.includes(record.native.historyOnlyFont.font.bytes.hash));
    assert(inspected.native.fonts.every(font => font.bytes.hash !== record.native.historyOnlyFont.font.bytes.hash), 'Old font must be history-only');
    assert.equal(expectedImage.layers.find(layer => layer.id === record.native.hiddenLayerId)?.visible, false);
    const root = ctx.root, files = await filesIn(root, signal);
    assert(!files.some(file => /^metadata\.sqlite-(wal|shm)$/.test(file.path)), 'Only a clean closed root can be sealed');
    // Even a read-only SQLite connection can create WAL/SHM. Inspect an owned
    // copy and keep the clean source root byte-identical throughout sealing.
    const sourceMetadata = join(root, 'metadata.sqlite'), scratch = join(plan.output, 'closed-root-inspection');
    const stamp = value => ({dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs});
    const sourceStamp = stamp(await lstat(sourceMetadata)), sourceIdentity = await fileIdentity(sourceMetadata, signal);
    assert.deepEqual(files.find(file => file.path === 'metadata.sqlite'), {path: 'metadata.sqlite', ...sourceIdentity});
    await mkdir(scratch, {mode: 0o700}); const copiedMetadata = join(scratch, 'metadata.sqlite');
    check(signal); await copyFile(sourceMetadata, copiedMetadata, constants.COPYFILE_EXCL);
    assert.deepEqual(stamp(await lstat(sourceMetadata)), sourceStamp);
    assert.deepEqual(await fileIdentity(sourceMetadata, signal), sourceIdentity);
    assert.deepEqual(await fileIdentity(copiedMetadata, signal), sourceIdentity);
    const db = new DatabaseSync(copiedMetadata, {readOnly: true});
    try {assert.deepEqual(JSON.parse(db.prepare('SELECT json FROM documents WHERE id=?').get(expectedDocument.id).json), inspected.document);} finally {db.close();}
    assert.deepEqual(await filesIn(root, signal), files, 'Inspection preserves the entire clean source root');
    assert.deepEqual(await verifyInputs(plan, signal), inputs, 'Original pinned inputs are unchanged');
    assert.deepEqual(await fileIdentity(archivePath, signal), {sha256: archive.sha256, byteLength: archive.byteLength});
    const seed = {root, documentId: inspected.document.id, archive};
    Object.assign(record, {status: 'complete', closed: true, seed, files, counts: inspected.counts, features: inspected.features, text: inspected.text, native: record.native, reopen: inspected.native});
    check(signal);
    await writeFile(join(plan.output, 'preparation.json'), json(record), {flag: 'wx', mode: 0o600});
    // Only this final publication creates an input admitted by the WC grower.
    check(signal);
    const seedPath = join(plan.output, 'seed.json'); await writeFile(seedPath, json(seed), {flag: 'wx', mode: 0o600});
    return {seedPath, seed, preparationPath: join(plan.output, 'preparation.json'), qualification: false, status: 'complete'};
  } catch (error) {
    let failure = error;
    record.memory.atFailure = processMemory();
    // Diagnostics cannot replace the original failure, resubmit an operation, or
    // keep a diagnostic lease alive across the existing owner drain.
    try {record.failureResources = await failureResources(fixture);}
    catch (diagnostic) {record.failureResources = {unavailable: true, code: diagnostic.code ?? diagnostic.name};}
    try {await fixture?.close();} catch (cleanup) {failure = new AggregateError([error, cleanup], 'Mixed seed failed and owner cleanup failed');}
    record.memory.afterFailureCleanup = processMemory();
    Object.assign(record, {status: 'incomplete', error: {name: failure.name, code: failure.code ?? null, message: String(failure.message).slice(0, 4096)}});
    try {await writeFile(join(plan.output, 'preparation-failure.json'), json(record), {flag: 'wx', mode: 0o600});}
    catch (retention) {throw new AggregateError([failure, retention], 'Mixed seed failed and failure record could not be retained');}
    throw failure;
  }
}

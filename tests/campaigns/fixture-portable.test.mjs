import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fstatSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveFeatureEvidence, buildPortableFixture, inspectPortableArchive, openPortableFixtureWriter, portableFixturePlan, withClosedSeedDatabase } from '../../tooling/qualification/campaigns/fixture-portable.mjs';
import { fileIdentity, productFor, verifyArchive } from '../../tooling/qualification/campaigns/backend-portable.mjs';
import * as portableCommon from '../../tooling/qualification/campaigns/backend-common.mjs';
import { ownTestRoot } from '../../tooling/qualification/owned-test-roots.mjs';

const seed = () => ({ root: '/closed/mixed-root', documentId: 'mixed_document', archive: {
  path: '/sealed/mixed.zip', sha256: 'a'.repeat(64), byteLength: '20000',
} });

test('WC plan pins full workloads and discloses production mutations as preparation only', () => {
  const normal = portableFixturePlan({ workload: 'WC512', seed: seed() });
  const stress = portableFixturePlan({ workload: 'WC4G', seed: seed() });
  assert.deepEqual([normal.closureBytes, normal.assets, normal.events], ['536870912', 1000, 10000]);
  assert.deepEqual([stress.closureBytes, stress.assets, stress.events, stress.captionVersions], ['4294967296', 10000, 100000, 4096]);
  assert.equal(normal.qualification, false); assert.equal(normal.preparationOnly, true);
  assert(normal.mutations.some(value => value.includes('production') || value.includes('ImportBundle')));
  assert(normal.mutations.some(value => value.includes('SaveCopy')));
  for (const workload of ['WC', 'WC1', 'smoke', { id: 'WC512', assets: 1 }]) {
    assert.throws(() => portableFixturePlan({ workload, seed: seed() }), { code: 'FIXTURE_REQUIRED' });
  }
});

test('valid plan freezes caller-owned seed identities', () => {
  const input = seed(), plan = portableFixturePlan({ workload: 'WC512', seed: input });
  input.archive.sha256 = 'b'.repeat(64); input.root = '/different';
  assert.equal(plan.seed.archive.sha256, 'a'.repeat(64)); assert.equal(plan.seed.root, '/closed/mixed-root');
});

test('missing mixed seed returns explicit inconclusive without creating output', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'wc-missing-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await buildPortableFixture({ workload: 'WC4G', output: join(parent, 'must-not-exist') });
  assert.equal(result.status, 'inconclusive'); assert.equal(result.qualification, false);
  assert(result.missing[0].includes('mixed')); assert.deepEqual(await readdir(parent), []);
});

test('valid seed requires explicit heavy preparation and complete archive identity', async () => {
  for (const archive of [{}, { path: '/archive', sha256: 'short', byteLength: '12' }, { path: '/archive', sha256: 'a'.repeat(64), byteLength: '0' }]) {
    assert.throws(() => portableFixturePlan({ workload: 'WC512', seed: { ...seed(), archive } }), { code: 'FIXTURE_REQUIRED' });
  }
  await assert.rejects(buildPortableFixture({ workload: 'WC512', seed: seed() }), /allowHeavy:true/);
});

// These tiny indexes model the already-validated typed tables left by the
// production closure validator. They test evidence classification only, never
// pretend to be real WC archives, font validation, or performance samples.
function typedIndex(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE refs(hash TEXT PRIMARY KEY,bytes TEXT); CREATE TABLE entities(kind TEXT,id TEXT,json TEXT); CREATE TABLE adopted_lineages(json TEXT); CREATE TABLE text_sources(hash TEXT,json TEXT); CREATE TABLE semantic_versions(id TEXT,ref TEXT)');
  const content = new Map();
  const ref = value => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    db.prepare('INSERT OR IGNORE INTO refs VALUES (?,?)').run(hash, String(bytes.length)); content.set(hash, bytes);
    return { hash, byteLength: String(bytes.length), mediaType: 'application/json' };
  };
  const entity = (kind, id, value) => db.prepare('INSERT INTO entities VALUES (?,?,?)').run(kind, id, JSON.stringify(value));
  const encoded = ref('encoded original'), pixels = ref('actual pixel identity'), fontBytes = ref('licensed font'), license = ref('license'), layout = ref('frozen layout');
  entity('asset', 'original', { blob: encoded });
  const contribution = ref({ plan: { kind: 'cp1-layer-contribution-v1' } });
  const stack = ref({ kind: 'cp1-contribution-stack-v1', contributions: [{ manifest: contribution, pixels }] });
  const raster = ref({ plan: { kind: 'decoded-native', sourceAssetId: 'original', contributions: stack } });
  entity('asset', 'prepared', { blob: pixels, raster: { manifest: raster } });
  entity('candidate-result', 'candidate', { safety: 'safe', encodedAssetId: 'original', preparedAssetId: 'prepared' });
  const source = { text: { textUtf8: ref('Editable native text'), fonts: [{ embedding: 'permitted', bytes: fontBytes, licenseRecord: license }] }, render: { layout } };
  const sourceRef = ref(source); db.prepare('INSERT INTO text_sources VALUES (?,?)').run(sourceRef.hash, JSON.stringify(source));
  const raw = ref('Original caption\n'), prompt = ref('Derived caption');
  const composition = ref({ id: 'composition_1', raw: [raw], review: { prompt } });
  db.prepare('INSERT INTO semantic_versions VALUES (?,?)').run('composition_1', JSON.stringify({ id: 'composition_1', value: composition, bindings: {} }));
  const adapter = ref('Weights'); entity('asset', 'adapter', { qualification: 'adapter-version', adapter: { weights: adapter, config: null, validation: {} } });
  return { db, read: async ref => { assert(content.has(ref.hash)); return content.get(ref.hash); }, ref, encoded, raw, prompt, composition };
}

test('feature evidence follows typed raster/candidate/native/composition/adapter edges', async t => {
  const fixture = typedIndex(t), evidence = await archiveFeatureEvidence(fixture.db, fixture.read);
  assert.equal(evidence.captionVersions, 1); assert.equal(evidence.typedFeaturesVerified, true);
  assert(evidence.features.originals.includes(fixture.encoded.hash));
  assert(evidence.features.retainedCandidates.includes(fixture.encoded.hash));
  assert(evidence.features.rawCaptions.includes(fixture.raw.hash));
  assert(evidence.features.derivedCaptions.includes(fixture.prompt.hash));
  for (const name of ['editableText', 'licensedFonts', 'frozenLayouts', 'contributions', 'adapters']) assert(evidence.features[name].length > 0, name);
});

test('arbitrary rooted hashes cannot masquerade as typed feature evidence', async t => {
  const fixture = typedIndex(t), padding = fixture.ref('unrelated rooted bytes');
  await assert.rejects(archiveFeatureEvidence(fixture.db, fixture.read, { seal: {
    counts: { captionVersions: 1 }, features: { originals: [padding.hash] },
  } }), /not typed retained evidence/);
  await assert.rejects(archiveFeatureEvidence(fixture.db, fixture.read, { seal: {
    counts: { captionVersions: 1 }, features: { unknown: [padding.hash] },
  } }), /Unknown WC feature/);
});

test('declared 4096 caption versions cannot replace actual retained version count', async t => {
  const fixture = typedIndex(t);
  await assert.rejects(archiveFeatureEvidence(fixture.db, fixture.read, { seal: {
    counts: { captionVersions: 4096 }, features: { rawCaptions: [fixture.raw.hash], derivedCaptions: [fixture.composition.hash] },
  } }), /Exact retained reviewed caption version count/);
});


import {portableReopenFontProjection} from '../../tooling/qualification/campaigns/fixture-portable.mjs';

// These model the already-validated typed archive index. Real SQLite SELECTs
// and exact metadata hashing run; no native-font validation is claimed here.
function reopenProjectionFixture(t,{fontCount=1,text=true}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE entities(kind TEXT,id TEXT,json TEXT)');
 const content=new Map(),reads=[];
 const ref=(value,mediaType='application/json')=>{const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value)),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');content.set(hash,bytes);return {hash,byteLength:String(bytes.length),mediaType};};
 const fonts=Array.from({length:fontCount},(_,i)=>({id:ref('font identity '+i).hash,bytes:ref('font bytes '+i,'font/ttf'),licenseRecord:ref('license '+i,'text/plain'),embedding:'permitted'}));
 for(const [i,font]of fonts.entries()){const id='imported_font_'+i;db.prepare('INSERT INTO entities VALUES (?,?,?)').run('asset',id,JSON.stringify({id,purpose:'font',qualification:'font',safety:'safe',availability:'available',font,blob:font.bytes}));}
 const sources=[],layers=[];
 for(let i=0;i<(fontCount===1?2:fontCount);i++){
  const font=fonts[Math.min(i,fontCount-1)],source={text:{textUtf8:ref('current text '+i,'text/plain'),fonts:[font]},render:{layout:ref({glyphs:[i]}),pixels:ref('pixels '+i,'application/x-ideogram-rgba8'),rendererProfile:{id:ref('renderer').hash}}};
  const sourceRef=ref(source);sources.push(source);layers.push({id:'imported_layer_'+i,kind:text?'text':'image',visible:i!==1,source:sourceRef});
 }
 const image={layers},imageState=ref(image),document={id:'final_imported_document',revision:'19',image:{state:imageState,semanticDigest:ref('semantic graph').hash},orderedLayerIds:layers.map(layer=>layer.id)};
 const read=async input=>{reads.push(input.hash);assert(content.has(input.hash));return Buffer.from(content.get(input.hash));};
 const rows=()=>db.prepare('SELECT * FROM entities ORDER BY kind,id').all();
 return {db,read,reads,ref,content,fonts,sources,layers,image,document,rows};
}

test('portable reopen projection reads the final current hidden text and exact deduplicated font locators without mutation',async t=>{
 const f=reopenProjectionFixture(t),before=f.rows(),changes=f.db.prepare('SELECT total_changes() AS n').get().n;
 const value=await portableReopenFontProjection(f.db,f.read,f.document);
 assert.deepEqual(value.text,{schema:'browser-reopen-text-fixture-1',documentId:f.document.id,revision:'19',imageState:f.document.image.state,semanticDigest:f.document.image.semanticDigest,orderedLayerIds:f.document.orderedLayerIds});
 assert.equal(f.layers[1].visible,false);assert.equal(value.native.textFacts.length,2);assert.deepEqual(value.native.fonts,f.fonts);assert.deepEqual(value.native.fontAssetIds,['imported_font_0']);
 assert.deepEqual(value.native.textFacts,f.layers.map((layer,i)=>({layerId:layer.id,sourceHash:layer.source.hash,textHash:f.sources[i].text.textUtf8.hash,textBytes:Number(f.sources[i].text.textUtf8.byteLength),layoutHash:f.sources[i].render.layout.hash,pixelHash:f.sources[i].render.pixels.hash,rendererHash:f.sources[i].render.rendererProfile.id,fonts:[f.fonts[0].bytes.hash]})));
 assert.deepEqual(f.reads,[f.document.image.state.hash,...f.layers.map(layer=>layer.source.hash)]);assert.deepEqual(f.rows(),before);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,changes);
});

test('portable reopen projection rejects changed metadata bytes and mismatched current layer order',async t=>{
 for(const kind of ['hash','order']){
  const f=reopenProjectionFixture(t);
  if(kind==='hash'){const bytes=Buffer.from(f.content.get(f.layers[0].source.hash));bytes[0]^=1;f.content.set(f.layers[0].source.hash,bytes);}else f.document.orderedLayerIds.reverse();
  const before=f.rows();await assert.rejects(portableReopenFontProjection(f.db,f.read,f.document),{code:'ERR_ASSERTION'});assert.deepEqual(f.rows(),before);
  assert.equal(f.reads.length,kind==='hash'?2:1);
 }
});

test('portable reopen projection enforces existing image and source metadata bounds before their reads',async t=>{
 for(const kind of ['image','source']){
  const f=reopenProjectionFixture(t);
  if(kind==='image')f.document.image.state={...f.document.image.state,byteLength:String(1048577)};
  else{f.layers[0].source={...f.layers[0].source,byteLength:'65537'};f.document.image.state=f.ref(f.image);}
  await assert.rejects(portableReopenFontProjection(f.db,f.read,f.document),/Bounded current metadata ref required/);assert.equal(f.reads.length,kind==='image'?0:1);
 }
});

test('portable reopen projection refuses missing or unsafe typed font locators without substituting IDs',async t=>{
 for(const kind of ['missing','unsafe','bytes']){
  const f=reopenProjectionFixture(t),row=f.rows()[0];
  if(kind==='missing')f.db.prepare('DELETE FROM entities').run();else{const asset=JSON.parse(row.json);if(kind==='unsafe')asset.safety='unsafe';else asset.blob=f.ref('substitute font','font/ttf');f.db.prepare('UPDATE entities SET json=? WHERE id=?').run(JSON.stringify(asset),row.id);}
  const before=f.rows(),changes=f.db.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(portableReopenFontProjection(f.db,f.read,f.document),{code:'ERR_ASSERTION'});assert.deepEqual(f.rows(),before);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,changes);
 }
});

test('portable reopen projection cannot turn an empty native closure or over-limit union into a substitution zero',async t=>{
 const empty=reopenProjectionFixture(t,{text:false});await assert.rejects(portableReopenFontProjection(empty.db,empty.read,empty.document),/Current portable native text is unavailable/);
 const excessive=reopenProjectionFixture(t,{fontCount:17});await assert.rejects(portableReopenFontProjection(excessive.db,excessive.read,excessive.document),/Current public font locator boundary exceeded/);
 assert.equal(excessive.reads.length,18);assert.equal(excessive.rows().length,17);
});


// Small real ordinary-writer archives exercise the production archive helpers.
// Their observed counts are used honestly below; this is not WC512/WC4G fixture
// admission, workload timing, or a replacement for any large-volume campaign.
async function smallCompositionArchive(t) {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const output = ownTestRoot(await mkdtemp(join(tmpdir(), 'portable-composition-closure-')));
  const product = await productFor(repo), core = await portableCommon.product({repo}, 'src/composition/core.js');
  const {canonical} = await portableCommon.product({repo}, 'src/protocol/json.js');
  const f = await portableCommon.createProductFixture({repo, output: join(output, 'writer')});
  try {
    await portableCommon.createDocument(f, {width: 3, height: 2});
    const raw = await portableCommon.stageBlob(f, Buffer.from('Original caption with retained Unicode: Café / 東京\n'), 'text', 'application/octet-stream');
    let composition = core.emptyComposition(3, 2, randomUUID());
    const element = core.emptyElement('text', 'caption_element'); element.text.value = 'Editable semantic caption';
    composition.scene = 'Small portable closure control'; composition.elements = [element]; composition.raw = [raw.blob];
    const commit = async type => {
      const stored = await portableCommon.stageBlob(f, Buffer.from(canonical(composition)), 'text', 'application/octet-stream');
      const value = {...stored.blob, mediaType: 'application/json'};
      await portableCommon.finish(f.writer, portableCommon.envelope({type, composition: {id: composition.id, value, bindings: {}}, draft: null},
        {documentId: f.documentId, expectedDocumentRevision: await f.writer.documentRevision(f.documentId)}), 'historyCommand');
      return value;
    };
    const initialGraph = await commit('CommitCompositionVersion');
    composition = structuredClone(composition); composition.id = randomUUID();
    const projected = core.serialize(composition, [], {}), prompt = await portableCommon.stageCaption(f, projected.prompt);
    composition.review = {serializer: 'caption-json-1', sourceId: composition.id, frame: composition.frame, request: composition.request,
      dependencies: projected.dependencies, boxes: projected.boxes, prompt: prompt.blob};
    const reviewedGraph = await commit('ApprovePromptProjection'), expectedDocument = await f.writer.document(f.documentId);
    assert.equal(expectedDocument.compositionVersion, composition.id);
    const saveRequest = portableCommon.envelope({type: 'SaveCopy'},
      {documentId: f.documentId, expectedDocumentRevision: expectedDocument.revision});
    let saved;
    try { saved = await portableCommon.finish(f.writer, saveRequest, 'portableCommand'); }
    catch (error) {
      // Preserve the actual command and bounded producer rejection for diagnosis.
      // This does not turn a rejected SaveCopy into a usable archive or test pass.
      try {
        const state = await f.writer.commandState(saveRequest.command.commandId), receipt = state.record?.receipt ?? null;
        let details = null;
        if (receipt?.status === 'rejected' && receipt.details) {
          const length = Number(receipt.details.byteLength);
          assert(Number.isSafeInteger(length) && length > 0 && length <= 65536);
          const bytes = Buffer.from(await f.writer.readMetadata(receipt.details));
          assert.equal(String(bytes.length), receipt.details.byteLength);
          assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), receipt.details.hash);
          details = {ref: receipt.details, value: JSON.parse(bytes.toString('utf8'))};
        }
        const diagnostic = join(output, 'save-copy-failure.json');
        await writeFile(diagnostic, JSON.stringify({kind: 'small-composition-save-copy-failure-1',
          commandId: saveRequest.command.commandId, receipt, details}, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
        t.diagnostic('Actual SaveCopy failure retained at ' + diagnostic);
      } catch (captureError) { throw new AggregateError([error, captureError], 'SaveCopy failed and rejection detail capture failed'); }
      throw error;
    }
    const bundle = saved.events.find(event => event.type === 'BundlePrepared')?.payload.bundle;
    assert.equal(bundle?.status, 'copy-ready');
    const bare = bundle.blob.hash.slice(7), path = join(f.root, 'objects', 'sha256', bare.slice(0, 2), bare);
    assert.deepEqual(await fileIdentity(path), {sha256: bare, byteLength: bundle.blob.byteLength});
    return {repo, output, product, path, bundle, expectedDocument, initialGraph, reviewedGraph, raw: raw.blob, prompt: prompt.blob};
  } finally {await f.close();}
}

// These wrappers delegate every real archive read/validation and every actual
// Composition reservation. Faults occur only once a production metadata read
// has both its graph scope and its async cache reservations, not at a fake API.
function observedArchiveProduct(actual, {fault, controller} = {}) {
  const owners = [], databases = [], zips = [], calls = [], activeReads = [];
  const injected = Error('controlled portable Composition metadata ' + (fault ?? 'read'));
  let injectedOnce = false;
  class ObservedCompositionMemory extends actual.CompositionMemory {
    constructor(...args) {super(...args); owners.push({value: this, before: this.resourceOwnership()});}
  }
  class ObservedZipIndex extends actual.ZipIndex {
    constructor(...args) {super(...args); this.closeCalls = 0; zips.push(this);}
    async *chunks(entry, check) {
      const current = owners.find(owner => owner.value.resourceOwnership().borrowers >= 2);
      if (current) {
        activeReads.push({entry: entry.name, ownership: current.value.resourceOwnership()});
        if (fault && !injectedOnce) {
          injectedOnce = true;
          if (fault === 'read-failure') throw injected;
          assert.equal(fault, 'abort'); controller.abort(injected);
        }
      }
      yield* super.chunks(entry, check);
    }
    close() {this.closeCalls++; return super.close();}
  }
  const product = {...actual, CompositionMemory: ObservedCompositionMemory, ZipIndex: ObservedZipIndex,
    spool(path) {const db = actual.spool(path); databases.push(db); return db;},
    async validateClosure(...args) {
      assert(args[3] instanceof actual.CompositionMemory, 'Fourth closure argument is the actual Composition owner');
      calls.push({owner: args[3], flags: args.slice(4)});
      return actual.validateClosure(...args);
    },
  };
  const drained = () => {
    assert.equal(owners.length, 1); assert.equal(databases.length, 1); assert.equal(zips.length, 1); assert.equal(calls.length, 1);
    assert(activeReads.length > 0, 'Real Composition closure enters owned metadata reads');
    assert(activeReads.every(read => read.entry.startsWith('objects/') && read.ownership.borrowedBytes > 0));
    for (const owner of owners) {assert.deepEqual(owner.value.resourceOwnership(), owner.before); assert.equal(owner.value.bytes, 0);}
    for (const zip of zips) {assert.equal(zip.closeCalls, 1); assert.throws(() => fstatSync(zip.fd), {code: 'EBADF'});}
    for (const db of databases) assert.throws(() => db.prepare('SELECT 1'), /not open|closed/i);
    if (fault) assert.equal(injectedOnce, true, 'Fault is delivered during the protected real metadata read');
  };
  return {product, owners, calls, activeReads, injected, drained};
}
const smallArchiveSeal = inspected => ({documentId: inspected.document.id, counts: structuredClone(inspected.counts), features: structuredClone(inspected.features)});
const closureFlags = format => [4, 5, 6, 7, 9, 10, 10, 12, 13].map(minimum => format >= minimum);

test('both portable archive validators accept a genuine ordinary-writer Composition closure with exact small counts', async t => {
  const f = await smallCompositionArchive(t), inspect = observedArchiveProduct(f.product);
  const actual = await inspectPortableArchive({repo: f.repo, path: f.path, output: f.output, product: inspect.product});
  inspect.drained();
  assert(actual.formatVersion >= 7); assert.equal(actual.document.id, f.expectedDocument.id);
  assert.equal(actual.document.compositionVersion, f.expectedDocument.compositionVersion);
  assert.equal(actual.fullHashesVerified, true); assert.equal(actual.semanticClosureVerified, true); assert.equal(actual.typedFeaturesVerified, true);
  assert.equal(actual.counts.captionVersions, 1); assert(actual.counts.events > 0); assert(BigInt(actual.counts.closureBytes) > 0n);
  assert(BigInt(actual.counts.closureBytes) < 536870912n); assert(actual.counts.assets < 1000 && actual.counts.events < 10000);
  assert.deepEqual(actual.features.rawCaptions, [f.raw.hash]);
  assert.deepEqual(actual.features.derivedCaptions, [f.reviewedGraph.hash, f.prompt.hash].sort());
  assert.deepEqual(inspect.calls[0].flags, closureFlags(actual.formatVersion));
  const verify = observedArchiveProduct(f.product), seal = smallArchiveSeal(actual);
  const checked = await verifyArchive(verify.product, f.path, f.output, seal);
  verify.drained(); assert.deepEqual(verify.calls[0].flags, closureFlags(actual.formatVersion));
  assert.equal(checked.documentId, actual.document.id); assert.equal(checked.formatVersion, actual.formatVersion);
  for (const name of ['events', 'assets', 'closureBytes', 'manifestBytes', 'captionVersions']) assert.equal(checked[name], actual.counts[name], name);
  assert.equal(checked.fullHashesVerified, true); assert.equal(checked.semanticClosureVerified, true); assert.equal(checked.typedFeaturesVerified, true);
  assert.equal(checked.ownedClosureHashesVerified, false); assert.match(checked.inputIdentity, /^sha256:[a-f0-9]{64}$/);
  // Successful validation is read-only: the actual archive is still its writer's
  // exact retained object, including the earlier unreviewed Composition version.
  assert.notEqual(f.initialGraph.hash, f.reviewedGraph.hash);
  assert.deepEqual(await fileIdentity(f.path), {sha256: f.bundle.blob.hash.slice(7), byteLength: f.bundle.blob.byteLength});
});

for (const helper of ['inspectPortableArchive', 'verifyArchive']) test(helper + ' drains real Composition owners and archive handles on protected read failure and abort', async t => {
  const f = await smallCompositionArchive(t);
  const baseline = await inspectPortableArchive({repo: f.repo, path: f.path, output: f.output, product: f.product});
  for (const fault of ['read-failure', 'abort']) {
    const controller = new AbortController(), observed = observedArchiveProduct(f.product, {fault, controller});
    const run = () => helper === 'inspectPortableArchive'
      ? inspectPortableArchive({repo: f.repo, path: f.path, output: f.output, product: observed.product, signal: controller.signal})
      : verifyArchive(observed.product, f.path, f.output, smallArchiveSeal(baseline), controller.signal);
    await assert.rejects(run(), error => error === observed.injected);
    observed.drained(); assert.deepEqual(observed.calls[0].flags, closureFlags(baseline.formatVersion));
    assert.equal(controller.signal.aborted, fault === 'abort');
  }
  // A failed diagnostic read neither mutates the source nor poisons a later
  // independent owner. Reverify the same archive with unmodified product APIs.
  const after = await inspectPortableArchive({repo: f.repo, path: f.path, output: f.output, product: f.product});
  assert.deepEqual(after, baseline);
  assert.deepEqual(await fileIdentity(f.path), {sha256: f.bundle.blob.hash.slice(7), byteLength: f.bundle.blob.byteLength});
});


// Tiny actual WAL-mode databases exercise only the copied inspection boundary.
// These are not product rows, mixed seeds, WC admission or timing evidence.
async function inspectionFiles(root, directory = '') {
  const files = [];
  for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = directory ? directory + '/' + entry.name : entry.name;
    assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) files.push(...await inspectionFiles(root, path));
    else { assert(entry.isFile()); files.push({ path, ...await fileIdentity(join(root, path)) }); }
  }
  return files;
}
async function closedWALInspection(t) {
  const parent = ownTestRoot(await realpath(await mkdtemp(join(tmpdir(), 'wc-seed-inspection-'))));
  t.diagnostic('Retained inspection-boundary control: ' + parent);
  const root = join(parent, 'source'), output = join(parent, 'output');
  await mkdir(root, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
  const db = new DatabaseSync(join(root, 'metadata.sqlite'));
  try {
    assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal');
    db.exec('PRAGMA synchronous=FULL; CREATE TABLE inspection_values(id TEXT PRIMARY KEY, value TEXT) STRICT;');
    db.prepare('INSERT INTO inspection_values VALUES (?,?)').run('retained', 'exact closed WAL value');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  await mkdir(join(root, 'objects'), { mode: 0o700 }); await writeFile(join(root, 'objects', 'opaque'), 'Independent retained bytes', { mode: 0o600, flag: 'wx' });
  const sourceFiles = await inspectionFiles(root);
  assert(!sourceFiles.some(file => /^metadata\.sqlite-(wal|shm)$/.test(file.path)));
  return { root, output, sourceFiles, scratch: join(output, 'seed-source-inspection') };
}
const inspectedValue = db => db.prepare('SELECT value FROM inspection_values WHERE id=?').get('retained').value;
const assertInspectionClosed = db => assert.throws(() => db.prepare('SELECT 1'), /not open|closed/i);

test('closed-WAL seed inspection uses an exact read-only private copy and preserves every source file', async t => {
  const f = await closedWALInspection(t); let observed;
  const result = await withClosedSeedDatabase(f, db => {
    observed = db; assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.throws(() => db.prepare('UPDATE inspection_values SET value=?').run('must not write'), /readonly|read.only/i);
    return inspectedValue(db);
  });
  assert.equal(result, 'exact closed WAL value'); assertInspectionClosed(observed);
  assert.deepEqual(await inspectionFiles(f.root), f.sourceFiles);
  const metadata = f.sourceFiles.find(file => file.path === 'metadata.sqlite');
  assert.deepEqual(await fileIdentity(join(f.scratch, 'metadata.sqlite')), { sha256: metadata.sha256, byteLength: metadata.byteLength });
  assert.equal((await lstat(f.scratch)).mode & 0o777, 0o700);
});

test('closed-WAL seed inspection preserves the actual query error, closes its copy and retains unchanged failure custody', async t => {
  const f = await closedWALInspection(t); let observed, original;
  await assert.rejects(withClosedSeedDatabase(f, db => {
    observed = db; assert.equal(inspectedValue(db), 'exact closed WAL value');
    try { db.prepare('SELECT missing_column FROM inspection_values').get(); }
    catch (error) { original = error; throw error; }
  }), error => error === original && error.code === 'ERR_SQLITE_ERROR');
  assertInspectionClosed(observed); assert.deepEqual(await inspectionFiles(f.root), f.sourceFiles);
  assert((await lstat(join(f.scratch, 'metadata.sqlite'))).isFile(), 'Failed inspection copy remains in owned evidence');
});

test('closed-WAL seed inspection fails closed on source mutation and preserves the ordered query and integrity failures', async t => {
  for (const queryFails of [false, true]) {
    const f = await closedWALInspection(t), original = Error('Original inspected-query failure'); let observed;
    await assert.rejects(withClosedSeedDatabase(f, async db => {
      observed = db; assert.equal(inspectedValue(db), 'exact closed WAL value');
      await writeFile(join(f.root, 'objects', 'opaque'), 'Changed source remains retained');
      if (queryFails) throw original;
    }), error => queryFails ? error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === original && error.errors[1].code === 'ERR_ASSERTION' : error.code === 'ERR_ASSERTION');
    assertInspectionClosed(observed); assert.notDeepEqual(await inspectionFiles(f.root), f.sourceFiles);
    assert((await lstat(join(f.scratch, 'metadata.sqlite'))).isFile());
  }
});

test('closed-WAL seed inspection refuses stale or contaminated sources and reused, overlapping or symlinked scratch roots', async t => {
  for (const kind of ['stale', 'wal', 'shm', 'reused', 'overlap', 'symlink']) {
    const f = await closedWALInspection(t); let output = f.output, calls = 0;
    if (kind === 'stale') await writeFile(join(f.root, 'objects', 'opaque'), 'Changed before capture admission');
    if (kind === 'wal' || kind === 'shm') { await writeFile(join(f.root, 'metadata.sqlite-' + kind), '', { flag: 'wx', mode: 0o600 }); f.sourceFiles = await inspectionFiles(f.root); }
    if (kind === 'reused') { await mkdir(f.scratch, { mode: 0o700 }); await writeFile(join(f.scratch, 'sentinel'), 'Existing evidence', { flag: 'wx', mode: 0o600 }); }
    if (kind === 'overlap') output = f.root;
    if (kind === 'symlink') { output = join(f.output, 'alias'); await symlink(f.output, output, 'dir'); }
    const before = await inspectionFiles(f.root);
    await assert.rejects(withClosedSeedDatabase({ ...f, output }, () => { calls++; }), error =>
      kind === 'reused' ? error.code === 'EEXIST' : kind === 'wal' || kind === 'shm' ? error.code === 'FIXTURE_REQUIRED' : error.code === 'ERR_ASSERTION');
    assert.equal(calls, 0); assert.deepEqual(await inspectionFiles(f.root), before);
    if (kind === 'reused') assert.deepEqual(await readdir(f.scratch), ['sentinel']);
    else assert(!((await readdir(output)).includes('seed-source-inspection')), kind);
  }
});

test('closed-WAL seed inspection preserves exact cancellation before admission and after a real query', async t => {
  for (const timing of ['before', 'after-query']) {
    const f = await closedWALInspection(t), controller = new AbortController(), original = Error('Selected inspection cancellation'); let observed;
    if (timing === 'before') controller.abort(original);
    await assert.rejects(withClosedSeedDatabase({ ...f, signal: controller.signal }, db => {
      observed = db; assert.equal(inspectedValue(db), 'exact closed WAL value'); controller.abort(original);
    }), error => error === original);
    assert.deepEqual(await inspectionFiles(f.root), f.sourceFiles);
    if (observed) assertInspectionClosed(observed);
    else assert.deepEqual(await readdir(f.output), []);
  }
});

// Observe real SQLite commits made by the actual archive validator. The journal
// stays in the owned preparation output, including on failure; these small
// controls do not establish WC capacity, timing or storage-monitor conformance.
const inspectionPragmas = db => ({
  journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
  synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
  cacheSize: db.prepare('PRAGMA cache_size').get().cache_size,
  tempStore: db.prepare('PRAGMA temp_store').get().temp_store,
});
function persistentInspectionProduct(actual, options) {
  const observed = observedArchiveProduct(actual, options), phases = [];
  let database, path, initial;
  const retain = label => {
    const info = lstatSync(path + '-journal');
    assert(info.isFile() && !info.isSymbolicLink() && info.size > 0);
    phases.push({label, dev: info.dev, ino: info.ino, settings: inspectionPragmas(database),
      changes: database.prepare('SELECT total_changes() n').get().n,
      entries: database.prepare('SELECT count(*) n FROM zip_entries').get().n,
      hashed: database.prepare('SELECT count(*) n FROM zip_entries WHERE sha256 IS NOT NULL').get().n});
  };
  class RetainedJournalZip extends observed.product.ZipIndex {
    constructor(...args) {super(...args); retain('schema');}
    async headers(check) {await super.headers(check); retain('headers');}
    async hashes(check) {await super.hashes(check); retain('hashes');}
    close() {try {retain('before-close');} finally {super.close();}}
  }
  const product = {...observed.product, ZipIndex: RetainedJournalZip,
    spool(value) {path = value; database = observed.product.spool(value); initial = inspectionPragmas(database); return database;},
  };
  const retained = () => {
    observed.drained();
    assert.deepEqual(initial, {journalMode: 'delete', synchronous: 2, cacheSize: -2048, tempStore: 1});
    assert.deepEqual(phases.map(phase => phase.label), ['schema', 'headers', 'hashes', 'before-close']);
    for (const phase of phases) {
      assert.deepEqual(phase.settings, {journalMode: 'persist', synchronous: 2, cacheSize: -2048, tempStore: 1});
      assert.equal(phase.dev, phases[0].dev); assert.equal(phase.ino, phases[0].ino);
    }
    assert.equal(phases[0].entries, 0);
    assert(phases[1].entries > 0 && phases[1].changes > phases[0].changes);
    assert.equal(phases[1].hashed, 0);
    assert.equal(phases[2].entries, phases[1].entries); assert.equal(phases[2].hashed, phases[1].entries);
    assert(phases[2].changes > phases[1].changes, 'Real entry hashing commits update the same retained journal');
    const closed = lstatSync(path + '-journal');
    assert(closed.isFile() && !closed.isSymbolicLink() && closed.size > 0);
    assert.equal(closed.dev, phases[0].dev); assert.equal(closed.ino, phases[0].ino);
  };
  return {product, retained, injected: observed.injected};
}

test('private portable inspection retains one real journal through commits and close without changing archive results or product defaults', async t => {
  const f = await smallCompositionArchive(t), observed = persistentInspectionProduct(f.product);
  const inspected = await inspectPortableArchive({repo: f.repo, path: f.path, output: f.output, product: observed.product});
  observed.retained();
  const checked = await verifyArchive(f.product, f.path, f.output, smallArchiveSeal(inspected));
  assert.deepEqual(inspected.counts, Object.fromEntries(['closureBytes', 'events', 'assets', 'captionVersions', 'manifestBytes'].map(name => [name, checked[name]])));
  assert.equal(inspected.document.id, f.expectedDocument.id);
  assert.equal(inspected.document.compositionVersion, f.expectedDocument.compositionVersion);
  assert.equal(inspected.formatVersion, checked.formatVersion);
  assert.equal(inspected.fullHashesVerified, true); assert.equal(inspected.semanticClosureVerified, true); assert.equal(inspected.typedFeaturesVerified, true);
  assert.deepEqual(inspected.features.rawCaptions, [f.raw.hash]);
  assert.deepEqual(inspected.features.derivedCaptions, [f.reviewedGraph.hash, f.prompt.hash].sort());
  assert.deepEqual(await fileIdentity(f.path), {sha256: f.bundle.blob.hash.slice(7), byteLength: f.bundle.blob.byteLength});
  // A separate unmodified production spool still uses DELETE journaling after
  // actual commits. No global spool or campaign-validator policy was changed.
  const path = join(f.output, 'unchanged-product-spool.sqlite'), db = f.product.spool(path);
  try {
    db.exec('CREATE TABLE kept(value INTEGER) STRICT; INSERT INTO kept VALUES (1); INSERT INTO kept VALUES (2);');
    assert.deepEqual(inspectionPragmas(db), {journalMode: 'delete', synchronous: 2, cacheSize: -2048, tempStore: 1});
    assert.equal(db.prepare('SELECT sum(value) n FROM kept').get().n, 3);
    assert.throws(() => lstatSync(path + '-journal'), {code: 'ENOENT'});
  } finally {db.close();}
});

test('private portable inspection retains journal custody and exact protected-read or cancellation errors', async t => {
  const f = await smallCompositionArchive(t);
  const baseline = await inspectPortableArchive({repo: f.repo, path: f.path, output: f.output, product: f.product});
  for (const fault of ['read-failure', 'abort']) {
    const controller = new AbortController(), observed = persistentInspectionProduct(f.product, {fault, controller});
    await assert.rejects(inspectPortableArchive({repo: f.repo, path: f.path, output: f.output,
      product: observed.product, signal: controller.signal}), error => error === observed.injected);
    observed.retained(); assert.equal(controller.signal.aborted, fault === 'abort');
  }
  const after = await inspectPortableArchive({repo: f.repo, path: f.path, output: f.output, product: f.product});
  assert.deepEqual(after, baseline);
  assert.deepEqual(await fileIdentity(f.path), {sha256: f.bundle.blob.hash.slice(7), byteLength: f.bundle.blob.byteLength});
});

test('private inspection closes its real SQLite connection before archive entry when PERSIST is refused or its query throws', async t => {
  const repo = fileURLToPath(new URL('../../', import.meta.url)), actual = await productFor(repo);
  const output = ownTestRoot(await realpath(await mkdtemp(join(tmpdir(), 'portable-inspection-mode-'))));
  for (const mode of ['refused', 'throws']) {
    let database, closes = 0, opened = 0;
    const owners = [], sentinel = Error('PERSIST mode query failed');
    class Memory extends actual.CompositionMemory {
      constructor(...args) {super(...args); owners.push({value: this, before: this.resourceOwnership()});}
    }
    const product = {...actual, CompositionMemory: Memory,
      ZipIndex: class {constructor() {opened++; throw Error('Archive must not open before mode admission');}},
      spool(path) {
        // SQLite itself returns "memory" for PERSIST on an in-memory database.
        // The other branch uses the actual private disk spool and injects only
        // its one mode-query error to check original exception preservation.
        database = mode === 'refused' ? new DatabaseSync(':memory:') : actual.spool(path);
        return new Proxy(database, {get(target, name) {
          if (name === 'close') return () => {closes++; target.close();};
          if (name === 'prepare' && mode === 'throws') return sql => {
            if (sql === 'PRAGMA journal_mode=PERSIST') return {get() {throw sentinel;}};
            return target.prepare(sql);
          };
          const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
        }});
      },
    };
    await assert.rejects(inspectPortableArchive({repo, path: join(output, 'never-opened.zip'), output, product}),
      mode === 'throws' ? error => error === sentinel : {code: 'ERR_ASSERTION', message: /Private portable inspection spool requires PERSIST journaling/});
    assert.equal(opened, 0); assert.equal(closes, 1); assert.equal(owners.length, 1);
    assert.deepEqual(owners[0].value.resourceOwnership(), owners[0].before); assert.equal(owners[0].value.bytes, 0);
    assertInspectionClosed(database);
  }
});

async function shardPreparation() {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const output = ownTestRoot(await realpath(await mkdtemp(join(tmpdir(), 'wc-object-shards-'))));
  const product = {...await productFor(repo), ...await portableCommon.product({repo}, 'server/storage/files.js')};
  return {repo, output, root: join(output, 'store'), product};
}
const shardStamp = stat => Object.fromEntries(['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, stat[key]]));

test('WC preparation opens the real writer only after all private empty shards exist and later publication preserves their parent identity', async () => {
  const f = await shardPreparation(), shards = join(f.root, 'objects', 'sha256');
  const {Objects} = await portableCommon.product({repo: f.repo}, 'server/storage/objects.js');
  let opened = 0, before;
  const product = {...f.product, async openWriter(...args) {
    opened++;
    const names = await readdir(shards);
    assert.equal(names.length, 256);
    assert(names.every(name => /^[0-9a-f]{2}$/.test(name)));
    for (const name of names) {
      const stat = await lstat(join(shards, name));
      assert(stat.isDirectory() && !stat.isSymbolicLink());
      assert.equal(stat.mode & 0o777, 0o700); assert.equal(stat.uid, process.getuid());
      assert.deepEqual(await readdir(join(shards, name)), []);
    }
    const objects = new Objects(f.root, () => {}, () => {});
    try { assert.deepEqual(objects.inventory(new Set()), {orphanCount: '0', stagingCount: '0'}); }
    finally { objects.close(); }
    before = shardStamp(await lstat(shards, {bigint: true}));
    return f.product.openWriter(...args);
  }};
  let writer = await openPortableFixtureWriter({...f, product});
  const values = [Buffer.from('first real retained object'), Buffer.from('second independent retained object')], refs = [];
  try {
    assert.equal(opened, 1);
    for (const bytes of values) {
      const ref = await writer.putObject([bytes], {byteLength: String(bytes.length), mediaType: 'text/plain'}, writer.epoch);
      assert.equal(ref.hash, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(Buffer.from(await writer.readMetadata(ref)), bytes); refs.push(ref);
      assert.deepEqual(shardStamp(await lstat(shards, {bigint: true})), before);
    }
    assert.notEqual(refs[0].hash.slice(7, 9), refs[1].hash.slice(7, 9));
    await writer.close(); writer = undefined;
    writer = await f.product.openWriter({root: f.root});
    for (let i = 0; i < refs.length; i++) assert.deepEqual(Buffer.from(await writer.readMetadata(refs[i])), values[i]);
    assert.deepEqual(shardStamp(await lstat(shards, {bigint: true})), before);
  } finally { await writer?.close(); }
});

test('WC shard preparation refuses existing stores without rewriting retained files or opening a writer', async () => {
  const f = await shardPreparation(); await mkdir(f.root, {mode: 0o700});
  const sentinel = join(f.root, 'retained'); await writeFile(sentinel, 'keep this failed or seed store', {mode: 0o600});
  let opened = 0;
  await assert.rejects(openPortableFixtureWriter({...f, product: {...f.product, openWriter() {opened++;}}}), {code: 'EEXIST'});
  assert.equal(opened, 0); assert.deepEqual(await readdir(f.root), ['retained']);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep this failed or seed store');
});

test('WC shard preparation rejects aliased ancestry and unsafe shard collisions without repairing or following them', async () => {
  const alias = await shardPreparation(), target = join(alias.output, 'target'), link = join(alias.output, 'alias');
  await mkdir(target, {mode: 0o700}); await symlink(target, link);
  await assert.rejects(openPortableFixtureWriter({...alias, root: join(link, 'store')}), {code: 'ROOT_UNSAFE'});
  assert.deepEqual(await readdir(target), []);
  for (const kind of ['symlink', 'file', 'wrong-mode']) {
    const f = await shardPreparation(), shards = join(f.root, 'objects', 'sha256'), outside = join(f.output, 'outside');
    await mkdir(outside, {mode: 0o700}); let opened = 0;
    const product = {...f.product, openWriter() {opened++;}, privateDirectory(path) {
      f.product.privateDirectory(path);
      if (path === shards) {
        if (kind === 'symlink') symlinkSync(outside, join(shards, '00'));
        else if (kind === 'file') writeFileSync(join(shards, '00'), 'collision', {mode: 0o600});
        else mkdirSync(join(shards, '00'), {mode: 0o755});
      }
    }};
    await assert.rejects(openPortableFixtureWriter({...f, product}), {code: 'ROOT_UNSAFE'});
    assert.equal(opened, 0); assert.deepEqual(await readdir(shards), ['00']); assert.deepEqual(await readdir(outside), []);
    const stat = await lstat(join(shards, '00'));
    if (kind === 'symlink') assert(stat.isSymbolicLink());
    else if (kind === 'file') assert.equal(await readFile(join(shards, '00'), 'utf8'), 'collision');
    else assert.equal(stat.mode & 0o777, 0o755);
  }
});

test('WC shard preparation preserves exact cancellation and partial evidence before writer admission', async () => {
  for (const timing of ['before', 'during']) {
    const f = await shardPreparation(), controller = new AbortController(), reason = Error('cancel selected shard preparation');
    let opened = 0;
    const product = {...f.product, openWriter() {opened++;}, privateDirectory(path) {
      f.product.privateDirectory(path);
      if (path === join(f.root, 'objects', 'sha256', '07')) controller.abort(reason);
    }};
    if (timing === 'before') controller.abort(reason);
    await assert.rejects(openPortableFixtureWriter({...f, product, signal: controller.signal}), error => error === reason);
    assert.equal(opened, 0);
    if (timing === 'before') assert.deepEqual(await readdir(f.output), []);
    else assert.deepEqual((await readdir(join(f.root, 'objects', 'sha256'))).sort(), ['00', '01', '02', '03', '04', '05', '06', '07']);
  }
});

test('WC shard preparation drains a real writer if cancellation arrives during its opening', async () => {
  const f = await shardPreparation(), controller = new AbortController(), reason = Error('cancel opening WC writer');
  let closes = 0;
  const product = {...f.product, async openWriter(...args) {
    const writer = await f.product.openWriter(...args); controller.abort(reason);
    return {...writer, async close() {closes++; await writer.close();}};
  }};
  await assert.rejects(openPortableFixtureWriter({...f, product, signal: controller.signal}), error => error === reason);
  assert.equal(closes, 1);
  const reopened = await f.product.openWriter({root: f.root});
  await reopened.close();
  assert.equal((await readdir(join(f.root, 'objects', 'sha256'))).length, 256);
});

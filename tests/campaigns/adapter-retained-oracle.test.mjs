import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdapterRetainedOracle } from '../../tooling/qualification/campaigns/adapter-retained-oracle.mjs';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const schema = `
PRAGMA user_version=17;
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE objects(hash TEXT PRIMARY KEY,byte_length TEXT NOT NULL) STRICT;
CREATE TABLE roots(owner TEXT NOT NULL,hash TEXT NOT NULL,media_type TEXT NOT NULL,PRIMARY KEY(owner,hash)) STRICT;
CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
CREATE TABLE asset_dependencies(asset_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(asset_id,hash)) STRICT;
CREATE TABLE documents(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
CREATE TABLE history(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
CREATE TABLE checkpoints(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
CREATE TABLE commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,original TEXT NOT NULL,canonical TEXT NOT NULL,receipt TEXT NOT NULL) STRICT;
CREATE TABLE events(seq TEXT PRIMARY KEY,transaction_id TEXT NOT NULL,command_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
CREATE TABLE events_v2(seq TEXT PRIMARY KEY,transaction_id TEXT NOT NULL,command_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
`;
async function identity(path) { const bytes = await readFile(path); return { sha256: hash(bytes), byteLength: String(bytes.length) }; }
async function seal(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push({ path: relative(root, path).split(sep).join('/'), ...await identity(path) });
    }
  }
  await walk(root); return { root, files, sha256: hash(json(files)) };
}
async function object(root, bytes, mediaType = 'application/octet-stream') {
  const ref = { hash: hash(bytes), byteLength: String(bytes.length), mediaType }, path = join(root, 'objects', 'sha256', ref.hash.slice(7, 9), ref.hash.slice(7));
  await mkdir(join(root, 'objects', 'sha256', ref.hash.slice(7, 9)), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  return { ref, path };
}
function editDatabase(root, work) { const db = new DatabaseSync(join(root, 'metadata.sqlite'), { allowExtension: false }); try { work(db); } finally { db.close(); } }
function asset(id, blob, extra = {}) { return { id, version: '1', purpose: 'adapter', blob, dependencies: [], availability: 'available', qualification: 'original', ...extra }; }

// Deliberately tiny byte specimens exercise the observer's contracts. They are
// unit inputs, never WA size/performance qualification or provider eligibility.
async function setup(t, { unknownTable = false, unknownFile = false, oversizedRow = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'wa-retained-unit-'))), source = join(base, 'sealed'), root = join(base, 'working'), output = join(base, 'observations');
  const observers = []; t.after(async () => { for (const observer of observers) observer.close(); await rm(base, { recursive: true, force: true }); });
  await mkdir(source, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
  const original = await object(source, Buffer.from('UNIT_ONLY_RETAINED_WEIGHTS'));
  const corpusPath = join(base, 'unit-corpus.bin'); await writeFile(corpusPath, Buffer.from('UNIT_ONLY_SOURCE_CORPUS'), { mode: 0o600, flag: 'wx' });
  const transport = randomUUID(); await mkdir(join(source, 'backend-transport'), { mode: 0o700 });
  await writeFile(join(source, 'backend-transport', transport + '.body'), 'PRIVATE_TRANSPORT_SENTINEL', { mode: 0o600, flag: 'wx' });
  await writeFile(join(source, 'backend-transport', transport + '.json'), json({ privateNote: 'PRIVATE_SIDECAR_SENTINEL' }), { mode: 0o600, flag: 'wx' });
  const entries = Array.from({ length: 100 }, (_, index) => ({ versionId: 'unit-adapter-' + index }));
  editDatabase(source, db => {
    db.exec(schema); db.prepare('INSERT INTO meta VALUES (?,?)').run('writerEpoch', '1'); db.prepare('INSERT INTO meta VALUES (?,?)').run('highWater', '1');
    db.prepare('INSERT INTO objects VALUES (?,?)').run(original.ref.hash, original.ref.byteLength);
    db.prepare('INSERT INTO documents VALUES (?,?)').run('unit-document', JSON.stringify({ id: 'unit-document', note: 'PRIVATE_DOCUMENT_SENTINEL' }));
    for (const { versionId } of entries) {
      const value = asset(versionId, original.ref, { qualification: 'adapter-version', adapter: { id: versionId, adapterId: versionId, version: '1', weights: original.ref, config: null, sources: { weightsAssetId: null, configAssetId: null, provenanceAssetId: null } } });
      db.prepare('INSERT INTO assets VALUES (?,?)').run(versionId, JSON.stringify(value)); db.prepare('INSERT INTO roots VALUES (?,?,?)').run('asset:' + versionId, original.ref.hash, original.ref.mediaType);
    }
    if (unknownTable) { db.exec('CREATE TABLE future_retention(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT'); db.prepare('INSERT INTO future_retention VALUES (?,?)').run('future-row', '{}'); }
    if (oversizedRow) db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run('oversized', hash('oversized'), 'x'.repeat(65537), '{}', '{}');
  });
  await chmod(join(source, 'metadata.sqlite'), 0o600);
  if (unknownFile) await writeFile(join(source, 'future-retained-input.bin'), 'UNIT_UNKNOWN_ROLE', { mode: 0o600, flag: 'wx' });
  const productPath = join(base, 'product-receipt.json'); await writeFile(productPath, json({ unitFixture: true }), { mode: 0o600, flag: 'wx' });
  const manifest = { kind: 'sealed-performance-fixture', version: 'perf-8-a3-corpus-2', outcome: 'prepared', workload: 'WA', root: source, documentId: 'unit-document',
    observed: { productionValidated: true, unitFixtureOnly: true }, definition: { metadataEntries: 100 }, adapterLibrary: { entries }, store: await seal(source),
    corpus: { files: [{ id: 'unit-corpus', path: corpusPath, ...await identity(corpusPath) }] }, productReceipt: { path: productPath, ...await identity(productPath) } };
  const manifestPath = join(base, 'fixture.json'); await writeFile(manifestPath, json(manifest), { mode: 0o600, flag: 'wx' });
  const fixture = { ...manifest, manifestPath, seal: { path: manifestPath, sha256: (await identity(manifestPath)).sha256 } };
  await cp(source, root, { recursive: true, errorOnExist: true, force: false });
  const observer = await createAdapterRetainedOracle({ repo: process.cwd(), root, fixture, output }); observers.push(observer);
  return { base, source, root, output, fixture, observer, original, corpusPath };
}
function released(observer, receipt) {
  const actual = observer.readerObservation(); assert.equal(actual.ownedReadersReleased, true); assert.equal(actual.openFiles, 0); assert.equal(actual.openDatabases, 0);
  assert.equal(actual.openedFiles, actual.closedFiles); assert.equal(actual.openedDatabases, actual.closedDatabases);
  if (receipt) assert.equal(receipt.readerObservation.ownedReadersReleased, true);
}

test('full byte checkpoints preserve the sealed source, allow modeled counter growth, and release every owned reader', async t => {
  const f = await setup(t), sourceBefore = await seal(f.source), baseline = await f.observer.baseline();
  assert.equal(baseline.status, 'PASS'); assert.equal(baseline.complete, true); assert.equal(baseline.counts.adapterVersions, 100); assert.equal(baseline.counts.baselineObjects, 1);
  assert.equal(baseline.assertions.durableFixturePreserved, true); released(f.observer, baseline);
  assert.deepEqual(await seal(f.source), sourceBefore, 'SQLite inspection must not create sidecars or mutate the sealed original');
  assert(!(await readdir(f.output)).some(name => name.startsWith('.wa-retained-readonly-')), 'Transient SQL copies must be removed before returning');
  editDatabase(f.root, db => { db.prepare('UPDATE meta SET value=? WHERE key=?').run('2', 'writerEpoch'); db.prepare('UPDATE meta SET value=? WHERE key=?').run('3', 'highWater'); });
  const checkpoint = await f.observer.checkpoint(), final = await f.observer.completeSeries();
  assert.equal(checkpoint.status, 'PASS'); assert.equal(final.status, 'PASS'); assert.equal(final.closureSha256, baseline.closureSha256); released(f.observer, final);
  assert.equal(await f.observer.completeSeries(), final, 'Finalization does not substitute a different proof');
  for (const receipt of [baseline, checkpoint, final]) {
    assert.equal(receipt.span.durationMs, receipt.span.endMs - receipt.span.startMs); assert(receipt.span.durationMs >= 0); assert.equal(receipt.span.chargedObserverWork, true);
    const emitted = await readFile(receipt.artifact.path, 'utf8');
    assert.equal(hash(emitted), receipt.artifact.sha256); assert.equal(Buffer.byteLength(emitted), receipt.artifact.bytes);
    for (const secret of ['PRIVATE_DOCUMENT_SENTINEL', 'PRIVATE_TRANSPORT_SENTINEL', 'PRIVATE_SIDECAR_SENTINEL', 'UNIT_ONLY_RETAINED_WEIGHTS']) assert(!emitted.includes(secret));
  }
});

test('each checkpoint fully rehashes original object, transport, and corpus bytes', async t => {
  for (const kind of ['object', 'transport', 'corpus']) {
    await t.test(kind, async child => {
      const f = await setup(child); assert.equal((await f.observer.baseline()).status, 'PASS');
      const target = kind === 'object' ? join(f.root, relative(f.source, f.original.path)) : kind === 'corpus' ? f.corpusPath : join(f.root, 'backend-transport', (await readdir(join(f.root, 'backend-transport'))).find(name => name.endsWith('.body')));
      const bytes = await readFile(target); bytes[0] ^= 1; await writeFile(target, bytes);
      const result = await f.observer.checkpoint(); assert.equal(result.status, 'FAIL'); assert.equal(result.assertions.durableFixturePreserved, false); released(f.observer, result);
    });
  }
});

test('baseline retained metadata rows cannot be changed or removed even when object bytes remain intact', async t => {
  const f = await setup(t); assert.equal((await f.observer.baseline()).status, 'PASS');
  editDatabase(f.root, db => db.prepare('UPDATE documents SET json=? WHERE id=?').run('{"id":"unit-document","changed":true}', 'unit-document'));
  const result = await f.observer.checkpoint(); assert.equal(result.status, 'FAIL'); assert.match(result.error.message, /baseline retained metadata row/); released(f.observer, result);
});

test('new imported version and source asset bindings receive actual full byte proofs and remain immutable later', async t => {
  const f = await setup(t); assert.equal((await f.observer.baseline()).status, 'PASS');
  const weights = await object(f.root, Buffer.from('UNIT_NEW_WEIGHTS')), config = await object(f.root, Buffer.from('UNIT_NEW_CONFIG'), 'text/plain');
  const version = asset('new-version', weights.ref, { qualification: 'adapter-version', dependencies: [config.ref], adapter: { id: 'new-version', adapterId: 'new-adapter', version: '1', weights: weights.ref, config: config.ref, sources: { weightsAssetId: 'new-weights', configAssetId: 'new-config', provenanceAssetId: null } } });
  editDatabase(f.root, db => {
    for (const value of [weights, config]) db.prepare('INSERT INTO objects VALUES (?,?)').run(value.ref.hash, value.ref.byteLength);
    for (const value of [asset('new-weights', weights.ref), asset('new-config', config.ref), version]) db.prepare('INSERT INTO assets VALUES (?,?)').run(value.id, JSON.stringify(value));
  });
  assert.deepEqual(await f.observer.readImportedAsset('new-version'), version); released(f.observer);
  const observed = await f.observer.checkpoint({ importedAssetIds: ['new-version'] });
  assert.equal(observed.status, 'PASS'); assert.equal(observed.counts.importedAssets, 3); assert.equal(observed.counts.importedObjects, 2); released(f.observer, observed);
  const retained = observed.importedAssetBindings.find(value => value.id === 'new-version');
  assert.equal(retained.metadataSha256, hash(JSON.stringify(version)));
  assert.deepEqual(retained.refs, [weights.ref, config.ref].sort((left, right) => left.hash.localeCompare(right.hash)).map(ref => ({ hash: ref.hash, byteLength: ref.byteLength })));
  assert(Buffer.byteLength(JSON.stringify(observed.importedAssetBindings)) <= 65536);
  editDatabase(f.root, db => db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify({ ...asset('new-config', config.ref), availability: 'unavailable' }), 'new-config'));
  const changed = await f.observer.checkpoint(); assert.equal(changed.status, 'FAIL'); assert.match(changed.error.message, /imported asset binding changed/i); released(f.observer, changed);
});

test('unreviewed retained tables or file roles remain inconclusive rather than manufacturing complete coverage', async t => {
  for (const option of ['unknownTable', 'unknownFile']) {
    await t.test(option, async child => {
      const f = await setup(child, { [option]: true }), result = await f.observer.baseline();
      assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.complete, false); assert.equal(result.assertions.durableFixturePreserved, null); assert(result.missing.length > 0); released(f.observer, result);
    });
  }
});

test('oversized metadata and symlink substitution cannot leave readers or produce a preservation pass', async t => {
  await t.test('oversized row', async child => {
    const f = await setup(child, { oversizedRow: true }), result = await f.observer.baseline();
    assert.equal(result.status, 'INCONCLUSIVE'); assert(result.missing.some(reason => reason.includes('64 KiB'))); released(f.observer, result);
    assert(!(await readdir(f.output)).some(name => name.startsWith('.wa-retained-readonly-')));
  });
  await t.test('symlink object', async child => {
    const f = await setup(child); assert.equal((await f.observer.baseline()).status, 'PASS');
    const target = join(f.root, relative(f.source, f.original.path)); await rm(target); await symlink(f.original.path, target);
    const result = await f.observer.checkpoint(); assert.equal(result.status, 'FAIL'); released(f.observer, result);
  });
});

// Source-only additions: authored, not executed. Tiny real files and a real
// SQLite fixture verify this projection seam, never WA/H resource qualification.
async function requestCaption(f, id, value, override = {}) {
  const caption = await object(f.root, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)), 'text/plain');
  const record = asset(id, caption.ref, {purpose: 'caption', qualification: 'opaque-text', safety: 'safe', ...override});
  editDatabase(f.root, db => {
    db.prepare('INSERT INTO objects VALUES (?,?)').run(caption.ref.hash, caption.ref.byteLength);
    db.prepare('INSERT INTO assets VALUES (?,?)').run(record.id, JSON.stringify(record));
  });
  return {...caption, record};
}

test('actual caption bytes and SQLite bindings project only request prompt references for supported families', async t => {
  const f = await setup(t), sourceBefore = await seal(f.source);
  const prompt = await object(f.root, Buffer.from('PRIVATE_PROMPT_SENTINEL'), 'text/plain');
  editDatabase(f.root, db => {
    db.prepare('INSERT INTO objects VALUES (?,?)').run(prompt.ref.hash, prompt.ref.byteLength);
    db.prepare('INSERT INTO assets VALUES (?,?)').run('prompt-text', JSON.stringify(asset('prompt-text', prompt.ref, {purpose: 'text'})));
  });
  assert.equal((await f.observer.baseline()).status, 'PASS');
  const ids = [];
  for (const [kind, operation] of [['request-draft-1', 'generate-adapters'], ['request-draft-v45-1', 'generate-v45'], ['request-draft-v45-1', 'transform-v45'], ['request-draft-v45-1', 'inpaint-v45']]) {
    const assetId = 'caption-' + operation;
    const caption = await requestCaption(f, assetId, {schemaVersion: 1, kind, operation, prompt: {mode: 'plain', text: prompt.ref}, privateNote: 'PRIVATE_CAPTION_SENTINEL'});
    const before = f.observer.readerObservation();
    const reading = f.observer.readRequestDraftReferences(assetId);
    assert.equal(f.observer.readerObservation().pendingObservation, true);
    assert.throws(() => f.observer.close(), /active retained observation/);
    await assert.rejects(f.observer.readImportedAsset(assetId), /idle observer/);
    const result = await reading; released(f.observer);
    assert.equal(f.observer.readerObservation().pendingObservation, false);
    assert.deepEqual(result, {assetId, kind, schemaVersion: 1, caption: {hash: caption.ref.hash, byteLength: caption.ref.byteLength}, promptText: prompt.ref});
    assert.equal(f.observer.readerObservation().openedDatabases - before.openedDatabases, 2, 'The exact asset binding is rechecked after proving bytes');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|privateNote|operation|prompt\.text/);
    ids.push(assetId);
  }
  const checkpoint = await f.observer.checkpoint({importedAssetIds: ['prompt-text', ...ids]});
  assert.equal(checkpoint.status, 'PASS'); released(f.observer, checkpoint);
  assert.deepEqual(await seal(f.source), sourceBefore, 'The sealed original remains byte-identical');
});

test('missing, changed and symlinked request captions fail with every owned reader released', async t => {
  await t.test('missing asset', async child => {
    const f = await setup(child);
    await assert.rejects(f.observer.readRequestDraftReferences('missing-caption'), /metadata is absent/); released(f.observer);
    assert.equal(f.observer.readerObservation().pendingObservation, false);
  });
  for (const mode of ['content-drift', 'missing-object', 'symlink-object']) await t.test(mode, async child => {
    const f = await setup(child), prompt = {hash: hash('private prompt'), byteLength: '14', mediaType: 'text/plain'};
    const caption = await requestCaption(f, 'changed-caption', {schemaVersion: 1, kind: 'request-draft-1', operation: 'generate', prompt: {text: prompt}});
    if (mode === 'content-drift') await writeFile(caption.path, Buffer.alloc(Number(caption.ref.byteLength), 0x20));
    else {
      await rm(caption.path);
      if (mode === 'symlink-object') await symlink(f.original.path, caption.path);
    }
    await assert.rejects(f.observer.readRequestDraftReferences('changed-caption'), mode === 'content-drift' ? /content differs from its exact sealed identity/ : undefined);
    released(f.observer); assert.equal(f.observer.readerObservation().pendingObservation, false);
  });
});

test('oversize, malformed and unrelated caption families cannot manufacture request references', async t => {
  const ref = {hash: hash('private prompt'), byteLength: '14', mediaType: 'text/plain'};
  const cases = [
    ['oversize', Buffer.from(' '.repeat(65537)), /64 KiB projection bound/],
    ['invalid-json', Buffer.from('{"PRIVATE_CAPTION_SENTINEL"'), /bounded UTF-8 JSON/],
    ['invalid-utf8', Buffer.from([0xff, 0xfe]), /bounded UTF-8 JSON/],
    ['unrelated-kind', {schemaVersion: 1, kind: 'text-draft-1', operation: 'generate', prompt: {text: ref}}, /recognized request draft family/],
    ['unsupported-version', {schemaVersion: 2, kind: 'request-draft-1', operation: 'generate', prompt: {text: ref}}, /recognized request draft family/],
    ['wrong-family-operation', {schemaVersion: 1, kind: 'request-draft-v45-1', operation: 'generate', prompt: {text: ref}}, /recognized request draft family/],
    ['raw-prompt', {schemaVersion: 1, kind: 'request-draft-1', operation: 'generate', prompt: {text: 'PRIVATE_PROMPT_SENTINEL'}}, /prompt reference is malformed/],
    ['wrong-media', {schemaVersion: 1, kind: 'request-draft-1', operation: 'generate', prompt: {text: {...ref, mediaType: 'application/json'}}}, /prompt reference is malformed/],
  ];
  for (const [name, value, message] of cases) await t.test(name, async child => {
    const f = await setup(child); await requestCaption(f, 'invalid-caption', value);
    await assert.rejects(f.observer.readRequestDraftReferences('invalid-caption'), message);
    released(f.observer); assert.equal(f.observer.readerObservation().pendingObservation, false);
    const emitted = await readdir(f.output); assert.deepEqual(emitted, [], 'Failed projections never emit caption bodies or partial proof receipts');
  });
});

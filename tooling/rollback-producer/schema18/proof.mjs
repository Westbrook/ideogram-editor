/** Source-only capture program. Run only on a newly created qualification
 * fixture or its independently restored copy, with the preserved no-network
 * preload. This never converts or lowers the header of an existing root. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, readdir, mkdir, writeFile, realpath, chmod} from 'node:fs/promises';
import {join, resolve, sep, dirname, basename, isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createLinuxNativeLibraryPolicy} from './proof-library-policy.mjs';

assert.equal(process.argv.slice(2).length, 6, 'The Linux proof requires a host path and sealed host hash');
const [mode, product, root, output, linuxHostPath, linuxHostSha256] = process.argv.slice(2);
assert(['seed', 'check'].includes(mode));
assert([product, root, output].every(value => typeof value === 'string' && isAbsolute(value)));
assert.equal(process.versions.node, '26.10.0');
assert(globalThis.__storeNetworkCounters, 'The preserved no-network preload is required');
const nativeLibraryPolicy = await createLinuxNativeLibraryPolicy({product, executable: process.execPath,
  linuxHostPath, linuxHostSha256, platform: process.platform, arch: process.arch});
const expectedCapabilityHash = 'sha256:c2eb7167875862e82da5f86dc52238001c09852a25c62d2f1bf9be9a2c3f0752';
const expectedCapabilityManifest = {
  kind: 'editor-capability-manifest-1', storageVersion: 18, projectionSchema: 9, assetProjectionSchema: 3,
  completePortableFormat: 10, recoveryPortableFormat: 11,
  capabilities: ['document-creation-v1', 'encoded-adoption-v1', 'local-queue-order-edit-v1',
    'oversized-import-derivation-v1', 'request-family-v45-v1', 'request-text-treatment-v1',
    'returned-description-text-v1', 'sanitized-recovery-copy-v1'],
};
const load = path => import(pathToFileURL(join(product, 'dist/local', path)));
const require = createRequire(pathToFileURL(join(product, 'package.json'))), resolvedDependencies = {};
const loadedNativeLibraries = new Set();
async function nativeLibraries() {
  for (const path of process.report.getReport().sharedObjects) {
    assert(path.startsWith('/'), 'Native library path must be absolute');
    await nativeLibraryPolicy.assertLibrary(path);
    loadedNativeLibraries.add(path);
  }
}
for (const name of ['sharp', 'fs-ext', 'canvaskit-wasm', 'canvaskit-wasm/bin/canvaskit.wasm']) {
  const path = await realpath(require.resolve(name));
  assert(path.startsWith(await realpath(product) + sep)); resolvedDependencies[name] = path;
}
const {openWriter} = await load('server/storage/writer.js');
const {StoreDatabase} = await load('server/storage/database.js');
const {canonical} = await load('server/storage/canonical.js');
const {newV45Draft} = await load('src/request/family.js');
const {assertEditorSchema18Receipt, assertEditorSchema18Ready,
  EDITOR_SCHEMA18_CAPABILITY_HASH, EDITOR_SCHEMA18_CAPABILITY_MANIFEST,
  EDITOR_SCHEMA18_CAPABILITY_SEAL} = await load('server/storage/schema.js');
assert.equal(EDITOR_SCHEMA18_CAPABILITY_HASH, expectedCapabilityHash);
assert.equal(EDITOR_SCHEMA18_CAPABILITY_SEAL, expectedCapabilityHash);
assert.deepEqual(EDITOR_SCHEMA18_CAPABILITY_MANIFEST, expectedCapabilityManifest);
assertEditorSchema18Ready();
const {verifyCodecs} = await load('server/raster/engine.js');
verifyCodecs();
await load('server/text/validation.js');
for (const [file, name] of [['bounded-webp', 'openBoundedWebP'], ['webp-output', 'openWebPOutputBridge'], ['webp-color', 'openWebPColorConverter']]) {
  const loaded = await load('server/raster/' + file + '.js');
  const bridge = await loaded[name](); assert(bridge, 'Required native ABI failed: ' + name);
  try { await nativeLibraries(); } finally { bridge.close(); }
}
const nativeText = new Worker(pathToFileURL(join(product, 'dist/local/server/text/render-worker.mjs')), {
  env: {}, workerData: {testing: {effectCounters: globalThis.__storeNetworkCounters.shared}},
});
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Native text initialization timeout')), 20000);
    const finish = error => { clearTimeout(timeout); error ? reject(error) : resolve(); };
    nativeText.once('error', finish);
    nativeText.once('exit', code => finish(Error('Native text exited before ready: ' + code)));
    nativeText.once('message', message => finish(message?.type === 'ready' ? null : Error('Native text initialization failed')));
  });
} finally { await nativeText.terminate(); }
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(Buffer.from(canonical(expectedCapabilityManifest))), expectedCapabilityHash);
const effects = () => globalThis.__storeNetworkCounters.read();
const zero = () => assert(Object.values(effects()).every(value => value === 0), JSON.stringify(effects()));
const database = () => {
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), {readOnly: true, allowExtension: false});
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 18);
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=18').get();
    assert(row, 'The genuine schema18 migration receipt is required');
    const receipt = JSON.parse(row.receipt); assertEditorSchema18Receipt(receipt);
    assert.deepEqual(receipt.capabilityManifest, expectedCapabilityManifest);
    assert.equal(receipt.capabilityHash, expectedCapabilityHash);
    const tables = {};
    for (const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      assert(/^[a-zA-Z0-9_]+$/.test(name));
      const rows = db.prepare(`SELECT * FROM "${name}"`).all()
        .filter(row => name !== 'meta' || row.key !== 'writerEpoch')
        .map(row => canonical(row)).sort();
      tables[name] = {rows: rows.length, hash: hash(Buffer.from(rows.join('\n')))};
    }
    return {tables, receipt};
  } finally { db.close(); }
};
async function objects() {
  const result = [];
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, name + '/');
      else { assert(entry.isFile()); const bytes = await readFile(path); result.push({path: name, byteLength: String(bytes.length), hash: hash(bytes)}); }
    }
  }
  await visit(join(root, 'objects')); return result;
}
const auth = () => ({clientId: 'rollback_client', sessionHash: 'a'.repeat(64), now: Date.now(), expires: Date.now() + 3600000});
const draftText = 'Schema18 retained V45 request — Café 東京';
if (mode === 'seed') {
  await mkdir(root, {mode: 0o700});
  const writer = await openWriter({root}, {effectCounters: globalThis.__storeNetworkCounters.shared});
  try {
    const bytes = Buffer.from('{"entities":[],"schemaVersion":1}');
    const expected = await writer.putObject([bytes], {hash: hash(bytes), byteLength: String(bytes.length), mediaType: 'application/json'}, writer.epoch);
    const command = (body, revision, documentId = 'rollback_document') => ({protocolVersion: 1, command: {
      schemaVersion: 1, commandId: randomUUID(), clientId: 'rollback_client', sessionId: 'rollback_session',
      correlationId: 'rollback_correlation', causationId: null, transactionId: randomUUID(), documentId,
      expectedDocumentRevision: revision, expectedEntityVersions: expected, issuedAt: '2026-09-30T00:00:00.000Z', body,
    }});
    for (const item of [command({type: 'NewDocument', width: 1200, height: 800, color: 'sRGB', depth: 8}, null),
      command({type: 'SaveCheckpoint', name: 'Schema 18 rollback — retained bytes'}, '1')]) {
      const receipt = await writer.submit(Buffer.from(JSON.stringify(item)), writer.epoch); assert.equal(receipt.status, 'accepted');
    }
    async function caption(bytes) {
      const stagingId = randomUUID(), digest = hash(bytes), authority = auth();
      await writer.assetCreate({protocolVersion: 1, stagingId, purpose: 'caption', expectedBytes: String(bytes.length), sha256: digest, mediaType: 'text/plain'}, authority);
      const token = await writer.assetBeginChunk(stagingId, '0', bytes.length, authority);
      await writer.assetChunk(token, bytes, authority);
      const request = command({type: 'FinalizeStaging', stagingId, expectedSha256: digest}, null, null);
      await writer.assetCommand(Buffer.from(JSON.stringify(request)), authority);
      for (let attempt = 0; attempt < 2000; attempt++) {
        const result = await writer.lookup(request.command.commandId);
        if (result) {
          assert.equal(result.receipt.status, 'accepted', JSON.stringify(result.receipt));
          const events = await writer.events(String(BigInt(result.receipt.fromSeq) - 1n), 1);
          const asset = events.events[0]?.payload.asset;
          assert(asset && asset.qualification === 'opaque-text' && asset.safety === 'safe');
          assert.equal(asset.blob.hash, digest); return asset;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw Error('Qualification draft asset did not reach a durable receipt');
    }
    const prompt = await caption(Buffer.from(draftText));
    const draft = newV45Draft(prompt.blob);
    assert.equal(draft.kind, 'request-draft-v45-1');
    const saved = await caption(Buffer.from(canonical(draft)));
    const receipt = await writer.uiPersist(Buffer.from(JSON.stringify({protocolVersion: 1, requestId: randomUUID(),
      sessionId: 'rollback_ui', expectedUISeq: '0', body: {type: 'SaveDraft', draft: {
        id: 'rollback_draft', generation: '1', kind: 'request', documentId: 'rollback_document', targetLayerId: null,
        expectedDocumentRevision: '2', assetId: saved.id, composing: false,
      }}})), auth());
    assert.equal(receipt.status, 'accepted'); zero();
  } finally { await writer.close(); }
}
const before = {tables: database().tables, objects: await objects()};
const writer = await openWriter({root}, {effectCounters: globalThis.__storeNetworkCounters.shared});
let document, events, projectionDigest, ui, draft;
try {
  await assert.rejects(openWriter({root}, {effectCounters: globalThis.__storeNetworkCounters.shared}), error => error.code === 'ROOT_BUSY');
  await nativeLibraries();
  document = await writer.document('rollback_document'); events = await writer.events();
  const diagnostics = await writer.readDiagnostics();
  try { projectionDigest = diagnostics.value.projectionDigest; } finally { diagnostics.release(); }
  assert(document && document.checkpoint && document.revision === '2');
  assert.equal(events.events.length, 4); assert.equal(events.highWater, '4');
  assert.equal(events.events.filter(event => event.documentId === 'rollback_document').length, 2);
  ui = await writer.uiRead('rollback_ui', auth());
  assert.equal(ui.uiSeq, '1'); assert.equal(ui.drafts.length, 1);
  const saved = ui.drafts[0]; assert.equal(saved.id, 'rollback_draft'); assert.equal(saved.status, 'saved-unapplied');
  const retainedAsset = events.events.map(event => event.payload.asset).find(asset => asset?.id === saved.assetId);
  assert(retainedAsset); draft = JSON.parse(Buffer.from(await writer.readMetadata(retainedAsset.blob)).toString('utf8'));
  assert.equal(draft.kind, 'request-draft-v45-1'); assert.equal(draft.prompt.mode, 'plain');
  const text = Buffer.from(await writer.readMetadata(draft.prompt.text));
  assert.equal(text.toString('utf8'), draftText); assert.equal(hash(text), draft.prompt.text.hash);
  zero();
} finally { await writer.close(); }
const retained = database(), after = {tables: retained.tables, objects: await objects()};
assert.deepEqual(after, before, 'Opening the existing schema18 root changed retained facts or objects');

// This is deliberately not a modified copy of the schema18 fixture. Its only
// purpose is to prove future-header refusal before source bytes, names or epoch
// can change. A pre-existing empty lock tests the public writer path too.
const futureRoot = join(dirname(root), basename(root) + '-future19-' + randomUUID());
await mkdir(futureRoot, {mode: 0o700});
const futurePath = join(futureRoot, 'metadata.sqlite');
const future = new DatabaseSync(futurePath, {allowExtension: false});
try { future.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;INSERT INTO meta VALUES('writerEpoch','73');PRAGMA user_version=19"); }
finally { future.close(); }
await chmod(futurePath, 0o600);
await writeFile(join(futureRoot, 'writer.lock'), '', {flag: 'wx', mode: 0o600});
const futureBytes = await readFile(futurePath), futureNames = (await readdir(futureRoot)).sort();
assert.throws(() => new StoreDatabase(futureRoot, () => {}), {code: 'UNSUPPORTED_STORAGE'});
await assert.rejects(openWriter({root: futureRoot}, {effectCounters: globalThis.__storeNetworkCounters.shared}), {code: 'UNSUPPORTED_STORAGE'});
assert.deepEqual(await readFile(futurePath), futureBytes);
assert.deepEqual((await readdir(futureRoot)).sort(), futureNames);
assert.equal((await readFile(join(futureRoot, 'writer.lock'))).length, 0);
const futureReader = new DatabaseSync(futurePath, {readOnly: true, allowExtension: false});
try {
  assert.equal(futureReader.prepare('PRAGMA user_version').get().user_version, 19);
  assert.equal(futureReader.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get().value, '73');
} finally { futureReader.close(); }
zero();
const observation = {kind: 'schema18-executable-observation-1', storageVersion: 18, mode, product: resolve(product), root: resolve(root),
  node: process.versions.node, platform: process.platform, arch: process.arch, modules: process.versions.modules,
  capabilityHash: expectedCapabilityHash, capabilityManifest: expectedCapabilityManifest, schema18Receipt: retained.receipt,
  openExistingSchema18: true, refuseFutureSchema19: true, replayByteIdentity: true, networkEffects: 0, effects: effects(),
  retained: after, document, events, projectionDigest, ui, draft, codecVerification: true, nativeTextProfilesLoaded: true,
  nativeFFIInitialized: true, nativeTextEngineInitialized: true, rootLockExclusion: true,
  futureSchema19: {root: futureRoot, syntheticFixture: true, constructorRefused: true, writerRefused: true,
    sourceUnchanged: true, namespaceUnchanged: true, writerEpoch: '73', metadataHash: hash(futureBytes), names: futureNames},
  resolvedDependencies, loadedNativeLibraries: [...loadedNativeLibraries].sort(), linuxHost: nativeLibraryPolicy.hostIdentity};
await writeFile(output, JSON.stringify(observation, null, 2) + '\n', {flag: 'wx', mode: 0o600});

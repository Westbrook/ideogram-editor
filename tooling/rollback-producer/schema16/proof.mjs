/** Runs only against a newly created qualification fixture or its fresh copy. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, readdir, mkdir, writeFile, realpath, lstat, chmod, cp} from 'node:fs/promises';
import {join, resolve, sep, dirname, basename, isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createLinuxNativeLibraryPolicy} from './proof-library-policy.mjs';

assert.equal(process.argv.slice(2).length, 6, 'The Linux proof requires a host path and sealed host hash');
const [mode, product, root, output, linuxHostPath, linuxHostSha256] = process.argv.slice(2);
assert(['seed', 'check'].includes(mode));
assert([product, root, output].every(isAbsolute));
const maintenanceContract = 'schema16-linux-raster-maintenance-1';
const historicalBase = '5650326b623d4aa2080772307708aa9f1854aa52';
assert.equal(process.versions.node, '26.10.0');
assert(globalThis.__storeNetworkCounters, 'The preserved no-network preload is required');
const nativeLibraryPolicy = await createLinuxNativeLibraryPolicy({product, executable: process.execPath,
  linuxHostPath, linuxHostSha256, platform: process.platform, arch: process.arch});
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
  const path = await realpath(require.resolve(name)); assert(path.startsWith(await realpath(product) + sep)); resolvedDependencies[name] = path;
}
const {openWriter} = await import(pathToFileURL(join(product, 'dist/local/server/storage/writer.js')));
const {canonical} = await import(pathToFileURL(join(product, 'dist/local/server/storage/canonical.js')));
const {verifyCodecs, runRaster, PIPELINE} = await import(pathToFileURL(join(product, 'dist/local/server/raster/engine.js')));
const {CODECS, CODEC_ID} = await import(pathToFileURL(join(product, 'dist/local/server/raster/codec-platform.js')));
assert.equal(CODECS.platform, 'linux'); assert.equal(CODECS.arch, process.arch);
assert.equal(PIPELINE, 'cp1-f64-triangle-area-v1/' + CODEC_ID);
verifyCodecs();
await import(pathToFileURL(join(product, 'dist/local/server/text/validation.js')));
const nativeText = new Worker(pathToFileURL(join(product, 'dist/local/server/text/render-worker.mjs')), {env: {}, workerData: {testing: {effectCounters: globalThis.__storeNetworkCounters.shared}}});
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Native text initialization timeout')), 20000);
    const finish = (error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
    nativeText.once('error', finish); nativeText.once('exit', code => finish(Error('Native text exited before ready: ' + code)));
    nativeText.once('message', message => finish(message?.type === 'ready' ? null : Error('Native text initialization failed')));
  });
} finally { await nativeText.terminate(); }
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const effects = () => globalThis.__storeNetworkCounters.read();
const zero = () => assert(Object.values(effects()).every(value => value === 0), JSON.stringify(effects()));

// These encoded fixtures and literal CP1 expectations are frozen in 5650326.
// No production raster function calculates the expected values.
const fixtureParent = await realpath(dirname(root));
const rasterDirectory = join(fixtureParent, basename(root) + '-native16-' + randomUUID());
await mkdir(rasterDirectory, {mode: 0o700});
const pixelCases = [];
const admit = async plan => {
  assert(plan.width === 1 && plan.height === 1 && plan.rawBytes === 4);
  assert(plan.cpuBytes > 0 && plan.cpuBytes <= 512 * 1024 ** 2);
};
async function rasterResult(id, job, expected, kind) {
  const directory = join(rasterDirectory, id); await mkdir(directory, {mode: 0o700});
  const value = await runRaster({...job, directory}, admit, zero);
  const pixels = await readFile(join(directory, 'pixels.rgba'));
  assert.deepEqual([...pixels], expected, 'Independent literal pixel oracle: ' + id);
  assert.equal(value.info.pipeline, PIPELINE); assert.equal(value.manifest.plan.kind, kind);
  assert.equal(value.info.pixels.hash, hash(pixels)); assert.equal(value.info.pixels.byteLength, '4');
  assert.equal(value.info.width, 1); assert.equal(value.info.height, 1);
  const encoded = await readFile(join(directory, 'output.png'));
  assert.equal(value.png.hash, hash(encoded)); assert.equal(value.png.byteLength, String(encoded.length));
  pixelCases.push({id, expectedRGBA: expected, pixels: value.info.pixels, png: value.png, pixelIdentity: value.info.pixelIdentity});
  return {id, info: value.info, path: join(directory, 'pixels.rgba')};
}
async function decodeFixture(id, hex, expectedHash, expected) {
  const bytes = Buffer.from(hex, 'hex'); assert.equal(bytes.length, 70); assert.equal(hash(bytes), expectedHash);
  const path = join(rasterDirectory, id + '.png'); await writeFile(path, bytes, {flag: 'wx', mode: 0o600});
  const result = await rasterResult(id, {type: 'decode', path, mediaType: 'image/png', sourceAssetId: id,
    original: {hash: expectedHash, byteLength: '70', mediaType: 'image/png'}}, expected, 'decoded-native');
  assert.equal(result.info.role, 'native'); assert.equal(result.info.conversion.resized, false);
  assert.equal(result.info.conversion.orientation, 1); assert.equal(result.info.conversion.profile, 'untagged-srgb');
  return result;
}
const white = await decodeFixture('white', '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082',
  'sha256:d5a51b6aed15684ec8c123e30fe5703155359d6543b6d7b47cb5766ef44939de', [255,255,255,255]);
const black = await decodeFixture('black', '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060f80f00010401005fe5c34b0000000049454e44ae426082',
  'sha256:abc58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f', [0,0,0,255]);
const layer = (input, opacity) => ({assetId: input.id, transform: [1,0,0,1,0,0], opacity, mask: null});
const compose = (id, inputs, layers, expected) => rasterResult(id,
  {type: 'compose', width: 1, height: 1, inputs, layers, dependencies: inputs.map(input => input.info.manifest)}, expected, 'cp1-composition');
await compose('stage2-alpha26', [white], [layer(white, .1)], [255,255,255,26]);
const gray = await compose('shared-gray90', [black,white], [layer(black,1),layer(white,.1)], [90,90,90,255]);
await compose('unflattened-gray108', [black,white], [layer(black,1),layer(white,.1),layer(white,14/255)], [108,108,108,255]);
await compose('flattened-gray109', [gray,white], [layer(gray,1),layer(white,14/255)], [109,109,109,255]);
await nativeLibraries(); zero();

const database = () => {
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), {readOnly: true, allowExtension: false});
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16);
    const tables = {};
    for (const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      assert(/^[a-zA-Z0-9_]+$/.test(name));
      const rows = db.prepare(`SELECT * FROM "${name}"`).all()
        .filter(row => name !== 'meta' || row.key !== 'writerEpoch')
        .map(row => canonical(row)).sort();
      tables[name] = {rows: rows.length, hash: hash(Buffer.from(rows.join('\n')))};
    }
    return tables;
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
  await visit(join(root, 'objects'));
  return result;
}
if (mode === 'seed') {
  await mkdir(root, {mode: 0o700});
  const writer = await openWriter({root}, {effectCounters: globalThis.__storeNetworkCounters.shared});
  try {
    const bytes = Buffer.from('{"entities":[],"schemaVersion":1}');
    const expected = await writer.putObject([bytes], {hash: hash(bytes), byteLength: String(bytes.length), mediaType: 'application/json'}, writer.epoch);
    const command = (body, revision) => ({protocolVersion: 1, command: {schemaVersion: 1, commandId: randomUUID(), clientId: 'rollback_client', sessionId: 'rollback_session',
      correlationId: 'rollback_correlation', causationId: null, transactionId: randomUUID(), documentId: 'rollback_document', expectedDocumentRevision: revision,
      expectedEntityVersions: expected, issuedAt: '2026-09-30T00:00:00.000Z', body}});
    for (const item of [command({type: 'NewDocument', width: 1200, height: 800, color: 'sRGB', depth: 8}, null), command({type: 'SaveCheckpoint', name: 'Schema 16 Linux maintenance — retained bytes'}, '1')]) {
      const receipt = await writer.submit(Buffer.from(JSON.stringify(item)), writer.epoch); assert.equal(receipt.status, 'accepted');
    }
    zero();
  } finally { await writer.close(); }
}
const before = {tables: database(), objects: await objects()};
const writer = await openWriter({root}, {effectCounters: globalThis.__storeNetworkCounters.shared});
let document, events, projectionDigest;
try {
  await assert.rejects(openWriter({root}, {effectCounters: globalThis.__storeNetworkCounters.shared}), error => error.code === 'ROOT_BUSY');
  await nativeLibraries();
  document = await writer.document('rollback_document');
  events = await writer.events();
  projectionDigest = (await writer.diagnostics()).projectionDigest;
  assert(document && document.checkpoint && events.events.length === 2 && events.highWater === '2');
  zero();
} finally { await writer.close(); }
const after = {tables: database(), objects: await objects()};
assert.deepEqual(after, before, 'Opening the existing schema16 root changed retained facts or objects');
zero();

// Copy only this closed, privately owned small fixture. Change only the copy's
// header; compare all copied contents and names before and after both refusal
// paths, including writerEpoch. This is not an OS no-activity claim.
async function contents(directory) {
  const rows = []; let total = 0;
  async function visit(path, relative = '', depth = 0) {
    assert(depth <= 32 && rows.length < 8192);
    const value = await lstat(path); assert(!value.isSymbolicLink());
    assert.equal(value.uid, process.getuid()); assert.equal(value.mode & 0o077, 0);
    if (value.isDirectory()) {
      rows.push({path: relative, directory: true, mode: value.mode & 0o777});
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), relative ? relative + '/' + entry : entry, depth + 1);
    } else {
      assert(value.isFile() && value.nlink === 1 && value.size <= 16 * 1024 ** 2);
      total += value.size; assert(total <= 64 * 1024 ** 2);
      const bytes = await readFile(path); assert.equal(bytes.length, value.size);
      rows.push({path: relative, mode: value.mode & 0o777, byteLength: String(bytes.length), hash: hash(bytes)});
    }
  }
  await visit(directory); return rows;
}
const sourceContents = await contents(root);
const futureRoot = join(fixtureParent, basename(root) + '-future17-' + randomUUID());
await cp(root, futureRoot, {recursive: true, force: false, errorOnExist: true, dereference: false});
assert.deepEqual(await contents(futureRoot), sourceContents, 'Future fixture copy changed original bytes or modes');
const futurePath = join(futureRoot, 'metadata.sqlite');
const future = new DatabaseSync(futurePath, {allowExtension: false}); let futureEpoch;
try {
  future.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA user_version=17');
  futureEpoch = future.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get().value;
} finally { future.close(); }
await chmod(futurePath, 0o600);
const futureBefore = await contents(futureRoot);
const {StoreDatabase} = await import(pathToFileURL(join(product, 'dist/local/server/storage/database.js')));
assert.throws(() => new StoreDatabase(futureRoot, () => {}), {code: 'UNSUPPORTED_STORAGE'});
await assert.rejects(openWriter({root: futureRoot}, {effectCounters: globalThis.__storeNetworkCounters.shared}), {code: 'UNSUPPORTED_STORAGE'});
assert.deepEqual(await contents(futureRoot), futureBefore, 'Future17 refusal mutated contents, modes or namespace');
const futureReader = new DatabaseSync(futurePath, {readOnly: true, allowExtension: false});
try {
  assert.equal(futureReader.prepare('PRAGMA user_version').get().user_version, 17);
  assert.equal(futureReader.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get().value, futureEpoch);
} finally { futureReader.close(); }
assert.deepEqual(await contents(root), sourceContents, 'Future17 probe modified the original schema16 root');
zero();
const observation = {kind: 'schema16-linux-maintenance-observation-1', storageVersion: 16, maintenanceContract, historicalBase,
  mode, product: resolve(product), root: resolve(root),
  node: process.versions.node, platform: process.platform, arch: process.arch, modules: process.versions.modules,
  openExistingSchema16: true, futureSchemaRefusal: true, replayByteIdentity: true, networkEffects: 0, effects: effects(),
  retained: after, document, events, projectionDigest, codecVerification: true, nativeTextProfilesLoaded: true,
  nativeRasterInitialized: true, independentPixelGoldens: true, nativeTextEngineInitialized: true, rootLockExclusion: true,
  nativeRaster: {codecId: CODEC_ID, pipeline: PIPELINE, cases: pixelCases},
  futureSchema17: {root: futureRoot, copiedFixture: true, constructorRefused: true, writerRefused: true,
    contentUnchanged: true, namespaceUnchanged: true, originalSchema16Unchanged: true, writerEpoch: futureEpoch,
    inventoryHash: hash(Buffer.from(canonical(futureBefore)))},
  resolvedDependencies, loadedNativeLibraries: [...loadedNativeLibraries].sort(), linuxHost: nativeLibraryPolicy.hostIdentity};
await writeFile(output, JSON.stringify(observation, null, 2) + '\n', {flag: 'wx', mode: 0o600});

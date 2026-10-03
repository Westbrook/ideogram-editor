/** Runs only against a newly created qualification fixture or its fresh copy. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, readdir, mkdir, writeFile, realpath} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createLinuxNativeLibraryPolicy} from './proof-library-policy.mjs';

assert.equal(process.argv.slice(2).length, 6, 'The Linux proof requires a host path and sealed host hash');
const [mode, product, root, output, linuxHostPath, linuxHostSha256] = process.argv.slice(2);
assert(['seed', 'check'].includes(mode));
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
const {verifyCodecs} = await import(pathToFileURL(join(product, 'dist/local/server/raster/engine.js')));
verifyCodecs();
await import(pathToFileURL(join(product, 'dist/local/server/text/validation.js')));
for (const [file, name] of [['bounded-webp', 'openBoundedWebP'], ['webp-output', 'openWebPOutputBridge'], ['webp-color', 'openWebPColorConverter']]) {
  const loaded = await import(pathToFileURL(join(product, 'dist/local/server/raster/' + file + '.js')));
  const bridge = await loaded[name](); assert(bridge, 'Required native ABI failed: ' + name);
  try { await nativeLibraries(); } finally { bridge.close(); }
}
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
const database = () => {
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), {readOnly: true, allowExtension: false});
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17);
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
    for (const item of [command({type: 'NewDocument', width: 1200, height: 800, color: 'sRGB', depth: 8}, null), command({type: 'SaveCheckpoint', name: 'Schema 17 rollback — retained bytes'}, '1')]) {
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
assert.deepEqual(after, before, 'Opening the existing schema17 root changed retained facts or objects');
zero();
const observation = {kind: 'schema17-executable-observation-1', storageVersion: 17, mode, product: resolve(product), root: resolve(root),
  node: process.versions.node, platform: process.platform, arch: process.arch, modules: process.versions.modules,
  openExistingSchema17: true, replayByteIdentity: true, networkEffects: 0, effects: effects(),
  retained: after, document, events, projectionDigest, codecVerification: true, nativeTextProfilesLoaded: true,
  nativeFFIInitialized: true, nativeTextEngineInitialized: true, rootLockExclusion: true,
  resolvedDependencies, loadedNativeLibraries: [...loadedNativeLibraries].sort(), linuxHost: nativeLibraryPolicy.hostIdentity};
await writeFile(output, JSON.stringify(observation, null, 2) + '\n', {flag: 'wx', mode: 0o600});

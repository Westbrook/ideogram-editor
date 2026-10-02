import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, unlinkSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { rootFor } from '../store/helpers.mjs';
import { Objects, IO_CHUNK } from '../../dist/local/server/storage/objects.js';
import { Assets } from '../../dist/local/server/storage/assets.js';
import { CompositionMemory } from '../../dist/local/server/storage/composition-memory.js';
import { StorageLibraryMemory, STORAGE_REGISTRY_BYTES, STORAGE_OPERATION_BYTES } from '../../dist/local/server/storage/library-memory.js';
import { StorageRepairs } from '../../dist/local/server/storage/storage-repair.js';
import { repairOwnership } from '../../dist/local/server/storage/repair-ownership.js';
import { canonical } from '../../dist/local/server/storage/canonical.js';
import { storageRepairRequest, storageRepairReview, storageRepairResult } from '../../dist/local/src/protocol/storage-repair.js';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { bytes = Buffer.from('original immutable bytes'), dependency = false, condition = 'missing', mediaType } = {}) {
  const root = await rootFor(t), db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE objects(hash TEXT PRIMARY KEY,byte_length TEXT);
    CREATE TABLE roots(owner TEXT,hash TEXT,media_type TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE staged_assets(id TEXT PRIMARY KEY,json TEXT,created_at TEXT,filename TEXT);
    CREATE TABLE asset_preparations(id TEXT,staging_id TEXT);
    CREATE TABLE portable_review_sources(staging_id TEXT);
    CREATE TABLE portable_preparations(id TEXT,frozen TEXT);
    CREATE TABLE commands(id TEXT PRIMARY KEY,hash TEXT,receipt TEXT,canonical TEXT);
    CREATE TABLE events_v2(command_id TEXT,json TEXT);
    CREATE TABLE documents(id TEXT,json TEXT); CREATE TABLE history(id TEXT,json TEXT);
    CREATE TABLE candidate_document_tombstones(document_id TEXT,generation TEXT);
    CREATE TABLE candidates(id TEXT,document_id TEXT,json TEXT);
    CREATE TABLE portable_namespaces(id TEXT,document_id TEXT,source TEXT);
    CREATE TABLE portable_rows(namespace TEXT,kind TEXT,id TEXT,json TEXT);
    CREATE TABLE ui_checkpoints(client_id TEXT,session_id TEXT,json TEXT);`);
  const auth = { clientId: 'client_1', sessionHash: 'a'.repeat(64), expires: Date.now() + 3600000, now: Date.now() };
  let fenced = false, authorized = true, readers = false, barrier = () => {}, epoch = '1';
  const check = () => { if (fenced) throw Error('STALE_EPOCH'); };
  const objects = new Objects(root, check, phase => barrier(phase));
  const assets = new Assets(db, objects, root, epoch, check, () => {}, () => assert.fail('No asset command'), () => assert.fail('No new asset/root registration'));
  const ref = { hash: sha(bytes), byteLength: String(bytes.length), mediaType: mediaType ?? (dependency ? 'application/x-ideogram-rgba8' : 'text/plain') };
  const id = objects.begin(ref.byteLength, ref.mediaType, ref.hash);
  try { for (let at = 0; at < bytes.length; at += IO_CHUNK) objects.chunk(id, bytes.subarray(at, at + IO_CHUNK)); objects.finish(id); } finally { objects.abort(id); }
  db.prepare('INSERT INTO objects VALUES (?,?)').run(ref.hash, ref.byteLength);
  db.prepare('INSERT INTO roots VALUES (?,?,?)').run('asset:retained_asset', ref.hash, ref.mediaType);
  const primary = dependency ? { hash: sha(Buffer.from('{}')), byteLength: '2', mediaType: 'application/json' } : ref;
  const asset = { id: 'retained_asset', version: '7', purpose: 'caption', blob: primary, dependencies: dependency ? [ref] : [], safety: 'safe', availability: 'available', qualification: 'opaque-text', measuredMediaType: 'text/plain' };
  db.prepare('INSERT INTO assets VALUES (?,?)').run(asset.id, canonical(asset));
  db.prepare('INSERT INTO documents VALUES (?,?)').run('document_1', '{"revision":"4","historyHead":"accepted_history"}');
  db.prepare('INSERT INTO history VALUES (?,?)').run('accepted_history', '{"assetId":"retained_asset","version":"7"}');
  if (condition === 'missing') unlinkSync(objects.path(ref));
  if (condition === 'corrupt') writeFileSync(objects.path(ref), Buffer.alloc(bytes.length, 120));
  const refreshed = [], mirror = new CompositionMemory(() => mirror.bytes, () => 0), memory = new StorageLibraryMemory(mirror), registryId = randomUUID(), loans = new Set();
  mirror.resize(registryId, STORAGE_REGISTRY_BYTES, 'storage-registry');
  const createRepairs = () => new StorageRepairs(db, objects, assets, root, epoch, check, current => {
    if (!authorized || current.clientId !== auth.clientId || current.sessionHash !== auth.sessionHash) throw Error('OWNER_REQUIRED');
  }, scope => readers || memory.otherBytes(scope) > 0, hash => refreshed.push(hash), memory);
  let rawRepairs = createRepairs();
  const call = (kind, args) => {
    const loanId = randomUUID(), scope = { loanId, registryId, kind };
    mirror.resize(loanId, STORAGE_OPERATION_BYTES[kind], 'storage-read'); loans.add(loanId);
    const release = () => { loans.delete(loanId); mirror.drop(loanId, () => assert.fail('No content handles')); };
    try { const work = rawRepairs[kind](...args, scope); void work.then(release, release); return work; } catch (error) { release(); throw error; }
  };
  const repairs = { review: (...args) => call('review', args), repair: (...args) => call('repair', args), close: () => rawRepairs.close() };
  const identity = () => Object.fromEntries(['assets', 'objects', 'roots', 'documents', 'history', 'commands', 'events_v2'].map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()]));
  const before = identity();
  async function upload(data = bytes, changes = {}) {
    const create = { protocolVersion: 1, stagingId: randomUUID(), purpose: 'text', expectedBytes: String(data.length), sha256: sha(data), mediaType: 'application/octet-stream', ...changes };
    assets.create(create, auth);
    for (let at = 0; at < data.length; at += IO_CHUNK) {
      const chunk = data.subarray(at, at + IO_CHUNK), token = assets.beginChunk(create.stagingId, String(at), chunk.length, auth);
      assets.chunk(token, chunk, auth);
    }
    return assets.get(create.stagingId, auth);
  }
  const review = () => repairs.review(asset.id, ref.hash, auth);
  const request = (r, stage, changes = {}) => ({ protocolVersion: 1, operationId: randomUUID(), reviewId: r.reviewId, reviewHash: r.reviewHash, stagingId: stage.stagingId, expectedStagingVersion: stage.version, ...changes });
  const absent = () => assert.throws(() => readFileSync(objects.path(ref)), { code: 'ENOENT' });
  t.after(async () => { await repairs.close(); await assets.close(); assert.equal(objects.hasLeases(), false); assert.equal(loans.size, 0); memory.close(); mirror.drop(registryId, () => assert.fail('No content handles')); assert.equal(mirror.bytes, 0); objects.close(); db.close(); });
  return { root, db, objects, assets, mirror, memory, loans, get repairs() { return repairs; }, auth, ref, bytes, asset, refreshed, before, identity, upload, review, request, absent,
    fence() { fenced = true; }, revoke() { authorized = false; }, readers(value) { readers = value; }, barrier(fn) { barrier = fn; },
    async restart() { await repairs.close(); epoch = '2'; rawRepairs = createRepairs(); } };
}

for (const condition of ['missing', 'corrupt']) for (const dependency of [false, true]) test('exact ' + condition + ' ' + (dependency ? 'secondary pixel dependency' : 'primary asset') + ' repair preserves accepted identities', async t => {
  const f = await fixture(t, { condition, dependency }), review = await f.review(), stage = await f.upload(), request = f.request(review, stage);
  storageRepairReview(review); assert.equal(review.condition, condition);
  const result = await f.repairs.repair(f.asset.id, request, f.auth);
  storageRepairResult(result); assert.equal(result.status, 'restored'); assert.equal(result.previousCondition, condition);
  assert.deepEqual(result.ref, f.ref); assert.equal(result.assetVersion, '7'); assert.equal(result.operationId, request.operationId);
  assert.deepEqual(readFileSync(f.objects.path(f.ref)), f.bytes); assert.deepEqual(f.identity(), f.before); assert.deepEqual(f.refreshed, [f.ref.hash]);
  const completed = f.assets.get(stage.stagingId, f.auth); assert.equal(completed.state, 'finalized'); assert.equal(completed.version, String(BigInt(stage.version) + 1n)); assert.deepEqual(completed.assetRef, f.ref);
  const again = await f.repairs.repair(f.asset.id, request, f.auth); assert.equal(again.status, 'already-available'); assert.equal(again.previousCondition, 'available');
  assert.equal(f.assets.get(stage.stagingId, f.auth).version, completed.version); assert.deepEqual(f.identity(), f.before);
  if (dependency) assert.throws(() => f.objects.verify(f.asset.blob), { code: 'MISSING_OBJECT' }, 'Restoring one dependency does not claim the whole asset closure is present');
});

for (const mismatch of ['hash', 'length', 'media', 'purpose', 'version', 'owner']) test('repair rejects staging ' + mismatch + ' without publishing or substituting an asset', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(), current = { ...stage };
  if (mismatch === 'hash') current.sha256 = sha(Buffer.from('wrong'));
  if (mismatch === 'length') current.expectedBytes = current.committedOffset = '1';
  if (mismatch === 'media') current.mediaType = 'text/plain';
  if (mismatch === 'purpose') current.purpose = 'caption';
  if (mismatch === 'version') current.version = String(BigInt(current.version) + 1n);
  if (mismatch === 'owner') current.ownerClientId = 'other_client';
  f.db.prepare('UPDATE staged_assets SET json=? WHERE id=?').run(canonical(current), stage.stagingId);
  await assert.rejects(async () => f.repairs.repair(f.asset.id, f.request(r, stage), f.auth)); f.absent();
  assert.deepEqual(f.identity(), f.before); assert.deepEqual(f.refreshed, []);
});

test('lying upload hash cannot publish different same-length bytes at the accepted hash', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(Buffer.alloc(f.bytes.length, 120), { sha256: f.ref.hash });
  await assert.rejects(f.repairs.repair(f.asset.id, f.request(r, stage), f.auth), { code: 'CORRUPT_OBJECT' });
  f.absent(); assert.deepEqual(f.identity(), f.before); assert.equal(f.assets.get(stage.stagingId, f.auth).state, 'complete');
});

for (const change of ['asset', 'root', 'stage', 'session', 'epoch']) test('changed ' + change + ' during a bounded read fences publication', async t => {
  const f = await fixture(t, { bytes: Buffer.alloc(IO_CHUNK + 17, 49) }), r = await f.review(), stage = await f.upload();
  const pending = f.repairs.repair(f.asset.id, f.request(r, stage), f.auth);
  if (change === 'asset') f.db.prepare('UPDATE assets SET json=? WHERE id=?').run(canonical({ ...f.asset, version: '8' }), f.asset.id);
  if (change === 'root') f.db.prepare('DELETE FROM roots WHERE hash=?').run(f.ref.hash);
  if (change === 'stage') f.db.prepare('UPDATE staged_assets SET json=? WHERE id=?').run(canonical({ ...stage, ownerClientId: 'other_client' }), stage.stagingId);
  if (change === 'session') f.revoke(); if (change === 'epoch') f.fence();
  await assert.rejects(pending); f.absent(); assert.equal(f.objects.hasLeases(), false); assert.deepEqual(f.refreshed, []);
});

for (const kind of ['recovery-reader', 'object-proof']) test('active ' + kind + ' prevents repair until its owned read drains', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(), request = f.request(r, stage);
  let proof; if (kind === 'recovery-reader') f.readers(true); else { const other = f.objects.putMetadata(Buffer.from('{}')); proof = await f.objects.prove(other, () => {}); }
  await assert.rejects(f.repairs.repair(f.asset.id, request, f.auth), { code: 'CAPACITY' }); f.absent();
  if (proof) f.objects.releaseProof(proof); f.readers(false);
  assert.equal((await f.repairs.repair(f.asset.id, request, f.auth)).status, 'restored');
});

test('a different corrupt inode appearing after review is never overwritten', async t => {
  const f = await fixture(t, { condition: 'corrupt' }), r = await f.review(), stage = await f.upload(), target = f.objects.path(f.ref);
  renameSync(target, join(f.root, 'original-corrupt')); const other = Buffer.from('replacement damaged object'); writeFileSync(target, other, { mode: 0o600 });
  await assert.rejects(f.repairs.repair(f.asset.id, f.request(r, stage), f.auth), { code: 'CORRUPT_OBJECT' });
  assert.deepEqual(readFileSync(target), other); assert.deepEqual(f.identity(), f.before);
});

test('valid exact bytes appearing after a missing review are verified without replacement', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(); writeFileSync(f.objects.path(f.ref), f.bytes, { mode: 0o600 });
  const result = await f.repairs.repair(f.asset.id, f.request(r, stage), f.auth); assert.equal(result.status, 'already-available'); assert.deepEqual(f.identity(), f.before);
});

test('late corrupt target replacement is refused at the atomic publication boundary', async t => {
  const f = await fixture(t, { condition: 'corrupt' }), r = await f.review(), stage = await f.upload(), target = f.objects.path(f.ref), other = Buffer.from('late unknown bytes');
  f.barrier(phase => { if (phase === 'repair-before-publish') { renameSync(target, join(f.root, 'held-corrupt')); writeFileSync(target, other, { mode: 0o600 }); } });
  await assert.rejects(f.repairs.repair(f.asset.id, f.request(r, stage), f.auth)); assert.deepEqual(readFileSync(target), other); assert.deepEqual(f.refreshed, []);
});

for (const phase of ['repair-before-publish', 'repair-after-publish', 'repair-after-directory-sync']) test(phase + ' failure never reports Restored and exact retry remains inspectable', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(), request = f.request(r, stage); let fired = false;
  f.barrier(at => { if (at === phase && !fired) { fired = true; throw Error('INJECTED_REPAIR_FAILURE'); } });
  await assert.rejects(f.repairs.repair(f.asset.id, request, f.auth), /INJECTED_REPAIR_FAILURE/);
  assert.equal(f.assets.get(stage.stagingId, f.auth).state, 'complete'); assert.deepEqual(f.identity(), f.before); assert.deepEqual(f.refreshed, []);
  const result = await f.repairs.repair(f.asset.id, request, f.auth);
  assert.equal(result.status, phase === 'repair-before-publish' ? 'restored' : 'already-available'); assert.deepEqual(readFileSync(f.objects.path(f.ref)), f.bytes);
});

test('restart requires a fresh authority review and verifies already-restored bytes', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(), request = f.request(r, stage);
  await f.repairs.repair(f.asset.id, request, f.auth); await f.restart();
  await assert.rejects(f.repairs.repair(f.asset.id, request, f.auth), { code: 'REVIEW_EXPIRED' });
  const fresh = await f.review(); assert.equal(fresh.condition, 'available');
  const result = await f.repairs.repair(f.asset.id, f.request(fresh, f.assets.get(stage.stagingId, f.auth)), f.auth);
  assert.equal(result.status, 'already-available'); assert.deepEqual(f.identity(), f.before);
});

test('operation nonce reuse with different input is refused and successful replay is re-proved', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(), request = f.request(r, stage);
  await f.repairs.repair(f.asset.id, request, f.auth);
  await assert.rejects(async () => f.repairs.repair(f.asset.id, { ...request, stagingId: 'different' }, f.auth), { code: 'COMMAND_ID_REUSE' });
  writeFileSync(f.objects.path(f.ref), 'changed after success');
  await assert.rejects(f.repairs.repair(f.asset.id, request, f.auth), { code: 'CORRUPT_OBJECT' }); assert.deepEqual(f.identity(), f.before);
});

test('one writer serializes active requests and re-proves the same nonce after settlement', async t => {
  const f = await fixture(t, { bytes: Buffer.alloc(IO_CHUNK + 1, 48) }), r = await f.review(), stage = await f.upload(), request = f.request(r, stage);
  const pending = f.repairs.repair(f.asset.id, request, f.auth);
  assert.throws(() => f.repairs.repair(f.asset.id, request, f.auth), { code: 'CAPACITY' });
  assert.throws(() => f.repairs.repair(f.asset.id, { ...request, operationId: randomUUID() }, f.auth), { code: 'CAPACITY' });
  assert.equal((await pending).status, 'restored'); assert.equal((await f.repairs.repair(f.asset.id, request, f.auth)).status, 'already-available'); assert.deepEqual(f.identity(), f.before);
});

test('upload symlink is refused without reading or changing its target', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload();
  const filename = f.db.prepare('SELECT filename FROM staged_assets WHERE id=?').get(stage.stagingId).filename;
  const upload = join(f.root, 'uploads', filename), sentinel = join(f.root, 'sentinel');
  writeFileSync(sentinel, f.bytes, { mode: 0o600 }); unlinkSync(upload); symlinkSync(sentinel, upload);
  await assert.rejects(f.repairs.repair(f.asset.id, f.request(r, stage), f.auth), { code: 'ROOT_UNSAFE' }); f.absent(); assert.deepEqual(readFileSync(sentinel), f.bytes);
});

test('font-owned shared dependency and unregistered hash cannot acquire a repair review', async t => {
  const f = await fixture(t); await assert.rejects(f.repairs.review(f.asset.id, sha(Buffer.from('unregistered')), f.auth));
  f.db.prepare('INSERT INTO assets VALUES (?,?)').run('font_version', canonical({ ...f.asset, id: 'font_version', purpose: 'font', qualification: 'font' }));
  await assert.rejects(f.review(), { code: 'CONTENT_WITHHELD' }); f.absent();
});

function registeredFont(f, target = 'bytes', retained) {
  const other = { hash: sha(Buffer.from('another accepted immutable font/license')), byteLength: '39', mediaType: 'application/octet-stream' };
  const value = { schemaVersion: 1, bytes: retained?.bytes ?? (target === 'bytes' ? f.ref : other), faceIndex: 0, format: 'static-ttf', parserProfile: 'sfnt-static-1-freetype-canvaskit040', fsType: 0, licenseRecord: retained?.license ?? (target === 'license' ? f.ref : other), origin: retained ? 'bundled' : 'local-file', embedding: 'permitted' };
  const font = { ...value, id: sha(Buffer.from(canonical(value))) };
  Object.assign(f.asset, { purpose: 'font', qualification: 'font', measuredMediaType: 'application/octet-stream', blob: font.bytes, dependencies: [font.licenseRecord], font });
  f.db.prepare('UPDATE assets SET json=? WHERE id=?').run(canonical(f.asset), f.asset.id);
  return font;
}

// These rows model previously accepted FontVersion metadata. No fixture is a
// native font-validation or new-import qualification claim.
for (const target of ['bytes', 'license']) test('exact registered corrupt font ' + target + ' collision restores accepted identity only', async t => {
  const metadata = JSON.parse(readFileSync(new URL('../../src/text/profile.json', import.meta.url), 'utf8')).fonts.find(row => row.id === 'NotoSans');
  const fontBytes = readFileSync(new URL('../../vendor/text/' + metadata.file, import.meta.url)), licenseBytes = readFileSync(new URL('../../vendor/text/' + metadata.licenseFile, import.meta.url));
  assert.equal(sha(fontBytes), 'sha256:' + metadata.sha256); assert.equal(fontBytes.length, metadata.bytes); assert.equal(sha(licenseBytes), metadata.licenseHash);
  const retained = { bytes: { hash: sha(fontBytes), byteLength: String(fontBytes.length), mediaType: 'application/octet-stream' }, license: { hash: sha(licenseBytes), byteLength: String(licenseBytes.length), mediaType: 'text/plain' } };
  const f = await fixture(t, { bytes: target === 'bytes' ? fontBytes : licenseBytes, condition: 'corrupt', mediaType: target === 'bytes' ? 'application/octet-stream' : 'text/plain' });
  const font = registeredFont(f, target, retained), before = f.identity(), review = await f.review(), stage = await f.upload();
  const wrong = await f.upload(Buffer.alloc(f.bytes.length, 88));
  await assert.rejects(f.repairs.repair(f.asset.id, f.request(review, wrong), f.auth), { code: 'CORRUPT_OBJECT' });
  assert.notDeepEqual(readFileSync(f.objects.path(f.ref)), f.bytes);
  assert.equal((await f.repairs.repair(f.asset.id, f.request(review, stage), f.auth)).status, 'restored');
  assert.deepEqual(readFileSync(f.objects.path(f.ref)), f.bytes); assert.deepEqual(f.identity(), before);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT json FROM assets WHERE id=?').get(f.asset.id).json).font, font);
});

for (const mismatch of ['identity', 'parser', 'asset-ref', 'license-ref', 'bundled-origin', 'unsafe']) test('retained font repair refuses ' + mismatch + ' metadata instead of establishing new trust', async t => {
  const f = await fixture(t, { condition: 'corrupt', mediaType: 'application/octet-stream' }); registeredFont(f);
  if (mismatch === 'identity') f.asset.font.id = sha(Buffer.from('different identity'));
  if (mismatch === 'parser') f.asset.font.parserProfile = 'unreviewed-profile';
  if (mismatch === 'asset-ref') f.asset.blob = { ...f.ref, mediaType: 'font/ttf' };
  if (mismatch === 'license-ref') f.asset.dependencies = [{ ...f.asset.font.licenseRecord, byteLength: '1' }];
  if (mismatch === 'bundled-origin') { f.asset.font.origin = 'bundled'; const { id, ...body } = f.asset.font; f.asset.font.id = sha(Buffer.from(canonical(body))); }
  if (mismatch === 'unsafe') f.asset.safety = 'quarantined';
  f.db.prepare('UPDATE assets SET json=? WHERE id=?').run(canonical(f.asset), f.asset.id);
  await assert.rejects(f.review(), { code: 'CONTENT_WITHHELD' }); assert.notDeepEqual(readFileSync(f.objects.path(f.ref)), f.bytes);
});

test('repair stops after its shared memory loan is revoked and refunds the active scope', async t => {
  const f = await fixture(t, { bytes: Buffer.alloc(IO_CHUNK + 1, 71) }), r = await f.review(), stage = await f.upload();
  const work = f.repairs.repair(f.asset.id, f.request(r, stage), f.auth);
  assert.equal(f.loans.size, 1); for (const id of f.loans) f.mirror.drop(id, () => assert.fail('No content handles'));
  await assert.rejects(work); f.absent(); assert.equal(f.loans.size, 0);
});

test('unrelated shared memory owner blocks repair without spending its allowance', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(), id = randomUUID();
  f.mirror.resize(id, 4096);
  try { await assert.rejects(f.repairs.repair(f.asset.id, f.request(r, stage), f.auth), { code: 'CAPACITY' }); f.absent(); }
  finally { f.mirror.drop(id, () => assert.fail('No content handles')); }
});

test('oversized authority JSON is refused before materialization or target publication', async t => {
  const f = await fixture(t); f.db.prepare('UPDATE roots SET owner=?').run('history-command:large');
  f.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run('large', sha(Buffer.from('large')), '{"status":"accepted"}', JSON.stringify({ padding: 'x'.repeat(262145) }));
  await assert.rejects(f.review(), { code: 'CAPACITY' }); f.absent();
});

test('a shared hash owned only by another asset cannot resurrect the selected unowned asset', async t => {
  const f = await fixture(t); f.db.prepare('UPDATE roots SET owner=?').run('asset:different_asset');
  await assert.rejects(f.review(), { code: 'NOT_FOUND' }); f.absent();
});

test('typed document registration owner is invalidated by document deletion', async t => {
  const f = await fixture(t); f.db.prepare('UPDATE roots SET owner=?').run('history-command:creator');
  f.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run('creator', sha(Buffer.from('command')), '{"status":"accepted"}', canonical({ command: { documentId: 'document_1', body: { type: 'NewDocument' } } }));
  f.db.prepare('INSERT INTO events_v2 VALUES (?,?)').run('creator', canonical({ type: 'AssetRegistered', payload: { asset: f.asset } }));
  assert.equal(repairOwnership(f.db, f.asset, f.ref).owner, 'history-command:creator'); const r = await f.review(), stage = await f.upload();
  f.db.prepare('INSERT INTO candidate_document_tombstones VALUES (?,?)').run('document_1', 'deleted');
  f.db.prepare('INSERT INTO roots VALUES (?,?,?)').run('asset:unrelated_live_asset', f.ref.hash, f.ref.mediaType);
  await assert.rejects(f.repairs.repair(f.asset.id, f.request(r, stage), f.auth)); f.absent();
});

for (const kind of ['accepted-import', 'request-mask', 'candidate-original', 'candidate-prepared', 'namespace', 'ui-draft']) test('actual ' + kind + ' retention edge authorizes only the selected asset', async t => {
  const f = await fixture(t); let owner;
  if (kind === 'accepted-import') {
    owner = 'history-command:importer';
    f.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run('importer', sha(Buffer.from('import')), '{"status":"accepted"}', canonical({ command: { documentId: 'document_1', body: { type: 'ImportAsset', assetId: f.asset.id } } }));
  } else if (kind === 'request-mask') owner = 'request-mask:document_1:' + f.asset.id;
  else if (kind.startsWith('candidate-')) {
    owner = kind === 'candidate-original' ? 'candidate:result' : 'candidate-prepared:' + f.asset.id;
    f.db.prepare('INSERT INTO candidates VALUES (?,?,?)').run('result', 'document_1', canonical({ id: 'result', safety: 'safe', encodedAssetId: kind === 'candidate-original' ? f.asset.id : 'other', preparedAssetId: kind === 'candidate-prepared' ? f.asset.id : null }));
  } else if (kind === 'namespace') {
    owner = 'namespace:imported'; f.db.prepare('INSERT INTO portable_namespaces VALUES (?,?,?)').run('imported', 'document_1', 'retained source');
    f.db.prepare('INSERT INTO portable_rows VALUES (?,?,?,?)').run('imported', 'asset', f.asset.id, canonical(f.asset));
  } else {
    owner = 'ui:client_1:session_1:draft:1';
    f.db.prepare('INSERT INTO ui_checkpoints VALUES (?,?,?)').run('client_1', 'session_1', canonical({ drafts: [{ id: 'draft', generation: '1', assetId: f.asset.id, documentId: 'document_1' }] }));
  }
  f.db.prepare('UPDATE roots SET owner=?').run(owner);
  assert.equal(repairOwnership(f.db, f.asset, f.ref).owner, owner);
  assert.throws(() => repairOwnership(f.db, { ...f.asset, id: 'unrelated_asset' }, f.ref), { code: 'NOT_FOUND' });
  const before = f.identity(), r = await f.review(), stage = await f.upload();
  assert.equal((await f.repairs.repair(f.asset.id, f.request(r, stage), f.auth)).status, 'restored'); assert.deepEqual(f.identity(), before);
});

test('returned review mutation cannot change the server-held target', async t => {
  const f = await fixture(t), r = await f.review(), stage = await f.upload(); r.ref.mediaType = 'image/png'; r.assetVersion = '999';
  const result = await f.repairs.repair(f.asset.id, f.request(r, stage), f.auth); assert.deepEqual(result.ref, f.ref); assert.equal(result.assetVersion, '7');
});

test('close drains and cancels yielded repair without publication', async t => {
  const f = await fixture(t, { bytes: Buffer.alloc(IO_CHUNK + 1, 50) }), r = await f.review(), stage = await f.upload();
  const pending = f.repairs.repair(f.asset.id, f.request(r, stage), f.auth), rejected = assert.rejects(pending, { code: 'CLOSED' }); await f.repairs.close(); await rejected;
  f.absent(); assert.equal(f.objects.hasLeases(), false);
});

test('strict direct-operation protocol rejects paths, replacement identity and false Saved outcomes', () => {
  const body = { protocolVersion: 1, operationId: 'operation', reviewId: 'review', reviewHash: 'sha256:' + '1'.repeat(64), stagingId: 'stage', expectedStagingVersion: '2' };
  storageRepairRequest(body);
  for (const extra of [{ path: '/tmp/arbitrary' }, { assetId: 'replacement' }, { mediaType: 'image/png' }]) assert.throws(() => storageRepairRequest({ ...body, ...extra }));
  assert.throws(() => storageRepairRequest({ ...body, expectedStagingVersion: '02' }));
  const result = { protocolVersion: 1, operationId: 'operation', status: 'restored', assetId: 'asset', assetVersion: '1', ref: { hash: body.reviewHash, byteLength: '1', mediaType: 'text/plain' }, previousCondition: 'missing' };
  storageRepairResult(result); assert.throws(() => storageRepairResult({ ...result, status: 'Saved' })); assert.throws(() => storageRepairResult({ ...result, status: 'already-available' }));
});

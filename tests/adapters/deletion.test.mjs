import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AdapterDeletions } from '../../dist/local/server/storage/adapter-deletion.js';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { command, encode, rootFor } from '../store/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const auth = () => ({ clientId: 'client_1', sessionHash: 'a'.repeat(64), now: Date.now(), expires: Date.now() + 3600000 });
const cmd = body => encode(command(EMPTY_EXPECTED_VERSIONS, { documentId: null, body }));
function fixture(t, root = null) {
  const db = new DatabaseSync(root ? join(root, 'metadata.sqlite') : ':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('writerEpoch','1');
    CREATE TABLE client_bindings(cookie_hash TEXT,client_id TEXT,expires TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE queue_jobs(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE portable_rows(namespace TEXT,kind TEXT,id TEXT,json TEXT);
    CREATE TABLE candidates(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE candidate_journal(family TEXT,id TEXT,json TEXT);
    CREATE TABLE ui_checkpoints(client_id TEXT,session_id TEXT,json TEXT);
    CREATE TABLE ui_receipts(client_id TEXT,id TEXT,json TEXT);
    CREATE TABLE documents(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE history(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE checkpoints(id TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE history_preparations(id TEXT PRIMARY KEY,canonical TEXT,frozen TEXT);
    CREATE TABLE portable_preparations(id TEXT PRIMARY KEY,canonical TEXT,frozen TEXT);`);
  const a = auth(); db.prepare('INSERT INTO client_bindings VALUES(?,?,?)').run(a.sessionHash, a.clientId, String(a.expires));
  const buffers = new Map(), roots = new Map(), receipts = new Map(); let event;
  const objects = {
    putMetadata(bytes) { const ref = { hash: sha(bytes), byteLength: String(bytes.length), mediaType: 'application/json' }; buffers.set(ref.hash, Buffer.from(bytes)); return ref; },
    verify(ref) { const bytes = buffers.get(ref.hash); if (!bytes || sha(bytes) !== ref.hash) throw Error('missing object'); return bytes; },
    readRange(ref, start, count) { return this.verify(ref).subarray(Number(start), Number(start) + count); }
  };
  const asset = { id: 'adapter_version_1', version: '1', purpose: 'adapter', qualification: 'adapter-version', blob: { hash: sha('weights'), byteLength: '7', mediaType: 'application/octet-stream' }, adapter: { id: 'adapter_version_1', adapterId: 'adapter_family_1', version: '1', weights: { hash: sha('weights'), byteLength: '7', mediaType: 'application/octet-stream' } } };
  db.prepare('INSERT INTO assets VALUES(?,?)').run(asset.id, canonical(asset)); roots.set('asset:' + asset.id, [asset.blob]);
  const assets = { asset(id) { const row = db.prepare('SELECT json FROM assets WHERE id=?').get(id); return row ? JSON.parse(row.json) : null; } };
  const deletion = new AdapterDeletions(db, objects, assets, () => {}, (bytes, build) => {
    const c = JSON.parse(Buffer.from(bytes)).command, identity = canonical(JSON.parse(Buffer.from(bytes)));
    if (receipts.has(c.commandId)) { const previous = receipts.get(c.commandId); if (previous.identity !== identity) throw Error('COMMAND_ID_REUSE'); return previous.receipt; }
    let receipt;
    try { event = build(); db.prepare('INSERT INTO assets VALUES(?,?)').run(event.payload.asset.id, canonical(event.payload.asset)); receipt = { status: 'accepted', commandId: c.commandId }; }
    catch (e) { if (!e.reason) throw e; receipt = { status: 'rejected', code: e.code, reason: e.reason }; }
    receipts.set(c.commandId, { identity, receipt }); return receipt;
  }, (owner, ref) => roots.set(owner, [ref]));
  const preview = () => { assert.equal(deletion.command(cmd({ type: 'PreviewAdapterDeletion', versionId: asset.id }), a).status, 'accepted'); return deletion.review(event.payload.asset.id, a); };
  const remove = plan => deletion.command(cmd({ type: 'DeleteAdapterVersion', versionId: asset.id, planId: plan.id, token: plan.token }), a);
  const metadata = value => objects.putMetadata(Buffer.from(canonical(value)));
  return { db, a, asset, assets, deletion, preview, remove, metadata, buffers, roots, get event() { return event; } };
}
const request = id => ({ adapters: [{ version: id, hash: sha('weights'), scale: '1' }] });
function draft(f, generation = '1') {
  const blob = f.metadata(request(f.asset.id)), draftAsset = { id: 'draft_asset_' + generation, blob };
  f.db.prepare('INSERT OR REPLACE INTO assets VALUES(?,?)').run(draftAsset.id, canonical(draftAsset));
  const value = { id: 'draft_1', generation, kind: 'request', assetId: draftAsset.id, status: 'saved-unapplied' };
  f.db.prepare('DELETE FROM ui_checkpoints').run();
  f.db.prepare('INSERT INTO ui_checkpoints VALUES(?,?,?)').run(f.a.clientId, 'session_1', canonical({ drafts: [value] }));
  return value;
}

test('adapter deletion records an immutable tombstone and never removes or credits original bytes', t => {
  const f = fixture(t), original = f.assets.asset(f.asset.id), before = structuredClone(f.roots.get('asset:' + f.asset.id)), plan = f.preview();
  assert.equal(plan.canDelete, true); assert.equal(plan.actualFreedBytes, '0'); assert.equal(plan.bytesRetained, true);
  assert.equal(plan.dependencyCount, 0); assert.deepEqual(plan.dependencies, []);
  const bytes = cmd({ type: 'DeleteAdapterVersion', versionId: f.asset.id, planId: plan.id, token: plan.token });
  const receipt = f.deletion.command(bytes, f.a); assert.equal(receipt.status, 'accepted'); assert.deepEqual(f.deletion.command(bytes, f.a), receipt);
  assert.deepEqual(f.assets.asset(f.asset.id), original); assert.deepEqual(f.roots.get('asset:' + f.asset.id), before);
  assert.equal(f.event.payload.asset.adapterDeletion.kind, 'deleted');
  const recorded = JSON.parse(f.buffers.get(f.event.payload.asset.blob.hash)); assert.equal(recorded.actualFreedBytes, '0'); assert.equal(recorded.bytesRetained, true);
  assert.equal(f.deletion.command(cmd({ type: 'PreviewAdapterDeletion', versionId: f.asset.id }), f.a).reason, 'ADAPTER_VERSION_DELETED');
});

test('preview binds the live client session and writer epoch, exact token and immutable version', t => {
  const f = fixture(t), plan = f.preview();
  const wrong = f.deletion.command(cmd({ type: 'DeleteAdapterVersion', versionId: f.asset.id, planId: plan.id, token: sha('wrong') }), f.a);
  assert.equal(wrong.reason, 'ADAPTER_DELETION_PREVIEW_CHANGED');
  const anotherTab = command(EMPTY_EXPECTED_VERSIONS, { documentId: null, sessionId: 'another_ui_session', body: { type: 'DeleteAdapterVersion', versionId: f.asset.id, planId: plan.id, token: plan.token } });
  assert.equal(f.deletion.command(encode(anotherTab), f.a).reason, 'ADAPTER_DELETION_PREVIEW_CHANGED');
  const next = { ...f.a, sessionHash: 'b'.repeat(64) }; f.db.prepare('INSERT INTO client_bindings VALUES(?,?,?)').run(next.sessionHash, next.clientId, String(next.expires));
  assert.throws(() => f.deletion.review(plan.id, next), { code: 'OWNER_REQUIRED' });
  assert.equal(f.deletion.command(cmd({ type: 'DeleteAdapterVersion', versionId: f.asset.id, planId: plan.id, token: plan.token }), next).reason, 'ADAPTER_DELETION_PREVIEW_CHANGED');
  f.db.prepare("UPDATE meta SET value='2' WHERE key='writerEpoch'").run(); assert.equal(f.remove(plan).reason, 'ADAPTER_DELETION_PREVIEW_CHANGED');
  f.db.prepare('DELETE FROM client_bindings').run(); assert.throws(() => f.preview(), { code: 'OWNER_REQUIRED' });
});

test('saved draft and current review dependencies block deletion; stale previews cannot authorize changed dependencies', t => {
  const f = fixture(t), clearPlan = f.preview(), d = draft(f);
  assert.equal(f.remove(clearPlan).reason, 'ADAPTER_DEPENDENCIES_CHANGED');
  const review = { id: 'review_1', draft: { sessionId: 'session_1', draftId: d.id, generation: d.generation }, draftAsset: d.assetId, request: request(f.asset.id) };
  f.db.prepare('INSERT INTO ui_receipts VALUES(?,?,?)').run(f.a.clientId, review.id, canonical({ review }));
  const blocked = f.preview(); assert.equal(blocked.canDelete, false); assert.deepEqual(blocked.dependencies.map(x => x.kind), ['draft', 'review']);
  assert.equal(f.remove(blocked).reason, 'ADAPTER_HAS_DEPENDENCIES');
  draft(f, '2'); assert.equal(f.remove(blocked).reason, 'ADAPTER_DEPENDENCIES_CHANGED');
  f.db.prepare('DELETE FROM ui_checkpoints').run(); assert.equal(f.preview().canDelete, true, 'expired review history cannot execute without its current draft');
});

test('job and imported result provenance remain blockers including terminal and hidden results', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('job_1', canonical({ id: 'job_1', disposition: 'set-aside', review: { request: request(f.asset.id) }, attempts: [{ id: 'attempt_1', state: 'provider-terminal' }] }));
  f.db.prepare('INSERT INTO portable_rows VALUES(?,?,?,?)').run('namespace_1', 'job-result', 'result_1', canonical({ jobId: 'imported_job_1', id: 'result_1', request: { specification: request(f.asset.id) } }));
  const plan = f.preview(); assert.deepEqual(plan.dependencies.map(d => d.kind), ['job', 'provenance']); assert.equal(f.remove(plan).reason, 'ADAPTER_HAS_DEPENDENCIES');
});


test('imported result bindings resolve original adapter IDs to exact local versions', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO portable_rows VALUES(?,?,?,?)').run('namespace_1', 'job-result', 'result_1', canonical({ jobId: 'imported_job_1', id: 'result_1', request: { specification: request('original_adapter_version'), assetBindings: { original_adapter_version: f.asset.id } } }));
  const plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'provenance'); assert.equal(f.remove(plan).reason, 'ADAPTER_HAS_DEPENDENCIES');
});

test('retained successor adapter provenance blocks deletion of an older original-version source', t => {
  const f = fixture(t), successor = { ...f.asset, id: 'successor_version', adapter: { ...f.asset.adapter, id: 'successor_version', sources: { weightsAssetId: f.asset.id, configAssetId: null, provenanceAssetId: null } } };
  f.db.prepare('INSERT INTO assets VALUES(?,?)').run(successor.id, canonical(successor));
  const plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].id, 'adapter:' + successor.id); assert.equal(f.remove(plan).reason, 'ADAPTER_HAS_DEPENDENCIES');
});

test('cross-document adopted assets protect document, branch history and checkpoint after source deletion', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('deleted_source_job', canonical({ id: 'deleted_source_job', disposition: 'deleted', review: { request: request(f.asset.id) }, attempts: [{ id: 'attempt_1' }] }));
  f.db.prepare('INSERT INTO candidate_journal VALUES(?,?,?)').run('candidate', 'candidate_1', canonical({ id: 'candidate_1', jobId: 'deleted_source_job', encodedAssetId: 'candidate_original', preparedAssetId: 'candidate_prepared' }));
  const image = { state: f.metadata({ layers: [{ assetId: 'candidate_prepared' }] }) };
  f.db.prepare('INSERT INTO documents VALUES(?,?)').run('other_document', canonical({ image }));
  f.db.prepare('INSERT INTO history VALUES(?,?)').run('retained_branch', canonical({ before: image, after: {} }));
  f.db.prepare('INSERT INTO checkpoints VALUES(?,?)').run('checkpoint_1', canonical({ image }));
  const plan = f.preview(); assert.deepEqual(plan.dependencies.map(d => d.kind), ['checkpoint', 'document', 'history']); assert.equal(plan.canDelete, false);
});


test('retained raster derivatives keep exact candidate ancestry in a different document', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('source_job', canonical({ id: 'source_job', disposition: 'deleted', review: { request: request(f.asset.id) }, attempts: [] }));
  f.db.prepare('INSERT INTO candidate_journal VALUES(?,?,?)').run('candidate', 'candidate_1', canonical({ id: 'candidate_1', jobId: 'source_job', preparedAssetId: 'candidate_prepared' }));
  const derivative = { id: 'derivative_asset', raster: { sourceAssetIds: ['candidate_prepared'], manifest: f.metadata({ kind: 'derived' }) } };
  f.db.prepare('INSERT INTO assets VALUES(?,?)').run(derivative.id, canonical(derivative));
  f.db.prepare('INSERT INTO documents VALUES(?,?)').run('other_document', canonical({ image: { state: f.metadata({ layers: [{ assetId: derivative.id }] }) } }));
  const plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'document');
});



test('source-only retained provider jobs preserve upstream adapter result dependencies', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('adapter_source_job', canonical({ id: 'adapter_source_job', disposition: 'deleted', review: { request: request(f.asset.id) }, attempts: [] }));
  f.db.prepare('INSERT INTO candidate_journal VALUES(?,?,?)').run('candidate', 'source_candidate', canonical({ id: 'source_candidate', jobId: 'adapter_source_job', preparedAssetId: 'source_output' }));
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('transform_job', canonical({ id: 'transform_job', disposition: 'eligible', review: { request: { source: { assetId: 'source_output' }, adapters: [] } }, attempts: [] }));
  const plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'job'); assert.equal(plan.dependencies[0].id, 'transform_job');
});

test('deleted provider intermediates propagate ancestry into adopted outputs in another live document', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('adapter_source_job', canonical({ id: 'adapter_source_job', disposition: 'deleted', review: { request: request(f.asset.id) }, attempts: [] }));
  f.db.prepare('INSERT INTO candidate_journal VALUES(?,?,?)').run('candidate', 'source_candidate', canonical({ id: 'source_candidate', jobId: 'adapter_source_job', preparedAssetId: 'source_output' }));
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('transform_job', canonical({ id: 'transform_job', disposition: 'deleted', review: { request: { source: { assetId: 'source_output' }, adapters: [] } }, attempts: [] }));
  f.db.prepare('INSERT INTO candidate_journal VALUES(?,?,?)').run('candidate', 'transform_candidate', canonical({ id: 'transform_candidate', jobId: 'transform_job', preparedAssetId: 'transform_output' }));
  f.db.prepare('INSERT INTO documents VALUES(?,?)').run('destination_document', canonical({ image: { state: f.metadata({ layers: [{ assetId: 'transform_output' }] }) } }));
  const plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'document');
});

test('imported source-only result ancestry resolves frozen source IDs through local bindings', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('adapter_source_job', canonical({ id: 'adapter_source_job', disposition: 'deleted', review: { request: request(f.asset.id) }, attempts: [] }));
  f.db.prepare('INSERT INTO candidate_journal VALUES(?,?,?)').run('candidate', 'source_candidate', canonical({ id: 'source_candidate', jobId: 'adapter_source_job', preparedAssetId: 'source_output' }));
  f.db.prepare('INSERT INTO portable_rows VALUES(?,?,?,?)').run('namespace_1', 'job-result', 'imported_result', canonical({ id: 'imported_result', jobId: 'imported_transform_job', request: { specification: { source: { assetId: 'original_source' }, adapters: [] }, assetBindings: { original_source: 'source_output' } } }));
  const plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'provenance');
});

test('source-only saved request drafts retain candidate ancestry after source document deletion', t => {
  const f = fixture(t), d = draft(f);
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('source_job', canonical({ id: 'source_job', disposition: 'deleted', review: { request: request(f.asset.id) }, attempts: [] }));
  f.db.prepare('INSERT INTO candidate_journal VALUES(?,?,?)').run('candidate', 'candidate_1', canonical({ id: 'candidate_1', jobId: 'source_job', preparedAssetId: 'candidate_prepared' }));
  f.db.prepare('UPDATE assets SET json=? WHERE id=?').run(canonical({ id: d.assetId, blob: f.metadata({ adapters: [], source: { assetId: 'candidate_prepared' } }) }), d.assetId);
  const plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'draft');
});

test('pending SaveCopy inspects the sealed captured asset closure after current drafts are cleared', async t => {
  const root = await rootFor(t), f = fixture(t, root), directory = join(root, 'portable', 'capture_1');
  // The persisted SaveCopy command also retains its typed precondition manifest.
  assert.deepEqual(f.metadata({ entities: [], schemaVersion: 1 }), EMPTY_EXPECTED_VERSIONS);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'capture.sqlite'), capture = new DatabaseSync(path);
  capture.exec('CREATE TABLE entities(kind TEXT,id TEXT,json TEXT)'); capture.prepare('INSERT INTO entities VALUES(?,?,?)').run('asset', f.asset.id, canonical(f.asset)); capture.close(); await chmod(path, 0o600);
  const frozen = { capture: 'capture_1', captureHash: sha(await readFile(path)), document: { id: 'document_1' } }, copy = command(EMPTY_EXPECTED_VERSIONS, { body: { type: 'SaveCopy' } });
  f.db.prepare('INSERT INTO portable_preparations VALUES(?,?,?)').run('copy_command', canonical(copy), canonical(frozen));
  let plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'provenance'); assert.match(plan.dependencies[0].detail, /pending SaveCopy capture/); assert.equal(plan.dependencyCount, 1, 'complete command metadata leaves only the captured adapter dependency');
  const without = new DatabaseSync(path); without.prepare('DELETE FROM entities').run(); without.close();
  plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'unavailable', 'changed captured file must not grant deletion');
  frozen.captureHash = sha(await readFile(path)); f.db.prepare('UPDATE portable_preparations SET frozen=?').run(canonical(frozen));
  assert.equal(f.preview().canDelete, true, 'verified unrelated copy does not block this adapter');
  f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('source_job', canonical({ id: 'source_job', disposition: 'deleted', review: { request: request(f.asset.id) }, attempts: [] }));
  f.db.prepare('INSERT INTO candidate_journal VALUES(?,?,?)').run('candidate', 'candidate_1', canonical({ id: 'candidate_1', jobId: 'source_job', preparedAssetId: 'candidate_prepared' }));
  const sourceCopy = new DatabaseSync(path); sourceCopy.prepare('INSERT INTO entities VALUES(?,?,?)').run('asset', 'candidate_prepared', '{}'); sourceCopy.close();
  frozen.captureHash = sha(await readFile(path)); f.db.prepare('UPDATE portable_preparations SET frozen=?').run(canonical(frozen));
  plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencies[0].kind, 'provenance', 'captured source-only candidate ancestry remains a dependency');
});

test('all saved draft metadata shares the aggregate inspection budget', t => {
  const f = fixture(t), drafts = [];
  for (let i = 0; i < 6; i++) {
    const id = 'draft_asset_' + i, blob = { hash: sha('oversize-' + i), byteLength: String(16777217), mediaType: 'application/json' };
    f.db.prepare('INSERT INTO assets VALUES(?,?)').run(id, canonical({ id, blob })); drafts.push({ id: 'draft_' + i, kind: 'request', generation: '1', assetId: id });
  }
  f.db.prepare('INSERT INTO ui_checkpoints VALUES(?,?,?)').run(f.a.clientId, 'session_1', canonical({ drafts }));
  const plan = f.preview(); assert.equal(plan.canDelete, false); assert.equal(plan.dependencyCount, 6); assert.ok(plan.dependencies.some(d => /exceeds the bounded dependency inspection/.test(d.detail)));
});

test('missing dependency metadata refuses deletion while unrelated user text and shared weights do not', t => {
  const f = fixture(t), unrelated = f.metadata({ scene: f.asset.id, name: f.asset.id, blob: f.asset.blob });
  f.db.prepare('INSERT INTO documents VALUES(?,?)').run('unrelated', canonical({ image: { state: unrelated } })); assert.equal(f.preview().canDelete, true);
  f.buffers.delete(unrelated.hash); const blocked = f.preview(); assert.equal(blocked.canDelete, false); assert.equal(blocked.dependencies[0].kind, 'unavailable'); assert.equal(f.remove(blocked).reason, 'ADAPTER_HAS_DEPENDENCIES');
});

test('bounded reason disclosure retains full dependency identity and counts', t => {
  const f = fixture(t);
  for (let i = 0; i < 140; i++) f.db.prepare('INSERT INTO queue_jobs VALUES(?,?)').run('job_' + i, canonical({ id: 'job_' + i, disposition: 'eligible', review: { request: request(f.asset.id) }, attempts: [] }));
  const plan = f.preview(); assert.equal(plan.dependencies.length, 128); assert.equal(plan.dependencyCount, 140); assert.equal(plan.dependenciesTruncated, true);
  f.db.prepare('UPDATE queue_jobs SET json=? WHERE id=?').run(canonical({ id: 'job_99', disposition: 'set-aside', review: { request: request(f.asset.id) }, attempts: [] }), 'job_99');
  assert.equal(f.remove(plan).reason, 'ADAPTER_DEPENDENCIES_CHANGED');
});

async function own(w, bytes, a) {
  const stagingId = randomUUID(), hash = sha(bytes);
  await w.assetCreate({ protocolVersion: 1, stagingId, purpose: 'adapter', expectedBytes: String(bytes.length), sha256: hash, mediaType: 'application/octet-stream' }, a);
  const token = await w.assetBeginChunk(stagingId, '0', bytes.length, a); await w.assetChunk(token, bytes, a);
  const c = command(EMPTY_EXPECTED_VERSIONS, { documentId: null, body: { type: 'FinalizeStaging', stagingId, expectedSha256: hash } }); await w.assetCommand(encode(c), a);
  for (let i = 0; i < 500; i++) { const lookup = await w.lookup(c.command.commandId); if (lookup) { assert.equal(lookup.receipt.status, 'accepted'); return (await w.events(String(BigInt(lookup.receipt.fromSeq) - 1n))).events[0].payload.asset; } await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('asset timeout');
}

test('real writer deletion replay preserves roots, immutable originals and version history across restart', async t => {
  const root = await rootFor(t), a = auth(); let w = await openWriter({ root }); t.after(() => w.close()); await w.protocolDefaults(); await w.rememberClient(a.sessionHash, a.clientId, a.expires);
  const header = Buffer.from(JSON.stringify({ tensor: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } })), length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  const bytes = Buffer.concat([length, header, Buffer.alloc(4)]), original = await own(w, bytes, a);
  const registration = cmd({ type: 'RegisterAdapterVersion', adapterId: null, previousVersionId: null, weightsAssetId: original.id, configAssetId: null, provenanceAssetId: null, name: 'Delete review fixture', declaredFamily: 'ideogram-v4', declaredFormat: 'fal', provenanceText: 'local test' });
  let receipt = await w.adapterCommand(registration, a); assert.equal(receipt.status, 'accepted'); const version = (await w.events(String(BigInt(receipt.fromSeq) - 1n))).events[0].payload.asset;
  receipt = await w.adapterCommand(cmd({ type: 'PreviewAdapterDeletion', versionId: version.id }), a); assert.equal(receipt.status, 'accepted');
  const preview = (await w.events(String(BigInt(receipt.fromSeq) - 1n))).events[0].payload.asset, plan = await w.adapterDeletionReview(preview.id, a);
  assert.equal(plan.canDelete, true);
  const deletion = cmd({ type: 'DeleteAdapterVersion', versionId: version.id, planId: plan.id, token: plan.token }); receipt = await w.adapterCommand(deletion, a); assert.equal(receipt.status, 'accepted');
  assert.equal((await w.adapterList()).items.length, 0); assert.equal((await w.adapterView(version.id)).available, false);
  await w.close(); w = await openWriter({ root }); assert.deepEqual(await w.adapterCommand(deletion, a), receipt);
  assert.equal((await w.adapterList()).items.length, 0); assert.deepEqual((await w.assetProjection(version.id)).asset, version);
  assert.deepEqual(await readFile(join(root, 'objects', 'sha256', original.blob.hash.slice(7, 9), original.blob.hash.slice(7))), bytes);
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true });
  try { assert.ok(db.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get('asset:' + version.id, original.blob.hash)); } finally { db.close(); }
});

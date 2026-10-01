import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { command, encode } from '../store/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { newDraft } from '../../dist/local/src/request/core.js';

const sessionId = 'adapter_race_session', draftId = 'adapter_race_draft';
const auth = () => ({ clientId: 'client_1', sessionHash: 'a'.repeat(64), now: Date.now(), expires: Date.now() + 3600000 });
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const cmd = body => encode(command(EMPTY_EXPECTED_VERSIONS, { documentId: null, body }));

// Structurally valid, deliberately unqualified local weights. Saving an invalid
// request draft is allowed; this fixture grants no provider eligibility.
function weights() {
  const count = 300000;
  const header = Buffer.from(JSON.stringify({ tensor: { dtype: 'F32', shape: [count], data_offsets: [0, count * 4] } }));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, Buffer.alloc(count * 4, 7)]);
}

async function original(w, bytes, purpose = 'caption') {
  const stagingId = randomUUID(), hash = sha(bytes), a = auth();
  await w.assetCreate({ protocolVersion: 1, stagingId, purpose, expectedBytes: String(bytes.length), sha256: hash,
    mediaType: purpose === 'adapter' ? 'application/octet-stream' : 'text/plain' }, a);
  for (let offset = 0; offset < bytes.length; offset += 1048576) {
    const part = bytes.subarray(offset, offset + 1048576);
    const token = await w.assetBeginChunk(stagingId, String(offset), part.length, a);
    await w.assetChunk(token, part, a);
  }
  const request = command(EMPTY_EXPECTED_VERSIONS, { documentId: null, body: { type: 'FinalizeStaging', stagingId, expectedSha256: hash } });
  await w.assetCommand(encode(request), a);
  for (let i = 0; i < 1000; i++) {
    const lookup = await w.lookup(request.command.commandId);
    if (lookup) {
      assert.equal(lookup.receipt.status, 'accepted');
      return (await w.events(String(BigInt(lookup.receipt.fromSeq) - 1n))).events.find(e => e.commandId === request.command.commandId).payload.asset;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Original asset did not finalize');
}

async function adapterEvent(w, bytes) {
  const receipt = await w.adapterCommand(bytes, auth());
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  return (await w.events(String(BigInt(receipt.fromSeq) - 1n))).events[0];
}

async function saveRequest(w, asset, generation) {
  const state = await w.uiRead(sessionId, auth());
  return encode({ protocolVersion: 1, requestId: randomUUID(), sessionId, expectedUISeq: state.uiSeq,
    body: { type: 'SaveDraft', draft: { id: draftId, generation, kind: 'request', documentId: 'document_1',
      targetLayerId: null, expectedDocumentRevision: '1', assetId: asset.id, composing: false } } });
}

function uiStorage(root) {
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true });
  try {
    return {
      checkpoints: db.prepare('SELECT * FROM ui_checkpoints ORDER BY client_id,session_id').all(),
      events: db.prepare('SELECT * FROM ui_events ORDER BY client_id,session_id,seq').all(),
      roots: db.prepare("SELECT * FROM roots WHERE owner LIKE 'ui:client_1:adapter_race_session:%' ORDER BY owner,hash").all()
    };
  } finally { db.close(); }
}

async function reached(root) {
  for (let i = 0; i < 2000; i++) {
    try { return JSON.parse(await readFile(join(root, 'draft-deletion-race-reached.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('SaveDraft did not reach the completed weights proof gate');
}

for (const replacement of [false, true]) {
  test(`SaveDraft rejects deletion during completed async adapter proof (${replacement ? 'replacement generation preserves prior draft' : 'first draft'})`, { timeout: 60000 }, async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'adapter-draft-race-'));
    let w, pending;
    t.after(async () => {
      await writeFile(join(root, 'draft-deletion-race-release'), '', { mode: 0o600 }).catch(() => {});
      await pending?.catch(() => {});
      await w?.close();
      await rm(root, { recursive: true, force: true });
    });
    w = await openWriter({ root }, { setupModule: new URL('./draft-deletion-race-fixture.mjs', import.meta.url).href });
    await w.protocolDefaults();
    await w.rememberClient(auth().sessionHash, 'client_1', auth().expires);
    assert.equal((await w.submit(encode(command(EMPTY_EXPECTED_VERSIONS)), w.epoch)).status, 'accepted');
    const source = await original(w, weights(), 'adapter');
    const version = (await adapterEvent(w, cmd({ type: 'RegisterAdapterVersion', adapterId: null, previousVersionId: null,
      weightsAssetId: source.id, configAssetId: null, provenanceAssetId: null, name: 'Async draft race fixture',
      declaredFamily: 'ideogram-v4', declaredFormat: 'fal', provenanceText: 'Local structural fixture only.' }))).payload.asset;
    assert.equal(version.adapter.qualification, 'structurally-valid');
    assert.equal(version.adapter.validation.locallyEligible, false);
    const prompt = await original(w, Buffer.from('Retain this exact draft prompt'));
    const draft = newDraft(prompt.blob);
    let previousAsset;
    if (replacement) {
      previousAsset = await original(w, Buffer.from(JSON.stringify(draft)));
      assert.equal((await w.uiPersist(await saveRequest(w, previousAsset, '1'), auth())).status, 'accepted');
    }
    draft.adapters = [{ version: version.id, hash: version.blob.hash, scale: '0' }];
    const incoming = await original(w, Buffer.from(JSON.stringify(draft)));
    const request = await saveRequest(w, incoming, replacement ? '2' : '1');
    const before = await w.uiRead(sessionId, auth()), storageBefore = uiStorage(root);
    await writeFile(join(root, 'draft-deletion-race-arm.json'), JSON.stringify({ hash: source.blob.hash }), { mode: 0o600 });
    pending = w.uiPersist(request, auth());
    // Attach a handler immediately; the receipt is still asserted after release.
    pending.catch(() => {});
    const gate = await reached(root);
    assert.deepEqual(gate, { hash: source.blob.hash, byteLength: source.blob.byteLength, proofComplete: true });
    assert.deepEqual(await w.uiRead(sessionId, auth()), before);
    const preview = (await adapterEvent(w, cmd({ type: 'PreviewAdapterDeletion', versionId: version.id }))).payload.asset;
    const plan = await w.adapterDeletionReview(preview.id, auth());
    assert.equal(plan.canDelete, true);
    assert.equal(plan.dependencyCount, 0);
    const deletion = cmd({ type: 'DeleteAdapterVersion', versionId: version.id, planId: plan.id, token: plan.token });
    const deleted = await w.adapterCommand(deletion, auth());
    assert.equal(deleted.status, 'accepted');
    assert.equal((await w.adapterView(version.id)).available, false);
    assert.deepEqual(await w.uiRead(sessionId, auth()), before);
    await writeFile(join(root, 'draft-deletion-race-release'), '', { mode: 0o600 });
    const receipt = await pending;
    assert.equal(receipt.status, 'rejected');
    assert.equal(receipt.reason, 'ADAPTER_DEPENDENCY_CHANGED');
    assert.equal(receipt.uiSeq, before.uiSeq);
    assert.deepEqual(await w.uiRead(sessionId, auth()), before);
    assert.deepEqual(uiStorage(root), storageBefore);
    if (replacement) {
      assert.equal(before.drafts.length, 1);
      assert.equal(before.drafts[0].assetId, previousAsset.id);
      assert.equal(before.drafts[0].generation, '1');
      assert.equal(before.drafts[0].status, 'saved-unapplied');
    } else assert.deepEqual(before.drafts, []);
    assert.deepEqual(await w.uiPersist(request, auth()), receipt);
    await w.close();
    w = await openWriter({ root });
    assert.deepEqual(await w.uiPersist(request, auth()), receipt);
    assert.deepEqual(await w.adapterCommand(deletion, auth()), deleted);
    assert.deepEqual(await w.uiRead(sessionId, auth()), before);
    assert.deepEqual(uiStorage(root), storageBefore);
    assert.equal((await w.adapterView(version.id)).available, false);
    assert.deepEqual((await w.assetProjection(version.id)).asset, version);
  });
}

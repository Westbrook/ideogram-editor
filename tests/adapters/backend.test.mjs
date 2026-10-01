import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rootFor, command, encode } from '../store/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { adapterVersion, adapterDependencies } from '../../dist/local/src/protocol/adapters.js';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { adapterEligibility, adapterReferences } from '../../dist/local/server/storage/adapters.js';
const auth = { clientId: 'client_1', sessionHash: 'a'.repeat(64), expires: Date.now() + 43200000, now: Date.now() };
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const path = (root, ref) => join(root, 'objects', 'sha256', ref.hash.slice(7, 9), ref.hash.slice(7));
function weights(n = 16, overrides = {}) {
  const header = Buffer.from(JSON.stringify({ tensor: { dtype: 'F32', shape: [n], data_offsets: [0, n * 4], ...overrides } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([prefix, header, Buffer.alloc(n * 4, 7)]);
}
async function own(w, bytes, purpose = 'adapter') {
  const stagingId = randomUUID(), sha256 = hash(bytes);
  await w.assetCreate({ protocolVersion: 1, stagingId, purpose, expectedBytes: String(bytes.length), sha256, mediaType: purpose === 'adapter' ? 'application/octet-stream' : 'text/plain' }, auth);
  for (let at = 0; at < bytes.length; at += 1048576) {
    const part = bytes.subarray(at, at + 1048576), token = await w.assetBeginChunk(stagingId, String(at), part.length, auth);
    await w.assetChunk(token, part, auth);
  }
  const c = command(EMPTY_EXPECTED_VERSIONS, { documentId: null, body: { type: 'FinalizeStaging', stagingId, expectedSha256: sha256 } });
  await w.assetCommand(encode(c), auth);
  for (let n = 0; n < 500; n++) {
    const state = await w.lookup(c.command.commandId);
    if (state) { assert.equal(state.receipt.status, 'accepted'); const event = (await w.events(String(BigInt(state.receipt.fromSeq) - 1n))).events[0]; return event.payload.asset; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('No original receipt');
}
function registration(original, patch = {}) {
  return command(EMPTY_EXPECTED_VERSIONS, { documentId: null, body: { type: 'RegisterAdapterVersion', adapterId: null, previousVersionId: null, weightsAssetId: original.id, configAssetId: null, provenanceAssetId: null, name: 'Local V4 adapter', declaredFamily: 'ideogram-v4', declaredFormat: 'fal', provenanceText: 'Local test fixture; generic structure only, no V4 qualification.', ...patch } });
}
async function registered(w, c) {
  const receipt = await w.adapterCommand(encode(c), auth); assert.equal(receipt.status, 'accepted');
  return (await w.events(String(BigInt(receipt.fromSeq) - 1n))).events[0].payload.asset;
}

test('local weights stream into immutable versions with exact independent config/provenance roots and restart identity', async t => {
  const root = await rootFor(t); let w = await openWriter({ root }); t.after(() => w.close()); await w.protocolDefaults();
  const bytes = weights(300000), source = await own(w, bytes), config = await own(w, Buffer.from('{"format":"fal"}'), 'caption'), provenance = await own(w, Buffer.from('declared original source'), 'caption');
  assert.equal(source.qualification, 'pending-adapter'); await assert.rejects(w.assetVerify(source.id), { code: 'CONTENT_WITHHELD' });
  const c = registration(source, { configAssetId: config.id, provenanceAssetId: provenance.id }), asset = await registered(w, c), a = asset.adapter;
  adapterVersion(a); assert.equal(asset.id, a.id); assert.equal(a.qualification, 'structurally-valid'); assert.equal(a.validation.locallyEligible, false); assert.equal(a.validation.runtimeVerified, false); assert.equal(a.validation.profileId, null);
  assert.equal(a.validation.structure.tensorCount, 1); assert.deepEqual(a.weights, source.blob); assert.deepEqual(a.config, config.blob); assert.deepEqual(a.origin.original, provenance.blob);
  assert.deepEqual(asset.dependencies, adapterDependencies(a)); assert.equal((await readFile(path(root, source.blob))).equals(bytes), true);
  assert.equal(JSON.parse(await readFile(path(root, a.origin.provenance), 'utf8')).statement, c.command.body.provenanceText);
  assert.equal(JSON.parse(await readFile(path(root, a.validation.report), 'utf8')).weights.hash, source.blob.hash);
  await assert.rejects(w.assetVerify(asset.id), { code: 'CONTENT_WITHHELD' });
  const firstReceipt = (await w.lookup(c.command.commandId)).receipt; assert.deepEqual(await w.adapterCommand(encode(c), auth), firstReceipt);
  const second = await registered(w, registration(source, { adapterId: a.adapterId, previousVersionId: a.id, name: 'Updated metadata', configAssetId: config.id }));
  assert.equal(second.adapter.version, '2'); assert.equal(second.adapter.adapterId, a.adapterId); assert.notEqual(second.id, asset.id); assert.deepEqual((await w.assetProjection(asset.id)).asset, asset);
  const stale = await w.adapterCommand(encode(registration(source, { adapterId: a.adapterId, previousVersionId: a.id })), auth); assert.equal(stale.status, 'rejected'); assert.equal(stale.code, 'STALE_REVISION');
  await w.close(); w = await openWriter({ root }); assert.deepEqual((await w.assetProjection(asset.id)).asset, asset); assert.deepEqual((await w.lookup(c.command.commandId)).receipt, firstReceipt);
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true });
  try { const roots = db.prepare('SELECT hash,media_type FROM roots WHERE owner=?').all('asset:' + asset.id); assert.deepEqual(new Set(roots.map(r => r.hash)), new Set([asset.blob, ...asset.dependencies].map(r => r.hash))); } finally { db.close(); }
});

test('structural incompatibility and invalid config retain originals but cannot become request eligibility', async t => {
  const root = await rootFor(t), w = await openWriter({ root }); t.after(() => w.close()); await w.protocolDefaults();
  for (const [bytes, expected] of [[Buffer.from('not a safetensors file'), 'incompatible'], [weights(4, { data_offsets: [0, 9999] }), 'incompatible'], [Buffer.alloc(0), 'incompatible']]) {
    const source = await own(w, bytes), asset = await registered(w, registration(source)); assert.equal(asset.adapter.qualification, expected); assert.equal((await readFile(path(root, source.blob))).equals(bytes), true);
  }
  const source = await own(w, weights()), config = await own(w, Buffer.from('{bad-json'), 'caption'), asset = await registered(w, registration(source, { configAssetId: config.id }));
  assert.equal(asset.adapter.validation.reason, 'CONFIG_JSON_INVALID'); assert.equal(asset.safety, 'quarantined');
  const available = { asset: id => id === asset.id ? asset : null, adapterDeleted:()=>false };
  assert.deepEqual(adapterReferences(available, [{ version: asset.id, hash: asset.blob.hash }]), [asset.blob, ...asset.dependencies]);
  assert.equal(adapterEligibility(null, available, [{ version: asset.id, hash: asset.blob.hash }]).adapters.size, 0);
  assert.throws(() => adapterReferences(available, [{ version: asset.id, hash: 'sha256:' + '0'.repeat(64) }]), { code: 'MISSING_OBJECT' });
  assert.throws(() => adapterVersion({ ...asset.adapter, validation: { ...asset.adapter.validation, locallyEligible: true, profileId: 'imported-claim' } }));
});

test('metadata pages and exact filters stay bounded and reveal no tensors or executable content', async t => {
  const root = await rootFor(t), w = await openWriter({ root }); t.after(() => w.close()); await w.protocolDefaults(); const source = await own(w, weights());
  for (let n = 0; n < 23; n++) await registered(w, registration(source, { name: 'Library item ' + n, declaredFormat: n % 2 ? 'comfy' : 'fal' }));
  const first = await w.adapterList(); assert.equal(first.items.length, 20); assert.ok(first.nextAfter); const second = await w.adapterList(first.nextAfter); assert.equal(second.items.length, 3); assert.equal(second.nextAfter, null);
  assert.equal(new Set([...first.items, ...second.items].map(a => a.versionId)).size, 23); assert.ok(Buffer.byteLength(canonical(first)) < 60000);
  for (const item of first.items) { assert.equal(item.locallyEligible, false); assert.equal(item.runtimeVerified, false); assert.equal(Object.hasOwn(item, 'tensors'), false); assert.equal(Object.hasOwn(item, 'metadata'), false); }
  const filtered = await w.adapterList('', 'item', { family: 'ideogram-v4', format: 'fal', origin: 'import', status: 'structurally-valid' }); assert.equal(filtered.items.length, 12);
  assert.equal((await w.adapterList('', '', { origin: 'training' })).items.length, 0);
  assert.deepEqual(await w.adapterView(first.items[0].versionId), first.items[0]); await assert.rejects(w.adapterList('', '', { origin: 'url' }), { code: 'MALFORMED_REQUEST' });
});

test('missing/corrupt exact originals cannot register and metadata never grants byte access', async t => {
  const root = await rootFor(t), w = await openWriter({ root }); t.after(() => w.close()); await w.protocolDefaults();
  const source = await own(w, weights()), asset = await registered(w, registration(source));
  await unlink(path(root, source.blob)); assert.equal((await w.adapterView(asset.id)).available, false);
  const receipt = await w.adapterCommand(encode(registration(source)), auth); assert.equal(receipt.status, 'rejected'); assert.equal(receipt.code, 'MISSING_ASSET');
  const source2 = await own(w, weights(5)); await writeFile(path(root, source2.blob), Buffer.alloc(Number(source2.blob.byteLength)), { mode: 0o600 });
  const corrupt = await w.adapterCommand(encode(registration(source2)), auth); assert.equal(corrupt.status, 'rejected'); assert.equal(corrupt.code, 'MISSING_ASSET');
});

test('adapter registration enforces owner, exact command identity and narrow workspace schema', async t => {
  const root = await rootFor(t), w = await openWriter({ root }); t.after(() => w.close()); await w.protocolDefaults(); const source = await own(w, weights()), c = registration(source);
  await assert.rejects(w.adapterCommand(encode(c), { ...auth, clientId: 'other' }), { code: 'OWNER_REQUIRED' });
  await registered(w, c); const changed = structuredClone(c); changed.command.body.name = 'changed under accepted identity'; await assert.rejects(w.adapterCommand(encode(changed), auth), { code: 'COMMAND_ID_REUSE' });
  const url = registration(source); url.command.body.url = 'https://invalid.example/adapter.safetensors'; await assert.rejects(w.adapterCommand(encode(url), auth), { code: 'MALFORMED_REQUEST' });
  const document = registration(source); document.command.documentId = 'document_1'; const receipt = await w.adapterCommand(encode(document), auth); assert.equal(receipt.status, 'rejected'); assert.equal(receipt.code, 'INVALID_INPUT');
  assert.equal((await w.adapterList()).items.length, 1);
});

 test('shared content identities retain distinct typed references without duplicate ownership roots',async t=>{
  const root=await rootFor(t),w=await openWriter({root});t.after(()=>w.close());await w.protocolDefaults();
  const bytes=Buffer.from('{}'),source=await own(w,bytes),config=await own(w,bytes,'caption'),provenance=await own(w,bytes,'caption');
  const asset=await registered(w,registration(source,{configAssetId:config.id,provenanceAssetId:provenance.id}));assert.equal(asset.adapter.qualification,'incompatible');assert.equal(asset.blob.hash,asset.adapter.config.hash);assert.notEqual(asset.blob.mediaType,asset.adapter.config.mediaType);
  const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM roots WHERE owner=? AND hash=?').get('asset:'+asset.id,source.blob.hash).n,1);}finally{db.close();}
  await w.close();const replay=await openWriter({root});try{assert.deepEqual((await replay.assetProjection(asset.id)).asset,asset);}finally{await replay.close();}
 });

test('retained official profile weights become locally eligible with exact metadata and remain runtime unverified', { skip: !process.env.IE_ADAPTER_PROFILE_FIXTURE }, async t => {
  const { open, stat } = await import('node:fs/promises');
  const fixture=process.env.IE_ADAPTER_PROFILE_FIXTURE, expected='sha256:bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5';
  const info=await stat(fixture);assert.equal(info.size,85299896);
  const root=await rootFor(t),w=await openWriter({root});t.after(()=>w.close());await w.protocolDefaults();const stagingId=randomUUID();
  await w.assetCreate({protocolVersion:1,stagingId,purpose:'adapter',expectedBytes:String(info.size),sha256:expected,mediaType:'application/octet-stream'},auth);
  const file=await open(fixture,'r');try{for(let at=0;at<info.size;at+=1048576){const bytes=Buffer.alloc(Math.min(1048576,info.size-at));let read=0;while(read<bytes.length){const result=await file.read(bytes,read,bytes.length-read,at+read);assert.ok(result.bytesRead>0);read+=result.bytesRead;}const token=await w.assetBeginChunk(stagingId,String(at),bytes.length,auth);await w.assetChunk(token,bytes,auth);}}finally{await file.close();}
  const final=command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body:{type:'FinalizeStaging',stagingId,expectedSha256:expected}});await w.assetCommand(encode(final),auth);let source;
  for(let i=0;i<2000;i++){const done=await w.lookup(final.command.commandId);if(done){assert.equal(done.receipt.status,'accepted');source=(await w.events(String(BigInt(done.receipt.fromSeq)-1n))).events[0].payload.asset;break;}await new Promise(r=>setTimeout(r,5));}assert.ok(source);
  const asset=await registered(w,registration(source));assert.equal(asset.adapter.validation.profileId,'v4-fal-public-example-1');assert.equal(asset.adapter.validation.locallyEligible,true);assert.equal(asset.adapter.validation.runtimeVerified,false);assert.equal(asset.adapter.qualification,'structurally-valid');assert.equal(asset.adapter.config,null);
  const entry=await w.adapterView(asset.id);assert.equal(entry.locallyEligible,true);assert.equal(entry.runtimeVerified,false);
  const mock={asset:id=>id===asset.id?asset:null,adapterDeleted:()=>false},eligible=adapterEligibility(null,mock,[{version:asset.id,hash:asset.blob.hash}]).adapters.get(asset.id);assert.deepEqual(eligible,{hash:expected,available:true,profile:'v4-safe-1',runtimeVerified:false});
  await assert.rejects(w.assetVerify(asset.id),{code:'CONTENT_WITHHELD'});
});

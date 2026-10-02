import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {RequestReviews} from '../../dist/local/server/storage/request-review.js';
import {currentAdapterRuntimeAuthority} from '../../dist/local/server/storage/adapter-runtime.js';
import {StoreError} from '../../dist/local/server/storage/errors.js';
import {adapterDependencies, adapterVersion} from '../../dist/local/src/protocol/adapters.js';
import {newDraft, newV45Draft, resolve, bodyTemplate, estimate, routes} from '../../dist/local/src/request/family.js';
import {RequestError} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';

// These tests exercise the real review parser, dependencies, owner and assert
// boundary against retained SQLite records and exact saved object bytes. Only
// the 85MB known-artifact weights are a detached presence descriptor: a zero-byte
// presence read is supported, but their tensor bytes are not loaded or claimed
// verified. No runtime profile, wire proof or provider authority is fabricated.
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const knownWeights = {hash: 'sha256:bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5', byteLength: '85299896', mediaType: 'application/octet-stream'};
const issue = code => error => error instanceof RequestError && error.issues.some(value => value.code === code);

function reviewFixture(t, {family = 'adapters', acknowledgements = [true, true, true]} = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE saved_drafts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE ui_receipts (client_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(client_id,id));
    CREATE TABLE fixture_objects (hash TEXT PRIMARY KEY, body BLOB NOT NULL);`);
  db.prepare('INSERT INTO meta VALUES (?,?)').run('writerEpoch', '7');
  const auth = {clientId: 'client_review', sessionHash: 'a'.repeat(64), now: 0, expires: 100000};
  const document = {id: 'document_review', revision: '1', branchId: 'branch_review', width: 1024, height: 1024,
    color: 'sRGB', depth: 8, orderedLayerIds: [], historyHead: 'history_review', checkpoint: null, compositionVersion: null};
  db.prepare('INSERT INTO documents VALUES (?,?)').run(document.id, canonical(document));
  const put = (value, mediaType = 'application/json') => {
    const body = Buffer.from(value instanceof Uint8Array ? value : typeof value === 'string' ? value : canonical(value));
    const ref = {hash: sha(body), byteLength: String(body.byteLength), mediaType};
    db.prepare('INSERT OR IGNORE INTO fixture_objects VALUES (?,?)').run(ref.hash, body); return ref;
  };
  const read = ref => {
    const row = db.prepare('SELECT body FROM fixture_objects WHERE hash=?').get(ref.hash);
    if (!row) throw new StoreError('MISSING_OBJECT');
    const body = Buffer.from(row.body);
    if (sha(body) !== ref.hash || String(body.byteLength) !== ref.byteLength) throw new StoreError('CORRUPT_OBJECT');
    return body;
  };
  const stageWrites = [], presentWeights = [], stages = new Map(); let nextStage = 0;
  const objects = {
    get staging() {assert.fail('unsupported current profile must not open protected transport storage');},
    verify(ref, retain = false) {const body = read(ref); return retain ? body : undefined;},
    readRange(ref, offset, length) {
      if (ref.hash === knownWeights.hash) {
        assert.equal(canonical(ref), canonical(knownWeights)); assert.equal(offset, '0'); assert.equal(length, 0);
        presentWeights.push(ref.hash); return Buffer.alloc(0);
      }
      return read(ref).subarray(Number(offset), Number(offset) + length);
    },
    begin(byteLength, mediaType) {const id = 'stage_' + nextStage++; stageWrites.push(id); stages.set(id, {byteLength, mediaType, chunks: []}); return id;},
    chunk(id, body) {stages.get(id).chunks.push(Buffer.from(body));},
    finish(id) {const stage = stages.get(id), body = Buffer.concat(stage.chunks); assert.equal(String(body.byteLength), stage.byteLength); return put(body, stage.mediaType);},
    abort(id) {stages.delete(id);},
  };
  const insertAsset = asset => {db.prepare('INSERT INTO assets VALUES (?,?)').run(asset.id, canonical(asset)); return asset;};
  const assets = {asset(id) {const row = db.prepare('SELECT json FROM assets WHERE id=?').get(id); return row ? JSON.parse(row.json) : null;}, adapterDeleted() {return false;}};
  const promptText = 'Review exact runtime uncertainty, Café and 東京.';
  const prompt = put(promptText, 'text/plain'), draft = family === 'v45' ? newV45Draft(prompt) : newDraft(prompt);
  if (family === 'adapters') {
    draft.operation = 'generate-adapters';
    for (let index = 0; index < acknowledgements.length; index++) {
      const id = 'adapter_review_' + index, provenance = put({kind: 'detached-known-artifact-origin', id}), report = put({kind: 'detached-known-artifact-inspection', id});
      const adapter = {schemaVersion: 1, id, adapterId: 'logical_' + id, version: '1', name: 'Review fixture ' + index,
        weights: {...knownWeights}, config: null, origin: {kind: 'import', provenance, original: null},
        sources: {weightsAssetId: id, configAssetId: null, provenanceAssetId: null}, declaredFamily: 'ideogram-v4', declaredFormat: 'fal',
        qualification: 'structurally-valid', validation: {report, inspector: 'safetensors-inspection-1', reason: 'Detached local-artifact descriptor; no runtime observation.',
          profileId: 'v4-fal-public-example-1', locallyEligible: true, runtimeVerified: false,
          structure: {headerBytes: 8, dataBytes: 85299880, tensorCount: 1, dtypes: ['F16'], tensorSignature: 'sha256:7df49bdf7165de3986b1360a4f9510340fa7b96927405d339d751c83f937d9c6'}}};
      adapterVersion(adapter);
      insertAsset({id, version: '1', purpose: 'adapter', blob: adapter.weights, dependencies: adapterDependencies(adapter),
        safety: 'unknown', availability: 'available', qualification: 'adapter-version', measuredMediaType: 'application/octet-stream', adapter});
      draft.adapters.push({version: id, hash: knownWeights.hash, scale: ['0', '1.5', '4'][index],
        ...(acknowledgements[index] === undefined ? {} : {runtimeAcknowledged: acknowledgements[index]})});
    }
  }
  const draftBytes = Buffer.from(JSON.stringify(draft, null, 2));
  const draftAsset = insertAsset({id: 'draft_asset_review', version: '1', purpose: 'caption', blob: put(draftBytes, 'text/plain'), dependencies: [],
    safety: 'unknown', availability: 'available', qualification: 'opaque-text', measuredMediaType: 'text/plain'});
  const saved = {id: 'draft_review', generation: '1', kind: 'request', documentId: document.id, targetLayerId: null,
    expectedDocumentRevision: document.revision, assetId: draftAsset.id, composing: false, status: 'saved-unapplied'};
  db.prepare('INSERT INTO saved_drafts VALUES (?,?)').run(saved.id, canonical(saved));
  const reviews = new RequestReviews(db, objects, assets, () => ({layers: [], composition: null}), {});
  const loadSaved = () => JSON.parse(db.prepare('SELECT json FROM saved_drafts WHERE id=?').get(saved.id).json);
  const retain = review => {
    const prepared = {protocolVersion: 1, requestId: review.id, status: 'accepted', uiSeq: '1', reason: null, review};
    const accepted = {protocolVersion: 1, requestId: 'acceptance_review', status: 'accepted', uiSeq: '2', reason: null, acceptedReview: review.id};
    db.prepare('INSERT INTO ui_receipts VALUES (?,?,?)').run(auth.clientId, review.id, canonical(prepared));
    db.prepare('INSERT INTO ui_receipts VALUES (?,?,?)').run(auth.clientId, accepted.requestId, canonical(accepted));
    return review;
  };
  const currentReview = () => JSON.parse(db.prepare('SELECT json FROM ui_receipts WHERE client_id=? AND id=?').get(auth.clientId, 'review_retained').json).review;
  const snapshot = () => Object.fromEntries(['meta', 'documents', 'assets', 'saved_drafts', 'ui_receipts', 'fixture_objects'].map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()]));
  const unchanged = before => {
    assert.deepEqual(snapshot(), before, 'assertion must not mutate immutable imports, saved drafts, review or acceptance receipts');
    assert.deepEqual(read(draftAsset.blob), draftBytes); assert.deepEqual(reviews.draft(loadSaved()), draft);
  };
  function prepare() {return retain(reviews.prepare(loadSaved(), 'session_review', 'review_retained', auth));}
  function historicalReview() {
    // Represent a previously accepted, correctly bound snapshot whose required
    // runtime observation is now unavailable. No successful provider run or
    // present authority is created here. Current prepare() separately refuses
    // this same unacknowledged draft, as the regression below verifies.
    const acknowledged = structuredClone(draft); acknowledged.adapters.forEach(use => {use.runtimeAcknowledged = true;});
    const request = resolve(acknowledged, promptText, {adapters: new Map(acknowledged.adapters.map(use => [use.version,
      {hash: use.hash, available: true, profile: 'v4-safe-1', runtimeVerified: false}]))});
    request.adapters = structuredClone(draft.adapters);
    const route = routes[draft.operation];
    const value = {kind: 'request-review-1', id: 'review_retained', owner: reviews.owner(auth),
      draft: {sessionId: 'session_review', draftId: saved.id, generation: saved.generation}, draftAsset: saved.assetId,
      documentId: saved.documentId, documentRevision: saved.expectedDocumentRevision, request, endpoint: route.endpoint,
      schemaHash: route.schemaHash, routeHash: sha(canonical(route)), dependencyHash: reviews.dependencies(reviews.draft(loadSaved()), loadSaved()),
      template: put(bodyTemplate(request, promptText)), prompt, conversion: draft.conversion, inactive: draft.inactive,
      destination: draft.destination, privacy: draft.privacy, estimate: estimate(request), dispatch: false};
    return retain({...value, token: sha(canonical(value))});
  }
  return {db, auth, objects, reviews, draft, saved, draftAsset, prepare, historicalReview, currentReview, loadSaved,
    snapshot, unchanged, stageWrites, presentWeights, read,
    assertCurrent() {return RequestReviews.prototype.assert.call(reviews, currentReview(), loadSaved(), auth);}};
}

for (const [label, acknowledgements] of [
  ['all acknowledgements absent', [undefined, undefined, undefined]],
  ['one acknowledgement absent', [true, undefined, true]],
  ['explicit false acknowledgement', [true, false, true]],
]) test('retained acceptance requires renewed runtime review when ' + label, t => {
  assert.equal(currentAdapterRuntimeAuthority(), null);
  const f = reviewFixture(t, {acknowledgements}), review = f.historicalReview(), before = f.snapshot();
  assert.equal(f.currentReview().token, review.token);
  assert.throws(() => f.assertCurrent(), issue('ADAPTER_RUNTIME_EVIDENCE_CHANGED'));
  f.unchanged(before);
  assert(f.presentWeights.length > 0, 'local adapter dependencies were checked before runtime authority was rejected');
  assert.equal(f.stageWrites.length, 0, 'reassertion cannot silently regenerate a template');
});

test('fresh unacknowledged preparation still refuses before writing a new review template', t => {
  const f = reviewFixture(t, {acknowledgements: [undefined]}), before = f.snapshot();
  assert.throws(() => f.reviews.prepare(f.loadSaved(), 'session_review', 'review_retained', f.auth), issue('ADAPTER_RUNTIME_ACK_REQUIRED'));
  assert.equal(f.stageWrites.length, 0); f.unchanged(before);
});

test('explicit acknowledgement permits real preparation and reassertion without runtime authority', t => {
  assert.equal(currentAdapterRuntimeAuthority(), null);
  const f = reviewFixture(t), review = f.prepare(), before = f.snapshot(), writes = f.stageWrites.length;
  assert.equal(review.kind, 'request-review-1'); assert.equal(review.endpoint, 'ideogram/v4/lora');
  assert(review.request.adapters.every(use => use.runtimeAcknowledged === true));
  assert.doesNotThrow(() => f.assertCurrent()); assert.doesNotThrow(() => f.assertCurrent());
  f.unchanged(before); assert.equal(f.stageWrites.length, writes);
  assert.equal(f.currentReview().dispatch, false);
});

for (const family of ['plain', 'v45']) test(family + ' review preparation and assertion remain independent of adapter runtime authority', t => {
  assert.equal(currentAdapterRuntimeAuthority(), null);
  const f = reviewFixture(t, {family}), review = f.prepare(), before = f.snapshot();
  assert.equal(review.kind, family === 'v45' ? 'request-review-v45-1' : 'request-review-1');
  assert.equal(review.endpoint, family === 'v45' ? 'ideogram/v4.5' : 'ideogram/v4');
  assert.equal('adapters' in review.request, false);
  if (family === 'v45') {
    assert.equal(review.providerReview.admission.state, 'blocked');
    assert.equal(review.providerReview.privacyProfile, null);
  }
  assert.doesNotThrow(() => f.assertCurrent()); f.unchanged(before); assert.deepEqual(f.presentWeights, []);
});

test('explicit runtime acknowledgement preserves owner, draft, dependency and immutable template checks', t => {
  const f = reviewFixture(t), review = f.prepare(), before = f.snapshot();
  const alteredOwner = {...f.auth, sessionHash: 'b'.repeat(64)};
  assert.throws(() => f.reviews.assert(f.currentReview(), f.loadSaved(), alteredOwner), issue('STALE_REVIEW'));
  assert.throws(() => f.reviews.assert(f.currentReview(), {...f.loadSaved(), generation: '2'}, f.auth), issue('STALE_REVIEW'));
  assert.throws(() => f.reviews.assert(f.currentReview(), {...f.loadSaved(), composing: true}, f.auth), issue('STALE_REVIEW'));
  const wrongDependency = structuredClone(review); wrongDependency.dependencyHash = sha('changed dependency');
  assert.throws(() => f.reviews.assert(wrongDependency, f.loadSaved(), f.auth), issue('STALE_REVIEW'));
  const badToken = structuredClone(review); badToken.token = sha('changed token');
  assert.throws(() => f.reviews.assert(badToken, f.loadSaved(), f.auth), error => error instanceof StoreError && error.code === 'MALFORMED_REQUEST');
  f.unchanged(before);
  const unavailableTemplate = {...review, template: {hash: sha('missing template'), byteLength: '16', mediaType: 'application/json'}};
  const {token: _, ...binding} = unavailableTemplate; unavailableTemplate.token = sha(canonical(binding));
  assert.throws(() => f.reviews.assert(unavailableTemplate, f.loadSaved(), f.auth), error => error instanceof StoreError && error.code === 'MISSING_OBJECT');
  f.unchanged(before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {deriveAdapterRuntimeEvidence, currentAdapterRuntimeAuthority, currentAdapterRuntimeProfile,
  AdapterRuntimeEvidenceReader, RUNTIME_EVIDENCE_LIMIT, RUNTIME_ATTEMPT_SCAN_LIMIT} from '../../dist/local/server/storage/adapter-runtime.js';
import {Adapters} from '../../dist/local/server/storage/adapters.js';
import {adapterDependencies, adapterVersion, adapterRuntimeEvidence} from '../../dist/local/src/protocol/adapters.js';
import {newDraft, resolve, routes, bodyTemplate, estimate} from '../../dist/local/src/request/core.js';
import {materializeTransportTemplate} from '../../dist/local/server/storage/queue-transport.js';
import {canonical} from '../../dist/local/src/protocol/json.js';

// DETACHED CONTRACT FIXTURE ONLY. These invented authority/transport records are
// inputs to the pure comparison; they neither mint production wire proof nor
// install a LoRA provider profile. Known artifact descriptors below are reused
// to satisfy local immutable-version validation, without loading their 85MB
// bytes. available() is explicitly synthetic. No provider request occurs and no
// test result here qualifies the real artifact or shipped provider for runtime.
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(value instanceof Uint8Array ? value : typeof value === 'string' ? value : canonical(value));
const blob = (value, mediaType = 'application/json') => {
  const body = bytes(value); return {hash: sha(body), byteLength: String(body.byteLength), mediaType};
};
const knownWeights = {hash: 'sha256:bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5', byteLength: '85299896', mediaType: 'application/octet-stream'};
const tensorSignature = 'sha256:7df49bdf7165de3986b1360a4f9510340fa7b96927405d339d751c83f937d9c6';
const uuid = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');

function versionAsset(id) {
  const provenance = blob({kind: 'synthetic-contract-provenance', id});
  const report = blob({kind: 'synthetic-contract-inspection', id});
  const adapter = {schemaVersion: 1, id, adapterId: 'logical_' + id, version: '1', name: 'Contract adapter ' + id,
    weights: {...knownWeights}, config: null, origin: {kind: 'import', provenance, original: null},
    sources: {weightsAssetId: id, configAssetId: null, provenanceAssetId: null},
    declaredFamily: 'ideogram-v4', declaredFormat: 'fal', qualification: 'structurally-valid',
    validation: {report, inspector: 'safetensors-inspection-1', reason: 'Detached contract fixture; no runtime qualification.',
      profileId: 'v4-fal-public-example-1', locallyEligible: true, runtimeVerified: false,
      structure: {headerBytes: 8, dataBytes: 85299880, tensorCount: 1, dtypes: ['F16'], tensorSignature}}};
  adapterVersion(adapter);
  return {id, version: '1', purpose: 'adapter', blob: adapter.weights, dependencies: adapterDependencies(adapter),
    safety: 'unknown', availability: 'available', qualification: 'adapter-version', measuredMediaType: 'application/octet-stream', adapter};
}

function fixture({operation = 'generate-adapters', count = 3} = {}) {
  const prompt = 'Detached contract: preserve literal "loras", Café and 東京.';
  const promptRef = blob(prompt, 'text/plain'), draft = newDraft(promptRef);
  const versions = new Map(Array.from({length: count}, (_, index) => {
    const asset = versionAsset('version_' + index); return [asset.id, asset];
  }));
  draft.operation = operation;
  draft.fields.seed = '9007199254740993';
  draft.adapters = [...versions.values()].map((asset, index) => ({version: asset.id, hash: asset.blob.hash,
    scale: ['0', '1.50', '4'][index], runtimeAcknowledged: true}));
  if (operation === 'transform-adapters') {
    draft.source = {assetId: 'source_asset', version: '1', blob: blob('synthetic source bytes', 'image/png'),
      pixels: blob('synthetic source pixels', 'application/octet-stream'), width: 1024, height: 1024,
      scope: 'asset', documentRevision: '1'};
    draft.fields.size = 'auto'; draft.fields.strength = '0.5';
  }
  const request = resolve(draft, prompt, {adapters: new Map(draft.adapters.map(use => [use.version,
    {hash: use.hash, available: true, profile: 'v4-safe-1', runtimeVerified: false}]))});
  const route = routes[request.kind];
  const authority = {profile: {id: 'detached_contract_only', version: 1, evidenceDigest: 'e'.repeat(64), endpoint: route.endpoint},
    queueOrigin: 'https://queue.contract.example', mediaOrigins: ['https://media.contract.example'], uploadOrigins: ['https://upload.contract.example']};
  const stagePlan = [...('source' in request ? [{role: 'source', original: request.source.blob,
    transport: blob('synthetic exact source transport', 'image/png'), width: 1024, height: 1024, conversion: null}] : []),
    ...request.adapters.map((use, index) => ({role: 'adapter:' + index, versionId: use.version,
      original: structuredClone(knownWeights), transport: structuredClone(knownWeights)}))];
  const mapping = Object.fromEntries(stagePlan.map((stage, index) => [stage.role, authority.mediaOrigins[0] + '/staged/' + index]));
  const template = bodyTemplate(request, prompt), transmitted = materializeTransportTemplate(template, request, stagePlan, mapping);
  const reviewValue = {kind: 'request-review-1', id: 'review_contract', owner: 'client_contract',
    draft: {sessionId: 'session_contract', draftId: 'draft_contract', generation: '1'}, draftAsset: 'draft_asset', documentId: 'document_contract', documentRevision: '1',
    request, endpoint: route.endpoint, schemaHash: route.schemaHash, routeHash: sha(canonical(route)),
    dependencyHash: sha(canonical([promptRef, ...stagePlan.map(stage => stage.original)])),
    template: blob(template), prompt: promptRef, conversion: null, inactive: {}, destination: 'retained-candidates',
    privacy: 'minimum-retention-unqualified', estimate: estimate(request), dispatch: false};
  const review = {...reviewValue, token: sha(canonical(reviewValue))};
  const attemptId = uuid(1), jobId = 'job_contract', requestId = 'request_contract', payloadHash = sha(transmitted);
  const approval = {id: 'approval_contract', configurationId: 'configuration_contract', configurationHash: sha('configuration').slice(7),
    epoch: '1', jobId, attemptId, reviewToken: review.token, profileId: authority.profile.id, profileVersion: authority.profile.version,
    disclosureDigest: sha('disclosure').slice(7), authorizedAt: '2026-10-01T00:00:00.000Z'};
  const attempt = {id: attemptId, previousAttemptId: null, version: '3', state: 'provider-terminal', hold: false, override: false,
    spendSessionId: 'spend_contract', count: 'dispatched', writerEpoch: '1', payloadHash, requestId, terminal: 'completed',
    uncertainReason: null, actualCharge: null, estimate: review.estimate, providerAuthorization: approval};
  const job = {id: jobId, version: '3', documentId: review.documentId, review, stagePlan, local: 'ready-to-dispatch',
    resultImport: 'none', disposition: 'eligible', attempts: [attempt]};
  const policy = {profileId: authority.profile.id, profileVersion: authority.profile.version, evidenceDigest: authority.profile.evidenceDigest,
    requestedStoreIO: '0', requestedAccess: 'most-private-compatible', appliedLifecycleSeconds: null, appliedACL: null,
    enforcement: 'unknown', fallbackAcknowledgementId: approval.id};
  const records = new Map(); let nextRecord = 10;
  function wire(role, direction, url, body, descriptor = null, requestRef = null) {
    const encodedBody = body === null ? undefined : bytes(body), identity = descriptor ?? blob(encodedBody ?? Buffer.alloc(0));
    const recordId = uuid(nextRecord++), parsed = new URL(url);
    const requestRecordId = direction === 'request' ? recordId : requestRef?.recordId ?? null;
    const requestSha256 = direction === 'request' ? identity.hash : requestRef?.bodyHash ?? null;
    const metadata = {class: 'backend-transport', recordId, attemptId, direction, sha256: identity.hash.slice(7),
      receivedBytes: identity.byteLength, retainedBytes: identity.byteLength, identity: null, completeness: 'complete',
      access: 'backend-only', export: 'never', headers: {}, policy: {...policy},
      wireExecution: {kind: 'provider-wire-provenance-1', boundary: 'sealed-fal-production-1', role,
        method: ['submit', 'upload'].includes(role) ? 'POST' : 'GET', origin: parsed.origin, pathname: parsed.pathname,
        urlHash: sha(url), httpStatus: 200, attemptId, direction, recordId, completed: true, requestRecordId, requestSha256},
      wireBodyIdentity: {kind: 'provider-wire-body-identity-1', dev: '1', ino: String(nextRecord), size: identity.byteLength, mtimeNs: '1', ctimeNs: '1'}};
    const ref = {recordId, bodyHash: identity.hash, metadataHash: sha(canonical(metadata))};
    records.set(recordId, {metadata, ...(encodedBody ? {body: encodedBody} : {})});
    return ref;
  }
  const uploads = stagePlan.map((stage, index) => {
    const url = authority.uploadOrigins[0] + '/upload/' + index;
    const input = wire('upload', 'request', url, null, stage.transport);
    const response = wire('upload', 'response', url, {url: mapping[stage.role]}, null, input);
    return {stage: structuredClone(stage), url: mapping[stage.role], request: input, response};
  });
  const base = authority.queueOrigin + '/' + route.endpoint;
  const urls = {status: base + '/requests/' + requestId + '/status', result: base + '/requests/' + requestId + '/response',
    cancel: base + '/requests/' + requestId + '/cancel'};
  const submitted = wire('submit', 'request', base, transmitted);
  const acknowledged = wire('submit', 'response', base, {request_id: requestId, status_url: urls.status,
    response_url: urls.result, cancel_url: urls.cancel}, null, submitted);
  const status = wire('status', 'response', urls.status, {request_id: requestId, status: 'COMPLETED'});
  const outputURL = authority.mediaOrigins[0] + '/output.png';
  const encodedBytes = Buffer.from('synthetic encoded image, not decodable or production-qualified');
  const encoded = {id: 'encoded_output', version: '1', purpose: 'image', blob: blob(encodedBytes, 'image/png'),
    dependencies: [], safety: 'safe', availability: 'available', qualification: 'pending-decoder', measuredMediaType: 'image/png'};
  const pixels = blob('synthetic prepared pixels', 'application/octet-stream');
  const manifest = blob({kind: 'synthetic prepared manifest', pixels});
  const prepared = {id: 'prepared_output', version: '1', purpose: 'image', blob: manifest, dependencies: [pixels, encoded.blob],
    safety: 'safe', availability: 'available', qualification: 'canonical-raster', measuredMediaType: 'image/png',
    raster: {schemaVersion: 1, pipeline: 'contract-only', width: 1024, height: 1024, manifest, pixels,
      pixelIdentity: sha('prepared pixel identity'), role: 'native', sourceAssetIds: [encoded.id], conversion: null}};
  const image = {url: outputURL, content_type: 'image/png', file_size: Number(encoded.blob.byteLength), width: 1024, height: 1024};
  const result = wire('result', 'response', urls.result, {request_id: requestId, images: [image], has_nsfw_concepts: [false]});
  const media = wire('media', 'response', outputURL, encodedBytes, encoded.blob);
  const binding = {reviewToken: review.token, stagePlanHash: sha(canonical(stagePlan)), mappingHash: sha(canonical(mapping)), payloadHash};
  const outbox = {endpoint: route.endpoint, requestId, payloadHash, state: 'terminal', urls, mapping, responseRecord: acknowledged.recordId,
    wireEvidence: {kind: 'queue-wire-evidence-1', conflicted: false, uploads, dispatch: {...binding},
      submission: {...binding, body: submitted, response: acknowledged}}};
  const outputIdentity = sha(canonical([requestId, 0, image]));
  const candidate = {id: 'c_' + sha(canonical([attemptId, 0, outputIdentity])).slice(7), version: '2', documentId: review.documentId, jobId, attemptId, requestId,
    outputIndex: 0, outputIdentity, safety: 'safe', state: 'prepared', hidden: false,
    encodedAssetId: encoded.id, preparedAssetId: prepared.id, warning: null};
  const retained = {jobId, attemptId, documentId: review.documentId, requestedCount: 1, actualCount: 1,
    observation: {phase: 'completed', nextPollAt: 0, failures: 0, mode: 'healthy', digest: status.bodyHash.slice(7),
      resultDigest: result.bodyHash.slice(7), warning: null},
    provenance: {requestedPrompt: promptRef, submittedPrompt: promptRef, returnedPrompt: null, returnedBytes: '0', complete: true,
      quarantined: false, inspection: 'supported', warning: null, requestedSeed: draft.fields.seed, returnedSeed: null,
      timings: {}, timingUnits: 'unknown', sourceBodyHash: result.bodyHash, privacyPolicy: blob(policy)},
    wireEvidence: {kind: 'candidate-wire-evidence-1', overflow: false, contradictions: [], status, result}};
  const privateSlot = {url: outputURL, expectedBytes: Number(encoded.blob.byteLength), mime: 'image/png', width: 1024, height: 1024,
    mediaRecord: media.recordId, mediaEvidence: media, retryRequested: false,
    outputEvidence: {kind: 'candidate-output-wire-1', result: structuredClone(result), index: 0, image: structuredClone(image), safe: true}};
  const unavailable = new Set();
  const facts = {job, attemptId, retained, outbox, candidate, privateSlot, versions, encoded, prepared,
    wire: reference => records.get(reference.recordId) ?? null, available: reference => !unavailable.has(reference.hash)};
  const metadata = reference => records.get(reference.recordId).metadata;
  const reseal = reference => {reference.metadataHash = sha(canonical(metadata(reference)));};
  const changeMetadata = (reference, change, seal = true) => {change(metadata(reference)); if (seal) reseal(reference);};
  const changeControl = (reference, value) => {
    const snapshot = records.get(reference.recordId); snapshot.body = bytes(value);
    reference.bodyHash = sha(snapshot.body); snapshot.metadata.sha256 = reference.bodyHash.slice(7);
    snapshot.metadata.receivedBytes = snapshot.metadata.retainedBytes = String(snapshot.body.byteLength);
    snapshot.metadata.wireBodyIdentity.size = String(snapshot.body.byteLength); reseal(reference);
  };
  const rehashReview = (alsoApproval = false) => {
    const {token: _, ...value} = review; review.token = sha(canonical(value));
    if (alsoApproval) approval.reviewToken = review.token;
  };
  return {facts, authority, attempt, approval, request, review, uploads, submitted, acknowledged, status, result, media,
    mapping, records, unavailable, transmitted, metadata, reseal, changeMetadata, changeControl, rehashReview};
}

const derive = fixture => deriveAdapterRuntimeEvidence(fixture.facts, fixture.authority);
const firstAsset = fixture => fixture.facts.versions.get('version_0');

test('detached coherent facts yield one scoped observation without changing immutable imports', () => {
  const f = fixture(), before = canonical([...f.facts.versions]);
  const evidence = derive(f);
  assert(evidence, 'synthetic contract should be internally coherent');
  assert(adapterRuntimeEvidence(evidence));
  assert.deepEqual(evidence.scope.adapters, [0, 1, 2].map((index) => ({version: 'version_' + index,
    weightsHash: knownWeights.hash, configHash: null, scale: [0, 1.5, 4][index]})));
  assert.deepEqual(evidence.scope.profile, f.authority.profile);
  assert.equal(evidence.outputAssetId, f.facts.prepared.id);
  assert.equal(evidence.outputHash, f.facts.prepared.blob.hash);
  assert.deepEqual(derive(f), evidence, 'observation identity is deterministic');
  assert.equal(canonical([...f.facts.versions]), before);
  assert.equal(firstAsset(f).adapter.validation.runtimeVerified, false);
  assert.equal(firstAsset(f).adapter.qualification, 'structurally-valid');
  const publicJSON = canonical(evidence);
  for (const secret of [f.authority.queueOrigin, f.authority.mediaOrigins[0], f.authority.uploadOrigins[0],
    f.submitted.recordId, f.acknowledged.recordId, f.status.recordId, f.result.recordId, f.media.recordId]) {
    assert(!publicJSON.includes(secret), 'public observation must not expose protected URLs or record ids');
  }
  assert.match(f.transmitted, /"seed":9007199254740993/);
});

test('one-member and source-plus-three-member detached stacks derive their exact endpoint and mapping', () => {
  const single = fixture({count: 1}), transform = fixture({operation: 'transform-adapters'});
  assert.equal(derive(single).scope.adapters.length, 1);
  const evidence = derive(transform);
  assert(evidence);
  assert.equal(evidence.scope.endpoint, 'ideogram/v4/image-to-image/lora');
  assert.equal(transform.uploads.length, 4);
  assert.equal(transform.uploads[0].stage.role, 'source');
  assert.notEqual(transform.uploads[0].stage.original.hash, transform.uploads[0].stage.transport.hash);
  assert.equal(JSON.parse(transform.transmitted).image_url, transform.mapping.source);
});

const scopeFailures = [
  ['changed scale under old review', f => {f.request.adapters[1].scale = '2';}],
  ['changed scale under recomputed review and approval but old dispatch', f => {f.request.adapters[1].scale = '2'; f.rehashReview(true);}],
  ['reordered equal-weight immutable versions', f => {f.request.adapters.reverse();}],
  ['smaller stack cannot borrow a prior whole-stack run', f => {f.request.adapters.pop();}],
  ['empty stack', f => {f.request.adapters = []; f.rehashReview(true);}],
  ['four-member stack', f => {f.request.adapters.push({...f.request.adapters[0], version: 'extra'}); f.rehashReview(true);}],
  ['different immutable version with identical bytes', f => {f.request.adapters[0].version = 'replacement';}],
  ['missing immutable version', f => {f.facts.versions.delete('version_0');}],
  ['wrong version identity in its retained asset', f => {firstAsset(f).adapter.id = 'replacement';}],
  ['replaced weights', f => {firstAsset(f).blob = blob('replacement', 'application/octet-stream');}],
  ['changed config invalidates exact supported artifact profile', f => {
    const asset = firstAsset(f); asset.adapter.config = blob({rank: 4}); asset.adapter.sources.configAssetId = 'new_config';
    asset.dependencies = adapterDependencies(asset.adapter);
  }],
  ['forged local profile id', f => {firstAsset(f).adapter.validation.profileId = 'imported_claim';}],
  ['noneligible retained version', f => {const a = firstAsset(f).adapter; a.validation.locallyEligible = false; a.validation.profileId = null;}],
  ['immutable import runtime flag is not authority', f => {firstAsset(f).adapter.validation.runtimeVerified = true;}],
  ['immutable qualification cannot be rewritten to runtime-verified', f => {firstAsset(f).adapter.qualification = 'runtime-verified';}],
  ['wrong adapter dependency closure', f => {firstAsset(f).dependencies = [];}],
  ['different endpoint', f => {f.authority.profile.endpoint = 'ideogram/v4/inpaint/lora';}],
  ['different provider profile id', f => {f.authority.profile.id = 'other_profile';}],
  ['different provider profile version', f => {f.authority.profile.version++;}],
  ['different provider evidence digest', f => {f.authority.profile.evidenceDigest = 'f'.repeat(64);}],
  ['changed schema under recomputed review', f => {f.review.schemaHash = sha('other schema'); f.rehashReview(true);}],
  ['changed route hash under recomputed review', f => {f.review.routeHash = sha('other route'); f.rehashReview(true);}],
  ['changed review token', f => {f.review.token = sha('unrelated review');}],
  ['old dispatch review token', f => {f.facts.outbox.wireEvidence.dispatch.reviewToken = sha('old review');}],
  ['old submission review token', f => {f.facts.outbox.wireEvidence.submission.reviewToken = sha('old review');}],
];
for (const [name, mutate] of scopeFailures) test('runtime scope refuses ' + name, () => {
  const f = fixture(); mutate(f); assert.equal(derive(f), null);
});

const lifecycleFailures = [
  ['partial provenance', f => {f.facts.retained.provenance.complete = false;}],
  ['failed attempt', f => {f.attempt.terminal = 'failed';}],
  ['uncertain submission', f => {f.attempt.state = 'submission-uncertain';}],
  ['latched uncertainty', f => {f.attempt.uncertainReason = 'ACKNOWLEDGEMENT_UNCERTAIN';}],
  ['quarantined result', f => {f.facts.retained.provenance.quarantined = true;}],
  ['noncompleted observation', f => {f.facts.retained.observation.phase = 'running';}],
  ['deleted job', f => {f.facts.job.disposition = 'deleted';}],
  ['inert imported history', f => {f.facts.retained.inert = true;}],
  ['missing approval', f => {delete f.attempt.providerAuthorization;}],
  ['approval from another job', f => {f.approval.jobId = 'other_job';}],
  ['approval from another attempt', f => {f.approval.attemptId = uuid(2);}],
  ['approval for another review', f => {f.approval.reviewToken = sha('other review');}],
  ['retained document mismatch', f => {f.facts.retained.documentId = 'other_document';}],
  ['retained attempt mismatch', f => {f.facts.retained.attemptId = uuid(2);}],
  ['missing protected candidate references', f => {delete f.facts.retained.wireEvidence;}],
  ['contradictory observations', f => {f.facts.retained.wireEvidence.contradictions.push('request identity changed');}],
  ['observation overflow', f => {f.facts.retained.wireEvidence.overflow = true;}],
  ['conflicting outbox evidence', f => {f.facts.outbox.wireEvidence.conflicted = true;}],
  ['nonterminal outbox', f => {f.facts.outbox.state = 'acknowledged';}],
  ['missing weights object', f => {f.unavailable.add(knownWeights.hash);}],
  ['missing adapter provenance object', f => {f.unavailable.add(firstAsset(f).adapter.origin.provenance.hash);}],
  ['missing inspection object', f => {f.unavailable.add(firstAsset(f).adapter.validation.report.hash);}],
  ['unavailable immutable asset', f => {firstAsset(f).availability = 'missing';}],
  ['corrupt immutable asset', f => {firstAsset(f).availability = 'corrupt';}],
];
for (const [name, mutate] of lifecycleFailures) test('runtime lifecycle refuses ' + name, () => {
  const f = fixture(); mutate(f); assert.equal(derive(f), null);
});

const proofFailures = [
  ['fixture execution boundary', m => {m.wireExecution.boundary = 'loopback-fixture-1';}],
  ['legacy record without wire execution', m => {delete m.wireExecution;}],
  ['legacy record without body identity', m => {delete m.wireBodyIdentity;}],
  ['malformed body identity', m => {m.wireBodyIdentity = {};}],
  ['extra body identity field', m => {m.wireBodyIdentity.imported = true;}],
  ['body identity with wrong size', m => {m.wireBodyIdentity.size = '1';}],
  ['body identity with noncanonical timestamp', m => {m.wireBodyIdentity.mtimeNs = '-1';}],
  ['uncompleted wire proof', m => {m.wireExecution.completed = false;}],
  ['partial protected body', m => {m.completeness = 'partial';}],
  ['truncated protected body', m => {m.retainedBytes = '1';}],
  ['different attempt in protected record', m => {m.attemptId = uuid(2);}],
  ['different attempt in wire proof', m => {m.wireExecution.attemptId = uuid(2);}],
  ['different record in wire proof', m => {m.wireExecution.recordId = uuid(999);}],
  ['different wire role', m => {m.wireExecution.role = 'result';}],
  ['different wire method', m => {m.wireExecution.method = 'PUT';}],
  ['different wire origin', m => {m.wireExecution.origin = 'https://forged.example';}],
  ['different wire path', m => {m.wireExecution.pathname = '/other';}],
  ['different exact URL hash', m => {m.wireExecution.urlHash = sha('other url');}],
  ['redirect instead of successful transport', m => {m.wireExecution.httpStatus = 302;}],
  ['failed wire response', m => {m.wireExecution.httpStatus = 503;}],
  ['noninteger wire status', m => {m.wireExecution.httpStatus = 200.5;}],
  ['public protected-body access', m => {m.access = 'public';}],
  ['exportable protected-body record', m => {m.export = 'allowed';}],
  ['wrong profile policy', m => {m.policy.profileId = 'other_profile';}],
  ['wrong profile version policy', m => {m.policy.profileVersion++;}],
  ['wrong profile evidence digest policy', m => {m.policy.evidenceDigest = 'f'.repeat(64);}],
  ['wrong authorization policy', m => {m.policy.fallbackAcknowledgementId = 'other_approval';}],
];
for (const [name, mutate] of proofFailures) test('protected runtime proof refuses ' + name, () => {
  const f = fixture(); f.changeMetadata(f.status, mutate); assert.equal(derive(f), null);
});

test('all required protected references must exist and match their retained metadata identities', () => {
  const selectors = [f => f.uploads[0].request, f => f.uploads[0].response, f => f.submitted,
    f => f.acknowledged, f => f.status, f => f.result, f => f.media];
  for (const select of selectors) {
    const missing = fixture(); missing.records.delete(select(missing).recordId); assert.equal(derive(missing), null);
    const changed = fixture(); changed.changeMetadata(select(changed), m => {m.headers['content-type'] = 'image/jpeg';}, false);
    assert.equal(derive(changed), null, 'canonical metadata hash must detect changed retained metadata');
    const wrongBody = fixture(); select(wrongBody).bodyHash = sha('different bytes'); assert.equal(derive(wrongBody), null);
    const extra = fixture(); select(extra).imported = true; assert.equal(derive(extra), null, 'wire references have exact fields');
  }
});

test('bounded control records require their actual exact bytes, including valid JSON and identity semantics', () => {
  for (const select of [f => f.uploads[0].response, f => f.acknowledged, f => f.status]) {
    const missing = fixture(); delete missing.records.get(select(missing).recordId).body; assert.equal(derive(missing), null);
    const changed = fixture(); changed.records.get(select(changed).recordId).body = bytes({forged: true}); assert.equal(derive(changed), null);
    for (const malformed of ['{', '[]', '{"request_id":"request_contract","request_id":"other"}', ' '.repeat(65537)]) {
      const f = fixture(); f.changeControl(select(f), malformed); assert.equal(derive(f), null);
    }
  }
  for (const control of [{request_id: 'other', status: 'COMPLETED'}, {request_id: 'request_contract', status: 'IN_PROGRESS'},
    {request_id: 'request_contract', status: 'COMPLETED', error: 'failed'}, {request_id: 'request_contract', status: 'COMPLETED', error_type: 'invalid'}]) {
    const f = fixture(); f.changeControl(f.status, control); assert.equal(derive(f), null);
  }
});

const transportFailures = [
  ['changed ordered upload list', f => {f.uploads.reverse();}],
  ['missing adapter upload', f => {f.uploads.pop();}],
  ['extra adapter upload', f => {f.uploads.push(structuredClone(f.uploads[0]));}],
  ['wrong immutable upload version', f => {f.uploads[0].stage.versionId = 'other_version';}],
  ['edited upload weights', f => {f.uploads[0].stage.transport = blob('other weights', 'application/octet-stream');}],
  ['changed role mapping', f => {f.mapping['adapter:0'] = f.mapping['adapter:1'];}],
  ['extra role mapping', f => {f.mapping.unreviewed = 'https://media.contract.example/extra';}],
  ['missing role mapping', f => {delete f.mapping['adapter:1'];}],
  ['changed dispatch payload hash', f => {f.facts.outbox.wireEvidence.dispatch.payloadHash = sha('other payload');}],
  ['changed dispatch stage hash', f => {f.facts.outbox.wireEvidence.dispatch.stagePlanHash = sha('other stages');}],
  ['changed dispatch mapping hash', f => {f.facts.outbox.wireEvidence.dispatch.mappingHash = sha('other mapping');}],
  ['changed submission binding', f => {f.facts.outbox.wireEvidence.submission.payloadHash = sha('other payload');}],
  ['different queue request id', f => {f.facts.outbox.requestId = 'other_request';}],
  ['different queue status URL', f => {f.facts.outbox.urls.status += '/other';}],
  ['different queue result URL', f => {f.facts.outbox.urls.result += '/other';}],
  ['different queue cancellation URL', f => {f.facts.outbox.urls.cancel += '/other';}],
  ['unapproved upload host', f => {f.authority.uploadOrigins = [];}],
  ['unapproved uploaded media host', f => {f.authority.mediaOrigins = [];}],
  ['wrong upload response URL', f => {f.changeControl(f.uploads[0].response, {url: 'https://media.contract.example/other'});}],
  ['wrong upload request pairing', f => {f.changeMetadata(f.uploads[0].response, m => {m.wireExecution.requestRecordId = f.uploads[1].request.recordId;});}],
  ['wrong upload request hash', f => {f.changeMetadata(f.uploads[0].response, m => {m.wireExecution.requestSha256 = sha('other body');});}],
  ['wrong upload request self hash', f => {f.changeMetadata(f.uploads[0].request, m => {m.wireExecution.requestSha256 = sha('other body');});}],
  ['upload request and response status mismatch', f => {f.changeMetadata(f.uploads[0].request, m => {m.wireExecution.httpStatus = 201;});}],
  ['bare upload request hash instead of exact hash identifier', f => {f.changeMetadata(f.uploads[0].response, m => {m.wireExecution.requestSha256 = f.uploads[0].request.bodyHash.slice(7);});}],
  ['wrong acknowledged request pairing', f => {f.changeMetadata(f.acknowledged, m => {m.wireExecution.requestRecordId = f.uploads[0].request.recordId;});}],
  ['wrong acknowledged request hash', f => {f.changeMetadata(f.acknowledged, m => {m.wireExecution.requestSha256 = sha('other body');});}],
  ['wrong submission request self hash', f => {f.changeMetadata(f.submitted, m => {m.wireExecution.requestSha256 = sha('other body');});}],
  ['submission request and response status mismatch', f => {f.changeMetadata(f.submitted, m => {m.wireExecution.httpStatus = 201;});}],
  ['bare acknowledged request hash instead of exact hash identifier', f => {f.changeMetadata(f.acknowledged, m => {m.wireExecution.requestSha256 = f.submitted.bodyHash.slice(7);});}],
  ['wrong result provenance hash', f => {f.facts.retained.provenance.sourceBodyHash = sha('other result');}],
  ['wrong observed result digest', f => {f.facts.retained.observation.resultDigest = 'f'.repeat(64);}],
];
for (const [name, mutate] of transportFailures) test('runtime transport refuses ' + name, () => {
  const f = fixture(); mutate(f); assert.equal(derive(f), null);
});

test('acknowledgement must preserve the exact provider request identity and all returned queue URLs', () => {
  for (const field of ['request_id', 'status_url', 'response_url', 'cancel_url']) {
    const f = fixture(), body = JSON.parse(Buffer.from(f.records.get(f.acknowledged.recordId).body).toString());
    body[field] += '_other'; f.changeControl(f.acknowledged, body); assert.equal(derive(f), null, field);
  }
});

test('source uploads retain the exact staged transform descriptor and returned mapping', () => {
  for (const mutate of [
    f => {f.uploads[0].stage.original = blob('other original', 'image/png');},
    f => {f.uploads[0].stage.transport = blob('other transport', 'image/png');},
    f => {f.uploads[0].stage.width = 2048;},
    f => {f.uploads[0].url = f.mapping['adapter:0'];},
    f => {f.changeMetadata(f.uploads[0].request, m => {m.retainedBytes = m.receivedBytes = '1';});},
    f => {f.changeControl(f.uploads[0].response, {url: f.mapping['adapter:0']});},
  ]) {const f = fixture({operation: 'transform-adapters'}); mutate(f); assert.equal(derive(f), null);}
});

const candidateFailures = [
  ['received candidate without prepared output', f => {f.facts.candidate.state = 'received';}],
  ['failed media transfer', f => {f.facts.candidate.state = 'transfer-failed';}],
  ['failed preparation', f => {f.facts.candidate.state = 'preparation-failed';}],
  ['unknown candidate safety', f => {f.facts.candidate.safety = 'unknown';}],
  ['withheld candidate', f => {f.facts.candidate.safety = 'withheld';}],
  ['candidate warning', f => {f.facts.candidate.warning = 'MISSING_BYTES';}],
  ['candidate from another request', f => {f.facts.candidate.requestId = 'other_request';}],
  ['candidate from another job', f => {f.facts.candidate.jobId = 'other_job';}],
  ['candidate from another attempt', f => {f.facts.candidate.attemptId = uuid(2);}],
  ['candidate from another document', f => {f.facts.candidate.documentId = 'other_document';}],
  ['missing result output binding', f => {delete f.facts.privateSlot.outputEvidence;}],
  ['output binding from a different result record', f => {f.facts.privateSlot.outputEvidence.result.recordId = uuid(999);}],
  ['output binding with a different result hash', f => {f.facts.privateSlot.outputEvidence.result.bodyHash = sha('other result');}],
  ['unsafe result output binding', f => {f.facts.privateSlot.outputEvidence.safe = false;}],
  ['result output binding at the wrong index', f => {f.facts.privateSlot.outputEvidence.index = 1;}],
  ['candidate at the wrong index', f => {f.facts.candidate.outputIndex = 1;}],
  ['out-of-bounds observed output count', f => {f.facts.retained.actualCount = 5;}],
  ['fractional observed output count', f => {f.facts.retained.actualCount = 1.5;}],
  ['string observed output count', f => {f.facts.retained.actualCount = '1';}],
  ['missing observed output count', f => {f.facts.retained.actualCount = null;}],
  ['result output image with wrong URL', f => {f.facts.privateSlot.outputEvidence.image.url += '?other=1';}],
  ['result output image with wrong dimensions', f => {f.facts.privateSlot.outputEvidence.image.width = 2048;}],
  ['result output image with wrong byte length', f => {f.facts.privateSlot.outputEvidence.image.file_size++;}],
  ['result output image with wrong media type', f => {f.facts.privateSlot.outputEvidence.image.content_type = 'image/jpeg';}],
  ['result output image with unrecognized fields', f => {f.facts.privateSlot.outputEvidence.image.unreviewed = true;}],
  ['candidate output identity not derived from its result image', f => {f.facts.candidate.outputIdentity = sha('other output');}],
  ['candidate id not derived from its attempt and output identity', f => {f.facts.candidate.id = 'forged_candidate';}],
  ['missing prepared output id', f => {f.facts.candidate.preparedAssetId = null;}],
  ['wrong encoded output id', f => {f.facts.candidate.encodedAssetId = 'other_encoded';}],
  ['unqualified prepared output', f => {f.facts.prepared.qualification = 'raster-preview';}],
  ['quarantined prepared output', f => {f.facts.prepared.safety = 'quarantined';}],
  ['prepared output detached from downloaded original', f => {f.facts.prepared.raster.sourceAssetIds = ['other_encoded'];}],
  ['missing encoded bytes', f => {f.unavailable.add(f.facts.encoded.blob.hash);}],
  ['missing prepared manifest', f => {f.unavailable.add(f.facts.prepared.blob.hash);}],
  ['missing prepared pixels', f => {f.unavailable.add(f.facts.prepared.raster.pixels.hash);}],
  ['unavailable prepared asset', f => {f.facts.prepared.availability = 'missing';}],
  ['corrupt encoded asset', f => {f.facts.encoded.availability = 'corrupt';}],
  ['missing protected media evidence', f => {delete f.facts.privateSlot.mediaEvidence;}],
  ['different protected media record', f => {f.facts.privateSlot.mediaRecord = uuid(999);}],
  ['different downloaded URL', f => {f.facts.privateSlot.url += '?changed=1';}],
  ['unapproved downloaded URL', f => {f.facts.privateSlot.url = 'https://forged.example/output.png';}],
  ['different downloaded original hash', f => {f.facts.encoded.blob = blob('different image', 'image/png');}],
  ['different downloaded original length', f => {f.facts.encoded.blob.byteLength = '1';}],
];
for (const [name, mutate] of candidateFailures) test('durable runtime output refuses ' + name, () => {
  const f = fixture(); mutate(f); assert.equal(derive(f), null);
});

test('the shipped production profile grants no LoRA runtime authority or protected-library scan', () => {
  assert.equal(currentAdapterRuntimeAuthority(), null);
  assert.equal(currentAdapterRuntimeProfile(), null);
  assert.equal(AdapterRuntimeEvidenceReader.prototype.profile.call({}), null);
  const sentinel = {db: {prepare() {assert.fail('disabled runtime authority must not query retained records');}},
    assets: {adapterDeleted() {assert.fail('disabled runtime authority must short-circuit before asset access');}}};
  assert.deepEqual(AdapterRuntimeEvidenceReader.prototype.forVersion.call(sentinel, 'version_0'), []);
  assert.equal(RUNTIME_EVIDENCE_LIMIT, 4);
  assert.equal(RUNTIME_ATTEMPT_SCAN_LIMIT, 32);
});

// Detached library projection tests use real in-memory SQL and fake dependency
// providers. They do not construct a protected transport store or bypass its
// factory to produce real runtime evidence. The injected projection only checks
// public filtering/cursors and immutable-record preservation.
function libraryFixture(t, count = 125) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE assets (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  const versions = new Map(), runtimeIds = new Set(), deletedIds = new Set(), unavailableIds = new Set(), calls = [];
  const insert = db.prepare('INSERT INTO assets VALUES (?,?)');
  for (let index = 0; index < count; index++) {
    const asset = versionAsset('version_' + String(index).padStart(3, '0'));
    versions.set(asset.id, asset); insert.run(asset.id, canonical(asset));
  }
  const observation = derive(fixture());
  assert(observation);
  const library = Object.assign(Object.create(Adapters.prototype), {db, check() {},
    assets: {adapterDeleted: id => deletedIds.has(id), asset: id => versions.get(id)},
    objects: {readRange(ref) {if (unavailableIds.has(ref.hash)) throw Object.assign(new Error('missing'), {code: 'ENOENT'}); return Buffer.alloc(0);}},
    runtime: {profile: () => structuredClone(observation.scope.profile), forVersion(id) {
      calls.push(id); if (!runtimeIds.has(id)) return [];
      const evidence = structuredClone(observation); evidence.scope.adapters[0].version = id; return [evidence];
    }}});
  return {db, versions, library, runtimeIds, deletedIds, unavailableIds, calls};
}

test('runtime library filtering is bounded and carries a cursor across an empty scan window', t => {
  const f = libraryFixture(t); f.runtimeIds.add('version_110');
  const first = f.library.list('', '', {status: 'runtime-verified'});
  assert.deepEqual(first.items, []);
  assert.equal(first.nextAfter, 'version_099');
  assert.equal(f.calls.length, 100, 'at most 100 candidate versions are projected per filtered page');
  const next = f.library.list(first.nextAfter, '', {status: 'runtime-verified'});
  assert.deepEqual(next.items.map(item => item.versionId), ['version_110']);
  assert.equal(next.nextAfter, null);
  assert.equal(f.calls.length, 125);
});

test('runtime library pages do not skip the twenty-first match and never rewrite imports', t => {
  const f = libraryFixture(t, 45), before = f.db.prepare('SELECT json FROM assets ORDER BY id').all();
  for (const id of f.versions.keys()) f.runtimeIds.add(id);
  const found = []; let cursor = '';
  do {
    const page = f.library.list(cursor, '', {status: 'runtime-verified'});
    assert(page.items.length <= 20); found.push(...page.items.map(item => item.versionId)); cursor = page.nextAfter;
    for (const entry of page.items) {assert.equal(entry.qualification, 'runtime-verified'); assert.equal(entry.runtimeVerified, true); assert(entry.runtimeEvidence.length);}
  } while (cursor !== null);
  assert.deepEqual(found, [...f.versions.keys()]);
  assert.equal(new Set(found).size, 45);
  assert.deepEqual(f.db.prepare('SELECT json FROM assets ORDER BY id').all(), before);
  for (const asset of f.versions.values()) {assert.equal(asset.adapter.qualification, 'structurally-valid'); assert.equal(asset.adapter.validation.runtimeVerified, false);}
});

test('runtime projection removes promoted entries from the stored-status filter and respects ordinary search', t => {
  const f = libraryFixture(t, 6); f.runtimeIds.add('version_001'); f.runtimeIds.add('version_004');
  const ordinary = f.library.list('', '', {status: 'structurally-valid'});
  assert.deepEqual(ordinary.items.map(item => item.versionId), ['version_000', 'version_002', 'version_003', 'version_005']);
  const searched = f.library.list('', 'version_004', {family: 'ideogram-v4', format: 'fal', origin: 'import', status: 'runtime-verified'});
  assert.deepEqual(searched.items.map(item => item.versionId), ['version_004']);
  assert.deepEqual(f.library.list('', '', {family: 'other', status: 'runtime-verified'}).items, []);
});

test('deleted or unavailable library versions cannot retain a runtime badge', t => {
  const f = libraryFixture(t, 3); f.runtimeIds.add('version_000'); f.runtimeIds.add('version_001');
  f.deletedIds.add('version_000');
  f.unavailableIds.add(f.versions.get('version_001').adapter.origin.provenance.hash);
  for (const id of ['version_000', 'version_001']) {
    const entry = f.library.view(id); assert.equal(entry.available, false); assert.equal(entry.runtimeVerified, false);
    assert.deepEqual(entry.runtimeEvidence, []); assert.equal(entry.qualification, 'structurally-valid');
  }
  assert.deepEqual(f.calls, [], 'unavailable versions must not trigger runtime evidence reads');
});

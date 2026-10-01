import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLifecycleOracle, hashByteStream, lifecyclePixelEquality, validateLoopbackOrigin, validatedBlobRef, verifyReplacementState, verifyAuthoredStroke } from '../../tooling/qualification/campaigns/browser-lifecycle-oracle.mjs';

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const ref = bytes => ({ hash: digest(bytes), byteLength: String(bytes.length), mediaType: 'application/octet-stream' });
async function* pieces(bytes, length = 3) { for (let offset = 0; offset < bytes.length; offset += length) yield bytes.subarray(offset, offset + length); }
const witness = (width = 2, height = 1, sha256 = digest(Buffer.from('decoded pixels'))) => ({ kind: 'independent-png-decoded-canonical-rgba-1', width, height, channels: 4, byteLength: String(width * height * 4), sha256, canonicalSha256: sha256, decodedEntirePNG: true, canonicalPixelsFullyHashed: true, nativeDisplayPixelsVerified: false });

test('full byte proof hashes every chunk and preserves exact lengths without a body buffer', async () => {
  const bytes = Buffer.from('a real bounded stream with several chunks'); let reads = 0;
  async function* source() { for await (const value of pieces(bytes)) { reads++; yield value; } }
  assert.deepEqual(await hashByteStream(source(), ref(bytes)), { ...ref(bytes), verification: 'complete-stream-sha256' });
  assert.equal(reads, Math.ceil(bytes.length / 3));
  assert.deepEqual(await hashByteStream(pieces(Buffer.alloc(0)), ref(Buffer.alloc(0))), { ...ref(Buffer.alloc(0)), verification: 'complete-stream-sha256' });
});

test('truncation, corruption and extra bytes cannot pass a declared metadata identity', async () => {
  const bytes = Buffer.from('the sealed bytes'), expected = ref(bytes);
  await assert.rejects(hashByteStream(pieces(bytes.subarray(0, -1)), expected), /full content hash or byte length mismatch/);
  const corrupt = Buffer.from(bytes); corrupt[0] ^= 1;
  await assert.rejects(hashByteStream(pieces(corrupt), expected), /full content hash or byte length mismatch/);
  await assert.rejects(hashByteStream(pieces(Buffer.concat([bytes, Buffer.from([0])])), expected), /exceeded its declared byte length/);
});

test('oversized metadata is rejected before a stream starts', async () => {
  let reads = 0; async function* source() { reads++; yield Buffer.alloc(32); }
  await assert.rejects(hashByteStream(source(), ref(Buffer.alloc(32)), { maxBytes: 16 }), /bounded verification budget/);
  assert.equal(reads, 0);
  for (const byteLength of [4, '-1', '01', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) assert.throws(() => validatedBlobRef({ ...ref(Buffer.alloc(4)), byteLength }));
});

test('cancellation closes the source and does not begin a pre-aborted read', async () => {
  const controller = new AbortController(), error = Error('stop oracle'); controller.abort(error);
  let reads = 0; async function* unopened() { reads++; yield Buffer.from('x'); }
  await assert.rejects(hashByteStream(unopened(), ref(Buffer.from('x')), { signal: controller.signal }), error);
  assert.equal(reads, 0);
  const active = new AbortController(); let closed = false;
  async function* interrupted() { try { yield Buffer.from('a'); active.abort(error); yield Buffer.from('b'); } finally { closed = true; } }
  await assert.rejects(hashByteStream(interrupted(), ref(Buffer.from('ab')), { signal: active.signal }), error);
  assert.equal(closed, true);
});

test('a non-byte stream cannot accidentally hash a string conversion', async () => {
  async function* bad() { yield 'bytes'; }
  await assert.rejects(hashByteStream(bad(), ref(Buffer.from('bytes'))), /non-byte chunk/);
});

test('literal origin validation rejects alternate hosts, redirects and credentials', () => {
  assert.equal(validateLoopbackOrigin('http://127.0.0.1:4381'), 'http://127.0.0.1:4381');
  for (const origin of ['http://localhost:4381', 'http://127.1:4381', 'http://[::1]:4381', 'https://127.0.0.1:4381', 'http://example.com:4381', 'http://user:secret@127.0.0.1:4381', 'http://127.0.0.1:4381/path', 'http://127.0.0.1:4381?next=elsewhere', 'http://127.0.0.1:4381/#pairing=secret']) assert.throws(() => validateLoopbackOrigin(origin));
});

test('pixel equality requires independent actual decode and canonical-byte proofs', () => {
  const before = witness(); assert.equal(lifecyclePixelEquality(before, structuredClone(before)), true);
  assert.equal(before.nativeDisplayPixelsVerified, false);
  for (const missing of ['kind', 'decodedEntirePNG', 'canonicalPixelsFullyHashed', 'sha256', 'canonicalSha256']) {
    const metadataOnly = { ...before }; delete metadataOnly[missing];
    assert.throws(() => lifecyclePixelEquality(before, metadataOnly), /two complete independent decode/);
  }
  assert.throws(() => lifecyclePixelEquality(before, { ...before, canonicalSha256: digest(Buffer.from('different actual canonical bytes')) }), /two complete independent decode/);
});

test('same byte count with a different grid or actual decoded bytes is unequal', () => {
  assert.equal(lifecyclePixelEquality(witness(2, 1), witness(1, 2)), false);
  assert.equal(lifecyclePixelEquality(witness(), witness(2, 1, digest(Buffer.from('different decoded image')))), false);
  assert.throws(() => lifecyclePixelEquality(witness(), { ...witness(), byteLength: '4' }), /two complete independent decode/);
  assert.throws(() => lifecyclePixelEquality(witness(), { ...witness(), channels: 3 }), /two complete independent decode/);
});

test('pixel witness bounds admit exact W2 but reject a scaled oversized maximum', () => {
  assert.equal(lifecyclePixelEquality(witness(5000, 5000), witness(5000, 5000)), true);
  assert.equal(lifecyclePixelEquality(witness(8192, 3000), witness(8192, 3000)), true);
  for (const [width, height] of [[5001, 5000], [8193, 1], [0, 2048]]) assert.throws(() => lifecyclePixelEquality(witness(), witness(width, height)), /two complete independent decode/);
});

test('oracle refuses the sealed source as a writable-subject copy before loading product modules', async () => {
  await assert.rejects(createLifecycleOracle({ origin: 'http://127.0.0.1:4381', root: '/sealed', fixture: { root: '/sealed', documentId: 'document' } }), /owned private fixture copy/);
  await assert.rejects(createLifecycleOracle({ origin: 'http://127.0.0.1:4381', root: '/owned-copy', fixture: { root: '/sealed', documentId: 'document' } }), /sealed corpus/);
});

function layer(id, version = '8') { return { id, version, kind: 'image', name: id, assetId: 'original_' + id, layerToDocument: [1, 0, 0, 1, 3, -3], opacity: 0.75, visible: true, locked: false, blend: 'normal', mask: { assetId: 'baseline_mask', mapping: 'document-r16-v1', inverted: false } }; }
function replacementFixture(count = 2) {
  const before = { schemaVersion: 3, width: 500, height: 500, layers: Array.from({ length: count }, (_, index) => layer('layer_' + index)) }, after = structuredClone(before);
  Object.assign(after.layers[0], { name: 'Candidate', version: '9', assetId: 'wrapped_candidate', layerToDocument: [1, 0, 0, 1, 0, 0], opacity: 1, mask: null });
  return { before, after, replacement: { id: 'layer_0', version: '8' } };
}

test('candidate replacement preserves the exact selected slot and all other layers at 100 layers', () => {
  const { before, after, replacement } = replacementFixture(100), result = verifyReplacementState(before, after, replacement);
  assert.equal(result.index, 0); assert.equal(result.target.assetId, 'wrapped_candidate'); assert.equal(after.layers.length, 100);
  // The other 99 layers remain visible: the document cannot be equated to the candidate.
  assert(after.layers.slice(1).every(value => value.visible));
});

test('replacement rejects another target version, changed other layer, reordered slot or retained mask', () => {
  for (const mutate of [value => { value.replacement.version = '7'; }, value => { value.after.layers[1].opacity = 0.1; }, value => { value.after.layers.reverse(); }, value => { value.after.layers[0].mask = value.before.layers[0].mask; }, value => { value.after.width++; }]) {
    const value = replacementFixture(); mutate(value); assert.throws(() => verifyReplacementState(value.before, value.after, value.replacement));
  }
});

function strokeFixture() {
  const document = { id: 'document', revision: '3', width: 500, height: 500 }, beforeImage = replacementFixture().before;
  const specimen = { id: 'stroke-001', brushDiameter: 64, sampleHz: 60, samples: Array.from({ length: 120 }, (_, index) => ({ x: 50 + Math.min(index, 118), y: 80, timeMs: index * 1000 / 60 })) };
  const points = specimen.samples.map(sample => [sample.x, sample.y]), events = points.map(([clientX, clientY], index) => ({ type: index === 0 ? 'pointerdown' : index === 119 ? 'pointerup' : 'pointermove', trusted: true, primary: true, pointerType: 'mouse', pointerId: 7, buttons: index === 119 ? 0 : 1, inputMs: 10 + index, observedMs: 10.25 + index, clientX, clientY }));
  const plan = { document, documentId: document.id, revision: document.revision, selectedLayerId: 'layer_0', state: { timeOrigin: 1, box: { x: 0, y: 0, width: 500, height: 500 }, viewport: { x: 0, y: 0, zoom: 1 } }, points: specimen.samples.map((sample, index) => ({ index, x: sample.x, y: sample.y, documentX: sample.x, documentY: sample.y })) };
  const native = { clock: 'browser-performance', timeOrigin: 1, armedMs: 9, firstInputMs: 10, stoppedMs: 140, canvasStillConnected: true, overflow: false, cancelled: false, events };
  const completion = { startMs: 150, detail: { schemaVersion: 1, gestureOrdinal: 1, pointerId: 7, inputDownMs: 10, inputUpMs: 129, trusted: true, documentId: document.id, revision: document.revision, draftId: 'draft', targetLayerId: 'layer_0', targetLayerVersion: '8', selectedLayerId: 'layer_0', sampleCount: 120, operationCount: 2, brushDiameter: 64, geometrySha256: digest(JSON.stringify(points)) } };
  const initial = { kind: 'import', assetId: 'original_mask', x: 0, y: 0, width: 500, height: 500, inverted: false };
  const authoring = { width: 500, height: 500, feather: 0, operations: [initial, { kind: 'stroke', points, size: 64, hardness: 1, mode: 'add' }] };
  const afterImage = structuredClone(beforeImage); afterImage.layers[0].version = '9'; afterImage.layers[0].mask.assetId = 'accepted_mask';
  return { stroke: { accepted: true, receipt: { status: 'accepted', documentId: document.id }, specimenId: specimen.id, target: { id: 'layer_0', version: '8' }, plan, native, completion }, specimen, document, beforeImage, afterImage, manifest: { plan: { kind: 'authored-mask-v1', authoring } }, baselineManifest: { plan: { authoring: { width: 500, height: 500, feather: 0, operations: [initial] } } } };
}

test('accepted authored geometry binds all 120 actual native points to the durable mask operation', () => {
  const result = verifyAuthoredStroke(strokeFixture());
  assert.equal(result.sampleCount, 120); assert.equal(result.brushDiameter, 64); assert.equal(result.native.productAppendQualified, true); assert.equal(result.independentRasterization, false);
});

test('declared sample count cannot replace an absent or untrusted native event', () => {
  for (const mutate of [value => { value.stroke.native.events.pop(); }, value => { value.stroke.native.events[10].trusted = false; }, value => { value.stroke.native.events[10].clientX += 1; }]) {
    const value = strokeFixture(); mutate(value); assert.throws(() => verifyAuthoredStroke(value), /native stroke/);
  }
});

test('authored points and sealed specimen are checked independently of product completion metadata', () => {
  const persistedChange = strokeFixture(); persistedChange.manifest.plan.authoring.operations.at(-1).points = structuredClone(persistedChange.manifest.plan.authoring.operations.at(-1).points); persistedChange.manifest.plan.authoring.operations.at(-1).points[20][1] += 0.25;
  assert.throws(() => verifyAuthoredStroke(persistedChange), /durable authored mask/);
  const planChange = strokeFixture(); planChange.stroke.plan.points[20].documentY += 1;
  assert.throws(() => verifyAuthoredStroke(planChange), /sealed document geometry/);
});

test('accepted mask geometry preserves its initial mask plan, feather and other layer state', () => {
  for (const mutate of [value => { value.manifest.plan.authoring.operations.shift(); }, value => { value.manifest.plan.authoring.feather = 3; }, value => { value.afterImage.layers[1].visible = false; }, value => { value.stroke.receipt.status = 'rejected'; }, value => { value.manifest.plan.authoring.operations.at(-1).size = 32; }]) {
    const value = strokeFixture(); mutate(value); assert.throws(() => verifyAuthoredStroke(value));
  }
});

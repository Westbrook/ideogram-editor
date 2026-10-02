import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyEncodedReview, verifyEncodedExecution, encodedInterpretationMissing } from '../../tooling/qualification/campaigns/browser-encoded.mjs';

const blob = (id, mediaType = 'image/png', byteLength = '4') => ({ hash: 'sha256:' + id.toString(16).padStart(64, '0'), mediaType, byteLength });
const image = (id, kind) => ({ assetId: id, assetVersion: '1', assetHash: blob(id === 'source' ? 1 : 2).hash, encodedAssetId: kind === 'candidate-original' ? 'original' : id, encoding: kind,
  encoded: blob(id === 'source' ? 3 : 4), info: { width: 1, height: 1, pixels: blob(id === 'source' ? 5 : 6, 'application/x-ideogram-rgba8') } });
const mask = id => ({ codec: 'r16le-deflate-v1', width: 1, height: 1, encoded: blob(id, 'application/x-ideogram-r16le-deflate', '30'), pixels: blob(id + 1, 'application/x-ideogram-r16le', '2') });
function fixture() {
  const encoded = { kind: 'encoded-adoption-inputs-1', source: image('source', 'canonical-png'), candidate: image('prepared', 'candidate-original'),
    mask: { assetId: 'mask', assetVersion: '1', assetHash: blob(7).hash, info: { width: 1, height: 1 }, authored: mask(10), effective: mask(20), approved: mask(20) } };
  const document = { id: 'document', revision: '1' }, candidate = { id: 'candidate', preparedAssetId: 'prepared', encodedAssetId: 'original' };
  const review = { kind: 'candidate-placement-review-1', reviewId: 'review', reviewHash: blob(30).hash, documentId: document.id, documentRevision: document.revision, preparation: 'deferred', placement: { placement: 'new-document', mode: 'safe-region', newDocumentId: 'created' },
    inputs: { mode: 'safe-region', identity: { candidateId: candidate.id, preparedAssetId: candidate.preparedAssetId }, encodedRebuild: encoded, sourceCapture: { scope: 'visible-document' }, plan: { sourcePixels: encoded.source.info.pixels, authoredMask: encoded.mask.authored.pixels, effectiveMask: encoded.mask.effective.pixels }, outputMapping: null } };
  const prepared = () => verifyEncodedReview(review, document, candidate, review.placement.placement);
  const input = (encoded, expected, kind) => ({ encoded, expected, actual: structuredClone(expected), kind });
  const inputs = [input(encoded.source.encoded, encoded.source.info.pixels, 'rgba8'), input(encoded.candidate.encoded, encoded.candidate.info.pixels, 'rgba8'), ...[encoded.mask.authored, encoded.mask.effective, encoded.mask.approved].map(m => input(m.encoded, m.pixels, 'r16le'))];
  const output = { encoded: blob(40), pixels: blob(41, 'application/x-ideogram-rgba8') };
  const record = (operation, inputs, outputAssetId, output) => ({ phase: 'encoded-input-rebuild', operation, slot: 'history:accept', outputAssetId, output,
    evidence: { kind: 'encoded-input-rebuild-1', canonicalInputPaths: 0, reusedPreparedProducts: 0, scratchRemoved: true, decodeCount: inputs.length, inputs },
    metrics: { decodeMs: 2, encodedInputCount: inputs.length, encodedScratchRemoved: 1 } });
  const records = [record('encoded-preserve', inputs, 'preserved', output), record('encoded-compose', [input(output.encoded, output.pixels, 'rgba8')], 'composite', { encoded: blob(50), pixels: blob(51, 'application/x-ideogram-rgba8') })];
  return { encoded, document, candidate, review, prepared, records };
}

test('encoded review binds original encoded bytes and exact R16 while disclosing retained canonical history', () => {
  const f = fixture(), result = f.prepared();
  assert.equal(result.targetDocumentId, 'created'); assert.equal(result.literalEncodedOnlyDurable, false); assert.equal(result.presentationClaim, false);
  assert.equal(result.encoded.mask.effective.codec, 'r16le-deflate-v1');
  f.review.placement.placement = 'current-document';
  assert.equal(f.prepared().targetDocumentId, 'document');
  f.review.inputs.sourceCapture.scope = 'single-layer'; assert.throws(f.prepared, { code: 'CAMPAIGN_PREREQUISITE' });
});
for (const [name, update] of [
  ['prepared Q reuse', f => f.review.preparation = 'prepared-reuse'],
  ['stale document revision', f => f.document.revision = '2'],
  ['different encoded original', f => f.candidate.encodedAssetId = 'other'],
  ['different prepared candidate', f => f.candidate.preparedAssetId = 'other'],
  ['missing encoded package', f => delete f.review.inputs.encodedRebuild],
  ['8-bit PNG pretending to be R16', f => f.encoded.mask.effective.encoded.mediaType = 'image/png'],
  ['incorrect raw mask extent', f => f.encoded.mask.effective.pixels.byteLength = '1'],
  ['different preservation source', f => f.review.inputs.plan.sourcePixels = blob(90)],
  ['full candidate mode', f => f.review.placement.mode = 'full-candidate'],
]) test('encoded review rejects ' + name, () => { const f = fixture(); update(f); assert.throws(f.prepared, { code: 'CAMPAIGN_PREREQUISITE' }); });

test('actual execution joins exact acceptance, original five decodes and fresh preservation output into final composition', () => {
  const f = fixture(), unrelated = structuredClone(f.records[0]); unrelated.slot = 'history:unrelated';
  const result = verifyEncodedExecution([unrelated, ...f.records], f.prepared(), 'accept', 'composite');
  assert.equal(result.decodeCount, 6); assert.equal(result.canonicalInputPaths, 0); assert.equal(result.reusedPreparedProducts, 0);
  assert.deepEqual(result.missing, [encodedInterpretationMissing]); assert.equal(result.literalEncodedOnlyDurable, false);
  assert.throws(() => verifyEncodedExecution(null, f.prepared(), 'accept', 'composite'), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.throws(() => verifyEncodedReview(f.review, null, f.candidate, 'new-document'), { code: 'CAMPAIGN_PREREQUISITE' });
});
for (const [name, update] of [
  ['another command', f => f.records[0].slot = 'history:other'],
  ['missing final decode', f => f.records.pop()],
  ['duplicated preservation record', f => f.records.push(f.records[0])],
  ['raw canonical path', f => f.records[0].evidence.canonicalInputPaths = 1],
  ['reused Q', f => f.records[0].evidence.reusedPreparedProducts = 1],
  ['missing actual decode', f => f.records[0].evidence.decodeCount = 0],
  ['different encoded bytes', f => f.records[0].evidence.inputs[0].encoded = blob(90)],
  ['decoded hash mismatch', f => f.records[0].evidence.inputs[0].actual = blob(90)],
  ['scratch still retained', f => f.records[1].evidence.scratchRemoved = false],
  ['final input from old Q', f => { const value = f.records[1].evidence.inputs[0]; value.encoded = blob(90); }],
  ['wrong accepted composite', f => f.records[1].outputAssetId = 'other'],
  ['missing decoder measurements', f => delete f.records[1].metrics.decodeMs],
]) test('encoded execution rejects ' + name, () => { const f = fixture(); update(f); assert.throws(() => verifyEncodedExecution(f.records, f.prepared(), 'accept', 'composite'), { code: 'CAMPAIGN_PREREQUISITE' }); });

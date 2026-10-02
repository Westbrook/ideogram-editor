import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { retainEncodedDiagnosticEvidence, projectEncodedDiagnosticRecords } from '../../tooling/qualification/campaigns/diagnostic-evidence.mjs';
import { verifyEncodedReview, verifyEncodedExecution, verifyRetainedEncodedExecution } from '../../tooling/qualification/campaigns/browser-encoded.mjs';

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
  // Independent job witnesses must not alias: changing the decoded input
  // must not also rewrite the prior job's output identity.
  const input = (encoded, expected, kind) => ({ encoded: structuredClone(encoded), expected, actual: structuredClone(expected), kind });
  const inputs = [input(encoded.source.encoded, encoded.source.info.pixels, 'rgba8'), input(encoded.candidate.encoded, encoded.candidate.info.pixels, 'rgba8'), ...[encoded.mask.authored, encoded.mask.effective, encoded.mask.approved].map(m => input(m.encoded, m.pixels, 'r16le'))];
  const output = { encoded: blob(40), pixels: blob(41, 'application/x-ideogram-rgba8') };
  const record = (operation, inputs, outputAssetId, output) => ({ phase: 'encoded-input-rebuild', operation, slot: 'history:accept', outputAssetId, output,
    evidence: { kind: 'encoded-input-rebuild-1', canonicalInputPaths: 0, reusedPreparedProducts: 0, scratchRemoved: true, decodeCount: inputs.length, inputs },
    metrics: { decodeMs: 2, encodedInputCount: inputs.length, encodedScratchRemoved: 1 } });
  const records = [record('encoded-preserve', inputs, 'preserved', output), record('encoded-compose', [input(output.encoded, output.pixels, 'rgba8')], 'composite', { encoded: blob(50), pixels: blob(51, 'application/x-ideogram-rgba8') })];
  return { encoded, document, candidate, review, prepared, records };
}


async function workspace(t) {
  const output = await mkdtemp(join(tmpdir(), 'encoded-diagnostic-receiver-'));
  t.after(() => rm(output, { recursive: true, force: true })); return output;
}

test('receiver gets finite detached decode proof while complete raw evidence is retained under owner', async t => {
  const output = await workspace(t), f = fixture(); let live = true;
  f.records[0].diagnosticOnly = { nativePlan: { bytes: 123, retained: ['full', 'raw'] } };
  Object.defineProperty(f.records, 'toJSON', { value() { assert.equal(live, true); return Array.from(this); } });
  const envelope = await retainEncodedDiagnosticEvidence(output, f.records); live = false;
  const raw = await readFile(envelope.raw.artifact.path);
  assert.equal(envelope.raw.artifact.bytes, raw.length);
  assert.equal(envelope.raw.artifact.sha256, 'sha256:' + createHash('sha256').update(raw).digest('hex'));
  assert.deepEqual(JSON.parse(raw)[0].diagnosticOnly, f.records[0].diagnosticOnly);
  assert.equal(envelope.records[0].diagnosticOnly, undefined);
  const originalHash = f.records[0].evidence.inputs[0].actual.hash;
  f.records[0].evidence.inputs[0].actual.hash = blob(99).hash;
  assert.equal(envelope.records[0].evidence.inputs[0].actual.hash, originalHash);
  const result = await verifyRetainedEncodedExecution(envelope, f.prepared(), 'accept', 'composite', output);
  assert.equal(result.decodeCount, 6); assert.equal(result.literalEncodedOnlyDurable, false);
  assert.deepEqual(result.diagnosticArtifact, envelope.raw.artifact);
  assert.equal(result.records[0].diagnosticOnly, undefined);
  envelope.records[0].evidence.inputs[0].actual.hash = blob(88).hash;
  assert.equal(result.records[0].evidence.inputs[0].actual.hash, originalHash, 'Receipt does not retain incoming projection aliases');
});

test('record and input bounds refuse overflow without truncation or a partial artifact', async t => {
  const output = await workspace(t), f = fixture();
  assert.equal(projectEncodedDiagnosticRecords(Array.from({ length: 32 }, () => f.records[0])).length, 32);
  await assert.rejects(retainEncodedDiagnosticEvidence(output, Array.from({ length: 33 }, () => f.records[0])), /RECORD_BOUND/);
  const six = structuredClone(f.records); six[0].evidence.inputs.push(six[0].evidence.inputs[0]);
  await assert.rejects(retainEncodedDiagnosticEvidence(output, six), /INPUT_BOUND/);
  assert.deepEqual(await readdir(output), [], 'Refused proof did not publish an artifact');
});

test('projection never evaluates diagnostic getters or copies unknown nested state', () => {
  const f = fixture(); let called = 0;
  Object.defineProperty(f.records[0], 'diagnosticOnly', { enumerable: true, get() { ++called; throw Error('must not read'); } });
  Object.defineProperty(f.records[0].metrics, 'decodeMs', { enumerable: true, get() { ++called; throw Error('must not read'); } });
  const detached = projectEncodedDiagnosticRecords(f.records);
  assert.equal(called, 0); assert.equal(detached[0].metrics.decodeMs, undefined);
  assert.throws(() => verifyEncodedExecution(detached, f.prepared(), 'accept', 'composite'), { code: 'CAMPAIGN_PREREQUISITE' });
});

test('retained receiver rejects changed bytes, identity and an artifact outside the actual group', async t => {
  const output = await workspace(t), f = fixture(), envelope = await retainEncodedDiagnosticEvidence(output, f.records);
  await assert.rejects(verifyRetainedEncodedExecution(envelope, f.prepared(), 'accept', 'composite', join(output, 'other')), { code: 'CAMPAIGN_PREREQUISITE' });
  const forged = structuredClone(envelope); forged.raw.artifact.bytes++;
  await assert.rejects(verifyRetainedEncodedExecution(forged, f.prepared(), 'accept', 'composite', output), { code: 'CAMPAIGN_PREREQUISITE' });
  await writeFile(envelope.raw.artifact.path, 'changed');
  await assert.rejects(verifyRetainedEncodedExecution(envelope, f.prepared(), 'accept', 'composite', output), { code: 'CAMPAIGN_PREREQUISITE' });
});

test('filesystem failure cannot return a complete detached observation', async t => {
  const output = await workspace(t), path = join(output, 'ordinary-file'); await writeFile(path, 'x');
  await assert.rejects(retainEncodedDiagnosticEvidence(path, fixture().records));
});

test('projection preserves the actual ordered refs, decoder count and cleanup predicates', () => {
  const updates = [
    f => f.records.reverse(),
    f => f.records[0].evidence.inputs[0].actual.hash = blob(91).hash,
    f => f.records[1].evidence.inputs[0].encoded.hash = blob(92).hash,
    f => f.records[0].evidence.canonicalInputPaths = 1,
    f => f.records[0].evidence.reusedPreparedProducts = 1,
    f => f.records[1].evidence.scratchRemoved = false,
    f => f.records[0].metrics.encodedInputCount = 0,
    f => f.records[1].metrics.encodedScratchRemoved = 0,
  ];
  for (const update of updates) {
    const f = fixture();
    assert.notEqual(f.records[0].output.encoded, f.records[1].evidence.inputs[0].encoded);
    update(f);
    assert.throws(() => verifyEncodedExecution(projectEncodedDiagnosticRecords(f.records), f.prepared(), 'accept', 'composite'), { code: 'CAMPAIGN_PREREQUISITE' });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { installRasterCapabilities, verifyReadinessSnapshot, verifyPreparedReview, contextRecoveryOutcome } from '../../tooling/qualification/campaigns/browser-readiness.mjs';

const snapshot = () => ({ schemaVersion: 1, clock: 'browser-performance', timeOrigin: 123, observedMs: 45,
  review: { reviewId: 'review', previewId: 'preview', assetId: 'result' },
  viewport: { schemaVersion: 1, generation: 4, decodedAssetId: 'result', bitmapSerial: 2, decodedBitmaps: 1, pendingReads: 0, releasedBitmaps: 1, decodeStarts: 2,
    contextLost: false, contextRestoring: false, recoveryError: false, contextLosses: 0, contextRestorations: 0, lastLossMs: null, lastRestorationMs: null } });
const prepared = () => ({ assetId: 'result', reviewId: 'review', previewId: 'preview', resident: snapshot() });

test('readiness A binds the real live owner to the exact public reviewed composite', () => {
  const result = verifyReadinessSnapshot(snapshot(), prepared(), 'A');
  assert.equal(result.assetId, 'result'); assert.equal(result.ownerGeneration, 4); assert.equal(result.presentationClaim, false);
});
for (const [name, update] of [
  ['different asset', value => value.viewport.decodedAssetId = 'accepted'],
  ['no live bitmap', value => value.viewport.decodedBitmaps = 0],
  ['pending decode', value => value.viewport.pendingReads = 1],
  ['lost context', value => value.viewport.contextLost = true],
  ['restoration in flight', value => value.viewport.contextRestoring = true],
  ['failed recovery', value => value.viewport.recoveryError = true],
  ['different review', value => value.review.reviewId = 'other'],
  ['different preparation', value => value.review.previewId = 'other'],
  ['missing native owner identity', value => value.viewport.bitmapSerial = null],
]) test('readiness A rejects ' + name, () => { const value = snapshot(); update(value); assert.throws(() => verifyReadinessSnapshot(value, prepared(), 'A'), { code: 'CAMPAIGN_PREREQUISITE' }); });

const returned = () => { const value = snapshot(); value.review = null; Object.assign(value.viewport, { decodedAssetId: 'accepted', bitmapSerial: 3, generation: 5, releasedBitmaps: 2, decodeStarts: 3 }); return value; };
test('B requires a real eviction of the previously observed prepared owner', () => {
  const value = verifyReadinessSnapshot(returned(), prepared(), 'B'); assert.equal(value.readiness, 'B'); assert.equal(value.decodedAssetId, 'accepted');
});
for (const [name, update] of [
  ['same asset still usable', value => value.viewport.decodedAssetId = 'result'],
  ['no release', value => value.viewport.releasedBitmaps = 1],
  ['same generation', value => value.viewport.generation = 4],
  ['same bitmap', value => value.viewport.bitmapSerial = 2],
  ['review still active', value => value.review = snapshot().review],
]) test('B rejects ' + name, () => { const value = returned(); update(value); assert.throws(() => verifyReadinessSnapshot(value, prepared(), 'B')); });
test('B cannot be certified by an initially empty cache or unexplained missing metadata', () => {
  assert.throws(() => verifyReadinessSnapshot(returned(), { ...prepared(), resident: null }, 'B'));
  assert.throws(() => verifyReadinessSnapshot(null, prepared(), 'A'));
  assert.throws(() => verifyReadinessSnapshot(snapshot(), prepared(), 'C'));
});
test('review proof binds source revision, candidate and final composite independently of ready labels', () => {
  const review = { reviewId: 'review', reviewHash: 'a'.repeat(64), preview: { previewId: 'preview', documentId: 'document', documentRevision: '1', after: { compositeAssetId: 'result' }, candidate: { candidateId: 'candidate', placement: 'current-document' } } };
  const document = { id: 'document', revision: '1' }, candidate = { id: 'candidate' };
  assert.equal(verifyPreparedReview(review, snapshot(), candidate, document).assetId, 'result');
  for (const altered of [{ ...document, revision: '2' }, { ...document, id: 'different' }]) assert.throws(() => verifyPreparedReview(review, snapshot(), candidate, altered));
  assert.throws(() => verifyPreparedReview(review, snapshot(), { id: 'different' }, document));
  const altered = structuredClone(review); altered.preview.after.compositeAssetId = 'other'; assert.throws(() => verifyPreparedReview(altered, snapshot(), candidate, document));
});
test('capability absence is installed only for its explicitly named cohort before product evaluation', async () => {
  const scripts = []; const context = { addInitScript: async fn => scripts.push(String(fn)) };
  assert.equal((await installRasterCapabilities(context, 'native')).injected, false);
  assert.equal((await installRasterCapabilities(context, 'context-loss')).injected, false);
  assert.deepEqual((await installRasterCapabilities(context, 'worker-offscreen-disabled')).disabled, ['Worker', 'OffscreenCanvas']);
  assert.equal(scripts.length, 1); assert.match(scripts[0], /Object.defineProperty/); assert.doesNotMatch(scripts[0], /ready|dispatchEvent|requestAnimationFrame/);
  await assert.rejects(installRasterCapabilities(context, 'unknown'), { code: 'CAMPAIGN_PREREQUISITE' });
});
const recovered = () => { const value = snapshot(); Object.assign(value.viewport, { contextLosses: 1, contextRestorations: 1, lastLossMs: 50, lastRestorationMs: 70, releasedBitmaps: 2, decodeStarts: 3 }); return value; };
test('context recovery needs actual loss, restoration, eviction and retained-asset decode', () => {
  const result = contextRecoveryOutcome(snapshot(), recovered(), { commandAccepted: true }); assert.equal(result.status, 'PASS'); assert.deepEqual(result.missing, []);
  assert.equal(contextRecoveryOutcome(snapshot(), snapshot(), { commandAccepted: true }).status, 'INCONCLUSIVE', 'A successful GPU command does not prove that the canvas lost context');
  assert.equal(contextRecoveryOutcome(snapshot(), recovered(), { commandAccepted: false }).status, 'INCONCLUSIVE');
  const other = recovered(); other.viewport.decodedAssetId = 'different'; assert.equal(contextRecoveryOutcome(snapshot(), other, { commandAccepted: true }).status, 'INCONCLUSIVE');
  const noDecode = recovered(); noDecode.viewport.decodeStarts = 2; assert.equal(contextRecoveryOutcome(snapshot(), noDecode, { commandAccepted: true }).status, 'INCONCLUSIVE');
});

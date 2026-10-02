import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReadinessSnapshot } from '../../tooling/qualification/campaigns/browser-readiness.mjs';

const snapshot = () => ({ schemaVersion: 1, observedMs: 20, timeOrigin: 100, review: { reviewId: 'review', previewId: 'preview', assetId: 'result' },
  viewport: { schemaVersion: 1, generation: 3, decodedAssetId: 'result', bitmapSerial: 1, decodedBitmaps: 6, releasedBitmaps: 0, decodeStarts: 6, pendingReads: 0, pendingCleanup: 0,
    representation: 'viewport-tiles', requiredTiles: 4, residentRequiredTiles: 4, visibleComplete: true, contextLost: false, contextRestoring: false, recoveryError: false } });
const prepared = () => ({ reviewId: 'review', previewId: 'preview', assetId: 'result', resident: snapshot() });
test('A accepts real complete visible tiles without requiring a single bitmap or claiming full image residency', () => {
  const result = verifyReadinessSnapshot(snapshot(), prepared(), 'A');
  assert.equal(result.representation, 'viewport-tiles'); assert.equal(result.requiredTiles, 4); assert.equal(result.residentRequiredTiles, 4); assert.equal(result.presentationClaim, false);
});
for (const [name, update] of [
  ['missing required tile', o => o.residentRequiredTiles = 3],
  ['no visible intersection', o => { o.requiredTiles = 0; o.residentRequiredTiles = 0; }],
  ['undrawn viewport', o => o.visibleComplete = false],
  ['pending native cleanup', o => o.pendingCleanup = 1],
  ['too few actual native owners', o => o.decodedBitmaps = 3],
  ['fabricated owner serial', o => o.bitmapSerial = 0],
  ['unknown owner representation', o => { o.representation = 'unknown'; o.decodedBitmaps = 1; }],
]) test('A refuses ' + name, () => { const value = snapshot(); update(value.viewport); assert.throws(() => verifyReadinessSnapshot(value, prepared(), 'A'), { code: 'CAMPAIGN_PREREQUISITE' }); });
test('B observes actual tile owner release and generation replacement', () => {
  const value = snapshot(); value.review = null;
  Object.assign(value.viewport, { decodedAssetId: 'accepted', generation: 4, bitmapSerial: 2, releasedBitmaps: 6, decodeStarts: 12 });
  assert.equal(verifyReadinessSnapshot(value, prepared(), 'B').readiness, 'B');
  value.viewport.releasedBitmaps = 1; assert.throws(() => verifyReadinessSnapshot(value, prepared(), 'B'), 'One released tile cannot prove release of six actual resident tile owners');
  delete value.viewport.releasedBitmaps; assert.throws(() => verifyReadinessSnapshot(value, prepared(), 'B'));
  value.viewport.releasedBitmaps = 0; assert.throws(() => verifyReadinessSnapshot(value, prepared(), 'B'));
  value.viewport.releasedBitmaps = 6; value.viewport.pendingCleanup = 1; assert.throws(() => verifyReadinessSnapshot(value, prepared(), 'B'));
});

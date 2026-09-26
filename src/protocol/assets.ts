import type { BlobRef, Seq } from './store.js';
import type { RasterInfo } from './raster.js';
export type StagingPurpose = 'image' | 'mask' | 'adapter' | 'font' | 'caption' | 'bundle' | 'text';
export type StagingCreateRequest = { protocolVersion: 1; stagingId: string; purpose: StagingPurpose; expectedBytes: string; sha256: string; mediaType: string };
export type StagingRecord = StagingCreateRequest & { ownerClientId: string; version: Seq; committedOffset: string; state: 'receiving' | 'complete' | 'finalized' | 'failed'; assetRef?: BlobRef };
export type StagingRecoveryItem = { stagingId: string; ownerClientId: string; version: Seq; purpose: StagingPurpose; expectedBytes: string; committedOffset: string; createdAt: string; state: 'receiving' | 'complete' | 'failed' };
export type StagingRecoveryPage = { protocolVersion: 1; items: StagingRecoveryItem[]; nextCursor: string | null };
export type StagingTransferReview = { protocolVersion: 1; reviewId: string; reviewHash: string; targetClientId: string; staging: StagingRecoveryItem; expiresAt: string };
export type AssetBody =
  | { type: 'PreviewStagingOwnershipTransfer'; stagingId: string }
  | { type: 'TransferStagingOwnership'; stagingId: string; expectedOwnerClientId: string; expectedVersion: Seq; reviewId: string; reviewHash: string }
  | { type: 'FinalizeStaging'; stagingId: string; expectedSha256: string };
// This is an owned original, never a RasterRef. Raster qualification creates a
// separate immutable version with its exact canonical dependencies in P1b.4.
export type Asset = { id: string; version: Seq; purpose: StagingPurpose; blob: BlobRef; dependencies: readonly BlobRef[];
  safety: 'safe' | 'unknown' | 'withheld' | 'quarantined'; availability: 'available' | 'missing' | 'corrupt';
  qualification: 'opaque-text' | 'pending-decoder' | 'raster-preview' | 'canonical-raster' | 'canonical-png' | 'pending-text' | 'font'; measuredMediaType: 'text/plain' | 'image/png' | 'image/jpeg' | 'image/webp' | 'application/octet-stream'; font?: import('./text.js').FontVersion; raster?: RasterInfo };
export type AssetFact =
  | { type: 'AssetRegistered'; payload: { asset: Asset } }
  | { type: 'RasterReviewPrepared'; payload: { reviewId: string; reviewHash: string } }
  | { type: 'StagingTransferReviewPrepared'; payload: { reviewId: string; reviewHash: string } }
  | { type: 'StagingOwnershipTransferred'; payload: { stagingId: string; fromClientId: string; toClientId: string; version: Seq; committedOffset: string } };

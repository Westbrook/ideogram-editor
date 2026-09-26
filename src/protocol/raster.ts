import type { BlobRef } from './store.js';
import type { Affine, Rect } from '../raster/core.js';
export type RasterLayer = { assetId: string; transform: Affine; opacity: number; mask: null | { assetId: string; mapping: 'document-luminance-alpha-v1'; inverted: boolean } };
export type RasterBody =
  | { type: 'PrepareRaster'; assetId: string }
  | { type: 'ReviewRaster'; assetId: string }
  | { type: 'ApproveRaster'; assetId: string; reviewId: string; reviewHash: string }
  | { type: 'ComposeRaster'; width: number; height: number; layers: readonly RasterLayer[] }
  | { type: 'ExportRaster'; assetId: string };
export type RasterInfo = { schemaVersion: 1; pipeline: string; width: number; height: number; manifest: BlobRef;
  pixels: BlobRef; pixelIdentity: string; role: 'native' | 'composite' | 'export'; sourceAssetIds: readonly string[];
  conversion: null | { encodedWidth: number; encodedHeight: number; orientation: number; profile: 'untagged-srgb' | 'srgb' | 'p3'; profileHash: string | null; colorChanged: boolean; orientationChanged: boolean; resized: false } };
export type RasterReview = { protocolVersion: 1; reviewId: string; assetId: string; manifestHash: string; pixelIdentity: string; targetClientId: string; expiresAt: string; reviewHash: string; conversion: RasterInfo['conversion']; previewAssetId: string };
export type RasterTile = Rect & { hash: string };
export type RasterManifest = { schemaVersion: 1; pipeline: string; width: number; height: number; format: 'straight-srgb-rgba8';
  layout: 'row-major-tile-views-v1'; tileSize: 512; pixels: BlobRef; tiles: readonly RasterTile[];
  dependencies: readonly BlobRef[]; plan: unknown };

import type {MaskMapping} from '../raster/mapping.js';
import type { MaskPlan } from '../raster/mask.js';
import type { BlobRef } from './store.js';
import type { Affine, Rect } from '../raster/core.js';
export type RasterLayer = { assetId: string; transform: Affine; opacity: number; mask: null | MaskMapping };
export type RasterBody =
  | { type:'PrepareV45EditInputs';source:import('../request/core.js').Source;mask:import('../request/core.js').Mask|null;references:readonly import('../request/core.js').Source[] }
  | { type: 'PrepareMask'; plan: MaskPlan }
  | { type: 'PrepareRequestMask'; sourceAssetId:string;plan:MaskPlan;clip:Rect|null }
  | { type: 'InspectRasterOriginal'; assetId: string }
  | { type: 'PrepareRaster'; assetId: string; importPlan?: import('./raster-import.js').RasterImportPlan }
  | { type: 'ReviewRaster'; assetId: string }
  | { type: 'ApproveRaster'; assetId: string; reviewId: string; reviewHash: string }
  | { type: 'ComposeRaster'; width: number; height: number; layers: readonly RasterLayer[] }
  | { type: 'ExportRaster'; assetId: string; options?: import('./export.js').RasterExportOptions };
export type RasterInfo = { schemaVersion: 1 | 2 | 3; pipeline: string; width: number; height: number; manifest: BlobRef;
  pixels: BlobRef; pixelIdentity: string; role: 'native' | 'derived' | 'composite' | 'export' | 'mask'; sourceAssetIds: readonly string[];
  conversion: null | { encodedWidth: number; encodedHeight: number; orientation: number; profile: 'untagged-srgb' | 'srgb' | 'p3'; profileHash: string | null; colorChanged: boolean; orientationChanged: boolean; resized: false } };
export type RasterReview = { protocolVersion: 1; reviewId: string; assetId: string; manifestHash: string; pixelIdentity: string; targetClientId: string; expiresAt: string; reviewHash: string; conversion: RasterInfo['conversion']; previewAssetId: string; derivation?: import('./raster-import.js').DecodedDerivedPlan };
export type RasterTile = Rect & { hash: string };
export type RasterManifest = { schemaVersion: 1 | 2 | 3; pipeline: string; width: number; height: number; format: 'straight-srgb-rgba8';
  layout: 'row-major-tile-views-v1'; tileSize: 512; pixels: BlobRef; tiles: readonly RasterTile[];
  dependencies: readonly BlobRef[]; plan: unknown };

export type ContributionStack = { schemaVersion:1;kind:'cp1-contribution-stack-v1';pipeline:string;width:number;height:number;contributions:readonly {manifest:BlobRef;pixels:BlobRef;pixelIdentity:string}[] };

export type {V45PreparedRaster,V45PreparedBlack,V45PreparedReference,V45EditInputsPlan,V45EditInputs} from './v45-inputs.js';

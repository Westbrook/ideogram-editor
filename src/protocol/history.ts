import type { TextBody } from './text.js';
import type { BlobRef, Document } from './store.js';
import type { Affine } from '../raster/core.js';
import type { RasterLayer } from './raster.js';

export type DraftFence = { sessionId: string; draftId: string; generation: string };
export type LayerProperties = {
  id: string; version: string; name: string; assetId: string;
  layerToDocument: Affine; opacity: number; visible: boolean; locked: boolean;
  blend: 'normal'; mask: RasterLayer['mask'];
};
export type ImageLayer = LayerProperties & ({kind:'image'} | {kind:'text';source:BlobRef});
export type ImageState = { schemaVersion: 1 | 2 | 3 | 4; width: number; height: number; layers: ImageLayer[] };
export type ImageVersion = { state: BlobRef; semanticDigest: string; compositeAssetId: string | null };
export type HistoryBody = TextBody
  | { type: 'ImportAsset'; assetId: string; layerId: string; name: string; draft: DraftFence | null }
  | { type: 'ApplyTransform'; layerId: string; layerVersion: string; transform: Affine; draft: DraftFence | null }
  | { type: 'SetLayerProperties'; layerId: string; layerVersion: string; properties: Partial<Pick<ImageLayer, 'name' | 'opacity' | 'visible' | 'locked' | 'mask'>>; draft: DraftFence | null }
  | { type: 'DeleteLayer'; layerId: string; layerVersion: string; draft: DraftFence | null }
  | { type: 'DuplicateLayer'; layerId: string; layerVersion: string; newLayerId: string; name: string; draft: DraftFence | null }
  | { type: 'MoveLayers'; orderedLayerIds: string[]; draft: DraftFence | null }
  | { type: 'CropDocument'; x: number; y: number; width: number; height: number; draft: DraftFence | null }
  | { type: 'ResizeCanvas'; width: number; height: number; offsetX: number; offsetY: number; draft: DraftFence | null }
  | { type: 'Undo'; historyHead: string }
  | { type: 'Redo'; historyNode: string }
  | { type: 'SwitchBranch'; branchId: string; historyNode: string }
  | { type: 'SaveCheckpoint'; name: string }
  | { type: 'PrepareImageResample'; layerId: string; layerVersion: string; width: number; height: number }
  | { type: 'PrepareFlattenedCopy'; layerIds: string[]; includeHidden: boolean; hideOriginals: boolean; newLayerId: string; name: string }
  | { type: 'ReviewImageEdit'; previewId: string }
  | { type: 'ResampleImage' | 'CreateFlattenedCopy'; previewId: string; reviewId: string; reviewHash: string; draft: DraftFence | null }
  | { type: 'ExportDocument'; historyHead: string };
export type ImageEditPreview = {
  previewId: string; documentId: string; documentRevision: string;
  kind: 'resample-image' | 'flattened-copy'; plan: BlobRef; source: ImageVersion;
  preparedAssetId: string; after: ImageVersion;
};
export type ImageEditReview = { protocolVersion: 1; reviewId: string; preview: ImageEditPreview; targetClientId: string; expiresAt: string; reviewHash: string };
export type ImageHistoryNode = {
  id: string; documentId: string; branchId: string; parent: string; revision: string;
  kind: 'image-edit'; operation: HistoryBody['type'];
  before: ImageVersion; after: ImageVersion;
  forward: BlobRef; inverse: BlobRef; roots: BlobRef[];
};
// Patches describe specific semantic changes; state objects are retained versions,
// never a public arbitrary-state command or a source of executable work.
export type ImagePatch = {
  schemaVersion: 1; stateSchema?: 1 | 2 | 3 | 4; operation: HistoryBody['type'];
  dimensions: { width: number; height: number } | null;
  layers: { id: string; value: ImageLayer | null }[]; order: string[] | null;
};
export type HistoryFact =
  | { type: 'ImageEdited'; payload: { document: Document; history: ImageHistoryNode } }
  | { type: 'ImageEditPreviewPrepared'; payload: { preview: ImageEditPreview } }
  | { type: 'ImageEditReviewPrepared'; payload: { reviewId: string; reviewHash: string } }
  | { type: 'HistoryNavigated'; payload: { document: Document; previousHead: string; action: 'Undo' | 'Redo' | 'SwitchBranch' } };
export const historyCommands = ['ImportFont','CreateTextLayer','CommitTextEdit','ReplaceTextFont','RasterizeTextDerivative','ImportAsset','ApplyTransform','SetLayerProperties','DeleteLayer','DuplicateLayer','MoveLayers','CropDocument','ResizeCanvas','Undo','Redo','SwitchBranch','ExportDocument','SaveCheckpoint','PrepareImageResample','PrepareFlattenedCopy','ReviewImageEdit','ResampleImage','CreateFlattenedCopy'] as const;
export const isHistoryCommand = (type: string): boolean => (historyCommands as readonly string[]).includes(type);

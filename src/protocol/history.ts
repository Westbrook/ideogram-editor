import type { CompositionRef } from '../composition/core.js';
import type { TextBody } from './text.js';
import type { BlobRef, Document } from './store.js';
import type { Affine } from '../raster/core.js';
import type { RasterLayer } from './raster.js';

export type DraftFence = { sessionId: string; draftId: string; generation: string };
export type LayerProperties = {
  id: string; version: string; name: string; assetId: string;
  layerToDocument: Affine; opacity: number; visible: boolean; locked: boolean;
  appearanceDescription?: string;
  blend: 'normal'; mask: RasterLayer['mask'];
};
export type ImageLayer = LayerProperties & ({kind:'image'} | {kind:'text';source:BlobRef});
export type ImageState = { schemaVersion: 1 | 2 | 3 | 4 | 5; composition?:CompositionRef|null; width: number; height: number; layers: ImageLayer[] };
export type ImageVersion = { state: BlobRef; semanticDigest: string; compositeAssetId: string | null };
export type CompositionCommand = 'CommitCompositionVersion'|'AddSemanticElement'|'RemoveSemanticElement'|'ReorderSemanticElement'|'SetSemanticBinding'|'DetachSemanticBinding'|'ApprovePromptProjection';
export const compositionCommands = ['CommitCompositionVersion','AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement','SetSemanticBinding','DetachSemanticBinding','ApprovePromptProjection'] as const;
export type CandidatePlacement = { candidateId:string; mode:'safe-region'|'full-candidate'; placement:'current-document'|'new-document'; newDocumentId:string|null; actualOutput:{width:number;height:number;clipMask:boolean}|null; newLayerId:string; name:string; replacement?:{layerId:string;layerVersion:string};textTreatment?:{kind:'candidate-text-treatment-1';plan:import('../request/text-treatment.js').RequestTextTreatmentEnvelope;choice:import('../request/text-treatment.js').TreatmentAdoptionChoice} };
export type HistoryBody = TextBody
  | {type:'CreateDocument';name:string;width:number;height:number;background:import('./store.js').DocumentCreationBackground}
  | {type:CompositionCommand;composition:CompositionRef;draft:DraftFence|null}
  | {type:'SetLayerAppearance';layerId:string;layerVersion:string;description:string;draft:DraftFence|null}
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
  | { type: 'PrepareRequestSource'; scope: 'single-layer' | 'visible-document' | 'selected-layers'; layerIds: string[] }
  | ({type:'PrepareCandidateAdoption'} & CandidatePlacement)
  | ({type:'ReviewCandidatePlacement';preparation?:'encoded-rebuild'} & CandidatePlacement)
  | {type:'AdoptReviewedCandidate';reviewId:string;reviewHash:string;draft:null}
  | { type: 'PrepareImageResample'; layerId: string; layerVersion: string; width: number; height: number }
  | { type: 'PrepareFlattenedCopy'; layerIds: string[]; includeHidden: boolean; hideOriginals: boolean; newLayerId: string; name: string }
  | { type: 'ReviewImageEdit'; previewId: string }
  | { type: 'ResampleImage' | 'CreateFlattenedCopy' | 'AdoptCandidate'; previewId: string; reviewId: string; reviewHash: string; draft: DraftFence | null }
  | { type: 'ExportDocument'; historyHead: string; options?: import('./export.js').DocumentExportOptions };
export type ImageEditPreview = {
  previewId: string; documentId: string; documentRevision: string;
  kind: 'resample-image' | 'flattened-copy' | 'candidate-adoption'; plan: BlobRef; source: ImageVersion;
  preparedAssetId: string; after: ImageVersion;
  candidate?: {candidateId:string;mode:'safe-region'|'full-candidate';placement:'current-document'|'new-document';newDocumentId:string|null;textTreatment?:{kind:'candidate-text-treatment-preview-1';plan:import('../request/text-treatment.js').RequestTextTreatmentEnvelope;choice:import('../request/text-treatment.js').TreatmentAdoptionChoice;nativeOffAssetId:string;nativeOnAssetId:string};replacement?:{layerId:string;layerVersion:string};coverage:{originalEffectivePixels:number;effectivePixels:number;lostPixels:number}|null;outputMapping:import('../request/raster-plan.js').RequestOutputMapping|null};
};
export type ImageEditReview = { protocolVersion: 1; reviewId: string; preview: ImageEditPreview; targetClientId: string; expiresAt: string; reviewHash: string };
export type CandidateLetteringComparison={kind:'candidate-lettering-comparison-1';plan:import('../request/text-treatment.js').RequestTextTreatmentEnvelope;choice:import('../request/text-treatment.js').TreatmentAdoptionChoice;intent:BlobRef;intentHash:string;manifest:BlobRef;grid:{width:number;height:number};candidateAloneAssetId:string;nativeOffAssetId:string;nativeOnAssetId:string};
/** Metadata intent only. It never claims prepared output pixels or preservation. */
export type CandidateLetteringIntent={kind:'candidate-lettering-intent-1';documentId:string;documentRevision:string;source:ImageVersion;placement:CandidatePlacement;identity:import('./candidates.js').CandidateAdoptionIdentity;requestPlan:import('../request/raster-plan.js').RequestRasterPlan|null;decision:import('../request/text-treatment.js').TextTreatmentPlacementIntent;after:ImageState};
export type CandidatePlacementReview = {protocolVersion:1;kind:'candidate-placement-review-1';reviewId:string;reviewHash:string;targetClientId:string;expiresAt:string;documentId:string;documentRevision:string;source:ImageVersion;placement:CandidatePlacement;inputs:import('./candidates.js').CandidateAdoptionInputs;preparation:'deferred'|'prepared-reuse';width:number;height:number;lettering?:CandidateLetteringComparison;encodedComposition?:import('./encoded-rebuild.js').EncodedCompositionInputs;encodedCompositionRef?:BlobRef};
export type ImageHistoryNode = {
  id: string; documentId: string; branchId: string; parent: string; revision: string;
  kind: 'image-edit'; operation: HistoryBody['type'];
  before: ImageVersion; after: ImageVersion;
  forward: BlobRef; inverse: BlobRef; roots: BlobRef[]; adoptedLineage?: BlobRef;
};
// Patches describe specific semantic changes; state objects are retained versions,
// never a public arbitrary-state command or a source of executable work.
export type ImagePatch = {
  schemaVersion: 1 | 2; composition?:CompositionRef|null; stateSchema?: 1 | 2 | 3 | 4 | 5; operation: HistoryBody['type'];
  dimensions: { width: number; height: number } | null;
  layers: { id: string; value: ImageLayer | null }[]; order: string[] | null;
};
export type HistoryFact =
  | { type: 'ImageEdited'; payload: { document: Document; history: ImageHistoryNode } }
  | { type: 'ImageEditPreviewPrepared'; payload: { preview: ImageEditPreview } }
  | { type: 'ImageEditReviewPrepared'; payload: { reviewId: string; reviewHash: string } }
  | {type:'CandidatePlacementReviewPrepared';payload:{reviewId:string;reviewHash:string}}
  | { type: 'HistoryNavigated'; payload: { document: Document; previousHead: string; action: 'Undo' | 'Redo' | 'SwitchBranch' } };
export const historyCommands = [...compositionCommands,'CreateDocument','SetLayerAppearance','ImportFont','CreateTextLayer','CreateTextFromReturnedDescription','CommitTextEdit','ReplaceTextFont','SplitTextDraft','RasterizeTextDerivative','ImportAsset','ApplyTransform','SetLayerProperties','DeleteLayer','DuplicateLayer','MoveLayers','CropDocument','ResizeCanvas','Undo','Redo','SwitchBranch','ExportDocument','SaveCheckpoint','PrepareRequestSource','PrepareCandidateAdoption','AdoptCandidate','ReviewCandidatePlacement','AdoptReviewedCandidate','PrepareImageResample','PrepareFlattenedCopy','ReviewImageEdit','ResampleImage','CreateFlattenedCopy'] as const;
export const isHistoryCommand = (type: string): boolean => (historyCommands as readonly string[]).includes(type);

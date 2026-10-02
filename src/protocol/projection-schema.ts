import type {DomainEvent} from './store.js';
import {entity,event,keys,requireValue as ok} from './validate.js';

export const CURRENT_PROJECTION_SCHEMA=9;
export function supportsProjectionSchema(value:unknown):value is number {
  return typeof value==='number'&&[2,3,4,5,6,7,8,9].includes(value);
}

// Freeze the pre-LP9 projected discriminants. These are typed envelope fields,
// never arbitrary user text or recursively searched referenced metadata.
const legacyHistoryOperations=new Set(['CommitCompositionVersion','AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement','SetSemanticBinding','DetachSemanticBinding','ApprovePromptProjection','SetLayerAppearance','ImportAsset','ApplyTransform','SetLayerProperties','DeleteLayer','DuplicateLayer','MoveLayers','CropDocument','ResizeCanvas','ResampleImage','CreateFlattenedCopy','AdoptCandidate','AdoptReviewedCandidate','CreateTextLayer','CommitTextEdit','ReplaceTextFont','RasterizeTextDerivative']);
const legacyEvents=new Set(['JobQueued','QueueStateChanged','SpendGuardChanged','SpendSessionStarted','CandidateStateChanged','DocumentDeletionPreviewed','DocumentDeleted','DocumentGarbageCollected','BundlePrepared','BundleImportReviewed','PortableCancelled','BundleImported','ImageEditPreviewPrepared','ImageEditReviewPrepared','CandidatePlacementReviewPrepared','AssetRegistered','StagingTransferReviewPrepared','RasterReviewPrepared','StagingOwnershipTransferred','DocumentCreated','ImageEdited','HistoryNavigated','CheckpointSaved']);
function legacyDocument(value:any){
  keys(value,['id','revision','branchId','width','height','color','depth','orderedLayerIds','historyHead','checkpoint','compositionVersion',...(value.image?['image','redo']:[])]);
}
function legacyEntity(type:string,value:any){
  if(type==='document')legacyDocument(value);
  else if(type==='history'){
    if(value.kind==='image-edit')ok(legacyHistoryOperations.has(value.operation),'Projection schema requires LP9');
    else{legacyDocument(value.forward.after);legacyDocument(value.inverse.before);}
  }else if(type==='asset')ok(value.raster?.role!=='derived','Projection schema requires LP9');
}
export function projectionEntity(schema:number,type:string,value:any):string {
  ok(supportsProjectionSchema(schema),'Unsupported projection schema');
  const version=entity(type,value);
  if(schema<9)legacyEntity(type,value);
  return version;
}
export function projectionEvent(schema:number,value:any):asserts value is DomainEvent {
  ok(supportsProjectionSchema(schema),'Unsupported projection schema');event(value);
  if(schema>=9)return;
  ok(legacyEvents.has(value.type),'Projection schema requires LP9');
  if(value.type==='DocumentCreated'||value.type==='ImageEdited'||value.type==='HistoryNavigated'||value.type==='BundleImported')legacyDocument(value.payload.document);
  if(value.type==='DocumentCreated'||value.type==='ImageEdited')legacyEntity('history',value.payload.history);
  if(value.type==='AssetRegistered')legacyEntity('asset',value.payload.asset);
  if(value.type==='BundlePrepared')ok(value.payload.bundle.complete===true&&value.payload.bundle.status==='copy-ready','Projection schema requires LP9');
  if(value.type==='ImageEditPreviewPrepared'){
    const preview=value.payload.preview;ok(['resample-image','flattened-copy','candidate-adoption'].includes(preview.kind),'Projection schema requires LP9');
    if(preview.kind==='candidate-adoption')ok(preview.candidate!==undefined&&!Object.hasOwn(preview.candidate,'textTreatment'),'Projection schema requires LP9');
  }
}

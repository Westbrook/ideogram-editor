import {lineageRecord,lineageAssetIds,type AdoptedCandidateLineage} from '../portable/lineage.js';
import {retainedMetadataReferences,validateRetainedRasterMetadata} from '../portable/retained.js';
import {requestAssetIds} from '../portable/candidates.js';
import {textRefs} from '../../src/protocol/text.js';
import {candidateDocument,candidateDocumentSeed} from './candidate-document.js';
import {CompositionError} from '../../src/composition/core.js';
import {compositionDraft,compositionDraftRefs} from '../../src/composition/draft.js';
import {readComposition,validateCommit,compositionRefs,imagePatch} from './composition.js';
import {maskGrid,retainedMask,r16Mask,translateMask} from '../../src/raster/mapping.js';
import {maskDraftValue,maskBindings,resolveMaskPlan} from '../../src/raster/mask.js';
import type { Texts } from './text.js';
import type { TextCandidate } from '../../src/protocol/text.js';
import { document as validateDocument, imageEditPreview as validatePreview } from '../../src/protocol/validate.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobRef, Command, Document, Receipt, HistoryNode, DomainEvent } from '../../src/protocol/store.js';
import type { Asset, AssetFact } from '../../src/protocol/assets.js';
import type { ImageState, ImageVersion, ImageHistoryNode, ImagePatch, HistoryFact, HistoryBody, ImageEditPreview, ImageEditReview, CandidatePlacement, CandidatePlacementReview } from '../../src/protocol/history.js';
import { isHistoryCommand } from '../../src/protocol/history.js';
import { imageState } from '../../src/protocol/history-validation.js';
import type { Objects, Barrier } from './objects.js';
import type { Assets, AssetAuth } from './assets.js';
import { AssetRejection } from './assets.js';
import type { Candidates } from './candidates.js';
import type { CandidateAdoptionInputs, CandidateAdoptionIdentity } from '../../src/protocol/candidates.js';
import type { RequestRasterPlan, RequestOutputMapping } from '../../src/request/raster-plan.js';
import type { RequestSourceCapture } from '../../src/protocol/request-edits.js';
import type { Rasters } from './raster.js';
import type { UIStore } from './ui.js';
import { canonical, hashBytes, isId, isSeq, parseCommand } from './canonical.js';
import { StoreError } from './errors.js';

export type HistoryBuild = { facts: (HistoryFact|AssetFact|Pick<Extract<DomainEvent,{type:'DocumentCreated'}>,'type'|'payload'>|{type:'CheckpointSaved';payload:{checkpoint:import('../../src/protocol/store.js').Checkpoint}})[]; documentChanged: boolean; exportRevision?: string };
export type HistoryCommit = (bytes:Uint8Array,build:(document:Document,revision:string)=>HistoryBuild,creating?:Document)=>Receipt;
type Proof = {ref:BlobRef;token:string};
// This one fixed receipt detail is installed before accepting HTTP work. A user
// can cancel while both large-transfer slots are occupied without a third slot.
export const EXPORT_CANCELLATION_JSON=canonical({kind:'fields',issues:[{path:'command.body',code:'EXPORT_CANCELED'}]});
export const EXPORT_CANCELLATION_REF:BlobRef={hash:hashBytes(EXPORT_CANCELLATION_JSON),byteLength:String(Buffer.byteLength(EXPORT_CANCELLATION_JSON)),mediaType:'application/json'};
export const semanticDigest=(state:ImageState)=>hashBytes(canonical({...state,layers:state.layers.map(({version,...l})=>l)}));
export class Histories {
  private running:Promise<void>|undefined;private runningId:string|undefined;private closing=false;private paused=new Set<string>();
  private authorities=new Map<string,{auth:AssetAuth;started:number}>();
  observations:Record<string,unknown>[]=[];
  constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private rasters:Rasters,private ui:UIStore,private texts:Texts,private candidates:Candidates,
    private check:()=>void,private barrier:Barrier,private commit:HistoryCommit,
    private document:(id:string)=>Document|null,private register:(owner:string,ref:BlobRef,proof?:string)=>void){}
  state(id:string):ImageState {
    const d=this.document(id);if(!d)throw new StoreError('NOT_FOUND');
    return d.image?this.versionState(d.image):{schemaVersion:1,width:d.width,height:d.height,layers:[]};
  }
  versionState(version:ImageVersion):ImageState {
    const bytes=this.objects.verify(version.state,true)!,value=JSON.parse(Buffer.from(bytes).toString('utf8'));
    try{imageState(value);if(canonical(value)!==Buffer.from(bytes).toString('utf8')||semanticDigest(value)!==version.semanticDigest)throw new Error();}
    catch{throw new StoreError('CORRUPT_OBJECT');}return value;
  }
  private node(id:string):HistoryNode|ImageHistoryNode {
    const row=this.db.prepare('SELECT json FROM history WHERE id=?').get(id);if(!row)throw new AssetRejection('INVALID_INPUT','HISTORY_NODE_REQUIRED');return JSON.parse(String(row.json));
  }
  private child(parent:string,branchId:string):string|null {
    const rows=this.db.prepare("SELECT id FROM history WHERE json_extract(json,'$.parent')=? AND json_extract(json,'$.branchId')=? ORDER BY id LIMIT 2").all(parent,branchId);
    if(rows.length>1)throw new StoreError('CORRUPT_STORE');return rows.length?String(rows[0].id):null;
  }
  preview(id:string,auth:AssetAuth):ImageEditPreview {
    this.check();if(!isId(id))throw new StoreError('MALFORMED_REQUEST');
    const row=this.db.prepare('SELECT client_id,json FROM image_previews WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');
    if(row.client_id!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
    const preview=JSON.parse(String(row.json));try{validatePreview(preview);}catch{throw new StoreError('CORRUPT_STORE');}return preview;
  }
  review(id:string,auth:AssetAuth):ImageEditReview|CandidatePlacementReview {
    if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM image_edit_reviews WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');
    const review=JSON.parse(String(row.json)) as ImageEditReview|CandidatePlacementReview;
    if(review.targetClientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
    if(row.session_hash!==auth.sessionHash||row.epoch!==this.epoch()||auth.now>=Date.parse(review.expiresAt))throw new StoreError('REVIEW_EXPIRED');return review;
  }
  private epoch(){return String(this.db.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get()!.value);}
  private authority(commandId:string):AssetAuth {
    const saved=this.authorities.get(commandId);if(!saved)throw new AssetRejection('INVALID_INPUT','IMAGE_REVIEW_EXPIRED');
    const auth={...saved.auth,now:saved.auth.now+Math.floor(performance.now()-saved.started)};
    const binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);
    if(auth.now>=auth.expires||!binding||binding.client_id!==auth.clientId||auth.now>=Number(binding.expires))throw new AssetRejection('INVALID_INPUT','IMAGE_REVIEW_EXPIRED');return auth;
  }
  private approved(c:Command,document:Document):ImageEditPreview {
    const b=c.body;if(b.type!=='ResampleImage'&&b.type!=='CreateFlattenedCopy'&&b.type!=='AdoptCandidate')throw new StoreError('UNSUPPORTED_COMMAND');
    let preview:ImageEditPreview,review:ImageEditReview;
    try{const auth=this.authority(c.commandId);preview=this.preview(b.previewId,auth);const found=this.review(b.reviewId,auth);if('kind'in found)throw new Error('IMAGE_PREVIEW_KIND');review=found;}catch(e){if(e instanceof AssetRejection)throw e;throw new AssetRejection('INVALID_INPUT','IMAGE_REVIEW_EXPIRED');}
    const sourceMatches=document.image?canonical(preview.source)===canonical(document.image):preview.source.compositeAssetId===null&&canonical(this.versionState(preview.source))===canonical({schemaVersion:1,width:document.width,height:document.height,layers:[]});
    if(review.reviewHash!==b.reviewHash||canonical(review.preview)!==canonical(preview)||preview.documentId!==document.id||preview.documentRevision!==document.revision||!sourceMatches)throw new AssetRejection('STALE_REVISION','IMAGE_PREVIEW_CHANGED');
    if(preview.kind!==(b.type==='ResampleImage'?'resample-image':b.type==='AdoptCandidate'?'candidate-adoption':'flattened-copy'))throw new AssetRejection('INCOMPATIBLE','IMAGE_PREVIEW_KIND');if(b.type==='AdoptCandidate'){if(this.candidatePlan(preview).command.placement!=='current-document')throw new AssetRejection('INCOMPATIBLE','NEW_DOCUMENT_COMMAND_REQUIRED');this.checkCandidatePreview(preview);}return preview;
  }
  pending(id:string){
    if(!isId(id))throw new StoreError('MALFORMED_REQUEST');
    const r=this.db.prepare('SELECT * FROM history_preparations WHERE id=?').get(id);if(!r)return null;
    const request=parseCommand(Buffer.from(String(r.original))),c=request.command;
    if(c.commandId!==id||canonical(request)!==r.canonical||hashBytes(String(r.canonical))!==r.hash||!isId(r.operation_id)||!isHistoryCommand(c.body.type)||!['preparing','waiting-for-resources'].includes(String(r.phase)))throw new StoreError('CORRUPT_STORE');
    try{const frozen=JSON.parse(String(r.frozen));if(canonical(frozen)!==r.frozen)throw new Error();if(c.body.type==='ExportDocument'){if(frozen!==null)validateDocument(frozen);}else if(frozen!==null)throw new Error();}catch{throw new StoreError('CORRUPT_STORE');}
    return {command:c,hash:String(r.hash),operationId:String(r.operation_id),phase:String(r.phase) as 'preparing'|'waiting-for-resources'};
  }
  command(bytes:Uint8Array,auth:AssetAuth):Receipt|null {
    this.check();const request=parseCommand(bytes),c=request.command,serialized=canonical(request),hash=hashBytes(serialized);
    if(c.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');if(!isHistoryCommand(c.body.type))throw new StoreError('UNSUPPORTED_COMMAND');
    const prior=this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);
    if(prior){if(prior.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return JSON.parse(String(prior.receipt));}
    for(const table of ['asset_preparations','raster_preparations','portable_preparations'])if(this.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(c.commandId))throw new StoreError('COMMAND_ID_REUSE');
    const pending=this.pending(c.commandId);if(pending){if(pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');if(['ReviewCandidatePlacement','AdoptReviewedCandidate','ReviewImageEdit','ResampleImage','CreateFlattenedCopy','AdoptCandidate','ImportFont','CreateTextLayer','CommitTextEdit','ReplaceTextFont','RasterizeTextDerivative'].includes(c.body.type))this.authorities.set(c.commandId,{auth:{...auth},started:performance.now()});this.paused.delete(c.commandId);this.schedule(true);return null;}
    if(Number(this.db.prepare('SELECT (SELECT count(*) FROM asset_preparations)+(SELECT count(*) FROM raster_preparations)+(SELECT count(*) FROM history_preparations)+(SELECT count(*) FROM portable_preparations) AS n').get()!.n)>=64)throw new StoreError('QUEUE_FULL');
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('INSERT INTO history_preparations VALUES (?,?,?,?,?,?,?)').run(c.commandId,hash,Buffer.from(bytes).toString('utf8'),serialized,randomUUID(),'preparing',canonical(c.body.type==='ExportDocument'?this.document(c.documentId!):null));
      this.barrier('history-preparation-before-commit');this.db.exec('COMMIT');this.barrier('history-preparation-after-commit');if(c.body.type==='ResampleImage'||c.body.type==='CreateFlattenedCopy'||c.body.type==='AdoptCandidate')this.barrier('image-edit-preparation-after-commit');
    }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
    if(['ReviewCandidatePlacement','AdoptReviewedCandidate','ReviewImageEdit','ResampleImage','CreateFlattenedCopy','AdoptCandidate','ImportFont','CreateTextLayer','CommitTextEdit','ReplaceTextFont','RasterizeTextDerivative'].includes(c.body.type))this.authorities.set(c.commandId,{auth:{...auth},started:performance.now()});
    this.schedule(true);return null;
  }
  async cancelExport(id:string,auth:AssetAuth):Promise<import('../../src/protocol/export.js').ExportCancellation>{
    this.check();if(!isId(id))throw new StoreError('MALFORMED_REQUEST');
    const row=this.db.prepare('SELECT canonical,receipt FROM commands WHERE id=?').get(id),pending=row?null:this.pending(id);
    const command=row?JSON.parse(String(row.canonical)).command as Command:pending?.command;
    if(!command)throw new StoreError('NOT_FOUND');
    if(command.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
    if(command.body.type!=='ExportDocument')throw new StoreError('MALFORMED_REQUEST');
    const receipt:Receipt=row?JSON.parse(String(row.receipt)):this.commit(Buffer.from(String(this.db.prepare('SELECT original FROM history_preparations WHERE id=?').get(id)!.original)),()=>{throw new AssetRejection('INVALID_INPUT','EXPORT_CANCELED');});
    // The exact original command becomes terminal before stopping IO. Replays
    // now return this same receipt and can never resurrect its preparation.
    const running=this.runningId===id?this.running:undefined;
    if(running){await this.rasters.stopDocumentExport(id);await running;}
    this.rasters.cleanupDocumentExport(id);
    const canceled=receipt.status==='rejected'&&receipt.code==='INVALID_INPUT'&&JSON.parse(Buffer.from(this.objects.verify(receipt.details,true)!).toString('utf8')).issues?.some((issue:{code?:string})=>issue.code==='EXPORT_CANCELED');
    return {protocolVersion:1,commandId:id,status:canceled?'canceled':'completed',receipt};
  }
  schedule(retry=false){
    if(this.closing||this.running)return;
    setImmediate(()=>{
      if(this.closing||this.running||!this.rasters.documentAvailable)return;
      const row=this.db.prepare("SELECT id FROM history_preparations WHERE phase='preparing' OR ? ORDER BY id LIMIT 64").all(retry?1:0).find(r=>!this.paused.has(String(r.id)));
      if(!row)return;const id=String(row.id),slot='history:'+id;try{this.objects.acquire(slot);}catch{return;}
      this.runningId=id;this.running=this.prepare(id,slot).catch(()=>{this.pause(id);}).finally(()=>{this.running=undefined;this.runningId=undefined;this.objects.unreserve(slot);this.objects.release(slot);this.schedule();});
    });
  }
  private pause(id:string){this.paused.add(id);try{this.db.prepare("UPDATE history_preparations SET phase='waiting-for-resources' WHERE id=?").run(id);}catch{}}
  private assertCommand(c:Command,d:Document|null){
    if(!d||!c.documentId||d.id!==c.documentId)throw new AssetRejection('INVALID_INPUT','DOCUMENT_REQUIRED');
    if(c.expectedDocumentRevision!==d.revision)throw new AssetRejection('STALE_REVISION','REVISION_CHANGED',d.revision);
    if('draft' in c.body){let layerId='layerId' in c.body&&c.body.type!=='CreateTextLayer'?c.body.layerId:null;
      if(c.body.type==='ResampleImage'&&c.body.draft){const preview=this.preview(c.body.previewId,this.authority(c.commandId));layerId=JSON.parse(Buffer.from(this.objects.verify(preview.plan,true)!).toString('utf8')).layerId;}
      const draft=this.ui.fence(c.clientId,c.body.draft,d.id,c.expectedDocumentRevision,layerId);
      if(draft?.kind==='composition'){if(!('composition'in c.body))throw new AssetRejection('INVALID_INPUT','COMPOSITION_DRAFT_COMMAND_MISMATCH');const asset=this.assets.asset(draft.assetId);if(!asset)throw new AssetRejection('MISSING_ASSET','DRAFT_MISSING');const envelope=JSON.parse(Buffer.from(this.objects.verify(asset.blob,true)!).toString());compositionDraft(envelope);const graph=JSON.parse(Buffer.from(this.objects.verify(envelope.graph,true)!).toString());const value=readComposition(c.body.composition,r=>this.objects.verify(r,true)!);if(canonical(graph.composition)!==canonical(value)||canonical(draft.compositionBindings)!==canonical(c.body.composition.bindings))throw new AssetRejection('STALE_REVISION','COMPOSITION_DRAFT_CHANGED');return draft;}
      if(draft&&(draft.kind==='mask'||(c.body.type==='SetLayerProperties'&&c.body.properties.mask))){
        const b=c.body;
        if(draft.kind!=='mask'||b.type!=='SetLayerProperties'||Object.keys(b.properties).length!==1||!b.properties.mask||b.properties.mask.mapping!=='document-r16-v1'||b.properties.mask.inverted)throw new AssetRejection('INVALID_INPUT','MASK_DRAFT_COMMAND_MISMATCH');
        const caption=this.assets.asset(draft.assetId),mask=this.assets.asset(b.properties.mask.assetId);
        if(!caption||caption.qualification!=='opaque-text'||caption.safety!=='safe'||caption.availability!=='available'||!mask||mask.raster?.role!=='mask'||mask.safety!=='safe'||mask.availability!=='available')throw new AssetRejection('MISSING_ASSET','MASK_DRAFT_DEPENDENCY_MISSING');
        const value=JSON.parse(Buffer.from(this.objects.verify(caption.blob,true)!).toString('utf8'));
        try{maskDraftValue(value);maskBindings(value.plan,draft.maskBindings!);}catch{throw new AssetRejection('INVALID_INPUT','MASK_DRAFT_INVALID');}
        const layer=this.state(d.id).layers.find(l=>l.id===b.layerId);
        if(value.layerVersion!==b.layerVersion||layer?.version!==b.layerVersion)throw new AssetRejection('STALE_REVISION','MASK_DRAFT_LAYER_CHANGED');
        const plan=resolveMaskPlan(value.plan,draft.maskBindings!);
        const prepared=this.rasters.manifest(mask.id).plan as {kind:string;authoring:unknown};
        if(plan.width!==d.width||plan.height!==d.height||!value.radius.trim()||Number(value.radius)!==plan.feather||prepared.kind!==(plan.schemaVersion===2?'authored-mask-v2':'authored-mask-v1')||canonical(prepared.authoring)!==canonical(plan))throw new AssetRejection('INVALID_INPUT','MASK_DRAFT_PLAN_MISMATCH');
        return draft;
      }
    }
  }
  private edit(c:Command,d:Document,before:ImageState):ImageState {
    const b=c.body as HistoryBody,state=structuredClone(before);
    if('layerId' in b&&b.type!=='ImportAsset'&&b.type!=='CreateTextLayer'){
      const layer=state.layers.find(l=>l.id===b.layerId);if(!layer)throw new AssetRejection('STALE_REVISION','LAYER_MISSING',d.revision);
      if(layer.version!==b.layerVersion)throw new AssetRejection('STALE_REVISION','LAYER_VERSION_CHANGED',d.revision);
      if(layer.locked&&!(b.type==='SetLayerProperties'&&Object.keys(b.properties).length===1&&b.properties.locked===false))throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED',d.revision);
      if(b.type==='ApplyTransform')layer.layerToDocument=b.transform;
      else if(b.type==='SetLayerProperties')Object.assign(layer,b.properties);
      else if(b.type==='SetLayerAppearance'){layer.appearanceDescription=b.description;state.schemaVersion=5;state.composition??=null;}
      else if(b.type==='DeleteLayer')state.layers=state.layers.filter(l=>l.id!==layer.id);
      else if(b.type==='DuplicateLayer'){
        if(state.layers.some(l=>l.id===b.newLayerId)||this.usedLayer(d.id,b.newLayerId))throw new AssetRejection('INVALID_INPUT','LAYER_ID_REUSE');
        state.layers.splice(state.layers.indexOf(layer)+1,0,{...structuredClone(layer),id:b.newLayerId,version:'1',name:b.name});
      }
      if(b.type!=='DuplicateLayer'&&b.type!=='DeleteLayer')layer.version=String(BigInt(layer.version)+1n);
    }else if(b.type==='ImportAsset'){
      const a=this.assets.asset(b.assetId);if(!a?.raster||a.raster.role==='mask'||a.qualification!=='canonical-raster'||a.safety!=='safe'||a.availability!=='available')throw new AssetRejection('INCOMPATIBLE','APPROVED_RASTER_REQUIRED');
      if(this.usedLayer(d.id,b.layerId))throw new AssetRejection('INVALID_INPUT','LAYER_ID_REUSE');
      state.layers.push({id:b.layerId,version:'1',kind:'image',name:b.name,assetId:b.assetId,layerToDocument:[1,0,0,1,0,0],opacity:1,visible:true,locked:false,blend:'normal',mask:null});
    }else if(b.type==='MoveLayers'){
      if(b.orderedLayerIds.length!==state.layers.length||b.orderedLayerIds.some(id=>!state.layers.some(l=>l.id===id)))throw new AssetRejection('STALE_REVISION','LAYER_ORDER_CHANGED');
      if(state.layers.some(l=>l.locked&&b.orderedLayerIds.indexOf(l.id)!==state.layers.indexOf(l)))throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');
      state.layers=b.orderedLayerIds.map(id=>state.layers.find(l=>l.id===id)!);
    }else if(b.type==='CropDocument'||b.type==='ResizeCanvas'){
      const dx=b.type==='CropDocument'?-b.x:b.offsetX,dy=b.type==='CropDocument'?-b.y:b.offsetY;
      if(b.type==='CropDocument'&&(b.x<0||b.y<0||b.x+b.width>d.width||b.y+b.height>d.height))throw new AssetRejection('INVALID_INPUT','CROP_OUTSIDE_DOCUMENT');
      if((dx||dy)&&state.layers.some(l=>l.locked))throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');
      state.width=b.width;state.height=b.height;
      for(const l of state.layers){
        const changed=!!(dx||dy)||!!l.mask&&!retainedMask(l.mask);
        if(l.mask)try{l.mask=translateMask(l.mask,before.width,before.height,dx,dy);}catch{throw new AssetRejection('INVALID_INPUT','MASK_ORIGIN_UNSAFE');}
        if(dx||dy){const [a,bb,c,dd,e,f]=l.layerToDocument;l.layerToDocument=[a,bb,c,dd,e+dx,f+dy];}
        if(changed)l.version=String(BigInt(l.version)+1n);
      }
    }else throw new StoreError('UNSUPPORTED_COMMAND');
    if(state.layers.length>100)throw new AssetRejection('CAPACITY','DOCUMENT_LAYER_LIMIT');
    if(state.schemaVersion<5&&state.layers.some(l=>l.mask&&retainedMask(l.mask)))state.schemaVersion=4;
    else if(state.schemaVersion<3&&state.layers.some(l=>l.mask?.mapping==='document-r16-v1'))state.schemaVersion=3;
    try{imageState(state);}catch{throw new AssetRejection('INVALID_INPUT','INVALID_IMAGE_STATE');}
    for(const l of state.layers)if(l.mask){const a=this.assets.asset(l.mask.assetId),g=maskGrid(l.mask,state.width,state.height);if(!a?.raster||a.qualification!=='canonical-raster'||a.safety!=='safe'||a.raster.width!==g.width||a.raster.height!==g.height||r16Mask(l.mask)!==(a.raster.role==='mask'))throw new AssetRejection('INCOMPATIBLE','MASK_MAPPING_REVIEW_REQUIRED');}
    return state;
  }
  private usedComposition(documentId:string,id:string):boolean {
    // Retained inactive branches and imported histories keep their version IDs.
    for(const row of this.db.prepare("SELECT json FROM history WHERE json_extract(json,'$.documentId')=? AND json_extract(json,'$.operation') IN ('CommitCompositionVersion','AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement','SetSemanticBinding','DetachSemanticBinding','ApprovePromptProjection')").iterate(documentId)){
      const h=JSON.parse(String(row.json));if(this.versionState(h.after).composition?.id===id)return true;
    }
    return false;
  }
  private usedLayer(documentId:string,id:string):boolean {
    // Layer IDs are never recycled, including identities only on inactive branches.
    if(this.document(documentId)?.orderedLayerIds.includes(id))return true;
    if(this.db.prepare("SELECT 1 FROM history h,json_each(h.json,'$.forward.after.orderedLayerIds') layer WHERE h.document_id=? AND layer.value=? LIMIT 1").get(documentId,id))return true;
    if(this.db.prepare("SELECT 1 FROM portable_maps m JOIN portable_namespaces n ON n.id=m.namespace WHERE n.document_id=? AND m.kind='layer' AND m.local_id=? LIMIT 1").get(documentId,id))return true;
    // Deferred reviews do not reserve layer IDs; an accepted deferred edit roots
    // its actual layer identity in history even after Undo or a branch switch.
    for(const row of this.db.prepare("SELECT json FROM history WHERE document_id=? AND json_extract(json,'$.operation')='AdoptReviewedCandidate'").iterate(documentId))if(this.versionState(JSON.parse(String(row.json)).after).layers.some(layer=>layer.id===id))return true;
    return !!this.db.prepare("SELECT 1 FROM commands WHERE json_extract(canonical,'$.command.documentId')=? AND json_extract(receipt,'$.status')='accepted' AND json_extract(canonical,'$.command.body.type')!='ReviewCandidatePlacement' AND (json_extract(canonical,'$.command.body.layerId')=? OR json_extract(canonical,'$.command.body.newLayerId')=?) LIMIT 1").get(documentId,id,id);
  }
  private patch(before:ImageState,after:ImageState,operation:HistoryBody['type']):ImagePatch {
    return imagePatch(before,after,operation);
  }
  private async prepareImagePreview(c:Command,document:Document,before:ImageState,source:ImageVersion,previewId:string,slot:string,check:()=>void,
    metadata:(value:unknown)=>Promise<BlobRef>,proofs:Proof[]):Promise<{preview:ImageEditPreview;facts:AssetFact[]}> {
    const b=c.body;if(b.type!=='PrepareImageResample'&&b.type!=='PrepareFlattenedCopy')throw new StoreError('UNSUPPORTED_COMMAND');
    const after=structuredClone(before),facts:AssetFact[]=[];let width:number,height:number,layers:import('../../src/protocol/raster.js').RasterLayer[];
    if(b.type==='PrepareImageResample'){
      const l=after.layers.find(l=>l.id===b.layerId);if(!l||l.version!==b.layerVersion)throw new AssetRejection('STALE_REVISION','LAYER_VERSION_CHANGED');
      if(l.kind!=='image')throw new AssetRejection('INCOMPATIBLE','TEXT_RASTERIZE_REQUIRED');if(l.locked)throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');const a=this.assets.asset(l.assetId);if(!a?.raster)throw new AssetRejection('MISSING_ASSET','IMAGE_SOURCE_MISSING');
      width=b.width;height=b.height;layers=[{assetId:l.assetId,transform:[width/a.raster.width,0,0,height/a.raster.height,0,0],opacity:1,mask:null}];
    }else{
      if(this.usedLayer(document.id,b.newLayerId)||after.layers.length>=100)throw new AssetRejection('CAPACITY','NEW_LAYER_UNAVAILABLE');
      if(b.layerIds.some(id=>!after.layers.some(l=>l.id===id)))throw new AssetRejection('STALE_REVISION','LAYER_MISSING');
      const selected=after.layers.filter(l=>b.layerIds.includes(l.id)&&(b.includeHidden||l.visible));if(!selected.length)throw new AssetRejection('INVALID_INPUT','EMPTY_SOURCE_SELECTION');
      if(b.hideOriginals&&selected.some(l=>l.locked))throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');
      width=before.width;height=before.height;layers=selected.map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask}));
    }
    const prepared=await this.rasters.prepareDocument({type:'ComposeRaster',width,height,layers},randomUUID(),slot,check);proofs.push(...prepared.proofs);facts.push({type:'AssetRegistered',payload:{asset:prepared.asset}});
    if(b.type==='PrepareImageResample'){
      const l=after.layers.find(l=>l.id===b.layerId)!;l.assetId=prepared.asset.id;l.version=String(BigInt(l.version)+1n);
    }else{
      if(b.hideOriginals)for(const l of after.layers)if(b.layerIds.includes(l.id)&&(b.includeHidden||l.visible)){l.visible=false;l.version=String(BigInt(l.version)+1n);}
      after.layers.push({id:b.newLayerId,version:'1',kind:'image',name:b.name,assetId:prepared.asset.id,layerToDocument:[1,0,0,1,0,0],opacity:1,visible:true,locked:false,blend:'normal',mask:null});
    }
    imageState(after);
    // The review includes the actual resulting full document. Flattening an
    // interleaved selection can change the result; no grouping equality is claimed.
    const composite=await this.rasters.prepareDocument({type:'ComposeRaster',width:after.width,height:after.height,layers:after.layers.filter(l=>l.visible).map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask}))},randomUUID(),slot,check,prepared.asset);
    proofs.push(...composite.proofs);facts.push({type:'AssetRegistered',payload:{asset:composite.asset}});
    return {facts,preview:{previewId,documentId:document.id,documentRevision:document.revision,kind:b.type==='PrepareImageResample'?'resample-image':'flattened-copy',plan:await metadata(b),source,preparedAssetId:prepared.asset.id,after:{state:await metadata(after),semanticDigest:semanticDigest(after),compositeAssetId:composite.asset.id}}};
  }
  private candidatePlan(preview:ImageEditPreview){
    const bytes=this.objects.verify(preview.plan,true)!,plan=JSON.parse(Buffer.from(bytes).toString('utf8')) as {command:Extract<HistoryBody,{type:'PrepareCandidateAdoption'}>;identity:CandidateAdoptionIdentity;requestPlan:RequestRasterPlan|null;outputMapping:RequestOutputMapping|null;lineage?:BlobRef;sourceCapture:RequestSourceCapture|null};
    if(preview.kind!=='candidate-adoption'||canonical(plan)!==Buffer.from(bytes).toString('utf8')||plan.command?.type!=='PrepareCandidateAdoption'||!plan.identity)throw new StoreError('CORRUPT_OBJECT');
    return plan;
  }
  private checkCandidatePreview(preview:ImageEditPreview){this.candidates.checkAdoption(this.candidatePlan(preview).identity);}
  private adoptedLineage(identity:CandidateAdoptionIdentity):AdoptedCandidateLineage {
    this.candidates.checkAdoption(identity);
    const jobRow=this.db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(identity.jobId),resultRow=this.db.prepare('SELECT json FROM candidate_jobs WHERE job_id=?').get(identity.attemptId),candidateRow=this.db.prepare('SELECT json FROM candidates WHERE id=?').get(identity.candidateId);
    if(!jobRow||!resultRow||!candidateRow)throw new AssetRejection('STALE_REVISION','CANDIDATE_CHANGED');
    const job=JSON.parse(String(jobRow.json)),retained=JSON.parse(String(resultRow.json)),candidate=JSON.parse(String(candidateRow.json));
    const specification=job.review.request,requestIds=requestAssetIds(specification),request={endpoint:job.review.endpoint,prompt:job.review.prompt,seed:specification.settings.seed.kind==='integer'?specification.settings.seed.decimal:null,specification,assetBindings:Object.fromEntries(requestIds.map(id=>[id,id]))};
    const value={kind:'adopted-candidate-lineage-1',inert:true,candidate,result:{id:retained.attemptId,jobId:retained.jobId,documentId:retained.documentId,requestedCount:retained.requestedCount,actualCount:retained.actualCount,phase:retained.observation.phase,provenance:retained.provenance,inert:true,request},assetBindings:Object.fromEntries([...new Set([...requestIds,candidate.encodedAssetId,candidate.preparedAssetId])].map(id=>[id,id]))};
    try{lineageRecord(value);}catch{throw new AssetRejection('INCOMPATIBLE','CANDIDATE_LINEAGE_UNAVAILABLE');}return value;
  }

  private approvedCreation(c:Command):ImageEditPreview {
    const b=c.body;if(b.type!=='AdoptCandidate'||c.expectedDocumentRevision!==null||b.draft!==null)throw new AssetRejection('INVALID_INPUT','NEW_DOCUMENT_COMMAND_REQUIRED');
    let preview:ImageEditPreview,review:ImageEditReview;
    try{const auth=this.authority(c.commandId);preview=this.preview(b.previewId,auth);const found=this.review(b.reviewId,auth);if('kind'in found)throw new Error('IMAGE_PREVIEW_KIND');review=found;}catch(e){if(e instanceof AssetRejection)throw e;throw new AssetRejection('INVALID_INPUT','IMAGE_REVIEW_EXPIRED');}
    if(preview.kind!=='candidate-adoption'||review.reviewHash!==b.reviewHash||canonical(review.preview)!==canonical(preview))throw new AssetRejection('STALE_REVISION','IMAGE_PREVIEW_CHANGED');
    const plan=this.candidatePlan(preview);
    if(!plan.lineage||plan.command.placement!=='new-document'||plan.command.newDocumentId!==c.documentId)throw new AssetRejection('INVALID_INPUT','NEW_DOCUMENT_COMMAND_REQUIRED');
    if(this.document(c.documentId!)||this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(c.documentId!))throw new AssetRejection('INVALID_INPUT','DOCUMENT_ID_REUSE');
    this.candidates.checkAdoption(plan.identity);return preview;
  }
  private approvedPlacement(c:Command):{review:CandidatePlacementReview;document:Document;before:ImageState}{
    const b=c.body;if(b.type!=='AdoptReviewedCandidate')throw new StoreError('UNSUPPORTED_COMMAND');
    let review:CandidatePlacementReview;
    try{const value=this.review(b.reviewId,this.authority(c.commandId));if(!('kind'in value)||value.kind!=='candidate-placement-review-1')throw new Error();review=value;}catch(e){if(e instanceof AssetRejection)throw e;throw new AssetRejection('INVALID_INPUT','IMAGE_REVIEW_EXPIRED');}
    const {reviewHash,...content}=review;
    if(reviewHash!==b.reviewHash||hashBytes(canonical(content))!==reviewHash)throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
    const document=this.document(review.documentId);if(!document||document.revision!==review.documentRevision)throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
    const before=this.state(document.id),sourceMatches=document.image?canonical(document.image)===canonical(review.source):review.source.compositeAssetId===null&&canonical(this.versionState(review.source))===canonical(before);
    if(!sourceMatches)throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
    if(review.placement.placement==='new-document'){
      if(c.documentId!==review.placement.newDocumentId||c.expectedDocumentRevision!==null)throw new AssetRejection('INVALID_INPUT','NEW_DOCUMENT_COMMAND_REQUIRED');
    }else{if(c.documentId!==document.id)throw new AssetRejection('INVALID_INPUT','CANDIDATE_DOCUMENT_MISMATCH');this.assertCommand(c,document);}
    if(review.inputs.identity.documentId!==document.id||review.inputs.identity.candidateId!==review.placement.candidateId||review.inputs.mode!==review.placement.mode)throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
    this.candidates.checkAdoption(review.inputs.identity);
    this.candidatePlacementState(review.placement,document,before,review.source,review.width,review.height,review.inputs.identity.preparedAssetId,review.inputs.sourceCapture);
    return {review,document,before};
  }
  private candidatePlacementState(b:CandidatePlacement,document:Document,before:ImageState,source:ImageVersion,width:number,height:number,assetId:string,capture:RequestSourceCapture|null):ImageState{
    if(b.replacement){
      if(b.mode!=='full-candidate'||b.placement!=='current-document'||b.newLayerId!==b.replacement.layerId)throw new AssetRejection('INVALID_INPUT','REPLACEMENT_REVIEW_INVALID');
      const after=structuredClone(before),target=after.layers.find(layer=>layer.id===b.replacement!.layerId);
      if(!target||target.version!==b.replacement.layerVersion)throw new AssetRejection('STALE_REVISION','LAYER_VERSION_CHANGED');
      if(target.kind!=='image'||target.locked||!target.visible)throw new AssetRejection('INCOMPATIBLE','NEW_DOCUMENT_REQUIRED');
      Object.assign(target,{version:String(BigInt(target.version)+1n),name:b.name,assetId,layerToDocument:[1,0,0,1,0,0],opacity:1,mask:null});
      imageState(after);this.texts.limits(after);return after;
    }
    if(b.placement==='new-document'){
      if(this.document(b.newDocumentId!)||this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(b.newDocumentId!))throw new AssetRejection('INVALID_INPUT','DOCUMENT_ID_REUSE');
    }else if(this.usedLayer(document.id,b.newLayerId)||before.layers.some(l=>l.id===b.newLayerId)||before.layers.length>=100)throw new AssetRejection('CAPACITY','NEW_LAYER_UNAVAILABLE');
    const after:ImageState=b.placement==='new-document'?{schemaVersion:1,width:width,height:height,layers:[]}:structuredClone(before);
    const layer:ImageState['layers'][number]={id:b.newLayerId,version:'1',kind:'image',name:b.name,assetId:assetId,layerToDocument:[1,0,0,1,0,0],opacity:1,visible:true,locked:false,blend:'normal',mask:null};
    if(b.placement==='current-document'&&b.mode==='safe-region'){
      if(!capture||capture.documentId!==document.id||capture.documentRevision!==document.revision||canonical(capture.image)!==canonical(source))throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
      if(capture.scope==='selected-layers')throw new AssetRejection('INCOMPATIBLE','NEW_DOCUMENT_REQUIRED');
      if(width!==before.width||height!==before.height)throw new AssetRejection('INCOMPATIBLE','CANDIDATE_GRID_CHANGED');
      const originals=after.layers.filter(l=>capture.layerIds.includes(l.id));
      if(originals.length!==capture.layerIds.length||originals.some(l=>!l.visible||l.locked))throw new AssetRejection('INCOMPATIBLE','NEW_DOCUMENT_REQUIRED');
      if(capture.scope==='visible-document'&&canonical(capture.layerIds)!==canonical(after.layers.filter(l=>l.visible).map(l=>l.id)))throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
      const slotIndex=capture.scope==='single-layer'?after.layers.indexOf(originals[0])+1:after.layers.length;
      for(const original of originals){original.visible=false;original.version=String(BigInt(original.version)+1n);}
      after.layers.splice(slotIndex,0,layer);
    }else after.layers.push(layer);
    imageState(after);this.texts.limits(after);
    return after;
  }
  private async prepareCandidatePreview(c:Command,document:Document,before:ImageState,source:ImageVersion,previewId:string,slot:string,check:()=>void,
    metadata:(value:unknown)=>Promise<BlobRef>,proofs:Proof[],reviewed?:CandidateAdoptionInputs):Promise<{preview:ImageEditPreview;facts:AssetFact[];check:()=>void}> {
    const b=c.body;if(b.type!=='PrepareCandidateAdoption')throw new StoreError('UNSUPPORTED_COMMAND');
    const prepared=reviewed?await this.candidates.prepareReviewedAdoption(reviewed,randomUUID(),slot,check):await this.candidates.prepareAdoption(b.candidateId,b.mode,randomUUID(),slot,check,{actualOutput:b.actualOutput});proofs.push(...prepared.proofs);
    for(const ref of [...(prepared.plan?[prepared.plan.sourcePixels,prepared.plan.authoredMask,prepared.plan.effectiveMask]:[]),...(prepared.outputMapping?[prepared.outputMapping.effectiveMask]:[])])if(!proofs.some(p=>p.ref.hash===ref.hash))proofs.push({ref,token:await this.objects.prove(ref,prepared.check)});
    if(prepared.identity.documentId!==document.id)throw new AssetRejection('INVALID_INPUT','CANDIDATE_DOCUMENT_MISMATCH');
    const lineage=await metadata(this.adoptedLineage(prepared.identity)),wrapped=await this.rasters.retainCandidate(prepared.asset,lineage,randomUUID(),slot,prepared.check);proofs.push(...wrapped.proofs);
    const after=this.candidatePlacementState(b,document,before,source,prepared.asset.raster!.width,prepared.asset.raster!.height,wrapped.asset.id,prepared.sourceCapture);
    const facts:AssetFact[]=this.assets.asset(prepared.asset.id)?[]:[{type:'AssetRegistered',payload:{asset:prepared.asset}}];facts.push({type:'AssetRegistered',payload:{asset:wrapped.asset}});
    const composite=await this.rasters.prepareDocument({type:'ComposeRaster',width:after.width,height:after.height,layers:after.layers.filter(l=>l.visible).map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask}))},randomUUID(),slot,check,wrapped.asset);
    proofs.push(...composite.proofs);facts.push({type:'AssetRegistered',payload:{asset:composite.asset}});
    const plan=await metadata({command:b,identity:prepared.identity,requestPlan:prepared.plan,outputMapping:prepared.outputMapping,coverage:prepared.coverage,sourceCapture:prepared.sourceCapture,lineage});
    return {check:prepared.check,facts,preview:{previewId,documentId:document.id,documentRevision:document.revision,kind:'candidate-adoption',candidate:{candidateId:b.candidateId,mode:b.mode,placement:b.placement,newDocumentId:b.newDocumentId,...(b.replacement?{replacement:b.replacement}:{}),coverage:prepared.coverage,outputMapping:prepared.outputMapping},plan,source,preparedAssetId:wrapped.asset.id,after:{state:await metadata(after),semanticDigest:semanticDigest(after),compositeAssetId:composite.asset.id}}};
  }
  private async prepare(id:string,slot:string){
    const start=performance.now(),pending=this.pending(id);if(!pending)return;
    const c=pending.command,b=c.body as HistoryBody,bytes=Buffer.from(String(this.db.prepare('SELECT original FROM history_preparations WHERE id=?').get(id)!.original));
    let textAsset:import('../../src/protocol/assets.js').Asset|undefined;let textCandidate:TextCandidate|undefined;let adoptedLineage:BlobRef|undefined,adoptedIdentity:CandidateAdoptionIdentity|undefined;
    const proofs:Proof[]=[];const check=()=>{this.check();if(this.closing)throw new StoreError('CLOSED');if(b.type==='ExportDocument'&&this.db.prepare('SELECT 1 FROM commands WHERE id=?').get(id))throw new AssetRejection('INVALID_INPUT','EXPORT_CANCELED');};
    const protect=async(ref:BlobRef)=>{if(!proofs.some(p=>p.ref.hash===ref.hash))proofs.push({ref,token:await this.objects.prove(ref,check)});};
    const metadata=async(value:unknown)=>{const ref=this.objects.putMetadataInSlot(Buffer.from(canonical(value)),slot);await protect(ref);return ref;};
    const assetIds=new Set<string>(),assetIdentities=new Map<string,string>(),versionIds=new Set<string>(),lineageIds=new Set<string>(),evidenceAttempts=new Set<string>();
    const protectAsset=async(id:string):Promise<void>=>{
      if(assetIds.has(id))return;assetIds.add(id);if(assetIds.size>512)throw new StoreError('CAPACITY');
      const a=textAsset?.id===id?textAsset:this.assets.asset(id);if(!a||a.availability!=='available')throw new AssetRejection('MISSING_ASSET','HISTORY_DEPENDENCY_MISSING');
      if(textAsset?.id!==id)assetIdentities.set(id,canonical(a));
      for(const ref of [a.blob,...a.dependencies])await protect(ref);
      if(a.retainedMetadata){await validateRetainedRasterMetadata(a.retainedMetadata,a.raster!,async ref=>JSON.parse(Buffer.from(this.objects.verify(ref,true)!).toString('utf8')),check);await protectFrozenMetadata(a.retainedMetadata);}
      if(a.raster){const m=textAsset?.id===id?JSON.parse(Buffer.from(this.objects.verify(a.raster.manifest,true)!).toString()):this.rasters.manifest(id);for(const ref of [...m.dependencies,...this.rasters.contributionRefs(m)])await protect(ref);const plan=m.plan as {kind?:string;source?:BlobRef;capture?:RequestSourceCapture;lineage?:BlobRef};if(plan.kind==='retained-text'&&plan.source){await protect(plan.source);for(const ref of textRefs(this.texts.source(plan.source)))await protect(ref);}if(plan.kind==='request-source-capture-v1'&&plan.capture)await protectVersion(plan.capture.image);if(plan.kind==='retained-candidate-v1'&&plan.lineage){for(const row of this.db.prepare('SELECT attempt_id FROM candidate_asset_evidence WHERE asset_id=? AND manifest_hash=?').all(a.id,a.raster.manifest.hash))evidenceAttempts.add(String(row.attempt_id));await protectLineage(plan.lineage);}for(const child of a.raster.sourceAssetIds)await protectAsset(child);}
    };
    const protectVersion=async(version:ImageVersion):Promise<void>=>{
      await protect(version.state);if(version.compositeAssetId)await protectAsset(version.compositeAssetId);
      if(versionIds.has(version.state.hash))return;versionIds.add(version.state.hash);
      const state=this.versionState(version);
      for(const layer of state.layers){await protectAsset(layer.assetId);if(layer.mask)await protectAsset(layer.mask.assetId);if(layer.kind==='text'){await protect(layer.source);for(const ref of textRefs(this.texts.source(layer.source)))await protect(ref);}}
      if(state.composition){const graph=readComposition(state.composition,r=>this.objects.verify(r,true)!);for(const ref of [state.composition.value,...compositionRefs(graph)])await protect(ref);}
    };
    const frozenMetadata=new Set<string>(),frozenLengths=new Map<string,string>();
    const protectFrozenMetadata=async(root:BlobRef):Promise<void>=>{
      const queue=[root];
      while(queue.length){
        const ref=queue.pop()!;await protect(ref);const key=ref.hash+':'+ref.mediaType;if(frozenMetadata.has(key))continue;
        if(frozenMetadata.size>=4096||ref.mediaType!=='application/json'||BigInt(ref.byteLength)>65536n)throw new StoreError('CAPACITY');
        frozenMetadata.add(key);const bytes=this.objects.verify(ref,true)!,value=JSON.parse(Buffer.from(bytes).toString('utf8'));if(canonical(value)!==Buffer.from(bytes).toString('utf8'))throw new StoreError('CORRUPT_OBJECT');
        for(const dependency of retainedMetadataReferences(value)){const prior=frozenLengths.get(dependency.ref.hash);if(prior!==undefined&&prior!==dependency.ref.byteLength)throw new StoreError('CORRUPT_OBJECT');frozenLengths.set(dependency.ref.hash,dependency.ref.byteLength);await protect(dependency.ref);if(dependency.inspect&&!frozenMetadata.has(dependency.ref.hash+':'+dependency.ref.mediaType))queue.push(dependency.ref);}
      }
    };
    const protectLineage=async(ref:BlobRef):Promise<void>=>{await protect(ref);if(lineageIds.has(ref.hash))return;lineageIds.add(ref.hash);const value=JSON.parse(Buffer.from(this.objects.verify(ref,true)!).toString('utf8'));lineageRecord(value);await protectFrozenMetadata(ref);const composition=value.result.request.specification.settings.prompt.composition;if(composition){const graph=readComposition(composition,r=>this.objects.verify(r,true)!);for(const dependency of [composition.value,...compositionRefs(graph)])await protect(dependency);}for(const assetId of lineageAssetIds(value))await protectAsset(assetId);};
    const retainEvidence=(documentId:string)=>{for(const attemptId of evidenceAttempts)this.db.prepare('INSERT OR IGNORE INTO candidate_adoption_evidence(document_id,attempt_id) VALUES (?,?)').run(documentId,attemptId);};
    try{
      if(b.type==='AdoptReviewedCandidate'){
        const approved=this.approvedPlacement(c),review=approved.review,document=approved.document,before=approved.before;
        await protectVersion(review.source);
        const checked=()=>{check();this.approvedPlacement(c);};
        const prepared=await this.prepareCandidatePreview({...c,documentId:document.id,body:{type:'PrepareCandidateAdoption',...review.placement}},document,before,review.source,pending.operationId,slot,checked,metadata,proofs,review.inputs);
        const preview=prepared.preview,plan=this.candidatePlan(preview),after=this.versionState(preview.after);await protectLineage(plan.lineage!);
        const creating=review.placement.placement==='new-document';let created:ReturnType<typeof candidateDocument>|undefined,node:ImageHistoryNode|undefined;
        if(creating)created=candidateDocument(preview,after,c.documentId!,pending.operationId,randomUUID(),plan.lineage);
        else{
          const branchId=document.redo||this.child(document.historyHead,document.branchId)?randomUUID():document.branchId;
          const forward=await metadata(this.patch(before,after,b.type)),inverse=await metadata(this.patch(after,before,b.type));
          node={id:pending.operationId,documentId:document.id,parent:document.historyHead,branchId,revision:String(BigInt(document.revision)+1n),kind:'image-edit',operation:b.type,before:review.source,after:preview.after,forward,inverse,adoptedLineage:plan.lineage!,roots:[review.source.state,preview.after.state,forward,inverse,plan.lineage!]};
        }
        this.barrier('history-after-proofs');await new Promise<void>(resolve=>setImmediate(resolve));checked();
        this.commit(bytes,(current,revision)=>{
          this.approvedPlacement(c);prepared.check();for(const [assetId,identity]of assetIdentities)if(canonical(this.assets.asset(assetId))!==identity)throw new AssetRejection('STALE_REVISION','HISTORY_DEPENDENCY_CHANGED');
          const seen=new Set<string>();for(const proof of proofs){this.objects.proven(proof.ref,proof.token);if(!seen.has(proof.ref.hash)){seen.add(proof.ref.hash);this.register('history-command:'+id,proof.ref,proof.token);}}
          let wrapper:Asset|undefined;for(const fact of prepared.facts)if(fact.type==='AssetRegistered'&&fact.payload.asset.id===preview.preparedAssetId)wrapper=fact.payload.asset;
          if(!wrapper?.raster)throw new StoreError('CORRUPT_STORE');evidenceAttempts.add(review.inputs.identity.attemptId);
          for(const attemptId of evidenceAttempts)this.db.prepare('INSERT INTO candidate_asset_evidence(asset_id,manifest_hash,attempt_id) VALUES (?,?,?)').run(wrapper.id,wrapper.raster.manifest.hash,attemptId);
          retainEvidence(c.documentId!);this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);
          if(created)return {facts:[...prepared.facts,{type:'DocumentCreated',payload:created}],documentChanged:true};
          const next:Document={...current,revision,width:after.width,height:after.height,orderedLayerIds:after.layers.map(l=>l.id),historyHead:node!.id,branchId:node!.branchId,image:preview.after,redo:null,compositionVersion:after.composition?.id??null};
          this.ui.reconcile(current.id,after,new Date().toISOString());return {facts:[...prepared.facts,{type:'ImageEdited',payload:{document:next,history:node!}}],documentChanged:true};
        },created?candidateDocumentSeed(created.document):undefined);return;
      }
      if(b.type==='AdoptCandidate'&&c.expectedDocumentRevision===null){
        const preview=this.approvedCreation(c),plan=this.candidatePlan(preview),after=this.versionState(preview.after);
        await protectLineage(plan.lineage!);
        await protect(preview.plan);for(const ref of [...(plan.requestPlan?[plan.requestPlan.sourcePixels,plan.requestPlan.authoredMask,plan.requestPlan.effectiveMask]:[]),...(plan.outputMapping?[plan.outputMapping.effectiveMask]:[])])await protect(ref);
        for(const version of [preview.source,preview.after,...(plan.sourceCapture?[plan.sourceCapture.image]:[])])await protectVersion(version);
        await protectAsset(preview.preparedAssetId);
        const created=candidateDocument(preview,after,c.documentId!,pending.operationId,randomUUID(),plan.lineage),seed=candidateDocumentSeed(created.document);
        this.barrier('history-after-proofs');await new Promise<void>(resolve=>setImmediate(resolve));check();
        this.commit(bytes,()=>{
          this.approvedCreation(c);for(const [assetId,identity]of assetIdentities)if(canonical(this.assets.asset(assetId))!==identity)throw new AssetRejection('STALE_REVISION','HISTORY_DEPENDENCY_CHANGED');
          const seen=new Set<string>();for(const proof of proofs){this.objects.proven(proof.ref,proof.token);if(!seen.has(proof.ref.hash)){seen.add(proof.ref.hash);this.register('history-command:'+id,proof.ref,proof.token);}}
          // Backend ownership is journaled only by a checked local adoption; imported scalar IDs never recreate this edge.
          evidenceAttempts.add(plan.identity.attemptId);retainEvidence(created.document.id);
          this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);
          return {facts:[{type:'DocumentCreated',payload:created}],documentChanged:true};
        },seed);return;
      }
      const d=b.type==='ExportDocument'?JSON.parse(String(this.db.prepare('SELECT frozen FROM history_preparations WHERE id=?').get(id)!.frozen)) as Document|null:this.document(c.documentId!);const maskDraft=this.assertCommand(c,d),maskDraftIdentity=maskDraft?canonical(maskDraft):null;const document=d!;
      if(maskDraft){await protectAsset(maskDraft.assetId);if(maskDraft.kind==='composition'){const a=this.assets.asset(maskDraft.assetId)!;const envelope=JSON.parse(Buffer.from(this.objects.verify(a.blob,true)!).toString());compositionDraft(envelope);for(const ref of compositionDraftRefs(envelope))await protect(ref);}for(const source of Object.values(maskDraft.maskBindings??{}))await protectAsset(source);}
      if(b.type==='ImportFont'){const asset=await this.texts.importFont(c,pending.operationId,protect);this.commit(bytes,current=>{this.assertCommand(c,current);this.authority(id);for(const p of proofs){this.objects.proven(p.ref,p.token);this.register('history-command:'+id,p.ref,p.token);}this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);return {facts:[{type:'AssetRegistered',payload:{asset}}],documentChanged:false};});return;}
      const before=document.image?this.versionState(document.image):{schemaVersion:1 as const,width:document.width,height:document.height,layers:[]};const beforeVersion:ImageVersion=document.image??{state:await metadata(before),semanticDigest:semanticDigest(before),compositeAssetId:null};
      if(b.type==='ReviewCandidatePlacement'){
        await protectVersion(beforeVersion);
        const input=await this.candidates.reviewAdoption(b.candidateId,b.mode,randomUUID(),slot,check,{actualOutput:b.actualOutput});proofs.push(...input.proofs);
        if(input.identity.documentId!==document.id)throw new AssetRejection('INVALID_INPUT','CANDIDATE_DOCUMENT_MISMATCH');
        const width=b.mode==='safe-region'?input.plan!.document.width:input.asset.raster!.width,height=b.mode==='safe-region'?input.plan!.document.height:input.asset.raster!.height;
        this.candidatePlacementState(b,document,before,beforeVersion,width,height,input.asset.id,input.sourceCapture);
        const lineage=await metadata(this.adoptedLineage(input.identity));await protectLineage(lineage);
        this.barrier('history-placement-review-after-proofs');await new Promise<void>(resolve=>setImmediate(resolve));check();
        this.commit(bytes,current=>{
          this.assertCommand(c,current);input.check();if(canonical(current.image??null)!==canonical(document.image??null))throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
          this.candidatePlacementState(b,current,before,beforeVersion,width,height,input.asset.id,input.sourceCapture);
          for(const [assetId,identity]of assetIdentities)if(canonical(this.assets.asset(assetId))!==identity)throw new AssetRejection('STALE_REVISION','HISTORY_DEPENDENCY_CHANGED');
          const seen=new Set<string>();for(const proof of proofs){this.objects.proven(proof.ref,proof.token);if(!seen.has(proof.ref.hash)){seen.add(proof.ref.hash);this.register('history-command:'+id,proof.ref,proof.token);}}
          const auth=this.authority(id),{type,...placement}=b,value={protocolVersion:1 as const,kind:'candidate-placement-review-1' as const,reviewId:pending.operationId,targetClientId:auth.clientId,expiresAt:new Date(Math.min(auth.expires,auth.now+1800000)).toISOString(),documentId:document.id,documentRevision:document.revision,source:beforeVersion,placement,inputs:input.frozen,preparation:input.preparation,width,height};
          const review:CandidatePlacementReview={...value,reviewHash:hashBytes(canonical(value))};this.db.prepare('INSERT INTO image_edit_reviews VALUES (?,?,?,?)').run(review.reviewId,canonical(review),auth.sessionHash,this.epoch());
          retainEvidence(document.id);this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);return {facts:[{type:'CandidatePlacementReviewPrepared',payload:{reviewId:review.reviewId,reviewHash:review.reviewHash}}],documentChanged:false};
        });return;
      }
      if(b.type==='PrepareRequestSource'){
        if(b.layerIds.some(id=>!before.layers.some(l=>l.id===id)))throw new AssetRejection('STALE_REVISION','LAYER_MISSING');
        const selected=before.layers.filter(l=>b.scope==='visible-document'?l.visible:b.layerIds.includes(l.id));
        if(!selected.length)throw new AssetRejection('INVALID_INPUT','EMPTY_SOURCE_SELECTION');
        await protect(beforeVersion.state);
        for(const l of before.layers){await protectAsset(l.assetId);if(l.mask)await protectAsset(l.mask.assetId);}
        if(beforeVersion.compositeAssetId)await protectAsset(beforeVersion.compositeAssetId);
        if(before.composition){const graph=readComposition(before.composition,r=>this.objects.verify(r,true)!);for(const ref of [before.composition.value,...compositionRefs(graph)])await protect(ref);}
        const capture:RequestSourceCapture={schemaVersion:1,documentId:document.id,documentRevision:document.revision,image:beforeVersion,scope:b.scope,layerIds:selected.map(l=>l.id)};
        const prepared=await this.rasters.prepareDocument({type:'ComposeRaster',width:before.width,height:before.height,layers:selected.map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask})),requestSource:capture},pending.operationId,slot,check);proofs.push(...prepared.proofs);
        this.barrier('history-request-source-after-proofs');await new Promise<void>(r=>setImmediate(r));check();
        this.commit(bytes,current=>{
          this.assertCommand(c,current);if(canonical(current.image??null)!==canonical(document.image??null))throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
          for(const [assetId,identity]of assetIdentities)if(canonical(this.assets.asset(assetId))!==identity)throw new AssetRejection('STALE_REVISION','HISTORY_DEPENDENCY_CHANGED');
          const seen=new Set<string>();for(const proof of proofs){this.objects.proven(proof.ref,proof.token);if(!seen.has(proof.ref.hash)){seen.add(proof.ref.hash);this.register('history-command:'+id,proof.ref,proof.token);}}
          retainEvidence(document.id);this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);return {facts:[{type:'AssetRegistered',payload:{asset:prepared.asset}}],documentChanged:false};
        });return;
      }
      if(b.type==='PrepareImageResample'||b.type==='PrepareFlattenedCopy'||b.type==='PrepareCandidateAdoption'||b.type==='ReviewImageEdit'){
        await protect(beforeVersion.state);for(const l of before.layers){await protectAsset(l.assetId);if(l.mask)await protectAsset(l.mask.assetId);}if(beforeVersion.compositeAssetId)await protectAsset(beforeVersion.compositeAssetId);
        let preview:ImageEditPreview,previewFacts:AssetFact[]=[],candidateCheck:(()=>void)|undefined;
        if(b.type==='ReviewImageEdit'){
          preview=this.preview(b.previewId,this.authority(id));if(preview.documentId!==document.id||preview.documentRevision!==document.revision||canonical(preview.source)!==canonical(beforeVersion))throw new AssetRejection('STALE_REVISION','IMAGE_PREVIEW_CHANGED');
          if(preview.kind==='candidate-adoption')this.checkCandidatePreview(preview);
          await protect(preview.plan);await protect(preview.after.state);await protectAsset(preview.preparedAssetId);await protectAsset(preview.after.compositeAssetId!);
        }else if(b.type==='PrepareCandidateAdoption'){const result=await this.prepareCandidatePreview(c,document,before,beforeVersion,pending.operationId,slot,check,metadata,proofs);preview=result.preview;previewFacts=result.facts;candidateCheck=result.check;}else{const result=await this.prepareImagePreview(c,document,before,beforeVersion,pending.operationId,slot,check,metadata,proofs);preview=result.preview;previewFacts=result.facts;}
        if(preview.kind==='candidate-adoption'){const lineage=this.candidatePlan(preview).lineage;if(lineage)await protectLineage(lineage);}
        this.barrier('history-preview-after-proofs');await new Promise<void>(r=>setImmediate(r));check();
        this.commit(bytes,current=>{
          this.assertCommand(c,current);candidateCheck?.();if(preview.kind==='candidate-adoption'&&b.type==='ReviewImageEdit')this.checkCandidatePreview(preview);for(const [assetId,identity]of assetIdentities)if(canonical(this.assets.asset(assetId))!==identity)throw new AssetRejection('STALE_REVISION','HISTORY_DEPENDENCY_CHANGED');for(const p of proofs)this.objects.proven(p.ref,p.token);
          const seen=new Set<string>();for(const p of proofs)if(!seen.has(p.ref.hash)){seen.add(p.ref.hash);this.register('history-command:'+id,p.ref,p.token);}
          if(b.type==='PrepareCandidateAdoption'){
            const candidatePlan=this.candidatePlan(preview);let wrapper:Asset|undefined;for(const fact of previewFacts)if(fact.type==='AssetRegistered'&&fact.payload.asset.id===preview.preparedAssetId)wrapper=fact.payload.asset;
            if(!wrapper?.raster)throw new StoreError('CORRUPT_STORE');evidenceAttempts.add(candidatePlan.identity.attemptId);
            for(const attemptId of evidenceAttempts)this.db.prepare('INSERT INTO candidate_asset_evidence(asset_id,manifest_hash,attempt_id) VALUES (?,?,?)').run(wrapper.id,wrapper.raster.manifest.hash,attemptId);
          }
          retainEvidence(document.id);
          const facts:HistoryBuild['facts']=[...previewFacts];
          if(b.type==='ReviewImageEdit'){
            const auth=this.authority(id),value={protocolVersion:1 as const,reviewId:pending.operationId,preview,targetClientId:auth.clientId,expiresAt:new Date(Math.min(auth.expires,auth.now+1800000)).toISOString()};
            const review={...value,reviewHash:hashBytes(canonical(value))};this.db.prepare('INSERT INTO image_edit_reviews VALUES (?,?,?,?)').run(review.reviewId,canonical(review),auth.sessionHash,this.epoch());facts.push({type:'ImageEditReviewPrepared',payload:{reviewId:review.reviewId,reviewHash:review.reviewHash}});
          }else{this.db.prepare('INSERT INTO image_previews VALUES (?,?,?,?)').run(preview.previewId,document.id,c.clientId,canonical(preview));facts.push({type:'ImageEditPreviewPrepared',payload:{preview}});}
          this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);return {facts,documentChanged:false};
        });this.observations.push({commandId:id,operation:b.type,fullPreparationMs:performance.now()-start,externalEffects:0});return;
      }
      let after:ImageState,version:ImageVersion,head:string,branchId=document.branchId,redo:string|null=null,node:ImageHistoryNode|undefined;
      let exportLayers:ImageState['layers']|undefined;
      const facts:AssetFact[]=[];
      if(b.type==='Undo'||b.type==='Redo'||b.type==='SwitchBranch'){
        if(b.type==='Undo'){
          if(b.historyHead!==document.historyHead)throw new AssetRejection('STALE_REVISION','HISTORY_HEAD_CHANGED');
          const current=this.node(b.historyHead);if(!('kind' in current))throw new AssetRejection('INVALID_INPUT','NOTHING_TO_UNDO');
          version=current.before;head=current.parent;redo=current.id;
        }else{
          const target=this.node(b.historyNode);if(target.documentId!==document.id||!('kind' in target)&&(b.type!=='SwitchBranch'||!target.forward.after.image))throw new AssetRejection('INVALID_INPUT','HISTORY_TARGET_INVALID');
          if(b.type==='Redo'&&(document.redo!==target.id||target.parent!==document.historyHead))throw new AssetRejection('STALE_REVISION','REDO_NOT_ELIGIBLE');
          if(b.type==='SwitchBranch'&&b.branchId!==target.branchId)throw new AssetRejection('STALE_REVISION','BRANCH_TARGET_CHANGED');
          branchId=b.type==='SwitchBranch'?b.branchId:document.branchId;version='kind' in target?target.after:target.forward.after.image!;head=target.id;redo=this.child(head,branchId);
        }
        after=this.versionState(version);
      }else if(b.type==='ExportDocument'||b.type==='SaveCheckpoint'){
        if(b.type==='ExportDocument'&&b.historyHead!==document.historyHead)throw new AssetRejection('STALE_REVISION','HISTORY_HEAD_CHANGED');
        after=before;version=beforeVersion;head=document.historyHead;
        if(b.type==='ExportDocument'&&b.options?.scope.kind==='selected-layers'){
          const scope=b.options.scope,selected=new Set(scope.layerIds);
          if(scope.layerIds.some(id=>!before.layers.some(layer=>layer.id===id)))throw new AssetRejection('INVALID_INPUT','EXPORT_LAYER_MISSING');
          exportLayers=before.layers.filter(layer=>selected.has(layer.id)&&(layer.visible||scope.includeHidden));
          if(!exportLayers.length)throw new AssetRejection('INVALID_INPUT','EXPORT_SELECTION_EMPTY');
          version={...beforeVersion,compositeAssetId:null};
        }
      }else{
        const approved=b.type==='ResampleImage'||b.type==='CreateFlattenedCopy'||b.type==='AdoptCandidate'?this.approved(c,document):null;
        if(approved){await protect(approved.plan);if(approved.kind==='candidate-adoption'){const candidatePlan=this.candidatePlan(approved);adoptedLineage=candidatePlan.lineage;adoptedIdentity=candidatePlan.identity;if(adoptedLineage)await protectLineage(adoptedLineage);}after=this.versionState(approved.after);version=approved.after;await protectAsset(approved.preparedAssetId);}
        else{
          if('composition'in b){
            if(this.usedComposition(document.id,b.composition.id))throw new AssetRejection('INVALID_INPUT','COMPOSITION_VERSION_REUSE');
            validateCommit(b.type,b.composition,before,r=>this.objects.verify(r,true)!,id=>this.assets.asset(id));after=structuredClone(before);after.schemaVersion=5;after.composition=b.composition;
          }else if('candidate'in b){
            textCandidate=await this.texts.candidate(c,document,this.authority(id),protect,()=>{check();this.assertCommand(c,this.document(c.documentId!));this.authority(id);});const source=await metadata(textCandidate.source);
            const prepared=await this.rasters.prepareDocument({type:'RetainText',source,pixels:textCandidate.source.render.pixels,width:textCandidate.source.render.width,height:textCandidate.source.render.height},randomUUID(),slot,check);proofs.push(...prepared.proofs);textAsset=prepared.asset;facts.push({type:'AssetRegistered',payload:{asset:textAsset}});
            after=structuredClone(before);after.schemaVersion=before.schemaVersion>=3?before.schemaVersion:2;const old=after.layers.find(l=>l.id===b.layerId);
            if(b.type==='CreateTextLayer'){if(this.usedLayer(document.id,b.layerId))throw new AssetRejection('INVALID_INPUT','LAYER_ID_REUSE');after.layers.push({id:b.layerId,version:'1',kind:'text',source,name:b.name,assetId:textAsset.id,layerToDocument:[1,0,0,1,b.placement?.x??0,b.placement?.y??0],opacity:1,visible:true,locked:false,blend:'normal',mask:null});}
            else{if(!old||old.kind!=='text'||old.version!==b.layerVersion)throw new AssetRejection('STALE_REVISION','TEXT_LAYER_CHANGED');if(old.locked)throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');const prior=this.texts.source(old.source);if(b.type==='CommitTextEdit'&&canonical(prior.text.fonts)!==canonical(textCandidate.source.text.fonts))throw new AssetRejection('INCOMPATIBLE','REVIEWED_FONT_REPLACEMENT_REQUIRED');old.assetId=textAsset.id;old.source=source;old.version=String(BigInt(old.version)+1n);}
          }else if(b.type==='RasterizeTextDerivative'){
            after=structuredClone(before);const old=after.layers.find(l=>l.id===b.layerId);if(!old||old.kind!=='text'||old.version!==b.layerVersion)throw new AssetRejection('STALE_REVISION','TEXT_LAYER_CHANGED');if(old.locked)throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');if(this.texts.source(old.source).render.id!==b.reviewedRender)throw new AssetRejection('STALE_REVISION','TEXT_DERIVATIVE_REVIEW_CHANGED');if(this.usedLayer(document.id,b.newLayerId))throw new AssetRejection('INVALID_INPUT','LAYER_ID_REUSE');const {source,kind,...props}=old;after.layers.splice(after.layers.indexOf(old)+1,0,{...props,id:b.newLayerId,version:'1',name:b.name,kind:'image'});if(b.hideOriginal){old.visible=false;old.version=String(BigInt(old.version)+1n);}
          }else after=this.edit(c,document,before);
          this.texts.limits(after);version={state:await metadata(after),semanticDigest:semanticDigest(after),compositeAssetId:null};}
        head=pending.operationId;
        if(document.redo||this.child(document.historyHead,document.branchId))branchId=randomUUID();
        const visual=(s:ImageState)=>({width:s.width,height:s.height,layers:s.layers.filter(l=>l.visible).map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask}))});
        if(!approved&&beforeVersion.compositeAssetId&&canonical(visual(before))===canonical(visual(after)))version.compositeAssetId=beforeVersion.compositeAssetId;
      }
      await protect(beforeVersion.state);await protect(version.state);
      if(b.type==='ExportDocument'){
        // Export consumes already accepted canonical pixels. An excluded layer's
        // missing original or a stale whole-document composite cannot block an
        // explicit selection; no new editable history or source lineage is made.
        const inputs=version.compositeAssetId?[version.compositeAssetId]:(exportLayers??after.layers.filter(layer=>layer.visible)).flatMap(layer=>[layer.assetId,...(layer.mask?[layer.mask.assetId]:[])]);
        for(const assetId of inputs){
          const asset=this.assets.asset(assetId);
          if(!asset||asset.availability!=='available')throw new AssetRejection('MISSING_ASSET','HISTORY_DEPENDENCY_MISSING');
          if(asset.qualification!=='canonical-raster'||asset.safety!=='safe'||!asset.raster)throw new AssetRejection('INCOMPATIBLE','RASTER_REVIEW_REQUIRED');
          assetIdentities.set(assetId,canonical(asset));await protect(asset.raster.manifest);await protect(asset.raster.pixels);
        }
      }else{
        for(const state of [before,after])if(state.composition){const c=readComposition(state.composition,r=>this.objects.verify(r,true)!);for(const ref of [state.composition.value,...compositionRefs(c)])await protect(ref);}
        for(const l of [...before.layers,...after.layers]){await protectAsset(l.assetId);if(l.mask)await protectAsset(l.mask.assetId);}
        if(beforeVersion.compositeAssetId)await protectAsset(beforeVersion.compositeAssetId);
      }
      if(version.compositeAssetId&&b.type!=='ExportDocument')await protectAsset(version.compositeAssetId);
      const navigation=b.type==='Undo'||b.type==='Redo'||b.type==='SwitchBranch';
      if(!navigation&&b.type!=='SaveCheckpoint'&&!version.compositeAssetId){
        const prepared=await this.rasters.prepareDocument({type:'ComposeRaster',width:after.width,height:after.height,layers:(exportLayers??after.layers.filter(l=>l.visible)).map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask}))},randomUUID(),slot,check,textAsset);
        proofs.push(...prepared.proofs);facts.push({type:'AssetRegistered',payload:{asset:prepared.asset}});version={...version,compositeAssetId:prepared.asset.id};
      }
      if(b.type==='ExportDocument'){
        // An untouched empty document has no retained composite yet. Export it
        // directly as a composed PNG in this one frozen-revision transaction.
        const intermediate=facts.length?facts[0].type==='AssetRegistered'?facts[0].payload.asset:undefined:undefined;
        const options=b.options?(({scope,...encoder})=>encoder)(b.options):undefined;
        const prepared=await this.rasters.prepareDocument({type:'ExportRaster',assetId:version.compositeAssetId!,...(options?{options}:{})},pending.operationId,slot,check,intermediate);proofs.push(...prepared.proofs);facts.push({type:'AssetRegistered',payload:{asset:prepared.asset}});
      }else if(!navigation&&b.type!=='SaveCheckpoint'){
        const forward=await metadata(this.patch(before,after,b.type)),inverse=await metadata(this.patch(after,before,b.type));
        node={id:head,documentId:document.id,parent:document.historyHead,branchId,revision:String(BigInt(document.revision)+1n),kind:'image-edit',operation:b.type,before:beforeVersion,after:version,forward,inverse,...(adoptedLineage?{adoptedLineage}:{}),roots:[beforeVersion.state,version.state,forward,inverse,...(adoptedLineage?[adoptedLineage]:[])]};
      }
      this.barrier('history-after-proofs');await new Promise<void>(resolve=>setImmediate(resolve));check();
      this.commit(bytes,(current,revision)=>{
        const currentMaskDraft=this.assertCommand(c,b.type==='ExportDocument'?document:current);if((currentMaskDraft?canonical(currentMaskDraft):null)!==maskDraftIdentity)throw new AssetRejection('STALE_REVISION','MASK_DRAFT_CHANGED');if('composition'in b){if(canonical(current)!==canonical(document))throw new AssetRejection('STALE_REVISION','COMPOSITION_BASE_CHANGED');validateCommit(b.type,b.composition,before,r=>this.objects.verify(r,true)!,id=>this.assets.asset(id));}if(textCandidate){this.texts.fence(c,current,this.authority(id),textCandidate);this.texts.limits(after);}if(b.type==='RasterizeTextDerivative')this.authority(id);if(b.type==='ResampleImage'||b.type==='CreateFlattenedCopy'||b.type==='AdoptCandidate')this.approved(c,current);for(const p of proofs)this.objects.proven(p.ref,p.token);
        this.barrier('history-before-register');for(const p of proofs)this.objects.proven(p.ref,p.token);for(const [id,identity]of assetIdentities)if(canonical(this.assets.asset(id))!==identity)throw new AssetRejection('STALE_REVISION','HISTORY_DEPENDENCY_CHANGED');
        const seen=new Set<string>();for(const p of proofs){if(seen.has(p.ref.hash))continue;seen.add(p.ref.hash);this.register('history-command:'+id,p.ref,p.token);}
        const all:HistoryBuild['facts']=[...facts];
        if(b.type==='SaveCheckpoint'){
          all.push({type:'CheckpointSaved',payload:{checkpoint:{id:pending.operationId,name:b.name,documentId:current.id,documentRevision:current.revision,historyHead:current.historyHead,highWater:String(this.db.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value),image:beforeVersion}}});
        }else if(b.type!=='ExportDocument'){
          const next:Document={...current,revision,width:after.width,height:after.height,orderedLayerIds:after.layers.map(l=>l.id),historyHead:head,branchId,image:version,redo,compositionVersion:after.composition?.id??null};
          if(adoptedIdentity)evidenceAttempts.add(adoptedIdentity.attemptId);retainEvidence(current.id);
          if(node)all.push({type:'ImageEdited',payload:{document:next,history:node}});
          else all.push({type:'HistoryNavigated',payload:{document:next,previousHead:current.historyHead,action:b.type as 'Undo'|'Redo'|'SwitchBranch'}});
          const now=new Date().toISOString();if('draft' in b)this.ui.applied(c.clientId,b.draft,now);this.ui.reconcile(current.id,after,now);
        }
        this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);
        return {facts:all,documentChanged:b.type!=='ExportDocument',...(b.type==='ExportDocument'?{exportRevision:document.revision}:{})};
      });
      this.observations.push({commandId:id,operation:b.type,fullPreparationMs:performance.now()-start,externalEffects:0});
    }catch(error){
      const code=(error as {code?:string}).code;
      const rejection=error instanceof CompositionError?new AssetRejection('INVALID_INPUT',error.issues[0].code):error instanceof AssetRejection?error:code==='PAYLOAD_TOO_LARGE'?new AssetRejection('CAPACITY','IMAGE_METADATA_LIMIT'):['ENOENT','MISSING_OBJECT','CORRUPT_OBJECT','ROOT_UNSAFE'].includes(code??'')?new AssetRejection('MISSING_ASSET','HISTORY_DEPENDENCY_UNAVAILABLE'):null;
      this.observations.push({commandId:id,operation:b.type,fullPreparationMs:performance.now()-start,error:rejection?.reason??code??'UNEXPECTED'});
      if(rejection){const creating=(b.type==='AdoptCandidate'||b.type==='AdoptReviewedCandidate')&&c.expectedDocumentRevision===null&&c.documentId&&!this.document(c.documentId)?{id:c.documentId,revision:'0',branchId:pending.operationId,width:1,height:1,color:'sRGB' as const,depth:8 as const,orderedLayerIds:[],historyHead:pending.operationId,checkpoint:null,compositionVersion:null}:undefined;this.commit(bytes,()=>{throw rejection;},creating);}else this.pause(id);
    }finally{for(const p of proofs)this.objects.releaseProof(p.token);if(this.db.prepare('SELECT id FROM commands WHERE id=?').get(id)){this.authorities.delete(id);if(b.type==='ExportDocument')this.rasters.cleanupDocumentExport(id);}if(this.observations.length>64)this.observations.shift();}
  }
  page(documentId:string,after:string,kind:'history'|'checkpoints'){
    this.check();if(!isId(documentId)||!(after===''||isId(after))||!this.document(documentId))throw new StoreError('NOT_FOUND');
    const result:unknown[]=[];let size=0,last=after,more=false;
    for(const row of this.db.prepare(`SELECT id,json FROM ${kind} WHERE document_id=? AND id>? ORDER BY id LIMIT 101`).iterate(documentId,after)){
      const text=String(row.json);if(result.length>=100||size+Buffer.byteLength(text)>48000){more=true;break;}result.push(JSON.parse(text));size+=Buffer.byteLength(text);last=String(row.id);
    }
    return {items:result,next:more?last:null};
  }
  closure(documentId:string,after:string){
    this.check();const d=this.document(documentId);if(!d)throw new StoreError('NOT_FOUND');
    if(after!==''&&!/^sha256:[a-f0-9]{64}$/.test(after))throw new StoreError('MALFORMED_REQUEST');
    // Paged retained-byte inventory. PF-1 must pin a read snapshot while making
    // a copy; this live listing is explicitly stamped, not a frozen bundle.
    const rows=this.db.prepare(`WITH refs AS (
      SELECT r.hash,r.media_type FROM roots r JOIN commands c ON r.owner IN ('history-command:'||c.id,'command:'||c.id,'receipt:'||c.id)
      WHERE json_extract(c.canonical,'$.command.documentId')=?
      UNION SELECT a.hash,a.media_type FROM ui_checkpoints u,json_each(u.json,'$.drafts') d
      JOIN asset_dependencies ad ON ad.asset_id=json_extract(d.value,'$.assetId')
      JOIN roots a ON a.hash=ad.hash WHERE json_extract(d.value,'$.documentId')=?
      UNION SELECT r.hash,r.media_type FROM roots r JOIN portable_namespaces n ON r.owner='namespace:'||n.id WHERE n.document_id=?
      UNION SELECT r.hash,r.media_type FROM ui_checkpoints u,json_each(u.json,'$.drafts') d JOIN roots r ON r.owner='ui:'||u.client_id||':'||u.session_id||':'||json_extract(d.value,'$.id')||':'||json_extract(d.value,'$.generation') WHERE json_extract(d.value,'$.documentId')=?
    ) SELECT refs.hash,objects.byte_length,MIN(refs.media_type) AS media_type FROM refs JOIN objects ON objects.hash=refs.hash
      WHERE refs.hash>? GROUP BY refs.hash ORDER BY refs.hash LIMIT 101`).all(documentId,documentId,documentId,documentId,after);
    const items=rows.slice(0,100).map(r=>({hash:String(r.hash),byteLength:String(r.byte_length),mediaType:String(r.media_type)}));
    return {documentId,documentRevision:d.revision,highWater:String(this.db.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value),kind:'live-retained-closure' as const,items,next:rows.length>100?items.at(-1)!.hash:null};
  }
  status(documentId:string,auth:AssetAuth,sessionId:string){
    const d=this.document(documentId);if(!d)throw new StoreError('NOT_FOUND');const checkpoint=d.checkpoint?JSON.parse(String(this.db.prepare('SELECT json FROM checkpoints WHERE id=?').get(d.checkpoint)!.json)):null;
    const savedRoot=checkpoint&&!checkpoint.image?this.node(checkpoint.historyHead):null;
    const semantic=d.image?.semanticDigest??semanticDigest(this.state(documentId));const ui=this.ui.read(sessionId,auth);
    return {pendingCommandCount:Number(this.db.prepare("SELECT count(*) AS n FROM history_preparations WHERE json_extract(canonical,'$.command.documentId')=? AND json_extract(canonical,'$.command.clientId')=?").get(documentId,auth.clientId)!.n),draftDirty:ui.drafts.some(x=>x.documentId===documentId&&x.status==='saved-unapplied'),
      documentChangedSinceCheckpoint:!checkpoint||(checkpoint.image?.semanticDigest??semanticDigest({schemaVersion:1,width:savedRoot&&!('kind' in savedRoot)?savedRoot.forward.after.width:d.width,height:savedRoot&&!('kind' in savedRoot)?savedRoot.forward.after.height:d.height,layers:[]}))!==semantic,bundleOutdated:true};
  }
  pressure(){return !!this.db.prepare("SELECT id FROM history_preparations WHERE phase='waiting-for-resources' LIMIT 1").get();}
  async close(){this.closing=true;await this.running;}
}

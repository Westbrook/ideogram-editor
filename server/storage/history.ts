import type { Texts } from './text.js';
import type { TextCandidate } from '../../src/protocol/text.js';
import { document as validateDocument, imageEditPreview as validatePreview } from '../../src/protocol/validate.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobRef, Command, Document, Receipt, HistoryNode } from '../../src/protocol/store.js';
import type { AssetFact } from '../../src/protocol/assets.js';
import type { ImageState, ImageVersion, ImageHistoryNode, ImagePatch, HistoryFact, HistoryBody, ImageEditPreview, ImageEditReview } from '../../src/protocol/history.js';
import { isHistoryCommand } from '../../src/protocol/history.js';
import { imageState } from '../../src/protocol/history-validation.js';
import type { Objects, Barrier } from './objects.js';
import type { Assets, AssetAuth } from './assets.js';
import { AssetRejection } from './assets.js';
import type { Rasters } from './raster.js';
import type { UIStore } from './ui.js';
import { canonical, hashBytes, isId, isSeq, parseCommand } from './canonical.js';
import { StoreError } from './errors.js';

export type HistoryBuild = { facts: (HistoryFact|AssetFact|{type:'CheckpointSaved';payload:{checkpoint:import('../../src/protocol/store.js').Checkpoint}})[]; documentChanged: boolean; exportRevision?: string };
export type HistoryCommit = (bytes:Uint8Array,build:(document:Document,revision:string)=>HistoryBuild)=>Receipt;
type Proof = {ref:BlobRef;token:string};
export const semanticDigest=(state:ImageState)=>hashBytes(canonical({...state,layers:state.layers.map(({version,...l})=>l)}));
export class Histories {
  private running:Promise<void>|undefined;private closing=false;private paused=new Set<string>();
  private authorities=new Map<string,{auth:AssetAuth;started:number}>();
  observations:Record<string,unknown>[]=[];
  constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private rasters:Rasters,private ui:UIStore,private texts:Texts,
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
  review(id:string,auth:AssetAuth):ImageEditReview {
    if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM image_edit_reviews WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');
    const review=JSON.parse(String(row.json)) as ImageEditReview;
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
    const b=c.body;if(b.type!=='ResampleImage'&&b.type!=='CreateFlattenedCopy')throw new StoreError('UNSUPPORTED_COMMAND');
    let preview:ImageEditPreview,review:ImageEditReview;
    try{const auth=this.authority(c.commandId);preview=this.preview(b.previewId,auth);review=this.review(b.reviewId,auth);}catch(e){if(e instanceof AssetRejection)throw e;throw new AssetRejection('INVALID_INPUT','IMAGE_REVIEW_EXPIRED');}
    if(review.reviewHash!==b.reviewHash||canonical(review.preview)!==canonical(preview)||preview.documentId!==document.id||preview.documentRevision!==document.revision||canonical(preview.source)!==canonical(document.image))throw new AssetRejection('STALE_REVISION','IMAGE_PREVIEW_CHANGED');
    if(preview.kind!==(b.type==='ResampleImage'?'resample-image':'flattened-copy'))throw new AssetRejection('INCOMPATIBLE','IMAGE_PREVIEW_KIND');return preview;
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
    const pending=this.pending(c.commandId);if(pending){if(pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');if(['ReviewImageEdit','ResampleImage','CreateFlattenedCopy','ImportFont','CreateTextLayer','CommitTextEdit','ReplaceTextFont','RasterizeTextDerivative'].includes(c.body.type))this.authorities.set(c.commandId,{auth:{...auth},started:performance.now()});this.paused.delete(c.commandId);this.schedule(true);return null;}
    if(Number(this.db.prepare('SELECT (SELECT count(*) FROM asset_preparations)+(SELECT count(*) FROM raster_preparations)+(SELECT count(*) FROM history_preparations)+(SELECT count(*) FROM portable_preparations) AS n').get()!.n)>=64)throw new StoreError('QUEUE_FULL');
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('INSERT INTO history_preparations VALUES (?,?,?,?,?,?,?)').run(c.commandId,hash,Buffer.from(bytes).toString('utf8'),serialized,randomUUID(),'preparing',canonical(c.body.type==='ExportDocument'?this.document(c.documentId!):null));
      this.barrier('history-preparation-before-commit');this.db.exec('COMMIT');this.barrier('history-preparation-after-commit');if(c.body.type==='ResampleImage'||c.body.type==='CreateFlattenedCopy')this.barrier('image-edit-preparation-after-commit');
    }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
    if(['ReviewImageEdit','ResampleImage','CreateFlattenedCopy','ImportFont','CreateTextLayer','CommitTextEdit','ReplaceTextFont','RasterizeTextDerivative'].includes(c.body.type))this.authorities.set(c.commandId,{auth:{...auth},started:performance.now()});
    this.schedule(true);return null;
  }
  schedule(retry=false){
    if(this.closing||this.running)return;
    setImmediate(()=>{
      if(this.closing||this.running||!this.rasters.documentAvailable)return;
      const row=this.db.prepare("SELECT id FROM history_preparations WHERE phase='preparing' OR ? ORDER BY id LIMIT 64").all(retry?1:0).find(r=>!this.paused.has(String(r.id)));
      if(!row)return;const id=String(row.id),slot='history:'+id;try{this.objects.acquire(slot);}catch{return;}
      this.running=this.prepare(id,slot).catch(()=>{this.pause(id);}).finally(()=>{this.running=undefined;this.objects.unreserve(slot);this.objects.release(slot);this.schedule();});
    });
  }
  private pause(id:string){this.paused.add(id);try{this.db.prepare("UPDATE history_preparations SET phase='waiting-for-resources' WHERE id=?").run(id);}catch{}}
  private assertCommand(c:Command,d:Document|null){
    if(!d||!c.documentId||d.id!==c.documentId)throw new AssetRejection('INVALID_INPUT','DOCUMENT_REQUIRED');
    if(c.expectedDocumentRevision!==d.revision)throw new AssetRejection('STALE_REVISION','REVISION_CHANGED',d.revision);
    if('draft' in c.body){let layerId='layerId' in c.body&&c.body.type!=='CreateTextLayer'?c.body.layerId:null;
      if(c.body.type==='ResampleImage'&&c.body.draft){const preview=this.preview(c.body.previewId,this.authority(c.commandId));layerId=JSON.parse(Buffer.from(this.objects.verify(preview.plan,true)!).toString('utf8')).layerId;}
      this.ui.fence(c.clientId,c.body.draft,d.id,c.expectedDocumentRevision,layerId);
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
      else if(b.type==='DeleteLayer')state.layers=state.layers.filter(l=>l.id!==layer.id);
      else if(b.type==='DuplicateLayer'){
        if(state.layers.some(l=>l.id===b.newLayerId)||this.usedLayer(d.id,b.newLayerId))throw new AssetRejection('INVALID_INPUT','LAYER_ID_REUSE');
        state.layers.splice(state.layers.indexOf(layer)+1,0,{...structuredClone(layer),id:b.newLayerId,version:'1',name:b.name});
      }
      if(b.type!=='DuplicateLayer'&&b.type!=='DeleteLayer')layer.version=String(BigInt(layer.version)+1n);
    }else if(b.type==='ImportAsset'){
      const a=this.assets.asset(b.assetId);if(!a?.raster||a.qualification!=='canonical-raster'||a.safety!=='safe'||a.availability!=='available')throw new AssetRejection('INCOMPATIBLE','APPROVED_RASTER_REQUIRED');
      if(this.usedLayer(d.id,b.layerId))throw new AssetRejection('INVALID_INPUT','LAYER_ID_REUSE');
      state.layers.push({id:b.layerId,version:'1',kind:'image',name:b.name,assetId:b.assetId,layerToDocument:[1,0,0,1,0,0],opacity:1,visible:true,locked:false,blend:'normal',mask:null});
    }else if(b.type==='MoveLayers'){
      if(b.orderedLayerIds.length!==state.layers.length||b.orderedLayerIds.some(id=>!state.layers.some(l=>l.id===id)))throw new AssetRejection('STALE_REVISION','LAYER_ORDER_CHANGED');
      if(state.layers.some(l=>l.locked&&b.orderedLayerIds.indexOf(l.id)!==state.layers.indexOf(l)))throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');
      state.layers=b.orderedLayerIds.map(id=>state.layers.find(l=>l.id===id)!);
    }else if(b.type==='CropDocument'||b.type==='ResizeCanvas'){
      const dx=b.type==='CropDocument'?-b.x:b.offsetX,dy=b.type==='CropDocument'?-b.y:b.offsetY;
      if(b.type==='CropDocument'&&(b.x<0||b.y<0||b.x+b.width>d.width||b.y+b.height>d.height))throw new AssetRejection('INVALID_INPUT','CROP_OUTSIDE_DOCUMENT');
      if(state.layers.some(l=>l.mask))throw new AssetRejection('INCOMPATIBLE','MASK_MAPPING_REVIEW_REQUIRED');
      if((dx||dy)&&state.layers.some(l=>l.locked))throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');
      state.width=b.width;state.height=b.height;
      for(const l of state.layers)if(dx||dy){const [a,bb,c,dd,e,f]=l.layerToDocument;l.layerToDocument=[a,bb,c,dd,e+dx,f+dy];l.version=String(BigInt(l.version)+1n);}
    }else throw new StoreError('UNSUPPORTED_COMMAND');
    if(state.layers.length>100)throw new AssetRejection('CAPACITY','DOCUMENT_LAYER_LIMIT');
    try{imageState(state);}catch{throw new AssetRejection('INVALID_INPUT','INVALID_IMAGE_STATE');}
    for(const l of state.layers)if(l.mask){const a=this.assets.asset(l.mask.assetId);if(!a?.raster||a.qualification!=='canonical-raster'||a.safety!=='safe'||a.raster.width!==state.width||a.raster.height!==state.height)throw new AssetRejection('INCOMPATIBLE','MASK_MAPPING_REVIEW_REQUIRED');}
    return state;
  }
  private usedLayer(documentId:string,id:string):boolean {
    // Layer IDs are never recycled, including identities only on inactive branches.
    if(this.db.prepare("SELECT 1 FROM portable_maps m JOIN portable_namespaces n ON n.id=m.namespace WHERE n.document_id=? AND m.kind='layer' AND m.local_id=? LIMIT 1").get(documentId,id))return true;
    return !!this.db.prepare("SELECT 1 FROM commands WHERE json_extract(canonical,'$.command.documentId')=? AND json_extract(receipt,'$.status')='accepted' AND (json_extract(canonical,'$.command.body.layerId')=? OR json_extract(canonical,'$.command.body.newLayerId')=?) LIMIT 1").get(documentId,id,id);
  }
  private patch(before:ImageState,after:ImageState,operation:HistoryBody['type']):ImagePatch {
    const ids=new Set([...before.layers.map(l=>l.id),...after.layers.map(l=>l.id)]);
    return {schemaVersion:1,operation,...(before.schemaVersion!==after.schemaVersion?{stateSchema:after.schemaVersion}:{}),dimensions:before.width!==after.width||before.height!==after.height?{width:after.width,height:after.height}:null,
      layers:[...ids].filter(id=>canonical(before.layers.find(l=>l.id===id)??null)!==canonical(after.layers.find(l=>l.id===id)??null)).map(id=>({id,value:after.layers.find(l=>l.id===id)??null})),
      order:canonical(before.layers.map(l=>l.id))!==canonical(after.layers.map(l=>l.id))?after.layers.map(l=>l.id):null};
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
  private async prepare(id:string,slot:string){
    const start=performance.now(),pending=this.pending(id);if(!pending)return;
    const c=pending.command,b=c.body as HistoryBody,bytes=Buffer.from(String(this.db.prepare('SELECT original FROM history_preparations WHERE id=?').get(id)!.original));
    let textAsset:import('../../src/protocol/assets.js').Asset|undefined;let textCandidate:TextCandidate|undefined;
    const proofs:Proof[]=[];const check=()=>{this.check();if(this.closing)throw new StoreError('CLOSED');};
    const protect=async(ref:BlobRef)=>{if(!proofs.some(p=>p.ref.hash===ref.hash))proofs.push({ref,token:await this.objects.prove(ref,check)});};
    const metadata=async(value:unknown)=>{const ref=this.objects.putMetadataInSlot(Buffer.from(canonical(value)),slot);await protect(ref);return ref;};
    const assetIds=new Set<string>();
    const protectAsset=async(id:string):Promise<void>=>{
      if(assetIds.has(id))return;assetIds.add(id);if(assetIds.size>512)throw new StoreError('CAPACITY');
      const a=textAsset?.id===id?textAsset:this.assets.asset(id);if(!a||a.availability!=='available')throw new AssetRejection('MISSING_ASSET','HISTORY_DEPENDENCY_MISSING');
      for(const ref of [a.blob,...a.dependencies])await protect(ref);
      if(a.raster){const m=textAsset?.id===id?JSON.parse(Buffer.from(this.objects.verify(a.raster.manifest,true)!).toString()):this.rasters.manifest(id);for(const ref of m.dependencies)await protect(ref);for(const child of a.raster.sourceAssetIds)await protectAsset(child);}
    };
    try{
      const d=b.type==='ExportDocument'?JSON.parse(String(this.db.prepare('SELECT frozen FROM history_preparations WHERE id=?').get(id)!.frozen)) as Document|null:this.document(c.documentId!);this.assertCommand(c,d);const document=d!;
      if(b.type==='ImportFont'){const asset=await this.texts.importFont(c,pending.operationId,protect);this.commit(bytes,current=>{this.assertCommand(c,current);this.authority(id);for(const p of proofs){this.objects.proven(p.ref,p.token);this.register('history-command:'+id,p.ref,p.token);}this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);return {facts:[{type:'AssetRegistered',payload:{asset}}],documentChanged:false};});return;}
      const before=document.image?this.versionState(document.image):{schemaVersion:1 as const,width:document.width,height:document.height,layers:[]};const beforeVersion:ImageVersion=document.image??{state:await metadata(before),semanticDigest:semanticDigest(before),compositeAssetId:null};
      if(b.type==='PrepareImageResample'||b.type==='PrepareFlattenedCopy'||b.type==='ReviewImageEdit'){
        await protect(beforeVersion.state);for(const l of before.layers){await protectAsset(l.assetId);if(l.mask)await protectAsset(l.mask.assetId);}if(beforeVersion.compositeAssetId)await protectAsset(beforeVersion.compositeAssetId);
        let preview:ImageEditPreview,previewFacts:AssetFact[]=[];
        if(b.type==='ReviewImageEdit'){
          preview=this.preview(b.previewId,this.authority(id));if(preview.documentId!==document.id||preview.documentRevision!==document.revision||canonical(preview.source)!==canonical(beforeVersion))throw new AssetRejection('STALE_REVISION','IMAGE_PREVIEW_CHANGED');
          await protect(preview.plan);await protect(preview.after.state);await protectAsset(preview.preparedAssetId);await protectAsset(preview.after.compositeAssetId!);
        }else{const result=await this.prepareImagePreview(c,document,before,beforeVersion,pending.operationId,slot,check,metadata,proofs);preview=result.preview;previewFacts=result.facts;}
        this.barrier('history-preview-after-proofs');await new Promise<void>(r=>setImmediate(r));check();
        this.commit(bytes,current=>{
          this.assertCommand(c,current);for(const p of proofs)this.objects.proven(p.ref,p.token);
          const seen=new Set<string>();for(const p of proofs)if(!seen.has(p.ref.hash)){seen.add(p.ref.hash);this.register('history-command:'+id,p.ref,p.token);}
          const facts:HistoryBuild['facts']=[...previewFacts];
          if(b.type==='ReviewImageEdit'){
            const auth=this.authority(id),value={protocolVersion:1 as const,reviewId:pending.operationId,preview,targetClientId:auth.clientId,expiresAt:new Date(Math.min(auth.expires,auth.now+1800000)).toISOString()};
            const review={...value,reviewHash:hashBytes(canonical(value))};this.db.prepare('INSERT INTO image_edit_reviews VALUES (?,?,?,?)').run(review.reviewId,canonical(review),auth.sessionHash,this.epoch());facts.push({type:'ImageEditReviewPrepared',payload:{reviewId:review.reviewId,reviewHash:review.reviewHash}});
          }else{this.db.prepare('INSERT INTO image_previews VALUES (?,?,?,?)').run(preview.previewId,document.id,c.clientId,canonical(preview));facts.push({type:'ImageEditPreviewPrepared',payload:{preview}});}
          this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(id);return {facts,documentChanged:false};
        });this.observations.push({commandId:id,operation:b.type,fullPreparationMs:performance.now()-start,externalEffects:0});return;
      }
      let after:ImageState,version:ImageVersion,head:string,branchId=document.branchId,redo:string|null=null,node:ImageHistoryNode|undefined;
      const facts:AssetFact[]=[];
      if(b.type==='Undo'||b.type==='Redo'||b.type==='SwitchBranch'){
        if(b.type==='Undo'){
          if(b.historyHead!==document.historyHead)throw new AssetRejection('STALE_REVISION','HISTORY_HEAD_CHANGED');
          const current=this.node(b.historyHead);if(!('kind' in current))throw new AssetRejection('INVALID_INPUT','NOTHING_TO_UNDO');
          version=current.before;head=current.parent;redo=current.id;
        }else{
          const target=this.node(b.historyNode);if(!('kind' in target)||target.documentId!==document.id)throw new AssetRejection('INVALID_INPUT','HISTORY_TARGET_INVALID');
          if(b.type==='Redo'&&(document.redo!==target.id||target.parent!==document.historyHead))throw new AssetRejection('STALE_REVISION','REDO_NOT_ELIGIBLE');
          if(b.type==='SwitchBranch'&&b.branchId!==target.branchId)throw new AssetRejection('STALE_REVISION','BRANCH_TARGET_CHANGED');
          branchId=b.type==='SwitchBranch'?b.branchId:document.branchId;version=target.after;head=target.id;redo=this.child(head,branchId);
        }
        after=this.versionState(version);
      }else if(b.type==='ExportDocument'||b.type==='SaveCheckpoint'){
        if(b.type==='ExportDocument'&&b.historyHead!==document.historyHead)throw new AssetRejection('STALE_REVISION','HISTORY_HEAD_CHANGED');
        after=before;version=beforeVersion;head=document.historyHead;
      }else{
        const approved=b.type==='ResampleImage'||b.type==='CreateFlattenedCopy'?this.approved(c,document):null;
        if(approved){await protect(approved.plan);after=this.versionState(approved.after);version=approved.after;await protectAsset(approved.preparedAssetId);}
        else{
          if('candidate'in b){
            textCandidate=await this.texts.candidate(c,document,this.authority(id),protect);const source=await metadata(textCandidate.source);
            const prepared=await this.rasters.prepareDocument({type:'RetainText',source,pixels:textCandidate.source.render.pixels,width:textCandidate.source.render.width,height:textCandidate.source.render.height},randomUUID(),slot,check);proofs.push(...prepared.proofs);textAsset=prepared.asset;facts.push({type:'AssetRegistered',payload:{asset:textAsset}});
            after=structuredClone(before);after.schemaVersion=2;const old=after.layers.find(l=>l.id===b.layerId);
            if(b.type==='CreateTextLayer'){if(this.usedLayer(document.id,b.layerId))throw new AssetRejection('INVALID_INPUT','LAYER_ID_REUSE');after.layers.push({id:b.layerId,version:'1',kind:'text',source,name:b.name,assetId:textAsset.id,layerToDocument:[1,0,0,1,0,0],opacity:1,visible:true,locked:false,blend:'normal',mask:null});}
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
      for(const l of [...before.layers,...after.layers]){await protectAsset(l.assetId);if(l.mask)await protectAsset(l.mask.assetId);}
      if(beforeVersion.compositeAssetId)await protectAsset(beforeVersion.compositeAssetId);
      if(version.compositeAssetId)await protectAsset(version.compositeAssetId);
      const navigation=b.type==='Undo'||b.type==='Redo'||b.type==='SwitchBranch';
      if(!navigation&&b.type!=='SaveCheckpoint'&&!version.compositeAssetId){
        const prepared=await this.rasters.prepareDocument({type:'ComposeRaster',width:after.width,height:after.height,layers:after.layers.filter(l=>l.visible).map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask}))},randomUUID(),slot,check,textAsset);
        proofs.push(...prepared.proofs);facts.push({type:'AssetRegistered',payload:{asset:prepared.asset}});version={...version,compositeAssetId:prepared.asset.id};
      }
      if(b.type==='ExportDocument'){
        // An untouched empty document has no retained composite yet. Export it
        // directly as a composed PNG in this one frozen-revision transaction.
        const intermediate=facts.length?facts[0].type==='AssetRegistered'?facts[0].payload.asset:undefined:undefined;
        const prepared=await this.rasters.prepareDocument({type:'ExportRaster',assetId:version.compositeAssetId!},pending.operationId,slot,check,intermediate);proofs.push(...prepared.proofs);facts.push({type:'AssetRegistered',payload:{asset:prepared.asset}});
      }else if(!navigation&&b.type!=='SaveCheckpoint'){
        const forward=await metadata(this.patch(before,after,b.type)),inverse=await metadata(this.patch(after,before,b.type));
        node={id:head,documentId:document.id,parent:document.historyHead,branchId,revision:String(BigInt(document.revision)+1n),kind:'image-edit',operation:b.type,before:beforeVersion,after:version,forward,inverse,roots:[beforeVersion.state,version.state,forward,inverse]};
      }
      this.barrier('history-after-proofs');await new Promise<void>(resolve=>setImmediate(resolve));check();
      this.commit(bytes,(current,revision)=>{
        this.assertCommand(c,b.type==='ExportDocument'?document:current);if(textCandidate){this.texts.fence(c,current,this.authority(id),textCandidate);this.texts.limits(after);}if(b.type==='RasterizeTextDerivative')this.authority(id);if(b.type==='ResampleImage'||b.type==='CreateFlattenedCopy')this.approved(c,current);for(const p of proofs)this.objects.proven(p.ref,p.token);
        this.barrier('history-before-register');for(const p of proofs)this.objects.proven(p.ref,p.token);
        const seen=new Set<string>();for(const p of proofs){if(seen.has(p.ref.hash))continue;seen.add(p.ref.hash);this.register('history-command:'+id,p.ref,p.token);}
        const all:HistoryBuild['facts']=[...facts];
        if(b.type==='SaveCheckpoint'){
          all.push({type:'CheckpointSaved',payload:{checkpoint:{id:pending.operationId,name:b.name,documentId:current.id,documentRevision:current.revision,historyHead:current.historyHead,highWater:String(this.db.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value),image:beforeVersion}}});
        }else if(b.type!=='ExportDocument'){
          const next:Document={...current,revision,width:after.width,height:after.height,orderedLayerIds:after.layers.map(l=>l.id),historyHead:head,branchId,image:version,redo};
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
      const rejection=error instanceof AssetRejection?error:code==='PAYLOAD_TOO_LARGE'?new AssetRejection('CAPACITY','IMAGE_METADATA_LIMIT'):['ENOENT','MISSING_OBJECT','CORRUPT_OBJECT','ROOT_UNSAFE'].includes(code??'')?new AssetRejection('MISSING_ASSET','HISTORY_DEPENDENCY_UNAVAILABLE'):null;
      this.observations.push({commandId:id,operation:b.type,fullPreparationMs:performance.now()-start,error:rejection?.reason??code??'UNEXPECTED'});
      if(rejection)this.commit(bytes,()=>{throw rejection;});else this.pause(id);
    }finally{for(const p of proofs)this.objects.releaseProof(p.token);if(this.db.prepare('SELECT id FROM commands WHERE id=?').get(id))this.authorities.delete(id);if(this.observations.length>64)this.observations.shift();}
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

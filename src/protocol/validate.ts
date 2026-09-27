import {validateMaskMapping,retainedMask} from '../raster/mapping.js';
import { validateMaskPlan } from '../raster/mask.js';
import { fontVersion } from './text.js';
import type { Document, DomainEvent } from './store.js';
import { canonical } from './json.js';
export function requireValue(value: unknown, message = 'Invalid recovery data'): asserts value { if (!value) throw new Error(message); }
export const id = (v: unknown): v is string => typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const seq = (v: unknown): v is string => typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v);
export function keys(v: any, fields: string[]) { requireValue(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===fields.length && fields.every(k=>Object.hasOwn(v,k))); }
export function blob(v: any) { keys(v,['hash','byteLength','mediaType']); requireValue(/^sha256:[a-f0-9]{64}$/.test(v.hash) && seq(v.byteLength) && typeof v.mediaType==='string'); }
export function document(v: any): asserts v is Document {
  keys(v,['id','revision','branchId','width','height','color','depth','orderedLayerIds','historyHead','checkpoint','compositionVersion',...(v.image?['image','redo']:[])]);
  requireValue(id(v.id)&&seq(v.revision)&&id(v.branchId)&&id(v.historyHead)&&(v.checkpoint===null||id(v.checkpoint))&&v.compositionVersion===null&&
    Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&v.color==='sRGB'&&v.depth===8&&Array.isArray(v.orderedLayerIds)&&v.orderedLayerIds.length<=100&&v.orderedLayerIds.every(id)&&new Set(v.orderedLayerIds).size===v.orderedLayerIds.length);
  if(v.image){imageVersion(v.image);requireValue(v.redo===null||id(v.redo));}else requireValue(v.orderedLayerIds.length===0);
}
export function imageVersion(v:any){keys(v,['state','semanticDigest','compositeAssetId']);blob(v.state);requireValue(v.state.mediaType==='application/json'&&BigInt(v.state.byteLength)<=65536n&&/^sha256:[a-f0-9]{64}$/.test(v.semanticDigest)&&(v.compositeAssetId===null||id(v.compositeAssetId)));}
export function imageEditPreview(v:any){keys(v,['previewId','documentId','documentRevision','kind','plan','source','preparedAssetId','after']);requireValue(id(v.previewId)&&id(v.documentId)&&seq(v.documentRevision)&&['resample-image','flattened-copy'].includes(v.kind)&&id(v.preparedAssetId));blob(v.plan);imageVersion(v.source);imageVersion(v.after);}
export function asset(v:any) {
  const raster=['raster-preview','canonical-raster','canonical-png'].includes(v?.qualification);
  keys(v,['id','version','purpose','blob','dependencies','safety','availability','qualification','measuredMediaType',...(raster?['raster']:[]),...(v?.qualification==='font'?['font']:[])]);
  requireValue(id(v.id)&&seq(v.version)&&['image','mask','caption','font','text'].includes(v.purpose)&&Array.isArray(v.dependencies)&&(v.qualification==='font'?v.dependencies.length===1:raster?v.dependencies.length<=8:v.dependencies.length===0)&&
    ['safe','unknown','withheld','quarantined'].includes(v.safety)&&['available','missing','corrupt'].includes(v.availability)&&
    ['opaque-text','pending-decoder','raster-preview','canonical-raster','canonical-png','pending-text','font'].includes(v.qualification)&&['text/plain','image/png','image/jpeg','image/webp','application/octet-stream'].includes(v.measuredMediaType));
  blob(v.blob);for(const ref of v.dependencies)blob(ref);
  if(raster){requireValue(v.purpose==='image'&&v.measuredMediaType==='image/png'&&v.blob.mediaType==='image/png');rasterInfo(v.raster);
    requireValue(v.dependencies.some((r:any)=>canonical(r)===canonical(v.raster.manifest))&&v.dependencies.some((r:any)=>canonical(r)===canonical(v.raster.pixels)));
    requireValue(v.qualification==='canonical-png'?v.raster.role==='export':v.qualification==='raster-preview'?v.raster.role==='native':v.raster.role!=='export');
  }else if(v.qualification==='font'){fontVersion(v.font);requireValue(v.purpose==='font'&&v.safety==='safe'&&canonical(v.blob)===canonical(v.font.bytes)&&canonical(v.dependencies)===canonical([v.font.licenseRecord]));}
  else if(v.qualification==='pending-text')requireValue(['font','text'].includes(v.purpose)&&v.safety==='unknown'&&v.measuredMediaType==='application/octet-stream');
  else requireValue(v.qualification==='opaque-text'?v.purpose==='caption'&&v.measuredMediaType==='text/plain':v.purpose!=='caption'&&v.safety!=='safe');
}
export function rasterInfo(v:any){
  keys(v,['schemaVersion','pipeline','width','height','manifest','pixels','pixelIdentity','role','sourceAssetIds','conversion']);
  requireValue([1,2,3].includes(v.schemaVersion)&&typeof v.pipeline==='string'&&/^cp1-f64-triangle-area-v1\/sha256:[a-f0-9]{64}$/.test(v.pipeline)&&
    Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&
    /^sha256:[a-f0-9]{64}$/.test(v.pixelIdentity)&&['native','composite','export','mask'].includes(v.role)&&Array.isArray(v.sourceAssetIds)&&v.sourceAssetIds.length<=200&&v.sourceAssetIds.every(id));
  requireValue((v.schemaVersion>=2)===(v.role==='mask'));blob(v.manifest);blob(v.pixels);requireValue(v.manifest.mediaType==='application/json'&&BigInt(v.manifest.byteLength)<=65536n&&v.pixels.mediaType==='application/x-ideogram-rgba8'&&v.pixels.byteLength===String(v.width*v.height*4));
  if(v.conversion!==null)rasterConversion(v.conversion,v.width,v.height);else requireValue(v.role!=='native');
}
function rasterConversion(c:any,width:number,height:number){
  keys(c,['encodedWidth','encodedHeight','orientation','profile','profileHash','colorChanged','orientationChanged','resized']);
  requireValue(Number.isSafeInteger(c.encodedWidth)&&Number.isSafeInteger(c.encodedHeight)&&c.encodedWidth>0&&c.encodedHeight>0&&c.encodedWidth<=8192&&c.encodedHeight<=8192&&c.encodedWidth*c.encodedHeight<=25000000&&Number.isInteger(c.orientation)&&c.orientation>=1&&c.orientation<=8&&['untagged-srgb','srgb','p3'].includes(c.profile)&&
    (c.profile==='untagged-srgb'?c.profileHash===null:/^sha256:[a-f0-9]{64}$/.test(c.profileHash))&&c.colorChanged===(c.profile==='p3')&&c.orientationChanged===(c.orientation!==1)&&c.resized===false&&width===(c.orientation>=5?c.encodedHeight:c.encodedWidth)&&height===(c.orientation>=5?c.encodedWidth:c.encodedHeight));
}

export function rasterManifest(v:any):void{
  keys(v,['schemaVersion','pipeline','width','height','format','layout','tileSize','pixels','tiles','dependencies','plan']);
  requireValue([1,2,3].includes(v.schemaVersion)&&typeof v.pipeline==='string'&&/^cp1-f64-triangle-area-v1\/sha256:[a-f0-9]{64}$/.test(v.pipeline)&&Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&v.format==='straight-srgb-rgba8'&&v.layout==='row-major-tile-views-v1'&&v.tileSize===512);
  blob(v.pixels);requireValue(v.pixels.mediaType==='application/x-ideogram-rgba8'&&v.pixels.byteLength===String(v.width*v.height*4));
  requireValue(Array.isArray(v.tiles)&&v.tiles.length===Math.ceil(v.width/512)*Math.ceil(v.height/512));
  let i=0;for(let y=0;y<v.height;y+=512)for(let x=0;x<v.width;x+=512){const t=v.tiles[i++];keys(t,['x','y','width','height','hash']);requireValue(t.x===x&&t.y===y&&t.width===Math.min(512,v.width-x)&&t.height===Math.min(512,v.height-y)&&/^sha256:[a-f0-9]{64}$/.test(t.hash));}
  requireValue(Array.isArray(v.dependencies)&&v.dependencies.length<=200);for(const ref of v.dependencies)blob(ref);
  const p=v.plan;requireValue(p&&typeof p==='object');requireValue(v.schemaVersion===(p.kind==='authored-mask-v2'||p.kind==='cp1-composition'&&p.layers?.some((l:any)=>l.mask&&retainedMask(l.mask))?3:p.kind==='authored-mask-v1'||p.kind==='cp1-composition'&&p.layers?.some((l:any)=>l.mask?.mapping==='document-r16-v1')?2:1));
  if(p.kind==='decoded-native'){keys(p,['kind','sourceAssetId','conversion','codec']);requireValue(id(p.sourceAssetId)&&p.codec===v.pipeline.split('/')[1]);rasterConversion(p.conversion,v.width,v.height);}
  else if(p.kind==='frozen-png-export'){keys(p,['kind','sourceAssetId','pixelIdentity','encoder']);requireValue(id(p.sourceAssetId)&&/^sha256:[a-f0-9]{64}$/.test(p.pixelIdentity)&&/^sha256:[a-f0-9]{64}$/.test(p.encoder));}
  else if(p.kind==='cp1-composition'){
    keys(p,['kind','layers','maskMapping','precision','kernel','edge','footprints']);requireValue(Array.isArray(p.layers)&&p.layers.length<=100&&p.maskMapping===(v.schemaVersion===3?'explicit-retained-domain-zero-v1':'document-luminance-alpha-v1')&&p.precision==='binary64'&&p.kernel==='triangle-area-source-axis-row-norm-v1'&&p.edge==='transparent-zero-no-renormalization'&&Array.isArray(p.footprints)&&p.footprints.length===p.layers.length);
    for(const l of p.layers){keys(l,['assetId','transform','opacity','mask']);requireValue(id(l.assetId)&&Array.isArray(l.transform)&&l.transform.length===6&&l.transform.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))&&Number.isFinite(l.opacity)&&l.opacity>=0&&l.opacity<=1);const [a,b,c,d]=l.transform;requireValue(Number.isFinite(a*d-b*c)&&a*d-b*c!==0);
      if(l.mask!==null){validateMaskMapping(l.mask);}
    }for(const f of p.footprints){keys(f,['x','y','width','height']);requireValue([f.x,f.y,f.width,f.height].every(Number.isSafeInteger)&&f.width>=0&&f.height>=0);}
  }else if(['authored-mask-v1','authored-mask-v2'].includes(p.kind)){keys(p,['kind','authoring','hard','effective','statistics']);validateMaskPlan(p.authoring);requireValue((p.kind==='authored-mask-v2')===(p.authoring.schemaVersion===2));requireValue(p.authoring.width===v.width&&p.authoring.height===v.height);for(const r of [p.hard,p.effective]){blob(r);requireValue(r.mediaType==='application/x-ideogram-r16le'&&r.byteLength===String(v.width*v.height*2)&&v.dependencies.some((d:any)=>canonical(d)===canonical(r)));}keys(p.statistics,['hardPixels','effectivePixels','support']);requireValue([p.statistics.hardPixels,p.statistics.effectivePixels].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=v.width*v.height));if(p.statistics.support!==null){keys(p.statistics.support,['x','y','width','height']);requireValue(Object.values(p.statistics.support).every(Number.isSafeInteger));}
  }else if(p.kind==='retained-text'){keys(p,['kind','source']);blob(p.source);requireValue(p.source.mediaType==='application/json');}
  else throw new Error('Unsupported raster plan');
}
export function entity(type: string, value: any) {
  if(type==='asset'){asset(value);return value.version;}
  if(type==='document') { document(value); return value.revision; }
  if(type==='checkpoint') {
    keys(value,['id','name','documentId','documentRevision','historyHead','highWater',...(value.image?['image']:[])]);if(value.image)imageVersion(value.image);
    requireValue(id(value.id)&&id(value.documentId)&&seq(value.documentRevision)&&id(value.historyHead)&&seq(value.highWater)&&typeof value.name==='string'); return value.documentRevision;
  }
  if(type==='history'&&value.kind==='image-edit') {
    keys(value,['id','documentId','branchId','parent','revision','kind','operation','before','after','forward','inverse','roots']);
    requireValue(['id','documentId','branchId','parent'].every(k=>id(value[k]))&&seq(value.revision)&&['ImportAsset','ApplyTransform','SetLayerProperties','DeleteLayer','DuplicateLayer','MoveLayers','CropDocument','ResizeCanvas','ResampleImage','CreateFlattenedCopy','CreateTextLayer','CommitTextEdit','ReplaceTextFont','RasterizeTextDerivative'].includes(value.operation));
    imageVersion(value.before);imageVersion(value.after);blob(value.forward);blob(value.inverse);
    requireValue(Array.isArray(value.roots)&&value.roots.length===4&&canonical(value.roots)===canonical([value.before.state,value.after.state,value.forward,value.inverse]));return value.revision;
  }
  if(type==='history') {
    keys(value,['id','documentId','branchId','parent','forward','inverse','roots']);
    requireValue(id(value.id)&&id(value.documentId)&&id(value.branchId)&&value.parent===null&&Array.isArray(value.roots));
    keys(value.forward,['before','after']);keys(value.inverse,['before','after']); document(value.forward.after);document(value.inverse.before);
    requireValue(value.forward.before===null&&value.inverse.after===null&&canonical(value.forward.after)===canonical(value.inverse.before)&&value.documentId===value.forward.after.id&&value.branchId===value.forward.after.branchId&&value.id===value.forward.after.historyHead);
    for(const ref of value.roots) blob(ref);return value.forward.after.revision;
  }
  throw new Error('Unsupported projection family');
}
export function event(v: any): asserts v is DomainEvent {
  keys(v,['schemaVersion','payloadVersion','eventId','workspaceSeq','streamId','streamSeq','documentId','resultingDocumentRevision','commandId','correlationId','causationId','transactionId','writerEpoch','recordedAt','type','payload']);
  requireValue(v.schemaVersion===1&&v.payloadVersion===1&&['eventId','streamId','commandId','correlationId','transactionId'].every(k=>id(v[k]))&&
    ['workspaceSeq','streamSeq','writerEpoch'].every(k=>seq(v[k]))&&(v.causationId===null||id(v.causationId))&&typeof v.recordedAt==='string'&&Number.isFinite(Date.parse(v.recordedAt))&&
    new TextEncoder().encode(canonical(v)).length<=16384);
  if(['BundlePrepared','BundleImportReviewed','PortableCancelled'].includes(v.type)){
    requireValue(v.documentId===null&&v.resultingDocumentRevision===null&&v.streamId==='portable'&&v.streamSeq===v.workspaceSeq);
    if(v.type==='BundlePrepared'){keys(v.payload,['bundle']);const b=v.payload.bundle;keys(b,['protocolVersion','bundleId','documentId','documentRevision','capturedHighWater','uiDigest','blob','complete','status','destinationStatus']);blob(b.blob);requireValue(b.protocolVersion===1&&id(b.bundleId)&&id(b.documentId)&&seq(b.documentRevision)&&seq(b.capturedHighWater)&&/^sha256:[a-f0-9]{64}$/.test(b.uiDigest)&&b.blob.mediaType==='application/x-ideogram-project'&&b.complete===true&&b.status==='copy-ready'&&b.destinationStatus==='unconfirmed');}
    else if(v.type==='BundleImportReviewed'){keys(v.payload,['reviewId','reviewHash']);requireValue(id(v.payload.reviewId)&&/^sha256:[a-f0-9]{64}$/.test(v.payload.reviewHash));}
    else{keys(v.payload,['operationId']);requireValue(id(v.payload.operationId));}return;
  }
  if(v.type==='BundleImported'){keys(v.payload,['namespaceId','source','document','namespaceHash']);blob(v.payload.source);document(v.payload.document);requireValue(/^sha256:[a-f0-9]{64}$/.test(v.payload.namespaceHash)&&id(v.payload.namespaceId)&&v.payload.source.mediaType==='application/x-ideogram-project'&&v.documentId===v.payload.document.id&&v.resultingDocumentRevision===v.payload.document.revision&&v.streamId===v.documentId&&v.streamSeq===v.resultingDocumentRevision);return;}
  if(v.type==='ImageEditPreviewPrepared'||v.type==='ImageEditReviewPrepared'||v.type==='AssetRegistered'||v.type==='StagingTransferReviewPrepared'||v.type==='RasterReviewPrepared'||v.type==='StagingOwnershipTransferred'){
    requireValue(v.documentId===null&&v.resultingDocumentRevision===null&&v.streamId==='assets'&&v.streamSeq===v.workspaceSeq);
    if(v.type==='ImageEditPreviewPrepared'){keys(v.payload,['preview']);imageEditPreview(v.payload.preview);}
    else if(v.type==='ImageEditReviewPrepared'){keys(v.payload,['reviewId','reviewHash']);requireValue(id(v.payload.reviewId)&&/^sha256:[a-f0-9]{64}$/.test(v.payload.reviewHash));}
    else if(v.type==='AssetRegistered'){keys(v.payload,['asset']);asset(v.payload.asset);}
    else if(v.type==='StagingTransferReviewPrepared'||v.type==='RasterReviewPrepared'){keys(v.payload,['reviewId','reviewHash']);requireValue(id(v.payload.reviewId)&&/^sha256:[a-f0-9]{64}$/.test(v.payload.reviewHash));}
    else {keys(v.payload,['stagingId','fromClientId','toClientId','version','committedOffset']);requireValue(id(v.payload.stagingId)&&id(v.payload.fromClientId)&&id(v.payload.toClientId)&&seq(v.payload.version)&&seq(v.payload.committedOffset));}
    return;
  }
  requireValue(id(v.documentId)&&seq(v.resultingDocumentRevision)&&v.streamId===v.documentId&&v.streamSeq===v.resultingDocumentRevision);
  if(v.type==='DocumentCreated') {
    keys(v.payload,['document','history']); document(v.payload.document);entity('history',v.payload.history);
    requireValue(v.documentId===v.payload.document.id&&v.resultingDocumentRevision===v.payload.document.revision&&canonical(v.payload.document)===canonical(v.payload.history.forward.after));
  } else if(v.type==='ImageEdited'||v.type==='HistoryNavigated') {
    keys(v.payload,v.type==='ImageEdited'?['document','history']:['document','previousHead','action']);document(v.payload.document);
    requireValue(v.payload.document.id===v.documentId&&v.payload.document.revision===v.resultingDocumentRevision&&v.payload.document.image);
    if(v.type==='ImageEdited'){entity('history',v.payload.history);requireValue(v.payload.history.kind==='image-edit'&&v.payload.history.id===v.payload.document.historyHead&&v.payload.history.documentId===v.documentId&&v.payload.history.branchId===v.payload.document.branchId&&canonical(v.payload.history.after)===canonical(v.payload.document.image));}
    else requireValue(id(v.payload.previousHead)&&['Undo','Redo','SwitchBranch'].includes(v.payload.action));
  } else if(v.type==='CheckpointSaved') {
    keys(v.payload,['checkpoint']);entity('checkpoint',v.payload.checkpoint);requireValue(v.payload.checkpoint.documentId===v.documentId);
  } else throw new Error('Unsupported event');
}

import type { Document, DomainEvent } from './store.js';
import { canonical } from './json.js';
export function requireValue(value: unknown, message = 'Invalid recovery data'): asserts value { if (!value) throw new Error(message); }
export const id = (v: unknown): v is string => typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const seq = (v: unknown): v is string => typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v);
export function keys(v: any, fields: string[]) { requireValue(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===fields.length && fields.every(k=>Object.hasOwn(v,k))); }
function blob(v: any) { keys(v,['hash','byteLength','mediaType']); requireValue(/^sha256:[a-f0-9]{64}$/.test(v.hash) && seq(v.byteLength) && typeof v.mediaType==='string'); }
export function document(v: any): asserts v is Document {
  keys(v,['id','revision','branchId','width','height','color','depth','orderedLayerIds','historyHead','checkpoint','compositionVersion']);
  requireValue(id(v.id)&&seq(v.revision)&&id(v.branchId)&&id(v.historyHead)&&(v.checkpoint===null||id(v.checkpoint))&&v.compositionVersion===null&&
    Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&v.color==='sRGB'&&v.depth===8&&Array.isArray(v.orderedLayerIds)&&v.orderedLayerIds.length===0);
}
export function asset(v:any) {
  const raster=['raster-preview','canonical-raster','canonical-png'].includes(v?.qualification);
  keys(v,['id','version','purpose','blob','dependencies','safety','availability','qualification','measuredMediaType',...(raster?['raster']:[])]);
  requireValue(id(v.id)&&seq(v.version)&&['image','mask','caption'].includes(v.purpose)&&Array.isArray(v.dependencies)&&(raster?v.dependencies.length<=8:v.dependencies.length===0)&&
    ['safe','unknown','withheld','quarantined'].includes(v.safety)&&['available','missing','corrupt'].includes(v.availability)&&
    ['opaque-text','pending-decoder','raster-preview','canonical-raster','canonical-png'].includes(v.qualification)&&['text/plain','image/png','image/jpeg','image/webp'].includes(v.measuredMediaType));
  blob(v.blob);for(const ref of v.dependencies)blob(ref);
  if(raster){requireValue(v.purpose==='image'&&v.measuredMediaType==='image/png'&&v.blob.mediaType==='image/png');rasterInfo(v.raster);
    requireValue(v.dependencies.some((r:any)=>canonical(r)===canonical(v.raster.manifest))&&v.dependencies.some((r:any)=>canonical(r)===canonical(v.raster.pixels)));
    requireValue(v.qualification==='canonical-png'?v.raster.role==='export':v.qualification==='raster-preview'?v.raster.role==='native':v.raster.role!=='export');
  }else requireValue(v.qualification==='opaque-text'?v.purpose==='caption'&&v.measuredMediaType==='text/plain':v.purpose!=='caption'&&v.safety!=='safe');
}
export function rasterInfo(v:any){
  keys(v,['schemaVersion','pipeline','width','height','manifest','pixels','pixelIdentity','role','sourceAssetIds','conversion']);
  requireValue(v.schemaVersion===1&&typeof v.pipeline==='string'&&/^cp1-f64-triangle-area-v1\/sha256:[a-f0-9]{64}$/.test(v.pipeline)&&
    Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&
    /^sha256:[a-f0-9]{64}$/.test(v.pixelIdentity)&&['native','composite','export'].includes(v.role)&&Array.isArray(v.sourceAssetIds)&&v.sourceAssetIds.length<=200&&v.sourceAssetIds.every(id));
  blob(v.manifest);blob(v.pixels);requireValue(v.manifest.mediaType==='application/json'&&BigInt(v.manifest.byteLength)<=65536n&&v.pixels.mediaType==='application/x-ideogram-rgba8'&&v.pixels.byteLength===String(v.width*v.height*4));
  if(v.conversion!==null)rasterConversion(v.conversion,v.width,v.height);else requireValue(v.role!=='native');
}
function rasterConversion(c:any,width:number,height:number){
  keys(c,['encodedWidth','encodedHeight','orientation','profile','profileHash','colorChanged','orientationChanged','resized']);
  requireValue(Number.isSafeInteger(c.encodedWidth)&&Number.isSafeInteger(c.encodedHeight)&&c.encodedWidth>0&&c.encodedHeight>0&&c.encodedWidth<=8192&&c.encodedHeight<=8192&&c.encodedWidth*c.encodedHeight<=25000000&&Number.isInteger(c.orientation)&&c.orientation>=1&&c.orientation<=8&&['untagged-srgb','srgb','p3'].includes(c.profile)&&
    (c.profile==='untagged-srgb'?c.profileHash===null:/^sha256:[a-f0-9]{64}$/.test(c.profileHash))&&c.colorChanged===(c.profile==='p3')&&c.orientationChanged===(c.orientation!==1)&&c.resized===false&&width===(c.orientation>=5?c.encodedHeight:c.encodedWidth)&&height===(c.orientation>=5?c.encodedWidth:c.encodedHeight));
}

export function rasterManifest(v:any):void{
  keys(v,['schemaVersion','pipeline','width','height','format','layout','tileSize','pixels','tiles','dependencies','plan']);
  requireValue(v.schemaVersion===1&&typeof v.pipeline==='string'&&/^cp1-f64-triangle-area-v1\/sha256:[a-f0-9]{64}$/.test(v.pipeline)&&Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&v.format==='straight-srgb-rgba8'&&v.layout==='row-major-tile-views-v1'&&v.tileSize===512);
  blob(v.pixels);requireValue(v.pixels.mediaType==='application/x-ideogram-rgba8'&&v.pixels.byteLength===String(v.width*v.height*4));
  requireValue(Array.isArray(v.tiles)&&v.tiles.length===Math.ceil(v.width/512)*Math.ceil(v.height/512));
  let i=0;for(let y=0;y<v.height;y+=512)for(let x=0;x<v.width;x+=512){const t=v.tiles[i++];keys(t,['x','y','width','height','hash']);requireValue(t.x===x&&t.y===y&&t.width===Math.min(512,v.width-x)&&t.height===Math.min(512,v.height-y)&&/^sha256:[a-f0-9]{64}$/.test(t.hash));}
  requireValue(Array.isArray(v.dependencies)&&v.dependencies.length<=200);for(const ref of v.dependencies)blob(ref);
  const p=v.plan;requireValue(p&&typeof p==='object');
  if(p.kind==='decoded-native'){keys(p,['kind','sourceAssetId','conversion','codec']);requireValue(id(p.sourceAssetId)&&p.codec===v.pipeline.split('/')[1]);rasterConversion(p.conversion,v.width,v.height);}
  else if(p.kind==='frozen-png-export'){keys(p,['kind','sourceAssetId','pixelIdentity','encoder']);requireValue(id(p.sourceAssetId)&&/^sha256:[a-f0-9]{64}$/.test(p.pixelIdentity)&&/^sha256:[a-f0-9]{64}$/.test(p.encoder));}
  else if(p.kind==='cp1-composition'){
    keys(p,['kind','layers','maskMapping','precision','kernel','edge','footprints']);requireValue(Array.isArray(p.layers)&&p.layers.length<=100&&p.maskMapping==='document-luminance-alpha-v1'&&p.precision==='binary64'&&p.kernel==='triangle-area-source-axis-row-norm-v1'&&p.edge==='transparent-zero-no-renormalization'&&Array.isArray(p.footprints)&&p.footprints.length===p.layers.length);
    for(const l of p.layers){keys(l,['assetId','transform','opacity','mask']);requireValue(id(l.assetId)&&Array.isArray(l.transform)&&l.transform.length===6&&l.transform.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))&&Number.isFinite(l.opacity)&&l.opacity>=0&&l.opacity<=1);const [a,b,c,d]=l.transform;requireValue(Number.isFinite(a*d-b*c)&&a*d-b*c!==0);
      if(l.mask!==null){keys(l.mask,['assetId','mapping','inverted']);requireValue(id(l.mask.assetId)&&l.mask.mapping==='document-luminance-alpha-v1'&&typeof l.mask.inverted==='boolean');}
    }for(const f of p.footprints){keys(f,['x','y','width','height']);requireValue([f.x,f.y,f.width,f.height].every(Number.isSafeInteger)&&f.width>=0&&f.height>=0);}
  }else throw new Error('Unsupported raster plan');
}
export function entity(type: string, value: any) {
  if(type==='asset'){asset(value);return value.version;}
  if(type==='document') { document(value); return value.revision; }
  if(type==='checkpoint') {
    keys(value,['id','name','documentId','documentRevision','historyHead','highWater']);
    requireValue(id(value.id)&&id(value.documentId)&&seq(value.documentRevision)&&id(value.historyHead)&&seq(value.highWater)&&typeof value.name==='string'); return value.documentRevision;
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
  if(v.type==='AssetRegistered'||v.type==='StagingTransferReviewPrepared'||v.type==='RasterReviewPrepared'||v.type==='StagingOwnershipTransferred'){
    requireValue(v.documentId===null&&v.resultingDocumentRevision===null&&v.streamId==='assets'&&v.streamSeq===v.workspaceSeq);
    if(v.type==='AssetRegistered'){keys(v.payload,['asset']);asset(v.payload.asset);}
    else if(v.type==='StagingTransferReviewPrepared'||v.type==='RasterReviewPrepared'){keys(v.payload,['reviewId','reviewHash']);requireValue(id(v.payload.reviewId)&&/^sha256:[a-f0-9]{64}$/.test(v.payload.reviewHash));}
    else {keys(v.payload,['stagingId','fromClientId','toClientId','version','committedOffset']);requireValue(id(v.payload.stagingId)&&id(v.payload.fromClientId)&&id(v.payload.toClientId)&&seq(v.payload.version)&&seq(v.payload.committedOffset));}
    return;
  }
  requireValue(id(v.documentId)&&seq(v.resultingDocumentRevision)&&v.streamId===v.documentId&&v.streamSeq===v.resultingDocumentRevision);
  if(v.type==='DocumentCreated') {
    keys(v.payload,['document','history']); document(v.payload.document);entity('history',v.payload.history);
    requireValue(v.documentId===v.payload.document.id&&v.resultingDocumentRevision===v.payload.document.revision&&canonical(v.payload.document)===canonical(v.payload.history.forward.after));
  } else if(v.type==='CheckpointSaved') {
    keys(v.payload,['checkpoint']);entity('checkpoint',v.payload.checkpoint);requireValue(v.payload.checkpoint.documentId===v.documentId);
  } else throw new Error('Unsupported event');
}

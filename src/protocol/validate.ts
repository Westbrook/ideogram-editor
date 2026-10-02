import {documentCreationMetadata,documentCreationBackground} from './document-creation.js';
import {recoveryDisclosure} from './portable.js';
import {validateRequestTextTreatmentEnvelope,validateTextTreatmentAdoptionChoice} from '../request/text-treatment.js';
import {decodedDerivedPlan} from './raster-import.js';
import {v45EditInputsPlan,v45EditInputsReferences} from './v45-inputs.js';
import {adapterVersion,adapterDependencies,adapterDeletionRecord} from './adapters.js';
import {validateRequestSourceCapture} from './request-edits.js';
import {queueEvents} from './queue-events.js';
import {validateMaskMapping,retainedMask} from '../raster/mapping.js';
import { validateMaskPlan } from '../raster/mask.js';
import { validateRequestRasterPlan, requestRasterGrid, requireOutputMapping } from '../request/raster-plan.js';
import { fontVersion } from './text.js';
import type { Document, DomainEvent } from './store.js';
import type { ContributionStack } from './raster.js';
import { canonical } from './json.js';
import { exportOptions } from './export.js';
export function requireValue(value: unknown, message = 'Invalid recovery data'): asserts value { if (!value) throw new Error(message); }
export const id = (v: unknown): v is string => typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const seq = (v: unknown): v is string => typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v);
export function keys(v: any, fields: string[]) { requireValue(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===fields.length && fields.every(k=>Object.hasOwn(v,k))); }
export function blob(v: any) { keys(v,['hash','byteLength','mediaType']); requireValue(/^sha256:[a-f0-9]{64}$/.test(v.hash) && seq(v.byteLength) && typeof v.mediaType==='string'); }
export function document(v: any): asserts v is Document {
  keys(v,['id','revision','branchId','width','height','color','depth','orderedLayerIds','historyHead','checkpoint','compositionVersion',...(v.image?['image','redo']:[]),...(Object.hasOwn(v,'metadata')?['metadata']:[])]);
  requireValue(id(v.id)&&seq(v.revision)&&id(v.branchId)&&id(v.historyHead)&&(v.checkpoint===null||id(v.checkpoint))&&(v.compositionVersion===null||id(v.compositionVersion))&&
    Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&v.color==='sRGB'&&v.depth===8&&Array.isArray(v.orderedLayerIds)&&v.orderedLayerIds.length<=100&&v.orderedLayerIds.every(id)&&new Set(v.orderedLayerIds).size===v.orderedLayerIds.length);
  if(Object.hasOwn(v,'metadata'))documentCreationMetadata(v.metadata);
  if(v.image){imageVersion(v.image);requireValue(v.redo===null||id(v.redo));}else requireValue(v.orderedLayerIds.length===0);
}
export function imageVersion(v:any){keys(v,['state','semanticDigest','compositeAssetId']);blob(v.state);requireValue(v.state.mediaType==='application/json'&&BigInt(v.state.byteLength)<=65536n&&/^sha256:[a-f0-9]{64}$/.test(v.semanticDigest)&&(v.compositeAssetId===null||id(v.compositeAssetId)));}
export function imageEditPreview(v:any){
  keys(v,['previewId','documentId','documentRevision','kind','plan','source','preparedAssetId','after',...(v.kind==='candidate-adoption'?['candidate']:[])]);
  requireValue(id(v.previewId)&&id(v.documentId)&&seq(v.documentRevision)&&['resample-image','flattened-copy','candidate-adoption'].includes(v.kind)&&id(v.preparedAssetId));blob(v.plan);imageVersion(v.source);imageVersion(v.after);
  if(v.kind==='candidate-adoption'){
    const c=v.candidate;keys(c,['candidateId','mode','placement','newDocumentId','coverage','outputMapping',...(Object.hasOwn(c,'replacement')?['replacement']:[]),...(Object.hasOwn(c,'textTreatment')?['textTreatment']:[])]);requireValue(id(c.candidateId)&&['safe-region','full-candidate'].includes(c.mode)&&['current-document','new-document'].includes(c.placement)&&(c.placement==='new-document'?id(c.newDocumentId):c.newDocumentId===null));
    if(Object.hasOwn(c,'replacement')){keys(c.replacement,['layerId','layerVersion']);requireValue(c.mode==='full-candidate'&&c.placement==='current-document'&&id(c.replacement.layerId)&&seq(c.replacement.layerVersion));}
    if(c.textTreatment){const t=c.textTreatment;keys(t,['kind','plan','choice','nativeOffAssetId','nativeOnAssetId']);requireValue(t.kind==='candidate-text-treatment-preview-1'&&id(t.nativeOffAssetId)&&id(t.nativeOnAssetId)&&!c.replacement);validateRequestTextTreatmentEnvelope(t.plan);validateTextTreatmentAdoptionChoice(t.choice);requireValue((c.placement==='new-document')===(t.choice.action==='new-document'));}
    if(c.coverage!==null){keys(c.coverage,['originalEffectivePixels','effectivePixels','lostPixels']);requireValue(Object.values(c.coverage).every(n=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=25000000)&&c.coverage.originalEffectivePixels-c.coverage.effectivePixels===c.coverage.lostPixels);}
    if(c.outputMapping!==null)requireOutputMapping(c.outputMapping.requestPlan,c.outputMapping,c.outputMapping.actualOutput?.width,c.outputMapping.actualOutput?.height);
    requireValue(c.mode==='safe-region'?c.coverage!==null:c.coverage===null&&c.outputMapping===null);
  }
}
export function asset(v:any) {
  const raster=['raster-preview','canonical-raster','canonical-png','canonical-jpeg'].includes(v?.qualification);
  keys(v,['id','version','purpose','blob','dependencies','safety','availability','qualification','measuredMediaType',...(raster?['raster']:[]),...(Object.hasOwn(v,'retainedMetadata')?['retainedMetadata']:[]),...(v?.qualification==='font'?['font']:[]),...(v?.qualification==='adapter-version'?['adapter']:[]),...(v?.qualification==='adapter-deletion'?['adapterDeletion']:[])]);
  requireValue(id(v.id)&&seq(v.version)&&['image','mask','caption','font','text','adapter'].includes(v.purpose)&&Array.isArray(v.dependencies)&&(v.qualification==='adapter-version'?v.dependencies.length<=5:v.qualification==='font'?v.dependencies.length===1:raster?v.dependencies.length<=(v.retainedMetadata?9:8):v.dependencies.length===0)&&
    ['safe','unknown','withheld','quarantined'].includes(v.safety)&&['available','missing','corrupt'].includes(v.availability)&&
    ['opaque-text','pending-decoder','raster-preview','canonical-raster','canonical-png','canonical-jpeg','pending-text','font','pending-adapter','adapter-version','adapter-deletion'].includes(v.qualification)&&['text/plain','image/png','image/jpeg','image/webp','application/octet-stream'].includes(v.measuredMediaType));
  blob(v.blob);for(const ref of v.dependencies)blob(ref);
  if(Object.hasOwn(v,'retainedMetadata')){blob(v.retainedMetadata);requireValue(raster&&v.retainedMetadata.mediaType==='application/json'&&BigInt(v.retainedMetadata.byteLength)<=65536n&&v.dependencies.some((r:any)=>canonical(r)===canonical(v.retainedMetadata)));}
  if(raster){const media=v.qualification==='canonical-jpeg'?'image/jpeg':'image/png';requireValue(v.purpose==='image'&&v.measuredMediaType===media&&v.blob.mediaType===media);rasterInfo(v.raster);
    requireValue(v.dependencies.some((r:any)=>canonical(r)===canonical(v.raster.manifest))&&v.dependencies.some((r:any)=>canonical(r)===canonical(v.raster.pixels)));
    requireValue(v.qualification==='canonical-png'||v.qualification==='canonical-jpeg'?v.raster.role==='export':v.qualification==='raster-preview'?['native','derived'].includes(v.raster.role):v.raster.role!=='export');
  }else if(v.qualification==='font'){fontVersion(v.font);requireValue(v.purpose==='font'&&v.safety==='safe'&&canonical(v.blob)===canonical(v.font.bytes)&&canonical(v.dependencies)===canonical([v.font.licenseRecord]));}
  else if(v.qualification==='adapter-version'){adapterVersion(v.adapter);requireValue(v.purpose==='adapter'&&v.measuredMediaType==='application/octet-stream'&&v.adapter.id===v.id&&v.safety===(v.adapter.qualification==='incompatible'?'quarantined':'unknown')&&canonical(v.blob)===canonical(v.adapter.weights)&&canonical(v.dependencies)===canonical(adapterDependencies(v.adapter)));}
  else if(v.qualification==='adapter-deletion'){adapterDeletionRecord(v.adapterDeletion);requireValue(v.purpose==='adapter'&&v.blob.mediaType==='application/json'&&v.safety==='unknown'&&v.measuredMediaType==='application/octet-stream');}
  else if(v.qualification==='pending-adapter')requireValue(v.purpose==='adapter'&&v.safety==='unknown'&&v.measuredMediaType==='application/octet-stream');
  else if(v.qualification==='pending-text')requireValue(['font','text'].includes(v.purpose)&&v.safety==='unknown'&&v.measuredMediaType==='application/octet-stream');
  else requireValue(v.qualification==='opaque-text'?v.purpose==='caption'&&v.measuredMediaType==='text/plain':v.purpose!=='caption'&&v.safety!=='safe');
}
export function rasterInfo(v:any){
  keys(v,['schemaVersion','pipeline','width','height','manifest','pixels','pixelIdentity','role','sourceAssetIds','conversion']);
  requireValue([1,2,3].includes(v.schemaVersion)&&typeof v.pipeline==='string'&&/^cp1-f64-triangle-area-v1\/sha256:[a-f0-9]{64}$/.test(v.pipeline)&&
    Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&
    /^sha256:[a-f0-9]{64}$/.test(v.pixelIdentity)&&['native','derived','composite','export','mask'].includes(v.role)&&Array.isArray(v.sourceAssetIds)&&v.sourceAssetIds.length<=200&&v.sourceAssetIds.every(id));
  requireValue((v.schemaVersion>=2)===(v.role==='mask'));blob(v.manifest);blob(v.pixels);requireValue(v.manifest.mediaType==='application/json'&&BigInt(v.manifest.byteLength)<=65536n&&v.pixels.mediaType==='application/x-ideogram-rgba8'&&v.pixels.byteLength===String(v.width*v.height*4));
  if(v.role==='derived')requireValue(v.schemaVersion===1&&v.conversion===null&&v.sourceAssetIds.length===1);
  if(v.conversion!==null)rasterConversion(v.conversion,v.width,v.height);else requireValue(v.role!=='native');
}
function rasterConversion(c:any,width:number,height:number){
  keys(c,['encodedWidth','encodedHeight','orientation','profile','profileHash','colorChanged','orientationChanged','resized']);
  requireValue(Number.isSafeInteger(c.encodedWidth)&&Number.isSafeInteger(c.encodedHeight)&&c.encodedWidth>0&&c.encodedHeight>0&&c.encodedWidth<=8192&&c.encodedHeight<=8192&&c.encodedWidth*c.encodedHeight<=25000000&&Number.isInteger(c.orientation)&&c.orientation>=1&&c.orientation<=8&&['untagged-srgb','srgb','p3'].includes(c.profile)&&
    (c.profile==='untagged-srgb'?c.profileHash===null:/^sha256:[a-f0-9]{64}$/.test(c.profileHash))&&c.colorChanged===(c.profile==='p3')&&c.orientationChanged===(c.orientation!==1)&&c.resized===false&&width===(c.orientation>=5?c.encodedHeight:c.encodedWidth)&&height===(c.orientation>=5?c.encodedWidth:c.encodedHeight));
}

export function contributionStack(v:any):asserts v is ContributionStack{
  keys(v,['schemaVersion','kind','pipeline','width','height','contributions']);
  requireValue(v.schemaVersion===1&&v.kind==='cp1-contribution-stack-v1'&&typeof v.pipeline==='string'&&/^cp1-f64-triangle-area-v1\/sha256:[a-f0-9]{64}$/.test(v.pipeline)&&Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&Array.isArray(v.contributions)&&v.contributions.length>0&&v.contributions.length<=100);
  for(const contribution of v.contributions){keys(contribution,['manifest','pixels','pixelIdentity']);blob(contribution.manifest);blob(contribution.pixels);requireValue(contribution.manifest.mediaType==='application/json'&&BigInt(contribution.manifest.byteLength)<=65536n&&contribution.pixels.mediaType==='application/x-ideogram-rgba8'&&contribution.pixels.byteLength===String(v.width*v.height*4)&&/^sha256:[a-f0-9]{64}$/.test(contribution.pixelIdentity));}
}
function rasterLayer(v:any){
  keys(v,['assetId','transform','opacity','mask']);requireValue(id(v.assetId)&&Array.isArray(v.transform)&&v.transform.length===6&&v.transform.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))&&Number.isFinite(v.opacity)&&v.opacity>=0&&v.opacity<=1);const [a,b,c,d]=v.transform;requireValue(Number.isFinite(a*d-b*c)&&a*d-b*c!==0);if(v.mask!==null)validateMaskMapping(v.mask);
}
function rasterFootprint(v:any){keys(v,['x','y','width','height']);requireValue([v.x,v.y,v.width,v.height].every(Number.isSafeInteger)&&v.width>=0&&v.height>=0);}
export function rasterManifest(v:any):void{
  keys(v,['schemaVersion','pipeline','width','height','format','layout','tileSize','pixels','tiles','dependencies','plan']);
  requireValue([1,2,3].includes(v.schemaVersion)&&typeof v.pipeline==='string'&&/^cp1-f64-triangle-area-v1\/sha256:[a-f0-9]{64}$/.test(v.pipeline)&&Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&v.format==='straight-srgb-rgba8'&&v.layout==='row-major-tile-views-v1'&&v.tileSize===512);
  blob(v.pixels);requireValue(v.pixels.mediaType==='application/x-ideogram-rgba8'&&v.pixels.byteLength===String(v.width*v.height*4));
  requireValue(Array.isArray(v.tiles)&&v.tiles.length===Math.ceil(v.width/512)*Math.ceil(v.height/512));
  let i=0;for(let y=0;y<v.height;y+=512)for(let x=0;x<v.width;x+=512){const t=v.tiles[i++];keys(t,['x','y','width','height','hash']);requireValue(t.x===x&&t.y===y&&t.width===Math.min(512,v.width-x)&&t.height===Math.min(512,v.height-y)&&/^sha256:[a-f0-9]{64}$/.test(t.hash));}
  requireValue(Array.isArray(v.dependencies)&&v.dependencies.length<=(v.plan?.kind==='request-source-capture-v1'?201:200));for(const ref of v.dependencies)blob(ref);
  const p=v.plan;requireValue(p&&typeof p==='object');const layers=['cp1-composition','request-source-capture-v1'].includes(p.kind)?p.layers:p.kind==='cp1-layer-contribution-v1'?[p.layer]:[];requireValue(v.schemaVersion===(p.kind==='authored-mask-v2'||p.kind==='authored-request-mask-v1'&&p.authoring?.schemaVersion===2||layers?.some((l:any)=>l?.mask&&retainedMask(l.mask))?3:p.kind==='authored-mask-v1'||p.kind==='authored-request-mask-v1'||layers?.some((l:any)=>l?.mask?.mapping==='document-r16-v1')?2:1));
  if(p.kind==='decoded-derived-v1'){decodedDerivedPlan(p,v.width,v.height);requireValue(p.codec===v.pipeline.split('/')[1]&&v.dependencies.some((ref:any)=>canonical(ref)===canonical(p.original)));}
  else if(p.kind==='decoded-native'){keys(p,['kind','sourceAssetId','conversion','codec',...(p.decodeTransport!==undefined?['decodeTransport']:[]),...(p.decoderBuild!==undefined?['decoderBuild']:[]),...(p.outputBuild!==undefined?['outputBuild']:[])]);requireValue((p.decodeTransport===undefined||['webp-opaque-incremental-v1','webp-bounded-v1','webp-file-v1'].includes(p.decodeTransport))&&(['webp-bounded-v1','webp-file-v1'].includes(p.decodeTransport)?/^sha256:[a-f0-9]{64}$/.test(p.decoderBuild):p.decoderBuild===undefined)&&(p.decodeTransport==='webp-file-v1'?/^sha256:[a-f0-9]{64}$/.test(p.outputBuild):p.outputBuild===undefined)&&id(p.sourceAssetId)&&p.codec===v.pipeline.split('/')[1]);rasterConversion(p.conversion,v.width,v.height);}
  else if(p.kind==='frozen-png-export'){keys(p,['kind','sourceAssetId','pixelIdentity','encoder']);requireValue(id(p.sourceAssetId)&&/^sha256:[a-f0-9]{64}$/.test(p.pixelIdentity)&&/^sha256:[a-f0-9]{64}$/.test(p.encoder));}
  else if(p.kind==='frozen-image-export-v1'){keys(p,['kind','sourceAssetId','pixelIdentity','sourceWidth','sourceHeight','options','encoder','kernel','matteComposition',...(p.encoderTransport!==undefined?['encoderTransport']:[])]);exportOptions(p.options,false);requireValue((p.encoderTransport===undefined||p.encoderTransport==='jpeg-file-baseline-v1'&&p.options.format==='jpeg')&&id(p.sourceAssetId)&&/^sha256:[a-f0-9]{64}$/.test(p.pixelIdentity)&&/^sha256:[a-f0-9]{64}$/.test(p.encoder)&&Number.isSafeInteger(p.sourceWidth)&&Number.isSafeInteger(p.sourceHeight)&&p.sourceWidth>0&&p.sourceHeight>0&&p.sourceWidth<=8192&&p.sourceHeight<=8192&&p.sourceWidth*p.sourceHeight<=25000000&&v.width===(p.options.resize?.width??p.sourceWidth)&&v.height===(p.options.resize?.height??p.sourceHeight)&&p.kernel==='triangle-area-source-axis-row-norm-v1'&&p.matteComposition==='linear-srgb-source-over-opaque-v1');}
  else if(p.kind==='candidate-lettering-comparison-v1'){
    keys(p,['kind','sourceWidth','sourceHeight','layers','comparison','kernel','edge','preservation']);
    requireValue(Number.isSafeInteger(p.sourceWidth)&&Number.isSafeInteger(p.sourceHeight)&&p.sourceWidth>0&&p.sourceHeight>0&&p.sourceWidth<=8192&&p.sourceHeight<=8192&&p.sourceWidth*p.sourceHeight<=25000000&&['candidate-alone','native-off','native-on'].includes(p.comparison)&&p.kernel==='triangle-area-source-axis-row-norm-v1'&&p.edge==='transparent-zero-no-renormalization'&&p.preservation==='not-applied'&&Array.isArray(p.layers)&&p.layers.length<=100);
    for(const layer of p.layers)rasterLayer(layer);
    const scale=Math.min(1,1024/p.sourceWidth,1024/p.sourceHeight);requireValue(v.schemaVersion===1&&v.width===Math.max(1,Math.round(p.sourceWidth*scale))&&v.height===Math.max(1,Math.round(p.sourceHeight*scale)));
    if(p.comparison==='candidate-alone')requireValue(p.layers.length===1&&p.layers[0].opacity===1&&p.layers[0].mask===null);
  }
  else if(p.kind==='cp1-composition'||p.kind==='request-source-capture-v1'){
    keys(p,['kind','layers','maskMapping','precision','kernel','edge','footprints',...(p.kind==='request-source-capture-v1'?['capture',...(p.contributions!==undefined?['contributions']:[])]:[])]);
    if(p.kind==='request-source-capture-v1'){validateRequestSourceCapture(p.capture);requireValue(v.dependencies.some((r:any)=>canonical(r)===canonical(p.capture.image.state)));if(p.contributions!==undefined){blob(p.contributions);requireValue(p.contributions.mediaType==='application/json'&&BigInt(p.contributions.byteLength)<=65536n&&v.dependencies.some((r:any)=>canonical(r)===canonical(p.contributions)));}}
    requireValue(Array.isArray(p.layers)&&p.layers.length<=100&&p.maskMapping===(v.schemaVersion===3?'explicit-retained-domain-zero-v1':'document-luminance-alpha-v1')&&p.precision==='binary64'&&p.kernel==='triangle-area-source-axis-row-norm-v1'&&p.edge==='transparent-zero-no-renormalization'&&Array.isArray(p.footprints)&&p.footprints.length===p.layers.length);
    for(const layer of p.layers)rasterLayer(layer);for(const footprint of p.footprints)rasterFootprint(footprint);
  }else if(p.kind==='cp1-layer-contribution-v1'){
    keys(p,['kind','layer','source','mask','maskMapping','precision','kernel','edge','footprint']);rasterLayer(p.layer);rasterFootprint(p.footprint);blob(p.source);if(p.mask!==null)blob(p.mask);
    requireValue(p.source.mediaType==='application/json'&&(p.layer.mask===null?p.mask===null:p.mask?.mediaType==='application/json')&&p.maskMapping===(v.schemaVersion===3?'explicit-retained-domain-zero-v1':'document-luminance-alpha-v1')&&p.precision==='binary64'&&p.kernel==='triangle-area-source-axis-row-norm-v1'&&p.edge==='transparent-zero-no-renormalization');
    requireValue(canonical(v.dependencies)===canonical([p.source,...(p.mask?[p.mask]:[])]));
  }else if(['authored-mask-v1','authored-mask-v2','authored-request-mask-v1'].includes(p.kind)){keys(p,['kind','authoring','hard','effective','statistics',...(p.kind==='authored-request-mask-v1'?['sourceAssetId','source','sourcePixels','clip','lostEffectivePixels']:[])]);validateMaskPlan(p.authoring);requireValue(p.kind==='authored-request-mask-v1'||(p.kind==='authored-mask-v2')===(p.authoring.schemaVersion===2));if(p.kind==='authored-request-mask-v1'){requireValue(id(p.sourceAssetId));blob(p.source);blob(p.sourcePixels);requireValue(p.source.mediaType==='application/json'&&p.sourcePixels.mediaType==='application/x-ideogram-rgba8'&&p.sourcePixels.byteLength===String(v.width*v.height*4)&&Number.isSafeInteger(p.lostEffectivePixels)&&p.lostEffectivePixels>=0&&p.lostEffectivePixels<=v.width*v.height);for(const ref of [p.source,p.sourcePixels])requireValue(v.dependencies.some((r:any)=>canonical(r)===canonical(ref)));if(p.clip!==null){keys(p.clip,['x','y','width','height']);requireValue(Object.values(p.clip).every(Number.isSafeInteger)&&p.clip.x>=0&&p.clip.y>=0&&p.clip.width>0&&p.clip.height>0&&p.clip.x+p.clip.width<=v.width&&p.clip.y+p.clip.height<=v.height);}}requireValue(p.authoring.width===v.width&&p.authoring.height===v.height);for(const r of [p.hard,p.effective]){blob(r);requireValue(r.mediaType==='application/x-ideogram-r16le'&&r.byteLength===String(v.width*v.height*2)&&v.dependencies.some((d:any)=>canonical(d)===canonical(r)));}keys(p.statistics,['hardPixels','effectivePixels','support']);requireValue([p.statistics.hardPixels,p.statistics.effectivePixels].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=v.width*v.height));if(p.statistics.support!==null){keys(p.statistics.support,['x','y','width','height']);requireValue(Object.values(p.statistics.support).every(Number.isSafeInteger));}
  }else if(['request-mask-binary-v1','request-source-transport-v1'].includes(p.kind)){keys(p,['kind','source','requestPlan']);blob(p.source);validateRequestRasterPlan(p.requestPlan);requireValue(p.source.mediaType==='application/json'&&v.width===requestRasterGrid(p.requestPlan).width&&v.height===requestRasterGrid(p.requestPlan).height);for(const r of [p.source,p.requestPlan.sourcePixels,p.requestPlan.authoredMask,p.requestPlan.effectiveMask])requireValue(v.dependencies.some((d:any)=>canonical(d)===canonical(r)));}
  else if(p.kind==='request-preservation-v1'){keys(p,['kind','source','candidate','mask','requestPlan','outputMapping']);validateRequestRasterPlan(p.requestPlan);if(p.outputMapping!==null){requireOutputMapping(p.requestPlan,p.outputMapping,p.outputMapping.actualOutput?.width,p.outputMapping.actualOutput?.height);requireValue(canonical(p.outputMapping.requestPlan)===canonical(p.requestPlan)&&v.dependencies.some((r:any)=>canonical(r)===canonical(p.outputMapping.effectiveMask)));}requireValue(v.width===p.requestPlan.document.width&&v.height===p.requestPlan.document.height);for(const ref of [p.source,p.candidate,p.mask]){blob(ref);requireValue(ref.mediaType==='application/json');}for(const ref of [p.source,p.candidate,p.mask,p.requestPlan.sourcePixels,p.requestPlan.authoredMask,p.requestPlan.effectiveMask])requireValue(v.dependencies.some((r:any)=>canonical(r)===canonical(ref)));}
  else if(p.kind==='request-mask-resize'){keys(p,['kind','source','from','mapping','kernel']);blob(p.source);keys(p.from,['width','height']);requireValue([p.from.width,p.from.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)&&p.mapping==='stretch'&&p.kernel==='triangle-area-r16-linear-v1');}
  else if(p.kind==='v45-edit-mask-v1'){
    keys(p,['kind','endpoint','source','mask','sourcePixels','requestPlan','polarity','statistics']);validateRequestRasterPlan(p.requestPlan);for(const ref of [p.source,p.mask]){blob(ref);requireValue(ref.mediaType==='application/json'&&BigInt(ref.byteLength)<=65536n);}blob(p.sourcePixels);keys(p.statistics,['editPixels','keepPixels']);const grid=requestRasterGrid(p.requestPlan);
    requireValue(p.endpoint==='ideogram/v4.5/edit'&&p.polarity==='black-edit'&&v.width===grid.width&&v.height===grid.height&&p.sourcePixels.mediaType==='application/x-ideogram-rgba8'&&p.sourcePixels.byteLength===String(v.width*v.height*4)&&Number.isSafeInteger(p.statistics.editPixels)&&Number.isSafeInteger(p.statistics.keepPixels)&&p.statistics.editPixels>0&&p.statistics.keepPixels>0&&p.statistics.editPixels+p.statistics.keepPixels===v.width*v.height);
    for(const ref of [p.source,p.mask,p.sourcePixels,p.requestPlan.sourcePixels,p.requestPlan.authoredMask,p.requestPlan.effectiveMask])requireValue(v.dependencies.some((r:any)=>canonical(r)===canonical(ref)));
  }
  else if(p.kind==='v45-edit-inputs-1'){
    v45EditInputsPlan(p);const grid=p.requestPlan?requestRasterGrid(p.requestPlan):p.original.source;requireValue(v.width===grid.width&&v.height===grid.height&&(!p.mask||canonical(p.mask.sourcePixels)===canonical(v.pixels)));
    for(const ref of v45EditInputsReferences(p))requireValue(v.dependencies.some((r:any)=>canonical(r)===canonical(ref)));
  }
  else if(p.kind==='retained-candidate-v1'){keys(p,['kind','source','lineage']);for(const ref of [p.source,p.lineage]){blob(ref);requireValue(ref.mediaType==='application/json'&&v.dependencies.some((r:any)=>canonical(r)===canonical(ref)));}}
  else if(p.kind==='solid-background-v1'){keys(p,['kind','color']);documentCreationBackground({kind:'solid',color:p.color});requireValue(v.schemaVersion===1&&v.dependencies.length===0);}
  else if(p.kind==='retained-text'){keys(p,['kind','source']);blob(p.source);requireValue(p.source.mediaType==='application/json');}
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
    keys(value,['id','documentId','branchId','parent','revision','kind','operation','before','after','forward','inverse','roots',...(value.adoptedLineage?['adoptedLineage']:[])]);
    requireValue(['id','documentId','branchId','parent'].every(k=>id(value[k]))&&seq(value.revision)&&['CommitCompositionVersion','AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement','SetSemanticBinding','DetachSemanticBinding','ApprovePromptProjection','SetLayerAppearance','ImportAsset','ApplyTransform','SetLayerProperties','DeleteLayer','DuplicateLayer','MoveLayers','CropDocument','ResizeCanvas','ResampleImage','CreateFlattenedCopy','AdoptCandidate','AdoptReviewedCandidate','CreateTextLayer','CreateTextFromReturnedDescription','CommitTextEdit','ReplaceTextFont','SplitTextDraft','RasterizeTextDerivative'].includes(value.operation));
    imageVersion(value.before);imageVersion(value.after);blob(value.forward);blob(value.inverse);
    if(value.adoptedLineage){blob(value.adoptedLineage);requireValue(['AdoptCandidate','AdoptReviewedCandidate'].includes(value.operation)&&value.adoptedLineage.mediaType==='application/json');}requireValue(Array.isArray(value.roots)&&canonical(value.roots)===canonical([value.before.state,value.after.state,value.forward,value.inverse,...(value.adoptedLineage?[value.adoptedLineage]:[])]));return value.revision;
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
  if(queueEvents.includes(v.type)){requireValue(v.documentId===null&&v.resultingDocumentRevision===null&&v.streamId==='assets'&&v.streamSeq===v.workspaceSeq);keys(v.payload,['id','version','state']);requireValue(id(v.payload.id)&&seq(v.payload.version));blob(v.payload.state);return;}
  if(['BundlePrepared','BundleImportReviewed','PortableCancelled'].includes(v.type)){
    requireValue(v.documentId===null&&v.resultingDocumentRevision===null&&v.streamId==='portable'&&v.streamSeq===v.workspaceSeq);
    if(v.type==='BundlePrepared'){keys(v.payload,['bundle']);const b=v.payload.bundle;keys(b,['protocolVersion','bundleId','documentId','documentRevision','capturedHighWater','uiDigest','blob','complete','status','destinationStatus',...(b.complete===false?['recovery']:[])]);if(b.complete===false)recoveryDisclosure(b.recovery);blob(b.blob);requireValue(b.protocolVersion===1&&id(b.bundleId)&&id(b.documentId)&&seq(b.documentRevision)&&seq(b.capturedHighWater)&&/^sha256:[a-f0-9]{64}$/.test(b.uiDigest)&&b.blob.mediaType==='application/x-ideogram-project'&&(b.complete===true&&b.status==='copy-ready'||b.complete===false&&b.status==='recovery-copy-ready')&&b.destinationStatus==='unconfirmed');}
    else if(v.type==='BundleImportReviewed'){keys(v.payload,['reviewId','reviewHash']);requireValue(id(v.payload.reviewId)&&/^sha256:[a-f0-9]{64}$/.test(v.payload.reviewHash));}
    else{keys(v.payload,['operationId']);requireValue(id(v.payload.operationId));}return;
  }
  if(v.type==='BundleImported'){keys(v.payload,['namespaceId','source','document','namespaceHash']);blob(v.payload.source);document(v.payload.document);requireValue(/^sha256:[a-f0-9]{64}$/.test(v.payload.namespaceHash)&&id(v.payload.namespaceId)&&v.payload.source.mediaType==='application/x-ideogram-project'&&v.documentId===v.payload.document.id&&v.resultingDocumentRevision===v.payload.document.revision&&v.streamId===v.documentId&&v.streamSeq===v.resultingDocumentRevision);return;}
  if(v.type==='ImageEditPreviewPrepared'||v.type==='ImageEditReviewPrepared'||v.type==='CandidatePlacementReviewPrepared'||v.type==='AssetRegistered'||v.type==='StagingTransferReviewPrepared'||v.type==='RasterReviewPrepared'||v.type==='RasterImportInspectionPrepared'||v.type==='StagingOwnershipTransferred'){
    requireValue(v.documentId===null&&v.resultingDocumentRevision===null&&v.streamId==='assets'&&v.streamSeq===v.workspaceSeq);
    if(v.type==='ImageEditPreviewPrepared'){keys(v.payload,['preview']);imageEditPreview(v.payload.preview);}
    else if(v.type==='ImageEditReviewPrepared'||v.type==='CandidatePlacementReviewPrepared'){keys(v.payload,['reviewId','reviewHash']);requireValue(id(v.payload.reviewId)&&/^sha256:[a-f0-9]{64}$/.test(v.payload.reviewHash));}
    else if(v.type==='AssetRegistered'){keys(v.payload,['asset']);asset(v.payload.asset);}
    else if(v.type==='RasterImportInspectionPrepared'){keys(v.payload,['inspectionId','inspectionHash']);requireValue(id(v.payload.inspectionId)&&/^sha256:[a-f0-9]{64}$/.test(v.payload.inspectionHash));}
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

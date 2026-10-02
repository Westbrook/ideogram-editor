import { canonical, parseControlJSON } from '../../src/protocol/json.js';
import { LIMITS, bindingIds, bindingMap, bindingValue, compositionRefs, serialize, validateComposition, validateCompositionRef } from '../../src/composition/core.js';
import type { Composition, CompositionRef, LayerValue } from '../../src/composition/core.js';
import type { ImageState, ImagePatch, HistoryBody } from '../../src/protocol/history.js';
import type { BlobRef } from '../../src/protocol/store.js';
import type { Asset } from '../../src/protocol/assets.js';
import { AssetRejection } from './assets.js';
import type {CompositionMemory} from './composition-memory.js';
import {validateBlob} from './canonical.js';
import {StoreError} from './errors.js';

export function readComposition(ref:CompositionRef,read:(ref:BlobRef)=>Uint8Array){validateCompositionRef(ref);const c=parseControlJSON(read(ref.value),1048576);validateComposition(c);if(c.id!==ref.id)throw Error('COMPOSITION_ID');bindingMap(c,ref.bindings);return c;}
function nativeLayerSourceRef(ref:BlobRef){validateBlob(ref);if(ref.mediaType!=='application/json'||ref.byteLength.length>20||BigInt(ref.byteLength)>65536n)throw new StoreError('PAYLOAD_TOO_LARGE');}
function portableInput(bytes:Uint8Array,max:number){const value=parseControlJSON(bytes,max);if(canonical(value)!==Buffer.from(bytes).toString('utf8'))throw new StoreError('MALFORMED_REQUEST');return value;}
function projectionPromptRef(ref:BlobRef){validateBlob(ref);if(ref.byteLength.length>20||BigInt(ref.byteLength)>BigInt(LIMITS.bytes))throw new StoreError('PAYLOAD_TOO_LARGE');}
function nativeLayerText(bytes:Uint8Array,portable=false){
 const source=(portable?portableInput(bytes,65536):parseControlJSON(bytes,65536)) as {text?:{frame?:{width?:unknown;height?:unknown};textUtf8?:BlobRef}};
 const text=source?.text,ref=text?.textUtf8,width=text?.frame?.width,height=text?.frame?.height;
 validateBlob(ref);
 if(!ref||ref.byteLength.length>20||BigInt(ref.byteLength)>16384n)throw new StoreError('PAYLOAD_TOO_LARGE');
 if(typeof width!=='number'||typeof height!=='number'||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>8192||height>8192||Math.ceil(width)*Math.ceil(height)>25000000)throw new StoreError('CORRUPT_OBJECT');
 return {ref,width,height};
}
/** Values are borrowed only through this synchronous semantic check. */
export function withLayerValues(state:ImageState,read:(ref:BlobRef)=>Uint8Array,asset:(id:string)=>Asset|null,memory:CompositionMemory,consume:(layers:LayerValue[])=>void):void{
 memory.nativeLayers(state,()=>consume(layerValues(state,read,asset)));
}
function layerValues(state:ImageState,read:(ref:BlobRef)=>Uint8Array,asset:(id:string)=>Asset|null):LayerValue[]{return state.layers.map(l=>{const a=asset(l.assetId);if(!a?.raster)throw new AssetRejection('MISSING_ASSET','LAYER_APPEARANCE_MISSING');let width=a.raster.width,height=a.raster.height,text:string|undefined;
 if(l.kind==='text'){nativeLayerSourceRef(l.source);const s=nativeLayerText(read(l.source));width=s.width;height=s.height;const bytes=read(s.ref);if(bytes.byteLength!==Number(s.ref.byteLength))throw new StoreError('CORRUPT_OBJECT');text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
 return {id:l.id,version:l.version,kind:l.kind,...(text!==undefined?{text}:{}),appearance:l.appearanceDescription??'',bounds:{rect:[0,0,width,height],transform:l.layerToDocument}};});}
export function verifyReview(c:Composition,read:(ref:BlobRef)=>Uint8Array){if(!c.review)return;projectionPromptRef(c.review.prompt);const result=serialize(c,[],{},true);const expected={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:result.dependencies,boxes:result.boxes,prompt:c.review.prompt};if(canonical(expected)!==canonical(c.review)||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(read(c.review.prompt))!==result.prompt)throw new AssetRejection('INVALID_INPUT','PROJECTION_EVIDENCE_MISMATCH');}
export function validateCommit(type:HistoryBody['type'],next:CompositionRef,before:ImageState,read:(ref:BlobRef)=>Uint8Array,asset:(id:string)=>Asset|null,memory:CompositionMemory):void{
 memory.nativeLayers(before,()=>{
 const c=readComposition(next,read),old=before.composition?readComposition(before.composition,read):null,layers=layerValues(before,read,asset);
 if(old?.id===c.id)throw new AssetRejection('INVALID_INPUT','COMPOSITION_VERSION_REUSE');
 for(const e of c.elements)for(const field of ['text','desc','bounds'] as const){const b=e[field];if(!b||b.mode==='literal')continue;const prior=old?.elements.find(x=>x.id===e.id)?.[field];
  if(prior&&canonical(prior)===canonical(b)&&before.composition?.bindings[b.layerId]===next.bindings[b.layerId])continue;
  const l=layers.find(l=>l.id===next.bindings[b.layerId]);if(!l||l.version!==b.lastReviewedLayerVersion||field==='text'&&l.kind!=='text'||canonical(b.lastReviewedValue)!==canonical(field==='text'?l.text:field==='desc'?l.appearance:l.bounds))throw new AssetRejection('STALE_REVISION','LINK_SOURCE_CHANGED');
 }
 const ids=c.elements.map(e=>e.id),oldIds=old?.elements.map(e=>e.id)??[];
 const target=(b:any,map:Record<string,string>)=>b?.mode==='layer'?map[b.layerId]:null;
 const specialized=['AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement','SetSemanticBinding','DetachSemanticBinding'].includes(type);
 if(specialized){
  if(!old)throw new AssetRejection('INVALID_INPUT','SEMANTIC_BASE_REQUIRED');
  const rest=(v:Composition)=>{const {id,review,elements,...rest}=v;return rest;};
  if(canonical(rest(c))!==canonical(rest(old)))throw new AssetRejection('INVALID_INPUT','SEMANTIC_COMMAND_SCOPE');
  if(['AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement'].includes(type))for(const e of c.elements){const prior=old.elements.find(x=>x.id===e.id);if(prior&&(canonical(e)!==canonical(prior)||(['text','desc','bounds'] as const).some(field=>target(e[field],next.bindings)!==target(prior[field],before.composition!.bindings))))throw new AssetRejection('INVALID_INPUT','SEMANTIC_COMMAND_SCOPE');}
  if(type==='SetSemanticBinding'||type==='DetachSemanticBinding'){
   if(canonical(ids)!==canonical(oldIds))throw new AssetRejection('INVALID_INPUT','SEMANTIC_COMMAND_SCOPE');let changed=0;
   for(const [i,e] of c.elements.entries()){const prior=old.elements[i],copy=structuredClone(e);for(const field of ['text','desc','bounds'] as const){const a=prior[field],b=e[field];if(canonical(a)!==canonical(b)||target(a,before.composition!.bindings)!==target(b,next.bindings)){changed++;if(type==='SetSemanticBinding'?b?.mode!=='layer':a?.mode!=='layer'||b?.mode!=='literal'||canonical(a.lastReviewedValue)!==canonical(b.value))throw new AssetRejection('INVALID_INPUT','SEMANTIC_BINDING_MISMATCH');}(copy as any)[field]=a;}if(canonical(copy)!==canonical(prior))throw new AssetRejection('INVALID_INPUT','SEMANTIC_COMMAND_SCOPE');}
   if(!changed)throw new AssetRejection('INVALID_INPUT','SEMANTIC_BINDING_MISMATCH');
  }
 }

 if(type==='AddSemanticElement'&&(ids.length!==oldIds.length+1||oldIds.some(id=>!ids.includes(id))))throw new AssetRejection('INVALID_INPUT','SEMANTIC_ADD_MISMATCH');
 if(type==='RemoveSemanticElement'&&(ids.length!==oldIds.length-1||ids.some(id=>!oldIds.includes(id))))throw new AssetRejection('INVALID_INPUT','SEMANTIC_REMOVE_MISMATCH');
 if(type==='ReorderSemanticElement'&&(ids.length!==oldIds.length||ids.some(id=>!oldIds.includes(id))||c.elements.some(e=>canonical(e)!==canonical(old!.elements.find(x=>x.id===e.id)))))throw new AssetRejection('INVALID_INPUT','SEMANTIC_ORDER_MISMATCH');
 if(type==='ApprovePromptProjection'){if(!c.review||c.frame.documentWidth!==before.width||c.frame.documentHeight!==before.height)throw new AssetRejection('STALE_REVISION','FRAME_CHANGED');try{serialize(c,layers,next.bindings);}catch{throw new AssetRejection('STALE_REVISION','PROJECTION_NEEDS_REVIEW');}}
 else if(c.review!==null)throw new AssetRejection('INVALID_INPUT','EXPLICIT_PROJECTION_REVIEW_REQUIRED');
 verifyReview(c,read);
 });
}
/** Portable validation keeps every cached input owned until synchronous commit
 * validation has consumed the last native string. Reads remain serial, and a
 * thrown check/read/parse drains the active read before either scope releases. */
export async function validateCommitAsync(type:HistoryBody['type'],next:CompositionRef,before:ImageState,read:(ref:BlobRef)=>Promise<Uint8Array>,asset:(id:string)=>Asset|null,memory:CompositionMemory,check:()=>void):Promise<void>{
 if(!Array.isArray(before.layers)||before.layers.length>100)throw new StoreError('CAPACITY');
 await memory.compositionsAsync([next,before.composition],()=>memory.commitCache(async reserve=>{
  const cache=new Map<string,Uint8Array>();
  const load=async(ref:BlobRef)=>{check();const prior=cache.get(ref.hash);if(prior){if(prior.byteLength!==Number(ref.byteLength))throw new StoreError('CORRUPT_OBJECT');return prior;}
   reserve(ref);const bytes=await read(ref);check();if(bytes.byteLength!==Number(ref.byteLength))throw new StoreError('CORRUPT_OBJECT');cache.set(ref.hash,bytes);return bytes;};
  try{
   for(const ref of [before.composition,next])if(ref){const c=portableInput(await load(ref.value),1048576);validateComposition(c);if(c.review){projectionPromptRef(c.review.prompt);await load(c.review.prompt);}}
   for(const layer of before.layers)if(layer.kind==='text'){nativeLayerSourceRef(layer.source);const text=nativeLayerText(await load(layer.source),true);await load(text.ref);}
   check();validateCommit(type,next,before,ref=>{const bytes=cache.get(ref.hash);if(!bytes||bytes.byteLength!==Number(ref.byteLength))throw new StoreError('CORRUPT_OBJECT');return bytes;},asset,memory);
  }finally{cache.clear();}
 }));
}
export function imagePatch(before:ImageState,after:ImageState,operation:HistoryBody['type']):ImagePatch{const ids=new Set([...before.layers.map(l=>l.id),...after.layers.map(l=>l.id)]),semantic=before.schemaVersion===5||after.schemaVersion===5;return {schemaVersion:semantic?2:1,operation,...(semantic?{composition:after.composition??null}:{}),...(before.schemaVersion!==after.schemaVersion?{stateSchema:after.schemaVersion}:{}),dimensions:before.width!==after.width||before.height!==after.height?{width:after.width,height:after.height}:null,layers:[...ids].filter(id=>canonical(before.layers.find(l=>l.id===id)??null)!==canonical(after.layers.find(l=>l.id===id)??null)).map(id=>({id,value:after.layers.find(l=>l.id===id)??null})),order:canonical(before.layers.map(l=>l.id))!==canonical(after.layers.map(l=>l.id))?after.layers.map(l=>l.id):null};}
export {compositionRefs,bindingIds};

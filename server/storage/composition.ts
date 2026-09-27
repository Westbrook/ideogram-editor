import { canonical, parseControlJSON } from '../../src/protocol/json.js';
import { bindingIds, bindingMap, bindingValue, compositionRefs, serialize, validateComposition, validateCompositionRef } from '../../src/composition/core.js';
import type { Composition, CompositionRef, LayerValue } from '../../src/composition/core.js';
import type { ImageState, ImagePatch, HistoryBody } from '../../src/protocol/history.js';
import type { BlobRef } from '../../src/protocol/store.js';
import type { Asset } from '../../src/protocol/assets.js';
import { AssetRejection } from './assets.js';

export function readComposition(ref:CompositionRef,read:(ref:BlobRef)=>Uint8Array){validateCompositionRef(ref);const c=parseControlJSON(read(ref.value),1048576);validateComposition(c);if(c.id!==ref.id)throw Error('COMPOSITION_ID');bindingMap(c,ref.bindings);return c;}
export function layerValues(state:ImageState,read:(ref:BlobRef)=>Uint8Array,asset:(id:string)=>Asset|null):LayerValue[]{return state.layers.map(l=>{const a=asset(l.assetId);if(!a?.raster)throw new AssetRejection('MISSING_ASSET','LAYER_APPEARANCE_MISSING');let width=a.raster.width,height=a.raster.height,text:string|undefined;
 if(l.kind==='text'){const s=parseControlJSON(read(l.source)) as any;width=s.text.frame.width;height=s.text.frame.height;text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(read(s.text.textUtf8));}
 return {id:l.id,version:l.version,kind:l.kind,...(text!==undefined?{text}:{}),appearance:l.appearanceDescription??'',bounds:{rect:[0,0,width,height],transform:l.layerToDocument}};});}
export function verifyReview(c:Composition,read:(ref:BlobRef)=>Uint8Array){if(!c.review)return;const result=serialize(c,[],{},true);const expected={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:result.dependencies,boxes:result.boxes,prompt:c.review.prompt};if(canonical(expected)!==canonical(c.review)||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(read(c.review.prompt))!==result.prompt)throw new AssetRejection('INVALID_INPUT','PROJECTION_EVIDENCE_MISMATCH');}
export function validateCommit(type:HistoryBody['type'],next:CompositionRef,before:ImageState,read:(ref:BlobRef)=>Uint8Array,asset:(id:string)=>Asset|null){
 const c=readComposition(next,read),old=before.composition?readComposition(before.composition,read):null,layers=layerValues(before,read,asset);
 if(old?.id===c.id)throw new AssetRejection('INVALID_INPUT','COMPOSITION_VERSION_REUSE');
 for(const e of c.elements)for(const field of ['text','desc','bounds'] as const){const b=e[field];if(!b||b.mode==='literal')continue;const prior=old?.elements.find(x=>x.id===e.id)?.[field];
  if(prior&&canonical(prior)===canonical(b)&&before.composition?.bindings[b.layerId]===next.bindings[b.layerId])continue;
  const l=layers.find(l=>l.id===next.bindings[b.layerId]);if(!l||l.version!==b.lastReviewedLayerVersion||field==='text'&&l.kind!=='text'||canonical(b.lastReviewedValue)!==canonical(field==='text'?l.text:field==='desc'?l.appearance:l.bounds))throw new AssetRejection('STALE_REVISION','LINK_SOURCE_CHANGED');
 }
 const ids=c.elements.map(e=>e.id),oldIds=old?.elements.map(e=>e.id)??[];
 const specialized=['AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement','SetSemanticBinding','DetachSemanticBinding'].includes(type);
 if(specialized){
  if(!old)throw new AssetRejection('INVALID_INPUT','SEMANTIC_BASE_REQUIRED');
  const rest=(v:Composition)=>{const {id,review,elements,...rest}=v;return rest;};
  if(canonical(rest(c))!==canonical(rest(old)))throw new AssetRejection('INVALID_INPUT','SEMANTIC_COMMAND_SCOPE');
  if(type==='AddSemanticElement'||type==='RemoveSemanticElement')for(const e of c.elements){const prior=old.elements.find(x=>x.id===e.id);if(prior&&canonical(e)!==canonical(prior))throw new AssetRejection('INVALID_INPUT','SEMANTIC_COMMAND_SCOPE');}
  if(type==='SetSemanticBinding'||type==='DetachSemanticBinding'){
   if(canonical(ids)!==canonical(oldIds))throw new AssetRejection('INVALID_INPUT','SEMANTIC_COMMAND_SCOPE');let changed=0;
   for(const [i,e] of c.elements.entries()){const prior=old.elements[i],copy=structuredClone(e);for(const field of ['text','desc','bounds'] as const){const a=prior[field],b=e[field];if(canonical(a)!==canonical(b)){changed++;if(type==='SetSemanticBinding'?b?.mode!=='layer':a?.mode!=='layer'||b?.mode!=='literal'||canonical(a.lastReviewedValue)!==canonical(b.value))throw new AssetRejection('INVALID_INPUT','SEMANTIC_BINDING_MISMATCH');}(copy as any)[field]=a;}if(canonical(copy)!==canonical(prior))throw new AssetRejection('INVALID_INPUT','SEMANTIC_COMMAND_SCOPE');}
   if(!changed)throw new AssetRejection('INVALID_INPUT','SEMANTIC_BINDING_MISMATCH');
  }
 }

 if(type==='AddSemanticElement'&&(ids.length!==oldIds.length+1||oldIds.some(id=>!ids.includes(id))))throw new AssetRejection('INVALID_INPUT','SEMANTIC_ADD_MISMATCH');
 if(type==='RemoveSemanticElement'&&(ids.length!==oldIds.length-1||ids.some(id=>!oldIds.includes(id))))throw new AssetRejection('INVALID_INPUT','SEMANTIC_REMOVE_MISMATCH');
 if(type==='ReorderSemanticElement'&&(ids.length!==oldIds.length||ids.some(id=>!oldIds.includes(id))||c.elements.some(e=>canonical(e)!==canonical(old!.elements.find(x=>x.id===e.id)))))throw new AssetRejection('INVALID_INPUT','SEMANTIC_ORDER_MISMATCH');
 if(type==='ApprovePromptProjection'){if(!c.review||c.frame.documentWidth!==before.width||c.frame.documentHeight!==before.height)throw new AssetRejection('STALE_REVISION','FRAME_CHANGED');try{serialize(c,layers,next.bindings);}catch{throw new AssetRejection('STALE_REVISION','PROJECTION_NEEDS_REVIEW');}}
 else if(c.review!==null)throw new AssetRejection('INVALID_INPUT','EXPLICIT_PROJECTION_REVIEW_REQUIRED');
 verifyReview(c,read);return c;
}
export function imagePatch(before:ImageState,after:ImageState,operation:HistoryBody['type']):ImagePatch{const ids=new Set([...before.layers.map(l=>l.id),...after.layers.map(l=>l.id)]),semantic=before.schemaVersion===5||after.schemaVersion===5;return {schemaVersion:semantic?2:1,operation,...(semantic?{composition:after.composition??null}:{}),...(before.schemaVersion!==after.schemaVersion?{stateSchema:after.schemaVersion}:{}),dimensions:before.width!==after.width||before.height!==after.height?{width:after.width,height:after.height}:null,layers:[...ids].filter(id=>canonical(before.layers.find(l=>l.id===id)??null)!==canonical(after.layers.find(l=>l.id===id)??null)).map(id=>({id,value:after.layers.find(l=>l.id===id)??null})),order:canonical(before.layers.map(l=>l.id))!==canonical(after.layers.map(l=>l.id))?after.layers.map(l=>l.id):null};}
export {compositionRefs,bindingIds};

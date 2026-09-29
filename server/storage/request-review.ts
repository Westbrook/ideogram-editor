import {canonical} from './canonical.js';
import {StoreError} from './errors.js';
import type {Objects} from './objects.js';
import type {Assets,AssetAuth} from './assets.js';
import type {DatabaseSync} from 'node:sqlite';
import type {Draft as SavedDraft} from '../../src/protocol/ui.js';
import type {BlobRef,Document} from '../../src/protocol/store.js';
import type {ImageState} from '../../src/protocol/history.js';
import {draftShape,resolve,bodyTemplate,estimate,routes,hash,refs,RequestError,labels,operations} from '../../src/request/core.js';
import type {Draft} from '../../src/request/core.js';
import type {RequestReview} from '../../src/request/review.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {validateComposition} from '../../src/composition/core.js';
export function readRequestBytes(objects:Objects,ref:BlobRef,max=16777216){if(BigInt(ref.byteLength)>BigInt(max))throw new StoreError('PAYLOAD_TOO_LARGE');objects.verify(ref);const out=new Uint8Array(Number(ref.byteLength));for(let offset=0;offset<out.length;offset+=1048576)out.set(objects.readRange(ref,String(offset),Math.min(1048576,out.length-offset)),offset);return out;}
export class RequestReviews{
 constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private state:(id:string)=>ImageState){}
 draft(saved:SavedDraft){if(saved.kind!=='request')throw new StoreError('MALFORMED_REQUEST');const a=this.assets.asset(saved.assetId);if(!a||a.qualification!=='opaque-text'||a.availability!=='available')throw new StoreError('MISSING_OBJECT');const d=parseControlJSON(this.objects.verify(a.blob,true)!);draftShape(d);return d;}
 owner(auth:AssetAuth){return hash(canonical({client:auth.clientId,session:auth.sessionHash,epoch:String(this.db.prepare('SELECT value FROM meta WHERE key=?').get('writerEpoch')!.value)}));}
 document(saved:SavedDraft){const row=this.db.prepare('SELECT json FROM documents WHERE id=?').get(saved.documentId);if(!row)throw new StoreError('NOT_FOUND');const d=JSON.parse(String(row.json)) as Document;if(d.revision!==saved.expectedDocumentRevision)throw new RequestError([{field:'document',code:'STALE_REVISION',message:'Review the current document; your draft is retained.'}]);return d;}
 dependencies(d:Draft,saved:SavedDraft){
  const document=this.document(saved),state=this.state(document.id),source=d.operation.startsWith('transform')||d.operation.startsWith('inpaint')?d.source:null,mask=d.operation.startsWith('inpaint')?d.mask:null;for(const s of [source,mask])if(s){const a=this.assets.asset(s.assetId);if(!a?.raster||a.qualification!=='canonical-raster'||a.safety!=='safe'||a.availability!=='available'||a.version!==s.version||canonical(a.blob)!==canonical(s.blob)||canonical(a.raster.pixels)!==canonical(s.pixels)||a.raster.width!==s.width||a.raster.height!==s.height||s===d.source&&a.raster.role==='mask')throw new RequestError([{field:s===d.source?'source':'mask',code:'DEPENDENCY_CHANGED',message:'The exact attached asset is unavailable or changed.'}]);}
  if(source?.scope==='visible-document'&&(document.image?.compositeAssetId!==source.assetId||document.revision!==source.documentRevision))throw new RequestError([{field:'source',code:'SOURCE_CHANGED',message:'Capture the current document explicitly.'}]);
  if(mask){const manifest=parseControlJSON(this.objects.verify(mask.plan,true)!) as any;const stats=manifest.plan?.statistics;if(!stats||mask.empty!==(stats.effectivePixels===0)||mask.full!==(stats.effectivePixels===mask.width*mask.height))throw new RequestError([{field:'mask',code:'MASK_COVERAGE',message:'Mask coverage must match retained measured statistics.'}]);const a=this.assets.asset(mask.assetId)!;if(a.raster?.role!=='mask'||canonical(a.raster.manifest)!==canonical(mask.plan))throw new RequestError([{field:'mask',code:'MASK_PLAN',message:'A retained local mask plan is required.'}]);}
  if(d.prompt.mode==='composition'){
   if(!state.composition||canonical(state.composition)!==canonical(d.prompt.composition))throw new RequestError([{field:'prompt',code:'COMPOSITION_CHANGED',message:'Approve the current Composition projection.'}]);
   const c=parseControlJSON(readRequestBytes(this.objects,state.composition.value,1048576),1048576);validateComposition(c);
   if(!c.review||canonical(c.review)!==canonical(d.prompt.projection)||canonical(c.review.prompt)!==canonical(d.prompt.text)||c.request.operation!==labels[operations.indexOf(d.operation)]||c.request.expansion!==d.fields.expansion)throw new RequestError([{field:'prompt',code:'PROJECTION_CHANGED',message:'The exact operation, expansion and prompt projection must agree.'}]);
   for(const dep of c.review.dependencies){const layer=state.layers.find(l=>l.id===state.composition!.bindings[dep.layerId]);if(!layer||layer.version!==dep.version)throw new RequestError([{field:'prompt',code:'LINK_CHANGED',message:'A linked layer changed.'}]);}
   if(d.fields.size==='custom'&&(c.frame.width!==Number(d.fields.width)||c.frame.height!==Number(d.fields.height)))throw new RequestError([{field:'size',code:'FRAME_CHANGED',message:'The reviewed Composition frame must match the requested output.'}]);
   if(d.fields.size!=='custom'&&c.review.boxes.some(b=>b.projection!==null))throw new RequestError([{field:'size',code:'UNRESOLVED_FRAME',message:'Choose explicit dimensions or explicitly omit Composition bounds.'}]);
  }
  for(const ref of refs(d))this.objects.verify(ref);
  return hash(canonical({document:{id:document.id,revision:document.revision,image:document.image??null},source:d.source,mask:d.mask,adapters:d.adapters,prompt:d.prompt,conversion:d.conversion}));
 }
 prepare(saved:SavedDraft,sessionId:string,requestId:string,auth:AssetAuth):RequestReview{
  if(saved.composing||saved.status!=='saved-unapplied')throw new RequestError([{field:'prompt',code:'DRAFT_NOT_SETTLED',message:'Finish editing and save the current draft first.'}]);
  const d=this.draft(saved),dependencyHash=this.dependencies(d,saved),prompt=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readRequestBytes(this.objects,d.prompt.text));
  const request=resolve(d,prompt),templateBytes=Buffer.from(bodyTemplate(request,prompt)),stage=this.objects.begin(String(templateBytes.length),'application/json');let template:BlobRef;
  try{for(let offset=0;offset<templateBytes.length;offset+=1048576)this.objects.chunk(stage,templateBytes.subarray(offset,offset+1048576));template=this.objects.finish(stage);}finally{this.objects.abort(stage);}
  const route=routes[d.operation];const value:Omit<RequestReview,'token'>={kind:'request-review-1',id:requestId,owner:this.owner(auth),draft:{sessionId,draftId:saved.id,generation:saved.generation},draftAsset:saved.assetId,documentId:saved.documentId,documentRevision:saved.expectedDocumentRevision,request,endpoint:route.endpoint,schemaHash:route.schemaHash,routeHash:hash(canonical(route)),dependencyHash,template,prompt:d.prompt.text,conversion:d.conversion,inactive:d.inactive,destination:d.destination,privacy:d.privacy,estimate:estimate(request),dispatch:false};const result={...value,token:hash(canonical(value))};if(Buffer.byteLength(canonical(result))>60000)throw new RequestError([{field:'review',code:'REVIEW_TOO_LARGE',message:'This review exceeds the bounded control record; the complete draft remains saved.'}]);return result;
 }
 assert(review:RequestReview,saved:SavedDraft,auth:AssetAuth){if(review.owner!==this.owner(auth)||saved.id!==review.draft.draftId||saved.generation!==review.draft.generation||saved.assetId!==review.draftAsset||saved.composing||this.dependencies(this.draft(saved),saved)!==review.dependencyHash)throw new RequestError([{field:'review',code:'STALE_REVIEW',message:'Owner, draft or dependencies changed. Prepare a new review.'}]);const {token,...value}=review;if(hash(canonical(value))!==token)throw new StoreError('MALFORMED_REQUEST');this.objects.verify(review.template);}
}

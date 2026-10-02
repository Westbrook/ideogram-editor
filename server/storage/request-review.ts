import {TextTreatments} from './text-treatment.js';
import {assertCurrentCompositionText,compositionTextOriginRefs} from './composition-text.js';
import type {TextTreatmentReviewIntent} from '../../src/request/text-treatment.js';
import {requirePlanDependencies,requireRequestCoverage} from '../../src/request/raster-plan.js';
import {adapterEligibility,adapterReferences} from './adapters.js';
import {validateRequestSourceCapture} from '../../src/protocol/request-edits.js';
import {canonical} from './canonical.js';
import {StoreError} from './errors.js';
import type {Objects} from './objects.js';
import {AssetRejection,type Assets,type AssetAuth} from './assets.js';
import type {DatabaseSync} from 'node:sqlite';
import type {Draft as SavedDraft} from '../../src/protocol/ui.js';
import type {BlobRef,Document} from '../../src/protocol/store.js';
import type {ImageState} from '../../src/protocol/history.js';
import {newDraft as newV4Draft,requireMaskAlignment,requireRequestMaskPlan,requestMaskDependencies,captureMaskFrame,runtimeAdaptersVerified,hash,RequestError,labels,operations} from '../../src/request/core.js';
import {draftShape,resolve,bodyTemplate,estimate,routes,refs,adapters,isV45Draft,isV45Request} from '../../src/request/family.js';
import {providerReviewV45,verifyRequestReviewV45,baseRequestReview,bindRequestTextTreatment} from '../../src/request/review.js';
import type {Draft} from '../../src/request/family.js';
import type {RequestReview} from '../../src/request/review.js';
import type {Rasters} from './raster.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {validateComposition} from '../../src/composition/core.js';
export function readRequestBytes(objects:Objects,ref:BlobRef,max=16777216){if(BigInt(ref.byteLength)>BigInt(max))throw new StoreError('PAYLOAD_TOO_LARGE');objects.verify(ref);const out=new Uint8Array(Number(ref.byteLength));for(let offset=0;offset<out.length;offset+=1048576)out.set(objects.readRange(ref,String(offset),Math.min(1048576,out.length-offset)),offset);return out;}
export class RequestReviews{
 constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private state:(id:string)=>ImageState,private rasters:Rasters){}
 draft(saved:SavedDraft){if(saved.kind!=='request')throw new StoreError('MALFORMED_REQUEST');const a=this.assets.asset(saved.assetId);if(!a||a.qualification!=='opaque-text'||a.availability!=='available')throw new StoreError('MISSING_OBJECT');const d=parseControlJSON(this.objects.verify(a.blob,true)!);draftShape(d);return d;}
 owner(auth:AssetAuth){return hash(canonical({client:auth.clientId,session:auth.sessionHash,epoch:String(this.db.prepare('SELECT value FROM meta WHERE key=?').get('writerEpoch')!.value)}));}
 document(saved:SavedDraft){const row=this.db.prepare('SELECT json FROM documents WHERE id=?').get(saved.documentId);if(!row)throw new StoreError('NOT_FOUND');const d=JSON.parse(String(row.json)) as Document;if(d.revision!==saved.expectedDocumentRevision)throw new RequestError([{field:'document',code:'STALE_REVISION',message:'Review the current document; your draft is retained.'}]);return d;}
 dependencies(d:Draft,saved:SavedDraft):string{
  const document=this.document(saved);
  if(isV45Draft(d)){
   const read=(ref:BlobRef)=>readRequestBytes(this.objects,ref,1048576);
   if(d.prompt.projection!==null){assertCurrentCompositionText(d,this.state(document.id),read,id=>this.assets.asset(id),this.rasters.compositionMemory);for(const ref of compositionTextOriginRefs(d,read))this.objects.verify(ref);}
   if(d.operation==='generate-v45'){for(const ref of refs(d))this.objects.verify(ref);return hash(canonical({kind:'request-dependencies-v45-1',document:{id:document.id,revision:document.revision,image:document.image??null},prompt:d.prompt,operation:d.operation}));}
   if(!d.source||!d.preparedInputs)throw new RequestError([{field:'source',code:'V45_INPUTS_REVIEW_REQUIRED',message:'Prepare these exact edit inputs before review.'}]);
   const legacy=newV4Draft(d.prompt.text);legacy.operation=d.operation==='inpaint-v45'?'inpaint':'transform';legacy.source=d.source;legacy.mask=d.mask;legacy.prompt={mode:d.prompt.mode,text:d.prompt.text,projection:null,composition:null};legacy.fields.size='auto';legacy.fields.strength='1';
   let preparedRead:ReturnType<Rasters['v45EditInputs']>;
   try{preparedRead=this.rasters.v45EditInputs(d.preparedInputs.assetId);}catch(error){if(error instanceof AssetRejection||error instanceof StoreError&&['MISSING_OBJECT','CORRUPT_OBJECT'].includes(error.code))throw new RequestError([{field:'source',code:'V45_INPUTS_CHANGED',message:'The retained edit inputs are unavailable or require explicit preparation in this document.'}]);throw error;}
   try{const prepared=preparedRead.value;const {assetId,version,...source}=prepared.source;
   if(assetId!==d.preparedInputs.assetId||version!==d.preparedInputs.version||canonical(prepared.manifest)!==canonical(d.preparedInputs.manifest)||canonical(prepared.original)!==canonical({source:d.source,mask:d.mask})||canonical(source)!==canonical(d.preparedInputs.source)||canonical(prepared.mask)!==canonical(d.preparedInputs.mask)||canonical(prepared.references.map(r=>r.original))!==canonical(d.references)||canonical(prepared.references.map(r=>r.input))!==canonical(d.preparedInputs.references)||canonical(prepared.requestPlan)!==canonical(d.mask?.requestPlan??null))throw new RequestError([{field:'source',code:'V45_INPUTS_CHANGED',message:'The exact source, mask, ordered references or prepared inputs changed. Prepare them again.'}]);
   const sourceDependencies=this.dependencies(legacy,saved);for(const ref of [...refs(d),...prepared.refs])this.objects.verify(ref);
   return hash(canonical({kind:'request-dependencies-v45-edit-1',sourceDependencies,prompt:d.prompt,operation:d.operation,source:d.source,mask:d.mask,references:d.references,preparedInputs:d.preparedInputs}));
   }finally{preparedRead.release();}
  }
  const state=this.state(document.id),source=d.operation.startsWith('transform')||d.operation.startsWith('inpaint')?d.source:null,mask=d.operation.startsWith('inpaint')?d.mask:null;for(const s of [source,mask])if(s){const a=this.assets.asset(s.assetId);if(!a?.raster||a.qualification!=='canonical-raster'||a.safety!=='safe'||a.availability!=='available'||a.version!==s.version||canonical(a.blob)!==canonical(s.blob)||canonical(a.raster.pixels)!==canonical(s.pixels)||a.raster.width!==s.width||a.raster.height!==s.height||s===d.source&&a.raster.role==='mask')throw new RequestError([{field:s===d.source?'source':'mask',code:'DEPENDENCY_CHANGED',message:'The exact attached asset is unavailable or changed.'}]);}
  if(source?.capture){
   const asset=this.assets.asset(source.assetId)!,manifest=parseControlJSON(this.objects.verify(source.capture,true)!) as any,capture=manifest.plan?.capture;
   try{validateRequestSourceCapture(capture);}catch{throw new RequestError([{field:'source',code:'SOURCE_CAPTURE_CHANGED',message:'The retained source capture record is unavailable or invalid.'}]);}
   if(canonical(asset.raster!.manifest)!==canonical(source.capture)||manifest.plan?.kind!=='request-source-capture-v1'||!capture||capture.documentId!==document.id||capture.documentRevision!==source.documentRevision||capture.scope!==source.scope||manifest.width!==source.width||manifest.height!==source.height||canonical(manifest.pixels)!==canonical(source.pixels))throw new RequestError([{field:'source',code:'SOURCE_CAPTURE_CHANGED',message:'The attached rendered capture does not match its immutable source record. Capture the source again explicitly.'}]);
   this.objects.verify(capture.image.state);
  }else if(source?.scope==='visible-document'&&(document.image?.compositeAssetId!==source.assetId||document.revision!==source.documentRevision))throw new RequestError([{field:'source',code:'SOURCE_CHANGED',message:'Capture the current document explicitly.'}]);
  if(mask){const manifest=parseControlJSON(this.objects.verify(mask.plan,true)!) as any;const stats=manifest.plan?.statistics;if(!stats||mask.empty!==(stats.effectivePixels===0)||mask.full!==(stats.effectivePixels===mask.width*mask.height))throw new RequestError([{field:'mask',code:'MASK_COVERAGE',message:'Mask coverage must match retained measured statistics.'}]);const a=this.assets.asset(mask.assetId)!;if(a.raster?.role!=='mask'||canonical(a.raster.manifest)!==canonical(mask.plan))throw new RequestError([{field:'mask',code:'MASK_PLAN',message:'A retained local mask plan is required.'}]);}
  if(mask&&source){if(!mask.binding){const f=mask.frame,layer=state.layers.find(l=>l.id===f?.layer.id);if(!f||!layer||canonical({...f,alignment:null})!==canonical(captureMaskFrame(document,layer)))throw new RequestError([{field:'mask',code:'MASK_FRAME_CHANGED',message:'The exact mask frame, layer version or document dependencies changed. Reattach and review explicitly.'}]);}requireMaskAlignment(source,mask);
   const plan=requireRequestMaskPlan(source,mask),manifest=parseControlJSON(this.objects.verify(mask.plan,true)!) as any;
   try{
    if(mask.binding&&(manifest.plan.kind!=='authored-request-mask-v1'||manifest.plan.sourceAssetId!==source.assetId||canonical(manifest.plan.source)!==canonical(source.capture)||canonical(manifest.plan.sourcePixels)!==canonical(source.pixels)))throw new RequestError([{field:'mask',code:'REQUEST_MASK_SOURCE_CHANGED',message:'The retained edit mask was authored for a different source. Create an explicitly reviewed successor mask for this capture.'}]);
    if(mask.binding&&manifest.plan.clip!==null&&plan.resolution!=='clipped-and-approved')throw new RequestError([{field:'mask',code:'MASK_CLIP_REVIEW_REQUIRED',message:'This retained mask contains explicitly clipped coverage. Approve that clipping in the request mapping preview.'}]);
    requirePlanDependencies(plan,{sourcePixels:source.pixels,authoredMask:manifest.plan.hard,effectiveMask:manifest.plan.effective,dependenciesHash:requestMaskDependencies(source,mask),document:{width:source.width,height:source.height}});
    this.objects.verify(plan.authoredMask);this.objects.verify(plan.effectiveMask);
    // Read exact R16 bytes in bounded chunks. Display RGBA and client flags are not coverage authority.
    let block=-1,bytes:Buffer=Buffer.alloc(0);const total=Number(plan.effectiveMask.byteLength),chunk=1048576;
    const measured=requireRequestCoverage(plan,{width:mask.width,height:mask.height,get:(x,y)=>{const offset=(y*mask.width+x)*2,next=Math.floor(offset/chunk)*chunk;if(next!==block){block=next;bytes=Buffer.from(this.objects.readRange(plan.effectiveMask,String(block),Math.min(chunk,total-block)));}return bytes.readUInt16LE(offset-block);}});
    if(mask.empty!==(measured.effectivePixels===0)||mask.full!==measured.fullDocument)throw Error('MASK_COVERAGE');
    if(measured.fullDomain&&!measured.fullDocument&&!mask.cropAcknowledged)throw new RequestError([{field:'mask',code:'FULL_SOURCE_CROP_ACK_REQUIRED',message:'The entire source crop can change. Review the final coverage and acknowledge that extent.'}]);
   }catch(e){if(e instanceof StoreError||e instanceof RequestError)throw e;throw new RequestError([{field:'mask',code:e instanceof Error?e.message:'MASK_PLAN_REVIEW_REQUIRED',message:'The retained request mask bytes or mapping do not match the approved plan. Reattach and review the mask.'}]);}
  }
  if(d.prompt.mode==='composition'){
   if(!state.composition||canonical(state.composition)!==canonical(d.prompt.composition))throw new RequestError([{field:'prompt',code:'COMPOSITION_CHANGED',message:'Approve the current Composition projection.'}]);
   const c=parseControlJSON(readRequestBytes(this.objects,state.composition.value,1048576),1048576);validateComposition(c);
   if(!c.review||canonical(c.review)!==canonical(d.prompt.projection)||canonical(c.review.prompt)!==canonical(d.prompt.text)||c.request.operation!==labels[operations.indexOf(d.operation)]||c.request.expansion!==d.fields.expansion)throw new RequestError([{field:'prompt',code:'PROJECTION_CHANGED',message:'The exact operation, expansion and prompt projection must agree.'}]);
   for(const dep of c.review.dependencies){const layer=state.layers.find(l=>l.id===state.composition!.bindings[dep.layerId]);if(!layer||layer.version!==dep.version)throw new RequestError([{field:'prompt',code:'LINK_CHANGED',message:'A linked layer changed.'}]);}
   if(d.fields.size==='custom'&&(c.frame.width!==Number(d.fields.width)||c.frame.height!==Number(d.fields.height)))throw new RequestError([{field:'size',code:'FRAME_CHANGED',message:'The reviewed Composition frame must match the requested output.'}]);
   if(d.fields.size!=='custom'&&c.review.boxes.some(b=>b.projection!==null))throw new RequestError([{field:'size',code:'UNRESOLVED_FRAME',message:'Choose explicit dimensions or explicitly omit Composition bounds.'}]);
  }
  for(const ref of refs(d))this.objects.verify(ref);
  // Large weights are cooperatively proved by the owning Save/Review/Queue
  // transaction. This synchronous dependency pass checks presence and length.
  for(const ref of adapterReferences(this.assets,d.adapters))this.objects.readRange(ref,'0',0);
  return hash(canonical({document:{id:document.id,revision:document.revision,image:document.image??null},source:d.source,mask:d.mask,adapters:d.adapters,prompt:d.prompt,conversion:d.conversion}));
 }
 prepare(saved:SavedDraft,sessionId:string,requestId:string,auth:AssetAuth,treatment?:TextTreatmentReviewIntent):RequestReview{
  if(saved.composing||saved.status!=='saved-unapplied')throw new RequestError([{field:'prompt',code:'DRAFT_NOT_SETTLED',message:'Finish editing and save the current draft first.'}]);
  const d=this.draft(saved),dependencyHash=this.dependencies(d,saved),prompt=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readRequestBytes(this.objects,d.prompt.text));
  const request=resolve(d,prompt,adapterEligibility(this.db,this.assets,adapters(d),this.objects)),templateBytes=Buffer.from(bodyTemplate(request,prompt)),stage=this.objects.begin(String(templateBytes.length),'application/json');let template:BlobRef;
  try{for(let offset=0;offset<templateBytes.length;offset+=1048576)this.objects.chunk(stage,templateBytes.subarray(offset,offset+1048576));template=this.objects.finish(stage);}finally{this.objects.abort(stage);}
  const route=routes[d.operation];
  const finish=(review:import('../../src/request/review.js').BaseRequestReview):RequestReview=>treatment?bindRequestTextTreatment(review,new TextTreatments(this.objects,this.assets,this.state,this.rasters).prepare(treatment,d,this.document(saved),requestId)):review;
  if(isV45Request(request)){const value={kind:'request-review-v45-1' as const,id:requestId,owner:this.owner(auth),draft:{sessionId,draftId:saved.id,generation:saved.generation},draftAsset:saved.assetId,documentId:saved.documentId,documentRevision:saved.expectedDocumentRevision,request,endpoint:route.endpoint,schemaHash:route.schemaHash,routeHash:hash(canonical(route)),dependencyHash,template,prompt:d.prompt.text,conversion:null,inactive:{},destination:d.destination,privacy:d.privacy,estimate:request.modelRequest.estimate,providerReview:providerReviewV45(request),dispatch:false as const};const result={...value,token:hash(canonical(value))};if(Buffer.byteLength(canonical(result))>60000)throw new RequestError([{field:'review',code:'REVIEW_TOO_LARGE',message:'This review exceeds the bounded control record; the complete draft remains saved.'}]);verifyRequestReviewV45(result,prompt);return finish(result);}
  if(isV45Draft(d))throw new StoreError('MALFORMED_REQUEST');
  const value:Omit<import('../../src/request/review.js').RequestReviewV4,'token'>={kind:'request-review-1',id:requestId,owner:this.owner(auth),draft:{sessionId,draftId:saved.id,generation:saved.generation},draftAsset:saved.assetId,documentId:saved.documentId,documentRevision:saved.expectedDocumentRevision,request,endpoint:route.endpoint,schemaHash:route.schemaHash,routeHash:hash(canonical(route)),dependencyHash,template,prompt:d.prompt.text,conversion:d.conversion,inactive:d.inactive,destination:d.destination,privacy:d.privacy,estimate:estimate(request) as import('../../src/request/review.js').RequestReviewV4['estimate'],dispatch:false};const result={...value,token:hash(canonical(value))};if(Buffer.byteLength(canonical(result))>60000)throw new RequestError([{field:'review',code:'REVIEW_TOO_LARGE',message:'This review exceeds the bounded control record; the complete draft remains saved.'}]);return finish(result);
 }
 treatmentRefs(review:RequestReview){return review.kind==='request-review-text-1'?new TextTreatments(this.objects,this.assets,this.state,this.rasters).refs(review.textTreatment):[];}
 assert(input:RequestReview,saved:SavedDraft,auth:AssetAuth){const review=baseRequestReview(input);if(input.kind==='request-review-text-1')new TextTreatments(this.objects,this.assets,this.state,this.rasters).assert(input.textTreatment,this.draft(saved),this.document(saved));if(review.kind==='request-review-v45-1'){try{verifyRequestReviewV45(review,new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readRequestBytes(this.objects,review.prompt)));}catch{throw new StoreError('MALFORMED_REQUEST');}}const draft=this.draft(saved);if(isV45Draft(draft)!==(review.kind==='request-review-v45-1'))throw new RequestError([{field:'review',code:'STALE_REVIEW',message:'The saved request family changed. Prepare a new review.'}]);if(review.owner!==this.owner(auth)||saved.id!==review.draft.draftId||saved.generation!==review.draft.generation||saved.assetId!==review.draftAsset||saved.composing||this.dependencies(this.draft(saved),saved)!==review.dependencyHash)throw new RequestError([{field:'review',code:'STALE_REVIEW',message:'Owner, draft or dependencies changed. Prepare a new review.'}]);const {token,...value}=review;if(hash(canonical(value))!==token)throw new StoreError('MALFORMED_REQUEST');
  // Accept and enqueue rederive current authority. A previous matching run is
  // not a permanent acknowledgement for a changed profile or unavailable proof.
  if(!isV45Draft(draft)&&draft.operation.endsWith('adapters')&&draft.adapters.some(a=>a.runtimeAcknowledged!==true)&&!runtimeAdaptersVerified(draft.operation,draft.adapters,adapterEligibility(this.db,this.assets,draft.adapters,this.objects)))throw new RequestError([{field:'adapters',code:'ADAPTER_RUNTIME_EVIDENCE_CHANGED',message:'The matching runtime observation is unavailable or its scope changed. Review and acknowledge the current request explicitly.'}]);
  this.objects.verify(review.template);}
}

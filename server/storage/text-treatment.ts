import {retainedMetadataReferences} from '../portable/retained.js';
import {validateSource,dependencyIdentity} from '../text/validation.js';
import type {Objects} from './objects.js';
import type {Assets} from './assets.js';
import type {Rasters} from './raster.js';
import type {BlobRef,Document} from '../../src/protocol/store.js';
import type {ImageState} from '../../src/protocol/history.js';
import {imageState} from '../../src/protocol/history-validation.js';
import type {Source} from '../../src/request/core.js';
import type {Draft} from '../../src/request/family.js';
import {isV45Draft} from '../../src/request/family.js';
import {assertCurrentCompositionText} from './composition-text.js';
import {canonical} from './canonical.js';
import {hash,RequestError} from '../../src/request/core.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {validateRequestSourceCapture} from '../../src/protocol/request-edits.js';
import {textSource,textRefs} from '../../src/protocol/text.js';
import {bindingValue,validateComposition,compositionRefs,type Composition} from '../../src/composition/core.js';
import {TextTreatmentError,planTextTreatment,planTextTreatmentAdoption,planTextTreatmentPlacement,type TreatmentPlacementCandidate,type TreatmentAdoptionCandidate,type TreatmentAdoptionChoice,validateTextTreatmentPlan,assertTextTreatmentFresh,bindTextTreatmentEnvelope,textTreatmentRefs,assertTextTreatmentEnvelope,type TextTreatmentReviewIntent,type TextTreatmentInventory,type TreatmentContribution,type TreatmentSource,type TextTreatmentPlan,type RequestTextTreatmentEnvelope} from '../../src/request/text-treatment.js';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function deny(code:string):never{throw new RequestError([{field:'textTreatment',code,message:'Review native layers, semantic text and the exact source again before continuing.'}]);}
export type TextTreatmentReference={ref:BlobRef;role:'required'|'font-bytes'};
/** All rows are built from current retained data. Client summaries supply no authority. */
export class TextTreatments {
 constructor(private objects:Objects,private assets:Assets,private state:(id:string)=>ImageState,private rasters:Rasters){}
 private expected<T>(work:()=>T):T{try{return work();}catch(error){if(error instanceof TextTreatmentError)deny(error.code);throw error;}}
 prepare(intent:TextTreatmentReviewIntent,draft:Draft,document:Document,id:string):RequestTextTreatmentEnvelope{return this.expected(()=>this.prepareValidated(intent,draft,document,id));}
 assert(envelope:RequestTextTreatmentEnvelope,draft:Draft,document:Document):TextTreatmentPlan{return this.expected(()=>this.assertValidated(envelope,draft,document));}
 adoption(envelope:RequestTextTreatmentEnvelope,document:Document,candidate:TreatmentAdoptionCandidate,choice:TreatmentAdoptionChoice){return this.expected(()=>this.adoptionValidated(envelope,document,candidate,choice));}
 placement(envelope:RequestTextTreatmentEnvelope,document:Document,candidate:TreatmentPlacementCandidate,choice:TreatmentAdoptionChoice){return this.expected(()=>{const {plan,current,copyState}=this.placementContext(envelope,document,choice);return {decision:planTextTreatmentPlacement(plan,current,candidate,choice),copyState};});}
 refs(envelope:RequestTextTreatmentEnvelope):BlobRef[]{return this.expected(()=>this.refsValidated(envelope).map(entry=>entry.ref));}
 // Roles classify retained data only; callers still own command authorization
 // and byte proofs. An ordinary use always defeats the font-only exception.
 refsWithRoles(envelope:RequestTextTreatmentEnvelope):TextTreatmentReference[]{return this.expected(()=>this.refsValidated(envelope,true));}
 private read(ref:BlobRef,max=65536):Uint8Array {if(BigInt(ref.byteLength)>BigInt(max))deny('TEXT_TREATMENT_LIMIT');if(process.memoryUsage().rss+Number(ref.byteLength)*6+16777216>536870912)deny('TEXT_TREATMENT_CAPACITY');this.objects.verify(ref);const bytes=new Uint8Array(Number(ref.byteLength));for(let at=0;at<bytes.length;at+=1048576)bytes.set(this.objects.readRange(ref,String(at),Math.min(1048576,bytes.length-at)),at);return bytes;}
 private json(ref:BlobRef,max=65536):any{return parseControlJSON(this.read(ref,max),max);}
 private store(value:unknown,media='application/json'):BlobRef {const bytes=Buffer.from(media==='application/json'?canonical(value):String(value)),stage=this.objects.begin(String(bytes.length),media);try{for(let at=0;at<bytes.length;at+=1048576)this.objects.chunk(stage,bytes.subarray(at,at+1048576));return this.objects.finish(stage);}finally{this.objects.abort(stage);}}
 private source(source:Source|null,document:Document):TreatmentSource|null {
  if(source===null)return null;const asset=this.assets.asset(source.assetId);
  if(!asset?.raster||asset.safety!=='safe'||asset.availability!=='available'||asset.qualification!=='canonical-raster'||asset.version!==source.version||!same(asset.blob,source.blob)||!same(asset.raster.pixels,source.pixels)||asset.raster.width!==source.width||asset.raster.height!==source.height||asset.raster.role==='mask')deny('TEXT_TREATMENT_SOURCE_CHANGED');
  if(source.scope==='asset'){if(source.capture)deny('TEXT_TREATMENT_SOURCE_CHANGED');return {source,capture:null};}
  if(!source.capture||!same(asset.raster.manifest,source.capture))deny('TEXT_TREATMENT_CAPTURE_REQUIRED');
  const manifest=this.json(source.capture),capture=manifest.plan?.capture;validateRequestSourceCapture(capture);
  if(manifest.plan.kind!=='request-source-capture-v1'||capture.documentId!==document.id||capture.documentRevision!==document.revision||source.documentRevision!==document.revision||!same(capture.image,document.image)||capture.scope!==source.scope||!same(manifest.pixels,source.pixels))deny('TEXT_TREATMENT_SOURCE_CHANGED');
  this.rasters.contributionRefs(manifest);return {source,capture};
 }
 private contributions(baseline:Source|null,document:Document):Map<string,TreatmentContribution> {
  const state=this.state(document.id),visible=state.layers.filter(l=>l.visible);if(!visible.length)return new Map();
  const source=this.source(baseline,document);if(!source?.capture||source.capture.scope!=='visible-document'||!same(source.capture.layerIds,visible.map(l=>l.id)))deny('TEXT_TREATMENT_BASELINE_REQUIRED');
  const manifest=this.json(source.source.capture!),stack=manifest.plan?.contributions?this.json(manifest.plan.contributions):null;
  if(!stack||stack.contributions.length!==visible.length)deny('TEXT_TREATMENT_CONTRIBUTIONS_REQUIRED');
  return new Map(visible.map((l,index)=>[l.id,stack.contributions[index]]));
 }
 private inventory(document:Document,contributions:Map<string,TreatmentContribution>,frozen?:{state:ImageState;revision:string;imageState:BlobRef}):TextTreatmentInventory {
  const state=frozen?.state??this.state(document.id),imageState=frozen?.imageState??document.image?.state??this.store(state);
  const layers=state.layers.map(layer=>{
   let native=null;if(layer.kind==='text'){const source=validateSource(this.json(layer.source));if(dependencyIdentity(source)!==source.render.dependencyHash)deny('TEXT_TREATMENT_NATIVE_IDENTITY');native={source:layer.source,literal:source.text.textUtf8,textVersion:source.text.id,renderVersion:source.render.id,dependencyHash:source.render.dependencyHash};}
   const contribution=contributions.get(layer.id)??null;
   if(layer.visible){if(!contribution)deny('TEXT_TREATMENT_CONTRIBUTIONS_REQUIRED');const m=this.json(contribution.manifest),p=m.plan,a=this.assets.asset(layer.assetId),mask=layer.mask?this.assets.asset(layer.mask.assetId):null;
    if(p?.kind!=='cp1-layer-contribution-v1'||m.width!==state.width||m.height!==state.height||!same(m.pixels,contribution.pixels)||hash(canonical({pipeline:m.pipeline,width:m.width,height:m.height,tiles:m.tiles}))!==contribution.pixelIdentity||!same(p.layer,{assetId:layer.assetId,transform:layer.layerToDocument,opacity:layer.opacity,mask:layer.mask})||!same(p.source,a?.raster?.manifest)||!same(p.mask,mask?.raster?.manifest??null))deny('TEXT_TREATMENT_CONTRIBUTION_CHANGED');
   }
   return {id:layer.id,version:layer.version,kind:layer.kind,visible:layer.visible,locked:layer.locked,stateHash:hash(canonical(layer)),contribution,native};
  });
  let composition:TextTreatmentInventory['composition']=null,semanticText:TextTreatmentInventory['semanticText']=[];
  if(state.composition){const c=this.json(state.composition.value,1048576) as Composition;validateComposition(c);if(c.id!==state.composition.id)deny('TEXT_TREATMENT_COMPOSITION_CHANGED');composition={id:c.id,value:state.composition.value,bindingsHash:hash(canonical(state.composition.bindings)),frameHash:hash(canonical(c.frame))};
   semanticText=c.elements.filter(e=>e.type==='text').map(e=>{const literal=this.store(bindingValue(e.text),'text/plain'),description=this.store(bindingValue(e.desc),'text/plain'),bounds=e.bounds?this.store(bindingValue(e.bounds)):null;
    const bindings:TextTreatmentInventory['semanticText'][number]['bindings']=[];
    for(const [field,binding,ref] of [['text',e.text,literal],['description',e.desc,description],['bounds',e.bounds,bounds]] as const)if(binding?.mode==='layer'&&ref)bindings.push({field,bindingLayerId:binding.layerId,layerId:state.composition!.bindings[binding.layerId],reviewedLayerVersion:binding.lastReviewedLayerVersion,reviewedValue:ref});
    return {id:e.id,literal,description,bounds,bindings};});
  }
  return {schemaVersion:1,kind:'text-treatment-inventory-1',documentId:document.id,documentRevision:frozen?.revision??document.revision,grid:{width:state.width,height:state.height},imageState,layers,composition,semanticText};
 }
 private prepareValidated(intent:TextTreatmentReviewIntent,draft:Draft,document:Document,id:string):RequestTextTreatmentEnvelope {
  if(!intent||intent.kind!=='text-treatment-review-intent-1'||Object.keys(intent).sort().join(',')!=='baseline,beforeSource,choice,kind')deny('TEXT_TREATMENT_INTENT');
  const inventory=this.inventory(document,this.contributions(intent.baseline,document));
  const after=draft.operation==='generate-v45'||['generate','fast','instant','generate-adapters'].includes(draft.operation)?null:('source'in draft?draft.source:null);
  const mode=isV45Draft(draft)&&draft.prompt.projection!==null?'composition-text':draft.prompt.mode;
  const projection=mode==='composition'||mode==='composition-text'?this.store(draft.prompt.projection):null;
  const mask=draft.operation.startsWith('inpaint')&&'mask'in draft?draft.mask:null;const edit=mask?.requestPlan?{effectiveMask:mask.requestPlan.effectiveMask,requestPlan:this.store(mask.requestPlan)}:null;
  const plan=planTextTreatment({id,inventory,choice:intent.choice,beforeSource:this.source(intent.beforeSource,document),afterSource:this.source(after,document),prompt:{mode,bytes:draft.prompt.text,projection},edit});
  this.match(plan,draft,document);const ref=this.store(plan);return bindTextTreatmentEnvelope(plan,ref);
 }
 private match(plan:TextTreatmentPlan,draft:Draft,document:Document):void {
  const after=draft.operation==='generate-v45'||['generate','fast','instant','generate-adapters'].includes(draft.operation)?null:('source'in draft?draft.source:null);
  const mode=isV45Draft(draft)&&draft.prompt.projection!==null?'composition-text':draft.prompt.mode;
  if(!same(plan.afterSource,this.source(after,document))||plan.prompt.mode!==mode||!same(plan.prompt.bytes,draft.prompt.text))deny('TEXT_TREATMENT_REQUEST_CHANGED');
  if(mode==='composition'||mode==='composition-text'){
   if(mode==='composition-text')assertCurrentCompositionText(draft,this.state(document.id),ref=>this.read(ref,1048576),id=>this.assets.asset(id),this.rasters.compositionMemory);
   if(!plan.prompt.projection||!same(this.json(plan.prompt.projection,524288),draft.prompt.projection))deny('TEXT_TREATMENT_PROJECTION_CHANGED');
   const state=this.state(document.id),c=state.composition?this.json(state.composition.value,1048576):null;
   if(!c||!same(c.elements.filter((e:any)=>e.type==='text'&&e.excluded).map((e:any)=>e.id),plan.excludedSemanticIds))deny('TEXT_TREATMENT_EXCLUSIONS_CHANGED');
  }else if(plan.prompt.projection!==null||plan.includedSemanticIds.length)deny('TEXT_TREATMENT_SEMANTIC_PROJECTION_REQUIRED');
  const mask=draft.operation.startsWith('inpaint')&&'mask'in draft?draft.mask:null;if(mask?.requestPlan){if(!plan.edit||!same(plan.edit.effectiveMask,mask.requestPlan.effectiveMask)||!same(this.json(plan.edit.requestPlan),mask.requestPlan))deny('TEXT_TREATMENT_MASK_CHANGED');}else if(plan.edit!==null)deny('TEXT_TREATMENT_MASK_CHANGED');
 }
 private assertValidated(envelope:RequestTextTreatmentEnvelope,draft:Draft,document:Document):TextTreatmentPlan {
  const plan=this.json(envelope.plan,524288);validateTextTreatmentPlan(plan);assertTextTreatmentEnvelope(envelope,plan);const contributions=new Map(plan.inventory.layers.flatMap(l=>l.contribution?[[l.id,l.contribution] as const]:[]));
  assertTextTreatmentFresh(plan,this.inventory(document,contributions));this.source(plan.beforeSource?.source??null,document);this.match(plan,draft,document);return plan;
 }
 private adoptionValidated(envelope:RequestTextTreatmentEnvelope,document:Document,candidate:TreatmentAdoptionCandidate,choice:TreatmentAdoptionChoice){
  const {plan,current,copyState}=this.placementContext(envelope,document,choice);return {decision:planTextTreatmentAdoption(plan,current,candidate,choice),copyState};
 }
 private placementContext(envelope:RequestTextTreatmentEnvelope,document:Document,choice:TreatmentAdoptionChoice){
  const plan=this.json(envelope.plan,524288);validateTextTreatmentPlan(plan);assertTextTreatmentEnvelope(envelope,plan);
  let frozen:{state:ImageState;revision:string;imageState:BlobRef}|undefined;
  if(choice.action==='new-document'){
   if(document.id!==plan.inventory.documentId)deny('TEXT_TREATMENT_SOURCE_CHANGED');
   const state=this.json(plan.inventory.imageState);imageState(state);
   frozen={state,revision:plan.inventory.documentRevision,imageState:plan.inventory.imageState};
  }
  // A fresh new-document review copies the accepted request's retained versions.
  // Rebuild their inventory from owned bytes before applying the same exact-plan
  // check. Current-document placement still requires the live inventory to match.
  const current=this.inventory(document,new Map(plan.inventory.layers.flatMap(layer=>layer.contribution?[[layer.id,layer.contribution] as const]:[])),frozen);
  return {plan,current,copyState:frozen?.state??this.state(document.id)};
 }
 private refsValidated(envelope:RequestTextTreatmentEnvelope,withRoles=false):TextTreatmentReference[]{
  const plan:TextTreatmentPlan=this.json(envelope.plan,524288);assertTextTreatmentEnvelope(envelope,plan);const refs=new Map<string,TextTreatmentReference>();
  const add=(ref:BlobRef,role:TextTreatmentReference['role']='required')=>{const key=canonical(ref),old=refs.get(key);refs.set(key,{ref,role:old?.role==='required'?'required':role});};
  const addText=(value:unknown,immutable=false)=>{
   if(withRoles||immutable){validateSource(value);retainedMetadataReferences(value);}else textSource(value);
   const source=value as import('../../src/protocol/text.js').TextSource;
   const required=new Set([source.text.textUtf8,source.render.layout,source.render.pixels,source.render.rendererProfile.manifest,...source.text.fonts.map(font=>font.licenseRecord)].map(ref=>canonical(ref)));
   for(const ref of textRefs(source))add(ref,required.has(canonical(ref))?'required':'font-bytes');
  };
  for(const ref of [envelope.plan,...textTreatmentRefs(plan)])add(ref);
  for(const layer of plan.inventory.layers){if(layer.native)addText(this.json(layer.native.source));if(layer.contribution){const m=this.json(layer.contribution.manifest);for(const ref of m.dependencies)add(ref);}}
  if(plan.inventory.composition){const c=this.json(plan.inventory.composition.value,1048576);validateComposition(c);for(const ref of compositionRefs(c))add(ref);}
  if(plan.edit){const mapping=this.json(plan.edit.requestPlan);for(const ref of [mapping.sourcePixels,mapping.authoredMask,mapping.effectiveMask])add(ref);}
  const pending=[plan.inventory.imageState,...plan.inventory.layers.flatMap(layer=>[...(layer.native?[layer.native.source]:[]),...(layer.contribution?[layer.contribution.manifest]:[])]),...[plan.beforeSource,plan.afterSource].flatMap(source=>source?.source.capture?[source.source.capture]:[])],seen=new Set<string>();
  while(pending.length){const ref=pending.pop()!;if(seen.has(ref.hash))continue;if(seen.size>=10000)deny('TEXT_TREATMENT_GRAPH_LIMIT');seen.add(ref.hash);const value=this.json(ref,plan.inventory.composition?.value.hash===ref.hash?1048576:65536);if(value?.text&&value.render){addText(value,true);continue;}for(const edge of retainedMetadataReferences(value)){add(edge.ref);if(edge.inspect&&!seen.has(edge.ref.hash)&&!pending.some(queued=>queued.hash===edge.ref.hash))pending.push(edge.ref);}}
  return [...refs.values()];
 }
}

import type {BlobRef} from '../../src/protocol/store.js';
import type {ImageLayer,ImageState} from '../../src/protocol/history.js';
import type {RasterManifest} from '../../src/protocol/raster.js';
import type {TextSource} from '../../src/protocol/text.js';
import {blob,contributionStack,rasterManifest,requireValue as ok} from '../../src/protocol/validate.js';
import {imageState} from '../../src/protocol/history-validation.js';
import {parseControlJSON,canonical} from '../../src/protocol/json.js';
import {hashBytes} from '../storage/canonical.js';
import {validateSource,dependencyIdentity} from '../text/validation.js';
import {textRefs} from '../../src/protocol/text.js';
import {bindingMap,bindingValue,serialize,validateComposition,type Composition} from '../../src/composition/core.js';
import {validateCompositionTextReview,verifyCompositionTextReview} from '../../src/composition/text-export.js';
import {validateRequestRasterPlan} from '../../src/request/raster-plan.js';
import {footprint} from '../../src/raster/core.js';
import {contributionReferences} from './contributions.js';
import {retainedMetadataReferences} from './retained.js';
import {
 assertTextTreatmentEnvelope,textTreatmentRefs,validateRequestTextTreatmentEnvelope,
 validateTextTreatmentPlan,type RequestTextTreatmentEnvelope,type TextTreatmentPlan,
 type TreatmentSemanticBinding,type TreatmentSource,
} from '../../src/request/text-treatment.js';

const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const layerInput=(layer:ImageLayer)=>({assetId:layer.assetId,transform:layer.layerToDocument,opacity:layer.opacity,mask:layer.mask});
const pixelIdentity=(m:RasterManifest)=>hashBytes(canonical({pipeline:m.pipeline,width:m.width,height:m.height,tiles:m.tiles}));
const semanticDigest=(state:ImageState)=>hashBytes(canonical({...state,layers:state.layers.map(({version,...layer})=>layer)}));
type ReadBytes=(ref:BlobRef)=>Promise<Uint8Array>;

/** Validate an immutable observation, never resolve its logical IDs in the current
 * namespace. The archive's existing sealed-object/hash pass owns all returned
 * leaves; this pass reads only bounded metadata and exact semantic scalar bytes.
 * It neither re-renders CP1/native text nor confers queue/adoption authority. */
export async function validateTextTreatmentObservation(envelope:RequestTextTreatmentEnvelope,read:ReadBytes,compositionTextSemantics=true):Promise<BlobRef[]> {
 validateRequestTextTreatmentEnvelope(envelope);
 const refs=new Map<string,BlobRef>(),lengths=new Map<string,string>(),jsons=new Map<string,any>(),visited=new Set<string>();
 const pending:BlobRef[]=[],scheduled=new Set<string>();let metadataBytes=0;
 const add=(ref:BlobRef,inspect=false)=>{
  blob(ref);const prior=lengths.get(ref.hash);ok(prior===undefined||prior===ref.byteLength);
  lengths.set(ref.hash,ref.byteLength);refs.set(ref.hash+':'+ref.mediaType,ref);
  ok(refs.size<=32768,'Text treatment reference limit');
  if(inspect){ok(ref.mediaType==='application/json');if(!scheduled.has(ref.hash)){scheduled.add(ref.hash);ok(scheduled.size<=4096,'Text treatment metadata limit');pending.push(ref);}}
 };
 const bytes=async(ref:BlobRef,max:number)=>{
  add(ref);ok(BigInt(ref.byteLength)<=BigInt(max),'Text treatment metadata limit');
  metadataBytes+=Number(ref.byteLength);ok(metadataBytes<=33554432,'Text treatment metadata limit');
  ok(process.memoryUsage().rss+Number(ref.byteLength)*6+16777216<=536870912,'Text treatment metadata capacity');
  const value=await read(ref);ok(value instanceof Uint8Array&&String(value.byteLength)===ref.byteLength&&hashBytes(value)===ref.hash);
  return value;
 };
 const json=async(ref:BlobRef,max=65536):Promise<any>=>{
  add(ref);ok(ref.mediaType==='application/json'&&BigInt(ref.byteLength)<=BigInt(max));
  if(jsons.has(ref.hash))return jsons.get(ref.hash);
  ok(jsons.size<4096,'Text treatment metadata limit');
  const raw=await bytes(ref,max),value=parseControlJSON(raw,max);
  ok(canonical(value)===Buffer.from(raw).toString('utf8'));jsons.set(ref.hash,value);return value;
 };
 const literal=async(ref:BlobRef,value:string)=>{
  ok(['text/plain','text/plain;charset=utf-8'].includes(ref.mediaType));
  const raw=await bytes(ref,1048576);ok(Buffer.from(raw).equals(Buffer.from(value,'utf8')));
 };
 const source=async(ref:BlobRef):Promise<TextSource>=>{
  const value=validateSource(await json(ref));ok(value.render.dependencyHash===dependencyIdentity(value));
  for(const leaf of textRefs(value))add(leaf);return value;
 };
 const plan:TextTreatmentPlan=await json(envelope.plan,524288);
 validateTextTreatmentPlan(plan);assertTextTreatmentEnvelope(envelope,plan);
 ok(compositionTextSemantics||plan.prompt.mode!=='composition-text','Composition text requires portable format 12');
 for(const ref of textTreatmentRefs(plan))add(ref);
 const inventory=plan.inventory,state:ImageState=await json(inventory.imageState);imageState(state);
 ok(state.width===inventory.grid.width&&state.height===inventory.grid.height&&state.layers.length===inventory.layers.length);
 for(let index=0;index<state.layers.length;index++){
  const layer=state.layers[index],row=inventory.layers[index];
  ok(row.id===layer.id&&row.version===layer.version&&row.kind===layer.kind&&row.visible===layer.visible&&row.locked===layer.locked&&row.stateHash===hashBytes(canonical(layer)));
  if(layer.kind==='text'){
   ok(row.native!==null&&same(row.native.source,layer.source));const native=await source(layer.source);
   ok(same(row.native.literal,native.text.textUtf8)&&row.native.textVersion===native.text.id&&row.native.renderVersion===native.render.id&&row.native.dependencyHash===native.render.dependencyHash);
  }else ok(row.native===null);
  if(row.contribution){
   const m:RasterManifest=await json(row.contribution.manifest);rasterManifest(m);const p:any=m.plan;
   ok(p.kind==='cp1-layer-contribution-v1'&&m.width===state.width&&m.height===state.height&&same(p.layer,layerInput(layer))&&same(p.footprint,footprint({x:0,y:0,width:state.width,height:state.height},layer.layerToDocument))&&same(m.pixels,row.contribution.pixels)&&pixelIdentity(m)===row.contribution.pixelIdentity);
   const original:RasterManifest=await json(p.source);rasterManifest(original);
   if(layer.kind==='text')ok((original.plan as any).kind==='retained-text'&&same((original.plan as any).source,layer.source));
   add(row.contribution.manifest,true);
  }
 }
 if(state.composition){
  const retained=inventory.composition;ok(retained!==null&&retained.id===state.composition.id&&same(retained.value,state.composition.value)&&retained.bindingsHash===hashBytes(canonical(state.composition.bindings)));
  const c:Composition=await json(retained.value,1048576);validateComposition(c);bindingMap(c,state.composition.bindings);
  ok(c.id===retained.id&&retained.frameHash===hashBytes(canonical(c.frame)));
  const elements=c.elements.filter(e=>e.type==='text');ok(elements.length===inventory.semanticText.length);
  for(let index=0;index<elements.length;index++){
   const element=elements[index],row=inventory.semanticText[index];ok(row.id===element.id);
   await literal(row.literal,bindingValue(element.text));await literal(row.description,bindingValue(element.desc));
   if(element.bounds){ok(row.bounds!==null&&same(await json(row.bounds),bindingValue(element.bounds)));}else ok(row.bounds===null);
   const bindings:TreatmentSemanticBinding[]=[];
   for(const [field,binding,ref] of [['text',element.text,row.literal],['description',element.desc,row.description],['bounds',element.bounds,row.bounds]] as const){
    if(binding?.mode==='layer'&&ref)bindings.push({field,bindingLayerId:binding.layerId,layerId:state.composition.bindings[binding.layerId],reviewedLayerVersion:binding.lastReviewedLayerVersion,reviewedValue:ref});
   }
   ok(same(row.bindings,bindings));
  }
  if(plan.prompt.mode==='composition'){
   ok(c.review!==null&&plan.prompt.projection!==null&&same(c.review,await json(plan.prompt.projection,524288))&&same(c.review.prompt,plan.prompt.bytes));
   // Retained last-reviewed values are deliberately used. This is a historical
   // observation; fresh writer admission separately validates live bindings.
   const projected=serialize(c,[],state.composition.bindings,true);
   ok(same(c.review.dependencies,projected.dependencies)&&same(c.review.boxes,projected.boxes));
   await literal(plan.prompt.bytes,projected.prompt);
   ok(same(plan.excludedSemanticIds,elements.filter(e=>e.excluded).map(e=>e.id)));
  }else if(plan.prompt.mode==='composition-text'){
   ok(plan.prompt.projection!==null);
   const review=await json(plan.prompt.projection,524288);validateCompositionTextReview(review);
   ok(same(review.prompt,plan.prompt.bytes));
   const exported=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await bytes(plan.prompt.bytes,40000));
   // Recompute the app-owned prose from the immutable approved source. This
   // does not reinterpret that prose as a provider structured-caption contract.
   verifyCompositionTextReview(c,review,exported);
   await bytes(review.sourceProjection.prompt,262144);
   ok(same(plan.excludedSemanticIds,elements.filter(e=>e.excluded).map(e=>e.id)));
  }
  add(retained.value,true);
 }else ok(inventory.composition===null&&inventory.semanticText.length===0&&!['composition','composition-text'].includes(plan.prompt.mode));
 const capture=async(observation:TreatmentSource|null)=>{
  if(!observation)return;
  const {source:retained,capture:expected}=observation;if(!expected){ok(retained.scope==='asset'&&retained.capture===undefined);return;}
  ok(retained.capture!==undefined);const m:RasterManifest=await json(retained.capture);rasterManifest(m);const p:any=m.plan;
  ok(p.kind==='request-source-capture-v1'&&same(p.capture,expected)&&same(expected.image.state,inventory.imageState)&&expected.image.semanticDigest===semanticDigest(state)&&m.width===state.width&&m.height===state.height&&same(m.pixels,retained.pixels));
  const included=expected.layerIds.map(id=>state.layers.find(layer=>layer.id===id));ok(included.every(layer=>layer!==undefined&&layer.visible));
  ok(same(p.layers,included.map(layer=>layerInput(layer!))));
  if(expected.scope==='visible-document')ok(same(expected.layerIds,state.layers.filter(layer=>layer.visible).map(layer=>layer.id)));
  ok(p.contributions!==undefined);const stack=await json(p.contributions);contributionStack(stack);
  ok(same(stack.contributions,expected.layerIds.map(id=>inventory.layers.find(layer=>layer.id===id)!.contribution)));
  for(const ref of await contributionReferences(m,json))add(ref,ref.mediaType==='application/json');
  add(retained.capture,true);
 };
 await capture(plan.beforeSource);await capture(plan.afterSource);
 if(plan.edit){
  const requestPlan=await json(plan.edit.requestPlan);validateRequestRasterPlan(requestPlan);
  ok(plan.afterSource!==null&&same(requestPlan.document,{width:plan.afterSource.source.width,height:plan.afterSource.source.height})&&same(requestPlan.sourcePixels,plan.afterSource.source.pixels)&&same(requestPlan.effectiveMask,plan.edit.effectiveMask));
  for(const ref of [requestPlan.sourcePixels,requestPlan.authoredMask,requestPlan.effectiveMask])add(ref);
 }
 add(inventory.imageState,true);
 // Typed metadata routing leaves authored JSON, captions, profiles and layouts
 // opaque. Recursing over every JSON-looking leaf would grant raw data meaning.
 while(pending.length){
  const ref=pending.pop()!;if(visited.has(ref.hash))continue;visited.add(ref.hash);ok(visited.size<=4096);
  const value=await json(ref,1048576);
  if(value?.text&&value.render)await source(ref);
  if(value?.format==='straight-srgb-rgba8'&&value.plan){
   rasterManifest(value);for(const child of await contributionReferences(value,json))add(child,child.mediaType==='application/json');
   if(value.plan.kind==='retained-text'){
    const native=await source(value.plan.source);
    ok(same(value.pixels,native.render.pixels)&&value.width===native.render.width&&value.height===native.render.height&&value.dependencies.some((dependency:BlobRef)=>same(dependency,value.plan.source)));
   }
  }
  for(const child of retainedMetadataReferences(value))add(child.ref,child.inspect);
 }
 return [...refs.values()];
}

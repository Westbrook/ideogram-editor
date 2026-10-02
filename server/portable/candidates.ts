import {validateTextTreatmentObservation} from './text-treatment.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {validateComposition,bindingMap,compositionRefs,serialize} from '../../src/composition/core.js';
import {verifyCompositionTextReview} from '../../src/composition/text-export.js';
import type {V45Prompt} from '../../src/request/v45-prompt.js';
import {validateRequestTextTreatmentEnvelope} from '../../src/request/text-treatment.js';
import {providerReviewV45} from '../../src/request/review.js';
import {keys,requireValue as ok,id,seq,blob} from '../../src/protocol/validate.js';
import {draftShape,newDraft,operations,presets,routes,hash} from '../../src/request/core.js';
import type {Operation} from '../../src/request/core.js';
import {validateV45Request,requestCount,requestPrompt,requestSeed,bodyTemplate,isV45Request,requestRoute} from '../../src/request/family.js';
import type {BlobRef} from '../../src/protocol/store.js';
import type {Request} from '../../src/request/family.js';
import {canonical} from '../../src/protocol/json.js';
/** These are inert provenance, never an executable review, token or provider envelope. */
export function requestAssetIds(r:Request):string[]{const value=r as Request&{source?:{assetId:string}|null;mask?:{assetId:string}|null;references?:{assetId:string}[];preparedInputs?:{assetId:string}|null;adapters?:{version:string}[]};return [...new Set([...(value.source?[value.source.assetId]:[]),...(value.mask?[value.mask.assetId]:[]),...(value.references??[]).map(a=>a.assetId),...(value.preparedInputs?[value.preparedInputs.assetId]:[]),...(value.adapters??[]).map(a=>a.version)])];}
export function frozenRequest(r:any):asserts r is Request{
 if(r&&isV45Request(r)){validateV45Request(r);return;}
 ok(r&&operations.includes(r.kind));const edit=r.kind.startsWith('transform')||r.kind.startsWith('inpaint'),masked=r.kind.startsWith('inpaint'),adapters=r.kind.endsWith('adapters'),regular=!['instant','fast'].includes(r.kind);
 keys(r,['kind','settings','size',...(edit?['source','strength']:[]),...(masked?['mask']:[]),...(adapters?['adapters']:[])]);const s=r.settings;keys(s,['prompt','syncMode','safetyChecker','seed','count','format','expansion',...(r.kind!=='instant'?['speed']:[]),...(regular?['acceleration']:[])]);
 ok(s.syncMode===false&&s.safetyChecker===true&&[1,2,3,4].includes(s.count)&&['png','jpeg'].includes(s.format)&&['None','Medium',...(regular?['Large']:[])].includes(s.expansion));if(r.kind!=='instant')ok(['TURBO','BALANCED','QUALITY'].includes(s.speed));if(regular)ok(['none','low','regular','high'].includes(s.acceleration));keys(s.seed,s.seed?.kind==='integer'?['kind','decimal']:['kind']);ok(s.seed.kind==='provider-random'||s.seed.kind==='integer'&&typeof s.seed.decimal==='string'&&/^-?(0|[1-9][0-9]*)$/.test(s.seed.decimal));
 if(r.size?.kind==='custom'){keys(r.size,['kind','width','height']);ok([r.size.width,r.size.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)&&r.size.width*r.size.height<=25000000);}else if(r.size?.kind==='preset'){keys(r.size,['kind','value']);ok(presets.includes(r.size.value));}else{keys(r.size,['kind']);ok(edit&&r.size.kind==='auto');}
 if(edit)ok(typeof r.strength==='number'&&Number.isFinite(r.strength)&&r.strength>=0&&r.strength<=1);const d=newDraft(s.prompt?.text);d.operation=r.kind;d.prompt=s.prompt;d.source=edit?r.source:null;d.mask=masked?r.mask:null;d.adapters=adapters?r.adapters:[];draftShape(d);if(adapters)ok(r.adapters.length>0&&r.adapters.length<=3&&new Set(r.adapters.map((a:any)=>a.version)).size===r.adapters.length&&r.adapters.every((a:any)=>a.scale.trim()!==''&&Number.isFinite(Number(a.scale))&&Number(a.scale)>=0&&Number(a.scale)<=4));
}
export function portableRequestRecord(r:any){
 if(Object.hasOwn(r,'textTreatment')){validateRequestTextTreatmentEnvelope(r.textTreatment);const {textTreatment,...base}=r;portableRequestRecord(base);return;}
 if(r?.specification&&isV45Request(r.specification)){
  keys(r,['endpoint','prompt','seed','specification','assetBindings','template','providerReview']);validateV45Request(r.specification);blob(r.prompt);blob(r.template);
  const seed=requestSeed(r.specification);ok(r.endpoint===requestRoute(r.specification).endpoint&&canonical(r.prompt)===canonical(requestPrompt(r.specification).text)&&r.seed===(seed.kind==='integer'?seed.decimal:null)&&r.template.mediaType==='application/json'&&BigInt(r.template.byteLength)<=16777216n&&canonical(r.providerReview)===canonical(providerReviewV45(r.specification)));
  keys(r.assetBindings,requestAssetIds(r.specification));ok(Object.values(r.assetBindings).every(id));return;
 }
 const full=Object.hasOwn(r,'specification');keys(r,['endpoint','prompt','seed',...(full?['specification','assetBindings']:[])]);blob(r.prompt);ok(r.prompt.mediaType==='text/plain'&&/^ideogram\/v4(?:\/[a-z-]+)*$/.test(r.endpoint)&&(r.seed===null||typeof r.seed==='string'&&/^-?(0|[1-9][0-9]*)$/.test(r.seed)));
 if(full){frozenRequest(r.specification);ok(r.endpoint===routes[r.specification.kind as Operation].endpoint&&canonical(r.prompt)===canonical(r.specification.settings.prompt.text)&&r.seed===(r.specification.settings.seed.kind==='integer'?r.specification.settings.seed.decimal:null));keys(r.assetBindings,requestAssetIds(r.specification));ok(Object.values(r.assetBindings).every(id));}
}

/** Reference identity alone is insufficient: copy/import authority reads the
 * exact retained prompt and local wire template, with no provider authority. */
export async function verifyPortableRequest(r:any,read:(ref:BlobRef)=>Promise<Uint8Array>,compositionTextSemantics=true):Promise<BlobRef[]>{
 portableRequestRecord(r);const retained:BlobRef[]=[];
 if(r.textTreatment){
  retained.push(...await validateTextTreatmentObservation(r.textTreatment,read,compositionTextSemantics));const plan:any=parseControlJSON(await read(r.textTreatment.plan),524288);
  ok(canonical(plan.prompt.bytes)===canonical(r.prompt)&&canonical(plan.afterSource?.source??null)===canonical(r.specification?.source??null));
  const prompt=r.specification?requestPrompt(r.specification):null;
  if(plan.prompt.mode==='composition-text'||prompt?.projection?.serializer==='composition-text-1'){
   ok(plan.prompt.mode==='composition-text'&&prompt?.projection?.serializer==='composition-text-1'&&prompt.composition!==null&&plan.prompt.projection!==null);
   ok(canonical(parseControlJSON(await read(plan.prompt.projection),524288))===canonical(prompt!.projection));
   ok(plan.inventory.composition!==null&&plan.inventory.composition.id===prompt!.composition!.id&&canonical(plan.inventory.composition.value)===canonical(prompt!.composition!.value)&&plan.inventory.composition.bindingsHash===hash(canonical(prompt!.composition!.bindings)));
  }
  const mask=r.specification?.mask;if(mask?.requestPlan)ok(!!plan.edit&&canonical(plan.edit.effectiveMask)===canonical(mask.requestPlan.effectiveMask));else ok(plan.edit===null);
 }
 if(!r.specification||!isV45Request(r.specification))return retained;
 const proven=async(ref:BlobRef)=>{const bytes=await read(ref);ok(String(bytes.byteLength)===ref.byteLength&&hash(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes))===ref.hash);return bytes;};
 const promptBytes=await proven(r.prompt),prompt=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(promptBytes),frozen=requestPrompt(r.specification) as V45Prompt;
 if(frozen.projection!==null){
  ok(compositionTextSemantics,'Composition text requires portable format 12');
  const graph=parseControlJSON(await proven(frozen.composition.value),1048576);validateComposition(graph);ok(graph.id===frozen.composition.id);bindingMap(graph,frozen.composition.bindings);
  verifyCompositionTextReview(graph,frozen.projection,prompt);
  const source=await proven(frozen.projection.sourceProjection.prompt),reviewed=serialize(graph,[],{},true);
  ok(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(source)===reviewed.prompt);
  retained.push(frozen.composition.value,frozen.text,...compositionRefs(graph));
 }
 const wire=bodyTemplate(r.specification,prompt),template=await proven(r.template),encoded=new TextEncoder().encode(wire);
 ok(template.byteLength===encoded.byteLength&&template.every((byte,index)=>byte===encoded[index])&&r.template.hash===hash(wire));return retained;
}

export function candidateRecord(v:any){
 keys(v,['id','version','documentId','jobId','attemptId','requestId','outputIndex','outputIdentity','safety','state','hidden','encodedAssetId','preparedAssetId','warning']);
 ok([v.id,v.documentId,v.jobId,v.attemptId,v.requestId].every(id)&&seq(v.version)&&Number.isSafeInteger(v.outputIndex)&&v.outputIndex>=0&&/^sha256:[a-f0-9]{64}$/.test(v.outputIdentity)&&['safe','unknown','withheld'].includes(v.safety)&&['missing','received','downloaded','prepared','transfer-failed','preparation-failed','withheld'].includes(v.state)&&typeof v.hidden==='boolean');
 for(const k of ['encodedAssetId','preparedAssetId'])ok(v[k]===null||id(v[k]));
 ok(v.warning===null||typeof v.warning==='string'&&v.warning.length<=256);
 ok(v.state!=='prepared'||v.safety==='safe'&&v.encodedAssetId!==null&&v.preparedAssetId!==null);
}
export function resultRecord(v:any){
 keys(v,['id','jobId','documentId','requestedCount','actualCount','phase','provenance','inert','request']);ok([v.id,v.jobId,v.documentId].every(id)&&Number.isSafeInteger(v.requestedCount)&&v.requestedCount>0&&v.requestedCount<=4&&(v.actualCount===null||Number.isSafeInteger(v.actualCount)&&v.actualCount>=0)&&['queued','running','completed','failed','quarantined'].includes(v.phase)&&v.inert===true);
 portableRequestRecord(v.request);if(v.request.specification&&isV45Request(v.request.specification)){ok(v.requestedCount===requestCount(v.request.specification));if(v.provenance!==null){v45ProvenanceRecord(v.provenance);ok(canonical(v.provenance.requestedPrompt)===canonical(v.request.prompt)&&canonical(v.provenance.submittedPrompt)===canonical(v.request.prompt)&&v.provenance.requestedSeed===v.request.seed);if(v.provenance.availability.resultContract==='valid')ok(v.actualCount!==null&&v.provenance.returnedSeed!==null&&v.phase==='completed');}else ok(v.actualCount===null&&['queued','running','failed'].includes(v.phase));return;}
 const p=v.provenance;if(p===null)return;keys(p,['requestedPrompt','submittedPrompt','returnedPrompt','returnedBytes','complete','quarantined','inspection','warning','requestedSeed','returnedSeed','timings','timingUnits','sourceBodyHash','privacyPolicy']);
 for(const k of ['requestedPrompt','submittedPrompt','privacyPolicy'])blob(p[k]);if(p.returnedPrompt)blob(p.returnedPrompt);
 ok(seq(p.returnedBytes)&&typeof p.complete==='boolean'&&typeof p.quarantined==='boolean'&&['supported','opaque','unavailable'].includes(p.inspection)&&[null,'missing-prompt','malformed-envelope'].includes(p.warning)&&p.timingUnits==='unknown'&&/^sha256:[a-f0-9]{64}$/.test(p.sourceBodyHash));
 for(const k of ['requestedSeed','returnedSeed'])ok(p[k]===null||typeof p[k]==='string'&&/^-?(0|[1-9][0-9]*)$/.test(p[k]));
 ok(p.timings&&typeof p.timings==='object'&&!Array.isArray(p.timings));for(const [k,n]of Object.entries(p.timings))ok(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)&&typeof n==='number'&&Number.isFinite(n)&&n>=0);
}

/** Called only at typed record or generated-metadata boundaries, never on raw authored JSON. */
export function requiresV45Format(value:any):boolean {
 return value?.schemaVersion===2&&value?.responseProfile==='ideogram-v45-result-1'||value&&['generate-v45','transform-v45','inpaint-v45','request-draft-v45-1','request-review-v45-1','provider-review-v45-1','v45-edit-inputs-1','v45-edit-mask-v1'].includes(value.kind)||value?.format==='straight-srgb-rgba8'&&['v45-edit-inputs-1','v45-edit-mask-v1'].includes(value.plan?.kind)||!!value?.request?.specification&&isV45Request(value.request.specification)||value?.kind==='adopted-candidate-lineage-1'&&!!value?.result?.request?.specification&&isV45Request(value.result.request.specification);

}

/** Endpoint metadata observations do not imply image admission or portable completeness. */
export function v45ProvenanceRecord(p:any):void {
 keys(p,['requestedPrompt','submittedPrompt','returnedPrompt','returnedBytes','complete','quarantined','inspection','warning','requestedSeed','returnedSeed','timings','timingUnits','sourceBodyHash','privacyPolicy','schemaVersion','responseProfile','availability']);
 for(const key of ['requestedPrompt','submittedPrompt','privacyPolicy'])blob(p[key]);
 const a=p.availability;keys(a,['returnedPrompt','timings','safety','providerDimensions','measuredImageMetadata','provenance','resultContract']);
 ok(p.schemaVersion===2&&p.responseProfile==='ideogram-v45-result-1'&&p.returnedPrompt===null&&p.returnedBytes==='0'&&p.complete===false&&p.inspection==='unavailable'&&p.timings===null&&p.timingUnits===null);
 ok(a.returnedPrompt==='unavailable-by-contract'&&a.timings==='unavailable-by-contract'&&a.safety==='unavailable-by-contract'&&a.providerDimensions==='unavailable-by-contract'&&a.measuredImageMetadata==='unavailable-while-withheld'&&a.provenance==='partial-metadata-unavailable'&&['valid','invalid'].includes(a.resultContract));
 ok(p.quarantined===(a.resultContract==='invalid')&&p.warning===(a.resultContract==='valid'?'provider-metadata-unavailable':'malformed-envelope')&&/^sha256:[a-f0-9]{64}$/.test(p.sourceBodyHash));
 for(const key of ['requestedSeed','returnedSeed'])ok(p[key]===null||typeof p[key]==='string'&&/^-?(0|[1-9][0-9]*)$/.test(p[key]));
}

/** At typed request/observation boundaries only. Authored text and opaque JSON
 * leaves never receive semantics merely because they contain this spelling. */
export function requiresCompositionTextFormat(value:any):boolean {
 const prompt=value?.kind==='request-draft-v45-1'?value.prompt:
  value&&['generate-v45','transform-v45','inpaint-v45'].includes(value.kind)?value.settings?.prompt:
  value?.request?.specification?.settings?.prompt??value?.result?.request?.specification?.settings?.prompt;
 return prompt?.projection?.serializer==='composition-text-1'||value?.kind==='text-treatment-plan-1'&&value.prompt?.mode==='composition-text'||value?.serializer==='composition-text-1';
}

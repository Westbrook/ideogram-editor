import * as v4 from './core.js';
import {newV45EditFields,resolveV45Edit,V45EditContractError} from './v45-edit.js';
import type {V45EditFields,V45EditRequest as ModelRequest,V45EditOperation} from './v45-edit.js';
import type {V45Prompt} from './v45-prompt.js';
import {v45PromptShape,v45PromptRefs} from './v45-prompt.js';
import type {V45PreparedRaster,V45PreparedBlack} from '../protocol/v45-inputs.js';
import {v45PreparedRaster,v45PreparedBlack} from '../protocol/v45-inputs.js';
import type {BlobRef} from '../protocol/store.js';
import {blob,id,seq,keys,requireValue as ok} from '../protocol/validate.js';
import {canonical} from '../protocol/json.js';

export type V45PreparedInputs={assetId:string;version:string;manifest:BlobRef;source:V45PreparedRaster;mask:V45PreparedBlack|null;references:V45PreparedRaster[]};
export type V45EditDraft={schemaVersion:1;kind:'request-draft-v45-1';operation:V45EditOperation;fields:V45EditFields;prompt:V45Prompt;guidanceAcknowledged:boolean;rewriteAcknowledged:boolean;destination:'retained-candidates';privacy:'minimum-retention-unqualified';textTreatment:'preserve-native';source:v4.Source|null;mask:v4.Mask|null;references:v4.Source[];preparedInputs:V45PreparedInputs|null;conversion:null;requestMaskDraft?:v4.RequestMaskDraft};
export type V45EditModel=Omit<ModelRequest,'body'|'seed'|'source'|'mask'|'references'>&{body:Omit<ModelRequest['body'],'prompt'|'image_url'|'mask_url'|'reference_image_urls'>};
type EditEnvelope={modelRequest:V45EditModel;settings:{prompt:V45Prompt;count:1|2|3|4;seed:v4.Seed};source:v4.Source;references:v4.Source[];preparedInputs:V45PreparedInputs};
export type V45EditRequest=EditEnvelope&({kind:'transform-v45'}|{kind:'inpaint-v45';mask:v4.Mask});
function fail(field:string,code:string,message:string):never{throw new v4.RequestError([{field,code,message}]);}
const modelError=(error:unknown):never=>{if(error instanceof V45EditContractError)return fail(error.field,error.code,error.message);throw error;};
export function newV45EditDraft(text:BlobRef,operation:V45EditOperation,mode:V45Prompt['mode']='plain'):V45EditDraft {
 const result:V45EditDraft={schemaVersion:1,kind:'request-draft-v45-1',operation,fields:newV45EditFields(operation),prompt:{mode,text:structuredClone(text),projection:null,composition:null},guidanceAcknowledged:false,rewriteAcknowledged:false,destination:'retained-candidates',privacy:'minimum-retention-unqualified',textTreatment:'preserve-native',source:null,mask:null,references:[],preparedInputs:null,conversion:null};v45EditDraftShape(result);return result;
}
function originalShape(prompt:V45Prompt,source:v4.Source|null,mask:v4.Mask|null,form?:v4.RequestMaskDraft){
 const probe=v4.newDraft(prompt.text);probe.source=source;probe.mask=mask;if(form!==undefined)probe.requestMaskDraft=form;v4.draftShape(probe);
}
export function preparedInputsShape(value:any):asserts value is V45PreparedInputs {
 keys(value,['assetId','version','manifest','source','mask','references']);ok(id(value.assetId)&&seq(value.version));blob(value.manifest);ok(value.manifest.mediaType==='application/json'&&BigInt(value.manifest.byteLength)<=65536n);v45PreparedRaster(value.source);ok(canonical(value.source.manifest)===canonical(value.manifest));if(value.mask!==null)v45PreparedBlack(value.mask);ok(Array.isArray(value.references)&&value.references.length<=4);value.references.forEach(v45PreparedRaster);
}
export function v45EditDraftShape(value:any):asserts value is V45EditDraft {
 keys(value,['schemaVersion','kind','operation','fields','prompt','guidanceAcknowledged','rewriteAcknowledged','destination','privacy','textTreatment','source','mask','references','preparedInputs','conversion',...(Object.hasOwn(value,'requestMaskDraft')?['requestMaskDraft']:[])]);
 ok(value.schemaVersion===1&&value.kind==='request-draft-v45-1'&&['transform-v45','inpaint-v45'].includes(value.operation));keys(value.fields,Object.keys(newV45EditFields(value.operation)));ok(Object.values(value.fields).every(v=>typeof v==='string'&&v.length<=16384));
 v45PromptShape(value.prompt);originalShape(value.prompt,value.source,value.mask,value.requestMaskDraft);
 ok(typeof value.guidanceAcknowledged==='boolean'&&typeof value.rewriteAcknowledged==='boolean'&&value.destination==='retained-candidates'&&value.privacy==='minimum-retention-unqualified'&&value.textTreatment==='preserve-native'&&value.conversion===null&&Array.isArray(value.references)&&value.references.length<=16);
 for(const source of value.references)originalShape(value.prompt,source,null);if(value.preparedInputs!==null)preparedInputsShape(value.preparedInputs);
}
function snapshot(request:ModelRequest):V45EditModel {
 const {seed,source,mask,references,body,...identity}=request,{prompt,image_url,mask_url,reference_image_urls,...fields}=body;return {...identity,body:fields};
}
function fields(request:V45EditRequest):V45EditFields {const model=request.modelRequest,b=model.body;return {precision:b.edit_precision,quality:b.quality,count:String(b.num_images),seed:request.settings.seed.kind==='integer'?request.settings.seed.decimal:'',size:typeof b.image_size==='string'?b.image_size:'custom',width:typeof b.image_size==='object'?String(b.image_size.width):String(model.requested.width),height:typeof b.image_size==='object'?String(b.image_size.height):String(model.requested.height)};}
function model(request:V45EditRequest,prompt:string):ModelRequest {
 return resolveV45Edit({operation:request.kind,prompt,promptMode:request.settings.prompt.mode,fields:fields(request),source:request.preparedInputs.source,mask:request.preparedInputs.mask,references:request.preparedInputs.references});
}
function alignment(request:V45EditRequest){
 if(request.references.length!==request.preparedInputs.references.length)fail('references','V45_REFERENCE_INPUTS_CHANGED','Prepare these exact ordered references again.');
 for(const [index,original]of request.references.entries()){const prepared=request.preparedInputs.references[index]!;if(prepared.width!==original.width||prepared.height!==original.height||canonical(prepared.pixels)!==canonical(original.pixels))fail('references','V45_REFERENCE_INPUTS_CHANGED','Prepare these exact ordered reference grids again.');}
 if(request.kind==='inpaint-v45'){
  if(request.mask.empty)fail('mask','EMPTY_MASK','Nothing is selected to edit.');if(request.mask.full&&!request.mask.fullAcknowledged)fail('mask','FULL_MASK','Confirm that the entire source can change.');
  const plan=v4.requireRequestMaskPlan(request.source,request.mask);v4.requireMaskAlignment(request.source,request.mask);
  if(plan.expectedOutput.width!==request.modelRequest.requested.width||plan.expectedOutput.height!==request.modelRequest.requested.height)fail('size','MASK_MAPPING_REVIEW_REQUIRED','The approved expected output must match this auto edit input grid.');
  const grid=plan.kind==='request-raster-plan-2'?plan.requestGrid:plan.expectedOutput;
  if(!request.preparedInputs.mask||grid.width!==request.preparedInputs.source.width||grid.height!==request.preparedInputs.source.height)fail('mask','V45_MASK_INPUTS_CHANGED','Prepare the exact approved source and binary edit mask.');
 }else if(request.preparedInputs.mask!==null||request.preparedInputs.source.width!==request.source.width||request.preparedInputs.source.height!==request.source.height||canonical(request.preparedInputs.source.pixels)!==canonical(request.source.pixels))fail('source','V45_SOURCE_INPUTS_CHANGED','Prepare the exact captured source grid.');
}
export function resolveV45EditDraft(draft:V45EditDraft,prompt:string):V45EditRequest {
 v45EditDraftShape(draft);
 if(new TextEncoder().encode(prompt).byteLength!==Number(draft.prompt.text.byteLength)||v4.hash(prompt)!==draft.prompt.text.hash)fail('prompt','PROMPT_BYTES','The exact saved prompt bytes changed.');
 if(!prompt.trim())fail('prompt','EMPTY_PROMPT','Enter a nonempty prompt (editor policy).');if(draft.prompt.mode==='raw'&&!draft.guidanceAcknowledged)fail('prompt','OPAQUE_ACK','Acknowledge that exact raw text is not a validated caption profile.');
 if(!draft.source)fail('source','SOURCE_REQUIRED','Capture one exact rendered source.');if(!draft.preparedInputs)fail('source','V45_INPUTS_REVIEW_REQUIRED','Prepare and review these exact edit inputs.');
 if(draft.operation==='inpaint-v45'&&!draft.mask)fail('mask','MASK_REQUIRED','Attach the approved source-bound mask.');if(draft.operation==='transform-v45'&&draft.mask!==null)fail('mask','V45_EDIT_MASK_UNEXPECTED','Choose the masked operation or explicitly remove this mask.');
 try{const pure=resolveV45Edit({operation:draft.operation,prompt,promptMode:draft.prompt.mode,fields:draft.fields,source:draft.preparedInputs.source,mask:draft.preparedInputs.mask,references:draft.preparedInputs.references});const result={kind:draft.operation,modelRequest:snapshot(pure),settings:{prompt:structuredClone(draft.prompt),count:pure.body.num_images,seed:structuredClone(pure.seed)},source:structuredClone(draft.source),references:structuredClone(draft.references),preparedInputs:structuredClone(draft.preparedInputs),...(draft.operation==='inpaint-v45'?{mask:structuredClone(draft.mask!)}:{})} as V45EditRequest;alignment(result);return result;}catch(error){return modelError(error);}
}
export function validateV45EditRequest(value:any):asserts value is V45EditRequest {
 keys(value,['kind','modelRequest','settings','source','references','preparedInputs',...(value.kind==='inpaint-v45'?['mask']:[])]);ok(['transform-v45','inpaint-v45'].includes(value.kind));keys(value.settings,['prompt','count','seed']);
 const seed=value.settings.seed;keys(seed,seed?.kind==='integer'?['kind','decimal']:['kind']);ok(seed.kind==='provider-random'||seed.kind==='integer'&&typeof seed.decimal==='string'&&seed.decimal.length<=16384&&/^-?(0|[1-9][0-9]*)$/.test(seed.decimal));
 v45PromptShape(value.settings.prompt);originalShape(value.settings.prompt,value.source,value.kind==='inpaint-v45'?value.mask:null);ok(Array.isArray(value.references)&&value.references.length<=(value.kind==='inpaint-v45'?3:4));for(const source of value.references)originalShape(value.settings.prompt,source,null);preparedInputsShape(value.preparedInputs);alignment(value);
 const rebuilt=model(value,'structural validation only');ok(canonical(snapshot(rebuilt))===canonical(value.modelRequest)&&value.settings.count===rebuilt.body.num_images&&canonical(value.settings.seed)===canonical(rebuilt.seed));
}
export function hydrateV45EditRequest(value:V45EditRequest,prompt:string):ModelRequest {
 validateV45EditRequest(value);if(new TextEncoder().encode(prompt).byteLength!==Number(value.settings.prompt.text.byteLength)||v4.hash(prompt)!==value.settings.prompt.text.hash)fail('prompt','PROMPT_BYTES','The exact retained prompt bytes changed.');if(!prompt.trim())fail('prompt','EMPTY_PROMPT','Enter a nonempty prompt (editor policy).');try{return model(value,prompt);}catch(error){return modelError(error);}
}
export function v45EditRefs(draft:V45EditDraft):BlobRef[]{
 const probe=v4.newDraft(draft.prompt.text);probe.source=draft.source;probe.mask=draft.mask;const refs=[...v45PromptRefs(draft.prompt),...v4.refs(probe).slice(1)];for(const source of draft.references)refs.push(source.blob,source.pixels,...(source.capture?[source.capture]:[]));const inputs=draft.preparedInputs;if(inputs){refs.push(inputs.manifest);for(const raster of [inputs.source,...(inputs.mask?[inputs.mask]:[]),...inputs.references])refs.push(raster.blob,raster.pixels,raster.manifest);}return refs;
}

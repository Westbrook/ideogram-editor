/** Versioned request-family boundary. The established V4 parser and bytes remain unchanged. */
import * as v4 from './core.js';
import {newV45GenerateFields,resolveV45Generate,wireV45Generate,V45ContractError,V45_GENERATION_SCHEMA} from './v45.js';
import type {V45GenerateFields,V45GenerateRequest} from './v45.js';
import {newV45EditDraft,v45EditDraftShape,resolveV45EditDraft,validateV45EditRequest,hydrateV45EditRequest,v45EditRefs} from './v45-family-edit.js';
import type {V45EditDraft,V45EditRequest} from './v45-family-edit.js';
import {V45_EDIT_SCHEMA,wireV45Edit} from './v45-edit.js';
import {v45PromptShape,v45PromptRefs} from './v45-prompt.js';
import type {V45Prompt} from './v45-prompt.js';
export type {V45Prompt} from './v45-prompt.js';
export {newV45EditDraft};
export type {V45EditDraft,V45EditRequest,V45PreparedInputs,V45EditModel} from './v45-family-edit.js';
import type {BlobRef} from '../protocol/store.js';
import {canonical} from '../protocol/json.js';
import {keys,requireValue as ok} from '../protocol/validate.js';

export {RequestError,hash,newDraft} from './core.js';
export type {Issue,Eligibility} from './core.js';
export type V4Draft=v4.Draft;
export type V4Request=v4.Request;
export type V45GenerateDraft={schemaVersion:1;kind:'request-draft-v45-1';operation:'generate-v45';fields:V45GenerateFields;prompt:V45Prompt;guidanceAcknowledged:boolean;rewriteAcknowledged:boolean;destination:'retained-candidates';privacy:'minimum-retention-unqualified';textTreatment:'preserve-native'};
export type V45GenerateModel=Omit<V45GenerateRequest,'body'|'seed'>&{body:Omit<V45GenerateRequest['body'],'prompt'>};
export type V45GenerateEnvelope={kind:'generate-v45';modelRequest:V45GenerateModel;settings:{prompt:V45Prompt;count:1|2|3|4;seed:v4.Seed}};
export type V45Draft=V45GenerateDraft|V45EditDraft;
export type V45Request=V45GenerateEnvelope|V45EditRequest;
export type Draft=V4Draft|V45Draft;
export type Request=V4Request|V45Request;
export const operations=[...v4.operations,'generate-v45','transform-v45','inpaint-v45'] as const;
export type Operation=typeof operations[number];
export const labels=[...v4.labels,'Generate with Ideogram v4.5','Transform with Ideogram v4.5','Edit masked region with Ideogram v4.5'];
export const routes={...v4.routes,'generate-v45':{endpoint:'ideogram/v4.5',schemaHash:V45_GENERATION_SCHEMA},'transform-v45':{endpoint:'ideogram/v4.5/edit',schemaHash:V45_EDIT_SCHEMA},'inpaint-v45':{endpoint:'ideogram/v4.5/edit',schemaHash:V45_EDIT_SCHEMA}};
export const isV45Draft=(draft:Draft):draft is V45Draft=>draft.kind==='request-draft-v45-1';
export const isV45Request=(request:Request):request is V45Request=>['generate-v45','transform-v45','inpaint-v45'].includes(request.kind);

export function newV45Draft(text:BlobRef,mode:V45Prompt['mode']='plain'):V45GenerateDraft {
 const value:V45GenerateDraft={schemaVersion:1,kind:'request-draft-v45-1',operation:'generate-v45',fields:newV45GenerateFields(),prompt:{mode,text:structuredClone(text),projection:null,composition:null},guidanceAcknowledged:false,rewriteAcknowledged:false,destination:'retained-candidates',privacy:'minimum-retention-unqualified',textTreatment:'preserve-native'};
 draftShape(value);return value;
}
export function draftShape(value:any):asserts value is Draft {
 if(value?.kind==='request-draft-1'){v4.draftShape(value);return;}
 if(value?.kind==='request-draft-v45-1'&&['transform-v45','inpaint-v45'].includes(value.operation)){v45EditDraftShape(value);return;}
 keys(value,['schemaVersion','kind','operation','fields','prompt','guidanceAcknowledged','rewriteAcknowledged','destination','privacy','textTreatment']);
 ok(value.schemaVersion===1&&value.kind==='request-draft-v45-1'&&value.operation==='generate-v45');
 keys(value.fields,Object.keys(newV45GenerateFields()));ok(Object.values(value.fields).every(v=>typeof v==='string'&&v.length<=16384));v45PromptShape(value.prompt);
 ok(typeof value.guidanceAcknowledged==='boolean'&&typeof value.rewriteAcknowledged==='boolean'&&value.destination==='retained-candidates'&&value.privacy==='minimum-retention-unqualified'&&value.textTreatment==='preserve-native');
}
export function refs(draft:Draft):BlobRef[]{draftShape(draft);return isV45Draft(draft)?draft.operation==='generate-v45'?v45PromptRefs(draft.prompt):v45EditRefs(draft):v4.refs(draft);}
export function adapters(draft:Draft):v4.Adapter[]{return isV45Draft(draft)?[]:draft.adapters;}
function reject(field:string,code:string,message:string):never {throw new v4.RequestError([{field,code,message}]);}
function contractError(error:unknown):never {if(error instanceof V45ContractError)return reject(error.field,error.code,error.message);throw error;}
export function resolve(draft:Draft,prompt:string,eligible:v4.Eligibility={adapters:new Map()}):Request {
 draftShape(draft);if(!isV45Draft(draft))return v4.resolve(draft,prompt,eligible);if(draft.operation!=='generate-v45')return resolveV45EditDraft(draft,prompt);
 if(new TextEncoder().encode(prompt).byteLength!==Number(draft.prompt.text.byteLength)||v4.hash(prompt)!==draft.prompt.text.hash)return reject('prompt','PROMPT_BYTES','The exact saved prompt bytes changed.');
 if(!prompt.trim())return reject('prompt','EMPTY_PROMPT','Enter a nonempty prompt (editor policy).');
 if(draft.prompt.mode==='raw'&&!draft.guidanceAcknowledged)return reject('prompt','OPAQUE_ACK','Acknowledge that exact raw text is not a validated caption profile.');
 if(draft.prompt.mode==='raw'&&draft.fields.promptExpansion==='enabled'&&!draft.rewriteAcknowledged)return reject('promptExpansion','REWRITE_ACK','Acknowledge that expansion can rewrite lettering, layout and content.');
 try {const modelRequest=resolveV45Generate({operation:draft.operation,prompt,promptMode:draft.prompt.mode,fields:draft.fields});return {kind:'generate-v45',modelRequest:modelSnapshot(modelRequest),settings:{prompt:structuredClone(draft.prompt),count:modelRequest.body.num_images,seed:structuredClone(modelRequest.seed)}};}catch(error){return contractError(error);}
}
/** Prompt bytes and the exact seed have one persisted owner, separate from model settings. */
function modelSnapshot(model:V45GenerateRequest):V45GenerateModel {
 const {seed,body,...identity}=model,{prompt,...fields}=body;return {...identity,body:fields};
}
function modelFields(model:V45GenerateModel,seed:v4.Seed):V45GenerateFields {
 return {quality:model.body.quality,promptExpansion:model.body.enable_prompt_expansion?'enabled':'disabled',count:String(model.body.num_images),seed:seed.kind==='integer'?seed.decimal:'',size:typeof model.body.image_size==='string'?model.body.image_size:'custom',width:String(model.requested.width),height:String(model.requested.height)};
}
/** Structural identity only. Authority requires hydrateV45Request with proven prompt bytes. */
export function validateV45Request(value:any):asserts value is V45Request {
 if(value?.kind==='transform-v45'||value?.kind==='inpaint-v45'){validateV45EditRequest(value);return;}
 keys(value,['kind','modelRequest','settings']);ok(value.kind==='generate-v45');keys(value.settings,['prompt','count','seed']);v45PromptShape(value.settings.prompt);
 const model=value.modelRequest,seed=value.settings.seed;keys(seed,seed?.kind==='integer'?['kind','decimal']:['kind']);ok(seed.kind==='provider-random'||seed.kind==='integer'&&typeof seed.decimal==='string'&&seed.decimal.length<=16384&&/^-?(0|[1-9][0-9]*)$/.test(seed.decimal));
 keys(model,['kind','contract','endpoint','schemaHash','requested','promptMode','body','outputFormat','safetyAdmission','estimate']);keys(model.body,['image_size','quality','enable_prompt_expansion','num_images','sync_mode']);
 const fields=modelFields(model,seed);ok(Object.values(fields).every(v=>typeof v==='string'&&v.length<=16384));
 const rebuilt=resolveV45Generate({operation:'generate-v45',prompt:'structural validation only',promptMode:value.settings.prompt.mode,fields});
 ok(canonical(model)===canonical(modelSnapshot(rebuilt))&&value.settings.count===rebuilt.body.num_images&&canonical(seed)===canonical(rebuilt.seed));
}
export function hydrateV45Request(value:V45Request,prompt:string):V45GenerateRequest|import('./v45-edit.js').V45EditRequest {
 validateV45Request(value);if(value.kind!=='generate-v45')return hydrateV45EditRequest(value,prompt);
 if(new TextEncoder().encode(prompt).byteLength!==Number(value.settings.prompt.text.byteLength)||v4.hash(prompt)!==value.settings.prompt.text.hash)return reject('prompt','PROMPT_BYTES','The exact retained prompt bytes changed.');
 if(!prompt.trim())return reject('prompt','EMPTY_PROMPT','Enter a nonempty prompt (editor policy).');
 try{const model=resolveV45Generate({operation:'generate-v45',prompt,promptMode:value.settings.prompt.mode,fields:modelFields(value.modelRequest,value.settings.seed)});ok(canonical(modelSnapshot(model))===canonical(value.modelRequest));return model;}catch(error){return contractError(error);}
}
export function bodyTemplate(request:Request,prompt:string):string {
 if(!isV45Request(request))return v4.bodyTemplate(request,prompt);const model=hydrateV45Request(request,prompt);return model.kind==='generate-v45'?wireV45Generate(model):wireV45Edit(model);
}
export function estimate(request:Request){return isV45Request(request)?structuredClone(request.modelRequest.estimate):v4.estimate(request);}
export function requestCount(request:Request){return request.settings.count;}
export function requestSeed(request:Request){return request.settings.seed;}
export function requestPrompt(request:Request){return request.settings.prompt;}
export function requestRoute(request:Request){return routes[request.kind];}
export function requestAdapters(request:Request):v4.Adapter[]{return 'adapters' in request?request.adapters:[];}

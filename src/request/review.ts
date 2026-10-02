import {validateRequestTextTreatmentEnvelope,type RequestTextTreatmentEnvelope} from './text-treatment.js';
import type {BlobRef} from '../protocol/store.js';
import type {Request as V4Request,Draft as V4Draft} from './core.js';
import {hash} from './core.js';
import type {DraftFence} from '../protocol/history.js';
import type {estimate as v4Estimate} from './core.js';
import type {V45Request} from './family.js';
import {validateV45Request,requestRoute,bodyTemplate} from './family.js';
import {canonical} from '../protocol/json.js';
import {blob,keys,id,seq,requireValue as ok} from '../protocol/validate.js';

/** The legacy shape is unchanged, including the absence of any v4.5 profile fields. */
export type RequestReviewV4={kind:'request-review-1';id:string;token:string;owner:string;draft:DraftFence;draftAsset:string;documentId:string;documentRevision:string;request:V4Request;endpoint:string;schemaHash:string;routeHash:string;dependencyHash:string;template:BlobRef;prompt:BlobRef;conversion:V4Draft['conversion'];inactive:V4Draft['inactive'];destination:'retained-candidates';privacy:'minimum-retention-unqualified';estimate:ReturnType<typeof v4Estimate>;dispatch:false};
export const V45_ADMISSION=Object.freeze({policy:'unknown-withheld-1',state:'blocked',reason:'provider-safety-evidence-unavailable',ordinaryDisplay:false,adoption:false,export:false} as const);
export type ProviderReviewV45={kind:'provider-review-v45-1';requestContract:string;resultContract:'ideogram-v45-result-1';schemaHash:string;admission:typeof V45_ADMISSION;admissionHash:string;privacyProfile:null;dispatch:false};
export type RequestReviewV45=Omit<RequestReviewV4,'kind'|'request'|'conversion'|'inactive'|'estimate'>&{kind:'request-review-v45-1';request:V45Request;conversion:null;inactive:Record<string,never>;estimate:V45Request['modelRequest']['estimate'];providerReview:ProviderReviewV45};
export type BaseRequestReview=RequestReviewV4|RequestReviewV45;
type TextReview<T extends BaseRequestReview> = Omit<T,'kind'|'token'> & {kind:'request-review-text-1';baseKind:T['kind'];baseToken:string;token:string;textTreatment:RequestTextTreatmentEnvelope};
export type RequestReviewText=TextReview<RequestReviewV4>|TextReview<RequestReviewV45>;
export type RequestReview=BaseRequestReview|RequestReviewText;
/** A flat adjunct preserves the exact original review token and provider family. */
export function baseRequestReview(review:RequestReview):BaseRequestReview {
 if(review.kind!=='request-review-text-1')return review;
 const {kind,baseKind,baseToken,token,textTreatment,...fields}=review;
 ok(['request-review-1','request-review-v45-1'].includes(baseKind));validateRequestTextTreatmentEnvelope(textTreatment);
 ok(hash(canonical({kind,baseKind,baseToken,textTreatment,...fields}))===token);
 const base={...fields,kind:baseKind,token:baseToken} as BaseRequestReview;
 const {token:prior,...binding}=base;ok(hash(canonical(binding))===prior);
 if(base.kind==='request-review-v45-1')validateRequestReviewV45Identity(base);
 return base;
}
export function reviewFamily(review:RequestReview):'v4'|'v45'{return baseRequestReview(review).kind==='request-review-v45-1'?'v45':'v4';}
export function bindRequestTextTreatment(review:BaseRequestReview,textTreatment:RequestTextTreatmentEnvelope):RequestReviewText {
 validateRequestTextTreatmentEnvelope(textTreatment);const {kind,token,...fields}=review;
 const value={...fields,kind:'request-review-text-1' as const,baseKind:kind,baseToken:token,textTreatment};
 const result={...value,token:hash(canonical(value))} as RequestReviewText;ok(new TextEncoder().encode(canonical(result)).byteLength<=60000);baseRequestReview(result);return result;
}


export function providerReviewV45(request:V45Request):ProviderReviewV45 {
 validateV45Request(request);
 return {kind:'provider-review-v45-1',requestContract:request.modelRequest.contract,resultContract:'ideogram-v45-result-1',schemaHash:request.modelRequest.schemaHash,admission:structuredClone(V45_ADMISSION),admissionHash:hash(canonical(V45_ADMISSION)),privacyProfile:null,dispatch:false};
}
/** Persisted review identity is validated before any queue/profile authority is considered. */
export function validateRequestReviewV45Identity(value:any):asserts value is RequestReviewV45 {
 keys(value,['kind','id','token','owner','draft','draftAsset','documentId','documentRevision','request','endpoint','schemaHash','routeHash','dependencyHash','template','prompt','conversion','inactive','destination','privacy','estimate','dispatch','providerReview']);
 ok(value.kind==='request-review-v45-1'&&id(value.id)&&id(value.draftAsset)&&id(value.documentId)&&seq(value.documentRevision));
 keys(value.draft,['sessionId','draftId','generation']);ok(id(value.draft.sessionId)&&id(value.draft.draftId)&&seq(value.draft.generation));
 const digest=(v:unknown)=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);ok([value.token,value.owner,value.routeHash,value.dependencyHash].every(digest));
 validateV45Request(value.request);blob(value.template);blob(value.prompt);const route=requestRoute(value.request);
 ok(value.template.mediaType==='application/json'&&BigInt(value.template.byteLength)<=16777216n&&canonical(value.prompt)===canonical(value.request.settings.prompt.text)&&value.endpoint===route.endpoint&&value.schemaHash===route.schemaHash&&value.routeHash===hash(canonical(route)));
 keys(value.inactive,[]);ok(value.conversion===null&&value.destination==='retained-candidates'&&value.privacy==='minimum-retention-unqualified'&&value.dispatch===false&&canonical(value.estimate)===canonical(value.request.modelRequest.estimate)&&canonical(value.providerReview)===canonical(providerReviewV45(value.request)));
 const {token,...binding}=value;ok(token===hash(canonical(binding))&&new TextEncoder().encode(canonical(value)).byteLength<=60000);
}

/** Required at writer/queue/import authority boundaries, after exact prompt bytes are read. */
export function verifyRequestReviewV45(value:any,prompt:string):asserts value is RequestReviewV45 {
 validateRequestReviewV45Identity(value);const wire=bodyTemplate(value.request,prompt);
 ok(value.template.hash===hash(wire)&&value.template.byteLength===String(new TextEncoder().encode(wire).byteLength));
}

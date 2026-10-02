import {createHash} from 'node:crypto';
import {canonical} from '../../src/protocol/json.js';
import type {ProviderAuthorization,ProviderPrivacyView} from '../../src/protocol/provider.js';
import type {RequestReview} from '../../src/request/review.js';
import {baseRequestReview,validateRequestReviewV45Identity} from '../../src/request/review.js';
import {ProviderConfigurationError} from './config.js';
import type {PrivacyProfile,PolicyAcknowledgement} from './policy.js';
import {V45_EVIDENCE_DIGEST} from './v45-profile.js';

const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function freeze<const T extends object>(value:T):Readonly<T>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value);}
/** Concrete requested fallback for review. Not registered in the production factory.
 * Its identity does not resolve safety, establish partner retention, or confer
 * authority on a request-review-v45-1 whose admission remains blocked. */
export const V45_GENERATION_DISCLOSURE=freeze([
 'This proposed operation sends the exact reviewed prompt to Fal and its Ideogram partner. It requests one medium-quality square_hd image with the explicitly reviewed prompt-expansion setting. Output format is provider-controlled; no source, mask, reference or adapter is uploaded.',
 'The requested fallback makes output media public to anyone holding its URL and requests expiration after 3600 seconds. This is a chosen documented lifetime, not the minimum compatible lifetime or a measured deletion guarantee.',
 'Only credential-free HTTPS reads from v3b.fal.media are proposed. Other returned media hosts are refused and their bytes are not fetched. Fal documentation covers that host; a model-page example does not guarantee the host of a future result.',
 'X-Fal-Store-IO: 0 requests no persistent Fal request/result JSON history. CDN lifetime and Ideogram partner copies are separate. Partner retention and deletion, and application of these headers to partner copies, remain unknown.',
 'The v4.5 contract does not supply per-output safety verdicts. Existing policy keeps outputs unknown and withheld: protected encoded retention may occur, but decoding, ordinary viewing, adoption and export remain unavailable. A production safety policy still requires a separate explicit decision.',
 'Result JSON has a shorter retrieval window when history storage is disabled; keeping the backend running cannot guarantee successful retrieval or recovery before expiry.',
 'Each exact attempt requires independent authorization. Finite request/image limits are not a currency spending guarantee. Cancellation, disconnection and local deletion do not prove remote work stopped, charges were avoided or provider copies were deleted. Uncertain submissions are never automatically repeated.',
 'This proposal and its fixture execution do not authorize live use. V4 approvals do not transfer; a separately selected V4.5 privacy and safety contract, reviewed request, server-only credential and explicit endpoint/budget approval remain required.'
] as const);
export const V45_GENERATION_MEDIA_ORIGINS_PROPOSAL=freeze(['https://v3b.fal.media'] as const);
export const V45_GENERATION_EVIDENCE_DIGEST=digest({kind:'v45-generation-fallback-proposal-1',documentedProfileEvidence:V45_EVIDENCE_DIGEST,endpoint:'ideogram/v4.5',mediaOrigins:V45_GENERATION_MEDIA_ORIGINS_PROPOSAL,requestedStoreIO:'0',requestedExpirationSeconds:3600,requestedACL:'public',partnerRetention:'unknown',partnerDeletion:'unknown',safety:'unknown-withheld-1'});
export const V45_GENERATION_PROFILE_PROPOSAL:PrivacyProfile=freeze({
 id:'fal-v45-public-hour-proposal-20260930',version:1,evidenceDigest:V45_GENERATION_EVIDENCE_DIGEST,endpoint:'ideogram/v4.5',mode:'production',
 enforcement:'documented',lifecycleSeconds:3600,minimumCompatibleSeconds:3600,acl:'public',supportedLifetimes:[3600],supportedACLs:['public'],mostPrivateACL:'public',
 deferredFetch:'unknown',requiredLifetimeSeconds:null,renewalQualified:false,
 fallback:{id:'v45-public-hour-proposal-1',disclosureDigest:digest(V45_GENERATION_DISCLOSURE),lifecycleSeconds:3600,acl:'public'}
});
export const V45_GENERATION_PRIVACY_PROPOSAL:ProviderPrivacyView=freeze({id:V45_GENERATION_PROFILE_PROPOSAL.id,version:1,evidenceDigest:V45_GENERATION_EVIDENCE_DIGEST,disclosureDigest:digest(V45_GENERATION_DISCLOSURE),disclosure:V45_GENERATION_DISCLOSURE,requestedStoreIO:'0',expirationSeconds:3600,initialACL:'public',enforcement:'documented'});
/** The existing production policy refuses the proposal; only the ordinary
 * loopback fixture constructor can exercise its requested fallback semantics. */
export const V45_GENERATION_FIXTURE_PROFILE:PrivacyProfile=freeze({...V45_GENERATION_PROFILE_PROPOSAL,mode:'fixture'});

export type FalV45GenerationManifest=Readonly<{
 schemaVersion:2;id:string;approvedAt:string;expiresAt:string;endpoint:'ideogram/v4.5';operation:'generate-v45';
 maxRequests:number;maxImages:number;output:Readonly<{width:1024;height:1024;count:1;size:'square_hd';format:'provider-controlled'}>;
 quality:'medium';enablePromptExpansion:boolean;resultContract:'ideogram-v45-result-1';admissionPolicy:'unknown-withheld-1';
 profileId:string;profileVersion:number;evidenceDigest:string;disclosureDigest:string;acknowledgeChargeAndPrivacy:true;
}>;
/** Internal fixture channel only. config.ts never accepts this mode and no
 * environment variable, browser command or launcher can construct it. */
export type V45FixtureRuntimeConfiguration=Readonly<{mode:'fal-v45-fixture';manifest:FalV45GenerationManifest;manifestHash:string;key:string}>;
const invalid=():never=>{throw new ProviderConfigurationError();};
function exact(v:unknown,keys:readonly string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function time(v:unknown):number{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))return invalid();const n=Date.parse(v);if(!Number.isSafeInteger(n)||new Date(n).toISOString()!==v)return invalid();return n;}
export function validateV45FixtureRuntimeConfiguration(value:unknown,queueOrigin:string|undefined,now=Date.now()):V45FixtureRuntimeConfiguration {
 try{
  // Literal IPv4 loopback only, exactly matching the existing test preload.
  if(typeof queueOrigin!=='string')return invalid();const origin=new URL(queueOrigin);
  if(origin.origin!==queueOrigin||origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.username||origin.password)return invalid();
  if(!exact(value,['mode','manifest','manifestHash','key'])||value.mode!=='fal-v45-fixture'||typeof value.key!=='string'||value.key.length>4096)return invalid();
  if(!/^[\x21-\x7e]+$/.test(value.key))return invalid();
  const m=value.manifest,p=V45_GENERATION_PROFILE_PROPOSAL;
  if(!exact(m,['schemaVersion','id','approvedAt','expiresAt','endpoint','operation','maxRequests','maxImages','output','quality','enablePromptExpansion','resultContract','admissionPolicy','profileId','profileVersion','evidenceDigest','disclosureDigest','acknowledgeChargeAndPrivacy'])||m.schemaVersion!==2||typeof m.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(m.id)||!Number.isSafeInteger(now)||time(m.approvedAt)>now||time(m.approvedAt)>=time(m.expiresAt)||m.endpoint!=='ideogram/v4.5'||m.operation!=='generate-v45'||m.quality!=='medium'||typeof m.enablePromptExpansion!=='boolean'||m.resultContract!=='ideogram-v45-result-1'||m.admissionPolicy!=='unknown-withheld-1'||m.profileId!==p.id||m.profileVersion!==p.version||m.evidenceDigest!==p.evidenceDigest||m.disclosureDigest!==V45_GENERATION_PRIVACY_PROPOSAL.disclosureDigest||m.acknowledgeChargeAndPrivacy!==true)return invalid();
  if(!Number.isSafeInteger(m.maxRequests)||Number(m.maxRequests)<1||Number(m.maxRequests)>100||!Number.isSafeInteger(m.maxImages)||Number(m.maxImages)<1||Number(m.maxImages)>400)return invalid();
  const o=m.output;if(!exact(o,['width','height','count','size','format'])||o.width!==1024||o.height!==1024||o.count!==1||o.size!=='square_hd'||o.format!=='provider-controlled')return invalid();
  if(value.manifestHash!==digest(m))return invalid();
  return freeze(structuredClone(value)) as unknown as V45FixtureRuntimeConfiguration;
 }catch{return invalid();}
}
/** Identity only. The real writer/queue still verifies retained prompt/template
 * bytes and independently refuses blocked V45 authorization/reserve/dispatch. */
export function v45GenerationMatches(review:RequestReview,m:FalV45GenerationManifest):boolean {
 try{const base=baseRequestReview(review);if(base.kind!=='request-review-v45-1')return false;validateRequestReviewV45Identity(base);
  const r=base.request;if(r.kind!=='generate-v45')return false;const b=r.modelRequest.body;
  return base.endpoint===m.endpoint&&base.providerReview.resultContract===m.resultContract&&base.providerReview.admission.policy===m.admissionPolicy&&r.settings.count===1&&b.num_images===1&&b.quality===m.quality&&b.image_size==='square_hd'&&b.enable_prompt_expansion===m.enablePromptExpansion&&b.sync_mode===false;
 }catch{return false;}
}
export function v45GenerationAcknowledgement(a:ProviderAuthorization):PolicyAcknowledgement{return {id:a.id,attemptId:a.attemptId,profileId:a.profileId,profileVersion:a.profileVersion,evidenceDigest:V45_GENERATION_EVIDENCE_DIGEST,fallbackId:V45_GENERATION_PROFILE_PROPOSAL.fallback!.id,disclosureDigest:a.disclosureDigest};}

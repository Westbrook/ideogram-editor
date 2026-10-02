import {createHash} from 'node:crypto';

/**
 * V45-A1 documentation contract. This data does not implement PrivacyProfile,
 * register an endpoint, select a media origin, or construct transport headers.
 * A later qualification/policy decision requires a new version and review.
 */
function immutable<const T extends object>(value:T):Readonly<T> {
  for(const child of Object.values(value))if(child!==null&&typeof child==='object')immutable(child);
  return Object.freeze(value);
}
const digest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const V45_PROFILE_ID='fal-v45-documented-blocked-20260930' as const;
export const V45_PROFILE_EVIDENCE=immutable([
  {id:'generation-schema',url:'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4.5',
    sha256:'ac31bdbfdf982da0b49bcaa94aedaaf4d95fa9fe9491ef473c120808843def29',
    observation:'The generation schema declares images and seed; no per-image safety metadata, returned prompt, timings or dimensions.'},
  {id:'generation-guide',url:'https://fal.ai/models/ideogram/v4.5/llms.txt',
    sha256:'ed3973b02172a7cab5a7ad6dec97d6dc711ed7a884ada7082fa8bdaa9db2fb20',
    observation:'Medium quality is documented at USD 0.06 per output image, independent of size. This is an estimate source, not actual billing.'},
  {id:'generation-page',url:'https://fal.ai/models/ideogram/v4.5/api',
    sha256:'6cb20e7540a8d71fe359cddb2aa941187e63237b8a9542077c93a9d75b6253d6',
    observation:'The page labels this endpoint Partner; embedded endpoint metadata reports enterprise_status ready. Neither observation verifies runtime compliance.'},
  {id:'model-errors',url:'https://fal.ai/docs/documentation/model-apis/errors.md',
    sha256:'2718eb66505e325460502703c8be3bffe5eeecb167a1cbe61890aaa05594ab90',
    observation:'Blocked-input errors and variable partner filtering are documented; endpoint error-format migration is incomplete. Successful output filtering is not established.'},
  {id:'fal-retention',url:'https://fal.ai/docs/documentation/model-apis/media-expiration.md',
    sha256:'3e45d770f4fee31bcb0ebe4eae77485b5012a294cf4b6f2a629149cb36afd383',
    observation:'Store-IO zero concerns Fal JSON history; media expiration is separate. The 3600-second example is not an endpoint minimum.'},
  {id:'fal-platform-headers',url:'https://fal.ai/docs/documentation/model-apis/common-parameters.md',
    sha256:'9e5f2ffe10ea893fa51ffb2ce0b869fd9a690fe6657fe65b05ec925892d8ecc1',
    observation:'The platform documents lifecycle and initial ACL request syntax; no V45 partner enforcement was observed.'},
  {id:'fal-file-acl',url:'https://fal.ai/docs/documentation/model-apis/file-access-controls.md',
    sha256:'d8923299c8acaf971372879ca12bb2bf7378df00ad2f423b8219e9e61393c48a',
    observation:'Documented ACL scope names v3b.fal.media; anonymous public reads differ from authenticated or signed private delivery.'},
  {id:'fal-cdn',url:'https://fal.ai/docs/documentation/model-apis/fal-cdn.md',
    sha256:'0c60d94075fbc055cb421a918095f472b804f4e6ec31a6f7d36f468c16e65547',
    observation:'Current output URL examples name v3b.fal.media; alternate upload/fallback references do not qualify alternate output-host ACL coverage.'},
  {id:'fal-result-expiry',url:'https://fal.ai/docs/documentation/model-apis/inference/webhooks.md',
    sha256:'e8def5d04dfbdb905869644064aef5372b170857525bf534104a049ad7ea85dc',
    observation:'With payload storage disabled, result JSON has a separate short retrieval window; restart recovery is not guaranteed.'},
  {id:'fal-api-services',url:'https://fal.ai/legal/api-services',
    sha256:'e96f9faf0ebafec43623c007dbdc3ddfb38d57cb417bc46466581a048f68dc5f',
    observation:'Partner API use transfers content. Contractual use restrictions have designated exclusions; this evidence is not an upstream retention measurement.'},
  {id:'ideogram-direct-api-terms',url:'https://ideogram.ai/legal/api-tos/',
    sha256:'cd3517be739dacb5066dc17bd68a0f8bee115a2177dd3ccef55a3bed664b1957',
    observation:'Direct Ideogram API terms describe a no-training rule with a flagged-policy-content exception; the Fal partner agreement is not established by those terms.'},
  {id:'ideogram-privacy',url:'https://ideogram.ai/legal/privacy/',
    sha256:'7c96cf1e10cc3b673f59c5f99fa009d397696e504f6413a6581043bfa78ba770',
    observation:'The public policy does not establish a fixed retention period for the Fal V45 route.'}
] as const);
export const V45_EVIDENCE_DIGEST=digest(V45_PROFILE_EVIDENCE);

export const V45_PROFILE_BLOCKERS=immutable([
  {code:'provider-safety-evidence-unavailable',area:'admission',state:'unresolved',
    explanation:'V45 does not declare per-image safety metadata. Successful requests and blocked-input errors do not establish safe output. Current policy withholds unclassified images.'},
  {code:'partner-retention-unqualified',area:'privacy',state:'unresolved',
    explanation:'Fal partner processing is documented, but V45 upstream retention, deletion and application of Fal retention headers to partner copies remain unqualified.'},
  {code:'media-policy-scope-unqualified',area:'cdn',state:'unresolved',
    explanation:'The V45 output example uses v3.fal.media while ACL documentation names v3b.fal.media. Actual output hosts and corresponding lifecycle, ACL and private-delivery behavior remain unqualified.'}
] as const);

export const V45_DISCLOSURE=immutable([
  'Generate image with Ideogram v4.5 is unavailable while its safety admission and production privacy profile remain unresolved. This documented profile does not authorize a provider request.',
  'The provider contract does not supply per-image safety metadata. Successful completion does not mean an image is safe. Results remain unknown and withheld from ordinary viewing, adoption and export; existing protected encoded-byte retention is unchanged.',
  'A future request would send the reviewed prompt to Fal and its model partner. The partner badge and website enterprise-ready metadata do not verify upstream retention, deletion or runtime compliance.',
  'X-Fal-Store-IO: 0 concerns Fal request/result JSON history. Media expiration and partner processing are separate. No evidence establishes that this header controls copies held by Ideogram.',
  'The published V45 output example uses v3.fal.media; Fal ACL documentation names v3b.fal.media. No production media host, ACL or lifetime is selected by this profile. A documented one-hour lifetime example does not establish a minimum compatible lifetime or private delivery.',
  'Disabling JSON history leaves a short result-retrieval window, separate from media expiration. Restart recovery and retrieval before expiration are not qualified.',
  'The planned first request is one medium-quality square_hd image. Output format is provider-controlled. The published USD 0.06 estimate must be rechecked before any live authorization; request limits are not a currency spending guarantee.',
  'Cancellation, disconnection and local deletion do not establish that remote work stopped, charges were avoided or provider copies were deleted. Lost submission acknowledgements remain uncertain and must not cause automatic resubmission.',
  'Any later live use needs a separately qualified profile and explicit authorization bound to the v4.5 endpoint, exact review and limits. Existing v4 approvals and privacy acknowledgements do not transfer.'
] as const);
export const V45_DISCLOSURE_DIGEST=digest(V45_DISCLOSURE);

export const V45_PROFILE=immutable({
  kind:'documented-provider-contract',id:V45_PROFILE_ID,version:1,reviewedOn:'2026-09-30',
  operation:'generate-v45',endpoint:'ideogram/v4.5',operationContract:'fal-ideogram-v45-generation-1',
  resultContract:'ideogram-v45-result-1',admissionPolicy:'unknown-withheld-1',
  dispatchEligible:false,evidenceStatus:'documented-only',
  evidenceDigest:V45_EVIDENCE_DIGEST,disclosureDigest:V45_DISCLOSURE_DIGEST,
  evidence:V45_PROFILE_EVIDENCE,disclosure:V45_DISCLOSURE,blockers:V45_PROFILE_BLOCKERS,
  admission:{state:'blocked',reason:'provider-safety-evidence-unavailable',safety:'unknown',
    ordinaryDisplay:false,adoption:false,export:false,decodePreparation:false,
    protectedEncodedRetention:'unchanged-existing-policy'},
  privacy:{selectedLifetimeSeconds:null,selectedACL:null,minimumCompatibleLifetimeSeconds:null,
    upstreamRetentionSeconds:null,privateDeliveryQualified:false,headerEnforcementQualified:false,
    recoveryQualified:false,
    documentedStoreIO:{name:'X-Fal-Store-IO',value:'0',scope:'fal-json-history'},
    partner:{pageBadge:'Partner',websiteEnterpriseStatus:'ready',qualification:'unobserved'}},
  media:{selectedPolicy:null,productionHosts:[],uploadsQualified:false,
    documentedOutputExampleHosts:['v3.fal.media'],documentedACLHosts:['v3b.fal.media'],
    actualOutputHostsObserved:false},
  prospectiveMilestone:{images:1,quality:'medium',size:'square_hd',width:1024,height:1024,
    promptExpansion:'explicit-reviewed-choice',outputFormat:'provider-controlled',
    estimate:{currency:'USD',cents:6,actualCharge:null,requiresPriceRecheck:true}}
} as const);
export type V45DocumentedProfile=typeof V45_PROFILE;
export type V45ProfileBlocker=typeof V45_PROFILE_BLOCKERS[number];

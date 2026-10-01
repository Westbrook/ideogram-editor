import {createHash} from 'node:crypto';
import type {PrivacyProfile,PolicyAcknowledgement} from './policy.js';
import type {ProviderPrivacyView,ProviderAuthorization} from '../../src/protocol/provider.js';

// Exact official-document observations and unresolved variants are retained in
// tooling/provider/research/20260930-official-profile.json. No live compliance claim.
const evidenceDigest='df139839b61d1f2b684b33368a0b038f0c9f99672b761dee52e164e4c71c589f';
const disclosure=Object.freeze([
  'This sends the exact reviewed prompt to Fal Ideogram v4 and can incur charges. The request limit is not a currency spending guarantee.',
  'Minimum-retention private delivery is not qualified. This operation uses an explicitly accepted fallback: generated media is public to anyone who has its URL, with a requested expiration of 3600 seconds.',
  'X-Fal-Store-IO: 0 requests no persistent request/response JSON history. Media retention is separate. These are documented requested policies, not independently measured provider guarantees.',
  'With JSON history disabled, result JSON may remain retrievable for only about one hour after completion, or about six minutes for responses of at least 10 KB. Keep the server running to retain results promptly; restart recovery can miss this window.',
  'Local deletion does not delete provider copies. Requesting cancellation or disconnecting does not prove work stopped or establish a refund. Lost acknowledgements remain uncertain and will not be automatically resubmitted.',
  'Only Generate image at the approved dimensions and one PNG output is enabled. Sources, masks, adapters, uploads, direct streams, and alternate media hosts are not enabled by this profile.',
  'The authorization expiry prevents new submissions. Existing explicitly authorized request status, cancellation and retrieval may continue so that remote work can be reconciled and retained.'
]);
const disclosureDigest=createHash('sha256').update(JSON.stringify(disclosure)).digest('hex');
export const PRODUCTION_PROFILE:PrivacyProfile=Object.freeze({
  id:'fal-v4-public-hour-20260930',version:1,evidenceDigest,endpoint:'ideogram/v4',mode:'production',
  enforcement:'documented',lifecycleSeconds:3600,minimumCompatibleSeconds:3600,acl:'public',
  supportedLifetimes:Object.freeze([3600]),supportedACLs:Object.freeze(['public']),mostPrivateACL:'public',
  // Always require the disclosed fallback. 3600 is a chosen documented example,
  // never a measured minimum or a promise about deferred retrieval timing.
  deferredFetch:'unknown',requiredLifetimeSeconds:null,renewalQualified:false,
  fallback:Object.freeze({id:'public-hour-explicit-fallback-v1',disclosureDigest,lifecycleSeconds:3600,acl:'public'})
});
export const PRODUCTION_PRIVACY:ProviderPrivacyView=Object.freeze({
  id:PRODUCTION_PROFILE.id,version:PRODUCTION_PROFILE.version,evidenceDigest,disclosureDigest,disclosure,
  requestedStoreIO:'0',expirationSeconds:3600,initialACL:'public',enforcement:'documented'
});
export function productionAcknowledgement(authorization:ProviderAuthorization):PolicyAcknowledgement {
  return {id:authorization.id,attemptId:authorization.attemptId,profileId:authorization.profileId,
    profileVersion:authorization.profileVersion,evidenceDigest,fallbackId:PRODUCTION_PROFILE.fallback!.id,
    disclosureDigest:authorization.disclosureDigest};
}

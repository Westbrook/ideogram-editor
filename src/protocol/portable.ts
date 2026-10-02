import type { BlobRef, Document } from './store.js';
export type PortableBody =
 | {type:'SaveCopy'}
 | {type:'SaveRecoveryCopy';acknowledgementId:string}
 | {type:'PreviewBundleImport';stagingId:string;expectedSha256:string}
 | {type:'ImportBundle';reviewId:string;reviewHash:string}
 | {type:'CancelPortable';operationId:string};
export const isPortableCommand=(type:string)=>['SaveCopy','SaveRecoveryCopy','PreviewBundleImport','ImportBundle','CancelPortable'].includes(type);
export type PortableSegment={path:string;sha256:string;bytes:string;kind:'index'|'events'|'records';recordCount:string};
export type PortableRoot={kind:string;logicalId:string;recordHash:string};
export type PortableManifest={formatVersion:7|8|9|10|11|12|13;documentSchema:7|8|9|10|11|12|13;sourceNamespace:string;capturedHighWater:string;complete:boolean;recovery?:RecoveryDisclosure;rootRefs:PortableRoot[];segments:PortableSegment[]};
export type Bundle={protocolVersion:1;bundleId:string;documentId:string;documentRevision:string;capturedHighWater:string;uiDigest:string;blob:BlobRef;destinationStatus:'unconfirmed'}&({complete:true;status:'copy-ready';recovery?:never}|{complete:false;status:'recovery-copy-ready';recovery:RecoveryDisclosure});
export type BundleReview={protocolVersion:1;reviewId:string;reviewHash:string;targetClientId:string;expiresAt:string;source:BlobRef;sourceNamespace:string;capturedHighWater:string;namespaceId:string;documentId:string;closureHash:string;formatVersion:number;documentSchema:number;editable:boolean;reason:string|null;recovery?:RecoveryDisclosure;objectCount:string;entityCount:string;eventCount:string;uiSessionIds:string[];uiSessionCount:string;scope:'selected-document-current-drafts-and-retained-domain-history'|'current-document-safe-content';localRetentionExcluded:'obsolete-unattributed-ui-only'};
export type PortableFact=
 | {type:'BundlePrepared';payload:{bundle:Bundle}}
 | {type:'BundleImportReviewed';payload:{reviewId:string;reviewHash:string}}
 | {type:'BundleImported';payload:{namespaceId:string;source:BlobRef;document:Document;namespaceHash:string}}
 | {type:'PortableCancelled';payload:{operationId:string}};

export const RECOVERY_OMISSIONS=['history','checkpoints','drafts','jobs','creation-background-provenance','text-origin-provenance','request-authority','adoption-authority','backend-transport','unsafe-or-incomplete-returned-prompts','unavailable-or-unsafe-content'] as const;
export type RecoveryDisclosure={kind:'tp1-sanitized-recovery-v1';label:'Incomplete sanitized recovery copy';sanitized:true;authority:'observation-only';acknowledgementId:string;scope:'current-document-safe-content';omissions:readonly (typeof RECOVERY_OMISSIONS)[number][]};
export function recoveryDisclosure(value:unknown):asserts value is RecoveryDisclosure {
 const v=value as RecoveryDisclosure,expected=['kind','label','sanitized','authority','acknowledgementId','scope','omissions'];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==expected.length||!expected.every(k=>Object.hasOwn(v,k))||v.kind!=='tp1-sanitized-recovery-v1'||v.label!=='Incomplete sanitized recovery copy'||v.sanitized!==true||v.authority!=='observation-only'||typeof v.acknowledgementId!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(v.acknowledgementId)||v.scope!=='current-document-safe-content'||!Array.isArray(v.omissions)||v.omissions.length!==RECOVERY_OMISSIONS.length||v.omissions.some((v,i)=>v!==RECOVERY_OMISSIONS[i]))throw Error('INVALID_RECOVERY_DISCLOSURE');
}

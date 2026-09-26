import type { BlobRef, Document } from './store.js';
export type PortableBody =
 | {type:'SaveCopy'}
 | {type:'PreviewBundleImport';stagingId:string;expectedSha256:string}
 | {type:'ImportBundle';reviewId:string;reviewHash:string}
 | {type:'CancelPortable';operationId:string};
export const isPortableCommand=(type:string)=>['SaveCopy','PreviewBundleImport','ImportBundle','CancelPortable'].includes(type);
export type PortableSegment={path:string;sha256:string;bytes:string;kind:'index'|'events'|'records';recordCount:string};
export type PortableRoot={kind:string;logicalId:string;recordHash:string};
export type PortableManifest={formatVersion:2;documentSchema:2;sourceNamespace:string;capturedHighWater:string;complete:boolean;rootRefs:PortableRoot[];segments:PortableSegment[]};
export type Bundle={protocolVersion:1;bundleId:string;documentId:string;documentRevision:string;capturedHighWater:string;uiDigest:string;blob:BlobRef;complete:true;status:'copy-ready';destinationStatus:'unconfirmed'};
export type BundleReview={protocolVersion:1;reviewId:string;reviewHash:string;targetClientId:string;expiresAt:string;source:BlobRef;sourceNamespace:string;capturedHighWater:string;namespaceId:string;documentId:string;closureHash:string;formatVersion:number;documentSchema:number;editable:boolean;reason:string|null;objectCount:string;entityCount:string;eventCount:string;uiSessionIds:string[];uiSessionCount:string;scope:'selected-document-current-drafts-and-retained-domain-history';localRetentionExcluded:'obsolete-unattributed-ui-only'};
export type PortableFact=
 | {type:'BundlePrepared';payload:{bundle:Bundle}}
 | {type:'BundleImportReviewed';payload:{reviewId:string;reviewHash:string}}
 | {type:'BundleImported';payload:{namespaceId:string;source:BlobRef;document:Document;namespaceHash:string}}
 | {type:'PortableCancelled';payload:{operationId:string}};

export type DeletionBody =
 | {type:'PreviewDocumentDeletion';documentId:string;expectedRevision:string}
 | {type:'DeleteDocument';documentId:string;planId:string;planHash:string;expectedRevision:string;rootGeneration:string;acknowledgeRunningAndUncertain:boolean}
 | {type:'CollectDocumentGarbage';documentId:string};
export type DeletionPlan={id:string;documentId:string;documentRevision:string;rootGeneration:string;planHash:string;exclusiveBytes:string;retainedBytes:string;pendingBytes:string;histories:number;checkpoints:number;drafts:number;jobs:number;unresolvedAttempts:string[];retainedRoots:string[];externalCopies:'not-erased';irreversible:true};
export type DeletionReceipt={documentId:string;planId:string;accepted:true;status:'cleanup-pending'|'cleanup-complete';estimatedEligibleBytes:string;retainedBytes:string;actualFreedBytes:string;pendingBytes:string;generation:string};

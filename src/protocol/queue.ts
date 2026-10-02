import {reviewFamily} from '../request/review.js';
import type {BlobRef} from './store.js';
import type {RequestReview} from '../request/review.js';
import type {ProviderAuthorization,ProviderAuthorizationBody} from './provider.js';
// This is only model admission, never authority to dispatch. V4 still needs
// its existing per-attempt provider profile/epoch/privacy authorization.
export function queueModelAdmission(review:RequestReview):'provider-profile-required'|'blocked-unavailable-evidence'{
 return reviewFamily(review)==='v4'?'provider-profile-required':'blocked-unavailable-evidence';
}
export type QueueBody = import('./candidates.js').CandidateBody | import('./deletion.js').DeletionBody | ProviderAuthorizationBody
 | {type:'CancelJob'|'RecoverJob'|'UndoPendingJob'|'RedoPendingJob';jobId:string;attemptId:string;expectedVersion:string}
 | {type:'QueueInference';reviewId:string;token:string;acceptanceId:string}
 | {type:'SetSpendGuard';spendSessionId:string;cap:number|null;expectedConfigVersion:string}
 | {type:'StartSpendSession';previousSessionId:string|null;cap:number|null;acknowledgeUnresolvedAttempts:boolean}
 | {type:'CancelUnstartedJob';jobId:string;expectedVersion:string}
 | {type:'ReorderLocalQueue';jobId:string;expectedVersion:string;neighborId:string;expectedNeighborVersion:string;expectedOrderVersion:string;direction:'up'|'down'}
 | {type:'EditQueuedJob';jobId:string;expectedVersion:string;sessionId:string;expectedUISeq:string;replacementDraftId:string}
 | {type:'OverrideUncertainHold';jobId:string;attemptId:string;expectedVersion:string;acknowledgeOverlapAndChargeRisk:true}
 | {type:'RetryUncertainJob';jobId:string;attemptId:string;expectedVersion:string;acknowledgeDuplicateWorkAndChargeRisk:true};
export const queueCommands=['ReorderLocalQueue','EditQueuedJob','QueueInference','AuthorizeProviderJob','SetSpendGuard','StartSpendSession','CancelUnstartedJob','OverrideUncertainHold','RetryUncertainJob','HideCandidate','RetryCandidateImport','RecoverCandidateOriginal','CancelJob','RecoverJob','UndoPendingJob','RedoPendingJob','PreviewDocumentDeletion','DeleteDocument','CollectDocumentGarbage'];
export const isQueueCommand=(type:string)=>queueCommands.includes(type);
export {queueEvents} from './queue-events.js';
export type QueueFact={type:'LocalQueueReordered'|'JobQueued'|'QueueStateChanged'|'SpendGuardChanged'|'SpendSessionStarted'|'CandidateStateChanged'|'DocumentDeletionPreviewed'|'DocumentDeleted'|'DocumentGarbageCollected';payload:{id:string;version:string;state:BlobRef}};
export type StageItem={role:'source'|'mask';original:BlobRef;transport:BlobRef;width:number;height:number;conversion:RequestReview['conversion']}|{role:`adapter:${number}`;original:BlobRef;transport:BlobRef;versionId:string}|import('../request/v45-stages.js').V45PreparedStage;
export type Attempt={providerAuthorization?:ProviderAuthorization;cancel?:'requested'|'acknowledged'|'confirmed'|'unconfirmed';recoveryRequired?:boolean;recoveryRequested?:boolean;cancelEvidence?:string;controlWarning?:string;id:string;previousAttemptId:string|null;version:string;state:'not-started'|'dispatching'|'acknowledged'|'submission-uncertain'|'provider-terminal'|'locally-cancelled';hold:boolean;override:boolean;spendSessionId:string|null;count:'none'|'reserved'|'dispatched'|'released';writerEpoch:string|null;payloadHash:string|null;requestId:string|null;terminal:string|null;uncertainReason:string|null;actualCharge:null;estimate:RequestReview['estimate']};
export type QueueOrder={insertionOrdinal:string|null;position:string;origin:'accepted'|'accepted-event'|'journal'|'journal-unplaced'|'legacy-id-order'};
export type QueueWaiting={position:number;previous:{id:string;version:string}|null;next:{id:string;version:string}|null;reason:string;editable:boolean};
export type QueueJob={order?:QueueOrder;ownerClientId?:string|null;replacementDraft?:{sessionId:string;draftId:string;generation:'1'};id:string;version:string;documentId:string;review:RequestReview;stagePlan:StageItem[];local:'accepted-local-queue'|'ready-to-dispatch'|'paused-spend-cap'|'locally-cancelled';resultImport:'none';disposition:'eligible'|'set-aside'|'cancel-requested'|'suppressed-by-undo'|'deleted';attempts:Attempt[]};
export type SpendSession={id:string;version:string;cap:number|null;createdAt:string;previousSessionId:string|null};
export type QueueView={orderVersion:string;orderEpoch:string;waiting:Record<string,QueueWaiting>;protocolVersion:1;session:SpendSession;totalJobs:number;jobs:QueueJob[];nextCursor:string|null;counts:{reserved:number;dispatched:number;remaining:number|null;active:number};limits:{active:1;target:100;maximum:1000};production:'denied'};

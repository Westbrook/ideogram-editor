import type {BlobRef} from './store.js';
import type {RequestReview} from '../request/review.js';
export type QueueBody =
 | {type:'QueueInference';reviewId:string;token:string;acceptanceId:string}
 | {type:'SetSpendGuard';spendSessionId:string;cap:number|null;expectedConfigVersion:string}
 | {type:'StartSpendSession';previousSessionId:string|null;cap:number|null;acknowledgeUnresolvedAttempts:boolean}
 | {type:'CancelUnstartedJob';jobId:string;expectedVersion:string}
 | {type:'OverrideUncertainHold';jobId:string;attemptId:string;expectedVersion:string;acknowledgeOverlapAndChargeRisk:true}
 | {type:'RetryUncertainJob';jobId:string;attemptId:string;expectedVersion:string;acknowledgeDuplicateWorkAndChargeRisk:true};
export const queueCommands=['QueueInference','SetSpendGuard','StartSpendSession','CancelUnstartedJob','OverrideUncertainHold','RetryUncertainJob'];
export const isQueueCommand=(type:string)=>queueCommands.includes(type);
export const queueEvents=['JobQueued','QueueStateChanged','SpendGuardChanged','SpendSessionStarted'];
export type QueueFact={type:'JobQueued'|'QueueStateChanged'|'SpendGuardChanged'|'SpendSessionStarted';payload:{id:string;version:string;state:BlobRef}};
export type StageItem={role:'source'|'mask';original:BlobRef;transport:BlobRef;width:number;height:number;conversion:RequestReview['conversion']};
export type Attempt={id:string;previousAttemptId:string|null;version:string;state:'not-started'|'dispatching'|'acknowledged'|'submission-uncertain'|'provider-terminal'|'locally-cancelled';hold:boolean;override:boolean;spendSessionId:string|null;count:'none'|'reserved'|'dispatched'|'released';writerEpoch:string|null;payloadHash:string|null;requestId:string|null;terminal:string|null;uncertainReason:string|null;actualCharge:null;estimate:RequestReview['estimate']};
export type QueueJob={id:string;version:string;documentId:string;review:RequestReview;stagePlan:StageItem[];local:'accepted-local-queue'|'ready-to-dispatch'|'paused-spend-cap'|'locally-cancelled';resultImport:'none';disposition:'eligible'|'set-aside';attempts:Attempt[]};
export type SpendSession={id:string;version:string;cap:number|null;createdAt:string;previousSessionId:string|null};
export type QueueView={protocolVersion:1;session:SpendSession;jobs:QueueJob[];nextCursor:string|null;counts:{reserved:number;dispatched:number;remaining:number|null;active:number};limits:{active:1;target:100;maximum:1000};production:'denied'};

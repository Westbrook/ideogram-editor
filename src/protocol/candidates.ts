import type {BlobRef} from './store.js';
/** Browser-safe observation only. No transport URLs, evidence IDs or scheduler authority. */
export type Candidate = {
 id:string; version:string; documentId:string; jobId:string; attemptId:string; requestId:string;
 outputIndex:number; outputIdentity:string; safety:'safe'|'unknown'|'withheld';
 state:'missing'|'received'|'downloaded'|'prepared'|'transfer-failed'|'preparation-failed'|'withheld';
 hidden:boolean; encodedAssetId:string|null; preparedAssetId:string|null; warning:string|null;
};
export type ResultFence={jobId:string;attemptId:string;requestId:string;epoch:string;jobVersion:string};
export type ObservationState={phase:'queued'|'running'|'completed'|'failed'|'cancelled'|'quarantined';nextPollAt:number;failures:number;mode:'healthy'|'backoff'|'offline';digest:string|null;resultDigest:string|null;warning:string|null};
export type ResultProvenance={requestedPrompt:BlobRef;submittedPrompt:BlobRef;returnedPrompt:BlobRef|null;returnedBytes:string;complete:boolean;quarantined:boolean;inspection:'supported'|'opaque'|'unavailable';warning:string|null;requestedSeed:string|null;returnedSeed:string|null;timings:Record<string,number>;timingUnits:'unknown';sourceBodyHash:string;privacyPolicy:BlobRef};
export type CandidateView={repair?:Record<string,BlobRef>;protocolVersion:1;jobId:string;documentId:string;request:{endpoint:string;prompt:BlobRef;seed:string|null};observation:ObservationState|null;requestedCount:number;actualCount:number|null;items:Candidate[];provenance:ResultProvenance|null;inert:boolean;nextCursor:string|null};
export type CandidateBody={type:'RecoverCandidateOriginal';candidateId:string;expectedVersion:string;assetId:string}|{type:'HideCandidate';candidateId:string;expectedVersion:string}|{type:'RetryCandidateImport';candidateId:string;expectedVersion:string};

export type CandidateHistory={items:{jobId:string;attemptId:string;inert:boolean}[];nextCursor:string|null};

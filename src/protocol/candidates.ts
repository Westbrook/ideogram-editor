import type {BlobRef} from './store.js';
import type {Source,Mask} from '../request/core.js';
import type {RequestRasterPlan,RequestOutputMapping} from '../request/raster-plan.js';
import type {RequestSourceCapture} from './request-edits.js';
/** Browser-safe observation only. No transport URLs, evidence IDs or scheduler authority. */
export type Candidate = {
 id:string; version:string; documentId:string; jobId:string; attemptId:string; requestId:string;
 outputIndex:number; outputIdentity:string; safety:'safe'|'unknown'|'withheld';
 state:'missing'|'received'|'downloaded'|'prepared'|'transfer-failed'|'preparation-failed'|'withheld';
 hidden:boolean; encodedAssetId:string|null; preparedAssetId:string|null; warning:string|null;
};
export type ResultFence={jobId:string;attemptId:string;requestId:string;epoch:string;jobVersion:string};
/** Retained with an adoption preview; any later control or output change invalidates it. */
export type CandidateAdoptionIdentity={candidateId:string;candidateVersion:string;documentId:string;jobId:string;attemptId:string;requestId:string;outputIdentity:string;preparedAssetId:string;preparedAssetVersion:string;preparedAssetHash:string;requestHash:string;jobVersion:string;writerEpoch:string};
export type AdoptionCoverage={originalEffectivePixels:number;effectivePixels:number;lostPixels:number};
export type CandidateAdoptionInputs={kind:'candidate-adoption-inputs-1';mode:'safe-region'|'full-candidate';identity:CandidateAdoptionIdentity;plan:RequestRasterPlan|null;sourceCapture:RequestSourceCapture|null;outputMapping:RequestOutputMapping|null;coverage:AdoptionCoverage|null};
export type ObservationState={phase:'queued'|'running'|'completed'|'failed'|'cancelled'|'quarantined';nextPollAt:number;failures:number;mode:'healthy'|'backoff'|'offline';digest:string|null;resultDigest:string|null;warning:string|null};
export type ResultProvenance={requestedPrompt:BlobRef;submittedPrompt:BlobRef;returnedPrompt:BlobRef|null;returnedBytes:string;complete:boolean;quarantined:boolean;inspection:'supported'|'opaque'|'unavailable';warning:string|null;requestedSeed:string|null;returnedSeed:string|null;timings:Record<string,number>;timingUnits:'unknown';sourceBodyHash:string;privacyPolicy:BlobRef};
export type CandidateView={repair?:Record<string,BlobRef>;protocolVersion:1;jobId:string;documentId:string;request:{endpoint:string;prompt:BlobRef;seed:string|null;raster?:{source:Source;mask:Mask;plan:RequestRasterPlan}};observation:ObservationState|null;requestedCount:number;actualCount:number|null;items:Candidate[];provenance:ResultProvenance|null;inert:boolean;nextCursor:string|null};
export type CandidateBody={type:'RecoverCandidateOriginal';candidateId:string;expectedVersion:string;assetId:string}|{type:'HideCandidate';candidateId:string;expectedVersion:string}|{type:'RetryCandidateImport';candidateId:string;expectedVersion:string};

export type CandidateHistory={items:{jobId:string;attemptId:string;inert:boolean}[];nextCursor:string|null};

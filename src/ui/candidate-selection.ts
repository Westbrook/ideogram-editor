import type {Candidate} from '../protocol/candidates.js';
import {reserveModelBytes,type OwnedModel} from '../observability/model-memory.js';
export const CANDIDATE_SELECTION_LIMITS=Object.freeze({attempts:256,bytes:65536});
export type CandidateSelections=Readonly<Record<string,string>>;
export const candidateInspectable=(candidate:Candidate)=>!candidate.hidden&&candidate.safety==='safe'&&candidate.state==='prepared'&&!!candidate.preparedAssetId;
/** Admit every attempt/id pair before retaining it. Original candidate order is
 * authoritative; an existing selected id wins over newly ready earlier rows. */
export function prepareCandidateSelections(prior:CandidateSelections,candidates:Iterable<Candidate>,override?:{attemptId:string;candidateId:string}):OwnedModel<CandidateSelections>{
 const payload=reserveModelBytes('candidate-selection',128);let bytes=128,count=0;
 try{const next:Record<string,string>=Object.create(null);for(const candidate of candidates){if(!candidateInspectable(candidate))continue;const attempt=candidate.attemptId,preferred=override?.attemptId===attempt?override.candidateId:prior[attempt],existing=next[attempt];if(existing!==undefined&&candidate.id!==preferred)continue;if(attempt.length>128||candidate.id.length>128)throw Error('CANDIDATE_SELECTION_LIMIT');const replacement=existing===undefined?bytes+(attempt.length+candidate.id.length)*2+16:bytes+(candidate.id.length-existing.length)*2;if(existing===undefined&&count>=CANDIDATE_SELECTION_LIMITS.attempts||replacement>CANDIDATE_SELECTION_LIMITS.bytes)throw Error('CANDIDATE_SELECTION_LIMIT');payload.resize(replacement);next[attempt]=candidate.id;bytes=replacement;if(existing===undefined)count++;}
  if(override&&next[override.attemptId]!==override.candidateId)throw Error('The selected candidate is no longer available for inspection.');
  return Object.freeze({value:next,release:()=>payload.release(),pin:()=>payload.pin()});
 }catch(error){payload.release();throw error;}
}

import type {BlobRef} from '../../src/protocol/store.js';
import type {Candidate,ResultProvenance} from '../../src/protocol/candidates.js';
import type {Request} from '../../src/request/family.js';
import {requestCount,isV45Request} from '../../src/request/family.js';
import {keys,id,blob,requireValue as ok} from '../../src/protocol/validate.js';
import {candidateRecord,resultRecord,requestAssetIds} from './candidates.js';

/** A destination history owns this immutable observation. Origin identifiers
 * stay original; assetBindings alone supplies the current namespace's bytes.
 * It contains no scheduler, session, review-token or provider transport authority. */
export type AdoptedCandidateLineage={
 kind:'adopted-candidate-lineage-1';inert:true;candidate:Candidate;
 result:{id:string;jobId:string;documentId:string;requestedCount:number;actualCount:number|null;
  phase:'queued'|'running'|'completed'|'failed'|'quarantined';provenance:ResultProvenance|null;inert:true;
  request:{endpoint:string;prompt:BlobRef;seed:string|null;specification:Request;assetBindings:Record<string,string>;textTreatment?:import('../../src/request/text-treatment.js').RequestTextTreatmentEnvelope}};
 assetBindings:Record<string,string>;
};
export function lineageRecord(value:unknown):asserts value is AdoptedCandidateLineage{
 const v=value as AdoptedCandidateLineage;keys(v,['kind','inert','candidate','result','assetBindings']);ok(v.kind==='adopted-candidate-lineage-1'&&v.inert===true);candidateRecord(v.candidate);resultRecord(v.result);
 const c=v.candidate,r=v.result;ok(!r.request.specification||!isV45Request(r.request.specification));ok(c.safety==='safe'&&c.state==='prepared'&&c.encodedAssetId!==null&&c.preparedAssetId!==null&&c.documentId===r.documentId&&c.jobId===r.jobId&&c.attemptId===r.id&&!!r.request.specification&&r.requestedCount===requestCount(r.request.specification)&&(r.actualCount===null||c.outputIndex<r.actualCount));
 ok(requestAssetIds(r.request.specification).every(original=>r.request.assetBindings[original]===original));
 keys(v.assetBindings,[...new Set([...requestAssetIds(r.request.specification),c.encodedAssetId!,c.preparedAssetId!])]);ok(Object.values(v.assetBindings).every(id));
}
export function lineageAssetIds(v:AdoptedCandidateLineage):string[]{lineageRecord(v);return [...new Set(Object.values(v.assetBindings))];}
export function lineageReferences(v:AdoptedCandidateLineage):BlobRef[]{
 lineageRecord(v);const refs=new Map<string,BlobRef>();const visit=(item:unknown)=>{if(!item||typeof item!=='object')return;if(!Array.isArray(item)&&Object.keys(item).sort().join(',')==='byteLength,hash,mediaType'){blob(item);const ref=item as BlobRef;refs.set(ref.hash+':'+ref.mediaType,ref);return;}for(const child of Object.values(item))visit(child);};visit(v);return [...refs.values()];
}

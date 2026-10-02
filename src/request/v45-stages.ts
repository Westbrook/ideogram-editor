import type {Request} from './family.js';
import {isV45Request,validateV45Request} from './family.js';
import type {V45EditSource,V45EditMask} from './v45-edit.js';
import type {BlobRef} from '../protocol/store.js';

export type V45PreparedStage={
 kind:'v45-prepared-stage-1';role:'source'|'mask'|`reference:${number}`;
 assetId:string;assetVersion:string;original:BlobRef;transport:BlobRef;
 width:number;height:number;conversion:null;prepared:V45EditSource|V45EditMask;
};

/** Pure projection of an immutable review. This never prepares new bytes,
 * proves ownership, authorizes upload, sorts references or deduplicates roles. */
export function requestPreparedStages(request:Request):V45PreparedStage[]{
 if(!isV45Request(request))return [];
 validateV45Request(request);if(request.kind==='generate-v45')return [];
 const stage=(role:V45PreparedStage['role'],original:{assetId:string;version:string;blob:BlobRef},prepared:V45EditSource|V45EditMask):V45PreparedStage=>({
  kind:'v45-prepared-stage-1',role,assetId:original.assetId,assetVersion:original.version,original:structuredClone(original.blob),transport:structuredClone(prepared.blob),
  width:prepared.width,height:prepared.height,conversion:null,prepared:structuredClone(prepared),
 });
 const stages=[stage('source',request.source,request.preparedInputs.source)];
 if('mask' in request&&request.preparedInputs.mask)stages.push(stage('mask',request.mask,request.preparedInputs.mask));
 for(const [index,reference] of request.references.entries())stages.push(stage(`reference:${index}`,reference,request.preparedInputs.references[index]!));
 return stages;
}

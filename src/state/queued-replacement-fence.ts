import {reserveModelBytes} from '../observability/model-memory.js';
export const QUEUED_REPLACEMENT_LIMITS=Object.freeze({drafts:4096,bytes:1024*1024,scalarUnits:128});
type DraftGeneration={generation:string;savedGeneration:string|null;pending:boolean;composing:boolean;error:string|null};
type DraftOwner={readonly hasRefusedChanges:boolean;readonly hasPendingRequests:boolean;readonly drafts:ReadonlyMap<string,DraftGeneration>;checkpoint:{uiSeq:string}|null};
const message='The current draft inventory exceeds the replacement review allowance. The current input and saved replacement are retained; close unused drafts before retrying.';
const seq=(value:unknown):value is string=>typeof value==='string'&&value.length<=QUEUED_REPLACEMENT_LIMITS.scalarUnits&&/^(0|[1-9][0-9]*)$/.test(value);
export function queuedDraftsClean(owner:DraftOwner){if(owner.drafts.size>QUEUED_REPLACEMENT_LIMITS.drafts)throw Error(message);if(owner.hasRefusedChanges||owner.hasPendingRequests)return false;for(const draft of owner.drafts.values())if(draft.generation!==draft.savedGeneration||draft.pending||draft.composing||draft.error)return false;return true;}
export function queuedReplacementOperation(draftId:string,sessionId:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(draftId)||!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))throw Error('The replacement draft identity is unavailable.');return reserveModelBytes('queued-replacement-operation',4096,4);}
/** A bounded scalar fence, not a clone of DraftPersistence or its checkpoint.
 * WeakRef is only a same-object stale token; payload release is always explicit.
 * The complete checkpoint and text remain with their actual existing owners. */
export function captureQueuedReplacementFence(owner:DraftOwner){
 const workspace=reserveModelBytes('queued-replacement-scan',1024,2);
 try{
  if(owner.drafts.size>QUEUED_REPLACEMENT_LIMITS.drafts||owner.checkpoint&&!seq(owner.checkpoint.uiSeq))throw Error(message);
  let bytes=256+(owner.checkpoint?.uiSeq.length??0)*2;
  for(const [id,draft]of owner.drafts){if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!seq(draft.generation)||draft.savedGeneration!==null&&!seq(draft.savedGeneration))throw Error(message);bytes+=(id.length+draft.generation.length+(draft.savedGeneration?.length??0))*2+64;if(bytes>QUEUED_REPLACEMENT_LIMITS.bytes)throw Error(message);}
  const payload=reserveModelBytes('queued-replacement-generation-fence',bytes,owner.drafts.size+2);let live=true;
  try{
   const generations:Array<readonly [string,string,string|null]>=[];for(const [id,draft]of owner.drafts)generations.push([id,draft.generation,draft.savedGeneration]);
   let checkpoint=owner.checkpoint?new WeakRef(owner.checkpoint):undefined,sequence=owner.checkpoint?.uiSeq;
   return Object.freeze({
    unchanged(current:DraftOwner){if(!live||current.checkpoint!==(checkpoint?.deref()??null)||current.checkpoint?.uiSeq!==sequence||current.drafts.size!==generations.length)return false;for(const [id,generation,savedGeneration]of generations){const draft=current.drafts.get(id);if(!draft||draft.generation!==generation||draft.savedGeneration!==savedGeneration)return false;}return true;},
    release(){if(live){live=false;generations.length=0;checkpoint=undefined;sequence=undefined;payload.release();}}
   });
  }catch(error){payload.release();throw error;}
 }finally{workspace.release();}
}

import type { Document, DomainEvent } from './store.js';
import { canonical } from './json.js';
export function requireValue(value: unknown, message = 'Invalid recovery data'): asserts value { if (!value) throw new Error(message); }
export const id = (v: unknown): v is string => typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const seq = (v: unknown): v is string => typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v);
export function keys(v: any, fields: string[]) { requireValue(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===fields.length && fields.every(k=>Object.hasOwn(v,k))); }
function blob(v: any) { keys(v,['hash','byteLength','mediaType']); requireValue(/^sha256:[a-f0-9]{64}$/.test(v.hash) && seq(v.byteLength) && typeof v.mediaType==='string'); }
export function document(v: any): asserts v is Document {
  keys(v,['id','revision','branchId','width','height','color','depth','orderedLayerIds','historyHead','checkpoint','compositionVersion']);
  requireValue(id(v.id)&&seq(v.revision)&&id(v.branchId)&&id(v.historyHead)&&(v.checkpoint===null||id(v.checkpoint))&&v.compositionVersion===null&&
    Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&v.color==='sRGB'&&v.depth===8&&Array.isArray(v.orderedLayerIds)&&v.orderedLayerIds.length===0);
}
export function asset(v:any) {
  keys(v,['id','version','purpose','blob','dependencies','safety','availability','qualification','measuredMediaType']);
  requireValue(id(v.id)&&seq(v.version)&&['image','mask','caption'].includes(v.purpose)&&Array.isArray(v.dependencies)&&v.dependencies.length===0&&
    ['safe','unknown','withheld','quarantined'].includes(v.safety)&&['available','missing','corrupt'].includes(v.availability)&&
    ['opaque-text','pending-decoder'].includes(v.qualification)&&['text/plain','image/png','image/jpeg','image/webp'].includes(v.measuredMediaType));
  blob(v.blob);requireValue(v.qualification==='opaque-text'?v.purpose==='caption'&&v.measuredMediaType==='text/plain':v.purpose!=='caption'&&v.safety!=='safe');
}
export function entity(type: string, value: any) {
  if(type==='asset'){asset(value);return value.version;}
  if(type==='document') { document(value); return value.revision; }
  if(type==='checkpoint') {
    keys(value,['id','name','documentId','documentRevision','historyHead','highWater']);
    requireValue(id(value.id)&&id(value.documentId)&&seq(value.documentRevision)&&id(value.historyHead)&&seq(value.highWater)&&typeof value.name==='string'); return value.documentRevision;
  }
  if(type==='history') {
    keys(value,['id','documentId','branchId','parent','forward','inverse','roots']);
    requireValue(id(value.id)&&id(value.documentId)&&id(value.branchId)&&value.parent===null&&Array.isArray(value.roots));
    keys(value.forward,['before','after']);keys(value.inverse,['before','after']); document(value.forward.after);document(value.inverse.before);
    requireValue(value.forward.before===null&&value.inverse.after===null&&canonical(value.forward.after)===canonical(value.inverse.before)&&value.documentId===value.forward.after.id&&value.branchId===value.forward.after.branchId&&value.id===value.forward.after.historyHead);
    for(const ref of value.roots) blob(ref);return value.forward.after.revision;
  }
  throw new Error('Unsupported projection family');
}
export function event(v: any): asserts v is DomainEvent {
  keys(v,['schemaVersion','payloadVersion','eventId','workspaceSeq','streamId','streamSeq','documentId','resultingDocumentRevision','commandId','correlationId','causationId','transactionId','writerEpoch','recordedAt','type','payload']);
  requireValue(v.schemaVersion===1&&v.payloadVersion===1&&['eventId','streamId','commandId','correlationId','transactionId'].every(k=>id(v[k]))&&
    ['workspaceSeq','streamSeq','writerEpoch'].every(k=>seq(v[k]))&&(v.causationId===null||id(v.causationId))&&typeof v.recordedAt==='string'&&Number.isFinite(Date.parse(v.recordedAt))&&
    new TextEncoder().encode(canonical(v)).length<=16384);
  if(v.type==='AssetRegistered'||v.type==='StagingTransferReviewPrepared'||v.type==='StagingOwnershipTransferred'){
    requireValue(v.documentId===null&&v.resultingDocumentRevision===null&&v.streamId==='assets'&&v.streamSeq===v.workspaceSeq);
    if(v.type==='AssetRegistered'){keys(v.payload,['asset']);asset(v.payload.asset);}
    else if(v.type==='StagingTransferReviewPrepared'){keys(v.payload,['reviewId','reviewHash']);requireValue(id(v.payload.reviewId)&&/^sha256:[a-f0-9]{64}$/.test(v.payload.reviewHash));}
    else {keys(v.payload,['stagingId','fromClientId','toClientId','version','committedOffset']);requireValue(id(v.payload.stagingId)&&id(v.payload.fromClientId)&&id(v.payload.toClientId)&&seq(v.payload.version)&&seq(v.payload.committedOffset));}
    return;
  }
  requireValue(id(v.documentId)&&seq(v.resultingDocumentRevision)&&v.streamId===v.documentId&&v.streamSeq===v.resultingDocumentRevision);
  if(v.type==='DocumentCreated') {
    keys(v.payload,['document','history']); document(v.payload.document);entity('history',v.payload.history);
    requireValue(v.documentId===v.payload.document.id&&v.resultingDocumentRevision===v.payload.document.revision&&canonical(v.payload.document)===canonical(v.payload.history.forward.after));
  } else if(v.type==='CheckpointSaved') {
    keys(v.payload,['checkpoint']);entity('checkpoint',v.payload.checkpoint);requireValue(v.payload.checkpoint.documentId===v.documentId);
  } else throw new Error('Unsupported event');
}

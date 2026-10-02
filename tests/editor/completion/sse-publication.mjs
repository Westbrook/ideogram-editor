import assert from 'node:assert/strict';
import {canonical} from '../../../dist/local/src/protocol/json.js';
import {id,seq,keys} from '../../../dist/local/src/protocol/validate.js';
import {supportsProjectionSchema,projectionEvent,projectionEntity} from '../../../dist/local/src/protocol/projection-schema.js';
const one=(rows,label)=>{assert.equal(rows.length,1,label);return rows[0];};
const same=(a,b)=>canonical(a)===canonical(b);
const contextKeys=['recoveryId','writerEpoch','highWater','projectionSchema'];
const sameContext=(a,b)=>a&&b&&contextKeys.every(k=>a[k]===b[k]);
const owned=(x,e)=>x.frameId===e.frameId&&x.document===e.document;
const pair=(a,b)=>a?.owners?.filter(o=>b?.owners?.some(p=>o.clientId===p.clientId&&o.sessionId===p.sessionId))??[];
export function sseRootStarts(e,c,events){
 const origin=new URL(c.url).origin;
 return events.filter(x=>{if(!owned(x,e)||x.kind!=='start')return false;const u=new URL(x.url);if(u.origin!==origin||!(u.pathname==='/api/v1/events'&&!u.searchParams.has('recoveryId')||u.pathname==='/api/v1/events/stream'))return false;assert(Number.isFinite(x.start),'Finite original root start');return x.start>=c.end;});
}
function referenceBoundary(e,c,starts,owner){
 const candidates=sseRootStarts(e,c,starts);if(!candidates.length)return null;
 const at=Math.min(...candidates.map(x=>x.start)),first=candidates.filter(x=>x.start===at);
 assert(at>c.end,'Root start order after descriptor must be strict');
 if(first.length!==1)return null;
 const x=first[0],p=x.originalProof;
 // An unproved earliest start cannot be skipped for a later convenient one.
 // With no proved boundary the caller retains unbounded publication uniqueness.
 if(!p||pair(x,{owners:[owner]}).length!==1||x.owners.length!==1||x.method!=='GET'||!Number.isInteger(x.operation)||x.operation<=0||x.operation===e.operation||x.operation===c.operation)return null;
 if(p.association!=='unique-frame-time-window'||p.eligibleRequests?.length!==1||p.eligibleRequests[0]!==p.requestId||!Number.isInteger(p.requestId)||p.requestId<=0||p.concurrentOperations?.length!==0||p.requestFrame!==x.frameId||!owned(p,x)||p.operation!==x.operation||p.url!==x.url||p.responseURL!==x.url||p.browserResponseURL!==x.url||p.kind!=='response'||p.method!=='GET'||p.start!==x.start||p.redirectedFrom!==null||p.redirected||p.fromServiceWorker||!Number.isFinite(p.responseAt)||p.responseAt<x.start||!Number.isFinite(p.requestStart)||p.requestStart<x.start-2||p.requestStart>p.responseAt+2||!same(p.owners,x.owners))return null;
 return x;
}
function recoveryContext(v){keys(v,['recoveryId','writerEpoch','projectionSchema','highWater','expiresAt']);assert(id(v.recoveryId)&&seq(v.writerEpoch)&&seq(v.highWater)&&supportsProjectionSchema(v.projectionSchema)&&Number.isFinite(Date.parse(v.expiresAt)));}
export function sseDescriptor(d,proof){
 const c=d.control;assert.equal(c.kind,'sse-frame');assert(c.completeFrame&&c.frameOrdinal>0&&c.byteStart>=0&&c.byteEnd>c.byteStart&&c.byteEnd<=c.deliveredCount&&c.deliveredByRead>0);assert.deepEqual(c.parserFailures,[]);
 assert.equal(c.readerNumber,1);assert.equal(proof.readerCount,1);assert.equal(proof.association,'unique-frame-time-window');assert.equal(proof.responseStatus,200);assert.equal(proof.status,200);assert.equal(proof.redirectedFrom,null);assert(!proof.redirected&&!proof.fromServiceWorker&&!proof.cloned&&!proof.teed);assert(proof.headers.type?.startsWith('text/event-stream'));assert.equal(proof.url,proof.browserResponseURL);
 const body=c.value;assert.deepEqual(Object.keys(body).sort(),['kind','protocolVersion','reference']);assert.equal(body.kind,'transaction-ref');assert.equal(body.protocolVersion,1);assert.equal(c.offeredId,d.owner.toSeq);assert.equal(d.content.encoding,'lp1-events-jsonl');
 recoveryContext(d.recovery);keys(d.owner,['kind','transactionId','fromSeq','toSeq','eventCount','recovery','content']);assert.equal(d.owner.kind,'transaction-ref');assert(id(d.owner.transactionId)&&seq(d.owner.fromSeq)&&seq(d.owner.toSeq)&&seq(d.owner.eventCount));keys(d.content,['contentId','url','blob','encoding','recordCount','expiresAt']);keys(d.content.blob,['hash','byteLength','mediaType']);assert(id(d.content.contentId)&&d.content.url===`/api/v1/protocol-content/${d.content.contentId}?recoveryId=${d.recovery.recoveryId}`&&d.content.blob.mediaType==='application/x-ndjson'&&/^sha256:[a-f0-9]{64}$/.test(d.content.blob.hash)&&seq(d.content.blob.byteLength)&&seq(d.content.recordCount)&&Number.isFinite(Date.parse(d.content.expiresAt)));assert.equal(d.owner.eventCount,d.content.recordCount);
 const u=new URL(c.url);assert.equal(u.pathname,'/api/v1/events/stream');assert.equal(u.searchParams.size,1);assert(/^(0|[1-9][0-9]*)$/.test(u.searchParams.get('after')??''));assert(BigInt(d.owner.fromSeq)>BigInt(u.searchParams.get('after')));assert.equal(BigInt(d.owner.toSeq)-BigInt(d.owner.fromSeq)+1n,BigInt(d.owner.eventCount));assert(BigInt(d.owner.toSeq)<=BigInt(d.recovery.highWater));assert(same(d.owner.recovery,d.recovery));
}

// Source-audited SSE reference linkage, not a private callback trace. A later
// revalidation batch is permitted; publication of this reference is exactly toSeq.
export function ssePublication({e,d,values,controls,committed,aborted,events,cachePrefix,rootStarts=/** @type {any[]} */([])}) {
 const c=d.control,owners=pair(e,c);assert.equal(owners.length,1,'Exact client/session owner');const owner=owners[0];assert(owner.clientId&&owner.sessionId);const db=cachePrefix+owner.clientId,target=d.owner.toSeq;
 for(const v of values)projectionEvent(d.recovery.projectionSchema,v);
 const finals=controls.filter(x=>owned(x,e)&&x.end>=e.end&&new URL(x.url).pathname==='/api/v1/events'&&new URL(x.url).searchParams.get('after')===target&&new URL(x.url).searchParams.get('recoveryId')===d.recovery.recoveryId);
 const final=one(finals,'One own SSE reference revalidation');assert.equal(new URL(final.url).searchParams.size,2);recoveryContext(final.value.recovery);assert(sameContext(final.value.recovery,d.recovery));assert(pair(final,e).some(o=>same(o,owner)));
 const fp=final.originalProof;assert.equal(fp?.association,'unique-frame-time-window');assert.equal(fp.responseStatus,200);assert.equal(fp.redirectedFrom,null);assert(!fp.redirected&&!fp.fromServiceWorker&&!fp.cloned&&!fp.teed&&!fp.earlyCancel&&!fp.readError&&!fp.overflow);assert.equal(fp.readerCount,1);
 const starts=sseRootStarts(e,c,events).map(x=>{const matches=rootStarts.filter(r=>r.frameId===x.frameId&&r.document===x.document&&r.operation===x.operation&&r.start===x.start&&r.url===x.url);return {...x,originalProof:matches.length===1?matches[0].originalProof:null};});
 const boundary=referenceBoundary(e,c,starts,owner),nextRecoveryStart=boundary?.start??null;
 const pubs=committed.filter(x=>owned(x,e)&&x.db===db).flatMap(x=>x.records.filter(r=>r.store==='meta'&&r.key==='published'&&r.value.epoch===d.recovery.writerEpoch&&r.value.cursor===target&&x.at>=final.end&&(nextRecoveryStart===null||x.at<nextRecoveryStart)).map(r=>({...r,db,completedAt:x.at,transaction:x.transaction,writeAt:r.at})));
 const pub=one(pubs,'One committed publication at the reference boundary');assert(pub.value.generation&&typeof pub.value.generation==='string');assert(pub.completedAt>=e.end);
 const competing=starts.filter(x=>x.start<=pub.completedAt);
 assert.equal(competing.length,0,'No later recovery supplies this publication');
 const writes=committed.filter(x=>owned(x,e)&&x.db===db&&x.at>=e.start&&x.at<=pub.completedAt).flatMap(x=>x.records.filter(r=>r.store==='rows'&&r.key?.[0]===pub.value.generation).map(r=>({...r,completedAt:x.at,transaction:x.transaction})));
 assert(!aborted.some(x=>owned(x,e)&&x.db===db&&x.records.some(r=>r.key?.[0]===pub.value.generation||r.store==='meta'&&r.value?.generation===pub.value.generation)),'Aborted generation cannot qualify');
 const eventWrites=[];for(const v of values){const marker=one(writes.filter(w=>w.key[1]==='event'&&w.key[2]===v.eventId),'One committed original event marker');assert.equal(marker.value,v.workspaceSeq);assert(Number.isInteger(marker.transaction)&&marker.transaction>0);const docs=v.payload?.document;
  if(v.documentId){const written=one(writes.filter(w=>w.key[1]==='document'&&w.key[2]===v.documentId&&w.transaction===marker.transaction),'Corresponding committed document write');assert.equal(projectionEntity(d.recovery.projectionSchema,'document',written.value),v.resultingDocumentRevision);if(docs)assert(same(written.value,docs));else {assert.equal(v.type,'CheckpointSaved');assert.equal(written.value.checkpoint,v.payload.checkpoint.id);assert.equal(written.value.historyHead,v.payload.checkpoint.historyHead);}}
  if(v.type==='BundleImported')assert(writes.some(w=>w.key[1]==='namespace'&&w.key[2]===v.payload.namespaceId&&w.value.eventId===v.eventId&&w.value.namespaceHash===v.payload.namespaceHash&&w.completedAt<=marker.completedAt),'Corresponding committed namespace write');eventWrites.push({eventId:v.eventId,workspaceSeq:v.workspaceSeq,transaction:marker.transaction,generation:marker.key[0]});
 }
 const otherPubs=committed.filter(x=>owned(x,e)&&x.db===db&&x.at>=e.start&&x.at<=pub.completedAt).flatMap(x=>x.records.filter(r=>r.store==='meta'&&r.key==='published'));
 assert.equal(otherPubs.length,1,'No conflicting publication during this reference');
 return {validationKind:'sse-reference-publication',publication:pub,clientId:owner.clientId,sessionId:owner.sessionId,targetCursor:target,finalCheck:{url:final.url,at:final.end,value:final.value,proof:fp},eventWrites,validated:true,nextRecoveryStart,referenceWindow:{starts},linkage:'Source-audited original SSE frame, original content, own revalidation and committed generation before the next proved original root start; no private callback trace or root-body completion claim'};
}

export function sseQualification(p){
 const d=p.descriptor,f=p.finalCheck;if(p.validationKind!=='sse-reference-publication'||!d||!f)return false;
 try{const c={url:d.controlProof.url,end:d.at,operation:d.requestOperation},starts=p.referenceWindow?.starts;if(!Array.isArray(starts))return false;const selected=sseRootStarts(p,c,starts);if(selected.length!==starts.length)return false;const boundary=referenceBoundary(p,c,starts,{clientId:p.clientId,sessionId:p.sessionId});if(p.nextRecoveryStart!==(boundary?.start??null)||starts.some(x=>x.start<=p.publication?.completedAt))return false;}catch{return false;}
 return d.source==='original-sse-frame'&&d.requestOperation===d.controlProof.operation&&d.frameOrdinal>0&&d.byteStart>=0&&d.byteEnd>d.byteStart&&d.byteEnd<=d.deliveredCount&&d.deliveredByRead>0&&d.parserFailures?.length===0&&d.offeredId===p.targetCursor&&d.owner.toSeq===p.targetCursor&&p.publication?.value.cursor===p.targetCursor&&p.publication.value.epoch===d.recovery.writerEpoch&&p.eventWrites?.length===p.records&&new Set(p.eventWrites.map(e=>e.eventId)).size===p.records&&p.eventWrites.every(e=>e.transaction>0&&e.generation===p.publication.value.generation)&&typeof p.publication.value.generation==='string'&&p.publication.value.generation.length>0&&f.proof?.association==='unique-frame-time-window'&&f.proof.responseStatus===200&&f.at<=p.publication.completedAt&&sameContext(f.value?.recovery,d.recovery)&&new URL(f.url).pathname==='/api/v1/events'&&new URL(f.url).searchParams.size===2&&new URL(f.url).searchParams.get('after')===p.targetCursor&&new URL(f.url).searchParams.get('recoveryId')===d.recovery.recoveryId;
}

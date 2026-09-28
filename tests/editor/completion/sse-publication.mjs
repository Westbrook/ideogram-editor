import assert from 'node:assert/strict';
import {canonical} from '../../../dist/local/src/protocol/json.js';
import {event as validateEvent,entity,id,seq,keys} from '../../../dist/local/src/protocol/validate.js';
const one=(rows,label)=>{assert.equal(rows.length,1,label);return rows[0];};
const same=(a,b)=>canonical(a)===canonical(b);
const contextKeys=['recoveryId','writerEpoch','highWater','projectionSchema'];
const sameContext=(a,b)=>a&&b&&contextKeys.every(k=>a[k]===b[k]);
const owned=(x,e)=>x.frameId===e.frameId&&x.document===e.document;
const pair=(a,b)=>a?.owners?.filter(o=>b?.owners?.some(p=>o.clientId===p.clientId&&o.sessionId===p.sessionId))??[];
function recoveryContext(v){keys(v,['recoveryId','writerEpoch','projectionSchema','highWater','expiresAt']);assert(id(v.recoveryId)&&seq(v.writerEpoch)&&seq(v.highWater)&&[2,3,4,5,6,7,8].includes(v.projectionSchema)&&Number.isFinite(Date.parse(v.expiresAt)));}
export function sseDescriptor(d,proof){
 const c=d.control;assert.equal(c.kind,'sse-frame');assert(c.completeFrame&&c.frameOrdinal>0&&c.byteStart>=0&&c.byteEnd>c.byteStart&&c.byteEnd<=c.deliveredCount&&c.deliveredByRead>0);assert.deepEqual(c.parserFailures,[]);
 assert.equal(c.readerNumber,1);assert.equal(proof.readerCount,1);assert.equal(proof.association,'unique-frame-time-window');assert.equal(proof.responseStatus,200);assert.equal(proof.status,200);assert.equal(proof.redirectedFrom,null);assert(!proof.redirected&&!proof.fromServiceWorker&&!proof.cloned&&!proof.teed);assert(proof.headers.type?.startsWith('text/event-stream'));assert.equal(proof.url,proof.browserResponseURL);
 const body=c.value;assert.deepEqual(Object.keys(body).sort(),['kind','protocolVersion','reference']);assert.equal(body.kind,'transaction-ref');assert.equal(body.protocolVersion,1);assert.equal(c.offeredId,d.owner.toSeq);assert.equal(d.content.encoding,'lp1-events-jsonl');
 recoveryContext(d.recovery);keys(d.owner,['kind','transactionId','fromSeq','toSeq','eventCount','recovery','content']);assert.equal(d.owner.kind,'transaction-ref');assert(id(d.owner.transactionId)&&seq(d.owner.fromSeq)&&seq(d.owner.toSeq)&&seq(d.owner.eventCount));keys(d.content,['contentId','url','blob','encoding','recordCount','expiresAt']);keys(d.content.blob,['hash','byteLength','mediaType']);assert(id(d.content.contentId)&&d.content.url===`/api/v1/protocol-content/${d.content.contentId}?recoveryId=${d.recovery.recoveryId}`&&d.content.blob.mediaType==='application/x-ndjson'&&/^sha256:[a-f0-9]{64}$/.test(d.content.blob.hash)&&seq(d.content.blob.byteLength)&&seq(d.content.recordCount)&&Number.isFinite(Date.parse(d.content.expiresAt)));assert.equal(d.owner.eventCount,d.content.recordCount);
 const u=new URL(c.url);assert.equal(u.pathname,'/api/v1/events/stream');assert.equal(u.searchParams.size,1);assert(/^(0|[1-9][0-9]*)$/.test(u.searchParams.get('after')??''));assert(BigInt(d.owner.fromSeq)>BigInt(u.searchParams.get('after')));assert.equal(BigInt(d.owner.toSeq)-BigInt(d.owner.fromSeq)+1n,BigInt(d.owner.eventCount));assert(BigInt(d.owner.toSeq)<=BigInt(d.recovery.highWater));assert(same(d.owner.recovery,d.recovery));
}

// Source-audited SSE reference linkage, not a private callback trace. A later
// revalidation batch is permitted; publication of this reference is exactly toSeq.
export function ssePublication({e,d,values,controls,committed,aborted,events,cachePrefix}) {
 const c=d.control,owners=pair(e,c);assert.equal(owners.length,1,'Exact client/session owner');const owner=owners[0];assert(owner.clientId&&owner.sessionId);const db=cachePrefix+owner.clientId,target=d.owner.toSeq;
 for(const v of values)validateEvent(v);
 const finals=controls.filter(x=>owned(x,e)&&x.end>=e.end&&new URL(x.url).pathname==='/api/v1/events'&&new URL(x.url).searchParams.get('after')===target&&new URL(x.url).searchParams.get('recoveryId')===d.recovery.recoveryId);
 const final=one(finals,'One own SSE reference revalidation');assert.equal(new URL(final.url).searchParams.size,2);recoveryContext(final.value.recovery);assert(sameContext(final.value.recovery,d.recovery));assert(pair(final,e).some(o=>same(o,owner)));
 const fp=final.originalProof;assert.equal(fp?.association,'unique-frame-time-window');assert.equal(fp.responseStatus,200);assert.equal(fp.redirectedFrom,null);assert(!fp.redirected&&!fp.fromServiceWorker&&!fp.cloned&&!fp.teed&&!fp.earlyCancel&&!fp.readError&&!fp.overflow);assert.equal(fp.readerCount,1);
 const pubs=committed.filter(x=>owned(x,e)&&x.db===db).flatMap(x=>x.records.filter(r=>r.store==='meta'&&r.key==='published'&&r.value.epoch===d.recovery.writerEpoch&&r.value.cursor===target&&x.at>=final.end).map(r=>({...r,db,completedAt:x.at,transaction:x.transaction,writeAt:r.at})));
 const pub=one(pubs,'One committed publication at the reference boundary');assert(pub.value.generation&&typeof pub.value.generation==='string');assert(pub.completedAt>=e.end);
 const competing=events.filter(x=>owned(x,e)&&x.kind==='start'&&x.start>c.end&&x.start<pub.completedAt&&((new URL(x.url).pathname==='/api/v1/events'&&!new URL(x.url).searchParams.has('recoveryId'))||new URL(x.url).pathname==='/api/v1/events/stream'));
 assert.equal(competing.length,0,'No later recovery supplies this publication');
 const writes=committed.filter(x=>owned(x,e)&&x.db===db&&x.at>=e.start&&x.at<=pub.completedAt).flatMap(x=>x.records.filter(r=>r.store==='rows'&&r.key?.[0]===pub.value.generation).map(r=>({...r,completedAt:x.at,transaction:x.transaction})));
 assert(!aborted.some(x=>owned(x,e)&&x.db===db&&x.records.some(r=>r.key?.[0]===pub.value.generation||r.store==='meta'&&r.value?.generation===pub.value.generation)),'Aborted generation cannot qualify');
 const eventWrites=[];for(const v of values){const marker=one(writes.filter(w=>w.key[1]==='event'&&w.key[2]===v.eventId),'One committed original event marker');assert.equal(marker.value,v.workspaceSeq);assert(Number.isInteger(marker.transaction)&&marker.transaction>0);const docs=v.payload?.document;
  if(v.documentId){const written=one(writes.filter(w=>w.key[1]==='document'&&w.key[2]===v.documentId&&w.transaction===marker.transaction),'Corresponding committed document write');assert.equal(entity('document',written.value),v.resultingDocumentRevision);if(docs)assert(same(written.value,docs));else {assert.equal(v.type,'CheckpointSaved');assert.equal(written.value.checkpoint,v.payload.checkpoint.id);assert.equal(written.value.historyHead,v.payload.checkpoint.historyHead);}}
  if(v.type==='BundleImported')assert(writes.some(w=>w.key[1]==='namespace'&&w.key[2]===v.payload.namespaceId&&w.value.eventId===v.eventId&&w.value.namespaceHash===v.payload.namespaceHash&&w.completedAt<=marker.completedAt),'Corresponding committed namespace write');eventWrites.push({eventId:v.eventId,workspaceSeq:v.workspaceSeq,transaction:marker.transaction});
 }
 const otherPubs=committed.filter(x=>owned(x,e)&&x.db===db&&x.at>=e.start&&x.at<=pub.completedAt).flatMap(x=>x.records.filter(r=>r.store==='meta'&&r.key==='published'));
 assert.equal(otherPubs.length,1,'No conflicting publication during this reference');
 return {validationKind:'sse-reference-publication',publication:pub,clientId:owner.clientId,sessionId:owner.sessionId,targetCursor:target,finalCheck:{url:final.url,at:final.end,value:final.value,proof:fp},eventWrites,validated:true,nextRecoveryStart:null,linkage:'Source-audited original SSE frame, original content, own revalidation and committed generation; no private callback trace'};
}

export function sseQualification(p){
 const d=p.descriptor,f=p.finalCheck;if(p.validationKind!=='sse-reference-publication'||!d||!f)return false;
 return d.source==='original-sse-frame'&&d.requestOperation===d.controlProof.operation&&d.frameOrdinal>0&&d.byteStart>=0&&d.byteEnd>d.byteStart&&d.byteEnd<=d.deliveredCount&&d.deliveredByRead>0&&d.parserFailures?.length===0&&d.offeredId===p.targetCursor&&d.owner.toSeq===p.targetCursor&&p.publication?.value.cursor===p.targetCursor&&p.publication.value.epoch===d.recovery.writerEpoch&&p.eventWrites?.length===p.records&&new Set(p.eventWrites.map(e=>e.eventId)).size===p.records&&p.eventWrites.every(e=>e.transaction>0)&&f.proof?.association==='unique-frame-time-window'&&f.proof.responseStatus===200&&f.at<=p.publication.completedAt&&sameContext(f.value?.recovery,d.recovery)&&new URL(f.url).pathname==='/api/v1/events'&&new URL(f.url).searchParams.size===2&&new URL(f.url).searchParams.get('after')===p.targetCursor&&new URL(f.url).searchParams.get('recoveryId')===d.recovery.recoveryId;
}

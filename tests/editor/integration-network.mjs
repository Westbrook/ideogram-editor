import {sseQualification} from './completion/sse-publication.mjs';
import {createHash} from 'node:crypto';
import {expectedCompositionCancellation} from './composition-network.mjs';
const literals={chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'};
export function integrationCancellation(e,origin,engine,downloads=[],faults=[],fontProofs=[],importedHeads=[],recovery={proofs:[],sse:[]},workflowProofs=[]){
 const prior=expectedCompositionCancellation(e,origin,engine,downloads,workflowProofs);if(prior)return prior;
 if(originalSSECancellation(e,origin,engine,recovery.sse??[]))return 'own-original-signal-sse-cancellation';
 const r=e.response;
 if(e.channel!=='requestfailed'||e.failure?.errorText!==literals[engine]||e.resourceType!=='fetch'||!r||r.requestId!==e.requestId||r.url!==e.url||r.method!==e.method)return false;
 const u=new URL(e.url);if(u.origin!==origin)return false;
 if(originalRecoveryCompletion(e,recovery.proofs??[]))return 'abort-with-proven-original-recovery-body';
 if(originalAssetBodyEOF(e,origin,workflowProofs))return 'exact-original-asset-response-eof';
 if(originalRejectedAssetCancellation(e,origin,faults,workflowProofs))return 'own-rejected-asset-original-reader-cancellation';
 if(u.search)return false;
 // server/storage/portable.ts localId creates this exact imported namespace.
 // The document HEAD endpoint ends after the authoritative entity version.
 if(engine==='chromium'&&e.method==='HEAD'&&r.status===200&&/^\/api\/v1\/documents\/p_[a-f0-9]{64}$/.test(u.pathname)&&/^(0|[1-9][0-9]*)$/.test(r.entityVersion??'')&&importedHeads.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.origin===origin&&p.localId===u.pathname.split('/').at(-1)&&p.localId===p.computedId&&p.localId==='p_'+createHash('sha256').update(JSON.stringify([p.namespace,'document',p.sourceId])).digest('hex')&&p.documentId===p.localId&&p.namespace&&p.sourceId&&p.revision===r.entityVersion&&p.redirectedFrom===null&&p.fromServiceWorker===false&&p.ownerPage===true))return 'imported-document-bodyless-head';
 if(e.method==='GET'&&r.status===200&&['font/ttf','font/otf'].includes(r.contentType)&&fontProofs.some(p=>originalFontCompletion(p,e)))return 'abort-with-proven-original-font-body';
 // HTTP HEAD has no response body, including this fixture's own removed font.
 // A GET to the same missing object does not inherit this qualification.
 if(engine==='chromium'&&e.method==='HEAD'&&r.status===404&&r.contentType==='application/json; charset=utf-8'&&/^\/api\/v1\/assets\/[0-9a-f-]{36}\/content$/.test(u.pathname)&&faults.some(f=>f.url===e.url&&f.status===404&&f.reason))return 'own-missing-font-bodyless-head';
 if(e.method!=='GET'||r.status!==200||!/^\/api\/v1\/(assets|bundles)\/[0-9a-f-]{36}\/content$/.test(u.pathname))return false;
 return downloads.some(p=>p.requestId===e.requestId&&p.url===e.url&&p.oneOwnedRequestInExplicitExportWindow===true&&p.destinationComplete===true&&p.downloadURL.startsWith('blob:'+origin+'/')&&r.contentLength===String(p.bytes)&&r.etag==='"sha256:'+p.sha256+'"')?'exact-original-completed-destination':false;
}

// The raw abort remains recorded. This proves original-body consumption only;
// protocol completion, its unexplained failure cause and cleanup are separate.
export function originalFontCompletion(p,e){
 const r=e.response;
 return p.association==='unique-frame-time-window'&&p.requestId===e.requestId&&p.eligibleRequests.length===1&&p.eligibleRequests[0]===e.requestId&&p.concurrentOperations.length===0&&p.frameId===p.requestFrame&&p.frameId>0&&typeof p.document==='string'&&p.document.length===36&&
  p.url===e.url&&p.requestURL===e.url&&p.responseURL===e.url&&p.browserResponseURL===e.url&&p.method===e.method&&p.method==='GET'&&p.status===200&&p.responseStatus===200&&r.status===200&&r.contentType===(p.font.path.endsWith('.otf')?'font/otf':'font/ttf')&&p.redirected===false&&p.redirectedFrom===null&&p.fromServiceWorker===false&&p.cacheControl==='no-store'&&
  p.normalEOF===true&&p.reason==='normal-eof'&&p.failed===false&&p.cancelledBeforeEOF===false&&p.truncatedObservation===false&&p.cloned===false&&p.teed===false&&p.readers===1&&p.readerNumber===1&&p.reads>0&&p.count===p.bytes&&p.bytes===p.font.bytes&&String(p.bytes)===r.contentLength&&p.sha256===p.font.sha256&&/^[a-f0-9]{64}$/.test(p.sha256)&&new URL(p.url).pathname===p.font.path&&
  p.timeOrigin<=p.start&&p.start<=p.responseAt&&p.responseAt<=p.end&&p.requestStart>=p.start-2&&p.requestStart<=p.responseAt+2&&p.applicationValidated===true&&p.validation?.receipt?.status==='accepted'&&p.validation.receipt.commandId===p.validation.commandId&&p.validation.source.hash==='sha256:'+p.sha256&&p.validation.source.byteLength===String(p.bytes)&&typeof p.validation.sessionId==='string'&&typeof p.validation.clientId==='string'&&typeof p.validation.documentId==='string';
}

export function originalRecoveryCompletion(e,proofs){
 const r=e.response;if(e.channel!=='requestfailed'||e.resourceType!=='fetch'||!Object.values(literals).includes(e.failure?.errorText)||e.method!=='GET'||r?.requestId!==e.requestId||r.url!==e.url||r.method!==e.method||r.status!==200||r.contentType!=='application/x-ndjson')return false;
 return proofs.some(p=>p.association==='unique-frame-time-window'&&p.requestId===e.requestId&&p.eligibleRequests.length===1&&p.eligibleRequests[0]===e.requestId&&p.concurrentOperations.length===0&&p.frameId===p.requestFrame&&p.document?.length===36&&p.url===e.url&&p.responseURL===e.url&&p.browserResponseURL===e.url&&p.status===200&&p.responseStatus===200&&p.redirected===false&&p.redirectedFrom===null&&p.fromServiceWorker===false&&p.cacheControl==='no-store'&&p.normalEOF===true&&!p.overflow&&!p.cloned&&!p.teed&&!p.earlyCancel&&!p.readError&&p.readerCount===1&&p.readerNumber===1&&p.count===p.bytes&&String(p.bytes)===r.contentLength&&r.etag==='"sha256:'+p.sha256+'"'&&p.descriptorCandidates===1&&p.descriptor.frameId===p.frameId&&p.descriptor.document===p.document&&p.descriptor.at<=p.start+2&&p.descriptor.controlProof.association==='unique-frame-time-window'&&p.descriptor.controlProof.responseStatus===200&&p.validated===true&&typeof p.clientId==='string'&&typeof p.sessionId==='string'&&p.owners.some(o=>o.clientId===p.clientId&&o.sessionId===p.sessionId)&&p.descriptor.owners.some(o=>o.clientId===p.clientId&&o.sessionId===p.sessionId)&&p.publication?.db==='ie-projection-'+p.clientId&&p.publication&&p.publication.completedAt>=p.end&&(p.nextRecoveryStart===null||p.publication.completedAt<p.nextRecoveryStart)&&(p.validationKind==='command-result'?p.acceptedCommand?.receipt?.status==='accepted'&&p.acceptedCommand.receipt.commandId===p.commandId&&new URL(p.descriptor.controlProof.url).pathname==='/api/v1/commands/'+p.commandId+'/result'&&p.acceptedCommand.eventsBodySHA256===p.sha256&&p.acceptedCommand.clientId===p.clientId&&p.acceptedCommand.sessionId===p.sessionId:(p.validationKind==='recovery-publication'&&p.finalCheck?.proof?.association==='unique-frame-time-window'&&p.finalCheck.proof.responseStatus===200&&p.finalCheck.at<=p.publication.completedAt&&p.finalCheck.value.recovery.recoveryId===p.descriptor.recovery.recoveryId||sseQualification(p)))&&p.publication.value.epoch===p.descriptor.recovery.writerEpoch&&p.descriptor.content.blob.hash==='sha256:'+p.sha256&&p.descriptor.content.blob.byteLength===String(p.bytes)&&p.descriptor.content.recordCount===String(p.records)&&new URL(p.url).searchParams.get('recoveryId')===p.descriptor.recovery.recoveryId);
}
export function originalSSECancellation(e,origin,engine,proofs){
 if(e.channel!=='requestfailed'||e.response!==null||e.method!=='GET'||e.resourceType!=='fetch'||e.failure?.errorText!==literals[engine])return false;const u=new URL(e.url);if(u.origin!==origin||u.pathname!=='/api/v1/events/stream'||u.searchParams.size!==1||!/^\d+$/.test(u.searchParams.get('after')??''))return false;
 return proofs.some(p=>p.association==='unique-frame-time-window'&&p.requestId===e.requestId&&p.url===e.url&&p.frameId===p.requestFrame&&p.document?.length===36&&p.eligibleRequests.length===1&&p.eligibleRequests[0]===e.requestId&&p.concurrentOperations.length===0&&p.redirectedFrom===null&&p.hasSignal===true&&p.name==='AbortError'&&p.signalAbort?.aborted===true&&p.signalAbort.reasonName==='AbortError'&&p.signalAbort.operation===p.operation&&p.signalAbort.document===p.document&&p.signalAbort.frameId===p.frameId&&p.signalAbort.at>=p.start&&p.signalAbort.at<=p.at&&p.responseStatus===undefined);
}

// This is the same bounded original-response EOF claim as the workflow JSON
// route, restricted to asset content. Raw native ERR_ABORTED stays in evidence.
// Count + ETag framing is NOT a digest of consumed bytes, font validation,
// domain success, causal attribution, cleanup, or native transport success.
export function originalAssetBodyEOF(e,origin,proofs){
 const r=e?.response;if(e?.channel!=='requestfailed'||e.resourceType!=='fetch'||!Object.values(literals).includes(e.failure?.errorText)||e.method!=='GET'||r?.requestId!==e.requestId||r.url!==e.url||r.method!==e.method||r.status!==200||r.contentType!=='application/octet-stream'||!/^[1-9][0-9]*$/.test(r.contentLength??'')||!/^"sha256:[a-f0-9]{64}"$/.test(r.etag??''))return false;
 let u;try{u=new URL(e.url);}catch{return false;}
 if(u.origin!==origin||u.search||u.hash||!/^\/api\/v1\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/.test(u.pathname))return false;
 if(!Array.isArray(proofs)||proofs.some(p=>!p||typeof p!=='object'))return false;
 const matches=proofs.filter(p=>p.requestId===e.requestId);if(matches.length!==1)return false;
 const p=matches[0],w=p.assetBodyEOF,time=n=>Number.isFinite(n)&&n>0,positive=n=>Number.isSafeInteger(n)&&n>0;
 if(p.association!=='unique-frame-time-window'||p.exactOccurrence!==true||p.bijection!==undefined||p.inferredAssociation!==undefined||p.requestTiming!==undefined||p.requestStartRaw!==undefined||p.url!==e.url||p.method!=='GET'||p.status!==200||!positive(p.requestId)||!positive(p.frameId)||p.frameId!==p.requestFrame||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.document??'')||!positive(p.operation)||!Array.isArray(p.eligibleRequests)||p.eligibleRequests.length!==1||p.eligibleRequests[0]!==e.requestId||!Array.isArray(p.concurrentOperations)||p.concurrentOperations.length!==0||p.bodyComplete!==true||p.bodyCanceled!==false||!positive(p.bytes)||String(p.bytes)!==r.contentLength)return false;
 if(!w||w.kind!=='original-asset-body-eof-1'||w.frameId!==p.frameId||w.document!==p.document||w.operation!==p.operation||w.url!==p.url||w.method!==p.method||w.start!==p.start||w.completedAt!==p.end||w.reader!==1||w.originalReader!==true||w.bytes!==p.bytes||![w.start,w.responseAt,w.readerAt,w.completedAt,p.requestStart].every(time)||!(w.start<=w.responseAt&&w.responseAt<=w.readerAt&&w.readerAt<=w.completedAt&&p.requestStart>=w.start-2&&p.requestStart<=w.responseAt+2))return false;
 return w.signalAbortAt===null?w.observedRows===4&&p.signalAborted===false:w.observedRows===5&&p.signalAborted===true&&time(w.signalAbortAt)&&w.signalAbortAt>w.completedAt;
}

// Only an explicitly declared own404 fault can use this rejection disposition.
// The original reader cancel fulfilled without a read; the native failure stays
// recorded. This is not EOF, a hash/font proof, transport success or abort cause.
export function originalRejectedAssetCancellation(e,origin,faults,proofs){
 const r=e?.response;if(e?.channel!=='requestfailed'||e.resourceType!=='fetch'||!Object.values(literals).includes(e.failure?.errorText)||e.method!=='GET'||r?.requestId!==e.requestId||r.url!==e.url||r.method!==e.method||r.status!==404||r.contentType!=='application/json; charset=utf-8'||typeof r.contentLength!=='string'||!/^[1-9][0-9]*$/.test(r.contentLength)||!Number.isSafeInteger(Number(r.contentLength)))return false;
 let u;try{u=new URL(e.url);}catch{return false;}
 if(u.origin!==origin||u.search||u.hash||!/^\/api\/v1\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/.test(u.pathname))return false;
 if(!Array.isArray(faults)||faults.some(f=>!f||typeof f!=='object'))return false;
 const declared=faults.filter(f=>f.url===e.url);if(declared.length!==1||declared[0].status!==404||declared[0].reason!=='Own exact font object removed; retained canonical pixels remain present.')return false;
 if(!Array.isArray(proofs)||proofs.some(p=>!p||typeof p!=='object'))return false;
 const matches=proofs.filter(p=>p.requestId===e.requestId);if(matches.length!==1)return false;
 const p=matches[0],w=p.assetRejectionCancellation,time=n=>Number.isFinite(n)&&n>0,positive=n=>Number.isSafeInteger(n)&&n>0;
 if(p.association!=='unique-frame-time-window'||p.exactOccurrence!==true||p.bijection!==undefined||p.inferredAssociation!==undefined||p.requestTiming!==undefined||p.requestStartRaw!==undefined||p.url!==e.url||p.method!=='GET'||p.status!==404||!positive(p.requestId)||!positive(p.frameId)||p.frameId!==p.requestFrame||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.document??'')||!positive(p.operation)||!Array.isArray(p.eligibleRequests)||p.eligibleRequests.length!==1||p.eligibleRequests[0]!==e.requestId||!Array.isArray(p.concurrentOperations)||p.concurrentOperations.length!==0||p.bodyComplete!==false||p.bodyCanceled!==true||p.bytes!==undefined||p.assetBodyEOF!==undefined)return false;
 if(!w||w.kind!=='original-asset-rejection-cancel-1'||w.frameId!==p.frameId||w.document!==p.document||w.operation!==p.operation||w.url!==p.url||w.method!==p.method||w.start!==p.start||w.cancelFulfilledAt!==p.end||w.reader!==1||w.originalReader!==true||w.readCalls!==0||w.bytes!==0||![w.start,w.responseAt,w.readerAt,w.cancelCalledAt,w.cancelFulfilledAt,p.requestStart].every(time)||!(w.start<=w.responseAt&&w.responseAt<=w.readerAt&&w.readerAt<=w.cancelCalledAt&&w.cancelCalledAt<=w.cancelFulfilledAt&&p.requestStart>=w.start-2&&p.requestStart<=w.responseAt+2))return false;
 return w.signalAbortAt===null?w.observedRows===5&&p.signalAborted===false:w.observedRows===6&&p.signalAborted===true&&time(w.signalAbortAt)&&w.signalAbortAt>=w.cancelFulfilledAt;
}

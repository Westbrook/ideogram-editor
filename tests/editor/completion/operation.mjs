import assert from 'node:assert/strict';
import {EXPECTED} from './app-buffer-core.mjs';
const one=(rows,label)=>{assert.equal(rows.length,1,label);return rows[0];};
export function qualifiedWasmAbort(event,epochs){
 const e=event,r=e.response;
 if(e.channel!=='requestfailed'||e.failure?.errorText!=='net::ERR_ABORTED'||e.method!=='GET'||e.resourceType!=='fetch'||!r||r.requestId!==e.requestId||r.url!==e.url||r.method!=='GET'||r.status!==200||r.contentType!=='application/wasm'||r.contentLength!==String(EXPECTED.wasmBytes))return false;
 return epochs.some(p=>p.qualification?.qualified&&p.qualification.cleanup===true&&p.qualification.observedEOF===false&&p.initial.originals.some(v=>v.q.id===e.requestId&&v.q.url===e.url&&v.q.method==='GET'&&v.q.resourceType==='fetch'&&v.t.kind==='failed'&&v.t.failure?.errorText==='net::ERR_ABORTED'));
}
export function nativeOperation({observation,action,after,acceptedBefore,acceptedAfter,candidate,command,priorPreview}) {
 const {rows,epoch,errors}=observation;assert(epoch);assert.deepEqual(errors,[]);assert(rows.every((r,i)=>r.epoch===epoch&&r.sequence===i+1),'Lossless original epoch');
 const own=rows.filter(r=>r.actionId===action.id),begin=one(own.filter(r=>r.kind==='action-begin'),'Fresh action'),end=one(own.filter(r=>r.kind==='action-end'),'Completed action');assert.deepEqual(begin.action,action);
 const worker=one(own.filter(r=>r.kind==='created'),'One unrecycled native worker');assert.equal(worker.url,action.workerURL);assert.equal(worker.type,'module');assert(/^ideogram-text-\d+$/.test(worker.name));assert.equal(rows.filter(r=>r.kind==='created'&&r.workerId===worker.workerId).length,1);
 const ready=one(own.filter(r=>r.kind==='message'&&r.ready),'Engine ready'),post=one(own.filter(r=>r.kind==='post'),'Original post'),returned=one(own.filter(r=>r.kind==='post-return'),'Original return'),success=one(own.filter(r=>r.kind==='message'&&r.ok===true),'Fresh native success'),stop=one(own.filter(r=>r.kind==='terminate'),'Original terminate'),stopped=one(own.filter(r=>r.kind==='terminate-return'),'Original terminate return');
 assert.deepEqual(own.map(r=>r.kind),['action-begin','created','message','post','post-return','message','terminate','terminate-return','action-end'],'No cancellation, supersession, input, failed result or reused worker');
 const ordered=[begin,worker,ready,post,returned,success,stop,stopped,end];assert(ordered.every((r,i)=>!i||ordered[i-1].sequence<r.sequence));assert(own.filter(r=>r.workerId!==undefined).every(r=>r.workerId===worker.workerId));assert.equal(post.workerAction,action.id);assert.equal(success.workerAction,action.id);
 assert.equal(post.text,action.text);assert.deepEqual(success.token,post.token);for(const k of ['documentId','documentRevision','sessionId','generation'])assert.equal(post.token[k],action[k],'Original '+k);assert(post.token.layerId);assert(/^(0|[1-9][0-9]*)$/.test(post.token.layerVersion));assert(action.draftId&&action.draftId!==action.sessionId);
 assert(/^sha256:[a-f0-9]{64}$/.test(success.rasterHash)&&success.rasterHash.length===71);assert(success.rgbaBytes>0&&success.rgbaBytes===success.width*success.height*4);
 if(action.kind==='Preview'){
  assert.equal(action.beforeReady,false);assert(after.sameTextarea&&after.connected&&after.editable&&after.ready);assert.equal(after.value,action.text);assert.equal(after.draftId,action.draftId);assert.equal(after.revision,action.revision);assert.deepEqual(acceptedAfter,acceptedBefore);assert.equal(command,undefined);assert.equal(candidate,undefined);
 }else{
  assert.equal(action.kind,'Apply');assert.equal(action.beforeReady,true);assert.equal(after.hidden,true);
  assert(priorPreview?.qualified&&priorPreview.actionId!==action.id);assert.equal(priorPreview.draftId,action.draftId);assert.equal(priorPreview.revision,action.revision);assert.equal(priorPreview.rasterHash,success.rasterHash);assert.deepEqual(priorPreview.token,post.token);
  assert(['CreateTextLayer','CommitTextEdit','ReplaceTextFont'].includes(command.body.type));assert.deepEqual(candidate.token,post.token);assert.equal(command.body.layerId,post.token.layerId);assert.equal(command.body.draft.sessionId,action.sessionId);assert.equal(command.body.draft.draftId,action.draftId);assert.equal(Number(command.body.draft.generation),action.generation);assert.equal(candidate.source.render.pixels.hash,success.rasterHash);
  assert.equal(acceptedAfter.document.id,action.documentId);assert(BigInt(acceptedAfter.document.revision)>BigInt(action.documentRevision));assert.equal(acceptedAfter.layer.id,post.token.layerId);assert.deepEqual(acceptedAfter.source,candidate.source);assert.equal(acceptedAfter.text,action.text);assert.equal(acceptedAfter.pixelSHA256,success.rasterHash);assert.equal(acceptedAfter.pixelBytes,success.rgbaBytes);assert(acceptedAfter.commandSucceeded);
 }
 return {qualified:true,actionId:action.id,kind:action.kind,workerId:worker.workerId,draftId:action.draftId,revision:action.revision,token:post.token,rasterHash:success.rasterHash,consumption:'source-derived exact native consumption and validation',observedEOF:false,transportSuccessClaim:false};
}

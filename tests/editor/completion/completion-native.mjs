import assert from 'node:assert/strict';
const one=(rows,p,label)=>{const a=rows.filter(p);assert.equal(a.length,1,label);return a[0];};
const before=(...rows)=>rows.every((r,i)=>r&&Number.isInteger(r.sequence)&&(!i||rows[i-1].sequence<r.sequence));
export function assessNative({observation,action,publicAfter,expectedWorkerURL,disposal,mode='valid',hold,acceptedBefore,acceptedAfter}) {
  const {rows,errors,epoch}=observation;assert.deepEqual(errors,[],'Observer errors');assert(epoch);
  assert(rows.every((r,i)=>r.epoch===epoch&&r.sequence===i+1),'Lossless same-document observer sequence');
  const begin=one(rows,r=>r.kind==='action-begin'&&r.actionId===action.id,'One fresh action');assert.deepEqual(begin.action,action);
  const end=one(rows,r=>r.kind==='action-end'&&r.actionId===action.id,'One completed public action');
  const own=rows.filter(r=>r.actionId===action.id);assert.equal(rows.filter(r=>r.kind==='created').length,1,'No prior/recycled/mixed worker cohort');
  const w=one(own,r=>r.kind==='created','Original native worker');assert.equal(w.url,expectedWorkerURL);assert.equal(w.type,'module');assert(/^ideogram-text-\d+$/.test(w.name));
  assert(own.filter(r=>r.workerId!==undefined).every(r=>r.workerId===w.workerId),'Original Worker identity');
  const stop=one(own,r=>r.kind==='terminate','Genuine termination'),stopped=one(own,r=>r.kind==='terminate-return','Termination returned');assert(before(begin,w,stop,stopped,end));
  assert.equal(disposal.originalObject,true);assert.equal(disposal.closeSameObject,true);assert.equal(disposal.closed,true);assert.equal(disposal.targetDestroyed,true);
  assert.equal(publicAfter.sameTextarea,true);assert.equal(publicAfter.draftId,action.draftId);assert.equal(publicAfter.documentId,action.documentId);assert.equal(publicAfter.sessionId,action.sessionId);
  assert.equal(action.kind,'Preview');assert.equal(action.beforeReady,false);assert(action.draftId&&action.sessionId&&action.documentId);assert.notEqual(action.draftId,action.sessionId,'Draft identity is not session identity');
  assert.deepEqual(acceptedAfter,acceptedBefore,'Accepted document/pixels/history unchanged');
  const successes=own.filter(r=>r.kind==='message'&&r.ok===true),posts=own.filter(r=>r.kind==='post');
  assert(!own.some(r=>['post-error','terminate-error','worker-error'].includes(r.kind)),'No unowned native/observer errors');
  if(mode==='valid') {
    const ready=one(own,r=>r.kind==='message'&&r.ready,'Native engine ready'),post=one(own,r=>r.kind==='post','Original posted request'),returned=one(own,r=>r.kind==='post-return','Original post returned'),success=one(successes,()=>true,'One fresh matching success');
    assert(before(w,ready,post,returned,success,stop));assert.equal(post.workerAction,action.id);assert.equal(success.workerAction,action.id);assert.equal(post.text,action.text);
    assert.deepEqual(success.token,post.token);assert.equal(post.token.documentId,action.documentId);assert.equal(post.token.documentRevision,action.documentRevision);assert.equal(post.token.sessionId,action.sessionId);assert.equal(post.token.generation,action.generation);assert(post.token.layerId);assert(/^(0|[1-9][0-9]*)$/.test(post.token.layerVersion));
    assert(own.filter(r=>r.kind==='message').every(r=>r.ready||r.ok===true),'Failed cohort cannot inherit success');
    assert(/^sha256:[a-f0-9]{64}$/.test(success.rasterHash));assert.equal(success.rasterHash.length,71);assert(Number.isInteger(success.rgbaBytes)&&success.rgbaBytes>0);assert.equal(success.rgbaBytes,success.width*success.height*4);
    assert.equal(publicAfter.ready,true);assert.equal(publicAfter.value,action.text);assert.equal(publicAfter.revision,action.revision);assert.equal(publicAfter.cleanupStarted,false);
    return {qualified:true,actionId:action.id,workerId:w.workerId,token:post.token,consumption:'source-derived exact native consumption and validation',observedEOF:false,transportSuccessClaim:false};
  }
  assert.equal(successes.length,0,'Negative operation must never succeed');assert.equal(posts.length,0,'Negative engine preparation never reaches task posting');assert.equal(publicAfter.ready,false);assert.equal(publicAfter.cleanupStarted,false);
  if(mode==='cancelled') {
    const held=one(own,r=>r.kind==='partial-held','Original partial response boundary'),input=one(own,r=>r.kind==='native-input','One native input'),cancelled=one(own,r=>r.kind==='cancelled-public','Observed public cancellation');
    assert(before(w,held,input,stop,stopped,cancelled,end));assert.equal(input.trusted,true);assert.equal(input.connected,true);assert.equal(input.editable,true);assert.equal(input.draftId,action.draftId);assert.equal(input.value,'Changed while preparation is pending');assert.notEqual(input.value,action.text);
    assert.equal(publicAfter.value,input.value);assert(Number(publicAfter.revision)>Number(action.revision));assert.equal(publicAfter.error,'TEXT_CANCELLED');
    assert.equal(hold.activeAtInput,true);assert.equal(hold.releasedBeforeTermination,false);assert.equal(hold.cleanupBeforeTermination,false);assert.equal(hold.originalRequests,1);assert.equal(hold.originalResponse,true);assert(hold.bytesWritten>0&&hold.bytesWritten<hold.expectedBytes);assert.equal(hold.preparing,true);
    return {qualified:false,negativePassed:true,actionId:action.id,workerId:w.workerId,label:'input-invalidated preparation cancellation',sourceDerivedCancellation:true,observedReaderAbort:false};
  }
  assert(['corrupt','truncated'].includes(mode));assert.equal(publicAfter.value,action.text);assert.equal(publicAfter.revision,action.revision);
  const refused=one(own,r=>r.kind==='message'&&r.ok===false,'Native preparation refusal');assert(before(w,refused,stop));assert.equal(refused.fatal,true);assert.equal(refused.code,'TEXT_ENGINE_LOAD');assert.equal(publicAfter.error,'TEXT_ENGINE_LOAD');
  return {qualified:false,negativePassed:true,actionId:action.id,workerId:w.workerId,label:mode+' original WASM refused by native preparation'};
}

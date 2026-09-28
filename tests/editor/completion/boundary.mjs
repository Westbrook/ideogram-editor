import assert from 'node:assert/strict';
import {EXPECTED} from './app-buffer-core.mjs';
import {nativeOperation} from './operation.mjs';

// Observe only the test-owned main-page metadata array. Application Worker
// methods, worker realms, messages and native promises are untouched here.
export async function installBoundary({key,binding}) {
 const observer=globalThis[key],first=observer.snapshot(),rows=first.rows,push=rows.push;
 let deliverySequence=0;
 const send=value=>{try{globalThis[binding](JSON.stringify({origin:location.origin,epoch:first.epoch,deliverySequence:++deliverySequence,...value}));}catch(e){first.errors.push('Boundary delivery: '+String(e));}};
 for(const row of rows)send({kind:'row',row});
 Object.defineProperty(rows,'push',{value:function(...values){const result=Reflect.apply(push,this,values);for(const row of values)send({kind:'row',row});return result;}});
 addEventListener('pagehide',()=>send({kind:'pagehide',observation:observer.snapshot()}),{once:true});
 observer.boundaryFlush=async()=>{};
 await observer.boundaryFlush();return first;
}

export function nativeTargetsDisposed({owner,discovery,workers}) {
 const created=discovery.filter(e=>e.name==='Target.targetCreated'&&e.params.targetInfo.type==='worker');
 assert(created.length<=workers.length,'Unexpected native target');
 const ids=created.map(e=>e.params.targetInfo.targetId);assert.equal(new Set(ids).size,ids.length,'Recycled native target');
 let complete=created.length===workers.length&&workers.every(w=>w.originalObject&&w.closed&&w.closeSameObject);
 for(const id of ids){
  const infos=discovery.filter(e=>e.params.targetInfo?.targetId===id).map(e=>e.params.targetInfo);
  for(const t of infos){assert.equal(t.type,'worker');assert.equal(t.parentId,owner.targetId);assert.equal(t.parentFrameId,owner.frameId);assert.equal(t.browserContextId,owner.contextId);if(t.url)assert.equal(t.url,owner.origin+EXPECTED.workerPath);}
  const ends=discovery.filter(e=>e.name==='Target.targetDestroyed'&&e.params.targetId===id);assert(ends.length<=1,'Duplicate native destruction');complete&&=ends.length===1&&infos.some(t=>t.url===owner.origin+EXPECTED.workerPath);
 }
 return complete;
}

export function validateNative(e,observation) {
 assert.equal(observation.epoch,e.epoch);assert.deepEqual(observation.errors,[]);
 assert(observation.rows.every((r,i)=>r.epoch===e.epoch&&r.sequence===i+1),'Lossless epoch rows');
 const created=observation.rows.filter(r=>r.kind==='created');assert.equal(created.length,e.proofs.length,'Every native worker has an operation');
 for(const row of observation.rows.filter(r=>r.workerId!==undefined)){
  const owners=created.filter(c=>c.workerId===row.workerId);assert.equal(owners.length,1,'One original native owner');assert.equal(row.actionId,owners[0].actionId,'No native event outside its original action');
 }
 for(const op of e.operations)assert.deepEqual(nativeOperation({...op,observation}),op.proof);
 return observation;
}

export async function independentSteps(steps,failures) {
 for(const [phase,run] of steps)try{await run();}catch(error){failures.push({phase,message:String(error)});}
}

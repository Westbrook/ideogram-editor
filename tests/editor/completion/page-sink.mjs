import assert from 'node:assert/strict';

// The page session owns this sink. Numeric context IDs are joined only to the
// retained, unrecycled default-context generation bound before observation.
export function pageReceiptSink({session,send,name,receipts,fail}) {
 const contexts=[],raw=[],errors=[];let sequence=0,installed=false;
 const reject=error=>{errors.push(String(error));fail(error);};
 const listen=(event,fn)=>session.on(event,params=>{const row={sequence:++sequence,event,params:structuredClone(params)};raw.push(row);try{fn(params,row);}catch(e){reject(e);}});
 listen('Runtime.executionContextCreated',({context:c},row)=>{
  assert(Number.isInteger(c.id)&&c.uniqueId,'Actual execution context identity');
  assert(!contexts.some(x=>x.uniqueId===c.uniqueId),'Duplicate context generation');
  contexts.push({...c,created:row.sequence,live:true});
 });
 listen('Runtime.executionContextDestroyed',(p,row)=>{const matches=contexts.filter(c=>c.id===p.executionContextId&&c.live);assert.equal(matches.length,1,'Known live destroyed context');if(p.executionContextUniqueId)assert.equal(matches[0].uniqueId,p.executionContextUniqueId);matches[0].live=false;matches[0].destroyed=row.sequence;});
 listen('Runtime.executionContextsCleared',(_p,row)=>{for(const c of contexts.filter(c=>c.live)){c.live=false;c.cleared=row.sequence;}});
 listen('Runtime.bindingCalled',(p,row)=>{
  if(p.name!==name)return;
  const matches=contexts.filter(c=>c.id===p.executionContextId);assert.equal(matches.length,1,'Unambiguous unrecycled binding context');
  const c=matches[0];assert(c.epoch&&c.owner&&c.auxData?.isDefault,'Binding context was owned before observation');
  assert.equal(typeof p.payload,'string');assert(p.payload.length<=33554432,'Bounded main-page receipt');const value=JSON.parse(p.payload);
  assert.equal(value.origin,c.owner.origin);assert.equal(value.epoch,c.epoch);assert(['row','pagehide'].includes(value.kind));
  assert.equal(value.deliverySequence,++c.delivered,'Gap-free original receipt delivery');
  assert(!c.final,'No activity after genuine pagehide');if(value.kind==='pagehide')c.final=row.sequence;
  receipts.push({...value,ownerPage:true,ownerFrame:true,executionContextId:c.id,executionContextUniqueId:c.uniqueId,frameId:c.owner.frameId,contextCreated:c.created,received:row.sequence});
 });
 return {contexts,raw,errors,
  async install(){assert(!installed);await send('Runtime.enable',{},'owned-page-CDPSession-1');await send('Runtime.addBinding',{name},'owned-page-CDPSession-1');installed=true;},
  bind(owner,epoch){assert(installed);assert.deepEqual(errors,[]);const matches=contexts.filter(c=>c.live&&c.origin===owner.origin&&c.auxData?.isDefault&&c.auxData.frameId===owner.frameId);assert.equal(matches.length,1,'One original main default context');const c=matches[0];assert.equal(contexts.filter(x=>x.id===c.id).length,1,'No recycled numeric context');assert(!c.epoch,'Context belongs to one document epoch');assert(!contexts.some(x=>x.epoch===epoch),'Unique document epoch');c.owner=structuredClone(owner);c.epoch=epoch;c.delivered=0;return {id:c.id,uniqueId:c.uniqueId,frameId:owner.frameId,origin:owner.origin,epoch};},
  final(epoch){assert.deepEqual(errors,[]);const c=contexts.filter(c=>c.epoch===epoch);assert.equal(c.length,1);return Number.isInteger(c[0].final);},
  async remove(){assert.deepEqual(errors,[]);await send('Runtime.removeBinding',{name},'owned-page-CDPSession-1');},
 };
}

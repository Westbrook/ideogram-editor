import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HOST_TIMEOUT,hostBudget,assessHostFinal,departureState,one} from './host-final-core.mjs';
import {hostFinalInit,installHostFinal,inspectHostHandler,HOST_HANDLER_SOURCE} from './host-final-page.mjs';
export async function integrationHostFinal({page,context,send,sink,boundaries,key,fixture}){
 const run=randomUUID(),hostKey=key+'Host',namespace='__p1c6_host_'+run+':',budget=hostBudget({run,fixture}),originalPage=page,originalFrame=page.mainFrame(),epochs=[];
 await context.addInitScript(hostFinalInit,{key:hostKey});
 const original=()=>{assert.equal(page,originalPage);assert.equal(page.context(),context);assert.equal(page.mainFrame(),originalFrame);assert(!page.isClosed());};
 const inspect=e=>inspectHostHandler({page,send,hostKey,registration:e.hostRegistration});
 function assess(e){const reg=one(e.hostSnapshot.registrations.filter(r=>r.epoch===e.epoch),'Own host epoch'),body=one(e.hostSnapshot.bodies.filter(b=>b.id===reg.receiptId),'Own host body');assert.deepEqual(e.hostSnapshot.errors,[]);assert.equal(e.hostSnapshot.pid,e.pid);assert.equal(e.hostSnapshot.instance,e.hostInstance);const result=assessHostFinal({e,registration:reg,body,journal:e.hostJournal,boundaries,contexts:sink.contexts,handlerSource:HOST_HANDLER_SOURCE});assert.equal(result.phase,e.departure.data.phase);return result;}
 return {data:{run,namespace,budget:budget.data},
  async activate(e){original();const server=await e.server.host('configure',{run,origin:e.origin});assert.equal(server.pid,e.pid);assert.equal(server.origin,e.origin);assert.equal(server.instance,e.server.instance);e.hostInstance=server.instance;
   const c=e.defaultContext,contextIdentity={pageObjectId:'original-application-page',frameObjectId:'original-main-frame',targetId:e.owner.targetId,browserContextId:e.owner.contextId,frameId:e.owner.frameId,id:c.id,uniqueId:c.uniqueId,isDefault:true,epoch:e.epoch};
   e.hostRegistration=await e.server.host('allocate',{epoch:e.epoch,context:contextIdentity,url:e.origin+'/',namespace});assert.equal(e.hostRegistration.instance,server.instance);e.departure=departureState();Object.defineProperty(e.departure,'toJSON',{value(){return this.data;}});epochs.push(e);
   e.hostInstalled=await page.evaluate(installHostFinal,{key,binding:key+'Boundary',hostKey,registration:e.hostRegistration});assert.equal(e.hostInstalled.epoch,e.epoch);return e.hostInstalled;
  },
  async arm(e,phase){original();e.departure.begin(phase);try{assert(e.closed&&e.navigationSealed&&!e.failure,'Successfully closed native epoch');assert.equal(page.url(),e.origin+'/');const inspection=await inspect(e),reservation=budget.reserve(e.hostRegistration);e.hostRegistration=await e.server.host('arm',{nonce:e.hostRegistration.nonce,value:{phase,nativeClosed:e.nativeClosed,inspection,nativeMethod:e.hostInstalled.nativeMethod,budget:reservation}});await page.evaluate(({hostKey,closed})=>globalThis[hostKey].arm(closed),{hostKey,closed:e.nativeClosed});}catch(error){e.departure.fail(error);throw error;}},
  async depart(e){original();assert(e.hostRegistration.armed);const deadline=Date.now()+HOST_TIMEOUT;e.hostDeadline=deadline;try{await page.goto(e.origin+e.hostRegistration.receiver,{timeout:HOST_TIMEOUT});assert.equal(page.url(),e.origin+e.hostRegistration.receiver);original();e.hostSnapshot=await e.server.host('drain',{nonce:e.hostRegistration.nonce,deadline});assert(Date.now()<=deadline,'Single departure deadline retained');e.hostJournal=await page.evaluate(k=>sessionStorage.getItem(k),namespace+e.epoch);e.hostFinal=assess(e);const r=one(e.hostSnapshot.registrations.filter(r=>r.epoch===e.epoch),'Own host epoch');budget.charge(r,one(e.hostSnapshot.bodies.filter(b=>b.id===r.receiptId),'Own host charge'));e.departure.drain(e.hostFinal);
    e.hostJournalRemoval=await page.evaluate(({key,namespace})=>{sessionStorage.removeItem(key);return {key,absent:sessionStorage.getItem(key)===null,remaining:Object.keys(sessionStorage).filter(k=>k.startsWith(namespace))};},{key:namespace+e.epoch,namespace});assert(e.hostJournalRemoval.absent);assert.deepEqual(e.hostJournalRemoval.remaining,[]);
   }catch(error){e.departure.fail(error);throw error;}
  },
  async refresh(e){e.hostSnapshot=await e.server.host('snapshot');e.hostFinal=assess(e);e.departure.require('teardown');return e.hostFinal;},
  retained(e){e.hostFinal=assess(e);e.departure.require('qualification');return e.hostFinal;},
  requireDrained(){for(const e of epochs)e.departure.require('teardown');budget.assertComplete();},
 };
}

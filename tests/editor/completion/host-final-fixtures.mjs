// Injected non-browser evidence for exercising the actual host assessor/monitor.
// These original-object claims are fixture inputs, never live capability proof.
import assert from 'node:assert/strict';
import {HOST_HANDLER_SOURCE} from './host-final-page.mjs';
import {digest,assessHostFinal,hostBudget,departureState} from './host-final-core.mjs';
import {installBoundary} from './boundary.mjs';
export function hostFixture(e={epoch:'epoch',origin:'http://127.0.0.1:34567',pid:123,nativeClosed:{epoch:'epoch',rows:[],errors:[]},operations:[],proofs:[]},phase='terminal'){
 const origin=e.origin,context={pageObjectId:'original-application-page',frameObjectId:'original-main-frame',targetId:'page',browserContextId:'context',frameId:'page',id:e.defaultContext?.id??1,uniqueId:e.defaultContext?.uniqueId??'default-context-1',isDefault:true,epoch:e.epoch};
 const r={run:'run',instance:'instance',origin,pid:e.pid,epoch:e.epoch,url:origin+'/',namespace:'owned:',nonce:'nonce',path:'/__p1c6-completion/run/nonce/final',receiver:'/__p1c6-completion/run/nonce/receiver',context,phase,armed:true,nativeClosed:structuredClone(e.nativeClosed),nativeMethod:{original:true,source:'function sendBeacon() { [native code] }'},inspection:{errors:[],released:true,source:HOST_HANDLER_SOURCE,context:structuredClone(context)},receiptId:1};
 const p={origin,epoch:e.epoch,deliverySequence:e.nativeClosed.rows.length+1,kind:'pagehide',observation:structuredClone(e.nativeClosed),event:{type:'pagehide',isTrusted:true,persisted:false,url:origin+'/',origin,timeStamp:123},nonce:r.nonce,context};const bytes=Buffer.from(JSON.stringify(p)),headers={origin,host:new URL(origin).host,'sec-fetch-site':'same-origin','content-type':'text/plain;charset=UTF-8'};
 const body={id:1,path:r.path,registration:r.nonce,run:r.run,origin,pid:r.pid,instance:r.instance,method:'POST',headers,rawHeaders:Object.entries(headers).flat(),incomingMessage:true,serverResponse:true,responseOwnRequest:true,incomingObject:1,responseObject:2,socketObject:3,socket:{localPort:Number(new URL(origin).port),remotePort:54321,localAddress:'127.0.0.1',remoteAddress:'127.0.0.1'},errors:[],end:true,complete:true,closed:true,completeAtClose:true,bodyValidated:true,responseFinished:true,responseClosed:true,responseWritableFinished:true,responseStatus:204,bytes:bytes.length,sha256:digest(bytes),rawBase64:bytes.toString('base64'),chunks:[{sequence:1,bytes:bytes.length,sha256:digest(bytes),base64:bytes.toString('base64')}],payload:p};
 const journal={namespace:r.namespace,key:r.namespace+r.epoch,context,steps:['installed','armed','entered','serialized','binding-return','beacon-return','retained'],errors:[],snapshot:p,binding:{returned:true},beacon:{attempts:1,returned:true},serialization:{ok:true,bytes:bytes.length},nativeMethod:r.nativeMethod,finalObservation:structuredClone(e.nativeClosed)};
 const contexts=[{id:context.id,uniqueId:context.uniqueId,epoch:r.epoch,auxData:{isDefault:true,frameId:'page'},owner:{targetId:'page',contextId:'context'},live:false}],boundaries=e.nativeClosed.rows.map(row=>({epoch:r.epoch,kind:'row',row,ownerPage:true,ownerFrame:true,executionContextId:context.id,executionContextUniqueId:context.uniqueId,frameId:'page'}));
 e.hostRegistration=structuredClone(r);return {e,registration:r,body,journal:JSON.stringify(journal),boundaries,contexts,handlerSource:HOST_HANDLER_SOURCE};
}
export async function injectedHostFinal({page,sink,boundaries,key,fixture='combined'}){
 const epochs=[],data={injectedNonBrowser:true,run:'run',budget:hostBudget({run:'run',fixture}).data};
 return {data,async activate(e){e.departure=departureState();Object.defineProperty(e.departure,'toJSON',{value(){return this.data;}});epochs.push(e);await page.evaluate(installBoundary,{key,binding:key+'Boundary'});},
 async arm(e,phase){e.departure.begin(phase);assert(e.closed&&e.navigationSealed);assert.deepEqual(await page.evaluate(k=>globalThis[k].snapshot(),key),e.nativeClosed,'Original page snapshot unchanged before arm');},
 async depart(e){const x=hostFixture(e,e.departure.data.phase);x.contexts=sink.contexts;x.boundaries=boundaries;Object.defineProperty(e,'injectedHostEvidence',{value:x,configurable:true});e.hostFinal=assessHostFinal(x);e.departure.drain(e.hostFinal);},
 async refresh(e){e.hostFinal=assessHostFinal(e.injectedHostEvidence);return e.hostFinal;},
 retained(e){assert(e.injectedHostEvidence,'Original host final required');e.departure.require('qualification');return assessHostFinal(e.injectedHostEvidence);},
 requireDrained(){for(const e of epochs){assert(e.injectedHostEvidence,'Original host final required');e.departure.require('teardown');}},
 };
}

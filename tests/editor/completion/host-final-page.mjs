import assert from 'node:assert/strict';
export function hostFinalInit({key}){
 if(!['http:','https:'].includes(location.protocol))return;
 const state={pageshows:[],errors:[]};Object.defineProperty(globalThis,key,{value:state});
 addEventListener('pageshow',event=>{state.pageshows.push({type:event.type,isTrusted:event.isTrusted,persisted:event.persisted,url:location.href,origin:location.origin});});
}
export function installHostFinal({key,binding,hostKey,registration}){
 const state=globalThis[hostKey],observer=globalThis[key],first=observer.snapshot(),rows=first.rows,push=rows.push;
 if(first.epoch!==registration.epoch)throw Error('Original host epoch');
 const journal={namespace:registration.namespace,key:registration.namespace+first.epoch,context:registration.context,steps:[],errors:[]};state.journal=journal;state.registration=registration;state.armed=false;
 const nativeBeacon=navigator.sendBeacon,nativeMethod={original:Object.getOwnPropertyDescriptor(Navigator.prototype,'sendBeacon')?.value===nativeBeacon,source:Function.prototype.toString.call(nativeBeacon)};journal.nativeMethod=nativeMethod;state.nativeMethod=nativeMethod;
 const write=phase=>{journal.steps.push(phase);try{if(journal.steps.length>8)throw Error('Owned journal step bound');const text=JSON.stringify(journal);if(new TextEncoder().encode(text).length>262144)throw Error('Owned journal size bound');sessionStorage.setItem(journal.key,text);}catch(e){journal.errors.push({phase,error:String(e)});}};
 let deliverySequence=0,beaconAttempts=0;
 const send=row=>{try{globalThis[binding](JSON.stringify({origin:location.origin,epoch:first.epoch,deliverySequence:++deliverySequence,kind:'row',row}));}catch(e){first.errors.push('Boundary delivery: '+String(e));}};
 for(const row of rows)send(row);Object.defineProperty(rows,'push',{value:function(...values){const result=Reflect.apply(push,this,values);for(const row of values)send(row);return result;}});
 state.arm=closed=>{if(state.armed||JSON.stringify(observer.snapshot())!==JSON.stringify(closed))throw Error('Original closed native snapshot before arm');if(journal.errors.length||first.errors.length)throw Error('Observer error before arm');state.armed=true;state.closed=JSON.stringify(closed);write('armed');};
 function genuineIntegrationHostFinal(event){
  write('entered');
  try{
   if(!state.armed)throw Error('Unarmed genuine departure');
   if(event.type!=='pagehide'||!event.isTrusted||event.persisted)throw Error('Genuine non-persisted pagehide required');
   if(JSON.stringify(observer.snapshot())!==state.closed)throw Error('Native changed after arm');
   const payload=JSON.stringify({origin:location.origin,epoch:first.epoch,deliverySequence:++deliverySequence,kind:'pagehide',observation:observer.snapshot(),event:{type:event.type,isTrusted:event.isTrusted,persisted:event.persisted,timeStamp:event.timeStamp,url:location.href,origin:location.origin},nonce:registration.nonce,context:registration.context});
   const bytes=new TextEncoder().encode(payload).length;if(bytes>32768)throw Error('Complete host final exceeds reservation');journal.serialization={ok:true,bytes};journal.snapshot=JSON.parse(payload);write('serialized');
   try{globalThis[binding](payload);journal.binding={returned:true};write('binding-return');}catch(e){journal.binding={returned:false,error:String(e)};first.errors.push(String(e));write('binding-error');}
   if(!nativeMethod.original||nativeMethod.source!=='function sendBeacon() { [native code] }'||navigator.sendBeacon!==nativeBeacon)throw Error('Original native beacon identity');
   if(new URL(registration.path,location.href).origin!==location.origin||++beaconAttempts!==1)throw Error('One same-origin native beacon');
   journal.beacon={attempts:beaconAttempts,returned:Reflect.apply(nativeBeacon,navigator,[registration.path,payload])};write('beacon-return');
   journal.finalObservation=JSON.parse(JSON.stringify(observer.snapshot()));write('retained');
  }catch(e){journal.failure=String(e);first.errors.push(String(e));write('failure');}
 }
 addEventListener('pagehide',genuineIntegrationHostFinal,{once:true});write('installed');observer.boundaryFlush=async()=>{};return {epoch:first.epoch,nativeMethod};
}
import {HOST_HANDLER_SOURCE} from './host-handler-artifact.mjs';
export {HOST_HANDLER_SOURCE} from './host-handler-artifact.mjs';
export async function inspectHostHandler({page,send,hostKey,registration:r}){
 const group='integration-host-'+r.nonce,result={context:structuredClone(r.context),errors:[],released:false};
 try{const remote=await send('Runtime.evaluate',{expression:'window',contextId:r.context.id,objectGroup:group,returnByValue:false},'owned-page-CDPSession-1');assert(!remote.exceptionDetails);assert(remote.result.objectId&&remote.result.className==='Window');result.remote=remote.result;
 const ls=(await send('DOMDebugger.getEventListeners',{objectId:remote.result.objectId},'owned-page-CDPSession-1')).listeners;result.listeners=ls;
 const own=ls.filter(x=>x.type==='pagehide'&&x.handler?.description?.includes('genuineIntegrationHostFinal'));assert.equal(own.length,1);assert.equal(own[0].once,true);assert(own[0].handler.objectId&&own[0].scriptId&&Number.isInteger(own[0].lineNumber)&&Number.isInteger(own[0].columnNumber));
 const source=await send('Runtime.callFunctionOn',{objectId:own[0].handler.objectId,functionDeclaration:'function(){return Function.prototype.toString.call(this)}',returnByValue:true},'owned-page-CDPSession-1');assert(!source.exceptionDetails);result.source=source.result.value;assert.equal(result.source,HOST_HANDLER_SOURCE);
 result.pageshows=await page.evaluate(k=>globalThis[k].pageshows,hostKey);assert.equal(result.pageshows.length,1);assert.deepEqual(result.pageshows[0],{type:'pageshow',isTrusted:true,persisted:false,url:r.url,origin:r.origin});
 }catch(e){result.errors.push(String(e));}finally{try{await send('Runtime.releaseObjectGroup',{objectGroup:group},'owned-page-CDPSession-1');result.released=true;}catch(e){result.errors.push(String(e));}}
 assert.deepEqual(result.errors,[]);return result;
}

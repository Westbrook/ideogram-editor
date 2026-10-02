import {allocationLedger,type ObservedPromptLease} from '../observability/allocations.js';
import type {OwnedModel} from '../observability/model-memory.js';

export const REQUEST_PROMPT_HEADROOM=65536;
export const REQUEST_PROMPT_REFUSAL='Request draft workspace is full. Your full input remains in the editor. Release another preview or revise this prompt, then retry saving. The previous saved draft is retained.';
export const REQUEST_PROMPT_INSERTION='This insertion exceeds the available prompt workspace. No part of the insertion was accepted. Shorten it or release another preview, then try again.';
export const REQUEST_PROMPT_NATIVE_OVERFLOW='The native editor accepted input beyond its admitted workspace. Your text remains in place. Shorten it or release another preview, then retry saving; the previous saved draft is retained.';

/** Keeps native value, retained raw value, previous rendered value, and a pending
 * native event within one prospective logical UTF-16 allowance. Browser-private
 * undo/layout allocations remain outside this logical payload measurement. */
export type PromptNative={value:string;isConnected:boolean;readonly updateComplete?:Promise<unknown>};
export class RequestPromptInput {
 private lease:ObservedPromptLease;private refs=1;private live=true;private registration:()=>void;
 private native:PromptNative|null=null;private observedValue:string|null=null;private generation=0;private observedUnits=0;private inheritedUnits=0;private eventUnits=0;private eventTurn:ReturnType<typeof setTimeout>|undefined;private externalPins=0;
 private settlement:Promise<void>|null=null;private pendingSettlement:{generation:number;node:PromptNative;render:()=>Promise<unknown>;owns:()=>boolean}|null=null;private waiter:(()=>void)|null=null;private nativeRetired=false;settlementFailed=false;
 private raw:string;private units:number;private upper:number;
 refused=false;nativeOverflow=false;insertionRefused=false;
 constructor(readonly id:string,readonly documentId:string,readonly owner:object,initial:string,maximum:number,register:()=>()=>void){
  if(!Number.isSafeInteger(maximum)||maximum<initial.length||maximum<0)throw Error('REQUEST_PROMPT_LIMIT');
  this.upper=maximum;this.units=Math.max(initial.length,Math.min(REQUEST_PROMPT_HEADROOM,maximum));
  this.registration=register();
  try{this.lease=allocationLedger.reserveObservedPrompt({owner:'request-prompt-input',cpuBytes:this.units*8+1024,handles:5});}catch(error){this.registration();throw error;}
  this.raw=initial;
 }
 get value(){this.current();return this.raw;}get capacity(){return this.units;}get maximum(){return this.upper;}
 get observedCPUBytes(){return this.observedUnits*8+1024;}get observationGeneration(){return this.generation;}
 get pendingValue(){this.current();return this.observedValue??this.raw;}
 private observeUnits(units:number){if(!Number.isSafeInteger(units)||units<0||!Number.isSafeInteger(units*8+1024))throw Error('REQUEST_PROMPT_OBSERVATION');this.observedUnits=Math.max(this.observedUnits,units);this.lease.observeCPUBytes(this.observedUnits*8+1024);}
 /** This records bytes that already exist. It never grants permission to save,
  * clone, serialize or publish them. The one retained native value is bounded
  * by the browser string itself, rather than silently clamped to an allowance. */
 observeNative(node:PromptNative,value:string,actualDraft=true){this.current();if(this.native&&this.native!==node)throw Error('REQUEST_PROMPT_NATIVE_CHANGED');if(this.nativeRetired)throw Error('REQUEST_PROMPT_RETIRED');this.observeUnits(Math.max(value.length,this.raw.length,this.eventUnits,this.inheritedUnits));if(actualDraft)this.inheritedUnits=0;this.native=node;this.observedValue=value;this.generation++;this.wake();}
 /** A reused connected control can retain an older IME draft behind a shorter
  * accepted value. Strictly admit its full previous floor before transferring;
  * only a later actual draft observation can establish replacement. */
 inheritNative(node:PromptNative,observedCPUBytes:number){
  this.current();if(this.nativeRetired||this.native&&this.native!==node)throw Error('REQUEST_PROMPT_NATIVE_CHANGED');
  if(!Number.isSafeInteger(observedCPUBytes)||observedCPUBytes<1024||(observedCPUBytes-1024)%8)throw Error('REQUEST_PROMPT_OBSERVATION');
  const units=(observedCPUBytes-1024)/8;this.admit(units);this.inheritedUnits=Math.max(this.inheritedUnits,units);this.observeUnits(this.inheritedUnits);this.native=node;this.observedValue=this.raw;this.generation++;this.wake();
 }
 observeEventData(value:string|null|undefined){
  this.current();if(typeof value!=='string')return;this.eventUnits=Math.max(this.eventUnits,value.length);this.observeUnits(Math.max(this.eventUnits,this.raw.length,this.observedValue?.length??0));this.generation++;
  // A single task-end hold covers real input-event data. Predicted insertion
  // length is used only by strict admit(), never by this observation.
  if(this.eventTurn===undefined){this.refs++;this.eventTurn=setTimeout(()=>{this.eventTurn=undefined;this.eventUnits=0;this.wake();this.unref();},0);}
 }
 private wake(){const waiter=this.waiter;this.waiter=null;waiter?.();}
 private async unpinned(){while(this.externalPins||this.eventTurn!==undefined)await new Promise<void>(resolve=>{this.waiter=resolve;});}
 /** One task per input, latest generation only; no per-event observation log.
  * Refund requires actual current native value, both render boundaries and
  * retirement of every old event/action pin. Failed boundaries retain debt. */
 settleNative(render:()=>Promise<unknown>,owns:()=>boolean):Promise<void>{
  this.current();if(!this.native||this.nativeRetired)return Promise.resolve();this.pendingSettlement={generation:this.generation,node:this.native,render,owns};this.wake();if(this.settlement)return this.settlement;
  this.refs++;const task=Promise.resolve().then(async()=>{try{for(;;){const pending=this.pendingSettlement;if(!pending)return;await pending.render();await pending.node.updateComplete;await this.unpinned();if(this.nativeRetired)return;if(this.pendingSettlement!==pending)continue;if(pending.generation!==this.generation)return;
    if(pending.node!==this.native||!pending.owns())return;const current=pending.node.value;this.observeUnits(Math.max(current.length,this.raw.length,this.observedValue?.length??0,this.eventUnits));
    // A stale public control value during composition cannot retire the full
    // newer detail string retained by the input owner.
    if(current!==this.observedValue)return;
    const units=Math.max(current.length,this.raw.length,this.eventUnits,this.inheritedUnits);this.lease.reconcileCPUBytes(units*8+1024);this.observedUnits=units;this.settlementFailed=false;return;
   }}catch(error){this.settlementFailed=true;throw error;}finally{this.pendingSettlement=null;this.settlement=null;this.unref();}});this.settlement=task;return task;
 }
 retryValue(){this.current();if(!this.nativeOverflow)return this.raw;if(!this.native||this.observedValue===null)throw Error('The refused native prompt is unavailable.');const current=this.native.value;this.observeUnits(Math.max(current.length,this.raw.length,this.observedValue.length));if(current!==this.observedValue)throw Error('The native prompt is still settling. Your complete input is retained.');return this.observedValue;}
 /** Parent rendering has removed the control or published its admitted successor.
  * Disconnection retires app graph ownership only; it does not prove opaque
  * native buffer/engine release. Keep the node through all old action pins. */
 async retireNative(successor:(node:PromptNative)=>boolean){
  this.current();if(this.nativeRetired)return;const native=this.native,generation=++this.generation;this.pendingSettlement=null;this.wake();
  const current=()=>{if(generation!==this.generation||native!==this.native)throw Error('REQUEST_PROMPT_NATIVE_CHANGED');};
  if(native){await native.updateComplete;current();if(native.isConnected&&!successor(native))throw Error('REQUEST_PROMPT_NATIVE_RETAINED');}
  this.nativeRetired=true;this.wake();
 }

 private current(){if(!this.refs)throw Error('REQUEST_PROMPT_RELEASED');}
 limit(maximum:number){this.current();if(!Number.isSafeInteger(maximum)||maximum<this.raw.length)throw Error('REQUEST_PROMPT_LIMIT');this.upper=maximum;}
 admit(units:number){
  if(!this.refs)throw Error('REQUEST_PROMPT_RELEASED');
  if(!Number.isSafeInteger(units)||units<0||units>this.upper)throw Error('REQUEST_PROMPT_LIMIT');
  if(units<=this.units)return;
  const next=Math.min(this.upper,Math.max(units,this.units*2,REQUEST_PROMPT_HEADROOM));
  this.lease.resize({cpuBytes:next*8+1024});this.units=next;
 }
 capture(value:string){this.current();if(value.length>this.units||value.length>this.upper)throw Error('REQUEST_PROMPT_NOT_ADMITTED');this.raw=value;this.nativeOverflow=false;this.insertionRefused=false;}
 saved(value:string){this.capture(value);this.refused=false;}
 private unref(){if(!--this.refs){this.raw='';this.observedValue=null;this.native=null;this.inheritedUnits=0;this.observedUnits=0;this.lease.reconcileCPUBytes(0);this.lease.release();this.registration();}}
 pin(){if(!this.refs)throw Error('REQUEST_PROMPT_RELEASED');this.refs++;this.externalPins++;let live=true;return ()=>{if(live){live=false;this.externalPins--;this.wake();this.unref();}};}
 release(){if(this.live){if(this.native&&!this.nativeRetired)throw Error('REQUEST_PROMPT_NATIVE_RETAINED');this.live=false;this.unref();}}
}

/** Registration survives the Entry's root and every existing async/render pin. */
export function registerRequestEntry<T>(model:OwnedModel<T>,register:()=>()=>void):OwnedModel<T>{
 const unregister=register();let refs=1,live=true;const unref=()=>{if(!--refs)unregister();};
 return {value:model.value,release(){if(live){live=false;model.release();unref();}},pin(){if(!refs)throw Error('REQUEST_ENTRY_REGISTRATION_RELEASED');const release=model.pin();refs++;let held=true;return ()=>{if(held){held=false;release();unref();}};}};
}

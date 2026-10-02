import type {LitElement} from 'lit';
import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import {modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';

export const NATIVE_CONTROL_LIMITS=Object.freeze({models:96,actions:32,modelBytes:32*1024**2,diagnosticUnits:4096});
/** Bounded logical application payload owners. Native control undo history and
 * engine object headers are not estimated here. Failed commits retain owners. */
export class NativeControlMemory {
 private models=new Set<OwnedModel<unknown>>();private retired=new Set<OwnedModel<unknown>>();private failed=new Set<OwnedModel<unknown>>();private pending=new Set<Promise<void>>();private actions=0;
 constructor(private host:Pick<LitElement,'requestUpdate'|'updateComplete'>){}
 create<T>(label:string,allowance:number,create:()=>T,measure:(value:T)=>number=modelPayloadBytes,handles=1):OwnedModel<T>{
  if(this.models.size>=NATIVE_CONTROL_LIMITS.models)throw Error('NATIVE_CONTROL_MODELS');
  if(!Number.isSafeInteger(allowance)||allowance<0||allowance>NATIVE_CONTROL_LIMITS.modelBytes)throw Error('NATIVE_CONTROL_BYTES');
  const lease=allocationLedger.reserve({owner:'native-'+label,kind:'prompt',cpuBytes:allowance,handles});let model:OwnedModel<T>;
  try{const value=create(),actual=measure(value);if(!Number.isSafeInteger(actual)||actual<0||actual>allowance)throw Error('NATIVE_CONTROL_ALLOWANCE');lease.resize({cpuBytes:actual});let refs=1,live=true;
   const unref=()=>{if(!--refs){this.models.delete(model);lease.release();}};
   model=Object.freeze({value,release:()=>{if(live){live=false;unref();}},pin:()=>{if(!refs)throw Error('NATIVE_CONTROL_RELEASED');refs++;let pinned=true;return ()=>{if(pinned){pinned=false;unref();}};}});this.models.add(model);return model;
  }catch(error){lease.release();throw error;}
 }
 clone<T>(label:string,value:T,extra=0){return this.create(label,modelPayloadBytes(value)+extra,()=>structuredClone(value));}
 workspace(label:string,bytes:number,handles=1):AllocationLease{return allocationLedger.reserve({owner:'native-'+label,kind:'prompt',cpuBytes:bytes,handles});}
 action(){if(this.actions>=NATIVE_CONTROL_LIMITS.actions)throw Error('NATIVE_CONTROL_ACTIONS');const lease=allocationLedger.reserve({owner:'native-action',kind:'control',cpuBytes:512,handles:2});this.actions++;let live=true;return ()=>{if(live){live=false;this.actions--;lease.release();}};}
 retire(model:OwnedModel<unknown>){if(this.retired.has(model))return;this.retired.add(model);this.schedule(model);}
 private schedule(model:OwnedModel<unknown>){const pending=Promise.resolve().then(()=>{this.host.requestUpdate();return this.host.updateComplete;}).then(()=>{model.release();this.retired.delete(model);}).catch(()=>{this.failed.add(model);});this.pending.add(pending);void pending.then(()=>this.pending.delete(pending));}
 async drain(){while(this.pending.size)await Promise.all([...this.pending]);for(const model of this.failed){this.failed.delete(model);this.schedule(model);}while(this.pending.size)await Promise.all([...this.pending]);if(this.failed.size)throw Error('NATIVE_CONTROL_RENDER_RELEASE');}
 inspect(){return {models:this.models.size,retired:this.retired.size,failed:this.failed.size,pending:this.pending.size,actions:this.actions};}
}

export function nativeDiagnostic(error:unknown){
 const message=error instanceof Error?error.message:typeof error==='string'?error:'Text operation unavailable.';
 return message.length<=NATIVE_CONTROL_LIMITS.diagnosticUnits?message:'Text operation returned an oversized diagnostic. Full text and the previous accepted appearance are retained.';
}

import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import type {MaskPlan} from '../raster/mask.js';

export const MASK_MEMORY_LIMITS=Object.freeze({modelBytes:4*1024**2,historyBytes:16*1024**2,historyEntries:64,formBytes:512*1024,points:32768});
/** Logical JSON payload bytes, with a bounded traversal before any clone. */
export function maskPayloadBytes(value:unknown){let nodes=0;const visit=(value:unknown,depth:number):number=>{
 if(++nodes>262144||depth>64)throw Error('REQUEST_MASK_MODEL_LIMIT');
 if(value===null||value===undefined)return 0;if(typeof value==='string')return value.length*2;if(typeof value==='number')return 8;if(typeof value==='boolean')return 1;
 let size=0;if(Array.isArray(value)){for(const item of value)size+=visit(item,depth+1);}else if(typeof value==='object'){for(const key in value)if(Object.hasOwn(value,key))size+=key.length*2+visit((value as Record<string,unknown>)[key],depth+1);}else throw Error('REQUEST_MASK_MODEL_VALUE');
 if(size>MASK_MEMORY_LIMITS.modelBytes)throw Error('REQUEST_MASK_MODEL_LIMIT');return size;
 };const bytes=visit(value,0);if(bytes>MASK_MEMORY_LIMITS.modelBytes)throw Error('REQUEST_MASK_MODEL_LIMIT');return bytes;}
type Owned={value:MaskPlan;bytes:number;lease:AllocationLease};
export type PreparedMask={readonly value:MaskPlan;release():void;take():Owned};
export class RequestMaskMemory {
 private current:Owned|null=null;private history:Owned[]=[];private form?:AllocationLease;private formBytes=0;
 get value(){return this.current?.value??null;}get historyLength(){return this.history.length;}get previous(){return this.history.at(-1)?.value;}
 get ownership(){return {currentModels:this.current?1:0,historyModels:this.history.length,modelBytes:(this.current?.bytes??0)+this.history.reduce((n,row)=>n+row.bytes,0),formBytes:this.formBytes};}
 prepare(value:MaskPlan,remember=true):PreparedMask{
  const bytes=maskPayloadBytes(value),historyBytes=this.history.reduce((n,row)=>n+row.bytes,0)+(remember?(this.current?.bytes??0):0);
  if(remember&&this.current&&(this.history.length>=MASK_MEMORY_LIMITS.historyEntries||historyBytes>MASK_MEMORY_LIMITS.historyBytes))throw Error('Request mask undo history is full. Clear its local undo history before adding another operation. The current mask is retained.');
  const lease=allocationLedger.reserve({owner:'request-mask-model',kind:'control',cpuBytes:bytes,handles:1});let owned:Owned;
  try{owned={value:structuredClone(value),bytes,lease};}catch(error){lease.release();throw error;}let live=true;
  return {value:owned.value,release(){if(live){live=false;lease.release();}},take(){if(!live)throw Error('REQUEST_MASK_MODEL_RELEASED');live=false;return owned;}};
 }
 commit(prepared:PreparedMask,mode:'push'|'replace'|'undo'='push'){
  if(mode==='push'&&this.current&&(this.history.length>=MASK_MEMORY_LIMITS.historyEntries||this.history.reduce((n,row)=>n+row.bytes,0)+this.current.bytes>MASK_MEMORY_LIMITS.historyBytes))throw Error('REQUEST_MASK_HISTORY_LIMIT');
  if(mode==='undo'&&!this.history.length)throw Error('REQUEST_MASK_HISTORY_EMPTY');
  const next=prepared.take(),prior=this.current;this.current=next;
  if(mode==='push'&&prior)this.history.push(prior);else prior?.lease.release();
  if(mode==='undo')this.history.pop()?.lease.release();
 }
 replace(value:MaskPlan|null){if(!value){this.current?.lease.release();this.current=null;return;}const prepared=this.prepare(value,false);this.commit(prepared,'replace');}
 clearHistory(){for(const row of this.history)row.lease.release();this.history=[];}
 reserveForm(bytes:number){if(!Number.isSafeInteger(bytes)||bytes<0||bytes>MASK_MEMORY_LIMITS.formBytes)throw Error('Request mask fields exceed the local editing allowance. Shorten the coordinate text; the previous values are retained.');if(this.form)this.form.resize({cpuBytes:bytes});else this.form=allocationLedger.reserve({owner:'request-mask-form',kind:'control',cpuBytes:bytes,handles:1});this.formBytes=bytes;}
 scratch(bytes=MASK_MEMORY_LIMITS.modelBytes){return allocationLedger.reserve({owner:'request-mask-scratch',kind:'scratch',cpuBytes:bytes,handles:1});}
 release(){this.replace(null);this.clearHistory();this.form?.release();this.form=undefined;this.formBytes=0;}
}

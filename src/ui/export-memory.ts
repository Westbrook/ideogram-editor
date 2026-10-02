import type {LitElement} from 'lit';
import {modelPayloadBytes,reserveModelBytes,type OwnedModel} from '../observability/model-memory.js';

export const EXPORT_MEMORY_LIMITS=Object.freeze({models:96,modelBytes:1024**2,formBytes:65536,operations:32,owners:8,actions:64,errorUnits:2048});
type RecordKind='operation'|'owner'|'action';
export type ExportRecord=Readonly<{release():void}>;

/** Logical payload ownership, not physical heap/DOM or native transport memory.
 * Replacement templates retire at the actual Lit commit. A failed commit keeps
 * the original model charged and reachable until a later successful retry. */
export class ExportMemory {
 private models=new Set<OwnedModel<unknown>>();private records=new Map<ExportRecord,RecordKind>();
 private retired=new Set<ExportRecord>();private pending=new Set<Promise<void>>();private failed=new Set<ExportRecord>();
 constructor(private host:Pick<LitElement,'requestUpdate'|'updateComplete'>,private settled:()=>void=()=>{}){}
 create<T>(label:string,allowance:number,create:()=>T,limit=EXPORT_MEMORY_LIMITS.modelBytes):OwnedModel<T>{
  if(this.models.size>=EXPORT_MEMORY_LIMITS.models)throw Error('EXPORT_MODEL_CAPACITY');
  if(!Number.isSafeInteger(allowance)||allowance<0||allowance>limit)throw Error('EXPORT_MODEL_LIMIT');
  const payload=reserveModelBytes('export-'+label,allowance,2);let model:OwnedModel<T>;
  try{
   const value=create(),retained=modelPayloadBytes(value);if(retained>allowance)throw Error('EXPORT_MODEL_ALLOWANCE');payload.resize(retained,2);
   let refs=1,live=true;const unref=()=>{if(!--refs){this.models.delete(model);payload.release();}};
   model=Object.freeze({value,release(){if(live){live=false;unref();}},pin(){if(!refs)throw Error('EXPORT_MODEL_RELEASED');refs++;let pinned=true;return ()=>{if(pinned){pinned=false;unref();}};}});
   this.models.add(model);return model;
  }catch(error){payload.release();throw error;}
 }
 clone<T>(label:string,value:T,limit=EXPORT_MEMORY_LIMITS.modelBytes){return this.create(label,modelPayloadBytes(value),()=>structuredClone(value),limit);}
 record(kind:RecordKind):ExportRecord{
  let count=0;for(const value of this.records.values())if(value===kind)count++;
  const cap=kind==='operation'?EXPORT_MEMORY_LIMITS.operations:kind==='owner'?EXPORT_MEMORY_LIMITS.owners:EXPORT_MEMORY_LIMITS.actions;
  if(count>=cap)throw Error('EXPORT_'+kind.toUpperCase()+'_CAPACITY');
  // Owner scalar identities, phase/cancellation state, bounded diagnostics and
  // their control handles. The session is retained only as cancellation authority.
  const payload=reserveModelBytes('export-'+kind,kind==='action'?512:16384,kind==='operation'?8:2);
  let live=true;const record=Object.freeze({release:()=>{if(live){live=false;this.records.delete(record);payload.release();}}});this.records.set(record,kind);return record;
 }
 retire(model:ExportRecord){
  if(this.retired.has(model))return;this.retired.add(model);this.scheduleRetirement(model);
 }
 private scheduleRetirement(model:ExportRecord){
  const task=Promise.resolve().then(()=>{this.host.requestUpdate();return this.host.updateComplete;}).then(()=>{model.release();this.retired.delete(model);}).catch(()=>{this.failed.add(model);});
  this.pending.add(task);void task.then(()=>{this.pending.delete(task);this.settled();});
 }
 retryRetirements(){for(const model of this.failed){this.failed.delete(model);this.scheduleRetirement(model);}}
 async drain(){
  while(this.pending.size)await Promise.all([...this.pending]);
  this.retryRetirements();while(this.pending.size)await Promise.all([...this.pending]);
  if(this.failed.size)throw Error('EXPORT_RENDER_RELEASE_UNCONFIRMED');
 }
 inspect(){const records={operation:0,owner:0,action:0};for(const kind of this.records.values())records[kind]++;return {models:this.models.size,records,retired:this.retired.size,pending:this.pending.size,failed:this.failed.size};}
}

/** Long diagnostics are rejected as retained UI payload, never silently sliced.
 * The original command receipt remains the authority for detailed diagnosis. */
export function exportDiagnostic(error:unknown,fallback='Export unavailable.'){
 const message=error instanceof Error?error.message:typeof error==='string'?error:fallback;
 return message.length<=EXPORT_MEMORY_LIMITS.errorUnits?message:'Export returned an oversized diagnostic. Inspect its retained command receipt for details.';
}

import type {LitElement} from 'lit';
import type {EditorClient} from '../state/editor-client.js';
import {modelPayloadBytes,reserveModelBytes,type OwnedModel,type ModelKind} from '../observability/model-memory.js';
import {PromptReaderCleanupError} from '../observability/prompt-memory.js';

/** Logical JSON/form ownership only: native File storage and DOM copies remain
 * outside this accounting. Retired render models stay admitted through Lit's
 * next commit, and asynchronous actions pin the values they captured. */
export class UIModelOwner {
  private slots=new Map<string,OwnedModel<unknown>>();private reads=new Set<AbortController>();private pending=new Set<Promise<unknown>>();
  private cleanupFailures=new Set<PromptReaderCleanupError>();private retiredFailures=new Map<OwnedModel<unknown>,unknown>();private releasePending:Promise<void>|undefined;
  private slotLimit:number;
  constructor(private host:LitElement,private editor:EditorClient,private owner:string,private kind:ModelKind='control',limits:{slots?:number}={}){
    this.slotLimit=limits.slots??16;if(!Number.isSafeInteger(this.slotLimit)||this.slotLimit<1||this.slotLimit>256)throw Error('UI_MODEL_LIMITS');
  }
  get releasing(){return !!this.releasePending;}
  get lifecycle(){return {models:this.slots.size,reads:this.reads.size,pending:this.pending.size,cleanupFailures:this.cleanupFailures.size+this.retiredFailures.size};}
  private check(){if(this.releasing)throw new DOMException('The previous view is still releasing.','AbortError');}
  model<T>(value:T,limit=1024**2,metadata:unknown=value,handles=1):OwnedModel<T>{
    this.check();const bytes=modelPayloadBytes(metadata);if(bytes>limit)throw Error('UI_MODEL_LIMIT');
    const lease=reserveModelBytes(this.owner,bytes,handles,this.kind);return Object.freeze({value,release:()=>lease.release(),pin:()=>lease.pin()});
  }
  temporary(bytes:number){this.check();return reserveModelBytes(this.owner,bytes,1,this.kind);}
  /** Ownership transfers only on success; the caller releases a refused value. */
  replace(slot:string,value:OwnedModel<unknown>){
    this.check();if(!this.slots.has(slot)&&this.slots.size>=this.slotLimit)throw Error('UI_MODEL_SLOTS');
    const prior=this.slots.get(slot);this.slots.set(slot,value);if(prior&&prior!==value)this.retire(prior);
  }
  clear(slot:string){const prior=this.slots.get(slot);this.slots.delete(slot);if(prior)this.retire(prior);}
  private retire(model:OwnedModel<unknown>){
    // Request the update after the caller synchronously replaces its fields.
    // The reservation is released only after old template values leave the DOM.
    this.watch(Promise.resolve().then(()=>{this.host.requestUpdate();return this.host.updateComplete;}).then(()=>model.release(),error=>{this.retiredFailures.set(model,error);throw error;}));
  }
  private watch<T>(task:Promise<T>):Promise<T>{
    this.pending.add(task);void task.then(()=>this.pending.delete(task),error=>{this.pending.delete(task);if(error instanceof PromptReaderCleanupError)this.cleanupFailures.add(error);});return task;
  }
  hold(){
    this.check();if(this.pending.size>=64)throw Error('UI_MODEL_OPERATIONS');
    const operation=reserveModelBytes(this.owner,0,1,this.kind),pins:Array<()=>void>=[];
    try{for(const model of this.slots.values())pins.push(model.pin());}catch(error){for(const unpin of pins)unpin();operation.release();throw error;}
    let done!:()=>void,live=true;this.watch(new Promise<void>(resolve=>{done=resolve;}));
    return ()=>{if(!live)return;live=false;for(const unpin of pins)unpin();operation.release();done();};
  }
  run<T>(work:()=>T|Promise<T>):Promise<T>{
    const unpin=this.hold();return this.watch(Promise.resolve().then(work).finally(unpin));
  }
  read<T>(path:string,current:()=>boolean,maxBytes=1024**2):Promise<OwnedModel<T>>{
    this.check();if(this.reads.size>=8)throw Error('UI_MODEL_READS');if(path.length>16384)throw Error('UI_MODEL_PATH_LIMIT');
    const operation=reserveModelBytes(this.owner,path.length*2,1,this.kind),abort=new AbortController();this.reads.add(abort);
    return this.watch(Promise.resolve().then(()=>this.editor.ownedJSON<T>(path,this.owner,{signal:abort.signal},()=>!abort.signal.aborted&&current(),maxBytes,this.kind))
      .then(model=>{if(abort.signal.aborted||!current()){model.release();throw new DOMException('The view changed.','AbortError');}return model;})
      .catch(error=>{if(error instanceof Error&&error.message==='PROMPT_READ_STALE'&&(abort.signal.aborted||!current()))throw new DOMException('The view changed.','AbortError');throw error;})
      .finally(()=>{this.reads.delete(abort);operation.release();}));
  }
  clearAll(){for(const abort of this.reads)abort.abort();for(const key of this.slots.keys())this.clear(key);}
  release(){
    if(this.releasePending)return this.releasePending;
    this.clearAll();this.releasePending=this.drain().then(()=>{this.releasePending=undefined;this.host.requestUpdate();},error=>{this.releasePending=undefined;throw error;});
    // Internal owner changes may initiate cleanup without awaiting it. Preserve
    // its rejection for explicit document release without an unhandled promise.
    void this.releasePending.catch(()=>{});return this.releasePending;
  }
  private async drain(){
    while(this.pending.size)await Promise.allSettled([...this.pending]);
    const errors:unknown[]=[];for(const error of this.cleanupFailures)try{await error.retry();this.cleanupFailures.delete(error);}catch(failure){errors.push(failure);}
    for(const [model]of this.retiredFailures)try{this.host.requestUpdate();await this.host.updateComplete;model.release();this.retiredFailures.delete(model);}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'UI_MODEL_RELEASE_INCOMPLETE');
  }
}

import type {LitElement} from 'lit';
import type {StagingCreateRequest} from '../protocol/assets.js';
import type {EditorClient} from '../state/editor-client.js';
import {modelPayloadBytes,reserveModelBytes,type OwnedModel} from '../observability/model-memory.js';
import {UIModelOwner} from './model-owner.js';
import {PromptReaderCleanupError} from '../observability/prompt-memory.js';

const externalPayload=(value:unknown):OwnedModel<unknown>|undefined=>{if(!value||typeof value!=='object')return;const payload=(value as {payload?:OwnedModel<unknown>}).payload;if(payload?.value===value&&typeof payload.pin==='function'&&typeof payload.release==='function')return payload;};

export const REQUEST_EDIT_LIMITS=Object.freeze({candidates:8192,indexBytes:8*1024**2,branches:64,bytes:16*1024**2,modelBytes:8*1024**2,reads:8});
/** Counts JSON payloads plus bounded sets; execution callbacks and session
 * handles are separately pinned, never traversed as application payloads. */
export function editModelBytes(value:unknown,depth=0):number{
 if(depth>64)throw Error('REQUEST_EDIT_MODEL_DEPTH');
 if(value===null||value===undefined||typeof value==='function')return 0;
 if(value instanceof Set){let size=0;for(const item of value)size+=editModelBytes(item,depth+1);return size;}
 if(typeof value!=='object')return modelPayloadBytes(value);
 let size=0;for(const key of Object.keys(value)){const field=(value as Record<string,unknown>)[key];if(key==='encodedOwner'&&externalPayload(field))continue;size+=key.length*2+editModelBytes(field,depth+1);if(size>REQUEST_EDIT_LIMITS.modelBytes)throw Error('REQUEST_EDIT_MODEL_LIMIT');}return size;
}
export type EditRead={signal:AbortSignal;cleanup(work:()=>void):()=>void;read<T>(path:string,current:()=>boolean,maxBytes?:number,signal?:AbortSignal):Promise<T>;command(...args:Parameters<EditorClient['ownedCommand']>):Promise<Awaited<ReturnType<EditorClient['ownedCommand']>>['value']>;upload(...args:Parameters<EditorClient['ownedUpload']>):Promise<StagingCreateRequest>;keep<T>(value:T,metadata?:unknown):T;release():void};
export class RequestEditModels {
 readonly controls:UIModelOwner;
 private bytes=0;private keys=new Set<string>();private operations=new Set<Promise<void>>();private operationAborts=new Set<AbortController>();private aborts=new Set<AbortController>();private cleanup=new Set<PromptReaderCleanupError>();private nativeCleanup=new Set<()=>void>();private failures:unknown[]=[];
 constructor(host:LitElement,private editor:EditorClient){this.controls=new UIModelOwner(host,editor,'request-edit-model','control',{slots:256});}
 get lifecycle(){return {...this.controls.lifecycle,bytes:this.bytes,operations:this.operations.size};}
 hold(){return this.controls.hold();}
 run<T>(work:()=>T|Promise<T>){return this.controls.run(work);}
 prepare<T>(value:T,metadata:unknown=value,limit=REQUEST_EDIT_LIMITS.modelBytes):OwnedModel<T>{
  const bytes=editModelBytes(metadata);if(bytes>limit||this.bytes+bytes>REQUEST_EDIT_LIMITS.bytes)throw Error('REQUEST_EDIT_MODEL_LIMIT');
  const lease=reserveModelBytes('request-edit-model',bytes);let unpinExternal:(()=>void)|undefined;try{if(metadata&&typeof metadata==='object')unpinExternal=externalPayload((metadata as {encodedOwner?:unknown}).encodedOwner)?.pin();}catch(error){lease.release();throw error;}this.bytes+=bytes;let refs=1,live=true;
  // A view may outlive native cancellation through Lit retirement or an action
  // pin. Keep separately admitted encoded metadata through that entire view.
  const drop=()=>{if(!--refs){this.bytes-=bytes;lease.release();unpinExternal?.();}};
  return Object.freeze({value,release:()=>{if(live){live=false;drop();}},pin:()=>{if(!refs)throw Error('REQUEST_EDIT_MODEL_RELEASED');refs++;let pinned=true;return ()=>{if(pinned){pinned=false;drop();}};}});
 }
 adopt(key:string,model:OwnedModel<unknown>){this.controls.replace(key,model);this.keys.add(key);}
 retain<T>(key:string,value:T,metadata:unknown=value,limit=REQUEST_EDIT_LIMITS.modelBytes){const model=this.prepare(value,metadata,limit);try{this.adopt(key,model);}catch(error){model.release();throw error;}return value;}
 clear(key:string){this.keys.delete(key);this.controls.clear(key);}
 operation():EditRead{
  const unpin=this.hold();let rootPin:()=>void;try{rootPin=this.editor.pinViewModels(this.editor.view.document,this.editor.view.image);}catch(error){unpin();throw error;}
  const operationAbort=new AbortController();this.operationAborts.add(operationAbort);
  const models=new Set<OwnedModel<unknown>>(),reads=new Set<Promise<unknown>>(),aborts=new Set<AbortController>(),cleanups=new Set<()=>void>();let done!:()=>void,live=true;
  const pending=new Promise<void>(resolve=>{done=resolve;});this.operations.add(pending);
  const finish=()=>{if(live||reads.size)return;for(const work of cleanups)try{work();}catch{this.nativeCleanup.add(work);}cleanups.clear();for(const model of models)model.release();models.clear();rootPin();unpin();this.operationAborts.delete(operationAbort);this.operations.delete(pending);done();};
  const keep=<T>(value:T,metadata:unknown=value)=>{const model=this.prepare(value,metadata);models.add(model);return value;};
  const ownedResult=<T>(work:()=>Promise<OwnedModel<T>>):Promise<T>=>{
   if(!live)throw Error('REQUEST_EDIT_OPERATION_RELEASED');
   let received:Promise<OwnedModel<T>>;try{received=work();}catch(error){if(error instanceof PromptReaderCleanupError)this.cleanup.add(error);throw error;}
   const task=received.then(model=>{models.add(model);if(!live||operationAbort.signal.aborted)throw new DOMException('Request edit changed.','AbortError');return model.value;}).catch(error=>{if(error instanceof PromptReaderCleanupError)this.cleanup.add(error);throw error;}).finally(()=>{reads.delete(task);finish();});reads.add(task);return task;
  };
  return {signal:operationAbort.signal,cleanup:work=>{cleanups.add(work);return ()=>cleanups.delete(work);},keep,command:(...args)=>ownedResult(()=>this.editor.ownedCommand(...args)),upload:(file,purpose,mediaType,existing,current,signal)=>ownedResult(()=>this.editor.ownedUpload(file,purpose,mediaType,existing,current,signal?AbortSignal.any([signal,operationAbort.signal]):operationAbort.signal)),read:<T>(path:string,current:()=>boolean,maxBytes=4*1024**2,signal:AbortSignal=operationAbort.signal)=>{
   if(!live)throw Error('REQUEST_EDIT_OPERATION_RELEASED');if(path.length>16384||this.aborts.size>=REQUEST_EDIT_LIMITS.reads)throw Error('REQUEST_EDIT_READ_LIMIT');
   const pathOwner=reserveModelBytes('request-edit-read',path.length*2),abort=new AbortController(),cancel=()=>abort.abort();aborts.add(abort);this.aborts.add(abort);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
   const task=Promise.resolve().then(()=>this.editor.ownedJSON<T>(path,'request-edit-read',{signal:abort.signal},()=>live&&!abort.signal.aborted&&current(),maxBytes)).then(model=>{models.add(model);if(!live||abort.signal.aborted||!current())throw new DOMException('Request edit changed.','AbortError');return model.value;}).catch(error=>{if(error instanceof PromptReaderCleanupError)this.cleanup.add(error);throw error;}).finally(()=>{pathOwner.release();signal?.removeEventListener('abort',cancel);aborts.delete(abort);this.aborts.delete(abort);reads.delete(task);finish();});
   reads.add(task);return task;
  },release:()=>{if(!live)return;live=false;operationAbort.abort();for(const abort of aborts)abort.abort();finish();}};
 }
 record(error:unknown){if(this.failures.length<64)this.failures.push(error);}
 async release(){this.keys.clear();for(const abort of this.operationAborts)abort.abort();for(const abort of this.aborts)abort.abort();const work=this.controls.release();while(this.operations.size)await Promise.allSettled([...this.operations]);const errors:unknown[]=[];try{await work;}catch(error){errors.push(error);}for(const error of this.cleanup)try{await error.retry();this.cleanup.delete(error);}catch(failure){errors.push(failure);}for(const retry of this.nativeCleanup)try{retry();this.nativeCleanup.delete(retry);}catch(error){errors.push(error);}if(this.failures.length)errors.push(...this.failures.splice(0));if(errors.length)throw new AggregateError(errors,'REQUEST_EDIT_CLEANUP_FAILED');}
}

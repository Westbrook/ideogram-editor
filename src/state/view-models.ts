import {allocationLedger} from '../observability/allocations.js';
import {createOwnedModel,cloneOwnedModel,modelPayloadBytes,reserveModelBytes,type OwnedModel} from '../observability/model-memory.js';
import {PromptReaderCleanupError} from '../observability/prompt-memory.js';
import {measureControl} from './control-memory.js';
import {canonical} from '../protocol/json.js';
import {SHA256} from '../protocol/sha256.js';
import type {EditorView} from './editor-client.js';

// The service keeps this cleared value reachable after any client is disposed.
// Admit before materializing it, then retain its exact logical payload for the
// module/realm lifetime. This is one shared root, never a per-disposal booking;
// no GC event or disconnected render is treated as its release boundary.
const terminalEditorView=createOwnedModel<EditorView>('editor-terminal-view',1024,()=>{
 const empty:never[]=[];Object.freeze(empty);
 return Object.freeze({ready:false,busy:false,message:'',error:'',recovery:'',documents:empty,document:null,image:null,history:empty,historyNext:null,undoAvailable:null,checkpoints:empty,checkpointNext:null,review:null,download:null,selected:empty,save:null,drafts:'',pending:empty,pendingAfter:null,pendingDirection:'next',pendingPrevious:null,pendingNext:null,pendingCreate:false,uiPending:empty,cursor:'0',uiChoices:empty,uiNext:null,stages:empty,stageNext:null});
});

export const VIEW_MODEL_LIMITS=Object.freeze({responseBytes:65536,bindings:4096,reads:8,downloadBytes:65536});
export type ViewModelSlot='image'|'history'|'checkpoints'|'save'|'download'|'review'|'uiChoices'|'stages'|'pending'|'metadata';
export type ViewModelInput={slot:ViewModelSlot;model:OwnedModel<unknown>;identity:string;exposed:unknown;references:()=>Iterable<object>};
type Entry=ViewModelInput&{index:ReturnType<typeof allocationLedger.reserve>;live:boolean;pins:number};
export const EDITOR_METADATA_LIMITS=Object.freeze({selected:4096,pending:64,idUnits:128,textUnits:65536,payloadBytes:2*1024**2,retiredRoots:48,documentReadBytes:4*65536+8});
const controlStrings=['message','error','recovery','drafts','cursor','historyNext','checkpointNext','uiNext','stageNext'] as const;
export type EditorControlMetadata={selected:string[];uiPending:string[];message:string;error:string;recovery:string;drafts:string;cursor:string;historyNext:string|null;checkpointNext:string|null;uiNext:string|null;stageNext:string|null;pendingAfter:string|null;pendingDirection:'next'|'prev';pendingPrevious:string|null;pendingNext:string|null;pendingCreate:boolean;ready:boolean;busy:boolean;undoAvailable:boolean|null};
function controlMetadata(value:EditorControlMetadata):EditorControlMetadata{
 for(const [items,limit]of [[value.selected,EDITOR_METADATA_LIMITS.selected],[value.uiPending,EDITOR_METADATA_LIMITS.pending]] as const){if(!Array.isArray(items)||items.length>limit)throw Error('EDITOR_METADATA_LIMIT');for(const item of items)if(typeof item!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(item))throw Error('EDITOR_METADATA_ID');}
 for(const key of controlStrings){const text=value[key];if(text!==null&&typeof text!=='string'||typeof text==='string'&&text.length>EDITOR_METADATA_LIMITS.textUnits)throw Error('EDITOR_METADATA_LIMIT');if(text===null&&!['historyNext','checkpointNext','uiNext','stageNext'].includes(key))throw Error('EDITOR_METADATA_VALUE');}
 for(const cursor of [value.pendingAfter,value.pendingPrevious,value.pendingNext])if(cursor!==null&&(typeof cursor!=='string'||cursor.length>256||!cursor.startsWith('command:')||cursor==='command:'||cursor>='command:\uffff'))throw Error('EDITOR_METADATA_PENDING_CURSOR');
 if(!['next','prev'].includes(value.pendingDirection))throw Error('EDITOR_METADATA_PENDING_DIRECTION');
 if(typeof value.pendingCreate!=='boolean'||typeof value.ready!=='boolean'||typeof value.busy!=='boolean'||!(value.undoAvailable===null||typeof value.undoAvailable==='boolean'))throw Error('EDITOR_METADATA_VALUE');
 return {selected:value.selected,uiPending:value.uiPending,message:value.message,error:value.error,recovery:value.recovery,drafts:value.drafts,cursor:value.cursor,historyNext:value.historyNext,checkpointNext:value.checkpointNext,uiNext:value.uiNext,stageNext:value.stageNext,pendingAfter:value.pendingAfter,pendingDirection:value.pendingDirection,pendingPrevious:value.pendingPrevious,pendingNext:value.pendingNext,pendingCreate:value.pendingCreate,ready:value.ready,busy:value.busy,undoAvailable:value.undoAvailable};
}
/** Explicit current roots and action pins. Weak lookup is only an identity
 * index, never a GC-based release mechanism; replaced unpinned owners release
 * synchronously. A pin retains its actual root until the caller's finally. */
export class ViewModelOwners {
 terminalView(){return terminalEditorView.value;}
 private retired=new Set<Entry>();private activePins=0;private current=new Map<ViewModelSlot,Entry>();private index=new WeakMap<object,WeakRef<Entry>>();
 private controlViews=new WeakMap<object,WeakRef<Entry>>();
 private pin(entry:Entry){if(!entry.live&&!entry.pins)throw Error('VIEW_MODEL_UNOWNED');const unpin=entry.model.pin();entry.pins++;this.activePins++;let target:Entry|undefined=entry;return ()=>{const pinned=target;if(!pinned)return;target=undefined;pinned.pins--;this.activePins--;unpin();if(!pinned.live&&!pinned.pins){this.retired.delete(pinned);pinned.index.release();}};}
 private drop(entry:Entry){if(entry.live){entry.live=false;entry.model.release();if(!entry.pins)entry.index.release();else this.retired.add(entry);}}
 borrow(value:object){const entry=this.index.get(value)?.deref();if(!entry)throw Error('VIEW_MODEL_UNOWNED');return this.pin(entry);}
 renderModel(value:object){const entry=this.index.get(value)?.deref();if(!entry||!entry.live&&!entry.pins)throw Error('VIEW_MODEL_UNOWNED');return {value:entry.model.value as object,pin:()=>this.pin(entry)};}
 borrowMany(values:Iterable<object>){const entries=new Set<Entry>(),releases:(()=>void)[]=[];try{for(const value of values){const entry=this.index.get(value)?.deref();if(!entry)throw Error('VIEW_MODEL_UNOWNED');entries.add(entry);}for(const entry of entries)releases.push(this.pin(entry));}catch(error){for(const release of releases)release();throw error;}finally{entries.clear();}return ()=>{for(const release of releases)release();releases.length=0;};}
 reuse<T>(slot:ViewModelSlot,identity:string):OwnedModel<T>|undefined{const entry=this.current.get(slot);if(!entry||entry.identity!==identity)return;const release=this.pin(entry);return {value:entry.model.value as T,release,pin:()=>this.pin(entry)};}
 isCurrent(slot:ViewModelSlot,value:unknown){return this.current.get(slot)?.model.value===value;}
 same<T>(slot:ViewModelSlot,value:T):OwnedModel<T>|undefined{const entry=this.current.get(slot);return entry&&sameValue(entry.model.value,value)?this.reuse<T>(slot,entry.identity):undefined;}
 /** These fields are independent retained payloads, not aliases whose lifetime
  * can be borrowed from a document, page or pending-delivery owner. Weak view
  * keys never keep the surrounding document/image graph alive. */
 publishControlView<T extends EditorControlMetadata>(view:T,publish:(value:T)=>void){
  const metadata=controlMetadata(view),prior=this.current.get('metadata');
  if(prior&&sameValue(prior.model.value,metadata)){const next={...view,...(prior.model.value as EditorControlMetadata)};this.controlViews.set(next,new WeakRef(prior));publish(next);return;}
  let retired=0;for(const entry of this.retired)if(entry.slot==='metadata')retired++;if(retired>=EDITOR_METADATA_LIMITS.retiredRoots)throw Error('EDITOR_METADATA_RETIREMENT_LIMIT');
  if(modelPayloadBytes(metadata)>EDITOR_METADATA_LIMITS.payloadBytes)throw Error('EDITOR_METADATA_LIMIT');
  const model=cloneOwnedModel('editor-view-metadata',metadata);Object.freeze(model.value.selected);Object.freeze(model.value.uiPending);Object.freeze(model.value);
  const next={...view,...model.value};
  try{this.publish([{slot:'metadata',model,identity:'editor-view-metadata',exposed:model.value,references:function*(){yield model.value;yield model.value.selected;yield model.value.uiPending;}}],()=>{const entry=this.current.get('metadata')!;this.controlViews.set(next,new WeakRef(entry));publish(next);});}
  catch(error){model.release();throw error;}
 }
 renderControlView(view:object){const entry=this.controlViews.get(view)?.deref();if(!entry||!entry.live&&!entry.pins)throw Error('EDITOR_METADATA_UNOWNED');return {value:entry.model.value as object,pin:()=>this.pin(entry)};}
 releaseControlView(){const entry=this.current.get('metadata');if(entry){this.current.delete('metadata');this.drop(entry);}}
 /** A second IDB read returns a new logical Document payload. The existing
  * document-list pin cannot own this clone. Admission precedes the read and
  * remains through its last validation consumer, including late completion.
  * Unknown native/legacy IDB cloning remains outside this logical allowance. */
 async validateDocumentRead(cache:{read(type:string,id:string):Promise<unknown>},document:{id:string;revision:string},current:()=>boolean){
  if(!current())return false;const lease=reserveModelBytes('editor-document-validation',EDITOR_METADATA_LIMITS.documentReadBytes,1);let value:unknown;
  try{value=await cache.read('document',document.id);if(!current())return false;if(value===undefined||value===null)return false;try{const measured=measureControl(value,65536);if(measured.logicalBytes>EDITOR_METADATA_LIMITS.documentReadBytes)throw Error('DOCUMENT_VALIDATION_LOGICAL_LIMIT');}catch(cause){throw Error('DOCUMENT_VALIDATION_MODEL_LIMIT',{cause});}return !!value&&typeof value==='object'&&(value as {id?:unknown}).id===document.id&&(value as {revision?:unknown}).revision===document.revision;}
  finally{value=undefined;lease.release();}
 }
 publish(inputs:ViewModelInput[],publish:()=>void){
  const prepared:Entry[]=[];let installed=false;
  try{for(const input of inputs){let count=0;for(const reference of input.references()){if(!reference||typeof reference!=='object'||++count>VIEW_MODEL_LIMITS.bindings)throw Error('View metadata exceeds the local ownership allowance. The previous complete view is retained.');}
    const index=allocationLedger.reserve({owner:'editor-view-model-index',kind:'control',cpuBytes:input.identity.length*2+count*8,handles:count+1});prepared.push({...input,index,live:true,pins:0});}
   const prior=prepared.map(entry=>this.current.get(entry.slot));
   for(const entry of prepared){this.current.set(entry.slot,entry);const weak=new WeakRef(entry);for(const reference of entry.references())this.index.set(reference,weak);}
   try{publish();}catch(error){for(let i=0;i<prepared.length;i++){const old=prior[i];if(old)this.current.set(prepared[i].slot,old);else this.current.delete(prepared[i].slot);}throw error;}
   installed=true;for(const entry of prior)if(entry)this.drop(entry);
  }finally{if(!installed)for(const entry of prepared)this.drop(entry);}
 }
 clearReplaced(values:Partial<Record<ViewModelSlot,unknown>>){for(const slot of ['image','history','checkpoints','save','download','review','uiChoices','stages','pending'] as const){const entry=this.current.get(slot);if(entry&&slot in values&&values[slot]!==entry.exposed){this.current.delete(slot);this.drop(entry);}}}
 get ownership(){return {currentRoots:this.current.size,retiredPinnedRoots:this.retired.size,activePins:this.activePins};}
}
function sameValue(a:unknown,b:unknown):boolean{if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;let count=0,other=0;for(const key in a)if(Object.hasOwn(a,key)){count++;if(!Object.hasOwn(b,key)||!sameValue((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]))return false;}for(const key in b)if(Object.hasOwn(b,key))other++;return count===other;}

export class ViewModelReads {
 private reads=new Map<AbortController,Promise<unknown>>();private failed=new Set<PromptReaderCleanupError>();private releasing=false;private drain?:Promise<void>;
 run<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.releasing)return Promise.reject(new DOMException('The previous view is closing. Retry after it finishes.','AbortError'));
  if(this.reads.size>=VIEW_MODEL_LIMITS.reads)return Promise.reject(Error('Too many view metadata reads are in progress. Wait for the current view, then retry.'));
  const lease=allocationLedger.reserve({owner:'editor-view-model-read',kind:'control',handles:1}),abort=new AbortController();
  const task=Promise.resolve().then(()=>work(abort.signal)).catch(error=>{this.capture(error);throw error;}).finally(()=>{this.reads.delete(abort);lease.release();});this.reads.set(abort,task);return task;
 }
 private capture(error:unknown){if(error instanceof PromptReaderCleanupError)this.failed.add(error);else if(error instanceof AggregateError)for(const cause of error.errors)this.capture(cause);}
 release(){if(this.drain)return this.drain;this.releasing=true;this.drain=(async()=>{for(const abort of this.reads.keys())abort.abort();await Promise.allSettled([...this.reads.values()]);const errors:unknown[]=[];for(const failure of this.failed)try{await failure.retry();this.failed.delete(failure);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'VIEW_MODEL_READ_CLEANUP_FAILED');})().finally(()=>{this.releasing=false;this.drain=undefined;});return this.drain;}
 get ownership(){return {activeReads:this.reads.size,cleanupFailures:this.failed.size};}
}
/** Canonical serialization may escape controls more than JSON.stringify. The
 * bounded count precedes its UTF-16/UTF-8 and key-sort workspace allocations. */
export function canonicalControlHash(value:unknown){const measured=measureControl(value,VIEW_MODEL_LIMITS.responseBytes),lease=allocationLedger.reserve({owner:'editor-model-hash',kind:'scratch',cpuBytes:measured.encodedBytes*24+measured.logicalBytes*2,handles:4});try{const hash=new SHA256();hash.update(new TextEncoder().encode(canonical(value)));return hash.digest();}finally{lease.release();}}

/** Prepared destination metadata is a bounded owned snapshot, including any
 * recovery disclosure. This does not charge the prepared file's logical size. */
export function ownDownload<T>(value:T):OwnedModel<T>{if(modelPayloadBytes(value)>VIEW_MODEL_LIMITS.downloadBytes)throw Error('Prepared download details exceed the local view allowance. The previous download is retained.');return cloneOwnedModel('editor-download-model',value);}

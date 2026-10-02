import {createHash} from 'node:crypto';
import {compositionDraft,compositionDraftGraph,type CompositionDraft} from '../../src/composition/draft.js';
import {validateCompositionRef,type CompositionRef} from '../../src/composition/core.js';
import {DRAFT_GRAPH_BYTES} from '../../src/composition/view.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import type {Objects} from './objects.js';
import type {ImageState} from '../../src/protocol/history.js';
import type {BlobRef} from '../../src/protocol/store.js';
import {validateBlob} from './canonical.js';
import {StoreError} from './errors.js';
import {adapterResources} from '../observability/adapter-resources.js';

const CPU_LIMIT=512*1024**2;
/** Writer-side coordination mirror for main-thread Composition controls. This
 * is not another budget: otherBytes includes this mirror in raster/text
 * admission, and main owns the corresponding central control lease. */
export class CompositionMemory {
 private loans=new Map<string,number>();private families=new Map<string,'composition'|'storage-read'|'storage-registry'>();private content=new Map<string,Set<string>>();private borrowed=0;
 private loanCoverage=new Map<string,()=>void>();private borrowers=0;
 constructor(private otherBytes:()=>number,private rss:()=>number=()=>process.memoryUsage().rss){}
 resourceOwnership(){let loanBytes=0,contentReaders=0;const loanFamilies={composition:0,storageRead:0,storageRegistry:0};for(const bytes of this.loans.values())loanBytes+=bytes;for(const handles of this.content.values())contentReaders+=handles.size;for(const family of this.families.values())loanFamilies[family==='composition'?'composition':family==='storage-read'?'storageRead':'storageRegistry']++;return {loans:this.loans.size,loanBytes,borrowers:this.borrowers,borrowedBytes:this.borrowed,contentReaders,loanFamilies};}
 get bytes(){let total=this.borrowed;for(const n of this.loans.values())total+=n;return total;}
 requireLoan(id:string,minimum:number,family?:'composition'|'storage-read'|'storage-registry'){const bytes=this.loans.get(id);if(!Number.isSafeInteger(minimum)||minimum<1||bytes===undefined||bytes<minimum||family!==undefined&&this.families.get(id)!==family)throw new StoreError('CAPACITY');}
 bytesExcept(ids:readonly string[]){let total=this.borrowed;for(const [id,bytes] of this.loans)if(!ids.includes(id))total+=bytes;return total;}
 resize(id:string,bytes:number,family:'composition'|'storage-read'|'storage-registry'='composition'){
  if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(bytes)||bytes<0||bytes>CPU_LIMIT)throw new StoreError('MALFORMED_REQUEST');
  if(!['composition','storage-read','storage-registry'].includes(family)||this.families.has(id)&&this.families.get(id)!==family)throw new StoreError('MALFORMED_REQUEST');
  const old=this.loans.get(id)??0;
  const maximum=family==='composition'?4:family==='storage-read'?2:1;
  if(!this.loans.has(id)&&[...this.families.values()].filter(value=>value===family).length>=maximum)throw new StoreError('CAPACITY');
  if(bytes>old&&this.rss()+this.otherBytes()+bytes-old>CPU_LIMIT)throw new StoreError('CAPACITY');
  if(!this.loans.has(id))this.loanCoverage.set(id,adapterResources.uncovered('composition-loan:'+family));
  this.loans.set(id,bytes);this.families.set(id,family);
 }
 openContent(id:string,open:()=>string){if(!this.loans.has(id))throw new StoreError('NOT_FOUND');if(this.families.get(id)!=='composition')throw new StoreError('MALFORMED_REQUEST');const handles=this.content.get(id)??new Set<string>();if(handles.size>=128)throw new StoreError('CAPACITY');const handle=open();handles.add(handle);this.content.set(id,handles);return handle;}
 dropContent(id:string,handle:string,drop:(handle:string)=>void){const handles=this.content.get(id);if(handles?.has(handle)){drop(handle);handles.delete(handle);}}
 drop(id:string,drop:(handle:string)=>void){const handles=this.content.get(id);if(handles)for(const handle of handles){drop(handle);handles.delete(handle);}this.content.delete(id);this.loans.delete(id);this.families.delete(id);const release=this.loanCoverage.get(id);this.loanCoverage.delete(id);release?.();}
 /** 2,048 graph identities, each charged 4 KiB for the exact BlobRef,
  * canonical Map key, ordered result arrays and comparison serialization.
  * This is a borrower owner within the same 512 MiB admission, not proof or
  * diagnostic credit. Consumers release only after comparison or proof handoff. */
 referenceCollection<T>(build:()=>T):{readonly value:T;release():void}{
  const release=this.admit(2048*4096);let value:T|undefined;let live=true;
  try{value=build();}catch(error){release();throw error;}
  return {get value(){if(!live)throw new StoreError('CLOSED');return value as T;},release(){if(live){live=false;value=undefined;release();}}};
 }
 /** Bounded immutable JSON and its parsed value remain owned through the
  * last consumer await. This shares raster/text admission, not another budget. */
 ownedMetadata<T>(bytes:number,build:()=>T):{readonly value:T;release():void}{
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>4*1024**2)throw new StoreError('PAYLOAD_TOO_LARGE');
  const release=this.admit(bytes*12+1024**2);let value:T|undefined,live=true;
  try{value=build();}catch(error){release();throw error;}
  return {get value(){if(!live)throw new StoreError('CLOSED');return value as T;},release(){if(live){live=false;value=undefined;release();}}};
 }
 private admit(bytes:number){if(this.rss()+this.otherBytes()+bytes>CPU_LIMIT)throw new StoreError('CAPACITY');const releaseCoverage=adapterResources.uncovered('composition-borrower');this.borrowed+=bytes;this.borrowers++;let live=true;return ()=>{if(live){live=false;this.borrowed-=bytes;this.borrowers--;releaseCoverage();}};}
 /** Native LayerValue records borrow state IDs/transforms, but own decoded text
  * and fresh rows/rectangles. Book every possible 16 KiB UTF-8 layer as UTF-16
  * before the first asset/source read, independently of Composition size.
  * Four MiB covers sequential source parsing, bounded object IO and comparison
  * scratch; engine allocation overhead is still subject to actual RSS. */
 nativeLayers(state:ImageState,consume:()=>void):void{
  if(!Array.isArray(state.layers)||state.layers.length>100)throw new StoreError('CAPACITY');
  let native=0;for(const layer of state.layers)if(layer.kind==='text')native++;
  const release=this.admit(4*1024**2+state.layers.length*4096+native*16384*2);
  try{consume();}finally{release();}
 }
 /** Portable commit preloads retain raw input buffers across awaits. Each
  * exact read is admitted before IO, including one returned/read copy; at most
  * two graphs/prompts and two inputs per native layer fit the 204 records.
  * Caller clears its cache before returning or throwing. No value escapes. */
 async commitCache(consume:(reserve:(ref:BlobRef)=>void)=>Promise<void>):Promise<void>{
  const releases=[this.admit(2*1024**2+204*4096)];let count=0,live=true;
  const reserve=(ref:BlobRef)=>{
   if(!live)throw new StoreError('CLOSED');validateBlob(ref);
   if(ref.byteLength.length>20||BigInt(ref.byteLength)>8388608n)throw new StoreError('PAYLOAD_TOO_LARGE');
   if(count>=204)throw new StoreError('CAPACITY');
   releases.push(this.admit(Number(ref.byteLength)*2));count++;
  };
  try{await consume(reserve);}finally{live=false;for(const release of releases)release();}
 }
 private compositionAllowance(refs:readonly (CompositionRef|null|undefined)[]){
  if(refs.length>2)throw new StoreError('CAPACITY');let bytes=0;for(const ref of refs)if(ref){validateCompositionRef(ref);bytes+=Number(ref.value.byteLength);}
  return bytes*12+1024**2;
 }
 /** A graph and all derived reference arrays remain borrowed through the last
  * protected walk await. Async admission is visible to raster/text workers. */
 compositions(refs:readonly (CompositionRef|null|undefined)[],consume:()=>void):void{const release=this.admit(this.compositionAllowance(refs));try{consume();}finally{release();}}
 async compositionsAsync(refs:readonly (CompositionRef|null|undefined)[],consume:()=>Promise<void>):Promise<void>{const release=this.admit(this.compositionAllowance(refs));try{await consume();}finally{release();}}
 /** Callback is synchronous and must not retain its borrowed graph. The
  * allowance covers input, decoded UTF-16, parsed logical payload, canonical
  * comparison scratch and one bounded IO chunk. Engine overhead is checked
  * against actual process RSS, not represented as measured heap bytes. */
 draft(objects:Objects,envelope:CompositionDraft,consume:(graph:Record<string,unknown>)=>void):void{
  compositionDraft(envelope);const n=Number(envelope.graph.byteLength),allowance=n*12+1024**2;
  const release=this.admit(allowance);
  try{
   objects.verify(envelope.graph);const bytes=new Uint8Array(n),digest=createHash('sha256');
   for(let at=0;at<n;){const part=objects.readRange(envelope.graph,String(at),Math.min(65536,n-at));if(!part.byteLength)throw new StoreError('CORRUPT_OBJECT');bytes.set(part,at);digest.update(part);at+=part.byteLength;}
   if('sha256:'+digest.digest('hex')!==envelope.graph.hash)throw new StoreError('CORRUPT_OBJECT');
   const graph=parseControlJSON(bytes,DRAFT_GRAPH_BYTES);compositionDraftGraph(graph,envelope);consume(graph);
  }finally{release();}
 }
}

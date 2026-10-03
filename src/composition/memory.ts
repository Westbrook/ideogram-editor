import {allocationLedger,StreamReaderCompletion,type AllocationLease} from '../observability/allocations.js';
import {jsonPayloadUnits,reservePromptPayload,PromptReaderCleanupError} from '../observability/prompt-memory.js';
import {LIMITS,bytes,parseCaption,serialize,projectBounds} from './core.js';
import {compositionObservations,type RawInspection} from '../observability/composition-observations.js';
import {CompositionError} from './core.js';
import {COMPOSITION_DRAFT_VIEW_BYTES,COMPOSITION_VIEW_BYTES} from './view.js';
import type {Composition,LayerValue,ParseResult} from './core.js';

// Logical payload allowances: UTF-16 strings and keys, numeric scalar payloads,
// booleans and nulls. Object headers, parser/engine internals, DOM strings and
// native transport/Blob residency remain explicit central-ledger coverage gaps.
// Walk existing JSON-shaped data; never serialize merely to measure it.
export function compositionPayloadBytes(value:unknown,depth=0):number {
 if(depth>64)throw Error('COMPOSITION_MEMORY_DEPTH');
 if(value===null||value===undefined)return 0;
 if(typeof value==='string')return value.length*2;
 if(typeof value==='number')return 8;
 if(typeof value==='boolean')return 1;
 let size=0;
 if(Array.isArray(value)){for(const field of value)size+=compositionPayloadBytes(field,depth+1);}
 else if(typeof value==='object'){for(const key in value)if(Object.hasOwn(value,key))size+=key.length*2+compositionPayloadBytes((value as Record<string,unknown>)[key],depth+1);}
 else throw Error('COMPOSITION_MEMORY_VALUE');
 if(!Number.isSafeInteger(size))throw Error('COMPOSITION_MEMORY_SIZE');return size;
}

export class CompositionPayload {
 private refs=1;private bytes:number;
 constructor(private lease:AllocationLease,bytes:number){this.bytes=bytes;}
 pin(){if(!this.refs)throw Error('COMPOSITION_MEMORY_RELEASED');this.refs++;let live=true;return ()=>{if(live){live=false;this.release();}};}
 grow(extra:number){this.resize(this.bytes+extra);}
 resize(bytes:number){this.lease.resize({cpuBytes:bytes});this.bytes=bytes;}
 release(){if(this.refs&&!--this.refs)this.lease.release();}
}
export type OwnedCompositionValue<T>={value:T;owner:CompositionPayload};
export function compositionAllowance(owner:string,bytes:number){return new CompositionPayload(reservePromptPayload(owner,bytes),bytes);}
export function createCompositionValue<T>(label:string,bytes:number,create:()=>T):OwnedCompositionValue<T>{
 const owner=compositionAllowance(label,bytes);
 try{const value=create(),retained=compositionPayloadBytes(value);if(retained>bytes)throw Error('COMPOSITION_ALLOWANCE_EXCEEDED');owner.resize(retained);return {value,owner};}catch(error){owner.release();throw error;}
}
export function cloneCompositionValue<T>(value:T){return createCompositionValue('composition-clone',compositionPayloadBytes(value),()=>structuredClone(value));}

// Typed Composition views share CONTROL admission with other application
// models. Raw captions and local authoring algorithms retain their existing
// prompt partition; this does not enlarge either central allocation ceiling.
export function compositionRenderAllowance(bytes:number){return new CompositionPayload(allocationLedger.reserve({owner:'composition-render-payload',kind:'control',cpuBytes:bytes,handles:1}),bytes);}
export function reserveCompositionRead(){return allocationLedger.reserve({owner:'composition-read-operation',kind:'control',handles:1});}
export async function readCompositionJSON<T>(response:Response,owns:()=>boolean,signal:AbortSignal,view:'accepted'|'draft',admitted:AllocationLease):Promise<OwnedCompositionValue<T>>{
 const limit=response.ok?(view==='draft'?COMPOSITION_DRAFT_VIEW_BYTES:COMPOSITION_VIEW_BYTES):65536;
 // The existing exact-length reader admits its byte buffer before allocation,
 // and owns native cancel/unlock through drain, including retained failures.
 const raw=await readCompositionBytes(response,limit,owns,signal,admitted,false);
 let owner:CompositionPayload|undefined;
 try{
  // Decode <=2n UTF-16 bytes plus parsed logical payload <=4n+8. The raw n
  // bytes remain separately charged until this method's finally. Engine/parser
  // object overhead remains an explicit central-ledger coverage gap.
  const allowance=raw.value.byteLength*6+8;
  owner=new CompositionPayload(allocationLedger.reserve({owner:'composition-response-model',kind:'control',cpuBytes:allowance,handles:1}),allowance);
  if(signal.aborted||!owns())throw Error('COMPOSITION_READ_STALE');
  let text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw.value);
  const value=JSON.parse(text) as T;text='';
  owner.resize(compositionPayloadBytes(value));
  if(!response.ok)throw Error((value as {error?:{code?:string}})?.error?.code??'CONTENT_UNAVAILABLE');
  const retained=owner;owner=undefined;return {value,owner:retained};
 }finally{owner?.release();raw.owner.release();}
}
export function parseCompositionValue(raw:Uint8Array,source?:{hash:string;byteLength:string}):OwnedCompositionValue<ParseResult>{
 // Retained parse values are distinct from decoded source/slices and the live
 // ancestor paths (depth <=16). These are allowances, not heap measurements.
 const size=Math.min(raw.byteLength,LIMITS.bytes),scratch=compositionAllowance('composition-parse-scratch',size*(4+2*LIMITS.depth)+4096);
 try{return createCompositionValue('composition-parse-model',size*4+4096,()=>{const result=parseCaption(raw);compositionObservations.parsed(raw.byteLength,result,source);return result;});}finally{scratch.release();}
}
export function encodeCompositionText(value:string){
 const owner=compositionAllowance('composition-encode',bytes(value));
 try{return {value:new TextEncoder().encode(value),owner};}catch(error){owner.release();throw error;}
}
export function serializeCompositionValue(c:Composition,layers:LayerValue[],bindings:Record<string,string>){
 const units=jsonPayloadUnits(c),scratch=compositionAllowance('composition-serialize-scratch',units*12+262144);
 // Projection primitives/keys have bounded count (256 elements, three fields);
 // caption strings are borrowed but conservatively remain charged here.
 try{return createCompositionValue('composition-projection',compositionPayloadBytes(c)*2+units*2+262144,()=>{const result=serialize(c,layers,bindings);compositionObservations.value('derived-snapshot',result.caption,'serialize');compositionObservations.value('issues',[],'serialize');return result;});}catch(error){if(error instanceof CompositionError)compositionObservations.value('issues',error.issues,'serialize');throw error;}finally{scratch.release();}
}
export function projectCompositionValue(...args:Parameters<typeof projectBounds>){return createCompositionValue('composition-box',4096,()=>projectBounds(...args));}
export async function readCompositionBlob(file:Blob,limit:number,inspection?:RawInspection){
 const length=Math.min(file.size,limit),owner=compositionAllowance('composition-raw-copy',length);
 try{const value=new Uint8Array(await file.slice(0,length).arrayBuffer());compositionObservations.read('blob-read',value.byteLength,file.size,inspection);return {value,owner};}catch(error){owner.release();throw error;}
}
export {PromptReaderCleanupError as CompositionReadCleanupError};
export async function readCompositionBytes(response:Response,limit:number,owns:()=>boolean,signal:AbortSignal,admitted?:AllocationLease,observeRaw=true,inspection?:RawInspection){
 let completion:StreamReaderCompletion|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,retainedReader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancelled:Promise<void>|undefined;
 let lease:AllocationLease|undefined=admitted,complete=false,primary:unknown,cancelFailure:unknown,unlockFailure:unknown,cancelFailed=false,unlockFailed=false;
 const cancel=()=>cancelled??=Promise.resolve().then(async()=>{if(!reader&&response.body){lease?.resize({handles:2});reader=response.body.getReader();completion=new StreamReaderCompletion(reader);retainedReader=reader;}if(completion)await completion.cancel();else await response.body?.cancel();});
 const abort=()=>{void cancel().catch(()=>{});};
 try{
  lease??=allocationLedger.reserve({owner:'composition-raw-read',kind:'prompt',handles:1});
  const header=response.headers.get('content-length'),length=header!==null&&/^(0|[1-9][0-9]*)$/.test(header)?Number(header):NaN;
  if(!Number.isSafeInteger(length)||length<0||length>limit||!response.body)throw Error('COMPOSITION_CONTENT_SIZE');
  lease.resize({cpuBytes:length,handles:2});
  reader=response.body.getReader();completion=new StreamReaderCompletion(reader);retainedReader=reader;signal.addEventListener('abort',abort,{once:true});
  const output=new Uint8Array(length);let offset=0;
  for(;;){if(signal.aborted||!owns())throw Error('COMPOSITION_READ_STALE');const item=await completion.read();if(signal.aborted||!owns())throw Error('COMPOSITION_READ_STALE');if(item.done)break;if(offset+item.value.byteLength>length)throw Error('COMPOSITION_CONTENT_SIZE');output.set(item.value,offset);offset+=item.value.byteLength;}
  if(offset!==length)throw Error('COMPOSITION_CONTENT_SIZE');
  reader.releaseLock();reader=undefined;complete=true;lease.resize({handles:1});
  const owner=new CompositionPayload(lease,length);lease=undefined;if(observeRaw)compositionObservations.read('stream-read',output.byteLength,length,inspection);return {value:output,owner};
 }catch(error){primary=error;throw error;}finally{
  signal.removeEventListener('abort',abort);
  if(!complete){try{await cancel();}catch(error){cancelFailed=true;cancelFailure=error;}if(reader)try{reader.releaseLock();reader=undefined;}catch(error){unlockFailed=true;unlockFailure=error;}}
  // Failed drain retains its record as unused; it must not advertise release.
  if(cancelFailed||unlockFailed)throw new PromptReaderCleanupError([primary,...(cancelFailed?[cancelFailure]:[]),...(unlockFailed?[unlockFailure]:[])],{response,reader,retainedReader,cancellation:cancelled,lease},cancelFailed);
  lease?.release();
 }
}

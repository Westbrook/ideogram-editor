import {allocationLedger,type AllocationLease} from './allocations.js';
import {readRetainedPrompt} from './prompt-memory.js';

// Count logical payloads already reachable from JSON-shaped application data.
// Object headers, engine parser internals and DOM copies are not heap estimates.
// Repeated references count conservatively; no serialized copy is made to count.
export function modelPayloadBytes(value:unknown,depth=0):number {
  if(depth>64)throw Error('MODEL_MEMORY_DEPTH');
  if(value===null||value===undefined)return 0;
  if(typeof value==='string')return value.length*2;
  if(typeof value==='number')return 8;
  if(typeof value==='boolean')return 1;
  let bytes=0;
  if(Array.isArray(value)){for(const field of value)bytes+=modelPayloadBytes(field,depth+1);}
  else if(typeof value==='object'){for(const key in value)if(Object.hasOwn(value,key))bytes+=key.length*2+modelPayloadBytes((value as Record<string,unknown>)[key],depth+1);}
  else throw Error('MODEL_MEMORY_VALUE');
  if(!Number.isSafeInteger(bytes))throw Error('MODEL_MEMORY_SIZE');return bytes;
}

export class ModelPayload {
  private refs=1;private live=true;
  constructor(private lease:AllocationLease){}
  private unref(){if(!--this.refs)this.lease.release();}
  pin(){if(!this.refs)throw Error('MODEL_MEMORY_RELEASED');this.refs++;let live=true;return ()=>{if(live){live=false;this.unref();}};}
  resize(bytes:number,handles=1){if(!this.refs)throw Error('MODEL_MEMORY_RELEASED');this.lease.resize({cpuBytes:bytes,handles});}
  release(){if(this.live){this.live=false;this.unref();}}
}
export type OwnedModel<T>=Readonly<{value:T;release():void;pin():()=>void}>;
export type ModelKind='control'|'prompt';
export function reserveModelBytes(owner:string,bytes:number,handles=1,kind:ModelKind='control'){return new ModelPayload(allocationLedger.reserve({owner,kind,cpuBytes:bytes,handles}));}
export function reserveModelPayload(owner:string,value:unknown){return reserveModelBytes(owner,modelPayloadBytes(value));}
export function createOwnedModel<T>(owner:string,allowance:number,create:()=>T,kind:ModelKind='control'):OwnedModel<T>{
  const payload=reserveModelBytes(owner,allowance,1,kind);
  try{const value=create(),retained=modelPayloadBytes(value);if(retained>allowance)throw Error('MODEL_MEMORY_ALLOWANCE');payload.resize(retained);return Object.freeze({value,release:()=>payload.release(),pin:()=>payload.pin()});}
  catch(error){payload.release();throw error;}
}
export function cloneOwnedModel<T>(owner:string,value:T){return createOwnedModel(owner,modelPayloadBytes(value),()=>structuredClone(value));}

export type OwnedJSONOptions={owner:string;init?:RequestInit;owns?:()=>boolean;maxBytes?:number;kind?:ModelKind};
type Transport=(path:string,init?:RequestInit)=>Promise<Response>;
const current=(options:OwnedJSONOptions)=>{if(options.init?.signal?.aborted||options.owns&&!options.owns())throw new DOMException('Model read was superseded.','AbortError');};
/** The caller owns the returned value until release, including any async pins.
 * Caller-controlled retention is never ended at this helper's return boundary.
 * The shared bounded reader owns native cancellation/unlock; its typed failures
 * retain actual resources and are retried by the owning controller's drain. */
export async function readOwnedJSON<T>(transport:Transport,path:string,options:OwnedJSONOptions):Promise<OwnedModel<T>>{
  const maxBytes=options.maxBytes??1024**2;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>16*1024**2)throw Error('MODEL_CONTENT_LIMIT');current(options);
  const admitted=allocationLedger.reserve({owner:options.owner,kind:options.kind??'control',handles:1});
  let response:Response;
  try{response=await transport(path,options.init);}catch(error){admitted.release();throw error;}
  if(response.status===204&&!response.body){admitted.release();current(options);return createOwnedModel<T>(options.owner,0,()=>undefined as T,options.kind);}
  const header=response.headers.get('content-length'),length=header!==null&&/^(0|[1-9][0-9]*)$/.test(header)?Number(header):NaN;
  // Invalid or excessive length enters the reader's pre-body cleanup path with
  // the already-admitted response owner, preserving cancel-failure ownership.
  // Fetch may expose a non-null empty stream for204. Observe its zero-byte EOF
  // through the same owned reader; a status code alone cannot authorize bytes.
  const expected=response.status===204?0:Number.isSafeInteger(length)&&length<=maxBytes?length:NaN;
  const retained=await readRetainedPrompt(response,expected,()=>!options.owns||options.owns(),options.init?.signal??undefined,admitted);
  try{
    current(options);
    if(response.status===204)return createOwnedModel<T>(options.owner,0,()=>undefined as T,options.kind);
    // A one-digit numeric scalar needs at most eight logical bytes per two JSON
    // units including separators. Strings/keys need at most two per input unit.
    const result=createOwnedModel<T>(options.owner,retained.text.length*4+8,()=>JSON.parse(retained.text) as T,options.kind);
    if(!response.ok){result.release();throw Error((result.value as {error?:{code?:string}})?.error?.code??'CONTENT_UNAVAILABLE');}
    return result;
  }finally{retained.lease.release();}
}

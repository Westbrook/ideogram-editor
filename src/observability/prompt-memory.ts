import {allocationLedger,StreamReaderCompletion,type AllocationLease} from './allocations.js';

// UTF-16 payload allowance only. JS object/header/DOM storage is not measured by
// this count. Count escaping before creating a second serialized string.
export function jsonStringUnits(value:string):number {
  let units=2;
  for(let i=0;i<value.length;i++){
    const code=value.charCodeAt(i);
    if(code===34||code===92||code===8||code===9||code===10||code===12||code===13)units+=2;
    else if(code<32)units+=6;
    else if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff){units+=2;i++;}else units+=6;}
    else units+=code>=0xdc00&&code<=0xdfff?6:1;
  }
  return units;
}
export function jsonPayloadUnits(value:unknown,depth=0):number {
  if(depth>64)throw Error('PROMPT_SERIALIZATION_DEPTH');
  if(value===null)return 4;
  if(typeof value==='string')return jsonStringUnits(value);
  if(typeof value==='boolean')return value?4:5;
  // Finite JSON numbers fit 25 code units; use an allowance without formatting.
  if(typeof value==='number')return Number.isFinite(value)?25:4;
  if(Array.isArray(value)){let count=2;for(let i=0;i<value.length;i++)count+=(i?1:0)+jsonPayloadUnits(value[i]??null,depth+1);return count;}
  if(value&&typeof value==='object'){
    let count=2,fields=0;
    for(const key in value)if(Object.hasOwn(value,key)){
      const field=(value as Record<string,unknown>)[key];if(field===undefined)continue;
      count+=(fields++?1:0)+jsonStringUnits(key)+1+jsonPayloadUnits(field,depth+1);
    }
    if(!Number.isSafeInteger(count))throw Error('PROMPT_SERIALIZATION_SIZE');return count;
  }
  throw Error('PROMPT_SERIALIZATION_VALUE');
}
export function reservePromptPayload(owner:string,bytes:number,handles=1){
  return allocationLedger.reserve({owner,kind:'prompt',cpuBytes:bytes,handles});
}
export function reservePromptJSON(owner:string,value:unknown){
  return reservePromptPayload(owner,jsonPayloadUnits(value)*2);
}
type PromptCleanupResource={response:Response;reader?:ReadableStreamDefaultReader<Uint8Array>;retainedReader?:ReadableStreamDefaultReader<Uint8Array>;cancellation?:Promise<void>;lease?:AllocationLease};
const failedPromptCleanups=new Set<PromptReaderCleanupError>();
export class PromptReaderCleanupError extends AggregateError {
 constructor(errors:unknown[],readonly resource:PromptCleanupResource,readonly cancellationFailed:boolean){super(errors,'PROMPT_READER_CLEANUP_FAILED');resource.lease?.markUnused();failedPromptCleanups.add(this);}
 async retry(){
  if(this.resource.reader){try{this.resource.reader.releaseLock();this.resource.reader=undefined;}catch(error){throw new AggregateError([this,error],'PROMPT_READER_UNLOCK_RETRY_FAILED');}}
  // A rejected native cancellation has no documented success receipt. Keep the
  // actual response, reader/lease and primary failure reachable, even unlocked.
  if(this.cancellationFailed)throw this;
  this.resource.lease?.release();this.resource.lease=undefined;failedPromptCleanups.delete(this);
 }
}
export function promptReaderCleanupFailures(){return [...failedPromptCleanups];}
export async function retryPromptReaderCleanups(){const outcomes=await Promise.allSettled([...failedPromptCleanups].map(error=>error.retry()));const errors=outcomes.filter((r):r is PromiseRejectedResult=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'PROMPT_READER_CLEANUP_INCOMPLETE');}
export async function readRetainedPrompt(response:Response,expectedBytes:number,owns:()=>boolean,signal?:AbortSignal,admitted?:AllocationLease){
  let lease:AllocationLease|undefined=admitted,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,retainedReader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancellation:Promise<void>|undefined;
  let primary:unknown,cancelFailure:unknown,unlockFailure:unknown,cancelFailed=false,unlockFailed=false,completion:StreamReaderCompletion|undefined;
  const parts:string[]=[];
  const check=()=>{if(signal?.aborted||!owns())throw Error('PROMPT_READ_STALE');};
  const cancel=()=>cancellation??=Promise.resolve().then(async()=>{if(!reader&&response.body){lease?.resize({handles:2});reader=response.body.getReader();completion=new StreamReaderCompletion(reader);retainedReader=reader;}if(completion)await completion.cancel();else await response.body?.cancel();});
  const abort=()=>{void cancel()?.catch(()=>{});};
  try{
    lease??=reservePromptPayload('request-prompt-read',0,1);check();
    if(!Number.isSafeInteger(expectedBytes)||expectedBytes<0||expectedBytes>16*1024**2||!response.body)throw Error('PROMPT_CONTENT_SIZE');
    // Decoded parts plus their joined UTF-16 payload. Network/native response
    // storage remains outside this app-controlled allowance.
    lease.resize({cpuBytes:expectedBytes*4,handles:2});
    reader=response.body.getReader();completion=new StreamReaderCompletion(reader);retainedReader=reader;signal?.addEventListener('abort',abort,{once:true});check();const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let bytes=0,used=0,slab=new Uint8Array(Math.min(expectedBytes,65536));
    const append=(part:string)=>{if(part){lease!.resize({handles:parts.length+2});parts.push(part);}};
    for(;;){check();const value=await completion.read();check();if(value.done)break;
      bytes+=value.value.byteLength;if(bytes>expectedBytes)throw Error('PROMPT_CONTENT_SIZE');
      // Transport fragmentation must not create one retained JS handle per
      // byte. Coalesce before decoding; the slab fits within the reservation
      // while only one decoded copy exists, then is released before join.
      for(let offset=0;offset<value.value.length;){const count=Math.min(slab.length-used,value.value.length-offset);slab.set(value.value.subarray(offset,offset+count),used);used+=count;offset+=count;if(used===slab.length){append(decoder.decode(slab,{stream:true}));used=0;}}
    }
    if(bytes!==expectedBytes)throw Error('PROMPT_CONTENT_SIZE');if(used)append(decoder.decode(slab.subarray(0,used),{stream:true}));slab=new Uint8Array(0);append(decoder.decode());
    const text=parts.join('');parts.length=0;lease.resize({cpuBytes:text.length*2,handles:1});
    reader.releaseLock();reader=undefined;
    const retained=lease;lease=undefined;return {text,lease:retained};
  }catch(error){
    primary=error;try{await cancel();}catch(error){cancelFailed=true;cancelFailure=error;}
    throw error;
  }finally{
    signal?.removeEventListener('abort',abort);parts.length=0;
    if(reader)try{reader.releaseLock();reader=undefined;}catch(error){unlockFailed=true;unlockFailure=error;}
    if(cancelFailed||unlockFailed)throw new PromptReaderCleanupError([primary,...(cancelFailed?[cancelFailure]:[]),...(unlockFailed?[unlockFailure]:[])],{response,reader,retainedReader,cancellation,lease},cancelFailed);
    lease?.release();
  }
}

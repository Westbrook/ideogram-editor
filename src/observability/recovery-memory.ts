import {allocationLedger,StreamReaderCompletion,type AllocationLease} from './allocations.js';

/** Simultaneously live payload slots in RecoveryConsumer, not JS object headers
 * or IndexedDB/native transport storage. UTF-16 copies count twice UTF-8 bounds.
 * Controls: outer page, nested descriptor, final proof (raw+decoder+parse+canonical).
 * JSONL: one16KiB line, parse/canonical text and base64 conversion temporaries.
 * Entity: one64KiB assembled projection, decoded/parsed/canonical text and IDB copy.
 * Links: imported document/head/current row/parent/resolved dependency; each may
 * coexist with a canonical comparison or one structured-copy payload.
 * SSE: one bounded frame/pending tail plus split, decode, parse and encode copies.
 * Slots remain admitted across nested awaits until the operation ends. */
export const RECOVERY_PAYLOAD_SLOTS=Object.freeze({
 control:Object.freeze({slots:3,utf8Bytes:65536,copies:7}),
 jsonl:Object.freeze({slots:1,utf8Bytes:16384,copies:10}),
 entity:Object.freeze({slots:1,utf8Bytes:65536,copies:11}),
 links:Object.freeze({slots:5,utf8Bytes:65536,copies:4}),
 sse:Object.freeze({slots:1,utf8Bytes:65664,copies:12}),
});
export class RecoveryCleanupError extends Error{constructor(readonly resource:'body'|'reader'){super('RECOVERY_RELEASE_UNCONFIRMED: '+resource);}}
type ReadOwner={completion?:StreamReaderCompletion;response:Response;lease:AllocationLease;reader?:ReadableStreamDefaultReader<Uint8Array>;cancel?:Promise<void>;closed?:boolean};
type Transport=(path:string,init?:RequestInit)=>Promise<Response>;
export class RecoveryWorkspace{
 readonly abort=new AbortController();private leases:AllocationLease[]=[];private responses=new Set<ReadOwner>();private failure:RecoveryCleanupError|undefined;
 private forward=()=>this.cancel();
 constructor(private external?:AbortSignal){
  try{for(const [kind,slot]of Object.entries(RECOVERY_PAYLOAD_SLOTS))this.leases.push(allocationLedger.reserve({owner:'recovery-'+kind,kind:'control',cpuBytes:slot.slots*slot.utf8Bytes*slot.copies,handles:1}));}
  catch(error){for(const lease of this.leases)lease.release();throw error;}
  external?.addEventListener('abort',this.forward,{once:true});if(external?.aborted)this.cancel();
 }
 get signal(){return this.abort.signal;}
 check(){if(this.signal.aborted)throw new DOMException('Recovery was cancelled.','AbortError');}
 cancel(){this.abort.abort();for(const owner of this.responses)void this.cancelOwner(owner).catch(()=>{});}
 private cancelOwner(owner:ReadOwner){return owner.cancel??=(async()=>{try{if(!owner.reader&&owner.response.body){owner.lease.resize({handles:2});owner.reader=owner.response.body.getReader();owner.completion=new StreamReaderCompletion(owner.reader);}if(owner.completion)await owner.completion.cancel();else await owner.response.body?.cancel();}catch{owner.lease.markUnused();const error=new RecoveryCleanupError('body');this.failure=error;throw error;}})();}
 private async closeOwner(owner:ReadOwner){
  if(owner.closed)return;let failure:unknown;
  try{await this.cancelOwner(owner);}catch(error){failure=error;}
  if(owner.reader)try{owner.reader.releaseLock();owner.reader=undefined;}catch{owner.lease.markUnused();failure=new RecoveryCleanupError('reader');this.failure=failure as RecoveryCleanupError;}
  if(failure)throw failure;owner.closed=true;this.responses.delete(owner);owner.lease.release();
 }
 async request(transport:Transport,path:string,init?:RequestInit){
  this.check();const lease=allocationLedger.reserve({owner:'recovery-response',kind:'control',handles:1});let transferred=false;
  try{const response=await transport(path,{...init,signal:this.signal}),owner:ReadOwner={response,lease};this.responses.add(owner);transferred=true;if(this.signal.aborted){await this.closeOwner(owner);this.check();}return response;}
  finally{if(!transferred)lease.release();}
 }
 async *chunks(response:Response):AsyncGenerator<Uint8Array>{
  const owner=[...this.responses].find(value=>value.response===response);if(!owner)throw Error('RECOVERY_RESPONSE_OWNER');
  try{
   this.check();if(!response.body)throw Error('RECOVERY_BODY');owner.lease.resize({handles:2});owner.reader=response.body.getReader();owner.completion=new StreamReaderCompletion(owner.reader);
   for(;;){this.check();const part=await owner.completion.read();this.check();if(part.done)break;
    // The browser supplies this chunk. Admit its exact payload before hashing,
    // copying or retaining it across application work; native read buffers are
    // outside this accounting and remain an independent measurement boundary.
    const lease=allocationLedger.reserve({owner:'recovery-incoming-chunk',kind:'staging',cpuBytes:part.value.byteLength,handles:1});
    try{yield part.value;}finally{lease.release();}
   }
  }finally{await this.closeOwner(owner);}
 }
 async release(){
  this.cancel();let failed:unknown;
  try{for(const owner of this.responses)try{await this.closeOwner(owner);}catch(error){failed=error;}}
  finally{this.external?.removeEventListener('abort',this.forward);for(const lease of this.leases)lease.release();this.leases=[];}
  if(!this.responses.size)this.failure=undefined;
  if(failed||this.failure)throw failed??this.failure;
 }
}

/** Base64 projection parts remain independent UTF-8 segments, matching the
 * existing protocol. Fixed storage rejects before concatenating an oversized
 * entity and avoids re-encoding the complete text after every part. */
export class RecoveryEntityBuffer{
 private bytes=new Uint8Array(65536);private used=0;
 append(base64:string){
  if(typeof base64!=='string'||base64.length>21848)throw Error('RECOVERY_ENTITY_PART');
  const raw=atob(base64);if(btoa(raw)!==base64||raw.length>this.bytes.length-this.used)throw Error('RECOVERY_ENTITY_SIZE');
  const part=Uint8Array.from(raw,value=>value.charCodeAt(0));new TextDecoder('utf-8',{fatal:true}).decode(part);
  this.bytes.set(part,this.used);this.used+=part.length;
 }
 value(){return this.bytes.subarray(0,this.used);}
 text(){return new TextDecoder('utf-8',{fatal:true}).decode(this.value());}
 clear(){this.used=0;}
}

import {allocationLedger,StreamReaderCompletion,type AllocationLease} from '../observability/allocations.js';
import {readOwnedJSON,createOwnedModel,cloneOwnedModel,modelPayloadBytes,reserveModelBytes,type OwnedModel} from '../observability/model-memory.js';
import {PromptReaderCleanupError} from '../observability/prompt-memory.js';
import {parseControlJSON} from '../protocol/json.js';
import {measureControl} from './control-memory.js';
import {SHA256} from '../protocol/sha256.js';
import {event as validateEvent,id,seq,keys,requireValue as ok} from '../protocol/validate.js';
import type {DomainEvent,Receipt} from '../protocol/store.js';
import type {EventPage,ProtocolContentRef,RecoveryContext} from '../protocol/recovery.js';

type Transport=(path:string,init?:RequestInit)=>Promise<Response>;
export const COMMAND_RESULT_LIMITS=Object.freeze({reads:8,controlBytes:65536,lineBytes:16384,outputTypes:128,outputBytes:4*1024**2});
const check=(signal?:AbortSignal)=>{if(signal?.aborted)throw new DOMException('Command result read was cancelled; its original receipt is retained.','AbortError');};
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
type Retryable=PromptReaderCleanupError|CommandReaderCleanupError|CommandRecoveryReleaseError;
/** Native failures remain reachable with their actual resources. This owner
 * drains read operations; it never reports cancellation of a writer command. */
export class CommandControlReads {
 private active=new Map<AbortController,Promise<unknown>>();private failures=new Map<object,Retryable>();private releasing=false;private drain?:Promise<void>;
 capture(error:unknown){if(error instanceof PromptReaderCleanupError)this.failures.set(error.resource,error);else if(error instanceof CommandReaderCleanupError||error instanceof CommandRecoveryReleaseError)this.failures.set(error.ownerIdentity,error);if(error instanceof AggregateError)for(const cause of error.errors)this.capture(cause);}
 run<T>(work:(signal:AbortSignal)=>Promise<T>,external?:AbortSignal|null):Promise<T>{
  if(this.releasing)return Promise.reject(new DOMException('Command result readers are closing. Retry after cleanup finishes.','AbortError'));
  if(this.failures.size)return Promise.reject(Error('COMMAND_RESULT_CLEANUP_REQUIRED'));
  if(this.active.size>=COMMAND_RESULT_LIMITS.reads)return Promise.reject(Error('COMMAND_RESULT_READ_LIMIT'));
  const lease=allocationLedger.reserve({owner:'command-control-operation',kind:'control',cpuBytes:4096,handles:4}),abort=new AbortController(),forward=()=>abort.abort();
  external?.addEventListener('abort',forward,{once:true});if(external?.aborted)abort.abort();
  const task=Promise.resolve().then(()=>{check(abort.signal);return work(abort.signal);}).catch(error=>{this.capture(error);throw error;}).finally(()=>{external?.removeEventListener('abort',forward);this.active.delete(abort);lease.release();});this.active.set(abort,task);return task;
 }
 release(){if(this.drain)return this.drain;this.releasing=true;this.drain=(async()=>{for(const abort of this.active.keys())abort.abort();await Promise.allSettled([...this.active.values()]);const errors:unknown[]=[];for(const [identity,failure] of [...this.failures])try{await failure.retry();this.failures.delete(identity);}catch(error){this.capture(error);errors.push(error);}if(errors.length)throw new AggregateError(errors,'COMMAND_RESULT_CLEANUP_INCOMPLETE');})().finally(()=>{this.releasing=false;this.drain=undefined;});return this.drain;}
 get ownership(){return {controlReads:this.active.size,controlCleanupFailures:this.failures.size};}
}

export class CommandReaderCleanupError extends AggregateError {
 constructor(errors:unknown[],private resource:CommandEventReader){super(errors,'COMMAND_EVENT_READER_CLEANUP_FAILED');}
 get ownerIdentity(){return this.resource;}
 retry(){return this.resource.close();}
}
/** Exactly one response and native lock. Admission happens before fetch, and
 * incoming browser chunks are charged only once they are exposed to the app. */
class CommandEventReader {
 private response?:Response;private reader?:ReadableStreamDefaultReader<Uint8Array>;private retainedReader?:ReadableStreamDefaultReader<Uint8Array>;private completion?:StreamReaderCompletion;
 private cancellation?:Promise<void>;private cancelFailed=false;private cancelError:unknown;private cleanup?:Promise<void>;private closed=false;
 private lease:AllocationLease=allocationLedger.reserve({owner:'command-event-response',kind:'staging',cpuBytes:1024,handles:4});
 private abort=()=>{void this.cancel().catch(()=>{});};
 constructor(private signal?:AbortSignal){}
 async request(transport:Transport,path:string){try{this.response=await transport(path,{signal:this.signal});this.signal?.addEventListener('abort',this.abort,{once:true});check(this.signal);return this.response;}catch(error){if(!this.response){this.lease.release();this.closed=true;}throw error;}}
 private lock(){if(!this.reader&&this.response?.body){this.reader=this.response.body.getReader();this.retainedReader=this.reader;this.completion=new StreamReaderCompletion(this.reader);}}
 private cancel(){return this.cancellation??=Promise.resolve().then(async()=>{try{this.lock();if(this.completion)await this.completion.cancel();else await this.response?.body?.cancel();}catch(error){this.cancelFailed=true;this.cancelError=error;throw error;}});}
 async *chunks(){this.lock();if(!this.reader||!this.completion)throw Error('TRANSACTION_UNAVAILABLE');for(;;){check(this.signal);const part=await this.completion.read();check(this.signal);if(part.done)return;const lease=allocationLedger.reserve({owner:'command-event-incoming',kind:'staging',cpuBytes:part.value.buffer.byteLength,handles:1});try{yield part.value;}finally{lease.release();}}}
 close():Promise<void>{if(this.closed)return Promise.resolve();if(this.cleanup)return this.cleanup;this.cleanup=(async()=>{let unlockError:unknown,unlockFailed=false;try{await this.cancel();}catch{}if(this.reader)try{this.reader.releaseLock();this.reader=undefined;}catch(error){unlockError=error;unlockFailed=true;}if(this.cancelFailed||unlockFailed){this.lease.markUnused();throw new CommandReaderCleanupError([...(this.cancelFailed?[this.cancelError]:[]),...(unlockFailed?[unlockError]:[])],this);}this.signal?.removeEventListener('abort',this.abort);this.response=undefined;this.retainedReader=undefined;this.completion=undefined;this.closed=true;this.lease.release();})().finally(()=>{this.cleanup=undefined;});return this.cleanup;}
}

class EventOutputs {
 private rows=new Map<string,{model:OwnedModel<DomainEvent>;bytes:number}>();private bytes=0;private finished=false;
 private index=allocationLedger.reserve({owner:'command-event-output-index',kind:'control',cpuBytes:COMMAND_RESULT_LIMITS.outputTypes*16,handles:COMMAND_RESULT_LIMITS.outputTypes+1});
 add(model:OwnedModel<DomainEvent>){const previous=this.rows.get(model.value.type),bytes=modelPayloadBytes(model.value),next=this.bytes-(previous?.bytes??0)+bytes;if((!previous&&this.rows.size>=COMMAND_RESULT_LIMITS.outputTypes)||next>COMMAND_RESULT_LIMITS.outputBytes)throw Error('Command result exceeds the local inspection allowance. Its original receipt is saved; release another operation before retrying.');this.rows.set(model.value.type,{model,bytes});this.bytes=next;previous?.model.release();}
 finish():OwnedModel<DomainEvent[]>{
  const arrayOwner=reserveModelBytes('command-event-return-array',this.rows.size*8,this.rows.size+1);let value:DomainEvent[];
  try{value=[];for(const row of this.rows.values())value.push(row.model.value);}catch(error){arrayOwner.release();throw error;}
  this.finished=true;let refs=1,live=true;const drop=()=>{if(!--refs){value.length=0;this.clear();arrayOwner.release();}};
  return Object.freeze({value,release(){if(live){live=false;drop();}},pin(){if(!refs)throw Error('COMMAND_EVENTS_RELEASED');refs++;let held=true;return ()=>{if(held){held=false;drop();}};}});
 }
 private clear(){for(const row of this.rows.values())row.model.release();this.rows.clear();this.bytes=0;this.index.release();}
 release(){if(!this.finished){this.finished=true;this.clear();}}
}

export class CommandRecoveryReleaseError extends Error {
 constructor(private cleanup:()=>Promise<void>){super('COMMAND_RECOVERY_RELEASE_UNCONFIRMED');}
 get ownerIdentity(){return this.cleanup;}
 retry(){return this.cleanup();}
}
function context(value:RecoveryContext){keys(value,['recoveryId','writerEpoch','projectionSchema','highWater','expiresAt']);ok(id(value.recoveryId)&&seq(value.writerEpoch)&&value.writerEpoch.length<=128&&seq(value.highWater)&&value.highWater.length<=128&&Number.isSafeInteger(value.projectionSchema)&&value.projectionSchema>0&&Number.isFinite(Date.parse(value.expiresAt)),'TRANSACTION_UNAVAILABLE');}
function sameContext(a:RecoveryContext,b:RecoveryContext){context(b);ok(a.recoveryId===b.recoveryId&&a.writerEpoch===b.writerEpoch&&a.highWater===b.highWater&&a.projectionSchema===b.projectionSchema,'TRANSACTION_CHANGED');}
function content(ref:ProtocolContentRef,recovery:RecoveryContext){keys(ref,['contentId','url','blob','encoding','recordCount','expiresAt']);keys(ref.blob,['hash','byteLength','mediaType']);ok(id(ref.contentId)&&ref.url===`/api/v1/protocol-content/${ref.contentId}?recoveryId=${recovery.recoveryId}`&&ref.encoding==='lp1-events-jsonl'&&ref.blob.mediaType==='application/x-ndjson'&&/^sha256:[a-f0-9]{64}$/.test(ref.blob.hash)&&seq(ref.blob.byteLength)&&ref.blob.byteLength.length<=128&&seq(ref.recordCount)&&ref.recordCount.length<=128&&Number.isFinite(Date.parse(ref.expiresAt)),'TRANSACTION_UNAVAILABLE');}
async function releaseRecovery(transport:Transport,recoveryId:string,payload:ReturnType<typeof reserveModelBytes>){
 let live=true;
 const cleanup=async()=>{if(!live)return;const result=await readOwnedJSON<void>(transport,'/api/v1/recovery/'+recoveryId+'/release',{owner:'command-recovery-release-response',maxBytes:COMMAND_RESULT_LIMITS.controlBytes,init:{method:'POST',headers:{'Content-Type':'application/json'},body:'{"protocolVersion":1}'}});try{live=false;payload.release();}finally{result.release();}};
 try{await cleanup();}catch(error){const failure=new CommandRecoveryReleaseError(cleanup);throw new AggregateError([error,failure],'COMMAND_RECOVERY_RELEASE_UNCONFIRMED');}
}
export async function readCommandEvents(transport:Transport,receipt:Extract<Receipt,{status:'accepted'}>,signal?:AbortSignal):Promise<OwnedModel<DomainEvent[]>>{
 let outputs:EventOutputs|undefined,scratch:AllocationLease|undefined,recoveryOwner:ReturnType<typeof reserveModelBytes>|undefined,page:OwnedModel<EventPage>|undefined,result:OwnedModel<DomainEvent[]>|undefined,recoveryId:string|undefined;let failed=false,primary:unknown;
 // The fixed row workspace covers the 16 KiB line, strict token parser's UTF-16
 // strings, key sets, canonical validation and encode temporaries. Returned
 // event payloads have separate measured owners, never this scratch allowance.
 try{
  // Reserve release identity before asking the server to acquire a read lease.
  recoveryOwner=reserveModelBytes('command-recovery-release',1024,2);
  scratch=allocationLedger.reserve({owner:'command-event-parse-scratch',kind:'scratch',cpuBytes:COMMAND_RESULT_LIMITS.lineBytes*32+4096,handles:8});outputs=new EventOutputs();
  page=await readOwnedJSON<EventPage>(transport,'/api/v1/commands/'+receipt.commandId+'/result',{owner:'command-event-page',maxBytes:COMMAND_RESULT_LIMITS.controlBytes,init:{signal}});
  const value=page.value;ok(value.protocolVersion===1&&value.kind==='batches','TRANSACTION_UNAVAILABLE');if(id(value.recovery?.recoveryId))recoveryId=value.recovery.recoveryId;context(value.recovery);
  ok(value.recovery.highWater===receipt.toSeq&&value.more===false&&value.nextCursor===receipt.toSeq&&Array.isArray(value.batches)&&value.batches.length===1,'TRANSACTION_UNAVAILABLE');
  const batch=value.batches[0];ok(batch&&batch.fromSeq===receipt.fromSeq&&batch.toSeq===receipt.toSeq&&batch.transactionId===receipt.transactionId,'TRANSACTION_UNAVAILABLE');let count=0n;
  const accept=(event:OwnedModel<DomainEvent>)=>{let transferred=false;try{validateEvent(event.value);ok(event.value.commandId===receipt.commandId&&event.value.transactionId===receipt.transactionId&&BigInt(event.value.workspaceSeq)===BigInt(receipt.fromSeq)+count,'TRANSACTION_CHANGED');outputs!.add(event);transferred=true;count++;}finally{if(!transferred)event.release();}};
  if(batch.kind==='inline'){ok(Array.isArray(batch.events),'TRANSACTION_UNAVAILABLE');for(const event of batch.events){check(signal);measureControl(event,COMMAND_RESULT_LIMITS.lineBytes);accept(cloneOwnedModel('command-event-retained',event));}}
  else{
   ok(batch.kind==='transaction-ref','TRANSACTION_UNAVAILABLE');sameContext(value.recovery,batch.recovery);content(batch.content,value.recovery);ok(batch.eventCount===batch.content.recordCount,'TRANSACTION_UNAVAILABLE');const ref=batch.content,reader=new CommandEventReader(signal);let failure:unknown,hasFailure=false;
   try{const response=await reader.request(transport,ref.url);ok(response.ok&&response.body&&response.headers.get('etag')==='"'+ref.blob.hash+'"'&&response.headers.get('content-length')===ref.blob.byteLength&&response.headers.get('content-type')===ref.blob.mediaType,'TRANSACTION_UNAVAILABLE');const line=new Uint8Array(COMMAND_RESULT_LIMITS.lineBytes),hash=new SHA256();let used=0,length=0n,deadline=performance.now()+4;
    for await(const bytes of reader.chunks()){length+=BigInt(bytes.length);ok(length<=BigInt(ref.blob.byteLength),'TRANSACTION_CORRUPT');for(let at=0;at<bytes.length;){const end=Math.min(bytes.length,at+16384);hash.update(bytes.subarray(at,end));for(;at<end;at++){if(bytes[at]===10){const event=createOwnedModel('command-event-retained',used*4+8,()=>parseControlJSON(line.subarray(0,used)) as unknown as DomainEvent);accept(event);used=0;}else{ok(used<line.length,'TRANSACTION_CORRUPT');line[used++]=bytes[at];}}if(performance.now()>=deadline){await pause();check(signal);deadline=performance.now()+4;}}}
    ok(!used&&String(length)===ref.blob.byteLength&&hash.digest()===ref.blob.hash&&String(count)===ref.recordCount,'TRANSACTION_CORRUPT');
   }catch(error){hasFailure=true;failure=error;}finally{try{await reader.close();}catch(error){throw new AggregateError([...(hasFailure?[failure]:[]),error],'COMMAND_EVENT_READ_FAILED');}}
   if(hasFailure)throw failure;
  }
  ok(count===BigInt(receipt.toSeq)-BigInt(receipt.fromSeq)+1n,'TRANSACTION_INCOMPLETE');
  const proof=await readOwnedJSON<EventPage>(transport,'/api/v1/events?after='+receipt.toSeq+'&recoveryId='+value.recovery.recoveryId,{owner:'command-event-proof',maxBytes:COMMAND_RESULT_LIMITS.controlBytes,init:{signal}});
  try{ok(proof.value.protocolVersion===1&&proof.value.kind==='batches'&&!proof.value.more&&proof.value.nextCursor===receipt.toSeq&&Array.isArray(proof.value.batches)&&proof.value.batches.length===0,'TRANSACTION_CHANGED');sameContext(value.recovery,proof.value.recovery);}finally{proof.release();}
  check(signal);result=outputs.finish();
 }catch(error){failed=true;primary=error;}
 finally{page?.release();scratch?.release();outputs?.release();if(recoveryId)try{await releaseRecovery(transport,recoveryId,recoveryOwner!);}catch(error){result?.release();throw new AggregateError([...(failed?[primary]:[]),error],'COMMAND_RESULT_RELEASE_FAILED');}else recoveryOwner?.release();}
 if(failed)throw primary;return result!;
}

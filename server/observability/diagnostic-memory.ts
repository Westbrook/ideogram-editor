import {opendirSync,type Dir} from 'node:fs';
import {diagnosticMemory,diagnosticPayloadBytes,type DiagnosticMemory,type DiagnosticLease,type DiagnosticRead,DiagnosticReads} from '../../src/observability/diagnostic-memory.js';

/** Receiver admission precedes the native request/dispatch. The same owner
 * covers the incoming graph and conservative serialization/native copy overlap.
 * It may be refunded only after a reply, failed synchronous send, or real exit. */
export type DiagnosticIngress<T>={
 receive(value:T):DiagnosticRead<T>;
 settledWithoutValue():void;
 readonly pending:boolean;
};
export class DiagnosticReceiver {
 private owners=new Set<DiagnosticIngress<unknown>>();private closed=false;
 constructor(private readonly owner:string,private readonly maximumBytes:number,private readonly maximum=4,private readonly memory:DiagnosticMemory=diagnosticMemory){
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>32*1024**2||!Number.isSafeInteger(maximum)||maximum<1||maximum>4)throw Error('DIAGNOSTIC_RECEIVER_LIMIT');
 }
 admit<T>():DiagnosticIngress<T>{
  if(this.closed)throw Error('DIAGNOSTIC_RECEIVER_CLOSED');if(this.owners.size>=this.maximum)throw Error('DIAGNOSTIC_READ_LIMIT');
  const lease=this.memory.reserve(this.owner,this.maximumBytes*3+65536);let value:T|undefined,state:'pending'|'ready'|'released'='pending';
  const drop=()=>{if(state==='released')return;lease.release();value=undefined;state='released';this.owners.delete(ingress as DiagnosticIngress<unknown>);};
  const read=Object.freeze({get value(){if(state!=='ready')throw Error('DIAGNOSTIC_READ_RELEASED');return value!;},release:drop});
  const ingress:DiagnosticIngress<T>=Object.freeze({
   receive:(incoming:T)=>{if(state!=='pending')throw Error('DIAGNOSTIC_RECEIVER_STATE');if(diagnosticPayloadBytes(incoming)>this.maximumBytes)throw Error('DIAGNOSTIC_RECEIVER_SIZE');value=incoming;state='ready';return read;},
   settledWithoutValue:()=>{if(state==='ready')throw Error('DIAGNOSTIC_RECEIVER_STATE');drop();},
   get pending(){return state==='pending';}
  });
  this.owners.add(ingress as DiagnosticIngress<unknown>);return ingress;
 }
 /** Actual exit ends only unfinished native requests; completed consumer reads
  * remain independently owned until their explicit release. */
 nativeExited(){const errors:unknown[]=[];for(const owner of this.owners)if(owner.pending)try{owner.settledWithoutValue();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'DIAGNOSTIC_RECEIVER_RELEASE');}
 close(){this.closed=true;}
 get pending(){let count=0;for(const owner of this.owners)if(owner.pending)count++;return count;}
 get active(){return this.owners.size;}
}

// Fixed synchronous record assembly/traversal workspace; no escaped graph is
// owned by this allowance. Each retained ring/read has its own reservation.
const diagnosticRecordWorkspace=diagnosticMemory.reserve('diagnostic-record-workspace',262144);

/** Persistent capacity is admitted before the first retained clone. A bounded
 * synchronous input borrow never outlives add(); consumers use explicit reads. */
export class DiagnosticRing<T> {
 private rows:T[]=[];private rowSizes:number[]=[];private retainedBytes=0;private lease:DiagnosticLease|undefined;private disposed=false;private readonly reads:DiagnosticReads;private omitted=0;
 constructor(private readonly owner:string,private readonly capacity:number,private readonly rowBytes:number,private readonly memory:DiagnosticMemory=diagnosticMemory,private readonly byteCapacity=capacity*rowBytes){
  if(!Number.isSafeInteger(byteCapacity)||byteCapacity<rowBytes||byteCapacity>capacity*rowBytes)throw Error('DIAGNOSTIC_RING_LIMIT');
  if(!Number.isSafeInteger(capacity)||capacity<1||capacity>64||!Number.isSafeInteger(rowBytes)||rowBytes<1||rowBytes>1024**2)throw Error('DIAGNOSTIC_RING_LIMIT');
  this.reads=new DiagnosticReads(owner+'-read',4,memory);
 }
 add(value:T){
  if(this.disposed)throw Error('DIAGNOSTIC_RING_CLOSED');
  this.lease??=this.memory.reserve(this.owner,this.byteCapacity+this.rowBytes+65536);
  const size=diagnosticPayloadBytes(value);if(size>this.rowBytes){this.omitted++;return false;}
  const retained=structuredClone(value);
  while(this.rows.length===this.capacity||this.retainedBytes+size>this.byteCapacity){this.rows.shift();this.retainedBytes-=this.rowSizes.shift()!;this.omitted++;}this.rows.push(retained);this.rowSizes.push(size);this.retainedBytes+=size;return true;
 }
 /** Only a synchronous scoped producer may borrow this array; read consumers
  * receive an admitted copy from the enclosing diagnostics scope. */
 borrow(){if(this.disposed)throw Error('DIAGNOSTIC_RING_CLOSED');return this.rows as readonly T[];}
 read(){return this.reads.read(diagnosticPayloadBytes(this.rows),()=>structuredClone(this.rows));}
 get dropped(){return this.omitted;}
 dispose(){if(this.disposed)return;this.rows=[];this.rowSizes=[];this.retainedBytes=0;this.lease?.release();this.lease=undefined;this.disposed=true;}
}

// These are sealed subdivisions of a parent reservation, not another budget.
export const STORAGE_DIAGNOSTIC_BYTES=160*1024**2;
export const RASTER_DIAGNOSTIC_BYTES=16*1024**2;
export const STORAGE_DIAGNOSTIC_HANDLES=257,RASTER_DIAGNOSTIC_HANDLES=65;
export const STORAGE_DIAGNOSTIC_REPLY_BYTES=16*1024**2;
export const RASTER_DIAGNOSTIC_REPLY_BYTES=1024**2;
export function adoptWorkerDiagnostics(received:unknown,expected:number){
 if(received!==expected||![STORAGE_DIAGNOSTIC_BYTES,RASTER_DIAGNOSTIC_BYTES].includes(expected)||diagnosticMemory.adopted)throw Error('DIAGNOSTIC_WORKER_GRANT');
 const handleLimit=(expected===STORAGE_DIAGNOSTIC_BYTES?STORAGE_DIAGNOSTIC_HANDLES:RASTER_DIAGNOSTIC_HANDLES)-1;let bytes=0,handles=0;
 diagnosticMemory.adopt(value=>{
  if(bytes+value.cpuBytes>expected||handles+value.handles>handleLimit)throw Error('DIAGNOSTIC_BORROW_LIMIT');bytes+=value.cpuBytes;handles+=value.handles;let live=true;
  return Object.freeze({release(){if(!live)return;live=false;bytes-=value.cpuBytes;handles-=value.handles;}});
 });
}
/** Releases each independent child even when one release rejects. The closure
 * retains failed children and is retryable until all have actually released. */
export function diagnosticReleases(owners:readonly {release():void}[]){
 const pending=new Set(owners);return ()=>{const errors:unknown[]=[];for(const owner of pending)try{owner.release();pending.delete(owner);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'DIAGNOSTIC_RELEASE');};
}

const directoryOwners=new Set<()=>void>();
export function withDiagnosticDirectory<T>(path:string,read:(directory:Dir)=>T):T{
 if(directoryOwners.size>=8)throw Error('DIAGNOSTIC_DIRECTORY_LIMIT');
 const lease=diagnosticMemory.reserve('diagnostic-inventory-directory',65536);let directory:Dir;
 try{directory=opendirSync(path);}catch(error){lease.release();throw error;}
 let closed=false;const release=()=>{if(!closed){directory.closeSync();closed=true;}lease.release();directoryOwners.delete(release);};directoryOwners.add(release);
 let value:T|undefined,failed=false,failure:unknown;try{value=read(directory);}catch(error){failed=true;failure=error;}
 try{release();}catch(error){if(failed)throw new AggregateError([failure,error],'DIAGNOSTIC_DIRECTORY_CLOSE');throw error;}
 if(failed)throw failure;return value!;
}
export function closeDiagnosticDirectories(){const errors:unknown[]=[];for(const release of directoryOwners)try{release();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'DIAGNOSTIC_DIRECTORY_CLOSE');}

import {randomUUID,createHash} from 'node:crypto';
import type {ServerResponse} from 'node:http';
import {allocationLedger,ALLOCATION_LIMITS,type AllocationLease} from '../src/observability/allocations.js';
import {blob as blobRef} from '../src/protocol/validate.js';
import type {BlobRef} from '../src/protocol/store.js';
import {StoreError} from './storage/errors.js';
import {adapterResources} from './observability/adapter-resources.js';

type RPC=(method:string,args:Record<string,unknown>)=>Promise<unknown>;
const METADATA_BYTES=1024**2;
type Booking={lease:AllocationLease;bytes:number;releasing:boolean;releaseOwnership:()=>void};
export class CompositionReads {
 private live=new Map<string,Booking>();private exited=false;
 constructor(private rpc:RPC,private owner='composition-view',private maximum=4,private family:'composition'|'storage-read'|'storage-registry'='composition'){if(!Number.isSafeInteger(maximum)||maximum<1||maximum>4)throw new StoreError('MALFORMED_REQUEST');}
 nativeExited(){this.exited=true;for(const [id,b] of this.live)if(b.releasing){b.lease.release();b.releaseOwnership();this.live.delete(id);}}
 private async drop(id:string,b:Booking){
  if(!this.live.has(id))return;b.releasing=true;
  if(!this.exited)await this.rpc('compositionRelease',{id});
  b.lease.release();b.releaseOwnership();this.live.delete(id);
 }
 async drain(){for(const [id,b] of this.live)if(b.releasing)await this.drop(id,b);}
 async open(current:()=>void=()=>{}){
  current();await this.drain();current();
  if(this.exited)throw new StoreError('CLOSED');if(this.live.size>=this.maximum)throw new StoreError('CAPACITY');
  if(process.memoryUsage().rss+METADATA_BYTES>ALLOCATION_LIMITS.cpuBytes)throw new StoreError('CAPACITY');
  const id=randomUUID(),b:Booking={lease:allocationLedger.reserve({owner:this.owner,kind:'control',cpuBytes:METADATA_BYTES,handles:2}),bytes:METADATA_BYTES,releasing:false,releaseOwnership:adapterResources.uncovered('borrowed-'+this.family)};this.live.set(id,b);
  const release=()=>this.drop(id,b);
  try{await this.rpc('compositionResize',{id,bytes:b.bytes,family:this.family});current();}
  catch(error){try{await release();}catch(cleanup){throw new AggregateError([error,cleanup],'COMPOSITION_RELEASE_INCOMPLETE');}throw error;}
  const grow=async(extra:number)=>{
   current();if(b.releasing||!this.live.has(id))throw new StoreError('CLOSED');const before=b.bytes,next=before+extra;
   if(!Number.isSafeInteger(extra)||extra<0||!Number.isSafeInteger(next))throw new StoreError('CAPACITY');
   if(process.memoryUsage().rss+extra>ALLOCATION_LIMITS.cpuBytes)throw new StoreError('CAPACITY');
   b.lease.resize({cpuBytes:next});b.bytes=next;
   try{await this.rpc('compositionResize',{id,bytes:next,family:this.family});current();}
   catch(error){
    // A caller-known ID makes uncertain delivery recoverable. Do not refund
    // central credit until the previous worker mirror is acknowledged.
    if(!this.exited)await this.rpc('compositionResize',{id,bytes:before,family:this.family});
    b.lease.resize({cpuBytes:before});b.bytes=before;throw error;
   }
  };
  return {
   id,grow,release,
   openContent:async(ref:BlobRef)=>{current();blobRef(ref);const handle=await this.rpc('compositionContentOpen',{id,ref}) as string;current();return handle;},
   dropContent:async(handle:string)=>{if(!this.exited)await this.rpc('compositionContentDrop',{id,handle});},
   read:async(ref:BlobRef,limit:number)=>{
    blobRef(ref);const n=Number(ref.byteLength);
    if(!Number.isSafeInteger(n)||n<0||n>limit)throw new StoreError('PAYLOAD_TOO_LARGE');
    // Input buffer + decoded UTF-16 + parsed logical payload and bounded
    // transport chunk are retained conservatively until the whole view drains.
    await grow(n*8);let handle:string|undefined,output:Uint8Array|undefined,releaseOutput=()=>{};
    try{
     try{
      handle=await this.rpc('compositionContentOpen',{id,ref}) as string;current();output=new Uint8Array(n);releaseOutput=adapterResources.buffer('composition-read','assembled-bytes',output);const hash=createHash('sha256');
      for(let at=0;at<n;){current();const count=Math.min(65536,n-at),part=await this.rpc('content',{handle,offset:String(at),length:count}) as Uint8Array;
       try{current();if(!(part instanceof Uint8Array)||part.byteLength!==count)throw new StoreError('CORRUPT_OBJECT');output.set(part,at);hash.update(part);at+=count;}
       finally{if(part instanceof Uint8Array)adapterResources.releaseReturned(part);}}
      if('sha256:'+hash.digest('hex')!==ref.hash)throw new StoreError('CORRUPT_OBJECT');
     }finally{if(handle!==undefined&&!this.exited)await this.rpc('compositionContentDrop',{id,handle});}
     return adapterResources.returnedBuffer('composition-read','metadata-bytes',output!);
    }finally{releaseOutput();}
   },
  };
 }
}
export type CompositionRead=Awaited<ReturnType<CompositionReads['open']>>;

/** Exact UTF-8 length of JSON.stringify for validated JSON DTOs, without
 * making the serialized string before its reservation. */
export function compositionJSONBytes(value:unknown,limit:number):number{
 let total=0;const add=(n:number)=>{total+=n;if(!Number.isSafeInteger(total)||total>limit)throw new StoreError('PAYLOAD_TOO_LARGE');};
 const string=(v:string)=>{add(2);for(let i=0;i<v.length;i++){const cp=v.charCodeAt(i);if(cp===34||cp===92||cp===8||cp===9||cp===10||cp===12||cp===13)add(2);else if(cp<32)add(6);else if(cp>=0xd800&&cp<=0xdbff){const next=v.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff){add(4);i++;}else add(6);}else if(cp>=0xdc00&&cp<=0xdfff)add(6);else add(cp<128?1:cp<2048?2:3);}};
 const walk=(v:unknown,depth:number)=>{if(depth>64)throw new StoreError('MALFORMED_REQUEST');if(v===null){add(4);return;}if(typeof v==='string'){string(v);return;}if(typeof v==='boolean'){add(v?4:5);return;}if(typeof v==='number'){if(!Number.isFinite(v))throw new StoreError('MALFORMED_REQUEST');add(JSON.stringify(v).length);return;}if(Array.isArray(v)){add(2);for(let i=0;i<v.length;i++){if(i)add(1);walk(v[i],depth+1);}return;}if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw new StoreError('MALFORMED_REQUEST');add(2);let fields=0;for(const key in v)if(Object.hasOwn(v,key)){const d=Object.getOwnPropertyDescriptor(v,key)!;if(!('value'in d)||d.value===undefined)throw new StoreError('MALFORMED_REQUEST');if(fields++)add(1);string(key);add(1);walk(d.value,depth+1);}};
 walk(value,0);return total;
}
export async function sendCompositionJSON(response:ServerResponse,value:unknown,limit:number,read:Pick<CompositionRead,'grow'>,check:()=>Promise<void>){
 const bytes=compositionJSONBytes(value,limit);await read.grow(bytes*3);await check();
 const body=Buffer.from(JSON.stringify(value),'utf8'),releaseBody=adapterResources.buffer('composition-response','json-bytes',body);
 try{if(body.byteLength!==bytes)throw new StoreError('CORRUPT_STORE');
 await new Promise<void>((resolve,reject)=>{
  let settled=false;const done=(error?:Error|null)=>{if(settled)return;settled=true;response.off('close',closed);response.off('error',done);error?reject(error):resolve();};
  const closed=()=>done(new StoreError('CLOSED'));response.once('close',closed);response.once('error',done);
  try{if(response.destroyed){closed();return;}response.writeHead(200,{'Content-Type':'application/json','Content-Length':bytes,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(body,(error?:Error|null)=>done(error));}catch(error){done(error instanceof Error?error:new StoreError('STORAGE_FAILURE'));}
 });
 }finally{releaseBody();}
}
export function endCompositionResponse(response:ServerResponse){
 return new Promise<void>((resolve,reject)=>{
  let settled=false;const done=(error?:Error|null)=>{if(settled)return;settled=true;response.off('close',closed);response.off('error',done);error?reject(error):resolve();};
  const closed=()=>done(new StoreError('CLOSED'));response.once('close',closed);response.once('error',done);
  try{if(response.destroyed){closed();return;}response.end((error?:Error|null)=>done(error));}catch(error){done(error instanceof Error?error:new StoreError('STORAGE_FAILURE'));}
 });
}

import { SHA256 } from '../protocol/sha256.js';
import { allocationLedger, StreamReaderCompletion, type AllocationLease } from '../observability/allocations.js';
import type { Download } from './editor-client.js';
type Sink={write(data:ArrayBuffer):Promise<void>;close():Promise<void>;abort():Promise<void>};
type Destination={createWritable():Promise<Sink>};
type DestinationPhase='receiving'|'committing';
const DOWNLOAD_CHUNK_BYTES=1024*1024;
type OwnedBlob={blob:Blob;lease:AllocationLease;urlOwned?:boolean};
const spoolOwners=new Map<string,{bytes:number;active:boolean;lease:AllocationLease}>();
const handedOffBlobs=new Map<string,{bytes:number;settled:Promise<void>;failed:boolean;release():void}>();
let copyingFallbacks=0;
export function destinationResources(){return {spoolDatabases:spoolOwners.size,spoolBytes:[...spoolOwners.values()].reduce((sum,value)=>sum+value.bytes,0),downloadBlobs:handedOffBlobs.size,downloadBlobBytes:[...handedOffBlobs.values()].reduce((sum,value)=>sum+value.bytes,0),copyingFallbacks};}
export async function settleDestinationDownloads(signal?:AbortSignal){
 for(const owner of handedOffBlobs.values()){checkCancellation(signal);if(owner.failed)owner.release();}
 const completed=Promise.all([...handedOffBlobs.values()].map(value=>value.settled));
 if(!signal)await completed;
 else await new Promise<void>((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason??new DOMException('Destination write canceled','AbortError'));};signal.addEventListener('abort',abort,{once:true});completed.then(()=>{signal.removeEventListener('abort',abort);resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});if(signal.aborted)abort();});
 for(const [name,owner] of spoolOwners){checkCancellation(signal);if(!owner.active)await deleteSpool(name);}
}
function deleteSpool(name:string):Promise<void>{
 return new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=()=>{spoolOwners.get(name)?.lease.release();spoolOwners.delete(name);resolve();};request.onerror=()=>{spoolOwners.get(name)?.lease.markUnused();reject(request.error??Error('DOWNLOAD_SPOOL_CLEANUP_FAILED'));};request.onblocked=()=>{spoolOwners.get(name)?.lease.markUnused();reject(Error('DOWNLOAD_SPOOL_CLEANUP_BLOCKED'));};});
}
function transactionFinished(tx:IDBTransaction,signal?:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{try{tx.abort();}catch{/* A transaction already committed before cancellation. */}};
  const clear=()=>signal?.removeEventListener('abort',abort);
  tx.oncomplete=()=>{clear();try{checkCancellation(signal);resolve();}catch(error){reject(error);}};
  tx.onabort=()=>{clear();reject(signal?.aborted?signal.reason??new DOMException('Destination write canceled','AbortError'):tx.error??Error('DOWNLOAD_SPOOL_TRANSACTION_ABORTED'));};
  tx.onerror=()=>{/* onabort owns the complete transaction outcome. */};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
async function independentDownloadBlob(file:File,expected:Pick<Download,'hash'|'bytes'>,signal?:AbortSignal):Promise<OwnedBlob>{
 // getFile() is backed by the OPFS entry. A File or new Blob([file]) cannot
 // authorize unlinking it. Copy actual bytes in bounded chunks into immutable,
 // non-File Blobs, and await their IndexedDB transaction before dropping each
 // source buffer. Native Blob allocation remains a measured browser property.
 const name='ie-download-spool-'+crypto.randomUUID();let db:IDBDatabase|undefined,owned=false,failed=false,primary:unknown,result:OwnedBlob|undefined;
 const spoolLease=allocationLedger.reserve({owner:'download-idb-spool',kind:'staging',handles:1});
 const bins:(OwnedBlob|undefined)[]=[];let count=0;
 try{
  checkCancellation(signal);
  const estimate=await navigator.storage.estimate();checkCancellation(signal);
  if(estimate.quota!==undefined&&estimate.usage!==undefined&&estimate.quota-estimate.usage<file.size+DOWNLOAD_CHUNK_BYTES)throw Error('DOWNLOAD_CAPACITY');
  db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{owned=true;spoolOwners.set(name,{bytes:0,active:true,lease:spoolLease});request.result.createObjectStore('chunks');};request.onsuccess=()=>{if(!owned){request.result.close();reject(Error('DOWNLOAD_SPOOL_COLLISION'));}else resolve(request.result);};request.onerror=()=>reject(request.error??Error('DOWNLOAD_SPOOL_UNAVAILABLE'));request.onblocked=()=>reject(Error('DOWNLOAD_SPOOL_BLOCKED'));});
  const hash=new SHA256();let copied=0n;
  for(let offset=0;offset<file.size;offset+=DOWNLOAD_CHUNK_BYTES){
   checkCancellation(signal);const length=Math.min(DOWNLOAD_CHUNK_BYTES,file.size-offset);
   // ArrayBuffer and Blob constructor bytes can overlap until the native IDB
   // transaction settles. Reserve both before creating either owned copy.
   const chunk=allocationLedger.reserve({owner:'download-idb-copy',kind:'copy',cpuBytes:length*2,handles:2});
   try{const bytes=new Uint8Array(await file.slice(offset,offset+length).arrayBuffer());checkCancellation(signal);
    hash.update(bytes);copied+=BigInt(bytes.byteLength);if(copied>BigInt(expected.bytes))throw Error('DOWNLOAD_CHANGED');
    const blob=new Blob([bytes]),tx=db.transaction('chunks','readwrite'),finished=transactionFinished(tx,signal);
    try{tx.objectStore('chunks').add(blob,count++);}catch(error){try{tx.abort();}catch{/* Already completed. */}await finished.catch(()=>{});throw error;}
    await finished;
    spoolOwners.get(name)!.bytes+=bytes.byteLength;
   }finally{chunk.release();}
  }
  if(String(copied)!==expected.bytes||hash.digest()!==expected.hash)throw Error('DOWNLOAD_CORRUPT');
  for(let index=0;index<count;index++){
   checkCancellation(signal);let current:OwnedBlob|undefined;
   const readLease=allocationLedger.reserve({owner:'download-blob-part',kind:'blob',handles:1});
   try{const tx=db.transaction('chunks'),finished=transactionFinished(tx,signal);let request:IDBRequest,chunk:Blob|undefined;
    try{request=tx.objectStore('chunks').get(index);}catch(error){try{tx.abort();}catch{/* Already completed. */}await finished.catch(()=>{});throw error;}
    request.onsuccess=()=>{chunk=request.result;};await finished;
    if(!(chunk instanceof Blob)||chunk instanceof File||chunk.size>DOWNLOAD_CHUNK_BYTES)throw Error('DOWNLOAD_SPOOL_CORRUPT');
    // A Blob read from IndexedDB can still depend on the database's backing
    // file in Firefox. Blob([chunk]) does not detach it before database deletion.
    // Copy one bounded chunk while charging both the buffer and Blob copy.
    const detached=allocationLedger.reserve({owner:'download-idb-detach',kind:'copy',cpuBytes:chunk.size*2,handles:2});
    try{const bytes=await chunk.arrayBuffer();checkCancellation(signal);if(bytes.byteLength!==chunk.size)throw Error('DOWNLOAD_SPOOL_CORRUPT');current={blob:new Blob([bytes]),lease:readLease};}
    finally{detached.release();}
    // A balanced tree keeps only O(log chunk-count) handles in application code.
    // IDB/Blob backing may be disk or native memory: logical file size is not a
    // resident CPU measurement. The ledger records these handles, not a false
    // native Blob memory bound; destinationResources exposes logical bytes.
    let level=0;while(bins[level]){const left=bins[level]!,lease=allocationLedger.reserve({owner:'download-blob-join',kind:'blob',handles:1});
     let joined:Blob;try{joined=new Blob([left.blob,current.blob]);}catch(error){lease.release();throw error;}
     left.lease.release();current.lease.release();bins[level]=undefined;current={blob:joined,lease};level++;
    }bins[level]=current;current=undefined;
   }catch(error){if(current)current.lease.release();else readLease.release();throw error;}
  }
  const lease=allocationLedger.reserve({owner:'download-independent-blob',kind:'blob',handles:1});
  try{result={blob:new Blob(bins.reverse().filter((part):part is OwnedBlob=>part!==undefined).map(part=>part.blob)),lease};}catch(error){lease.release();throw error;}
  if(String(result.blob.size)!==expected.bytes)throw Error('DOWNLOAD_SPOOL_CORRUPT');checkCancellation(signal);
  }catch(error){if(error instanceof DOMException&&error.name==='QuotaExceededError')error=new Error('DOWNLOAD_CAPACITY',{cause:error});failed=true;primary=error;throw error;}
 finally{
  for(const part of bins)part?.lease.release();bins.length=0;db?.close();const owner=spoolOwners.get(name);if(owner)owner.active=false;
  if(failed)result?.lease.release();
  if(owned)try{await deleteSpool(name);}catch(error){result?.lease.release();throw new AggregateError([...(failed?[primary]:[]),error],'Download spool cleanup incomplete',{cause:primary??error});}
  else spoolLease.release();
 }
 return result!;
}
function offerDownload(owned:OwnedBlob,name:string){
 const {blob,lease}=owned;
 const urlLease=allocationLedger.reserve({owner:'download-object-url',kind:'blob',handles:1});let url:string;
 try{url=URL.createObjectURL(blob);}catch(error){urlLease.release();throw error;}
 let settle!:()=>void,fail!:(error:unknown)=>void;
 const settled=new Promise<void>((resolve,reject)=>{settle=resolve;fail=reject;});void settled.catch(()=>{});
 const release=():void=>{try{URL.revokeObjectURL(url);}catch(error){owner.failed=true;lease.markUnused();urlLease.markUnused();fail(error);throw error;}
  handedOffBlobs.delete(url);owned.urlOwned=false;lease.release();urlLease.release();settle();
 };
 const owner={bytes:blob.size,settled,failed:false,release};owned.urlOwned=true;handedOffBlobs.set(url,owner);
 try{const link=document.createElement('a');link.href=url;link.download=name;link.click();}
 catch(error){try{release();}catch(cleanup){throw new AggregateError([error,cleanup],'Download URL cleanup incomplete',{cause:error});}throw error;}
 // HTML's download activation starts Fetch before click() returns. File API
 // keeps already-started requests valid after revocation. Release our mapping
 // on the next task; the native download owns independent immutable Blob data,
 // never an OPFS File. Three-engine download/hash tests verify this boundary.
 // https://html.spec.whatwg.org/multipage/links.html#downloading-resources
 // https://w3c.github.io/FileAPI/#dfn-revokeObjectURL
 setTimeout(()=>{try{release();}catch{/* The retained owner is retried by settleDestinationDownloads. */}},0);
}
function checkCancellation(signal?:AbortSignal){if(signal?.aborted)throw signal.reason??new DOMException('Destination write canceled','AbortError');}
function selectedDestination(chosen:Promise<Destination>,signal?:AbortSignal):Promise<Destination>{
  if(!signal)return chosen;
  return new Promise((resolve,reject)=>{
    const aborted=()=>{signal.removeEventListener('abort',aborted);reject(signal.reason??new DOMException('Destination write canceled','AbortError'));};
    signal.addEventListener('abort',aborted,{once:true});
    chosen.then(destination=>{signal.removeEventListener('abort',aborted);resolve(destination);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
    if(signal.aborted)aborted();
  });
}
function receivedResponse(pending:Promise<Response>,signal?:AbortSignal):Promise<Response>{
  if(!signal)return pending;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const aborted=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);reject(signal.reason??new DOMException('Destination write canceled','AbortError'));};
    signal.addEventListener('abort',aborted,{once:true});
    pending.then(response=>{
      if(settled){void response.body?.cancel().catch(()=>{});return;}
      settled=true;signal.removeEventListener('abort',aborted);resolve(response);
    },error=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);reject(error);});
    if(signal.aborted)aborted();
  });
}
export function chooseDestination(name:string,signal?:AbortSignal):Promise<Destination>|null {
  if(signal?.aborted){const cancelled=Promise.reject<Destination>(signal.reason??new DOMException('Destination write canceled','AbortError'));void cancelled.catch(()=>{});return cancelled;}
  const picker=(window as unknown as {showSaveFilePicker?:(options:{suggestedName:string})=>Promise<Destination>}).showSaveFilePicker;
  const chosen=picker?picker.call(window,{suggestedName:name}):null;
  // Attach immediately: the UI yields for pending feedback before awaiting it.
  void chosen?.catch(()=>{});return chosen;
}
export async function writeDestination(download:Pick<Download,'path'|'name'|'hash'|'bytes'>,transport:(path:string,init?:RequestInit)=>Promise<Response>,chosen:Promise<Destination>|null,signal?:AbortSignal,onPhase?:(phase:DestinationPhase)=>void){
  // A caller may hand us an already-rejected picker while cancellation wins.
  void chosen?.catch(()=>{});
  let sink:Sink|undefined;let temporary:FileSystemFileHandle|undefined;
  let response:Response|undefined;
  let temporaryRoot:FileSystemDirectoryHandle|undefined,temporaryName:string|undefined;let handedOff=false;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,readerCompletion:StreamReaderCompletion|undefined,readerCancellation:Promise<void>|undefined,sinkAbortion:Promise<void>|undefined;
  let readerLease:AllocationLease|undefined,sinkLease:AllocationLease|undefined,temporaryLease:AllocationLease|undefined,blob:OwnedBlob|undefined;
  const unsettledWrites=new Set<AllocationLease>();
  const releaseSink=()=>{sinkLease?.release();for(const lease of unsettledWrites)lease.release();unsettledWrites.clear();};
  let streamCleanupFailed=false,streamCleanupFailure:unknown;
  let fallbackOwned=false;
  const cancelReader=()=>{if(!readerCompletion)return Promise.resolve();return readerCancellation??=Promise.resolve().then(()=>readerCompletion!.cancel()).catch(error=>{streamCleanupFailed=true;streamCleanupFailure=error;throw error;});};
  const releaseReader=()=>{try{reader?.releaseLock();readerLease?.release();}catch(error){readerLease?.markUnused();const cause=signal?.aborted?signal.reason??new DOMException('Destination write canceled','AbortError'):error;throw new AggregateError(cause===error?[error]:[cause,error],'Download reader cleanup incomplete',{cause});}};
  const abortSink=()=>{if(!sink)return Promise.resolve();const owned=sink;return sinkAbortion??=Promise.resolve().then(()=>owned.abort()).then(releaseSink);};
  const writable=async(destination:Destination)=>{const lease=allocationLedger.reserve({owner:'download-native-writer',kind:'staging',handles:1});try{const value=await destination.createWritable();sinkLease=lease;return value;}catch(error){lease.release();throw error;}};
  // Interrupt pending stream reads and writes as well as checking their results.
  // Cleanup below awaits these same operations, preserving their failures.
  const cancelled=()=>{void cancelReader().catch(()=>{});void abortSink().catch(()=>{});};
  signal?.addEventListener('abort',cancelled,{once:true});
  try{
    checkCancellation(signal);
    if(chosen){const destination=await selectedDestination(chosen,signal);checkCancellation(signal);sink=await writable(destination);checkCancellation(signal);}
    else{
      if(copyingFallbacks)throw Error('DOWNLOAD_ALREADY_PREPARING');
      copyingFallbacks++;fallbackOwned=true;
      // A previous browser handoff has a finite URL ownership window. Do not
      // accumulate another large Blob while the application still owns it.
      await settleDestinationDownloads(signal);checkCancellation(signal);
      // Disk-backed fallback avoids accumulating an entire project in JS memory.
      const root=await navigator.storage.getDirectory();checkCancellation(signal);
      const name='ie-download-'+crypto.randomUUID();
      // Refuse a known collision; the attempt owns only its newly created entry.
      try{await root.getFileHandle(name);checkCancellation(signal);throw Error('DOWNLOAD_TEMPORARY_COLLISION');}
      catch(error){checkCancellation(signal);if(!(error instanceof DOMException)||error.name!=='NotFoundError')throw error;}
      temporaryLease=allocationLedger.reserve({owner:'download-opfs-entry',kind:'scratch',handles:1});
      try{temporary=await root.getFileHandle(name,{create:true});}catch(error){temporaryLease.release();throw error;}
      temporaryRoot=root;temporaryName=name;checkCancellation(signal);
      sink=await writable(temporary);checkCancellation(signal);
    }
    onPhase?.('receiving');checkCancellation(signal);
    // Pass the signal to native fetch and fence transports that settle late.
    response=await receivedResponse(signal?transport(download.path,{signal}):transport(download.path),signal);
    checkCancellation(signal);
    if(!response.ok||!response.body||response.headers.get('etag')!=='"'+download.hash+'"'||response.headers.get('content-length')!==download.bytes)throw Error('DOWNLOAD_UNAVAILABLE');
    readerLease=allocationLedger.reserve({owner:'download-response-reader',kind:'staging',handles:1});
    try{reader=response.body.getReader();}catch(error){readerLease.release();throw error;}
    readerCompletion=new StreamReaderCompletion(reader);
    const hash=new SHA256();let length=0n;
    try{for(;;){checkCancellation(signal);const {done,value}=await readerCompletion.read();checkCancellation(signal);if(done)break;
      const incoming=allocationLedger.reserve({owner:'download-received-chunk',kind:'staging',cpuBytes:value.byteLength,handles:1});
      try{length+=BigInt(value.length);if(length>BigInt(download.bytes))throw Error('DOWNLOAD_CHANGED');
       for(let i=0;i<value.length;i+=32768){checkCancellation(signal);const part=value.subarray(i,i+32768);hash.update(part);
        // The explicit copy and native write extraction can overlap. A failed
        // write retains its reservation until abort/close establishes release.
        const copy=allocationLedger.reserve({owner:'download-write-copy',kind:'copy',cpuBytes:part.byteLength*2,handles:2});unsettledWrites.add(copy);
        await sink!.write(new Uint8Array(part).buffer);copy.release();unsettledWrites.delete(copy);checkCancellation(signal);
       }
      }finally{incoming.release();}
    }}finally{
      // An errored fetch can reject cancel() even after the read has settled.
      // Release the actual reader lock independently; preserve source cleanup
      // failure above without inventing a retained reader after it is unlocked.
      try{await cancelReader();}catch(error){try{releaseReader();}catch(failure){throw new AggregateError([error,failure],'Download reader cleanup incomplete',{cause:error});}throw error;}
      releaseReader();
    }
    checkCancellation(signal);
    if(String(length)!==download.bytes||hash.digest()!==download.hash)throw Error('DOWNLOAD_CORRUPT');
    checkCancellation(signal);if(!temporary)onPhase?.('committing');checkCancellation(signal);
    // Native close is the commit point. Cancellation after it starts cannot
    // promise rollback, but must never publish a confirmed destination result.
    await sink!.close();sink=undefined;releaseSink();checkCancellation(signal);
    if(temporary){
      const file=await temporary.getFile();checkCancellation(signal);blob=await independentDownloadBlob(file,download,signal);checkCancellation(signal);
      // The complete independent Blob exists and its temporary IDB is gone.
      // Delete the attempt-owned OPFS entry before offering a browser download.
      await temporaryRoot!.removeEntry(temporaryName!);temporaryLease?.release();temporary=undefined;temporaryRoot=undefined;temporaryName=undefined;checkCancellation(signal);
      onPhase?.('committing');checkCancellation(signal);offerDownload(blob,download.name);handedOff=true;return 'unconfirmed' as const;
    }
    return 'confirmed' as const;
  }catch(error){
    if(signal?.aborted&&!(error instanceof AggregateError))error=signal.reason??new DOMException('Destination write canceled','AbortError');
    else if(error instanceof DOMException&&error.name==='QuotaExceededError')error=new Error('DOWNLOAD_CAPACITY',{cause:error});
    const cleanupErrors:unknown[]=[];
    // Validation or allocation admission may refuse before a reader exists.
    // This response still belongs to the attempt and must be drained/canceled.
    if(response?.body&&!reader)try{await response.body.cancel();}catch(failure){if(failure!==error)cleanupErrors.push(failure);}
    // StreamReaderCompletion already distinguishes the original stored stream
    // error from a genuine cancel rejection. Preserve every remaining failure,
    // even when the underlying source rejected with the user's abort reason.
    if(signal?.aborted&&streamCleanupFailed)cleanupErrors.push(streamCleanupFailure);
    // Settle the writer before unlinking. An uncertain writer leaves the entry
    // intact and reports incomplete cleanup alongside the original failure.
    if(sink){const ownedSink=sink;try{await abortSink();sink=undefined;}catch(failure){
      // A native convenience write may temporarily hold the stream lock. Once
      // that awaited write has settled, retry an abort rejected during it.
      if(signal?.aborted){try{await ownedSink.abort();sink=undefined;releaseSink();}catch(retryFailure){cleanupErrors.push(failure,retryFailure);}}
      else cleanupErrors.push(failure);
    }}
    if(!handedOff&&!sink&&temporaryRoot&&temporaryName){try{await temporaryRoot.removeEntry(temporaryName);temporaryLease?.release();}catch(failure){cleanupErrors.push(failure);}}
    if(cleanupErrors.length)throw new AggregateError([error,...cleanupErrors],(error instanceof Error?error.message:String(error))+'; download cleanup incomplete',{cause:error});
    throw error;
  }finally{
    signal?.removeEventListener('abort',cancelled);if(fallbackOwned)copyingFallbacks--;
    if(!handedOff&&!blob?.urlOwned)blob?.lease.release();
    // Failed native cleanup is not permission to erase a charged owner.
    if(sink){sinkLease?.markUnused();for(const lease of unsettledWrites)lease.markUnused();}
    if(temporaryRoot&&temporaryName)temporaryLease?.markUnused();
  }
}

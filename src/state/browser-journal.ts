// Disposable browser delivery cache. Writer receipts remain authoritative.
import {allocationLedger} from '../observability/allocations.js';
import {ControlAdmissionError,JOURNAL_RECORD_BYTES,journalRecordBytes} from './control-memory.js';

let activeUnverifiedReads=0,unverifiedReads=0,rejectedRecords=0;
const increment=(value:number)=>Math.min(Number.MAX_SAFE_INTEGER,value+1);
/** Older databases have no trusted size sidecar. A native cursor/get clone may
 * already exist before application code can inspect it. This is explicit
 * uncertainty, never a claim that the normal 1 MiB slot bounds native memory.
 * Counters are fixed-size and retain neither records nor identifiers. */
export function journalReadCoverage(){return Object.freeze({activeUnverifiedReads,unverifiedReads,rejectedRecords,nativeCloneBytesKnown:false as const});}
function readAdmission(){
 const payload=allocationLedger.reserve({owner:'journal-read-copy',kind:'control',cpuBytes:JOURNAL_RECORD_BYTES,handles:1});
 let uncertainty:ReturnType<typeof allocationLedger.reserve>;
 try{uncertainty=allocationLedger.reserve({owner:'journal-unverified-native-read',kind:'control',handles:1});}catch(error){payload.release();throw error;}
 activeUnverifiedReads++;unverifiedReads=increment(unverifiedReads);let live=true;
 return ()=>{if(live){live=false;activeUnverifiedReads--;uncertainty.release();payload.release();}};
}
function admittedRecord(value:unknown){try{return journalRecordBytes(value);}catch(error){rejectedRecords=increment(rejectedRecords);throw new Error('A saved browser delivery exceeds the supported control allowance or has unsupported data. It remains in IndexedDB and has not been retried or deleted. The previous pending list is retained; use recovery support for this saved delivery.',{cause:error});}}
export class BrowserJournal {
 private constructor(private db:IDBDatabase){}
 static async open(owner:string){
  const request=indexedDB.open('ie-delivery-'+owner,1);request.onupgradeneeded=()=>request.result.createObjectStore('entries');
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});return new BrowserJournal(db);
 }
 async put(key:string,value:unknown){
  if(key.length>256)throw new ControlAdmissionError('size',JOURNAL_RECORD_BYTES);
  // No native structured clone begins until this exact logical record is
  // checked and admitted. The IDB storage engine's backing is still opaque.
  const bytes=journalRecordBytes(value),copy=allocationLedger.reserve({owner:'journal-write-copy',kind:'control',cpuBytes:bytes+key.length*2,handles:1});
  try{
   const tx=this.db.transaction('entries','readwrite');let failed=false,failure:unknown;
   const complete=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>failed?reject(failure):resolve();tx.onabort=()=>reject(failed?failure:tx.error);tx.onerror=()=>{if(!failed){failed=true;failure=tx.error;}};});
   try{tx.objectStore('entries').put(value,key);}catch(error){failed=true;failure=error;try{tx.abort();}catch(abort){failure=new AggregateError([error,abort],'JOURNAL_ABORT_FAILED');}}
   await complete;
  }finally{copy.release();}
 }
 async get<T>(key:string):Promise<T|undefined>{
  const release=readAdmission();let value:T|undefined;
  try{
   const tx=this.db.transaction('entries');let failed=false,failure:unknown;
   const complete=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>failed?reject(failure):resolve();tx.onabort=()=>reject(failed?failure:tx.error??Error('JOURNAL_READ_ABORTED'));tx.onerror=()=>{if(!failed){failed=true;failure=tx.error??Error('JOURNAL_READ_ABORTED');}};});
   try{const request=tx.objectStore('entries').get(key);
   request.onsuccess=()=>{try{if(request.result!==undefined){admittedRecord(request.result);value=request.result as T;}}catch(error){failed=true;failure=error;try{tx.abort();}catch(abort){failure=new AggregateError([error,abort],'JOURNAL_ABORT_FAILED');}}};
   }catch(error){failed=true;failure=error;try{tx.abort();}catch(abort){failure=new AggregateError([error,abort],'JOURNAL_ABORT_FAILED');}}
   await complete;return value;
  }finally{release();}
 }
 async has(key:string):Promise<boolean>{const request=this.db.transaction('entries').objectStore('entries').getKey(key);return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result!==undefined);request.onerror=()=>reject(request.error);});}
 async scan<T>(prefix:string,visit:(value:T)=>void|boolean):Promise<void>{
  const release=readAdmission();
  try{
   const tx=this.db.transaction('entries');let failed=false,failure:unknown;
   const complete=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>failed?reject(failure):resolve();tx.onabort=()=>reject(failed?failure:tx.error??Error('JOURNAL_READ_ABORTED'));tx.onerror=()=>{if(!failed){failed=true;failure=tx.error??Error('JOURNAL_READ_ABORTED');}};});
   try{const request=tx.objectStore('entries').openCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));
   // One native value at a time; reject legacy oversized data before handing
   // it to a retaining visitor. A rejected scan never publishes a partial list.
   request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;try{admittedRecord(cursor.value);if(visit(cursor.value)!==false)cursor.continue();}catch(error){failed=true;failure=error;try{tx.abort();}catch(abort){failure=new AggregateError([error,abort],'JOURNAL_ABORT_FAILED');}}};
   }catch(error){failed=true;failure=error;try{tx.abort();}catch(abort){failure=new AggregateError([error,abort],'JOURNAL_ABORT_FAILED');}}
   await complete;
  }finally{release();}
 }
 close(){this.db.close();}
}

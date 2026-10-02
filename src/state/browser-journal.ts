// Disposable browser delivery cache. Writer receipts remain authoritative.
import {allocationLedger} from '../observability/allocations.js';
import {ControlAdmissionError,JOURNAL_RECORD_BYTES,journalRecordBytes} from './control-memory.js';
import {OwnedIDB} from './idb-ownership.js';

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
export type JournalScanOptions={after?:string|null;direction?:'next'|'prev'};
export class BrowserJournal {
 private constructor(private readonly owned:OwnedIDB){}
 static async open(owner:string){
  return new BrowserJournal(await OwnedIDB.open('ie-delivery-'+owner,'journal',db=>{db.createObjectStore('entries');}));
 }
 async put(key:string,value:unknown){
  if(key.length>256)throw new ControlAdmissionError('size',JOURNAL_RECORD_BYTES);
  // No native structured clone begins until this exact logical record is
  // checked and admitted. The IDB storage engine's backing is still opaque.
  const bytes=journalRecordBytes(value),copy=allocationLedger.reserve({owner:'journal-write-copy',kind:'control',cpuBytes:bytes+key.length*2,handles:1});
  try{
   await this.owned.run('entries','readwrite',tx=>{this.owned.request(tx,()=>tx.objectStore('entries').put(value,key));return ()=>{};});
  }finally{copy.release();}
 }
 async get<T>(key:string):Promise<T|undefined>{
  const release=readAdmission();let value:T|undefined;
  try{
   return await this.owned.run('entries','readonly',tx=>{this.owned.request(tx,()=>tx.objectStore('entries').get(key),result=>{if(result!==undefined){admittedRecord(result);value=result as T;}});return ()=>value;});
  }finally{release();}
 }
 async has(key:string):Promise<boolean>{let value=false;return this.owned.run('entries','readonly',tx=>{this.owned.request(tx,()=>tx.objectStore('entries').getKey(key),result=>{value=result!==undefined;});return ()=>value;});}
 async scan<T>(prefix:string,visit:(value:T,key:string)=>void|boolean,options:JournalScanOptions={}):Promise<void>{
  const after=options.after??null,direction=options.direction??'next';
  if(typeof prefix!=='string'||prefix.length<1||prefix.length>256||!['next','prev'].includes(direction)||after!==null&&(typeof after!=='string'||after.length<=prefix.length||after.length>256||!after.startsWith(prefix)||after>=prefix+'\uffff'))throw new ControlAdmissionError('shape',JOURNAL_RECORD_BYTES);
  const release=readAdmission();
  try{
  const range=after===null?IDBKeyRange.bound(prefix,prefix+'\uffff'):direction==='next'?IDBKeyRange.bound(after,prefix+'\uffff',true,false):IDBKeyRange.bound(prefix,after,false,true);
   await this.owned.run('entries','readonly',tx=>{
    // One native value at a time; reject legacy oversized data before handing
    // it to a retaining visitor. A rejected scan never publishes a partial list.
    this.owned.request(tx,()=>tx.objectStore('entries').openCursor(range,direction),cursor=>{if(cursor){if(typeof cursor.key!=='string'||cursor.key.length>256||!cursor.key.startsWith(prefix))throw new ControlAdmissionError('shape',JOURNAL_RECORD_BYTES);admittedRecord(cursor.value);if(visit(cursor.value,cursor.key)!==false)cursor.continue();}},true);return ()=>{};
   });
  }finally{release();}
 }
 close(){this.owned.close();}
}

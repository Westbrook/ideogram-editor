import {allocationLedger,type AllocationLease} from '../observability/allocations.js';

type TransactionOwner={lease:AllocationLease;requests:Map<IDBRequest,AllocationLease>;complete:Promise<void>;failed:boolean;failure:unknown;terminal:boolean};
type Scope='journal'|'recovery';
let connections=0,transactions=0,requests=0,unconfirmedClose=0;
/** Logical application handles only. IDB structured clone backing, engine
 * storage and physical native cleanup remain unmeasured. No completeness bit
 * or caller-owned RecoveryWorkspace payload reservation is changed here. */
export function idbOwnershipCoverage(){return Object.freeze({connections,transactions,requests,unconfirmedClose,nativeCloneBytesKnown:false as const,nativeCleanupObserved:false as const});}

export class OwnedIDB {
 private db:IDBDatabase|null=null;private closing=false;private closeRequested=false;private closeFailed=false;private released=false;
 private readonly active=new Map<IDBTransaction,TransactionOwner>();
 private constructor(private readonly scope:Scope,private readonly connection:AllocationLease){connections++;}
 private reserve(kind:'open'|'upgrade'|'transaction'|'request'){return allocationLedger.reserve({owner:this.scope+'-idb-'+kind,kind:'control',handles:1});}
 static async open(name:string,scope:Scope,upgrade:(db:IDBDatabase)=>void){
  const connection=allocationLedger.reserve({owner:scope+'-idb-connection',kind:'control',handles:1});
  const owner=new OwnedIDB(scope,connection);let opening:AllocationLease|undefined,upgradeSlot:AllocationLease|undefined;
  try{opening=owner.reserve('open');upgradeSlot=owner.reserve('upgrade');}
  catch(error){opening?.release();upgradeSlot?.release();owner.releaseConnection();throw error;}
  // A versionchange transaction is native-created before upgradeneeded, so
  // reserve its possible handle before invoking indexedDB.open itself.
  let request:IDBOpenDBRequest;
  try{request=indexedDB.open(name,1);}
  catch(error){opening.release();upgradeSlot.release();owner.releaseConnection();throw error;}
  requests++;let upgradeFailure:unknown,upgradeFailed=false;
  return new Promise<OwnedIDB>((resolve,reject)=>{
   const settleRequest=()=>{opening!.release();requests--;upgradeSlot?.release();upgradeSlot=undefined;request.onupgradeneeded=null;request.onsuccess=null;request.onerror=null;};
   const rejectOpen=(error:unknown)=>{
    settleRequest();
    try{if(owner.db)owner.close();else owner.releaseConnection();}
    catch(closeError){reject(new AggregateError([error,closeError],'IDB_OPEN_CLOSE_UNCONFIRMED'));return;}
    reject(error);
   };
   request.onupgradeneeded=()=>{
    owner.attach(request.result);
    const tx=request.transaction;
    if(!tx){upgradeFailed=true;upgradeFailure=Error('IDB_UPGRADE_TRANSACTION_UNAVAILABLE');return;}
    owner.track(tx,upgradeSlot!);upgradeSlot=undefined;
    try{upgrade(request.result);}catch(error){upgradeFailed=true;upgradeFailure=error;owner.abort(tx,error);}
   };
   request.onsuccess=()=>{
    owner.attach(request.result);
    if(upgradeFailed){rejectOpen(upgradeFailure);return;}
    settleRequest();resolve(owner);
   };
   request.onerror=()=>rejectOpen(upgradeFailed?upgradeFailure:request.error??Error('IDB_OPEN_FAILED'));
  });
 }
 private attach(db:IDBDatabase){
  if(this.db){if(this.db!==db)throw Error('IDB_CONNECTION_CHANGED');return;}
  this.db=db;
  db.addEventListener('close',this.forcedClose);
 }
 private forcedClose=()=>{this.closing=true;this.closeRequested=true;this.finishClose();};
 private releaseConnection(){
  if(this.released)return;this.released=true;
  this.db?.removeEventListener('close',this.forcedClose);this.db=null;
  if(this.closeFailed){this.closeFailed=false;unconfirmedClose--;}
  this.connection.release();connections--;
 }
 private finishClose(){if(this.closeRequested&&this.active.size===0)this.releaseConnection();}
 close(){
  if(this.released)return;
  // Fence wrapper admissions even if native close throws. A retry targets the
  // same retained connection; it cannot replace or silently refund it.
  this.closing=true;
  if(!this.closeRequested){
   try{this.db!.close();this.closeRequested=true;}
   catch(error){if(!this.closeFailed){this.closeFailed=true;unconfirmedClose++;}this.connection.markUnused();throw error;}
  }
  // IndexedDB3 §5.2: normal close sets close-pending, forbids new transactions
  // and closes after existing transactions finish. It emits no normal close
  // event. End logical ownership after this observed drain, drop our reference,
  // and make no native allocator/RSS reclamation claim.
  this.finishClose();
 }
 private track(tx:IDBTransaction,lease:AllocationLease){
  let resolve!:()=>void,reject!:(error:unknown)=>void;
  const complete=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void complete.catch(()=>{});
  const value:TransactionOwner={lease,requests:new Map(),complete,failed:false,failure:undefined,terminal:false};
  this.active.set(tx,value);transactions++;
  const finish=(aborted:boolean)=>{
   if(value.terminal)return;value.terminal=true;
   tx.removeEventListener('complete',committed);tx.removeEventListener('abort',abortedEvent);tx.removeEventListener('error',errored);
   for(const [request,held]of value.requests){request.onsuccess=null;request.onerror=null;held.release();requests--;}
   value.requests.clear();lease.release();transactions--;this.active.delete(tx);this.finishClose();
   if(aborted||value.failed)reject(value.failed?value.failure:tx.error??Error('IDB_TRANSACTION_ABORTED'));else resolve();
  };
  const committed=()=>finish(false),abortedEvent=()=>finish(true),errored=()=>{if(!value.failed){value.failed=true;value.failure=tx.error??Error('IDB_TRANSACTION_ERROR');}};
  tx.addEventListener('complete',committed);tx.addEventListener('abort',abortedEvent);tx.addEventListener('error',errored);
  return value;
 }
 private transaction(stores:string|string[],mode:IDBTransactionMode){
  if(this.closing||!this.db||this.released)throw Error('IDB_CONNECTION_CLOSING');
  const lease=this.reserve('transaction');let tx:IDBTransaction;
  try{tx=this.db.transaction(stores,mode);}catch(error){lease.release();throw error;}
  this.track(tx,lease);return tx;
 }
 private abort(tx:IDBTransaction,error:unknown){
  const owner=this.active.get(tx);if(!owner||owner.terminal)return;
  owner.failed=true;owner.failure=error;
  try{tx.abort();}catch(abort){owner.failure=new AggregateError([error,abort],'IDB_ABORT_UNCONFIRMED');}
  // An error or a failed abort call is not a terminal transaction event. No
  // promise/refund timeout is used; its owner remains until complete or abort.
 }
 request<T>(tx:IDBTransaction,create:()=>IDBRequest<T>,success?:(value:T)=>void,cursor=false):IDBRequest<T>{
  const owner=this.active.get(tx);if(!owner||owner.terminal)throw Error('IDB_TRANSACTION_UNOWNED');
  if(owner.failed)throw owner.failure;
  const lease=this.reserve('request');let request:IDBRequest<T>;
  try{request=create();}catch(error){lease.release();throw error;}
  owner.requests.set(request,lease);requests++;
  request.onsuccess=()=>{
   if(owner.terminal||owner.failed)return;
   try{success?.(request.result);}catch(error){this.abort(tx,error);return;}
   // A completed single request releases only its logical operation handle.
   // The transaction remains independently admitted. Cursor continue() reuses
   // the request, so retain that token through transaction completion.
   if(!cursor&&owner.requests.delete(request)){lease.release();requests--;request.onsuccess=null;request.onerror=null;}
  };
  request.onerror=()=>{if(!owner.failed){owner.failed=true;owner.failure=request.error??Error('IDB_REQUEST_FAILED');}};
  return request;
 }
 async run<T>(stores:string|string[],mode:IDBTransactionMode,start:(tx:IDBTransaction)=>()=>T):Promise<T>{
  const tx=this.transaction(stores,mode),owner=this.active.get(tx)!;let read:(()=>T)|undefined;
  try{read=start(tx);}catch(error){this.abort(tx,error);}
  await owner.complete;return read!();
 }
}

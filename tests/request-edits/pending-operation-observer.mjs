// Opt-in fixture diagnostics only. Original calls, promises and errors retain authority.
import {AsyncLocalStorage} from 'node:async_hooks';

export const OPERATION_LIMITS=Object.freeze({cohorts:4,activeCalls:32,transitionRows:128,methods:12,backingBytes:10880,serializedBytes:32768});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const countLimit=2147483647;
const methods=Object.freeze([
 ['histories','prepare','history.prepare',true],
 ['histories','prepareCandidatePreview','history.prepareCandidatePreview',true],
 ['candidates','reviewAdoptionOwned','candidates.reviewAdoptionOwned',true],
 ['candidates','prepareReviewedAdoption','candidates.prepareReviewedAdoption',true],
 ['candidates','prepareReviewedEncodedAdoption','candidates.prepareReviewedEncodedAdoption',true],
 ['rasters','retainCandidate','rasters.retainCandidate',true],
 ['rasters','prepareDocument','rasters.prepareDocument',true],
 ['rasters','prepareEncodedComposition','rasters.prepareEncodedComposition',true],
 ['objects','prove','objects.prove',true],
 ['objects','adoptFile','objects.adoptFile',true],
 ['objects','putMetadataInSlot','objects.putMetadataInSlot',false],
 ['histories','approvedPlacement','history.approvedPlacement',false],
]);
const missing=reason=>({kind:'e3-operation-observation-unavailable-1',available:false,reason});
const resourceMissing=reason=>({kind:'e3-resource-observation-1',available:false,reason});
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function fault(s,c,active=true,aggregate=true){
 s.faults=Math.min(countLimit,s.faults+1);
 if(!s.meta)return;
 for(let i=0;i<4;i++)if(c===undefined||c===i){const at=i*8;s.meta[at+1]=Math.min(countLimit,s.meta[at+1]+1);if(active)s.meta[at+3]=0;if(aggregate)s.meta[at+4]=0;}
}
function clock(s,c){try{const n=s.now();if(Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER)return n;}catch{}fault(s,c,false,true);return -1;}
function current(s,c){return !s.closed&&s.enabled&&Number.isInteger(c)&&c>=0&&c<4&&s.meta[c*8]===1&&s.meta[c*8+6]===1;}
function increment(s,c,index){const at=(c*12+index)*5;if(s.stats[at]>=countLimit){fault(s,c,false,true);return;}s.stats[at]++;}
function trace(s,c,index,event,call,parent,time){
 if(index===11)return; // Frequent synchronous guards retain aggregates only.
 if(s.sequence>=countLimit){fault(s,c);s.meta[c*8+5]=0;return;}
 const slot=s.sequence%128,at=slot*7;
 if(s.sequence>=128){const prior=s.rows[at+1]-1;if(prior>=0){s.meta[prior*8+2]++;s.meta[prior*8+5]=0;}}
 s.rows.set([++s.sequence,c+1,index+1,event,call,parent,time],at);
}
function activeSlot(s,c,index,call,parent,start){
 for(let i=0;i<32;i++){const at=i*6;if(!s.active[at]){s.active.set([c+1,call,index+1,parent,start,1],at);return i;}}
 fault(s,c,true,false);return -1;
}
function settle(s,c,index,call,parent,slot,start,outcome){
 if(!current(s,c))return;
 const end=clock(s,c),at=(c*12+index)*5;
 if(s.stats[at+outcome]>=countLimit)fault(s,c,false,true);else s.stats[at+outcome]++;
 if(start>=0&&end>=start){const elapsed=end-start,total=s.stats[at+3]+elapsed;if(Number.isSafeInteger(Math.ceil(total))){s.stats[at+3]=total;s.stats[at+4]=Math.max(s.stats[at+4],elapsed);}else fault(s,c,false,true);}
 else fault(s,c,false,true);
 if(slot>=0){const a=slot*6;if(s.active[a]===c+1&&s.active[a+1]===call)s.active.fill(0,a,a+6);else fault(s,c);}
 trace(s,c,index,outcome===1?2:3,call,parent,end);
 if(index===0){
  s.meta[c*8]=0;
  for(let i=0;i<32;i++)if(s.active[i*6]===c+1){fault(s,c);break;}
 }
}
// These callbacks retain only erasable state and scalar ordinals, never args/results/check functions.
function watch(s,c,index,call,parent,slot,start,result){
 try{Promise.prototype.then.call(result,()=>{try{settle(s,c,index,call,parent,slot,start,1);}catch{fault(s,c);}},()=>{try{settle(s,c,index,call,parent,slot,start,2);}catch{fault(s,c);}});}
 catch{fault(s,c);}
}
function observedCall(s,c,index,original,receiver,args){
 if(!current(s,c))return Reflect.apply(original,receiver,args);
 if(s.calls>=countLimit){fault(s,c);return Reflect.apply(original,receiver,args);}
 const call=++s.calls,parent=s.als.getStore()?.parent??0,start=clock(s,c);
 increment(s,c,index);const slot=activeSlot(s,c,index,call,parent,start);trace(s,c,index,1,call,parent,start);
 // No additional context or settlement closure when the fixed pending-call table is full.
 if(slot<0){fault(s,c,false,true);return Reflect.apply(original,receiver,args);}
 let result;
 try{result=s.als.run({cohort:c,parent:call},()=>Reflect.apply(original,receiver,args));}
 catch(error){try{settle(s,c,index,call,parent,slot,start,2);}catch{fault(s,c);}throw error;}
 if(methods[index][3])watch(s,c,index,call,parent,slot,start,result);
 else try{settle(s,c,index,call,parent,slot,start,1);}catch{fault(s,c);}
 return result;
}
function untracked(s,original,receiver,args){
 return s.als?.getStore()?s.als.run(undefined,()=>Reflect.apply(original,receiver,args)):Reflect.apply(original,receiver,args);
}
function rootCall(s,original,receiver,args){
 if(s.closed||!s.enabled)return Reflect.apply(original,receiver,args);
 if(receiver!==s.restores[0]?.owner){fault(s);return untracked(s,original,receiver,args);}
 const id=args[0],slot=args[1];let selected=false;
 try{
  if(typeof id==='string'&&uuid.test(id)&&slot==='history:'+id){
   const row=s.store.db.prepare("SELECT json_extract(canonical,'$.command.commandId') AS commandId,json_extract(canonical,'$.command.body.type') AS operation FROM history_preparations WHERE id=?").get(id);
   selected=row?.commandId===id&&row.operation==='AdoptReviewedCandidate';
  }
 }catch{fault(s);}
 if(!selected)return untracked(s,original,receiver,args);
 const duplicate=s.ids.indexOf(id);if(duplicate>=0){fault(s,duplicate);s.meta[duplicate*8+6]=0;return untracked(s,original,receiver,args);}
 const c=s.ids.indexOf(null);if(c<0){s.cohortOverflow=true;fault(s);return untracked(s,original,receiver,args);}
 const complete=s.ownershipLost?0:1;
 s.ids[c]=id;s.meta.set([1,1-complete,0,complete,complete,1,1,0],c*8);
 return s.als.run({cohort:c,parent:0},()=>observedCall(s,c,0,original,receiver,args));
}
function wrapper(s,index,original){
 return function(...args){
  if(index===0)return rootCall(s,original,this,args);
  const c=s.closed?undefined:s.als?.getStore()?.cohort;
  if(current(s,c)&&this!==s.restores[index]?.owner){fault(s,c);return untracked(s,original,this,args);}
  return current(s,c)?observedCall(s,c,index,original,this,args):Reflect.apply(original,this,args);
 };
}
function audit(s){
 for(const item of s.restores){
  const descriptor=Object.getOwnPropertyDescriptor(item.owner,item.key);
  if(s.store?.[item.group]!==item.owner||descriptor?.value!==item.wrapped){s.ownershipLost=true;if(!item.faulted){item.faulted=true;fault(s);}}
 }
}
function summary(s){
 let pending=0;if(s.active)for(let i=0;i<32;i++)if(s.active[i*6])pending++;
 let incomplete=s.faults>0||s.cohortOverflow||pending>0;
 if(s.meta)for(let i=0;i<4;i++)if(s.ids[i]!==null&&(s.meta[i*8]||!s.meta[i*8+3]||!s.meta[i*8+4]||!s.meta[i*8+5]))incomplete=true;
 return {disposed:true,incomplete,faults:s.faults,pendingCalls:pending,qualification:false};
}
function restore(s){
 for(let i=s.restores.length-1;i>=0;i--){const item=s.restores[i];try{
  const descriptor=Object.getOwnPropertyDescriptor(item.owner,item.key);
  if(descriptor?.value!==item.wrapped){s.ownershipLost=true;if(!item.faulted){item.faulted=true;fault(s);}continue;}
  if(item.before)Object.defineProperty(item.owner,item.key,item.before);else delete item.owner[item.key];
 }catch{fault(s);}}
 s.restores.length=0;
}
function dispose(s){
 if(s.closed)return s.disposed;
 try{audit(s);}catch{fault(s);}s.closed=true;
 try{s.als?.disable();}catch{fault(s);}
 restore(s);s.disposed=Object.freeze(summary(s));
 s.store=null;s.now=null;s.als=null;s.ids=null;
 s.rows=null;s.active=null;s.stats=null;s.meta=null;
 return s.disposed;
}
function snapshot(s,id){
 if(s.closed)return missing('disposed');if(!s.enabled)return missing(s.installFailed?'install-refused':'disabled');
 try{
  audit(s);const c=s.ids.indexOf(id);if(c<0)return missing(s.cohortOverflow?'cohort-bound':'no-selected-cohort');if(!s.meta[c*8+6])return missing('ambiguous-cohort');
  const aggregate=methods.map((row,index)=>{const at=(c*12+index)*5;return {method:row[2],calls:s.stats[at],fulfilled:s.stats[at+1],rejected:s.stats[at+2],totalMs:s.stats[at+3],maxMs:s.stats[at+4]};});
  const active=[];for(let i=0;i<32;i++){const at=i*6;if(s.active[at]===c+1)active.push({method:methods[s.active[at+2]-1][2],call:s.active[at+1],parent:s.active[at+3],enteredMs:s.active[at+4]});}
  const transitions=[];for(let i=0;i<128;i++){const at=i*7;if(s.rows[at+1]===c+1)transitions.push({sequence:s.rows[at],cohort:c+1,method:methods[s.rows[at+2]-1][2],event:['entry','fulfilled','rejected'][s.rows[at+3]-1],call:s.rows[at+4],parent:s.rows[at+5],atMs:s.rows[at+6]});}transitions.sort((a,b)=>a.sequence-b.sequence);
  const m=c*8,result={kind:'e3-operation-observation-1',available:true,cohort:c+1,rootPending:!!s.meta[m],aggregate,active,transitions,traceComplete:!!s.meta[m+5],activeComplete:!!s.meta[m+3],aggregateComplete:!!s.meta[m+4],incomplete:!!s.meta[m+1]||!s.meta[m+3]||!s.meta[m+4]||!s.meta[m+5],dropped:s.meta[m+2],faults:s.meta[m+1],backingBytes:OPERATION_LIMITS.backingBytes,qualification:false};
  return Buffer.byteLength(JSON.stringify(result))<=OPERATION_LIMITS.serializedBytes?result:missing('snapshot-bound');
 }catch{fault(s);return missing('snapshot-refused');}
}
function select(source,keys,booleans=[]){
 const result={};for(const key of keys){if(!integer(source?.[key]))throw Error('SCALAR');result[key]=source[key];}
 for(const key of booleans){if(typeof source?.[key]!=='boolean')throw Error('SCALAR');result[key]=source[key];}return result;
}
function resources(s){
 if(s.closed||!s.enabled)return resourceMissing(s.closed?'disposed':'disabled');
 try{
  const raw=s.store.objects.resourceOwnership(),p=s.store.objects.proofInventory(),r=s.store.rasters.resourceOwnership();
  const objects=select(raw,['stages','slots','proofReservations','retainedProofs','proofReaders','proofWaiters','repairReads','repairs'],['proofWaitTimer']);
  const proofs=select(p,['pending','retained','activeReaders','metadataBytes']);
  if(proofs.pending!==objects.proofReservations-objects.retainedProofs||proofs.retained!==objects.retainedProofs||proofs.activeReaders!==objects.proofReaders||proofs.metadataBytes!==objects.proofReservations*2048||objects.proofReaders>2||objects.proofReservations>2048||objects.proofWaiters>proofs.pending)throw Error('JOIN');
  const raster=select(r,['activeWorkers','bookedCPUBytes'],['running','documentBusy']);if(raster.activeWorkers!==r.workerService?.activeJobs)throw Error('JOIN');
  const composition=select(r.compositionMemory,['loans','loanBytes','borrowers','borrowedBytes','contentReaders']);
  return {kind:'e3-resource-observation-1',available:true,objects,proofs,raster,composition};
 }catch{return resourceMissing('inventory-unavailable');}
}
export function installPendingOperationObserver(store,{enabled=false,now=()=>performance.now()}={}){
 const s={store:null,now:null,als:null,enabled:false,closed:false,installFailed:false,ids:null,rows:null,active:null,stats:null,meta:null,restores:[],calls:0,sequence:0,faults:0,ownershipLost:false,cohortOverflow:false,disposed:null};
 const api=Object.freeze({snapshot:id=>snapshot(s,id),resources:()=>resources(s),dispose:()=>dispose(s)});
 if(!enabled)return api;
 try{
  if(typeof now!=='function')throw Error('CLOCK');s.store=store;s.now=now;s.als=new AsyncLocalStorage();s.ids=Array(4).fill(null);
  s.rows=new Float64Array(128*7);s.active=new Float64Array(32*6);s.stats=new Float64Array(4*12*5);s.meta=new Float64Array(4*8);
  if(s.rows.byteLength+s.active.byteLength+s.stats.byteLength+s.meta.byteLength!==OPERATION_LIMITS.backingBytes)throw Error('BACKING');
  for(const [index,[group,key]] of methods.entries()){
   const owner=store[group],original=owner?.[key];if(typeof original!=='function')throw Error('METHOD');const before=Object.getOwnPropertyDescriptor(owner,key);
   if(before&&(!('value'in before)||!before.configurable&&!before.writable))throw Error('DESCRIPTOR');
   const wrapped=wrapper(s,index,original);Object.defineProperty(owner,key,before?{...before,value:wrapped}:{value:wrapped,writable:true,configurable:true,enumerable:false});
   s.restores.push({group,key,owner,before,wrapped,faulted:false});
  }
  s.enabled=true;
 }catch{
  fault(s);s.installFailed=true;restore(s);try{s.als?.disable();}catch{}s.store=null;s.now=null;s.als=null;s.ids=null;s.rows=null;s.active=null;s.stats=null;s.meta=null;
 }
 return api;
}

// Private native99 fixture diagnostics. No product entry point imports this file.
// RSS is process-wide; heap/external fields belong to the reporting isolate.
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {threadId} from 'node:worker_threads';
import {isPromise} from 'node:util/types';

export const candidateMemoryFiles=Object.freeze({marker:'native99-passive-memory.json',sidecar:'native99-passive-memory-evidence.json',fixture:'request-edits-fixture.json'});
const MARKER='{"version":1,"case":"native99"}\n';
const ROWS=16,STRIDE=64,MAX_BYTES=32768,FIXTURE_BYTES=65536;
const phases=Object.freeze({open:1,entry:2,admission:3,preflight:4,fulfilled:5,rejected:6,threw:7,workerStart:8,workerBeforeEncode:9,workerAfterEncode:10,close:11});
const fields=Object.freeze(['sequence','phase','candidateOrdinal','outcome','callbackClockOriginUnixMs','callbackAtMs','pid','threadId','rss','heapTotal','heapUsed','external','arrayBuffers','rasterActiveJobs','rasterGeneration','rasterThreadId','rasterWorkerCount','rasterIdleWorkers','rasterRetainedJobReferences','rasterCompletedJobs','rasterBookedCPUBytes','rasterDocumentBusy','compositionLoans','compositionLoanBytes','compositionBorrowers','compositionBorrowedBytes','compositionContentReaders','textVerifying','textBookedCPUBytes','textReadyLoans','textBrowserAdmissions','proofPending','proofRetained','proofReaders','proofMetadataBytes','objectStages','objectSlots','objectRepairReads','objectRepairs','objectReservedBytes','objectActiveTransfers','originalAdmissionRSS','originalExternalCPU','replacedPreflightCPU','planCPUBytes','originalCombinedBytes','originalAdmitted','admissionWorkerGeneration','admissionWorkerThreadId','originalAddAccepted']);
const memoryKeys=['rss','heapTotal','heapUsed','external','arrayBuffers'];
const own=(value,key)=>{if(!value||typeof value!=='object')return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
const number=value=>Number.isSafeInteger(value)&&value>=0?value:-1;
const flag=value=>value===true?1:value===false?0:-1;
const counter=value=>Math.min(1000000,value+1);
const scalarString=value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,15})$/.test(value)?number(Number(value)):-1;
function fault(s){s.faults=counter(s.faults);}
function value(s,v){const n=number(v);if(n<0)fault(s);return n;}
function bool(s,v){const n=flag(v);if(n<0)fault(s);return n;}
function row(s,phase,ordinal,outcome){
 if(!s.buffer||s.count>=ROWS){s.dropped=counter(s.dropped);return null;}
 const at=s.count++*STRIDE;s.buffer.fill(-1,at,at+STRIDE);
 const base=[s.count,phase,ordinal,outcome,performance.timeOrigin,-1,process.pid,threadId];
 for(let i=0;i<base.length;i++)s.buffer[at+i]=base[i];
 try{const time=s.now();if(Number.isFinite(time)&&time>=0&&time<=Number.MAX_SAFE_INTEGER)s.buffer[at+5]=time;else fault(s);}catch{fault(s);}return at;
}
function sample(s,phase,ordinal=0,outcome=0){
 let at;try{
  at=row(s,phase,ordinal,outcome);if(at===null)return;
  const m=s.memory();for(let i=0;i<memoryKeys.length;i++)s.buffer[at+8+i]=value(s,own(m,memoryKeys[i]));
  const store=s.store,r=store.rasters.resourceOwnership(),w=own(r,'workerService'),identity=own(w,'identity'),c=own(r,'compositionMemory'),t=store.texts.resourceOwnership(),p=store.objects.proofInventory(),o=store.objects.resourceOwnership(),io=store.objects.reservationInventory();
  const nums=[own(w,'activeJobs'),own(w,'generation'),identity===null?-1:own(identity,'threadId'),own(w,'workerCount'),own(w,'idleWorkers'),own(w,'retainedJobReferences'),own(w,'completedJobs'),own(r,'bookedCPUBytes'),flag(own(r,'documentBusy')),own(c,'loans'),own(c,'loanBytes'),own(c,'borrowers'),own(c,'borrowedBytes'),own(c,'contentReaders'),flag(own(t,'verifying')),own(t,'bookedCPUBytes'),own(t,'readyLoans'),own(t,'browserAdmissions'),own(p,'pending'),own(p,'retained'),own(p,'activeReaders'),own(p,'metadataBytes'),own(o,'stages'),own(o,'slots'),own(o,'repairReads'),own(o,'repairs'),scalarString(own(io,'reservedBytes')),own(io,'activeTransfers')];
  for(let i=0;i<nums.length;i++)s.buffer[at+13+i]=i===2&&identity===null?-1:value(s,nums[i]);
 }catch{fault(s);}return at;
}
function workerMetrics(s,ordinal,metrics){
 for(const [prefix,phase]of [['workerStart',phases.workerStart],['workerBeforeEncode',phases.workerBeforeEncode],['workerAfterEncode',phases.workerAfterEncode]]){
  let at;try{at=row(s,phase,ordinal,1);if(at===null)return;
   const generation=value(s,own(metrics,'workerGeneration')),worker=value(s,own(metrics,'workerThreadId'));s.buffer[at+7]=worker;s.buffer[at+14]=generation;s.buffer[at+15]=worker;
   for(let i=0;i<memoryKeys.length;i++){const name=prefix+['RSS','HeapTotal','HeapUsed','External','ArrayBuffers'][i];s.buffer[at+8+i]=value(s,own(metrics,name));}
  }catch{fault(s);}
 }
}
// Bound handlers capture only this erasable state and a numeric ordinal. They
// never capture a wrapper, native delegate, receiver, args, slot or result.
function fulfilled(s,ordinal,result){finish(s,ordinal,1,result);}
function rejected(s,ordinal){finish(s,ordinal,2);}
function finish(s,ordinal,outcome,result){
 if(!s.open||s.pending?.ordinal!==ordinal)return;
 try{
  if(s.collect){sample(s,outcome===1?phases.fulfilled:phases.rejected,ordinal,outcome);if(outcome===1)workerMetrics(s,ordinal,own(result,'metrics'));}
  if(!s.pending.admissions)fault(s);s.completed=counter(s.completed);
 }catch{fault(s);}finally{if(s.pending?.ordinal===ordinal){s.pending.slot=null;s.pending=null;}}
}
function begin(s,receiver,args){
 if(!s.open)return 0;
 try{
  if(own(args[0],'type')!=='PrepareCandidate')return 0;
  s.attempts=counter(s.attempts);
  const slot=args[2],output=args[1],input=own(args[0],'assetId');
  if(!s.collect||receiver!==s.rasters||s.pending||s.candidates>=2||typeof slot!=='string'||!/^candidate-prepare:[A-Za-z0-9_-]{1,128}$/.test(slot)||typeof output!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(output)||typeof input!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input)||s.slots.includes(slot)){
   s.collect=false;s.untracked=true;s.dropped=counter(s.dropped);return 0;
  }
  const ordinal=++s.candidates;s.slots.push(slot);s.pending={ordinal,slot,admissions:0};sample(s,phases.entry,ordinal);return ordinal;
 }catch{fault(s);s.collect=false;s.untracked=true;return 0;}
}
function prepareWrapper(delegate,s){
 return function(...args){
  const ordinal=begin(s,this,args);let work;
  try{work=Reflect.apply(delegate,this,args);}catch(error){
   if(ordinal&&s.open&&s.pending?.ordinal===ordinal){try{sample(s,phases.threw,ordinal,2);}catch{fault(s);}if(!s.pending.admissions)fault(s);s.pending.slot=null;s.pending=null;s.completed=counter(s.completed);}
   throw error;
  }
  if(ordinal&&s.open)try{
   if(isPromise(work))Promise.prototype.then.call(work,fulfilled.bind(null,s,ordinal),rejected.bind(null,s,ordinal));
   else{fault(s);s.pending.slot=null;s.pending=null;}
  }catch{fault(s);}
  return work;
 };
}
function afterAdd(s,receiver,args,accepted){
 if(!s.open||!s.collect||!s.pending)return;
 try{
  const record=args[0],phase=own(record,'phase');if(phase!=='resource-admission'&&phase!=='resource-preflight')return;
  if(receiver!==s.observations){fault(s);return;}
  if(own(record,'slot')!==s.pending.slot)return;
  if(s.pending.admissions){fault(s);s.collect=false;return;}s.pending.admissions++;
  const at=sample(s,phase==='resource-admission'?phases.admission:phases.preflight,s.pending.ordinal);if(at===null||at===undefined)return;
  const plan=own(record,'plan'),worker=own(record,'worker');
  const numbers=[own(record,'processRSS'),own(record,'externalCPU'),phase==='resource-admission'?own(record,'replacedCPU'):-1,phase==='resource-admission'?own(plan,'cpuBytes'):own(record,'preflightCPU'),own(record,'combinedReservedBytes'),flag(own(record,'admitted')),phase==='resource-admission'?own(worker,'generation'):-1,phase==='resource-admission'?own(worker,'threadId'):-1,flag(accepted)];
  for(let i=0;i<numbers.length;i++)s.buffer[at+41+i]=phase==='resource-preflight'&&[2,6,7].includes(i)?-1:value(s,numbers[i]);
  if(accepted!==true)fault(s);
 }catch{fault(s);}
}
function addWrapper(delegate,s){
 return function(...args){let result;try{result=Reflect.apply(delegate,this,args);}catch(error){if(s.open&&s.pending)fault(s);throw error;}afterAdd(s,this,args,result);return result;};
}
const unavailable=reason=>({kind:'native99-passive-memory-unavailable-1',reason,qualification:false,nativeAllocationOwner:'unobserved'});
function bounded(packet){const bytes=JSON.stringify(packet);return Buffer.byteLength(bytes)<=MAX_BYTES?bytes:JSON.stringify(unavailable('output-bound'));}
function disposer(s,restores,emit){
 return function dispose(){
  if(!s.open)return null;s.open=false;
  const pendingAtClose=s.pending?1:0;let packet;
  try{
   sample(s,phases.close);const records=[];for(let n=0;n<s.count;n++)records.push(Array.from(s.buffer.subarray(n*STRIDE,n*STRIDE+fields.length)));
   packet={kind:'native99-passive-memory-1',fields:[...fields],phases:{...phases},records,candidates:s.candidates,completed:s.completed,attempts:s.attempts,pendingAtClose,untrackedCohorts:s.untracked,dropped:s.dropped,faults:s.faults,incomplete:pendingAtClose>0||s.untracked||s.dropped>0||s.faults>0||s.candidates!==2||s.completed!==2,disposedBeforeDrain:true,rssScope:'whole-process',heapScope:'record-threadId',workerMetricClock:'callback-delivery-only',nativeAllocationOwner:'unobserved',qualification:false};
  }catch{packet=unavailable('capture-failed');}
  finally{
   for(let i=restores.length-1;i>=0;i--){const r=restores[i];try{if(r.owner[r.key]===r.wrapper)r.owner[r.key]=r.original;else if(packet?.kind==='native99-passive-memory-1'){packet.faults=counter(packet.faults);packet.incomplete=true;}}catch{if(packet?.kind==='native99-passive-memory-1'){packet.faults=counter(packet.faults);packet.incomplete=true;}}r.owner=null;r.original=null;r.wrapper=null;}restores.length=0;
   if(s.pending)s.pending.slot=null;s.pending=null;s.slots.fill(null);s.slots.length=0;s.buffer?.fill(0);s.buffer=null;s.store=null;s.rasters=null;s.observations=null;s.memory=null;s.now=null;s.collect=false;
  }
  try{emit?.(bounded(packet));}catch{/* Diagnostic IO cannot replace close. */}finally{emit=null;}
  return packet;
 };
}
export function observeCandidateMemory(store,{memory=()=>process.memoryUsage(),now=()=>performance.now(),emit}={}){
 const s={open:true,collect:true,store,rasters:null,observations:null,memory,now,buffer:new Float64Array(ROWS*STRIDE),count:0,candidates:0,completed:0,attempts:0,dropped:0,faults:0,pending:null,slots:[],untracked:false};const restores=[];
 const dispose=disposer(s,restores,emit);
 try{
  s.rasters=store.rasters;s.observations=s.rasters.observations;
  for(const [owner,key,make]of [[s.rasters,'prepareDocument',prepareWrapper],[s.observations,'add',addWrapper]]){
   const original=owner[key];if(typeof original!=='function')throw Error('OBSERVATION_SHAPE');const wrapper=make(original,s);restores.push({owner,key,original,wrapper});owner[key]=wrapper;
  }
  sample(s,phases.open);
 }catch{fault(s);dispose();}
 return dispose;
}
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;}
function readBounded(path,limit){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>BigInt(limit))throw Error('BOUND');
  const bytes=Buffer.alloc(limit+1);let total=0,n;while(total<bytes.length&&(n=readSync(fd,bytes,total,bytes.length-total,null))>0)total+=n;
  const after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});if(total>limit||BigInt(total)!==before.size||!same(before,after)||!same(after,named)||!named.isFile())throw Error('CHANGED');
  return bytes.subarray(0,total).toString('utf8');
 }finally{closeSync(fd);}
}
export function markCandidateMemory(root){try{writeFileSync(join(root,candidateMemoryFiles.marker),MARKER,{flag:'wx',mode:0o600});return true;}catch{return false;}}
export function installCandidateMemory(store,encoded){
 if(encoded)return null;
 try{if(readBounded(join(store.root,candidateMemoryFiles.marker),64)!==MARKER)return null;}catch{return null;}
 try{
  const path=join(store.root,candidateMemoryFiles.sidecar);
  return observeCandidateMemory(store,{emit:bytes=>{writeFileSync(path+'.tmp',bytes,{flag:'wx',mode:0o600});renameSync(path+'.tmp',path);}});
 }catch{return null;}
}
function validatePacket(v){
 const keys=['kind','fields','phases','records','candidates','completed','attempts','pendingAtClose','untrackedCohorts','dropped','faults','incomplete','disposedBeforeDrain','rssScope','heapScope','workerMetricClock','nativeAllocationOwner','qualification'];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(',')||v.kind!=='native99-passive-memory-1'||JSON.stringify(v.fields)!==JSON.stringify(fields)||JSON.stringify(v.phases)!==JSON.stringify(phases)||!Array.isArray(v.records)||v.records.length>ROWS)throw Error('PACKET');
 for(const key of ['candidates','completed','attempts','pendingAtClose','dropped','faults'])if(number(v[key])<0||v[key]>1000000)throw Error('COUNT');
 if(v.candidates>2||v.completed>v.candidates||v.pendingAtClose>1||['untrackedCohorts','incomplete'].some(k=>typeof v[k]!=='boolean')||v.disposedBeforeDrain!==true||v.rssScope!=='whole-process'||v.heapScope!=='record-threadId'||v.workerMetricClock!=='callback-delivery-only'||v.nativeAllocationOwner!=='unobserved'||v.qualification!==false)throw Error('CLAIM');
 const mustIncomplete=v.pendingAtClose>0||v.untrackedCohorts||v.dropped>0||v.faults>0||v.candidates!==2||v.completed!==2;if(v.incomplete!==mustIncomplete)throw Error('INCOMPLETE');
 for(const [i,row]of v.records.entries())if(!Array.isArray(row)||row.length!==fields.length||row.some((n,j)=>typeof n!=='number'||!Number.isFinite(n)||n< -1||n>Number.MAX_SAFE_INTEGER||![4,5].includes(j)&&!Number.isInteger(n))||row[0]!==i+1||!Object.values(phases).includes(row[1])||!Number.isInteger(row[2])||row[2]<0||row[2]>2)throw Error('ROW');
 return v;
}
function fixtureLengths(v){
 if(!v||!Array.isArray(v.uploads)||v.uploads.length>4||!Array.isArray(v.submissions)||v.submissions.length>2)throw Error('FIXTURE');
 const values=new Map();for(const [i,u]of v.uploads.entries()){if(u?.id!=='upload_'+(i+1)||number(u.bytes)<0)throw Error('UPLOAD');values.set(u.id,u.bytes);}
 const png=number(v.result?.bytes);if(png<0)throw Error('PNG');
 const prefix=[];let total=0;
 if(v.uploads.length!==v.submissions.length*2)throw Error('PAIRING');
 for(const [i,sub]of v.submissions.entries()){
  const ids=[sub?.sourceUploadId,sub?.maskUploadId],expected=['upload_'+(i*2+1),'upload_'+(i*2+2)];
  if(new Set(ids).size!==2||!ids.every(id=>expected.includes(id)&&values.has(id)))throw Error('PAIRING');
  total+=values.get(ids[0])+values.get(ids[1]);if(number(total)<0)throw Error('TOTAL');prefix.push(total);
 }
 return {status:'declared-view-lengths',uploadViews:values.size,submissionPairs:prefix.length,uploadPrefixBytes:prefix,resultPNGViewBytes:png,totalUploadViewBytes:total,physicalBytes:null,livenessAfterExit:false};
}
export function readCandidateMemory(root){
 let observation,fixture;try{observation=validatePacket(JSON.parse(readBounded(join(root,candidateMemoryFiles.sidecar),MAX_BYTES)));}catch{observation=unavailable('sidecar-unavailable');}
 try{fixture=fixtureLengths(JSON.parse(readBounded(join(root,candidateMemoryFiles.fixture),FIXTURE_BYTES)));}catch{fixture={status:'unavailable'};}
 const packet={kind:'native99-passive-memory-readback-1',observation,fixture,qualification:false,nativeAllocationOwner:'unobserved'};
 return JSON.parse(bounded(packet));
}
export function reportCandidateMemory(root,report){try{report(bounded(readCandidateMemory(root)));}catch{/* Preserve the original case/close result. */}}

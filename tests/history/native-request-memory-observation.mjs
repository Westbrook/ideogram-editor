// Test-only transition evidence. This module never reads/writes files, starts a
// worker, schedules work, changes a reservation, or retains request/result bytes.
import {Worker,threadId} from 'node:worker_threads';

const SAMPLE_CAPACITY=12,DESCRIPTOR_CAPACITY=6,WORKER_CAPACITY=4,MAXIMUM_BYTES=6144;
const fields=Object.freeze(['sequence','descriptorId','phase','outcome','pid','threadId','workerThreadId','workerInstance','rpcId','clockOriginUnixMs','atMs','rss','heapTotal','heapUsed','external','arrayBuffers','lifetimeMaxRSSBytes','documentResolvedAtSample']);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:null;
const diagnosticId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)?value:null;
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:-1;
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:-1;

function recorder(role){
 const storage=new Float64Array(SAMPLE_CAPACITY*fields.length),descriptors=new Map(),reviews=new Map(),pending=new Set();
 const processIdentity=Object.freeze({pid:process.pid,threadId,clockOriginUnixMs:performance.timeOrigin});
 let sequence=0,writes=0,nextDescriptor=0,faults=0,closed=false;
 const dropped={records:0,descriptors:0,bindings:0,pending:0,workers:0};
 const fault=()=>{faults++;};
 const guarded=action=>{try{return action();}catch{fault();return undefined;}};
 const sample=(descriptor,phase,outcome)=>guarded(()=>{
  if(closed)return;
  const next=++sequence,memory=process.memoryUsage(),usage=process.resourceUsage();
  const values=[next,descriptor.id,phase,outcome,process.pid,threadId,descriptor.workerThreadId,descriptor.workerInstance,descriptor.rpcId,performance.timeOrigin,performance.now(),memory.rss,memory.heapTotal,memory.heapUsed,memory.external,memory.arrayBuffers,usage.maxRSS*1024,descriptor.documentId?1:0];
  if(values.some(value=>!Number.isFinite(value)))throw Error('numeric observation unavailable');
  storage.set(values,(writes%SAMPLE_CAPACITY)*fields.length);writes++;if(writes>SAMPLE_CAPACITY)dropped.records++;
 });
 // The parser is observational only. Product parsing remains authoritative.
 const identify=(method,bytes)=>guarded(()=>{
  if(closed||!['uiPersist','queueCommand'].includes(method))return null;
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)throw Error('control bytes unavailable');
  const value=JSON.parse(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('utf8'));
  const command=method==='queueCommand'?value?.command:null,body=method==='queueCommand'?command?.body:value?.body;
  const operation=body?.type;
  if(method==='uiPersist'&&!['PrepareRequestReview','AcceptRequestReview'].includes(operation)||method==='queueCommand'&&operation!=='QueueInference')return null;
  const requestId=method==='uiPersist'?id(value.requestId):null,commandId=method==='queueCommand'?id(command.commandId):null;
  const reviewId=operation==='PrepareRequestReview'?null:id(body.reviewId),acceptanceId=operation==='QueueInference'?id(body.acceptanceId):null;
  if(value.protocolVersion!==1||method==='uiPersist'&&!requestId||method==='queueCommand'&&!commandId||operation!=='PrepareRequestReview'&&!reviewId||operation==='QueueInference'&&!acceptanceId)throw Error('operation identity unavailable');
  return {operation,requestId,commandId,reviewId,acceptanceId};
 });
 const reviewKey=descriptor=>descriptor.workerInstance+':'+descriptor.reviewId;
 const begin=(identity,workerInstance,workerThreadId,rpcId=-1)=>guarded(()=>{
  if(closed||!identity)return null;
  if(pending.size>=DESCRIPTOR_CAPACITY){dropped.pending++;return null;}
  if(descriptors.size>=DESCRIPTOR_CAPACITY){const retired=[...descriptors.values()].find(value=>!pending.has(value.id));if(!retired){dropped.descriptors++;return null;}descriptors.delete(retired.id);dropped.descriptors++;}
  const descriptor={id:++nextDescriptor,...identity,documentId:null,workerInstance,workerThreadId,rpcId,bound:false};
  const review=descriptor.reviewId?reviews.get(reviewKey(descriptor)):null;
  if(review&&(descriptor.operation==='AcceptRequestReview'||descriptor.operation==='QueueInference'&&review.acceptRequestId===descriptor.acceptanceId)){descriptor.documentId=review.documentId;descriptor.bound=true;}
  descriptors.set(descriptor.id,descriptor);pending.add(descriptor.id);sample(descriptor,1,0);return descriptor;
 });
 const finish=(descriptor,result,exception=false,outcomeOverride)=>guarded(()=>{
  if(closed||!descriptor||!pending.has(descriptor.id))return;
  let outcome=outcomeOverride??(exception?3:result?.status==='rejected'?2:1);
  if(!exception&&outcomeOverride===undefined){
   if(descriptor.operation==='PrepareRequestReview'&&result?.status==='accepted'){
    const reviewId=id(result.review?.id),documentId=id(result.review?.documentId);
    if(result.requestId!==descriptor.requestId||!reviewId||!documentId)fault();
    else{
     descriptor.reviewId=reviewId;descriptor.documentId=documentId;descriptor.bound=true;
     const key=reviewKey(descriptor);if(!reviews.has(key)&&reviews.size>=DESCRIPTOR_CAPACITY){reviews.delete(reviews.keys().next().value);dropped.bindings++;}
     reviews.set(key,{reviewId,documentId,prepareRequestId:descriptor.requestId,acceptRequestId:null});
    }
   }else if(descriptor.operation==='AcceptRequestReview'&&result?.status==='accepted'){
    const review=reviews.get(reviewKey(descriptor));
    if(!review||!descriptor.bound||result.requestId!==descriptor.requestId||result.acceptedReview!==descriptor.reviewId||id(result.review?.id)!==descriptor.reviewId||id(result.review?.documentId)!==descriptor.documentId)fault();
    else review.acceptRequestId=descriptor.requestId;
   }
  }
  sample(descriptor,2,outcome);pending.delete(descriptor.id);
 });
 const observeReturn=(descriptor,result)=>{
  if(!descriptor)return;
  // Return the original value/Promise to the caller. The additional branch has
  // both handlers and neither can throw; it changes no fulfillment/rejection.
  guarded(()=>{if(result instanceof Promise)Promise.prototype.then.call(result,value=>{finish(descriptor,value);},()=>{finish(descriptor,undefined,true);});else finish(descriptor,result);});
 };
 const rows=()=>{const count=Math.min(writes,SAMPLE_CAPACITY),result=[];for(let i=writes-count;i<writes;i++)result.push(Array.from(storage.subarray((i%SAMPLE_CAPACITY)*fields.length,(i%SAMPLE_CAPACITY+1)*fields.length)));return result;};
 const unavailable=(uuid,context,reason)=>({kind:'native-request-memory-unavailable-1',role,diagnosticId:uuid,processIdentity,context,reason,incomplete:true,activePending:pending.size,dropped:{...dropped},faults,closed,maximumBytes:MAXIMUM_BYTES,nativeAllocationOwner:'unobserved'});
 const snapshotForFailure=(uuid,input={})=>{
  let validUUID=null,context={documentId:null,queueCommandId:null,jobId:null};
  try{
   validUUID=diagnosticId(uuid);context={documentId:id(input?.documentId),queueCommandId:id(input?.queueCommandId),jobId:id(input?.jobId)};
   if(!validUUID||!context.documentId){fault();return unavailable(validUUID,context,'failure-binding-unavailable');}
   const candidates=[...descriptors.values()].filter(value=>value.operation==='QueueInference'&&value.bound&&value.documentId===context.documentId);
   const queue=context.queueCommandId?candidates.find(value=>value.commandId===context.queueCommandId):candidates.at(-1);
   if(!queue)return unavailable(validUUID,context,'queue-cohort-unavailable');
   const cohort=[...descriptors.values()].filter(value=>value.workerInstance===queue.workerInstance&&value.reviewId===queue.reviewId&&value.documentId===queue.documentId);
   const prepare=cohort.find(value=>value.operation==='PrepareRequestReview'),accept=cohort.find(value=>value.operation==='AcceptRequestReview'&&value.requestId===queue.acceptanceId);
   if(!prepare||!accept)return unavailable(validUUID,context,'review-cohort-unavailable');
   const selected=[prepare,accept,queue],selectedIds=new Set(selected.map(value=>value.id)),records=rows().filter(row=>selectedIds.has(row[1]));
   const descriptorsOut=selected.map(({bound,...value})=>value);
   const incomplete=faults>0||Object.values(dropped).some(Boolean)||selected.some(value=>pending.has(value.id))||selected.some(value=>records.filter(row=>row[1]===value.id).length!==2);
   const snapshot={kind:'native-request-memory-transitions-1',role,diagnosticId:validUUID,processIdentity,context,
    binding:{documentId:queue.documentId,queueCommandId:queue.commandId,reviewId:queue.reviewId,prepareRequestId:prepare.requestId,acceptRequestId:accept.requestId,acceptanceId:queue.acceptanceId},
    selectionBasis:context.queueCommandId?'exact-queue-command':'latest-observed-document',sampleCapacity:SAMPLE_CAPACITY,descriptorCapacity:DESCRIPTOR_CAPACITY,maximumBytes:MAXIMUM_BYTES,
    fields,records,descriptors:descriptorsOut,activePending:pending.size,dropped:{...dropped},faults,incomplete,closed,
    phases:{before:1,after:2},outcomes:{pending:0,fulfilled:1,rejectedReceipt:2,exception:3,workerExit:4},
    rssScope:'whole-process',heapScope:'record-threadId',lifetimeMaxRSSScope:'process-lifetime-high-water',nativeAllocationOwner:'unobserved',
    documentBinding:'Prepare-before may be unresolved; documentResolvedAtSample preserves that fact. Later association uses the actual Prepare result and matching review/acceptance IDs.',
    replySemantics:role==='http-main'?'Matching writer RPC reply observed; not a durability or qualification claim.':'Original method settled; not a durability or qualification claim.'};
   if(Buffer.byteLength(JSON.stringify(snapshot))>MAXIMUM_BYTES)return unavailable(validUUID,context,'snapshot-byte-bound');
   return snapshot;
  }catch{fault();return unavailable(validUUID,context,'observation-fault');}
 };
 return {identify,begin,finish,observeReturn,snapshotForFailure,guarded,fault,dropWorker(){dropped.workers++;},get closed(){return closed;},close(){if(pending.size){dropped.pending+=pending.size;pending.clear();}closed=true;},};
}

export function observeNativeRequestWriter(store){
 const memory=recorder('writer'),restores=[];
 for(const [owner,key,method]of [[store?.ui,'persist','uiPersist'],[store?.queue,'command','queueCommand']])memory.guarded(()=>{
  const original=owner[key];if(typeof original!=='function')throw Error('method unavailable');
  const observed=function(...args){
   const descriptor=memory.begin(memory.identify(method,args[0]),0,threadId);
   let result;try{result=Reflect.apply(original,this,args);}catch(error){memory.finish(descriptor,undefined,true);throw error;}
   memory.observeReturn(descriptor,result);return result;
  };
  owner[key]=observed;restores.push(()=>{if(owner[key]===observed)owner[key]=original;else memory.fault();});
 });
 return Object.freeze({snapshotForFailure:memory.snapshotForFailure,close(){for(const restore of restores.splice(0))memory.guarded(restore);memory.close();}});
}

export function observeNativeRequestMain({workerPrototype=Worker.prototype}={}){
 const memory=recorder('http-main'),workers=new Map();let nextWorker=0,installed=false,original,observed;
 const retire=(worker,state,exited=false)=>{
  // Teardown is not evidence that a live worker exited. On stop, the recorder
  // discloses remaining pending samples as dropped/incomplete instead.
  if(exited)for(const descriptor of state.pending.values())memory.finish(descriptor,undefined,true,4);
  state.pending.clear();memory.guarded(()=>worker.off('message',state.message));memory.guarded(()=>worker.off('exit',state.exit));workers.delete(worker);
 };
 const attach=worker=>{
  let state=workers.get(worker);if(state)return state;
  if(workers.size>=WORKER_CAPACITY){memory.dropWorker();return null;}
  const actualThread=integer(worker.threadId);if(actualThread<1){memory.fault();return null;}
  state={instance:++nextWorker,threadId:actualThread,pending:new Map(),message:null,exit:null};
  state.message=message=>memory.guarded(()=>{
   if(memory.closed||!message||!['result','error'].includes(message.type)||!Number.isSafeInteger(message.id))return;
   const descriptor=state.pending.get(message.id);if(!descriptor)return;state.pending.delete(message.id);
   memory.finish(descriptor,message.type==='result'?message.result:undefined,message.type==='error');
  });
  state.exit=()=>memory.guarded(()=>retire(worker,state,true));
  try{worker.on('message',state.message);worker.on('exit',state.exit);workers.set(worker,state);return state;}
  catch{memory.guarded(()=>worker.off('message',state.message));memory.guarded(()=>worker.off('exit',state.exit));memory.fault();return null;}
 };
 memory.guarded(()=>{
  if(threadId!==0)throw Error('main observation requires actual main isolate');
  original=workerPrototype.postMessage;if(typeof original!=='function')throw Error('postMessage unavailable');
  observed=function(...args){
   let state,descriptor;
   memory.guarded(()=>{
    if(memory.closed)return;
    const message=args[0],identity=memory.identify(message?.method,message?.args?.bytes);if(!identity)return;
    if(!Number.isSafeInteger(message.id)||message.id<1)throw Error('RPC identity unavailable');
    state=attach(this);if(!state)return;if(state.pending.has(message.id))throw Error('duplicate observed RPC');
    descriptor=memory.begin(identity,state.instance,state.threadId,message.id);if(descriptor)state.pending.set(message.id,descriptor);
   });
   try{return Reflect.apply(original,this,args);}catch(error){if(descriptor){state.pending.delete(descriptor.rpcId);memory.finish(descriptor,undefined,true);}throw error;}
  };
  workerPrototype.postMessage=observed;installed=true;
 });
 return Object.freeze({snapshotForFailure:memory.snapshotForFailure,close(){
  if(installed){memory.guarded(()=>{if(workerPrototype.postMessage===observed)workerPrototype.postMessage=original;else memory.fault();});installed=false;}
  for(const [worker,state]of workers)memory.guarded(()=>retire(worker,state));memory.close();
 }});
}

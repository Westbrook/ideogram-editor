import {Worker} from 'node:worker_threads';
import type {RasterJob,RasterResult,ResourcePlan} from './engine.js';
import type {RasterWorkerSnapshot} from './active-compute.js';
import type {RasterWorkerIdentity,RasterWorkerReply,RasterWorkerRestart} from './worker-protocol.js';
import {RASTER_WORKER_PROTOCOL} from './worker-protocol.js';
import {StoreError} from '../storage/errors.js';

type WorkerPort=Pick<Worker,'threadId'|'on'|'postMessage'|'terminate'>;
type Hooks={check:()=>void;admit:(plan:ResourcePlan)=>void;failure:(message:Extract<RasterWorkerReply,{type:'failure'}>)=>unknown;telemetry:(snapshot:RasterWorkerSnapshot|undefined)=>void};
type Pending={jobId:number;slot:string;hooks:Hooks;resolve:(result:RasterResult)=>void;reject:(error:unknown)=>void;admitted:boolean;result?:RasterResult;error?:unknown};
type Process={worker:WorkerPort;generation:number;identity?:RasterWorkerIdentity;ready:Promise<void>;readyResolve:()=>void;readyReject:(error:unknown)=>void;exit:Promise<void>;exitResolve:()=>void;timer?:ReturnType<typeof setTimeout>;terminating?:Promise<void>;expectedExit:boolean;exited:boolean};
const safeCounter=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;

/** One actual raster worker executes real jobs serially. Idle retains the
 * service thread/module runtime, never job inputs, output objects or admission
 * leases. That is not a promise that the native allocator returns its RSS. */
export class RasterWorkerOwner {
 private process?:Process;private pending?:Pending;private generation=0;private nextJob=0;private closed=false;private restarting=false;private completedJobs=0;private lastCompleted:{generation:number;threadId:number;jobId:number}|null=null;
 constructor(private readonly createWorker:(generation:number)=>WorkerPort=generation=>new Worker(new URL('./worker.js',import.meta.url),{
  workerData:{protocolVersion:RASTER_WORKER_PROTOCOL,generation},env:{},resourceLimits:{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:8},
  ...(process.execArgv.some(arg=>arg.startsWith('--input-type'))?{execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type'))}:{})
 })){}
 get snapshot(){return {generation:this.generation,identity:this.process?.identity?{...this.process.identity}:null,activeJobs:this.pending?1:0,slot:this.pending?.slot??null,workerCount:this.process&&!this.process.exited?1:0,idleWorkers:this.process?.identity&&!this.pending&&!this.restarting&&!this.process.exited?1:0,restarting:this.restarting,retainedJobReferences:this.pending?1:0,closed:this.closed,nativeAllocatorReleaseClaim:false,completedJobs:this.completedJobs,lastCompleted:this.lastCompleted?{...this.lastCompleted}:null};}
 private fail(error:unknown){const pending=this.pending;if(pending){pending.error??=error;pending.result=undefined;}return this.process?this.terminate(this.process):Promise.resolve();}
 private terminate(record:Process):Promise<void>{
  record.terminating??=(async()=>{record.expectedExit=true;clearTimeout(record.timer);await record.worker.terminate();await record.exit;})();return record.terminating;
 }
 private ensure():Process {
  if(this.closed)throw new StoreError('CLOSED');
  if(this.process&&!this.process.exited)return this.process;
  if(this.generation>=Number.MAX_SAFE_INTEGER)throw new StoreError('CAPACITY');const generation=++this.generation;let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,exitResolve!:()=>void;
  const ready=new Promise<void>((yes,no)=>{readyResolve=yes;readyReject=no;});ready.catch(()=>{});
  const exit=new Promise<void>(yes=>{exitResolve=yes;});
  const worker=this.createWorker(generation),record:Process={worker,generation,ready,readyResolve,readyReject,exit,exitResolve,expectedExit:false,exited:false};this.process=record;
  record.timer=setTimeout(()=>{if(this.process!==record||record.exited)return;record.readyReject(new StoreError('CAPACITY'));void this.fail(new StoreError('CAPACITY')).catch(()=>{});},15000);
  worker.on('message',(message:RasterWorkerReply)=>this.message(record,message));
  worker.on('error',()=>{if(this.process!==record||record.exited)return;record.readyReject(new StoreError('CAPACITY'));void this.fail(new StoreError('CAPACITY')).catch(()=>{});});
  worker.on('exit',()=>{
   clearTimeout(record.timer);record.exited=true;record.readyReject(new StoreError('STORAGE_FAILURE'));record.exitResolve();
   if(this.process!==record)return;this.process=undefined;
   const pending=this.pending;this.pending=undefined;if(pending)pending.reject(pending.error??new StoreError('STORAGE_FAILURE'));
  });
  return record;
 }
 private message(record:Process,message:RasterWorkerReply){
  if(this.process!==record||record.exited)return;
  try{
   if(!message||message.generation!==record.generation)throw new StoreError('CORRUPT_STORE');
   // Cleanup evidence belongs to this already-owned job even if its authority
   // was cancelled meanwhile. Keep native retained-byte reports while awaiting
   // actual exit; a cancelled document cannot make those allocations disappear.
   if(message.type==='failure'){
    const pending=this.pending;if(!record.identity||!pending||message.jobId!==pending.jobId)throw new StoreError('CORRUPT_STORE');
    pending.hooks.telemetry(message.telemetry);const failure=pending.hooks.failure(message);pending.error??=failure;pending.result=undefined;
    void this.fail(pending.error??new StoreError('STORAGE_FAILURE')).catch(()=>{});return;
   }
   if(record.expectedExit)return;
   if(message.type==='ready'){
    if(record.identity||message.protocolVersion!==RASTER_WORKER_PROTOCOL||message.threadId!==record.worker.threadId||!safeCounter(message.threadId)||!Number.isFinite(message.startedMs)||!Number.isFinite(message.clockOriginUnixMs))throw new StoreError('CORRUPT_STORE');
    record.identity={generation:record.generation,threadId:message.threadId,startedMs:message.startedMs,clockOriginUnixMs:message.clockOriginUnixMs};clearTimeout(record.timer);record.readyResolve();return;
   }
   const pending=this.pending;if(!record.identity||!pending||message.jobId!==pending.jobId)throw new StoreError('CORRUPT_STORE');
   pending.hooks.check();
   if(message.type==='plan'){
    if(pending.admitted||pending.result||pending.error)throw new StoreError('CORRUPT_STORE');pending.hooks.admit(message.plan);pending.admitted=true;record.worker.postMessage({type:'admit',generation:record.generation,jobId:pending.jobId});return;
   }
   if(message.type==='result'){
    if(!pending.admitted||pending.result||pending.error||!message.result)throw new StoreError('CORRUPT_STORE');pending.result=message.result;pending.hooks.telemetry(message.result.telemetry);return;
   }
   if(message.type==='idle'){
    if(!pending.admitted||!pending.result||pending.error||message.completed!==true||message.retainedJobReferences!==0)throw new StoreError('CORRUPT_STORE');
    const result=pending.result;pending.result=undefined;this.completedJobs++;this.lastCompleted={generation:record.generation,threadId:record.identity.threadId,jobId:pending.jobId};this.pending=undefined;pending.resolve(result);return;
   }
   throw new StoreError('CORRUPT_STORE');
  }catch(error){record.readyReject(error);void this.fail(error).catch(()=>{});}
 }
 run(job:RasterJob,slot:string,hooks:Hooks):Promise<RasterResult>{
  if(this.closed)return Promise.reject(new StoreError('CLOSED'));
  if(this.pending||this.restarting)return Promise.reject(new StoreError('QUEUE_FULL'));
  if(this.nextJob>=Number.MAX_SAFE_INTEGER)return Promise.reject(new StoreError('CAPACITY'));
  if(!/^(?:history|raster|display|candidate-prepare|queue|portable):[A-Za-z0-9_-]{1,128}$/.test(slot))return Promise.reject(new StoreError('MALFORMED_REQUEST'));
  let resolve!:(result:RasterResult)=>void,reject!:(error:unknown)=>void;const promise=new Promise<RasterResult>((yes,no)=>{resolve=yes;reject=no;});
  const pending:Pending={jobId:++this.nextJob,slot,hooks,resolve,reject,admitted:false};this.pending=pending;
  void (async()=>{try{hooks.check();const record=this.ensure();await record.ready;if(this.closed||this.pending!==pending||this.process!==record||record.expectedExit)throw new StoreError('CLOSED');hooks.check();record.worker.postMessage({type:'run',generation:record.generation,jobId:pending.jobId,job});}
   catch(error){pending.error??=error;if(this.process)await this.fail(error);else if(this.pending===pending){this.pending=undefined;pending.reject(error);}}})().catch(error=>{if(this.pending===pending){this.pending=undefined;pending.reject(error);}});
  return promise;
 }
 async interrupt(slot:string){if(this.pending?.slot!==slot)return false;await this.fail(new StoreError('CLOSED'));return true;}
 async restartIdle(expectedGeneration:number):Promise<RasterWorkerRestart>{
  if(this.closed)throw new StoreError('CLOSED');const old=this.process;
  if(this.pending||this.restarting||!old?.identity||old.expectedExit||old.exited)throw new StoreError('QUEUE_FULL');
  if(expectedGeneration!==old.generation)throw new StoreError('STALE_EPOCH');
  this.restarting=true;const before={...old.identity},startedMs=performance.now();
  try{await this.terminate(old);const terminatedMs=performance.now();const next=this.ensure();await next.ready;
   return {kind:'raster-worker-restart-1',clock:'owner-performance',startedMs,terminatedMs,readyMs:performance.now(),before,after:{...next.identity!},activeJobs:0,retainedJobReferences:0,forcedGC:false,nativeAllocatorReleaseClaim:false};
  }finally{this.restarting=false;}
 }
 async close(){this.closed=true;if(this.pending)this.pending.error=new StoreError('CLOSED');if(this.process)await this.terminate(this.process);}
}

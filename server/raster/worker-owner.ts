import {diagnosticMemory,type DiagnosticLease,type DiagnosticRead} from '../../src/observability/diagnostic-memory.js';
import {DiagnosticReceiver,RASTER_DIAGNOSTIC_BYTES,RASTER_DIAGNOSTIC_HANDLES,RASTER_DIAGNOSTIC_REPLY_BYTES,type DiagnosticIngress} from '../observability/diagnostic-memory.js';
import {Worker} from 'node:worker_threads';
import type {RasterJob,RasterResult,ResourcePlan} from './engine.js';
import type {RasterWorkerSnapshot} from './active-compute.js';
import type {RasterWorkerIdentity,RasterWorkerReply,RasterWorkerRestart} from './worker-protocol.js';
import {RASTER_WORKER_PROTOCOL} from './worker-protocol.js';
import {StoreError} from '../storage/errors.js';
import {adapterResources} from '../observability/adapter-resources.js';

export type RasterReadyWorkerLease=Readonly<RasterWorkerIdentity>;
type WorkerPort=Pick<Worker,'threadId'|'on'|'postMessage'|'terminate'>;
type Hooks={check:()=>void;admit:(plan:ResourcePlan)=>void;failure:(message:Extract<RasterWorkerReply,{type:'failure'}>)=>unknown;telemetry:(snapshot:DiagnosticRead<RasterWorkerSnapshot>)=>void};
type Pending={jobId:number;slot:string;hooks:Hooks;resolve:(result:RasterResult)=>void;reject:(error:unknown)=>void;admitted:boolean;diagnostic:DiagnosticIngress<RasterWorkerSnapshot>;result?:RasterResult;error?:unknown;failed:boolean;releaseUncovered:()=>void};
type Process={worker:WorkerPort;diagnostic:DiagnosticLease;generation:number;identity?:RasterWorkerIdentity;ready:Promise<void>;readyResolve:()=>void;readyReject:(error:unknown)=>void;exit:Promise<void>;exitResolve:()=>void;timer?:ReturnType<typeof setTimeout>;terminating?:Promise<void>;expectedExit:boolean;exited:boolean;releaseObserved:()=>void;releaseRestartObserved?:()=>void};
const safeCounter=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;

/** One actual raster worker executes real jobs serially. Idle retains the
 * service thread/module runtime, never job inputs, output objects or admission
 * leases. That is not a promise that the native allocator returns its RSS. */
export class RasterWorkerOwner {
 private readonly diagnostics=new DiagnosticReceiver('diagnostic-raster-ingress',RASTER_DIAGNOSTIC_REPLY_BYTES,1);
 private readonly readyLeases=new WeakMap<RasterReadyWorkerLease,{record:Process;completedJobs:number}>();
 private process?:Process;private pending?:Pending;private generation=0;private nextJob=0;private closed=false;private restarting=false;private completedJobs=0;private lastCompleted:{generation:number;threadId:number;jobId:number}|null=null;
 constructor(private readonly createWorker:(generation:number,diagnosticBytes:number)=>WorkerPort=(generation,diagnosticBytes)=>new Worker(new URL('./worker.js',import.meta.url),{
  workerData:{protocolVersion:RASTER_WORKER_PROTOCOL,generation,diagnosticBytes},env:{},resourceLimits:{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:8},
  ...(process.execArgv.some(arg=>arg.startsWith('--input-type'))?{execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type'))}:{})
 })){}
 get snapshot(){return {generation:this.generation,identity:this.process?.identity?{...this.process.identity}:null,activeJobs:this.pending?1:0,slot:this.pending?.slot??null,workerCount:this.process&&!this.process.exited?1:0,idleWorkers:this.process?.identity&&!this.pending&&!this.restarting&&!this.process.exited?1:0,restarting:this.restarting,retainedJobReferences:this.pending?1:0,closed:this.closed,nativeAllocatorReleaseClaim:false,completedJobs:this.completedJobs,lastCompleted:this.lastCompleted?{...this.lastCompleted}:null};}
 /** Only an already ready, idle native generation can support a warm preflight. */
 get readyIdentity():RasterReadyWorkerLease|null {
  const record=this.process;
  if(this.closed||this.pending||this.restarting||!record?.identity||record.exited||record.expectedExit||record.terminating)return null;
  const lease=Object.freeze({...record.identity});this.readyLeases.set(lease,{record,completedJobs:this.completedJobs});return lease;
 }
 private matchesReady(record:Process|undefined,identity:RasterWorkerIdentity):record is Process {
  const actual=record?.identity;
  return !!record&&!!actual&&!record.exited&&!record.expectedExit&&!record.terminating&&actual.generation===identity.generation&&actual.threadId===identity.threadId&&actual.startedMs===identity.startedMs&&actual.clockOriginUnixMs===identity.clockOriginUnixMs;
 }
 private fail(error:unknown){const pending=this.pending;if(pending){if(!pending.failed){pending.error=error;pending.failed=true;}pending.result=undefined;}return this.process?this.terminate(this.process):Promise.resolve();}
 private terminate(record:Process):Promise<void>{
  if(record.exited)return record.exit;
  if(!record.terminating){record.expectedExit=true;clearTimeout(record.timer);const work=(async()=>{await record.worker.terminate();await record.exit;})();record.terminating=work;void work.catch(()=>{if(record.terminating===work)record.terminating=undefined;});}return record.terminating;
 }
 private ensure():Process {
  if(this.closed)throw new StoreError('CLOSED');
  if(this.process&&!this.process.exited)return this.process;
  if(this.generation>=Number.MAX_SAFE_INTEGER)throw new StoreError('CAPACITY');const generation=++this.generation;let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,exitResolve!:()=>void;
  const ready=new Promise<void>((yes,no)=>{readyResolve=yes;readyReject=no;});ready.catch(()=>{});
  const exit=new Promise<void>(yes=>{exitResolve=yes;});
  const diagnostic=diagnosticMemory.reserve('diagnostic-raster-worker',RASTER_DIAGNOSTIC_BYTES,RASTER_DIAGNOSTIC_HANDLES);let worker:WorkerPort;
  try{worker=this.createWorker(generation,RASTER_DIAGNOSTIC_BYTES);}catch(error){diagnostic.release();throw error;}
  const record:Process={worker,diagnostic,generation,ready,readyResolve,readyReject,exit,exitResolve,expectedExit:false,exited:false,releaseObserved:adapterResources.worker('raster',worker.threadId)};this.process=record;
  record.timer=setTimeout(()=>{if(this.process!==record||record.exited)return;record.readyReject(new StoreError('CAPACITY'));void this.fail(new StoreError('CAPACITY')).catch(()=>{});},15000);
  worker.on('message',(message:RasterWorkerReply)=>this.message(record,message));
  worker.on('error',()=>{if(this.process!==record||record.exited)return;record.readyReject(new StoreError('CAPACITY'));void this.fail(new StoreError('CAPACITY')).catch(()=>{});});
  worker.on('exit',()=>{
   if(record.exited)return;clearTimeout(record.timer);record.exited=true;record.releaseObserved();record.releaseRestartObserved?.();record.diagnostic.release();this.diagnostics.nativeExited();record.readyReject(new StoreError('STORAGE_FAILURE'));record.exitResolve();
   if(this.process!==record)return;this.process=undefined;
   const pending=this.pending;this.pending=undefined;if(pending){pending.releaseUncovered();pending.reject(pending.failed?pending.error:new StoreError('STORAGE_FAILURE'));}
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
    this.acceptTelemetry(pending,message.telemetry);message.telemetry=undefined;const failure=pending.hooks.failure(message);if(!pending.failed){pending.error=failure;pending.failed=true;}pending.result=undefined;
    void this.fail(pending.failed?pending.error:new StoreError('STORAGE_FAILURE')).catch(()=>{});return;
   }
   if(record.expectedExit)return;
   if(message.type==='ready'){
    if(record.identity||message.protocolVersion!==RASTER_WORKER_PROTOCOL||message.threadId!==record.worker.threadId||!safeCounter(message.threadId)||!Number.isFinite(message.startedMs)||!Number.isFinite(message.clockOriginUnixMs))throw new StoreError('CORRUPT_STORE');
    record.identity={generation:record.generation,threadId:message.threadId,startedMs:message.startedMs,clockOriginUnixMs:message.clockOriginUnixMs};clearTimeout(record.timer);record.readyResolve();return;
   }
   const pending=this.pending;if(!record.identity||!pending||message.jobId!==pending.jobId)throw new StoreError('CORRUPT_STORE');
   pending.hooks.check();
   if(message.type==='plan'){
    if(pending.admitted||pending.result||pending.failed)throw new StoreError('CORRUPT_STORE');pending.hooks.admit(message.plan);pending.admitted=true;record.worker.postMessage({type:'admit',generation:record.generation,jobId:pending.jobId});return;
   }
   if(message.type==='result'){
    if(!pending.admitted||pending.result||pending.failed||!message.result)throw new StoreError('CORRUPT_STORE');this.acceptTelemetry(pending,message.telemetry);message.telemetry=undefined;pending.result=message.result;return;
   }
   if(message.type==='idle'){
    if(!pending.admitted||!pending.result||pending.failed||message.completed!==true||message.retainedJobReferences!==0)throw new StoreError('CORRUPT_STORE');
    const result=pending.result;pending.result=undefined;this.completedJobs++;this.lastCompleted={generation:record.generation,threadId:record.identity.threadId,jobId:pending.jobId};this.pending=undefined;pending.releaseUncovered();pending.resolve(result);return;
   }
   throw new StoreError('CORRUPT_STORE');
  }catch(error){record.readyReject(error);void this.fail(error).catch(()=>{});}
 }
 private acceptTelemetry(pending:Pending,value:RasterWorkerSnapshot|undefined){
  if(value===undefined){pending.diagnostic.settledWithoutValue();return;}
  let read;try{read=pending.diagnostic.receive(value);pending.hooks.telemetry(read);}finally{if(read)read.release();else pending.diagnostic.settledWithoutValue();}
 }
 run(job:RasterJob,slot:string,hooks:Hooks,requiredReadyWorker?:RasterReadyWorkerLease):Promise<RasterResult>{
  const required=requiredReadyWorker?this.readyLeases.get(requiredReadyWorker):undefined;
  if(requiredReadyWorker)this.readyLeases.delete(requiredReadyWorker);
  if(this.closed)return Promise.reject(new StoreError('CLOSED'));
  if(this.pending||this.restarting)return Promise.reject(new StoreError('QUEUE_FULL'));
  if(this.nextJob>=Number.MAX_SAFE_INTEGER)return Promise.reject(new StoreError('CAPACITY'));
  const requiredRecord=required?.record;
  if(requiredReadyWorker&&(!required||required.completedJobs!==this.completedJobs||this.process!==requiredRecord||!this.matchesReady(requiredRecord,requiredReadyWorker)))return Promise.reject(new StoreError('CAPACITY'));
  if(!/^(?:history|raster|display|candidate-prepare|queue|portable):[A-Za-z0-9_-]{1,128}$/.test(slot))return Promise.reject(new StoreError('MALFORMED_REQUEST'));
  let resolve!:(result:RasterResult)=>void,reject!:(error:unknown)=>void;const promise=new Promise<RasterResult>((yes,no)=>{resolve=yes;reject=no;});
  let diagnostic:DiagnosticIngress<RasterWorkerSnapshot>;try{diagnostic=this.diagnostics.admit<RasterWorkerSnapshot>();}catch(error){return Promise.reject(error);}
  // Failed termination can reject publicly while pending native work remains owned.
  const releaseUncovered=adapterResources.uncovered('raster-worker-job');
  const pending:Pending={jobId:++this.nextJob,slot,hooks,resolve,reject,admitted:false,failed:false,diagnostic,releaseUncovered};this.pending=pending;
  void (async()=>{try{
   hooks.check();
   // A pinned warm run never calls ensure(), including after an actual exit.
   if(requiredReadyWorker&&(this.process!==requiredRecord||!this.matchesReady(requiredRecord,requiredReadyWorker)))throw new StoreError('CAPACITY');
   const record=requiredReadyWorker?requiredRecord!:this.ensure();await record.ready;
   if(this.closed||this.pending!==pending||this.process!==record||record.expectedExit||record.exited||record.terminating)throw new StoreError('CLOSED');
   if(requiredReadyWorker&&!this.matchesReady(record,requiredReadyWorker))throw new StoreError('CAPACITY');
   hooks.check();
   if(this.closed||this.pending!==pending||this.process!==record||record.expectedExit||record.exited||record.terminating)throw new StoreError('CLOSED');
   record.worker.postMessage({type:'run',generation:record.generation,jobId:pending.jobId,job});
  }catch(error){
   // An exit already settled this job; never retire a newer owner's worker.
   if(this.pending!==pending)return;
   if(!pending.failed){pending.error=error;pending.failed=true;}if(this.process)await this.fail(error);else{this.pending=undefined;pending.diagnostic.settledWithoutValue();pending.releaseUncovered();pending.reject(error);}
  }})().catch(error=>{if(this.pending===pending)pending.reject(error);});
  return promise;
 }
 async interrupt(slot:string){if(this.pending?.slot!==slot)return false;await this.fail(new StoreError('CLOSED'));return true;}
 async restartIdle(expectedGeneration:number):Promise<RasterWorkerRestart>{
  if(this.closed)throw new StoreError('CLOSED');const old=this.process;
  if(this.pending||this.restarting||!old?.identity||old.expectedExit||old.exited)throw new StoreError('QUEUE_FULL');
  if(expectedGeneration!==old.generation)throw new StoreError('STALE_EPOCH');
  // A failed restart retains coverage until its surviving worker actually exits.
  const releaseUncovered=adapterResources.uncovered('raster-worker-restart');let completed=false;this.restarting=true;const before={...old.identity},startedMs=performance.now();
  try{await this.terminate(old);const terminatedMs=performance.now();const next=this.ensure();await next.ready;
   // Ready can be drained immediately before the worker's exit event. Recheck
   // the actual replacement after awaiting it; a lost generation is not ready.
   if(this.closed||this.process!==next||next.expectedExit||next.exited||next.terminating||!next.identity)throw new StoreError('CLOSED');
   completed=true;return {kind:'raster-worker-restart-1',clock:'owner-performance',startedMs,terminatedMs,readyMs:performance.now(),before,after:{...next.identity!},activeJobs:0,retainedJobReferences:0,forcedGC:false,nativeAllocatorReleaseClaim:false};
  }finally{this.restarting=false;const remaining=this.process;if(!completed&&remaining&&!remaining.exited)remaining.releaseRestartObserved=releaseUncovered;else releaseUncovered();}
 }
 async close(){this.closed=true;this.diagnostics.close();if(this.pending){this.pending.error=new StoreError('CLOSED');this.pending.failed=true;}if(this.process)await this.terminate(this.process);}
}

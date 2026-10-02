import {diagnosticMemory,diagnosticPayloadBytes} from '../../src/observability/diagnostic-memory.js';
import {adoptWorkerDiagnostics,RASTER_DIAGNOSTIC_BYTES,RASTER_DIAGNOSTIC_REPLY_BYTES,diagnosticReleases} from '../observability/diagnostic-memory.js';
import {parentPort,workerData,threadId} from 'node:worker_threads';
import {runRaster,type RasterJob,type RasterResult} from './engine.js';
import {PhaseRecorder,sanitizePhaseContext} from '../../src/observability/phases.js';
import {ActiveCompute} from './active-compute.js';
import {rasterFailure} from './failure.js';
import {RASTER_WORKER_PROTOCOL,type RasterWorkerRequest,type RasterWorkerReply,type RasterWorkerKey} from './worker-protocol.js';
if(!parentPort)throw Error('Raster requires a worker');
adoptWorkerDiagnostics(workerData?.diagnosticBytes,RASTER_DIAGNOSTIC_BYTES);
const port=parentPort;
const persistent=workerData?.protocolVersion===RASTER_WORKER_PROTOCOL;
const generation=persistent?workerData.generation:1;
if(!Number.isSafeInteger(generation)||generation<1)throw Error('RASTER_WORKER_PROTOCOL');
let current:RasterWorkerKey|null=null,admission:((accepted:boolean)=>void)|undefined,lastJob=0;
const post=(message:RasterWorkerReply)=>port.postMessage(persistent?message:Object.fromEntries(Object.entries(message).filter(([key])=>key!=='generation'&&key!=='jobId')));
const check=()=>{if(process.memoryUsage().rss>512*1024*1024)throw Error('RASTER_RESOURCES');};

/** Returning from this function releases all job input/result references before
 * the idle acknowledgement. Native allocator RSS is measured independently. */
async function execute(job:RasterJob,key:RasterWorkerKey):Promise<boolean>{
 const contextLease=diagnosticMemory.reserve('diagnostic-raster-context',65536);let phases:PhaseRecorder|undefined,activeCompute:ActiveCompute|undefined;
 try{const context=sanitizePhaseContext(job.telemetry??{});phases=new PhaseRecorder({lane:'raster-worker',capacity:64});activeCompute=new ActiveCompute({context});
 return await executeOwned(job,key,context,phases,activeCompute);
 }finally{diagnosticReleases([{release:()=>activeCompute?.dispose()},{release:()=>phases?.dispose()},contextLease])();}
}
async function executeOwned(job:RasterJob,key:RasterWorkerKey,context:import('../../src/observability/phases.js').PhaseContext,phases:PhaseRecorder,activeCompute:ActiveCompute):Promise<boolean>{
 let admitted=false;
 // Missing diagnostic evidence never changes an otherwise successful raster.
 const transmit=(message:Extract<RasterWorkerReply,{type:'result'|'failure'}>)=>{
  let phaseRead:ReturnType<PhaseRecorder['readSnapshot']>|undefined,activeRead:ReturnType<ActiveCompute['readSnapshot']>|undefined;
  try{try{phaseRead=phases.readSnapshot();activeRead=activeCompute.readSnapshot();const telemetry={...phaseRead.value,activeCompute:activeRead.value};if(diagnosticPayloadBytes(telemetry)<=RASTER_DIAGNOSTIC_REPLY_BYTES)message.telemetry=telemetry;}catch{message.telemetry=undefined;}
   post(message);
  }finally{message.telemetry=undefined;diagnosticReleases([...(phaseRead?[phaseRead]:[]),...(activeRead?[activeRead]:[])])();}
 };
 const preparation=phases.start('raster.prepare',context);
 const operation=job.type==='compose'&&job.requestSource?phases.start('source.capture',{...context,documentId:job.requestSource.documentId,revision:job.requestSource.documentRevision}):job.type==='mask'?phases.start('mask.plan',context):undefined;
 const failure=(error:unknown)=>{const value=rasterFailure(error);preparation.end('error');operation?.end('error');activeCompute.finish('failed');transmit({type:'failure',...key,...value});};
 const timer=setInterval(()=>{try{check();}catch(error){failure(error);process.exit(1);}},10);timer.unref();
 try{
  const result:RasterResult=await runRaster(job,plan=>new Promise<void>((resolve,reject)=>{
   if(admission||admitted){reject(Error('RASTER_WORKER_PROTOCOL'));return;}
   admission=accepted=>{admission=undefined;if(accepted){admitted=true;resolve();}else reject(Error('RASTER_RESOURCES'));};
   post({type:'plan',...key,plan});
  }),check,phases,activeCompute);
  if(!admitted)throw Error('RASTER_RESOURCES');
  preparation.end('incomplete',{width:result.info.width,height:result.info.height,boundary:'observed'});operation?.end('incomplete',{width:result.info.width,height:result.info.height,boundary:'observed'});
  transmit({type:'result',...key,result});return true;
 }catch(error){failure(error);return false;}
 finally{clearInterval(timer);admission=undefined;}
}

if(persistent){
 port.on('message',(message:RasterWorkerRequest)=>{
  if(!message||message.generation!==generation||!Number.isSafeInteger(message.jobId)||message.jobId<1){process.exit(1);return;}
  if(message.type==='admit'){
   if(!current||current.jobId!==message.jobId||!admission){process.exit(1);return;}
   admission(true);return;
  }
  if(message.type!=='run'||current||message.jobId<=lastJob){process.exit(1);return;}
  lastJob=message.jobId;const key={generation,jobId:message.jobId};current=key;
  void execute(message.job,key).then(completed=>{
   current=null;
   if(completed)post({type:'idle',...key,completed:true,retainedJobReferences:0});
   else port.close();
  }).catch(()=>{process.exit(1);});
 });
 post({type:'ready',protocolVersion:RASTER_WORKER_PROTOCOL,generation,threadId,startedMs:performance.now(),clockOriginUnixMs:performance.timeOrigin});
}else{
 // Preserve direct one-job codec/failure fixtures and the existing internal
 // constructor API while all production Rasters calls use the owned protocol.
 current={generation,jobId:1};port.on('message',message=>{if(message?.type==='admit'&&admission)admission(true);else admission?.(false);});
 try{await execute(workerData,current);}finally{current=null;port.close();}
}

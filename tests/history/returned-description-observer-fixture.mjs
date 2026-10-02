// Test-only failure observation. No command, admission or provider behavior changes.
import {readFileSync,writeFileSync,statSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {setup as setupObserver} from '../candidates/observer-fixture.mjs';
import {adapterResources} from '../../dist/local/server/observability/adapter-resources.js';
import {createNativeMemoryRecorder,nativeMemoryPhases as phase} from './native-memory-diagnostics.mjs';

const memoryOwners=new WeakMap();
const portableImportFailures=new WeakMap();
function installImportFailureObservation(store){
 const owner=store.portables,original=owner.acceptImport;let active=true;
 const observed=async function(...args){
  try{return await Reflect.apply(original,this,args);}catch(error){
   if(active)try{
    const stack=typeof error?.stack==='string'?error.stack:'';
    portableImportFailures.set(store,{kind:'portable-import-failure-1',phase:'acceptImport-rejection',commandId:String(args[1]?.commandId??'').slice(0,80),operationId:String(args[2]??'').slice(0,80),error:{name:String(error?.name??'Unknown').slice(0,80),code:typeof error?.code==='string'?error.code.slice(0,80):null,stack:stack.slice(0,4096),stackTruncated:stack.length>4096},process:process.memoryUsage()});
   }catch{}
   throw error;
  }
 };
 owner.acceptImport=observed;
 return ()=>{active=false;if(owner.acceptImport===observed)owner.acceptImport=original;portableImportFailures.delete(store);};
}
function installMemoryObservation(store){
 // Only the native fixture opts in. Other users of failure diagnostics retain
 // their existing behavior and allocate no transition ring or method wrappers.
 if(!existsSync(join(store.root,'j19-memory-enabled')))return ()=>{};
 const memory=createNativeMemoryRecorder(2),restores=[];memoryOwners.set(store,memory);
 const sample=(step,related=-1,outcome=-1)=>{
  let owned=[];
  try{const p=store.objects.proofInventory(),io=store.objects.reservationInventory();owned=[store.texts.reservedCPU,store.texts.externalBytes(),store.rasters.reservedCPU,p.retained,p.activeReaders,io.activeTransfers];}catch{}
  memory.sample(-1,step,related,outcome,owned);
 };
 const wrap=(owner,key,before,after)=>{
  const original=owner[key];
  const wrapped=function(...args){
   sample(before);
   let work;try{work=Reflect.apply(original,this,args);}catch(error){sample(after,-1,2);throw error;}
   return work.then(value=>{sample(after,-1,1);return value;},error=>{sample(after,-1,2);throw error;});
  };
  owner[key]=wrapped;restores.push(()=>{if(owner[key]===wrapped)owner[key]=original;});
 };
 wrap(store.texts,'inspect',phase.inspectBefore,phase.inspectAfter);
 wrap(store.texts,'verify',phase.verifyBefore,phase.verifyAfter);
 // prepareDocument is not replaced by the encoded-graph guard fixture; using
 // its boundary avoids leaving a nested compute wrapper installed at teardown.
 wrap(store.rasters,'prepareDocument',phase.rasterBefore,phase.rasterAfter);
 const worker=adapterResources.worker;
 const observedWorker=function(kind,id){
  const release=Reflect.apply(worker,this,[kind,id]);
  if(kind!=='text-font'&&kind!=='text-verification')return release;
  sample(kind==='text-font'?phase.fontWorkerStart:phase.verifyWorkerStart,id);
  // Both production call sites release this owner inside their actual Worker
  // exit handler, before the surrounding reservation is refunded. This sample
  // is in the writer isolate; it does not measure the departed worker's heap.
  return ()=>{try{return release();}finally{sample(kind==='text-font'?phase.fontWorkerExitRelease:phase.verifyWorkerExitRelease,id);}};
 };
 adapterResources.worker=observedWorker;restores.push(()=>{if(adapterResources.worker===observedWorker)adapterResources.worker=worker;});
 sample(phase.writerOpen);
 return ()=>{sample(phase.writerObserverStop);for(const restore of restores.reverse())restore();memoryOwners.delete(store);memory.close();};
}

export function captureOwnedDiagnostics(store,commandId){
 const owners=[],releaseFailures=[];let bytes;
 try{
  const history=store.histories.readObservations();owners.push(history);const raster=store.rasters.readDiagnostics();owners.push(raster);const text=store.texts.readObservations();owners.push(text);const portable=store.portables.readObservations();owners.push(portable);
  const r=raster.value,payload={kind:'j19-owned-diagnostics-1',commandId,capturedAt:new Date().toISOString(),process:process.memoryUsage(),text:{reservedCPU:store.texts.reservedCPU,externalBytes:store.texts.externalBytes(),backendCPU:store.texts.backendCPU(),observations:text.value.slice(-32)},history:history.value.slice(-32),raster:{...r,observations:r.observations.slice(-64),workerPhases:r.workerPhases.slice(-32)},portable:{observations:portable.value.slice(-64),droppedObservations:store.portables.droppedObservations,ownership:store.portables.resourceOwnership(),...(portableImportFailures.has(store)?{importFailure:portableImportFailures.get(store)}:{})},objects:store.objects.reservationInventory(),...(memoryOwners.has(store)?{memoryTransitions:memoryOwners.get(store).snapshot()}: {})};
  bytes=Buffer.from(JSON.stringify(payload));if(bytes.length>262144)throw Error('J19_DIAGNOSTIC_BOUND');
 }catch(error){bytes=Buffer.from(JSON.stringify({kind:'j19-diagnostic-unavailable-1',commandId,reason:String(error.code??error.message??error.name).slice(0,80),process:process.memoryUsage()}));}
 finally{for(const owner of owners.reverse())try{owner.release();}catch(error){releaseFailures.push(String(error.code??error.name).slice(0,80));}}
 if(releaseFailures.length)return Buffer.from(JSON.stringify({kind:'j19-diagnostic-unavailable-1',commandId,reason:'owned-reader-release-failed',releaseFailures}));
 return bytes;
}
export function installFailureDiagnostics(store){
 const stopMemory=installMemoryObservation(store);
 let last='';
 const timer=setInterval(()=>{
  const request=join(store.root,'j19-diagnostic-request.json');let commandId;
  try{const stat=statSync(request);if(!stat.isFile()||stat.size>128)return;const value=JSON.parse(readFileSync(request,'utf8'));if(Object.keys(value).length!==1||typeof value.commandId!=='string'||!/^[a-f0-9-]{36}$/.test(value.commandId)||value.commandId===last)return;commandId=value.commandId;last=commandId;}catch{return;}
  try{const output=join(store.root,'j19-diagnostic-'+commandId+'.json');writeFileSync(output+'.tmp',captureOwnedDiagnostics(store,commandId),{mode:0o600,flag:'wx'});renameSync(output+'.tmp',output);}catch{}
 },25);
 return ()=>{clearInterval(timer);stopMemory();};
}
export async function setup(store){const closeObserver=await setupObserver(store),stopDiagnostics=installFailureDiagnostics(store),stopImportObservation=installImportFailureObservation(store);return async()=>{try{stopDiagnostics();}finally{stopImportObservation();await closeObserver();}};}

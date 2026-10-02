import {threadId} from 'node:worker_threads';

// Test-only, fixed numeric storage. No request, rendered output, exception,
// worker, store or source Buffer enters this ring. -1 means unobserved.
export const nativeMemoryPhases=Object.freeze({
 fixtureOpen:1,serverReady:2,baseRasterReady:3,fontImportBefore:4,fontImportAfter:5,
 rendererCreate:6,rendererReady:7,rendererResult:8,rendererExit:9,stagingComplete:10,
 admissionBefore:11,admissionAfter:12,admissionReleaseBefore:13,admissionReleaseAfter:14,
 fixtureCloseBefore:15,fixtureCloseAfter:16,
 writerOpen:20,inspectBefore:21,inspectAfter:22,verifyBefore:23,verifyAfter:24,
 rasterBefore:25,rasterAfter:26,fontWorkerStart:27,fontWorkerExitRelease:28,
 verifyWorkerStart:29,verifyWorkerExitRelease:30,writerObserverStop:31,
});
const capacity=32,fields=Object.freeze(['sequence','fixture','phase','realm','pid','threadId','clockOriginUnixMs','atMs','relatedThreadId','outcome','rss','heapTotal','heapUsed','external','arrayBuffers','textReservedCPU','browserExternalCPU','rasterReservedCPU','retainedProofs','proofReaders','ioTransfers']);
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:-1;
export function createNativeMemoryRecorder(realm){
 let storage=new Float64Array(capacity*fields.length),sequence=0,dropped=0,faults=0;
 const put=(fixture,phase,sample,related=-1,outcome=-1,owned=[])=>{
  if(!storage)return;
  try{
   if(!Array.isArray(sample)||sample.length!==9||sample.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw Error('Invalid numeric memory sample');
   const values=[++sequence,fixture,phase,realm,...sample.slice(0,4),related,outcome,...sample.slice(4),...owned];
   const at=((sequence-1)%capacity)*fields.length;
   for(let i=0;i<fields.length;i++)storage[at+i]=number(values[i]);
   if(sequence>capacity)dropped++;
  }catch{faults++;}
 };
 const sample=(fixture,phase,related=-1,outcome=-1,owned=[])=>{
  if(!storage)return;
  try{const m=process.memoryUsage();put(fixture,phase,[process.pid,threadId,performance.timeOrigin,performance.now(),m.rss,m.heapTotal,m.heapUsed,m.external,m.arrayBuffers],related,outcome,owned);}catch{faults++;}
 };
 return Object.freeze({
  sample,
  remote(fixture,phase,value,related=-1){
   // Only the browser-stand-in worker sends these fixed numeric samples. Its
   // heap fields belong to that worker; RSS still covers its whole process.
   const before=sequence;put(fixture,phase,value,related);
   if(storage&&sequence!==before)storage[((sequence-1)%capacity)*fields.length+3]=3;
  },
  snapshot(){
   const count=storage?Math.min(sequence,capacity):0,records=[];
   for(let i=sequence-count;i<sequence;i++)records.push(Array.from(storage.subarray((i%capacity)*fields.length,(i%capacity+1)*fields.length)));
   return {kind:'j19-numeric-memory-transitions-1',capacity,backingBytes:storage?.byteLength??0,maximumBackingBytes:capacity*fields.length*8,fields,phases:nativeMemoryPhases,realms:{1:'main-test',2:'writer',3:'browser-stand-in-native-worker'},records,dropped,faults,closed:!storage,nativeAllocationOwner:'unobserved',rssScope:'whole-process',heapScope:'record-threadId',relatedWorkerMemory:'unobserved unless a realm3 sample names that thread'};
  },
  close(){storage?.fill(0);storage=undefined;},
 });
}

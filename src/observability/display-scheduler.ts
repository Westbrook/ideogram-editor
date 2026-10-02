import {allocationLedger,type AllocationLease} from './allocations.js';

/** One shared admission queue for display responses. A slot belongs to the
 * complete fetch/read/decode lifetime, including cancellation cleanup. Its
 * fixed control allowance covers the scheduler's callback/queue bookkeeping;
 * raster bytes and captured caller payloads retain their separate owners. */
const SLOT_BYTES=512,DRAIN_BYTES=256;
type Waiting={signal?:AbortSignal;start:()=>void;abort:()=>void};
type Drain={promise:Promise<void>;resolve:()=>void;lease:AllocationLease};
const waiting:Waiting[]=[];let active=0,drain:Drain|undefined;
function settled(){if(active===0&&waiting.length===0&&drain){const current=drain;drain=undefined;current.lease.release();current.resolve();}}
function pump(){while(active<2&&waiting.length){const item=waiting.shift()!;item.signal?.removeEventListener('abort',item.abort);if(item.signal?.aborted){item.abort();continue;}active++;item.start();}settled();}
export function withDisplayRead<T>(signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>{
  if(signal?.aborted)return Promise.reject(new DOMException('Display read cancelled.','AbortError'));
  if(waiting.length>=256)return Promise.reject(Error('DISPLAY_QUEUE_CAPACITY'));
  let lease:AllocationLease;
  try{lease=allocationLedger.reserve({owner:'display-queue-slot',kind:'control',cpuBytes:SLOT_BYTES,handles:2});}
  catch(error){return Promise.reject(error);}
  return new Promise<T>((resolve,reject)=>{
    let live=true;
    const release=()=>{if(live){live=false;lease.release();}};
    const finish=(accept:()=>void)=>{release();active--;pump();accept();};
    const item:Waiting={signal,abort:()=>{if(!live)return;const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);release();reject(new DOMException('Display read cancelled.','AbortError'));settled();},start:()=>{void Promise.resolve().then(work).then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));}};
    try{signal?.addEventListener('abort',item.abort,{once:true});waiting.push(item);pump();}
    catch(error){signal?.removeEventListener('abort',item.abort);const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);release();reject(error);settled();}
  });
}
export function displayReadOwnership(){return Object.freeze({active,queued:waiting.length,limit:2});}
/** All callers share the same pending notification. There is no retained
 * per-caller resolver collection or growing set of uncharged drain handles. */
export function waitForDisplayReads():Promise<void>{
  if(!active&&!waiting.length)return Promise.resolve();if(drain)return drain.promise;
  let lease:AllocationLease;
  try{lease=allocationLedger.reserve({owner:'display-queue-drain',kind:'control',cpuBytes:DRAIN_BYTES,handles:1});}
  catch(error){return Promise.reject(error);}
  let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});drain={promise,resolve,lease};return promise;
}

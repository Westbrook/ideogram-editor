/** One shared admission queue for display responses. A slot belongs to the
 * complete fetch/read/decode lifetime, including cancellation cleanup. */
type Waiting={signal?:AbortSignal;start:()=>void;abort:()=>void};
const waiting:Waiting[]=[];const drains=new Set<()=>void>();let active=0;
function settled(){if(active===0&&waiting.length===0){for(const resolve of drains)resolve();drains.clear();}}
function pump(){while(active<2&&waiting.length){const item=waiting.shift()!;item.signal?.removeEventListener('abort',item.abort);if(item.signal?.aborted){item.abort();continue;}active++;item.start();}settled();}
export function withDisplayRead<T>(signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>{
  if(signal?.aborted)return Promise.reject(new DOMException('Display read cancelled.','AbortError'));
  if(waiting.length>=256)return Promise.reject(Error('DISPLAY_QUEUE_CAPACITY'));
  return new Promise<T>((resolve,reject)=>{
    const item:Waiting={signal,abort:()=>{const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);reject(new DOMException('Display read cancelled.','AbortError'));settled();},start:()=>{void Promise.resolve().then(work).then(value=>{active--;pump();resolve(value);},error=>{active--;pump();reject(error);});}};
    signal?.addEventListener('abort',item.abort,{once:true});waiting.push(item);pump();
  });
}
export function displayReadOwnership(){return Object.freeze({active,queued:waiting.length,limit:2});}
export function waitForDisplayReads():Promise<void>{if(!active&&!waiting.length)return Promise.resolve();return new Promise(resolve=>drains.add(resolve));}

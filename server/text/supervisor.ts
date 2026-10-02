import {Worker} from 'node:worker_threads';
import {AssetRejection} from '../storage/assets.js';
import {adapterResources} from '../observability/adapter-resources.js';
// Only the owning backend supplies module/deadline. They are not wire inputs.
// The promise settles on actual exit, so callers cannot refund on a message,
// timeout, cancel request, or a successful call to terminate alone.
export function runVerification(data:unknown,check:()=>void,module=new URL('./render-worker.mjs',import.meta.url),deadlineMs=20000){
 check();return new Promise<void>((resolve,reject)=>{
  const releaseUncovered=adapterResources.uncovered('text-verification-worker');let worker:Worker;
  try{worker=new Worker(module,{workerData:data,env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});}catch(error){releaseUncovered();throw error;}
  const releaseWorker=adapterResources.worker('text-verification',worker.threadId);
  let valid=false,error:unknown;const stop=(e:unknown)=>{error??=e;void worker.terminate().catch(f=>{error??=f;});};
  const deadline=setTimeout(()=>stop(new AssetRejection('CAPACITY','TEXT_VERIFICATION_DEADLINE')),deadlineMs);
  const polling=setInterval(()=>{try{check();}catch(e){stop(e);}},50);
  worker.on('message',m=>{try{check();if(m.type==='ready')worker.postMessage({type:'admit'});else if(m.type==='result'&&m.verified===true)valid=true;else stop(new AssetRejection('INVALID_INPUT',m.code??'TEXT_VERIFICATION_FAILED'));}catch(e){stop(e);}});
  worker.on('error',()=>stop(new AssetRejection('INVALID_INPUT','TEXT_VERIFICATION_FAILED')));
  worker.on('exit',code=>{clearTimeout(deadline);clearInterval(polling);releaseWorker();releaseUncovered();if(error)reject(error);else if(valid&&code===0)resolve();else reject(new AssetRejection('INVALID_INPUT','TEXT_VERIFICATION_FAILED'));});
 });
}

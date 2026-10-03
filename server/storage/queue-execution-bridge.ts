import type {QueueStore} from './queue.js';
import type {QueueJob} from '../../src/protocol/queue.js';
import type {AppliedPrivacyPolicy} from '../provider/contracts.js';
import {StoreError} from './errors.js';

type Admission=(job:QueueJob)=>boolean;
type Core={readonly root:string;readonly epoch:string;check():void;job(id:string):QueueJob;
 reserve(id:string,admit:Admission):ReturnType<QueueStore['reserve']>;
 dispatch(id:string,attempt:string,mapping:Record<string,string>,policy:AppliedPrivacyPolicy,admit:Admission):ReturnType<QueueStore['dispatch']>};
const queues=new WeakMap<QueueStore,Core>();
/** Internal live-object bridge, not a persisted capability or a public opener.
 * The normal launcher imports registration only. It never acquires a lease.
 * Arbitrary code in the trusted writer process is outside this boundary. */
export function registerQueueExecution(queue:QueueStore,core:Core):()=>void {
 if(queues.has(queue))throw new StoreError('STALE_EPOCH');queues.set(queue,core);
 return ()=>{if(queues.get(queue)===core)queues.delete(queue);};
}
export function acquireQueueExecution(queue:QueueStore,admit:Admission){
 const core=queues.get(queue);if(!core||typeof admit!=='function')throw new StoreError('STALE_EPOCH');
 const check=()=>{if(queues.get(queue)!==core)throw new StoreError('STALE_EPOCH');core.check();};
 const admitted:Admission=job=>{check();return admit(job);};check();
 return Object.freeze({root:core.root,epoch:core.epoch,check,job:(id:string)=>{check();return core.job(id);},
  reserve:(id:string)=>{check();return core.reserve(id,admitted);},
  dispatch:(id:string,attempt:string,mapping:Record<string,string>,policy:AppliedPrivacyPolicy)=>{check();return core.dispatch(id,attempt,mapping,policy,admitted);}});
}

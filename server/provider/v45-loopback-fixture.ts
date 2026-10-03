/** Explicit generation-only loopback fixture. Never imported by the normal
 * launcher, runtime configuration, HTTP router, UI or persisted queue replay. */
import type {QueueStore} from '../storage/queue.js';
import {Candidates} from '../storage/candidates.js';
import {acquireQueueExecution} from '../storage/queue-execution-bridge.js';
import {canonical,hashBytes} from '../storage/canonical.js';
import {StoreError} from '../storage/errors.js';
import type {QueueJob} from '../../src/protocol/queue.js';
import {verifyRequestReviewV45} from '../../src/request/review.js';
import {providerBoundary} from './client.js';
import {QueueDispatcher} from './dispatcher.js';
import {ResultObserver} from './observer.js';
import type {PrivacyProfile} from './policy.js';
import {ProviderError} from './contracts.js';

const SENTINEL='fixture-key-never-production-P21';
const PROFILE:PrivacyProfile=Object.freeze({id:'v45-durable-loopback-1',version:1,evidenceDigest:hashBytes('v45-durable-loopback-1').slice(7),endpoint:'ideogram/v4.5',mode:'fixture',
 enforcement:'observed',lifecycleSeconds:60,minimumCompatibleSeconds:60,acl:'fixture-private',supportedLifetimes:Object.freeze([60]),supportedACLs:Object.freeze(['fixture-private']),
 mostPrivateACL:'fixture-private',deferredFetch:'bounded',requiredLifetimeSeconds:60,renewalQualified:false});
type Selection=Readonly<{jobId:string;attemptId:string;reviewToken:string;origin:string}>;
type Lease=Readonly<{queue:QueueStore;root:string;epoch:string;jobId:string;attemptId:string;reviewToken:string;reviewHash:string;stagePlanHash:string;profileHash:string;boundary:ReturnType<typeof providerBoundary>}>;
const leases=new WeakMap<object,Lease>();
const refuse=():never=>{throw new ProviderError('IDENTITY');};
/** No wire/boundary/credential/clock/profile injection. The origin is the sole
 * network input and is confined to one canonical literal IPv4 loopback port. */
export function createV45LoopbackGeneration(queue:QueueStore,candidates:Candidates,selection:Selection){
 if(!selection||typeof selection!=='object'||Object.keys(selection).sort().join(',')!=='attemptId,jobId,origin,reviewToken')return refuse();
 const selected={...selection};if(Object.values(selected).some(value=>typeof value!=='string'))return refuse();
 let url:URL;try{url=new URL(selected.origin);}catch{return refuse();}
 if(url.origin!==selected.origin||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return refuse();
 if(!(candidates instanceof Candidates)||candidates.queue!==queue)return refuse();
 const token=Object.freeze({});let closed=false;
 const lease=()=>{const value=leases.get(token);if(closed||!value)throw new StoreError('STALE_EPOCH');return value;};
 const matches=(job:QueueJob):boolean=>{
  const value=lease();if(job.id!==value.jobId)return false;
  const attempt=job.attempts.at(-1);
  if(value.queue!==queue||value.root!==execution.root||value.epoch!==execution.epoch||value.boundary!==boundary||value.profileHash!==hashBytes(canonical(PROFILE))||
   !attempt||attempt.id!==value.attemptId||attempt.providerAuthorization!==undefined||job.review.token!==value.reviewToken||
   hashBytes(canonical(job.review))!==value.reviewHash||hashBytes(canonical(job.stagePlan))!==value.stagePlanHash)throw new StoreError('STALE_EPOCH');
  return true;
 };
 const execution=acquireQueueExecution(queue,matches),initial=execution.job(selected.jobId),attempt=initial.attempts.at(-1),review=initial.review;
 if(!attempt||attempt.id!==selected.attemptId||attempt.providerAuthorization!==undefined||review.token!==selected.reviewToken||review.kind!=='request-review-v45-1'||review.request.kind!=='generate-v45'||initial.stagePlan.length)return refuse();
 const prompt=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(queue.input(review.prompt));verifyRequestReviewV45(review,prompt);
 const model=review.request.modelRequest;
 if(model.body.quality!=='medium'||model.body.image_size!=='square_hd'||model.body.num_images!==1||model.body.sync_mode!==false)return refuse();
 const boundary=providerBoundary({mode:'fixture',queueOrigin:selected.origin,mediaOrigins:[selected.origin],profiles:[PROFILE],credential:{queueKey:()=>SENTINEL},
  connection:{mode:'fixture',fixtureOrigins:[selected.origin],resolve:async()=>[{address:'127.0.0.1',family:4}]}});
 leases.set(token,Object.freeze({queue,root:execution.root,epoch:execution.epoch,jobId:initial.id,attemptId:attempt.id,reviewToken:review.token,reviewHash:hashBytes(canonical(review)),stagePlanHash:hashBytes(canonical(initial.stagePlan)),profileHash:hashBytes(canonical(PROFILE)),boundary}));
 const current=()=>{execution.check();if(!matches(execution.job(selected.jobId)))throw new StoreError('STALE_EPOCH');};
 const permitted=(jobId:string,attemptId:string)=>{current();return jobId===selected.jobId&&attemptId===selected.attemptId;};
 const port=new Proxy(queue,{get(target,key){
  if(key==='reserve')return (id:string)=>{current();if(id!==selected.jobId)return refuse();return execution.reserve(id);};
  if(key==='dispatch')return (id:string,idAttempt:string,mapping:Record<string,string>,policy:Parameters<QueueStore['dispatch']>[3])=>{current();if(id!==selected.jobId||idAttempt!==selected.attemptId||Object.keys(mapping).length||canonical(policy)!==canonical(boundary.policy({attemptId:selected.attemptId,identity:{endpoint:'ideogram/v4.5'},profileId:PROFILE.id}).applied))return refuse();return execution.dispatch(id,idAttempt,mapping,policy);};
  const value=Reflect.get(target,key);
  if(key==='recoveryWork'||key==='controlWork')return ()=>{current();return value.call(target,permitted);};
  return typeof value==='function'?(...args:unknown[])=>{current();return value.apply(target,args);}:value;
 }});
 const candidatePort:Candidates=new Proxy(candidates,{get(target,key){if(key==='queue')return port;const value=Reflect.get(target,key);
  if(key==='due')return (now:number)=>{current();return target.due(now,permitted);};
  if(key==='retries')return ()=>{current();return target.retries(permitted);};
  return typeof value==='function'?(...args:unknown[])=>{current();return value.apply(candidatePort,args);}:value;
 }});
 const dispatcher=new QueueDispatcher(port,boundary,{profileId:PROFILE.id,queueOrigin:selected.origin,authorize:job=>{current();if(!matches(job)||job.disposition!=='eligible'||queue.deleted(job.documentId))refuse();}});
 const observer=new ResultObserver(candidatePort,boundary,dispatcher,PROFILE.id,[SENTINEL]);
 const pending=new Set<Promise<unknown>>();
 const run=<T>(work:()=>T|Promise<T>):Promise<T>=>{const promise=Promise.resolve().then(()=>{current();return work();});pending.add(promise);void promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;};
 return Object.freeze({submit:()=>run(()=>dispatcher.submit(selected.jobId)),tick:()=>run(()=>observer.tick()),
  readKnown:(action:'status'|'result'|'cancel')=>run(()=>dispatcher.readKnown(selected.jobId,selected.attemptId,action)),
  recoverRetained:()=>run(()=>dispatcher.recoverRetained(selected.jobId,selected.attemptId)),
  async close(){closed=true;leases.delete(token);dispatcher.close();observer.close();await Promise.allSettled([...pending]);}});
}

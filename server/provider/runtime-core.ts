import {randomUUID} from 'node:crypto';
import type {StoreDatabase} from '../storage/database.js';
import {AssetRejection} from '../storage/assets.js';
import type {QueueJob,Attempt} from '../../src/protocol/queue.js';
import type {ProviderAuthorization,ProviderAuthorizationBody,ProviderView} from '../../src/protocol/provider.js';
import type {ProviderRuntimeConfig} from './config.js';
import type {ProviderBoundary} from './client.js';
import {QueueDispatcher} from './dispatcher.js';
import {ResultObserver} from './observer.js';
import {PRODUCTION_PRIVACY,PRODUCTION_PROFILE,productionAcknowledgement} from './production-profile.js';
import {QUEUE_ORIGIN} from './policy.js';

const reject=(code:string):never=>{throw new AssetRejection('INVALID_INPUT',code);};
type Ports={provider?:ProviderBoundary;queueOrigin?:string;now?:()=>number;automatic?:boolean};
/** Internal scheduler engine. Fixtures inject a separate loopback boundary here;
 * the ordinary launcher can construct only runtime.ts's sealed production wrapper. */
export class ProviderExecution {
 private timer:ReturnType<typeof setInterval>|undefined;
 private pending:Promise<void>|undefined;
 private closed=false;
 private observer:ResultObserver|undefined;
 private dispatcher:QueueDispatcher|undefined;
 private message:string|null=null;
 private now:()=>number;
 private authorize:(job:QueueJob,attempt:Attempt,body:ProviderAuthorizationBody)=>ProviderAuthorization;
 constructor(private store:StoreDatabase,private config:ProviderRuntimeConfig={mode:'disabled'},ports:Ports={}){
  this.now=ports.now??Date.now;
  this.authorize=(job,attempt,body)=>this.approve(job,attempt,body);
  if(config.mode==='disabled')return;
  if(!ports.provider)return reject('PROVIDER_UNAVAILABLE');
  this.store.queue.authorizeProvider=this.authorize;
  const acknowledgement=(jobId:string,attemptId:string)=>{
   const job=this.job(jobId),attempt=job.attempts.find(a=>a.id===attemptId);
   if(!attempt||!this.permitted(job,attempt,false))return reject('PROVIDER_AUTHORIZATION_REQUIRED');
   return productionAcknowledgement(attempt.providerAuthorization!);
  };
  this.dispatcher=new QueueDispatcher(store.queue,ports.provider,{profileId:PRODUCTION_PROFILE.id,
   queueOrigin:ports.queueOrigin??QUEUE_ORIGIN,allowResultResponseSuffix:true,acknowledgement,
   authorize:(job)=>this.assertDispatch(job)});
  // Route selection only: the real queue/candidate methods retain their own
  // authorization, epoch, deletion and terminal-result fences.
  const permitted=(jobId:string,attemptId:string)=>{try{const job=this.job(jobId),a=job.attempts.find(a=>a.id===attemptId);return !!a&&this.permitted(job,a,false);}catch{return false;}};
  const queue=new Proxy(store.queue,{get(target,key){const value=Reflect.get(target,key);if(key==='recoveryWork'||key==='controlWork')return ()=>value.call(target,permitted);return typeof value==='function'?value.bind(target):value;}});
  const candidates=new Proxy(store.candidates,{get(target,key){if(key==='queue')return queue;const value=Reflect.get(target,key);if(key==='due')return (now:number)=>value.call(target,now,permitted);if(key==='retries')return ()=>value.call(target,permitted);return typeof value==='function'?value.bind(target):value;}});
  this.observer=new ResultObserver(candidates,ports.provider,this.dispatcher,PRODUCTION_PROFILE.id,[config.key],acknowledgement);
  if(ports.automatic!==false){this.timer=setInterval(()=>{void this.tick().catch(()=>{});},1000);this.timer.unref();}
 }
 private jobs(){const jobs:QueueJob[]=[];let cursor='';do{const page=this.store.queue.view(cursor);jobs.push(...page.jobs);cursor=page.nextCursor??'';}while(cursor);return jobs;}
 private job(id:string){const job=this.jobs().find(j=>j.id===id);if(!job)return reject('PROVIDER_JOB_UNAVAILABLE');return job;}
 private usage(exclude?:string){let usedRequests=0,usedImages=0;if(this.config.mode==='fal')for(const job of this.jobs())for(const a of job.attempts){const approval=a.providerAuthorization;if(a.id===exclude||!approval||approval.configurationId!==this.config.manifest.id||approval.configurationHash!==this.config.manifestHash||!['reserved','dispatched'].includes(a.count))continue;usedRequests++;usedImages+=job.review.request.settings.count;}return {usedRequests,usedImages};}
 private eligible(job:QueueJob){
  if(this.config.mode!=='fal'||this.closed)return reject('PROVIDER_UNAVAILABLE');
  const m=this.config.manifest,r=job.review.request;
  if(job.disposition!=='eligible'||this.store.queue.deleted(job.documentId))return reject('PROVIDER_JOB_INELIGIBLE');
  if(job.review.endpoint!==m.endpoint||r.kind!==m.operation||job.stagePlan.length||r.size.kind!=='custom'||r.size.width!==m.output.width||r.size.height!==m.output.height||r.settings.count!==m.output.count||r.settings.format!==m.output.format||r.settings.expansion!==m.expansion||r.settings.safetyChecker!==true||r.settings.syncMode!==false)return reject('PROVIDER_REQUEST_OUTSIDE_APPROVAL');
  return m;
 }
 private available(job:QueueJob,exclude?:string){const m=this.eligible(job);if(this.now()>=Date.parse(m.expiresAt))return reject('PROVIDER_AUTHORIZATION_EXPIRED');const used=this.usage(exclude);if(used.usedRequests>=m.maxRequests||used.usedImages+job.review.request.settings.count>m.maxImages)return reject('PROVIDER_AUTHORIZATION_LIMIT');return m;}
 private permitted(job:QueueJob,attempt:Attempt,currentEpoch:boolean){
  if(this.config.mode!=='fal')return false;const a=attempt.providerAuthorization,m=this.config.manifest;
  return !!a&&a.configurationId===m.id&&a.configurationHash===this.config.manifestHash&&(!currentEpoch||a.epoch===this.store.epoch)&&a.jobId===job.id&&a.attemptId===attempt.id&&a.reviewToken===job.review.token&&a.profileId===m.profileId&&a.profileVersion===m.profileVersion&&a.disclosureDigest===m.disclosureDigest;
 }
 private approve(job:QueueJob,attempt:Attempt,body:ProviderAuthorizationBody):ProviderAuthorization {
  const m=this.available(job,attempt.id);if(this.config.mode!=='fal')return reject('PROVIDER_UNAVAILABLE');
  if(body.configurationId!==m.id||body.configurationHash!==this.config.manifestHash||body.epoch!==this.store.epoch||body.profileId!==m.profileId||body.profileVersion!==m.profileVersion||body.disclosureDigest!==m.disclosureDigest||body.acknowledgeChargeAndPrivacy!==true||body.reviewToken!==job.review.token||body.jobId!==job.id||body.attemptId!==attempt.id)return reject('PROVIDER_APPROVAL_CHANGED');
  return {id:randomUUID(),configurationId:m.id,configurationHash:this.config.manifestHash,epoch:this.store.epoch,
   jobId:job.id,attemptId:attempt.id,reviewToken:job.review.token,profileId:m.profileId,profileVersion:m.profileVersion,
   disclosureDigest:m.disclosureDigest,authorizedAt:new Date(this.now()).toISOString()};
 }
 private assertDispatch(job:QueueJob){const attempt=job.attempts.at(-1)!;if(!this.permitted(job,attempt,true))return reject('PROVIDER_AUTHORIZATION_REQUIRED');this.available(job,attempt.id);}
 view():ProviderView {
  const base={protocolVersion:1 as const,epoch:this.store.epoch,operation:'generate' as const,endpoint:'ideogram/v4' as const};
  if(this.config.mode==='disabled')return {...base,mode:'disabled',ready:false,state:'disabled',configurationId:null,configurationHash:null,credentialConfigured:false,profile:null,limits:null,message:'Fal is disabled. Local request review and enqueue make no provider call. Configure a local approval manifest and private key file to enable deliberate dispatch.'};
  const m=this.config.manifest,used=this.usage(),expired=this.now()>=Date.parse(m.expiresAt),exhausted=used.usedRequests>=m.maxRequests||used.usedImages>=m.maxImages,state=this.closed?'unavailable':expired?'expired':exhausted?'limit-reached':'ready';
  return {...base,mode:'fal',ready:state==='ready',state,configurationId:m.id,configurationHash:this.config.manifestHash,
   credentialConfigured:true,profile:PRODUCTION_PRIVACY,limits:{maximumRequests:m.maxRequests,maximumImages:m.maxImages,...used,
    width:m.output.width,height:m.output.height,imagesPerRequest:1,format:'png',expansion:'None',expiresAt:m.expiresAt},
   message:this.message??(expired?'The submission approval expired. Existing explicitly authorized work can still be checked and retained.':exhausted?'The approved request or image limit is exhausted. Existing work remains retained.':'Fal Generate is configured. Each exact queued request requires a separate charge and privacy authorization before dispatch.')};
 }
 async tick(){
  if(this.closed||this.config.mode==='disabled')return;if(this.pending)return this.pending;
  const work=async()=>{
   for(const job of this.jobs()){
    if(this.closed)break;const attempt=job.attempts.at(-1)!;
    if(attempt.state!=='not-started'||!this.permitted(job,attempt,true))continue;
    try{this.assertDispatch(job);await this.dispatcher!.submit(job.id);}
    catch{this.message='A provider action was blocked or could not be completed. Inspect the durable request state; uncertain submissions are never automatically repeated.';}
   }
   if(!this.closed)try{await this.observer!.tick(this.now());}catch{this.message='Existing provider work could not be checked or retained. Inspect its durable state and retry retrieval deliberately; no submission was repeated.';}
  };
  this.pending=work().finally(()=>{this.pending=undefined;});return this.pending;
 }
 async close(){this.closed=true;clearInterval(this.timer);this.observer?.close();this.dispatcher?.close();if(this.store.queue.authorizeProvider===this.authorize)this.store.queue.authorizeProvider=undefined;await this.pending;}
}

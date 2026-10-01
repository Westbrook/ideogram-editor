import type {Candidates} from '../storage/candidates.js';
import type {ProviderBoundary} from './client.js';
import type {QueueDispatcher} from './dispatcher.js';
import type {PolicyAcknowledgement} from './policy.js';
import type {ResultFence} from '../../src/protocol/candidates.js';
import {StoreError} from '../storage/errors.js';
/** Backend-owned finite polling step. Replay/import never constructs this capability. */
export class ResultObserver {
 private active=false;private closed=false;private readonly controller=new AbortController();
 constructor(private candidates:Candidates,private provider:ProviderBoundary,private dispatcher:QueueDispatcher,private profileId:string,private secrets:readonly string[]=[],private acknowledgement?:(jobId:string,attemptId:string)=>PolicyAcknowledgement|undefined){}
 private current(f:ResultFence){const queue=this.candidates.queue,work=queue.recovery(f.jobId,f.attemptId);if(work.epoch!==f.epoch||work.attempt.requestId!==f.requestId)throw new StoreError('STALE_EPOCH');return work.attempt.recoveryRequired||queue.deleted(work.documentId)?null:queue.resultFence(f.jobId,f.attemptId);}
 private control(f:ResultFence,action:'status'|'cancel'){const queue=this.candidates.queue,work=queue.recovery(f.jobId,f.attemptId);if(work.epoch!==f.epoch||work.attempt.requestId!==f.requestId)throw new StoreError('STALE_EPOCH');if(work.attempt.recoveryRequired||action==='cancel'&&work.attempt.cancel!=='requested')return null;return queue.controlFence(f.jobId,f.attemptId,action);}
 async tick(now=Date.now(),background=false){
  if(this.active||this.closed)return;this.active=true;
  try{
   for(const work of this.candidates.queue.recoveryWork())this.dispatcher.recoverRetained(work.jobId,work.attemptId);
   for(const work of this.candidates.queue.controlWork()){
    if(this.closed)break;
    const latest=this.candidates.queue.recovery(work.jobId,work.attemptId);if(latest.attempt.recoveryRequired)continue;
    if(work.cancel&&latest.attempt.cancel==='requested'){const f=this.candidates.queue.controlFence(work.jobId,work.attemptId,'cancel');const r=await this.dispatcher.readKnown(work.jobId,work.attemptId,'cancel',this.controller.signal),current=this.control(f,'cancel');if(current)this.candidates.queue.cancelObserved(current,r.evidence.recordId,r.outcome==='complete'&&r.status!==null&&r.status>=200&&r.status<300);}
    if(work.deleted){const f=this.candidates.queue.controlFence(work.jobId,work.attemptId,'status'),r=await this.dispatcher.readKnown(work.jobId,work.attemptId,'status',this.controller.signal),current=this.control(f,'status');if(!current)continue;let status=null;try{if(r.outcome==='complete'&&r.status===200){const v=this.dispatcher.readControl(r.evidence.recordId);if(v.request_id===f.requestId&&typeof v.status==='string')status=v.status;}}catch{}this.candidates.queue.detachedObserved(current,r.evidence.recordId,status);}
   }
   for(const initial of this.candidates.due(now)){
   if(this.closed)break;
   if(!this.current(initial))continue;
   const receipt=await this.dispatcher.readKnown(initial.jobId,initial.attemptId,'status',this.controller.signal);
   if(this.closed)break;
   const current=this.current(initial);if(!current)continue;
   if(receipt.outcome!=='complete'||receipt.status!==200){const meta=this.candidates.queue.evidence.inspect(receipt.evidence.recordId);this.candidates.backoff(current,now,retryAfter(meta.headers['retry-after'],now),receipt.status===null);continue;}
   const observed=this.candidates.observe(current,receipt.evidence,now,background);
   if(observed.view.observation?.phase!=='completed')continue;
   const f=observed.fence,result=await this.dispatcher.readKnown(f.jobId,f.attemptId,'result',this.controller.signal);
   if(this.closed)break;
   const ready=this.current(f);if(!ready)continue;
   if(result.outcome!=='complete'||result.status!==200){this.candidates.backoff(ready,now);continue;}
   const endpoint=this.candidates.queue.recovery(f.jobId,f.attemptId).endpoint;
   const policy=this.provider.policy({attemptId:f.attemptId,identity:{endpoint,requestId:f.requestId},profileId:this.profileId,acknowledgement:this.acknowledgement?.(f.jobId,f.attemptId)}).applied;
   this.candidates.receive(ready,result.evidence,policy,this.secrets);
   for(const candidate of this.candidates.outputs(f.attemptId)){if(this.closed)break;const next=this.current(ready);if(!next)break;await this.candidates.transfer(next,String(candidate.id),this.provider,policy,this.controller.signal);}
  }
   for(const c of this.candidates.retries()){
    if(this.closed)break;const work=this.candidates.queue.recovery(c.jobId,c.attemptId);
    // A durable retry intent is not fresh recovery authority after reopening.
    if(work.attempt.recoveryRequired||this.candidates.queue.deleted(work.documentId))continue;
    const f=this.candidates.queue.resultFence(c.jobId,c.attemptId),endpoint=work.endpoint;
    const policy=this.provider.policy({attemptId:c.attemptId,identity:{endpoint,requestId:c.requestId},profileId:this.profileId,acknowledgement:this.acknowledgement?.(c.jobId,c.attemptId)}).applied;
    this.candidates.clearRetry(c.id);await this.candidates.transfer(f,c.id,this.provider,policy,this.controller.signal);
   }
  }finally{this.active=false;}
 }
 close(){this.closed=true;this.controller.abort();}
}

function retryAfter(value:string|undefined,now:number){if(!value)return 0;const seconds=Number(value),delta=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-now;return Number.isFinite(delta)?Math.max(0,delta):0;}

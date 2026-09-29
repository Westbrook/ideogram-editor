import type {Candidates} from '../storage/candidates.js';
import type {ProviderBoundary} from './client.js';
import type {QueueDispatcher} from './dispatcher.js';
/** Backend-owned finite polling step. Replay/import never constructs this capability. */
export class ResultObserver {
 private active=false;private closed=false;
 constructor(private candidates:Candidates,private provider:ProviderBoundary,private dispatcher:QueueDispatcher,private profileId:string,private secrets:readonly string[]=[]){}
 async tick(now=Date.now(),background=false){
  if(this.active||this.closed)return;this.active=true;
  try{
   for(const work of this.candidates.queue.recoveryWork())this.dispatcher.recoverRetained(work.jobId,work.attemptId);
   for(const work of this.candidates.queue.controlWork()){
    if(this.closed)break;
    if(work.cancel){const f=this.candidates.queue.controlFence(work.jobId,work.attemptId,'cancel');const r=await this.dispatcher.readKnown(work.jobId,work.attemptId,'cancel');this.candidates.queue.cancelObserved(f,r.evidence.recordId,r.outcome==='complete'&&r.status!==null&&r.status>=200&&r.status<300);}
    if(work.deleted){const f=this.candidates.queue.controlFence(work.jobId,work.attemptId,'status'),r=await this.dispatcher.readKnown(work.jobId,work.attemptId,'status');let status=null;try{const v=this.dispatcher.readControl(r.evidence.recordId);if(v.request_id===f.requestId)status=v.status;}catch{}this.candidates.queue.detachedObserved(f,r.evidence.recordId,status);}
   }
   for(const initial of this.candidates.due(now)){
   if(this.closed)break;
   const receipt=await this.dispatcher.readKnown(initial.jobId,initial.attemptId,'status');
   if(this.closed)break;
   if(receipt.outcome!=='complete'||receipt.status!==200){const meta=this.candidates.queue.evidence.inspect(receipt.evidence.recordId);this.candidates.backoff(initial,now,retryAfter(meta.headers['retry-after'],now),receipt.status===null);continue;}
   const observed=this.candidates.observe(initial,receipt.evidence,now,background);
   if(observed.view.observation?.phase!=='completed')continue;
   const f=observed.fence,result=await this.dispatcher.readKnown(f.jobId,f.attemptId,'result');
   if(this.closed)break;
   if(result.outcome!=='complete'||result.status!==200){this.candidates.backoff(f,now);continue;}
   const endpoint=this.candidates.queue.recovery(f.jobId,f.attemptId).endpoint;
   const policy=this.provider.policy({attemptId:f.attemptId,identity:{endpoint,requestId:f.requestId},profileId:this.profileId}).applied;
   this.candidates.receive(f,result.evidence,policy,this.secrets);
   for(const candidate of this.candidates.outputs(f.attemptId)){if(this.closed)break;await this.candidates.transfer(f,String(candidate.id),this.provider,policy);}
  }
   for(const c of this.candidates.retries()){
    if(this.closed)break;const f=this.candidates.queue.resultFence(c.jobId,c.attemptId),endpoint=this.candidates.queue.recovery(c.jobId,c.attemptId).endpoint;
    const policy=this.provider.policy({attemptId:c.attemptId,identity:{endpoint,requestId:c.requestId},profileId:this.profileId}).applied;
    this.candidates.clearRetry(c.id);await this.candidates.transfer(f,c.id,this.provider,policy);
   }
  }finally{this.active=false;}
 }
 close(){this.closed=true;}
}

function retryAfter(value:string|undefined,now:number){if(!value)return 0;const seconds=Number(value),delta=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-now;return Number.isFinite(delta)?Math.max(0,delta):0;}

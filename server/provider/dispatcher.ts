import type {QueueStore} from '../storage/queue.js';
import type {ProviderBoundary,ProviderAttempt} from './client.js';
import {validateQueueURL,exactURL} from './policy.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {ProviderError} from './contracts.js';
/** The normal launcher supplies no qualified profile. A fixture can inject its sealed loopback boundary.
 * No timer, automatic POST retry or startup submission exists in this adapter. */
export class QueueDispatcher {
 constructor(private queue:QueueStore,private provider:ProviderBoundary,private config:{profileId:string;queueOrigin:string;uploadURL?:string;mediaOrigin?:string}){}
 async submit(jobId:string){
  const first=this.queue.view();let job=first.jobs.find(j=>j.id===jobId);let cursor=first.nextCursor;
  while(!job&&cursor){const page=this.queue.view(cursor);job=page.jobs.find(j=>j.id===jobId);cursor=page.nextCursor;}
  if(!job)throw new ProviderError('IDENTITY');
  const latest=job.attempts.at(-1)!;if(latest.state!=='not-started')return null;
  const attempt:ProviderAttempt={attemptId:latest.id,identity:{endpoint:job.review.endpoint},profileId:this.config.profileId};
  // The policy gate runs before staging, credentials, reservation or outbound bytes.
  const policy=this.provider.policy(attempt).applied,reservation=this.queue.reserve(jobId);if(!reservation)return null;
  const mapping:Record<string,string>={};
  for(const item of job.stagePlan){
   if(!this.config.uploadURL||!this.config.mediaOrigin)throw new ProviderError('POLICY');
   const response=this.queue.sink(attempt.attemptId,'response',policy),request=this.queue.sink(attempt.attemptId,'request',policy);
   const receipt=await this.provider.upload(this.config.uploadURL,attempt,{bytes:this.queue.input(item.transport),evidence:request},response);
   if(receipt.outcome!=='complete'||receipt.status!==200)throw new ProviderError('INTERRUPTED');
   const value=this.readControl(receipt.evidence.recordId),url=exactURL(value.url);if(url.origin!==this.config.mediaOrigin)throw new ProviderError('POLICY');mapping[item.role]=url.href;
  }
  const dispatch=this.queue.dispatch(jobId,attempt.attemptId,mapping,policy);if(!dispatch)return null;
  try{
   const response=this.queue.sink(attempt.attemptId,'response',policy),request=this.queue.sink(attempt.attemptId,'request',policy);
   const receipt=await this.provider.queue(attempt,'submit',response,{bytes:dispatch.bytes,evidence:request});
   if(receipt.outcome!=='complete'||receipt.status===null||receipt.status<200||receipt.status>=300)throw new ProviderError('INTERRUPTED');
   const value=this.readControl(receipt.evidence.recordId),identity={endpoint:attempt.identity.endpoint,requestId:value.request_id};
   const urls={status:validateQueueURL(value.status_url,identity,'status',this.config.queueOrigin).href,result:validateQueueURL(value.response_url,identity,'result',this.config.queueOrigin).href,cancel:validateQueueURL(value.cancel_url,identity,'cancel',this.config.queueOrigin).href};
   return this.queue.outcome(jobId,attempt.attemptId,dispatch.epoch,{kind:'ack',requestId:value.request_id,urls,responseRecord:receipt.evidence.recordId});
  }catch(error){
   // Storage failure may also prevent this update. Durable dispatching is sufficient for restart uncertainty.
   this.queue.outcome(jobId,attempt.attemptId,dispatch.epoch,{kind:'uncertain',reason:'Submission or acknowledgment persistence is uncertain; do not automatically retry.'});throw error;
  }
 }
 readControl(id:string){const meta=this.queue.evidence.inspect(id);if(meta.completeness!=='complete'||BigInt(meta.retainedBytes)>65536n)throw new ProviderError('PROVENANCE');return parseControlJSON(Buffer.concat([...this.queue.evidence.read(id)])) as any;}
 recoverRetained(jobId:string,attemptId:string){
  const current=this.queue.recovery(jobId,attemptId);if(current.attempt.requestId||!current.attempt.recoveryRequested||current.attempt.recoveryRequired)return;
  const matches: {record:string;requestId:string;urls:{status:string;result:string;cancel:string}}[]=[];
  try{for(const record of this.queue.evidence.records(attemptId)){
   try{const value=this.readControl(record),identity={endpoint:current.endpoint,requestId:value.request_id};
    const urls={status:validateQueueURL(value.status_url,identity,'status',this.config.queueOrigin).href,result:validateQueueURL(value.response_url,identity,'result',this.config.queueOrigin).href,cancel:validateQueueURL(value.cancel_url,identity,'cancel',this.config.queueOrigin).href};matches.push({record,requestId:value.request_id,urls});
   }catch{}
  }}catch{this.queue.recoveryInspected(jobId,attemptId,'Retained evidence could not be verified. Submission remains uncertain.');return;}
  const identities=new Set(matches.map(m=>JSON.stringify([m.requestId,m.urls])));
  if(identities.size!==1){this.queue.recoveryInspected(jobId,attemptId,identities.size?'Conflicting retained acknowledgements require reconciliation.':'No validated acknowledgement found. Submission remains uncertain; do not automatically retry.');return;}
  const m=matches[0]!;this.queue.outcome(jobId,attemptId,current.epoch,{kind:'ack',requestId:m.requestId,urls:m.urls,responseRecord:m.record});
 }
 async readKnown(jobId:string,attemptId:string,action:'status'|'result'|'cancel'){
  this.queue.controlFence(jobId,attemptId,action);
  const current=this.queue.recovery(jobId,attemptId);if(!current.attempt.requestId||!current.outbox.urls)throw new ProviderError('IDENTITY');
  const attempt={attemptId,identity:{endpoint:current.endpoint,requestId:current.attempt.requestId},profileId:this.config.profileId},policy=this.provider.policy(attempt).applied;
  const receipt=await this.provider.queue(attempt,action,this.queue.sink(attemptId,'response',policy),undefined,current.outbox.urls[action]);
  // Read/cancel/fetch preserves counts and holds. Cancellation reconciliation and candidate import belong to later slices.
  return receipt;
 }
}

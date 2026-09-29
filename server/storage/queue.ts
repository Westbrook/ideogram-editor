import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {DatabaseSync} from 'node:sqlite';
import type {BlobRef,Receipt} from '../../src/protocol/store.js';
import type {QueueBody,QueueFact,QueueJob,SpendSession,Attempt,QueueView,StageItem} from '../../src/protocol/queue.js';
import {isQueueCommand} from '../../src/protocol/queue.js';
import type {RequestReview} from '../../src/request/review.js';
import {refs,RequestError} from '../../src/request/core.js';
import type {Assets,AssetAuth} from './assets.js';
import {AssetRejection} from './assets.js';
import type {Objects,Barrier} from './objects.js';
import type {UIStore} from './ui.js';
import type {Rasters} from './raster.js';
import type {ImageState} from '../../src/protocol/history.js';
import {canonical,hashBytes,parseCommand,isId} from './canonical.js';
import {StoreError} from './errors.js';
import {RequestReviews,readRequestBytes} from './request-review.js';
import {TransportEvidenceStore,r31Reservation} from '../provider/evidence.js';
import type {AppliedPrivacyPolicy} from '../provider/contracts.js';

type Outbox={state:'safe-unstarted'|'dispatching'|'acknowledged'|'uncertain'|'cancelled'|'terminal';epoch:string|null;endpoint:string;mapping:Record<string,string>;bodyRecord:string|null;payloadHash:string|null;requestId:string|null;urls:{status:string;result:string;cancel:string}|null;responseRecord:string|null};
export class QueueStore {
 readonly evidence:TransportEvidenceStore;
 private preparing=new Map<string,{hash:string;promise:Promise<Receipt>}>();
 constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private ui:UIStore,private rasters:Rasters,
  private state:(id:string)=>ImageState,private check:()=>void,private epoch:string,private barrier:Barrier,root:string,
  private commit:(bytes:Uint8Array,build:()=>QueueFact)=>Receipt,private register:(owner:string,ref:BlobRef,proof?:string)=>void){
  this.evidence=new TransportEvidenceStore(root);
  // Replay the durable queue journal only. This cannot execute transport or create attempts.
  this.db.exec('BEGIN IMMEDIATE');try{
   this.db.exec('DELETE FROM queue_jobs; DELETE FROM spend_sessions');
   for(const row of this.db.prepare('SELECT json FROM queue_journal ORDER BY seq').iterate()){
    const record=JSON.parse(String(row.json));this.project(record.family,record.value);
   }
   if(!this.db.prepare('SELECT 1 FROM spend_sessions LIMIT 1').get())this.record('session',this.newSession(null,null),'SpendSessionInitialized');
   for(const job of this.all())for(const attempt of job.attempts)if(attempt.state==='dispatching'){
    attempt.state='submission-uncertain';attempt.uncertainReason='Restart after durable dispatch fence; bytes or acknowledgment may be missing.';attempt.version=String(BigInt(attempt.version)+1n);job.version=String(BigInt(job.version)+1n);
    const out=this.outbox(attempt.id);out.state='uncertain';this.writeOutbox(attempt.id,job.id,out);this.record('job',job,'SubmissionUncertain');
   }
   this.db.exec('COMMIT');
  }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
 }
 private project(family:'job'|'session',value:QueueJob|SpendSession){this.db.prepare(`INSERT INTO ${family==='job'?'queue_jobs':'spend_sessions'} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(value.id,canonical(value));}
 private record(family:'job'|'session',value:QueueJob|SpendSession,event:string){this.db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family,event,epoch:this.epoch,at:new Date().toISOString(),value}));this.project(family,value);}
 private all():QueueJob[]{return this.db.prepare('SELECT json FROM queue_jobs ORDER BY id').all().map(r=>JSON.parse(String(r.json)));}
 private job(id:string):QueueJob{const row=this.db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(id);if(!row)throw new AssetRejection('INVALID_INPUT','JOB_UNAVAILABLE');return JSON.parse(String(row.json));}
 private newSession(previousSessionId:string|null,cap:number|null):SpendSession{return {id:randomUUID(),version:'1',cap,previousSessionId,createdAt:new Date().toISOString()};}
 private session():SpendSession{const row=this.db.prepare('SELECT json FROM spend_sessions ORDER BY rowid DESC LIMIT 1').get()!;return JSON.parse(String(row.json));}
 private assertCapacity(){if(this.all().filter(j=>j.local!=='locally-cancelled'&&j.attempts.some(a=>a.state==='not-started')).length>=1000)throw new AssetRejection('CAPACITY','LOCAL_QUEUE_CEILING');}
 private attempts(){return this.all().flatMap(j=>j.attempts);}
 view(after=''):QueueView{
  this.check();if(after&&!isId(after))throw new StoreError('MALFORMED_REQUEST');const session=this.session(),attempts=this.attempts(),current=attempts.filter(a=>a.spendSessionId===session.id),reserved=current.filter(a=>a.count==='reserved').length,dispatched=current.filter(a=>a.count==='dispatched').length;
  const jobs=this.all().filter(j=>j.id>after),items=jobs.slice(0,20);
  return {protocolVersion:1,session,jobs:items,nextCursor:jobs.length>20?items.at(-1)!.id:null,counts:{reserved,dispatched,remaining:session.cap===null?null:Math.max(0,session.cap-reserved-dispatched),active:attempts.filter(a=>a.hold).length},limits:{active:1,target:100,maximum:1000},production:'denied'};
 }
 private attempt(review:RequestReview,previousAttemptId:string|null=null):Attempt{return {id:randomUUID(),previousAttemptId,version:'1',state:'not-started',hold:false,override:false,spendSessionId:null,count:'none',writerEpoch:null,payloadHash:null,requestId:null,terminal:null,uncertainReason:null,actualCharge:null,estimate:review.estimate};}
 private outbox(id:string):Outbox{const row=this.db.prepare('SELECT json FROM queue_outbox WHERE attempt_id=?').get(id);if(!row)throw new StoreError('CORRUPT_STORE');return JSON.parse(String(row.json));}
 private writeOutbox(id:string,jobId:string,out:Outbox){this.db.prepare('INSERT INTO queue_outbox VALUES (?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET json=excluded.json').run(id,jobId,canonical(out));}
 private initialOutbox(attempt:Attempt,job:QueueJob){this.writeOutbox(attempt.id,job.id,{state:'safe-unstarted',epoch:null,endpoint:job.review.endpoint,mapping:{},bodyRecord:null,payloadHash:null,requestId:null,urls:null,responseRecord:null});}
 private fact(value:QueueJob|SpendSession,type:QueueFact['type']):QueueFact{const state=this.objects.putMetadata(Buffer.from(canonical(value)));this.register('queue:'+value.id+':'+value.version,state);return {type,payload:{id:value.id,version:value.version,state}};}
 private review(body:Extract<QueueBody,{type:'QueueInference'}>,auth:AssetAuth){
  const binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);if(auth.now>=auth.expires||!binding||binding.client_id!==auth.clientId||auth.now>=Number(binding.expires))throw new AssetRejection('STALE_REVISION','REVIEW_SESSION_EXPIRED');
  const row=this.db.prepare('SELECT json FROM ui_receipts WHERE client_id=? AND id=?').get(auth.clientId,body.acceptanceId),receipt=row?JSON.parse(String(row.json)):null;
  const review:RequestReview|undefined=receipt?.status==='accepted'&&receipt.acceptedReview===body.reviewId?receipt.review:undefined;
  if(!review||review.token!==body.token)throw new AssetRejection('STALE_REVISION','ACCEPTED_REVIEW_REQUIRED');
  const saved=this.ui.read(review.draft.sessionId,auth).drafts.find(d=>d.id===review.draft.draftId);if(!saved||saved.status!=='saved-unapplied')throw new AssetRejection('STALE_REVISION','DRAFT_CHANGED');
  const reviews=new RequestReviews(this.db,this.objects,this.assets,this.state);try{reviews.assert(review,saved,auth);}catch(e){if(e instanceof RequestError)throw new AssetRejection('STALE_REVISION',e.issues.map(i=>i.code).join('_'));throw e;}
  return {review,draft:reviews.draft(saved)};
 }
 command(bytes:Uint8Array,auth:AssetAuth):Promise<Receipt>{
  const request=parseCommand(bytes),c=request.command;if(!isQueueCommand(c.body.type))throw new StoreError('UNSUPPORTED_COMMAND');
  // Duplicate delivery returns the original receipt before checking current authority/dependencies.
  if(c.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
  const hash=hashBytes(canonical(request)),old=this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);
  if(old){if(old.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return Promise.resolve(JSON.parse(String(old.receipt)));}
  const pending=this.preparing.get(c.commandId);if(pending){if(pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return pending.promise;}
  const promise=this.prepare(bytes,auth).finally(()=>this.preparing.delete(c.commandId));this.preparing.set(c.commandId,{hash,promise});return promise;
 }
 private async prepare(bytes:Uint8Array,auth:AssetAuth):Promise<Receipt>{
  const started=performance.now(),currentAuth=()=>({...auth,now:auth.now+Math.floor(performance.now()-started)});
  const c=parseCommand(bytes).command,b=c.body as QueueBody,slot='queue:'+c.commandId,proofs:{ref:BlobRef;token:string}[]=[],stagePlan:StageItem[]=[];
  let prepared:ReturnType<QueueStore['review']>|undefined,failure:AssetRejection|undefined;this.objects.acquire(slot);
  try{
   if(b.type==='QueueInference')try{
    prepared=this.review(b,auth);
    for(const ref of [prepared.review.template,...refs(prepared.draft)])proofs.push({ref,token:await this.objects.prove(ref,this.check)});
    const r=prepared.review.request;
    for(const role of ['source','mask'] as const){if(!(role in r))continue;const source=(r as any)[role] as {assetId:string;blob:BlobRef;width:number;height:number};
     const size=r.size.kind==='custom'?r.size:{width:source.width,height:source.height};
     let transport=source.blob;
     if(size.width!==source.width||size.height!==source.height){
      const result=await this.rasters.prepareDocument(role==='mask'?{type:'RequestMaskResize',assetId:source.assetId,width:size.width,height:size.height}:{type:'ComposeRaster',width:size.width,height:size.height,layers:[{assetId:source.assetId,transform:[size.width/source.width,0,0,size.height/source.height,0,0],opacity:1,mask:null}]},randomUUID(),slot,this.check);
      proofs.push(...result.proofs);transport=result.asset.blob;
     }
     stagePlan.push({role,original:source.blob,transport,width:size.width,height:size.height,conversion:prepared.review.conversion});
    }
   }catch(e){if(e instanceof AssetRejection)failure=e;else if(e instanceof StoreError&&['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code))failure=new AssetRejection('MISSING_ASSET',e.code);else throw e;}
   return this.commit(bytes,()=>{
    this.check();if(failure)throw failure;
    if(b.type==='QueueInference'){
     const fresh=this.review(b,currentAuth());if(!prepared||canonical(fresh.review)!==canonical(prepared.review))throw new AssetRejection('STALE_REVISION','REVIEW_CHANGED');
     this.assertCapacity();
     const registered=new Set<string>();for(const p of proofs){this.objects.proven(p.ref,p.token);if(!registered.has(p.ref.hash)){this.register('queue-input:'+c.commandId,p.ref,p.token);registered.add(p.ref.hash);}}
     const review=fresh.review,job:QueueJob={id:randomUUID(),version:'1',documentId:review.documentId,review,stagePlan,local:'accepted-local-queue',resultImport:'none',disposition:'eligible',attempts:[this.attempt(review)]};
     this.initialOutbox(job.attempts[0],job);this.record('job',job,'JobQueued');this.barrier('queue-accept-before-fact');return this.fact(job,'JobQueued');
    }
    if(b.type==='SetSpendGuard'||b.type==='StartSpendSession'){
     const current=this.session();let next:SpendSession;
     if(b.type==='SetSpendGuard'){if(current.id!==b.spendSessionId||current.version!==b.expectedConfigVersion)throw new AssetRejection('STALE_REVISION','SPEND_CONFIG_CHANGED');next={...current,cap:b.cap,version:String(BigInt(current.version)+1n)};}
     else{if(b.previousSessionId!==current.id)throw new AssetRejection('STALE_REVISION','SPEND_SESSION_CHANGED');if(this.attempts().some(a=>a.hold||a.state==='submission-uncertain')&&!b.acknowledgeUnresolvedAttempts)throw new AssetRejection('INVALID_INPUT','ACKNOWLEDGE_UNRESOLVED_CHARGES');next=this.newSession(current.id,b.cap);}
     const event=b.type==='SetSpendGuard'?'SpendGuardChanged':'SpendSessionStarted';this.record('session',next,event);
     // A config change makes local work eligible; it never clears old counters or remote holds.
     for(const job of this.all())if(job.local==='paused-spend-cap'){job.local='accepted-local-queue';job.version=String(BigInt(job.version)+1n);this.record('job',job,event);}
     return this.fact(next,event);
    }
    const job=this.job(b.jobId);if(job.version!==b.expectedVersion)throw new AssetRejection('STALE_REVISION','JOB_CHANGED');
    if(b.type==='CancelUnstartedJob'){
     const a=job.attempts.at(-1)!;if(a.state!=='not-started')throw new AssetRejection('INCOMPATIBLE','DISPATCH_MAY_HAVE_STARTED');a.state='locally-cancelled';a.hold=false;a.count=a.count==='reserved'?'released':a.count;a.version=String(BigInt(a.version)+1n);job.local='locally-cancelled';job.disposition='set-aside';const out=this.outbox(a.id);out.state='cancelled';this.writeOutbox(a.id,job.id,out);
    }else{
     const a=job.attempts.find(a=>a.id===b.attemptId);if(!a||a.state!=='submission-uncertain')throw new AssetRejection('INCOMPATIBLE','UNCERTAIN_ATTEMPT_REQUIRED');
     if(b.type==='OverrideUncertainHold'){a.hold=false;a.override=true;a.version=String(BigInt(a.version)+1n);}
     else{if(a.hold||job.attempts.at(-1)!.state==='not-started')throw new AssetRejection('INCOMPATIBLE','REVIEW_OVERLAPPING_WORK_FIRST');this.assertCapacity();const next=this.attempt(job.review,a.id);job.attempts.push(next);job.local='accepted-local-queue';this.initialOutbox(next,job);}
    }
    job.version=String(BigInt(job.version)+1n);this.record('job',job,b.type);return this.fact(job,'QueueStateChanged');
   });
  }finally{for(const p of proofs)this.objects.releaseProof(p.token);this.objects.unreserve(slot);this.objects.release(slot);}
 }
 // Internal scheduler capability, never a browser route. All transitions use the sole writer.
 input(ref:BlobRef){return readRequestBytes(this.objects,ref,104857600);}
 sink(attemptId:string,direction:'request'|'response',policy:AppliedPrivacyPolicy){return this.evidence.begin(attemptId,direction,r31Reservation(this.objects,'queue-wire:'+randomUUID(),direction==='request'?'provider-request':'provider-response',this.check),policy);}
 private transaction<T>(fn:()=>T):T{this.check();this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.check();this.db.exec('COMMIT');return result;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
 reserve(jobId:string){return this.transaction(()=>{
  const job=this.job(jobId),a=job.attempts.at(-1)!;if(a.state!=='not-started'||job.local==='locally-cancelled')return null;
  if(a.count==='reserved')return {job,attempt:a};
  const session=this.session(),attempts=this.attempts();if(attempts.some(a=>a.hold))return null;
  const used=attempts.filter(a=>a.spendSessionId===session.id&&['reserved','dispatched'].includes(a.count)).length;
  if(session.cap!==null&&used>=session.cap){job.local='paused-spend-cap';job.version=String(BigInt(job.version)+1n);this.record('job',job,'PausedSpendCap');return null;}
  a.count='reserved';a.spendSessionId=session.id;a.hold=true;a.writerEpoch=this.epoch;a.version=String(BigInt(a.version)+1n);job.local='ready-to-dispatch';job.version=String(BigInt(job.version)+1n);this.record('job',job,'AttemptReserved');return {job,attempt:a};
 });}
 dispatch(jobId:string,attemptId:string,mapping:Record<string,string>,policy:AppliedPrivacyPolicy){
  // Materialize exact body once before the fence, preserving exact integer seed tokens.
  this.check();const job=this.job(jobId),a=job.attempts.find(a=>a.id===attemptId);if(!a||a.state!=='not-started'||a.count!=='reserved'||!a.hold)throw new StoreError('STALE_EPOCH');
  let text=new TextDecoder('utf-8',{fatal:true}).decode(readRequestBytes(this.objects,job.review.template));
  if(Object.keys(mapping).length!==job.stagePlan.length)throw new StoreError('MALFORMED_REQUEST');
  for(const item of job.stagePlan){this.objects.verify(item.transport);const url=mapping[item.role];if(typeof url!=='string'||url.length>8192)throw new StoreError('MALFORMED_REQUEST');const key=item.role==='source'?'image_url':'mask_url',token=JSON.stringify(key)+':'+JSON.stringify('asset:'+item.original.hash);if(text.split(token).length!==2)throw new StoreError('CORRUPT_OBJECT');text=text.replace(token,JSON.stringify(key)+':'+JSON.stringify(url));}
  const bytes=Buffer.from(text),payloadHash=hashBytes(bytes),sink=this.evidence.begin(a.id,'request',r31Reservation(this.objects,'queue-body:'+a.id,'provider-request',this.check),policy);
  let body;try{for(let i=0;i<bytes.length;i+=1048576)sink.append(bytes.subarray(i,i+1048576));body=sink.finish(true);}catch(e){sink.finish(false);throw e;}
  this.barrier('queue-before-dispatch-fence');
  const result=this.transaction(()=>{
   const current=this.job(jobId),attempt=current.attempts.find(a=>a.id===attemptId)!;
   if(attempt.state!=='not-started'||attempt.count!=='reserved'||!attempt.hold||this.attempts().some(a=>a.id!==attemptId&&a.hold))throw new StoreError('STALE_EPOCH');
   const session=this.session(),used=this.attempts().filter(a=>a.id!==attemptId&&a.spendSessionId===session.id&&['reserved','dispatched'].includes(a.count)).length;
   if(session.cap!==null&&used>=session.cap){attempt.count='released';attempt.hold=false;attempt.version=String(BigInt(attempt.version)+1n);current.local='paused-spend-cap';current.version=String(BigInt(current.version)+1n);this.record('job',current,'PausedSpendCap');return null;}
   attempt.spendSessionId=session.id;
   attempt.state='dispatching';attempt.count='dispatched';attempt.writerEpoch=this.epoch;attempt.payloadHash=payloadHash;attempt.version=String(BigInt(attempt.version)+1n);current.version=String(BigInt(current.version)+1n);
   const out=this.outbox(attempt.id);Object.assign(out,{state:'dispatching',epoch:this.epoch,mapping,bodyRecord:body.recordId,payloadHash});this.writeOutbox(attempt.id,jobId,out);this.record('job',current,'AttemptDispatching');this.barrier('queue-dispatch-before-commit');return {jobId,attemptId,epoch:this.epoch,endpoint:current.review.endpoint,payloadHash,bodyRecord:body.recordId,bytes};
  });this.barrier('queue-dispatch-after-commit');return result;
 }
 outcome(jobId:string,attemptId:string,epoch:string,outcome:{kind:'uncertain';reason:string}|{kind:'ack';requestId:string;urls:NonNullable<Outbox['urls']>;responseRecord:string}|{kind:'terminal';status:string}){
  return this.transaction(()=>{if(epoch!==this.epoch)throw new StoreError('STALE_EPOCH');const job=this.job(jobId),a=job.attempts.find(a=>a.id===attemptId);if(!a||!['dispatching','submission-uncertain','acknowledged'].includes(a.state))throw new StoreError('STALE_EPOCH');const out=this.outbox(attemptId);
   if(outcome.kind==='ack'){if(a.requestId&&a.requestId!==outcome.requestId)throw new StoreError('MALFORMED_REQUEST');a.requestId=outcome.requestId;a.state='acknowledged';a.uncertainReason=null;Object.assign(out,{state:'acknowledged',requestId:outcome.requestId,urls:outcome.urls,responseRecord:outcome.responseRecord});}
   else if(outcome.kind==='terminal'){if(!a.requestId)throw new StoreError('MALFORMED_REQUEST');a.state='provider-terminal';a.terminal=outcome.status;a.hold=false;out.state='terminal';}
   else{a.state='submission-uncertain';a.uncertainReason=outcome.reason;out.state='uncertain';}
   a.version=String(BigInt(a.version)+1n);job.version=String(BigInt(job.version)+1n);this.writeOutbox(a.id,job.id,out);this.record('job',job,outcome.kind==='ack'?'AttemptAcknowledged':outcome.kind==='terminal'?'ProviderTerminal':'SubmissionUncertain');this.barrier('queue-outcome-before-commit');return job;
  });
 }
 recovery(jobId:string,attemptId:string){this.check();const job=this.job(jobId),attempt=job.attempts.find(a=>a.id===attemptId);if(!attempt)throw new StoreError('NOT_FOUND');return {jobId,attempt,endpoint:job.review.endpoint,outbox:this.outbox(attemptId),epoch:this.epoch};}
 async close(){await Promise.allSettled([...this.preparing.values()].map(p=>p.promise));}
}

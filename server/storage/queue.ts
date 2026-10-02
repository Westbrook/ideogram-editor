import {localQueuePhases,serverPhases} from '../observability/phases.js';
import {adapterResources} from '../observability/adapter-resources.js';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {DatabaseSync} from 'node:sqlite';
import type {BlobRef,Receipt} from '../../src/protocol/store.js';
import type {QueueBody,QueueFact,QueueJob,SpendSession,Attempt,QueueView,StageItem,QueueWaiting} from '../../src/protocol/queue.js';
import {isQueueCommand,queueModelAdmission} from '../../src/protocol/queue.js';
import type {RequestReview} from '../../src/request/review.js';
import {requireRequestMaskPlan} from '../../src/request/core.js';
import {refs,adapters,isV45Request,validateV45Request,RequestError} from '../../src/request/family.js';
import type {Assets,AssetAuth} from './assets.js';
import {AssetRejection} from './assets.js';
import type {Objects,Barrier} from './objects.js';
import type {UIStore} from './ui.js';
import type {Rasters} from './raster.js';
import type {ImageState} from '../../src/protocol/history.js';
import {canonical,hashBytes,parseCommand,isId} from './canonical.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {StoreError} from './errors.js';
import {RequestReviews,readRequestBytes} from './request-review.js';
import {compositionTextOriginRefs} from './composition-text.js';
import {TransportEvidenceStore,r31Reservation} from '../provider/evidence.js';
import type {AppliedPrivacyPolicy} from '../provider/contracts.js';
import type {ProviderAuthorization,ProviderAuthorizationBody} from '../../src/protocol/provider.js';
import {adapterReferences} from './adapters.js';
import {materializeTransportTemplate} from './queue-transport.js';
import {requestRasterGrid} from '../../src/request/raster-plan.js';
import {requestPreparedStages} from '../../src/request/v45-stages.js';

// Three bounded job copies, raw/canonical command, event, receipt and index/page overhead.
// Objects adds its usual 25% headroom; the emergency receipt allowance is separate.
export const QUEUE_ADMISSION_BYTES=524288n;
/** Backend-only references to finalized transport records. These are observations,
 * not eligibility grants; consumers must revalidate metadata and body identities. */
export type RuntimeWireRef={recordId:string;bodyHash:string;metadataHash:string};
type RuntimeWireRole='submit'|'status'|'result'|'upload'|'media'|'cancel';
export type RuntimeUploadEvidence={stage:StageItem;url:string;request:RuntimeWireRef;response:RuntimeWireRef};
type RuntimeDispatchBinding={reviewToken:string;stagePlanHash:string;mappingHash:string;payloadHash:string};
export type QueueWireEvidence={kind:'queue-wire-evidence-1';uploads:RuntimeUploadEvidence[];dispatch:RuntimeDispatchBinding|null;submission:(RuntimeDispatchBinding&{body:RuntimeWireRef;response:RuntimeWireRef})|null;conflicted:boolean};
type Outbox={state:'safe-unstarted'|'dispatching'|'acknowledged'|'uncertain'|'cancelled'|'terminal';epoch:string|null;endpoint:string;mapping:Record<string,string>;bodyRecord:string|null;payloadHash:string|null;requestId:string|null;urls:{status:string;result:string;cancel:string}|null;responseRecord:string|null;wireEvidence?:QueueWireEvidence};
export class QueueStore {
 private inputStreams=0;
 resourceOwnership(){return {preparing:this.preparing.size,inputStreams:this.inputStreams,inputStreamsObserved:true,transportEvidenceObserved:false};}
 readonly evidence:TransportEvidenceStore;
 onDocumentDeleted:((documentId:string)=>void)|undefined;
 deletionCommand:((bytes:Uint8Array,auth:AssetAuth)=>Receipt)|undefined;
 candidateAction:((body:import('../../src/protocol/candidates.js').CandidateBody,slot:string)=>QueueFact)|undefined;
 authorizeProvider:((job:QueueJob,attempt:Attempt,body:ProviderAuthorizationBody)=>ProviderAuthorization)|undefined;
 private preparing=new Map<string,{hash:string;promise:Promise<Receipt>}>();
 constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private ui:UIStore,private rasters:Rasters,
  private state:(id:string)=>ImageState,private check:()=>void,private epoch:string,private barrier:Barrier,root:string,
  private commit:(bytes:Uint8Array,build:()=>QueueFact,slot:string,onDurable?:()=>void)=>Receipt,private register:(owner:string,ref:BlobRef,proof?:string)=>void){
  this.evidence=new TransportEvidenceStore(root);
  // Replay the durable queue journal only. This cannot execute transport or create attempts.
  this.db.exec('BEGIN IMMEDIATE');try{
   this.db.exec('DELETE FROM queue_jobs; DELETE FROM spend_sessions');
   for(const row of this.db.prepare('SELECT json FROM queue_journal ORDER BY seq').iterate()){
    const record=JSON.parse(String(row.json));this.project(record.family,record.value);
   }
   this.initializeOrder();
   if(!this.db.prepare('SELECT 1 FROM spend_sessions LIMIT 1').get())this.record('session',this.newSession(null,null),'SpendSessionInitialized');
   for(const job of this.jobs())for(const attempt of job.attempts)if(attempt.state==='dispatching'){
    attempt.state='submission-uncertain';attempt.uncertainReason='Restart after durable dispatch fence; bytes or acknowledgment may be missing.';attempt.version=String(BigInt(attempt.version)+1n);job.version=String(BigInt(job.version)+1n);
    const out=this.outbox(attempt.id);out.state='uncertain';this.writeOutbox(attempt.id,job.id,out);this.record('job',job,'SubmissionUncertain');
   }
   for(const job of this.jobs()) {let changed=false;for(const a of job.attempts)if(a.requestId&&a.state!=='locally-cancelled'&&!a.recoveryRequired){a.recoveryRequired=true;a.recoveryRequested=false;changed=true;}if(changed){job.version=String(BigInt(job.version)+1n);this.record('job',job,'RecoveryRequiresExplicitAction');}}
   this.db.exec('COMMIT');
  }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
 }
 private project(family:'job'|'session',value:QueueJob|SpendSession){this.db.prepare(`INSERT INTO ${family==='job'?'queue_jobs':'spend_sessions'} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(value.id,canonical(value));}
 private record(family:'job'|'session',value:QueueJob|SpendSession,event:string){this.db.prepare('INSERT INTO queue_journal(json) VALUES (?)').run(canonical({family,event,epoch:this.epoch,at:new Date().toISOString(),value}));this.project(family,value);}
 private initializeOrder(){
  if(!this.db.prepare("SELECT 1 FROM queue_jobs WHERE json_type(json,'$.order') IS NULL LIMIT 1").get())return;
  let next=this.lastPosition(),acceptedCount=0;
  // First accepted creation sequence is authoritative. Consume it as a cursor,
  // retaining one job/command only; duplicate creation evidence cannot reorder it.
  for(const row of this.db.prepare("SELECT e.json AS event,c.canonical AS command FROM events_v2 e JOIN commands c ON c.id=e.command_id WHERE json_extract(e.json,'$.type')='JobQueued' ORDER BY length(e.seq),e.seq").iterate()){
   const event=JSON.parse(String(row.event)),record=this.db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(event.payload.id);if(!record)continue;const job=JSON.parse(String(record.json)) as QueueJob;acceptedCount++;if(job.order)continue;
   const position=String(++next),creating=JSON.parse(String(row.command));job.order={position,insertionOrdinal:position,origin:'accepted-event'};job.ownerClientId=typeof creating?.command?.clientId==='string'?creating.command.clientId:null;job.version=String(BigInt(job.version)+1n);this.record('job',job,'QueueOrderInitialized');
  }
  // Release every SELECT before touching its source table. An append-only
  // sequence key resumes journal traversal without retaining historical rows.
  let journalSeq=0;
  for(;;){const row=this.db.prepare("SELECT seq,json FROM queue_journal WHERE seq>? AND json_extract(json,'$.family')='job' AND json_extract(json,'$.event')='JobQueued' ORDER BY seq LIMIT 1").get(journalSeq);if(!row)break;journalSeq=Number(row.seq);const original=JSON.parse(String(row.json)),record=this.db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(original.value.id);if(!record)continue;const job=JSON.parse(String(record.json)) as QueueJob;if(job.order)continue;const position=String(++next);
   job.order={position,insertionOrdinal:acceptedCount===0?position:null,origin:acceptedCount?'journal-unplaced':'journal'};job.ownerClientId=null;job.version=String(BigInt(job.version)+1n);this.record('job',job,'QueueOrderInitialized');
  }
  for(;;){const row=this.db.prepare("SELECT id FROM queue_jobs WHERE json_type(json,'$.order') IS NULL ORDER BY id LIMIT 1").get();if(!row)break;const job=this.job(String(row.id));job.order={position:String(++next),insertionOrdinal:null,origin:'legacy-id-order'};job.ownerClientId=null;job.version=String(BigInt(job.version)+1n);this.record('job',job,'QueueOrderInitialized');}
 }
 private *jobs():Generator<QueueJob>{let position='0',id='';for(;;){
  const rows=this.db.prepare("SELECT json FROM queue_jobs WHERE length(json_extract(json,'$.order.position'))>? OR (length(json_extract(json,'$.order.position'))=? AND (json_extract(json,'$.order.position')>? OR (json_extract(json,'$.order.position')=? AND id>?))) ORDER BY length(json_extract(json,'$.order.position')),json_extract(json,'$.order.position'),id LIMIT 20").all(position.length,position.length,position,position,id);if(!rows.length)return;
  // The bounded SELECT is complete before a caller can mutate a yielded job.
  for(const row of rows){const job=JSON.parse(String(row.json)) as QueueJob;position=job.order!.position;id=job.id;yield job;}
 }}
 private lastPosition(){const row=this.db.prepare("SELECT json_extract(json,'$.order.position') AS position FROM queue_jobs WHERE json_type(json,'$.order.position')='text' ORDER BY length(json_extract(json,'$.order.position')) DESC,json_extract(json,'$.order.position') DESC,id DESC LIMIT 1").get();return row?BigInt(String(row.position)):0n;}
 private *attempts():Generator<Attempt>{for(const job of this.jobs())for(const attempt of job.attempts)yield attempt;}
 private counts(sessionId:string,exclude?:string){let reserved=0,dispatched=0,active=0;for(const attempt of this.attempts()){if(attempt.id===exclude)continue;if(attempt.hold)active++;if(attempt.spendSessionId===sessionId){if(attempt.count==='reserved')reserved++;if(attempt.count==='dispatched')dispatched++;}}return {reserved,dispatched,active};}
 private unresolved(){for(const attempt of this.attempts())if(attempt.hold||attempt.state==='submission-uncertain')return true;return false;}
 private firstEligible(){for(const job of this.jobs()){const a=job.attempts.at(-1);if(!this.deleted(job.documentId)&&job.disposition==='eligible'&&job.local!=='locally-cancelled'&&a?.state==='not-started'&&['none','released'].includes(a.count)&&queueModelAdmission(job.review)==='provider-profile-required')return job;}return null;}
 private eligibility(){const job=this.firstEligible();if(!job)return null;const counts=this.counts(this.session().id),cap=this.session().cap;if(counts.active||cap!==null&&counts.reserved+counts.dispatched>=cap)return null;return {jobId:job.id,documentId:job.documentId,attemptId:job.attempts.at(-1)!.id};}
 // Observation only: callers cannot obtain dispatch authority from this probe.
 observeEligibility(){try{return this.eligibility();}catch{return undefined;}}
 eligibleChanged(previous:ReturnType<QueueStore['observeEligibility']>,next:ReturnType<QueueStore['observeEligibility']>,commandId?:string){if(previous===undefined||next===undefined)return;try{if(next&&(next.jobId!==previous?.jobId||next.attemptId!==previous?.attemptId))serverPhases.instant('job.eligible',{...next,commandId,boundary:'authority-durable',eligibility:'local-order'});}catch{/* Telemetry cannot change a durable outcome. */}}
 private waitingNeighbor(jobId:string,direction:'up'|'down'){let previous:string|null=null,found=false;for(const job of this.jobs()){if(!this.waiting(job))continue;if(found)return job.id;if(job.id===jobId){if(direction==='up')return previous;found=true;}previous=job.id;}return null;}
 private orderVersion(){return String(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM queue_journal').get()!.seq);}
 private orderEpoch(){return String(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM queue_journal WHERE json_extract(json,'$.event') IN ('QueueOrderInitialized','LocalQueueReordered')").get()!.seq);}
 private waiting(job:QueueJob){const a=job.attempts.at(-1);return !this.deleted(job.documentId)&&job.disposition==='eligible'&&job.local!=='locally-cancelled'&&!!a&&a.state==='not-started'&&!a.hold&&['none','released'].includes(a.count)&&job.attempts.length===1&&this.outbox(a.id).state==='safe-unstarted';}
 private assertWaiting(job:QueueJob){if(!this.waiting(job))throw new AssetRejection('INCOMPATIBLE','UNRESERVED_WAITING_JOB_REQUIRED');}
 private assertClient(auth:AssetAuth){const binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);if(auth.now>=auth.expires||!binding||binding.client_id!==auth.clientId||auth.now>=Number(binding.expires))throw new AssetRejection('STALE_REVISION','REVIEW_SESSION_EXPIRED');}
 private boundedJob(job:QueueJob){if(Buffer.byteLength(canonical(job))>65536)throw new AssetRejection('CAPACITY','QUEUE_METADATA_LIMIT');}

 private job(id:string):QueueJob{const row=this.db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(id);if(!row)throw new AssetRejection('INVALID_INPUT','JOB_UNAVAILABLE');return JSON.parse(String(row.json));}
 private newSession(previousSessionId:string|null,cap:number|null):SpendSession{return {id:randomUUID(),version:'1',cap,previousSessionId,createdAt:new Date().toISOString()};}
 private session():SpendSession{const row=this.db.prepare('SELECT json FROM spend_sessions ORDER BY rowid DESC LIMIT 1').get()!;return JSON.parse(String(row.json));}
 private assertCapacity(){let count=0;for(const job of this.jobs())if(job.local!=='locally-cancelled'&&job.attempts.some(a=>a.state==='not-started')&&++count>=1000)throw new AssetRejection('CAPACITY','LOCAL_QUEUE_CEILING');}
 view(after=''):QueueView{
  this.check();const orderEpoch=this.orderEpoch(),orderVersion=this.orderVersion();let position=0n;
  if(after){const parts=after.split(':');if(after.length>256||parts.length!==4||parts[0]!=='q1'||!/^(0|[1-9][0-9]*)$/.test(parts[1]!)||!/^[1-9][0-9]*$/.test(parts[2]!)||!isId(parts[3]))throw new StoreError('MALFORMED_REQUEST');if(parts[1]!==orderEpoch)throw new StoreError('STALE_EPOCH');const anchor=this.job(parts[3]!);if(anchor.order?.position!==parts[2])throw new StoreError('STALE_EPOCH');position=BigInt(parts[2]!);}
  const session=this.session(),counts=this.counts(session.id),totalJobs=Number(this.db.prepare('SELECT COUNT(*) AS count FROM queue_jobs').get()!.count),afterPosition=String(position);
  const items=this.db.prepare("SELECT json FROM queue_jobs WHERE length(json_extract(json,'$.order.position'))>? OR (length(json_extract(json,'$.order.position'))=? AND json_extract(json,'$.order.position')>?) ORDER BY length(json_extract(json,'$.order.position')),json_extract(json,'$.order.position'),id LIMIT 21").all(afterPosition.length,afterPosition.length,afterPosition).map(row=>JSON.parse(String(row.json)) as QueueJob),more=items.length>20;if(more)items.pop();
  const visible=new Set(items.map(job=>job.id)),waiting:Record<string,QueueWaiting>={};let waitingPosition=0,previous:{id:string;version:string}|null=null;
  for(const job of this.jobs()){if(!this.waiting(job))continue;waitingPosition++;const identity={id:job.id,version:job.version};if(previous&&waiting[previous.id])waiting[previous.id]!.next=identity;
   if(visible.has(job.id))waiting[job.id]={position:waitingPosition,previous,next:null,editable:!!job.ownerClientId,reason:queueModelAdmission(job.review)!=='provider-profile-required'?'Waiting for model safety qualification':counts.active?'Waiting for the active request':job.local==='paused-spend-cap'?'Paused at the request cap':'Waiting for explicit provider authorization'};previous=identity;
  }
  const last=items.at(-1);return {protocolVersion:1,session,orderVersion,orderEpoch,waiting,totalJobs,jobs:items,nextCursor:more&&last?'q1:'+orderEpoch+':'+last.order!.position+':'+last.id:null,counts:{...counts,remaining:session.cap===null?null:Math.max(0,session.cap-counts.reserved-counts.dispatched)},limits:{active:1,target:100,maximum:1000},production:'denied'};
 }
 private attempt(review:RequestReview,previousAttemptId:string|null=null):Attempt{return {id:randomUUID(),previousAttemptId,version:'1',state:'not-started',hold:false,override:false,spendSessionId:null,count:'none',writerEpoch:null,payloadHash:null,requestId:null,terminal:null,uncertainReason:null,actualCharge:null,estimate:review.estimate};}
 private outbox(id:string):Outbox{const row=this.db.prepare('SELECT json FROM queue_outbox WHERE attempt_id=?').get(id);if(!row)throw new StoreError('CORRUPT_STORE');return JSON.parse(String(row.json));}
 private writeOutbox(id:string,jobId:string,out:Outbox){this.db.prepare('INSERT INTO queue_outbox VALUES (?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET json=excluded.json').run(id,jobId,canonical(out));}
 private initialOutbox(attempt:Attempt,job:QueueJob){this.writeOutbox(attempt.id,job.id,{state:'safe-unstarted',epoch:null,endpoint:job.review.endpoint,mapping:{},bodyRecord:null,payloadHash:null,requestId:null,urls:null,responseRecord:null});}
 private fact(value:QueueJob|SpendSession,type:QueueFact['type'],slot:string):QueueFact{
  let bytes=Buffer.from(canonical(value));
  if(bytes.byteLength>65536&&type==='QueueStateChanged'&&'attempts' in value){
   // Migration adds local administrative metadata. Its full value remains in
   // the immutable journal; do not make cancellation of a formerly valid job
   // fail solely because those optional fields exceed the legacy fact budget.
   const {order,ownerClientId,...legacy}=value;const legacyBytes=Buffer.from(canonical(legacy));if(legacyBytes.byteLength<=65536)bytes=legacyBytes;
  }
  const state=this.objects.putMetadataInSlot(bytes,slot);this.register('queue:'+value.id+':'+value.version,state);return {type,payload:{id:value.id,version:value.version,state}};
 }
 private review(body:Extract<QueueBody,{type:'QueueInference'}>,auth:AssetAuth){
  const binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);if(auth.now>=auth.expires||!binding||binding.client_id!==auth.clientId||auth.now>=Number(binding.expires))throw new AssetRejection('STALE_REVISION','REVIEW_SESSION_EXPIRED');
  const row=this.db.prepare('SELECT json FROM ui_receipts WHERE client_id=? AND id=?').get(auth.clientId,body.acceptanceId),receipt=row?JSON.parse(String(row.json)):null;
  const review:RequestReview|undefined=receipt?.status==='accepted'&&receipt.acceptedReview===body.reviewId?receipt.review:undefined;
  if(review&&this.deleted(review.documentId))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');
  if(!review||review.token!==body.token)throw new AssetRejection('STALE_REVISION','ACCEPTED_REVIEW_REQUIRED');
  const saved=this.ui.read(review.draft.sessionId,auth).drafts.find(d=>d.id===review.draft.draftId);if(!saved||saved.status!=='saved-unapplied')throw new AssetRejection('STALE_REVISION','DRAFT_CHANGED');
  const reviews=new RequestReviews(this.db,this.objects,this.assets,this.state,this.rasters);try{reviews.assert(review,saved,auth);}catch(e){if(e instanceof RequestError)throw new AssetRejection('STALE_REVISION',e.issues.map(i=>i.code).join('_'));throw e;}
  return {review,draft:reviews.draft(saved)};
 }
 command(bytes:Uint8Array,auth:AssetAuth):Promise<Receipt>{
  const request=parseCommand(bytes),c=request.command;if(!isQueueCommand(c.body.type))throw new StoreError('UNSUPPORTED_COMMAND');
  // Duplicate delivery returns the original receipt before checking current authority/dependencies.
  if(c.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
  const hash=hashBytes(canonical(request)),old=this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);
  if(old){if(old.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return Promise.resolve(JSON.parse(String(old.receipt)));}
  const pending=this.preparing.get(c.commandId);if(pending){if(pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return pending.promise;}
  const releaseCoverage=adapterResources.uncovered('queue-preparation');
  const promise=this.prepare(bytes,auth).finally(()=>{this.preparing.delete(c.commandId);releaseCoverage();});this.preparing.set(c.commandId,{hash,promise});return promise;
 }
 private async prepare(bytes:Uint8Array,auth:AssetAuth):Promise<Receipt>{
  const started=performance.now(),currentAuth=()=>({...auth,now:auth.now+Math.floor(performance.now()-started)});
  const c=parseCommand(bytes).command,b=c.body as QueueBody,slot='queue:'+c.commandId,admission=slot+':metadata',proofs:{ref:BlobRef;token:string}[]=[],stagePlan:StageItem[]=[];
  if(['PreviewDocumentDeletion','DeleteDocument','CollectDocumentGarbage'].includes(b.type)){if(!this.deletionCommand)throw new StoreError('UNSUPPORTED_COMMAND');const receipt=this.deletionCommand(bytes,auth);if(b.type==='DeleteDocument'&&receipt.status==='accepted')this.onDocumentDeleted?.(b.documentId);return receipt;}
  let replacement:Awaited<ReturnType<UIStore['prepareQueueReplacement']>>|undefined;
  let prepared:ReturnType<QueueStore['review']>|undefined,failure:AssetRejection|undefined;this.objects.acquire(slot);
  try{
   const admitsMetadata=['QueueInference','ReorderLocalQueue','EditQueuedJob'].includes(b.type);
   if(admitsMetadata)try{this.objects.reserve(admission,QUEUE_ADMISSION_BYTES);}catch(e){if(e instanceof StoreError&&e.code==='CAPACITY')failure=new AssetRejection('CAPACITY','QUEUE_METADATA_ADMISSION');else throw e;}
   if(b.type==='QueueInference'&&!failure)try{
    prepared=this.review(b,auth);
    const authored=this.assets.asset(prepared.review.draftAsset);if(!authored)throw new StoreError('MISSING_OBJECT');proofs.push({ref:authored.blob,token:await this.objects.prove(authored.blob,this.check)});
    for(const ref of [prepared.review.template,...new RequestReviews(this.db,this.objects,this.assets,this.state,this.rasters).treatmentRefs(prepared.review),...refs(prepared.draft),...compositionTextOriginRefs(prepared.draft,ref=>readRequestBytes(this.objects,ref,1048576)),...adapterReferences(this.assets,adapters(prepared.draft))])proofs.push({ref,token:await this.objects.prove(ref,this.check)});
    const r=prepared.review.request;
    if(isV45Request(r)){
     // Local acceptance can only reuse already prepared, reviewed input bytes.
     // It grants no provider authority and cannot run V4 attachment conversion.
     validateV45Request(r);
     if(r.kind!=='generate-v45'){
      const inputRead=this.rasters.v45EditInputs(r.preparedInputs.assetId);try{const preparedInputs=inputRead.value,{assetId,version,...source}=preparedInputs.source;
      const actual={assetId,version,manifest:preparedInputs.manifest,source,mask:preparedInputs.mask,references:preparedInputs.references.map(reference=>reference.input)};
      const mask='mask' in r?r.mask:null;
      if(canonical(actual)!==canonical(r.preparedInputs)||canonical(preparedInputs.original)!==canonical({source:r.source,mask})||canonical(preparedInputs.requestPlan)!==canonical(mask?.requestPlan??null)||canonical(preparedInputs.references.map(reference=>reference.original))!==canonical(r.references))throw new AssetRejection('STALE_REVISION','V45_PREPARED_INPUTS_CHANGED');
      for(const ref of preparedInputs.refs)proofs.push({ref,token:await this.objects.prove(ref,this.check)});
      }finally{inputRead.release();}
     }
     stagePlan.push(...requestPreparedStages(r));
    }else{
    const requestPlan='mask' in r?structuredClone(requireRequestMaskPlan(r.source,r.mask)):undefined;
    for(const role of ['source','mask'] as const){if(!(role in r))continue;const source=(r as any)[role] as {assetId:string;blob:BlobRef;width:number;height:number};
     const size=requestPlan?requestRasterGrid(requestPlan):r.size.kind==='custom'?r.size:{width:source.width,height:source.height};
     let transport=source.blob;
     if(requestPlan||size.width!==source.width||size.height!==source.height){
      const result=await this.rasters.prepareDocument(requestPlan?{type:role==='mask'?'RequestMaskTransport':'RequestSourceTransport',assetId:source.assetId,plan:requestPlan}:{type:'ComposeRaster',width:size.width,height:size.height,layers:[{assetId:source.assetId,transform:[size.width/source.width,0,0,size.height/source.height,0,0],opacity:1,mask:null}]},randomUUID(),slot,this.check,undefined,prepared.review.documentId);
      proofs.push(...result.proofs);transport=result.asset.blob;
     }
     stagePlan.push({role,original:source.blob,transport,width:size.width,height:size.height,conversion:prepared.review.conversion});
    }
    if('adapters' in r)for(const [index,use]of r.adapters.entries()){
     const asset=this.assets.asset(use.version);if(!asset?.adapter||asset.blob.hash!==use.hash)throw new StoreError('MISSING_OBJECT');
     stagePlan.push({role:`adapter:${index}`,versionId:use.version,original:asset.blob,transport:asset.blob});
    }
    }
   }catch(e){if(e instanceof AssetRejection)failure=e;else if(e instanceof StoreError&&e.code==='CAPACITY')failure=new AssetRejection('CAPACITY','QUEUE_METADATA_ADMISSION');else if(e instanceof StoreError&&['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code))failure=new AssetRejection('MISSING_ASSET',e.code);else throw e;}
   if(b.type==='EditQueuedJob'&&!failure)try{const job=this.job(b.jobId);this.assertClient(currentAuth());if(job.ownerClientId!==auth.clientId)throw new AssetRejection('INVALID_INPUT','QUEUE_OWNER_REQUIRED');this.assertWaiting(job);replacement=await this.ui.prepareQueueReplacement(job.review,b,auth);proofs.push(...replacement.proofs.map(p=>({ref:p.ref,token:p.proof})));}catch(e){if(e instanceof AssetRejection)failure=e;else if(e instanceof StoreError&&['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code))failure=new AssetRejection('MISSING_ASSET',e.code);else throw e;}
   const eligibilityBefore=this.observeEligibility();let eligibilityAfter:ReturnType<QueueStore['observeEligibility']>=undefined;const receipt=this.commit(bytes,()=>{const fact=(():QueueFact=>{
    this.check();if(failure)throw failure;
    if(admitsMetadata)try{this.objects.capacity(0n);}catch(e){if(e instanceof StoreError&&e.code==='CAPACITY')throw new AssetRejection('CAPACITY','QUEUE_METADATA_ADMISSION');throw e;}
    if(b.type==='QueueInference'){
     const fresh=this.review(b,currentAuth());if(!prepared||canonical(fresh.review)!==canonical(prepared.review))throw new AssetRejection('STALE_REVISION','REVIEW_CHANGED');
     this.assertCapacity();
     const registered=new Set<string>();for(const p of proofs){this.objects.proven(p.ref,p.token);if(!registered.has(p.ref.hash)){this.register('queue-input:'+c.commandId,p.ref,p.token);registered.add(p.ref.hash);}}
     const ordinal=String(this.lastPosition()+1n);
     const review=fresh.review,job:QueueJob={order:{insertionOrdinal:ordinal,position:ordinal,origin:'accepted'},ownerClientId:c.clientId,id:randomUUID(),version:'1',documentId:review.documentId,review,stagePlan,local:'accepted-local-queue',resultImport:'none',disposition:'eligible',attempts:[this.attempt(review)]};
     this.boundedJob(job);this.initialOutbox(job.attempts[0],job);this.record('job',job,'JobQueued');this.barrier('queue-accept-before-fact');return this.fact(job,'JobQueued',slot);
    }
    if(b.type==='SetSpendGuard'||b.type==='StartSpendSession'){
     const current=this.session();let next:SpendSession;
     if(b.type==='SetSpendGuard'){if(current.id!==b.spendSessionId||current.version!==b.expectedConfigVersion)throw new AssetRejection('STALE_REVISION','SPEND_CONFIG_CHANGED');next={...current,cap:b.cap,version:String(BigInt(current.version)+1n)};}
     else{if(b.previousSessionId!==current.id)throw new AssetRejection('STALE_REVISION','SPEND_SESSION_CHANGED');if(this.unresolved()&&!b.acknowledgeUnresolvedAttempts)throw new AssetRejection('INVALID_INPUT','ACKNOWLEDGE_UNRESOLVED_CHARGES');next=this.newSession(current.id,b.cap);}
     const event=b.type==='SetSpendGuard'?'SpendGuardChanged':'SpendSessionStarted';this.record('session',next,event);
     // A config change makes local work eligible; it never clears old counters or remote holds.
     for(const job of this.jobs())if(job.local==='paused-spend-cap'){job.local='accepted-local-queue';job.version=String(BigInt(job.version)+1n);this.record('job',job,event);}
     return this.fact(next,event,slot);
    }
    if(b.type==='HideCandidate'||b.type==='RetryCandidateImport'||b.type==='RecoverCandidateOriginal'){if(!this.candidateAction)throw new StoreError('UNSUPPORTED_COMMAND');return this.candidateAction(b,slot);}
    if('documentId' in b)throw new StoreError('UNSUPPORTED_COMMAND');
    const job=this.job(b.jobId);if(job.version!==b.expectedVersion)throw new AssetRejection('STALE_REVISION','JOB_CHANGED');
    if(b.type==='ReorderLocalQueue'){
     this.assertClient(currentAuth());if(this.orderVersion()!==b.expectedOrderVersion)throw new AssetRejection('STALE_REVISION','QUEUE_ORDER_CHANGED');this.assertWaiting(job);
     const neighbor=this.job(b.neighborId);if(neighbor.version!==b.expectedNeighborVersion)throw new AssetRejection('STALE_REVISION','NEIGHBOR_CHANGED');this.assertWaiting(neighbor);
     if(this.waitingNeighbor(job.id,b.direction)!==neighbor.id)throw new AssetRejection('STALE_REVISION','WAITING_NEIGHBOR_CHANGED');
     const old=job.order!.position;job.order!.position=neighbor.order!.position;neighbor.order!.position=old;job.version=String(BigInt(job.version)+1n);neighbor.version=String(BigInt(neighbor.version)+1n);
     this.record('job',job,'LocalQueueReordered');this.record('job',neighbor,'LocalQueueReordered');
     const value={kind:'local-queue-reorder-1',id:job.id,version:job.version,orderVersion:this.orderVersion(),jobs:[{id:job.id,version:job.version,order:job.order},{id:neighbor.id,version:neighbor.version,order:neighbor.order}]},state=this.objects.putMetadataInSlot(Buffer.from(canonical(value)),slot);this.register('queue-order:'+c.commandId,state);return {type:'LocalQueueReordered',payload:{id:job.id,version:job.version,state}};
    }
    if(b.type==='EditQueuedJob'){
     this.assertClient(currentAuth());if(job.ownerClientId!==auth.clientId)throw new AssetRejection('INVALID_INPUT','QUEUE_OWNER_REQUIRED');this.assertWaiting(job);if(!replacement)throw new AssetRejection('STALE_REVISION','REPLACEMENT_DRAFT_CHANGED');
     this.ui.commitQueueReplacement(job.review,b,currentAuth(),replacement);
     const a=job.attempts.at(-1)!;a.state='locally-cancelled';a.version=String(BigInt(a.version)+1n);job.local='locally-cancelled';job.disposition='set-aside';job.replacementDraft={sessionId:b.sessionId,draftId:b.replacementDraftId,generation:'1'};const out=this.outbox(a.id);out.state='cancelled';this.writeOutbox(a.id,job.id,out);
    }else if(b.type==='AuthorizeProviderJob'){
     if(queueModelAdmission(job.review)!=='provider-profile-required')throw new AssetRejection('INCOMPATIBLE','V45_SAFETY_ADMISSION_BLOCKED');
     const a=job.attempts.at(-1);
     if(this.deleted(job.documentId)||!this.db.prepare('SELECT 1 FROM documents WHERE id=?').get(job.documentId))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');
     if(!a||a.id!==b.attemptId||a.state!=='not-started')throw new AssetRejection('STALE_REVISION','ATTEMPT_CHANGED');
     if(job.disposition!=='eligible'||job.local==='locally-cancelled')throw new AssetRejection('INCOMPATIBLE','JOB_NOT_ELIGIBLE');
     if(b.reviewToken!==job.review.token)throw new AssetRejection('STALE_REVISION','REVIEW_CHANGED');
     if(a.providerAuthorization)throw new AssetRejection('INCOMPATIBLE','PROVIDER_AUTHORIZATION_ALREADY_RECORDED');
     if(!this.authorizeProvider)throw new AssetRejection('INCOMPATIBLE','PROVIDER_UNAVAILABLE');
     a.providerAuthorization=structuredClone(this.authorizeProvider(structuredClone(job),structuredClone(a),structuredClone(b)));
     a.version=String(BigInt(a.version)+1n);
    }else if(b.type==='CancelJob'||b.type==='UndoPendingJob'||b.type==='RedoPendingJob'||b.type==='RecoverJob'){
     const a=job.attempts.find(a=>a.id===b.attemptId);if(!a)throw new AssetRejection('STALE_REVISION','ATTEMPT_CHANGED');
     if(b.type==='RecoverJob'){a.recoveryRequired=false;a.recoveryRequested=true;a.controlWarning=a.requestId?'Checking the same provider request.':'No durable provider identifier; no remote lookup or new request is possible.';}
     else {if(this.deleted(job.documentId))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');
      if(b.type==='RedoPendingJob'){job.disposition='set-aside';a.controlWarning=a.state==='locally-cancelled'?'Not run — submit a new request.':'Results remain retained; placement requires separate review.';}
      else {job.disposition=b.type==='UndoPendingJob'?'suppressed-by-undo':'cancel-requested';
       if(a.state==='not-started'){a.state='locally-cancelled';a.hold=false;if(a.count==='reserved')a.count='released';job.local='locally-cancelled';const out=this.outbox(a.id);out.state='cancelled';this.writeOutbox(a.id,job.id,out);}
       else if(!a.cancel){a.cancel='requested';a.recoveryRequired=false;}
      }
     }a.version=String(BigInt(a.version)+1n);
    }else if(b.type==='CancelUnstartedJob'){
     const a=job.attempts.at(-1)!;if(a.state!=='not-started')throw new AssetRejection('INCOMPATIBLE','DISPATCH_MAY_HAVE_STARTED');a.state='locally-cancelled';a.hold=false;a.count=a.count==='reserved'?'released':a.count;a.version=String(BigInt(a.version)+1n);job.local='locally-cancelled';job.disposition='set-aside';const out=this.outbox(a.id);out.state='cancelled';this.writeOutbox(a.id,job.id,out);
    }else{
     if(this.deleted(job.documentId)&&b.type!=='OverrideUncertainHold')throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');
     const a=job.attempts.find(a=>a.id===b.attemptId);if(!a||a.state!=='submission-uncertain')throw new AssetRejection('INCOMPATIBLE','UNCERTAIN_ATTEMPT_REQUIRED');
     if(b.type==='OverrideUncertainHold'){a.hold=false;a.override=true;a.version=String(BigInt(a.version)+1n);}
     else{if(a.hold||job.attempts.at(-1)!.state==='not-started')throw new AssetRejection('INCOMPATIBLE','REVIEW_OVERLAPPING_WORK_FIRST');this.assertCapacity();const next=this.attempt(job.review,a.id);job.attempts.push(next);job.local='accepted-local-queue';this.initialOutbox(next,job);}
    }
    job.version=String(BigInt(job.version)+1n);if(b.type==='EditQueuedJob'||b.type==='RetryUncertainJob')this.boundedJob(job);this.record('job',job,b.type);return this.fact(job,'QueueStateChanged',slot);
   })();eligibilityAfter=this.observeEligibility();return fact;},slot,()=>this.eligibleChanged(eligibilityBefore,eligibilityAfter,c.commandId));return receipt;
  }finally{for(const p of proofs)this.objects.releaseProof(p.token);this.objects.unreserve(admission);this.objects.unreserve(slot);this.objects.release(slot);}
 }
 deleted(documentId:string){return !!this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(documentId);}
 controlFence(jobId:string,attemptId:string,action:'status'|'cancel'|'result'){
  this.check();const job=this.job(jobId),a=job.attempts.find(a=>a.id===attemptId);
  if(!a?.requestId||a.recoveryRequired||(action==='result'&&this.deleted(job.documentId))||(action==='cancel'&&a.cancel!=='requested'))throw new StoreError('STALE_EPOCH');
  return {jobId,attemptId,requestId:a.requestId,epoch:this.epoch,jobVersion:job.version};
 }
 cancelObserved(f:import('../../src/protocol/candidates.js').ResultFence,recordId:string,accepted:boolean){return this.transaction(()=>{
  const current=this.controlFence(f.jobId,f.attemptId,'cancel');if(canonical(current)!==canonical(f))throw new StoreError('STALE_EPOCH');
  const job=this.job(f.jobId),a=job.attempts.find(a=>a.id===f.attemptId)!;a.cancel=accepted?'acknowledged':'unconfirmed';a.cancelEvidence=recordId;a.controlWarning=accepted?'Cancellation requested; work may still finish.':'Cancellation could not be confirmed. Check the existing request.';a.version=String(BigInt(a.version)+1n);job.version=String(BigInt(job.version)+1n);this.record('job',job,'CancellationObserved');return job;
 });}
 recoveryWork(eligible:(jobId:string,attemptId:string)=>boolean=()=>true){const items:{jobId:string;attemptId:string}[]=[];for(const job of this.jobs())for(const a of job.attempts)if(!a.requestId&&a.recoveryRequested&&!a.recoveryRequired&&eligible(job.id,a.id)){items.push({jobId:job.id,attemptId:a.id});if(items.length===20)return items;}return items;}
 recoveryInspected(jobId:string,attemptId:string,message:string){return this.transaction(()=>{const job=this.job(jobId),a=job.attempts.find(a=>a.id===attemptId);if(!a||!a.recoveryRequested)throw new StoreError('STALE_EPOCH');a.recoveryRequested=false;a.controlWarning=message;a.version=String(BigInt(a.version)+1n);job.version=String(BigInt(job.version)+1n);this.record('job',job,'RecoveryInspected');});}
 controlWork(eligible:(jobId:string,attemptId:string)=>boolean=()=>true){const items:{jobId:string;attemptId:string;cancel:boolean;deleted:boolean}[]=[];for(const job of this.jobs()){const deleted=this.deleted(job.documentId);for(const a of job.attempts)if(a.requestId&&!a.recoveryRequired&&(a.cancel==='requested'||deleted&&a.recoveryRequested)&&eligible(job.id,a.id)){items.push({jobId:job.id,attemptId:a.id,cancel:a.cancel==='requested',deleted});if(items.length===20)return items;}}return items;}
 detachedObserved(f:import('../../src/protocol/candidates.js').ResultFence,recordId:string,status:string|null){return this.transaction(()=>{
  const current=this.controlFence(f.jobId,f.attemptId,'status');if(canonical(current)!==canonical(f))throw new StoreError('STALE_EPOCH');
  const job=this.job(f.jobId),a=job.attempts.find(a=>a.id===f.attemptId)!;a.recoveryRequested=false;a.controlWarning=status?'Document deleted; no result bytes will be retrieved.':'Existing request status could not be confirmed. '+(a.hold?'The local hold remains. ':'This check did not establish that remote work stopped. ')+'Document deleted; no result bytes will be retrieved.';
  if(status&&['COMPLETED','FAILED','CANCELLED'].includes(status)){if(a.terminal&&a.terminal!==status.toLowerCase())a.controlWarning='Conflicting terminal observations require reconciliation.';else{a.state='provider-terminal';a.terminal=status.toLowerCase();a.hold=false;if(status==='CANCELLED')a.cancel='confirmed';}}
  a.cancelEvidence=recordId;a.version=String(BigInt(a.version)+1n);job.version=String(BigInt(job.version)+1n);this.record('job',job,'DetachedReconciliation');return job;
 });}
 detachDocument(documentId:string){
  for(const job of this.jobs()){if(job.documentId!==documentId)continue;
   job.disposition='deleted';for(const a of job.attempts){if(a.state==='not-started'){a.state='locally-cancelled';a.hold=false;if(a.count==='reserved')a.count='released';const out=this.outbox(a.id);out.state='cancelled';this.writeOutbox(a.id,job.id,out);}a.recoveryRequired=true;a.recoveryRequested=false;a.version=String(BigInt(a.version)+1n);}
   job.local='locally-cancelled';job.version=String(BigInt(job.version)+1n);this.record('job',job,'DocumentDetached');
  }
 }
 // Internal scheduler capability, never a browser route. All transitions use the sole writer.
 input(ref:BlobRef){return readRequestBytes(this.objects,ref,104857600);}
 inputStream(ref:BlobRef):{byteLength:bigint;chunks:()=>AsyncIterable<Uint8Array>}{
  const objects=this.objects,check=this.check,total=BigInt(ref.byteLength);
  const owner=this;
  return {byteLength:total,chunks:async function*(){
   // The caller owns the bounded request/response transfer reservations for
   // the entire iteration. A third permit would deadlock the two-slot IO pool.
   const releaseCoverage=adapterResources.uncovered('queue-input-stream');let proof:string|undefined;owner.inputStreams++;
   try{proof=await objects.prove(ref,check);for(let offset=0n;offset<total;){check();objects.proven(ref,proof);const length=Number(total-offset>1048576n?1048576n:total-offset),owned=objects.readRangeOwned(ref,String(offset),length);try{yield owned.bytes;}finally{owned.release();}offset+=BigInt(length);}}
   finally{try{if(proof)objects.releaseProof(proof);}finally{owner.inputStreams--;releaseCoverage();}}
  }};
 }
 sink(attemptId:string,direction:'request'|'response',policy:AppliedPrivacyPolicy){return this.evidence.begin(attemptId,direction,r31Reservation(this.objects,'queue-wire:'+randomUUID(),direction==='request'?'provider-request':'provider-response',this.check),policy);}
 runtimeWireRef(recordId:string,attemptId:string,direction:'request'|'response',role:RuntimeWireRole,expectedURL?:string):RuntimeWireRef|null{
  this.check();const meta=this.evidence.inspect(recordId),wire=meta.wireExecution;
  // Legacy snapshots and incomplete/derived bodies are never upgraded by a
  // current semantic observation. inspect validates any present wire claim.
  if(!wire||meta.completeness!=='complete'||meta.receivedBytes!==meta.retainedBytes||meta.attemptId!==attemptId||meta.direction!==direction||wire.role!==role||wire.httpStatus<200||wire.httpStatus>=300)return null;
  if(expectedURL!==undefined){const url=new URL(expectedURL);if(wire.origin!==url.origin||wire.pathname!==url.pathname||wire.urlHash!==hashBytes(expectedURL))return null;}
  return {recordId:meta.recordId,bodyHash:'sha256:'+meta.sha256,metadataHash:hashBytes(canonical(meta))};
 }
 private runtimePair(recordId:string,attemptId:string,role:'upload'|'submit'):{request:RuntimeWireRef;response:RuntimeWireRef}|null{
  const response=this.runtimeWireRef(recordId,attemptId,'response',role);if(!response)return null;
  const responseMeta=this.evidence.inspect(recordId),wire=responseMeta.wireExecution!;
  if(!wire.requestRecordId||!wire.requestSha256)throw new StoreError('CORRUPT_OBJECT');
  const request=this.runtimeWireRef(wire.requestRecordId,attemptId,'request',role);if(!request)throw new StoreError('CORRUPT_OBJECT');
  const requestMeta=this.evidence.inspect(request.recordId),sent=requestMeta.wireExecution!;
  if(request.bodyHash!==wire.requestSha256||sent.requestRecordId!==request.recordId||sent.requestSha256!==request.bodyHash||sent.boundary!==wire.boundary||sent.method!==wire.method||sent.origin!==wire.origin||sent.pathname!==wire.pathname||sent.urlHash!==wire.urlHash||sent.httpStatus!==wire.httpStatus)throw new StoreError('CORRUPT_OBJECT');
  return {request,response};
 }
 private newWireEvidence():QueueWireEvidence{return {kind:'queue-wire-evidence-1',uploads:[],dispatch:null,submission:null,conflicted:false};}
 /** Called only by the dispatcher after a complete, accepted upload. Private
  * URLs and exact wire identities stay in the existing backend outbox. */
 recordUpload(jobId:string,attemptId:string,stage:StageItem,url:string,responseRecord:string){return this.transaction(()=>{
  const job=this.job(jobId),attempt=job.attempts.find(value=>value.id===attemptId);
  if(this.deleted(job.documentId)||!attempt||attempt.state!=='not-started'||attempt.count!=='reserved'||!attempt.hold||attempt.writerEpoch!==this.epoch)throw new StoreError('STALE_EPOCH');
  if(job.stagePlan.length>5||job.stagePlan.filter(value=>value.role===stage.role).length!==1||!job.stagePlan.some(value=>canonical(value)===canonical(stage)))throw new StoreError('CORRUPT_OBJECT');
  const pair=this.runtimePair(responseRecord,attemptId,'upload');if(!pair)return false;
  const response=this.evidence.inspect(responseRecord),request=this.evidence.inspect(pair.request.recordId);
  if(pair.request.bodyHash!==stage.transport.hash||request.retainedBytes!==stage.transport.byteLength||BigInt(response.retainedBytes)>65536n||typeof url!=='string'||url.length>16384)throw new StoreError('CORRUPT_OBJECT');
  const value=parseControlJSON(Buffer.concat([...this.evidence.read(responseRecord)])) as {url?:unknown};if(value.url!==url)throw new StoreError('CORRUPT_OBJECT');
  const out=this.outbox(attemptId),wire=out.wireEvidence??this.newWireEvidence(),entry:RuntimeUploadEvidence={stage:structuredClone(stage),url,...pair};
  const previous=wire.uploads.find(item=>item.stage.role===stage.role);
  if(previous){if(canonical(previous)!==canonical(entry))wire.conflicted=true;}
  else if(wire.uploads.length<5)wire.uploads.push(entry);else wire.conflicted=true;
  out.wireEvidence=wire;this.writeOutbox(attemptId,jobId,out);return true;
 });}
 private transaction<T>(fn:()=>T):T{this.check();const before=this.observeEligibility();this.db.exec('BEGIN IMMEDIATE');try{const result=fn(),after=this.observeEligibility();this.check();this.db.exec('COMMIT');this.eligibleChanged(before,after);return result;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
 reserve(jobId:string){const result=this.transaction(()=>{
  const job=this.job(jobId),a=job.attempts.at(-1)!;if(this.deleted(job.documentId))return null;if(a.state!=='not-started'||job.local==='locally-cancelled')return null;
  // Neither replay, local acceptance, nor an injected scheduler can turn a
  // V4.5 request into a billable attempt while its admission is unavailable.
  if(queueModelAdmission(job.review)!=='provider-profile-required')return null;
  if(a.count==='reserved')return {job,attempt:a};
  if(this.firstEligible()?.id!==jobId)return null;
  const session=this.session(),counts=this.counts(session.id);if(counts.active)return null;
  const used=counts.reserved+counts.dispatched;
  if(session.cap!==null&&used>=session.cap){job.local='paused-spend-cap';job.version=String(BigInt(job.version)+1n);this.record('job',job,'PausedSpendCap');return null;}
  a.count='reserved';a.spendSessionId=session.id;a.hold=true;a.writerEpoch=this.epoch;a.version=String(BigInt(a.version)+1n);job.local='ready-to-dispatch';job.version=String(BigInt(job.version)+1n);this.record('job',job,'AttemptReserved');return {job,attempt:a};
 });if(result)localQueuePhases.eligible(jobId,result.job.documentId,result.attempt.id);return result;}
 dispatch(jobId:string,attemptId:string,mapping:Record<string,string>,policy:AppliedPrivacyPolicy){
  // Materialize exact body once before the fence, preserving exact integer seed tokens.
  this.check();const job=this.job(jobId),a=job.attempts.find(a=>a.id===attemptId);if(this.deleted(job.documentId)||!a||a.state!=='not-started'||a.count!=='reserved'||!a.hold)throw new StoreError('STALE_EPOCH');
  if(queueModelAdmission(job.review)!=='provider-profile-required')throw new AssetRejection('INCOMPATIBLE','V45_SAFETY_ADMISSION_BLOCKED');
  const template=new TextDecoder('utf-8',{fatal:true}).decode(readRequestBytes(this.objects,job.review.template));
  for(const item of job.stagePlan)this.objects.verify(item.transport);
  // V4.5 retains prompt bytes by reference. Hydration verifies that exact
  // object; metadata or the current editor contents cannot replace it.
  const prompt=isV45Request(job.review.request)?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readRequestBytes(this.objects,job.review.prompt)):undefined;
  const text=materializeTransportTemplate(template,job.review.request,job.stagePlan,mapping,prompt);
  const bytes=Buffer.from(text),payloadHash=hashBytes(bytes),sink=this.evidence.begin(a.id,'request',r31Reservation(this.objects,'queue-body:'+a.id,'provider-request',this.check),policy);
  let body;try{for(let i=0;i<bytes.length;i+=1048576)sink.append(bytes.subarray(i,i+1048576));body=sink.finish(true);}catch(e){sink.finish(false);throw e;}
  this.barrier('queue-before-dispatch-fence');
  const result=this.transaction(()=>{
   const current=this.job(jobId),attempt=current.attempts.find(a=>a.id===attemptId)!;
   const session=this.session(),counts=this.counts(session.id,attemptId);if(this.deleted(current.documentId)||attempt.state!=='not-started'||attempt.count!=='reserved'||!attempt.hold||counts.active)throw new StoreError('STALE_EPOCH');
   const used=counts.reserved+counts.dispatched;
   if(session.cap!==null&&used>=session.cap){attempt.count='released';attempt.hold=false;attempt.version=String(BigInt(attempt.version)+1n);current.local='paused-spend-cap';current.version=String(BigInt(current.version)+1n);this.record('job',current,'PausedSpendCap');return null;}
   attempt.spendSessionId=session.id;
   attempt.state='dispatching';attempt.count='dispatched';attempt.writerEpoch=this.epoch;attempt.payloadHash=payloadHash;attempt.version=String(BigInt(attempt.version)+1n);current.version=String(BigInt(current.version)+1n);
   const out=this.outbox(attempt.id),wire=out.wireEvidence??this.newWireEvidence();
   const binding={reviewToken:current.review.token,stagePlanHash:hashBytes(canonical(current.stagePlan)),mappingHash:hashBytes(canonical(mapping)),payloadHash};
   if(wire.dispatch&&canonical(wire.dispatch)!==canonical(binding))wire.conflicted=true;
   if(!wire.dispatch)wire.dispatch=binding;
   if(wire.uploads.length!==current.stagePlan.length||current.stagePlan.some(stage=>!wire.uploads.some(item=>canonical(item.stage)===canonical(stage)&&item.url===mapping[stage.role])))wire.conflicted=true;
   Object.assign(out,{state:'dispatching',epoch:this.epoch,mapping,bodyRecord:body.recordId,payloadHash,wireEvidence:wire});this.writeOutbox(attempt.id,jobId,out);this.record('job',current,'AttemptDispatching');this.barrier('queue-dispatch-before-commit');return {jobId,attemptId,epoch:this.epoch,endpoint:current.review.endpoint,payloadHash,bodyRecord:body.recordId,bytes};
  });this.barrier('queue-dispatch-after-commit');return result;
 }
 outcome(jobId:string,attemptId:string,epoch:string,outcome:{kind:'uncertain';reason:string}|{kind:'ack';requestId:string;urls:NonNullable<Outbox['urls']>;responseRecord:string}|{kind:'terminal';status:string}){
  return this.transaction(()=>{if(epoch!==this.epoch)throw new StoreError('STALE_EPOCH');const job=this.job(jobId),a=job.attempts.find(a=>a.id===attemptId);if(!a||!['dispatching','submission-uncertain','acknowledged'].includes(a.state))throw new StoreError('STALE_EPOCH');const out=this.outbox(attemptId);
   if(outcome.kind==='ack'){
    if(a.requestId&&a.requestId!==outcome.requestId)throw new StoreError('MALFORMED_REQUEST');
    // Capture only the first live dispatch acknowledgment. Recovery can restore
    // semantic request identity, but cannot retrospectively mint runtime proof.
    const wire=out.wireEvidence;
    if(a.state==='dispatching'&&out.state==='dispatching'&&out.epoch===epoch&&wire?.dispatch&&!wire.submission){
     const pair=this.runtimePair(outcome.responseRecord,attemptId,'submit');
     if(pair){
      const response=this.evidence.inspect(pair.response.recordId),request=this.evidence.inspect(pair.request.recordId),snapshot=out.bodyRecord?this.evidence.inspect(out.bodyRecord):null;
      const binding={reviewToken:job.review.token,stagePlanHash:hashBytes(canonical(job.stagePlan)),mappingHash:hashBytes(canonical(out.mapping)),payloadHash:out.payloadHash!};
      if(!snapshot||pair.request.bodyHash!==out.payloadHash||pair.request.bodyHash!=='sha256:'+snapshot.sha256||request.retainedBytes!==snapshot.retainedBytes||canonical(binding)!==canonical(wire.dispatch))throw new StoreError('CORRUPT_OBJECT');
      if(BigInt(response.retainedBytes)>65536n)throw new StoreError('CORRUPT_OBJECT');
      const ack=parseControlJSON(Buffer.concat([...this.evidence.read(pair.response.recordId)])) as {request_id?:unknown};if(ack.request_id!==outcome.requestId)throw new StoreError('CORRUPT_OBJECT');
      wire.submission={...binding,body:pair.request,response:pair.response};
     }
    }
    if(wire?.submission&&wire.submission.response.recordId!==outcome.responseRecord)wire.conflicted=true;
    a.requestId=outcome.requestId;a.state='acknowledged';a.uncertainReason=null;Object.assign(out,{state:'acknowledged',requestId:outcome.requestId,urls:outcome.urls,responseRecord:outcome.responseRecord});
   }
   else if(outcome.kind==='terminal'){if(!a.requestId)throw new StoreError('MALFORMED_REQUEST');a.state='provider-terminal';a.terminal=outcome.status;a.hold=false;out.state='terminal';}
   else{a.state='submission-uncertain';a.uncertainReason=outcome.reason;out.state='uncertain';}
   a.version=String(BigInt(a.version)+1n);job.version=String(BigInt(job.version)+1n);this.writeOutbox(a.id,job.id,out);this.record('job',job,outcome.kind==='ack'?'AttemptAcknowledged':outcome.kind==='terminal'?'ProviderTerminal':'SubmissionUncertain');this.barrier('queue-outcome-before-commit');return job;
  });
 }
 recovery(jobId:string,attemptId:string){this.check();const job=this.job(jobId),attempt=job.attempts.find(a=>a.id===attemptId);if(!attempt)throw new StoreError('NOT_FOUND');return {jobId,documentId:job.documentId,attempt,endpoint:job.review.endpoint,outbox:this.outbox(attemptId),epoch:this.epoch};}
 resultFence(jobId:string,attemptId:string){
  this.check();const job=this.job(jobId),attempt=job.attempts.find(a=>a.id===attemptId);
  if(!attempt?.requestId||!['acknowledged','provider-terminal'].includes(attempt.state)||!this.db.prepare('SELECT 1 FROM documents WHERE id=?').get(job.documentId)||this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(job.documentId))throw new StoreError('STALE_EPOCH');
  return {jobId,attemptId,requestId:attempt.requestId,epoch:this.epoch,jobVersion:job.version};
 }
 assertResult(f:import('../../src/protocol/candidates.js').ResultFence){const current=this.resultFence(f.jobId,f.attemptId);if(canonical(current)!==canonical(f))throw new StoreError('STALE_EPOCH');return this.job(f.jobId);}
 resultTransaction<T>(f:import('../../src/protocol/candidates.js').ResultFence,build:(job:QueueJob)=>T){return this.transaction(()=>build(this.assertResult(f)));}
 resultTerminal(job:QueueJob,attemptId:string,status:'completed'|'failed'|'cancelled'){
  const a=job.attempts.find(a=>a.id===attemptId)!;a.state='provider-terminal';a.terminal=status;a.hold=false;if(status==='cancelled')a.cancel='confirmed';a.version=String(BigInt(a.version)+1n);job.version=String(BigInt(job.version)+1n);
  const out=this.outbox(a.id);out.state='terminal';this.writeOutbox(a.id,job.id,out);this.record('job',job,'ProviderTerminal');
 }
 async close(){await Promise.allSettled([...this.preparing.values()].map(p=>p.promise));}
}

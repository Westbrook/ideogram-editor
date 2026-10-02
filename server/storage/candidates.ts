import {serverPhases} from '../observability/phases.js';
import {adapterResources} from '../observability/adapter-resources.js';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import type {DatabaseSync} from 'node:sqlite';
import type {Candidate,CandidateView,ResultFence,ObservationState,ResultProvenance,CandidateAdoptionIdentity,CandidateAdoptionInputs,AdoptionCoverage} from '../../src/protocol/candidates.js';
export type {CandidateAdoptionInputs} from '../../src/protocol/candidates.js';
import type {BlobRef} from '../../src/protocol/store.js';
import type {Asset} from '../../src/protocol/assets.js';
import type {Objects} from './objects.js';
import type {Assets} from './assets.js';
import type {Rasters} from './raster.js';
import type {QueueStore,RuntimeWireRef} from './queue.js';
import type {QueueJob} from '../../src/protocol/queue.js';
import type {ProtectedBody,AppliedPrivacyPolicy} from '../provider/contracts.js';
import {ProviderError} from '../provider/contracts.js';
import type {ProviderBoundary} from '../provider/client.js';
import {scanEnvelope,deriveProvenance,deriveUnavailableV45Provenance} from '../provider/provenance.js';
import {adaptResponse,type ResponseDescriptor} from '../provider/response-adapter.js';
import {reviewedResponseProfile} from '../provider/response-profile.js';
import {r31Reservation} from '../provider/evidence.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {parseCaption,LIMITS} from '../../src/composition/core.js';
import {canonical,hashBytes,isId} from './canonical.js';
import {asset as validateAsset,rasterManifest as validateRasterManifest} from '../../src/protocol/validate.js';
import {PIPELINE as PRESERVATION_PIPELINE} from '../raster/profile-registry.js';
import {StoreError} from './errors.js';
import {AssetRejection} from './assets.js';
import {validateRequestSourceCapture,type RequestSourceCapture} from '../../src/protocol/request-edits.js';
import {requireRequestMaskPlan,requestMaskDependencies} from '../../src/request/core.js';
import {isV45Request} from '../../src/request/family.js';
import {requireActualOutput,requireOutputMapping,requirePlanDependencies,requireRequestCoverage,inspectRequestCoverage,createActualOutputMapping,clipRequestCoverage,type RequestRasterPlan,type RequestOutputMapping} from '../../src/request/raster-plan.js';

export type CandidateWireEvidence={kind:'candidate-wire-evidence-1';status:RuntimeWireRef|null;result:RuntimeWireRef|null;contradictions:RuntimeWireRef[];overflow:boolean};
export type CandidateOutputWireEvidence={kind:'candidate-output-wire-1';result:RuntimeWireRef;index:number;image:Record<string,unknown>;safe:boolean};
type Retained={jobId:string;attemptId:string;documentId:string;observation:ObservationState;requestedCount:number;actualCount:number|null;provenance:ResultProvenance|null;wireEvidence?:CandidateWireEvidence};
type PrivateSlot={url:string|null;expectedBytes:number|null;mime:string|null;width:number|null;height:number|null;mediaRecord:string|null;mediaEvidence?:RuntimeWireRef;outputEvidence?:CandidateOutputWireEvidence;retryRequested:boolean};
type AdoptionOptions={expectedVersion?:string;actualOutput?:{width:number;height:number;clipMask:boolean}|null};
type AdoptionPreparation=Omit<CandidateAdoptionInputs,'kind'|'mode'>&{asset:Asset;proofs:{ref:BlobRef;token:string}[];frozen:CandidateAdoptionInputs;preparation:'deferred'|'prepared-reuse';check:()=>void};
/** All mutations execute in the sole writer. Public views contain no transport address. */
export class Candidates {
 resourceOwnership(){return {transfers:this.transfers.size};}
 private closing=false;private transfers=new Map<string,{documentId:string;controller:AbortController}>();
 constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private rasters:Rasters,readonly queue:QueueStore,
  private check:()=>void,private register:(owner:string,ref:BlobRef,proof?:string)=>void){
  db.exec('BEGIN IMMEDIATE');try{
  queue.candidateAction=(body,slot)=>this.command(body,slot);
  for(const row of db.prepare('SELECT family,id,json FROM candidate_journal ORDER BY seq').iterate()){
   if(row.family==='asset')db.prepare('INSERT INTO assets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(row.id,row.json);
   else if(row.family==='job')db.prepare('INSERT INTO candidate_jobs VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET json=excluded.json').run(row.id,row.json);
   else if(row.family==='candidate'){const c=JSON.parse(String(row.json));db.prepare('INSERT INTO candidates VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(row.id,c.documentId,c.jobId,row.json);}
  }
  for(const row of db.prepare("SELECT json FROM candidates WHERE json_extract(json,'$.state') IN ('received','downloaded')").all()){const c:Candidate=JSON.parse(String(row.json));c.state=c.encodedAssetId?'preparation-failed':'transfer-failed';c.warning='Local preparation was interrupted. Retry keeps this output identity.';c.version=String(BigInt(c.version)+1n);this.save('candidate',c.id,c);}
  db.exec('COMMIT');}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
 }
 private save(family:'job'|'candidate'|'asset',id:string,value:unknown){
  const text=canonical(value);this.db.prepare('INSERT INTO candidate_journal(family,id,json) VALUES (?,?,?)').run(family,id,text);
  if(family==='job')this.db.prepare('INSERT INTO candidate_jobs VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET json=excluded.json').run(id,text);
  else if(family==='candidate'){const c=value as Candidate;this.db.prepare('INSERT INTO candidates VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id,c.documentId,c.jobId,text);}
  else this.db.prepare('INSERT INTO assets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id,text);
 }
 private retained(f:ResultFence):Retained{
  const row=this.db.prepare('SELECT json FROM candidate_jobs WHERE job_id=?').get(f.attemptId);if(row)return JSON.parse(String(row.json));
  const job=this.queue.assertResult(f);return {jobId:job.id,attemptId:f.attemptId,documentId:job.documentId,requestedCount:job.review.request.settings.count,actualCount:null,provenance:null,
   observation:{phase:'queued',nextPollAt:0,failures:0,mode:'healthy',digest:null,resultDigest:null,warning:null}};
 }
 private source(f:ResultFence,source:ProtectedBody){this.queue.assertResult(f);const actual=this.queue.evidence.inspect(source.recordId);if(actual.attemptId!==f.attemptId||actual.direction!=='response'||canonical(actual)!==canonical({...actual,...source}))throw new StoreError('STALE_EPOCH');return actual;}
 private newWireEvidence():CandidateWireEvidence{return {kind:'candidate-wire-evidence-1',status:null,result:null,contradictions:[],overflow:false};}
 private wireRef(f:ResultFence,source:ProtectedBody,role:'status'|'result'){
  const url=this.queue.recovery(f.jobId,f.attemptId).outbox.urls?.[role];
  return url?this.queue.runtimeWireRef(source.recordId,f.attemptId,'response',role,url):null;
 }
 private wireContradiction(r:Retained,source:ProtectedBody){
  const meta=this.queue.evidence.inspect(source.recordId),ref={recordId:meta.recordId,bodyHash:'sha256:'+meta.sha256,metadataHash:hashBytes(canonical(meta))};
  const wire=r.wireEvidence??this.newWireEvidence();
  // This reference can describe a partial/malformed body. Its presence denies
  // qualification; it is never interpreted as successful wire provenance.
  if(!wire.contradictions.some(value=>canonical(value)===canonical(ref))){if(wire.contradictions.length<16)wire.contradictions.push(ref);else wire.overflow=true;}
  r.wireEvidence=wire;
 }
 private quarantine(attemptId:string){
  for(const row of this.db.prepare("SELECT json FROM candidates WHERE json_extract(json,'$.attemptId')=?").all(attemptId)){
   const c:Candidate=JSON.parse(String(row.json));c.safety='unknown';c.state='withheld';c.warning='Conflicting result evidence requires reconciliation.';c.version=String(BigInt(c.version)+1n);this.save('candidate',c.id,c);
   for(const id of [c.encodedAssetId,c.preparedAssetId])if(id){const a=this.assets.asset(id);if(a)this.save('asset',id,{...a,safety:'quarantined'});}
  }
 }
 observe(f:ResultFence,source:ProtectedBody,now:number,background=false){
  const phase=serverPhases.start('job.observe',{jobId:f.jobId,attemptId:f.attemptId,providerRequestId:f.requestId});
  try{
  const meta=this.source(f,source);let value:any=null;try{if(meta.completeness==='complete'&&BigInt(meta.retainedBytes)<=65536n)value=parseControlJSON(Buffer.concat([...this.queue.evidence.read(meta.recordId)]));}catch{/* Protected original remains available for reconciliation. */}
  const result=this.queue.resultTransaction(f,job=>{
   const r=this.retained(f),o=r.observation,previousPhase=o.phase;
   const phase=value?.request_id===f.requestId?value.status==='CANCELLED'?'cancelled':value.status==='IN_QUEUE'?'queued':value.status==='IN_PROGRESS'?'running':value.status==='COMPLETED'?(value.error||value.error_type?'failed':'completed'):null:null;
   const digest=hashBytes(canonical({requestId:value?.request_id??null,phase}));
   if(!phase||o.phase==='quarantined'||(['completed','failed','cancelled'].includes(o.phase)&&['completed','failed','cancelled'].includes(phase)&&phase!==o.phase)){
    this.wireContradiction(r,source);o.warning='Provider observations conflict or are malformed; reconciliation is required.';o.phase='quarantined';o.nextPollAt=0;this.quarantine(f.attemptId);
   }else if(!(['completed','failed','cancelled'].includes(o.phase)&&!['completed','failed','cancelled'].includes(phase))&&!(o.phase==='running'&&phase==='queued')){
    if(o.phase!==phase&&['completed','failed','cancelled'].includes(phase))this.queue.resultTerminal(job,f.attemptId,phase as 'completed'|'failed'|'cancelled');
    o.phase=phase;o.digest=digest;o.failures=0;o.mode='healthy';o.nextPollAt=['completed','failed','cancelled'].includes(phase)?0:now+(background?15000:2000);
    if(phase==='completed'&&previousPhase!=='completed'&&!r.observation.resultDigest){const ref=this.wireRef(f,source,'status');if(ref){const wire=r.wireEvidence??this.newWireEvidence();if(!wire.status)wire.status=ref;r.wireEvidence=wire;}}
   }
   if(!['completed','failed','cancelled','quarantined'].includes(o.phase)){o.nextPollAt=now+(background?15000:2000);o.failures=0;o.mode='healthy';}
   this.save('job',f.attemptId,r);return {view:this.view(job.id,f.attemptId),fence:this.queue.resultFence(job.id,f.attemptId)};
  });
  phase.end('ok',{boundary:'authority-durable'});
  const observedPhase=result.view.observation?.phase;
  if(observedPhase==='queued'||observedPhase==='running')serverPhases.instant(observedPhase==='queued'?'job.provider_queue':'job.provider_run',{jobId:f.jobId,attemptId:f.attemptId,providerRequestId:f.requestId,boundary:'observed',observationSource:'local-poll',timingConfidence:'observation-only'});
  return result;
  }catch(error){phase.end('error');throw error;}
 }
 backoff(f:ResultFence,now:number,retryAfterMs=0,offline=false,jitter=Math.random()){return this.queue.resultTransaction(f,()=>{
  const r=this.retained(f),o=r.observation;o.failures++;o.mode=offline?'offline':'backoff';o.nextPollAt=now+Math.max(retryAfterMs,Math.min(300000,2000*2**Math.min(o.failures,7))*(.75+Math.max(0,Math.min(1,jitter))*.5));this.save('job',f.attemptId,r);return o;
 });}
 due(now:number,eligible?:(jobId:string,attemptId:string)=>boolean){
  this.check();const result:ResultFence[]=[];let cursor='';
  do{const page=this.queue.view(cursor);for(const j of page.jobs)for(const a of j.attempts)if(!a.recoveryRequired&&a.requestId&&['acknowledged','provider-terminal'].includes(a.state)){
   if(eligible&&!eligible(j.id,a.id))continue;
   let f:ResultFence;try{f=this.queue.resultFence(j.id,a.id);}catch(e){if(e instanceof StoreError&&e.code==='STALE_EPOCH')continue;throw e;}const r=this.retained(f);
   if(!['quarantined','failed','cancelled'].includes(r.observation.phase)&&!r.observation.resultDigest&&r.observation.nextPollAt<=now)result.push(f);
   if(result.length===20)return result;
  }cursor=page.nextCursor??'';}while(cursor);return result;
 }
 private copyBody(body:ProtectedBody,mediaType:string):BlobRef{
  const meta=this.queue.evidence.inspect(body.recordId);if(meta.completeness!=='complete')throw new StoreError('MISSING_OBJECT');
  const stage=this.objects.begin(meta.retainedBytes,mediaType,'sha256:'+meta.sha256);
  try{for(const bytes of this.queue.evidence.read(body.recordId))this.objects.chunk(stage,bytes);return this.objects.finish(stage);}catch(e){this.objects.abort(stage);throw e;}
 }
 responseProfile(f:ResultFence):ResponseDescriptor{return reviewedResponseProfile(this.queue.assertResult(f).review);}
 receive(f:ResultFence,source:ProtectedBody,policy:AppliedPrivacyPolicy,secrets:readonly string[],expectedProfile?:ResponseDescriptor){
  const responseProfile=this.responseProfile(f);
  if(expectedProfile&&canonical(expectedProfile)!==canonical(responseProfile))throw new StoreError('STALE_EPOCH');
  if(responseProfile.profile==='ideogram-v45-result-1')return this.receiveV45(f,source,policy,responseProfile);
  const meta=this.source(f,source);const old=this.retained(f);
  if(old.observation.resultDigest){if(old.observation.resultDigest!==source.sha256)this.queue.resultTransaction(f,()=>{this.wireContradiction(old,source);old.observation.phase='quarantined';old.observation.warning='Contradictory completed result retained for reconciliation.';this.quarantine(f.attemptId);this.save('job',f.attemptId,old);});return this.view(f.jobId,f.attemptId);}
  let envelope:ReturnType<typeof scanEnvelope>|null=null;try{if(meta.completeness==='complete')envelope=scanEnvelope(this.queue.evidence.read(source.recordId),()=>{});}catch{/* No guessed image ownership after malformed envelope. */}
  const derived=deriveProvenance({store:this.queue.evidence,source,promptSink:this.queue.sink(f.attemptId,'response',policy),endpoint:this.queue.recovery(f.jobId,f.attemptId).endpoint,requestId:f.requestId,status:'completed',policy,knownTransportSecrets:secrets});
  const valid=!!envelope?.imagesArray&&envelope.seed!==null&&envelope.timingsObject&&envelope.timingsValid;
  const returned=derived.record.returnedPromptRef?this.copyBody(derived.prompt,'text/plain'):null;
  let inspection:ResultProvenance['inspection']=returned?'opaque':'unavailable';
  if(returned&&BigInt(returned.byteLength)<=BigInt(LIMITS.bytes)){this.objects.verify(returned);const raw=this.objects.readRange(returned,'0',Number(returned.byteLength));if(parseCaption(raw).state==='supported')inspection='supported';}
  const policyRef=this.objects.putMetadata(Buffer.from(canonical({...policy,evidenceDigest:policy.evidenceDigest.startsWith('sha256:')?policy.evidenceDigest:'sha256:'+policy.evidenceDigest})));
  return this.queue.resultTransaction(f,job=>{
   const r=this.retained(f),e=envelope;let resultWire:RuntimeWireRef|null=null;
   if(valid){const ref=this.wireRef(f,source,'result');if(ref){const wire=r.wireEvidence??this.newWireEvidence();if(!wire.result){wire.result=ref;resultWire=ref;}r.wireEvidence=wire;}}
   else this.wireContradiction(r,source);
   // A result cannot overturn a provider terminal failure/cancellation. Local
   // cancel intent is a separate job disposition and still permits late success.
   if(['failed','cancelled'].includes(r.observation.phase))this.wireContradiction(r,source);
   const reconciled=!['quarantined','failed','cancelled'].includes(r.observation.phase)&&!r.wireEvidence?.contradictions.length&&!r.wireEvidence?.overflow;
   r.observation.resultDigest=source.sha256;r.actualCount=e?.imagesArray?e.images.length:null;
   r.observation.phase=valid&&reconciled?'completed':'quarantined';r.observation.warning=valid?(reconciled?null:'Conflicting result evidence remains quarantined; reconciliation is required.'):'Malformed completion; result remains quarantined.';
   r.provenance={requestedPrompt:job.review.prompt,submittedPrompt:job.review.prompt,returnedPrompt:returned,returnedBytes:derived.prompt.receivedBytes,complete:derived.record.derivation.complete,quarantined:derived.quarantined,inspection,warning:derived.warning,requestedSeed:job.review.request.settings.seed.kind==='integer'?job.review.request.settings.seed.decimal:null,returnedSeed:e?.seed??null,timings:e?.timings??{},timingUnits:'unknown',sourceBodyHash:'sha256:'+source.sha256,privacyPolicy:policyRef};
   const rooted=new Set<string>();for(const ref of [job.review.prompt,policyRef,...(returned?[returned]:[])])if(!rooted.has(ref.hash)){this.register('candidate-provenance:'+f.attemptId,ref);rooted.add(ref.hash);}
   const count=Math.max(r.requestedCount,r.actualCount??0),aligned=valid&&reconciled&&e!.safetyArray&&e!.safety.length===e!.images.length&&e!.safety.every(v=>typeof v==='boolean');
   for(let i=0;i<count;i++){
    const image=e?.images[i],present=!!image&&typeof image.url==='string';
    const safety=aligned?e!.safety[i]===false?'safe':e!.safety[i]===true?'withheld':'unknown':'unknown';
    const identity=hashBytes(canonical([f.requestId,i,image??null])),id='c_'+hashBytes(canonical([f.attemptId,i,identity])).slice(7);
    const candidate:Candidate={id,version:'1',documentId:job.documentId,jobId:job.id,attemptId:f.attemptId,requestId:f.requestId,outputIndex:i,outputIdentity:identity,safety,state:!present?'missing':safety==='safe'?'received':'withheld',hidden:false,encodedAssetId:null,preparedAssetId:null,warning:!present?'Requested output is missing.':safety!=='safe'?'Safety is withheld or cannot be matched to this output.':null};
    this.save('candidate',id,candidate);
    const numeric=(k:string)=>image?.[k]===undefined||image?.[k]===null?null:typeof image[k]==='number'&&Number.isSafeInteger(image[k])&&Number(image[k])>=0?Number(image[k]):-1;
    const privateSlot:PrivateSlot={url:present?String(image!.url):null,expectedBytes:numeric('file_size'),mime:image?.content_type===undefined||image.content_type===null?null:typeof image.content_type==='string'?image.content_type:'invalid',width:numeric('width'),height:numeric('height'),mediaRecord:null,retryRequested:false};
    // Retain only the scanner's bounded output header, joined to the first
    // actual result proof. No prompt rescan or legacy backfill is required by
    // runtime eligibility reads. Unexpected output counts remain retained but
    // cannot mint this bounded 1–4-output witness.
    if(resultWire&&present&&e!.images.length>=1&&e!.images.length<=4&&i<e!.images.length)privateSlot.outputEvidence={kind:'candidate-output-wire-1',result:resultWire,index:i,image:structuredClone(image!),safe:aligned&&e!.safety[i]===false};
    this.db.prepare('INSERT INTO candidate_private VALUES (?,?)').run(id,canonical(privateSlot));
   }
   this.save('job',f.attemptId,r);return this.view(job.id,f.attemptId);
  });
 }
 /** Separate versioned path: legacy receive and its serialized objects stay unchanged. */
 private receiveV45(f:ResultFence,source:ProtectedBody,policy:AppliedPrivacyPolicy,responseProfile:ResponseDescriptor){
  const meta=this.source(f,source),old=this.retained(f);
  if(old.observation.resultDigest){if(old.observation.resultDigest!==source.sha256)this.queue.resultTransaction(f,()=>{old.observation.phase='quarantined';old.observation.warning='Contradictory completed result retained for reconciliation.';this.quarantine(f.attemptId);this.save('job',f.attemptId,old);});return this.view(f.jobId,f.attemptId);}
  let envelope:ReturnType<typeof scanEnvelope>|null=null;
  try{if(meta.completeness==='complete')envelope=scanEnvelope(this.queue.evidence.read(source.recordId),()=>{},{profile:'ideogram-v45-result-1'});}catch{/* No guessed output ownership after malformed envelope. */}
  const job=this.queue.assertResult(f),adapted=adaptResponse(responseProfile,{requestedCount:job.review.request.settings.count,sourceComplete:meta.completeness==='complete',envelope});
  const policyRef=this.objects.putMetadata(Buffer.from(canonical({...policy,evidenceDigest:policy.evidenceDigest.startsWith('sha256:')?policy.evidenceDigest:'sha256:'+policy.evidenceDigest})));
  const provenance=deriveUnavailableV45Provenance({store:this.queue.evidence,source,adapted,requestedPrompt:job.review.prompt,submittedPrompt:job.review.prompt,requestedSeed:job.review.request.settings.seed.kind==='integer'?job.review.request.settings.seed.decimal:null,privacyPolicy:policyRef});
  return this.queue.resultTransaction(f,current=>{
   const r=this.retained(f);
   if(['failed','cancelled'].includes(r.observation.phase))this.wireContradiction(r,source);
   const reconciled=!['quarantined','failed','cancelled'].includes(r.observation.phase)&&!r.wireEvidence?.contradictions.length&&!r.wireEvidence?.overflow;
   r.observation.resultDigest=source.sha256;r.actualCount=adapted.actualCount;r.observation.phase=reconciled?adapted.observationPhase:'quarantined';
   r.observation.warning=adapted.envelope.schemaValid?(reconciled?'Provider safety metadata is unavailable; image bytes remain protected and cannot be displayed, decoded, adopted or exported.':'Conflicting result evidence remains quarantined; reconciliation is required.'):'Malformed completion; result remains quarantined.';
   r.provenance=provenance;
   const rooted=new Set<string>();for(const ref of [current.review.prompt,policyRef])if(!rooted.has(ref.hash)){this.register('candidate-provenance:'+f.attemptId,ref);rooted.add(ref.hash);}
   for(const output of adapted.outputs){
    const i=output.index,image=envelope?.images[i],identity=hashBytes(canonical([f.requestId,i,image??null])),id='c_'+hashBytes(canonical([f.attemptId,i,identity])).slice(7);
    const candidate:Candidate={id,version:'1',documentId:current.documentId,jobId:current.id,attemptId:f.attemptId,requestId:f.requestId,outputIndex:i,outputIdentity:identity,safety:'unknown',state:output.present?'withheld':'missing',hidden:false,encodedAssetId:null,preparedAssetId:null,warning:output.present?'Provider safety metadata is unavailable; protected original retention does not permit image publication.':'Requested output is missing.'};
    this.save('candidate',id,candidate);
    const numeric=(k:string)=>image?.[k]===undefined||image?.[k]===null?null:typeof image[k]==='number'&&Number.isSafeInteger(image[k])&&Number(image[k])>=0?Number(image[k]):-1;
    const privateSlot:PrivateSlot={url:output.present?String(image!.url):null,expectedBytes:numeric('file_size'),mime:image?.content_type===undefined||image.content_type===null?null:typeof image.content_type==='string'?image.content_type:'invalid',width:null,height:null,mediaRecord:null,retryRequested:false};
    this.db.prepare('INSERT INTO candidate_private VALUES (?,?)').run(id,canonical(privateSlot));
   }
   this.save('job',f.attemptId,r);return this.view(current.id,f.attemptId);
  });
 }
 private candidate(id:string):Candidate{if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT json FROM candidates WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');return JSON.parse(String(row.json));}
 private update(f:ResultFence,id:string,patch:Partial<Candidate>){return this.queue.resultTransaction(f,()=>{const c=this.candidate(id);if(c.attemptId!==f.attemptId)throw new StoreError('STALE_EPOCH');Object.assign(c,patch,{version:String(BigInt(c.version)+1n)});this.save('candidate',id,c);return c;});}
 async transfer(f:ResultFence,id:string,provider:ProviderBoundary,policy:AppliedPrivacyPolicy,signal?:AbortSignal){
  this.queue.assertResult(f);const initial=this.candidate(id),controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const releaseCoverage=adapterResources.uncovered('candidate-transfer');this.transfers.set(id,{documentId:initial.documentId,controller});
  try{return await this.transferOwned(f,id,provider,policy,controller.signal);}catch(error){
   if(this.queue.deleted(initial.documentId))return;
   if(error instanceof ProviderError){
    const current=this.queue.resultFence(f.jobId,f.attemptId),candidate=this.candidate(id);
    if(current.epoch!==f.epoch||current.requestId!==f.requestId)throw error;
    if(this.responseProfile(current).profile==='ideogram-v45-result-1')this.update(current,id,{state:'withheld',warning:'Protected original transfer was refused or interrupted. Safety remains unknown; no image publication or ordinary import retry is available.'});
    else if(candidate.safety==='safe'&&['received','downloaded','transfer-failed','preparation-failed'].includes(candidate.state))this.update(current,id,{state:candidate.encodedAssetId?'preparation-failed':'transfer-failed',warning:current.jobVersion!==f.jobVersion?'Request controls changed during import. Retry keeps this output and never submits a replacement request.':'Image transfer was refused or interrupted. Retry retrieves this same output without generating a replacement.'});
    return;
   }
   if(!(error instanceof StoreError)||error.code!=='STALE_EPOCH')throw error;
   const current=this.queue.resultFence(f.jobId,f.attemptId),candidate=this.candidate(id);
   if(current.epoch!==f.epoch||current.requestId!==f.requestId||current.jobVersion===f.jobVersion)throw error;
   // A control action can invalidate in-flight publication without losing the output's retry path.
   // The old fence remains invalid; only an explicit retry may retrieve or prepare this same output.
   if(!['received','downloaded'].includes(candidate.state))throw error;
   this.update(current,id,{state:candidate.encodedAssetId?'preparation-failed':'transfer-failed',warning:'Request controls changed during import. Retry keeps this output and never submits a replacement request.'});
  }finally{signal?.removeEventListener('abort',abort);this.transfers.delete(id);releaseCoverage();}
 }
 abortDocument(documentId:string){for(const work of this.transfers.values())if(work.documentId===documentId)work.controller.abort();}
 private async transferOwned(f:ResultFence,id:string,provider:ProviderBoundary,policy:AppliedPrivacyPolicy,signal:AbortSignal){
  const c=this.candidate(id);this.queue.assertResult(f);const v45=this.responseProfile(f).profile==='ideogram-v45-result-1';
  if(v45&&(c.safety!=='unknown'||c.preparedAssetId!==null))throw new StoreError('CONTENT_WITHHELD');
  if(c.attemptId!==f.attemptId||c.state==='prepared'||c.state==='missing')return;
  const raw=this.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(id);if(!raw)throw new StoreError('NOT_FOUND');const p:PrivateSlot=JSON.parse(String(raw.json));if(!p.url)return;
  if(!c.encodedAssetId){
   const sink=this.queue.evidence.begin(f.attemptId,'response',r31Reservation(this.objects,'candidate-fetch:'+id,'provider-media',()=>this.queue.assertResult(f)),policy);
   const fetchPhase=serverPhases.start('result.fetch',{documentId:c.documentId,jobId:f.jobId,attemptId:f.attemptId,providerRequestId:f.requestId,candidateId:id});
   let receipt;try{receipt=await provider.media(p.url,sink,{signal,...(p.expectedBytes!==null&&p.expectedBytes>=0?{expectedBytes:BigInt(p.expectedBytes)}:{})});fetchPhase.end(receipt.outcome==='complete'&&receipt.status===200?'ok':'error',{boundary:'observed'});}catch(error){fetchPhase.end(signal.aborted?'cancelled':'error');throw error;}
   this.queue.resultTransaction(f,()=>{
    p.mediaRecord=receipt.evidence.recordId;
    if(receipt.outcome==='complete'&&receipt.status===200){const wire=this.queue.runtimeWireRef(receipt.evidence.recordId,f.attemptId,'response','media',p.url!);if(wire)p.mediaEvidence=wire;}
    this.db.prepare('UPDATE candidate_private SET json=? WHERE id=?').run(canonical(p),id);
   });
   if(receipt.outcome!=='complete'||receipt.status!==200){this.update(f,id,v45?{state:'withheld',warning:'Protected original transfer failed. Safety remains unknown; no image is available for display, adoption or export.'}:{state:'transfer-failed',warning:'Image transfer failed. Retry retrieves the same output without generating a replacement.'});return;}
   const headers=this.queue.evidence.inspect(receipt.evidence.recordId).headers,mime=headers['content-type'];
   const allowed=['image/png','image/jpeg','image/webp'];const measured=allowed.includes(mime??'')?mime!:'application/octet-stream';
   const storePhase=serverPhases.start('result.store',{documentId:c.documentId,jobId:f.jobId,attemptId:f.attemptId,providerRequestId:f.requestId,candidateId:id});
   try{const ref=this.copyBody(receipt.evidence,measured),a:Asset={id:randomUUID(),version:'1',purpose:'image',blob:ref,dependencies:[],safety:c.safety==='safe'?'unknown':c.safety,availability:'available',qualification:'pending-decoder',measuredMediaType:measured as Asset['measuredMediaType']};validateAsset(a);
   this.queue.resultTransaction(f,()=>{this.register('candidate:'+id,ref);this.save('asset',a.id,a);});c.encodedAssetId=a.id;
   const bad=!allowed.includes(measured)||p.mime!==null&&p.mime!==measured||[p.width,p.height,p.expectedBytes].some(n=>n!==null&&n<0);
   this.update(f,id,{encodedAssetId:a.id,state:c.safety!=='safe'?'withheld':bad?'preparation-failed':'downloaded',warning:bad?'Returned image metadata is invalid; original bytes are retained.':c.warning});
   storePhase.end('ok',{outputAssetId:a.id,assetHash:ref.hash,bytes:Number(ref.byteLength),boundary:'encoded-durable'});
   if(bad)return;
   }catch(error){storePhase.end('error');throw error;}
  }
  if(v45||c.safety!=='safe')return;
  const slot='candidate-prepare:'+id;this.objects.acquire(slot);
  let prepared:Awaited<ReturnType<Rasters['prepareDocument']>>|undefined;
  const preparePhase=serverPhases.start('result.prepare',{documentId:c.documentId,jobId:f.jobId,attemptId:f.attemptId,providerRequestId:f.requestId,candidateId:id,assetId:c.encodedAssetId??undefined});
  const verifyPhase=serverPhases.start('result.verify',{documentId:c.documentId,jobId:f.jobId,attemptId:f.attemptId,providerRequestId:f.requestId,candidateId:id,assetId:c.encodedAssetId??undefined});
  try{
   prepared=await this.rasters.prepareDocument({type:'PrepareCandidate',assetId:c.encodedAssetId!},randomUUID(),slot,()=>{this.queue.assertResult(f);if(this.closing)throw new StoreError('CLOSED');if(signal.aborted)throw new ProviderError('ABORTED');},undefined,c.documentId);
   const info=prepared.asset.raster!,conversion=info.conversion!;
   const metadataMismatch=p.width!==null&&p.width!==conversion.encodedWidth||p.height!==null&&p.height!==conversion.encodedHeight;
   const request=this.queue.assertResult(f).review.request,expected=isV45Request(request)?request.modelRequest.requested:'mask' in request&&request.mask.requestPlan?request.mask.requestPlan.expectedOutput:request.size.kind==='custom'?request.size:request.size.kind==='auto'&&'source' in request?request.source:null;
   const outputMismatch=!!expected&&(info.width!==expected.width||info.height!==expected.height);
   this.queue.resultTransaction(f,()=>{const rooted=new Set<string>();for(const proof of prepared!.proofs){this.objects.proven(proof.ref,proof.token);if(!rooted.has(proof.ref.hash)){this.register('candidate-prepared:'+prepared!.asset.id,proof.ref,proof.token);rooted.add(proof.ref.hash);}}this.save('asset',prepared!.asset.id,prepared!.asset);});
   verifyPhase.end('ok',{outputAssetId:prepared.asset.id,assetHash:prepared.asset.blob.hash,width:info.width,height:info.height,boundary:'prepared-durable'});
   this.update(f,id,{preparedAssetId:prepared.asset.id,state:'prepared',warning:outputMismatch?'Decoded output dimensions differ from the approved request. Original and prepared candidate retained; output mapping review is required before safe-region adoption.':metadataMismatch?'Decoded dimensions differ from provider metadata. Original and prepared candidate retained; review the actual output before placement.':null});
   // Availability requires successful byte decoding and durable ownership. A
   // plausible Content-Type on retained bytes alone is not a ready candidate.
   serverPhases.instant('result.candidate_available',{documentId:c.documentId,jobId:f.jobId,attemptId:f.attemptId,providerRequestId:f.requestId,candidateId:id,assetId:c.encodedAssetId!,outputAssetId:prepared.asset.id,width:info.width,height:info.height,boundary:'encoded-durable'});
   preparePhase.end('incomplete',{outputAssetId:prepared.asset.id,width:info.width,height:info.height,boundary:'prepared-durable'});
  }catch(e){verifyPhase.end(signal.aborted?'cancelled':'error');preparePhase.end(signal.aborted?'cancelled':'error');this.queue.assertResult(f);this.update(f,id,{state:'preparation-failed',warning:'Preparation failed; encoded original retained. Retry prepares the same candidate.'});}
  finally{for(const proof of prepared?.proofs??[])this.objects.releaseProof(proof.token);this.objects.unreserve(slot);this.objects.release(slot);}
 }
 private adoptionAsset(id:string){
  const asset=this.assets.asset(id);
  if(!asset||asset.safety!=='safe'||asset.availability!=='available'||asset.qualification!=='canonical-raster'||!asset.raster||asset.raster.role==='mask')throw new AssetRejection('INCOMPATIBLE','CANDIDATE_NOT_PREPARED');
  return asset;
 }
 private adoptionDependencies(job:QueueJob){
  const request=job.review.request;
  if('source' in request){
   const source=request.source,asset=this.adoptionAsset(source.assetId);
   if(asset.version!==source.version||canonical(asset.blob)!==canonical(source.blob)||canonical(asset.raster!.pixels)!==canonical(source.pixels)||source.capture&&canonical(asset.raster!.manifest)!==canonical(source.capture)||asset.raster!.width!==source.width||asset.raster!.height!==source.height)throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
  }
  if('mask' in request){
   const mask=request.mask,asset=this.assets.asset(mask.assetId);
   if(!asset||asset.safety!=='safe'||asset.availability!=='available'||asset.qualification!=='canonical-raster'||asset.raster?.role!=='mask'||asset.version!==mask.version||canonical(asset.blob)!==canonical(mask.blob)||canonical(asset.raster.pixels)!==canonical(mask.pixels)||canonical(asset.raster.manifest)!==canonical(mask.plan)||asset.raster.width!==mask.width||asset.raster.height!==mask.height)throw new AssetRejection('STALE_REVISION','REQUEST_MASK_CHANGED');
  }
 }
 private adoptionLookup<T>(read:()=>T):T{try{return read();}catch(e){if(e instanceof StoreError&&['STALE_EPOCH','NOT_FOUND'].includes(e.code))throw new AssetRejection('STALE_REVISION','CANDIDATE_CHANGED');throw e;}}
 /** Rechecked after async work and again when the explicitly reviewed preview is committed. */
 checkAdoption(identity:CandidateAdoptionIdentity){
  this.check();if(this.closing)throw new StoreError('CLOSED');
  this.adoptionLookup(()=>{
  const c=this.candidate(identity.candidateId);
  if(c.version!==identity.candidateVersion||c.documentId!==identity.documentId||c.jobId!==identity.jobId||c.attemptId!==identity.attemptId||c.requestId!==identity.requestId||c.outputIdentity!==identity.outputIdentity||c.preparedAssetId!==identity.preparedAssetId)throw new AssetRejection('STALE_REVISION','CANDIDATE_CHANGED');
  if(c.safety!=='safe'||c.state!=='prepared'||c.hidden||!c.preparedAssetId)throw new AssetRejection('INCOMPATIBLE','CANDIDATE_NOT_PREPARED');
  this.documentOwner(c.documentId);
  const job=this.queue.assertResult({jobId:c.jobId,attemptId:c.attemptId,requestId:c.requestId,jobVersion:identity.jobVersion,epoch:identity.writerEpoch});
  if(job.documentId!==c.documentId||job.disposition==='deleted'||hashBytes(canonical(job.review.request))!==identity.requestHash)throw new AssetRejection('STALE_REVISION','CANDIDATE_REQUEST_CHANGED');
  const asset=this.adoptionAsset(c.preparedAssetId);
  if(asset.version!==identity.preparedAssetVersion||hashBytes(canonical(asset))!==identity.preparedAssetHash)throw new AssetRejection('STALE_REVISION','CANDIDATE_CHANGED');
  this.adoptionDependencies(job);
  });
 }
 async prepareAdoption(candidateId:string,mode:'safe-region'|'full-candidate',id:string,slot:string,check:()=>void,options:AdoptionOptions={}){
  const phase=serverPhases.start(mode==='safe-region'?'result.preserve':'result.prepare',{candidateId,previewId:id});
  try{const input=await this.reviewAdoption(candidateId,mode,id,slot,check,options),result=await this.renderAdoption(input,id,slot);phase.end('incomplete',{documentId:result.identity.documentId,jobId:result.identity.jobId,attemptId:result.identity.attemptId,providerRequestId:result.identity.requestId,outputAssetId:result.asset.id,width:result.asset.raster!.width,height:result.asset.raster!.height,boundary:'observed'});return result;}catch(error){phase.end('error');throw error;}
 }
 /** Freeze normalized inputs and mapping for review without producing Q or a document composite. */
 async reviewAdoption(candidateId:string,mode:'safe-region'|'full-candidate',id:string,slot:string,check:()=>void,options:AdoptionOptions={}):Promise<AdoptionPreparation>{
  const input=await this.reviewAdoptionOwned(candidateId,mode,id,slot,check,options);
  try{if(mode==='safe-region')input.preparation=await this.retainedPreservation(input)?'prepared-reuse':'deferred';return input;}catch(error){for(const proof of input.proofs)this.objects.releaseProof(proof.token);throw error;}
 }
 /** Explicit review prepares immutable encoded transports. No Q is consulted or
  * produced here. Raw inputs remain retained for history and ordinary use. */
 async reviewEncodedAdoption(candidateId:string,mode:'safe-region'|'full-candidate',id:string,slot:string,check:()=>void,options:AdoptionOptions={}):Promise<AdoptionPreparation>{
  if(mode!=='safe-region')throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_SAFE_REGION_REQUIRED');
  const input=await this.reviewAdoptionOwned(candidateId,mode,id,slot,check,options);
  try{
   input.check();const candidate=this.candidate(candidateId),job=this.queue.assertResult({jobId:input.identity.jobId,attemptId:input.identity.attemptId,requestId:input.identity.requestId,jobVersion:input.identity.jobVersion,epoch:input.identity.writerEpoch}),request=job.review.request;
   if(!('mask' in request)||!input.plan||!candidate.encodedAssetId)throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');
   const original=this.assets.asset(candidate.encodedAssetId);if(!original||original.availability!=='available'||canonical(input.asset.raster!.sourceAssetIds)!==canonical([original.id]))throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');
   const retained=await this.rasters.retainEncodedAdoption(this.adoptionAsset(request.source.assetId),input.asset,original,this.assets.asset(request.mask.assetId)!,input.plan,input.outputMapping,slot,input.check,input.identity.documentId);
   input.proofs.push(...retained.proofs);input.check();return {...input,preparation:'deferred',frozen:{...input.frozen,encodedRebuild:retained.encoded}};
  }catch(error){for(const proof of input.proofs)this.objects.releaseProof(proof.token);throw error;}
 }
 /** Rebuild acceptance does not invoke reviewAdoptionOwned: coverage review,
  * clipping and exact R16 transports were frozen before acceptance. It cannot
  * read a retained canonical input path or discover a previously prepared Q. */
 async prepareReviewedEncodedAdoption(frozen:CandidateAdoptionInputs,id:string,slot:string,check:()=>void):Promise<AdoptionPreparation>{
  if(frozen.kind!=='candidate-adoption-inputs-1'||frozen.mode!=='safe-region'||!frozen.encodedRebuild||!frozen.plan||!frozen.sourceCapture)throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
  const guard=()=>{check();this.checkAdoption(frozen.identity);};guard();
  const identity=frozen.identity,candidate=this.candidate(identity.candidateId),request=this.queue.assertResult({jobId:identity.jobId,attemptId:identity.attemptId,requestId:identity.requestId,jobVersion:identity.jobVersion,epoch:identity.writerEpoch}).review.request,encoded=frozen.encodedRebuild;
  if(!('mask' in request)||encoded.source.assetId!==request.source.assetId||encoded.candidate.assetId!==identity.preparedAssetId||encoded.candidate.encodedAssetId!==candidate.encodedAssetId||encoded.mask.assetId!==request.mask.assetId)throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
  const phase=serverPhases.start('result.preserve',{candidateId:identity.candidateId,previewId:id});let prepared:Awaited<ReturnType<Rasters['prepareEncodedPreservation']>>|undefined;
  try{
   prepared=await this.rasters.prepareEncodedPreservation(encoded,frozen.plan,frozen.outputMapping,id,slot,guard,identity.documentId);guard();
   phase.end('incomplete',{documentId:identity.documentId,jobId:identity.jobId,attemptId:identity.attemptId,providerRequestId:identity.requestId,outputAssetId:prepared.asset.id,width:prepared.asset.raster!.width,height:prepared.asset.raster!.height,boundary:'observed'});
   return {asset:prepared.asset,proofs:prepared.proofs,identity,plan:frozen.plan,sourceCapture:frozen.sourceCapture,outputMapping:frozen.outputMapping,coverage:frozen.coverage,frozen,preparation:'deferred',check:guard};
  }catch(error){for(const proof of prepared?.proofs??[])this.objects.releaseProof(proof.token);phase.end('error');throw error;}
 }
 /** Explicit acceptance reuses the exact approved mapping and final R16 object. */
 async prepareReviewedAdoption(frozen:CandidateAdoptionInputs,id:string,slot:string,check:()=>void):Promise<AdoptionPreparation>{
  if(frozen?.kind!=='candidate-adoption-inputs-1')throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
  this.checkAdoption(frozen.identity);
  const phase=serverPhases.start(frozen.mode==='safe-region'?'result.preserve':'result.prepare',{candidateId:frozen.identity.candidateId,previewId:id});
  try{
   const mapping=frozen.outputMapping,options:AdoptionOptions={expectedVersion:frozen.identity.candidateVersion,actualOutput:mapping?{...mapping.actualOutput,clipMask:mapping.resolution==='clipped-and-approved'}:null};
   const input=await this.reviewAdoptionOwned(frozen.identity.candidateId,frozen.mode,id,slot,check,options,frozen),result=await this.renderAdoption(input,id,slot);
   phase.end('incomplete',{documentId:result.identity.documentId,jobId:result.identity.jobId,attemptId:result.identity.attemptId,providerRequestId:result.identity.requestId,outputAssetId:result.asset.id,width:result.asset.raster!.width,height:result.asset.raster!.height,boundary:'observed'});return result;
  }catch(error){phase.end('error');throw error;}
 }
 private async renderAdoption(input:AdoptionPreparation,id:string,slot:string):Promise<AdoptionPreparation>{
  try{
   input.check();
   if(input.frozen.mode==='safe-region'){
    const retained=await this.retainedPreservation(input);if(retained)return {...input,asset:retained,preparation:'prepared-reuse'};
    const identity=input.identity,request=this.adoptionLookup(()=>this.queue.assertResult({jobId:identity.jobId,attemptId:identity.attemptId,requestId:identity.requestId,epoch:identity.writerEpoch,jobVersion:identity.jobVersion})).review.request;
    if(!('mask' in request)||!input.plan)throw new AssetRejection('INCOMPATIBLE','REQUEST_MASK_PLAN_REQUIRED');
    const prepared=await this.rasters.prepareDocument({type:'PreserveRequestCandidate',sourceAssetId:request.source.assetId,candidateAssetId:input.asset.id,maskAssetId:request.mask.assetId,plan:input.plan,...(input.outputMapping?{outputMapping:input.outputMapping}:{})},id,slot,input.check,undefined,identity.documentId);
    input.proofs.push(...prepared.proofs);input.check();return {...input,asset:prepared.asset,preparation:'deferred'};
   }
   return input;
  }catch(error){for(const proof of input.proofs)this.objects.releaseProof(proof.token);throw error;}
 }
 private async retainedPreservation(input:AdoptionPreparation):Promise<Asset|null>{
  input.check();if(!input.plan)return null;
  const identity=input.identity,request=this.adoptionLookup(()=>this.queue.assertResult({jobId:identity.jobId,attemptId:identity.attemptId,requestId:identity.requestId,epoch:identity.writerEpoch,jobVersion:identity.jobVersion})).review.request;
  if(!('mask' in request))throw new AssetRejection('INCOMPATIBLE','REQUEST_MASK_PLAN_REQUIRED');
  const source=this.assets.asset(request.source.assetId)!,mask=this.assets.asset(request.mask.assetId)!,ids=[source.id,input.asset.id,mask.id];
  // Bounded existing-asset lookup. A retained pixel product confers no review or
  // command authority; current inputs and the reused asset are still rechecked.
  const rows=this.db.prepare("SELECT a.id FROM assets a WHERE json_extract(a.json,'$.qualification')='canonical-raster' AND json_extract(a.json,'$.safety')='safe' AND json_extract(a.json,'$.availability')='available' AND json_extract(a.json,'$.raster.role')='composite' AND json_extract(a.json,'$.raster.pipeline')=? AND json_extract(a.json,'$.raster.sourceAssetIds')=? AND EXISTS (SELECT 1 FROM roots r WHERE r.hash=json_extract(a.json,'$.raster.manifest.hash')) ORDER BY a.id LIMIT 65").all(PRESERVATION_PIPELINE,canonical(ids));
  if(rows.length>64)throw new StoreError('CAPACITY');
  const expected={kind:'request-preservation-v1',source:source.raster!.manifest,candidate:input.asset.raster!.manifest,mask:mask.raster!.manifest,requestPlan:input.plan,outputMapping:input.outputMapping};
  const dependencies=[source.raster!.manifest,input.asset.raster!.manifest,mask.raster!.manifest];for(const ref of [input.plan.sourcePixels,input.plan.authoredMask,input.plan.effectiveMask,...(input.outputMapping?[input.outputMapping.effectiveMask]:[])])if(!dependencies.some(r=>canonical(r)===canonical(ref)))dependencies.push(ref);
  for(const row of rows){
   input.check();const asset=this.adoptionAsset(String(row.id)),manifest=this.rasters.manifest(asset.id);validateRasterManifest(manifest);
   if(canonical(manifest.plan)!==canonical(expected))continue;
   if(manifest.pipeline!==PRESERVATION_PIPELINE||manifest.width!==input.plan.document.width||manifest.height!==input.plan.document.height||canonical(manifest.dependencies)!==canonical(dependencies)||canonical(asset.raster!.sourceAssetIds)!==canonical(ids)||canonical(asset.dependencies)!==canonical([asset.raster!.manifest,asset.raster!.pixels]))throw new StoreError('CORRUPT_OBJECT');
   const retained=canonical(asset),priorCheck=input.check,guard=()=>{priorCheck();if(canonical(this.assets.asset(asset.id))!==retained)throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');};
   for(const ref of [asset.blob,...asset.dependencies,...manifest.dependencies])if(!input.proofs.some(p=>canonical(p.ref)===canonical(ref)))input.proofs.push({ref,token:await this.objects.prove(ref,guard)});
   guard();for(const proof of input.proofs)this.objects.proven(proof.ref,proof.token);input.check=guard;return asset;
  }
  return null;
 }
 private async reviewAdoptionOwned(candidateId:string,mode:'safe-region'|'full-candidate',id:string,slot:string,check:()=>void,options:AdoptionOptions={},reviewed?:CandidateAdoptionInputs):Promise<AdoptionPreparation>{
  if(!['safe-region','full-candidate'].includes(mode)||!isId(id))throw new StoreError('MALFORMED_REQUEST');
  const candidate=this.adoptionLookup(()=>this.candidate(candidateId));
  if(options.expectedVersion!==undefined&&candidate.version!==options.expectedVersion)throw new AssetRejection('STALE_REVISION','CANDIDATE_CHANGED');
  if(candidate.safety!=='safe'||candidate.state!=='prepared'||candidate.hidden||!candidate.preparedAssetId)throw new AssetRejection('INCOMPATIBLE','CANDIDATE_NOT_PREPARED');
  const asset=this.adoptionAsset(candidate.preparedAssetId),fence=this.adoptionLookup(()=>this.queue.resultFence(candidate.jobId,candidate.attemptId)),job=this.adoptionLookup(()=>this.queue.assertResult(fence));
  const identity:CandidateAdoptionIdentity={candidateId:candidate.id,candidateVersion:candidate.version,documentId:candidate.documentId,jobId:candidate.jobId,attemptId:candidate.attemptId,requestId:candidate.requestId,outputIdentity:candidate.outputIdentity,preparedAssetId:asset.id,preparedAssetVersion:asset.version,preparedAssetHash:hashBytes(canonical(asset)),requestHash:hashBytes(canonical(job.review.request)),jobVersion:fence.jobVersion,writerEpoch:fence.epoch};
  if(reviewed&&canonical(identity)!==canonical(reviewed.identity))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
  const guard=()=>{check();this.checkAdoption(identity);};guard();
  const request=job.review.request,proofs:{ref:BlobRef;token:string}[]=[];let sourceCapture:RequestSourceCapture|null=null,plan:RequestRasterPlan|null=null,outputMapping:RequestOutputMapping|null=null,coverageReview:{originalEffectivePixels:number;effectivePixels:number;lostPixels:number}|null=null;
  const protect=async(ref:BlobRef)=>{if(!proofs.some(p=>canonical(p.ref)===canonical(ref)))proofs.push({ref,token:await this.objects.prove(ref,guard)});};
  try{
   if('source' in request&&request.source.capture){
    const source=request.source,captureRef=source.capture!,manifest=this.rasters.manifest(source.assetId),captured=manifest.plan as {kind?:string;capture?:unknown};
    if(canonical(this.assets.asset(source.assetId)!.raster!.manifest)!==canonical(captureRef)||captured.kind!=='request-source-capture-v1')throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
    try{validateRequestSourceCapture(captured.capture);}catch{throw new AssetRejection('INCOMPATIBLE','REQUEST_SOURCE_CAPTURE_REQUIRED');}
    sourceCapture=captured.capture;
    if(sourceCapture.documentId!==candidate.documentId||sourceCapture.documentRevision!==source.documentRevision||sourceCapture.scope!==source.scope)throw new AssetRejection('STALE_REVISION','REQUEST_SOURCE_CHANGED');
    await protect(captureRef);await protect(sourceCapture.image.state);
   }
   if('mask' in request&&request.mask.requestPlan){
    try{
     plan=requireRequestMaskPlan(request.source,request.mask);
     const maskManifest=this.rasters.manifest(request.mask.assetId).plan as {hard:BlobRef;effective:BlobRef};
     requirePlanDependencies(plan,{sourcePixels:request.source.pixels,authoredMask:maskManifest.hard,effectiveMask:maskManifest.effective,dependenciesHash:requestMaskDependencies(request.source,request.mask),document:{width:request.source.width,height:request.source.height}});
    }catch(e){if(e instanceof StoreError||e instanceof AssetRejection)throw e;throw new AssetRejection('INCOMPATIBLE','REQUEST_MASK_PLAN_REQUIRED');}
   }
   if(mode==='safe-region'){
    if(!('mask' in request)||!plan||!sourceCapture)throw new AssetRejection('INCOMPATIBLE','REQUEST_SOURCE_CAPTURE_REQUIRED');
    await protect(plan.effectiveMask);
    const frozenPlan=plan,total=Number(frozenPlan.effectiveMask.byteLength),chunkSize=1048576;let block=-1,blockBytes:Buffer=Buffer.alloc(0);
    const coverage={width:plan.document.width,height:plan.document.height,get:(x:number,y:number)=>{const offset=(y*frozenPlan.document.width+x)*2,next=Math.floor(offset/chunkSize)*chunkSize;if(next!==block){guard();block=next;blockBytes=Buffer.from(this.objects.readRange(frozenPlan.effectiveMask,String(block),Math.min(chunkSize,total-block)));}return blockBytes.readUInt16LE(offset-block);}};
    if(options.actualOutput){
     const actual=options.actualOutput;
     if(actual.width!==asset.raster!.width||actual.height!==asset.raster!.height||typeof actual.clipMask!=='boolean')throw new AssetRejection('INCOMPATIBLE','OUTPUT_MAPPING_REVIEW_REQUIRED');
     if(reviewed?.outputMapping)try{requireOutputMapping(plan,reviewed.outputMapping,actual.width,actual.height);}catch{throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');}
     outputMapping=createActualOutputMapping(plan,{actualOutput:{width:actual.width,height:actual.height},effectiveMask:plan.effectiveMask,resolution:'already-contained',approvalId:reviewed?.outputMapping?.approvalId??randomUUID()});
     const successorCoverage=actual.clipMask?clipRequestCoverage(plan,coverage,outputMapping):coverage;
     try{const original=inspectRequestCoverage(plan,coverage,outputMapping,guard),final=requireRequestCoverage(plan,successorCoverage,outputMapping,guard);coverageReview={originalEffectivePixels:original.effectivePixels,effectivePixels:final.effectivePixels,lostPixels:original.lostPixels};}catch(e){if(e instanceof StoreError||e instanceof AssetRejection)throw e;throw new AssetRejection('INCOMPATIBLE',e instanceof Error?e.message:'OUTPUT_MAPPING_REVIEW_REQUIRED');}
     if(actual.clipMask){
      // Retain a successor object derived only from the frozen exact R16 mask.
      // It is rooted by the preview's proof set; the original mask is unchanged.
      const retained=reviewed?.outputMapping?.effectiveMask;
      if(retained)await protect(retained);
      const stage=retained?null:this.objects.begin(plan.effectiveMask.byteLength,'application/x-ideogram-r16le');
      let effective:BlobRef;
      try{
       for(let at=0;at<total;at+=chunkSize){
        guard();const bytes=Buffer.alloc(Math.min(chunkSize,total-at));
        for(let offset=0;offset<bytes.length;offset+=2){const pixel=(at+offset)/2;bytes.writeUInt16LE(successorCoverage.get(pixel%plan.document.width,Math.floor(pixel/plan.document.width)),offset);}
        if(retained){if(!bytes.equals(Buffer.from(this.objects.readRange(retained,String(at),bytes.length))))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');}
        else this.objects.chunk(stage!,bytes);await tick();
       }
       guard();for(const proof of proofs)this.objects.proven(proof.ref,proof.token);effective=retained??this.objects.finish(stage!);
      }finally{if(stage)this.objects.abort(stage);}
      await protect(effective);
      outputMapping=createActualOutputMapping(plan,{actualOutput:{width:actual.width,height:actual.height},effectiveMask:effective,resolution:'clipped-and-approved',approvalId:outputMapping.approvalId});
     }
    }else{
     try{requireActualOutput(plan,asset.raster!.width,asset.raster!.height);}catch{throw new AssetRejection('INCOMPATIBLE','OUTPUT_MAPPING_REVIEW_REQUIRED');}
     try{const measured=requireRequestCoverage(plan,coverage,undefined,guard);coverageReview={originalEffectivePixels:measured.effectivePixels,effectivePixels:measured.effectivePixels,lostPixels:0};}catch(e){if(e instanceof StoreError||e instanceof AssetRejection)throw e;throw new AssetRejection('INCOMPATIBLE',e instanceof Error?e.message:'MASK_DOMAIN_REVIEW_REQUIRED');}
    }
   }
   if(mode==='full-candidate'&&options.actualOutput)throw new AssetRejection('INCOMPATIBLE','OUTPUT_MAPPING_REQUIRES_SAFE_REGION');
   // Normalized CP source and candidate pixels are authoritative retained inputs.
   // Review proves them without decoding again or manufacturing a cold cache.
   guard();
   for(const input of [asset,...('source' in request?[this.assets.asset(request.source.assetId)!]:[]),...('mask' in request?[this.assets.asset(request.mask.assetId)!]:[])])for(const ref of [input.blob,...input.dependencies])await protect(ref);
   for(const ref of [...(plan?[plan.sourcePixels,plan.authoredMask,plan.effectiveMask]:[]),...(outputMapping?[outputMapping.effectiveMask]:[])])await protect(ref);
   const frozen:CandidateAdoptionInputs={kind:'candidate-adoption-inputs-1',mode,identity,plan,sourceCapture,outputMapping,coverage:coverageReview};
   if(reviewed&&canonical(frozen)!==canonical(reviewed))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
   guard();for(const proof of proofs)this.objects.proven(proof.ref,proof.token);return {asset,proofs,plan,sourceCapture,outputMapping,coverage:coverageReview,identity,frozen,preparation:mode==='full-candidate'?'prepared-reuse':'deferred',check:guard};
  }catch(e){for(const proof of proofs)this.objects.releaseProof(proof.token);throw e;}
 }
 private command(body:import('../../src/protocol/candidates.js').CandidateBody,slot:string):import('../../src/protocol/queue.js').QueueFact{
  const c=this.candidate(body.candidateId),f=this.queue.resultFence(c.jobId,c.attemptId);this.queue.assertResult(f);
  if(c.version!==body.expectedVersion)throw new AssetRejection('STALE_REVISION','CANDIDATE_CHANGED');
  if(body.type==='HideCandidate')c.hidden=true;
  else if(body.type==='RecoverCandidateOriginal'){
   const original=c.encodedAssetId?this.assets.asset(c.encodedAssetId):null,replacement=this.assets.asset(body.assetId);
   if(c.safety!=='safe'||!original||!replacement||canonical(original.blob)!==canonical(replacement.blob))throw new AssetRejection('INCOMPATIBLE','EXACT_ORIGINAL_REQUIRED');
   this.objects.verify(original.blob);if(!this.db.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get('candidate:'+c.id,original.blob.hash))this.register('candidate:'+c.id,original.blob);
   let ready=false;if(c.preparedAssetId){const prepared=this.assets.asset(c.preparedAssetId);try{if(prepared){for(const ref of [prepared.blob,...prepared.dependencies])this.objects.verify(ref);ready=true;}}catch{}}
   if(!ready){c.state='preparation-failed';c.preparedAssetId=null;const row=this.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(c.id);if(!row)throw new StoreError('NOT_FOUND');const p:PrivateSlot=JSON.parse(String(row.json));p.retryRequested=true;this.db.prepare('UPDATE candidate_private SET json=? WHERE id=?').run(canonical(p),c.id);}
   c.warning=ready?'Matching original bytes restored; retained candidate identity is unchanged.':'Matching original bytes restored; local preparation is pending. No generation was requested.';
  }else{
   if(!['transfer-failed','preparation-failed'].includes(c.state)||c.safety!=='safe')throw new AssetRejection('INCOMPATIBLE','CANDIDATE_NOT_RETRYABLE');
   const row=this.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(c.id)!;const p:PrivateSlot=JSON.parse(String(row.json));p.retryRequested=true;this.db.prepare('UPDATE candidate_private SET json=? WHERE id=?').run(canonical(p),c.id);
  }
  c.version=String(BigInt(c.version)+1n);this.save('candidate',c.id,c);
  const state=this.objects.putMetadataInSlot(Buffer.from(canonical(c)),slot);this.register('candidate-state:'+c.id+':'+c.version,state);
  return {type:'CandidateStateChanged',payload:{id:c.id,version:c.version,state}};
 }
 retries(eligible?:(jobId:string,attemptId:string)=>boolean){this.check();const result:Candidate[]=[];for(const row of this.db.prepare("SELECT c.json FROM candidates c JOIN candidate_private p ON c.id=p.id WHERE json_extract(p.json,'$.retryRequested')=1 ORDER BY c.id").iterate()){const candidate=JSON.parse(String(row.json)) as Candidate;if(eligible&&!eligible(candidate.jobId,candidate.attemptId))continue;result.push(candidate);if(result.length===20)break;}return result;}
 clearRetry(id:string){const c=this.candidate(id),f=this.queue.resultFence(c.jobId,c.attemptId);return this.queue.resultTransaction(f,()=>{const r=this.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(id)!;const p:PrivateSlot=JSON.parse(String(r.json));p.retryRequested=false;this.db.prepare('UPDATE candidate_private SET json=? WHERE id=?').run(canonical(p),id);});}
 prompt(jobId:string,attemptId:string,kind:'requested'|'submitted'|'returned'|'text-treatment',offset:string){
  const view=this.view(jobId,attemptId),p=view.provenance;if(p?.quarantined)throw new StoreError('CONTENT_WITHHELD');
  const ref=kind==='text-treatment'?view.request.textTreatment?.plan:kind==='requested'?(p?.requestedPrompt??view.request.prompt):kind==='submitted'?(p?.submittedPrompt??view.request.prompt):p?.returnedPrompt;if(!ref)throw new StoreError('NOT_FOUND');
  if(!/^(0|[1-9][0-9]*)$/.test(offset)||BigInt(offset)>BigInt(ref.byteLength))throw new StoreError('MALFORMED_REQUEST');
  this.objects.verify(ref);const start=Number(offset);let bytes=this.objects.readRange(ref,offset,Math.min(32768,Number(ref.byteLength)-start));
  for(let trim=0;;trim++){try{new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);break;}catch{if(trim===3||start+bytes.length===Number(ref.byteLength))throw new StoreError('CORRUPT_OBJECT');bytes=bytes.subarray(0,bytes.length-1);}}
  return {bytes,byteLength:ref.byteLength,offset,nextOffset:start+bytes.length<Number(ref.byteLength)?String(start+bytes.length):null};
 }
 view(jobId:string,attemptId?:string,after=''):CandidateView{
  this.check();if(after!==''&&!isId(after)||attemptId!==undefined&&!isId(attemptId))throw new StoreError('MALFORMED_REQUEST');if(!isId(jobId))throw new StoreError('MALFORMED_REQUEST');
  const rows=this.db.prepare("SELECT json FROM candidate_jobs WHERE json_extract(json,'$.jobId')=? ORDER BY rowid DESC").all(jobId),r:Retained|undefined=rows.map(x=>JSON.parse(String(x.json))).find(x=>!attemptId||x.attemptId===attemptId);
  if(!r){
   const current=this.db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(jobId);
   if(current){
    const job=JSON.parse(String(current.json)) as QueueJob,attempt=attemptId?job.attempts.find(a=>a.id===attemptId):job.attempts.at(-1);
    if(!attempt||job.disposition==='deleted')throw new StoreError('NOT_FOUND');this.documentOwner(job.documentId);
    return {protocolVersion:1,jobId,documentId:job.documentId,request:this.request(jobId),requestedCount:job.review.request.settings.count,actualCount:null,observation:null,provenance:null,inert:false,items:[],repair:{},nextCursor:null};
   }
   const row=this.db.prepare("SELECT json FROM portable_rows WHERE kind='job-result' AND json_extract(json,'$.jobId')=? AND (? IS NULL OR id=?) LIMIT 1").get(jobId,attemptId??null,attemptId??null);if(!row)throw new StoreError('NOT_FOUND');const imported=JSON.parse(String(row.json));this.documentOwner(imported.documentId);
   return {protocolVersion:1,jobId,documentId:imported.documentId,request:imported.request,requestedCount:imported.requestedCount,actualCount:imported.actualCount,observation:null,provenance:imported.provenance,inert:true,...this.page(imported.id,after,true)};
  }
  this.documentOwner(r.documentId);return {protocolVersion:1,jobId,documentId:r.documentId,request:this.request(jobId),observation:r.observation,requestedCount:r.requestedCount,actualCount:r.actualCount,...this.page(r.attemptId,after,false),provenance:r.provenance,inert:false};
 }
 private request(jobId:string){const r=(JSON.parse(String(this.db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(jobId)!.json)) as QueueJob).review,request=r.request;return {...(r.kind==='request-review-text-1'?{textTreatment:r.textTreatment}:{}),endpoint:r.endpoint,prompt:r.prompt,seed:request.settings.seed.kind==='integer'?request.settings.seed.decimal:null,...('mask' in request&&request.mask.requestPlan?{raster:{source:request.source,mask:request.mask,plan:request.mask.requestPlan}}:{})};}
 private documentOwner(id:string){if(!this.db.prepare('SELECT 1 FROM documents WHERE id=?').get(id)||this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(id))throw new StoreError('NOT_FOUND');}
 private page(attemptId:string,after:string,inert:boolean){
  const rows=inert?this.db.prepare("SELECT id,json FROM portable_rows WHERE kind='candidate-result' AND json_extract(json,'$.attemptId')=? AND id>? ORDER BY id LIMIT 33").all(attemptId,after):this.db.prepare("SELECT id,json FROM candidates WHERE json_extract(json,'$.attemptId')=? AND id>? ORDER BY id LIMIT 33").all(attemptId,after);
  const items=rows.slice(0,32).map(r=>JSON.parse(String(r.json)) as Candidate),repair:Record<string,BlobRef>={};if(!inert)for(const c of items)if(c.safety==='safe'&&c.encodedAssetId){const asset=this.assets.asset(c.encodedAssetId);if(asset)repair[c.id]=asset.blob;}return {items,repair,nextCursor:rows.length>32?items.at(-1)!.id:null};
 }
 outputs(attemptId:string){return this.db.prepare("SELECT id FROM candidates WHERE json_extract(json,'$.attemptId')=? ORDER BY id").iterate(attemptId);}
 history(documentId:string,after=''):import('../../src/protocol/candidates.js').CandidateHistory{
  this.check();if(!isId(documentId)||after!==''&&!isId(after))throw new StoreError('MALFORMED_REQUEST');
  if(!this.db.prepare('SELECT 1 FROM documents WHERE id=?').get(documentId)||this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(documentId))throw new StoreError('NOT_FOUND');
  const rows=this.db.prepare("SELECT job_id id,json,0 inert FROM candidate_jobs WHERE json_extract(json,'$.documentId')=? AND job_id>? UNION ALL SELECT id,json,1 inert FROM portable_rows WHERE kind='job-result' AND json_extract(json,'$.documentId')=? AND id>? ORDER BY id LIMIT 33").all(documentId,after,documentId,after);
  const items=rows.slice(0,32).map(row=>{const r=JSON.parse(String(row.json));return {jobId:r.jobId,attemptId:r.attemptId??r.id,inert:!!row.inert};});return {items,nextCursor:rows.length>32?String(rows[31]!.id):null};
 }
 async close(){this.closing=true;}
}

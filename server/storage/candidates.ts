import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Candidate,CandidateView,ResultFence,ObservationState,ResultProvenance} from '../../src/protocol/candidates.js';
import type {BlobRef} from '../../src/protocol/store.js';
import type {Asset} from '../../src/protocol/assets.js';
import type {Objects} from './objects.js';
import type {Assets} from './assets.js';
import type {Rasters} from './raster.js';
import type {QueueStore} from './queue.js';
import type {QueueJob} from '../../src/protocol/queue.js';
import type {ProtectedBody,AppliedPrivacyPolicy} from '../provider/contracts.js';
import type {ProviderBoundary} from '../provider/client.js';
import {scanEnvelope,deriveProvenance} from '../provider/provenance.js';
import {r31Reservation} from '../provider/evidence.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {parseCaption,LIMITS} from '../../src/composition/core.js';
import {canonical,hashBytes,isId} from './canonical.js';
import {asset as validateAsset} from '../../src/protocol/validate.js';
import {StoreError} from './errors.js';
import {AssetRejection} from './assets.js';

type Retained={jobId:string;attemptId:string;documentId:string;observation:ObservationState;requestedCount:number;actualCount:number|null;provenance:ResultProvenance|null};
type PrivateSlot={url:string|null;expectedBytes:number|null;mime:string|null;width:number|null;height:number|null;mediaRecord:string|null;retryRequested:boolean};
/** All mutations execute in the sole writer. Public views contain no transport address. */
export class Candidates {
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
 private quarantine(attemptId:string){
  for(const row of this.db.prepare("SELECT json FROM candidates WHERE json_extract(json,'$.attemptId')=?").all(attemptId)){
   const c:Candidate=JSON.parse(String(row.json));c.safety='unknown';c.state='withheld';c.warning='Conflicting result evidence requires reconciliation.';c.version=String(BigInt(c.version)+1n);this.save('candidate',c.id,c);
   for(const id of [c.encodedAssetId,c.preparedAssetId])if(id){const a=this.assets.asset(id);if(a)this.save('asset',id,{...a,safety:'quarantined'});}
  }
 }
 observe(f:ResultFence,source:ProtectedBody,now:number,background=false){
  const meta=this.source(f,source);let value:any=null;try{if(meta.completeness==='complete'&&BigInt(meta.retainedBytes)<=65536n)value=parseControlJSON(Buffer.concat([...this.queue.evidence.read(meta.recordId)]));}catch{/* Protected original remains available for reconciliation. */}
  return this.queue.resultTransaction(f,job=>{
   const r=this.retained(f),o=r.observation;
   const phase=value?.request_id===f.requestId?value.status==='CANCELLED'?'cancelled':value.status==='IN_QUEUE'?'queued':value.status==='IN_PROGRESS'?'running':value.status==='COMPLETED'?(value.error||value.error_type?'failed':'completed'):null:null;
   const digest=hashBytes(canonical({requestId:value?.request_id??null,phase}));
   if(!phase||o.phase==='quarantined'||(['completed','failed','cancelled'].includes(o.phase)&&['completed','failed','cancelled'].includes(phase)&&phase!==o.phase)){
    o.warning='Provider observations conflict or are malformed; reconciliation is required.';o.phase='quarantined';o.nextPollAt=0;this.quarantine(f.attemptId);
   }else if(!(['completed','failed','cancelled'].includes(o.phase)&&!['completed','failed','cancelled'].includes(phase))&&!(o.phase==='running'&&phase==='queued')){
    if(o.phase!==phase&&['completed','failed','cancelled'].includes(phase))this.queue.resultTerminal(job,f.attemptId,phase as 'completed'|'failed'|'cancelled');
    o.phase=phase;o.digest=digest;o.failures=0;o.mode='healthy';o.nextPollAt=['completed','failed','cancelled'].includes(phase)?0:now+(background?15000:2000);
   }
   if(!['completed','failed','cancelled','quarantined'].includes(o.phase)){o.nextPollAt=now+(background?15000:2000);o.failures=0;o.mode='healthy';}
   this.save('job',f.attemptId,r);return {view:this.view(job.id,f.attemptId),fence:this.queue.resultFence(job.id,f.attemptId)};
  });
 }
 backoff(f:ResultFence,now:number,retryAfterMs=0,offline=false,jitter=Math.random()){return this.queue.resultTransaction(f,()=>{
  const r=this.retained(f),o=r.observation;o.failures++;o.mode=offline?'offline':'backoff';o.nextPollAt=now+Math.max(retryAfterMs,Math.min(300000,2000*2**Math.min(o.failures,7))*(.75+Math.max(0,Math.min(1,jitter))*.5));this.save('job',f.attemptId,r);return o;
 });}
 due(now:number){
  this.check();const result:ResultFence[]=[];let cursor='';
  do{const page=this.queue.view(cursor);for(const j of page.jobs)for(const a of j.attempts)if(!a.recoveryRequired&&a.requestId&&['acknowledged','provider-terminal'].includes(a.state)){
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
 receive(f:ResultFence,source:ProtectedBody,policy:AppliedPrivacyPolicy,secrets:readonly string[]){
  const meta=this.source(f,source);const old=this.retained(f);
  if(old.observation.resultDigest){if(old.observation.resultDigest!==source.sha256)this.queue.resultTransaction(f,()=>{old.observation.phase='quarantined';old.observation.warning='Contradictory completed result retained for reconciliation.';this.quarantine(f.attemptId);this.save('job',f.attemptId,old);});return this.view(f.jobId,f.attemptId);}
  let envelope:ReturnType<typeof scanEnvelope>|null=null;try{if(meta.completeness==='complete')envelope=scanEnvelope(this.queue.evidence.read(source.recordId),()=>{});}catch{/* No guessed image ownership after malformed envelope. */}
  const derived=deriveProvenance({store:this.queue.evidence,source,promptSink:this.queue.sink(f.attemptId,'response',policy),endpoint:this.queue.recovery(f.jobId,f.attemptId).endpoint,requestId:f.requestId,status:'completed',policy,knownTransportSecrets:secrets});
  const valid=!!envelope?.imagesArray&&envelope.seed!==null&&envelope.timingsObject&&envelope.timingsValid;
  const returned=derived.record.returnedPromptRef?this.copyBody(derived.prompt,'text/plain'):null;
  let inspection:ResultProvenance['inspection']=returned?'opaque':'unavailable';
  if(returned&&BigInt(returned.byteLength)<=BigInt(LIMITS.bytes)){this.objects.verify(returned);const raw=this.objects.readRange(returned,'0',Number(returned.byteLength));if(parseCaption(raw).state==='supported')inspection='supported';}
  const policyRef=this.objects.putMetadata(Buffer.from(canonical({...policy,evidenceDigest:policy.evidenceDigest.startsWith('sha256:')?policy.evidenceDigest:'sha256:'+policy.evidenceDigest})));
  return this.queue.resultTransaction(f,job=>{
   const r=this.retained(f),e=envelope;
   r.observation.resultDigest=source.sha256;r.actualCount=e?.imagesArray?e.images.length:null;
   r.observation.phase=valid?'completed':'quarantined';r.observation.warning=valid?null:'Malformed completion; result remains quarantined.';
   r.provenance={requestedPrompt:job.review.prompt,submittedPrompt:job.review.prompt,returnedPrompt:returned,returnedBytes:derived.prompt.receivedBytes,complete:derived.record.derivation.complete,quarantined:derived.quarantined,inspection,warning:derived.warning,requestedSeed:job.review.request.settings.seed.kind==='integer'?job.review.request.settings.seed.decimal:null,returnedSeed:e?.seed??null,timings:e?.timings??{},timingUnits:'unknown',sourceBodyHash:'sha256:'+source.sha256,privacyPolicy:policyRef};
   const rooted=new Set<string>();for(const ref of [job.review.prompt,policyRef,...(returned?[returned]:[])])if(!rooted.has(ref.hash)){this.register('candidate-provenance:'+f.attemptId,ref);rooted.add(ref.hash);}
   const count=Math.max(r.requestedCount,r.actualCount??0),aligned=valid&&e!.safetyArray&&e!.safety.length===e!.images.length&&e!.safety.every(v=>typeof v==='boolean');
   for(let i=0;i<count;i++){
    const image=e?.images[i],present=!!image&&typeof image.url==='string';
    const safety=aligned?e!.safety[i]===false?'safe':e!.safety[i]===true?'withheld':'unknown':'unknown';
    const identity=hashBytes(canonical([f.requestId,i,image??null])),id='c_'+hashBytes(canonical([f.attemptId,i,identity])).slice(7);
    const candidate:Candidate={id,version:'1',documentId:job.documentId,jobId:job.id,attemptId:f.attemptId,requestId:f.requestId,outputIndex:i,outputIdentity:identity,safety,state:!present?'missing':safety==='safe'?'received':'withheld',hidden:false,encodedAssetId:null,preparedAssetId:null,warning:!present?'Requested output is missing.':safety!=='safe'?'Safety is withheld or cannot be matched to this output.':null};
    this.save('candidate',id,candidate);
    const numeric=(k:string)=>image?.[k]===undefined||image?.[k]===null?null:typeof image[k]==='number'&&Number.isSafeInteger(image[k])&&Number(image[k])>=0?Number(image[k]):-1;
    const privateSlot:PrivateSlot={url:present?String(image!.url):null,expectedBytes:numeric('file_size'),mime:image?.content_type===undefined||image.content_type===null?null:typeof image.content_type==='string'?image.content_type:'invalid',width:numeric('width'),height:numeric('height'),mediaRecord:null,retryRequested:false};
    this.db.prepare('INSERT INTO candidate_private VALUES (?,?)').run(id,canonical(privateSlot));
   }
   this.save('job',f.attemptId,r);return this.view(job.id,f.attemptId);
  });
 }
 private candidate(id:string):Candidate{if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT json FROM candidates WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');return JSON.parse(String(row.json));}
 private update(f:ResultFence,id:string,patch:Partial<Candidate>){return this.queue.resultTransaction(f,()=>{const c=this.candidate(id);if(c.attemptId!==f.attemptId)throw new StoreError('STALE_EPOCH');Object.assign(c,patch,{version:String(BigInt(c.version)+1n)});this.save('candidate',id,c);return c;});}
 async transfer(f:ResultFence,id:string,provider:ProviderBoundary,policy:AppliedPrivacyPolicy){
  this.queue.assertResult(f);const initial=this.candidate(id),controller=new AbortController();this.transfers.set(id,{documentId:initial.documentId,controller});
  try{return await this.transferOwned(f,id,provider,policy,controller.signal);}catch(error){
   if(this.queue.deleted(initial.documentId))return;
   if(!(error instanceof StoreError)||error.code!=='STALE_EPOCH')throw error;
   const current=this.queue.resultFence(f.jobId,f.attemptId),candidate=this.candidate(id);
   if(current.epoch!==f.epoch||current.requestId!==f.requestId||current.jobVersion===f.jobVersion)throw error;
   // A control action can invalidate in-flight publication without losing the output's retry path.
   // The old fence remains invalid; only an explicit retry may retrieve or prepare this same output.
   if(!['received','downloaded'].includes(candidate.state))throw error;
   this.update(current,id,{state:candidate.encodedAssetId?'preparation-failed':'transfer-failed',warning:'Request controls changed during import. Retry keeps this output and never submits a replacement request.'});
  }finally{this.transfers.delete(id);}
 }
 abortDocument(documentId:string){for(const work of this.transfers.values())if(work.documentId===documentId)work.controller.abort();}
 private async transferOwned(f:ResultFence,id:string,provider:ProviderBoundary,policy:AppliedPrivacyPolicy,signal:AbortSignal){
  const c=this.candidate(id);this.queue.assertResult(f);if(c.attemptId!==f.attemptId||c.state==='prepared'||c.state==='missing')return;
  const raw=this.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(id);if(!raw)throw new StoreError('NOT_FOUND');const p:PrivateSlot=JSON.parse(String(raw.json));if(!p.url)return;
  if(!c.encodedAssetId){
   const sink=this.queue.evidence.begin(f.attemptId,'response',r31Reservation(this.objects,'candidate-fetch:'+id,'provider-media',()=>this.queue.assertResult(f)),policy);
   const receipt=await provider.media(p.url,sink,{signal,...(p.expectedBytes!==null&&p.expectedBytes>=0?{expectedBytes:BigInt(p.expectedBytes)}:{})});
   this.queue.assertResult(f);p.mediaRecord=receipt.evidence.recordId;this.db.prepare('UPDATE candidate_private SET json=? WHERE id=?').run(canonical(p),id);
   if(receipt.outcome!=='complete'||receipt.status!==200){this.update(f,id,{state:'transfer-failed',warning:'Image transfer failed. Retry retrieves the same output without generating a replacement.'});return;}
   const headers=this.queue.evidence.inspect(receipt.evidence.recordId).headers,mime=headers['content-type'];
   const allowed=['image/png','image/jpeg','image/webp'];const measured=allowed.includes(mime??'')?mime!:'application/octet-stream';
   const ref=this.copyBody(receipt.evidence,measured),a:Asset={id:randomUUID(),version:'1',purpose:'image',blob:ref,dependencies:[],safety:c.safety==='safe'?'unknown':c.safety,availability:'available',qualification:'pending-decoder',measuredMediaType:measured as Asset['measuredMediaType']};validateAsset(a);
   this.queue.resultTransaction(f,()=>{this.register('candidate:'+id,ref);this.save('asset',a.id,a);});c.encodedAssetId=a.id;
   const bad=!allowed.includes(measured)||p.mime!==null&&p.mime!==measured||[p.width,p.height,p.expectedBytes].some(n=>n!==null&&n<0);
   this.update(f,id,{encodedAssetId:a.id,state:c.safety!=='safe'?'withheld':bad?'preparation-failed':'downloaded',warning:bad?'Returned image metadata is invalid; original bytes are retained.':c.warning});if(bad)return;
  }
  if(c.safety!=='safe')return;
  const slot='candidate-prepare:'+id;this.objects.acquire(slot);
  let prepared:Awaited<ReturnType<Rasters['prepareDocument']>>|undefined;
  try{
   prepared=await this.rasters.prepareDocument({type:'PrepareCandidate',assetId:c.encodedAssetId!},randomUUID(),slot,()=>{this.queue.assertResult(f);if(this.closing)throw new StoreError('CLOSED');},undefined,c.documentId);
   const info=prepared.asset.raster!,conversion=info.conversion!;
   if(p.width!==null&&p.width!==conversion.encodedWidth||p.height!==null&&p.height!==conversion.encodedHeight)throw new StoreError('MEDIA_TYPE');
   this.queue.resultTransaction(f,()=>{const rooted=new Set<string>();for(const proof of prepared!.proofs){this.objects.proven(proof.ref,proof.token);if(!rooted.has(proof.ref.hash)){this.register('candidate-prepared:'+prepared!.asset.id,proof.ref,proof.token);rooted.add(proof.ref.hash);}}this.save('asset',prepared!.asset.id,prepared!.asset);});
   this.update(f,id,{preparedAssetId:prepared.asset.id,state:'prepared',warning:null});
  }catch(e){this.queue.assertResult(f);this.update(f,id,{state:'preparation-failed',warning:'Preparation failed; encoded original retained. Retry prepares the same candidate.'});}
  finally{for(const proof of prepared?.proofs??[])this.objects.releaseProof(proof.token);this.objects.unreserve(slot);this.objects.release(slot);}
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
 retries(){this.check();return this.db.prepare("SELECT c.json FROM candidates c JOIN candidate_private p ON c.id=p.id WHERE json_extract(p.json,'$.retryRequested')=1 ORDER BY c.id LIMIT 20").all().map(r=>JSON.parse(String(r.json)) as Candidate);}
 clearRetry(id:string){const c=this.candidate(id),f=this.queue.resultFence(c.jobId,c.attemptId);return this.queue.resultTransaction(f,()=>{const r=this.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(id)!;const p:PrivateSlot=JSON.parse(String(r.json));p.retryRequested=false;this.db.prepare('UPDATE candidate_private SET json=? WHERE id=?').run(canonical(p),id);});}
 prompt(jobId:string,attemptId:string,kind:'requested'|'submitted'|'returned',offset:string){
  const view=this.view(jobId,attemptId),p=view.provenance;if(p?.quarantined)throw new StoreError('CONTENT_WITHHELD');
  const ref=kind==='requested'?(p?.requestedPrompt??view.request.prompt):kind==='submitted'?(p?.submittedPrompt??view.request.prompt):p?.returnedPrompt;if(!ref)throw new StoreError('NOT_FOUND');
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
 private request(jobId:string){const r=JSON.parse(String(this.db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(jobId)!.json)).review;return {endpoint:r.endpoint,prompt:r.prompt,seed:r.request.settings.seed.kind==='integer'?r.request.settings.seed.decimal:null};}
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

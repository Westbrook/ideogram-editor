import {DiagnosticRing} from '../observability/diagnostic-memory.js';
import {returnedDescriptionSelection,validateReturnedDescriptionSelection} from '../../src/text/returned-description.js';
import {readFileSync} from 'node:fs';
import {runVerification} from '../text/supervisor.js';
import {verificationBudget} from '../../src/protocol/text-budget.js';
import {retainedProfile,usesStreamingLayout,usesParagraphRunQuota} from '../text/validation.js';
import {textDraft,draftRefs,textSplitPlan} from '../../src/protocol/text.js';
import {planTextSplit} from '../../src/text/split.js';
import {imageState} from '../../src/protocol/history-validation.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import { Worker } from 'node:worker_threads';
import {adapterResources} from '../observability/adapter-resources.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Objects } from './objects.js';
import type { Assets, AssetAuth } from './assets.js';
import { AssetRejection } from './assets.js';
import { StoreError } from './errors.js';
import type { BlobRef, Command, Document } from '../../src/protocol/store.js';
import type { Asset } from '../../src/protocol/assets.js';
import type { ImageState } from '../../src/protocol/history.js';
import type { FontVersion, TextCandidate, TextSource, TextDraft, TextSplitPlan } from '../../src/protocol/text.js';
import { canonical, hashBytes, isId } from './canonical.js';
import { profile, profileRef, identity, validateSource, validateLayout, layoutValidationBytes, dependencyIdentity, dependencies, bundledFont } from '../text/validation.js';
import { keys, requireValue as ok } from '../../src/protocol/validate.js';

export type PreparedTextSplit={plan:TextSplitPlan;saved:TextDraft;candidates:TextCandidate[];draftRef:BlobRef};

export class Texts {
 private verifying=false;private readyLoans=new Set<string>();
 private admissionCount=0;
 private admissionCoverage:(()=>void)|undefined;
 resourceOwnership(){return {verifying:this.verifying,bookedCPUBytes:this.reservedCPU,readyLoans:this.readyLoans.size,browserAdmissions:this.admissionCount,browserAdmissionInventoryObserved:true};}
 private observations=new DiagnosticRing<Record<string,unknown>>('diagnostic-text-observations',32,16384);
 readObservations(){return this.observations.read();}
 get droppedObservations(){return this.observations.dropped;}
 closeObservations(){this.observations.dispose();}
 reservedCPU=0;backendCPU:()=>number=()=>0;
 constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private epoch:string){this.admissionCount=Number(db.prepare('SELECT count(*) n FROM text_admissions').get()!.n);this.refreshAdmissionCoverage();}
 // Verification loans remain inside the same retained browser admission.
 private refreshAdmissionCoverage(){if(this.admissionCount)this.admissionCoverage??=adapterResources.uncovered('text-browser-admission');else{this.admissionCoverage?.();this.admissionCoverage=undefined;}}
 // One R35 lane: browser preparation then a booked server verification loan.
 // The same128MiB envelope remains inside R18; neither phase gets a fresh cap.
 admission(id:string,auth:AssetAuth){
  if(this.verifying)throw new StoreError('QUEUE_FULL');
  if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM text_admissions WHERE id=?').get(id);
  if(row){if(row.client_id!==auth.clientId)throw new StoreError('OWNER_REQUIRED');this.db.prepare('UPDATE text_admissions SET session_hash=?,epoch=? WHERE id=?').run(auth.sessionHash,this.epoch,id);return {id,bytes:134217728};}
  const phase=/^([a-f0-9-]{36})_([1-9][0-9]*)_([0-9]+)$/.exec(id);
  const predecessors=phase?this.db.prepare('SELECT * FROM text_admissions WHERE id LIKE ?').all(phase[1]+'_%'):[];
  for(const old of predecessors){const prior=String(old.id).split('_');if(old.client_id!==auth.clientId||old.session_hash!==auth.sessionHash||BigInt(prior[1])>=BigInt(phase![2]))throw new StoreError('OWNER_REQUIRED');}
  if(Number(this.db.prepare('SELECT count(*) n FROM text_admissions').get()!.n)!==predecessors.length||this.reservedCPU)throw new StoreError('CAPACITY');
  const processRSS=process.memoryUsage().rss,backendBytes=this.backendCPU(),browserBytes=134217728,combined=processRSS+backendBytes+browserBytes;
  this.observations.add({phase:'browser-admission',id,predecessors:predecessors.length<=32?predecessors.map(row=>row.id):[],omittedPredecessors:Math.max(0,predecessors.length-32),processRSS,backendBytes,browserBytes,combined,limit:536870912,admitted:combined<=536870912});
  if(combined>536870912)throw new StoreError('CAPACITY');
  const releaseCoverage=adapterResources.uncovered('text-admission-transition');
  try{
   for(const old of predecessors){this.readyLoans.delete(String(old.id));this.admissionCount-=Number(this.db.prepare('DELETE FROM text_admissions WHERE id=?').run(old.id).changes);}
   const inserted=this.db.prepare('INSERT INTO text_admissions VALUES (?,?,?,?)').run(id,auth.clientId,auth.sessionHash,this.epoch);this.admissionCount+=Number(inserted.changes);return {id,bytes:134217728};
  }finally{this.refreshAdmissionCoverage();releaseCoverage();}
 }
 releaseAdmission(id:string,auth:AssetAuth){if(this.verifying)throw new StoreError('QUEUE_FULL');const row=this.db.prepare('SELECT * FROM text_admissions WHERE id=?').get(id);if(row&&(row.client_id!==auth.clientId||row.session_hash!==auth.sessionHash||row.epoch!==this.epoch))throw new StoreError('OWNER_REQUIRED');this.readyLoans.delete(id);this.admissionCount-=Number(this.db.prepare('DELETE FROM text_admissions WHERE id=?').run(id).changes);this.refreshAdmissionCoverage();}
 externalBytes(){return this.db.prepare('SELECT id FROM text_admissions').all().reduce((n,row)=>n+134217728-(this.readyLoans.has(String(row.id))?Number(String(row.id).split('_')[2]):0),0);}
 guardMetadata(bytes:number){if(process.memoryUsage().rss+this.externalBytes()+this.reservedCPU+this.backendCPU()+bytes*6+16777216>536870912)throw new StoreError('CAPACITY');}
 source(ref:BlobRef){return validateSource(parseControlJSON(this.objects.verify(ref,true)!));}
 async inspect(ref:BlobRef,path=this.objects.path(ref)){
  if(this.verifying||this.reservedCPU)throw new StoreError('QUEUE_FULL');const row=this.db.prepare('SELECT id FROM text_admissions').get();const borrowed=!!row&&this.readyLoans.has(String(row.id));if(row&&!borrowed)throw new AssetRejection('CAPACITY','TEXT_REALM_OWNS_CAPACITY');
  if(BigInt(ref.byteLength)>16777216n||process.memoryUsage().rss+this.externalBytes()+this.reservedCPU+this.backendCPU()+67108864>536870912)throw new AssetRejection('CAPACITY','FONT_MEMORY_BUDGET');
  const releaseCoverage=adapterResources.uncovered('text-font-inspection');this.reservedCPU+=67108864;
  try{return await new Promise<any>((resolve,reject)=>{
   const w=new Worker(new URL('../text/worker.js',import.meta.url),{workerData:{path,length:Number(ref.byteLength),hash:ref.hash},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});let result:any,error:unknown;
   const releaseWorker=adapterResources.worker('text-font',w.threadId);
   const timer=setTimeout(()=>{error=new AssetRejection('CAPACITY','FONT_VALIDATION_DEADLINE');void w.terminate();},20000);
   w.on('message',m=>{if(m.ok)result=m.result;else error=new AssetRejection('INCOMPATIBLE',m.code);});w.on('error',()=>{error=new AssetRejection('INCOMPATIBLE','FONT_VALIDATION_FAILED');});w.on('exit',()=>{clearTimeout(timer);releaseWorker();if(error)reject(error);else if(result)resolve(result);else reject(new StoreError('STORAGE_FAILURE'));});
  });}finally{this.reservedCPU-=67108864;releaseCoverage();}
 }
 async importFont(c:Command,id:string,protect:(ref:BlobRef)=>Promise<void>):Promise<Asset>{
  const b=c.body;if(b.type!=='ImportFont')throw new StoreError('UNSUPPORTED_COMMAND');
  const releaseCoverage=adapterResources.uncovered('text-font-import');try{
  await protect(b.source);await protect(b.license);if(BigInt(b.license.byteLength)>65536n)throw new AssetRejection('CAPACITY','FONT_LICENSE_LIMIT');
  const license=this.objects.verify(b.license,true)!;try{if(!new TextDecoder('utf-8',{fatal:true}).decode(license).trim())throw Error();}catch{throw new AssetRejection('INVALID_INPUT','FONT_LICENSE_REQUIRED');}
  const inspected=await this.inspect(b.source),value={schemaVersion:1 as const,bytes:b.source,faceIndex:0 as const,format:inspected.format,parserProfile:inspected.parserProfile,fsType:inspected.fsType,licenseRecord:b.license,origin:b.origin,embedding:'permitted' as const};
  const font:FontVersion={...value,id:identity(value)};try{bundledFont(font);}catch{throw new AssetRejection('INVALID_INPUT','FONT_BUNDLED_IDENTITY');}
  return {id,version:'1',purpose:'font',blob:b.source,dependencies:[b.license],safety:'safe',availability:'available',qualification:'font',measuredMediaType:'application/octet-stream',font};
  }finally{releaseCoverage();}
 }
 fence(c:Command,d:Document,auth:AssetAuth,value:TextCandidate){
  const b=c.body;if(!('candidate'in b))throw new StoreError('UNSUPPORTED_COMMAND');
  const a=this.db.prepare('SELECT * FROM text_admissions WHERE id=?').get(b.admissionId);
  if(!a||a.client_id!==auth.clientId||a.session_hash!==auth.sessionHash||a.epoch!==this.epoch)throw new AssetRejection('STALE_REVISION','TEXT_ADMISSION_EXPIRED');
  const t=value.token;if(t.documentId!==d.id||t.documentRevision!==d.revision||t.layerId!==b.layerId||t.layerVersion!==((b.type==='CreateTextLayer'||b.type==='CreateTextFromReturnedDescription')?'0':b.layerVersion)||t.sessionId!==b.draft.sessionId||String(t.generation)!==b.draft.generation||c.sessionId!==b.draft.sessionId)throw new AssetRejection('STALE_REVISION','TEXT_TOKEN_CHANGED');
  const checkpoint=this.db.prepare('SELECT json FROM ui_checkpoints WHERE client_id=? AND session_id=?').get(c.clientId,b.draft.sessionId);const draft=checkpoint?JSON.parse(String(checkpoint.json)).drafts.find((x:any)=>x.id===b.draft.draftId):null;const asset=draft?this.assets.asset(draft.assetId):null;if(!asset||draft.kind!=='text')throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_REQUIRED');const saved=parseControlJSON(this.objects.verify(asset.blob,true)!);textDraft(saved);if(canonical(saved.textUtf8)!==canonical(value.source.text.textUtf8)||canonical(saved.style)!==canonical(value.source.text.style)||canonical(saved.frame)!==canonical(value.source.text.frame)||canonical(saved.fonts)!==canonical(value.source.text.fonts))throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_CONTENT_CHANGED');
  if(value.source.render.rendererProfile.id!==profile.id||canonical(value.source.render.rendererProfile.manifest)!==canonical(profileRef))throw new AssetRejection('INCOMPATIBLE','TEXT_PROFILE_UNSUPPORTED');
  if((b.type==='CreateTextLayer'||b.type==='CreateTextFromReturnedDescription')&&(((saved.kind==='text-draft-2'||saved.kind==='text-draft-3'))!==('placement'in b)||canonical(b.placement??{x:0,y:0})!==canonical((saved.kind==='text-draft-2'||saved.kind==='text-draft-3')?saved.placement:{x:0,y:0}))||(b.type!=='CreateTextLayer'&&b.type!=='CreateTextFromReturnedDescription')&&(saved.kind==='text-draft-2'||saved.kind==='text-draft-3'))throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_PLACEMENT_CHANGED');
  if(saved.kind==='text-draft-3'&&(b.type!=='CreateTextFromReturnedDescription'||canonical(saved.description)!==canonical(returnedDescriptionSelection(b.description))))throw new AssetRejection('STALE_REVISION','TEXT_DESCRIPTION_DRAFT_CHANGED');
  if('reviewedDependencyHash'in b&&b.reviewedDependencyHash!==value.source.render.dependencyHash)throw new AssetRejection('STALE_REVISION','TEXT_REFLOW_REVIEW_CHANGED');
 }
 async candidate(c:Command,d:Document,auth:AssetAuth,protect:(ref:BlobRef)=>Promise<void>,check:()=>void){
  const b=c.body;if(!('candidate'in b))throw new StoreError('UNSUPPORTED_COMMAND');const releaseCoverage=adapterResources.uncovered('text-candidate-validation');try{await protect(b.candidate);
  let value:TextCandidate;
  try{value=parseControlJSON(this.objects.verify(b.candidate,true)!) as unknown as TextCandidate;keys(value,['schemaVersion','token','source']);ok(value.schemaVersion===1);keys(value.token,['documentId','documentRevision','layerId','layerVersion','sessionId','generation']);ok(Number.isSafeInteger(value.token.generation)&&value.token.generation>=0);validateSource(value.source);}catch{throw new AssetRejection('INVALID_INPUT','TEXT_CANDIDATE_INVALID');}
  this.fence(c,d,auth,value);const s=value.source;
  for(const ref of dependencies(s))await protect(ref);
  if(dependencyIdentity(s)!==s.render.dependencyHash)throw new AssetRejection('INVALID_INPUT','TEXT_DEPENDENCY_HASH');
  for(const f of s.text.fonts){const rows=this.db.prepare("SELECT json FROM assets WHERE json_extract(json,'$.font.id')=?").all(f.id);if(!rows.some(row=>canonical(JSON.parse(String(row.json)).font)===canonical(f)))throw new AssetRejection('INCOMPATIBLE','FONT_IMPORT_REQUIRED');}
  {
   const layoutBytes=Number(s.render.layout.byteLength);
   if(!Number.isSafeInteger(layoutBytes)||layoutBytes>8388608||process.memoryUsage().rss+this.externalBytes()+this.reservedCPU+this.backendCPU()+layoutBytes+1048576>536870912)throw new AssetRejection('CAPACITY','TEXT_VALIDATION_MEMORY');
   let layout:Uint8Array,validationBytes:number;
   try{layout=this.read(s.render.layout,8388608);validationBytes=layoutValidationBytes(layout);}catch{throw new AssetRejection('INVALID_INPUT','TEXT_LAYOUT_INVALID');}
   if(process.memoryUsage().rss+this.externalBytes()+this.reservedCPU+this.backendCPU()+validationBytes>536870912||validationBytes>134217728)throw new AssetRejection('CAPACITY','TEXT_VALIDATION_MEMORY');
   try{const text=this.objects.verify(s.text.textUtf8,true)!;validateLayout(s,layout,text);if((b.type==='CreateTextLayer'||b.type==='CreateTextFromReturnedDescription')&&text.length===0)throw new Error();}catch{throw new AssetRejection('INVALID_INPUT','TEXT_LAYOUT_INVALID');}
  }
  await this.verify(s,ref=>this.objects.path(ref),check,b.admissionId);
  return value;
  }finally{releaseCoverage();}
 }
 private splitMetadata(ref:BlobRef,savedDraft=false){
  if(!(ref.mediaType==='application/json'||savedDraft&&(ref.mediaType==='text/plain'||ref.mediaType==='text/plain;charset=utf-8'))||BigInt(ref.byteLength)>65536n)throw new AssetRejection('CAPACITY','TEXT_SPLIT_METADATA_LIMIT');
  this.guardMetadata(Number(ref.byteLength));this.objects.verify(ref);const bytes=this.read(ref,65536),value=parseControlJSON(bytes);
  if(canonical(value)!==bytes.toString('utf8'))throw new AssetRejection('INVALID_INPUT','TEXT_SPLIT_METADATA_NOT_CANONICAL');return value;
 }
 private splitPlan(ref:BlobRef):TextSplitPlan{
  try{const plan=this.splitMetadata(ref);textSplitPlan(plan);return plan;}catch(error){if(error instanceof StoreError||error instanceof AssetRejection)throw error;throw new AssetRejection('INVALID_INPUT','TEXT_SPLIT_PLAN_INVALID');}
 }
 private splitSaved(c:Command,d:Document,auth:AssetAuth):{saved:TextDraft;draftRef:BlobRef;availableParts:number}{
  const b=c.body;if(b.type!=='SplitTextDraft')throw new StoreError('UNSUPPORTED_COMMAND');
  const binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);
  if(c.clientId!==auth.clientId||c.sessionId!==b.draft.sessionId||!Number.isFinite(auth.now)||!Number.isFinite(auth.expires)||auth.now>=auth.expires||!binding||binding.client_id!==auth.clientId||auth.now>=Number(binding.expires)||String(this.db.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get()?.value)!==this.epoch)throw new AssetRejection('STALE_REVISION','TEXT_SPLIT_AUTHORITY_CHANGED');
  if(c.documentId!==d.id||c.expectedDocumentRevision!==d.revision||this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(d.id))throw new AssetRejection('STALE_REVISION','TEXT_SPLIT_DOCUMENT_CHANGED');
  const row=this.db.prepare('SELECT json FROM ui_checkpoints WHERE client_id=? AND session_id=?').get(c.clientId,b.draft.sessionId);
  if(!row||Buffer.byteLength(String(row.json))>65536)throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_REQUIRED');
  this.guardMetadata(65536);const draft=JSON.parse(String(row.json)).drafts.find((value:any)=>value.id===b.draft.draftId);
  if(!draft||draft.kind!=='text'||draft.generation!==b.draft.generation||draft.documentId!==d.id||draft.expectedDocumentRevision!==d.revision||draft.targetLayerId!==(b.sourceLayer?.layerId??null)||draft.composing||draft.status!=='saved-unapplied')throw new AssetRejection('STALE_REVISION','DRAFT_GENERATION_CHANGED');
  const asset=this.assets.asset(draft.assetId);
  if(!asset||asset.qualification!=='opaque-text'||asset.safety!=='safe'||asset.availability!=='available')throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_REQUIRED');
  const saved=this.splitMetadata(asset.blob,true);try{textDraft(saved);}catch{throw new AssetRejection('INVALID_INPUT','TEXT_SPLIT_DRAFT_INVALID');}
  let state:ImageState={schemaVersion:1,width:d.width,height:d.height,layers:[]};
  if(d.image){
   if(BigInt(d.image.state.byteLength)>8388608n)throw new AssetRejection('CAPACITY','TEXT_SPLIT_STATE_LIMIT');
   this.guardMetadata(Number(d.image.state.byteLength));this.objects.verify(d.image.state);const parsed=parseControlJSON(this.read(d.image.state,8388608),8388608);imageState(parsed);state=parsed;
  }
  if(b.sourceLayer){
   if(saved.kind!=='text-draft-1'||!d.image)throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_PLACEMENT_CHANGED');
   const layer=state.layers.find(value=>value.id===b.sourceLayer!.layerId);
   if(!layer||layer.kind!=='text'||layer.version!==b.sourceLayer.layerVersion)throw new AssetRejection('STALE_REVISION','TEXT_LAYER_CHANGED');
   if(layer.locked)throw new AssetRejection('INVALID_INPUT','LAYER_LOCKED');
  }
  const aggregate=state.layers.reduce((total,layer)=>total+(layer.kind==='text'&&layer.id!==b.sourceLayer?.layerId?BigInt(this.source(layer.source).text.textUtf8.byteLength):0n),BigInt(saved.textUtf8.byteLength));
  if(aggregate>1048576n)throw new AssetRejection('CAPACITY','TEXT_DOCUMENT_LIMIT');
  const availableParts=100-state.layers.length+(b.sourceLayer?1:0);if(availableParts<2)throw new AssetRejection('CAPACITY','DOCUMENT_LAYER_LIMIT');
  return {saved,draftRef:asset.blob,availableParts};
 }
 private splitCandidate(ref:BlobRef):TextCandidate{
  try{const value=this.splitMetadata(ref) as unknown as TextCandidate;keys(value,['schemaVersion','token','source']);ok(value.schemaVersion===1);keys(value.token,['documentId','documentRevision','layerId','layerVersion','sessionId','generation']);ok(Number.isSafeInteger(value.token.generation)&&value.token.generation>=0);validateSource(value.source);return value;}catch(error){if(error instanceof StoreError||error instanceof AssetRejection)throw error;throw new AssetRejection('INVALID_INPUT','TEXT_CANDIDATE_INVALID');}
 }
 private splitCandidateFence(c:Command,d:Document,saved:TextDraft,plan:TextSplitPlan,value:TextCandidate,index:number){
  const b=c.body;if(b.type!=='SplitTextDraft')throw new StoreError('UNSUPPORTED_COMMAND');
  const part=plan.parts[index],token=value.token,source=value.source;
  if(!part||token.documentId!==d.id||token.documentRevision!==d.revision||token.sessionId!==b.draft.sessionId||String(token.generation)!==b.draft.generation||token.layerId!==part.layerId||token.layerVersion!==(index===0&&b.sourceLayer?b.sourceLayer.layerVersion:'0'))throw new AssetRejection('STALE_REVISION','TEXT_TOKEN_CHANGED');
  if(index===0&&(part.offset.x!==0||part.offset.y!==0||b.sourceLayer&&part.layerId!==b.sourceLayer.layerId))throw new AssetRejection('STALE_REVISION','TEXT_SPLIT_ORIGIN_CHANGED');
  if(canonical(saved.style)!==canonical(source.text.style)||canonical(saved.frame)!==canonical(source.text.frame)||canonical(saved.fonts)!==canonical(source.text.fonts))throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_CONTENT_CHANGED');
  if(source.render.rendererProfile.id!==profile.id||canonical(source.render.rendererProfile.manifest)!==canonical(profileRef))throw new AssetRejection('INCOMPATIBLE','TEXT_PROFILE_UNSUPPORTED');
  if(part.reviewedDependencyHash!==source.render.dependencyHash||part.reviewedRasterHash!==source.render.pixels.hash)throw new AssetRejection('STALE_REVISION','TEXT_SPLIT_PREVIEW_CHANGED');
 }
 private splitDescription(saved:TextDraft,plan:TextSplitPlan){
  if(saved.kind!=='text-draft-3'){if(plan.description)throw new AssetRejection('STALE_REVISION','TEXT_DESCRIPTION_DRAFT_CHANGED');return;}
  const selection=plan.description;
  if(!selection)throw new AssetRejection('STALE_REVISION','TEXT_DESCRIPTION_DRAFT_CHANGED');
  try{validateReturnedDescriptionSelection(selection);}catch{throw new AssetRejection('INVALID_INPUT','RETURNED_DESCRIPTION_SELECTION_CHANGED');}
  if(canonical(saved.description)!==canonical(selection))throw new AssetRejection('STALE_REVISION','TEXT_DESCRIPTION_DRAFT_CHANGED');
 }
 splitFence(c:Command,d:Document,auth:AssetAuth,value:PreparedTextSplit){
  const b=c.body;if(b.type!=='SplitTextDraft')throw new StoreError('UNSUPPORTED_COMMAND');
  const current=this.splitSaved(c,d,auth),plan=this.splitPlan(b.plan);
  if(b.reviewedPlanHash!==b.plan.hash||canonical(plan)!==canonical(value.plan)||canonical(current.draftRef)!==canonical(value.draftRef)||canonical(current.saved)!==canonical(value.saved)||canonical(plan.originalText)!==canonical(current.saved.textUtf8)||value.candidates.length!==plan.parts.length)throw new AssetRejection('STALE_REVISION','TEXT_SPLIT_PLAN_CHANGED');
  this.guardMetadata(Number(b.plan.byteLength)+Number(current.draftRef.byteLength)+plan.parts.reduce((total,part)=>total+Number(part.candidate.byteLength),0));
  this.splitDescription(current.saved,plan);
  for(const [index,part]of plan.parts.entries()){
   const candidate=this.splitCandidate(part.candidate);
   if(canonical(candidate)!==canonical(value.candidates[index]))throw new AssetRejection('STALE_REVISION','TEXT_SPLIT_CANDIDATE_CHANGED');
   this.splitCandidateFence(c,d,current.saved,plan,candidate,index);
  }
 }
 async split(c:Command,d:Document,auth:AssetAuth,protect:(ref:BlobRef)=>Promise<void>,check:()=>void):Promise<PreparedTextSplit>{
  const b=c.body;if(b.type!=='SplitTextDraft')throw new StoreError('UNSUPPORTED_COMMAND');
  const releaseCoverage=adapterResources.uncovered('text-split-validation');
  try{
   check();if(this.verifying||this.reservedCPU)throw new StoreError('QUEUE_FULL');
   if(this.db.prepare('SELECT 1 FROM text_admissions LIMIT 1').get())throw new AssetRejection('CAPACITY','TEXT_REALM_OWNS_CAPACITY');
   const {saved,draftRef,availableParts}=this.splitSaved(c,d,auth);
   if(!['text/plain','text/plain;charset=utf-8'].includes(saved.textUtf8.mediaType)||BigInt(saved.textUtf8.byteLength)>1048576n)throw new AssetRejection('CAPACITY','TEXT_SPLIT_ORIGINAL_LIMIT');
   await protect(draftRef);for(const ref of draftRefs(saved))await protect(ref);await protect(b.plan);check();
   const plan=this.splitPlan(b.plan);
   if(b.reviewedPlanHash!==b.plan.hash||canonical(plan.originalText)!==canonical(saved.textUtf8))throw new AssetRejection('STALE_REVISION','TEXT_SPLIT_PLAN_CHANGED');
   const metadataBytes=Number(b.plan.byteLength)+Number(draftRef.byteLength)+Number(saved.textUtf8.byteLength)+plan.parts.reduce((total,part)=>total+Number(part.candidate.byteLength),0);this.guardMetadata(metadataBytes);
   this.splitDescription(saved,plan);if(plan.description)await protect(plan.description.returnedPrompt);
   const original=this.read(saved.textUtf8,1048576);let ranges:ReturnType<typeof planTextSplit>;
   try{ranges=planTextSplit(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(original),availableParts);}catch(error){if(error instanceof Error&&error.message==='TEXT_SPLIT_LAYER_LIMIT')throw new AssetRejection('CAPACITY','TEXT_SPLIT_LAYER_LIMIT');throw new AssetRejection('INVALID_INPUT','TEXT_SPLIT_RANGES_INVALID');}
   if(ranges.length!==plan.parts.length||ranges.some((range,index)=>range.startByte!==plan.parts[index].startByte||range.endByte!==plan.parts[index].endByte))throw new AssetRejection('INVALID_INPUT','TEXT_SPLIT_RANGES_CHANGED');
   const candidates:TextCandidate[]=[];
   for(const [index,part]of plan.parts.entries()){
    check();await protect(part.candidate);const candidate=this.splitCandidate(part.candidate),source=candidate.source;this.splitCandidateFence(c,d,saved,plan,candidate,index);
    for(const ref of dependencies(source))await protect(ref);
    const text=this.read(source.text.textUtf8,16384),expected=original.subarray(part.startByte,part.endByte);
    if(text.byteLength!==expected.byteLength||!text.every((byte,offset)=>byte===expected[offset]))throw new AssetRejection('INVALID_INPUT','TEXT_SPLIT_CONTENT_CHANGED');
    if(dependencyIdentity(source)!==source.render.dependencyHash)throw new AssetRejection('INVALID_INPUT','TEXT_DEPENDENCY_HASH');
    for(const font of source.text.fonts){const rows=this.db.prepare("SELECT json FROM assets WHERE json_extract(json,'$.font.id')=?").all(font.id);if(!rows.some(row=>canonical(JSON.parse(String(row.json)).font)===canonical(font)))throw new AssetRejection('INCOMPATIBLE','FONT_IMPORT_REQUIRED');}
    {
     const layoutBytes=Number(source.render.layout.byteLength);this.guardMetadata(layoutBytes);let layout:Uint8Array,validationBytes:number;
     try{layout=this.read(source.render.layout,8388608);validationBytes=layoutValidationBytes(layout);}catch{throw new AssetRejection('INVALID_INPUT','TEXT_LAYOUT_INVALID');}
     if(process.memoryUsage().rss+this.externalBytes()+this.reservedCPU+this.backendCPU()+validationBytes>536870912||validationBytes>134217728)throw new AssetRejection('CAPACITY','TEXT_VALIDATION_MEMORY');
     try{validateLayout(source,layout,text);if(!text.length)throw Error();}catch{throw new AssetRejection('INVALID_INPUT','TEXT_LAYOUT_INVALID');}
    }
    // Every part is verified serially after the browser has released its realm;
    // this path neither grants an admission nor borrows/refunds another owner.
    await this.verify(source,ref=>this.objects.path(ref),check);candidates.push(candidate);
   }
   const value={plan,saved,candidates,draftRef};check();this.splitFence(c,d,auth,value);return value;
  }finally{releaseCoverage();}
 }
 async verify(s:TextSource,path:(ref:BlobRef)=>string,check:()=>void,admissionId?:string){
  check();if(this.verifying)throw new StoreError('QUEUE_FULL');if(!retainedProfile(s.render.rendererProfile))throw new AssetRejection('INCOMPATIBLE','TEXT_PROFILE_UNSUPPORTED');
  const releaseCoverage=adapterResources.uncovered('text-verification-input');try{
  const textBytes=readFileSync(path(s.text.textUtf8));if(hashBytes(textBytes)!==s.text.textUtf8.hash)throw new StoreError('CORRUPT_OBJECT');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(textBytes);
  let budget;try{budget=verificationBudget(text,s.text.frame.width,s.text.frame.height,s.text.fonts.reduce((n,f)=>n+Number(f.bytes.byteLength),0),profile.engine.wasm.bytes,{legacy:!usesStreamingLayout(s.render.rendererProfile.id),layoutBytes:Number(s.render.layout.byteLength),retainedRunQuota:!usesParagraphRunQuota(s.render.rendererProfile.id)});}catch{throw new AssetRejection('CAPACITY','TEXT_VERIFICATION_CAPACITY');}
  const row=this.db.prepare('SELECT id FROM text_admissions').get();const borrowed=!!admissionId&&row?.id===admissionId;
  if(borrowed){if(Number(admissionId!.split('_')[2])!==budget.bytes)throw new AssetRejection('INVALID_INPUT','TEXT_VERIFICATION_ADMISSION');this.readyLoans.add(admissionId!);}
  else if(row)throw new AssetRejection('CAPACITY','TEXT_REALM_OWNS_CAPACITY');
  if(this.reservedCPU||process.memoryUsage().rss+this.externalBytes()+this.backendCPU()+budget.bytes>536870912)throw new AssetRejection('CAPACITY','TEXT_VERIFICATION_CAPACITY');
  this.verifying=true;this.reservedCPU=budget.bytes;
  try{await runVerification({request:{text,style:s.text.style,frame:s.text.frame,token:{documentId:'verification',documentRevision:'0',layerId:'verification',layerVersion:'0',sessionId:'verification',generation:0}},profile:s.render.rendererProfile.id,fonts:s.text.fonts.map(f=>({path:path(f.bytes),length:Number(f.bytes.byteLength),hash:f.bytes.hash,licenseHash:f.licenseRecord.hash,origin:f.origin})),expected:{layoutPath:path(s.render.layout),layoutHash:s.render.layout.hash,pixelsHash:s.render.pixels.hash,textHash:s.text.textUtf8.hash,overflow:s.render.overflow}},check);check();}finally{this.verifying=false;this.reservedCPU=0;}
  }finally{releaseCoverage();}
 }
 private read(ref:BlobRef,limit:number){if(BigInt(ref.byteLength)>BigInt(limit))throw new StoreError('CAPACITY');const result=Buffer.alloc(Number(ref.byteLength));for(let at=0;at<result.length;at+=1048576)result.set(this.objects.readRange(ref,String(at),Math.min(1048576,result.length-at)),at);return result;}
 limits(state:ImageState){let bytes=0;const fonts=new Map<string,FontVersion>();for(const l of state.layers)if(l.kind==='text'){const s=this.source(l.source);bytes+=Number(s.text.textUtf8.byteLength);for(const f of s.text.fonts)fonts.set(f.bytes.hash+':'+f.faceIndex,f);}if(bytes>1048576||state.layers.length>100||fonts.size>16||[...fonts.values()].reduce((n,f)=>n+Number(f.bytes.byteLength),0)>67108864)throw new AssetRejection('CAPACITY','TEXT_DOCUMENT_LIMIT');}
}

import {readFileSync} from 'node:fs';
import {runVerification} from '../text/supervisor.js';
import {verificationBudget} from '../../src/protocol/text-budget.js';
import {retainedProfile} from '../text/validation.js';
import {textDraft} from '../../src/protocol/text.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import type { Objects } from './objects.js';
import type { Assets, AssetAuth } from './assets.js';
import { AssetRejection } from './assets.js';
import { StoreError } from './errors.js';
import type { BlobRef, Command, Document } from '../../src/protocol/store.js';
import type { Asset } from '../../src/protocol/assets.js';
import type { ImageState } from '../../src/protocol/history.js';
import type { FontVersion, TextCandidate, TextSource } from '../../src/protocol/text.js';
import { canonical, hashBytes, isId } from './canonical.js';
import { profile, profileRef, identity, validateSource, validateLayout, dependencyIdentity, dependencies, bundledFont } from '../text/validation.js';
import { keys, requireValue as ok } from '../../src/protocol/validate.js';

export class Texts {
 private verifying=false;private readyLoans=new Set<string>();
 reservedCPU=0;backendCPU:()=>number=()=>0;
 constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private epoch:string){}
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
  if(process.memoryUsage().rss+this.backendCPU()+134217728+134217728>536870912)throw new StoreError('CAPACITY');
  for(const old of predecessors){this.readyLoans.delete(String(old.id));this.db.prepare('DELETE FROM text_admissions WHERE id=?').run(old.id);}
  this.db.prepare('INSERT INTO text_admissions VALUES (?,?,?,?)').run(id,auth.clientId,auth.sessionHash,this.epoch);return {id,bytes:134217728};
 }
 releaseAdmission(id:string,auth:AssetAuth){if(this.verifying)throw new StoreError('QUEUE_FULL');const row=this.db.prepare('SELECT * FROM text_admissions WHERE id=?').get(id);if(row&&(row.client_id!==auth.clientId||row.session_hash!==auth.sessionHash||row.epoch!==this.epoch))throw new StoreError('OWNER_REQUIRED');this.readyLoans.delete(id);this.db.prepare('DELETE FROM text_admissions WHERE id=?').run(id);}
 externalBytes(){return this.db.prepare('SELECT id FROM text_admissions').all().reduce((n,row)=>n+134217728-(this.readyLoans.has(String(row.id))?Number(String(row.id).split('_')[2]):0),0);}
 guardMetadata(bytes:number){if(process.memoryUsage().rss+this.externalBytes()+this.reservedCPU+this.backendCPU()+bytes*6+16777216>536870912)throw new StoreError('CAPACITY');}
 source(ref:BlobRef){return validateSource(parseControlJSON(this.objects.verify(ref,true)!));}
 async inspect(ref:BlobRef,path=this.objects.path(ref)){
  if(this.verifying||this.reservedCPU)throw new StoreError('QUEUE_FULL');const row=this.db.prepare('SELECT id FROM text_admissions').get();const borrowed=!!row&&this.readyLoans.has(String(row.id));if(row&&!borrowed)throw new AssetRejection('CAPACITY','TEXT_REALM_OWNS_CAPACITY');
  if(BigInt(ref.byteLength)>16777216n||process.memoryUsage().rss+this.externalBytes()+this.reservedCPU+this.backendCPU()+67108864>536870912)throw new AssetRejection('CAPACITY','FONT_MEMORY_BUDGET');
  this.reservedCPU+=67108864;
  try{return await new Promise<any>((resolve,reject)=>{
   const w=new Worker(new URL('../text/worker.js',import.meta.url),{workerData:{path,length:Number(ref.byteLength),hash:ref.hash},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});let result:any,error:unknown;
   const timer=setTimeout(()=>{error=new AssetRejection('CAPACITY','FONT_VALIDATION_DEADLINE');void w.terminate();},20000);
   w.on('message',m=>{if(m.ok)result=m.result;else error=new AssetRejection('INCOMPATIBLE',m.code);});w.on('error',()=>{error=new AssetRejection('INCOMPATIBLE','FONT_VALIDATION_FAILED');});w.on('exit',()=>{clearTimeout(timer);if(error)reject(error);else if(result)resolve(result);else reject(new StoreError('STORAGE_FAILURE'));});
  });}finally{this.reservedCPU-=67108864;}
 }
 async importFont(c:Command,id:string,protect:(ref:BlobRef)=>Promise<void>):Promise<Asset>{
  const b=c.body;if(b.type!=='ImportFont')throw new StoreError('UNSUPPORTED_COMMAND');
  await protect(b.source);await protect(b.license);if(BigInt(b.license.byteLength)>65536n)throw new AssetRejection('CAPACITY','FONT_LICENSE_LIMIT');
  const license=this.objects.verify(b.license,true)!;try{if(!new TextDecoder('utf-8',{fatal:true}).decode(license).trim())throw Error();}catch{throw new AssetRejection('INVALID_INPUT','FONT_LICENSE_REQUIRED');}
  const inspected=await this.inspect(b.source),value={schemaVersion:1 as const,bytes:b.source,faceIndex:0 as const,format:inspected.format,parserProfile:inspected.parserProfile,fsType:inspected.fsType,licenseRecord:b.license,origin:b.origin,embedding:'permitted' as const};
  const font:FontVersion={...value,id:identity(value)};try{bundledFont(font);}catch{throw new AssetRejection('INVALID_INPUT','FONT_BUNDLED_IDENTITY');}
  return {id,version:'1',purpose:'font',blob:b.source,dependencies:[b.license],safety:'safe',availability:'available',qualification:'font',measuredMediaType:'application/octet-stream',font};
 }
 fence(c:Command,d:Document,auth:AssetAuth,value:TextCandidate){
  const b=c.body;if(!('candidate'in b))throw new StoreError('UNSUPPORTED_COMMAND');
  const a=this.db.prepare('SELECT * FROM text_admissions WHERE id=?').get(b.admissionId);
  if(!a||a.client_id!==auth.clientId||a.session_hash!==auth.sessionHash||a.epoch!==this.epoch)throw new AssetRejection('STALE_REVISION','TEXT_ADMISSION_EXPIRED');
  const t=value.token;if(t.documentId!==d.id||t.documentRevision!==d.revision||t.layerId!==b.layerId||t.layerVersion!==(b.type==='CreateTextLayer'?'0':b.layerVersion)||t.sessionId!==b.draft.sessionId||String(t.generation)!==b.draft.generation||c.sessionId!==b.draft.sessionId)throw new AssetRejection('STALE_REVISION','TEXT_TOKEN_CHANGED');
  const checkpoint=this.db.prepare('SELECT json FROM ui_checkpoints WHERE client_id=? AND session_id=?').get(c.clientId,b.draft.sessionId);const draft=checkpoint?JSON.parse(String(checkpoint.json)).drafts.find((x:any)=>x.id===b.draft.draftId):null;const asset=draft?this.assets.asset(draft.assetId):null;if(!asset||draft.kind!=='text')throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_REQUIRED');const saved=parseControlJSON(this.objects.verify(asset.blob,true)!);textDraft(saved);if(canonical(saved.textUtf8)!==canonical(value.source.text.textUtf8)||canonical(saved.style)!==canonical(value.source.text.style)||canonical(saved.frame)!==canonical(value.source.text.frame)||canonical(saved.fonts)!==canonical(value.source.text.fonts))throw new AssetRejection('STALE_REVISION','TEXT_DRAFT_CONTENT_CHANGED');
  if(value.source.render.rendererProfile.id!==profile.id||canonical(value.source.render.rendererProfile.manifest)!==canonical(profileRef))throw new AssetRejection('INCOMPATIBLE','TEXT_PROFILE_UNSUPPORTED');
  if('reviewedDependencyHash'in b&&b.reviewedDependencyHash!==value.source.render.dependencyHash)throw new AssetRejection('STALE_REVISION','TEXT_REFLOW_REVIEW_CHANGED');
 }
 async candidate(c:Command,d:Document,auth:AssetAuth,protect:(ref:BlobRef)=>Promise<void>,check:()=>void){
  const b=c.body;if(!('candidate'in b))throw new StoreError('UNSUPPORTED_COMMAND');await protect(b.candidate);
  let value:TextCandidate;
  try{value=parseControlJSON(this.objects.verify(b.candidate,true)!) as unknown as TextCandidate;keys(value,['schemaVersion','token','source']);ok(value.schemaVersion===1);keys(value.token,['documentId','documentRevision','layerId','layerVersion','sessionId','generation']);ok(Number.isSafeInteger(value.token.generation)&&value.token.generation>=0);validateSource(value.source);}catch{throw new AssetRejection('INVALID_INPUT','TEXT_CANDIDATE_INVALID');}
  this.fence(c,d,auth,value);const s=value.source;
  for(const ref of dependencies(s))await protect(ref);
  if(dependencyIdentity(s)!==s.render.dependencyHash)throw new AssetRejection('INVALID_INPUT','TEXT_DEPENDENCY_HASH');
  for(const f of s.text.fonts){const rows=this.db.prepare("SELECT json FROM assets WHERE json_extract(json,'$.font.id')=?").all(f.id);if(!rows.some(row=>canonical(JSON.parse(String(row.json)).font)===canonical(f)))throw new AssetRejection('INCOMPATIBLE','FONT_IMPORT_REQUIRED');}
  const bytes=Number(s.render.layout.byteLength);if(process.memoryUsage().rss+this.externalBytes()+this.reservedCPU+this.backendCPU()+bytes*6+16777216>536870912||bytes*6+16777216>134217728)throw new AssetRejection('CAPACITY','TEXT_VALIDATION_MEMORY');
  try{const layout=this.read(s.render.layout,8388608),text=this.objects.verify(s.text.textUtf8,true)!;validateLayout(s,layout,text);if(b.type==='CreateTextLayer'&&text.length===0)throw new Error();}catch{throw new AssetRejection('INVALID_INPUT','TEXT_LAYOUT_INVALID');}
  await this.verify(s,ref=>this.objects.path(ref),check,b.admissionId);
  return value;
 }
 async verify(s:TextSource,path:(ref:BlobRef)=>string,check:()=>void,admissionId?:string){
  check();if(this.verifying)throw new StoreError('QUEUE_FULL');if(!retainedProfile(s.render.rendererProfile))throw new AssetRejection('INCOMPATIBLE','TEXT_PROFILE_UNSUPPORTED');
  const textBytes=readFileSync(path(s.text.textUtf8));if(hashBytes(textBytes)!==s.text.textUtf8.hash)throw new StoreError('CORRUPT_OBJECT');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(textBytes);
  let budget;try{budget=verificationBudget(text,s.text.frame.width,s.text.frame.height,s.text.fonts.reduce((n,f)=>n+Number(f.bytes.byteLength),0),profile.engine.wasm.bytes);}catch{throw new AssetRejection('CAPACITY','TEXT_VERIFICATION_CAPACITY');}
  const row=this.db.prepare('SELECT id FROM text_admissions').get();const borrowed=!!admissionId&&row?.id===admissionId;
  if(borrowed){if(Number(admissionId!.split('_')[2])!==budget.bytes)throw new AssetRejection('INVALID_INPUT','TEXT_VERIFICATION_ADMISSION');this.readyLoans.add(admissionId!);}
  else if(row)throw new AssetRejection('CAPACITY','TEXT_REALM_OWNS_CAPACITY');
  if(this.reservedCPU||process.memoryUsage().rss+this.externalBytes()+this.backendCPU()+budget.bytes>536870912)throw new AssetRejection('CAPACITY','TEXT_VERIFICATION_CAPACITY');
  this.verifying=true;this.reservedCPU=budget.bytes;
  try{await runVerification({request:{text,style:s.text.style,frame:s.text.frame,token:{documentId:'verification',documentRevision:'0',layerId:'verification',layerVersion:'0',sessionId:'verification',generation:0}},profile:s.render.rendererProfile.id,fonts:s.text.fonts.map(f=>({path:path(f.bytes),length:Number(f.bytes.byteLength),hash:f.bytes.hash,licenseHash:f.licenseRecord.hash,origin:f.origin})),expected:{layoutPath:path(s.render.layout),layoutHash:s.render.layout.hash,pixelsHash:s.render.pixels.hash,textHash:s.text.textUtf8.hash,overflow:s.render.overflow}},check);check();}finally{this.verifying=false;this.reservedCPU=0;}
 }
 private read(ref:BlobRef,limit:number){if(BigInt(ref.byteLength)>BigInt(limit))throw new StoreError('CAPACITY');const result=Buffer.alloc(Number(ref.byteLength));for(let at=0;at<result.length;at+=1048576)result.set(this.objects.readRange(ref,String(at),Math.min(1048576,result.length-at)),at);return result;}
 limits(state:ImageState){let bytes=0;const fonts=new Map<string,FontVersion>();for(const l of state.layers)if(l.kind==='text'){const s=this.source(l.source);bytes+=Number(s.text.textUtf8.byteLength);for(const f of s.text.fonts)fonts.set(f.bytes.hash+':'+f.faceIndex,f);}if(bytes>1048576||state.layers.length>100||fonts.size>16||[...fonts.values()].reduce((n,f)=>n+Number(f.bytes.byteLength),0)>67108864)throw new AssetRejection('CAPACITY','TEXT_DOCUMENT_LIMIT');}
}

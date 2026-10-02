import type {DatabaseSync} from 'node:sqlite';
import type {BlobRef,Document} from '../../src/protocol/store.js';
import type {RecoveryDisclosure} from '../../src/protocol/portable.js';
import {keys,requireValue as ok,id,seq,blob,asset as assetRecord} from '../../src/protocol/validate.js';
import {imageState} from '../../src/protocol/history-validation.js';
import {validString} from '../../src/composition/core.js';
import {validateMaskMapping} from '../../src/raster/mapping.js';
import {textSource} from '../../src/protocol/text.js';
import {canonical,hashBytes,validateBlob} from '../storage/canonical.js';
import {assertPrivate} from '../storage/files.js';
import {StoreError} from '../storage/errors.js';
import type {Objects} from '../storage/objects.js';
import type {Assets} from '../storage/assets.js';
import {privacyPolicy,providerRecord,safeTimings} from './provenance.js';

/** PF-11 is a new observation profile, never an editable subset of PF-10.
 * No original JSON object, history node, request, manifest or event is copied.
 * Only reconstructed scalars and explicitly selected leaf bytes cross it. */
export const RECOVERY_OMISSIONS = ['history','checkpoints','drafts','jobs','creation-background-provenance','text-origin-provenance','request-authority','adoption-authority','backend-transport','unsafe-or-incomplete-returned-prompts','unavailable-or-unsafe-content'] as const;
export function recoveryDisclosure(acknowledgementId:string):RecoveryDisclosure {
 ok(id(acknowledgementId));
 return {kind:'tp1-sanitized-recovery-v1',label:'Incomplete sanitized recovery copy',sanitized:true,authority:'observation-only',acknowledgementId,scope:'current-document-safe-content',omissions:[...RECOVERY_OMISSIONS]};
}
export function recoveryEntity(kind:string,v:any){
 if(kind==='recovery-provider'){providerRecord(v);ok(v.derivation.complete===false);return;}
 if(kind==='recovery-text'){
  keys(v,['schemaVersion','id','documentId','ownerId','purpose','blob']);ok(v.schemaVersion===1&&id(v.id)&&id(v.documentId)&&id(v.ownerId)&&['layer-text','requested-prompt','submitted-prompt','returned-prompt'].includes(v.purpose));blob(v.blob);ok(v.blob.mediaType==='text/plain');return;
 }
 if(kind==='recovery-asset'){
  keys(v,['schemaVersion','id','version','width','height','role','blob','pixels']);ok(v.schemaVersion===1&&id(v.id)&&seq(v.version)&&['native','composite','mask','export'].includes(v.role));extent(v);blob(v.blob);blob(v.pixels);ok(['image/png','image/jpeg'].includes(v.blob.mediaType)&&v.pixels.mediaType==='application/x-ideogram-rgba8'&&v.pixels.byteLength===String(v.width*v.height*4));return;
 }
 ok(kind==='recovery-document');keys(v,['schemaVersion','id','revision','name','width','height','compositeAssetId','layers','omitted']);ok(v.schemaVersion===1&&id(v.id)&&seq(v.revision)&&(v.name===null||typeof v.name==='string'&&v.name.length>0&&v.name.length<=256&&v.name.trim()===v.name&&!/[\u0000-\u001f\u007f]/.test(v.name)&&Buffer.byteLength(v.name)<=256)&&(v.compositeAssetId===null||id(v.compositeAssetId)));extent(v);
 keys(v.omitted,['assets','texts','providerRecords']);ok(Object.values(v.omitted).every(n=>Number.isSafeInteger(n)&&Number(n)>=0));
 ok(Array.isArray(v.layers)&&v.layers.length<=100&&new Set(v.layers.map((l:any)=>l.id)).size===v.layers.length);
 for(const l of v.layers){keys(l,['id','version','kind','name','appearanceDescription','assetId','layerToDocument','opacity','visible','locked','blend','mask','maskOmitted','textRef']);
  ok(id(l.id)&&seq(l.version)&&['image','text'].includes(l.kind)&&typeof l.name==='string'&&l.name.length>0&&Buffer.byteLength(l.name)<=1024&&(l.appearanceDescription===null||validString(l.appearanceDescription))&&(l.assetId===null||id(l.assetId))&&Array.isArray(l.layerToDocument)&&l.layerToDocument.length===6&&l.layerToDocument.every(Number.isFinite)&&typeof l.opacity==='number'&&Number.isFinite(l.opacity)&&l.opacity>=0&&l.opacity<=1&&typeof l.visible==='boolean'&&typeof l.locked==='boolean'&&l.blend==='normal'&&typeof l.maskOmitted==='boolean'&&(!l.maskOmitted||l.mask===null));
  if(l.mask!==null)validateMaskMapping(l.mask);if(l.textRef!==null){blob(l.textRef);ok(l.kind==='text'&&l.textRef.mediaType==='text/plain');}
 }
}
function extent(v:any){ok(Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000);}
export function recoveryAssetAllowed(db:DatabaseSync,assetId:string){
 // A later safety withdrawal also covers already-normalized descendants. A
 // safe wrapper cannot launder a withheld candidate through its frozen pixels.
 // Keep absent IDs in the final check. Missing ancestry is unknown authority,
 // not proof that a descendant is safe. UNION visits each reachable ID once,
 // including when corrupt metadata contains a cycle. Linked candidate safety
 // must be explicitly safe; SQL NULL includes absent/unclassified evidence.
 return !db.prepare(`WITH RECURSIVE ancestry(id) AS (VALUES (?) UNION SELECT j.value FROM ancestry p JOIN assets a ON a.id=p.id JOIN json_each(a.json,'$.raster.sourceAssetIds') j)
 SELECT 1 FROM ancestry p LEFT JOIN assets a ON a.id=p.id WHERE a.id IS NULL OR json_extract(a.json,'$.safety') IN ('withheld','quarantined')
 OR EXISTS (SELECT 1 FROM candidates c WHERE json_extract(c.json,'$.safety') IS NOT 'safe' AND (json_extract(c.json,'$.encodedAssetId')=p.id OR json_extract(c.json,'$.preparedAssetId')=p.id))
 OR EXISTS (SELECT 1 FROM portable_rows r WHERE r.kind='candidate-result' AND json_extract(r.json,'$.safety') IS NOT 'safe' AND (json_extract(r.json,'$.encodedAssetId')=p.id OR json_extract(r.json,'$.preparedAssetId')=p.id)) LIMIT 1`).get(assetId);
}
export function recoveryReferences(kind:string,v:any,emit:(ref:BlobRef)=>void){
 recoveryEntity(kind,v);
 if(kind==='recovery-asset'){emit(v.blob);emit(v.pixels);}
 else if(kind==='recovery-text')emit(v.blob);
 else if(kind==='recovery-document'){for(const l of v.layers)if(l.textRef)emit(l.textRef);}
 else for(const k of ['requestedPromptRef','submittedPromptRef','returnedPromptRef','privacyPolicyRef','safeTimingsRef'])if(v[k])emit(v[k]);
}

/** Scoped selection and deduplication stay on disk; large text/raster bytes are
 * never materialized. This is called under the writer's capture transaction. */
export function captureRecovery(db:DatabaseSync,out:DatabaseSync,document:Document,objects:Objects,assets:Assets,check:()=>void){
 out.exec('CREATE TABLE recovery_denied(hash TEXT PRIMARY KEY) STRICT; CREATE TABLE recovery_selected_assets(id TEXT PRIMARY KEY,available INTEGER NOT NULL) STRICT;');
 for(const row of db.prepare('SELECT hash FROM portable_quarantined_hashes').iterate())out.prepare('INSERT OR IGNORE INTO recovery_denied VALUES (?)').run(row.hash);
 const deny=(hash:unknown)=>{if(typeof hash==='string'&&/^sha256:[a-f0-9]{64}$/.test(hash))out.prepare('INSERT OR IGNORE INTO recovery_denied VALUES (?)').run(hash);};
 // Body hashes are evidence metadata, not export edges, even if another record
 // happens to use the same hash as an otherwise allowable leaf.
 for(const row of db.prepare("SELECT json FROM candidate_jobs WHERE json_extract(json,'$.documentId')=?").iterate(document.id)){const p=JSON.parse(String(row.json)).provenance;if(p){deny(p.sourceBodyHash);if(p.quarantined||!p.complete)deny(p.returnedPrompt?.hash);}}
 for(const row of db.prepare("SELECT r.json FROM portable_rows r JOIN portable_namespaces n ON n.id=r.namespace WHERE n.document_id=? AND r.kind='portable-provider'").iterate(document.id)){const p=JSON.parse(String(row.json));deny(p.derivation.sourceBodyHash);if(!p.derivation.complete)deny(p.returnedPromptRef?.hash);}
 const omitted={assets:0,texts:0,providerRecords:0};
 const available=(ref:BlobRef)=>{
  validateBlob(ref);if(out.prepare('SELECT 1 FROM recovery_denied WHERE hash=?').get(ref.hash))return false;
  const owned=db.prepare('SELECT byte_length FROM objects WHERE hash=? AND EXISTS (SELECT 1 FROM roots WHERE hash=? AND media_type=?)').get(ref.hash,ref.hash,ref.mediaType);if(!owned)return false;if(owned.byte_length!==ref.byteLength)throw new StoreError('CORRUPT_OBJECT');
  try{if(BigInt(assertPrivate(objects.path(ref),false).size)!==BigInt(ref.byteLength))throw new StoreError('CORRUPT_OBJECT');}catch(e){if((e as NodeJS.ErrnoException)?.code==='ENOENT')return false;throw e;}return true;
 };
 const keep=(ref:BlobRef)=>{const old=out.prepare('SELECT bytes,media FROM refs WHERE hash=?').get(ref.hash);if(old&&(old.bytes!==ref.byteLength||old.media!==ref.mediaType))throw new StoreError('CORRUPT_OBJECT');out.prepare('INSERT OR IGNORE INTO refs(hash,bytes,media) VALUES (?,?,?)').run(ref.hash,ref.byteLength,ref.mediaType);};
 const add=(kind:string,key:string,value:any)=>{recoveryEntity(kind,value);const raw=canonical(value);if(Buffer.byteLength(raw)>65536)throw new StoreError('PAYLOAD_TOO_LARGE');out.prepare('INSERT OR IGNORE INTO entities VALUES (?,?,?,NULL)').run(kind,key,raw);recoveryReferences(kind,value,keep);};
 const read=(ref:BlobRef)=>{if(ref.mediaType!=='application/json'||BigInt(ref.byteLength)>65536n||!available(ref))return null;const bytes=objects.verify(ref,true)!;const v=JSON.parse(Buffer.from(bytes).toString('utf8'));if(canonical(v)!==Buffer.from(bytes).toString('utf8'))throw new StoreError('CORRUPT_OBJECT');return v;};
 const recoverAsset=(assetId:string|null):string|null=>{
  if(assetId===null)return null;const prior=out.prepare('SELECT available FROM recovery_selected_assets WHERE id=?').get(assetId);if(prior)return prior.available?assetId:null;
  check();const a=assets.asset(assetId);if(a)assetRecord(a);
  const usable=!!a&&a.safety==='safe'&&a.availability==='available'&&['canonical-raster','canonical-png','canonical-jpeg'].includes(a.qualification)&&['image/png','image/jpeg'].includes(a.blob.mediaType)&&!!a.raster&&['native','composite','mask','export'].includes(a.raster.role)&&a.raster.pixels.mediaType==='application/x-ideogram-rgba8'&&recoveryAssetAllowed(db,assetId)&&available(a.blob)&&available(a.raster.pixels);
  out.prepare('INSERT INTO recovery_selected_assets VALUES (?,?)').run(assetId,usable?1:0);
  if(!usable){omitted.assets++;return null;}
  add('recovery-asset',assetId,{schemaVersion:1,id:a!.id,version:a!.version,width:a!.raster!.width,height:a!.raster!.height,role:a!.raster!.role,blob:a!.blob,pixels:a!.raster!.pixels});return assetId;
 };
 const recoverText=(ref:BlobRef|null,ownerId:string,purpose:string):BlobRef|null=>{
  if(!ref)return null;if(ref.mediaType!=='text/plain'||!available(ref)){omitted.texts++;return null;}
  const key='t_'+hashBytes(canonical([ownerId,purpose,ref])).slice(7);add('recovery-text',key,{schemaVersion:1,id:key,documentId:document.id,ownerId,purpose,blob:ref});return ref;
 };
 const layers:any[]=[];
 if(document.image){const state=read(document.image.state);if(state){imageState(state);if(hashBytes(canonical({...state,layers:state.layers.map(({version,...l})=>l)}))!==document.image.semanticDigest||state.width!==document.width||state.height!==document.height||canonical(state.layers.map((l:any)=>l.id))!==canonical(document.orderedLayerIds))throw new StoreError('CORRUPT_OBJECT');
   for(const l of state.layers){let textRef:BlobRef|null=null;if(l.kind==='text'){const source=read(l.source);if(source){textSource(source);textRef=recoverText(source.text.textUtf8,l.id,'layer-text');}else omitted.texts++;}
    const maskAsset=l.mask?recoverAsset(l.mask.assetId):null;layers.push({id:l.id,version:l.version,kind:l.kind,name:l.name,appearanceDescription:l.appearanceDescription??null,assetId:recoverAsset(l.assetId),layerToDocument:l.layerToDocument,opacity:l.opacity,visible:l.visible,locked:l.locked,blend:'normal',mask:maskAsset?{...l.mask,assetId:maskAsset}:null,maskOmitted:!!l.mask&&!maskAsset,textRef});
   }
  }else omitted.assets+=document.orderedLayerIds.length;
 }
 const compositeAssetId=recoverAsset(document.image?.compositeAssetId??null);
 const provider=(attemptId:string,p:any)=>{
  // Exact field construction is intentional: unknown provider JSON remains in
  // the protected original. No URLs, arbitrary errors, headers or authority.
  const requestedPromptRef=recoverText(p.requestedPromptRef,attemptId,'requested-prompt'),submittedPromptRef=recoverText(p.submittedPromptRef,attemptId,'submitted-prompt'),returnedPromptRef=p.derivation.complete?recoverText(p.returnedPromptRef,attemptId,'returned-prompt'):null;
  if(!p.derivation.complete)omitted.texts++;
  const policy=read(p.privacyPolicyRef);if(!policy){omitted.providerRecords++;return;}privacyPolicy(policy);
  let safeTimingsRef:BlobRef|null=null;if(p.safeTimingsRef){const timings=read(p.safeTimingsRef);if(timings){safeTimings(timings);safeTimingsRef=p.safeTimingsRef;}}
  // Hash strings are inert observations; unlike BlobRefs they are never walked.
  const value={class:'portable-provider',attemptId,endpoint:p.endpoint,requestId:p.requestId,status:p.status,assetHashes:p.assetHashes,requestedPromptRef,submittedPromptRef,returnedPromptRef,seedText:p.seedText,safeTimingsRef,privacyPolicyRef:p.privacyPolicyRef,derivation:{profile:'TP-1',sourceBodyHash:p.derivation.sourceBodyHash,complete:false}};
  // A provider may return more image-hash observations than fit one ordinary
  // control record. Keep the separately selected content; disclose omission of
  // the whole observation instead of truncating a field and calling it exact.
  if(Buffer.byteLength(canonical(value))>65536){omitted.providerRecords++;return;}
  add('recovery-provider',attemptId,value);
 };
 // Keep independently usable prepared pixels. Unknown/withheld candidates are
 // excluded even if a stale asset row still happens to say safety:'safe'.
 for(const row of db.prepare('SELECT json FROM candidates WHERE document_id=? ORDER BY id').iterate(document.id)){const c=JSON.parse(String(row.json));if(c.safety==='safe'&&c.state==='prepared'&&c.preparedAssetId)recoverAsset(c.preparedAssetId);else if(c.preparedAssetId||c.encodedAssetId)omitted.assets++;}
 for(const row of db.prepare("SELECT json FROM queue_jobs WHERE json_extract(json,'$.documentId')=? ORDER BY id").iterate(document.id)){const job=JSON.parse(String(row.json));recoverText(job.review.prompt,job.id,'requested-prompt');check();}
 for(const row of db.prepare("SELECT json FROM candidate_jobs WHERE json_extract(json,'$.documentId')=? ORDER BY job_id").iterate(document.id)){
  const r=JSON.parse(String(row.json)),p=r.provenance;if(!p)continue;const rowJob=db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(r.jobId);if(!rowJob){omitted.providerRecords++;continue;}const job=JSON.parse(String(rowJob.json));if(job.documentId!==document.id)throw new StoreError('CORRUPT_STORE');const attempt=job.attempts.find((a:any)=>a.id===r.attemptId);if(!attempt)throw new StoreError('CORRUPT_STORE');
  const assetHashes:string[]=[];for(const row of db.prepare("SELECT json FROM candidates WHERE job_id=? AND json_extract(json,'$.attemptId')=? ORDER BY id").iterate(r.jobId,r.attemptId)){const c=JSON.parse(String(row.json)),a=c.safety==='safe'&&c.encodedAssetId?assets.asset(c.encodedAssetId):null;if(a)assetHashes.push(a.blob.hash);}
  provider(r.attemptId,{endpoint:job.review.endpoint,requestId:attempt.requestId,status:r.observation.phase,assetHashes,requestedPromptRef:p.requestedPrompt,submittedPromptRef:p.submittedPrompt,returnedPromptRef:p.returnedPrompt,seedText:p.returnedSeed,safeTimingsRef:null,privacyPolicyRef:p.privacyPolicy,derivation:{sourceBodyHash:p.sourceBodyHash,complete:p.complete&&!p.quarantined}});check();
 }
 for(const row of db.prepare("SELECT r.kind,r.id,r.json FROM portable_rows r JOIN portable_namespaces n ON n.id=r.namespace WHERE n.document_id=? AND r.kind IN ('portable-provider','candidate-result','job-result') ORDER BY r.kind,r.id").iterate(document.id)){
  const value=JSON.parse(String(row.json));if(row.kind==='portable-provider'){providerRecord(value);provider(String(row.id),value);}else if(row.kind==='job-result')recoverText(value.request.prompt,String(row.id),'requested-prompt');else if(value.documentId===document.id&&value.safety==='safe'&&value.state==='prepared'&&value.preparedAssetId)recoverAsset(value.preparedAssetId);check();
 }
 add('recovery-document',document.id,{schemaVersion:1,id:document.id,revision:document.revision,name:(document as Document&{metadata?:{name:string}}).metadata?.name??null,width:document.width,height:document.height,compositeAssetId,layers,omitted});
 return {omitted};
}

/** Structural closure for inspection only. It cannot validate or restore any
 * request/history/adoption authority because that profile contains none. */
export async function validateRecoveryRecords(db:DatabaseSync,sourceNamespace:string,check:()=>void,read?:(ref:BlobRef)=>Promise<Uint8Array>){
 ok(!db.prepare('SELECT 1 FROM events LIMIT 1').get()&&!db.prepare('SELECT 1 FROM transactions LIMIT 1').get());
 ok(Number(db.prepare("SELECT count(*) n FROM entities WHERE kind='recovery-document'").get()!.n)===1);
 db.exec('CREATE TABLE IF NOT EXISTS recovery_needed(hash TEXT PRIMARY KEY,bytes TEXT NOT NULL,media TEXT NOT NULL) STRICT; DELETE FROM recovery_needed;');
 const needed=(ref:BlobRef)=>{const row=db.prepare('SELECT bytes,media FROM refs WHERE hash=?').get(ref.hash);ok(row&&row.bytes===ref.byteLength&&row.media===ref.mediaType);const old=db.prepare('SELECT bytes,media FROM recovery_needed WHERE hash=?').get(ref.hash);ok(!old||old.bytes===ref.byteLength&&old.media===ref.mediaType);db.prepare('INSERT OR IGNORE INTO recovery_needed VALUES (?,?,?)').run(ref.hash,ref.byteLength,ref.mediaType);};
 const asset=(assetId:string|null)=>{if(assetId!==null)ok(db.prepare("SELECT 1 FROM entities WHERE kind='recovery-asset' AND id=?").get(assetId));};
 for(const row of db.prepare('SELECT * FROM entities ORDER BY kind,id').iterate()){
  const v=JSON.parse(String(row.json)),kind=String(row.kind);recoveryEntity(kind,v);ok((kind==='recovery-provider'?v.attemptId:v.id)===row.id);recoveryReferences(kind,v,needed);
  if(kind==='recovery-document'){ok(v.id===sourceNamespace);asset(v.compositeAssetId);for(const l of v.layers){asset(l.assetId);if(l.mask)asset(l.mask.assetId);}}
  if(kind==='recovery-text')ok(v.documentId===sourceNamespace);
  if(kind==='recovery-provider'){
   ok(!db.prepare('SELECT 1 FROM refs WHERE hash=?').get(v.derivation.sourceBodyHash));
   for(const [ref,validate] of [[v.privacyPolicyRef,privacyPolicy],[v.safeTimingsRef,safeTimings]] as const)if(ref){ok(BigInt(ref.byteLength)<=65536n);if(read){const bytes=await read(ref),value=JSON.parse(Buffer.from(bytes).toString('utf8'));ok(canonical(value)===Buffer.from(bytes).toString('utf8'));validate(value);}}
  }
  check();await new Promise<void>(resolve=>setImmediate(resolve));
 }
 // Entity payload bytes are the only other permitted objects. Extra objects,
 // including old archives or opaque JSON metadata, cannot hitchhike in PF-11.
 for(const row of db.prepare('SELECT json FROM records').iterate())needed(JSON.parse(String(row.json)).payloadRef);
 for(const row of db.prepare('SELECT hash,json FROM payloads').iterate())needed({hash:String(row.hash),byteLength:String(Buffer.byteLength(String(row.json))),mediaType:'application/json'});
 ok(!db.prepare('SELECT 1 FROM refs WHERE hash NOT IN (SELECT hash FROM recovery_needed) LIMIT 1').get());
}

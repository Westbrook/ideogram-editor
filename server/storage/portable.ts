import {draftShape as requestDraft,refs as requestRefs} from '../../src/request/core.js';
import {readComposition,compositionRefs,verifyReview} from './composition.js';
import {compositionDraft,compositionDraftRefs} from '../../src/composition/draft.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import {maskDraftValue,maskBindings,maskImports,maskSource,resolveMaskPlan} from '../../src/raster/mask.js';
import {textDraft,draftRefs} from '../../src/protocol/text.js';
import { UnsupportedText, bundledFont, validateSource, dependencies } from '../text/validation.js';
import type { Texts } from './text.js';
import { captureTransactions, addTransaction, validateTransactions } from '../portable/transactions.js';
import { CODEC_ID } from '../raster/identity.js';
import { PIXEL_PIPELINE } from '../../src/raster/core.js';
import { providerRecord } from '../portable/provenance.js';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, constants, readSync, fsyncSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BlobRef, Command, Document, Receipt } from '../../src/protocol/store.js';
import type { Bundle, BundleReview, PortableFact } from '../../src/protocol/portable.js';
import { isPortableCommand } from '../../src/protocol/portable.js';
import { canonical, hashBytes, isId, parseCommand } from './canonical.js';
import { StoreError, safeError } from './errors.js';
import { AssetRejection, type Assets, type AssetAuth } from './assets.js';
import type { Objects, Barrier } from './objects.js';
import type { Rasters } from './raster.js';
import { assertPrivate, privateDirectory, privateFile, syncDirectory } from './files.js';
import { ZipIndex, writeZip, spool, tick, write, invalid, crc32 } from '../portable/zip.js';
import { defineIndex, references, addRef, json, fileSource, encodeRecords, decodeRecords } from '../portable/format.js';
import { validateClosure, validateUI } from '../portable/closure.js';
import { imageState } from '../../src/protocol/history-validation.js';
import { entity, event, rasterManifest } from '../../src/protocol/validate.js';
import { semanticDigest } from './history.js';
export type PortableBuild={fact:PortableFact;documentRevision:string|null};
export type PortableCommit=(bytes:Uint8Array,build:()=>PortableBuild,slot?:string)=>Receipt;
const stamp=(path:string)=>{const s=assertPrivate(path,false);return canonical([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);};
const refFrom=(r:any):BlobRef=>({hash:String(r.hash),byteLength:String(r.bytes),mediaType:String(r.media)});
type LoadedArchive={db:DatabaseSync;zip:ZipIndex;manifest:any;read:(ref:BlobRef)=>Promise<Uint8Array>};
export class Portables {
 private running:Promise<void>|undefined;private paused=new Set<string>();private failures=new Map<string,string>();private closing=false;
 private authorities=new Map<string,{auth:AssetAuth;start:number}>();
 private directory:string;observations:Record<string,unknown>[]=[];
 private reads=new Map<string,{ref:BlobRef;proof:string;client:string;session:string;expires:number;slot:string}>();
 constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,private rasters:Rasters,private texts:Texts,private root:string,private epoch:string,private check:()=>void,private barrier:Barrier,private commit:PortableCommit,private document:(id:string)=>Document|null,private register:(owner:string,ref:BlobRef,proof?:string)=>void){
  this.directory=join(root,'portable');privateDirectory(this.directory);
  // Exclusive startup has no surviving readers from the prior process. A crash
  // after receipt commit can leave only our now-terminal operation pins behind.
  this.transaction(()=>this.db.prepare('DELETE FROM portable_pins WHERE operation_id NOT IN (SELECT operation_id FROM portable_preparations)').run());
 }
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{this.check();const out=fn();this.db.exec('COMMIT');return out;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
 pending(id:string){const r=this.db.prepare('SELECT * FROM portable_preparations WHERE id=?').get(id);if(!r)return null;const request=parseCommand(Buffer.from(String(r.original)));if(canonical(request)!==r.canonical||hashBytes(String(r.canonical))!==r.hash||!isPortableCommand(request.command.body.type))throw new StoreError('CORRUPT_STORE');return {command:request.command,hash:String(r.hash),operationId:String(r.operation_id),phase:r.phase==='preparing'?'preparing' as const:'waiting-for-resources' as const};}
 command(bytes:Uint8Array,auth:AssetAuth):Receipt|null{
  const confirmedAt=Date.now(),confirmedStart=performance.now();this.check();const request=parseCommand(bytes),c=request.command,serialized=canonical(request),hash=hashBytes(serialized);if(c.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');if(!isPortableCommand(c.body.type))throw new StoreError('UNSUPPORTED_COMMAND');
  const prior=this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);if(prior){if(prior.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return JSON.parse(String(prior.receipt));}
  for(const table of ['asset_preparations','raster_preparations','history_preparations'])if(this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(c.commandId))throw new StoreError('COMMAND_ID_REUSE');
  const pending=this.pending(c.commandId);if(pending){if(pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');this.authorities.set(c.commandId,{auth:{...auth},start:performance.now()});this.paused.delete(c.commandId);this.failures.delete(c.commandId);this.schedule();return null;}
  if(c.body.type==='CancelPortable'){
   let target='';const receipt=this.commit(bytes,()=>{const row=this.db.prepare('SELECT id,canonical FROM portable_preparations WHERE operation_id=?').get(c.body.type==='CancelPortable'?c.body.operationId:'');if(!row||JSON.parse(String(row.canonical)).command.clientId!==auth.clientId)throw new AssetRejection('INVALID_INPUT','PORTABLE_OPERATION_UNAVAILABLE');target=String(row.id);this.db.prepare("INSERT OR IGNORE INTO portable_cancellations VALUES (?,'user-requested')").run(row.id);return {fact:{type:'PortableCancelled',payload:{operationId:c.body.type==='CancelPortable'?c.body.operationId:''}},documentRevision:null};});
   this.paused.delete(target);this.schedule();return receipt;
  }
  if(Number(this.db.prepare('SELECT (SELECT count(*) FROM asset_preparations)+(SELECT count(*) FROM raster_preparations)+(SELECT count(*) FROM history_preparations)+(SELECT count(*) FROM portable_preparations) n').get()!.n)>=64)throw new StoreError('QUEUE_FULL');
  const operationId=randomUUID(),captureSlot='capture:'+operationId;let frozen:any=null;
  if(c.body.type==='SaveCopy'){this.objects.acquire(captureSlot);try{const dbBytes=BigInt(assertPrivate(join(this.root,'metadata.sqlite'),false).size),wal=(()=>{try{return BigInt(assertPrivate(join(this.root,'metadata.sqlite-wal'),false).size);}catch{return 0n;}})();this.objects.reserve(captureSlot,2n*(dbBytes+wal)+1048576n);}catch(e){this.objects.release(captureSlot);throw e;}}
  try{this.transaction(()=>{
   if(c.body.type==='SaveCopy'){
    const d=c.documentId?this.document(c.documentId):null;if(!d||c.expectedDocumentRevision!==d.revision)throw new StoreError('MALFORMED_REQUEST');
    frozen=this.capture(operationId,d);this.barrier('portable-capture-pinned');
   }else if(c.body.type==='PreviewBundleImport'){
    if(c.documentId!==null||c.expectedDocumentRevision!==null)throw new StoreError('MALFORMED_REQUEST');const s=this.assets.bundleSource(c.body.stagingId,auth);if(s.record.sha256!==c.body.expectedSha256)throw new StoreError('MALFORMED_REQUEST');frozen={stagingId:s.record.stagingId,version:s.record.version,source:{hash:s.record.sha256,byteLength:s.record.expectedBytes,mediaType:s.record.mediaType}};
   }else if(c.body.type==='ImportBundle'){
    if(c.documentId!==null||c.expectedDocumentRevision!==null)throw new StoreError('MALFORMED_REQUEST');const review=this.review(c.body.reviewId,auth);if(review.reviewHash!==c.body.reviewHash)throw new StoreError('MALFORMED_REQUEST');frozen=review;
   }
   this.db.prepare('INSERT INTO portable_preparations VALUES (?,?,?,?,?,?,?,?,NULL)').run(c.commandId,hash,Buffer.from(bytes).toString('utf8'),serialized,operationId,'preparing',canonical(frozen),confirmedAt);this.barrier('portable-preparation-before-commit');
  });}finally{this.objects.unreserve(captureSlot);this.objects.release(captureSlot);}this.barrier('portable-preparation-after-commit');this.authorities.set(c.commandId,{auth:{...auth},start:confirmedStart});this.schedule();return null;
 }
 pendingCount(documentId:string,clientId:string){return Number(this.db.prepare("SELECT count(*) n FROM portable_preparations WHERE json_extract(canonical,'$.command.documentId')=? AND json_extract(canonical,'$.command.clientId')=?").get(documentId,clientId)!.n);}
 private capture(operationId:string,d:Document){
  const dir=join(this.directory,operationId);privateDirectory(dir);const out=spool(join(dir,'capture.sqlite'));defineIndex(out);out.exec('BEGIN IMMEDIATE');
  const addEntity=(kind:string,id:string,value:any)=>{if(kind==='portable-provider')providerRecord(value);else if(kind!=='draft')entity(kind,value);out.prepare('INSERT INTO entities VALUES (?,?,?,NULL)').run(kind,id,canonical(value));references(value,r=>addRef(out,r));};
  const queue=(id:string)=>out.prepare('INSERT OR IGNORE INTO assets_queue(id) VALUES (?)').run(id);
  const font=(f:any)=>{const row=this.db.prepare("SELECT id,json FROM assets WHERE json_extract(json,'$.font.id')=? ORDER BY id LIMIT 1").get(f.id);if(!row||canonical(JSON.parse(String(row.json)).font)!==canonical(f))throw new StoreError('MISSING_OBJECT');queue(String(row.id));};
  const addState=(v:any)=>{if(!v)return;const s=json(this.objects.verify(v.state,true)!);imageState(s);if(semanticDigest(s)!==v.semanticDigest)throw new StoreError('CORRUPT_OBJECT');if(s.composition){addRef(out,s.composition.value);const c=readComposition(s.composition,r=>this.objects.verify(r,true)!);verifyReview(c,r=>this.objects.verify(r,true)!);for(const r of compositionRefs(c))addRef(out,r);}for(const l of s.layers){if(l.kind==='text'){addRef(out,l.source);const source=validateSource(json(this.objects.verify(l.source,true)!));for(const ref of dependencies(source))addRef(out,ref);source.text.fonts.forEach(font);}queue(l.assetId);if(l.mask)queue(l.mask.assetId);}if(v.compositeAssetId)queue(v.compositeAssetId);};
  try{
   addEntity('document',d.id,d);addState(d.image);
   for(const [table,kind] of [['history','history'],['checkpoints','checkpoint']])for(const r of this.db.prepare(`SELECT id,json FROM ${table} WHERE document_id=? ORDER BY id`).iterate(d.id)){const v=JSON.parse(String(r.json));addEntity(kind,String(r.id),v);if(kind==='history'&&v.kind==='image-edit'){addState(v.before);addState(v.after);}else addState(v.image);}
   const uiHash=createHash('sha256');for(const row of this.db.prepare('SELECT client_id,session_id,json FROM ui_checkpoints ORDER BY client_id,session_id').iterate()){
    const all=JSON.parse(String(row.json)),drafts=all.drafts.filter((x:any)=>x.documentId===d.id);if(all.preferences.documentId!==d.id&&!drafts.length)continue;
    const sessionId='ui_'+hashBytes(canonical([row.client_id,row.session_id])).slice(7),v={sessionId,uiSeq:all.uiSeq,preferences:all.preferences.documentId===d.id?all.preferences:null,drafts,reconciledLayerIds:all.preferences.documentId===d.id?all.reconciledLayerIds:[]};validateUI(v,d.id);addEntity('draft',sessionId,v);uiHash.update(canonical(v));for(const draft of drafts){
     const owner='ui:'+row.client_id+':'+row.session_id+':'+draft.id+':'+draft.generation,roots=this.db.prepare('SELECT hash,media_type FROM roots WHERE owner=?').all(owner),asset=this.assets.asset(draft.assetId);
     if(!asset||!roots.some(root=>root.hash===asset.blob.hash&&root.media_type===asset.blob.mediaType))throw new StoreError('MISSING_OBJECT',{kind:'resource-state',resourceId:draft.id,state:'required-current-draft-ownership-unavailable'});queue(draft.assetId);if(draft.kind==='mask'){const value=parseControlJSON(this.objects.verify(asset.blob,true)!);maskDraftValue(value);for(const id of maskBindings(value.plan,draft.maskBindings))queue(id);}if(draft.kind==='request'){const value=parseControlJSON(this.objects.verify(asset.blob,true)!);requestDraft(value);for(const ref of requestRefs(value))addRef(out,ref);}
     if(draft.kind==='composition'){const value=json(this.objects.verify(asset.blob,true)!);compositionDraft(value);for(const ref of compositionDraftRefs(value))addRef(out,ref);}
     if(draft.kind==='text'){const text=json(this.objects.verify(asset.blob,true)!);textDraft(text);for(const ref of draftRefs(text))addRef(out,ref);text.fonts.forEach(font);}
    }
   }
   for(const r of this.db.prepare("SELECT e.json FROM events_v2 e JOIN commands c ON c.id=e.command_id WHERE (json_extract(c.canonical,'$.command.documentId')=? AND json_extract(c.canonical,'$.command.body.type')!='SaveCopy') OR json_extract(e.json,'$.documentId')=? ORDER BY length(e.seq),e.seq").iterate(d.id,d.id)){
    const e=JSON.parse(String(r.json));event(e);out.prepare('INSERT INTO events VALUES (?,?,?)').run(e.workspaceSeq,e.transactionId,String(r.json));references(e,ref=>addRef(out,ref));if(e.type==='AssetRegistered')queue(e.payload.asset.id);if(e.type==='ImageEditPreviewPrepared'){addState(e.payload.preview.source);addState(e.payload.preview.after);queue(e.payload.preview.preparedAssetId);}
   }
   captureTransactions(out,this.db);
   for(const r of this.db.prepare("SELECT DISTINCT r.hash,o.byte_length,r.media_type FROM roots r JOIN objects o ON o.hash=r.hash JOIN commands c ON r.owner IN ('command:'||c.id,'receipt:'||c.id,'history-command:'||c.id) WHERE json_extract(c.canonical,'$.command.documentId')=?").iterate(d.id))addRef(out,{hash:String(r.hash),byteLength:String(r.byte_length),mediaType:String(r.media_type)});
   // Accepted draft fences give an explicit document ownership edge even after
   // ClearDraft or transcript compaction. UI-only obsolete generations do not.
   for(const row of this.db.prepare("SELECT canonical FROM commands WHERE json_extract(canonical,'$.command.documentId')=? AND json_extract(receipt,'$.status')='accepted' AND json_type(canonical,'$.command.body.draft')='object'").iterate(d.id)){
    const c=JSON.parse(String(row.canonical)).command,f=c.body.draft,owner='ui:'+c.clientId+':'+f.sessionId+':'+f.draftId+':'+f.generation;
    const refs=this.db.prepare('SELECT r.hash,o.byte_length,r.media_type FROM roots r JOIN objects o ON o.hash=r.hash WHERE r.owner=?').all(owner);
    if(refs.length<1)throw new StoreError('MISSING_OBJECT',{kind:'resource-state',resourceId:c.commandId,state:'required-history-draft-ownership-unavailable'});for(const r of refs)addRef(out,{hash:String(r.hash),byteLength:String(r.byte_length),mediaType:String(r.media_type)});
   }
   for(const r of this.db.prepare("SELECT r.id,r.json,r.namespace FROM portable_rows r JOIN portable_namespaces n ON n.id=r.namespace WHERE n.document_id=? AND r.kind='portable-provider' ORDER BY r.id").iterate(d.id)){
    const v=JSON.parse(String(r.json));addEntity('portable-provider',String(r.id),v);
    for(const hash of v.assetHashes){const rows=this.db.prepare("SELECT id FROM portable_rows WHERE namespace=? AND kind='asset' AND json_extract(json,'$.blob.hash')=?").all(r.namespace,hash);if(!rows.length)throw new StoreError('MISSING_OBJECT');for(const a of rows)queue(String(a.id));}
   }
   for(;;){const q=out.prepare('SELECT id FROM assets_queue WHERE done=0 ORDER BY id LIMIT 1').get();if(!q)break;const a=this.assets.asset(String(q.id));if(!a||a.availability!=='available')throw new StoreError('MISSING_OBJECT');addEntity('asset',a.id,a);
    if(a.raster){const m=this.rasters.manifest(a.id);references(m,r=>addRef(out,r));if((m.plan as any).kind==='retained-text'){const source=validateSource(json(this.objects.verify((m.plan as any).source,true)!));for(const ref of dependencies(source))addRef(out,ref);source.text.fonts.forEach(font);}for(const source of a.raster.sourceAssetIds)queue(source);}
    out.prepare('UPDATE assets_queue SET done=1 WHERE id=?').run(q.id);
   }

   for(const r of out.prepare('SELECT * FROM refs').iterate()){if(this.db.prepare('SELECT 1 FROM portable_quarantined_hashes WHERE hash=?').get(r.hash))throw new StoreError('CORRUPT_OBJECT',{kind:'resource-state',resourceId:String(r.hash).slice(7),state:'transport-provenance-quarantined'});const ref=refFrom(r);this.db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?)').run(ref.hash,ref.byteLength);if(this.db.prepare('SELECT byte_length FROM objects WHERE hash=?').get(ref.hash)!.byte_length!==ref.byteLength)throw new StoreError('CORRUPT_OBJECT');this.db.prepare('INSERT INTO portable_pins VALUES (?,?,?)').run(operationId,ref.hash,ref.mediaType);}
   out.exec('COMMIT');
   const input=openSync(join(dir,'capture.sqlite'),constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),block=Buffer.alloc(1048576);try{for(;;){const n=readSync(input,block);if(!n)break;hash.update(block.subarray(0,n));}}finally{closeSync(input);}
   const captureHash='sha256:'+hash.digest('hex');
   const highWater=String(this.db.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value);return {captureVersion:2,document:d,highWater,uiDigest:'sha256:'+uiHash.digest('hex'),capture:operationId,captureHash};
  }finally{if(out.isTransaction)out.exec('ROLLBACK');out.close();syncDirectory(dir);}
 }
 private auth(id:string){const a=this.authorities.get(id);if(!a)throw new AssetRejection('INVALID_INPUT','BUNDLE_REVIEW_EXPIRED');const auth={...a.auth,now:a.auth.now+Math.floor(performance.now()-a.start)},binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);if(!binding||binding.client_id!==auth.clientId||auth.now>=auth.expires||auth.now>=Number(binding.expires))throw new AssetRejection('INVALID_INPUT','BUNDLE_REVIEW_EXPIRED');return auth;}
 review(id:string,auth:AssetAuth):BundleReview{if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM portable_reviews WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');if(row.client_id!==auth.clientId)throw new StoreError('OWNER_REQUIRED');const r=JSON.parse(String(row.json));if(row.session_hash!==auth.sessionHash||row.epoch!==this.epoch||auth.now>=Date.parse(r.expiresAt))throw new StoreError('REVIEW_EXPIRED');return r;}
 bundle(id:string,auth:AssetAuth):Bundle{if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM portable_bundles WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');if(row.client_id!==auth.clientId)throw new StoreError('OWNER_REQUIRED');return JSON.parse(String(row.json));}
 schedule(){if(this.closing||this.running)return;setImmediate(()=>{if(this.closing||this.running||!this.rasters.documentAvailable)return;const r=this.db.prepare('SELECT id FROM portable_preparations ORDER BY id LIMIT 64').all().find(r=>!this.paused.has(String(r.id)));if(!r)return;const id=String(r.id),slot='portable:'+id;try{this.objects.acquire(slot);}catch{return;}this.running=this.prepare(id,slot).catch(()=>this.pause(id)).finally(()=>{this.running=undefined;this.objects.unreserve(slot);this.objects.unreserve(slot+':archive');this.objects.release(slot);this.schedule();});});}
 private pause(id:string,reason='STORAGE_FAILURE'){this.paused.add(id);this.failures.set(id,reason);try{this.db.prepare("UPDATE portable_preparations SET phase='waiting-for-resources',failure=? WHERE id=?").run(reason,id);}catch{}}
 private async prepare(id:string,slot:string){
  const start=performance.now(),pending=this.pending(id);if(!pending)return;const c=pending.command,row=this.db.prepare('SELECT original,frozen,confirmed_at FROM portable_preparations WHERE id=?').get(id)!,frozen=JSON.parse(String(row.frozen)),bytes=Buffer.from(String(row.original));
  const check=()=>{this.check();if(this.closing)throw new StoreError('CLOSED');if(this.db.prepare('SELECT 1 FROM portable_cancellations WHERE id=?').get(id))throw new AssetRejection('INVALID_INPUT','PORTABLE_CANCELLED');if(process.memoryUsage().rss>512*1024*1024)throw new StoreError('CAPACITY');this.objects.capacity(0n);};
  try{
   check();if(c.body.type==='SaveCopy')await this.exportCopy(bytes,c,pending.operationId,frozen,slot,check);
   else if(c.body.type==='PreviewBundleImport')await this.previewImport(bytes,c,pending.operationId,frozen,slot,check);
   else if(c.body.type==='ImportBundle')await this.acceptImport(bytes,c,pending.operationId,frozen,slot,check);
   this.observations.push({commandId:id,operation:c.body.type,confirmationToTerminalMs:Date.now()-Number(row.confirmed_at),preparationMs:performance.now()-start,rss:process.memoryUsage().rss,qualification:false});
  }catch(e){const native=(e as NodeJS.ErrnoException)?.code,code=e instanceof StoreError?e.code:native==='ENOENT'?'MISSING_OBJECT':native==='EROFS'?'READ_ONLY_STORAGE':native==='ENOSPC'||native==='EDQUOT'?safeError(e).code:(e as any)?.errcode===13?'STORAGE_FULL':'INVALID_ARCHIVE';const rejection=e instanceof AssetRejection?e:['MALFORMED_REQUEST','CORRUPT_OBJECT','MISSING_OBJECT','ROOT_UNSAFE','REVIEW_EXPIRED','INVALID_ARCHIVE'].includes(code)?new AssetRejection(code==='MISSING_OBJECT'?'MISSING_ASSET':'INVALID_INPUT',code==='REVIEW_EXPIRED'?'BUNDLE_REVIEW_EXPIRED':'PORTABLE_'+code):null;
   this.observations.push({commandId:id,operation:c.body.type,confirmationToTerminalMs:Date.now()-Number(row.confirmed_at),preparationMs:performance.now()-start,error:rejection?.reason??code});if(rejection)this.commit(bytes,()=>{throw rejection;},slot);else this.pause(id,code);
  }finally{if(this.db.prepare('SELECT 1 FROM commands WHERE id=?').get(id)){this.db.prepare('DELETE FROM portable_pins WHERE operation_id=?').run(pending.operationId);this.authorities.delete(id);this.failures.delete(id);}if(this.observations.length>64)this.observations.shift();}
 }
 private async exportCopy(bytes:Uint8Array,c:Command,operationId:string,frozen:any,slot:string,check:()=>void){
  const sourceDir=join(this.directory,frozen.capture),attempt=join(sourceDir,randomUUID());privateDirectory(attempt);
  const capturedPath=join(sourceDir,'capture.sqlite'),capturedStamp=stamp(capturedPath),outerCheck=check;check=()=>{outerCheck();if(stamp(capturedPath)!==capturedStamp)throw new StoreError('CORRUPT_OBJECT');};const capturedSource=await fileSource('capture',capturedPath,check);if('sha256:'+capturedSource.sha256!==frozen.captureHash)throw new StoreError('CORRUPT_OBJECT');
  const db=spool(join(attempt,'export.sqlite')),capture=new DatabaseSync(join(sourceDir,'capture.sqlite'),{readOnly:true});
  try{db.exec('BEGIN IMMEDIATE');defineIndex(db);for(const table of ['entities','events','refs'])for(const r of capture.prepare(`SELECT * FROM ${table}`).iterate()){const fields=Object.keys(r);db.prepare(`INSERT INTO ${table} VALUES (${fields.map(()=>'?').join(',')})`).run(...Object.values(r));await tick();}
   if(frozen.captureVersion===2){for(const r of capture.prepare('SELECT json FROM transactions').iterate())addTransaction(db,JSON.parse(String(r.json)));}
   else if(frozen.captureVersion===undefined)captureTransactions(db,this.db);
   else throw new StoreError('TRANSACTION_EVIDENCE_UNAVAILABLE');
   await validateTransactions(db,frozen.highWater,check);
   await this.verifyAncestorTransactions(db,null,attempt,slot,check,true);
   let total=0n;for(const r of db.prepare('SELECT bytes FROM refs').iterate())total+=BigInt(String(r.bytes));const metadataBytes=BigInt(assertPrivate(join(sourceDir,'capture.sqlite'),false).size);this.objects.reserve(slot,total+metadataBytes*8n+1048576n);
   await encodeRecords(db,attempt,frozen.document.id,frozen.highWater,check);const document=await validateClosure(db,async ref=>{if(BigInt(ref.byteLength)>8388608n)throw new StoreError('PAYLOAD_TOO_LARGE');this.texts.guardMetadata(Number(ref.byteLength));this.objects.verify(ref);const b=Buffer.alloc(Number(ref.byteLength));for(let at=0;at<b.length;at+=1048576)b.set(this.objects.readRange(ref,String(at),Math.min(1048576,b.length-at)),at);return b;},check);if(canonical(document)!==canonical(frozen.document))throw new StoreError('CORRUPT_OBJECT');
   const objectSource=async(r:any)=>{const ref=refFrom(r),payload=db.prepare('SELECT json FROM payloads WHERE hash=?').get(ref.hash);let path:string;
    if(payload){path=join(attempt,ref.hash.slice(7));const fd=privateFile(path);try{write(fd,Buffer.from(String(payload.json)));fsyncSync(fd);}finally{closeSync(fd);}}
    else path=this.objects.path(ref);
    let s;try{s=await fileSource('objects/'+ref.hash.slice(7),path,check);}catch(e){if((e as NodeJS.ErrnoException)?.code==='ENOENT')throw new AssetRejection('MISSING_ASSET','PORTABLE_REQUIRED_OBJECT_MISSING',null,'objects/'+ref.hash.slice(7));throw e;}if(s.bytes!==BigInt(ref.byteLength)||s.sha256!==ref.hash.slice(7))throw new StoreError('CORRUPT_OBJECT');return s;
   };
   await writeZip(join(attempt,'archive.partial'),db,(async function*(){yield await fileSource('manifest.json',join(attempt,'manifest.json'),check);for(const r of db.prepare('SELECT path FROM segments ORDER BY path').iterate())yield await fileSource(String(r.path),join(attempt,String(r.path).replace('/','-')),check);for(const r of db.prepare('SELECT * FROM refs ORDER BY hash').iterate())yield await objectSource(r);})(),check,()=>this.barrier('portable-archive-before-write'));
   const archive=await fileSource('archive',join(attempt,'archive.partial'),check),ref={hash:'sha256:'+archive.sha256,byteLength:String(archive.bytes),mediaType:'application/x-ideogram-project'};
   const proof=await this.objects.adoptFile(join(attempt,'archive.partial'),ref,check);try{
    this.barrier('portable-export-before-commit');check();this.commit(bytes,()=>{check();this.objects.proven(ref,proof);const bundle:Bundle={protocolVersion:1,bundleId:operationId,documentId:frozen.document.id,documentRevision:frozen.document.revision,capturedHighWater:frozen.highWater,uiDigest:frozen.uiDigest,blob:ref,complete:true,status:'copy-ready',destinationStatus:'unconfirmed'};
     this.register('bundle:'+operationId,ref,proof);this.db.prepare('INSERT INTO portable_bundles VALUES (?,?,?,?)').run(operationId,c.clientId,frozen.document.id,canonical(bundle));return {fact:{type:'BundlePrepared',payload:{bundle}},documentRevision:frozen.document.revision};},slot);
   }finally{this.objects.releaseProof(proof);}
  }finally{if(db.isTransaction)db.exec('COMMIT');capture.close();db.close();}
 }
 private async verifyAncestorTransactions(db:DatabaseSync,zip:ZipIndex|null,directory:string,slot:string,check:()=>void,allowOriginalJournal:boolean){
  // Original imported archives are immutable history dependencies. A new local
  // BundleImported receipt cannot establish the bounds of their old events.
  // Work and evidence stay on disk; archive depth/count are not memory caps.
  db.exec('CREATE TABLE ancestor_queue(hash TEXT PRIMARY KEY,bytes TEXT NOT NULL,media TEXT NOT NULL,path TEXT NOT NULL,directory TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0) STRICT');
  let reserved=0n;
  const enqueue=async(index:DatabaseSync,container:ZipIndex|null)=>{
   for(const row of index.prepare("SELECT json FROM events WHERE json_extract(json,'$.type')='BundleImported' ORDER BY length(seq),seq").iterate()){
    const ref:BlobRef=JSON.parse(String(row.json)).payload.source,known=db.prepare('SELECT * FROM ancestor_queue WHERE hash=?').get(ref.hash);
    if(known){if(known.bytes!==ref.byteLength||known.media!==ref.mediaType)invalid();continue;}
    const retained=index.prepare('SELECT * FROM refs WHERE hash=?').get(ref.hash);if(!retained||retained.bytes!==ref.byteLength)invalid();
    reserved+=BigInt(ref.byteLength)*3n+1048576n;this.objects.reserve(slot+':ancestry',reserved);
    const dir=join(directory,'ancestor-'+ref.hash.slice(7));privateDirectory(dir);let path:string;
    if(container){path=join(dir,'source.zip');const entry=container.entry('objects/'+ref.hash.slice(7));if(entry.bytes!==BigInt(ref.byteLength)||entry.sha256!==ref.hash.slice(7))invalid();const fd=privateFile(path);try{for await(const b of container.chunks(entry,check))write(fd,b);fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(dir);}
    else path=this.objects.path(ref);
    db.prepare('INSERT INTO ancestor_queue(hash,bytes,media,path,directory) VALUES (?,?,?,?,?)').run(ref.hash,ref.byteLength,ref.mediaType,path,dir);check();await tick();
   }
  };
  const merge=(record:any)=>{const old=db.prepare('SELECT json FROM transactions WHERE archive=? AND id=?').get(record.sourceArchive,record.receipt.transactionId);if(old){if(old.json!==canonical(record))invalid();}else addTransaction(db,record);};
  try{
   await enqueue(db,zip);
   for(;;){const queued=db.prepare('SELECT * FROM ancestor_queue WHERE done=0 ORDER BY hash LIMIT 1').get();if(!queued)break;
    const loaded:LoadedArchive=await this.loadArchive(refFrom(queued),String(queued.path),String(queued.directory),slot,check,false,false);
    try{
     if(loaded.manifest.unsupported==='LEGACY_TRANSACTION_BOUNDS_UNAVAILABLE'&&loaded.manifest.complete){
      let supplied=false;for(const row of db.prepare('SELECT json FROM transactions WHERE archive=? ORDER BY length(first_seq),first_seq').iterate(queued.hash)){const record=JSON.parse(String(row.json));addTransaction(loaded.db,{...record,sourceArchive:null});supplied=true;}
      if(!supplied){if(!allowOriginalJournal)throw new StoreError('TRANSACTION_EVIDENCE_UNAVAILABLE');captureTransactions(loaded.db,this.db);}
      await validateTransactions(loaded.db,loaded.manifest.capturedHighWater,check);
      const document=await validateClosure(loaded.db,loaded.read,check,loaded.manifest.formatVersion>=4,loaded.manifest.formatVersion>=5,loaded.manifest.formatVersion>=6,loaded.manifest.formatVersion>=7);if(document.id!==loaded.manifest.sourceNamespace)invalid();
     }else if(loaded.manifest.unsupported||!loaded.manifest.complete)throw new StoreError('TRANSACTION_EVIDENCE_UNAVAILABLE');
     for(const row of loaded.db.prepare('SELECT json FROM transactions ORDER BY archive,length(first_seq),first_seq').iterate()){const record=JSON.parse(String(row.json));merge({...record,sourceArchive:record.sourceArchive??String(queued.hash)});}
     // Every supplied bound must describe the exact retained ancestor, including
     // its entire declared event stream. Extra claims cannot be smuggled through.
     for(const row of db.prepare('SELECT json FROM transactions WHERE archive=?').iterate(queued.hash)){const record=JSON.parse(String(row.json)),original=loaded.db.prepare("SELECT json FROM transactions WHERE archive='' AND id=?").get(record.receipt.transactionId);if(!original||canonical({...record,sourceArchive:null})!==original.json)invalid();}
     await enqueue(loaded.db,loaded.zip);db.prepare('UPDATE ancestor_queue SET done=1 WHERE hash=?').run(queued.hash);
    }finally{if(loaded.db.isTransaction)loaded.db.exec('ROLLBACK');loaded.zip.close();loaded.db.close();}
   }
   if(db.prepare("SELECT 1 FROM transactions WHERE archive!='' AND archive NOT IN (SELECT hash FROM ancestor_queue WHERE done=1) LIMIT 1").get())invalid();
  }finally{this.objects.unreserve(slot+':ancestry');}
 }
 private async loadArchive(source:BlobRef,path:string,directory:string,slot:string,check:()=>void,ancestors=true,reserve=true):Promise<LoadedArchive>{
  if(reserve)this.objects.reserve(slot+':archive',BigInt(source.byteLength)*2n+1048576n);const data=await fileSource('source',path,check);if(data.bytes!==BigInt(source.byteLength)||data.sha256!==source.hash.slice(7))throw new StoreError('CORRUPT_OBJECT');
  const db=spool(join(directory,'index.sqlite')),zip=new ZipIndex(path,db);
  try{db.exec('BEGIN IMMEDIATE');await zip.headers(check);this.barrier('portable-headers-validated');await zip.hashes(check);this.barrier('portable-bytes-validated');const manifest=await decodeRecords(zip,db,check);
   const read=async(ref:BlobRef)=>{if(BigInt(ref.byteLength)>8388608n)throw new StoreError('PAYLOAD_TOO_LARGE');this.texts.guardMetadata(Number(ref.byteLength));const e=zip.entry('objects/'+ref.hash.slice(7));if(e.bytes!==BigInt(ref.byteLength)||e.sha256!==ref.hash.slice(7))invalid();const parts:Buffer[]=[];for await(const b of zip.chunks(e,check))parts.push(Buffer.from(b));return Buffer.concat(parts);};
   if(!manifest.unsupported){if(!manifest.complete)manifest.unsupported='INCOMPLETE_RECOVERY_COPY';else {try{const document=await validateClosure(db,read,check,manifest.formatVersion>=4,manifest.formatVersion>=5,manifest.formatVersion>=6,manifest.formatVersion>=7);if(document.id!==manifest.sourceNamespace)invalid();}catch(e){if(!(e instanceof UnsupportedText))throw e;manifest.unsupported=e.message;}}}
   for(const row of db.prepare("SELECT json FROM entities WHERE kind='asset'").iterate()){const a=JSON.parse(String(row.json));if(a.raster&&a.raster.pipeline!==PIXEL_PIPELINE+'/'+CODEC_ID)manifest.unsupported='UNSUPPORTED_RESOURCE_PROFILE';}
   for(const r of db.prepare('SELECT hash FROM refs').iterate())if(this.db.prepare('SELECT 1 FROM portable_quarantined_hashes WHERE hash=?').get(r.hash))manifest.unsupported='TRANSPORT_PROVENANCE_QUARANTINED';
   if(ancestors&&!manifest.unsupported){try{await this.verifyAncestorTransactions(db,zip,directory,slot,check,false);}catch(e){if(e instanceof StoreError&&e.code==='TRANSACTION_EVIDENCE_UNAVAILABLE')manifest.unsupported='ORIGINAL_TRANSACTION_BOUNDS_UNAVAILABLE_SOURCE_ARCHIVE_RETAINED';else throw e;}}
   this.barrier('portable-closure-validated');return {db,zip,manifest,read};
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');zip.close();db.close();throw e;}
 }
 private async extract(db:DatabaseSync,zip:ZipIndex,directory:string,check:()=>void){
  for(const row of db.prepare('SELECT * FROM refs ORDER BY hash').iterate()){const ref=refFrom(row),path=join(directory,ref.hash.slice(7)),fd=privateFile(path);try{for await(const b of zip.chunks(zip.entry('objects/'+ref.hash.slice(7)),check))write(fd,b);fsyncSync(fd);}finally{closeSync(fd);}db.prepare('UPDATE refs SET stamp=? WHERE hash=?').run(stamp(path),ref.hash);}
  syncDirectory(directory);
 }
 private async typed(db:DatabaseSync,directory:string,slot:string,check:()=>void){
  db.exec('CREATE TABLE decoded_pixels(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');
  const text=async(ref:BlobRef)=>{const decoder=new TextDecoder('utf-8',{fatal:true}),stream=await fileSource('text',join(directory,ref.hash.slice(7)),check);for await(const b of stream.chunks())decoder.decode(b,{stream:true});decoder.decode();};
  for(const row of db.prepare("SELECT json FROM entities WHERE kind='portable-provider'").iterate()){const v=JSON.parse(String(row.json));for(const key of ['requestedPromptRef','submittedPromptRef','returnedPromptRef'])if(v[key])await text(v[key]);}

  for(const row of db.prepare("SELECT json FROM entities WHERE kind='asset' ORDER BY id").iterate()){
   const a=JSON.parse(String(row.json)),path=join(directory,a.blob.hash.slice(7));check();
   if(a.qualification==='font'){bundledFont(a.font);const inspected=await this.texts.inspect(a.blob,path);if(inspected.format!==a.font.format||inspected.parserProfile!==a.font.parserProfile||inspected.fsType!==a.font.fsType)invalid();await text(a.font.licenseRecord);}
   else if(a.qualification==='opaque-text')await text(a.blob);
   else{const work=join(directory,'verify-'+randomUUID());privateDirectory(work);const result=await this.rasters.validatePortable(path,a.measuredMediaType,a.blob,work,slot,check);
    db.prepare('INSERT INTO decoded_pixels VALUES (?,?)').run(a.id,canonical(result.info));if(a.raster&&(result.info.pixels.hash!==a.raster.pixels.hash||result.info.width!==a.raster.width||result.info.height!==a.raster.height))invalid();
   }
   if(a.raster){const m=json(Buffer.from(await this.readSmall(join(directory,a.raster.manifest.hash.slice(7)))));rasterManifest(m);const fd=openSync(join(directory,m.pixels.hash.slice(7)),constants.O_RDONLY|constants.O_NOFOLLOW);try{for(const t of m.tiles){const h=createHash('sha256'),b=Buffer.alloc(t.width*4);for(let y=0;y<t.height;y++){if(readSync(fd,b,0,b.length,((t.y+y)*m.width+t.x)*4)!==b.length)invalid();h.update(b);}if('sha256:'+h.digest('hex')!==t.hash)invalid();check();await tick();}}finally{closeSync(fd);}}
  }
  for(const row of db.prepare("SELECT json FROM entities WHERE kind='asset' AND json_extract(json,'$.raster.role')='mask'").iterate()){
   const a=JSON.parse(String(row.json)),m=json(Buffer.from(await this.readSmall(join(directory,a.raster.manifest.hash.slice(7)))));
   if(!['authored-mask-v1','authored-mask-v2'].includes(m.plan.kind))invalid();
   const ids=maskImports(m.plan.authoring);if(canonical(ids)!==canonical(a.raster.sourceAssetIds))invalid();
   const inputs=await Promise.all(ids.map(async id=>{const source=JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(id)?.json??'null'));if(!source?.raster||source.qualification!=='canonical-raster')invalid();
    if(m.plan.authoring.operations.some((op:any)=>op.kind==='import'&&op.assetId===id)&&JSON.parse(String(db.prepare("SELECT json FROM entities WHERE kind='asset' AND id=?").get(source.raster.sourceAssetIds[0])?.json??'null'))?.measuredMediaType!=='image/png')invalid();
    const manifest=json(Buffer.from(await this.readSmall(join(directory,source.raster.manifest.hash.slice(7)))));maskSource(m.plan.authoring,id,source.raster,manifest.plan.hard);
    return {id,info:source.raster,path:join(directory,source.raster.pixels.hash.slice(7)),...(source.raster.role==='mask'?{hardPath:join(directory,manifest.plan.hard.hash.slice(7))}:{})};}));
   const work=join(directory,'mask-verify-'+randomUUID());privateDirectory(work);const computed=await this.rasters.validateMaskPortable(m.plan.authoring,inputs,work,slot,check),p=computed.manifest.plan as any;
   if(canonical(p.hard)!==canonical(m.plan.hard)||canonical(p.effective)!==canonical(m.plan.effective)||canonical(p.statistics)!==canonical(m.plan.statistics)||computed.info.pixels.hash!==a.raster.pixels.hash)invalid();
  }
  for(const row of db.prepare('SELECT json FROM text_sources ORDER BY hash').iterate()){await this.texts.verify(JSON.parse(String(row.json)),ref=>join(directory,ref.hash.slice(7)),check);}
  for(const row of db.prepare("SELECT json FROM entities WHERE kind='asset'").iterate()){const a=JSON.parse(String(row.json));if(a.raster?.role==='native'){
   const source=db.prepare('SELECT json FROM decoded_pixels WHERE id=?').get(a.raster.sourceAssetIds[0]);if(!source)invalid();const info=JSON.parse(String(source!.json));if(info.pixels.hash!==a.raster.pixels.hash||canonical(info.conversion)!==canonical(a.raster.conversion))invalid();
  }}
 }
 private async readSmall(path:string){const s=await fileSource('metadata',path,()=>this.check());if(s.bytes>65536n)invalid();const parts:Buffer[]=[];for await(const b of s.chunks())parts.push(Buffer.from(b));return Buffer.concat(parts);}
 private async previewImport(bytes:Uint8Array,c:Command,operationId:string,frozen:any,slot:string,check:()=>void){
  const auth=this.auth(c.commandId),source=this.assets.bundleSource(frozen.stagingId,auth);if(source.record.version!==frozen.version)throw new AssetRejection('STALE_REVISION','STAGING_CHANGED');
  const dir=join(this.directory,operationId);privateDirectory(dir);const attempt=join(dir,randomUUID());privateDirectory(attempt);const loaded=await this.loadArchive(frozen.source,source.path,attempt,slot,check);
  try{const {db,zip,manifest}=loaded;if(!manifest.unsupported){await this.extract(db,zip,attempt,check);await this.typed(db,attempt,slot,check);}check();zip.check();const current=this.auth(c.commandId),stage=this.assets.bundleSource(frozen.stagingId,current);if(stage.record.version!==frozen.version)throw new AssetRejection('STALE_REVISION','STAGING_CHANGED');
   const namespaceId=randomUUID(),documentId=this.localId(namespaceId,'document',manifest.sourceNamespace);const uiSessionIds=db.prepare("SELECT id FROM entities WHERE kind='draft' ORDER BY id LIMIT 64").all().map(r=>this.localId(namespaceId,'ui',String(r.id)));
   const value:Omit<BundleReview,'reviewHash'>={protocolVersion:1,reviewId:operationId,targetClientId:c.clientId,expiresAt:new Date(Math.min(current.expires,current.now+1800000)).toISOString(),source:frozen.source,sourceNamespace:manifest.sourceNamespace,capturedHighWater:manifest.capturedHighWater,namespaceId,documentId,closureHash:hashBytes(canonical({source:frozen.source,manifest})),formatVersion:manifest.formatVersion,documentSchema:manifest.documentSchema,editable:!manifest.unsupported,reason:manifest.unsupported??null,objectCount:String(db.prepare('SELECT count(*) n FROM refs').get()!.n),entityCount:String(db.prepare('SELECT count(*) n FROM entities').get()!.n),eventCount:String(db.prepare('SELECT count(*) n FROM events').get()!.n),uiSessionIds,uiSessionCount:String(db.prepare("SELECT count(*) n FROM entities WHERE kind='draft'").get()!.n),scope:'selected-document-current-drafts-and-retained-domain-history',localRetentionExcluded:'obsolete-unattributed-ui-only'};
   const review={...value,reviewHash:hashBytes(canonical(value))};await this.reviewMappings(db,namespaceId,loaded.read,check);this.commit(bytes,()=>{this.auth(c.commandId);zip.check();const s=this.assets.bundleSource(frozen.stagingId,current);if(s.record.version!==frozen.version)throw new AssetRejection('STALE_REVISION','STAGING_CHANGED');this.db.prepare('INSERT INTO portable_reviews VALUES (?,?,?,?,?)').run(operationId,c.clientId,current.sessionHash,this.epoch,canonical(review));for(const row of db.prepare('SELECT * FROM review_mapping').iterate())this.db.prepare('INSERT INTO portable_review_maps VALUES (?,?,?,?)').run(operationId,row.kind,row.source_id,row.local_id);this.db.prepare('INSERT INTO portable_review_sources VALUES (?,?,?,?)').run(operationId,frozen.stagingId,frozen.version,stamp(source.path));return {fact:{type:'BundleImportReviewed',payload:{reviewId:operationId,reviewHash:review.reviewHash}},documentRevision:null};},slot);
  }finally{if(loaded.db.isTransaction)loaded.db.exec('COMMIT');loaded.zip.close();loaded.db.close();}
 }
 private async reviewMappings(db:DatabaseSync,namespace:string,read:(ref:BlobRef)=>Promise<Uint8Array>,check:()=>void){
  db.exec('CREATE TABLE review_mapping(kind TEXT NOT NULL,source_id TEXT NOT NULL,local_id TEXT NOT NULL,PRIMARY KEY(kind,source_id)) STRICT');
  const add=(kind:string,id:string|null)=>{if(id!==null)db.prepare('INSERT OR IGNORE INTO review_mapping VALUES (?,?,?)').run(kind,id,this.localId(namespace,kind,id));};
  for(const r of db.prepare('SELECT * FROM entities ORDER BY kind,id').iterate()){
   const v=JSON.parse(String(r.json));add(r.kind==='draft'?'ui':r.kind==='portable-provider'?'attempt':String(r.kind),String(r.id));
   if(v.branchId)add('branch',v.branchId);for(const id of v.orderedLayerIds??[])add('layer',id);
   for(const version of [v.image,v.before,v.after])if(version?.state){const state=json(await read(version.state));for(const l of state.layers)add('layer',l.id);}check();await tick();
   if(r.kind==='draft'){for(const d of v.drafts){add('draft',d.id);add('layer',d.targetLayerId);}for(const id of v.preferences?.selectedLayerIds??[])add('layer',id);for(const id of v.reconciledLayerIds)add('layer',id);}
  }
 }
 mapping(id:string,auth:AssetAuth,kind:string,after:string){
  this.review(id,auth);if(!['document','history','checkpoint','asset','ui','attempt','branch','draft','layer'].includes(kind)||after!==''&&!isId(after))throw new StoreError('MALFORMED_REQUEST');
  const items=this.db.prepare('SELECT source_id sourceId,local_id localId FROM portable_review_maps WHERE review_id=? AND kind=? AND source_id>? ORDER BY source_id LIMIT 100').all(id,kind,after);
  return {protocolVersion:1,kind,items,next:items.length===100?String(items.at(-1)!.sourceId):null};
 }
 private localId(namespace:string,kind:string,id:string){return 'p_'+hashBytes(canonical([namespace,kind,id])).slice(7);}
 private async acceptImport(bytes:Uint8Array,c:Command,operationId:string,review:BundleReview,slot:string,check:()=>void){
  const auth=this.auth(c.commandId),live=this.review(review.reviewId,auth);if(canonical(live)!==canonical(review)||!review.editable)throw new AssetRejection('INCOMPATIBLE','BUNDLE_NOT_EDITABLE');
  if(this.db.prepare('SELECT 1 FROM portable_namespaces WHERE id=? OR document_id=?').get(review.namespaceId,review.documentId)||this.document(review.documentId))throw new AssetRejection('INVALID_INPUT','NAMESPACE_EXISTS');
  const source=this.db.prepare('SELECT * FROM portable_review_sources WHERE id=?').get(review.reviewId)!;const stage=this.assets.bundleSource(String(source.staging_id),auth);if(stage.record.version!==source.version||stamp(stage.path)!==source.stamp)throw new AssetRejection('STALE_REVISION','BUNDLE_SOURCE_CHANGED');
  const dir=join(this.directory,operationId);privateDirectory(dir);const attempt=join(dir,randomUUID());privateDirectory(attempt);const loaded=await this.loadArchive(review.source,stage.path,attempt,slot,check);
  try{if(loaded.manifest.unsupported||hashBytes(canonical({source:review.source,manifest:loaded.manifest}))!==review.closureHash)throw new AssetRejection('INCOMPATIBLE','BUNDLE_VALIDATION_CHANGED');await this.extract(loaded.db,loaded.zip,attempt,check);await this.typed(loaded.db,attempt,slot,check);
   const sourcePath=join(attempt,review.source.hash.slice(7)),sourceFD=privateFile(sourcePath);try{const stream=await fileSource('source',stage.path,check);for await(const b of stream.chunks()){write(sourceFD,b);check();await tick();}fsyncSync(sourceFD);}finally{closeSync(sourceFD);}addRef(loaded.db,review.source);
   await this.mapImport(loaded.db,attempt,review.namespaceId,check);this.barrier('portable-import-after-proofs');await tick();check();
   // Adopt one object at a time. Proofs live in the disk-backed index and are
   // rechecked at the atomic acceptance; no 512-object/whole-project map.
   for(const r of loaded.db.prepare('SELECT * FROM refs ORDER BY hash').iterate()){const ref=refFrom(r),path=join(attempt,ref.hash.slice(7)),proof=await this.objects.adoptFile(path,ref,check);try{this.objects.proven(ref,proof);loaded.db.prepare('UPDATE refs SET stamp=? WHERE hash=?').run(stamp(this.objects.path(ref)),ref.hash);}finally{this.objects.releaseProof(proof);}}
   const d=JSON.parse(String(loaded.db.prepare("SELECT json FROM mapped WHERE kind='document'").get()!.json));
   this.commit(bytes,()=>{const a=this.auth(c.commandId);if(canonical(this.review(review.reviewId,a))!==canonical(review))throw new AssetRejection('STALE_REVISION','BUNDLE_REVIEW_CHANGED');loaded.zip.check();check();const currentStage=this.assets.bundleSource(String(source.staging_id),a);if(currentStage.record.version!==source.version||stamp(currentStage.path)!==source.stamp)throw new AssetRejection('STALE_REVISION','BUNDLE_SOURCE_CHANGED');if(this.document(review.documentId)||this.db.prepare('SELECT 1 FROM portable_namespaces WHERE id=?').get(review.namespaceId))throw new AssetRejection('INVALID_INPUT','NAMESPACE_EXISTS');
    for(const r of loaded.db.prepare('SELECT * FROM refs').iterate()){if(this.db.prepare('SELECT 1 FROM portable_quarantined_hashes WHERE hash=?').get(r.hash))throw new AssetRejection('INCOMPATIBLE','TRANSPORT_PROVENANCE_QUARANTINED');if(stamp(this.objects.path(refFrom(r)))!==r.stamp)throw new AssetRejection('MISSING_ASSET','BUNDLE_DEPENDENCY_CHANGED');}
    this.db.prepare('INSERT INTO portable_namespaces VALUES (?,?,?)').run(review.namespaceId,d.id,canonical({source:review.source,sourceNamespace:review.sourceNamespace,capturedHighWater:review.capturedHighWater}));
    for(const r of loaded.db.prepare('SELECT * FROM refs').iterate()){const ref=refFrom(r);this.db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?)').run(ref.hash,ref.byteLength);this.db.prepare('INSERT INTO roots VALUES (?,?,?)').run('namespace:'+review.namespaceId,ref.hash,ref.mediaType);}
    for(const r of loaded.db.prepare('SELECT * FROM mapped ORDER BY kind,id').iterate())this.db.prepare('INSERT INTO portable_rows VALUES (?,?,?,?)').run(review.namespaceId,r.kind,r.id,r.json);
    for(const r of loaded.db.prepare('SELECT * FROM mapping').iterate())this.db.prepare('INSERT INTO portable_maps VALUES (?,?,?,?)').run(review.namespaceId,r.kind,r.source_id,r.local_id);
    for(const r of loaded.db.prepare("SELECT json FROM mapped WHERE kind='draft'").iterate()){
     const ui=JSON.parse(String(r.json));validateUI(ui,d.id);
     for(const draft of ui.drafts){
      const row=loaded.db.prepare("SELECT json FROM mapped WHERE kind='asset' AND id=?").get(draft.assetId);if(!row)invalid();const asset=JSON.parse(String(row!.json));
      if(asset.qualification!=='opaque-text'||asset.safety!=='safe'||asset.availability!=='available'||draft.documentId!==d.id)invalid();
      // The reviewed archive and frozen mapping establish this ownership. Keep
      // it after apply/clear, just as for a locally saved draft generation.
      const ref=asset.blob,owned=loaded.db.prepare('SELECT bytes,stamp FROM refs WHERE hash=?').get(ref.hash);if(!owned||owned.bytes!==ref.byteLength||owned.stamp!==stamp(this.objects.path(ref)))invalid();
      this.db.prepare('INSERT INTO roots VALUES (?,?,?)').run('ui:'+c.clientId+':'+ui.sessionId+':'+draft.id+':'+draft.generation,ref.hash,ref.mediaType);
     }
     if(ui.preferences===null)ui.preferences={documentId:null,tool:'select',viewport:{x:0,y:0,zoom:1},panels:{left:280,right:280,active:'layers'},selectedLayerIds:[]};this.db.prepare('INSERT INTO ui_checkpoints VALUES (?,?,?)').run(c.clientId,ui.sessionId,canonical(ui));
    }
    this.barrier('portable-import-before-commit');return {fact:{type:'BundleImported',payload:{namespaceId:review.namespaceId,source:review.source,document:d,namespaceHash:namespaceDigest(this.db,review.namespaceId)}},documentRevision:d.revision};
   },slot);
  }finally{if(loaded.db.isTransaction)loaded.db.exec('COMMIT');loaded.zip.close();loaded.db.close();}
 }
 private async mapImport(db:DatabaseSync,directory:string,namespace:string,check:()=>void){
  db.exec('CREATE TABLE mapped(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id)) STRICT; CREATE TABLE mapping(kind TEXT NOT NULL,source_id TEXT NOT NULL,local_id TEXT NOT NULL,PRIMARY KEY(kind,source_id)) STRICT; CREATE TABLE refmap(hash TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;');
  const map=(kind:string,id:string|null)=>{if(id===null)return null;const local=this.localId(namespace,kind,id);db.prepare('INSERT OR IGNORE INTO mapping VALUES (?,?,?)').run(kind,id,local);return local;};
  const metadata=(v:any)=>{const text=canonical(v);if(Buffer.byteLength(text)>65536)invalid();const ref={hash:hashBytes(text),byteLength:String(Buffer.byteLength(text)),mediaType:'application/json'};const path=join(directory,ref.hash.slice(7)),fd=privateFile(path);try{write(fd,Buffer.from(text));fsyncSync(fd);}finally{closeSync(fd);}addRef(db,ref);return ref;};
  const read=(ref:BlobRef)=>this.readSmall(join(directory,ref.hash.slice(7))).then(json);
  const layer=(l:any)=>({...l,id:map('layer',l.id),assetId:map('asset',l.assetId),mask:l.mask?{...l.mask,assetId:map('asset',l.mask.assetId)}:null});
  const semantic=(c:any)=>c?{...c,bindings:Object.fromEntries(Object.entries(c.bindings).map(([key,id])=>[key,map('layer',id as string)]))}:null;
  const version=async(v:any)=>{const s=await read(v.state);imageState(s);s.layers=s.layers.map(layer);if(s.schemaVersion===5)s.composition=semantic(s.composition);return {...v,state:metadata(s),semanticDigest:semanticDigest(s),compositeAssetId:map('asset',v.compositeAssetId)};};
  const document=async(d:any)=>({...d,id:map('document',d.id),branchId:map('branch',d.branchId),orderedLayerIds:d.orderedLayerIds.map((id:string)=>map('layer',id)),historyHead:map('history',d.historyHead),checkpoint:map('checkpoint',d.checkpoint),...(d.image?{image:await version(d.image),redo:map('history',d.redo)}:{})});
  // Topological asset translation rewrites only sealed typed metadata; original
  // bytes, pixels, prompts and prior manifests stay separately rooted verbatim.
  for(;;){let progress=0,remaining=0;for(const row of db.prepare("SELECT id,json FROM entities WHERE kind='asset' ORDER BY id").iterate()){
   if(db.prepare("SELECT 1 FROM mapped WHERE kind='asset' AND id=?").get(map('asset',String(row.id))!))continue;remaining++;const a=JSON.parse(String(row.json));if(a.raster&&a.raster.sourceAssetIds.some((id:string)=>!db.prepare("SELECT 1 FROM mapped WHERE kind='asset' AND id=?").get(map('asset',id)!)))continue;
   if(a.raster){const m=await read(a.raster.manifest);m.dependencies=m.dependencies.map((r:BlobRef)=>{const mapped=db.prepare('SELECT json FROM refmap WHERE hash=?').get(r.hash);return mapped?JSON.parse(String(mapped.json)):r;});if(['authored-mask-v1','authored-mask-v2'].includes(m.plan.kind))m.plan.authoring=resolveMaskPlan(m.plan.authoring,Object.fromEntries(maskImports(m.plan.authoring).map(id=>[id,map('asset',id)!])));if(m.plan.sourceAssetId)m.plan.sourceAssetId=map('asset',m.plan.sourceAssetId);if(m.plan.layers)m.plan.layers=m.plan.layers.map((l:any)=>({...l,assetId:map('asset',l.assetId),mask:l.mask?{...l.mask,assetId:map('asset',l.mask.assetId)}:null}));const ref=metadata(m);db.prepare('INSERT OR IGNORE INTO refmap VALUES (?,?)').run(a.raster.manifest.hash,canonical(ref));a.dependencies=a.dependencies.map((r:BlobRef)=>r.hash===a.raster.manifest.hash?ref:r);a.raster={...a.raster,manifest:ref,sourceAssetIds:a.raster.sourceAssetIds.map((id:string)=>map('asset',id))};}
   a.id=map('asset',a.id);db.prepare('INSERT INTO mapped VALUES (?,?,?)').run('asset',a.id,canonical(a));progress++;check();await tick();
  }if(!remaining)break;if(!progress)invalid();}
  for(const row of db.prepare("SELECT * FROM entities WHERE kind!='asset' ORDER BY kind,id").iterate()){
   const v=JSON.parse(String(row.json));let out:any;
   if(row.kind==='document')out=await document(v);
   else if(row.kind==='history'){
    out={...v,id:map('history',v.id),documentId:map('document',v.documentId),branchId:map('branch',v.branchId),parent:map('history',v.parent)};
    if(v.kind==='image-edit'){out.before=await version(v.before);out.after=await version(v.after);for(const key of ['forward','inverse']){const p=await read(v[key]);if(p.schemaVersion===2)p.composition=semantic(p.composition);p.layers=p.layers.map((x:any)=>({id:map('layer',x.id),value:x.value?layer(x.value):null}));if(p.order)p.order=p.order.map((id:string)=>map('layer',id));out[key]=metadata(p);}out.roots=[out.before.state,out.after.state,out.forward,out.inverse];}
    else{out.forward={before:null,after:await document(v.forward.after)};out.inverse={before:out.forward.after,after:null};}
   }else if(row.kind==='checkpoint')out={...v,id:map('checkpoint',v.id),documentId:map('document',v.documentId),historyHead:map('history',v.historyHead),...(v.image?{image:await version(v.image)}:{})};
   else if(row.kind==='portable-provider')out={...v,attemptId:map('attempt',v.attemptId)};
   else{out={...v,sessionId:map('ui',v.sessionId),preferences:v.preferences?{...v.preferences,documentId:map('document',v.preferences.documentId),selectedLayerIds:v.preferences.selectedLayerIds.map((id:string)=>map('layer',id))}:null,drafts:v.drafts.map((d:any)=>({...d,id:map('draft',d.id),documentId:map('document',d.documentId),targetLayerId:map('layer',d.targetLayerId),assetId:map('asset',d.assetId),...(d.kind==='composition'?{compositionBindings:Object.fromEntries(Object.entries(d.compositionBindings).map(([key,id])=>[key,map('layer',id as string)]))}:{}),...(d.kind==='mask'?{maskBindings:Object.fromEntries(Object.entries(d.maskBindings).map(([key,id])=>[key,map('asset',id as string)]))}:{})})),reconciledLayerIds:v.reconciledLayerIds.map((id:string)=>map('layer',id))};}
   if(row.kind==='portable-provider')providerRecord(out);else if(row.kind!=='draft')entity(String(row.kind),out);db.prepare('INSERT INTO mapped VALUES (?,?,?)').run(row.kind,out.id??out.sessionId??out.attemptId,canonical(out));check();await tick();
  }
 }
 async verifyBundle(id:string,auth:AssetAuth){if(this.reads.size>=128)throw new StoreError('QUEUE_FULL');const b=this.bundle(id,auth),handle=randomUUID(),slot='bundle-read:'+handle;this.objects.acquire(slot);try{const proof=await this.objects.prove(b.blob,()=>this.check());this.reads.set(handle,{ref:b.blob,proof,client:auth.clientId,session:auth.sessionHash,expires:auth.expires,slot});return {bundle:b,handle};}catch(e){this.objects.release(slot);throw e;}}
 content(handle:string,offset:string,length:number,auth:AssetAuth){const r=this.reads.get(handle);if(!r||r.client!==auth.clientId||r.session!==auth.sessionHash||auth.now>=r.expires)throw new StoreError('OWNER_REQUIRED');this.objects.proven(r.ref,r.proof);return this.objects.readRange(r.ref,offset,length);}
 release(handle:string){const r=this.reads.get(handle);if(r){this.objects.releaseProof(r.proof);this.objects.release(r.slot);this.reads.delete(handle);}}
 inventory(auth:AssetAuth,after:string){if(after!==''&&!isId(after))throw new StoreError('MALFORMED_REQUEST');const items:any[]=[];for(const r of this.db.prepare("SELECT id,operation_id,phase,failure,canonical FROM portable_preparations WHERE id>? AND json_extract(canonical,'$.command.clientId')=? ORDER BY id LIMIT 100").iterate(after,auth.clientId)){const c=JSON.parse(String(r.canonical)).command;items.push({commandId:r.id,operationId:r.operation_id,phase:this.paused.has(String(r.id))?'waiting-for-resources':r.phase,reason:this.failures.get(String(r.id))??r.failure,operation:c.body.type,documentId:c.documentId,recovery:(this.failures.get(String(r.id))??r.failure)==='TRANSACTION_EVIDENCE_UNAVAILABLE'?'restore-matching-original-history-or-cancel; original-archive-retained':'retry-same-command-or-cancel'});}return {protocolVersion:1,items,next:items.length===100?items.at(-1).commandId:null};}
 latest(documentId:string){const r=this.db.prepare('SELECT json FROM portable_bundles WHERE document_id=? ORDER BY rowid DESC LIMIT 1').get(documentId);return r?JSON.parse(String(r.json)) as Bundle:null;}
 currentUIDigest(documentId:string){const h=createHash('sha256');for(const row of this.db.prepare('SELECT client_id,session_id,json FROM ui_checkpoints ORDER BY client_id,session_id').iterate()){const all=JSON.parse(String(row.json)),drafts=all.drafts.filter((x:any)=>x.documentId===documentId);if(all.preferences.documentId!==documentId&&!drafts.length)continue;const sessionId='ui_'+hashBytes(canonical([row.client_id,row.session_id])).slice(7);h.update(canonical({sessionId,uiSeq:all.uiSeq,preferences:all.preferences.documentId===documentId?all.preferences:null,drafts,reconciledLayerIds:all.preferences.documentId===documentId?all.reconciledLayerIds:[]}));}return 'sha256:'+h.digest('hex');}
 async close(){this.closing=true;await this.running;for(const handle of this.reads.keys())this.release(handle);}
}

export function namespaceDigest(db:DatabaseSync,namespace:string){const h=createHash('sha256');const n=db.prepare('SELECT source FROM portable_namespaces WHERE id=?').get(namespace);if(!n)throw new StoreError('CORRUPT_STORE');h.update(String(n.source));for(const table of ['portable_rows','portable_maps'])for(const row of db.prepare(`SELECT * FROM ${table} WHERE namespace=? ORDER BY 1,2,3`).iterate(namespace))h.update(canonical(row)+'\n');return 'sha256:'+h.digest('hex');}
export function projectNamespace(db:DatabaseSync,namespace:string,expected:string){if(namespaceDigest(db,namespace)!==expected)throw new StoreError('CORRUPT_STORE');
  const row=db.prepare('SELECT * FROM portable_namespaces WHERE id=?').get(namespace);if(!row)throw new StoreError('CORRUPT_STORE');
  for(const kind of ['document','asset','history','checkpoint'])for(const r of db.prepare('SELECT id,json FROM portable_rows WHERE namespace=? AND kind=? ORDER BY id').iterate(namespace,kind)){const v=JSON.parse(String(r.json));entity(kind,v);if(kind==='document')db.prepare('INSERT INTO documents VALUES (?,?)').run(v.id,r.json);else if(kind==='asset'){db.prepare('INSERT INTO assets VALUES (?,?)').run(v.id,r.json);for(const ref of [v.blob,...v.dependencies])db.prepare('INSERT OR IGNORE INTO asset_dependencies VALUES (?,?)').run(v.id,ref.hash);}else db.prepare(`INSERT INTO ${kind==='history'?'history':'checkpoints'} VALUES (?,?,?)`).run(v.id,v.documentId,r.json);}
 }

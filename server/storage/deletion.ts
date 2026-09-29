import {randomUUID,createHash} from 'node:crypto';
import {unlinkSync,readdirSync,lstatSync,openSync,readSync,closeSync,rmdirSync,constants} from 'node:fs';
import {dirname,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {BlobRef,Receipt} from '../../src/protocol/store.js';
import type {DeletionBody,DeletionPlan,DeletionReceipt} from '../../src/protocol/deletion.js';
import type {QueueFact} from '../../src/protocol/queue.js';
import type {Objects,Barrier} from './objects.js';
import type {QueueStore} from './queue.js';
import type {AssetAuth} from './assets.js';
import {AssetRejection} from './assets.js';
import {canonical,hashBytes,parseCommand,isId} from './canonical.js';
import {StoreError} from './errors.js';
import {syncDirectory,assertPrivate,assertComponents} from './files.js';

type Root={owner:string;hash:string;media_type:string;byte_length:string};
const deletionTypes=['PreviewDocumentDeletion','DeleteDocument','CollectDocumentGarbage'];
/** Tombstones and intents are workspace records, deliberately outside the deleted namespace. */
export class Deletions {
 constructor(private db:DatabaseSync,private objects:Objects,private queue:QueueStore,private check:()=>void,private barrier:Barrier,
  private commit:(bytes:Uint8Array,build:()=>QueueFact)=>Receipt,private register:(owner:string,ref:BlobRef)=>void,private readers:()=>boolean,private root:string){
  queue.deletionCommand=(bytes,auth)=>this.command(bytes,auth);
 }
 private transaction<T>(work:()=>T){this.check();this.db.exec('BEGIN IMMEDIATE');try{const value=work();this.check();this.db.exec('COMMIT');return value;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
 private roots():Root[]{return this.db.prepare(`SELECT r.*,o.byte_length FROM roots r JOIN objects o ON o.hash=r.hash
  WHERE r.owner NOT LIKE 'deletion:%' AND NOT EXISTS(SELECT 1 FROM commands c WHERE r.owner IN ('command:'||c.id,'receipt:'||c.id) AND json_extract(c.canonical,'$.command.body.type') IN ('PreviewDocumentDeletion','DeleteDocument','CollectDocumentGarbage')) ORDER BY r.owner,r.hash`).all() as Root[];}
 private ownership(documentId:string){
  const owners=new Set<string>(),prefixes=new Set<string>();
  const add=(s:string)=>owners.add(s);
  for(const r of this.db.prepare("SELECT id,canonical FROM commands WHERE json_extract(canonical,'$.command.documentId')=?").all(documentId)){
   const c=JSON.parse(String(r.canonical)).command;for(const prefix of ['command:','receipt:','history-command:'])add(prefix+String(r.id));
   if(c.body.draft)prefixes.add('ui:'+c.clientId+':'+c.body.draft.sessionId+':'+c.body.draft.draftId+':');
  }
  let drafts=0;for(const r of this.db.prepare('SELECT client_id,session_id,json FROM ui_checkpoints').all())for(const d of JSON.parse(String(r.json)).drafts)if(d.documentId===documentId){drafts++;prefixes.add('ui:'+r.client_id+':'+r.session_id+':'+d.id+':');}
  for(const r of this.db.prepare("SELECT client_id,json FROM ui_receipts WHERE json_extract(json,'$.review.documentId')=?").all(documentId)){const v=JSON.parse(String(r.json));if(v.review?.id)add('request-review:'+r.client_id+':'+v.review.id);}
  const jobs=this.db.prepare("SELECT id,json FROM queue_jobs WHERE json_extract(json,'$.documentId')=?").all(documentId).map(r=>JSON.parse(String(r.json)));
  for(const j of jobs){prefixes.add('queue:'+j.id+':');for(const a of j.attempts)add('candidate-provenance:'+a.id);
   for(const r of this.db.prepare("SELECT id FROM commands WHERE json_extract(canonical,'$.command.body.type')='QueueInference' AND json_extract(canonical,'$.command.body.reviewId')=?").all(j.review.id))add('queue-input:'+r.id);
  }
  for(const r of this.db.prepare('SELECT json FROM candidates WHERE document_id=?').all(documentId)){const c=JSON.parse(String(r.json));add('candidate:'+c.id);prefixes.add('candidate-state:'+c.id+':');if(c.preparedAssetId)add('candidate-prepared:'+c.preparedAssetId);}
  for(const r of this.db.prepare('SELECT id FROM portable_namespaces WHERE document_id=?').all(documentId))add('namespace:'+r.id);
  const roots=this.roots();for(const r of roots)if([...prefixes].some(p=>r.owner.startsWith(p)))add(r.owner);
  return {owners,roots,jobs,drafts};
 }
 private protected(hash:string,excluding=new Set<string>()){
  const owners=this.db.prepare('SELECT owner FROM roots WHERE hash=?').all(hash).map(r=>String(r.owner)).filter(o=>!excluding.has(o));
  if(this.db.prepare('SELECT 1 FROM portable_pins WHERE hash=? LIMIT 1').get(hash))owners.push('active-copy-pin');
  if(this.db.prepare('SELECT 1 FROM snapshot_roots WHERE hash=? LIMIT 1').get(hash))owners.push('retained-recovery-snapshot');
  if(this.db.prepare('SELECT 1 FROM deletion_backup_pins WHERE hash=?').get(hash))owners.push('independent-migration-backup');
  return owners;
 }
 private describe(documentId:string,expectedRevision:string){
  const row=this.db.prepare('SELECT json FROM documents WHERE id=?').get(documentId);
  if(!row||this.queue.deleted(documentId))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');
  const document=JSON.parse(String(row.json));if(document.revision!==expectedRevision)throw new AssetRejection('STALE_REVISION','DOCUMENT_CHANGED');
  const {owners,roots,jobs,drafts}=this.ownership(documentId),refs=new Map<string,Root>(),retainedRoots=new Set<string>();let exclusive=0n,retained=0n;
  for(const r of roots)if(owners.has(r.owner))refs.set(r.hash,r);
  for(const r of refs.values()){const protectedBy=this.protected(r.hash,owners);if(protectedBy.length){retained+=BigInt(r.byte_length);protectedBy.forEach(o=>retainedRoots.add(o));}else exclusive+=BigInt(r.byte_length);}
  const work=this.work(documentId);for(const file of work.files)exclusive+=BigInt(file.bytes);retained+=BigInt(work.retainedBytes);if(work.retainedBytes!=='0')retainedRoots.add('protected-reconciliation-or-migration-transport');
  const rootGeneration=hashBytes(canonical({work,roots,pins:this.db.prepare('SELECT * FROM portable_pins ORDER BY operation_id,hash').all(),snapshots:this.db.prepare('SELECT * FROM snapshot_roots ORDER BY snapshot_id,owner,hash').all(),backups:this.db.prepare('SELECT * FROM deletion_backup_pins ORDER BY hash').all(),ui:this.db.prepare('SELECT * FROM ui_checkpoints ORDER BY client_id,session_id').all(),jobs,leases:this.objects.leaseIdentity(),readers:this.readers()}));
  const count=(table:string)=>Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE document_id=?`).get(documentId)!.n);
  return {owners:[...owners].sort(),refs:[...refs.values()],value:{documentId,documentRevision:expectedRevision,rootGeneration,exclusiveBytes:String(exclusive),retainedBytes:String(retained),pendingBytes:this.busy()?String(exclusive):'0',histories:count('history'),checkpoints:count('checkpoints'),drafts,jobs:jobs.length,unresolvedAttempts:jobs.flatMap(j=>j.attempts.filter((a:any)=>a.hold||['dispatching','submission-uncertain','acknowledged'].includes(a.state)).map((a:any)=>a.id)),retainedRoots:[...retainedRoots].sort(),externalCopies:'not-erased' as const,irreversible:true as const}};
 }
 private work(documentId:string){
  const files:{path:string;bytes:string;stamp:string}[]=[],directories:string[]=[];let retainedBytes=0n;
  const visit=(path:string)=>{assertComponents(dirname(path));const st=lstatSync(path);if(st.isDirectory()){assertPrivate(path,true);directories.push(path);for(const name of readdirSync(path))visit(join(path,name));}else{assertPrivate(path,false);files.push({path,bytes:String(st.size),stamp:canonical([st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs])});}};
  for(const row of this.db.prepare('SELECT path FROM deletion_work WHERE document_id=? ORDER BY path').all(documentId)){
   const path=String(row.path);if(![join(this.root,'raster-work')+'/',join(this.root,'portable')+'/'].some(prefix=>path.startsWith(prefix)))throw new StoreError('ROOT_UNSAFE');
   try{visit(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const jobs=this.db.prepare("SELECT json FROM queue_jobs WHERE json_extract(json,'$.documentId')=?").all(documentId).map(r=>JSON.parse(String(r.json))),attempts=new Map<string,any>();for(const j of jobs)for(const a of j.attempts)attempts.set(a.id,a);
  for(const name of readdirSync(this.queue.evidence.directory).filter(n=>n.endsWith('.json'))){const meta=this.queue.evidence.inspect(name.slice(0,-5)),a=attempts.get(meta.attemptId);if(!a)continue;
   // An unresolved acknowledgement is the only retained body needed to recover identity.
   if((a.hold&&meta.direction==='response'&&BigInt(meta.retainedBytes)<=65536n)||this.db.prepare('SELECT 1 FROM deletion_backup_files WHERE path=?').get(join(this.queue.evidence.directory,name))){for(const suffix of ['.body','.json'])try{retainedBytes+=BigInt(assertPrivate(join(this.queue.evidence.directory,meta.recordId+suffix),false).size);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}continue;}
   for(const suffix of ['.body','.json']){const path=join(this.queue.evidence.directory,meta.recordId+suffix);try{visit(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }
  return {retainedBytes:String(retainedBytes),files:files.sort((a,b)=>a.path.localeCompare(b.path)),directories:directories.sort((a,b)=>b.length-a.length)};
 }
 private fileHash(path:string){assertComponents(dirname(path));assertPrivate(path,false);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');try{const b=Buffer.alloc(1048576);for(;;){const n=readSync(fd,b);if(!n)break;hash.update(b.subarray(0,n));}return hash.digest('hex');}finally{closeSync(fd);}}
 private collectWork(documentId:string){
  const work=this.work(documentId);
  this.transaction(()=>{for(const file of work.files)this.db.prepare("INSERT OR IGNORE INTO deletion_files VALUES (?,?,?,?,'quarantined')").run(documentId,file.path,file.bytes,this.fileHash(file.path));});
  for(const row of this.db.prepare("SELECT * FROM deletion_files WHERE document_id=? AND state!='freed' ORDER BY path").all(documentId)){
   if(this.busy())return;const path=String(row.path);
   if(row.state!=='unlinking'){if(this.fileHash(path)!==row.hash)throw new StoreError('CORRUPT_OBJECT');this.transaction(()=>this.db.prepare("UPDATE deletion_files SET state='unlinking' WHERE document_id=? AND path=?").run(documentId,path));}
   this.barrier('deletion-work-unlink-intent');
   this.transaction(()=>{if(this.busy())throw new StoreError('STALE_EPOCH');try{if(this.fileHash(path)!==row.hash)throw new StoreError('CORRUPT_OBJECT');unlinkSync(path);syncDirectory(dirname(path));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}this.barrier('deletion-work-after-unlink');this.db.prepare("UPDATE deletion_files SET state='freed' WHERE document_id=? AND path=?").run(documentId,path);});
  }
  for(const directory of work.directories){try{rmdirSync(directory);syncDirectory(dirname(directory));}catch(e){if(!['ENOENT','ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code??''))throw e;}}
 }
 private busy(){return this.objects.hasLeases()||this.readers();}
 private fact(id:string,type:QueueFact['type'],value:unknown):QueueFact{const state=this.objects.putMetadata(Buffer.from(canonical(value)));this.register('deletion:'+id+':'+randomUUID(),state);return {type,payload:{id,version:'1',state}};}
 command(bytes:Uint8Array,auth:AssetAuth):Receipt{
  const c=parseCommand(bytes).command,b=c.body as DeletionBody;
  if(!deletionTypes.includes(b.type))throw new StoreError('UNSUPPORTED_COMMAND');
  const binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);
  if(auth.clientId!==c.clientId||!binding||binding.client_id!==auth.clientId||auth.now>=auth.expires||auth.now>=Number(binding.expires))throw new StoreError('OWNER_REQUIRED');
  if(b.type==='CollectDocumentGarbage')this.collect(b.documentId);
  return this.commit(bytes,()=>{
   if(b.type==='PreviewDocumentDeletion'){
    const d=this.describe(b.documentId,b.expectedRevision),id=randomUUID(),unsigned={id,...d.value},plan={...unsigned,planHash:hashBytes(canonical(unsigned))};
    this.db.prepare('INSERT INTO deletion_plans VALUES (?,?,?,?,?)').run(id,b.documentId,auth.clientId,canonical(plan),canonical(d.owners));return this.fact(id,'DocumentDeletionPreviewed',plan);
   }
   if(b.type==='CollectDocumentGarbage'){const receipt=this.receipt(b.documentId);if(!receipt)throw new AssetRejection('INVALID_INPUT','DELETION_REQUIRED');return this.fact(b.documentId,'DocumentGarbageCollected',receipt);}
   const row=this.db.prepare('SELECT * FROM deletion_plans WHERE id=? AND client_id=?').get(b.planId,auth.clientId),plan:DeletionPlan|undefined=row?JSON.parse(String(row.json)):undefined;
   if(!plan||plan.documentId!==b.documentId||plan.planHash!==b.planHash||plan.documentRevision!==b.expectedRevision||plan.rootGeneration!==b.rootGeneration)throw new AssetRejection('STALE_REVISION','DELETION_PREVIEW_CHANGED');
   const current=this.describe(b.documentId,b.expectedRevision);
   if(current.value.rootGeneration!==plan.rootGeneration||canonical(current.owners)!==row!.owners)throw new AssetRejection('STALE_REVISION','DELETION_ROOTS_CHANGED');
   if(plan.unresolvedAttempts.length&&!b.acknowledgeRunningAndUncertain)throw new AssetRejection('INVALID_INPUT','ACKNOWLEDGE_RUNNING_AND_UNCERTAIN');
   this.db.prepare('INSERT INTO candidate_document_tombstones VALUES (?,?)').run(b.documentId,plan.rootGeneration);
   this.queue.detachDocument(b.documentId);
   for(const row of this.db.prepare("SELECT id FROM portable_preparations WHERE json_extract(canonical,'$.command.documentId')=?").all(b.documentId))this.db.prepare("INSERT OR IGNORE INTO portable_cancellations VALUES (?,'document-deleted')").run(row.id);
   for(const owner of current.owners)this.db.prepare('DELETE FROM roots WHERE owner=?').run(owner);
   for(const ref of current.refs)this.db.prepare('INSERT INTO deletion_objects VALUES (?,?,?,?,?,?)').run(b.documentId,ref.hash,ref.byte_length,ref.media_type,'eligible',plan.rootGeneration);
   this.removeProjection(b.documentId);
   const receipt:DeletionReceipt={documentId:b.documentId,planId:plan.id,accepted:true,status:'cleanup-pending',estimatedEligibleBytes:plan.exclusiveBytes,retainedBytes:plan.retainedBytes,actualFreedBytes:'0',pendingBytes:plan.exclusiveBytes,generation:plan.rootGeneration};
   this.db.prepare('INSERT INTO deletion_receipts VALUES (?,?)').run(b.documentId,canonical(receipt));this.barrier('deletion-before-commit');return this.fact(b.documentId,'DocumentDeleted',receipt);
  });
 }
 removeProjection(documentId:string){
  this.db.prepare('DELETE FROM checkpoints WHERE document_id=?').run(documentId);this.db.prepare('DELETE FROM history WHERE document_id=?').run(documentId);this.db.prepare('DELETE FROM documents WHERE id=?').run(documentId);
  this.db.prepare('DELETE FROM image_previews WHERE document_id=?').run(documentId);
  for(const row of this.db.prepare('SELECT client_id,session_id,json FROM ui_checkpoints').all()){
   const v=JSON.parse(String(row.json));v.drafts=v.drafts.filter((d:any)=>d.documentId!==documentId);if(v.preferences.documentId===documentId){v.preferences.documentId=null;v.preferences.selectedLayerIds=[];v.reconciledLayerIds=[];}this.db.prepare('UPDATE ui_checkpoints SET json=? WHERE client_id=? AND session_id=?').run(canonical(v),row.client_id,row.session_id);
  }
  this.db.prepare('DELETE FROM candidate_private WHERE id IN (SELECT id FROM candidates WHERE document_id=?)').run(documentId);
  this.db.prepare('DELETE FROM candidates WHERE document_id=?').run(documentId);
  this.db.prepare("DELETE FROM candidate_jobs WHERE json_extract(json,'$.documentId')=?").run(documentId);
 }
 list(after=''){this.check();if(after&&!isId(after))throw new StoreError('MALFORMED_REQUEST');const rows=this.db.prepare('SELECT json FROM deletion_receipts WHERE document_id>? ORDER BY document_id LIMIT 21').all(after),items=rows.slice(0,20).map(r=>JSON.parse(String(r.json)) as DeletionReceipt);return {items,next:rows.length>20?items.at(-1)!.documentId:null};}
 receipt(documentId:string):DeletionReceipt|null{const row=this.db.prepare('SELECT json FROM deletion_receipts WHERE document_id=?').get(documentId);return row?JSON.parse(String(row.json)):null;}
 view(documentId:string,auth:AssetAuth,after=''){this.check();if(!isId(documentId)||(after&&!isId(after)))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT json FROM deletion_plans WHERE document_id=? AND client_id=? ORDER BY rowid DESC LIMIT 1').get(documentId,auth.clientId);const rows=this.db.prepare("SELECT id,json FROM queue_jobs WHERE json_extract(json,'$.documentId')=? AND id>? ORDER BY id LIMIT 21").all(documentId,after),jobs=rows.slice(0,20).map(r=>JSON.parse(String(r.json)) as import('../../src/protocol/queue.js').QueueJob);return {plan:row?JSON.parse(String(row.json)) as DeletionPlan:null,receipt:this.receipt(documentId),jobs,next:rows.length>20?jobs.at(-1)!.id:null};}
 resume(){for(const row of this.db.prepare("SELECT DISTINCT document_id FROM deletion_objects WHERE state IN ('quarantined','unlinking') UNION SELECT document_id FROM deletion_files WHERE state IN ('quarantined','unlinking')").all())this.collect(String(row.document_id));}
 collect(documentId:string){
  if(!this.receipt(documentId))throw new AssetRejection('INVALID_INPUT','DELETION_REQUIRED');
  this.transaction(()=>{this.db.prepare("UPDATE deletion_objects SET state='quarantined' WHERE document_id=? AND state='eligible'").run(documentId);});this.barrier('deletion-quarantine-committed');
  if(this.busy())return;
  for(const row of this.db.prepare("SELECT * FROM deletion_objects WHERE document_id=? AND state IN ('quarantined','unlinking') ORDER BY hash").all(documentId)){
   const ref={hash:String(row.hash),byteLength:String(row.byte_length),mediaType:String(row.media_type)};
   if(this.busy())break;
   if(this.protected(ref.hash).length){this.transaction(()=>this.db.prepare("UPDATE deletion_objects SET state='rescued' WHERE document_id=? AND hash=?").run(documentId,ref.hash));continue;}
   if(row.state!=='unlinking'){this.objects.verify(ref);this.transaction(()=>{if(this.protected(ref.hash).length||this.busy())throw new StoreError('STALE_EPOCH');this.db.prepare("UPDATE deletion_objects SET state='unlinking' WHERE document_id=? AND hash=?").run(documentId,ref.hash);});}
   this.barrier('deletion-unlink-intent-committed');
   this.transaction(()=>{
    if(this.protected(ref.hash).length||this.busy()){this.db.prepare("UPDATE deletion_objects SET state='rescued' WHERE document_id=? AND hash=?").run(documentId,ref.hash);return;}
    try{this.objects.verify(ref);unlinkSync(this.objects.path(ref));syncDirectory(dirname(this.objects.path(ref)));}catch(e){if(!(e instanceof StoreError&&e.code==='MISSING_OBJECT')&&(e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    this.barrier('deletion-after-unlink');this.db.prepare("UPDATE deletion_objects SET state='freed' WHERE document_id=? AND hash=?").run(documentId,ref.hash);
   });
  }
  this.collectWork(documentId);
  this.transaction(()=>{const receipt=this.receipt(documentId)!;let freed=0n,pending=0n,retained=BigInt(this.work(documentId).retainedBytes);for(const r of this.db.prepare('SELECT byte_length,state FROM deletion_objects WHERE document_id=? UNION ALL SELECT bytes AS byte_length,state FROM deletion_files WHERE document_id=?').all(documentId,documentId)){if(r.state==='freed')freed+=BigInt(String(r.byte_length));else if(r.state==='rescued')retained+=BigInt(String(r.byte_length));else pending+=BigInt(String(r.byte_length));}receipt.actualFreedBytes=String(freed);receipt.pendingBytes=String(pending);receipt.retainedBytes=String(retained);receipt.status=pending===0n?'cleanup-complete':'cleanup-pending';this.db.prepare('UPDATE deletion_receipts SET json=? WHERE document_id=?').run(canonical(receipt),documentId);});
 }
}

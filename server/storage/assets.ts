import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, fstatSync, ftruncateSync, lstatSync, openSync, readSync, readdirSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Asset, AssetFact, StagingCreateRequest, StagingRecord, StagingRecoveryItem, StagingRecoveryPage, StagingTransferReview } from '../../src/protocol/assets.js';
import type { BlobRef, Command, Receipt, RejectionCode } from '../../src/protocol/store.js';
import { canonical, hashBytes, isId, isSeq, keys, parseCommand } from './canonical.js';
import { StoreError, safeError } from './errors.js';
import { assertComponents, assertPrivate, privateDirectory, sameFile, syncDirectory } from './files.js';
import { IO_CHUNK, type Objects, type Barrier } from './objects.js';

export type AssetAuth = { clientId: string; sessionHash: string; expires: number; now: number };
export class AssetRejection extends Error {
  constructor(readonly code: RejectionCode, readonly reason: string, readonly currentRevision: string | null = null) {super(reason);}
}
type StoredStage = { record: StagingRecord; createdAt: string; filename: string };
type Lease = { id: string; owner: string; version: string; offset: string; length: number; at: number };
type Commit = (bytes: Uint8Array, build: () => AssetFact, failure?: () => void) => Receipt;
const hashPattern=/^sha256:[a-f0-9]{64}$/;
export class Assets {
  private directory: string;
  private leases=new Map<string,Lease>();
  private cursors=new Map<string,{after:string;clientId:string;sessionHash:string;expires:number}>();
  private running=new Set<string>();
  private paused=new Set<string>();
  private closing=false;
  private work=new Set<Promise<void>>();
  preparationMs:number[]=[];
  constructor(private db: DatabaseSync, private objects: Objects, root: string, private epoch: string, private check:()=>void,
    private barrier:Barrier, private commit:Commit, private register:(owner:string,ref:BlobRef,proof:string)=>void) {
    this.directory=join(root,'uploads');privateDirectory(this.directory);
    // Only recorded, flushed offsets survive. Never infer durability from length.
    for(const row of db.prepare('SELECT * FROM staged_assets').iterate()) {
      const stage=this.fromRow(row);if(stage.record.state==='finalized')continue;
      try {const fd=this.open(stage);try{if(BigInt(fstatSync(fd).size)<BigInt(stage.record.committedOffset))throw new StoreError('CORRUPT_OBJECT');ftruncateSync(fd,Number(BigInt(stage.record.committedOffset)));fsyncSync(fd);}finally{closeSync(fd);}}
      catch(e){
        if((e as NodeJS.ErrnoException).code!=='ENOENT'&&!(e instanceof StoreError&&e.code==='CORRUPT_OBJECT'))throw e;
        // A closed/renamed exact original may precede acceptance. Missing staged
        // data is recoverable metadata, not a reason to hide the whole workspace.
        const ref={hash:stage.record.sha256,byteLength:stage.record.expectedBytes,mediaType:stage.record.mediaType};
        try{if(stage.record.state!=='complete')throw new StoreError('MISSING_OBJECT');this.objects.verify(ref);}
        catch(error){if(error instanceof StoreError&&error.code==='ROOT_UNSAFE')throw error;stage.record.state='failed';stage.record.version=String(BigInt(stage.record.version)+1n);this.save(stage);}
      }
      this.objects.reserve('upload:'+stage.record.stagingId,BigInt(stage.record.expectedBytes)-BigInt(stage.record.committedOffset),false);
    }
  }
  private fromRow(row:any):StoredStage {return {record:JSON.parse(String(row.json)),createdAt:String(row.created_at),filename:String(row.filename)};}
  private stage(id:string):StoredStage {this.check();if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM staged_assets WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');return this.fromRow(row);}
  private save(s:StoredStage){this.db.prepare('UPDATE staged_assets SET json=? WHERE id=?').run(canonical(s.record),s.record.stagingId);}
  private path(s:StoredStage){if(!isId(s.filename))throw new StoreError('CORRUPT_STORE');return join(this.directory,s.filename);}
  private open(s:StoredStage){assertComponents(this.directory);assertPrivate(this.directory,true);const identity=assertPrivate(this.path(s),false);const fd=openSync(this.path(s),constants.O_RDWR|constants.O_NOFOLLOW);if(!sameFile(identity,fstatSync(fd))){closeSync(fd);throw new StoreError('ROOT_UNSAFE');}return fd;}
  private owner(s:StoredStage,clientId:string){if(s.record.ownerClientId!==clientId)throw new StoreError('OWNER_REQUIRED');}
  private transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{this.check();const result=fn();this.db.exec('COMMIT');return result;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
  create(value:unknown,auth:AssetAuth){
    this.check();keys(value,['protocolVersion','stagingId','purpose','expectedBytes','sha256','mediaType']);
    if(!Number.isInteger(value.protocolVersion))throw new StoreError('MALFORMED_REQUEST');if(value.protocolVersion!==1)throw new StoreError('PROTOCOL_VERSION');
    if(!isId(value.stagingId)||!isSeq(value.expectedBytes)||typeof value.sha256!=='string'||!hashPattern.test(value.sha256)||typeof value.mediaType!=='string')throw new StoreError('MALFORMED_REQUEST');
    const request=value as StagingCreateRequest;
    const existing=this.db.prepare('SELECT * FROM staged_assets WHERE id=?').get(request.stagingId);
    if(existing){const stage=this.fromRow(existing);this.owner(stage,auth.clientId);const r=stage.record;
      if(canonical(request)!==canonical({protocolVersion:r.protocolVersion,stagingId:r.stagingId,purpose:r.purpose,expectedBytes:r.expectedBytes,sha256:r.sha256,mediaType:r.mediaType}))throw new StoreError('STAGING_ID_REUSE');
      return {created:false,record:r};}
    const allowed=request.purpose==='image'?['image/png','image/jpeg','image/webp']:request.purpose==='mask'?['image/png']:request.purpose==='caption'?['text/plain','application/json']:[];
    if(!allowed.includes(request.mediaType))throw new StoreError('MEDIA_TYPE');
    // Deferred parsers never gain eligibility from a declared type or signature.
    const reservation='upload:'+request.stagingId;this.objects.reserve(reservation,BigInt(request.expectedBytes));
    const filename=randomUUID();const path=join(this.directory,filename);
    try {
      assertComponents(this.directory);assertPrivate(this.directory,true);
      const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(this.directory);
      const record:StagingRecord={...request,ownerClientId:auth.clientId,version:'1',committedOffset:'0',state:request.expectedBytes==='0'?'complete':'receiving'};
      this.transaction(()=>this.db.prepare('INSERT INTO staged_assets VALUES (?,?,?,?)').run(record.stagingId,canonical(record),new Date(auth.now).toISOString(),filename));
      return {created:true,record};
    }catch(e){this.objects.unreserve(reservation);throw e;}
  }
  get(id:string,auth:AssetAuth){const s=this.stage(id);this.owner(s,auth.clientId);return s.record;}
  private minimal(s:StoredStage):StagingRecoveryItem {
    if(s.record.state==='finalized')throw new StoreError('NOT_FOUND');const r=s.record;
    return {stagingId:r.stagingId,ownerClientId:r.ownerClientId,version:r.version,purpose:r.purpose,expectedBytes:r.expectedBytes,committedOffset:r.committedOffset,createdAt:s.createdAt,state:r.state as StagingRecoveryItem['state']};
  }
  inventory(cursor:string|null,auth:AssetAuth):StagingRecoveryPage {
    this.check();for(const [id,c]of this.cursors)if(auth.now>=c.expires)this.cursors.delete(id);
    let after='';if(cursor){const c=this.cursors.get(cursor);if(!c||c.clientId!==auth.clientId||c.sessionHash!==auth.sessionHash)throw new StoreError('MALFORMED_REQUEST');after=c.after;}
    const items:StagingRecoveryItem[]=[];let more=false;
    for(const row of this.db.prepare("SELECT * FROM staged_assets WHERE id>? AND json_extract(json,'$.state')!='finalized' ORDER BY id").iterate(after)){
      const s=this.fromRow(row);if(s.record.state==='finalized')continue;const item=this.minimal(s);
      if(Buffer.byteLength(canonical({protocolVersion:1,items:[...items,item],nextCursor:'x'.repeat(36)}))>60000){more=true;break;}items.push(item);
    }
    let nextCursor:string|null=null;if(more){if(this.cursors.size>=128)throw new StoreError('QUEUE_FULL');nextCursor=randomUUID();this.cursors.set(nextCursor,{after:items.at(-1)!.stagingId,clientId:auth.clientId,sessionHash:auth.sessionHash,expires:Math.min(auth.expires,auth.now+1800000)});}
    return {protocolVersion:1,items,nextCursor};
  }
  beginChunk(id:string,offset:string,length:number,auth:AssetAuth){
    const s=this.stage(id);this.owner(s,auth.clientId);const r=s.record;
    if(!isSeq(offset)||!Number.isSafeInteger(length)||length<1)throw new StoreError('MALFORMED_REQUEST');
    if(offset!==r.committedOffset)throw new StoreError('OFFSET_MISMATCH',{kind:'offset',committedOffset:r.committedOffset,stagingVersion:r.version});
    if(length>IO_CHUNK||BigInt(offset)+BigInt(length)>BigInt(r.expectedBytes))throw new StoreError('PAYLOAD_TOO_LARGE');
    if(r.state!=='receiving'||this.db.prepare('SELECT id FROM asset_preparations WHERE staging_id=?').get(id))throw new StoreError('CONTENT_WITHHELD');
    for(const lease of this.leases.values())if(lease.id===id)throw new StoreError('QUEUE_FULL');
    this.objects.reserve('upload:'+id,BigInt(r.expectedBytes)-BigInt(offset));
    const token=randomUUID();this.objects.acquire(token);this.leases.set(token,{id,owner:auth.clientId,version:r.version,offset,length,at:Date.now()});return token;
  }
  checkChunk(token:string,auth:AssetAuth){const lease=this.leases.get(token);if(!lease)throw new StoreError('OWNER_REQUIRED');const s=this.stage(lease.id);this.owner(s,auth.clientId);if(lease.owner!==auth.clientId||lease.version!==s.record.version)throw new StoreError('OWNER_REQUIRED');this.objects.capacity(0n);}
  abortChunk(token:string){this.leases.delete(token);this.objects.release(token);}
  chunk(token:string,bytes:Uint8Array,auth:AssetAuth){
    const lease=this.leases.get(token);if(!lease)throw new StoreError('OWNER_REQUIRED');
    try{
      const s=this.stage(lease.id);this.owner(s,auth.clientId);const r=s.record;
      if(auth.clientId!==lease.owner||r.version!==lease.version)throw new StoreError('OWNER_REQUIRED');
      if(bytes.length!==lease.length)throw new StoreError('MALFORMED_REQUEST');
      this.objects.reserve('upload:'+r.stagingId,BigInt(r.expectedBytes)-BigInt(r.committedOffset));
      const fd=this.open(s);
      try {
        ftruncateSync(fd,Number(BigInt(r.committedOffset)));this.barrier('upload-before-write');
        for(let n=0;n<bytes.length;){const written=writeSync(fd,bytes,n,bytes.length-n,Number(BigInt(r.committedOffset))+n);if(!written)throw new StoreError('STORAGE_FAILURE');n+=written;}
        this.barrier('upload-before-flush');fsyncSync(fd);this.barrier('upload-after-flush');
      }finally{closeSync(fd);}
      this.transaction(()=>{this.owner(this.stage(r.stagingId),auth.clientId);r.committedOffset=String(BigInt(r.committedOffset)+BigInt(bytes.length));r.version=String(BigInt(r.version)+1n);r.state=r.committedOffset===r.expectedBytes?'complete':'receiving';this.save(s);this.barrier('upload-before-offset-commit');});
      this.barrier('upload-after-offset-commit');this.objects.reserve('upload:'+r.stagingId,BigInt(r.expectedBytes)-BigInt(r.committedOffset),false);return r;
    }finally{this.abortChunk(token);}
  }
  review(id:string,auth:AssetAuth):StagingTransferReview {
    this.check();const row=this.db.prepare('SELECT * FROM transfer_reviews WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');const r=JSON.parse(String(row.json)) as StagingTransferReview;
    if(r.targetClientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
    if(row.session_hash!==auth.sessionHash||row.epoch!==this.epoch||auth.now>=Date.parse(r.expiresAt))throw new StoreError('REVIEW_EXPIRED');return r;
  }
  command(bytes:Uint8Array,auth:AssetAuth){
    const c=parseCommand(bytes).command;if(c.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
    const previous=this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);const hash=hashBytes(canonical({protocolVersion:1,command:c}));
    if(previous){if(previous.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return JSON.parse(String(previous.receipt)) as Receipt;}
    const pending=this.pending(c.commandId);if(pending){if(pending.command.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');if(pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');this.paused.delete(c.commandId);this.schedule(true);return null;}
    const body=c.body;if(!('stagingId' in body))throw new StoreError('UNSUPPORTED_COMMAND');
    const s=this.stage(body.stagingId);
    if(body.type==='FinalizeStaging'){
      this.owner(s,auth.clientId);
      // Validate inside the same writer transaction that journals preparation.
      if(s.record.state!=='complete'||body.expectedSha256!==s.record.sha256)return this.commit(bytes,()=>{throw new AssetRejection(s.record.state==='finalized'?'INCOMPATIBLE':'INVALID_INPUT','STAGING_NOT_MATCHING_COMPLETE');});
      if(this.db.prepare('SELECT id FROM asset_preparations WHERE staging_id=?').get(s.record.stagingId))return this.commit(bytes,()=>{throw new AssetRejection('CAPACITY','STAGING_PREPARATION_ACTIVE');});
      if(Number(this.db.prepare('SELECT count(*) AS n FROM asset_preparations').get()!.n)>=64)throw new StoreError('QUEUE_FULL');
      this.transaction(()=>{this.db.prepare('INSERT INTO asset_preparations VALUES (?,?,?,?,?,?,?,?)').run(c.commandId,hash,Buffer.from(bytes).toString('utf8'),canonical({protocolVersion:1,command:c}),randomUUID(),s.record.stagingId,s.record.version,'preparing');this.barrier('preparation-before-commit');});
      this.barrier('preparation-after-commit');this.schedule(true);return null;
    }
    const receipt=this.commit(bytes,()=>{
      const current=this.stage(body.stagingId);
      if(current.record.state==='finalized')throw new AssetRejection('INCOMPATIBLE','STAGING_FINALIZED');
      if(body.type==='PreviewStagingOwnershipTransfer'){
        const reviewId=randomUUID();const value={reviewId,targetClientId:auth.clientId,staging:this.minimal(current),expiresAt:new Date(Math.min(auth.expires,auth.now+1800000)).toISOString()};
        const review:StagingTransferReview={protocolVersion:1,...value,reviewHash:hashBytes(canonical(value))};
        this.db.prepare('INSERT INTO transfer_reviews VALUES (?,?,?,?)').run(reviewId,canonical(review),auth.sessionHash,this.epoch);
        return {type:'StagingTransferReviewPrepared',payload:{reviewId,reviewHash:review.reviewHash}};
      }
      if(body.type!=='TransferStagingOwnership')throw new StoreError('UNSUPPORTED_COMMAND');
      let review:StagingTransferReview;try{review=this.review(body.reviewId,auth);}catch{throw new AssetRejection('INVALID_INPUT','REVIEW_INVALID_OR_EXPIRED');}
      if(review.reviewHash!==body.reviewHash||review.staging.stagingId!==body.stagingId)throw new AssetRejection('INVALID_INPUT','REVIEW_MISMATCH');
      const r=current.record;
      if(body.expectedVersion!==r.version||body.expectedOwnerClientId!==r.ownerClientId||review.staging.version!==r.version||review.staging.ownerClientId!==r.ownerClientId||review.staging.state!==r.state)throw new AssetRejection('STALE_REVISION','STAGING_CHANGED',r.version);
      if(this.db.prepare('SELECT id FROM asset_preparations WHERE staging_id=?').get(body.stagingId))throw new AssetRejection('CAPACITY','PREPARATION_MUST_QUIESCE',r.version);
      // All disk writes execute synchronously on this sole worker. Network leases
      // have no file callback: revoke before commit; queued IPC tokens fail closed.
      for(const [token,lease]of this.leases)if(lease.id===r.stagingId)this.abortChunk(token);
      const fromClientId=r.ownerClientId;r.ownerClientId=auth.clientId;r.version=String(BigInt(r.version)+1n);this.save(current);this.barrier('transfer-before-commit');
      return {type:'StagingOwnershipTransferred',payload:{stagingId:r.stagingId,fromClientId,toClientId:auth.clientId,version:r.version,committedOffset:r.committedOffset}};
    });
    if(body.type==='TransferStagingOwnership'&&receipt.status==='accepted')this.barrier('transfer-after-commit');return receipt;
  }
  pending(id:string){
    if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM asset_preparations WHERE id=?').get(id);if(!row)return null;
    try{const request=parseCommand(Buffer.from(String(row.original)));const c=request.command;
      if(c.commandId!==id||canonical(request)!==row.canonical||hashBytes(String(row.canonical))!==row.hash||c.body.type!=='FinalizeStaging'||c.body.stagingId!==row.staging_id||!isId(row.operation_id)||!isSeq(row.staging_version)||!['preparing','waiting-for-resources'].includes(String(row.phase)))throw new Error();
      return {hash:String(row.hash),command:c,operationId:String(row.operation_id),phase:String(row.phase) as 'preparing'|'waiting-for-resources'};
    }catch{throw new StoreError('CORRUPT_STORE');}
  }
  schedule(retryWaiting=false){if(this.closing)return;setImmediate(()=>{if(this.closing)return;for(const row of this.db.prepare("SELECT id FROM asset_preparations WHERE phase='preparing' OR ? ORDER BY id LIMIT 64").all(retryWaiting?1:0)){
    const id=String(row.id);if(this.running.has(id)||this.paused.has(id))continue;try{this.objects.acquire('prepare:'+id);}catch{break;}
    this.running.add(id);const work=this.prepare(id).catch(()=>{this.paused.add(id);try{this.transaction(()=>this.db.prepare("UPDATE asset_preparations SET phase='waiting-for-resources' WHERE id=?").run(id));}catch{/* Retain the last durable preparation when the journal itself cannot advance. */}}).finally(()=>{this.objects.release('prepare:'+id);this.running.delete(id);this.work.delete(work);this.schedule();});this.work.add(work);
  }});}
  private async prepare(id:string){
    const started=performance.now();const pending=this.pending(id);if(!pending)return;
    const c=pending.command;const row=this.db.prepare('SELECT * FROM asset_preparations WHERE id=?').get(id)!;
    const bytes=Buffer.from(String(row.original));const stage=this.stage(String(row.staging_id));const r=stage.record;
    try{
      if(r.ownerClientId!==c.clientId||r.version!==row.staging_version||r.state!=='complete')throw new AssetRejection('STALE_REVISION','STAGING_CHANGED',r.version);
      this.objects.reserve('upload:'+r.stagingId,0n);const ref:BlobRef={hash:r.sha256,byteLength:r.expectedBytes,mediaType:r.mediaType};
      let fd:number;let source=this.path(stage);let renamed=false;
      try{fd=this.open(stage);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;source=this.objects.path(ref);assertComponents(dirname(source));const identity=assertPrivate(source,false);fd=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW);if(!sameFile(identity,fstatSync(fd))){closeSync(fd);throw new StoreError('ROOT_UNSAFE');}renamed=true;}
      let measured:Asset['measuredMediaType']='text/plain';
      try{
        const buffer=Buffer.alloc(IO_CHUNK);const hash=createHash('sha256');let at=0n;let checkedAt=Date.now();const decoder=r.purpose==='caption'?new TextDecoder('utf-8',{fatal:true}):null;
        for(;;){this.check();if(this.closing)throw new StoreError('CLOSED');if(Date.now()-checkedAt>=30000){this.objects.capacity(0n);checkedAt=Date.now();}
          const n=readSync(fd,buffer);if(!n)break;hash.update(buffer.subarray(0,n));if(at===0n)measured=this.signature(buffer.subarray(0,n),r);
          if(decoder)try{decoder.decode(buffer.subarray(0,n),{stream:true});}catch{throw new AssetRejection('INVALID_INPUT','INVALID_UTF8');}
          at+=BigInt(n);if(at>BigInt(r.expectedBytes))throw new AssetRejection('INVALID_INPUT','LENGTH_MISMATCH');await new Promise<void>(resolve=>setImmediate(resolve));
        }
        if(decoder)try{decoder.decode();}catch{throw new AssetRejection('INVALID_INPUT','INVALID_UTF8');}
        if(at!==BigInt(r.expectedBytes)||'sha256:'+hash.digest('hex')!==r.sha256)throw new AssetRejection('INVALID_INPUT','LENGTH_OR_HASH_MISMATCH');
        if(r.purpose!=='caption'&&at===0n)throw new AssetRejection('INVALID_INPUT','IMAGE_SIGNATURE_REQUIRED');
        this.barrier('finalize-before-flush');fsyncSync(fd);this.barrier('finalize-after-flush');
      }finally{closeSync(fd);}
      if(!renamed){const target=this.objects.path(ref);privateDirectory(dirname(target));this.barrier('finalize-before-rename');
        try{lstatSync(target);const proof=await this.objects.prove(ref,()=>this.check());this.objects.releaseProof(proof);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;renameSync(source,target);}
        this.barrier('finalize-after-rename');syncDirectory(dirname(target));syncDirectory(this.directory);this.barrier('finalize-after-directory-sync');}
      // Verify the immutable target after close/rename/directory sync before any
      // root/event is accepted. This is file identity, not decoder qualification.
      const proof=await this.objects.prove(ref,()=>{this.check();if(this.closing)throw new StoreError('CLOSED');});this.barrier('finalize-before-register');
      try{this.commit(bytes,()=>{
        const current=this.stage(r.stagingId);if(current.record.ownerClientId!==c.clientId||current.record.version!==r.version)throw new AssetRejection('STALE_REVISION','STAGING_CHANGED',current.record.version);
        const asset:Asset={id:String(row.operation_id),version:'1',purpose:r.purpose,blob:ref,dependencies:[],safety:r.purpose==='caption'?'safe':'unknown',availability:'available',qualification:r.purpose==='caption'?'opaque-text':'pending-decoder',measuredMediaType:measured};
        this.register('asset:'+asset.id,ref,proof);r.state='finalized';r.version=String(BigInt(r.version)+1n);r.assetRef=ref;this.save(stage);
        this.db.prepare('DELETE FROM asset_preparations WHERE id=?').run(id);
        return {type:'AssetRegistered',payload:{asset}};
      });
      }finally{this.objects.releaseProof(proof);}
      this.objects.unreserve('upload:'+r.stagingId);this.barrier('finalize-after-register');
      this.preparationMs.push(performance.now()-started);if(this.preparationMs.length>100)this.preparationMs.shift();
    }catch(error){
      if(error instanceof AssetRejection){this.commit(bytes,()=>{throw error;},()=>{const current=this.stage(r.stagingId);current.record.state='failed';current.record.version=String(BigInt(current.record.version)+1n);this.save(current);this.db.prepare('DELETE FROM asset_preparations WHERE id=?').run(id);});this.objects.unreserve('upload:'+r.stagingId);}
      else {const failure=safeError(error);if(failure.code!=='CLOSED')this.transaction(()=>this.db.prepare("UPDATE asset_preparations SET phase='waiting-for-resources' WHERE id=?").run(id));}
    }
  }
  private signature(bytes:Uint8Array,r:StagingRecord):Asset['measuredMediaType'] {
    const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(r.purpose==='caption')return 'text/plain';
    let mime:Asset['measuredMediaType']|null=null;
    if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.toString('ascii',12,16)==='IHDR')mime='image/png';
    else if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)mime='image/jpeg';
    else if(b.length>=16&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')mime='image/webp';
    if(!mime||mime!==r.mediaType||(r.purpose==='mask'&&mime!=='image/png'))throw new AssetRejection('INVALID_INPUT','UNSUPPORTED_OR_MISMATCHED_SIGNATURE');
    return mime; // All image formats remain unknown, including possible animation.
  }
  asset(id:string):Asset|null{this.check();if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT json FROM assets WHERE id=?').get(id);return row?JSON.parse(String(row.json)):null;}
  safeAsset(id:string){const a=this.asset(id);if(!a)throw new StoreError('NOT_FOUND');if(a.safety!=='safe'||a.qualification!=='opaque-text')throw new StoreError('CONTENT_WITHHELD');if(a.availability!=='available')throw new StoreError('NOT_FOUND');return a;}
  private readers=new Map<string,string>();
  async verify(id:string){const a=this.safeAsset(id);const slot=randomUUID();this.objects.acquire(slot);try{const handle=await this.objects.prove(a.blob,()=>{this.safeAsset(id);if(this.closing)throw new StoreError('CLOSED');});this.readers.set(handle,slot);return {asset:a,handle};}catch(e){this.objects.release(slot);if((e as NodeJS.ErrnoException).code==='ENOENT'||(e instanceof StoreError&&['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code)))throw new StoreError('NOT_FOUND');throw e;}}
  content(id:string,handle:string,offset:string,length:number){const a=this.safeAsset(id);this.objects.proven(a.blob,handle);const bytes=this.objects.readRange(a.blob,offset,length);this.objects.proven(a.blob,handle);return bytes;}
  releaseContent(handle:string){const slot=this.readers.get(handle);if(slot)this.objects.release(slot);this.readers.delete(handle);this.objects.releaseProof(handle);}
  diagnostics(){
    let orphanUploadCount=0n,orphanUploadBytes=0n,committedBytes=0n,failedCount=0n;
    for(const filename of readdirSync(this.directory)){const stat=assertPrivate(join(this.directory,filename),false);if(!this.db.prepare('SELECT id FROM staged_assets WHERE filename=?').get(filename)){orphanUploadCount++;orphanUploadBytes+=BigInt(stat.size);}}
    for(const row of this.db.prepare('SELECT json FROM staged_assets').iterate()){const s=JSON.parse(String(row.json)) as StagingRecord;committedBytes+=BigInt(s.committedOffset);if(s.state==='failed')failedCount++;}
    return {orphanUploadCount:String(orphanUploadCount),orphanUploadBytes:String(orphanUploadBytes),committedBytes:String(committedBytes),failedCount:String(failedCount),preparations:String(this.db.prepare('SELECT count(*) AS n FROM asset_preparations').get()!.n),stages:String(this.db.prepare('SELECT count(*) AS n FROM staged_assets').get()!.n),...this.objects.reservationInventory(),preparationMs:this.preparationMs};}
  pressure(){return this.paused.size>0||!!this.db.prepare("SELECT id FROM asset_preparations WHERE phase='waiting-for-resources' LIMIT 1").get();}
  async close(){this.closing=true;for(const token of this.leases.keys())this.abortChunk(token);await Promise.allSettled(this.work);for(const handle of this.readers.keys())this.releaseContent(handle);}
}

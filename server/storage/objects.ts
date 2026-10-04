import {withDiagnosticDirectory,closeDiagnosticDirectories} from '../observability/diagnostic-memory.js';
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { BlobRef } from '../../src/protocol/store.js';
import { assertComponents, assertPrivate, inspectTree, privateDirectory, sameFile, syncDirectory } from './files.js';
import { isSeq, validateBlob } from './canonical.js';
import { StoreError } from './errors.js';
import { adapterResources } from '../observability/adapter-resources.js';

export const IO_CHUNK = 1024 * 1024;
// Proof entries are small immutable identities, not retained byte buffers.
// Charge a conservative fixed allowance for their bounded strings, map entry
// and pending continuation. CP-1's 100-layer closure can exceed 512 identities.
export const PROOF_METADATA_BYTES = 2048;
export const PROOF_METADATA_BUDGET = 4 * 1024 * 1024;
export const PROOF_LIMIT = PROOF_METADATA_BUDGET / PROOF_METADATA_BYTES;
export const PROOF_HASH_READERS = 2;
const MARGIN = 1024n ** 3n;
const EMERGENCY = 64n * 1024n ** 2n;
export type Barrier = (phase: string) => void;
type Stage = { fd: number; path: string; length: bigint; received: bigint; hash: ReturnType<typeof createHash>;
  expectedHash?: string; mediaType: string; reserved: bigint; checkedAt: number; releaseFD: () => void; releaseHash: () => void };
type ProofWaiter = { resolve:(admitted:boolean)=>void; reject:(error:unknown)=>void; check:()=>void };
export type RepairTarget = { condition:'missing'|'corrupt'|'available'; identity:string };
type HeldRepair = RepairTarget & { ref:Readonly<BlobRef>;fd?:number;stamp?:string;prepared?:{stageId:string;stamp:string};published?:string;releaseObserved:()=>void };
export class Objects {
  private stages = new Map<string, Stage>();
  private reserved = 0n;
  private external = new Map<string,bigint>();
  private slots = new Set<string>();
  private observedSlots = new Map<string, () => void>();
  private observedProofs = new Map<string, () => void>();
  private available:()=>void=()=>{};
  private repairReads=0;
  private repairs=new Map<string,HeldRepair>();
  hasLeases(){return this.stages.size>0||this.slots.size>0||this.proofReservations.size>0||this.repairReads>0||this.repairs.size>0;}
  leaseIdentity(){return {stages:[...this.stages.keys()].sort(),slots:[...this.slots].sort(),proofs:[...this.proofReservations].sort(),repairs:[...this.repairs.keys()].sort(),repairReads:this.repairReads};}
  onAvailable(callback:()=>void){this.available=callback;}
  private proofs = new Map<string,{ref:Readonly<BlobRef>;stamp:string}>();
  private proofReservations = new Set<string>();
  private proofReaders = 0;
  private proofWaiters = new Set<ProofWaiter>();
  private proofWaitTimer:ReturnType<typeof setTimeout>|undefined;
  private proofClosed = false;
  proofInventory(){return {pending:this.proofReservations.size-this.proofs.size,retained:this.proofs.size,activeReaders:this.proofReaders,metadataBytes:this.proofReservations.size*PROOF_METADATA_BYTES};}
  resourceOwnership(){return {stages:this.stages.size,slots:this.slots.size,proofReservations:this.proofReservations.size,retainedProofs:this.proofs.size,proofReaders:this.proofReaders,proofWaiters:this.proofWaiters.size,proofWaitTimer:!!this.proofWaitTimer,repairReads:this.repairReads,repairs:this.repairs.size};}
  private checkProofWaiters(){
    this.proofWaitTimer=undefined;
    for(const waiter of this.proofWaiters){try{waiter.check();}catch(error){this.proofWaiters.delete(waiter);waiter.reject(error);}}
    this.scheduleProofWaitCheck();
  }
  private scheduleProofWaitCheck(){
    // One bounded admission queue owns one timer. A cancelled owner can release
    // its pending lease without waiting for unrelated large hashes to finish.
    if(this.proofWaiters.size&&!this.proofClosed&&!this.proofWaitTimer){this.proofWaitTimer=setTimeout(()=>this.checkProofWaiters(),25);this.proofWaitTimer.unref();}
    else if(!this.proofWaiters.size&&this.proofWaitTimer){clearTimeout(this.proofWaitTimer);this.proofWaitTimer=undefined;}
  }
  private proofReader(check:()=>void):Promise<boolean>{
    if(this.proofClosed)return Promise.resolve(false);
    if(this.proofReaders<PROOF_HASH_READERS){this.proofReaders++;return Promise.resolve(true);}
    return new Promise((resolve,reject)=>{this.proofWaiters.add({resolve,reject,check});this.scheduleProofWaitCheck();});
  }
  private releaseProofReader(){const next=this.proofWaiters.values().next().value;if(next)this.proofWaiters.delete(next);this.scheduleProofWaitCheck();if(next&&!this.proofClosed)next.resolve(true);else{this.proofReaders--;next?.resolve(false);}}
  readonly staging: string;
  readonly objects: string;
  constructor(private root: string, private check: () => void, private barrier: Barrier, private quota?: string) {
    this.objects = join(root, 'objects'); privateDirectory(this.objects);
    this.objects = join(this.objects, 'sha256'); privateDirectory(this.objects);
    this.staging = join(root, 'staging'); privateDirectory(this.staging);
  }
  capacity(length: bigint): void {
    const stats = statfsSync(this.root, { bigint: true });
    const free = stats.bavail * stats.bsize; const total = stats.blocks * stats.bsize;
    const required = length + (length + 3n) / 4n;
    const reserved = this.reserved + [...this.external.values()].reduce((a,b)=>a+b,0n);
    const used = this.quota ? inspectTree(this.root) : 0n;
    if (free < reserved + required + MARGIN + EMERGENCY || (total - free) * 10n >= total * 9n ||
        (this.quota && (used * 10n >= BigInt(this.quota) * 9n || used + reserved + required + MARGIN + EMERGENCY > BigInt(this.quota)))) throw new StoreError('CAPACITY');
  }
  reserve(id: string, cost: bigint, enforce = true) {
    const previous=this.external.get(id);this.external.delete(id);
    try {if(enforce)this.capacity(cost);this.external.set(id,cost+(cost+3n)/4n);}
    catch(e){if(previous!==undefined)this.external.set(id,previous);throw e;}
  }
  unreserve(id: string) {this.external.delete(id);}
  acquire(id: string) {if(this.slots.has(id))return;if(this.stages.size+this.slots.size>=2)throw new StoreError('CAPACITY');this.slots.add(id);this.observedSlots.set(id,adapterResources.handle('objects','io-slot'));}
  release(id: string) {if(this.slots.delete(id)){this.observedSlots.get(id)?.();this.observedSlots.delete(id);this.available();}}
  reservationInventory() {let bytes=this.reserved;for(const value of this.external.values())bytes+=value;return {reservedBytes:String(bytes),activeTransfers:this.slots.size+this.stages.size};}
  begin(byteLength: string, mediaType: string, expectedHash?: string, metadata = false): string {
    this.check();
    assertComponents(this.staging); assertPrivate(this.staging, true);
    if (!isSeq(byteLength)) throw new StoreError('MALFORMED_REQUEST');
    validateBlob({ hash: expectedHash ?? `sha256:${'0'.repeat(64)}`, byteLength, mediaType });
    const length = BigInt(byteLength);
    if (metadata && length > 65536n) throw new StoreError('PAYLOAD_TOO_LARGE');
    if (this.stages.size + this.slots.size >= 2) throw new StoreError('CAPACITY');
    if (!metadata) this.capacity(length);
    const id = randomUUID(); const path = join(this.staging, id);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const reserved = metadata ? 0n : length + (length + 3n) / 4n;
    this.reserved += reserved;
    const releaseFD=adapterResources.handle('objects','stage-fd'),releaseHash=adapterResources.handle('objects','stage-hash');
    this.stages.set(id, { fd, path, length, received: 0n, hash: createHash('sha256'), mediaType, expectedHash, reserved, checkedAt: Date.now(),releaseFD,releaseHash });
    return id;
  }
  chunk(id: string, bytes: Uint8Array): void {
    this.check();
    assertComponents(this.staging);
    const stage = this.stages.get(id);
    if (!stage || bytes.byteLength > IO_CHUNK || stage.received + BigInt(bytes.byteLength) > stage.length) throw new StoreError('MALFORMED_REQUEST');
    assertPrivate(this.staging, true);
    if (!sameFile(fstatSync(stage.fd), assertPrivate(stage.path, false))) throw new StoreError('ROOT_UNSAFE');
    if (stage.reserved && Date.now() - stage.checkedAt >= 30_000) { this.capacity(0n); stage.checkedAt = Date.now(); }
    this.barrier('before-object-write');
    for (let offset = 0; offset < bytes.byteLength;) {
      const count = writeSync(stage.fd, bytes, offset, bytes.byteLength - offset);
      if (!count) throw new StoreError('STORAGE_FAILURE');
      offset += count;
    }
    stage.hash.update(bytes); stage.received += BigInt(bytes.byteLength);
  }
  finish(id: string): BlobRef {
    this.check(); const stage = this.stages.get(id);
    if (!stage || stage.received !== stage.length) throw new StoreError('MALFORMED_REQUEST');
    const hash = `sha256:${stage.hash.digest('hex')}`;
    stage.releaseHash();
    if (stage.expectedHash && hash !== stage.expectedHash) throw new StoreError('CORRUPT_OBJECT');
    const ref = { hash, byteLength: String(stage.length), mediaType: stage.mediaType };
    this.barrier('before-object-flush'); fsyncSync(stage.fd); this.barrier('after-object-flush');
    closeSync(stage.fd); stage.fd = -1;stage.releaseFD();
    assertComponents(this.objects); assertPrivate(this.objects, true);
    const target = this.path(ref); privateDirectory(join(this.objects, hash.slice(7, 9)));
    this.barrier('before-object-rename');
    try {
      lstatSync(target); this.verify(ref); unlinkSync(stage.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      renameSync(stage.path, target);
    }
    this.barrier('after-object-rename');
    syncDirectory(join(this.objects, hash.slice(7, 9))); syncDirectory(this.staging);
    this.barrier('after-object-directory-sync'); this.verify(ref);
    this.reserved -= stage.reserved; this.stages.delete(id);stage.releaseFD();stage.releaseHash();this.available();
    return ref;
  }
  abort(id: string): void {
    const stage = this.stages.get(id); if (!stage) return;
    if (stage.fd !== -1) closeSync(stage.fd);
    // Keep abandoned bytes for startup inventory; cleanup is a later explicit operation.
    this.reserved -= stage.reserved; this.stages.delete(id);stage.releaseFD();stage.releaseHash();this.available();
  }
  putMetadataInSlot(bytes:Uint8Array,slot:string):BlobRef {
    // A synchronous metadata write borrows its caller's existing IO permit.
    // No callback can admit another task until the permit is restored.
    if(!this.slots.delete(slot))throw new StoreError('CAPACITY');
    try{return this.putMetadata(bytes);}finally{this.slots.add(slot);}
  }
  /** Bounded ordinary JSON shares the caller's existing IO slot. It is not
   * emergency metadata: normal disk/quota admission and chunk limits apply. */
  putJSONInSlot(bytes:Uint8Array,slot:string):BlobRef {
    if(bytes.byteLength<1||bytes.byteLength>4*1024**2)throw new StoreError('PAYLOAD_TOO_LARGE');
    if(!this.slots.delete(slot))throw new StoreError('CAPACITY');
    let release=()=>{};
    try{release=adapterResources.buffer('objects','owned-json-write',bytes);const id=this.begin(String(bytes.byteLength),'application/json');
      try{for(let at=0;at<bytes.byteLength;at+=IO_CHUNK)this.chunk(id,bytes.subarray(at,at+IO_CHUNK));return this.finish(id);}finally{this.abort(id);}
    }finally{try{release();}finally{this.slots.add(slot);}}
  }
  putMetadata(bytes: Uint8Array): BlobRef {
    const release=adapterResources.buffer('objects','metadata-write',bytes);
    try{const id = this.begin(String(bytes.byteLength), 'application/json', undefined, true);
      try { this.chunk(id, bytes); return this.finish(id); } finally { this.abort(id); }
    }finally{release();}
  }
  path(ref: BlobRef): string { validateBlob(ref); return join(this.objects, ref.hash.slice(7, 9), ref.hash.slice(7)); }
  verify(ref: BlobRef, read = false): Uint8Array | undefined {
    return this.verifyObserved(ref,read,bytes=>adapterResources.retain('objects','verify-result',bytes));
  }
  /** A bounded verified read whose receiver owns the exact returned buffer. */
  verifyOwned(ref: BlobRef): {bytes: Uint8Array; release: () => void} {
    let release=()=>{};
    try{const bytes=this.verifyObserved(ref,true,bytes=>{release=adapterResources.buffer('objects','verify-owned-result',bytes);return bytes;})!;return {bytes,release};}
    catch(error){release();throw error;}
  }
  private verifyObserved(ref: BlobRef, read: boolean, observe: (bytes: Buffer) => Buffer): Uint8Array | undefined {
    this.check(); validateBlob(ref);
    if (read && BigInt(ref.byteLength) > 65536n) throw new StoreError('PAYLOAD_TOO_LARGE');
    let fd: number;
    try {
      assertComponents(this.objects);
      assertPrivate(this.objects, true); assertPrivate(join(this.objects, ref.hash.slice(7, 9)), true);
      const identity = assertPrivate(this.path(ref), false);
      fd = openSync(this.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!sameFile(identity, fstatSync(fd))) { closeSync(fd); throw new StoreError('ROOT_UNSAFE'); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StoreError('MISSING_OBJECT');
      throw error;
    }
    const releaseFD=adapterResources.handle('objects','verify-fd'),releases=[adapterResources.handle('objects','verify-hash')];
    try {
      const expected = BigInt(ref.byteLength), hash = createHash('sha256'); const chunk = Buffer.alloc(Number(expected < BigInt(IO_CHUNK) ? expected + 1n : BigInt(IO_CHUNK)));releases.push(adapterResources.buffer('objects','verify-buffer',chunk)); let length = 0n;
      const parts: Buffer[] = [];
      for (;;) {
        const n = readSync(fd, chunk); if (!n) break;
        length += BigInt(n); hash.update(chunk.subarray(0, n));
        if (length > BigInt(ref.byteLength)) throw new StoreError('CORRUPT_OBJECT');
        if (read) {const part=Buffer.from(chunk.subarray(0, n));releases.push(adapterResources.buffer('objects','verify-part',part));parts.push(part);}
      }
      if (length !== BigInt(ref.byteLength) || `sha256:${hash.digest('hex')}` !== ref.hash) throw new StoreError('CORRUPT_OBJECT');
      return read ? observe(Buffer.concat(parts)) : undefined;
    } finally {try{closeSync(fd);releaseFD();}finally{for(const release of releases)release();} }
  }
  readRange(ref: BlobRef, offset: string, length: number): Uint8Array {
    return this.readRangeObserved(ref,offset,length,bytes=>adapterResources.retain('objects','range-result',bytes));
  }
  readRangeOwned(ref:BlobRef,offset:string,length:number):{bytes:Uint8Array;release:()=>void}{
    let release=()=>{};
    try{const bytes=this.readRangeObserved(ref,offset,length,bytes=>{release=adapterResources.buffer('objects','range-owned',bytes);return bytes;});return {bytes,release};}
    catch(error){release();throw error;}
  }
  private readRangeObserved(ref: BlobRef, offset: string, length: number,observe:(bytes:Buffer)=>Buffer): Uint8Array {
    this.check(); validateBlob(ref);
    if (!isSeq(offset) || !Number.isSafeInteger(length) || length < 0 || length > IO_CHUNK ||
        BigInt(offset) + BigInt(length) > BigInt(ref.byteLength)) throw new StoreError('MALFORMED_REQUEST');
    assertComponents(this.objects); assertPrivate(this.objects, true);
    assertPrivate(join(this.objects, ref.hash.slice(7, 9)), true);
    const identity = assertPrivate(this.path(ref), false);
    const fd = openSync(this.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
    const releaseFD=adapterResources.handle('objects','range-fd');
    try {
      if (!sameFile(identity, fstatSync(fd)) || BigInt(identity.size) !== BigInt(ref.byteLength)) throw new StoreError('CORRUPT_OBJECT');
      const bytes = observe(Buffer.alloc(length)); let read = 0;
      while (read < length) {
        const n = readSync(fd, bytes, read, length - read, BigInt(offset) + BigInt(read));
        if (!n) throw new StoreError('CORRUPT_OBJECT'); read += n;
      }
      return bytes;
    } finally {closeSync(fd);releaseFD();}
  }
  private stamp(ref:BlobRef) {
    const path=this.path(ref);assertComponents(this.objects);assertPrivate(this.objects,true);assertPrivate(join(this.objects,ref.hash.slice(7,9)),true);
    const s=assertPrivate(path,false);return JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);
  }
  async prove(ref:BlobRef,check:()=>void):Promise<string> {
    this.check();validateBlob(ref);if(this.proofClosed)throw new StoreError('CLOSED');
    if(ref.byteLength.length>20||this.proofReservations.size>=PROOF_LIMIT)throw new StoreError('CAPACITY');
    // Reserve before the first await, and snapshot caller-owned metadata before
    // hashing. Concurrent calls cannot oversubscribe or mutate the later proof.
    const value=Object.freeze({...ref}),token=randomUUID();this.proofReservations.add(token);
    this.observedProofs.set(token,adapterResources.reservation('objects','proof-metadata-lease',PROOF_METADATA_BYTES));
    let fd:number|undefined,reader=false,retained=false,releaseFD:(()=>void)|undefined;
    const releases:(()=>void)[]=[];
    const guard=()=>{this.check();if(this.proofClosed)throw new StoreError('CLOSED');check();};
    try{guard();reader=await this.proofReader(guard);if(!reader)throw new StoreError('CLOSED');releases.push(adapterResources.handle('objects','proof-reader'));guard();const stamp=this.stamp(value),path=this.path(value);
      fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      releaseFD=adapterResources.handle('objects','proof-fd');
      if(!sameFile(fstatSync(fd),assertPrivate(path,false)))throw new StoreError('ROOT_UNSAFE');
      const expected=BigInt(value.byteLength),hash=createHash('sha256');const buffer=Buffer.alloc(Number(expected<BigInt(IO_CHUNK)?expected+1n:BigInt(IO_CHUNK)));let length=0n;
      releases.push(adapterResources.handle('objects','proof-hash'),adapterResources.buffer('objects','proof-buffer',buffer));
      for(;;){guard();const n=readSync(fd,buffer);if(!n)break;length+=BigInt(n);if(length>BigInt(value.byteLength))throw new StoreError('CORRUPT_OBJECT');hash.update(buffer.subarray(0,n));await new Promise<void>(r=>setImmediate(r));}
      if(length!==BigInt(value.byteLength)||'sha256:'+hash.digest('hex')!==value.hash||this.stamp(value)!==stamp)throw new StoreError('CORRUPT_OBJECT');
      this.proofs.set(token,{ref:value,stamp});retained=true;return token;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new StoreError('MISSING_OBJECT');throw error;}
    finally{try{if(fd!==undefined){closeSync(fd);releaseFD?.();}}finally{for(const release of releases)release();if(reader)this.releaseProofReader();if(!retained){this.proofReservations.delete(token);this.observedProofs.get(token)?.();this.observedProofs.delete(token);this.available();}}}
  }
  proven(ref:BlobRef,token:string){this.check();const proof=this.proofs.get(token);if(!proof||proof.ref.hash!==ref.hash||proof.ref.byteLength!==ref.byteLength||proof.ref.mediaType!==ref.mediaType||this.stamp(ref)!==proof.stamp)throw new StoreError('CORRUPT_OBJECT');}
  releaseProof(token:string){if(this.proofs.delete(token)){this.proofReservations.delete(token);this.observedProofs.get(token)?.();this.observedProofs.delete(token);this.available();}}
  private repairStamp(path:string,fd:number):string {
    assertComponents(dirname(path));assertPrivate(dirname(path),true);assertPrivate(path,false);
    const named=lstatSync(path,{bigint:true}),held=fstatSync(fd,{bigint:true});
    const stamp=(s:typeof named)=>JSON.stringify([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink,s.uid,s.gid].map(String));
    if(stamp(named)!==stamp(held))throw new StoreError('ROOT_UNSAFE');
    return stamp(named);
  }
  private repairAbsent(ref:BlobRef){
    assertComponents(this.objects);assertPrivate(this.objects,true);const path=this.path(ref);
    try{assertPrivate(dirname(path),true);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    try{lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    throw new StoreError('CORRUPT_OBJECT');
  }
  private async readRepairTarget(ref:BlobRef,check:()=>void):Promise<HeldRepair>{
    validateBlob(ref);if(this.repairReads>=2||this.proofClosed)throw new StoreError(this.proofClosed?'CLOSED':'CAPACITY');
    const value=Object.freeze({...ref}),releaseObserved=adapterResources.uncovered('objects-repair');this.repairReads++;let fd:number|undefined,retained=false;
    const guard=()=>{this.check();if(this.proofClosed)throw new StoreError('CLOSED');check();};
    try{
      guard();const path=this.path(value);assertComponents(this.objects);assertPrivate(this.objects,true);
      try{assertPrivate(dirname(path),true);assertPrivate(path,false);fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;this.repairAbsent(value);retained=true;return {ref:value,condition:'missing',identity:'sha256:'+createHash('sha256').update(JSON.stringify([value,'missing'])).digest('hex'),releaseObserved};}
      const stamp=this.repairStamp(path,fd),length=fstatSync(fd,{bigint:true}).size;let actual='length-mismatch';
      if(length===BigInt(value.byteLength)){
        const hash=createHash('sha256'),buffer=Buffer.alloc(Number(length<BigInt(IO_CHUNK)?length+1n:BigInt(IO_CHUNK)));let at=0n;
        for(;;){guard();const n=readSync(fd,buffer);if(!n)break;at+=BigInt(n);if(at>length)throw new StoreError('CORRUPT_OBJECT');hash.update(buffer.subarray(0,n));await new Promise<void>(r=>setImmediate(r));}
        if(at!==length)throw new StoreError('CORRUPT_OBJECT');actual='sha256:'+hash.digest('hex');
      }
      guard();if(this.repairStamp(path,fd)!==stamp)throw new StoreError('CORRUPT_OBJECT');
      const result:HeldRepair={ref:value,condition:actual===value.hash?'available':'corrupt',identity:'sha256:'+createHash('sha256').update(JSON.stringify([value,stamp,actual])).digest('hex'),fd,stamp,releaseObserved};
      retained=true;return result;
    }finally{this.repairReads--;try{if(fd!==undefined&&!retained)closeSync(fd);if(!retained)releaseObserved();}finally{this.available();}}
  }
  /** Observes actual bytes with bounded buffers; does not authorize a write. */
  async inspectRepair(ref:BlobRef,check:()=>void):Promise<RepairTarget>{
    const result=await this.readRepairTarget(ref,check);
    try{return {condition:result.condition,identity:result.identity};}finally{if(result.fd!==undefined)closeSync(result.fd);result.releaseObserved();}
  }
  private repairIdle(token?:string,stageId?:string){
    if(this.slots.size||this.proofReservations.size||this.repairReads||[...this.stages.keys()].some(id=>id!==stageId)||[...this.repairs.keys()].some(id=>id!==token))throw new StoreError('CAPACITY');
  }
  /** Holds only an absent target or a fully observed private inode. Other owned
   * read/worker leases must drain; no caller can provide a filesystem path. */
  async beginRepair(ref:BlobRef,expected:RepairTarget,check:()=>void):Promise<string>{
    this.repairIdle();check();const result=await this.readRepairTarget(ref,check);let retained=false;
    try{
      this.repairIdle();check();
      // An ambiguous prior success can be retried only after a fresh full proof
      // that the exact original bytes are already present. Never overwrite them.
      if(result.condition!=='available'&&(result.condition!==expected.condition||result.identity!==expected.identity))throw new StoreError('CORRUPT_OBJECT');
      const token=randomUUID();this.repairs.set(token,result);retained=true;return token;
    }finally{if(!retained){if(result.fd!==undefined)closeSync(result.fd);result.releaseObserved();}}
  }
  private repairGuard(token:string,stageId:string,check:()=>void):HeldRepair{
    this.check();if(this.proofClosed)throw new StoreError('CLOSED');check();this.repairIdle(token,stageId);
    const target=this.repairs.get(token);if(!target||target.published||!this.stages.has(stageId))throw new StoreError('CORRUPT_OBJECT');
    if(target.condition==='missing')this.repairAbsent(target.ref);
    else if(target.fd===undefined||this.repairStamp(this.path(target.ref),target.fd)!==target.stamp)throw new StoreError('CORRUPT_OBJECT');
    return target;
  }
  /** Proves the actual temporary file, not merely the chunks supplied by JS. */
  async prepareRepair(stageId:string,token:string,check:()=>void):Promise<void>{
    const target=this.repairGuard(token,stageId,check),stage=this.stages.get(stageId)!;
    if(stage.received!==stage.length||String(stage.length)!==target.ref.byteLength||stage.mediaType!==target.ref.mediaType||stage.expectedHash!==target.ref.hash)throw new StoreError('CORRUPT_OBJECT');
    fsyncSync(stage.fd);const stamp=this.repairStamp(stage.path,stage.fd),hash=createHash('sha256');
    const buffer=Buffer.alloc(Number(stage.length<BigInt(IO_CHUNK)?stage.length+1n:BigInt(IO_CHUNK)));let at=0n;
    for(;;){this.repairGuard(token,stageId,check);const n=readSync(stage.fd,buffer,0,buffer.length,at);if(!n)break;at+=BigInt(n);if(at>stage.length)throw new StoreError('CORRUPT_OBJECT');hash.update(buffer.subarray(0,n));await new Promise<void>(r=>setImmediate(r));}
    this.repairGuard(token,stageId,check);
    if(at!==stage.length||'sha256:'+hash.digest('hex')!==target.ref.hash||this.repairStamp(stage.path,stage.fd)!==stamp)throw new StoreError('CORRUPT_OBJECT');
    target.prepared={stageId,stamp};
  }
  /** Atomic publication after all scope checks. The root's sole writer plus
   * held inode/stamp checks are the authority; this is not a general OS CAS. */
  finishRepair(stageId:string,token:string,check:()=>void):{ref:BlobRef;previousCondition:RepairTarget['condition']}{
    const target=this.repairGuard(token,stageId,check),stage=this.stages.get(stageId)!;
    if(target.prepared?.stageId!==stageId||this.repairStamp(stage.path,stage.fd)!==target.prepared.stamp||'sha256:'+stage.hash.digest('hex')!==target.ref.hash)throw new StoreError('CORRUPT_OBJECT');
    stage.releaseHash();const destination=this.path(target.ref);privateDirectory(dirname(destination));
    this.barrier('repair-before-publish');this.repairGuard(token,stageId,check);
    if(this.repairStamp(stage.path,stage.fd)!==target.prepared.stamp)throw new StoreError('CORRUPT_OBJECT');
    if(target.condition==='available'){
      // Only this operation's independently proved duplicate temporary is removed.
      fsyncSync(target.fd!);unlinkSync(stage.path);
    }else renameSync(stage.path,destination);
    this.barrier('repair-after-publish');
    syncDirectory(dirname(destination));syncDirectory(this.staging);this.barrier('repair-after-directory-sync');
    const fd=target.condition==='available'?target.fd!:stage.fd;
    target.published=this.repairStamp(destination,fd);
    closeSync(stage.fd);stage.fd=-1;stage.releaseFD();this.reserved-=stage.reserved;this.stages.delete(stageId);this.available();
    return {ref:{...target.ref},previousCondition:target.condition};
  }
  repairProven(ref:BlobRef,token:string){
    this.check();const target=this.repairs.get(token);if(!target?.published||ref.hash!==target.ref.hash||ref.byteLength!==target.ref.byteLength||ref.mediaType!==target.ref.mediaType)throw new StoreError('CORRUPT_OBJECT');
    const fd=openSync(this.path(ref),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{if(this.repairStamp(this.path(ref),fd)!==target.published)throw new StoreError('CORRUPT_OBJECT');}finally{closeSync(fd);}
  }
  releaseRepair(token:string){const target=this.repairs.get(token);if(!target)return;this.repairs.delete(token);try{if(target.fd!==undefined)closeSync(target.fd);target.releaseObserved();}finally{this.available();}}
  // Internal raster output only. The sole writer checks private same-filesystem
  // bytes, flushes and renames, then cooperatively proves the immutable target.
  async adoptFile(path:string,ref:BlobRef,check:()=>void):Promise<string>{
    this.check();validateBlob(ref);assertComponents(dirname(path));const identity=assertPrivate(path,false);
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!sameFile(identity,fstatSync(fd))||String(identity.size)!==ref.byteLength)throw new StoreError('CORRUPT_OBJECT');this.barrier('raster-before-flush');fsyncSync(fd);this.barrier('raster-after-flush');}finally{closeSync(fd);}
    const target=this.path(ref);privateDirectory(dirname(target));
    this.barrier('raster-before-rename');
    try{lstatSync(target);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;renameSync(path,target);}
    this.barrier('raster-after-rename');syncDirectory(dirname(target));syncDirectory(dirname(path));this.barrier('raster-after-directory-sync');
    return this.prove(ref,check);
  }
  /** Diagnostic-only scalar walk: never materializes directory listings, orphan
   * names or a registered hash set. Each opened native directory closes even on
   * validation/lookup failure. Existing inventory callers keep their contract. */
  diagnosticInventory(registered:(hash:string)=>boolean){
    let orphanCount=0n,stagingCount=0n;
    withDiagnosticDirectory(this.objects,shards=>{for(let shard=shards.readSync();shard;shard=shards.readSync()){
      const path=join(this.objects,shard.name);assertPrivate(path,true);
      withDiagnosticDirectory(path,names=>{for(let entry=names.readSync();entry;entry=names.readSync()){assertPrivate(join(path,entry.name),false);if(!registered('sha256:'+entry.name))orphanCount++;}});
    }});
    withDiagnosticDirectory(this.staging,staging=>{while(staging.readSync())stagingCount++;});
    return {orphanCount:String(orphanCount),stagingCount:String(stagingCount)};
  }
  inventory(registered: Set<string>) {
    const orphans: string[] = [];
    for (const shard of readdirSync(this.objects)) {
      assertPrivate(join(this.objects, shard), true);
      for (const name of readdirSync(join(this.objects, shard))) {
        assertPrivate(join(this.objects, shard, name), false);
        if (!registered.has(`sha256:${name}`)) orphans.push(name);
      }
    }
    return { orphanCount: String(orphans.length), stagingCount: String(readdirSync(this.staging).length) };
  }
  close() {closeDiagnosticDirectories();this.proofClosed=true;for(const waiting of this.proofWaiters)waiting.resolve(false);this.proofWaiters.clear();this.scheduleProofWaitCheck();for(const token of this.proofs.keys()){this.proofReservations.delete(token);this.observedProofs.get(token)?.();this.observedProofs.delete(token);}this.proofs.clear();for (const id of this.stages.keys()) this.abort(id);for(const token of this.repairs.keys())this.releaseRepair(token);}
}

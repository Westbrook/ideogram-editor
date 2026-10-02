import {CURRENT_PROJECTION_SCHEMA,supportsProjectionSchema,projectionEntity} from '../../src/protocol/projection-schema.js';
import { createHash, randomUUID } from 'node:crypto';
import {serverPhases} from '../observability/phases.js';
import type {PhaseSpan,PhaseContext} from '../../src/observability/phases.js';
import { DatabaseSync } from 'node:sqlite';
import type { BlobRef, DomainEvent } from '../../src/protocol/store.js';
import { canonical, isSeq, isId } from './canonical.js';
import type { Objects } from './objects.js';
import { entity as validateEntity } from '../../src/protocol/validate.js';
import { StoreError } from './errors.js';
import { assertComponents, assertPrivate } from './files.js';
import { dirname } from 'node:path';
import { IO_CHUNK } from './objects.js';
import type { Barrier } from './objects.js';
import { namespaceDigest } from './portable.js';
import {adapterResources} from '../observability/adapter-resources.js';

export type StoredContent = { handle: string; blob: BlobRef; encoding: 'lp1-json' | 'lp1-events-jsonl' | 'lp1-snapshot-jsonl' | 'lp1-namespace-jsonl'; recordCount: string };
export type StoredSnapshot = { id: string; seq: string; content: Omit<StoredContent, 'handle'> };
const order = 'ORDER BY length(seq),seq';
export class RecoveryStore {
  resourceOwnership(){return {readers:this.handles.size,maintenance:!!this.maintenance,maintenanceReaders:this.maintenanceReaders};}
  private handles = new Map<string, BlobRef>();
  private readerCoverage = new Map<string, ()=>void>();
  private verified: { snapshot: StoredSnapshot | null; stamp: string; dataVersion: unknown } | undefined;
  private maintenance: Promise<void> | undefined;
  private maintenanceReaders=0;
  snapshotBuildMs = 0;
  snapshotSliceMaxMs = 0;
  snapshotActivationMs = 0;
  snapshotFailure = false;
  constructor(private db: DatabaseSync, private objects: Objects, private path: string, private barrier: Barrier, private check: () => void) {}
  hasReaders(){return this.handles.size>0||!!this.maintenance;}
  highWater() { return String(this.db.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value); }
  private *entities(db = this.db) {
    for (const [type, table] of [['asset','assets'], ['checkpoint','checkpoints'], ['document','documents'], ['history','history']]) {
      for (const row of db.prepare(`SELECT id,json FROM ${table} ORDER BY id`).iterate()) {
        const text = String(row.json); const value = JSON.parse(text);
        yield { type, id: String(row.id), version: type==='asset'?value.version:type === 'document' ? value.revision : type === 'checkpoint' ? value.documentRevision : (value.kind==='image-edit'?value.revision:value.forward.after.revision), text };
      }
    }
  }
  private *snapshotRows(id: string, seq: string, db = this.db): Generator<Buffer> {
    const count = db.prepare('SELECT (SELECT count(*) FROM assets)+(SELECT count(*) FROM documents)+(SELECT count(*) FROM history)+(SELECT count(*) FROM checkpoints) AS n').get()!.n;
    yield Buffer.from(canonical({ kind: 'header', snapshotId: id, snapshotSeq: seq, projectionSchema: CURRENT_PROJECTION_SCHEMA, entityCount: String(count) }) + '\n');
    for (const entity of this.entities(db)) {
      // Current narrow projections are individually bounded by the event budget.
      // The wire remains part-based so consumers do not depend on that bound.
      const bytes = Buffer.from(entity.text); const chunks: Buffer[] = [];
      for (let start = 0; start < bytes.length;) {
        let end = Math.min(start + 8192, bytes.length);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        chunks.push(bytes.subarray(start, end)); start = end;
      }
      for (let i = 0; i < chunks.length; i++) {
        const row = Buffer.from(canonical({ kind: 'projection-part', entityType: entity.type, entityId: entity.id,
          entityVersion: entity.version, partIndex: i, partCount: chunks.length, utf8Base64: chunks[i].toString('base64') }) + '\n');
        if (row.length > 16384) throw new StoreError('PAYLOAD_TOO_LARGE'); yield row;
      }
    }
  }
  private storeRows(rows: () => Iterable<Buffer>, encoding: StoredContent['encoding']): Omit<StoredContent, 'handle'> {
    const releaseCoverage=adapterResources.uncovered('recovery-content-build');try{
    let length = 0n; let count = 0n;
    for (const bytes of rows()) { length += BigInt(bytes.length); count++; }
    const id = this.objects.begin(String(length), encoding === 'lp1-json' ? 'application/json' : 'application/x-ndjson');
    try {
      for (const bytes of rows()) this.objects.chunk(id, bytes);
      return { blob: this.objects.finish(id), encoding, recordCount: String(count) };
    } finally { this.objects.abort(id); }
    }finally{releaseCoverage();}
  }
  private projectionHash(): string {
    const hash = createHash('sha256'); for (const e of this.entities()) hash.update(canonical({ type: e.type, id: e.id, version: e.version, text: e.text }) + '\n');
    return hash.digest('hex');
  }
  private rootsHash(snapshotId?: string): string {
    const hash = createHash('sha256');
    for (const row of (snapshotId ? this.db.prepare('SELECT owner,hash,media_type FROM snapshot_roots WHERE snapshot_id=? ORDER BY owner,hash').iterate(snapshotId) : this.db.prepare('SELECT * FROM roots ORDER BY owner,hash').iterate())) hash.update(canonical(row) + '\n');
    return hash.digest('hex');
  }
  maintain(): void {
    if (this.maintenance || BigInt(this.highWater())-BigInt(this.latest(true)?.seq??'0')<250n) return;
    const phase=serverPhases.start('document.snapshot');
    const releaseCoverage=adapterResources.uncovered('recovery-maintenance');
    let read: DatabaseSync | undefined;
    const observedClosed=()=>{if(read){read=undefined;this.maintenanceReaders--;}};
    const closeRead=()=>{if(read){read.close();observedClosed();}releaseCoverage();};
    try {
      this.check();assertPrivate(this.path,false);
      // Pin B before yielding. Only this worker writes; this connection retains
      // an immutable WAL read view while later commands update the live writer.
      read=new DatabaseSync(this.path,{readOnly:true,allowExtension:false,timeout:250});this.maintenanceReaders++;
      read.exec('PRAGMA trusted_schema=OFF; BEGIN');
      const seq=String(read.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value);
      const steps=this.buildSnapshot(read,seq,phase,observedClosed);
      const started=performance.now();this.snapshotSliceMaxMs=0;
      this.maintenance=new Promise<void>(resolve=>{
        const run=()=>{
          const start=performance.now();
          try {
            this.check();
            let count=0;
            do {if(steps.next().done){this.snapshotBuildMs=performance.now()-started;this.snapshotFailure=false;this.maintenance=undefined;closeRead();resolve();return;}}
            while(++count<32&&performance.now()-start<2);
            setImmediate(run);
          } catch {phase.end('error');try {steps.return(undefined);} catch {} try {closeRead();} catch {} this.snapshotFailure=true;this.maintenance=undefined;resolve();}
          finally {this.snapshotSliceMaxMs=Math.max(this.snapshotSliceMaxMs,performance.now()-start);}
        };
        setImmediate(run);
      });
    } catch {phase.end('error');try {closeRead();} catch {} this.snapshotFailure=true;}
  }
  async settle(start = false) {if(start)this.maintain();await this.maintenance;}
  needsSnapshot() {return BigInt(this.highWater())-BigInt(this.latest(true)?.seq??'0')>=500n;}
  private *buildSnapshot(read: DatabaseSync, seq: string,phase:PhaseSpan,observedClosed:()=>void): Generator<void> {
    const id=randomUUID();let stage: string|undefined,completed:PhaseContext|undefined;
    try {
      let length=0n;let count=0n;
      for(const row of this.snapshotRows(id,seq,read)){length+=BigInt(row.length);count++;yield;}
      stage=this.objects.begin(String(length),'application/x-ndjson');
      const buffer=Buffer.alloc(IO_CHUNK);let used=0;
      for(const row of this.snapshotRows(id,seq,read)){
        if(used+row.length>buffer.length){this.objects.chunk(stage,buffer.subarray(0,used));used=0;}
        row.copy(buffer,used);used+=row.length;yield;
      }
      if(used)this.objects.chunk(stage,buffer.subarray(0,used));
      const content={blob:this.objects.finish(stage),encoding:'lp1-snapshot-jsonl' as const,recordCount:String(count)};
      stage=undefined;yield;
      const projection=createHash('sha256');
      for(const e of this.entities(read)){projection.update(canonical({type:e.type,id:e.id,version:e.version,text:e.text})+'\n');yield;}
      const roots=createHash('sha256');
      for(const row of read.prepare('SELECT * FROM roots ORDER BY owner,hash').iterate()){roots.update(canonical(row)+'\n');yield;}
      const snapshot={id,seq,content};
      this.barrier('snapshot-before-register');const activationStart=performance.now();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?)').run(content.blob.hash,content.blob.byteLength);
        if (this.db.prepare('SELECT byte_length FROM objects WHERE hash=?').get(content.blob.hash)!.byte_length !== content.blob.byteLength) throw new StoreError('CORRUPT_OBJECT');
        this.db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?)').run(id, seq, canonical(snapshot), projection.digest('hex'), roots.digest('hex'));
        const insert=this.db.prepare('INSERT INTO snapshot_roots VALUES (?,?,?,?)');
        for(const row of read.prepare('SELECT * FROM roots ORDER BY owner,hash').iterate())insert.run(id,row.owner,row.hash,row.media_type);
        this.db.exec('COMMIT');
        this.snapshotActivationMs=performance.now()-activationStart;
      } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
      this.remember(snapshot);
      completed={snapshotId:id,workspaceSeq:seq,assetHash:content.blob.hash,bytes:Number(content.blob.byteLength),boundary:'authority-durable'};
    } finally {if(stage)this.objects.abort(stage);read.close();observedClosed();if(completed)phase.end('ok',completed);}
  }
  private stamp(item: StoredSnapshot | null): string {
    if (!item) return '';
    const path=this.objects.path(item.content.blob);assertComponents(dirname(path));
    const stat=assertPrivate(path,false);
    return JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]);
  }
  private remember(snapshot: StoredSnapshot | null) {
    this.verified={snapshot,stamp:this.stamp(snapshot),dataVersion:this.db.prepare('PRAGMA data_version').get()!.data_version};
  }
  latest(admission = false): StoredSnapshot | null {
    // Admission reuses the last verified immutable snapshot while its file and
    // database identities are unchanged. Every recovery/content read still
    // verifies all bytes, roots and projections; external changes invalidate it.
    if (admission && this.verified) {
      try {
        if (this.verified.dataVersion===this.db.prepare('PRAGMA data_version').get()!.data_version && this.verified.stamp===this.stamp(this.verified.snapshot)) return this.verified.snapshot;
      } catch { /* Missing/changed bytes require the normal verified fallback. */ }
    }
    // Invalid latest snapshots never invalidate retained events or the prior copy.
    for (const row of this.db.prepare('SELECT descriptor FROM snapshots ORDER BY length(seq) DESC,seq DESC').iterate()) {
      try { const item = JSON.parse(String(row.descriptor)) as StoredSnapshot; this.objects.verify(item.content.blob); this.validateSnapshot(item); this.remember(item); return item; }
      catch (e) { if (e instanceof SyntaxError || e instanceof TypeError) continue; if (!(e instanceof StoreError) || !['CORRUPT_OBJECT','MISSING_OBJECT','CORRUPT_STORE','MALFORMED_REQUEST','PAYLOAD_TOO_LARGE'].includes(e.code)) throw e; }
    }
    this.remember(null); return null;
  }
  private *lines(ref: BlobRef): Generator<Record<string, any>> {
    const releaseCoverage=adapterResources.uncovered('recovery-snapshot-lines');try{
    let pending = Buffer.alloc(0); let offset = 0n;
    while (offset < BigInt(ref.byteLength)) {
      const n = Number(BigInt(ref.byteLength) - offset > 32768n ? 32768n : BigInt(ref.byteLength) - offset);
      pending = Buffer.concat([pending, this.objects.readRange(ref, String(offset), n)]); offset += BigInt(n);
      let at: number;
      while ((at = pending.indexOf(10)) !== -1) {
        if (at + 1 > 16384) throw new StoreError('CORRUPT_STORE');
        const bytes = pending.subarray(0, at); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const row = JSON.parse(text); if (canonical(row) !== text) throw new StoreError('CORRUPT_STORE');
        yield row; pending = pending.subarray(at + 1);
      }
      if (pending.length > 16384) throw new StoreError('CORRUPT_STORE');
    }
    if (pending.length) throw new StoreError('CORRUPT_STORE');
    }finally{releaseCoverage();}
  }
  validateSnapshot(item: StoredSnapshot, apply?: (type: string, id: string, text: string) => void) {
    const releaseCoverage=adapterResources.uncovered('recovery-snapshot-validation');try{
    if (!isId(item.id) || !isSeq(item.seq) || item.content.encoding !== 'lp1-snapshot-jsonl' || item.content.blob.mediaType !== 'application/x-ndjson' || !isSeq(item.content.recordCount)) throw new StoreError('CORRUPT_STORE');
    if (this.rootsHash(item.id) !== this.db.prepare('SELECT roots_hash FROM snapshots WHERE id=?').get(item.id)?.roots_hash) throw new StoreError('CORRUPT_STORE');
    const projectionHash = createHash('sha256');
    let projectionSchema=0; let rows = 0n; let entities = 0n; let expected = ''; let key = ''; let previousKey = ''; let part = 0; let parts = 0; let text = ''; let version = '';
    for (const row of this.lines(item.content.blob)) {
      if (rows++ === 0n) {
        if (row.kind !== 'header' || row.snapshotId !== item.id || row.snapshotSeq !== item.seq || !supportsProjectionSchema(row.projectionSchema) || !isSeq(row.entityCount)) throw new StoreError('CORRUPT_STORE');
        projectionSchema=row.projectionSchema; expected = row.entityCount; continue;
      }
      if (row.kind !== 'projection-part' || !['asset','document','history','checkpoint'].includes(row.entityType) || !isId(row.entityId) || !isSeq(row.entityVersion) ||
          !Number.isSafeInteger(row.partCount) || row.partCount < 1 || !Number.isSafeInteger(row.partIndex)) throw new StoreError('CORRUPT_STORE');
      const nextKey = row.entityType + ':' + row.entityId;
      if (!part) { if (nextKey <= previousKey) throw new StoreError('CORRUPT_STORE'); key = nextKey; parts = row.partCount; version = row.entityVersion; }
      if (key !== nextKey || parts !== row.partCount || row.partIndex !== part || version !== row.entityVersion) throw new StoreError('CORRUPT_STORE');
      const bytes = Buffer.from(row.utf8Base64, 'base64');
      if (bytes.toString('base64') !== row.utf8Base64) throw new StoreError('CORRUPT_STORE');
      text += new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (Buffer.byteLength(text) > 65536) throw new StoreError('CORRUPT_STORE');
      if (++part === parts) {
        const value = JSON.parse(text);
        if (canonical(value) !== text || value.id !== row.entityId) throw new StoreError('CORRUPT_STORE');
        const actualVersion = row.entityType==='asset'?value.version:row.entityType === 'document' ? value.revision : row.entityType === 'checkpoint' ? value.documentRevision : (value.kind==='image-edit'?value.revision:value.forward?.after?.revision);
        try { projectionEntity(projectionSchema,row.entityType,value); } catch { throw new StoreError('CORRUPT_STORE'); }
        projectionHash.update(canonical({ type: row.entityType, id: row.entityId, version, text }) + '\n');
        if (version !== actualVersion) throw new StoreError('CORRUPT_STORE');
        apply?.(row.entityType, row.entityId, text); entities++; previousKey = key; text = ''; part = 0;
      }
    }
    if (part || String(entities) !== expected || String(rows) !== item.content.recordCount || projectionHash.digest('hex') !== this.db.prepare('SELECT projection_hash FROM snapshots WHERE id=?').get(item.id)?.projection_hash) throw new StoreError('CORRUPT_STORE');
    }finally{releaseCoverage();}
  }
  restore(item: StoredSnapshot) {
    // Caller owns rollback transaction. Insert documents first to honor FKs.
    for (const type of ['asset','document','history','checkpoint']) this.validateSnapshot(item, (kind,id,text) => {
      if (kind !== type) return; const value = JSON.parse(text);
      if (kind==='asset') {this.db.prepare('INSERT INTO assets VALUES (?,?)').run(id,text);for(const ref of [value.blob,...value.dependencies])this.db.prepare('INSERT OR IGNORE INTO asset_dependencies VALUES (?,?)').run(id,ref.hash);}
      else if (kind === 'document') this.db.prepare('INSERT INTO documents VALUES (?,?)').run(id,text);
      else this.db.prepare(`INSERT INTO ${kind === 'history' ? 'history' : 'checkpoints'} VALUES (?,?,?)`).run(id,value.documentId,text);
    });
    const expected = this.db.prepare('SELECT projection_hash FROM snapshots WHERE id=?').get(item.id)!;
    if (this.projectionHash() !== expected.projection_hash) throw new StoreError('CORRUPT_STORE');
  }
  snapshotKnown(id: string) { if (!isId(id)) throw new StoreError('MALFORMED_REQUEST'); return !!this.db.prepare('SELECT id FROM snapshots WHERE id=?').get(id); }
  getSnapshot(id: string): StoredSnapshot | null {
    if (!isId(id)) throw new StoreError('MALFORMED_REQUEST');
    const row = this.db.prepare('SELECT descriptor FROM snapshots WHERE id=?').get(id);
    if (!row) return null;
    const item = JSON.parse(String(row.descriptor)) as StoredSnapshot;
    this.objects.verify(item.content.blob); this.validateSnapshot(item); return item;
  }
  capture() { return { highWater: this.highWater(), snapshot: this.latest() }; }
  boundary(after: string, highWater: string) {
    if (!isSeq(after) || !isSeq(highWater) || BigInt(after) > BigInt(highWater) || BigInt(highWater) > BigInt(this.highWater())) throw new StoreError('MALFORMED_REQUEST');
    if (after === '0') return null;
    const event = this.db.prepare('SELECT command_id FROM events_v2 WHERE seq=?').get(after);
    if (!event) throw new StoreError('CORRUPT_STORE');
    const receipt = JSON.parse(String(this.db.prepare('SELECT receipt FROM commands WHERE id=?').get(event.command_id!)!.receipt));
    return receipt.toSeq === after ? null : { fromSeq: receipt.fromSeq as string, toSeq: receipt.toSeq as string };
  }
  batch(after: string, highWater: string) {
    if (this.boundary(after, highWater)) throw new StoreError('MALFORMED_REQUEST');
    const row = this.db.prepare(`SELECT command_id FROM events_v2 WHERE length(seq)>length(?) OR (length(seq)=length(?) AND seq>?) ${order} LIMIT 1`).get(after,after,after);
    if (!row || after === highWater) return null;
    const receipt = JSON.parse(String(this.db.prepare('SELECT receipt FROM commands WHERE id=?').get(row.command_id!)!.receipt));
    if (BigInt(receipt.toSeq) > BigInt(highWater)) throw new StoreError('CORRUPT_STORE');
    const rows = () => this.db.prepare(`SELECT json FROM events_v2 WHERE transaction_id=? ${order}`).iterate(receipt.transactionId);
    let size = 0; let count = 0n;
    for (const e of rows()) { size += Buffer.byteLength(String(e.json)) + 1; count++; }
    if (count !== BigInt(receipt.toSeq) - BigInt(receipt.fromSeq) + 1n) throw new StoreError('CORRUPT_STORE');
    const common = { transactionId: receipt.transactionId as string, fromSeq: receipt.fromSeq as string, toSeq: receipt.toSeq as string };
    const imports=this.db.prepare("SELECT 1 FROM events_v2 WHERE transaction_id=? AND json_extract(json,'$.type')='BundleImported' LIMIT 1").get(receipt.transactionId);
    // Imported transactions require a recovery context even on the SSE path,
    // so the browser can hydrate their immutable mapped rows before publishing.
    if (size <= 48000 && !imports) return { ...common, events: Array.from(rows(), e => JSON.parse(String(e.json)) as DomainEvent) };
    const content = this.storeRows(function* () { for (const e of rows()) yield Buffer.from(String(e.json) + '\n'); }, 'lp1-events-jsonl');
    return { ...common, eventCount: String(count), content: this.issue(content) };
  }
  namespaceContent(eventId:string, highWater:string) {
    if(!isId(eventId)||!isSeq(highWater)||BigInt(highWater)>BigInt(this.highWater()))throw new StoreError('MALFORMED_REQUEST');
    const row=this.db.prepare("SELECT seq,json FROM events_v2 WHERE json_extract(json,'$.eventId')=? AND json_extract(json,'$.type')='BundleImported'").get(eventId);
    if(!row||BigInt(String(row.seq))>BigInt(highWater))throw new StoreError('NOT_FOUND');
    const event=JSON.parse(String(row.json)),namespace=event.payload.namespaceId;
    if(namespaceDigest(this.db,namespace)!==event.payload.namespaceHash)throw new StoreError('CORRUPT_STORE');
    const count=this.db.prepare("SELECT count(*) n FROM portable_rows WHERE namespace=? AND kind IN ('asset','checkpoint','document','history')").get(namespace)!.n;
    const db=this.db;
    const rows=function*(){
      yield Buffer.from(canonical({kind:'header',namespaceId:namespace,namespaceHash:event.payload.namespaceHash,eventId,workspaceSeq:event.workspaceSeq,projectionSchema:CURRENT_PROJECTION_SCHEMA,entityCount:String(count)})+'\n');
      // These are the shared domain projection families. Client-owned UI and
      // inert provider provenance retain their separate access/ownership paths.
      for(const row of db.prepare("SELECT kind,id,json FROM portable_rows WHERE namespace=? AND kind IN ('asset','checkpoint','document','history') ORDER BY kind,id").iterate(namespace)){
        const value=JSON.parse(String(row.json)),version=validateEntity(String(row.kind),value),bytes=Buffer.from(String(row.json));
        if(bytes.length>65536||value.id!==row.id||canonical(value)!==String(row.json))throw new StoreError('CORRUPT_STORE');
        const chunks:Buffer[]=[];for(let at=0;at<bytes.length;){let end=Math.min(at+8192,bytes.length);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;chunks.push(bytes.subarray(at,end));at=end;}
        for(let i=0;i<chunks.length;i++)yield Buffer.from(canonical({kind:'projection-part',entityType:String(row.kind),entityId:String(row.id),entityVersion:version,partIndex:i,partCount:chunks.length,utf8Base64:chunks[i].toString('base64')})+'\n');
      }
    };
    return {eventId,namespaceId:namespace,namespaceHash:event.payload.namespaceHash,workspaceSeq:event.workspaceSeq,content:this.issue(this.storeRows(rows,'lp1-namespace-jsonl'))};
  }
  safeJSON(kind: 'document' | 'receipt', id: string): StoredContent {
    if (!isId(id)) throw new StoreError('MALFORMED_REQUEST');
    const releaseCoverage=adapterResources.uncovered('recovery-safe-json');try{
    let bytes: Uint8Array;
    if (kind === 'document') {
      const row = this.db.prepare('SELECT json FROM documents WHERE id=?').get(id);
      if (!row) throw new StoreError('MISSING_OBJECT'); bytes = Buffer.from(String(row.json));
    } else if (kind === 'receipt') {
      const row = this.db.prepare('SELECT receipt FROM commands WHERE id=?').get(id);
      if (!row) throw new StoreError('MISSING_OBJECT'); const receipt = JSON.parse(String(row.receipt));
      if (receipt.status !== 'rejected') throw new StoreError('MALFORMED_REQUEST');
      bytes = this.objects.verify(receipt.details,true)!;
      const detail = JSON.parse(Buffer.from(bytes).toString());
      if (detail.kind !== 'fields' || Object.keys(detail).sort().join(',') !== 'issues,kind' || !Array.isArray(detail.issues) ||
          detail.issues.some((v: any)=>Object.keys(v).sort().join(',')!=='code,path' || typeof v.path!=='string' || typeof v.code!=='string') ||
          canonical(detail) !== Buffer.from(bytes).toString()) throw new StoreError('CORRUPT_STORE');
    } else throw new StoreError('MALFORMED_REQUEST');
    return this.issue({blob:this.objects.putMetadata(bytes),encoding:'lp1-json',recordCount:'1'});
    }finally{releaseCoverage();}
  }
  documentProjection(id:string) {
    if(!isId(id))throw new StoreError('MALFORMED_REQUEST');this.check();
    const row=this.db.prepare('SELECT json FROM documents WHERE id=?').get(id);
    if(!row)return null;
    // Capture one authoritative value and high-water in this synchronous writer
    // turn. A second read by ID could pair a newer body with an older revision.
    const text=String(row.json);let value;
    try{value=JSON.parse(text);validateEntity('document',value);if(value.id!==id||canonical(value)!==text)throw Error();}
    catch{throw new StoreError('CORRUPT_STORE');}
    const common={protocolVersion:1 as const,entityVersion:value.revision as string,projectionSchema:CURRENT_PROJECTION_SCHEMA,highWater:this.highWater()};
    const inline={...common,projection:{kind:'inline' as const,value}};
    if(Buffer.byteLength(canonical(inline))<=65536)return inline;
    const length=String(Buffer.byteLength(text));
    // LP-1 still bounds the complete control reply. Referencing its value cannot
    // make an oversized outer entityVersion/highWater legal. These placeholder
    // fields have exactly the lengths of the eventual public content descriptor.
    const uuid='00000000-0000-0000-0000-000000000000';
    const descriptor={contentId:uuid,url:'/api/v1/protocol-content/'+uuid,blob:{hash:'sha256:'+'0'.repeat(64),byteLength:length,mediaType:'application/json'},encoding:'lp1-json',recordCount:'1',expiresAt:'2000-01-01T00:00:00.000Z'};
    if(Buffer.byteLength(canonical({...common,projection:{kind:'content-ref',content:descriptor}}))>65536)throw new StoreError('PAYLOAD_TOO_LARGE');
    if(this.handles.size>=128)throw new StoreError('QUEUE_FULL');
    // Typed projection content uses ordinary reserved, chunked, atomically
    // installed objects. Generic putMetadata retains its existing64KiB guard.
    const releaseCoverage=adapterResources.uncovered('recovery-document-projection');let stage:string|undefined;
    try{
      stage=this.objects.begin(length,'application/json');
      const bytes=Buffer.from(text);
      for(let at=0;at<bytes.length;at+=IO_CHUNK)this.objects.chunk(stage,bytes.subarray(at,at+IO_CHUNK));
      return {...common,projection:{kind:'stored' as const,content:this.issue({blob:this.objects.finish(stage),encoding:'lp1-json',recordCount:'1'})}};
    }finally{try{if(stage)this.objects.abort(stage);}finally{releaseCoverage();}}
  }
  issue(content: Omit<StoredContent, 'handle'>): StoredContent {
    return { ...content, handle:this.openContent(content.blob) };
  }
  openContent(ref:BlobRef):string {
    if (this.handles.size >= 128) throw new StoreError('QUEUE_FULL');
    const releaseCoverage=adapterResources.uncovered('recovery-reader');
    try{this.objects.verify(ref);
    const handle = randomUUID(); this.handles.set(handle, ref); this.readerCoverage.set(handle,releaseCoverage); return handle;
    }catch(error){releaseCoverage();throw error;}
  }
  verifyContent(handle: string) { const ref = this.handles.get(handle); if (!ref) throw new StoreError('MISSING_OBJECT'); this.objects.verify(ref); }
  content(handle: string, offset: string, length: number) {
    const ref = this.handles.get(handle); if (!ref) throw new StoreError('MISSING_OBJECT');
    return this.objects.readRange(ref, offset, length);
  }
  drop(handle: string) { this.handles.delete(handle); this.readerCoverage.get(handle)?.();this.readerCoverage.delete(handle); }
  releasedOwner(id: string) { return this.db.prepare('SELECT client_id FROM read_releases WHERE id=?').get(id)?.client_id ?? null; }
  release(id: string, clientId: string, epoch: string) {
    this.db.prepare('INSERT OR IGNORE INTO read_releases VALUES (?,?,?)').run(id,clientId,epoch);
  }
}

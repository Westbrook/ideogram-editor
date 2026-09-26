import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobRef, DomainEvent } from '../../src/protocol/store.js';
import { canonical, isSeq, isId } from './canonical.js';
import type { Objects } from './objects.js';
import { entity as validateEntity } from '../../src/protocol/validate.js';
import { StoreError } from './errors.js';

export type StoredContent = { handle: string; blob: BlobRef; encoding: 'lp1-json' | 'lp1-events-jsonl' | 'lp1-snapshot-jsonl'; recordCount: string };
export type StoredSnapshot = { id: string; seq: string; content: Omit<StoredContent, 'handle'> };
const order = 'ORDER BY length(seq),seq';
export class RecoveryStore {
  private handles = new Map<string, BlobRef>();
  snapshotFailure = false;
  constructor(private db: DatabaseSync, private objects: Objects) {}
  highWater() { return String(this.db.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value); }
  private *entities() {
    for (const [type, table] of [['checkpoint','checkpoints'], ['document','documents'], ['history','history']]) {
      for (const row of this.db.prepare(`SELECT id,json FROM ${table} ORDER BY id`).iterate()) {
        const text = String(row.json); const value = JSON.parse(text);
        yield { type, id: String(row.id), version: type === 'document' ? value.revision : type === 'checkpoint' ? value.documentRevision : value.forward.after.revision, text };
      }
    }
  }
  private *snapshotRows(id: string, seq: string): Generator<Buffer> {
    let count = 0n; for (const _ of this.entities()) count++;
    yield Buffer.from(canonical({ kind: 'header', snapshotId: id, snapshotSeq: seq, projectionSchema: 2, entityCount: String(count) }) + '\n');
    for (const entity of this.entities()) {
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
    let length = 0n; let count = 0n;
    for (const bytes of rows()) { length += BigInt(bytes.length); count++; }
    const id = this.objects.begin(String(length), encoding === 'lp1-json' ? 'application/json' : 'application/x-ndjson');
    try {
      for (const bytes of rows()) this.objects.chunk(id, bytes);
      return { blob: this.objects.finish(id), encoding, recordCount: String(count) };
    } finally { this.objects.abort(id); }
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
  snapshot(force = false): StoredSnapshot | null {
    const last = this.latest(); const seq = this.highWater();
    if (!force && BigInt(seq) - BigInt(last?.seq ?? '0') < 250n) return last;
    const id = randomUUID();
    try {
      const content = this.storeRows(() => this.snapshotRows(id, seq), 'lp1-snapshot-jsonl');
      const snapshot = { id, seq, content };
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?)').run(content.blob.hash,content.blob.byteLength);
        if (this.db.prepare('SELECT byte_length FROM objects WHERE hash=?').get(content.blob.hash)!.byte_length !== content.blob.byteLength) throw new StoreError('CORRUPT_OBJECT');
        this.db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?)').run(id, seq, canonical(snapshot), this.projectionHash(), this.rootsHash());
        this.db.prepare('INSERT INTO snapshot_roots SELECT ?,owner,hash,media_type FROM roots').run(id);
        this.db.exec('COMMIT');
      } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
      this.snapshotFailure = false; return snapshot;
    } catch (error) { this.snapshotFailure = true; throw error; }
  }
  latest(): StoredSnapshot | null {
    // Invalid latest snapshots never invalidate retained events or the prior copy.
    for (const row of this.db.prepare('SELECT descriptor FROM snapshots ORDER BY length(seq) DESC,seq DESC').iterate()) {
      try { const item = JSON.parse(String(row.descriptor)) as StoredSnapshot; this.objects.verify(item.content.blob); this.validateSnapshot(item); return item; }
      catch (e) { if (e instanceof SyntaxError || e instanceof TypeError) continue; if (!(e instanceof StoreError) || !['CORRUPT_OBJECT','MISSING_OBJECT','CORRUPT_STORE','MALFORMED_REQUEST','PAYLOAD_TOO_LARGE'].includes(e.code)) throw e; }
    }
    return null;
  }
  private *lines(ref: BlobRef): Generator<Record<string, any>> {
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
  }
  validateSnapshot(item: StoredSnapshot, apply?: (type: string, id: string, text: string) => void) {
    if (!isId(item.id) || !isSeq(item.seq) || item.content.encoding !== 'lp1-snapshot-jsonl' || item.content.blob.mediaType !== 'application/x-ndjson' || !isSeq(item.content.recordCount)) throw new StoreError('CORRUPT_STORE');
    if (this.rootsHash(item.id) !== this.db.prepare('SELECT roots_hash FROM snapshots WHERE id=?').get(item.id)?.roots_hash) throw new StoreError('CORRUPT_STORE');
    const projectionHash = createHash('sha256');
    let rows = 0n; let entities = 0n; let expected = ''; let key = ''; let previousKey = ''; let part = 0; let parts = 0; let text = ''; let version = '';
    for (const row of this.lines(item.content.blob)) {
      if (rows++ === 0n) {
        if (row.kind !== 'header' || row.snapshotId !== item.id || row.snapshotSeq !== item.seq || row.projectionSchema !== 2 || !isSeq(row.entityCount)) throw new StoreError('CORRUPT_STORE');
        expected = row.entityCount; continue;
      }
      if (row.kind !== 'projection-part' || !['document','history','checkpoint'].includes(row.entityType) || !isId(row.entityId) || !isSeq(row.entityVersion) ||
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
        const actualVersion = row.entityType === 'document' ? value.revision : row.entityType === 'checkpoint' ? value.documentRevision : value.forward?.after?.revision;
        try { validateEntity(row.entityType,value); } catch { throw new StoreError('CORRUPT_STORE'); }
        projectionHash.update(canonical({ type: row.entityType, id: row.entityId, version, text }) + '\n');
        if (version !== actualVersion) throw new StoreError('CORRUPT_STORE');
        apply?.(row.entityType, row.entityId, text); entities++; previousKey = key; text = ''; part = 0;
      }
    }
    if (part || String(entities) !== expected || String(rows) !== item.content.recordCount || projectionHash.digest('hex') !== this.db.prepare('SELECT projection_hash FROM snapshots WHERE id=?').get(item.id)?.projection_hash) throw new StoreError('CORRUPT_STORE');
  }
  restore(item: StoredSnapshot) {
    // Caller owns rollback transaction. Insert documents first to honor FKs.
    for (const type of ['document','history','checkpoint']) this.validateSnapshot(item, (kind,id,text) => {
      if (kind !== type) return; const value = JSON.parse(text);
      if (kind === 'document') this.db.prepare('INSERT INTO documents VALUES (?,?)').run(id,text);
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
    if (size <= 48000) return { ...common, events: Array.from(rows(), e => JSON.parse(String(e.json)) as DomainEvent) };
    const content = this.storeRows(function* () { for (const e of rows()) yield Buffer.from(String(e.json) + '\n'); }, 'lp1-events-jsonl');
    return { ...common, eventCount: String(count), content: this.issue(content) };
  }
  safeJSON(kind: 'document' | 'receipt', id: string): StoredContent {
    if (!isId(id)) throw new StoreError('MALFORMED_REQUEST');
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
  }
  issue(content: Omit<StoredContent, 'handle'>): StoredContent {
    if (this.handles.size >= 128) throw new StoreError('QUEUE_FULL');
    this.objects.verify(content.blob);
    const handle = randomUUID(); this.handles.set(handle, content.blob); return { ...content, handle };
  }
  verifyContent(handle: string) { const ref = this.handles.get(handle); if (!ref) throw new StoreError('MISSING_OBJECT'); this.objects.verify(ref); }
  content(handle: string, offset: string, length: number) {
    const ref = this.handles.get(handle); if (!ref) throw new StoreError('MISSING_OBJECT');
    return this.objects.readRange(ref, offset, length);
  }
  drop(handle: string) { this.handles.delete(handle); }
  releasedOwner(id: string) { return this.db.prepare('SELECT client_id FROM read_releases WHERE id=?').get(id)?.client_id ?? null; }
  release(id: string, clientId: string, epoch: string) {
    this.db.prepare('INSERT OR IGNORE INTO read_releases VALUES (?,?,?)').run(id,clientId,epoch);
  }
}

import { closeSync, lstatSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { EMPTY_EXPECTED_VERSIONS } from '../../src/protocol/store.js';
import type { BlobRef, Command, Document, DomainEvent, Receipt, RejectionCode } from '../../src/protocol/store.js';
import { canonical, hashBytes, isId, isSeq, parseCommand, parseExpected } from './canonical.js';
import { assertComponents, assertPrivate, inspectTree, privateFile, sameFile, syncDirectory } from './files.js';
import { StoreError } from './errors.js';
import { Objects } from './objects.js';
import type { Barrier } from './objects.js';
import { event as validateEvent } from '../../src/protocol/validate.js';
import { Assets, AssetRejection } from './assets.js';
import type { AssetFact } from '../../src/protocol/assets.js';
import { extendSchema, assetSchema, rasterSchema, approvalSchema } from './schema.js';
import { Rasters } from './raster.js';
import { RecoveryStore } from './recovery.js';
import { reduceDocument } from './reducer.js';

const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT OR IGNORE INTO meta VALUES ('writerEpoch','0'), ('highWater','0');
CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, byte_length TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, original TEXT NOT NULL,
 canonical TEXT NOT NULL, receipt TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS events (seq TEXT PRIMARY KEY, transaction_id TEXT NOT NULL UNIQUE,
 command_id TEXT NOT NULL UNIQUE REFERENCES commands(id) DEFERRABLE INITIALLY DEFERRED, json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS roots (owner TEXT NOT NULL, hash TEXT NOT NULL REFERENCES objects(hash),
 media_type TEXT NOT NULL, PRIMARY KEY(owner,hash)) STRICT;
CREATE TRIGGER IF NOT EXISTS events_immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS events_immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS commands_immutable_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS commands_immutable_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
type Rejection = { code: RejectionCode; path: string; reason: string; currentRevision: string | null };
export class StoreDatabase {
  private db: DatabaseSync;
  readonly objects: Objects;
  readonly epoch: string;
  readonly recovery: RecoveryStore;
  readonly assets: Assets;
  readonly rasters: Rasters;
  private databaseIdentity;
  private rootIdentity;
  private missing: { hash: string; code: string }[] = [];
  private missingCount = 0;
  private appendMs: number[] = [];
  private replayMs = 0;
  private closed = false;
  private path: string;
  constructor(private root: string, private barrier: Barrier, options: { quotaBytes?: string; maxPageCount?: number } = {}) {
    this.rootIdentity = assertPrivate(root, true);
    inspectTree(root);
    this.path = join(root, 'metadata.sqlite');
    closeSync(privateFile(this.path)); syncDirectory(root);
    this.databaseIdentity = assertPrivate(this.path, false);
    const reader = new DatabaseSync(this.path, { readOnly: true, allowExtension: false });
    let version: number;
    try { version = Number(reader.prepare('PRAGMA user_version').get()!.user_version); }
    finally { reader.close(); }
    // Unknown future roots are inspected with a read-only connection only.
    if (![0,1,2,3,4,5].includes(version)) throw new StoreError('UNSUPPORTED_STORAGE', {
      kind: 'fields', issues: [{ path: 'storage.schemaVersion', code: 'USE_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP' }],
    });
    this.db = new DatabaseSync(this.path, { timeout: 250, enableForeignKeyConstraints: true, allowExtension: false });
    try {
      if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) !== version) throw new StoreError('ROOT_UNSAFE');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA trusted_schema=OFF; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;');
      for (const [name, expected] of [['journal_mode', 'wal'], ['synchronous', 2], ['foreign_keys', 1], ['busy_timeout', 250]] as const) {
        if (Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0] !== expected) throw new StoreError('UNSUPPORTED_STORAGE');
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(schema);

      this.db.exec('COMMIT');
      extendSchema(this.db, root, version, options.quotaBytes);
      assetSchema(this.db, root, options.quotaBytes,version===0);
      rasterSchema(this.db, root, options.quotaBytes,version===0);
      approvalSchema(this.db, root, barrier, options.quotaBytes,version===0);
      this.objects = new Objects(root, () => this.check(), barrier, options.quotaBytes);
      // Projections are rebuildable indexes. Events/receipts and immutable bytes
      // remain authoritative; replay has no scheduler or transport attached.
      this.recovery = new RecoveryStore(this.db, this.objects, this.path, barrier, () => this.fence(this.epoch));
      this.rebuild();
      for (const row of this.db.prepare('SELECT DISTINCT o.hash, o.byte_length, r.media_type FROM roots r JOIN objects o ON r.hash=o.hash').iterate()) {
        try { this.objects.verify({ hash: String(row.hash), byteLength: String(row.byte_length), mediaType: String(row.media_type) }); }
        catch (error) {
          if (!(error instanceof StoreError) || !['MISSING_OBJECT', 'CORRUPT_OBJECT'].includes(error.code)) throw error;
          this.missingCount++;
          if (this.missing.length < 100) this.missing.push({ hash: String(row.hash), code: error.code });
        }
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.epoch = String(BigInt(this.meta('writerEpoch')) + 1n);
      this.setMeta('writerEpoch', this.epoch);
      this.db.exec('COMMIT');
      syncDirectory(root); this.check();
      this.assets=new Assets(this.db,this.objects,root,this.epoch,()=>this.fence(this.epoch),barrier,
        (bytes,build,failure)=>this.commitAsset(bytes,build,failure),(owner,ref,proof)=>this.register(owner,ref,proof));
      this.rasters=new Rasters(this.db,this.objects,this.assets,root,this.epoch,()=>this.fence(this.epoch),barrier,
        (bytes,build,failure)=>this.commitAsset(bytes,build,failure),(owner,ref,proof)=>this.register(owner,ref,proof));
      this.objects.onAvailable(()=>{this.assets.schedule();this.rasters.schedule();});
      if (options.maxPageCount !== undefined) {
        if (!Number.isSafeInteger(options.maxPageCount) || options.maxPageCount < 1) throw new Error('Invalid test page limit');
        this.db.exec(`PRAGMA max_page_count=${options.maxPageCount}`);
      }
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.db.close(); throw error;
    }
  }
  check(): void {
    assertComponents(this.root);
    if (this.closed || !sameFile(this.rootIdentity, assertPrivate(this.root, true)) ||
        !sameFile(this.databaseIdentity, assertPrivate(this.path, false))) throw new StoreError('ROOT_UNSAFE');
    for (const suffix of ['-wal', '-shm']) {
      try { lstatSync(this.path + suffix); assertPrivate(this.path + suffix, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  fence(epoch: string): void {
    this.check();
    if (epoch !== this.epoch || this.meta('writerEpoch') !== epoch) throw new StoreError('STALE_EPOCH');
  }
  private meta(key: string): string { return String(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)!.value); }
  private setMeta(key: string, value: string) { this.db.prepare('UPDATE meta SET value=? WHERE key=?').run(value, key); }
  document(id: string): Document | null {
    if (!isId(id)) throw new StoreError('MALFORMED_REQUEST');
    this.check(); const row = this.db.prepare('SELECT json FROM documents WHERE id=?').get(id);
    return row ? JSON.parse(String(row.json)) : null;
  }
  lookup(id: string) {
    if (!isId(id)) throw new StoreError('MALFORMED_REQUEST');
    this.check(); const row = this.db.prepare('SELECT hash, canonical, receipt FROM commands WHERE id=?').get(id);
    return row ? { hash: String(row.hash), command: JSON.parse(String(row.canonical)).command as Command, receipt: JSON.parse(String(row.receipt)) as Receipt } : null;
  }
  events(after: string, limit: number) {
    this.check();
    if (!isSeq(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new StoreError('MALFORMED_REQUEST');
    const events = this.db.prepare('SELECT json FROM events_v2 WHERE length(seq)>length(?) OR (length(seq)=length(?) AND seq>?) ORDER BY length(seq),seq LIMIT ?').all(after, after, after, limit);
    return { highWater: this.meta('highWater'), events: events.map(row => JSON.parse(String(row.json)) as DomainEvent) };
  }
  entity(kind: 'history' | 'checkpoints', id: string) {
    this.check(); if (!isId(id)) throw new StoreError('MALFORMED_REQUEST');
    const row = this.db.prepare(kind === 'history' ? 'SELECT json FROM history WHERE id=?' : 'SELECT json FROM checkpoints WHERE id=?').get(id);
    return row ? JSON.parse(String(row.json)) : null;
  }
  private project(event: DomainEvent): void {
    if(event.type==='AssetRegistered') {
      this.db.prepare('INSERT INTO assets VALUES (?,?)').run(event.payload.asset.id,canonical(event.payload.asset));
      for(const ref of [event.payload.asset.blob,...event.payload.asset.dependencies])this.db.prepare('INSERT OR IGNORE INTO asset_dependencies VALUES (?,?)').run(event.payload.asset.id,ref.hash);
      return;
    }
    if(event.type==='StagingTransferReviewPrepared'||event.type==='RasterReviewPrepared'||event.type==='StagingOwnershipTransferred')return;
    const next = reduceDocument(this.document(event.documentId!), event);
    this.db.prepare('INSERT INTO documents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(next.id, canonical(next));
    if (event.type === 'DocumentCreated') this.db.prepare('INSERT INTO history VALUES (?,?,?)').run(event.payload.history.id, next.id, canonical(event.payload.history));
    else this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?)').run(event.payload.checkpoint.id, next.id, canonical(event.payload.checkpoint));
  }
  private rebuild(): void {
    const start = performance.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM asset_dependencies; DELETE FROM assets; DELETE FROM checkpoints; DELETE FROM history; DELETE FROM documents;');
      const snapshot = this.recovery.latest();
      if (snapshot) this.recovery.restore(snapshot);
      let highWater = BigInt(snapshot?.seq ?? '0');
      let activeTransaction: string | null = null;
      let transactionEnd = highWater;
      for (const row of this.db.prepare('SELECT json,seq,transaction_id,command_id FROM events_v2 WHERE length(seq)>length(?) OR (length(seq)=length(?) AND seq>?) ORDER BY length(seq),seq').iterate(String(highWater),String(highWater),String(highWater))) {
        const event = JSON.parse(String(row.json)) as DomainEvent;
        try { validateEvent(event); } catch { throw new StoreError('CORRUPT_STORE'); }
        highWater++;
        if (event.workspaceSeq !== String(highWater) || event.workspaceSeq !== row.seq ||
            event.transactionId !== row.transaction_id || event.commandId !== row.command_id || Buffer.byteLength(String(row.json)) > 16384) throw new StoreError('CORRUPT_STORE');
        const record = this.lookup(event.commandId);
        if (!record || hashBytes(canonical({ protocolVersion: 1, command: record.command })) !== record.hash ||
            record.receipt.status !== 'accepted' || BigInt(record.receipt.fromSeq) > highWater ||
            BigInt(record.receipt.toSeq) < highWater || record.receipt.transactionId !== event.transactionId) throw new StoreError('CORRUPT_STORE');
        if (activeTransaction === null) {
          if (record.receipt.fromSeq !== event.workspaceSeq) throw new StoreError('CORRUPT_STORE');
          activeTransaction = event.transactionId; transactionEnd = BigInt(record.receipt.toSeq);
        }
        if (event.transactionId !== activeTransaction) throw new StoreError('CORRUPT_STORE');
        this.project(event);
        if (highWater === transactionEnd) activeTransaction = null;
      }
      if (activeTransaction !== null || this.meta('highWater') !== String(highWater)) throw new StoreError('CORRUPT_STORE');
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    this.replayMs = performance.now() - start;
  }
  private register(owner: string, ref: BlobRef, proof?:string) {
    if(proof)this.objects.proven(ref,proof);else this.objects.verify(ref);
    this.db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?)').run(ref.hash, ref.byteLength);
    if (this.db.prepare('SELECT byte_length FROM objects WHERE hash=?').get(ref.hash)!.byte_length !== ref.byteLength) throw new StoreError('CORRUPT_OBJECT');
    this.db.prepare('INSERT INTO roots VALUES (?,?,?)').run(owner, ref.hash, ref.mediaType);
  }
  private rejection(c: Command, current: Document | null): Rejection | null {
    const reject = (code: RejectionCode, path: string, reason: string): Rejection => ({ code, path, reason, currentRevision: current?.revision ?? null });
    if (!c.documentId) return reject('INVALID_INPUT', 'command.documentId', 'REQUIRED');
    if (c.expectedDocumentRevision !== (current?.revision ?? null)) return reject('STALE_REVISION', 'command.expectedDocumentRevision', 'REVISION_CHANGED');
    let bytes: Uint8Array;
    try { bytes = this.objects.verify(c.expectedEntityVersions, true)!; }
    catch (error) {
      if (error instanceof StoreError && ['MISSING_OBJECT', 'CORRUPT_OBJECT'].includes(error.code)) return reject('MISSING_ASSET', 'command.expectedEntityVersions', 'UNAVAILABLE_BYTES');
      if (error instanceof StoreError && error.code === 'PAYLOAD_TOO_LARGE') return reject('CAPACITY', 'command.expectedEntityVersions', 'FOUNDATION_METADATA_LIMIT');
      throw error;
    }
    try {
      if (c.expectedEntityVersions.mediaType !== 'application/json') return reject('INVALID_INPUT', 'command.expectedEntityVersions', 'EXPECTED_JSON');
      const versions = parseExpected(bytes);
      if (canonical(versions) !== Buffer.from(bytes).toString('utf8')) return reject('INVALID_INPUT', 'command.expectedEntityVersions', 'EXPECTED_CANONICAL_JSON');
      for (const entity of versions.entities) {
        if (entity.entityId !== c.documentId) return reject('INVALID_INPUT', 'command.expectedEntityVersions', 'OUTSIDE_DOCUMENT');
        if (entity.version !== current?.revision) return reject('STALE_REVISION', 'command.expectedEntityVersions', 'ENTITY_CHANGED');
      }
    } catch (error) {
      if (error instanceof StoreError && ['MALFORMED_REQUEST', 'PAYLOAD_TOO_LARGE'].includes(error.code)) return reject('INVALID_INPUT', 'command.expectedEntityVersions', 'INVALID_VERSION_MAP');
      throw error;
    }
    if (this.db.prepare('SELECT seq FROM events_v2 WHERE transaction_id=?').get(c.transactionId)) return reject('INVALID_INPUT', 'command.transactionId', 'TRANSACTION_ID_REUSE');
    if (c.body.type === 'NewDocument') {
      if (current) return reject('INVALID_INPUT', 'command.documentId', 'DOCUMENT_EXISTS');
      if (c.body.width < 1 || c.body.height < 1) return reject('INVALID_INPUT', 'command.body', 'POSITIVE_DIMENSIONS_REQUIRED');
      if (c.body.color !== 'sRGB' || c.body.depth !== 8) return reject('INCOMPATIBLE', 'command.body', 'UNSUPPORTED_COLOR_DEPTH');
      if (c.body.width > 8192 || c.body.height > 8192 || c.body.width * c.body.height > 25000000) return reject('CAPACITY', 'command.body', 'DOCUMENT_DIMENSION_LIMIT');
    } else if(c.body.type==='SaveCheckpoint') {
      if (!current) return reject('INVALID_INPUT', 'command.documentId', 'DOCUMENT_REQUIRED');
      if (!c.body.name.trim()) return reject('INVALID_INPUT', 'command.body.name', 'NAME_REQUIRED');
    }
    // Tail backpressure is relative to the latest verified snapshot, never total history.
    if (BigInt(this.meta('highWater')) - BigInt(this.recovery.latest(true)?.seq ?? '0') >= 500n) return reject('CAPACITY', 'command.body', 'SNAPSHOT_REQUIRED');
    return null;
  }
  submit(bytes: Uint8Array, epoch: string): Receipt {
    this.fence(epoch);
    const request = parseCommand(bytes); const c = request.command;
    if(c.body.type!=='NewDocument'&&c.body.type!=='SaveCheckpoint')throw new StoreError('UNSUPPORTED_COMMAND');
    const serialized = canonical(request);
    if (Buffer.byteLength(serialized) > 65536) throw new StoreError('PAYLOAD_TOO_LARGE');
    const hash = hashBytes(serialized);
    const start = performance.now();
    this.recovery.maintain();
    const captured = { eventId: randomUUID(), historyId: randomUUID(), branchId: randomUUID(), checkpointId: randomUUID(), recordedAt: new Date().toISOString() };
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      this.fence(epoch);
      const previous = this.lookup(c.commandId);
      if (previous) {
        if (previous.hash !== hash) throw new StoreError('COMMAND_ID_REUSE');
        this.db.exec('ROLLBACK'); return previous.receipt;
      }
      this.assertPendingIdentity(c.commandId,hash);
      if (this.missingCount) throw new StoreError('CORRUPT_STORE');
      const document = c.documentId ? this.document(c.documentId) : null;
      let rejection = this.rejection(c, document);
      let event: DomainEvent | undefined;
      const seq = String(BigInt(this.meta('highWater')) + 1n);
      const revision = String(BigInt(document?.revision ?? '0') + 1n);
      if (!rejection) {
        const envelope = { schemaVersion: 1 as const, payloadVersion: 1 as const, eventId: captured.eventId, workspaceSeq: seq,
          streamId: c.documentId!, streamSeq: revision, documentId: c.documentId!, resultingDocumentRevision: revision,
          commandId: c.commandId, correlationId: c.correlationId, causationId: c.causationId, transactionId: c.transactionId, writerEpoch: epoch, recordedAt: captured.recordedAt };
        if (c.body.type === 'NewDocument') {
          const created: Document = { id: c.documentId!, revision, branchId: captured.branchId, width: c.body.width, height: c.body.height,
            color: 'sRGB', depth: 8, orderedLayerIds: [], historyHead: captured.historyId, checkpoint: null, compositionVersion: null };
          event = { ...envelope, type: 'DocumentCreated', payload: { document: created, history: {
            id: captured.historyId, documentId: created.id, branchId: created.branchId, parent: null,
            forward: { before: null, after: created }, inverse: { before: created, after: null }, roots: [c.expectedEntityVersions] } } };
        } else if(c.body.type==='SaveCheckpoint') event = { ...envelope, type: 'CheckpointSaved', payload: { checkpoint: { id: captured.checkpointId, name: c.body.name,
          documentId: document!.id, documentRevision: document!.revision, historyHead: document!.historyHead, highWater: this.meta('highWater') } } };
        if (Buffer.byteLength(canonical(event)) > 16384) rejection = { code: 'CAPACITY', path: 'command.body', reason: 'EVENT_SIZE_LIMIT', currentRevision: document?.revision ?? null };
      }
      let receipt: Receipt;
      if (rejection) {
        const detail = { kind: 'fields', issues: [{ path: rejection.path, code: rejection.reason }] };
        const details = this.objects.putMetadata(Buffer.from(canonical(detail)));
        this.register(`receipt:${c.commandId}`, details);
        receipt = { status: 'rejected', commandId: c.commandId, code: rejection.code, currentRevision: rejection.currentRevision, details };
      } else {
        this.register(`command:${c.commandId}`, c.expectedEntityVersions);
        this.barrier('before-event-insert');
        this.db.prepare('INSERT INTO events_v2 VALUES (?,?,?,?)').run(seq, c.transactionId, c.commandId, canonical(event));
        this.project(event!); this.setMeta('highWater', seq);
        receipt = { status: 'accepted', commandId: c.commandId, fromSeq: seq, toSeq: seq, documentRevision: revision, transactionId: c.transactionId };
      }
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run(c.commandId, hash, Buffer.from(bytes).toString('utf8'), serialized, canonical(receipt));
      this.barrier('before-commit'); this.fence(epoch);
      this.db.exec('COMMIT'); committed = true;
      this.barrier('after-commit');
      this.recovery.maintain();
      this.appendMs.push(performance.now() - start); if (this.appendMs.length > 100) this.appendMs.shift();
      return receipt;
    } catch (error) {
      if (!committed && this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private assertPendingIdentity(id:string,hash:string):void {
    // The acceptance transaction owns this check. HTTP prechecks can race another
    // request that durably reserves the ID while this command is queued.
    for(const table of ['asset_preparations','raster_preparations']){const pending=this.db.prepare(`SELECT hash FROM ${table} WHERE id=?`).get(id);
      if(pending&&pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');}
  }
  private commitAsset(bytes: Uint8Array, build:()=>AssetFact, failure?:()=>void):Receipt {
    this.fence(this.epoch);const request=parseCommand(bytes);const c=request.command;const serialized=canonical(request);const hash=hashBytes(serialized);
    this.recovery.maintain();this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.lookup(c.commandId);if(previous){if(previous.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');this.db.exec('ROLLBACK');return previous.receipt;}
      this.assertPendingIdentity(c.commandId,hash);
      if(this.missingCount)throw new StoreError('CORRUPT_STORE');
      let receipt:Receipt;
      // A savepoint prevents a rejected builder from publishing partial indexes.
      this.db.exec('SAVEPOINT asset_effect');
      try {
        if(c.documentId!==null||c.expectedDocumentRevision!==null)throw new AssetRejection('INVALID_INPUT','WORKSPACE_COMMAND_REQUIRED');
        let expected:Uint8Array;
        try{expected=this.objects.verify(c.expectedEntityVersions,true)!;}catch(e){if(e instanceof StoreError&&['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code))throw new AssetRejection('MISSING_ASSET','UNAVAILABLE_PRECONDITIONS');if(e instanceof StoreError&&e.code==='PAYLOAD_TOO_LARGE')throw new AssetRejection('CAPACITY','VERSION_MANIFEST_LIMIT');throw e;}
        let versions;try{versions=parseExpected(expected);}catch(e){if(e instanceof StoreError&&['MALFORMED_REQUEST','PAYLOAD_TOO_LARGE'].includes(e.code))throw new AssetRejection('INVALID_INPUT','INVALID_VERSION_MAP');throw e;}
        if(c.expectedEntityVersions.mediaType!=='application/json'||canonical(versions)!==Buffer.from(expected).toString('utf8')||versions.entities.length)throw new AssetRejection('INVALID_INPUT','EMPTY_WORKSPACE_PRECONDITIONS_REQUIRED');
        if(this.db.prepare('SELECT seq FROM events_v2 WHERE transaction_id=?').get(c.transactionId))throw new AssetRejection('INVALID_INPUT','TRANSACTION_ID_REUSE');
        if(BigInt(this.meta('highWater'))-BigInt(this.recovery.latest(true)?.seq??'0')>=500n)throw new AssetRejection('CAPACITY','SNAPSHOT_REQUIRED');
        const fact=build();const seq=String(BigInt(this.meta('highWater'))+1n);
        const event:DomainEvent={schemaVersion:1,payloadVersion:1,eventId:randomUUID(),workspaceSeq:seq,streamId:'assets',streamSeq:seq,documentId:null,resultingDocumentRevision:null,
          commandId:c.commandId,correlationId:c.correlationId,causationId:c.causationId,transactionId:c.transactionId,writerEpoch:this.epoch,recordedAt:new Date().toISOString(),...fact};
        validateEvent(event);if(Buffer.byteLength(canonical(event))>16384)throw new AssetRejection('CAPACITY','EVENT_SIZE_LIMIT');
        this.register('command:'+c.commandId,c.expectedEntityVersions);
        this.db.prepare('INSERT INTO events_v2 VALUES (?,?,?,?)').run(seq,c.transactionId,c.commandId,canonical(event));this.project(event);this.setMeta('highWater',seq);
        receipt={status:'accepted',commandId:c.commandId,fromSeq:seq,toSeq:seq,documentRevision:null,transactionId:c.transactionId};
        this.db.exec('RELEASE asset_effect');
      }catch(error){
        this.db.exec('ROLLBACK TO asset_effect; RELEASE asset_effect');
        if(!(error instanceof AssetRejection))throw error;
        failure?.();const details=this.objects.putMetadata(Buffer.from(canonical({kind:'fields',issues:[{path:'command.body',code:error.reason}]})));this.register('receipt:'+c.commandId,details);
        receipt={status:'rejected',commandId:c.commandId,code:error.code,currentRevision:error.currentRevision,details};
        // A rejected original identity is terminal; no preparation can overwrite it.
        this.db.prepare('DELETE FROM asset_preparations WHERE id=?').run(c.commandId);
        this.db.prepare('DELETE FROM raster_preparations WHERE id=?').run(c.commandId);
      }
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run(c.commandId,hash,Buffer.from(bytes).toString('utf8'),serialized,canonical(receipt));
      this.barrier('asset-before-commit');this.fence(this.epoch);this.db.exec('COMMIT');this.barrier('asset-after-commit');this.recovery.maintain();return receipt;
    }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }
  protocolDefaults(): void {
    // A fixed safe precondition value makes the existing narrow commands usable
    // on a new root. This is not arbitrary blob upload or repair of missing roots.
    if (this.missingCount || this.db.prepare('SELECT hash FROM objects WHERE hash=?').get(EMPTY_EXPECTED_VERSIONS.hash)) return;
    const ref = this.objects.putMetadata(Buffer.from(canonical({entities:[],schemaVersion:1})));
    if (canonical(ref) !== canonical(EMPTY_EXPECTED_VERSIONS)) throw new StoreError('CORRUPT_STORE');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.register('protocol-default:empty-versions',ref); this.db.exec('COMMIT'); }
    catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  recoverClient(cookieHash: string, now: number): string | null {
    if (!/^[a-f0-9]{64}$/.test(cookieHash) || !Number.isSafeInteger(now)) throw new StoreError('MALFORMED_REQUEST');
    const row = this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(cookieHash);
    return row && BigInt(String(row.expires)) > BigInt(now) ? String(row.client_id) : null;
  }
  rememberClient(cookieHash: string, clientId: string, expires: number, oldHash?: string) {
    if (!/^[a-f0-9]{64}$/.test(cookieHash) || !isId(clientId) || !Number.isSafeInteger(expires) ||
        (oldHash !== undefined && !/^[a-f0-9]{64}$/.test(oldHash))) throw new StoreError('MALFORMED_REQUEST');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (oldHash) this.db.prepare('DELETE FROM client_bindings WHERE cookie_hash=?').run(oldHash);
      this.db.prepare('INSERT INTO client_bindings VALUES (?,?,?)').run(cookieHash,clientId,String(expires));
      this.db.exec('COMMIT');
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  forgetClient(cookieHash: string) { this.db.prepare('DELETE FROM client_bindings WHERE cookie_hash=?').run(cookieHash); }
  health() {
    this.check(); const fs = statfsSync(this.root,{bigint:true});
    return { missingCount: this.missingCount, diskWarning: (fs.blocks-fs.bavail)*100n >= fs.blocks*80n, snapshotPressure: this.recovery.snapshotFailure || this.assets.pressure() || this.rasters.pressure() };
  }
  diagnostics() {
    this.check(); const filesystem = statfsSync(this.root, { bigint: true });
    const pragma = (name: string) => Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0];
    const projectionHash = createHash('sha256'); projectionHash.update('['); let first = true;
    for (const row of this.db.prepare('SELECT json FROM documents ORDER BY id').iterate()) { if (!first) projectionHash.update(','); first = false; projectionHash.update(canonical(JSON.parse(String(row.json)))); }
    projectionHash.update(']'); const digest = 'sha256:' + projectionHash.digest('hex');
    return { node: process.versions.node, sqlite: this.db.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source').get(),
      settings: Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout', 'fullfsync', 'checkpoint_fullfsync', 'page_size', 'page_count', 'max_page_count'].map(k => [k, pragma(k)])),
      writerEpoch: this.epoch, highWater: this.meta('highWater'), projectionDigest: digest,
      inventory: this.objects.inventory(new Set(this.db.prepare('SELECT hash FROM objects').all().map(row => String(row.hash)))),
      missingCount: this.missingCount, missing: this.missing,
      filesystem: { type: String(filesystem.type), blockSize: String(filesystem.bsize), availableBytes: String(filesystem.bavail * filesystem.bsize), totalBytes: String(filesystem.blocks * filesystem.bsize) },
      diskWarning: (filesystem.blocks - filesystem.bavail) * 100n >= filesystem.blocks * 80n,
      resources: { ioChunkBytes: 1048576, maxTransfers: 2, admissionOverheadPercent: 25, freeMarginBytes: '1073741824', metadataHeadroomBytes: '67108864', metadataHeadroomPhysicallyPreallocated: false, snapshotTailCeiling: 500 },
      assets: this.assets.diagnostics(),
      rasters: this.rasters.diagnostics(),
      observations: { appendMs: this.appendMs, replayMs: this.replayMs, snapshot: { target: 250, pressure: this.recovery.snapshotFailure, latest: this.recovery.latest()?.seq ?? null,
        buildMs: this.recovery.snapshotBuildMs, sliceMaxMs: this.recovery.snapshotSliceMaxMs, activationMs: this.recovery.snapshotActivationMs }, qualification: false },
      processMemory: process.memoryUsage(), sqliteIntegrity: this.db.prepare('PRAGMA quick_check').get() };
  }
  close() {
    if (this.closed) return;
    this.objects.close(); this.db.close(); this.closed = true;
  }
}

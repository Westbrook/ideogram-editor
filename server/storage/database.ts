import {validDocumentName} from '../../src/protocol/document-creation.js';
import {serverPhases,commandAcceptances,commandContext,localQueuePhases} from '../observability/phases.js';
import {adapterResources} from '../observability/adapter-resources.js';
import type {PhaseSpan,PhaseSnapshot} from '../../src/observability/phases.js';
import {Deletions} from './deletion.js';
import {Candidates} from './candidates.js';
import {QueueStore} from './queue.js';
import {queueEvents} from '../../src/protocol/queue.js';
import type {QueueFact} from '../../src/protocol/queue.js';
import { Texts } from './text.js';
import { Portables, projectNamespace, type PortableCommit } from './portable.js';
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
import { Adapters } from './adapters.js';
import type { AssetFact } from '../../src/protocol/assets.js';
import { Histories, EXPORT_CANCELLATION_JSON, EXPORT_CANCELLATION_REF, ENCODED_REVIEW_CANCELLATION_JSON, ENCODED_REVIEW_CANCELLATION_REF } from './history.js';
import type { HistoryCommit } from './history.js';
import { UIStore } from './ui.js';
import {assertCompositionTextSchema19Ready,assertCompositionTextMigrationReady,compositionTextSchema} from './composition-text-schema.js';
import { extendSchema, assetSchema, rasterSchema, approvalSchema, historySchema, portableSchema, portableTransactionSchema, textSchema, maskSchema, retainedMaskSchema, textPlacementSchema, compositionSchema, queueSchema, candidateSchema, deletionSchema, assertP2LegacyCompatibility, p2SemanticSchema, assertEditorStorageCompatibility, editorSQLitePreflight, assertEditorSchema18Ready, assertRequestFamilyMigrationReady, requestFamilySchema } from './schema.js';
import { Rasters,RASTER_IMPORT_CANCELLATION_JSON,RASTER_IMPORT_CANCELLATION_REF } from './raster.js';
import { Displays } from './display.js';
import {StorageLibrary} from './library.js';
import {StorageLibraryMemory} from './library-memory.js';
import {StorageRepairs} from './storage-repair.js';
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
function utf8View(bytes:Uint8Array){return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('utf8');}
function parseObservedCommand(value:string){const bytes=Buffer.from(value),release=adapterResources.buffer('database','original-command',bytes);try{return parseCommand(bytes);}finally{release();}}
export class StoreDatabase {
  private db: DatabaseSync;
  readonly objects: Objects;
  readonly epoch: string;
  readonly recovery: RecoveryStore;
  readonly assets: Assets;
  readonly adapters: Adapters;
  readonly rasters: Rasters;
  readonly displays: Displays;
  readonly storageMemory: StorageLibraryMemory;
  readonly storageLibrary: StorageLibrary;
  readonly storageRepairs: StorageRepairs;
  readonly histories: Histories;
  readonly ui: UIStore;
  readonly texts: Texts;
  readonly portables: Portables;
  readonly queue: QueueStore;
  readonly candidates: Candidates;
  readonly deletions: Deletions;
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
    // Existing roots remain unopened for writing until the read-only capability
    // receipt and typed semantic scan succeed. Only a genuinely absent database
    // may be provisioned, and even that requires the centrally sealed executable.
    try { this.databaseIdentity = assertPrivate(this.path, false); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      assertEditorSchema18Ready();assertCompositionTextSchema19Ready();closeSync(privateFile(this.path));syncDirectory(root);
      this.databaseIdentity=assertPrivate(this.path,false);
    }
    const preflight=editorSQLitePreflight(root,this.path),reader=preflight.db;
    let version:number;
    try { version=Number(reader.prepare('PRAGMA user_version').get()!.user_version);if(version===16)assertP2LegacyCompatibility(reader,root);assertEditorStorageCompatibility(reader,root,version); }
    finally { preflight.close(); }
    preflight.checkSource();
    // Unknown future roots are inspected only through the private captured copy.
    if (![0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19].includes(version)) throw new StoreError('UNSUPPORTED_STORAGE', {
      kind: 'fields', issues: [{ path: 'storage.schemaVersion', code: 'USE_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP' }],
    });
    assertRequestFamilyMigrationReady(version,root);assertCompositionTextMigrationReady(version,root);
    preflight.checkSource();
    this.db = new DatabaseSync(this.path, { timeout: 250, enableForeignKeyConstraints: true, allowExtension: false });
    try {
      if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) !== version) throw new StoreError('ROOT_UNSAFE');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA trusted_schema=OFF; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;');
      for (const [name, expected] of [['journal_mode', 'wal'], ['synchronous', 2], ['foreign_keys', 1], ['busy_timeout', 250]] as const) {
        if (Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0] !== expected) throw new StoreError('UNSUPPORTED_STORAGE');
      }
      // An existing17 root needs its own exact backup before even optional
      // projection-index repair. No queue/UI/recovery bootstrap has run here.
      if(version===17)requestFamilySchema(this.db,root,barrier,options.quotaBytes);
      if(version>=17)compositionTextSchema(this.db,root,barrier,options.quotaBytes);
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(schema);

      this.db.exec('COMMIT');
      extendSchema(this.db, root, version, options.quotaBytes);
      assetSchema(this.db, root, options.quotaBytes,version===0);
      rasterSchema(this.db, root, options.quotaBytes,version===0);
      approvalSchema(this.db, root, barrier, options.quotaBytes,version===0);
      historySchema(this.db, root, barrier, options.quotaBytes,version===0);
      portableSchema(this.db, root, barrier, options.quotaBytes,version===0);
      portableTransactionSchema(this.db, root, barrier, options.quotaBytes,version===0);
      textSchema(this.db, root, barrier, options.quotaBytes,version===0);
      maskSchema(this.db, root, barrier, options.quotaBytes,version===0);
      retainedMaskSchema(this.db, root, barrier, options.quotaBytes,version===0);
      textPlacementSchema(this.db, root, barrier, options.quotaBytes,version===0);
      compositionSchema(this.db, root, barrier, options.quotaBytes,version===0);
      queueSchema(this.db,root,barrier,options.quotaBytes,version===0);
      candidateSchema(this.db,root,barrier,options.quotaBytes,version===0);
      deletionSchema(this.db,root,barrier,options.quotaBytes,version===0);
      p2SemanticSchema(this.db,root,barrier,options.quotaBytes,version===0,version<=16);
      requestFamilySchema(this.db,root,barrier,options.quotaBytes,version===0);
      compositionTextSchema(this.db,root,barrier,options.quotaBytes,version===0);
      this.objects = new Objects(root, () => this.check(), barrier, options.quotaBytes);
      // Projections are rebuildable indexes. Events/receipts and immutable bytes
      // remain authoritative; replay has no scheduler or transport attached.
      this.recovery = new RecoveryStore(this.db, this.objects, this.path, barrier, () => this.fence(this.epoch));
      this.rebuild();
      this.scanMissing();
      this.db.exec('BEGIN IMMEDIATE');
      this.epoch = String(BigInt(this.meta('writerEpoch')) + 1n);
      this.setMeta('writerEpoch', this.epoch);
      this.db.exec('COMMIT');
      syncDirectory(root); this.check();
      this.assets=new Assets(this.db,this.objects,root,this.epoch,()=>this.fence(this.epoch),barrier,
        (bytes,build,failure)=>this.commitAsset(bytes,build,failure),(owner,ref,proof)=>this.register(owner,ref,proof));
      this.adapters=new Adapters(this.db,this.objects,this.assets,()=>this.fence(this.epoch),
        (bytes,build,slot)=>this.commitAsset(bytes,build,undefined,slot),(owner,ref,proof)=>this.register(owner,ref,proof));
      this.rasters=new Rasters(this.db,this.objects,this.assets,root,this.epoch,()=>this.fence(this.epoch),barrier,
        (bytes,build,failure,slot)=>this.commitAsset(bytes,build,failure,slot),(owner,ref,proof)=>this.register(owner,ref,proof));
      this.texts=new Texts(this.db,this.objects,this.assets,this.epoch);
      this.rasters.externalCPU=()=>this.texts.externalBytes()+this.texts.reservedCPU+this.rasters.compositionMemory.bytes;
      this.texts.backendCPU=()=>this.rasters.reservedBytes+this.rasters.compositionMemory.bytes;
      this.displays=new Displays(this.objects,this.assets,this.rasters,root,()=>this.fence(this.epoch));
      this.storageMemory=new StorageLibraryMemory(this.rasters.compositionMemory);
      this.storageLibrary=new StorageLibrary(this.db,this.objects,this.displays,root,this.epoch,()=>this.fence(this.epoch),this.storageMemory);
      this.storageRepairs=new StorageRepairs(this.db,this.objects,this.assets,root,this.epoch,()=>this.fence(this.epoch),auth=>this.storageLibrary.authorize(auth),scope=>this.recovery.hasReaders()||this.displays.hasReaders()||this.texts.reservedCPU>0||this.rasters.reservedBytes>0||this.storageMemory.otherBytes(scope)>0,hash=>this.refreshMissingHash(hash),this.storageMemory);
      this.ui=new UIStore(this.db,this.objects,this.assets,()=>this.fence(this.epoch),barrier,id=>this.histories.state(id),(owner,ref,proof)=>this.register(owner,ref,proof,owner.startsWith('ui:')),this.rasters);
      this.portables=new Portables(this.db,this.objects,this.assets,this.rasters,this.texts,root,this.epoch,()=>this.fence(this.epoch),barrier,(bytes,build,slot)=>this.commitPortable(bytes,build,slot),id=>this.document(id),(owner,ref,proof)=>this.register(owner,ref,proof));
      this.queue=new QueueStore(this.db,this.objects,this.assets,this.ui,this.rasters,id=>this.histories.state(id),()=>this.fence(this.epoch),this.epoch,barrier,root,(bytes,build,slot,onDurable)=>this.commitAsset(bytes,build,undefined,slot,undefined,onDurable),(owner,ref,proof)=>this.register(owner,ref,proof));
      this.candidates=new Candidates(this.db,this.objects,this.assets,this.rasters,this.queue,()=>this.fence(this.epoch),(owner,ref,proof)=>this.register(owner,ref,proof));
      // Candidate-only assets are journal projections too. Validate the complete
      // retained graph before any provider, scheduler or public writer is ready.
      this.rasters.validateRetainedManifests();
      this.histories=new Histories(this.db,this.objects,this.assets,this.rasters,this.ui,this.texts,this.candidates,()=>this.fence(this.epoch),barrier,(bytes,build,creating,cancellation)=>this.commitHistory(bytes,build,creating,cancellation),id=>this.document(id),(owner,ref,proof)=>this.register(owner,ref,proof));
      this.queue.onDocumentDeleted=id=>{try{this.candidates.abortDocument(id);}finally{this.histories.discardEncodedReviewDocument(id);}};
      this.deletions=new Deletions(this.db,this.objects,this.queue,()=>this.fence(this.epoch),barrier,(bytes,build,beforeCommit)=>this.commitAsset(bytes,build,undefined,undefined,beforeCommit),(owner,ref)=>this.register(owner,ref),()=>this.recovery.hasReaders(),root);
      for(const r of this.db.prepare('SELECT document_id FROM candidate_document_tombstones').all())this.deletions.removeProjection(String(r.document_id));
      this.deletions.resume();
      this.objects.onAvailable(()=>{this.assets.schedule();this.rasters.schedule();this.histories.schedule();this.portables.schedule();});
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
  documentRevision(id:string):string|null {
    if(!isId(id))throw new StoreError('MALFORMED_REQUEST');this.check();
    const row=this.db.prepare("SELECT json_extract(json,'$.revision') AS revision FROM documents WHERE id=?").get(id);
    if(!row)return null;if(typeof row.revision!=='string'||!isSeq(row.revision))throw new StoreError('CORRUPT_STORE');
    return row.revision;
  }
  lookup(id: string) {
    if (!isId(id)) throw new StoreError('MALFORMED_REQUEST');
    this.check(); const row = this.db.prepare('SELECT hash, canonical, receipt FROM commands WHERE id=?').get(id);
    return row ? { hash: String(row.hash), command: JSON.parse(String(row.canonical)).command as Command, receipt: JSON.parse(String(row.receipt)) as Receipt } : null;
  }
  // Read-only owner inventory. Keyset pages bound memory; no history or pending row is removed.
  pendingInventory(clientId: string, after: string, high: string | null) {
    this.check(); if (!isId(clientId) || after && !isId(after) || high !== null && high !== '' && !isId(high)) throw new StoreError('MALFORMED_REQUEST');
    const union = ['asset_preparations','raster_preparations','history_preparations','portable_preparations']
      .map(table => `SELECT id,hash,canonical,operation_id,phase FROM ${table}`).join(' UNION ALL ');
    const owner = `json_extract(canonical,'$.command.clientId')=?`;
    const upper = high ?? String(this.db.prepare(`SELECT coalesce(max(id),'') AS id FROM (${union}) WHERE ${owner}`).get(clientId)!.id);
    const rows = this.db.prepare(`SELECT * FROM (${union}) WHERE ${owner} AND id>? AND id<=? ORDER BY id LIMIT 33`).all(clientId,after,upper);
    const items = rows.slice(0,32).map(row => {
      const command = JSON.parse(String(row.canonical)).command as Command;
      if(command.commandId!==row.id || hashBytes(String(row.canonical))!==row.hash || !isId(row.operation_id) || !['preparing','waiting-for-resources'].includes(String(row.phase))) throw new StoreError('CORRUPT_STORE');
      return {commandId:command.commandId,commandHash:String(row.hash),operationId:String(row.operation_id),phase:String(row.phase) as 'preparing'|'waiting-for-resources',label:command.body.type};
    });
    return {items,high:upper,after:items.at(-1)?.commandId??after,more:rows.length>32};
  }
  uiInventory(clientId:string,after:string,high:string|null){
    this.check();if(!isId(clientId)||after&&!isId(after)||high!==null&&high!==''&&!isId(high))throw new StoreError('MALFORMED_REQUEST');
    const upper=high??String(this.db.prepare("SELECT coalesce(max(session_id),'') AS id FROM ui_checkpoints WHERE client_id=?").get(clientId)!.id);
    const rows=this.db.prepare('SELECT session_id,json FROM ui_checkpoints WHERE client_id=? AND session_id>? AND session_id<=? ORDER BY session_id LIMIT 65').all(clientId,after,upper);
    const items=rows.slice(0,64).map(row=>{const ui=JSON.parse(String(row.json));return {sessionId:String(row.session_id),documentId:ui.preferences.documentId,uiSeq:ui.uiSeq};});
    return {items,high:upper,after:items.at(-1)?.sessionId??after,more:rows.length>64};
  }
  originalCommand(id: string, clientId: string) {
    this.check(); if(!isId(id)||!isId(clientId))throw new StoreError('MALFORMED_REQUEST');
    for(const table of ['commands','asset_preparations','raster_preparations','history_preparations','portable_preparations']){
      const row=this.db.prepare(`SELECT original,canonical,hash FROM ${table} WHERE id=?`).get(id);if(!row)continue;
      const original=String(row.original),request=parseObservedCommand(original);
      if(request.command.clientId!==clientId)throw new StoreError('OWNER_REQUIRED');
      if(request.command.commandId!==id||canonical(request)!==row.canonical||hashBytes(String(row.canonical))!==row.hash)throw new StoreError('CORRUPT_STORE');
      return original;
    }
    return null;
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
    if(queueEvents.includes(event.type))return;
    if(event.documentId&&this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(event.documentId))return;
    if(event.type==='BundleImported'&&this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=(SELECT document_id FROM portable_namespaces WHERE id=?)').get(event.payload.namespaceId))return;
    if(event.type==='BundleImported'){projectNamespace(this.db,event.payload.namespaceId,event.payload.namespaceHash);return;}
    if(['BundlePrepared','BundleImportReviewed','PortableCancelled'].includes(event.type))return;
    if(event.type==='AssetRegistered') {
      this.db.prepare('INSERT INTO assets VALUES (?,?)').run(event.payload.asset.id,canonical(event.payload.asset));
      for(const ref of [event.payload.asset.blob,...event.payload.asset.dependencies])this.db.prepare('INSERT OR IGNORE INTO asset_dependencies VALUES (?,?)').run(event.payload.asset.id,ref.hash);
      return;
    }
    if(event.type==='ImageEditPreviewPrepared'||event.type==='ImageEditReviewPrepared'||event.type==='CandidatePlacementReviewPrepared'||event.type==='StagingTransferReviewPrepared'||event.type==='RasterReviewPrepared'||event.type==='RasterImportInspectionPrepared'||event.type==='StagingOwnershipTransferred')return;
    const next = reduceDocument(this.document(event.documentId!), event);
    this.db.prepare('INSERT INTO documents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(next.id, canonical(next));
    if (event.type === 'DocumentCreated'||event.type==='ImageEdited') this.db.prepare('INSERT INTO history VALUES (?,?,?)').run(event.payload.history.id, next.id, canonical(event.payload.history));
    else if(event.type==='CheckpointSaved') this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?)').run(event.payload.checkpoint.id, next.id, canonical(event.payload.checkpoint));
  }
  private rebuild(): void {
    const start = performance.now(),phase=serverPhases.start('document.replay',{replay:true,boundary:'replay'});
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
      for(const r of this.db.prepare('SELECT document_id FROM candidate_document_tombstones').all()){this.db.prepare('DELETE FROM checkpoints WHERE document_id=?').run(r.document_id);this.db.prepare('DELETE FROM history WHERE document_id=?').run(r.document_id);this.db.prepare('DELETE FROM documents WHERE id=?').run(r.document_id);}
      if (activeTransaction !== null || this.meta('highWater') !== String(highWater)) throw new StoreError('CORRUPT_STORE');
      // Preview ownership is a private preparation index, not browser authority.
      // Rebuild it from retained immutable facts even when the domain tail used a
      // snapshot. Review/session credentials themselves are never replayed.
      this.db.exec('DELETE FROM image_previews');
      for(const row of this.db.prepare("SELECT json FROM events_v2 WHERE json_extract(json,'$.type')='ImageEditPreviewPrepared' ORDER BY length(seq),seq").iterate()){
        const event=JSON.parse(String(row.json));validateEvent(event);
        if(event.type!=='ImageEditPreviewPrepared')throw new StoreError('CORRUPT_STORE');
        const owner=this.lookup(event.commandId);if(!owner)throw new StoreError('CORRUPT_STORE');const preview=event.payload.preview;
        if(this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(preview.documentId))continue;
        this.db.prepare('INSERT INTO image_previews VALUES (?,?,?,?)').run(preview.previewId,preview.documentId,owner.command.clientId,canonical(preview));
      }
      this.db.exec('COMMIT');
    } catch (error) { phase.end('error'); if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    phase.end();this.replayMs = performance.now() - start;
  }
  private register(owner: string, ref: BlobRef, proof?:string, reuseUIRoot=false) {
    if(proof)this.objects.proven(ref,proof);else this.objects.verify(ref);
    this.db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?)').run(ref.hash, ref.byteLength);
    if (this.db.prepare('SELECT byte_length FROM objects WHERE hash=?').get(ref.hash)!.byte_length !== ref.byteLength) throw new StoreError('CORRUPT_OBJECT');
    // ClearDraft retires the checkpoint, not retained history. A later UI save
    // can reuse its id/generation; only an exactly proven root is idempotent.
    const retained=reuseUIRoot?this.db.prepare('SELECT media_type FROM roots WHERE owner=? AND hash=?').get(owner,ref.hash):undefined;
    if(retained){if(retained.media_type!==ref.mediaType)throw new StoreError('CORRUPT_OBJECT');}
    else this.db.prepare('INSERT INTO roots VALUES (?,?,?)').run(owner, ref.hash, ref.mediaType);
    this.db.prepare("UPDATE deletion_objects SET state='rescued' WHERE hash=? AND state IN ('eligible','quarantined','unlinking')").run(ref.hash);
  }
  private rejection(c: Command, current: Document | null): Rejection | null {
    const reject = (code: RejectionCode, path: string, reason: string): Rejection => ({ code, path, reason, currentRevision: current?.revision ?? null });
    if(c.documentId&&this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(c.documentId))return reject('STALE_REVISION','command.documentId','DOCUMENT_DELETED');
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
      if (canonical(versions) !== utf8View(bytes)) return reject('INVALID_INPUT', 'command.expectedEntityVersions', 'EXPECTED_CANONICAL_JSON');
      for (const entity of versions.entities) {
        if(entity.entityType==='layer'){
          const layer=current?.image?this.histories.versionState(current.image).layers.find(l=>l.id===entity.entityId):undefined;
          if(!layer||layer.version!==entity.version)return reject('STALE_REVISION','command.expectedEntityVersions','LAYER_VERSION_CHANGED');
          continue;
        }
        if (entity.entityId !== c.documentId) return reject('INVALID_INPUT', 'command.expectedEntityVersions', 'OUTSIDE_DOCUMENT');
        if (entity.version !== current?.revision) return reject('STALE_REVISION', 'command.expectedEntityVersions', 'ENTITY_CHANGED');
      }
    } catch (error) {
      if (error instanceof StoreError && ['MALFORMED_REQUEST', 'PAYLOAD_TOO_LARGE'].includes(error.code)) return reject('INVALID_INPUT', 'command.expectedEntityVersions', 'INVALID_VERSION_MAP');
      throw error;
    }
    if (this.db.prepare('SELECT seq FROM events_v2 WHERE transaction_id=?').get(c.transactionId)) return reject('INVALID_INPUT', 'command.transactionId', 'TRANSACTION_ID_REUSE');
    if (c.body.type === 'NewDocument'||c.body.type==='CreateDocument') {
      if(c.body.type==='CreateDocument'&&(!validDocumentName(c.body.name.trim())||/[\u0000-\u001f\u007f]/.test(c.body.name)))return reject('INVALID_INPUT','command.body.name','DOCUMENT_NAME_REQUIRED_OR_INVALID');
      if (current) return reject('INVALID_INPUT', 'command.documentId', 'DOCUMENT_EXISTS');
      if (c.body.width < 1 || c.body.height < 1) return reject('INVALID_INPUT', 'command.body', 'POSITIVE_DIMENSIONS_REQUIRED');
      if (c.body.type==='NewDocument'&&(c.body.color !== 'sRGB' || c.body.depth !== 8)) return reject('INCOMPATIBLE', 'command.body', 'UNSUPPORTED_COLOR_DEPTH');
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
    let committed = false;let append:PhaseSpan|undefined;
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
      if(c.body.type==='SaveCheckpoint'&&document?.image)throw new StoreError('UNSUPPORTED_COMMAND');
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
          documentId: document!.id, documentRevision: document!.revision, historyHead: document!.historyHead, highWater: this.meta('highWater'), ...(document!.image?{image:document!.image}:{}) } } };
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
        append=serverPhases.start('event.append',commandContext(c));
        this.db.prepare('INSERT INTO events_v2 VALUES (?,?,?,?)').run(seq, c.transactionId, c.commandId, canonical(event));
        this.project(event!); this.setMeta('highWater', seq);
        receipt = { status: 'accepted', commandId: c.commandId, fromSeq: seq, toSeq: seq, documentRevision: revision, transactionId: c.transactionId };
      }
      commandAcceptances.validated(c.commandId,hash,receipt);this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run(c.commandId, hash, utf8View(bytes), serialized, canonical(receipt));
      this.barrier('before-commit'); this.fence(epoch);
      this.db.exec('COMMIT'); committed = true;
      append?.end('ok',{boundary:'authority-durable'});commandAcceptances.durable(c.commandId,hash,receipt);
      this.barrier('after-commit');
      this.recovery.maintain();
      this.appendMs.push(performance.now() - start); if (this.appendMs.length > 100) this.appendMs.shift();
      return receipt;
    } catch (error) {
      append?.end('error');
      if (!committed && this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private scanMissing(){
    this.missingCount=0;this.missing=[];
      for (const row of this.db.prepare('SELECT DISTINCT o.hash, o.byte_length, r.media_type FROM roots r JOIN objects o ON r.hash=o.hash').iterate()) {
        try { this.objects.verify({ hash: String(row.hash), byteLength: String(row.byte_length), mediaType: String(row.media_type) }); }
        catch (error) {
          if (!(error instanceof StoreError) || !['MISSING_OBJECT', 'CORRUPT_OBJECT'].includes(error.code)) throw error;
          this.missingCount++;
          if (this.missing.length < 100) this.missing.push({ hash: String(row.hash), code: error.code });
        }
      }
  }
  private refreshMissingHash(hash:string):void {
    this.fence(this.epoch);this.storageLibrary.invalidate();if(!/^sha256:[a-f0-9]{64}$/.test(hash))throw new StoreError('MALFORMED_REQUEST');
    const prior=this.missing.filter(item=>item.hash===hash);
    for(const row of this.db.prepare('SELECT DISTINCT o.byte_length,r.media_type FROM roots r JOIN objects o ON o.hash=r.hash WHERE r.hash=?').iterate(hash))this.objects.verify({hash,byteLength:String(row.byte_length),mediaType:String(row.media_type)});
    // The retained detail is capped at 100. If the hash is outside it, keep the
    // conservative count until the normal acceptance scan refreshes it.
    this.missing=this.missing.filter(item=>item.hash!==hash);this.missingCount=Math.max(0,this.missingCount-prior.length);
  }
  private assertPendingIdentity(id:string,hash:string):void {
    // The acceptance transaction owns this check. HTTP prechecks can race another
    // request that durably reserves the ID while this command is queued.
    for(const table of ['asset_preparations','raster_preparations','history_preparations','portable_preparations']){const pending=this.db.prepare(`SELECT hash FROM ${table} WHERE id=?`).get(id);
      if(pending&&pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');}
  }
  private assetEnvelope(c:Command):void {
    if(c.documentId!==null||c.expectedDocumentRevision!==null)throw new AssetRejection('INVALID_INPUT','WORKSPACE_COMMAND_REQUIRED');
    let expected:Uint8Array;
    try{expected=this.objects.verify(c.expectedEntityVersions,true)!;}catch(e){if(e instanceof StoreError&&['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code))throw new AssetRejection('MISSING_ASSET','UNAVAILABLE_PRECONDITIONS');if(e instanceof StoreError&&e.code==='PAYLOAD_TOO_LARGE')throw new AssetRejection('CAPACITY','VERSION_MANIFEST_LIMIT');throw e;}
    let versions;try{versions=parseExpected(expected);}catch(e){if(e instanceof StoreError&&['MALFORMED_REQUEST','PAYLOAD_TOO_LARGE'].includes(e.code))throw new AssetRejection('INVALID_INPUT','INVALID_VERSION_MAP');throw e;}
    if(c.expectedEntityVersions.mediaType!=='application/json'||canonical(versions)!==utf8View(expected)||versions.entities.length)throw new AssetRejection('INVALID_INPUT','EMPTY_WORKSPACE_PRECONDITIONS_REQUIRED');
    if(this.db.prepare('SELECT seq FROM events_v2 WHERE transaction_id=?').get(c.transactionId))throw new AssetRejection('INVALID_INPUT','TRANSACTION_ID_REUSE');
    if(BigInt(this.meta('highWater'))-BigInt(this.recovery.latest(true)?.seq??'0')>=500n)throw new AssetRejection('CAPACITY','SNAPSHOT_REQUIRED');
  }
  private commitAsset(bytes: Uint8Array, build:()=>AssetFact|QueueFact, failure?:()=>void, slot?:string, beforeCommit?:()=>void,onDurable?:()=>void):Receipt {
    let append:PhaseSpan|undefined,queuedJobId:string|undefined,deletionBefore:ReturnType<QueueStore['observeEligibility']>=undefined,deletionAfter:ReturnType<QueueStore['observeEligibility']>=undefined;
    this.fence(this.epoch);const request=parseCommand(bytes);const c=request.command;const serialized=canonical(request);const hash=hashBytes(serialized);
    if(beforeCommit){
      // Filesystem collection owns short transactions. Validate the same command
      // envelope first, before allowing any irreversible physical side effect.
      // The callback is synchronous in the sole writer; no IPC turn can race
      // between this preflight and the normal acceptance revalidation below.
      this.recovery.maintain();this.db.exec('BEGIN IMMEDIATE');
      try{
        const previous=this.lookup(c.commandId);if(previous){if(previous.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');this.db.exec('ROLLBACK');return previous.receipt;}
        this.assertPendingIdentity(c.commandId,hash);if(this.missingCount)this.scanMissing();this.assetEnvelope(c);this.db.exec('ROLLBACK');
      }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');if(error instanceof AssetRejection)return this.commitAsset(bytes,()=>{throw error;},failure,slot);throw error;}
      try{beforeCommit();}catch(error){if(error instanceof AssetRejection)return this.commitAsset(bytes,()=>{throw error;},failure,slot);throw error;}
    }
    this.recovery.maintain();this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.lookup(c.commandId);if(previous){if(previous.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');this.db.exec('ROLLBACK');return previous.receipt;}
      this.assertPendingIdentity(c.commandId,hash);
      if(this.missingCount)this.scanMissing();
      let receipt:Receipt;
      // A savepoint prevents a rejected builder from publishing partial indexes.
      this.db.exec('SAVEPOINT asset_effect');
      try {
        this.assetEnvelope(c);
        if(c.body.type==='DeleteDocument')deletionBefore=this.queue.observeEligibility();
        const fact=build();if(c.body.type==='DeleteDocument')deletionAfter=this.queue.observeEligibility();if(fact.type==='JobQueued'||fact.type==='QueueStateChanged'&&c.body.type==='RetryUncertainJob')queuedJobId=fact.payload.id;const seq=String(BigInt(this.meta('highWater'))+1n);
        const event:DomainEvent={schemaVersion:1,payloadVersion:1,eventId:randomUUID(),workspaceSeq:seq,streamId:'assets',streamSeq:seq,documentId:null,resultingDocumentRevision:null,
          commandId:c.commandId,correlationId:c.correlationId,causationId:c.causationId,transactionId:c.transactionId,writerEpoch:this.epoch,recordedAt:new Date().toISOString(),...fact};
        validateEvent(event);if(Buffer.byteLength(canonical(event))>16384)throw new AssetRejection('CAPACITY','EVENT_SIZE_LIMIT');
        this.register('command:'+c.commandId,c.expectedEntityVersions);
        append??=serverPhases.start('event.append',commandContext(c));this.db.prepare('INSERT INTO events_v2 VALUES (?,?,?,?)').run(seq,c.transactionId,c.commandId,canonical(event));this.project(event);this.setMeta('highWater',seq);
        receipt={status:'accepted',commandId:c.commandId,fromSeq:seq,toSeq:seq,documentRevision:null,transactionId:c.transactionId};
        this.db.exec('RELEASE asset_effect');
      }catch(error){
        append?.end(error instanceof AssetRejection?'rejected':'error');append=undefined;
        this.db.exec('ROLLBACK TO asset_effect; RELEASE asset_effect');
        if(!(error instanceof AssetRejection))throw error;
        failure?.();const detailBytes=Buffer.from(canonical({kind:'fields',issues:[{path:'command.body',code:error.reason}]})),details=['InspectRasterOriginal','PrepareRaster'].includes(c.body.type)&&error.reason==='RASTER_IMPORT_CANCELED'?RASTER_IMPORT_CANCELLATION_REF:slot?this.objects.putMetadataInSlot(detailBytes,slot):this.objects.putMetadata(detailBytes);this.register('receipt:'+c.commandId,details);
        receipt={status:'rejected',commandId:c.commandId,code:error.code,currentRevision:error.currentRevision,details};
        // A rejected original identity is terminal; no preparation can overwrite it.
        this.db.prepare('DELETE FROM asset_preparations WHERE id=?').run(c.commandId);
        this.db.prepare('DELETE FROM raster_preparations WHERE id=?').run(c.commandId);
      }
      commandAcceptances.validated(c.commandId,hash,receipt);this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run(c.commandId,hash,utf8View(bytes),serialized,canonical(receipt));
      this.barrier('asset-before-commit');this.fence(this.epoch);this.db.exec('COMMIT');if(receipt.status==='accepted'){onDurable?.();if(c.body.type==='DeleteDocument')this.queue.eligibleChanged(deletionBefore,deletionAfter,c.commandId);}append?.end('ok',{boundary:'authority-durable'});commandAcceptances.durable(c.commandId,hash,receipt);
      if(receipt.status==='accepted'){if(queuedJobId)localQueuePhases.begin(queuedJobId,commandContext(c));if(c.body.type==='EditQueuedJob'||c.body.type==='CancelJob'||c.body.type==='CancelUnstartedJob'||c.body.type==='UndoPendingJob'){localQueuePhases.cancel(c.body.jobId);serverPhases.instant('job.cancel_requested',{...commandContext(c),jobId:c.body.jobId,...('attemptId' in c.body?{attemptId:c.body.attemptId}:{}),boundary:'cancel-intent'});}}
      this.barrier('asset-after-commit');this.recovery.maintain();return receipt;
    }catch(e){append?.end('error');if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }
  private commitHistory(bytes:Uint8Array,build:Parameters<HistoryCommit>[1],creating?:Document,cancellation?:'encoded-candidate-review'):Receipt {
    let append:PhaseSpan|undefined;
    this.fence(this.epoch);const request=parseCommand(bytes),c=request.command,serialized=canonical(request),hash=hashBytes(serialized);
    const start=performance.now();this.recovery.maintain();this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior=this.lookup(c.commandId);if(prior){if(prior.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');this.db.exec('ROLLBACK');return prior.receipt;}
      this.assertPendingIdentity(c.commandId,hash);
      let receipt:Receipt;const current=c.documentId?this.document(c.documentId):null;
      this.db.exec('SAVEPOINT history_effect');
      try {
        const frozen=c.body.type==='ExportDocument'?JSON.parse(String(this.db.prepare('SELECT frozen FROM history_preparations WHERE id=?').get(c.commandId)?.frozen??'null')) as Document|null:current;
        // This authenticated internal control can only reject the exact
        // pending encoded review. A changed/deleted document must not turn
        // cancellation into a new preparation or require another IO permit.
        if(cancellation==='encoded-candidate-review'){
          if(c.body.type!=='ReviewCandidatePlacement'||c.body.preparation!=='encoded-rebuild'||creating)throw new StoreError('MALFORMED_REQUEST');
          throw new AssetRejection('INVALID_INPUT','ENCODED_REBUILD_REVIEW_CANCELED');
        }
        const rejected=this.rejection(c,frozen);if(rejected)throw new AssetRejection(rejected.code,rejected.reason,rejected.currentRevision);
        if(creating&&(!['CreateDocument','AdoptCandidate','AdoptReviewedCandidate'].includes(c.body.type)||current!==null||creating.id!==c.documentId||creating.revision!=='0'||c.expectedDocumentRevision!==null))throw new AssetRejection('INVALID_INPUT','INVALID_DOCUMENT_CREATION');
        if(!current&&!creating)throw new AssetRejection('INVALID_INPUT','DOCUMENT_REQUIRED');
        const target=current??creating!,revision=String(BigInt(current?.revision??'0')+1n),result=build(target,revision);
        if(result.facts.length<1)throw new StoreError('CORRUPT_STORE');
        if(BigInt(this.meta('highWater'))-BigInt(this.recovery.latest(true)?.seq??'0')+BigInt(result.facts.length)>500n)throw new AssetRejection('CAPACITY','SNAPSHOT_REQUIRED');
        const first=String(BigInt(this.meta('highWater'))+1n);let seq=BigInt(first);
        for(const fact of result.facts){
          const domain=fact.type==='DocumentCreated'||fact.type==='ImageEdited'||fact.type==='HistoryNavigated'||fact.type==='CheckpointSaved';
          const eventDocument=fact.type==='DocumentCreated'?fact.payload.document:target,eventRevision=fact.type==='DocumentCreated'?eventDocument.revision:revision;
          const event:DomainEvent={schemaVersion:1,payloadVersion:1,eventId:randomUUID(),workspaceSeq:String(seq),streamId:domain?eventDocument.id:'assets',streamSeq:domain?eventRevision:String(seq),documentId:domain?eventDocument.id:null,resultingDocumentRevision:domain?eventRevision:null,
            commandId:c.commandId,correlationId:c.correlationId,causationId:c.causationId,transactionId:c.transactionId,writerEpoch:this.epoch,recordedAt:new Date().toISOString(),...fact};
          if(Buffer.byteLength(canonical(event))>16384)throw new AssetRejection('CAPACITY','EVENT_SIZE_LIMIT');validateEvent(event);
          this.barrier('history-before-event');append??=serverPhases.start('event.append',commandContext(c));this.db.prepare('INSERT INTO events_v2 VALUES (?,?,?,?)').run(String(seq),c.transactionId,c.commandId,canonical(event));this.project(event);seq++;
        }
        this.setMeta('highWater',String(seq-1n));this.register('command:'+c.commandId,c.expectedEntityVersions);
        receipt={status:'accepted',commandId:c.commandId,fromSeq:first,toSeq:String(seq-1n),documentRevision:result.documentChanged?revision:result.exportRevision??current?.revision??revision,transactionId:c.transactionId};
        this.db.exec('RELEASE history_effect');
      }catch(error){
        append?.end(error instanceof AssetRejection?'rejected':'error');append=undefined;
        this.db.exec('ROLLBACK TO history_effect; RELEASE history_effect');if(!(error instanceof AssetRejection))throw error;
        const details=c.body.type==='ExportDocument'&&error.reason==='EXPORT_CANCELED'?EXPORT_CANCELLATION_REF:c.body.type==='ReviewCandidatePlacement'&&c.body.preparation==='encoded-rebuild'&&error.reason==='ENCODED_REBUILD_REVIEW_CANCELED'?ENCODED_REVIEW_CANCELLATION_REF:this.objects.putMetadata(Buffer.from(canonical({kind:'fields',issues:[{path:'command.body',code:error.reason}]})));this.register('receipt:'+c.commandId,details);
        receipt={status:'rejected',commandId:c.commandId,code:error.code,currentRevision:current?.revision??null,details};
        this.db.prepare('DELETE FROM history_preparations WHERE id=?').run(c.commandId);
      }
      commandAcceptances.validated(c.commandId,hash,receipt);this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run(c.commandId,hash,utf8View(bytes),serialized,canonical(receipt));
      if(c.body.type==='ResampleImage'||c.body.type==='CreateFlattenedCopy')this.barrier('image-edit-before-commit');
      this.barrier('history-before-commit');this.fence(this.epoch);this.db.exec('COMMIT');append?.end('ok',{boundary:'authority-durable'});commandAcceptances.durable(c.commandId,hash,receipt);this.barrier('history-after-commit');if(c.body.type==='ResampleImage'||c.body.type==='CreateFlattenedCopy')this.barrier('image-edit-after-commit');this.recovery.maintain();
      this.appendMs.push(performance.now()-start);if(this.appendMs.length>100)this.appendMs.shift();return receipt;
    }catch(e){append?.end('error');if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }
  private commitPortable(bytes:Uint8Array,build:Parameters<PortableCommit>[1],slot?:string):Receipt {
    let append:PhaseSpan|undefined;
    this.fence(this.epoch);const request=parseCommand(bytes),c=request.command,serialized=canonical(request),hash=hashBytes(serialized);
    this.recovery.maintain();this.db.exec('BEGIN IMMEDIATE');
    try{const prior=this.lookup(c.commandId);if(prior){if(prior.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');this.db.exec('ROLLBACK');return prior.receipt;}
      this.assertPendingIdentity(c.commandId,hash);let receipt:Receipt;
      this.db.exec('SAVEPOINT portable_effect');
      try{
        const expected=parseExpected(this.objects.verify(c.expectedEntityVersions,true)!);if(c.expectedEntityVersions.mediaType!=='application/json'||canonical(expected)!==utf8View(this.objects.verify(c.expectedEntityVersions,true)!))throw new AssetRejection('INVALID_INPUT','INVALID_VERSION_MAP');
        if(c.body.type==='SaveCopy'||c.body.type==='SaveRecoveryCopy'){const p=this.db.prepare('SELECT frozen FROM portable_preparations WHERE id=?').get(c.commandId);const frozen=p?JSON.parse(String(p.frozen)):null;if(!frozen||c.documentId!==frozen.document.id||c.expectedDocumentRevision!==frozen.document.revision||expected.entities.some(x=>x.entityType!=='document'||x.entityId!==c.documentId||x.version!==c.expectedDocumentRevision))throw new AssetRejection('STALE_REVISION','CAPTURE_CHANGED');if(c.body.type==='SaveRecoveryCopy'&&(frozen.captureVersion!==11||frozen.recovery?.acknowledgementId!==c.body.acknowledgementId||frozen.recovery?.kind!=='tp1-sanitized-recovery-v1'))throw new AssetRejection('INVALID_INPUT','RECOVERY_ACKNOWLEDGEMENT_CHANGED');}
        else if(c.documentId!==null||c.expectedDocumentRevision!==null||expected.entities.length)throw new AssetRejection('INVALID_INPUT','WORKSPACE_COMMAND_REQUIRED');
        if(this.db.prepare('SELECT 1 FROM events_v2 WHERE transaction_id=?').get(c.transactionId))throw new AssetRejection('INVALID_INPUT','TRANSACTION_ID_REUSE');
        if(BigInt(this.meta('highWater'))-BigInt(this.recovery.latest(true)?.seq??'0')>=500n)throw new AssetRejection('CAPACITY','SNAPSHOT_REQUIRED');
        const result=build(),seq=String(BigInt(this.meta('highWater'))+1n),imported=result.fact.type==='BundleImported'?result.fact.payload.document:null;
        const e:DomainEvent={schemaVersion:1,payloadVersion:1,eventId:randomUUID(),workspaceSeq:seq,streamId:imported?imported.id:'portable',streamSeq:imported?imported.revision:seq,documentId:imported?imported.id:null,resultingDocumentRevision:imported?imported.revision:null,commandId:c.commandId,correlationId:c.correlationId,causationId:c.causationId,transactionId:c.transactionId,writerEpoch:this.epoch,recordedAt:new Date().toISOString(),...result.fact};
        validateEvent(e);if(Buffer.byteLength(canonical(e))>16384)throw new AssetRejection('CAPACITY','EVENT_SIZE_LIMIT');this.register('command:'+c.commandId,c.expectedEntityVersions);append??=serverPhases.start('event.append',commandContext(c));this.db.prepare('INSERT INTO events_v2 VALUES (?,?,?,?)').run(seq,c.transactionId,c.commandId,canonical(e));this.project(e);this.setMeta('highWater',seq);
        receipt={status:'accepted',commandId:c.commandId,fromSeq:seq,toSeq:seq,documentRevision:result.documentRevision,transactionId:c.transactionId};this.db.exec('RELEASE portable_effect');
      }catch(e){append?.end(e instanceof AssetRejection?'rejected':'error');append=undefined;if(!(e instanceof AssetRejection))throw e;this.db.exec('ROLLBACK TO portable_effect; RELEASE portable_effect');const detailBytes=Buffer.from(canonical({kind:'fields',issues:[{path:e.field,code:e.reason}]})),details=slot?this.objects.putMetadataInSlot(detailBytes,slot):this.objects.putMetadata(detailBytes);this.register('receipt:'+c.commandId,details);receipt={status:'rejected',commandId:c.commandId,code:e.code,currentRevision:null,details};}
      commandAcceptances.validated(c.commandId,hash,receipt);this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run(c.commandId,hash,utf8View(bytes),serialized,canonical(receipt));this.db.prepare('DELETE FROM portable_preparations WHERE id=?').run(c.commandId);this.barrier('portable-before-commit');this.fence(this.epoch);this.db.exec('COMMIT');append?.end('ok',{boundary:'authority-durable'});commandAcceptances.durable(c.commandId,hash,receipt);this.barrier('portable-after-commit');if(c.body.type==='ImportBundle')this.barrier('portable-import-after-commit');this.recovery.maintain();return receipt;
    }catch(e){append?.end('error');if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }
  protocolDefaults(): void {
    // A fixed safe precondition value makes the existing narrow commands usable
    // on a new root. This is not arbitrary blob upload or repair of missing roots.
    if(this.missingCount)return;
    for(const value of [{owner:'raster-import-cancellation',json:RASTER_IMPORT_CANCELLATION_JSON,ref:RASTER_IMPORT_CANCELLATION_REF},{owner:'empty-versions',json:canonical({entities:[],schemaVersion:1}),ref:EMPTY_EXPECTED_VERSIONS},{owner:'export-cancellation',json:EXPORT_CANCELLATION_JSON,ref:EXPORT_CANCELLATION_REF},{owner:'encoded-review-cancellation',json:ENCODED_REVIEW_CANCELLATION_JSON,ref:ENCODED_REVIEW_CANCELLATION_REF}]){
      const owner='protocol-default:'+value.owner;if(this.db.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=? AND media_type=?').get(owner,value.ref.hash,value.ref.mediaType))continue;
      const ref=this.db.prepare('SELECT 1 FROM objects WHERE hash=?').get(value.ref.hash)?value.ref:this.objects.putMetadata(Buffer.from(value.json));if(canonical(ref)!==canonical(value.ref))throw new StoreError('CORRUPT_STORE');
      this.db.exec('BEGIN IMMEDIATE');
      try{this.register(owner,ref);this.db.exec('COMMIT');}
      catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
    }
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
    if(oldHash)this.histories.discardEncodedReviewSession(oldHash);
  }
  forgetClient(cookieHash: string) { this.db.prepare('DELETE FROM client_bindings WHERE cookie_hash=?').run(cookieHash);this.histories.discardEncodedReviewSession(cookieHash); }
  health() {
    this.check(); const fs = statfsSync(this.root,{bigint:true});
    return { missingCount: this.missingCount, diskWarning: (fs.blocks-fs.bavail)*100n >= fs.blocks*80n, snapshotPressure: this.recovery.snapshotFailure || this.assets.pressure() || this.rasters.pressure() || this.histories.pressure() };
  }
  diagnostics(phases:PhaseSnapshot,rasters:ReturnType<Rasters['readDiagnostics']>['value'],textObservations:readonly Record<string,unknown>[],historyObservations:readonly Record<string,unknown>[],portableObservations:readonly Record<string,unknown>[]) {
    this.check(); const filesystem = statfsSync(this.root, { bigint: true });
    const pragma = (name: string) => Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0];
    // Reject an oversized row before selecting its JSON into this process.
    // The caller has already admitted the fixed parse/canonical workspace.
    if(this.db.prepare('SELECT 1 FROM documents WHERE length(CAST(json AS BLOB))>1048576 LIMIT 1').get())throw new StoreError('CAPACITY');
    const projectionHash = createHash('sha256'); projectionHash.update('['); let first = true;
    for (const row of this.db.prepare('SELECT json FROM documents ORDER BY id').iterate()) { if (!first) projectionHash.update(','); first = false; projectionHash.update(canonical(JSON.parse(String(row.json)))); }
    projectionHash.update(']'); const digest = 'sha256:' + projectionHash.digest('hex'),registered=this.db.prepare('SELECT 1 FROM objects WHERE hash=?');
    return { node: process.versions.node, sqlite: this.db.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source').get(),
      settings: Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout', 'fullfsync', 'checkpoint_fullfsync', 'page_size', 'page_count', 'max_page_count'].map(k => [k, pragma(k)])),
      writerEpoch: this.epoch, highWater: this.meta('highWater'), projectionDigest: digest,
      inventory: this.objects.diagnosticInventory(hash=>!!registered.get(hash)),
      missingCount: this.missingCount, missing: this.missing,
      filesystem: { type: String(filesystem.type), blockSize: String(filesystem.bsize), availableBytes: String(filesystem.bavail * filesystem.bsize), totalBytes: String(filesystem.blocks * filesystem.bsize) },
      diskWarning: (filesystem.blocks - filesystem.bavail) * 100n >= filesystem.blocks * 80n,
      resources: { ioChunkBytes: 1048576, maxTransfers: 2, admissionOverheadPercent: 25, freeMarginBytes: '1073741824', metadataHeadroomBytes: '67108864', metadataHeadroomPhysicallyPreallocated: false, snapshotTailCeiling: 500 },
      assets: this.assets.diagnostics(),
      rasters,
      display: this.displays.diagnostics(),
      text: {observations:textObservations,droppedObservations:this.texts.droppedObservations,reservedCPU:this.texts.reservedCPU,externalBytes:this.texts.externalBytes()},
      history: {observations:historyObservations,droppedObservations:this.histories.droppedObservations},
      portable: {observations:portableObservations,droppedObservations:this.portables.droppedObservations},
      observations: { phases,pendingAcceptanceSpans:commandAcceptances.pending,pendingLocalQueueSpans:localQueuePhases.pending, appendMs: this.appendMs, replayMs: this.replayMs, snapshot: { target: 250, pressure: this.recovery.snapshotFailure, latest: this.recovery.latest()?.seq ?? null,
        buildMs: this.recovery.snapshotBuildMs, sliceMaxMs: this.recovery.snapshotSliceMaxMs, activationMs: this.recovery.snapshotActivationMs }, qualification: false },
      processMemory: process.memoryUsage(), sqliteIntegrity: this.db.prepare('PRAGMA quick_check').get() };
  }
  close() {
    if (this.closed) return;
    commandAcceptances.close();localQueuePhases.close();this.texts.closeObservations();this.objects.close(); this.db.close(); this.closed = true;
  }
}

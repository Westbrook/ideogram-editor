import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobRef } from '../../src/protocol/store.js';
import type { Asset } from '../../src/protocol/assets.js';
import { fontVersion } from '../../src/protocol/text.js';
import { assertIdentity, bundledFont } from '../text/validation.js';
import type { StorageRepairRequest, StorageRepairResult, StorageRepairReview } from '../../src/protocol/storage-repair.js';
import { storageRepairRequest, storageRepairResult, storageRepairReview } from '../../src/protocol/storage-repair.js';
import type { AssetAuth, Assets } from './assets.js';
import { canonical, hashBytes, isId, validateBlob } from './canonical.js';
import { StoreError } from './errors.js';
import { assertComponents, assertPrivate, sameFile } from './files.js';
import { IO_CHUNK, type Objects } from './objects.js';
import { repairOwnership } from './repair-ownership.js';
import type { StorageLibraryMemory, StorageLibraryScope } from './library-memory.js';

type Authority = { asset: string; owner: string; binding: string; ref: BlobRef };
type Review = { value: StorageRepairReview; authority: Authority; clientId: string; sessionHash: string };
type Operation = { identity: string; expires: number; work?: Promise<StorageRepairResult> };

/** Restores only exact physically missing/corrupt bytes with a typed live owner.
 * This emits no document/history event and creates no replacement asset/root. */
export class StorageRepairs {
  private reviews = new Map<string, Review>();
  private operations = new Map<string, Operation>();
  private inspections = new Set<Promise<StorageRepairReview>>();
  private busy: string | undefined;
  private closed = false;
  constructor(private db: DatabaseSync, private objects: Objects, private assets: Assets,
    private root: string, private epoch: string, private check: () => void,
    private authorize: (auth: AssetAuth) => void, private hasReaders: (scope: StorageLibraryScope) => boolean,
    private refreshed: (hash: string) => void, private memory: StorageLibraryMemory) {}

  private guard(auth: AssetAuth) {
    this.check(); if (this.closed) throw new StoreError('CLOSED'); this.authorize(auth);
    if (!isId(auth.clientId) || !Number.isFinite(auth.expires) || Date.now() >= auth.expires) throw new StoreError('OWNER_REQUIRED');
  }
  private authority(assetId: string, hash: string): Authority {
    if (!isId(assetId) || !/^sha256:[a-f0-9]{64}$/.test(hash)) throw new StoreError('MALFORMED_REQUEST');
    const row = this.db.prepare('SELECT CASE WHEN length(CAST(json AS BLOB))<=65536 THEN json ELSE NULL END AS json FROM assets WHERE id=?').get(assetId);
    if (!row) throw new StoreError('NOT_FOUND'); if (row.json === null) throw new StoreError('CAPACITY');
    const text = String(row.json), asset = JSON.parse(text) as Asset;
    if (['withheld', 'quarantined'].includes(asset.safety)) throw new StoreError('CONTENT_WITHHELD');
    const font = asset.purpose === 'font' || !!asset.font || asset.qualification === 'font';
    if (font) {
      // This restores accepted metadata's bytes; it does not inspect/import a
      // new font or grant permission to substitute a different version.
      if (asset.purpose !== 'font' || asset.qualification !== 'font' || asset.safety !== 'safe' || !asset.font) throw new StoreError('CONTENT_WITHHELD');
      try { fontVersion(asset.font); assertIdentity(asset.font); bundledFont(asset.font); } catch { throw new StoreError('CONTENT_WITHHELD'); }
      if (canonical(asset.blob) !== canonical(asset.font.bytes) || asset.dependencies.length !== 1 || canonical(asset.dependencies[0]) !== canonical(asset.font.licenseRecord) || asset.retainedMetadata) throw new StoreError('CONTENT_WITHHELD');
    }
    const matches = [asset.blob, ...asset.dependencies, ...(asset.retainedMetadata ? [asset.retainedMetadata] : [])].filter(r => r.hash === hash);
    if (!matches.length || matches.some(r => canonical(r) !== canonical(matches[0]))) throw new StoreError('NOT_FOUND');
    const ref = { ...matches[0] }; validateBlob(ref);
    if (ref.byteLength.length > 20 || (!font && ref.mediaType.startsWith('font/'))) throw new StoreError('CONTENT_WITHHELD');
    if (!font && this.db.prepare("SELECT 1 FROM assets a WHERE (json_extract(a.json,'$.purpose')='font' OR json_extract(a.json,'$.qualification')='font') AND (json_extract(a.json,'$.blob.hash')=? OR EXISTS (SELECT 1 FROM json_each(a.json,'$.dependencies') d WHERE json_extract(d.value,'$.hash')=?)) LIMIT 1").get(hash, hash)) throw new StoreError('CONTENT_WITHHELD');
    const object = this.db.prepare('SELECT CASE WHEN length(byte_length)<=20 THEN byte_length ELSE NULL END AS byte_length FROM objects WHERE hash=?').get(hash);
    if (!object || String(object.byte_length) !== ref.byteLength) throw new StoreError('CORRUPT_STORE');
    const ownership = repairOwnership(this.db, asset, ref);
    return { asset: text, ...ownership, ref };
  }
  private prune() {
    for (const [id, item] of this.reviews) if (Date.now() >= Date.parse(item.value.expiresAt)) this.reviews.delete(id);
    for (const [id, item] of this.operations) if (!item.work && Date.now() >= item.expires) this.operations.delete(id);
  }
  review(assetId: string, hash: string, auth: AssetAuth, scope: StorageLibraryScope): Promise<StorageRepairReview> {
    scope = Object.freeze({ loanId: scope?.loanId, registryId: scope?.registryId, kind: scope?.kind });
    const loan = this.memory.enter(scope, 'review');
    const work = this.inspect(assetId, hash, Object.freeze({ ...auth }), loan.check).finally(() => { this.inspections.delete(work); loan.release(); });
    this.inspections.add(work); return work;
  }
  private async inspect(assetId: string, hash: string, auth: AssetAuth, memoryCheck: () => void): Promise<StorageRepairReview> {
    memoryCheck(); this.guard(auth); this.prune(); if (this.reviews.size + this.inspections.size >= 32) throw new StoreError('CAPACITY');
    const authority = this.authority(assetId, hash);
    const guard = () => { memoryCheck(); this.guard(auth); if (canonical(this.authority(assetId, hash)) !== canonical(authority)) throw new StoreError('REVIEW_EXPIRED'); };
    const target = await this.objects.inspectRepair(authority.ref, guard); guard();
    const value = { protocolVersion: 1 as const, reviewId: randomUUID(), assetId,
      assetVersion: JSON.parse(authority.asset).version, ref: { ...authority.ref }, owner: authority.owner,
      condition: target.condition, targetIdentity: target.identity,
      staging: { purpose: 'text' as const, mediaType: 'application/octet-stream' as const },
      expiresAt: new Date(Math.min(auth.expires, Date.now() + 10 * 60 * 1000)).toISOString() };
    const review: StorageRepairReview = { ...value, reviewHash: hashBytes(canonical({ ...value, epoch: this.epoch, clientId: auth.clientId, sessionHash: auth.sessionHash, authority })) };
    storageRepairReview(review);
    this.reviews.set(review.reviewId, { value: structuredClone(review), authority, clientId: auth.clientId, sessionHash: auth.sessionHash }); return review;
  }
  repair(assetId: string, value: unknown, auth: AssetAuth, scope: StorageLibraryScope): Promise<StorageRepairResult> {
    scope = Object.freeze({ loanId: scope?.loanId, registryId: scope?.registryId, kind: scope?.kind });
    const loan = this.memory.enter(scope, 'repair');
    try {
      loan.check(); auth = Object.freeze({ ...auth }); this.guard(auth); this.prune();
      try { storageRepairRequest(value); } catch { throw new StoreError('MALFORMED_REQUEST'); }
      if (!isId(assetId)) throw new StoreError('MALFORMED_REQUEST');
      const request = Object.freeze({ ...value }), identity = hashBytes(canonical({ assetId, request, clientId: auth.clientId, sessionHash: auth.sessionHash, epoch: this.epoch }));
      let operation = this.operations.get(request.operationId);
      if (operation && operation.identity !== identity) throw new StoreError('COMMAND_ID_REUSE');
      if (operation?.work) throw new StoreError('CAPACITY');
      if (this.busy || (!operation && this.operations.size >= 64)) throw new StoreError('CAPACITY');
      if (!operation) { operation = { identity, expires: Date.now() + 10 * 60 * 1000 }; this.operations.set(request.operationId, operation); }
      this.busy = request.operationId;
      const owned = operation, work = this.restore(assetId, request, auth, scope, loan.check).finally(() => { owned.work = undefined; this.busy = undefined; loan.release(); });
      owned.work = work; return work;
    } catch (error) { loan.release(); throw error; }
  }
  private async restore(assetId: string, request: StorageRepairRequest, auth: AssetAuth, memoryScope: StorageLibraryScope, memoryCheck: () => void): Promise<StorageRepairResult> {
    const review = this.reviews.get(request.reviewId);
    if (!review || review.value.assetId !== assetId || review.value.reviewHash !== request.reviewHash || review.clientId !== auth.clientId || review.sessionHash !== auth.sessionHash) throw new StoreError('REVIEW_EXPIRED');
    const scope = () => {
      memoryCheck(); this.guard(auth);
      if (Date.now() >= Date.parse(review.value.expiresAt) || canonical(this.authority(assetId, review.value.ref.hash)) !== canonical(review.authority)) throw new StoreError('REVIEW_EXPIRED');
      if (this.hasReaders(memoryScope)) throw new StoreError('CAPACITY');
    };
    const stageRecord = () => {
      scope();
      const bounded = this.db.prepare('SELECT length(CAST(json AS BLOB)) AS bytes FROM staged_assets WHERE id=?').get(request.stagingId);
      if (bounded && Number(bounded.bytes) > 65536) throw new StoreError('CAPACITY');
      const record = this.assets.get(request.stagingId, auth);
      const retried = record.state === 'finalized' && (record.version === request.expectedStagingVersion || record.version === String(BigInt(request.expectedStagingVersion) + 1n)) && canonical(record.assetRef) === canonical(review.value.ref);
      if (record.ownerClientId !== auth.clientId || (!retried && (record.version !== request.expectedStagingVersion || record.state !== 'complete')) || record.committedOffset !== record.expectedBytes) throw new StoreError('REVIEW_EXPIRED');
      if (record.sha256 !== review.value.ref.hash || record.expectedBytes !== review.value.ref.byteLength || record.purpose !== review.value.staging.purpose || record.mediaType !== review.value.staging.mediaType) throw new StoreError('CORRUPT_OBJECT');
      if (this.db.prepare('SELECT 1 FROM asset_preparations WHERE staging_id=?').get(request.stagingId) || this.db.prepare('SELECT 1 FROM portable_review_sources WHERE staging_id=?').get(request.stagingId) || this.db.prepare("SELECT 1 FROM portable_preparations WHERE json_extract(frozen,'$.stagingId')=?").get(request.stagingId)) throw new StoreError('CAPACITY');
      return record;
    };
    const record = stageRecord(), stageIdentity = canonical(record);
    const guard = () => { if (canonical(stageRecord()) !== stageIdentity) throw new StoreError('REVIEW_EXPIRED'); };
    const sourceRow = this.db.prepare('SELECT CASE WHEN length(filename)<=128 THEN filename ELSE NULL END AS filename FROM staged_assets WHERE id=?').get(request.stagingId);
    if (!sourceRow || !isId(sourceRow.filename)) throw new StoreError('CORRUPT_STORE');
    const source = join(this.root, 'uploads', sourceRow.filename), directory = dirname(source);
    assertComponents(directory); assertPrivate(directory, true); const original = assertPrivate(source, false);
    if (String(original.size) !== record.expectedBytes) throw new StoreError('CORRUPT_OBJECT');
    let fd: number | undefined, stage: string | undefined, token: string | undefined;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!sameFile(original, fstatSync(fd))) throw new StoreError('ROOT_UNSAFE');
      const sourceUnchanged = () => {
        guard(); const now = assertPrivate(source, false), held = fstatSync(fd!);
        if (!sameFile(original, now) || !sameFile(original, held) || now.size !== original.size || held.size !== original.size || now.mtimeMs !== original.mtimeMs || now.ctimeMs !== original.ctimeMs || held.mtimeMs !== original.mtimeMs || held.ctimeMs !== original.ctimeMs) throw new StoreError('CORRUPT_OBJECT');
        if (this.db.prepare('SELECT CASE WHEN length(filename)<=128 THEN filename ELSE NULL END AS filename FROM staged_assets WHERE id=?').get(request.stagingId)?.filename !== sourceRow.filename) throw new StoreError('CORRUPT_STORE');
      };
      token = await this.objects.beginRepair(review.value.ref, { condition: review.value.condition, identity: review.value.targetIdentity }, sourceUnchanged);
      sourceUnchanged(); stage = this.objects.begin(review.value.ref.byteLength, review.value.ref.mediaType, review.value.ref.hash);
      const expected = BigInt(record.expectedBytes), buffer = Buffer.alloc(Number(expected < BigInt(IO_CHUNK) ? expected + 1n : BigInt(IO_CHUNK))); let at = 0n;
      for (;;) { sourceUnchanged(); const n = readSync(fd, buffer); if (!n) break; at += BigInt(n); if (at > expected) throw new StoreError('CORRUPT_OBJECT'); this.objects.chunk(stage, buffer.subarray(0, n)); await new Promise<void>(resolve => setImmediate(resolve)); }
      if (at !== expected) throw new StoreError('CORRUPT_OBJECT');
      await this.objects.prepareRepair(stage, token, sourceUnchanged); sourceUnchanged();
      const published = this.objects.finishRepair(stage, token, sourceUnchanged); stage = undefined;
      scope(); this.objects.repairProven(review.value.ref, token);
      // Only transfer bookkeeping changes. No event, root, accepted asset,
      // history node, document revision or projection format is rewritten.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        sourceUnchanged(); this.objects.repairProven(review.value.ref, token);
        if (record.state !== 'finalized') {
          const finalized = { ...record, state: 'finalized', version: String(BigInt(record.version) + 1n), assetRef: { ...review.value.ref } };
          this.db.prepare('UPDATE staged_assets SET json=? WHERE id=?').run(canonical(finalized), request.stagingId);
        }
        this.check(); this.db.exec('COMMIT');
      } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
      scope(); this.objects.repairProven(review.value.ref, token); this.refreshed(review.value.ref.hash);
      this.objects.unreserve('upload:' + request.stagingId);
      const result: StorageRepairResult = { protocolVersion: 1, operationId: request.operationId, status: published.previousCondition === 'available' ? 'already-available' : 'restored', assetId, assetVersion: review.value.assetVersion, ref: { ...review.value.ref }, previousCondition: published.previousCondition };
      storageRepairResult(result); return result;
    } finally {
      try { if (fd !== undefined) closeSync(fd); }
      finally { try { if (stage !== undefined) this.objects.abort(stage); } finally { if (token !== undefined) this.objects.releaseRepair(token); } }
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.inspections, ...[...this.operations.values()].flatMap(op => op.work ? [op.work] : [])]); this.reviews.clear(); this.operations.clear(); }
}

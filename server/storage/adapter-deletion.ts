import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AdapterDeletionDependency, AdapterDeletionPlan } from '../../src/protocol/adapters.js';
import type { Asset, AssetFact } from '../../src/protocol/assets.js';
import type { BlobRef, Receipt } from '../../src/protocol/store.js';
import { canonical, hashBytes, isId, parseCommand } from './canonical.js';
import { AssetRejection, type Assets, type AssetAuth } from './assets.js';
import { StoreError } from './errors.js';
import type { Objects } from './objects.js';
import { assertComponents, assertPrivate } from './files.js';
import { maskDraftValue, resolveMaskPlan } from '../../src/raster/mask.js';

type Commit = (bytes: Uint8Array, build: () => AssetFact, slot?: string) => Receipt;
type DependencyKind = AdapterDeletionDependency['kind'];
const MAX_METADATA = 16777216;
const MAX_SCAN_BYTES = 67108864;

/** Immutable preview and deletion facts use the existing asset replay and snapshot
 * path. A deletion removes selection authority, never historical byte roots. */
export class AdapterDeletions {
  constructor(private db: DatabaseSync, private objects: Objects, private assets: Assets,
    private check: () => void, private commit: Commit,
    private register: (owner: string, ref: BlobRef, proof?: string) => void) {}

  private owner(auth: AssetAuth): string {
    this.check();
    const binding = this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);
    if (!binding || binding.client_id !== auth.clientId || auth.now >= auth.expires || auth.now >= Number(binding.expires)) throw new StoreError('OWNER_REQUIRED');
    return hashBytes(canonical({ client: auth.clientId, session: auth.sessionHash,
      epoch: String(this.db.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get()!.value) }));
  }
  private version(id: string): Asset {
    if (!isId(id)) throw new StoreError('MALFORMED_REQUEST');
    const asset = this.assets.asset(id);
    if (!asset?.adapter || asset.qualification !== 'adapter-version') throw new AssetRejection('MISSING_ASSET', 'ADAPTER_VERSION_UNAVAILABLE');
    if (this.deleted(id)) throw new AssetRejection('STALE_REVISION', 'ADAPTER_VERSION_DELETED');
    return asset;
  }
  private deleted(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM assets WHERE json_extract(json,'$.qualification')='adapter-deletion' AND json_extract(json,'$.adapterDeletion.kind')='deleted' AND json_extract(json,'$.adapterDeletion.versionId')=? LIMIT 1").get(id);
  }
  private read(ref: BlobRef): unknown {
    if (BigInt(ref.byteLength) > BigInt(MAX_METADATA)) throw new StoreError('PAYLOAD_TOO_LARGE');
    this.objects.verify(ref);
    const bytes = Buffer.alloc(Number(ref.byteLength));
    for (let at = 0; at < bytes.length; at += 1048576) bytes.set(this.objects.readRange(ref, String(at), Math.min(1048576, bytes.length - at)), at);
    return JSON.parse(bytes.toString('utf8'));
  }

  /** Only typed identity fields count; a coincidental ID in user text does not.
   * Inspect retained image metadata as well as current projections, so undo,
   * branches, portable provenance and cross-document adoption remain protected. */
  private dependencies(versionId: string) {
    const reasons: AdapterDeletionDependency[] = [], fingerprints = new Map<string, string>();
    const hash = createHash('sha256'); let reasonBytes = 0;
    const add = (kind: DependencyKind, id: string, detail: string, identity: unknown) => {
      const key = kind + ':' + id, fingerprint = hashBytes(canonical(identity));
      if (fingerprints.has(key)) return;
      fingerprints.set(key, fingerprint);
      const reason = { kind, id, detail }, bytes = Buffer.byteLength(canonical(reason));
      if (reasons.length < 128 && reasonBytes + bytes <= 48000) { reasons.push(reason); reasonBytes += bytes; }
    };
    const references = (v: any): boolean => !!v && typeof v === 'object' && Array.isArray(v.adapters) && v.adapters.some((a: any) => a?.version === versionId);
    const jobs = new Set<string>(), attempts = new Set<string>(), candidates = new Set<string>(), candidateAssets = new Set<string>();
    for (const row of this.db.prepare('SELECT id,json FROM queue_jobs ORDER BY id').iterate()) {
      const job = JSON.parse(String(row.json));
      if (!references(job.review?.request)) continue;
      jobs.add(String(row.id)); for (const attempt of job.attempts ?? []) attempts.add(attempt.id);
      if (job.disposition !== 'deleted') add('job', String(row.id), 'Retained request, job and result provenance use this exact adapter version.', job);
    }
    for (const row of this.db.prepare("SELECT namespace,id,json FROM portable_rows WHERE kind='job-result' ORDER BY namespace,id").iterate()) {
      const result = JSON.parse(String(row.json));
      const retained = result.request, attached = retained?.specification?.adapters;
      if (Array.isArray(attached) && attached.some((a: any) => (retained.assetBindings?.[a.version] ?? a.version) === versionId)) {
        jobs.add(result.jobId); attempts.add(result.id);
        add('provenance', String(row.namespace) + ':' + String(row.id), 'Imported result provenance retains this exact adapter version.', result);
      }
    }
    for (const row of this.db.prepare("SELECT id,json FROM assets WHERE json_extract(json,'$.qualification')='adapter-version' AND id!=? ORDER BY id").iterate(versionId)) {
      const asset = JSON.parse(String(row.json));
      if (Object.values(asset.adapter?.sources ?? {}).includes(versionId)) add('provenance', 'adapter:' + String(row.id), 'Another immutable adapter version retains this version as an original source.', asset);
    }
    // Include candidate journal identities after document deletion. An adopted
    // image in another live document can still refer to the retained result.
    const expandCandidates = () => { for (const row of this.db.prepare("SELECT id,json FROM candidates UNION ALL SELECT id,json FROM candidate_journal WHERE family='candidate' UNION ALL SELECT id,json FROM portable_rows WHERE kind='candidate-result'").iterate()) {
      const candidate = JSON.parse(String(row.json));
      if (!jobs.has(candidate.jobId)) continue;
      candidates.add(candidate.id);
      for (const id of [candidate.encodedAssetId, candidate.preparedAssetId]) if (id) candidateAssets.add(id);
    } };
    expandCandidates();
    let scannedBytes = 0;
    const cache = new Map<string, { value?: unknown; error?: string }>();
    const load = (ref: BlobRef): unknown => {
      let entry = cache.get(ref.hash);
      if (!entry) {
        scannedBytes += Number(ref.byteLength);
        if (!Number.isSafeInteger(scannedBytes) || scannedBytes > MAX_SCAN_BYTES) throw Error('Retained metadata exceeds the bounded dependency inspection.');
        try { entry = { value: this.read(ref) }; }
        catch { entry = { error: 'Retained metadata is missing, corrupt or exceeds the per-object inspection limit.' }; }
        cache.set(ref.hash, entry);
      }
      if (entry.error) throw Error(entry.error);
      return entry.value;
    };
    const inspectAsset = (id: string, visited: Set<string>, depth: number): boolean => {
      if (depth > 128) throw Error('Asset ancestry exceeds the bounded dependency inspection.');
      if (id === versionId || candidateAssets.has(id)) return true;
      if (visited.has('asset:' + id)) return false;
      visited.add('asset:' + id);
      const asset = this.assets.asset(id);
      if (!asset) throw Error('A referenced asset is unavailable for dependency inspection.');
      if (asset.raster) {
        if (asset.raster.sourceAssetIds.some(source => inspectAsset(source, visited, depth + 1))) return true;
        // sourceAssetIds is the sealed raster ancestry closure. Pixel/manifest
        // files may already be collected for a deleted source document.
        return false;
      }
      return false;
    };
    const inspect = (value: unknown, visited = new Set<string>(), depth = 0): boolean => {
      if (depth > 128) throw Error('Metadata nesting exceeds the bounded dependency inspection.');
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.some(v => inspect(v, visited, depth + 1));
      const v = value as Record<string, any>;
      if (references(v) || v.adapterVersionId === versionId || v.assetId === versionId || jobs.has(v.jobId) || attempts.has(v.attemptId) || candidates.has(v.candidateId) || candidateAssets.has(v.assetId) || candidateAssets.has(v.compositeAssetId)) return true;
      if (typeof v.hash === 'string' && typeof v.byteLength === 'string' && v.mediaType === 'application/json') {
        if (visited.has(v.hash)) return false;
        visited.add(v.hash);
        return inspect(load(v as BlobRef), visited, depth + 1);
      }
      for (const key of ['assetId', 'compositeAssetId', 'preparedAssetId', 'encodedAssetId', 'sourceAssetId']) if (typeof v[key] === 'string' && inspectAsset(v[key], visited, depth + 1)) return true;
      return Object.values(v).some(child => inspect(child, visited, depth + 1));
    };
    const examine = (kind: DependencyKind, id: string, value: unknown, detail: string) => {
      try { if (inspect(value)) add(kind, id, detail, value); }
      catch (error) { add('unavailable', kind + ':' + id, error instanceof Error ? error.message : 'Dependency inspection unavailable.', value); }
    };
    // Provider transforms can form a chain of results. Propagate typed source
    // ancestry even through deleted intermediate jobs before inspecting live
    // documents and drafts that may retain their outputs.
    const sourceAncestry = (request: any, bindings?: Record<string, string>): boolean => {
      for (const source of [request?.source, request?.mask]) if (source?.assetId && inspectAsset(bindings?.[source.assetId] ?? source.assetId, new Set(), 0)) return true;
      return false;
    };
    let changed = true, rounds = 0;
    while (changed && rounds++ < 128) {
      changed = false;
      for (const row of this.db.prepare('SELECT id,json FROM queue_jobs ORDER BY id').iterate()) {
        if (jobs.has(String(row.id))) continue;
        const job = JSON.parse(String(row.json));
        try {
          if (sourceAncestry(job.review?.request)) {
            jobs.add(String(row.id)); for (const attempt of job.attempts ?? []) attempts.add(attempt.id); changed = true;
            if (job.disposition !== 'deleted') add('job', String(row.id), 'Retained request source ancestry depends on a result created with this adapter.', job);
          }
        } catch { add('unavailable', 'job:' + String(row.id), 'Retained job source ancestry is unavailable for complete dependency inspection.', job); }
      }
      for (const row of this.db.prepare("SELECT namespace,id,json FROM portable_rows WHERE kind='job-result' ORDER BY namespace,id").iterate()) {
        const result = JSON.parse(String(row.json)); if (jobs.has(result.jobId)) continue;
        try {
          if (sourceAncestry(result.request?.specification, result.request?.assetBindings)) {
            jobs.add(result.jobId); attempts.add(result.id); changed = true;
            add('provenance', String(row.namespace) + ':' + String(row.id), 'Imported request source ancestry depends on a result created with this adapter.', result);
          }
        } catch { add('unavailable', 'provenance:' + String(row.namespace) + ':' + String(row.id), 'Imported result source ancestry is unavailable for complete dependency inspection.', result); }
      }
      if (changed) expandCandidates();
    }
    if (changed) add('unavailable', 'provider-source-ancestry', 'Provider source ancestry exceeds the bounded dependency inspection.', { versionId, rounds });
    const liveDrafts = new Map<string, any>();
    for (const row of this.db.prepare('SELECT client_id,session_id,json FROM ui_checkpoints ORDER BY client_id,session_id').iterate()) {
      const state = JSON.parse(String(row.json));
      for (const draft of state.drafts) {
        const id = String(row.client_id) + ':' + String(row.session_id) + ':' + draft.id;
        liveDrafts.set(id, draft);
        if (!['request', 'mask', 'composition', 'text'].includes(draft.kind)) continue;
        const asset = this.assets.asset(draft.assetId);
        if (!asset) { add('unavailable', 'draft:' + id, 'Saved request draft metadata is unavailable.', draft); continue; }
        try {
          let content = load(asset.blob);
          if (draft.kind === 'mask') { maskDraftValue(content); content = { ...content, plan: resolveMaskPlan(content.plan, draft.maskBindings ?? {}) }; }
          if (inspect(content)) add('draft', id, 'A saved draft selects this adapter or depends on a result created with it.', { draft, content: asset.blob });
        } catch (error) { add('unavailable', 'draft:' + id, error instanceof Error ? error.message : 'Saved draft metadata is unavailable.', { draft, content: asset.blob }); }
      }
    }
    for (const row of this.db.prepare("SELECT client_id,id,json FROM ui_receipts WHERE json_extract(json,'$.review') IS NOT NULL ORDER BY client_id,id").iterate()) {
      const receipt = JSON.parse(String(row.json)), review = receipt.review;
      const draft = liveDrafts.get(String(row.client_id) + ':' + review.draft.sessionId + ':' + review.draft.draftId);
      if (draft && draft.generation === review.draft.generation && draft.assetId === review.draftAsset && references(review.request)) add('review', String(row.client_id) + ':' + String(row.id), 'A current request review selects this exact adapter version.', review);
    }
    for (const [kind, table] of [['document', 'documents'], ['history', 'history'], ['checkpoint', 'checkpoints']] as const) {
      for (const row of this.db.prepare(`SELECT id,json FROM ${table} ORDER BY id`).iterate()) examine(kind, String(row.id), JSON.parse(String(row.json)), 'Retained ' + kind + ' metadata depends on this adapter or a result created with it.');
    }
    // Pending adoption work can survive a UI change or recover after a crash.
    for (const table of ['history_preparations', 'portable_preparations'] as const) {
      for (const row of this.db.prepare(`SELECT id,canonical,frozen FROM ${table} ORDER BY id`).iterate()) {
        const command = JSON.parse(String(row.canonical)), frozen = JSON.parse(String(row.frozen)), value = { command, frozen }, id = table + ':' + String(row.id);
        examine('provenance', id, value, 'Prepared durable work retains this adapter or its candidate provenance.');
        if (table === 'portable_preparations' && command.command.body.type === 'SaveCopy') {
          try {
            const main = this.db.prepare('PRAGMA database_list').all().find(r => r.name === 'main');
            if (!main?.file || !isId(frozen.capture) || typeof frozen.captureHash !== 'string') throw Error();
            const path = join(dirname(String(main.file)), 'portable', frozen.capture, 'capture.sqlite');
            assertComponents(dirname(path)); const before = assertPrivate(path, false);
            scannedBytes += before.size;
            if (!Number.isSafeInteger(scannedBytes) || scannedBytes > MAX_SCAN_BYTES) throw Error();
            const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), captureHash = createHash('sha256');
            try { const block = Buffer.alloc(1048576); for (;;) { const size = readSync(fd, block); if (!size) break; captureHash.update(block.subarray(0, size)); } } finally { closeSync(fd); }
            if ('sha256:' + captureHash.digest('hex') !== frozen.captureHash) throw Error();
            const capture = new DatabaseSync(path, { readOnly: true }); let dependency = false;
            try { for (const asset of capture.prepare("SELECT id FROM entities WHERE kind='asset' ORDER BY id").iterate()) if (asset.id === versionId || candidateAssets.has(String(asset.id))) { dependency = true; break; } } finally { capture.close(); }
            const after = assertPrivate(path, false);
            if (canonical([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]) !== canonical([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs])) throw Error();
            if (dependency) add('provenance', id, 'A pending SaveCopy capture retains this adapter version or a result created with it.', value);
          } catch { add('unavailable', id, 'The pending SaveCopy capture cannot be fully verified within the dependency inspection budget. Finish or cancel that copy before deletion.', value); }
        }
      }
    }
    for (const [key, fingerprint] of [...fingerprints].sort(([a], [b]) => a.localeCompare(b))) hash.update(canonical([key, fingerprint]));
    return { dependencies: reasons.sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id)), dependencyCount: fingerprints.size,
      dependenciesTruncated: fingerprints.size > reasons.length, dependencyHash: 'sha256:' + hash.digest('hex'), canDelete: fingerprints.size === 0 };
  }

  private fact(id: string, record: NonNullable<Asset['adapterDeletion']>, value: unknown): AssetFact {
    const blob = this.objects.putMetadata(Buffer.from(canonical(value)));
    const asset: Asset = { id, version: '1', purpose: 'adapter', blob, dependencies: [], safety: 'unknown', availability: 'available',
      qualification: 'adapter-deletion', measuredMediaType: 'application/octet-stream', adapterDeletion: record };
    this.register('asset:' + id, blob);
    return { type: 'AssetRegistered', payload: { asset } };
  }
  review(planId: string, auth: AssetAuth): AdapterDeletionPlan {
    const owner = this.owner(auth);
    if (!isId(planId)) throw new StoreError('MALFORMED_REQUEST');
    const asset = this.assets.asset(planId), record = asset?.adapterDeletion;
    if (!asset || record?.kind !== 'preview' || record.planId !== planId) throw new StoreError('NOT_FOUND');
    const plan = this.read(asset.blob) as AdapterDeletionPlan, { token, ...unsigned } = plan;
    if (plan.kind !== 'adapter-deletion-plan-1' || plan.id !== planId || plan.versionId !== record.versionId || token !== record.token || token !== hashBytes(canonical(unsigned))) throw new StoreError('CORRUPT_OBJECT');
    if (plan.owner !== owner) throw new StoreError('OWNER_REQUIRED');
    return plan;
  }
  command(bytes: Uint8Array, auth: AssetAuth): Receipt {
    const owner = this.owner(auth), command = parseCommand(bytes).command, body = command.body;
    if (command.clientId !== auth.clientId) throw new StoreError('OWNER_REQUIRED');
    if (body.type !== 'PreviewAdapterDeletion' && body.type !== 'DeleteAdapterVersion') throw new StoreError('UNSUPPORTED_COMMAND');
    return this.commit(bytes, () => {
      this.owner(auth);
      const asset = this.version(body.versionId), version = asset.adapter!;
      if (body.type === 'PreviewAdapterDeletion') {
        const id = randomUUID(), unsigned = { kind: 'adapter-deletion-plan-1' as const, id, versionId: version.id, adapterId: version.adapterId,
          version: version.version, weights: version.weights, owner, sessionId: command.sessionId, ...this.dependencies(version.id), actualFreedBytes: '0' as const, bytesRetained: true as const };
        const plan: AdapterDeletionPlan = { ...unsigned, token: hashBytes(canonical(unsigned)) };
        return this.fact(id, { kind: 'preview', versionId: version.id, planId: id, token: plan.token }, plan);
      }
      let plan: AdapterDeletionPlan;
      try { plan = this.review(body.planId, auth); }
      catch (error) { if (error instanceof StoreError && ['OWNER_REQUIRED', 'NOT_FOUND'].includes(error.code)) throw new AssetRejection('STALE_REVISION', 'ADAPTER_DELETION_PREVIEW_CHANGED'); throw error; }
      if (plan.sessionId !== command.sessionId || plan.versionId !== version.id || plan.token !== body.token || canonical(plan.weights) !== canonical(version.weights) || plan.version !== version.version) throw new AssetRejection('STALE_REVISION', 'ADAPTER_DELETION_PREVIEW_CHANGED');
      const current = this.dependencies(version.id);
      if (current.dependencyHash !== plan.dependencyHash || current.canDelete !== plan.canDelete) throw new AssetRejection('STALE_REVISION', 'ADAPTER_DEPENDENCIES_CHANGED');
      if (!current.canDelete) throw new AssetRejection('INVALID_INPUT', 'ADAPTER_HAS_DEPENDENCIES');
      return this.fact(randomUUID(), { kind: 'deleted', versionId: version.id, planId: plan.id, token: plan.token },
        { kind: 'adapter-deletion-receipt-1', versionId: version.id, planId: plan.id, token: plan.token, deleted: true, actualFreedBytes: '0', bytesRetained: true });
    });
  }
}

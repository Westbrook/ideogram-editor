import { randomUUID } from 'node:crypto';
import { AdapterDeletions } from './adapter-deletion.js';
import {AdapterRuntimeEvidenceReader} from './adapter-runtime.js';
import type { DatabaseSync } from 'node:sqlite';
import { inspectSafetensorsHeader, parseSafetensorsHeaderLength, SafetensorsError } from '../../src/adapters/structure.js';
import { inspectAdapterProfile, retainedAdapterProfile } from '../../src/adapters/profile.js';
import { adapterDependencies, adapterRegistration, adapterVersion } from '../../src/protocol/adapters.js';
import type { RegisterAdapterBody, AdapterLibraryEntry, AdapterLibraryFilters, AdapterLibraryPage, AdapterLibraryUpdates, AdapterQualification, AdapterVersion } from '../../src/protocol/adapters.js';
import type { Asset, AssetFact } from '../../src/protocol/assets.js';
import type { BlobRef, Receipt } from '../../src/protocol/store.js';
import type { Eligibility } from '../../src/request/core.js';
import { parseControlJSON } from '../../src/protocol/json.js';
import { canonical, hashBytes, isId, parseCommand } from './canonical.js';
import { AssetRejection, type Assets, type AssetAuth } from './assets.js';
import { StoreError } from './errors.js';
import type { Objects } from './objects.js';
import { adapterResources } from '../observability/adapter-resources.js';

type Use = Readonly<{ version: string; hash: string }>;
type Inspection = { qualification: AdapterQualification; reason: string; structure: AdapterVersion['validation']['structure'];profileId:string|null;locallyEligible:boolean;runtimeVerified:false };
type ReadOriginal = (ref: BlobRef, offset: number, length: number) => Uint8Array;
/** Bounded safe metadata inspection. Never loads or evaluates tensor data. */
export function inspectAdapterOriginal(read: ReadOriginal, input: { weights: BlobRef; config: BlobRef | null; declaredFamily: string; declaredFormat: string }): Inspection {
  const releaseInspection=adapterResources.handle('adapters','metadata-inspection');
  const releases:(()=>void)[]=[];
  const observedRead:ReadOriginal=(ref,offset,length)=>{const bytes=read(ref,offset,length);releases.push(adapterResources.buffer('adapters',offset===0&&length===8?'header-prefix':ref===input.config?'config-input':'header-input',bytes));return bytes;};
  let structure: AdapterVersion['validation']['structure'] = null;
  const unavailable={profileId:null,locallyEligible:false,runtimeVerified:false} as const;
  try {
    const bytes = Number(input.weights.byteLength);
    if (!Number.isSafeInteger(bytes) || bytes < 8) return { qualification: 'incompatible', reason: 'SAFETENSORS_FILE_LENGTH', structure,...unavailable };
    const headerLength = parseSafetensorsHeaderLength(observedRead(input.weights, 0, 8), bytes);
    const inspected = inspectSafetensorsHeader(observedRead(input.weights, 8, headerLength), bytes);
    structure = { headerBytes: inspected.headerBytes, dataBytes: inspected.dataBytes, tensorCount: inspected.tensorCount, dtypes: [...inspected.dtypes], tensorSignature: inspected.tensorSignature };
    if (input.config !== null) {
      if (BigInt(input.config.byteLength) > 1048576n) return { qualification: 'incompatible', reason: 'CONFIG_INSPECTION_LIMIT', structure,...unavailable };
      try {
        const config = parseControlJSON(observedRead(input.config, 0, Number(input.config.byteLength)), 1048576);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error();
      } catch (error) { if (error instanceof StoreError) throw error; return { qualification: 'incompatible', reason: 'CONFIG_JSON_INVALID', structure,...unavailable }; }
    }
    const compatibility = inspectAdapterProfile({ structure: inspected, weightsHash: input.weights.hash, declaredFamily: input.declaredFamily, declaredFormat: input.declaredFormat, configHash: input.config?.hash ?? null, origin: 'import' });
    return { qualification: compatibility.status, reason: compatibility.reason, structure,profileId:compatibility.profileId,locallyEligible:compatibility.locallyEligible,runtimeVerified:false };
  } catch (error) {
    if (error instanceof StoreError) throw error;
    return { qualification: 'incompatible', reason: error instanceof SafetensorsError ? error.code : 'SAFETENSORS_INSPECTION_INVALID', structure,...unavailable };
  }finally{for(const release of releases)release();releaseInspection();}
}

export function adapterReferences(assets: Assets, uses: ReadonlyArray<Use>): BlobRef[] {
  const refs = new Map<string, BlobRef>();
  for (const use of uses) {
    const asset = assets.asset(use.version);
    if (!asset?.adapter || asset.qualification !== 'adapter-version' || assets.adapterDeleted(use.version) || asset.availability !== 'available' || asset.blob.hash !== use.hash) throw new StoreError('MISSING_OBJECT');
    try { adapterVersion(asset.adapter); } catch { throw new StoreError('CORRUPT_STORE'); }
    if (asset.adapter.id !== asset.id || canonical(asset.adapter.weights) !== canonical(asset.blob) || canonical(adapterDependencies(asset.adapter)) !== canonical(asset.dependencies)) throw new StoreError('CORRUPT_STORE');
    for (const ref of [asset.blob, ...asset.dependencies]) refs.set(canonical(ref), ref);
  }
  return [...refs.values()];
}
export function adapterEligibility(db: DatabaseSync, assets: Assets, uses: ReadonlyArray<Use>, objects?:Objects): Eligibility {
  adapterReferences(assets, uses);const adapters:Eligibility['adapters'] extends ReadonlyMap<string,infer E>?Map<string,E>:never=new Map();
  const runtime=db&&objects?new AdapterRuntimeEvidenceReader(db,objects,assets):null;
  for(const use of uses){const a=assets.asset(use.version)!.adapter!;const verified=a.qualification==='structurally-valid'&&a.validation.locallyEligible&&a.validation.structure?retainedAdapterProfile({weightsHash:a.weights.hash,configHash:a.config?.hash??null,declaredFamily:a.declaredFamily,declaredFormat:a.declaredFormat,tensorSignature:a.validation.structure.tensorSignature,origin:a.origin.kind}):null;
    if(verified?.locallyEligible&&verified.profileId===a.validation.profileId){const evidence=runtime?.forVersion(use.version)??[];adapters.set(use.version,{hash:a.weights.hash,available:true,profile:'v4-safe-1',runtimeVerified:evidence.length>0,...runtime?{configHash:a.config?.hash??null,runtimeProfile:runtime.profile(),runtimeEvidence:evidence}:{}});}
  }
  return { adapters };
}

type Commit = (bytes: Uint8Array, build: () => AssetFact, slot?: string) => Receipt;
export class Adapters {
  private deletions:AdapterDeletions;
  private runtime:AdapterRuntimeEvidenceReader;
  constructor(private db: DatabaseSync, private objects: Objects, private assets: Assets, private check: () => void,
    private commit: Commit, private register: (owner: string, ref: BlobRef, proof?: string) => void) {this.deletions=new AdapterDeletions(db,objects,assets,check,commit,register);this.runtime=new AdapterRuntimeEvidenceReader(db,objects,assets);}
  deletionReview(id:string,auth:AssetAuth){return this.deletions.review(id,auth);}
  private original(id: string, weights: boolean): Asset {
    const a = this.assets.asset(id);
    if (!a || a.availability !== 'available') throw new AssetRejection('MISSING_ASSET', 'ADAPTER_ORIGINAL_UNAVAILABLE');
    if (weights ? a.purpose !== 'adapter' || a.qualification !== 'pending-adapter' || a.blob.mediaType !== 'application/octet-stream' : a.purpose !== 'caption' || a.qualification !== 'opaque-text') throw new AssetRejection('INVALID_INPUT', 'ADAPTER_ORIGINAL_KIND');
    return a;
  }
  private previous(body: RegisterAdapterBody): AdapterVersion | null {
    if (body.adapterId === null) return null;
    const versions = this.db.prepare("SELECT json FROM assets WHERE json_extract(json,'$.adapter.adapterId')=? ORDER BY length(json_extract(json,'$.adapter.version')) DESC,json_extract(json,'$.adapter.version') DESC,id DESC LIMIT 1").get(body.adapterId);
    const previous = versions ? (JSON.parse(String(versions.json)) as Asset).adapter : null;
    if (!previous || this.assets.adapterDeleted(previous.id) || previous.id !== body.previousVersionId) throw new AssetRejection('STALE_REVISION', 'ADAPTER_VERSION_CHANGED', previous?.version ?? null);
    return previous;
  }
  async command(bytes: Uint8Array, auth: AssetAuth): Promise<Receipt> {
    this.check(); const request = parseCommand(bytes), c = request.command;
    if (c.clientId !== auth.clientId) throw new StoreError('OWNER_REQUIRED');
    if(c.body.type==='PreviewAdapterDeletion'||c.body.type==='DeleteAdapterVersion')return this.deletions.command(bytes,auth);
    if (c.body.type !== 'RegisterAdapterVersion') throw new StoreError('UNSUPPORTED_COMMAND');
    adapterRegistration(c.body); const body = c.body;
    const hash = hashBytes(canonical(request));
    const previous = this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);
    if (previous) { if (previous.hash !== hash) throw new StoreError('COMMAND_ID_REUSE'); return JSON.parse(String(previous.receipt)); }
    for (const table of ['asset_preparations', 'raster_preparations', 'history_preparations', 'portable_preparations']) if (this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(c.commandId)) throw new StoreError('COMMAND_ID_REUSE');
    const slot = 'adapter:' + randomUUID(), proofs = new Map<string, string>();
    this.objects.acquire(slot);
    try {
      this.previous(body);
      const weights = this.original(body.weightsAssetId, true), config = body.configAssetId ? this.original(body.configAssetId, false) : null,
        provenance = body.provenanceAssetId ? this.original(body.provenanceAssetId, false) : null;
      for (const ref of new Map([weights.blob, config?.blob, provenance?.blob].filter((r): r is BlobRef => !!r).map(r => [canonical(r), r])).values()) {
        const proof = await this.objects.prove(ref, this.check); proofs.set(canonical(ref), proof);
      }
      const inspected = inspectAdapterOriginal((ref, offset, length) => {
        this.objects.proven(ref, proofs.get(canonical(ref))!); return this.objects.readRange(ref, String(offset), length);
      }, { weights: weights.blob, config: config?.blob ?? null, declaredFamily: body.declaredFamily, declaredFormat: body.declaredFormat });
      const report = this.objects.putMetadataInSlot(Buffer.from(canonical({ kind: 'adapter-validation-1', inspector: 'safetensors-inspection-1', weights: weights.blob, config: config?.blob ?? null, declaredFamily: body.declaredFamily, declaredFormat: body.declaredFormat, ...inspected })), slot);
      const origin = this.objects.putMetadataInSlot(Buffer.from(canonical({ kind: 'adapter-import-provenance-1', name: body.name, declaredFamily: body.declaredFamily, declaredFormat: body.declaredFormat, statement: body.provenanceText, original: provenance?.blob ?? null })), slot);
      return this.commit(bytes, () => {
        this.check(); const previousVersion = this.previous(body);
        for (const a of [weights, config, provenance]) if (a) {
          if (canonical(this.original(a.id, a === weights)) !== canonical(a)) throw new AssetRejection('STALE_REVISION', 'ADAPTER_ORIGINAL_CHANGED');
          this.objects.proven(a.blob, proofs.get(canonical(a.blob))!);
        }
        const id = randomUUID();
        const version: AdapterVersion = { schemaVersion: 1, id, adapterId: body.adapterId ?? randomUUID(), version: String(BigInt(previousVersion?.version ?? '0') + 1n), name: body.name,
          weights: weights.blob, config: config?.blob ?? null, origin: { kind: 'import', provenance: origin, original: provenance?.blob ?? null },
          sources: { weightsAssetId: weights.id, configAssetId: config?.id ?? null, provenanceAssetId: provenance?.id ?? null },
          declaredFamily: body.declaredFamily, declaredFormat: body.declaredFormat, qualification: inspected.qualification,
          validation: { report, inspector: 'safetensors-inspection-1', reason: inspected.reason, profileId: inspected.profileId, locallyEligible: inspected.locallyEligible, runtimeVerified: false, structure: inspected.structure } };
        adapterVersion(version);
        const asset: Asset = { id, version: '1', purpose: 'adapter', blob: weights.blob, dependencies: adapterDependencies(version), safety: inspected.qualification === 'incompatible' ? 'quarantined' : 'unknown', availability: 'available', qualification: 'adapter-version', measuredMediaType: 'application/octet-stream', adapter: version };
        for (const ref of new Map([...asset.dependencies, asset.blob].map(ref => [ref.hash, ref])).values()) this.register('asset:' + id, ref, proofs.get(canonical(ref)));
        return { type: 'AssetRegistered', payload: { asset } };
      }, slot);
    } catch (error) {
      if (error instanceof AssetRejection) return this.commit(bytes, () => { throw error; }, slot);
      if (error instanceof StoreError && ['MISSING_OBJECT', 'CORRUPT_OBJECT'].includes(error.code)) return this.commit(bytes, () => { throw new AssetRejection('MISSING_ASSET', 'ADAPTER_ORIGINAL_UNAVAILABLE'); }, slot);
      throw error;
    } finally { for (const proof of proofs.values()) this.objects.releaseProof(proof); this.objects.release(slot); }
  }
  private entry(asset: Asset): AdapterLibraryEntry {
    const a = asset.adapter!; adapterVersion(a);
    const deleted=this.assets.adapterDeleted(asset.id);let available = asset.availability === 'available'&&!deleted;
    if (available) for (const ref of [asset.blob, ...asset.dependencies]) {
      try { this.objects.readRange(ref, '0', 0); } catch (e) { if (!(e instanceof StoreError && ['MISSING_OBJECT', 'CORRUPT_OBJECT'].includes(e.code)) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; available = false; break; }
    }
    const runtimeEvidence=available&&a.validation.locallyEligible?this.runtime.forVersion(a.id):[],runtimeVerified=runtimeEvidence.length>0;
    return { versionId: a.id, adapterId: a.adapterId, version: a.version, name: a.name, declaredFamily: a.declaredFamily, declaredFormat: a.declaredFormat,
      qualification:runtimeVerified?'runtime-verified':a.qualification, available, weights: a.weights, config: a.config, origin: a.origin.kind, profileId: a.validation.profileId, locallyEligible: available&&a.validation.locallyEligible, runtimeVerified,runtimeProfile:this.runtime.profile(),runtimeEvidence,
      reason: deleted ? 'Deleted from this library; retained bytes have not been reclaimed.' : !available ? 'Original bytes are missing or unavailable. Restore the exact retained files.' : runtimeVerified ? 'A successful run was observed for the recorded endpoint, profile and complete adapter combination. Other combinations require review.' : a.validation.reason };
  }
  view(id: string): AdapterLibraryEntry {
    this.check(); if (!isId(id)) throw new StoreError('MALFORMED_REQUEST'); const asset = this.assets.asset(id);
    if (!asset?.adapter || asset.qualification !== 'adapter-version') throw new StoreError('NOT_FOUND'); return this.entry(asset);
  }
  updates(id: string): AdapterLibraryUpdates {
    const current = this.view(id);
    // Include unavailable and deleted successors so a read never silently falls
    // back to an older version or grants replacement/eligibility authority.
    const row = this.db.prepare("SELECT json FROM assets WHERE json_extract(json,'$.qualification')='adapter-version' AND json_extract(json,'$.adapter.adapterId')=? AND (length(json_extract(json,'$.adapter.version'))>? OR (length(json_extract(json,'$.adapter.version'))=? AND json_extract(json,'$.adapter.version')>?)) ORDER BY length(json_extract(json,'$.adapter.version')) DESC,json_extract(json,'$.adapter.version') DESC,id DESC LIMIT 1").get(current.adapterId, current.version.length, current.version.length, current.version);
    return { protocolVersion: 1, current, latest: row ? this.entry(JSON.parse(String(row.json))) : null };
  }
  list(after = '', search = '', filters: AdapterLibraryFilters = {}): AdapterLibraryPage {
    this.check(); if (after !== '' && !isId(after) || typeof search !== 'string' || search.length > 120 || !filters || typeof filters !== 'object' || Array.isArray(filters) || Object.entries(filters).some(([k, v]) => !['family', 'format', 'origin', 'status'].includes(k) || typeof v !== 'string' || v.length > 120)) throw new StoreError('MALFORMED_REQUEST');
    if (filters.origin && !['import', 'training'].includes(filters.origin) || filters.status && !['unverified', 'structurally-valid', 'incompatible', 'runtime-verified'].includes(filters.status)) throw new StoreError('MALFORMED_REQUEST');
    const sql = "SELECT json FROM assets WHERE id>? AND json_extract(json,'$.qualification')='adapter-version' AND NOT EXISTS(SELECT 1 FROM assets deletion WHERE json_extract(deletion.json,'$.adapterDeletion.kind')='deleted' AND json_extract(deletion.json,'$.adapterDeletion.versionId')=assets.id) AND (?='' OR instr(lower(json_extract(json,'$.adapter.name')),lower(?))>0)";
    const clauses = [['family', '$.adapter.declaredFamily'], ['format', '$.adapter.declaredFormat'], ['origin', '$.adapter.origin.kind']] as const;
    // Runtime status is a bounded projection over retained observations, never
    // a rewrite of the immutable import qualification. Scan at most 100 rows;
    // a continuation may cross an empty result page without losing identities.
    const scanLimit=filters.status?100:21;
    const rows = this.db.prepare(sql + clauses.map(([, path]) => ` AND (?='' OR json_extract(json,'${path}')=?)`).join('') + ' ORDER BY id LIMIT ?').all(after, search, search, ...clauses.flatMap(([key]) => [filters[key] ?? '', filters[key] ?? '']),scanLimit);
    const matched:AdapterLibraryEntry[]=[];let lastScanned=after;
    for(const row of rows){const value=this.entry(JSON.parse(String(row.json)));lastScanned=value.versionId;if(!filters.status||value.qualification===filters.status)matched.push(value);if(matched.length===21)break;}
    const items=matched.slice(0,20),nextAfter=matched.length>20?items.at(-1)!.versionId:rows.length===scanLimit?lastScanned:null;
    return { protocolVersion: 1, items, nextAfter };
  }
}

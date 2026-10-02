import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, opendirSync, unlinkSync, rmdirSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BlobRef } from '../../src/protocol/store.js';
import type { Asset } from '../../src/protocol/assets.js';
import { DISPLAY_PROFILE, DISPLAY_TILE_SIZE, displayDimensions, validDisplayRequest, type DisplayInfo, type DisplayRequest } from '../../src/protocol/display.js';
import type { InputRaster, RasterResult } from '../raster/engine.js';
import type { Assets } from './assets.js';
import type { Objects } from './objects.js';
import type { Rasters } from './raster.js';
import { canonical, hashBytes, isId, isSeq } from './canonical.js';
import { assertComponents, assertPrivate, inspectTree, privateDirectory } from './files.js';
import { StoreError } from './errors.js';
import {adapterResources} from '../observability/adapter-resources.js';

// Disk cache limits are independent of the browser's 64/128 MiB memory cache.
export const DISPLAY_DISK_TARGET = 256 * 1024 * 1024;
export const DISPLAY_DISK_HARD = 512 * 1024 * 1024;
const CACHE_ENTRIES = 128, READ_BYTES = 32768;
type SourceStamp = { ref: BlobRef; stamp: string };
type Entry = { key: string; directoryStamp: string; directory: string; path: string; ref: BlobRef; stamp: string; source: SourceStamp; width: number; height: number; pins: number };
type Lease = { id: string; assetId: string; request: DisplayRequest; slot: string; canceled: boolean; acquired: boolean; releaseCoverage:()=>void;
  proofs: { ref: BlobRef; token: string }[]; entry?: Entry; fd?: number; source?: SourceStamp;
  raw?: BlobRef; rawWidth?: number; x?: number; y?: number; info?: DisplayInfo; pending?: Promise<DisplayInfo>; directory?: string; diskAllowance: number };
const stamp = (s: BigIntStats) => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');

/** Read-only derivatives. Every live response keeps source proofs and an IO slot. */
export class Displays {
  private directory: string;
  private entries = new Map<string, Entry>();
  private leases = new Map<string, Lease>();
  private building = new Set<string>();
  private bytes = 0;
  private closing = false;
  resourceOwnership(){return {leases:this.leases.size,building:this.building.size,cacheEntries:this.entries.size};}
  constructor(private objects: Objects, private assets: Assets, private rasters: Rasters, root: string, private checkRoot: () => void) {
    this.directory = join(root, 'display-cache'); privateDirectory(this.directory);
    // No disk-cache identity is trusted across a writer restart.
    for (const name of readdirSync(this.directory)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new StoreError('ROOT_UNSAFE');
      const path = join(this.directory, name); inspectTree(path); rmSync(path, { recursive: true });
    }
  }
  private asset(lease: Lease): Asset {
    this.checkRoot(); if (this.closing || lease.canceled) throw new StoreError('CLOSED');
    const asset = this.assets.safeAsset(lease.assetId), info = asset.raster;
    if (!info || !['raster-preview','canonical-raster','canonical-png','canonical-jpeg'].includes(asset.qualification)) throw new StoreError('CONTENT_WITHHELD');
    if ((lease.request.basis === 'pixels' ? info.pixelIdentity : asset.blob.hash) !== lease.request.identity) throw new StoreError('OFFSET_MISMATCH');
    return asset;
  }
  private check(lease: Lease) {
    const asset = this.asset(lease); this.rasters.manifest(asset.id);
    assertComponents(this.directory); assertPrivate(this.directory, true);
    if (lease.directory) { assertComponents(lease.directory); assertPrivate(lease.directory, true); }
    for (const proof of lease.proofs) this.objects.proven(proof.ref, proof.token);
    if (lease.source && this.sourceStamp(lease.source.ref) !== lease.source.stamp) throw new StoreError('CORRUPT_OBJECT');
    if (lease.raw && lease.fd !== undefined && stamp(fstatSync(lease.fd, { bigint: true })) !== lease.source!.stamp) throw new StoreError('CORRUPT_OBJECT');
    if (lease.entry) {
      assertPrivate(lease.entry.directory, true); assertPrivate(lease.entry.path, false);
      if (stamp(lstatSync(lease.entry.path, { bigint: true })) !== lease.entry.stamp || lease.fd !== undefined && stamp(fstatSync(lease.fd, { bigint: true })) !== lease.entry.stamp) throw new StoreError('CORRUPT_OBJECT');
    }
  }
  private sourceStamp(ref: BlobRef) {
    const path = this.objects.path(ref); assertComponents(dirname(path)); assertPrivate(path, false);
    const stat = lstatSync(path, { bigint: true }); if (String(stat.size) !== ref.byteLength) throw new StoreError('CORRUPT_OBJECT'); return stamp(stat);
  }
  begin(id: string, assetId: string, request: DisplayRequest): Promise<DisplayInfo> {
    if (!isId(id) || !isId(assetId) || !validDisplayRequest(request) || this.leases.has(id)) return Promise.reject(new StoreError('MALFORMED_REQUEST'));
    if (this.closing) return Promise.reject(new StoreError('CLOSED'));
    if (this.leases.size >= 16) return Promise.reject(new StoreError('CAPACITY'));
    const lease: Lease = { id, assetId, request, slot: 'display:' + id, canceled: false, acquired: false, proofs: [], diskAllowance: 0, releaseCoverage:adapterResources.uncovered('display-reader') };
    this.leases.set(id, lease);
    lease.pending = this.prepare(lease);
    return lease.pending;
  }
  private async prepare(lease: Lease): Promise<DisplayInfo> {
    let complete = false;
    try {
      const asset = this.asset(lease), source = asset.raster!, request = lease.request;
      const dimensions = displayDimensions(source.width, source.height, request);
      const x = request.kind === 'tile' ? request.x * DISPLAY_TILE_SIZE : 0, y = request.kind === 'tile' ? request.y * DISPLAY_TILE_SIZE : 0;
      if (x >= dimensions.width || y >= dimensions.height) throw new StoreError('MALFORMED_REQUEST');
      // Transfer saturation is transient, not disk exhaustion. No await occurs
      // between this check and acquisition on the single writer event loop.
      if(this.objects.reservationInventory().activeTransfers>=2)throw new StoreError('QUEUE_FULL');
      this.objects.acquire(lease.slot); lease.acquired = true;
      // Manifest validation also checks the rooted dependency graph.
      const manifest = this.rasters.manifest(asset.id);
      const manifestToken = await this.objects.prove(source.manifest, () => this.check(lease));
      lease.proofs.push({ ref: source.manifest, token: manifestToken }); this.check(lease);
      let ref: BlobRef, width: number, height: number;
      if (request.kind === 'tile' && request.lod === 0 && request.basis === 'pixels') {
        // The rooted manifest authenticates this exact 512px range. Hashing its
        // rows below avoids rehashing a 100MB source for each viewport tile.
        ref = source.pixels; lease.raw = ref; lease.rawWidth = source.width;
        lease.source = { ref, stamp: this.sourceStamp(ref) }; lease.fd = openSync(this.objects.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW); this.check(lease);
      } else {
        const key = hashBytes(canonical({ profile: DISPLAY_PROFILE, source: request.identity, pixels: source.pixelIdentity, blob: request.basis === 'encoded' ? asset.blob.hash : null,
          kind: request.kind, size: request.kind === 'preview' ? request.edge : request.lod }));
        let entry = this.entries.get(key);
        if (!entry) {
          const sourceRef = request.basis === 'encoded' ? asset.blob : source.pixels;
          const token = await this.objects.prove(sourceRef, () => this.check(lease)); lease.proofs.push({ ref: sourceRef, token }); this.check(lease);
          // Only a successfully hash-proven full source may seed a derivative's
          // reusable stamp. Current file metadata alone never establishes trust.
          lease.source = { ref: sourceRef, stamp: this.sourceStamp(sourceRef) }; this.check(lease);
          entry = this.entries.get(key) ?? await this.build(lease, asset, key, dimensions);
        }
        lease.source = entry.source;
        if (lease.entry !== entry) { entry.pins++; lease.entry = entry; }
        this.entries.delete(key); this.entries.set(key, entry);
        this.check(lease); lease.fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW); this.check(lease);
        ref = entry.ref; lease.rawWidth = entry.width;
      }
      width = request.kind === 'tile' ? Math.min(DISPLAY_TILE_SIZE, dimensions.width - x) : dimensions.width;
      height = request.kind === 'tile' ? Math.min(DISPLAY_TILE_SIZE, dimensions.height - y) : dimensions.height;
      lease.x = x; lease.y = y;
      const info: DisplayInfo = { profile: DISPLAY_PROFILE, source: request.identity, basis: request.basis, width, height,
        sourceWidth: source.width, sourceHeight: source.height, lod: request.kind === 'tile' ? request.lod : 0,
        byteLength: request.kind === 'tile' ? String(width * height * 4) : ref.byteLength, hash: ref.hash,
        mediaType: request.kind === 'tile' ? 'application/x-ideogram-rgba8' : 'image/png' };
      lease.info = info;
      if (request.kind === 'tile') {
        const hash = createHash('sha256');
        for (let at = 0; at < width * height * 4; at += READ_BYTES) {
          hash.update(this.read(lease.id, String(at), Math.min(READ_BYTES, width * height * 4 - at)));
          await new Promise<void>(resolve => setImmediate(resolve)); this.check(lease);
        }
        info.hash = 'sha256:' + hash.digest('hex');
        if (lease.raw) {
          const expected = manifest.tiles.find(tile => tile.x === x && tile.y === y && tile.width === width && tile.height === height);
          if (!expected || expected.hash !== info.hash) throw new StoreError('CORRUPT_OBJECT');
        }
      }
      this.check(lease); complete = true; return info;
    } finally { if (!complete) this.cleanup(lease); }
  }
  private evict(required: number, target = DISPLAY_DISK_TARGET) {
    const pending = [...this.leases.values()].reduce((sum, lease) => sum + lease.diskAllowance, 0);
    for (const [key, entry] of this.entries) {
      if (this.bytes + pending + required <= target && this.entries.size < CACHE_ENTRIES) break;
      if (entry.pins) continue;
      assertPrivate(entry.directory, true); inspectTree(entry.directory); rmSync(entry.directory, { recursive: true });
      this.entries.delete(key); this.bytes -= Number(entry.ref.byteLength);
    }
    if (this.bytes + pending + required > DISPLAY_DISK_HARD || this.entries.size >= CACHE_ENTRIES) throw new StoreError('CAPACITY');
  }
  private async verifyFile(path: string, ref: BlobRef, lease: Lease) {
    assertPrivate(path, false); const before = stamp(lstatSync(path, { bigint: true }));
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (stamp(fstatSync(fd, { bigint: true })) !== before) throw new StoreError('ROOT_UNSAFE');
      const buffer = Buffer.alloc(READ_BYTES), hash = createHash('sha256'); let total = 0;
      for (;;) { this.check(lease); const n = readSync(fd, buffer, 0, buffer.length, total); if (!n) break; total += n; hash.update(buffer.subarray(0,n));
        if (total > Number(ref.byteLength)) throw new StoreError('CORRUPT_OBJECT');
        if (total % (1024 * 1024) === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (String(total) !== ref.byteLength || 'sha256:' + hash.digest('hex') !== ref.hash || stamp(fstatSync(fd, { bigint: true })) !== before || stamp(lstatSync(path, { bigint: true })) !== before) throw new StoreError('CORRUPT_OBJECT');
      return before;
    } finally { closeSync(fd); }
  }
  private async build(lease: Lease, asset: Asset, key: string, dimensions: { width: number; height: number }): Promise<Entry> {
    // A duplicate cold request retries once the first builder publishes. Never
    // let two builders overwrite an indexed entry whose response still pins it.
    if (this.building.has(key)) throw new StoreError('QUEUE_FULL');
    const releaseCoverage=adapterResources.uncovered('display-build');this.building.add(key);
    try {
    // Reserve the maximum retained derivative before launching its worker. The
    // worker separately admits transient files under the existing R31 margin.
    const allowance = lease.request.kind === 'tile' ? dimensions.width * dimensions.height * 4 : dimensions.width * dimensions.height * 4 + dimensions.height + 65536;
    this.evict(allowance); lease.diskAllowance = allowance; this.check(lease);
    const directory = mkdtempSync(join(this.directory, 'work-')); lease.directory = directory; assertPrivate(directory, true);
    let input: InputRaster = { id: asset.id, info: asset.raster!, path: this.objects.path(asset.raster!.pixels) }, result: RasterResult | undefined;
    const work = async (job: Parameters<Rasters['displayWork']>[0]) => { this.check(lease); const value = await this.rasters.displayWork(job, lease.slot, () => this.check(lease)); this.check(lease); return value; };
    if (lease.request.basis === 'encoded') {
      if (!['image/png','image/jpeg','image/webp'].includes(asset.measuredMediaType)) throw new StoreError('MEDIA_TYPE');
      const decoded = join(directory, 'decoded'); privateDirectory(decoded);
      result = await work({ type: 'decode', path: this.objects.path(asset.blob), mediaType: asset.measuredMediaType, original: asset.blob, sourceAssetId: asset.id, directory: decoded });
      if (result.info.width !== asset.raster!.width || result.info.height !== asset.raster!.height) throw new StoreError('CORRUPT_OBJECT');
      input = { id: asset.id, info: result.info, path: join(decoded, 'pixels.rgba') };
    }
    if (!result || input.info.width !== dimensions.width || input.info.height !== dimensions.height) {
      const rendered = join(directory, 'rendered'); privateDirectory(rendered);
      result = await work({ type: 'export', input, directory: rendered, dependencies: [input.info.manifest],
        options: { format: 'png', resize: dimensions, matte: null, quality: null } });
    }
    const selected = lease.request.kind === 'tile' ? result.info.pixels : result.png;
    if (Number(selected.byteLength) > allowance) throw new StoreError('CAPACITY');
    const from = result.files.find(file => canonical(file.ref) === canonical(selected));
    if (!from || !['pixels.rgba','output.png'].includes(from.name)) throw new StoreError('CORRUPT_OBJECT');
    const outputDirectory = !result || input.info.width !== dimensions.width || input.info.height !== dimensions.height || lease.request.basis === 'pixels' ? 'rendered' : 'decoded';
    const path = join(directory, 'data'); renameSync(join(directory, outputDirectory, from.name), path);
    const fileStamp = await this.verifyFile(path, selected, lease);
    for (const name of ['decoded','rendered']) { const child = join(directory,name); try { inspectTree(child); rmSync(child,{recursive:true}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    const entry: Entry = { key, directoryStamp: stamp(lstatSync(directory,{bigint:true})), directory, path, ref: selected, stamp: fileStamp, source: lease.source!, width: dimensions.width, height: dimensions.height, pins: 0 };
    this.check(lease); this.evict(0, DISPLAY_DISK_HARD);
    entry.pins = 1; lease.entry = entry;
    this.entries.set(key, entry); this.bytes += Number(selected.byteLength); lease.diskAllowance = 0; lease.directory = undefined; this.objects.unreserve(lease.slot);
    return entry;
    } finally { this.building.delete(key); releaseCoverage(); }
  }
  read(id: string, offset: string, length: number): Uint8Array {
    const lease = this.leases.get(id); if (!lease?.info) throw new StoreError('NOT_FOUND'); this.check(lease);
    if (!isSeq(offset) || !Number.isSafeInteger(length) || length < 1 || length > READ_BYTES || BigInt(offset) + BigInt(length) > BigInt(lease.info.byteLength)) throw new StoreError('MALFORMED_REQUEST');
    const bytes = Buffer.alloc(length), start = Number(offset);
    if (lease.request.kind === 'preview') {
      if (readSync(lease.fd!, bytes, 0, length, start) !== length) throw new StoreError('CORRUPT_OBJECT');
    } else {
      const rowBytes = lease.info.width * 4;
      for (let at = 0; at < length;) {
        const logical = start + at, row = Math.floor(logical / rowBytes), col = logical % rowBytes, n = Math.min(length - at, rowBytes - col);
        const position = ((lease.y! + row) * lease.rawWidth! + lease.x!) * 4 + col;
        if (readSync(lease.fd!, bytes, at, n, position) !== n) throw new StoreError('CORRUPT_OBJECT');
        at += n;
      }
    }
    this.check(lease); return bytes;
  }
  private cleanup(lease: Lease) {
    if (lease.fd !== undefined) { closeSync(lease.fd); lease.fd = undefined; }
    if (lease.directory) { inspectTree(lease.directory); rmSync(lease.directory, { recursive: true }); lease.directory = undefined; }
    lease.diskAllowance = 0;
    if (lease.entry) { lease.entry.pins--; lease.entry = undefined; }
    for (const proof of lease.proofs) this.objects.releaseProof(proof.token); lease.proofs = [];
    this.objects.unreserve(lease.slot); if (lease.acquired) { this.objects.release(lease.slot); lease.acquired = false; }
    this.leases.delete(lease.id);
    lease.releaseCoverage();
  }
  async release(id: string) {
    const lease = this.leases.get(id); if (!lease) return;
    lease.canceled = true; await this.rasters.stopDisplayWork(lease.slot);
    await lease.pending?.catch(() => {}); this.cleanup(lease);
  }
  hasReaders(){return this.leases.size>0||this.building.size>0;}
  storageInventory() {
    this.checkRoot();if(this.closing)throw new StoreError('CLOSED');
    let knownBytes=0n,clearableBytes=0n,pinnedEntries=0,clearableEntries=0;
    for(const entry of this.entries.values()){
      knownBytes+=BigInt(entry.ref.byteLength);
      if(entry.pins)pinnedEntries++;
      else if(!this.building.has(entry.key)){clearableEntries++;clearableBytes+=BigInt(entry.ref.byteLength);}
    }
    return {entries:this.entries.size,knownBytes:String(knownBytes),pinnedEntries,activeBuilds:this.building.size,clearableEntries,clearableBytes:String(clearableBytes),scope:'registered-display-derivatives' as const};
  }
  /** Only exact, unpinned entries published by this writer are eligible. The
   * directory census is bounded to two names; unexpected members are retained. */
  clearRegistered() {
    this.checkRoot();if(this.closing)throw new StoreError('CLOSED');
    assertComponents(this.directory);assertPrivate(this.directory,true);
    const failures:{key:string;reason:'identity'|'unexpected-members'|'remove-failed'}[]=[];
    let removedEntries=0,freed=0n,pinnedEntries=0,examinedEntries=0;const initialEntries=this.entries.size;
    for(const [key,entry] of this.entries){
      if(examinedEntries===128)break;examinedEntries++;
      if(entry.pins){pinnedEntries++;continue;}if(this.building.has(key))continue;
      let recordedFailure=false,fd:number|undefined,reason:'identity'|'unexpected-members'|'remove-failed'='identity';
      try{
        this.checkRoot();assertComponents(this.directory);assertPrivate(this.directory,true);
        if(this.entries.get(key)!==entry||entry.path!==join(entry.directory,'data')||dirname(entry.directory)!==this.directory||!/^work-[A-Za-z0-9]+$/.test(basename(entry.directory)))throw new StoreError('ROOT_UNSAFE');
        assertPrivate(entry.directory,true);
        if(stamp(lstatSync(entry.directory,{bigint:true}))!==entry.directoryStamp)throw new StoreError('ROOT_UNSAFE');
        const directory=opendirSync(entry.directory);let onlyData=false;
        try{const first=directory.readSync(),second=directory.readSync();onlyData=first?.name==='data'&&first.isFile()&&!second;}finally{directory.closeSync();}
        if(!onlyData){reason='unexpected-members';throw new StoreError('ROOT_UNSAFE');}
        assertPrivate(entry.path,false);fd=openSync(entry.path,constants.O_RDONLY|constants.O_NOFOLLOW);
        if(stamp(fstatSync(fd,{bigint:true}))!==entry.stamp||stamp(lstatSync(entry.path,{bigint:true}))!==entry.stamp||String(fstatSync(fd,{bigint:true}).size)!==entry.ref.byteLength||stamp(lstatSync(entry.directory,{bigint:true}))!==entry.directoryStamp)throw new StoreError('ROOT_UNSAFE');
        this.checkRoot();reason='remove-failed';unlinkSync(entry.path);
        // Once the known file is removed, report that actual logical removal
        // even if the final empty-directory removal independently fails.
        this.entries.delete(key);this.bytes-=Number(entry.ref.byteLength);removedEntries++;freed+=BigInt(entry.ref.byteLength);
        const opened=fd;fd=undefined;closeSync(opened);rmdirSync(entry.directory);
      }catch{failures.push({key:key.slice(7),reason});recordedFailure=true;}
      finally{if(fd!==undefined){try{closeSync(fd);}catch{if(!recordedFailure)failures.push({key:key.slice(7),reason:'remove-failed'});}}}
    }
    this.checkRoot();
    const unexaminedEntries=initialEntries-examinedEntries;
    return {examinedEntries,unexaminedEntries,outcome:failures.length||unexaminedEntries?'partial' as const:'complete' as const,removedEntries,freedLogicalBytes:String(freed),pinnedEntries,activeBuilds:this.building.size,retainedEntries:this.entries.size,failures};
  }
  diagnostics() { return { entries: this.entries.size, bytes: this.bytes, targetBytes: DISPLAY_DISK_TARGET, hardBytes: DISPLAY_DISK_HARD, active: this.leases.size, profile: DISPLAY_PROFILE }; }
  async close() { this.closing = true; await Promise.all([...this.leases.keys()].map(id => this.release(id))); }
}

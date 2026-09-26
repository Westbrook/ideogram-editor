import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BlobRef } from '../../src/protocol/store.js';
import { assertComponents, assertPrivate, inspectTree, privateDirectory, sameFile, syncDirectory } from './files.js';
import { isSeq, validateBlob } from './canonical.js';
import { StoreError } from './errors.js';

export const IO_CHUNK = 1024 * 1024;
const MARGIN = 1024n ** 3n;
const EMERGENCY = 64n * 1024n ** 2n;
export type Barrier = (phase: string) => void;
type Stage = { fd: number; path: string; length: bigint; received: bigint; hash: ReturnType<typeof createHash>;
  expectedHash?: string; mediaType: string; reserved: bigint; checkedAt: number };
export class Objects {
  private stages = new Map<string, Stage>();
  private reserved = 0n;
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
    const used = this.quota ? inspectTree(this.root) : 0n;
    if (free < this.reserved + required + MARGIN + EMERGENCY || (total - free) * 10n >= total * 9n ||
        (this.quota && (used * 10n >= BigInt(this.quota) * 9n || used + this.reserved + required + EMERGENCY > BigInt(this.quota)))) throw new StoreError('CAPACITY');
  }
  begin(byteLength: string, mediaType: string, expectedHash?: string, metadata = false): string {
    this.check();
    assertComponents(this.staging); assertPrivate(this.staging, true);
    if (!isSeq(byteLength)) throw new StoreError('MALFORMED_REQUEST');
    validateBlob({ hash: expectedHash ?? `sha256:${'0'.repeat(64)}`, byteLength, mediaType });
    const length = BigInt(byteLength);
    if (metadata && length > 65536n) throw new StoreError('PAYLOAD_TOO_LARGE');
    if (this.stages.size >= 2) throw new StoreError('CAPACITY');
    if (!metadata) this.capacity(length);
    const id = randomUUID(); const path = join(this.staging, id);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const reserved = metadata ? 0n : length + (length + 3n) / 4n;
    this.reserved += reserved;
    this.stages.set(id, { fd, path, length, received: 0n, hash: createHash('sha256'), mediaType, expectedHash, reserved, checkedAt: Date.now() });
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
    if (stage.expectedHash && hash !== stage.expectedHash) throw new StoreError('CORRUPT_OBJECT');
    const ref = { hash, byteLength: String(stage.length), mediaType: stage.mediaType };
    this.barrier('before-object-flush'); fsyncSync(stage.fd); this.barrier('after-object-flush');
    closeSync(stage.fd); stage.fd = -1;
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
    this.reserved -= stage.reserved; this.stages.delete(id);
    return ref;
  }
  abort(id: string): void {
    const stage = this.stages.get(id); if (!stage) return;
    if (stage.fd !== -1) closeSync(stage.fd);
    // Keep abandoned bytes for startup inventory; cleanup is a later explicit operation.
    this.reserved -= stage.reserved; this.stages.delete(id);
  }
  putMetadata(bytes: Uint8Array): BlobRef {
    const id = this.begin(String(bytes.byteLength), 'application/json', undefined, true);
    try { this.chunk(id, bytes); return this.finish(id); } finally { this.abort(id); }
  }
  path(ref: BlobRef): string { validateBlob(ref); return join(this.objects, ref.hash.slice(7, 9), ref.hash.slice(7)); }
  verify(ref: BlobRef, read = false): Uint8Array | undefined {
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
    try {
      const hash = createHash('sha256'); const chunk = Buffer.alloc(IO_CHUNK); let length = 0n;
      const parts: Buffer[] = [];
      for (;;) {
        const n = readSync(fd, chunk); if (!n) break;
        length += BigInt(n); hash.update(chunk.subarray(0, n));
        if (length > BigInt(ref.byteLength)) throw new StoreError('CORRUPT_OBJECT');
        if (read) parts.push(Buffer.from(chunk.subarray(0, n)));
      }
      if (length !== BigInt(ref.byteLength) || `sha256:${hash.digest('hex')}` !== ref.hash) throw new StoreError('CORRUPT_OBJECT');
      return read ? Buffer.concat(parts) : undefined;
    } finally { closeSync(fd); }
  }
  readRange(ref: BlobRef, offset: string, length: number): Uint8Array {
    this.check(); validateBlob(ref);
    if (!isSeq(offset) || !Number.isSafeInteger(length) || length < 0 || length > IO_CHUNK ||
        BigInt(offset) + BigInt(length) > BigInt(ref.byteLength)) throw new StoreError('MALFORMED_REQUEST');
    assertComponents(this.objects); assertPrivate(this.objects, true);
    assertPrivate(join(this.objects, ref.hash.slice(7, 9)), true);
    const identity = assertPrivate(this.path(ref), false);
    const fd = openSync(this.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(identity, fstatSync(fd)) || BigInt(identity.size) !== BigInt(ref.byteLength)) throw new StoreError('CORRUPT_OBJECT');
      const bytes = Buffer.alloc(length); let read = 0;
      while (read < length) {
        const n = readSync(fd, bytes, read, length - read, BigInt(offset) + BigInt(read));
        if (!n) throw new StoreError('CORRUPT_OBJECT'); read += n;
      }
      return bytes;
    } finally { closeSync(fd); }
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
  close() { for (const id of this.stages.keys()) this.abort(id); }
}

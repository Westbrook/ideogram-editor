// SOURCE STAGING ONLY. No native identity or ROI halo is supplied by default.
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync, writeSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {encodeWebPRequest, validateWebPIdentity, validateWebPOriginal, webpTileReservation, webpTiles, WEBP_IO_BYTES,
  type QualifiedWebPIdentity, type WebPOriginal, type WebPReservation, type WebPSourceStamp} from './tile-plan.js';

// release must be idempotent, including a rejected/unknown completion outcome.
export type WebPLease = Readonly<{release(): void | Promise<void>}>;
export type WebPScratchJournal = Readonly<{
  // Must durably and idempotently claim an exclusive path BEFORE file creation.
  record(path: string, maximumBytes: number): void | Promise<void>;
  // Called only after this adapter has removed its exact owned file (or verified
  // that a failed exclusive create never created one). Must support retry.
  remove(path: string): void | Promise<void>;
}>;
export type WebPNativeMetrics = Readonly<{
  nativePeak: number; nativeRemaining: number; allocationDenied: bigint;
  outputPeak: number; outputRemaining: number; outputBytesWritten: number;
}>;
type NativeFunction = (...args: (number | bigint | Buffer)[]) => number | bigint;
type Library = {getFunctions(definitions: Record<string, {arguments: string[]; return: string}>): Record<string, NativeFunction>; close(): void};
type FFI = {DynamicLibrary: new(path: string) => Library};
type Owned = {path: string; fd?: number; stamp?: BigIntStats; recorded: boolean};
let activePreparation = false;
let poisoned = false;
// A residual native mapping forbids unloading/reloading this library and
// pretending its charge disappeared. The isolated worker must be replaced.
const quarantinedLibraries: Library[] = [];
const sameIdentity = (a: WebPSourceStamp, b: WebPSourceStamp) => a.dev === b.dev && a.ino === b.ino;
const same = (a: WebPSourceStamp, b: WebPSourceStamp) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sameObject = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function errorCode(code: string): never { throw Error(code); }
function directory(path: string, requirePrivate = false): BigIntStats {
  if (!isAbsolute(path) || resolve(path) !== path) errorCode('RASTER_INPUT_CHANGED');
  const leaf = lstatSync(path, {bigint: true});
  if (requirePrivate && ((leaf.mode & 0o7777n) !== 0o700n || leaf.uid !== BigInt(process.geteuid!()))) errorCode('RASTER_INPUT_CHANGED');
  for (let current = path;;) {
    const s = lstatSync(current, {bigint: true});
    if (!s.isDirectory() || s.isSymbolicLink()) errorCode('RASTER_INPUT_CHANGED');
    const parent = dirname(current); if (parent === current) return leaf; current = parent;
  }
}
function regular(fd: number, privateFile = false): BigIntStats {
  const s = fstatSync(fd, {bigint: true});
  if (!s.isFile() || s.size < 0n || s.size > BigInt(Number.MAX_SAFE_INTEGER) || s.nlink !== 1n ||
      (privateFile && ((s.mode & 0o7777n) !== 0o600n || s.uid !== BigInt(process.geteuid!())))) errorCode('RASTER_INPUT_CHANGED');
  return s;
}
function named(path: string): BigIntStats {
  const s = lstatSync(path, {bigint: true});
  if (!s.isFile() || s.isSymbolicLink()) errorCode('RASTER_INPUT_CHANGED');
  return s;
}
function closeOwned(file: Owned): void {
  if (file.fd !== undefined) { const fd = file.fd; file.fd = undefined; closeSync(fd); }
}
function snapshotOriginal(value: WebPOriginal): WebPOriginal {
  const d = value.descriptor;
  return Object.freeze({...value, descriptor: Object.freeze({...d, image: Object.freeze({...d.image}),
    ...(d.alpha ? {alpha: Object.freeze({...d.alpha})} : {}), stamp: Object.freeze({...d.stamp})})});
}
function snapshotIdentity(value: QualifiedWebPIdentity): QualifiedWebPIdentity {
  return Object.freeze({...value, artifact: Object.freeze({...value.artifact}), halo: value.halo ? Object.freeze({...value.halo}) : null});
}

// Cleanup failure retains the resource lease. The durable storage owner must
// retry dispose() or reconcile the recorded paths during worker recovery.
export class WebPScratchCleanupError extends Error {
  readonly code = 'RASTER_SCRATCH_CLEANUP';
  constructor(readonly dispose: () => Promise<void>, options: {cause: unknown}) {
    super('RASTER_SCRATCH_CLEANUP', options);
  }
}
async function verifiedLibrary(seal: QualifiedWebPIdentity, check: () => void) {
  directory(dirname(seal.artifact.path));
  const fd = openSync(seal.artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stamp = regular(fd);
    if (stamp.size !== BigInt(seal.artifact.bytes) || !same(stamp, named(seal.artifact.path))) errorCode('RASTER_CODEC_UNQUALIFIED');
    const buffer = Buffer.alloc(WEBP_IO_BYTES), digest = createHash('sha256');
    for (let offset = 0; offset < seal.artifact.bytes;) {
      check();
      const wanted = Math.min(buffer.length, seal.artifact.bytes - offset);
      let done = 0;
      while (done < wanted) {
        check(); const n = readSync(fd, buffer, done, wanted - done, offset + done);
        if (n <= 0) errorCode('RASTER_CODEC_UNQUALIFIED'); done += n;
      }
      digest.update(buffer.subarray(0, wanted)); offset += wanted;
      if (offset % 1048576 === 0) await tick();
    }
    check();
    if ('sha256:' + digest.digest('hex') !== seal.artifact.hash || !same(stamp, regular(fd)) ||
        !same(stamp, named(seal.artifact.path))) errorCode('RASTER_CODEC_UNQUALIFIED');
    return {fd, stamp};
  } catch (error) { closeSync(fd); throw error; }
}
function metricsFrom(buffer: Buffer): WebPNativeMetrics {
  // A dishonest uint64 remains larger than every allowed cap when converted
  // to Number. Check residuals before throwing; otherwise an invalid metric
  // could accidentally unload a library that still owns native mappings.
  const n = (offset: number) => Number(buffer.readBigUInt64LE(offset));
  return Object.freeze({nativePeak: n(0), nativeRemaining: n(8), allocationDenied: buffer.readBigUInt64LE(16),
    outputPeak: n(24), outputRemaining: n(32), outputBytesWritten: n(40)});
}

export async function prepareOversizedWebP(args: {
  original: WebPOriginal; output: string; seal?: QualifiedWebPIdentity;
  admit(plan: WebPReservation): WebPLease | Promise<WebPLease>;
  journal: WebPScratchJournal; check(): void; cancellation: SharedArrayBuffer;
  // Must quarantine/restart the isolated raster worker after residual mappings.
  // Returning from this callback does not unpoison this module or release its lease.
  quarantine(metrics: WebPNativeMetrics): void;
}): Promise<{
  path: string; width: number; height: number; bytes: number; profile: 'encoded-rgba8';
  inspectionHash: string; nativePeak: number; outputPeak: number;
  reservation: WebPReservation; dispose(): Promise<void>;
}> {
  args.check(); validateWebPOriginal(args.original); validateWebPIdentity(args.seal);
  if (!(args.cancellation instanceof SharedArrayBuffer) || args.cancellation.byteLength !== 4 ||
      typeof args.quarantine !== 'function' || !args.journal || typeof args.journal.record !== 'function' ||
      typeof args.journal.remove !== 'function') errorCode('RASTER_RESOURCES');
  if (poisoned) errorCode('RASTER_CODEC_UNQUALIFIED');
  if (activePreparation) errorCode('RASTER_DECODE_BUSY');
  const original = snapshotOriginal(args.original), seal = snapshotIdentity(args.seal), output = args.output;
  if (!isAbsolute(output) || resolve(output) !== output || !isAbsolute(original.path) || resolve(original.path) !== original.path ||
      output === original.path || output === seal.artifact.path) errorCode('RASTER_INPUT_CHANGED');
  const reservation = webpTileReservation(original, seal), cancel = new Uint32Array(args.cancellation);
  const check = () => { args.check(); if (Atomics.load(cancel, 0)) errorCode('RASTER_CANCELED'); };
  check(); activePreparation = true;
  let lease: WebPLease | undefined, library: Library | undefined, libraryFile: {fd: number; stamp: BigIntStats} | undefined;
  let source: number | undefined, successful = false, nativeLeak = false, released = false;
  let sourceOutput: Owned = {path: output, recorded: false}, tile: Owned | undefined;
  const rootPath = dirname(output);
  let scratchDirectory: BigIntStats | undefined;
  let disposedPromise: Promise<void> | undefined;
  const rootFence = () => {
    const current = directory(rootPath, true);
    if (scratchDirectory && !sameObject(scratchDirectory, current)) errorCode('RASTER_INPUT_CHANGED');
  };
  const syncRoot = () => {
    rootFence();
    const fd = openSync(rootPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameObject(scratchDirectory!, fstatSync(fd, {bigint: true}))) errorCode('RASTER_INPUT_CHANGED');
      fsyncSync(fd); rootFence();
    } finally { closeSync(fd); }
  };
  const originalFence = () => {
    check(); directory(dirname(original.path));
    if (source === undefined || !same(original.descriptor.stamp, regular(source, true)) ||
        !same(original.descriptor.stamp, named(original.path))) errorCode('RASTER_INPUT_CHANGED');
  };
  const outputFence = (file: Owned, expected: BigIntStats) => {
    rootFence();
    if (file.fd === undefined || !same(expected, regular(file.fd, true)) ||
        !sameObject(expected, regular(file.fd, true)) || !same(expected, named(file.path))) errorCode('RASTER_INPUT_CHANGED');
  };
  const removeOwned = async (file: Owned) => {
    // Cleanup intentionally ignores cancellation, but still refuses unrelated
    // files or a replaced scratch root. Never debit disk that was not removed.
    if (file.fd === undefined && file.stamp === undefined && !file.recorded) return;
    rootFence();
    if (file.fd !== undefined && !file.stamp) file.stamp = fstatSync(file.fd, {bigint: true});
    if (file.stamp) {
      const held = file.fd === undefined ? undefined : fstatSync(file.fd, {bigint: true});
      if (!held || !held.isFile() || !sameIdentity(file.stamp, held) || held.mode !== file.stamp.mode ||
          held.uid !== file.stamp.uid || held.gid !== file.stamp.gid || held.nlink > 1n) errorCode('RASTER_INPUT_CHANGED');
      try {
        const current = named(file.path);
        if (!sameObject(file.stamp, current)) errorCode('RASTER_INPUT_CHANGED');
        unlinkSync(file.path);
      } catch (error) {
        if (!missing(error)) throw error;
        // A missing pathname may mean rename, not deletion. The held inode
        // must have zero links before its disk charge can be released.
        if (fstatSync(file.fd!, {bigint: true}).nlink !== 0n) errorCode('RASTER_INPUT_CHANGED');
      }
      if (fstatSync(file.fd!, {bigint: true}).nlink !== 0n) errorCode('RASTER_INPUT_CHANGED');
      file.stamp = undefined;
      closeOwned(file); syncRoot();
    }
    closeOwned(file);
    if (file.recorded) { syncRoot(); await args.journal.remove(file.path); file.recorded = false; }
  };
  const dispose = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (disposedPromise) return disposedPromise;
    disposedPromise = (async () => {
      if (tile) { await removeOwned(tile); tile = undefined; }
      await removeOwned(sourceOutput);
      if (nativeLeak) errorCode('RASTER_NATIVE_LEAK');
      if (lease) await lease.release(); released = true;
    })().catch(error => { disposedPromise = undefined; throw new WebPScratchCleanupError(dispose, {cause: error}); });
    return disposedPromise;
  };
  const createOwned = async (file: Owned, maximum: number) => {
    rootFence(); check();
    // Journal operations are idempotent, including an unknown outcome. Keep
    // the pending claim until cleanup reconciles it even if record() rejects.
    file.recorded = true; await args.journal.record(file.path, maximum);
    rootFence(); check();
    file.fd = openSync(file.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    file.stamp = fstatSync(file.fd, {bigint: true}); regular(file.fd, true);
    if (file.stamp.size !== 0n || !same(file.stamp, named(file.path))) errorCode('RASTER_INPUT_CHANGED');
  };
  try {
    // Admission precedes scratch creation, library mapping and decoder calls.
    lease = await args.admit(reservation);
    if (!lease || typeof lease.release !== 'function') { lease = undefined; errorCode('RASTER_RESOURCES'); }
    check(); scratchDirectory = directory(rootPath, true); directory(dirname(original.path));
    source = openSync(original.path, constants.O_RDONLY | constants.O_NOFOLLOW); originalFence();
    await createOwned(sourceOutput, reservation.sourceScratchBytes);
    let rawStamp = regular(sourceOutput.fd!, true);
    libraryFile = await verifiedLibrary(seal, check); originalFence(); outputFence(sourceOutput, rawStamp);
    const specifier = 'node:ffi', ffi = await import(specifier) as FFI;
    check();
    if (!same(libraryFile.stamp, regular(libraryFile.fd))) errorCode('RASTER_CODEC_UNQUALIFIED');
    library = new ffi.DynamicLibrary('/dev/fd/' + libraryFile.fd);
    if (!same(libraryFile.stamp, regular(libraryFile.fd))) errorCode('RASTER_CODEC_UNQUALIFIED');
    const fn = library.getFunctions({
      IEWebPAdvancedABIVersion: {arguments: [], return: 'uint32'},
      IEWebPAdvancedDecoderVersion: {arguments: [], return: 'uint32'},
      IEWebPAdvancedDecodeFile: {arguments: ['int32', 'int32', 'pointer', 'pointer', 'pointer'], return: 'int32'},
    });
    if (fn.IEWebPAdvancedABIVersion() !== 1 || fn.IEWebPAdvancedDecoderVersion() !== seal.decoderVersion) errorCode('RASTER_CODEC_UNQUALIFIED');
    const transfer = Buffer.alloc(WEBP_IO_BYTES), requestBuffer = Buffer.alloc(112), nativeMetrics = Buffer.alloc(48), cancelPointer = Buffer.from(args.cancellation);
    let nativePeak = 0, outputPeak = 0, copiedBytes = 0, tileCount = 0;
    for (const region of webpTiles(reservation)) {
      originalFence(); outputFence(sourceOutput, rawStamp);
      if (!same(libraryFile.stamp, regular(libraryFile.fd))) errorCode('RASTER_CODEC_UNQUALIFIED');
      tile = {path: join(rootPath, '.webp-import-tile-' + randomUUID()), recorded: false};
      await createOwned(tile, reservation.tileScratchBytes);
      originalFence(); outputFence(sourceOutput, rawStamp);
      const request = encodeWebPRequest(original, reservation, region, requestBuffer);
      nativeMetrics.fill(0);
      const result = Number(fn.IEWebPAdvancedDecodeFile(source, tile.fd!, request, cancelPointer, nativeMetrics));
      const m = metricsFrom(nativeMetrics);
      nativePeak = Math.max(nativePeak, m.nativePeak); outputPeak = Math.max(outputPeak, m.outputPeak);
      if (m.nativeRemaining || m.outputRemaining || result === 7) {
        nativeLeak = poisoned = true;
        quarantinedLibraries.push(library); library = undefined;
        args.quarantine(m); errorCode('RASTER_NATIVE_LEAK');
      }
      if (nativePeak > reservation.nativeBytes || outputPeak > reservation.outputMappingBytes) errorCode('RASTER_RESOURCES');
      if (result !== 0) errorCode(result === 1 || m.allocationDenied ? 'RASTER_RESOURCES' : result === 4 ? 'RASTER_INPUT_CHANGED' :
        result === 6 ? 'RASTER_CANCELED' : result === 3 ? 'RASTER_IO' : result === 5 ? 'RASTER_DECODE_BUSY' : 'RASTER_DECODE');
      check(); originalFence(); outputFence(sourceOutput, rawStamp);
      if (!same(libraryFile.stamp, regular(libraryFile.fd))) errorCode('RASTER_CODEC_UNQUALIFIED');
      const tileBytes = region.cropWidth * region.cropHeight * 4;
      if (m.outputBytesWritten !== tileBytes || !sameObject(tile.stamp!, regular(tile.fd!, true)) ||
          regular(tile.fd!, true).size !== BigInt(tileBytes)) errorCode('RASTER_INPUT_CHANGED');
      fsyncSync(tile.fd!);
      const tileStamp = regular(tile.fd!, true); outputFence(tile, tileStamp);
      for (let row = 0; row < region.height; row++) {
        check();
        const sourceOffset = ((row + region.trimTop) * region.cropWidth + region.trimLeft) * 4;
        const targetOffset = ((row + region.y) * reservation.width + region.x) * 4;
        const rowBytes = region.width * 4;
        for (let at = 0; at < rowBytes;) {
          const wanted = Math.min(transfer.length, rowBytes - at);
          let read = 0;
          while (read < wanted) {
            check(); let n: number;
            try { n = readSync(tile.fd!, transfer, read, wanted - read, sourceOffset + at + read); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'EINTR') continue; throw error; }
            if (n <= 0) errorCode('RASTER_INPUT_CHANGED'); read += n;
          }
          let written = 0;
          while (written < wanted) {
            check(); let n: number;
            try { n = writeSync(sourceOutput.fd!, transfer, written, wanted - written, targetOffset + at + written); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'EINTR') continue; throw error; }
            if (n <= 0) errorCode('RASTER_IO'); written += n;
          }
          at += wanted; copiedBytes += wanted;
        }
        rawStamp = regular(sourceOutput.fd!, true);
        if (rawStamp.size > BigInt(reservation.sourceScratchBytes)) errorCode('RASTER_INPUT_CHANGED');
        if ((row + 1) % 16 === 0) {
          outputFence(tile, tileStamp); outputFence(sourceOutput, rawStamp); originalFence();
          await tick();
          outputFence(tile, tileStamp); outputFence(sourceOutput, rawStamp); originalFence();
        }
      }
      outputFence(tile, tileStamp); outputFence(sourceOutput, rawStamp); originalFence();
      await removeOwned(tile); tile = undefined; tileCount++;
      await tick(); originalFence(); outputFence(sourceOutput, rawStamp);
    }
    if (tileCount !== reservation.tileCount || copiedBytes !== reservation.sourceScratchBytes ||
        rawStamp.size !== BigInt(reservation.sourceScratchBytes)) errorCode('RASTER_DECODE');
    fsyncSync(sourceOutput.fd!); syncRoot(); rawStamp = regular(sourceOutput.fd!, true);
    outputFence(sourceOutput, rawStamp); originalFence();
    if (!same(libraryFile.stamp, regular(libraryFile.fd))) errorCode('RASTER_CODEC_UNQUALIFIED');
    check();
    library.close(); library = undefined; closeSync(libraryFile.fd); libraryFile = undefined;
    closeSync(source); source = undefined;
    // Keep the raw inode descriptor through dispose, so a missing pathname can
    // be distinguished from an untracked rename when releasing disk admission.
    successful = true;
    return {path: output, width: reservation.width, height: reservation.height, bytes: reservation.sourceScratchBytes,
      profile: 'encoded-rgba8', inspectionHash: original.inspectionHash, nativePeak, outputPeak, reservation, dispose};
  } finally {
    try {
      try { library?.close(); }
      finally {
        try { if (libraryFile) closeSync(libraryFile.fd); }
        finally {
          if (source !== undefined) closeSync(source);
        }
      }
    } finally {
      activePreparation = false;
      if (!successful && lease) await dispose();
    }
  }
}

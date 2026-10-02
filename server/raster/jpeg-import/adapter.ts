import {removeJPEGScratch} from './scratch.js';
// STAGED ONLY. There is deliberately no default native identity. Promotion must
// supply a separately produced, reviewed and sealed artifact for each platform.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { inspectOversizedJPEG, jpegScanlineReservation, type OversizedJPEG, type JPEGReservation } from './inspect.js';

export type JPEGSourceStamp = Readonly<{dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint}>;
export type JPEGMetadata = Readonly<{orientation: number; profile: 'untagged-srgb' | 'srgb' | 'p3'; profileHash: string | null}>;
export type JPEGMetadataPolicy = Readonly<{profiles: {srgb: {hash: string}; p3: {hash: string}}; exifOrientation: (exif: Buffer) => number}>;
export type JPEGOriginal = Readonly<{path: string; image: OversizedJPEG; stamp: JPEGSourceStamp; metadata?: JPEGMetadata}>;
export type QualifiedJPEGIdentity = Readonly<{
  status: 'qualified'; kind: 'jpeg-scanline-file-v1'; abiVersion: 1;
  platform: NodeJS.Platform; arch: string;
  artifact: {path: string; bytes: number; hash: string};
  sourceHash: string; producerHash: string; qualificationHash: string;
  residentCodeBytes: number;
}>;
export class JPEGScratchCleanupError extends Error { readonly code='RASTER_SCRATCH_CLEANUP'; constructor(readonly dispose:()=>Promise<void>,options:{cause:unknown}){super('RASTER_SCRATCH_CLEANUP',options);} }
export type JPEGLease = Readonly<{release(): void | Promise<void>}>;
export type JPEGAdmission = (reservation: JPEGReservation) => JPEGLease | Promise<JPEGLease>;
type NativeFunction = (...args: (number | bigint | Buffer)[]) => number | bigint;
type Library = {getFunctions(definitions: Record<string, {arguments: string[]; return: string}>): Record<string, NativeFunction>; close(): void};
type FFI = {DynamicLibrary: new (path: string) => Library};
const hashPattern = /^sha256:[0-9a-f]{64}$/;
const same = (a: JPEGSourceStamp, b: JPEGSourceStamp) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const identity = (a: {dev: bigint; ino: bigint}, b: {dev: bigint; ino: bigint}) => a.dev === b.dev && a.ino === b.ino;
const sourceStamp = (fd: number): JPEGSourceStamp => {
  const s = fstatSync(fd, {bigint: true});
  if (!s.isFile() || s.size > BigInt(Number.MAX_SAFE_INTEGER) || s.nlink !== 1n) throw Error('RASTER_INPUT_CHANGED');
  return Object.freeze({dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs});
};
// Path ancestry is checked without following symlinks. The storage owner must
// additionally bind these paths to its already-owned private roots.
function directory(path: string) {
  let current = path;
  for (;;) {
    const s = lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw Error('RASTER_INPUT_CHANGED');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export function inspectJPEGOriginal(path: string, check: () => void, metadataPolicy: JPEGMetadataPolicy): JPEGOriginal & {metadata: JPEGMetadata};
export function inspectJPEGOriginal(path: string, check: () => void): JPEGOriginal;
export function inspectJPEGOriginal(path: string, check: () => void, metadataPolicy?: JPEGMetadataPolicy): JPEGOriginal {
  directory(dirname(path)); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stamp = sourceStamp(fd), encodedBytes = Number(stamp.size);
    const read = (offset: number, length: number) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536 || offset + length > encodedBytes) throw Error('RASTER_METADATA');
      const bytes = Buffer.alloc(length); let done = 0;
      while (done < length) { check(); const n = readSync(fd, bytes, done, length - done, offset + done); if (!n) throw Error('RASTER_TRUNCATED'); done += n; }
      return bytes;
    };
    const image = inspectOversizedJPEG(read, encodedBytes, check);
    let metadata: JPEGMetadata | undefined;
    if (metadataPolicy) {
      if (![metadataPolicy.profiles.srgb.hash, metadataPolicy.profiles.p3.hash].every(h => hashPattern.test(h)) || typeof metadataPolicy.exifOrientation !== 'function') throw Error('RASTER_METADATA');
      let profile: JPEGMetadata['profile'] = 'untagged-srgb', profileHash: string | null = null;
      if (image.icc) {
        const digest = createHash('sha256');
        // APP2 ICC segments are sorted by their declared sequence, not file
        // order. Hash their assembled logical stream without an assembled copy.
        for (const segment of image.icc) digest.update(read(segment.offset, segment.length));
        profileHash = 'sha256:' + digest.digest('hex');
        if (profileHash === metadataPolicy.profiles.srgb.hash) profile = 'srgb';
        else if (profileHash === metadataPolicy.profiles.p3.hash) profile = 'p3';
        else throw Error('RASTER_PROFILE');
      }
      const orientation = image.exif ? metadataPolicy.exifOrientation(read(image.exif.offset, image.exif.length)) : 1;
      if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw Error('RASTER_METADATA');
      metadata = Object.freeze({orientation, profile, profileHash});
    }
    if (!same(stamp, sourceStamp(fd))) throw Error('RASTER_INPUT_CHANGED');
    return Object.freeze({path, image, stamp, ...(metadata ? {metadata} : {})});
  } finally { closeSync(fd); }
}
function validateSeal(seal: QualifiedJPEGIdentity | undefined): asserts seal is QualifiedJPEGIdentity {
  if (!seal || seal.status !== 'qualified' || seal.kind !== 'jpeg-scanline-file-v1' || seal.abiVersion !== 1 || seal.platform !== process.platform || seal.arch !== process.arch ||
      ![seal.artifact.hash, seal.sourceHash, seal.producerHash, seal.qualificationHash].every(h => hashPattern.test(h)) ||
      !Number.isSafeInteger(seal.artifact.bytes) || seal.artifact.bytes < 1 || !Number.isSafeInteger(seal.residentCodeBytes) || seal.residentCodeBytes < seal.artifact.bytes) throw Error('RASTER_CODEC_UNQUALIFIED');
}
function openVerifiedLibrary(seal: QualifiedJPEGIdentity) {
  directory(dirname(seal.artifact.path));
  const fd = openSync(seal.artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW), block = Buffer.alloc(65536), digest = createHash('sha256');
  try {
    const before = sourceStamp(fd); if (before.size !== BigInt(seal.artifact.bytes)) throw Error('RASTER_CODEC_UNQUALIFIED');
    let n: number; while ((n = readSync(fd, block))) digest.update(block.subarray(0, n));
    if ('sha256:' + digest.digest('hex') !== seal.artifact.hash || !same(before, sourceStamp(fd))) throw Error('RASTER_CODEC_UNQUALIFIED');
    return {fd, stamp: before};
  } catch (error) { closeSync(fd); throw error; }
}

export async function prepareOversizedJPEG(args: {
  original: JPEGOriginal; output: string; seal?: QualifiedJPEGIdentity;
  admit: JPEGAdmission; check: () => void; cancellation: SharedArrayBuffer;
}): Promise<{path: string; width: number; height: number; bytes: number; profile: 'encoded-rgb-rgba8'; nativePeak: number; reservation: JPEGReservation; dispose(): Promise<void>}> {
  const {original, output, check} = args;
  check(); validateSeal(args.seal);
  if (!(args.cancellation instanceof SharedArrayBuffer) || args.cancellation.byteLength !== 4) throw Error('RASTER_RESOURCES');
  const plan = jpegScanlineReservation(original.image);
  const reservation = Object.freeze({...plan, hostBytes: plan.hostBytes + args.seal.residentCodeBytes, cpuBytes: plan.cpuBytes + args.seal.residentCodeBytes});
  if (!Number.isSafeInteger(reservation.cpuBytes)) throw Error('RASTER_RESOURCES');
  // This gate precedes the library mapping, row/native allocations, output
  // creation and any decoder call. Inspection itself used bounded JS pages.
  const lease = await args.admit(reservation);
  if (!lease || typeof lease.release !== 'function') throw Error('RASTER_RESOURCES');
  let source: number | undefined, target: number | undefined, targetStamp: JPEGSourceStamp | undefined, library: Library | undefined, libraryFile: {fd: number; stamp: JPEGSourceStamp} | undefined, succeeded = false;
  let released=false,disposing:Promise<void>|undefined;
  const dispose=():Promise<void>=>{
    if(released)return Promise.resolve();if(disposing)return disposing;
    disposing=(async()=>{
      if(targetStamp){if(target===undefined)throw Error('RASTER_INPUT_CHANGED');removeJPEGScratch(output,target,targetStamp);targetStamp=undefined;}
      if(target!==undefined){closeSync(target);target=undefined;}
      await lease.release();released=true;
    })().catch(error=>{disposing=undefined;throw new JPEGScratchCleanupError(dispose,{cause:error});});return disposing;
  };
  try {
    check(); directory(dirname(original.path)); directory(dirname(output));
    source = openSync(original.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!same(original.stamp, sourceStamp(source))) throw Error('RASTER_INPUT_CHANGED');
    target = openSync(output, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    targetStamp = sourceStamp(target);
    // The only dynamic import is the documented host FFI surface. The bridge
    // cannot retain Buffer pointers or native state after this synchronous call.
    const specifier = 'node:ffi', ffi = await import(specifier) as FFI;
    libraryFile = openVerifiedLibrary(args.seal);
    // Both qualified target platforms must prove descriptor-path loading. No
    // path reopen occurs between hash verification and dlopen of the artifact.
    library = new ffi.DynamicLibrary('/dev/fd/' + libraryFile.fd);
    const fn = library.getFunctions({
      IEJPEGABIVersion: {arguments: [], return: 'uint32'},
      IEJPEGDecodeRGBAFile: {arguments: ['int32', 'uint64', 'int32', 'uint32', 'uint32', 'uint64', 'pointer', 'pointer', 'pointer', 'pointer'], return: 'int32'},
    });
    if (fn.IEJPEGABIVersion() !== 1) throw Error('RASTER_CODEC_UNQUALIFIED');
    const peak = Buffer.alloc(8), remaining = Buffer.alloc(8), denied = Buffer.alloc(8), cancel = Buffer.from(args.cancellation);
    const result = Number(fn.IEJPEGDecodeRGBAFile(source, BigInt(original.image.encodedBytes), target, original.image.width, original.image.height, BigInt(reservation.nativeBytes), cancel, peak, remaining, denied));
    const nativePeak = Number(peak.readBigUInt64LE());
    if (nativePeak > reservation.nativeBytes || remaining.readBigUInt64LE() !== 0n) throw Error('RASTER_RESOURCES');
    if (result !== 0) throw Error(result === 1 || denied.readBigUInt64LE() ? 'RASTER_RESOURCES' : result === 4 ? 'RASTER_INPUT_CHANGED' : result === 6 ? 'RASTER_CANCELED' : result === 3 ? 'RASTER_IO' : result === 5 ? 'RASTER_DECODE_BUSY' : 'RASTER_DECODE');
    check();
    if (!same(libraryFile.stamp, sourceStamp(libraryFile.fd))) throw Error('RASTER_CODEC_UNQUALIFIED');
    if (Atomics.load(new Uint32Array(args.cancellation), 0)) throw Error('RASTER_CANCELED');
    if (!same(original.stamp, sourceStamp(source))) throw Error('RASTER_INPUT_CHANGED');
    const after = sourceStamp(target), named = lstatSync(output, {bigint: true});
    if (!identity(targetStamp, after) || !identity(after, named) || !named.isFile() || named.isSymbolicLink() || after.size !== BigInt(reservation.scratchBytes)) throw Error('RASTER_INPUT_CHANGED');
    fsyncSync(target);
    // Close the synchronous native lifetime before transferring scratch and its
    // resource lease to the next stage. The disk charge remains held until
    // dispose removes exactly this owned output, including after cancellation.
    library.close(); library = undefined;
    closeSync(libraryFile.fd); libraryFile = undefined;
    closeSync(source); source = undefined;
    // Keep the source scratch inode held through controlled P3 normalization.
    succeeded = true;
    return {path: output, width: original.image.width, height: original.image.height, bytes: reservation.scratchBytes, profile: 'encoded-rgb-rgba8', nativePeak, reservation,
      dispose};
  } finally {
    const failures:unknown[]=[];
    for(const finish of [()=>library?.close(),()=>{if(libraryFile!==undefined)closeSync(libraryFile.fd);},()=>{if(source!==undefined)closeSync(source);}])try{finish();}catch(error){failures.push(error);}
    if(!succeeded||failures.length)try{await dispose();}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'JPEG import cleanup failed');
  }
}

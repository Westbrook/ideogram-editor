import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CODECS } from './codec-platform.js';
import { directWebPLibraryPath } from './webp.js';
import { boundedWebPLibraryPath, verifyBoundedWebP } from './bounded-webp.js';
import { BOUNDED_WEBP } from './webp-platform.js';
import { LINUX_COLOR } from './linux-color-platform.js';
import { linuxColorLibraryPath, verifyLinuxColor } from './linux-color.js';
import { openWebPOutputBridge, outputMetrics, type WebPOutputMetrics } from './webp-output.js';
import { sameWebPSource } from './webp-metadata.js';

// The same CC0 libvips built-in sRGB profile already retained in
// tooling/raster/srgb.icc and sealed by CODECS.profiles. Keeping its exact bytes
// here makes the installed runtime independent of the checkout/cwd. This is a
// copy of the existing qualified profile, not a newly generated ICC profile.
const SRGB = 'AAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb';
const PIXELS = 16 * 1024;
export const WEBP_COLOR_SCRATCH_BYTES = PIXELS * 3 * 2;
// The native wrapper uses public LCMS2 RGB8, perceptual intent0 and NOCACHE,
// matching the existing libvips conversion. It owns all handles in one C call.
// https://github.com/mm2/Little-CMS/blob/master/include/lcms2.h
// https://github.com/libvips/libvips/blob/master/libvips/colour/icc_transform.c
type NativeFunction = (...args: (number | bigint | Buffer)[]) => number | bigint;
type Library = { getFunctions(definitions: Record<string, { arguments: string[]; return: string }>): Record<string, NativeFunction>; getSymbol(name: string): bigint; close(): void };
type FFI = { DynamicLibrary: new (path: string) => Library };
export type WebPColorConverter = { convertInPlace(rgba: Buffer, p3: Uint8Array, check: () => void): Promise<void>; convertFileInPlace(fd:number,rawBytes:number,p3:Uint8Array,check:()=>void):Promise<WebPOutputMetrics>; close(): void };

function requireProfile(bytes: Uint8Array, profile: 'srgb' | 'p3'): void {
  const expected = CODECS.profiles[profile];
  if (bytes.length !== expected.bytes || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== expected.hash) throw Error('RASTER_PROFILE');
}
function requireLibrary(path: string): void {
  const expected = CODECS.files.find(file => path.endsWith(file.path.replace(/^node_modules\//, '')));
  if (!expected) throw Error('RASTER_CODEC_UNQUALIFIED');
  const fd = openSync(path, constants.O_RDONLY), block = Buffer.alloc(64 * 1024), hash = createHash('sha256');
  try {
    if (fstatSync(fd).size !== expected.bytes) throw Error('RASTER_CODEC_UNQUALIFIED');
    let length: number, total = 0;
    while ((length = readSync(fd, block))) { total += length; hash.update(block.subarray(0, length)); }
    if (total !== expected.bytes || 'sha256:' + hash.digest('hex') !== expected.hash) throw Error('RASTER_CODEC_UNQUALIFIED');
  } finally { closeSync(fd); }
}

// Opening resolves the optional native interface only. Profiles, the transform,
// and pixel scratch are allocated by convertInPlace after resource admission.
export async function openWebPColorConverter(): Promise<WebPColorConverter | null> {
  const path = directWebPLibraryPath(), boundedPath = LINUX_COLOR ? linuxColorLibraryPath() : boundedWebPLibraryPath(); if (!path || !boundedPath) return null;
  requireLibrary(path); verifyBoundedWebP(); verifyLinuxColor();
  let lib: Library | undefined, bounded: Library | undefined, fn: Record<string, NativeFunction>;
  const functions = Buffer.alloc((LINUX_COLOR ? 10 : 6) * 8);
  try {
    const specifier = 'node:ffi', ffi = await import(specifier) as FFI;
    lib = new ffi.DynamicLibrary(path); bounded = new ffi.DynamicLibrary(boundedPath);
    if (LINUX_COLOR) {
      fn = bounded.getFunctions({
        IELinuxColorABIVersion: { arguments: [], return: 'uint32' },
        IELinuxColorConvertRGBA: { arguments: ['pointer', 'uint64', 'pointer', 'uint32', 'pointer', 'uint32'], return: 'int32' },
      });
      if (fn.IELinuxColorABIVersion() !== LINUX_COLOR.abiVersion) { bounded.close(); lib.close(); return null; }
      ['vips_image_new_from_memory', 'vips_image_set_blob_copy', 'vips_icc_transform', 'vips_image_write_to_memory', 'g_object_unref', 'g_free', 'vips_error_clear', 'vips_cache_get_max', 'vips_concurrency_get', 'vips_version'].forEach((name, index) => functions.writeBigUInt64LE(lib!.getSymbol(name), index * 8));
    } else {
      const cmm = lib.getFunctions({ cmsGetEncodedCMMversion: { arguments: [], return: 'int32' } });
      fn = bounded.getFunctions({
        IEWebPABIVersion: { arguments: [], return: 'uint32' },
        IEWebPConvertP3RGBA: { arguments: ['pointer', 'uint64', 'pointer', 'uint32', 'pointer', 'uint32', 'pointer', 'uint32'], return: 'int32' },
      });
      // LCMS 2.19.1 reports the public 2.19 ABI value (2190). The qualified
      // library's exact hash above distinguishes the patch build.
      if (cmm.cmsGetEncodedCMMversion() !== 2190 || fn.IEWebPABIVersion() !== BOUNDED_WEBP.abiVersion) { bounded.close(); lib.close(); return null; }
      ['cmsGetEncodedCMMversion', 'cmsOpenProfileFromMem', 'cmsCreateTransform', 'cmsDoTransform', 'cmsDeleteTransform', 'cmsCloseProfile'].forEach((name, index) => functions.writeBigUInt64LE(lib!.getSymbol(name), index * 8));
    }
  } catch { bounded?.close(); lib?.close(); return null; }
  const outputBridge=await openWebPOutputBridge();if(!outputBridge){bounded.close();lib.close();return null;}
  let converterPointer:bigint;try{converterPointer=bounded.getSymbol(LINUX_COLOR?'IELinuxColorConvertRGBA':'IEWebPConvertP3RGBA');}catch{outputBridge.close();bounded.close();lib.close();return null;}
  const library = lib, native = bounded; let closed = false, busy = false;
  return {
    close() { if (busy) throw Error('RASTER_COLOR_BUSY'); if (!closed) { closed = true; native.close(); library.close(); outputBridge.close(); functions.fill(0); } },
    async convertFileInPlace(fd,rawBytes,p3,check){
      if(closed||busy)throw Error('RASTER_COLOR_BUSY');
      if(!Number.isSafeInteger(rawBytes)||rawBytes<=0||rawBytes%4||rawBytes>100000000)throw Error('RASTER_LENGTH');
      if(!(p3 instanceof Uint8Array)||p3.length!==CODECS.profiles.p3.bytes)throw Error('RASTER_PROFILE');
      const source=Buffer.from(p3),target=Buffer.from(SRGB,'base64');requireProfile(source,'p3');requireProfile(target,'srgb');busy=true;
      try{check();const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.size!==BigInt(rawBytes))throw Error('RASTER_INPUT_CHANGED');
        const peak=Buffer.alloc(8),remaining=Buffer.alloc(8);
        const status=outputBridge.convert(fd,BigInt(rawBytes),LINUX_COLOR?2:1,source,source.length,target,target.length,functions,LINUX_COLOR?10:6,converterPointer,peak,remaining);
        const metrics=outputMetrics(peak,remaining,rawBytes);
        if(status===0&&metrics.outputPeak<rawBytes)throw Error('RASTER_RESOURCES');
        if(status!==0)throw Error(status===2?'RASTER_LENGTH':status===4?'RASTER_CODEC_UNQUALIFIED':status===7?'RASTER_RESOURCES':status===8?'RASTER_INPUT_CHANGED':'RASTER_RESOURCES');
        const written=fstatSync(fd,{bigint:true});check();const after=fstatSync(fd,{bigint:true});if(!sameWebPSource(written,after)||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size)throw Error('RASTER_INPUT_CHANGED');return metrics;
      }finally{source.fill(0);target.fill(0);busy=false;}
    },
    async convertInPlace(rgba, p3, check) {
      if (closed || busy) throw Error('RASTER_COLOR_BUSY');
      if (!Buffer.isBuffer(rgba) || rgba.length === 0 || rgba.length % 4 || rgba.length > 100_000_000) throw Error('RASTER_LENGTH');
      if (!(p3 instanceof Uint8Array) || p3.length !== CODECS.profiles.p3.bytes) throw Error('RASTER_PROFILE');
      // Copy the small profile before validation so caller mutation cannot
      // replace bytes after the trust check while a native handle retains them.
      const source = Buffer.from(p3), target = Buffer.from(SRGB, 'base64');
      requireProfile(source, 'p3'); requireProfile(target, 'srgb');
      busy = true;
      try {
        check();
        // One synchronous C call creates the profiles/transform, converts in
        // 96 KiB strips and closes all native handles. Worker termination cannot
        // strand a handle between JS safepoints. Native code never calls JS.
        const status = LINUX_COLOR
          ? fn.IELinuxColorConvertRGBA(rgba, BigInt(rgba.length), source, source.length, functions, 10)
          : fn.IEWebPConvertP3RGBA(rgba, BigInt(rgba.length), source, source.length, target, target.length, functions, 6);
        if (status !== 0) throw Error(status === 2 ? 'RASTER_LENGTH' : status === 4 ? 'RASTER_CODEC_UNQUALIFIED' : 'RASTER_RESOURCES');
        check();
      } finally {
        // Keep both profile buffers strongly reachable through the native call.
        source.fill(0); target.fill(0); busy = false;
      }
    },
  };
}

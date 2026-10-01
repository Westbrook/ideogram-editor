import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { extent } from '../../src/raster/core.js';
import { BOUNDED_WEBP } from './webp-platform.js';
import { sameWebPSource, type WebPSourceStamp } from './webp-metadata.js';

export const BOUNDED_WEBP_NATIVE_BYTES = 128 * 1024 * 1024;
export const BOUNDED_WEBP_COLOR_BYTES = 32 * 1024 * 1024;
export type BoundedWebPMetrics = { nativeBudget: number; nativePeak: number; nativeRemaining: number; nativeDenied: number };
export type BoundedWebPDecoder = {
  decode(path: string, width: number, height: number, encodedBytes: number, check: () => void, budget?: number, expectedStamp?: WebPSourceStamp): { data: Buffer; metrics: BoundedWebPMetrics };
  close(): void;
};
type NativeFunction = (...args: (number | bigint | Buffer)[]) => number | bigint;
type Library = { getFunctions(definitions: Record<string, { arguments: string[]; return: string }>): Record<string, NativeFunction>; close(): void };
type FFI = { DynamicLibrary: new (path: string) => Library };

export function boundedWebPLibraryPath(): string | null {
  if (process.platform !== BOUNDED_WEBP.platform || process.arch !== BOUNDED_WEBP.arch) return null;
  const require = createRequire(import.meta.url), modules = dirname(dirname(dirname(require.resolve('sharp'))));
  return join(dirname(modules), BOUNDED_WEBP.path);
}
export function verifyBoundedWebP(): void {
  const path = boundedWebPLibraryPath(); if (!path) throw Error('RASTER_CODEC_UNQUALIFIED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), block = Buffer.alloc(64 * 1024), digest = createHash('sha256');
  try {
    if (fstatSync(fd).size !== BOUNDED_WEBP.bytes) throw Error('RASTER_CODEC_UNQUALIFIED');
    let total = 0, n: number; while ((n = readSync(fd, block))) { total += n; digest.update(block.subarray(0, n)); }
    if (total !== BOUNDED_WEBP.bytes || 'sha256:' + digest.digest('hex') !== BOUNDED_WEBP.hash) throw Error('RASTER_CODEC_UNQUALIFIED');
  } finally { closeSync(fd); }
}

export async function openBoundedWebP(): Promise<BoundedWebPDecoder | null> {
  const path = boundedWebPLibraryPath(); if (!path) return null;
  // A changed required input is corruption, not permission to try another codec.
  verifyBoundedWebP(); let lib: Library | undefined;
  try {
    const specifier = 'node:ffi', ffi = await import(specifier) as FFI;
    lib = new ffi.DynamicLibrary(path);
    const fn = lib.getFunctions({
      IEWebPABIVersion: { arguments: [], return: 'uint32' },
      IEWebPDecoderVersion: { arguments: [], return: 'uint32' },
      IEWebPDecodeRGBA: { arguments: ['int32', 'uint64', 'pointer', 'uint64', 'int32', 'int32', 'uint64', 'pointer', 'pointer', 'pointer'], return: 'int32' },
    });
    if (fn.IEWebPABIVersion() !== BOUNDED_WEBP.abiVersion || fn.IEWebPDecoderVersion() !== 0x010600) { lib.close(); return null; }
    const library = lib; let closed = false, busy = false;
    return {
      close() { if (busy) throw Error('RASTER_DECODE_BUSY'); if (!closed) { closed = true; library.close(); } },
      decode(input, width, height, encodedBytes, check, budget = BOUNDED_WEBP_NATIVE_BYTES, expectedStamp) {
        extent(width, height); if (closed || busy) throw Error('RASTER_DECODE_BUSY');
        if (!Number.isSafeInteger(budget) || budget < 0 || budget > BOUNDED_WEBP_NATIVE_BYTES || !Number.isSafeInteger(encodedBytes) || encodedBytes < 0) throw Error('RASTER_RESOURCES');
        busy = true; let fd: number | undefined;
        try {
          check(); fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW);
          const before = fstatSync(fd, { bigint: true });
          if (!before.isFile() || before.size !== BigInt(encodedBytes) || expectedStamp && !sameWebPSource(before, expectedStamp)) throw Error('RASTER_INPUT_CHANGED');
          const data = Buffer.alloc(width * height * 4), peak = Buffer.alloc(8), remaining = Buffer.alloc(8), denied = Buffer.alloc(8);
          // The entire native lifetime is inside one synchronous FFI call. Even
          // Worker.terminate waits for this C call's cleanup. No native handles
          // or borrowed Buffer pointers escape to a JS continuation/safepoint.
          const status = fn.IEWebPDecodeRGBA(fd, BigInt(encodedBytes), data, BigInt(data.length), width, height, BigInt(budget), peak, remaining, denied);
          const metrics = { nativeBudget: budget, nativePeak: Number(peak.readBigUInt64LE()), nativeRemaining: Number(remaining.readBigUInt64LE()), nativeDenied: Number(denied.readBigUInt64LE()) };
          if (metrics.nativePeak > budget || metrics.nativeRemaining !== 0) throw Error('RASTER_RESOURCES');
          if (status !== 0) throw Error(status === 1 || status === 3 || metrics.nativeDenied ? 'RASTER_RESOURCES' : status === 5 ? 'RASTER_INPUT_CHANGED' : status === 6 ? 'RASTER_LENGTH' : 'RASTER_DECODE');
          check(); const after = fstatSync(fd, { bigint: true });
          if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw Error('RASTER_INPUT_CHANGED');
          return { data, metrics };
        } finally { if (fd !== undefined) closeSync(fd); busy = false; }
      },
    };
  } catch { lib?.close(); return null; }
}

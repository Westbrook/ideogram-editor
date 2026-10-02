import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';
import { createDeflateRaw, createInflateRaw, constants as zlibConstants } from 'node:zlib';
import type { DeflateRaw, InflateRaw } from 'node:zlib';
import { extent } from '../../src/raster/core.js';
import type { BlobRef } from '../../src/protocol/store.js';
import { assertComponents, assertPrivate, sameFile } from '../storage/files.js';

export const R16_ENCODED_MEDIA_TYPE = 'application/x-ideogram-r16le-deflate';
export const R16_ENCODED_CODEC = 'r16le-deflate-v1';
export const R16_ENCODED_CHUNK_BYTES = 65536;
// Conservative admission allowance for the input block, zlib output block and
// native zlib state at windowBits=15/memLevel=8. Excludes the worker/runtime
// baseline; this is an allowance, not a measured RSS or a full-image allocation.
export const R16_ENCODED_ALLOCATION_BYTES = 512 * 1024;

const RAW_MEDIA_TYPE = 'application/x-ideogram-r16le';
const HEADER_BYTES = 24;
// Eight exact bytes: ASCII "IER16LE", then the format version byte 1.
// LE uint32 width, LE uint32 height, LE uint64 raw byte length follow, then
// exactly one complete raw DEFLATE stream. There are no optional/trailing fields.
const MAGIC = Buffer.from([0x49, 0x45, 0x52, 0x31, 0x36, 0x4c, 0x45, 1]);
const bad = (code: string): never => { throw new Error(code); };
const stamp = (s: Stats) => [s.dev, s.ino, s.size, s.mode, s.uid, s.nlink, s.mtimeMs, s.ctimeMs].join(':');

function rawLength(width: number, height: number): number {
  extent(width, height);
  return width * height * 2;
}

function write(fd: number, bytes: Buffer, check: () => void): void {
  if (bytes.length > R16_ENCODED_CHUNK_BYTES) bad('R16_BLOCK');
  for (let offset = 0; offset < bytes.length;) {
    check();
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) bad('R16_WRITE');
    offset += count;
  }
}

function read(fd: number, bytes: Buffer, position: number, count: number, check: () => void): void {
  if (count > R16_ENCODED_CHUNK_BYTES || count > bytes.length) bad('R16_BLOCK');
  for (let offset = 0; offset < count;) {
    check();
    const got = readSync(fd, bytes, offset, count - offset, position + offset);
    if (!got) bad('R16_LENGTH');
    offset += got;
  }
}

// A failed zlib transform may emit error/close without invoking its write
// callback. Keep exactly one bounded listener pair for the current block, and
// remove both on every settlement so successful blocks cannot accumulate work.
function submit(zip: DeflateRaw | InflateRaw, bytes: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (failed: boolean, error?: unknown) => {
      if (settled) return;
      settled = true; zip.off('error', errored); zip.off('close', closed);
      if (failed) reject(error); else resolve();
    };
    const errored = (error: Error) => settle(true, error);
    const closed = () => settle(true, zip.errored ?? new Error('R16_STREAM'));
    zip.once('error', errored); zip.once('close', closed);
    if (zip.destroyed) { closed(); return; }
    try { zip.write(bytes, error => settle(error != null, error)); }
    catch (error) { settle(true, error); }
  });
}

// One submitted input block at a time. Data callbacks synchronously consume at
// most one zlib output block, so no unbounded stream queue or Buffer.concat is
// needed. Awaiting each write callback also prevents reuse of an in-flight block.
async function transfer(
  fd: number, start: number, size: number, zip: DeflateRaw | InflateRaw,
  consume: (bytes: Buffer) => void, check: () => void, strictInput: boolean,
): Promise<void> {
  // Both completion and physical close are observed before the first write.
  // File descriptors and owned output remain alive until zlib has closed.
  const closed = new Promise<void>(resolve => zip.once('close', resolve));
  const completed = finished(zip, { cleanup: true });
  void completed.catch(() => {});
  let consumerFailed = false, consumerError: unknown;
  zip.on('data', (bytes: Buffer) => {
    try { check(); consume(bytes); }
    catch (error) {
      consumerFailed = true; consumerError = error;
      zip.destroy(error instanceof Error ? error : new Error('R16_CONSUMER'));
    }
  });
  try {
    const block = Buffer.alloc(R16_ENCODED_CHUNK_BYTES);
    for (let offset = 0; offset < size;) {
      check();
      const count = Math.min(block.length, size - offset);
      read(fd, block, start + offset, count, check);
      await submit(zip, block.subarray(0, count));
      offset += count;
      // Raw inflate stops at its first end marker. bytesWritten is the public
      // count of compressed input consumed, not the size of decoded output.
      if (strictInput && zip.bytesWritten !== offset) bad('R16_TRAILING');
    }
    zip.end();
    await completed;
    zip.destroy();
    await closed;
    if (consumerFailed) throw consumerError;
    if (strictInput && zip.bytesWritten !== size) bad('R16_TRAILING');
  } catch (error) {
    zip.destroy();
    await Promise.allSettled([completed, closed]);
    if (consumerFailed) throw consumerError;
    if (error instanceof Error && 'code' in error && String(error.code).startsWith('Z_')) {
      throw new Error('R16_STREAM', { cause: error });
    }
    throw error;
  }
}

async function files(
  input: string, output: string, check: () => void,
  run: (source: number, target: number, size: number) => Promise<void>,
): Promise<void> {
  check();
  assertComponents(dirname(input)); assertComponents(dirname(output));
  assertPrivate(dirname(input), true); assertPrivate(dirname(output), true);
  const identity = assertPrivate(input, false), initialStamp = stamp(identity);
  const source = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target: number | undefined, outputIdentity: Stats | undefined, complete = false;
  try {
    if (!sameFile(identity, fstatSync(source)) || stamp(fstatSync(source)) !== initialStamp) bad('R16_INPUT_CHANGED');
    target = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    outputIdentity = fstatSync(target);
    if (!sameFile(outputIdentity, assertPrivate(output, false))) bad('R16_OUTPUT_CHANGED');
    await run(source, target, identity.size);
    check();
    if (stamp(fstatSync(source)) !== initialStamp || stamp(assertPrivate(input, false)) !== initialStamp) bad('R16_INPUT_CHANGED');
    if (!sameFile(outputIdentity, assertPrivate(output, false))) bad('R16_OUTPUT_CHANGED');
    fsyncSync(target);
    check();
    const closing = target; target = undefined; closeSync(closing);
    complete = true;
  } finally {
    try { if (target !== undefined) closeSync(target); }
    finally {
      try { closeSync(source); }
      finally {
        if (!complete && outputIdentity) {
          // An EEXIST target was never ours. Likewise, do not unlink an unrelated
          // replacement if a caller violated the private-directory ownership.
          try { if (sameFile(outputIdentity, lstatSync(output))) unlinkSync(output); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    }
  }
}

/** Encode canonical row-major R16LE bytes without changing any 16-bit sample. */
export async function encodeR16(input: string, output: string, width: number, height: number, check: () => void): Promise<void> {
  check();
  const length = rawLength(width, height);
  await files(input, output, check, async (source, target, size) => {
    if (size !== length) bad('R16_LENGTH');
    const header = Buffer.alloc(HEADER_BYTES);
    header.set(MAGIC); header.writeUInt32LE(width, 8); header.writeUInt32LE(height, 12); header.writeBigUInt64LE(BigInt(length), 16);
    write(target, header, check);
    const zip = createDeflateRaw({
      level: 6, windowBits: 15, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY,
      chunkSize: R16_ENCODED_CHUNK_BYTES,
    });
    await transfer(source, 0, length, zip, bytes => write(target, bytes, check), check, false);
  });
}

/** Decode only this format and authenticate the exact canonical raw BlobRef. */
export async function decodeR16(
  input: string, output: string, width: number, height: number, expected: BlobRef, check: () => void,
): Promise<void> {
  check();
  const length = rawLength(width, height);
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).sort().join(',') !== 'byteLength,hash,mediaType' ||
      expected.mediaType !== RAW_MEDIA_TYPE || expected.byteLength !== String(length) ||
      typeof expected.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expected.hash)) bad('R16_IDENTITY');
  await files(input, output, check, async (source, target, size) => {
    if (size <= HEADER_BYTES) bad('R16_FORMAT');
    const header = Buffer.alloc(HEADER_BYTES);
    read(source, header, 0, header.length, check);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header.readUInt32LE(8) !== width ||
        header.readUInt32LE(12) !== height || header.readBigUInt64LE(16) !== BigInt(length)) bad('R16_FORMAT');
    const hash = createHash('sha256');
    let decoded = 0;
    const zip = createInflateRaw({ windowBits: 15, chunkSize: R16_ENCODED_CHUNK_BYTES });
    await transfer(source, HEADER_BYTES, size - HEADER_BYTES, zip, bytes => {
      if (bytes.length > R16_ENCODED_CHUNK_BYTES || decoded + bytes.length > length) bad('R16_LENGTH');
      decoded += bytes.length; hash.update(bytes); write(target, bytes, check);
    }, check, true);
    if (decoded !== length) bad('R16_LENGTH');
    if ('sha256:' + hash.digest('hex') !== expected.hash) bad('R16_HASH');
  });
}

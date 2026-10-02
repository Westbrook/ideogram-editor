import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname } from 'node:path';
import { extent } from '../../src/raster/core.js';
import { encodedExtent } from '../../src/protocol/raster-import.js';
import { assertComponents, assertPrivate } from '../storage/files.js';

export const WEBP_METADATA_BYTES = 4 * 1024 * 1024;
export const WEBP_MAX_CHUNKS = 1024;
export type WebPSourceStamp = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>;
export type WebPMetadataChunk = { offset: number; length: number };
export type WebPMetadataDescriptor = {
  width: number; height: number; encodedBytes: number;
  // null means the first chunk was a simple VP8/VP8L image. A later VP8X
  // must not activate metadata flags: the frozen demuxer ignores it.
  flags: number | null; bitstreamHasAlpha: boolean;
  image: WebPMetadataChunk & { type: 'VP8 ' | 'VP8L' }; alpha?: WebPMetadataChunk;
  icc?: WebPMetadataChunk; exif?: WebPMetadataChunk; stamp: WebPSourceStamp;
};
export type WebPMetadata = {
  format: 'webp'; width: number; height: number; space: 'srgb'; depth: 'uchar';
  orientation: number; hasAlpha: boolean; icc?: Buffer; exif?: Buffer;
  pages?: never; delay?: never; loop?: never;
};

export function webpSourceStamp(stat: WebPSourceStamp): WebPSourceStamp {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}
export function sameWebPSource(a: WebPSourceStamp, b: WebPSourceStamp): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
const metadataError = (): never => { throw Error('RASTER_METADATA'); };
const normalized = (value: number) => value >= 1 && value <= 8 ? value : 1;

// Only IFD0 orientation affects pixels. This implements the pinned libvips
// 8.18.6 / libexif 0.6.26 interpretation without loading or expanding other
// tags. In particular, libexif clips TIFF parsing to 65528 bytes, keeps the
// first successfully loaded duplicate, and tolerates truncated IFD tables.
// Exact references: libvips/foreign/exif.c (vips__exif_parse, vips_exif_to_s),
// libexif/exif-data.c (exif_data_load_data[_content/_entry]), and
// libexif/exif-entry.c (exif_entry_fix).
export function webpExifOrientation(exif: Buffer): number {
  // Tiny nonempty EXIF makes libvips emit a metadata warning, but Sharp's
  // metadata() still returns the original blob without an orientation.
  if (exif.length < 4) return 1;
  let start = 0;
  if (exif.toString('latin1', 0, 4) === 'Exif') {
    if (exif.length < 6 || exif[4] !== 0 || exif[5] !== 0) return 1;
    start = 6;
  }
  const bytes = exif.subarray(start, start + 65528);
  if (bytes.length < 8) return 1;
  const order = bytes.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const little = order === 'II';
  const u16 = (at: number) => little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
  const u32 = (at: number) => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  const s32 = (at: number) => little ? bytes.readInt32LE(at) : bytes.readInt32BE(at);
  if (u16(2) !== 42) return 1;
  const directory = u32(4);
  if (directory > bytes.length - 2) return 1;
  const count = Math.min(u16(directory), Math.floor((bytes.length - directory - 2) / 12));
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  for (let i = 0; i < count; i++) {
    const at = directory + 2 + i * 12;
    if (u16(at) !== 0x0112) continue;
    const format = u16(at + 2), components = u32(at + 4), size = (sizes[format] ?? 0) * components;
    if (!size) continue;
    const valueAt = size > 4 ? u32(at + 8) : at + 8;
    if (valueAt >= bytes.length || size > bytes.length - valueAt) continue;
    // The first valid entry wins, including an unsupported orientation type.
    // With >=10 components libvips uses libexif's descriptive error string,
    // whose atoi() result is zero and is normalized to one.
    if (components >= 10) return 1;
    if (format === 1 || format === 6) return normalized(bytes[valueAt]);
    if (format === 3 || format === 8) return normalized(u16(valueAt));
    if (format === 4 || format === 9) return normalized(u32(valueAt) & 0xffff);
    // libvips formats these as numerator/denominator; atoi takes only the
    // numerator. A zero denominator does not change orientation handling.
    if (format === 5) return normalized(u32(valueAt) | 0);
    if (format === 10) return normalized(s32(valueAt));
    return 1;
  }
  return 1;
}

// Call after resource admission. The descriptor comes from a bounded RIFF
// walk, not client input. No encoded-image mapping, native parser, pixel
// accumulator, metadata decompression, or unrelated EXIF graph is involved.
export function readWebPMetadata(path: string, descriptor: WebPMetadataDescriptor, check: () => void = () => {}, originalMetadata = false): WebPMetadata {
  (originalMetadata ? encodedExtent : extent)(descriptor.width, descriptor.height);
  if (!Number.isSafeInteger(descriptor.encodedBytes) || descriptor.encodedBytes < 12 ||
      typeof descriptor.bitstreamHasAlpha !== 'boolean' || (descriptor.flags !== null &&
      (!Number.isInteger(descriptor.flags) || descriptor.flags < 0 || descriptor.flags > 255))) metadataError();
  const flags = descriptor.flags ?? 0;
  if (flags & 2) throw Error('RASTER_ANIMATION');
  if (flags & 0xc1) throw Error('RASTER_FORMAT');
  let total = 0;
  for (const chunk of [descriptor.icc, descriptor.exif]) {
    if (!chunk) continue;
    if (!Number.isSafeInteger(chunk.offset) || !Number.isSafeInteger(chunk.length) || chunk.offset < 20 || chunk.length < 0 ||
        chunk.length > WEBP_METADATA_BYTES || chunk.offset > descriptor.encodedBytes - chunk.length) metadataError();
    total += chunk.length;
  }
  if (total > WEBP_METADATA_BYTES) throw Error('RASTER_RESOURCES');
  if (descriptor.icc && descriptor.exif && descriptor.icc.offset < descriptor.exif.offset + descriptor.exif.length &&
      descriptor.exif.offset < descriptor.icc.offset + descriptor.icc.length) metadataError();
  check(); assertComponents(dirname(path)); assertPrivate(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(descriptor.encodedBytes) || !sameWebPSource(before, descriptor.stamp)) throw Error('RASTER_INPUT_CHANGED');
    const read = (chunk: WebPMetadataChunk | undefined): Buffer | undefined => {
      if (!chunk || !chunk.length) return undefined;
      const data = Buffer.alloc(chunk.length);
      for (let at = 0; at < data.length;) {
        check(); const wanted = Math.min(65536, data.length - at), n = readSync(fd, data, at, wanted, chunk.offset + at);
        if (n <= 0) throw Error('RASTER_INPUT_CHANGED');
        at += n;
      }
      return data;
    };
    // Unflagged chunks are ignored by the frozen WebP demuxer as well.
    const icc = flags & 32 ? read(descriptor.icc) : undefined;
    const exif = flags & 8 ? read(descriptor.exif) : undefined;
    const orientation = exif ? webpExifOrientation(exif) : 1;
    check(); assertPrivate(path, false);
    if (!sameWebPSource(before, fstatSync(fd, { bigint: true })) || !sameWebPSource(before, lstatSync(path, { bigint: true }))) throw Error('RASTER_INPUT_CHANGED');
    // In a simple file, the frozen demuxer consumes an immediately trailing
    // ALPH and then clears its alpha flag (even intrinsic VP8L alpha). A later
    // ALPH beyond any intervening chunk is outside that first frame.
    const trailingAlpha = descriptor.alpha?.offset === descriptor.image.offset + descriptor.image.length + (descriptor.image.length % 2) + 8;
    const hasAlpha = descriptor.flags === null ? descriptor.bitstreamHasAlpha && !trailingAlpha : Boolean(flags & 16);
    return { format: 'webp', width: descriptor.width, height: descriptor.height, space: 'srgb', depth: 'uchar', orientation, hasAlpha, ...(icc ? { icc } : {}), ...(exif ? { exif } : {}) };
  } finally { closeSync(fd); }
}

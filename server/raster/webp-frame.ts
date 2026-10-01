import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { assertComponents, assertPrivate, sameFile } from '../storage/files.js';
import { sameWebPSource, webpSourceStamp, type WebPMetadataDescriptor, type WebPSourceStamp } from './webp-metadata.js';

export const webpFrameBytes = (descriptor: WebPMetadataDescriptor) => 20 + descriptor.image.length + descriptor.image.length % 2;

// The frozen demuxer ignores some unflagged ALPH chunks, including malformed
// alpha payloads. Decode the identical VP8/VP8L bitstream in a simple RIFF so
// the bounded decoder cannot accidentally consume that ignored plane. The
// original remains owned and supplies all metadata/provenance.
export async function decodeWebPFrame<T>(path: string, descriptor: WebPMetadataDescriptor, directory: string,
  decode: (framePath: string, encodedBytes: number, stamp: WebPSourceStamp) => T, check: () => void): Promise<T> {
  assertComponents(dirname(path)); assertPrivate(path, false);
  assertComponents(directory); assertPrivate(directory, true);
  const source = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target: number | undefined, targetPath: string | undefined;
  const bytes = webpFrameBytes(descriptor);
  try {
    const before = fstatSync(source, { bigint: true });
    if (!before.isFile() || !sameWebPSource(before, descriptor.stamp) || !Number.isSafeInteger(bytes) ||
        bytes < 20 || bytes > 0xffffffff || descriptor.image.offset < 20 ||
        descriptor.image.offset > descriptor.encodedBytes - descriptor.image.length) throw Error('RASTER_INPUT_CHANGED');
    check(); targetPath = join(directory, '.webp-frame-' + randomUUID());
    target = openSync(targetPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const write = (data: Buffer, at: number) => {
      for (let offset = 0; offset < data.length;) {
        const n = writeSync(target!, data, offset, data.length - offset, at + offset);
        if (!n) throw Error('RASTER_WRITE'); offset += n;
      }
    };
    const header = Buffer.alloc(20); header.write('RIFF'); header.writeUInt32LE(bytes - 8, 4);
    header.write('WEBP', 8); header.write(descriptor.image.type, 12); header.writeUInt32LE(descriptor.image.length, 16);
    write(header, 0);
    const buffer = Buffer.alloc(65536);
    for (let at = 0; at < descriptor.image.length;) {
      check(); const wanted = Math.min(buffer.length, descriptor.image.length - at);
      const n = readSync(source, buffer, 0, wanted, descriptor.image.offset + at);
      if (n !== wanted) throw Error('RASTER_INPUT_CHANGED');
      write(buffer.subarray(0, n), 20 + at); at += n;
      if (at % 1048576 === 0) await tick();
    }
    if (descriptor.image.length % 2) write(Buffer.alloc(1), bytes - 1);
    fsyncSync(target);
    const targetStamp=webpSourceStamp(fstatSync(target,{bigint:true}));
    const fence = () => {
      check();
      if (!sameWebPSource(before, fstatSync(source, { bigint: true })) ||
          !sameWebPSource(before, lstatSync(path, { bigint: true })) ||
          !sameWebPSource(targetStamp,fstatSync(target!,{bigint:true})) ||
          !sameWebPSource(targetStamp,lstatSync(targetPath!,{bigint:true})) ||
          !sameFile(fstatSync(target!), assertPrivate(targetPath!, false))) throw Error('RASTER_INPUT_CHANGED');
    };
    fence(); const result = decode(targetPath, bytes,targetStamp); fence(); return result;
  } finally {
    closeSync(source);
    if (target !== undefined) {
      const owned = fstatSync(target); closeSync(target);
      try { if (targetPath && sameFile(owned, lstatSync(targetPath))) unlinkSync(targetPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

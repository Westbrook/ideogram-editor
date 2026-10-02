import { createDeflate, crc32 } from 'node:zlib';
import { createWriteStream, fstatSync, readSync } from 'node:fs';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Private JPEG loader input only. IDAT framing is deliberately not a canonical
 * asset recipe. A single row is borrowed by zlib until its write callback; the
 * caller owns the input descriptor and the enclosing scratch directory. */
export async function encodeScratchPNG(source: number, output: string, width: number, height: number, check: () => void): Promise<void> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 25000000) throw Error('RASTER_LENGTH');
  check();
  const before = fstatSync(source, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(width * height * 4)) throw Error('RASTER_LENGTH');
  const row = Buffer.alloc(width * 4 + 1), header = Buffer.alloc(8), trailer = Buffer.alloc(4);
  const target = createWriteStream(output, { flags: 'wx', mode: 0o600, highWaterMark: 65536 });
  let targetError: Error | undefined;
  target.on('error', error => { targetError = error; });
  const closed = new Promise<void>(resolve => target.once('close', resolve));
  const put = async (bytes: Uint8Array) => {
    check(); if (targetError) throw targetError; if (target.destroyed) throw Error('RASTER_WRITE');
    // Completion, rather than writable drain, establishes when our small
    // framing buffers may be changed again. Zlib output is likewise immutable
    // until its physical write callback has completed.
    await new Promise<void>((resolve, reject) => target.write(bytes, error => error ? reject(error) : resolve()));
  };
  const chunk = async (type: string, bytes: Uint8Array) => {
    header.writeUInt32BE(bytes.length); header.write(type, 4, 4, 'ascii');
    trailer.writeUInt32BE(crc32(bytes, crc32(header.subarray(4))));
    await put(header); await put(bytes); await put(trailer);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  let zip: ReturnType<typeof createDeflate> | undefined, producing: Promise<void> | undefined, compressorClosed: Promise<void> | undefined;
  try {
    await put(SIGNATURE); await chunk('IHDR', ihdr); await chunk('sRGB', Buffer.from([0]));
    zip = createDeflate({ level: 6, chunkSize: 65536 });
    compressorClosed = new Promise<void>(resolve => zip!.once('close', resolve));
    const compressor = zip;
    producing = (async () => {
      for (let y = 0; y < height; y++) {
        check();
        for (let at = 0; at < width * 4;) {
          const count = readSync(source, row, 1 + at, width * 4 - at, y * width * 4 + at);
          if (!count) throw Error('RASTER_LENGTH'); at += count;
        }
        // The next positional read cannot mutate this row until zlib has
        // consumed the current write. No raw frame or stream carry is retained.
        await new Promise<void>((resolve, reject) => compressor.write(row, error => error ? reject(error) : resolve()));
      }
      compressor.end();
    })();
    producing.catch(error => compressor.destroy(error));
    for await (const data of compressor) await chunk('IDAT', data);
    await producing;
    const after = fstatSync(source, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error('RASTER_INPUT_CHANGED');
    await chunk('IEND', Buffer.alloc(0)); target.end(); await closed; if (targetError) throw targetError;
  } catch (error) {
    target.destroy(); zip?.destroy(); if (producing) await Promise.allSettled([producing]); await closed; throw error;
  } finally {
    // The row producer and output stream can settle before zlib finishes its
    // asynchronous native cleanup. Preserve the original result until close.
    if (compressorClosed) await compressorClosed;
  }
}

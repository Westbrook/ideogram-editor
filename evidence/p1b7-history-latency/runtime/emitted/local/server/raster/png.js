import { createDeflate, crc32 } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function chunk(type, data) {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4, 4, 'ascii');
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4);
    return out;
}
// Deterministic filter0, zlib level6, one64KiB IDAT per deflate output piece.
// Stream row-major canonical bytes without a second full image allocation.
export async function encodePNG(raw, output, width, height, check) {
    const target = createWriteStream(output, { flags: 'wx', mode: 0o600, highWaterMark: 65536 });
    const put = async (b) => { check(); if (!target.write(b))
        await once(target, 'drain'); };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    await put(PNG_SIGNATURE);
    await put(chunk('IHDR', ihdr));
    await put(chunk('sRGB', Buffer.from([0])));
    async function* rows() {
        let carry = Buffer.alloc(0), count = 0;
        for await (const bytes of createReadStream(raw, { highWaterMark: 65536 })) {
            check();
            carry = Buffer.concat([carry, bytes]);
            while (carry.length >= width * 4) {
                yield Buffer.from([0]);
                yield carry.subarray(0, width * 4);
                carry = carry.subarray(width * 4);
                count++;
            }
        }
        if (carry.length || count !== height)
            throw new Error('RASTER_LENGTH');
    }
    const zip = createDeflate({ level: 6, chunkSize: 65536 });
    const producing = pipeline(Readable.from(rows()), zip);
    producing.catch(() => { });
    try {
        for await (const data of zip)
            await put(chunk('IDAT', data));
        await producing;
        await put(chunk('IEND', Buffer.alloc(0)));
        target.end();
        await once(target, 'close');
    }
    catch (e) {
        target.destroy();
        zip.destroy();
        throw e;
    }
}

import { closeSync, openSync, readSync, fstatSync, constants } from 'node:fs';
import { extent } from '../../src/raster/core.js';
import { inspectPNG } from './png-input.js';
// Bound metadata before invoking the native parser. Encoded data is streamed;
// these are work reservations, not a replacement for the document envelope.
export async function inspectContainer(path, mime, check = () => { }) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), length = fstatSync(fd).size;
    let metadataBytes = 0, width = 0, height = 0;
    let pngMetadata;
    const dimensions = (w, h) => { extent(w, h); if (width && (width !== w || height !== h))
        throw new Error('RASTER_FORMAT'); width = w; height = h; };
    const read = (at, n) => { if (at < 0 || n < 0 || at + n > length)
        throw new Error('RASTER_TRUNCATED'); const b = Buffer.alloc(n); if (readSync(fd, b, 0, n, at) !== n)
        throw new Error('RASTER_TRUNCATED'); return b; };
    const metadata = (n) => { metadataBytes += n; if (metadataBytes > 4 * 1024 * 1024)
        throw new Error('RASTER_RESOURCES'); };
    try {
        if (mime === 'image/png') {
            const png = await inspectPNG(read, length, metadata, check);
            dimensions(png.width, png.height);
            pngMetadata = { iccHash: png.iccHash, exifHash: png.exifHash };
        }
        else if (mime === 'image/webp') {
            const h = read(0, 12);
            if (h.toString('ascii', 0, 4) !== 'RIFF' || h.toString('ascii', 8) !== 'WEBP' || h.readUInt32LE(4) + 8 !== length)
                throw new Error('RASTER_TRUNCATED');
            let at = 12, images = 0;
            const seen = new Set();
            while (at < length) {
                const c = read(at, 8), n = c.readUInt32LE(4), type = c.toString('ascii', 0, 4);
                if (at + 8 + n + (n % 2) > length)
                    throw new Error('RASTER_TRUNCATED');
                if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && n >= 1 && (read(at + 8, 1)[0] & 2)))
                    throw new Error('RASTER_ANIMATION');
                if (seen.has(type))
                    throw new Error('RASTER_FORMAT');
                seen.add(type);
                if (type === 'VP8X') {
                    if (n !== 10)
                        throw new Error('RASTER_FORMAT');
                    const b = read(at + 8, 10);
                    dimensions(1 + b.readUIntLE(4, 3), 1 + b.readUIntLE(7, 3));
                }
                if (type === 'VP8 ') {
                    if (n < 10)
                        throw new Error('RASTER_TRUNCATED');
                    const b = read(at + 8, 10);
                    if ((b[0] & 1) || !b.subarray(3, 6).equals(Buffer.from([157, 1, 42])))
                        throw new Error('RASTER_FORMAT');
                    dimensions(b.readUInt16LE(6) & 16383, b.readUInt16LE(8) & 16383);
                }
                if (type === 'VP8L') {
                    if (n < 5)
                        throw new Error('RASTER_TRUNCATED');
                    const b = read(at + 8, 5);
                    if (b[0] !== 47 || (b[4] >> 5) !== 0)
                        throw new Error('RASTER_FORMAT');
                    const bits = b.readUInt32LE(1);
                    dimensions(1 + (bits & 16383), 1 + ((bits >>> 14) & 16383));
                }
                if (type === 'VP8 ' || type === 'VP8L')
                    images++;
                else
                    metadata(n);
                at += 8 + n + n % 2;
            }
            if (at !== length || images !== 1)
                throw new Error('RASTER_FORMAT');
        }
        else if (mime === 'image/jpeg') {
            if (!read(0, 2).equals(Buffer.from([255, 216])))
                throw new Error('RASTER_FORMAT');
            let at = 2, ended = false, scans = 0;
            while (at < length) {
                if (read(at++, 1)[0] !== 255)
                    throw new Error('RASTER_FORMAT');
                let marker = read(at++, 1)[0];
                while (marker === 255)
                    marker = read(at++, 1)[0];
                if (marker === 217) {
                    if (at !== length)
                        throw new Error('RASTER_FORMAT');
                    ended = true;
                    break;
                }
                if (marker === 0 || marker === 216 || (marker >= 208 && marker <= 215))
                    throw new Error('RASTER_FORMAT');
                const n = read(at, 2).readUInt16BE();
                if (n < 2 || at + n > length)
                    throw new Error('RASTER_TRUNCATED');
                if (marker >= 224 || marker === 254)
                    metadata(n);
                if ([192, 193, 194].includes(marker)) {
                    const h = read(at + 2, 6);
                    if (h[0] !== 8)
                        throw new Error('RASTER_DEPTH');
                    dimensions(h.readUInt16BE(3), h.readUInt16BE(1));
                }
                at += n;
                if (marker === 218) {
                    scans++;
                    let found = false;
                    // Entropy scanning in bounded chunks, carrying FF across boundaries.
                    let ff = false;
                    while (at < length && !found) {
                        const data = read(at, Math.min(65536, length - at));
                        for (let i = 0; i < data.length; i++) {
                            const b = data[i];
                            if (ff && b !== 0 && b !== 255 && !(b >= 208 && b <= 215)) {
                                at += i - 1;
                                found = true;
                                break;
                            }
                            ff = b === 255;
                        }
                        if (!found)
                            at += data.length;
                    }
                    if (!found)
                        throw new Error('RASTER_TRUNCATED');
                }
            }
            if (!ended || !scans)
                throw new Error('RASTER_TRUNCATED');
        }
        else
            throw new Error('RASTER_FORMAT');
        if (!width || !height)
            throw new Error('RASTER_FORMAT');
        return { metadataBytes, encodedBytes: length, width, height, pngMetadata };
    }
    finally {
        closeSync(fd);
    }
}

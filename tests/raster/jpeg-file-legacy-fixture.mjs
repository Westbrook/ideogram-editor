// Frozen pre-scratch JPEG file encoder from server18; only dependency locations
// changed. Retain its public encodePNG feeder for exact final-byte comparison.
import { createReadStream, createWriteStream, constants, openSync, fsyncSync, closeSync, fstatSync, lstatSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { encodePNG } from '../../dist/local/server/raster/png.js';
import { extent } from '../../dist/local/src/raster/core.js';
import { assertComponents, assertPrivate, sameFile } from '../../dist/local/server/storage/files.js';
export const JPEG_FILE_TRANSPORT = 'jpeg-file-baseline-v1';
export function jpegAllocationPlan(width, height, transport = JPEG_FILE_TRANSPORT) {
    extent(width, height);
    const raw = width * height * 4;
    // The new path has neither full raw input buffers nor coefficient arrays.
    // Retain two whole RGBA surfaces plus 32 MiB as a conservative reservation until
    // measured per-platform RSS campaigns establish a tighter native allowance.
    // Baseline 8-bit: each 64-coefficient component block has at most 27 bits per
    // coefficient before worst-case byte stuffing. 512 bytes per component block
    // conservatively covers entropy and padding; 2 MiB covers tables/ICC/markers.
    const jpegBytes = 3 * Math.ceil(width / 8) * Math.ceil(height / 8) * 512 + 2 * 1024 * 1024;
    // Legacy replay retains its old bytes, but accounts for both input copies,
    // both full coefficient arrays, and a growing native encoded-output buffer.
    const cpuBytes = transport === JPEG_FILE_TRANSPORT ? 2 * raw + 32 * 1024 * 1024 : 2 * raw + 12 * Math.ceil(width / 8) * 8 * Math.ceil(height / 8) * 8 + 2 * jpegBytes + 32 * 1024 * 1024;
    const scratchBytes = transport === JPEG_FILE_TRANSPORT ? raw + height + 1024 * 1024 : 0;
    return { cpuBytes, diskBytes: raw + jpegBytes + scratchBytes + 2 * 1024 * 1024 };
}
// runRaster verifies the sealed Sharp/libjpeg/profile build before admission.
// Raw pixels are already explicitly flattened in linear sRGB; the encoder never
// chooses a matte, resize kernel or quality on the user's behalf.
async function encodeLegacyJPEG(raw, output, width, height, quality, check) {
    check();
    const guarded = new Transform({ transform(chunk, encoding, done) { try {
            check();
            done(null, chunk);
        }
        catch (error) {
            done(error);
        } } });
    const encoder = sharp({ raw: { width, height, channels: 4 }, limitInputPixels: 25000000 }).removeAlpha().withIccProfile('srgb').jpeg({ quality: Math.max(1, Math.round(quality * 100)), chromaSubsampling: '4:4:4', progressive: false, optimiseCoding: true });
    const sourceFD = openSync(raw, constants.O_RDONLY | constants.O_NOFOLLOW);
    let targetFD;
    try {
        targetFD = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    catch (error) {
        closeSync(sourceFD);
        throw error;
    }
    const source = createReadStream(raw, { fd: sourceFD, autoClose: true, highWaterMark: 65536 });
    const target = createWriteStream(output, { fd: targetFD, autoClose: true, highWaterMark: 65536 });
    await pipeline(source, guarded, encoder, target);
    check();
    const fd = openSync(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
export async function encodeJPEG(raw, output, width, height, quality, check, transport = JPEG_FILE_TRANSPORT) {
    extent(width, height);
    if (!Number.isFinite(quality) || quality <= 0 || quality > 1)
        throw Error('RASTER_FORMAT');
    if (transport === 'jpeg-raw-optimized-v1')
        return encodeLegacyJPEG(raw, output, width, height, quality, check);
    if (transport !== JPEG_FILE_TRANSPORT)
        throw Error('RASTER_PROFILE');
    check();
    assertComponents(dirname(raw));
    assertComponents(dirname(output));
    const sourceIdentity = assertPrivate(raw, false), source = openSync(raw, constants.O_RDONLY | constants.O_NOFOLLOW);
    let target, pngInput, scratch, succeeded = false;
    try {
        const before = fstatSync(source, { bigint: true });
        if (!sameFile(sourceIdentity, fstatSync(source)) || before.size !== BigInt(width * height * 4))
            throw Error('RASTER_LENGTH');
        target = openSync(output, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        scratch = mkdtempSync(join(dirname(output), '.jpeg-'));
        assertPrivate(scratch, true);
        const intermediate = join(scratch, 'pixels.png');
        // POSIX descriptor paths keep the native loader and sink bound to the
        // exclusively opened files. The sealed platforms provide /dev/fd.
        await encodePNG('/dev/fd/' + source, intermediate, width, height, check);
        check();
        const after = fstatSync(source, { bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
            throw Error('RASTER_INPUT_CHANGED');
        pngInput = openSync(intermediate, constants.O_RDONLY | constants.O_NOFOLLOW);
        const result = await sharp('/dev/fd/' + pngInput, { limitInputPixels: 25000000, sequentialRead: true, ignoreIcc: true, failOn: 'warning' })
            .removeAlpha().withIccProfile('srgb')
            .jpeg({ quality: Math.max(1, Math.round(quality * 100)), chromaSubsampling: '4:4:4', progressive: false, optimiseCoding: false, trellisQuantisation: false, overshootDeringing: false, optimiseScans: false, quantisationTable: 0 })
            .toFile('/dev/fd/' + target);
        check();
        if (result.width !== width || result.height !== height || result.channels !== 3 || result.format !== 'jpeg')
            throw Error('RASTER_LENGTH');
        if (!sameFile(fstatSync(target), assertPrivate(output, false)))
            throw Error('RASTER_INPUT_CHANGED');
        fsyncSync(target);
        succeeded = true;
    }
    finally {
        if (pngInput !== undefined)
            closeSync(pngInput);
        closeSync(source);
        if (target !== undefined) {
            const identity = fstatSync(target);
            closeSync(target);
            if (!succeeded) {
                try {
                    if (sameFile(identity, lstatSync(output)))
                        unlinkSync(output);
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
            }
        }
        if (scratch !== undefined)
            rmSync(scratch, { recursive: true, force: true });
    }
}

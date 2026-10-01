// The reference fixture retains the previous file JPEG encoder, including its
// public PNG feeder. Its imports alone point to the current frozen dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { crc32, inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { rootFor } from '../store/helpers.mjs';
import { legacyExportPixels } from './native-matte-legacy-fixture.mjs';
import { verifyCodecs } from '../../dist/local/server/raster/engine.js';
import { encodeScratchPNG } from '../../dist/local/server/raster/png-scratch.js';
import { encodeJPEG as candidateJPEG, jpegAllocationPlan as candidatePlan } from '../../dist/local/server/raster/jpeg.js';
import { encodeJPEG as referenceJPEG, jpegAllocationPlan as referencePlan } from './jpeg-file-legacy-fixture.mjs';

function pixels(width, height) {
  const data = Buffer.alloc(width * height * 4), alpha = [0, 1, 127, 128, 254, 255]; let seed = 0x74a3952f;
  for (let i = 0; i < data.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; data[i] = i % 4 === 3 ? alpha[(i >>> 2) % alpha.length] : seed & 255; }
  return data;
}
function verifyPNG(bytes, expected, width, height) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = [], types = []; let at = 8;
  while (at < bytes.length) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8); assert(at + size + 12 <= bytes.length);
    assert.equal(bytes.readUInt32BE(at + 8 + size), crc32(bytes.subarray(at + 4, at + 8 + size))); types.push(type);
    if (type === 'IHDR') { assert.equal(size, 13); assert.equal(bytes.readUInt32BE(at + 8), width); assert.equal(bytes.readUInt32BE(at + 12), height); assert.deepEqual([...bytes.subarray(at + 16, at + 21)], [8, 6, 0, 0, 0]); }
    if (type === 'sRGB') assert.deepEqual([...bytes.subarray(at + 8, at + 8 + size)], [0]);
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + size));
    if (type === 'IEND') { assert.equal(size, 0); assert.equal(at + 12, bytes.length); }
    at += size + 12;
  }
  assert.deepEqual(types.slice(0, 2), ['IHDR', 'sRGB']); assert.equal(types.at(-1), 'IEND'); assert(types.slice(2, -1).every(t => t === 'IDAT'));
  const filtered = inflateSync(Buffer.concat(idat)); assert.equal(filtered.length, (width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { const start = y * (width * 4 + 1); assert.equal(filtered[start], 0); assert.deepEqual(filtered.subarray(start + 1, start + 1 + width * 4), expected.subarray(y * width * 4, (y + 1) * width * 4)); }
}
async function rawFixture(t, width, height) {
  const root = await rootFor(t), raw = join(root, 'pixels.rgba'), data = pixels(width, height); await writeFile(raw, data, { mode: 0o600 });
  return { root, raw, data, width, height };
}
async function scratch(f, output, check = () => {}) {
  const fd = fs.openSync(f.raw, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { await encodeScratchPNG(fd, output, f.width, f.height, check); }
  finally { assert.equal(fs.fstatSync(fd).size, f.data.length, 'Borrowed source remains open even after failure'); fs.closeSync(fd); }
}

test('scratch PNG independently inflates to exact RGBA, alpha and hidden RGB across extent/row boundaries', async t => {
  verifyCodecs(); sharp.cache(false); sharp.concurrency(1);
  for (const [width, height] of [[1, 1], [31, 29], [273, 289], [8192, 1], [1, 8192], [8192, 17]]) {
    const f = await rawFixture(t, width, height), png = join(f.root, 'scratch.png'); await scratch(f, png);
    const bytes = await readFile(png); verifyPNG(bytes, f.data, width, height);
    const decoded = await sharp(png, { ignoreIcc: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([decoded.info.width, decoded.info.height, decoded.info.channels], [width, height, 4]); assert.deepEqual(decoded.data, f.data);
  }
});

test('one owned row survives partial input reads and slow physical output callbacks without alias corruption', async t => {
  const f = await rawFixture(t, 8191, 19), output = join(f.root, 'slow.png'), identity = fs.statSync(f.raw);
  const read = fs.readSync, create = fs.createWriteStream, buffers = new Set(); let inputBytes = 0, maximumRead = 0, delayed = 0;
  const readPatch = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const info = fs.fstatSync(fd), source = info.dev === identity.dev && info.ino === identity.ino;
    const count = read(fd, buffer, offset, source ? Math.min(length, 997) : length, position);
    if (source) { buffers.add(buffer); inputBytes += count; maximumRead = Math.max(maximumRead, count); } return count;
  });
  const writePatch = t.mock.method(fs, 'createWriteStream', (path, options) => create(path, { ...options, highWaterMark: 1,
    fs: { open: fs.open, close: fs.close, write(...args) { delayed++; setTimeout(() => fs.write(...args), 1); }, writev(...args) { delayed++; setTimeout(() => fs.writev(...args), 1); } } }));
  syncBuiltinESMExports();
  try { await scratch(f, output); } finally { readPatch.mock.restore(); writePatch.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(buffers.size, 1); assert.equal([...buffers][0].length, f.width * 4 + 1); assert.equal(inputBytes, f.data.length); assert(maximumRead <= 997); assert(delayed > 10);
  verifyPNG(await readFile(output), f.data, f.width, f.height);
});

test('final JPEG bytes remain exact across quality, custom mattes, alpha and frozen tile boundaries', async t => {
  for (const [width, height] of [[31, 29], [273, 289], [8192, 1]]) {
    const f = await rawFixture(t, width, height);
    for (const matte of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#27b4c9']) {
      const flat = join(f.root, matte.slice(1) + '.rgba');
      await legacyExportPixels({ path: f.raw, width, height }, flat, width, height, matte);
      for (const quality of [0.01, 0.5, 0.9, 1]) {
        const name = matte.slice(1) + '-' + quality, current = join(f.root, name + '-candidate.jpg'), retained = join(f.root, name + '-reference.jpg');
        await referenceJPEG(flat, retained, width, height, quality, () => {}); await candidateJPEG(flat, current, width, height, quality, () => {});
        assert.deepEqual(await readFile(current), await readFile(retained), `${width}x${height} ${matte} q${quality}`);
      }
    }
    assert.deepEqual(await readFile(f.raw), f.data); assert(!(await readdir(f.root)).some(n => n.startsWith('.jpeg-')));
  }
});

test('cancelled scratch writes close before removal/retry, preserve borrowed input and make bounded reads', async t => {
  for (const phase of ['before', 'rows']) {
    const f = await rawFixture(t, 2048, 512), output = join(f.root, 'cancelled.png'), identity = fs.statSync(f.raw), read = fs.readSync; let consumed = 0;
    const patch = t.mock.method(fs, 'readSync', (fd, ...args) => { const info = fs.fstatSync(fd), n = read(fd, ...args); if (info.dev === identity.dev && info.ino === identity.ino) consumed += n; return n; }); syncBuiltinESMExports();
    try { await assert.rejects(scratch(f, output, () => { if (phase === 'before' || consumed >= f.width * 4 * 5) throw Error('TEST_CANCEL_' + phase); }), new RegExp('TEST_CANCEL_' + phase)); }
    finally { patch.mock.restore(); syncBuiltinESMExports(); }
    assert(consumed < f.data.length / 2); if (fs.existsSync(output)) await unlink(output);
    await scratch(f, output); verifyPNG(await readFile(output), f.data, f.width, f.height); assert.deepEqual(await readFile(f.raw), f.data);
  }
});

test('JPEG-only wiring removes owned intermediate/target after cancellation and native loader failure', async t => {
  for (const phase of ['png', 'native', 'corrupt']) {
    const f = await rawFixture(t, 31, 29), output = join(f.root, 'output.jpg'); let reached = false;
    const check = () => {
      const directory = fs.readdirSync(f.root).find(n => n.startsWith('.jpeg-')), png = directory ? join(f.root, directory, 'pixels.png') : null;
      const bytes = png && fs.existsSync(png) ? fs.readFileSync(png) : null, complete = bytes?.length >= 12 && bytes.subarray(-8, -4).toString() === 'IEND';
      if (!reached && phase === 'corrupt' && complete) { fs.writeFileSync(png, 'not a PNG'); reached = true; }
      if (phase === 'png' && bytes?.length && !complete || phase === 'native' && fs.existsSync(output) && fs.statSync(output).size) { reached = true; throw Error('TEST_CANCEL_' + phase); }
    };
    await assert.rejects(candidateJPEG(f.raw, output, f.width, f.height, 0.9, check)); assert(reached); assert.deepEqual(await readdir(f.root), ['pixels.rgba']);
    await candidateJPEG(f.raw, output, f.width, f.height, 0.9, () => {}); assert.equal((await sharp(output).metadata()).format, 'jpeg'); assert.deepEqual(await readFile(f.raw), f.data);
  }
});

test('the private feeder keeps all current JPEG resource reservations unchanged', () => {
  for (const [width, height] of [[1, 1], [8192, 1], [5000, 5000]]) {
    assert.deepEqual(candidatePlan(width, height), referencePlan(width, height));
    assert.deepEqual(candidatePlan(width, height, 'jpeg-raw-optimized-v1'), referencePlan(width, height, 'jpeg-raw-optimized-v1'));
  }
});

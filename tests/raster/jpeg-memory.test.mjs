import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { rootFor } from '../store/helpers.mjs';
import { encodeJPEG, jpegAllocationPlan, JPEG_FILE_TRANSPORT } from '../../dist/local/server/raster/jpeg.js';
import { verifyCodecs, hash, resourcePlan } from '../../dist/local/server/raster/engine.js';
import { CODECS } from '../../dist/local/server/raster/codec-platform.js';

async function input(t, width = 31, height = 29) {
  const root = await rootFor(t), raw = join(root, 'pixels.rgba'), data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([(x * 43 + y * 7) % 256, (x * 13 + y * 71) % 256, (x * 109 + y * 3) % 256, 255], (y * width + x) * 4);
  await writeFile(raw, data, { mode: 0o600 }); return { root, raw, data, width, height };
}
function tables(bytes) {
  const result = [];
  for (let at = 2; at < bytes.length;) {
    assert.equal(bytes[at++], 255); while (bytes[at] === 255) at++;
    const marker = bytes[at++]; if (marker === 0xda || marker === 0xd9) break;
    const size = bytes.readUInt16BE(at);
    if (marker === 0xdb) result.push(bytes.subarray(at + 2, at + size));
    at += size;
  }
  return Buffer.concat(result);
}
function scratchPNG(root) {
  const directory = readdirSync(root).find(name => name.startsWith('.jpeg-'));
  if (!directory) return null;
  const path = join(root, directory, 'pixels.png'); return existsSync(path) ? path : null;
}
function completePNG(path) { const bytes = readFileSync(path); return bytes.length >= 12 && bytes.subarray(-8, -4).toString() === 'IEND'; }

test('file JPEG retains legacy decoded pixels, quantization tables, profile and sampling across quality boundaries', async t => {
  verifyCodecs(); sharp.cache(false); sharp.concurrency(1);
  for (const [width, height] of [[31, 29], [8192, 1]]) {
    const f = await input(t, width, height);
    for (const quality of [0.01, 0.5, 0.9, 1]) {
      const current = join(f.root, `current-${quality}.jpeg`), legacy = join(f.root, `legacy-${quality}.jpeg`);
      await encodeJPEG(f.raw, current, width, height, quality, () => {});
      await encodeJPEG(f.raw, legacy, width, height, quality, () => {}, 'jpeg-raw-optimized-v1');
      const newBytes = await readFile(current), oldBytes = await readFile(legacy), metadata = await sharp(newBytes).metadata();
      assert.deepEqual(await sharp(newBytes, { ignoreIcc: true }).raw().toBuffer(), await sharp(oldBytes, { ignoreIcc: true }).raw().toBuffer());
      assert.deepEqual(tables(newBytes), tables(oldBytes));
      assert.equal(hash(metadata.icc), CODECS.profiles.srgb.hash);
      assert.deepEqual([metadata.width, metadata.height, metadata.channels, metadata.chromaSubsampling, metadata.isProgressive], [width, height, 3, '4:4:4', false]);
      assert.equal((await readdir(f.root)).some(name => name.startsWith('.jpeg-')), false);
    }
    assert.deepEqual(await readFile(f.raw), f.data);
  }
});

test('exclusive JPEG sink refuses existing files and symlinks without modifying their bytes', async t => {
  const f = await input(t), victim = join(f.root, 'victim'), link = join(f.root, 'link.jpeg');
  await writeFile(victim, 'retained original', { mode: 0o600 }); await symlink(victim, link);
  for (const output of [victim, link]) await assert.rejects(encodeJPEG(f.raw, output, f.width, f.height, 0.9, () => {}), { code: 'EEXIST' });
  assert.equal(await readFile(victim, 'utf8'), 'retained original');
  assert.equal((await readdir(f.root)).some(name => name.startsWith('.jpeg-')), false);
});

test('JPEG cancellation before preparation, during PNG and after native output removes only owned work', async t => {
  for (const phase of ['before', 'png', 'native']) {
    const f = await input(t), output = join(f.root, 'output.jpeg'); let cancelled = false;
    const check = () => {
      const png = scratchPNG(f.root), reached = phase === 'before' || phase === 'png' && png && statSync(png).size > 0 && !completePNG(png) || phase === 'native' && existsSync(output) && statSync(output).size > 0;
      if (reached) { cancelled = true; throw Error('TEST_CANCEL_' + phase); }
    };
    await assert.rejects(encodeJPEG(f.raw, output, f.width, f.height, 0.9, check), new RegExp('TEST_CANCEL_' + phase));
    assert.equal(cancelled, true); assert.deepEqual(await readdir(f.root), ['pixels.rgba']); assert.deepEqual(await readFile(f.raw), f.data);
  }
});

test('a native loader failure closes the exclusive output and removes its private intermediate', async t => {
  const f = await input(t), output = join(f.root, 'output.jpeg'); let corrupted = false;
  await assert.rejects(encodeJPEG(f.raw, output, f.width, f.height, 0.9, () => {
    const png = scratchPNG(f.root);
    if (!corrupted && png && completePNG(png)) { writeFileSync(png, Buffer.from('not an image')); corrupted = true; }
  }));
  assert.equal(corrupted, true); assert.deepEqual(await readdir(f.root), ['pixels.rgba']);
  await encodeJPEG(f.raw, output, f.width, f.height, 0.9, () => {});
  assert.equal((await sharp(output).metadata()).format, 'jpeg');
});

test('25 MP JPEG file admission reserves scratch and stuffed entropy output before encoding', () => {
  const plan = jpegAllocationPlan(5000, 5000), baseline = resourcePlan(5000, 5000);
  assert.equal(JPEG_FILE_TRANSPORT, 'jpeg-file-baseline-v1');
  assert.ok(baseline.cpuBytes + plan.cpuBytes < 384 * 1024 * 1024);
  assert.ok(plan.diskBytes > 2 * 100000000 + 3 * 625 * 625 * 512);
  assert.ok(jpegAllocationPlan(5000, 5000, 'jpeg-raw-optimized-v1').cpuBytes > plan.cpuBytes);
});

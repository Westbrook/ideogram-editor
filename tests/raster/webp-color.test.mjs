import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { openWebPColorConverter, WEBP_COLOR_SCRATCH_BYTES } from '../../dist/local/server/raster/webp-color.js';

// Match the worker's qualified native settings. The Linux bridge verifies
// these before borrowing a strip and never changes global library settings.
sharp.cache(false); sharp.concurrency(1);

const profile = await readFile(new URL('../../tooling/raster/p3.icc', import.meta.url));
const oracle = JSON.parse(await readFile(new URL('./fixtures/color-oracle.json', import.meta.url)));
const alpha = [0, 128, 255, 64];
const sourcePixels = () => Buffer.from(oracle.sourceRGB.flatMap((_, i) => i % 3 === 0 ? [...oracle.sourceRGB.slice(i, i + 3), alpha[i / 3]] : []));
const expectedPixels = () => Buffer.from(oracle.expectedRGB.flatMap((_, i) => i % 3 === 0 ? [...oracle.expectedRGB.slice(i, i + 3), alpha[i / 3]] : []));

test('bounded P3 conversion matches independent public LCMS oracle including hidden RGB and exact alpha', async () => {
  const converter = await openWebPColorConverter(); assert.ok(converter);
  try {
    const rgba = sourcePixels(), identity = rgba.buffer;
    assert.equal(await converter.convertInPlace(rgba, profile, () => {}), undefined);
    assert.equal(rgba.buffer, identity); assert.deepEqual(rgba, expectedPixels());
    assert.equal(WEBP_COLOR_SCRATCH_BYTES, 96 * 1024);
  } finally { converter.close(); }
});

test('bounded P3 strips match the frozen Sharp conversion across lossy and lossless WebP and alpha', async () => {
  const converter = await openWebPColorConverter(); assert.ok(converter);
  const width = 200, height = 100, pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set([(i * 17 + Math.floor(i / 53)) % 256, (i * 29 + 7) % 256, (i * 43 + 31) % 256, alpha[i % alpha.length]], i * 4);
  try {
    for (const lossless of [false, true]) {
      const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } }).withIccProfile('p3').webp({ lossless, quality: 91 }).toBuffer();
      const icc = (await sharp(bytes, { ignoreIcc: true }).metadata()).icc;
      const rgba = await sharp(bytes, { ignoreIcc: true }).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer();
      const originalAlpha = rgba.filter((_, i) => i % 4 === 3);
      const expected = await sharp(bytes).withIccProfile('srgb', { attach: false }).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer();
      let checks = 0; await converter.convertInPlace(rgba, icc, () => { checks++; });
      assert.deepEqual(rgba, expected, lossless ? 'lossless' : 'lossy');
      assert.deepEqual(rgba.filter((_, i) => i % 4 === 3), originalAlpha);
      assert.equal(checks, 2, 'cancellation is checked around one native call that owns both strips');
    }
  } finally { converter.close(); }
});

test('conversion rejects unsealed profiles and invalid pixel lengths before changing pixels', async () => {
  const converter = await openWebPColorConverter(); assert.ok(converter);
  try {
    const invalid = Buffer.from(profile); invalid[84] ^= 1;
    for (const candidate of [invalid, profile.subarray(0, profile.length - 1), await readFile(new URL('../../tooling/raster/srgb.icc', import.meta.url))]) {
      const rgba = sourcePixels(); await assert.rejects(converter.convertInPlace(rgba, candidate, () => {}), /RASTER_PROFILE/); assert.deepEqual(rgba, sourcePixels());
    }
    for (const rgba of [Buffer.alloc(0), Buffer.alloc(3)]) await assert.rejects(converter.convertInPlace(rgba, profile, () => {}), /RASTER_LENGTH/);
    const rgba = sourcePixels(); await converter.convertInPlace(rgba, profile, () => {}); assert.deepEqual(rgba, expectedPixels());
  } finally { converter.close(); }
});

test('conversion releases every native handle on cancellation and preserves the busy/closed lifetime', async () => {
  const converter = await openWebPColorConverter(); assert.ok(converter);
  try {
    let checks = 0;
    await assert.rejects(converter.convertInPlace(sourcePixels(), profile, () => { if (++checks === 2) throw Error('TEST_CANCEL'); }), /TEST_CANCEL/);
    const rgba = sourcePixels(); await converter.convertInPlace(rgba, profile, () => {}); assert.deepEqual(rgba, expectedPixels());
    let reentrant;
    await converter.convertInPlace(Buffer.alloc(20_000 * 4, 127), profile, () => {
      if (!reentrant) reentrant = converter.convertInPlace(sourcePixels(), profile, () => {});
      assert.throws(() => converter.close(), /RASTER_COLOR_BUSY/);
    });
    await assert.rejects(reentrant, /RASTER_COLOR_BUSY/);
  } finally { converter.close(); }
  await assert.rejects(converter.convertInPlace(sourcePixels(), profile, () => {}), /RASTER_COLOR_BUSY/); converter.close();
});

test('missing optional FFI capability is discovered before allocating a color transform', () => {
  const module = new URL('../../dist/local/server/raster/webp-color.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--no-experimental-ffi', '--import', './tests/session/no-egress.mjs', '--input-type=module', '-e', `const {openWebPColorConverter}=await import(${JSON.stringify(module)});if(await openWebPColorConverter()!==null)process.exit(1);`], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
});

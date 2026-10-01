import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import sharp from 'sharp';
import { rootFor } from '../store/helpers.mjs';
import { openBoundedWebP, BOUNDED_WEBP_NATIVE_BYTES } from '../../dist/local/server/raster/bounded-webp.js';
import { directWebPLibraryPath } from '../../dist/local/server/raster/webp.js';
import { BOUNDED_WEBP } from '../../dist/local/server/raster/webp-platform.js';
import { WEBP_OUTPUT } from '../../dist/local/server/raster/webp-output-platform.js';
import { supportsRasterProfile } from '../../dist/local/server/raster/profile.js';
import { CODEC_ID } from '../../dist/local/server/raster/identity.js';
import { PIXEL_PIPELINE } from '../../dist/local/src/raster/core.js';
import { inspectContainer } from '../../dist/local/server/raster/container.js';
import { runRaster, resourcePlan, verifyCodecs, hash } from '../../dist/local/server/raster/engine.js';
const base = new URL('./fixtures/', import.meta.url);

async function privateFixture(t, name) {
  const root = await rootFor(t), bytes = await readFile(new URL(name, base)), path = join(root, name);
  await writeFile(path, bytes, { mode: 0o600 }); return { root, path, bytes };
}

test('bounded WebP admission charges output, native cap and stack before every static codec', () => {
  assert.equal(directWebPLibraryPath('unsupported', 'arm64'), null);
  assert.equal(directWebPLibraryPath(process.platform, 'unsupported'), null);
  const bounded = resourcePlan(5000, 5000, true, 0, 'webp-bounded');
  assert.equal(bounded.allocations.rawOutput, 100000000);
  assert.equal(bounded.allocations.nativeDecoderAndColor, BOUNDED_WEBP_NATIVE_BYTES);
  assert.equal(bounded.allocations.nativeStackAndIO, 256 * 1024);
  assert.ok(bounded.cpuBytes < 384 * 1024 * 1024);
  assert.ok(resourcePlan(5000, 5000, true, 0, 'webp').cpuBytes > 512 * 1024 * 1024);
});

test('native budget refusal and cancellation release all allocations for a subsequent exact retry', async t => {
  verifyCodecs(); const decoder = await openBoundedWebP(); assert.ok(decoder);
  const { path, bytes } = await privateFixture(t, 'white-lossy.webp'), info = await inspectContainer(path, 'image/webp');
  try {
    assert.throws(() => decoder.decode(path, info.width, info.height, bytes.length, () => {}, 1), /RASTER_RESOURCES/);
    let checks = 0;
    assert.throws(() => decoder.decode(path, info.width, info.height, bytes.length, () => { if (++checks === 2) throw Error('TEST_CANCEL'); }), /TEST_CANCEL/);
    const result = decoder.decode(path, info.width, info.height, bytes.length, () => {});
    assert.deepEqual(result.data, Buffer.alloc(info.width * info.height * 4, 255));
    assert.equal(result.metrics.nativeRemaining, 0); assert.equal(result.metrics.nativeDenied, 0);
    assert.ok(result.metrics.nativePeak <= result.metrics.nativeBudget);
    assert.throws(() => decoder.decode(path, info.width + 1, info.height, bytes.length, () => {}), /RASTER_LENGTH/);
    const replacement = await privateFixture(t, 'white-lossy.webp');
    assert.throws(() => decoder.decode(replacement.path, info.width, info.height, bytes.length, () => {}, undefined, info.webpMetadata.stamp), /RASTER_INPUT_CHANGED/);
    for (const name of ['alpha-lossless.webp', 'alpha-lossy.webp']) {
      const fixture = await privateFixture(t, name), extent = await inspectContainer(fixture.path, 'image/webp');
      const decoded = decoder.decode(fixture.path, extent.width, extent.height, fixture.bytes.length, () => {});
      const expected = await sharp(fixture.bytes, { ignoreIcc: true }).ensureAlpha().raw().toBuffer();
      assert.deepEqual(decoded.data, expected); assert.equal(decoded.metrics.nativeRemaining, 0);
    }
  } finally { decoder.close(); }
  assert.throws(() => decoder.decode(path, info.width, info.height, bytes.length, () => {}), /RASTER_DECODE_BUSY/); decoder.close();
});

test('disabling the optional native interface preserves safe fallback before admission', () => {
  const module = new URL('../../dist/local/server/raster/bounded-webp.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--no-experimental-ffi', '--import', './tests/session/no-egress.mjs', '--input-type=module', '-e', `const {openBoundedWebP}=await import(${JSON.stringify(module)});if(await openBoundedWebP()!==null)process.exit(1);`], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
});

test('bounded WebP matches frozen Sharp pixels and all EXIF orientations', async t => {
  const width = 17, height = 13, source = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) source.set([(x * 17 + y * 3) % 256, (x * 2 + y * 23) % 256, (x * 11 + y * 7) % 256], (y * width + x) * 3);
  for (let orientation = 1; orientation <= 8; orientation++) {
    const root = await rootFor(t), path = join(root, 'oriented.webp');
    const bytes = await sharp(source, { raw: { width, height, channels: 3 } }).webp({ quality: 91 }).withMetadata({ orientation }).toBuffer();
    assert.equal((await sharp(bytes).metadata()).orientation, orientation, 'generated fixture orientation');
    await writeFile(path, bytes, { mode: 0o600 });
    const expected = await sharp(bytes, { ignoreIcc: true }).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer();
    const result = await runRaster({ type: 'decode', directory: root, path, mediaType: 'image/webp', sourceAssetId: 'fixture', original: { hash: hash(bytes), byteLength: String(bytes.length), mediaType: 'image/webp' } }, async () => {}, () => {});
    assert.equal(result.manifest.plan.decodeTransport, 'webp-file-v1'); assert.equal(result.manifest.plan.decoderBuild, BOUNDED_WEBP.hash); assert.equal(result.manifest.plan.outputBuild, WEBP_OUTPUT.hash);
    assert.equal(supportsRasterProfile(result.info.pipeline, result.manifest.plan), true);
    assert.equal(supportsRasterProfile(result.info.pipeline, { ...result.manifest.plan, decoderBuild: 'sha256:' + 'f'.repeat(64) }), false);
    assert.equal(supportsRasterProfile(PIXEL_PIPELINE + '/' + CODEC_ID, result.manifest.plan), false);
    assert.deepEqual(await readFile(join(root, 'pixels.rgba')), expected, `orientation ${orientation}`);
    assert.equal(result.info.conversion.orientation, orientation); assert.equal(result.metrics.nativeRemaining, 0);
  }
});

test('portable decoding profiles retain the historical marker-free and opaque native formats', () => {
  const legacy = PIXEL_PIPELINE + '/' + CODEC_ID;
  assert.equal(supportsRasterProfile(legacy, { kind: 'decoded-native', codec: CODEC_ID }), true);
  assert.equal(supportsRasterProfile(legacy, { kind: 'decoded-native', codec: CODEC_ID, decodeTransport: 'webp-opaque-incremental-v1' }), true);
});

test('input mutation after native decoding is refused before returning its pixels', async t => {
  verifyCodecs(); const decoder = await openBoundedWebP(); assert.ok(decoder);
  const { path, bytes } = await privateFixture(t, 'white-lossy.webp'), info = await inspectContainer(path, 'image/webp'); let checks = 0;
  try {
    assert.throws(() => decoder.decode(path, info.width, info.height, bytes.length, () => {
      if (++checks === 2) { const fd = openSync(path, 'r+'); try { writeSync(fd, Buffer.from('VP8L'), 0, 4, 12); } finally { closeSync(fd); } }
    }), /RASTER_INPUT_CHANGED/);
  } finally { decoder.close(); }
});

test('profiled WebP uses bounded decoding and preserves exact frozen color conversion', async t => {
  const root = await rootFor(t), path = join(root, 'p3.webp');
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 60, b: 30 } } }).withIccProfile('p3').webp({ quality: 91 }).toBuffer();
  await writeFile(path, bytes, { mode: 0o600 });
  const expected = await sharp(bytes).withIccProfile('srgb', { attach: false }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const result = await runRaster({ type: 'decode', directory: root, path, mediaType: 'image/webp', sourceAssetId: 'fixture', original: { hash: hash(bytes), byteLength: String(bytes.length), mediaType: 'image/webp' } }, async () => {}, () => {});
  assert.equal(result.manifest.plan.decodeTransport, 'webp-file-v1');
  assert.deepEqual(await readFile(join(root, 'pixels.rgba')), expected);
  assert.equal(result.info.conversion.colorChanged, true); assert.equal(result.metrics.nativeRemaining, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootFor } from '../store/helpers.mjs';
import { runRaster, hash, PIPELINE } from '../../dist/local/server/raster/engine.js';
import { encodeJPEG } from '../../dist/local/server/raster/jpeg.js';
import { encodePNG } from '../../dist/local/server/raster/png.js';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { rasterManifest } from '../../dist/local/src/protocol/validate.js';
import { legacyExportPixels } from './native-matte-legacy-fixture.mjs';

const ref = (bytes, mediaType) => ({ hash: hash(bytes), byteLength: String(bytes.length), mediaType });
const identity = (bytes, width, height) => hash(canonical({ pipeline: PIPELINE, width, height, tiles: [{ x: 0, y: 0, width, height, hash: hash(bytes) }] }));
const jpeg = (matte, resize = null) => ({ format: 'jpeg', resize, matte, quality: 0.9 });
const png = (resize = null) => ({ format: 'png', resize, matte: null, quality: null });

async function retained(t) {
  const root = await rootFor(t), width = 273, height = 289, path = join(root, 'source.rgba');
  const bytes = Buffer.alloc(width * height * 4), alphas = [0, 1, 127, 128, 254, 255];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    bytes.set([(x * 17 + y * 97) & 255, (x * y + y * 23) & 255, (x * 79 + y * 7) & 255, alphas[(x + 3 * y) % alphas.length]], at);
  }
  // Literal independent probes straddle the old 128-square boundaries.
  bytes.set([255, 255, 255, 128], (127 * width + 128) * 4);
  bytes.set([17, 99, 231, 0], (129 * width + 127) * 4);
  bytes.set([12, 34, 56, 255], (256 * width + 256) * 4);
  await writeFile(path, bytes, { mode: 0o600 });
  const pixels = ref(bytes, 'application/x-ideogram-rgba8');
  const manifestBytes = Buffer.from(canonical({ fixture: 'native-matte-source', width, height, pixels }));
  const manifestPath = join(root, 'source-manifest.json'); await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const info = { schemaVersion: 1, pipeline: PIPELINE, width, height, manifest: ref(manifestBytes, 'application/json'), pixels, pixelIdentity: identity(bytes, width, height), role: 'native', sourceAssetIds: [], conversion: null };
  return { root, width, height, bytes, manifestPath, manifestBytes, input: { id: 'native_matte_source', path, info } };
}

async function unchanged(source) {
  assert.equal((await readFile(source.input.path)).equals(source.bytes), true, 'source RGBA changed');
  assert.equal((await readFile(source.manifestPath)).equals(source.manifestBytes), true, 'source manifest changed');
}

async function compare(source, options) {
  const width = options.resize?.width ?? source.width, height = options.resize?.height ?? source.height;
  const directory = await mkdtemp(join(source.root, 'current-')), legacyDirectory = await mkdtemp(join(source.root, 'legacy-'));
  const oldRaw = join(legacyDirectory, 'pixels.rgba');
  await legacyExportPixels({ path: source.input.path, width: source.width, height: source.height }, oldRaw, width, height, options.matte);
  const result = await runRaster({ type: 'export', directory, input: source.input, dependencies: [source.input.info.manifest], options }, async () => {}, () => {});
  const expected = await readFile(oldRaw), actual = await readFile(join(directory, 'pixels.rgba'));
  assert.equal(actual.equals(expected), true, `canonical matte/resize pixels changed for ${JSON.stringify(options)}`);
  assert.equal(result.info.pixelIdentity, identity(expected, width, height));
  assert.equal(result.info.pixels.hash, hash(expected));
  const name = options.format === 'jpeg' ? 'output.jpeg' : 'output.png', oldOutput = join(legacyDirectory, name);
  if (options.format === 'jpeg') await encodeJPEG(oldRaw, oldOutput, width, height, options.quality, () => {});
  else await encodePNG(oldRaw, oldOutput, width, height, () => {});
  assert.equal((await readFile(join(directory, name))).equals(await readFile(oldOutput)), true, `encoded ${options.format} bytes changed for the same frozen pixels`);
  rasterManifest(result.manifest);
  await unchanged(source);
  return { result, actual, directory };
}

test('native-size JPEG row matte matches the frozen tiled branch for partial alpha, hidden RGB and custom colors', async t => {
  const source = await retained(t);
  const halfWhite = { '#000000': [188, 188, 188, 255], '#ffffff': [255, 255, 255, 255], '#ff0000': [255, 188, 188, 255], '#00ff00': [188, 255, 188, 255], '#0000ff': [188, 188, 255, 255] };
  for (const matte of [...Object.keys(halfWhite), '#1b2751']) {
    const { actual } = await compare(source, jpeg(matte));
    const sample = (x, y) => [...actual.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 4)];
    if (halfWhite[matte]) assert.deepEqual(sample(128, 127), halfWhite[matte]);
    assert.deepEqual(sample(127, 129), [...[1, 3, 5].map(i => parseInt(matte.slice(i, i + 2), 16)), 255]);
    assert.deepEqual(sample(256, 256), [12, 34, 56, 255]);
  }
});

test('PNG native bytes and resized PNG/JPEG pixels retain the prior export branch behavior', async t => {
  const source = await retained(t);
  const native = await compare(source, png());
  assert.equal(native.actual.equals(source.bytes), true, 'native PNG must retain hidden RGB and alpha');
  assert.equal(native.result.info.pixelIdentity, source.input.info.pixelIdentity);
  const resize = { width: 139, height: 137 };
  await compare(source, png(resize));
  await compare(source, jpeg('#35b07f', resize));
});

test('native matte cancellation after former tile boundaries preserves the source and permits an exact retry', async t => {
  const source = await retained(t), options = jpeg('#0000ff'), directory = await mkdtemp(join(source.root, 'cancelled-'));
  const partial = join(directory, 'pixels.rgba'); let cancelled = false;
  await assert.rejects(runRaster({ type: 'export', directory, input: source.input, dependencies: [source.input.info.manifest], options }, async () => {}, () => {
    if (existsSync(partial) && statSync(partial).size > source.width * 128 * 4) { cancelled = true; throw Error('TEST_NATIVE_MATTE_CANCEL'); }
  }), /TEST_NATIVE_MATTE_CANCEL/);
  assert.equal(cancelled, true);
  await unchanged(source);
  await compare(source, options);
});

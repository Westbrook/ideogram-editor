import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { rootFor } from '../store/helpers.mjs';
import { runRaster, hash, PIPELINE } from '../../dist/local/server/raster/engine.js';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { rasterManifest } from '../../dist/local/src/protocol/validate.js';

const identity = [1, 0, 0, 1, 0, 0];
const ref = (bytes, mediaType) => ({ hash: hash(bytes), byteLength: String(bytes.length), mediaType });

async function retained(t, opaque = false) {
  const root = await rootFor(t), width = 273, height = 289;
  const directory = await mkdtemp(join(root, 'source-')), path = join(directory, 'pixels.rgba');
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    bytes[at] = (x * 13 + y * 29 + (x ^ y)) & 255;
    bytes[at + 1] = (x * 71 + y * 3 + ((x * y) >>> 3)) & 255;
    bytes[at + 2] = (x * 5 + y * 113 + (y >>> 2)) & 255;
    bytes[at + 3] = opaque ? 255 : [0, 1, 64, 128, 254, 255][(x + y * 5) % 6];
  }
  await writeFile(path, bytes, { mode: 0o600 });
  // This represents a retained canonical source. Its independently generated
  // coordinates distinguish rows, horizontal tiles, alpha and hidden RGB.
  const pixels = ref(bytes, 'application/x-ideogram-rgba8');
  const tile = { x: 0, y: 0, width, height, hash: hash(bytes) };
  const manifestBytes = Buffer.from(canonical({ fixture: 'row-cache-source', width, height, pixels }));
  const manifestPath = join(directory, 'retained-source.json');
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const info = {
    schemaVersion: 1, pipeline: PIPELINE, width, height,
    manifest: ref(manifestBytes, 'application/json'), pixels,
    pixelIdentity: hash(canonical({ pipeline: PIPELINE, width, height, tiles: [tile] })),
    role: 'native', sourceAssetIds: [], conversion: null,
  };
  return { root, width, height, bytes, manifestBytes, manifestPath, input: { id: 'retained_source', path, info } };
}

const composition = source => ({
  type: 'compose', width: source.width, height: source.height,
  layers: [{ assetId: source.input.id, transform: identity, opacity: 1, mask: null }],
  inputs: [source.input], dependencies: [source.input.info.manifest],
});

async function unchanged(source) {
  assert.equal((await readFile(source.input.path)).equals(source.bytes), true, 'retained source pixels changed');
  assert.equal((await readFile(source.manifestPath)).equals(source.manifestBytes), true, 'retained source metadata changed');
}

test('identity composition preserves every nonuniform row and hidden sample across multiple tiles', async t => {
  const source = await retained(t), directory = await mkdtemp(join(source.root, 'compose-'));
  const result = await runRaster({ ...composition(source), directory }, async () => {}, () => {});
  const raw = await readFile(join(directory, 'pixels.rgba'));
  assert.equal(raw.equals(source.bytes), true, 'identity composition changed pixels across a row or tile boundary');
  assert.equal(result.info.pixelIdentity, source.input.info.pixelIdentity);
  assert.deepEqual([result.info.width, result.info.height], [source.width, source.height]);
  assert.equal((await sharp(join(directory, 'output.png'), { ignoreIcc: true }).ensureAlpha().raw().toBuffer()).equals(source.bytes), true);
  rasterManifest(result.manifest);
  await unchanged(source);
});

test('opaque native-size JPEG matte processing preserves source rows when horizontal tiles revisit them', async t => {
  const source = await retained(t, true), directory = await mkdtemp(join(source.root, 'jpeg-'));
  const options = { format: 'jpeg', resize: null, matte: '#1b2751', quality: 0.9 };
  const result = await runRaster({ type: 'export', directory, input: source.input, dependencies: [source.input.info.manifest], options }, async () => {}, () => {});
  // The source is fully opaque, so matte composition must preserve its exact
  // canonical bytes before JPEG quantization, including every cache revisit.
  assert.equal((await readFile(join(directory, 'pixels.rgba'))).equals(source.bytes), true);
  assert.equal(result.info.pixelIdentity, source.input.info.pixelIdentity);
  assert.equal(result.png.mediaType, 'image/jpeg');
  assert.deepEqual(result.manifest.plan.options, options);
  const metadata = await sharp(join(directory, 'output.jpeg')).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.channels], [source.width, source.height, 3]);
  rasterManifest(result.manifest);
  await unchanged(source);
});

test('cancelling after several tiles leaves retained rows immutable and a fresh retry exact', async t => {
  const source = await retained(t), directory = await mkdtemp(join(source.root, 'cancelled-'));
  const partial = join(directory, 'pixels.rgba');
  let cancelled = false;
  await assert.rejects(runRaster({ ...composition(source), directory }, async () => {}, () => {
    if (existsSync(partial) && statSync(partial).size > source.width * 128 * 4) {
      cancelled = true; throw Error('TEST_ROW_CACHE_CANCEL');
    }
  }), /TEST_ROW_CACHE_CANCEL/);
  assert.equal(cancelled, true, 'cancellation reached a later vertical tile');
  await unchanged(source);
  const retry = await mkdtemp(join(source.root, 'retry-'));
  const result = await runRaster({ ...composition(source), directory: retry }, async () => {}, () => {});
  assert.equal((await readFile(join(retry, 'pixels.rgba'))).equals(source.bytes), true);
  assert.equal(result.info.pixelIdentity, source.input.info.pixelIdentity);
  await unchanged(source);
});

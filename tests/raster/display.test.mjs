import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import sharp from 'sharp';
import { setup, cookieFrom, readHeaders } from '../protocol/helpers.mjs';
import { importRaster, operate, binary, digest } from './helpers.mjs';
import { displayPath, displayDimensions, DISPLAY_PROFILE } from '../../dist/local/src/protocol/display.js';

function readDisplay(f, asset, request, headers = readHeaders(cookieFrom(f.paired))) {
  return new Promise((resolve, reject) => {
    const url = new URL(f.server.origin);
    const req = httpRequest({ hostname: '127.0.0.1', port: url.port, path: displayPath(asset.id, request), headers }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
}
const preview = (asset, edge = 256, basis = 'pixels') => ({ kind: 'preview', edge, basis, identity: basis === 'pixels' ? asset.raster.pixelIdentity : asset.blob.hash });
const tile = (asset, x = 0, y = 0, lod = 0, basis = 'pixels') => ({ kind: 'tile', x, y, lod, basis, identity: basis === 'pixels' ? asset.raster.pixelIdentity : asset.blob.hash });
const decoded = bytes => sharp(bytes, { ignoreIcc: true }).ensureAlpha().raw().toBuffer();
function headers(response, asset, query, width, height) {
  assert.equal(response.status, 200, response.bytes.toString());
  assert.equal(response.headers['x-display-profile'], DISPLAY_PROFILE);
  assert.equal(response.headers['x-display-source'], query.identity);
  assert.equal(response.headers['x-display-basis'], query.basis);
  assert.equal(response.headers['x-display-width'], String(width));
  assert.equal(response.headers['x-display-height'], String(height));
  assert.equal(response.headers['x-display-source-width'], String(asset.raster.width));
  assert.equal(response.headers['x-display-source-height'], String(asset.raster.height));
  assert.equal(response.headers['x-display-lod'], String(query.kind === 'tile' ? query.lod : 0));
  assert.equal(response.headers['content-length'], String(response.bytes.length));
  assert.equal(response.headers.etag, '"' + digest(response.bytes) + '"');
  assert.equal(response.headers['cache-control'], 'no-store');
}

test('display routes authenticate, guard immutable identities, preserve hidden RGBA, and emit no domain change', async t => {
  const f = await setup(t), imported = await importRaster(f, 'hidden-alpha.png'), asset = imported.asset;
  const before = (await f.read('/api/v1/assets/' + asset.id)).json;
  const expected = await decoded((await binary(f, asset.id)).bytes);
  for (const edge of [256, 1024]) {
    const query = preview(asset, edge), response = await readDisplay(f, asset, query);
    headers(response, asset, query, 3, 2); assert.equal(response.headers['content-type'], 'image/png');
    assert.deepEqual(await decoded(response.bytes), expected);
    assert.deepEqual([...response.bytes.subarray(24, 29)], [8, 6, 0, 0, 0]);
  }
  assert.deepEqual((await f.read('/api/v1/assets/' + asset.id)).json, before);
  assert.equal((await readDisplay(f, asset, preview(asset), readHeaders(''))).status, 401);
  assert.equal((await readDisplay(f, asset, { ...preview(asset), identity: 'sha256:' + '0'.repeat(64) })).status, 409);
  assert.equal((await readDisplay(f, imported.input, { ...preview(asset), identity: imported.input.blob.hash, basis: 'encoded' })).status, 403);
  assert.equal((await f.read(displayPath(asset.id, preview(asset)) + '&unexpected=1')).status, 400);
  assert.equal((await f.read(displayPath(asset.id, preview(asset)).replace('edge=256', 'edge=2048'))).status, 400);
  assert.equal((await readDisplay(f, asset, tile(asset, 1))).status, 400);
});

test('512-grid tile fringes preserve row stride and every supported LOD has bounded RGBA dimensions', async t => {
  const f = await setup(t), { asset } = await importRaster(f, 'seam-checker.png');
  const original = await decoded((await binary(f, asset.id)).bytes), query = tile(asset, 1), response = await readDisplay(f, asset, query);
  headers(response, asset, query, 8, 2); assert.equal(response.headers['content-type'], 'application/x-ideogram-rgba8');
  assert.deepEqual(response.bytes, Buffer.concat([original.subarray(512 * 4, 520 * 4), original.subarray((520 + 512) * 4, 520 * 2 * 4)]));
  for (let lod = 1; lod <= 6; lod++) {
    const query = tile(asset, 0, 0, lod), size = displayDimensions(520, 2, query), response = await readDisplay(f, asset, query);
    headers(response, asset, query, size.width, size.height); assert.equal(response.bytes.length, size.width * size.height * 4);
  }
  const small = await readDisplay(f, asset, preview(asset)); headers(small, asset, preview(asset), 256, 1);
  const large = await readDisplay(f, asset, preview(asset, 1024)); headers(large, asset, preview(asset, 1024), 520, 2);
  assert.deepEqual(await decoded(large.bytes), original);
});

test('encoded JPEG display decodes the actual lossy blob rather than pre-encoding export pixels', async t => {
  const f = await setup(t), source = await importRaster(f, 'hidden-alpha.png');
  const exported = await operate(f, { type: 'ExportRaster', assetId: source.asset.id, options: { format: 'jpeg', resize: null, quality: 0.2, matte: '#000000' } });
  const asset = exported.event.payload.asset, expected = await decoded((await binary(f, asset.id)).bytes);
  const encodedQuery = tile(asset, 0, 0, 0, 'encoded'), encoded = await readDisplay(f, asset, encodedQuery);
  headers(encoded, asset, encodedQuery, asset.raster.width, asset.raster.height); assert.deepEqual(encoded.bytes, expected);
  const retained = await readDisplay(f, asset, tile(asset)); assert.notDeepEqual(encoded.bytes, retained.bytes);
  const pngQuery = preview(asset, 256, 'encoded'), png = await readDisplay(f, asset, pngQuery);
  headers(png, asset, pngQuery, asset.raster.width, asset.raster.height); assert.deepEqual(await decoded(png.bytes), expected);
  assert.equal((await readDisplay(f, asset, { ...pngQuery, identity: asset.raster.pixelIdentity })).status, 409);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootFor } from '../store/helpers.mjs';
import { inspectContainer } from '../../dist/local/server/raster/container.js';

const maximum = new URL('./fixtures/max-webp-lossy.webp', import.meta.url);
async function vp8Chunk() {
  const bytes = await readFile(maximum);
  for (let at = 12; at < bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString('ascii', at, at + 4) === 'VP8 ') return bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + size % 2;
  }
  throw Error('Missing sealed VP8 image chunk');
}
async function container(t, name, chunks) {
  const root = await rootFor(t), path = join(root, name);
  const size = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.bytes + chunk.bytes % 2, 0);
  const file = await open(path, 'wx', 0o600);
  try {
    // Sparse zero-filled pixel/ancillary payloads avoid a full encoded copy in
    // this framing test. Native validity is tested separately by decoder tests.
    await file.truncate(size);
    const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(size - 8, 4); header.write('WEBP', 8);
    await file.write(header, 0, header.length, 0);
    let at = 12;
    for (const chunk of chunks) {
      const header = Buffer.alloc(8); header.write(chunk.type); header.writeUInt32LE(chunk.bytes, 4);
      await file.write(header, 0, header.length, at);
      if (chunk.data) await file.write(chunk.data, 0, chunk.data.length, at + 8);
      at += 8 + chunk.bytes + chunk.bytes % 2;
    }
  } finally { await file.close(); }
  return { path, size };
}
const extended = () => {
  const data = Buffer.alloc(10); data[0] = 16;
  data.writeUIntLE(4999, 4, 3); data.writeUIntLE(4999, 7, 3);
  return { type: 'VP8X', bytes: 10, data };
};

test('WebP alpha pixel data above 4 MiB stays encoded input instead of ancillary metadata', async t => {
  const vp8 = await vp8Chunk();
  const input = await container(t, 'raw-alpha.webp', [extended(), { type: 'ALPH', bytes: 25_000_001 }, { type: 'VP8 ', bytes: vp8.length, data: vp8 }]);
  const actual = await inspectContainer(input.path, 'image/webp');
  assert.equal(actual.encodedBytes, input.size); assert.ok(actual.encodedBytes > 25_000_000);
  assert.equal(actual.metadataBytes, 10); assert.equal(actual.width, 5000); assert.equal(actual.height, 5000);
});

test('WebP unknown ancillary metadata retains the exact combined 4 MiB ceiling', async t => {
  const vp8 = await vp8Chunk(), metadataLimit = 4 * 1024 * 1024;
  for (const extra of [0, 1]) {
    const input = await container(t, 'ancillary-' + extra + '.webp', [extended(), { type: 'JUNK', bytes: metadataLimit - 10 + extra }, { type: 'VP8 ', bytes: vp8.length, data: vp8 }]);
    if (extra) await assert.rejects(inspectContainer(input.path, 'image/webp'), /RASTER_RESOURCES/);
    else assert.equal((await inspectContainer(input.path, 'image/webp')).metadataBytes, metadataLimit);
  }
});

test('WebP zero-payload chunk bookkeeping is bounded and remains cancellable', async t => {
  const vp8 = await vp8Chunk();
  for (const extra of [0, 1]) {
    const unknown = Array.from({ length: 1022 + extra }, (_, i) => ({ type: i.toString(16).padStart(4, '0'), bytes: 0 }));
    const input = await container(t, 'chunks-' + extra + '.webp', [extended(), ...unknown, { type: 'VP8 ', bytes: vp8.length, data: vp8 }]);
    if (extra) await assert.rejects(inspectContainer(input.path, 'image/webp'), /RASTER_RESOURCES/);
    else {
      assert.equal((await inspectContainer(input.path, 'image/webp')).metadataBytes, 10);
      let checks = 0;
      await assert.rejects(inspectContainer(input.path, 'image/webp', () => { if (++checks === 10) throw Error('TEST_CANCEL'); }), /TEST_CANCEL/);
      assert.equal(checks, 10);
    }
  }
});

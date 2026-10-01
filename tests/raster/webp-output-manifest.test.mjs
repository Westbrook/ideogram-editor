import test from 'node:test';
import assert from 'node:assert/strict';
import { rasterManifest } from '../../dist/local/src/protocol/validate.js';

const codec = 'sha256:' + '1'.repeat(64), decoderBuild = 'sha256:' + '2'.repeat(64), outputBuild = 'sha256:' + '3'.repeat(64);
const pixels = { hash: 'sha256:' + '4'.repeat(64), byteLength: '4', mediaType: 'application/x-ideogram-rgba8' };
const conversion = { encodedWidth: 1, encodedHeight: 1, orientation: 1, profile: 'untagged-srgb', profileHash: null, colorChanged: false, orientationChanged: false, resized: false };
const manifest = plan => ({ schemaVersion: 1, pipeline: 'cp1-f64-triangle-area-v1/' + codec, width: 1, height: 1,
  format: 'straight-srgb-rgba8', layout: 'row-major-tile-views-v1', tileSize: 512, pixels,
  tiles: [{ x: 0, y: 0, width: 1, height: 1, hash: pixels.hash }], dependencies: [],
  plan: { kind: 'decoded-native', sourceAssetId: 'original', conversion, codec, ...plan } });

test('file-backed WebP manifests require both decoder and output producer seals', () => {
  const plan = { decodeTransport: 'webp-file-v1', decoderBuild, outputBuild };
  assert.doesNotThrow(() => rasterManifest(manifest(plan)));
  for (const changed of [{ ...plan, decoderBuild: undefined }, { ...plan, outputBuild: undefined },
    { ...plan, decoderBuild: 'unknown' }, { ...plan, outputBuild: 'unknown' },
    { ...plan, decodeTransport: 'webp-file-v2' }, { ...plan, unexpected: true }]) {
    const present = Object.fromEntries(Object.entries(changed).filter(([, value]) => value !== undefined));
    assert.throws(() => rasterManifest(manifest(present)));
  }
});

test('historical transports retain their shape and cannot carry an output bridge claim', () => {
  for (const plan of [{}, { decodeTransport: 'webp-opaque-incremental-v1' }, { decodeTransport: 'webp-bounded-v1', decoderBuild }]) {
    assert.doesNotThrow(() => rasterManifest(manifest(plan)));
    assert.throws(() => rasterManifest(manifest({ ...plan, outputBuild })));
  }
  assert.throws(() => rasterManifest(manifest({ decoderBuild })));
  assert.throws(() => rasterManifest(manifest({ decodeTransport: 'webp-opaque-incremental-v1', decoderBuild })));
});

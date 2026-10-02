// Source-only staged regression for the cumulative producer-profile overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PIXEL_PIPELINE } from '../../dist/local/src/raster/core.js';
import { RASTER_PROFILES, resolveRasterProfile } from '../../dist/local/server/raster/profile-registry.js';
import { supportsRasterProfile } from '../../dist/local/server/raster/profile.js';

const producerKinds = ['v45-edit-inputs-1', 'v45-edit-mask-v1', 'solid-background-v1'];
const unknownHash = 'sha256:' + 'f'.repeat(64);

// These are producer-role lookup fixtures, not complete RasterManifest values.
// Portable closure and typed manifest validation must succeed independently
// before this lookup; recognizing a role alone grants no import authority.
test('issued profiles recognize each exact V45 input, V45 mask and solid-background producer role', () => {
  for (const profile of RASTER_PROFILES) for (const kind of producerKinds) {
    const plan = Object.freeze({ kind });
    assert.equal(resolveRasterProfile(profile.pipeline, plan), profile, profile.pipeline + ' / ' + kind);
    assert.deepEqual(plan, { kind }, 'producer identity is not rewritten to the current host profile');
  }
});

test('producer support is an exact allowlist, not a plan-kind or pipeline-prefix match', () => {
  const unissuedKinds = [
    'v45-edit-inputs-2', 'v45-edit-mask-v2', 'solid-background-v2',
    'v45-edit-inputs', 'v45-edit-mask', 'solid-background',
    ...producerKinds.flatMap(kind => [kind + '-future', 'prefix/' + kind, kind + '\0']),
  ];
  for (const profile of RASTER_PROFILES) {
    for (const kind of unissuedKinds) assert.equal(resolveRasterProfile(profile.pipeline, { kind }), undefined, kind);
    for (const kind of producerKinds) {
      for (const pipeline of [
        PIXEL_PIPELINE + '/' + unknownHash,
        'unissued-pixel-pipeline/' + profile.rasterCodecId,
        profile.pipeline + '/future',
        profile.pipeline.replace(PIXEL_PIPELINE, 'unissued-pixel-pipeline'),
        '', null, { pipeline: profile.pipeline },
      ]) assert.equal(resolveRasterProfile(pipeline, { kind }), undefined);
    }
    for (const value of [null, [], {}, { kind: null }, { kind: ['v45-edit-inputs-1'] }]) {
      assert.equal(resolveRasterProfile(profile.pipeline, value), undefined);
    }
  }
});

test('the portable producer-support predicate uses the same retained profile and exact role decisions', () => {
  for (const profile of RASTER_PROFILES) for (const kind of producerKinds) {
    assert.equal(supportsRasterProfile(profile.pipeline, { kind }), true);
    assert.equal(supportsRasterProfile(profile.pipeline, { kind: kind + '-unissued' }), false);
    assert.equal(supportsRasterProfile(PIXEL_PIPELINE + '/' + unknownHash, { kind }), false);
    assert.equal(supportsRasterProfile('unissued-pixel-pipeline/' + profile.rasterCodecId, { kind }), false);
  }
});

test('new retained producer roles do not relax decoded codec or WebP transport bindings', () => {
  for (const profile of RASTER_PROFILES) {
    const decoded = { kind: 'decoded-native', codec: profile.rasterCodecId };
    assert.equal(resolveRasterProfile(profile.pipeline, decoded), profile);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded, codec: unknownHash }), undefined);
    const other = RASTER_PROFILES.find(value => value.rasterCodecId !== profile.rasterCodecId);
    assert(other);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded, codec: other.rasterCodecId }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded, decodeTransport: 'unknown' }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded, decoderBuild: profile.decoderBuild }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded, decodeTransport: 'webp-opaque-incremental-v1' }), profile.legacy ? profile : undefined);

    const bounded = { ...decoded, decodeTransport: 'webp-bounded-v1', decoderBuild: profile.decoderBuild };
    assert.equal(resolveRasterProfile(profile.pipeline, bounded), profile.decodeTransport === 'webp-bounded-v1' ? profile : undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...bounded, decoderBuild: unknownHash }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...bounded, outputBuild: profile.outputBuild }), undefined);

    const file = { ...decoded, decodeTransport: 'webp-file-v1', decoderBuild: profile.decoderBuild, outputBuild: profile.outputBuild };
    assert.equal(resolveRasterProfile(profile.pipeline, file), profile.decodeTransport === 'webp-file-v1' ? profile : undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...file, decoderBuild: unknownHash }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...file, outputBuild: unknownHash }), undefined);
    const { outputBuild, ...missingOutput } = file;
    assert.equal(resolveRasterProfile(profile.pipeline, missingOutput), undefined);
    assert.equal(supportsRasterProfile(profile.pipeline, { ...file, outputBuild: unknownHash }), false);
  }
});

test('processed exports retain exact encoder checks and unchanged PNG keeps its known foreign-encoder rule', () => {
  for (const profile of RASTER_PROFILES) {
    const other = RASTER_PROFILES.find(value => value.codecId !== profile.codecId);
    assert(other);
    const jpeg = { kind: 'frozen-image-export-v1', encoder: profile.codecId, options: { format: 'jpeg' } };
    assert.equal(resolveRasterProfile(profile.pipeline, jpeg), profile);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...jpeg, encoderTransport: 'jpeg-file-baseline-v1' }), profile);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...jpeg, encoder: unknownHash }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...jpeg, encoder: other.codecId }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...jpeg, encoderTransport: 'unknown' }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...jpeg, options: { format: 'png' }, encoderTransport: 'jpeg-file-baseline-v1' }), undefined);

    const png = { kind: 'frozen-png-export', encoder: other.codecId };
    assert.equal(resolveRasterProfile(profile.pipeline, png), profile);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...png, encoder: unknownHash }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...png, encoderTransport: 'unknown' }), undefined);
    assert.equal(supportsRasterProfile(profile.pipeline, { ...jpeg, encoder: other.codecId }), false);
  }
});

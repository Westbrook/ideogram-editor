import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { PIXEL_PIPELINE } from '../../dist/local/src/raster/core.js';
import { CODEC_ID as MAC_CODEC_ID } from '../../dist/local/server/raster/identity.js';
import { BOUNDED_WEBP as MAC_BOUNDED_WEBP } from '../../dist/local/server/raster/webp-identity.js';
import { CODEC_PROFILES } from '../../dist/local/server/raster/codec-platform.js';
import { BOUNDED_WEBP_PROFILES } from '../../dist/local/server/raster/webp-platform.js';
import { WEBP_OUTPUT_PROFILES, findWebPOutputProfile } from '../../dist/local/server/raster/webp-output-platform.js';
import { LINUX_COLOR_ARM64 } from '../../dist/local/server/raster/linux-color-arm64-identity.js';
import { LINUX_COLOR_X64 } from '../../dist/local/server/raster/linux-color-x64-identity.js';
import { RASTER_PROFILES, CURRENT_RASTER_PROFILE, PIPELINE, RASTER_CODEC_ID, findRasterProfile, findCurrentRasterProfile, resolveRasterProfile, isKnownRasterEncoder } from '../../dist/local/server/raster/profile-registry.js';

const hash = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
const unknown = 'sha256:' + 'f'.repeat(64);
const decoded = profile => ({ kind: 'decoded-native', codec: profile.rasterCodecId });
const exported = (profile, format = 'jpeg') => ({ kind: 'frozen-image-export-v1', encoder: profile.codecId, options: { format } });

test('issued profile inventory preserves all historical aggregates and binds each current output bridge', () => {
  const oldPipeline = PIXEL_PIPELINE + '/' + MAC_CODEC_ID;
  const macPipeline = PIXEL_PIPELINE + '/' + hash({ base: MAC_CODEC_ID, boundedWebP: MAC_BOUNDED_WEBP });
  assert.equal(RASTER_PROFILES.length, 7);
  assert.equal(new Set(RASTER_PROFILES.map(profile => profile.pipeline)).size, 7);
  assert.equal(findRasterProfile(oldPipeline).legacy, true);
  assert.equal(findRasterProfile(macPipeline).decodeTransport, 'webp-bounded-v1');
  assert.equal(findRasterProfile(macPipeline).current, false);
  for (const linuxColor of [LINUX_COLOR_ARM64, LINUX_COLOR_X64]) {
    const codec = CODEC_PROFILES.find(profile => profile.codecs.platform === 'linux' && profile.codecs.arch === linuxColor.arch);
    const boundedWebP = BOUNDED_WEBP_PROFILES.find(profile => profile.platform === 'linux' && profile.arch === linuxColor.arch);
    const expected = PIXEL_PIPELINE + '/' + hash({ base: codec.codecId, boundedWebP, linuxColor });
    assert.equal(findRasterProfile(expected).decodeTransport, 'webp-bounded-v1');
    assert.equal(findRasterProfile(expected).current, false);
    assert.equal(findRasterProfile(PIXEL_PIPELINE + '/' + codec.codecId), undefined, 'unissued legacy Linux profile');
    assert.equal(findRasterProfile(PIXEL_PIPELINE + '/' + hash({ base: codec.codecId, boundedWebP })), undefined, 'missing color identity');
  }
  for (const webpOutput of WEBP_OUTPUT_PROFILES) {
    const codec = CODEC_PROFILES.find(profile => profile.codecs.platform === webpOutput.platform && profile.codecs.arch === webpOutput.arch);
    const boundedWebP = BOUNDED_WEBP_PROFILES.find(profile => profile.platform === webpOutput.platform && profile.arch === webpOutput.arch);
    const linuxColor = [LINUX_COLOR_ARM64, LINUX_COLOR_X64].find(profile => profile.platform === webpOutput.platform && profile.arch === webpOutput.arch);
    const expected = PIXEL_PIPELINE + '/' + hash({ base: codec.codecId, boundedWebP, ...(linuxColor ? { linuxColor } : {}), webpOutput });
    const current = findCurrentRasterProfile(webpOutput.platform, webpOutput.arch);
    assert.equal(current.pipeline, expected);
    assert.equal(current.current, true);
    assert.equal(current.decodeTransport, 'webp-file-v1');
    assert.equal(current.decoderBuild, webpOutput.decoderHash);
    assert.equal(current.outputBuild, webpOutput.hash);
    assert.equal(webpOutput.decoderHash, boundedWebP.hash);
    assert.equal(webpOutput.converterHash, linuxColor?.hash ?? boundedWebP.hash);
    assert.equal(findWebPOutputProfile(webpOutput.platform, webpOutput.arch), webpOutput);
  }
  assert.equal(findCurrentRasterProfile('win32', 'x64'), undefined);
  assert.equal(findWebPOutputProfile('win32', 'x64'), undefined);
  assert.equal(findRasterProfile(PIXEL_PIPELINE + '/' + unknown), undefined);
  assert.equal(findRasterProfile({ pipeline: PIPELINE }), undefined);
  assert.equal(PIPELINE, CURRENT_RASTER_PROFILE.pipeline);
  assert.equal(RASTER_CODEC_ID, CURRENT_RASTER_PROFILE.rasterCodecId);
});

test('decoded profile support binds transport and decoder build to the exact retained producer', () => {
  for (const profile of RASTER_PROFILES) {
    assert.equal(resolveRasterProfile(profile.pipeline, decoded(profile)), profile);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded(profile), codec: unknown }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded(profile), decoderBuild: unknown }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded(profile), outputBuild: unknown }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded(profile), decodeTransport: 'unknown' }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...decoded(profile), decodeTransport: 'webp-opaque-incremental-v1' }), profile.legacy ? profile : undefined);
    const bounded = { ...decoded(profile), decodeTransport: 'webp-bounded-v1', decoderBuild: profile.decoderBuild };
    assert.equal(resolveRasterProfile(profile.pipeline, bounded), profile.decodeTransport === 'webp-bounded-v1' ? profile : undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...bounded, decoderBuild: unknown }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...bounded, outputBuild: profile.outputBuild }), undefined);
    for (const other of RASTER_PROFILES.filter(other => !other.legacy && other.decoderBuild !== profile.decoderBuild)) {
      assert.equal(resolveRasterProfile(profile.pipeline, { ...bounded, decoderBuild: other.decoderBuild }), undefined);
    }
  }
});

test('file transport requires its exact output bridge and cannot rewrite a retained buffered attestation', () => {
  for (const profile of RASTER_PROFILES) {
    const file = { ...decoded(profile), decodeTransport: 'webp-file-v1', decoderBuild: profile.decoderBuild, outputBuild: profile.outputBuild };
    assert.equal(resolveRasterProfile(profile.pipeline, file), profile.decodeTransport === 'webp-file-v1' ? profile : undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...file, decoderBuild: unknown }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...file, outputBuild: unknown }), undefined);
    const { outputBuild, ...missingOutput } = file;
    assert.equal(resolveRasterProfile(profile.pipeline, missingOutput), undefined);
    for (const other of RASTER_PROFILES.filter(other => other.current && other.outputBuild !== profile.outputBuild)) {
      assert.equal(resolveRasterProfile(profile.pipeline, { ...file, outputBuild: other.outputBuild }), undefined);
    }
    if (profile.decodeTransport === 'webp-bounded-v1') {
      const original = { ...decoded(profile), decodeTransport: 'webp-bounded-v1', decoderBuild: profile.decoderBuild };
      const unchanged = structuredClone(original), current = findCurrentRasterProfile(profile.platform, profile.arch);
      assert.equal(resolveRasterProfile(profile.pipeline, original), profile);
      assert.deepEqual(original, unchanged, 'retained build attestation stays byte-for-byte intact');
      assert.equal(resolveRasterProfile(current.pipeline, { ...original, codec: current.rasterCodecId }), undefined, 'current file profile cannot claim the retired buffer transport');
      assert.equal(resolveRasterProfile(profile.pipeline, { ...file, outputBuild: current.outputBuild }), undefined, 'a bridge seal does not upgrade an old aggregate');
    }
  }
});

test('processed export encoder and transport must match the retained profile', () => {
  for (const profile of RASTER_PROFILES) {
    assert.equal(resolveRasterProfile(profile.pipeline, exported(profile)), profile, 'legacy JPEG recipe remains readable');
    assert.equal(resolveRasterProfile(profile.pipeline, { ...exported(profile), encoderTransport: 'jpeg-file-baseline-v1' }), profile);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...exported(profile, 'png'), encoderTransport: 'jpeg-file-baseline-v1' }), undefined);
    assert.equal(resolveRasterProfile(profile.pipeline, { ...exported(profile), encoderTransport: 'jpeg-raw-optimized-v1' }), undefined, 'internal legacy selector is not an issued manifest marker');
    assert.equal(resolveRasterProfile(profile.pipeline, { ...exported(profile), encoder: unknown }), undefined);
    for (const other of RASTER_PROFILES.filter(other => other.codecId !== profile.codecId)) {
      assert.equal(resolveRasterProfile(profile.pipeline, { ...exported(profile), encoder: other.codecId }), undefined);
    }
  }
});

test('unchanged PNG may preserve foreign pixels but must name a known encoder', () => {
  for (const profile of RASTER_PROFILES) for (const encoder of CODEC_PROFILES) {
    assert.equal(resolveRasterProfile(profile.pipeline, { kind: 'frozen-png-export', encoder: encoder.codecId }), profile);
    assert.equal(isKnownRasterEncoder(encoder.codecId), true);
  }
  assert.equal(resolveRasterProfile(PIPELINE, { kind: 'frozen-png-export', encoder: unknown }), undefined);
  assert.equal(isKnownRasterEncoder(unknown), false);
  assert.equal(resolveRasterProfile(PIPELINE, { kind: 'unrecognized-plan' }), undefined);
  assert.equal(resolveRasterProfile(PIPELINE, null), undefined);
  assert.equal(resolveRasterProfile(PIPELINE, []), undefined);
});

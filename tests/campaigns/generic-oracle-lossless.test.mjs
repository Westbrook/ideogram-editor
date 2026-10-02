import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm, symlink, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {validatePackedGenericOracle, replayPackedGenericOracle} from '../../tooling/qualification/campaigns/generic-oracle-lossless.mjs';

// Synthetic protocol fixtures only, authored without execution. These bytes
// are not product expectations, reviewed campaign oracles or measurements.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture({duplicate = true, empty = false} = {}) {
  const raw = Buffer.from([0, 40, 80, 255, 5, 10, 15, 255]), encoded = empty ? Buffer.alloc(0) : deflateRawSync(raw);
  const pixel = {path: 'expected.bgra', bytes: raw.length, sha256: hash(raw)};
  const pixels = empty ? [] : [{...pixel, pixelStorage: {kind: 'deflate-raw', offset: 0, encodedBytes: encoded.length, encodedSha256: hash(encoded)}}];
  if (!empty && duplicate) pixels.push({...pixel, path: 'same-expected.bgra', pixelStorage: {kind: 'reference', path: pixel.path}});
  const index = {kind: 'rfc1951-oracle-pixels-1', schemaVersion: 1, oracleSha256: 'a'.repeat(64),
    reviewSha256: 'b'.repeat(64), reviewReference: 'existing-review-42', pixels};
  const options = {oracleSha256: index.oracleSha256, containerPin: {bytes: encoded.length, sha256: hash(encoded)},
    reviewPin: {bytes: 42, sha256: index.reviewSha256}, pixelIdentities: pixels.map(({path, bytes, sha256}) => ({path, bytes, sha256}))};
  return {raw, encoded, index, options};
}
function seal(value) {const indexBytes = Buffer.from(JSON.stringify(value.index)); return {...value.options, indexBytes, indexSha256: hash(indexBytes)};}
async function replay(t, value, extra = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'generic-oracle-lossless-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const containerPath = join(directory, 'oracle-pixels.bin'); await writeFile(containerPath, value.encoded, {mode: 0o600});
  return replayPackedGenericOracle({...seal(value), containerPath, ...extra});
}

test('packed index preserves exact logical raw identity and explicit external review reference', () => {
  const value = fixture(), result = validatePackedGenericOracle(seal(value));
  assert.deepEqual(result, value.index); assert.notEqual(result, value.index);
  assert.equal(result.reviewReference, 'existing-review-42');
});
test('raw oracle, index and review pins bind separately', () => {
  const value = fixture(), options = seal(value);
  for (const change of [{indexSha256: '0'.repeat(64)}, {oracleSha256: '0'.repeat(64)}, {reviewPin: {bytes: 42, sha256: '0'.repeat(64)}}])
    assert.throws(() => validatePackedGenericOracle({...options, ...change}));
});
test('packed index rejects an omitted or changed logical pixel identity', () => {
  const value = fixture(); assert.throws(() => validatePackedGenericOracle({...seal(value), pixelIdentities: value.options.pixelIdentities.slice(1)}));
  value.index.pixels[0].sha256 = 'c'.repeat(64); assert.throws(() => validatePackedGenericOracle(seal(value)));
});
test('reference must point backward to identical raw bytes', () => {
  for (const mutate of [v => {v.index.pixels[0].pixelStorage = {kind: 'reference', path: 'same-expected.bgra'};},
    v => {v.index.pixels[1].pixelStorage.path = 'missing.bgra';},
    v => {v.index.pixels[1].sha256 = v.options.pixelIdentities[1].sha256 = 'c'.repeat(64);}]) {
    const value = fixture(); mutate(value); assert.throws(() => validatePackedGenericOracle(seal(value)));
  }
});
test('container ranges must be an exact nonoverlapping contiguous partition', () => {
  for (const mutate of [v => {v.index.pixels[0].pixelStorage.offset = 1;},
    v => {v.options.containerPin.bytes++;}, v => {v.index.pixels[0].pixelStorage.encodedBytes++;}]) {
    const value = fixture(); mutate(value); assert.throws(() => validatePackedGenericOracle(seal(value)));
  }
});
test('unknown storage kinds and extra storage fields are rejected', () => {
  for (const mutate of [v => {v.index.pixels[0].pixelStorage.kind = 'gzip';}, v => {v.index.pixels[1].pixelStorage.extra = true;}]) {
    const value = fixture(); mutate(value); assert.throws(() => validatePackedGenericOracle(seal(value)));
  }
});
test('empty independent oracle inventory requires the exact empty container', async t => {
  const value = fixture({empty: true}), result = await replay(t, value);
  assert.deepEqual(result.pixelIdentities, []); assert.equal(result.qualification, false);
});
test('strict streaming replay reconstructs raw identities and resolves deduplicated files', async t => {
  const value = fixture(), result = await replay(t, value);
  assert.deepEqual(result.pixelIdentities, value.options.pixelIdentities);
  assert.equal(result.semanticReview.authorityFromFlags, false); assert.equal(result.qualification, false);
});
test('changed encoded whole-file identity cannot replay', async t => {
  const value = fixture(); value.options.containerPin.sha256 = '0'.repeat(64);
  await assert.rejects(replay(t, value), /container pin/);
});
test('truncated deflate is rejected even when new encoded pins agree', async t => {
  const value = fixture(); value.encoded = value.encoded.subarray(0, -1);
  value.options.containerPin = {bytes: value.encoded.length, sha256: hash(value.encoded)};
  Object.assign(value.index.pixels[0].pixelStorage, {encodedBytes: value.encoded.length, encodedSha256: hash(value.encoded)});
  await assert.rejects(replay(t, value));
});
test('trailing bytes inside a pinned member are rejected', async t => {
  const value = fixture(); value.encoded = Buffer.concat([value.encoded, Buffer.from([1, 2, 3])]);
  value.options.containerPin = {bytes: value.encoded.length, sha256: hash(value.encoded)};
  Object.assign(value.index.pixels[0].pixelStorage, {encodedBytes: value.encoded.length, encodedSha256: hash(value.encoded)});
  await assert.rejects(replay(t, value));
});
test('decoded output exceeding declared raw length is bounded and rejected', async t => {
  const value = fixture({duplicate: false}); value.index.pixels[0].bytes = value.options.pixelIdentities[0].bytes = 4;
  await assert.rejects(replay(t, value), /exact raw length/);
});
test('correct encoded bytes cannot authorize a different raw pixel hash', async t => {
  const value = fixture({duplicate: false}); value.index.pixels[0].sha256 = value.options.pixelIdentities[0].sha256 = 'c'.repeat(64);
  await assert.rejects(replay(t, value), /reconstructed pixels/);
});
test('cancelled replay cannot supply raw identities', async t => {
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(replay(t, fixture(), {signal: controller.signal}), /cancelled/);
});
test('packed container path cannot be a symlink', async t => {
  const value = fixture(), directory = await realpath(await mkdtemp(join(tmpdir(), 'generic-oracle-symlink-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const actual = join(directory, 'actual.bin'), link = join(directory, 'alias.bin'); await writeFile(actual, value.encoded); await symlink(actual, link);
  await assert.rejects(replayPackedGenericOracle({...seal(value), containerPath: link}), /canonical/);
});

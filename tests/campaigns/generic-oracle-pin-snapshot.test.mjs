import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {replayPackedGenericOracle} from '../../tooling/qualification/campaigns/generic-oracle-lossless.mjs';

test('async oracle replay retains originally admitted container and review pins', async t => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'oracle-pin-snapshot-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const raw = Buffer.from([0, 40, 80, 255]), encoded = deflateRawSync(raw), containerPath = join(directory, 'pixels.bin');
  await writeFile(containerPath, encoded, {mode: 0o600});
  const pixel = {path: 'synthetic.bgra', bytes: raw.length, sha256: hash(raw)};
  const containerPin = {bytes: encoded.length, sha256: hash(encoded)}, reviewPin = {bytes: 42, sha256: 'b'.repeat(64)};
  const expectedContainer = structuredClone(containerPin), expectedReview = structuredClone(reviewPin);
  const indexBytes = Buffer.from(JSON.stringify({kind: 'rfc1951-oracle-pixels-1', schemaVersion: 1, oracleSha256: 'a'.repeat(64),
    reviewSha256: reviewPin.sha256, reviewReference: 'synthetic-protocol-fixture', pixels: [{...pixel,
      pixelStorage: {kind: 'deflate-raw', offset: 0, encodedBytes: encoded.length, encodedSha256: hash(encoded)}}]}));
  const pending = replayPackedGenericOracle({containerPath, containerPin, indexBytes, indexSha256: hash(indexBytes),
    oracleSha256: 'a'.repeat(64), pixelIdentities: [pixel], reviewPin});
  containerPin.bytes++; containerPin.sha256 = '0'.repeat(64); reviewPin.bytes++; reviewPin.sha256 = 'c'.repeat(64);
  const result = await pending;
  assert.deepEqual(result.container, expectedContainer);
  assert.equal(result.semanticReview.sha256, expectedReview.sha256); assert.equal(result.semanticReview.bytes, expectedReview.bytes);
  assert.deepEqual(result.pixelIdentities, [pixel]); assert.equal(result.qualification, false);
});

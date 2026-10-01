import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { pacingDeadline, pacedChunks, startControlledNetwork } from '../../tooling/qualification/campaigns/controlled-network.mjs';

test('N byte deadlines use decimal Mbps and retain each real bounded release', async () => {
  assert.equal(pacingDeadline(10, 2500000, 20), 1010); assert.equal(pacingDeadline(10, 12500000, 100), 1010);
  assert.throws(() => pacingDeadline(0, -1, 20)); assert.throws(() => pacingDeadline(0, 1, 0));
  const observations = [], original = Buffer.alloc(65537, 17), chunks = [];
  for await (const chunk of pacedChunks([original], { mbps: 100, observations })) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), original); assert.deepEqual(observations.map(value => value.chunkBytes), [65536, 1]);
  assert.deepEqual(observations.map(value => value.cumulativeBytes), [65536, 65537]); assert(observations.every(value => Number.isFinite(value.deadlineMs) && Number.isFinite(value.releasedMs)));
});

async function transfer(url, method, length, chunks) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: length === undefined ? {} : { 'content-length': length } }, response => {
      const body = []; response.on('data', bytes => body.push(bytes)); response.once('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(body) })); response.once('error', reject);
    });
    req.once('error', reject);
    void (async () => { for await (const chunk of chunks ?? []) await new Promise((done, failed) => req.write(chunk, error => error ? failed(error) : done())); req.end(); })().catch(error => { req.destroy(error); reject(error); });
  });
}

test('controlled loopback moves exact bytes, retains a durable upload, gives fresh URLs and never claims physical RTT qualification', async t => {
  const output = await mkdtemp(join(tmpdir(), 'wa-network-unit-')); t.after(() => rm(output, { recursive: true, force: true }));
  const bytes = Buffer.alloc(131073, 91), path = join(output, 'source.bin'), hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex'); await writeFile(path, bytes);
  const network = await startControlledNetwork({ output, downloadFile: path, downloadBytes: bytes.length, downloadHash: hash }); t.after(() => network.close());
  assert.equal(network.policy.physicalRTTQualified, false); assert.equal(network.policy.physicalPacketLossQualified, false);
  const downloaded = await transfer(network.downloadURL, 'GET'); assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.bytes, bytes);
  const secondURL = await network.addDownload(path, bytes.length, hash); assert.notEqual(secondURL, network.downloadURL);
  network.expectUpload({ bytes: bytes.length, hash }); const pacing = [];
  const uploaded = await transfer(network.uploadURL, 'POST', bytes.length, network.uploadChunks(createReadStream(path, { highWaterMark: 65536 }), pacing));
  assert.equal(uploaded.status, 200); const ready = JSON.parse(uploaded.bytes.toString('utf8')); assert.equal(new URL(ready.url).origin, network.origin);
  const received = network.effects.find(value => value.method === 'POST'); assert.equal(received.bytes, bytes.length); assert.equal(received.hash, hash.slice(7)); assert.deepEqual(await readFile(received.file), bytes);
  assert.deepEqual((await transfer(ready.url, 'GET')).bytes, bytes); assert(pacing.length > 1); assert.deepEqual(network.errors, []);
  const closed = await network.close(); assert.equal(closed.incompleteExpectedUploads, 0); assert.equal(closed.retained, true);
});

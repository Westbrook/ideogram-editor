import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ADAPTER_NORMAL_BYTES, ADAPTER_STRESS_BYTES, adapterFixtureHeader, adapterFixtureDigest, writeAdapterFixture, hashAdapterFile, prepareAdapterFixtures, createAdapterCampaign } from '../../tooling/qualification/campaigns/adapters.mjs';

async function directory(t) { const root = await mkdtemp(join(tmpdir(), 'wa-fixture-unit-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('WA generator writes deterministic complete bytes through bounded chunks and an exact safe header', async t => {
  const root = await directory(t), bytes = 2 * 1048576 + 73;
  const first = await writeAdapterFixture(join(root, 'one.safetensors'), bytes), second = await writeAdapterFixture(join(root, 'two.safetensors'), bytes);
  assert.equal(first.hash, second.hash); assert.equal(first.bytes, bytes); assert.equal(first.locallyEligible, false);
  assert.equal(first.hash, adapterFixtureDigest(bytes));
  const actual = await hashAdapterFile(first.path); assert.equal(actual.hash, first.hash); assert.equal(actual.bytes, bytes); assert.equal(actual.maxChunk, 1048576); assert.equal(actual.chunks, 3);
  const content = await readFile(first.path), headerBytes = Number(content.readBigUInt64LE()); assert.equal(headerBytes, 1024);
  const header = JSON.parse(content.subarray(8, 8 + headerBytes).toString('utf8'));
  assert.deepEqual(header.weights, { dtype: 'U8', shape: [bytes - 1032], data_offsets: [0, bytes - 1032] });
  assert.equal(header.__metadata__.compatibility, 'structural-only');
  assert.equal(content[1032], 19); assert.equal(content[1033], 92); assert.equal(content[1032 + 1048576], 19);
  assert.equal(first.hash, 'sha256:' + createHash('sha256').update(content).digest('hex'));
  const { inspectSafetensorsHeader } = await import('../../dist/local/src/adapters/structure.js');
  const inspected = inspectSafetensorsHeader(content.subarray(8, 8 + headerBytes), bytes);
  assert.equal(inspected.tensorCount, 1); assert.equal(inspected.dataBytes, bytes - 1032); assert.deepEqual(inspected.dtypes, ['U8']);
});

test('WA fixtures have exact declared full weights sizes including prefix and header', () => {
  for (const bytes of [ADAPTER_NORMAL_BYTES, ADAPTER_STRESS_BYTES]) {
    const header = adapterFixtureHeader(bytes), parsed = JSON.parse(header.subarray(8).toString('utf8'));
    assert.equal(header.length + parsed.weights.data_offsets[1], bytes);
  }
  for (const bytes of [0, 1024, 1032, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => adapterFixtureHeader(bytes));
});

test('WA generation cannot silently substitute a small unit payload or overwrite retained fixture bytes', async t => {
  const root = await directory(t), path = join(root, 'retained.safetensors'); await writeFile(path, 'retained-first-failure');
  await assert.rejects(writeAdapterFixture(path, 4096), { code: 'EEXIST' }); assert.equal(await readFile(path, 'utf8'), 'retained-first-failure');
  await assert.rejects(prepareAdapterFixtures(join(root, 'small'), { sizes: [4096] }), /exactly 256 MiB or 1 GiB/);
  await assert.rejects(prepareAdapterFixtures(join(root, 'duplicate'), { sizes: [ADAPTER_NORMAL_BYTES, ADAPTER_NORMAL_BYTES] }), /exactly/);
});

test('aborted generation retains incomplete evidence and refuses pretending it is complete', async t => {
  const root = await directory(t), controller = new AbortController(); controller.abort(Error('Stop requested'));
  const path = join(root, 'partial.safetensors'); await assert.rejects(writeAdapterFixture(path, 4096, { signal: controller.signal }), /Stop requested/);
  assert.equal((await readFile(path)).length, 1032); await assert.rejects(writeAdapterFixture(path, 4096), { code: 'EEXIST' });
});

test('unsupported cells are refused before fixture generation or writer startup', async t => {
  const root = await directory(t), campaign = await createAdapterCampaign({ repo: resolve('.'), output: root });
  await assert.rejects(campaign.prepareCell({ operation: 'training.package' }), /Unsupported adapter operation/);
  await campaign.close();
});

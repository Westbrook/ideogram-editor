import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../tooling/qualification/campaigns/common.mjs';
import { verifyAdapterLifecycleResourceEvidence } from '../../tooling/qualification/campaigns/verification.mjs';

const cell = { handler: 'adapters', host: 'C', kind: 'lifecycle', workload: 'WA', operation: 'adapter.lifecycle' };

test('adapter resource replay applies only to the canonical C WA lifecycle', async () => {
  for (const change of [{ handler: 'browser' }, { host: 'H' }, { kind: 'operation' }, { workload: 'W1' }, { operation: 'adapter.import' }]) {
    const result = await verifyAdapterLifecycleResourceEvidence({ cell: { ...cell, ...change }, result: { sampling: { complete: true } },
      readRetained: () => { throw Error('An unrelated cell must not read an adapter resource stream'); } });
    assert.deepEqual(result, { applicable: false });
  }
});

test('legacy incomplete adapter observations retain an explicit absent artifact result', async () => {
  const result = await verifyAdapterLifecycleResourceEvidence({ cell, result: { status: 'INCONCLUSIVE', sampling: { complete: false } },
    readRetained: () => { throw Error('No unsealed path should be read'); } });
  assert.equal(result.applicable, true);
  assert.equal(result.complete, false);
  assert(result.missing.includes('adapter-resource-sealed-artifact-unavailable'));
});

test('complete adapter sampling requires a usable sealed raw artifact identity', async () => {
  for (const artifact of [undefined, { path: '/original/wa.jsonl', bytes: 1, sha256: null },
    { path: '/original/wa.jsonl', bytes: 0, sha256: digest('') }]) {
    await assert.rejects(verifyAdapterLifecycleResourceEvidence({ cell, result: { sampling: { complete: true, artifact } },
      readRetained: () => { throw Error('No malformed artifact should be read'); } }), /lacks a sealed raw artifact/);
  }
});

test('adapter verification reads retained packet bytes once and rejects a changed stream', async () => {
  let reads = 0;
  const path = '/original/group/wa.jsonl', original = Buffer.from('{}\n');
  await assert.rejects(verifyAdapterLifecycleResourceEvidence({ cell,
    result: { status: 'FAIL', processIdentity: 'owned-process', cycles: [], sampling: {
      kind: 'attributed-backend-process-and-allocation-ledger', complete: false, processIdentity: 'owned-process',
      sha256: digest(original), artifact: { path, bytes: original.length, sha256: digest(original) },
    } }, readRetained: retainedPath => {
      assert.equal(retainedPath, path); reads++;
      return Buffer.from('{} \n');
    } }), /contradicts its receipt.*artifact identity/);
  assert.equal(reads, 1);
});

test('adapter raw replay binds to the lifecycle process even when the stream has a valid hash', async () => {
  const bytes = Buffer.from('{}\n'), sha256 = digest(bytes);
  await assert.rejects(verifyAdapterLifecycleResourceEvidence({ cell,
    result: { status: 'FAIL', processIdentity: 'actual-lifecycle', cycles: [], sampling: {
      kind: 'attributed-backend-process-and-allocation-ledger', complete: false, processIdentity: 'another-lifecycle', sha256,
      artifact: { path: '/original/group/wa.jsonl', bytes: bytes.length, sha256 },
    } }, readRetained: () => bytes }), /contradicts its receipt.*different lifecycle process/);
});

test('adapter verification propagates a sealed reader failure without reopening the original file', async () => {
  const bytes = Buffer.from('{}\n'), sha256 = digest(bytes);
  await assert.rejects(verifyAdapterLifecycleResourceEvidence({ cell,
    result: { sampling: { complete: false, sha256, artifact: { path: '/original/absent.jsonl', bytes: bytes.length, sha256 } } },
    readRetained: () => { throw Error('Retained packet membership failed'); } }), /Retained packet membership failed/);
});

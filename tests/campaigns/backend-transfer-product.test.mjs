// Opt-in actual local transport smoke; this is not a shaped-network qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBackendAdapter } from '../../tooling/qualification/campaigns/backend.mjs';
import { egressAttempts } from '../provider/no-egress.mjs';

const enabled = process.env.IE_CAMPAIGN_PRODUCT_INTEGRATION === '1';
async function fixture(output) {
  const path = join(output, 'transfer-8MiB.bin'), file = await open(path, 'wx', 0o600), digest = createHash('sha256');
  const chunk = Buffer.alloc(65536); let state = 813791;
  try {
    for (let at = 0; at < 8388608; at += chunk.length) {
      for (let i = 0; i < chunk.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; chunk[i] = state & 255; }
      digest.update(chunk); await file.writeFile(chunk);
    }
    await file.sync();
  } finally { await file.close(); }
  return { corpus: { files: [{ id: 'transfer-8MiB', role: 'transfer-payload', path, byteLength: '8388608', sha256: 'sha256:' + digest.digest('hex') }] } };
}

for (const direction of ['upload', 'download']) {
  test('Actual 8MiB ' + direction + ' uses fresh transfer identities while retaining the warm product store', { skip: !enabled }, async t => {
    const output = resolve('artifacts/campaign-transfer-smoke', randomUUID()); await mkdir(output, { recursive: true, mode: 0o700 });
    const adapter = createBackendAdapter({ repo: process.cwd(), output, fixture: await fixture(output) }); t.after(() => adapter.close());
    const cell = { id: 'smoke/' + direction, operation: 'transfer.asset', workload: 'W1', parameters: { direction, bytes: 8388608 } };
    await adapter.prepareCell(cell); const outcomes = [];
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      const sample = { cache: 'warm', prime: ordinal === 0, ordinal };
      const reset = await adapter.resetCell(cell, sample); assert.equal(reset.status, 'pass');
      const outcome = await adapter.execute(cell, sample); outcomes.push(outcome);
      assert.equal(outcome.status, 'inconclusive', 'Application pacing does not prove physical N shaping');
      assert(outcome.assertions.every(item => item.passed)); assert.equal(outcome.observations.effects.length, 1);
      assert.equal(outcome.observations.effects[0].bytes, 8388608); assert.equal(outcome.observations.retainedStore, true);
      assert.equal(outcome.measurements.R28ActualByteOrDurabilityMismatchCount.unit, 'violations');
      assert.equal(outcome.measurements.R28ActualByteOrDurabilityMismatchCount.value, 0);
      assert(outcome.phases.some(span => span.name === 'asset.transfer-durable' && span.outcome === 'completed'));
    }
    assert.equal(outcomes[0].observations.root, outcomes[1].observations.root);
    assert.equal(outcomes[0].observations.storeEpoch, outcomes[1].observations.storeEpoch);
    assert.equal(outcomes[0].observations.connectionEndpoint, outcomes[1].observations.connectionEndpoint);
    assert.notEqual(outcomes[0].observations.transferKey, outcomes[1].observations.transferKey);
    assert.deepEqual(egressAttempts(), []);
  });
}

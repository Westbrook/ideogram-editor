// Product integration gate, not a performance or full-workload qualification.
// Run only after the selected server build, with tests/provider/no-egress.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createBackendAdapter } from '../../tooling/qualification/campaigns/backend.mjs';
import { egressAttempts } from '../provider/no-egress.mjs';
import { fastManifest } from '../../tooling/qualification/campaigns/backend-queue.mjs';

async function smokeFastFixture(output) {
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 17, g: 83, b: 141, alpha: 1 } } }).png().toBuffer();
  const path = join(output, 'wf-512-png-0.png'); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const corpus = { files: [{ id: 'wf-512-png-0', role: 'fast-candidate', width: 512, height: 512, format: 'png', index: 0, path, byteLength: String(bytes.length), sha256: hash(bytes) }], fast: { validFamilies: fastManifest } };
  const manifest = Buffer.from(JSON.stringify({ kind: 'focused-WF01-product-smoke-input', corpus }));
  const manifestPath = join(output, 'fixture.json'); await writeFile(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
  return { corpus, seal: { path: manifestPath, sha256: hash(manifest) } };
}

async function execute(t, cell) {
  const output = resolve('artifacts/campaign-product-smoke', randomUUID()); await mkdir(output, { recursive: true, mode: 0o700 });
  const fixture = cell.parameters.caseId === 'WF01' ? await smokeFastFixture(output) : undefined;
  const adapter = createBackendAdapter({ repo: process.cwd(), output, fixture });
  t.after(() => adapter.close());
  await adapter.prepareCell(cell); await adapter.resetCell(cell, { cache: 'cold', ordinal: 1, prime: false });
  const outcome = await adapter.execute(cell, { cache: 'cold', ordinal: 1, prime: false });
  assert.notEqual(outcome.status, 'fail'); assert.deepEqual(egressAttempts(), []);
  return outcome;
}

test('Fast campaign creates a real immutable job and one loopback POST in the retained writer', async t => {
  const outcome = await execute(t, { id: 'smoke/WF01', operation: 'fast.workflow', workload: 'WF', parameters: { caseId: 'WF01' } });
  assert.equal(outcome.observations.retainedWriter, true); assert.equal(outcome.observations.outcome.state, 'acknowledged');
  assert.equal(outcome.observations.effects.filter(effect => effect.method === 'POST').length, 1);
  assert.equal(outcome.measurements.R42BatchOutputs.value, 1);
  assert.equal(outcome.measurements.R42BatchOutputs.unit, 'count');
  assert(outcome.measurements.R42BatchOutputs.evidence.length > 0);
  for (const name of ['R20PrematureDurableAcknowledgements', 'R24FrozenCommandOrQueueReceiptViolations', 'R42RouteOrDroppedFieldOrUnexpectedRetryCount', 'R29UnexpectedResubmissionCount']) {
    assert.equal(outcome.measurements[name].unit, 'violations', name);
    assert.equal(outcome.measurements[name].value, 0, name);
    assert(outcome.measurements[name].evidence.length > 0, name);
  }
  assert(outcome.phases.some(span => span.name === 'job.submit.eligible-dispatch' && span.durationMs >= 0));
});

for (const scenario of ['lost-ack', 'duplicate-status', 'out-of-order-status', 'browser-restart']) {
  test('Actual WQ fixture handlers preserve ' + scenario + ' without replacement submit', async t => {
    const outcome = await execute(t, { id: 'smoke/' + scenario, operation: 'queue.fault', workload: 'WQ', parameters: { scenario } });
    assert.equal(outcome.status, 'inconclusive', 'A focused small fixture is not the full WQ workload');
    assert.equal(outcome.observations.effects.filter(effect => effect.method === 'POST').length, 1);
    assert.equal(outcome.observations.retainedWriter, true);
    if (scenario === 'lost-ack') assert.equal(outcome.observations.outcome.state, 'submission-uncertain');
    else assert.equal(outcome.observations.outcome.state, 'acknowledged');
  });
}

for (const caseId of ['WF07', 'WF08', 'WF09', 'WF10', 'WF11', 'WF12']) {
  test(caseId + ' rejects its independent Fast field and preserves a real saved draft', async t => {
    const outcome = await execute(t, { id: 'smoke/' + caseId, operation: 'fast.workflow', workload: 'WF', parameters: { caseId } });
    assert.equal(outcome.status, 'pass'); assert(outcome.observations.rejection.length > 0);
    assert(outcome.phases.some(span => span.name === 'command.validate'));
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { runLifecycle } from '../../tooling/qualification/campaigns/worker.mjs';
import { evaluateRequiredMeasurements } from '../../tooling/qualification/campaigns/run.mjs';
import { makeCampaignPlan } from '../../tooling/qualification/campaigns/inventory.mjs';

// Service-free controller tests. These instantaneous idle doubles are never
// passed off as actual 30-second resource lifecycle observations.
function context(events) {
  return { fixture: { manifestHash: 'sha256:' + 'a'.repeat(64) },
    wait: async requestedMs => { events.push('idle'); return { requestedMs, startMs: performance.now(), endMs: performance.now() }; },
    trace: async () => {} };
}
function adapter(events, fail = false) {
  let ordinal = 0;
  return { lifecycleIdentity: async () => 'process', measureResources: async () => { events.push('resources'); return { ordinal: ++ordinal }; },
    beginResourceWindow: async ({ cycleOrdinal }) => { events.push('begin:' + cycleOrdinal); return { cycleOrdinal }; },
    endResourceWindow: async handle => { events.push('end:' + handle.cycleOrdinal); return { cycleOrdinal: handle.cycleOrdinal, samples: [{ ordinal: ++ordinal }] }; },
    lifecycleCycle: async (_, { cycle }) => { events.push('action:' + cycle); if (fail) throw Object.assign(Error('actual failed action'), { lifecycleCounterEvidence: { artifact: { path: '/owned/failed-cycle.json', bytes: 12, sha256: 'sha256:' + 'b'.repeat(64) } } }); return { status: 'PASS', phases: [] }; },
    resourceSamplingEvidence: async () => ({ complete: false, kind: 'unit-test-double' }) };
}

test('worker brackets real action and post-idle observation with the same resource window', async () => {
  const events = [], result = await runLifecycle({ workload: 'WA', jobId: 'AC2', parameters: { cycles: 2 } }, adapter(events), context(events));
  assert.deepEqual(events, ['idle', 'resources', 'begin:1', 'action:1', 'idle', 'resources', 'end:1', 'begin:2', 'action:2', 'idle', 'resources', 'end:2']);
  assert.equal(result.cycles.length, 2);
  for (const cycle of result.cycles) assert.deepEqual(cycle.resourceSamples, cycle.resourceWindow.samples);
});

test('failed action retains its partial resource window and actual counter artifact', async () => {
  const events = [], result = await runLifecycle({ workload: 'WA', jobId: 'AC2', parameters: { cycles: 2 } }, adapter(events, true), context(events));
  assert.equal(result.status, 'FAIL'); assert.equal(result.cycles.length, 1);
  assert.deepEqual(events, ['idle', 'resources', 'begin:1', 'action:1', 'end:1']);
  assert.equal(result.cycles[0].failedActionEvidence.artifact.path, '/owned/failed-cycle.json');
  assert.deepEqual(result.cycles[0].resourceSamples, result.cycles[0].resourceWindow.samples);
});

test('lifecycle registry ignores unobserved scalar aliases and retains proven lower-bound breaches', () => {
  const cell = makeCampaignPlan({ campaign: 'P', features: 'core' }).cells.find(value => value.operation === 'lifecycle.editor' && value.workload === 'W1');
  const rule = cell.requiredMeasurements.find(value => value.name === 'R18CpuAllocationBytes'); assert(rule);
  const sample = { processIdentity: 'same', ordinal: 1, observation: { startMs: 1, endMs: 2 }, cpuBytes: rule.ceiling + 1 };
  const raw = { kind: 'lifecycle-observation-1', workload: 'W1', profile: 'P-M', processIdentity: 'same', fixtureIdentity: 'fixed', B0: { observation: { startMs: 1, endMs: 2 }, resources: sample }, endMs: 3, cycles: [], sampling: { processIdentity: 'same', counts: { samples: 1 }, complete: false, peakSamples: { cpuBytes: sample }, peaks: { cpuBytes: sample.cpuBytes } },
    measurements: [{ name: rule.name, value: 0, unit: 'bytes', method: 'unbound scalar', evidence: {} }] };
  const observed = () => evaluateRequiredMeasurements(cell, [{ id: 'actual/scored/1', prime: false, cache: 'single', result: raw }]).find(value => value.name === rule.name);
  assert.equal(observed().status, 'FAIL'); assert.equal(observed().observations[0].lowerBound, true);
  // Even a ceiling breach needs an observed scored interval. Preparation and
  // after-end observations cannot become scored failures by scalar alias.
  for (const bounds of [null, { startMs: 3, endMs: 4 }]) {
    raw.B0.observation = bounds;
    assert.equal(observed().status, 'INCONCLUSIVE'); assert.equal(observed().observations[0].valid, null);
  }
  raw.B0.observation = { startMs: 1, endMs: 2 };
  raw.endMs = 1;
  assert.equal(observed().status, 'INCONCLUSIVE'); assert.equal(observed().observations[0].valid, null);
  raw.endMs = 3;
  assert.equal(observed().status, 'FAIL'); assert.equal(observed().observations[0].lowerBound, true);
  raw.B0.resources.cpuBytes = 0;
  assert.equal(observed().status, 'INCONCLUSIVE'); assert.equal(observed().observations[0].valid, null);
});

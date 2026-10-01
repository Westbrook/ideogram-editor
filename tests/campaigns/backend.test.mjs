import test from 'node:test';
import assert from 'node:assert/strict';
import { routeCell, supportedOperations } from '../../tooling/qualification/campaigns/backend.mjs';
import { identifyQueueCase, fastManifest, delay } from '../../tooling/qualification/campaigns/backend-queue.mjs';
import { identifyTransfer } from '../../tooling/qualification/campaigns/backend-transfer.mjs';
import { envelope, expectedVersions, phase } from '../../tooling/qualification/campaigns/backend-common.mjs';
import { normalizeBackendMeasurements } from '../../tooling/qualification/campaigns/backend-measurements.mjs';

test('backend dispatch covers the closed supported operation set without fallback success', () => {
  for (const operation of supportedOperations) {
    const parameters = operation === 'caption.raw-ingest' ? { bytes: 16777216 } : {};
    assert.match(routeCell({ operation, parameters }).module, /^\.\/backend-[a-z-]+\.mjs$/);
  }
  assert.throws(() => routeCell({ operation: 'unimplemented.request' }), { code: 'CELL_UNSUPPORTED' });
  assert.equal(routeCell({ operation: 'caption.raw-ingest', parameters: { bytes: 16777217 } }).cell.parameters.caseId, 'RAW16M_PLUS1');
  assert.throws(() => routeCell({ operation: 'caption.raw-ingest', parameters: { bytes: 1024 } }));
});

test('all nine inventory WQ names select one actual scenario and unknown names reject', () => {
  const names = ['lost-ack', 'duplicate-status', 'out-of-order-status', 'cancel-late-result', 'expiry', 'browser-restart', 'backend-restart', 'offline-completion', 'disk-full-admission'];
  const decoded = names.map(scenario => identifyQueueCase({ operation: 'queue.fault', parameters: { scenario } }));
  assert.equal(new Set(decoded.map(value => value.scenario)).size, 9);
  assert.equal(decoded[0].scenario, 'lost-acknowledgement'); assert.equal(decoded[4].scenario, 'expired-result-url');
  assert.throws(() => identifyQueueCase({ operation: 'queue.fault', parameters: { scenario: 'pretend-success' } }));
});

test('six Fast routes are a fixed manifest with all promised sizes, formats, speeds and counts', () => {
  assert.equal(fastManifest.length, 6);
  assert.deepEqual([...new Set(fastManifest.map(value => value.width))].sort((a, b) => a - b), [512, 1024, 2048]);
  assert.deepEqual([...new Set(fastManifest.map(value => value.count))].sort(), [1, 4]);
  assert.deepEqual([...new Set(fastManifest.map(value => value.format))].sort(), ['jpeg', 'png']);
  for (let index = 1; index <= 16; index++) assert(identifyQueueCase({ operation: 'fast.workflow', parameters: { caseId: 'WF' + String(index).padStart(2, '0') } }));
  assert.throws(() => identifyQueueCase({ operation: 'fast.workflow', parameters: { caseId: 'WF17' } }));
});

test('I7N admits all four exact byte-moving cells and refuses substitute sizes', () => {
  for (const direction of ['upload', 'download']) for (const bytes of [8388608, 33554432]) assert.deepEqual(identifyTransfer({ operation: 'transfer.asset', parameters: { direction, bytes } }), { direction, bytes });
  assert.throws(() => identifyTransfer({ operation: 'transfer.asset', parameters: { direction: 'download', bytes: 0 } }));
  assert.throws(() => identifyTransfer({ operation: 'transfer.asset', parameters: { direction: 'cache-hit', bytes: 8388608 } }));
});

test('real monotonic span preserves failures instead of success-shaped timing', async () => {
  const phases = []; const error = Object.assign(Error('owned operation rejected'), { code: 'REJECTED' });
  await assert.rejects(phase(phases, 'actual-operation', async () => { throw error; }), error);
  assert.equal(phases[0].outcome, 'failed'); assert.equal(phases[0].error.code, 'REJECTED');
  assert(phases[0].startMs <= phases[0].endMs); assert.equal(phases[0].durationMs, phases[0].endMs - phases[0].startMs);
});

test('real wait obeys cancellation, and command identity has correct frozen dependency', async () => {
  const controller = new AbortController(); controller.abort(Error('stop')); await assert.rejects(delay(10000, controller.signal), /stop/);
  const first = envelope({ type: 'CancelUnstartedJob' }), second = envelope({ type: 'CancelUnstartedJob' });
  assert.notEqual(first.command.commandId, second.command.commandId);
  assert.equal(expectedVersions.hash, 'sha256:10584db4c85cf1d5cbd2eda3429934a693b7c26268e63be96dbdb23d6dd42069');
});

test('backend measurement normalization requires actual producer method and retained evidence', () => {
  const cell = { requiredMeasurements: [{ name: 'R25PendingEntries', unit: 'count' }] };
  const missingProof = { measurements: { R25PendingEntries: 100 } };
  normalizeBackendMeasurements(cell, missingProof);
  assert.equal(missingProof.measurements.R25PendingEntries, 100, 'A bare value stays unqualified rather than receiving invented evidence');
  const evidence = [{ kind: 'queue-inventory', pendingEntries: 100, jobs: 1000, pages: 50 }];
  const observed = { measurements: { R25PendingEntries: 100 }, measurementDetails: { R25PendingEntries: { method: 'Complete public queue pages with the pending-admission predicate', evidence } } };
  normalizeBackendMeasurements(cell, observed);
  assert.deepEqual(observed.measurements.R25PendingEntries, { name: 'R25PendingEntries', value: 100, unit: 'count', method: observed.measurementDetails.R25PendingEntries.method, evidence });
});

test('paired proxy overhead retains its real interval proof without inventing a duration phase', () => {
  const pair = { direct: { startMs: 10, endMs: 12, durationMs: 2 }, proxy: { startMs: 15, endMs: 18, durationMs: 3 } };
  const output = { phases: [], measurements: { R26ProxyAddedHopMs: 1 }, measurementDetails: { R26ProxyAddedHopMs: { method: 'Same-worker sequential proxy minus direct duration', evidence: [{ kind: 'same-worker-proxy-pair', pair }] } } };
  normalizeBackendMeasurements({}, output);
  assert.equal(output.measurements.R26ProxyAddedHopMs.value, 1); assert.equal(output.measurements.R26ProxyAddedHopMs.unit, 'ms'); assert.deepEqual(output.phases, []);
});

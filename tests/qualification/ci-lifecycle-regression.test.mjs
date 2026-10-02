import test from 'node:test';
import assert from 'node:assert/strict';
import {collectCellRows, compareCellRows} from '../../tooling/qualification/ci/regression.mjs';
import {deriveLifecycleMeasurements} from '../../tooling/qualification/campaigns/metrics.mjs';

const cpuRule = {name: 'R18CpuAllocationBytes', budgetId: 'R18', unit: 'bytes', target: 256 * 1024 ** 2, ceiling: 512 * 1024 ** 2};
const scopes = [
  {profile: 'P-M', side: 'H', job: 'H2'}, {profile: 'M', side: 'H', job: 'I5a'},
  {profile: 'P-A', side: 'H', job: 'AH2'}, {profile: 'Q3-A', side: 'H', job: 'I8H'},
  {profile: 'P-A', side: 'C', job: 'AC2'}, {profile: 'Q3-A', side: 'C', job: 'I8C'},
];

// These are in-memory arithmetic fixtures. Campaign verification separately
// authenticates retained artifacts, protocol actions and the complete plan.
function scenario(scope = scopes[0], cpuBytes = 100) {
  const adapter = scope.profile.endsWith('-A'), cycles = scope.profile === 'M' ? 100 : 2;
  const workload = adapter ? 'WA' : 'W1', processIdentity = 'fixture-process', fixtureIdentity = 'fixture-document';
  const cell = {id: `${scope.job}/${workload}-lifecycle`, kind: 'lifecycle', host: scope.side,
    handler: scope.side === 'C' ? 'adapters' : 'browser', operation: adapter ? 'adapter.lifecycle' : 'lifecycle.editor', workload,
    primes: 0, parameters: {cycles, idleMs: 30000, baselineIdleMs: 30000, ...(adapter ? {bytes: 256 * 1024 ** 2, configBytesMax: 1024 ** 2} : {})},
    requiredMeasurements: [cpuRule], phaseBudgets: []};
  let ordinal = 0;
  function resources(startMs, endMs) {
    const common = {ordinal: ++ordinal, processIdentity, observation: {startMs, endMs}, backendRssBytes: 100, cpuBytes, unusedHandles: 0};
    if (scope.side === 'H') return {...common, browserRssBytes: 100, gpuBytes: 100, previewCacheBytes: 10, settledBytes: 100, textureSide: 1024, deviceTextureLimit: 4096};
    return {...common, resourceScope: 'wa-backend-process-workers-allocations-1', browserRssBytes: null, gpuBytes: null,
      previewCacheBytes: null, settledBytes: null, textureSide: null, deviceTextureLimit: null,
      backendOwnership: {kind: 'wa-backend-owner-evidence-1', processIdentity,
        coverage: Object.fromEntries(['processTree', 'workerThreads', 'stagingBuffers', 'hashBuffers', 'headerBuffers', 'configBuffers', 'ioCopies', 'metadataConsumers', 'assetReadHandles', 'proofHandles', 'streamHandles'].map(key => [key, true])),
        evidence: {path: 'owner.json', bytes: 100, sha256: 'a'.repeat(64)}}};
  }
  const raw = {kind: 'lifecycle-observation-1', profile: scope.profile, workload, processIdentity, fixtureIdentity,
    startMs: 0, endMs: 30002 + cycles * 90000, forcedGC: false, processRestarted: false,
    B0: {idle: {requestedMs: 30000, startMs: 0, endMs: 30000}, observation: {startMs: 30000, endMs: 30001}, resources: resources(30000, 30001)},
    cycles: Array.from({length: cycles}, (_, index) => {
      const startMs = 30001 + index * 90000, endMs = startMs + 90000;
      return {ordinal: index + 1, processIdentity, fixtureIdentity, startMs, endMs,
        idle: {requestedMs: 30000, startMs: endMs - 30001, endMs: endMs - 1}, observation: {startMs: endMs - 1, endMs},
        resourceSamples: [resources(startMs, startMs + 1)], resources: resources(endMs - 1, endMs)};
    })};
  const samples = [raw.B0.resources, ...raw.cycles.flatMap(cycle => [...cycle.resourceSamples, cycle.resources])];
  raw.sampling = {complete: true, kind: scope.side === 'C' ? 'attributed-backend-process-and-allocation-ledger' : 'attributed-process-tree-and-allocation-ledger',
    processIdentity, sha256: 'b'.repeat(64), artifact: {path: 'resource-samples.json', bytes: 4096, sha256: 'b'.repeat(64)},
    counts: {samples: samples.length}, peaks: {cpuBytes}, peakSamples: {cpuBytes: structuredClone(samples[0])}};
  if (scope.side === 'C') {
    const windowId = 'fixture-B0-allocation-window', windowScope = 'independent-B0-lifecycle-window';
    raw.sampling.observationWindow = {id: windowId, scope: windowScope, processIdentity,
      startObservation: {...raw.B0.observation}, endObservation: {startMs: raw.cycles.at(-1).endMs, endMs: raw.endMs}};
    raw.sampling.allocationPeaks = {cpuBytes: {kind: 'owned-allocation-continuous-peak-1', scope: windowScope, value: cpuBytes, processIdentity,
      sharedIdentity: 'fixture-shared-counter', sequence: 1, sourceOrdinal: samples.length, observation: {...raw.sampling.observationWindow.endObservation}, windowId,
      window: {startMonotonicNs: '30000000000', endMonotonicNs: String(raw.endMs * 1e6), sealed: true, integrityComplete: true},
      artifact: structuredClone(raw.sampling.artifact), complete: true}};
  }
  return {cell, raw};
}
function collect({cell, raw}, {direct = false, claimed = 0} = {}) {
  const measurements = [{name: cpuRule.name, value: claimed, unit: 'bytes', method: 'Untrusted top-level alias', evidence: true}];
  const result = direct ? {...raw, status: 'PASS', measurements} : {status: 'PASS', lifecycle: raw, measurements};
  return collectCellRows(cell, 'single', [{id: `${cell.id}/single/scored/1`, cache: 'single', ordinal: 1, prime: false, status: 'PASS', result}], 'Q3');
}

test('paired backend WA rows use their sealed lifecycle allocation maxima instead of top-level aliases', () => {
  for (const scope of scopes.filter(scope => scope.side === 'C')) {
    const base = collect(scenario(scope, 100)), candidate = collect(scenario(scope, 106), {direct: true, claimed: 0});
    assert.equal(base.rows[0].complete, true, scope.job); assert.equal(candidate.rows[0].complete, true, scope.job);
    const compared = compareCellRows(base.rows, candidate.rows)[0];
    assert.equal(compared.base, 100, scope.job); assert.equal(compared.candidate, 106, scope.job);
    assert.equal(compared.kind, 'peak-memory'); assert.equal(compared.outcome, 'BLOCKED');
  }
});

test('sampled browser M and WA allocations remain lower bounds without reviewed continuous ownership', () => {
  for (const scope of scopes.filter(scope => scope.side === 'H')) {
    const specimens = [scenario(scope, 100), scenario(scope, 106)];
    const rows = specimens.map(({cell, raw}, index) => {
      const derived = deriveLifecycleMeasurements(raw, {cell});
      // sampling.complete and a sampled maximum do not supply the browser B0
      // window/ACK join, reconciled appOwnedCpu witness, or fixed renderer
      // source/native/build/runtime proof required for an exact R18 row.
      assert.deepEqual(derived.measurements, [], scope.job);
      assert.equal(derived.unavailable.length, 1, scope.job);
      assert.equal(derived.unavailable[0].name, cpuRule.name);
      assert.equal(derived.unavailable[0].observedLowerBound, index === 0 ? 100 : 106, scope.job);
      assert.match(derived.unavailable[0].reason, /sealed continuous browser reservation window.*fixed reviewed.*proof/i);
      // Neither a plausible exact alias nor an invented over-cap alias may
      // replace the missing ownership or create an exact relative verdict.
      const collected = collect({cell, raw}, {direct: index === 1, claimed: index === 0 ? 100 : cpuRule.ceiling + 1}).rows;
      assert.equal(collected.length, 1); assert.equal(collected[0].name, cpuRule.name);
      assert.equal(collected[0].kind, 'peak-memory'); assert.equal(collected[0].value, null, scope.job);
      assert.equal(collected[0].complete, false, scope.job);
      assert.match(collected[0].missing.join(' '), /value\/unit\/method\/evidence unavailable/i);
      return collected;
    });
    const compared = compareCellRows(rows[0], rows[1])[0];
    assert.equal(compared.outcome, 'INCONCLUSIVE', scope.job);
    assert.equal(compared.reason, 'complete-matched-statistics-required');
  }
});

test('missing lifecycle traces and mismatched planned scope cannot be replaced by aliases', () => {
  const valid = scenario(), base = collect(valid).rows;
  for (const value of [scenario(), scenario(scopes[4])]) {
    value.cell.host = value.cell.host === 'C' ? 'H' : 'C';
    assert.equal(compareCellRows(base, collect(value, {claimed: 100}).rows)[0].outcome, 'INCONCLUSIVE');
  }
  const missing = scenario(); missing.raw = null;
  assert.equal(compareCellRows(base, collect(missing, {claimed: 100}).rows)[0].outcome, 'INCONCLUSIVE');
});

test('partial lifecycle peak witnesses stay inconclusive even when their lower bound breaches a cap', () => {
  for (const scope of [scopes[0], scopes[4]]) {
    const value = scenario(scope, cpuRule.ceiling + 1); value.raw.sampling.complete = false;
    const derived = deriveLifecycleMeasurements(value.raw, {cell: value.cell}).measurements[0];
    assert.equal(derived.lowerBound, true); assert.equal(derived.complete, false);
    const rows = collect(value).rows, paired = compareCellRows(collect(scenario(scope)).rows, rows)[0];
    assert.equal(rows[0].value, null); assert.equal(rows[0].complete, false);
    assert.match(rows[0].missing.join(' '), /censored|incomplete/i); assert.equal(paired.outcome, 'INCONCLUSIVE');
  }
});

test('partial within-budget lifecycle evidence cannot be completed by a plausible exact alias', () => {
  const value = scenario(); delete value.raw.sampling.peakSamples.cpuBytes;
  assert.deepEqual(deriveLifecycleMeasurements(value.raw, {cell: value.cell}).measurements, []);
  assert.equal(collect(value, {claimed: 100}).rows[0].complete, false);
  const backend = scenario(scopes[4]);
  backend.raw.sampling.allocationPeaks.cpuBytes.scope = 'process-lifetime';
  backend.raw.sampling.allocationPeaks.cpuBytes.value = cpuRule.ceiling + 1;
  assert.deepEqual(deriveLifecycleMeasurements(backend.raw, {cell: backend.cell}).measurements, [], 'Preparation lifetime peaks cannot substitute for the independent B0 window');
  assert.equal(collect(backend, {claimed: 100}).rows[0].complete, false);
});

test('all relative scalar rows reject bounds or explicit incompleteness while exact completed rows remain comparable', () => {
  const cell = {id: 'scalar/fixture', operation: 'fixture.measurement', workload: 'W1', cold: 1, warm: 0, primes: 0, phaseBudgets: [], requiredMeasurements: [cpuRule]};
  const read = extra => collectCellRows(cell, 'cold', [{id: 'scalar/cold/scored/1', cache: 'cold', ordinal: 1, prime: false, status: 'PASS',
    result: {status: 'PASS', measurements: [{name: cpuRule.name, value: 100, unit: 'bytes', method: 'Actual exact allocation', evidence: {sample: 1}, ...extra}]}}], 'P').rows;
  const exact = read({complete: true});
  assert.equal(compareCellRows(exact, read({value: 105}))[0].outcome, 'PASS');
  assert.equal(compareCellRows(exact, read({complete: true, value: 106}))[0].outcome, 'BLOCKED');
  for (const bounds of [{lowerBound: true}, {upperBound: true}, {lowerBound: 90, upperBound: 110}, {complete: false}]) {
    const incomplete = read({complete: true, ...bounds});
    assert.equal(incomplete[0].value, null); assert.equal(compareCellRows(exact, incomplete)[0].outcome, 'INCONCLUSIVE');
  }
});

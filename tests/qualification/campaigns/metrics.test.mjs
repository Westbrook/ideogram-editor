import test from 'node:test';
import assert from 'node:assert/strict';
import { unionWork, evaluateSession, evaluateFirstUse, evaluateHotEdit, evaluateInteraction, evaluateLifecycle, evaluateAdapterLifecycle, evaluateVisits } from '../../../tooling/qualification/campaigns/metrics.mjs';

const evidence = { kind: 'browser-presentation-trace', sha256: 'a'.repeat(64), attributionComplete: true };
function session(protocol = 'I', cache = 'warm', ordinal = 1) {
  const actions = [];
  if (protocol === 'I') {
    for (let stroke = 0; stroke < 20; stroke++) actions.push({ id: `stroke-${stroke}`, kind: 'stroke', inputMs: stroke * 2000, presentedMs: stroke * 2000 + 10, meaningful: true,
      samples: Array.from({ length: 120 }, (_, index) => ({ id: `${stroke}-${index}`, inputMs: stroke * 2000 + index * 1000 / 60, presentedMs: stroke * 2000 + index * 1000 / 60 + 10 })), pointerSchedule: { clock: 'runner-monotonic', frequencyHz: 60, samples: Array.from({ length: 120 }, (_, index) => ({ index, scheduledMs: stroke * 2000 + index * 1000 / 60, dispatchStartedMs: stroke * 2000 + index * 1000 / 60, dispatchCompletedMs: stroke * 2000 + index * 1000 / 60 + 1 })) } });
    for (let index = 0; index < 80; index++) actions.push({ id: `discrete-${index}`, kind: 'discrete', inputMs: 40000 + index * 200, presentedMs: 40010 + index * 200, meaningful: true });
  } else {
    for (const [kind, count] of [['insert-delete', 40], ['preedit', 20], ['composition-end', 10], ['caret', 10], ['semantic-selection', 10], ['text-format', 10], ['presentation', 6]]) {
      for (let index = 0; index < count; index++) actions.push({ id: `${kind}-${index}`, kind, inputMs: actions.length * 500, presentedMs: actions.length * 500 + 10, meaningful: true });
    }
  }
  return { id: `${cache}-${ordinal}`, cache, ordinal, cohortKey: 'fixture-H-chromium-warm', startMs: 0, endMs: 60000, visibility: 'visible', refreshHz: 60,
    trace: evidence, actions, activeSegments: [{ startMs: 0, endMs: 60000, mainThreadIntervals: Array.from({ length: 3600 }, (_, index) => ({ startMs: index * 1000 / 60, endMs: index * 1000 / 60 + 1 })), slots: Array.from({ length: 3600 }, (_, index) => ({ index, presented: true })) }],
    textPresentation: Object.fromEntries(['sameConnectedNode', 'forwardRangePreserved', 'backwardRangePreserved', 'collapsedRangePreserved', 'latestDeferredOnlyAfterNativeEnd', 'cancelDropsDeferred', 'staleSessionGenerationVersionRejected'].map(key => [key, true])) };
}

test('frame work clips cross-slot intervals and counts overlapping nested work once', () => {
  assert.equal(unionWork([{ startMs: 0, endMs: 8 }, { startMs: 2, endMs: 5 }, { startMs: 7, endMs: 12 }, { startMs: 18, endMs: 23 }], 0, 20), 14);
  assert.equal(unionWork([{ startMs: 0, endMs: 30 }], 16, 20), 4);
  assert.throws(() => unionWork([{ startMs: 5, endMs: 1 }], 0, 20), /Invalid/);
});

test('I uses 100 actions and all2400 actual pointer samples; IText uses106 independent actions', () => {
  const ordinary = evaluateSession(session());
  assert.equal(ordinary.outcome, 'PASS'); assert.equal(ordinary.actions, 100); assert.equal(ordinary.pointer.n, 2400); assert.equal(ordinary.frameWork.n, 3600);
  const text = evaluateSession(session('IText'), 'IText');
  assert.equal(text.outcome, 'PASS'); assert.equal(text.actions, 106); assert.equal(text.pointer.n, 0);
  const missing = session('IText'); missing.actions.pop();
  assert.equal(evaluateSession(missing, 'IText').outcome, 'INCONCLUSIVE');
  const stale = session('IText'); stale.textPresentation.staleSessionGenerationVersionRejected = false;
  assert.equal(evaluateSession(stale, 'IText').outcome, 'FAIL');
});

test('scheduled sixty-Hz input stays separate from actual native jitter and presentation latency', () => {
  const value = session();
  for (const action of value.actions.filter(action => action.kind === 'stroke')) for (let index = 0; index < action.samples.length; index++) {
    action.samples[index].inputMs += index % 2 ? 2 : 0;
    action.samples[index].presentedMs = action.samples[index].inputMs + 10;
    action.pointerSchedule.samples[index].dispatchStartedMs += 3;
    action.pointerSchedule.samples[index].dispatchCompletedMs += 3;
  }
  const observed = evaluateSession(value);
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.pointer.p95, 10);
  // Synthetic timestamp subtraction can round by a few picoseconds.
  assert.ok(Math.abs(observed.pointerCadence.dispatchLateness.max - 3) < 1e-9);
  assert.ok(observed.pointerCadence.actualNativeIntervals.max > 18);
  const missing = structuredClone(value); delete missing.actions[0].pointerSchedule;
  assert.equal(evaluateSession(missing).outcome, 'INCONCLUSIVE');
  const early = structuredClone(value); early.actions[0].pointerSchedule.samples[1].dispatchStartedMs = 0;
  assert.equal(evaluateSession(early).outcome, 'INCONCLUSIVE');
  const malformed = structuredClone(value); malformed.actions[0].pointerSchedule.samples[1].scheduledMs += 1;
  assert.equal(evaluateSession(malformed).outcome, 'INCONCLUSIVE');
  const proxy = structuredClone(value); proxy.actions[0].pointerSchedule.clock = 'browser-performance';
  assert.equal(evaluateSession(proxy).outcome, 'INCONCLUSIVE');
});

test('DOM or rAF proxy and unavailable presentation never establish a passing session', () => {
  const proxy = session(); proxy.trace = { ...evidence, kind: 'requestAnimationFrame' };
  assert.equal(evaluateSession(proxy).outcome, 'INCONCLUSIVE');
  const missing = session(); missing.actions[0].presentedMs = null;
  assert.equal(evaluateSession(missing).outcome, 'INCONCLUSIVE');
  const truncated = session(); truncated.activeSegments[0].endMs = 1000; truncated.activeSegments[0].slots.length = 60;
  assert.equal(evaluateSession(truncated).outcome, 'INCONCLUSIVE');
  const missingPointIdentity = session(); delete missingPointIdentity.actions[0].samples[0].id;
  assert.equal(evaluateSession(missingPointIdentity).outcome, 'INCONCLUSIVE');
});

test('known action failures and resource violations cannot be hidden by fast presented samples', () => {
  const timeout = session('IText'); timeout.actions[0].outcome = 'timeout';
  assert.equal(evaluateSession(timeout, 'IText').outcome, 'FAIL');
  const cap = session('IText'); cap.capViolation = true;
  assert.equal(evaluateSession(cap, 'IText').outcome, 'FAIL');
  const late = session(); late.actions[0].samples[0].presentedMs = 90000;
  assert.equal(evaluateSession(late).outcome, 'FAIL');
  const outside = session(); outside.fallbackRequired = true; outside.fallbackSlices = [{ startMs: 90000, endMs: 90001, active: true }];
  assert.equal(evaluateSession(outside).outcome, 'INCONCLUSIVE');
});

test('per-slot max, pointer p95, drop share and acknowledgement maxima enforce independent ceilings', () => {
  const work = session(); work.activeSegments[0].mainThreadIntervals = [{ startMs: 0, endMs: 11 }];
  assert.ok(evaluateSession(work).failures.includes('R07-main-thread-slot-over-10ms'));
  const pointer = session(); for (const action of pointer.actions) for (const point of action.samples ?? []) point.presentedMs = point.inputMs + 34;
  assert.ok(evaluateSession(pointer).failures.includes('R07-pointer-p95-over-33.4ms'));
  const drop = session(); for (let index = 0; index < 181; index++) drop.activeSegments[0].slots[index].presented = false;
  const dropped = evaluateSession(drop); assert.equal(dropped.outcome, 'FAIL'); assert.equal(dropped.stallsAtLeast100ms.length, 1);
  const feedback = session(); feedback.actions.at(-1).presentedMs += 91;
  assert.ok(evaluateSession(feedback).failures.includes('R04-acknowledgement-over-100ms'));
});

test('frame targets retain each active segment while dropped slots use the entire sixty-second session', () => {
  const value = session(), segment = value.activeSegments[0];
  value.activeSegments = [
    { startMs: 0, endMs: 1000, mainThreadIntervals: Array.from({ length: 60 }, (_, index) => ({ startMs: index * 1000 / 60, endMs: index * 1000 / 60 + 9 })), slots: Array.from({ length: 60 }, (_, index) => ({ index, presented: index < 57 })) },
    { startMs: 1000, endMs: 60000, mainThreadIntervals: segment.mainThreadIntervals, slots: Array.from({ length: 3540 }, (_, index) => ({ index, presented: index >= 3 })) },
  ];
  const observed = evaluateSession(value);
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.targetMisses.frameWork, true);
  assert.ok(observed.frameWork.p95 < 8); assert.ok(observed.frameSegments[0].work.p95 > 8);
  assert.equal(observed.droppedShare60SecondSession, 6 / 3600);
  assert.equal(observed.stallsAtLeast100ms.length, 1);
});

test('active cooperative slices retain6ms ceiling independent of inactive16ms ceiling', () => {
  const value = session(); value.fallbackRequired = true; value.fallbackSlices = [{ startMs: 0, endMs: 6, active: true }, { startMs: 100, endMs: 116, active: false }];
  assert.equal(evaluateSession(value).outcome, 'PASS');
  value.fallbackSlices[0].endMs = 6.1;
  assert.equal(evaluateSession(value).outcome, 'FAIL');
});

test('Q3 I takes six separate sessions, without substituting a fast pooled subset', () => {
  const sessions = [session('I', 'cold', 1), ...Array.from({ length: 5 }, (_, index) => session('I', 'warm', index + 1))];
  const args = { profile: 'Q3', cohortKey: sessions[0].cohortKey, sessions };
  assert.equal(evaluateInteraction(args).outcome, 'PASS');
  assert.equal(evaluateInteraction({ ...args, sessions: sessions.slice(1) }).outcome, 'INCONCLUSIVE');
  sessions[0].actions[0].presentedMs = 101;
  assert.equal(evaluateInteraction(args).outcome, 'FAIL');
});

test('P I requires all ten reset first-use windows and three preserved hot edits with actual presentation', () => {
  const warm = session();
  const args = { profile: 'P', cohortKey: warm.cohortKey, sessions: [warm],
    firstUse: Array.from({ length: 10 }, (_, id) => ({ id: `first-${id}`, reset: true, startMs: 0, endMs: 1000, inputMs: 10, presentedMs: 20, readyMs: 700, meaningful: true, trace: evidence })),
    hotEdits: Array.from({ length: 3 }, (_, id) => ({ id: `hot-${id}`, savedMs: 0, presentedMs: 400, documentPreserved: true, reload: false, trace: evidence })) };
  assert.equal(evaluateInteraction(args).outcome, 'PASS');
  assert.equal(evaluateInteraction({ ...args, firstUse: args.firstUse.slice(1) }).outcome, 'INCONCLUSIVE');
  const missing = structuredClone(args); missing.hotEdits[0].trace.kind = 'rAF';
  assert.equal(evaluateInteraction(missing).outcome, 'INCONCLUSIVE');
  const slow = structuredClone(args); slow.firstUse[0].readyMs = 761;
  assert.ok(evaluateInteraction(slow).failures.includes('R06-lazy-readiness'));
  const reload = structuredClone(args); reload.hotEdits[0].reload = true;
  assert.equal(evaluateInteraction(reload).outcome, 'FAIL');
  const failed = structuredClone(args); failed.firstUse[0].outcome = 'timeout';
  assert.equal(evaluateInteraction(failed).outcome, 'FAIL');
  const cap = structuredClone(args); cap.hotEdits[0].capViolation = true;
  assert.equal(evaluateInteraction(cap).outcome, 'FAIL');
});

test('standalone first-use evaluation keeps reset, window, acknowledgement and ready constraints', () => {
  const values = Array.from({ length: 10 }, (_, ordinal) => ({ id: `first-${ordinal}`, reset: true, startMs: 0, endMs: 1000, inputMs: 10, presentedMs: 20, readyMs: 700, meaningful: true, trace: evidence }));
  assert.equal(evaluateFirstUse(values).outcome, 'PASS');
  assert.equal(evaluateFirstUse(values.slice(1)).outcome, 'INCONCLUSIVE');
  const noReset = structuredClone(values); noReset[0].reset = false;
  assert.equal(evaluateFirstUse(noReset).outcome, 'INCONCLUSIVE');
  const late = structuredClone(values); late[0].presentedMs = 111;
  assert.equal(evaluateFirstUse(late).outcome, 'FAIL');
  const noTrace = structuredClone(values); noTrace[0].trace.kind = 'DOM';
  assert.equal(evaluateFirstUse(noTrace).outcome, 'INCONCLUSIVE');
});

test('standalone Q3 hot updates require exact cold and warm cohorts and actual preserved paints', () => {
  const values = ['cold', 'warm'].flatMap(cache => Array.from({ length: 10 }, (_, index) => ({ id: `${cache}-${index}`, cache, ordinal: index + 1, savedMs: 0, presentedMs: cache === 'cold' ? 400 : 100, documentPreserved: true, reload: false, trace: evidence })));
  const observed = evaluateHotEdit(values, { profile: 'Q3' });
  assert.equal(observed.outcome, 'PASS'); assert.equal(observed.caches.cold.max, 400); assert.equal(observed.caches.warm.max, 100);
  assert.equal(evaluateHotEdit(values.slice(1), { profile: 'Q3' }).outcome, 'INCONCLUSIVE');
  const duplicate = structuredClone(values); duplicate[0].ordinal = duplicate[1].ordinal;
  assert.equal(evaluateHotEdit(duplicate, { profile: 'Q3' }).outcome, 'INCONCLUSIVE');
  const late = structuredClone(values); late[0].presentedMs = 501;
  assert.equal(evaluateHotEdit(late, { profile: 'Q3' }).outcome, 'FAIL');
  const reload = structuredClone(values); reload[0].reload = true;
  assert.equal(evaluateHotEdit(reload, { profile: 'Q3' }).outcome, 'FAIL');
  const noTrace = structuredClone(values); noTrace[0].trace.kind = 'rAF';
  assert.equal(evaluateHotEdit(noTrace, { profile: 'Q3' }).outcome, 'INCONCLUSIVE');
  assert.equal(evaluateHotEdit(values.slice(10, 13)).outcome, 'PASS');
  assert.equal(evaluateHotEdit(values.slice(0, 3)).outcome, 'INCONCLUSIVE');
});

const lifecycleRaster = () => ({ schemaVersion: 1, scope: 'M-authored-mask-candidate-replacement-undo', strokeAuthoredGeometry: true, adoptedLayerPixelsEqualPreparedCandidate: true, otherLayersAndTargetSlotPreserved: true, canonicalDocumentPixelsVerified: true, undoAdoptionPixelsRestored: true, undoBaselinePixelsRestored: true, retainedInputs: true, nativeDisplayPixels: false, independentStrokeRasterization: false });

const resource = () => ({ browserRssBytes: 100 * 1024 ** 2, backendRssBytes: 100 * 1024 ** 2, cpuBytes: 100 * 1024 ** 2, gpuBytes: 100 * 1024 ** 2, previewCacheBytes: 10 * 1024 ** 2, settledBytes: 100 * 1024 ** 2, unusedHandles: 0, textureSide: 1024, deviceTextureLimit: 4096 });
function lifecycle(profile = 'P-M', workload = 'W1') {
  const count = profile === 'P-M' ? 2 : 100;
  const cycles = Array.from({ length: count }, (_, index) => {
    const startMs = 30000 + index * 90000, endMs = startMs + 90000;
    const names = ['open', 'stroke', 'adopt', 'undo-adoption', 'undo-stroke', 'close', 'release'];
    if (workload.startsWith('WX')) names.splice(1, 0, 'text-edit', 'undo-text', 'font-select', 'font-restore');
    return { ordinal: index + 1, processIdentity: 'process', fixtureIdentity: 'fixture', startMs, endMs,
      action: { phases: names.map((name, n) => ({ name, startMs: startMs + n * 100, endMs: startMs + n * 100 + 50, outcome: 'expected' })), strokeSamples: 120, assertions: { lifecycleRaster: lifecycleRaster() } },
      idle: { requestedMs: 30000, startMs: endMs - 30100, endMs: endMs - 100 }, observation: { startMs: endMs - 100, endMs }, resources: resource(), resourceSamples: [resource()], releaseMs: 100,
      restart: (profile === 'P-M' ? index === 0 : [19, 39, 59, 79].includes(index)) ? { before: `worker-${index}`, after: `worker-${index + 1}`, startMs: startMs + 4000, endMs: startMs + 5000 } : null };
  });
  return { profile, workload, startMs: 0, endMs: cycles.at(-1).endMs, processIdentity: 'process', fixtureIdentity: 'fixture', forcedGC: false, processRestarted: false, B0: { idle: { requestedMs: 30000, startMs: 0, endMs: 30000 }, observation: { startMs: 30000, endMs: 30000 }, resources: resource() }, cycles,
    windows: profile === 'M' ? Array.from({ length: 5 }, (_, index) => ({ ordinal: index + 1, startMs: 30000 + index * 1800000, endMs: 30000 + (index + 1) * 1800000 })) : [], sampling: { complete: true, kind: 'attributed-process-tree-and-allocation-ledger', sha256: 'b'.repeat(64) } };
}

test('P-M and100-cycle mixed lifecycle require independent baseline, idles, true actions and restarts', () => {
  assert.equal(evaluateLifecycle(lifecycle()).outcome, 'PASS');
  assert.equal(evaluateLifecycle(lifecycle('M', 'WXs')).outcome, 'PASS');
  const short = lifecycle('M'); short.cycles.pop();
  assert.equal(evaluateLifecycle(short).outcome, 'INCONCLUSIVE');
  const restart = lifecycle(); restart.cycles[0].restart = null;
  assert.equal(evaluateLifecycle(restart).outcome, 'INCONCLUSIVE');
  const reset = lifecycle(); reset.cycles[1].processIdentity = 'restarted';
  assert.equal(evaluateLifecycle(reset).outcome, 'INCONCLUSIVE');
  assert.equal(evaluateLifecycle({ ...lifecycle(), forcedGC: true }).outcome, 'FAIL');
});

test('M proves the explicit authored, adopted-layer and both Undo byte oracles without a display claim', () => {
  const value = lifecycle(); value.cycles[0].action.assertions.exactPixels = null;
  assert.equal(evaluateLifecycle(value).outcome, 'PASS');
  const legacy = lifecycle(); legacy.cycles[0].action.assertions = { exactPixels: true, undoRestored: true, retainedInputs: true };
  assert.equal(evaluateLifecycle(legacy).outcome, 'INCONCLUSIVE');
  for (const key of ['strokeAuthoredGeometry', 'adoptedLayerPixelsEqualPreparedCandidate', 'otherLayersAndTargetSlotPreserved', 'canonicalDocumentPixelsVerified', 'undoAdoptionPixelsRestored', 'undoBaselinePixelsRestored', 'retainedInputs']) {
    const missing = lifecycle(); delete missing.cycles[0].action.assertions.lifecycleRaster[key];
    assert.equal(evaluateLifecycle(missing).outcome, 'INCONCLUSIVE', key);
    const failed = lifecycle(); failed.cycles[0].action.assertions.lifecycleRaster[key] = false;
    assert.equal(evaluateLifecycle(failed).outcome, 'FAIL', key);
  }
  const broad = lifecycle(); broad.cycles[0].action.assertions.lifecycleRaster.nativeDisplayPixels = true;
  assert.equal(evaluateLifecycle(broad).outcome, 'INCONCLUSIVE');
});

test('a transient memory breach and worst settled growth cannot be hidden by a small final sample', () => {
  const peak = lifecycle(); peak.cycles[0].resourceSamples[0].cpuBytes = 512 * 1024 ** 2 + 1;
  assert.equal(evaluateLifecycle(peak).outcome, 'FAIL');
  const growth = lifecycle(); growth.cycles[0].resources.settledBytes += 8 * 1024 ** 2 + 1;
  const evaluated = evaluateLifecycle(growth); assert.equal(evaluated.outcome, 'FAIL'); assert.equal(evaluated.growth.finalBytes, 0);
  const release = lifecycle(); release.cycles[1].releaseMs = 5001;
  assert.equal(evaluateLifecycle(release).outcome, 'FAIL');
});

test('Canvas2D texture N/A needs reviewed source and build proof, never a runtime declaration or fabricated limit', () => {
  const declaration = { contract: 'canvas2d-owned-rgba-v1', backend: 'main-thread-canvas-2d', appOwnedTextureAPIs: [], appOwnedTextureCount: 0, textureLimitApplicability: 'not-applicable', rgbaBackingEstimateBytes: resource().gpuBytes };
  for (const proof of [undefined, {}, { kind: 'renderer-ownership-proof-1', schemaVersion: 1, reviewId: 'unreviewed', reviewSha256: 'a'.repeat(64) }]) {
    const value = lifecycle(); Object.assign(value.B0.resources, { rendererOwnership: declaration, rendererOwnershipProof: proof, textureSide: null, deviceTextureLimit: null });
    const observed = evaluateLifecycle(value);
    assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.ok(observed.missing.includes('reviewed-renderer-texture-not-applicable-proof'));
    value.B0.resources.textureSide = 0; value.B0.resources.deviceTextureLimit = 0;
    assert.equal(evaluateLifecycle(value).outcome, 'INCONCLUSIVE');
    value.B0.resources.gpuBytes = 384 * 1024 ** 2 + 1;
    assert.equal(evaluateLifecycle(value).outcome, 'FAIL');
  }
  const missing = lifecycle(); missing.B0.resources.textureSide = null; missing.B0.resources.deviceTextureLimit = null;
  assert.equal(evaluateLifecycle(missing).outcome, 'INCONCLUSIVE');
  const measured = lifecycle(); measured.B0.resources.textureSide = 2049;
  assert.equal(evaluateLifecycle(measured).outcome, 'FAIL');
});

test('missing peak attribution is unavailable and whole windows cannot be compressed', () => {
  const missing = lifecycle(); missing.sampling.complete = false;
  assert.equal(evaluateLifecycle(missing).outcome, 'INCONCLUSIVE');
  const compressed = lifecycle('M'); compressed.windows[1].endMs -= 1000;
  assert.equal(evaluateLifecycle(compressed).outcome, 'INCONCLUSIVE');
  const fastIdle = lifecycle(); fastIdle.cycles[0].idle.requestedMs = 100;
  assert.equal(evaluateLifecycle(fastIdle).outcome, 'INCONCLUSIVE');
  const earlyFinish = lifecycle('M'); earlyFinish.endMs = earlyFinish.windows.at(-1).endMs - 1000;
  assert.equal(evaluateLifecycle(earlyFinish).outcome, 'INCONCLUSIVE');
});

test('post-idle resource sampling latency stays inside the real ninety-second cycle deadline', () => {
  const value = lifecycle();
  assert.equal(evaluateLifecycle(value).outcome, 'PASS');
  value.cycles[0].observation.endMs += 1; value.cycles[0].endMs += 1;
  assert.ok(evaluateLifecycle(value).failures.includes('cycle-over-ninety-seconds'));
  const before = lifecycle(); before.cycles[0].observation.startMs--;
  assert.equal(evaluateLifecycle(before).outcome, 'INCONCLUSIVE');
  const absent = lifecycle(); delete absent.cycles[0].observation;
  assert.equal(evaluateLifecycle(absent).outcome, 'INCONCLUSIVE');
  const emptyIdentity = lifecycle(); emptyIdentity.cycles[0].restart.before = '';
  assert.equal(evaluateLifecycle(emptyIdentity).outcome, 'INCONCLUSIVE');
});

function adapterLifecycle() {
  const value = lifecycle(); value.profile = 'P-A'; value.weightsIdentity = 'd'.repeat(64); value.configIdentity = 'e'.repeat(64);
  value.cycles.forEach(cycle => {
    cycle.weightsIdentity = value.weightsIdentity; cycle.configIdentity = value.configIdentity; cycle.restart = null;
    cycle.action = { phases: ['import', 'select', 'unselect', 'close', 'release'].map((name, index) => ({ name, startMs: cycle.startMs + index * 100, endMs: cycle.startMs + index * 100 + 50, outcome: 'expected' })),
      selectedIdentities: [value.weightsIdentity], assertions: Object.fromEntries(['fixedArtifactsImported', 'selectionRestored', 'durableFixturePreserved', 'noBrowserTensorDecode', 'zeroUnexpectedFetches'].map(key => [key, true])) };
  });
  return value;
}

test('WA has two independent real import lifecycles and caps without inventing editor growth claims', () => {
  const value = adapterLifecycle(); value.cycles[1].resources.settledBytes += 64 * 1024 ** 2;
  const result = evaluateAdapterLifecycle(value); assert.equal(result.outcome, 'PASS'); assert.equal(result.growthClaim, false); assert.equal(result.growth, undefined);
  value.cycles[0].action.phases[0].name = 'metadata-selection';
  assert.equal(evaluateAdapterLifecycle(value).outcome, 'INCONCLUSIVE');
  const different = adapterLifecycle(); different.cycles[1].weightsIdentity = 'f'.repeat(64);
  assert.equal(evaluateAdapterLifecycle(different).outcome, 'INCONCLUSIVE');
  const cap = adapterLifecycle(); cap.cycles[1].resourceSamples[0].backendRssBytes = 512 * 1024 ** 2 + 1;
  assert.equal(evaluateAdapterLifecycle(cap).outcome, 'FAIL');
  const destructive = adapterLifecycle(); destructive.cycles[0].action.assertions.durableFixturePreserved = false;
  assert.equal(evaluateAdapterLifecycle(destructive).outcome, 'FAIL');
});

function visits(metric = 'INP') {
  const count = metric === 'INP' ? 5 : 30, expectedVisits = Array.from({ length: count }, (_, index) => `visit-${index}`);
  return { profile: 'Q3', metric, cache: 'warm', cohortKey: 'chrome-H', library: { name: 'web-vitals', version: '1.2.3', sha256: 'c'.repeat(64) }, expectedVisits,
    reports: expectedVisits.map((visitId, index) => ({ metric, visitId, navigationId: `nav-${index}`, metricId: `metric-${index}`, sequence: 1, finalized: true, observerSupported: true, lifecycleComplete: true, visibility: 'visible', interactions: 100, value: metric === 'CLS' ? .01 : 100, cohortKey: 'chrome-H', cache: 'warm', libraryVersion: '1.2.3' })) };
}

test('CW keeps the latest finalized metric per visit and uses cross-visitp75, never interactionp95', () => {
  const value = visits(); value.reports.forEach((report, index) => report.value = [20, 40, 60, 180, 190][index]);
  value.reports.push({ ...value.reports[0], sequence: 2, value: 100 });
  value.reports.push({ ...value.reports[0], sequence: 3, finalized: false, value: 99999 });
  const evaluated = evaluateVisits(value);
  assert.equal(evaluated.outcome, 'PASS'); assert.equal(evaluated.available, 5); assert.equal(evaluated.value, 180);
  assert.equal(evaluated.finalized[0].sequence, 2); assert.equal(evaluated.finalized[0].value, 100);
});

test('no interactions, no observer or unfinished lifecycle gives unavailableINP rather than zero', () => {
  for (const patch of [{ interactions: 0 }, { observerSupported: false }, { lifecycleComplete: false }, { finalized: false }]) {
    const value = visits(); Object.assign(value.reports[0], patch);
    const evaluated = evaluateVisits(value); assert.equal(evaluated.outcome, 'INCONCLUSIVE'); assert.equal(evaluated.value, null); assert.deepEqual(evaluated.unavailable, ['visit-0']);
  }
});

test('CW missing visits, duplicate sequences and mixed identities cannot supply a passing percentile', () => {
  const missing = visits('LCP'); missing.expectedVisits.pop(); missing.reports.pop();
  assert.equal(evaluateVisits(missing).outcome, 'INCONCLUSIVE');
  const duplicate = visits(); duplicate.reports.push({ ...duplicate.reports[0] });
  assert.equal(evaluateVisits(duplicate).outcome, 'INCONCLUSIVE');
  const mixed = visits(); mixed.reports[0].cohortKey = 'different-machine';
  assert.equal(evaluateVisits(mixed).outcome, 'INCONCLUSIVE');
  const failed = visits(); failed.reports[0].outcome = 'unexpected-error';
  assert.equal(evaluateVisits(failed).outcome, 'FAIL');
  const duplicatedVisit = visits(); duplicatedVisit.reports.forEach(report => { report.metricId = 'same-metric'; report.navigationId = 'same-navigation'; });
  assert.equal(evaluateVisits(duplicatedVisit).outcome, 'INCONCLUSIVE');
  const numericIdentity = visits(); numericIdentity.reports[0].metricId = 42;
  assert.equal(evaluateVisits(numericIdentity).outcome, 'INCONCLUSIVE');
  const missingInteractionCount = visits('LCP'); delete missingInteractionCount.reports[0].interactions;
  assert.equal(evaluateVisits(missingInteractionCount).outcome, 'INCONCLUSIVE');
});

test('CW measured ceilings retain failure precedence with unavailable visits', () => {
  const value = visits(); value.reports.forEach(report => report.value = 201); value.reports[0].observerSupported = false;
  assert.equal(evaluateVisits(value).outcome, 'FAIL');
  const cls = visits('CLS'); cls.reports.forEach(report => report.value = .11);
  assert.equal(evaluateVisits(cls).outcome, 'FAIL');
});

test('optional field results require real visits and full28day coverage, not localhost lab relabeling', () => {
  const field = visits(); field.profile = 'FIELD'; field.fieldWindow = { realUserVisits: false, startMs: 0, endMs: 28 * 86400_000 };
  assert.equal(evaluateVisits(field).outcome, 'INCONCLUSIVE');
});

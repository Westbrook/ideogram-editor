import test from 'node:test';
import { appOwnedCpuCandidate } from '../../../tooling/qualification/campaigns/resource-sampling-verification.mjs';
import { appOwnershipSpecimen } from '../../campaigns/app-ownership-specimen.mjs';
import { selectedAdapterIdentity } from '../../../tooling/qualification/campaigns/adapter-lifecycle.mjs';
import assert from 'node:assert/strict';
import { unionWork, evaluateSession, evaluateFirstUse, evaluateHotEdit, evaluateInteraction, evaluateLifecycle, evaluateAdapterLifecycle, deriveLifecycleMeasurements, evaluateVisits } from '../../../tooling/qualification/campaigns/metrics.mjs';

const evidence = { kind: 'browser-presentation-trace', sha256: 'a'.repeat(64), attributionComplete: true };
const textRejection = () => ({ kind: 'deferred-presentation-rejection-1', requestSequence: 6, reason: 'stale-generation', requestEpoch: 1, currentEpoch: 1, requestGeneration: 2, currentGeneration: 3,
  presentationUnchanged: true, requestNotSettled: true, nativeBoundary: 'existing-final-composition-cancel', extraMutationOrRequest: false, witnessedGuards: ['stale-generation'], unobservedGuards: ['stale-session', 'stale-version'] });
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
    textPresentation: { ...Object.fromEntries(['sameConnectedNode', 'forwardRangePreserved', 'backwardRangePreserved', 'collapsedRangePreserved', 'latestDeferredOnlyAfterNativeEnd', 'cancelDropsDeferred', 'staleDeferredRequestRejected'].map(key => [key, true])), deferredRequestRejection: textRejection() } };
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
  assert.equal(text.outcome, 'INCONCLUSIVE'); assert.equal(text.actions, 106); assert.equal(text.pointer.n, 0);
  assert.deepEqual(text.missing, ['IText:actual-cancel-native-end-draft-guard-tuple', 'IText:stale-session-rejection-unobserved', 'IText:stale-version-rejection-unobserved']);
  const missing = session('IText'); missing.actions.pop();
  assert.equal(evaluateSession(missing, 'IText').outcome, 'INCONCLUSIVE');
  const stale = session('IText'); stale.textPresentation.staleDeferredRequestRejected = false;
  assert.equal(evaluateSession(stale, 'IText').outcome, 'FAIL');
});

test('IText records the actual generation rejection without claiming unobserved session and version branches', () => {
  const value = session('IText'), observed = evaluateSession(value, 'IText');
  assert.deepEqual(observed.textGuardCoverage.witnessedGuards, ['stale-generation']);
  assert.deepEqual(observed.textGuardCoverage.unobservedGuards, ['stale-session', 'stale-version']);
  assert.equal(observed.textGuardCoverage.modelSettlementIsPhysicalPresentation, false);
  const legacy = session('IText'); delete legacy.textPresentation.deferredRequestRejection; delete legacy.textPresentation.staleDeferredRequestRejected;
  legacy.textPresentation.staleSessionGenerationVersionRejected = true;
  const old = evaluateSession(legacy, 'IText'); assert.equal(old.outcome, 'INCONCLUSIVE');
  assert.deepEqual(old.textGuardCoverage.witnessedGuards, []); assert.ok(old.missing.includes('IText:actual-cancel-native-end-draft-guard-tuple'));
  for (const patch of [{ currentGeneration: 2 }, { currentEpoch: 2 }, { reason: 'cancelled' }, { requestSequence: 0 }, { requestEpoch: null }, { witnessedGuards: ['stale-session', 'stale-generation', 'stale-version'], unobservedGuards: [] }]) {
    const invalid = session('IText'); Object.assign(invalid.textPresentation.deferredRequestRejection, patch);
    const result = evaluateSession(invalid, 'IText'); assert.deepEqual(result.textGuardCoverage.witnessedGuards, []); assert.ok(result.missing.includes('IText:actual-cancel-native-end-draft-guard-tuple'));
  }
});

test('IText admits one compound actual Cancel tuple with draft-version meaning and unchanged accepted versions', () => {
  const value = session('IText');
  value.textPresentation.deferredRequestRejection = {kind: 'deferred-presentation-rejection-2', requestSequence: 6, reason: 'cancelled',
    requestEpoch: 1, currentEpoch: 2, requestGeneration: 10, currentGeneration: 11, requestTextVersion: 3, currentTextVersion: 4,
    capturedState: {epoch: 1, generation: 10, textVersion: 3}, currentState: {epoch: 2, generation: 11, textVersion: 4},
    presentationUnchanged: true, requestNotSettled: true, nativeBoundary: 'cancel-native-end', guardMask: 7, versionMeaning: 'draft-text-version',
    extraMutationOrRequest: false, witnessedGuards: ['stale-session', 'stale-generation', 'stale-version'], unobservedGuards: [],
    acceptedVersion: {scope: 'accepted-document-layer-version', invariantUnchanged: true, rejectionObserved: false}};
  // This complete arithmetic fixture is not a retained native session. The
  // three observations are one compound Cancel retirement, not isolated branches.
  const observed = evaluateSession(value, 'IText');
  assert.equal(observed.outcome, 'PASS'); assert.deepEqual(observed.missing, []);
  assert.deepEqual(observed.textGuardCoverage.witnessedGuards, ['stale-session', 'stale-generation', 'stale-version']);
  assert.deepEqual(observed.textGuardCoverage.unobservedGuards, []); assert.equal(observed.textGuardCoverage.versionMeaning, 'draft-text-version');
  assert.deepEqual(observed.textGuardCoverage.acceptedVersion, {scope: 'accepted-document-layer-version', invariantUnchanged: true, rejectionObserved: false});
  assert.equal(observed.textGuardCoverage.modelSettlementIsPhysicalPresentation, false);
  for (const mutate of [r => {r.guardMask = 3;}, r => {r.nativeBoundary = 'restore-input';}, r => {r.currentEpoch = r.requestEpoch;},
    r => {r.currentGeneration = r.requestGeneration;}, r => {r.currentTextVersion = r.requestTextVersion;},
    r => {r.capturedState.textVersion++;}, r => {r.currentState.generation++;}, r => {r.versionMeaning = 'accepted-layer-version';},
    r => {r.acceptedVersion.rejectionObserved = true;}, r => {delete r.currentTextVersion;}, r => {r.requestTextVersion = true;}]) {
    const invalid = structuredClone(value); mutate(invalid.textPresentation.deferredRequestRejection);
    const result = evaluateSession(invalid, 'IText'); assert.equal(result.outcome, 'INCONCLUSIVE');
    assert.ok(result.missing.includes('IText:actual-cancel-native-end-draft-guard-tuple'));
    assert.deepEqual(result.textGuardCoverage.witnessedGuards, []);
  }
  for (const mutate of [r => {r.guardMask = 15;}, r => {r.acceptedVersion.invariantUnchanged = false;}]) {
    const invalid = structuredClone(value); mutate(invalid.textPresentation.deferredRequestRejection);
    const result = evaluateSession(invalid, 'IText'); assert.equal(result.outcome, 'FAIL');
    assert.ok(result.failures.includes('IText:accepted-version-changed-in-fixed-specimen'));
  }
});

test('IText cancelled request state changes and extra actions fail while model settlement cannot supply paint', () => {
  for (const patch of [{ presentationUnchanged: false }, { requestNotSettled: false }, { extraMutationOrRequest: true }]) {
    const value = session('IText'); Object.assign(value.textPresentation.deferredRequestRejection, patch);
    assert.equal(evaluateSession(value, 'IText').outcome, 'FAIL');
  }
  const value = session('IText'); for (const action of value.actions.filter(action => action.kind === 'presentation')) { action.presentedMs = null; action.modelSettledMs = action.inputMs + 1; }
  const observed = evaluateSession(value, 'IText'); assert.equal(observed.outcome, 'INCONCLUSIVE'); assert.ok(observed.missing.includes('meaningful-presented-acknowledgement'));
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

function adapterCell(side = 'H', profile = 'P-A') {
  const id = profile === 'P-A' ? side === 'C' ? 'AC2' : 'AH2' : side === 'C' ? 'I8C' : 'I8H';
  return { id: `${id}/WA-lifecycle`, host: side, handler: side === 'C' ? 'adapters' : 'browser', operation: 'adapter.lifecycle', workload: 'WA', kind: 'lifecycle', parameters: { cycles: 2, idleMs: 30000, baselineIdleMs: 30000, bytes: 256 * 1024 ** 2, configBytesMax: 1024 ** 2 } };
}
const evaluateWA = (value, { cell = adapterCell('H', value.profile) } = {}) => evaluateAdapterLifecycle(value, { cell });

function adapterLifecycle() {
  const value = lifecycle(); value.profile = 'P-A'; value.weightsIdentity = 'sha256:' + 'd'.repeat(64); value.configIdentity = 'sha256:' + 'e'.repeat(64);
  value.cycles.forEach(cycle => {
    cycle.weightsIdentity = value.weightsIdentity; cycle.configIdentity = value.configIdentity; cycle.restart = null;
    cycle.action = { phases: ['import', 'select', 'unselect', 'close', 'release'].map((name, index) => ({ name, startMs: cycle.startMs + index * 100, endMs: cycle.startMs + index * 100 + 50, outcome: 'expected' })),
      selectedArtifacts: [selectedAdapterIdentity({ versionId: `version-${cycle.ordinal}`, adapterId: 'adapter', version: String(cycle.ordinal), weights: { hash: value.weightsIdentity, byteLength: String(256 * 1024 ** 2), mediaType: 'application/octet-stream' }, config: { hash: value.configIdentity, byteLength: '128', mediaType: 'application/json' } })], assertions: Object.fromEntries(['fixedArtifactsImported', 'selectionRestored', 'durableFixturePreserved', 'noBrowserTensorDecode', 'zeroUnexpectedFetches'].map(key => [key, true])) };
    cycle.action.selectedIdentities = cycle.action.selectedArtifacts.map(artifact => artifact.identity);
    cycle.action.observations = { importedBinding: { ...cycle.action.selectedArtifacts[0].value, kind: 'wa-imported-adapter-binding-1', locallyEligible: true }, selectedImportedIdentity: true };
  });
  return value;
}

test('WA retains two-cycle resource checks while unverified H semantics remain unknown', () => {
  const value = adapterLifecycle(); value.cycles[1].resources.settledBytes += 64 * 1024 ** 2;
  const result = evaluateWA(value); assert.equal(result.outcome, 'INCONCLUSIVE'); assert.equal(result.growthClaim, false); assert.equal(result.growth, undefined);
  assert.deepEqual(result.missing, ['WA:noBrowserTensorDecode', 'WA:zeroUnexpectedFetches']);
  value.cycles[0].action.phases[0].name = 'metadata-selection';
  assert.equal(evaluateWA(value).outcome, 'INCONCLUSIVE');
  assert.ok(evaluateWA(value).missing.includes('actual-complete-WA-import-select-unselect-close-release'));
  const different = adapterLifecycle(); different.cycles[1].weightsIdentity = 'f'.repeat(64);
  assert.equal(evaluateWA(different).outcome, 'INCONCLUSIVE');
  assert.ok(evaluateWA(different).missing.includes('same-WA-process-and-fixed-artifacts-through-cycles'));
  const cap = adapterLifecycle(); cap.cycles[1].resourceSamples[0].backendRssBytes = 512 * 1024 ** 2 + 1;
  assert.equal(evaluateWA(cap).outcome, 'FAIL');
  const destructive = adapterLifecycle(); destructive.cycles[0].action.assertions.durableFixturePreserved = false;
  assert.equal(evaluateWA(destructive).outcome, 'FAIL');
});

test('WA selected versions must recompute to exactly the fixed imported weights and config', () => {
  const value = adapterLifecycle();
  assert.equal(evaluateWA(value).outcome, 'INCONCLUSIVE');
  assert.deepEqual(evaluateWA(value).missing, ['WA:noBrowserTensorDecode', 'WA:zeroUnexpectedFetches']);
  const substituted = adapterLifecycle(), artifact = substituted.cycles[0].action.selectedArtifacts[0];
  const replacement = selectedAdapterIdentity({ ...artifact.value, weights: { ...artifact.value.weights, hash: 'sha256:' + 'f'.repeat(64), byteLength: '85299896' } });
  substituted.cycles[0].action.selectedArtifacts = [replacement]; substituted.cycles[0].action.selectedIdentities = [replacement.identity];
  assert.equal(evaluateWA(substituted).outcome, 'FAIL');
  const wrongConfig = adapterLifecycle(); wrongConfig.cycles[0].action.selectedArtifacts[0].value.config.hash = 'sha256:' + 'f'.repeat(64);
  assert.equal(evaluateWA(wrongConfig).outcome, 'FAIL');
  const missing = adapterLifecycle(); delete missing.cycles[0].action.selectedArtifacts;
  assert.equal(evaluateWA(missing).outcome, 'INCONCLUSIVE');
  assert.ok(evaluateWA(missing).missing.includes('WA-exact-imported-selection-artifact-records'));
  const forged = adapterLifecycle(); forged.cycles[0].action.selectedArtifacts[0].identity = 'sha256:' + 'a'.repeat(64);
  assert.equal(evaluateWA(forged).outcome, 'FAIL');
  const oldVersion = adapterLifecycle(); oldVersion.cycles[0].action.observations.importedBinding.versionId = 'newly-imported-version';
  assert.equal(evaluateWA(oldVersion).outcome, 'FAIL');
  const noBinding = adapterLifecycle(); delete noBinding.cycles[0].action.observations.importedBinding;
  assert.equal(evaluateWA(noBinding).outcome, 'INCONCLUSIVE');
  assert.ok(evaluateWA(noBinding).missing.includes('WA-actual-eligible-imported-version-binding'));
});

test('H WA caller flags and serialized approvals cannot replace retained replay authority in either profile', () => {
  for (const profile of ['P-A', 'Q3-A']) {
    const value = adapterLifecycle(); value.profile = profile;
    for (const cycle of value.cycles) cycle.action.observations.browserWA = {
      kind: 'retained-wa-browser-observation-1', verified: true, approved: true,
      analysis: {complete: true, assertions: {noBrowserTensorDecode: true, zeroUnexpectedFetches: true}, missing: [], failures: []},
    };
    const result = evaluateWA(value);
    assert.equal(result.outcome, 'INCONCLUSIVE');
    assert.deepEqual(result.missing, ['WA:noBrowserTensorDecode', 'WA:zeroUnexpectedFetches']);
    assert.deepEqual(evaluateWA(structuredClone(value)).missing, result.missing);
    for (const key of ['noBrowserTensorDecode', 'zeroUnexpectedFetches']) {
      const violated = structuredClone(value); violated.cycles[0].action.assertions[key] = false;
      const unverified = evaluateWA(violated); assert.equal(unverified.outcome, 'INCONCLUSIVE');
      assert.deepEqual(unverified.missing, ['WA:noBrowserTensorDecode', 'WA:zeroUnexpectedFetches']); assert.deepEqual(unverified.failures, []);
    }
  }
});

function backendAdapterLifecycle() {
  const value = adapterLifecycle(); value.sampling.kind = 'attributed-backend-process-and-allocation-ledger';
  const backend = () => ({ resourceScope: 'wa-backend-process-workers-allocations-1', backendRssBytes: 100 * 1024 ** 2, cpuBytes: 10 * 1024 ** 2, unusedHandles: 0,
    browserRssBytes: null, gpuBytes: null, previewCacheBytes: null, textureSide: null, deviceTextureLimit: null, settledBytes: null,
    backendOwnership: { kind: 'wa-backend-owner-evidence-1', processIdentity: value.processIdentity,
      coverage: Object.fromEntries(['processTree', 'workerThreads', 'stagingBuffers', 'hashBuffers', 'headerBuffers', 'configBuffers', 'ioCopies', 'metadataConsumers', 'assetReadHandles', 'proofHandles', 'streamHandles'].map(key => [key, true])),
      evidence: { path: 'backend-owner.json', bytes: 1024, sha256: 'a'.repeat(64) } } });
  value.B0.resources = backend();
  for (const cycle of value.cycles) { cycle.resources = backend(); cycle.resourceSamples = [backend()]; }
  return value;
}

test('C WA applicability comes from the verified backend cell and preserves real CPU/RSS/handle requirements', () => {
  const value = backendAdapterLifecycle(), context = { cell: adapterCell('C') };
  assert.equal(evaluateWA(value, context).outcome, 'PASS');
  assert.deepEqual(evaluateWA(value, context).notApplicableResourceFields, ['browserRssBytes', 'gpuBytes', 'previewCacheBytes', 'textureSide', 'deviceTextureLimit']);
  assert.equal(evaluateWA(value).outcome, 'INCONCLUSIVE');
  assert.ok(evaluateWA(value).missing.includes('complete-resource-ledger-and-process-tree-RSS'));
  assert.equal(evaluateAdapterLifecycle(value).outcome, 'INCONCLUSIVE');
  const wrongHandler = { cell: { ...context.cell, handler: 'browser' } };
  assert.equal(evaluateWA(value, wrongHandler).outcome, 'INCONCLUSIVE');
  const unknown = backendAdapterLifecycle(); unknown.B0.resources.cpuBytes = null; unknown.B0.resources.backendOwnership.coverage.hashBuffers = false;
  assert.equal(evaluateWA(unknown, context).outcome, 'INCONCLUSIVE');
  const fakeZero = backendAdapterLifecycle(); fakeZero.B0.resources.browserRssBytes = 0;
  assert.equal(evaluateWA(fakeZero, context).outcome, 'INCONCLUSIVE');
  const borrowed = backendAdapterLifecycle(); borrowed.B0.resources.backendOwnership.processIdentity = 'other-process';
  assert.equal(evaluateWA(borrowed, context).outcome, 'INCONCLUSIVE');
  const rss = backendAdapterLifecycle(); rss.cycles[0].resourceSamples[0].backendRssBytes = 512 * 1024 ** 2 + 1;
  assert.equal(evaluateWA(rss, context).outcome, 'FAIL');
  const cpu = backendAdapterLifecycle(); cpu.cycles[0].resourceSamples[0].cpuBytes = 512 * 1024 ** 2 + 1;
  assert.equal(evaluateWA(cpu, context).outcome, 'FAIL');
  const leaked = backendAdapterLifecycle(); leaked.cycles[0].resources.unusedHandles = 1;
  assert.equal(evaluateWA(leaked, context).outcome, 'FAIL');
});

const measurementRule = (name, budgetId, unit, ceiling) => ({ name, budgetId, unit, target: ceiling, ceiling });
function measurementCell(value) {
  return { id: `H2/${value.workload}-lifecycle`, host: 'H', handler: 'browser', operation: 'lifecycle.editor', workload: value.workload, kind: 'lifecycle',
    parameters: { cycles: value.profile === 'M' ? 100 : 2, baselineIdleMs: 30000, idleMs: 30000 }, requiredMeasurements: [
      measurementRule('R17BrowserProcessTreeRssBytes', 'R17', 'bytes', 1.5 * 1024 ** 3),
      measurementRule('R17BackendRssBytes', 'R17', 'bytes', 512 * 1024 ** 2),
      measurementRule('R18CpuAllocationBytes', 'R18', 'bytes', 512 * 1024 ** 2),
      measurementRule('R18TextureDeviceOr2048BoundViolations', 'R18', 'violations', 0),
      measurementRule('R19FinalSettledGrowthBytes', 'R19', 'bytes', 8 * 1024 ** 2),
      measurementRule('R19WorstSettledGrowthBytes', 'R19', 'bytes', 8 * 1024 ** 2),
    ] };
}
function sealSampling(value) {
  const samples = [value.B0.resources, ...value.cycles.flatMap(cycle => [...cycle.resourceSamples, cycle.resources])];
  samples.forEach((item, index) => Object.assign(item, { ordinal: index + 1, processIdentity: value.processIdentity }));
  value.B0.resources.observation = { ...value.B0.observation };
  for (const cycle of value.cycles) { cycle.resources.observation = { ...cycle.observation }; cycle.resourceSamples.forEach((item, index) => { item.observation = { startMs: cycle.startMs + index + 1, endMs: cycle.startMs + index + 2 }; }); }
  const keys = ['browserRssBytes', 'backendRssBytes', 'cpuBytes', 'gpuBytes', 'previewCacheBytes'];
  value.sampling = { ...value.sampling, processIdentity: value.processIdentity, counts: { samples: samples.length }, artifact: { path: 'resource-samples.json', bytes: 4096, sha256: value.sampling.sha256 },
    peaks: Object.fromEntries(keys.map(key => [key, samples.every(item => typeof item[key] === 'number') ? Math.max(...samples.map(item => item[key])) : null])),
    peakSamples: Object.fromEntries(keys.map(key => [key, structuredClone(samples.reduce((a, b) => a[key] >= b[key] ? a : b))])),
    textureLimits: { complete: true, observedSamples: samples.length, violations: samples.filter(item => item.textureSide > Math.min(2048, item.deviceTextureLimit)).length, notApplicableSamples: 0 } };
  return value;
}
function sealBackendCpuWindow(value) {
  value.sampling.observationWindow = { id: 'actual-window', scope: 'independent-B0-lifecycle-window', processIdentity: value.processIdentity,
    startObservation: { ...value.B0.observation }, endObservation: { startMs: value.endMs, endMs: value.endMs } };
  value.sampling.allocationPeaks = { cpuBytes: { kind: 'owned-allocation-continuous-peak-1', value: value.sampling.peaks.cpuBytes,
    scope: 'independent-B0-lifecycle-window', processIdentity: value.processIdentity, sharedIdentity: 'actual-shared-atomic-ledger', sequence: 5,
    sourceOrdinal: value.sampling.counts.samples, observation: { startMs: value.endMs, endMs: value.endMs }, windowId: 'actual-window',
    window: { startMonotonicNs: '30000000000', endMonotonicNs: String(value.endMs * 1000000), sealed: true, integrityComplete: true },
    artifact: { ...value.sampling.artifact }, complete: true } };
  return value;
}
const browserCpuGaps = ['app-payload-ownership-incomplete', 'native-image-and-canvas-implementation-overhead', 'native-blob-residency', 'engine-and-dom-allocations', 'renderer-ownership-proof-required'];
function sealBrowserCpuWindow(value, peakBytes = 300 * 1024 ** 2) {
  const sampling = value.sampling, ledgerInstanceId = 'c684aa02-ec45-4ee9-b9c7-1ff624bf65aa';
  const window = { kind: 'combined-cpu-window-1', schemaVersion: 1, ledgerInstanceId, id: 'real-browser-window', ordinal: 1,
    clock: 'browser-performance', clockOriginMs: 1790000000000, startMs: 100, endMs: 90000, peakAtMs: 110,
    startSequence: 10, endSequence: 30, peakSequence: 12, currentBytes: 0, peakBytes,
    ledgerBytesAtPeak: peakBytes - 1024, textBytesAtPeak: 1024, textStartSequence: 2, textEndSequence: 9,
    sealed: true, observationComplete: true, ownerCoverageComplete: false, failures: [], missing: [...browserCpuGaps] };
  const ack = boundary => ({ kind: 'combined-cpu-window-ack-1', schemaVersion: 1, ledgerInstanceId, id: window.id, ordinal: window.ordinal,
    boundary, sequence: boundary === 'begin' ? window.startSequence : window.endSequence, atMs: boundary === 'begin' ? window.startMs : window.endMs,
    clock: window.clock, clockOriginMs: window.clockOriginMs, sealed: boundary === 'end' });
  const beginAck = ack('begin'), endAck = ack('end'), endObservation = { startMs: value.endMs, endMs: value.endMs };
  value.B0.resources.cpuWindowBoundary = 'begin'; value.B0.resources.cpuWindowAck = structuredClone(beginAck);
  sampling.counts.samples++;
  sampling.observationWindow = { scope: 'independent-B0-browser-cpu-window', id: window.id, processIdentity: value.processIdentity, ledgerInstanceId,
    startSourceOrdinal: value.B0.resources.ordinal, endSourceOrdinal: sampling.counts.samples, startObservation: { ...value.B0.resources.observation }, endObservation, beginAck, endAck };
  sampling.allocationPeaks = { cpuBytes: { kind: 'owned-allocation-continuous-peak-1', scope: sampling.observationWindow.scope, value: peakBytes,
    processIdentity: value.processIdentity, sharedIdentity: ledgerInstanceId, sequence: window.endSequence, sourceOrdinal: sampling.counts.samples,
    observation: { ...endObservation }, windowId: window.id, window, ownerCoverageComplete: false, complete: false, artifact: { ...sampling.artifact } } };
  return value;
}
const browserCpuRow = value => deriveLifecycleMeasurements(value, { cell: { ...measurementCell(value), requiredMeasurements: [measurementRule('R18CpuAllocationBytes', 'R18', 'bytes', 512 * 1024 ** 2)] } });

function collectorRow(value, cell, cycle, name, unit, measured) {
  return { name, value: measured, unit, complete: true, method: 'Actual retained collector comparison', evidence: {
    kind: 'lifecycle-measurement-evidence-1', cellId: cell.id, cycleOrdinal: cycle.ordinal, processIdentity: value.processIdentity, fixtureIdentity: value.fixtureIdentity,
    coverage: 'complete-cycle-actions', artifact: { path: `cycle-${cycle.ordinal}-collector.json`, bytes: 512, sha256: 'f'.repeat(64) } } };
}

test('lifecycle registry translation preserves sampled RSS and growth while CPU requires continuous ownership coverage', () => {
  const value = lifecycle(); value.cycles[0].resourceSamples[0].cpuBytes = 200 * 1024 ** 2; value.cycles[0].resources.settledBytes += 2 * 1024 ** 2;
  sealSampling(value); const translated = deriveLifecycleMeasurements(value, { cell: measurementCell(value) });
  assert.deepEqual(translated.unavailable.map(item => item.name), ['R18CpuAllocationBytes']); assert.equal(translated.measurements.length, 5);
  const rows = Object.fromEntries(translated.measurements.map(item => [item.name, item]));
  assert.equal(rows.R18CpuAllocationBytes, undefined); assert.equal(translated.unavailable[0].observedLowerBound, 200 * 1024 ** 2);
  assert.equal(rows.R19WorstSettledGrowthBytes.value, 2 * 1024 ** 2); assert.equal(rows.R19FinalSettledGrowthBytes.value, 0);
  assert.equal(rows.R18TextureDeviceOr2048BoundViolations.value, 0); assert.ok(translated.measurements.every(item => item.complete));
});

test('missing lifecycle peak coverage never passes from a subset but known ceiling failures remain visible', () => {
  const value = sealSampling(lifecycle()), cell = measurementCell(value);
  delete value.sampling.peakSamples.cpuBytes;
  assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.some(item => item.name === 'R18CpuAllocationBytes'), false);
  value.cycles[0].resourceSamples[0].cpuBytes = 512 * 1024 ** 2 + 1; value.sampling.complete = false;
  const failed = deriveLifecycleMeasurements(value, { cell }).measurements.find(item => item.name === 'R18CpuAllocationBytes');
  assert.equal(failed.value, 512 * 1024 ** 2 + 1); assert.equal(failed.lowerBound, true); assert.equal(failed.complete, false);
  const unknown = sealSampling(lifecycle()); unknown.cycles[0].resources.cpuBytes = null;
  assert.equal(deriveLifecycleMeasurements(unknown, { cell }).measurements.some(item => item.name === 'R18CpuAllocationBytes'), false);
  const composite = sealSampling(lifecycle()); composite.sampling.peaks.cpuBytes++;
  assert.equal(deriveLifecycleMeasurements(composite, { cell }).measurements.some(item => item.name === 'R18CpuAllocationBytes'), false);
});

test('clean browser CPU windows retain transient covered peaks without claiming complete ownership', () => {
  const value = sealBrowserCpuWindow(sealSampling(lifecycle()));
  const result = browserCpuRow(value);
  assert.deepEqual(result.measurements, []);
  assert.equal(result.unavailable[0].observedLowerBound, 300 * 1024 ** 2);
  assert.match(result.unavailable[0].reason, /scoped lower bound/);
  assert.equal(value.sampling.allocationPeaks.cpuBytes.window.ownerCoverageComplete, false);
  assert.deepEqual(value.sampling.allocationPeaks.cpuBytes.window.missing, browserCpuGaps);
});

test('a transient continuous browser CPU breach remains a lower-bound failure between ordinary samples', () => {
  const value = sealBrowserCpuWindow(sealSampling(lifecycle()), 512 * 1024 ** 2 + 1);
  value.sampling.complete = false;
  const row = browserCpuRow(value).measurements[0];
  assert.equal(row.value, 512 * 1024 ** 2 + 1); assert.equal(row.lowerBound, true); assert.equal(row.complete, false);
  assert.equal(row.evidence.continuousCpuWindow.sourceOrdinal, value.sampling.counts.samples);
  assert.equal(row.evidence.sampledPeak.cpuBytes, value.sampling.peaks.cpuBytes);
  assert.ok(row.evidence.sampledPeak.cpuBytes < row.value); assert.equal(row.evidence.lifetimePeakIsScored, false);
});

test('browser continuous CPU joins the worker serialized lifecycle identity to the original sampler identity', () => {
  const value = sealBrowserCpuWindow(sealSampling(lifecycle()), 512 * 1024 ** 2 + 1);
  value.processIdentity = JSON.stringify(value.sampling.processIdentity);
  for (const cycle of value.cycles) cycle.processIdentity = value.processIdentity;
  const row = browserCpuRow(value).measurements[0];
  assert.equal(row.value, 512 * 1024 ** 2 + 1); assert.equal(row.lowerBound, true);
  assert.equal(row.evidence.continuousCpuWindow.processIdentity, value.sampling.processIdentity);
});

test('browser CPU peaks reject borrowed identities, malformed sums, missing coverage disclosure and claimed global completeness', () => {
  for (const change of [
    v => { v.sampling.allocationPeaks.cpuBytes.scope = 'fresh-worker-process-lifetime-including-preparation'; },
    v => { v.sampling.allocationPeaks.cpuBytes.windowId = 'borrowed'; },
    v => { v.sampling.allocationPeaks.cpuBytes.sharedIdentity = 'borrowed'; },
    v => { v.sampling.observationWindow.processIdentity = 'borrowed'; },
    v => { v.B0.resources.processIdentity = 'borrowed'; },
    v => { v.sampling.kind = 'attributed-backend-process-and-allocation-ledger'; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.ledgerBytesAtPeak++; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.missing = []; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.ownerCoverageComplete = true; },
    v => { v.sampling.allocationPeaks.cpuBytes.ownerCoverageComplete = true; },
    v => { v.sampling.allocationPeaks.cpuBytes.complete = true; },
    v => { v.sampling.allocationPeaks.cpuBytes.artifact.sha256 = 'f'.repeat(64); },
    v => { v.sampling.allocationPeaks.cpuBytes.sourceOrdinal--; },
    v => { v.sampling.observationWindow.endSourceOrdinal++; },
  ]) {
    const value = sealBrowserCpuWindow(sealSampling(lifecycle()), 512 * 1024 ** 2 + 1); change(value);
    assert.deepEqual(browserCpuRow(value).measurements, []);
  }
});

test('browser CPU windows require exact ACK clocks, sequence continuity and actual B0/end runner brackets', () => {
  for (const change of [
    v => { v.sampling.observationWindow.beginAck.sequence++; },
    v => { v.sampling.observationWindow.endAck.clockOriginMs++; },
    v => { v.sampling.observationWindow.endAck.atMs++; },
    v => { v.sampling.observationWindow.endAck.sealed = false; },
    v => { v.B0.resources.cpuWindowAck.id = 'borrowed'; },
    v => { v.B0.resources.cpuWindowBoundary = null; },
    v => { v.sampling.observationWindow.startObservation.startMs--; },
    v => { v.sampling.observationWindow.endObservation.startMs = v.cycles.at(-1).startMs; },
    v => { v.sampling.observationWindow.endObservation.endMs = v.endMs + 1; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.peakAtMs = 99; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.peakSequence = 31; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.textEndSequence = 1; },
  ]) {
    const value = sealBrowserCpuWindow(sealSampling(lifecycle()), 512 * 1024 ** 2 + 1); change(value);
    assert.deepEqual(browserCpuRow(value).measurements, []);
  }
});

test('missing or fault-disclosed browser CPU endpoints cannot promote a continuous peak', () => {
  for (const change of [
    v => { delete v.sampling.allocationPeaks; },
    v => { v.sampling.observationWindow.endObservation = null; v.sampling.observationWindow.endAck = null; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.sealed = false; },
    v => { v.sampling.observationWindow.endObservation = { startMs: 0, endMs: 0 }; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.observationComplete = false; },
    v => { v.sampling.allocationPeaks.cpuBytes.window.failures = ['text-sequence-discontinuity']; },
  ]) {
    const value = sealBrowserCpuWindow(sealSampling(lifecycle()), 512 * 1024 ** 2 + 1); change(value);
    assert.deepEqual(browserCpuRow(value).measurements, []);
    value.cycles[0].resourceSamples[0].cpuBytes = 512 * 1024 ** 2 + 2;
    const row = browserCpuRow(value).measurements[0]; assert.equal(row.value, 512 * 1024 ** 2 + 2); assert.equal(row.lowerBound, true);
  }
});

test('browser preparation peaks remain diagnostic and absent RSS is never replaced by CPU coverage', () => {
  const value = sealBrowserCpuWindow(sealSampling(lifecycle()));
  const beforeB0 = { ...structuredClone(value.sampling.peakSamples.cpuBytes), observation: { startMs: value.B0.observation.startMs - 2, endMs: value.B0.observation.startMs - 1 }, cpuBytes: 1024 ** 3 };
  value.sampling.peakSamples.cpuBytes = beforeB0; value.sampling.peaks.cpuBytes = beforeB0.cpuBytes;
  assert.deepEqual(browserCpuRow(value).measurements, []);
  for (const sample of [value.B0.resources, ...value.cycles.flatMap(cycle => [...cycle.resourceSamples, cycle.resources])]) sample.browserRssBytes = null;
  value.sampling.peakSamples.browserRssBytes = null; value.sampling.peaks.browserRssBytes = null;
  const rows = deriveLifecycleMeasurements(value, { cell: measurementCell(value) });
  assert.equal(rows.measurements.some(row => row.name === 'R17BrowserProcessTreeRssBytes'), false);
  assert.equal(rows.unavailable.find(row => row.name === 'R17BrowserProcessTreeRssBytes').observedLowerBound, undefined);
});

test('lifecycle growth never relabels an incomplete prefix as final or borrows a different scope', () => {
  const value = sealSampling(lifecycle()), cell = measurementCell(value);
  value.cycles[0].resources.settledBytes += 9 * 1024 ** 2; value.cycles.pop();
  const result = deriveLifecycleMeasurements(value, { cell });
  assert.equal(result.measurements.some(item => item.name === 'R19FinalSettledGrowthBytes'), false);
  assert.equal(result.measurements.find(item => item.name === 'R19WorstSettledGrowthBytes').lowerBound, true);
  assert.equal(deriveLifecycleMeasurements(value, { cell: { ...cell, host: 'C' } }).measurements.length, 0);
});

test('texture violations require actual per-observation counters and cannot combine unrelated maxima', () => {
  const value = sealSampling(lifecycle()), cell = measurementCell(value);
  delete value.sampling.textureLimits;
  assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.some(item => item.name === 'R18TextureDeviceOr2048BoundViolations'), false);
  value.cycles[0].resourceSamples[0].textureSide = 1024; value.cycles[0].resourceSamples[0].deviceTextureLimit = 512;
  const row = deriveLifecycleMeasurements(value, { cell }).measurements.find(item => item.name === 'R18TextureDeviceOr2048BoundViolations');
  assert.equal(row.value, 1); assert.equal(row.lowerBound, true);
});

test('WA backend registry translation derives only applicable observed allocations without fabricated browser rows', () => {
  const value = sealBackendCpuWindow(sealSampling(backendAdapterLifecycle())), cell = adapterCell('C');
  cell.requiredMeasurements = [measurementRule('R17BackendRssBytes', 'R17', 'bytes', 512 * 1024 ** 2), measurementRule('R18CpuAllocationBytes', 'R18', 'bytes', 512 * 1024 ** 2), measurementRule('R18GpuAllocationBytes', 'R18', 'bytes', 384 * 1024 ** 2)];
  const result = deriveLifecycleMeasurements(value, { cell });
  assert.deepEqual(result.measurements.map(item => item.name), ['R17BackendRssBytes', 'R18CpuAllocationBytes']);
  assert.deepEqual(result.unavailable.map(item => item.name), ['R18GpuAllocationBytes']);
  value.B0.resources.backendOwnership.coverage.ioCopies = false;
  assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.length, 0);
});

test('C CPU uses an exact sealed B0 observation window and never treats a preparation lifetime peak as scored', () => {
  const value = sealBackendCpuWindow(sealSampling(backendAdapterLifecycle())), cell = adapterCell('C');
  cell.requiredMeasurements = [measurementRule('R18CpuAllocationBytes', 'R18', 'bytes', 512 * 1024 ** 2)];
  value.sampling.allocationPeaks.cpuBytes.value = 20 * 1024 ** 2;
  const measured = deriveLifecycleMeasurements(value, { cell }).measurements[0];
  assert.equal(measured.value, 20 * 1024 ** 2); assert.equal(measured.complete, true);
  assert.equal(value.cycles[0].resources.cpuBytes, 10 * 1024 ** 2);
  for (const edit of [item => { item.scope = 'fresh-worker-process-lifetime-including-preparation'; }, item => { item.windowId = 'different-window'; }, item => { item.window.sealed = false; }, item => { item.artifact.sha256 = 'f'.repeat(64); }, item => { item.sourceOrdinal = 999; }]) {
    const invalid = structuredClone(value); edit(invalid.sampling.allocationPeaks.cpuBytes);
    invalid.sampling.allocationPeaks.cpuBytes.value = 1024 ** 3;
    assert.equal(deriveLifecycleMeasurements(invalid, { cell }).measurements.length, 0);
  }
  const noWindow = structuredClone(value); delete noWindow.sampling.observationWindow;
  assert.equal(deriveLifecycleMeasurements(noWindow, { cell }).measurements.length, 0);
  noWindow.cycles[0].resourceSamples[0].cpuBytes = 512 * 1024 ** 2 + 1;
  const failure = deriveLifecycleMeasurements(noWindow, { cell }).measurements[0];
  assert.equal(failure.lowerBound, true); assert.equal(failure.value, 512 * 1024 ** 2 + 1);
});

function markActiveOwnedHandles(value) {
  value.unusedHandles = null;
  value.producer = { kind: 'adapter-resource-observation-1', coverage: { handles: false }, handleClassification: {
    kind: 'scoped-handle-classification-1', complete: false, settled: false, retainedHandles: null,
    activeOwners: { mainHandles: 1, workerMethods: 1, assetPreparations: 0, preparationPromises: 0, assetChunkLeases: 1, assetContentReaders: 0 },
    serviceHandles: { main: 1, worker: 0 } } };
  return value;
}
function activeBackendLifecycle() {
  const value = backendAdapterLifecycle();
  for (const cycle of value.cycles) { markActiveOwnedHandles(cycle.resourceSamples[0]); cycle.resourceSamples[0].cpuBytes = 200 * 1024 ** 2; }
  return sealBackendCpuWindow(sealSampling(value));
}
const cpuOnlyCell = () => ({ ...adapterCell('C'), requiredMeasurements: [measurementRule('R18CpuAllocationBytes', 'R18', 'bytes', 512 * 1024 ** 2)] });

test('C active owned handles stay explicitly unknown while complete CPU peaks and settled endpoints remain measurable', () => {
  const value = activeBackendLifecycle(), cell = cpuOnlyCell();
  assert.equal(evaluateWA(value, { cell }).outcome, 'PASS');
  const row = deriveLifecycleMeasurements(value, { cell }).measurements[0];
  assert.equal(row.value, 200 * 1024 ** 2); assert.equal(row.complete, true);
  assert.equal(row.evidence.sampledPeak.unusedHandles, null);
  assert.ok(value.cycles.every(cycle => cycle.resourceSamples[0].unusedHandles === null && cycle.resources.unusedHandles === 0));
  assert.equal(value.B0.resources.unusedHandles, 0);
});

test('unknown active handles require explicit intact active-owner classification rather than an absent field or fake zero', () => {
  for (const mutate of [
    value => { delete value.producer; }, value => { value.unusedHandles = undefined; },
    value => { value.producer.coverage.handles = true; }, value => { value.producer.handleClassification.settled = true; },
    value => { value.producer.handleClassification.complete = true; }, value => { value.producer.handleClassification.retainedHandles = 0; },
    value => { value.producer.handleClassification.activeOwners = Object.fromEntries(Object.keys(value.producer.handleClassification.activeOwners).map(key => [key, 0])); },
    value => { value.producer.handleClassification.activeOwners.mainHandles = -1; }, value => { value.producer.handleClassification.serviceHandles.worker = null; },
    value => { value.backendOwnership.coverage.proofHandles = false; }, value => { value.cpuBytes = null; },
  ]) {
    const value = activeBackendLifecycle(), cell = cpuOnlyCell(); mutate(value.cycles[0].resourceSamples[0]);
    assert.equal(evaluateWA(value, { cell }).outcome, 'INCONCLUSIVE');
    assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.length, 0);
  }
});

test('active classification cannot replace B0 or post-release unused-handle checks or hide a measured breach', () => {
  for (const endpoint of ['baseline', 'settled']) {
    const value = activeBackendLifecycle(), cell = cpuOnlyCell();
    markActiveOwnedHandles(endpoint === 'baseline' ? value.B0.resources : value.cycles[0].resources);
    assert.equal(evaluateWA(value, { cell }).outcome, 'INCONCLUSIVE'); assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.length, 0);
  }
  const leaked = activeBackendLifecycle(); leaked.cycles[0].resources.unusedHandles = 1;
  assert.equal(evaluateWA(leaked, { cell: cpuOnlyCell() }).outcome, 'FAIL');
  const cap = activeBackendLifecycle(); cap.cycles[0].resourceSamples[0].cpuBytes = 512 * 1024 ** 2 + 1;
  assert.equal(evaluateWA(cap, { cell: cpuOnlyCell() }).outcome, 'FAIL');
  assert.equal(deriveLifecycleMeasurements(cap, { cell: cpuOnlyCell() }).measurements[0].lowerBound, true);
  const known = activeBackendLifecycle(), transient = known.cycles[0].resourceSamples[0]; transient.unusedHandles = 3;
  transient.producer.coverage.handles = true; transient.producer.handleClassification.complete = true; transient.producer.handleClassification.settled = true;
  transient.producer.handleClassification.activeOwners = Object.fromEntries(Object.keys(transient.producer.handleClassification.activeOwners).map(key => [key, 0]));
  transient.producer.handleClassification.retainedHandles = 3;
  assert.equal(evaluateWA(known, { cell: cpuOnlyCell() }).outcome, 'PASS', 'An intermediate count is released by the actual end observation and measured deadline');
  assert.equal(transient.unusedHandles, 3, 'The evaluator preserves the known intermediate count instead of rewriting it as zero');
});

test('H browser resource requirements do not inherit the C active-handle applicability exception', () => {
  const value = sealSampling(adapterLifecycle()); markActiveOwnedHandles(value.cycles[0].resourceSamples[0]);
  assert.equal(evaluateWA(value, { cell: adapterCell('H') }).outcome, 'INCONCLUSIVE');
  assert.ok(evaluateWA(value, { cell: adapterCell('H') }).missing.includes('complete-resource-ledger-and-process-tree-RSS'));
  const cell = { ...adapterCell('H'), requiredMeasurements: cpuOnlyCell().requiredMeasurements };
  assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.length, 0);
});

test('metric-specific lifecycle collector rows need every exact cycle and never infer zeros from assertions', () => {
  const value = sealSampling(adapterLifecycle()), cell = adapterCell('H');
  cell.requiredMeasurements = [measurementRule('T05IncompleteOrUnverifiedIdentityAcceptanceCount', 'T05', 'violations', 0), measurementRule('T06UnchangedOwnedAssetFetches', 'T06', 'count', 0)];
  assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.length, 0);
  for (const cycle of value.cycles) cycle.action.measurements = cell.requiredMeasurements.map(rule => collectorRow(value, cell, cycle, rule.name, rule.unit, 0));
  const unverified = deriveLifecycleMeasurements(value, { cell });
  assert.deepEqual(unverified.measurements.map(item => item.name), ['T05IncompleteOrUnverifiedIdentityAcceptanceCount']);
  assert.ok(unverified.unavailable.some(item => item.name === 'T06UnchangedOwnedAssetFetches'));
  value.cycles[1].action.measurements[0].evidence.cellId = 'different-cell';
  assert.deepEqual(deriveLifecycleMeasurements(value, { cell }).measurements, []);
  value.cycles[0].action.measurements[0].value = 1;
  const failed = deriveLifecycleMeasurements(value, { cell }).measurements.find(item => item.name.startsWith('T05'));
  assert.equal(failed.value, 1); assert.equal(failed.lowerBound, true);
  value.cycles[0].action.measurements[1].value = 1;
  const partialFetch = deriveLifecycleMeasurements(value, { cell });
  assert.equal(partialFetch.measurements.some(item => item.name.startsWith('T06')), false);
  assert.deepEqual(partialFetch.unavailable.find(item => item.name === 'T06UnchangedOwnedAssetFetches'), {
    name: 'T06UnchangedOwnedAssetFetches', reason: 'Every planned cycle needs a unique complete metric-specific row with exact cell/process/fixture binding and retained collector proof',
  });
  const duplicate = value.cycles[0].action.measurements[1]; value.cycles[0].action.measurements.push(structuredClone(duplicate));
  assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.some(item => item.name.startsWith('T06')), false);
});

test('H WA network zeros and positive counts cannot borrow serialized approval from another cohort', () => {
  for (const profile of ['P-A', 'Q3-A']) for (const measured of [0, 1]) for (const complete of [true, false]) {
    const value = sealSampling(adapterLifecycle()); value.profile = profile; const cell = adapterCell('H', profile);
    cell.requiredMeasurements = [measurementRule('T06UnchangedOwnedAssetFetches', 'T06', 'count', 0), measurementRule('R32UnchangedOwnedAssetFetches', 'R32', 'count', 0), measurementRule('R32CacheIdentityMismatchCount', 'R32', 'violations', 0)];
    for (const cycle of value.cycles) {
      cycle.action.measurements = cell.requiredMeasurements.map(rule => {
        const row = collectorRow(value, cell, cycle, rule.name, rule.unit, measured); row.complete = complete;
        row.evidence.coverage = complete ? 'complete-cycle-actions' : 'observed-partial-cycle-actions'; return row;
      });
      // Collector rows have the current cohort's structural binding. The
      // fabricated public approval belongs to another cohort and supplies no
      // private retained replay, even when its claimed count exceeds a cap.
      cycle.action.observations.browserWA = { kind: 'retained-wa-browser-observation-1', verified: true, approved: true,
        scope: 'reviewed-selected-file-opaque-upload-and-owned-application-http-1', artifact: {path: 'borrowed-other-cohort.json', bytes: 1024, sha256: 'sha256:' + 'a'.repeat(64)},
        binding: {cellId: cell.id + '-other-cohort', cycle: cycle.ordinal, processIdentity: 'other-process', fixtureIdentity: 'other-fixture'},
        analysis: {authenticated: true, complete, assertions: {noBrowserTensorDecode: measured === 0, zeroUnexpectedFetches: measured === 0}, missing: [], failures: measured ? ['unexpected-owned-asset-fetch'] : [],
          measurements: cycle.action.measurements.map(({name, value, unit, complete}) => ({name, value, unit, complete}))} };
    }
    for (const input of [value, structuredClone(value)]) {
      const evaluated = evaluateWA(input, {cell}); assert.equal(evaluated.outcome, 'INCONCLUSIVE'); assert.deepEqual(evaluated.failures, []);
      assert.deepEqual(evaluated.missing, ['WA:noBrowserTensorDecode', 'WA:zeroUnexpectedFetches']);
      const derived = deriveLifecycleMeasurements(input, {cell}); assert.deepEqual(derived.measurements, []);
      assert.deepEqual(derived.unavailable, cell.requiredMeasurements.map(({name}) => ({name,
        reason: 'Every planned cycle needs a unique complete metric-specific row with exact cell/process/fixture binding and retained collector proof'})));
    }
  }
});

test('partial lifecycle collectors retain witnessed ceiling breaches without turning partial zero into a pass', () => {
  const value = sealSampling(lifecycle()), cell = measurementCell(value);
  cell.requiredMeasurements = [measurementRule('R21CommandUtf8Bytes', 'R21', 'bytes', 64 * 1024)];
  for (const cycle of value.cycles) {
    const row = collectorRow(value, cell, cycle, 'R21CommandUtf8Bytes', 'bytes', 0);
    row.complete = false; row.evidence.coverage = 'observed-partial-cycle-actions'; cycle.action.measurements = [row];
  }
  assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.length, 0);
  value.cycles[0].action.measurements[0].value = 64 * 1024 + 1;
  const row = deriveLifecycleMeasurements(value, { cell }).measurements[0];
  assert.equal(row.value, 64 * 1024 + 1); assert.equal(row.lowerBound, true); assert.equal(row.complete, false);
  value.cycles[0].action.measurements[0].complete = true;
  assert.equal(deriveLifecycleMeasurements(value, { cell }).measurements.length, 0);
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

function sealAppOwnedWindow({ cpuPeak = 300 * 1024 ** 2, gpuPeak = 100 * 1024 ** 2, previewPeak = 10 * 1024 ** 2 } = {}) {
  const value = sealBrowserCpuWindow(sealSampling(lifecycle()), cpuPeak), sampling = value.sampling;
  const endWindow = sampling.allocationPeaks.cpuBytes.window;
  endWindow.currentBytes = 4;
  const beginWindow = { ...structuredClone(endWindow), endMs: null, endSequence: null, textEndSequence: null, sealed: false,
    currentBytes: value.B0.resources.cpuBytes, peakBytes: value.B0.resources.cpuBytes, ledgerBytesAtPeak: value.B0.resources.cpuBytes - 4,
    textBytesAtPeak: 4, peakAtMs: endWindow.startMs + 1, peakSequence: endWindow.startSequence + 1 };
  const combined = window => ({ kind: 'combined-cpu-observation-1', schemaVersion: 1, scope: 'browser-ledger-plus-text-reservations',
    ledgerInstanceId: window.ledgerInstanceId, sequence: window.endSequence ?? window.peakSequence, currentBytes: window.currentBytes,
    observedPeakBytes: 2 * 1024 ** 3, observationComplete: false, ownerCoverageComplete: false, missing: [...browserCpuGaps], window });
  const begin = value.B0.resources;
  begin.kind = 'manual'; begin.combinedCpu = combined(beginWindow); begin.rendererOwnershipProof = null;
  const initialCpuBytes = begin.cpuBytes - 16;
  begin.appOwnership = appOwnershipSpecimen(begin.combinedCpu, { initialCpuBytes, transitionCount: 1,
    gpuBytes: begin.gpuBytes, previewCacheBytes: begin.previewCacheBytes });
  const end = { kind: 'final', ordinal: sampling.counts.samples, processIdentity: sampling.processIdentity,
    observation: sampling.observationWindow.endObservation, combinedCpu: combined(structuredClone(endWindow)),
    rendererOwnershipProof: null, cpuWindowBoundary: 'end', cpuWindowAck: sampling.observationWindow.endAck };
  end.appOwnership = appOwnershipSpecimen(end.combinedCpu, { initialCpuBytes, transitionCount: 3,
    gpuBytes: begin.gpuBytes, previewCacheBytes: begin.previewCacheBytes, gpuPeak, previewPeak });
  const candidate = appOwnedCpuCandidate(begin, end, sampling.processIdentity, sampling.observationWindow);
  assert(candidate, 'The fabricated fixture must satisfy the structural join, without approving it');
  sampling.appOwnedCpu = { ...structuredClone(candidate), artifact: { ...sampling.artifact } };
  sampling.complete = false;
  return value;
}
const appOwnedRows = value => deriveLifecycleMeasurements(value, { cell: { ...measurementCell(value), requiredMeasurements: [
  measurementRule('R18CpuAllocationBytes', 'R18', 'bytes', 512 * 1024 ** 2),
  measurementRule('R18GpuAllocationBytes', 'R18', 'bytes', 384 * 1024 ** 2),
  measurementRule('R18PreviewCacheBytes', 'R18', 'bytes', 128 * 1024 ** 2),
] } });

test('unsigned app-owned CPU/GPU/cache windows stay inconclusive without global or RSS promotion', () => {
  const value = sealAppOwnedWindow(), result = appOwnedRows(value);
  assert.deepEqual(result.measurements, []);
  assert.deepEqual(result.unavailable.map(row => row.name), ['R18CpuAllocationBytes', 'R18GpuAllocationBytes', 'R18PreviewCacheBytes']);
  assert.equal(value.sampling.appOwnedCpu.complete, false); assert.equal(value.sampling.complete, false);
  assert.equal(value.sampling.appOwnedCpu.end.appOwnership.window.globalCoverageComplete, false);
  const rss = deriveLifecycleMeasurements(value, { cell: measurementCell(value) });
  assert.equal(rss.measurements.some(row => row.name === 'R17BrowserProcessTreeRssBytes'), false);
});

test('exact R18 ceilings remain incomplete while genuine observed plus-one breaches remain failures', () => {
  const caps = { cpuPeak: 512 * 1024 ** 2, gpuPeak: 384 * 1024 ** 2, previewPeak: 128 * 1024 ** 2 };
  assert.deepEqual(appOwnedRows(sealAppOwnedWindow(caps)).measurements, []);
  for (const [key, name] of [['cpuPeak', 'R18CpuAllocationBytes'], ['gpuPeak', 'R18GpuAllocationBytes'], ['previewPeak', 'R18PreviewCacheBytes']]) {
    const result = appOwnedRows(sealAppOwnedWindow({ ...caps, [key]: caps[key] + 1 }));
    assert.deepEqual(result.measurements.map(row => row.name), [name]);
    assert.equal(result.measurements[0].value, caps[key] + 1);
    assert.equal(result.measurements[0].complete, false); assert.equal(result.measurements[0].lowerBound, true);
  }
});

test('caller approval flags, unknown proof and altered app seals cannot approve under-cap rows', () => {
  for (const mutate of [
    value => { value.sampling.appOwnedCpu.complete = true; },
    value => { value.sampling.appOwnedCpu.artifact.sha256 = 'e'.repeat(64); },
    value => { value.sampling.appOwnedCpu.rendererOwnershipProof = { kind: 'renderer-ownership-proof-2', reviewId: 'not-a-fixed-review' }; },
    value => { value.sampling.appOwnedCpu.end.appOwnership.window.kinds[0].kind = 'unreviewed-kind'; },
    value => { value.sampling.appOwnedCpu.startSourceOrdinal++; },
  ]) {
    const value = sealAppOwnedWindow(); mutate(value);
    assert.deepEqual(appOwnedRows(value).measurements, []);
  }
});

test('invalid app-owned closure cannot erase the existing genuine continuous CPU breach', () => {
  const value = sealAppOwnedWindow({ cpuPeak: 600 * 1024 ** 2 });
  value.sampling.appOwnedCpu.end.appOwnership.point.totals.cpuBytes++;
  const row = appOwnedRows(value).measurements.find(item => item.name === 'R18CpuAllocationBytes');
  assert.equal(row.value, 600 * 1024 ** 2); assert.equal(row.lowerBound, true); assert.equal(row.complete, false);
});

test('a failed final planned cycle cannot turn a full ordinal count into complete app observations', () => {
  const value = sealAppOwnedWindow({ cpuPeak: 600 * 1024 ** 2 }), last = value.cycles.at(-1);
  last.error = { name: 'Error', message: 'Actual final cycle interrupted before its observation' };
  last.resources = null; last.resourceSamples = [];
  const row = appOwnedRows(value).measurements.find(item => item.name === 'R18CpuAllocationBytes');
  assert.equal(value.cycles.length, 2);
  assert.equal(row.value, 600 * 1024 ** 2); assert.equal(row.lowerBound, true); assert.equal(row.complete, false);
});

test('GPU/cache preparation maxima remain diagnostic while actual in-window breaches still fail', () => {
  for (const [key, name, cap] of [['gpuBytes', 'R18GpuAllocationBytes', 384 * 1024 ** 2], ['previewCacheBytes', 'R18PreviewCacheBytes', 128 * 1024 ** 2]]) {
    const value = sealAppOwnedWindow();
    value.sampling.peakSamples[key] = { ...structuredClone(value.B0.resources), [key]: cap + 1,
      observation: { startMs: value.B0.observation.startMs - 2, endMs: value.B0.observation.startMs - 1 } };
    value.sampling.peaks[key] = cap + 1;
    assert.equal(appOwnedRows(value).measurements.some(row => row.name === name), false);
    value.cycles[0].resourceSamples[0][key] = cap + 2;
    const row = appOwnedRows(value).measurements.find(row => row.name === name);
    assert.equal(row.value, cap + 2); assert.equal(row.lowerBound, true); assert.equal(row.complete, false);
  }
});

test('final live-point allocations after sealing do not replace the scoped continuous maximum', () => {
  for (const [key, name, cap] of [['cpuBytes', 'R18CpuAllocationBytes', 512 * 1024 ** 2], ['gpuBytes', 'R18GpuAllocationBytes', 384 * 1024 ** 2], ['previewCacheBytes', 'R18PreviewCacheBytes', 128 * 1024 ** 2]]) {
    const value = sealAppOwnedWindow(), end = value.sampling.appOwnedCpu;
    value.sampling.peakSamples[key] = { ...structuredClone(value.B0.resources), ordinal: end.endSourceOrdinal,
      observation: structuredClone(end.endObservation), [key]: cap + 1 };
    value.sampling.peaks[key] = cap + 1;
    assert.equal(appOwnedRows(value).measurements.some(row => row.name === name), false);
  }
});

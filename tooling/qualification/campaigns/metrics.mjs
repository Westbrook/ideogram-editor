// PERF-8 session/resource/finalized-visit arithmetic. Collection and artifact
// authenticity belong to the runner; these helpers never certify a host.
import { nearestRank } from '../statistics.mjs';
import { isRendererTextureNotApplicable } from './renderer-ownership.mjs';

const MiB = 1024 ** 2, GiB = 1024 ** 3, slotMs = 1000 / 60;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hash = value => typeof value === 'string' && /^(sha256:)?[a-f0-9]{64}$/.test(value);
const unique = values => new Set(values).size === values.length;
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) < 0.01;
function result(kind, fail, missing, values) {
  return { kind, outcome: fail.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS', qualification: false,
    failures: [...new Set(fail)], missing: [...new Set(missing)], ...values };
}
function exact(condition, missing, reason) { if (!condition) missing.push(reason); }
function violation(condition, fail, reason) { if (condition) fail.push(reason); }
function observedOutcome(value, fail, missing, label) {
  if (value.outcome === 'infra-invalid' && value.infraEvidence) missing.push(`${label}:documented-infrastructure-invalidation`);
  else violation(value.outcome !== undefined && value.outcome !== 'expected', fail, `${label}:unexpected-outcome`);
  violation(value.correctnessViolation === true || value.capViolation === true, fail, `${label}:correctness-or-cap-violation`);
}
function sample(values) { return values.length ? { n: values.length, p95: nearestRank(values, .95), max: Math.max(...values) } : { n: 0, p95: null, max: null }; }

/** Clip and union nested app main-thread intervals inside one display slot.
 * Waiting/worker/GPU lanes are not main-thread work and must be separate input.
 */
export function unionWork(intervals, startMs, endMs) {
  return mergedWork(intervals, startMs, endMs).reduce((total, [start, end]) => total + end - start, 0);
}
function mergedWork(intervals, startMs, endMs) {
  if (!finite(startMs) || !finite(endMs) || endMs <= startMs || !Array.isArray(intervals)) throw Error('Invalid frame interval');
  const clipped = intervals.map(interval => {
    if (!finite(interval.startMs) || !finite(interval.endMs) || interval.endMs < interval.startMs) throw Error('Invalid app work interval');
    return [Math.max(startMs, interval.startMs), Math.min(endMs, interval.endMs)];
  }).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, stop] of clipped) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], stop);
    else merged.push([start, stop]);
  }
  return merged;
}

/** One exact 60-second segment. Null/missing presentation timestamps remain
 * unavailable; DOM mutation, rAF and render submission do not qualify as paint.
 * actions: {id,kind,inputMs,presentedMs,meaningful,samples?}; stroke samples have
 * {id,inputMs,presentedMs}. Frame slots are actual trace-backed observations.
 */
export function evaluateSession(session, protocol = 'I') {
  if (!['I', 'IText'].includes(protocol)) throw Error('Unknown interaction protocol');
  const fail = [], missing = [], actions = session.actions ?? [], segments = session.activeSegments ?? [];
  exact(finite(session.startMs) && close(session.endMs - session.startMs, 60_000), missing, 'exact-60-second-session');
  exact(session.visibility === 'visible' && session.refreshHz === 60, missing, 'visible-60Hz-display');
  const trace = session.trace;
  exact(trace?.kind === 'browser-presentation-trace' && hash(trace.sha256) && trace.attributionComplete === true, missing, 'validated-presentation-and-app-attribution-trace');
  if (session.outcome && session.outcome !== 'expected') {
    if (session.outcome === 'infra-invalid' && session.infraEvidence) missing.push('documented-infrastructure-invalidation');
    else fail.push('unexpected-session-outcome');
  }
  violation(session.correctnessViolation === true, fail, 'session-correctness');
  violation(session.capViolation === true, fail, 'session-resource-cap');
  const kinds = protocol === 'I' ? { stroke: 20, discrete: 80 } : { 'insert-delete': 40, preedit: 20, 'composition-end': 10, caret: 10, 'semantic-selection': 10, 'text-format': 10, presentation: 6 };
  exact(Array.isArray(actions) && actions.length === (protocol === 'I' ? 100 : 106) && unique(actions.map(action => action.id)) && actions.every(action => typeof action.id === 'string' && action.id), missing, 'exact-unique-action-inventory');
  for (const [kind, count] of Object.entries(kinds)) exact(actions.filter(action => action.kind === kind).length === count, missing, `action-count:${kind}`);
  exact(actions.every(action => Object.hasOwn(kinds, action.kind)), missing, 'unknown-action-kind');
  const acknowledgement = [], pointer = [], nativeIntervals = [], dispatchLateness = [], dispatchDurations = [];
  let observedSchedules = 0;
  for (const action of actions) {
    if (action.outcome === 'infra-invalid' && action.infraEvidence) missing.push('documented-action-infrastructure-invalidation');
    else violation(action.outcome !== undefined && action.outcome !== 'expected', fail, 'unexpected-action-outcome');
    violation(action.correctnessViolation === true || action.capViolation === true, fail, 'action-correctness-or-cap-violation');
    exact(finite(action.inputMs) && action.inputMs >= session.startMs && action.inputMs <= session.endMs, missing, 'action-in-session');
    if (finite(action.presentedMs) && action.presentedMs >= action.inputMs && action.meaningful === true) {
      acknowledgement.push(action.presentedMs - action.inputMs);
      violation(action.presentedMs - action.inputMs > 100, fail, 'R04-acknowledgement-over-100ms');
      violation(action.presentedMs > session.endMs, fail, 'action-finishes-outside-sixty-second-segment');
    } else missing.push('meaningful-presented-acknowledgement');
    if (action.kind === 'stroke') {
      const points = action.samples ?? [];
      exact(points.length === 120 && unique(points.map(point => point.id)) && points.every(point => typeof point.id === 'string' && !!point.id.trim()), missing, 'stroke-120-distinct-pointer-samples');
      const schedule = action.pointerSchedule, dispatches = schedule?.samples ?? [];
      exact(schedule?.clock === 'runner-monotonic' && schedule?.frequencyHz === 60 && Array.isArray(dispatches) && dispatches.length === 120, missing, 'pointer-60Hz-dispatch-schedule');
      if (schedule?.clock === 'runner-monotonic' && schedule?.frequencyHz === 60 && dispatches.length === 120) observedSchedules++;
      for (let index = 0; index < dispatches.length; index++) {
        const dispatch = dispatches[index];
        exact(dispatch.index === index && finite(dispatch.scheduledMs) && (index === 0 || close(dispatch.scheduledMs - dispatches[index - 1].scheduledMs, slotMs)), missing, 'pointer-exact-60Hz-requested-cadence');
        const valid = finite(dispatch.scheduledMs) && finite(dispatch.dispatchStartedMs) && finite(dispatch.dispatchCompletedMs) && dispatch.dispatchStartedMs >= dispatch.scheduledMs && dispatch.dispatchCompletedMs >= dispatch.dispatchStartedMs && (!index || dispatch.dispatchStartedMs >= dispatches[index - 1].dispatchCompletedMs);
        exact(valid, missing, 'ordered-actual-pointer-dispatch-observations');
        if (valid) { dispatchLateness.push(dispatch.dispatchStartedMs - dispatch.scheduledMs); dispatchDurations.push(dispatch.dispatchCompletedMs - dispatch.dispatchStartedMs); }
      }
      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        observedOutcome(point, fail, missing, 'pointer');
        exact(finite(point.inputMs) && point.inputMs >= session.startMs && point.inputMs <= session.endMs, missing, 'pointer-input-in-session');
        if (index) {
          const interval = point.inputMs - points[index - 1].inputMs;
          exact(finite(interval), missing, 'ordered-actual-native-pointer-inputs');
          if (finite(interval)) nativeIntervals.push(interval);
        }
        if (finite(point.presentedMs) && point.presentedMs >= point.inputMs) { pointer.push(point.presentedMs - point.inputMs); violation(point.presentedMs > session.endMs, fail, 'pointer-finishes-outside-sixty-second-segment'); }
        else missing.push('pointer-actual-presentation');
      }
    }
  }
  const allPointerIds = actions.flatMap(action => action.samples ?? []).map(point => point.id);
  exact(unique(allPointerIds), missing, 'distinct-pointer-event-identities');
  if (protocol === 'IText') {
    const checks = session.textPresentation;
    for (const key of ['sameConnectedNode', 'forwardRangePreserved', 'backwardRangePreserved', 'collapsedRangePreserved', 'latestDeferredOnlyAfterNativeEnd', 'cancelDropsDeferred', 'staleSessionGenerationVersionRejected']) {
      exact(checks?.[key] === true, missing, `IText:${key}`);
      violation(checks?.[key] === false, fail, `IText:${key}`);
    }
  }
  const work = [], frameSegments = [], stalls = [];
  let expectedSlots = 0, missedSlots = 0, missedRun = 0, completeSlots = true;
  exact(segments.length > 0, missing, 'active-frame-segments');
  for (const action of actions) for (const point of [action, ...(action.samples ?? [])]) exact(segments.some(segment => point.inputMs >= segment.startMs && point.inputMs < segment.endMs), missing, 'active-input-covered-by-frame-trace');
  let previousEnd = session.startMs;
  for (const segment of segments) {
    const validRange = finite(segment.startMs) && finite(segment.endMs) && segment.endMs > segment.startMs && segment.startMs >= session.startMs && segment.endMs <= session.endMs && segment.startMs >= previousEnd;
    exact(validRange, missing, 'ordered-active-segments-in-session'); if (!validRange) { completeSlots = false; continue; }
    if (segment.startMs > previousEnd) { if (missedRun * slotMs >= 100 - .01) stalls.push(missedRun * slotMs); missedRun = 0; }
    previousEnd = segment.endMs;
    const count = Math.round((segment.endMs - segment.startMs) / slotMs), slots = segment.slots ?? [];
    exact(count > 0 && close(segment.endMs - segment.startMs, count * slotMs), missing, 'whole-60Hz-active-slots');
    exact(slots.length === count && unique(slots.map(slot => slot.index)) && slots.every((slot, index) => slot.index === index && typeof slot.presented === 'boolean'), missing, 'complete-ordered-display-slot-observations');
    exact(Array.isArray(segment.mainThreadIntervals), missing, 'main-thread-work-trace');
    if (!Array.isArray(segment.mainThreadIntervals)) { completeSlots = false; continue; }
    const intervals = mergedWork(segment.mainThreadIntervals, segment.startMs, segment.endMs);
    let missed = 0, cursor = 0;
    const segmentWork = [];
    for (let index = 0; index < count; index++) {
      const start = segment.startMs + index * slotMs, end = segment.startMs + (index + 1) * slotMs;
      while (cursor < intervals.length && intervals[cursor][1] <= start) cursor++;
      let total = 0;
      for (let next = cursor; next < intervals.length && intervals[next][0] < end; next++) total += Math.max(0, Math.min(end, intervals[next][1]) - Math.max(start, intervals[next][0]));
      work.push(total); segmentWork.push(total);
      if (slots[index]?.presented === false) { missed++; missedRun++; }
      else { if (missedRun * slotMs >= 100 - .01) stalls.push(missedRun * slotMs); missedRun = 0; }
    }
    const observed = slots.length === count && slots.every((slot, index) => slot.index === index && typeof slot.presented === 'boolean');
    completeSlots &&= observed; expectedSlots += count; missedSlots += missed;
    frameSegments.push({ startMs: segment.startMs, endMs: segment.endMs, work: sample(segmentWork), expectedSlots: count, missedSlots: observed ? missed : null });
  }
  if (missedRun * slotMs >= 100 - .01) stalls.push(missedRun * slotMs);
  const workStats = sample(work), pointerStats = sample(pointer), ackStats = sample(acknowledgement);
  const droppedShare = completeSlots && expectedSlots ? missedSlots / expectedSlots : null;
  violation(workStats.max > 10, fail, 'R07-main-thread-slot-over-10ms');
  violation(pointerStats.p95 > 33.4, fail, 'R07-pointer-p95-over-33.4ms');
  violation(droppedShare > .05, fail, 'R07-dropped-slots-over-five-percent');
  const slices = { active: [], inactive: [] };
  for (const slice of session.fallbackSlices ?? []) {
    exact(finite(slice.startMs) && finite(slice.endMs) && slice.endMs >= slice.startMs && typeof slice.active === 'boolean', missing, 'fallback-slice-trace');
    exact(slice.startMs >= session.startMs && slice.endMs <= session.endMs, missing, 'fallback-slice-inside-session');
    if (!finite(slice.startMs) || !finite(slice.endMs) || slice.endMs < slice.startMs) continue;
    const elapsed = slice.endMs - slice.startMs; slices[slice.active ? 'active' : 'inactive'].push(elapsed);
    violation(elapsed > (slice.active ? 6 : 16), fail, 'R08-cooperative-slice-ceiling');
  }
  if (session.fallbackRequired) exact((session.fallbackSlices ?? []).length > 0, missing, 'required-fallback-slices');
  return result('perf-interaction-session-1', fail, missing, { protocol, actions: actions.length, acknowledgements: ackStats, pointer: pointerStats, pointerCadence: { requestedHz: 60, observedSchedules, actualNativeIntervals: sample(nativeIntervals), dispatchLateness: sample(dispatchLateness), dispatchDurations: sample(dispatchDurations), scope: 'Requested cadence and observed timing are separate; no jitter tolerance is invented and runner/browser clocks are never subtracted.' }, frameWork: { ...workStats, pooledDiagnostic: true }, frameSegments, droppedShare60SecondSession: droppedShare, expectedActiveSlots: expectedSlots, missedActiveSlots: completeSlots ? missedSlots : null, stallsAtLeast100ms: stalls, fallback: { active: sample(slices.active), inactive: sample(slices.inactive) }, targetMisses: { acknowledgement: ackStats.max > 50, frameWork: frameSegments.some(segment => segment.work.p95 > 8), pointer: pointerStats.p95 > 16.7, droppedSlots: droppedShare > .01, activeSlice: sample(slices.active).p95 > 4, inactiveSlice: sample(slices.inactive).p95 > 8 } });
}

/** Standalone first-use sibling of P-I. Reset/ready/ack clocks require the
 * actual one-second observation window and validated presentation trace. */
export function evaluateFirstUse(firstUse = []) {
  const fail = [], missing = [];
  exact(firstUse.length === 10 && firstUse.every(value => typeof value.id === 'string' && !!value.id.trim()) && unique(firstUse.map(value => value.id)), missing, 'ten-first-use-windows');
  for (const value of firstUse) {
    observedOutcome(value, fail, missing, 'first-use');
    exact(value.reset === true && close(value.endMs - value.startMs, 1000), missing, 'reset-one-second-first-use-window');
    exact(finite(value.startMs) && finite(value.inputMs) && value.inputMs >= value.startMs && value.inputMs <= value.endMs && finite(value.readyMs) && value.readyMs >= value.inputMs && value.readyMs <= value.endMs && finite(value.presentedMs) && value.presentedMs <= value.endMs, missing, 'first-use-observations-inside-reset-window');
    exact(value.trace?.kind === 'browser-presentation-trace' && hash(value.trace.sha256) && value.trace.attributionComplete === true, missing, 'first-use-presentation-trace');
    if (finite(value.presentedMs) && finite(value.inputMs) && value.presentedMs >= value.inputMs && value.meaningful === true) violation(value.presentedMs - value.inputMs > 100, fail, 'R04-first-use-acknowledgement');
    else missing.push('first-use-presentation');
    if (finite(value.readyMs)) violation(value.readyMs - value.inputMs > 750, fail, 'R06-lazy-readiness'); else missing.push('first-use-complete-readiness');
  }
  const ready = firstUse.filter(value => finite(value.readyMs) && finite(value.inputMs) && value.readyMs >= value.inputMs).map(value => value.readyMs - value.inputMs);
  const acknowledgement = firstUse.filter(value => finite(value.presentedMs) && finite(value.inputMs) && value.presentedMs >= value.inputMs).map(value => value.presentedMs - value.inputMs);
  return result('perf-first-use-1', fail, missing, { windows: firstUse.length, readiness: sample(ready), acknowledgements: sample(acknowledgement) });
}

/** D05 can be evaluated independently of I. P uses three warm edits; Q3 uses
 * ten cold and ten warm starts with independently retained cache ordinals. */
export function evaluateHotEdit(hotEdits = [], { profile = 'P' } = {}) {
  if (!['P', 'Q3'].includes(profile)) throw Error('Unknown hot-edit profile');
  const fail = [], missing = [];
  exact(hotEdits.every(value => typeof value.id === 'string' && !!value.id.trim()) && unique(hotEdits.map(value => value.id)), missing, 'unique-hot-edit-identities');
  if (profile === 'P') exact(hotEdits.length === 3 && hotEdits.every(value => value.cache === undefined || value.cache === 'warm'), missing, 'three-warm-hot-edits');
  else {
    const expected = ['cold', 'warm'].flatMap(cache => Array.from({ length: 10 }, (_, index) => `${cache}:${index + 1}`));
    const actual = hotEdits.map(value => `${value.cache}:${value.ordinal}`);
    exact(actual.length === expected.length && unique(actual) && expected.every(key => actual.includes(key)), missing, 'ten-cold-and-ten-warm-hot-edits');
  }
  for (const value of hotEdits) {
    observedOutcome(value, fail, missing, 'hot-update');
    exact(value.documentPreserved === true && value.reload === false, missing, 'hot-update-preserves-document');
    violation(value.documentPreserved === false || value.reload === true, fail, 'hot-update-lost-document-or-reloaded');
    exact(value.trace?.kind === 'browser-presentation-trace' && hash(value.trace.sha256) && value.trace.attributionComplete === true, missing, 'hot-update-presentation-trace');
    if (finite(value.savedMs) && finite(value.presentedMs) && value.presentedMs >= value.savedMs) violation(value.presentedMs - value.savedMs > 500, fail, 'D05-hot-update-over-500ms'); else missing.push('hot-update-presented-completion');
  }
  const elapsed = hotEdits.filter(value => finite(value.savedMs) && finite(value.presentedMs) && value.presentedMs >= value.savedMs).map(value => value.presentedMs - value.savedMs);
  return result('perf-hot-edit-1', fail, missing, { profile, edits: hotEdits.length, elapsed: { ...sample(elapsed), pooledDiagnostic: true }, caches: Object.fromEntries((profile === 'P' ? ['warm'] : ['cold', 'warm']).map(cache => [cache, sample(hotEdits.filter(value => (value.cache ?? 'warm') === cache && finite(value.savedMs) && finite(value.presentedMs) && value.presentedMs >= value.savedMs).map(value => value.presentedMs - value.savedMs))])), targetMissed: elapsed.some(value => value > 200) });
}

export function evaluateInteraction({ profile, protocol = 'I', cohortKey, sessions = [], firstUse = [], hotEdits = [] }) {
  if (!['P', 'Q3'].includes(profile) || typeof cohortKey !== 'string' || !cohortKey) throw Error('Declare P/Q3 and a sealed cohort key');
  const fail = [], missing = [], expected = profile === 'P' ? ['warm:1'] : ['cold:1', ...Array.from({ length: 5 }, (_, index) => `warm:${index + 1}`)];
  const actual = sessions.map(session => `${session.cache}:${session.ordinal}`);
  exact(sessions.every(session => typeof session.id === 'string' && !!session.id.trim()) && unique(sessions.map(session => session.id)) && actual.length === expected.length && unique(actual) && expected.every(key => actual.includes(key)), missing, 'exact-I-session-inventory');
  exact(sessions.every(session => session.cohortKey === cohortKey), missing, 'single-sealed-cohort');
  const evaluations = sessions.map(session => evaluateSession(session, protocol));
  for (const entry of evaluations) { fail.push(...entry.failures); missing.push(...entry.missing); }
  if (profile === 'P' && protocol === 'I') {
    for (const entry of [evaluateFirstUse(firstUse), evaluateHotEdit(hotEdits)]) { fail.push(...entry.failures); missing.push(...entry.missing); }
  }
  const pointerValues = evaluations.map(entry => entry.pointer.p95).filter(finite);
  return result('perf-interaction-cohort-1', fail, missing, { profile, protocol, cohortKey, sessions: evaluations, worstSessionPointerP95: pointerValues.length ? Math.max(...pointerValues) : null, note: 'R02 INP is evaluated separately from finalized visits, never from these interaction samples.' });
}

const resourceKeys = ['browserRssBytes', 'backendRssBytes', 'cpuBytes', 'gpuBytes', 'previewCacheBytes', 'settledBytes', 'unusedHandles'];
function resourceCheck(value, workload, fail, missing) {
  exact(value && resourceKeys.every(key => finite(value[key])), missing, 'complete-resource-ledger-and-process-tree-RSS');
  if (!value) return;
  const caps = { browserRssBytes: ['W2', 'WXs'].includes(workload) ? 2 * GiB : 1.5 * GiB, backendRssBytes: 512 * MiB, cpuBytes: 512 * MiB, gpuBytes: 384 * MiB, previewCacheBytes: 128 * MiB };
  for (const [key, cap] of Object.entries(caps)) violation(value[key] > cap, fail, `resource-ceiling:${key}`);
  const textureNotApplicable = value.rendererOwnership?.textureLimitApplicability === 'not-applicable';
  if (textureNotApplicable) exact(isRendererTextureNotApplicable(value.rendererOwnership, value.rendererOwnershipProof, { gpuBytes: value.gpuBytes }) && value.textureSide === null && value.deviceTextureLimit === null, missing, 'reviewed-renderer-texture-not-applicable-proof');
  else exact(finite(value.textureSide) && finite(value.deviceTextureLimit) && value.deviceTextureLimit > 0, missing, 'actual-texture-side-and-device-limit');
  if (finite(value.textureSide) && finite(value.deviceTextureLimit)) violation(value.textureSide > Math.min(2048, value.deviceTextureLimit), fail, 'R18-texture-limit');
}
const completeIdle = idle => idle?.requestedMs === 30_000 && finite(idle.startMs) && finite(idle.endMs) && idle.endMs - idle.startMs >= 30_000;
const completeObservation = value => finite(value?.observation?.startMs) && finite(value?.observation?.endMs) && value.observation.startMs >= value.idle?.endMs && value.observation.endMs >= value.observation.startMs;
/** P-M: B0+2 cycles, worker restart after 1. M: B0+100 cycles in five
 * real 30-minute windows, worker restarts after 20/40/60/80. B_i is measured
 * after exactly30s idle; processIdentity/fixtureIdentity cannot change.
 */
export function evaluateLifecycle({ profile, workload, processIdentity, fixtureIdentity, B0, cycles = [], windows = [], sampling, forcedGC, processRestarted, startMs, endMs }) {
  if (!['P-M', 'M'].includes(profile) || !['W1', 'W2', 'WXn', 'WXs'].includes(workload)) throw Error('Unknown lifecycle profile/workload');
  const fail = [], missing = [], count = profile === 'P-M' ? 2 : 100, restarts = profile === 'P-M' ? [1] : [20, 40, 60, 80];
  exact(typeof processIdentity === 'string' && !!processIdentity && typeof fixtureIdentity === 'string' && !!fixtureIdentity, missing, 'sealed-process-and-fixture-identities');
  violation(forcedGC || processRestarted, fail, 'continuous-process-without-forced-GC');
  exact(typeof forcedGC === 'boolean' && typeof processRestarted === 'boolean', missing, 'explicit-process-and-GC-observations');
  exact(completeIdle(B0?.idle), missing, 'B0-after-thirty-second-idle');
  exact(completeObservation(B0), missing, 'B0-resource-observation-after-idle');
  exact(finite(startMs) && finite(endMs) && startMs <= B0?.idle?.startMs && endMs >= cycles.at(-1)?.endMs, missing, 'actual-whole-series-clock');
  resourceCheck(B0?.resources, workload, fail, missing);
  exact(sampling?.complete === true && sampling.kind === 'attributed-process-tree-and-allocation-ledger' && hash(sampling.sha256), missing, 'continuous-RSS-and-allocation-sampling');
  exact(cycles.length === count && cycles.every((cycle, index) => cycle.ordinal === index + 1), missing, 'exact-ordered-lifecycle-cycles');
  let lastEnd = B0?.observation?.endMs, worstGrowth = 0, growthObserved = false;
  for (const cycle of cycles) {
    exact(cycle.processIdentity === processIdentity && cycle.fixtureIdentity === fixtureIdentity, missing, 'same-process-and-durable-fixture-through-cycles');
    exact(finite(cycle.startMs) && finite(cycle.endMs) && cycle.startMs >= lastEnd && cycle.endMs >= cycle.startMs, missing, 'ordered-lifecycle-clock');
    violation(cycle.endMs - cycle.startMs > 90_000, fail, 'cycle-over-ninety-seconds'); lastEnd = cycle.endMs;
    exact(completeIdle(cycle.idle) && completeObservation(cycle) && cycle.endMs >= cycle.observation.endMs, missing, 'cycle-ends-after-thirty-second-idle-and-resource-observation');
    const required = ['open', 'stroke', 'adopt', 'undo-adoption', 'undo-stroke', 'close', 'release'];
    if (workload.startsWith('WX')) required.splice(2, 0, 'text-edit', 'undo-text', 'font-select', 'font-restore');
    const phases = cycle.action?.phases ?? [];
    const names = phases.map(phase => phase.name), primary = ['open', 'stroke', 'adopt', 'undo-adoption', 'undo-stroke', 'close', 'release'];
    exact(phases.length === required.length && unique(names) && required.every(name => names.includes(name)) && primary.every((name, index) => !index || names.indexOf(name) > names.indexOf(primary[index - 1])) && phases.every((phase, index) => phase.outcome === 'expected' && finite(phase.startMs) && finite(phase.endMs) && phase.endMs >= phase.startMs && phase.startMs >= (index ? phases[index - 1].endMs : cycle.startMs) && phase.endMs <= cycle.idle?.startMs), missing, 'actual-complete-lifecycle-actions');
    if (workload.startsWith('WX')) exact(['text-edit', 'undo-text', 'font-select', 'font-restore'].every(name => names.indexOf(name) > names.indexOf('open') && names.indexOf(name) < names.indexOf('close')) && names.indexOf('text-edit') < names.indexOf('undo-text') && names.indexOf('font-select') < names.indexOf('font-restore'), missing, 'mixed-text-edit-undo-font-restore');
    violation(phases.some(phase => phase.outcome && phase.outcome !== 'expected'), fail, 'lifecycle-action-failure');
    exact(cycle.action?.strokeSamples === 120, missing, 'one-hundred-twenty-authored-stroke-samples');
    const raster = cycle.action?.assertions?.lifecycleRaster;
    exact(raster?.schemaVersion === 1 && raster?.scope === 'M-authored-mask-candidate-replacement-undo' && raster.nativeDisplayPixels === false && raster.independentStrokeRasterization === false, missing, 'explicit-lifecycle-raster-oracle-scope');
    for (const key of ['strokeAuthoredGeometry', 'adoptedLayerPixelsEqualPreparedCandidate', 'otherLayersAndTargetSlotPreserved', 'canonicalDocumentPixelsVerified', 'undoAdoptionPixelsRestored', 'undoBaselinePixelsRestored', 'retainedInputs']) {
      exact(raster?.[key] === true, missing, `lifecycle-raster:${key}`);
      violation(raster?.[key] === false, fail, `lifecycle-raster-oracle-failed:${key}`);
    }
    exact(finite(cycle.releaseMs), missing, 'last-consumer-release-measurement'); violation(cycle.releaseMs > 5000, fail, 'R19-release-over-five-seconds');
    if (restarts.includes(cycle.ordinal)) exact(cycle.restart && typeof cycle.restart.before === 'string' && !!cycle.restart.before.trim() && typeof cycle.restart.after === 'string' && !!cycle.restart.after.trim() && cycle.restart.before !== cycle.restart.after && finite(cycle.restart.startMs) && finite(cycle.restart.endMs) && cycle.restart.startMs >= phases.at(-1)?.endMs && cycle.restart.endMs >= cycle.restart.startMs && cycle.restart.endMs <= cycle.idle?.startMs, missing, 'scheduled-real-worker-restart');
    else exact(cycle.restart == null, missing, 'unexpected-worker-restart');
    exact(Array.isArray(cycle.resourceSamples) && cycle.resourceSamples.length > 0, missing, 'cycle-peak-resource-samples');
    for (const value of cycle.resourceSamples ?? []) resourceCheck(value, workload, fail, missing);
    resourceCheck(cycle.resources, workload, fail, missing);
    violation(cycle.resources?.unusedHandles > 0, fail, 'unused-handles-not-released');
    if (finite(cycle.resources?.settledBytes) && finite(B0?.resources?.settledBytes)) { growthObserved = true; worstGrowth = Math.max(worstGrowth, cycle.resources.settledBytes - B0.resources.settledBytes); }
  }
  if (profile === 'M') {
    exact(windows.length === 5, missing, 'five-thirty-minute-windows');
    exact(endMs >= windows.at(-1)?.endMs, missing, 'actual-series-observation-through-final-window');
    for (let index = 0; index < windows.length; index++) {
      const window = windows[index];
      exact(window.ordinal === index + 1 && close(window.endMs - window.startMs, 1_800_000) && close(window.startMs, index ? windows[index - 1].endMs : B0?.idle?.endMs), missing, 'consecutive-thirty-minute-windows');
      const inWindow = cycles.slice(index * 20, index * 20 + 20);
      exact(inWindow.length === 20 && inWindow.every(cycle => cycle.startMs >= window.startMs && cycle.endMs <= window.endMs), missing, 'twenty-real-cycles-per-window');
    }
  }
  const finalGrowth = finite(cycles.at(-1)?.resources?.settledBytes) && finite(B0?.resources?.settledBytes) ? Math.max(0, cycles.at(-1).resources.settledBytes - B0.resources.settledBytes) : null;
  const target = (profile === 'P-M' ? 4 : 16) * MiB, ceiling = (profile === 'P-M' ? 8 : 32) * MiB;
  violation(worstGrowth > ceiling || finalGrowth > ceiling, fail, 'R19-settled-growth-ceiling');
  return result('perf-lifecycle-evaluation-1', fail, missing, { profile, workload, expectedCycles: count, observedCycles: cycles.length, growth: { finalBytes: finalGrowth, worstBytes: growthObserved ? worstGrowth : null, targetBytes: target, ceilingBytes: ceiling, targetMissed: growthObserved ? worstGrowth > target || finalGrowth > target : null } });
}

/** Independent AC2/AH2 or Q3 I8 WA resource cohort. Its two real imports do
 * not establish editor R19's hundred-cycle growth claim or P-M's acute bound.
 */
export function evaluateAdapterLifecycle({ profile, processIdentity, fixtureIdentity, weightsIdentity, configIdentity, B0, cycles = [], sampling, forcedGC, processRestarted }) {
  if (!['P-A', 'Q3-A'].includes(profile)) throw Error('Unknown adapter lifecycle profile');
  const fail = [], missing = [];
  exact(typeof processIdentity === 'string' && !!processIdentity && typeof fixtureIdentity === 'string' && !!fixtureIdentity && hash(weightsIdentity) && hash(configIdentity), missing, 'sealed-WA-process-and-fixed-artifact-identities');
  exact(typeof forcedGC === 'boolean' && typeof processRestarted === 'boolean', missing, 'explicit-process-and-GC-observations');
  violation(forcedGC === true || processRestarted === true, fail, 'continuous-process-without-forced-GC');
  exact(completeIdle(B0?.idle) && completeObservation(B0), missing, 'independent-WA-B0-after-thirty-second-idle');
  resourceCheck(B0?.resources, 'WA', fail, missing);
  exact(sampling?.complete === true && sampling.kind === 'attributed-process-tree-and-allocation-ledger' && hash(sampling.sha256), missing, 'continuous-RSS-and-allocation-sampling');
  exact(cycles.length === 2 && cycles.every((cycle, index) => cycle.ordinal === index + 1), missing, 'two-independent-complete-WA-cycles');
  let lastEnd = B0?.observation?.endMs;
  for (const cycle of cycles) {
    exact(cycle.processIdentity === processIdentity && cycle.fixtureIdentity === fixtureIdentity && cycle.weightsIdentity === weightsIdentity && cycle.configIdentity === configIdentity, missing, 'same-WA-process-and-fixed-artifacts-through-cycles');
    exact(finite(cycle.startMs) && finite(cycle.endMs) && cycle.startMs >= lastEnd && cycle.endMs >= cycle.startMs, missing, 'ordered-WA-lifecycle-clock');
    lastEnd = cycle.endMs;
    exact(completeIdle(cycle.idle) && completeObservation(cycle) && cycle.endMs >= cycle.observation.endMs, missing, 'WA-cycle-complete-idle-and-resource-observation');
    const phases = cycle.action?.phases ?? [], required = ['import', 'select', 'unselect', 'close', 'release'];
    exact(phases.length === required.length && phases.every((phase, index) => phase.name === required[index] && phase.outcome === 'expected' && finite(phase.startMs) && finite(phase.endMs) && phase.endMs >= phase.startMs && phase.startMs >= (index ? phases[index - 1].endMs : cycle.startMs) && phase.endMs <= cycle.idle?.startMs), missing, 'actual-complete-WA-import-select-unselect-close-release');
    violation(phases.some(phase => phase.outcome && phase.outcome !== 'expected'), fail, 'WA-lifecycle-action-failure');
    for (const key of ['fixedArtifactsImported', 'selectionRestored', 'durableFixturePreserved', 'noBrowserTensorDecode', 'zeroUnexpectedFetches']) {
      exact(cycle.action?.assertions?.[key] === true, missing, `WA:${key}`);
      violation(cycle.action?.assertions?.[key] === false, fail, `WA:${key}`);
    }
    const selected = cycle.action?.selectedIdentities;
    exact(Array.isArray(selected) && selected.length >= 1 && selected.length <= 3 && unique(selected) && selected.every(hash), missing, 'WA-one-to-three-distinct-selected-identities');
    exact(cycle.restart == null, missing, 'WA-no-unspecified-worker-restart');
    exact(finite(cycle.releaseMs), missing, 'last-consumer-release-measurement'); violation(cycle.releaseMs > 5000, fail, 'R19-release-over-five-seconds');
    exact(Array.isArray(cycle.resourceSamples) && cycle.resourceSamples.length > 0, missing, 'WA-cycle-peak-resource-samples');
    for (const value of cycle.resourceSamples ?? []) resourceCheck(value, 'WA', fail, missing);
    resourceCheck(cycle.resources, 'WA', fail, missing);
    violation(cycle.resources?.unusedHandles > 0, fail, 'unused-handles-not-released');
  }
  return result('perf-adapter-lifecycle-evaluation-1', fail, missing, { profile, workload: 'WA', expectedCycles: 2, observedCycles: cycles.length, growthClaim: false, note: 'WA checks applicable resource caps and independent real lifecycle actions. It does not establish a two-cycle or hundred-cycle editor growth claim.' });
}

/** Reports use the pinned web-vitals lifecycle, not a replacement INP/CLS
 * algorithm. Each report names visitId/navigationId/metricId, sequence, metric,
 * finalized, observerSupported, lifecycleComplete, visibility, interactions,
 * value, and libraryVersion. BFCache visits need distinct visit IDs.
 */
export function evaluateVisits({ profile, metric, cache, cohortKey, library, expectedVisits = [], reports = [], fieldWindow }) {
  if (!['P', 'Q3', 'FIELD'].includes(profile) || !['LCP', 'CLS', 'INP'].includes(metric) || !['cold', 'warm'].includes(cache)) throw Error('Unknown finalized-visit cohort');
  const fail = [], missing = [], values = [], unavailable = [], finalized = [], visitMetricIdentities = [];
  exact(typeof cohortKey === 'string' && !!cohortKey, missing, 'sealed-visit-cohort-key');
  exact(library?.name === 'web-vitals' && typeof library.version === 'string' && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(library.version) && hash(library.sha256), missing, 'pinned-web-vitals-library-and-definitions');
  const expectedCount = profile === 'P' ? metric === 'INP' ? 1 : 3 : profile === 'Q3' ? metric === 'INP' ? cache === 'warm' ? 5 : 1 : 30 : 200;
  exact(unique(expectedVisits) && expectedVisits.every(id => typeof id === 'string' && id) && (profile === 'FIELD' ? expectedVisits.length >= expectedCount : expectedVisits.length === expectedCount), missing, 'prescribed-distinct-visit-count');
  if (profile === 'FIELD') exact(fieldWindow?.realUserVisits === true && finite(fieldWindow.startMs) && finite(fieldWindow.endMs) && fieldWindow.endMs - fieldWindow.startMs >= 28 * 86400_000, missing, 'field-two-hundred-real-visits-over-twenty-eight-days');
  const selected = reports.filter(report => report.metric === metric);
  exact(selected.every(report => expectedVisits.includes(report.visitId) && report.cohortKey === cohortKey && report.cache === cache), missing, 'unmixed-declared-visit-cohort');
  for (const id of expectedVisits) {
    const visit = selected.filter(report => report.visitId === id);
    const identity = visit[0];
    if (identity) {
      exact(typeof identity.metricId === 'string' && !!identity.metricId && typeof identity.navigationId === 'string' && !!identity.navigationId, missing, 'nonempty-string-navigation-and-metric-identities');
      visitMetricIdentities.push(identity.metricId);
    }
    exact(visit.every(report => report.metricId === identity.metricId && report.navigationId === identity.navigationId && report.libraryVersion === library?.version && Number.isSafeInteger(report.sequence) && report.sequence >= 0) && unique(visit.map(report => report.sequence)), missing, 'stable-visit-metric-and-sequence-identities');
    const latest = visit.filter(report => report.finalized === true).sort((a, b) => b.sequence - a.sequence)[0];
    for (const report of visit) {
      if (report.outcome === 'infra-invalid' && report.infraEvidence) missing.push('documented-visit-infrastructure-invalidation');
      else if (report.outcome && report.outcome !== 'expected') fail.push('unexpected-visit-outcome');
      violation(report.correctnessViolation === true || report.capViolation === true, fail, 'visit-correctness-or-cap-violation');
    }
    if (!latest || latest.observerSupported !== true || latest.lifecycleComplete !== true || latest.visibility !== 'visible' || !latest.metricId || !latest.navigationId || !finite(latest.value) || !Number.isSafeInteger(latest.interactions) || latest.interactions < (metric === 'INP' ? 1 : 0)) {
      unavailable.push(id); missing.push('required-finalized-visit-metric-unavailable'); continue;
    }
    values.push(latest.value); finalized.push({ visitId: id, navigationId: latest.navigationId, metricId: latest.metricId, sequence: latest.sequence, value: latest.value });
  }
  exact(unique(visitMetricIdentities), missing, 'distinct-finalized-metric-identities-per-visit');
  const limits = { LCP: [1500, 2500], CLS: [.05, .10], INP: [100, 200] }[metric];
  const probability = profile === 'P' ? 1 : .75;
  // Missing visits contribute only a conservative zero lower bound. A known
  // breach still fails; a smaller success-only percentile cannot supply a pass.
  const lower = expectedVisits.length ? nearestRank([...values, ...Array(unavailable.length).fill(0)], probability) : null;
  violation(lower > limits[1], fail, 'finalized-visit-metric-ceiling');
  const eligible = !missing.length && values.length === expectedVisits.length;
  return result('perf-finalized-visits-1', fail, missing, { metric, cache, profile, expected: expectedVisits.length, available: values.length, unavailable, finalized, statistic: profile === 'P' ? 'max' : 'p75', value: eligible ? nearestRank(values, probability) : null, prescribedRankLowerBound: lower, target: limits[0], ceiling: limits[1], targetMissed: eligible ? nearestRank(values, probability) > limits[0] : null, successOnly: { diagnosticOnly: !eligible, n: values.length, p75: values.length ? nearestRank(values, .75) : null }, note: 'Lab scripted visits do not establish field performance; unavailable INP is never zero.' });
}

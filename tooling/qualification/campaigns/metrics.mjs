// PERF-8 session/resource/finalized-visit arithmetic. Collection and artifact
// authenticity belong to the runner; these helpers never certify a host.
import { nearestRank } from '../statistics.mjs';
import { isRendererTextureNotApplicable, isAppOwnedAllocationPoint, isAppOwnedAllocationScope } from './renderer-ownership.mjs';
import { readVerifiedBrowserWA } from './browser-wa-observation.mjs';
import { selectedAdapterIdentity } from './adapter-lifecycle.mjs';
import { isDeepStrictEqual } from 'node:util';
import { appOwnedCpuCandidate } from './resource-sampling-verification.mjs';
import { readVerifiedHmrCeiling } from './windowserver-hmr-verification.mjs';
import { readVerifiedFirstUseBounds } from './windowserver-first-use-verification.mjs';
import { readVerifiedSessionBounds } from './windowserver-session-verification.mjs';
import { readVerifiedTextSessionBounds } from './windowserver-text-session-verification.mjs';

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
  const native = protocol === 'I' ? readVerifiedSessionBounds(session.nativePresentationProof, session) : readVerifiedTextSessionBounds(session.nativePresentationProof, session);
  const nativeAcknowledgements = [], nativePointers = [];
  if (session.nativePresentationProof && !native) missing.push('session-native-presentation-proof-unavailable');
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
    } else {
      const bound = native?.actions.find(row => row.id === action.id)?.acknowledgement;
      if (action.presentedMs === null && action.meaningful === true && bound?.status === 'OBSERVED' && finite(bound.upperBoundMs) &&
        bound.endpoint === 'WindowServer-presented-pixels' && bound.ceilingMs === 100 && bound.withinWindow === true) {
        const input = native.actions.find(row => row.id === action.id)?.input;
        nativeAcknowledgements.push({id: action.id, upperBoundMs: bound.upperBoundMs, ...(input ? {input} : {})});
        // An upper bound above the cap does not prove the first frame was late.
        if (bound.upperBoundMs > 100) missing.push('R04-earliest-acknowledgement-unavailable');
      } else missing.push('meaningful-presented-acknowledgement');
    }
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
        const diagnostic = native?.actions.find(row => row.id === action.id)?.pointer.find(row => row.id === point.id);
        if (point.presentedMs === null && diagnostic?.status === 'OBSERVED' && finite(diagnostic.upperBoundMs) && diagnostic.withinWindow === true)
          nativePointers.push({id: point.id, upperBoundMs: diagnostic.upperBoundMs});
      }
    }
  }
  const allPointerIds = actions.flatMap(action => action.samples ?? []).map(point => point.id);
  exact(unique(allPointerIds), missing, 'distinct-pointer-event-identities');
  let textGuardCoverage = null;
  if (protocol === 'IText') {
    const checks = session.textPresentation;
    for (const key of ['sameConnectedNode', 'forwardRangePreserved', 'backwardRangePreserved', 'collapsedRangePreserved', 'latestDeferredOnlyAfterNativeEnd', 'cancelDropsDeferred', 'staleDeferredRequestRejected']) {
      exact(checks?.[key] === true, missing, `IText:${key}`);
      violation(checks?.[key] === false, fail, `IText:${key}`);
    }
    const rejection = checks?.deferredRequestRejection;
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const exactNames = (value, names) => Array.isArray(value) && value.length === names.length && value.every((name, index) => name === names[index]);
    const draftGuards = ['stale-session', 'stale-generation', 'stale-version'];
    const observedLegacyGeneration = rejection?.kind === 'deferred-presentation-rejection-1' && rejection.reason === 'stale-generation' &&
      integer(rejection.requestSequence) && rejection.requestSequence > 0 && integer(rejection.requestEpoch) && rejection.currentEpoch === rejection.requestEpoch &&
      integer(rejection.requestGeneration) && integer(rejection.currentGeneration) && rejection.currentGeneration > rejection.requestGeneration &&
      rejection.presentationUnchanged === true && rejection.requestNotSettled === true && rejection.nativeBoundary === 'existing-final-composition-cancel' && rejection.extraMutationOrRequest === false &&
      exactNames(rejection.witnessedGuards, ['stale-generation']) && exactNames(rejection.unobservedGuards, ['stale-session', 'stale-version']);
    const observedDraftGuards = rejection?.kind === 'deferred-presentation-rejection-2' && rejection.reason === 'cancelled' &&
      rejection.nativeBoundary === 'cancel-native-end' && rejection.guardMask === 7 && rejection.versionMeaning === 'draft-text-version' &&
      integer(rejection.requestSequence) && rejection.requestSequence > 0 &&
      ['requestEpoch', 'currentEpoch', 'requestGeneration', 'currentGeneration', 'requestTextVersion', 'currentTextVersion'].every(name => integer(rejection[name])) &&
      rejection.currentEpoch > rejection.requestEpoch && rejection.currentGeneration > rejection.requestGeneration && rejection.currentTextVersion > rejection.requestTextVersion &&
      rejection.capturedState?.epoch === rejection.requestEpoch && rejection.capturedState?.generation === rejection.requestGeneration && rejection.capturedState?.textVersion === rejection.requestTextVersion &&
      rejection.currentState?.epoch === rejection.currentEpoch && rejection.currentState?.generation === rejection.currentGeneration && rejection.currentState?.textVersion === rejection.currentTextVersion &&
      rejection.presentationUnchanged === true && rejection.requestNotSettled === true && rejection.extraMutationOrRequest === false &&
      exactNames(rejection.witnessedGuards, draftGuards) && exactNames(rejection.unobservedGuards, []) &&
      rejection.acceptedVersion?.scope === 'accepted-document-layer-version' && rejection.acceptedVersion?.invariantUnchanged === true && rejection.acceptedVersion?.rejectionObserved === false;
    exact(observedDraftGuards, missing, 'IText:actual-cancel-native-end-draft-guard-tuple');
    violation(rejection?.presentationUnchanged === false || rejection?.requestNotSettled === false || rejection?.extraMutationOrRequest === true, fail, 'IText:stale-request-restored-state-or-added-action');
    violation(rejection?.kind === 'deferred-presentation-rejection-2' && (rejection.acceptedVersion?.invariantUnchanged === false || integer(rejection.guardMask) && (rejection.guardMask & 8) !== 0), fail, 'IText:accepted-version-changed-in-fixed-specimen');
    const witnessedGuards = observedDraftGuards ? draftGuards : observedLegacyGeneration ? ['stale-generation'] : [];
    const unobservedGuards = draftGuards.filter(name => !witnessedGuards.includes(name));
    missing.push(...unobservedGuards.map(name => 'IText:' + name + '-rejection-unobserved'));
    textGuardCoverage = {witnessedGuards, unobservedGuards, versionMeaning: 'draft-text-version',
      acceptedVersion: {scope: 'accepted-document-layer-version', invariantUnchanged: observedDraftGuards ? true : null, rejectionObserved: false},
      rejection: rejection ?? null, modelSettlementIsPhysicalPresentation: false};
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
  const withinCeiling = nativeAcknowledgements.filter(row => row.upperBoundMs <= 100).length;
  const upperBounds = {exactLatency: false, endpoint: 'WindowServer-presented-pixels',
    acknowledgements: {...sample(nativeAcknowledgements.map(row => row.upperBoundMs)), required: protocol === 'I' ? 100 : 106,
      observedWithinCeiling: withinCeiling, observedWithinTarget: nativeAcknowledgements.filter(row => row.upperBoundMs <= 50).length, ceilingMs: 100, targetMs: 50,
      ceilingAssessment: native && nativeAcknowledgements.length === (protocol === 'I' ? 100 : 106) && withinCeiling === (protocol === 'I' ? 100 : 106) && !fail.length ? 'observed-upper-bounds-within-ceiling' : 'unavailable',
      actions: nativeAcknowledgements},
    pointer: {...sample(nativePointers.map(row => row.upperBoundMs)), required: protocol === 'I' ? 2400 : 0, diagnosticOnly: true,
      scope: 'Exact reviewed prefix before next input; unavailable coalesced or dropped prefixes are not a new R07 requirement.'},
    limitations: native?.limitations ?? null};
  return result('perf-interaction-session-1', fail, missing, { protocol, textGuardCoverage, upperBounds, actions: actions.length, acknowledgements: ackStats, pointer: pointerStats, pointerCadence: { requestedHz: 60, observedSchedules, actualNativeIntervals: sample(nativeIntervals), dispatchLateness: sample(dispatchLateness), dispatchDurations: sample(dispatchDurations), scope: 'Requested cadence and observed timing are separate; no jitter tolerance is invented and runner/browser clocks are never subtracted.' }, frameWork: { ...workStats, pooledDiagnostic: true }, frameSegments, droppedShare60SecondSession: droppedShare, expectedActiveSlots: expectedSlots, missedActiveSlots: completeSlots ? missedSlots : null, stallsAtLeast100ms: stalls, fallback: { active: sample(slices.active), inactive: sample(slices.inactive) }, targetMisses: { acknowledgement: ackStats.max > 50 ? true : nativeAcknowledgements.length ? null : false, frameWork: frameSegments.some(segment => segment.work.p95 > 8), pointer: pointerStats.p95 > 16.7, droppedSlots: droppedShare > .01, activeSlice: sample(slices.active).p95 > 4, inactiveSlice: sample(slices.inactive).p95 > 8 } });
}

/** Standalone first-use sibling of P-I. Reset/ready/ack clocks require the
 * actual one-second observation window and validated presentation trace. */
export function evaluateFirstUse(firstUse = []) {
  const fail = [], missing = [], readiness = [], acknowledgements = [], nativeAcknowledgements = [], nativeReadiness = [];
  exact(firstUse.length === 10 && firstUse.every(value => typeof value.id === 'string' && !!value.id.trim()) && unique(firstUse.map(value => value.id)), missing, 'ten-first-use-windows');
  for (const value of firstUse) {
    observedOutcome(value, fail, missing, 'first-use');
    exact(value.reset === true && close(value.endMs - value.startMs, 1000), missing, 'reset-one-second-first-use-window');
    const suppliedNative = value.nativePresentationProof !== undefined && value.nativePresentationProof !== null;
    const native = readVerifiedFirstUseBounds(value.nativePresentationProof, value);
    if (suppliedNative && value.presentedMs !== undefined && value.presentedMs !== null) missing.push('first-use-conflicting-exact-and-upper-bound-presentation');
    if (native && value.presentedMs === null) {
      const ack = native.acknowledgement, ready = native.readiness;
      exact(['Mask', 'Adapter library'].includes(value.feature) && value.meaningful === true, missing, 'first-use-native-feature-outcome');
      exact(value.windowClock === 'runner-monotonic' && value.readyClock === 'runner-monotonic' && finite(value.startMs) && finite(value.readyMs) && value.readyMs >= value.startMs && value.readyMs <= value.endMs, missing, 'first-use-public-readiness-inside-reset-window');
      if (finite(ack?.upperBoundMs) && ack.ceilingMs === 100 && ack.endpoint === 'WindowServer-presented-pixels') {
        nativeAcknowledgements.push(ack.upperBoundMs);
        if (ack.upperBoundMs > 100) missing.push('first-use-earliest-presentation-unavailable');
        exact(ack.withinWindow === true, missing, 'first-use-native-presentation-window-unavailable');
      } else missing.push('first-use-native-presentation-proof-unavailable');
      if (finite(ready?.upperBoundMs) && ready.ceilingMs === 750 && ready.endpoint === 'public-control-ready-following-native-ACK') {
        nativeReadiness.push(ready.upperBoundMs);
        if (ready.upperBoundMs > 750) missing.push('first-use-earliest-readiness-unavailable');
        exact(ready.withinWindow === true, missing, 'first-use-native-readiness-window-unavailable');
      } else missing.push('first-use-complete-readiness');
      // Conservative upper bounds stay out of the exact distribution. A late
      // ACK/sample cannot prove the first ready/paint endpoint missed its cap.
      continue;
    }
    if (suppliedNative || value.nativePresentation) missing.push('first-use-native-presentation-proof-unavailable');
    const windowClock = value.inputClock === undefined && value.windowClock === undefined || value.inputClock !== undefined && value.inputClock === value.windowClock;
    const readyClock = value.inputClock === undefined && value.readyClock === undefined || value.inputClock !== undefined && value.inputClock === value.readyClock;
    exact(windowClock && finite(value.startMs) && finite(value.inputMs) && value.inputMs >= value.startMs && value.inputMs <= value.endMs && readyClock && finite(value.readyMs) && value.readyMs >= value.inputMs && value.readyMs <= value.endMs && finite(value.presentedMs) && value.presentedMs <= value.endMs, missing, 'first-use-observations-inside-reset-window');
    exact(value.trace?.kind === 'browser-presentation-trace' && hash(value.trace.sha256) && value.trace.attributionComplete === true, missing, 'first-use-presentation-trace');
    const exactPaintClock = value.presentedClock === undefined || value.presentedClock === value.inputClock;
    if (exactPaintClock && finite(value.presentedMs) && finite(value.inputMs) && value.presentedMs >= value.inputMs && value.meaningful === true) {
      acknowledgements.push(value.presentedMs - value.inputMs); violation(value.presentedMs - value.inputMs > 100, fail, 'R04-first-use-acknowledgement');
    }
    else missing.push('first-use-presentation');
    if (readyClock && finite(value.readyMs) && finite(value.inputMs) && value.readyMs >= value.inputMs) {
      readiness.push(value.readyMs - value.inputMs); violation(value.readyMs - value.inputMs > 750, fail, 'R06-lazy-readiness');
    } else missing.push('first-use-complete-readiness');
  }
  return result('perf-first-use-1', fail, missing, { windows: firstUse.length, readiness: sample(readiness), acknowledgements: sample(acknowledgements),
    upperBounds: {acknowledgements: {...sample(nativeAcknowledgements), exactLatency: false, endpoint: 'WindowServer-presented-pixels', targetMs: 50, ceilingMs: 100},
      readiness: {...sample(nativeReadiness), exactLatency: false, endpoint: 'public-control-ready-following-native-ACK', targetMs: 250, ceilingMs: 750}} });
}

/** D05 can be evaluated independently of I. P uses three warm edits; Q3 uses
 * ten cold and ten warm starts with independently retained cache ordinals. */
export function evaluateHotEdit(hotEdits = [], { profile = 'P' } = {}) {
  if (!['P', 'Q3'].includes(profile)) throw Error('Unknown hot-edit profile');
  const fail = [], missing = [], nativeBounds = [];
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
    const suppliedNativeProof = value.nativePresentationProof !== undefined && value.nativePresentationProof !== null;
    const native = readVerifiedHmrCeiling(value.nativePresentationProof, value);
    const verifiedNative = native && finite(native.upperBoundMs) && native.ceilingMs === 500 && native.endpoint === 'WindowServer-presented-pixels';
    if (suppliedNativeProof && value.presentedMs !== undefined && value.presentedMs !== null) missing.push('hot-update-conflicting-exact-and-upper-bound-presentation');
    if (verifiedNative && value.presentedMs === null) {
      nativeBounds.push({ cache: value.cache ?? 'warm', upperBoundMs: native.upperBoundMs });
      // An observed matching frame bounds first correct paint from above. A
      // later observation cannot prove that the first correct frame was late.
      if (native.upperBoundMs > 500) missing.push('hot-update-earliest-presentation-unavailable');
      continue;
    }
    if (suppliedNativeProof) missing.push('hot-update-native-presentation-proof-unavailable');
    // Unknown/mismatched native claims cannot suppress a genuine legacy
    // latency breach, product failure, or document-preservation violation.
    exact(value.trace?.kind === 'browser-presentation-trace' && hash(value.trace.sha256) && value.trace.attributionComplete === true, missing, 'hot-update-presentation-trace');
    if (finite(value.savedMs) && finite(value.presentedMs) && value.presentedMs >= value.savedMs) violation(value.presentedMs - value.savedMs > 500, fail, 'D05-hot-update-over-500ms'); else missing.push('hot-update-presented-completion');
  }
  const elapsed = hotEdits.filter(value => finite(value.savedMs) && finite(value.presentedMs) && value.presentedMs >= value.savedMs).map(value => value.presentedMs - value.savedMs);
  const upperBounds = { ...sample(nativeBounds.map(value => value.upperBoundMs)), pooledDiagnostic: true,
    unit: 'ms', endpoint: 'WindowServer-presented-pixels', semantics: 'conservative-first-correct-paint-upper-bound', exactLatency: false, ceilingMs: 500,
    caches: Object.fromEntries((profile === 'P' ? ['warm'] : ['cold', 'warm']).map(cache => [cache, sample(nativeBounds.filter(value => value.cache === cache).map(value => value.upperBoundMs))])) };
  return result('perf-hot-edit-1', fail, missing, { profile, edits: hotEdits.length, elapsed: { ...sample(elapsed), pooledDiagnostic: true }, caches: Object.fromEntries((profile === 'P' ? ['warm'] : ['cold', 'warm']).map(cache => [cache, sample(hotEdits.filter(value => (value.cache ?? 'warm') === cache && finite(value.savedMs) && finite(value.presentedMs) && value.presentedMs >= value.savedMs).map(value => value.presentedMs - value.savedMs))])), upperBounds,
    targetMissed: elapsed.some(value => value > 200) ? true : nativeBounds.length ? null : false });
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
const backendOwnerCoverage = ['processTree', 'workerThreads', 'stagingBuffers', 'hashBuffers', 'headerBuffers', 'configBuffers', 'ioCopies', 'metadataConsumers', 'assetReadHandles', 'proofHandles', 'streamHandles'];
function adapterResourceScope(cell, profile) {
  if (!['P-A', 'Q3-A'].includes(profile)) return null;
  const jobs = profile === 'P-A' ? { AC2: ['C', 'adapters'], AH2: ['H', 'browser'] } : { I8C: ['C', 'adapters'], I8H: ['H', 'browser'] };
  const job = typeof cell?.id === 'string' ? cell.id.split('/')[0] : null, expected = jobs[job];
  if (!expected || cell.id !== `${job}/WA-lifecycle` || cell.host !== expected[0] || cell.handler !== expected[1] || cell.operation !== 'adapter.lifecycle' || cell.workload !== 'WA' || cell.kind !== 'lifecycle' || cell.parameters?.cycles !== 2 || cell.parameters?.idleMs !== 30000 || cell.parameters?.baselineIdleMs !== 30000 || cell.parameters?.bytes !== 256 * MiB || cell.parameters?.configBytesMax !== MiB) return null;
  return expected[0];
}
function observedActiveHandleOwners(value) {
  const producer = value?.producer, classification = producer?.handleClassification;
  const counts = ['mainHandles', 'workerMethods', 'assetPreparations', 'preparationPromises', 'assetChunkLeases', 'assetContentReaders'];
  const integer = number => Number.isSafeInteger(number) && number >= 0;
  return producer?.kind === 'adapter-resource-observation-1' && producer.coverage?.handles === false &&
    classification?.kind === 'scoped-handle-classification-1' && classification.complete === false && classification.settled === false && classification.retainedHandles === null &&
    counts.every(key => integer(classification.activeOwners?.[key])) && counts.some(key => classification.activeOwners[key] > 0) &&
    integer(classification.serviceHandles?.main) && integer(classification.serviceHandles?.worker);
}
function adapterResourceCheck(value, scope, processIdentity, fail, missing, { settled = true } = {}) {
  if (scope !== 'C') { resourceCheck(value, 'WA', fail, missing); return; }
  const handles = Number.isSafeInteger(value?.unusedHandles) && value.unusedHandles >= 0;
  const activeUnknown = !settled && value?.unusedHandles === null && observedActiveHandleOwners(value);
  exact(value && finite(value.backendRssBytes) && finite(value.cpuBytes) && (handles || activeUnknown), missing, 'complete-WA-backend-RSS-allocation-and-applicable-handle-observation');
  if (!value) return;
  exact(value.resourceScope === 'wa-backend-process-workers-allocations-1' && ['browserRssBytes', 'gpuBytes', 'previewCacheBytes', 'textureSide', 'deviceTextureLimit'].every(key => value[key] === null), missing, 'WA-backend-scope-without-fabricated-browser-measurements');
  const owner = value.backendOwnership, evidence = owner?.evidence;
  exact(owner?.kind === 'wa-backend-owner-evidence-1' && owner.processIdentity === processIdentity && backendOwnerCoverage.every(key => owner.coverage?.[key] === true) && typeof evidence?.path === 'string' && !!evidence.path && Number.isSafeInteger(evidence.bytes) && evidence.bytes > 0 && hash(evidence.sha256), missing, 'complete-WA-backend-owner-coverage-and-retained-evidence');
  violation(value.backendRssBytes > 512 * MiB, fail, 'resource-ceiling:backendRssBytes');
  violation(value.cpuBytes > 512 * MiB, fail, 'resource-ceiling:cpuBytes');
}

export function evaluateAdapterLifecycle(raw, { cell } = {}) {
  const { profile, processIdentity, fixtureIdentity, weightsIdentity, configIdentity, B0, cycles = [], sampling, forcedGC, processRestarted } = raw;
  const browserProof = cell?.host === 'H' ? readVerifiedBrowserWA(raw, cell) : null;
  if (!['P-A', 'Q3-A'].includes(profile)) throw Error('Unknown adapter lifecycle profile');
  const fail = [], missing = [], resourceScope = adapterResourceScope(cell, profile);
  exact(resourceScope !== null, missing, 'verified-planned-WA-cell-resource-applicability');
  exact(typeof processIdentity === 'string' && !!processIdentity && typeof fixtureIdentity === 'string' && !!fixtureIdentity && hash(weightsIdentity) && hash(configIdentity), missing, 'sealed-WA-process-and-fixed-artifact-identities');
  exact(typeof forcedGC === 'boolean' && typeof processRestarted === 'boolean', missing, 'explicit-process-and-GC-observations');
  violation(forcedGC === true || processRestarted === true, fail, 'continuous-process-without-forced-GC');
  exact(completeIdle(B0?.idle) && completeObservation(B0), missing, 'independent-WA-B0-after-thirty-second-idle');
  adapterResourceCheck(B0?.resources, resourceScope, processIdentity, fail, missing);
  exact(sampling?.complete === true && sampling.kind === (resourceScope === 'C' ? 'attributed-backend-process-and-allocation-ledger' : 'attributed-process-tree-and-allocation-ledger') && hash(sampling.sha256), missing, 'continuous-RSS-and-allocation-sampling');
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
      const scoped = cell?.host === 'H' && ['noBrowserTensorDecode','zeroUnexpectedFetches'].includes(key);
      const replay = scoped ? browserProof?.find(value => value.ordinal === cycle.ordinal) : null;
      exact(cycle.action?.assertions?.[key] === true && (!scoped || replay?.complete === true && replay.assertions[key] === true), missing, `WA:${key}`);
      if (scoped && replay?.authenticated === true && replay.failures?.length) fail.push(...replay.failures.map(value => 'WA:' + value));
      violation(scoped ? replay?.authenticated === true && replay.assertions[key] === false : cycle.action?.assertions?.[key] === false, fail, `WA:${key}`);
    }
    const selected = cycle.action?.selectedIdentities;
    exact(Array.isArray(selected) && selected.length >= 1 && selected.length <= 3 && unique(selected) && selected.every(hash), missing, 'WA-one-to-three-distinct-selected-identities');
    const selectedArtifacts = cycle.action?.selectedArtifacts;
    exact(Array.isArray(selectedArtifacts) && selectedArtifacts.length >= 1 && selectedArtifacts.length <= 3 && selectedArtifacts.length === selected?.length, missing, 'WA-exact-imported-selection-artifact-records');
    const imported = cycle.action?.observations?.importedBinding;
    exact(imported?.kind === 'wa-imported-adapter-binding-1' && imported.locallyEligible === true && cycle.action?.observations?.selectedImportedIdentity === true, missing, 'WA-actual-eligible-imported-version-binding');
    for (const [index, artifact] of (Array.isArray(selectedArtifacts) ? selectedArtifacts : []).entries()) {
      try {
        const canonical = selectedAdapterIdentity(artifact.value), weights = canonical.value.weights, config = canonical.value.config;
        violation(artifact.value.kind !== canonical.value.kind || artifact.identity !== canonical.identity || artifact.method !== canonical.method || selected?.[index] !== canonical.identity, fail, 'WA-selected-artifact-identity-mismatch');
        violation(weights.hash !== weightsIdentity || config?.hash !== configIdentity || (cell?.parameters?.bytes !== undefined && weights.byteLength !== String(cell.parameters.bytes)) || !config || !/^[1-9][0-9]*$/.test(config.byteLength) || BigInt(config.byteLength) > BigInt(MiB), fail, 'WA-selected-artifacts-differ-from-fixed-import');
        if (imported) violation(['versionId', 'adapterId', 'version'].some(key => canonical.value[key] !== imported[key]) || ['weights', 'config'].some(key => ['hash', 'byteLength', 'mediaType'].some(field => canonical.value[key]?.[field] !== imported[key]?.[field])), fail, 'WA-selected-version-is-not-the-actual-cycle-import');
      } catch { fail.push('WA-malformed-selected-artifact-identity'); }
    }

    exact(cycle.restart == null, missing, 'WA-no-unspecified-worker-restart');
    exact(finite(cycle.releaseMs), missing, 'last-consumer-release-measurement'); violation(cycle.releaseMs > 5000, fail, 'R19-release-over-five-seconds');
    exact(Array.isArray(cycle.resourceSamples) && cycle.resourceSamples.length > 0, missing, 'WA-cycle-peak-resource-samples');
    for (const value of cycle.resourceSamples ?? []) adapterResourceCheck(value, resourceScope, processIdentity, fail, missing, { settled: false });
    adapterResourceCheck(cycle.resources, resourceScope, processIdentity, fail, missing);
    violation(cycle.resources?.unusedHandles > 0, fail, 'unused-handles-not-released');
  }
  return result('perf-adapter-lifecycle-evaluation-1', fail, missing, { profile, workload: 'WA', resourceScope, notApplicableResourceFields: resourceScope === 'C' ? ['browserRssBytes', 'gpuBytes', 'previewCacheBytes', 'textureSide', 'deviceTextureLimit'] : [], expectedCycles: 2, observedCycles: cycles.length, growthClaim: false, note: 'WA checks applicable resource caps and independent real lifecycle actions. It does not establish a two-cycle or hundred-cycle editor growth claim.' });
}

const retainedArtifact = value => typeof value?.path === 'string' && !!value.path && Number.isSafeInteger(value.bytes) && value.bytes > 0 && hash(value.sha256);
const safeMeasurement = value => finite(value) && value <= Number.MAX_SAFE_INTEGER;
const resourceMetrics = {
  R17BrowserProcessTreeRssBytes: 'browserRssBytes', R17BackendRssBytes: 'backendRssBytes',
  R18CpuAllocationBytes: 'cpuBytes', R18GpuAllocationBytes: 'gpuBytes', R18PreviewCacheBytes: 'previewCacheBytes',
};
const collectorBudgets = new Set(['R21', 'R25', 'R35', 'R38', 'T05', 'T06', 'R32']);

function backendCpuWindow(raw, sampling) {
  const peak = sampling?.allocationPeaks?.cpuBytes, window = sampling?.observationWindow;
  const validId = value => typeof value === 'string' && !!value;
  const bracket = value => finite(value?.startMs) && finite(value?.endMs) && value.endMs >= value.startMs;
  const ns = value => typeof value === 'string' && /^[0-9]+$/.test(value);
  const scoped = peak?.kind === 'owned-allocation-continuous-peak-1' && peak.scope === 'independent-B0-lifecycle-window' &&
    window?.scope === peak.scope && validId(peak.windowId) && window.id === peak.windowId && peak.processIdentity === raw?.processIdentity && window.processIdentity === raw?.processIdentity &&
    typeof peak.sharedIdentity === 'string' && !!peak.sharedIdentity && Number.isSafeInteger(peak.sequence) && peak.sequence >= 0 &&
    Number.isSafeInteger(peak.sourceOrdinal) && peak.sourceOrdinal >= 1 && peak.sourceOrdinal <= sampling?.counts?.samples && safeMeasurement(peak.value) &&
    ns(peak.window?.startMonotonicNs) && ns(peak.window?.endMonotonicNs) && BigInt(peak.window.endMonotonicNs) >= BigInt(peak.window.startMonotonicNs) && peak.window.sealed === true && peak.window.integrityComplete === true &&
    bracket(window.startObservation) && bracket(window.endObservation) && window.startObservation.startMs >= raw?.B0?.observation?.startMs && window.startObservation.endMs <= raw?.B0?.observation?.endMs &&
    window.endObservation.startMs >= raw?.cycles?.at(-1)?.endMs && window.endObservation.endMs <= raw?.endMs && bracket(peak.observation) && peak.observation.startMs >= window.startObservation.startMs && peak.observation.endMs <= raw?.endMs &&
    retainedArtifact(peak.artifact) && retainedArtifact(sampling?.artifact) && ['path', 'bytes', 'sha256'].every(key => peak.artifact[key] === sampling.artifact[key]);
  return { peak: scoped ? peak : null, complete: scoped && peak.complete === true };
}

// This first browser observer measures a named subset of payload owners. Its
// sealed peak can establish a lower-bound breach, never complete global CPU
// coverage. Browser and runner clocks are bound by ACKs/brackets, not subtracted.
function browserCpuWindow(raw, sampling) {
  const peak = sampling?.allocationPeaks?.cpuBytes, joined = sampling?.observationWindow, window = peak?.window;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const ledgerId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const bracket = value => finite(value?.startMs) && finite(value?.endMs) && value.endMs >= value.startMs;
  const equalBracket = (a, b) => bracket(a) && bracket(b) && a.startMs === b.startMs && a.endMs === b.endMs;
  const gaps = ['app-payload-ownership-incomplete', 'native-image-and-canvas-implementation-overhead', 'native-blob-residency', 'engine-and-dom-allocations', 'renderer-ownership-proof-required'];
  const disclosedGaps = value => Array.isArray(value) && value.length === gaps.length && new Set(value).size === gaps.length && gaps.every(code => value.includes(code));
  const ack = (value, boundary) => value?.kind === 'combined-cpu-window-ack-1' && value.schemaVersion === 1 && value.boundary === boundary &&
    value.ledgerInstanceId === window.ledgerInstanceId && value.id === window.id && value.ordinal === window.ordinal && value.clock === 'browser-performance' && value.clockOriginMs === window.clockOriginMs &&
    value.sequence === (boundary === 'begin' ? window.startSequence : window.endSequence) && value.atMs === (boundary === 'begin' ? window.startMs : window.endMs) && value.sealed === (boundary === 'end');
  const begin = raw?.B0?.resources;
  const scoped = sampling?.kind === 'attributed-process-tree-and-allocation-ledger' && peak?.kind === 'owned-allocation-continuous-peak-1' && peak.scope === 'independent-B0-browser-cpu-window' && joined?.scope === peak.scope &&
    id(peak.windowId) && joined.id === peak.windowId && window?.id === peak.windowId && ledgerId(window?.ledgerInstanceId) && joined.ledgerInstanceId === window.ledgerInstanceId && peak.sharedIdentity === window.ledgerInstanceId &&
    typeof sampling.processIdentity === 'string' && !!sampling.processIdentity && (raw?.processIdentity === sampling.processIdentity || raw?.processIdentity === JSON.stringify(sampling.processIdentity)) &&
    peak.processIdentity === sampling.processIdentity && joined.processIdentity === sampling.processIdentity && begin?.processIdentity === sampling.processIdentity &&
    window.kind === 'combined-cpu-window-1' && window.schemaVersion === 1 && window.clock === 'browser-performance' && finite(window.clockOriginMs) && integer(window.ordinal) && window.ordinal > 0 &&
    ['startMs', 'endMs', 'peakAtMs'].every(key => finite(window[key])) && window.startMs <= window.peakAtMs && window.peakAtMs <= window.endMs &&
    ['startSequence', 'endSequence', 'peakSequence', 'textStartSequence', 'textEndSequence', 'currentBytes', 'peakBytes', 'ledgerBytesAtPeak', 'textBytesAtPeak'].every(key => integer(window[key])) &&
    window.startSequence <= window.peakSequence && window.peakSequence <= window.endSequence && window.textStartSequence <= window.textEndSequence &&
    window.currentBytes <= window.peakBytes && window.ledgerBytesAtPeak + window.textBytesAtPeak === window.peakBytes &&
    window.sealed === true && window.observationComplete === true && window.ownerCoverageComplete === false && Array.isArray(window.failures) && window.failures.length === 0 && disclosedGaps(window.missing) &&
    peak.ownerCoverageComplete === false && peak.complete === false && peak.sequence === window.endSequence && peak.value === window.peakBytes &&
    integer(joined.startSourceOrdinal) && joined.startSourceOrdinal >= 1 && joined.startSourceOrdinal === begin?.ordinal && integer(joined.endSourceOrdinal) && joined.endSourceOrdinal > joined.startSourceOrdinal && joined.endSourceOrdinal <= sampling?.counts?.samples && peak.sourceOrdinal === joined.endSourceOrdinal &&
    equalBracket(joined.startObservation, begin?.observation) && bracket(raw?.B0?.observation) && joined.startObservation.startMs >= raw.B0.observation.startMs && joined.startObservation.endMs <= raw.B0.observation.endMs &&
    bracket(joined.endObservation) && joined.endObservation.startMs >= raw?.cycles?.at(-1)?.endMs && joined.endObservation.endMs <= raw?.endMs && equalBracket(peak.observation, joined.endObservation) &&
    ack(joined.beginAck, 'begin') && ack(joined.endAck, 'end') && begin?.cpuWindowBoundary === 'begin' && ack(begin.cpuWindowAck, 'begin') &&
    retainedArtifact(peak.artifact) && retainedArtifact(sampling?.artifact) && ['path', 'bytes', 'sha256'].every(key => peak.artifact[key] === sampling.artifact[key]);
  return { peak: scoped ? peak : null, complete: false };
}

function browserAppOwnedAllocationWindow(raw, sampling, continuous, resourceKey) {
  const peak = sampling?.appOwnedCpu, joined = sampling?.observationWindow, artifact = sampling?.artifact;
  if (!peak || !continuous?.peak || !retainedArtifact(artifact) || !retainedArtifact(peak.artifact) ||
    !['path', 'bytes', 'sha256'].every(key => peak.artifact[key] === artifact[key])) return { peak: null, complete: false };
  const begin = raw?.B0?.resources;
  const end = { kind: 'final', ordinal: peak.endSourceOrdinal, processIdentity: sampling.processIdentity, observation: peak.endObservation,
    appOwnership: peak.end?.appOwnership, combinedCpu: peak.end?.combinedCpu, rendererOwnershipProof: peak.rendererOwnershipProof,
    cpuWindowBoundary: 'end', cpuWindowAck: joined?.endAck };
  const expected = appOwnedCpuCandidate(begin, end, sampling.processIdentity, joined);
  if (!expected || expected.value !== continuous.peak.value || !isDeepStrictEqual(peak, { ...expected, artifact: { path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 } })) return { peak: null, complete: false };
  const observed = expected.start.appOwnership.window.observationComplete === true && expected.end.appOwnership.window.observationComplete === true && expected.end.appOwnership.window.reconciled === true;
  const value = observed ? resourceKey === 'cpuBytes' ? expected.value : expected.end.appOwnership.window.peaks[resourceKey] : null;
  const complete = observed &&
    isAppOwnedAllocationPoint(expected.rendererOwnershipProof, { ...expected.start, resourceKey }) &&
    isAppOwnedAllocationScope(expected.rendererOwnershipProof, { ...expected.end, resourceKey });
  return { peak, value, complete: complete === true && safeMeasurement(value) };
}

/** Translate actual lifecycle observations into the registry's named rows.
 * Missing coverage never becomes a passing maximum or zero. A witnessed
 * lower bound above a ceiling is still emitted so a partial run cannot hide a
 * measured failure. Artifact authentication/replay remains the runner's job.
 */
export function deriveLifecycleMeasurements(raw, { cell } = {}) {
  const measurements = [], unavailable = [], rules = Array.isArray(cell?.requiredMeasurements) ? cell.requiredMeasurements : [];
  const adapter = cell?.operation === 'adapter.lifecycle', scope = adapter ? adapterResourceScope(cell, raw?.profile) :
    cell?.operation === 'lifecycle.editor' && cell.kind === 'lifecycle' && cell.host === 'H' && cell.handler === 'browser' && cell.workload === raw?.workload &&
    ['W1', 'W2', 'WXn', 'WXs'].includes(raw?.workload) && ['P-M', 'M'].includes(raw?.profile) && cell.parameters?.cycles === (raw.profile === 'M' ? 100 : 2) && cell.parameters?.idleMs === 30000 && cell.parameters?.baselineIdleMs === 30000 ? 'H' : null;
  const cycles = Array.isArray(raw?.cycles) ? raw.cycles : [], expected = cell?.parameters?.cycles;
  const identities = typeof raw?.processIdentity === 'string' && !!raw.processIdentity && typeof raw?.fixtureIdentity === 'string' && !!raw.fixtureIdentity;
  const inventory = scope !== null && identities && cycles.length === expected && cycles.every((cycle, index) => cycle.ordinal === index + 1 && cycle.processIdentity === raw.processIdentity && cycle.fixtureIdentity === raw.fixtureIdentity);
  const sampling = raw?.sampling, artifact = sampling?.artifact;
  const sameProcess = typeof sampling?.processIdentity === 'string' && !!sampling.processIdentity && (raw?.processIdentity === sampling.processIdentity || raw?.processIdentity === JSON.stringify(sampling.processIdentity));
  const samplingComplete = inventory && sampling?.complete === true && sampling.kind === (scope === 'C' ? 'attributed-backend-process-and-allocation-ledger' : 'attributed-process-tree-and-allocation-ledger') && retainedArtifact(artifact) && artifact.sha256 === sampling.sha256 && sameProcess && Number.isSafeInteger(sampling.counts?.samples) && sampling.counts.samples > 0;
  const samples = [raw?.B0?.resources, ...cycles.flatMap(cycle => [...(Array.isArray(cycle.resourceSamples) ? cycle.resourceSamples : []), cycle.resources])].filter(Boolean);
  const allSamplesPresent = !!raw?.B0?.resources && cycles.every(cycle => cycle.resources && Array.isArray(cycle.resourceSamples) && cycle.resourceSamples.length > 0);
  const sampleBound = value => value && value.processIdentity === sampling?.processIdentity && Number.isSafeInteger(value.ordinal) && value.ordinal >= 1 && value.ordinal <= sampling?.counts?.samples && finite(value.observation?.startMs) && finite(value.observation?.endMs) && value.observation.endMs >= value.observation.startMs;
  const check = (value, settled = false) => { const fail = [], missing = []; if (adapter) adapterResourceCheck(value, scope, raw?.processIdentity, fail, missing, { settled }); else resourceCheck(value, raw?.workload, fail, missing); return missing.length === 0; };
  const settledSamples = [raw?.B0?.resources, ...cycles.map(cycle => cycle.resources)];
  const activeSamples = cycles.flatMap(cycle => Array.isArray(cycle.resourceSamples) ? cycle.resourceSamples : []);
  const collectionComplete = samplingComplete && allSamplesPresent && settledSamples.every(value => sampleBound(value) && check(value, true)) && activeSamples.every(value => sampleBound(value) && check(value, false));
  const appObservationInventory = inventory && allSamplesPresent && cycles.every(cycle => !cycle.error && cycle.action) &&
    settledSamples.every(sampleBound) && activeSamples.every(sampleBound);
  const ruleCounts = new Map(); for (const rule of rules) ruleCounts.set(rule.name, (ruleCounts.get(rule.name) ?? 0) + 1);
  let growth;
  for (const rule of rules) {
    if (rule.source === 'separate-byte-audit') continue;
    let value = null, complete = false, evidence = null, method = null, reason = 'No complete metric-specific lifecycle collector evidence is available';
    if (scope === null || ruleCounts.get(rule.name) !== 1 || typeof rule.unit !== 'string' || !finite(rule.ceiling)) {
      unavailable.push({ name: rule.name, reason: 'Unique registry row and verified planned lifecycle resource scope are required' }); continue;
    }
    const key = resourceMetrics[rule.name];
    if (key) {
      if (scope === 'C' && ['browserRssBytes', 'gpuBytes', 'previewCacheBytes'].includes(key)) {
        unavailable.push({ name: rule.name, reason: 'Browser-owned resource row is inapplicable to the verified C backend WA cell; the planned registry must omit it' }); continue;
      }
      const peak = sampling?.peakSamples?.[key], scoredCpu = key === 'cpuBytes', appOwnedKey = scope === 'H' && ['cpuBytes', 'gpuBytes', 'previewCacheBytes'].includes(key);
      const browserContinuous = appOwnedKey ? browserCpuWindow(raw, sampling) : null;
      const cpuWindow = key === 'cpuBytes' ? (scope === 'C' ? backendCpuWindow(raw, sampling) : browserContinuous) : null;
      const appWindow = appOwnedKey ? browserAppOwnedAllocationWindow(raw, sampling, browserContinuous, key) : null;
      const observed = [...samples, peak].filter(item => sameProcess && sampleBound(item) && safeMeasurement(item[key]) &&
        (!scoredCpu || item.observation.startMs >= raw?.B0?.observation?.startMs && item.observation.endMs <= (scope === 'C' ? (sampling?.observationWindow?.endObservation?.endMs ?? raw?.endMs) : raw?.endMs)) &&
        (!appWindow?.peak || item.ordinal < appWindow.peak.endSourceOrdinal && item.observation.startMs >= appWindow.peak.startObservation.startMs && item.observation.endMs <= appWindow.peak.endObservation.endMs));
      if (observed.length) value = Math.max(...observed.map(item => item[key]));
      complete = rule.unit === 'bytes' && collectionComplete && samples.every(item => safeMeasurement(item[key])) && sampleBound(peak) && check(peak) && safeMeasurement(sampling.peaks?.[key]) && sampling.peaks[key] === peak[key] && value === peak[key];
      if (cpuWindow) {
        if (sameProcess && cpuWindow.peak) value = Math.max(value ?? 0, cpuWindow.peak.value);
        complete = rule.unit === 'bytes' && collectionComplete && cpuWindow.complete && samples.every(item => safeMeasurement(item[key])) && value === cpuWindow.peak.value;
      }
      // R18's reviewed application reservations have their own continuous
      // closure. They cannot promote global/native/RSS sampling completeness.
      if (appWindow?.peak && safeMeasurement(appWindow.value)) value = Math.max(value ?? 0, appWindow.value);
      if (appOwnedKey) complete = rule.unit === 'bytes' && appObservationInventory && sameProcess && appWindow?.complete === true && artifact.sha256 === sampling.sha256 &&
        raw.forcedGC === false && raw.processRestarted === false && value === appWindow.value;
      evidence = { artifact: retainedArtifact(artifact) ? artifact : null, resourceKey: key, sampledPeak: peak ?? null, ...(cpuWindow ? { continuousCpuWindow: cpuWindow.peak, lifetimePeakIsScored: false } : {}),
        ...(appWindow ? { appOwnedReservationWindow: appWindow.peak, scopedValue: appWindow.value ?? null, allocationScope: 'application-owned-conservative-reservations', globalCoverageComplete: false } : {}),
        observedValues: observed.map(item => ({ ordinal: item.ordinal ?? null, value: item[key], processIdentity: item.processIdentity ?? null })) };
      method = appOwnedKey ? complete ? 'Actual sealed application-owned conservative reservation maximum, with fixed reviewed source/native/build/runtime proof and reconciled per-kind B0/final ownership; global native and RSS coverage are separate' : 'Maximum of actual sampled observations and the structurally bound continuous reservation maximum; incomplete ownership makes this only a lower bound' : 'Maximum of actual attributed lifecycle resource observations, including the original sealed sampler peak witness; incomplete observations establish only a lower bound';
      reason = appOwnedKey ? 'A sealed continuous browser reservation window, reconciled app-owned witness and fixed reviewed source/native/build/runtime proof are required; an unapproved observation remains a scoped lower bound' : 'Complete retained resource sampling, exact peak witness and full cycle/resource ownership coverage are required';
    } else if (rule.name === 'R18TextureDeviceOr2048BoundViolations') {
      const known = [...new Map(samples.filter(item => sampleBound(item) && finite(item.textureSide) && finite(item.deviceTextureLimit) && item.deviceTextureLimit > 0).map(item => [item.ordinal, item])).values()];
      const breaches = known.filter(item => item.textureSide > Math.min(2048, item.deviceTextureLimit)).length;
      const texture = sampling?.textureLimits;
      const observedCounter = Number.isSafeInteger(texture?.violations) && texture.violations >= 0 ? texture.violations : null;
      value = observedCounter === null ? breaches || null : Math.max(breaches, observedCounter);
      complete = scope === 'H' && rule.unit === 'violations' && collectionComplete && texture?.complete === true && texture.observedSamples === sampling.counts.samples && observedCounter !== null && Number.isSafeInteger(texture.notApplicableSamples) && texture.notApplicableSamples >= 0 && texture.notApplicableSamples <= texture.observedSamples;
      evidence = { artifact: retainedArtifact(artifact) ? artifact : null, textureLimits: texture ?? null, observedBreaches: breaches };
      method = 'Actual per-observation texture-side/device-limit comparisons or independently approved renderer applicability across the complete retained sampling stream';
      reason = 'Complete per-observation texture bound counter and reviewed applicability are required';
    } else if (['R19FinalSettledGrowthBytes', 'R19WorstSettledGrowthBytes'].includes(rule.name)) {
      if (!adapter) {
        growth ??= evaluateLifecycle(raw).growth;
        value = rule.name === 'R19FinalSettledGrowthBytes' ? growth.finalBytes : growth.worstBytes;
        complete = rule.unit === 'bytes' && collectionComplete && safeMeasurement(raw?.B0?.resources?.settledBytes) && cycles.every(cycle => safeMeasurement(cycle.resources?.settledBytes));
        // An incomplete prefix has no final observation. Its intermediate
        // growth remains a valid lower bound for the separate worst row.
        if (rule.name === 'R19FinalSettledGrowthBytes' && cycles.length !== expected) value = null;
        evidence = { artifact: retainedArtifact(artifact) ? artifact : null, baseline: { ordinal: raw?.B0?.resources?.ordinal, value: raw?.B0?.resources?.settledBytes, processIdentity: raw?.B0?.resources?.processIdentity, observation: raw?.B0?.observation }, settled: cycles.map(cycle => ({ ordinal: cycle.ordinal, sampleOrdinal: cycle.resources?.ordinal, value: cycle.resources?.settledBytes, processIdentity: cycle.resources?.processIdentity, observation: cycle.observation })), growth };
        method = 'Nonnegative final and worst B_i minus independent B0 settled RSS, using evaluateLifecycle and actual post-idle observations of the same process and fixture';
        reason = 'Complete same-process lifecycle inventory and post-idle settled observations are required';
      }
    } else if (collectorBudgets.has(rule.budgetId)) {
      const observed = cycles.map(cycle => {
        const candidates = Array.isArray(cycle.action?.measurements) ? cycle.action.measurements.filter(item => item.name === rule.name) : [];
        if (candidates.length !== 1) return null;
        const item = candidates[0], proof = item.evidence;
        if (adapter && cell.host === 'H' && ['T06UnchangedOwnedAssetFetches','R32UnchangedOwnedAssetFetches','R32CacheIdentityMismatchCount'].includes(rule.name)) {
          const replay = readVerifiedBrowserWA(raw, cell)?.find(value => value.ordinal === cycle.ordinal);
          const verified = replay?.measurements?.find(value => value.name === rule.name);
          if (replay?.authenticated !== true || !verified || verified.value !== item.value || verified.unit !== item.unit || verified.complete !== item.complete) return null;
        }
        const coverage = proof?.coverage === 'complete-cycle-actions' || item.complete === false && proof?.coverage === 'observed-partial-cycle-actions';
        if (!safeMeasurement(item.value) || item.unit !== rule.unit || typeof item.method !== 'string' || !item.method.trim() || proof?.kind !== 'lifecycle-measurement-evidence-1' || proof.cellId !== cell.id || proof.cycleOrdinal !== cycle.ordinal || proof.processIdentity !== raw.processIdentity || proof.fixtureIdentity !== raw.fixtureIdentity || !coverage || !retainedArtifact(proof.artifact)) return null;
        return item;
      });
      const present = observed.filter(Boolean);
      if (present.length) value = rule.unit === 'violations' ? present.reduce((sum, item) => sum + item.value, 0) : Math.max(...present.map(item => item.value));
      complete = inventory && present.length === expected && present.every(item => item.complete === true) && safeMeasurement(value);
      evidence = present.map(item => ({ value: item.value, method: item.method, complete: item.complete === true, evidence: item.evidence }));
      method = rule.unit === 'violations' ? 'Sum of actual metric-specific violation counts across distinct bound lifecycle cycles' : 'Maximum of actual metric-specific observations across every bound lifecycle cycle';
      reason = 'Every planned cycle needs a unique complete metric-specific row with exact cell/process/fixture binding and retained collector proof';
    }
    if (safeMeasurement(value) && (complete || value > rule.ceiling)) measurements.push({ name: rule.name, value, unit: rule.unit, method, evidence, complete, ...(!complete ? { lowerBound: true } : {}) });
    if (!complete) unavailable.push({ name: rule.name, reason, ...(safeMeasurement(value) ? { observedLowerBound: value } : {}) });
  }
  return { measurements, unavailable };
}

export const deriveAdapterLifecycleMeasurements = deriveLifecycleMeasurements;

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

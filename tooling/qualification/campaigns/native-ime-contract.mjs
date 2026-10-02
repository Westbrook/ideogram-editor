import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {inspectTextPresentationWitness, nextPresentationTarget} from './text-presentation-observation.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const bounded = (value, max = 256) => typeof value === 'string' && value.length <= max;
const text = value => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 16384;
const keys = (value, names) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const freeze = value => {if (value && typeof value === 'object') {for (const item of Object.values(value)) freeze(item); Object.freeze(value);} return value;};
const demand = (condition, reason) => {if (!condition) throw Error(reason);};
const stateKeys = ['connected', 'parentUnchanged', 'nodeId', 'parentId', 'visible', 'focused', 'start', 'end', 'direction', 'scrollTop', 'scrollLeft', 'units', 'textHash', 'presentation', 'session', 'revision', 'textVersion', 'switch'];
const switchKeys = ['pending', 'request', 'requestEpoch', 'requestGeneration', 'requestTextVersion', 'settled', 'rejected', 'rejectedEpoch', 'rejectedGeneration', 'rejectedCurrentEpoch', 'rejectedCurrentGeneration', 'rejectedTextVersion', 'rejectedCurrentTextVersion', 'rejectedGuards', 'rejectedBoundary', 'reason', 'superseded'];
const rowKeys = ['ordinal', 'type', 'timeStampMs', 'observedMs', 'afterObservedMs', 'beforeCaptureOrdinal', 'afterCaptureOrdinal', 'isTrusted', 'composing', 'control', 'eventDataHash', 'inputType', 'before', 'after'];
const eventTypes = ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown', 'pointerdown', 'click', 'select', 'focusin', 'focusout', 'state'];
const stateValid = value => keys(value, stateKeys) && ['connected', 'parentUnchanged', 'visible', 'focused'].every(name => typeof value[name] === 'boolean') &&
  ['nodeId', 'parentId', 'start', 'end', 'units', 'textVersion'].every(name => integer(value[name])) && value.nodeId > 0 && value.parentId > 0 && value.units <= 16384 &&
  value.start <= value.end && value.end <= value.units && ['forward', 'backward', 'none'].includes(value.direction) &&
  ['scrollTop', 'scrollLeft'].every(name => typeof value[name] === 'number' && Number.isFinite(value[name])) && sha(value.textHash) &&
  ['anchored', 'inspector'].includes(value.presentation) && bounded(value.session) && bounded(value.revision, 128) && /^(0|[1-9][0-9]*)$/.test(value.revision) &&
  keys(value.switch, switchKeys) && ['', 'anchored', 'inspector'].includes(value.switch.pending) &&
  ['request', 'requestEpoch', 'requestGeneration', 'requestTextVersion', 'settled', 'rejected', 'superseded', 'rejectedGuards'].every(name => integer(value.switch[name])) && value.switch.rejectedGuards <= 15 &&
  ['rejectedEpoch', 'rejectedGeneration', 'rejectedCurrentEpoch', 'rejectedCurrentGeneration', 'rejectedTextVersion', 'rejectedCurrentTextVersion'].every(name => value.switch[name] === null || integer(value.switch[name])) &&
  bounded(value.switch.rejectedBoundary, 64) && (value.switch.reason === null || bounded(value.switch.reason, 128));
const acceptedValid = value => keys(value, ['documentId', 'documentRevision', 'imageDigest', 'layerId', 'layerVersion', 'sourceHash']) &&
  ['documentId', 'documentRevision', 'layerId', 'layerVersion'].every(name => bounded(value[name]) && value[name].length > 0) && sha(value.imageDigest) && sha(value.sourceHash);

/** Data-only references to the existing sealed corpus. It never types, changes
 * an input source, or authorizes an operator/reviewer receipt. */
export function buildNativeImePlan(fixture, workload) {
  demand(['WXn', 'WXs'].includes(workload), 'NATIVE_IME_WORKLOAD');
  const corpus = fixture?.text?.corpus;
  demand(corpus && text(corpus.text) && corpus.text.length > 0 && sha(corpus.sha256) && hash(corpus.text) === corpus.sha256, 'NATIVE_IME_CORPUS');
  demand(Array.isArray(corpus.fragments) && corpus.fragments.length >= 20 && corpus.fragments.length <= 256 && corpus.fragments.every(value => text(value) && value.length > 0), 'NATIVE_IME_FRAGMENTS');
  demand(corpus.fragments.reduce((n, value) => n + Buffer.byteLength(value, 'utf8'), 0) <= 1048576 && sha(corpus.fragmentsHash) && hash(JSON.stringify(corpus.fragments)) === corpus.fragmentsHash, 'NATIVE_IME_FRAGMENTS_HASH');
  const fragmentIndex = workload === 'WXn' ? 10 : 3;
  return freeze({kind: 'native-ime-plan-1', workload, inputSource: workload === 'WXn' ? 'japanese' : 'simplified-chinese', durationMs: 60000,
    corpusHash: corpus.sha256, fragmentsHash: corpus.fragmentsHash,
    sequences: Array.from({length: 10}, (_, index) => ({index, fragmentIndex, fragmentHash: hash(corpus.fragments[fragmentIndex]), outcome: index === 7 || index === 9 ? 'cancel' : 'commit', cancelSession: index === 9,
      presentations: index < 3 ? [{sequence: index + 1, mode: 'immediate', range: ['forward', 'backward', 'none'][index]}] :
        index === 8 ? [{sequence: 4, mode: 'deferred'}, {sequence: 5, mode: 'deferred-latest'}] : index === 9 ? [{sequence: 6, mode: 'deferred-cancelled'}] : []}))});
}

/** Structural compatibility only. Trusted browser events are necessary, never
 * sufficient evidence of an OS IME. The parent issuer/reviewer joins real source,
 * process, input-source and independent review authority to this exact trace. */
export function inspectNativeImeTrace(raw, {fixture, plan, nonce, acceptedBefore, acceptedAfter} = {}) {
  const missing = [], failures = [], sequences = [], requestObservations = [];
  const miss = (condition, reason) => {if (!condition) missing.push(reason);};
  const fail = (condition, reason) => {if (condition) failures.push(reason);};
  let expectedPlan;
  try {expectedPlan = buildNativeImePlan(fixture, plan?.workload);} catch {missing.push('sealed-native-ime-plan-unavailable');}
  if (expectedPlan) fail(!isDeepStrictEqual(plan, expectedPlan), 'native-ime-plan-differs');
  miss(acceptedValid(acceptedBefore) && acceptedValid(acceptedAfter), 'accepted-document-layer-identity-unavailable');
  if (acceptedValid(acceptedBefore) && acceptedValid(acceptedAfter)) fail(!isDeepStrictEqual(acceptedBefore, acceptedAfter), 'accepted-document-layer-changed');
  const result = (presentation = null) => ({status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS', missing: [...new Set(missing)], failures: [...new Set(failures)],
    observation: {kind: 'native-ime-trace-observation-1', workload: expectedPlan?.workload ?? null, inputSource: expectedPlan?.inputSource ?? null,
      durationMs: 60000, sequences, compositionCount: sequences.length, commits: sequences.filter(value => value.outcome === 'commit' && value.outcomeObserved).length,
      cancels: sequences.filter(value => value.outcome === 'cancel' && value.outcomeObserved).length, presentationRequests: requestObservations.length, presentation,
      acceptedStateUnchanged: acceptedValid(acceptedBefore) && acceptedValid(acceptedAfter) ? isDeepStrictEqual(acceptedBefore, acceptedAfter) : null,
      qualification: false, nativeImeAuthority: false, trustedEventsAreSufficient: false, physicalInput: false, physicalMetrics: false,
      boundary: 'Passive native-event compatibility; independent same-attempt operator/source review and retained replay authority are required. No physical input, paint, or latency qualification.'}});
  if (!expectedPlan) return result();
  const rawKeys = ['kind', 'nonce', 'clock', 'timeOrigin', 'armedMs', 'startMs', 'endMs', 'captureStoppedMs', 'durationMs', 'initial', 'final', 'records', 'overflow', 'interruptions', 'cleanup'];
  miss(keys(raw, rawKeys) && raw.kind === 'native-ime-raw-1', 'native-ime-raw-envelope-unavailable');
  if (!raw || typeof raw !== 'object') return result();
  fail(!token(nonce) || raw.nonce !== nonce, 'native-ime-attempt-nonce-differs');
  const windowValid = raw.clock === 'browser-performance' && time(raw.timeOrigin) && raw.timeOrigin > 0 && time(raw.armedMs) && time(raw.startMs) &&
    raw.startMs >= raw.armedMs && raw.endMs === raw.startMs + 60000 && raw.durationMs === 60000 && time(raw.captureStoppedMs) && raw.captureStoppedMs >= raw.endMs;
  miss(windowValid, 'exact-native-ime-window-unavailable');
  miss(raw.overflow === false, 'native-ime-observer-overflow');
  miss(Array.isArray(raw.interruptions) && raw.interruptions.length === 0, 'uninterrupted-native-ime-observation-unavailable');
  miss(keys(raw.cleanup, ['removed']) && raw.cleanup.removed === true, 'native-ime-observer-cleanup-unavailable');
  miss(stateValid(raw.initial) && stateValid(raw.final), 'complete-native-ime-endpoint-state-unavailable');
  const rows = Array.isArray(raw.records) && raw.records.length <= 4096 ? raw.records : [];
  miss(rows.length > 0, 'bounded-native-ime-records-unavailable');
  if (!windowValid || !stateValid(raw.initial) || !rows.length) return result();
  fail(raw.initial.textHash !== expectedPlan.corpusHash || raw.initial.units !== fixture.text.corpus.text.length, 'native-ime-initial-corpus-differs');
  fail(!raw.initial.session || raw.initial.switch.request !== 0, 'native-ime-initial-session-or-request-state-differs');
  const events = [], points = [];
  let lastObserved = raw.startMs, lastCapture = -1, allRowsValid = true;
  for (const [index, row] of rows.entries()) {
    const valid = keys(row, rowKeys) && row.ordinal === index && eventTypes.includes(row.type) && ['text', 'presentation', 'cancel', 'other'].includes(row.control) &&
      time(row.observedMs) && time(row.afterObservedMs) && row.afterObservedMs >= row.observedMs &&
      integer(row.beforeCaptureOrdinal) && integer(row.afterCaptureOrdinal) &&
      typeof row.composing === 'boolean' && (row.eventDataHash === null || sha(row.eventDataHash)) && (row.inputType === null || bounded(row.inputType, 128)) &&
      (row.type === 'state' ? row.isTrusted === null && row.timeStampMs === null && row.observedMs === row.afterObservedMs && row.beforeCaptureOrdinal === row.afterCaptureOrdinal :
        typeof row.isTrusted === 'boolean' && time(row.timeStampMs) && row.timeStampMs <= row.observedMs && row.afterCaptureOrdinal > row.beforeCaptureOrdinal) && stateValid(row.before) && stateValid(row.after);
    miss(valid, 'complete-native-ime-event-state-unavailable');
    if (!valid) { allRowsValid = false; continue; }
    fail(row.observedMs < lastObserved || row.beforeCaptureOrdinal <= lastCapture, 'native-ime-event-order-differs');
    lastObserved = row.observedMs; lastCapture = row.beforeCaptureOrdinal;
    const eventTime = row.type === 'state' ? row.observedMs : row.timeStampMs;
    fail(eventTime < raw.startMs || eventTime > raw.endMs, 'native-ime-event-outside-window');
    miss(row.observedMs <= raw.endMs, 'native-ime-event-observed-after-window');
    fail(row.control === 'other', 'unrelated-native-ime-activity');
    if (row.type !== 'state') fail(row.isTrusted !== true, 'untrusted-native-ime-event');
    if (row.type === 'state') fail(!isDeepStrictEqual(row.before, row.after), 'native-ime-state-row-differs');
    if (eventTime < raw.startMs || eventTime > raw.endMs || row.observedMs > raw.endMs) continue;
    events.push(row);
    points.push({state: row.before, atMs: row.observedMs, capture: row.beforeCaptureOrdinal, ordinal: row.ordinal, phase: 'before'});
    if (row.type !== 'state' && row.afterObservedMs <= raw.endMs) points.push({state: row.after, atMs: row.afterObservedMs, capture: row.afterCaptureOrdinal, ordinal: row.ordinal, phase: 'after'});
  }
  // Shape bounds precede serialization; unbounded caller objects are never copied.
  if (allRowsValid && keys(raw, rawKeys) && raw.kind === 'native-ime-raw-1' && token(raw.nonce) && typeof raw.overflow === 'boolean' && stateValid(raw.final) &&
    Array.isArray(raw.interruptions) && raw.interruptions.length === 0 && keys(raw.cleanup, ['removed']) && typeof raw.cleanup.removed === 'boolean')
    miss(Buffer.byteLength(JSON.stringify(raw), 'utf8') <= 8 * 1024 * 1024, 'bounded-native-ime-serialized-trace-unavailable');
  points.sort((a, b) => a.capture - b.capture);
  for (let index = 1; index < points.length; index++) fail(points[index].capture === points[index - 1].capture || points[index].atMs < points[index - 1].atMs, 'native-ime-snapshot-capture-order-differs');
  const initiating = events.find(row => row.isTrusted === true && ['keydown', 'pointerdown', 'compositionstart', 'compositionupdate', 'compositionend'].includes(row.type));
  miss(!!initiating, 'native-ime-starting-native-event-unavailable');
  if (initiating) fail(initiating.timeStampMs !== raw.startMs, 'native-ime-start-is-not-first-native-event');
  let active;
  const spans = [];
  for (const row of events) {
    if (row.type === 'compositionstart') {
      fail(!!active, 'overlapping-native-ime-compositions');
      if (!active) active = {start: row, inputs: []};
    } else if (row.type === 'compositionupdate') {fail(!active, 'orphan-native-ime-composition-update');}
    else if (row.type === 'compositionend') {
      fail(!active, 'orphan-native-ime-composition-end');
      if (active) {active.end = row; spans.push(active); active = undefined;}
    } else if (row.type === 'input' && active) active.inputs.push(row);
    if (['compositionstart', 'compositionupdate', 'compositionend', 'input', 'beforeinput'].includes(row.type)) fail(row.control !== 'text', 'native-ime-composition-target-differs');
    if (['input', 'beforeinput'].includes(row.type)) fail(/paste|drop|history/i.test(row.inputType ?? ''), 'native-ime-noncomposition-edit-observed');
  }
  miss(!active, 'native-ime-composition-end-unavailable');
  miss(spans.length === 10, 'exact-ten-native-ime-compositions-unavailable');
  fail(spans.length > 10, 'extra-native-ime-composition');
  const terminalEnd = spans[9]?.end;
  let previousRevision = BigInt(raw.initial.revision), previousTextVersion = raw.initial.textVersion;
  for (const point of points) {
    const s = point.state;
    fail(!s.connected || !s.parentUnchanged || s.nodeId !== 1 || s.parentId !== 1, 'native-ime-node-or-parent-changed');
    fail(BigInt(s.revision) < previousRevision || s.textVersion < previousTextVersion, 'native-ime-version-regressed');
    previousRevision = BigInt(s.revision); previousTextVersion = s.textVersion;
    const afterFinalEnd = !!terminalEnd && point.capture > terminalEnd.beforeCaptureOrdinal;
    fail((!s.visible || s.session !== raw.initial.session) && !(afterFinalEnd && s.session === ''), 'native-ime-session-hidden-or-replaced-before-native-end');
    for (const span of spans) if (point.capture >= span.start.afterCaptureOrdinal && point.capture < span.end.beforeCaptureOrdinal) fail(!s.visible || !s.focused, 'native-ime-focus-or-visibility-lost-during-composition');
  }
  let expectedText = fixture.text.corpus.text;
  for (const [index, span] of spans.slice(0, 10).entries()) {
    const item = expectedPlan.sequences[index], before = span.start.before, nextStart = spans[index + 1]?.start.beforeCaptureOrdinal ?? Infinity;
    fail(before.textHash !== hash(expectedText) || before.units !== expectedText.length, 'native-ime-sequence-start-value-differs');
    const prefix = expectedText.slice(0, before.start), suffix = expectedText.slice(before.end), fragment = fixture.text.corpus.fragments[item.fragmentIndex];
    fail(!prefix.isWellFormed() || !suffix.isWellFormed(), 'native-ime-selection-splits-scalar');
    const desired = item.outcome === 'commit' ? prefix + fragment + suffix : expectedText, desiredHash = hash(desired);
    fail(!text(desired), 'native-ime-result-exceeds-admitted-text');
    const interval = points.filter(point => point.capture >= span.end.beforeCaptureOrdinal && point.capture < nextStart);
    // Native engines may commit input before or after compositionend. The end
    // event's real before-state is eligible; empty event data alone is never proof.
    const terminal = interval.find(point => point.state.session === raw.initial.session && point.state.textHash === desiredHash && point.state.units === desired.length && point.state.textVersion > before.textVersion);
    const inputObserved = span.inputs.some(row => row.isTrusted === true && row.control === 'text' && (row.composing || /composition/i.test(row.inputType ?? '')));
    miss(inputObserved, 'native-ime-input-evidence-unavailable');
    miss(!!terminal, 'native-ime-outcome-state-unavailable');
    if (terminal) for (const point of interval.filter(value => value.capture >= terminal.capture)) fail(point.state.session !== '' && point.state.textHash !== desiredHash, 'native-ime-text-changed-after-sequence-outcome');
    const atNextStart = spans[index + 1]?.start.before;
    if (atNextStart) fail(atNextStart.textHash !== desiredHash || atNextStart.units !== desired.length, 'native-ime-commit-or-cancel-outcome-differs');
    sequences.push({index, fragmentIndex: item.fragmentIndex, fragmentHash: item.fragmentHash, outcome: item.outcome, cancelSession: item.cancelSession,
      startOrdinal: span.start.ordinal, endOrdinal: span.end.ordinal, startingRange: {start: before.start, end: before.end, direction: before.direction},
      startingTextHash: hash(expectedText), expectedTextHash: desiredHash, outcomeObserved: !!terminal && inputObserved,
      terminal: terminal ? {ordinal: terminal.ordinal, phase: terminal.phase, atMs: terminal.atMs, textHash: terminal.state.textHash} : null});
    expectedText = desired;
  }
  const clicks = events.filter(row => row.type === 'click' && row.control === 'presentation' && row.isTrusted === true);
  const cancels = events.filter(row => row.type === 'click' && row.control === 'cancel' && row.isTrusted === true);
  miss(clicks.length === 6, 'exact-six-native-presentation-clicks-unavailable'); fail(clicks.length > 6, 'extra-native-presentation-click');
  miss(cancels.length === 1, 'exact-explicit-native-cancel-unavailable'); fail(cancels.length > 1, 'extra-explicit-native-cancel');
  const requests = expectedPlan.sequences.flatMap(item => item.presentations.map(request => ({...request, composition: item.index})));
  for (const [index, item] of requests.entries()) {
    const click = clicks[index], next = clicks[index + 1]?.beforeCaptureOrdinal ?? Infinity, span = spans[item.composition];
    if (!click || !span) continue;
    const target = nextPresentationTarget(click.before), deferred = item.mode !== 'immediate';
    fail(click.before.switch.request !== index, 'native-ime-request-sequence-before-click-differs');
    fail(deferred ? click.beforeCaptureOrdinal < span.start.beforeCaptureOrdinal || click.beforeCaptureOrdinal >= span.end.beforeCaptureOrdinal : click.beforeCaptureOrdinal >= span.start.beforeCaptureOrdinal || item.composition > 0 && click.beforeCaptureOrdinal <= spans[item.composition - 1]?.end.beforeCaptureOrdinal, 'native-ime-request-composition-placement-differs');
    const boundary = deferred ? span.end.beforeCaptureOrdinal : span.start.beforeCaptureOrdinal;
    const after = points.find(point => point.capture > click.beforeCaptureOrdinal && point.capture < Math.min(next, boundary) && point.state.switch.request === item.sequence &&
      (deferred ? point.state.switch.pending === target && point.state.presentation === click.before.presentation : point.state.switch.settled === item.sequence && point.state.presentation === target));
    miss(!!after, 'native-ime-request-result-state-unavailable');
    if (!after) continue;
    if (!deferred) {
      fail(click.before.direction !== item.range || (item.range === 'none' ? click.before.start !== click.before.end : click.before.start === click.before.end), 'native-ime-request-range-differs');
      fail(['start', 'end', 'direction', 'scrollTop', 'scrollLeft', 'textHash', 'session', 'nodeId', 'parentId'].some(name => click.before[name] !== after.state[name]), 'native-ime-immediate-range-or-node-not-preserved');
    }
    requestObservations.push({actionId: 'native-ime-presentation-' + item.sequence, mode: item.mode, target, before: click.before, after: after.state});
  }
  fail(points.some(point => point.state.switch.request > 6), 'extra-native-presentation-request');
  let presentation = null;
  const latestSpan = spans[8], finalSpan = spans[9], cancel = cancels[0];
  if (requestObservations.length === 6 && latestSpan && finalSpan && cancel) {
    fail(cancel.beforeCaptureOrdinal <= clicks[5].beforeCaptureOrdinal || cancel.beforeCaptureOrdinal >= finalSpan.end.beforeCaptureOrdinal, 'native-ime-explicit-cancel-placement-differs');
    const latestAfter = points.find(point => point.capture > latestSpan.end.beforeCaptureOrdinal && point.capture < finalSpan.start.beforeCaptureOrdinal && point.state.switch.settled === 5 && point.state.switch.pending === '');
    const cancelAfter = points.find(point => point.capture > finalSpan.end.beforeCaptureOrdinal && point.state.session === '' && point.state.switch.rejected === 6);
    miss(!!latestAfter && !!cancelAfter, 'native-ime-native-end-settlement-unavailable');
    if (latestAfter && cancelAfter) {
      presentation = inspectTextPresentationWitness({kind: 'text-presentation-observation-1', requests: requestObservations,
        latest: {beforeEnd: latestSpan.end.before, afterEnd: latestAfter.state}, cancellation: {beforeCancel: cancel.before, afterCancel: cancelAfter.state}});
      missing.push(...presentation.missing); failures.push(...presentation.failures);
    }
  } else missing.push('complete-native-ime-presentation-witness-unavailable');
  miss(sequences.length === 10 && sequences.filter(value => value.outcome === 'commit' && value.outcomeObserved).length === 8 && sequences.filter(value => value.outcome === 'cancel' && value.outcomeObserved).length === 2, 'native-ime-eight-commit-two-cancel-outcomes-unavailable');
  if (stateValid(raw.final)) fail(raw.final.nodeId !== 1 || raw.final.parentId !== 1 || !raw.final.connected || !raw.final.parentUnchanged, 'native-ime-final-node-or-parent-changed');
  return result(presentation);
}

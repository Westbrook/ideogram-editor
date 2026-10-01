/**
 * Browser presentation evidence, PERF §3 R04/R07 and §5 D05.
 *
 * This is a bounded decoder for Chromium's exported trace, not a native screen
 * capture adapter. Exact input/surface/display joins are useful diagnostics, but
 * neither EventLatency nor Display::FrameDisplayed carries the hardware/failure
 * flags needed here. No currently implemented native source can qualify pixels.
 * Keep that limitation executable: caller-supplied flags, DOM witnesses, source
 * profiles, and "is_presented" booleans cannot turn these results into a pass.
 */
export const PRESENTATION_SOURCE_REFERENCES = Object.freeze({
  readOn: '2026-09-30',
  eventLatency: 'https://chromium.googlesource.com/chromium/src/+/refs/heads/main/cc/metrics/event_latency_tracing_recorder.cc',
  schema: 'https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/tracing/protos/chrome_track_event.proto',
  display: 'https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/viz/service/display/display.cc',
  feedback: 'https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/gfx/presentation_feedback.h',
  exporter: 'https://github.com/google/perfetto/blob/main/src/trace_processor/export_json.cc',
  pipeline: 'https://github.com/google/perfetto/blob/main/src/trace_processor/perfetto_sql/stdlib/chrome/graphics_pipeline.sql',
  latencySql: 'https://github.com/google/perfetto/blob/main/src/trace_processor/perfetto_sql/stdlib/chrome/event_latency.sql',
});

export const PRESENTATION_TRACE_CATEGORIES = Object.freeze(['cc', 'benchmark', 'input', 'input.scrolling', 'viz', 'graphics.pipeline', 'blink.user_timing', 'disabled-by-default-display.framedisplayed']);
const CATEGORIES = new Set(PRESENTATION_TRACE_CATEGORIES);
const MAX_EVENTS = 1_000_000;
const MAX_IDS = 4096;
const TIME = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const SMALL_ID = value => Number.isSafeInteger(value) && value >= 0;
const int64Max = (1n << 63n) - 1n;
const uint64Max = (1n << 64n) - 1n;
const STAGES = new Set(['SwapEndToPresentationCompositorFrame', 'LatchToPresentation', 'SwapStartToPresentation', 'LatchToSwapEnd']);
const ENDPOINTS = new Set([...STAGES].filter(name => name !== 'LatchToSwapEnd'));
const EVENT_TYPES = new Set(['MOUSE_PRESSED', 'MOUSE_RELEASED', 'MOUSE_WHEEL', 'KEY_PRESSED', 'KEY_RELEASED', 'TOUCH_PRESSED', 'TOUCH_RELEASED', 'TOUCH_MOVED', 'GESTURE_SCROLL_BEGIN', 'GESTURE_SCROLL_UPDATE', 'GESTURE_SCROLL_END', 'GESTURE_DOUBLE_TAP', 'GESTURE_LONG_PRESS', 'GESTURE_LONG_TAP', 'GESTURE_SHOW_PRESS', 'GESTURE_TAP', 'GESTURE_TAP_CANCEL', 'GESTURE_TAP_DOWN', 'GESTURE_TAP_UNCONFIRMED', 'GESTURE_TWO_FINGER_TAP', 'FIRST_GESTURE_SCROLL_UPDATE', 'MOUSE_DRAGGED', 'GESTURE_PINCH_BEGIN', 'GESTURE_PINCH_END', 'GESTURE_PINCH_UPDATE', 'INERTIAL_GESTURE_SCROLL_UPDATE', 'MOUSE_MOVED_EVENT', 'INERTIAL_GESTURE_SCROLL_END']);
const STEPS = new Map([[9, 'STEP_SUBMIT_COMPOSITOR_FRAME'], [10, 'STEP_SURFACE_AGGREGATION'], [11, 'STEP_SEND_BUFFER_SWAP'], [12, 'STEP_BUFFER_SWAP_POST_SUBMIT'], [13, 'STEP_FINISH_BUFFER_SWAP'], [14, 'STEP_SWAP_BUFFERS_ACK'], [21, 'STEP_DRAW_AND_SWAP']]);
const STEP_NAMES = new Set(STEPS.values());

// Typed proto IDs are int64. Reject lossy JSON numbers rather than accidentally
// associating neighboring frames. Async exporter track IDs are uint64 instead.
function identifier(value, maximum = int64Max) {
  if (typeof value === 'number') {
    if (!SMALL_ID(value)) return null;
    value = BigInt(value);
  } else if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19}|0x[0-9a-fA-F]{1,16})$/.test(value)) value = BigInt(value);
  else if (typeof value !== 'bigint') return null;
  return value >= 0n && value <= maximum ? value.toString() : null;
}

function identities(values) {
  if (!Array.isArray(values) || values.length > MAX_IDS) return null;
  const ids = values.map(value => identifier(value));
  return ids.some(id => id === null) ? null : [...new Set(ids)];
}

function track(event) {
  // Perfetto's JSON exporter uses its track identity, NOT display_trace_id, as
  // an async id. Local identities must also retain the originating process.
  const scopes = [event.id2?.local !== undefined && ['local', event.id2.local], event.id2?.global !== undefined && ['global', event.id2.global], event.id !== undefined && ['global', event.id]].filter(Boolean);
  if (scopes.length !== 1) return null;
  const [scope, value] = scopes[0], id = identifier(value, uint64Max);
  return id === null ? null : {scope, id, ...(scope === 'local' ? {pid: event.pid} : {})};
}

function validTrack(value) {
  if (!value || !['local', 'global'].includes(value.scope) || identifier(value.id, uint64Max) === null || (value.scope === 'local' && !SMALL_ID(value.pid))) return null;
  return {scope: value.scope, id: identifier(value.id, uint64Max), ...(value.scope === 'local' ? {pid: value.pid} : {})};
}

function key(value) {return value ? `${value.scope}:${value.pid ?? ''}:${value.id}` : null;}

/** Only fixed event/enum names, bounded numeric identities and times survive. */
export function sanitizePresentationTraceEvent(event) {
  if (!event || !SMALL_ID(event.pid) || !SMALL_ID(event.tid) || !TIME(event.ts)) return null;
  const cats = typeof event.cat === 'string' ? event.cat.split(',') : [];
  if (!cats.some(cat => CATEGORIES.has(cat))) return null;
  const base = {ts: event.ts, pid: event.pid, tid: event.tid};
  if (cats.includes('blink.user_timing')) {
    const match = /^ie\.perf\.v1:(clock-before|clock-after):([0-9]{1,15})$/.exec(event.name ?? '');
    const normalized = event.name === 'presentation-clock-mark' && ['clock-before', 'clock-after'].includes(event.kind) && SMALL_ID(event.markId);
    if ((!match && !normalized) || !['I', 'i', 'R'].includes(event.ph)) return null;
    return {cat: 'blink.user_timing', name: 'presentation-clock-mark', ph: 'I', ...base, kind: normalized ? event.kind : match[1], markId: normalized ? event.markId : Number(match[2])};
  }
  if (!['b', 'e', 'X', 'B', 'E', 'I', 'i', 'n'].includes(event.ph)) return null;
  if (event.ph === 'X' && (!TIME(event.dur) || !TIME(event.ts + event.dur))) return null;
  const phase = {ph: event.ph, ...(event.ph === 'X' ? {dur: event.dur} : {})};
  if (event.name === 'Display::FrameDisplayed') return {cat: 'viz', name: event.name, ...base, ...phase};
  if (event.name === 'EventLatency' || STAGES.has(event.name)) {
    // Legacy exporter scopes are arbitrary strings. Until their identity can be
    // retained safely, do not collapse differently scoped tracks onto one ID.
    if (event.scope !== undefined && event.scope !== '') return null;
    const identity = event.track ? validTrack(event.track) : track(event);
    if (!identity || (identity.scope === 'local' && identity.pid !== event.pid)) return null;
    const result = {cat: 'cc', name: event.name, ...base, ...phase, track: identity};
    if (event.name === 'EventLatency' && event.ph !== 'e' && event.ph !== 'E') {
      const data = event.latency ?? event.args?.event_latency;
      if (!data || typeof data !== 'object') return null;
      const latencyId = identifier(data.event_latency_id), surfaceId = identifier(data.surface_frame_trace_id), displayId = identifier(data.display_trace_id);
      if (latencyId === null) return null;
      // A missing/stripped frame field stays missing; a malformed supplied ID
      // invalidates this record, including Chromium's -1 unknown sentinel.
      if ((data.surface_frame_trace_id !== undefined && surfaceId === null) || (data.display_trace_id !== undefined && displayId === null)) return null;
      const eventType = EVENT_TYPES.has(data.event_type) ? data.event_type : 'UNKNOWN';
      result.latency = {event_latency_id: latencyId, event_type: eventType,
        ...(surfaceId === null ? {} : {surface_frame_trace_id: surfaceId}), ...(displayId === null ? {} : {display_trace_id: displayId})};
    }
    return result;
  }
  if (event.name !== 'Graphics.Pipeline' || ['e', 'E'].includes(event.ph)) return null;
  const data = event.pipeline ?? event.args?.chrome_graphics_pipeline;
  if (!data || typeof data !== 'object') return null;
  const step = STEP_NAMES.has(data.step) ? data.step : STEPS.get(data.step);
  if (!step) return null;
  const surface = identifier(data.surface_frame_trace_id), display = identifier(data.display_trace_id);
  if ((data.surface_frame_trace_id !== undefined && surface === null) || (data.display_trace_id !== undefined && display === null)) return null;
  const latencyIds = data.latency_ids === undefined ? undefined : identities(data.latency_ids);
  const aggregatedIds = data.aggregated_surface_frame_trace_ids === undefined ? undefined : identities(data.aggregated_surface_frame_trace_ids);
  if (latencyIds === null || aggregatedIds === null || (surface === null && display === null)) return null;
  return {cat: 'graphics.pipeline', name: 'Graphics.Pipeline', ...base, ...phase, pipeline: {step,
    ...(surface === null ? {} : {surface_frame_trace_id: surface}), ...(display === null ? {} : {display_trace_id: display}),
    ...(latencyIds === undefined ? {} : {latency_ids: latencyIds}), ...(aggregatedIds === undefined ? {} : {aggregated_surface_frame_trace_ids: aggregatedIds})}};
}

function spans(events) {
  const result = [], open = new Map(), rejected = new Set();
  let malformed = 0;
  // Sort stably: export stream order at tied timestamps matters for nested ends.
  for (const event of events.filter(event => event.name === 'EventLatency' || STAGES.has(event.name)).sort((left, right) => left.ts - right.ts)) {
    const token = key(event.track) + ':' + event.name;
    if (event.ph === 'X') result.push({...event, endUs: event.ts + event.dur});
    else if (event.ph === 'b' || event.ph === 'B') {
      if (open.has(token)) {rejected.add(token); malformed++;}
      open.set(token, event);
    } else if (event.ph === 'e' || event.ph === 'E') {
      const start = open.get(token); open.delete(token);
      if (!start || rejected.has(token) || event.ts < start.ts) malformed++;
      else result.push({...start, endUs: event.ts});
    }
  }
  return {values: result, malformed: malformed + open.size};
}

function unique(values) {return [...new Set(values)];}
function complete(trace) {return trace?.clock === 'chromium-monotonic-microseconds' && trace?.collection?.status === 'complete' && trace.collection.completeEventReceived === true && Array.isArray(trace.collection.reasons) && trace.collection.reasons.length === 0;}

/** Causal bounds, not an affine guess between Node and browser clock origins. */
export function presentationClockBounds(trace, bracket) {
  return clockBounds(trace, bracket);
}

function clockBounds(trace, bracket, retainedMarks) {
  const unavailable = reason => ({status: 'unavailable', reason, clock: 'chromium-monotonic-microseconds'});
  if (!complete(trace)) return unavailable('trace-incomplete-or-clock-unknown');
  if (bracket?.kind !== 'browser-trace-action-bracket-1' || !SMALL_ID(bracket.id) || bracket.status !== 'complete' || bracket.actionCompleted !== true || bracket.sameDocument !== true) return unavailable('causal-action-bracket-missing');
  if (!TIME(bracket.browserTimeOrigin) || !TIME(bracket.beforeBrowserMs) || !TIME(bracket.afterBrowserMs) || bracket.beforeBrowserMs > bracket.afterBrowserMs) return unavailable('causal-action-clock-witness-invalid');
  if (!Array.isArray(trace.events) || trace.events.length > MAX_EVENTS) return unavailable('trace-event-bound-exceeded');
  const marks = retainedMarks ? retainedMarks.get(bracket.id) ?? [] : trace.events.map(sanitizePresentationTraceEvent).filter(event => event?.name === 'presentation-clock-mark' && event.markId === bracket.id);
  const before = marks.filter(event => event.kind === 'clock-before'), after = marks.filter(event => event.kind === 'clock-after');
  if (before.length !== 1 || after.length !== 1) return unavailable('causal-clock-marks-missing-or-ambiguous');
  if (before[0].pid !== after[0].pid || before[0].tid !== after[0].tid || before[0].ts > after[0].ts) return unavailable('causal-clock-lane-or-order-mismatch');
  return {status: 'bounded', clock: 'chromium-monotonic-microseconds', earliestUs: before[0].ts, latestUs: after[0].ts, uncertaintyUs: after[0].ts - before[0].ts,
    method: 'awaited-trace-mark-before-action-and-after-action', exact: false};
}

/**
 * Wrap only the actual save, not the later DOM wait. Both marks are awaited, so
 * the save occurred between their trace timestamps regardless of RPC delays or
 * drift between runner and browser clocks. Collection overhead stays in the run.
 * The returned value is unchanged. Failed instrumentation yields missing clock
 * evidence without losing a completed save receipt. The action's own error is
 * still propagated; no successful bracket is produced for a failed action.
 */
export async function bracketTraceAction({page, id, run, markTimeoutMs = 10000}) {
  if (!SMALL_ID(id) || String(id).length > 15 || typeof run !== 'function' || typeof page?.evaluate !== 'function' || !Number.isSafeInteger(markTimeoutMs) || markTimeoutMs < 1 || markTimeoutMs > 60000) throw Error('Invalid presentation clock action');
  const mark = async kind => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => page.evaluate(({name}) => ({timeOrigin: performance.timeOrigin, startMs: performance.mark(name).startTime}), {name: `ie.perf.v1:${kind}:${id}`})),
        new Promise((_, reject) => {timer = setTimeout(() => reject(Error('clock mark unavailable')), markTimeoutMs);}),
      ]);
    } finally {clearTimeout(timer);}
  };
  let before, after, instrumentationFailure;
  try {before = await mark('clock-before');} catch {instrumentationFailure = 'before-action-clock-mark-unavailable';}
  const value = await run();
  try {after = await mark('clock-after');} catch {instrumentationFailure ??= 'after-action-clock-mark-unavailable';}
  const valid = TIME(before?.timeOrigin) && TIME(after?.timeOrigin) && TIME(before?.startMs) && TIME(after?.startMs) && before.timeOrigin === after.timeOrigin && before.startMs <= after.startMs;
  return {value, bracket: {kind: 'browser-trace-action-bracket-1', id, status: valid ? 'complete' : 'unavailable', actionCompleted: true, sameDocument: valid,
    ...(valid ? {browserTimeOrigin: before.timeOrigin, beforeBrowserMs: before.startMs, afterBrowserMs: after.startMs} : {reason: instrumentationFailure ?? 'document-or-clock-changed-during-action'})}};
}

/**
 * Inspect one independently collected trace only: identities never cross runs.
 * requests use {id, latencyId?} for input or {id,start:{kind:'bracketed-save',
 * bracket}} for file save. Missing native-input IDs are never guessed by nearest
 * timestamp. productPhases/nativeEvidence may be retained by callers, but are
 * deliberately NOT accepted as physical feedback or content/frame provenance.
 */
export function analyzePresentation({trace, requests = [], nativeEvidence, runtime = {}} = {}) {
  const reasons = new Set(['hardware-presentation-feedback-unavailable', 'independent-content-frame-binding-unavailable', 'native-presentation-source-not-implemented']);
  if (!complete(trace)) reasons.add('trace-incomplete-or-clock-unknown');
  if (runtime.engine && runtime.engine !== 'chromium') reasons.add('browser-presentation-source-unsupported');
  if (runtime.headless === true) reasons.add('headless-display-not-physical');
  if (runtime.nativeCapturePermission === 'denied') reasons.add('native-capture-permission-denied');
  if (runtime.nativeCapturePermission === undefined || runtime.nativeCapturePermission === 'unknown') reasons.add('native-capture-permission-unverified');
  if (nativeEvidence !== undefined) reasons.add('native-evidence-profile-unsupported');
  const input = Array.isArray(trace?.events) ? trace.events : [];
  if (input.length > MAX_EVENTS) reasons.add('trace-event-bound-exceeded');
  if (!Array.isArray(requests) || requests.length > 100_000) throw Error('Invalid presentation request collection');
  const events = input.slice(0, MAX_EVENTS).map(sanitizePresentationTraceEvent).filter(Boolean);
  const decoded = spans(events);
  if (decoded.malformed) reasons.add('unmatched-or-ambiguous-presentation-spans');
  const latencies = decoded.values.filter(event => event.name === 'EventLatency' && event.latency);
  const stages = decoded.values.filter(event => ENDPOINTS.has(event.name));
  const pipeline = events.filter(event => event.name === 'Graphics.Pipeline');
  const latencyCounts = new Map(), trackLatencyCounts = new Map(), submissions = new Map(), aggregations = new Map(), trackStages = new Map(), retainedMarks = new Map();
  const latestAggregations = new Map(), ambiguousDisplays = new Set(), displayMembers = new Map();
  const append = (map, id, value) => {if (!map.has(id)) map.set(id, []); map.get(id).push(value);};
  for (const event of latencies) {
    latencyCounts.set(event.latency.event_latency_id, (latencyCounts.get(event.latency.event_latency_id) ?? 0) + 1);
    trackLatencyCounts.set(key(event.track), (trackLatencyCounts.get(key(event.track)) ?? 0) + 1);
  }
  for (const event of events) if (event.name === 'presentation-clock-mark') append(retainedMarks, event.markId, event);
  for (const stage of stages) append(trackStages, key(stage.track), stage);
  for (const row of pipeline) {
    if (row.pipeline.step === 'STEP_SUBMIT_COMPOSITOR_FRAME' && row.pipeline.surface_frame_trace_id) for (const id of row.pipeline.latency_ids ?? []) append(submissions, id, row.pipeline.surface_frame_trace_id);
    if (row.pipeline.step === 'STEP_SURFACE_AGGREGATION' && row.pipeline.display_trace_id && row.pipeline.aggregated_surface_frame_trace_ids) {
      const group = `${row.pipeline.display_trace_id}:${row.pid}:${row.tid}`, prior = latestAggregations.get(group);
      // Perfetto discards earlier duplicated aggregation steps because they may
      // have been canceled. Tied contradictory records cannot be ordered here.
      if (!prior || row.ts > prior.ts) latestAggregations.set(group, row);
      else if (row.ts === prior.ts && JSON.stringify([...row.pipeline.aggregated_surface_frame_trace_ids].sort()) !== JSON.stringify([...prior.pipeline.aggregated_surface_frame_trace_ids].sort())) ambiguousDisplays.add(row.pipeline.display_trace_id);
    }
  }
  for (const row of latestAggregations.values()) {
    if (!displayMembers.has(row.pipeline.display_trace_id)) displayMembers.set(row.pipeline.display_trace_id, new Set());
    for (const id of row.pipeline.aggregated_surface_frame_trace_ids) {
      displayMembers.get(row.pipeline.display_trace_id).add(id);
      if (!ambiguousDisplays.has(row.pipeline.display_trace_id)) append(aggregations, id, row.pipeline.display_trace_id);
    }
  }
  for (const map of [submissions, aggregations]) for (const [id, values] of map) map.set(id, unique(values));
  const joins = latencies.map(event => {
    const id = event.latency.event_latency_id, missing = [];
    if (latencyCounts.get(id) !== 1) missing.push('event-latency-id-ambiguous');
    if (trackLatencyCounts.get(key(event.track)) !== 1) missing.push('event-latency-track-ambiguous');
    const submitted = submissions.get(id) ?? [];
    const surface = event.latency.surface_frame_trace_id ?? (submitted.length === 1 ? submitted[0] : null);
    if (!surface) missing.push('input-surface-frame-id-missing-or-ambiguous');
    if (surface && submitted.length && (submitted.length !== 1 || submitted[0] !== surface)) missing.push('input-surface-frame-id-conflict');
    const aggregated = aggregations.get(surface) ?? [];
    const display = event.latency.display_trace_id ?? (aggregated.length === 1 ? aggregated[0] : null);
    if (!display) missing.push('surface-display-frame-id-missing-or-ambiguous');
    if (display && aggregated.length && !aggregated.includes(display)) missing.push('surface-display-frame-id-conflict');
    if (display && displayMembers.has(display) && !displayMembers.get(display).has(surface)) missing.push('final-display-aggregation-excludes-surface');
    if (display && ambiguousDisplays.has(display)) missing.push('surface-display-aggregation-ambiguous');
    const endpoints = trackLatencyCounts.get(key(event.track)) === 1 ? (trackStages.get(key(event.track)) ?? []).filter(stage => stage.ts >= event.ts && stage.endUs <= event.endUs) : [];
    if (endpoints.length !== 1) missing.push('explicit-presentation-stage-missing-or-ambiguous');
    // In particular, never use the stdlib's historical LatchToSwapEnd fallback.
    const endpoint = endpoints.length === 1 ? endpoints[0] : null;
    if (endpoint && endpoint.endUs !== event.endUs) missing.push('presentation-stage-not-terminal');
    const joined = missing.length === 0;
    return {latencyId: id, eventType: event.latency.event_type, inputTsUs: event.ts, surfaceFrameTraceId: surface, displayTraceId: display,
      status: joined ? 'diagnostic-id-join' : 'unavailable', reportedPresentationUs: joined ? endpoint.endUs : null,
      diagnosticInputToReportedPresentationMs: joined ? (endpoint.endUs - event.ts) / 1000 : null,
      endpointStage: endpoint?.name ?? null, physicalPresentationQualified: false, missing};
  });
  const requestIds = new Set();
  const joinsById = new Map();
  for (const join of joins) append(joinsById, join.latencyId, join);
  const observations = requests.map(request => {
    if (!SMALL_ID(request?.id) || requestIds.has(request.id)) throw Error('Presentation request IDs must be unique nonnegative integers');
    requestIds.add(request.id);
    const missing = ['physical-presentation-unavailable', 'correct-content-frame-binding-unavailable'];
    let start = {status: 'unavailable', reason: 'native-input-trace-id-unavailable'};
    let diagnosticJoin = null;
    if (request.start?.kind === 'bracketed-save') start = request.start.bracket?.id === request.id ? clockBounds(trace, request.start.bracket, retainedMarks) : {status: 'unavailable', reason: 'save-bracket-id-mismatch'};
    else {
      const latencyId = identifier(request.latencyId);
      const matching = latencyId === null ? [] : joinsById.get(latencyId) ?? [];
      if (matching.length === 1 && matching[0].status === 'diagnostic-id-join') {
        diagnosticJoin = matching[0]; start = {status: 'measured-native-input', clock: 'chromium-monotonic-microseconds', earliestUs: diagnosticJoin.inputTsUs, latestUs: diagnosticJoin.inputTsUs, exact: true};
      }
    }
    if (start.status === 'unavailable') missing.push(start.reason);
    return {id: request.id, outcome: 'INCONCLUSIVE', qualification: false, start, presentedUs: null, durationMs: null, diagnosticJoin, missing};
  });
  return {kind: 'browser-presentation-analysis-1', outcome: 'INCONCLUSIVE', qualification: false,
    capability: 'chromium-diagnostic-id-joins-only', clock: 'chromium-monotonic-microseconds', reasons: [...reasons],
    physicalPresentation: {status: 'unavailable', reason: 'No implemented native source retains hardware completion/failure feedback plus independently verified correct content for the same displayed frame.'},
    droppedDisplaySlots: {status: 'unavailable', reason: 'The exported frame events do not provide a complete physical display-slot sequence.'},
    observations, diagnosticJoins: joins, diagnosticFrameDisplayedEvents: events.filter(event => event.name === 'Display::FrameDisplayed').length,
    sourceReferences: PRESENTATION_SOURCE_REFERENCES};
}

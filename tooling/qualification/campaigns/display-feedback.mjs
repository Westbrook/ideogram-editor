/**
 * Lossless Chromium trace diagnostics for PERF R04/R06/R07. This module does
 * not certify a physical presentation. Its input is an unfiltered, retained CDP
 * ReturnAsStream JSON artifact; numbers must come from our lossless decoder.
 * Collection integrity and causal trace joins remain separate from authority.
 */
import {createHash} from 'node:crypto';
import {decodeRawTraceEvents, isRawTraceNumber} from './display-feedback-json.mjs';

export const DISPLAY_FEEDBACK_PROFILE = Object.freeze({
  kind: 'chromium-display-feedback-diagnostic-1',
  browserVersion: '153.0.8010.12',
  sourceCommit: '971a7443b0c9b0a9b2860529b33331b76077ec62',
  typedArgumentShape: 'nested-chromium-typed-arguments',
  liveCdpArgumentShapeVerified: false,
  qualification: false,
});

export const R07_MISSING_AUTHORITIES = Object.freeze([
  'actual-input-and-coalesced-sample-to-event-latency-id-authority',
  'intent-specific-visible-content-to-surface-and-display-frame-authority',
  'physical-display-feedback-flags-and-clock-authority',
  'complete-active-physical-refresh-slot-and-missed-slot-authority',
  'complete-application-main-thread-attribution-against-authoritative-slots',
]);

const MAX_SIGNED = (1n << 63n) - 1n;
const MAX_UNSIGNED = (1n << 64n) - 1n;
const MAX_DIAGNOSTICS = 250_000;
const MAX_ASSOCIATIONS = 1_000_000;
const MAX_IDS = 4096; // Per typed event, never the whole-session input count.
const ENDPOINTS = new Set(['SwapEndToPresentationCompositorFrame', 'LatchToPresentation', 'SwapStartToPresentation']);
const STAGES = new Set([...ENDPOINTS, 'LatchToSwapEnd']);
const CATEGORIES = new Set(['cc', 'benchmark', 'input', 'input.scrolling', 'viz', 'graphics.pipeline', 'disabled-by-default-display.framedisplayed']);
const STEPS = new Map([['9', 'STEP_SUBMIT_COMPOSITOR_FRAME'], ['10', 'STEP_SURFACE_AGGREGATION']]);

function decimal(value) {
  if (!isRawTraceNumber(value) || value.raw.length > 64) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.raw);
  if (!match || (match[4] && match[4].replace(/^[+-]/, '').length > 3)) return null;
  const exponent = Number(match[4] ?? 0);
  let scale = (match[3]?.length ?? 0) - exponent;
  if (Math.abs(scale) > 32) return null;
  let numerator = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`);
  if (numerator < 0n) return null;
  if (scale < 0) {numerator *= 10n ** BigInt(-scale); scale = 0;}
  while (scale && numerator % 10n === 0n) {numerator /= 10n; scale--;}
  return {numerator, scale};
}

function common(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return [left.numerator * 10n ** BigInt(scale - left.scale), right.numerator * 10n ** BigInt(scale - right.scale), scale];
}
function compare(left, right) {const [a, b] = common(left, right); return a < b ? -1 : a > b ? 1 : 0;}
function add(left, right) {const [a, b, scale] = common(left, right); return {numerator: a + b, scale};}
function subtract(left, right) {const [a, b, scale] = common(left, right); return {numerator: a - b, scale};}
function exact(value) {
  if (!value.scale) return value.numerator.toString();
  const digits = value.numerator.toString().padStart(value.scale + 1, '0');
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, '');
}

function identifier(value, maximum = MAX_SIGNED) {
  let raw;
  if (isRawTraceNumber(value)) {
    const number = decimal(value);
    if (!number || number.scale !== 0) return null;
    raw = number.numerator;
  } else if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19}|0x[0-9a-fA-F]{1,16})$/.test(value)) raw = BigInt(value);
  else return null;
  // -1 in Chromium is an unknown sentinel. Neither that sentinel nor an
  // unsafe JS Number can become a join identity.
  return raw >= 0n && raw <= maximum ? raw.toString() : null;
}
function identities(value) {
  if (!Array.isArray(value) || value.length > MAX_IDS) return null;
  const result = value.map(item => identifier(item));
  return result.some(item => item === null) || new Set(result).size !== result.length ? null : result;
}
function track(event, pid) {
  if (event.scope !== undefined && event.scope !== '') return null;
  const choices = [event.id2?.local !== undefined && ['local', event.id2.local], event.id2?.global !== undefined && ['global', event.id2.global], event.id !== undefined && ['global', event.id]].filter(Boolean);
  if (choices.length !== 1) return null;
  const [scope, value] = choices[0], id = identifier(value, MAX_UNSIGNED);
  return id === null ? null : `${scope}:${scope === 'local' ? pid : ''}:${id}`;
}
function step(value) {return typeof value === 'string' && [...STEPS.values()].includes(value) ? value : STEPS.get(identifier(value));}
function append(map, key, value) {if (!map.has(key)) map.set(key, []); map.get(key).push(value);}
function membership(row) {return [...row.surfaces].sort().join(',');}

function normalize(event, ordinal, counts) {
  if (!event || typeof event !== 'object') return null;
  const wanted = event.name === 'EventLatency' || STAGES.has(event.name) || event.name === 'Graphics.Pipeline' || event.name === 'Display::FrameDisplayed';
  if (!wanted) return null;
  counts.targeted++;
  const reject = () => {counts.rejected++; return null;};
  const categories = typeof event.cat === 'string' && event.cat.length <= 1024 ? event.cat.split(',') : [];
  if (!categories.some(category => CATEGORIES.has(category))) return reject();
  const pid = identifier(event.pid, 0x7fffffffn), tid = identifier(event.tid, 0x7fffffffn), ts = decimal(event.ts);
  if (pid === null || tid === null || !ts || !['b', 'e', 'B', 'E', 'X', 'I', 'i', 'n'].includes(event.ph)) return reject();
  const dur = event.ph === 'X' ? decimal(event.dur) : null;
  if (event.ph === 'X' && !dur) return reject();
  const row = {ordinal, name: event.name, pid, tid, ts, ph: event.ph, ...(dur ? {dur} : {})};
  if (event.name === 'Display::FrameDisplayed') return row;
  if (event.name !== 'Graphics.Pipeline') {
    // Synchronous B/E events have thread-stack semantics; they cannot share
    // this named asynchronous-track join path or close an asynchronous span.
    if (!['b', 'e', 'X'].includes(event.ph)) return reject();
    row.track = track(event, pid);
    if (!row.track) return reject();
    if (event.name === 'EventLatency' && event.ph !== 'e') {
      const data = event.args?.event_latency;
      if (!data || typeof data !== 'object') return reject();
      row.input = identifier(data.event_latency_id);
      row.surface = data.surface_frame_trace_id === undefined ? null : identifier(data.surface_frame_trace_id);
      row.display = data.display_trace_id === undefined ? null : identifier(data.display_trace_id);
      // Explicit unknown IDs stay unavailable. An explicit contradictory ID is
      // never repaired by choosing a nearby event or a different lane.
      row.explicitSurfaceUnknown = data.surface_frame_trace_id !== undefined && row.surface === null;
      row.explicitDisplayUnknown = data.display_trace_id !== undefined && row.display === null;
      if (row.input === null) return reject();
      row.eventType = typeof data.event_type === 'string' && /^[A-Z_]{1,64}$/.test(data.event_type) ? data.event_type : 'UNDECODED';
    }
    return row;
  }
  if (['e', 'E'].includes(event.ph)) return null;
  const data = event.args?.chrome_graphics_pipeline;
  if (!data || typeof data !== 'object') return reject();
  row.step = step(data.step);
  if (!row.step) {counts.unsupportedPipelineSteps++; return null;}
  if (row.step === 'STEP_SUBMIT_COMPOSITOR_FRAME') {
    row.surface = identifier(data.surface_frame_trace_id);
    row.inputs = identities(data.latency_ids);
    if (row.surface === null || row.inputs === null) return reject();
  } else {
    row.display = identifier(data.display_trace_id);
    row.surfaces = identities(data.aggregated_surface_frame_trace_ids);
    if (row.display === null || row.surfaces === null) return reject();
  }
  return row;
}

function spans(rows) {
  const result = [], open = new Map(), invalid = new Set();
  let malformed = 0;
  const ordered = rows.filter(row => row.track).sort((a, b) => compare(a.ts, b.ts) || a.ordinal - b.ordinal);
  for (const row of ordered) {
    const key = `${row.track}:${row.name}`;
    if (row.ph === 'X') result.push({...row, end: add(row.ts, row.dur)});
    else if (row.ph === 'b') {
      if (open.has(key)) {invalid.add(key); malformed++;}
      open.set(key, row);
    } else if (row.ph === 'e') {
      const start = open.get(key); open.delete(key);
      if (!start || invalid.has(key) || compare(row.ts, start.ts) < 0) malformed++;
      else result.push({...start, end: row.ts});
    }
  }
  return {rows: result, malformed: malformed + open.size};
}

function graph(rows) {
  const decoded = spans(rows), latencies = decoded.rows.filter(row => row.name === 'EventLatency');
  const inputCounts = new Map(), trackCounts = new Map(), submissions = new Map(), latest = new Map(), ambiguous = new Set(), displays = new Map(), stagesByTrack = new Map(), displaysBySurface = new Map();
  for (const row of latencies) {inputCounts.set(row.input, (inputCounts.get(row.input) ?? 0) + 1); trackCounts.set(row.track, (trackCounts.get(row.track) ?? 0) + 1);}
  for (const row of decoded.rows) if (ENDPOINTS.has(row.name)) append(stagesByTrack, row.track, row);
  for (const row of rows) {
    if (row.step === 'STEP_SUBMIT_COMPOSITOR_FRAME') for (const id of row.inputs) append(submissions, id, row);
    if (row.step === 'STEP_SURFACE_AGGREGATION') {
      const key = `${row.pid}:${row.tid}:${row.display}`, prior = latest.get(key);
      if (!prior || compare(row.ts, prior.row.ts) > 0) latest.set(key, {row, ambiguous: false});
      else if (compare(row.ts, prior.row.ts) === 0 && membership(row) !== membership(prior.row)) prior.ambiguous = true;
    }
  }
  for (const entry of latest.values()) {
    const {row} = entry;
    if (entry.ambiguous) ambiguous.add(row.display);
    append(displays, row.display, row);
    for (const surface of row.surfaces) {
      if (!displaysBySurface.has(surface)) displaysBySurface.set(surface, new Set());
      displaysBySurface.get(surface).add(row.display);
    }
  }
  const joins = latencies.map(row => {
    const missing = [];
    if (inputCounts.get(row.input) !== 1) missing.push('event-latency-id-not-unique');
    if (trackCounts.get(row.track) !== 1) missing.push('event-latency-track-not-unique');
    const submitted = submissions.get(row.input) ?? [];
    if (submitted.length !== 1) missing.push('exact-input-surface-submission-missing-or-ambiguous');
    const submission = submitted.length === 1 ? submitted[0] : null;
    const surface = submission?.surface ?? null;
    if (row.explicitSurfaceUnknown || (row.surface !== null && row.surface !== surface)) missing.push('event-latency-surface-conflict-or-unknown');
    const candidates = surface === null ? null : displaysBySurface.get(surface);
    const display = row.display ?? (candidates?.size === 1 ? candidates.values().next().value : null);
    if (row.explicitDisplayUnknown) missing.push('event-latency-display-unknown');
    const aggregations = displays.get(display) ?? [];
    if (display === null || aggregations.length !== 1 || ambiguous.has(display)) missing.push('exact-final-surface-display-aggregation-missing-or-ambiguous');
    const aggregation = aggregations.length === 1 ? aggregations[0] : null;
    if (aggregation && !candidates?.has(display)) missing.push('final-aggregation-excludes-submitted-surface');
    const stages = trackCounts.get(row.track) === 1 ? (stagesByTrack.get(row.track) ?? []).filter(stage => compare(stage.ts, row.ts) >= 0 && compare(stage.end, row.end) <= 0) : [];
    if (stages.length !== 1) missing.push('explicit-terminal-presentation-stage-missing-or-ambiguous');
    const endpoint = stages.length === 1 ? stages[0] : null;
    if (endpoint && compare(endpoint.end, row.end) !== 0) missing.push('presentation-stage-not-terminal');
    if (submission && (compare(submission.ts, row.ts) < 0 || compare(submission.ts, row.end) > 0)) missing.push('submission-outside-event-latency-span');
    if (submission && aggregation && (compare(aggregation.ts, submission.ts) < 0 || compare(aggregation.ts, row.end) > 0)) missing.push('aggregation-causal-order-invalid');
    return {
      eventLatencyId: row.input, asyncTrack: row.track, eventType: row.eventType,
      surfaceFrameTraceId: surface, displayTraceId: display,
      traceStartUs: exact(row.ts), traceEndUs: exact(row.end), traceSpanUs: exact(subtract(row.end, row.ts)),
      diagnosticJoin: missing.length || decoded.malformed ? 'unavailable' : 'exact-trace-identities', reasons: decoded.malformed ? [...missing, 'trace-span-set-incomplete-or-ambiguous'] : missing,
      endpointStage: endpoint?.name ?? null,
      actualInputBound: false, meaningfulContentBound: false, physicalPresentationQualified: false,
    };
  });
  return {joins, malformedSpans: decoded.malformed, frameDisplayedEvents: rows.filter(row => row.name === 'Display::FrameDisplayed').length,
    frameDisplayedAuthority: 'unjoined-timestamp-only-no-feedback-flags-or-physical-slot-sequence'};
}

const TEXT_COUNTS = Object.freeze({'insert-delete': 40, preedit: 20, 'composition-commit-cancel': 10, 'caret-selection': 10, 'semantic-list': 10, 'font-wrap-transform-guide': 10, 'presentation-request': 6});
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value);

/** Shape/count validation only. A declared action is not an observed input. */
export function inspectR07Cohort(cohort) {
  const reasons = [];
  if (!cohort || !['P-I', 'IText'].includes(cohort.profile)) return {status: 'invalid', qualification: false, reasons: ['r07-cohort-profile-missing']};
  if (cohort.durationMs !== 60_000 || cohort.refreshHz !== 60) reasons.push('cohort-must-remain-60-seconds-at-60-hz');
  const actions = Array.isArray(cohort.actions) && cohort.actions.length <= 106 ? cohort.actions : [];
  const expectedActions = cohort.profile === 'P-I' ? 100 : 106;
  if (actions.length !== expectedActions) reasons.push('cohort-action-count-changed');
  const allIds = new Set(), kinds = new Map();
  let strokePoints = 0;
  for (const action of actions) {
    if (!token(action?.id) || allIds.has(action.id)) reasons.push('action-id-invalid-or-duplicate');
    allIds.add(action?.id);
    kinds.set(action?.kind, (kinds.get(action?.kind) ?? 0) + 1);
    if (action?.kind === 'stroke') {
      const samples = Array.isArray(action.sampleIds) ? action.sampleIds : [];
      if (samples.length !== 120 || action.sampleHz !== 60) reasons.push('stroke-must-preserve-120-samples-at-60-hz');
      strokePoints += samples.length;
      // Reject the declaration without traversing an unbounded caller array.
      if (samples.length <= 120) for (const id of samples) {if (!token(id) || allIds.has(id)) reasons.push('sample-id-invalid-or-duplicate'); allIds.add(id);}
    }
  }
  if (cohort.profile === 'P-I') {
    if (kinds.get('stroke') !== 20 || kinds.get('discrete') !== 80 || kinds.size !== 2 || strokePoints !== 2400) reasons.push('p-i-must-retain-20-strokes-2400-points-and-80-discrete-actions');
  } else if (kinds.size !== Object.keys(TEXT_COUNTS).length || Object.entries(TEXT_COUNTS).some(([kind, count]) => kinds.get(kind) !== count)) reasons.push('itext-must-retain-original-100-plus-six-presentation-requests');
  return {status: reasons.length ? 'invalid' : 'declaration-valid', qualification: false, reasons: [...new Set(reasons)],
    profile: cohort.profile, expectedActions, declaredActions: actions.length, declaredStrokePoints: strokePoints,
    declaredDurationMs: cohort.durationMs, declaredRefreshHz: cohort.refreshHz,
    originalActionCount: 100, extraPresentationRequests: cohort.profile === 'IText' ? 6 : 0,
    observedExecution: false, expectedPhysicalSlots: null,
    note: 'The nominal 60-Hz mode does not manufacture 3,600 measured slots; the actual slot sequence requires an independent authority.'};
}

function manifestProblems(manifest, digest, bytes) {
  const reasons = [];
  if (manifest?.kind !== 'display-feedback-raw-trace-1') reasons.push('raw-collection-manifest-missing');
  const c = manifest?.collection, a = manifest?.artifact;
  if (c?.status !== 'complete' || c.startOutcome !== 'acknowledged' || c.completeEventReceived !== true || c.dataLossOccurred !== false || c.streamReceived !== true || c.eof !== true || !Array.isArray(c.reasons) || c.reasons.length) reasons.push('raw-trace-collection-incomplete-or-loss-unknown');
  if (a?.format !== 'json' || a.compression !== 'none' || a.sha256 !== digest || a.bytes !== bytes || c?.bytes !== bytes || a.persistedSize !== bytes || a.hashScope !== 'completed-file' || a.hashVerifiedAgainstSize !== true || a.rawClosed !== true || manifest?.manifest?.saved !== true) reasons.push('raw-trace-bytes-or-hash-mismatch');
  const p = manifest?.protocol;
  if (p?.transferMode !== 'ReturnAsStream' || p.streamFormat !== 'json' || p.streamCompression !== 'none' || p.enableArgumentFilter !== false) reasons.push('raw-unfiltered-stream-protocol-not-established');
  return reasons;
}

/**
 * Fully consume and hash the raw stream before returning diagnostics. A valid
 * prefix followed by a corrupt trailer cannot publish any successful join.
 * Caller-supplied requests, latency IDs, native flags or slot arrays are not
 * accepted as additional arguments that could qualify this evidence.
 */
export async function analyzeDisplayFeedbackTrace({chunks, manifest, cohort, maxDiagnosticEvents = MAX_DIAGNOSTICS, maxDiagnosticAssociations = MAX_ASSOCIATIONS} = {}) {
  if (!chunks || (!chunks[Symbol.asyncIterator] && !chunks[Symbol.iterator])) throw Error('Raw trace byte chunks are required');
  if (!Number.isSafeInteger(maxDiagnosticEvents) || maxDiagnosticEvents < 1 || maxDiagnosticEvents > MAX_DIAGNOSTICS) throw Error('Invalid diagnostic event limit');
  if (!Number.isSafeInteger(maxDiagnosticAssociations) || maxDiagnosticAssociations < 1 || maxDiagnosticAssociations > MAX_ASSOCIATIONS) throw Error('Invalid diagnostic association limit');
  const counts = {decoded: 0, targeted: 0, rejected: 0, unsupportedPipelineSteps: 0, retainedAssociations: 0}, rows = [], hash = createHash('sha256');
  let bytes = 0, failure = null;
  async function* retainedBytes() {
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) throw Error('Raw trace chunks must be bytes');
      if (chunk.byteLength > 128 * 1024 * 1024 - bytes) throw Error('Raw trace byte bound exceeded');
      if (chunk.byteLength === 0) yield new Uint8Array(0);
      // Do not hash a caller-owned view and then asynchronously parse it: the
      // producer could reuse that storage between decoder reads. Each private
      // slice is the exact immutable-by-ownership input to both operations.
      for (let offset = 0; offset < chunk.byteLength; offset += 16 * 1024) {
        const owned = Uint8Array.from(chunk.subarray(offset, offset + 16 * 1024));
        bytes += owned.byteLength;
        hash.update(owned);
        yield owned;
      }
    }
  }
  try {
    for await (const event of decodeRawTraceEvents(retainedBytes(), {maxEventBytes: 256 * 1024})) {
      counts.decoded++;
      const row = normalize(event, counts.decoded - 1, counts);
      if (row) {
        if (rows.length >= maxDiagnosticEvents) throw Error('Diagnostic event bound exceeded');
        const associations = (row.inputs?.length ?? 0) + (row.surfaces?.length ?? 0) + [row.input, row.surface, row.display, row.track].filter(value => value !== undefined && value !== null).length;
        if (counts.retainedAssociations + associations > maxDiagnosticAssociations) throw Error('Diagnostic association bound exceeded');
        counts.retainedAssociations += associations;
        rows.push(row);
      }
    }
  } catch (error) {failure = error instanceof Error ? error.message : 'Raw trace decoding failed';}
  const digest = hash.digest('hex'), reasons = manifestProblems(manifest, digest, bytes);
  if (failure) reasons.push('raw-trace-decode-failed-no-prefix-results');
  const integrity = reasons.length === 0;
  if (counts.rejected) reasons.push('required-trace-facts-malformed-or-unsupported');
  // A dropped malformed aggregation could otherwise make an older canceled
  // one look final. Preserve the byte-integrity fact while suppressing joins.
  const diagnostics = integrity && counts.rejected === 0 ? graph(rows) : {joins: [], malformedSpans: null, frameDisplayedEvents: null, frameDisplayedAuthority: 'unavailable'};
  if (diagnostics.malformedSpans) reasons.push('presentation-spans-incomplete-or-ambiguous');
  const declaredCohort = inspectR07Cohort(cohort);
  if (declaredCohort.status !== 'declaration-valid') reasons.push('full-r07-cohort-declaration-invalid');
  const product = manifest?.browserVersion?.status === 'observed' && typeof manifest.browserVersion.product === 'string' ? manifest.browserVersion.product : null;
  const expectedBuildObserved = product === `Chrome/${DISPLAY_FEEDBACK_PROFILE.browserVersion}`;
  if (!expectedBuildObserved) reasons.push('pinned-headed-chromium-build-not-observed');
  return {
    kind: 'display-feedback-analysis-1', status: 'INCONCLUSIVE', qualification: false,
    profile: DISPLAY_FEEDBACK_PROFILE, clock: 'chromium-trace-microseconds-not-calibrated-to-physical-display',
    sourceIdentity: {product, expectedBuildObserved, processAndExecutableAdmission: 'external-provenance-still-required'},
    rawArtifact: {bytes, sha256: digest, fullJsonValidated: failure === null, matchesCollectionManifest: integrity, ...(failure ? {decodeFailure: failure} : {})},
    limits: {maxRawBytes: 128 * 1024 * 1024, maxEventBytes: 256 * 1024, maxDiagnosticEvents, maxDiagnosticAssociations},
    counts, diagnostics, cohort: declaredCohort,
    missingAuthorities: [...R07_MISSING_AUTHORITIES],
    reasons: [...new Set([...reasons, 'live-cdp-typed-argument-profile-unverified', 'stock-trace-does-not-prove-full-r07-presentation'])],
    metrics: {actualInputToPresentedPaint: {status: 'unavailable'}, droppedPhysicalSlots: {status: 'unavailable'}, applicationWorkPerPhysicalSlot: {status: 'unavailable'}, workerCompositorGpuTiming: {status: 'unavailable'}},
  };
}

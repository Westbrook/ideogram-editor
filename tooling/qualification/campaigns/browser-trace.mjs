import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {analyzePresentation, PRESENTATION_TRACE_CATEGORIES, sanitizePresentationTraceEvent} from './browser-presentation.mjs';

// CDP Tracing ReportEvents, pinned by the installed Playwright protocol types.
// No screenshots, network category, stack sampling, or raw arguments are saved.
// PERF §3/§8: a renderer Paint, DrawFrame, DOM update, or rAF is NOT evidence of
// physical presentation. The presentation decoder retains exact diagnostic IDs;
// unsupported native feedback/content-frame provenance remains unavailable.
const CATEGORIES = [...new Set(['toplevel', 'devtools.timeline', 'blink.user_timing', 'cc', 'viz', 'gpu', ...PRESENTATION_TRACE_CATEGORIES])];
const WORK = new Set(['RunTask', 'ThreadControllerImpl::RunTask', 'FunctionCall', 'EvaluateScript', 'EventDispatch', 'TimerFire', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'CompositeLayers', 'UpdateLayer', 'ParseHTML']);
const DIAGNOSTIC = new Set(['DrawFrame', 'BeginFrame', 'BeginMainThreadFrame', 'ActivateLayerTree', 'Commit', 'RasterTask', 'GPUTask']);
const THREADS = new Set(['CrRendererMain', 'CrBrowserMain', 'Compositor', 'VizCompositorThread', 'CrGpuMain', 'Chrome_IOThread', 'DedicatedWorker thread']);
const KINDS = new Set(['intent', 'feedback', 'complete', 'active-start', 'active-end', 'frame-start', 'frame-end', 'editor-updated', 'canvas-drawn', 'viewport-drawn']);
const OPERATIONS = ['Select layers', 'View zoom', 'Pan', 'Inspect mask PNG', 'Move layer', 'Sample canonical color', 'Apply text', 'Cancel text edit', 'Edit text', 'Open text editor', 'Prepare dropped image', 'Prepare pasted image', 'Resume original transfer', 'Save checkpoint'];
const FIXED_MARKS = new Map([['ie.editor.updated', 'editor-updated'], ['ie.canvas.drawn', 'canvas-drawn'], ['ie.viewport.drawn', 'viewport-drawn']]);
const NONNEGATIVE = number => Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER;
const ID = number => Number.isSafeInteger(number) && number >= 0;
const LIMIT_REASONS = new Set(['event-limit', 'byte-limit', 'browser-buffer-limit', 'browser-data-loss', 'trace-completion-timeout', 'trace-end-failed', 'trace-start-failed', 'cdp-unavailable', 'unexpected-trace-stream', 'malformed-work-event']);

function positiveInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error(`Invalid ${name}`);
  return value;
}

function mark(name) {
  if (typeof name !== 'string') return null;
  if (FIXED_MARKS.has(name)) return {kind: FIXED_MARKS.get(name), id: 0};
  const numeric = /^ie\.perf\.v1:(intent|feedback|complete|active-start|active-end|frame-start|frame-end):([0-9]{1,15})$/.exec(name);
  if (numeric) return {kind: numeric[1], id: Number(numeric[2])};
  for (const kind of ['intent', 'complete']) {
    const index = OPERATIONS.indexOf(name.slice(`ie.${kind}.`.length));
    if (name.startsWith(`ie.${kind}.`) && index >= 0) return {kind, id: index + 1};
  }
  return null;
}

/** Strict output schema: fixed enums and times, with lossless decimal trace IDs. */
export function sanitizeTraceEvent(event) {
  const presentation = sanitizePresentationTraceEvent(event);
  if (presentation) return presentation;
  if (!event || typeof event !== 'object' || !ID(event.pid) || !ID(event.tid)) return null;
  const categories = typeof event.cat === 'string' ? event.cat.split(',') : [];
  if (event.ph === 'M' && event.name === 'thread_name' && (categories.includes('__metadata') || event.cat === 'metadata')) {
    const thread = event.thread ?? event.args?.name;
    return THREADS.has(thread) ? {cat: 'metadata', name: 'thread_name', ph: 'M', ts: 0, pid: event.pid, tid: event.tid, thread} : null;
  }
  if (!NONNEGATIVE(event.ts)) return null;
  const base = {ts: event.ts, pid: event.pid, tid: event.tid};
  if (categories.includes('blink.user_timing')) {
    const product = event.name === 'product-mark' && KINDS.has(event.kind) && ID(event.id) ? {kind: event.kind, id: event.id} : mark(event.name ?? '');
    if (product && ['I', 'i', 'R', 'b', 'e', 'X'].includes(event.ph)) return {cat: 'blink.user_timing', name: 'product-mark', ph: 'I', ...base, ...product};
    return null;
  }
  const category = categories.find(item => CATEGORIES.includes(item));
  if (!category || !['X', 'B', 'E', 'I', 'i'].includes(event.ph)) return null;
  if (event.ph === 'E' && (event.name === undefined || event.name === '' || event.name === 'End')) return {cat: category, name: 'End', ph: 'E', ...base};
  if (!WORK.has(event.name) && !DIAGNOSTIC.has(event.name)) return null;
  if (event.ph === 'X' && (!NONNEGATIVE(event.dur) || !Number.isFinite(event.ts + event.dur))) return null;
  return {cat: category, name: event.name, ph: event.ph, ...base, ...(event.ph === 'X' ? {dur: event.dur} : {})};
}

function union(intervals) {
  const sorted = intervals.filter(interval => interval[1] > interval[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result = [];
  for (const interval of sorted) {
    const last = result.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else result.push([...interval]);
  }
  return result;
}

function intersect(left, right) {
  const result = []; let l = 0; let r = 0;
  while (l < left.length && r < right.length) {
    const start = Math.max(left[l][0], right[r][0]); const end = Math.min(left[l][1], right[r][1]);
    if (end > start) result.push([start, end]);
    if (left[l][1] < right[r][1]) l++; else r++;
  }
  return result;
}

function intervalsFromEvents(events, mainThread) {
  const intervals = []; const stack = []; let unmatched = 0;
  for (const event of events.filter(event => event.pid === mainThread.pid && event.tid === mainThread.tid).sort((a, b) => a.ts - b.ts)) {
    // Async presentation tracks do not participate in the renderer task stack.
    if (event.track || event.pipeline || event.name === 'Display::FrameDisplayed') continue;
    if (event.ph === 'E') {
      const open = stack.pop();
      if (!open || (event.name !== 'End' && event.name !== open.name) || event.ts < open.ts) unmatched++;
      else if (WORK.has(open.name)) intervals.push([open.ts, event.ts]);
    } else if (event.ph === 'B') stack.push(event);
    else if (event.ph === 'X' && WORK.has(event.name)) intervals.push([event.ts, event.ts + event.dur]);
  }
  return {intervals: union(intervals), unmatched: unmatched + stack.length};
}

function validIntervals(value, maximum = 100_000) {
  return Array.isArray(value) && value.length > 0 && value.length <= maximum && value.every(item => item && NONNEGATIVE(item.startUs) && NONNEGATIVE(item.endUs) && item.endUs > item.startUs);
}

/**
 * Analyze only explicit evidence. Attribution is supplied by an independently
 * reviewed campaign: complete application intervals on the stated renderer lane,
 * including background app tasks and app-triggered rendering. A main-thread
 * identity alone cannot establish that attribution. Slots likewise require a
 * validated display clock; fabricated fixed rAF slots must not be supplied.
 */
export function analyzeTrace(trace, options = {}) {
  const input = Array.isArray(trace?.events) ? trace.events : [];
  const events = input.slice(0, 1_000_000).map(sanitizeTraceEvent).filter(Boolean);
  const collection = trace?.collection;
  const complete = collection?.status === 'complete' && collection.completeEventReceived === true && collection.reasons?.length === 0 && input.length <= 1_000_000;
  const reasons = [];
  if (!complete) reasons.push('trace-incomplete');
  const malformedWork = input.some(event => WORK.has(event?.name) && ['X', 'B', 'E'].includes(event?.ph) && !sanitizeTraceEvent(event));
  if (malformedWork) reasons.push('malformed-work-event');
  const presentation = {status: 'unavailable', reason: 'No validated physical-display presentation adapter. Paint, DrawFrame, product marks and requestAnimationFrame are not physical presentation.'};
  let frameWork = {status: 'unavailable', reason: 'Explicit application attribution and validated active display slots are required.'};
  const mainThread = options.mainThread;
  const lane = mainThread && ID(mainThread.pid) && ID(mainThread.tid);
  const attribution = options.attribution;
  const attributionValid = lane && attribution?.complete === true && attribution.includesBackgroundAppWork === true && attribution.includesTriggeredRendering === true && validIntervals(attribution.intervals);
  const slots = options.frameSlots;
  const slotsValid = validIntervals(slots) && options.frameSlotSource === 'validated-display-clock' && options.displayRefreshHz === 60 && options.visibility === 'visible' && slots.every((slot, index) => Math.abs(slot.endUs - slot.startUs - 1_000_000 / 60) <= 0.1 && (!index || slot.startUs >= slots[index - 1].endUs));
  let provenCeilingBreach = false;
  if (lane) {
    const work = intervalsFromEvents(events, mainThread);
    if (work.unmatched) reasons.push('unmatched-main-thread-intervals');
    if (attributionValid && slotsValid && (work.intervals.length > 0 || work.unmatched > 0 || malformedWork)) {
      const attributable = intersect(work.intervals, union(attribution.intervals.map(item => [item.startUs, item.endUs])));
      let cursor = 0;
      const samples = slots.map(slot => {
        while (cursor < attributable.length && attributable[cursor][1] <= slot.startUs) cursor++;
        let workUs = 0;
        for (let index = cursor; index < attributable.length && attributable[index][0] < slot.endUs; index++) workUs += Math.max(0, Math.min(slot.endUs, attributable[index][1]) - Math.max(slot.startUs, attributable[index][0]));
        return {startUs: slot.startUs, endUs: slot.endUs, workMs: workUs / 1000};
      });
      const values = samples.map(item => item.workMs).sort((a, b) => a - b);
      const maximumMs = values.at(-1); const p95Ms = values[Math.ceil(values.length * 0.95) - 1];
      const measured = complete && work.unmatched === 0 && !malformedWork;
      provenCeilingBreach = maximumMs > 10;
      frameWork = {status: measured ? 'measured' : 'partial-diagnostic', samples, p95Ms, maximumMs, sampleCount: samples.length, targetMs: 8, ceilingMs: 10, targetMissed: p95Ms > 8, ceilingBreached: provenCeilingBreach, scope: 'union-of-explicitly-attributed-main-thread-work-per-active-60Hz-display-slot', physicalPresentationQualified: false};
    } else {
      if (!work.intervals.length) reasons.push('main-thread-work-evidence-missing');
      frameWork = {...frameWork, diagnosticMainThreadWorkMs: work.intervals.length ? work.intervals.reduce((sum, item) => sum + item[1] - item[0], 0) / 1000 : null, diagnosticOnly: true};
    }
  }
  if (!attributionValid) reasons.push('application-attribution-missing');
  if (!slotsValid) reasons.push('validated-active-display-slots-missing');
  reasons.push('physical-presentation-missing');
  return {
    kind: 'browser-trace-analysis-1', outcome: provenCeilingBreach ? 'FAIL' : 'INCONCLUSIVE', qualification: false,
    reasons, physicalPresentation: presentation, pointerToPresentedPaint: presentation, meaningfulFeedbackPresented: presentation, droppedDisplaySlots: presentation,
    frameWork, marks: events.filter(event => event.name === 'product-mark').map(({ts, pid, tid, kind, id}) => ({tsUs: ts, pid, tid, kind, id})),
    lanes: events.filter(event => event.ph === 'M').map(({pid, tid, thread}) => ({pid, tid, thread})),
    diagnosticFrameEvents: events.filter(event => DIAGNOSTIC.has(event.name)).length,
    clock: 'chromium-monotonic-microseconds', browserPhaseClockJoin: 'unavailable-unless-separately-calibrated',
    separatePipelineTiming: {worker: 'unavailable', compositor: 'unavailable', gpu: 'unavailable'},
  };
}

function bounded(promise, timeoutMs, reason) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(reason)), timeoutMs);})]).finally(() => clearTimeout(timer));
}

/** Chromium only. Unsupported CDP and collection loss produce saved missing evidence. */
export function createBrowserTrace(page, options = {}) {
  const {artifactDirectory, artifactName = 'browser-trace.json', maxEvents = 150_000, maxBytes = 16 * 1024 * 1024, completionTimeoutMs = 10_000} = options;
  if (!isAbsolute(artifactDirectory ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.json$/.test(artifactName)) throw Error('Invalid trace artifact destination');
  positiveInteger(maxEvents, 'trace event limit', 1, 1_000_000);
  positiveInteger(maxBytes, 'trace byte limit', 4096, 64 * 1024 * 1024);
  positiveInteger(completionTimeoutMs, 'trace completion timeout', 1, 60_000);
  const events = []; const reasons = new Set();
  let state = 'new'; let session; let received = 0; let bytesRetained = 0; let completionReceived = false; let finish; let stopPromise; let endPromise;
  const completed = new Promise(resolve => {finish = resolve;});
  function reason(value) {if (LIMIT_REASONS.has(value)) reasons.add(value);}
  function requestEnd() {
    if (!session || endPromise) return;
    endPromise = bounded(Promise.resolve().then(() => session.send('Tracing.end')), completionTimeoutMs, 'trace-end-failed').catch(() => reason('trace-end-failed'));
  }
  function collect(payload) {
    if (!Array.isArray(payload?.value)) return;
    const previousReceived = received;
    received = Math.min(Number.MAX_SAFE_INTEGER, received + payload.value.length);
    if (received > maxEvents) {reason('event-limit'); requestEnd();}
    for (const [index, event] of payload.value.entries()) {
      if (previousReceived + index >= maxEvents || reasons.has('byte-limit')) break;
      const sanitized = sanitizeTraceEvent(event);
      if (!sanitized) {
        if (WORK.has(event?.name) && ['X', 'B', 'E'].includes(event?.ph)) reason('malformed-work-event');
        continue;
      }
      const size = Buffer.byteLength(JSON.stringify(sanitized)) + 1;
      // Reserve a fixed envelope; argument strings never enter this buffer.
      if (bytesRetained + size > maxBytes - 2048) {reason('byte-limit'); requestEnd(); break;}
      events.push(sanitized); bytesRetained += size;
    }
  }
  function bufferUsage(payload) {
    if ([payload?.percentFull, payload?.value].some(value => Number.isFinite(value) && value >= 0.9)) {reason('browser-buffer-limit'); requestEnd();}
  }
  function complete(payload) {
    completionReceived = true;
    if (payload?.dataLossOccurred !== false) reason('browser-data-loss');
    if (payload?.stream !== undefined) reason('unexpected-trace-stream');
    finish();
  }
  async function start() {
    if (state !== 'new') throw Error('Trace may start only once');
    state = 'starting';
    try {
      const pendingSession = Promise.resolve().then(() => page.context().newCDPSession(page));
      pendingSession.then(value => {if (state === 'unavailable' || state === 'stopped') void value.detach().catch(() => {});}, () => {});
      session = await bounded(pendingSession, completionTimeoutMs, 'cdp-unavailable');
    } catch {reason('cdp-unavailable'); state = 'unavailable'; return {status: state};}
    session.on('Tracing.dataCollected', collect); session.on('Tracing.bufferUsage', bufferUsage); session.on('Tracing.tracingComplete', complete);
    try {
      await bounded(session.send('Tracing.start', {
        transferMode: 'ReportEvents', bufferUsageReportingInterval: 500,
        traceConfig: {recordMode: 'recordUntilFull', traceBufferSizeInKb: Math.ceil(maxBytes / 1024), enableSampling: false, enableSystrace: false, enableArgumentFilter: true, includedCategories: CATEGORIES, excludedCategories: ['*']},
      }), completionTimeoutMs, 'trace-start-failed');
      state = 'active'; return {status: state};
    } catch {reason('trace-start-failed'); state = 'unavailable'; return {status: state};}
  }
  function stop(analysisOptions = {}) {
    if (stopPromise) return stopPromise;
    if (state === 'starting') throw Error('Await trace start before stopping');
    stopPromise = (async () => {
      if (state === 'new') reason('trace-start-failed');
      if (state === 'active') {
        state = 'stopping'; requestEnd();
        try {await bounded(completed, completionTimeoutMs, 'trace-completion-timeout');} catch {reason('trace-completion-timeout');}
        await endPromise;
      }
      if (session) {
        session.off('Tracing.dataCollected', collect); session.off('Tracing.bufferUsage', bufferUsage); session.off('Tracing.tracingComplete', complete);
        await bounded(Promise.resolve().then(() => session.detach()), completionTimeoutMs, 'detach-timeout').catch(() => {});
      }
      const collection = {status: state === 'new' || state === 'unavailable' ? 'unavailable' : reasons.size || !completionReceived ? 'incomplete' : 'complete', reasons: [...reasons].sort(), completeEventReceived: completionReceived, eventsReceived: received, eventsRetained: events.length, bytesRetained, maxEvents, maxBytes};
      const trace = {kind: 'sanitized-chromium-trace-1', clock: 'chromium-monotonic-microseconds', collection, events};
      const bytes = Buffer.from(JSON.stringify(trace));
      if (bytes.length > maxBytes) throw Error('Trace artifact byte bound exceeded');
      await mkdir(artifactDirectory, {recursive: true, mode: 0o700});
      const path = join(artifactDirectory, artifactName);
      await writeFile(path, bytes, {flag: 'wx', mode: 0o600});
      state = 'stopped';
      return {artifact: {path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}, collection, analysis: analyzeTrace(trace, analysisOptions),
        presentation: analyzePresentation({...analysisOptions.presentation, trace})};
    })();
    return stopPromise;
  }
  return {start, stop};
}

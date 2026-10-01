import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyzeTrace, createBrowserTrace, sanitizeTraceEvent} from '../../tooling/qualification/campaigns/browser-trace.mjs';

const event = (name, ts, dur = 0, rest = {}) => ({cat: 'devtools.timeline', name, ph: 'X', pid: 10, tid: 20, ts, dur, ...rest});
const complete = events => ({collection: {status: 'complete', completeEventReceived: true, reasons: []}, events});
const attribution = (intervals = [{startUs: 0, endUs: 50_000}]) => ({mainThread: {pid: 10, tid: 20}, attribution: {complete: true, includesBackgroundAppWork: true, includesTriggeredRendering: true, intervals}, frameSlots: Array.from({length: 3}, (_, index) => ({startUs: index * 1_000_000 / 60, endUs: (index + 1) * 1_000_000 / 60})), frameSlotSource: 'validated-display-clock', displayRefreshHz: 60, visibility: 'visible'});

test('sanitization admits only fixed enums and numeric product identities', () => {
  const secret = 'https://example.invalid/?token=SECRET prompt=PRIVATE';
  const input = [
    event('FunctionCall', 10, 20, {args: {url: secret, stackTrace: [{functionName: secret}]}, id: secret}),
    event('ie.intent.Select layers', 20, 0, {cat: 'blink.user_timing', ph: 'R', args: {detail: {documentId: secret}}}),
    event('ie.perf.v1:intent:42', 25, 0, {cat: 'blink.user_timing', ph: 'R', args: {prompt: secret}}),
    event(`ie.intent.Open ${secret}`, 30, 0, {cat: 'blink.user_timing', ph: 'R'}),
    event(secret, 30, 0), event('ResourceSendRequest', 10, 5, {args: {headers: secret}}),
  ];
  const sanitized = input.map(sanitizeTraceEvent).filter(Boolean);
  assert.equal(sanitized.length, 3);
  assert.doesNotMatch(JSON.stringify(sanitized), /SECRET|PRIVATE|url|args|documentId|stackTrace|https/);
  assert.deepEqual(sanitized[1], {cat: 'blink.user_timing', name: 'product-mark', ph: 'I', ts: 20, pid: 10, tid: 20, kind: 'intent', id: 1});
  assert.equal(sanitized[2].id, 42);
  for (const raw of [event('Layout', -1, 2), event('Layout', 1, NaN), event('Layout', 1, Infinity), event('Layout', 1, 2, {pid: '10'}), event('Layout', 1, 2, {tid: -1}), event('Layout', 1, 2, {cat: 'network'})]) assert.equal(sanitizeTraceEvent(raw), null);
  assert.equal(sanitizeTraceEvent(event(42, 0, 0, {cat: 'blink.user_timing', ph: 'R'})), null);
});

test('renderer paint, DrawFrame and product acknowledgement never become physical presentation', () => {
  const result = analyzeTrace(complete([event('Paint', 0, 1000), event('DrawFrame', 2000, 0, {cat: 'cc', ph: 'I'}), event('ie.perf.v1:feedback:42', 2500, 0, {cat: 'blink.user_timing', ph: 'R'})]));
  assert.equal(result.outcome, 'INCONCLUSIVE'); assert.equal(result.qualification, false);
  for (const key of ['physicalPresentation', 'pointerToPresentedPaint', 'meaningfulFeedbackPresented', 'droppedDisplaySlots']) assert.equal(result[key].status, 'unavailable');
  assert.equal(result.marks.length, 1); assert.equal(result.diagnosticFrameEvents, 1);
  assert.equal(result.frameWork.status, 'unavailable');
});

test('main-thread interval unions clip slots, avoid nested double counting, and exclude other lanes', () => {
  const result = analyzeTrace(complete([event('RunTask', 0, 6000), event('FunctionCall', 1000, 3000), event('Layout', 5000, 3000), event('Paint', 16_000, 2000), event('RunTask', 100, 50000, {tid: 21})]), attribution());
  assert.equal(result.frameWork.status, 'measured'); assert.equal(result.frameWork.sampleCount, 3);
  assert.ok(Math.abs(result.frameWork.samples[0].workMs - 8.666666666666668) < 1e-10);
  assert.ok(Math.abs(result.frameWork.samples[1].workMs - 1.3333333333333321) < 1e-10);
  assert.equal(result.frameWork.samples[2].workMs, 0);
  assert.equal(result.frameWork.ceilingBreached, false); assert.equal(result.outcome, 'INCONCLUSIVE');
});

test('attribution clips explicit app work; lane identity alone is only diagnostic', () => {
  const trace = complete([event('RunTask', 0, 16_000)]);
  const options = attribution([{startUs: 5000, endUs: 10_000}]);
  assert.equal(analyzeTrace(trace, options).frameWork.maximumMs, 5);
  for (const amend of [options => delete options.attribution, options => options.attribution.complete = false, options => options.attribution.includesBackgroundAppWork = false, options => options.attribution.includesTriggeredRendering = false, options => options.frameSlotSource = 'requestAnimationFrame', options => options.visibility = 'hidden', options => options.displayRefreshHz = 120, options => options.frameSlots[1].startUs = 0]) {
    const value = attribution(); amend(value);
    assert.equal(analyzeTrace(trace, value).frameWork.status, 'unavailable');
  }
  const empty = analyzeTrace(complete([]), attribution());
  assert.equal(empty.frameWork.status, 'unavailable'); assert.equal(empty.frameWork.diagnosticMainThreadWorkMs, null);
  assert.ok(empty.reasons.includes('main-thread-work-evidence-missing'));
});

test('a proved work ceiling violation outranks missing presentation and trace incompleteness', () => {
  const trace = complete([event('RunTask', 0, 10_001)]);
  assert.equal(analyzeTrace(trace, attribution()).outcome, 'FAIL');
  trace.collection.status = 'incomplete'; trace.collection.reasons = ['browser-data-loss'];
  const result = analyzeTrace(trace, attribution());
  assert.equal(result.outcome, 'FAIL'); assert.equal(result.frameWork.status, 'partial-diagnostic');
  assert.equal(result.frameWork.ceilingBreached, true);
  assert.equal(analyzeTrace(complete([event('RunTask', 0, 10_000)]), attribution()).frameWork.ceilingBreached, false);
});

test('balanced B/E spans work and missing or mismatched endings retain incompleteness', () => {
  const start = event('RunTask', 0, 0, {ph: 'B'}); const end = event('', 5000, 0, {ph: 'E'});
  assert.equal(analyzeTrace(complete([start, end]), attribution()).frameWork.maximumMs, 5);
  for (const events of [[start], [end], [start, {...end, name: 'Layout'}]]) {
    const result = analyzeTrace(complete(events), attribution());
    assert.equal(result.frameWork.status, 'partial-diagnostic'); assert.ok(result.reasons.includes('unmatched-main-thread-intervals'));
  }
  const malformed = analyzeTrace(complete([event('Layout', 0, Infinity)]), attribution());
  assert.equal(malformed.frameWork.status, 'partial-diagnostic'); assert.ok(malformed.reasons.includes('malformed-work-event'));
});

class Session extends EventEmitter {
  constructor({events = [], loss = false, noCompletion = false, startReject = false, bufferFull = false} = {}) {super(); Object.assign(this, {events, loss, noCompletion, startReject, bufferFull}); this.commands = []; this.detached = false;}
  async send(command, params) {
    this.commands.push({command, params});
    if (command === 'Tracing.start') {
      if (this.startReject) throw Error('SECRET URL');
      if (this.bufferFull) queueMicrotask(() => this.emit('Tracing.bufferUsage', {percentFull: 0.95}));
    }
    if (command === 'Tracing.end') {
      this.emit('Tracing.dataCollected', {value: this.events});
      if (!this.noCompletion) this.emit('Tracing.tracingComplete', {dataLossOccurred: this.loss});
    }
    return {};
  }
  async detach() {this.detached = true;}
}

async function fixture(t, configuration = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ie-trace-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const session = new Session(configuration);
  const page = {context: () => ({newCDPSession: async () => session})};
  return {trace: createBrowserTrace(page, {artifactDirectory: directory, ...options}), directory, session};
}

test('collector saves a bounded sanitized artifact and idempotent stop detaches the session', async t => {
  const {trace, session} = await fixture(t, {events: [event('RunTask', 0, 5000, {args: {prompt: 'SECRET'}})]});
  assert.deepEqual(await trace.start(), {status: 'active'});
  const result = await trace.stop(attribution());
  assert.equal(await trace.stop(), result); assert.equal(session.detached, true);
  assert.equal(result.collection.status, 'complete'); assert.equal(result.analysis.outcome, 'INCONCLUSIVE');
  const bytes = await readFile(result.artifact.path);
  assert.equal(bytes.length, result.artifact.bytes); assert.doesNotMatch(bytes.toString(), /SECRET|args|prompt/);
  assert.equal(JSON.parse(bytes).events.length, 1);
  const start = session.commands.find(item => item.command === 'Tracing.start').params;
  assert.equal(start.traceConfig.enableArgumentFilter, true); assert.equal(start.traceConfig.enableSampling, false);
  assert.equal(start.traceConfig.recordMode, 'recordUntilFull'); assert.equal(start.transferMode, 'ReportEvents');
  assert.ok(!start.traceConfig.includedCategories.some(value => /screenshot|network|netlog/.test(value)));
  await assert.rejects(trace.start(), /only once/);
});

test('collector loss, event overflow and byte overflow retain missing evidence', async t => {
  for (const [configuration, options, expected] of [
    [{events: [event('RunTask', 0, 100)], loss: true}, {}, 'browser-data-loss'],
    [{events: [event('RunTask', 0, 100), event('RunTask', 100, 100)]}, {maxEvents: 1}, 'event-limit'],
    [{events: Array.from({length: 100}, (_, index) => event('RunTask', index * 1000, 100))}, {maxBytes: 4096}, 'byte-limit'],
    [{bufferFull: true}, {}, 'browser-buffer-limit'],
  ]) {
    const {trace} = await fixture(t, configuration, options); await trace.start(); const result = await trace.stop();
    assert.equal(result.collection.status, 'incomplete'); assert.ok(result.collection.reasons.includes(expected));
    if (configuration.events) assert.equal(result.collection.eventsReceived, configuration.events.length);
    assert.equal(result.analysis.outcome, 'INCONCLUSIVE'); assert.ok(result.artifact.bytes <= (options.maxBytes ?? 16 * 1024 * 1024));
  }
});

test('one collector preserves safe presentation IDs and exposes causal save bounds', async t => {
  const events = [
    event('EventLatency', 1000, 15000, {cat: 'cc', id2: {local: '0x30'}, args: {event_latency: {event_latency_id: '700', surface_frame_trace_id: '800', display_trace_id: '900', event_type: 'MOUSE_PRESSED'}, prompt: 'SECRET'}}),
    event('SwapEndToPresentationCompositorFrame', 12000, 4000, {cat: 'cc', id2: {local: '0x30'}}),
    event('ie.perf.v1:clock-before:1', 2000, 0, {cat: 'blink.user_timing', ph: 'R'}),
    event('ie.perf.v1:clock-after:1', 3000, 0, {cat: 'blink.user_timing', ph: 'R'}),
  ];
  const {trace, session} = await fixture(t, {events}); await trace.start();
  const bracket = {kind: 'browser-trace-action-bracket-1', id: 1, status: 'complete', actionCompleted: true, sameDocument: true, browserTimeOrigin: 10000, beforeBrowserMs: 2, afterBrowserMs: 3};
  const result = await trace.stop({presentation: {requests: [{id: 1, start: {kind: 'bracketed-save', bracket}}], runtime: {engine: 'chromium'}}});
  assert.equal(session.commands.filter(command => command.command === 'Tracing.start').length, 1);
  assert.equal(result.presentation.outcome, 'INCONCLUSIVE');
  assert.equal(result.presentation.diagnosticJoins[0].status, 'diagnostic-id-join');
  assert.equal(result.presentation.observations[0].start.earliestUs, 2000);
  assert.equal(result.presentation.observations[0].start.latestUs, 3000);
  const saved = (await readFile(result.artifact.path)).toString();
  assert.doesNotMatch(saved, /SECRET|prompt/);
  assert.equal(JSON.parse(saved).events[0].latency.event_latency_id, '700');
  const categories = session.commands.find(command => command.command === 'Tracing.start').params.traceConfig.includedCategories;
  assert.ok(categories.includes('graphics.pipeline')); assert.ok(categories.includes('disabled-by-default-display.framedisplayed'));
});

test('independent async presentation spans cannot pollute the renderer work stack', () => {
  const result = analyzeTrace(complete([
    event('RunTask', 0, 5000),
    event('EventLatency', 0, 0, {cat: 'cc', ph: 'b', id2: {local: '0x30'}, args: {event_latency: {event_latency_id: '700'}}}),
    event('Graphics.Pipeline', 1000, 0, {cat: 'cc', ph: 'B', args: {chrome_graphics_pipeline: {step: 'STEP_SUBMIT_COMPOSITOR_FRAME', surface_frame_trace_id: '800', latency_ids: ['700']}}}),
  ]), attribution());
  assert.equal(result.frameWork.status, 'measured');
  assert.equal(result.frameWork.maximumMs, 5);
  assert.ok(!result.reasons.includes('unmatched-main-thread-intervals'));
});

test('trace completion timeout and unavailable CDP are bounded and never leak exception text', async t => {
  const {trace, session} = await fixture(t, {noCompletion: true}, {completionTimeoutMs: 5});
  await trace.start(); const result = await trace.stop();
  assert.ok(result.collection.reasons.includes('trace-completion-timeout')); assert.equal(session.detached, true);
  const directory = await mkdtemp(join(tmpdir(), 'ie-trace-unsupported-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const unsupported = createBrowserTrace({context: () => ({newCDPSession: async () => {throw Error('SECRET provider key');}})}, {artifactDirectory: directory});
  assert.equal((await unsupported.start()).status, 'unavailable');
  const missing = await unsupported.stop(); assert.equal(missing.collection.status, 'unavailable');
  assert.doesNotMatch((await readFile(missing.artifact.path)).toString(), /SECRET|provider key/);
});

test('unsafe destinations and limits are rejected; existing evidence is never overwritten', async t => {
  for (const options of [{artifactDirectory: 'relative'}, {artifactDirectory: '/tmp', artifactName: '../secret.json'}, {artifactDirectory: '/tmp', maxEvents: 0}, {artifactDirectory: '/tmp', maxBytes: 3000}, {artifactDirectory: '/tmp', completionTimeoutMs: Infinity}]) assert.throws(() => createBrowserTrace({}, options));
  const {trace, directory} = await fixture(t); await trace.start(); const original = await trace.stop();
  const second = createBrowserTrace({context: () => ({newCDPSession: async () => new Session()})}, {artifactDirectory: directory});
  await second.start(); await assert.rejects(second.stop(), {code: 'EEXIST'});
  assert.equal((await readFile(original.artifact.path)).length, original.artifact.bytes);
});

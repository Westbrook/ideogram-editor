import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzePresentation, bracketTraceAction, presentationClockBounds, sanitizePresentationTraceEvent} from '../../tooling/qualification/campaigns/browser-presentation.mjs';
import {sanitizeTraceEvent} from '../../tooling/qualification/campaigns/browser-trace.mjs';

const event = (name, ts, dur = 0, extra = {}) => ({name, cat: 'cc,benchmark,input', ph: 'X', pid: 10, tid: 20, ts, dur, id2: {local: '0x30'}, ...extra});
const latency = (id = '700', extra = {}) => event('EventLatency', 1000, 15000, {args: {event_latency: {event_latency_id: id, surface_frame_trace_id: '800', display_trace_id: '900', event_type: 'MOUSE_PRESSED'}}, ...extra});
const endpoint = (extra = {}) => event('SwapEndToPresentationCompositorFrame', 12000, 4000, extra);
const pipeline = (data, ts = 5000) => event('Graphics.Pipeline', ts, 1000, {cat: 'viz,graphics.pipeline', args: {chrome_graphics_pipeline: data}});
const trace = events => ({clock: 'chromium-monotonic-microseconds', collection: {status: 'complete', completeEventReceived: true, reasons: []}, events});
const clockMark = (kind, id, ts, extra = {}) => event(`ie.perf.v1:${kind}:${id}`, ts, 0, {cat: 'blink.user_timing', ph: 'R', ...extra});
const bracket = (id = 1) => ({kind: 'browser-trace-action-bracket-1', id, status: 'complete', actionCompleted: true, sameDocument: true, browserTimeOrigin: 100000, beforeBrowserMs: 2, afterBrowserMs: 3});

test('sanitizer preserves exact typed IDs but strips free strings and invented feedback', () => {
  const raw = latency('9223372036854775807');
  raw.args.event_latency.prompt = 'PRIVATE'; raw.args.url = 'SECRET'; raw.args.presentation_feedback = {flags: 7};
  const clean = sanitizePresentationTraceEvent(raw);
  assert.equal(clean.latency.event_latency_id, '9223372036854775807');
  assert.equal(clean.track.id, '48');
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE|SECRET|args|feedback|flags/);
  assert.deepEqual(sanitizePresentationTraceEvent(clean), clean);
  assert.deepEqual(sanitizeTraceEvent(raw), clean);
  assert.equal(sanitizePresentationTraceEvent(latency(9007199254740992)), null);
  assert.equal(sanitizePresentationTraceEvent(latency('9223372036854775808')), null);
  assert.equal(sanitizePresentationTraceEvent(latency('-1')), null);
  assert.equal(sanitizePresentationTraceEvent(latency('0007')), null);
  assert.equal(sanitizePresentationTraceEvent({...raw, ts: Infinity}), null);
  assert.equal(sanitizePresentationTraceEvent({...raw, dur: -1}), null);
});

test('typed IDs and async track IDs have distinct domains and local process scope', () => {
  const raw = latency('0x700', {id2: {local: '0xffffffffffffffff'}});
  const clean = sanitizePresentationTraceEvent(raw);
  assert.equal(clean.latency.event_latency_id, '1792');
  assert.equal(clean.track.id, '18446744073709551615');
  assert.equal(clean.track.pid, 10);
  assert.equal(sanitizePresentationTraceEvent({...clean, pid: 11}), null);
  assert.equal(sanitizePresentationTraceEvent({...raw, id: '0x30'}), null);
  const result = analyzePresentation({trace: trace([latency(), endpoint({pid: 11})])});
  assert.equal(result.diagnosticJoins[0].status, 'unavailable');
});

test('complete exact EventLatency join is diagnostic and includes input queueing', () => {
  const result = analyzePresentation({trace: trace([latency(), endpoint()]), requests: [{id: 1, latencyId: '700'}]});
  assert.equal(result.outcome, 'INCONCLUSIVE'); assert.equal(result.qualification, false);
  assert.equal(result.diagnosticJoins[0].status, 'diagnostic-id-join');
  assert.equal(result.diagnosticJoins[0].diagnosticInputToReportedPresentationMs, 15);
  assert.equal(result.observations[0].start.earliestUs, 1000);
  assert.equal(result.observations[0].presentedUs, null);
  assert.equal(result.observations[0].durationMs, null);
  assert.equal(result.physicalPresentation.status, 'unavailable');
  assert.equal(result.droppedDisplaySlots.status, 'unavailable');
});

test('caller-selected latency IDs preserve trace facts without claiming actual input ownership', () => {
  const result = analyzePresentation({trace: trace([latency(), endpoint()]), requests: [
    {id: 1, latencyId: '700'},
    {id: 2, latencyId: '700', actualInputBound: true, nativeInput: true, exact: true},
  ]});
  assert.equal(result.outcome, 'INCONCLUSIVE'); assert.equal(result.qualification, false);
  assert.equal(result.diagnosticJoins.length, 1);
  assert.equal(result.diagnosticJoins[0].latencyId, '700');
  assert.equal(result.diagnosticJoins[0].inputTsUs, 1000);
  assert.equal(result.diagnosticJoins[0].surfaceFrameTraceId, '800');
  assert.equal(result.diagnosticJoins[0].displayTraceId, '900');
  assert.equal(result.diagnosticJoins[0].reportedPresentationUs, 16000);
  assert.equal(result.diagnosticJoins[0].diagnosticInputToReportedPresentationMs, 15);
  for (const observation of result.observations) {
    assert.deepEqual(observation.start, {status: 'diagnostic-trace-input-start', clock: 'chromium-monotonic-microseconds',
      earliestUs: 1000, latestUs: 1000, exact: false, actualInputBound: false});
    assert.equal(observation.diagnosticJoin, result.diagnosticJoins[0]);
    assert.equal(observation.outcome, 'INCONCLUSIVE'); assert.equal(observation.qualification, false);
    assert.equal(observation.presentedUs, null); assert.equal(observation.durationMs, null);
    assert.deepEqual(observation.missing, ['physical-presentation-unavailable', 'correct-content-frame-binding-unavailable']);
  }
  assert.equal(result.physicalPresentation.status, 'unavailable');
  assert.equal(result.droppedDisplaySlots.status, 'unavailable');
});

test('explicit pipeline relationships can recover omitted surface/display IDs', () => {
  const input = latency('700', {args: {event_latency: {event_latency_id: '700', event_type: 'KEY_PRESSED'}}});
  const result = analyzePresentation({trace: trace([input, endpoint(),
    pipeline({step: 9, surface_frame_trace_id: '800', latency_ids: ['700']}),
    pipeline({step: 10, display_trace_id: '900', aggregated_surface_frame_trace_ids: ['800']})])});
  assert.equal(result.diagnosticJoins[0].status, 'diagnostic-id-join');
  assert.equal(result.diagnosticJoins[0].surfaceFrameTraceId, '800');
  assert.equal(result.diagnosticJoins[0].displayTraceId, '900');
  assert.equal(result.qualification, false);
});

test('conflicting and ambiguous pipeline IDs never join by temporal proximity', () => {
  for (const data of [
    {step: 'STEP_SUBMIT_COMPOSITOR_FRAME', surface_frame_trace_id: '801', latency_ids: ['700']},
    {step: 'STEP_SURFACE_AGGREGATION', display_trace_id: '901', aggregated_surface_frame_trace_ids: ['800']},
  ]) {
    const result = analyzePresentation({trace: trace([latency(), endpoint(), pipeline(data)])});
    assert.equal(result.diagnosticJoins[0].status, 'unavailable');
    assert.equal(result.diagnosticJoins[0].reportedPresentationUs, null);
  }
  const result = analyzePresentation({trace: trace([latency(), endpoint()]), requests: [{id: 1, latencyId: '701', intentMs: 1}]});
  assert.equal(result.observations[0].diagnosticJoin, null);
  assert.equal(result.observations[0].start.status, 'unavailable');
});

test('duplicate latency IDs and endpoint stages retain ambiguity', () => {
  for (const events of [[latency(), latency(), endpoint()], [latency(), endpoint(), endpoint()]]) {
    const result = analyzePresentation({trace: trace(events)});
    assert.ok(result.diagnosticJoins.every(join => join.status === 'unavailable'));
    assert.equal(result.outcome, 'INCONCLUSIVE');
  }
});

test('multiple inputs can share one display frame without inventing display slots', () => {
  const result = analyzePresentation({trace: trace([latency(), endpoint(), latency('701', {id2: {local: '0x31'}}), endpoint({id2: {local: '0x31'}})])});
  assert.equal(result.diagnosticJoins.length, 2);
  assert.ok(result.diagnosticJoins.every(join => join.status === 'diagnostic-id-join' && join.displayTraceId === '900'));
  assert.equal(result.droppedDisplaySlots.status, 'unavailable');
  assert.equal(result.droppedDisplaySlots.totalSlots, undefined);
});

test('begin/end exporter events pair only on exact track and event identity', () => {
  const begin = latency('700', {ph: 'b'}), end = event('EventLatency', 16000, 0, {ph: 'e'});
  const stageBegin = endpoint({ph: 'b'}), stageEnd = event('SwapEndToPresentationCompositorFrame', 16000, 0, {ph: 'e'});
  const result = analyzePresentation({trace: trace([begin, stageBegin, stageEnd, end])});
  assert.equal(result.diagnosticJoins[0].status, 'diagnostic-id-join');
  for (const events of [[begin, stageBegin, stageEnd], [begin, begin, stageBegin, stageEnd, end], [begin, {...end, id2: {local: '0x31'}}]]) {
    const partial = analyzePresentation({trace: trace(events)});
    assert.ok(partial.reasons.includes('unmatched-or-ambiguous-presentation-spans'));
    assert.equal(partial.outcome, 'INCONCLUSIVE');
  }
});

test('latch fallback, nonterminal stage and unrelated track do not supply an endpoint', () => {
  for (const stage of [endpoint({name: 'LatchToSwapEnd'}), endpoint({dur: 2000}), endpoint({id2: {local: '0x31'}})]) {
    const result = analyzePresentation({trace: trace([latency(), stage])});
    assert.equal(result.diagnosticJoins[0].status, 'unavailable');
    assert.equal(result.diagnosticJoins[0].reportedPresentationUs, null);
  }
});

test('native feedback flags, renderer/DOM marks and FrameDisplayed cannot bypass unavailable capture', () => {
  const events = ['Paint', 'DrawFrame', 'FireAnimationFrame', 'ie.perf.v1:feedback:1', 'Display::FrameDisplayed'].map(name => event(name, 16000, 0));
  for (const flags of [0, 1, 2, 4, 7, 15, 16, 31]) {
    const result = analyzePresentation({trace: trace(events), nativeEvidence: {flags, is_presented: true, hardwareValidated: true, contentMatches: true, displayTraceId: '900'}, runtime: {headless: true, nativeCapturePermission: 'denied'}});
    assert.equal(result.outcome, 'INCONCLUSIVE');
    assert.equal(result.diagnosticJoins.length, 0);
    assert.equal(result.diagnosticFrameDisplayedEvents, 1);
    assert.ok(result.reasons.includes('native-evidence-profile-unsupported'));
    assert.ok(result.reasons.includes('headless-display-not-physical'));
    assert.ok(result.reasons.includes('native-capture-permission-denied'));
  }
});

test('lossy/truncated collections do not become complete from available successful joins', () => {
  const source = trace([latency(), endpoint()]);
  source.collection.reasons.push('browser-data-loss');
  const result = analyzePresentation({trace: source});
  assert.ok(result.reasons.includes('trace-incomplete-or-clock-unknown'));
  assert.equal(result.outcome, 'INCONCLUSIVE');
  assert.equal(result.qualification, false);
});

test('D05 causal save bounds use both trace markers without mixing runner clock origins', () => {
  const source = trace([clockMark('clock-before', 1, 1000), clockMark('clock-after', 1, 5000)]);
  const result = presentationClockBounds(source, bracket());
  assert.equal(result.status, 'bounded'); assert.equal(result.earliestUs, 1000); assert.equal(result.latestUs, 5000);
  assert.equal(result.uncertaintyUs, 4000); assert.equal(result.exact, false);
  const analysis = analyzePresentation({trace: source, requests: [{id: 1, start: {kind: 'bracketed-save', bracket: bracket()}, savedMs: 999999999}]});
  assert.deepEqual(analysis.observations[0].start, result);
  assert.equal(analysis.observations[0].presentedUs, null);
  assert.equal(analysis.observations[0].durationMs, null);
});

test('save bounds reject missing, duplicate, reversed or cross-process anchors', () => {
  const before = clockMark('clock-before', 1, 1000), after = clockMark('clock-after', 1, 5000);
  for (const events of [[before], [after], [before, before, after], [before, after, after], [before, {...after, ts: 999}], [before, {...after, pid: 11}], [before, {...after, tid: 21}]]) {
    assert.equal(presentationClockBounds(trace(events), bracket()).status, 'unavailable');
  }
  for (const witness of [{...bracket(), sameDocument: false}, {...bracket(), actionCompleted: false}, {...bracket(), browserTimeOrigin: NaN}, {...bracket(), afterBrowserMs: 1}]) assert.equal(presentationClockBounds(trace([before, after]), witness).status, 'unavailable');
  const source = trace([before, after]); source.collection.completeEventReceived = false;
  assert.equal(presentationClockBounds(source, bracket()).status, 'unavailable');
});

test('one request cannot reuse another save bracket and request IDs remain unique', () => {
  const source = trace([clockMark('clock-before', 1, 1000), clockMark('clock-after', 1, 5000)]);
  const result = analyzePresentation({trace: source, requests: [{id: 2, start: {kind: 'bracketed-save', bracket: bracket(1)}}]});
  assert.equal(result.observations[0].start.reason, 'save-bracket-id-mismatch');
  assert.throws(() => analyzePresentation({trace: source, requests: [{id: 1}, {id: 1}]}), /unique/);
});

test('save helper causally orders marks and preserves the actual save receipt', async () => {
  const order = [], saved = {savedMs: 900000, clock: 'runner-monotonic'};
  const page = {evaluate: async (_fn, args) => {order.push(args.name); return {timeOrigin: 10000, startMs: order.length};}};
  const result = await bracketTraceAction({page, id: 7, run: async () => {order.push('save'); return saved;}});
  assert.deepEqual(order, ['ie.perf.v1:clock-before:7', 'save', 'ie.perf.v1:clock-after:7']);
  assert.equal(result.value, saved); assert.equal(result.bracket.status, 'complete');
  assert.equal(result.bracket.id, 7); assert.equal(result.bracket.sameDocument, true);
});

test('failed save does not emit a successful bracket and reload invalidates both anchors', async () => {
  let calls = 0;
  const page = {evaluate: async () => ({timeOrigin: ++calls, startMs: calls})};
  await assert.rejects(bracketTraceAction({page, id: 1, run: async () => {throw Error('save failed');}}), /save failed/);
  assert.equal(calls, 1);
  calls = 0;
  const result = await bracketTraceAction({page, id: 2, run: async () => 42});
  assert.equal(result.value, 42); assert.equal(result.bracket.status, 'unavailable'); assert.equal(result.bracket.sameDocument, false);
});

test('clock instrumentation failure preserves a completed save and reports missing evidence', async () => {
  for (const failureAt of [1, 2]) {
    let calls = 0, saves = 0;
    const page = {evaluate: async () => {if (++calls === failureAt) throw Error('SECRET browser context failure'); return {timeOrigin: 10000, startMs: calls};}};
    const result = await bracketTraceAction({page, id: 1, run: async () => {saves++; return {savedMs: 42};}});
    assert.equal(saves, 1); assert.deepEqual(result.value, {savedMs: 42});
    assert.equal(result.bracket.status, 'unavailable'); assert.equal(result.bracket.actionCompleted, true);
    assert.equal(result.bracket.reason, failureAt === 1 ? 'before-action-clock-mark-unavailable' : 'after-action-clock-mark-unavailable');
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('legacy source scopes cannot collapse unrelated asynchronous tracks', () => {
  assert.equal(sanitizePresentationTraceEvent(latency('700', {scope: 'A'})), null);
  const result = analyzePresentation({trace: trace([
    latency('700', {ph: 'b', scope: 'A'}),
    event('EventLatency', 16000, 0, {ph: 'e', scope: 'B'}), endpoint({scope: 'B'}),
  ])});
  assert.equal(result.diagnosticJoins.length, 0); assert.equal(result.qualification, false);
});

test('final aggregation replaces canceled duplicate steps before surface/display joins', () => {
  const submit = pipeline({step: 9, surface_frame_trace_id: '800', latency_ids: ['700']});
  const earlier = pipeline({step: 10, display_trace_id: '900', aggregated_surface_frame_trace_ids: ['800']}, 6000);
  const later = pipeline({step: 10, display_trace_id: '900', aggregated_surface_frame_trace_ids: ['801']}, 7000);
  for (const input of [latency(), latency('700', {args: {event_latency: {event_latency_id: '700'}}})]) {
    const result = analyzePresentation({trace: trace([input, endpoint(), submit, earlier, later])});
    assert.equal(result.diagnosticJoins[0].status, 'unavailable');
    assert.equal(result.diagnosticJoins[0].reportedPresentationUs, null);
  }
  const ambiguous = analyzePresentation({trace: trace([latency(), endpoint(), submit, earlier, {...later, ts: 6000}])});
  assert.ok(ambiguous.diagnosticJoins[0].missing.includes('surface-display-aggregation-ambiguous'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {analyzeDisplayFeedbackTrace, inspectR07Cohort, R07_MISSING_AUTHORITIES} from '../../tooling/qualification/campaigns/display-feedback.mjs';

// Synthetic parser fixtures only. These IDs are deliberately not measurement
// evidence; every result must remain INCONCLUSIVE even for an exact trace join.
const INPUT = 9007199254740993n, SURFACE = 9007199254740995n, DISPLAY = 9007199254740997n;
const number = raw => ({fixtureNumberLexeme: raw});
const encode = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? `RAW:${item}` : item?.fixtureNumberLexeme ? `RAW:${item.fixtureNumberLexeme}` : item).replace(/"RAW:([-\d.eE+]+)"/g, '$1');
function pi() {
  return {profile: 'P-I', durationMs: 60_000, refreshHz: 60, actions: [
    ...Array.from({length: 20}, (_, stroke) => ({id: `stroke-${stroke}`, kind: 'stroke', sampleHz: 60, sampleIds: Array.from({length: 120}, (_, point) => `s${stroke}-p${point}`)})),
    ...Array.from({length: 80}, (_, action) => ({id: `discrete-${action}`, kind: 'discrete'})),
  ]};
}
function itext() {
  const counts = {'insert-delete': 40, preedit: 20, 'composition-commit-cancel': 10, 'caret-selection': 10, 'semantic-list': 10, 'font-wrap-transform-guide': 10, 'presentation-request': 6};
  return {profile: 'IText', durationMs: 60_000, refreshHz: 60, actions: Object.entries(counts).flatMap(([kind, count]) => Array.from({length: count}, (_, i) => ({id: `${kind}-${i}`, kind})))};
}
const base = (name, ts, other = {}) => ({name, cat: 'cc,benchmark,graphics.pipeline,viz', ph: 'I', pid: 7, tid: 9, ts, ...other});
function fixture() {
  const track = {id2: {local: '0xffffffffffffffff'}};
  return [
    base('EventLatency', 100, {...track, ph: 'X', dur: 10, args: {event_latency: {event_latency_id: INPUT, surface_frame_trace_id: SURFACE, display_trace_id: DISPLAY, event_type: 'MOUSE_MOVED_EVENT'}}}),
    base('SwapEndToPresentationCompositorFrame', 109, {...track, ph: 'X', dur: 1}),
    base('Graphics.Pipeline', 102, {args: {chrome_graphics_pipeline: {step: 9, surface_frame_trace_id: SURFACE, latency_ids: [INPUT]}}}),
    base('Graphics.Pipeline', 105, {args: {chrome_graphics_pipeline: {step: 10, display_trace_id: DISPLAY, aggregated_surface_frame_trace_ids: [SURFACE]}}}),
    base('Display::FrameDisplayed', 110),
  ];
}
function manifestFor(bytes) {
  return {kind: 'display-feedback-raw-trace-1',
    collection: {status: 'complete', startOutcome: 'acknowledged', completeEventReceived: true, dataLossOccurred: false, streamReceived: true, eof: true, reasons: [], bytes: bytes.length},
    artifact: {format: 'json', compression: 'none', bytes: bytes.length, persistedSize: bytes.length, rawClosed: true, hashScope: 'completed-file', hashVerifiedAgainstSize: true, sha256: createHash('sha256').update(bytes).digest('hex')},
    protocol: {transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none', enableArgumentFilter: false},
    browserVersion: {status: 'observed', product: 'Chrome/153.0.8010.12'}, manifest: {saved: true}};
}
async function analyze(events = fixture(), {text, cohort = pi(), manifestChange, extra = {}, chunkSize = 113} = {}) {
  const bytes = Buffer.from(text ?? encode({traceEvents: events, metadata: {fixture: true}}));
  const manifest = manifestFor(bytes); manifestChange?.(manifest);
  async function* chunks() {for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);}
  return analyzeDisplayFeedbackTrace({chunks: chunks(), manifest, cohort, ...extra});
}

test('retains neighboring >2^53 typed IDs and uint64 async IDs exactly', async () => {
  const result = await analyze();
  assert.equal(result.rawArtifact.fullJsonValidated, true);
  assert.equal(result.rawArtifact.matchesCollectionManifest, true);
  assert.equal(result.diagnostics.joins.length, 1);
  const row = result.diagnostics.joins[0];
  assert.equal(row.eventLatencyId, '9007199254740993');
  assert.equal(row.surfaceFrameTraceId, '9007199254740995');
  assert.equal(row.displayTraceId, '9007199254740997');
  assert.equal(row.asyncTrack, 'local:7:18446744073709551615');
  assert.equal(row.diagnosticJoin, 'exact-trace-identities');
  assert.equal(row.traceSpanUs, '10');
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.qualification, false);
  assert.deepEqual(result.missingAuthorities, [...R07_MISSING_AUTHORITIES]);
  assert.equal(row.actualInputBound, false);
  assert.equal(row.meaningfulContentBound, false);
  assert.equal(row.physicalPresentationQualified, false);
});

test('large fractional trace timestamps remain exact without floating-point clock guesses', async () => {
  const events = fixture();
  events[0].ts = number('9007199254740993.001');
  events[1].ts = number('9007199254741002.001');
  events[2].ts = number('9007199254740995.001');
  events[3].ts = number('9007199254740998.001');
  events[4].ts = number('9007199254741003.001');
  const result = await analyze(events);
  const row = result.diagnostics.joins[0];
  assert.equal(row.diagnosticJoin, 'exact-trace-identities');
  assert.equal(row.traceStartUs, '9007199254740993.001');
  assert.equal(row.traceEndUs, '9007199254741003.001');
  assert.equal(row.traceSpanUs, '10');
});

test('neighboring raw IDs cannot join by rounded Number or timestamp proximity', async () => {
  const events = fixture();
  events[2].args.chrome_graphics_pipeline.latency_ids = [INPUT - 1n];
  const result = await analyze(events);
  assert.equal(result.diagnostics.joins[0].diagnosticJoin, 'unavailable');
  assert.ok(result.diagnostics.joins[0].reasons.includes('exact-input-surface-submission-missing-or-ambiguous'));
});

test('unknown sentinel and overflowing int64 typed frame IDs do not become identities', async () => {
  for (const invalid of [-1n, 9223372036854775808n]) {
    const events = fixture(); events[0].args.event_latency.surface_frame_trace_id = invalid;
    const result = await analyze(events);
    assert.equal(result.diagnostics.joins[0].diagnosticJoin, 'unavailable');
    assert.ok(result.diagnostics.joins[0].reasons.includes('event-latency-surface-conflict-or-unknown'));
  }
});

test('a JSON object resembling a number wrapper cannot forge a typed numeric fact', async () => {
  const events = fixture(); events[0].args.event_latency.event_latency_id = {kind: 'trace-number', raw: String(INPUT)};
  const result = await analyze(events);
  assert.equal(result.diagnostics.joins.length, 0);
  assert.ok(result.reasons.includes('required-trace-facts-malformed-or-unsupported'));
});

test('LatchToSwapEnd never substitutes for an explicit presentation endpoint', async () => {
  const events = fixture(); events[1].name = 'LatchToSwapEnd';
  const result = await analyze(events);
  assert.equal(result.diagnostics.joins[0].diagnosticJoin, 'unavailable');
  assert.ok(result.diagnostics.joins[0].reasons.includes('explicit-terminal-presentation-stage-missing-or-ambiguous'));
});

test('FrameDisplayed, rAF, Paint and caller flags cannot supply missing presentation authority', async () => {
  const events = fixture(); events.splice(1, 1);
  events.push(base('Paint', 110), base('FireAnimationFrame', 110));
  const result = await analyze(events, {extra: {requests: [{latencyId: String(INPUT)}], frameSlots: [{presented: true}], nativeEvidence: {qualified: true, physical: true, droppedFrames: 0}}});
  assert.equal(result.diagnostics.frameDisplayedEvents, 1);
  assert.equal(result.diagnostics.joins[0].diagnosticJoin, 'unavailable');
  assert.equal(result.qualification, false);
  for (const metric of Object.values(result.metrics)) assert.equal(metric.status, 'unavailable');
});

test('repeated input submissions are ambiguous even when their surface strings agree', async () => {
  const events = fixture(); events.push(structuredClone(events[2]));
  const result = await analyze(events);
  assert.ok(result.diagnostics.joins[0].reasons.includes('exact-input-surface-submission-missing-or-ambiguous'));
});

test('final aggregation excludes a surface present only in a canceled earlier aggregation', async () => {
  const events = fixture();
  events.push(base('Graphics.Pipeline', 108, {args: {chrome_graphics_pipeline: {step: 10, display_trace_id: DISPLAY, aggregated_surface_frame_trace_ids: [SURFACE + 1n]}}}));
  const result = await analyze(events);
  assert.ok(result.diagnostics.joins[0].reasons.includes('final-aggregation-excludes-submitted-surface'));
});

test('superseded tied aggregations do not depend on raw JSON event order', async () => {
  const original = fixture(), earlier = structuredClone(original[3]), canceled = structuredClone(original[3]);
  earlier.ts = 103; canceled.ts = 103;
  canceled.args.chrome_graphics_pipeline.aggregated_surface_frame_trace_ids = [SURFACE + 1n];
  for (const order of [[earlier, canceled, original[3]], [original[3], earlier, canceled], [canceled, original[3], earlier]]) {
    const result = await analyze([...original.slice(0, 3), ...order, original[4]]);
    assert.equal(result.diagnostics.joins[0].diagnosticJoin, 'exact-trace-identities');
  }
});

test('tied contradictory aggregation memberships and unrelated lanes are rejected', async () => {
  for (const crossLane of [false, true]) {
    const events = fixture(), extra = structuredClone(events[3]);
    if (crossLane) extra.tid = 10;
    else extra.args.chrome_graphics_pipeline.aggregated_surface_frame_trace_ids = [SURFACE + 1n];
    events.push(extra);
    const result = await analyze(events);
    assert.ok(result.diagnostics.joins[0].reasons.includes('exact-final-surface-display-aggregation-missing-or-ambiguous'));
  }
});

test('a malformed final aggregation cannot reveal an older canceled join as exact', async () => {
  const events = fixture();
  events.push(base('Graphics.Pipeline', 108, {args: {chrome_graphics_pipeline: {step: 10, display_trace_id: DISPLAY, aggregated_surface_frame_trace_ids: [SURFACE, SURFACE]}}}));
  const result = await analyze(events);
  assert.equal(result.rawArtifact.matchesCollectionManifest, true);
  assert.equal(result.diagnostics.joins.length, 0);
  assert.ok(result.reasons.includes('required-trace-facts-malformed-or-unsupported'));
});

test('any malformed span set makes surviving joins provisional and unavailable', async () => {
  const events = fixture();
  events.push(base('EventLatency', 120, {ph: 'e', id2: {local: '42'}}));
  const result = await analyze(events);
  assert.equal(result.diagnostics.joins[0].diagnosticJoin, 'unavailable');
  assert.ok(result.diagnostics.joins[0].reasons.includes('trace-span-set-incomplete-or-ambiguous'));
});

test('surface and display chronology must be inside the same latency span', async () => {
  const events = fixture(); events[3].ts = 111;
  const result = await analyze(events);
  assert.ok(result.diagnostics.joins[0].reasons.includes('aggregation-causal-order-invalid'));
});

test('local asynchronous IDs cannot cross processes', async () => {
  const events = fixture(); events[1].pid = 8;
  const result = await analyze(events);
  assert.ok(result.diagnostics.joins[0].reasons.includes('explicit-terminal-presentation-stage-missing-or-ambiguous'));
});

test('begin/end spans are complete and an unmatched end cannot fabricate a terminal stage', async () => {
  const events = fixture();
  events[0].ph = 'b'; delete events[0].dur;
  events.push(base('EventLatency', 110, {ph: 'e', id2: {local: '0xffffffffffffffff'}}));
  let result = await analyze(events);
  assert.equal(result.diagnostics.joins[0].diagnosticJoin, 'exact-trace-identities');
  events.pop(); result = await analyze(events);
  assert.equal(result.diagnostics.joins.length, 0);
  assert.ok(result.reasons.includes('presentation-spans-incomplete-or-ambiguous'));
});

test('mixed async and synchronous phases cannot fabricate a terminal span', async () => {
  for (const [begin, end] of [['b', 'E'], ['B', 'e'], ['B', 'E']]) {
    const events = fixture(); events[1].ph = begin; delete events[1].dur;
    events.push(base('SwapEndToPresentationCompositorFrame', 110, {ph: end, id2: {local: '0xffffffffffffffff'}}));
    const result = await analyze(events);
    assert.equal(result.diagnostics.joins.length, 0);
    assert.ok(result.reasons.includes('required-trace-facts-malformed-or-unsupported'));
  }
});

test('corrupt trailing JSON, duplicate metadata keys and truncation suppress every prefix join', async () => {
  const valid = encode({traceEvents: fixture()});
  for (const text of [valid + 'x', valid.slice(0, -1), valid.slice(0, -1) + ',"metadata":{"same":1,"same":2}}']) {
    const result = await analyze([], {text});
    assert.equal(result.rawArtifact.fullJsonValidated, false);
    assert.equal(result.diagnostics.joins.length, 0);
    assert.ok(result.reasons.includes('raw-trace-decode-failed-no-prefix-results'));
  }
});

test('hash mismatch, missing loss flag, incomplete collection and missing EOF suppress joins', async () => {
  for (const manifestChange of [manifest => {manifest.artifact.sha256 = '0'.repeat(64);}, manifest => {delete manifest.collection.dataLossOccurred;}, manifest => {manifest.collection.status = 'incomplete';}, manifest => {manifest.collection.eof = false;}, manifest => {manifest.protocol.enableArgumentFilter = true;}, manifest => {manifest.artifact.hashScope = 'persisted-prefix';}]) {
    const result = await analyze(fixture(), {manifestChange});
    assert.equal(result.rawArtifact.matchesCollectionManifest, false);
    assert.equal(result.diagnostics.joins.length, 0);
  }
});

test('diagnostic memory bound fails closed and does not return a truncated success', async () => {
  const result = await analyze(fixture(), {extra: {maxDiagnosticEvents: 1}});
  assert.equal(result.diagnostics.joins.length, 0);
  assert.equal(result.rawArtifact.fullJsonValidated, false);
  assert.match(result.rawArtifact.decodeFailure, /bound/);
});

test('cumulative typed identities and associations are bounded before graph indexes allocate', async () => {
  const result = await analyze(fixture(), {extra: {maxDiagnosticAssociations: 4}});
  assert.equal(result.diagnostics.joins.length, 0);
  assert.equal(result.rawArtifact.fullJsonValidated, false);
  assert.match(result.rawArtifact.decodeFailure, /association bound/);
  assert.ok(result.counts.retainedAssociations <= 4);
});

test('P-I preserves all 100 actions and 2,400 pointer samples', () => {
  const result = inspectR07Cohort(pi());
  assert.equal(result.status, 'declaration-valid');
  assert.equal(result.declaredActions, 100);
  assert.equal(result.declaredStrokePoints, 2400);
  assert.equal(result.expectedPhysicalSlots, null);
  assert.equal(result.observedExecution, false);
  assert.equal(result.qualification, false);
});

test('missing sample, duplicate sample, shortened segment and 120-Hz substitutions fail the cohort declaration', () => {
  for (const mutate of [value => value.actions[0].sampleIds.pop(), value => {value.actions[1].sampleIds[0] = value.actions[0].sampleIds[0];}, value => {value.durationMs = 59_999;}, value => {value.refreshHz = 120;}, value => value.actions.pop()]) {
    const value = pi(); mutate(value);
    assert.equal(inspectR07Cohort(value).status, 'invalid');
  }
});

test('oversized stroke declarations fail before iterating their sample values', () => {
  const value = pi();
  const samples = Array(121);
  Object.defineProperty(samples, '0', {get() {throw Error('oversized samples must not be traversed');}});
  value.actions[0].sampleIds = samples;
  assert.equal(inspectR07Cohort(value).status, 'invalid');
});

test('IText retains the original 100 plus six requests without manufacturing a deferred completion deadline', () => {
  const value = itext(), result = inspectR07Cohort(value);
  assert.equal(result.status, 'declaration-valid');
  assert.equal(result.declaredActions, 106);
  assert.equal(result.originalActionCount, 100);
  assert.equal(result.extraPresentationRequests, 6);
  assert.equal(result.expectedPhysicalSlots, null);
  value.actions.splice(100, 6);
  assert.equal(inspectR07Cohort(value).status, 'invalid');
});

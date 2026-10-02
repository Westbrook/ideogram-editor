import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, readdir, realpath, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowserTrace} from '../../tooling/qualification/campaigns/browser-trace.mjs';
import {rawDisplayFeedbackChunks} from '../../tooling/qualification/campaigns/browser-trace-raw.mjs';

const ownership = Object.freeze({kind: 'owned-isolated-synthetic-browser-1', admittedBy: 'root', owned: true, isolated: true, syntheticOnly: true, sessionOwned: true, browserInstanceId: 'synthetic-fixture-only'});
const rawText = () => '{"traceEvents":[' + [
  '{"cat":"metadata","name":"thread_name","ph":"M","pid":7,"tid":9,"args":{"name":"CrRendererMain"}}',
  '{"cat":"toplevel","name":"RunTask","ph":"X","pid":7,"tid":9,"ts":100.25,"dur":2.5}',
  '{"cat":"blink.user_timing","name":"ie.perf.v1:intent:1","ph":"I","pid":7,"tid":9,"ts":100}',
  '{"cat":"cc,benchmark","name":"EventLatency","ph":"X","pid":7,"tid":9,"ts":100,"dur":10,"id2":{"local":"0xffffffffffffffff"},"args":{"event_latency":{"event_latency_id":9007199254740993,"surface_frame_trace_id":9007199254740995,"display_trace_id":9007199254740997,"event_type":"MOUSE_MOVED_EVENT"}}}',
  '{"cat":"cc,benchmark","name":"SwapEndToPresentationCompositorFrame","ph":"X","pid":7,"tid":9,"ts":109,"dur":1,"id2":{"local":"0xffffffffffffffff"}}',
  '{"cat":"graphics.pipeline","name":"Graphics.Pipeline","ph":"I","pid":7,"tid":9,"ts":102,"args":{"chrome_graphics_pipeline":{"step":9,"surface_frame_trace_id":9007199254740995,"latency_ids":[9007199254740993]}}}',
  '{"cat":"graphics.pipeline","name":"Graphics.Pipeline","ph":"I","pid":7,"tid":9,"ts":105,"args":{"chrome_graphics_pipeline":{"step":10,"display_trace_id":9007199254740997,"aggregated_surface_frame_trace_ids":[9007199254740995]}}}',
  '{"cat":"disabled-by-default-not-enabled","name":"unrelated","ph":"I","pid":7,"tid":9,"ts":110,"args":{"private":"do-not-copy-to-sanitized-artifact"}}',
].join(',') + '],"metadata":{"fixture":true}}';

class FakeSession extends EventEmitter {
  constructor(text = rawText(), options = {}) {super(); this.bytes = Buffer.from(text); this.options = options; this.calls = []; this.offset = 0; this.detaches = 0;}
  async send(method, params) {
    this.calls.push({method, params});
    if (method === 'Browser.getVersion') return {protocolVersion: '1.3', product: 'Chrome/153.0.8010.12', revision: 'fixture', userAgent: 'synthetic fixture', jsVersion: 'fixture'};
    if (method === 'Tracing.start') {if (this.options.rejectStart) throw Error('already tracing'); this.mode = params.transferMode; return {};}
    if (method === 'Tracing.end') {
      if (this.mode === 'ReportEvents') {this.emit('Tracing.dataCollected', {value: [{cat: 'toplevel', name: 'RunTask', ph: 'X', pid: 7, tid: 9, ts: 100, dur: 2}]}); this.emit('Tracing.tracingComplete', {dataLossOccurred: false});}
      else this.emit('Tracing.tracingComplete', {dataLossOccurred: this.options.loss ?? false, stream: 'fixture-stream', traceFormat: 'json', streamCompression: 'none'});
      return {};
    }
    if (method === 'IO.read') {
      const end = Math.min(this.bytes.length, this.offset + params.size), value = this.bytes.subarray(this.offset, end); this.offset = end;
      return {data: value.toString('base64'), base64Encoded: true, eof: this.offset === this.bytes.length};
    }
    if (method === 'IO.close') return {};
    throw Error(`Unexpected method ${method}`);
  }
  async detach() {this.detaches++;}
}

async function setup(t, {text, sessionOptions, raw = true, traceOptions = {}, newSession} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ie-raw-trace-test-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const session = new FakeSession(text, sessionOptions);
  let sessions = 0;
  const page = {context() {return {newCDPSession() {sessions++; return newSession ? newSession(session) : Promise.resolve(session);}};}};
  const trace = createBrowserTrace(page, {artifactDirectory: directory, artifactName: 'browser-trace-1.json',
    ...(raw ? {rawFeedback: {ownership, artifactName: 'browser-feedback-1.raw.json'}} : {}), ...traceOptions});
  return {directory, session, trace, sessionCount: () => sessions};
}

test('one raw CDP trace retains exact bytes and derives the existing sanitized artifact', async t => {
  const {directory, session, trace, sessionCount} = await setup(t);
  assert.equal((await trace.start()).status, 'active');
  const result = await trace.stop();
  assert.equal(sessionCount(), 1);
  assert.equal(session.calls.filter(call => call.method === 'Tracing.start').length, 1);
  assert.equal(session.calls.find(call => call.method === 'Tracing.start').params.transferMode, 'ReturnAsStream');
  assert.equal(session.calls.filter(call => call.method === 'Tracing.end').length, 1);
  assert.equal(session.calls.filter(call => call.method === 'IO.close').length, 1);
  assert.equal(session.detaches, 1);
  assert.equal(await readFile(join(directory, 'browser-feedback-1.raw.json'), 'utf8'), rawText());
  const sanitized = JSON.parse(await readFile(result.artifact.path, 'utf8'));
  assert.equal(sanitized.kind, 'sanitized-chromium-trace-1');
  assert.equal(sanitized.collection.status, 'complete');
  assert.equal(sanitized.collection.derivedFromVerifiedRaw, true);
  assert.equal(sanitized.events.find(event => event.name === 'RunTask').ts, 100.25);
  assert.equal(sanitized.events.find(event => event.name === 'thread_name').thread, 'CrRendererMain');
  assert.equal(sanitized.events.find(event => event.name === 'EventLatency').latency.event_latency_id, '9007199254740993');
  assert.equal(JSON.stringify(sanitized).includes('do-not-copy'), false);
  assert.equal(result.rawFeedback.rawAndSanitizedShareOneTrace, true);
  assert.equal(result.rawFeedback.manifest.collection.status, 'complete');
  assert.equal(result.rawFeedback.analysis.diagnostics.joins[0].diagnosticJoin, 'exact-trace-identities');
  assert.equal(result.rawFeedback.qualification, false);
  assert.equal(result.rawFeedback.analysis.status, 'INCONCLUSIVE');
  assert.equal(result.analysis.qualification, false);
});

test('raw fixed categories include legacy work lanes without starting ReportEvents', async t => {
  const {session, trace} = await setup(t); await trace.start(); await trace.stop();
  const config = session.calls.find(call => call.method === 'Tracing.start').params.traceConfig;
  for (const category of ['toplevel', 'devtools.timeline', 'gpu', 'cc', 'viz', 'blink.user_timing', 'graphics.pipeline']) assert.ok(config.includedCategories.includes(category));
  assert.equal(config.enableArgumentFilter, false);
  assert.equal(config.enableSampling, false);
  assert.equal(config.enableSystrace, false);
  assert.deepEqual(config.excludedCategories, ['*']);
});

test('omitting the explicit raw option preserves the legacy ReportEvents route', async t => {
  const {directory, session, trace} = await setup(t, {raw: false});
  await trace.start(); const result = await trace.stop();
  assert.equal(session.calls.find(call => call.method === 'Tracing.start').params.transferMode, 'ReportEvents');
  assert.equal(session.calls.some(call => call.method === 'IO.read'), false);
  assert.equal(result.rawFeedback, undefined);
  assert.deepEqual(await readdir(directory), ['browser-trace-1.json']);
  assert.equal(result.collection.status, 'complete');
});

test('a corrupt raw trailer keeps transport bytes but discards every sanitized prefix event', async t => {
  const text = rawText() + '!';
  const {directory, trace} = await setup(t, {text}); await trace.start(); const result = await trace.stop();
  assert.equal(await readFile(join(directory, 'browser-feedback-1.raw.json'), 'utf8'), text);
  assert.equal(result.rawFeedback.manifest.collection.status, 'complete');
  assert.equal(result.collection.status, 'incomplete');
  assert.ok(result.collection.reasons.includes('raw-feedback-replay-invalid'));
  assert.equal(result.rawFeedback.fullRawJsonValidated, false);
  assert.equal(JSON.parse(await readFile(result.artifact.path, 'utf8')).events.length, 0);
});

test('capture loss stays incomplete with no decoded prefix or second capture', async t => {
  const {session, trace} = await setup(t, {sessionOptions: {loss: true}}); await trace.start(); const result = await trace.stop();
  assert.equal(result.collection.status, 'incomplete');
  assert.equal(result.collection.eventsRetained, 0);
  assert.equal(result.rawFeedback.manifest.collection.status, 'incomplete');
  assert.equal(session.calls.some(call => call.method === 'IO.read'), false);
  assert.equal(session.calls.filter(call => call.method === 'Tracing.start').length, 1);
});

test('legacy event and byte limits do not discard the retained full raw artifact', async t => {
  for (const traceOptions of [{maxEvents: 1}, {maxBytes: 4096}]) {
    const {directory, trace} = await setup(t, {traceOptions}); await trace.start(); const result = await trace.stop();
    assert.equal(result.collection.status, 'incomplete');
    assert.equal(await readFile(join(directory, 'browser-feedback-1.raw.json'), 'utf8'), rawText());
    assert.equal(result.rawFeedback.manifest.collection.status, 'complete');
    assert.equal(result.rawFeedback.analysis.rawArtifact.fullJsonValidated, true);
    assert.equal(result.rawFeedback.qualification, false);
  }
});

test('an unrepresentable work timestamp is unavailable instead of rounded into a task interval', async t => {
  const text = rawText().replace('"ts":100.25', '"ts":9007199254740993.001');
  const {trace} = await setup(t, {text}); await trace.start(); const result = await trace.stop();
  assert.equal(result.collection.status, 'incomplete');
  assert.ok(result.collection.reasons.includes('malformed-work-event'));
  assert.equal(result.rawFeedback.manifest.collection.status, 'complete');
});

test('repeat stop shares the one drain and one result, including failure receipts', async t => {
  for (const sessionOptions of [{}, {rejectStart: true}]) {
    const {session, trace} = await setup(t, {sessionOptions}); await trace.start();
    const first = trace.stop(), second = trace.stop(); assert.equal(first, second);
    const result = await first; assert.equal(await trace.stop(), result);
    assert.equal(session.calls.filter(call => call.method === 'Tracing.start').length, 1);
    assert.ok(session.calls.filter(call => call.method === 'Tracing.end').length <= 1);
    assert.equal(session.detaches, 1);
    if (sessionOptions.rejectStart) {assert.equal(session.calls.some(call => call.method === 'Tracing.end'), false); assert.equal(result.collection.status, 'unavailable');}
  }
});

test('stop without start records unavailable instrumentation and does not launch a CDP session', async t => {
  const {trace, sessionCount} = await setup(t);
  const result = await trace.stop();
  assert.equal(sessionCount(), 0);
  assert.equal(result.collection.status, 'unavailable');
  assert.equal(result.rawFeedback.manifest, null);
  assert.equal(result.collection.eventsRetained, 0);
  await assert.rejects(trace.start(), /only once/);
});

test('a CDP session arriving after timeout and stop is detached without starting a trace', async t => {
  let resolveSession;
  const {session, trace} = await setup(t, {traceOptions: {completionTimeoutMs: 1}, newSession: () => new Promise(resolve => {resolveSession = resolve;})});
  assert.equal((await trace.start()).status, 'unavailable');
  await trace.stop(); resolveSession(session);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(session.detaches, 1);
  assert.equal(session.calls.length, 0);
});

test('missing ownership never starts tracing and remains explicit missing evidence', async t => {
  const {session, trace} = await setup(t, {traceOptions: {rawFeedback: {artifactName: 'raw.json'}}});
  assert.equal((await trace.start()).status, 'unavailable');
  const result = await trace.stop();
  assert.equal(session.calls.some(call => call.method === 'Tracing.start'), false);
  assert.equal(session.detaches, 1);
  assert.equal(result.collection.status, 'unavailable');
});

test('raw and sanitized artifacts cannot alias or accept arbitrary extra collector controls', async t => {
  await assert.rejects(setup(t, {traceOptions: {rawFeedback: {ownership, artifactName: 'browser-trace-1.json'}}}), /artifact name/);
  await assert.rejects(setup(t, {traceOptions: {rawFeedback: {ownership, categories: ['*']}}}), /Unsupported/);
});

test('shared retained-file reader requires the independently bound exact path and rejects symlinks', async t => {
  const {directory, trace} = await setup(t); await trace.start(); const result = await trace.stop();
  const manifest = result.rawFeedback.manifest, path = manifest.artifact.path;
  assert.throws(() => rawDisplayFeedbackChunks({manifest, expectedPath: join(directory, 'other.json')}), /independently bound/);
  const retained = [];
  for await (const chunk of rawDisplayFeedbackChunks({manifest, expectedPath: path})) retained.push(chunk);
  assert.equal(Buffer.concat(retained).toString('utf8'), rawText());
  const linkedPath = join(directory, 'linked.json'); await symlink(path, linkedPath);
  const linked = structuredClone(manifest); linked.artifact.path = linkedPath;
  await assert.rejects(async () => {for await (const unused of rawDisplayFeedbackChunks({manifest: linked, expectedPath: linkedPath})) void unused;});
});

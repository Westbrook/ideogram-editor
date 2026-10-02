import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDisplayFeedbackCollector, DISPLAY_FEEDBACK_TRACE_CATEGORIES, DISPLAY_FEEDBACK_TRACE_LIMITS} from '../../tooling/qualification/campaigns/display-feedback-collector.mjs';

// Staged source-only on 2026-09-30: these cases have NOT been executed. Their
// synthetic protocol/sink fixtures qualify no browser binary or physical display.

const ownership = Object.freeze({kind: 'owned-isolated-synthetic-browser-1', admittedBy: 'root', owned: true,
  isolated: true, syntheticOnly: true, sessionOwned: true, browserInstanceId: 'synthetic-browser-1'});
const version = {protocolVersion: '1.3', product: 'Chrome/153.0.8010.12', revision: '@synthetic-revision',
  userAgent: 'synthetic-test-agent', jsVersion: 'synthetic-js-version'};
const raw = Buffer.from('{"traceEvents":[{"name":"EventLatency","args":{"event_latency_id":9007199254740993,"display_trace_id":18446744073709551615}}]}\n');

class Session extends EventEmitter {
  constructor(options = {}) {super(); this.options = options; this.commands = []; this.index = 0; this.detachCalls = 0;}
  async send(name, params) {
    this.commands.push({name, params});
    if (this.options.never === name) return new Promise(() => {});
    if (this.options.reject === name) throw Error('PRIVATE untrusted protocol error');
    if (name === 'Browser.getVersion') return this.options.version ?? version;
    if (name === 'Tracing.start') {
      if (this.options.startEvent) this.emit(this.options.startEvent.name, this.options.startEvent.payload);
      return {};
    }
    if (name === 'Tracing.end') {
      if (this.options.unexpectedData) this.emit('Tracing.dataCollected', {value: [{private: 'do not retain'}]});
      if (!this.options.noCompletion) {
        const complete = this.options.completion ?? {dataLossOccurred: false, stream: 'synthetic-stream', traceFormat: 'json', streamCompression: 'none'};
        this.emit('Tracing.tracingComplete', complete);
        if (this.options.duplicate) this.emit('Tracing.tracingComplete', complete);
      }
      return {};
    }
    if (name === 'IO.read') {
      const chunk = (this.options.chunks ?? [{data: raw.toString('base64'), base64Encoded: true, eof: true}])[this.index++];
      if (chunk instanceof Error) throw chunk;
      return chunk;
    }
    return {};
  }
  async detach() {
    this.detachCalls++;
    if (this.options.completionDuringDetach) this.emit('Tracing.tracingComplete', {dataLossOccurred: false, stream: 'late-stream'});
    if (this.options.detachNever) return new Promise(() => {});
    if (this.options.detachReject) throw Error('PRIVATE detach error');
  }
}

async function fixture(t, sessionOptions = {}, collectorOptions = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ie-raw-display-trace-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const artifactPath = join(directory, 'raw.json'), session = new Session(sessionOptions);
  const collector = createDisplayFeedbackCollector({session, artifactPath, ownership, commandTimeoutMs: 25, completionTimeoutMs: 25, ...collectorOptions});
  return {directory, artifactPath, session, collector};
}
async function capture(t, sessionOptions = {}, collectorOptions = {}) {
  const value = await fixture(t, sessionOptions, collectorOptions);
  await value.collector.start();
  return {...value, result: await value.collector.stop()};
}
const calls = (session, name) => session.commands.filter(command => command.name === name);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function incomplete(result, reason) {
  assert.equal(result.collection.status, 'incomplete');
  assert.ok(result.collection.reasons.includes(reason), JSON.stringify(result.collection));
  assert.equal(result.provenanceRequired, true); assert.equal(result.qualification, false);
}

test('raw decimal identities and whitespace survive without parsing or reserialization', async t => {
  const {collector, session, result, artifactPath} = await capture(t);
  assert.equal(result.collection.status, 'complete'); assert.deepEqual(result.collection.reasons, []);
  assert.equal(result.collection.completeEventReceived, true); assert.equal(result.collection.dataLossOccurred, false);
  assert.equal(result.collection.eof, true); assert.equal(result.artifact.hashScope, 'completed-file');
  assert.equal(result.artifact.hashVerifiedAgainstSize, true);
  assert.equal(result.artifact.contentValidation, 'not-performed');
  assert.equal(result.provenanceRequired, true); assert.equal(result.qualification, false);
  assert.deepEqual(await readFile(artifactPath), raw);
  assert.equal(result.artifact.sha256, digest(raw)); assert.equal(result.artifact.bytes, raw.length);
  assert.equal(result.artifact.persistedSize, raw.length);
  assert.equal(await collector.stop(), result); assert.equal(session.detachCalls, 1);
  assert.equal(calls(session, 'Tracing.end').length, 1); assert.equal(calls(session, 'IO.close').length, 1);
  assert.equal(session.listenerCount('Tracing.tracingComplete'), 0);
  const sidecar = JSON.parse(await readFile(result.manifest.path, 'utf8'));
  assert.equal(sidecar.collection.status, 'incomplete');
  assert.ok(sidecar.collection.reasons.includes('manifest-save-unacknowledged'));
  assert.equal(sidecar.manifest.saved, false);
  assert.equal(sidecar.manifest.sidecar, 'provisional-requires-returned-save-acknowledgement');
  assert.equal(result.manifest.returnedReceiptAuthority, 'requires-owning-producer-receipt');
  assert.equal(result.manifest.saved, true);
  assert.equal(sidecar.qualification, false); assert.equal(sidecar.provenanceRequired, true);
  assert.equal(sidecar.artifact.sha256, result.artifact.sha256);
  assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.manifest.path)).mode & 0o777, 0o600);
  assert.throws(() => collector.start(), /only once/);
});

test('fixed stock trace configuration excludes unrelated categories and preserves arguments', async t => {
  const {session, result} = await capture(t);
  const {params} = calls(session, 'Tracing.start')[0];
  assert.equal(params.transferMode, 'ReturnAsStream'); assert.equal(params.streamFormat, 'json');
  assert.equal(params.streamCompression, 'none'); assert.equal(params.traceConfig.recordMode, 'recordUntilFull');
  assert.equal(params.traceConfig.enableArgumentFilter, false);
  assert.equal(params.traceConfig.enableSampling, false); assert.equal(params.traceConfig.enableSystrace, false);
  assert.deepEqual(params.traceConfig.includedCategories, [...DISPLAY_FEEDBACK_TRACE_CATEGORIES]);
  assert.deepEqual(params.traceConfig.excludedCategories, ['*']);
  assert.ok(!params.traceConfig.includedCategories.some(value => /netlog|network|screenshot|memory|cpu_profiler/.test(value)));
  assert.deepEqual(result.protocol.traceConfig, params.traceConfig);
  assert.equal(DISPLAY_FEEDBACK_TRACE_LIMITS.maxBytes, 128 * 1024 * 1024);
  assert.equal(DISPLAY_FEEDBACK_TRACE_LIMITS.maxReadBytes, 64 * 1024);
  assert.equal(DISPLAY_FEEDBACK_TRACE_LIMITS.captureTimeoutMs, 75_000);
  assert.ok(calls(session, 'IO.read').every(call => call.params.size <= 64 * 1024));
});

test('observed browser version is bounded metadata and never establishes provenance', async t => {
  const {result} = await capture(t);
  assert.deepEqual(result.browserVersion, {status: 'observed', source: 'supplied-session-Browser.getVersion', ...version});
  assert.equal(result.ownership.validation, 'caller-declaration-only');
  assert.equal(result.qualification, false); assert.equal(result.provenanceRequired, true);
  for (const options of [{reject: 'Browser.getVersion'}, {version: {...version, product: 'x'.repeat(257)}}, {version: {...version, userAgent: 'bad\nvalue'}}]) {
    const {result: missing} = await capture(t, options);
    assert.equal(missing.collection.status, 'complete');
    assert.equal(missing.browserVersion.status, 'unavailable');
    assert.equal(missing.provenanceRequired, true);
  }
});

test('UTF-8 and base64 chunks concatenate to the exact raw received bytes', async t => {
  const left = '{"traceEvents":[{"name":"synthetic 🦊",', right = '"id":9007199254740993}]}';
  const bytes = Buffer.from(left + right);
  const {result, artifactPath} = await capture(t, {chunks: [
    {data: left, eof: false}, {data: Buffer.from(right).toString('base64'), base64Encoded: true, eof: true},
  ]});
  assert.deepEqual(await readFile(artifactPath), bytes); assert.equal(result.artifact.sha256, digest(bytes));
  assert.equal(result.collection.readCalls, 2);
});

test('a byte-exact but invalid JSON payload is transport-only, never content validation', async t => {
  const {result, artifactPath} = await capture(t, {chunks: [{data: '{broken', eof: true}]});
  assert.equal(result.collection.status, 'complete'); assert.equal(await readFile(artifactPath, 'utf8'), '{broken');
  assert.equal(result.artifact.contentValidation, 'not-performed'); assert.equal(result.qualification, false);
});

test('missing completion, loss, absent loss flag and missing stream cannot complete', async t => {
  for (const [options, reason] of [
    [{noCompletion: true}, 'trace-completion-timeout'],
    [{completion: {dataLossOccurred: true, stream: 's'}}, 'browser-data-loss-or-unknown'],
    [{completion: {stream: 's'}}, 'browser-data-loss-or-unknown'],
    [{completion: {dataLossOccurred: false}}, 'missing-stream'],
  ]) {
    const {result, artifactPath, session} = await capture(t, options);
    incomplete(result, reason);
    assert.equal(result.manifest.saved, true); assert.equal(result.artifact.hashScope, 'persisted-prefix');
    assert.equal((await readFile(artifactPath)).length, result.artifact.bytes);
    assert.equal(session.detachCalls, 1); assert.equal(calls(session, 'Tracing.end').length, 1);
    assert.equal(calls(session, 'IO.read').length, 0);
  }
});

test('unexpected stream format/compression is closed without pretending it is raw JSON', async t => {
  for (const amend of [{traceFormat: 'proto'}, {streamCompression: 'gzip'}, {traceFormat: {private: 'SECRET'}}, {streamCompression: 'SECRET'}]) {
    const {result, session} = await capture(t, {completion: {dataLossOccurred: false, stream: 's', ...amend}});
    incomplete(result, amend.traceFormat ? 'unexpected-stream-format' : 'unexpected-stream-compression');
    assert.equal(calls(session, 'IO.read').length, 0); assert.equal(calls(session, 'IO.close').length, 1);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('overlapping protocol rejection gets no retry and never ends the pre-existing trace', async t => {
  const {collector, session, artifactPath} = await fixture(t, {reject: 'Tracing.start'});
  assert.equal((await collector.start()).status, 'incomplete');
  const result = await collector.stop(); incomplete(result, 'trace-start-rejected');
  assert.equal(calls(session, 'Tracing.start').length, 1); assert.equal(calls(session, 'Tracing.end').length, 0);
  assert.equal(session.detachCalls, 1); assert.equal((await readFile(artifactPath)).length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|untrusted protocol error/);
});

test('start, end and read command timeouts stay incomplete and detach the owned session', async t => {
  for (const [command, reason] of [['Tracing.start', 'trace-start-timeout'], ['Tracing.end', 'trace-end-timeout'], ['IO.read', 'stream-read-timeout']]) {
    const {session, result} = await capture(t, {never: command}, {commandTimeoutMs: 5, completionTimeoutMs: 5});
    incomplete(result, reason); assert.equal(session.detachCalls, 1);
    assert.ok(calls(session, 'Tracing.end').length <= 1); assert.equal(result.manifest.saved, true);
    if (command === 'Tracing.start') assert.equal(result.cleanup.browserCleanupRequired, true);
  }
});

test('late completion during owned detach closes its stream without erasing the timeout', async t => {
  const {result, session} = await capture(t, {noCompletion: true, completionDuringDetach: true}, {completionTimeoutMs: 5});
  incomplete(result, 'trace-completion-timeout');
  assert.equal(result.collection.completeEventReceived, true); assert.equal(result.collection.eof, false);
  assert.equal(calls(session, 'IO.read').length, 0); assert.equal(calls(session, 'IO.close').length, 1);
  assert.equal(calls(session, 'IO.close')[0].params.handle, 'late-stream');
  assert.equal(result.cleanup.streamClosed, true); assert.equal(session.detachCalls, 1);
});

test('completion without an acknowledged start cannot cause closure of another trace stream', async t => {
  const {result, session} = await capture(t, {reject: 'Tracing.start', completionDuringDetach: true});
  incomplete(result, 'trace-start-rejected');
  assert.equal(calls(session, 'Tracing.end').length, 0); assert.equal(calls(session, 'IO.close').length, 0);
});

test('a read error keeps the exact already written prefix and its digest', async t => {
  const prefix = '{"traceEvents":[';
  const {result, artifactPath, session} = await capture(t, {chunks: [{data: prefix, eof: false}, Error('PRIVATE read error')]});
  incomplete(result, 'stream-read-or-write-failed');
  assert.equal(await readFile(artifactPath, 'utf8'), prefix); assert.equal(result.artifact.sha256, digest(prefix));
  assert.equal(result.artifact.hashScope, 'persisted-prefix'); assert.equal(result.collection.eof, false);
  assert.equal(calls(session, 'IO.close').length, 1);
});

test('exact byte budget may reach EOF; overflow keeps only the bounded prefix', async t => {
  for (const extra of [false, true]) {
    const chunks = extra ? [{data: '{}', eof: false}, {data: ' ', eof: true}] : [{data: '{}', eof: true}];
    const {result, artifactPath} = await capture(t, {chunks}, {maxBytes: 2});
    assert.equal(await readFile(artifactPath, 'utf8'), '{}'); assert.equal(result.artifact.bytes, 2);
    if (extra) incomplete(result, 'byte-limit'); else assert.equal(result.collection.status, 'complete');
  }
});

test('oversized chunk, malformed envelope/base64 and unpaired surrogates refuse decoding', async t => {
  for (const [response, reason] of [
    [{data: '12345', eof: true}, 'read-chunk-limit'],
    [{data: 'eA=', base64Encoded: true, eof: true}, 'malformed-base64'],
    [{data: 'Zh==', base64Encoded: true, eof: true}, 'malformed-base64'],
    [{data: '\ud800', eof: true}, 'malformed-utf8-envelope'],
    [{data: '{}', eof: 'yes'}, 'malformed-read-response'],
    [{data: '{}', base64Encoded: 'yes', eof: true}, 'malformed-read-response'],
    [{data: '', eof: false}, 'empty-read-without-eof'],
    [{data: '', eof: true}, 'empty-stream'],
  ]) {
    const {result, artifactPath} = await capture(t, {chunks: [response]}, {maxReadBytes: 4});
    incomplete(result, reason); assert.equal((await readFile(artifactPath)).length, 0);
  }
});

test('read-call bound prevents an endless stream of small nonempty chunks', async t => {
  const {result, artifactPath, session} = await capture(t, {chunks: [{data: '{', eof: false}, {data: '}', eof: false}]}, {maxReadCalls: 1});
  incomplete(result, 'read-call-limit'); assert.equal(calls(session, 'IO.read').length, 1);
  assert.equal(await readFile(artifactPath, 'utf8'), '{');
});

test('capture watchdog ends once and marks the shortened capture incomplete', async t => {
  const {collector, session} = await fixture(t, {}, {captureTimeoutMs: 5});
  await collector.start(); await new Promise(resolve => setTimeout(resolve, 20));
  const result = await collector.stop(); incomplete(result, 'capture-time-limit');
  assert.equal(calls(session, 'Tracing.end').length, 1); assert.equal(session.detachCalls, 1);
});

test('buffer peak and unexpected event delivery stay explicit in the manifest', async t => {
  for (const [options, reason] of [
    [{startEvent: {name: 'Tracing.bufferUsage', payload: {percentFull: 0.95}}}, 'browser-buffer-limit'],
    [{startEvent: {name: 'Tracing.bufferUsage', payload: {percentFull: 2}}}, 'malformed-buffer-usage'],
    [{unexpectedData: true}, 'unexpected-data-events'],
    [{duplicate: true}, 'duplicate-completion'],
  ]) {
    const {result} = await capture(t, options); incomplete(result, reason);
    if (reason === 'browser-buffer-limit') assert.equal(result.collection.bufferUsagePeak, 0.95);
  }
});

test('stream-close and detach failures cannot retain a complete status', async t => {
  for (const [options, reason] of [
    [{reject: 'IO.close'}, 'stream-close-rejected'],
    [{detachReject: true}, 'session-detach-failed'],
    [{detachNever: true}, 'session-detach-timeout'],
  ]) {
    const {result, session} = await capture(t, options, {commandTimeoutMs: 5});
    incomplete(result, reason); assert.equal(result.collection.eof, true);
    assert.equal(session.detachCalls, 1); assert.equal(calls(session, 'IO.close').length, 1);
  }
});

function memorySink({partial = false, failWrite = false, wrongSize = false, failSave = false} = {}) {
  const chunks = []; let closed = 0, saved;
  return {
    chunks, get closed() {return closed;}, get saved() {return saved;},
    async write(bytes) {
      if (failWrite && chunks.length) throw Error('PRIVATE write error');
      const count = partial || failWrite ? Math.min(3, bytes.length) : bytes.length;
      chunks.push(Buffer.from(bytes.subarray(0, count))); return count;
    },
    async flush() {return {size: Buffer.concat(chunks).length + (wrongSize ? 1 : 0)};},
    async close() {closed++;},
    async saveManifest(manifest) {if (failSave) throw Error('PRIVATE manifest error'); saved = structuredClone(manifest);},
  };
}

test('short sink writes hash only acknowledged bytes and write errors preserve a prefix', async t => {
  for (const failWrite of [false, true]) {
    const sink = memorySink({partial: true, failWrite});
    const {result} = await capture(t, {}, {sinkFactory: async () => sink});
    const retained = Buffer.concat(sink.chunks);
    assert.equal(result.artifact.sha256, digest(retained)); assert.equal(result.artifact.bytes, retained.length);
    assert.equal(sink.closed, 1); assert.ok(sink.saved);
    if (failWrite) {incomplete(result, 'stream-read-or-write-failed'); assert.equal(retained.length, 3);}
    else {assert.equal(result.collection.status, 'complete'); assert.deepEqual(retained, raw);}
  }
});

test('sink size mismatch and manifest-save error are explicit failures', async t => {
  for (const [configuration, reason] of [[{wrongSize: true}, 'persisted-size-mismatch'], [{failSave: true}, 'manifest-save-failed']]) {
    const sink = memorySink(configuration);
    const {result} = await capture(t, {}, {sinkFactory: async () => sink});
    incomplete(result, reason);
    if (configuration.wrongSize) assert.equal(result.artifact.hashVerifiedAgainstSize, false);
    if (configuration.failSave) assert.equal(result.manifest.saved, false);
  }
});

test('existing raw file and symlink targets are never replaced or traced', async t => {
  for (const link of [false, true]) {
    const {collector, artifactPath, directory, session} = await fixture(t);
    if (link) {const target = join(directory, 'original'); await writeFile(target, 'keep'); await symlink(target, artifactPath);}
    else await writeFile(artifactPath, 'keep');
    assert.equal((await collector.start()).status, 'incomplete');
    const result = await collector.stop(); incomplete(result, 'artifact-open-failed');
    assert.equal(await readFile(artifactPath, 'utf8'), 'keep'); assert.equal(calls(session, 'Tracing.start').length, 0);
  }
});

test('existing manifest is not replaced and cannot be reported saved', async t => {
  const {collector, artifactPath} = await fixture(t);
  await writeFile(`${artifactPath}.manifest.json`, 'keep');
  await collector.start(); const result = await collector.stop();
  incomplete(result, 'manifest-save-failed'); assert.equal(result.manifest.saved, false);
  assert.equal(await readFile(`${artifactPath}.manifest.json`, 'utf8'), 'keep');
});

test('ownership, path and excessive limits fail before any protocol activity', () => {
  const session = new Session();
  const valid = {session, artifactPath: '/private/tmp/raw.json', ownership};
  for (const options of [
    {ownership: undefined}, {ownership: {...ownership, syntheticOnly: false}},
    {ownership: {...ownership, isolated: false}}, {ownership: {...ownership, sessionOwned: false}},
    {ownership: {...ownership, admittedBy: 'caller'}}, {ownership: {...ownership, browserInstanceId: 'https://private.invalid'}},
    {artifactPath: 'relative.json'}, {artifactPath: '/private/tmp/../raw.json'},
    {maxBytes: 128 * 1024 * 1024 + 1}, {maxReadBytes: 65537}, {maxReadCalls: 0}, {captureTimeoutMs: 75001},
  ]) assert.throws(() => createDisplayFeedbackCollector({...valid, ...options}));
  assert.equal(session.commands.length, 0);
});

test('stop before start is terminal and never sends a tracing command', async t => {
  const {collector, session, artifactPath} = await fixture(t);
  const result = await collector.stop(); incomplete(result, 'trace-not-started');
  assert.equal(session.commands.length, 0); assert.equal(session.detachCalls, 1);
  assert.equal(result.artifact.exists, false); assert.equal(result.manifest.saved, false);
  await assert.rejects(readFile(artifactPath), {code: 'ENOENT'});
  assert.throws(() => collector.start(), /only once/);
});

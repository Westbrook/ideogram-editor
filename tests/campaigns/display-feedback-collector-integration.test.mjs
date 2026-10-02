import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {setImmediate as immediate, setTimeout as delay} from 'node:timers/promises';
import {createDisplayFeedbackCollector, DISPLAY_FEEDBACK_TRACE_CATEGORIES} from '../../tooling/qualification/campaigns/display-feedback-collector.mjs';

// Source-only successor regression cases. Authored, NOT imported or executed.
// All sessions/sinks below are synthetic; no browser, network or filesystem I/O.
const ownership = {kind: 'owned-isolated-synthetic-browser-1', admittedBy: 'root', owned: true,
  isolated: true, syntheticOnly: true, sessionOwned: true, browserInstanceId: 'isolated-fixture'};
const version = {protocolVersion: '1.3', product: 'Chrome/synthetic', revision: 'synthetic', userAgent: 'synthetic', jsVersion: 'synthetic'};
const digest = value => createHash('sha256').update(value).digest('hex');
const never = () => new Promise(() => {});
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}

class Session extends EventEmitter {
  constructor(options = {}) {super(); this.options = options; this.calls = []; this.detaches = 0; this.readIndex = 0;}
  async send(name, params) {
    this.calls.push({name, params});
    if (name === 'Browser.getVersion') {
      this.options.duringVersion?.(this);
      return this.options.versionPromise ?? version;
    }
    if (name === 'Tracing.start') {this.options.duringStart?.(this); return {};}
    if (name === 'Tracing.end') {
      for (const event of this.options.completions ?? [{dataLossOccurred: false, stream: 'own-stream'}]) this.emit('Tracing.tracingComplete', event);
      return {};
    }
    if (name === 'IO.read') return (this.options.chunks ?? [{data: '{}', eof: true}])[this.readIndex++];
    return {};
  }
  async detach() {this.detaches++;}
}
function memorySink(overrides = {}) {
  const retained = [], calls = []; let saved;
  const value = {
    calls, retained, get saved() {return saved;},
    async write(bytes) {calls.push('write'); retained.push(Buffer.from(bytes)); return bytes.length;},
    async flush() {calls.push('flush'); return {size: Buffer.concat(retained).length};},
    async close() {calls.push('close');},
    async saveManifest(manifest) {calls.push('saveManifest'); saved = structuredClone(manifest);},
  };
  for (const [name, implementation] of Object.entries(overrides)) {
    value[name] = async (...args) => {calls.push(name); return implementation(...args);};
  }
  return value;
}
function fixture({sessionOptions = {}, sink = memorySink(), sinkFactory = async () => sink, ...options} = {}) {
  const session = new Session(sessionOptions);
  const collector = createDisplayFeedbackCollector({session, artifactPath: '/private/tmp/synthetic-display-trace.json', ownership,
    sinkFactory, commandTimeoutMs: 50, completionTimeoutMs: 50, sinkTimeoutMs: 5, artifactCleanupTimeoutMs: 5, ...options});
  return {session, sink, collector};
}
const count = (session, name) => session.calls.filter(call => call.name === name).length;
function incomplete(result, reason) {
  assert.equal(result.collection.status, 'incomplete'); assert.ok(result.collection.reasons.includes(reason), JSON.stringify(result.collection));
  assert.equal(result.qualification, false); assert.equal(result.provenanceRequired, true);
}
async function capture(options) {
  const context = fixture(options); const start = await context.collector.start();
  return {...context, start, result: await context.collector.stop()};
}

test('foreign completion during Browser.getVersion aborts without starting, ending or closing its stream', async () => {
  const {start, result, session, sink} = await capture({sessionOptions: {duringVersion: session => {
    session.emit('Tracing.tracingComplete', {dataLossOccurred: false, stream: 'foreign-stream'});
  }}});
  assert.equal(start.status, 'incomplete'); incomplete(result, 'pre-start-trace-interference');
  assert.equal(result.collection.startOutcome, 'aborted-before-start');
  assert.equal(result.collection.completeEventReceived, false); assert.equal(result.collection.completionOwnership, 'none');
  assert.equal(result.collection.foreignTraceObserved, true); assert.equal(result.cleanup.browserCleanupRequired, true);
  for (const name of ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close']) assert.equal(count(session, name), 0);
  assert.equal(session.detaches, 1); assert.deepEqual(sink.retained, []);
});

test('foreign data and buffer events during version lookup also prevent a new trace', async () => {
  for (const name of ['Tracing.dataCollected', 'Tracing.bufferUsage']) {
    const {result, session} = await capture({sessionOptions: {duringVersion: session => session.emit(name, {value: []})}});
    incomplete(result, 'pre-start-trace-interference'); assert.equal(result.collection.foreignTraceObserved, true);
    assert.equal(count(session, 'Tracing.start'), 0); assert.equal(count(session, 'Tracing.end'), 0);
  }
});

test('stop while the version request is pending cancels start at the actual dispatch boundary', async () => {
  const versionStarted = deferred(), versionResult = deferred();
  const {collector, session} = fixture({sessionOptions: {versionPromise: versionResult.promise, duringVersion: () => versionStarted.resolve()}});
  const starting = collector.start(); await versionStarted.promise;
  const stopping = collector.stop(); versionResult.resolve(version);
  assert.equal((await starting).status, 'incomplete');
  const result = await stopping; incomplete(result, 'trace-start-cancelled');
  assert.equal(result.collection.startOutcome, 'aborted-before-start'); assert.equal(count(session, 'Tracing.start'), 0);
});

test('completion during a pending start remains unresolved after the start acknowledgement', async () => {
  const {result, start, session} = await capture({sessionOptions: {duringStart: session => {
    session.emit('Tracing.tracingComplete', {dataLossOccurred: false, stream: 'own-stream'});
  }}});
  assert.equal(start.status, 'incomplete'); incomplete(result, 'unexpected-completion');
  assert.ok(result.collection.reasons.includes('completion-during-start-unresolved'));
  assert.equal(result.collection.completionOwnership, 'unresolved');
  assert.equal(result.collection.foreignTraceObserved, true);
  assert.equal(result.collection.startOutcome, 'acknowledged'); assert.equal(result.cleanup.browserCleanupRequired, true);
  assert.equal(count(session, 'Tracing.start'), 1); assert.equal(count(session, 'Tracing.end'), 0);
  assert.equal(count(session, 'IO.read'), 0); assert.equal(count(session, 'IO.close'), 0);
});

test('duplicate completions with distinct, absent or malformed streams require browser cleanup', async () => {
  for (const duplicate of [{stream: 'another-stream'}, {}, {stream: {secret: 'untrusted'}}]) {
    const {result, session} = await capture({sessionOptions: {completions: [
      {dataLossOccurred: false, stream: 'own-stream'}, {dataLossOccurred: false, ...duplicate},
    ]}});
    incomplete(result, 'duplicate-completion'); assert.ok(result.collection.reasons.includes('additional-stream-unresolved'));
    assert.equal(result.cleanup.unresolvedAdditionalStream, true); assert.equal(result.cleanup.browserCleanupRequired, true);
    assert.deepEqual(session.calls.filter(call => call.name === 'IO.close').map(call => call.params.handle), ['own-stream']);
    assert.doesNotMatch(JSON.stringify(result), /another-stream|untrusted/);
  }
});

test('an unsolicited completion after start acknowledgement cannot discharge active-trace cleanup', async () => {
  const {collector, session} = fixture(); assert.equal((await collector.start()).status, 'active');
  session.emit('Tracing.tracingComplete', {dataLossOccurred: false, stream: 'unrequested-stream'});
  const result = await collector.stop(); incomplete(result, 'unrequested-completion-unresolved');
  assert.equal(result.collection.completionOwnership, 'unresolved');
  assert.equal(result.cleanup.browserCleanupRequired, true);
  assert.equal(count(session, 'IO.read'), 0); assert.equal(count(session, 'IO.close'), 0);
});

test('duplicate completion for the same known stream closes only that stream once', async () => {
  const complete = {dataLossOccurred: false, stream: 'own-stream'};
  const {result, session} = await capture({sessionOptions: {completions: [complete, complete]}});
  incomplete(result, 'duplicate-completion'); assert.equal(result.cleanup.unresolvedAdditionalStream, false);
  assert.equal(result.cleanup.browserCleanupRequired, false); assert.equal(count(session, 'IO.close'), 1);
});

test('a never-resolving sink factory has a terminal incomplete receipt', {timeout: 1000}, async () => {
  const {result, session, start} = await capture({sinkFactory: never});
  assert.equal(start.status, 'incomplete'); incomplete(result, 'artifact-factory-timeout');
  assert.equal(count(session, 'Tracing.start'), 0); assert.equal(session.detaches, 1);
  assert.equal(result.cleanup.artifactCleanupRequired, true); assert.equal(result.artifact.fileMayChangeAfterReturn, true);
  assert.equal(result.artifact.hashVerifiedAgainstSize, false); assert.equal(result.artifact.persistedSize, null);
  assert.deepEqual(result.cleanup.lateOperations, [{operation: 'factory', lateOutcome: 'pending', cancellable: false,
    disposition: 'bounded-close-if-factory-resolves', cleanup: 'awaiting-owned-handle'}]);
});

test('a factory handle arriving after return receives one owned close without mutating the receipt', {timeout: 1000}, async () => {
  const factory = deferred(), closed = deferred(); let closes = 0;
  const {collector} = fixture({sinkFactory: () => factory.promise});
  await collector.start(); const result = await collector.stop(), snapshot = structuredClone(result);
  factory.resolve({async close() {closes++; closed.resolve();}});
  await closed.promise; await immediate();
  assert.equal(closes, 1); assert.deepEqual(result, snapshot); assert.equal(result.cleanup.artifactCleanupRequired, true);
  assert.equal(result.manifest.saved, false);
});

test('late factory cleanup is bounded when close never resolves and handles rejection', {timeout: 1000}, async () => {
  for (const rejects of [false, true]) {
    const factory = deferred(), closeStarted = deferred(); let closes = 0;
    const {result} = await capture({sinkFactory: () => factory.promise});
    factory.resolve({close() {closes++; closeStarted.resolve(); return rejects ? Promise.reject(Error('private close error')) : never();}});
    await closeStarted.promise; await delay(15);
    assert.equal(closes, 1); assert.equal(result.cleanup.artifactCleanupRequired, true);
    assert.equal(result.cleanup.lateOperations[0].lateOutcome, 'pending');
  }
});

test('late factory rejection is observed and cannot upgrade the returned failure', {timeout: 1000}, async () => {
  const factory = deferred();
  const {result} = await capture({sinkFactory: () => factory.promise});
  const snapshot = structuredClone(result); factory.reject(Error('private factory error'));
  await immediate(); assert.deepEqual(result, snapshot); incomplete(result, 'artifact-factory-timeout');
});

test('timed-out writes preserve only acknowledged prefix bytes and skip concurrent flush', {timeout: 1000}, async () => {
  const secondWrite = deferred(); let writes = 0; const retained = [];
  const sink = memorySink({async write(bytes) {
    if (++writes === 2) await secondWrite.promise;
    retained.push(Buffer.from(bytes)); return bytes.length;
  }});
  const {result, session} = await capture({sink, sessionOptions: {chunks: [{data: '{', eof: false}, {data: '}', eof: true}]}});
  incomplete(result, 'artifact-write-timeout');
  assert.equal(result.artifact.bytes, 1); assert.equal(result.artifact.sha256, digest('{'));
  assert.equal(result.artifact.hashScope, 'acknowledged-prefix'); assert.equal(result.artifact.persistedSize, null);
  assert.equal(result.artifact.hashVerifiedAgainstSize, false); assert.equal(result.artifact.fileMayChangeAfterReturn, true);
  assert.equal(result.cleanup.artifactCleanupRequired, true); assert.equal(sink.calls.includes('flush'), false);
  assert.equal(sink.calls.filter(name => name === 'close').length, 1); assert.equal(count(session, 'IO.close'), 1);
  const snapshot = structuredClone(result); secondWrite.resolve(); await immediate();
  assert.equal(Buffer.concat(retained).toString(), '{}'); assert.deepEqual(result, snapshot);
  assert.equal(result.artifact.bytes, 1); // The late write is never retroactively hashed.
});

test('a flush deadline prevents a false persisted-size or completed-file claim', {timeout: 1000}, async () => {
  const sink = memorySink({flush: never});
  const {result} = await capture({sink}); incomplete(result, 'artifact-flush-timeout');
  assert.equal(result.artifact.bytes, 2); assert.equal(result.artifact.sha256, digest('{}'));
  assert.equal(result.artifact.hashScope, 'acknowledged-prefix'); assert.equal(result.artifact.persistedSize, null);
  assert.equal(result.cleanup.artifactCleanupRequired, true); assert.equal(result.artifact.hashVerifiedAgainstSize, false);
  assert.equal(sink.calls.filter(name => name === 'flush').length, 1); assert.equal(sink.calls.filter(name => name === 'close').length, 1);
});

test('owned close has an independent deadline and is never retried', {timeout: 1000}, async () => {
  const sink = memorySink({close: never});
  const {result} = await capture({sink, sinkTimeoutMs: 50, artifactCleanupTimeoutMs: 5});
  incomplete(result, 'artifact-close-timeout'); assert.equal(result.artifact.rawClosed, false);
  assert.equal(result.cleanup.artifactCleanupRequired, true); assert.equal(result.artifact.hashVerifiedAgainstSize, false);
  assert.equal(sink.calls.filter(name => name === 'close').length, 1);
  assert.equal(result.cleanup.lateOperations[0].operation, 'close');
});

test('late manifest save can persist only a provisional nonqualifying receipt', {timeout: 1000}, async () => {
  const save = deferred(); let payload, persisted;
  const sink = memorySink({async saveManifest(manifest) {payload = structuredClone(manifest); await save.promise; persisted = structuredClone(manifest);}});
  const {result} = await capture({sink}); incomplete(result, 'artifact-saveManifest-timeout');
  assert.equal(result.manifest.saved, false); assert.equal(result.cleanup.artifactCleanupRequired, true);
  assert.equal(result.artifact.hashScope, 'persisted-prefix'); assert.equal(result.artifact.fileMayChangeAfterReturn, false);
  assert.equal(payload.collection.status, 'incomplete'); assert.equal(payload.manifest.saved, false);
  assert.ok(payload.collection.reasons.includes('manifest-save-unacknowledged'));
  const snapshot = structuredClone(result); save.resolve(); await immediate();
  assert.deepEqual(persisted, payload); assert.deepEqual(result, snapshot);
  assert.equal(persisted.collection.status, 'incomplete');
});

test('successful capture returns an acknowledged receipt while its standalone sidecar stays provisional', async () => {
  const {result, sink} = await capture();
  assert.equal(result.collection.status, 'complete'); assert.equal(result.manifest.saved, true);
  assert.equal(result.manifest.returnedReceiptAuthority, 'requires-owning-producer-receipt');
  assert.equal(result.artifact.hashScope, 'completed-file'); assert.equal(result.artifact.hashVerifiedAgainstSize, true);
  assert.equal(result.cleanup.artifactCleanupRequired, false); assert.deepEqual(result.cleanup.lateOperations, []);
  assert.equal(sink.saved.manifest.saved, false); assert.equal(sink.saved.collection.status, 'incomplete');
  assert.ok(sink.saved.collection.reasons.includes('manifest-save-unacknowledged'));
  assert.equal(result.qualification, false); assert.equal(result.provenanceRequired, true);
});

test('successor preserves the one-trace category union and validates new finite deadlines', () => {
  for (const category of ['toplevel', 'devtools.timeline', 'gpu', 'graphics.pipeline', 'blink.user_timing']) assert.ok(DISPLAY_FEEDBACK_TRACE_CATEGORIES.includes(category));
  for (const options of [{sinkTimeoutMs: 0}, {sinkTimeoutMs: 10001}, {artifactCleanupTimeoutMs: Infinity}, {artifactCleanupTimeoutMs: 10001}]) {
    assert.throws(() => fixture(options), /Invalid/);
  }
});

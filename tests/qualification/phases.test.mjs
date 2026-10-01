import {allocationsURL,ownedPreviewURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';

// Exercise the shared implementation directly, without depending on stale dist
// output. Deterministic local clocks test accounting; they are not performance
// measurements or evidence that a browser actually presented a frame.
const data = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const phasesURL = data((await transformWithOxc(await readFile('src/observability/phases.ts', 'utf8'), 'phases.ts')).code);
const { PhaseRecorder } = await import(phasesURL);
const commandCode = (await transformWithOxc(await readFile('server/observability/command-phases.ts', 'utf8'), 'command-phases.ts')).code
  .replaceAll('../../src/observability/phases.js', phasesURL);
const { CommandAcceptancePhases, LocalQueuePhases } = await import(data(commandCode));
const workerCode = (await transformWithOxc(await readFile('src/observability/browser-worker-observations.ts', 'utf8'), 'browser-worker-observations.ts')).code
  .replaceAll('./phases.js', phasesURL);
const workerURL = data(workerCode);
const browserCode = (await transformWithOxc(await readFile('src/observability/browser.ts', 'utf8'), 'browser.ts')).code
  .replaceAll('./phases.js', phasesURL).replaceAll('./browser-worker-observations.js', workerURL).replaceAll('./allocations.js', allocationsURL);
const { BrowserPhases } = await import(data(browserCode));

function fixture(options = {}) {
  let monotonic = 100, wall = 1_800_000_000_100;
  const recorder = new PhaseRecorder({ lane: 'browser', now: () => monotonic, wallNow: () => wall, ...options });
  return { recorder, now(value) { monotonic = value; }, wall(value) { wall = value; } };
}

test('snapshot schema records local durations and one explicitly uncertain wall-clock join', () => {
  const f = fixture();
  assert.deepEqual(f.recorder.snapshot(), { schemaVersion: 1, lane: 'browser', clockOriginUnixMs: 1_800_000_000_000, clockUncertaintyMs: null, records: [], dropped: 0, invalid: 0 });
  const span = f.recorder.start('command.validate', { commandId: 'command_existing', documentId: 'document_existing', revision: '9007199254740993' });
  assert.deepEqual(f.recorder.snapshot().records, [], 'An unfinished action cannot manufacture a completion');
  f.now(137.5); f.wall(-999_999_999);
  const row = span.end();
  assert.deepEqual(row, { sequence: 1, phase: 'command.validate', startedMs: 100, endedMs: 137.5, durationMs: 37.5, outcome: 'ok', context: { commandId: 'command_existing', documentId: 'document_existing', revision: '9007199254740993' } });
  assert.equal(f.recorder.snapshot().clockOriginUnixMs, 1_800_000_000_000, 'Wall-clock adjustments do not alter monotonic durations or silently rebase earlier records');
});

test('concurrent spans use finish order without inventing correlation identities', () => {
  const f = fixture(), first = f.recorder.start('result.prepare');
  f.now(105); const second = f.recorder.start('event.append', { commandId: 'existing-command' });
  f.now(109); second.end(); f.now(122); first.end();
  assert.deepEqual(f.recorder.snapshot().records, [
    { sequence: 1, phase: 'event.append', startedMs: 105, endedMs: 109, durationMs: 4, outcome: 'ok', context: { commandId: 'existing-command' } },
    { sequence: 2, phase: 'result.prepare', startedMs: 100, endedMs: 122, durationMs: 22, outcome: 'ok', context: {} },
  ]);
});

test('client and server clocks remain separate even when the same command correlates them', () => {
  let authorityTime = 50_000;
  const browser = fixture(), authority = fixture({ lane: 'storage-worker', now: () => authorityTime, wallNow: () => 9_000_000 });
  const intent = browser.recorder.start('ui.intent', { commandId: 'shared-existing-command' });
  const commit = authority.recorder.start('event.append', { commandId: 'shared-existing-command' });
  browser.now(108); authorityTime = 50_019;
  intent.end(); commit.end();
  assert.equal(browser.recorder.snapshot().records[0].durationMs, 8);
  assert.equal(authority.recorder.snapshot().records[0].durationMs, 19);
  assert.notEqual(browser.recorder.snapshot().clockOriginUnixMs, authority.recorder.snapshot().clockOriginUnixMs);
});

test('end is idempotent and returned records and snapshots do not mutate retained observations', () => {
  const f = fixture(), input = { commandId: 'before', bytes: 10 }, additions = { assetId: 'result-before' };
  const span = f.recorder.start('asset.stage', input); input.commandId = 'after';
  f.now(120); const ended = span.end('ok', additions); additions.assetId = 'result-after';
  ended.context.commandId = 'mutated-return'; ended.durationMs = -10;
  const snapshot = f.recorder.snapshot(); snapshot.records[0].context.assetId = 'mutated-snapshot'; snapshot.records.length = 0;
  f.now(200); assert.equal(span.end('error', { bytes: 99 }), undefined);
  assert.deepEqual(f.recorder.snapshot().records, [{ sequence: 1, phase: 'asset.stage', startedMs: 100, endedMs: 120, durationMs: 20, outcome: 'ok', context: { commandId: 'before', bytes: 10, assetId: 'result-before' } }]);
});

test('unknown, inherited, nested and accessor metadata cannot retain prompts, credentials or URLs', () => {
  let getterCalls = 0;
  const metadata = Object.assign(Object.create({ documentId: 'inherited-document' }), {
    commandId: 'known_command-1', prompt: 'private prompt text', caption: 'private caption', url: 'https://remote.invalid/result?token=secret', headers: { authorization: 'Bearer secret' },
    providerRequestId: 'https://remote.invalid/request', assetId: '../private/file', attemptId: 'token?secret', transactionId: 'two words', requestId: '\nsecret',
  });
  Object.defineProperty(metadata, 'jobId', { enumerable: true, get() { getterCalls++; throw Error('Telemetry must not evaluate this getter'); } });
  Object.defineProperty(metadata, 'password', { enumerable: false, get() { getterCalls++; throw Error('Unknown getters must remain unread'); } });
  metadata[Symbol('secret')] = 'private symbol data';
  const f = fixture(); f.recorder.instant('job.observe', metadata);
  assert.equal(getterCalls, 0);
  assert.deepEqual(f.recorder.snapshot().records[0].context, { commandId: 'known_command-1' });
  const encoded = JSON.stringify(f.recorder.snapshot());
  for (const secret of ['private', 'remote.invalid', 'Bearer', 'token', 'secret', 'inherited']) assert(!encoded.includes(secret));
});

test('context accepts exact safe correlation values, counts and declared readiness without truncation', () => {
  const context = {
    commandId: 'c', documentId: 'd', transactionId: 't', correlationId: 'correlation-existing', jobId: 'j', attemptId: 'a', providerRequestId: 'provider-existing',
    assetId: 'r', candidateId: 'candidate', previewId: 'preview', datasetVersion: 'dataset_2', adapterVersion: 'adapter_3', requestId: 'request', revision: '9999999999999999999999999999999999999999',
    assetHash: 'sha256:' + 'a'.repeat(64), evidenceHash: 'sha256:' + 'b'.repeat(64), bytes: Number.MAX_SAFE_INTEGER,
    width: 0, height: 8192, sourceWidth: 5000, sourceHeight: 5000, requestWidth: 512, requestHeight: 512, count: 0, replay: true, readiness: 'C', boundary: 'prepared-durable',
  };
  const f = fixture(); f.recorder.instant('result.prepare', context);
  assert.deepEqual(f.recorder.snapshot().records[0].context, context);
});

test('invalid context scalars are omitted rather than coerced, truncated or serialized', () => {
  const f = fixture();
  for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123', null, {}, [], true]) f.recorder.instant('raster.prepare', { width: bad, bytes: bad });
  for (const revision of ['-1', '01', '1.0', '1e3', '1'.repeat(41), 1]) f.recorder.instant('command.validate', { revision });
  for (const assetHash of ['a'.repeat(64), 'sha256:' + 'A'.repeat(64), 'sha256:' + 'a'.repeat(63), 'https://remote.invalid/secret']) f.recorder.instant('result.verify', { assetHash });
  for (const commandId of ['', 'a'.repeat(129), { toString() { throw Error('No coercion'); } }]) f.recorder.instant('command.validate', { commandId });
  f.recorder.instant('ui.feedback', { boundary: 'secret prompt', readiness: 'prepared', replay: 'true' });
  assert(f.recorder.snapshot().records.every(row => Object.keys(row.context).length === 0));
});

test('phase and lane validation prevent arbitrary strings entering the trace vocabulary', () => {
  const f = fixture();
  for (const phase of ['private prompt text', 'https://remote.invalid/token', 'command.validate\n', '', '__proto__']) assert.throws(() => f.recorder.start(phase), /PHASE_NAME/);
  assert.deepEqual(f.recorder.snapshot().records, []);
  for (const lane of ['private prompt text', 'https://remote.invalid/token', '', 'Browser', 'a'.repeat(49)]) assert.throws(() => fixture({ lane }), /PHASE_LANE/);
});

test('only supported outcomes are retained and an invalid outcome becomes visibly incomplete', () => {
  const f = fixture();
  for (const outcome of ['ok', 'rejected', 'error', 'cancelled', 'incomplete', 'uncertain']) f.recorder.start('command.accept').end(outcome);
  f.recorder.start('command.accept').end('private error response with signed URL');
  const snapshot = f.recorder.snapshot();
  assert.deepEqual(snapshot.records.map(row => row.outcome), ['ok', 'rejected', 'error', 'cancelled', 'incomplete', 'uncertain', 'incomplete']);
  assert.equal(snapshot.invalid, 1); assert(!JSON.stringify(snapshot).includes('private error'));
});

test('valid input timestamps are measured locally and invalid or epoch timestamps fall back visibly', () => {
  const f = fixture();
  f.recorder.start('ui.feedback', { boundary: 'intent' }, 75).end();
  for (const timestamp of [-1, NaN, Infinity, 101, 1_800_000_000_100]) f.recorder.start('ui.feedback', {}, timestamp).end();
  const snapshot = f.recorder.snapshot();
  assert.equal(snapshot.records[0].durationMs, 25);
  assert(snapshot.records.slice(1).every(row => row.startedMs === 100 && row.endedMs === 100 && row.durationMs === 0));
  assert.equal(snapshot.invalid, 5);
});

test('backward or nonfinite monotonic clock samples cannot create negative or infinite durations', () => {
  const f = fixture(), span = f.recorder.start('result.fetch');
  f.now(90); const ended = span.end(); assert.equal(ended.durationMs, 0); assert.equal(ended.endedMs, 100);
  for (const value of [NaN, Infinity, -1]) { f.now(value); const next = f.recorder.start('result.store'); next.end(); }
  f.now(150); f.recorder.start('result.verify', {}, 140).end();
  const snapshot = f.recorder.snapshot();
  assert.equal(snapshot.invalid, 7);
  assert(snapshot.records.every(row => Number.isFinite(row.durationMs) && row.durationMs >= 0));
  assert.equal(snapshot.records.at(-1).durationMs, 10);
});

test('a bad initial monotonic clock remains explicit instead of poisoning all later records', () => {
  let now = NaN;
  const recorder = new PhaseRecorder({ lane: 'browser', now: () => now, wallNow: () => 500 });
  now = 10; recorder.start('document.replay', { replay: true }).end();
  const snapshot = recorder.snapshot(); assert.equal(snapshot.invalid, 1); assert.equal(snapshot.clockOriginUnixMs, 500);
  assert.deepEqual(snapshot.records[0].context, { replay: true }); assert.equal(snapshot.records[0].durationMs, 0);
});

test('bounded ring retains newest complete records with exact drop accounting', () => {
  const f = fixture({ capacity: 2 });
  for (let i = 0; i < 5; i++) { f.now(100 + i); f.recorder.instant('job.observe', { count: i }); }
  const snapshot = f.recorder.snapshot();
  assert.equal(snapshot.dropped, 3); assert.deepEqual(snapshot.records.map(row => [row.sequence, row.context.count]), [[4, 3], [5, 4]]);
  assert.equal(f.recorder.snapshot().dropped, 3, 'A read is not a drain');
});

test('drain resets interval loss counters while global record sequence continues', () => {
  const f = fixture({ capacity: 1 });
  f.recorder.instant('job.observe'); f.recorder.start('job.observe', {}, -1).end('invalid');
  const drained = f.recorder.drain();
  assert.equal(drained.dropped, 1); assert.equal(drained.invalid, 2); assert.equal(drained.records[0].sequence, 2);
  assert.deepEqual(f.recorder.snapshot().records, []); assert.equal(f.recorder.snapshot().dropped, 0); assert.equal(f.recorder.snapshot().invalid, 0);
  f.recorder.instant('reconnect'); assert.equal(f.recorder.snapshot().records[0].sequence, 3);
  assert.equal(drained.records[0].sequence, 2, 'Later records cannot mutate a previously drained packet');
});

test('capacity cannot be unbounded, fractional, negative or implicitly coerced', () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 16385, '2']) assert.throws(() => fixture({ capacity }), /PHASE_CAPACITY/);
  assert.equal(fixture({ capacity: 1 }).recorder.snapshot().records.length, 0);
  assert.equal(fixture({ capacity: 16384 }).recorder.snapshot().records.length, 0);
});

test('instant uses one clock sample and cannot manufacture a nonzero phase duration', () => {
  let now = 0;
  const recorder = new PhaseRecorder({ lane: 'browser', now: () => ++now, wallNow: () => 1_000 });
  const record = recorder.instant('result.candidate_available', { boundary: 'encoded-durable' });
  assert.equal(now, 2); assert.equal(record.startedMs, 2); assert.equal(record.endedMs, 2); assert.equal(record.durationMs, 0);
});

test('end-known fields refine a phase without relabeling its captured command or document identity', () => {
  const f = fixture(), initial = { commandId: 'original-command', documentId: 'original-document', attemptId: 'original-attempt', assetId: 'original-asset', revision: '7', assetHash: 'sha256:' + 'a'.repeat(64), boundary: 'intent', bytes: 10 };
  const span = f.recorder.start('result.adopt', initial);
  const record = span.end('ok', { commandId: 'other-command', documentId: 'other-document', attemptId: 'other-attempt', assetId: 'other-asset', revision: '8', assetHash: 'sha256:' + 'b'.repeat(64), resultingRevision: '8', outputAssetId: 'actual-output', boundary: 'local-durable', bytes: 20 });
  assert.deepEqual(record.context, { ...initial, resultingRevision: '8', outputAssetId: 'actual-output', boundary: 'local-durable', bytes: 20 });
});

test('nonfinite wall-clock origins are refused instead of emitting a misleading JSON clock join', () => {
  for (const wall of [NaN, Infinity, -Infinity]) assert.throws(() => fixture({ wallNow: () => wall }), /PHASE_CLOCK_ORIGIN/);
});

const command = (id = 'command-existing') => ({ commandId: id, documentId: 'document-existing', expectedDocumentRevision: '7', transactionId: 'transaction-existing', correlationId: 'correlation-existing', body: { prompt: 'Private command contents', url: 'https://remote.invalid/?token=secret' } });
const accepted = (id = 'command-existing') => ({ status: 'accepted', commandId: id, fromSeq: '11', toSeq: '13', documentRevision: '8', transactionId: 'transaction-existing' });
const commandRows = f => f.recorder.snapshot().records.filter(row => row.phase === 'command.accept');
const validationRows = f => f.recorder.snapshot().records.filter(row => row.phase === 'command.validate');

test('authority acceptance remains pending until the matching durable receipt is observed', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), handle = authority.begin(command(), 'sha256:' + 'a'.repeat(64));
  for (const result of [null, undefined, true, 'accepted', {}, { status: 'pending' }, { status: 'pending', receipt: accepted() }, accepted('wrong-command')]) authority.complete(handle, result);
  assert.equal(authority.pending, 1); assert.deepEqual(f.recorder.snapshot().records, []);
  f.now(155); authority.complete(handle, accepted());
  const row = commandRows(f)[0];
  assert.equal(authority.pending, 0); assert.equal(row.phase, 'command.accept'); assert.equal(row.durationMs, 55); assert.equal(row.outcome, 'ok');
  assert.deepEqual(row.context, { commandId: 'command-existing', documentId: 'document-existing', revision: '7', transactionId: 'transaction-existing', correlationId: 'correlation-existing', boundary: 'authority-durable', resultingRevision: '8' });
});

test('durable notification requires both original command identity and immutable request hash', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), hash = 'sha256:' + 'a'.repeat(64), otherHash = 'sha256:' + 'b'.repeat(64);
  authority.begin(command(), hash); authority.begin(command(), otherHash);
  authority.durable('other-command', hash, accepted()); authority.durable('command-existing', 'wrong-hash', accepted());
  assert.equal(authority.pending, 2); assert.deepEqual(f.recorder.snapshot().records, []);
  authority.durable('command-existing', hash, accepted());
  assert.equal(authority.pending, 1); assert.equal(commandRows(f).length, 1);
  authority.durable('command-existing', hash, accepted()); assert.equal(commandRows(f).length, 1, 'Repeated durable observation is idempotent');
  authority.close(); assert.deepEqual(commandRows(f).map(row => row.outcome), ['ok', 'incomplete']);
});

test('rejected durable commands are distinguishable from errors and preserve observed revision only', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), handle = authority.begin(command());
  authority.complete(handle, { status: 'rejected', commandId: 'command-existing', currentRevision: '19', code: 'REVISION_CONFLICT', details: { rawProviderResponse: 'Private provider prompt echo', url: 'https://remote.invalid/secret' } });
  const row = commandRows(f)[0];
  assert.equal(row.outcome, 'rejected'); assert.equal(row.context.boundary, 'authority-durable'); assert.equal(row.context.resultingRevision, '19');
  assert(!JSON.stringify(f.recorder.snapshot()).includes('Private')); assert(!JSON.stringify(f.recorder.snapshot()).includes('remote.invalid'));
});

test('server tracking captures metadata without retaining or evaluating the command body', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), input = command();
  Object.defineProperty(input, 'body', { get() { throw Error('Command body must not be inspected by phase tracking'); } });
  const handle = authority.begin(input, 'sha256:' + 'a'.repeat(64)); input.commandId = 'changed-later'; input.documentId = 'changed-later';
  authority.complete(handle, accepted());
  assert.equal(commandRows(f)[0].context.commandId, 'command-existing');
  assert.equal(commandRows(f)[0].context.documentId, 'document-existing');
  assert(!JSON.stringify(handle).includes('body'));
});

test('unknown malformed command identity cannot acquire a successful receipt by matching undefined', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), handle = authority.begin(undefined);
  authority.complete(handle, { status: 'accepted' }); authority.complete(handle, accepted());
  assert.equal(authority.pending, 1); assert.deepEqual(f.recorder.snapshot().records, []);
  authority.fail(handle);
  assert.equal(authority.pending, 0); assert.equal(commandRows(f)[0].outcome, 'error'); assert.deepEqual(commandRows(f)[0].context, {});
});

test('server active capacity censors the oldest unfinished acceptance without claiming durability', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder, 2), oldest = authority.begin(command('oldest'));
  authority.begin(command('middle')); authority.begin(command('latest'));
  assert.equal(authority.pending, 2);
  const first = commandRows(f)[0]; assert.equal(first.context.commandId, 'oldest'); assert.equal(first.outcome, 'incomplete'); assert.equal(first.context.boundary, undefined);
  authority.complete(oldest, accepted('oldest')); assert.equal(commandRows(f).length, 1);
  authority.close(); assert.equal(authority.pending, 0); assert.deepEqual(commandRows(f).map(row => row.context.commandId), ['oldest', 'middle', 'latest']);
  assert.deepEqual(validationRows(f).map(row => row.outcome), ['incomplete', 'incomplete', 'incomplete']);
});

test('server errors, successful completion and shutdown each finish a handle at most once', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), a = authority.begin(command('a')), b = authority.begin(command('b')), c = authority.begin(command('c'));
  authority.fail(a); authority.fail(a); authority.complete(a, accepted('a'));
  authority.complete(b, accepted('b')); authority.fail(b); authority.complete(b, accepted('b'));
  authority.close(); authority.close(); authority.fail(c); authority.fail(undefined); authority.complete(undefined, accepted());
  assert.equal(authority.pending, 0); assert.deepEqual(commandRows(f).map(row => row.outcome), ['error', 'ok', 'incomplete']);
  assert.deepEqual(validationRows(f).map(row => row.outcome), ['error', 'ok', 'incomplete']);
});

test('server unfinished-acceptance capacity cannot be disabled or expanded without bounds', () => {
  const f = fixture({ lane: 'server-writer' });
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 1025, '2', null]) assert.throws(() => new CommandAcceptancePhases(f.recorder, capacity), /PHASE_PENDING_CAPACITY/);
});

test('completed domain validation stays distinct from the later durable acceptance boundary', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), hash = 'sha256:' + 'a'.repeat(64);
  authority.begin(command(), hash); f.now(125); authority.validated('command-existing', hash, accepted());
  assert.equal(authority.pending, 1); assert.deepEqual(commandRows(f), []);
  assert.equal(validationRows(f).length, 1); assert.equal(validationRows(f)[0].durationMs, 25); assert.equal(validationRows(f)[0].context.boundary, 'observed'); assert.equal(validationRows(f)[0].context.replay, undefined);
  f.now(145); authority.durable('command-existing', hash, accepted());
  assert.equal(authority.pending, 0); assert.equal(commandRows(f)[0].durationMs, 45); assert.equal(commandRows(f)[0].context.boundary, 'authority-durable'); assert.equal(validationRows(f).length, 1);
});

test('validation observations require matching command, payload hash and a valid receipt disposition', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), hash = 'sha256:' + 'a'.repeat(64);
  authority.begin(command(), hash);
  authority.validated('other-command', hash, accepted()); authority.validated('command-existing', 'other-hash', accepted());
  authority.validated('command-existing', hash, accepted('other-command')); authority.validated('command-existing', hash, { status: 'pending', commandId: 'command-existing' });
  assert.deepEqual(validationRows(f), []); assert.equal(authority.pending, 1);
  const rejected = { status: 'rejected', commandId: 'command-existing', currentRevision: '19', code: 'REVISION_CONFLICT' };
  authority.validated('command-existing', hash, rejected); authority.validated('command-existing', hash, rejected);
  assert.equal(validationRows(f).length, 1); assert.equal(validationRows(f)[0].outcome, 'rejected'); assert.deepEqual(commandRows(f), []);
  authority.durable('command-existing', hash, rejected); assert.equal(commandRows(f)[0].outcome, 'rejected');
});

test('cached durable receipt validation is explicitly tagged replay rather than fresh validation work', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), handle = authority.begin(command());
  authority.complete(handle, accepted());
  const row = validationRows(f)[0]; assert.equal(row.context.replay, true); assert.equal(row.context.boundary, 'authority-durable');
  assert.equal(commandRows(f)[0].context.replay, undefined); assert.equal(commandRows(f)[0].outcome, 'ok');
});

test('successful validation followed by commit failure does not become successful acceptance', () => {
  const f = fixture({ lane: 'server-writer' }), authority = new CommandAcceptancePhases(f.recorder), hash = 'sha256:' + 'a'.repeat(64), handle = authority.begin(command(), hash);
  f.now(120); authority.validated('command-existing', hash, accepted()); f.now(130); authority.fail(handle); authority.close();
  assert.equal(validationRows(f).length, 1); assert.equal(validationRows(f)[0].outcome, 'ok'); assert.equal(validationRows(f)[0].durationMs, 20);
  assert.equal(commandRows(f).length, 1); assert.equal(commandRows(f)[0].outcome, 'error'); assert.equal(commandRows(f)[0].durationMs, 30); assert.equal(commandRows(f)[0].context.boundary, undefined);
});

test('local queue spans retain the accepted command until dispatch eligibility commits', () => {
  const f = fixture({ lane: 'server-writer' }), queue = new LocalQueuePhases(f.recorder);
  queue.begin('job-existing', { commandId: 'command-existing', documentId: 'document-existing' });
  assert.equal(queue.pending, 1); assert.deepEqual(f.recorder.snapshot().records, []);
  f.now(145); queue.eligible('job-existing', 'document-existing', 'attempt-existing');
  assert.equal(queue.pending, 0);
  assert.deepEqual(f.recorder.snapshot().records, [{ sequence: 1, phase: 'job.local_queue', startedMs: 100, endedMs: 145, durationMs: 45, outcome: 'ok', context: { commandId: 'command-existing', documentId: 'document-existing', jobId: 'job-existing', attemptId: 'attempt-existing', boundary: 'dispatch' } }]);
  queue.eligible('job-existing', 'document-existing', 'attempt-existing'); assert.equal(f.recorder.snapshot().records.length, 1);
});

test('recovered jobs without a current-process queue start cannot fabricate elapsed residence', () => {
  const f = fixture({ lane: 'server-writer' }), queue = new LocalQueuePhases(f.recorder);
  queue.eligible('replayed-job', 'document-existing', 'attempt-existing'); queue.cancel('replayed-job'); queue.close();
  assert.equal(queue.pending, 0); assert.deepEqual(f.recorder.snapshot().records, []);
});

test('local queue cancellation and replacement are terminal and capacity loss is visibly incomplete', () => {
  const f = fixture({ lane: 'server-writer' }), queue = new LocalQueuePhases(f.recorder, 2);
  queue.begin('cancelled'); queue.cancel('cancelled'); queue.cancel('cancelled'); queue.eligible('cancelled', 'document-existing', 'attempt-existing');
  queue.begin('replaced'); queue.begin('replaced'); queue.begin('next'); queue.begin('last'); queue.close(); queue.close();
  assert.equal(queue.pending, 0);
  assert.deepEqual(f.recorder.snapshot().records.map(row => [row.context.jobId, row.outcome]), [['cancelled', 'cancelled'], ['replaced', 'incomplete'], ['replaced', 'incomplete'], ['next', 'incomplete'], ['last', 'incomplete']]);
  assert.equal(f.recorder.snapshot().records[0].context.boundary, 'authority-durable');
  assert(f.recorder.snapshot().records.slice(1).every(row => row.context.boundary === undefined));
});

test('local queue observes only safe metadata and does not inspect prompt fields or accessors', () => {
  const f = fixture({ lane: 'server-writer' }), queue = new LocalQueuePhases(f.recorder), context = { commandId: 'command-existing', jobId: 'cannot-relabel-job', prompt: 'Private user prompt', url: 'https://remote.invalid/secret' };
  Object.defineProperty(context, 'caption', { enumerable: true, get() { throw Error('Telemetry must not read private accessors'); } });
  queue.begin('actual-job', context); queue.eligible('actual-job', 'document-existing', 'attempt-existing');
  assert.deepEqual(f.recorder.snapshot().records[0].context, { commandId: 'command-existing', jobId: 'actual-job', documentId: 'document-existing', attemptId: 'attempt-existing', boundary: 'dispatch' });
});

test('local queue active capacity is finite and positive', () => {
  const f = fixture({ lane: 'server-writer' });
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 1025, '2', null]) assert.throws(() => new LocalQueuePhases(f.recorder, capacity), /PHASE_PENDING_CAPACITY/);
});

const target = { documentId: 'document-existing', revision: '8', assetId: 'output-existing' };
const adoption = { previewId: 'preview-existing', documentId: 'document-existing', revision: '7', assetId: 'prepared-existing' };
function browserFixture() {
  const f = fixture({ lane: 'browser-main' });
  return { ...f, browser: new BrowserPhases(undefined, f.recorder) };
}
const adoptionRows = f => f.browser.snapshot().trace.records.filter(row => row.phase === 'result.adopt');

for (const order of ['durability-first', 'render-first']) test(`browser adoption ${order} remains censored until external presentation evidence`, () => {
  const f = browserFixture(); f.browser.beginAdoption(adoption, false); f.now(105); f.browser.bindAdoption('preview-existing', { commandId: 'command-existing' });
  f.now(150);
  if (order === 'durability-first') f.browser.adoptionDurable('command-existing', target); else f.browser.viewportDecoded(target, 120);
  assert.equal(adoptionRows(f).length, 0); assert.equal(f.browser.snapshot().adoptions[0].outcome, 'pending');
  f.now(170);
  if (order === 'durability-first') f.browser.viewportDecoded(target, 151); else f.browser.adoptionDurable('command-existing', target);
  const snapshot = f.browser.snapshot(), [row] = adoptionRows(f);
  assert.equal(snapshot.presentationEvidence, 'external-trace-required'); assert.equal(snapshot.adoptions[0].outcome, 'awaiting-presentation');
  assert.equal(row.outcome, 'incomplete'); assert.equal(row.startedMs, 100); assert.equal(row.endedMs, 170); assert.equal(row.durationMs, 70);
  assert.equal(row.context.readiness, 'C'); assert.equal(row.context.boundary, 'render-submitted'); assert.equal(row.context.commandId, 'command-existing');
  assert.equal(row.context.revision, '7'); assert.equal(row.context.resultingRevision, '8'); assert.equal(row.context.outputAssetId, 'output-existing');
  assert(!snapshot.trace.records.some(record => record.context.boundary === 'presented'));
  assert(!snapshot.trace.records.some(record => record.phase === 'component.proposal'), 'Sanitizing metadata is not an application proposal');
  f.browser.adoptionDurable('command-existing', target); f.browser.viewportDecoded(target);
  assert.equal(adoptionRows(f).length, 1, 'Duplicate receipt and draw observations cannot create another adoption completion');
});

for (const key of ['documentId', 'revision', 'assetId']) test(`browser adoption never joins viewport output with a mismatched ${key}`, () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'command-existing' }, true); f.now(120); f.browser.adoptionDurable('command-existing', target);
  f.now(130); f.browser.viewportDecoded({ ...target, [key]: key === 'revision' ? '9' : 'wrong-existing-identity' });
  assert.equal(adoptionRows(f).length, 0); assert.equal(f.browser.snapshot().adoptions[0].renderSubmittedMs, null);
  f.now(140); f.browser.viewportDecoded(target);
  assert.equal(adoptionRows(f).length, 1); assert.equal(adoptionRows(f)[0].endedMs, 140); assert.equal(adoptionRows(f)[0].outcome, 'incomplete');
});

test('prepared and viewport-decoded readiness are separate from an adoption presentation claim', () => {
  const f = browserFixture(); let resident = null; f.browser.setViewportProbe(() => resident);
  f.browser.beginAdoption({ ...adoption, previewId: 'unprepared' }, false);
  f.browser.beginAdoption({ ...adoption, previewId: 'prepared' }, true);
  f.now(110); f.browser.viewportDecoded({ documentId: 'document-existing', revision: '7', assetId: 'prepared-existing' }); resident = 'prepared-existing';
  f.now(120); f.browser.beginAdoption({ ...adoption, previewId: 'decoded' }, true);
  f.browser.beginAdoption({ ...adoption, previewId: 'unprepared-after-decode' }, false);
  assert.deepEqual(f.browser.snapshot().adoptions.map(row => [row.context.previewId, row.context.readiness]), [['unprepared', 'C'], ['prepared', 'B'], ['decoded', 'A'], ['unprepared-after-decode', 'C']]);
  assert.deepEqual(adoptionRows(f), []);
});

for (const mode of ['default-probe', 'different-asset', 'cleared-viewport', 'failed-probe']) test(`stale last-draw metadata cannot claim readiness A with ${mode}`, () => {
  const f = browserFixture();
  f.browser.viewportDecoded({ documentId: 'document-existing', revision: '7', assetId: 'prepared-existing' });
  if (mode === 'different-asset') f.browser.setViewportProbe(() => 'preview-replacement');
  if (mode === 'cleared-viewport') f.browser.setViewportProbe(() => null);
  if (mode === 'failed-probe') f.browser.setViewportProbe(() => { throw Error('Viewport observation unavailable'); });
  f.now(120); f.browser.beginAdoption(adoption, true);
  assert.equal(f.browser.snapshot().adoptions[0].context.readiness, 'B');
  assert.deepEqual(adoptionRows(f), []);
});

test('a late command binding retains original adoption identity and cannot relabel an existing command', () => {
  const f = browserFixture(); f.browser.beginAdoption(adoption, false);
  f.browser.bindAdoption('preview-existing', { commandId: 'command-existing', documentId: 'other-document', revision: '999', assetId: 'other-asset', previewId: 'other-preview' });
  f.browser.bindAdoption('preview-existing', { commandId: 'changed-command' });
  const context = f.browser.snapshot().adoptions[0].context;
  assert.deepEqual(context, { ...adoption, commandId: 'command-existing', readiness: 'C' });
  f.browser.adoptionDurable('changed-command', target); assert.equal(f.browser.snapshot().adoptions[0].durableMs, null);
  f.browser.adoptionDurable('command-existing', target); assert.equal(f.browser.snapshot().adoptions[0].durableMs, 100);
});

test('invalid preview and target metadata neither retain private content nor complete an adoption', () => {
  const f = browserFixture();
  f.browser.beginAdoption({ previewId: 'https://remote.invalid/secret', prompt: 'Private user prompt' }, true);
  assert.deepEqual(f.browser.snapshot().adoptions, []); assert.deepEqual(f.browser.snapshot().trace.records, []);
  f.browser.beginAdoption({ ...adoption, commandId: 'command-existing', prompt: 'Private user prompt', sourceURL: 'https://remote.invalid/secret' }, true);
  f.browser.adoptionDurable('command-existing', { ...target, assetId: '../secret' }); f.browser.viewportDecoded({ ...target, documentId: 'https://remote.invalid/secret' });
  assert.equal(f.browser.snapshot().adoptions[0].durableMs, null); assert.equal(adoptionRows(f).length, 0);
  assert(!JSON.stringify(f.browser.snapshot()).includes('Private')); assert(!JSON.stringify(f.browser.snapshot()).includes('secret'));
});

for (const outcome of ['error', 'rejected', 'cancelled']) test(`browser adoption ${outcome} remains terminal when stale durability or viewport work arrives`, () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'command-existing' }, false);
  f.now(115); f.browser.adoptionFailed('preview-existing', outcome); f.browser.adoptionFailed('preview-existing', 'error');
  f.now(150); f.browser.adoptionDurable('command-existing', target); f.browser.viewportDecoded(target);
  assert.equal(adoptionRows(f).length, 1); assert.equal(adoptionRows(f)[0].outcome, outcome); assert.equal(adoptionRows(f)[0].durationMs, 15);
  assert.equal(f.browser.snapshot().adoptions[0].outcome, outcome); assert.equal(f.browser.snapshot().adoptions[0].durableMs, null);
});

test('reusing a preview identity cancels the old pending span before tracking the new explicit intent', () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'old-command' }, false);
  f.now(125); f.browser.beginAdoption({ ...adoption, commandId: 'new-command' }, true);
  assert.deepEqual(adoptionRows(f).map(row => [row.outcome, row.context.commandId]), [['cancelled', 'old-command']]);
  assert.equal(f.browser.snapshot().adoptions.length, 1); assert.equal(f.browser.snapshot().adoptions[0].intentMs, 125);
  f.browser.adoptionDurable('old-command', target); assert.equal(f.browser.snapshot().adoptions[0].durableMs, null);
});

test('browser reset ends pending spans and clears prepared viewport readiness for the next owner', () => {
  const f = browserFixture(); let resident = 'prepared-existing'; f.browser.setViewportProbe(() => resident); f.browser.viewportDecoded({ documentId: 'document-existing', revision: '7', assetId: 'prepared-existing' });
  f.browser.beginAdoption({ ...adoption, commandId: 'old-command' }, true); assert.equal(f.browser.snapshot().adoptions[0].context.readiness, 'A');
  f.now(115); f.browser.reset(); f.browser.reset(); resident = null;
  assert.deepEqual(adoptionRows(f).map(row => row.outcome), ['cancelled']);
  f.browser.adoptionDurable('old-command', target); assert.equal(f.browser.snapshot().adoptions[0].durableMs, null);
  f.browser.beginAdoption({ ...adoption, previewId: 'new-preview' }, true);
  assert.equal(f.browser.snapshot().adoptions.at(-1).context.readiness, 'B');
});

test('browser pending-adoption storage is bounded and reports the dropped incomplete intent', () => {
  const f = browserFixture();
  for (let i = 0; i < 65; i++) f.browser.beginAdoption({ ...adoption, previewId: 'preview-' + i, commandId: 'command-' + i }, false);
  const snapshot = f.browser.snapshot(); assert.equal(snapshot.adoptions.length, 64); assert.equal(snapshot.droppedAdoptions, 1); assert.equal(snapshot.adoptions[0].context.previewId, 'preview-1');
  assert.deepEqual(adoptionRows(f).map(row => [row.context.previewId, row.outcome]), [['preview-0', 'incomplete']]);
  f.browser.adoptionDurable('command-0', target); assert.equal(adoptionRows(f).length, 1);
});

test('browser snapshot copies cannot mutate pending adoption identity or target matching', () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'command-existing' }, false); f.browser.adoptionDurable('command-existing', target);
  const snapshot = f.browser.snapshot(); snapshot.adoptions[0].context.commandId = 'other-command'; snapshot.adoptions[0].target.assetId = 'other-asset'; snapshot.trace.records.length = 0;
  f.now(145); f.browser.viewportDecoded(target);
  assert.equal(adoptionRows(f).length, 1); assert.equal(adoptionRows(f)[0].context.commandId, 'command-existing'); assert.equal(adoptionRows(f)[0].context.outputAssetId, 'output-existing');
});

test('browser endpoints use the recorder clock guard rather than retaining nonfinite or backward samples', () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'command-existing' }, false);
  f.now(80); f.browser.adoptionDurable('command-existing', target, 1_800_000_000_000);
  f.now(NaN); f.browser.viewportDecoded(target);
  const snapshot = f.browser.snapshot(), row = snapshot.adoptions[0];
  assert.equal(row.intentMs, 100); assert.equal(row.durableMs, 100); assert.equal(row.renderSubmittedMs, 100); assert(snapshot.trace.invalid > 0);
  assert(snapshot.trace.records.every(record => Number.isFinite(record.durationMs) && record.durationMs >= 0)); assert.equal(adoptionRows(f)[0].outcome, 'incomplete');
});

test('input acknowledgement remains pending until submitted feedback and never claims presented paint', () => {
  const f = browserFixture(); f.browser.beginIntent({ documentId: 'document-existing', commandId: 'command-existing' }, 75);
  assert.deepEqual(f.browser.snapshot().trace.records.map(row => row.phase), ['ui.intent']);
  const intent = f.browser.snapshot().trace.records[0]; assert.equal(intent.startedMs, 75); assert.equal(intent.context.boundary, 'intent');
  f.now(125); f.browser.feedbackSubmitted(); f.browser.feedbackSubmitted();
  const feedback = f.browser.snapshot().trace.records.filter(row => row.phase === 'ui.feedback');
  assert.equal(feedback.length, 1); assert.equal(feedback[0].startedMs, 75); assert.equal(feedback[0].durationMs, 50); assert.equal(feedback[0].outcome, 'incomplete'); assert.equal(feedback[0].context.boundary, 'render-submitted');
  assert(!f.browser.snapshot().trace.records.some(row => row.context.boundary === 'presented'));
});

test('new input censors earlier unsubmitted feedback instead of erasing its elapsed work', () => {
  const f = browserFixture(); f.browser.beginIntent({ commandId: 'first-command' }); f.now(120); f.browser.beginIntent({ commandId: 'second-command' });
  const before = f.browser.snapshot().trace.records.filter(row => row.phase === 'ui.feedback');
  assert.equal(before.length, 1); assert.equal(before[0].context.commandId, 'first-command'); assert.equal(before[0].durationMs, 20); assert.equal(before[0].outcome, 'incomplete'); assert.equal(before[0].context.boundary, undefined);
  f.now(140); f.browser.feedbackSubmitted();
  const rows = f.browser.snapshot().trace.records.filter(row => row.phase === 'ui.feedback'); assert.equal(rows.length, 2); assert.equal(rows[1].context.commandId, 'second-command'); assert.equal(rows[1].durationMs, 20);
});

test('browser owner reset cancels pending feedback and late submission cannot revive it', () => {
  const f = browserFixture(); f.browser.beginIntent({ commandId: 'command-existing' }); f.now(110); f.browser.reset(); f.now(150); f.browser.feedbackSubmitted(); f.browser.reset();
  const rows = f.browser.snapshot().trace.records.filter(row => row.phase === 'ui.feedback');
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'cancelled'); assert.equal(rows[0].durationMs, 10); assert.equal(rows[0].context.boundary, undefined);
});

test('input telemetry drops private fields and uses a guarded local timestamp', () => {
  const f = browserFixture(), context = { documentId: 'document-existing', prompt: 'Private prompt', signedURL: 'https://remote.invalid/secret' };
  Object.defineProperty(context, 'caption', { enumerable: true, get() { throw Error('Private getter'); } });
  f.browser.beginIntent(context, 1_800_000_000_000); f.browser.feedbackSubmitted();
  assert(f.browser.snapshot().trace.invalid > 0); assert(f.browser.snapshot().trace.records.every(row => row.startedMs === 100 && row.durationMs === 0));
  assert(!JSON.stringify(f.browser.snapshot()).includes('Private')); assert(!JSON.stringify(f.browser.snapshot()).includes('remote.invalid'));
});

let workerFixtureNumber = 0;
const workerFixture = () => import(data(workerCode + '\n// isolated collector fixture ' + ++workerFixtureNumber));
const workerPacket = () => ({ schemaVersion: 1, lane: 'text-worker', clockOriginUnixMs: 10_000, clockUncertaintyMs: null, dropped: 0, invalid: 0, records: [
  { sequence: 1, phase: 'text.layout', startedMs: 10, endedMs: 20, durationMs: 10, outcome: 'ok', context: { requestId: 'request-existing', documentId: 'document-existing', revision: '7', readiness: 'B', boundary: 'observed' } },
  { sequence: 2, phase: 'text.edit', startedMs: 15, endedMs: 25, durationMs: 10, outcome: 'incomplete', context: { requestId: 'request-existing', boundary: 'render-submitted' } },
] });

test('worker observations preserve each local clock and never synthesize a main-thread duration', async () => {
  const worker = await workerFixture(), first = workerPacket(), second = workerPacket(); second.clockOriginUnixMs = 90_000;
  second.records = [{ ...second.records[0], startedMs: 200, endedMs: 204, durationMs: 4 }];
  worker.retainWorkerPhases(first); worker.retainWorkerPhases(second);
  assert.deepEqual(worker.workerPhaseSnapshot(), { schemaVersion: 1, traces: [first, second], dropped: 0, invalid: 0, clockJoin: 'external-calibration-required' });
});

test('worker collector strips unknown fields, invalid readiness and private accessors without reading them', async () => {
  const worker = await workerFixture(), packet = workerPacket(); let calls = 0;
  packet.prompt = 'Private packet prompt'; packet.records[0].url = 'https://remote.invalid/secret'; packet.records[0].context.prompt = 'Private row prompt'; packet.records[0].context.providerRequestId = 'https://remote.invalid/secret';
  packet.records[0].context.readiness = 'fabricated-presented'; packet.records[0].context.width = Infinity;
  Object.defineProperty(packet.records[0].context, 'assetHash', { enumerable: true, get() { calls++; throw Error('Private getter'); } });
  Object.defineProperty(packet.records[0], 'privateCaption', { enumerable: true, get() { calls++; throw Error('Private getter'); } });
  worker.retainWorkerPhases(packet);
  const snapshot = worker.workerPhaseSnapshot(); assert.equal(calls, 0); assert.equal(snapshot.invalid, 0); assert.equal(snapshot.traces.length, 1);
  assert.deepEqual(snapshot.traces[0].records[0].context, { requestId: 'request-existing', documentId: 'document-existing', revision: '7', boundary: 'observed' });
  assert(!JSON.stringify(snapshot).includes('Private')); assert(!JSON.stringify(snapshot).includes('remote.invalid')); assert(!JSON.stringify(snapshot).includes('fabricated'));
});

test('worker collector rejects invalid envelopes, ordering, vocabulary and duration arithmetic atomically', async () => {
  const worker = await workerFixture(), mutations = [
    p => { p.schemaVersion = 2; }, p => { p.lane = 'browser-main'; }, p => { p.clockOriginUnixMs = NaN; }, p => { p.clockOriginUnixMs = -1; }, p => { p.clockUncertaintyMs = 0; },
    p => { p.dropped = -1; }, p => { p.invalid = 0.5; }, p => { p.records = {}; }, p => { p.records = Array(129).fill(p.records[0]); },
    p => { p.records[0].sequence = 0; }, p => { p.records[1].sequence = 1; }, p => { p.records[0].phase = 'Private prompt'; }, p => { p.records[0].outcome = 'Private provider echo'; },
    p => { p.records[0].startedMs = -1; }, p => { p.records[0].endedMs = Infinity; }, p => { p.records[0].durationMs = 11; }, p => { p.records[0].startedMs = 21; },
    p => { p.records[1].endedMs = 19; p.records[1].durationMs = 4; }, p => { delete p.records[1]; },
  ];
  for (const mutate of mutations) { const packet = workerPacket(); mutate(packet); worker.retainWorkerPhases(packet); }
  const snapshot = worker.workerPhaseSnapshot(); assert.equal(snapshot.invalid, mutations.length); assert.equal(snapshot.dropped, 0); assert.deepEqual(snapshot.traces, []);
  assert(!JSON.stringify(snapshot).includes('Private'));
});

test('worker collector does not evaluate required-field accessors or retain partially valid packets', async () => {
  const worker = await workerFixture(), packet = workerPacket(); let calls = 0;
  Object.defineProperty(packet.records[1], 'phase', { enumerable: true, get() { calls++; throw Error('Private getter'); } });
  worker.retainWorkerPhases(packet);
  const envelope = workerPacket(); Object.defineProperty(envelope, 'records', { enumerable: true, get() { calls++; throw Error('Private getter'); } }); worker.retainWorkerPhases(envelope);
  assert.equal(calls, 0); assert.equal(worker.workerPhaseSnapshot().invalid, 2); assert.deepEqual(worker.workerPhaseSnapshot().traces, []);
});

test('worker collector bounds snapshots and rows while preserving exact producer and collector loss counts', async () => {
  const worker = await workerFixture();
  for (let i = 0; i < 33; i++) {
    const packet = workerPacket(); packet.clockOriginUnixMs = 10_000 + i; packet.dropped = 3; packet.invalid = 4;
    packet.records = Array.from({ length: 128 }, (_, row) => ({ sequence: row + 1, phase: 'text.layout', startedMs: row, endedMs: row + 0.5, durationMs: 0.5, outcome: 'ok', context: { count: row } }));
    worker.retainWorkerPhases(packet);
  }
  const snapshot = worker.workerPhaseSnapshot(); assert.equal(snapshot.traces.length, 32); assert.equal(snapshot.dropped, 1); assert.equal(snapshot.invalid, 0);
  assert.equal(snapshot.traces[0].clockOriginUnixMs, 10_001); assert.equal(snapshot.traces.at(-1).clockOriginUnixMs, 10_032);
  assert(snapshot.traces.every(trace => trace.records.length === 128 && trace.dropped === 3 && trace.invalid === 4));
});

test('worker packets and returned snapshots cannot mutate retained observations', async () => {
  const worker = await workerFixture(), packet = workerPacket(); worker.retainWorkerPhases(packet);
  packet.records[0].context.documentId = 'mutated-input'; packet.records.length = 0;
  const snapshot = worker.workerPhaseSnapshot(); snapshot.traces[0].records[0].context.documentId = 'mutated-output'; snapshot.traces.length = 0;
  assert.equal(worker.workerPhaseSnapshot().traces[0].records.length, 2); assert.equal(worker.workerPhaseSnapshot().traces[0].records[0].context.documentId, 'document-existing');
});

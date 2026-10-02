import {resolveAdapterUploadModules,readStagedSource} from '../adapter-upload-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';

// Exercise the actual source. A staged overlay may supply changed modules while
// unchanged imports remain in the frozen checkout. These deterministic clocks
// test accounting; they do not measure performance or observed browser paint.
const data = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function moduleCode(path, imports = {}) {
  let code = (await transformWithOxc(await readStagedSource(path), path)).code;
  for (const [name, url] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(name), JSON.stringify(url)).replaceAll("'" + name + "'", JSON.stringify(url));
  return code;
}
const diagnosticURL = data(await moduleCode('src/observability/diagnostic-memory.ts'));
const compositionURL = data(await moduleCode('src/observability/composition-observations.ts', { './diagnostic-memory.js': diagnosticURL }));
const allocationsURL = data(await moduleCode('src/observability/allocations.ts', { './diagnostic-memory.js': diagnosticURL, './composition-observations.js': compositionURL }));
const { allocationLedger } = await import(allocationsURL);
const phasesURL = data(await moduleCode('src/observability/phases.ts', { './diagnostic-memory.js': diagnosticURL }));
const { PhaseRecorder } = await import(phasesURL);
const commandCode = await moduleCode('server/observability/command-phases.ts', { '../../src/observability/phases.js': phasesURL, '../../src/observability/diagnostic-memory.js':diagnosticURL });
const { CommandAcceptancePhases, LocalQueuePhases } = await import(data(commandCode));
const workerCode = await moduleCode('src/observability/browser-worker-observations.ts', { './phases.js': phasesURL, './diagnostic-memory.js': diagnosticURL });
const workerURL = data(workerCode);
const navigationURL = data(await moduleCode('src/observability/navigation-observations.ts', { './phases.js': phasesURL, './diagnostic-memory.js': diagnosticURL }));
const {adapterUploadURL,adapterUploadHookURL}=await resolveAdapterUploadModules({diagnosticMemoryURL:diagnosticURL,allocationsURL});
const browserCode = await moduleCode('src/observability/browser.ts', { './navigation-observations.js': navigationURL, './phases.js': phasesURL, './browser-worker-observations.js': workerURL, './allocations.js': allocationsURL, './diagnostic-memory.js': diagnosticURL, './composition-observations.js': compositionURL, './adapter-upload-hook.js': adapterUploadHookURL, './adapter-upload.js': adapterUploadURL });
const { BrowserPhases } = await import(data(browserCode));

// Assertion copies belong to the runner, outside the product ownership graph.
// Release the real scoped copy in finally, including when assertion copying fails.
function copyRead(read) { try { return structuredClone(read.value); } finally { read.release(); } }
const copySnapshot = owner => copyRead(owner.readSnapshot());
const copyWorkerSnapshot = worker => copyRead(worker.readWorkerPhases());
const recorders = new Set(), browsers = new Set(), workerFixtures = new Set(),commandOwners=new Set();
function ownCommands(recorder,capacity){const owner=new CommandAcceptancePhases(recorder,capacity);commandOwners.add(owner);return owner;}
function ownQueue(recorder,capacity){const owner=new LocalQueuePhases(recorder,capacity);commandOwners.add(owner);return owner;}
function ownRecorder(options) { const recorder = new PhaseRecorder(options); recorders.add(recorder); return recorder; }
test.afterEach(() => {
  for(const owner of commandOwners)owner.close();commandOwners.clear();
  try { for (const browser of browsers) browser.dispose(); }
  finally {
    browsers.clear();
    try { for (const worker of workerFixtures) worker.disposeWorkerPhases(); }
    finally { workerFixtures.clear(); for (const recorder of recorders) recorder.dispose(); recorders.clear(); }
  }
});

function fixture(options = {}) {
  let monotonic = 100, wall = 1_800_000_000_100;
  const recorder = ownRecorder({ lane: 'browser', now: () => monotonic, wallNow: () => wall, ...options });
  return { recorder, now(value) { monotonic = value; }, wall(value) { wall = value; } };
}

test('snapshot schema records local durations and one explicitly uncertain wall-clock join', () => {
  const f = fixture();
  assert.deepEqual(copySnapshot(f.recorder), { schemaVersion: 1, lane: 'browser', clockOriginUnixMs: 1_800_000_000_000, clockUncertaintyMs: null, records: [], dropped: 0, invalid: 0 });
  const span = f.recorder.start('command.validate', { commandId: 'command_existing', documentId: 'document_existing', revision: '9007199254740993' });
  assert.deepEqual(copySnapshot(f.recorder).records, [], 'An unfinished action cannot manufacture a completion');
  f.now(137.5); f.wall(-999_999_999);
  assert.equal(span.end(), 100);
  const row = copySnapshot(f.recorder).records.at(-1);
  assert.deepEqual(row, { sequence: 1, phase: 'command.validate', startedMs: 100, endedMs: 137.5, durationMs: 37.5, outcome: 'ok', context: { commandId: 'command_existing', documentId: 'document_existing', revision: '9007199254740993' } });
  assert.equal(copySnapshot(f.recorder).clockOriginUnixMs, 1_800_000_000_000, 'Wall-clock adjustments do not alter monotonic durations or silently rebase earlier records');
});

test('concurrent spans use finish order without inventing correlation identities', () => {
  const f = fixture(), first = f.recorder.start('result.prepare');
  f.now(105); const second = f.recorder.start('event.append', { commandId: 'existing-command' });
  f.now(109); second.end(); f.now(122); first.end();
  assert.deepEqual(copySnapshot(f.recorder).records, [
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
  assert.equal(copySnapshot(browser.recorder).records[0].durationMs, 8);
  assert.equal(copySnapshot(authority.recorder).records[0].durationMs, 19);
  assert.notEqual(copySnapshot(browser.recorder).clockOriginUnixMs, copySnapshot(authority.recorder).clockOriginUnixMs);
});

test('end returns only its start timestamp and scoped snapshots cannot mutate retained observations', () => {
  const f = fixture(), input = { commandId: 'before', bytes: 10 }, additions = { assetId: 'result-before' };
  const span = f.recorder.start('asset.stage', input); input.commandId = 'after';
  f.now(120); const ended = span.end('ok', additions); additions.assetId = 'result-after';
  assert.equal(ended, 100);
  const read = f.recorder.readSnapshot();
  try { read.value.records[0].context.commandId = 'mutated-read'; read.value.records[0].durationMs = -10; } finally { read.release(); }
  const snapshot = copySnapshot(f.recorder); snapshot.records[0].context.assetId = 'mutated-snapshot'; snapshot.records.length = 0;
  f.now(200); assert.equal(span.end('error', { bytes: 99 }), undefined);
  assert.deepEqual(copySnapshot(f.recorder).records, [{ sequence: 1, phase: 'asset.stage', startedMs: 100, endedMs: 120, durationMs: 20, outcome: 'ok', context: { commandId: 'before', bytes: 10, assetId: 'result-before' } }]);
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
  assert.deepEqual(copySnapshot(f.recorder).records[0].context, { commandId: 'known_command-1' });
  const encoded = JSON.stringify(copySnapshot(f.recorder));
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
  assert.deepEqual(copySnapshot(f.recorder).records[0].context, context);
});

test('invalid context scalars are omitted rather than coerced, truncated or serialized', () => {
  const f = fixture();
  for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123', null, {}, [], true]) f.recorder.instant('raster.prepare', { width: bad, bytes: bad });
  for (const revision of ['-1', '01', '1.0', '1e3', '1'.repeat(41), 1]) f.recorder.instant('command.validate', { revision });
  for (const assetHash of ['a'.repeat(64), 'sha256:' + 'A'.repeat(64), 'sha256:' + 'a'.repeat(63), 'https://remote.invalid/secret']) f.recorder.instant('result.verify', { assetHash });
  for (const commandId of ['', 'a'.repeat(129), { toString() { throw Error('No coercion'); } }]) f.recorder.instant('command.validate', { commandId });
  f.recorder.instant('ui.feedback', { boundary: 'secret prompt', readiness: 'prepared', replay: 'true' });
  assert(copySnapshot(f.recorder).records.every(row => Object.keys(row.context).length === 0));
});

test('phase and lane validation prevent arbitrary strings entering the trace vocabulary', () => {
  const f = fixture();
  for (const phase of ['private prompt text', 'https://remote.invalid/token', 'command.validate\n', '', '__proto__']) assert.throws(() => f.recorder.start(phase), /PHASE_NAME/);
  assert.deepEqual(copySnapshot(f.recorder).records, []);
  for (const lane of ['private prompt text', 'https://remote.invalid/token', '', 'Browser', 'a'.repeat(49)]) assert.throws(() => fixture({ lane }), /PHASE_LANE/);
});

test('only supported outcomes are retained and an invalid outcome becomes visibly incomplete', () => {
  const f = fixture();
  for (const outcome of ['ok', 'rejected', 'error', 'cancelled', 'incomplete', 'uncertain']) f.recorder.start('command.accept').end(outcome);
  f.recorder.start('command.accept').end('private error response with signed URL');
  const snapshot = copySnapshot(f.recorder);
  assert.deepEqual(snapshot.records.map(row => row.outcome), ['ok', 'rejected', 'error', 'cancelled', 'incomplete', 'uncertain', 'incomplete']);
  assert.equal(snapshot.invalid, 1); assert(!JSON.stringify(snapshot).includes('private error'));
});

test('valid input timestamps are measured locally and invalid or epoch timestamps fall back visibly', () => {
  const f = fixture();
  f.recorder.start('ui.feedback', { boundary: 'intent' }, 75).end();
  for (const timestamp of [-1, NaN, Infinity, 101, 1_800_000_000_100]) f.recorder.start('ui.feedback', {}, timestamp).end();
  const snapshot = copySnapshot(f.recorder);
  assert.equal(snapshot.records[0].durationMs, 25);
  assert(snapshot.records.slice(1).every(row => row.startedMs === 100 && row.endedMs === 100 && row.durationMs === 0));
  assert.equal(snapshot.invalid, 5);
});

test('backward or nonfinite monotonic clock samples cannot create negative or infinite durations', () => {
  const f = fixture(), span = f.recorder.start('result.fetch');
  f.now(90); assert.equal(span.end(), 100); const ended = copySnapshot(f.recorder).records.at(-1); assert.equal(ended.durationMs, 0); assert.equal(ended.endedMs, 100);
  for (const value of [NaN, Infinity, -1]) { f.now(value); const next = f.recorder.start('result.store'); next.end(); }
  f.now(150); f.recorder.start('result.verify', {}, 140).end();
  const snapshot = copySnapshot(f.recorder);
  assert.equal(snapshot.invalid, 7);
  assert(snapshot.records.every(row => Number.isFinite(row.durationMs) && row.durationMs >= 0));
  assert.equal(snapshot.records.at(-1).durationMs, 10);
});

test('a bad initial monotonic clock remains explicit instead of poisoning all later records', () => {
  let now = NaN;
  const recorder = ownRecorder({ lane: 'browser', now: () => now, wallNow: () => 500 });
  now = 10; recorder.start('document.replay', { replay: true }).end();
  const snapshot = copySnapshot(recorder); assert.equal(snapshot.invalid, 1); assert.equal(snapshot.clockOriginUnixMs, 500);
  assert.deepEqual(snapshot.records[0].context, { replay: true }); assert.equal(snapshot.records[0].durationMs, 0);
});

test('bounded ring retains newest complete records with exact drop accounting', () => {
  const f = fixture({ capacity: 2 });
  for (let i = 0; i < 5; i++) { f.now(100 + i); f.recorder.instant('job.observe', { count: i }); }
  const snapshot = copySnapshot(f.recorder);
  assert.equal(snapshot.dropped, 3); assert.deepEqual(snapshot.records.map(row => [row.sequence, row.context.count]), [[4, 3], [5, 4]]);
  assert.equal(copySnapshot(f.recorder).dropped, 3, 'A read is not a drain');
});

test('drain resets interval loss counters while global record sequence continues', () => {
  const f = fixture({ capacity: 1 });
  f.recorder.instant('job.observe'); f.recorder.start('job.observe', {}, -1).end('invalid');
  const drained = copyRead(f.recorder.drain());
  assert.equal(drained.dropped, 1); assert.equal(drained.invalid, 2); assert.equal(drained.records[0].sequence, 2);
  assert.deepEqual(copySnapshot(f.recorder).records, []); assert.equal(copySnapshot(f.recorder).dropped, 0); assert.equal(copySnapshot(f.recorder).invalid, 0);
  f.recorder.instant('reconnect'); assert.equal(copySnapshot(f.recorder).records[0].sequence, 3);
  assert.equal(drained.records[0].sequence, 2, 'Later records cannot mutate a previously drained packet');
});

test('capacity cannot be unbounded, fractional, negative or implicitly coerced', () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 16385, '2']) assert.throws(() => fixture({ capacity }), /PHASE_CAPACITY/);
  assert.equal(copySnapshot(fixture({ capacity: 1 }).recorder).records.length, 0);
  assert.equal(copySnapshot(fixture({ capacity: 16384 }).recorder).records.length, 0);
});

test('instant uses one clock sample and cannot manufacture a nonzero phase duration', () => {
  let now = 0;
  const recorder = ownRecorder({ lane: 'browser', now: () => ++now, wallNow: () => 1_000 });
  assert.equal(recorder.instant('result.candidate_available', { boundary: 'encoded-durable' }), 2);
  const record = copySnapshot(recorder).records.at(-1);
  assert.equal(now, 2); assert.equal(record.startedMs, 2); assert.equal(record.endedMs, 2); assert.equal(record.durationMs, 0);
});

test('end-known fields refine a phase without relabeling its captured command or document identity', () => {
  const f = fixture(), initial = { commandId: 'original-command', documentId: 'original-document', attemptId: 'original-attempt', assetId: 'original-asset', revision: '7', assetHash: 'sha256:' + 'a'.repeat(64), boundary: 'intent', bytes: 10 };
  const span = f.recorder.start('result.adopt', initial);
  const started = span.end('ok', { commandId: 'other-command', documentId: 'other-document', attemptId: 'other-attempt', assetId: 'other-asset', revision: '8', assetHash: 'sha256:' + 'b'.repeat(64), resultingRevision: '8', outputAssetId: 'actual-output', boundary: 'local-durable', bytes: 20 });
  assert.equal(started, 100); const record = copySnapshot(f.recorder).records.at(-1);
  assert.deepEqual(record.context, { ...initial, resultingRevision: '8', outputAssetId: 'actual-output', boundary: 'local-durable', bytes: 20 });
});

test('nonfinite wall-clock origins are refused instead of emitting a misleading JSON clock join', () => {
  for (const wall of [NaN, Infinity, -Infinity]) assert.throws(() => fixture({ wallNow: () => wall }), /PHASE_CLOCK_ORIGIN/);
});

const command = (id = 'command-existing') => ({ commandId: id, documentId: 'document-existing', expectedDocumentRevision: '7', transactionId: 'transaction-existing', correlationId: 'correlation-existing', body: { prompt: 'Private command contents', url: 'https://remote.invalid/?token=secret' } });
const accepted = (id = 'command-existing') => ({ status: 'accepted', commandId: id, fromSeq: '11', toSeq: '13', documentRevision: '8', transactionId: 'transaction-existing' });
const commandRows = f => copySnapshot(f.recorder).records.filter(row => row.phase === 'command.accept');
const validationRows = f => copySnapshot(f.recorder).records.filter(row => row.phase === 'command.validate');

test('authority acceptance remains pending until the matching durable receipt is observed', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), handle = authority.begin(command(), 'sha256:' + 'a'.repeat(64));
  for (const result of [null, undefined, true, 'accepted', {}, { status: 'pending' }, { status: 'pending', receipt: accepted() }, accepted('wrong-command')]) authority.complete(handle, result);
  assert.equal(authority.pending, 1); assert.deepEqual(copySnapshot(f.recorder).records, []);
  f.now(155); authority.complete(handle, accepted());
  const row = commandRows(f)[0];
  assert.equal(authority.pending, 0); assert.equal(row.phase, 'command.accept'); assert.equal(row.durationMs, 55); assert.equal(row.outcome, 'ok');
  assert.deepEqual(row.context, { commandId: 'command-existing', documentId: 'document-existing', revision: '7', transactionId: 'transaction-existing', correlationId: 'correlation-existing', boundary: 'authority-durable', resultingRevision: '8' });
});

test('durable notification requires both original command identity and immutable request hash', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), hash = 'sha256:' + 'a'.repeat(64), otherHash = 'sha256:' + 'b'.repeat(64);
  authority.begin(command(), hash); authority.begin(command(), otherHash);
  authority.durable('other-command', hash, accepted()); authority.durable('command-existing', 'wrong-hash', accepted());
  assert.equal(authority.pending, 2); assert.deepEqual(copySnapshot(f.recorder).records, []);
  authority.durable('command-existing', hash, accepted());
  assert.equal(authority.pending, 1); assert.equal(commandRows(f).length, 1);
  authority.durable('command-existing', hash, accepted()); assert.equal(commandRows(f).length, 1, 'Repeated durable observation is idempotent');
  authority.close(); assert.deepEqual(commandRows(f).map(row => row.outcome), ['ok', 'incomplete']);
});

test('rejected durable commands are distinguishable from errors and preserve observed revision only', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), handle = authority.begin(command());
  authority.complete(handle, { status: 'rejected', commandId: 'command-existing', currentRevision: '19', code: 'REVISION_CONFLICT', details: { rawProviderResponse: 'Private provider prompt echo', url: 'https://remote.invalid/secret' } });
  const row = commandRows(f)[0];
  assert.equal(row.outcome, 'rejected'); assert.equal(row.context.boundary, 'authority-durable'); assert.equal(row.context.resultingRevision, '19');
  assert(!JSON.stringify(copySnapshot(f.recorder)).includes('Private')); assert(!JSON.stringify(copySnapshot(f.recorder)).includes('remote.invalid'));
});

test('server tracking captures metadata without retaining or evaluating the command body', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), input = command();
  Object.defineProperty(input, 'body', { get() { throw Error('Command body must not be inspected by phase tracking'); } });
  const handle = authority.begin(input, 'sha256:' + 'a'.repeat(64)); input.commandId = 'changed-later'; input.documentId = 'changed-later';
  authority.complete(handle, accepted());
  assert.equal(commandRows(f)[0].context.commandId, 'command-existing');
  assert.equal(commandRows(f)[0].context.documentId, 'document-existing');
  assert(!JSON.stringify(handle).includes('body'));
});

test('unknown malformed command identity cannot acquire a successful receipt by matching undefined', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), handle = authority.begin(undefined);
  authority.complete(handle, { status: 'accepted' }); authority.complete(handle, accepted());
  assert.equal(authority.pending, 1); assert.deepEqual(copySnapshot(f.recorder).records, []);
  authority.fail(handle);
  assert.equal(authority.pending, 0); assert.equal(commandRows(f)[0].outcome, 'error'); assert.deepEqual(commandRows(f)[0].context, {});
});

test('server active capacity censors the oldest unfinished acceptance without claiming durability', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder, 2), oldest = authority.begin(command('oldest'));
  authority.begin(command('middle')); authority.begin(command('latest'));
  assert.equal(authority.pending, 2);
  const first = commandRows(f)[0]; assert.equal(first.context.commandId, 'oldest'); assert.equal(first.outcome, 'incomplete'); assert.equal(first.context.boundary, undefined);
  authority.complete(oldest, accepted('oldest')); assert.equal(commandRows(f).length, 1);
  authority.close(); assert.equal(authority.pending, 0); assert.deepEqual(commandRows(f).map(row => row.context.commandId), ['oldest', 'middle', 'latest']);
  assert.deepEqual(validationRows(f).map(row => row.outcome), ['incomplete', 'incomplete', 'incomplete']);
});

test('server errors, successful completion and shutdown each finish a handle at most once', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), a = authority.begin(command('a')), b = authority.begin(command('b')), c = authority.begin(command('c'));
  authority.fail(a); authority.fail(a); authority.complete(a, accepted('a'));
  authority.complete(b, accepted('b')); authority.fail(b); authority.complete(b, accepted('b'));
  authority.close(); authority.close(); authority.fail(c); authority.fail(undefined); authority.complete(undefined, accepted());
  assert.equal(authority.pending, 0); assert.deepEqual(commandRows(f).map(row => row.outcome), ['error', 'ok', 'incomplete']);
  assert.deepEqual(validationRows(f).map(row => row.outcome), ['error', 'ok', 'incomplete']);
});

test('server unfinished-acceptance capacity cannot be disabled or expanded without bounds', () => {
  const f = fixture({ lane: 'server-writer' });
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 1025, '2', null]) assert.throws(() => ownCommands(f.recorder, capacity), /PHASE_PENDING_CAPACITY/);
});

test('completed domain validation stays distinct from the later durable acceptance boundary', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), hash = 'sha256:' + 'a'.repeat(64);
  authority.begin(command(), hash); f.now(125); authority.validated('command-existing', hash, accepted());
  assert.equal(authority.pending, 1); assert.deepEqual(commandRows(f), []);
  assert.equal(validationRows(f).length, 1); assert.equal(validationRows(f)[0].durationMs, 25); assert.equal(validationRows(f)[0].context.boundary, 'observed'); assert.equal(validationRows(f)[0].context.replay, undefined);
  f.now(145); authority.durable('command-existing', hash, accepted());
  assert.equal(authority.pending, 0); assert.equal(commandRows(f)[0].durationMs, 45); assert.equal(commandRows(f)[0].context.boundary, 'authority-durable'); assert.equal(validationRows(f).length, 1);
});

test('validation observations require matching command, payload hash and a valid receipt disposition', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), hash = 'sha256:' + 'a'.repeat(64);
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
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), handle = authority.begin(command());
  authority.complete(handle, accepted());
  const row = validationRows(f)[0]; assert.equal(row.context.replay, true); assert.equal(row.context.boundary, 'authority-durable');
  assert.equal(commandRows(f)[0].context.replay, undefined); assert.equal(commandRows(f)[0].outcome, 'ok');
});

test('successful validation followed by commit failure does not become successful acceptance', () => {
  const f = fixture({ lane: 'server-writer' }), authority = ownCommands(f.recorder), hash = 'sha256:' + 'a'.repeat(64), handle = authority.begin(command(), hash);
  f.now(120); authority.validated('command-existing', hash, accepted()); f.now(130); authority.fail(handle); authority.close();
  assert.equal(validationRows(f).length, 1); assert.equal(validationRows(f)[0].outcome, 'ok'); assert.equal(validationRows(f)[0].durationMs, 20);
  assert.equal(commandRows(f).length, 1); assert.equal(commandRows(f)[0].outcome, 'error'); assert.equal(commandRows(f)[0].durationMs, 30); assert.equal(commandRows(f)[0].context.boundary, undefined);
});

test('local queue spans retain the accepted command until dispatch eligibility commits', () => {
  const f = fixture({ lane: 'server-writer' }), queue = ownQueue(f.recorder);
  queue.begin('job-existing', { commandId: 'command-existing', documentId: 'document-existing' });
  assert.equal(queue.pending, 1); assert.deepEqual(copySnapshot(f.recorder).records, []);
  f.now(145); queue.eligible('job-existing', 'document-existing', 'attempt-existing');
  assert.equal(queue.pending, 0);
  assert.deepEqual(copySnapshot(f.recorder).records, [{ sequence: 1, phase: 'job.local_queue', startedMs: 100, endedMs: 145, durationMs: 45, outcome: 'ok', context: { commandId: 'command-existing', documentId: 'document-existing', jobId: 'job-existing', attemptId: 'attempt-existing', boundary: 'dispatch' } }]);
  queue.eligible('job-existing', 'document-existing', 'attempt-existing'); assert.equal(copySnapshot(f.recorder).records.length, 1);
});

test('recovered jobs without a current-process queue start cannot fabricate elapsed residence', () => {
  const f = fixture({ lane: 'server-writer' }), queue = ownQueue(f.recorder);
  queue.eligible('replayed-job', 'document-existing', 'attempt-existing'); queue.cancel('replayed-job'); queue.close();
  assert.equal(queue.pending, 0); assert.deepEqual(copySnapshot(f.recorder).records, []);
});

test('local queue cancellation and replacement are terminal and capacity loss is visibly incomplete', () => {
  const f = fixture({ lane: 'server-writer' }), queue = ownQueue(f.recorder, 2);
  queue.begin('cancelled'); queue.cancel('cancelled'); queue.cancel('cancelled'); queue.eligible('cancelled', 'document-existing', 'attempt-existing');
  queue.begin('replaced'); queue.begin('replaced'); queue.begin('next'); queue.begin('last'); queue.close(); queue.close();
  assert.equal(queue.pending, 0);
  assert.deepEqual(copySnapshot(f.recorder).records.map(row => [row.context.jobId, row.outcome]), [['cancelled', 'cancelled'], ['replaced', 'incomplete'], ['replaced', 'incomplete'], ['next', 'incomplete'], ['last', 'incomplete']]);
  assert.equal(copySnapshot(f.recorder).records[0].context.boundary, 'authority-durable');
  assert(copySnapshot(f.recorder).records.slice(1).every(row => row.context.boundary === undefined));
});

test('local queue observes only safe metadata and does not inspect prompt fields or accessors', () => {
  const f = fixture({ lane: 'server-writer' }), queue = ownQueue(f.recorder), context = { commandId: 'command-existing', jobId: 'cannot-relabel-job', prompt: 'Private user prompt', url: 'https://remote.invalid/secret' };
  Object.defineProperty(context, 'caption', { enumerable: true, get() { throw Error('Telemetry must not read private accessors'); } });
  queue.begin('actual-job', context); queue.eligible('actual-job', 'document-existing', 'attempt-existing');
  assert.deepEqual(copySnapshot(f.recorder).records[0].context, { commandId: 'command-existing', jobId: 'actual-job', documentId: 'document-existing', attemptId: 'attempt-existing', boundary: 'dispatch' });
});

test('local queue active capacity is finite and positive', () => {
  const f = fixture({ lane: 'server-writer' });
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 1025, '2', null]) assert.throws(() => ownQueue(f.recorder, capacity), /PHASE_PENDING_CAPACITY/);
});

const target = { documentId: 'document-existing', revision: '8', assetId: 'output-existing' };
const adoption = { previewId: 'preview-existing', documentId: 'document-existing', revision: '7', assetId: 'prepared-existing' };
function browserFixture() {
  const f = fixture({ lane: 'browser-main' });
  const browser = new BrowserPhases(undefined, f.recorder, 1_800_000_000_000.25); browsers.add(browser);
  return { ...f, browser };
}
const adoptionRows = f => copySnapshot(f.browser).trace.records.filter(row => row.phase === 'result.adopt');

for (const order of ['durability-first', 'render-first']) test(`browser adoption ${order} remains censored until external presentation evidence`, () => {
  const f = browserFixture(); f.browser.beginAdoption(adoption, false); f.now(105); f.browser.bindAdoption('preview-existing', { commandId: 'command-existing' });
  f.now(150);
  if (order === 'durability-first') f.browser.adoptionDurable('command-existing', target); else f.browser.viewportDecoded(target, 120);
  assert.equal(adoptionRows(f).length, 0); assert.equal(copySnapshot(f.browser).adoptions[0].outcome, 'pending');
  f.now(170);
  if (order === 'durability-first') f.browser.viewportDecoded(target, 151); else f.browser.adoptionDurable('command-existing', target);
  const snapshot = copySnapshot(f.browser), [row] = adoptionRows(f);
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
  assert.equal(adoptionRows(f).length, 0); assert.equal(copySnapshot(f.browser).adoptions[0].renderSubmittedMs, null);
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
  assert.deepEqual(copySnapshot(f.browser).adoptions.map(row => [row.context.previewId, row.context.readiness]), [['unprepared', 'C'], ['prepared', 'B'], ['decoded', 'A'], ['unprepared-after-decode', 'C']]);
  assert.deepEqual(adoptionRows(f), []);
});

for (const mode of ['default-probe', 'different-asset', 'cleared-viewport', 'failed-probe']) test(`stale last-draw metadata cannot claim readiness A with ${mode}`, () => {
  const f = browserFixture();
  f.browser.viewportDecoded({ documentId: 'document-existing', revision: '7', assetId: 'prepared-existing' });
  if (mode === 'different-asset') f.browser.setViewportProbe(() => 'preview-replacement');
  if (mode === 'cleared-viewport') f.browser.setViewportProbe(() => null);
  if (mode === 'failed-probe') f.browser.setViewportProbe(() => { throw Error('Viewport observation unavailable'); });
  f.now(120); f.browser.beginAdoption(adoption, true);
  assert.equal(copySnapshot(f.browser).adoptions[0].context.readiness, 'B');
  assert.deepEqual(adoptionRows(f), []);
});

test('a late command binding retains original adoption identity and cannot relabel an existing command', () => {
  const f = browserFixture(); f.browser.beginAdoption(adoption, false);
  f.browser.bindAdoption('preview-existing', { commandId: 'command-existing', documentId: 'other-document', revision: '999', assetId: 'other-asset', previewId: 'other-preview' });
  f.browser.bindAdoption('preview-existing', { commandId: 'changed-command' });
  const context = copySnapshot(f.browser).adoptions[0].context;
  assert.deepEqual(context, { ...adoption, commandId: 'command-existing', readiness: 'C' });
  f.browser.adoptionDurable('changed-command', target); assert.equal(copySnapshot(f.browser).adoptions[0].durableMs, null);
  f.browser.adoptionDurable('command-existing', target); assert.equal(copySnapshot(f.browser).adoptions[0].durableMs, 100);
});

test('invalid preview and target metadata neither retain private content nor complete an adoption', () => {
  const f = browserFixture();
  f.browser.beginAdoption({ previewId: 'https://remote.invalid/secret', prompt: 'Private user prompt' }, true);
  assert.deepEqual(copySnapshot(f.browser).adoptions, []); assert.deepEqual(copySnapshot(f.browser).trace.records, []);
  f.browser.beginAdoption({ ...adoption, commandId: 'command-existing', prompt: 'Private user prompt', sourceURL: 'https://remote.invalid/secret' }, true);
  f.browser.adoptionDurable('command-existing', { ...target, assetId: '../secret' }); f.browser.viewportDecoded({ ...target, documentId: 'https://remote.invalid/secret' });
  assert.equal(copySnapshot(f.browser).adoptions[0].durableMs, null); assert.equal(adoptionRows(f).length, 0);
  assert(!JSON.stringify(copySnapshot(f.browser)).includes('Private')); assert(!JSON.stringify(copySnapshot(f.browser)).includes('secret'));
});

for (const outcome of ['error', 'rejected', 'cancelled']) test(`browser adoption ${outcome} remains terminal when stale durability or viewport work arrives`, () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'command-existing' }, false);
  f.now(115); f.browser.adoptionFailed('preview-existing', outcome); f.browser.adoptionFailed('preview-existing', 'error');
  f.now(150); f.browser.adoptionDurable('command-existing', target); f.browser.viewportDecoded(target);
  assert.equal(adoptionRows(f).length, 1); assert.equal(adoptionRows(f)[0].outcome, outcome); assert.equal(adoptionRows(f)[0].durationMs, 15);
  assert.equal(copySnapshot(f.browser).adoptions[0].outcome, outcome); assert.equal(copySnapshot(f.browser).adoptions[0].durableMs, null);
});

test('reusing a preview identity cancels the old pending span before tracking the new explicit intent', () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'old-command' }, false);
  f.now(125); f.browser.beginAdoption({ ...adoption, commandId: 'new-command' }, true);
  assert.deepEqual(adoptionRows(f).map(row => [row.outcome, row.context.commandId]), [['cancelled', 'old-command']]);
  assert.equal(copySnapshot(f.browser).adoptions.length, 1); assert.equal(copySnapshot(f.browser).adoptions[0].intentMs, 125);
  f.browser.adoptionDurable('old-command', target); assert.equal(copySnapshot(f.browser).adoptions[0].durableMs, null);
});

test('browser reset ends pending spans and clears prepared viewport readiness for the next owner', () => {
  const f = browserFixture(); let resident = 'prepared-existing'; f.browser.setViewportProbe(() => resident); f.browser.viewportDecoded({ documentId: 'document-existing', revision: '7', assetId: 'prepared-existing' });
  f.browser.beginAdoption({ ...adoption, commandId: 'old-command' }, true); assert.equal(copySnapshot(f.browser).adoptions[0].context.readiness, 'A');
  f.now(115); f.browser.reset(); f.browser.reset(); resident = null;
  assert.deepEqual(adoptionRows(f).map(row => row.outcome), ['cancelled']);
  f.browser.adoptionDurable('old-command', target); assert.equal(copySnapshot(f.browser).adoptions[0].durableMs, null);
  f.browser.beginAdoption({ ...adoption, previewId: 'new-preview' }, true);
  assert.equal(copySnapshot(f.browser).adoptions.at(-1).context.readiness, 'B');
});

test('browser pending-adoption storage is bounded and reports the dropped incomplete intent', () => {
  const f = browserFixture();
  for (let i = 0; i < 65; i++) f.browser.beginAdoption({ ...adoption, previewId: 'preview-' + i, commandId: 'command-' + i }, false);
  const snapshot = copySnapshot(f.browser); assert.equal(snapshot.adoptions.length, 64); assert.equal(snapshot.droppedAdoptions, 1); assert.equal(snapshot.adoptions[0].context.previewId, 'preview-1');
  assert.deepEqual(adoptionRows(f).map(row => [row.context.previewId, row.outcome]), [['preview-0', 'incomplete']]);
  f.browser.adoptionDurable('command-0', target); assert.equal(adoptionRows(f).length, 1);
});

test('browser snapshot copies cannot mutate pending adoption identity or target matching', () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'command-existing' }, false); f.browser.adoptionDurable('command-existing', target);
  const snapshot = copySnapshot(f.browser); snapshot.adoptions[0].context.commandId = 'other-command'; snapshot.adoptions[0].target.assetId = 'other-asset'; snapshot.trace.records.length = 0;
  f.now(145); f.browser.viewportDecoded(target);
  assert.equal(adoptionRows(f).length, 1); assert.equal(adoptionRows(f)[0].context.commandId, 'command-existing'); assert.equal(adoptionRows(f)[0].context.outputAssetId, 'output-existing');
});

test('browser endpoints use the recorder clock guard rather than retaining nonfinite or backward samples', () => {
  const f = browserFixture(); f.browser.beginAdoption({ ...adoption, commandId: 'command-existing' }, false);
  f.now(80); f.browser.adoptionDurable('command-existing', target, 1_800_000_000_000);
  f.now(NaN); f.browser.viewportDecoded(target);
  const snapshot = copySnapshot(f.browser), row = snapshot.adoptions[0];
  assert.equal(row.intentMs, 100); assert.equal(row.durableMs, 100); assert.equal(row.renderSubmittedMs, 100); assert(snapshot.trace.invalid > 0);
  assert(snapshot.trace.records.every(record => Number.isFinite(record.durationMs) && record.durationMs >= 0)); assert.equal(adoptionRows(f)[0].outcome, 'incomplete');
});

test('input acknowledgement remains pending until submitted feedback and never claims presented paint', () => {
  const f = browserFixture(); f.browser.beginIntent({ documentId: 'document-existing', commandId: 'command-existing' }, 75);
  assert.deepEqual(copySnapshot(f.browser).trace.records.map(row => row.phase), ['ui.intent']);
  const intent = copySnapshot(f.browser).trace.records[0]; assert.equal(intent.startedMs, 75); assert.equal(intent.context.boundary, 'intent');
  f.now(125); f.browser.feedbackSubmitted(); f.browser.feedbackSubmitted();
  const feedback = copySnapshot(f.browser).trace.records.filter(row => row.phase === 'ui.feedback');
  assert.equal(feedback.length, 1); assert.equal(feedback[0].startedMs, 75); assert.equal(feedback[0].durationMs, 50); assert.equal(feedback[0].outcome, 'incomplete'); assert.equal(feedback[0].context.boundary, 'render-submitted');
  assert(!copySnapshot(f.browser).trace.records.some(row => row.context.boundary === 'presented'));
});

test('new input censors earlier unsubmitted feedback instead of erasing its elapsed work', () => {
  const f = browserFixture(); f.browser.beginIntent({ commandId: 'first-command' }); f.now(120); f.browser.beginIntent({ commandId: 'second-command' });
  const before = copySnapshot(f.browser).trace.records.filter(row => row.phase === 'ui.feedback');
  assert.equal(before.length, 1); assert.equal(before[0].context.commandId, 'first-command'); assert.equal(before[0].durationMs, 20); assert.equal(before[0].outcome, 'incomplete'); assert.equal(before[0].context.boundary, undefined);
  f.now(140); f.browser.feedbackSubmitted();
  const rows = copySnapshot(f.browser).trace.records.filter(row => row.phase === 'ui.feedback'); assert.equal(rows.length, 2); assert.equal(rows[1].context.commandId, 'second-command'); assert.equal(rows[1].durationMs, 20);
});

test('browser owner reset cancels pending feedback and late submission cannot revive it', () => {
  const f = browserFixture(); f.browser.beginIntent({ commandId: 'command-existing' }); f.now(110); f.browser.reset(); f.now(150); f.browser.feedbackSubmitted(); f.browser.reset();
  const rows = copySnapshot(f.browser).trace.records.filter(row => row.phase === 'ui.feedback');
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'cancelled'); assert.equal(rows[0].durationMs, 10); assert.equal(rows[0].context.boundary, undefined);
});

test('input telemetry drops private fields and uses a guarded local timestamp', () => {
  const f = browserFixture(), context = { documentId: 'document-existing', prompt: 'Private prompt', signedURL: 'https://remote.invalid/secret' };
  Object.defineProperty(context, 'caption', { enumerable: true, get() { throw Error('Private getter'); } });
  f.browser.beginIntent(context, 1_800_000_000_000); f.browser.feedbackSubmitted();
  assert(copySnapshot(f.browser).trace.invalid > 0); assert(copySnapshot(f.browser).trace.records.every(row => row.startedMs === 100 && row.durationMs === 0));
  assert(!JSON.stringify(copySnapshot(f.browser)).includes('Private')); assert(!JSON.stringify(copySnapshot(f.browser)).includes('remote.invalid'));
});

let workerFixtureNumber = 0;
const workerFixture = async () => { const worker = await import(data(workerCode + '\n// isolated collector fixture ' + ++workerFixtureNumber)); workerFixtures.add(worker); return worker; };
const workerPacket = () => ({ schemaVersion: 1, lane: 'text-worker', clockOriginUnixMs: 10_000, clockUncertaintyMs: null, dropped: 0, invalid: 0, records: [
  { sequence: 1, phase: 'text.layout', startedMs: 10, endedMs: 20, durationMs: 10, outcome: 'ok', context: { requestId: 'request-existing', documentId: 'document-existing', revision: '7', readiness: 'B', boundary: 'observed' } },
  { sequence: 2, phase: 'text.edit', startedMs: 15, endedMs: 25, durationMs: 10, outcome: 'incomplete', context: { requestId: 'request-existing', boundary: 'render-submitted' } },
] });

test('worker observations preserve each local clock and never synthesize a main-thread duration', async () => {
  const worker = await workerFixture(), first = workerPacket(), second = workerPacket(); second.clockOriginUnixMs = 90_000;
  second.records = [{ ...second.records[0], startedMs: 200, endedMs: 204, durationMs: 4 }];
  worker.retainWorkerPhases(first); worker.retainWorkerPhases(second);
  assert.deepEqual(copyWorkerSnapshot(worker), { schemaVersion: 1, traces: [first, second], dropped: 0, invalid: 0, clockJoin: 'external-calibration-required' });
});

test('worker collector strips unknown fields, invalid readiness and private accessors without reading them', async () => {
  const worker = await workerFixture(), packet = workerPacket(); let calls = 0;
  packet.prompt = 'Private packet prompt'; packet.records[0].url = 'https://remote.invalid/secret'; packet.records[0].context.prompt = 'Private row prompt'; packet.records[0].context.providerRequestId = 'https://remote.invalid/secret';
  packet.records[0].context.readiness = 'fabricated-presented'; packet.records[0].context.width = Infinity;
  Object.defineProperty(packet.records[0].context, 'assetHash', { enumerable: true, get() { calls++; throw Error('Private getter'); } });
  Object.defineProperty(packet.records[0], 'privateCaption', { enumerable: true, get() { calls++; throw Error('Private getter'); } });
  worker.retainWorkerPhases(packet);
  const snapshot = copyWorkerSnapshot(worker); assert.equal(calls, 0); assert.equal(snapshot.invalid, 0); assert.equal(snapshot.traces.length, 1);
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
  const snapshot = copyWorkerSnapshot(worker); assert.equal(snapshot.invalid, mutations.length); assert.equal(snapshot.dropped, 0); assert.deepEqual(snapshot.traces, []);
  assert(!JSON.stringify(snapshot).includes('Private'));
});

test('worker collector does not evaluate required-field accessors or retain partially valid packets', async () => {
  const worker = await workerFixture(), packet = workerPacket(); let calls = 0;
  Object.defineProperty(packet.records[1], 'phase', { enumerable: true, get() { calls++; throw Error('Private getter'); } });
  worker.retainWorkerPhases(packet);
  const envelope = workerPacket(); Object.defineProperty(envelope, 'records', { enumerable: true, get() { calls++; throw Error('Private getter'); } }); worker.retainWorkerPhases(envelope);
  assert.equal(calls, 0); assert.equal(copyWorkerSnapshot(worker).invalid, 2); assert.deepEqual(copyWorkerSnapshot(worker).traces, []);
});

test('worker collector bounds snapshots and rows while preserving exact producer and collector loss counts', async () => {
  const worker = await workerFixture();
  for (let i = 0; i < 33; i++) {
    const packet = workerPacket(); packet.clockOriginUnixMs = 10_000 + i; packet.dropped = 3; packet.invalid = 4;
    packet.records = Array.from({ length: 128 }, (_, row) => ({ sequence: row + 1, phase: 'text.layout', startedMs: row, endedMs: row + 0.5, durationMs: 0.5, outcome: 'ok', context: { count: row } }));
    worker.retainWorkerPhases(packet);
  }
  const snapshot = copyWorkerSnapshot(worker); assert.equal(snapshot.traces.length, 32); assert.equal(snapshot.dropped, 1); assert.equal(snapshot.invalid, 0);
  assert.equal(snapshot.traces[0].clockOriginUnixMs, 10_001); assert.equal(snapshot.traces.at(-1).clockOriginUnixMs, 10_032);
  assert(snapshot.traces.every(trace => trace.records.length === 128 && trace.dropped === 3 && trace.invalid === 4));
});

test('worker packets and returned snapshots cannot mutate retained observations', async () => {
  const worker = await workerFixture(), packet = workerPacket(); worker.retainWorkerPhases(packet);
  packet.records[0].context.documentId = 'mutated-input'; packet.records.length = 0;
  const snapshot = copyWorkerSnapshot(worker); snapshot.traces[0].records[0].context.documentId = 'mutated-output'; snapshot.traces.length = 0;
  assert.equal(copyWorkerSnapshot(worker).traces[0].records.length, 2); assert.equal(copyWorkerSnapshot(worker).traces[0].records[0].context.documentId, 'document-existing');
});

test('an asynchronous diagnostic consumer keeps its read owned until the final awaited use', async () => {
  const f = fixture(); f.recorder.instant('ui.intent', { commandId: 'before' });
  const baseline = allocationLedger.snapshot().cpuBytes, read = f.recorder.readSnapshot();
  try {
    assert(allocationLedger.snapshot().cpuBytes > baseline);
    await Promise.resolve(); f.recorder.instant('ui.intent', { commandId: 'after' });
    assert.deepEqual(read.value.records.map(row => row.context.commandId), ['before']);
    assert(allocationLedger.snapshot().cpuBytes > baseline, 'An await does not release the diagnostic copy');
  } finally { read.release(); }
  assert.equal(allocationLedger.snapshot().cpuBytes, baseline);
  assert.throws(() => read.value, /DIAGNOSTIC_READ_RELEASED/); read.release();
});

test('the assertion-copy helper releases its real read when runner copying throws', () => {
  const f = fixture(); f.recorder.instant('ui.intent', { commandId: 'existing' });
  const baseline = allocationLedger.snapshot().cpuBytes, native = globalThis.structuredClone, failure = Error('Assertion copy failed'); let copies = 0;
  globalThis.structuredClone = (...args) => { if (++copies === 2) throw failure; return native(...args); };
  try { assert.throws(() => copySnapshot(f.recorder), error => error === failure); }
  finally { globalThis.structuredClone = native; }
  assert.equal(copies, 2, 'Exercise failure after the product copy has been admitted');
  assert.equal(allocationLedger.snapshot().cpuBytes, baseline);
  assert.equal(copySnapshot(f.recorder).records[0].context.commandId, 'existing');
});

test('a drained packet retains independent ownership after producer disposal and releases exactly once', () => {
  const baseline = allocationLedger.snapshot().cpuBytes, recorder = ownRecorder({ lane: 'drain-owner', capacity: 2, now: () => 10, wallNow: () => 100 });
  recorder.instant('ui.intent', { commandId: 'retained' });
  const read = recorder.drain();
  try {
    assert.deepEqual(copySnapshot(recorder).records, []); recorder.dispose();
    assert(allocationLedger.snapshot().cpuBytes > baseline);
    assert.equal(read.value.records[0].context.commandId, 'retained');
    assert.throws(() => recorder.readSnapshot(), /PHASE_DISPOSED/);
  } finally { read.release(); }
  read.release(); assert.equal(allocationLedger.snapshot().cpuBytes, baseline); assert.throws(() => read.value, /DIAGNOSTIC_READ_RELEASED/);
});

test('browser aggregate read remains owned across asynchronous use and external recorder disposal is explicit', async () => {
  const f = fixture(), recorderBaseline = allocationLedger.snapshot().cpuBytes, browser = new BrowserPhases(undefined, f.recorder, 1_800_000_000_000.25); browsers.add(browser);
  browser.beginAdoption({ previewId: 'preview-existing', commandId: 'command-existing' }, false);
  const read = browser.readSnapshot('async_consumer');
  try {
    await Promise.resolve(); browser.dispose();
    assert.equal(browser.readSnapshot('async_consumer'), read, 'Cleanup can recover the same outstanding read by its owner key');
    assert.equal(read.value.adoptions[0].context.commandId, 'command-existing');
    f.recorder.instant('reconnect', { commandId: 'recorder-still-owned' });
    assert.equal(copySnapshot(f.recorder).records.at(-1).context.commandId, 'recorder-still-owned', 'Browser disposal does not release an injected recorder');
    assert(allocationLedger.snapshot().cpuBytes > recorderBaseline);
  } finally { read.release(); }
  assert.equal(allocationLedger.snapshot().cpuBytes, recorderBaseline);
  assert.throws(() => read.value, /DIAGNOSTIC_READ_RELEASED/);
});

const navigationTarget={sessionId:'ui-session',generation:2,documentId:'document-existing',revision:'8',assetId:'output-existing',assetHash:'sha256:'+'a'.repeat(64)};
const navigationModel={...navigationTarget,snapshotId:'recovery-generation'};
function commitNavigation(browser,target=navigationTarget,enabled=true){browser.recordNavigationControlsRendered(target,enabled);browser.recordNavigationControlsCommitted(target,true,enabled);}
for(const order of ['model-first','render-first'])test(`navigation ${order} joins real observations without claiming shaping or physical presentation`,()=>{
 const f=browserFixture();
 f.now(110);if(order==='model-first')f.browser.recordNavigationModelReady(navigationModel);else f.browser.recordNavigationRenderSubmitted(navigationTarget);
 if(order==='model-first'){f.browser.recordNavigationControlsRendered(navigationTarget,true);f.browser.recordNavigationControlsCommitted(navigationTarget,false,true);}else commitNavigation(f.browser);assert.equal(copySnapshot(f.browser).navigation.editAvailableMs,null);
 f.now(120);if(order==='model-first')f.browser.recordNavigationRenderSubmitted(navigationTarget);else f.browser.recordNavigationModelReady(navigationModel);
 f.now(130);commitNavigation(f.browser);
 const row=copySnapshot(f.browser).navigation;
 assert.deepEqual(row.identity,navigationModel);assert.equal(row.navigationTimeOriginMs,1_800_000_000_000.25);
 assert.equal(row.modelReadyMs,order==='model-first'?110:120);assert.equal(row.renderSubmittedMs,order==='model-first'?120:110);assert.equal(row.editAvailableMs,130);
 assert.equal(row.viewportCurrent,true);assert.equal(row.editAvailable,true);assert.equal(row.modelMeaning,'stored-authoritative-model');assert.equal(row.renderMeaning,'canonical-canvas-render-submitted');assert.equal(row.editMeaning,'shell-committed-document-controls');assert.equal(row.presentationEvidence,'external-trace-required');
 f.now(140);f.browser.recordNavigationModelReady(navigationModel);f.browser.recordNavigationRenderSubmitted(navigationTarget);commitNavigation(f.browser);assert.deepEqual(copySnapshot(f.browser).navigation,row);
 assert.equal(copySnapshot(f.browser).trace.records.length,0,'Navigation endpoints do not fabricate phase spans or shaping work');
});
for(const key of ['sessionId','generation','documentId','revision','assetId','assetHash'])test(`navigation rejects late viewport or render controls for a different ${key}`,()=>{
 const f=browserFixture(),other={...navigationTarget,[key]:key==='generation'?3:key==='revision'?'9':key==='assetHash'?'sha256:'+'b'.repeat(64):'different-existing'};
 f.browser.recordNavigationModelReady(navigationModel);f.browser.recordNavigationRenderSubmitted(other);commitNavigation(f.browser,other);
 assert.equal(copySnapshot(f.browser).navigation.renderSubmittedMs,null);assert.equal(copySnapshot(f.browser).navigation.editAvailableMs,null);
 f.browser.recordNavigationRenderSubmitted(navigationTarget);f.browser.recordNavigationControlsRendered(other,true);f.browser.recordNavigationControlsCommitted(navigationTarget,true,true);assert.equal(copySnapshot(f.browser).navigation.editAvailableMs,null);
 f.now(150);commitNavigation(f.browser);assert.equal(copySnapshot(f.browser).navigation.editAvailableMs,150);
});
test('navigation distinguishes a current submitted canvas from enabled committed controls and clears lost viewports',()=>{
 const f=browserFixture();f.browser.recordNavigationModelReady(navigationModel);f.browser.recordNavigationRenderSubmitted(navigationTarget);
 commitNavigation(f.browser,navigationTarget,false);let row=copySnapshot(f.browser).navigation;assert.equal(row.viewportCurrent,true);assert.equal(row.editAvailableMs,null);
 f.now(120);commitNavigation(f.browser);assert.equal(copySnapshot(f.browser).navigation.editAvailableMs,120);
 f.browser.recordNavigationControlsRendered(navigationTarget,true);f.browser.recordNavigationViewportUnavailable();f.browser.recordNavigationControlsCommitted(navigationTarget,false,true);
 row=copySnapshot(f.browser).navigation;assert.equal(row.modelReadyMs,100);assert.equal(row.renderSubmittedMs,null);assert.equal(row.editAvailableMs,null);assert.equal(row.viewportCurrent,false);assert.equal(row.editAvailable,false);
 f.now(150);f.browser.recordNavigationRenderSubmitted(navigationTarget);f.browser.recordNavigationControlsCommitted(navigationTarget,true,true);assert.equal(copySnapshot(f.browser).navigation.editAvailableMs,null,'A consumed or missing render gate cannot enable controls');
 f.now(160);commitNavigation(f.browser);row=copySnapshot(f.browser).navigation;assert.equal(row.renderSubmittedMs,150);assert.equal(row.editAvailableMs,160);
});
test('navigation publication replacement and reset retire all prior milestones while held owned reads remain immutable',()=>{
 const f=browserFixture();f.browser.recordNavigationModelReady(navigationModel);f.browser.recordNavigationRenderSubmitted(navigationTarget);commitNavigation(f.browser);
 const held=f.browser.readSnapshot('navigation-held');try{
  const saved=structuredClone(held.value.navigation);f.now(120);f.browser.recordNavigationModelReady({...navigationModel,snapshotId:'successor-generation'});
  let row=copySnapshot(f.browser).navigation;assert.equal(row.identity.snapshotId,'successor-generation');assert.equal(row.modelReadyMs,120);assert.equal(row.renderSubmittedMs,null);assert.equal(row.editAvailableMs,null);
  f.browser.resetNavigation();assert.equal(copySnapshot(f.browser).navigation,null);assert.deepEqual(held.value.navigation,saved);
  f.browser.recordNavigationModelReady({...navigationModel,generation:3});f.browser.recordNavigationRenderSubmitted(navigationTarget);assert.equal(copySnapshot(f.browser).navigation.renderSubmittedMs,null);
  f.browser.reset();assert.equal(copySnapshot(f.browser).navigation,null);assert.deepEqual(held.value.navigation,saved);
 }finally{held.release();}
});
test('navigation admits only bounded scalar identity metadata and its snapshot cannot mutate retained state',()=>{
 const f=browserFixture();let getters=0;const invalid={...navigationModel,documentId:undefined,prompt:'private'};Object.defineProperty(invalid,'documentId',{get(){getters++;return 'private';}});
 f.browser.recordNavigationModelReady(invalid);assert.equal(getters,0);assert.equal(copySnapshot(f.browser).navigation,null);
 for(const field of ['sessionId','documentId','assetId','snapshotId']){f.browser.recordNavigationModelReady({...navigationModel,[field]:'x'.repeat(129)});assert.equal(copySnapshot(f.browser).navigation,null);}
 f.browser.recordNavigationModelReady({...navigationModel,prompt:'private'});const before=allocationLedger.snapshot();
 for(let i=0;i<1000;i++){f.browser.recordNavigationRenderSubmitted(navigationTarget);commitNavigation(f.browser);}
 const after=allocationLedger.snapshot();assert.equal(after.cpuBytes,before.cpuBytes);assert.equal(after.activeRecords,before.activeRecords);
 const row=copySnapshot(f.browser).navigation;row.identity.documentId='mutated';assert.equal(copySnapshot(f.browser).navigation.identity.documentId,navigationTarget.documentId);assert(!JSON.stringify(copySnapshot(f.browser).navigation).includes('private'));
});

for(const change of ['revision','publication'])test(`navigation observes already submitted canonical residency for a new ${change} without fabricating a fresh draw`,()=>{
 const f=browserFixture();f.browser.recordNavigationModelReady(navigationModel);f.browser.recordNavigationRenderSubmitted(navigationTarget);commitNavigation(f.browser);
 const next={...navigationModel,...(change==='revision'?{revision:'9',assetHash:'sha256:'+'b'.repeat(64)}:{snapshotId:'recovery-successor'})};
 f.now(120);f.browser.recordNavigationModelReady(next);assert.equal(copySnapshot(f.browser).navigation.renderSubmittedMs,null);
 f.now(130);commitNavigation(f.browser,next);const row=copySnapshot(f.browser).navigation;
 assert.deepEqual(row.identity,next);assert.equal(row.modelReadyMs,120);assert.equal(row.renderSubmittedMs,130);assert.equal(row.renderMeaning,'canonical-resident-submission-observed');assert.equal(row.editAvailableMs,130);assert.equal(row.milestonePolicy,'current-availability-episode');assert.equal(copySnapshot(f.browser).trace.records.length,0);
});

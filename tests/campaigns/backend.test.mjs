import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exerciseQueueConnection, bindWQOwner, isWQCacheCell, inspectWQCacheProof, verifyWQCacheAttempt, WQ_CACHE_PROOF_LIMIT } from '../../tooling/qualification/campaigns/backend-wq-cache.mjs';
import { routeCell, supportedOperations } from '../../tooling/qualification/campaigns/backend.mjs';
import { identifyQueueCase, fastManifest, delay, workloadMissing } from '../../tooling/qualification/campaigns/backend-queue.mjs';
import { identifyTransfer } from '../../tooling/qualification/campaigns/backend-transfer.mjs';
import { envelope, expectedVersions, phase } from '../../tooling/qualification/campaigns/backend-common.mjs';
import { normalizeBackendMeasurements } from '../../tooling/qualification/campaigns/backend-measurements.mjs';
import { validateObserved } from '../../tooling/qualification/campaigns/fixtures.mjs';

test('backend dispatch covers the closed supported operation set without fallback success', () => {
  for (const operation of supportedOperations) {
    const parameters = operation === 'caption.raw-ingest' ? { bytes: 16777216 } : {};
    assert.match(routeCell({ operation, parameters }).module, /^\.\/backend-[a-z-]+\.mjs$/);
  }
  assert.throws(() => routeCell({ operation: 'unimplemented.request' }), { code: 'CELL_UNSUPPORTED' });
  assert.equal(routeCell({ operation: 'caption.raw-ingest', parameters: { bytes: 16777217 } }).cell.parameters.caseId, 'RAW16M_PLUS1');
  assert.throws(() => routeCell({ operation: 'caption.raw-ingest', parameters: { bytes: 1024 } }));
});

test('all nine inventory WQ names select one actual scenario and unknown names reject', () => {
  const names = ['lost-ack', 'duplicate-status', 'out-of-order-status', 'cancel-late-result', 'expiry', 'browser-restart', 'backend-restart', 'offline-completion', 'disk-full-admission'];
  const decoded = names.map(scenario => identifyQueueCase({ operation: 'queue.fault', parameters: { scenario } }));
  assert.equal(new Set(decoded.map(value => value.scenario)).size, 9);
  assert.equal(decoded[0].scenario, 'lost-acknowledgement'); assert.equal(decoded[4].scenario, 'expired-result-url');
  assert.throws(() => identifyQueueCase({ operation: 'queue.fault', parameters: { scenario: 'pretend-success' } }));
});

test('six Fast routes are a fixed manifest with all promised sizes, formats, speeds and counts', () => {
  assert.equal(fastManifest.length, 6);
  assert.deepEqual([...new Set(fastManifest.map(value => value.width))].sort((a, b) => a - b), [512, 1024, 2048]);
  assert.deepEqual([...new Set(fastManifest.map(value => value.count))].sort(), [1, 4]);
  assert.deepEqual([...new Set(fastManifest.map(value => value.format))].sort(), ['jpeg', 'png']);
  for (let index = 1; index <= 16; index++) assert(identifyQueueCase({ operation: 'fast.workflow', parameters: { caseId: 'WF' + String(index).padStart(2, '0') } }));
  assert.throws(() => identifyQueueCase({ operation: 'fast.workflow', parameters: { caseId: 'WF17' } }));
});

test('I7N admits all four exact byte-moving cells and refuses substitute sizes', () => {
  for (const direction of ['upload', 'download']) for (const bytes of [8388608, 33554432]) assert.deepEqual(identifyTransfer({ operation: 'transfer.asset', parameters: { direction, bytes } }), { direction, bytes });
  assert.throws(() => identifyTransfer({ operation: 'transfer.asset', parameters: { direction: 'download', bytes: 0 } }));
  assert.throws(() => identifyTransfer({ operation: 'transfer.asset', parameters: { direction: 'cache-hit', bytes: 8388608 } }));
});

test('real monotonic span preserves failures instead of success-shaped timing', async () => {
  const phases = []; const error = Object.assign(Error('owned operation rejected'), { code: 'REJECTED' });
  await assert.rejects(phase(phases, 'actual-operation', async () => { throw error; }), error);
  assert.equal(phases[0].outcome, 'failed'); assert.equal(phases[0].error.code, 'REJECTED');
  assert(phases[0].startMs <= phases[0].endMs); assert.equal(phases[0].durationMs, phases[0].endMs - phases[0].startMs);
});

test('real wait obeys cancellation, and command identity has correct frozen dependency', async () => {
  const controller = new AbortController(); controller.abort(Error('stop')); await assert.rejects(delay(10000, controller.signal), /stop/);
  const first = envelope({ type: 'CancelUnstartedJob' }), second = envelope({ type: 'CancelUnstartedJob' });
  assert.notEqual(first.command.commandId, second.command.commandId);
  assert.equal(expectedVersions.hash, 'sha256:10584db4c85cf1d5cbd2eda3429934a693b7c26268e63be96dbdb23d6dd42069');
});

test('backend measurement normalization requires actual producer method and retained evidence', () => {
  const cell = { requiredMeasurements: [{ name: 'R25PendingEntries', unit: 'count' }] };
  const missingProof = { measurements: { R25PendingEntries: 100 } };
  normalizeBackendMeasurements(cell, missingProof);
  assert.equal(missingProof.measurements.R25PendingEntries, 100, 'A bare value stays unqualified rather than receiving invented evidence');
  const evidence = [{ kind: 'queue-inventory', pendingEntries: 100, jobs: 1000, pages: 50 }];
  const observed = { measurements: { R25PendingEntries: 100 }, measurementDetails: { R25PendingEntries: { method: 'Complete public queue pages with the pending-admission predicate', evidence } } };
  normalizeBackendMeasurements(cell, observed);
  assert.deepEqual(observed.measurements.R25PendingEntries, { name: 'R25PendingEntries', value: 100, unit: 'count', method: observed.measurementDetails.R25PendingEntries.method, evidence });
});

test('paired proxy overhead retains its real interval proof without inventing a duration phase', () => {
  const pair = { direct: { startMs: 10, endMs: 12, durationMs: 2 }, proxy: { startMs: 15, endMs: 18, durationMs: 3 } };
  const output = { phases: [], measurements: { R26ProxyAddedHopMs: 1 }, measurementDetails: { R26ProxyAddedHopMs: { method: 'Same-worker sequential proxy minus direct duration', evidence: [{ kind: 'same-worker-proxy-pair', pair }] } } };
  normalizeBackendMeasurements({}, output);
  assert.equal(output.measurements.R26ProxyAddedHopMs.value, 1); assert.equal(output.measurements.R26ProxyAddedHopMs.unit, 'ms'); assert.deepEqual(output.phases, []);
});


test('WQ queue admission consumes the complete observed fixture contract using queued, not jobs', () => {
  // Contract data only: no fixture was prepared, sealed or qualified by this test.
  const observed = { productionValidated: true, width: 2048, height: 2048,
    activeRequests: 0, layers: 20, imageLayers: 20, textLayers: 0, visibleLayers: 5,
    events: 10000, snapshotTail: 500, queued: 1000, incompleteJobs: 100, candidates: 0 };
  validateObserved('WQ', observed);
  assert.equal(Object.hasOwn(observed, 'jobs'), false, 'The producer and manifest contract name the total queued');
  const fixture = { observed, seal: { path: '/contract-only/WQ.json', sha256: 'sha256:' + 'a'.repeat(64) } };
  const cell = { operation: 'queue.fault', workload: 'WQ', parameters: { scenario: 'lost-ack' } };
  assert.deepEqual(workloadMissing({ fixture }, cell), []);
  assert.equal(workloadMissing({ fixture: { observed } }, cell).length, 1, 'A missing manifest seal remains unavailable');
  assert.equal(workloadMissing({}, cell).length, 1, 'Absent fixture remains unavailable');
  for (const changed of [
    { ...observed, queued: 999 },
    { ...observed, incompleteJobs: 99 },
    (({ queued, ...rest }) => ({ ...rest, jobs: queued }))(observed),
  ]) {
    assert.throws(() => validateObserved('WQ', changed), /Fixture WQ (queued|incompleteJobs):/);
    assert.equal(workloadMissing({ fixture: { ...fixture, observed: changed } }, cell).length, 1);
  }
  assert.deepEqual(workloadMissing({}, { workload: 'WF' }), [], 'Other workload admission is unchanged');
});

const cacheHash = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
function connectionReadFixture() {
  const calls = [], document = { id: 'read-document', width: 64, height: 32, revision: '7' };
  const image = { layers: [{ id: 'visible-layer', visible: true }, { id: 'hidden-layer', visible: false }] };
  const capture = { highWater: '37', snapshot: { seq: '32' } };
  const jobs = [
    { id: 'cancelled', local: 'locally-cancelled', attempts: [{ state: 'locally-cancelled', hold: false }] },
    { id: 'pending', local: 'eligible', attempts: [{ state: 'not-started', hold: false }] },
    { id: 'active', local: 'eligible', attempts: [{ state: 'acknowledged', hold: true }] },
  ];
  const pages = {
    '': { totalJobs: 3, jobs: jobs.slice(0, 2), counts: { active: 1 }, nextCursor: 'next' },
    next: { totalJobs: 3, jobs: jobs.slice(2), counts: { active: 1 }, nextCursor: null },
  };
  const reader = {
    async capture() { calls.push(['capture']); return structuredClone(capture); },
    async document(id) { calls.push(['document', id]); assert.equal(id, document.id); return structuredClone(document); },
    async imageState(id) { calls.push(['imageState', id]); assert.equal(id, document.id); return structuredClone(image); },
    async queueView(cursor) { calls.push(['queueView', cursor]); assert(Object.hasOwn(pages, cursor)); return structuredClone(pages[cursor]); },
    submit() { assert.fail('Connection reads must not submit a command'); },
    queueCommand() { assert.fail('Connection reads must not write queue state'); },
  };
  return { calls, document, image, capture, jobs, pages, reader };
}

test('the final-connection cache profile selects only the three explicit WQ fault/control operations', () => {
  for (const operation of ['queue.fault', 'queue.proxy-pair', 'queue.healthy-polling']) {
    assert.equal(isWQCacheCell({ operation, workload: 'WQ' }), true);
    assert.equal(isWQCacheCell({ operation, workload: 'WF' }), false);
  }
  for (const cell of [undefined, {}, { operation: 'queue.unknown', workload: 'WQ' },
    { operation: 'fast.workflow', workload: 'WF' }, { operation: 'state.snapshot-read', workload: 'WQ' }]) assert.equal(isWQCacheCell(cell), false);
});

test('connection cache exercise traverses every public queue page and hashes bounded observed state without writes', async () => {
  const f = connectionReadFixture(), observed = await exerciseQueueConnection(f.reader, f.document.id);
  assert.deepEqual(observed, {
    documentId: f.document.id, width: 64, height: 32, layers: 2, visibleLayers: 1,
    imageHash: cacheHash(f.image), documentHash: cacheHash(f.document), highWater: '37', snapshot: f.capture.snapshot,
    queue: { pages: 2, jobs: 3, incomplete: 1, cancelled: 1, active: 1, sha256: cacheHash(f.jobs.map(job => JSON.stringify(job) + '\n').join('')) },
    reads: ['capture', 'document', 'imageState', 'all-queue-pages', 'capture', 'document', 'imageState'],
  });
  assert.deepEqual(f.calls.map(call => call[0]), ['capture', 'document', 'imageState', 'queueView', 'queueView', 'capture', 'document', 'imageState']);
  assert.deepEqual(f.calls.filter(call => call[0] === 'queueView').map(call => call[1]), ['', 'next']);
  assert.equal(Object.hasOwn(observed, 'jobs'), false, 'Full queue records are consumed, not retained in the proof');
});

for (const [name, change] of [
  ['duplicate job identity', f => { f.pages.next.jobs[0].id = f.pages[''].jobs[0].id; }],
  ['repeated cursor', f => { f.pages.next.nextCursor = 'next'; }],
  ['incomplete inventory', f => { f.pages[''].nextCursor = null; }],
  ['changing total', f => { f.pages.next.totalJobs = 4; }],
  ['changing global counter', f => { f.pages.next.counts.active = 2; }],
  ['incorrect active counter', f => { f.pages[''].counts.active = f.pages.next.counts.active = 0; }],
  ['oversized public page', f => { f.pages[''].jobs = Array.from({ length: 21 }, (_, i) => ({ id: 'overflow-' + i, attempts: [] })); }],
  ['global queue above the fixture-plus-scenario limit', f => { f.pages[''].totalJobs = 1002; }],
  ['malformed attempt list', f => { f.pages.next.jobs[0].attempts = null; }],
]) test('connection cache exercise rejects ' + name, async () => {
  const f = connectionReadFixture(); change(f);
  await assert.rejects(exerciseQueueConnection(f.reader, f.document.id));
});

test('connection cache exercise bounds empty cursor chains rather than accepting endless pages', async () => {
  const f = connectionReadFixture(); let pages = 0;
  f.reader.queueView = async () => ({ totalJobs: 0, jobs: [], counts: { active: 0 }, nextCursor: String(++pages) });
  await assert.rejects(exerciseQueueConnection(f.reader, f.document.id), /exceeds its full fixture/);
  assert.equal(pages, 52);
});

for (const [name, change] of [
  ['durable capture', f => { f.capture.highWater = '38'; }],
  ['document revision', f => { f.document.revision = '8'; }],
  ['image projection', f => { f.image.layers[0].visible = false; }],
]) test('connection cache exercise refuses ' + name + ' drift during its reads', async () => {
  const f = connectionReadFixture(), read = f.reader.queueView;
  f.reader.queueView = async cursor => { const page = await read(cursor); if (cursor === 'next') change(f); return page; };
  await assert.rejects(exerciseQueueConnection(f.reader, f.document.id), /changed/);
});

test('connection cache exercise observes cancellation before reads and between queue pages', async () => {
  const f = connectionReadFixture(), before = new AbortController(), failure = Error('cancelled cache reads'); before.abort(failure);
  await assert.rejects(exerciseQueueConnection(f.reader, f.document.id, { signal: before.signal }), error => error === failure);
  assert.deepEqual(f.calls, []);
  const during = new AbortController(), read = f.reader.queueView;
  f.reader.queueView = async cursor => { const page = await read(cursor); during.abort(failure); return page; };
  await assert.rejects(exerciseQueueConnection(f.reader, f.document.id, { signal: during.signal }), error => error === failure);
  assert.deepEqual(f.calls.map(call => call[0]), ['capture', 'document', 'imageState', 'queueView']);
});

test('a failed public read never produces a completed connection cache observation', async () => {
  const f = connectionReadFixture(), failure = Error('public queue read rejected');
  f.reader.queueView = async () => { throw failure; };
  await assert.rejects(exerciseQueueConnection(f.reader, f.document.id), error => error === failure);
  assert.deepEqual(f.calls.map(call => call[0]), ['capture', 'document', 'imageState']);
});

for (const field of ['root', 'epoch', 'connectionId', 'threadId', 'pid', 'moduleInstanceId']) test('WQ owner guard refuses changed ' + field + ' before measurement', async () => {
  const identity = { root: '/contract-only/store', epoch: '7', connectionId: 'connection-7', threadId: 2, pid: 3, moduleInstanceId: 'module-1' };
  const guard = await bindWQOwner(async () => structuredClone(identity));
  assert.deepEqual(await guard(), identity);
  identity[field] = typeof identity[field] === 'number' ? identity[field] + 1 : identity[field] + '-replacement';
  await assert.rejects(guard, /WQ measurement owner changed/);
});

test('WQ owner guard preserves a closed-owner rejection rather than accepting its last identity', async () => {
  const identity = { root: '/contract-only/store', epoch: '7' }, failure = Error('owner closed'); let closed = false;
  const guard = await bindWQOwner(async () => { if (closed) throw failure; return structuredClone(identity); });
  assert.deepEqual(await guard(), identity); closed = true;
  await assert.rejects(guard, error => error === failure);
});

// Explicit contract-only data. These packets test replay refusal; they were not
// produced by a worker, do not authenticate any source and establish no warmth.
function wqCacheContract(cache = 'warm', scenario = 'lost-ack', operation = 'queue.fault') {
  const digest = 'sha256:' + 'a'.repeat(64), root = '/contract-only/owned-wq';
  const parameters = operation === 'queue.fault' ? { scenario } : operation === 'queue.proxy-pair'
    ? { pairedDirectAndProxy: true, networkProfile: 'N' } : { durationMs: 10000 };
  const cell = { id: 'contract/wq/' + (operation === 'queue.fault' ? scenario : operation), operation, workload: 'WQ', parameters };
  const sample = { cache, ordinal: 1, prime: false };
  const fixture = { root: '/contract-only/sealed-wq', documentId: 'queue-document', seal: { sha256: digest }, preparation: { productionRestartVerified: true } };
  const sources = ['tooling/qualification/campaigns/backend-wq-cache.mjs', 'tooling/qualification/campaigns/backend.mjs',
    'tooling/qualification/campaigns/backend-common.mjs', 'tooling/qualification/campaigns/fixture-product.mjs',
    'tooling/qualification/campaigns/backend-queue.mjs', 'tooling/qualification/campaigns/backend-queue-worker.mjs',
    'tooling/qualification/campaigns/backend-queue-control.mjs', 'dist/local/server/storage/worker.js',
    'dist/local/server/storage/database.js', 'dist/local/server/storage/queue.js'].map(path => ({ path, bytes: 1, sha256: digest }));
  const owner = (epoch, threadId) => ({ kind: 'store-instance-connection', connectionId: 'connection-' + epoch, moduleInstanceId: 'module-' + threadId, pid: 123, threadId, root, epoch, sources: structuredClone(sources) });
  const counts = { events: 10000, rasterLayers: 20, layers: 20, independentLayerIds: 20, independentRasterAssets: 20,
    visible: 5, visibleMasked: 5, visibleTransformed: 5, snapshotTail: '500', jobs: 1000, incomplete: 100, cancelled: 900, active: 0, candidates: 0 };
  const baseline = { document: { id: fixture.documentId, width: 2048, height: 2048 }, counts, globalCounts: { events: 10000, jobs: 1000, active: 0 }, documentHash: digest, imageHash: digest, snapshot: { seq: '9500' } };
  const read = extra => ({ documentId: fixture.documentId, width: 2048, height: 2048, layers: 20, visibleLayers: 5,
    documentHash: digest, imageHash: digest, highWater: String(10000 + extra), snapshot: baseline.snapshot,
    queue: { pages: extra ? 51 : 50, jobs: 1000 + extra, incomplete: 100 + extra, cancelled: 900, active: 0, sha256: digest },
    reads: ['capture', 'document', 'imageState', 'all-queue-pages', 'capture', 'document', 'imageState'] });
  const phase = (name, startMs, endMs) => ({ name, startMs, endMs, durationMs: endMs - startMs, outcome: 'completed' });
  const record = (label, identity, extra = 0) => ({ label, before: identity, after: structuredClone(identity), entry: structuredClone(identity),
    entryAtMs: label === 'writer-before-scenario' ? 41 : 61, reads: cache === 'warm' ? read(extra) : null,
    ...(cache === 'warm' ? { readPhase: label === 'writer-before-scenario'
      ? phase('wq-cache.final-connection-public-reads', 31, 40) : phase('wq-cache.direct-connection-public-reads', 50, 60) } : {}) });
  const packet = { kind: 'backend-wq-connection-cache-1', previousStore: null, cell, sample,
    fixture: { seal: digest, sourceRoot: fixture.root, root, productionRestartVerified: true },
    cache: { profile: cache === 'warm' ? 'fresh-store-public-read-warmed-measurement-connections' : 'fresh-store-without-optional-connection-read-warming',
      previousCaseCacheReuse: 'not claimed', measurementWriter: 'fresh worker after actual close/reopen; direct stages explicitly identify their separate connection', previousStoreReused: false, commonBootstrap: ['StoreDatabase open/recovery', 'rememberClient', 'protocolDefaults', 'identity fence'],
      additionalScenarioPrimes: 0, writeCache: 'not claimed', jitCache: 'not claimed', decodedCache: 'not claimed', operatingSystemPageCache: 'unobserved' },
    setup: { owner: owner('1', 1), baseline, verificationPhase: phase('wq-cache.verify-global-fixture', 10, 20), restartPhase: phase('wq-cache.actual-writer-close-and-reopen', 21, 30) }, owners: [record('writer-before-scenario', owner('2', 2))], scenarioEntered: true, outcome: 'pass' };
  if (['backend-restart', 'disk-full-admission'].includes(scenario)) packet.owners.push(record(scenario === 'backend-restart' ? 'direct-before-dispatch' : 'direct-before-rejection', owner('3', 0), scenario === 'backend-restart' ? 1 : 0));
  packet.finalOwner = structuredClone(packet.owners.at(-1).after);
  if (scenario === 'backend-restart') {
    packet.measuredRestart = { before: structuredClone(packet.finalOwner), after: owner('4', 0), phase: phase('backend-close-and-reopen', 70, 80) };
    packet.finalOwner = structuredClone(packet.measuredRestart.after);
  }
  return { packet, cell, sample, fixture };
}

for (const cache of ['cold', 'warm']) for (const scenario of ['lost-ack', 'backend-restart', 'disk-full-admission']) test('WQ ' + cache + ' contract binds the declared final owner through ' + scenario, () => {
  const f = wqCacheContract(cache, scenario), result = inspectWQCacheProof(f.packet, f);
  assert.equal(result.root, f.packet.fixture.root); assert.equal(result.profile, f.packet.cache.profile);
  assert.equal(result.owners, scenario === 'lost-ack' ? 1 : 2);
});

for (const [name, change] of [
  ['sample ordinal', f => { f.packet.sample = { ...f.sample, ordinal: 2 }; }],
  ['fixture seal', f => { f.packet.fixture.seal = 'sha256:' + 'b'.repeat(64); }],
  ['reused sealed root', f => { f.packet.fixture.root = f.fixture.root; }],
  ['unverified production restart', f => { f.fixture.preparation.productionRestartVerified = false; }],
  ['prior-case cache reuse claim', f => { f.packet.cache.previousCaseCacheReuse = 'retained prior-case cache'; }],
  ['additional scenario prime', f => { f.packet.cache.additionalScenarioPrimes = 1; }],
  ['unentered scenario', f => { f.packet.scenarioEntered = false; }],
  ['accumulated global queue', f => { f.packet.setup.baseline.globalCounts.jobs = 1001; }],
  ['owner drift during public reads', f => { f.packet.owners[0].after.epoch = 'changed'; }],
  ['owner drift before measurement', f => { f.packet.owners[0].entry.connectionId = 'replacement'; }],
  ['missing warm reads', f => { f.packet.owners[0].reads = null; }],
  ['incomplete warm queue traversal', f => { f.packet.owners[0].reads.queue.jobs = 999; }],
  ['warm reads of another document', f => { f.packet.owners[0].reads.documentId = 'other'; }],
  ['changed warm document hash', f => { f.packet.owners[0].reads.documentHash = 'sha256:' + 'b'.repeat(64); }],
  ['changed source membership', f => { f.packet.owners[0].before.sources.pop(); }],
  ['final owner replacement', f => { f.packet.finalOwner.epoch = 'different'; }],
]) test('WQ cache replay rejects ' + name, () => {
  const f = wqCacheContract(); change(f); assert.throws(() => inspectWQCacheProof(f.packet, f));
});

test('WQ cold proof rejects optional warming, and direct paths require their own final-owner reads', () => {
  const cold = wqCacheContract('cold'); cold.packet.owners[0].reads = wqCacheContract().packet.owners[0].reads;
  assert.throws(() => inspectWQCacheProof(cold.packet, cold), /Cold owner was optionally read-warmed/);
  for (const scenario of ['backend-restart', 'disk-full-admission']) {
    const missingOwner = wqCacheContract('warm', scenario); missingOwner.packet.owners.pop();
    assert.throws(() => inspectWQCacheProof(missingOwner.packet, missingOwner));
    const missingReads = wqCacheContract('warm', scenario); missingReads.packet.owners[1].reads = null;
    assert.throws(() => inspectWQCacheProof(missingReads.packet, missingReads));
  }
});

test('WQ backend restart proof preserves the measured restart instead of accepting a warmed-owner substitution', () => {
  const f = wqCacheContract('warm', 'backend-restart');
  f.packet.measuredRestart.after.epoch = f.packet.measuredRestart.before.epoch;
  f.packet.finalOwner = structuredClone(f.packet.measuredRestart.after);
  assert.throws(() => inspectWQCacheProof(f.packet, f));
});

test('WQ cache replay retains the exact prior closed store seal and refuses a changed prior root', () => {
  const f = wqCacheContract();
  f.packet.previousStore = { root: '/contract-only/previous-wq', files: 2, bytes: 8192, sha256: 'sha256:' + 'd'.repeat(64) };
  f.packet.previousStoreAfter = structuredClone(f.packet.previousStore);
  assert.equal(inspectWQCacheProof(f.packet, f).root, f.packet.fixture.root);
  f.packet.previousStoreAfter.sha256 = 'sha256:' + 'e'.repeat(64);
  assert.throws(() => inspectWQCacheProof(f.packet, f), /Previous WQ store changed/);
  f.packet.previousStoreAfter = structuredClone(f.packet.previousStore);
  f.packet.previousStore.root = f.packet.fixture.root; f.packet.previousStoreAfter.root = f.packet.fixture.root;
  assert.throws(() => inspectWQCacheProof(f.packet, f));
});

for (const field of ['id', 'width', 'height']) test('cold WQ cache proof refuses a wrong baseline document ' + field, () => {
  const f = wqCacheContract('cold');
  f.packet.setup.baseline.document[field] = field === 'id' ? 'other-document' : 1024;
  assert.throws(() => inspectWQCacheProof(f.packet, f));
});

function retainedWQCacheContract(cache = 'warm', ordinal = 1, scenario = 'lost-ack', operation = 'queue.fault') {
  const f = wqCacheContract(cache, scenario, operation); f.sample.ordinal = ordinal;
  const bytes = Buffer.from(JSON.stringify(f.packet) + '\n'), reads = [];
  const artifact = { path: '/contract-only/retained/wq-cache.json', bytes: bytes.length, sha256: cacheHash(bytes) };
  const files = structuredClone(f.packet.setup.owner.sources);
  const resetPhases = [f.packet.setup.verificationPhase, f.packet.setup.restartPhase, f.packet.owners[0].readPhase].filter(Boolean);
  const resultPhases = [...f.packet.owners.slice(1).map(record => record.readPhase), f.packet.measuredRestart?.phase].filter(Boolean);
  const args = { cell: { ...f.cell, handler: 'backend' }, fixture: f.fixture, attempt: { ...f.sample, status: 'PASS', reset: { phases: structuredClone(resetPhases) },
      result: { phases: structuredClone(resultPhases), wqCache: { artifact, profile: f.packet.cache.profile } } },
    workerProcessIdentity: { pid: 123 }, controlFiles: files.filter(file => file.path.startsWith('tooling/')),
    buildFiles: files.filter(file => file.path.startsWith('dist/')), seenRoots: new Set(),
    readRetained: async (path, options) => { reads.push({ path, options }); assert.equal(path, artifact.path); assert.deepEqual(options, { maximum: WQ_CACHE_PROOF_LIMIT }); return Buffer.from(bytes); },
  };
  return { args, bytes, reads, packet: f.packet };
}

for (const hashStyle of ['prefixed', 'raw', 'mixed']) test('independent WQ replay binds exact source/build bytes with ' + hashStyle + ' SHA-256 rows', async () => {
  const f = retainedWQCacheContract(), files = [...f.args.controlFiles, ...f.args.buildFiles];
  for (const [index, file] of files.entries()) if (hashStyle === 'raw' || hashStyle === 'mixed' && index % 2) file.sha256 = file.sha256.slice('sha256:'.length);
  const replayed = await verifyWQCacheAttempt(f.args);
  assert.deepEqual(replayed, f.packet); assert.equal(f.reads.length, 1); assert.deepEqual([...f.args.seenRoots], [f.packet.fixture.root]);
});

for (const cache of ['cold', 'warm']) test('independent ' + cache + ' WQ replay requires proof for PASS while missing proof remains inconclusive', async () => {
  const f = retainedWQCacheContract(cache); f.args.attempt.result = {};
  await assert.rejects(verifyWQCacheAttempt(f.args), /Passing WQ attempt lacks/); assert.deepEqual(f.reads, []);
  f.args.attempt.status = 'INCONCLUSIVE'; assert.equal(await verifyWQCacheAttempt(f.args), null); assert.deepEqual(f.reads, []); assert.equal(f.args.seenRoots.size, 0);
});

for (const [name, change] of [
  ['changed control hash', f => { f.args.controlFiles[0].sha256 = 'b'.repeat(64); }],
  ['changed build hash', f => { f.args.buildFiles[0].sha256 = 'sha256:' + 'b'.repeat(64); }],
  ['changed control byte count', f => { f.args.controlFiles[0].bytes++; }],
  ['changed build byte count', f => { f.args.buildFiles[0].bytes++; }],
  ['deleted control source', f => { f.args.controlFiles[0].deleted = true; }],
  ['missing build output', f => { f.args.buildFiles.pop(); }],
  ['different worker process', f => { f.args.workerProcessIdentity.pid++; }],
]) test('independent WQ replay rejects ' + name, async () => {
  const f = retainedWQCacheContract(); change(f);
  await assert.rejects(verifyWQCacheAttempt(f.args)); assert.equal(f.reads.length, 1); assert.equal(f.args.seenRoots.size, 0);
});

test('independent WQ replay checks artifact bytes before accepting source or owner evidence', async () => {
  const f = retainedWQCacheContract(), altered = Buffer.from(f.bytes); altered[0] ^= 1;
  let reads = 0; f.args.readRetained = async () => { reads++; return altered; };
  await assert.rejects(verifyWQCacheAttempt(f.args)); assert.equal(reads, 1); assert.equal(f.args.seenRoots.size, 0);
  f.args.attempt.result.wqCache.artifact.bytes = WQ_CACHE_PROOF_LIMIT + 1;
  await assert.rejects(verifyWQCacheAttempt(f.args)); assert.equal(reads, 1, 'Oversized proof refuses before reading');
});

test('independent WQ replay rejects the same owned root under a later valid sample ordinal', async () => {
  const first = retainedWQCacheContract('warm', 1), second = retainedWQCacheContract('warm', 2);
  await verifyWQCacheAttempt(first.args); second.args.seenRoots = first.args.seenRoots;
  await assert.rejects(verifyWQCacheAttempt(second.args), /WQ sample reused a prior store/);
  assert.equal(second.reads.length, 1); assert.equal(first.args.seenRoots.size, 1);
});

for (const [name, change] of [
  ['verification overlapping the restart', f => { const value = f.packet.setup.verificationPhase; value.endMs = 22; value.durationMs = value.endMs - value.startMs; }],
  ['failed setup restart', f => { f.packet.setup.restartPhase.outcome = 'failed'; }],
  ['warm reads before the final connection opens', f => { const value = f.packet.owners[0].readPhase; value.startMs = 29; value.durationMs = value.endMs - value.startMs; }],
  ['scenario entry before reads settle', f => { f.packet.owners[0].entryAtMs = 35; }],
]) test('WQ cache proof refuses ' + name, () => {
  const f = wqCacheContract(); change(f); assert.throws(() => inspectWQCacheProof(f.packet, f));
});

test('cold WQ proof cannot hide optional warming behind an empty read payload', () => {
  const f = wqCacheContract('cold'); f.packet.owners[0].readPhase = wqCacheContract().packet.owners[0].readPhase;
  assert.equal(f.packet.owners[0].reads, null); assert.throws(() => inspectWQCacheProof(f.packet, f));
});

test('the measured backend restart must follow entry into its warmed direct connection', () => {
  const f = wqCacheContract('warm', 'backend-restart'), phase = f.packet.measuredRestart.phase;
  phase.startMs = 60; phase.durationMs = phase.endMs - phase.startMs;
  assert.throws(() => inspectWQCacheProof(f.packet, f));
});

for (const [name, change] of [
  ['missing setup verification', f => { f.args.attempt.reset.phases.shift(); }],
  ['missing final writer restart', f => { f.args.attempt.reset.phases.splice(1, 1); }],
  ['missing final writer reads', f => { f.args.attempt.reset.phases.pop(); }],
  ['duplicate preparation phase across ledgers', f => { f.args.attempt.result.phases.push(structuredClone(f.args.attempt.reset.phases[0])); }],
  ['altered charged preparation phase', f => { f.args.attempt.reset.phases[1].durationMs++; }],
]) test('independent WQ replay refuses ' + name, async () => {
  const f = retainedWQCacheContract(); change(f);
  await assert.rejects(verifyWQCacheAttempt(f.args), /charged ledger/); assert.equal(f.args.seenRoots.size, 0);
});

for (const scenario of ['backend-restart', 'disk-full-admission']) test('independent WQ replay charges the actual direct-owner reads for ' + scenario, async () => {
  const f = retainedWQCacheContract('warm', 1, scenario);
  assert.deepEqual(await verifyWQCacheAttempt(f.args), f.packet);
  f.args.seenRoots.clear(); f.args.attempt.result.phases = f.args.attempt.result.phases.filter(phase => phase.name !== 'wq-cache.direct-connection-public-reads');
  await assert.rejects(verifyWQCacheAttempt(f.args), /charged ledger/); assert.equal(f.args.seenRoots.size, 0);
});

test('independent WQ replay requires the actual measured restart once in the charged result', async () => {
  const f = retainedWQCacheContract('warm', 1, 'backend-restart');
  f.args.attempt.result.phases = f.args.attempt.result.phases.filter(phase => phase.name !== 'backend-close-and-reopen');
  await assert.rejects(verifyWQCacheAttempt(f.args), /charged ledger/);
  f.args.attempt.result.phases.push(structuredClone(f.packet.measuredRestart.phase), structuredClone(f.packet.measuredRestart.phase));
  await assert.rejects(verifyWQCacheAttempt(f.args), /charged ledger/); assert.equal(f.args.seenRoots.size, 0);
});


// These contract specimens exercise the actual independent proof consumer. They
// do not execute/qualify a six-pair cohort or its three real ten-second traces.
for (const [operation, caches] of [['queue.proxy-pair', ['cold', 'warm']], ['queue.healthy-polling', ['warm']]]) {
  for (const cache of caches) test(operation + ' ' + cache + ' requires the exact final WQ writer proof', async () => {
    const f = retainedWQCacheContract(cache, 1, 'control', operation);
    assert.deepEqual(identifyQueueCase(f.args.cell), { scenario: operation.slice(6), fast: false });
    assert.deepEqual(f.args.cell.parameters, operation === 'queue.proxy-pair'
      ? { pairedDirectAndProxy: true, networkProfile: 'N' } : { durationMs: 10000 });
    const packet = await verifyWQCacheAttempt(f.args);
    assert.deepEqual(packet, f.packet); assert.equal(packet.owners.length, 1);
    assert.equal(packet.measuredRestart, undefined); assert.equal(packet.cache.additionalScenarioPrimes, 0);
    if (cache === 'cold') assert.equal(packet.owners[0].reads, null);
    else assert.deepEqual(packet.owners[0].reads.queue, { pages: 50, jobs: 1000, incomplete: 100, cancelled: 900, active: 0, sha256: 'sha256:' + 'a'.repeat(64) });
    assert.equal(f.reads.length, 1); assert.equal(f.args.seenRoots.size, 1);
  });
  test(operation + ' refuses changed global counts, snapshot, owner and extra-prime proof', () => {
    for (const change of [
      f => { f.packet.setup.baseline.globalCounts.events++; },
      f => { f.packet.setup.baseline.globalCounts.jobs++; },
      f => { f.packet.owners[0].reads.queue.incomplete--; },
      f => { f.packet.owners[0].reads.queue.cancelled--; },
      f => { f.packet.owners[0].reads.highWater = '10001'; },
      f => { f.packet.owners[0].reads.snapshot = { seq: '9499' }; },
      f => { f.packet.finalOwner.connectionId = 'foreign-final-owner'; },
      f => { f.sample.prime = true; },
    ]) {
      const f = wqCacheContract('warm', 'control', operation); change(f);
      assert.throws(() => inspectWQCacheProof(f.packet, f));
    }
  });
  test(operation + ' cannot bypass missing PASS proof, source binding or charged warming', async () => {
    const missing = retainedWQCacheContract('warm', 1, 'control', operation); missing.args.attempt.result = {};
    await assert.rejects(verifyWQCacheAttempt(missing.args), /Passing WQ attempt lacks/);
    assert.deepEqual(missing.reads, []); assert.equal(missing.args.seenRoots.size, 0);
    missing.args.attempt.status = 'INCONCLUSIVE'; assert.equal(await verifyWQCacheAttempt(missing.args), null);
    const source = retainedWQCacheContract('warm', 1, 'control', operation); source.args.controlFiles[0].bytes++;
    await assert.rejects(verifyWQCacheAttempt(source.args), /source\/build binding changed/);
    assert.equal(source.args.seenRoots.size, 0);
    const uncharged = retainedWQCacheContract('warm', 1, 'control', operation);
    uncharged.args.attempt.reset.phases = uncharged.args.attempt.reset.phases.filter(row => row.name !== 'wq-cache.final-connection-public-reads');
    await assert.rejects(verifyWQCacheAttempt(uncharged.args), /charged ledger/);
    assert.equal(uncharged.args.seenRoots.size, 0);
  });
}


for (const operation of ['queue.fault', 'queue.proxy-pair', 'queue.healthy-polling']) test(operation + ' backend proof is not required or borrowed for browser and unowned handlers', async () => {
  for (const handler of ['browser', 'unknown', undefined]) {
    const f = retainedWQCacheContract('warm', 1, 'control', operation);
    f.args.cell.handler = handler;
    assert.equal(await verifyWQCacheAttempt(f.args), null);
    assert.deepEqual(f.reads, [], 'Non-backend results cannot consume a backend ownership artifact');
    assert.equal(f.args.seenRoots.size, 0);
    f.args.attempt.result = {};
    assert.equal(await verifyWQCacheAttempt(f.args), null, 'A browser PASS must not require backend proof');
  }
});

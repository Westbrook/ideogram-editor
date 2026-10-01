// Measurement evidence tests use only public-read fakes and synthetic HTTP
// records. They neither open a product writer nor make network requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectQueueMeasurements, readQueueMeasurementInventory } from '../../../tooling/qualification/campaigns/backend-queue-metrics.mjs';
import { normalizeBackendMeasurements } from '../../../tooling/qualification/campaigns/backend-measurements.mjs';
import { REQUIRED_MEASUREMENT_REGISTRY } from '../../../tooling/qualification/campaigns/inventory.mjs';
import { evaluateRequiredMeasurements } from '../../../tooling/qualification/campaigns/run.mjs';

const names = {
  active: 'R25ActiveRequests', pending: 'R25PendingEntries', rejected: 'R25RejectedDraftLossCount',
  status: 'R26StatusMessageBytes', rate: 'R26ObserverBytesPerMinute', terminal: 'R26LostTerminalStateCount',
  fetches: 'R32UnchangedOwnedAssetFetches', identity: 'R32CacheIdentityMismatchCount',
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = bytes => 'sha256:' + hash(bytes);
const endpoint = 'ideogram/v4', jobId = 'job_1', attemptId = 'attempt_1', requestId = 'request_1';
const statusPath = '/' + endpoint + '/requests/' + requestId + '/status';

function collect(required, options = {}) {
  return collectQueueMeasurements({ writer: {}, scenario: 'healthy-polling', snapshot: { effects: [] }, endpoint,
    ...options, before: { ...options.before, requiredMeasurements: required } });
}

function assertMissing(result, name, reason) {
  assert.equal(Object.hasOwn(result.measurements, name), false, name + ' must remain absent');
  const missing = result.missing.filter(item => item.startsWith(name + ': '));
  assert(missing.length > 0, name + ' needs an explicit missing-evidence reason');
  if (reason) assert(missing.some(item => reason.test(item)), missing.join('\n'));
}

function inventoryFixture() {
  const calls = [], counts = { active: 2, queued: 2, retained: 6 };
  const pages = [
    { counts: { ...counts }, totalJobs: 6, nextCursor: 'page_2', jobs: [
      { id: 'pending_early', attempts: [{ id: 'new_1', state: 'not-started', hold: false }] },
      { id: 'terminal_history', attempts: [{ id: 'old_1', state: 'provider-terminal', terminal: 'completed', hold: false }] },
      { id: 'cancelled', local: 'locally-cancelled', attempts: [{ id: 'cancelled_1', state: 'not-started', hold: false }] },
    ] },
    { counts: { retained: 6, queued: 2, active: 2 }, totalJobs: 6, nextCursor: null, jobs: [
      { id: 'pending_late', attempts: [{ id: 'old_2', state: 'provider-terminal', terminal: 'failed', hold: false }, { id: 'new_2', state: 'not-started', hold: false }] },
      { id: 'held_1', attempts: [{ id: 'held_attempt_1', state: 'acknowledged', hold: true }] },
      { id: 'held_2', attempts: [{ id: 'held_attempt_2', state: 'running', hold: true }] },
    ] },
  ];
  return { pages, calls, writer: { async queueView(cursor) { calls.push(cursor); return pages[cursor === '' ? 0 : 1]; } } };
}

function statusEffect({ path = statusPath, atMs = 1001, body = { status: 'IN_QUEUE', message: 'Café' }, terminalStatus } = {}) {
  const bodyBytes = Buffer.from(JSON.stringify(body));
  const requestHeaders = Buffer.from(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  const responseHeaders = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bodyBytes.length}\r\n\r\n`);
  return { method: 'GET', path, atMs, observerId: 'product-observer',
    request: { complete: true, bodyBytes: 0, headerBytes: requestHeaders.length, wireBytes: requestHeaders.length },
    response: { complete: true, statusCode: 200, bodyBytes: bodyBytes.length, headerBytes: responseHeaders.length,
      wireBytes: bodyBytes.length + responseHeaders.length, bodySha256: digest(bodyBytes), startedMs: atMs,
      completedMs: atMs + 1, clock: 'fixture-monotonic', ...(terminalStatus ? { terminalStatus } : {}) } };
}

function observerWindow(length) {
  return { complete: true, clock: 'fixture-monotonic', observerId: 'product-observer', productObserverOnly: true,
    startedMs: 1000, completedMs: 11000, effectStartIndex: 0, effectEndIndex: length };
}

function rejectedProof() {
  const before = { draftId: 'draft_1', generation: '2', assetId: 'asset_1',
    blob: { hash: digest('authored text'), byteLength: String(Buffer.byteLength('authored text')), mediaType: 'text/plain' }, rawHash: digest('authored text'),
    state: { prompt: 'authored text', selection: { start: 0, end: 12 }, dirty: false } };
  return { kind: 'rejected-draft-preservation-1', receipt: { status: 'rejected', code: 'STORAGE_FULL' }, before, after: structuredClone(before) };
}

function terminalFixture() {
  const effect = statusEffect({ body: { status: 'COMPLETED' }, terminalStatus: 'COMPLETED' }), calls = [];
  const read = { jobId, attemptId, kind: 'status', receipt: { outcome: 'complete', status: 200,
    sha256: effect.response.bodySha256.slice(7), receivedBytes: String(effect.response.bodyBytes),
    evidence: { recordId: 'protected_response_1', attemptId, direction: 'response', completeness: 'complete', sha256: effect.response.bodySha256.slice(7) } } };
  const recovery = { attempt: { id: attemptId, requestId, state: 'provider-terminal', terminal: 'completed', hold: false } };
  const view = { jobId, observation: { phase: 'completed' } };
  return { effect, read, recovery, view, calls, options: {
    queued: { job: { id: jobId } }, before: { terminalChallenge: { jobId, attemptId, requestId } },
    snapshot: { effects: [effect], controlReads: [read] },
    writer: { async queueRecovery(...args) { calls.push(['queueRecovery', ...args]); return recovery; },
      async candidateView(...args) { calls.push(['candidateView', ...args]); return view; } },
  } };
}

function cacheFixture() {
  const calls = [], phases = [], asset = { id: 'asset_1', state: 'owned', generation: '1', label: 'original',
    blob: { hash: digest('data'), byteLength: '4', mediaType: 'application/octet-stream' } };
  const values = { first: structuredClone(asset), second: structuredClone(asset), verified: structuredClone(asset), bytes: Buffer.from('d') };
  const prefix = [{ method: 'GET', path: '/image/earlier/0' }];
  const snapshots = [{ effects: structuredClone(prefix) }, { effects: [...structuredClone(prefix),
    { method: 'GET', path: statusPath }, { method: 'POST', path: '/image/not-a-fetch/0' },
    { method: 'GET', path: '/image/added/0' }, { method: 'GET', path: '/image/added/1' }] }];
  let projection = 0, snapshot = 0;
  const writer = {
    async assetProjection(id) { calls.push(['assetProjection', id]); return { asset: projection++ === 0 ? values.first : values.second }; },
    async assetVerify(id) { calls.push(['assetVerify', id]); return { handle: 'verified_handle', asset: values.verified }; },
    async assetContent(...args) { calls.push(['assetContent', ...args]); if (values.error) throw Error(values.error); return values.bytes; },
    async assetRelease(handle) { calls.push(['assetRelease', handle]); },
  };
  const control = { async snapshot(selectedEndpoint) { calls.push(['snapshot', selectedEndpoint]); return snapshots[snapshot++]; } };
  return { values, snapshots, calls, phases, options: { writer, control, phases, before: { cacheProbe: { assetId: asset.id } } } };
}

test('actual invariant producers preserve violation units through normalization and strict qualification', async t => {
  const cases = [
    { name: names.rejected, create: () => { const proof = rejectedProof(); return { options: { before: { rejectedDraftProof: proof } }, violate: () => { proof.after.state.dirty = true; } }; } },
    { name: names.terminal, create: () => { const fixture = terminalFixture(); return { options: fixture.options, violate: () => { fixture.recovery.attempt.hold = true; } }; } },
    { name: names.identity, create: () => { const fixture = cacheFixture(); return { options: fixture.options, violate: () => { fixture.values.verified.generation = '2'; } }; } },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const rule = Object.values(REQUIRED_MEASUREMENT_REGISTRY).flat().find(item => item.name === entry.name);
    assert.equal(rule.unit, 'violations');
    const cell = { requiredMeasurements: [rule] };
    const evaluate = result => evaluateRequiredMeasurements(cell, [{ id: 'metric-regression', cache: 'warm', prime: false, result }])[0];
    for (const violation of [false, true]) {
      const fixture = entry.create(); if (violation) fixture.violate();
      const result = await collect([entry.name], fixture.options);
      assert.deepEqual(result.missing, []);
      assert.equal(result.measurementDetails[entry.name].unit, 'violations');
      const wrongUnit = structuredClone(result); wrongUnit.measurementDetails[entry.name].unit = 'count';
      normalizeBackendMeasurements(cell, wrongUnit);
      assert.equal(evaluate(wrongUnit).status, 'INCONCLUSIVE', 'A producer unit mismatch must not be repaired by weakening the evaluator');
      normalizeBackendMeasurements(cell, result);
      assert.equal(result.measurements[entry.name].value, violation ? 1 : 0);
      assert.equal(evaluate(result).status, violation ? 'FAIL' : 'PASS');
    }
  });
});

test('queue inventory visits every page and applies pending admission separately from terminal history and cancellations', async () => {
  const fixture = inventoryFixture(), inventory = await readQueueMeasurementInventory(fixture.writer);
  assert.deepEqual(fixture.calls, ['', 'page_2']);
  assert.equal(inventory.pages, 2); assert.equal(inventory.jobs, 6);
  assert.equal(inventory.pendingEntries, 2); assert.deepEqual(inventory.pendingIds, ['pending_early', 'pending_late']);
  assert.equal(inventory.activeRequests, 2); assert.deepEqual(inventory.heldAttemptIds, ['held_attempt_1', 'held_attempt_2']);
  const result = await collect([names.active, names.pending], { writer: fixture.writer, before: {
    queueCheckpoints: [{ label: 'earlier', counts: { active: 4 } }, { label: 'later', counts: { active: 1 } }],
  } });
  assert.deepEqual(result.measurements, { [names.pending]: 2, [names.active]: 4 });
  assert.deepEqual(result.missing, []);
});

test('queue inventory rejects unstable cursors, counters, totals, jobs and held attempt identities', async t => {
  const cases = [
    ['repeated cursor', fixture => { fixture.pages[1].nextCursor = 'page_2'; }, /cursor repeated/],
    ['changed counter', fixture => { fixture.pages[1].counts.queued = 3; }, /counters changed/],
    ['changed total', fixture => { fixture.pages[1].totalJobs = 7; }, /inventory changed/],
    ['incomplete inventory', fixture => { for (const page of fixture.pages) page.totalJobs = 7; }, /Incomplete queue inventory/],
    ['duplicate job', fixture => { fixture.pages[1].jobs[0].id = 'pending_early'; }, /Duplicate or invalid/],
    ['duplicate held attempt', fixture => { fixture.pages[1].jobs[2].attempts[0].id = 'held_attempt_1'; }, /Attempt identity repeated/],
    ['active mismatch', fixture => { for (const page of fixture.pages) page.counts.active = 3; }, /held attempts disagree/],
  ];
  for (const [label, mutate, reason] of cases) await t.test(label, async () => {
    const fixture = inventoryFixture(); mutate(fixture);
    await assert.rejects(readQueueMeasurementInventory(fixture.writer), reason);
    const result = await collect([names.active, names.pending], { writer: fixture.writer });
    assertMissing(result, names.active, reason); assertMissing(result, names.pending, reason);
  });
});

test('requiredMeasurements filters both output and missing reasons without inventing unrelated zeros', async () => {
  const fixture = inventoryFixture(), result = await collect([names.pending], {
    writer: fixture.writer, snapshot: { effects: [statusEffect()] },
  });
  assert.deepEqual(result.measurements, { [names.pending]: 2 }); assert.deepEqual(result.missing, []);
  const empty = await collect([], { writer: new Proxy({}, { get() { assert.fail('No writer read is required'); } }) });
  assert.deepEqual(empty.measurements, {}); assert.deepEqual(empty.missing, []);
});

test('scenario and prepared metadata cannot manufacture rejection, terminal or cache zero measurements', async () => {
  const required = [names.rejected, names.terminal, names.fetches, names.identity];
  for (const scenario of ['disk-full-admission', 'cancel-late-result', 'healthy-polling']) {
    const result = await collect(required, { scenario, prepared: { draftId: 'draft_1', draftAsset: { id: 'asset_1' } } });
    assert.deepEqual(result.measurements, {});
    for (const name of required) assertMissing(result, name);
  }
});

test('rejected draft equality uses authored bytes and the complete saved state', async t => {
  const unchanged = rejectedProof();
  unchanged.after.state = { dirty: false, selection: { end: 12, start: 0 }, prompt: 'authored text' };
  assert.deepEqual((await collect([names.rejected], { before: { rejectedDraftProof: unchanged } })).measurements, { [names.rejected]: 0 });
  for (const [label, mutate] of [
    ['raw bytes changed', proof => { proof.after.rawHash = digest('changed text'); }],
    ['saved state changed', proof => { proof.after.state.selection.end = 1; }],
    ['owned identity changed', proof => { proof.after.assetId = 'asset_2'; }],
  ]) await t.test(label, async () => {
    const proof = rejectedProof(); mutate(proof);
    assert.deepEqual((await collect([names.rejected], { before: { rejectedDraftProof: proof } })).measurements, { [names.rejected]: 1 });
  });
  for (const [label, mutate] of [
    ['missing rejection', proof => { proof.receipt.status = 'accepted'; }],
    ['missing raw proof', proof => { delete proof.after.rawHash; }],
    ['missing state', proof => { delete proof.after.state; }],
    ['baseline does not match owned bytes', proof => { proof.before.rawHash = digest('other'); }],
  ]) await t.test(label, async () => {
    const proof = rejectedProof(); mutate(proof);
    assertMissing(await collect([names.rejected], { before: { rejectedDraftProof: proof } }), names.rejected);
  });
});

test('status size records exact complete response wire bytes within the selected effect interval', async () => {
  const first = statusEffect(), second = statusEffect({ body: { status: 'IN_PROGRESS', message: '東京 Café longer' } });
  const incomplete = statusEffect({ body: { text: 'x'.repeat(1000) } }); incomplete.response.complete = false;
  const outside = statusEffect({ body: { text: 'x'.repeat(2000) } });
  const effects = [outside, { path: '/image/result/0', response: outside.response }, first, incomplete, second, outside];
  const result = await collect([names.status], { snapshot: { effects }, before: { effectStartIndex: 1, effectEndIndex: 5 } });
  assert.deepEqual(result.measurements, { [names.status]: second.response.headerBytes + Buffer.byteLength(JSON.stringify({ status: 'IN_PROGRESS', message: '東京 Café longer' })) });
  assert.deepEqual(result.missing, []);
  const proof = result.evidence.find(item => item.kind === 'status-response-bytes');
  assert.deepEqual(proof.records.map(row => row.effectIndex), [2, 4]);
  assert.equal(proof.records[1].response.wireBytes, second.response.wireBytes);
  second.response.wireBytes++;
  assertMissing(await collect([names.status], { snapshot: { effects: [second] } }), names.status, /No complete exactly-accounted/);
});

test('observer rate includes exact request and response bytes across a complete ten-second product-only interval', async () => {
  const first = statusEffect(), second = statusEffect({ atMs: 10000, path: statusPath + '?poll=2' });
  const ignored = [{ method: 'POST', path: '/' + endpoint }, { method: 'GET', path: '/image/result/0' }, { path: '/' + endpoint + '/requests/' + requestId }];
  const effects = [first, ...ignored, second];
  const result = await collect([names.rate], { snapshot: { effects }, before: { observerWindow: observerWindow(effects.length) } });
  const requestBytes = first.request.wireBytes + second.request.wireBytes, responseBytes = first.response.wireBytes + second.response.wireBytes;
  assert.deepEqual(result.measurements, { [names.rate]: (requestBytes + responseBytes) * 6 });
  assert.deepEqual(result.missing, []);
  const proof = result.evidence.find(item => item.kind === 'normalized-observed-status-rate');
  assert.equal(proof.elapsedMs, 10000); assert.equal(proof.requestBytes, requestBytes); assert.equal(proof.responseBytes, responseBytes); assert.equal(proof.exchanges, 2);
});

test('observer rate rejects partial, direct, mixed or unproven observation windows', async t => {
  const cases = [
    ['under ten seconds', (_effects, window) => { window.completedMs = 10999; }, /at least ten real seconds/],
    ['incomplete window', (_effects, window) => { window.complete = false; }, /complete same-clock/],
    ['wrong clock', (_effects, window) => { window.clock = 'wall-clock'; }, /complete same-clock/],
    ['missing product-only declaration', (_effects, window) => { delete window.productObserverOnly; }, /only this product observer/],
    ['direct control traffic', effects => { effects[0].role = 'direct-control'; }, /Direct comparison traffic/],
    ['incomplete request', effects => { effects[0].request.complete = false; }, /incomplete/],
    ['incomplete response', effects => { effects[0].response.complete = false; }, /incomplete/],
    ['wrong request accounting', effects => { effects[0].request.wireBytes++; }, /incomplete/],
    ['different observer', effects => { effects[0].observerId = 'another-observer'; }, /Mixed observers/],
    ['multiple request identities', effects => { effects.push(statusEffect({ path: '/' + endpoint + '/requests/another/status' })); }, /Multiple request identities/],
    ['exchange before window', effects => { effects[0].atMs = 999; }, /outside/],
    ['exchange after window', effects => { effects[0].response.completedMs = 11001; }, /outside/],
  ];
  for (const [label, mutate, reason] of cases) await t.test(label, async () => {
    const effects = [statusEffect()], window = observerWindow(1); mutate(effects, window); window.effectEndIndex = effects.length;
    assertMissing(await collect([names.rate], { snapshot: { effects }, before: { observerWindow: window } }), names.rate, reason);
  });
});

test('terminal loss requires protected received bytes and actual durable attempt/candidate reads', async () => {
  const fixture = terminalFixture();
  const result = await collect([names.terminal], fixture.options);
  assert.deepEqual(result.measurements, { [names.terminal]: 0 }); assert.deepEqual(result.missing, []);
  assert.deepEqual(fixture.calls, [['queueRecovery', jobId, attemptId], ['candidateView', jobId, attemptId]]);
  const proof = result.evidence.find(item => item.kind === 'terminal-projection-check');
  assert.equal(proof.expected, 'completed'); assert.deepEqual(proof.attempt, fixture.recovery.attempt); assert.deepEqual(proof.observation, fixture.view.observation);
  delete fixture.options.snapshot.controlReads;
  fixture.options.before.terminalChallenge.retainedResponses = [fixture.read];
  assert.equal((await collect([names.terminal], fixture.options)).measurements[names.terminal], 0, 'challenge can carry the matching receipt directly');
  fixture.recovery.attempt.hold = true;
  assert.equal((await collect([names.terminal], fixture.options)).measurements[names.terminal], 1);
  fixture.recovery.attempt.hold = false; fixture.view.observation.phase = 'retrieval-pending';
  assert.equal((await collect([names.terminal], fixture.options)).measurements[names.terminal], 1);
});

test('server terminal writes alone or mismatched protected receipts cannot report terminal success', async t => {
  const cases = [
    ['missing receipt', fixture => { delete fixture.options.snapshot.controlReads; }],
    ['incomplete receipt', fixture => { fixture.read.receipt.outcome = 'incomplete'; }],
    ['wrong HTTP status', fixture => { fixture.read.receipt.status = 503; }],
    ['wrong job', fixture => { fixture.read.jobId = 'other_job'; }],
    ['wrong attempt', fixture => { fixture.read.attemptId = 'other_attempt'; }],
    ['wrong read kind', fixture => { fixture.read.kind = 'result'; }],
    ['wrong received digest', fixture => { fixture.read.receipt.sha256 = hash('different'); }],
    ['wrong received length', fixture => { fixture.read.receipt.receivedBytes = '1'; }],
    ['wrong retained attempt', fixture => { fixture.read.receipt.evidence.attemptId = 'other_attempt'; }],
    ['wrong retained direction', fixture => { fixture.read.receipt.evidence.direction = 'request'; }],
    ['incomplete retained bytes', fixture => { fixture.read.receipt.evidence.completeness = 'partial'; }],
    ['missing protected record', fixture => { delete fixture.read.receipt.evidence.recordId; }],
    ['wrong retained digest', fixture => { fixture.read.receipt.evidence.sha256 = hash('different'); }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const fixture = terminalFixture(); mutate(fixture);
    assertMissing(await collect([names.terminal], fixture.options), names.terminal);
    assert.deepEqual(fixture.calls, [], 'unproven delivery must not pass through to the durable comparison');
  });
  const fixture = terminalFixture(); fixture.recovery.attempt.requestId = 'other_request';
  assertMissing(await collect([names.terminal], fixture.options), names.terminal);
});

test('cache probe performs public repeated metadata/integrity/content reads and counts only newly added image GETs', async () => {
  const fixture = cacheFixture(), result = await collect([names.fetches, names.identity], fixture.options);
  assert.deepEqual(result.measurements, { [names.fetches]: 2, [names.identity]: 0 }); assert.deepEqual(result.missing, []);
  assert.deepEqual(fixture.calls, [['snapshot', endpoint], ['assetProjection', 'asset_1'], ['assetProjection', 'asset_1'],
    ['assetVerify', 'asset_1'], ['assetContent', 'asset_1', 'verified_handle', '0', 1], ['assetRelease', 'verified_handle'], ['snapshot', endpoint]]);
  assert.equal(fixture.phases.length, 1); assert.equal(fixture.phases[0].name, 'asset.cache-lookup');
  assert(fixture.phases[0].durationMs >= 0);
  const proof = result.evidence.find(item => item.kind === 'owned-asset-reuse-probe');
  assert.equal(proof.effectStartIndex, 1); assert.equal(proof.effectEndIndex, 5); assert.deepEqual(proof.verified, fixture.values.verified);
});

test('cache identity compares complete owned assets including metadata outside the blob', async () => {
  const fixture = cacheFixture(); fixture.values.second.label = 'changed'; fixture.values.verified.generation = '2';
  const result = await collect([names.identity], fixture.options);
  assert.deepEqual(result.measurements, { [names.identity]: 2 }); assert.deepEqual(result.missing, []);
  assert.equal(fixture.calls.filter(call => call[0] === 'assetRelease').length, 1);
});

test('cache verification releases its handle when content or verified identity checks fail', async t => {
  for (const [label, mutate] of [
    ['content failure', fixture => { fixture.values.error = 'content read failed'; }],
    ['short content', fixture => { fixture.values.bytes = Buffer.alloc(0); }],
    ['wrong verified asset', fixture => { fixture.values.verified.id = 'foreign_asset'; }],
  ]) await t.test(label, async () => {
    const fixture = cacheFixture(); mutate(fixture);
    const result = await collect([names.fetches, names.identity], fixture.options);
    assertMissing(result, names.fetches); assertMissing(result, names.identity);
    assert.deepEqual(fixture.calls.filter(call => call[0] === 'assetRelease'), [['assetRelease', 'verified_handle']]);
  });
  const fixture = cacheFixture(); fixture.snapshots[1].effects[0].path = '/image/changed-history/0';
  const result = await collect([names.fetches, names.identity], fixture.options);
  assertMissing(result, names.fetches, /prefix changed/); assertMissing(result, names.identity, /prefix changed/);
  assert.equal(fixture.calls.filter(call => call[0] === 'assetRelease').length, 1);
});

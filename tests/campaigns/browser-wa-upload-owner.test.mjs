import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {resolveAdapterUploadModules} from '../adapter-upload-module.mjs';
import {
  analyzeWAUploads, analyzeBrowserWAObservation, waExecutableBinding,
  readVerifiedBrowserWA, verifyRetainedBrowserWAObservation, verifyBrowserWALifecycle, WA_BROWSER_SCOPE, WA_OPAQUE_PATH_SOURCE_PINS,
} from '../../tooling/qualification/campaigns/browser-wa-observation.mjs';
import {evaluateAdapterLifecycle, deriveAdapterLifecycleMeasurements} from '../../tooling/qualification/campaigns/metrics.mjs';

// These URLs execute the real source producer, SHA256 and ownership modules
// when the registered integration suite runs. No summary flags are supplied to
// the producer. The smaller specimen tests arithmetic, not the fixed WA gate.
const modules = await resolveAdapterUploadModules({identity: 'wa-consumer-upload-owner'});
const {AdapterUploadObservations} = await import(modules.adapterUploadURL);
const {DiagnosticMemory} = await import(modules.diagnosticMemoryURL);
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const owner = Object.freeze({sessionId: 'wa-private-session', draftSessionId: 'wa-private-draft', documentId: 'wa-private-document', documentEpoch: 3, editorEpoch: 7, clientId: 'wa-private-client'});
const clone = structuredClone;
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const read = observations => {const result = observations.readSnapshot(); try {return clone(result.value);} finally {result.release();}};
const run = value => analyzeWAUploads(value.before, value.afterImport, value.after, value.selected);
const reject = (value, reason) => {const result = run(value); assert.equal(result.complete, false); assert.ok(result.missing.includes(reason), JSON.stringify(result)); return result;};
const observations = (t, capacity = 16) => {const value = new AdapterUploadObservations(capacity, new DiagnosticMemory()); t.after(() => value.dispose()); return value;};
function payload(length) {const value = Buffer.alloc(length); for (let i = 0; i < length; i++) value[i] = (i * 29 + 17) % 251; return value;}
function specimens(provenance = true) {
  const entries = [
    ['adapter-weights', payload(1048576 + 131), 'application/octet-stream'],
    ['adapter-config', Buffer.from('{"rank":4,"alpha":8}'), 'application/json'],
    ...(provenance ? [['adapter-provenance', Buffer.from('private provenance reference'), 'text/plain']] : []),
  ].map(([role, bytes, type]) => ({role, bytes, file: new File([bytes], role + '.private', {type}), ref: {hash: digest(bytes), byteLength: String(bytes.length), mediaType: type}}));
  return {entries, selected: {versionId: 'actual-import-version', weights: entries[0].ref, config: entries[1].ref, provenance: entries[2]?.ref ?? null,
    weightsAssetId: 'weights-asset', configAssetId: 'config-asset', provenanceAssetId: entries[2] ? 'provenance-asset' : null}};
}
function upload(observed, entry, transport, {controller = new AbortController(), identity = owner} = {}) {
  return observed.bind(entry.file, entry.role)({file: entry.file, purpose: entry.role === 'adapter-weights' ? 'adapter' : 'caption', mediaType: entry.file.type,
    transport, owner: identity, signal: controller.signal, check: () => controller.signal.throwIfAborted(), tick: () => Promise.resolve()});
}
function json(response, status, value) {const bytes = Buffer.from(JSON.stringify(value)); response.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': String(bytes.length)}); response.end(bytes);}

// The server independently consumes the actual HTTP bodies and supplies the
// product's staging acknowledgements. Request/response doubles cannot produce
// the positive analyzer fixture. Literal loopback preserves the no-egress guard.
async function staging(t, {beforeAck, skipWeightsTail = false} = {}) {
  const requests = [], records = new Map(), errors = [], tasks = new Set(); let ordinal = 0;
  const server = createServer((request, response) => {
    const task = (async () => {
      const chunks = []; let count = 0;
      for await (const chunk of request) {count += chunk.length; assert.ok(count <= 1048576); chunks.push(chunk);}
      const entry = {method: request.method, path: request.url, offset: request.headers['upload-offset'] ?? null, bytes: Buffer.concat(chunks)}; requests.push(entry);
      if (entry.method === 'POST' && entry.path === '/api/v1/assets/staging') {
        const create = JSON.parse(entry.bytes.toString('utf8')); assert.equal(create.protocolVersion, 1); assert.equal(records.has(create.stagingId), false);
        assert.match(create.sha256, /^sha256:[a-f0-9]{64}$/); assert.match(create.expectedBytes, /^[1-9][0-9]*$/);
        const record = {...create, ownerClientId: owner.clientId, version: '1', committedOffset: '0', state: 'receiving'};
        records.set(create.stagingId, record); json(response, 201, record); return;
      }
      const match = /^\/api\/v1\/assets\/staging\/([A-Za-z0-9_-]+)$/.exec(entry.path ?? ''); assert.ok(match);
      const record = records.get(match[1]); assert.ok(record);
      if (entry.method === 'GET') {assert.equal(entry.bytes.length, 0); json(response, 200, record); return;}
      assert.equal(entry.method, 'PUT'); assert.equal(entry.offset, record.committedOffset); assert.ok(entry.bytes.length > 0);
      await beforeAck?.({entry, record, ordinal: ++ordinal}); if (response.destroyed) return;
      const next = skipWeightsTail && record.purpose === 'adapter' ? Number(record.expectedBytes) : Number(record.committedOffset) + entry.bytes.length;
      assert.ok(next <= Number(record.expectedBytes)); record.committedOffset = String(next); record.version = String(Number(record.version) + 1);
      record.state = record.committedOffset === record.expectedBytes ? 'complete' : 'receiving'; json(response, 200, record);
    })().catch(error => {errors.push(error); if (!response.destroyed) {if (response.headersSent) response.destroy(); else json(response, 500, {error: {code: 'FIXTURE_ERROR'}});}});
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', () => {server.off('error', reject); resolve();});});
  const address = server.address(); assert.equal(address.address, '127.0.0.1'); const origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => {await new Promise((resolve, reject) => {server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();}); await Promise.all(tasks); assert.deepEqual(errors, []);});
  return {requests, records, transport: (path, init) => {
    assert.match(path, /^\/api\/v1\/assets\/staging(?:\/[A-Za-z0-9_-]+)?$/);
    return fetch(origin + path, {...init, signal: AbortSignal.any(init?.signal ? [init.signal, t.signal] : [t.signal]), redirect: 'error'});
  }};
}
async function imported(t, {provenance = true, priorUpload = false, capacity = 16, skipWeightsTail = false, ownerFor = () => owner} = {}) {
  const observed = observations(t, capacity), http = await staging(t, {skipWeightsTail}), fixture = specimens(provenance);
  if (priorUpload) {const prior = await upload(observed, fixture.entries[1], http.transport); prior.release();}
  const before = read(observed);
  for (const entry of fixture.entries) {const result = await upload(observed, entry, http.transport, {identity: ownerFor(entry.role)}); result.release();}
  return {...fixture, observed, http, before, afterImport: read(observed), after: read(observed)};
}
function changedTranscript(fixture, mutate) {
  const value = {before: clone(fixture.before), afterImport: clone(fixture.afterImport), after: clone(fixture.after), selected: clone(fixture.selected)};
  mutate(value.afterImport.operations[0], value.afterImport); value.after = clone(value.afterImport); return value;
}

test('analyzer accepts real File/SHA256/HTTP transcripts for each selected role within the explicit opaque-upload scope', {timeout: 15000}, async t => {
  const fixture = await imported(t), saved = clone([fixture.before, fixture.afterImport, fixture.after]), result = run(fixture);
  assert.equal(result.complete, true); assert.deepEqual(result.missing, []); assert.deepEqual(result.failures, []);
  assert.deepEqual(result.operations.map(row => row.role), ['adapter-weights', 'adapter-config', 'adapter-provenance']);
  assert.equal(fixture.after.globalCoverageComplete, false); assert.equal(fixture.after.scope, 'ownedUpload-opaque-hash-and-transfer');
  assert.equal(WA_BROWSER_SCOPE, 'reviewed-selected-file-opaque-upload-and-owned-application-http-1');
  assert.equal(result.operations[0].hash.chunks, 17); assert.equal(result.operations[0].transfer.chunks, 2);
  for (const [index, row] of result.operations.entries()) {
    const expected = fixture.entries[index], puts = fixture.http.requests.filter(request => request.method === 'PUT' && request.path.endsWith('/' + row.stagingId));
    assert.deepEqual(Buffer.concat(puts.map(request => request.bytes)), expected.bytes); assert.equal(row.hash.sha256, digest(expected.bytes));
    assert.equal(fixture.http.records.get(row.stagingId).sha256, expected.ref.hash); assert.equal(row.transfer.lastCommittedOffset, expected.ref.byteLength);
  }
  assert.deepEqual([fixture.before, fixture.afterImport, fixture.after], saved, 'analysis must not mutate detached producer snapshots');
  result.operations[0].hash.sha256 = digest('mutated returned analysis'); assert.deepEqual([fixture.before, fixture.afterImport, fixture.after], saved);
});

test('cycle cursors exclude earlier real uploads and optional provenance is an exact two-file inventory', {timeout: 15000}, async t => {
  const fixture = await imported(t, {provenance: false, priorUpload: true}), result = run(fixture);
  assert.equal(fixture.before.sequence, 1); assert.equal(fixture.after.sequence, 3); assert.equal(result.complete, true);
  assert.deepEqual(result.operations.map(row => [row.sequence, row.role]), [[2, 'adapter-weights'], [3, 'adapter-config']]);
});

test('missing boundaries, reset cursors, realm drift, drops and invalid observations cannot establish coverage', {timeout: 15000}, async t => {
  const fixture = await imported(t);
  for (const [label, mutate, reason] of [
    ['before absent', value => {value.before = null;}, 'opaque-upload-producer-boundary-unavailable'],
    ['after import absent', value => {value.afterImport = null;}, 'opaque-upload-producer-boundary-unavailable'],
    ['after absent', value => {value.after = null;}, 'opaque-upload-producer-boundary-unavailable'],
    ['overflow', value => {value.after.overflow = true;}, 'opaque-upload-producer-boundary-unavailable'],
    ['unsettled boundary', value => {value.after.active = 1;}, 'opaque-upload-producer-boundary-unavailable'],
    ['realm changed', value => {value.after.realmId += '-other';}, 'opaque-upload-realm-sequence-or-selection-read-coverage'],
    ['cursor reset', value => {value.after.sequence = 0;}, 'opaque-upload-realm-sequence-or-selection-read-coverage'],
    ['dropped row', value => {value.after.dropped++;}, 'opaque-upload-realm-sequence-or-selection-read-coverage'],
    ['invalid read', value => {value.after.invalid++;}, 'opaque-upload-realm-sequence-or-selection-read-coverage'],
  ]) await t.test(label, () => {const value = {before: clone(fixture.before), afterImport: clone(fixture.afterImport), after: clone(fixture.after), selected: clone(fixture.selected)}; mutate(value); reject(value, reason);});
});

test('selected digest, length, exact role, stage and operation identity must match the actual imported files', {timeout: 15000}, async t => {
  const fixture = await imported(t);
  for (const [label, mutate] of [
    ['weights digest', value => {value.selected.weights.hash = digest('other weights');}],
    ['config bytes', value => {value.selected.config.byteLength = String(Number(value.selected.config.byteLength) + 1);}],
    ['provenance digest', value => {value.selected.provenance.hash = digest('other provenance');}],
  ]) await t.test(label, () => {const value = {...fixture, selected: clone(fixture.selected)}; mutate(value); const result = run(value); assert.equal(result.complete, false); assert.ok(result.failures.includes('opaque-upload-selected-file-digest-or-length-mismatch'));});
  for (const [label, mutate, reason = 'opaque-upload-file-lineage-or-operation-identity'] of [
    ['wrong role', row => {row.role = 'adapter-config';}], ['wrong purpose', row => {row.purpose = 'caption';}],
    ['wrong operation realm', row => {row.id = 'other:' + row.sequence;}, 'opaque-upload-malformed-operation'], ['missing stage', row => {row.stagingId = null;}],
    ['array coerces to stage ID text', row => {row.stagingId = [row.stagingId];}],
    ['duplicate stage', (row, value) => {value.operations[1].stagingId = row.stagingId;}],
  ]) await t.test(label, () => reject(changedTranscript(fixture, mutate), reason));
  const extra = {...fixture, selected: {...fixture.selected, provenance: null}}; reject(extra, 'opaque-upload-exact-selected-file-inventory');
});

test('hash, transfer and ACK transcripts require exact contiguous ranges and matching ordinal steps', {timeout: 15000}, async t => {
  const fixture = await imported(t);
  for (const [label, mutate] of [
    ['missing coverage reason', row => {row.missing.push('read-range-unavailable');}],
    ['retained read lease', row => {row.liveReads = 1;}], ['unsettled row', row => {row.settled = false;}],
    ['hash gap', row => {row.hash.runs[0].offset = 1;}], ['hash bound exceeded', row => {row.hash.runs[0].length = 65537;}],
    ['transfer truncation', row => {row.transfer.runs.pop();}], ['ack missing', row => {row.transfer.ackRuns.pop();}],
    ['ack count', row => {row.transfer.acks--;}], ['ack terminal', row => {row.transfer.lastState = 'receiving';}],
    ['ack gap', row => {row.transfer.ackRuns[0].from = '1';}],
    ['same total and count but swapped acknowledgement steps', row => {
      row.transfer.ackRuns = [{from: '0', to: '131', step: 131, count: 1}, {from: '131', to: String(1048576 + 131), step: 1048576, count: 1}];
    }],
  ]) await t.test(label, () => reject(changedTranscript(fixture, mutate), 'opaque-upload-complete-read-hash-ack-settlement'));
});

test('malformed null transcript members are unavailable rather than escaping the analyzer', {timeout: 15000}, async t => {
  const fixture = await imported(t);
  for (const [label, mutate] of [
    ['imported operation', value => {value.afterImport.operations[0] = null;}],
    ['retained operation', value => {value.after.operations[0] = null;}],
    ['hash run', value => {value.afterImport.operations[0].hash.runs[0] = null;}],
    ['transfer run', value => {value.afterImport.operations[0].transfer.runs[0] = null;}],
    ['ack run', value => {value.afterImport.operations[0].transfer.ackRuns[0] = null;}],
    ['before operation exceeds cursor', value => {value.before.operations.push(clone(value.afterImport.operations[0]));}],
    ['after operation exceeds cursor', value => {const row = clone(value.after.operations[0]); row.sequence = value.after.sequence + 1; row.id = value.after.realmId + ':' + row.sequence; value.after.operations.push(row);}],
    ['after repeats operation sequence', value => {value.after.operations.push(clone(value.after.operations[0]));}],
  ]) await t.test(label, () => {
    const value = {before: clone(fixture.before), afterImport: clone(fixture.afterImport), after: clone(fixture.after), selected: clone(fixture.selected)}; mutate(value);
    const result = run(value); assert.equal(result.complete, false); assert.ok(result.missing.length > 0);
  });
});

test('a real owner change between selected uploads loses one-owner lineage', {timeout: 15000}, async t => {
  const fixture = await imported(t, {ownerFor: role => role === 'adapter-config' ? {...owner, sessionId: 'another-private-session'} : owner});
  assert.notEqual(fixture.afterImport.operations[0].owner.sessionHash, fixture.afterImport.operations[1].owner.sessionHash);
  reject(fixture, 'opaque-upload-owner-changed');
  const arrayHashes = changedTranscript(fixture, (_row, value) => {for (const row of value.operations) row.owner.sessionHash = [digest(owner.sessionId)];});
  reject(arrayHashes, 'opaque-upload-owner-identity-unavailable');
});

test('a held real HTTP acknowledgement and then an abort cannot become a complete import', {timeout: 15000}, async t => {
  const observed = observations(t), entered = deferred(), acknowledgement = deferred(), controller = new AbortController();
  const http = await staging(t, {beforeAck: async () => {entered.resolve(); await acknowledgement.promise;}}), fixture = specimens(false), before = read(observed);
  const pending = upload(observed, fixture.entries[0], http.transport, {controller}); void pending.catch(() => {});
  try {
    await Promise.race([entered.promise, pending.then(() => {throw Error('Upload finished before held acknowledgement');})]);
    const active = read(observed); assert.equal(active.active, 1); assert.equal(active.operations[0].transfer.acks, 0);
    reject({before, afterImport: active, after: read(observed), selected: fixture.selected}, 'opaque-upload-producer-boundary-unavailable');
    controller.abort(); await assert.rejects(pending, error => error?.name === 'AbortError');
    const partial = read(observed); assert.equal(partial.active, 0); assert.equal(partial.operations[0].outcome, 'error');
    assert.ok(partial.operations[0].missing.includes('aborted'));
    reject({before, afterImport: partial, after: read(observed), selected: fixture.selected}, 'opaque-upload-complete-read-hash-ack-settlement');
  } finally {controller.abort(); acknowledgement.resolve(); await pending.then(value => value.release(), () => {});}
});

test('actual skipped transfer acknowledgements and retained-row eviction remain incomplete', {timeout: 15000}, async t => {
  await t.test('server skipped unread weights tail', async child => {
    const fixture = await imported(child, {skipWeightsTail: true}); assert.equal(fixture.afterImport.operations[0].outcome, 'complete');
    assert.ok(fixture.afterImport.operations[0].missing.includes('acknowledgement-discontinuity'));
    reject(fixture, 'opaque-upload-complete-read-hash-ack-settlement');
  });
  await t.test('producer retention dropped part of selected inventory', async child => {
    const fixture = await imported(child, {capacity: 2}); assert.equal(fixture.afterImport.dropped, 1);
    reject(fixture, 'opaque-upload-realm-sequence-or-selection-read-coverage');
  });
});

test('an actual extra file read after import and any changed settled transcript invalidate selection coverage', {timeout: 15000}, async t => {
  const fixture = await imported(t); assert.equal(run(fixture).complete, true);
  const request = await upload(fixture.observed, fixture.entries[1], fixture.http.transport); request.release();
  fixture.after = read(fixture.observed); reject(fixture, 'opaque-upload-realm-sequence-or-selection-read-coverage');
  const changed = {...fixture, after: clone(fixture.afterImport)}; changed.after.operations[0].owner.documentEpoch++;
  reject(changed, 'opaque-upload-settled-transcript-changed-during-selection');
});

function unapprovedIdentity() {
  const sourceFiles = [], buildFiles = [{path: 'dist/app/build-evidence.json', bytes: 1, sha256: digest('unreviewed build')}];
  return {sourceFiles, sourceDigest: digest(JSON.stringify(sourceFiles)).slice(7), buildFiles, buildDigest: digest(JSON.stringify(buildFiles)), toolsDigest: digest('test tools'), approved: true};
}
const cell = () => ({id: 'AH2/WA-lifecycle', host: 'H', handler: 'browser', kind: 'lifecycle', operation: 'adapter.lifecycle', workload: 'WA',
  parameters: {cycles: 2, idleMs: 30000, baselineIdleMs: 30000, bytes: 256 * 1048576, configBytesMax: 1048576}});

test('a real complete upload transcript never grants source, build or global tensor-decode authority by itself', {timeout: 15000}, async t => {
  const fixture = await imported(t), executableIdentity = unapprovedIdentity(), selectedCell = cell();
  assert.equal(run(fixture).complete, true); assert.equal(waExecutableBinding(executableIdentity), null);
  const expected = {cell: selectedCell, cycle: 1, processIdentity: 'test-process', fixtureIdentity: digest('test fixture'), executableIdentity, selected: fixture.selected};
  const raw = {kind: 'wa-browser-observation-1', scope: WA_BROWSER_SCOPE,
    binding: {cellId: selectedCell.id, cycle: 1, processIdentity: expected.processIdentity, fixtureIdentity: expected.fixtureIdentity, executable: null},
    selected: fixture.selected, uploads: {before: fixture.before, afterImport: fixture.afterImport, after: fixture.after}, network: {}, missing: []};
  const result = analyzeBrowserWAObservation(raw, expected); assert.equal(result.complete, false); assert.equal(result.uploads.complete, true);
  assert.equal(result.assertions.noBrowserTensorDecode, null); assert.equal(result.assertions.zeroUnexpectedFetches, null);
  assert.ok(result.missing.includes('reviewed-opaque-path-and-imported-identity-required')); assert.deepEqual(result.measurements, []);
  const forged = clone(raw); forged.binding.executable = {approved: true, scope: WA_BROWSER_SCOPE, sourceDigest: executableIdentity.sourceDigest};
  const rejected = analyzeBrowserWAObservation(forged, expected); assert.equal(rejected.assertions.noBrowserTensorDecode, null);
  assert.ok(rejected.missing.includes('exact-H-WA-executable-cycle-fixture-binding'));
  for (const malformed of [{}, 1, 'caller omitted diagnostics', [null], Array(129).fill('reason'), ['x'.repeat(257)]]) {
    const changed = clone(raw); changed.missing = malformed;
    const unavailable = analyzeBrowserWAObservation(changed, expected); assert.equal(unavailable.complete, false);
    assert.ok(unavailable.missing.includes('producer-missing-inventory-unavailable'), 'malformed raw diagnostics must add an explicit unavailable reason');
  }
});

test('unverified H lifecycle semantic flags and zero-fetch metric receipts cannot bypass private retained-replay authority', () => {
  const selectedCell = cell(), processIdentity = 'unverified-process', fixtureIdentity = digest('unverified fixture');
  const names = ['T06UnchangedOwnedAssetFetches', 'R32UnchangedOwnedAssetFetches', 'R32CacheIdentityMismatchCount'];
  selectedCell.requiredMeasurements = names.map(name => ({name, budgetId: name.startsWith('T06') ? 'T06' : 'R32', unit: name.endsWith('MismatchCount') ? 'violations' : 'count', ceiling: 0}));
  const raw = {profile: 'P-A', processIdentity, fixtureIdentity, weightsIdentity: digest('weights'), configIdentity: digest('config'), forcedGC: false, processRestarted: false,
    // These deliberately forged rows are negative fixtures, not observations.
    cycles: [1, 2].map(ordinal => ({ordinal, processIdentity, fixtureIdentity, action: {
      assertions: {fixedArtifactsImported: true, selectionRestored: true, durableFixturePreserved: true, noBrowserTensorDecode: true, zeroUnexpectedFetches: true},
      observations: {browserWA: {analysis: {complete: true, assertions: {noBrowserTensorDecode: true, zeroUnexpectedFetches: true}}}},
      measurements: selectedCell.requiredMeasurements.map(rule => ({name: rule.name, value: 0, unit: rule.unit, complete: true, method: 'forged caller approval',
        evidence: {kind: 'lifecycle-measurement-evidence-1', coverage: 'complete-cycle-actions', cellId: selectedCell.id, cycleOrdinal: ordinal, processIdentity, fixtureIdentity,
          artifact: {path: '/unread/caller-supplied.json', bytes: 1, sha256: digest('not retained replay')}}})),
    }}))};
  assert.equal(readVerifiedBrowserWA(raw, selectedCell), null); assert.equal(readVerifiedBrowserWA(clone(raw), clone(selectedCell)), null);
  const evaluation = evaluateAdapterLifecycle(raw, {cell: selectedCell}); assert.notEqual(evaluation.outcome, 'PASS');
  assert.ok(evaluation.missing.includes('WA:noBrowserTensorDecode')); assert.ok(evaluation.missing.includes('WA:zeroUnexpectedFetches'));
  const metrics = deriveAdapterLifecycleMeasurements(raw, {cell: selectedCell}); assert.deepEqual(metrics.measurements, []);
  assert.deepEqual(metrics.unavailable.map(row => row.name), names);
});

// These source/build identities are test metadata for the scoped retained-byte
// verifier. They do not attest an actual built browser or the fixed WA workload;
// that admission remains exclusively in verifyBrowserWALifecycle.
function reviewedTestIdentity() {
  const sourceFiles = WA_OPAQUE_PATH_SOURCE_PINS.map(({path, bytes, sha256}) => ({path, bytes, sha256: sha256.slice(7)}));
  const buildBytes = Buffer.from('{"fixture":"scoped-retained-byte-unit-metadata-only"}');
  const buildFiles = [{path: 'dist/app/build-evidence.json', bytes: buildBytes.length, sha256: digest(buildBytes)}];
  return {sourceFiles, sourceDigest: digest(JSON.stringify(sourceFiles)).slice(7), buildFiles, buildDigest: digest(JSON.stringify(buildFiles)), toolsDigest: digest('scoped verifier test tools')};
}
function retainedUpload(fixture) {
  const executableIdentity = reviewedTestIdentity(), selectedCell = cell(), executable = waExecutableBinding(executableIdentity);
  assert.ok(executable, 'the test uses the exact reviewed source pin metadata');
  const expected = {cell: selectedCell, cycle: 1, processIdentity: 'scoped-test-process-only', fixtureIdentity: digest('scoped test fixture'), executableIdentity, selected: clone(fixture.selected)};
  const raw = {kind: 'wa-browser-observation-1', scope: WA_BROWSER_SCOPE,
    binding: {cellId: selectedCell.id, cycle: expected.cycle, processIdentity: expected.processIdentity, fixtureIdentity: expected.fixtureIdentity, executable},
    selected: clone(fixture.selected), uploads: {before: clone(fixture.before), afterImport: clone(fixture.afterImport), after: clone(fixture.after)}, network: {}, missing: []};
  const bytes = Buffer.from(JSON.stringify(raw) + '\n'), artifact = {path: '/owned-test/retained-wa-observation.json', bytes: bytes.length, sha256: digest(bytes)};
  return {expected, raw, artifact, bytes, readRetained: async path => {assert.equal(path, artifact.path); return Buffer.from(bytes);}};
}

test('retained replay accepts actual upload producer bytes only for its explicit scope and grants no lifecycle authority', {timeout: 15000}, async t => {
  const fixture = await imported(t), input = retainedUpload(fixture), value = await verifyRetainedBrowserWAObservation(input);
  assert.equal(value.analysis.authenticated, true); assert.equal(value.analysis.scope, WA_BROWSER_SCOPE);
  assert.equal(value.analysis.uploads.complete, true); assert.equal(value.analysis.assertions.noBrowserTensorDecode, true);
  assert.equal(value.analysis.network.complete, false); assert.equal(value.analysis.assertions.zeroUnexpectedFetches, null);
  assert.equal(value.analysis.complete, false); assert.ok(value.analysis.missing.length > 0); assert.deepEqual(value.analysis.measurements, []);
  assert.deepEqual(value.raw, input.raw); assert.deepEqual(value.analysis.uploads.operations, fixture.afterImport.operations);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.raw.uploads.afterImport.operations)); assert.ok(Object.isFrozen(value.analysis.uploads.operations[0]));
  assert.throws(() => {value.analysis.uploads.operations[0].bytes++;}, TypeError);
  assert.equal(readVerifiedBrowserWA(value, input.expected.cell), null); assert.equal(readVerifiedBrowserWA(value.analysis, input.expected.cell), null);
  assert.equal(value.raw.selected.weights.byteLength, String(1048576 + 131), 'this small specimen is never the 256MiB qualifying workload');
});

test('retained replay rejects wrong byte identity, malformed UTF8/JSON and mutated expected or artifact bindings', {timeout: 15000}, async t => {
  const fixture = await imported(t), source = retainedUpload(fixture);
  await t.test('length mismatch', async () => {
    await assert.rejects(verifyRetainedBrowserWAObservation({...source, artifact: {...source.artifact, bytes: source.artifact.bytes + 1}}), /H-WA retained observation length differs/);
  });
  await t.test('digest mismatch', async () => {
    await assert.rejects(verifyRetainedBrowserWAObservation({...source, artifact: {...source.artifact, sha256: digest('different bytes')}}), /H-WA retained observation digest differs/);
  });
  await t.test('bounded artifact required before reading', async () => {
    let reads = 0;
    await assert.rejects(verifyRetainedBrowserWAObservation({...source, artifact: {...source.artifact, bytes: 16 * 1048576 + 1}, readRetained: async () => {reads++; return source.bytes;}}), /H-WA retained observation identity unavailable/);
    assert.equal(reads, 0);
  });
  for (const [label, bytes] of [['malformed UTF8', Buffer.concat([Buffer.from('{"kind":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])], ['truncated JSON', Buffer.from('{"kind":')], ['JSON trailer', Buffer.from('{} trailer')]]) {
    await t.test(label, async () => {
      const artifact = {...source.artifact, bytes: bytes.length, sha256: digest(bytes)};
      await assert.rejects(verifyRetainedBrowserWAObservation({...source, artifact, readRetained: async () => Buffer.from(bytes)}));
    });
  }
  for (const [label, mutate, message] of [
    ['expected binding changes during read', input => {input.expected.cycle++;}, /H-WA expected binding changed during retained replay/],
    ['artifact identity changes during read', input => {input.artifact.path += '-changed';}, /H-WA artifact identity changed during retained replay/],
  ]) await t.test(label, async () => {
    const input = retainedUpload(fixture), entered = deferred(), release = deferred();
    const pending = verifyRetainedBrowserWAObservation({...input, readRetained: async path => {assert.equal(path, input.artifact.path); entered.resolve(); await release.promise; return Buffer.from(input.bytes);}});
    void pending.catch(() => {});
    try {await Promise.race([entered.promise, pending.then(() => {throw Error('Replay completed before held read');})]); mutate(input); release.resolve(); await assert.rejects(pending, message);}
    finally {release.resolve(); await pending.catch(() => {});}
  });
});

test('missing retained cycle artifacts get private incomplete rows only for the unchanged original result and bound cell', async () => {
  const fixtureIdentity = digest('actual incomplete fixture seal'), fixture = {seal: {sha256: fixtureIdentity}, documentId: owner.documentId};
  const makeResult = () => ({profile: 'P-A', fixtureIdentity, processIdentity: 'incomplete-owned-process', weightsIdentity: digest('weights'), configIdentity: digest('config'),
    cycles: [1, 2].map(ordinal => ({ordinal, action: {observations: {browserWA: null}}}))});
  let reads = 0;
  const verify = (result, selectedCell, selectedFixture = fixture) => verifyBrowserWALifecycle({cell: selectedCell, result, fixture: selectedFixture,
    executableIdentity: reviewedTestIdentity(), runtimePath: '/never-read/incomplete-runtime.json', readRetained: async () => {reads++; throw Error('A missing-artifact cycle must not read runtime or evidence');}});
  const result = makeResult(), selectedCell = cell(), cycles = await verify(result, selectedCell);
  assert.equal(reads, 0); assert.equal(readVerifiedBrowserWA(result, selectedCell), cycles); assert.ok(Object.isFrozen(cycles));
  assert.deepEqual(cycles.map(row => row.ordinal), [1, 2]);
  for (const row of cycles) {
    assert.ok(Object.isFrozen(row)); assert.notEqual(row.authenticated, true); assert.notEqual(row.complete, true);
    assert.deepEqual(row.assertions, {noBrowserTensorDecode: null, zeroUnexpectedFetches: null}); assert.deepEqual(row.measurements, []);
    assert.deepEqual(row.missing, ['retained-H-WA-observation-unavailable']);
  }
  assert.equal(readVerifiedBrowserWA(clone(result), selectedCell), null);
  result.cycles[0].action.observations.callerChanged = true; assert.equal(readVerifiedBrowserWA(result, selectedCell), null);
  const second = makeResult(), secondCell = cell(); await verify(second, secondCell); secondCell.parameters.bytes--;
  assert.equal(readVerifiedBrowserWA(second, secondCell), null);
  const foreign = makeResult(); await assert.rejects(verify(foreign, cell(), {seal: {sha256: digest('other fixture')}, documentId: owner.documentId}), /H-WA result differs from consumed fixture/);
  assert.equal(readVerifiedBrowserWA(foreign, cell()), null); assert.equal(reads, 0);
});

test('full verifier binds the outer observation window and network engine before later runtime admission', {timeout: 15000}, async t => {
  const producer = await imported(t), retained = retainedUpload(producer);
  // Actual small-upload evidence reaches these early joins. The minimal runtime
  // metadata is deliberately insufficient for later worker/runtime admission;
  // even the unchanged fixture must reject rather than qualify a full H run.
  const runtimePath = '/owned-test/window-join-runtime.json', runtime = {engine: 'chromium', testScope: 'early-window-join-only'};
  const selected = retained.expected.selected;
  const importedValue = {asset: {adapter: {origin: {original: clone(selected.provenance)}, sources: {
    weightsAssetId: selected.weightsAssetId, configAssetId: selected.configAssetId, provenanceAssetId: selected.provenanceAssetId,
  }}}, binding: {binding: {versionId: selected.versionId, weights: clone(selected.weights), config: clone(selected.config)}}};
  for (const [label, mutate, message, runtimeRead] of [
    ['intact early joins reach the later worker-owner guard', () => {}, /H-WA proxy belongs to another worker/, true],
    ['missing outer ID', raw => {delete raw.id;}, /H-WA outer observation identity unavailable/, false],
    ['malformed outer ID', raw => {raw.id = 'another window';}, /H-WA outer observation identity unavailable/, false],
    ['overlong outer ID', raw => {raw.id = 'x'.repeat(129);}, /H-WA outer observation identity unavailable/, false],
    ['array cannot coerce to an outer ID', raw => {raw.id = [raw.id];}, /H-WA outer observation identity unavailable/, false],
    ['foreign browser window', raw => {raw.network.browser.observation.id = 'foreign-window';}, /H-WA browser observation belongs to another window/, false],
    ['foreign proxy window', raw => {raw.network.proxy.id = 'foreign-window';}, /H-WA proxy observation belongs to another window/, false],
    ['network engine differs from retained runtime', raw => {raw.network.binding.engine = 'firefox';}, /H-WA network observer engine differs from retained runtime/, true],
  ]) await t.test(label, async () => {
    const raw = clone(retained.raw); raw.id = 'actual-upload-window'; raw.binding.runtime = clone(runtime);
    raw.network = {binding: {engine: 'chromium'}, browser: {observation: {id: raw.id}}, proxy: {id: raw.id}}; mutate(raw);
    const bytes = Buffer.from(JSON.stringify(raw) + '\n'), artifact = {path: '/owned-test/window-join-observation.json', bytes: bytes.length, sha256: digest(bytes)};
    const selectedCell = clone(retained.expected.cell), result = {profile: 'P-A', processIdentity: retained.expected.processIdentity, fixtureIdentity: retained.expected.fixtureIdentity,
      weightsIdentity: selected.weights.hash, configIdentity: selected.config.hash,
      cycles: [{ordinal: 1, action: {observations: {browserWA: {artifact}, imported: clone(importedValue)}}}]};
    const reads = [], args = {cell: selectedCell, result, fixture: {seal: {sha256: result.fixtureIdentity}, documentId: owner.documentId},
      executableIdentity: clone(retained.expected.executableIdentity), workerProcessIdentity: {pid: 32199}, runtimePath,
      readRetained: async path => {reads.push(path); if (path === artifact.path) return Buffer.from(bytes); assert.equal(path, runtimePath); return Buffer.from(JSON.stringify(runtime));}};
    assert.equal(readVerifiedBrowserWA(result, selectedCell), null);
    await assert.rejects(verifyBrowserWALifecycle(args), message);
    assert.deepEqual(reads, runtimeRead ? [artifact.path, runtimePath] : [artifact.path]);
    assert.equal(readVerifiedBrowserWA(result, selectedCell), null); assert.equal(readVerifiedBrowserWA(clone(result), selectedCell), null);
    assert.equal(raw.selected.weights.byteLength, String(1048576 + 131));
  });
});

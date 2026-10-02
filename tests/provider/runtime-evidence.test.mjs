import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storage } from './support.mjs';
import { emulator, SENTINEL_KEY } from './emulator.mjs';
import { egressAttempts } from './no-egress.mjs';
import { providerBoundary } from '../../dist/local/server/provider/client.js';
import { TransportEvidenceStore } from '../../dist/local/server/provider/evidence.js';
import * as transport from '../../dist/local/server/provider/transport.js';
import * as production from '../../dist/local/server/provider/index.js';
import { PRODUCTION_PROFILE, PRODUCTION_PRIVACY } from '../../dist/local/server/provider/production-profile.js';

// These are real loopback transfers. Their observed completion is fixture
// evidence only; this suite never manufactures successful production evidence.
const options = { timeout: 15_000 };
const payload = Buffer.from('{"request_id":"runtime_evidence_fixture","images":[]}');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const provenanceError = error => error?.code === 'PROVENANCE';
const absent = value => {
  assert.equal(Object.hasOwn(value, 'wireExecution'), false);
  assert.equal(Object.hasOwn(value, 'wireBodyIdentity'), false);
};

function owner(t) {
  const controller = new AbortController(), cleanup = [], pending = new Set();
  // Register cleanup before allocating a store, socket or transfer. Even a
  // failed mid-stream assertion first aborts and settles every owned transfer.
  t.after(async () => {
    controller.abort();
    await Promise.allSettled([...pending]);
    const errors = [];
    for (const close of cleanup.reverse()) try { await close(); } catch (error) { errors.push(error); }
    try { assert.deepEqual(egressAttempts(), []); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Runtime evidence fixture cleanup failed');
  });
  return {
    signal: controller.signal,
    after: close => cleanup.push(close),
    track(promise) {
      pending.add(promise);
      void promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    },
  };
}

async function receiver(scope, handler = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(payload);
}) {
  const sockets = new Set(), requests = [], errors = [];
  const server = http.createServer((req, res) => {
    const hash = createHash('sha256');
    const record = { method: req.method, url: req.url, bytes: 0, sha256: null };
    requests.push(record);
    req.on('error', () => {}); // Intentional truncation/cancellation is observed by the client.
    res.on('error', () => {});
    req.on('data', bytes => { record.bytes += bytes.length; hash.update(bytes); });
    req.on('end', () => {
      record.sha256 = hash.digest('hex');
      try { handler(req, res, record); } catch (error) { errors.push(error); res.destroy(); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  scope.after(async () => {
    const closedSockets = [...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)));
    const closedServer = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    await Promise.all([closedServer, ...closedSockets]);
    assert.equal(server.listening, false); assert.equal(sockets.size, 0);
    if (errors.length) throw new AggregateError(errors, 'Loopback receiver failed');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

function provider(f, overrides = {}) {
  return emulator({ queueOrigin: f.origin, mediaOrigin: f.origin, uploadOrigin: f.origin, ...overrides });
}
function attempt(s, requestId) {
  return { attemptId: s.attemptId, identity: { endpoint: 'ideogram/v4', ...(requestId ? { requestId } : {}) }, profileId: 'local-fixture-v1' };
}
function firstAppend(sink) {
  const seen = Promise.withResolvers(), append = sink.append.bind(sink);
  sink.append = bytes => { append(bytes); seen.resolve(); };
  return seen.promise;
}
async function beforeCompletion(observed, transfer) {
  await Promise.race([observed, transfer.then(() => { throw Error('Transfer completed before the required observation'); })]);
}
function assertExecution(s, body, patch) {
  const wire = body.wireExecution;
  assert.ok(wire, 'Actual completed transfer retains its wire provenance');
  assert.deepEqual(wire, {
    kind: 'provider-wire-provenance-1', boundary: 'loopback-fixture-1', role: 'media', method: 'GET',
    origin: patch.origin, pathname: patch.pathname, urlHash: 'sha256:' + sha(patch.url), httpStatus: 200,
    attemptId: s.attemptId, direction: 'response', recordId: body.recordId, completed: true,
    requestRecordId: null, requestSha256: null,
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'url')),
  });
  assert.deepEqual(s.store.inspect(body.recordId).wireExecution, wire);
  return wire;
}

test('wire provenance appears only at real response EOF and binds the observed result identity', options, async t => {
  const scope = owner(t), s = storage(scope); let response;
  const f = await receiver(scope, (_req, res) => {
    response = res; res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(payload.subarray(0, 7));
  });
  const sink = s.sink(), appended = firstAppend(sink), path = '/ideogram/v4/requests/runtime_evidence_fixture';
  const transfer = scope.track(provider(f).queue(attempt(s, 'runtime_evidence_fixture'), 'result', sink, undefined, undefined, scope.signal));
  await beforeCompletion(appended, transfer);
  const partial = s.store.inspect(sink.owner.recordId);
  assert.equal(partial.completeness, 'partial'); absent(partial);
  response.end(payload.subarray(7));
  const result = await transfer;
  assert.equal(result.outcome, 'complete'); assert.equal(result.failure, null);
  assert.equal(result.evidence.sha256, sha(payload)); assert.equal(result.evidence.receivedBytes, String(payload.length));
  assertExecution(s, result.evidence, { origin: f.origin, pathname: path, url: f.origin + path, role: 'result' });
  assert.deepEqual(Buffer.concat([...s.store.read(result.evidence.recordId)]), payload);
  assert.deepEqual(f.requests.map(r => [r.method, r.url]), [['GET', path]]);
});

test('interrupted and hash-failing transfers retain no request or response execution claim', options, async t => {
  const scope = owner(t), s = storage(scope); let interruptedResponse;
  const f = await receiver(scope, (req, res) => {
    if (req.url === '/ideogram/v4') {
      interruptedResponse = res; res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, 3));
    } else { res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload); }
  });
  const request = s.request('{"prompt":"fixture"}'), sink = s.sink(), appended = firstAppend(sink);
  const interrupted = scope.track(provider(f).queue(attempt(s), 'submit', sink, request, undefined, scope.signal));
  await beforeCompletion(appended, interrupted); interruptedResponse.destroy();
  const partial = await interrupted;
  assert.equal(partial.outcome, 'interrupted'); assert.equal(partial.evidence.completeness, 'partial');
  absent(partial.evidence); absent(s.store.inspect(partial.evidence.recordId)); absent(s.store.inspect(request.evidence.owner.recordId));
  const badHash = await scope.track(provider(f).media(f.origin + '/hash', s.sink(), { expectedHash: 'f'.repeat(64), signal: scope.signal }));
  assert.equal(badHash.outcome, 'interrupted'); assert.equal(badHash.failure, 'HASH');
  assert.equal(badHash.evidence.completeness, 'partial'); absent(badHash.evidence); absent(s.store.inspect(badHash.evidence.recordId));
  assert.equal(f.requests.length, 2, 'Neither failure retries or fabricates another exchange');
});

test('a successful resumed stream has exact retained bytes but no single-exchange execution claim', options, async t => {
  const scope = owner(t), s = storage(scope); let firstResponse;
  const f = await receiver(scope, (req, res) => {
    if (req.headers.range) {
      res.writeHead(206, { 'Content-Length': payload.length - 3, 'Content-Range': `bytes 3-${payload.length - 1}/${payload.length}`, ETag: '"fixture-v1"' });
      res.end(payload.subarray(3));
    } else {
      firstResponse = res; res.writeHead(200, { 'Content-Length': payload.length, ETag: '"fixture-v1"' }); res.write(payload.subarray(0, 3));
    }
  });
  const sink = s.sink(), appended = firstAppend(sink), p = provider(f), url = f.origin + '/range';
  const pending = scope.track(p.media(url, sink, { signal: scope.signal }));
  await beforeCompletion(appended, pending); firstResponse.destroy(); const first = await pending;
  assert.equal(first.outcome, 'interrupted'); assert.equal(first.storedBytes, '3'); absent(first.evidence);
  const resumed = s.store.resume(first.evidence.recordId, s.reservation());
  const result = await scope.track(p.media(url, resumed, { resume: { offset: 3n, etag: '"fixture-v1"', total: BigInt(payload.length) }, expectedHash: sha(payload), signal: scope.signal }));
  assert.equal(result.outcome, 'complete'); assert.equal(result.status, 206); assert.equal(result.sha256, sha(payload));
  absent(result.evidence); absent(s.store.inspect(result.evidence.recordId));
  assert.deepEqual(Buffer.concat([...s.store.read(result.evidence.recordId)]), payload);
  assert.equal(f.requests.length, 2);
});

test('pre-dispatch small request capture gains matching request and response identities only after wire completion', options, async t => {
  const scope = owner(t), s = storage(scope); let received = Promise.withResolvers(), response;
  const f = await receiver(scope, (_req, res, record) => { response = res; received.resolve(record); });
  const request = s.request('{"prompt":"exact reviewed fixture"}'), requestHash = sha(request.bytes), sink = s.sink();
  const pending = scope.track(provider(f).queue(attempt(s), 'submit', sink, request, undefined, scope.signal));
  const captured = s.store.inspect(request.evidence.owner.recordId);
  assert.equal(captured.completeness, 'complete'); assert.equal(captured.sha256, requestHash); absent(captured);
  await beforeCompletion(received.promise, pending);
  absent(s.store.inspect(captured.recordId)); absent(s.store.inspect(sink.owner.recordId));
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(payload);
  const result = await pending, requestBody = s.store.inspect(captured.recordId);
  assert.equal(result.outcome, 'complete'); assert.equal(f.requests[0].sha256, requestHash);
  const common = { origin: f.origin, pathname: '/ideogram/v4', url: f.origin + '/ideogram/v4', role: 'submit', method: 'POST', requestRecordId: captured.recordId, requestSha256: 'sha256:' + requestHash };
  assertExecution(s, requestBody, { ...common, direction: 'request' });
  assertExecution(s, result.evidence, common);

  received = Promise.withResolvers();
  const changedRequest = s.request('{"prompt":"closed capture mutation"}'), changedSink = s.sink();
  const changedTransfer = scope.track(provider(f).queue(attempt(s), 'submit', changedSink, changedRequest, undefined, scope.signal));
  await beforeCompletion(received.promise, changedTransfer);
  const retainedRequest = s.store.inspect(changedRequest.evidence.owner.recordId);
  assert.equal(retainedRequest.completeness, 'complete'); absent(retainedRequest);
  const capturedPath = join(s.store.directory, retainedRequest.recordId + '.body'), altered = readFileSync(capturedPath);
  altered[0] ^= 1; writeFileSync(capturedPath, altered);
  assert.equal(changedRequest.evidence.digest(), sha(changedRequest.bytes), 'Closed sink still has the original in-memory hash');
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(payload);
  const refused = await changedTransfer;
  assert.equal(refused.outcome, 'interrupted'); assert.equal(refused.failure, 'PROVENANCE');
  assert.equal(refused.status, 200); assert.equal(refused.receivedBytes, String(payload.length));
  absent(refused.evidence); absent(s.store.inspect(changedSink.owner.recordId)); absent(s.store.inspect(retainedRequest.recordId));
  assert.equal(f.requests[1].sha256, sha(changedRequest.bytes)); assert.equal(f.requests.length, 2);
});

test('independent hashes and owned file identity reject request or response changes before first trusted completion', options, async t => {
  const scope = owner(t), s = storage(scope); let received;
  const f = await receiver(scope, (_req, res, record) => {
    received.resolve(record); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(payload);
  });
  for (const changed of ['request-sink', 'response-sink', 'request-disk', 'response-disk']) {
    received = Promise.withResolvers();
    const response = s.sink(), evidence = s.store.begin(s.attemptId, 'request', s.reservation('provider-request'), s.policy);
    const bytes = Buffer.from('immutable-streamed-upload'), outbound = changed.startsWith('request'), disk = changed.endsWith('disk');
    const target = outbound ? evidence : response, originalBytes = outbound ? bytes : payload, append = target.append.bind(target); let rewrites = 0;
    target.append = chunk => {
      if (!disk) { const copy = Buffer.from(chunk); copy[0] ^= 1; append(copy); return; }
      // Rewrite the SAME owned file only after all original bytes reached the
      // original append implementation. The cached digest still matches the
      // real exchange, so only the writer-owned identity fence can detect this.
      append(chunk);
      if (target.bytes === BigInt(originalBytes.length)) {
        const path = join(s.store.directory, target.owner.recordId + '.body'), retained = readFileSync(path);
        retained[0] ^= 1; writeFileSync(path, retained); rewrites++;
      }
    };
    const request = { byteLength: BigInt(bytes.length), chunks: async function* () {
      yield bytes;
      // A fixed Content-Length lets the receiver finish parsing before local
      // req.end. Ensure its exact body observation precedes a local refusal.
      await received.promise;
    }, evidence };
    const result = await scope.track(provider(f).upload(f.origin + '/upload', attempt(s), request, response, scope.signal));
    assert.equal(result.outcome, 'interrupted', changed); assert.equal(result.failure, 'PROVENANCE', changed);
    absent(result.evidence); absent(s.store.inspect(response.owner.recordId)); absent(s.store.inspect(evidence.owner.recordId));
    assert.equal(f.requests.at(-1).sha256, sha(bytes), 'Receiver observed the original outbound stream');
    if (!outbound) { assert.equal(result.status, 200); assert.equal(result.receivedBytes, String(payload.length)); }
    if (disk) {
      assert.equal(rewrites, 1); assert.equal(target.digest(), sha(originalBytes), 'In-memory digest still matches the actual exchange');
      const retained = readFileSync(join(s.store.directory, target.owner.recordId + '.body'));
      assert.equal(retained.length, originalBytes.length); assert.notEqual(sha(retained), target.digest());
    }
  }
  assert.equal(f.requests.length, 4);
});

test('opaque completion capabilities reject forged, copied, cross-sink and replayed use', options, async t => {
  const scope = owner(t), s = storage(scope), f = await receiver(scope, (_req, res) => { res.writeHead(410); res.end(payload); });
  const p = provider(f);
  async function capturedCapability() {
    const sink = s.sink(), finish = sink.finish.bind(sink); let capability;
    // Preserve the exact original sink object. A wrapper would change the
    // identity under test. Defer consumption without minting or replacing it.
    sink.finish = (complete, observed, token) => { if (token !== undefined) capability = token; return finish(complete, observed); };
    const result = await scope.track(p.media(f.origin + '/expired', sink, { signal: scope.signal, role: 'result', url: new URL(f.origin + '/wrong'), method: 'POST' }));
    assert.equal(result.outcome, 'complete'); assert.equal(result.status, 410); assert.ok(capability);
    absent(result.evidence); assert.equal(Object.isFrozen(capability), true);
    return { sink, capability, body: result.evidence };
  }
  const first = await capturedCapability();
  assert.throws(() => transport.consumeWireExecution({ ...first.capability, httpStatus: 200 }, first.sink, first.body), provenanceError);
  const wire = transport.consumeWireExecution(first.capability, first.sink, first.body);
  assert.equal(wire.httpStatus, 410, 'Complete HTTP error evidence never changes into HTTP success');
  assert.equal(wire.role, 'media'); assert.equal(wire.method, 'GET'); assert.equal(wire.pathname, '/expired');
  assert.equal(wire.urlHash, 'sha256:' + sha(f.origin + '/expired'));
  assert.equal(Object.isFrozen(wire), true); assert.throws(() => { wire.httpStatus = 200; }, TypeError);
  assert.throws(() => transport.consumeWireExecution(first.capability, first.sink, first.body), provenanceError);
  const second = await capturedCapability(), other = s.sink(); other.append(payload); const otherBody = other.finish(true);
  assert.throws(() => transport.consumeWireExecution(second.capability, other, otherBody), provenanceError);
  assert.throws(() => transport.consumeWireExecution(second.capability, second.sink, second.body), provenanceError);
  absent(s.store.inspect(otherBody.recordId));
  const mismatches = [
    { recordId: randomUUID() }, { attemptId: randomUUID() }, { direction: 'request' },
    { completeness: 'partial' }, { sha256: '0'.repeat(64) }, { receivedBytes: String(payload.length + 1) },
  ];
  for (const patch of mismatches) {
    const bound = await capturedCapability();
    assert.throws(() => transport.consumeWireExecution(bound.capability, bound.sink, { ...bound.body, ...patch }), provenanceError);
    assert.throws(() => transport.consumeWireExecution(bound.capability, bound.sink, bound.body), provenanceError);
  }
  const handmade = s.sink(); handmade.append(payload); const handmadeBody = handmade.finish(true);
  absent(handmadeBody); absent(s.store.inspect(handmadeBody.recordId));
  const forged = s.sink(); forged.append(payload);
  assert.throws(() => forged.finish(true, BigInt(payload.length), { ...wire, httpStatus: 200, recordId: forged.owner.recordId }), provenanceError);
  absent(s.store.inspect(forged.owner.recordId));
  assert.equal(f.requests.length, 2 + mismatches.length);
  assert.ok(f.requests.every(r => r.method === 'GET' && r.url === '/expired'));
});

test('production-shaped fixture configuration cannot grant production authority and the factory exports no issuer', options, async t => {
  const scope = owner(t), s = storage(scope), f = await receiver(scope); let credentialReads = 0;
  const shaped = providerBoundary({ mode: 'production', queueOrigin: f.origin, mediaOrigins: [f.origin], profiles: [PRODUCTION_PROFILE],
    credential: { queueKey() { credentialReads++; return SENTINEL_KEY; } },
    connection: { mode: 'fixture', fixtureOrigins: [f.origin], resolve: async () => [{ address: '127.0.0.1', family: 4 }] } });
  const a = { attemptId: s.attemptId, identity: { endpoint: 'ideogram/v4', requestId: 'runtime_evidence_fixture' }, profileId: PRODUCTION_PROFILE.id,
    acknowledgement: { id: 'fixture-explicit-fallback', attemptId: s.attemptId, profileId: PRODUCTION_PROFILE.id, profileVersion: PRODUCTION_PROFILE.version,
      evidenceDigest: PRODUCTION_PROFILE.evidenceDigest, fallbackId: PRODUCTION_PROFILE.fallback.id, disclosureDigest: PRODUCTION_PRIVACY.disclosureDigest } };
  const result = await scope.track(shaped.queue(a, 'result', s.sink(), undefined, undefined, scope.signal));
  assert.equal(result.outcome, 'complete'); assert.equal(result.evidence.wireExecution.boundary, 'loopback-fixture-1');
  assert.equal(credentialReads, 1);
  assert.deepEqual(Object.keys(transport).sort(), ['assertProductionConfiguration', 'assertProductionEnvironment', 'connectBound', 'consumeWireExecution', 'createProductionProvider', 'createWireTransport'].sort());
  assert.deepEqual(Object.keys(production).sort(), ['assertProductionConfiguration', 'assertProductionEnvironment', 'createProductionProvider'].sort());
  assert.equal(production.createProductionProvider, transport.createProductionProvider);
  const credentials = { queueKey() { assert.fail('No production credential should be read'); } };
  for (const config of [{ mode: 'fixture' }, { connection: { mode: 'fixture' } }, { origin: f.origin }, { profile: PRODUCTION_PROFILE }, { issuer: () => ({}) }]) {
    assert.throws(() => production.createProductionProvider(credentials, config), error => error?.code === 'POLICY');
  }
  const sealed = production.createProductionProvider(credentials), rejected = s.sink();
  assert.throws(() => sealed.media(f.origin + '/expired', rejected), error => error?.code === 'POLICY');
  absent(s.store.inspect(rejected.owner.recordId));
  const lowLevel = transport.createWireTransport({ mode: 'production', resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  const denied = await scope.track(lowLevel({ url: new URL(f.origin + '/expired'), method: 'GET', role: 'result', headers: () => ({}), sink: s.sink(), signal: scope.signal }));
  assert.equal(denied.outcome, 'interrupted'); assert.equal(denied.failure, 'POLICY'); absent(denied.evidence);
  assert.equal(f.requests.length, 1, 'All supposed production overrides refuse before network effects');
});

test('legacy records remain unverified while malformed claims and changed completion metadata fail closed', options, async t => {
  const scope = owner(t), s = storage(scope), f = await receiver(scope), sink = s.sink();
  const result = await scope.track(provider(f).media(f.origin + '/ok', sink, { signal: scope.signal }));
  assert.equal(result.outcome, 'complete'); assert.ok(result.evidence.wireExecution);
  const file = join(s.store.directory, result.evidence.recordId + '.json'), original = readFileSync(file, 'utf8'), saved = JSON.parse(original);
  assert.equal(saved.wireBodyIdentity.kind, 'provider-wire-body-identity-1');
  assert.deepEqual(sink.finish(true).wireBodyIdentity, saved.wireBodyIdentity, 'Repeated completion preserves the exact owned body identity');
  assert.deepEqual(new TransportEvidenceStore(s.root).inspect(saved.recordId).wireBodyIdentity, saved.wireBodyIdentity, 'Reopening preserves valid wire evidence without issuing a new capability');
  try {
    const legacy = { ...saved }; delete legacy.wireExecution; delete legacy.wireBodyIdentity;
    writeFileSync(file, JSON.stringify(legacy)); absent(s.store.inspect(saved.recordId));
    for (const change of [
      null, {}, { ...saved.wireExecution, kind: 'caller-claim' }, { ...saved.wireExecution, completed: false },
      { ...saved.wireExecution, recordId: randomUUID() }, { ...saved.wireExecution, attemptId: randomUUID() },
      { ...saved.wireExecution, direction: 'request' }, { ...saved.wireExecution, httpStatus: 0 },
      { ...saved.wireExecution, urlHash: 'unverified' }, { ...saved.wireExecution, extra: true },
    ]) {
      writeFileSync(file, JSON.stringify({ ...saved, wireExecution: change }));
      assert.throws(() => s.store.inspect(saved.recordId), provenanceError);
    }
    writeFileSync(file, JSON.stringify({ ...saved, completeness: 'partial' }));
    assert.throws(() => s.store.inspect(saved.recordId), provenanceError);
    const unpaired = { ...saved }; delete unpaired.wireBodyIdentity;
    writeFileSync(file, JSON.stringify(unpaired)); assert.throws(() => s.store.inspect(saved.recordId), provenanceError);
    const stampOnly = { ...saved }; delete stampOnly.wireExecution;
    writeFileSync(file, JSON.stringify(stampOnly)); assert.throws(() => s.store.inspect(saved.recordId), provenanceError);
    writeFileSync(file, JSON.stringify({ ...saved, wireBodyIdentity: { ...saved.wireBodyIdentity, size: 'not-a-size' } }));
    assert.throws(() => s.store.inspect(saved.recordId), provenanceError);
  } finally { writeFileSync(file, original); }
  let changed;
  try { changed = sink.finish(true, BigInt(payload.length + 1)); }
  catch (error) { assert.equal(error.code, 'PROVENANCE'); }
  if (changed) absent(changed);
  else assert.equal(s.store.inspect(saved.recordId).receivedBytes, String(payload.length));
  // Existing metadata mutators may refuse after close or invalidate the claim;
  // neither behavior may retain a production/fixture execution assertion.
  const beforeMutation = s.store.inspect(saved.recordId); let mutationError;
  try { sink.recordHeaders({ 'Content-Type': 'text/plain' }); }
  catch (error) { mutationError = error; }
  if (mutationError) {
    assert.ok(['PROVENANCE', 'IDENTITY', 'CAPACITY'].includes(mutationError.code));
    assert.deepEqual(s.store.inspect(saved.recordId), beforeMutation);
  } else absent(s.store.inspect(saved.recordId));
  const partial = sink.finish(false); absent(partial); absent(s.store.inspect(saved.recordId));
  const fresh = await scope.track(provider(f).media(f.origin + '/body-identity', s.sink(), { signal: scope.signal }));
  assert.equal(fresh.outcome, 'complete'); assert.ok(fresh.evidence.wireExecution);
  const bodyPath = join(s.store.directory, fresh.evidence.recordId + '.body'), changedBytes = readFileSync(bodyPath);
  changedBytes[0] ^= 1; writeFileSync(bodyPath, changedBytes);
  assert.equal(changedBytes.length, Number(fresh.evidence.receivedBytes), 'Mutation keeps the retained body length unchanged');
  assert.throws(() => s.store.inspect(fresh.evidence.recordId), provenanceError);
  assert.throws(() => new TransportEvidenceStore(s.root).inspect(fresh.evidence.recordId), provenanceError);
});

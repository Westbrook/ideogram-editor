// Loaded exclusively through openWriter's internal setupModule test hook.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { threadId } from 'node:worker_threads';
import { startFixtureProvider } from './backend-queue.mjs';
import { readPrivateJSON, writePrivateJSON, QUEUE_CONFIG_FILE, QUEUE_READY_FILE } from './backend-queue-control.mjs';

const ENDPOINTS = new Set(['ideogram/v4', 'ideogram/v4/fast', 'ideogram/v4/instant']);
const STATUSES = new Set(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED']);
const DEFAULT_CONTROLS = Object.freeze({ status: 'IN_QUEUE', dropAcknowledgement: false, mediaStatus: 200, offline: false });

function object(value) { assert(value && typeof value === 'object' && !Array.isArray(value), 'Control object required'); return value; }
function identifier(value) { assert(typeof value === 'string' && value.length > 0 && value.length <= 256, 'Invalid fixture identifier'); return value; }
function endpoint(value) { assert(ENDPOINTS.has(value), 'Unsupported qualification endpoint'); return value; }
function controls(value) {
  object(value);
  for (const key of Object.keys(value)) assert(['status', 'dropAcknowledgement', 'mediaStatus', 'offline', 'jobIds'].includes(key), 'Unknown fixture control');
  if (value.status !== undefined) assert(STATUSES.has(value.status), 'Invalid fixture status');
  if (value.mediaStatus !== undefined) assert([200, 410].includes(value.mediaStatus), 'Invalid fixture media status');
  for (const key of ['dropAcknowledgement', 'offline']) if (value[key] !== undefined) assert.equal(typeof value[key], 'boolean');
  if (value.jobIds !== undefined) { assert(Array.isArray(value.jobIds) && value.jobIds.length <= 1000); value.jobIds.forEach(identifier); }
  return value;
}

function findJob(store, jobId) {
  let after = '';
  do { const page = store.queue.view(after), job = page.jobs.find(item => item.id === jobId); if (job) return job; after = page.nextCursor; } while (after);
  throw Error('Qualification job does not exist');
}

/** The proxy limits selection only. All selected mutations, proof checks and
 * durable observations still execute on the real StoreDatabase instance. */
export function scopeQueueStore(store, jobIds, attemptKeys) {
  assert(jobIds instanceof Set && attemptKeys instanceof Set, 'Exact fixture job and attempt ownership required');
  const bind = (target, key) => typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  const owns = (jobId, attemptId) => jobIds.has(jobId) && attemptKeys.has(jobId + '\0' + attemptId);
  const queue = new Proxy(store.queue, { get(target, key) {
    if (key === 'view') return (...args) => { const page = target.view(...args); return { ...page, jobs: page.jobs.filter(job => jobIds.has(job.id)) }; };
    if (key === 'controlWork' || key === 'recoveryWork') return (eligible = () => true) => target[key]((jobId, attemptId) => owns(jobId, attemptId) && eligible(jobId, attemptId));
    return bind(target, key);
  } });
  const candidates = new Proxy(store.candidates, { get(target, key) {
    if (key === 'queue') return queue;
    if (key === 'due') return (now, eligible = () => true) => target.due(now, (jobId, attemptId) => owns(jobId, attemptId) && eligible(jobId, attemptId));
    if (key === 'retries') return (eligible = () => true) => target.retries((jobId, attemptId) => owns(jobId, attemptId) && eligible(jobId, attemptId));
    return bind(target, key);
  } });
  return new Proxy(store, { get(target, key) { if (key === 'queue') return queue; if (key === 'candidates') return candidates; return bind(target, key); } });
}

/** Factory injection is solely for focused bridge tests; setup always uses the
 * real HTTP fixture and production dispatcher/observer. */
export async function startQueueControl(store, config, { startProvider = startFixtureProvider } = {}) {
  assert.equal(config.schema, 'qualification-queue-worker-1');
  assert.equal(config.root, resolve(store.root));
  assert.match(config.nonce, /^[0-9a-f]{64}$/);
  assert.equal(config.repo, resolve(config.repo));
  const routes = new Map(), sockets = new Set();
  let origin = '', closing = false, pending = 0, tail = Promise.resolve();
  const worker = { epoch: store.epoch, threadId };
  let snapshotBoundary = null;
  const originalMaintain = store.recovery?.maintain.bind(store.recovery), originalSettle = store.recovery?.settle.bind(store.recovery);
  async function routeFor(value) {
    const name = endpoint(value);
    if (!routes.has(name)) {
      const jobIds = new Set(), attemptKeys = new Set();
      const fixture = await startProvider({ repo: config.repo, fixture: config.fixture }, scopeQueueStore(store, jobIds, attemptKeys), name,
        config.resultFiles ? { resultFiles: config.resultFiles } : {});
      routes.set(name, { endpoint: name, fixture, jobIds, attemptKeys, submittedJobIds: new Set(), submittedAttemptIds: new Set(),
        lastSubmit: null, lastConfigured: null, lastTick: null, lastKnownRead: null, lastStatusObservation: null, closed: false });
    }
    assert(!routes.get(name).closed, 'Closed fixture namespace requires public cleanup and fixture reset');
    return routes.get(name);
  }
  function enroll(route, jobId) {
    identifier(jobId); const job = findJob(store, jobId);
    assert.equal(job.review.endpoint, route.endpoint, 'Job endpoint mismatch');
    const latest = job.attempts.at(-1), key = jobId + '\0' + latest.id;
    if (!route.attemptKeys.has(key)) assert.equal(latest.state, 'not-started', 'An existing foreign attempt cannot be adopted by the fixture');
    route.jobIds.add(jobId); route.attemptKeys.add(key); return job;
  }
  function ownedJob(jobId, attemptId) {
    const job = findJob(store, identifier(jobId)), route = routes.get(job.review.endpoint);
    assert(route?.jobIds.has(jobId), 'Job has not been enrolled by this fixture');
    const attempt = job.attempts.find(item => item.id === identifier(attemptId));
    assert(attempt, 'Unknown owned attempt');
    assert(route.attemptKeys.has(jobId + '\0' + attemptId), 'Attempt has not been enrolled by this fixture');
    if (attempt.requestId) assert(route.fixture.requests.has(attempt.requestId), 'Provider request is not owned by this fixture');
    assert(!route.closed, 'Fixture provider namespace is closed'); return { job, route };
  }
  const snapshot = route => ({ endpoint: route.endpoint, origin: route.fixture.origin, profile: route.fixture.profile, image: route.fixture.image,
    controls: { ...route.fixture.controls }, effects: [...route.fixture.effects], errors: [...(route.fixture.errors ?? [])], jobIds: [...route.jobIds],
    controlReads: [...(route.fixture.controlReads ?? [])],
    enrolledJobIds: [...route.jobIds], enrolledAttemptIds: [...route.attemptKeys].map(key => key.split('\0')[1]),
    submittedJobIds: [...route.submittedJobIds], submittedAttemptIds: [...route.submittedAttemptIds], requestIds: [...route.fixture.requests.keys()],
    lastSubmit: route.lastSubmit, lastConfigured: route.lastConfigured, lastTick: route.lastTick, lastKnownRead: route.lastKnownRead,
    lastStatusObservation: route.lastStatusObservation, resultFixture: config.resultFixture ?? null, closed: route.closed, worker });
  async function readKnown(route, jobId, attemptId, kind) {
    const startedMs = performance.now();
    try { return await route.fixture.dispatcher.readKnown(jobId, attemptId, kind); }
    finally { route.lastKnownRead = { jobId, attemptId, kind, startedMs, completedMs: performance.now() }; }
  }
  async function operation(name, args) {
    object(args);
    switch (name) {
      case 'configure': {
        const selected = await routeFor(args.endpoint), options = controls(args.options ?? {});
        for (const id of options.jobIds ?? []) enroll(selected, id);
        const { jobIds: _ignored, ...next } = options, startedMs = performance.now();
        const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => selected.fixture.controls[key] !== value));
        Object.assign(selected.fixture.controls, next);
        selected.lastConfigured = { startedMs, completedMs: performance.now(), changed, controls: { ...selected.fixture.controls } }; return snapshot(selected);
      }
      case 'submit': {
        const job = findJob(store, identifier(args.jobId)), route = await routeFor(job.review.endpoint); enroll(route, job.id);
        const before = route.fixture.effects.length, attemptId = job.attempts.at(-1).id, startedMs = performance.now();
        try { return await route.fixture.dispatcher.submit(job.id); }
        finally {
          const post = route.fixture.effects.slice(before).find(effect => effect.method === 'POST');
          if (post) { route.submittedJobIds.add(job.id); route.submittedAttemptIds.add(attemptId); }
          route.lastSubmit = { jobId: job.id, attemptId, startedMs, postObservedMs: post?.atMs ?? null, completedMs: performance.now() };
        }
      }
      case 'observeStatus': {
        assert(STATUSES.has(args.status)); const { route } = ownedJob(args.jobId, args.attemptId);
        const startedMs = performance.now();
        try {
          route.fixture.controls.status = args.status;
          const fence = store.queue.resultFence(args.jobId, args.attemptId);
          const receipt = await readKnown(route, args.jobId, args.attemptId, 'status');
          assert.equal(receipt.outcome, 'complete'); return store.candidates.observe(fence, receipt.evidence, Date.now());
        } finally { route.lastStatusObservation = { jobId: args.jobId, attemptId: args.attemptId, status: args.status, startedMs, completedMs: performance.now() }; }
      }
      case 'readKnown': {
        assert(['status', 'result', 'cancel'].includes(args.kind)); const { route } = ownedJob(args.jobId, args.attemptId);
        return readKnown(route, args.jobId, args.attemptId, args.kind);
      }
      case 'proxyPair': {
        const { job, route } = ownedJob(args.jobId, args.attemptId), attempt = job.attempts.find(item => item.id === args.attemptId);
        assert(attempt.requestId, 'Proxy comparison requires an owned known request');
        const directStart = performance.now();
        const response = await fetch(route.fixture.origin + '/' + route.endpoint + '/requests/' + encodeURIComponent(attempt.requestId) + '/status', { redirect: 'error', signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 200); let bytes = 0; const hash = createHash('sha256');
        for await (const chunk of response.body) { bytes += chunk.length; assert(bytes <= 65536, 'Direct fixture response exceeds control bound'); hash.update(chunk); }
        const directEnd = performance.now(), direct = { startMs: directStart, endMs: directEnd, durationMs: directEnd - directStart, sha256: 'sha256:' + hash.digest('hex'), bytes };
        const proxyStart = performance.now(), receipt = await readKnown(route, args.jobId, args.attemptId, 'status'), proxyEnd = performance.now();
        assert.equal(receipt.outcome, 'complete'); assert.equal(receipt.status, 200);
        const proxy = { startMs: proxyStart, endMs: proxyEnd, durationMs: proxyEnd - proxyStart, sha256: 'sha256:' + receipt.sha256, receipt };
        assert.equal(direct.sha256, proxy.sha256, 'Direct and product status responses must contain identical bytes');
        return { jobId: args.jobId, attemptId: args.attemptId, direct, proxy, addedHopMs: Math.max(0, proxy.durationMs - direct.durationMs), worker,
          boundary: 'Sequential direct fixture fetch and production dispatcher status read inside the same retained writer worker; control RPC excluded' };
      }
      case 'tick': {
        const route = routes.get(endpoint(args.endpoint)); assert(route && !route.closed, 'Fixture route is not open');
        const startedMs = performance.now();
        try { await route.fixture.observer.tick(); }
        finally { route.lastTick = { startedMs, completedMs: performance.now() }; }
        return snapshot(route);
      }
      case 'snapshot': { if (args.endpoint === undefined) return { routes: [...routes.values()].map(snapshot), worker }; const route = routes.get(endpoint(args.endpoint)); assert(route, 'Fixture route is not configured'); return snapshot(route); }
      case 'resources': return { objects: store.objects.reservationInventory(), raster: store.rasters.diagnostics(), ...worker };
      case 'closeNamespace': {
        const route = routes.get(endpoint(args.endpoint)); assert(route, 'Fixture route is not configured');
        if (!route.closed) { await route.fixture.close(); route.closed = true; }
        return snapshot(route);
      }
      case 'setSnapshotBoundary': {
        assert(originalMaintain && originalSettle, 'Real recovery scheduler is required');
        const value = args.boundary;
        assert(value === null || typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'Exact snapshot boundary required');
        if (value !== null) assert(BigInt(value) >= BigInt(store.recovery.highWater()), 'Snapshot boundary precedes live high water');
        await originalSettle();
        const previous = snapshotBoundary; snapshotBoundary = value;
        if (value === null) { store.recovery.maintain = originalMaintain; store.recovery.settle = originalSettle; }
        else {
          const boundary = BigInt(value);
          store.recovery.maintain = () => { const high = BigInt(store.recovery.highWater()); if (high <= boundary - 250n || high === boundary) originalMaintain(); };
          store.recovery.settle = async start => {
            await originalSettle(start);
            if (BigInt(store.recovery.highWater()) === boundary) { originalMaintain(); await originalSettle(); assert.equal(store.recovery.latest()?.seq, value, 'Production snapshot did not activate at exact fixture boundary'); }
          };
        }
        return { previous, boundary: value, ...worker, schedulingOnly: true, directSQLWrites: false };
      }
      case 'resetFixture': {
        assert.equal(pending, 1, 'Fixture reset requires an exclusive command boundary');
        // Public cancellation/reconciliation/deletion precedes this fixture-only reset.
        // Refuse to forget any live attempt that still owns a provider hold.
        for (const route of routes.values()) for (const jobId of route.jobIds) {
          const job = findJob(store, jobId); assert(job.attempts.every(attempt => !attempt.hold), 'Public product cleanup must release all owned holds before fixture reset');
          assert(job.disposition === 'deleted' && job.attempts.every(attempt => attempt.state !== 'not-started'), 'Public document deletion must precede fixture reset');
        }
        for (const route of routes.values()) { if (route.closed) { routes.delete(route.endpoint); continue; } Object.assign(route.fixture.controls, DEFAULT_CONTROLS); route.fixture.effects.length = 0; if (route.fixture.controlReads) route.fixture.controlReads.length = 0; route.fixture.requests.clear(); route.jobIds.clear(); route.attemptKeys.clear(); route.submittedJobIds.clear(); route.submittedAttemptIds.clear(); route.lastSubmit = null; route.lastConfigured = null; route.lastTick = null; route.lastKnownRead = null; route.lastStatusObservation = null; }
        return { ...worker, reset: true };
      }
      default: throw Error('Unknown qualification worker operation');
    }
  }
  function authorized(req) {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return false;
    const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + config.nonce);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    const respond = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (closing || req.method !== 'POST' || req.url !== '/control' || !authorized(req) || req.headers['content-type'] !== 'application/json') { req.resume(); respond(403, { ok: false, error: { code: 'FIXTURE_CONTROL', message: 'Private fixture control required' } }); return; }
    if (pending >= 8) { req.resume(); respond(429, { ok: false, error: { code: 'FIXTURE_CONTROL_BUSY', message: 'Fixture command queue full' } }); return; }
    ++pending;
    try {
      let length = 0; const chunks = [];
      for await (const chunk of req) { length += chunk.length; assert(length <= 65536, 'Fixture command too large'); chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(value.schema, 'qualification-queue-command-1'); assert.equal(value.epoch, store.epoch, 'Stale fixture worker epoch');
      const next = tail.then(() => { assert(!closing, 'Fixture is closing'); return operation(value.operation, value.args); });
      tail = next.catch(() => {});
      const result = await next; respond(200, { ok: true, result: result ?? null });
    } catch (error) { respond(400, { ok: false, error: { name: error.name, code: error.code ?? 'FIXTURE_CONTROL', message: error.message } }); }
    finally { --pending; }
  });
  server.requestTimeout = 125000; server.headersTimeout = 10000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port;
  await writePrivateJSON(join(store.root, QUEUE_READY_FILE), { schema: 'qualification-queue-worker-ready-1', root: config.root, nonce: config.nonce, origin, ...worker });
  return async () => {
    closing = true;
    for (const route of routes.values()) { route.fixture.observer.close(); route.fixture.dispatcher.close(); }
    await tail;
    const closed = new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    for (const socket of sockets) socket.destroy();
    await closed;
    for (const route of routes.values()) if (!route.closed) await route.fixture.close();
    if (originalMaintain && originalSettle) { store.recovery.maintain = originalMaintain; store.recovery.settle = originalSettle; }
  };
}

export async function setup(store) {
  const config = await readPrivateJSON(join(store.root, QUEUE_CONFIG_FILE));
  return startQueueControl(store, config);
}

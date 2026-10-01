import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { auth, createProductFixture, createDocument, encode, envelope, finish, hash, phase, product, result, stageBlob, stageCaption, ui } from './backend-common.mjs';

export const scenarios = Object.freeze(['lost-acknowledgement', 'duplicate-status', 'out-of-order-status', 'cancel-late-result', 'expired-result-url', 'browser-restart', 'backend-restart', 'offline-completion', 'disk-full-admission']);
export const fastManifest = Object.freeze([
  { caseId: 'WF01', speed: 'TURBO', expansion: 'None', width: 512, height: 512, count: 1, format: 'png' },
  { caseId: 'WF02', speed: 'TURBO', expansion: 'Medium', width: 1024, height: 1024, count: 4, format: 'jpeg' },
  { caseId: 'WF03', speed: 'BALANCED', expansion: 'None', width: 2048, height: 2048, count: 1, format: 'jpeg' },
  { caseId: 'WF04', speed: 'BALANCED', expansion: 'Medium', width: 512, height: 512, count: 4, format: 'png' },
  { caseId: 'WF05', speed: 'QUALITY', expansion: 'None', width: 1024, height: 1024, count: 1, format: 'png' },
  { caseId: 'WF06', speed: 'QUALITY', expansion: 'Medium', width: 2048, height: 2048, count: 4, format: 'jpeg' },
]);
const fastFault = { WF13: 'lost-acknowledgement', WF14: 'browser-restart', WF15: 'cancel', WF16: 'late-result' };

export function identifyQueueCase(cell) {
  const parameters = cell.parameters ?? {};
  if (cell.operation === 'queue.fault') {
    const scenario = { 'lost-ack': 'lost-acknowledgement', expiry: 'expired-result-url' }[parameters.scenario] ?? parameters.scenario;
    if (!scenarios.includes(scenario)) throw Error('Unknown WQ scenario: ' + scenario);
    return { scenario, fast: false };
  }
  if (cell.operation === 'fast.workflow') {
    if (!/^WF(0[1-9]|1[0-6])$/.test(parameters.caseId)) throw Error('Unknown Fast case');
    const manifest = fastManifest.find(item => item.caseId === parameters.caseId);
    return { scenario: manifest ? 'valid' : fastFault[parameters.caseId] ?? 'invalid', fast: true, caseId: parameters.caseId, manifest };
  }
  if (['queue.proxy-pair', 'queue.healthy-polling'].includes(cell.operation)) return { scenario: cell.operation.slice(6), fast: false };
  throw Error('Unsupported queue operation: ' + cell.operation);
}

export async function prepareQueue(f, phases, options = {}) {
  const { newDraft, resolve, bodyTemplate } = await product(f.context, 'src/request/core.js');
  await createDocument(f);
  const promptText = 'Campaign exact Café 東京 \\ " independent ' + (options.caseId ?? 'WQ');
  const prompt = await phase(phases, 'prompt-hash-stage-register', () => stageCaption(f, promptText));
  const draft = newDraft(prompt.blob), manifest = options.manifest ?? { speed: 'BALANCED', expansion: 'None', width: 512, height: 512, count: 1, format: 'png' };
  draft.operation = options.fast ? 'fast' : 'generate';
  Object.assign(draft.fields, { speed: manifest.speed, expansion: manifest.expansion, width: String(manifest.width), height: String(manifest.height), count: String(manifest.count), format: manifest.format, seed: '900719925474099312345', acceleration: options.fast ? '' : 'none' });
  draft.guidanceAcknowledged = true;
  options.mutate?.(draft, prompt);
  const draftAsset = await phase(phases, 'draft-hash-stage-register', () => stageCaption(f, JSON.stringify(draft)));
  const draftId = 'campaign_draft_' + randomUUID();
  const revision = await f.writer.documentRevision(f.documentId);
  const saved = await phase(phases, 'draft-durable-append', () => ui(f, { type: 'SaveDraft', draft: { id: draftId, generation: '1', kind: 'request', documentId: f.documentId, targetLayerId: null, expectedDocumentRevision: revision, assetId: draftAsset.id, composing: false } }));
  assert.equal(saved.status, 'accepted', JSON.stringify(saved));
  const request = await phase(phases, 'validation', () => resolve(draft, promptText));
  const wire = await phase(phases, 'projection-wire-accounting', () => bodyTemplate(request, promptText));
  const review = await phase(phases, 'review', () => ui(f, { type: 'PrepareRequestReview', draftId, generation: '1' }));
  assert.equal(review.status, 'accepted', JSON.stringify(review));
  const accepted = await phase(phases, 'explicit-review-acceptance', () => ui(f, { type: 'AcceptRequestReview', reviewId: review.review.id, token: review.review.token }));
  assert.equal(accepted.status, 'accepted', JSON.stringify(accepted));
  return { draft, draftId, draftAsset, wire, promptText, prompt, review: review.review, body: { type: 'QueueInference', reviewId: review.review.id, token: review.review.token, acceptanceId: accepted.requestId } };
}

export async function enqueue(f, body, phases) {
  const request = envelope(body);
  const receipt = await phase(phases, 'command.accept', () => f.writer.queueCommand(encode(request), auth()));
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  const diagnostics = await f.writer.diagnostics();
  let acceptedAtMs = null;
  const productAcceptance = (diagnostics.observations?.phases?.records ?? []).find(record => record.context?.commandId === request.command.commandId && record.phase === 'command.accept' && record.outcome === 'ok') ?? null;
  for (const record of diagnostics.observations?.phases?.records ?? []) {
    if (record.context.commandId !== request.command.commandId || !['command.validate', 'event.append'].includes(record.phase)) continue;
    phases.push({ name: record.phase, startMs: record.startedMs, endMs: record.endedMs, durationMs: record.durationMs, outcome: record.outcome, clock: 'product-writer-monotonic', context: record.context });
    if (record.phase === 'event.append' && record.outcome === 'ok') acceptedAtMs = record.endedMs;
  }
  const events = (await f.writer.events(String(BigInt(receipt.fromSeq) - 1n))).events;
  const id = events.find(event => event.commandId === request.command.commandId && event.type === 'JobQueued')?.payload.id;
  assert(id, 'Durable queue event required');
  let cursor = '', job;
  do { const page = await f.writer.queueView(cursor); job = page.jobs.find(item => item.id === id); cursor = page.nextCursor; } while (!job && cursor);
  assert(job); return { job, request, receipt, acceptedAtMs, productAcceptance };
}

/** Actual loopback HTTP is used throughout. A dropped acknowledgement destroys
 * the socket after reading the complete POST, so the durable fence is exercised. */
export async function startFixtureProvider(context, store, endpoint, options = {}) {
  const { emulator, fixtureProfile } = await import(pathToFileURL(join(context.repo ?? process.cwd(), 'tests/provider/emulator.mjs')).href);
  const { QueueDispatcher } = await product(context, 'server/provider/dispatcher.js');
  const { ResultObserver } = await product(context, 'server/provider/observer.js');
  const selected = options.resultFiles?.[0] ?? context.fixture?.corpus?.files?.find(file => ['candidate-result', 'candidate', 'fast-fault-candidate'].includes(file.role) && Number(file.byteLength) === 8 * 1024 * 1024);
  const image = selected ? await readFile(selected.path) : await readFile(join(context.repo ?? process.cwd(), 'tests/raster/fixtures/normal-png.png'));
  if (selected) assert.equal(hash(image), selected.sha256);
  const controls = { status: 'IN_QUEUE', dropAcknowledgement: false, mediaStatus: 200, offline: false, ...options };
  const effects = [], controlReads = [], requests = new Map(), sockets = new Set(), socketAccounting = new WeakMap(), errors = [], pending = new Set(), stopped = new AbortController();
  let origin = '', closing = false;
  const server = createServer(async (req, res) => {
    let resolvePending; const work = new Promise(resolve => { resolvePending = resolve; }); pending.add(work);
    try {
      const socketState = socketAccounting.get(req.socket) ?? { read: 0, pending: 0 };
      socketAccounting.set(req.socket, socketState);
      assert.equal(socketState.pending, 0, 'Exact control-byte accounting requires sequential requests without HTTP pipelining');
      socketState.pending++;
      let released = false;
      const release = () => { if (!released) { released = true; socketState.pending--; } };
      res.once('finish', release); res.once('close', release);
      const body = Buffer.concat(await Array.fromAsync(req));
      assert.equal(req.headers['transfer-encoding'], undefined, 'Fixture control requests must declare exact lengths without chunk framing');
      const read = req.socket.bytesRead, wireBytes = read - socketState.read; socketState.read = read;
      assert(req.complete && wireBytes > body.length, 'Actual request byte count must include complete HTTP headers');
      const effect = { method: req.method, path: req.url, bytes: body.length, sha256: hash(body), atMs: performance.now(),
        request: { complete: true, bodyBytes: body.length, headerBytes: wireBytes - body.length, wireBytes, accounting: 'Socket bytesRead delta under enforced sequential HTTP requests' } };
      effects.push(effect);
      res.setHeader('Content-Type', 'application/json');
      if (controls.offline) { req.socket.destroy(); return; }
      if (req.method === 'POST') {
        assert.equal(req.url, '/' + endpoint);
        const requestId = 'campaign_' + randomUUID(), request = JSON.parse(body); requests.set(requestId, request);
        if (controls.dropAcknowledgement) { req.socket.destroy(); return; }
        const base = origin + '/' + endpoint + '/requests/' + requestId;
        res.end(JSON.stringify({ request_id: requestId, status_url: base + '/status', response_url: base, cancel_url: base + '/cancel' })); return;
      }
      if (req.url.startsWith('/image/')) {
        if (controls.mediaStatus !== 200) { res.statusCode = controls.mediaStatus; res.end(JSON.stringify({ code: 'EXPIRED_FIXTURE_RESULT' })); return; }
        const index = Number(req.url.split('/').at(-1));
        const selectedImage = options.resultFiles?.[index];
        const format = selectedImage?.format ?? selected?.format ?? 'png', mediaType = format.startsWith('image/') ? format : 'image/' + format;
        // A browser fixture may hold this real HTTP response while it observes
        // the product's retrieval-pending state, then release the actual bytes.
        if (options.beforeMedia) {
          let onAbort;
          const abort = new Promise((_, reject) => { onAbort = () => reject(stopped.signal.reason); stopped.signal.addEventListener('abort', onAbort, { once: true }); });
          try { stopped.signal.throwIfAborted(); await Promise.race([options.beforeMedia({ index, signal: stopped.signal }), abort]); }
          finally { stopped.signal.removeEventListener('abort', onAbort); }
        }
        res.statusCode = controls.mediaStatus; res.setHeader('Content-Type', mediaType); res.setHeader('Content-Length', String(selectedImage?.byteLength ?? image.length));
        if (selectedImage) await pipeline(createReadStream(selectedImage.path, { highWaterMark: 65536 }), res);
        else res.end(image);
        return;
      }
      const requestId = /\/requests\/([^/?]+)/.exec(req.url)?.[1], request = requests.get(requestId);
      assert(request, 'Emulator request identity required');
      if (req.url.endsWith('/status')) {
        const responseBody = Buffer.from(JSON.stringify({ request_id: requestId, status: controls.status }));
        const socket = req.socket, writtenBefore = socket.bytesWritten, startedMs = performance.now();
        res.setHeader('Content-Length', String(responseBody.length));
        const response = effect.response = { complete: false, statusCode: 200, bodyBytes: responseBody.length, bodySha256: hash(responseBody),
          headerBytes: null, wireBytes: null, startedMs, completedMs: null,
          terminalStatus: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(controls.status) ? controls.status : null,
          clock: 'fixture-monotonic' };
        res.once('finish', () => {
          const wireBytes = socket.bytesWritten - writtenBefore;
          assert(wireBytes >= responseBody.length, 'Actual response socket byte counter must include the entire body');
          Object.assign(response, { complete: true, wireBytes, headerBytes: wireBytes - responseBody.length, completedMs: performance.now() });
        });
        res.end(responseBody);
      }
      else if (req.url.endsWith('/cancel')) res.end(JSON.stringify({ request_id: requestId, status: 'CANCELLING' }));
      else res.end(JSON.stringify({ images: Array.from({ length: request.num_images ?? 1 }, (_, index) => {
        const file = options.resultFiles?.[index] ?? selected, format = file?.format ?? 'png';
        return { url: origin + '/image/' + requestId + '/' + index, width: file?.width ?? 2048, height: file?.height ?? 2048, content_type: format.startsWith('image/') ? format : 'image/' + format, file_size: Number(file?.byteLength ?? image.length) };
      }), prompt: request.prompt, has_nsfw_concepts: Array.from({ length: request.num_images ?? 1 }, () => false), seed: 31 }));
    } catch (error) { if (!closing) errors.push({ message: error.message }); if (!res.headersSent) { res.statusCode = 500; res.end('{}'); } else res.destroy(); }
    finally { pending.delete(work); resolvePending(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fixtureProfile({ endpoint }), provider = emulator({ queueOrigin: origin, mediaOrigin: origin, profiles: [profile] });
  let dispatcher, observer;
  function bind(next) {
    observer?.close(); dispatcher?.close(); store = next;
    dispatcher = new QueueDispatcher(store.queue, provider, { queueOrigin: origin, profileId: profile.id });
    const readKnown = dispatcher.readKnown.bind(dispatcher);
    dispatcher.readKnown = async (jobId, attemptId, kind, ...rest) => {
      const observation = { jobId, attemptId, kind, startedMs: performance.now(), completedMs: null, receipt: null }; controlReads.push(observation);
      try {
        const receipt = await readKnown(jobId, attemptId, kind, ...rest);
        observation.receipt = { outcome: receipt.outcome, status: receipt.status, sha256: receipt.sha256, receivedBytes: receipt.receivedBytes, evidence: receipt.evidence };
        return receipt;
      } catch (error) { observation.error = { code: error.code ?? error.name }; throw error; }
      finally { observation.completedMs = performance.now(); }
    };
    observer = new ResultObserver(store.candidates, provider, dispatcher, profile.id);
  }
  bind(store);
  return { origin, controls, effects, controlReads, requests, errors, image: { bytes: image.length, sha256: hash(image), exactEightMiB: image.length === 8 * 1024 * 1024 }, provider, profile,
    get dispatcher() { return dispatcher; }, get observer() { return observer; }, bind,
    async close() {
      if (closing) return; closing = true; stopped.abort(Error('Fixture provider closed'));
      observer.close(); dispatcher.close();
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy(); await closed; await Promise.allSettled([...pending]); assert.deepEqual(errors, []);
    },
  };
}

async function observeStatus(store, fixture, job, status, phases) {
  fixture.controls.status = status;
  return phase(phases, 'status-' + status.toLowerCase(), async () => {
    const fence = store.queue.resultFence(job.id, job.attempts[0].id);
    const receipt = await fixture.dispatcher.readKnown(job.id, fence.attemptId, 'status');
    assert.equal(receipt.outcome, 'complete');
    return store.candidates.observe(fence, receipt.evidence, Date.now());
  });
}

async function recover(store, job, phases) {
  const current = store.queue.recovery(job.id, job.attempts[0].id);
  return phase(phases, 'explicit-known-job-recovery', async () => {
    const body = { type: 'RecoverJob', jobId: job.id, attemptId: job.attempts[0].id, expectedVersion: current.jobVersion };
    // Recovery's job version is public on the owning job, not inferred from the attempt.
    let cursor = '', live;
    do { const page = store.queue.view(cursor); live = page.jobs.find(value => value.id === job.id); cursor = page.nextCursor; } while (!live && cursor);
    body.expectedVersion = live.version;
    const receipt = await store.queue.command(encode(envelope(body)), auth()); assert.equal(receipt.status, 'accepted', JSON.stringify(receipt)); return receipt;
  });
}

function workloadMissing(context, cell) {
  if (cell.workload !== 'WQ') return [];
  const observed = context.fixture?.observed;
  return context.fixture?.seal && observed?.jobs >= 1000 && observed?.incompleteJobs >= 100 ? [] : ['WQ sealed full document, 1,000 metadata jobs and 100 incomplete-job reset identity are required for this workload'];
}

export async function runCell(context, cell) {
  const options = identifyQueueCase(cell), phases = [], assertions = [], missing = workloadMissing(context, cell);
  const f = context.productFixture ?? await phase(phases, 'fresh-namespace-reset', () => createProductFixture(context));
  let fixture, store;
  try {
    if (options.scenario === 'invalid') return await runInvalidFast(context, cell, f, phases, options);
    const prepared = await prepareQueue(f, phases, options);
    if (f.queueWorker) return await runRetainedQueueCell(context, cell, f, phases, options, prepared, missing);
    if (options.scenario === 'disk-full-admission') {
      store = await f.direct({ quotaBytes: '1' });
      const draft = store.ui.read('request_session', auth()), before = store.queue.view().counts;
      let receipt;
      await phase(phases, 'capacity-admission', async () => {
        try { receipt = await store.queue.command(encode(envelope(prepared.body)), auth()); }
        catch (error) { assert.equal(error.code, 'CAPACITY'); receipt = { status: 'rejected', code: error.code }; }
      });
      assert.equal(receipt.status, 'rejected'); assert.equal(receipt.code, 'CAPACITY');
      assert.deepEqual(store.queue.view().counts, before); assert.deepEqual(store.ui.read('request_session', auth()), draft);
      assertions.push({ name: 'Real quota reservation rejects without queue or draft changes', passed: true });
      return result(cell, phases, { root: f.root, receipt, counts: before, quotaBytes: '1', fault: 'Product capacity admission; no simulated disk write' }, assertions, missing);
    }
    const queued = await enqueue(f, prepared.body, phases);
    store = await f.direct(); fixture = await startFixtureProvider(context, store, queued.job.review.endpoint);
    if (options.scenario === 'lost-acknowledgement') fixture.controls.dropAcknowledgement = true;
    let acknowledgement;
    const dispatchStart = performance.now();
    await phase(phases, 'eligible-dispatch-and-emulator-acknowledgement', async () => {
      try { acknowledgement = await fixture.dispatcher.submit(queued.job.id); }
      catch (error) { if (options.scenario !== 'lost-acknowledgement') throw error; assert.equal(error.code, 'INTERRUPTED'); }
    });
    const dispatchedAt = fixture.effects.find(effect => effect.method === 'POST')?.atMs;
    assert(Number.isFinite(dispatchedAt));
    phases.push({ name: 'job.submit.eligible-dispatch', startMs: dispatchStart, endMs: dispatchedAt, durationMs: dispatchedAt - dispatchStart, outcome: 'completed', boundary: 'Eligible dispatcher invocation to emulator receipt of exact POST body; acknowledgement excluded' });
    assert.equal(fixture.effects.filter(effect => effect.method === 'POST').length, 1);
    assert.equal(fixture.effects.find(effect => effect.method === 'POST').sha256, hash(Buffer.from(prepared.wire)), 'Actual HTTP submit preserves every approved byte and exact integer seed');
    if (options.scenario === 'lost-acknowledgement') {
      const uncertain = store.queue.recovery(queued.job.id, queued.job.attempts[0].id).attempt;
      assert.equal(uncertain.state, 'submission-uncertain'); assert.equal(uncertain.requestId, null); assert.equal(uncertain.hold, true);
      assert.equal(await fixture.dispatcher.submit(queued.job.id), null);
      assertions.push({ name: 'Lost real HTTP acknowledgement remains uncertain without retry', passed: true });
    } else {
      assert.equal(acknowledgement.attempts[0].state, 'acknowledged');
      switch (options.scenario) {
        case 'duplicate-status':
        case 'out-of-order-status': {
          await observeStatus(store, fixture, queued.job, 'IN_PROGRESS', phases);
          const outcome = await observeStatus(store, fixture, queued.job, options.scenario === 'duplicate-status' ? 'IN_PROGRESS' : 'IN_QUEUE', phases);
          assert.equal(outcome.view.observation.phase, 'running');
          assertions.push({ name: 'Repeated or older queue status cannot regress authoritative running state', passed: true }); break;
        }
        case 'backend-restart': {
          fixture.observer.close(); fixture.dispatcher.close();
          const oldEpoch = store.epoch;
          await phase(phases, 'backend-close-and-reopen', async () => { await f.closeDirect(); store = await f.direct(); fixture.bind(store); });
          assert.notEqual(store.epoch, oldEpoch);
          const before = fixture.effects.length; await fixture.observer.tick(); assert.equal(fixture.effects.length, before);
          const reconnectStart = performance.now(); await recover(store, queued.job, phases); await observeStatus(store, fixture, queued.job, 'IN_PROGRESS', phases);
          addObservedPhase(phases, 'job.reconnect-start', reconnectStart, fixture.effects.filter(effect => effect.path.endsWith('/status')).at(-1).atMs);
          assertions.push({ name: 'Reopen is inert until explicit known-job recovery', passed: true }); break;
        }
        case 'browser-restart': {
          // C owns the backend half. This is an actual session lookup/read/recovery;
          // H independently measures navigation and painted state.
          await phase(phases, 'client-session-reopen', async () => {
            assert.equal(store.recoverClient(auth().sessionHash, Date.now()), auth().clientId);
            assert(store.document(f.documentId)); store.queue.view();
          });
          const reconnectStart = performance.now(); await recover(store, queued.job, phases); await observeStatus(store, fixture, queued.job, 'IN_PROGRESS', phases);
          addObservedPhase(phases, 'job.reconnect-start', reconnectStart, fixture.effects.filter(effect => effect.path.endsWith('/status')).at(-1).atMs);
          assertions.push({ name: 'Known client reconnect reconciles the same attempt', passed: true }); break;
        }
        case 'cancel':
        case 'cancel-late-result': {
          const live = acknowledgement;
          const receipt = await phase(phases, 'cancel-durable-intent', () => store.queue.command(encode(envelope({ type: 'CancelJob', jobId: live.id, attemptId: live.attempts[0].id, expectedVersion: live.version })), auth()));
          assert.equal(receipt.status, 'accepted');
          await phase(phases, 'eligible-cancel-dispatch', () => fixture.observer.tick());
          assert(fixture.effects.some(effect => effect.method === 'PUT' && effect.path.endsWith('/cancel')));
          if (options.scenario === 'cancel') break;
          fixture.controls.status = 'COMPLETED'; const availableAt = performance.now();
          // No clock jump substitutes for the actual next healthy poll interval.
          await waitUntilDue(store, queued.job, context.signal);
          await phase(phases, 'late-result-retrieval-and-owned-registration', () => fixture.observer.tick());
          addObservedPhase(phases, 'result.retrieval-start', availableAt, fixture.effects.find(effect => effect.path.startsWith('/image/')).atMs);
          assert.equal(store.candidates.view(queued.job.id).items[0]?.state, 'prepared');
          break;
        }
        case 'offline-completion': {
          fixture.controls.offline = true;
          await phase(phases, 'offline-observation', () => fixture.observer.tick());
          assert.equal(store.candidates.view(queued.job.id).observation.mode, 'offline');
          fixture.controls.offline = false; fixture.controls.status = 'COMPLETED'; const reconnectedAt = performance.now(), beforeReconnectEffects = fixture.effects.length;
          await recover(store, queued.job, phases);
          await phase(phases, 'honest-offline-backoff-wait', () => waitUntilDue(store, queued.job, context.signal));
          await phase(phases, 'reconnected-owned-result', () => fixture.observer.tick());
          addObservedPhase(phases, 'job.reconnect-start', reconnectedAt, fixture.effects.slice(beforeReconnectEffects).find(effect => effect.path.endsWith('/status')).atMs);
          addObservedPhase(phases, 'result.retrieval-start', reconnectedAt, fixture.effects.find(effect => effect.path.startsWith('/image/')).atMs);
          assert.equal(store.candidates.view(queued.job.id).items[0]?.state, 'prepared'); break;
        }
        case 'expired-result-url':
        case 'late-result': {
          fixture.controls.status = 'COMPLETED'; const availableAt = performance.now();
          if (options.scenario === 'expired-result-url') fixture.controls.mediaStatus = 410;
          await phase(phases, 'result-retrieval-and-owned-registration', () => fixture.observer.tick());
          addObservedPhase(phases, 'result.retrieval-start', availableAt, fixture.effects.find(effect => effect.path.startsWith('/image/')).atMs);
          const view = store.candidates.view(queued.job.id);
          assert.equal(view.items[0]?.state, options.scenario === 'expired-result-url' ? 'transfer-failed' : 'prepared');
          break;
        }
        case 'proxy-pair': {
          const attempt = store.queue.recovery(queued.job.id, queued.job.attempts[0].id).attempt;
          const path = '/' + queued.job.review.endpoint + '/requests/' + attempt.requestId + '/status';
          const direct = await phase(phases, 'direct-emulator-control', async () => { const response = await fetch(fixture.origin + path); assert.equal(response.status, 200); return response.text(); });
          const proxied = await phase(phases, 'product-provider-control', () => fixture.dispatcher.readKnown(queued.job.id, attempt.id, 'status'));
          assert.equal(proxied.outcome, 'complete'); assert.equal(hash(Buffer.from(direct)), 'sha256:' + proxied.sha256);
          assertions.push({ name: 'Paired direct/product control carries identical response bytes', passed: true }); break;
        }
        case 'healthy-polling': {
          const durationMs = cell.parameters?.durationMs;
          assert.equal(durationMs, 10000, 'The closed healthy trace is exactly ten seconds');
          await phase(phases, 'healthy-polling-ten-seconds', async () => {
            const start = performance.now();
            while (performance.now() - start < durationMs) { context.signal?.throwIfAborted(); await fixture.observer.tick(); await delay(Math.min(20, durationMs - (performance.now() - start)), context.signal); }
          });
          const calls = fixture.effects.filter(effect => effect.path.endsWith('/status'));
          assert(calls.length >= 4 && calls.length <= 6);
          const gaps = calls.slice(1).map((call, index) => call.atMs - calls[index].atMs);
          assert(gaps.every(gap => gap >= 1900 && gap <= 5000));
          assertions.push({ name: 'Actual healthy foreground poll gaps are bounded', passed: true, gapsMs: gaps }); break;
        }
        case 'valid': break;
        default: throw Error('Unimplemented queue scenario ' + options.scenario);
      }
      assert.equal(await fixture.dispatcher.submit(queued.job.id), null, 'One attempt never auto-submits twice');
    }
    const current = store.queue.recovery(queued.job.id, queued.job.attempts[0].id);
    if (options.fast && /^WF1[3-6]$/.test(options.caseId) && !fixture.image.exactEightMiB) missing.push('WF13–16 fixed 8MiB result fixture is not supplied');
    assert.equal(current.attempt.count, 'dispatched');
    assert.equal(fixture.effects.filter(effect => effect.method === 'POST').length, 1);
    assert.deepEqual(store.objects.reservationInventory(), { reservedBytes: '0', activeTransfers: 0 });
    assertions.push({ name: 'Exactly one real POST, immutable attempt and all transfer reservations released', passed: true });
    return result(cell, phases, { root: f.root, endpoint: queued.job.review.endpoint, jobId: queued.job.id, attemptId: queued.job.attempts[0].id, requestId: current.attempt.requestId, requestBodyBytes: Buffer.byteLength(prepared.wire), effects: fixture.effects, outcome: current.attempt, resultFixture: fixture.image, seedManifest: options.manifest ?? null, pid: process.pid }, assertions, missing);
  } finally { await fixture?.close(); if (!context.productFixture) await f.close(); }
}

async function runInvalidFast(context, cell, f, phases, options) {
  const { newDraft, resolve } = await product(context, 'src/request/core.js');
  await createDocument(f);
  const promptText = 'Fast incompatible field remains durable';
  const prompt = await phase(phases, 'fixture-prompt-preservation', () => stageCaption(f, promptText));
  const draft = newDraft(prompt.blob);
  draft.operation = 'fast'; Object.assign(draft.fields, { width: '512', height: '512', acceleration: '', expansion: 'None', seed: '31' }); draft.guidanceAcknowledged = true;
  const expectedField = { WF07: 'source', WF08: 'mask', WF09: 'adapters', WF10: 'acceleration', WF11: 'expansion', WF12: 'size' }[options.caseId];
  if (options.caseId === 'WF07' || options.caseId === 'WF08') {
    const assetFrom = operation => operation.events.find(event => event.payload?.asset)?.payload.asset;
    const sourceAsset = await phase(phases, 'fixture-valid-source-dependency', async () => {
      const original = await stageBlob(f, await readFile(join(context.repo, 'tests/raster/fixtures/hidden-alpha.png')), 'image', 'image/png');
      const preview = assetFrom(await finish(f.writer, envelope({ type: 'PrepareRaster', assetId: original.id }), 'rasterCommand', context.signal)); assert(preview);
      const reviewed = await finish(f.writer, envelope({ type: 'ReviewRaster', assetId: preview.id }), 'rasterCommand', context.signal);
      const reviewId = reviewed.events.find(event => event.payload?.reviewId)?.payload.reviewId, review = await f.writer.rasterReview(reviewId, auth());
      const approved = assetFrom(await finish(f.writer, envelope({ type: 'ApproveRaster', assetId: preview.id, reviewId, reviewHash: review.reviewHash }), 'rasterCommand', context.signal)); assert(approved); return approved;
    });
    const source = { assetId: sourceAsset.id, version: sourceAsset.version, blob: sourceAsset.blob, pixels: sourceAsset.raster.pixels, width: 3, height: 2, scope: 'asset', documentRevision: await f.writer.documentRevision(f.documentId) };
    if (options.caseId === 'WF07') draft.source = source;
    else {
      const mask = await phase(phases, 'fixture-valid-mask-dependency', async () => assetFrom(await finish(f.writer, envelope({ type: 'PrepareMask', plan: { width: 3, height: 2, feather: 0, operations: [{ kind: 'shape', shape: { kind: 'rectangle', x: 1, y: 0, width: 1, height: 2 }, mode: 'replace' }] } }), 'rasterCommand', context.signal)));
      assert(mask); draft.mask = { assetId: mask.id, version: mask.version, blob: mask.blob, pixels: mask.raster.pixels, width: 3, height: 2, sourceHash: source.pixels.hash, polarity: 'white-edit', fullAcknowledged: false, empty: false, full: false, plan: mask.raster.manifest };
    }
  }
  if (options.caseId === 'WF09') {
    const adapter = await phase(phases, 'fixture-valid-retained-adapter-dependency', async () => {
      const header = Buffer.from(JSON.stringify({ tensor: { dtype: 'F32', shape: [1024], data_offsets: [0, 4096] } }));
      const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
      const weights = await stageBlob(f, Buffer.concat([length, header, Buffer.alloc(4096)]), 'adapter', 'application/octet-stream');
      const registered = await finish(f.writer, envelope({ type: 'RegisterAdapterVersion', adapterId: null, previousVersionId: null, weightsAssetId: weights.id, configAssetId: null, provenanceAssetId: null, name: 'Fast incompatible adapter fixture', declaredFamily: 'ideogram-v4', declaredFormat: 'fal', provenanceText: 'Structural local fixture. No model compatibility or provider runtime qualification.' }), 'adapterCommand', context.signal);
      const version = registered.events.find(event => event.payload?.asset)?.payload.asset; assert(version); assert.equal(version.adapter.validation.locallyEligible, false); return version;
    });
    draft.adapters = [{ version: adapter.id, hash: adapter.blob.hash, scale: '1', runtimeAcknowledged: false }];
  }
  if (options.caseId === 'WF10') draft.fields.acceleration = 'high';
  if (options.caseId === 'WF11') draft.fields.expansion = 'Large';
  if (options.caseId === 'WF12') { draft.fields.width = '1600'; draft.fields.height = '900'; }
  const retained = await phase(phases, 'fixture-draft-preservation', () => stageCaption(f, JSON.stringify(draft)));
  const before = await f.writer.queueView(), retainedHash = hash(await f.writer.readMetadata(retained.blob));
  let rejection;
  await phase(phases, 'command.validate', () => {
    try { resolve(draft, promptText); assert.fail('Fast incompatible request must be rejected'); }
    catch (error) { assert(Array.isArray(error.issues), 'Expected product RequestError'); rejection = error.issues; }
  });
  assert(rejection.some(issue => issue.field === expectedField || options.caseId === 'WF12' && ['width', 'height'].includes(issue.field)), JSON.stringify(rejection));
  assert.deepEqual(await f.writer.queueView(), before);
  assert.equal(hash(await f.writer.readMetadata(retained.blob)), retainedHash);
  const missing = []; let rejectedDraftProof;
  // Each incompatible field has its real dependency retained; the authoritative
  // UI boundary must preserve the exact saved, unapplied draft on rejection.
  if (['WF07', 'WF08', 'WF09', 'WF10', 'WF11', 'WF12'].includes(options.caseId)) {
    const draftId = 'invalid_fast_' + randomUUID();
    const saved = await ui(f, { type: 'SaveDraft', draft: { id: draftId, generation: '1', kind: 'request', documentId: f.documentId, targetLayerId: null, expectedDocumentRevision: await f.writer.documentRevision(f.documentId), assetId: retained.id, composing: false } });
    assert.equal(saved.status, 'accepted', JSON.stringify(saved));
    const original = await f.writer.uiRead('request_session', auth());
    const review = await phase(phases, 'authoritative-invalid-review', () => ui(f, { type: 'PrepareRequestReview', draftId, generation: '1' }));
    const unchanged = await f.writer.uiRead('request_session', auth());
    assert.equal(review.status, 'rejected'); assert.deepEqual(unchanged, original);
    const record = state => ({ draftId, generation: '1', assetId: retained.id, blob: retained.blob, rawHash: retainedHash, state });
    rejectedDraftProof = { kind: 'rejected-draft-preservation-1', receipt: review, before: record(original), after: record(unchanged) };
    missing.length = 0;
  }
  const { collectQueueMeasurements } = await import('./backend-queue-metrics.mjs');
  const measured = await collectQueueMeasurements({ writer: f.writer, scenario: 'invalid', phases,
    before: { requiredMeasurements: cell.requiredMeasurements?.map(rule => rule.name) ?? [], rejectedDraftProof } });
  const out = result(cell, phases, { root: f.root, rejection, retainedDraft: retained.blob, providerEffects: 0, measurementGaps: measured.missing }, [{ name: 'Named Fast field rejected with exact authored bytes retained and no attempt', passed: true }], missing);
  out.measurements = measured.measurements; out.measurementDetails = measured.measurementDetails; out.evidence.push(...measured.evidence); return out;
}

async function runRetainedQueueCell(context, cell, f, phases, options, prepared, missing) {
  const assertions = [], measurements = {}, ownEvidence = [], measurementProofs = { requiredMeasurements: cell.requiredMeasurements?.map(rule => rule.name) ?? [] }, queued = await enqueue(f, prepared.body, phases), endpoint = queued.job.review.endpoint;
  const control = f.queueWorker, workerBefore = await control.resources();
  const beforeEffects = (await control.configure(endpoint, { status: 'IN_QUEUE', offline: false, mediaStatus: 200, dropAcknowledgement: options.scenario === 'lost-acknowledgement' })).effects.length;
  let acknowledgement;
  await phase(phases, 'dispatch-and-emulator-acknowledgement', async () => {
    try { acknowledgement = await control.submit(queued.job.id); }
    catch (error) { if (options.scenario !== 'lost-acknowledgement') throw error; assert.equal(error.code, 'INTERRUPTED'); }
  });
  let snapshot = await control.snapshot(endpoint);
  measurementProofs.queueCheckpoints = [{ label: 'after-real-submit', counts: (await f.writer.queueView()).counts }];
  const effects = () => snapshot.effects.slice(beforeEffects);
  assert.equal(snapshot.lastSubmit.jobId, queued.job.id);
  if (Number.isFinite(queued.acceptedAtMs)) addObservedPhase(phases, 'job.submit.eligible-dispatch', queued.acceptedAtMs, snapshot.lastSubmit.postObservedMs);
  else missing.push('Product writer durable append endpoint required to establish when the new accepted job became eligible for dispatch');
  const recovery = () => f.writer.queueRecovery(queued.job.id, queued.job.attempts[0].id);
  const currentJob = async () => {
    let after = '';
    do { const view = await f.writer.queueView(after), job = view.jobs.find(job => job.id === queued.job.id); if (job) return job; after = view.nextCursor; } while (after);
    throw Error('Retained fixture job disappeared');
  };
  const command = async body => {
    const request = envelope(body), receipt = await f.writer.queueCommand(encode(request), auth());
    assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
    const trace = await f.writer.diagnostics();
    const committed = (trace.observations?.phases?.records ?? []).filter(record => record.context?.commandId === request.command.commandId && record.phase === 'event.append' && record.outcome === 'ok').at(-1);
    return { request, receipt, acceptedAtMs: committed?.endedMs ?? null };
  };
  const observe = status => phase(phases, 'status-' + status.toLowerCase(), () => control.observeStatus(queued.job.id, queued.job.attempts[0].id, status));
  const waitDue = async () => { const view = await f.writer.candidateView(queued.job.id); await delay(Math.max(0, (view.observation?.nextPollAt ?? 0) - Date.now()), context.signal); };
  const ownResult = async ({ expired = false, wait = false } = {}) => {
    const availability = await control.configure(endpoint, { status: 'COMPLETED', mediaStatus: expired ? 410 : 200 });
    if (wait) await phase(phases, 'actual-healthy-poll-wait', waitDue);
    await phase(phases, 'result-retrieval-through-owned-registration', () => control.tick(endpoint));
    snapshot = await control.snapshot(endpoint);
    const request = effects().find(effect => effect.path.startsWith('/image/')); assert(request);
    addObservedPhase(phases, 'result.retrieval-start', availability.lastConfigured.completedMs, request.atMs);
    measurementProofs.terminalChallenge = { jobId: queued.job.id, attemptId: queued.job.attempts[0].id,
      requestId: (await recovery()).attempt.requestId, effectStartIndex: beforeEffects, effectEndIndex: snapshot.effects.length };
    const view = await f.writer.candidateView(queued.job.id); assert.equal(view.items[0]?.state, expired ? 'transfer-failed' : 'prepared'); return view;
  };
  if (options.scenario === 'lost-acknowledgement') {
    const attempt = (await recovery()).attempt;
    assert.equal(attempt.state, 'submission-uncertain'); assert.equal(attempt.requestId, null); assert.equal(attempt.hold, true);
  } else {
    assert.equal(acknowledgement.attempts[0].state, 'acknowledged');
    switch (options.scenario) {
      case 'valid': break;
      case 'duplicate-status':
      case 'out-of-order-status': {
        await observe('IN_PROGRESS'); const seen = await observe(options.scenario === 'duplicate-status' ? 'IN_PROGRESS' : 'IN_QUEUE'); assert.equal(seen.view.observation.phase, 'running'); break;
      }
      case 'browser-restart': {
        await phase(phases, 'same-client-session-recovery', async () => { assert.equal(await f.writer.recoverClient(auth().sessionHash, Date.now()), auth().clientId); await f.writer.document(f.documentId); });
        const job = await currentJob(), recover = await command({ type: 'RecoverJob', jobId: job.id, attemptId: job.attempts[0].id, expectedVersion: job.version });
        await observe('IN_PROGRESS'); snapshot = await control.snapshot(endpoint);
        if (Number.isFinite(recover.acceptedAtMs)) addObservedPhase(phases, 'job.reconnect-start', recover.acceptedAtMs, effects().filter(effect => effect.path.endsWith('/status')).at(-1).atMs);
        else missing.push('Product writer recovery append endpoint required for reconnect timing');
        measurements.R29RecoveredPageEntries = (await f.writer.queueView()).jobs.length; break;
      }
      case 'cancel':
      case 'cancel-late-result': {
        const job = await currentJob();
        const cancel = await phase(phases, 'cancel-durable-intent', () => command({ type: 'CancelJob', jobId: job.id, attemptId: job.attempts[0].id, expectedVersion: job.version }));
        await phase(phases, 'cancel-dispatch-and-response', () => control.tick(endpoint)); snapshot = await control.snapshot(endpoint);
        const dispatched = effects().find(effect => effect.method === 'PUT' && effect.path.endsWith('/cancel')); assert(dispatched);
        if (Number.isFinite(cancel.acceptedAtMs)) measurements.R30CancelEligibleDispatchMs = dispatched.atMs - cancel.acceptedAtMs;
        else missing.push('Product writer cancellation append endpoint required for eligible cancel timing');
        const attempt = (await recovery()).attempt; assert.equal(attempt.cancel, 'acknowledged'); assert.notEqual(attempt.terminal, 'cancelled');
        ownEvidence.push({ kind: 'cancel-dispatch-proof', acceptedAtMs: cancel.acceptedAtMs, actualPut: dispatched, writer: workerBefore, afterAcknowledgement: attempt });
        measurements.R30StoppedOrRefundedWithoutEvidenceCount = 0;
        if (options.scenario === 'cancel-late-result') await ownResult({ wait: true }); break;
      }
      case 'expired-result-url': await ownResult({ expired: true }); break;
      case 'late-result': await ownResult(); break;
      case 'offline-completion': {
        await control.configure(endpoint, { offline: true }); await phase(phases, 'offline-observation', () => control.tick(endpoint));
        assert.equal((await f.writer.candidateView(queued.job.id)).observation.mode, 'offline');
        const reconnect = await control.configure(endpoint, { offline: false, status: 'COMPLETED' });
        const job = await currentJob(); await command({ type: 'RecoverJob', jobId: job.id, attemptId: job.attempts[0].id, expectedVersion: job.version });
        await ownResult({ wait: true }); snapshot = await control.snapshot(endpoint);
        addObservedPhase(phases, 'job.reconnect-start', reconnect.lastConfigured.completedMs, effects().filter(effect => effect.path.endsWith('/status')).at(-1).atMs);
        measurements.R29RecoveredPageEntries = (await f.writer.queueView()).jobs.length; break;
      }
      case 'healthy-polling': {
        assert.equal(cell.parameters.durationMs, 10000);
        await phase(phases, 'healthy-polling-ten-seconds', async () => {
          let tick = await control.tick(endpoint); const began = tick.lastTick.startedMs;
          while (tick.lastTick.completedMs - began < 10000) {
            await delay(Math.min(20, 10000 - (tick.lastTick.completedMs - began)), context.signal);
            tick = await control.tick(endpoint);
          }
          measurementProofs.observerWindow = { observerId: queued.job.attempts[0].id, startedMs: began,
            completedMs: tick.lastTick.completedMs, clock: 'fixture-monotonic', complete: true,
            effectStartIndex: beforeEffects, effectEndIndex: tick.effects.length, productObserverOnly: true };
        });
        snapshot = await control.snapshot(endpoint); const polls = effects().filter(effect => effect.path.endsWith('/status')), gaps = polls.slice(1).map((effect, i) => effect.atMs - polls[i].atMs);
        assert(gaps.length >= 3); assert(gaps.every(gap => gap >= 1900 && gap <= 5000)); measurements.R29ForegroundHealthyPollGapMs = Math.max(...gaps);
        // Background 15–30s is a distinct trace and cannot be invented from this ten-second foreground specimen.
        break;
      }
      case 'proxy-pair': {
        const attempt = (await recovery()).attempt, pair = await control.proxyPair(queued.job.id, attempt.id);
        assert.equal(pair.direct.sha256, pair.proxy.sha256);
        for (const [name, span] of [['control.direct', pair.direct], ['control.proxy', pair.proxy]]) phases.push({ name, startMs: span.startMs, endMs: span.endMs, durationMs: span.durationMs, outcome: 'completed', boundary: pair.boundary });
        measurements.R26ProxyAddedHopMs = pair.addedHopMs;
        ownEvidence.push({ kind: 'same-worker-proxy-pair', pair });
        assertions.push({ name: 'Proxy overhead is the measured same-route paired difference in one worker', passed: true, directMs: pair.direct.durationMs, proxyMs: pair.proxy.durationMs, addedHopMs: measurements.R26ProxyAddedHopMs });
        break;
      }
      default: throw Error('Retained writer does not implement ' + options.scenario);
    }
  }
  assert.equal(await control.submit(queued.job.id), null);
  const current = await recovery(); assert.equal(current.attempt.count, 'dispatched');
  snapshot = await control.snapshot(endpoint); assert.equal(effects().filter(effect => effect.method === 'POST').length, 1); assert.deepEqual(snapshot.errors, []);
  assert.equal(effects().find(effect => effect.method === 'POST').sha256, hash(Buffer.from(prepared.wire)), 'Actual HTTP submit preserves every approved byte and exact integer seed');
  const resources = await control.resources(); assert.equal(resources.threadId, workerBefore.threadId); assert.equal(resources.epoch, workerBefore.epoch);
  assert.deepEqual(resources.objects, { reservedBytes: '0', activeTransfers: 0 });
  const view = await f.writer.queueView();
  Object.assign(measurements, { R21CommandUtf8Bytes: encode(queued.request).length, R25ActiveRequests: view.counts.active, R29UnexpectedResubmissionCount: 0, R42ActiveRequests: view.counts.active, R42BatchOutputs: prepared.draft.fields.count, R42RouteOrDroppedFieldOrUnexpectedRetryCount: 0 });
  const eventPage = await f.writer.events(String(BigInt(queued.receipt.fromSeq) - 1n));
  const ownedEvents = eventPage.events.filter(event => event.commandId === queued.request.command.commandId);
  assert(ownedEvents.length > 0); assert(ownedEvents.every(event => !/data:[^;]+;base64/.test(JSON.stringify(event))));
  measurements.R21EventUtf8Bytes = Math.max(...ownedEvents.map(event => encode(event).length)); measurements.R21InlineBinaryOrDataUris = 0;
  const stored = await f.writer.lookup(queued.request.command.commandId);
  assert.deepEqual(stored.receipt, queued.receipt, 'Repeated lookup retains the exact immutable acceptance receipt');
  assert.deepEqual((await currentJob()).review, queued.job.review, 'The authoritative accepted job preserves its exact frozen review');
  const submitted = effects().find(effect => effect.method === 'POST');
  const wireProof = { kind: 'durable-queue-wire-proof', commandId: queued.request.command.commandId, commandBytes: encode(queued.request).length,
    commandSha256: hash(encode(queued.request)), receipt: queued.receipt, repeatedReceipt: stored.receipt,
    eventBytes: ownedEvents.map(event => ({ sequence: event.seq, commandId: event.commandId, bytes: encode(event).length, sha256: hash(encode(event)) })),
    inlineDataUriCount: 0, approvedBodySha256: hash(Buffer.from(prepared.wire)), actualSubmit: submitted,
    durableAppendEndedMs: queued.acceptedAtMs, productAcceptance: queued.productAcceptance, frozenReview: queued.job.review,
    actualSubmitCount: effects().filter(effect => effect.method === 'POST').length };
  ownEvidence.push(wireProof);
  if (queued.productAcceptance && Number.isFinite(queued.acceptedAtMs)) {
    assert(queued.acceptedAtMs <= queued.productAcceptance.endedMs, 'Product acknowledgement must follow durable append completion in the same writer clock');
    measurements.R20PrematureDurableAcknowledgements = 0;
  }
  measurements.R24FrozenCommandOrQueueReceiptViolations = 0;
  if (options.fast && /^WF1[3-6]$/.test(options.caseId) && !snapshot.image.exactEightMiB) missing.push('WF13–16 fixed 8MiB result fixture is not supplied');
  if (measurementProofs.requiredMeasurements.some(name => name.startsWith('R32'))) {
    const source = (await f.writer.imageState(f.documentId)).layers.find(layer => layer.kind === 'image');
    if (source) measurementProofs.cacheProbe = { assetId: source.assetId };
  }
  const { collectQueueMeasurements } = await import('./backend-queue-metrics.mjs');
  const measured = await collectQueueMeasurements({ writer: f.writer, control, endpoint, queued, prepared, before: measurementProofs, snapshot, scenario: options.scenario, phases });
  Object.assign(measurements, measured.measurements);
  if (measurements.R25ActiveRequests !== undefined) measurements.R42ActiveRequests = measurements.R25ActiveRequests;
  const out = result(cell, phases, { root: f.root, endpoint, jobId: queued.job.id, attemptId: queued.job.attempts[0].id, requestId: current.attempt.requestId, effects: effects(), outcome: current.attempt, resultFixture: snapshot.image, seedManifest: options.manifest ?? null, resources, retainedWriter: true, measurementGaps: measured.missing }, [{ name: 'Actual writer thread and epoch retained through all product commands and provider handling', passed: true }, ...assertions], missing);
  out.evidence.push(...ownEvidence, ...measured.evidence);
  const proof = (unit, method, evidence) => ({ unit, method, evidence });
  out.measurementDetails = {
    ...measured.measurementDetails,
    R21CommandUtf8Bytes: proof('bytes', 'UTF-8 byte length of the exact submitted canonical command envelope', [wireProof]),
    R21EventUtf8Bytes: proof('bytes', 'Maximum UTF-8 byte length among the actual durable events emitted by this command', [wireProof]),
    R21InlineBinaryOrDataUris: proof('count', 'Checked actual admitted event JSON for inline data URI payloads; recorded event hashes identify the inspected events', [wireProof]),
    R20PrematureDurableAcknowledgements: proof('violations', 'Compared same-writer durable append completion and product acknowledgement endpoints, then verified the exact durable receipt and events', [wireProof]),
    R24FrozenCommandOrQueueReceiptViolations: proof('violations', 'Exact approved request-body hash, actual HTTP body hash, repeated receipt, and later frozen job review agree', [wireProof]),
    R42ActiveRequests: proof('count', 'Maximum actual durable active counter at recorded queue checkpoints', measured.evidence.filter(item => item.kind === 'observed-active-counter-checkpoints')),
    R42BatchOutputs: proof('count', 'Requested batch count in the frozen Fast manifest whose complete serialized body hash matches the actual HTTP POST', [wireProof]),
    R42RouteOrDroppedFieldOrUnexpectedRetryCount: proof('violations', 'Actual endpoint assertion, exact approved-versus-transmitted body hash and one-POST observation', [wireProof]),
    R26ProxyAddedHopMs: proof('ms', 'Nonnegative difference between sequential same-worker direct and production-proxy intervals on the same response identity', ownEvidence.filter(item => item.kind === 'same-worker-proxy-pair')),
  };
  if (measurements.R29ForegroundHealthyPollGapMs !== undefined) out.measurementDetails.R29ForegroundHealthyPollGapMs = proof('ms', 'Maximum consecutive actual foreground status-request arrival gap inside the declared healthy observer interval', [{ window: measurementProofs.observerWindow, requests: effects().filter(effect => effect.path.endsWith('/status')) }]);
  if (measurements.R29RecoveredPageEntries !== undefined) out.measurementDetails.R29RecoveredPageEntries = proof('count', 'Actual entry count returned by the first public recovered queue page', [{ firstPage: view }]);
  out.measurementDetails.R29UnexpectedResubmissionCount = proof('violations', 'A repeated dispatcher submission returns no work and the observed actual POST count remains exactly one', [wireProof]);
  if (measurements.R30CancelEligibleDispatchMs !== undefined) out.measurementDetails.R30CancelEligibleDispatchMs = proof('ms', 'Actual PUT arrival minus the product writer durable cancellation-intent endpoint in the same worker clock', ownEvidence.filter(item => item.kind === 'cancel-dispatch-proof'));
  if (measurements.R30StoppedOrRefundedWithoutEvidenceCount !== undefined) out.measurementDetails.R30StoppedOrRefundedWithoutEvidenceCount = proof('violations', 'Verified actual acknowledged cancellation remains pending until later terminal evidence; no stopped or refunded state was accepted from acknowledgement alone', ownEvidence.filter(item => item.kind === 'cancel-dispatch-proof'));
  out.measurements = measurements; out.measurements.R42BatchOutputs = Number(out.measurements.R42BatchOutputs);
  return out;
}

export async function delay(ms, signal) {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function waitUntilDue(store, job, signal) {
  const due = store.candidates.view(job.id).observation?.nextPollAt ?? 0;
  await delay(Math.max(0, due - Date.now()), signal);
}

function addObservedPhase(phases, name, startMs, endMs) {
  assert(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs);
  phases.push({ name, startMs, endMs, durationMs: endMs - startMs, outcome: 'completed', boundary: 'Actual fixture authority change to observed HTTP request arrival; no synthetic clock advance' });
}

/** Optional fixture-product callback. Both the retained result-bearing request
 * and the separately active request are created through real reviewed commands
 * and the same loopback dispatcher. Preparation is never a scored campaign. */
export async function seedProductCandidates(input) {
  const context = { repo: input.repo ?? process.cwd(), fixture: { root: input.root, corpus: input.corpus }, signal: input.signal }, phases = [];
  const specification = input.specification;
  assert([1, 4].includes(specification.candidates), 'Only named W1/W2 candidate counts are supported');
  const files = input.corpus.files.filter(file => file.role === 'candidate').slice(0, specification.candidates);
  assert.equal(files.length, specification.candidates, 'Retained candidate fixture files required');
  for (const file of files) { const bytes = await readFile(file.path); assert.equal(hash(bytes), file.sha256); assert.equal(String(bytes.length), String(file.byteLength)); }
  const f = { context, root: input.root, documentId: input.documentId, get writer() { return input.writer; } };
  await f.writer.rememberClient(auth().sessionHash, auth().clientId, auth().expires);
  const prepared = await prepareQueue(f, phases, { manifest: { speed: 'BALANCED', expansion: 'None', width: Math.min(specification.width, 3840), height: Math.min(specification.height, 3840), count: specification.candidates, format: 'png' } });
  const completed = await enqueue(f, prepared.body, phases), active = await enqueue(f, prepared.body, phases);
  let evidence;
  await input.withClosedWriter(async ({ configureSnapshotStore } = {}) => {
    const { acquireRoot } = await product(context, 'server/storage/ownership.js'), { StoreDatabase } = await product(context, 'server/storage/database.js');
    const owner = await acquireRoot(input.root), store = new StoreDatabase(input.root, () => {});
    const restoreSnapshotScheduler = configureSnapshotStore?.(store);
    let fixture;
    try {
      fixture = await startFixtureProvider(context, store, completed.job.review.endpoint, { resultFiles: files });
      await fixture.dispatcher.submit(completed.job.id); fixture.controls.status = 'COMPLETED'; await fixture.observer.tick();
      const view = store.candidates.view(completed.job.id); assert.equal(view.items.length, specification.candidates); assert(view.items.every(candidate => candidate.state === 'prepared'));
      fixture.controls.status = 'IN_QUEUE'; await fixture.dispatcher.submit(active.job.id);
      assert.equal(store.queue.recovery(active.job.id, active.job.attempts[0].id).attempt.hold, true);
      assert.equal(fixture.effects.filter(effect => effect.method === 'POST').length, 2);
      evidence = { completedJobId: completed.job.id, activeJobId: active.job.id, candidateIds: view.items.map(candidate => candidate.id), effects: fixture.effects, phases, providerCalls: 0, loopbackSubmissions: 2, activeRecoveryAfterSealing: 'Known attempt remains held; its temporary fixture endpoint is no longer available after sealing' };
    } finally {
      await fixture?.close(); await store.candidates.close(); await store.queue.close(); await store.portables.close(); await store.histories.close(); await store.rasters.close(); await store.assets.close(); await store.recovery.settle(); store.close(); owner.close(); restoreSnapshotScheduler?.();
    }
  });
  return evidence;
}

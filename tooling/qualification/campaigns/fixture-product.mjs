// Production-backed performance fixture preparation. This module never starts a
// network provider, writes SQL, substitutes metadata for images, or runs at import.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const expectedVersions = Object.freeze({ hash: 'sha256:10584db4c85cf1d5cbd2eda3429934a693b7c26268e63be96dbdb23d6dd42069', byteLength: '33', mediaType: 'application/json' });
const specifications = Object.freeze({
  W0: { width: 2048, height: 2048, layers: 0, visible: 0, events: 1, tail: 0, queued: 0, terminal: 0, incomplete: 0, active: 0, candidates: 0 },
  W1: { width: 2048, height: 2048, layers: 20, visible: 5, events: 10000, tail: 500, queued: 100, terminal: 0, incomplete: 100, active: 1, candidates: 1 },
  W2: { width: 5000, height: 5000, layers: 100, visible: 10, events: 100000, tail: 500, queued: 0, terminal: 0, incomplete: 0, active: 1, candidates: 4 },
  // The active fault case is added to an isolated copy by its campaign. Leaving
  // its sole dispatch slot free is an explicit WQ seed precondition.
  WQ: { width: 2048, height: 2048, layers: 20, visible: 5, events: 10000, tail: 500, queued: 1000, terminal: 900, incomplete: 100, active: 0, candidates: 0 },
  WA: { width: 2048, height: 2048, layers: 20, visible: 5, events: 10000, tail: 500, queued: 100, terminal: 0, incomplete: 100, active: 1, candidates: 1, metadataEntries: 100 },
  WXn: { width: 2048, height: 2048, layers: 20, imageLayers: 10, textLayers: 10, visible: 5, visibleImages: 2, visibleText: 3, events: 10000, tail: 500, queued: 0, terminal: 0, incomplete: 0, active: 1, candidates: 1 },
  WXs: { width: 5000, height: 5000, layers: 100, imageLayers: 25, textLayers: 75, visible: 10, visibleImages: 5, visibleText: 5, events: 100000, tail: 500, queued: 0, terminal: 0, incomplete: 0, active: 1, candidates: 4 },
});
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function check(condition, message) { if (!condition) throw new Error('PRODUCT_FIXTURE: ' + message); }
function aborted(signal) { signal?.throwIfAborted(); }

export function productWorkload(workload) {
  const id = typeof workload === 'string' ? workload : workload?.id ?? workload?.name;
  check(Object.hasOwn(specifications, id), 'workload must be W0, W1, W2, WQ, WA, WXn, or WXs');
  const spec = { id, ...specifications[id] };
  if (workload && typeof workload === 'object') {
    // Do not silently turn a scaled smoke run into a named qualification fixture.
    for (const key of Object.keys(specifications[id])) if (Object.hasOwn(workload, key)) check(workload[key] === spec[key], `${id}.${key} cannot be scaled or overridden`);
  }
  return spec;
}

export function planProductFixture({ workload, corpus = { files: [] } }) {
  const spec = productWorkload(workload), files = corpus.files;
  check(Array.isArray(files), 'corpus.files must be an array');
  const originals = files.filter(file => file.role === 'raster-original').sort((a, b) => a.index - b.index);
  const masks = files.filter(file => file.role === 'mask' && ['png', 'image/png'].includes(file.format));
  const candidates = files.filter(file => file.role === 'candidate');
  const imageLayers = spec.imageLayers ?? spec.layers;
  check(originals.length === imageLayers, `${spec.id} requires exactly ${imageLayers} raster originals`);
  check(!spec.layers || masks.length > 0, `${spec.id} requires a generated PNG mask`);
  check(new Set(originals.map(file => file.sha256)).size === originals.length, 'raster originals must have independent encoded identities');
  check(new Set(originals.map(file => file.index)).size === originals.length, 'raster original indexes must be unique');
  const selected = [...originals, ...(spec.layers ? [masks[0]] : []), ...candidates];
  for (const file of selected) {
    check(typeof file.id === 'string' && file.id.length > 0, 'each selected corpus file needs an id');
    check(typeof file.path === 'string' && file.path.length > 0, 'each selected corpus file needs a path');
    check(/^sha256:[a-f0-9]{64}$/.test(file.sha256), 'each selected corpus file needs a SHA-256 identity');
    check(/^[1-9][0-9]*$/.test(file.byteLength), 'each selected corpus file needs an exact byte length');
    check(file.width === spec.width && file.height === spec.height, `${file.id ?? file.path} dimensions do not match ${spec.id}`);
    const limit = spec.width === 5000 ? (file.role === 'mask' ? 8 : 32) : 8;
    check(BigInt(file.byteLength) <= BigInt(limit * 1024 * 1024), `${file.role} exceeds its encoded ${limit} MiB limit`);
  }
  return { specification: spec, originals, mask: spec.layers ? masks[0] : null, candidates,
    executionRequired: true, heavy: spec.id !== 'W0',
    snapshotBoundary: spec.tail ? String(spec.events - spec.tail) : null,
    eventPadding: 'real document SaveCheckpoint commands; stable masked capture uses real same-cap SetSpendGuard workspace events in its final tail; no synthetic events or SQL inserts',
    snapshotPreparation: spec.tail ? 'fixture-only scheduling gate around the production RecoveryStore; normal production snapshot bytes, activation, verification, and tail admission' : null,
    candidateRequirement: spec.candidates ? `${spec.candidates} retained candidates and ${spec.active} active request require an explicit production candidate seeder` : null };
}

/** Internal writer setup hook. Only openWriter's explicit testing.setupModule
 * loads this export; no HTTP, CLI environment, or project file enables it.
 * The final snapshot and all events are written by ordinary production code.
 * We pause automatic snapshot scheduling only around the requested boundary so
 * a fixture can retain the specified, worst-case 500-event recovery tail.
 */
export async function setup(store) {
  const raw = new URL(import.meta.url).searchParams.get('fixtureSnapshotBoundary');
  configureFixtureSnapshotStore(store, raw);
  return async () => {};
}

export function configureFixtureSnapshotStore(store, raw) {
  check(typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw), 'writer fixture hook needs a snapshot boundary');
  const boundary = BigInt(raw), originalMaintain = store.recovery.maintain, originalSettle = store.recovery.settle;
  const maintain = originalMaintain.bind(store.recovery), settle = originalSettle.bind(store.recovery);
  store.recovery.maintain = () => {
    const high = BigInt(store.recovery.highWater());
    if (high <= boundary - 250n || high === boundary) maintain();
  };
  store.recovery.settle = async start => {
    await settle(start);
    if (BigInt(store.recovery.highWater()) === boundary) {
      maintain();
      await settle();
      check(store.recovery.latest()?.seq === raw, 'production snapshot did not activate at the requested boundary');
    }
  };
  return () => { store.recovery.maintain = originalMaintain; store.recovery.settle = originalSettle; };
}

async function inspectFile(file, signal) {
  aborted(signal);
  const before = await lstat(file.path);
  check(before.isFile() && !before.isSymbolicLink(), 'corpus input must be a regular file');
  check(String(before.size) === file.byteLength, 'corpus byte length changed');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file.path, { highWaterMark: 1048576 })) { aborted(signal); hash.update(bytes); }
  const after = await lstat(file.path);
  check(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'corpus changed during verification');
  check('sha256:' + hash.digest('hex') === file.sha256, 'corpus SHA-256 mismatch');
  return after;
}

export async function inspectProductWriter(writer, documentId, { eventAfter = '0', documentJobsOnly = false } = {}) {
  const document = await writer.document(documentId), state = await writer.imageState(documentId), capture = await writer.capture();
  const allJobs = [];
  let cursor = '';
  do { const page = await writer.queueView(cursor); allJobs.push(...page.jobs); cursor = page.nextCursor; } while (cursor);
  const jobs = documentJobsOnly ? allJobs.filter(job => job.documentId === documentId) : allJobs;
  let history = 0, checkpoints = 0;
  for (const kind of ['history', 'checkpoints']) {
    let pageCursor = '';
    do {
      const page = await writer.historyPage(documentId, pageCursor, kind);
      const rows = page.items;
      check(Array.isArray(rows), 'history page protocol changed');
      if (kind === 'history') history += rows.length; else checkpoints += rows.length;
      pageCursor = page.next;
    } while (pageCursor);
  }
  const histogram = {}, documentHistogram = {};
  check(/^(0|[1-9][0-9]*)$/.test(eventAfter) && BigInt(eventAfter) <= BigInt(capture.highWater), 'invalid retained event baseline');
  let after = eventAfter, events = 0;
  while (BigInt(after) < BigInt(capture.highWater)) {
    const page = await writer.events(after, 100);
    check(page.events.length > 0, 'event stream contains a gap');
    for (const event of page.events) {
      check(BigInt(event.workspaceSeq) === BigInt(after) + 1n, 'event stream is not contiguous');
      after = event.workspaceSeq; events++;
      histogram[event.type] = (histogram[event.type] ?? 0) + 1;
      if (event.documentId === documentId) documentHistogram[event.type] = (documentHistogram[event.type] ?? 0) + 1;
    }
  }
  const visible = state.layers.filter(layer => layer.visible);
  const visibleImages = visible.filter(layer => layer.kind === 'image');
  const adapters = [];
  let adapterCursor = '';
  do { const page = await writer.adapterList(adapterCursor); adapters.push(...page.items); adapterCursor = page.nextAfter; } while (adapterCursor);
  let candidateCount = 0, candidateCursor = '';
  do {
    const page = await writer.candidateHistory(documentId, candidateCursor);
    // Count actual candidates through each retained attempt, not generated files.
    for (const item of page.items) {
      let next = '';
      do { const view = await writer.candidateView(item.jobId, item.attemptId, next); candidateCount += view.items.length; next = view.nextCursor; } while (next);
    }
    candidateCursor = page.nextCursor;
  } while (candidateCursor);
  return { document, state, snapshot: capture.snapshot, jobs, adapters,
    globalCounts: { events: Number(capture.highWater), jobs: allJobs.length, active: allJobs.flatMap(job => job.attempts).filter(attempt => attempt.hold).length },
    counts: { events, highWater: capture.highWater, historyNodes: history, historyEdits: Math.max(0, history - 1), checkpoints,
      layers: state.layers.length, rasterLayers: state.layers.filter(layer => layer.kind === 'image').length,
      textLayers: state.layers.filter(layer => layer.kind === 'text').length,
      visible: visible.length, visibleMasked: visible.filter(layer => layer.mask !== null).length,
      visibleTransformed: visible.filter(layer => JSON.stringify(layer.layerToDocument) !== '[1,0,0,1,0,0]').length,
      visibleImages: visibleImages.length, visibleText: visible.filter(layer => layer.kind === 'text').length,
      visibleImageMasked: visibleImages.filter(layer => layer.mask !== null).length,
      visibleImageTransformed: visibleImages.filter(layer => JSON.stringify(layer.layerToDocument) !== '[1,0,0,1,0,0]').length,
      independentLayerIds: new Set(state.layers.map(layer => layer.id)).size,
      independentRasterAssets: new Set(state.layers.filter(layer => layer.kind === 'image').map(layer => layer.assetId)).size,
      jobs: jobs.length, incomplete: jobs.filter(job => job.attempts.some(attempt => ['not-started', 'dispatching', 'acknowledged', 'submission-uncertain'].includes(attempt.state))).length,
      cancelled: jobs.filter(job => job.attempts.at(-1)?.state === 'locally-cancelled').length,
      active: jobs.flatMap(job => job.attempts).filter(attempt => attempt.hold).length,
      candidates: candidateCount, metadataEntries: adapters.length,
      snapshotSeq: capture.snapshot?.seq ?? null,
      snapshotTail: capture.snapshot ? String(BigInt(capture.highWater) - BigInt(capture.snapshot.seq)) : null,
      eventTypes: histogram, documentEventTypes: documentHistogram } };
}

export function productCriteria(specification, counts) {
  const spec = productWorkload(specification);
  const imageLayers = spec.imageLayers ?? spec.layers;
  const rows = [
    ['exact-event-count', counts.events === spec.events], ['exact-raster-layer-count', counts.rasterLayers === imageLayers && counts.layers === spec.layers],
    ['independent-layer-identities', counts.independentLayerIds === spec.layers && counts.independentRasterAssets === imageLayers],
    ['visible-layers-transforms-and-masks', counts.visible === spec.visible && (spec.textLayers
      ? counts.visibleImages === spec.visibleImages && counts.visibleText === spec.visibleText && counts.visibleImageMasked === spec.visibleImages && counts.visibleImageTransformed === spec.visibleImages
      : counts.visibleMasked === spec.visible && counts.visibleTransformed === spec.visible)],
    ['latest-snapshot-500-tail', spec.tail === 0 || counts.snapshotTail === String(spec.tail)],
    ['queued-metadata-count', counts.jobs === spec.queued + (spec.active ? 2 : 0)],
    ['incomplete-job-count', counts.incomplete === spec.incomplete + spec.active],
    ['terminal-job-count', counts.cancelled === spec.terminal], ['active-request-count', counts.active === spec.active],
    ['retained-candidate-count', counts.candidates === spec.candidates],
  ];
  if (spec.textLayers !== undefined) rows.push(['native-text-layer-count', counts.textLayers === spec.textLayers]);
  if (spec.metadataEntries !== undefined) rows.push(['adapter-metadata-entries', counts.metadataEntries === spec.metadataEntries]);
  return rows.map(([id, met]) => ({ id, met }));
}

/**
 * corpus.files: {id,path,sha256,byteLength,role,format,width,height,index}[].
 * W1/W2 optional seedCandidates(context) must use actual production candidate
 * ingestion and add one completed result-bearing job plus one active job. Its
 * absence is explicitly incomplete, never a claim that staged PNGs are results.
 * The helper owns and closes its writer. It leaves a prepared root on failure.
 */
export async function buildProductFixture({ root, repo = process.cwd(), workload, corpus, allowHeavy = false, signal, onProgress = () => {}, seedCandidates, prepareAdditional, prepareNativeLayers, commandTimeoutMs = 300000,
  writer: providedWriter, documentId: requestedDocumentId, retainedWriter, additionalEventReserve = 0 }) {
  const plan = planProductFixture({ workload, corpus }), spec = plan.specification;
  const imageLayers = spec.imageLayers ?? spec.layers, visibleImages = spec.visibleImages ?? spec.visible;
  const externalWriter = providedWriter !== undefined;
  // A masked source is fenced to the exact document revision captured by its
  // seeder. Advertise this requirement before invocation so all checkpoints can
  // precede the capture; the remaining tail uses real workspace metadata facts.
  const stableCandidateCapture = seedCandidates?.requiresStableSourceRevision === true;
  check(spec.id === 'W0' || allowHeavy === true, 'heavy fixture preparation requires allowHeavy:true');
  check(!(seedCandidates || prepareAdditional || prepareNativeLayers) || allowHeavy === true, 'fixture extensions require allowHeavy:true');
  check(!spec.textLayers || typeof prepareNativeLayers === 'function', 'mixed native workload requires actual native layer preparation');
  check(!stableCandidateCapture || typeof seedCandidates === 'function' && spec.layers > 0 && spec.tail > 0, 'stable candidate capture requires a layered workload with a retained tail');
  check(typeof root === 'string' && root.length > 0, 'a fresh root path is required');
  check(Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs > 0, 'command timeout must be finite positive milliseconds');
  check(Number.isSafeInteger(additionalEventReserve) && additionalEventReserve >= 0 && additionalEventReserve < spec.events, 'additional event reserve must be a bounded nonnegative integer');
  root = resolve(root);
  repo = resolve(repo);
  check(externalWriter === (retainedWriter !== undefined), 'external writer requires a declared retainedWriter baseline');
  const baseline = externalWriter ? retainedWriter?.baselineHighWater : '0';
  check(typeof baseline === 'string' && /^(0|[1-9][0-9]*)$/.test(baseline), 'retained workspace needs exact baselineHighWater');
  check(BigInt(baseline) + BigInt(spec.events) <= BigInt(Number.MAX_SAFE_INTEGER), 'fixture counters exceed exact numeric range');
  if (externalWriter) {
    check(typeof requestedDocumentId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestedDocumentId), 'external writer requires a fresh explicit documentId');
    check(!providedWriter.root || resolve(providedWriter.root) === root, 'external writer root does not match');
    check(!plan.snapshotBoundary || typeof retainedWriter.snapshotBoundaryController === 'function', 'external writer requires an explicit fixture snapshot scheduler controller');
  } else {
    check(requestedDocumentId === undefined || /^[A-Za-z0-9_-]{1,128}$/.test(requestedDocumentId), 'invalid document id');
    await mkdir(root, { mode: 0o700, recursive: true });
    check((await readdir(root)).length === 0, 'root must be empty; existing evidence is never overwritten');
  }
  for (const file of [...plan.originals, ...(plan.mask ? [plan.mask] : []), ...plan.candidates]) await inspectFile(file, signal);
  const { openWriter } = externalWriter ? { openWriter: null } : await import(pathToFileURL(resolve(repo, 'dist/local/server/storage/writer.js')).href);
  const { newDraft } = await import(pathToFileURL(resolve(repo, 'dist/local/src/request/core.js')).href);
  const hook = new URL(import.meta.url);
  const snapshotBoundary = plan.snapshotBoundary ? String(BigInt(baseline) + BigInt(plan.snapshotBoundary)) : null;
  if (snapshotBoundary) hook.searchParams.set('fixtureSnapshotBoundary', snapshotBoundary);
  let writer = providedWriter ?? await openWriter({ root }, snapshotBoundary ? { setupModule: hook.href } : undefined);
  const clientId = 'qualification_fixture', sessionId = externalWriter ? 'fixture_session_' + randomUUID() : 'qualification_fixture', sessionHash = createHash('sha256').update(randomUUID()).digest('hex');
  const auth = () => ({ clientId, sessionHash, now: Date.now(), expires: Date.now() + 7 * 86400000 });
  const documentId = requestedDocumentId ?? 'qualification_' + spec.id.toLowerCase(), originals = [], rasterAssets = [], layerIds = [], commandCounts = {};
  let eventCount = 0, maskAsset = null, submitted = 0, native = null, additionalEvidence = null, candidateEvidence = null;
  let candidateSeedEvents = 0, postCaptureSpendGuardEvents = 0;
  let restoreSnapshotController;
  const readEventCount = async () => Number(BigInt((await writer.capture()).highWater) - BigInt(baseline));
  const emit = async (phase, detail = {}) => { aborted(signal); await onProgress({ phase, workload: spec.id, eventCount, submitted, ...detail }); };
  const command = (body, scoped = false, revision = null) => ({ protocolVersion: 1, command: {
    schemaVersion: 1, commandId: randomUUID(), clientId, sessionId, correlationId: randomUUID(), causationId: null,
    transactionId: randomUUID(), documentId: scoped ? documentId : null, expectedDocumentRevision: revision,
    expectedEntityVersions: expectedVersions, issuedAt: new Date().toISOString(), body,
  } });
  async function execute(body, method, scoped = false) {
    aborted(signal);
    const request = command(body, scoped, scoped ? await writer.documentRevision(documentId) : null), began = performance.now();
    let receipt = method === 'submit' ? await writer.submit(encode(request), writer.epoch) : await writer[method](encode(request), auth());
    while (!receipt) {
      aborted(signal); check(performance.now() - began < commandTimeoutMs, `${body.type} did not produce a durable receipt before timeout`);
      await delay(5, undefined, { signal }); receipt = (await writer.lookup(request.command.commandId))?.receipt;
    }
    if (receipt.status !== 'accepted') {
      const detail = receipt.details ? Buffer.from(await writer.readMetadata(receipt.details)).toString('utf8') : '';
      throw new Error(`PRODUCT_FIXTURE: ${body.type} rejected: ${receipt.code}: ${detail}`);
    }
    const events = (await writer.events(String(BigInt(receipt.fromSeq) - 1n), 100)).events.filter(event => event.commandId === request.command.commandId);
    check(events.length === Number(BigInt(receipt.toSeq) - BigInt(receipt.fromSeq) + 1n), 'accepted receipt event range changed');
    eventCount = Number(BigInt(receipt.toSeq) - BigInt(baseline)); submitted++; commandCounts[body.type] = (commandCounts[body.type] ?? 0) + 1;
    return { receipt, events };
  }
  function registered(result) { const asset = result.events.find(event => event.type === 'AssetRegistered')?.payload.asset; check(asset, 'asset command did not register an asset'); return asset; }
  async function stage(source, purpose = 'image', mediaTypeOverride) {
    const buffer = Buffer.isBuffer(source) ? source : null, length = buffer ? String(buffer.length) : source.byteLength;
    const sha256 = buffer ? digest(buffer) : source.sha256;
    const mediaType = mediaTypeOverride ?? (purpose === 'caption' ? 'text/plain' : ['font', 'text', 'adapter', 'bundle'].includes(purpose) ? 'application/octet-stream' : /^(?:jpeg|jpg|image\/jpeg)$/.test(source.format) ? 'image/jpeg' : 'image/png');
    const stagingId = randomUUID();
    await writer.assetCreate({ protocolVersion: 1, stagingId, purpose, expectedBytes: length, sha256, mediaType }, auth());
    let offset = 0;
    const chunks = buffer ? [buffer] : createReadStream(source.path, { highWaterMark: 1048576 });
    const consumed = createHash('sha256');
    for await (const bytes of chunks) {
      aborted(signal);
      for (let at = 0; at < bytes.length; at += 1048576) {
        const chunk = bytes.subarray(at, at + 1048576), token = await writer.assetBeginChunk(stagingId, String(offset), chunk.length, auth());
        await writer.assetChunk(token, chunk, auth()); consumed.update(chunk); offset += chunk.length;
      }
    }
    check(String(offset) === length && 'sha256:' + consumed.digest('hex') === sha256, 'corpus changed during upload');
    return registered(await execute({ type: 'FinalizeStaging', stagingId, expectedSha256: sha256 }, 'assetCommand'));
  }
  async function importRaster(file) {
    const original = await stage(file), preview = registered(await execute({ type: 'PrepareRaster', assetId: original.id }, 'rasterCommand'));
    const reviewEvent = (await execute({ type: 'ReviewRaster', assetId: preview.id }, 'rasterCommand')).events.find(event => event.type === 'RasterReviewPrepared');
    check(reviewEvent, 'raster conversion review missing');
    const review = await writer.rasterReview(reviewEvent.payload.reviewId, auth());
    const asset = registered(await execute({ type: 'ApproveRaster', assetId: preview.id, reviewId: review.reviewId, reviewHash: review.reviewHash }, 'rasterCommand'));
    check(asset.raster?.width === spec.width && asset.raster?.height === spec.height, 'decoder produced unexpected dimensions');
    return { original, asset };
  }
  async function ui(body) {
    const current = await writer.uiRead(sessionId, auth());
    const reply = await writer.uiPersist(encode({ protocolVersion: 1, requestId: randomUUID(), sessionId, expectedUISeq: current.uiSeq, body }), auth());
    check(reply.status === 'accepted', `UI preparation rejected ${body.type}: ${JSON.stringify(reply)}`);
    return reply;
  }
  async function checkpoint() {
    const document = await writer.document(documentId);
    await execute({ type: 'SaveCheckpoint', name: `Qualification retained event ${eventCount + 1}` }, document.image ? 'historyCommand' : 'submit', true);
    if (submitted % 100 === 0) await emit('document-history');
  }
  async function padTo(target) {
    check(eventCount <= target, `actual setup events ${eventCount} exceeded requested boundary ${target}`);
    while (eventCount < target) await checkpoint();
  }
  async function assertCandidateCapture(phase) {
    check(candidateEvidence?.requiresStableSourceRevision === true, 'masked seeder must retain its stable source requirement in evidence');
    check(typeof candidateEvidence.capturedDocumentRevision === 'string' && /^[1-9][0-9]*$/.test(candidateEvidence.capturedDocumentRevision), 'masked seeder must retain its exact captured document revision');
    check(candidateEvidence.captureImage && typeof candidateEvidence.captureImage === 'object', 'masked seeder must retain its exact captured image version');
    const document = await writer.document(documentId);
    check(document?.revision === candidateEvidence.capturedDocumentRevision, `masked source revision changed ${phase}`);
    check(canonical(document.image) === canonical(candidateEvidence.captureImage), `masked source image changed ${phase}`);
  }
  async function padStableTail(target) {
    check(eventCount <= target, `actual masked seed events ${eventCount} exceeded requested total ${target}`);
    while (eventCount < target) {
      const { session } = await writer.queueView(''), before = eventCount;
      const result = await execute({ type: 'SetSpendGuard', spendSessionId: session.id, expectedConfigVersion: session.version, cap: session.cap }, 'queueCommand');
      check(result.events.length === 1 && result.events[0].type === 'SpendGuardChanged' && result.events[0].documentId === null && eventCount === before + 1,
        'same-cap spend guard must produce exactly one workspace event');
      postCaptureSpendGuardEvents++;
      if (postCaptureSpendGuardEvents % 100 === 0) await emit('workspace-metadata-tail');
    }
    await assertCandidateCapture('after final workspace tail');
  }
  // Some qualification helpers exercise the production StoreDatabase directly
  // (e.g. an emulator's candidate observer). Give them exclusive root ownership
  // and then restart the ordinary worker. They must close their own handles.
  async function withClosedWriter(operation) {
    check(!externalWriter, 'external writer mode cannot close or replace its owned writer; use a live provider bridge');
    check(typeof operation === 'function', 'exclusive store operation must be a function');
    await writer.close();
    try { return await operation({ root, repo, documentId, specification: spec, signal,
      configureSnapshotStore: store => snapshotBoundary ? configureFixtureSnapshotStore(store, snapshotBoundary) : () => {} }); }
    finally {
      writer = await openWriter({ root }, plan.snapshotBoundary ? { setupModule: hook.href } : undefined);
      eventCount = await readEventCount();
    }
  }
  const extensionContext = () => ({ get writer() { return writer; }, root, repo, documentId, clientId, sessionId, auth, execute, stage, importRaster, registered, ui, padTo,
    imageLayerIds: [...layerIds], rasterAssetIds: rasterAssets.map(asset => asset.id), maskAssetId: maskAsset?.id ?? null,
    withClosedWriter, corpus, specification: spec, signal });
  try {
    if (externalWriter) {
      check((await writer.capture()).highWater === baseline, 'retained workspace baseline changed before fixture preparation');
      check(await writer.document(documentId) === null, 'retained workspace documentId is already present');
      if (snapshotBoundary) restoreSnapshotController = await retainedWriter.snapshotBoundaryController({ writer, boundary: snapshotBoundary, signal });
      check(restoreSnapshotController === undefined || typeof restoreSnapshotController === 'function', 'snapshot controller must return a restore function or undefined');
    }
    await writer.rememberClient(sessionHash, clientId, auth().expires);
    await writer.protocolDefaults();
    await execute({ type: 'NewDocument', width: spec.width, height: spec.height, color: 'sRGB', depth: 8 }, 'submit', true);
    for (const [index, file] of plan.originals.entries()) {
      const result = await importRaster(file); originals.push(result.original); rasterAssets.push(result.asset);
      await emit('raster-import', { completed: index + 1, total: imageLayers });
    }
    if (plan.mask) {
      const maskInput = await importRaster(plan.mask);
      maskAsset = registered(await execute({ type: 'PrepareMask', plan: { width: spec.width, height: spec.height, feather: 0,
        operations: [{ kind: 'import', assetId: maskInput.asset.id, x: 0, y: 0, width: spec.width, height: spec.height, inverted: false }] } }, 'rasterCommand'));
    }
    if (spec.queued) {
      const prompt = await stage(Buffer.from('Deterministic local qualification request. No remote provider is configured.'), 'caption'), draft = newDraft(prompt.blob);
      draft.fields.expansion = 'None'; draft.fields.width = String(Math.min(spec.width, 3840)); draft.fields.height = String(Math.min(spec.height, 3840));
      const saved = await stage(encode(draft), 'caption');
      await ui({ type: 'SaveDraft', draft: { id: 'qualification_request', generation: '1', kind: 'request', documentId, targetLayerId: null,
        expectedDocumentRevision: await writer.documentRevision(documentId), assetId: saved.id, composing: false } });
      let body;
      for (let index = 0; index < spec.queued; index++) {
        if (index % 50 === 0) {
          const review = await ui({ type: 'PrepareRequestReview', draftId: 'qualification_request', generation: '1' });
          const accepted = await ui({ type: 'AcceptRequestReview', reviewId: review.review.id, token: review.review.token });
          body = { type: 'QueueInference', reviewId: review.review.id, token: review.review.token, acceptanceId: accepted.requestId };
        }
        const queued = await execute(body, 'queueCommand'), job = queued.events.find(event => event.type === 'JobQueued')?.payload;
        check(job, 'queue command did not publish a job');
        if (index < spec.terminal) await execute({ type: 'CancelUnstartedJob', jobId: job.id, expectedVersion: job.version }, 'queueCommand');
        if (index % 25 === 0) await emit('queue-metadata', { completed: index + 1, total: spec.queued });
      }
    }
    // Adapter-library preparation can add real assets/commands before event
    // padding. Native mixed documents have separate workload definitions and
    // should use their own builder rather than relabeling W1/W2 raster counts.
    if (prepareAdditional) {
      additionalEvidence = await prepareAdditional(extensionContext()) ?? null;
      eventCount = await readEventCount();
      check(!(await writer.document(documentId)).image, 'prepareAdditional must preserve the empty document before bulk history preparation');
    }
    if (spec.layers) {
      // Retain most document checkpoints before importing layers, so creating
      // 100k history events does not re-hash 100 full rasters 100k times. This is
      // preparation outside measured cells. The remaining checkpoint commands
      // prove complete image dependencies after ordinary layer assembly. A
      // masked candidate seed follows the boundary and retains its revision.
      // Native preparation persists five worker outputs plus the draft/text,
      // then admits the text asset/composite/history and hidden-layer change.
      // Its real event count is larger than an ordinary raster import.
      const reserve = spec.layers * 8 + (spec.textLayers ?? 0) * 2 + 250 + additionalEventReserve;
      await padTo(spec.events - spec.tail - reserve);
      // Hidden layers first bounds intermediate composites during setup.
      const indexes = [...Array(imageLayers).keys()].sort((a, b) => Number(a < visibleImages) - Number(b < visibleImages) || a - b);
      for (const index of indexes) {
        const layerId = `fixture_layer_${String(index).padStart(3, '0')}`; layerIds[index] = layerId;
        await execute({ type: 'ImportAsset', assetId: rasterAssets[index].id, layerId, name: `Raster ${index + 1}`, draft: null }, 'historyCommand', true);
        if (index >= visibleImages) await execute({ type: 'SetLayerProperties', layerId, layerVersion: '1', properties: { visible: false }, draft: null }, 'historyCommand', true);
        else {
          await execute({ type: 'ApplyTransform', layerId, layerVersion: '1', transform: [1, 0, 0, 1, index + 1, -(index + 1)], draft: null }, 'historyCommand', true);
          await execute({ type: 'SetLayerProperties', layerId, layerVersion: '2', properties: { mask: { assetId: maskAsset.id, mapping: 'document-r16-v1', inverted: false } }, draft: null }, 'historyCommand', true);
        }
        await emit('document-layers', { completed: indexes.indexOf(index) + 1, total: imageLayers });
      }
      if (prepareNativeLayers) {
        native = await prepareNativeLayers(extensionContext());
        check(Array.isArray(native?.layerIds) && native.layerIds.length === spec.layers && new Set(native.layerIds).size === spec.layers, 'native hook must return every independently addressable layer id');
        const actual = await writer.imageState(documentId);
        check(actual.layers.length === spec.layers && native.layerIds.every(id => actual.layers.some(layer => layer.id === id)), 'native hook returned nonexistent or omitted layers');
        layerIds.splice(0, layerIds.length, ...native.layerIds);
        eventCount = await readEventCount();
      }
      await execute({ type: 'MoveLayers', orderedLayerIds: layerIds, draft: null }, 'historyCommand', true);
      if (seedCandidates && !stableCandidateCapture) {
        const beforeSeed = eventCount;
        candidateEvidence = await seedCandidates(extensionContext()) ?? null;
        eventCount = await readEventCount();
        candidateSeedEvents = eventCount - beforeSeed;
        check(candidateEvidence?.requiresStableSourceRevision !== true, 'stable candidate seeder must advertise requiresStableSourceRevision before capture');
      }
      await padTo(spec.events - spec.tail);
      const boundary = await writer.capture();
      check(boundary.snapshot?.seq === snapshotBoundary, 'exact pre-tail production snapshot is missing');
      if (stableCandidateCapture) {
        const beforeSeed = eventCount;
        candidateEvidence = await seedCandidates(extensionContext()) ?? null;
        eventCount = await readEventCount();
        candidateSeedEvents = eventCount - beforeSeed;
        await assertCandidateCapture('after masked candidate seeding');
        await padStableTail(spec.events);
      } else await padTo(spec.events);
    }
    const inspectOptions = { eventAfter: baseline, documentJobsOnly: externalWriter };
    const before = await inspectProductWriter(writer, documentId, inspectOptions);
    if (!externalWriter) await writer.close();
    // Normal restart has no scheduler override. Merely opening/reading the
    // fixture does not write new domain events or perform remote work.
    if (!externalWriter) writer = await openWriter({ root });
    const observed = externalWriter ? before : await inspectProductWriter(writer, documentId, inspectOptions);
    if (stableCandidateCapture) await assertCandidateCapture(externalWriter ? 'after retained-writer observation' : 'after normal production restart');
    check(canonical(before.counts) === canonical(observed.counts), 'observed counts changed after production restart');
    check(canonical(before.document) === canonical(observed.document), 'document changed after production restart');
    const criteria = productCriteria(spec, observed.counts);
    const result = { schemaVersion: 1, kind: 'ideogram-product-performance-fixture', root, repo, workload: spec,
      documentId, layerIds, originalAssetIds: originals.map(asset => asset.id), rasterAssetIds: rasterAssets.map(asset => asset.id), maskAssetId: maskAsset?.id ?? null,
      jobIds: observed.jobs.map(job => job.id), snapshot: observed.snapshot, counts: observed.counts, commandCounts, criteria, native,
      extensions: { additional: additionalEvidence, candidates: candidateEvidence },
      status: criteria.every(row => row.met) ? externalWriter ? 'prepared-accumulated-workspace' : 'complete' : 'incomplete',
      provider: 'disabled; no live provider calls authorized by fixture preparation',
      preparation: { productionRestartVerified: !externalWriter, retainedWriter: externalWriter, snapshotSchedulingOverride: !!plan.snapshotBoundary, directSQLWrites: false,
        checkpointPlacement: stableCandidateCapture
          ? 'bulk before raster-layer assembly; remaining document checkpoints through snapshot boundary; masked candidate preparation and same-cap workspace spend-guard events form the final500tail'
          : 'bulk before raster-layer assembly; exact final500after full image assembly',
        eventPadding: { documentCheckpointEvents: observed.counts.eventTypes.CheckpointSaved ?? 0,
          workspaceSpendGuardEvents: observed.counts.eventTypes.SpendGuardChanged ?? 0, postCaptureSpendGuardEvents, candidateSeedEvents,
          eventTypes: observed.counts.eventTypes, documentEventTypes: observed.counts.documentEventTypes },
        stableCandidateCapture, candidateCaptureVerifiedAfterRestart: stableCandidateCapture && !externalWriter,
        additionalEventReserve,
        activeCandidateSeeder: !!seedCandidates, additionalPreparation: !!prepareAdditional, wqActiveSlot: spec.id === 'WQ' ? 'intentionally free before scenario isolation' : null },
      inputIdentities: [...plan.originals, ...(plan.mask ? [plan.mask] : []), ...plan.candidates].map(({ id, sha256, byteLength, role }) => ({ id, sha256, byteLength, role })) };
    if (externalWriter) result.retainedWorkspace = { baselineHighWater: baseline, highWater: observed.counts.highWater,
      eventDelta: observed.counts.events, globalCounts: observed.globalCounts,
      documentCounts: { layers: observed.counts.layers, imageLayers: observed.counts.rasterLayers, textLayers: observed.counts.textLayers,
        historyNodes: observed.counts.historyNodes, checkpoints: observed.counts.checkpoints, jobs: observed.counts.jobs, candidates: observed.counts.candidates,
        events: Object.values(observed.counts.documentEventTypes).reduce((sum, count) => sum + count, 0), eventTypes: observed.counts.documentEventTypes },
      perSampleCriteriaMet: criteria.every(row => row.met), canonicalGlobal: false, qualification: 'inconclusive',
      writerPreserved: true, limitation: 'The continuously owned workspace retains prior global history and metadata. This is an actual warm reset diagnostic, not a canonical fresh W0/W1/W2/WQ/WA/WX workload qualification.' };
    result.observed = { productionValidated: result.status === 'complete', width: observed.document.width, height: observed.document.height,
      layers: observed.counts.layers, imageLayers: observed.counts.rasterLayers, textLayers: observed.state.layers.filter(layer => layer.kind === 'text').length,
      visibleLayers: observed.counts.visible, events: spec.id === 'W0' ? 0 : observed.counts.events, storeEvents: observed.counts.events,
      snapshotTail: observed.counts.snapshotTail === null ? 0 : Number(observed.counts.snapshotTail),
      queued: spec.id === 'WQ' ? observed.counts.jobs : observed.jobs.filter(job => job.attempts.at(-1)?.state === 'not-started').length,
      candidates: observed.counts.candidates, incompleteJobs: observed.counts.incomplete, active: observed.counts.active, metadataEntries: observed.counts.metadataEntries };
    result.seal = { algorithm: 'sha256-canonical-json', sha256: digest(canonical(result)), scope: 'this receipt before the seal field; parent owns the complete closed-root file manifest' };
    await emit('complete', { status: result.status, counts: result.counts });
    return result;
  } finally {
    if (externalWriter) await restoreSnapshotController?.();
    else await writer.close();
  }
}

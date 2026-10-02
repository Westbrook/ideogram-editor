import test from 'node:test';
import assert from 'node:assert/strict';
import { exerciseQueueConnection, bindWQOwner } from '../../tooling/qualification/campaigns/backend-wq-cache.mjs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auth, createDocument, createProductFixture, hash } from '../../tooling/qualification/campaigns/backend-common.mjs';
import { prepareQueue, enqueue, fastManifest, runCell as runFastCell } from '../../tooling/qualification/campaigns/backend-queue.mjs';
import { writeExactSizePNG } from '../../tooling/qualification/campaigns/fixtures.mjs';
import { prepareFastWarmProof, observeFastWarmState, fastWarmDigest, readFastStorageSummary } from '../../tooling/qualification/campaigns/backend-fast-warm-proof.mjs';
import { resetWarmProductFixture } from '../../tooling/qualification/campaigns/backend-reset.mjs';

const enabled = process.env.IE_CAMPAIGN_PRODUCT_INTEGRATION === '1';
async function prepared(t, bridge = false) {
  const output = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-warm-reset-'));
  const context = { repo: process.cwd(), output, queueFixture: bridge, fixture: { corpus: { files: [] } } };
  const f = await createProductFixture(context);
  t.after(async () => { await f.close(); await rm(output, { recursive: true, force: true }); });
  await createDocument(f);
  return { f, context };
}

test('real production W0 warm resets keep one writer epoch and retain truthful accumulated history', { skip: !enabled }, async t => {
  const { f, context } = await prepared(t), writer = f.writer, epoch = writer.epoch, original = f.documentId;
  const first = await resetWarmProductFixture(f, context, { id: 'warm-W0', workload: 'W0' }, { cache: 'warm', ordinal: 0, prime: true });
  const firstId = f.documentId;
  const second = await resetWarmProductFixture(f, context, { id: 'warm-W0', workload: 'W0' }, { cache: 'warm', ordinal: 1, prime: false });
  assert.equal(f.writer, writer); assert.equal(writer.epoch, epoch);
  assert.notEqual(firstId, original); assert.notEqual(f.documentId, firstId);
  assert.equal(await writer.document(original), null); assert.equal(await writer.document(firstId), null);
  for (const value of [first, second]) {
    assert.equal(value.status, 'pass'); assert.equal(value.qualification.status, 'inconclusive');
    assert.equal(value.observations.rebuilt.status, 'prepared-accumulated-workspace');
    assert.equal(value.observations.rebuilt.counts.events, 1);
    assert.equal(value.observations.rebuilt.retainedWorkspace.canonicalGlobal, false);
    assert.equal(value.observations.rebuilt.preparation.productionRestartVerified, false);
    assert.equal(value.observations.rebuilt.observed.productionValidated, false);
    assert.equal(value.observations.spendSessionReset[0].body.type, 'StartSpendSession');
  }
  assert(BigInt(second.observations.globalHighWater.afterReseed) > BigInt(first.observations.globalHighWater.afterReseed));
});

test('a failed real W0 reseed retains its document identity so the next reset cleans it', { skip: !enabled }, async t => {
  const { f, context } = await prepared(t), writer = f.writer, before = f.documentId;
  context.trace = async () => { throw Error('fixture receipt sink interrupted'); };
  await assert.rejects(resetWarmProductFixture(f, context, { id: 'warm-W0', workload: 'W0' }, { cache: 'warm', ordinal: 0 }), /fixture receipt sink interrupted/);
  const interruptedDocument = f.documentId;
  assert.notEqual(interruptedDocument, before); assert(await writer.document(interruptedDocument));
  context.trace = undefined;
  const resumed = await resetWarmProductFixture(f, context, { id: 'warm-W0', workload: 'W0' }, { cache: 'warm', ordinal: 1 });
  assert.equal(resumed.observations.previousDocumentId, interruptedDocument);
  assert.equal(await writer.document(interruptedDocument), null); assert.equal(f.writer, writer);
});

for (const uncertain of [false, true]) test('real retained loopback ' + (uncertain ? 'lost acknowledgment' : 'known request') + ' is disposed without writer restart or another submit', { skip: !enabled }, async t => {
  const { f, context } = await prepared(t, true), writer = f.writer, epoch = writer.epoch, phases = [];
  const preparedRequest = await prepareQueue(f, phases), queued = await enqueue(f, preparedRequest.body, phases);
  const endpoint = queued.job.review.endpoint;
  await f.queueWorker.configure(endpoint, { dropAcknowledgement: uncertain });
  if (uncertain) await assert.rejects(f.queueWorker.submit(queued.job.id), { code: 'INTERRUPTED' });
  else await f.queueWorker.submit(queued.job.id);
  const before = await f.queueWorker.snapshot(endpoint);
  assert.equal(before.effects.filter(effect => effect.method === 'POST').length, 1);
  const result = await resetWarmProductFixture(f, context, { id: 'warm-WF', workload: 'WF' }, { cache: 'warm', ordinal: 1, prime: false });
  assert.equal(f.writer, writer); assert.equal(writer.epoch, epoch);
  const all = await writer.queueView(''), retained = all.jobs.find(job => job.id === queued.job.id), attempt = retained.attempts[0];
  assert.equal(retained.disposition, 'deleted'); assert.equal(attempt.hold, false);
  assert.equal(attempt.state, uncertain ? 'submission-uncertain' : 'provider-terminal');
  if (uncertain) {
    assert.equal(attempt.requestId, null); assert.equal(attempt.override, true);
    const evidence = result.observations.disposal.reconciliations[0];
    assert.equal(evidence.remoteStatusKnown, false); assert.equal(evidence.actualChargeKnown, false);
    assert.equal(evidence.closure.closed, true);
    assert.equal(evidence.closure.effects.filter(effect => effect.method === 'POST').length, 1);
  } else assert.equal(attempt.terminal, 'cancelled');
  assert.equal(result.observations.writerWorkerRestarted, false);
  assert.equal(result.qualification.status, 'inconclusive');
});

test('connection cache reads use the actual reopened writer and leave its small product journal unchanged', { skip: !enabled }, async t => {
  // This small real document verifies connection warming and ownership only;
  // it does not stand in for a complete 1,000-job WQ qualification fixture.
  const { f } = await prepared(t), previous = f.writer, previousEpoch = previous.epoch;
  await f.reopen();
  const writer = f.writer, epoch = writer.epoch, calls = [];
  assert.notEqual(writer, previous); assert.notEqual(epoch, previousEpoch); assert.equal(previous.available, false);
  const before = await writer.capture(), queueBefore = await writer.queueView('');
  const reader = Object.fromEntries(['document', 'imageState', 'capture', 'queueView'].map(name => [name, async (...args) => {
    calls.push({ name, args, writer, epoch: writer.epoch });
    return writer[name](...args);
  }]));
  const first = await exerciseQueueConnection(reader, f.documentId);
  const second = await exerciseQueueConnection(reader, f.documentId);
  assert.deepEqual(second, first, 'The same read-only public state has one stable bounded observation');
  assert.equal(first.documentId, f.documentId); assert.equal(first.width, 512); assert.equal(first.height, 512);
  assert.equal(first.queue.jobs, queueBefore.totalJobs); assert.equal(first.highWater, before.highWater);
  for (const hash of [first.documentHash, first.imageHash, first.queue.sha256]) assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  for (const name of ['document', 'imageState', 'capture', 'queueView']) assert(calls.some(call => call.name === name), name);
  for (const call of calls) {
    assert.equal(call.writer, writer); assert.equal(call.epoch, epoch);
    if (['document', 'imageState'].includes(call.name)) assert.deepEqual(call.args, [f.documentId]);
  }
  const after = await writer.capture(), queueAfter = await writer.queueView('');
  assert.equal(after.highWater, before.highWater); assert.deepEqual(after.snapshot, before.snapshot);
  assert.deepEqual(queueAfter.jobs, queueBefore.jobs); assert.deepEqual(queueAfter.counts, queueBefore.counts);
  assert.equal(f.writer, writer); assert.equal(f.writer.epoch, epoch);
});

test('the real queue worker cache owner remains exact through public reads and fences a later reopen', { skip: !enabled }, async t => {
  const { f } = await prepared(t, true), writer = f.writer, control = f.queueWorker;
  const original = await control.cacheOwner(), guard = await bindWQOwner(() => f.queueWorker.cacheOwner());
  assert.equal(original.epoch, writer.epoch); assert.equal(original.root, f.root);
  assert.equal(original.threadId, control.descriptor.threadId);
  assert.deepEqual(await guard(), original);
  await exerciseQueueConnection(writer, f.documentId);
  assert.deepEqual(await guard(), original);
  await f.reopen();
  const replacement = await f.queueWorker.cacheOwner();
  assert.notEqual(f.writer, writer); assert.equal(writer.available, false); assert.notEqual(f.queueWorker, control);
  assert.equal(replacement.root, original.root); assert.notEqual(replacement.epoch, original.epoch);
  assert.notEqual(replacement.connectionId, original.connectionId); assert.notEqual(replacement.threadId, original.threadId);
  assert.deepEqual(replacement.sources, original.sources);
  await assert.rejects(guard, /WQ measurement owner changed/);
});

test('actual direct-store warming is bound to that connection and cannot survive its replacement', { skip: !enabled }, async t => {
  const { f } = await prepared(t, true), writer = f.writer, workerOwner = await f.queueWorker.cacheOwner();
  const store = await f.direct(), directOwner = await f.directIdentity(store), guard = await bindWQOwner(() => f.directIdentity(store));
  assert.equal(writer.available, false); assert.equal(directOwner.root, workerOwner.root);
  assert.notEqual(directOwner.epoch, workerOwner.epoch); assert.notEqual(directOwner.connectionId, workerOwner.connectionId);
  const before = store.recovery.capture();
  const read = await exerciseQueueConnection({ capture: () => store.recovery.capture(), document: id => store.document(id),
    imageState: id => store.histories.state(id), queueView: after => store.queue.view(after) }, f.documentId);
  assert.equal(read.highWater, before.highWater); assert.deepEqual(store.recovery.capture(), before); assert.deepEqual(await guard(), directOwner);
  await f.closeDirect(); const replacement = await f.direct(), replacementOwner = await f.directIdentity(replacement);
  assert.notEqual(replacement, store); assert.notEqual(replacementOwner.epoch, directOwner.epoch); assert.notEqual(replacementOwner.connectionId, directOwner.connectionId);
  await assert.rejects(guard, /WQ direct owner changed/);
});

// These actual selected inputs exercise helper components in a small product
// fixture. They do not stand in for the complete 24-input WF qualification seal.
async function selectedFastPrepared(t, caseId) {
  const output = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-fast-warm-reset-'));
  let f;
  t.after(async () => { try { await f?.close(); } finally { await rm(output, { recursive: true, force: true }); } });
  let bytes = null, path = null; const files = [];
  if (caseId !== 'WF10') {
    const sharp = (await import('sharp')).default;
    bytes = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 17, g: 83, b: 141, alpha: 1 } } }).png().toBuffer();
    path = join(output, 'wf-512-png-0.png'); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    files.push({ id: 'wf-512-png-0', role: 'fast-candidate', width: 512, height: 512, format: 'png', index: 0, path, byteLength: String(bytes.length), sha256: hash(bytes) });
  }
  if (caseId === 'WF13') {
    const faultPath = join(output, 'wf-fault-8MiB.png');
    files.push({ id: 'wf-fault-8MiB', role: 'fast-fault-candidate', path: faultPath, width: 512, height: 512, format: 'png', index: 0,
      ...await writeExactSizePNG(faultPath, path, 8 * 1024 * 1024) });
  }
  const corpus = { files, fast: { validFamilies: fastManifest } };
  const manifest = Buffer.from(JSON.stringify({ kind: 'focused-WF-warm-reset-component-input', corpus }));
  const manifestPath = join(output, 'fixture.json'); await writeFile(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
  const cell = { id: 'component/warm-' + caseId, handler: 'backend', operation: 'fast.workflow', workload: 'WF', parameters: { caseId } };
  const context = { repo: process.cwd(), output, queueFixture: true, queueFixtureCell: cell,
    fixture: { corpus, seal: { path: manifestPath, sha256: hash(manifest) } } };
  f = await createProductFixture(context); await createDocument(f, { width: 2048, height: 2048 });
  return { f, context, cell, path, bytes };
}

async function selectedFastSample(f, context, cell, sample, reset, previous = null) {
  const session = await prepareFastWarmProof(f, context, cell, sample, { reset, previous });
  const preparation = reset.fastWarmPreparation;
  for (const key of ['documentId', 'documentHash', 'imageHash', 'width', 'height', 'layers', 'highWater', 'snapshot', 'queue']) assert.deepEqual(preparation.warmed[key], preparation.base[key], key);
  assert.equal(preparation.warmed.storage.epoch, preparation.base.storage.epoch); assert.equal(preparation.warmed.storage.registeredObjects.complete, true);
  assert(preparation.warmed.reads.includes('all-queue-pages')); assert(preparation.warmed.reads.includes('storageSummary'));
  assert.equal(preparation.cacheProfile.additionalScenarioPrimes, 0);
  assert.equal(preparation.base.queue.active, 0); assert.equal(preparation.base.layers, 0);
  assert(!preparation.base.queue.jobs.some(job => job.documentId === f.documentId));
  await session.enter();
  const outcome = await runFastCell({ ...context, productFixture: f, ...session.runContext }, cell);
  assert.notEqual(outcome.status, 'fail');
  const packet = await session.finish(outcome);
  const page = await f.writer.queueView(''), job = page.jobs.find(row => row.id === outcome.observations.jobId);
  assert(job); assert.equal(job.documentId, f.documentId);
  const draftId = job.review.draft.draftId, draft = (await f.writer.uiRead('request_session', auth())).drafts.find(row => row.id === draftId);
  assert(draft); assert.equal(draft.documentId, f.documentId); assert.equal(draft.status, 'saved-unapplied');
  assert.equal(outcome.observations.effects.filter(effect => effect.method === 'POST').length, 1);
  assert.equal(outcome.fastWarmInput.verdict.complete, true);
  assert.equal(packet.preparation.selected.fixtureSeal, context.fixture.seal.sha256);
  const artifact = await readFile(outcome.fastWarmInput.artifact.path);
  assert.equal(artifact.length, outcome.fastWarmInput.artifact.bytes); assert.equal(fastWarmDigest(artifact), outcome.fastWarmInput.artifact.sha256);
  assert.deepEqual(JSON.parse(artifact), packet);
  return { outcome, packet, job, draftId };
}

async function assertSelectedFastCleanup(f, reset, prior) {
  const observations = reset.observations, disposal = observations.disposal;
  assert.equal(observations.previousDocumentId, prior.packet.after.documentId);
  assert.notEqual(f.documentId, prior.packet.after.documentId);
  assert.equal(await f.writer.document(prior.packet.after.documentId), null);
  assert.equal(disposal.deletion.status, 'cleanup-complete'); assert.equal(disposal.deletion.pendingBytes, '0');
  assert.equal(observations.writerWorkerRestarted, false); assert.equal(observations.directSQLWrites, false);
  assert.equal(observations.providerReset.receipt.reset, true);
  const state = await observeFastWarmState(f);
  assert.equal(state.width, 2048); assert.equal(state.height, 2048); assert.equal(state.layers, 0);
  assert.equal(state.queue.active, 0); assert(!state.queue.jobs.some(job => job.documentId === f.documentId));
  assert.equal((await f.writer.queueView('')).counts.active, 0);
  const retained = (await f.writer.queueView('')).jobs.find(job => job.id === prior.job.id);
  assert(retained); assert.equal(retained.disposition, 'deleted'); assert(retained.attempts.every(attempt => !attempt.hold));
  assert(BigInt(state.highWater) > BigInt(prior.packet.after.highWater));
  assert.equal(observations.logicalStorage.after.highWater, state.highWater);
  assert.equal(observations.logicalStorage.after.registeredObjects.complete, true);
  assert.equal(observations.logicalStorage.after.appPhysicalBytes, null);
  return { state, retained };
}

test('selected real WF01 samples retain one warmed writer through public cleanup and fresh draft and job identities', { skip: !enabled }, async t => {
  const { f, context, cell, path, bytes } = await selectedFastPrepared(t, 'WF01');
  const writer = f.writer, control = f.queueWorker, epoch = writer.epoch, owner = await control.cacheOwner(), seal = structuredClone(context.fixture.seal);
  const capture = await writer.capture(), queue = await writer.queueView(''), provider = await control.snapshot();
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  try {
    await writeFile(path, corrupt);
    await assert.rejects(prepareFastWarmProof(f, context, cell, { cache: 'warm', ordinal: 1, prime: false }, { reset: { phases: [], observations: { root: f.root } } }), /WF original hash changed/);
    assert.deepEqual(await writer.capture(), capture); assert.deepEqual(await writer.queueView(''), queue); assert.deepEqual(await control.snapshot(), provider);
  } finally { await writeFile(path, bytes); }
  assert.deepEqual(await readFile(path), bytes);
  let previous = null, reset = { phases: [], observations: { root: f.root } }; const samples = [];
  for (const ordinal of [1, 2]) {
    const sample = { cache: 'warm', ordinal, prime: false };
    const current = await selectedFastSample(f, context, cell, sample, reset, previous);
    assert.equal(current.packet.serial, ordinal); assert.deepEqual(current.packet.finalOwner, owner);
    assert.equal(current.outcome.observations.outcome.state, 'acknowledged');
    assert.equal(current.packet.preparation.selected.kind, 'valid');
    assert.equal(current.packet.preparation.originals[0].sha256, hash(bytes));
    assert.equal(current.packet.preparation.originals[0].bytes, bytes.length);
    if (previous) {
      assert.equal(current.packet.previous, fastWarmDigest(previous));
      assert.notEqual(current.job.id, samples[0].job.id); assert.notEqual(current.job.attempts[0].id, samples[0].job.attempts[0].id);
      assert.notEqual(current.draftId, samples[0].draftId);
      assert.notEqual(current.packet.after.documentId, previous.after.documentId);
    } else {
      assert.equal(current.packet.previous, null);
      assert.deepEqual(current.packet.preparation.provider.routes, []);
    }
    const beforeReset = await control.snapshot();
    reset = await resetWarmProductFixture(f, context, cell, { cache: 'warm', ordinal: ordinal + 1, prime: false });
    const clean = await assertSelectedFastCleanup(f, reset, current);
    assert.equal(clean.state.queue.total, ordinal, 'Prior accepted jobs remain in the complete global inventory');
    const afterReset = await control.snapshot(), route = afterReset.routes[0];
    assert.equal(afterReset.routes.length, 1); assert.equal(route.origin, beforeReset.routes[0].origin); assert.equal(route.closed, false);
    assert.deepEqual(Object.fromEntries(['status', 'dropAcknowledgement', 'mediaStatus', 'offline'].map(key => [key, route.controls[key]])), { status: 'IN_QUEUE', dropAcknowledgement: false, mediaStatus: 200, offline: false });
    assert.deepEqual(route.controls.resultFiles, beforeReset.routes[0].controls.resultFiles, 'Immutable selected result files remain bound across mutable provider reset');
    for (const key of ['effects', 'errors', 'controlReads', 'jobIds', 'enrolledJobIds', 'enrolledAttemptIds', 'submittedJobIds', 'submittedAttemptIds', 'requestIds']) assert.deepEqual(route[key], [], key);
    for (const key of ['lastSubmit', 'lastConfigured', 'lastTick', 'lastKnownRead', 'lastStatusObservation']) assert.equal(route[key], null, key);
    assert.deepEqual(reset.observations.providerReset.after, afterReset);
    assert.equal(f.writer, writer); assert.equal(f.queueWorker, control); assert.equal(writer.epoch, epoch); assert.deepEqual(await control.cacheOwner(), owner);
    assert.deepEqual(context.fixture.seal, seal, 'Public reseed cannot replace the selected immutable-input seal');
    samples.push(current); previous = current.packet;
  }
  assert.equal(samples.length, 2);
});

test('selected real WF13 keeps its fixed 8 MiB original and uncertain history while resetting the next warm baseline', { skip: !enabled }, async t => {
  const { f, context, cell } = await selectedFastPrepared(t, 'WF13');
  const writer = f.writer, control = f.queueWorker, epoch = writer.epoch, owner = await control.cacheOwner(), seal = structuredClone(context.fixture.seal);
  const current = await selectedFastSample(f, context, cell, { cache: 'warm', ordinal: 1, prime: false }, { phases: [], observations: { root: f.root } });
  assert.equal(current.packet.preparation.selected.kind, 'fault');
  assert.equal(current.packet.preparation.selected.manifest.count, 1);
  assert.equal(current.packet.preparation.originals.length, 1);
  assert.equal(current.packet.preparation.originals[0].bytes, 8 * 1024 * 1024);
  assert.equal(current.outcome.observations.resultFixture.exactEightMiB, true);
  const endpoint = current.job.review.endpoint, before = await control.snapshot(endpoint), attempt = current.job.attempts[0];
  assert.equal(attempt.state, 'submission-uncertain'); assert.equal(attempt.requestId, null); assert.equal(attempt.hold, true);
  assert(before.submittedJobIds.includes(current.job.id)); assert(before.submittedAttemptIds.includes(attempt.id));
  const posts = before.effects.filter(effect => effect.method === 'POST'); assert.equal(posts.length, 1); assert.equal(posts[0].request.complete, true);
  const reset = await resetWarmProductFixture(f, context, cell, { cache: 'warm', ordinal: 2, prime: false });
  const { state, retained } = await assertSelectedFastCleanup(f, reset, current);
  const reconciliation = reset.observations.disposal.reconciliations[0];
  assert.equal(reconciliation.outcome, 'uncertainty-retained-local-hold-explicitly-overridden');
  assert.equal(reconciliation.remoteStatusKnown, false); assert.equal(reconciliation.actualChargeKnown, false); assert.equal(reconciliation.submittedAgain, false);
  assert.equal(reconciliation.closure.closed, true); assert.equal(reconciliation.closure.effects.filter(effect => effect.method === 'POST').length, 1);
  const override = reset.observations.disposal.receipts.find(row => row.body.type === 'OverrideUncertainHold');
  assert(override); assert.equal(override.receipt.status, 'accepted'); assert.equal(override.body.jobId, current.job.id); assert.equal(override.body.attemptId, attempt.id); assert.equal(override.body.acknowledgeOverlapAndChargeRisk, true);
  assert.equal(retained.attempts[0].state, 'submission-uncertain'); assert.equal(retained.attempts[0].requestId, null); assert.equal(retained.attempts[0].hold, false); assert.equal(retained.attempts[0].override, true);
  assert.equal(state.queue.total, 1); assert.deepEqual((await control.snapshot()).routes, []); assert.deepEqual(reset.observations.providerReset.after.routes, []);
  const nextReset = reset, next = await prepareFastWarmProof(f, context, cell, { cache: 'warm', ordinal: 2, prime: false }, { reset: nextReset, previous: current.packet });
  assert(next); assert.equal(nextReset.fastWarmPreparation.serial, 2); assert.deepEqual(nextReset.fastWarmPreparation.warmed.queue, nextReset.fastWarmPreparation.base.queue);
  assert.equal(nextReset.fastWarmPreparation.warmed.highWater, nextReset.fastWarmPreparation.base.highWater);
  assert.equal(nextReset.fastWarmPreparation.base.queue.active, 0); assert.equal(nextReset.fastWarmPreparation.originals[0].bytes, 8 * 1024 * 1024);
  assert.deepEqual((await control.snapshot()).routes, [], 'Read preparation must not dispatch or reopen the closed provider namespace');
  assert.equal(f.writer, writer); assert.equal(f.queueWorker, control); assert.equal(writer.epoch, epoch); assert.deepEqual(await control.cacheOwner(), owner); assert.deepEqual(context.fixture.seal, seal);
});


test('selected real WF10 proof preserves its rejected durable draft without a queue job or provider activity', { skip: !enabled }, async t => {
  const { f, context, cell } = await selectedFastPrepared(t, 'WF10');
  const writer = f.writer, control = f.queueWorker, owner = await control.cacheOwner();
  const reset = { phases: [], observations: { root: f.root } }, sample = { cache: 'warm', ordinal: 1, prime: false };
  const session = await prepareFastWarmProof(f, context, cell, sample, { reset });
  const prepared = session.runContext.fastPreparedInput;
  assert.equal(prepared.kind, 'fast-durable-invalid-input-1'); assert.equal(prepared.caseId, 'WF10');
  assert.equal(prepared.expectedField, 'acceleration');
  assert.equal(reset.fastWarmPreparation.selected.kind, 'invalid'); assert.deepEqual(reset.fastWarmPreparation.selected.files, []);
  const before = await writer.uiRead('request_session', auth()), original = await writer.readMetadata(prepared.retained.blob);
  const draft = before.drafts.find(row => row.id === prepared.draftId);
  assert(draft); assert.equal(draft.status, 'saved-unapplied'); assert.equal(draft.documentId, f.documentId);
  assert.equal(draft.assetId, prepared.retained.id); assert.equal(hash(original), prepared.retainedHash);
  const queue = await writer.queueView(''), provider = await control.snapshot();
  assert.equal(queue.totalJobs, 0); assert.deepEqual(provider.routes, []);
  await session.enter();
  const outcome = await runFastCell({ ...context, productFixture: f, ...session.runContext }, cell);
  assert.equal(outcome.status, 'pass'); assert(outcome.observations.rejection.some(issue => issue.field === 'acceleration'));
  const packet = await session.finish(outcome);
  assert.deepEqual(await writer.uiRead('request_session', auth()), before);
  assert.deepEqual(await writer.readMetadata(prepared.retained.blob), original);
  assert.deepEqual(outcome.observations.retainedDraft, prepared.retained.blob);
  assert.deepEqual(await writer.queueView(''), queue); assert.deepEqual(await control.snapshot(), provider);
  assert.equal(outcome.observations.providerEffects, 0); assert.equal(packet.operation.jobId, null); assert.equal(packet.operation.attemptId, null);
  assert.deepEqual(packet.after.queue, packet.entry.queue); assert.deepEqual(packet.finalProvider, packet.preparation.provider);
  assert.equal(packet.preparation.draft.rawHash, hash(original)); assert.equal(packet.preparation.draft.draftId, draft.id);
  assert.equal(outcome.fastWarmInput.verdict.complete, true);
  assert.equal(f.writer, writer); assert.equal(f.queueWorker, control); assert.deepEqual(await control.cacheOwner(), owner);
});


// Transport acknowledgements are the only controlled ownership seam. The
// central read owner, worker mirror and storage loan verifier are production
// classes with their unchanged grants and admission limits.
async function fastStorageReadHarness({summaryChange, readFailure, releaseFailure} = {}) {
  const [{StorageReads}, {CompositionMemory}, {StorageLibraryMemory, STORAGE_REGISTRY_BYTES, STORAGE_OPERATION_BYTES}, {allocationLedger}] = await Promise.all([
    import('../../dist/local/server/storage-reads.js'), import('../../dist/local/server/storage/composition-memory.js'),
    import('../../dist/local/server/storage/library-memory.js'), import('../../dist/local/src/observability/allocations.js'),
  ]);
  const cpu = () => allocationLedger.snapshot().cpuBytes, baseline = cpu(), ids = new Map();
  let releaseStarted, acknowledge, lastRead, releaseCalls = 0;
  const releasing = new Promise(resolve => { releaseStarted = resolve; }), acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  const mirror = new CompositionMemory(() => mirror.bytes), memory = new StorageLibraryMemory(mirror);
  const owner = new StorageReads(async (method, args) => {
    if (method === 'compositionResize') { mirror.resize(args.id, args.bytes, args.family); ids.set(args.id, args.family); return; }
    if (method === 'compositionRelease') {
      if (ids.get(args.id) === 'storage-read') { releaseCalls++; releaseStarted(); await acknowledgement; if (releaseFailure) throw releaseFailure; }
      mirror.drop(args.id, () => {}); ids.delete(args.id); return;
    }
    assert.fail('Unexpected storage ownership RPC: ' + method);
  });
  const summary = {protocolVersion:1,epoch:'7',highWater:'19',
    categories:['all','originals','canonical','masks','candidates','adapters','datasets','history','staging','previews'].map(id => ({id,label:id,assetCount:1,objectCount:1,knownBytes:'64',complete:true,unknownCount:0,assetRows:true})),
    registeredObjects:{count:1,knownBytes:'64',complete:true},filesystem:{availableBytes:'1000000',totalBytes:'2000000'},appPhysicalBytes:null,
    accounting:'logical-content-bytes; categories may overlap',previewCache:{entries:0,knownBytes:'0',pinnedEntries:0,activeBuilds:0,clearableEntries:0,clearableBytes:'0',scope:'registered-display-derivatives'}};
  summaryChange?.(summary);
  const writer = {epoch:'7',storageSummary:async authorization => {
    assert.equal(authorization.clientId,'client_1'); assert.equal(authorization.sessionHash,'a'.repeat(64));
    assert(Number.isFinite(authorization.now)); assert(authorization.expires>authorization.now);
    lastRead = await owner.read('summary', async scope => {
      const loan = memory.enter(scope, 'summary');
      try { loan.check(); if (readFailure) throw readFailure; return summary; }
      finally { loan.release(); }
    });
    return lastRead;
  }};
  return {writer,summary,baseline,cpu,releasing,acknowledge,get lastRead(){return lastRead;},get releaseCalls(){return releaseCalls;},
    requestBytes:STORAGE_OPERATION_BYTES.summary,registryBytes:STORAGE_REGISTRY_BYTES,
    async close(){
      acknowledge(); await owner.nativeExited(); memory.close();
      for (const id of ids.keys()) mirror.drop(id, () => {}); ids.clear();
      assert.equal(mirror.bytes,0); assert.equal(cpu(),baseline);
    }};
}
function observeFastStorageRead(promise) {
  const observed = {settled:false};
  observed.result = promise.then(value => { observed.settled = true; return {value}; }, error => { observed.settled = true; return {error}; });
  return observed;
}
async function waitForFastStorageRelease(h, observed) {
  await Promise.race([h.releasing, observed.result.then(result => { throw result.error ?? Error('Storage observation returned before release acknowledgement'); })]);
  assert.equal(observed.settled,false,'Evidence and errors remain pending until actual release acknowledgement');
  assert.equal(h.releaseCalls,1); assert.equal(h.cpu(),h.baseline+h.registryBytes+h.requestBytes);
}

test('WF storage evidence consumes the actual live read and waits for release before returning a detached summary', { skip: !enabled }, async () => {
  const h = await fastStorageReadHarness(), observed = observeFastStorageRead(readFastStorageSummary(h.writer,{highWater:'19'}));
  try {
    await waitForFastStorageRelease(h,observed);
    assert(Object.isFrozen(h.lastRead)); assert.throws(() => h.lastRead.value,{code:'CLOSED'});
    h.acknowledge(); const result = await observed.result; assert.equal(result.error,undefined);
    assert.deepEqual(result.value,h.summary); assert.notEqual(result.value,h.summary); assert.notEqual(result.value.categories,h.summary.categories);
    h.summary.categories[0].knownBytes='128'; h.summary.filesystem.availableBytes='1';
    assert.equal(result.value.categories[0].knownBytes,'64'); assert.equal(result.value.filesystem.availableBytes,'1000000');
    assert.equal(h.cpu(),h.baseline+h.registryBytes);
  } finally { h.acknowledge(); await observed.result; await h.close(); }
});

test('WF storage assertion and dispatch rejection await real read cleanup without losing their failures', { skip: !enabled }, async () => {
  for (const failure of ['assertion','dispatch']) {
    const readFailure = Error('storage summary dispatch failed');
    const h = await fastStorageReadHarness(failure === 'assertion' ? {summaryChange:summary => { summary.highWater='20'; }} : {readFailure});
    const observed = observeFastStorageRead(readFastStorageSummary(h.writer,{highWater:'19'}));
    try {
      await waitForFastStorageRelease(h,observed);
      if (failure === 'assertion') assert.throws(() => h.lastRead.value,{code:'CLOSED'});
      else assert.equal(h.lastRead,undefined,'Rejected dispatch never exposes a consumer read');
      h.acknowledge(); const result = await observed.result; assert.equal(result.value,undefined);
      if (failure === 'assertion') { assert.equal(result.error.code,'ERR_ASSERTION'); assert.equal(result.error.actual,'20'); assert.equal(result.error.expected,'19'); }
      else assert.equal(result.error,readFailure);
      assert.equal(h.cpu(),h.baseline+h.registryBytes);
    } finally { h.acknowledge(); await observed.result; await h.close(); }
  }
});

test('WF storage release failure retains ownership and preserves both primary and cleanup errors', { skip: !enabled }, async () => {
  for (const assertionFails of [false,true]) {
    const releaseFailure = Error('storage release acknowledgement lost');
    const h = await fastStorageReadHarness({releaseFailure,...(assertionFails ? {summaryChange:summary => { summary.registeredObjects.complete=false; }} : {})});
    const observed = observeFastStorageRead(readFastStorageSummary(h.writer,{highWater:'19'}));
    try {
      await waitForFastStorageRelease(h,observed); h.acknowledge(); const result = await observed.result;
      assert.equal(result.value,undefined); assert.throws(() => h.lastRead.value,{code:'CLOSED'});
      if (assertionFails) { assert(result.error instanceof AggregateError); assert.equal(result.error.errors.length,2); assert.equal(result.error.errors[0].code,'ERR_ASSERTION'); assert.match(result.error.errors[0].message,/inventory is incomplete/); assert.equal(result.error.errors[1],releaseFailure); }
      else assert.equal(result.error,releaseFailure);
      assert.equal(h.cpu(),h.baseline+h.registryBytes+h.requestBytes,'Unacknowledged native release remains booked until owner exit');
    } finally { h.acknowledge(); await observed.result; await h.close(); }
  }
});

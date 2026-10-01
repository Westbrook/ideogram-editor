import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocument, createProductFixture } from '../../tooling/qualification/campaigns/backend-common.mjs';
import { prepareQueue, enqueue } from '../../tooling/qualification/campaigns/backend-queue.mjs';
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

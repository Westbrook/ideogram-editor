import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProductFixture, inspectProductWriter, planProductFixture, productCriteria, productWorkload } from '../../tooling/qualification/campaigns/fixture-product.mjs';

function corpus(id = 'W1') {
  const spec = productWorkload(id);
  const file = (index, role = 'raster-original') => ({ id: `${role}-${index}`, path: `/unused/${role}-${index}.png`,
    sha256: 'sha256:' + index.toString(16).padStart(64, '0'), byteLength: '1024', format: 'png', role, index, width: spec.width, height: spec.height });
  return { files: [...Array.from({ length: spec.imageLayers ?? spec.layers }, (_, index) => file(index + 1)), ...(spec.layers ? [file(999, 'mask')] : [])] };
}

test('canonical product workload dimensions and event counts cannot silently scale', () => {
  assert.equal(productWorkload('W2').events, 100000);
  assert.equal(productWorkload('W1').layers, 20);
  assert.equal(productWorkload('WQ').terminal, 900);
  assert.equal(productWorkload('WQ').incomplete, 100);
  assert.equal(productWorkload('WQ').active, 0);
  assert.equal(productWorkload('WA').metadataEntries, 100);
  assert.throws(() => productWorkload({ id: 'W1', width: 32 }), /cannot be scaled/);
  assert.throws(() => productWorkload('mini-W1'), /must be W0/);
});

test('fixture planning requires every independent full-grid raster and generated mask identity', () => {
  const inputs = corpus();
  const plan = planProductFixture({ workload: 'W1', corpus: inputs });
  assert.equal(plan.originals.length, 20);
  assert.equal(plan.snapshotBoundary, '9500');
  assert.equal(plan.executionRequired, true);
  assert.equal(plan.heavy, true);
  const duplicate = structuredClone(inputs); duplicate.files[1].sha256 = duplicate.files[0].sha256;
  assert.throws(() => planProductFixture({ workload: 'W1', corpus: duplicate }), /independent encoded/);
  const missing = structuredClone(inputs); missing.files.pop();
  assert.throws(() => planProductFixture({ workload: 'W1', corpus: missing }), /generated PNG mask/);
  const resized = structuredClone(inputs); resized.files[0].width = 1024;
  assert.throws(() => planProductFixture({ workload: 'W1', corpus: resized }), /dimensions do not match/);
  const oversized = structuredClone(inputs); oversized.files[0].byteLength = String(8 * 1024 * 1024 + 1);
  assert.throws(() => planProductFixture({ workload: 'W1', corpus: oversized }), /encoded 8 MiB limit/);
});

test('heavy preparation is opt-in before opening a writer or touching a root', async () => {
  await assert.rejects(buildProductFixture({ root: '/must-not-be-created', workload: 'W1', corpus: corpus() }), /requires allowHeavy:true/);
});

test('incomplete active/candidate state is not reported as a complete W1 fixture', () => {
  const counts = { events: 10000, layers: 20, rasterLayers: 20, independentLayerIds: 20, independentRasterAssets: 20,
    visible: 5, visibleMasked: 5, visibleTransformed: 5, snapshotTail: '500', jobs: 100, incomplete: 100, cancelled: 0, active: 0, candidates: 0 };
  const failed = productCriteria('W1', counts).filter(row => !row.met).map(row => row.id);
  assert.deepEqual(failed, ['queued-metadata-count', 'incomplete-job-count', 'active-request-count', 'retained-candidate-count']);
  counts.jobs = 102; counts.incomplete = 101; counts.active = 1; counts.candidates = 1;
  assert.ok(productCriteria('W1', counts).every(row => row.met));
  counts.snapshotTail = '249';
  assert.deepEqual(productCriteria('W1', counts).filter(row => !row.met).map(row => row.id), ['latest-snapshot-500-tail']);
});

test('WQ seed requires 900 actual cancelled and 100 incomplete jobs and a free active slot', () => {
  const counts = { events: 10000, layers: 20, rasterLayers: 20, independentLayerIds: 20, independentRasterAssets: 20,
    visible: 5, visibleMasked: 5, visibleTransformed: 5, snapshotTail: '500', jobs: 1000, incomplete: 100, cancelled: 900, active: 0, candidates: 0 };
  assert.ok(productCriteria('WQ', counts).every(row => row.met));
  counts.cancelled = 899; counts.active = 1;
  assert.deepEqual(productCriteria('WQ', counts).filter(row => !row.met).map(row => row.id), ['terminal-job-count', 'active-request-count']);
});

test('WA completion requires 100 observed adapter metadata entries in addition to the W1 product state', () => {
  const counts = { events: 10000, layers: 20, rasterLayers: 20, independentLayerIds: 20, independentRasterAssets: 20,
    visible: 5, visibleMasked: 5, visibleTransformed: 5, snapshotTail: '500', jobs: 102, incomplete: 101, cancelled: 0,
    active: 1, candidates: 1, metadataEntries: 99 };
  assert.deepEqual(productCriteria('WA', counts).filter(row => !row.met).map(row => row.id), ['adapter-metadata-entries']);
  counts.metadataEntries = 100;
  assert.ok(productCriteria('WA', counts).every(row => row.met));
});

test('mixed native workloads require actual image/text counts and the specified visible split', () => {
  assert.equal(planProductFixture({ workload: 'WXn', corpus: corpus('WXn') }).originals.length, 10);
  assert.equal(planProductFixture({ workload: 'WXs', corpus: corpus('WXs') }).originals.length, 25);
  const counts = { events: 10000, layers: 20, rasterLayers: 10, textLayers: 10, independentLayerIds: 20, independentRasterAssets: 10,
    visible: 5, visibleImages: 2, visibleText: 3, visibleImageMasked: 2, visibleImageTransformed: 2,
    snapshotTail: '500', jobs: 2, incomplete: 1, cancelled: 0, active: 1, candidates: 1 };
  assert.ok(productCriteria('WXn', counts).every(row => row.met));
  counts.textLayers = 9;
  assert.deepEqual(productCriteria('WXn', counts).filter(row => !row.met).map(row => row.id), ['native-text-layer-count']);
});

test('external writer mode rejects an undeclared or invalid retained workspace without closing the writer', async () => {
  const writer = { close() { throw Error('borrowed writer must remain open'); } };
  await assert.rejects(buildProductFixture({ root: '/unused', workload: 'W0', corpus: { files: [] }, writer }), /declared retainedWriter baseline/);
  await assert.rejects(buildProductFixture({ root: '/unused', workload: 'W0', corpus: { files: [] }, writer,
    retainedWriter: { baselineHighWater: 'not-a-sequence' } }), /exact baselineHighWater/);
});

test('fixture scheduling gate retains production snapshot generation at the exact boundary', async () => {
  const module = await import('../../tooling/qualification/campaigns/fixture-product.mjs?fixtureSnapshotBoundary=750');
  let highWater = '500', latest = null;
  const scheduled = [], store = { recovery: {
    highWater: () => highWater, latest: () => latest,
    maintain() { scheduled.push(highWater); latest = { seq: highWater }; }, settle: async () => {},
  } };
  await module.setup(store);
  store.recovery.maintain();
  highWater = '501'; store.recovery.maintain();
  highWater = '749'; store.recovery.maintain();
  assert.deepEqual(scheduled, ['500']);
  highWater = '750'; await store.recovery.settle();
  assert.deepEqual(scheduled, ['500', '750']);
  highWater = '1250'; store.recovery.maintain(); await store.recovery.settle();
  assert.deepEqual(scheduled, ['500', '750']);
  assert.equal(latest.seq, '750');
});

test('observation follows real history/candidate pagination and counts events independently of requested totals', async () => {
  const visited = [];
  const writer = {
    document: async () => ({ id: 'document' }), imageState: async () => ({ layers: [] }), capture: async () => ({ highWater: '2', snapshot: null }),
    queueView: async () => ({ jobs: [], nextCursor: null }),
    adapterList: async after => ({ items: [{}], nextAfter: after ? null : 'more' }),
    historyPage: async (_id, after, kind) => { visited.push([kind, after]); return after ? { items: [{}], next: null } : { items: [{}], next: 'more' }; },
    events: async after => ({ events: after === '0' ? [{ workspaceSeq: '1', type: 'DocumentCreated', documentId: 'document' }] : [{ workspaceSeq: '2', type: 'CheckpointSaved', documentId: 'document' }] }),
    candidateHistory: async (_id, after) => ({ items: after ? [] : [{ jobId: 'job', attemptId: 'attempt' }], nextCursor: after ? null : 'more' }),
    candidateView: async (jobId, attemptId, after) => { assert.equal(jobId, 'job'); assert.equal(attemptId, 'attempt'); return { items: [{}], nextCursor: after ? null : 'more' }; },
  };
  const observed = await inspectProductWriter(writer, 'document');
  assert.equal(observed.counts.events, 2);
  assert.equal(observed.counts.historyNodes, 2);
  assert.equal(observed.counts.checkpoints, 2);
  assert.equal(observed.counts.candidates, 2);
  assert.equal(observed.counts.metadataEntries, 2);
  assert.deepEqual(visited, [['history', ''], ['history', 'more'], ['checkpoints', ''], ['checkpoints', 'more']]);
});

test('retained workspace observation keeps global history distinct from the new namespace event delta', async () => {
  const writer = {
    document: async () => ({ id: 'current' }), imageState: async () => ({ layers: [] }), capture: async () => ({ highWater: '12', snapshot: null }),
    queueView: async () => ({ jobs: [{ id: 'old', documentId: 'old', attempts: [] }, { id: 'new', documentId: 'current', attempts: [] }], nextCursor: null }),
    adapterList: async () => ({ items: [], nextAfter: null }), historyPage: async () => ({ items: [], next: null }),
    events: async after => ({ events: after === '10' ? [{ workspaceSeq: '11', type: 'DocumentCreated', documentId: 'current' }] : [{ workspaceSeq: '12', type: 'AssetRegistered', documentId: null }] }),
    candidateHistory: async () => ({ items: [], nextCursor: null }),
  };
  const observed = await inspectProductWriter(writer, 'current', { eventAfter: '10', documentJobsOnly: true });
  assert.equal(observed.globalCounts.events, 12);
  assert.equal(observed.globalCounts.jobs, 2);
  assert.equal(observed.counts.events, 2);
  assert.equal(observed.counts.jobs, 1);
  assert.deepEqual(observed.counts.documentEventTypes, { DocumentCreated: 1 });
});

test('real production W0 survives writer restart with exactly one creation event and no layer/edit/job', { skip: process.env.IE_CAMPAIGN_PRODUCT_INTEGRATION !== '1' }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-product-fixture-'));
  try {
    const receipt = await buildProductFixture({ root, workload: 'W0', corpus: { files: [] } });
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.counts.events, 1);
    assert.equal(receipt.observed.events, 0);
    assert.equal(receipt.observed.storeEvents, 1);
    assert.equal(receipt.counts.historyEdits, 0);
    assert.equal(receipt.counts.layers, 0);
    assert.equal(receipt.counts.jobs, 0);
    assert.equal(receipt.preparation.productionRestartVerified, true);
    assert.equal(receipt.preparation.directSQLWrites, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

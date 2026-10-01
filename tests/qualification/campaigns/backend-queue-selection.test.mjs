// Pure fixture-descriptor checks. The corpus loader owns on-disk seal validation;
// real provider dispatch and worker configuration have separate coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { FAST_QUEUE_FIXTURE_FAMILIES, selectQueueResultFixture } from '../../../tooling/qualification/campaigns/backend-queue-control.mjs';
import { fastManifest } from '../../../tooling/qualification/campaigns/backend-queue.mjs';

const expectedFamilies = [
  { caseId: 'WF01', speed: 'TURBO', expansion: 'None', width: 512, height: 512, count: 1, format: 'png' },
  { caseId: 'WF02', speed: 'TURBO', expansion: 'Medium', width: 1024, height: 1024, count: 4, format: 'jpeg' },
  { caseId: 'WF03', speed: 'BALANCED', expansion: 'None', width: 2048, height: 2048, count: 1, format: 'jpeg' },
  { caseId: 'WF04', speed: 'BALANCED', expansion: 'Medium', width: 512, height: 512, count: 4, format: 'png' },
  { caseId: 'WF05', speed: 'QUALITY', expansion: 'None', width: 1024, height: 1024, count: 1, format: 'png' },
  { caseId: 'WF06', speed: 'QUALITY', expansion: 'Medium', width: 2048, height: 2048, count: 4, format: 'jpeg' },
];
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const fixtureRoot = resolve('artifacts/queue-selection-fixture');

function contextFor(caseId = 'WF02') {
  const files = new Map();
  for (const family of expectedFamilies) {
    for (let index = 0; index < family.count; ++index) {
      const id = `wf-${family.width}-${family.format}-${index}`;
      files.set(id, { id, role: 'fast-candidate', path: join('images', `${id}.${family.format}`),
        width: family.width, height: family.height, format: family.format, index,
        byteLength: String(1000 + index), sha256: digest(id) });
    }
  }
  // Put the legacy fallback first and valid candidates in reverse batch order.
  // Selection must use exact family identity, never array order or byte size.
  return {
    repo: resolve('artifacts/wrong-queue-selection-repo'),
    queueFixtureCell: { operation: 'fast.workflow', parameters: { caseId } },
    fixture: { root: fixtureRoot, seal: { sha256: digest('sealed-fast-corpus') }, corpus: {
      fast: { validFamilies: structuredClone(expectedFamilies) },
      files: [{ id: 'wf-fault-8MiB', role: 'fast-fault-candidate', path: 'wf-fault-8MiB.png',
        byteLength: String(8 * 1024 * 1024), sha256: digest('fault'), width: 512, height: 512, format: 'png', index: 0 },
      ...[...files.values()].reverse()],
    } },
  };
}

function selectedCandidate(context, index = 0) {
  const family = expectedFamilies.find(row => row.caseId === context.queueFixtureCell.parameters.caseId);
  return context.fixture.corpus.files.find(file => file.id === `wf-${family.width}-${family.format}-${index}`);
}

function fixtureRequired(work, caseId) {
  assert.throws(work, error => {
    assert.equal(error.code, 'FIXTURE_REQUIRED');
    assert.match(error.message, new RegExp(caseId));
    return true;
  });
}

test('worker Fast family table matches all six campaign manifests and stays immutable', () => {
  assert.deepEqual(fastManifest, expectedFamilies);
  assert.deepEqual(FAST_QUEUE_FIXTURE_FAMILIES, fastManifest);
  assert(Object.isFrozen(FAST_QUEUE_FIXTURE_FAMILIES));
  for (const family of FAST_QUEUE_FIXTURE_FAMILIES) assert(Object.isFrozen(family));
});

test('all six valid Fast cells select their exact ordered sealed candidate family', async t => {
  for (const family of expectedFamilies) await t.test(family.caseId, () => {
    const context = contextFor(family.caseId), before = structuredClone(context);
    const selection = selectQueueResultFixture(context);
    assert.deepEqual(selection, {
      kind: 'fast-valid-result-family', caseId: family.caseId, manifest: family,
      fixtureSeal: context.fixture.seal.sha256,
      files: Array.from({ length: family.count }, (_, index) => {
        const id = `wf-${family.width}-${family.format}-${index}`;
        return { id, role: 'fast-candidate', path: join(fixtureRoot, 'images', `${id}.${family.format}`),
          byteLength: String(1000 + index), sha256: digest(id), width: family.width,
          height: family.height, format: family.format, index };
      }),
    });
    assert(selection.files.every(file => isAbsolute(file.path)));
    assert.deepEqual(context, before, 'selection must not mutate the sealed descriptor');
    assert.notEqual(selection.manifest, FAST_QUEUE_FIXTURE_FAMILIES.find(row => row.caseId === family.caseId));
  });
});

test('explicit cells override the default and paths use fixture root, repository, then cwd', () => {
  const context = contextFor('WF01');
  for (const cell of ['WF02', { caseId: 'WF02' }, { operation: 'fast.workflow', parameters: { caseId: 'WF02' } }]) {
    assert.equal(selectQueueResultFixture(context, cell).caseId, 'WF02');
  }
  const file = selectedCandidate(context);
  file.byteLength = 1234;
  assert.equal(selectQueueResultFixture(context).files[0].byteLength, '1234');
  assert.equal(selectQueueResultFixture(context).files[0].path, resolve(context.fixture.root, file.path));
  delete context.fixture.root;
  assert.equal(selectQueueResultFixture(context).files[0].path, resolve(context.repo, file.path));
  delete context.repo;
  assert.equal(selectQueueResultFixture(context).files[0].path, resolve(file.path));
  file.path = resolve('artifacts/absolute-candidate.png');
  context.fixture.root = fixtureRoot;
  assert.equal(selectQueueResultFixture(context).files[0].path, file.path);
});

test('valid cells require a complete strict six-family sealed manifest', async t => {
  const mutations = [
    ['missing fixture', context => { delete context.fixture; }],
    ['missing seal', context => { delete context.fixture.seal; }],
    ['malformed seal', context => { context.fixture.seal.sha256 = 'a'.repeat(64); }],
    ['missing Fast manifest', context => { delete context.fixture.corpus.fast; }],
    ['missing family list', context => { delete context.fixture.corpus.fast.validFamilies; }],
    ['non-array family list', context => { context.fixture.corpus.fast.validFamilies = {}; }],
    ['only selected family', context => { context.fixture.corpus.fast.validFamilies = [expectedFamilies[1]]; }],
    ['missing unrelated family', context => { context.fixture.corpus.fast.validFamilies.pop(); }],
    ['additional family', context => { context.fixture.corpus.fast.validFamilies.push({ ...expectedFamilies[0] }); }],
    ['reordered families', context => { context.fixture.corpus.fast.validFamilies.reverse(); }],
    ['duplicate family', context => { context.fixture.corpus.fast.validFamilies[5] = { ...expectedFamilies[0] }; }],
    ['changed unrelated family', context => { context.fixture.corpus.fast.validFamilies[5].count = 1; }],
    ['missing family field', context => { delete context.fixture.corpus.fast.validFamilies[5].speed; }],
    ['extra family field', context => { context.fixture.corpus.fast.validFamilies[5].extra = true; }],
    ['coerced family field', context => { context.fixture.corpus.fast.validFamilies[1].width = '1024'; }],
  ];
  for (const [label, mutate] of mutations) await t.test(label, () => {
    const context = contextFor(); mutate(context);
    fixtureRequired(() => selectQueueResultFixture(context), 'WF02');
  });
});

test('missing or duplicate exact candidates fail every valid case despite the 8 MiB fallback', async t => {
  for (const family of expectedFamilies) {
    for (const failure of ['missing', 'duplicate']) await t.test(`${family.caseId} ${failure}`, () => {
      const context = contextFor(family.caseId), file = selectedCandidate(context, family.count - 1);
      if (failure === 'missing') context.fixture.corpus.files = context.fixture.corpus.files.filter(candidate => candidate !== file);
      else context.fixture.corpus.files.push({ ...file });
      assert(context.fixture.corpus.files.some(candidate => candidate.role === 'fast-fault-candidate' && Number(candidate.byteLength) === 8 * 1024 * 1024));
      fixtureRequired(() => selectQueueResultFixture(context), family.caseId);
    });
  }
  const context = contextFor(); delete context.fixture.corpus.files;
  fixtureRequired(() => selectQueueResultFixture(context), 'WF02');
});

test('mismatched candidate descriptors fail without replacing them with an 8 MiB specimen', async t => {
  const changes = [
    ['wrong identity', { id: 'other-image' }],
    ['wrong role', { role: 'fast-fault-candidate' }],
    ['wrong width', { width: 512 }],
    ['wrong height', { height: 512 }],
    ['wrong format', { format: 'png' }],
    ['wrong batch index', { index: 1 }],
    ['coerced batch index', { index: '0' }],
    ['missing digest', { sha256: undefined }],
    ['malformed digest', { sha256: 'sha256:broken' }],
    ['missing path', { path: undefined }],
    ['empty path', { path: '' }],
    ['non-string path', { path: 12 }],
    ['missing length', { byteLength: undefined }],
    ['zero length', { byteLength: '0' }],
    ['negative length', { byteLength: '-1' }],
    ['fractional length', { byteLength: '1.5' }],
    ['noncanonical length', { byteLength: '0123' }],
    ['unsafe length', { byteLength: '9007199254740992' }],
  ];
  for (const [label, fields] of changes) await t.test(label, () => {
    const context = contextFor(); Object.assign(selectedCandidate(context), fields);
    fixtureRequired(() => selectQueueResultFixture(context), 'WF02');
  });
});

test('fault, invalid, ordinary queue, and absent cells do not select a valid Fast family', () => {
  assert.equal(selectQueueResultFixture(), null);
  for (const cell of [null, {}, 'WF99', { operation: 'queue.fault', parameters: { scenario: 'lost-ack' } },
    { operation: 'queue.healthy-polling' }, { operation: 'queue.proxy-pair' },
    ...Array.from({ length: 10 }, (_, index) => ({ operation: 'fast.workflow', parameters: { caseId: 'WF' + String(index + 7).padStart(2, '0') } }))]) {
    assert.equal(selectQueueResultFixture({ queueFixtureCell: cell }), null);
    assert.equal(selectQueueResultFixture(contextFor(), cell), null, 'an explicit non-valid cell overrides the valid default');
  }
});

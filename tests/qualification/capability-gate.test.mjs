import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { functionalGates, selectGates } from '../../tooling/qualification/manifest.mjs';
import { discoverNodeFiles, nodeClassification } from '../../tooling/qualification/developer-campaigns/selectors.mjs';

const special = 'tests/recovery/editor-capability-preflight.test.mjs';
const ordinary = ['session', 'store', 'protocol', 'assets', 'raster', 'history', 'provider', 'request', 'queue', 'adapters', 'candidates', 'export', 'composition', 'text-state', 'ui-state', 'portable', 'recovery', 'browser', 'editor', 'text', 'qualification', 'campaigns'];

async function specimen(t, { capability = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qualification-capability-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function add(path) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    // The plan inspects filenames; no specimen test or product code is run.
    await writeFile(join(root, path), '// Discovery specimen only.\n');
  }
  for (const group of ordinary) await add(`tests/${group}/ordinary.test.mjs`);
  await add('tests/recovery/nested/deep.test.mjs');
  await add('tests/recovery/nested/editor-capability-preflight.test.mjs');
  await add('tests/candidates/nested/editor-capability-preflight.test.mjs');
  if (capability) await add(special);
  return { root, add };
}

test('capability preflight has one exact strict gate while recovery keeps recursive discovery', async t => {
  const { root } = await specimen(t), gates = functionalGates(root);
  const selected = gates.filter(gate => gate.files?.includes(special));
  assert.equal(selected.length, 1);
  const [gate] = selected;
  assert.equal(gate.id, 'node:editor-capability-preflight');
  assert.deepEqual(gate.files, [special]);
  assert.equal(gate.guard, 'tests/store/no-network.mjs');
  assert.deepEqual(gate.command, ['node', '--import', './tests/store/no-network.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', special]);
  assert.deepEqual(gate.dependencies, ['build-server']);
  const recovery = gates.find(item => item.id === 'node:recovery');
  assert.equal(recovery.guard, 'tests/session/no-egress.mjs');
  assert.deepEqual(recovery.files, ['tests/recovery/nested/deep.test.mjs', 'tests/recovery/nested/editor-capability-preflight.test.mjs', 'tests/recovery/ordinary.test.mjs']);
  const files = gates.flatMap(item => item.files ?? []);
  assert.equal(new Set(files).size, files.length);
  for (const selection of ['features', 'base-features', 'all', 'node:editor-capability-preflight']) {
    const ids = selectGates(gates, selection).map(item => item.id);
    assert.equal(ids.filter(id => id === gate.id).length, 1);
    for (const dependency of ['typecheck', 'vendor', 'imports', 'raster-inputs', 'build-app', 'build-server']) {
      assert.equal(ids.filter(id => id === dependency).length, 1);
      assert.ok(ids.indexOf(dependency) < ids.indexOf(gate.id));
    }
  }
  for (const selection of ['base', 'helpers']) assert.ok(!selectGates(gates, selection).some(item => item.id === gate.id));
  assert.deepEqual(selectGates(gates, gate.id, { includeDependencies: false }).map(item => item.id), [gate.id]);
});

test('missing exact capability file cannot be satisfied by a nested same-name test', async t => {
  const { root } = await specimen(t, { capability: false });
  assert.throws(() => functionalGates(root), /No discovered Node files for editor-capability-preflight/);
});

test('split does not suppress unmapped Node test auditing', async t => {
  const { root, add } = await specimen(t);
  await add('tests/unmapped/nested/required.test.mjs');
  assert.throws(() => functionalGates(root), /Unmapped required Node test files: tests\/unmapped\/nested\/required.test\.mjs/);
});

test('feature and helper guard, browser and fixture prerequisites survive the split', async t => {
  const { root, add } = await specimen(t);
  for (const path of ['tests/text-state/native.test.mjs', 'tests/history/mask-text-compatibility.test.mjs', 'tests/editor/completion/protocol-membership.test.mjs', 'tests/editor/completion/handler-source.test.mjs']) await add(path);
  const gates = new Map(functionalGates(root).map(gate => [gate.id, gate]));
  assert.equal(gates.get('node:store').guard, 'tests/store/no-network.mjs');
  assert.equal(gates.get('node:ui-state').guard, 'tests/store/no-network.mjs');
  assert.equal(gates.get('node:provider').guard, 'tests/provider/no-egress.mjs');
  for (const group of ordinary.filter(group => !['store', 'provider', 'ui-state'].includes(group))) assert.equal(gates.get(`node:${group}`).guard, 'tests/session/no-egress.mjs');
  assert.deepEqual(gates.get('node:campaigns').requiredEnvironment, { IE_CAMPAIGN_PRODUCT_INTEGRATION: '1' });
  assert.deepEqual(gates.get('node:text-state').fixtureBuild, { id: 'text-state-app', config: 'tests/text-state/vite.config.ts', outputEnvironment: 'TEXT_STATE_APP' });
  assert.deepEqual(gates.get('node:text-state').browserPrerequisites.engines, ['chromium']);
  assert.deepEqual(gates.get('node:text-state').browserPrerequisites.files, ['tests/text-state/native.test.mjs']);
  assert.ok(gates.get('node:history').browserPrerequisites.files.includes('tests/history/mask-text-compatibility.test.mjs'));
  assert.deepEqual(gates.get('node:editor').completionPrerequisites, { kind: 'current-issuers-original-monitor-independent-capture-1' });
});

test('developer campaign discovery preserves the same strict exact-path guard', async t => {
  const { root } = await specimen(t), discovered = await discoverNodeFiles(root);
  const files = discovered.filter(item => item.file === special);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0], { file: special, method: 'L', guard: 'tests/store/no-network.mjs', contracts: ['L-recovery'] });
  for (const path of ['tests/recovery/ordinary.test.mjs', 'tests/recovery/nested/editor-capability-preflight.test.mjs']) {
    assert.equal(discovered.find(item => item.file === path).guard, 'tests/session/no-egress.mjs');
  }
  for (const file of ['tests/candidates/ordinary.test.mjs', 'tests/candidates/nested/editor-capability-preflight.test.mjs']) {
    assert.deepEqual(discovered.find(item => item.file === file), { file, method: 'L', guard: 'tests/session/no-egress.mjs', contracts: ['L-job'] });
  }
  assert.throws(() => nodeClassification('tests/candidates-extra/ordinary.test.mjs'), /Unmapped required test directory: tests\/candidates-extra\/ordinary\.test\.mjs/);
  assert.equal(nodeClassification('tests/store/ordinary.test.mjs').guard, 'tests/store/no-network.mjs');
  assert.equal(nodeClassification('tests/provider/ordinary.test.mjs').guard, 'tests/provider/no-egress.mjs');
  const gate = functionalGates(root).find(item => item.id === 'node:editor-capability-preflight');
  assert.equal(files[0].guard, gate.guard);
});

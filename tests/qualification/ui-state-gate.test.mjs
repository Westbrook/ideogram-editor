import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { functionalGates, selectGates } from '../../tooling/qualification/manifest.mjs';
import { discoverNodeFiles, nodeClassification } from '../../tooling/qualification/developer-campaigns/selectors.mjs';

const ordinary = ['session', 'store', 'protocol', 'assets', 'raster', 'history', 'provider', 'request', 'queue', 'adapters', 'candidates', 'export', 'composition', 'text-state', 'portable', 'recovery', 'browser', 'editor', 'text', 'qualification', 'campaigns'];
const required = 'tests/ui-state/j1-ownership.test.mjs';
const nested = 'tests/ui-state/nested/dialog-ownership.test.mjs';
const dependencies = ['typecheck', 'vendor', 'imports', 'raster-inputs', 'build-app', 'build-server'];

async function specimen(t, { ui = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qualification-ui-state-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function add(file) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    // These bytes are only filenames for real discovery; never execute them.
    await writeFile(join(root, file), '// Discovery specimen only.\n');
  }
  for (const group of ordinary) await add(`tests/${group}/ordinary.test.mjs`);
  await add('tests/recovery/editor-capability-preflight.test.mjs');
  await mkdir(join(root, 'tests/ui-state'), { recursive: true });
  if (ui) { await add(required); await add(nested); }
  return { root, add };
}

test('actual filesystem discovery assigns all UI-state files once to a strict feature gate', async t => {
  const { root, add } = await specimen(t);
  await add('tests/ui-state/browser-only.spec.ts');
  const gates = functionalGates(root), gate = gates.find(item => item.id === 'node:ui-state');
  assert.deepEqual(gate.files, [required, nested]);
  assert.equal(gate.guard, 'tests/store/no-network.mjs');
  assert.deepEqual(gate.command, ['node', '--import', './tests/store/no-network.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', required, nested]);
  assert.deepEqual(gate.dependencies, ['build-server']);
  assert.equal(gate.browserPrerequisites, undefined);
  assert.equal(gate.fixtureBuild, undefined);
  assert.equal(gate.requiredEnvironment, undefined);
  const assigned = gates.flatMap(item => item.files ?? []);
  assert.equal(new Set(assigned).size, assigned.length);
  for (const file of [required, nested]) assert.equal(assigned.filter(value => value === file).length, 1);
  for (const selector of ['features', 'base-features', 'all', 'node:ui-state']) {
    const selected = selectGates(gates, selector).map(item => item.id);
    assert.equal(selected.filter(id => id === gate.id).length, 1);
    for (const id of dependencies) { assert.equal(selected.filter(value => value === id).length, 1); assert(selected.indexOf(id) < selected.indexOf(gate.id)); }
  }
  const features = selectGates(gates, 'features', { includeDependencies: false }).map(item => item.id);
  assert.equal(features.indexOf('node:ui-state'), features.indexOf('node:text-state') + 1);
  assert(features.indexOf('node:ui-state') < features.indexOf('node:portable'));
  for (const selector of ['base', 'helpers']) assert(!selectGates(gates, selector).some(item => item.id === gate.id));
  assert.deepEqual(selectGates(gates, gate.id, { includeDependencies: false }).map(item => item.id), [gate.id]);
});

test('an empty UI-state group or a new unknown directory cannot silently disappear', async t => {
  const { root, add } = await specimen(t, { ui: false });
  await add('tests/ui-state/only-browser.spec.ts');
  assert.throws(() => functionalGates(root), /No discovered Node files for ui-state/);
  await add(required);
  await add('tests/unmapped/nested/required.test.mjs');
  assert.throws(() => functionalGates(root), /Unmapped required Node test files: tests\/unmapped\/nested\/required\.test\.mjs/);
  await assert.rejects(discoverNodeFiles(root), /Unmapped required test directory: tests\/unmapped\/nested\/required\.test\.mjs/);
});

test('developer discovery uses the same no-network guard and control contract without browser classification', async t => {
  const { root } = await specimen(t), discovered = await discoverNodeFiles(root);
  for (const file of [required, nested]) {
    assert.deepEqual(discovered.find(item => item.file === file), { file, method: 'U', guard: 'tests/store/no-network.mjs', contracts: ['U-controls'] });
  }
  assert.deepEqual(discovered.find(item => item.file === 'tests/candidates/ordinary.test.mjs'), { file: 'tests/candidates/ordinary.test.mjs', method: 'L', guard: 'tests/session/no-egress.mjs', contracts: ['L-job'] });
  assert.equal(nodeClassification('tests/recovery/editor-capability-preflight.test.mjs').guard, 'tests/store/no-network.mjs');
  assert.equal(nodeClassification('tests/recovery/ordinary.test.mjs').guard, 'tests/session/no-egress.mjs');
  assert.equal(nodeClassification('tests/provider/ordinary.test.mjs').guard, 'tests/provider/no-egress.mjs');
  assert.equal(nodeClassification('tests/editor/ordinary.test.mjs').guard, 'tests/session/no-egress.mjs');
});

test('special inventory selects the same UI-state gate once and retains prerequisite and allocation requirements', async t => {
  const { root } = await specimen(t), actual = functionalGates(root).find(item => item.id === 'node:ui-state');
  const inventory = JSON.parse(await readFile(new URL('../../tooling/qualification/special-tests.json', import.meta.url), 'utf8'));
  const contracts = inventory.nodeGateContracts.filter(item => item.id === actual.id);
  assert.equal(contracts.length, 1);
  const [contract] = contracts;
  assert.equal(contract.executedBy, 'node-features');
  assert.equal(contract.guard, actual.guard);
  assert.deepEqual(contract.testCommandPrefix, actual.command.slice(0, 6));
  assert.deepEqual(contract.dependencies, actual.dependencies);
  assert.equal(contract.fileDiscovery.root, 'tests/ui-state');
  assert.equal(contract.fileDiscovery.recursive, true);
  assert.deepEqual(contract.standaloneSelectionCommand, ['npm', 'run', 'qualify', '--', 'run', '--select', 'node:ui-state', '--without-dependencies', '--output', '{{standaloneGateOutput}}']);
  assert.equal(contract.standaloneEnvironment.IE_EVIDENCE_ALLOCATION, '{{functionalAllocationManifest}}');
  const batch = inventory.commands.find(item => item.id === 'node-features');
  assert.equal(batch.selectedGateIds.filter(id => id === actual.id).length, 1);
  assert(batch.prerequisites.includes('current-source-prerequisites-passed'));
  assert(batch.prerequisites.includes('explicit-evidence-allocation'));
  assert.deepEqual(inventory.nodeDiscoveryAudit.featuresOrder, batch.selectedGateIds);
  assert.equal(inventory.firstFailurePolicy.continueAfterNonPass, false);
});

test('inventory keeps targeted retries and Prompt browser prerequisites distinct from full acceptance', async () => {
  const inventory = JSON.parse(await readFile(new URL('../../tooling/qualification/special-tests.json', import.meta.url), 'utf8'));
  assert.equal(inventory.gateExecutionPolicy.initialGate, 'typecheck');
  assert.deepEqual(inventory.rerunPolicy.node.argv, ['run', 'qualify', '--', 'run', '--select', '{{failedGateId}}', '--without-dependencies', '--output', '{{failedGateOutput}}']);
  assert.equal(inventory.rerunPolicy.node.env.IE_EVIDENCE_ALLOCATION, '{{functionalAllocationManifest}}');
  assert.equal(inventory.rerunPolicy.node.successfulUnrelatedSuitesRepeated, false);
  assert.equal(inventory.rerunPolicy.browser.supportedContainerFilter, null);
  assert.equal(inventory.operatorAllocationSelection.capacityBytes, 34359738368);
  assert.equal(inventory.operatorAllocationSelection.root, null);
  assert.equal(inventory.operatorAllocationSelection.manifestPath, null);
  const typechecks = inventory.browserPlanBinding.fixtureBuildSteps.filter(step => step.id === 'typecheck-request-prompt-fixture');
  assert.equal(typechecks.length, 1);
  assert.deepEqual(typechecks[0].argv, ['exec', '--', 'tsc', '--project', 'tests/request/prompt-refusal.tsconfig.json']);
  for (const browser of ['chromium', 'firefox', 'webkit']) {
    const matches = inventory.browserChildCommandContracts.filter(step => step.id === `request-prompt-refusal-${browser}`);
    assert.equal(matches.length, 1);
    const [step] = matches;
    assert.equal(step.config, 'tests/request/prompt-refusal.playwright.config.ts');
    assert.equal(step.project, browser);
    assert.equal(step.argv[step.argv.indexOf('--project') + 1], browser);
    assert.deepEqual(step.files, ['tests/request/prompt-refusal.spec.ts']);
    assert.deepEqual(step.environmentBinding.ownedOutputFields, ['REQUEST_PROMPT_BROWSER_OUTPUT']);
    assert.equal(step.environmentBinding.reportRelativeToOutput, 'browser.json');
    assert(step.prerequisites.includes('typecheck-request-prompt-fixture'));
  }
});

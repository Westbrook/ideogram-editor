import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseContainerSelection, selectContainerNodePlan, containerPacketEnvironment } from '../../tooling/qualification/container/selection.mjs';
import { executionEnvironment } from '../../tooling/qualification/core.mjs';
import { createBrowserPlan } from '../../tooling/qualification/container/browser-plan.mjs';

const base = ['session', 'store', 'protocol', 'assets', 'raster', 'history'];
const features = ['provider', 'request', 'queue', 'adapters', 'candidates', 'export', 'composition', 'text-state', 'ui-state', 'portable', 'recovery', 'editor-capability-preflight'];
const helpers = ['browser', 'editor', 'text', 'qualification', 'campaigns'];
const prerequisites = ['typecheck', 'preflight', 'vendor', 'text-inputs', 'imports', 'raster-inputs', 'build-app', 'build-server'];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qualification-container-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = file => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), '// Discovery fixture only.\n'); };
  for (const group of [...base, ...features.filter(group => group !== 'editor-capability-preflight'), ...helpers]) add(`tests/${group}/sample.test.mjs`);
  for (const file of ['tests/recovery/editor-capability-preflight.test.mjs', 'tests/text-state/native.test.mjs', 'tests/editor/completion/protocol-membership.test.mjs']) add(file);
  return { root, add };
}

test('default and explicit legacy container selections preserve their Node scopes', t => {
  const { root } = fixture(t);
  assert.deepEqual(parseContainerSelection([]), { selection: 'chromium', scope: 'features', browserOnly: false });
  for (const selection of ['chromium', 'firefox', 'webkit', 'all']) for (const scope of ['base', 'features']) {
    const selected = parseContainerSelection([selection, scope]);
    assert.deepEqual(selected, { selection, scope, browserOnly: false });
    const expected = [...prerequisites, ...(scope === 'base' ? base : [...base, ...features, ...helpers]).map(group => `node:${group}`)];
    assert.deepEqual(selectContainerNodePlan(root, selected).map(gate => gate.id), expected);
  }
});

test('browser-only keeps the actual prerequisite dependency closure and executes no Node suite twice', t => {
  const { root } = fixture(t);
  for (const selection of ['chromium', 'firefox', 'webkit', 'all']) for (const scope of ['base', 'features']) {
    const selected = parseContainerSelection([selection, scope, '--browser-only']);
    const gates = selectContainerNodePlan(root, selected);
    assert.deepEqual(gates.map(gate => gate.id), prerequisites);
    assert.deepEqual(gates.at(-1).command, ['npm', 'run', 'build:server']);
    assert.equal(gates.some(gate => gate.id.startsWith('node:')), false);
    assert.equal(new Set(gates.map(gate => gate.id)).size, gates.length);
  }
});

test('browser-only does not change any selected browser route, fixture build or reporter', () => {
  for (const engine of ['chromium', 'firefox', 'webkit', 'all']) for (const scope of ['base', 'features']) {
    const normal = parseContainerSelection([engine, scope]);
    const selected = parseContainerSelection([engine, scope, '--browser-only']);
    const output = join(tmpdir(), 'qualification-container-plan-comparison');
    const before = createBrowserPlan({ selection: normal.selection, scope: normal.scope, output });
    const after = createBrowserPlan({ selection: selected.selection, scope: selected.scope, output });
    assert.deepEqual(after, before);
  }
});

test('selection rejects unknown, duplicate and misplaced switches instead of silently broadening work', () => {
  for (const argv of [['all', 'features', '--unknown'], ['all', 'features', '--browser-only', '--browser-only'], ['--browser-only', 'all'], ['all', '--browser-only', 'features'], ['safari'], ['all', 'helpers'], ['all', 'base', 'extra'], [null]]) {
    assert.throws(() => parseContainerSelection(argv), /Usage:/);
  }
  assert.deepEqual(parseContainerSelection(['--browser-only']), { selection: 'chromium', scope: 'features', browserOnly: true });
  const argv = ['all', 'features', '--browser-only'];
  parseContainerSelection(argv);
  assert.deepEqual(argv, ['all', 'features', '--browser-only']);
});

test('full selection retains capability guard, campaign opt-in and native/completion preparation', t => {
  const { root } = fixture(t);
  const gates = selectContainerNodePlan(root, parseContainerSelection(['all', 'features']));
  const byId = new Map(gates.map(gate => [gate.id, gate]));
  const capability = byId.get('node:editor-capability-preflight');
  assert.deepEqual(capability.command, ['node', '--import', './tests/store/no-network.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/recovery/editor-capability-preflight.test.mjs']);
  assert.equal(gates.flatMap(gate => gate.files ?? []).filter(file => file === 'tests/recovery/editor-capability-preflight.test.mjs').length, 1);
  assert.deepEqual(byId.get('node:campaigns').requiredEnvironment, { IE_CAMPAIGN_PRODUCT_INTEGRATION: '1' });
  assert.equal(byId.get('node:text-state').fixtureBuild.outputEnvironment, 'TEXT_STATE_APP');
  assert.deepEqual(byId.get('node:text-state').browserPrerequisites.engines, ['chromium']);
  assert.equal(byId.get('node:editor').completionPrerequisites.kind, 'current-issuers-original-monitor-independent-capture-1');
});

test('browser-only still fails closed on unmapped tests and a missing exact capability file', t => {
  const { root, add } = fixture(t);
  const selection = parseContainerSelection(['all', 'features', '--browser-only']);
  add('tests/unmapped/new.test.mjs');
  assert.throws(() => selectContainerNodePlan(root, selection), /Unmapped required Node test files/);
  rmSync(join(root, 'tests/unmapped'), { recursive: true });
  rmSync(join(root, 'tests/recovery/editor-capability-preflight.test.mjs'));
  add('tests/recovery/nested/editor-capability-preflight.test.mjs');
  assert.throws(() => selectContainerNodePlan(root, selection), /No discovered Node files for editor-capability-preflight/);
});

test('special-test defaults execute feature/helper selectors once and the browser-only entry last', () => {
  const inventory = JSON.parse(readFileSync(new URL('../../tooling/qualification/special-tests.json', import.meta.url), 'utf8'));
  assert.deepEqual(inventory.defaultExecutionOrder, ['node-features', 'node-helpers', 'browser-functional']);
  const commands = new Map(inventory.commands.map(command => [command.id, command]));
  assert.deepEqual(commands.get('node-features').argv, ['run', 'qualify', '--', 'run', '--select', 'features', '--without-dependencies', '--output', '{{nodeFeaturesOutput}}']);
  assert.deepEqual(commands.get('node-helpers').argv, ['run', 'qualify', '--', 'run', '--select', 'helpers', '--without-dependencies', '--output', '{{nodeHelpersOutput}}']);
  assert.deepEqual(commands.get('browser-functional').argv, ['tooling/qualification/container/run.mjs', 'all', 'features', '--browser-only']);
  for (const id of ['node-features', 'node-helpers']) {
    assert.equal(commands.get(id).env.IE_EVIDENCE_ALLOCATION, '{{functionalAllocationManifest}}');
    assert(commands.get(id).prerequisites.includes('explicit-evidence-allocation'));
    assert.equal(commands.get(id).dependenciesIncluded, false);
    assert(commands.get(id).prerequisites.includes('current-source-prerequisites-passed'));
  }
  const bindings = inventory.commandBindings.values;
  assert.equal(inventory.commandBindings.state, 'unbound-no-operator-allocation-supplied');
  assert.equal(bindings.nodeFeaturesOutput.containedBy, 'functionalAllocationManifest.root');
  assert.equal(bindings.nodeHelpersOutput.containedBy, 'functionalAllocationManifest.root');
  assert(bindings.nodeFeaturesOutput.distinctFrom.includes('nodeHelpersOutput'));
  const browser = commands.get('browser-functional');
  assert.equal(browser.cwd, '/workspace');
  assert.equal(browser.env.IE_EVIDENCE_ALLOCATION, '/evidence-allocation.json');
  assert.equal(browser.containerEvidence.allocationRoot, '/workspace/artifacts');
  assert.equal(browser.containerEvidence.manifestMount.readOnly, true);
  assert.equal(browser.containerEvidence.workflowCapacityVariable, 'QUALIFICATION_EVIDENCE_CAPACITY_BYTES');
  assert(browser.prerequisites.includes('explicit-evidence-allocation'));
  assert(inventory.nodeGateContracts.every(gate => gate.standaloneSelectionCommand.at(-2) === '--output' && gate.standaloneSelectionCommand.at(-1) === '{{standaloneGateOutput}}'));
  assert(inventory.browserChildCommandContracts.every(route => route.environmentBinding.inheritedEvidenceFields.includes('IE_EVIDENCE_ALLOCATION')));
  assert.equal(inventory.nodeGateContracts.filter(gate => gate.id === 'node:editor-capability-preflight').length, 1);
  assert.equal(inventory.nodeGateContracts.find(gate => gate.id === 'node:editor-capability-preflight').executedBy, 'node-features');
  const predecessor = inventory.dependencySeals.capabilityGate.requiredSource;
  const successor = inventory.dependencySeals.capabilityLaterEffectiveSource;
  assert.equal(successor.predecessorSHA256, predecessor.sourceSHA256);
  assert.notEqual(successor.sourceSeal.sha256, predecessor.sourceSHA256);
  assert.equal(successor.target, predecessor.target);
  const volume = inventory.specializedCommandInventory.find(command => command.id === 'store-volume-fault');
  assert.equal(volume.guard, 'tests/store/no-network.mjs');
  assert.equal(volume.steps[1].argv[1], './tests/store/no-network.mjs');
  const migration = inventory.separateEvidenceWork.find(command => command.id === 'actual-schema17-to18-backup17-migration-rollback');
  assert.equal(migration.inDefaultExecution, false);
  assert.equal(migration.executionPerformed, false);
  assert.deepEqual(migration.phases.map(phase => phase.id), ['inspect', 'execute']);
  assert.equal(migration.harnessAndDocsArePromotionTargets, false);
  assert.equal(inventory.firstFailurePolicy.continueAfterNonPass, false);
});

test('container forwards the supplied schema18 packet through both child environment boundaries only', () => {
  const supplied = {
    IE_SCHEMA18_EXECUTABLE_PACKET: '/schema18-packet/packet.json',
    FAL_KEY: 'fixture-secret', HTTPS_PROXY: 'https://example.invalid',
    NODE_OPTIONS: '--require /unexpected-code', IE_UNRELATED_PACKET: '/unrelated/packet.json',
  };
  const forwarded = containerPacketEnvironment(supplied);
  assert.deepEqual(forwarded, { IE_SCHEMA18_EXECUTABLE_PACKET: '/schema18-packet/packet.json' });
  const child = executionEnvironment({ PATH: '/usr/bin:/bin', ...forwarded }, '/pinned/bin', '/evidence');
  assert.equal(child.IE_SCHEMA18_EXECUTABLE_PACKET, supplied.IE_SCHEMA18_EXECUTABLE_PACKET);
  for (const key of ['FAL_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'IE_UNRELATED_PACKET']) {
    assert.equal(Object.hasOwn(forwarded, key), false, key);
    assert.equal(Object.hasOwn(child, key), false, key);
  }
  assert.equal(supplied.FAL_KEY, 'fixture-secret', 'The ambient input is not mutated');
});

test('container packet forwarding does not invent defaults or normalize unvalidated paths', () => {
  const missing = containerPacketEnvironment({ FAL_KEY: 'fixture-secret' });
  assert.deepEqual(missing, {});
  assert.equal(Object.hasOwn(executionEnvironment(missing, '/pinned/bin', '/evidence'), 'IE_SCHEMA18_EXECUTABLE_PACKET'), false);
  for (const path of ['', 'relative/packet.json', '/schema18-packet/../packet.json']) {
    const child = executionEnvironment(containerPacketEnvironment({ IE_SCHEMA18_EXECUTABLE_PACKET: path }), '/pinned/bin', '/evidence');
    assert.equal(child.IE_SCHEMA18_EXECUTABLE_PACKET, path, 'The existing held() consumer must validate the original value');
  }
});

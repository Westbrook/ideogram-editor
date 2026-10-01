import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignJobs, validateCampaignSchedule, selectGates, functionalGates, manualProtocols } from '../../tooling/qualification/manifest.mjs';
import { executionEnvironment, tapCounts, gateOutcome, receiptOutcome, verifyReceipt, digestJSON, sha256 } from '../../tooling/qualification/core.mjs';
import { executeGate } from '../../tooling/qualification/run.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('PERF closed inventory retains all native core and conditional adapter/training jobs', () => {
  for (const [campaign, counts] of [['P', [22, 30, 40]], ['Q3', [16, 19, 22]]]) {
    for (const [index, feature] of ['core', 'adapters', 'training'].entries()) {
      const jobs = campaignJobs(campaign, feature);
      assert.equal(jobs.length, counts[index]); assert.equal(new Set(jobs).size, jobs.length);
    }
  }
  assert.deepEqual(campaignJobs('Q3', 'core'), ['I0','I1','I2','I3','I4','I5a','I5b','I6C','I6H','I7N','I10C','I10H','I11H','I12C','I12H','I13H']);
  assert.throws(() => campaignJobs('E', 'core'));
  assert.throws(() => campaignJobs('Q3', 'disabled-native'));
});

test('scheduling validates both directions for distinct fresh base and candidate', () => {
  const revisions = ['a'.repeat(40), 'b'.repeat(40)];
  const jobs = revisions.flatMap(revision => campaignJobs('Q3', 'training').map(id => ({ revision, id })));
  const input = { campaign: 'Q3', features: 'training', revisions, jobs };
  assert.equal(validateCampaignSchedule(input).jobs, 44);
  assert.equal(validateCampaignSchedule(input).qualification, false);
  assert.throws(() => validateCampaignSchedule({ ...input, jobs: jobs.slice(1) }), /missing/);
  assert.throws(() => validateCampaignSchedule({ ...input, jobs: [...jobs, jobs[0]] }), /Duplicate/);
  assert.throws(() => validateCampaignSchedule({ ...input, jobs: [...jobs.slice(1), { revision: revisions[0], id: 'I99' }] }), /orphan/);
  assert.throws(() => validateCampaignSchedule({ ...input, revisions: [revisions[0], revisions[0]] }), /distinct/);
});

test('selection executes explicit dependencies once in canonical cheapest-first order', () => {
  const gates = [{ id: 'types', dependencies: [] }, { id: 'build', dependencies: ['types'] }, { id: 'one', dependencies: ['build'] }, { id: 'two', dependencies: ['build'] }];
  assert.deepEqual(selectGates(gates, 'two,one').map(gate => gate.id), ['types', 'build', 'one', 'two']);
  assert.throws(() => selectGates(gates, 'one,one'), /Duplicate/);
  assert.throws(() => selectGates(gates, 'missing'), /Unknown/);
  assert.throws(() => selectGates([{ id: 'one', dependencies: ['two'] }, { id: 'two', dependencies: ['one'] }], 'one'), /cycle/);
  assert.throws(() => selectGates([{ id: 'one', dependencies: ['absent'] }], 'one'), /Unknown dependency/);
});

test('implemented adapter suite is selected by features, all and base-features with its egress guard', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const gates = functionalGates(root);
  for (const selection of ['features', 'all', 'base-features']) {
    const planned = selectGates(gates, selection), ids = planned.map(gate => gate.id);
    const adapter = planned.find(gate => gate.id === 'node:adapters');
    assert.ok(adapter, `${selection} must execute imported-adapter behavior`);
    assert.ok(adapter.files.includes('tests/adapters/flow.test.mjs'));
    assert.ok(adapter.files.includes('tests/adapters/draft-deletion-race.test.mjs'));
    assert.deepEqual(adapter.command.slice(0, 3), ['node', '--import', './tests/session/no-egress.mjs']);
    assert.equal(ids.filter(id => id === 'build-server').length, 1);
    assert.equal(ids.filter(id => id === 'build-app').length, 1);
    assert.ok(ids.indexOf('node:queue') < ids.indexOf('node:adapters'));
    assert.ok(ids.indexOf('node:adapters') < ids.indexOf('node:candidates'));
    const exportGate = planned.find(gate => gate.id === 'node:export');
    assert.ok(exportGate.files.includes('tests/export/ui.test.mjs'));
    assert.equal(exportGate.guard, 'tests/session/no-egress.mjs');
    assert.ok(ids.indexOf('node:candidates') < ids.indexOf('node:export'));
    const rasterInputs = planned.find(gate => gate.id === 'raster-inputs');
    assert.deepEqual(rasterInputs.command, ['npm', 'run', 'verify:raster']);
    assert.ok(ids.indexOf('imports') < ids.indexOf('raster-inputs'));
    assert.ok(ids.indexOf('raster-inputs') < ids.indexOf('build-app'));
  }
  const initial = selectGates(gates, 'base-features').map(gate => gate.id);
  assert.deepEqual(initial.filter(id => id.startsWith('node:')), ['session', 'store', 'protocol', 'assets', 'raster', 'history', 'provider', 'request', 'queue', 'adapters', 'candidates', 'export', 'composition', 'text-state', 'portable', 'recovery'].map(name => `node:${name}`));
  assert.equal(initial.includes('node:qualification'), false);
  assert.ok(selectGates(gates, 'all').some(gate => gate.id === 'node:campaigns'));
  assert.ok(selectGates(gates, 'helpers').some(gate => gate.id === 'node:campaigns'));
  const campaigns = gates.find(gate => gate.id === 'node:campaigns');
  assert.deepEqual(campaigns.requiredEnvironment, { IE_CAMPAIGN_PRODUCT_INTEGRATION: '1' });
  assert.deepEqual(campaigns.dependencies, ['build-server']);
  for (const file of ['backend-reset-product', 'backend-transfer-product', 'fixtures-product']) assert.ok(campaigns.files.includes(`tests/campaigns/${file}.test.mjs`));
  assert.equal(campaigns.guard, 'tests/session/no-egress.mjs');
  const native = gates.find(gate => gate.id === 'node:text-state');
  assert.deepEqual(native.fixtureBuild, { id: 'text-state-app', config: 'tests/text-state/vite.config.ts', outputEnvironment: 'TEXT_STATE_APP' });
  assert.deepEqual(native.browserPrerequisites.engines, ['chromium']);
  assert.ok(native.browserPrerequisites.files.includes('tests/text-state/native.test.mjs'));
  assert.ok(gates.find(gate => gate.id === 'node:history').browserPrerequisites.files.includes('tests/history/mask-text-compatibility.test.mjs'));
});

test('child environment removes credentials, proxies and injected Node loaders', () => {
  const clean = executionEnvironment({ PATH: '/bin', HOME: '/home/test', TMPDIR: '/tmp', FAL_KEY: 'sentinel', OPENAI_API_KEY: 'sentinel2', HTTPS_PROXY: 'http://secret', NODE_OPTIONS: '--import hostile.mjs', AWS_SECRET_ACCESS_KEY: 'secret', IE_CAMPAIGN_PRODUCT_INTEGRATION: '1', CI: 'false' }, '/pinned', '/receipt');
  assert.equal(clean.PATH, '/pinned:/bin'); assert.equal(clean.HOME, '/home/test'); assert.equal(clean.CI, '1');
  for (const forbidden of ['FAL_KEY', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY', 'IE_CAMPAIGN_PRODUCT_INTEGRATION']) assert.equal(clean[forbidden], undefined);
  assert.equal(clean.EDITOR_RECEIPT, '/receipt/editor');
});

test('TAP totals use final run summary and preserve skip/cancellation counts', () => {
  assert.deepEqual(tapCounts('    # tests 2\n# tests 9\n# pass 8\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'), { tests: 9, pass: 8, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
  assert.equal(gateOutcome({ exitCode: 0, counts: { tests: 9, pass: 8, skipped: 1 } }, true), 'INCONCLUSIVE');
  assert.equal(gateOutcome({ exitCode: 0, counts: {} }, true), 'INCONCLUSIVE');
  assert.equal(gateOutcome({ exitCode: 0, counts: { tests: 9, pass: 1 } }, true), 'INCONCLUSIVE');
  assert.equal(gateOutcome({ exitCode: 0, counts: {} }, false), 'PASS');
  assert.equal(gateOutcome({ exitCode: 0, timedOut: true, counts: { tests: 1, pass: 1 } }, true), 'FAIL');
  assert.equal(gateOutcome({ exitCode: 1, counts: {} }, true), 'FAIL');
});

test('missing gates or concurrent source drift cannot produce a passing run', () => {
  const gates = [{ id: 'one', outcome: 'PASS' }];
  assert.equal(receiptOutcome(gates, ['one'], 'a', 'a'), 'PASS');
  assert.equal(receiptOutcome(gates, ['one', 'two'], 'a', 'a'), 'INCONCLUSIVE');
  assert.equal(receiptOutcome(gates, ['one'], 'a', 'b'), 'INCONCLUSIVE');
  assert.equal(receiptOutcome([{ id: 'one', outcome: 'FAIL' }], ['one', 'two'], 'a', 'b'), 'FAIL');
});

function exampleReceipt() {
  const bytes = Buffer.from('TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  const source = { files: [{ path: 'src/a.ts', bytes: 1, sha256: 'a'.repeat(64) }] }; source.digest = digestJSON(source.files);
  const gate = { id: 'node:one', command: ['node', '--test', 'tests/one.test.mjs'], exitCode: 0, signal: null, timedOut: false, counts: tapCounts(bytes.toString()), outcome: 'PASS', log: { path: 'one.log', bytes: bytes.length, sha256: sha256(bytes) } };
  return { bytes, receipt: { kind: 'qualification-functional-run-1', selected: ['node:one'], plan: { gates: [{ id: gate.id, command: gate.command }] }, gates: [gate], identity: { before: structuredClone(source), after: structuredClone(source) }, outcome: 'PASS', scope: 'functional only' } };
}

test('receipt verifier rejects altered output, counts, source identities and verdicts', () => {
  const { bytes, receipt } = exampleReceipt();
  assert.equal(verifyReceipt(receipt, () => bytes).outcome, 'PASS');
  assert.equal(verifyReceipt(receipt, () => bytes).qualification, false);
  assert.throws(() => verifyReceipt(receipt, () => Buffer.from('replacement')), /digest mismatch/);
  for (const mutate of [copy => copy.gates[0].counts.pass++, copy => copy.identity.before.files[0].bytes++, copy => copy.gates[0].outcome = 'FAIL', copy => copy.outcome = 'FAIL']) {
    const copy = structuredClone(receipt); mutate(copy); assert.throws(() => verifyReceipt(copy, () => bytes), /mismatch/);
  }
  assert.throws(() => verifyReceipt({ ...receipt, selected: [], gates: [] }, () => bytes), /empty/);
  assert.throws(() => verifyReceipt({ ...receipt, selected: ['node:other'] }, () => bytes), /selection differs/);
  const environment = structuredClone(receipt); environment.plan.gates[0].requiredEnvironment = { IE_CAMPAIGN_PRODUCT_INTEGRATION: '1' };
  assert.throws(() => verifyReceipt(environment, () => bytes), /Executed environment differs/);
  const changed = structuredClone(receipt); changed.gates[0].command = ['true'];
  assert.throws(() => verifyReceipt(changed, () => bytes), /command differs/);
  const fixture = structuredClone(receipt); fixture.gates[0].fixturePrerequisites = [{ name: 'test-input', path: 'input.json', bytes: bytes.length, sha256: sha256(bytes) }];
  assert.equal(verifyReceipt(fixture, () => bytes).outcome, 'PASS');
  fixture.gates[0].fixturePrerequisites[0].bytes++;
  assert.throws(() => verifyReceipt(fixture, () => bytes), /Fixture prerequisite digest mismatch/);
  const produced = structuredClone(receipt);
  produced.plan.gates[0].fixtureBuild = { id: 'fixture', config: 'fixture.config.ts', outputEnvironment: 'FIXTURE_APP' };
  assert.throws(() => verifyReceipt(produced, () => bytes), /Missing planned fixture producer/);
  const files = ['index.html', 'assets/app.js'].map(path => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
  const manifestBytes = Buffer.from(JSON.stringify({ kind: 'qualification-preparation-output-1', output: 'node-one-fixture', files }));
  produced.gates[0].fixtureBuild = { code: 0, signal: null, timedOut: false, interrupted: false, output: 'node-one-fixture', executable: { path: process.execPath, node: '26.10.0', bytes: 1, sha256: 'a'.repeat(64) }, command: [process.execPath, 'node_modules/vite/bin/vite.js', 'build', '--config', 'fixture.config.ts', '--outDir', '/receipt/node-one-fixture'], files, manifest: { path: 'node-one-fixture.manifest.json', bytes: manifestBytes.length, sha256: sha256(manifestBytes) } };
  const readProduced = path => path.endsWith('.manifest.json') ? manifestBytes : bytes;
  assert.equal(verifyReceipt(produced, readProduced).outcome, 'PASS');
  const wrongProducer = structuredClone(produced); wrongProducer.gates[0].fixtureBuild.command = ['true'];
  assert.throws(() => verifyReceipt(wrongProducer, readProduced), /Fixture producer (command|executable) differs/);
  const wrongExecutable = structuredClone(produced); wrongExecutable.gates[0].fixtureBuild.command[0] = '/bin/true';
  assert.throws(() => verifyReceipt(wrongExecutable, readProduced), /Fixture producer executable differs/);
  const omittedAsset = structuredClone(produced); omittedAsset.gates[0].fixtureBuild.files.pop();
  assert.throws(() => verifyReceipt(omittedAsset, readProduced), /Fixture output inventory mismatch/);
  assert.throws(() => verifyReceipt(produced, path => path.endsWith('app.js') ? Buffer.from('changed') : readProduced(path)), /Fixture build digest mismatch/);
  produced.gates[0].fixtureBuild.files = [];
  assert.throws(() => verifyReceipt(produced, readProduced), /Incomplete fixture producer/);
  const completion = structuredClone(receipt); completion.plan.gates[0].completionPrerequisites = { kind: 'current-issuers-original-monitor-independent-capture-1' };
  assert.throws(() => verifyReceipt(completion, () => bytes), /Missing completion prerequisite closure/);
  const retained = new Map([['one.log', bytes]]);
  completion.gates[0].fixturePreparations = [['completion-issuers', ['application-identity.json', 'host-final-issuers.json', 'receipt.json']], ['completion-inputs', ['PROTOCOL_OLD_MONITOR.mjs', 'preparation.json', 'capture.log', 'handler-capture/result.json', 'handler-capture/first/result.json', 'handler-capture/independent/result.json']]].map(([role, paths]) => {
    const output = `node-one-${role}`, files = paths.map(path => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
    for (const path of paths) retained.set(`${output}/${path}`, bytes);
    const manifestBytes = Buffer.from(JSON.stringify({ kind: 'qualification-preparation-output-1', output, files })), manifestPath = `${output}.manifest.json`;
    retained.set(manifestPath, manifestBytes);
    return { role, output, files, manifest: { path: manifestPath, bytes: manifestBytes.length, sha256: sha256(manifestBytes) } };
  });
  completion.gates[0].fixturePrerequisites = [['COMPLETION_APPLICATION_IDENTITY', 'completion-issuers/application-identity.json'], ['COMPLETION_ISSUER_MANIFEST', 'completion-issuers/host-final-issuers.json'], ['PROTOCOL_OLD_MONITOR', 'completion-inputs/PROTOCOL_OLD_MONITOR.mjs'], ['HOST_HANDLER_CAPTURE', 'completion-inputs/handler-capture/first/result.json']].map(([name, suffix]) => ({ name, path: `node-one-${suffix}`, bytes: bytes.length, sha256: sha256(bytes) }));
  assert.equal(verifyReceipt(completion, path => retained.get(path)).outcome, 'PASS');
  const unrelatedInput = structuredClone(completion); unrelatedInput.gates[0].fixturePrerequisites.at(-1).path = 'one.log';
  assert.throws(() => verifyReceipt(unrelatedInput, path => retained.get(path)), /Completion input differs from sealed preparation/);
  const missingIndependent = structuredClone(completion); missingIndependent.gates[0].fixturePreparations[1].files.pop();
  assert.throws(() => verifyReceipt(missingIndependent, path => retained.get(path)), /Missing independent completion preparation/);


});

test('native manual protocols retain exact two IME specimens and cannot be synthetic', () => {
  const ime = manualProtocols.filter(protocol => protocol.id.startsWith('M-IME'));
  assert.equal(ime.length, 2);
  for (const protocol of ime) {
    assert.equal(protocol.seconds, 60); assert.equal(protocol.compositions, 10); assert.equal(protocol.commits, 8); assert.equal(protocol.cancels, 2); assert.equal(protocol.presentationRequests, 6); assert.equal(protocol.syntheticSubstitution, false);
  }
});

test('actual gate child output is hashed and timeouts cannot masquerade as success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-runner-'));
  try {
    const output = 'TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    const passed = await executeGate({ id: 'node:fixture', command: [process.execPath, '--eval', `if(process.env.IE_CAMPAIGN_PRODUCT_INTEGRATION!=='1')process.exit(2);process.stdout.write(${JSON.stringify(output)})`], requiredEnvironment: { IE_CAMPAIGN_PRODUCT_INTEGRATION: '1' }, timeoutMs: 5000 }, directory, {});
    assert.equal(passed.outcome, 'PASS'); assert.equal(passed.counts.tests, 1);
    assert.equal(passed.log.sha256, sha256(await readFile(join(directory, passed.log.path))));
    const failed = await executeGate({ id: 'node:failed', command: [process.execPath, '--eval', 'process.exit(3)'], timeoutMs: 5000 }, directory, {});
    assert.equal(failed.outcome, 'FAIL'); assert.equal(failed.exitCode, 3);
    const timed = await executeGate({ id: 'node:timed', command: [process.execPath, '--eval', 'setInterval(()=>{},1000)'], timeoutMs: 100, graceMs: 50 }, directory, {});
    assert.equal(timed.outcome, 'FAIL'); assert.equal(timed.timedOut, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

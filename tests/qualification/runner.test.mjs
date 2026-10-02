import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignJobs, validateCampaignSchedule, selectGates, functionalGates, manualProtocols } from '../../tooling/qualification/manifest.mjs';
import { executionEnvironment, tapCounts, gateOutcome, receiptOutcome, verifyReceipt, digestJSON, sha256 } from '../../tooling/qualification/core.mjs';
import { executeGate } from '../../tooling/qualification/run.mjs';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import {readFileSync, existsSync} from 'node:fs';
import {completionPrerequisitesFor} from '../../tooling/qualification/suite-prerequisites.mjs';
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
  assert.deepEqual(initial.filter(id => id.startsWith('node:')), ['session', 'store', 'protocol', 'assets', 'raster', 'history', 'provider', 'request', 'queue', 'adapters', 'candidates', 'export', 'composition', 'text-state', 'ui-state', 'portable', 'recovery', 'editor-capability-preflight'].map(name => `node:${name}`));
  assert.equal(initial.includes('node:qualification'), false);
  const all = selectGates(gates, 'all'), allIds = all.map(gate => gate.id);
  assert.deepEqual(all.find(gate => gate.id === 'preflight').dependencies, ['typecheck']);
  assert.deepEqual(all.find(gate => gate.id === 'node:qualification').dependencies, ['build-server']);
  assert.ok(allIds.indexOf('typecheck') < allIds.indexOf('preflight'));
  assert.ok(allIds.indexOf('preflight') < allIds.indexOf('vendor'));
  assert.ok(allIds.indexOf('build-server') < allIds.indexOf('node:qualification'));
  assert.ok(allIds.indexOf('vendor') < allIds.indexOf('build-app'));
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
  const pins = { IE_PORTABLE_MAX12_RECEIPT: '/retained/capture/receipt.json', IE_PORTABLE_MAX12_RECEIPT_SHA256: 'a'.repeat(64), IE_PORTABLE_MAX12_FINALIZATION: '/retained/finalization.json', IE_PORTABLE_MAX12_FINALIZATION_SHA256: 'b'.repeat(64) };
  const retained = executionEnvironment({ ...pins, IE_PORTABLE_MAX12_NODE: '/untrusted/node', IE_PORTABLE_MAX12_LOADER: '/untrusted/loader', NODE_PATH: '/untrusted/modules' }, '/pinned', '/receipt');
  for (const [key, value] of Object.entries(pins)) assert.equal(retained[key], value);
  for (const key of ['IE_PORTABLE_MAX12_NODE', 'IE_PORTABLE_MAX12_LOADER', 'NODE_PATH']) assert.equal(retained[key], undefined);
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


test('schema18 packet environment is explicit passthrough without a default or admission claim', () => {
  const explicit = '/synthetic/schema18/packet.json';
  const clean = executionEnvironment({ IE_SCHEMA18_EXECUTABLE_PACKET: explicit }, '/pinned', '/receipt');
  assert.equal(clean.IE_SCHEMA18_EXECUTABLE_PACKET, explicit);
  assert.equal(Object.hasOwn(executionEnvironment({}, '/pinned', '/receipt'), 'IE_SCHEMA18_EXECUTABLE_PACKET'), false);
  // Input validation belongs to the fixture installer, including refusing relative paths.
  assert.equal(executionEnvironment({ IE_SCHEMA18_EXECUTABLE_PACKET: 'relative.json' }, '/pinned', '/receipt').IE_SCHEMA18_EXECUTABLE_PACKET, 'relative.json');
});

test('D11 archive cache survives the child boundary only as an explicit selection', () => {
  const explicit = '/synthetic/pinned-archive-cache';
  const clean = executionEnvironment({ IE_D11_NPM_CACHE: explicit, npm_config_cache: '/unselected', NODE_OPTIONS: '--import untrusted.mjs' }, '/pinned', '/receipt');
  assert.equal(clean.IE_D11_NPM_CACHE, explicit);
  assert.equal(Object.hasOwn(clean, 'npm_config_cache'), false);
  assert.equal(Object.hasOwn(clean, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(executionEnvironment({}, '/pinned', '/receipt'), 'IE_D11_NPM_CACHE'), false);
  // The bounded archive reader owns path and content validation; forwarding is
  // not evidence admission and never invents a default cache location.
  assert.equal(executionEnvironment({ IE_D11_NPM_CACHE: 'relative' }, '/pinned', '/receipt').IE_D11_NPM_CACHE, 'relative');
});


test('sealed text input verification is a dependency before imports and all formal builds', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url)), gates = functionalGates(root);
  const text = gates.find(gate => gate.id === 'text-inputs');
  assert.deepEqual(text.command, ['npm', 'run', 'verify:text']);
  assert.deepEqual(text.dependencies, ['vendor']);assert.equal(text.files, undefined);
  assert.deepEqual(gates.find(gate => gate.id === 'imports').dependencies, ['text-inputs']);
  for (const selection of ['base', 'features', 'helpers', 'all', 'build-app', 'build-server']) {
    const ids = selectGates(gates, selection).map(gate => gate.id);
    assert.equal(ids.filter(id => id === 'typecheck').length, 1);assert.equal(ids.filter(id => id === 'text-inputs').length, 1);
    assert.ok(ids.indexOf('vendor') < ids.indexOf('text-inputs'));assert.ok(ids.indexOf('text-inputs') < ids.indexOf('imports'));
    for (const build of ['build-app', 'build-server'])if(ids.includes(build))assert.ok(ids.indexOf('text-inputs') < ids.indexOf(build));
  }
});


// Synthetic producers write real retained files; these controls test the runner
// boundary, never issue application or browser qualification evidence.
function completionPreparationFixture() {
 const calls=[];
 return {calls,
  async prepareIssuers(output,cwd){
   calls.push({role:'issuers',output,cwd});await mkdir(output);
   for(const path of ['application-identity.json','host-final-issuers.json','receipt.json'])await writeFile(join(output,path),JSON.stringify({synthetic:path}));
   return {output,env:{COMPLETION_APPLICATION_IDENTITY:join(output,'application-identity.json'),COMPLETION_ISSUER_MANIFEST:join(output,'host-final-issuers.json')}};
  },
  async prepareInputs(output,cwd,options){
   calls.push({role:'inputs',output,cwd,options});
   assert.ok(options.timeoutMs>0);assert.ok(options.abortSignal instanceof AbortSignal);
   assert.deepEqual(JSON.parse(await readFile(options.env.COMPLETION_APPLICATION_IDENTITY,'utf8')),{synthetic:'application-identity.json'});
   for(const path of ['PROTOCOL_OLD_MONITOR.mjs','preparation.json','capture.log','handler-capture/result.json','handler-capture/first/result.json','handler-capture/independent/result.json']){
    await mkdir(join(output,path,'..'),{recursive:true});await writeFile(join(output,path),JSON.stringify({synthetic:path}));
   }
   return {PROTOCOL_OLD_MONITOR:join(output,'PROTOCOL_OLD_MONITOR.mjs'),HOST_HANDLER_CAPTURE:join(output,'handler-capture/first/result.json')};
  },
 };
}
const completionTap='TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
function completionProbe(id,file,script) {
 return {id,files:[file],completionPrerequisites:completionPrerequisitesFor([file]),timeoutMs:5000,
  command:[process.execPath,'--import',fileURLToPath(new URL('../session/no-egress.mjs',import.meta.url)),'--input-type=module','--eval',script]};
}
function syntheticCompletionReceipt(gate,observed) {
 const identity={files:[],digest:digestJSON([])};
 return {kind:'qualification-functional-run-1',gates:[observed],selected:[gate.id],plan:{gates:[gate]},identity:{before:identity,after:identity},outcome:observed.outcome,scope:'Synthetic runner contract fixture only'};
}

test('actual Node gate receives sealed current issuer paths before eager import without a capture',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'completion-node-issuer-'));
 try{
  const fixture=completionPreparationFixture();
  const gate=completionProbe('node:editor','tests/editor/completion/candidate-corrections.test.mjs',`
   import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
   for(const [name,path] of [['COMPLETION_APPLICATION_IDENTITY','application-identity.json'],['COMPLETION_ISSUER_MANIFEST','host-final-issuers.json']])assert.deepEqual(JSON.parse(readFileSync(process.env[name],'utf8')),{synthetic:path});
   assert.equal(process.env.PROTOCOL_OLD_MONITOR,undefined);assert.equal(process.env.HOST_HANDLER_CAPTURE,undefined);
   process.stdout.write(${JSON.stringify(completionTap)});
  `);
  const observed=await executeGate(gate,directory,{},directory,undefined,fixture);
  assert.equal(observed.outcome,'PASS');assert.deepEqual(fixture.calls.map(c=>c.role),['issuers']);
  assert.deepEqual(observed.fixturePrerequisites.map(p=>p.name),['COMPLETION_APPLICATION_IDENTITY','COMPLETION_ISSUER_MANIFEST']);
  assert.deepEqual(observed.fixturePreparations.map(p=>p.role),['completion-issuers']);
  assert.equal(existsSync(join(directory,'tests/editor/completion/application-identity.json')),false);
  const receipt=syntheticCompletionReceipt(gate,observed),read=path=>readFileSync(join(directory,path));
  assert.equal(verifyReceipt(receipt,read).outcome,'PASS');
  for(const mutate of [r=>r.gates[0].fixturePrerequisites.pop(),r=>r.gates[0].fixturePreparations=[],r=>r.gates[0].fixturePreparations[0].files.pop()]){
   const changed=structuredClone(receipt);mutate(changed);assert.throws(()=>verifyReceipt(changed,read),/Missing (completion prerequisite closure|independent completion preparation)/);
  }
  const detached=structuredClone(receipt);detached.gates[0].fixturePrerequisites[0].path=detached.gates[0].fixturePreparations[0].output+'/receipt.json';
  const detachedBytes=read(detached.gates[0].fixturePrerequisites[0].path);Object.assign(detached.gates[0].fixturePrerequisites[0],{bytes:detachedBytes.length,sha256:sha256(detachedBytes)});
  assert.throws(()=>verifyReceipt(detached,read),/Completion input differs from sealed preparation/);
  const missingPlan=structuredClone(receipt);delete missingPlan.plan.gates[0].completionPrerequisites;
  assert.throws(()=>verifyReceipt(missingPlan,read),/Completion prerequisites differ from selected files/);
  const fullPlan=structuredClone(receipt);fullPlan.plan.gates[0].files=['tests/editor/completion/handler-source.test.mjs'];fullPlan.plan.gates[0].completionPrerequisites=completionPrerequisitesFor(fullPlan.plan.gates[0].files);
  assert.throws(()=>verifyReceipt(fullPlan,read),/Missing completion prerequisite closure/);
  await writeFile(join(directory,observed.fixturePrerequisites[0].path),'tampered');
  assert.throws(()=>verifyReceipt(receipt,read),/Fixture prerequisite digest mismatch/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('existing completion capture gates still prepare both independent inputs after current issuers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'completion-node-full-'));
 try{
  const fixture=completionPreparationFixture();
  const gate=completionProbe('node:editor','tests/editor/completion/handler-source.test.mjs',`
   import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
   for(const name of ['COMPLETION_APPLICATION_IDENTITY','COMPLETION_ISSUER_MANIFEST','PROTOCOL_OLD_MONITOR','HOST_HANDLER_CAPTURE'])assert.ok(readFileSync(process.env[name]).length);
   process.stdout.write(${JSON.stringify(completionTap)});
  `);
  const observed=await executeGate(gate,directory,{},directory,undefined,fixture);
  assert.equal(observed.outcome,'PASS');assert.deepEqual(fixture.calls.map(c=>c.role),['issuers','inputs']);
  assert.equal(observed.fixturePrerequisites.length,4);assert.deepEqual(observed.fixturePreparations.map(p=>p.role),['completion-issuers','completion-inputs']);
  assert.equal(verifyReceipt(syntheticCompletionReceipt(gate,observed),path=>readFileSync(join(directory,path))).outcome,'PASS');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('completion preparation failures, stale plans and changed retained inputs fail the gate',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'completion-node-refusal-'));
 try{
  const file='tests/editor/completion/candidate-corrections.test.mjs',marker=join(directory,'child-started');
  const gate=completionProbe('node:issuer-failure',file,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');process.stdout.write(${JSON.stringify(completionTap)});`);
  const refused=await executeGate(gate,directory,{},directory,undefined,{prepareIssuers:async()=>{throw Error('Synthetic issuer source mismatch');}});
  assert.equal(refused.outcome,'FAIL');assert.match(refused.error,/issuer source mismatch/);assert.equal(existsSync(marker),false);
  const stale={...gate,id:'node:stale',completionPrerequisites:{kind:'current-issuers-original-monitor-independent-capture-1'}},fixture=completionPreparationFixture();
  const rejected=await executeGate(stale,directory,{},directory,undefined,fixture);
  assert.equal(rejected.outcome,'FAIL');assert.match(rejected.error,/Completion prerequisites differ/);assert.deepEqual(fixture.calls,[]);assert.equal(existsSync(marker),false);
  const changed=completionProbe('node:changed',file,`import {writeFileSync} from 'node:fs';writeFileSync(process.env.COMPLETION_APPLICATION_IDENTITY,'changed');process.stdout.write(${JSON.stringify(completionTap)});`);
  const observed=await executeGate(changed,directory,{},directory,undefined,completionPreparationFixture());
  assert.equal(observed.outcome,'FAIL');assert.match(observed.error,/Prepared fixture changed during gate/);
 }finally{await rm(directory,{recursive:true,force:true});}
});


import {prepareCompletionIssuersChild} from '../../tooling/qualification/completion-issuers/prepare-child.mjs';
import {boundedChild as completionTestChild} from '../../tooling/qualification/container/bounded-child.mjs';
import {rename as publishCompletionTestAck,realpath as completionFixtureRealpath} from 'node:fs/promises';

// These tiny producers exercise child ownership and the retained-output handoff.
// Their synthetic issuer files are never application or qualification evidence.
async function completionChildFixture(mode='complete') {
 const directory=await completionFixtureRealpath(await mkdtemp(join(tmpdir(),'completion-issuer-child-')));
 const root=join(directory,'source'),output=join(directory,'issuers');
 try{
  await mkdir(join(root,'tooling/qualification/completion-issuers'),{recursive:true});
  await mkdir(join(root,'tests/session'),{recursive:true});
  await writeFile(join(root,'tests/session/no-egress.mjs'),await readFile(new URL('../session/no-egress.mjs',import.meta.url)));
  const script=`
   import assert from 'node:assert/strict';
   import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
   import {createHash} from 'node:crypto';
   import {join} from 'node:path';
   const mode=${JSON.stringify(mode)},output=${JSON.stringify(output)},root=${JSON.stringify(root)};
   assert.deepEqual(process.argv.slice(2),['--output',output]);
   assert.deepEqual(process.execArgv,['--import','./tests/session/no-egress.mjs']);
   assert.equal(process.cwd(),root);
   for(const name of ['NODE_OPTIONS','FAL_KEY','HTTPS_PROXY','COMPLETION_APPLICATION_IDENTITY','COMPLETION_ISSUER_MANIFEST'])assert.equal(process.env[name],undefined);
   assert.equal(process.env.LANG,'C');assert.equal(process.env.CI,'1');
   const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
   if(mode==='busy'){
    writeFileSync(join(root,'child-ready'),'ready');
    const deadline=Date.now()+10000;
    while(!existsSync(join(root,'parent-timer-ack'))){if(Date.now()>=deadline)throw Error('Parent timer did not run during synchronous child work');}
    assert.equal(readFileSync(join(root,'parent-timer-ack'),'utf8'),'ack-after-child-ready');
   }
   if(mode==='timeout'||mode==='abort'){
    process.on('SIGTERM',()=>{
     writeFileSync(join(root,'terminated'),'graceful-zero');
     process.stdout.write('TERM-zero\\n',()=>process.exit(0));
    });
    process.stdout.write('READY\\n');setInterval(()=>{},1000);
   }else{
    mkdirSync(output);
    const candidateFiles=['application-identity.json','host-final-issuers.json'].map(path=>{
     const bytes=Buffer.from(JSON.stringify({synthetic:path}));writeFileSync(join(output,path),bytes);
     return {path,bytes:bytes.length,sha256:hash(bytes)};
    });
    const receipt={schema:1,kind:'COMPLETION-ISSUER-ADOPTION-1',status:mode==='adopted'?'adopted':'prepared',candidateFiles};
    if(mode==='escape')receipt.candidateFiles[0].path='../application-identity.json';
    if(mode==='duplicate')receipt.candidateFiles[1]={...receipt.candidateFiles[0]};
    if(mode==='byte-length')receipt.candidateFiles[0].bytes++;
    if(mode!=='missing-receipt')writeFileSync(join(output,'receipt.json'),mode==='invalid-json'?'{':JSON.stringify(receipt));
    if(mode==='changed-file')writeFileSync(join(output,'host-final-issuers.json'),'changed after the retained pin');
    process.stdout.write(JSON.stringify({env:{COMPLETION_APPLICATION_IDENTITY:'/untrusted/stdout.json',UNEXPECTED_PUBLICATION:'refuse'}})+'\\n');
    process.stderr.write('synthetic issuer diagnostics\\n');
    if(mode==='nonzero')process.exitCode=7;
   }
  `;
  await writeFile(join(root,'tooling/qualification/completion-issuers/index.mjs'),script);
  return {directory,root,output};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}

const completionChildEnvironment=()=>({PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C',NODE_OPTIONS:'--invalid-injected-option',FAL_KEY:'synthetic-secret',HTTPS_PROXY:'http://synthetic.invalid',COMPLETION_APPLICATION_IDENTITY:'/stale/application.json',COMPLETION_ISSUER_MANIFEST:'/stale/issuers.json'});
async function completionChildObservation(output) {
 const retained=await readFile(output+'.child.json'),observation=JSON.parse(retained);
 const log=await readFile(output+'.log');
 assert.deepEqual(observation.logIdentity,{bytes:log.length,sha256:sha256(log)});
 assert.equal(observation.output,output);assert.equal(observation.log,output+'.log');
 return {observation,log,identity:{path:output+'.child.json',bytes:retained.length,sha256:sha256(retained)}};
}

test('issuer preparation runs synchronous producer work in a child while a parent timer progresses',async()=>{
 const fixture=await completionChildFixture('busy'),controller=new AbortController(),environment=completionChildEnvironment(),before={...environment};
 let pending,timer,acknowledgement,callbackError,ackStarted=false,seenChildReady=false,invocation;
 try{
  timer=setInterval(()=>{
   if(ackStarted||!existsSync(join(fixture.root,'child-ready')))return;
   ackStarted=true;seenChildReady=true;
   try{
    assert.equal(existsSync(join(fixture.output,'receipt.json')),false);
    acknowledgement=writeFile(join(fixture.root,'parent-timer-ack.tmp'),'ack-after-child-ready')
     .then(()=>publishCompletionTestAck(join(fixture.root,'parent-timer-ack.tmp'),join(fixture.root,'parent-timer-ack')))
     .catch(error=>{callbackError=error;controller.abort(error);});
   }catch(error){callbackError=error;controller.abort(error);}
  },5);
  pending=prepareCompletionIssuersChild(fixture.output,fixture.root,{env:environment,abortSignal:controller.signal,timeoutMs:15000},{runChild:async(executable,args,options)=>{
   invocation={executable,args,options};
   return completionTestChild(executable,args,options);
  }});
  const prepared=await pending.catch(async error=>{
   const diagnostic=await readFile(fixture.output+'.log').catch(()=>null);
   if(diagnostic?.length)error.message+='\nIssuer child diagnostic (first8KiB):\n'+diagnostic.subarray(0,8192).toString();
   throw error;
  });
  await acknowledgement;if(callbackError)throw callbackError;
  assert.equal(seenChildReady,true,'ACK came from a parent timer after actual child readiness');
  assert.equal(invocation.executable,process.execPath);
  assert.deepEqual(invocation.args,['--import','./tests/session/no-egress.mjs','tooling/qualification/completion-issuers/index.mjs','--output',fixture.output]);
  assert.equal(invocation.options.cwd,fixture.root);
  assert.ok(Number.isSafeInteger(invocation.options.timeoutMs)&&invocation.options.timeoutMs>0&&invocation.options.timeoutMs<=15000);
  assert.ok(invocation.options.abortSignal instanceof AbortSignal);
  assert.equal(invocation.options.env.PATH,join(fixture.root,'.toolchain/bin')+':'+environment.PATH);
  assert.equal(invocation.options.env.QUALIFICATION_OUTPUT,fixture.directory);
  assert.deepEqual(environment,before,'the supplied environment remains unchanged');
  assert.deepEqual(prepared.env,{COMPLETION_APPLICATION_IDENTITY:join(fixture.output,'application-identity.json'),COMPLETION_ISSUER_MANIFEST:join(fixture.output,'host-final-issuers.json')});
  assert.equal(prepared.adopted,false);assert.equal(prepared.receipt,join(fixture.output,'receipt.json'));assert.equal(prepared.childObservation,fixture.output+'.child.json');
  const {observation,log,identity}=await completionChildObservation(fixture.output);
  assert.deepEqual(prepared.preparation,identity,'the caller receives an exact retained preparation reference');
  assert.equal(observation.status,'complete');assert.equal(observation.child.code,0);
  assert.equal(observation.child.timedOut,false);assert.equal(observation.child.interrupted,false);
  assert.match(log.toString(),/synthetic issuer diagnostics/);
  assert.match(log.toString(),/untrusted\/stdout/);
  assert.equal(prepared.env.UNEXPECTED_PUBLICATION,undefined,'stdout cannot publish child-controlled environment keys');
 }finally{
  clearInterval(timer);controller.abort('test cleanup');
  await Promise.allSettled([pending,acknowledgement].filter(Boolean));
  await rm(fixture.directory,{recursive:true,force:true});
 }
});

test('issuer child nonzero exit retains valid partial files and diagnostics without publishing them',async()=>{
 const fixture=await completionChildFixture('nonzero');let published;
 try{
  await assert.rejects(async()=>{published=await prepareCompletionIssuersChild(fixture.output,fixture.root,{env:completionChildEnvironment(),timeoutMs:5000});},error=>error.code===7&&!error.timedOut&&!error.interrupted);
  assert.equal(published,undefined);
  assert.equal(JSON.parse(await readFile(join(fixture.output,'receipt.json'),'utf8')).status,'prepared','otherwise-valid files do not erase child failure');
  const {observation,log}=await completionChildObservation(fixture.output);
  assert.equal(observation.status,'failed');assert.equal(observation.child.code,7);
  assert.equal(observation.environment,undefined);assert.equal(observation.env,undefined);
  assert.match(log.toString(),/synthetic issuer diagnostics/);
 }finally{await rm(fixture.directory,{recursive:true,force:true});}
});

test('issuer deadline and abort await real bounded cleanup even when TERM exits zero',async t=>{
 for(const mode of ['timeout','abort'])await t.test(mode,async()=>{
  const fixture=await completionChildFixture(mode),controller=new AbortController();let pending,drained=false,ready='',published;
  try{
   pending=prepareCompletionIssuersChild(fixture.output,fixture.root,{env:completionChildEnvironment(),abortSignal:controller.signal,timeoutMs:mode==='timeout'?1500:5000},{runChild:async(executable,args,options)=>{
    // Only the synthetic fixture's cleanup grace is shortened. The real helper's
    // command, deadline, composed signal and boundedChild cleanup remain in use.
    const child=await completionTestChild(executable,args,{...options,graceMs:250,onStdout:chunk=>{
     options.onStdout(chunk);ready+=chunk.toString();
     if(mode==='abort'&&ready.includes('READY\n'))controller.abort('explicit issuer test cancellation');
    }});
    drained=true;return child;
   }});
   await assert.rejects(async()=>{published=await pending;},error=>{
    assert.equal(drained,true,'helper rejection follows the owned child cleanup');
    assert.equal(error.code,0,'the child handled TERM with a successful exit');
    assert.equal(error.timedOut,mode==='timeout');assert.equal(error.interrupted,mode==='abort');
    assert.equal(error.exitObserved,true);assert.deepEqual(error.requestedSignals,['SIGTERM','SIGKILL']);
    return true;
   });
   assert.equal(published,undefined);assert.match(ready,/TERM-zero/);
   assert.equal(await readFile(join(fixture.root,'terminated'),'utf8'),'graceful-zero');
   assert.equal(existsSync(fixture.output),false);
   const {observation,log}=await completionChildObservation(fixture.output);
   assert.equal(observation.status,'failed');assert.equal(observation.child.code,0);
   assert.equal(observation.child.timedOut,mode==='timeout');assert.equal(observation.child.interrupted,mode==='abort');
   assert.deepEqual(observation.child.requestedSignals,['SIGTERM','SIGKILL']);assert.match(log.toString(),/TERM-zero/);
  }finally{
   controller.abort('test cleanup');await Promise.allSettled([pending].filter(Boolean));
   await rm(fixture.directory,{recursive:true,force:true});
  }
 });
});

test('issuer child success cannot publish adopted, missing, malformed or mismatched output',async t=>{
 const cases=[['adopted',/Invalid non-adopting issuer receipt/],['missing-receipt',/ENOENT/],['invalid-json',/JSON|property|position/i],['escape',/Invalid non-adopting issuer receipt/],['duplicate',/Invalid non-adopting issuer receipt/],['byte-length',/Prepared issuer file differs/],['changed-file',/Prepared issuer file differs/]];
 for(const [mode,expected]of cases)await t.test(mode,async()=>{
  const fixture=await completionChildFixture(mode);let published;
  try{
   await assert.rejects(async()=>{published=await prepareCompletionIssuersChild(fixture.output,fixture.root,{env:completionChildEnvironment(),timeoutMs:5000});},expected);
   assert.equal(published,undefined);
   const {observation}=await completionChildObservation(fixture.output);
   assert.equal(observation.child.code,0);assert.equal(observation.status,'failed');
   assert.equal(existsSync(join(fixture.output,'application-identity.json')),true,'failed outputs remain for diagnosis');
   assert.equal(existsSync(join(fixture.root,'tests/editor/completion/application-identity.json')),false,'no source adoption occurs');
  }finally{await rm(fixture.directory,{recursive:true,force:true});}
 });
});

test('issuer preparation refuses an existing output before launching or replacing retained evidence',async()=>{
 const fixture=await completionChildFixture();let calls=0;
 try{
  await prepareCompletionIssuersChild(fixture.output,fixture.root,{env:completionChildEnvironment(),timeoutMs:5000});
  const retained=await Promise.all([fixture.output+'.child.json',fixture.output+'.log',join(fixture.output,'receipt.json')].map(path=>readFile(path)));
  await assert.rejects(prepareCompletionIssuersChild(fixture.output,fixture.root,{env:completionChildEnvironment(),timeoutMs:5000},{runChild:async()=>{calls++;throw Error('existing output launched');}}),/Fresh issuer receipt directory required/);
  assert.equal(calls,0);
  assert.deepEqual(await Promise.all([fixture.output+'.child.json',fixture.output+'.log',join(fixture.output,'receipt.json')].map(path=>readFile(path))),retained);
  await rm(fixture.output,{recursive:true,force:true});
  await assert.rejects(prepareCompletionIssuersChild(fixture.output,fixture.root,{env:completionChildEnvironment(),timeoutMs:5000},{runChild:async()=>{calls++;throw Error('retained sidecar launched');}}),/Fresh issuer receipt directory required/);
  assert.equal(calls,0,'a retained preparation sidecar also prevents output reuse');
  assert.deepEqual(await Promise.all([fixture.output+'.child.json',fixture.output+'.log'].map(path=>readFile(path))),retained.slice(0,2));
 }finally{await rm(fixture.directory,{recursive:true,force:true});}
});

test('issuer spawn rejection retains diagnostics and preserves the original failure',async()=>{
 const fixture=await completionChildFixture(),failure=Error('synthetic spawn refusal');let published;
 try{
  await assert.rejects(async()=>{published=await prepareCompletionIssuersChild(fixture.output,fixture.root,{env:completionChildEnvironment(),timeoutMs:5000},{runChild:async(_executable,_args,options)=>{options.onStderr(Buffer.from('spawn refused before exit\n'));throw failure;}});},error=>error===failure);
  assert.equal(published,undefined);assert.equal(existsSync(fixture.output),false);
  const {observation,log,identity}=await completionChildObservation(fixture.output);
  assert.equal(observation.status,'failed');assert.equal(observation.child,null);assert.equal(observation.error,failure.message);
  assert.deepEqual(failure.issuerPreparation,identity,'failure retains the same sealed preparation reference');
  assert.equal(log.toString(),'spawn refused before exit\n');
 }finally{await rm(fixture.directory,{recursive:true,force:true});}
});

test('executeGate forwards issuer preparation controls and retains failure evidence before any dependent command',async()=>{
 for(const mode of ['timeout','abort']){
  const directory=await mkdtemp(join(tmpdir(),'completion-issuer-gate-failure-')),controller=new AbortController();
  const environment={PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C'},before={...environment};
  const marker=join(directory,'dependent-command-started');let calls=0,inputCalls=0,preparation;
  const gate=completionProbe('node:issuer-'+mode,'tests/editor/completion/handler-source.test.mjs',`
   import {writeFileSync} from 'node:fs';
   writeFileSync(${JSON.stringify(marker)},'started');
   process.stdout.write(${JSON.stringify(completionTap)});
  `);
  gate.requiredEnvironment={IE_CAMPAIGN_PRODUCT_INTEGRATION:'1'};
  const failure=Object.assign(Error('Synthetic issuer '+mode),{signal:'SIGTERM',timedOut:mode==='timeout',interrupted:mode==='abort'});
  try{
   const observed=await executeGate(gate,directory,environment,directory,controller.signal,{
    prepareIssuers:async(output,cwd,options)=>{
     calls++;assert.equal(output,join(directory,'node-issuer-'+mode+'-completion-issuers'));assert.equal(cwd,directory);
     assert.deepEqual(options.env,{...environment,...gate.requiredEnvironment},'the gate forwards its constructed environment to the helper');
     assert.ok(options.abortSignal instanceof AbortSignal);assert.notEqual(options.abortSignal,controller.signal);
     assert.equal(options.abortSignal.aborted,false);
     assert.ok(Number.isSafeInteger(options.timeoutMs)&&options.timeoutMs>0&&options.timeoutMs<=gate.timeoutMs);
     if(mode==='abort'){
      controller.abort('issuer caller cancellation');
      assert.equal(options.abortSignal.aborted,true);assert.equal(options.abortSignal.reason,'issuer caller cancellation');
     }
     const bytes=Buffer.from(JSON.stringify({synthetic:true,status:'failed',child:{signal:failure.signal,timedOut:failure.timedOut,interrupted:failure.interrupted}}));
     preparation={path:output+'.child.json',bytes:bytes.length,sha256:sha256(bytes)};
     await writeFile(preparation.path,bytes);failure.issuerPreparation=preparation;
     throw failure;
    },
    prepareInputs:async()=>{inputCalls++;throw Error('Dependent capture must not start');},
   });
   assert.equal(calls,1);assert.equal(inputCalls,0);assert.equal(existsSync(marker),false);
   assert.deepEqual(environment,before);assert.equal(observed.outcome,'FAIL');assert.equal(observed.exitCode,null);
   assert.equal(observed.signal,'SIGTERM');assert.equal(observed.timedOut,mode==='timeout');assert.equal(Boolean(observed.interrupted),mode==='abort');
   assert.equal(observed.error,failure.message);assert.deepEqual(observed.issuerPreparation,preparation);
   const retained=await readFile(observed.issuerPreparation.path);
   assert.equal(retained.length,preparation.bytes);assert.equal(sha256(retained),preparation.sha256);
   assert.equal(observed.fixturePreparations,undefined);assert.equal(observed.fixturePrerequisites,undefined);
  }finally{controller.abort('test cleanup');await rm(directory,{recursive:true,force:true});}
 }
});


// Guard partitions keep one logical campaign selection while changing the real
// child launch boundary only for the exact warm composition test file.
import {readdirSync} from 'node:fs';
const warmCompositionGuardFile = 'tests/campaigns/backend-composition-warm.test.mjs';
function discoveredCampaignTestFiles(root, directory='tests/campaigns') {
  return readdirSync(join(root,directory),{withFileTypes:true}).flatMap(entry=>{
    const path=`${directory}/${entry.name}`;
    return entry.isDirectory()?discoveredCampaignTestFiles(root,path):entry.isFile()&&entry.name.endsWith('.test.mjs')?[path]:[];
  }).sort();
}

test('formal campaign guard partition owns every discovered file once and launches the strict file with the real preload', () => {
  const root=fileURLToPath(new URL('../../',import.meta.url)),gates=functionalGates(root);
  const ordinary=gates.find(gate=>gate.id==='node:campaigns'),strict=gates.find(gate=>gate.id==='node:campaigns:store');
  assert.ok(ordinary);assert.ok(strict);
  assert.equal(gates.indexOf(strict),gates.indexOf(ordinary)+1,'The guard sibling retains the campaign position');
  assert.equal(strict.selectionGroup,'node:campaigns');
  assert.deepEqual(strict.files,[warmCompositionGuardFile]);
  assert.equal(ordinary.files.includes(warmCompositionGuardFile),false);
  const expected=discoveredCampaignTestFiles(root),partition=[...ordinary.files,...strict.files];
  assert.deepEqual([...partition].sort(),expected);
  assert.equal(partition.length,new Set(partition).size);
  assert.equal(new Set(gates.flatMap(gate=>gate.files??[])).size,gates.flatMap(gate=>gate.files??[]).length);
  for(const file of expected)assert.equal(gates.flatMap(gate=>gate.files??[]).filter(value=>value===file).length,1,file);
  assert.equal(ordinary.guard,'tests/session/no-egress.mjs');
  assert.deepEqual(ordinary.command.slice(0,6),['node','--import','./tests/session/no-egress.mjs','--test','--test-reporter=tap','--test-concurrency=1']);
  assert.equal(strict.guard,'tests/store/no-network.mjs');
  assert.deepEqual(strict.command,['node','--import','./tests/store/no-network.mjs','--test','--test-reporter=tap','--test-concurrency=1',warmCompositionGuardFile]);
  for(const gate of [ordinary,strict]){
    assert.deepEqual(gate.requiredEnvironment,{IE_CAMPAIGN_PRODUCT_INTEGRATION:'1'});
    assert.deepEqual(gate.dependencies,['build-server']);
    assert.equal(gate.command.some(arg=>arg.startsWith('--test-name-pattern')||arg.startsWith('--input-type')),false);
  }
  for(const file of ['backend-queue-product','backend-reset-product','backend-transfer-product'])assert.ok(ordinary.files.includes(`tests/campaigns/${file}.test.mjs`),'Loopback consumers remain in the ordinary partition');
});

test('formal parent campaign selectors expand guard siblings once with and without dependency execution', () => {
  const root=fileURLToPath(new URL('../../',import.meta.url)),gates=functionalGates(root),expected=discoveredCampaignTestFiles(root);
  const family=['node:campaigns','node:campaigns:store'];
  for(const selector of ['node:campaigns','helpers','all','node:campaigns:store,node:campaigns'])for(const includeDependencies of [true,false]){
    const selected=selectGates(gates,selector,{includeDependencies}),ids=selected.map(gate=>gate.id);
    assert.equal(ids.length,new Set(ids).size,selector);
    assert.deepEqual(ids.filter(id=>family.includes(id)),family,selector);
    const files=selected.filter(gate=>family.includes(gate.id)).flatMap(gate=>gate.files);
    assert.deepEqual([...files].sort(),expected,selector);
    assert.equal(new Set(files).size,files.length,selector);
    if(includeDependencies){
      for(const id of ['typecheck','preflight','build-app','build-server'])assert.equal(ids.filter(value=>value===id).length,1,id);
      assert.ok(ids.indexOf('typecheck')<ids.indexOf('preflight'));
      assert.ok(ids.indexOf('build-server')<ids.indexOf('node:campaigns'));
    }else if(selector!=='all')assert.equal(ids.some(id=>!id.startsWith('node:')),false,'Dependencies are not silently reintroduced');
  }
  const strictOnly=selectGates(gates,'node:campaigns:store',{includeDependencies:false});
  assert.deepEqual(strictOnly.map(gate=>gate.id),['node:campaigns:store']);
  assert.deepEqual(strictOnly[0].files,[warmCompositionGuardFile]);
  assert.throws(()=>selectGates(gates,'node:campaigns,node:campaigns'),/Duplicate/);
  assert.throws(()=>selectGates(gates,'node:campaigns:store,node:campaigns:store'),/Duplicate/);
});


import {nodeClassification,discoverNodeFiles} from '../../tooling/qualification/developer-campaigns/selectors.mjs';
import {nodeGuardForFile} from '../../tooling/qualification/suite-prerequisites.mjs';

test('developer campaign discovery agrees with the exact warm guard override and leaves same-basename files ordinary',async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url)),discovered=await discoverNodeFiles(root),gates=functionalGates(root);
  const cases=[
    {file:warmCompositionGuardFile,guard:'tests/store/no-network.mjs',gate:'node:campaigns:store'},
    {file:'tests/campaigns/backend-queue-product.test.mjs',guard:'tests/session/no-egress.mjs',gate:'node:campaigns'},
  ];
  for(const {file,guard,gate} of cases){
    const classified=nodeClassification(file);
    assert.equal(classified.guard,guard);assert.equal(classified.method,'L');assert.deepEqual(classified.contracts,['L-runner']);
    assert.equal(nodeGuardForFile('campaigns',file),guard);
    assert.deepEqual(discovered.find(entry=>entry.file===file),{file,...classified});
    assert.equal(gates.find(entry=>entry.id===gate).guard,guard);
    assert.ok(gates.find(entry=>entry.id===gate).files.includes(file));
  }
  const sameBasename='tests/campaigns/nested/backend-composition-warm.test.mjs';
  assert.equal(nodeGuardForFile('campaigns',sameBasename),'tests/session/no-egress.mjs');
  assert.equal(nodeClassification(sameBasename).guard,'tests/session/no-egress.mjs');
});

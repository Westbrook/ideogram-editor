import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm, realpath, mkdir, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {commandSchedule, commandBudgets, developerCommandPlan, summarizeCommands, observeD11Build} from '../../tooling/qualification/developer-campaigns/commands.mjs';
import {caseIdentity, classifySuite, validateBrowserSelection, validateFocused, nodeClassification, exactPattern, nativeNodeBrowserFiles, contractsForCase} from '../../tooling/qualification/developer-campaigns/selectors.mjs';
import BrowserReporter from '../../tooling/qualification/developer-campaigns/browser-reporter.mjs';
import {cleanEnvironment, execute, json} from '../../tooling/qualification/developer-campaigns/common.mjs';
import {browserCacheIdentity} from '../../tooling/qualification/developer-campaigns/verify-browsers.mjs';
import {campaignPlan, parseCampaignOptions} from '../../tooling/qualification/developer-campaigns/run.mjs';

const observed = (method, file, name, status = 'passed') => ({type: 'case', id: caseIdentity(method, file, name), file, method, name, occurrence: 1, status});
test('campaign entry routes exact I0 host stages and rejects incomplete or ambiguous execution', () => {
  for (const campaign of ['I0', 'I1', 'I2']) {
    assert.equal(parseCampaignOptions(['--campaign', campaign]).plan, true);
    assert.equal(campaignPlan(campaign).qualification, false);
    assert.throws(() => parseCampaignOptions(['--campaign', campaign, '--run']), /requires --install/);
    assert.throws(() => parseCampaignOptions(['--campaign', campaign, '--plan', '--output', 'bad']), /not applicable/);
  }
  const stage = ['--campaign', 'I0', '--run', '--install', '--ci-plan', '/plan.json', '--received', '/received', '--workspace', '/subjects', '--output', '/new', '--stage', 'q3-candidate-i0-cold-H'];
  assert.equal(parseCampaignOptions(stage).stage, 'q3-candidate-i0-cold-H');
  assert.throws(() => parseCampaignOptions([...stage.slice(0, -1), 'p-candidate-prepareC']), /exact revision/);
  assert.throws(() => parseCampaignOptions(['--campaign', 'I2', '--run', '--install']), /requires --recipe/);
  assert.throws(() => parseCampaignOptions(['--campaign', 'I1', '--verify']), /not applicable/);
});
function completeGroups() {
  return commandSchedule().map(group => ({...group, scored: true, status: 'completed', elapsedMs: 100000,
    d11: observeD11Build(buildInventory()),
    phases: Object.entries(commandBudgets).filter(([id]) => !/^(install|browser)-/.test(id) || id.endsWith(group.cache)).map(([id]) => ({id, outcome: 'PASS', elapsedMs: id === 'cold-build' ? 1000 : id === 'install-cold' ? 1000 : id === 'install-warm' ? 500 : 100}))}));
}
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function ordered(value) { return value && typeof value === 'object' ? Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value; }
function sealBuild(value) { const {sha256, ...contents} = value; return {...contents, sha256: digest(JSON.stringify(ordered(contents)))}; }
// Synthetic byte-accounting specimens: never runnable editor artifacts or
// qualification evidence. The production reader separately checks disk bytes.
function buildInventory() {
  const file = (file, kind, bytes, extra = {}) => ({file, kind, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: digest(bytes), authoringFont: false, ...extra});
  const files = [file('inline:bootstrap', 'js', Buffer.from('pair();')), file('main.js', 'js', Buffer.from('boot();')),
    file('shared.js', 'js', Buffer.from('shared();')), file('panel.js', 'js', Buffer.from('panel();')),
    file('dialog.js', 'js', Buffer.from('dialog();')), file('worker.js', 'js', Buffer.from('worker();')),
    file('engine.wasm', 'wasm', Buffer.from([0, 97, 115, 109])), file('ui.css', 'css', Buffer.from('body{}')), file('ui.woff2', 'font', Buffer.from('ui font')),
    file('authoring.ttf', 'font', Buffer.from('font'), {authoringFont: true})];
  return sealBuild({kind: 'perf-d11-build-1', files, textWasmHash: files.find(file => file.kind === 'wasm').sha256,
    duplicateVersions: [{package: 'synthetic-package', versions: ['1.0.0', '2.0.0']}],
    roles: {complete: true, missing: [], startupFiles: ['inline:bootstrap', 'main.js', 'shared.js', 'ui.css', 'ui.woff2'],
      lazyFeatures: [{id: 'dialog', files: ['dialog.js', 'shared.js']}, {id: 'panel', files: ['panel.js', 'shared.js']}],
      textEngineFiles: ['worker.js', 'engine.wasm'], uiCssFontFiles: ['ui.css', 'ui.woff2']}});
}
test('D11 C build counts actual inline startup and each complete lazy closure with shared code once', () => {
  const inventory = buildInventory(), observed = observeD11Build(inventory);
  assert.equal(observed.status, 'PASS'); assert.deepEqual(observed.missing, []);
  assert.equal(observed.inventory, inventory); assert.deepEqual(observed.inventory.duplicateVersions, inventory.duplicateVersions);
  assert.deepEqual(observed.featureIds, ['dialog', 'panel']);
  const bytes = name => inventory.files.find(file => file.file === name).gzipBytes;
  const metric = name => observed.measurements.find(row => row.name === name);
  assert.equal(metric('D11BuildStartupJsGzipBytes').value, bytes('inline:bootstrap') + bytes('main.js') + bytes('shared.js'));
  assert.equal(metric('D11BuildUiCssFontGzipBytes').value, bytes('ui.css') + bytes('ui.woff2'));
  for (const feature of observed.features) {
    assert.equal(feature.gzipBytes, bytes(feature.id + '.js') + bytes('shared.js'));
    assert.equal(feature.evidence.buildSha256, inventory.sha256);
    assert.deepEqual(feature.files, [feature.id + '.js', 'shared.js']);
  }
  assert.equal(metric('D11BuildLazyFeatureGzipBytes').value, Math.max(...observed.features.map(feature => feature.gzipBytes)));
  assert.equal(observed.measurements.length, 5);
  assert(observed.measurements.every(row => row.name.startsWith('D11Build') && row.evidence.buildSha256 === inventory.sha256));
});
test('D11 ambiguous source roles retain inventory and cannot emit substitute zero budget observations', () => {
  const inventory = buildInventory(); inventory.roles.complete = false; inventory.roles.missing = ['Dynamic import cannot be classified'];
  const observed = observeD11Build(sealBuild(inventory));
  assert.equal(observed.status, 'INCONCLUSIVE'); assert.deepEqual(observed.measurements, []);
  assert(observed.missing.includes('Dynamic import cannot be classified'));
  delete inventory.roles; assert.equal(observeD11Build(sealBuild(inventory)).status, 'INCONCLUSIVE');
});
test('D11 refuses role aliasing, unknown files, engine leakage and authoring fonts counted as UI', () => {
  const mutations = [
    value => value.roles.startupFiles.push('main.js'),
    value => value.roles.startupFiles.push('absent.js'),
    value => value.roles.lazyFeatures[0].files.push('engine.wasm'),
    value => value.roles.lazyFeatures.push(value.roles.lazyFeatures[0]),
    value => value.roles.uiCssFontFiles.push('authoring.ttf'),
    value => value.roles.textEngineFiles.splice(1, 1),
  ];
  for (const change of mutations) { const inventory = buildInventory(); change(inventory); assert.throws(() => observeD11Build(sealBuild(inventory)), /D11/); }
  const changed = buildInventory(); changed.files[0].gzipBytes++;
  assert.throws(() => observeD11Build(changed), /seal/);
});
test('D11 proven absent lazy features differ from missing classification, and ceilings remain enforced', () => {
  const none = buildInventory(); none.roles.lazyFeatures = [];
  assert.equal(observeD11Build(sealBuild(none)).measurements.find(row => row.name === 'D11BuildLazyFeatureGzipBytes').value, 0);
  const large = buildInventory(); large.files.find(file => file.file === 'panel.js').gzipBytes = 300 * 1024 + 1;
  const observed = observeD11Build(sealBuild(large));
  assert.equal(observed.status, 'FAIL'); assert.equal(observed.features.length, 2);
  assert.equal(observed.budgets.find(row => row.name === 'D11BuildLazyFeatureGzipBytes').outcome, 'FAIL');
});
test('D11 positive eager authoring-font or text-WASM evidence fails even when another role is missing', () => {
  for (const [path, id] of [['authoring.ttf', 'D11-build-eager-authoring-font'], ['engine.wasm', 'D11-build-eager-text-wasm']]) {
    const inventory = buildInventory(); inventory.roles.startupFiles.push(path);
    const complete = observeD11Build(sealBuild(inventory));
    assert.equal(complete.status, 'FAIL'); assert.equal(complete.measurements.length, 5);
    assert.equal(complete.violations[0].id, id); assert.equal(complete.violations[0].evidence.files[0].file, path);
    inventory.roles.complete = false; inventory.roles.missing = ['Another computed import is unresolved'];
    const incomplete = observeD11Build(sealBuild(inventory));
    assert.equal(incomplete.status, 'FAIL'); assert.equal(incomplete.violations[0].id, id); assert(incomplete.missing.length > 0);
  }
});
test('I1 requires complete matching D11 evidence and rejects changed retained measurements', () => {
  const missing = completeGroups(); delete missing[0].d11;
  assert.equal(summarizeCommands(missing).outcome, 'INCONCLUSIVE');
  const incomplete = completeGroups(), inventory = buildInventory(); inventory.roles.complete = false;
  incomplete[0].d11 = observeD11Build(sealBuild(inventory)); assert.equal(summarizeCommands(incomplete).outcome, 'INCONCLUSIVE');
  const forged = completeGroups(); forged[0].d11.features[0].gzipBytes++;
  assert.equal(summarizeCommands(forged).outcome, 'FAIL');
  const falseBudget = completeGroups(); falseBudget[0].d11.budgets[0].ceiling++;
  assert.equal(summarizeCommands(falseBudget).outcome, 'FAIL');
  const changed = completeGroups(), variant = buildInventory(); variant.files[0].rawBytes++;
  changed[0].d11 = observeD11Build(sealBuild(variant));
  assert.equal(summarizeCommands(changed).buildIdentityMismatch, true);
  assert.equal(summarizeCommands(changed).outcome, 'FAIL');
});
test('I1 has ten independent cold/warm groups and never recursively schedules I0', () => {
  const plan = developerCommandPlan();
  assert.deepEqual(plan.schedule.filter(item => item.cache === 'cold').map(item => item.ordinal), [1, 2, 3, 4, 5]);
  assert.deepEqual(plan.schedule.filter(item => item.cache === 'warm').map(item => item.ordinal), [1, 2, 3, 4, 5]);
  assert.equal(plan.qualification, false); assert(!plan.schedule.some(item => item.id.includes('I0')));
});
test('five-per-cache medians/maxima and D10 ratios retain missing, failed and slow samples', () => {
  assert.equal(summarizeCommands(completeGroups()).outcome, 'PASS');
  assert.equal(summarizeCommands(completeGroups().slice(0, 9)).outcome, 'INCONCLUSIVE');
  const failed = completeGroups(); failed[0].status = 'failed'; assert.equal(summarizeCommands(failed).outcome, 'FAIL');
  const slow = completeGroups(); slow[0].phases.find(phase => phase.id === 'full-unit').elapsedMs = 30001;
  assert.equal(summarizeCommands(slow).outcome, 'FAIL');
  const overhead = completeGroups(); overhead[0].elapsedMs = 1200001; assert.equal(summarizeCommands(overhead).outcome, 'FAIL');
  const cache = completeGroups(); for (const group of cache.filter(group => group.cache === 'warm')) group.phases.find(phase => phase.id === 'install-warm').elapsedMs = 801;
  assert.equal(summarizeCommands(cache).ratios.find(item => item.id === 'D10-install').outcome, 'FAIL');
});
test('focused fixture selects existing risk cases with exact 100/10/5 and E1–E4 aliases', async () => {
  const fixture = validateFocused(JSON.parse(await readFile('tooling/qualification/developer-campaigns/focused.json')));
  assert.deepEqual([fixture.unit.length, fixture.integration.length, fixture.browser.length], [100, 10, 5]);
  for (const alias of ['E1', 'E2', 'E3', 'E4']) assert(fixture.browser.some(item => item.contracts.includes(alias)));
  for (const item of fixture.browser) for (const alias of item.contracts.filter(value => /^(E|AX)/.test(value))) assert(contractsForCase('B', item.file, item.name).includes(alias));
  assert.equal(fixture.browser.find(item => item.contracts.includes('E1')).file, 'tests/editor/integration.spec.ts');
  const missing = structuredClone(fixture); missing.unit.pop(); assert.throws(() => validateFocused(missing), /exactly 100/);
  const forged = structuredClone(fixture); forged.integration[0].id = fixture.unit[0].id; assert.throws(() => validateFocused(forged), /contract mapping/);
});
test('focused report admits only selected successes while retaining deliberately filtered siblings', () => {
  const file = 'tests/request/core.test.mjs', selected = observed('U', file, 'A'), sibling = observed('U', file, 'B', 'skipped');
  const report = [selected, sibling, {type: 'end', status: 'passed'}];
  assert.equal(classifySuite(report, {method: 'U', files: [file], expected: [selected]}).outcome, 'PASS');
  assert.equal(classifySuite(report, {method: 'U', files: [file]}).outcome, 'FAIL');
  assert.equal(classifySuite([sibling, {type: 'end', status: 'passed'}], {method: 'U', files: [file], expected: [selected]}).outcome, 'FAIL');
  assert.equal(classifySuite([...report, selected], {method: 'U', files: [file], expected: [selected]}).outcome, 'FAIL');
});
test('browser evidence rejects dropped discovery, duplicate completion, skipped and changed IDs', () => {
  const file = 'tests/editor/integration.spec.ts', item = {...observed('B', file, 'E1'), frameworkId: 'one'};
  const good = [{type: 'discovery', ids: ['one'], files: [file]}, item, {type: 'end', status: 'passed'}];
  assert.equal(validateBrowserSelection(good, [file]).outcome, 'PASS');
  assert.equal(validateBrowserSelection(good.slice(1), [file]).outcome, 'FAIL');
  assert.equal(validateBrowserSelection([good[0], item, item, good[2]], [file]).outcome, 'FAIL');
  assert.equal(validateBrowserSelection([{...good[0], ids: ['other']}, item, good[2]], [file]).outcome, 'FAIL');
  assert.equal(validateBrowserSelection([good[0], {...item, status: 'skipped'}, good[2]], [file]).outcome, 'FAIL');
  assert.equal(validateBrowserSelection(good, [file, 'tests/recovery/e4.spec.ts']).outcome, 'FAIL');
});
test('exact Node patterns escape operators and stable method IDs cannot cross namespaces', () => {
  const pattern = new RegExp(exactPattern(['A (x)', 'zero + one?', 'x$']));
  assert(pattern.test('A (x)')); assert(!pattern.test('A x')); assert(!pattern.test('prefix A (x)'));
  assert.notEqual(caseIdentity('U', 'tests/a.test.mjs', 'same'), caseIdentity('L', 'tests/a.test.mjs', 'same'));
  assert.throws(() => caseIdentity('U', '../elsewhere', 'same'), /Unsafe/);
  assert.equal(nodeClassification('tests/store/core.test.mjs').guard, 'tests/store/no-network.mjs');
  assert.equal(nodeClassification('tests/provider/runtime.test.mjs').guard, 'tests/provider/no-egress.mjs');
  assert.equal(nativeNodeBrowserFiles.length, 7);
  assert(nativeNodeBrowserFiles.includes('tests/browser/wa-observation.test.mjs'));
  assert.deepEqual(nodeClassification('tests/browser/wa-observation.test.mjs'), {method: 'B', guard: 'tests/session/no-egress.mjs', contracts: ['B-controls']});
  assert.equal(nodeClassification('tests/campaigns/browser-wa-requests.test.mjs').method, 'U');
  assert(nativeNodeBrowserFiles.includes('tests/editor/model-memory-browser.test.mjs'));
  assert.deepEqual(nodeClassification('tests/editor/model-memory-browser.test.mjs'), {method: 'B', guard: 'tests/session/no-egress.mjs', contracts: ['B-controls']});
  for (const file of nativeNodeBrowserFiles) assert.equal(nodeClassification(file).method, 'B');
});
test('reporter retains framework identity and full title without changing stable leaf name', () => {
  const reporter = new BrowserReporter();
  const testCase = {id: 'pw-1', title: 'E1', titlePath: () => ['', 'chromium', 'a.spec.ts', 'group', 'E1'], location: {file: process.cwd() + '/tests/editor/a.spec.ts', line: 2, column: 1}, expectedStatus: 'passed'};
  reporter.onBegin({workers: 1}, {allTests: () => [testCase]});
  reporter.onTestEnd(testCase, {status: 'passed', retry: 0, duration: 4});
  const item = reporter.records.find(value => value.type === 'case');
  assert.equal(item.name, 'E1'); assert.equal(item.frameworkId, 'pw-1'); assert.deepEqual(item.titlePath, testCase.titlePath());
});
test('real Node reporter exposes complete outcomes and exact selected case identity', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'developer-reporter-test-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const file = 'tests/qualification/fixtures/reporter-input.mjs', expected = observed('U', file, 'included [exact] case');
  for (const mode of ['focused', 'full', 'browser']) {
    const method = mode === 'browser' ? 'B' : 'U';
    const report = join(directory, mode + '.ndjson');
    const result = await execute({id: mode, command: [process.execPath, '--import', './tests/session/no-egress.mjs', '--test', '--test-reporter', './tooling/qualification/developer-campaigns/node-reporter.mjs', '--test-reporter-destination', report,
      ...(mode === 'focused' ? ['--test-name-pattern', exactPattern([expected.name])] : []), file], cwd: process.cwd(),
      env: {PATH: process.env.PATH, QUALIFICATION_METHOD: method}, directory, timeoutMs: 10000});
    assert.equal(result.outcome, 'PASS');
    const records = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const resultCases = classifySuite(records, {method, files: [file], expected: mode === 'focused' ? [expected] : null});
    assert.equal(resultCases.outcome, 'PASS', json(resultCases)); assert.equal(resultCases.executed, mode === 'focused' ? 1 : 2);
  }
});
test('browser cache seals auxiliary headless/resources and refuses links outside the owned cache', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'developer-browser-cache-test-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const cache = join(directory, 'cache'); await mkdir(cache); await mkdir(join(cache, 'chromium')); await mkdir(join(cache, '.links'));
  await writeFile(join(cache, 'chromium', 'full-browser'), 'full'); await writeFile(join(cache, 'chromium', 'headless-shell'), 'headless'); await writeFile(join(cache, '.links', 'owner'), '/first-source');
  const before = await browserCacheIdentity(cache); await writeFile(join(cache, '.links', 'owner'), '/next-source');
  assert.equal((await browserCacheIdentity(cache)).sha256, before.sha256);
  await writeFile(join(cache, 'chromium', 'headless-shell'), 'changed'); assert.notEqual((await browserCacheIdentity(cache)).sha256, before.sha256);
  await writeFile(join(directory, 'outside'), 'private'); await symlink('../outside', join(cache, 'escape')); await assert.rejects(browserCacheIdentity(cache), /leaves its sealed cache/);
});

test('campaign clean environment preserves only the explicitly configured D11 archive cache', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'developer-d11-environment-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const npmCache = join(directory, 'owned-install-cache'), browserCache = join(directory, 'browsers');
  const explicit = join(directory, 'selected archive cache');
  const configured = await cleanEnvironment({workspace: join(directory, 'configured'), npmCache, browserCache,
    env: {IE_D11_NPM_CACHE: explicit, npm_config_cache: '/unselected', NODE_OPTIONS: '--import untrusted.mjs'}});
  assert.equal(configured.IE_D11_NPM_CACHE, explicit);
  assert.equal(configured.npm_config_cache, npmCache);
  assert.equal(Object.hasOwn(configured, 'NODE_OPTIONS'), false);
  for (const [name, env] of [['absent', {}], ['install-only', {npm_config_cache: explicit}]]) {
    const clean = await cleanEnvironment({workspace: join(directory, name), npmCache, browserCache, env});
    assert.equal(Object.hasOwn(clean, 'IE_D11_NPM_CACHE'), false);
    assert.equal(clean.npm_config_cache, npmCache);
  }
  // Preserve invalid explicit configuration for the strict reader to reject;
  // environmental cleanup must not silently replace it with a usable cache.
  for (const [name, value] of [['empty', ''], ['relative', 'relative-cache']]) {
    const clean = await cleanEnvironment({workspace: join(directory, name), npmCache, browserCache, env: {IE_D11_NPM_CACHE: value}});
    assert.equal(clean.IE_D11_NPM_CACHE, value);
  }
});

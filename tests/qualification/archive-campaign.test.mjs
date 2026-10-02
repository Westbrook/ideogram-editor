import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, symlink, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {archiveBudgets, archivePlan, producerCommands, packageNames, validateArchiveRecipe,
  validateFrozenManifests, extractFrozenPython, verifyPackedResult, adoptedConsumerPackage,
  browserResultCounts, summarizeArchiveCampaign, runArchiveCampaign, sealedBrowserConfig, registrationTitles, validateArchiveSample, runArchiveSample, validateArchiveSampleReceipt, publishArchiveReceipt, validatePreparedBrowser, prepareArchiveRecipe} from '../../tooling/qualification/developer-campaigns/archive.mjs';
import {execute} from '../../tooling/qualification/developer-campaigns/common.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixedHash = digest('sealed input');
const clone = value => structuredClone(value);
async function workspace(t) {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'archive-campaign-test-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}
async function assertRequiresArchiveOutput(run, options, work) {
  const recipePath = join(work, 'unread-recipe.json');
  for (const flags of [{}, {install: true}, {recipePath}, {install: true, recipePath}]) {
    await assert.rejects(run({...options, ...flags}), /requires explicit output/);
  }
  assert.deepEqual(await readdir(work), []);
}
function recipe() {
  return {schema: 1, kind: 'archive-upgrade-recipe-1', frozenDirectory: '/sealed/source',
    sourceManifest: {path: 'source-manifest.json', sha256: fixedHash}, packagesManifest: {path: 'packages.json', sha256: fixedHash},
    producerCommands: clone(producerCommands), consumer: {config: 'tests/consumer/playwright.config.ts', configSha256: fixedHash,
      test: 'tests/consumer/registration.spec.ts', testSha256: fixedHash, expectedTests: 2},
    browser: {cacheDirectory: '/sealed/browsers', executable: '/sealed/browsers/chromium/chrome', sha256: fixedHash, playwrightVersion: '1.63.0', revision: '1243', version: '153.0.8010.12'}};
}
function manifests() {
  const paths = ['LICENSE', 'package.json', 'package-lock.json', ...packageNames.map(name => `packages/${name.split('/')[1]}/package.json`)].sort();
  const files = paths.map(path => ({path, bytes: 1, sha256: fixedHash, mode: 0o644}));
  const sourceIdentity = digest(JSON.stringify(files));
  const manifest = {schema: 1, sourceIdentity, files, sourceArchive: {path: 'source.tar.gz', bytes: 100, sha256: fixedHash},
    provenance: {'source.patch': {bytes: 0, sha256: digest('')}, 'source-status.z': {bytes: 0, sha256: digest('')}}};
  const packages = {schema: 1, sourceIdentity, packages: packageNames.map(name => ({name, version: '0.1.0', filename: name.replace('@', '').replace('/', '-') + '-0.1.0.tgz', bytes: 1,
    sha256: fixedHash, integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), shasum: 'a'.repeat(40), dependencies: {}, peerDependencies: {}}))};
  return {manifest, packages};
}
function completeRuns() {
  return archivePlan().runs.map(run => ({...run, status: 'passed', timings: {sourceInstall: 100000, producer: 240000, upgrade: 400000, wholeRun: 510000, resetAndReceipt: 10000}}));
}
function browserReport() {
  return {config: {version: '1.63.0', workers: 1, projects: [{name: 'archive-chromium', id: 'archive-chromium', retries: 0}]},
    errors: [], stats: {expected: 2, unexpected: 0, skipped: 0, flaky: 0}, suites: [{specs: [], suites: [{file: 'registration.spec.ts', specs: registrationTitles.map(title =>
      ({title, tests: [{expectedStatus: 'passed', status: 'expected', projectName: 'archive-chromium', projectId: 'archive-chromium', results: [{status: 'passed', retry: 0}]}]}))}]}]};
}

test('I2 inventory is exactly five cold and five warm complete runs with nested producer accounting', () => {
  const plan = archivePlan();
  assert.deepEqual(plan.runs.map(run => run.id), ['cold-1', 'cold-2', 'cold-3', 'cold-4', 'cold-5', 'warm-1', 'warm-2', 'warm-3', 'warm-4', 'warm-5']);
  assert.deepEqual(archiveBudgets.sourceInstall, {id: 'D09-source-install', targetMs: 120000, ceilingMs: 240000});
  assert.deepEqual(archiveBudgets.producer, {id: 'D09-producer', targetMs: 300000, ceilingMs: 600000});
  assert.deepEqual(archiveBudgets.upgrade, {id: 'D09-upgrade', targetMs: 480000, ceilingMs: 900000});
  assert.equal(archiveBudgets.wholeRun.ceilingMs, 1200000);
  assert.ok(plan.boundaries.some(text => /producer timer exactly once/.test(text)));
  assert.equal(summarizeArchiveCampaign(completeRuns()).outcome, 'PASS');
  assert.ok(plan.consumerCommands.findIndex(args => args[1] === 'verify:vendor') < plan.consumerCommands.findIndex(args => args[0] === 'ci'));
});
test('runtime bridge sample selection never expands one start into a complete campaign', async t => {
  assert.deepEqual(validateArchiveSample({cache: 'warm', ordinal: 3, cacheStateDirectory: '/owned/private-state'}), {cache: 'warm', ordinal: 3, id: 'warm-3', cacheStateDirectory: '/owned/private-state'});
  for (const value of [{cache: 'normal', ordinal: 1, cacheStateDirectory: '/owned'}, {cache: 'cold', ordinal: 6, cacheStateDirectory: '/owned'}, {cache: 'cold', ordinal: 0, cacheStateDirectory: '/owned'}, {cache: 'cold', ordinal: 1, cacheStateDirectory: 'relative'}]) assert.throws(() => validateArchiveSample(value));
  const work = await workspace(t);
  await assertRequiresArchiveOutput(runArchiveSample, {cache: 'cold', ordinal: 1, cacheStateDirectory: join(work, 'uncreated-cache')}, work);
});
test('cache handoff requires a complete successful sample, exact commands, browser cases, archive quartet and timing bounds', () => {
  const commands = Array.from({length: 2 + producerCommands.length + archivePlan().consumerCommands.length + 1}, (_, index) => ({id: `command-${index}`, outcome: 'PASS', exitCode: 0, timedOut: false, interrupted: false}));
  const run = completeRuns()[0]; run.commands = commands.map(command => command.id); run.browserCounts = {tests: 2, passed: 2, failed: 0, skipped: 0, retries: 0}; run.producedArchives = manifests().packages.packages;
  const receipt = {kind: 'archive-upgrade-sample-1', status: 'passed-local-sample', summary: {outcome: 'PASS', completeCampaign: false, firstArchiveQualified: false}, cacheKey: fixedHash,
    run, commands, adoptedConsumerLock: {sha256: fixedHash, bytes: 100}};
  assert.equal(validateArchiveSampleReceipt(receipt, fixedHash, 'cold-1'), true);
  for (const mutate of [value => value.status = 'failed', value => value.summary.firstArchiveQualified = true, value => value.cacheKey = digest('other'),
    value => value.run.timings.producer = value.run.timings.upgrade + 1, value => value.run.timings.resetAndReceipt = 60001,
    value => value.run.producedArchives.pop(), value => value.run.browserCounts.passed = 1, value => value.commands.pop(),
    value => value.commands[0].timedOut = true, value => delete value.adoptedConsumerLock]) {
    const changed = clone(receipt); mutate(changed); assert.throws(() => validateArchiveSampleReceipt(changed, fixedHash, 'cold-1'));
  }
});
test('slow final publication and post-command cancellation rewrite failure before returning', async () => {
  function receipt() {
    const run = completeRuns()[0]; run.spans = {wholeRun: {start: 0, end: 510000}};
    return {sample: {cache: 'cold', ordinal: 1}, monotonicStartedAt: 0, runs: [run], status: 'passed-local-sample', summary: {outcome: 'PASS'}};
  }
  let clock = 510000; const slow = receipt(), versions = [];
  await publishArchiveReceipt({receipt: slow, now: () => clock, save: async () => { versions.push(clone(slow)); clock += 60000; }});
  assert.equal(versions.length, 2); assert.equal(versions[0].status, 'passed-local-sample'); assert.equal(versions[1].status, 'failed');
  assert.equal(slow.summary.outcome, 'FAIL'); assert.match(slow.failure, /reset\/receipt ceiling/);
  const interrupted = receipt(), controller = new AbortController(), saved = [];
  await publishArchiveReceipt({receipt: interrupted, now: () => 510000, abortSignal: controller.signal,
    save: async () => { saved.push(clone(interrupted)); controller.abort(); }});
  assert.equal(saved.length, 2); assert.equal(saved[1].status, 'failed'); assert.equal(interrupted.interrupted, true);
});
test('recipe seals exact source, producer inventory, both browser cases and pinned browser identity', () => {
  assert.equal(validateArchiveRecipe(recipe()).consumer.expectedTests, 2);
  for (const mutate of [
    value => value.producerCommands.pop(), value => value.producerCommands.reverse(), value => value.producerCommands.push(['run', 'docs']),
    value => value.sourceManifest.path = '../source-manifest.json', value => value.sourceManifest.sha256 = 'unknown',
    value => value.frozenDirectory = 'relative', value => value.consumer.expectedTests = 1, value => value.consumer.test = 'tests/other.spec.ts',
    value => value.browser.executable = '/other/chrome', value => value.browser.revision = '1244', value => value.browser.playwrightVersion = 'latest',
    value => value.arbitraryCommand = ['sh', '-c', 'true'],
  ]) { const changed = recipe(); mutate(changed); assert.throws(() => validateArchiveRecipe(changed)); }
});
test('recipe preparation requires the actual pinned Chromium version and explicit new output/cache', async () => {
  const metadata = {playwrightVersion: '1.63.0', chromium: {revision: '1243', browserVersion: '153.0.8010.12'}, executable: '/owned/browsers/chromium/chrome'};
  assert.equal(validatePreparedBrowser(metadata, 'Chromium 153.0.8010.12\n', metadata.executable), true);
  assert.equal(validatePreparedBrowser(metadata, 'Google Chrome for Testing 153.0.8010.12\n', metadata.executable), true);
  for (const [value, version, executable] of [
    [{...metadata, playwrightVersion: '1.62.0'}, 'Chromium 153.0.8010.12', metadata.executable],
    [metadata, 'Chromium 152.0.1.2', metadata.executable], [metadata, 'Chromium 153.0.8010.12', '/another/browser'],
    [{...metadata, chromium: {...metadata.chromium, revision: '1244'}}, 'Chromium 153.0.8010.12', metadata.executable],
  ]) assert.throws(() => validatePreparedBrowser(value, version, executable));
  await assert.rejects(prepareArchiveRecipe({}), /requires --browser-cache/);
});
test('frozen source identity includes complete sorted source manifest and exact four-package graph', () => {
  const {manifest, packages} = manifests();
  assert.equal(validateFrozenManifests(manifest, packages).sourceIdentity, manifest.sourceIdentity);
  const cases = [
    (m, p) => m.files.reverse(), (m, p) => m.files[0].path = '../LICENSE', (m, p) => m.files.push(clone(m.files[0])),
    (m, p) => m.files[0].mode = 0o777, (m, p) => m.sourceArchive.path = '../source.tar.gz', (m, p) => delete m.provenance['source.patch'],
    (m, p) => p.sourceIdentity = digest('another source'), (m, p) => p.packages.pop(), (m, p) => p.packages[1].filename = p.packages[0].filename,
    (m, p) => p.packages[2].dependencies = {'@en-reve/missing': '0.1.0'}, (m, p) => p.packages[2].dependencies = {'@en-reve/tokens': '0.2.0'},
    (m, p) => p.packages[2].dependencies = {lit: 'file:../../sibling'},
  ];
  for (const mutate of cases) { const m = clone(manifest), p = clone(packages); mutate(m, p); assert.throws(() => validateFrozenManifests(m, p)); }
  const m = clone(manifest); m.files.push({path: 'z/node_modules/a.js', bytes: 1, sha256: fixedHash, mode: 0o644}); m.sourceIdentity = digest(JSON.stringify(m.files));
  assert.throws(() => validateFrozenManifests(m, {...packages, sourceIdentity: m.sourceIdentity}), /output, dependency or toolchain/);
});
test('coherent adoption returns a fresh package object and changes all four dependencies together', () => {
  const {manifest, packages} = manifests();
  const original = {name: 'consumer', dependencies: Object.fromEntries([...packageNames.map(name => [name, 'file:vendor/old.tgz']), ['lit', '3.3.3']])};
  const result = adoptedConsumerPackage(original, manifest.sourceIdentity, packages.packages);
  for (const pkg of packages.packages) {
    assert.equal(original.dependencies[pkg.name], 'file:vendor/old.tgz');
    assert.equal(result.dependencies[pkg.name], `file:vendor/en-reve/${manifest.sourceIdentity}/${pkg.filename}`);
  }
  assert.equal(result.dependencies.lit, '3.3.3');
  assert.throws(() => adoptedConsumerPackage(original, manifest.sourceIdentity, packages.packages.slice(1)), /Incomplete/);
  assert.throws(() => adoptedConsumerPackage({dependencies: {}}, manifest.sourceIdentity, packages.packages), /all four/);
});
test('actual produced bytes must match expected SHA-256, npm SHA-512, SHA-1, size and source graph', () => {
  const bytes = Buffer.from('actual archive bytes'), name = '@en-reve/tokens';
  const expected = {name, version: '0.1.0', filename: 'en-reve-tokens-0.1.0.tgz', bytes: bytes.length, sha256: digest(bytes),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), shasum: createHash('sha1').update(bytes).digest('hex'), dependencies: {}, peerDependencies: {}};
  const result = {...expected, size: bytes.length, unpackedSize: 100, files: [{path: 'package.json'}]};
  const source = {name, version: '0.1.0'};
  assert.equal(verifyPackedResult(result, expected, bytes, source).sha256, expected.sha256);
  assert.throws(() => verifyPackedResult(result, expected, Buffer.from('other bytes'), source), /differs/);
  assert.throws(() => verifyPackedResult({...result, size: 0}, expected, bytes, source), /size differs/);
  assert.throws(() => verifyPackedResult(result, expected, bytes, {...source, dependencies: {lit: '3.3.3'}}), /graph differs/);
  assert.throws(() => verifyPackedResult({...result, files: []}, expected, bytes, source), /Unexpected/);
});
test('browser receipts reject skipped, flaky, retried, failed, missing or unexpected tests even with exit zero', () => {
  assert.deepEqual(browserResultCounts(browserReport()), {tests: 2, passed: 2, failed: 0, skipped: 0, retries: 0});
  for (const mutate of [
    value => value.stats.skipped = 1, value => value.stats.flaky = 1, value => value.stats.unexpected = 1,
    value => value.errors.push({message: 'setup failed'}), value => value.suites[0].suites[0].specs.pop(),
    value => value.suites[0].suites[0].specs[0].tests[0].results.push({status: 'passed'}),
    value => value.suites[0].suites[0].specs[0].tests[0].expectedStatus = 'failed',
    value => value.suites[0].suites[0].specs[0].tests[0].results[0].status = 'skipped',
    value => value.suites[0].suites[0].specs[0].title = registrationTitles[1], value => value.suites[0].suites[0].file = 'other.spec.ts',
    value => value.suites[0].suites[0].specs[0].tests[0].projectId = 'other', value => value.config.projects[0].retries = 1,
  ]) { const changed = browserReport(); mutate(changed); assert.throws(() => browserResultCounts(changed), /incomplete/); }
});
test('owned browser configuration forces the sealed executable for headless launch', () => {
  const executable = '/sealed/cache/Chromium.app/Contents/MacOS/Chromium';
  const config = sealedBrowserConfig(executable, fixedHash);
  assert.match(config, /import base from '\.\/playwright\.config'/);
  assert.ok(config.includes(`executablePath: ${JSON.stringify(executable)}`));
  assert.match(config, /browserName: 'chromium', headless: true/);
  assert.match(config, /forbidOnly: true/);
  assert.ok(config.includes(`archiveExecutableSha256: "${fixedHash}"`));
  assert.throws(() => sealedBrowserConfig('relative/chromium', fixedHash));
});
test('median target and maximum ceiling are evaluated independently for cold and warm cohorts', () => {
  const runs = completeRuns();
  for (let i = 0; i < 5; i++) runs[i].timings.sourceInstall = 130000;
  for (const run of runs) { run.timings.wholeRun = run.timings.sourceInstall + run.timings.upgrade + run.timings.resetAndReceipt; }
  let summary = summarizeArchiveCampaign(runs);
  assert.equal(summary.outcome, 'TARGET_MISSED');
  assert.equal(summary.cells.find(cell => cell.cache === 'cold' && cell.phase === 'sourceInstall').medianMs, 130000);
  assert.equal(summary.cells.find(cell => cell.cache === 'warm' && cell.phase === 'sourceInstall').outcome, 'PASS');
  runs[0].timings.sourceInstall = 240000.001; runs[0].timings.wholeRun = runs[0].timings.sourceInstall + runs[0].timings.upgrade + runs[0].timings.resetAndReceipt;
  summary = summarizeArchiveCampaign(runs); assert.equal(summary.outcome, 'FAIL');
});
test('failed, omitted, duplicate, reordered, incomplete-timing and invalid nested runs cannot pass', () => {
  const cases = [
    runs => runs.pop(), runs => runs.reverse(), runs => runs[1] = clone(runs[0]), runs => runs[2].status = 'failed',
    runs => runs[3].status = 'running', runs => delete runs[4].timings.wholeRun, runs => runs[4].timings.producer = runs[4].timings.upgrade + 1,
    runs => runs[4].timings.wholeRun = 1, runs => runs[4].timings.resetAndReceipt = 60001,
  ];
  for (const mutate of cases) { const runs = completeRuns(); mutate(runs); assert.notEqual(summarizeArchiveCampaign(runs).outcome, 'PASS'); }
  const missing = summarizeArchiveCampaign([]); assert.equal(missing.outcome, 'INCOMPLETE'); assert.equal(missing.complete, false);
});

async function tarFixture(work, members) {
  const archive = join(work, 'source.tar.gz'), spec = join(work, 'members.json');
  await writeFile(spec, JSON.stringify(members));
  const script = String.raw`import io,json,tarfile,sys
with tarfile.open(sys.argv[2],'w:gz') as archive:
 for item in json.load(open(sys.argv[1])):
  data=item.get('text','').encode(); entry=tarfile.TarInfo(item['path']); entry.mode=item.get('mode',420)
  if 'link' in item: entry.type=tarfile.SYMTYPE; entry.linkname=item['link']; archive.addfile(entry)
  else: entry.size=len(data); archive.addfile(entry,io.BytesIO(data))
`;
  const result = spawnSync('python3', ['-c', script, spec, archive], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr); return archive;
}
test('real sealed source extraction rejects links, traversal, duplicate/extra/missing members and mismatched bytes', async t => {
  const work = await workspace(t), files = [{path: 'LICENSE', bytes: 7, sha256: digest('license'), mode: 0o644}, {path: 'src/a.js', bytes: 4, sha256: digest('code'), mode: 0o644}];
  const manifest = join(work, 'manifest.json'); await writeFile(manifest, JSON.stringify({sourceIdentity: fixedHash, files}));
  const original = [{path: 'LICENSE', text: 'license'}, {path: 'src/a.js', text: 'code'}];
  const mutations = [null, list => list[0] = {path: 'LICENSE', link: '/tmp/escape'}, list => list[0].path = '../LICENSE',
    list => list.push(clone(list[1])), list => list.pop(), list => list[1].text = 'evil', list => list[1].mode = 0o755];
  for (const [index, mutate] of mutations.entries()) {
    const folder = join(work, `case-${index}`); await mkdir(folder); const destination = join(folder, 'output'); await mkdir(destination);
    const members = clone(original); if (mutate) mutate(members); const archive = await tarFixture(folder, members);
    const result = await execute({id: `extract-${index}`, command: ['python3', '-c', extractFrozenPython, manifest, archive, destination], cwd: folder, env: {PATH: process.env.PATH}, directory: join(folder, 'logs')});
    if (index === 0) { assert.equal(result.exitCode, 0); assert.equal(await readFile(join(destination, 'src/a.js'), 'utf8'), 'code'); }
    else assert.notEqual(result.exitCode, 0, `case ${index} should reject`);
    assert.equal(result.stdout.sha256, digest(await readFile(result.stdout.path)));
    assert.equal(result.stderr.sha256, digest(await readFile(result.stderr.path)));
  }
  await assert.rejects(stat(join(work, 'LICENSE')), {code: 'ENOENT'});
});
test('extraction never follows an existing destination link', async t => {
  const work = await workspace(t), destination = join(work, 'output'), outside = join(work, 'outside'); await mkdir(destination); await mkdir(outside);
  await symlink(outside, join(destination, 'src'));
  const file = {path: 'src/a.js', bytes: 4, sha256: digest('code'), mode: 0o644}, manifest = join(work, 'manifest.json');
  await writeFile(manifest, JSON.stringify({sourceIdentity: fixedHash, files: [file]}));
  const archive = await tarFixture(work, [{path: 'src/a.js', text: 'code'}]);
  const result = await execute({id: 'linked-output', command: ['python3', '-c', extractFrozenPython, manifest, archive, destination], cwd: work, env: {PATH: process.env.PATH}, directory: join(work, 'logs')});
  assert.notEqual(result.exitCode, 0); assert.deepEqual(await readdir(outside), []);
});
test('default CLI is inert and execution requires explicit output before install/recipe checks', async t => {
  const work = await workspace(t), script = resolve('tooling/qualification/developer-campaigns/archive.mjs');
  const result = spawnSync(process.execPath, [script], {cwd: work, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).mode, 'plan'); assert.deepEqual(await readdir(work), []);
  const missing = spawnSync(process.execPath, [script, '--run'], {cwd: work, encoding: 'utf8'});
  assert.equal(missing.status, 1); assert.match(missing.stderr, /requires explicit output/); assert.deepEqual(await readdir(work), []);
  const incompleteRecipe = spawnSync(process.execPath, [script, '--run', '--output', join(work, 'uncreated-output'), '--install', '--recipe'], {cwd: work, encoding: 'utf8'});
  assert.equal(incompleteRecipe.status, 1); assert.match(incompleteRecipe.stderr, /Unknown or incomplete option: --recipe/); assert.deepEqual(await readdir(work), []);
  await assertRequiresArchiveOutput(runArchiveCampaign, {}, work);
});

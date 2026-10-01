#!/usr/bin/env node
/** PERF I2 / D09. Plans are inert. Execution installs only in retained, isolated
 * snapshots; it never rewrites the selected checkout or a published archive. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile, writeFile, mkdir, realpath, lstat, copyFile} from 'node:fs/promises';
import {resolve, join, dirname, basename, isAbsolute, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotSource} from '../dev.mjs';
import {sha256, json, hashFile, fileManifest, verifyManifest, sourcePaths, cleanEnvironment,
  execute, createRun, toolchain, assertSuccess, observedEnvironment} from './common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const names = ['tokens', 'styles', 'primitives', 'elements'];
export const packageNames = Object.freeze(names.map(name => `@en-reve/${name}`));
export const archiveBudgets = Object.freeze({
  sourceInstall: {id: 'D09-source-install', targetMs: 120000, ceilingMs: 240000},
  producer: {id: 'D09-producer', targetMs: 300000, ceilingMs: 600000},
  upgrade: {id: 'D09-upgrade', targetMs: 480000, ceilingMs: 900000},
  resetAndReceipt: {id: 'I2-reset-receipt', ceilingMs: 60000},
  wholeRun: {id: 'I2-whole-run', ceilingMs: 1200000},
});
export const producerCommands = Object.freeze([
  ...names.map(name => ['run', 'build', '-w', `@en-reve/${name}`]),
  ['run', 'metadata'],
  ...['check:lazy', 'check:types', 'check:api', 'check:customization'].map(script => ['run', script]),
  ...names.map(name => ['pack', '--json', '--pack-destination', '<packs>', '-w', `@en-reve/${name}`]),
]);
const hashPattern = /^[0-9a-f]{64}$/;
const ownedBrowserConfig = 'tests/consumer/archive-qualification.config.ts';
const browserProject = 'archive-chromium';
export const registrationTitles = Object.freeze(['auto', 'global'].map(registry => `public packed registration, interaction and lazy readiness (${registry})`));
function fail(message) { throw new Error(message); }
function safePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`Unsafe frozen path: ${path}`);
  return path;
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(`Invalid ${label} fields`);
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function revision(directory) {
  const args = ['rev-parse', '--verify', 'HEAD'];
  const value = spawnSync('git', args, {cwd: directory, env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin'}, encoding: 'utf8'});
  const head = value.stdout?.trim();
  if (value.status !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head ?? '')) fail('Cannot seal the consumer Git revision');
  return {head, command: ['git', ...args]};
}

export function archivePlan() {
  return {schema: 1, kind: 'archive-upgrade-plan-1', mode: 'plan', budget: 'I2', row: 'D09',
    runs: ['cold', 'warm'].flatMap(cache => Array.from({length: 5}, (_, index) => ({id: `${cache}-${index + 1}`, cache, ordinal: index + 1}))),
    budgets: archiveBudgets, producerCommands,
    sourceInstall: ['ci', '--no-audit', '--no-fund'],
    consumerCommands: [['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'verify:vendor'], ['ci', '--no-audit', '--no-fund'],
      ['ls', '--all', '--json'], ['run', 'verify:imports'], ['run', 'typecheck:consumer'], ['run', 'build:consumer'],
      ['exec', '--', 'playwright', 'test', '--config', ownedBrowserConfig]],
    boundaries: [
      'Each of ten runs starts with fresh producer and consumer source trees and no node_modules or build outputs.',
      'Source npm ci is separately timed. The upgrade timer starts before production and contains the producer timer exactly once.',
      'All build/metadata caches remain cold; warm means the declared registry caches populated by the fifth cold run, plus the observed host filesystem cache.',
      'Frozen source, license, four produced archives, package graph, lock update, clean consumer install and the exact two public registration browser cases are verified.',
      'Browser provisioning is a sealed prerequisite; its executable is checked before and after use and explicitly selected by an owned config derived from the frozen config. No browser download is hidden in a sample.',
      'A successful local campaign does not certify PERF C hardware, network N, native accessibility, other Q3 blocks, or a release.',
      'Every failure, interruption, timeout, missing/skipped/flaky test, changed input and budget breach is retained and prevents a campaign pass.',
    ],
    recipe: {schema: 1, kind: 'archive-upgrade-recipe-1', frozenDirectory: '<absolute frozen directory>',
      sourceManifest: {path: 'source-manifest.json', sha256: '<SHA-256 of exact manifest bytes>'},
      packagesManifest: {path: 'packages.json', sha256: '<SHA-256 of exact expected packages bytes>'},
      producerCommands, consumer: {config: 'tests/consumer/playwright.config.ts', configSha256: '<SHA-256>', test: 'tests/consumer/registration.spec.ts', testSha256: '<SHA-256>', expectedTests: 2},
      browser: {cacheDirectory: '<absolute installed Playwright browser cache>', executable: '<absolute Chromium executable>', sha256: '<SHA-256>', playwrightVersion: '1.63.0', revision: '1243', version: '153.0.8010.12'}},
    execute: 'node tooling/qualification/developer-campaigns/archive.mjs --run --install --recipe <sealed.json> [--output <new-directory>]',
    prepare: 'node tooling/qualification/developer-campaigns/archive.mjs --prepare-recipe --browser-cache <installed-cache> --output <new-recipe.json> [--frozen <frozen-directory>] [--browser-executable <exact-chromium>]',
  };
}

export function validateArchiveRecipe(recipe) {
  exactKeys(recipe, ['schema', 'kind', 'frozenDirectory', 'sourceManifest', 'packagesManifest', 'producerCommands', 'consumer', 'browser'], 'recipe');
  if (recipe.schema !== 1 || recipe.kind !== 'archive-upgrade-recipe-1' || !isAbsolute(recipe.frozenDirectory)) fail('A sealed absolute frozen source directory is required');
  for (const key of ['sourceManifest', 'packagesManifest']) {
    exactKeys(recipe[key], ['path', 'sha256'], key);
    safePath(recipe[key].path);
    if (!hashPattern.test(recipe[key].sha256)) fail(`Invalid ${key} SHA-256`);
  }
  if (recipe.sourceManifest.path !== 'source-manifest.json' || recipe.packagesManifest.path !== 'packages.json') fail('Use the producer manifest names');
  if (!same(recipe.producerCommands, producerCommands)) fail('Producer command inventory differs from the required coherent build/check/pack sequence');
  exactKeys(recipe.consumer, ['config', 'configSha256', 'test', 'testSha256', 'expectedTests'], 'consumer');
  if (recipe.consumer.config !== 'tests/consumer/playwright.config.ts' || recipe.consumer.test !== 'tests/consumer/registration.spec.ts' || recipe.consumer.expectedTests !== 2 || !hashPattern.test(recipe.consumer.configSha256) || !hashPattern.test(recipe.consumer.testSha256)) fail('Consumer selection must seal both public registration cases and their configuration');
  exactKeys(recipe.browser, ['cacheDirectory', 'executable', 'sha256', 'playwrightVersion', 'revision', 'version'], 'browser');
  if (!isAbsolute(recipe.browser.cacheDirectory) || !isAbsolute(recipe.browser.executable) || !recipe.browser.executable.startsWith(recipe.browser.cacheDirectory + sep) || !hashPattern.test(recipe.browser.sha256) || recipe.browser.playwrightVersion !== '1.63.0' || recipe.browser.revision !== '1243' || recipe.browser.version !== '153.0.8010.12') fail('Browser must use the pinned, preinstalled Chromium identity');
  return recipe;
}

export function validateFrozenManifests(manifest, packages) {
  if (manifest?.schema !== 1 || !hashPattern.test(manifest.sourceIdentity) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000) fail('Invalid frozen source manifest');
  let last = '';
  for (const file of manifest.files) {
    exactKeys(file, ['path', 'bytes', 'sha256', 'mode'], 'source file'); safePath(file.path);
    if (file.path <= last || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !hashPattern.test(file.sha256) || ![0o644, 0o755].includes(file.mode)) fail('Source paths must be sorted unique regular files with exact lengths and modes');
    if (file.path.split('/').some(part => ['node_modules', 'dist', '.git', '.toolchain', '.toolchains', '.vite'].includes(part))) fail('Frozen source contains an output, dependency or toolchain directory');
    last = file.path;
  }
  if (sha256(JSON.stringify(manifest.files)) !== manifest.sourceIdentity) fail('Frozen source identity does not match its complete file manifest');
  for (const path of ['package.json', 'package-lock.json', 'LICENSE', ...names.map(name => `packages/${name}/package.json`)]) if (!manifest.files.some(file => file.path === path)) fail(`Missing required producer input: ${path}`);
  const archive = manifest.sourceArchive;
  if (!archive || safePath(archive.path) !== 'source.tar.gz' || !Number.isSafeInteger(archive.bytes) || archive.bytes <= 0 || archive.bytes > 512 * 1024 * 1024 || !hashPattern.test(archive.sha256)) fail('Invalid source archive seal');
  if (!manifest.provenance || !same(Object.keys(manifest.provenance).sort(), ['source-status.z', 'source.patch'])) fail('Both producer provenance files are required');
  for (const value of Object.values(manifest.provenance)) if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || !hashPattern.test(value.sha256)) fail('Invalid producer provenance seal');
  if (packages?.schema !== 1 || packages.sourceIdentity !== manifest.sourceIdentity || !Array.isArray(packages.packages) || packages.packages.length !== 4 || !same(packages.packages.map(item => item.name).sort(), [...packageNames].sort())) fail('Expected exactly four packages from the same frozen source');
  const filenames = new Set();
  for (const pkg of packages.packages) {
    if (safePath(pkg.filename).includes('/') || filenames.has(pkg.filename) || !pkg.filename.endsWith('.tgz') || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version) || !Number.isSafeInteger(pkg.bytes) || pkg.bytes <= 0 || !hashPattern.test(pkg.sha256) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity) || !/^[0-9a-f]{40}$/.test(pkg.shasum)) fail('Invalid expected archive identity');
    filenames.add(pkg.filename);
    for (const [dependency, version] of Object.entries({...pkg.dependencies, ...pkg.peerDependencies})) {
      if (dependency.startsWith('@en-reve/') && (!packageNames.includes(dependency) || version !== packages.packages.find(item => item.name === dependency)?.version)) fail('Private package graph must resolve entirely to the four coherent archives');
      if (typeof version !== 'string' || /^(?:file:|link:|workspace:|https?:|git)/.test(version)) fail('Archive graph contains an external source or local dependency');
    }
  }
  return {sourceIdentity: manifest.sourceIdentity, fileCount: manifest.files.length, packages: packageNames};
}

// No tar extraction API is trusted to follow archive paths. The sealed inventory
// must match in order; each member is streamed into a new regular file itself.
export const extractFrozenPython = String.raw`import hashlib,json,os,pathlib,sys,tarfile
manifest=json.load(open(sys.argv[1],encoding='utf-8')); target=pathlib.Path(sys.argv[3]); seen=[]
with tarfile.open(sys.argv[2],mode='r|gz') as archive:
 for index,member in enumerate(archive):
  if index>=len(manifest['files']): raise ValueError('Extra source archive member')
  record=manifest['files'][index]; parts=pathlib.PurePosixPath(member.name).parts
  if member.name!=record['path'] or not member.isfile() or member.name.startswith('/') or '\\' in member.name or any(p in ('','..','.') for p in parts) or member.mode!=record['mode'] or member.size!=record['bytes']: raise ValueError('Unsafe or mismatching source archive member')
  output=target.joinpath(*parts); output.parent.mkdir(parents=True,exist_ok=True)
  if any(p.is_symlink() for p in [output,*output.parents]): raise ValueError('Source extraction link')
  digest=hashlib.sha256(); count=0
  with archive.extractfile(member) as source,open(output,'xb') as sink:
   while True:
    chunk=source.read(1048576)
    if not chunk: break
    sink.write(chunk); digest.update(chunk); count+=len(chunk)
  if count!=record['bytes'] or digest.hexdigest()!=record['sha256']: raise ValueError('Source content seal mismatch')
  os.chmod(output,record['mode']); seen.append(member.name)
if seen!=[r['path'] for r in manifest['files']]: raise ValueError('Missing source archive member')
print(json.dumps({'files':len(seen),'sourceIdentity':manifest['sourceIdentity']}))
`;

export function verifyPackedResult(result, expected, bytes, sourcePackage) {
  if (!result || result.name !== expected.name || result.filename !== expected.filename || result.version !== expected.version || !Array.isArray(result.files) || !result.files.length) fail('Unexpected npm 12 pack result');
  const actual = {bytes: bytes.length, sha256: sha256(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex')};
  for (const field of ['bytes', 'sha256', 'integrity', 'shasum']) if (actual[field] !== expected[field]) fail(`Produced archive differs from sealed expected identity: ${expected.name} ${field}`);
  if (result.integrity !== actual.integrity || result.shasum !== actual.shasum || result.size !== actual.bytes) fail('npm pack digest or size differs from the produced bytes');
  for (const field of ['name', 'version']) if (sourcePackage[field] !== expected[field]) fail('Produced package identity differs from source');
  for (const field of ['dependencies', 'peerDependencies']) if (!same(sourcePackage[field] ?? {}, expected[field] ?? {})) fail('Produced graph differs from sealed expected graph');
  return {...expected, files: result.files, unpackedSize: result.unpackedSize};
}

export function adoptedConsumerPackage(pkg, sourceIdentity, packages) {
  if (!hashPattern.test(sourceIdentity) || !pkg.dependencies || !packageNames.every(name => typeof pkg.dependencies[name] === 'string')) fail('Consumer must declare all four runtime dependencies');
  const result = structuredClone(pkg);
  for (const name of packageNames) {
    const records = packages.filter(item => item.name === name);
    if (records.length !== 1 || safePath(records[0].filename).includes('/')) fail('Incomplete coherent archive adoption');
    result.dependencies[name] = `file:vendor/en-reve/${sourceIdentity}/${records[0].filename}`;
  }
  return result;
}

export function browserResultCounts(report, expectedTests = 2) {
  const cases = [];
  const walk = suite => { for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) cases.push({test, title: spec.title, file: spec.file ?? suite.file}); for (const child of suite.suites ?? []) walk(child); };
  for (const suite of report.suites ?? []) walk(suite);
  const passed = cases.filter(({test}) => test.status === 'expected' && test.expectedStatus === 'passed' && test.results?.length === 1 && test.results[0].status === 'passed' && test.results[0].retry === 0 && test.projectName === browserProject && test.projectId === browserProject).length;
  const stats = report.stats ?? {};
  const projects = report.config?.projects ?? [];
  if (report.errors?.length || report.config?.version !== '1.63.0' || report.config?.workers !== 1 || projects.length !== 1 || projects[0].name !== browserProject || projects[0].id !== browserProject || projects[0].retries !== 0 ||
    cases.some(item => item.file !== 'registration.spec.ts') || !same(cases.map(item => item.title).sort(), [...registrationTitles].sort()) ||
    cases.length !== expectedTests || passed !== expectedTests || stats.expected !== expectedTests || stats.unexpected !== 0 || stats.flaky !== 0 || stats.skipped !== 0) fail(`Public browser selection incomplete: expected ${expectedTests} clean passes, got ${passed}/${cases.length}`);
  return {tests: cases.length, passed, failed: 0, skipped: 0, retries: 0};
}

export function sealedBrowserConfig(executable, executableSha256) {
  if (!isAbsolute(executable) || !hashPattern.test(executableSha256)) fail('An exact browser executable seal is required');
  return `import base from './playwright.config';\nexport default {...base, projects: [{name: '${browserProject}'}], workers: 1, retries: 0, forbidOnly: true, use: {...base.use, browserName: 'chromium', headless: true, launchOptions: {...base.use?.launchOptions, executablePath: ${JSON.stringify(executable)}}}, metadata: {...base.metadata, archiveExecutableSha256: ${JSON.stringify(executableSha256)}}};\n`;
}

export function summarizeArchiveCampaign(runs) {
  const expected = archivePlan().runs;
  const complete = runs.length === 10 && runs.every((run, index) => run.id === expected[index].id && run.cache === expected[index].cache && run.ordinal === expected[index].ordinal);
  const cells = [];
  for (const cache of ['cold', 'warm']) for (const [name, budget] of Object.entries(archiveBudgets).filter(([name]) => !['resetAndReceipt', 'wholeRun'].includes(name))) {
    const selected = runs.filter(run => run.cache === cache), values = selected.map(run => run.timings?.[name]).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const valid = selected.length === 5 && selected.every(run => run.status === 'passed') && values.length === 5;
    cells.push({cache, phase: name, samples: values.length, medianMs: values.length ? values[Math.ceil(values.length / 2) - 1] : null, maximumMs: values.length ? values.at(-1) : null,
      targetMs: budget.targetMs, ceilingMs: budget.ceilingMs, outcome: !valid ? 'INCOMPLETE' : values.at(-1) > budget.ceilingMs ? 'FAIL' : values[2] > budget.targetMs ? 'TARGET_MISSED' : 'PASS'});
  }
  const failed = runs.some(run => run.status === 'failed' || Object.entries(archiveBudgets).some(([phase, budget]) => run.timings?.[phase] > budget.ceilingMs));
  const missingTimings = runs.some(run => Object.keys(archiveBudgets).some(phase => !Number.isFinite(run.timings?.[phase]) || run.timings[phase] < 0));
  const invalidNesting = runs.some(run => Number.isFinite(run.timings?.producer) && Number.isFinite(run.timings?.upgrade) && (run.timings.producer > run.timings.upgrade ||
    run.timings.wholeRun < run.timings.sourceInstall + run.timings.upgrade ||
    Math.abs(run.timings.wholeRun - run.timings.sourceInstall - run.timings.upgrade - run.timings.resetAndReceipt) > 0.01));
  return {complete, cells, outcome: failed || invalidNesting ? 'FAIL' : !complete || missingTimings || cells.some(cell => cell.outcome === 'INCOMPLETE') ? 'INCOMPLETE' : cells.some(cell => cell.outcome === 'TARGET_MISSED') ? 'TARGET_MISSED' : 'PASS',
    producerIsUpgradeChild: true, elapsedAccounting: 'wholeRun includes sourceInstall + upgrade + resetAndReceipt; producer is already inside upgrade'};
}

function observeFinalBounds(receipt, now) {
  receipt.finishedAt = new Date().toISOString(); receipt.elapsedMs = now - receipt.monotonicStartedAt;
  const last = receipt.runs.at(-1);
  if (last?.status === 'passed') {
    last.spans.wholeRun.end = now; last.timings.wholeRun = now - last.spans.wholeRun.start;
    last.timings.resetAndReceipt = last.timings.wholeRun - last.timings.sourceInstall - last.timings.upgrade;
    if (Object.entries(archiveBudgets).some(([phase, budget]) => last.timings[phase] > budget.ceilingMs)) {
      last.status = 'failed'; receipt.status = 'failed'; receipt.failure = 'Final archive sample exceeded its whole-run or reset/receipt ceiling';
      receipt.summary = {...receipt.summary, outcome: 'FAIL', terminalFailure: receipt.failure};
    }
  }
  receipt.aggregateBudget = receipt.sample ? null : {targetMs: 7200000, ceilingMs: 12000000, elapsedMs: receipt.elapsedMs};
  if (!receipt.sample && receipt.elapsedMs > 12000000) {
    receipt.status = 'failed'; receipt.failure = 'I2 aggregate 200-minute ceiling exceeded'; receipt.summary = {...receipt.summary, outcome: 'FAIL', terminalFailure: receipt.failure};
  } else if (!receipt.sample && receipt.elapsedMs > 7200000 && receipt.status === 'passed-local-campaign') {
    receipt.status = 'target-missed'; receipt.summary = {...receipt.summary, outcome: 'TARGET_MISSED'};
  }
}

/** Called while holding the serialization lock. Publication itself belongs to
 * I2's reset/receipt allowance. A slow final write or a late cancellation must
 * be durably rewritten as failed before another sample can consume it. */
export async function publishArchiveReceipt({receipt, save, now = () => performance.now(), abortSignal}) {
  const markInterrupted = () => {
    receipt.interrupted = true; receipt.status = 'failed'; receipt.failure = 'Campaign interrupted';
    receipt.summary = {...receipt.summary, outcome: 'FAIL', terminalFailure: receipt.failure};
  };
  let state;
  do {
    if (abortSignal?.aborted) markInterrupted();
    observeFinalBounds(receipt, now());
    state = `${receipt.status}:${receipt.interrupted ?? false}`;
    await save();
    if (abortSignal?.aborted) markInterrupted();
    observeFinalBounds(receipt, now());
  } while (state !== `${receipt.status}:${receipt.interrupted ?? false}`);
  return receipt;
}

async function checkedBytes(directory, path, expected) {
  safePath(path); const absolute = join(directory, path);
  const before = await lstat(absolute);
  if (await realpath(absolute) !== absolute || !before.isFile()) fail(`Linked or nonregular input: ${path}`);
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
    expected.mode !== undefined && (after.mode & 0o777) !== expected.mode || sha256(bytes) !== expected.sha256 || expected.bytes !== undefined && bytes.length !== expected.bytes) fail(`Input seal mismatch: ${path}`);
  return bytes;
}
async function requireBrowser(recipe) {
  if (await realpath(recipe.browser.executable) !== recipe.browser.executable) fail('Browser executable links are not accepted');
  const actual = await hashFile(recipe.browser.executable);
  if (actual.sha256 !== recipe.browser.sha256) fail('Browser executable identity changed');
  return actual;
}

const browserMetadataScript = String.raw`import {createRequire} from 'node:module'; import {readFile} from 'node:fs/promises'; import {resolve,dirname} from 'node:path';
const require=createRequire(resolve(process.argv[1],'package.json')); const api=require('@playwright/test'); const packagePath=require.resolve('playwright-core/package.json');
const pkg=JSON.parse(await readFile(packagePath)); const manifestPath=resolve(dirname(packagePath),'browsers.json'); const manifest=JSON.parse(await readFile(manifestPath));
console.log(JSON.stringify({playwrightVersion:pkg.version,manifestPath,chromium:manifest.browsers.find(item=>item.name==='chromium'),executable:api.chromium.executablePath()}));`;

export function validatePreparedBrowser(metadata, versionOutput, requestedExecutable) {
  if (metadata?.playwrightVersion !== '1.63.0' || metadata.chromium?.revision !== '1243' || metadata.chromium?.browserVersion !== '153.0.8010.12' ||
    !isAbsolute(metadata.executable) || requestedExecutable && metadata.executable !== requestedExecutable ||
    !/^(?:Chromium|Google Chrome(?: for Testing)?) 153\.0\.8010\.12(?:\s|$)/.test(versionOutput.trim())) fail('Installed Chromium metadata, executable or actual version differs from the pinned browser');
  return true;
}

/** Produce the exact recipe from already installed, immutable inputs. This is
 * retained prerequisite work: no install, producer build or browser download. */
export async function prepareArchiveRecipe({sourceRoot = root, frozenDirectory, browserCacheDirectory, browserExecutable, output, abortSignal, timingLease} = {}) {
  if (typeof output !== 'string' || !output || typeof browserCacheDirectory !== 'string' || !browserCacheDirectory) fail('Recipe preparation requires --browser-cache and an exclusive --output file');
  sourceRoot = await realpath(sourceRoot);
  const run = await createRun(sourceRoot, undefined, {timingLease}), start = performance.now();
  const receipt = {schema: 1, kind: 'archive-recipe-preparation-1', status: 'running', startedAt: new Date().toISOString(), commands: [], directory: run.directory, workspace: run.workspace, qualification: false};
  const save = () => run.save(receipt);
  try {
    if (abortSignal?.aborted) fail('Recipe preparation interrupted');
    const pinned = await toolchain(sourceRoot); receipt.toolchain = pinned;
    const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json')));
    if (pkg.devDependencies?.['@playwright/test'] !== '1.63.0') fail('The consumer must select Playwright 1.63.0');
    if (!frozenDirectory) {
      const locations = packageNames.map(name => pkg.dependencies?.[name]);
      if (locations.some(path => typeof path !== 'string' || !path.startsWith('file:vendor/en-reve/'))) fail('Cannot infer one frozen archive identity from consumer dependencies');
      const directories = [...new Set(locations.map(path => dirname(resolve(sourceRoot, safePath(path.slice(5))))))];
      if (directories.length !== 1) fail('All four consumer archives must select the same frozen directory');
      frozenDirectory = directories[0];
    }
    const frozen = await realpath(frozenDirectory), cache = await realpath(browserCacheDirectory);
    const manifestBytes = await readFile(join(frozen, 'source-manifest.json')), packagesBytes = await readFile(join(frozen, 'packages.json'));
    const manifest = JSON.parse(manifestBytes), packages = JSON.parse(packagesBytes);
    validateFrozenManifests(manifest, packages);
    const inputs = [{path: 'source-manifest.json', sha256: sha256(manifestBytes), bytes: manifestBytes.length}, {path: 'packages.json', sha256: sha256(packagesBytes), bytes: packagesBytes.length},
      manifest.sourceArchive, ...Object.entries(manifest.provenance).map(([path, value]) => ({path, ...value})),
      {...manifest.files.find(file => file.path === 'LICENSE')}, ...packages.packages.map(pkg => ({path: pkg.filename, bytes: pkg.bytes, sha256: pkg.sha256}))];
    for (const input of inputs) await checkedBytes(frozen, input.path, input);
    const env = await cleanEnvironment({workspace: join(run.workspace, 'environment'), npmCache: join(run.workspace, 'unused-npm-cache'), browserCache: cache, extra: {PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'}});
    const command = async (id, command) => {
      const result = await execute({id, command, cwd: sourceRoot, env, directory: join(run.directory, 'logs'), timeoutMs: 30000, abortSignal});
      receipt.commands.push(result); await save(); assertSuccess(result); return result;
    };
    const metadataCommand = await command('browser-metadata', [pinned.executable, '--input-type=module', '-e', browserMetadataScript, sourceRoot]);
    const metadata = JSON.parse(await readFile(metadataCommand.stdout.path, 'utf8'));
    const executable = browserExecutable ? await realpath(browserExecutable) : metadata.executable;
    if (typeof executable !== 'string' || !isAbsolute(executable) || !executable.startsWith(cache + sep) || await realpath(executable) !== executable || executable !== metadata.executable) fail('The supplied browser must be the pinned Playwright executable inside the selected cache');
    const before = await hashFile(executable);
    const versionCommand = await command('browser-version', [executable, '--version']);
    const versionOutput = await readFile(versionCommand.stdout.path, 'utf8');
    validatePreparedBrowser(metadata, versionOutput, executable);
    if (!same(await hashFile(executable), before)) fail('Browser executable changed during prerequisite verification');
    receipt.browser = {...metadata, identity: before, actualVersionOutput: versionOutput, revisionManifest: {path: metadata.manifestPath, ...await hashFile(metadata.manifestPath)}};
    const recipe = validateArchiveRecipe({schema: 1, kind: 'archive-upgrade-recipe-1', frozenDirectory: frozen,
      sourceManifest: {path: 'source-manifest.json', sha256: sha256(manifestBytes)}, packagesManifest: {path: 'packages.json', sha256: sha256(packagesBytes)}, producerCommands,
      consumer: {config: 'tests/consumer/playwright.config.ts', configSha256: (await hashFile(join(sourceRoot, 'tests/consumer/playwright.config.ts'))).sha256,
        test: 'tests/consumer/registration.spec.ts', testSha256: (await hashFile(join(sourceRoot, 'tests/consumer/registration.spec.ts'))).sha256, expectedTests: 2},
      browser: {cacheDirectory: cache, executable, sha256: before.sha256, playwrightVersion: metadata.playwrightVersion, revision: metadata.chromium.revision, version: metadata.chromium.browserVersion}});
    for (const input of inputs) await checkedBytes(frozen, input.path, input);
    if (abortSignal?.aborted) fail('Recipe preparation interrupted');
    const requestedOutput = resolve(output); await mkdir(dirname(requestedOutput), {recursive: true});
    const destination = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
    const bytes = json(recipe); await writeFile(destination, bytes, {flag: 'wx', mode: 0o600});
    receipt.recipe = {path: destination, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes), value: recipe};
    receipt.sourceIdentity = manifest.sourceIdentity; receipt.inputs = inputs; receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.failure = String(error); }
  finally {
    receipt.finishedAt = new Date().toISOString(); receipt.elapsedMs = performance.now() - start;
    try {
      let interrupted;
      do {
        interrupted = abortSignal?.aborted ?? false;
        if (interrupted) { receipt.status = 'failed'; receipt.failure = 'Recipe preparation interrupted'; }
        await save();
      } while (interrupted !== (abortSignal?.aborted ?? false));
    } finally { await run.close(); }
  }
  return receipt;
}

export function validateArchiveSample(sample) {
  if (!sample || !['cold', 'warm'].includes(sample.cache) || !Number.isInteger(sample.ordinal) || sample.ordinal < 1 || sample.ordinal > 5 || typeof sample.cacheStateDirectory !== 'string' || !isAbsolute(sample.cacheStateDirectory)) fail('One I2 sample requires cache cold|warm, ordinal 1..5, and an absolute owned cacheStateDirectory');
  return {cache: sample.cache, ordinal: sample.ordinal, id: `${sample.cache}-${sample.ordinal}`, cacheStateDirectory: sample.cacheStateDirectory};
}
async function sampleStateDirectory(sample, sourceRoot) {
  const directory = resolve(sample.cacheStateDirectory);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const info = await lstat(directory);
  if (await realpath(directory) !== directory || !info.isDirectory() || directory === sourceRoot || directory.startsWith(sourceRoot + sep) || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) fail('I2 cache state must be an owned private canonical directory outside the checkout');
  return directory;
}
async function readSampleCache(directory, cacheKey) {
  const path = 'archive-cache.json', seal = (await readFile(join(directory, 'archive-cache.sha256'), 'utf8')).trim();
  if (!hashPattern.test(seal)) fail('I2 cache state has no valid seal');
  const state = JSON.parse(await checkedBytes(directory, path, {sha256: seal}));
  if (state.kind !== 'archive-upgrade-cache-1' || state.cacheKey !== cacheKey || state.sourceSample !== 'cold-5' || !isAbsolute(state.workspace) || await realpath(state.workspace) !== state.workspace) fail('I2 warm cache identity differs from the successful cold-5 sample');
  await readSuccessfulSample(state.receiptDirectory, cacheKey, state.sample);
  for (const key of ['sourceCache', 'consumerCache']) {
    if (!isAbsolute(state[key]) || !state[key].startsWith(state.workspace + sep) || await realpath(state[key]) !== state[key]) fail('I2 cached path escaped its retained producer workspace');
    if (!same(await fileManifest(state[key]), state[key + 'Manifest'])) fail('I2 warm registry cache contents changed outside the campaign');
  }
  return state;
}
async function readSuccessfulSample(directory, cacheKey, id) {
  if (!isAbsolute(directory) || await realpath(directory) !== directory) fail('I2 prerequisite receipt directory is not canonical');
  const seal = (await readFile(join(directory, 'receipt.sha256'), 'utf8')).trim();
  if (!hashPattern.test(seal)) fail('I2 prerequisite receipt is not sealed');
  const receipt = JSON.parse(await checkedBytes(directory, 'receipt.json', {sha256: seal}));
  validateArchiveSampleReceipt(receipt, cacheKey, id);
  for (const command of receipt.commands) for (const stream of ['stdout', 'stderr']) {
    const log = command[stream];
    if (!log || !isAbsolute(log.path) || !log.path.startsWith(join(directory, 'logs') + sep)) fail('I2 prerequisite log escaped its receipt directory');
    const actual = await hashFile(log.path);
    if (actual.sha256 !== log.sha256 || actual.bytes !== log.bytes) fail('I2 prerequisite command evidence changed');
  }
  for (const archive of receipt.run.producedArchives) await checkedBytes(join(receipt.workspace, id, 'packs'), archive.filename, archive);
  return receipt;
}
export function validateArchiveSampleReceipt(receipt, cacheKey, id) {
  if (receipt.kind !== 'archive-upgrade-sample-1' || receipt.status !== 'passed-local-sample' || receipt.summary?.outcome !== 'PASS' || receipt.summary.completeCampaign !== false || receipt.summary.firstArchiveQualified !== false || receipt.cacheKey !== cacheKey || receipt.run?.id !== id || receipt.run.status !== 'passed') fail('I2 prerequisite sample did not finish successfully');
  const timings = receipt.run.timings;
  if (!timings || Object.entries(archiveBudgets).some(([phase, budget]) => !Number.isFinite(timings[phase]) || timings[phase] < 0 || timings[phase] > budget.ceilingMs) ||
    timings.producer > timings.upgrade || Math.abs(timings.wholeRun - timings.sourceInstall - timings.upgrade - timings.resetAndReceipt) > 0.01) fail('I2 prerequisite timing or nesting evidence is invalid');
  if (!same(receipt.run.browserCounts, {tests: 2, passed: 2, failed: 0, skipped: 0, retries: 0}) || !Array.isArray(receipt.run.producedArchives) || !same(receipt.run.producedArchives.map(pkg => pkg.name).sort(), [...packageNames].sort()) ||
    receipt.run.producedArchives.some(pkg => !hashPattern.test(pkg.sha256) || !Number.isSafeInteger(pkg.bytes) || pkg.bytes <= 0 || safePath(pkg.filename).includes('/'))) fail('I2 prerequisite archive or browser evidence is incomplete');
  if (!receipt.adoptedConsumerLock || !hashPattern.test(receipt.adoptedConsumerLock.sha256) || !Number.isSafeInteger(receipt.adoptedConsumerLock.bytes) || receipt.adoptedConsumerLock.bytes <= 0) fail('I2 prerequisite adopted lock seal is missing');
  const expectedCommands = 2 + producerCommands.length + archivePlan().consumerCommands.length + 1;
  if (!Array.isArray(receipt.commands) || receipt.commands.length !== expectedCommands || !same(receipt.run.commands, receipt.commands.map(command => command.id)) ||
    receipt.commands.some(command => command.outcome !== 'PASS' || command.exitCode !== 0 || command.signal || command.error || command.timedOut || command.interrupted)) fail('I2 prerequisite command inventory did not pass');
  return true;
}
async function readColdPredecessor(directory, cacheKey, ordinal) {
  const name = `archive-cold-${ordinal - 1}`, seal = (await readFile(join(directory, name + '.sha256'), 'utf8')).trim();
  if (!hashPattern.test(seal)) fail('I2 cold predecessor seal is missing');
  const value = JSON.parse(await checkedBytes(directory, name + '.json', {sha256: seal}));
  return readSuccessfulSample(value.receiptDirectory, cacheKey, `cold-${ordinal - 1}`);
}
async function writeSampleCache(directory, state, first) {
  const bytes = json(state);
  // The parent runner is serial and the common host lock is held. Both files
  // must agree after a restart; a torn update fails closed and is never reused.
  await writeFile(join(directory, 'archive-cache.json'), bytes, {flag: first ? 'wx' : 'w', mode: 0o600});
  await writeFile(join(directory, 'archive-cache.sha256'), sha256(bytes) + '\n', {flag: first ? 'wx' : 'w', mode: 0o600});
}

/** One runtime-inventory start. The caller owns the required five cold + five
 * warm schedule; this return can never claim a complete archive campaign. */
export async function runArchiveSample(options) {
  const sample = validateArchiveSample(options);
  return runArchiveCampaign({...options, sample});
}

export async function runArchiveCampaign({sourceRoot = root, output, recipePath, install = false, registry = 'https://registry.npmjs.org/', abortSignal, sample: sampleOption, timingLease} = {}) {
  const sample = sampleOption ? validateArchiveSample(sampleOption) : null;
  if (!install || !recipePath) fail('Archive execution requires --install and --recipe; it installs only in owned snapshots');
  sourceRoot = await realpath(sourceRoot);
  const run = await createRun(sourceRoot, output, {timingLease});
  const invocationStart = performance.now();
  let recipeBytes, recipe, selectedToolchain, frozen, manifest, packages, packagesBytes;
  const receipt = {schema: 1, kind: sample ? 'archive-upgrade-sample-1' : 'archive-upgrade-campaign-1', status: 'running', budget: 'I2', row: 'D09', startedAt: new Date().toISOString(), monotonicStartedAt: invocationStart,
    recipe: {path: resolve(recipePath)}, plan: archivePlan(), host: observedEnvironment(), sample,
    registry, workspace: run.workspace, directory: run.directory, runs: [], commands: [], qualification: false};
  const markInterrupted = () => {
    receipt.interrupted = true; receipt.status = 'failed'; receipt.failure = 'Campaign interrupted';
    receipt.summary = {...summarizeArchiveCampaign(receipt.runs), outcome: 'FAIL', terminalFailure: receipt.failure};
  };
  abortSignal?.addEventListener('abort', markInterrupted);
  let sequence = 0;
  const save = () => run.save(receipt);
  const command = async (id, cwd, env, command, timeoutMs = 300000) => {
    const result = await execute({id: `${String(++sequence).padStart(4, '0')}-${id}`, command, cwd, env, directory: join(run.directory, 'logs'), timeoutMs, abortSignal});
    receipt.commands.push(result); await save(); assertSuccess(result); return result;
  };
  const npm = (id, cwd, env, args, timeoutMs) => command(id, cwd, env, [selectedToolchain.executable, selectedToolchain.npmCli, ...args], timeoutMs);
  try {
    if (abortSignal?.aborted) fail('Campaign interrupted before source preparation');
    recipeBytes = await readFile(resolve(recipePath));
    if (recipeBytes.length > 1024 * 1024) fail('Recipe is too large');
    recipe = validateArchiveRecipe(JSON.parse(recipeBytes));
    receipt.recipe = {path: resolve(recipePath), sha256: sha256(recipeBytes), value: recipe};
    selectedToolchain = await toolchain(sourceRoot); receipt.toolchain = selectedToolchain;
    frozen = await realpath(recipe.frozenDirectory);
    const sourceManifestBytes = await checkedBytes(frozen, recipe.sourceManifest.path, recipe.sourceManifest);
    packagesBytes = await checkedBytes(frozen, recipe.packagesManifest.path, recipe.packagesManifest);
    manifest = JSON.parse(sourceManifestBytes); packages = JSON.parse(packagesBytes);
    validateFrozenManifests(manifest, packages);
    receipt.producerSource = {identity: manifest.sourceIdentity, head: manifest.head ?? null, archive: manifest.sourceArchive, manifest: recipe.sourceManifest};
    receipt.browser = {...recipe.browser, ...await requireBrowser(recipe)};
    const paths = await sourcePaths(sourceRoot);
    receipt.consumerRevision = revision(sourceRoot);
    const base = join(run.workspace, 'consumer-base'), frozenCopy = join(run.workspace, 'frozen-input');
    await mkdir(base); await mkdir(frozenCopy);
    receipt.consumerSource = await snapshotSource(sourceRoot, base, paths);
    receipt.consumerRevision.workingTreeSHA256 = receipt.consumerSource.sha256;
    if (!same(paths, await sourcePaths(sourceRoot))) fail('Consumer source inventory changed during capture');
    for (const [key, hashKey] of [['config', 'configSha256'], ['test', 'testSha256']]) await checkedBytes(base, recipe.consumer[key], {sha256: recipe.consumer[hashKey]});
    const inputPaths = ['source-manifest.json', 'packages.json', manifest.sourceArchive.path, ...Object.keys(manifest.provenance), 'LICENSE'];
    receipt.frozenInput = await snapshotSource(frozen, frozenCopy, inputPaths);
    await checkedBytes(frozenCopy, recipe.sourceManifest.path, recipe.sourceManifest);
    await checkedBytes(frozenCopy, recipe.packagesManifest.path, recipe.packagesManifest);
    await checkedBytes(frozenCopy, manifest.sourceArchive.path, manifest.sourceArchive);
    for (const [path, seal] of Object.entries(manifest.provenance)) await checkedBytes(frozenCopy, path, seal);
    await checkedBytes(frozenCopy, 'LICENSE', manifest.files.find(file => file.path === 'LICENSE'));
    const selectedPackage = JSON.parse(await readFile(join(base, 'package.json')));
    if (selectedPackage.devDependencies['@playwright/test'] !== recipe.browser.playwrightVersion) fail('Consumer Playwright pin differs from browser recipe');
    receipt.cacheKey = sha256(json({consumer: receipt.consumerSource.sha256, producer: manifest.sourceIdentity, archives: packages.packages, browser: recipe.browser, toolchain: selectedToolchain, host: receipt.host, commands: receipt.plan.producerCommands, registry}));
    await save();
    const stateDirectory = sample ? await sampleStateDirectory(sample, sourceRoot) : null;
    let warmSourceCache, warmConsumerCache, retainedCache, pendingCacheState;
    if (sample?.cache === 'cold' && sample.ordinal > 1) receipt.adoptedConsumerLock = (await readColdPredecessor(stateDirectory, receipt.cacheKey, sample.ordinal)).adoptedConsumerLock;
    if (sample?.cache === 'warm') {
      retainedCache = await readSampleCache(stateDirectory, receipt.cacheKey);
      if (retainedCache.nextWarmOrdinal !== sample.ordinal) fail('I2 warm samples must continue the sealed ordinal without replacing a prior observation');
      warmSourceCache = retainedCache.sourceCache; warmConsumerCache = retainedCache.consumerCache;
      receipt.adoptedConsumerLock = retainedCache.adoptedConsumerLock;
    }
    if (sample) {
      // Reserve the observation, including an eventual failure. Reusing its
      // ordinal would silently replace evidence; a retry needs a new cohort.
      await writeFile(join(stateDirectory, `archive-${sample.id}.attempt.json`), json({kind: 'archive-sample-attempt-1', id: sample.id,
        cacheKey: receipt.cacheKey, receiptDirectory: run.directory, startedAt: receipt.startedAt}), {flag: 'wx', mode: 0o600});
    }
    const schedule = sample ? [sample] : receipt.plan.runs;
    for (const planned of schedule) {
      const wholeStart = receipt.runs.length ? performance.now() : invocationStart, item = {...planned, status: 'running', startedAt: new Date().toISOString(), timings: {}, spans: {wholeRun: {start: wholeStart}}, commands: []};
      receipt.runs.push(item); const firstCommand = receipt.commands.length;
      const workspace = join(run.workspace, planned.id), source = join(workspace, 'producer'), consumer = join(workspace, 'consumer'), packs = join(workspace, 'packs');
      try {
        if (abortSignal?.aborted) fail('Campaign interrupted before the next run');
        await mkdir(workspace); await mkdir(source); await mkdir(consumer); await mkdir(packs);
        const sourceCache = planned.cache === 'cold' ? join(workspace, 'source-cache') : warmSourceCache;
        const consumerCache = planned.cache === 'cold' ? join(workspace, 'consumer-cache') : warmConsumerCache;
        if (planned.cache === 'cold') { await mkdir(sourceCache); await mkdir(consumerCache); }
        if (planned.id === 'cold-5') { warmSourceCache = sourceCache; warmConsumerCache = consumerCache; }
        item.cache = planned.cache; item.cacheState = {sourceCache, consumerCache, key: receipt.cacheKey,
          sourceBefore: await fileManifest(sourceCache), consumerBefore: await fileManifest(consumerCache), buildCaches: 'fresh and empty', metadataCache: 'off'};
        if (planned.cache === 'cold' && (item.cacheState.sourceBefore.length || item.cacheState.consumerBefore.length)) fail('Cold registry cache was not empty');
        const sourceEnv = await cleanEnvironment({workspace: join(workspace, 'producer-env'), npmCache: sourceCache, browserCache: recipe.browser.cacheDirectory, registry, extra: {EN_SETUP_CACHE: 'off'}});
        const consumerEnv = await cleanEnvironment({workspace: join(workspace, 'consumer-env'), npmCache: consumerCache, browserCache: recipe.browser.cacheDirectory, registry,
          extra: {IE_CONSUMER_OUTPUT: join(run.directory, planned.id, 'browser'), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'}});
        await command(`${planned.id}-extract`, workspace, sourceEnv, ['python3', '-c', extractFrozenPython, join(frozenCopy, 'source-manifest.json'), join(frozenCopy, manifest.sourceArchive.path), source]);
        await snapshotSource(base, consumer, paths);
        await requireBrowser(recipe);
        let start = performance.now();
        await npm(`${planned.id}-source-ci`, source, sourceEnv, receipt.plan.sourceInstall, archiveBudgets.sourceInstall.ceilingMs);
        item.spans.sourceInstall = {start, end: performance.now()};
        item.timings.sourceInstall = item.spans.sourceInstall.end - start;
        await checkedBytes(source, 'package-lock.json', manifest.files.find(file => file.path === 'package-lock.json'));
        if (item.timings.sourceInstall > archiveBudgets.sourceInstall.ceilingMs) fail('Source install ceiling exceeded');
        const upgradeStart = performance.now(), producerStart = performance.now(), producerFirst = receipt.commands.length;
        const produced = [];
        for (const args of producerCommands.filter(args => args[0] !== 'pack')) await npm(`${planned.id}-producer-${receipt.commands.length}`, source, sourceEnv, args, Math.max(1, Math.floor(archiveBudgets.producer.ceilingMs - (performance.now() - producerStart))));
        for (const name of names) {
          const licenseTarget = join(source, 'packages', name, 'LICENSE');
          try { await copyFile(join(source, 'LICENSE'), licenseTarget, 1); }
          catch (error) { if (error.code !== 'EEXIST') throw error; if (!same(await readFile(licenseTarget), await readFile(join(source, 'LICENSE')))) fail('Existing package license differs from frozen root license'); }
          const args = ['pack', '--json', '--pack-destination', packs, '-w', `@en-reve/${name}`];
          const packedCommand = await npm(`${planned.id}-pack-${name}`, source, sourceEnv, args, Math.max(1, Math.floor(archiveBudgets.producer.ceilingMs - (performance.now() - producerStart))));
          const result = JSON.parse(await readFile(packedCommand.stdout.path, 'utf8'))[`@en-reve/${name}`];
          const expected = packages.packages.find(pkg => pkg.name === `@en-reve/${name}`);
          produced.push(verifyPackedResult(result, expected, await readFile(join(packs, expected.filename)), JSON.parse(await readFile(join(source, 'packages', name, 'package.json')))));
        }
        item.timings.producer = performance.now() - producerStart;
        item.spans.producer = {start: producerStart, end: producerStart + item.timings.producer};
        if (item.timings.producer > archiveBudgets.producer.ceilingMs) fail('Producer ceiling exceeded');
        const producerReceipt = {schema: 1, status: 'passed', sourceIdentity: manifest.sourceIdentity, sourceArchive: manifest.sourceArchive,
          toolchain: JSON.parse(await readFile(join(base, 'tooling/toolchain.json'))), producerElapsedMs: item.timings.producer,
          commands: receipt.commands.slice(producerFirst).map(command => ({...command, exit: command.exitCode})), packages: produced,
          limits: ['Producer child within one I2 campaign run; the campaign receipt owns statistical claims.']};
        const destination = join(consumer, 'vendor', 'en-reve', manifest.sourceIdentity);
        const existed = await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (!existed) {
          await mkdir(destination, {recursive: true});
          for (const path of inputPaths.filter(path => path !== 'packages.json')) await copyFile(join(frozenCopy, path), join(destination, path), 1);
          await writeFile(join(destination, 'packages.json'), packagesBytes, {flag: 'wx'});
          await writeFile(join(destination, 'producer-receipt.json'), json(producerReceipt), {flag: 'wx'});
          for (const pkg of produced) await copyFile(join(packs, pkg.filename), join(destination, pkg.filename), 1);
        } else {
          // Requalification of an unchanged identity uses existing bytes only
          // after the newly produced archive has independently matched them.
          if (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination) fail('Existing archive identity is not an owned regular directory');
          for (const path of inputPaths) await checkedBytes(destination, path, {sha256: sha256(await readFile(join(frozenCopy, path)))});
          for (const pkg of produced) await checkedBytes(destination, pkg.filename, pkg);
        }
        await writeFile(join(run.directory, `${planned.id}-producer.json`), json(producerReceipt), {flag: 'wx'});
        const pkgPath = join(consumer, 'package.json');
        await writeFile(pkgPath, json(adoptedConsumerPackage(JSON.parse(await readFile(pkgPath)), manifest.sourceIdentity, produced)));
        const browserConfig = sealedBrowserConfig(recipe.browser.executable, recipe.browser.sha256);
        await writeFile(join(consumer, ownedBrowserConfig), browserConfig, {flag: 'wx'});
        item.browserConfig = {path: ownedBrowserConfig, sha256: sha256(browserConfig)};
        item.consumerLockBefore = await hashFile(join(consumer, 'package-lock.json'));
        const remaining = () => Math.max(1, Math.floor(archiveBudgets.upgrade.ceilingMs - (performance.now() - upgradeStart)));
        for (const [index, args] of receipt.plan.consumerCommands.entries()) {
          if (index === receipt.plan.consumerCommands.length - 1) {
            const identity = await command(`${planned.id}-browser-identity`, consumer, consumerEnv, [selectedToolchain.executable, '--input-type=module', '-e', "import {chromium} from '@playwright/test'; console.log(JSON.stringify({executable:chromium.executablePath()}));"], remaining());
            if (JSON.parse(await readFile(identity.stdout.path, 'utf8')).executable !== recipe.browser.executable) fail('Installed Playwright resolves a different browser executable');
          }
          await npm(`${planned.id}-consumer-${index + 1}`, consumer, consumerEnv, args, remaining());
        }
        item.browserCounts = browserResultCounts(JSON.parse(await readFile(join(consumerEnv.IE_CONSUMER_OUTPUT, 'consumer-browser.json'))));
        await checkedBytes(consumer, ownedBrowserConfig, item.browserConfig);
        item.consumerLockAfter = await hashFile(join(consumer, 'package-lock.json'));
        if (receipt.adoptedConsumerLock && !same(item.consumerLockAfter, receipt.adoptedConsumerLock)) fail('Adopted consumer lock identity changed between campaign runs');
        receipt.adoptedConsumerLock ??= item.consumerLockAfter;
        item.timings.upgrade = performance.now() - upgradeStart;
        item.spans.upgrade = {start: upgradeStart, end: upgradeStart + item.timings.upgrade};
        await checkedBytes(source, 'package-lock.json', manifest.files.find(file => file.path === 'package-lock.json'));
        await requireBrowser(recipe);
        await verifyManifest(frozenCopy, receipt.frozenInput.files);
        item.cacheState.sourceAfter = await fileManifest(sourceCache); item.cacheState.consumerAfter = await fileManifest(consumerCache);
        item.producedArchives = produced.map(({files, ...pkg}) => pkg);
        item.status = 'passed';
      } catch (error) { item.status = 'failed'; item.failure = String(error); }
      item.commands = receipt.commands.slice(firstCommand).map(command => command.id); item.finishedAt = new Date().toISOString();
      await save();
      item.spans.wholeRun.end = performance.now();
      item.timings.wholeRun = item.spans.wholeRun.end - wholeStart;
      item.timings.resetAndReceipt = item.timings.wholeRun - (item.timings.sourceInstall ?? 0) - (item.timings.upgrade ?? 0);
      for (const [phase, budget] of Object.entries(archiveBudgets)) if (item.timings[phase] > budget.ceilingMs) { item.status = 'failed'; item.failure ??= `${phase} ceiling exceeded`; }
      await save();
      if (item.status !== 'passed') fail(`Archive campaign stopped at ${item.id}: ${item.failure}`);
      if (sample && (planned.id === 'cold-5' || planned.cache === 'warm')) {
        pendingCacheState = {kind: 'archive-upgrade-cache-1', cacheKey: receipt.cacheKey, sourceSample: 'cold-5',
          workspace: retainedCache?.workspace ?? run.workspace, sourceCache: item.cacheState.sourceCache, consumerCache: item.cacheState.consumerCache,
          sourceCacheManifest: item.cacheState.sourceAfter, consumerCacheManifest: item.cacheState.consumerAfter,
          adoptedConsumerLock: receipt.adoptedConsumerLock, nextWarmOrdinal: planned.cache === 'warm' ? planned.ordinal + 1 : 1,
          receiptDirectory: run.directory, sample: planned.id};
      }
    }
    await verifyManifest(base, receipt.consumerSource.files);
    await verifyManifest(frozenCopy, receipt.frozenInput.files);
    if (!same(paths, await sourcePaths(sourceRoot))) fail('Selected consumer inventory changed during campaign');
    if (revision(sourceRoot).head !== receipt.consumerRevision.head) fail('Selected consumer revision changed during campaign');
    for (const file of receipt.consumerSource.files) await checkedBytes(sourceRoot, file.path, file);
    for (const file of receipt.frozenInput.files) await checkedBytes(frozen, file.path, file);
    if (!same(recipeBytes, await readFile(resolve(recipePath)))) fail('Selected recipe changed during campaign');
    if (abortSignal?.aborted) fail('Campaign interrupted before success publication');
    const last = receipt.runs.at(-1);
    last.spans.wholeRun.end = performance.now(); last.timings.wholeRun = last.spans.wholeRun.end - last.spans.wholeRun.start;
    last.timings.resetAndReceipt = last.timings.wholeRun - last.timings.sourceInstall - last.timings.upgrade;
    for (const [phase, budget] of Object.entries(archiveBudgets)) if (last.timings[phase] > budget.ceilingMs) { last.status = 'failed'; fail(`Final ${phase} ceiling exceeded`); }
    receipt.run = sample ? last : undefined;
    receipt.summary = sample ? {outcome: 'PASS', sample: true, complete: false, completeCampaign: false, firstArchiveQualified: false, producerIsUpgradeChild: true} : summarizeArchiveCampaign(receipt.runs);
    receipt.status = sample ? 'passed-local-sample' : receipt.summary.outcome === 'PASS' ? 'passed-local-campaign' : receipt.summary.outcome === 'TARGET_MISSED' ? 'target-missed' : 'failed';
    if (sample?.cache === 'cold') {
      const marker = json({kind: 'archive-cold-sample-link-1', receiptDirectory: run.directory, cacheKey: receipt.cacheKey, id: sample.id});
      await writeFile(join(stateDirectory, `archive-${sample.id}.json`), marker, {flag: 'wx', mode: 0o600});
      await writeFile(join(stateDirectory, `archive-${sample.id}.sha256`), sha256(marker) + '\n', {flag: 'wx', mode: 0o600});
    }
    if (pendingCacheState) await writeSampleCache(stateDirectory, pendingCacheState, sample.id === 'cold-5');
  } catch (error) { receipt.status = 'failed'; receipt.failure = String(error); receipt.summary = {...summarizeArchiveCampaign(receipt.runs), outcome: 'FAIL', terminalFailure: receipt.failure}; }
  finally {
    receipt.run = sample ? receipt.runs[0] : undefined;
    try {
      // Accept cancellation until the durable publication boundary. A signal
      // during persistence changes the receipt and requires a failed rewrite
      // before the lock can be released to a dependent sample.
      await publishArchiveReceipt({receipt, save, abortSignal});
    } finally { abortSignal?.removeEventListener('abort', markInterrupted); await run.close(); }
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--run') options.run = true;
      else if (arg === '--prepare-recipe') options.prepare = true;
      else if (arg === '--install') options.install = true;
      else if (['--recipe', '--output', '--frozen', '--browser-cache', '--browser-executable'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) options[({'--recipe': 'recipePath', '--output': 'output', '--frozen': 'frozenDirectory', '--browser-cache': 'browserCacheDirectory', '--browser-executable': 'browserExecutable'})[arg]] = args[++index];
      else fail(`Unknown or incomplete option: ${arg}`);
    }
    if (options.run && options.prepare) fail('Choose recipe preparation or campaign execution');
    if (options.prepare) {
      const controller = new AbortController(), onInterrupt = () => controller.abort(new Error('Recipe preparation interrupted'));
      process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
      try {
        const receipt = await prepareArchiveRecipe({...options, abortSignal: controller.signal});
        process.stdout.write(json({status: receipt.status, recipe: receipt.recipe, directory: receipt.directory, failure: receipt.failure}));
        if (receipt.status !== 'passed' || controller.signal.aborted) process.exitCode = 1;
      } finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt); }
    } else if (!options.run) process.stdout.write(json(archivePlan()));
    else {
      const controller = new AbortController();
      const interrupt = signal => controller.abort(new Error(`Campaign interrupted: ${signal}`));
      const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
      process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
      try {
        const receipt = await runArchiveCampaign({...options, abortSignal: controller.signal});
        process.stdout.write(json({status: receipt.status, directory: receipt.directory, summary: receipt.summary}));
        if (receipt.status !== 'passed-local-campaign' || controller.signal.aborted) process.exitCode = 1;
      } finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); }
    }
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}

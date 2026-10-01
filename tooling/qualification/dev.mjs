#!/usr/bin/env node
// Real, bounded developer measurements. No network/install/workspace mutation in plan mode.
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {createReadStream, constants} from 'node:fs';
import {readFile, writeFile, mkdir, mkdtemp, realpath, lstat, open, readdir} from 'node:fs/promises';
import {resolve, join, dirname, relative, sep, isAbsolute} from 'node:path';
import {tmpdir, platform, arch, release, cpus, totalmem} from 'node:os';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
export const budgets = Object.freeze({
  coldBuild: {row: 'D03', targetMs: 30000, ceilingMs: 60000},
  fullTypes: {row: 'D04', targetMs: 10000, ceilingMs: 20000},
  incrementalBuild: {row: 'D04', targetMs: 2000, ceilingMs: 5000},
  incrementalTypes: {row: 'D04', targetMs: 1000, ceilingMs: 3000},
});
export const editScopes = Object.freeze([
  {id: 'public-leaf', path: 'src/theme/appearance.ts',
    before: "const key = 'ideogram.appearance';", after: "const key = 'ideogram.appearance.qualification-edit';"},
  {id: 'domain-type', path: 'src/protocol/store.ts',
    before: 'export type BlobRef = { hash: string; byteLength: string; mediaType: string };',
    after: 'export type BlobRef = { hash: string; byteLength: string; mediaType: string; readonly qualificationProbe?: never };'},
]);
export function budgetVerdict(elapsedMs, commandSucceeded, budget) {
  if (!commandSucceeded) return 'command-failed';
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid elapsed time');
  if (!budget) return 'observed';
  return elapsedMs <= budget.targetMs ? 'target' : elapsedMs <= budget.ceilingMs ? 'ceiling' : 'cap-exceeded';
}
export function applyEdit(text, scope) {
  if (!scope || text.split(scope.before).length !== 2) throw new Error(`Edit anchor must match exactly once: ${scope?.id}`);
  return text.replace(scope.before, scope.after);
}
export async function withTemporaryEdit(path, scope, action, afterRestore = async () => {}) {
  const original = await readFile(path), edited = Buffer.from(applyEdit(original.toString('utf8'), scope));
  const record = {scope: scope.id, path: scope.path, original: digest(original), edited: digest(edited), restored: false};
  try {
    await writeFile(path, edited);
    await action(record);
  } finally {
    await writeFile(path, original);
    record.restored = digest(await readFile(path)) === record.original;
    if (!record.restored) throw new Error(`Source restoration failed: ${scope.id}`);
    await afterRestore(record);
  }
  return record;
}
export function isBuildSource(path) {
  return /^(src|server|tests|tooling|vendor)\//.test(path) ||
    /^(package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|vite(?:\.[\w-]+)?\.config\.ts|index\.html|\.npmrc|\.progress-report\/project\.json)$/.test(path);
}
function safeRelative(path) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe source path: ${path}`);
  return path;
}
async function sourceBytes(directory, path) {
  safeRelative(path);
  const absolute = join(directory, path);
  if (await realpath(absolute) !== absolute) throw new Error(`Source links are not permitted: ${path}`);
  const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (!before.isFile()) throw new Error(`Source is not a regular file: ${path}`);
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) throw new Error(`Source changed during capture: ${path}`);
    return {bytes, mode: before.mode & 0o777};
  } finally { await fd.close(); }
}
async function manifest(directory, paths) {
  const result = [];
  for (const path of [...new Set(paths)].sort()) {
    const {bytes, mode} = await sourceBytes(directory, path);
    result.push({path, bytes: bytes.length, sha256: digest(bytes), mode});
  }
  return result;
}
export async function snapshotSource(sourceRoot, destination, paths) {
  sourceRoot = await realpath(sourceRoot);
  destination = await realpath(destination);
  if (sourceRoot === destination || destination.startsWith(sourceRoot + sep)) throw new Error('Snapshot must be outside the live source checkout');
  if ((await readdir(destination)).length) throw new Error('Snapshot destination must be empty');
  const before = await manifest(sourceRoot, paths);
  for (const record of before) {
    const {bytes, mode} = await sourceBytes(sourceRoot, record.path);
    if (digest(bytes) !== record.sha256) throw new Error(`Source changed during capture: ${record.path}`);
    await mkdir(dirname(join(destination, record.path)), {recursive: true});
    await writeFile(join(destination, record.path), bytes, {mode, flag: 'wx'});
  }
  const after = await manifest(sourceRoot, paths);
  if (json(before) !== json(after) || json(before) !== json(await manifest(destination, paths))) throw new Error('Source changed during snapshot');
  return {sha256: digest(json(before)), files: before};
}
function gitPaths(directory) {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: directory, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`Cannot inventory checkout: ${result.stderr}`);
  return [...new Set(result.stdout.split('\0').filter(p => p && isBuildSource(p)))].sort();
}
async function hashFile(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return {bytes, sha256: hash.digest('hex')};
}
async function outputManifest(directory, base = directory) {
  const result = [];
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await outputManifest(path, base));
    else if (entry.isFile()) result.push({path: relative(base, path).split(sep).join('/'), ...await hashFile(path)});
    else throw new Error(`Unexpected output link: ${path}`);
  }
  return result;
}

// stdout/stderr are streamed into retained files, never silently truncated by maxBuffer.
export async function runCommand({executable, args, cwd, env, logDirectory, id, timeoutMs = 300000}) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Unsafe command id');
  await mkdir(logDirectory, {recursive: true});
  const stdoutPath = join(logDirectory, id + '.stdout.log'), stderrPath = join(logDirectory, id + '.stderr.log');
  const stdout = await open(stdoutPath, 'wx'), stderr = await open(stderrPath, 'wx');
  const startedAt = new Date().toISOString(), start = performance.now();
  let result;
  try {
    result = await new Promise(done => {
      const child = spawn(executable, args, {cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', stdout.fd, stderr.fd]});
      let error = null, timedOut = false;
      // An owned detached process group lets a timeout stop npm's compiler children too.
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
        catch (value) { if (value.code !== 'ESRCH') error = value.message; }
      }, timeoutMs);
      child.once('error', value => { error = value.message; });
      child.once('close', (exitCode, signal) => { clearTimeout(timer); done({exitCode, signal, error, timedOut}); });
    });
  } finally { await stdout.close(); await stderr.close(); }
  return {id, executable, args, cwd, startedAt, elapsedMs: performance.now() - start, ...result,
    stdout: {path: stdoutPath, ...await hashFile(stdoutPath)}, stderr: {path: stderrPath, ...await hashFile(stderrPath)}};
}

export function developerPlan() {
  return {schema: 1, kind: 'developer-performance-plan-1', mode: 'plan', budgets, scopes: editScopes,
    commands: {install: ['npm ci', 'npm ls --all --json', 'npm run verify:vendor'],
      fullTypes: ['npm run typecheck'], coldBuild: ['npm run build:app', 'npm run build:server'],
      incrementalTypes: ['tsc --noEmit --incremental --tsBuildInfoFile <owned-cache> -p <each consumer/app/server config>'],
      incrementalBuild: ['npm run build:app', 'npm run build:server']},
    boundaries: ['Commands run in an independently installed source snapshot; live checkout and its dependencies are never modified or copied.',
      'Prime and restoration commands are measured as overhead, separately from changed-input commands. No incremental bundler cache is claimed.',
      'D03 and D04 are one actual observation per selected cell. A cap failure stops subsequent measured work; restoration still runs.',
      'No D01 qualification: installation is setup. No I1, D10 ratio, P/Q3, browser provisioning, physical C environment or release qualification claim.'],
    execute: 'node tooling/qualification/dev.mjs --run --install [--output <new-receipt-directory>]'};
}

export async function runDeveloperCampaign(options = {}) {
  const {acquireTimingLock, timingHostIdentity, timingLockDirectory} = await import('./campaigns/host.mjs');
  const timingLease = options.timingLease;
  const owner = await acquireTimingLock(await timingLockDirectory(), {host: timingHostIdentity(), receiptId: timingLease?.receiptId ?? randomUUID(), lease: timingLease ?? null});
  try { return await runBoundedDeveloperCampaign(options); }
  finally { await owner.release(); }
}

async function runBoundedDeveloperCampaign({sourceRoot = root, output} = {}) {
  sourceRoot = await realpath(sourceRoot);
  const config = JSON.parse(await readFile(join(sourceRoot, 'tooling/toolchain.json'), 'utf8'));
  if (process.versions.node !== config.node) throw new Error(`Use pinned Node ${config.node}`);
  const npmCli = join(sourceRoot, '.toolchain', `npm-${config.npm}`, 'package/bin/npm-cli.js');
  const npmVersion = spawnSync(process.execPath, [npmCli, '--version'], {encoding: 'utf8'});
  if (npmVersion.status !== 0 || npmVersion.stdout.trim() !== config.npm) throw new Error(`Use pinned npm ${config.npm}`);
  const outputParent = join(sourceRoot, 'artifacts');
  await mkdir(outputParent, {recursive: true});
  const receiptDirectory = output ? resolve(output) : await mkdtemp(join(outputParent, 'developer-performance-'));
  if (output) await mkdir(receiptDirectory, {recursive: false});
  const workspace = await mkdtemp(join(await realpath(tmpdir()), 'ideogram-developer-'));
  const source = join(workspace, 'source'); await mkdir(source);
  const cache = join(workspace, 'cache'), home = join(workspace, 'home');
  await mkdir(cache); await mkdir(home); await writeFile(join(workspace, 'npmrc'), '');
  const env = {PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: await realpath(tmpdir()),
    CI: '1', LANG: 'en_US.UTF-8', npm_config_cache: join(cache, 'npm'), npm_config_userconfig: join(workspace, 'npmrc'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_engine_strict: 'true'};
  const receipt = {schema: 1, kind: 'developer-performance-receipt-1', status: 'running', startedAt: new Date().toISOString(),
    toolchain: {node: process.versions.node, npm: npmVersion.stdout.trim(), executable: process.execPath},
    environment: {platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(),
      profile: 'observed-local-host; PERF C hardware/concurrency not asserted',
      isolation: 'fresh source, own npm install/cache/home; no dependency/output copies, no provider environment inherited'},
    workspace, receiptDirectory, plan: developerPlan(), commands: [], phases: [], edits: [], limits: developerPlan().boundaries};
  const save = () => writeFile(join(receiptDirectory, 'receipt.json'), json(receipt));
  let sequence = 0;
  const command = async (id, executable, args) => {
    const value = await runCommand({id: `${String(++sequence).padStart(3, '0')}-${id}`, executable, args, cwd: source, env, logDirectory: join(receiptDirectory, 'logs')});
    receipt.commands.push(value); await save();
    if (value.exitCode !== 0 || value.signal || value.error || value.timedOut) throw new Error(`Command failed: ${id}; see retained raw logs`);
    return value;
  };
  const npm = (id, ...args) => command(id, process.execPath, [npmCli, ...args]);
  const phase = async (id, budget, action) => {
    const start = performance.now(), firstCommand = receipt.commands.length; let error;
    try { await action(); } catch (value) { error = value; }
    const elapsedMs = performance.now() - start;
    const result = {id, elapsedMs, budget: budget ?? null, commandIds: receipt.commands.slice(firstCommand).map(c => c.id), verdict: budgetVerdict(elapsedMs, !error, budget)};
    receipt.phases.push(result); await save();
    if (error) throw error;
    if (result.verdict === 'cap-exceeded') throw new Error(`Performance cap exceeded: ${id} (${elapsedMs.toFixed(1)} ms)`);
    return result;
  };
  const build = async () => { await npm('build-app', 'run', 'build:app'); await npm('build-server', 'run', 'build:server'); };
  const incrementalTypes = async () => {
    for (const [id, configPath] of [['consumer', 'tsconfig.json'], ['app', 'tsconfig.app.json'], ['server', 'tsconfig.server.json']])
      await command(`types-${id}`, process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', join(cache, id + '.tsbuildinfo'), '-p', configPath]);
  };
  try {
    const paths = gitPaths(sourceRoot);
    receipt.source = await snapshotSource(sourceRoot, source, paths);
    if (json(paths) !== json(gitPaths(sourceRoot))) throw new Error('Source file inventory changed during capture');
    receipt.counts = {sourceFiles: paths.length, typescriptModules: paths.filter(p => /\.tsx?$/.test(p)).length,
      testFiles: paths.filter(p => /^tests\//.test(p) && /\.(test\.mjs|spec\.ts)$/.test(p)).length, executedTestCases: 0};
    receipt.cacheIdentity = {source: receipt.source.sha256, lock: digest(await readFile(join(source, 'package-lock.json'))),
      node: config.node, npm: config.npm, os: platform(), arch: arch(),
      compiler: JSON.parse(await readFile(join(source, 'package.json'))).devDependencies.typescript,
      bundler: JSON.parse(await readFile(join(source, 'package.json'))).devDependencies.vite,
      declaredBrowserTool: JSON.parse(await readFile(join(source, 'package.json'))).devDependencies['@playwright/test'],
      browserExecution: 'none',
      commands: digest(json(receipt.plan.commands)), vendor: receipt.source.files.filter(f => f.path.startsWith('vendor/'))};
    await save();
    await phase('setup-verify-install', null, async () => {
      await command('verify-vendor-before', 'python3', ['tooling/verify-vendor.py']);
      await npm('install', 'ci', '--no-audit', '--no-fund');
      await npm('dependency-graph', 'ls', '--all', '--json');
      await npm('verify-vendor-after', 'run', 'verify:vendor');
      const lock = JSON.parse(await readFile(join(source, 'package-lock.json')));
      for (const [path, value] of Object.entries(lock.packages)) {
        if (!path) continue;
        safeRelative(path);
        const installedPath = join(source, path);
        const stat = await lstat(installedPath).catch(error => { if (error.code === 'ENOENT' && value.optional) return null; throw error; });
        if (!stat) continue;
        if (stat.isSymbolicLink() || !(await realpath(installedPath)).startsWith(join(source, 'node_modules') + sep)) throw new Error(`Linked dependency: ${path}`);
        if (JSON.parse(await readFile(join(installedPath, 'package.json'))).version !== value.version) throw new Error(`Installed version mismatch: ${path}`);
      }
      if (digest(await readFile(join(source, 'package-lock.json'))) !== receipt.cacheIdentity.lock) throw new Error('Installation changed the selected lockfile');
    });
    await phase('full-types', budgets.fullTypes, () => npm('full-types', 'run', 'typecheck'));
    // This snapshot starts without dist, build information or bundler caches.
    await phase('cold-production-build', budgets.coldBuild, build);
    receipt.coldArtifacts = await outputManifest(join(source, 'dist')); await save();
    for (const scope of editScopes) {
      // Each scope is independently primed after the previous original was rebuilt.
      await phase(scope.id + '-prime', null, async () => { await incrementalTypes(); await build(); });
      await withTemporaryEdit(join(source, scope.path), scope, async record => {
        receipt.edits.push(record); await save();
        await phase(scope.id + '-incremental-types', budgets.incrementalTypes, incrementalTypes);
        await phase(scope.id + '-incremental-build', budgets.incrementalBuild, build);
        record.artifacts = await outputManifest(join(source, 'dist'));
      }, async record => {
        await save();
        await phase(scope.id + '-restore', null, async () => { await incrementalTypes(); await build(); });
        record.restoredArtifacts = await outputManifest(join(source, 'dist')); await save();
        if (json(record.restoredArtifacts) !== json(receipt.coldArtifacts)) throw new Error(`Restored output mismatch: ${scope.id}`);
      });
    }
    if (json(await manifest(source, paths)) !== json(receipt.source.files)) throw new Error('Snapshot source was not fully restored');
    receipt.status = 'passed-bounded-observations';
  } catch (error) {
    receipt.status = 'failed'; receipt.failure = String(error);
  } finally { receipt.finishedAt = new Date().toISOString(); await save(); }
  return receipt;
}

async function main() {
  const args = process.argv.slice(2); let output; let run = false; let install = false;
  if (args.includes('--campaign')) {
    const {mainCampaign} = await import('./developer-campaigns/run.mjs');
    return mainCampaign(args);
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') run = true;
    else if (args[i] === '--install') install = true;
    else if (args[i] === '--plan') { /* Explicit read-only plan. */ }
    else if (args[i] === '--output' && args[i + 1]) output = args[++i];
    else throw new Error(`Unknown/incomplete argument: ${args[i]}`);
  }
  if (!run) { if (install || output) throw new Error('--install/--output require --run'); console.log(json(developerPlan())); return; }
  if (!install) throw new Error('--run requires --install to authorize npm ci in the new isolated workspace');
  const receipt = await runDeveloperCampaign({output});
  console.log(json({status: receipt.status, receipt: join(receipt.receiptDirectory, 'receipt.json'), workspace: receipt.workspace, failure: receipt.failure}));
  if (receipt.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(String(error)); process.exitCode = 1; });

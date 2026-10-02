import {createHash, randomUUID} from 'node:crypto';
import {writeSync, constants} from 'node:fs';
import {readFile, writeFile, mkdir, mkdtemp, realpath, lstat, readdir, open} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve, join, dirname, relative, sep, isAbsolute} from 'node:path';
import {tmpdir, hostname, platform, arch, release, cpus, totalmem} from 'node:os';
import {snapshotSource, isBuildSource} from '../dev.mjs';
import {boundedChild} from '../container/bounded-child.mjs';
import {acquireTimingLock, timingHostIdentity, timingLockDirectory} from '../campaigns/host.mjs';

export const json = value => JSON.stringify(value, null, 2) + '\n';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function safeRelative(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`Unsafe relative path: ${path}`);
  return path;
}
export async function hashFile(path) {
  if (!(await lstat(path)).isFile() || await realpath(path) !== resolve(path)) throw Error(`Expected a regular unlinked file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256'); let bytes = 0;
  try {
    const before = await handle.stat(); if (!before.isFile()) throw Error('Hash input changed type');
    for await (const chunk of handle.createReadStream({autoClose: false})) { hash.update(chunk); bytes += chunk.length; }
    const after = await handle.stat(), current = await lstat(path);
    if (!current.isFile() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs || before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(path) !== resolve(path)) throw Error(`File changed during hashing: ${path}`);
    return {bytes, sha256: hash.digest('hex')};
  } finally { await handle.close(); }
}
export async function fileManifest(root, {exclude = []} = {}) {
  root = await realpath(root); const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name), path = relative(root, absolute).split(sep).join('/');
      if (exclude.some(value => path === value || path.startsWith(value + '/'))) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push({path, ...await hashFile(absolute)});
      else throw Error(`Manifest cannot contain a link or special file: ${path}`);
    }
  }
  await walk(root); return files;
}
export async function verifyManifest(root, manifest) {
  if (!Array.isArray(manifest) || new Set(manifest.map(record => record.path)).size !== manifest.length) throw Error('Invalid or duplicate manifest');
  for (const record of manifest) {
    const actual = await hashFile(join(root, safeRelative(record.path)));
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) throw Error(`Manifest mismatch: ${record.path}`);
  }
  return true;
}
export function sourcePaths(root) {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: root, encoding: 'utf8'});
  if (result.status !== 0) throw Error(`Cannot capture source inventory: ${result.stderr}`);
  return [...new Set(result.stdout.split('\0').filter(path => path && (isBuildSource(path) || path.startsWith('docs/spec/') || path.startsWith('.github/workflows/') || path === 'AGENTS.md')))].sort();
}
export async function createWorkspace(sourceRoot, paths = sourcePaths(sourceRoot), parent) {
  const base = parent ? await realpath(parent) : await realpath(tmpdir());
  const workspace = await mkdtemp(join(base, 'ideogram-developer-campaign-'));
  const source = join(workspace, 'source'); await mkdir(source);
  const sourceManifest = await snapshotSource(sourceRoot, source, paths);
  if (json(paths) !== json(sourcePaths(sourceRoot))) throw Error('Source inventory changed during capture');
  return {workspace, source, sourceManifest};
}
export async function toolchain(root) {
  const config = JSON.parse(await readFile(join(root, 'tooling/toolchain.json')));
  if (process.versions.node !== config.node || config.node !== '26.10.0' || config.npm !== '12.1.0') throw Error('Pinned Node 26.10.0 and npm 12.1.0 are required');
  const npmCli = join(root, '.toolchain', `npm-${config.npm}`, 'package/bin/npm-cli.js');
  const result = spawnSync(process.execPath, [npmCli, '--version'], {encoding: 'utf8', env: {PATH: `${dirname(process.execPath)}:/usr/bin:/bin`}});
  if (result.status !== 0 || result.stdout.trim() !== config.npm) throw Error('Pinned npm CLI unavailable');
  return {node: config.node, npm: config.npm, npmCli, executable: process.execPath, executableIdentity: await hashFile(process.execPath)};
}
export async function cleanEnvironment({workspace, npmCache, browserCache, registry, browserDownloadHost, extra = {}, env = process.env}) {
  for (const key of Object.keys(extra)) if (!/^(?:QUALIFICATION_|IE_|TEXT_|SPECTRUM_|ADAPTER_|REQUEST_|QUEUE_|EDITOR_)/.test(key) && !(key === 'EN_SETUP_CACHE' && extra[key] === 'off') && !(key === 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD' && extra[key] === '1')) throw Error(`Disallowed campaign environment field: ${key}`);
  const home = join(workspace, 'home'); await mkdir(home, {recursive: true});
  const npmrc = join(workspace, 'npmrc'); await writeFile(npmrc, '', {flag: 'wx'});
  if (registry) {
    const url = new URL(registry);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw Error('Registry fixture URL cannot contain credentials');
  }
  if (browserDownloadHost) {
    const url = new URL(browserDownloadHost);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Browser download fixture must be a literal loopback HTTP origin');
  }
  return {PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: await realpath(tmpdir()),
    CI: '1', LANG: 'en_US.UTF-8', NO_COLOR: '1', npm_config_cache: npmCache, npm_config_userconfig: npmrc,
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_engine_strict: 'true', npm_config_nodedir: resolve(dirname(process.execPath), '..'),
    // The D11 reader validates this explicitly selected cache itself. Do not
    // substitute the install cache or infer the user's default npm cache.
    ...(env.IE_D11_NPM_CACHE !== undefined ? {IE_D11_NPM_CACHE: env.IE_D11_NPM_CACHE} : {}),
    ...(registry ? {npm_config_registry: registry} : {}), ...(browserDownloadHost ? {PLAYWRIGHT_DOWNLOAD_HOST: browserDownloadHost} : {}), PLAYWRIGHT_BROWSERS_PATH: browserCache, ...extra};
}
export async function execute({id, command, cwd, env, directory, timeoutMs = 300000, abortSignal}) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || !Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string')) throw Error('Invalid command specification');
  await mkdir(directory, {recursive: true});
  const paths = {stdout: join(directory, `${id}.stdout.log`), stderr: join(directory, `${id}.stderr.log`)};
  const stdout = await open(paths.stdout, 'wx'); let stderr;
  try { stderr = await open(paths.stderr, 'wx'); } catch (error) { await stdout.close(); throw error; }
  let logError;
  const append = handle => bytes => {
    try { for (let offset = 0; offset < bytes.length;) { const written = writeSync(handle.fd, bytes, offset, bytes.length - offset); if (!written) throw Error('Command log write made no progress'); offset += written; } }
    catch (error) { logError ??= String(error); }
  };
  const startedAt = new Date().toISOString(), start = performance.now(); let result;
  try { result = await boundedChild(command[0], command.slice(1), {cwd, env, timeoutMs, abortSignal, onStdout: append(stdout), onStderr: append(stderr)}); }
  catch (error) { result = {code: null, error: String(error), timedOut: false, interrupted: false}; }
  finally { await Promise.all([stdout.close(), stderr.close()]); }
  if (logError) result.error = `Could not retain complete command output: ${logError}`;
  const outcome = result.code === 0 && !result.timedOut && !result.interrupted && !result.signal && !result.error ? 'PASS' : 'FAIL';
  return {id, command, cwd, startedAt, endedAt: new Date().toISOString(), elapsedMs: performance.now() - start, ...result,
    exitCode: result.code, outcome, stdout: {path: paths.stdout, ...await hashFile(paths.stdout)}, stderr: {path: paths.stderr, ...await hashFile(paths.stderr)}};
}
export function assertSuccess(record) {
  if (record.outcome !== 'PASS') throw Object.assign(Error(`Command failed: ${record.id}`), {observation: record});
}
export function observedEnvironment() {
  return {hostname: hostname(), platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, memoryBytes: totalmem(), qualified: false,
    qualificationRequirement: 'PERF C: four pinned physical i7-12700 P-cores, 16 GiB, local NVMe, Ubuntu 24.04.3; dedicated host; controlled immutable N registry/browser fixture. Observation alone does not certify this profile.'};
}
export async function createRun(root, output, {timingLease} = {}) {
  // Runtime and standalone campaigns share the same host lock. A nested
  // runtime child must present its live ancestor's exact lease to borrow it.
  const temporary = await realpath(tmpdir());
  const owner = await acquireTimingLock(await timingLockDirectory(), {host: timingHostIdentity(), receiptId: timingLease?.receiptId ?? randomUUID(), lease: timingLease ?? null});
  try {
    const parent = join(root, 'artifacts'); await mkdir(parent, {recursive: true});
    const directory = output ? resolve(output) : await mkdtemp(join(parent, 'developer-campaign-'));
    if (output) await mkdir(directory, {recursive: false});
    const workspace = await mkdtemp(join(temporary, 'ideogram-developer-run-'));
    let closed = false;
    return {directory, workspace, timingLease: owner.lease, timingLock: {path: owner.path, identity: owner.identity, borrowed: owner.borrowed},
      async save(receipt) { await writeFile(join(directory, 'receipt.json'), json(receipt)); await writeFile(join(directory, 'receipt.sha256'), sha256(json(receipt)) + '\n'); },
      async close() { if (closed) return; await owner.release(); closed = true; }};
  } catch (error) { await owner.release(); throw error; }
}

import { readFile, writeFile, mkdir, mkdtemp, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, platform, arch, release } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [snapshotArg, sourceArg] = process.argv.slice(2);
const verifyRebuild = sourceArg === '--verify-rebuild';
const liveSource = verifyRebuild ? undefined : sourceArg;
if (!snapshotArg || !sourceArg) throw new Error('Usage: node tooling/produce-en-reve.mjs <frozen-directory> <read-only-source-path | --verify-rebuild>');
const snapshot = resolve(snapshotArg);
const manifest = JSON.parse(await readFile(join(snapshot, 'source-manifest.json')));
const config = JSON.parse(await readFile(join(root, 'tooling/toolchain.json')));
const toolBin = dirname(process.execPath);
const npmCli = join(root, '.toolchain', `npm-${config.npm}`, 'package/bin/npm-cli.js');
if (process.versions.node !== config.node) throw new Error(`Use pinned Node ${config.node}`);
await mkdir(join(root, 'artifacts'), { recursive: true });
const runDirectory = await mkdtemp(join(root, 'artifacts/producer-'));
const work = await mkdtemp(join(tmpdir(), 'ideogram-producer-'));
const env = { PATH: `${toolBin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(work, 'home'),
  TMPDIR: tmpdir(), CI: '1', EN_SETUP_CACHE: 'off', npm_config_cache: join(work, 'npm-cache'),
  npm_config_userconfig: join(work, 'empty.npmrc'), npm_config_engine_strict: 'true',
  npm_config_audit: 'false', npm_config_fund: 'false', LANG: 'en_US.UTF-8' };
await mkdir(env.HOME);
await writeFile(env.npm_config_userconfig, '');
const digest = (bytes, type = 'sha256', encoding = 'hex') => createHash(type).update(bytes).digest(encoding);
const receipt = { schema: 1, status: 'running', sourceIdentity: manifest.sourceIdentity,
  sourceArchive: manifest.sourceArchive, toolchain: config, platform: { platform: platform(), arch: arch(), release: release() },
  startedAt: new Date().toISOString(), commands: [], packages: [], environment: { isolatedHome: true, emptyNpmCache: true, upstreamOutputsUsed: false, metadataCache: 'off' },
  limits: ['One local correctness production run; not Q3 I2 five-cold/five-warm qualification.'], workDirectory: work };
const save = () => writeFile(join(runDirectory, 'producer-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
function run(executable, args, cwd = work) {
  const start = performance.now();
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entry = { executable: executable === process.execPath ? 'pinned-node' : executable,
    args: args.map(x => x === npmCli ? 'pinned-npm-cli' : x), cwd: cwd === work ? 'isolated-source' : cwd,
    startedAt: new Date(Date.now() - (performance.now() - start)).toISOString(), elapsedMs: performance.now() - start,
    exit: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
  receipt.commands.push(entry);
  console.log(`${executable === process.execPath ? 'node' : executable} ${entry.args.join(' ')}: ${entry.exit} (${(entry.elapsedMs / 1000).toFixed(2)}s)`);
  if (result.status !== 0) throw new Error(`${entry.args.join(' ')} failed\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const npm = (...args) => run(process.execPath, [npmCli, ...args]);
try {
  if (npm('--version').trim() !== config.npm) throw new Error('Wrong npm version');
  const bytes = await readFile(join(snapshot, manifest.sourceArchive.path));
  if (digest(bytes) !== manifest.sourceArchive.sha256) throw new Error('Frozen source archive mismatch');
  run('tar', ['-xzf', join(snapshot, manifest.sourceArchive.path), '-C', work]);
  for (const item of manifest.files) {
    const content = await readFile(join(work, item.path));
    if (content.length !== item.bytes || digest(content) !== item.sha256) throw new Error(`Source mismatch: ${item.path}`);
  }
  if (liveSource) run('python3', [join(root, 'tooling/freeze-en-reve.py'), liveSource, '--check', join(snapshot, 'source-manifest.json')]);
  npm('ci', '--no-audit', '--no-fund');
  receipt.producerStartedAt = new Date().toISOString();
  const producerStart = performance.now();
  for (const name of ['tokens', 'styles', 'primitives', 'elements']) npm('run', 'build', '-w', `@en-reve/${name}`);
  npm('run', 'metadata');
  for (const script of ['check:lazy', 'check:types', 'check:api', 'check:customization']) npm('run', script);
  const packs = join(work, 'packs');
  await mkdir(packs);
  for (const name of ['tokens', 'styles', 'primitives', 'elements']) {
    // npm does not reliably include the workspace root license in workspace archives.
    await cp(join(work, 'LICENSE'), join(work, 'packages', name, 'LICENSE'));
    const packResult = JSON.parse(npm('pack', '--json', '--pack-destination', packs, '-w', `@en-reve/${name}`));
    const packed = packResult[`@en-reve/${name}`];
    if (!packed?.filename || packed.name !== `@en-reve/${name}`) throw new Error('Unexpected npm 12 pack response');
    const archive = await readFile(join(packs, packed.filename));
    if (packed.integrity !== `sha512-${digest(archive, 'sha512', 'base64')}` || packed.shasum !== digest(archive, 'sha1')) throw new Error('npm pack digest mismatch');
    const pkg = JSON.parse(await readFile(join(work, 'packages', name, 'package.json')));
    receipt.packages.push({ name: pkg.name, version: pkg.version, filename: packed.filename, bytes: archive.length,
      unpackedSize: packed.unpackedSize, integrity: packed.integrity, shasum: packed.shasum, sha256: digest(archive),
      dependencies: pkg.dependencies ?? {}, peerDependencies: pkg.peerDependencies ?? {}, files: packed.files });
  }
  receipt.producerElapsedMs = performance.now() - producerStart;
  receipt.generatedChanges = [];
  for (const item of manifest.files) {
    const bytes = await readFile(join(work, item.path));
    if (digest(bytes) !== item.sha256) receipt.generatedChanges.push({ path: item.path, before: item.sha256, after: digest(bytes), bytes: bytes.length });
  }
  if (digest(await readFile(join(work, 'package-lock.json'))) !== manifest.files.find(x => x.path === 'package-lock.json').sha256) throw new Error('Producer lockfile changed');
  if (liveSource) run('python3', [join(root, 'tooling/freeze-en-reve.py'), liveSource, '--check', join(snapshot, 'source-manifest.json')]);
  const destination = join(root, 'vendor/en-reve', manifest.sourceIdentity);
  if (verifyRebuild) {
    const expected = JSON.parse(await readFile(join(snapshot, 'packages.json')));
    for (const packed of receipt.packages) {
      const original = expected.packages.find(item => item.name === packed.name);
      if (!original || packed.sha256 !== original.sha256 || packed.integrity !== original.integrity) throw new Error(`Reproduction mismatch: ${packed.name}`);
    }
    receipt.status = 'passed';
    receipt.reproduction = 'All four archives reproduced byte-for-byte from the stored source archive, without sibling access';
    receipt.finishedAt = new Date().toISOString();
    await save();
    console.log(receipt.reproduction);
  } else {
  await mkdir(destination, { recursive: false }); // Never overwrite a published snapshot.
  await cp(snapshot, destination, { recursive: true });
  for (const filename of await readdir(packs)) await cp(join(packs, filename), join(destination, filename));
  await cp(join(work, 'LICENSE'), join(destination, 'LICENSE'));
  receipt.status = 'passed';
  receipt.finishedAt = new Date().toISOString();
  await save();
  await cp(join(runDirectory, 'producer-receipt.json'), join(destination, 'producer-receipt.json'));
  await writeFile(join(destination, 'packages.json'), JSON.stringify({ schema: 1, sourceIdentity: manifest.sourceIdentity, packages: receipt.packages.map(({ files, ...pkg }) => pkg) }, null, 2) + '\n');
  console.log(`Produced immutable packages: ${destination}`);
  }
} catch (error) {
  receipt.status = 'failed';
  receipt.failure = String(error);
  receipt.finishedAt = new Date().toISOString();
  await save();
  throw error;
} finally {
  console.log(`Receipt: ${join(runDirectory, 'producer-receipt.json')}`);
  console.log(`Isolated work retained: ${work}`);
}

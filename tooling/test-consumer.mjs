import { readFile, writeFile, mkdir, mkdtemp, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, platform, arch, release } from 'node:os';
import { copyConsumerInputs } from './consumer-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(join(root, 'tooling/toolchain.json')));
if (process.versions.node !== config.node) throw new Error(`Use Node ${config.node}`);
const npmCli = join(root, '.toolchain', `npm-${config.npm}`, 'package/bin/npm-cli.js');
const fixture = await mkdtemp(join(tmpdir(), 'ideogram-consumer-'));
await mkdir(join(root, 'artifacts'), { recursive: true });
const receiptDirectory = await mkdtemp(join(root, 'artifacts/consumer-'));
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(fixture, '.home'),
  TMPDIR: tmpdir(), CI: '1', npm_config_cache: join(fixture, '.npm-cache'),
  npm_config_userconfig: join(fixture, '.npmrc'), PLAYWRIGHT_BROWSERS_PATH: join(fixture, '.browsers'),
  LANG: 'en_US.UTF-8' };
const receipt = { schema: 1, startedAt: new Date().toISOString(), status: 'running', fixture,
  commands: [], platform: { platform: platform(), arch: arch(), release: release() }, toolchain: config,
  isolation: { freshNodeModules: true, emptyNpmCache: true, freshBrowserCache: true, copiedSiblingSource: false,
    upstreamToolchainUsed: false, limits: 'Filesystem isolation by empty directory, exact files and no external package links; not an OS sandbox.' },
  qualification: 'Q12/Q13 bounded consumer smoke only. Adapter, full supported browsers and Q3 I2 remain unqualified.' };
function run(executable, args) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const result = spawnSync(executable, args, { cwd: fixture, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entry = { executable: executable === process.execPath ? 'pinned-node' : executable,
    args: args.map(arg => arg === npmCli ? 'pinned-npm-cli' : arg), startedAt,
    elapsedMs: performance.now() - start, exit: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
  receipt.commands.push(entry);
  console.log(`${entry.args.join(' ')}: ${entry.exit} (${(entry.elapsedMs / 1000).toFixed(2)}s)`);
  if (result.status !== 0) throw new Error(`${entry.args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const npm = (...args) => run(process.execPath, [npmCli, ...args]);
try {
  receipt.copiedInputs = await copyConsumerInputs(root, fixture);
  await mkdir(env.HOME);
  await mkdir(join(fixture, 'artifacts'));
  if (npm('--version').trim() !== config.npm) throw new Error('Wrong npm version');
  const installStart = performance.now();
  run('python3', ['tooling/verify-vendor.py']);
  npm('ci');
  npm('ls', '--all', '--json');
  run('python3', ['tooling/verify-vendor.py']);
  receipt.installAndVendorElapsedMs = performance.now() - installStart;
  // Realpath checks prevent accidental workspace/sibling linking in the installed graph.
  run(process.execPath, ['--input-type=module', '-e', `
    import { realpath, lstat, readFile } from 'node:fs/promises';
    import { resolve, sep } from 'node:path';
    const lock = JSON.parse(await readFile('package-lock.json'));
    for (const [path, value] of Object.entries(lock.packages)) {
      if (!path) continue;
      const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT' && value.optional) return null; throw error; });
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new Error('Linked dependency: ' + path);
      if (!(await realpath(path)).startsWith(resolve('node_modules') + sep)) throw new Error('External dependency: ' + path);
      const installed = JSON.parse(await readFile(path + '/package.json'));
      if (installed.version !== value.version) throw new Error('Version mismatch: ' + path);
    }
    console.log('Installed graph has no sibling links and matches the lock');
  `]);
  npm('run', 'typecheck:consumer');
  const buildStart = performance.now();
  npm('run', 'build:consumer');
  receipt.buildElapsedMs = performance.now() - buildStart;
  receipt.buildEvidence = JSON.parse(await readFile(join(fixture, 'dist/consumer/build-evidence.json')));
  run(process.execPath, ['node_modules/@playwright/test/cli.js', 'install', 'chromium']);
  run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/consumer/playwright.config.ts']);
  receipt.browser = JSON.parse(run(process.execPath, ['--input-type=module', '-e', `
    import { chromium } from '@playwright/test';
    import { readFile } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    const executable = chromium.executablePath();
    const browser = await chromium.launch();
    console.log(JSON.stringify({ version: browser.version(), executable, sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
      revisionManifest: JSON.parse(await readFile('node_modules/playwright-core/browsers.json')) }));
    await browser.close();
  `]));
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.failure = String(error);
  throw error;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(receiptDirectory, 'consumer-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await cp(join(fixture, 'artifacts'), join(receiptDirectory, 'artifacts'), { recursive: true });
  await cp(join(fixture, 'test-results'), join(receiptDirectory, 'test-results'), { recursive: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log(`Consumer receipt: ${join(receiptDirectory, 'consumer-receipt.json')}`);
  console.log(`Isolated consumer retained: ${fixture}`);
}

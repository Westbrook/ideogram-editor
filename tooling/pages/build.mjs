import { spawn } from 'node:child_process';
import { mkdir, readFile, copyFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { buildIdentity, noticeInputs, sealArtifact } from './artifact.mjs';
import { committedInputs } from './source.mjs';

export function argumentsFor(args) {
  const options = {};
  while (args.length) {
    const key = args.shift(), value = args.shift();
    const field = { '--commit': 'commit', '--built-at': 'builtAt', '--metadata': 'metadata', '--output': 'output' }[key];
    if (!field || !value || options[field]) throw Error('Usage: build.mjs --commit SHA --built-at UTC --metadata /fresh/private/directory --output /fresh/public-artifact');
    options[field] = value;
  }
  buildIdentity(options.commit, options.builtAt);
  if (!options.metadata || !isAbsolute(options.metadata) || !options.output || !isAbsolute(options.output) || resolve(options.output) === resolve(options.metadata)) throw Error('Distinct fresh absolute build metadata and public artifact directories required');
  return options;
}
export function cleanEnvironment(environment) {
  return { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'PLAYWRIGHT_BROWSERS_PATH'].filter(key => environment[key] !== undefined).map(key => [key, environment[key]])),
    CI: '1', NO_COLOR: '1', IDEOGRAM_PROVIDER_MODE: 'disabled' };
}
async function run(executable, args, env) {
  const child = spawn(executable, args, { cwd: process.cwd(), env, stdio: 'inherit' });
  await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => code === 0 && !signal ? accept() : reject(Error(`Pages build gate failed: ${executable} ${args.join(' ')}`))); });
}
// This is a build-input attestation, not a replacement for the browser request
// guards. API path declarations in the real UI do not grant a live transport.
export function verifyOfflineGraph(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 4096 || rows.some(row => !row || typeof row.path !== 'string' || !row.path || row.path.length > 1024 || row.path.startsWith('/') || row.path.includes('\\') || row.path.split('/').some(part => !part || part === '.' || part === '..'))) throw Error('Invalid Pages module inventory');
  const modules = new Set(rows.map(row => row.path));
  for (const path of ['pages/main.ts', 'pages/text-demo.ts', 'pages/offline-session-client.ts', 'src/ui/shell.ts', 'src/state/editor-client.ts', 'src/text/client.ts', 'src/text/worker.ts', 'src/theme/shell.css'])
    if (!modules.has(path)) throw Error(`Required production browser slice absent from Pages graph: ${path}`);
  if (modules.has('src/main.ts') || modules.has('src/state/session-client.ts') || [...modules].some(path => /^(?:server|tests|tooling)\/|^node:|(?:^|\/)\.\.(?:\/|$)/.test(path))) throw Error('Private or live session module entered the Pages graph');
  return { schema: 1, kind: 'ideogram-pages-offline-graph-1', mode: 'disconnected', modules: [...modules].sort() };
}

export async function buildPages(options) {
  if (process.versions.node !== '26.10.0') throw Error('Pages build requires Node 26.10.0');
  const root = process.cwd(), identity = buildIdentity(options.commit, options.builtAt);
  if (await lstat(options.output).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw Error('Public artifact output already exists; choose a fresh assigned run');
  await mkdir(options.metadata, { recursive: false, mode: 0o700 });
  const source = await committedInputs(root, identity.commit);
  await writeFile(join(options.metadata, 'source.json'), JSON.stringify(source, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await mkdir(options.output, { recursive: false, mode: 0o700 });
  const env = { ...cleanEnvironment(process.env), PAGES_SOURCE_COMMIT: identity.commit, PAGES_BUILD_DATE: identity.builtAt, PAGES_BUILD_METADATA: resolve(options.metadata), PAGES_BUILD_OUTPUT: resolve(options.output) };
  // The audited validation entry runs the whole-repository typecheck first.
  // This build-only command also covers the isolated preview type closure.
  for (const command of [ ['exec', '--offline', '--', 'tsc', '--noEmit', '-p', 'tsconfig.pages.json'], ['run', 'verify:vendor'],
    ['run', 'verify:text'], ['run', 'verify:imports'] ]) await run('npm', command, env);
  await run(process.execPath, ['tooling/theme/density.mjs'], env);
  await run('npm', ['exec', '--offline', '--', 'vite', 'build', '--config', 'vite.pages.config.ts'], env);
  const moduleBytes = await readFile(join(options.metadata, 'modules.jsonl'));
  if (moduleBytes.length > 4 * 1024 * 1024) throw Error('Pages graph evidence bound exceeded');
  const boundary = verifyOfflineGraph(moduleBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line)));
  await writeFile(join(options.metadata, 'offline-boundary.json'), JSON.stringify(boundary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const notices = await noticeInputs(root), directory = options.output;
  await mkdir(join(directory, 'notices'));
  for (const row of notices) await copyFile(join(root, row.source), join(directory, row.path));
  await writeFile(join(directory, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n', { flag: 'wx' });
  // The prebuilt branch must bypass Jekyll without introducing any public data.
  await writeFile(join(directory, '.nojekyll'), Buffer.alloc(0), { flag: 'wx' });
  const manifest = await sealArtifact(root, directory, identity);
  if ((await committedInputs(root, identity.commit)).digest !== source.digest) throw Error('Pages source changed during build');
  console.log(JSON.stringify({ outcome: 'PASS', scope: 'Build and public artifact only; browser validation separate', identity, files: manifest.files.length, moduleCount: boundary.modules.length }));
}
if (import.meta.main) buildPages(argumentsFor(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });

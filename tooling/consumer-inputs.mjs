import {readFile, lstat} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';

// Install the root lock's complete local archive closure. Validation does not
// create a workspace, run npm, download a browser, or import a test module.
export async function consumerInputs(root) {
  const packageJSON = JSON.parse(await readFile(resolve(root, 'package.json')));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json')));
  const archivePaths = new Set();
  for (const [name, spec] of Object.entries({...packageJSON.dependencies, ...packageJSON.devDependencies})) {
    if (!spec.startsWith('file:')) continue;
    const path = spec.slice(5);
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || !path.startsWith('vendor/') || !path.endsWith('.tgz')) throw Error(`Unsafe local dependency: ${name}`);
    if (lock.packages?.['']?.dependencies?.[name] !== spec && lock.packages?.['']?.devDependencies?.[name] !== spec) throw Error(`Local dependency differs from lock: ${name}`);
    archivePaths.add(path);
  }
  const paths = ['package.json', 'package-lock.json', '.npmrc', 'tsconfig.json', 'vite.config.ts', 'tooling', 'tests/consumer', 'vendor/en-reve', 'vendor/text', 'src/text/profile.json'];
  for (const path of [...paths, ...archivePaths]) {
    const absolute = resolve(root, path);
    if (relative(root, absolute).startsWith('..')) throw Error('Consumer input escaped root');
    const info = await lstat(absolute).catch(() => null);
    if (!info || info.isSymbolicLink()) throw Error(`Missing or linked consumer input: ${path}`);
  }
  return {paths: [...new Set([...paths, ...[...archivePaths].filter(path => !paths.some(parent => path.startsWith(parent + '/')))])], archivePaths: [...archivePaths].sort()};
}

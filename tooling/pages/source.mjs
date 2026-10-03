import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);
// The ordinary source identity's complete path classes, plus this isolated
// preview and its public setup documentation. This is a distinct Pages closure,
// not a claim that an older production-only digest has been reused.
const isInput = path => /^(pages\/|src\/|server\/|tooling\/|tests\/|docs\/spec\/|docs\/PAGES\.md$|vendor\/|\.github\/workflows\/|\.npmrc$|\.progress-report\/project\.json$|index\.html$|package(?:-lock)?\.json$|tsconfig[^/]*\.json$|vite[^/]*\.ts$|AGENTS\.md$)/.test(path);
// Compare Git blob bytes directly, rather than trusting a caller-provided SHA or
// clean/smudge filters. This also supports a detached validation checkout whose
// bytes match a reviewed commit elsewhere in the same repository.
export async function committedInputs(root, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw Error('Exact SHA-1 commit required');
  if (await realpath(root) !== root) throw Error('Canonical owned checkout required');
  const env = { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const options = { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 };
  if ((await execute('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim() !== root) throw Error('Pages inputs must belong to the selected checkout');
  if ((await execute('git', ['cat-file', '-t', commit], options)).stdout.trim() !== 'commit') throw Error('Pages revision is not a commit');
  const rows = (await execute('git', ['ls-tree', '-r', '-z', '--full-tree', commit], options)).stdout.split('\0').filter(row => row && isInput(row.slice(row.indexOf('\t') + 1))).map(row => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\n]+)$/.exec(row);
    if (!match || match[3].includes('\\') || match[3].split('/').some(part => ['.', '..'].includes(part))) throw Error('Pages source must contain ordinary tracked files');
    return { path: match[3], object: match[2], mode: match[1] };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const current = (await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], options)).stdout.split('\0').filter(isInput).sort();
  if (!rows.length || rows.length > 8192 || JSON.stringify([...new Set(current)].sort()) !== JSON.stringify(rows.map(row => row.path).sort())) throw Error('Pages source inventory differs from the labelled commit');
  const files = []; let totalBytes = 0;
  for (const row of rows) {
    const path = join(root, row.path), before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 256 * 1024 * 1024 || (totalBytes += before.size) > 512 * 1024 * 1024 || await realpath(path) !== path) throw Error('Invalid or oversized committed Pages input');
    const blob = createHash('sha1').update(`blob ${before.size}\0`), content = createHash('sha256'); let bytes = 0;
    for await (const part of createReadStream(path)) { blob.update(part); content.update(part); bytes += part.length; }
    const after = await lstat(path);
    if (bytes !== before.size || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || blob.digest('hex') !== row.object ||
        Boolean(after.mode & 0o111) !== (row.mode === '100755')) throw Error(`Pages input differs from the labelled commit: ${row.path}`);
    files.push({ path: row.path, bytes, sha256: content.digest('hex'), gitObject: row.object });
  }
  return { commit, files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

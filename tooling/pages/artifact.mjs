import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const publicBase = '/ideogram-editor/';
export function buildIdentity(commit, builtAt) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(builtAt ?? '') || new Date(builtAt).toISOString() !== builtAt) throw Error('Exact commit and canonical UTC build date required');
  return { schema: 1, product: 'Ideogram Editor preview', scope: 'Temporary text preview; no local server or provider', commit, builtAt, base: publicBase };
}
export async function noticeInputs(root, { verifySources = true } = {}) {
  const manifest = JSON.parse(await readFile(join(root, 'tooling/pages/notices.json'), 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 64) throw Error('Invalid public notice inventory');
  const destinations = new Set();
  for (const row of manifest.files) {
    if (!/^(?:tooling\/pages|vendor\/[^\s]+|node_modules\/[^\s]+)\/[A-Za-z0-9_.-]+$/.test(row.source) ||
        row.source.split('/').some(part => ['.', '..'].includes(part)) || !/^notices\/[A-Za-z0-9_.-]+\.txt$/.test(row.path) || destinations.has(row.path) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 1024 * 1024 || !/^[0-9a-f]{64}$/.test(row.sha256)) throw Error('Unsafe public notice member');
    destinations.add(row.path);
    if (verifySources) {
      const path = join(root, row.source), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw Error('Notice source must be a regular, non-linked file');
      const bytes = await readFile(path);
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw Error(`Notice source changed: ${row.source}`);
    }
  }
  if (!destinations.has('notices/index.txt')) throw Error('Public notice index missing');
  return manifest.files;
}

async function inventory(root, directory, notices) {
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw Error('Public artifact directory must be canonical');
  const allowedNotices = new Map(notices.map(row => [row.path, row]));
  const rows = []; let total = 0, fileCount = 0;
  async function walk(prefix = '') {
    for (const name of (await readdir(join(directory, prefix))).sort()) {
      const path = prefix + name, absolute = join(directory, path), stat = await lstat(absolute);
      if (stat.isDirectory()) {
        if (!['assets', 'notices'].includes(path)) throw Error(`Unexpected artifact directory: ${path}`);
        await walk(path + '/'); continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw Error(`Non-regular public artifact: ${path}`);
      if (!['index.html', 'build-identity.json', 'artifact-manifest.json'].includes(path) && !allowedNotices.has(path) &&
          !/^assets\/[A-Za-z0-9_.-]+\.(?:js|css|wasm|ttf|otf|woff2?|svg)$/.test(path)) throw Error(`Unapproved public artifact: ${path}`);
      if (stat.size > 24 * 1024 * 1024 || ++fileCount > 160 || (total += stat.size) > 64 * 1024 * 1024) throw Error('Public artifact bound exceeded');
      const bytes = await readFile(absolute);
      const notice = allowedNotices.get(path);
      if (notice && (bytes.length !== notice.bytes || hash(bytes) !== notice.sha256)) throw Error(`Distributed notice differs: ${path}`);
      if (/\.(?:html|js|css|json|svg)$/.test(path)) {
        const text = bytes.toString('utf8');
        if (/sourceMappingURL|\/Users\/|\/private\/tmp\/|\.progress-report|127\.0\.0\.1|localhost|\/api\/v1|fal\.run|queue\.fal\.run|sk-proj-[A-Za-z0-9]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw Error(`Private, backend, credential or map marker in public artifact: ${path}`);
      }
      if (path !== 'artifact-manifest.json') rows.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  await walk(); rows.sort((a, b) => a.path.localeCompare(b.path));
  for (const path of ['index.html', 'build-identity.json', ...allowedNotices.keys()]) if (!rows.some(row => row.path === path)) throw Error(`Missing public artifact: ${path}`);
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  if (!html.includes('Content-Security-Policy') || !html.includes(`${publicBase}assets/`)) throw Error('Pages base or explicit preview policy missing');
  if (/\b(?:src|href)=["']\/(?!ideogram-editor\/)/.test(html)) throw Error('Root-relative asset bypasses the project base');
  const profile = JSON.parse(await readFile(join(root, 'src/text/profile.json'), 'utf8'));
  const wasm = rows.filter(row => row.path.endsWith('.wasm'));
  if (wasm.length !== 1 || wasm[0].bytes !== profile.engine.wasm.bytes || wasm[0].sha256 !== profile.engine.wasm.sha256) throw Error('Public native WASM differs from the sealed renderer');
  const fonts = rows.filter(row => /\.(?:ttf|otf|woff2?)$/.test(row.path));
  if (fonts.length !== profile.fonts.length || profile.fonts.some(font => fonts.filter(row => row.bytes === font.bytes && row.sha256 === font.sha256).length !== 1)) throw Error('Public fonts differ from the sealed font inventory');
  if (!rows.some(row => row.path.endsWith('.css')) || !rows.some(row => row.path.endsWith('.js'))) throw Error('Pages scripts/styles missing');
  return rows;
}

export async function sealArtifact(root, directory, identity) {
  const notices = await noticeInputs(root);
  const files = await inventory(root, directory, notices);
  const observed = JSON.parse(await readFile(join(directory, 'build-identity.json'), 'utf8'));
  if (!same(observed, buildIdentity(identity.commit, identity.builtAt))) throw Error('Build identity differs');
  const manifest = { schema: 1, kind: 'ideogram-pages-public-artifact-1', identity: observed, files };
  await writeFile(join(directory, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function verifyArtifact(root, directory, expectedCommit) {
  const manifest = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.kind !== 'ideogram-pages-public-artifact-1' || !same(manifest.identity, buildIdentity(manifest.identity?.commit, manifest.identity?.builtAt)) ||
      (expectedCommit && manifest.identity.commit !== expectedCommit)) throw Error('Invalid public artifact identity');
  const identity = JSON.parse(await readFile(join(directory, 'build-identity.json'), 'utf8'));
  if (!same(identity, manifest.identity) || !same(manifest.files, await inventory(root, directory, await noticeInputs(root, { verifySources: false })))) throw Error('Public artifact changed after sealing');
  return manifest;
}
if (import.meta.main) {
  if (process.argv.length !== 4 || !/^[0-9a-f]{40}$/.test(process.argv[3])) throw Error('Usage: node tooling/pages/artifact.mjs /absolute/public-artifact COMMIT');
  const result = await verifyArtifact(process.cwd(), resolve(process.argv[2]), process.argv[3]);
  console.log(JSON.stringify({ outcome: 'PASS', commit: result.identity.commit, files: result.files.length, bytes: result.files.reduce((n, row) => n + row.bytes, 0), scope: 'Public artifact verification only' }));
}

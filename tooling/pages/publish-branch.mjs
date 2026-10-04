import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { buildIdentity, verifyArtifact } from './artifact.mjs';
import { committedInputs } from './source.mjs';

const repository = 'Westbrook/ideogram-editor';
const reference = 'refs/heads/gh-pages';
const sha1 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ordered = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path));
const limits = Object.freeze({ files: 160, memberBytes: 24 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, manifestBytes: 1024 * 1024, responseBytes: 2 * 1024 * 1024 });
const publicPath = path => typeof path === 'string' && (['index.html', 'build-identity.json'].includes(path) ||
  /^assets\/[A-Za-z0-9_.-]+\.(?:js|css|wasm|ttf|otf|woff2?|svg)$/.test(path) || /^assets\/profile-[A-Za-z0-9_-]{8}\.json$/.test(path) || /^notices\/[A-Za-z0-9_.-]+\.txt$/.test(path));

export function publicationArguments(args) {
  const options = {};
  while (args.length) {
    const field = { '--directory': 'directory', '--commit': 'sourceCommit', '--manifest-sha256': 'manifestSHA256' }[args.shift()], value = args.shift();
    if (!field || !value || options[field]) throw Error('Usage: publish-branch.mjs --directory /verified/public-artifact --commit SHA --manifest-sha256 SHA256');
    options[field] = value;
  }
  if (!isAbsolute(options.directory ?? '') || !sha1(options.sourceCommit) || !sha256(options.manifestSHA256)) throw Error('Exact public artifact directory, source commit and build-job manifest hash required');
  return options;
}

/** A fixed-origin, bounded transport. Never follows a response-provided URL or logs an API body/token. */
export function githubRequest(token, transport = fetch, signal = AbortSignal.timeout(10 * 60_000)) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw Error('GH_TOKEN is required in the publication step');
  return async (method, path, body, { allowMissing = false } = {}) => {
    const allowed = method === 'GET' && (/^\/git\/(?:blobs|commits)\/[0-9a-f]{40}$/.test(path) || /^\/git\/trees\/[0-9a-f]{40}\?recursive=1$/.test(path) || path === '/git/ref/heads/gh-pages') ||
      method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits', '/git/refs'].includes(path) ||
      method === 'PATCH' && path === '/git/refs/heads/gh-pages';
    const referenceBody = path === '/git/refs' && method === 'POST'
      ? body?.ref === reference && sha1(body.sha) && same(Object.keys(body).sort(), ['ref', 'sha'])
      : path === '/git/refs/heads/gh-pages' && method === 'PATCH'
        ? body?.force === false && sha1(body.sha) && same(Object.keys(body).sort(), ['force', 'sha']) : true;
    if (!allowed || !referenceBody || method === 'GET' && body !== undefined || allowMissing && (method !== 'GET' || path !== '/git/ref/heads/gh-pages')) throw Error('Unapproved GitHub publication endpoint or reference mutation');
    signal.throwIfAborted();
    let response;
    try {
      response = await transport(`https://api.github.com/repos/${repository}${path}`, {
        method, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'ideogram-pages-publication', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw Error(`GitHub ${method} ${path.split('?')[0]} request failed; remote outcome is unconfirmed`); }
    const cancelBody = async () => { try { await response.body?.cancel(); } catch { /* Response payloads never enter diagnostics. */ } };
    if (allowMissing && response.status === 404) { await cancelBody(); return null; }
    if (response.status !== (method === 'POST' ? 201 : 200)) {
      await cancelBody();
      throw Error(`GitHub ${method} ${path.split('?')[0]} refused (HTTP ${response.status}); no automatic retry`);
    }
    if (!response.body) throw Error('GitHub returned no publication response body');
    const reader = response.body.getReader(), bytes = Buffer.alloc(limits.responseBytes);
    let used = 0, ended = false;
    const oversized = Error('GitHub publication response exceeded its bound');
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) { ended = true; break; }
        if (used + part.value.byteLength > bytes.length) throw oversized;
        bytes.set(part.value, used); used += part.value.byteLength;
      }
      try { return JSON.parse(bytes.subarray(0, used).toString('utf8')); }
      catch { throw Error('GitHub returned invalid publication metadata'); }
    } catch (error) {
      if (error === oversized) throw error;
      throw Error('GitHub returned unreadable publication metadata; remote outcome is unconfirmed');
    } finally { try { if (!ended) await reader.cancel(); } catch { /* Do not expose response data. */ } finally { reader.releaseLock(); } }
  };
}

export function manifestRows(manifest, manifestBytes, { historical = false } = {}) {
  const identity = buildIdentity(manifest?.identity?.commit, manifest?.identity?.builtAt);
  const recognizedIdentity = same(manifest?.identity, identity) || historical && same(manifest?.identity, { ...identity, scope: 'Temporary text preview; no local server or provider' });
  if (manifest?.schema !== 1 || manifest.kind !== 'ideogram-pages-public-artifact-1' ||
      !recognizedIdentity ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length + 1 > limits.files ||
      manifestBytes.length > limits.manifestBytes) throw Error('Unrecognized gh-pages artifact manifest');
  let total = manifestBytes.length;
  const names = new Set();
  for (const row of manifest.files) {
    if (!publicPath(row.path) || names.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > limits.memberBytes || !sha256(row.sha256)) throw Error('Invalid gh-pages public artifact member');
    names.add(row.path); total += row.bytes;
  }
  if (total > limits.totalBytes || !['index.html', 'build-identity.json', 'notices/index.txt'].every(path => names.has(path))) throw Error('Incomplete or oversized gh-pages public artifact');
  return ordered([...manifest.files, { path: 'artifact-manifest.json', bytes: manifestBytes.length, sha256: hash(manifestBytes) }]);
}

function treeFiles(tree, expectedSHA) {
  if (!tree || tree.sha !== expectedSHA || !sha1(tree.sha) || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > limits.files + 2) throw Error('Incomplete gh-pages tree response');
  const names = new Set(), files = [], directories = [];
  for (const row of tree.tree) {
    if (typeof row.path !== 'string' || names.has(row.path) || !sha1(row.sha)) throw Error('Ambiguous gh-pages tree');
    names.add(row.path);
    if (row.type === 'tree' && row.mode === '040000' && ['assets', 'notices'].includes(row.path)) directories.push(row.path);
    else if (row.type === 'blob' && row.mode === '100644' && (publicPath(row.path) || row.path === 'artifact-manifest.json') &&
        Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= limits.memberBytes) files.push({ path: row.path, bytes: row.size, gitSHA: row.sha });
    else throw Error('Existing gh-pages contains foreign or non-ordinary files; review it before publication');
  }
  const requiredDirectories = [...new Set(files.filter(row => row.path.includes('/')).map(row => row.path.split('/')[0]))].sort();
  if (!same(directories.sort(), requiredDirectories)) throw Error('Unexpected gh-pages directory inventory');
  return ordered(files);
}

function refSHA(value) {
  if (value === null) return null;
  if (value.ref !== reference || value.object?.type !== 'commit' || !sha1(value.object.sha)) throw Error('Unrecognized gh-pages reference');
  return value.object.sha;
}
const readHead = async request => refSHA(await request('GET', '/git/ref/heads/gh-pages', undefined, { allowMissing: true }));
function verifiedCommit(value, sha, treeSHA, parent) {
  if (!value || value.sha !== sha || value.tree?.sha !== treeSHA || !Array.isArray(value.parents) ||
      !same(value.parents.map(item => item.sha), parent ? [parent] : [])) throw Error('Artifact commit tree or parent differs from the reviewed publication');
}

export async function existingArtifact(request, head) {
  if (!head) return null;
  const commit = await request('GET', '/git/commits/' + head);
  if (commit.sha !== head || !sha1(commit.tree?.sha)) throw Error('Existing gh-pages commit is invalid');
  const tree = await request('GET', '/git/trees/' + commit.tree.sha + '?recursive=1');
  const files = treeFiles(tree, commit.tree.sha), row = files.find(item => item.path === 'artifact-manifest.json');
  if (!row || row.bytes > limits.manifestBytes) throw Error('Existing gh-pages is not a recognized public artifact; review it before publication');
  const blob = await request('GET', '/git/blobs/' + row.gitSHA);
  if (blob.sha !== row.gitSHA || blob.encoding !== 'base64' || blob.size !== row.bytes || typeof blob.content !== 'string' || blob.content.length > limits.manifestBytes * 2) throw Error('Invalid existing artifact manifest blob');
  const encoded = blob.content.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Error('Invalid existing manifest encoding');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== row.bytes || blobHash(bytes) !== row.gitSHA) throw Error('Existing artifact manifest blob identity differs');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw Error('Existing gh-pages manifest is invalid JSON'); }
  const described = manifestRows(manifest, bytes, { historical: true });
  // Recognize the entire prior distribution, refusing extra files. Old payload
  // SHA-256 values are declarations here; the new payloads are locally rehashed.
  if (!same(files.map(({ path, bytes }) => ({ path, bytes })), described.map(({ path, bytes }) => ({ path, bytes })))) throw Error('Existing gh-pages contains files outside its recognized manifest');
  return { head, treeSHA: commit.tree.sha, files, sourceCommit: manifest.identity.commit };
}

async function verifiedMember(directory, row) {
  const path = join(directory, row.path), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== row.bytes || await realpath(path) !== path) throw Error('Public artifact member changed before publication');
  const bytes = await readFile(path), after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw Error('Public artifact member does not match the build-job seal');
  return bytes;
}

export async function publicationArtifact(root, options) {
  const directory = resolve(options.directory);
  if (!isAbsolute(options.directory) || await realpath(directory) !== directory || !sha1(options.sourceCommit) || !sha256(options.manifestSHA256)) throw Error('Invalid publication input');
  await committedInputs(root, options.sourceCommit);
  const manifest = await verifyArtifact(root, directory, options.sourceCommit);
  const manifestBytes = await readFile(join(directory, 'artifact-manifest.json'));
  if (hash(manifestBytes) !== options.manifestSHA256) throw Error('Artifact manifest differs from the successful build-job output');
  const rows = manifestRows(manifest, manifestBytes), files = [];
  for (const row of rows) files.push({ ...row, gitSHA: blobHash(await verifiedMember(directory, row)) });
  return {
    identity: manifest.identity, files, manifestSHA256: options.manifestSHA256,
    read: row => verifiedMember(directory, row),
    reverify: async () => {
      await committedInputs(root, options.sourceCommit);
      const current = await verifyArtifact(root, directory, options.sourceCommit);
      if (!same(current, manifest) || hash(await readFile(join(directory, 'artifact-manifest.json'))) !== options.manifestSHA256) throw Error('Public artifact changed during publication');
    },
  };
}

/** The caller supplies the exact manifest hash from its successful validation run. */
export async function publishBranch(options, { request, artifact = publicationArtifact, root = process.cwd() } = {}) {
  const signal = AbortSignal.timeout(10 * 60_000);
  // All local validation precedes even a remote read or token-dependent request.
  const plan = await artifact(root, options);
  const send = request ?? githubRequest(process.env.GH_TOKEN, fetch, signal);
  const api = async (...args) => { signal.throwIfAborted(); const value = await send(...args); signal.throwIfAborted(); return value; };
  const parent = await readHead(api), previous = await existingArtifact(api, parent);
  const expected = ordered(plan.files.map(({ path, bytes, gitSHA }) => ({ path, bytes, gitSHA })));
  if (previous && same(previous.files, expected)) {
    await plan.reverify();
    if (await readHead(api) !== parent) throw Error('gh-pages changed during publication; no automatic race repair');
    return { outcome: 'PASS', action: 'unchanged', repository, ref: reference, sourceCommit: plan.identity.commit,
      artifactCommit: parent, tree: previous.treeSHA, manifestSHA256: plan.manifestSHA256, files: expected.length };
  }
  const uploaded = new Set();
  for (const row of plan.files) {
    if (uploaded.has(row.gitSHA)) continue;
    const bytes = await plan.read(row);
    if (blobHash(bytes) !== row.gitSHA || hash(bytes) !== row.sha256) throw Error('Public member changed before upload');
    const blob = await api('POST', '/git/blobs', { content: bytes.toString('base64'), encoding: 'base64' });
    if (blob.sha !== row.gitSHA) throw Error('Uploaded public blob identity differs');
    uploaded.add(row.gitSHA);
  }
  // A complete new tree contains only the verified public files. The old commit
  // remains the sole parent; this does not replace or rewrite its history.
  const tree = await api('POST', '/git/trees', { tree: plan.files.map(row => ({ path: row.path, mode: '100644', type: 'blob', sha: row.gitSHA })) });
  if (!sha1(tree.sha)) throw Error('GitHub did not return an artifact tree identity');
  const observedTree = treeFiles(await api('GET', '/git/trees/' + tree.sha + '?recursive=1'), tree.sha);
  if (!same(observedTree, expected)) throw Error('Uploaded artifact tree differs from the verified local files');
  const created = await api('POST', '/git/commits', {
    message: `Publish editor preview from ${plan.identity.commit}\n\nSource commit: ${plan.identity.commit}\nArtifact manifest SHA-256: ${plan.manifestSHA256}\nGenerated public files only; local editor services are not deployed.`,
    tree: tree.sha, parents: parent ? [parent] : [],
  });
  if (!sha1(created.sha)) throw Error('GitHub did not return an artifact commit identity');
  verifiedCommit(created, created.sha, tree.sha, parent);
  verifiedCommit(await api('GET', '/git/commits/' + created.sha), created.sha, tree.sha, parent);
  await plan.reverify();
  if (await readHead(api) !== parent) throw Error('gh-pages changed during publication; no automatic race repair');
  // The API has no expected-old-SHA CAS field. Re-read plus force:false refuses
  // ordinary competing forward updates. No force, retry, rebase or reset is used.
  const updated = parent
    ? await api('PATCH', '/git/refs/heads/gh-pages', { sha: created.sha, force: false })
    : await api('POST', '/git/refs', { ref: reference, sha: created.sha });
  if (refSHA(updated) !== created.sha || await readHead(api) !== created.sha) throw Error('gh-pages final reference is unconfirmed; inspect it before retrying');
  return { outcome: 'PASS', action: parent ? 'fast-forward' : 'created', repository, ref: reference,
    sourceCommit: plan.identity.commit, artifactCommit: created.sha, previousArtifactCommit: parent,
    tree: tree.sha, manifestSHA256: plan.manifestSHA256, files: expected.length,
    scope: 'Verified public artifact branch only. Official Pages deployment and public URL verification are separate.' };
}

if (import.meta.main) publishBranch(publicationArguments(process.argv.slice(2)))
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });

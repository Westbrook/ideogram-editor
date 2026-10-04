import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildIdentity } from '../../tooling/pages/artifact.mjs';
import { existingArtifact, githubRequest, manifestRows, publicationArguments, publishBranch } from '../../tooling/pages/publish-branch.mjs';

// The publication transport is injected. This file runs beneath the repository's
// no-network preload; no fixture replaces or bypasses its fetch/socket guards.
const digest = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sort = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path));
const reference = sha => ({ ref: 'refs/heads/gh-pages', object: { type: 'commit', sha } });

function artifact(label = 'first') {
  const identity = buildIdentity(digest(label, 'sha1'), '2026-10-03T12:00:00.000Z');
  const members = new Map([
    ['index.html', Buffer.from(`<title>Public preview ${label}</title>`)],
    ['build-identity.json', Buffer.from(JSON.stringify(identity) + '\n')],
    ['notices/index.txt', Buffer.from('Public dependency notices\n')],
    ['assets/preview.js', Buffer.from(`export const preview = ${JSON.stringify(label)};\n`)],
  ]);
  const row = ([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) });
  const manifest = { schema: 1, kind: 'ideogram-pages-public-artifact-1', identity, files: sort([...members].map(row)) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  members.set('artifact-manifest.json', manifestBytes);
  const files = sort([...members].map(([path, bytes]) => ({ ...row([path, bytes]), gitSHA: blobHash(bytes) })));
  let reverifications = 0;
  return {
    identity, members, files, manifestSHA256: digest(manifestBytes),
    read: async row => Buffer.from(members.get(row.path)),
    reverify: async () => { reverifications++; },
    get reverifications() { return reverifications; },
  };
}

function remote(previous) {
  const calls = [], blobs = new Map(), trees = new Map(), commits = new Map();
  function saveTree(files) {
    const sha = digest(JSON.stringify(sort(files)), 'sha1');
    const directories = [...new Set(files.filter(row => row.path.includes('/')).map(row => row.path.split('/')[0]))];
    trees.set(sha, { sha, truncated: false, tree: [
      ...directories.map(path => ({ path, type: 'tree', mode: '040000', sha: digest(path, 'sha1') })),
      ...files.map(row => ({ path: row.path, type: 'blob', mode: '100644', sha: row.gitSHA, size: row.bytes })),
    ] });
    return sha;
  }
  function saveCommit(tree, parents, message = 'Existing public artifact') {
    const sha = digest(JSON.stringify({ tree, parents, message }), 'sha1');
    const value = { sha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })) };
    commits.set(sha, value); return value;
  }
  const state = { head: null, before: null };
  if (previous) {
    for (const bytes of previous.members.values()) blobs.set(blobHash(bytes), bytes);
    state.head = saveCommit(saveTree(previous.files), []).sha;
  }
  const request = async (method, path, body, options) => {
    const call = { method, path, body: body === undefined ? undefined : structuredClone(body), options };
    calls.push(call);
    const override = await state.before?.(call, { calls, blobs, trees, commits, state });
    if (override !== undefined) return override;
    if (method === 'GET' && path === '/git/ref/heads/gh-pages') return state.head ? reference(state.head) : null;
    if (method === 'GET' && path.startsWith('/git/commits/')) return structuredClone(commits.get(path.slice('/git/commits/'.length)));
    if (method === 'GET' && path.startsWith('/git/trees/')) return structuredClone(trees.get(path.slice('/git/trees/'.length).split('?')[0]));
    if (method === 'GET' && path.startsWith('/git/blobs/')) {
      const sha = path.slice('/git/blobs/'.length), bytes = blobs.get(sha);
      return { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    }
    if (method === 'POST' && path === '/git/blobs') {
      const bytes = Buffer.from(body.content, body.encoding), sha = blobHash(bytes);
      blobs.set(sha, bytes); return { sha };
    }
    if (method === 'POST' && path === '/git/trees') {
      assert.deepEqual(Object.keys(body), ['tree']);
      const files = body.tree.map(row => {
        assert.equal(row.type, 'blob'); assert.equal(row.mode, '100644');
        return { path: row.path, bytes: blobs.get(row.sha).length, gitSHA: row.sha };
      });
      return { sha: saveTree(files) };
    }
    if (method === 'POST' && path === '/git/commits') return structuredClone(saveCommit(body.tree, body.parents, body.message));
    if (method === 'POST' && path === '/git/refs') {
      assert.equal(state.head, null); assert.equal(body.ref, 'refs/heads/gh-pages');
      state.head = body.sha; return reference(state.head);
    }
    if (method === 'PATCH' && path === '/git/refs/heads/gh-pages') {
      assert.equal(body.force, false);
      assert.deepEqual(commits.get(body.sha).parents, [{ sha: state.head }]);
      state.head = body.sha; return reference(state.head);
    }
    throw Error('Unexpected mocked publication request');
  };
  return { request, calls, state, blobs, trees, commits };
}

const options = plan => ({ directory: '/verified/public-artifact', sourceCommit: plan.identity.commit, manifestSHA256: plan.manifestSHA256 });
const publish = (plan, api) => publishBranch(options(plan), { root: '/source', artifact: async () => plan, request: api.request });
const mutations = api => api.calls.filter(call => call.method !== 'GET');
const refMutations = api => api.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/git/refs'));
const previousTree = api => api.trees.get(api.commits.get(api.state.head).tree.sha);

test('arguments require an exact source commit, build-job seal and absolute artifact directory', () => {
  const plan = artifact(), args = ['--directory', '/verified/public-artifact', '--commit', plan.identity.commit, '--manifest-sha256', plan.manifestSHA256];
  assert.deepEqual(publicationArguments([...args]), options(plan));
  for (const invalid of [[], [...args, '--directory', '/elsewhere'], ['--directory', 'relative', ...args.slice(2)],
    [...args.slice(0, 3), 'main', ...args.slice(4)], [...args.slice(0, 5), 'bad'], [...args, '--ref', 'main']]) {
    assert.throws(() => publicationArguments(invalid));
  }
});

test('failed local artifact verification prevents every remote read and write', async () => {
  const api = remote();
  await assert.rejects(publishBranch({}, { artifact: async () => { throw Error('Build-job seal differs'); }, request: api.request }), /Build-job seal differs/);
  assert.deepEqual(api.calls, []);
});

test('absent branch creates only the verified public tree with a root artifact commit', async () => {
  const plan = artifact(), api = remote(), result = await publish(plan, api);
  assert.equal(result.action, 'created'); assert.equal(result.sourceCommit, plan.identity.commit);
  assert.equal(result.artifactCommit, api.state.head); assert.notEqual(result.artifactCommit, result.sourceCommit);
  assert.deepEqual(api.commits.get(result.artifactCommit).parents, []);
  assert.deepEqual(refMutations(api).map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'POST', path: '/git/refs', body: { ref: 'refs/heads/gh-pages', sha: result.artifactCommit } },
  ]);
  assert.deepEqual(previousTree(api).tree.filter(row => row.type === 'blob').map(row => row.path).sort(), plan.files.map(row => row.path).sort());
  assert.equal(plan.reverifications, 1);
});

test('recognized existing branch remains the sole parent and updates with force false', async () => {
  const old = artifact('old'), plan = artifact('new'), api = remote(old), parent = api.state.head;
  const result = await publish(plan, api);
  assert.equal(result.action, 'fast-forward'); assert.equal(result.previousArtifactCommit, parent);
  assert.deepEqual(api.commits.get(result.artifactCommit).parents, [{ sha: parent }]);
  assert.deepEqual(refMutations(api).map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'PATCH', path: '/git/refs/heads/gh-pages', body: { sha: result.artifactCommit, force: false } },
  ]);
  const oldManifestRead = api.calls.findIndex(call => call.method === 'GET' && call.path.startsWith('/git/blobs/'));
  assert.ok(oldManifestRead >= 0 && oldManifestRead < api.calls.findIndex(call => call.method === 'POST'));
});

test('identical already-published artifact is a verified no-op', async () => {
  const plan = artifact(), api = remote(plan), head = api.state.head, result = await publish(plan, api);
  assert.equal(result.action, 'unchanged'); assert.equal(result.artifactCommit, head);
  assert.deepEqual(mutations(api), []); assert.equal(plan.reverifications, 1);
});

test('foreign existing branch files are refused before any mutation', async () => {
  const api = remote(artifact('old'));
  previousTree(api).tree.push({ path: 'private-report.json', type: 'blob', mode: '100644', sha: 'f'.repeat(40), size: 12 });
  await assert.rejects(publish(artifact('new'), api), /foreign/);
  assert.deepEqual(mutations(api), []);
});

test('extra allowed-path file absent from the existing manifest is still refused', async () => {
  const api = remote(artifact('old'));
  previousTree(api).tree.push({ path: 'assets/unowned.js', type: 'blob', mode: '100644', sha: 'f'.repeat(40), size: 12 });
  await assert.rejects(publish(artifact('new'), api), /outside its recognized manifest/);
  assert.deepEqual(mutations(api), []);
});

test('unrecognized existing artifact kind cannot authorize replacing branch files', async () => {
  const api = remote(artifact('old')), row = previousTree(api).tree.find(row => row.path === 'artifact-manifest.json');
  const manifest = JSON.parse(api.blobs.get(row.sha).toString('utf8'));
  manifest.kind = 'unrelated-site';
  const bytes = Buffer.from(JSON.stringify(manifest));
  row.sha = blobHash(bytes); row.size = bytes.length; api.blobs.set(row.sha, bytes);
  await assert.rejects(publish(artifact('new'), api), /Unrecognized gh-pages artifact manifest/);
  assert.deepEqual(mutations(api), []);
});

test('manifest content must match its Git blob identity before existing branch recognition', async () => {
  const api = remote(artifact('old'));
  api.state.before = call => call.path.startsWith('/git/blobs/')
    ? { sha: call.path.slice('/git/blobs/'.length), encoding: 'base64', size: previousTree(api).tree.find(row => row.path === 'artifact-manifest.json').size, content: Buffer.from('{}').toString('base64') } : undefined;
  await assert.rejects(publish(artifact('new'), api), /blob identity differs/);
  assert.deepEqual(mutations(api), []);
});

test('source branch metadata is never accepted as the publication branch', async () => {
  const api = remote();
  api.state.before = () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } });
  await assert.rejects(publish(artifact(), api), /Unrecognized gh-pages reference/);
  assert.deepEqual(mutations(api), []);
});

test('a competing head observed before reference update leaves the branch untouched', async () => {
  const api = remote(artifact('old')); let reads = 0;
  api.state.before = call => {
    if (call.path === '/git/ref/heads/gh-pages' && ++reads === 2) api.state.head = 'f'.repeat(40);
  };
  await assert.rejects(publish(artifact('new'), api), /changed during publication/);
  assert.equal(api.state.head, 'f'.repeat(40)); assert.deepEqual(refMutations(api), []);
});

test('a refused fast-forward update is not retried or forced', async () => {
  const api = remote(artifact('old')), parent = api.state.head;
  api.state.before = call => { if (call.method === 'PATCH') throw Error('GitHub refused (HTTP 422)'); };
  await assert.rejects(publish(artifact('new'), api), /HTTP 422/);
  assert.equal(api.state.head, parent); assert.equal(refMutations(api).length, 1);
  assert.equal(refMutations(api)[0].body.force, false);
});

test('unconfirmed final branch ownership reports failure without automatic repair', async () => {
  const api = remote(); let reads = 0;
  api.state.before = call => call.path === '/git/ref/heads/gh-pages' && ++reads === 3 ? reference('e'.repeat(40)) : undefined;
  await assert.rejects(publish(artifact(), api), /final reference is unconfirmed/);
  assert.equal(refMutations(api).length, 1);
});

test('changed owned bytes are detected before upload of that member', async () => {
  const plan = artifact(), api = remote();
  plan.read = async () => Buffer.from('changed');
  await assert.rejects(publish(plan, api), /changed before upload/);
  assert.deepEqual(mutations(api), []);
});

test('incorrect uploaded blob identity prevents tree and branch creation', async () => {
  const api = remote();
  api.state.before = call => call.method === 'POST' && call.path === '/git/blobs' ? { sha: 'f'.repeat(40) } : undefined;
  await assert.rejects(publish(artifact(), api), /Uploaded public blob identity differs/);
  assert.deepEqual(mutations(api).map(call => call.path), ['/git/blobs']);
});

test('unexpected uploaded tree member prevents artifact commit creation', async () => {
  const api = remote();
  api.state.before = call => {
    if (call.method !== 'GET' || !call.path.startsWith('/git/trees/')) return;
    const tree = structuredClone(api.trees.get(call.path.slice('/git/trees/'.length).split('?')[0]));
    tree.tree.push({ path: 'assets/unowned.js', type: 'blob', mode: '100644', sha: 'f'.repeat(40), size: 1 }); return tree;
  };
  await assert.rejects(publish(artifact(), api), /Uploaded artifact tree differs/);
  assert.equal(api.calls.some(call => call.path === '/git/commits'), false);
  assert.deepEqual(refMutations(api), []);
});

test('wrong artifact commit parent prevents every branch update', async () => {
  const api = remote();
  api.state.before = call => call.method === 'POST' && call.path === '/git/commits'
    ? { sha: 'f'.repeat(40), tree: { sha: call.body.tree }, parents: [{ sha: 'e'.repeat(40) }] } : undefined;
  await assert.rejects(publish(artifact(), api), /commit tree or parent differs/);
  assert.deepEqual(refMutations(api), []);
});

test('failed final source and artifact verification prevents branch mutation', async () => {
  const plan = artifact(), api = remote();
  plan.reverify = async () => { throw Error('Public artifact changed during publication'); };
  await assert.rejects(publish(plan, api), /changed during publication/);
  assert.deepEqual(refMutations(api), []);
});

test('transport fixes repository, API origin, redirect policy and token-bearing request scope', async () => {
  const calls = [], request = githubRequest('test-token', async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify(reference('a'.repeat(40))), { status: 200 });
  });
  await request('GET', '/git/ref/heads/gh-pages');
  assert.equal(calls[0].url, 'https://api.github.com/repos/Westbrook/ideogram-editor/git/ref/heads/gh-pages');
  assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('transport rejects source refs, forced updates and extra reference fields before sending', async () => {
  let calls = 0;
  const request = githubRequest('test-token', async () => { calls++; throw Error('must not send'); });
  const sha = 'a'.repeat(40);
  for (const args of [
    ['PATCH', '/git/refs/heads/main', { sha, force: false }],
    ['POST', '/git/refs', { ref: 'refs/heads/main', sha }],
    ['PATCH', '/git/refs/heads/gh-pages', { sha, force: true }],
    ['PATCH', '/git/refs/heads/gh-pages', { sha, force: false, ref: 'main' }],
    ['DELETE', '/git/refs/heads/gh-pages'],
    ['GET', 'https://example.test/'],
  ]) await assert.rejects(request(...args), /Unapproved GitHub publication endpoint/);
  assert.equal(calls, 0);
});

test('only an explicitly allowed absent publication reference accepts HTTP 404', async () => {
  const request = githubRequest('test-token', async () => new Response('private response must stay hidden', { status: 404 }));
  assert.equal(await request('GET', '/git/ref/heads/gh-pages', undefined, { allowMissing: true }), null);
  await assert.rejects(request('GET', '/git/ref/heads/gh-pages'), error => /HTTP 404/.test(error.message) && !error.message.includes('private response'));
  await assert.rejects(request('GET', '/git/commits/' + 'a'.repeat(40), undefined, { allowMissing: true }), /Unapproved/);
});

test('transport refuses oversized API responses', async () => {
  const request = githubRequest('test-token', async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1, 32), { status: 200 }));
  await assert.rejects(request('GET', '/git/ref/heads/gh-pages'), /response exceeded its bound/);
});

test('expired shared publication deadline prevents another request', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const request = githubRequest('test-token', async () => { calls++; }, controller.signal);
  await assert.rejects(request('GET', '/git/ref/heads/gh-pages'), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('transport error messages cannot disclose transport payloads or credentials', async () => {
  const request = githubRequest('test-token', async () => { throw Error('secret-response Bearer test-token'); });
  await assert.rejects(request('GET', '/git/ref/heads/gh-pages'), error => /remote outcome is unconfirmed/.test(error.message) && !/test-token|secret-response/.test(error.message));
});

test('truncated existing remote tree is not accepted as a complete branch inventory', async () => {
  const api = remote(artifact()); previousTree(api).truncated = true;
  await assert.rejects(existingArtifact(api.request, api.state.head), /Incomplete gh-pages tree response/);
  assert.deepEqual(mutations(api), []);
});

// Keep the original publication fixtures and cases unchanged. Only this helper
// makes a self-consistent historical identity fixture with new byte/blob pins.
const historicalScope = 'Temporary text preview; no local server or provider';
function artifactWithIdentity(label, fields, extraMembers = []) {
  const plan = artifact(label);
  plan.identity = { ...plan.identity, ...fields };
  plan.members.set('build-identity.json', Buffer.from(JSON.stringify(plan.identity) + '\n'));
  for (const [path, bytes] of extraMembers) plan.members.set(path, bytes);
  const manifest = { schema: 1, kind: 'ideogram-pages-public-artifact-1', identity: plan.identity,
    files: sort([...plan.members].filter(([path]) => path !== 'artifact-manifest.json')
      .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) }))) };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  plan.members.set('artifact-manifest.json', bytes);
  plan.manifestSHA256 = digest(bytes);
  plan.files = sort([...plan.members].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes), gitSHA: blobHash(bytes) })));
  return plan;
}

test('an exact historical text-demo distribution can advance to the current editor artifact', async () => {
  const profile = ['assets/profile-abcdefgh.json', Buffer.from('{"fixture":"sealed-profile"}\n')];
  const prior = artifactWithIdentity('historical-text-demo', { scope: historicalScope }), current = artifactWithIdentity('current-editor', {}, [profile]);
  const api = remote(prior), parent = api.state.head;
  assert.notEqual(prior.identity.scope, current.identity.scope);
  const result = await publish(current, api);
  assert.equal(result.action, 'fast-forward'); assert.equal(result.previousArtifactCommit, parent);
  assert.equal(result.sourceCommit, current.identity.commit);
  assert.deepEqual(api.commits.get(result.artifactCommit).parents, [{ sha: parent }]);
  assert.deepEqual(refMutations(api).map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'PATCH', path: '/git/refs/heads/gh-pages', body: { sha: result.artifactCommit, force: false } },
  ]);
  assert.deepEqual(previousTree(api).tree.filter(row => row.type === 'blob').map(row => row.path).sort(), current.files.map(row => row.path).sort());
  assert.deepEqual(api.blobs.get(blobHash(profile[1])), profile[1]);
});

test('historical identity is recognized only by existing-branch admission and cannot admit a new artifact', async () => {
  const prior = artifactWithIdentity('historical-text-demo', { scope: historicalScope });
  const bytes = prior.members.get('artifact-manifest.json'), manifest = JSON.parse(bytes.toString('utf8'));
  assert.throws(() => manifestRows(manifest, bytes), /Unrecognized gh-pages artifact manifest/);
  assert.throws(() => manifestRows(manifest, bytes, { historical: false }), /Unrecognized gh-pages artifact manifest/);
  const api = remote(prior), existing = await existingArtifact(api.request, api.state.head);
  assert.equal(existing.sourceCommit, prior.identity.commit);
  assert.deepEqual(mutations(api), []);
  const profile = ['assets/profile-abcdefgh.json', Buffer.from('{"fixture":"sealed-profile"}\n')];
  const current = artifactWithIdentity('current-editor', {}, [profile]), currentBytes = current.members.get('artifact-manifest.json');
  assert.equal(manifestRows(JSON.parse(currentBytes.toString('utf8')), currentBytes).length, current.files.length);
  for (const path of ['assets/settings.json', 'assets/profile-short.json', 'assets/profile-abcdefghi.json']) {
    const invalid = artifactWithIdentity('unknown-json', {}, [[path, profile[1]]]);
    const invalidBytes = invalid.members.get('artifact-manifest.json');
    assert.throws(() => manifestRows(JSON.parse(invalidBytes.toString('utf8')), invalidBytes), /Invalid gh-pages public artifact member/);
    const refused = remote(invalid), head = refused.state.head;
    await assert.rejects(publish(current, refused), /foreign/);
    assert.equal(refused.state.head, head); assert.deepEqual(mutations(refused), []);
  }
});

test('historical compatibility refuses broad scopes or changed identity fields before any remote mutation', async () => {
  for (const fields of [
    { scope: historicalScope + '; remote editing enabled' }, { scope: 'Any editor preview' },
    { scope: historicalScope, product: 'Other product' }, { scope: historicalScope, schema: 2 },
    { scope: historicalScope, base: '/' }, { scope: historicalScope, extra: true },
    { scope: historicalScope, commit: 'main' }, { scope: historicalScope, builtAt: '2026-10-03' },
  ]) {
    const prior = artifactWithIdentity('changed-historical-identity', fields), api = remote(prior), head = api.state.head;
    await assert.rejects(publish(artifact('current-editor'), api));
    assert.equal(api.state.head, head); assert.deepEqual(mutations(api), [], JSON.stringify(fields));
  }
});

// The prior markerless fixtures remain byte-exact. Exercise the real remote
// admission and publication flow with a single additional empty public member.
test('both recognized markerless distributions can fast-forward to an empty-marker artifact', async () => {
  for (const fields of [{}, { scope: historicalScope }]) {
    const prior = artifactWithIdentity('markerless-prior', fields);
    const current = artifactWithIdentity('prebuilt-current', {}, [['.nojekyll', Buffer.alloc(0)]]);
    const api = remote(prior), parent = api.state.head;
    const bytes = current.members.get('artifact-manifest.json');
    assert.ok(manifestRows(JSON.parse(bytes.toString('utf8')), bytes).some(row => row.path === '.nojekyll' && row.bytes === 0 && row.sha256 === digest(Buffer.alloc(0))));
    const result = await publish(current, api);
    assert.equal(result.action, 'fast-forward');
    assert.deepEqual(api.commits.get(result.artifactCommit).parents, [{ sha: parent }]);
    assert.deepEqual(refMutations(api).map(({ method, path, body }) => ({ method, path, body })), [
      { method: 'PATCH', path: '/git/refs/heads/gh-pages', body: { sha: result.artifactCommit, force: false } },
    ]);
    const marker = previousTree(api).tree.find(row => row.path === '.nojekyll');
    assert.deepEqual(marker, { path: '.nojekyll', type: 'blob', mode: '100644', sha: blobHash(Buffer.alloc(0)), size: 0 });
    assert.deepEqual(api.blobs.get(marker.sha), Buffer.alloc(0));
    assert.deepEqual(previousTree(api).tree.filter(row => row.type === 'blob').map(row => row.path).sort(), current.files.map(row => row.path).sort());
  }
});

test('an identical empty-marker artifact remains a verified publication no-op', async () => {
  const current = artifactWithIdentity('prebuilt-current', {}, [['.nojekyll', Buffer.alloc(0)]]);
  const api = remote(current), head = api.state.head;
  const result = await publish(current, api);
  assert.equal(result.action, 'unchanged'); assert.equal(result.artifactCommit, head);
  assert.equal(current.reverifications, 1); assert.deepEqual(mutations(api), []);
});

test('manifest admission refuses nonempty or falsely pinned nojekyll and unrelated hidden paths', () => {
  const plan = artifactWithIdentity('prebuilt-current', {}, [['.nojekyll', Buffer.alloc(0)]]);
  const manifest = JSON.parse(plan.members.get('artifact-manifest.json').toString('utf8'));
  for (const change of [{ bytes: 1 }, { sha256: digest(Buffer.from('\n')) },
    { path: 'assets/.nojekyll' }, { path: '.nojekyll.txt' }, { path: '.hidden' }]) {
    const value = structuredClone(manifest);
    Object.assign(value.files.find(row => row.path === '.nojekyll'), change);
    const bytes = Buffer.from(JSON.stringify(value));
    for (const historical of [false, true])
      assert.throws(() => manifestRows(value, bytes, { historical }), /Invalid .*member/);
  }
});

test('remote nojekyll must be an ordinary empty declared blob before any mutation', async () => {
  const current = artifactWithIdentity('prebuilt-current', {}, [['.nojekyll', Buffer.alloc(0)]]);
  for (const change of [{ size: 1 }, { sha: blobHash(Buffer.from('\n')) }, { mode: '120000' }, { type: 'tree', mode: '040000' }]) {
    const api = remote(current), head = api.state.head;
    Object.assign(previousTree(api).tree.find(row => row.path === '.nojekyll'), change);
    await assert.rejects(publish(current, api), /Invalid empty Pages|foreign/);
    assert.equal(api.state.head, head); assert.deepEqual(mutations(api), []);
  }
  const api = remote(artifact('undeclared-marker')), head = api.state.head;
  previousTree(api).tree.push({ path: '.nojekyll', type: 'blob', mode: '100644', sha: blobHash(Buffer.alloc(0)), size: 0 });
  await assert.rejects(publish(current, api), /outside its recognized manifest/);
  assert.equal(api.state.head, head); assert.deepEqual(mutations(api), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdentity, sealArtifact, verifyArtifact } from '../../tooling/pages/artifact.mjs';
import { verifyOfflineGraph } from '../../tooling/pages/build.mjs';

const commit = 'a'.repeat(40), builtAt = '2026-10-03T12:00:00.000Z';
const pin = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const json = value => JSON.stringify(value, null, 2) + '\n';
const profileAsset = 'assets/profile-abcdefgh.json';
const offlineGraph = () => ['pages/main.ts', 'pages/text-demo.ts', 'pages/offline-session-client.ts',
  'src/ui/shell.ts', 'src/state/editor-client.ts', 'src/text/client.ts', 'src/text/worker.ts',
  'src/theme/shell.css', 'node_modules/lit/index.js'].map(path => ({ path }));

test('the actual build graph requires the offline shim and complete production UI and native text paths', () => {
  const graph = offlineGraph(), boundary = verifyOfflineGraph(graph);
  assert.equal(boundary.kind, 'ideogram-pages-offline-graph-1');
  assert.equal(boundary.mode, 'disconnected');
  assert.deepEqual(boundary.modules, graph.map(row => row.path).sort());
  for (const missing of graph.filter(row => !row.path.startsWith('node_modules/')))
    assert.throws(() => verifyOfflineGraph(graph.filter(row => row !== missing)), /Required production browser slice absent/, missing.path);
});

test('the actual build graph refuses live session, private modules and malformed inventories', () => {
  for (const path of ['src/main.ts', 'src/state/session-client.ts', 'server/session.ts', 'tests/private-fixture.ts',
    'tooling/pages/build.mjs', 'node:fs'])
    assert.throws(() => verifyOfflineGraph([...offlineGraph(), { path }]), /Private or live session module/, path);
  for (const path of ['../private.ts', 'pages/../src/state/session-client.ts', '/src/ui/shell.ts', 'pages\\main.ts', 'pages//main.ts'])
    assert.throws(() => verifyOfflineGraph([...offlineGraph(), { path }]), /Invalid Pages module inventory/, path);
  for (const rows of [null, [], [{ path: null }], [{ path: 'x'.repeat(1025) }], Array.from({ length: 4097 }, () => ({ path: 'pages/main.ts' }))])
    assert.throws(() => verifyOfflineGraph(rows), /Invalid Pages module inventory/);
});

// These deliberately tiny synthetic inputs exercise the real artifact sealer.
// They are no claim about a built renderer, browser behavior or qualification.
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pages-artifact-unit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'public-artifact'), identity = buildIdentity(commit, builtAt);
  for (const path of ['tooling/pages', 'src/text', 'public-artifact/assets', 'public-artifact/notices'])
    await mkdir(join(root, path), { recursive: true });
  const notice = Buffer.from('Synthetic public notice fixture\n');
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), font = Buffer.from('synthetic-font-input');
  await writeFile(join(root, 'tooling/pages/NOTICES.txt'), notice);
  await writeFile(join(root, 'tooling/pages/notices.json'), json({ schema: 1, files: [
    { source: 'tooling/pages/NOTICES.txt', path: 'notices/index.txt', ...pin(notice) },
  ] }));
  const profileBytes = Buffer.from(json({ engine: { wasm: pin(wasm) }, fonts: [pin(font)] }));
  await writeFile(join(root, 'src/text/profile.json'), profileBytes);
  const members = new Map([
    ['index.html', Buffer.from('<meta http-equiv="Content-Security-Policy" content="connect-src &#39;none&#39;"><script type="module" src="/ideogram-editor/assets/editor.js"></script>')],
    ['build-identity.json', Buffer.from(json(identity))],
    ['assets/editor.js', Buffer.from('export const disconnected = true;\n')],
    ['assets/editor.css', Buffer.from('body { color: black; }\n')],
    ['assets/renderer.wasm', wasm], ['assets/font.woff2', font], [profileAsset, profileBytes], ['notices/index.txt', notice],
  ]);
  for (const [path, bytes] of members) await writeFile(join(directory, path), bytes);
  return { root, directory, identity, members,
    write: (path, bytes) => writeFile(join(directory, path), bytes),
    seal: () => sealArtifact(root, directory, identity),
    verify: () => verifyArtifact(root, directory, commit),
  };
}

test('Pages identity describes the disconnected editor and native demo without claiming a local service', () => {
  const identity = buildIdentity(commit, builtAt);
  assert.equal(identity.scope, 'Disconnected editor UI and temporary native text demo; no local server or provider');
  assert.equal(identity.commit, commit); assert.equal(identity.builtAt, builtAt);
  assert.equal(identity.base, '/ideogram-editor/');
  for (const [revision, date] of [['main', builtAt], [commit, '2026-10-03'], [commit, '2026-02-30T12:00:00.000Z']])
    assert.throws(() => buildIdentity(revision, date));
});

test('real Pages sealing and verification retain the exact public file identities', async t => {
  const value = await fixture(t), sealed = await value.seal(), verified = await value.verify();
  assert.deepEqual(verified, sealed);
  assert.deepEqual(sealed.files, [...value.members].map(([path, bytes]) => ({ path, ...pin(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path)));
  assert.deepEqual(sealed.identity, value.identity);
  await assert.rejects(verifyArtifact(value.root, value.directory, 'b'.repeat(40)), /Invalid public artifact identity/);
  await assert.rejects(value.seal(), /EEXIST/);
  // Public JSON is the single raw source profile, not any JSON with that name.
  await rm(join(value.directory, profileAsset));
  await assert.rejects(value.verify(), /Public native profile differs/);
  await value.write(profileAsset, value.members.get(profileAsset));
  await value.write('assets/profile-ijklmnop.json', value.members.get(profileAsset));
  await assert.rejects(value.verify(), /Public native profile differs/);
  await rm(join(value.directory, 'assets/profile-ijklmnop.json'));
  const changedProfile = Buffer.from(value.members.get(profileAsset));
  changedProfile[changedProfile.length - 1] = 32; // Same byte length, different valid JSON whitespace.
  await value.write(profileAsset, changedProfile);
  await assert.rejects(value.verify(), /Public native profile differs/);
  await value.write(profileAsset, value.members.get(profileAsset));
  for (const path of ['assets/settings.json', 'assets/profile-short.json', 'assets/profile-abcdefghi.json']) {
    await value.write(path, value.members.get(profileAsset));
    await assert.rejects(value.verify(), /Unapproved public artifact/, path);
    await rm(join(value.directory, path));
  }
  await value.verify();
});

test('API literals are admitted only in JavaScript while other public text retains the backend guard', async t => {
  const value = await fixture(t);
  await value.write('assets/editor.js', 'export const inactiveCommandPath = "/api/v1/commands";\n');
  await value.seal(); await value.verify();
  for (const [path, content] of [
    ['index.html', '<!-- /api/v1/commands -->'],
    ['assets/editor.css', '/* /api/v1/commands */'],
    ['build-identity.json', json({ ...value.identity, scope: '/api/v1/commands' })],
    [profileAsset, json({ endpoint: '/api/v1/commands' })],
    ['assets/icon.svg', '<svg><desc>/api/v1/commands</desc></svg>'],
  ]) {
    const refused = await fixture(t);
    await refused.write(path, content);
    await assert.rejects(refused.seal(), /Backend path outside a public JS declaration/, path);
  }
  await value.verify();
});

test('JavaScript retains private path, report, loopback, provider, credential and source-map bans', async t => {
  const value = await fixture(t);
  const markers = ['sourceMappingURL=editor.js.map', '/Users/example/project', '/private/tmp/project',
    '.progress-report/project.json', '127.0.0.1', 'localhost', 'fal.run', 'queue.fal.run',
    'sk-proj-example', '-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----'];
  for (const marker of markers) {
    await value.write('assets/editor.js', `export const forbidden = ${JSON.stringify(marker)};\n`);
    await assert.rejects(value.seal(), /Private, backend, credential or map marker/, marker);
    await value.write('assets/editor.js', value.members.get('assets/editor.js'));
    await value.write(profileAsset, json({ forbidden: marker }));
    await assert.rejects(value.seal(), /Private, backend, credential or map marker/, marker);
    await value.write(profileAsset, value.members.get(profileAsset));
  }
  await value.write('assets/editor.js', value.members.get('assets/editor.js'));
  await value.seal(); await value.verify();
});

test('a sealed distribution refuses changed JavaScript bytes and identity before reuse', async t => {
  const value = await fixture(t); await value.seal();
  const retained = await readFile(join(value.directory, 'artifact-manifest.json'));
  await value.write('assets/editor.js', 'export const disconnected = false;\n');
  await assert.rejects(value.verify(), /Public artifact changed after sealing/);
  assert.deepEqual(await readFile(join(value.directory, 'artifact-manifest.json')), retained);
  await value.write('assets/editor.js', value.members.get('assets/editor.js'));
  await value.write('build-identity.json', json({ ...value.identity, commit: 'b'.repeat(40) }));
  await assert.rejects(value.verify(), /Public artifact changed after sealing/);
  await value.write('build-identity.json', value.members.get('build-identity.json'));
  await value.verify();
});

// Historical markerless artifacts above remain recognized. New prebuilt output
// includes only this empty root marker, covered by the ordinary manifest seal.
test('empty root nojekyll is sealed exactly and cannot disappear after sealing', async t => {
  const value = await fixture(t);
  await value.write('.nojekyll', Buffer.alloc(0));
  const sealed = await value.seal();
  assert.deepEqual(sealed.files.find(row => row.path === '.nojekyll'), { path: '.nojekyll', ...pin(Buffer.alloc(0)) });
  assert.deepEqual(await value.verify(), sealed);
  await rm(join(value.directory, '.nojekyll'));
  await assert.rejects(value.verify(), /Public artifact changed after sealing/);
  await value.write('.nojekyll', Buffer.alloc(0));
  assert.deepEqual(await value.verify(), sealed);
});

test('nojekyll refuses every nonempty body including a newline before and after sealing', async t => {
  const value = await fixture(t);
  for (const bytes of [Buffer.from('\n'), Buffer.from('private configuration'), Buffer.from([0])]) {
    await value.write('.nojekyll', bytes);
    await assert.rejects(value.seal(), /Pages \.nojekyll must be empty/);
  }
  await value.write('.nojekyll', Buffer.alloc(0));
  await value.seal();
  await value.write('.nojekyll', '\n');
  await assert.rejects(value.verify(), /Pages \.nojekyll must be empty/);
});

test('nojekyll does not admit linked markers, directories, nested markers or other hidden roots', async t => {
  const value = await fixture(t), outside = join(value.root, 'empty');
  await writeFile(outside, Buffer.alloc(0));
  await symlink(outside, join(value.directory, '.nojekyll'));
  await assert.rejects(value.seal(), /Non-regular public artifact/);
  await rm(join(value.directory, '.nojekyll'));
  await mkdir(join(value.directory, '.nojekyll'));
  await assert.rejects(value.seal(), /Unexpected artifact directory/);
  await rm(join(value.directory, '.nojekyll'), { recursive: true });
  for (const path of ['assets/.nojekyll', '.nojekyll.txt', '.hidden']) {
    await value.write(path, Buffer.alloc(0));
    await assert.rejects(value.seal(), /Unapproved public artifact/, path);
    await rm(join(value.directory, path));
  }
  await value.seal(); await value.verify();
});

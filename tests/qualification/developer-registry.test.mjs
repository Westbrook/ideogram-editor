import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registryObjects, browserDownloadObjects, registryNetwork, verifyRegistry, serveRegistry} from '../../tooling/qualification/developer-campaigns/registry.mjs';
import {sha256, json} from '../../tooling/qualification/developer-campaigns/common.mjs';

const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const lock = entries => ({lockfileVersion: 3, packages: Object.fromEntries(entries.map(([name, resolved, integrity]) => [`node_modules/${name}`, {resolved, integrity}]))});
async function fixture(t, content = Buffer.from('immutable package fixture')) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'developer-registry-test-')); t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(join(directory, 'objects'));
  const bytes = content, url = 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', path = `objects/${sha256(url)}.tgz`;
  await writeFile(join(directory, path), bytes);
  const manifest = {kind: 'developer-registry-fixture-1', lockSha256: sha256('lock'), network: registryNetwork,
    objects: [{url, route: '/fixture/-/fixture-1.0.0.tgz', path, bytes: bytes.length, sha256: sha256(bytes), integrity: integrity(bytes)}]};
  await writeFile(join(directory, 'manifest.json'), json(manifest)); await writeFile(join(directory, 'manifest.sha256'), sha256(json(manifest)) + '\n');
  return {directory, manifest, bytes};
}
test('registry capture inventory retains each exact public lock integrity and excludes local vendor archives', () => {
  const value = lock([['a', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity('a')], ['b', 'file:vendor/b.tgz', undefined]]);
  assert.equal(registryObjects(value).length, 1);
  assert.throws(() => registryObjects(lock([['a', 'https://unowned.example/a.tgz', integrity('a')]])), /Non-public/);
  assert.throws(() => registryObjects(lock([['a', 'https://user:secret@registry.npmjs.org/a.tgz', integrity('a')]])), /Non-public/);
  assert.throws(() => registryObjects(lock([['a', 'https://registry.npmjs.org/a.tgz', 'sha1-short']])), /SHA-512/);
});
test('one registry route cannot carry conflicting immutable package identities', () => {
  assert.throws(() => registryObjects(lock([['a', 'https://registry.npmjs.org/a.tgz', integrity('a')], ['b', 'https://registry.npmjs.org/a.tgz', integrity('b')]])), /Conflicting/);
});
test('browser fixture uses exact CLI primary/override routes and rejects mismatched or arbitrary hosts', () => {
  const source = 'Chromium\n  Download url:        https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1243/chromium-linux.zip\n';
  const override = 'Chromium\n  Download url:        http://127.0.0.1:1/builds/chromium/1243/chromium-linux.zip\n';
  assert.equal(browserDownloadObjects(source, override)[0].route, '/builds/chromium/1243/chromium-linux.zip');
  assert.throws(() => browserDownloadObjects(source, ''), /inventory mismatch/);
  assert.throws(() => browserDownloadObjects(source.replace('cdn.playwright.dev', 'attacker.example'), override), /Unapproved/);
  assert.throws(() => browserDownloadObjects(source, override.replace('127.0.0.1:1', 'localhost:1')), /Uncontrolled/);
});
test('fixture validation binds lock, SHA-512 payload and complete manifest seal', async t => {
  const f = await fixture(t); assert.equal((await verifyRegistry(f.directory, f.manifest.lockSha256)).manifest.objects.length, 1);
  await assert.rejects(verifyRegistry(f.directory, sha256('other')), /different lock/);
  await writeFile(join(f.directory, f.manifest.objects[0].path), 'replacement'); await assert.rejects(verifyRegistry(f.directory), /integrity mismatch/);
});
test('N fixture transfers retained bytes over literal loopback and seals actual request spans', async t => {
  const f = await fixture(t), output = join(f.directory, 'service.json');
  const service = await serveRegistry({directory: f.directory, lockSha256: f.manifest.lockSha256, output});
  try {
    assert.match(service.origin, /^http:\/\/127\.0\.0\.1:/);
    const response = await fetch(service.origin + f.manifest.objects[0].route);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    assert.equal((await fetch(service.origin + '/missing')).status, 404);
  } finally { await service.close(); }
  const receiptBytes = await readFile(output), receipt = JSON.parse(receiptBytes);
  assert.equal((await readFile(output + '.sha256', 'utf8')).trim(), sha256(receiptBytes));
  assert.equal(receipt.requests[0].bytes, f.bytes.length); assert(receipt.requests[0].elapsedMs >= 35);
  assert.equal(receipt.qualification, false); assert.equal(receipt.network.downBitsPerSecond, 100000000);
});
test('atomic replacement during N transfer cannot complete a successful sealed response', async t => {
  const f = await fixture(t, Buffer.alloc(2 * 1024 * 1024, 37)), output = join(f.directory, 'replaced-service.json');
  const service = await serveRegistry({directory: f.directory, output});
  try {
    const response = await fetch(service.origin + f.manifest.objects[0].route), replacement = join(f.directory, 'replacement');
    await writeFile(replacement, f.bytes);
    await rename(replacement, join(f.directory, f.manifest.objects[0].path));
    await assert.rejects(response.arrayBuffer());
  } finally { await service.close(); }
  const receipt = JSON.parse(await readFile(output));
  assert.equal(receipt.status, 'failed'); assert.match(receipt.requests[0].error, /Fixture changed during response/);
  assert(receipt.requests[0].bytes < f.bytes.length);
});

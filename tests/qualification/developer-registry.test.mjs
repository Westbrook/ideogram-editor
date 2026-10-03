import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename, lstat, copyFile, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registryObjects, browserDownloadObjects, registryNetwork, verifyRegistry, serveRegistry, captureRegistry, parseRegistryOptions} from '../../tooling/qualification/developer-campaigns/registry.mjs';
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

async function workspace(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'developer-registry-union-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}
async function unionInputs(t) {
  const directory = await workspace(t);
  const payloads = new Map(['producer', 'consumer', 'shared'].map(name => [`https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, Buffer.from('immutable ' + name)]));
  const entry = name => { const url = `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`; return [name, url, integrity(payloads.get(url))]; };
  const producer = lock([entry('producer'), entry('shared')]), consumer = lock([entry('consumer'), entry('shared')]);
  producer.packages['node_modules/@en-reve/tokens'] = {resolved: 'packages/tokens', link: true};
  producer.packages['packages/tokens'] = {name: '@en-reve/tokens', version: '0.1.0'};
  const files = [join(directory, 'producer-lock.json'), join(directory, 'consumer-lock.json')];
  await writeFile(files[0], json(producer)); await writeFile(files[1], json(consumer));
  const identities = await Promise.all(files.map(async path => { const bytes = await readFile(path); return {path, bytes: bytes.length, sha256: sha256(bytes)}; }));
  return {directory, files, identities: identities.sort((a, b) => a.path < b.path ? -1 : 1), producer, consumer, payloads, output: join(directory, 'capture')};
}
async function capturedUnion(t) {
  const f = await unionInputs(t), fetched = [];
  const mocked = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error'); assert(f.payloads.has(url)); fetched.push(url);
    return new Response(f.payloads.get(url));
  });
  try { f.receipt = await captureRegistry({lockfiles: f.files, output: f.output}); }
  finally { mocked.mock.restore(); }
  f.fetched = fetched; f.hashes = f.identities.map(identity => identity.sha256);
  return f;
}
async function rewriteManifest(directory, manifest) {
  const bytes = json(manifest);
  await writeFile(join(directory, 'manifest.json'), bytes);
  await writeFile(join(directory, 'manifest.sha256'), sha256(bytes) + '\n');
}

test('workspace links resolve only to canonical local in-lock non-link packages', () => {
  const value = lock([['public', 'https://registry.npmjs.org/public/-/public-1.0.0.tgz', integrity('public')]]);
  value.packages['node_modules/@scope/local'] = {resolved: 'packages/local', link: true};
  value.packages['packages/local'] = {name: '@scope/local', version: '1.0.0'};
  assert.equal(registryObjects(value).length, 1);
  value.packages['packages/local'].link = false;
  assert.equal(registryObjects(value).length, 1);
  delete value.packages['packages/local'].link;
  for (const target of [undefined, '', '.', '..', '/packages/local', '../packages/local', 'packages/../local', 'packages//local', './packages/local', 'packages/local/', 'packages\\local', 'file:packages/local', 'https://registry.npmjs.org/local', 'packages/local?x', 'packages/local#x', 'packages/%2elocal', 'packages/lo\ncal', 'packages/missing']) {
    const changed = structuredClone(value); changed.packages['node_modules/@scope/local'].resolved = target;
    assert.throws(() => registryObjects(changed), /workspace link/i);
  }
  for (const target of [null, [], {link: true, resolved: 'packages/next'}, {link: 'false'}, {resolved: 'https://registry.npmjs.org/local/-/local-1.0.0.tgz'}, {resolved: 'file:elsewhere'}]) {
    const changed = structuredClone(value); changed.packages['packages/local'] = target;
    assert.throws(() => registryObjects(changed), /workspace link/i);
  }
  const inherited = structuredClone(value); delete inherited.packages['packages/local'];
  Object.setPrototypeOf(inherited.packages, {'packages/local': {version: '1.0.0'}});
  assert.throws(() => registryObjects(inherited), /workspace link/i);
  for (const link of [1, 'true', null]) { const changed = structuredClone(value); changed.packages['node_modules/@scope/local'].link = link; assert.throws(() => registryObjects(changed), /workspace link/i); }
});

test('multi-lock capture retains both exact inputs and fetches the complete deduplicated union', async t => {
  const f = await capturedUnion(t);
  assert.equal(f.receipt.kind, 'developer-registry-capture-2'); assert.equal(f.receipt.status, 'captured'); assert.equal(f.receipt.qualification, false);
  assert.deepEqual(f.receipt.locks, f.identities);
  assert.deepEqual(f.fetched.sort(), [...f.payloads.keys()].sort());
  const bytes = await readFile(join(f.output, 'manifest.json')), manifest = JSON.parse(bytes);
  assert.equal(manifest.kind, 'developer-registry-fixture-2'); assert.deepEqual(manifest.locks, f.identities);
  assert.equal((await readFile(join(f.output, 'manifest.sha256'), 'utf8')).trim(), sha256(bytes));
  assert.equal(manifest.objects.length, 3);
  for (const identity of f.identities) assert.deepEqual(await readFile(join(f.output, 'locks', identity.sha256 + '.json')), await readFile(identity.path));
  assert.deepEqual(JSON.parse(await readFile(join(f.output, 'capture.json'))), f.receipt);
  assert.equal((await verifyRegistry(f.output, f.hashes)).sha256, sha256(bytes));
  await verifyRegistry(f.output, [...f.hashes].reverse());
});

test('ambiguous, duplicate, linked or conflicting lock selections refuse before fetch and output creation', async t => {
  const f = await unionInputs(t), duplicate = join(f.directory, 'duplicate-lock.json'), linked = join(f.directory, 'linked-lock.json');
  await copyFile(f.files[0], duplicate); await symlink(f.files[0], linked);
  const conflict = structuredClone(f.consumer); conflict.packages['node_modules/shared'].integrity = integrity('conflict');
  const conflicting = join(f.directory, 'conflicting-lock.json'); await writeFile(conflicting, json(conflict));
  let calls = 0; const mocked = t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('must not fetch'); });
  try {
    for (const selection of [{lockfile: f.files[0], lockfiles: f.files}, {lockfiles: []}, {lockfiles: f.files.concat(f.files[0])}, {lockfiles: [f.files[0], duplicate]}, {lockfiles: [f.files[0], linked]}, {lockfiles: [f.files[0], conflicting]}]) {
      await assert.rejects(captureRegistry({...selection, output: f.output}));
      await assert.rejects(lstat(f.output), {code: 'ENOENT'});
    }
  } finally { mocked.mock.restore(); }
  assert.equal(calls, 0);
});

test('multi-lock verification requires the complete distinct expected set and exact retained route coverage', async t => {
  const f = await capturedUnion(t);
  for (const expected of [undefined, f.hashes[0], [], [f.hashes[0]], [...f.hashes, f.hashes[0]], [f.hashes[0], sha256('wrong')], [...f.hashes, sha256('additional')]]) {
    await assert.rejects(verifyRegistry(f.output, expected), /lock (hash )?set/);
  }
  const original = JSON.parse(await readFile(join(f.output, 'manifest.json')));
  for (const change of [
    value => value.objects.pop(),
    value => value.locks.reverse(),
    value => value.locks[1].path = value.locks[0].path,
    value => value.locks[1].sha256 = value.locks[0].sha256,
    value => value.locks[0].path = '/noncanonical/../lock.json',
    value => value.locks[0].bytes = -1,
    value => value.locks[0].bytes = 16 * 1024 * 1024 + 1,
    value => value.locks[0].sha256 = 'invalid',
    value => value.lockSha256 = f.hashes[0],
  ]) {
    const changed = structuredClone(original); change(changed); await rewriteManifest(f.output, changed);
    await assert.rejects(verifyRegistry(f.output, f.hashes));
  }
  await rewriteManifest(f.output, original);
  const copy = join(f.output, 'locks', f.hashes[0] + '.json'); await writeFile(copy, json({lockfileVersion: 3, packages: {}}));
  await assert.rejects(verifyRegistry(f.output, f.hashes), /Retained lockfile identity mismatch/);
});

test('one controlled service delivers producer-only and consumer-only routes and binds both real lock identities', async t => {
  const f = await capturedUnion(t), output = join(f.directory, 'service.json');
  await assert.rejects(serveRegistry({directory: f.output, lockSha256s: [f.hashes[0]], output}), /lock hash set/);
  await assert.rejects(serveRegistry({directory: f.output, lockSha256: f.hashes[0], lockSha256s: f.hashes, output}), /one expected lock binding/);
  const service = await serveRegistry({directory: f.output, lockSha256s: [...f.hashes].reverse(), output});
  try {
    for (const [url, bytes] of f.payloads) {
      const response = await fetch(service.origin + new URL(url).pathname);
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
  } finally { await service.close(); }
  const bytes = await readFile(output), receipt = JSON.parse(bytes);
  assert.equal(receipt.kind, 'developer-registry-service-2'); assert.equal(receipt.status, 'served');
  assert.equal(receipt.qualification, false); assert.deepEqual(receipt.locks, f.identities);
  assert.deepEqual(receipt.expectedLockSha256s, [...f.hashes].sort()); assert.deepEqual(receipt.network, registryNetwork);
  assert.equal(receipt.requests.length, 3); assert(receipt.requests.every(request => request.status === 200 && request.bytes > 0 && !request.error));
  assert.equal((await readFile(output + '.sha256', 'utf8')).trim(), sha256(bytes));
});

test('changed original lock during capture retains failure and cannot publish a fixture', async t => {
  const f = await unionInputs(t); let changed = false;
  const mocked = t.mock.method(globalThis, 'fetch', async url => {
    if (!changed) { changed = true; await writeFile(f.files[0], json(f.producer) + '\n'); }
    return new Response(f.payloads.get(url));
  });
  try { await assert.rejects(captureRegistry({lockfiles: f.files, output: f.output}), /Lockfile changed during capture/); }
  finally { mocked.mock.restore(); }
  const receipt = JSON.parse(await readFile(join(f.output, 'capture.json')));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.objects.length, 3); assert.match(receipt.failure, /Lockfile changed/);
  await assert.rejects(lstat(join(f.output, 'manifest.json')), {code: 'ENOENT'});
});

test('failed captured tarball integrity retains partial evidence without a successful manifest', async t => {
  const f = await unionInputs(t); let count = 0;
  const mocked = t.mock.method(globalThis, 'fetch', async url => new Response(++count === 2 ? Buffer.from('corrupt tarball') : f.payloads.get(url)));
  try { await assert.rejects(captureRegistry({lockfiles: f.files, output: f.output}), /Registry integrity mismatch/); }
  finally { mocked.mock.restore(); }
  const receipt = JSON.parse(await readFile(join(f.output, 'capture.json')));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.objects.length, 1); assert.match(receipt.failure, /integrity mismatch/);
  assert.equal((await readFile(join(f.output, receipt.objects[0].path))).length, receipt.objects[0].bytes);
  await assert.rejects(lstat(join(f.output, 'manifest.json')), {code: 'ENOENT'});
});

test('actual single-lock capture and legacy browser fixtures preserve v1 expected-hash behavior', async t => {
  const f = await unionInputs(t);
  const mocked = t.mock.method(globalThis, 'fetch', async url => new Response(f.payloads.get(url)));
  let captured;
  try { captured = await captureRegistry({lockfile: f.files[1], output: f.output}); }
  finally { mocked.mock.restore(); }
  assert.equal(captured.kind, 'developer-registry-capture-1'); assert.equal(captured.locks, undefined);
  const expected = sha256(await readFile(f.files[1]));
  assert.deepEqual(captured.lock, {path: f.files[1], sha256: expected});
  assert.equal((await verifyRegistry(f.output, expected)).manifest.kind, 'developer-registry-fixture-1');
  await verifyRegistry(f.output); await assert.rejects(verifyRegistry(f.output, [expected]), /single expected/);
  const service = await serveRegistry({directory: f.output, lockSha256: expected, output: join(f.directory, 'legacy-service.json')});
  await service.close(); assert.equal(service.receipt.kind, 'developer-registry-service-1'); assert.equal(service.receipt.lockSha256, expected);
  const browserDirectory = join(f.directory, 'browser'); await mkdir(browserDirectory); await mkdir(join(browserDirectory, 'objects'));
  const payload = Buffer.from('captured browser bytes'), url = 'https://cdn.playwright.dev/builds/chromium/1243/chromium-mac.zip', path = `objects/${sha256(url)}.zip`;
  await writeFile(join(browserDirectory, path), payload);
  await rewriteManifest(browserDirectory, {kind: 'developer-browser-download-fixture-1', lockSha256: expected, playwright: '1.63.0', platform: process.platform, arch: process.arch, network: registryNetwork,
    objects: [{url, route: '/builds/chromium/1243/chromium-mac.zip', path, bytes: payload.length, sha256: sha256(payload), integrity: integrity(payload)}]});
  await verifyRegistry(browserDirectory); await verifyRegistry(browserDirectory, expected);
  await assert.rejects(verifyRegistry(browserDirectory, sha256('wrong')), /different lock/);
});

test('registry CLI preserves repeated lock inputs and refuses ambiguous or malformed options', () => {
  assert.deepEqual(parseRegistryOptions(['capture', '--lockfile', 'producer.json', '--lockfile', 'consumer.json', '--output', 'new']), {mode: 'capture', lockfiles: ['producer.json', 'consumer.json'], output: 'new'});
  assert.deepEqual(parseRegistryOptions(['serve', '--fixture', 'captured', '--receipt', 'service.json', '--lockfile', 'consumer.json', '--lockfile', 'producer.json', '--port', '0']), {mode: 'serve', fixture: 'captured', receipt: 'service.json', lockfiles: ['consumer.json', 'producer.json'], port: 0});
  assert.deepEqual(parseRegistryOptions(['capture-browsers', '--source', 'repo', '--output', 'new']), {mode: 'capture-browsers', source: 'repo', output: 'new'});
  for (const args of [[], ['capture', '--output', 'new'], ['capture', '--lockfile'], ['capture', '--lockfile', 'one', '--output', 'new', '--output', 'other'], ['capture', '--lockfile', 'one', '--output', 'new', '--unknown', 'x'], ['capture-browsers', '--source', 'repo', '--output', 'new', '--lockfile', 'one'], ['serve', '--fixture', 'dir', '--receipt', 'out', '--port', '-1'], ['serve', '--fixture', 'dir', '--receipt', 'out', '--port', '65536']]) assert.throws(() => parseRegistryOptions(args));
});

test('multi-lock capture bounds a concurrently growing read and closes shortened inputs before fetch', async t => {
  for (const mode of ['grow', 'shorten']) {
    const f = await unionInputs(t), original = await readFile(f.files[0]);
    const realOpen = fs.promises.open; let reads = 0, closes = 0, fetches = 0;
    const bufferSizes = [];
    const opening = t.mock.method(fs.promises, 'open', async (path, ...options) => {
      const handle = await realOpen(path, ...options);
      if (path !== f.files[0]) return handle;
      return {
        stat: () => handle.stat(),
        read: async (buffer, ...args) => {
          bufferSizes.push(buffer.length);
          if (++reads === 1) await writeFile(path, mode === 'grow' ? Buffer.concat([original, Buffer.from('extra')]) : original.subarray(0, original.length - 1));
          return handle.read(buffer, ...args);
        },
        close: async () => { closes++; await handle.close(); },
      };
    });
    syncBuiltinESMExports();
    const fetched = t.mock.method(globalThis, 'fetch', async () => { fetches++; throw Error('must not fetch'); });
    try {
      await assert.rejects(captureRegistry({lockfiles: f.files, output: f.output}), mode === 'grow' ? /Lockfile grew while reading/ : /Lockfile shortened while reading/);
    } finally { fetched.mock.restore(); opening.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(fetches, 0); assert.equal(closes, 1);
    assert.equal(bufferSizes[0], original.length); assert(bufferSizes.every(length => length <= original.length));
    if (mode === 'grow') assert.equal(bufferSizes.at(-1), 1);
    await assert.rejects(lstat(f.output), {code: 'ENOENT'});
  }
});

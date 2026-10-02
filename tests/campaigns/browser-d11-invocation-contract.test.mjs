import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D11_COMPILATION_INPUT_PATHS, D11_INVOCATION_DEPENDENCY_PATHS, createD11NpmArchiveReader, prepareD11InvocationContract,
  verifyD11CompilationCapture, verifyD11InvocationContract } from '../../tooling/qualification/campaigns/browser-d11-invocation-contract.mjs';
import { D11_APPLICATION_SOURCE_PATHS } from '../../tooling/qualification/campaigns/browser-d11-application-profile.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const MAX_ARCHIVE = 2 * 1024 * 1024;
const identity = (path, bytes) => ({ path, rawBytes: bytes.length, sha256: sha(bytes) });
const shell = () => ({ kind: 'perf-d11-invocation-contract-1', profile: 'd11-export-invocation-1', packages: [] });
let authenticPreparation;

// No import-time reads, npm commands, downloads, or default cache discovery.
// The reviewed profile deliberately cannot be replaced with synthetic hashes.
async function authentic(t) {
  const cacheDirectory = process.env.IE_D11_TEST_NPM_CACHE ?? process.env.IE_D11_NPM_CACHE ?? process.env.npm_config_cache;
  if (!cacheDirectory) {
    t.skip('Authentic reviewed archive cases require explicit IE_D11_TEST_NPM_CACHE, IE_D11_NPM_CACHE, or npm_config_cache; no cache was selected.');
    return null;
  }
  authenticPreparation ??= (async () => {
    const repo = await realpath(resolve(fileURLToPath(new URL('../..', import.meta.url))));
    const repoBytes = new Map();
    const read = async (path, maximum) => {
      if (repoBytes.has(path)) {
        const bytes = repoBytes.get(path);
        if (bytes.length > maximum) throw Error('Authentic fixture input exceeds its bound');
        return { bytes };
      }
      if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Noncanonical authentic fixture path');
      const absolute = join(repo, path);
      if (await realpath(absolute) !== absolute) throw Error('Authentic fixture input traverses a symlink');
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maximum) throw Error('Authentic fixture input exceeds its ordinary-file bound');
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw Error('Authentic fixture input shortened');
          offset += bytesRead;
        }
        const after = await handle.stat(), current = await lstat(absolute);
        if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key] || before[key] !== current[key])) throw Error('Authentic fixture input changed');
        repoBytes.set(path, bytes); return { bytes };
      } finally { await handle.close(); }
    };
    const dependencyInputs = [];
    for (const path of D11_INVOCATION_DEPENDENCY_PATHS) dependencyInputs.push(identity(path, (await read(path, 64 * 1024)).bytes));
    const sourceTextByPath = {}, configInputs = [];
    for (const path of D11_COMPILATION_INPUT_PATHS) {
      const bytes = (await read(path, 64 * 1024)).bytes;
      sourceTextByPath[path] = bytes.toString('utf8'); configInputs.push({ path, bytes: bytes.length, sha256: sha(bytes).slice(7) });
    }
    const sourceInputs = [];
    for (const path of D11_APPLICATION_SOURCE_PATHS) {
      const bytes = (await read(path, 2 * 1024 * 1024)).bytes;
      sourceTextByPath[path] = bytes.toString('utf8'); sourceInputs.push(identity(path, bytes));
    }
    const staticSource = (await read('server/static.ts', 64 * 1024)).bytes.toString('utf8');
    const marker = 'export const BOOTSTRAP_PRELUDE = `', start = staticSource.indexOf(marker);
    assert(start >= 0 && staticSource.indexOf(marker, start + marker.length) < 0);
    const end = staticSource.indexOf('`;', start + marker.length); assert(end > start);
    const bootstrap = staticSource.slice(start + marker.length, end);
    assert(!bootstrap.includes('`') && !bootstrap.includes('\\') && !bootstrap.includes('${'));
    const outputTextByFile = { 'inline:bootstrap': bootstrap };
    // A synthetic capture envelope tests pure consistency against authentic
    // reviewed source. It is not evidence that this test ran a Vite build.
    const compilation = { schema: 1, profile: 'reviewed-vite-app-1', configFile: 'vite.app.config.ts', configLoader: 'bundle',
      command: 'build', mode: 'production', env: { BASE_URL: '/', MODE: 'production', DEV: false, PROD: true }, configInputs,
      inlineTransformOptions: 'none', userPlugins: ['consumer-build-evidence'] };
    const emittedModules = D11_INVOCATION_DEPENDENCY_PATHS.filter(path => path.endsWith('.js'));
    const readArchive = createD11NpmArchiveReader({ cacheDirectory });
    const contract = await prepareD11InvocationContract({ read, readArchive, dependencyInputs, emittedModules, compilation, sourceTextByPath, sourceInputs, outputTextByFile });
    const lock = JSON.parse((await read('package-lock.json', 16 * 1024 * 1024)).bytes.toString('utf8'));
    return { contract, lock, dependencyInputs, emittedModules, compilation, sourceTextByPath, sourceInputs, outputTextByFile, repoBytes: Object.fromEntries(repoBytes) };
  })();
  return structuredClone(await authenticPreparation);
}

const verify = value => verifyD11InvocationContract(value.contract, value);
async function rejectsMutations(t, changes) {
  const original = await authentic(t); if (!original) return;
  for (const [label, change] of changes) {
    const value = structuredClone(original); change(value);
    assert.throws(() => verify(value), Error, label);
  }
}

// Reader specimens below are arbitrary SHA512-addressed bytes in owned temporary
// directories. They test the cache boundary only, never a qualifying contract.
async function localCache(t, bytes = Buffer.from('bounded local cache reader specimen')) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'd11-invocation-cache-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, 'cache'), integrity = sri(bytes), hex = Buffer.from(integrity.slice(7), 'base64').toString('hex');
  const path = join(directory, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
  return { base, directory, path, integrity, bytes, read: createD11NpmArchiveReader({ cacheDirectory: directory }) };
}

test('invocation contract rejects malformed or nonexact top-level fields before dependency reads', () => {
  for (const value of [null, [], {}, { ...shell(), extra: true }, { profile: shell().profile, packages: [] },
    { kind: shell().kind, packages: [] }, { kind: shell().kind, profile: shell().profile },
    { ...shell(), kind: 'other' }, { ...shell(), profile: 'unreviewed-profile' }]) {
    assert.throws(() => verifyD11InvocationContract(value), Error);
  }
  assert.equal(D11_INVOCATION_DEPENDENCY_PATHS.length, 44);
  assert.equal(new Set(D11_INVOCATION_DEPENDENCY_PATHS).size, 44);
  assert(Object.isFrozen(D11_INVOCATION_DEPENDENCY_PATHS));
});

test('invocation preparation requires explicit readers and rejects an oversized lock before archives', async () => {
  await assert.rejects(prepareD11InvocationContract(), /explicit repo and archive readers/);
  await assert.rejects(prepareD11InvocationContract({ read: async () => ({ bytes: Buffer.from('{}') }) }), /explicit repo and archive readers/);
  let archiveReads = 0;
  await assert.rejects(prepareD11InvocationContract({
    read: async (_path, maximum) => ({ bytes: Buffer.alloc(maximum + 1) }),
    readArchive: async () => { archiveReads++; throw Error('Unexpected archive read'); },
  }), /byte bound/);
  assert.equal(archiveReads, 0);
});

test('authentic reviewed archives bind all installed members and emitted production modules', async t => {
  const value = await authentic(t); if (!value) return;
  const before = JSON.stringify(value.contract), result = verify(value);
  assert.equal(result.kind, 'verified-d11-invocation-contract-1');
  assert.equal(result.profile, 'd11-export-invocation-1');
  assert.equal(value.contract.packages.length, 8);
  assert.deepEqual(result.inputs.map(row => row.path).sort(), [...D11_INVOCATION_DEPENDENCY_PATHS]);
  assert.deepEqual([...result.inputs].sort((a, b) => a.path.localeCompare(b.path)),
    [...value.dependencyInputs].sort((a, b) => a.path.localeCompare(b.path)));
  assert.equal(result.localArchiveInputs.length, 2);
  assert(result.localArchiveInputs.every(row => row.path.startsWith('vendor/en-reve/') && row.path.endsWith('.tgz')));
  assert.deepEqual(result.effects, { plainArrowEventBinding: 'stored-until-dispatch', eventInvocation: 'EventPart.handleEvent',
    nativeButtonStartupClick: 'not-dispatched-by-reviewed-own-lifecycle',
    repeatRender: 'eager-key-and-item-render-with-child-part-commit', nativeEditingBridgeStartup: 'no-preview-or-apply-dispatch',
    supportedCompilation: 'reviewed-vite-app-config-and-build-evidence', applicationSourceProfile: 'reviewed-d11-startup-corpus-1',
    treeSelectedKeys: 'immutable-string-array-from-reviewed-value-model' });
  assert.equal(result.applicationSourceProfile.profile, 'reviewed-d11-startup-corpus-1');
  assert.deepEqual(result.compilationInputs.map(row => row.path), [...D11_COMPILATION_INPUT_PATHS]);
  assert.deepEqual(result.requiredAbsentGlobals, ['reactiveElementPolyfillSupport', 'litElementHydrateSupport',
    'litElementPolyfillSupport', 'litHtmlPolyfillSupport']);
  assert.equal(JSON.stringify(value.contract), before);
});

test('reviewed invocation requires the exact application, original index and startup bootstrap', async t => {
  await rejectsMutations(t, [
    ['missing application receipt', value => { delete value.sourceInputs; }],
    ['omitted original index', value => { delete value.sourceTextByPath['index.html']; }],
    ['additional source caller', value => { value.sourceTextByPath['src/unreviewed.ts'] = 'export {};'; }],
    ['self-consistent changed source', value => {
      const path = 'src/ui/shell.ts'; value.sourceTextByPath[path] += '\n';
      Object.assign(value.sourceInputs.find(input => input.path === path), identity(path, Buffer.from(value.sourceTextByPath[path])));
    }],
    ['omitted bootstrap', value => { delete value.outputTextByFile['inline:bootstrap']; }],
    ['changed startup bootstrap', value => { value.outputTextByFile['inline:bootstrap'] += '\n'; }],
  ]);
});

test('reviewed compilation cannot be replaced by another config, plugin or ambient transform input', async t => {
  await rejectsMutations(t, [
    ['missing compilation capture', value => { delete value.compilation; }],
    ['different actual config', value => { value.compilation.configFile = 'other.config.ts'; }],
    ['extra user plugin', value => { value.compilation.userPlugins.push('transform'); }],
    ['inline transform', value => { value.compilation.inlineTransformOptions = 'present'; }],
    ['ambient Vite define', value => { value.compilation.env.VITE_UNSEALED = 'present'; }],
    ['source bytes missing', value => { delete value.sourceTextByPath['vite.app.config.ts']; }],
    ['source config changes', value => { value.sourceTextByPath['vite.app.config.ts'] += '\n'; }],
    ['self-consistent unreviewed plugin source', value => {
      const path = 'tooling/build-evidence.ts'; value.sourceTextByPath[path] += '\n';
      const bytes = Buffer.from(value.sourceTextByPath[path]);
      Object.assign(value.compilation.configInputs.find(input => input.path === path), { bytes: bytes.length, sha256: sha(bytes).slice(7) });
      assert.equal(verifyD11CompilationCapture(value.compilation, value).kind, 'verified-d11-compilation-capture-1');
    }],
  ]);
});

test('reviewed invocation contract rejects omitted, altered or duplicate dependency identities', async t => {
  await rejectsMutations(t, [
    ['missing inventory', value => { delete value.dependencyInputs; }],
    ['omitted member', value => { value.dependencyInputs.pop(); }],
    ['duplicated member', value => { value.dependencyInputs[1] = { ...value.dependencyInputs[0] }; }],
    ['member byte count', value => { value.dependencyInputs[0].rawBytes++; }],
    ['member byte hash', value => { value.dependencyInputs[0].sha256 = sha('different installed member'); }],
    ['extra identity property', value => { value.dependencyInputs[0].extra = true; }],
    ['member path escape', value => { value.dependencyInputs[0].path = '../outside.js'; }],
    ['invented member', value => { value.dependencyInputs[0].path = 'node_modules/lit/unreviewed.js'; }],
    ['fractional byte count', value => { value.dependencyInputs[0].rawBytes = 0.5; }],
  ]);
});

test('reviewed invocation contract requires the emitted browser condition rather than retained unused files', async t => {
  await rejectsMutations(t, [
    ['missing emitted inventory', value => { delete value.emittedModules; }],
    ['omitted runtime member', value => { value.emittedModules.pop(); }],
    ['non-string emitted path', value => { value.emittedModules.push(null); }],
    ['oversized emitted inventory', value => { value.emittedModules = Array(100001).fill('assets/main.js'); }],
    ['development variant', value => { value.emittedModules.push('node_modules/lit-html/development/lit-html.js'); }],
    ['server variant', value => { value.emittedModules.push('node_modules/lit-html/node/lit-html.js'); }],
    ['nested installation', value => { value.emittedModules.push('node_modules/other/node_modules/lit/index.js'); }],
    ['nested scoped installation', value => { value.emittedModules.push('node_modules/other/node_modules/@lit/reactive-element/reactive-element.js'); }],
    ['transformed query variant', value => { value.emittedModules.push('node_modules/lit/index.js?worker'); }],
    ['transformed fragment variant', value => { value.emittedModules.push('node_modules/lit-html/lit-html.js#condition'); }],
    ['replaced reviewed member', value => { value.emittedModules[0] = 'node_modules/lit-html/development/lit-html.js'; }],
  ]);
});

test('reviewed invocation package version, resolution and fixed profile cannot drift', async t => {
  await rejectsMutations(t, [
    ['contract profile', value => { value.contract.profile = 'd11-export-invocation-2'; }],
    ['package omission', value => { value.contract.packages.pop(); }],
    ['package order', value => { value.contract.packages.reverse(); }],
    ['extra package field', value => { value.contract.packages[0].conditions = ['development']; }],
    ['package version', value => { value.contract.packages[0].version = '0.0.0'; }],
    ['package resolution', value => { value.contract.packages[0].resolved = 'file:vendor/unreviewed.tgz'; }],
    ['package lock path', value => { value.contract.packages[0].lockPath = '../node_modules/lit'; }],
    ['lock version', value => { value.lock.packages['node_modules/lit'].version = '0.0.0'; }],
    ['lock resolution', value => { value.lock.packages['node_modules/lit'].resolved += '?condition=development'; }],
    ['linked package', value => { value.lock.packages['node_modules/lit'].link = true; }],
    ['duplicate nested package', value => { value.lock.packages['node_modules/other/node_modules/lit'] = { ...value.lock.packages['node_modules/lit'] }; }],
    ['local root dependency', value => { value.lock.packages[''].dependencies['@en-reve/elements'] = 'file:vendor/other.tgz'; }],
    ['compiler profile', value => { value.lock.packages['node_modules/vite'].version = '0.0.0'; }],
    ['compiler resolution', value => { value.lock.packages['node_modules/vite'].resolved = 'file:other-compiler.tgz'; }],
    ['compiler integrity', value => { value.lock.packages['node_modules/vite'].integrity = sri('unreviewed compiler'); }],
    ['ambiguous compiler identity', value => { value.lock.packages['node_modules/other/node_modules/vite'] = { ...value.lock.packages['node_modules/vite'] }; }],
  ]);
});

test('reviewed invocation archive bytes, canonical encoding and integrity remain inseparable', async t => {
  await rejectsMutations(t, [
    ['non-base64 archive', value => { value.contract.packages[0].archive.data = '!'; }],
    ['base64 whitespace', value => { value.contract.packages[0].archive.data += '\n'; }],
    ['archive encoding', value => { value.contract.packages[0].archive.encoding = 'hex'; }],
    ['archive byte count', value => { value.contract.packages[0].archive.rawBytes++; }],
    ['archive hash', value => { value.contract.packages[0].archive.sha256 = sha('other archive'); }],
    ['package SRI', value => { value.contract.packages[0].integrity = sri('other archive'); }],
    ['lock SRI', value => { value.lock.packages['node_modules/lit'].integrity = sri('other archive'); }],
    ['altered bytes with self-consistent SHA256', value => {
      const archive = value.contract.packages[0].archive, bytes = Buffer.from(archive.data, 'base64');
      bytes[0] ^= 1; archive.data = bytes.toString('base64'); archive.sha256 = sha(bytes); archive.rawBytes = bytes.length;
    }],
    ['oversized encoded archive', value => { value.contract.packages[0].archive.data = 'A'.repeat(Math.ceil(MAX_ARCHIVE / 3) * 4 + 4); }],
    ['extra archive field', value => { value.contract.packages[0].archive.path = '/unrelated/archive.tgz'; }],
  ]);
});

test('reviewed invocation member text and installed provenance cannot be substituted', async t => {
  await rejectsMutations(t, [
    ['member omission', value => { value.contract.packages[0].members.pop(); }],
    ['member text', value => { value.contract.packages[0].members[0].text += '\n'; }],
    ['member hash', value => { value.contract.packages[0].members[0].sha256 = sha('other member'); }],
    ['member byte count', value => { value.contract.packages[0].members[0].rawBytes++; }],
    ['archive path escape', value => { value.contract.packages[0].members[0].memberPath = 'package/../outside.js'; }],
    ['installed path escape', value => { value.contract.packages[0].members[0].installedPath = '../outside.js'; }],
    ['extra member field', value => { value.contract.packages[0].members[0].condition = 'development'; }],
  ]);
});

test('preparation rejects changed installed member bytes and oversized archive acquisition', async t => {
  const value = await authentic(t); if (!value) return;
  const changedPath = 'node_modules/lit/package.json';
  const read = async path => {
    assert(Object.hasOwn(value.repoBytes, path), 'Unretained authentic preparation input');
    const bytes = Buffer.from(value.repoBytes[path]);
    if (path === changedPath) bytes[bytes.length - 1] ^= 1;
    return { bytes };
  };
  const readArchive = async ({ name }) => Buffer.from(value.contract.packages.find(item => item.name === name).archive.data, 'base64');
  await assert.rejects(prepareD11InvocationContract({ ...value, read, readArchive }), /installed member differs/);
  await assert.rejects(prepareD11InvocationContract({ ...value,
    read: async path => ({ bytes: Buffer.from(value.repoBytes[path]) }),
    readArchive: async () => Buffer.alloc(MAX_ARCHIVE + 1),
  }), /byte bound/);
});

test('local npm reader requires explicit canonical cache configuration', () => {
  const absolute = resolve(tmpdir(), 'd11-unused-cache');
  for (const options of [undefined, {}, { cacheDirectory: '' }, { cacheDirectory: null }, { cacheDirectory: 'relative-cache' },
    { cacheDirectory: absolute + '/' }, { cacheDirectory: absolute + '/../outside' }]) {
    assert.throws(() => createD11NpmArchiveReader(options), /explicit absolute canonical directory/);
  }
});

test('local npm reader rejects malformed SRI and invalid bounds before reading a cache', async () => {
  const read = createD11NpmArchiveReader({ cacheDirectory: resolve(tmpdir(), 'd11-cache-that-is-not-opened') });
  for (const integrity of [undefined, '', 'sha256:' + '0'.repeat(64), 'sha512-../outside', 'sha512-' + 'A'.repeat(85) + 'B=='])
    await assert.rejects(read({ integrity }), /request is invalid|integrity is not canonical/);
  for (const maxBytes of [0, -1, 0.5, NaN, Infinity, MAX_ARCHIVE + 1])
    await assert.rejects(read({ integrity: sri('reader specimen'), maxBytes }), /request is invalid/);
});

test('local npm reader returns only bounded bytes with the requested content identity', async t => {
  const cache = await localCache(t);
  assert.deepEqual(await cache.read({ integrity: cache.integrity, maxBytes: cache.bytes.length }), cache.bytes);
  await assert.rejects(cache.read({ integrity: cache.integrity, maxBytes: cache.bytes.length - 1 }), /byte bound/);
  await writeFile(cache.path, Buffer.from('different cache bytes'));
  await assert.rejects(cache.read({ integrity: cache.integrity }), /changed|differs/);
});

test('local npm reader rejects a symlinked cache root', async t => {
  const cache = await localCache(t), link = join(cache.base, 'cache-link');
  await symlink(cache.directory, link, 'dir');
  await assert.rejects(createD11NpmArchiveReader({ cacheDirectory: link })({ integrity: cache.integrity }), /canonical directory/);
});

test('local npm reader rejects symlinked ancestor directories and archive files', async t => {
  const ancestor = await localCache(t), backing = join(ancestor.base, 'cache-backing');
  await rename(join(ancestor.directory, '_cacache'), backing);
  await symlink(backing, join(ancestor.directory, '_cacache'), 'dir');
  await assert.rejects(ancestor.read({ integrity: ancestor.integrity }), /symlink or non-regular/);
  const file = await localCache(t), stored = join(file.base, 'stored-archive');
  await rename(file.path, stored); await symlink(stored, file.path, 'file');
  await assert.rejects(file.read({ integrity: file.integrity }), /symlink or non-regular/);
});

test('local npm reader rejects a directory at the content-addressed archive path', async t => {
  const cache = await localCache(t);
  await rm(cache.path); await mkdir(cache.path);
  await assert.rejects(cache.read({ integrity: cache.integrity }), /symlink or non-regular/);
});

// The selectedKeys effect is admitted only through this exact receiver/getter
// dependency closure, never through a property name or a TypeScript annotation.
const treeSelectionMembers = [
  "node_modules/@en-reve/elements/dist/definitions/tree.js",
  "node_modules/@en-reve/elements/dist/tree.js",
  "node_modules/@en-reve/elements/dist/tree/index.js",
  "node_modules/@en-reve/elements/dist/tree/element.js",
  "node_modules/@en-reve/elements/dist/tree/interaction-controller.js",
  "node_modules/@en-reve/elements/dist/tree/data-controller.js",
  "node_modules/@en-reve/elements/dist/tree/lazy-controller.js",
  "node_modules/@en-reve/elements/dist/tree/move-controller.js",
  "node_modules/@en-reve/elements/dist/internal/child-upgrades.js",
  "node_modules/@en-reve/elements/dist/internal/dom-kind.js",
  "node_modules/@en-reve/primitives/dist/interactions/tree.js",
  "node_modules/@en-reve/primitives/dist/state/value.js",
  "node_modules/@en-reve/primitives/dist/interactions/signal-controller.js",
  "node_modules/@en-reve/primitives/dist/interactions/virtual-collection.js",
  "node_modules/@en-reve/primitives/dist/interactions/scroll-into-view.js",
  "node_modules/signal-polyfill/package.json",
  "node_modules/signal-polyfill/dist/index.js",
  "node_modules/signal-utils/package.json",
  "node_modules/signal-utils/dist/subtle/reaction.ts.js"
];

test('reviewed tree selection effect requires the complete installed and emitted member closure', async t => {
  const original = await authentic(t); if (!original) return;
  assert.equal(treeSelectionMembers.length, 19);
  const pureForwarders = new Set(['node_modules/@en-reve/elements/dist/tree.js', 'node_modules/@en-reve/elements/dist/tree/index.js']);
  for (const path of treeSelectionMembers) {
    assert(D11_INVOCATION_DEPENDENCY_PATHS.includes(path), path);
    const omitted = structuredClone(original);
    omitted.dependencyInputs = omitted.dependencyInputs.filter(input => input.path !== path);
    assert.throws(() => verify(omitted), /dependency input inventory/, 'omitted installed member: ' + path);
    if (path.endsWith('.js') && !pureForwarders.has(path)) {
      const notCompiled = structuredClone(original);
      notCompiled.emittedModules = notCompiled.emittedModules.filter(value => value !== path);
      assert.throws(() => verify(notCompiled), /compiled module graph/, 'uncompiled member: ' + path);
    }
  }
  assert.equal(verify(original).effects.treeSelectedKeys, 'immutable-string-array-from-reviewed-value-model');
});

test('tree getter, model and host consumers cannot authorize altered installed or retained semantics', async t => {
  const paths = [
    'node_modules/@en-reve/elements/dist/tree/element.js',
    'node_modules/@en-reve/primitives/dist/interactions/tree.js',
    'node_modules/@en-reve/primitives/dist/state/value.js',
    'node_modules/@en-reve/elements/dist/tree/data-controller.js',
    'node_modules/@en-reve/primitives/dist/interactions/virtual-collection.js',
    'node_modules/signal-polyfill/dist/index.js',
    'node_modules/signal-utils/dist/subtle/reaction.ts.js',
  ];
  const changes = paths.flatMap(path => [
    ['changed installed bytes: ' + path, value => {
      const input = value.dependencyInputs.find(row => row.path === path);
      input.sha256 = sha('unreviewed selection/model/controller implementation');
    }],
    ['self-consistent retained member and installed receipt: ' + path, value => {
      const member = value.contract.packages.flatMap(packed => packed.members).find(row => row.installedPath === path);
      member.text += '\n// unreviewed selection semantics\n';
      const bytes = Buffer.from(member.text); member.rawBytes = bytes.length; member.sha256 = sha(bytes);
      Object.assign(value.dependencyInputs.find(row => row.path === path), identity(path, bytes));
    }],
  ]);
  changes.push(['caller-supplied effect cannot replace reviewed bytes', value => {
    value.contract.effects = { treeSelectedKeys: 'immutable-string-array-from-reviewed-value-model' };
  }]);
  await rejectsMutations(t, changes);
});

test('tree value and reaction packages remain lock and package-resolution bound', async t => {
  await rejectsMutations(t, ['signal-polyfill', 'signal-utils'].flatMap(name => [
    ['changed version: ' + name, value => { value.lock.packages['node_modules/' + name].version = '0.0.0'; }],
    ['changed resolution: ' + name, value => { value.lock.packages['node_modules/' + name].resolved += '?unreviewed'; }],
    ['nested copy: ' + name, value => {
      value.lock.packages['node_modules/other/node_modules/' + name] = { ...value.lock.packages['node_modules/' + name] };
    }],
    ['changed export metadata: ' + name, value => {
      const member = value.contract.packages.find(packed => packed.name === name).members.find(row => row.installedPath.endsWith('/package.json'));
      const metadata = JSON.parse(member.text); metadata.exports = { '.': './unreviewed.js' };
      member.text = JSON.stringify(metadata); const bytes = Buffer.from(member.text);
      member.rawBytes = bytes.length; member.sha256 = sha(bytes);
      Object.assign(value.dependencyInputs.find(row => row.path === member.installedPath), identity(member.installedPath, bytes));
    }],
  ]));
});

test('tree effect preparation refuses an altered installed getter before accepting its archive contract', async t => {
  const value = await authentic(t); if (!value) return;
  const changedPath = 'node_modules/@en-reve/elements/dist/tree/element.js';
  const read = async (path, maximum) => {
    const retained = value.repoBytes[path]; assert(retained, 'unretained fixture read: ' + path);
    const bytes = path === changedPath ? Buffer.from('export class EnTree { get selectedKeys() { return [() => {}]; } }') : Buffer.from(retained);
    assert(bytes.length <= maximum); return { bytes };
  };
  const readArchive = async ({ name }) => Buffer.from(value.contract.packages.find(packed => packed.name === name).archive.data, 'base64');
  await assert.rejects(prepareD11InvocationContract({ ...value, read, readArchive }), /installed member differs/);
});


test('only the authenticated two-link EnTree reexport chain may be absent from emitted modules', async t => {
  const value = await authentic(t); if (!value) return;
  const root = 'node_modules/@en-reve/elements/dist/';
  const forwarders = [root + 'tree.js', root + 'tree/index.js'];
  value.emittedModules = value.emittedModules.filter(path => !forwarders.includes(path));
  const result = verify(value);
  assert.deepEqual(result.treeForwarding, { kind: 'verified-d11-tree-forwarding-1', exportName: 'EnTree',
    definition: root + 'definitions/tree.js', leaf: root + 'tree/element.js', links: [
      { path: root + 'tree.js', specifier: './tree/index.js', target: root + 'tree/index.js', emitted: false },
      { path: root + 'tree/index.js', specifier: './element.js', target: root + 'tree/element.js', emitted: false },
    ] });
  assert.equal(result.inputs.length, 44);
  for (const path of forwarders) assert(result.inputs.some(input => input.path === path));
  for (const path of [root + 'definitions/tree.js', root + 'tree/element.js', root + 'tree/data-controller.js']) {
    const missing = structuredClone(value); missing.emittedModules = missing.emittedModules.filter(member => member !== path);
    assert.throws(() => verify(missing), /compiled module graph/, 'missing required emitted authority: ' + path);
  }
  for (const path of forwarders) {
    const missing = structuredClone(value); missing.dependencyInputs = missing.dependencyInputs.filter(input => input.path !== path);
    assert.throws(() => verify(missing), /dependency input inventory/, 'forwarder installed bytes remain mandatory');
    const redirected = structuredClone(value);
    const member = redirected.contract.packages.flatMap(packed => packed.members).find(input => input.installedPath === path);
    member.text = "export { UnreviewedTree as EnTree } from './unreviewed.js';";
    const bytes = Buffer.from(member.text); member.sha256 = sha(bytes); member.rawBytes = bytes.length;
    Object.assign(redirected.dependencyInputs.find(input => input.path === path), identity(path, bytes));
    assert.throws(() => verify(redirected), Error, 'a caller-resealed redirect cannot borrow the original forwarding contract');
  }
  const invented = structuredClone(value); invented.contract.forwarders = forwarders;
  assert.throws(() => verify(invented), /contract fields/, 'caller forwarding labels have no authority');
});

test('authenticated button forwarding and tree forwarding compose when all four barrels are omitted', async t => {
  const value = await authentic(t); if (!value) return;
  const root = 'node_modules/@en-reve/elements/dist/';
  const button = [root + 'button.js', root + 'button/index.js'];
  const omitted = [...button, root + 'tree.js', root + 'tree/index.js'];
  value.emittedModules = value.emittedModules.filter(path => !omitted.includes(path));
  const result = verify(value);
  assert.deepEqual(result.buttonForwarding, { kind: 'verified-d11-button-forwarding-1', exportName: 'EnButton',
    definition: root + 'definitions/button.js', leaf: root + 'button/element.js', links: [
      { path: root + 'button.js', specifier: './button/index.js', target: root + 'button/index.js', emitted: false },
      { path: root + 'button/index.js', specifier: './element.js', target: root + 'button/element.js', emitted: false },
    ] });
  assert.equal(result.inputs.length, 44);
  for (const path of omitted) assert(result.inputs.some(input => input.path === path), 'omitted forwarding input retained: ' + path);
  assert(result.treeForwarding.links.every(link => link.emitted === false));
  assert.equal(result.effects.nativeButtonStartupClick, 'not-dispatched-by-reviewed-own-lifecycle');
  assert.equal(result.effects.treeSelectedKeys, 'immutable-string-array-from-reviewed-value-model');
  for (const path of button) {
    const partlyEmitted = structuredClone(value); partlyEmitted.emittedModules.push(path);
    const proof = verify(partlyEmitted);
    assert.deepEqual(proof.buttonForwarding.links.map(link => link.emitted), button.map(member => member === path));
  }
});

test('button forwarding requires every authenticated link and mandatory emitted implementation', async t => {
  const value = await authentic(t); if (!value) return;
  const root = 'node_modules/@en-reve/elements/dist/';
  const forwarders = [root + 'button.js', root + 'button/index.js'];
  value.emittedModules = value.emittedModules.filter(path => !forwarders.includes(path));
  for (const path of [root + 'definitions/button.js', root + 'button/element.js', root + 'button/template.js',
    'node_modules/lit-html/lit-html.js']) {
    const missing = structuredClone(value); missing.emittedModules = missing.emittedModules.filter(member => member !== path);
    assert.throws(() => verify(missing), /compiled module graph/, 'unproved runtime omission remains refused: ' + path);
  }
  for (const path of [root + 'definitions/button.js', ...forwarders, root + 'button/element.js']) {
    const missing = structuredClone(value); missing.dependencyInputs = missing.dependencyInputs.filter(input => input.path !== path);
    assert.throws(() => verify(missing), /dependency input inventory/, 'every chain input remains mandatory: ' + path);
    const changed = structuredClone(value);
    changed.dependencyInputs.find(input => input.path === path).sha256 = sha('unreviewed implementation');
    assert.throws(() => verify(changed), /compiled dependency member/, 'installed bytes cannot borrow archived forwarding: ' + path);
  }
  for (const [path, text] of [
    [root + 'button.js', "export { UnreviewedButton as EnButton } from './unreviewed.js';"],
    [root + 'button/index.js', "export { EnButton } from './element.js'; globalThis.sideEffect = true;"],
    [root + 'definitions/button.js', "export const buttonDefinition = { tagName: 'en-button', elementClass: OtherButton };"],
  ]) {
    const changed = structuredClone(value);
    const member = changed.contract.packages.flatMap(packed => packed.members).find(input => input.installedPath === path);
    member.text = text; const bytes = Buffer.from(text); member.rawBytes = bytes.length; member.sha256 = sha(bytes);
    Object.assign(changed.dependencyInputs.find(input => input.path === path), identity(path, bytes));
    assert.throws(() => verify(changed), /member provenance/, 'caller-resealed forwarding semantics stay unauthorized: ' + path);
  }
  const invented = structuredClone(value); invented.contract.buttonForwarding = { links: forwarders };
  assert.throws(() => verify(invented), /contract fields/, 'caller-provided forwarding authority is refused');
});

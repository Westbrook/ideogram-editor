import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readD11RegistrationArchiveMember } from './browser-d11-registration.mjs';
import { verifyD11ApplicationProfile } from './browser-d11-application-profile.mjs';

const PROFILE = 'd11-export-invocation-1';
const SOURCE = '37341d7a644cdfb37e6ba06d5c051e560306417d61a80705558bd78bd0c02cc4';
const MAX_ARCHIVE = 2 * 1024 * 1024, MAX_MEMBER = 64 * 1024, MAX_LOCK = 16 * 1024 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const equal = (actual, expected, label) => { if (!isDeepStrictEqual(actual, expected)) throw Error('D11 invocation ' + label + ' differs'); };
const decoder = new TextDecoder('utf-8', { fatal: true });
export const D11_COMPILATION_INPUT_PATHS = Object.freeze(['.progress-report/project.json', 'tooling/build-evidence.ts', 'vite.app.config.ts']);
const REVIEWED_COMPILATION = [
  { path: 'vite.app.config.ts', rawBytes: 459, sha256: 'sha256:1254165ea4fb9b0cc2a83552b3f87c9132d45225e38959f11ce99f6130e89c4a' },
  { path: 'tooling/build-evidence.ts', rawBytes: 14643, sha256: 'sha256:8dea77e7b87e497a94066147a6dbee44a2274edc07a1546a4808ee7ba8b1e668' },
];

// These are reviewed production members, not package-name exemptions. Runtime
// sources are retained with their npm archives and independently bound to the
// finalized build's dependency inputs. Development/SSR variants cannot stand in
// for these browser implementations.
const PACKAGES = [
  { name: 'lit', version: '3.3.3', integrity: 'sha512-fycuvZg/hkpozL00lm1pEJH5nN/lr9ZXd6mJI2HSN4+Bzc+LDNdEApJ6HFbPkdFNHLvOplIIuJvxkS4XUxqirw==', members: [
    ['package.json', 10758, 'b96d657d4a2e94394569b6a0f25881a4e4908a2682094d20d3b251ef7e1198a6'],
    ['index.js', 157, 'b1993a57ee9b162bc5af6b2f4bc44623c0bd3496be5119c83d5325b04093b65c'],
    ['directives/repeat.js', 79, '1dd0dea44a8f3c956689a92360a16ccd7a412091c24906d5066196be45168ca0'],
  ] },
  { name: 'lit-element', version: '4.2.2', integrity: 'sha512-aFKhNToWxoyhkNDmWZwEva2SlQia+jfG0fjIWV//YeTaWrVnOxD89dPKfigCUspXFmjzOEUQpOkejH5Ly6sG0w==', members: [
    ['package.json', 7887, '30f4bdf2fa9f991060faa0b1e54fde10fe8923bf339aea38dfbfafa14e16928d'],
    ['lit-element.js', 1124, 'ee09e38303bb39c36959a961fb0a52663c798ee44493914472c3a61e84e55e3c'],
  ] },
  { name: 'lit-html', version: '3.3.3', integrity: 'sha512-el8M6jK2o3RXBnrSHX3ZKrsN8zEV63pSExTO1wYJz7QndGYZ8353e2a5PPX+qHe2aGayfnchQmkAojaWAREOIA==', members: [
    ['package.json', 20151, '9c0052af049941508481d808ff092dc8b9077faa58dad60316c24832089487e6'],
    ['lit-html.js', 7309, 'b878e7f95dec8a9b6e9b217faca6b6a11bad82ebc44c0caa77419ed83edd81f2'],
    ['directives/repeat.js', 1606, '083140026ecd8665fedd15b17769f9d516252a9f1502f1e91e6967686ee82626'],
    ['directive.js', 481, '3344c4f41c69cd0701d3937e8f9ef90bd845614bf6456d0b8314b7c51d415b9d'],
    ['directive-helpers.js', 1272, 'f7fb1154b8f72ed2cc08b05eaeed71c99270e9ad2d48620ed24688a1af4c2b62'],
  ] },
  { name: '@lit/reactive-element', version: '2.1.2', integrity: 'sha512-pbCDiVMnne1lYUIaYNN5wrwQXDtHaYtg7YEFPeW+hws6U47WeFvISGUWekPGKWOP1ygrs0ef0o1VJMk1exos5A==', members: [
    ['package.json', 15312, '71099ad5c6f15cbea26035d1bf151fd9d0957b79867bc5c3999e24b903f0b2ae'],
    ['reactive-element.js', 6306, '76e9815ec67d16684bff1444224bf62532d6318dbd8f25e7c1e9546158b1335f'],
  ] },
  { name: '@en-reve/elements', version: '0.1.0', filename: 'en-reve-elements-0.1.0.tgz',
    archiveSha256: 'sha256:01baeb4da2f42cf7ae14e2e0bf91b5199c7a10c23a8f899b289fed57827db11b',
    integrity: 'sha512-TyP4vV7EfglBb3IYwLO27ONejewFrIx5qCN8XUsmTQAUj3lFaAZBi7gu/QFWTlLlXyIXkw9Av4+03Ki0aiW31g==', members: [
      ['package.json', 1174, '90bdf39411df3e527e2ccbf26dabad33289a9da929237a3db11a390afe087507'],
      ['dist/definitions/button.js', 249, '01bda170373066f086311dccef844de29fb5cd24cf6222f1fc15f1ea7dd0961c'],
      ['dist/button.js', 80, '6da2cac2a5da37f804edc4c0be5bfed92e04a73dc3c84a766a11f3a01926aba8'],
      ['dist/button/index.js', 74, '9d864437ebca5b8a407c78e1a3180c8122bd647d7a32ee63e1286a9750bfa975'],
      ['dist/button/element.js', 8818, '13032a5ac7a8c27e95f5b334acfebf74e15d57e9388a94f0b5f8165c77625f22'],
      ['dist/button/template.js', 1093, '62222041a4c66d91175f39b86b1304f724373671bf4a99061db6458ef4cffa48'],
      ['dist/internal/en-element.js', 6691, 'fd3e011a019b31f46965191be3241e84435929c89842e53b238fef20136cc472'],
      ['dist/internal/focus-participant.js', 2458, '1dd4bc6cb676ed29017e96716f6276405ba600526dc894838b2ba20ab1b4bce5'],
      ['dist/internal/element-registry.js', 922, '2366b0126eabc41f8226e7b09af76c8fef2aeb6be25ba2d41c8d88519c304dab'],
    ] },
  { name: '@en-reve/primitives', version: '0.1.0', filename: 'en-reve-primitives-0.1.0.tgz',
    archiveSha256: 'sha256:769baf6ac5652966e1a791688291d0ef87596ea1ed270ebe10735f4d51cf65c2',
    integrity: 'sha512-8UGr4RS/eW19iP9HBWpU5K7Q5GEMnQRPvq6G7FI8azibCecqfdBf7Nz4dFF0m8Ti12QIcTBEfvhiqGeweqqcoA==', members: [
      ['package.json', 1103, '28534fd92e36e4e027afcafb806dbb6cc4bb9e285ef86b5213b09bb5a1254662'],
      ['dist/interactions/editing-controller.js', 5194, 'a82457b0e8ced258808675721c29f475734373c5b2672204fa59ac5a50736fee'],
      ['dist/interactions/events.js', 4279, 'eb0569335d5266defd088066c9315366a16bc081aa0ee4b7bbd1dee2b91bf422'],
      ['dist/interactions/static-styles.js', 6120, 'daa549156db3e728263cdb86ae1d73210831a1146ff617caac57547b306209aa'],
    ] },
].map(item => Object.freeze({ ...item,
  lockPath: 'node_modules/' + item.name,
  resolved: item.filename ? 'file:vendor/en-reve/' + SOURCE + '/' + item.filename
    : 'https://registry.npmjs.org/' + item.name + '/-/' + item.name.split('/').at(-1) + '-' + item.version + '.tgz',
  members: Object.freeze(item.members.map(([path, rawBytes, hash]) => Object.freeze({ memberPath: 'package/' + path,
    installedPath: 'node_modules/' + item.name + '/' + path, rawBytes, sha256: 'sha256:' + hash }))),
}));

export const D11_INVOCATION_DEPENDENCY_PATHS = Object.freeze(PACKAGES.flatMap(item => item.members.map(member => member.installedPath)).sort());

function fields(value, expected, label) {
  if (!object(value)) throw Error('Invalid D11 invocation ' + label);
  equal(Object.keys(value).sort(), [...expected].sort(), label + ' fields');
}
function text(bytes) {
  let value; try { value = decoder.decode(bytes); } catch { throw Error('D11 invocation member is not UTF-8'); }
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 || !Buffer.from(value).equals(bytes)) throw Error('D11 invocation member does not round-trip as exact UTF-8');
  return value;
}
function bounded(bytes, maximum, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximum) throw Error('D11 invocation ' + label + ' exceeds its byte bound');
  return bytes;
}
function identity(path, bytes) { return { path, rawBytes: bytes.length, sha256: sha(bytes) }; }
function parse(bytes) { try { return JSON.parse(text(bytes)); } catch { throw Error('D11 invocation retained JSON is invalid'); } }

/** Reproduce the finalized compilation capture against retained source bytes.
 * This establishes capture consistency only. The invocation contract below
 * additionally requires the reviewed source hashes; callers cannot substitute
 * a different config or compiler guard as an approved effect implementation. */
export function verifyD11CompilationCapture(compilation, { sourceTextByPath } = {}) {
  if (!object(sourceTextByPath)) throw Error('D11 compilation requires retained source bytes');
  const inputs = D11_COMPILATION_INPUT_PATHS.map(path => {
    const value = sourceTextByPath[path];
    if (typeof value !== 'string') throw Error('D11 compilation source is missing: ' + path);
    const bytes = bounded(Buffer.from(value), MAX_MEMBER, 'compilation source');
    if (text(bytes) !== value) throw Error('D11 compilation source does not round-trip');
    return identity(path, bytes);
  });
  equal(compilation, { schema: 1, profile: 'reviewed-vite-app-1', configFile: 'vite.app.config.ts', configLoader: 'bundle',
    command: 'build', mode: 'production', env: { BASE_URL: '/', MODE: 'production', DEV: false, PROD: true },
    configInputs: inputs.map(input => ({ path: input.path, bytes: input.rawBytes, sha256: input.sha256.slice(7) })),
    inlineTransformOptions: 'none', userPlugins: ['consumer-build-evidence'] }, 'compilation capture');
  return { kind: 'verified-d11-compilation-capture-1', inputs };
}
function lockPackages(lock) {
  if (!object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages)) throw Error('D11 invocation requires the retained npm lock');
  const compiler = lock.packages['node_modules/vite'];
  if (Object.keys(lock.packages).filter(path => path === 'node_modules/vite' || path.endsWith('/node_modules/vite')).length !== 1
    || !object(compiler) || compiler.version !== '8.3.1' || compiler.resolved !== 'https://registry.npmjs.org/vite/-/vite-8.3.1.tgz'
    || compiler.integrity !== 'sha512-/bvH9E9tmCXRGp2uXY3WbOldqpTwFkbha/8ANaEQ6VkxhH60KyqLwgZq6lG2y+4uT55x9+9eUHMpQ7uGnOCKjA==' || compiler.link === true)
    throw Error('D11 invocation compiler differs from the reviewed Vite configuration profile');
  for (const item of PACKAGES) {
    const locked = lock.packages[item.lockPath], matches = Object.keys(lock.packages).filter(path => path === item.lockPath || path.endsWith('/' + item.lockPath));
    if (matches.length !== 1 || !object(locked) || locked.version !== item.version || locked.resolved !== item.resolved || locked.integrity !== item.integrity || locked.link === true) throw Error('D11 invocation package differs from the reviewed lock profile: ' + item.name);
    if (item.filename && lock.packages['']?.dependencies?.[item.name] !== item.resolved) throw Error('D11 invocation local archive root differs from the retained lock');
  }
}
function dependencies(values) {
  if (!Array.isArray(values) || values.length !== D11_INVOCATION_DEPENDENCY_PATHS.length) throw Error('D11 invocation dependency input inventory differs');
  const found = new Map();
  for (const input of values) {
    fields(input, ['path', 'rawBytes', 'sha256'], 'dependency input');
    if (!D11_INVOCATION_DEPENDENCY_PATHS.includes(input.path) || found.has(input.path) || !Number.isSafeInteger(input.rawBytes) || input.rawBytes < 0 || !HASH.test(input.sha256 ?? '')) throw Error('D11 invocation dependency identity is invalid');
    found.set(input.path, input);
  }
  return found;
}

/** Pure archive/member and build-input verification. This returns narrowly
 * reviewed effects; it never certifies a class, a callback escape, absence of
 * synthetic events, or absence of the optional framework hooks. Those remain
 * obligations of the source-bound target proof and fixed browser context. */
export function verifyD11InvocationContract(contract, { lock, dependencyInputs, emittedModules, compilation, sourceTextByPath, sourceInputs, outputTextByFile } = {}) {
  fields(contract, ['kind', 'profile', 'packages'], 'contract');
  if (contract.kind !== 'perf-d11-invocation-contract-1' || contract.profile !== PROFILE) throw Error('D11 invocation profile is unsupported');
  lockPackages(lock); const installed = dependencies(dependencyInputs);
  const compiled = verifyD11CompilationCapture(compilation, { sourceTextByPath });
  for (const input of REVIEWED_COMPILATION) equal(compiled.inputs.find(value => value.path === input.path), input, 'reviewed compilation source');
  const applicationSourceProfile = verifyD11ApplicationProfile({ sourceTextByPath, sourceInputs, bootstrapText: outputTextByFile?.['inline:bootstrap'] });
  if (!Array.isArray(emittedModules) || emittedModules.length > 100_000 || emittedModules.some(path => typeof path !== 'string' || path.length > 8192)) throw Error('D11 invocation emitted module inventory is absent or invalid');
  const emitted = new Set(emittedModules);
  // The forwarded imports must select the reviewed production browser modules.
  // Merely retaining an unused reviewed file beside a different resolved module
  // cannot supply the event contract.
  for (const item of PACKAGES) for (const member of item.members) if (!member.installedPath.endsWith('/package.json') && !emitted.has(member.installedPath)) throw Error('D11 invocation reviewed runtime member was not in the compiled module graph: ' + member.installedPath);
  for (const path of emitted) for (const item of PACKAGES) {
    if (path.includes('/' + item.lockPath + '/')) throw Error('D11 invocation compiled graph includes an unreviewed nested package identity');
    if (path.startsWith(item.lockPath + '/') && (/\/(?:development|node)\//.test(path.slice(item.lockPath.length)) || /[?#]/.test(path))) throw Error('D11 invocation compiled graph includes an unreviewed development, server or transformed variant');
  }
  if (!Array.isArray(contract.packages) || contract.packages.length !== PACKAGES.length) throw Error('D11 invocation requires the exact reviewed packages');
  const inputs = [], localArchiveInputs = [];
  for (const [index, item] of PACKAGES.entries()) {
    const packed = contract.packages[index];
    fields(packed, ['name', 'lockPath', 'version', 'resolved', 'integrity', 'archive', 'members'], 'package');
    for (const key of ['name', 'lockPath', 'version', 'resolved', 'integrity']) equal(packed[key], item[key], 'package ' + key);
    const archive = packed.archive;
    fields(archive, ['encoding', 'data', 'rawBytes', 'sha256'], 'archive');
    if (archive.encoding !== 'base64' || typeof archive.data !== 'string' || archive.data.length > Math.ceil(MAX_ARCHIVE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(archive.data)) throw Error('Invalid D11 invocation archive encoding');
    const bytes = bounded(Buffer.from(archive.data, 'base64'), MAX_ARCHIVE, 'archive');
    if (bytes.toString('base64') !== archive.data || bytes.length !== archive.rawBytes || sha(bytes) !== archive.sha256 || sri(bytes) !== item.integrity || item.archiveSha256 && sha(bytes) !== item.archiveSha256) throw Error('D11 invocation archive differs from reviewed lock integrity');
    if (item.filename) localArchiveInputs.push(identity(item.resolved.slice(5), bytes));
    if (!Array.isArray(packed.members) || packed.members.length !== item.members.length) throw Error('D11 invocation selected member inventory differs');
    for (const [memberIndex, member] of item.members.entries()) {
      const selected = bounded(readD11RegistrationArchiveMember(bytes, member.memberPath).bytes, MAX_MEMBER, 'member');
      if (selected.length !== member.rawBytes || sha(selected) !== member.sha256) throw Error('D11 invocation member differs from reviewed production bytes');
      equal(packed.members[memberIndex], { ...member, text: text(selected) }, 'member provenance');
      const input = identity(member.installedPath, selected);
      equal(installed.get(member.installedPath), input, 'compiled dependency member');
      inputs.push(input);
      if (member.installedPath.endsWith('/package.json')) {
        const metadata = parse(selected);
        if (metadata.name !== item.name || metadata.version !== item.version || metadata.type !== 'module') throw Error('D11 invocation package metadata differs');
      }
    }
  }
  return { kind: 'verified-d11-invocation-contract-1', profile: PROFILE,
    effects: { plainArrowEventBinding: 'stored-until-dispatch', eventInvocation: 'EventPart.handleEvent', nativeButtonStartupClick: 'not-dispatched-by-reviewed-own-lifecycle',
      repeatRender: 'eager-key-and-item-render-with-child-part-commit', nativeEditingBridgeStartup: 'no-preview-or-apply-dispatch',
      supportedCompilation: 'reviewed-vite-app-config-and-build-evidence', applicationSourceProfile: 'reviewed-d11-startup-corpus-1' },
    requiredAbsentGlobals: ['reactiveElementPolyfillSupport', 'litElementHydrateSupport', 'litElementPolyfillSupport', 'litHtmlPolyfillSupport'],
    inputs, localArchiveInputs, compilationInputs: compiled.inputs, applicationSourceProfile };
}

/** Preparation performs bounded reads only. Registry archive acquisition is
 * explicit and injected; this module never installs packages or uses a network.
 * The caller's repo reader must enforce its canonical/stable file boundary. */
export async function prepareD11InvocationContract({ read, readArchive, dependencyInputs, emittedModules, compilation, sourceTextByPath, sourceInputs, outputTextByFile } = {}) {
  if (typeof read !== 'function' || typeof readArchive !== 'function') throw Error('D11 invocation preparation requires explicit repo and archive readers');
  const obtain = async (path, maximum) => bounded((await read(path, maximum)).bytes, maximum, path);
  const lock = parse(await obtain('package-lock.json', MAX_LOCK)); lockPackages(lock);
  for (const path of D11_COMPILATION_INPUT_PATHS) equal(sourceTextByPath?.[path], text(await obtain(path, MAX_MEMBER)), 'prepared compilation source');
  const contract = { kind: 'perf-d11-invocation-contract-1', profile: PROFILE, packages: [] };
  for (const item of PACKAGES) {
    const bytes = bounded(item.filename ? await obtain(item.resolved.slice(5), MAX_ARCHIVE)
      : await readArchive({ name: item.name, lockPath: item.lockPath, resolved: item.resolved, integrity: item.integrity, maxBytes: MAX_ARCHIVE }), MAX_ARCHIVE, 'archive');
    if (sri(bytes) !== item.integrity || item.archiveSha256 && sha(bytes) !== item.archiveSha256) throw Error('D11 invocation archive identity differs before member preparation');
    const members = [];
    for (const member of item.members) {
      const selected = readD11RegistrationArchiveMember(bytes, member.memberPath).bytes;
      if (selected.length !== member.rawBytes || sha(selected) !== member.sha256) throw Error('D11 invocation reviewed member differs before installed read');
      if (!selected.equals(await obtain(member.installedPath, MAX_MEMBER))) throw Error('D11 invocation installed member differs from retained archive');
      members.push({ ...member, text: text(selected) });
    }
    contract.packages.push({ name: item.name, lockPath: item.lockPath, version: item.version, resolved: item.resolved, integrity: item.integrity,
      archive: { encoding: 'base64', data: bytes.toString('base64'), rawBytes: bytes.length, sha256: sha(bytes) }, members });
  }
  verifyD11InvocationContract(contract, { lock, dependencyInputs, emittedModules, compilation, sourceTextByPath, sourceInputs, outputTextByFile });
  return contract;
}

/** Optional local reader for npm's SHA512-addressed content cache. A caller must
 * explicitly select an absolute canonical cache directory; no default cache,
 * npm invocation, download, package import, or cache write occurs. */
export function createD11NpmArchiveReader({ cacheDirectory } = {}) {
  if (typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory) || resolve(cacheDirectory) !== cacheDirectory) throw Error('D11 invocation npm cache must be an explicit absolute canonical directory');
  return async ({ integrity, maxBytes = MAX_ARCHIVE } = {}) => {
    if (!SRI.test(integrity ?? '') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARCHIVE) throw Error('D11 invocation cache request is invalid');
    const digest = Buffer.from(integrity.slice(7), 'base64');
    if (digest.length !== 64 || digest.toString('base64') !== integrity.slice(7)) throw Error('D11 invocation cache integrity is not canonical');
    const hex = digest.toString('hex'), parts = ['_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)];
    if (await realpath(cacheDirectory) !== cacheDirectory || !(await lstat(cacheDirectory)).isDirectory()) throw Error('D11 invocation npm cache root is not a canonical directory');
    let path = cacheDirectory;
    for (const [index, part] of parts.entries()) {
      path = join(path, part); const entry = await lstat(path);
      if (entry.isSymbolicLink() || (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) throw Error('D11 invocation cache contains a symlink or non-regular path');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) throw Error('D11 invocation cache archive exceeds its byte bound');
      // Read into a fixed bound even if a concurrently modified cache entry
      // grows after stat; readFile() would allocate for the untrusted growth.
      const buffer = Buffer.alloc(maxBytes + 1); let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > maxBytes) throw Error('D11 invocation cache archive exceeds its byte bound');
      const bytes = buffer.subarray(0, count), after = await handle.stat();
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || sri(bytes) !== integrity) throw Error('D11 invocation cache archive changed or differs from lock integrity');
      return bytes;
    } finally { await handle.close(); }
  };
}

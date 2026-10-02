import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { deriveD11Roles } from './browser-d11-roles.mjs';
import { D11_ROLE_CONTEXT, prepareD11RegistrationContract } from './browser-d11-registration.mjs';
import { D11_INVOCATION_DEPENDENCY_PATHS, createD11NpmArchiveReader, prepareD11InvocationContract, verifyD11CompilationCapture } from './browser-d11-invocation-contract.mjs';

const JSON_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
const ENTRY_LIMIT = 20_000;
const HASH = /^[a-f0-9]{64}$/;
const requiredSources = ['index.html', 'vite.app.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'package.json', 'package-lock.json', '.progress-report/project.json', 'tooling/build-evidence.ts', 'vendor/text/manifest.json'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sorted = values => [...new Set(values)].sort();

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function pathName(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || isAbsolute(value) || /[\\\x00-\x1f\x7f?#]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw Error('D11 requires canonical relative file paths');
  return value;
}

function same(left, right) {
  return left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory() && !right.isSymbolicLink() && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);
}

function kind(file) {
  if (/\.(?:js|mjs|cjs)$/i.test(file)) return 'js';
  if (/\.css$/i.test(file)) return 'css';
  if (/\.(?:ttf|otf|woff2?|ttc)$/i.test(file)) return 'font';
  if (/\.wasm$/i.test(file)) return 'wasm';
  return 'other';
}

function strings(value, label) {
  if (!Array.isArray(value) || value.length > ENTRY_LIMIT || value.some(item => typeof item !== 'string' || item.length > 8192) || new Set(value).size !== value.length) throw Error('Invalid D11 ' + label);
  return value;
}

const staticTail = [
  'const resources = [];',
  "html = html.replace(/<script\\b[^>]*\\bsrc=[^>]*><\\/script>|<link\\b[^>]*>/gi, tag => { resources.push(tag); return ''; });",
  "html = html.replace(/<\\/head>/i, `<template id=\"ie-resources\">${resources.join('')}</template></head>`);",
  'html = html.replace(/<head(?:\\s[^>]*)?>/i, match => `${match}<script>${BOOTSTRAP_PRELUDE}</script>`);',
  "files.set('/', { bytes: Buffer.from(html), type: 'text/html; charset=utf-8' });",
  'return files;',
  '}',
].join('\n');

function staticBytes({ staticModule, index }) {
  if (typeof staticModule !== 'string' || Buffer.byteLength(staticModule) > JSON_LIMIT || typeof index !== 'string' || Buffer.byteLength(index) > JSON_LIMIT) throw Error('D11 static derivation requires bounded UTF-8 module and index bytes');
  const declaration = 'export const BOOTSTRAP_PRELUDE = `', start = staticModule.indexOf(declaration);
  if (start < 0 || staticModule.indexOf(declaration, start + declaration.length) !== -1) throw Error('D11 unsupported compiled bootstrap declaration');
  const end = staticModule.indexOf('`;', start + declaration.length);
  if (end < 0) throw Error('D11 compiled bootstrap template is incomplete');
  const prelude = staticModule.slice(start + declaration.length, end);
  if (!prelude || prelude.includes('`') || prelude.includes('\\') || prelude.includes('${')) throw Error('D11 compiled bootstrap requires an unescaped literal template');
  const normalized = staticModule.split(/\r?\n/).map(line => line.trim()).join('\n');
  if (!normalized.endsWith(staticTail) && !normalized.endsWith(staticTail + '\n')) throw Error('D11 compiled static document transform is unsupported');
  if (!/<head(?:\s[^>]*)?>/i.test(index)) throw Error('D11 index lacks the product-required head');
  const resources = [];
  let html = index.replace(/<script\b[^>]*\bsrc=[^>]*><\/script>|<link\b[^>]*>/gi, tag => { resources.push(tag); return ''; });
  html = html.replace(/<\/head>/i, `<template id="ie-resources">${resources.join('')}</template></head>`);
  html = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<script>${prelude}</script>`);
  return { prelude, html };
}

/** Offline replay uses exact retained compiled/index bytes, without evaluating
 * retained JavaScript. Unsupported product transform changes fail explicitly. */
export function deriveD11StaticDocument(input) {
  const { prelude, html } = staticBytes(input);
  const account = text => { const bytes = Buffer.from(text), gzipBytes = gzipSync(bytes).length; return { sha256: digest(bytes), rawBytes: bytes.length, gzipBytes, computedGzipBytes: gzipBytes }; };
  return {
    bootstrap: { file: 'inline:bootstrap', ...account(prelude), modules: ['server/static.ts'], sources: ['server/static.ts'], kind: 'js', authoringFont: false },
    document: account(html),
  };
}

/** Read and seal a finalized production artifact. This does not classify an
 * asset as fetched/evaluated, prove a lazy boundary, or make a timing claim.
 * Registry archives are read only from an explicitly configured local cache. */
export async function loadD11Build({ repo, cacheDirectory } = {}) {
  if (process.versions.node !== '26.10.0') throw Error('D11 build inventory requires the pinned Node 26.10.0 runtime before byte/gzip work');
  if (!isAbsolute(repo ?? '') || resolve(repo) !== repo || await realpath(repo) !== repo || !(await lstat(repo)).isDirectory()) throw Error('D11 repo must be an existing canonical directory without symlinks');
  const reads = new Map(), available = new Map(), directories = new Map(); let totalBytes = 0;
  async function regular(path) {
    pathName(path);
    const absolute = join(repo, path);
    if (await realpath(absolute) !== absolute) throw Error('D11 input traverses a symlink: ' + path);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('D11 input is not an ordinary file: ' + path);
    if (!available.has(path)) available.set(path, stat);
    return { absolute, stat };
  }
  async function read(path, maximum = FILE_LIMIT) {
    const cached = reads.get(path);
    if (cached) { if (cached.bytes.length > maximum) throw Error('D11 input exceeds its byte bound: ' + path); return cached; }
    const { absolute, stat: before } = await regular(path);
    if (before.size > maximum || totalBytes + before.size > TOTAL_LIMIT || reads.size >= ENTRY_LIMIT) throw Error('D11 input exceeds its byte or entry bound: ' + path);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(before, await handle.stat())) throw Error('D11 input changed before reading: ' + path);
      // A fixed allocation bounds reads even if a writer grows the file.
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw Error('D11 input shortened during reading: ' + path); offset += bytesRead; }
      const after = await handle.stat(), current = await lstat(absolute);
      if (!same(before, after) || !same(before, current) || await realpath(absolute) !== absolute) throw Error('D11 input changed while reading: ' + path);
      const value = { bytes, stat: after, path, sha256: digest(bytes) }; reads.set(path, value); totalBytes += bytes.length; return value;
    } finally { await handle.close(); }
  }
  async function json(path) {
    const value = await read(path, JSON_LIMIT);
    try { return { ...value, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes)) }; }
    catch { throw Error('D11 input is not bounded UTF-8 JSON: ' + path); }
  }
  async function tree(path) {
    pathName(path); const absolute = join(repo, path), before = await lstat(absolute);
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(absolute) !== absolute) throw Error('D11 directory is not canonical: ' + path);
    const entries = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length + directories.size > ENTRY_LIMIT) throw Error('D11 directory inventory exceeds its bound');
    const result = [];
    for (const entry of entries) {
      const child = path + '/' + entry.name; pathName(child);
      if (entry.isDirectory()) result.push(...await tree(child));
      else if (entry.isFile()) result.push(child);
      else throw Error('D11 inventory contains a symlink or special file: ' + child);
      if (result.length > ENTRY_LIMIT) throw Error('D11 directory inventory exceeds its bound');
    }
    const after = await lstat(absolute);
    if (!same(before, after)) throw Error('D11 directory changed during inventory: ' + path);
    directories.set(path, after); return result;
  }

  const evidence = await json('dist/app/build-evidence.json'), manifestInput = await json('dist/app/.vite/manifest.json');
  const lockInput = await json('package-lock.json'), textInput = await json('vendor/text/manifest.json'), profileInput = await json('src/text/profile.json');
  const staticSourceInput = await read('server/static.ts', JSON_LIMIT), staticModuleInput = await read('dist/local/server/static.js', JSON_LIMIT), indexInput = await read('dist/app/index.html', JSON_LIMIT);
  const build = evidence.value, manifest = manifestInput.value, lock = lockInput.value, text = textInput.value;
  if (!object(build) || build.schema !== 1 || build.capture?.phase !== 'writeBundle' || build.capture?.finalized !== true || !Array.isArray(build.outputs) || !build.outputs.length || build.outputs.length > ENTRY_LIMIT || !Array.isArray(build.sourceInputs) || !build.sourceInputs.length || build.sourceInputs.length > ENTRY_LIMIT) throw Error('D11 requires finalized build evidence and full source inputs');
  if (build.toolchain?.node !== '26.10.0' || build.toolchain?.npm !== '12.1.0') throw Error('D11 finalized build must record pinned Node 26.10.0 and npm 12.1.0');
  if (!object(manifest) || !Object.keys(manifest).length || Object.keys(manifest).length > ENTRY_LIMIT || !object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages) || Object.keys(lock.packages).length > ENTRY_LIMIT) throw Error('Invalid D11 bundler manifest or package lock');
  if (!object(text) || !HASH.test(text.engine?.wasm?.sha256 ?? '') || !integer(text.engine.wasm.bytes) || !Array.isArray(text.fonts) || text.fonts.length > 256 || canonical(text) !== canonical(profileInput.value)) throw Error('D11 text profile differs from the sealed vendor manifest');

  const expectedSources = sorted([...requiredSources, ...await tree('src'), ...await tree('tooling/theme')]);
  const sourceInputs = [], sourceNames = new Set();
  for (const source of build.sourceInputs) {
    if (!object(source) || !integer(source.bytes) || !HASH.test(source.sha256 ?? '') || sourceNames.has(pathName(source.path))) throw Error('Invalid or duplicate D11 source input');
    sourceNames.add(source.path); const actual = await read(source.path);
    if (actual.bytes.length !== source.bytes || actual.sha256 !== 'sha256:' + source.sha256) throw Error('D11 source changed since the finalized build: ' + source.path);
    sourceInputs.push({ path: source.path, rawBytes: actual.bytes.length, sha256: actual.sha256 });
  }
  if (JSON.stringify(sorted(sourceNames)) !== JSON.stringify(expectedSources)) throw Error('D11 finalized source inventory is incomplete or has changed');

  const capturesInvocationDependencies = Object.hasOwn(build, 'dependencyInputs');
  const dependencyInputs = [], dependencyNames = new Set();
  if (capturesInvocationDependencies) {
    if (!Array.isArray(build.dependencyInputs) || build.dependencyInputs.length !== D11_INVOCATION_DEPENDENCY_PATHS.length) throw Error('D11 finalized invocation dependency inventory is incomplete or has changed');
    for (const input of build.dependencyInputs) {
      if (!object(input) || Object.keys(input).sort().join(',') !== 'bytes,path,sha256' || !D11_INVOCATION_DEPENDENCY_PATHS.includes(input.path) || dependencyNames.has(input.path) || !integer(input.bytes) || input.bytes > 64 * 1024 || !HASH.test(input.sha256 ?? '')) throw Error('Invalid or duplicate D11 invocation dependency input');
      dependencyNames.add(input.path); const actual = await read(input.path, 64 * 1024);
      if (actual.bytes.length !== input.bytes || actual.sha256 !== 'sha256:' + input.sha256) throw Error('D11 invocation dependency changed since the finalized build: ' + input.path);
      dependencyInputs.push({ path: input.path, rawBytes: actual.bytes.length, sha256: actual.sha256 });
    }
    if (JSON.stringify(sorted(dependencyNames)) !== JSON.stringify(D11_INVOCATION_DEPENDENCY_PATHS)) throw Error('D11 finalized invocation dependency inventory is incomplete or has changed');
  }

  const sourceByFile = new Map(), entries = Object.entries(manifest);
  for (const [key, entry] of entries) {
    if (typeof key !== 'string' || key.length > 4096 || !object(entry)) throw Error('Invalid D11 manifest entry');
    pathName(entry.file);
    for (const name of ['imports', 'dynamicImports', 'css', 'assets']) if (entry[name] !== undefined) strings(entry[name], 'manifest ' + name);
    if (entry.src !== undefined) { pathName(entry.src); const sources = sourceByFile.get(entry.file) ?? []; sources.push(entry.src); sourceByFile.set(entry.file, sources); await regular(entry.src); }
    for (const key of [...entry.imports ?? [], ...entry.dynamicImports ?? []]) if (!Object.hasOwn(manifest, key)) throw Error('D11 manifest dependency is absent: ' + key);
  }
  const authoring = new Map();
  for (const font of text.fonts) {
    if (!object(font) || !HASH.test(font.sha256 ?? '') || !integer(font.bytes)) throw Error('Invalid D11 authoring font identity');
    const source = 'vendor/text/' + pathName(font.file), actual = await read(source);
    if (actual.bytes.length !== font.bytes || actual.sha256 !== 'sha256:' + font.sha256) throw Error('D11 vendor font bytes differ from their identity');
    authoring.set(actual.sha256, source);
  }
  const files = [], emitted = new Map();
  for (const output of build.outputs) {
    if (!object(output) || !integer(output.bytes) || !integer(output.gzipBytes) || !HASH.test(output.sha256 ?? '') || emitted.has(pathName(output.file)) || output.file === 'build-evidence.json') throw Error('Invalid or duplicate D11 emitted output');
    const modules = strings(output.modules, 'module inventory'); strings(output.imports, 'output imports').forEach(pathName);
    const actual = await read('dist/app/' + output.file), computedGzipBytes = gzipSync(actual.bytes).length;
    if (actual.bytes.length !== output.bytes || actual.sha256 !== 'sha256:' + output.sha256 || computedGzipBytes !== output.gzipBytes) throw Error('D11 emitted raw/hash/gzip identity mismatch: ' + output.file);
    const sources = [...sourceByFile.get(output.file) ?? []];
    for (const module of modules) {
      // Virtual bundler modules have no disk source. Preserve their identities;
      // never treat their names as paths or fabricate source provenance.
      if (module.startsWith('\0') || module.startsWith('virtual:')) continue;
      const source = module.split('?')[0]; pathName(source); await regular(source); sources.push(source);
    }
    if (authoring.has(actual.sha256)) sources.push(authoring.get(actual.sha256));
    const value = { file: output.file, sha256: actual.sha256, rawBytes: actual.bytes.length, gzipBytes: computedGzipBytes, computedGzipBytes, modules: [...modules], sources: sorted(sources), kind: kind(output.file), authoringFont: kind(output.file) === 'font' && authoring.has(actual.sha256) };
    emitted.set(value.file, value); files.push(value);
  }
  const diskFiles = (await tree('dist/app')).map(path => relative(join(repo, 'dist/app'), join(repo, path)).split(sep).join('/'));
  const expectedOutput = sorted([...emitted.keys(), 'index.html', 'build-evidence.json', '.vite/manifest.json']);
  if (JSON.stringify(sorted(diskFiles)) !== JSON.stringify(expectedOutput)) throw Error('D11 build contains missing or unrecorded output files');
  if (!emitted.has('index.html')) {
    // Vite emits final HTML outside the plugin's chunk bundle. It is still
    // measured and sealed here, but carries no invented chunk-module list.
    const html = await read('dist/app/index.html'), computedGzipBytes = gzipSync(html.bytes).length;
    const value = { file: 'index.html', sha256: html.sha256, rawBytes: html.bytes.length, gzipBytes: computedGzipBytes, computedGzipBytes, modules: [], sources: ['index.html'], kind: 'other', authoringFont: false };
    emitted.set(value.file, value); files.push(value);
  }
  for (const [key, entry] of entries) for (const file of [entry.file, ...entry.css ?? [], ...entry.assets ?? []]) if (!emitted.has(pathName(file))) throw Error('D11 manifest refers to missing emitted file: ' + key);
  for (const output of build.outputs) for (const file of output.imports) if (!emitted.has(file)) throw Error('D11 output imports a missing emitted file');
  const textWasmHash = 'sha256:' + text.engine.wasm.sha256;
  if (!files.some(file => file.kind === 'wasm' && file.sha256 === textWasmHash && file.rawBytes === text.engine.wasm.bytes)) throw Error('D11 emitted sealed text WASM is absent');

  function closure(key, seen = new Set(), result = new Set()) {
    if (seen.has(key)) return result; seen.add(key);
    const entry = manifest[key]; result.add(entry.file); (entry.css ?? []).forEach(file => result.add(file));
    for (const dependency of entry.imports ?? []) closure(dependency, seen, result);
    return result;
  }
  const dynamicFeatures = entries.filter(([, entry]) => entry.isDynamicEntry === true).map(([id, entry]) => ({ id, entryFile: entry.file, files: sorted(closure(id)) })).sort((a, b) => a.id.localeCompare(b.id));
  const packages = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue; pathName(path);
    if (!object(entry) || typeof entry.version !== 'string' || !entry.version || entry.version.length > 256 || entry.link === true) throw Error('Invalid D11 locked package identity');
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
    if (!match) throw Error('Invalid D11 locked package path');
    const name = typeof entry.name === 'string' ? entry.name : match[1];
    if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) throw Error('Invalid D11 locked package name');
    const versions = packages.get(name) ?? new Set(); versions.add(entry.version); packages.set(name, versions);
  }
  const duplicateVersions = [...packages].filter(([, versions]) => versions.size > 1).map(([name, versions]) => ({ package: name, versions: sorted(versions) })).sort((a, b) => a.package.localeCompare(b.package));
  const decode = value => {
    // Retained text must round-trip to the exact independently sealed bytes;
    // TextDecoder's default BOM stripping would silently change that identity.
    if (value.bytes.length >= 3 && value.bytes[0] === 0xef && value.bytes[1] === 0xbb && value.bytes[2] === 0xbf) throw Error('D11 retained UTF-8 inputs must not contain a byte-order mark');
    return new TextDecoder('utf-8', { fatal: true }).decode(value.bytes);
  };
  const retainedInputs = Object.fromEntries(Object.entries({ buildEvidence: evidence, manifest: manifestInput, lock: lockInput, textManifest: textInput, textProfile: profileInput, staticSource: staticSourceInput, staticModule: staticModuleInput, index: indexInput }).map(([name, value]) => [name, decode(value)]));
  const derived = deriveD11StaticDocument({ staticModule: retainedInputs.staticModule, index: retainedInputs.index });
  const expectedStatic = staticBytes({ staticModule: retainedInputs.staticModule, index: retainedInputs.index });
  const moduleURL = pathToFileURL(join(repo, 'dist/local/server/static.js')); moduleURL.searchParams.set('d11-sha256', staticModuleInput.sha256);
  const actualStatic = await import(moduleURL.href);
  if (actualStatic.BOOTSTRAP_PRELUDE !== expectedStatic.prelude || typeof actualStatic.loadStatic !== 'function') throw Error('D11 compiled product bootstrap differs from retained derivation');
  const served = (await actualStatic.loadStatic(join(repo, 'dist/app'))).get('/');
  if (!served || !Buffer.isBuffer(served.bytes) || !served.bytes.equals(Buffer.from(expectedStatic.html))) throw Error('D11 actual product static document differs from retained derivation');
  files.push(derived.bootstrap);
  const sourceTextByPath = Object.fromEntries(sourceInputs.filter(input => /\.(?:[cm]?[jt]sx?|css|json)$/.test(input.path) || capturesInvocationDependencies && input.path === 'index.html').map(input => [input.path, decode(reads.get(input.path))]));
  const outputTextByFile = Object.fromEntries(files.filter(file => file.kind === 'js' || file.kind === 'css').map(file => [file.file, file.file === 'inline:bootstrap' ? expectedStatic.prelude : decode(reads.get('dist/app/' + file.file))]));
  const parserVersion = lock.packages['node_modules/rolldown']?.version;
  const parserPackage = await json('node_modules/rolldown/package.json');
  if (typeof parserVersion !== 'string' || parserPackage.value.version !== parserVersion) throw Error('D11 AST parser does not match the retained package lock');
  const subjectRequire = createRequire(join(repo, 'package.json'));
  const parserPaths = [subjectRequire.resolve('rolldown'), subjectRequire.resolve('rolldown/utils')];
  for (const path of parserPaths) {
    if (!path.startsWith(repo + sep)) throw Error('D11 AST parser resolves outside the subject repository');
    await regular(relative(repo, path).split(sep).join('/'));
  }
  const { VERSION } = await import(pathToFileURL(parserPaths[0]).href), { parseSync } = await import(pathToFileURL(parserPaths[1]).href);
  if (VERSION !== parserVersion || typeof parseSync !== 'function') throw Error('D11 loaded AST parser differs from its pinned identity');
  const registrationContract = await prepareD11RegistrationContract({ repo, read });
  if (capturesInvocationDependencies) verifyD11CompilationCapture(build.compilation, { sourceTextByPath });
  else if (Object.hasOwn(build, 'compilation')) throw Error('D11 legacy finalized evidence cannot acquire invocation compilation metadata');
  const emittedModules = sorted(files.flatMap(file => file.modules));
  let invocationContract = null;
  if (capturesInvocationDependencies && cacheDirectory !== undefined) {
    const cachedArchive = createD11NpmArchiveReader({ cacheDirectory }), unavailable = Symbol('D11 invocation archive unavailable');
    const readArchive = async input => {
      try { return await cachedArchive(input); }
      catch (error) {
        // Only absence reported by this explicit external cache reader makes
        // the optional contract unavailable. Repo/member/provenance failures
        // still reject the inventory instead of becoming an absence claim.
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw unavailable;
        throw error;
      }
    };
    try { invocationContract = await prepareD11InvocationContract({ read, readArchive, dependencyInputs, emittedModules, compilation: build.compilation, sourceTextByPath, sourceInputs, outputTextByFile }); }
    catch (error) { if (error !== unavailable) throw error; }
  }
  const roleContext = D11_ROLE_CONTEXT;
  const roleInputs = { sourceTextByPath, outputTextByFile, parser: { name: 'rolldown', version: parserVersion }, registrationContract,
    ...(capturesInvocationDependencies ? { invocationContract } : {}) };
  const roles = deriveD11Roles({ manifest, files, ...roleInputs, roleContext, ...(capturesInvocationDependencies ? { dependencyInputs, compilation: build.compilation, sourceInputs } : {}), lock, parser: { ...roleInputs.parser, parseSync } });
  // Recheck every read and directory at the final boundary. No browser timing
  // should begin until this immutable inventory has finished successfully.
  for (const [path, value] of reads) { const actual = await regular(path); if (!same(value.stat, actual.stat)) throw Error('D11 input changed before final sealing: ' + path); }
  for (const [path, before] of available) if (!same(before, await lstat(join(repo, path))) || await realpath(join(repo, path)) !== join(repo, path)) throw Error('D11 source availability changed before final sealing: ' + path);
  for (const [path, before] of directories) if (!same(before, await lstat(join(repo, path))) || await realpath(join(repo, path)) !== join(repo, path)) throw Error('D11 inventory changed before final sealing: ' + path);
  const identity = value => ({ path: value.path, rawBytes: value.bytes.length, sha256: value.sha256 });
  const result = { kind: 'perf-d11-build-1', files: files.sort((a, b) => a.file.localeCompare(b.file)), dynamicFeatures, textWasmHash, duplicateVersions,
    duplicateVersionsScope: 'package-lock-all-packages; installed or bundled execution is not implied',
    gzip: { algorithm: 'gzip', level: 'zlib-default', source: 'fresh Node gzipSync bytes, matching build-evidence.ts; not observed HTTP compression' },
    inputs: { buildEvidence: identity(evidence), manifest: identity(manifestInput), lock: identity(lockInput), textManifest: identity(textInput), textProfile: identity(profileInput), staticSource: identity(staticSourceInput), staticModule: identity(staticModuleInput), index: identity(indexInput) },
    retainedInputs, ...derived, roles, roleInputs, roleContext,
    toolchain: { node: process.versions.node, npm: build.toolchain.npm, zlib: process.versions.zlib, built: { node: build.toolchain.node, npm: build.toolchain.npm } },
    sourceInputs: sourceInputs.sort((a, b) => a.path.localeCompare(b.path)),
    ...(capturesInvocationDependencies ? { dependencyInputs: dependencyInputs.sort((a, b) => a.path.localeCompare(b.path)), compilation: build.compilation } : {}),
    sourceAttribution: 'Recorded chunk modules and manifest asset sources; virtual modules and worker assets may lack source-module detail. Disk source availability is checked; emitted bytes and recorded application inputs are hash-verified.' };
  return freeze({ ...result, sha256: digest(canonical(result)) });
}

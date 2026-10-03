import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gzipSync } from 'node:zlib';
import { VERSION as rolldownVersion } from 'rolldown';
import { parseSync } from 'rolldown/utils';
import { analyzeD11Observation } from './browser-d11.mjs';
import { deriveD11StaticDocument } from './browser-d11-build.mjs';
import { D11_VITE_BROWSER_EXTERNAL, deriveD11Roles, isD11VirtualModule } from './browser-d11-roles.mjs';
import { D11_ROLE_CONTEXT, verifyD11RegistrationContract } from './browser-d11-registration.mjs';
import { D11_INVOCATION_DEPENDENCY_PATHS, verifyD11CompilationCapture, verifyD11InvocationContract } from './browser-d11-invocation-contract.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const BARE_HASH = /^[a-f0-9]{64}$/;
const LIMIT = 20_000;
const requiredSources = ['index.html', 'vite.app.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'package.json', 'package-lock.json', '.progress-report/project.json', 'tooling/build-evidence.ts', 'vendor/text/manifest.json'];
const requiredInputs = { buildEvidence: 'dist/app/build-evidence.json', manifest: 'dist/app/.vite/manifest.json', lock: 'package-lock.json', textManifest: 'vendor/text/manifest.json', textProfile: 'src/text/profile.json', staticSource: 'server/static.ts', staticModule: 'dist/local/server/static.js', index: 'dist/app/index.html' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const equal = (actual, expected, message) => { if (!isDeepStrictEqual(actual, expected)) throw Error(message); };
const sorted = values => [...new Set(values)].sort();

// Match the build producer's recursive, sorted-key JSON seal. Inputs come from
// the retained JSON packet; rejecting non-JSON values also keeps direct callers
// from making a disappearing undefined/property value part of an identity.
function canonical(value, depth = 0) {
  if (depth > 64) throw Error('D11 retained evidence exceeds its nesting bound');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > LIMIT) throw Error('D11 retained evidence exceeds its entry bound');
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  }
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort();
    if (keys.length > LIMIT) throw Error('D11 retained evidence exceeds its entry bound');
    return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  }
  throw Error('D11 retained evidence must contain only JSON values');
}

function pathName(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /^[A-Za-z]:/.test(value) || /[\\\x00-\x1f\x7f?#]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw Error('D11 receipt requires canonical relative paths');
  return value;
}

function array(value, name, { nonempty = false } = {}) {
  if (!Array.isArray(value) || value.length > LIMIT || nonempty && !value.length) throw Error('Invalid D11 ' + name);
  return value;
}

function strings(value, name) {
  array(value, name);
  if (value.some(item => typeof item !== 'string' || item.length > 8192) || new Set(value).size !== value.length) throw Error('Invalid D11 ' + name);
  return value;
}

function receiptFiles(values, name, source = false) {
  const result = new Map();
  for (const item of array(values, name, { nonempty: true })) {
    if (!object(item)) throw Error('Invalid D11 receipt file identity');
    const path = pathName(item.path);
    if (result.has(path)) throw Error('Duplicate D11 receipt file identity');
    if (source && item.deleted === true) {
      equal(Object.keys(item).sort(), ['deleted', 'path'], 'Invalid D11 deleted source marker');
      result.set(path, null); continue;
    }
    if (item.deleted !== undefined || !integer(item.bytes) || typeof item.sha256 !== 'string' || !(source ? BARE_HASH : HASH).test(item.sha256)) throw Error('Invalid D11 receipt file identity');
    result.set(path, { rawBytes: item.bytes, sha256: source ? 'sha256:' + item.sha256 : item.sha256 });
  }
  return result;
}

function bindIdentity(identity, inventory, label) {
  if (!object(identity) || !integer(identity.rawBytes) || typeof identity.sha256 !== 'string' || !HASH.test(identity.sha256)) throw Error('Invalid D11 ' + label + ' identity');
  const path = pathName(identity.path), actual = inventory.get(path);
  if (!actual || actual.rawBytes !== identity.rawBytes || actual.sha256 !== identity.sha256) throw Error('D11 ' + label + ' differs from retained receipt identity: ' + path);
  return path;
}

function artifactKind(file) {
  if (/\.(?:js|mjs|cjs)$/i.test(file)) return 'js';
  if (/\.css$/i.test(file)) return 'css';
  if (/\.(?:ttf|otf|woff2?|ttc)$/i.test(file)) return 'font';
  if (/\.wasm$/i.test(file)) return 'wasm';
  return 'other';
}

function retainedInputs(build) {
  if (!object(build.retainedInputs)) throw Error('D11 exact retained build input bytes are absent');
  equal(Object.keys(build.retainedInputs).sort(), Object.keys(requiredInputs).sort(), 'D11 retained input byte inventory differs');
  const parsed = {};
  for (const [name, value] of Object.entries(build.retainedInputs)) {
    if (typeof value !== 'string') throw Error('D11 retained inputs must contain exact UTF-8 strings');
    const bytes = Buffer.from(value), identity = build.inputs[name];
    if (bytes.length > 16 * 1048576 || value.startsWith('\uFEFF') || bytes.toString('utf8') !== value || bytes.length !== identity.rawBytes || hash(bytes) !== identity.sha256) throw Error('D11 retained input bytes differ from their sealed identity: ' + name);
    if (['staticSource', 'staticModule', 'index'].includes(name)) parsed[name] = value;
    else {
      try { parsed[name] = JSON.parse(value); }
      catch { throw Error('D11 retained input is not valid JSON: ' + name); }
    }
  }
  return parsed;
}

// Metadata is derived from exact retained JSON bytes, themselves bound to the
// receipt's compiled/source files. A newly self-sealed build cannot silently
// lower gzip values or reclassify an authoring font as a UI asset.
function reproduceBuildMetadata(build) {
  const retained = retainedInputs(build), evidence = retained.buildEvidence, manifest = retained.manifest, lock = retained.lock, text = retained.textManifest;
  if (!object(evidence) || evidence.schema !== 1 || evidence.capture?.phase !== 'writeBundle' || evidence.capture.finalized !== true) throw Error('D11 retained build evidence is not finalized');
  if (evidence.toolchain?.node !== '26.10.0' || evidence.toolchain?.npm !== '12.1.0' || process.versions.node !== '26.10.0') throw Error('D11 byte reproduction requires the pinned build and verifier toolchain');
  equal(build.toolchain, { node: '26.10.0', npm: '12.1.0', zlib: process.versions.zlib, built: { node: '26.10.0', npm: '12.1.0' } }, 'D11 gzip toolchain differs from retained build evidence');
  if (build.gzip?.algorithm !== 'gzip' || build.gzip?.level !== 'zlib-default') throw Error('D11 retained gzip method differs from the byte producer');
  if (!object(manifest) || !Object.keys(manifest).length || Object.keys(manifest).length > LIMIT || !object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages) || Object.keys(lock.packages).length > LIMIT) throw Error('Invalid retained D11 manifest or lock');
  if (!object(text) || !BARE_HASH.test(text.engine?.wasm?.sha256 ?? '') || !integer(text.engine.wasm.bytes) || !Array.isArray(text.fonts) || text.fonts.length > 256) throw Error('Invalid retained D11 text manifest');
  equal(retained.textProfile, text, 'D11 retained text profile differs from vendor manifest');
  const sourceInputs = array(evidence.sourceInputs, 'retained finalized source inputs', { nonempty: true }).map(input => {
    if (!object(input) || !integer(input.bytes) || typeof input.sha256 !== 'string' || !BARE_HASH.test(input.sha256)) throw Error('Invalid retained D11 source input');
    return { path: pathName(input.path), rawBytes: input.bytes, sha256: 'sha256:' + input.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  equal(build.sourceInputs, sourceInputs, 'D11 source inputs differ from finalized build evidence');
  if (Object.hasOwn(evidence, 'dependencyInputs')) {
    const dependencyInputs = array(evidence.dependencyInputs, 'retained finalized dependency inputs', { nonempty: true }).map(input => {
      if (!object(input) || !integer(input.bytes) || input.bytes > 64 * 1024 || !BARE_HASH.test(input.sha256 ?? '')) throw Error('Invalid retained D11 dependency input');
      equal(Object.keys(input).sort(), ['bytes', 'path', 'sha256'], 'D11 finalized dependency input fields differ');
      return { path: pathName(input.path), rawBytes: input.bytes, sha256: 'sha256:' + input.sha256 };
    }).sort((a, b) => a.path.localeCompare(b.path));
    equal(dependencyInputs.map(input => input.path).sort(), D11_INVOCATION_DEPENDENCY_PATHS, 'D11 finalized dependency inventory differs from the reviewed profile');
    equal(build.dependencyInputs, dependencyInputs, 'D11 dependency inputs differ from finalized build evidence');
    equal(build.compilation, evidence.compilation, 'D11 compilation capture differs from finalized build evidence');
  } else if (Object.hasOwn(build, 'dependencyInputs') || Object.hasOwn(build, 'compilation') || Object.hasOwn(evidence, 'compilation')) {
    throw Error('D11 legacy build cannot acquire dependency provenance absent from finalized evidence');
  }

  const entries = Object.entries(manifest), sourceByFile = new Map();
  for (const [, entry] of entries) {
    if (!object(entry)) throw Error('Invalid retained D11 manifest entry');
    pathName(entry.file);
    for (const key of ['imports', 'dynamicImports', 'css', 'assets']) if (entry[key] !== undefined) strings(entry[key], 'retained manifest ' + key);
    for (const key of [...entry.imports ?? [], ...entry.dynamicImports ?? []]) if (!Object.hasOwn(manifest, key)) throw Error('D11 retained manifest dependency is absent');
    if (entry.src !== undefined) { const sources = sourceByFile.get(entry.file) ?? []; sources.push(pathName(entry.src)); sourceByFile.set(entry.file, sources); }
  }
  const authoring = new Map();
  for (const font of text.fonts) {
    if (!object(font) || typeof font.sha256 !== 'string' || !BARE_HASH.test(font.sha256) || !integer(font.bytes)) throw Error('Invalid retained D11 authoring font identity');
    authoring.set('sha256:' + font.sha256, 'vendor/text/' + pathName(font.file));
  }
  const expectedFiles = [], emitted = new Map();
  for (const output of array(evidence.outputs, 'retained finalized outputs', { nonempty: true })) {
    if (!object(output) || !integer(output.bytes) || !integer(output.gzipBytes) || typeof output.sha256 !== 'string' || !BARE_HASH.test(output.sha256)) throw Error('Invalid retained D11 output identity');
    const file = pathName(output.file);
    if (emitted.has(file) || file === 'build-evidence.json') throw Error('Duplicate retained D11 output');
    const modules = strings(output.modules, 'retained output modules'), sources = [...sourceByFile.get(file) ?? []];
    strings(output.imports, 'retained output imports').forEach(pathName);
    for (const module of modules) if (!isD11VirtualModule(module)) sources.push(pathName(module.split('?')[0]));
    const sha256 = 'sha256:' + output.sha256;
    if (authoring.has(sha256)) sources.push(authoring.get(sha256));
    const kind = artifactKind(file);
    const value = { file, sha256, rawBytes: output.bytes, gzipBytes: output.gzipBytes, computedGzipBytes: output.gzipBytes,
      modules: [...modules], sources: sorted(sources), kind, authoringFont: kind === 'font' && authoring.has(sha256) };
    emitted.set(file, value); expectedFiles.push(value);
  }
  const indexBytes = Buffer.from(retained.index), indexHash = hash(indexBytes), indexGzip = gzipSync(indexBytes).length;
  if (!emitted.has('index.html')) {
    const index = { file: 'index.html', sha256: indexHash, rawBytes: indexBytes.length, gzipBytes: indexGzip, computedGzipBytes: indexGzip, modules: [], sources: ['index.html'], kind: 'other', authoringFont: false };
    emitted.set(index.file, index); expectedFiles.push(index);
  }
  else if (emitted.get('index.html').sha256 !== indexHash || emitted.get('index.html').rawBytes !== indexBytes.length || emitted.get('index.html').gzipBytes !== indexGzip) throw Error('D11 finalized HTML accounting differs from retained bytes');
  for (const [, entry] of entries) for (const file of [entry.file, ...entry.css ?? [], ...entry.assets ?? []]) if (!emitted.has(pathName(file))) throw Error('D11 retained manifest emitted file is absent');
  for (const output of evidence.outputs) for (const file of output.imports) if (!emitted.has(file)) throw Error('D11 retained output dependency is absent');
  function closure(key, seen = new Set(), files = new Set()) {
    if (seen.has(key)) return files;
    seen.add(key); const entry = manifest[key]; files.add(entry.file); (entry.css ?? []).forEach(file => files.add(file));
    for (const dependency of entry.imports ?? []) closure(dependency, seen, files);
    return files;
  }
  const dynamicFeatures = entries.filter(([, entry]) => entry.isDynamicEntry === true).map(([id, entry]) => ({ id, entryFile: entry.file, files: sorted(closure(id)) })).sort((a, b) => a.id.localeCompare(b.id));
  equal(build.dynamicFeatures, dynamicFeatures, 'D11 dynamic features differ from retained bundler manifest');
  const packages = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    pathName(path);
    if (!object(entry) || typeof entry.version !== 'string' || !entry.version || entry.version.length > 256 || entry.link === true) throw Error('Invalid retained D11 locked package');
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
    if (!match) throw Error('Invalid retained D11 locked package path');
    const name = typeof entry.name === 'string' ? entry.name : match[1];
    if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) throw Error('Invalid retained D11 locked package name');
    const versions = packages.get(name) ?? new Set(); versions.add(entry.version); packages.set(name, versions);
  }
  const duplicateVersions = [...packages].filter(([, versions]) => versions.size > 1).map(([name, versions]) => ({ package: name, versions: sorted(versions) })).sort((a, b) => a.package.localeCompare(b.package));
  equal(build.duplicateVersions, duplicateVersions, 'D11 duplicate versions differ from retained package lock');
  if (build.textWasmHash !== 'sha256:' + text.engine.wasm.sha256 || !expectedFiles.some(file => file.kind === 'wasm' && file.sha256 === build.textWasmHash && file.rawBytes === text.engine.wasm.bytes)) throw Error('D11 text WASM differs from retained engine manifest');
  const derived = deriveD11StaticDocument({ staticModule: retained.staticModule, index: retained.index });
  equal(build.bootstrap, derived.bootstrap, 'D11 bootstrap differs from retained compiled static module');
  equal(build.document, derived.document, 'D11 document differs from retained compiled static module and HTML');
  expectedFiles.push(derived.bootstrap);
  equal(build.files, expectedFiles.sort((a, b) => a.file.localeCompare(b.file)), 'D11 emitted accounting differs from retained finalized inputs');
  return retained;
}

function reproduceRoles(build, retained, sources) {
  const inputs = build.roleInputs;
  if (!object(inputs) || !object(inputs.sourceTextByPath) || !object(inputs.outputTextByFile)) throw Error('D11 retained role input bytes are absent');
  const hasInvocationCapture = Object.hasOwn(retained.buildEvidence, 'dependencyInputs');
  equal(Object.keys(inputs).sort(), ['outputTextByFile', 'parser', 'registrationContract', 'sourceTextByPath', ...(hasInvocationCapture ? ['invocationContract'] : [])].sort(), 'D11 retained role input fields differ');
  equal(build.roleContext, D11_ROLE_CONTEXT, 'D11 startup role context differs from the fixed campaign boundary');
  if (hasInvocationCapture) verifyD11CompilationCapture(build.compilation, { sourceTextByPath: inputs.sourceTextByPath });
  const registration = verifyD11RegistrationContract(inputs.registrationContract, { lock: retained.lock });
  const registrationPaths = new Set();
  for (const input of array(registration.inputs, 'registration input identities', { nonempty: true })) {
    const path = bindIdentity(input, sources, 'registration input');
    if (registrationPaths.has(path)) throw Error('Duplicate D11 registration input identity');
    registrationPaths.add(path);
  }
  if (hasInvocationCapture && inputs.invocationContract !== null) {
    // Registry archive identity is rooted in the retained lock SRI. Local
    // En Reve archives additionally belong to the external source receipt;
    // ignored node_modules files are never invented as source-receipt entries.
    const invocation = verifyD11InvocationContract(inputs.invocationContract, { lock: retained.lock,
      dependencyInputs: build.dependencyInputs, emittedModules: [...new Set(build.files.flatMap(file => file.modules))],
      compilation: build.compilation, sourceTextByPath: inputs.sourceTextByPath, sourceInputs: build.sourceInputs, outputTextByFile: inputs.outputTextByFile });
    for (const input of invocation.localArchiveInputs) bindIdentity(input, sources, 'invocation local archive');
  }
  const version = retained.lock.packages['node_modules/rolldown']?.version;
  if (typeof version !== 'string' || version !== rolldownVersion) throw Error('D11 role replay parser differs from retained package lock');
  equal(inputs.parser, { name: 'rolldown', version }, 'D11 role parser identity differs from retained package lock');
  const sourceInputs = build.sourceInputs.filter(input => /\.(?:[cm]?[jt]sx?|css|json)$/.test(input.path) || hasInvocationCapture && input.path === 'index.html');
  equal(Object.keys(inputs.sourceTextByPath).sort(), sourceInputs.map(input => input.path).sort(), 'D11 retained role source inventory differs');
  const outputInputs = build.files.filter(file => ['js', 'css'].includes(file.kind));
  equal(Object.keys(inputs.outputTextByFile).sort(), outputInputs.map(file => file.file).sort(), 'D11 retained role output inventory differs');
  function bytes(value, identity, label) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 64 * 1048576) throw Error('D11 retained role input must be bounded UTF-8 text');
    const encoded = Buffer.from(value);
    if (value.startsWith('\uFEFF') || encoded.toString('utf8') !== value || encoded.length !== identity.rawBytes || hash(encoded) !== identity.sha256) throw Error('D11 retained role bytes differ from sealed ' + label);
    return encoded;
  }
  for (const input of sourceInputs) bytes(inputs.sourceTextByPath[input.path], input, 'source');
  for (const file of outputInputs) {
    const encoded = bytes(inputs.outputTextByFile[file.file], file, 'output');
    if (gzipSync(encoded).length !== file.gzipBytes) throw Error('D11 emitted JavaScript/CSS gzip differs from retained bytes');
  }
  const roles = deriveD11Roles({ manifest: retained.manifest, files: build.files, sourceTextByPath: inputs.sourceTextByPath,
    outputTextByFile: inputs.outputTextByFile, parser: { name: 'rolldown', version, parseSync },
    registrationContract: inputs.registrationContract, roleContext: build.roleContext, lock: retained.lock,
    ...(hasInvocationCapture ? { invocationContract: inputs.invocationContract, dependencyInputs: build.dependencyInputs, compilation: build.compilation, sourceInputs: build.sourceInputs } : {}) });
  equal(build.roles, roles, 'D11 roles differ from retained source and output bytes');
}

function verifyBuild(build, compiled, sources) {
  if (!object(build) || build.kind !== 'perf-d11-build-1' || !HASH.test(build.sha256 ?? '')) throw Error('Invalid retained D11 build');
  const { sha256, ...body } = build;
  if (hash(canonical(body)) !== sha256) throw Error('D11 canonical build seal mismatch');
  if (!object(build.inputs)) throw Error('D11 retained build inputs are absent');
  equal(Object.keys(build.inputs).sort(), Object.keys(requiredInputs).sort(), 'D11 retained build input inventory differs');
  const appPaths = new Set();
  for (const [name, path] of Object.entries(requiredInputs)) if (build.inputs[name]?.path !== path) throw Error('D11 required build input differs: ' + name);
  for (const input of Object.values(build.inputs)) {
    const path = pathName(input?.path);
    bindIdentity(input, path.startsWith('dist/') ? compiled : sources, 'build input');
    if (path.startsWith('dist/app/')) appPaths.add(path);
  }
  const retained = reproduceBuildMetadata(build);
  const sourceNames = new Set();
  for (const input of array(build.sourceInputs, 'source inputs', { nonempty: true })) {
    const path = bindIdentity(input, sources, 'source input');
    if (sourceNames.has(path)) throw Error('Duplicate D11 source input');
    sourceNames.add(path);
  }
  const expectedSources = [...new Set([...requiredSources, ...[...sources].filter(([path, value]) => value && (path.startsWith('src/') || path.startsWith('tooling/theme/'))).map(([path]) => path)])].sort();
  equal([...sourceNames].sort(), expectedSources, 'D11 source input inventory differs from retained receipt sources');

  const files = new Map();
  for (const file of array(build.files, 'emitted files', { nonempty: true })) {
    if (!object(file)) throw Error('Invalid D11 emitted file');
    const path = pathName(file.file);
    if (files.has(path) || path === 'build-evidence.json') throw Error('Invalid or duplicate D11 emitted file');
    const inline = path === 'inline:bootstrap';
    if (!integer(file.gzipBytes) || file.computedGzipBytes !== file.gzipBytes || file.kind !== (inline ? 'js' : artifactKind(path)) || typeof file.authoringFont !== 'boolean' || file.authoringFont && file.kind !== 'font') throw Error('Invalid D11 emitted byte accounting');
    strings(file.modules, 'emitted modules'); strings(file.sources, 'emitted sources').forEach(pathName);
    if (file.modules.includes(D11_VITE_BROWSER_EXTERNAL) && sources.get(D11_VITE_BROWSER_EXTERNAL)) throw Error('D11 virtual module conflicts with a retained physical source: ' + D11_VITE_BROWSER_EXTERNAL);
    if (!inline) { bindIdentity({ ...file, path: 'dist/app/' + path }, compiled, 'emitted file'); appPaths.add('dist/app/' + path); }
    files.set(path, file);
  }
  equal([...appPaths].sort(), [...compiled.keys()].filter(path => path.startsWith('dist/app/')).sort(), 'D11 emitted inventory differs from retained receipt build');
  if (!HASH.test(build.textWasmHash ?? '') || ![...files.values()].some(file => file.kind === 'wasm' && file.sha256 === build.textWasmHash)) throw Error('D11 sealed text WASM is absent');
  const featureIds = new Set();
  for (const feature of array(build.dynamicFeatures, 'dynamic features')) {
    if (!object(feature) || typeof feature.id !== 'string' || !feature.id || featureIds.has(feature.id) || !files.has(feature.entryFile) || files.get(feature.entryFile).kind !== 'js') throw Error('Invalid D11 dynamic feature');
    if (!strings(feature.files, 'dynamic feature files').includes(feature.entryFile) || feature.files.some(file => !files.has(file))) throw Error('D11 dynamic feature contains an unknown emitted file');
    featureIds.add(feature.id);
  }
  const packages = new Set();
  for (const duplicate of array(build.duplicateVersions, 'duplicate versions')) {
    if (!object(duplicate) || typeof duplicate.package !== 'string' || !duplicate.package || packages.has(duplicate.package) || strings(duplicate.versions, 'package versions').length < 2) throw Error('Invalid D11 duplicate package versions');
    packages.add(duplicate.package);
  }
  reproduceRoles(build, retained, sources);
}

/** Shared build/AST replay for developer build artifacts and browser audits.
 * The caller supplies independently retained source and compiled identities.
 * No subject source path or emitted file is reopened. */
export function verifyD11RetainedBuild(build, { buildFiles, sourceFiles } = {}) {
  const compiled = receiptFiles(buildFiles, 'receipt build files'), sources = receiptFiles(sourceFiles, 'receipt source files', true);
  verifyBuild(build, compiled, sources);
  return build;
}

/** Reproduce a sealed byte-audit result using only retained packet content.
 * The caller verifies artifact bytes against its outer receipt before parsing.
 * This proves accounting/identity consistency, not a new browser observation. */
export function verifyD11RetainedObservation(payload, returnedD11, { buildFiles, sourceFiles, fixtureSeal } = {}) {
  if (!object(payload) || !object(payload.observation) || !object(payload.result) || !object(returnedD11)) throw Error('Missing retained D11 observation/result/build');
  if (fixtureSeal !== null && (typeof fixtureSeal !== 'string' || !HASH.test(fixtureSeal))) throw Error('Invalid retained D11 fixture seal');
  verifyD11RetainedBuild(payload.build, { buildFiles, sourceFiles });
  const { observation, result, build } = payload;
  if (observation.fixtureSeal !== fixtureSeal) throw Error('D11 fixture seal differs from consumed fixture');
  array(observation.evaluated, 'evaluated modules'); array(observation.resources, 'resources');
  if (!integer(returnedD11.evaluatedModuleCount) || returnedD11.evaluatedModuleCount !== observation.evaluated.length || !integer(returnedD11.resourceCount) || returnedD11.resourceCount !== observation.resources.length) throw Error('D11 returned observation counts differ');
  const recomputed = analyzeD11Observation(observation, build);
  equal(result, recomputed, 'Retained D11 result differs from reproduced observation');
  const { artifact: _artifact, evaluatedModuleCount: _evaluated, resourceCount: _resources, ...returned } = returnedD11;
  equal(returned, recomputed, 'Returned D11 result differs from reproduced observation');
  return recomputed;
}

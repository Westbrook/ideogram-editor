import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { deriveD11StaticDocument, loadD11Build } from '../../tooling/qualification/campaigns/browser-d11-build.mjs';
import { D11_ROLE_CONTEXT, prepareD11RegistrationContract, verifyD11RegistrationContract } from '../../tooling/qualification/campaigns/browser-d11-registration.mjs';
import { D11_INVOCATION_DEPENDENCY_PATHS, verifyD11InvocationContract } from '../../tooling/qualification/campaigns/browser-d11-invocation-contract.mjs';
import { measureD11StartupBuildBound } from '../../tooling/qualification/campaigns/browser-d11-startup-bound.mjs';
import { parseSync } from 'rolldown/utils';
import { deriveD11WorkerActivation, resolveD11EmittedWorkerTarget } from '../../tooling/qualification/campaigns/browser-d11-worker-activation.mjs';

import { deriveD11Roles } from '../../tooling/qualification/campaigns/browser-d11-roles.mjs';
import { verifyD11RetainedBuild } from '../../tooling/qualification/campaigns/browser-d11-verification.mjs';
import { observeD11Build } from '../../tooling/qualification/developer-campaigns/commands.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required = ['index.html', 'vite.app.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'package.json', 'package-lock.json', '.progress-report/project.json', 'tooling/build-evidence.ts', 'vendor/text/manifest.json'];
let registrationFixture;
async function reviewedRegistrationFixture() {
  // The verifier has no synthetic override for its reviewed dependency profile.
  // Read the two exact frozen archives once during future test setup; copy only
  // these retained inputs and selected public members into the isolated fixture.
  return registrationFixture ??= (async () => {
    const repo = await realpath(new URL('../../', import.meta.url));
    const read = async (path, maximum) => {
      const bytes = await readFile(join(repo, path));
      assert(bytes.length <= maximum);
      return { bytes };
    };
    const contract = await prepareD11RegistrationContract({ repo, read });
    const lock = JSON.parse((await read('package-lock.json', 16 * 1048576)).bytes);
    return { contract, lock };
  })();
}
const compiledStatic = [
  "import { readFile } from 'node:fs/promises';",
  "import { join } from 'node:path';",
  'export const BOOTSTRAP_PRELUDE = `globalThis.bootstrapObserved=true;`;',
  'export async function loadStatic(directory) {',
  'const files = new Map();',
  "let html = await readFile(join(directory, 'index.html'), 'utf8');",
  'const resources = [];',
  "html = html.replace(/<script\\b[^>]*\\bsrc=[^>]*><\\/script>|<link\\b[^>]*>/gi, tag => { resources.push(tag); return ''; });",
  "html = html.replace(/<\\/head>/i, `<template id=\"ie-resources\">${resources.join('')}</template></head>`);",
  'html = html.replace(/<head(?:\\s[^>]*)?>/i, match => `${match}<script>${BOOTSTRAP_PRELUDE}</script>`);',
  "files.set('/', { bytes: Buffer.from(html), type: 'text/html; charset=utf-8' });",
  'return files;',
  '}',
].join('\n');

// Small synthetic metadata specimens exercise integrity boundaries only. They
// are not runnable editor bundles, product fixtures, or performance evidence.
export async function d11BuildFixture(t) {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'd11-build-')));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const put = async (path, bytes) => { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), bytes); };
  const font = Buffer.from('font fixture bytes'), wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const controlRequire = createRequire(import.meta.url), parserEntry = controlRequire.resolve('rolldown'), parserUtils = controlRequire.resolve('rolldown/utils');
  const parserPackage = JSON.parse(await readFile(new URL('../../node_modules/rolldown/package.json', import.meta.url), 'utf8'));
  const profile = { engine: { wasm: { bytes: wasm.length, sha256: hash(wasm) } }, fonts: [{ file: 'fonts/example.ttf', bytes: font.length, sha256: hash(font) }] };
  const lock = { lockfileVersion: 3, packages: { '': { name: 'specimen', version: '1.0.0' }, 'node_modules/example': { version: '1.0.0' }, 'node_modules/other': { version: '1.0.0' }, 'node_modules/other/node_modules/example': { version: '2.0.0' }, 'node_modules/rolldown': { version: parserPackage.version } } };
  const reviewed = await reviewedRegistrationFixture();
  lock.packages[''].dependencies = {};
  for (const archive of reviewed.contract.archives) {
    lock.packages['node_modules/' + archive.package] = reviewed.lock.packages['node_modules/' + archive.package];
    lock.packages[''].dependencies[archive.package] = reviewed.lock.packages[''].dependencies[archive.package];
    await put(archive.path, Buffer.from(archive.data, 'base64'));
  }
  await put(reviewed.contract.packagesMetadata.path, reviewed.contract.packagesMetadata.text);
  for (const member of reviewed.contract.members) await put(member.installedPath, member.text);
  for (const path of required) await put(path, 'source ' + path);
  await put('package.json', JSON.stringify({ name: 'd11-specimen', type: 'module' }));
  await put('package-lock.json', JSON.stringify(lock));
  await put('src/text/profile.json', JSON.stringify(profile));
  await put('vendor/text/manifest.json', JSON.stringify(profile));
  await put('vendor/text/fonts/example.ttf', font);
  await put('src/main.ts', 'export const main = 1;');
  await put('src/lazy.ts', 'export const lazy = 1;');
  await put('src/nested.ts', 'export const nested = 1;');
  await put('tooling/theme/example.css', ':root{color:#000}');
  await put('node_modules/example/index.js', 'export const example = 1;');
  // Reuse the pinned test-process parser through tiny ordinary-file shims;
  // never clone dependency trees or substitute a fake parser implementation.
  await put('node_modules/rolldown/package.json', JSON.stringify({ name: 'rolldown', version: parserPackage.version, type: 'module', exports: { '.': './index.mjs', './utils': './utils.mjs' } }));
  await put('node_modules/rolldown/index.mjs', 'export { VERSION } from ' + JSON.stringify(pathToFileURL(parserEntry).href) + ';');
  await put('node_modules/rolldown/utils.mjs', 'export { parseSync } from ' + JSON.stringify(pathToFileURL(parserUtils).href) + ';');
  await put('server/static.ts', compiledStatic);
  await put('dist/local/server/static.js', compiledStatic);
  const manifest = {
    'index.html': { file: 'assets/main.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/lazy.ts'], css: ['assets/main.css'] },
    '_shared.js': { file: 'assets/shared.js' },
    'src/lazy.ts': { file: 'assets/lazy.js', src: 'src/lazy.ts', isDynamicEntry: true, imports: ['_shared.js'], dynamicImports: ['src/nested.ts'], css: ['assets/lazy.css'], assets: ['assets/example.ttf', 'assets/worker.js'] },
    'src/nested.ts': { file: 'assets/nested.js', src: 'src/nested.ts', isDynamicEntry: true },
    'vendor/text/fonts/example.ttf': { file: 'assets/example.ttf', src: 'vendor/text/fonts/example.ttf' },
  };
  const content = {
    'assets/main.js': ['import "./shared.js";', ['src/main.ts', '\0vite/modulepreload-polyfill.js'], ['assets/shared.js', 'assets/lazy.js']],
    'assets/shared.js': ['export const shared=1;', ['node_modules/example/index.js'], []],
    'assets/lazy.js': ['export const lazy=1;', ['src/lazy.ts'], ['assets/shared.js', 'assets/nested.js']],
    'assets/nested.js': ['export const nested=1;', ['src/nested.ts'], []],
    'assets/main.css': ['body{color:#111}', [], []],
    'assets/lazy.css': ['.lazy{color:#222}', [], []],
    'assets/example.ttf': [font, [], []],
    'assets/engine.wasm': [wasm, [], []],
    'assets/worker.js': ['postMessage("ready");', [], []],
    'index.html': ['<!doctype html><head><script src="/assets/main.js"></script></head><body></body>', [], []],
    '.vite/manifest.json': [JSON.stringify(manifest), [], []],
  };
  const outputs = [];
  for (const [file, [contentBytes, modules, imports]] of Object.entries(content)) {
    const bytes = Buffer.from(contentBytes); await put('dist/app/' + file, bytes);
    outputs.push({ file, bytes: bytes.length, sha256: hash(bytes), gzipBytes: gzipSync(bytes).length, modules, imports, entry: file === 'assets/main.js' });
  }
  const sourceInputs = [];
  for (const path of [...required, 'src/main.ts', 'src/lazy.ts', 'src/nested.ts', 'src/text/profile.json', 'tooling/theme/example.css'].sort()) {
    const bytes = await readFile(join(repo, path)); sourceInputs.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const evidence = { schema: 1, capture: { phase: 'writeBundle', finalized: true }, toolchain: { node: '26.10.0', npm: '12.1.0' }, sourceInputs, outputs };
  const saveEvidence = () => put('dist/app/build-evidence.json', JSON.stringify(evidence));
  const saveManifest = async () => {
    const bytes = Buffer.from(JSON.stringify(manifest)); await put('dist/app/.vite/manifest.json', bytes);
    Object.assign(outputs.find(output => output.file === '.vite/manifest.json'), { bytes: bytes.length, sha256: hash(bytes), gzipBytes: gzipSync(bytes).length }); await saveEvidence();
  };
  await saveEvidence();
  return { repo, put, evidence, manifest, profile, font, wasm, saveEvidence, saveManifest };
}
const fixture = d11BuildFixture;

test('D11 inventory binds actual raw/gzip bytes, exact fonts, and static lazy closures', async t => {
  const f = await fixture(t), result = await loadD11Build({ repo: f.repo });
  assert.equal(result.kind, 'perf-d11-build-1'); assert.match(result.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.files.length, f.evidence.outputs.length + 1);
  for (const output of f.evidence.outputs) {
    const measured = result.files.find(file => file.file === output.file);
    assert.equal(measured.rawBytes, output.bytes); assert.equal(measured.sha256, 'sha256:' + output.sha256);
    assert.equal(measured.gzipBytes, output.gzipBytes); assert.equal(measured.computedGzipBytes, output.gzipBytes);
  }
  assert.equal(result.files.find(file => file.file === 'assets/example.ttf').authoringFont, true);
  assert.deepEqual(result.files.find(file => file.file === 'assets/worker.js').modules, []);
  assert.deepEqual(result.dynamicFeatures.find(feature => feature.id === 'src/lazy.ts').files, ['assets/lazy.css', 'assets/lazy.js', 'assets/shared.js']);
  assert.deepEqual(result.duplicateVersions, [{ package: 'example', versions: ['1.0.0', '2.0.0'] }]);
  assert.match(result.duplicateVersionsScope, /execution is not implied/);
  assert.equal(result.textWasmHash, 'sha256:' + hash(f.wasm));
  assert.deepEqual(result.bootstrap, result.files.find(file => file.file === 'inline:bootstrap'));
  assert.equal(result.bootstrap.rawBytes, Buffer.byteLength('globalThis.bootstrapObserved=true;'));
  assert.equal(result.bootstrap.sha256, 'sha256:' + hash('globalThis.bootstrapObserved=true;'));
  assert.equal(result.toolchain.node, '26.10.0'); assert.equal(result.toolchain.built.npm, '12.1.0');
  assert.deepEqual(result.roleContext, D11_ROLE_CONTEXT);
  assert.equal(result.roleInputs.registrationContract.kind, 'perf-d11-registration-contract-1');
  assert.equal(result.retainedInputs.staticModule, compiledStatic);
  for (const [name, value] of Object.entries(result.retainedInputs)) {
    assert.equal(result.inputs[name].sha256, 'sha256:' + hash(value));
    assert.equal(result.inputs[name].rawBytes, Buffer.byteLength(value));
  }
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.files[0])); assert(Object.isFrozen(result.dynamicFeatures[0].files));
  assert.throws(() => result.files[0].sources.push('invented'));
  assert.equal((await loadD11Build({ repo: f.repo })).sha256, result.sha256);
});

test('D11 inventory measures final HTML even when a plugin bundle omits it', async t => {
  const f = await fixture(t);
  f.evidence.outputs = f.evidence.outputs.filter(output => !['index.html', '.vite/manifest.json'].includes(output.file));
  await f.saveEvidence();
  const result = await loadD11Build({ repo: f.repo });
  assert.equal(result.files.find(file => file.file === 'index.html').kind, 'other');
});

test('D11 refuses provisional evidence and missing finalized sources', async t => {
  const f = await fixture(t);
  f.evidence.capture.finalized = false; await f.saveEvidence();
  await assert.rejects(loadD11Build({ repo: f.repo }), /finalized build evidence/);
  f.evidence.capture.finalized = true; f.evidence.sourceInputs.pop(); await f.saveEvidence();
  await assert.rejects(loadD11Build({ repo: f.repo }), /source inventory/);
});

test('D11 refuses changed, added, or absent application inputs', async t => {
  const f = await fixture(t);
  await f.put('src/main.ts', 'unbuilt change');
  await assert.rejects(loadD11Build({ repo: f.repo }), /source changed/);
  await f.put('src/main.ts', 'export const main = 1;'); await f.put('src/added.ts', 'added');
  await assert.rejects(loadD11Build({ repo: f.repo }), /source inventory/);
  await rm(join(f.repo, 'src/added.ts')); await rm(join(f.repo, 'src/lazy.ts'));
  await assert.rejects(loadD11Build({ repo: f.repo }), /ENOENT/);
});

test('D11 refuses emitted hash, byte, and gzip mismatches separately', async t => {
  const f = await fixture(t), output = f.evidence.outputs[0], original = { ...output };
  for (const change of [{ sha256: '0'.repeat(64) }, { bytes: output.bytes + 1 }, { gzipBytes: output.gzipBytes + 1 }]) {
    Object.assign(output, original, change); await f.saveEvidence();
    await assert.rejects(loadD11Build({ repo: f.repo }), /raw\/hash\/gzip identity mismatch/);
  }
});

test('D11 refuses duplicate and traversal output paths before accepting evidence', async t => {
  const f = await fixture(t), original = f.evidence.outputs[0].file;
  f.evidence.outputs.push(f.evidence.outputs[0]); await f.saveEvidence();
  await assert.rejects(loadD11Build({ repo: f.repo }), /duplicate D11 emitted output/);
  f.evidence.outputs.pop(); f.evidence.outputs[0].file = '../outside.js'; await f.saveEvidence();
  await assert.rejects(loadD11Build({ repo: f.repo }), /canonical relative/);
  f.evidence.outputs[0].file = original;
});

test('D11 refuses unrecorded output and dangling manifest dependencies', async t => {
  const f = await fixture(t);
  await f.put('dist/app/assets/stale.js', 'stale');
  await assert.rejects(loadD11Build({ repo: f.repo }), /unrecorded output/);
  await rm(join(f.repo, 'dist/app/assets/stale.js')); f.manifest['src/lazy.ts'].imports.push('missing'); await f.saveManifest();
  await assert.rejects(loadD11Build({ repo: f.repo }), /manifest dependency is absent/);
});

test('D11 refuses symlinked repositories, source inputs, and emitted assets', async t => {
  const f = await fixture(t), link = f.repo + '-link';
  await symlink(f.repo, link); t.after(() => rm(link, { force: true }));
  await assert.rejects(loadD11Build({ repo: link }), /canonical directory/);
  const asset = join(f.repo, 'dist/app/assets/worker.js'), bytes = await readFile(asset);
  await f.put('worker-copy.js', bytes); await rm(asset); await symlink(join(f.repo, 'worker-copy.js'), asset);
  await assert.rejects(loadD11Build({ repo: f.repo }), /symlink/);
  await rm(asset); await writeFile(asset, bytes);
  await rm(join(f.repo, 'src/main.ts')); await symlink(join(f.repo, 'src/lazy.ts'), join(f.repo, 'src/main.ts'));
  await assert.rejects(loadD11Build({ repo: f.repo }), /symlink/);
});

test('D11 refuses oversized JSON without reading an unbounded payload', async t => {
  const f = await fixture(t); await truncate(join(f.repo, 'dist/app/build-evidence.json'), 16 * 1024 * 1024 + 1);
  await assert.rejects(loadD11Build({ repo: f.repo }), /byte or entry bound/);
});

test('D11 distinguishes exact authoring font/profile identity from file suffixes', async t => {
  const f = await fixture(t);
  await f.put('vendor/text/fonts/example.ttf', 'different bytes');
  await assert.rejects(loadD11Build({ repo: f.repo }), /vendor font bytes differ/);
  await f.put('vendor/text/fonts/example.ttf', f.font);
  await f.put('src/text/profile.json', JSON.stringify({ ...f.profile, changed: true }));
  await assert.rejects(loadD11Build({ repo: f.repo }), /profile differs/);
});

test('D11 derives bootstrap and served HTML offline without evaluating retained code', () => {
  const index = '<html><head><link href="/a.css"><script src="/a.js"></script></head><body></body></html>';
  const result = deriveD11StaticDocument({ staticModule: compiledStatic, index });
  const served = '<html><head><script>globalThis.bootstrapObserved=true;</script><template id="ie-resources"><link href="/a.css"><script src="/a.js"></script></template></head><body></body></html>';
  assert.equal(result.document.sha256, 'sha256:' + hash(served));
  assert.equal(result.document.gzipBytes, gzipSync(Buffer.from(served)).length);
  assert.equal(globalThis.bootstrapObserved, undefined);
  assert.throws(() => deriveD11StaticDocument({ staticModule: compiledStatic.replace('return files;', 'return different;'), index }), /unsupported/);
  assert.throws(() => deriveD11StaticDocument({ staticModule: compiledStatic.replace('globalThis.bootstrapObserved=true;', '${untrusted()}'), index }), /unescaped literal/);
});

test('D11 rejects an unqualified finalized build toolchain', async t => {
  const f = await fixture(t); f.evidence.toolchain.node = 'other'; await f.saveEvidence();
  await assert.rejects(loadD11Build({ repo: f.repo }), /finalized build must record pinned/);
});


// This selected product integration reads the real finalized output graph. It
// intentionally does not replace it with the all-members synthetic specimen.
test('D11 product integration verifies actual finalized invocation provenance and the static B01 bound', {
  skip: process.env.IE_CAMPAIGN_PRODUCT_INTEGRATION !== '1' && 'Requires selected IE_CAMPAIGN_PRODUCT_INTEGRATION=1.',
}, async () => {
  const cacheDirectory = process.env.IE_D11_NPM_CACHE;
  assert.equal(typeof cacheDirectory, 'string', 'Selected product integration requires explicit IE_D11_NPM_CACHE, as B01 does.');
  assert(cacheDirectory.length > 0, 'Selected product integration requires a nonempty IE_D11_NPM_CACHE.');
  const repo = await realpath(new URL('../../', import.meta.url));
  const result = await loadD11Build({ repo, cacheDirectory });
  assert.equal(result.kind, 'perf-d11-build-1');
  // loadD11Build prepares and verifies this contract against the actual emitted
  // modules before returning. Missing cache evidence must not turn into a skip.
  assert(result.roleInputs.invocationContract, 'Actual finalized output must retain its verified invocation contract.');
  assert.equal(result.roleInputs.invocationContract.kind, 'perf-d11-invocation-contract-1');
  assert.deepEqual(result.dependencyInputs.map(input => input.path).sort(), [...D11_INVOCATION_DEPENDENCY_PATHS]);
  // This is B01's unchanged static bound, not fetched/evaluated startup evidence
  // or a completed performance qualification.
  const bound = measureD11StartupBuildBound(result);
  assert.equal(bound.status, 'PASS', JSON.stringify({ missing: bound.missing, failures: bound.failures,
    artifactBuildBudgets: bound.artifactBuildBudgets, artifactBuildViolations: bound.artifactBuildViolations }));
});

// Actual-output Worker authority belongs here with the application-build
// prerequisite, rather than in the build-free Worker source/grammar suite.
test('actual finalized Vite Worker URL traverses the unchanged source and invocation authority', {
  skip: process.env.IE_CAMPAIGN_PRODUCT_INTEGRATION !== '1' && 'Requires selected IE_CAMPAIGN_PRODUCT_INTEGRATION=1.',
}, async () => {
  const cacheDirectory = process.env.IE_D11_NPM_CACHE;
  assert.equal(typeof cacheDirectory, 'string', 'Selected product integration requires explicit IE_D11_NPM_CACHE.');
  assert(cacheDirectory.length > 0, 'Selected product integration requires a nonempty IE_D11_NPM_CACHE.');
  const repo = await realpath(new URL('../../', import.meta.url));
  const parser = { name: 'rolldown', version: createRequire(import.meta.url)('rolldown/package.json').version, parseSync };
  const build = await loadD11Build({ repo, cacheDirectory });
  assert(build.roleInputs.invocationContract, 'Finalized output must retain its authentic invocation contract.');
  const input = { ...build.roleInputs, parser, files: build.files, roleContext: build.roleContext,
    lock: JSON.parse(build.retainedInputs.lock), dependencyInputs: build.dependencyInputs,
    compilation: build.compilation, sourceInputs: build.sourceInputs };
  const result = deriveD11WorkerActivation(input);
  assert.equal(result.complete, true, result.missing.join('; '));
  assert.equal(result.excludedWorkers.length, 1);
  const proof = result.excludedWorkers[0];
  assert.equal(proof.source, 'src/text/client.ts');
  assert.equal(proof.witness.applicationSourceProfile.profile, 'reviewed-d11-startup-corpus-1');
  const importer = proof.emittedSite.file, output = build.roleInputs.outputTextByFile[importer];
  const expression = output.slice(proof.emittedSite.start, proof.emittedSite.end);
  const parsed = parseSync('emitted-worker.js', expression + ';', { lang: 'js', sourceType: 'module' });
  assert.equal(parsed.errors?.length ?? 0, 0);
  assert.equal(parsed.program.body.length, 1);
  assert.equal(parsed.program.body[0].type, 'ExpressionStatement');
  const worker = parsed.program.body[0].expression;
  assert.equal(worker.type, 'NewExpression'); assert.equal(worker.callee.name, 'Worker');
  assert.equal(resolveD11EmittedWorkerTarget({ url: worker.arguments[0], importer, files: build.files }), proof.target);
  assert.equal(build.files.filter(file => file.file === proof.target && file.kind === 'js').length, 1);
  const missingTarget = deriveD11WorkerActivation({ ...input, files: build.files.filter(file => file.file !== proof.target) });
  assert.equal(missingTarget.complete, false); assert.deepEqual(missingTarget.excludedWorkers, []);
  assert.match(missingTarget.missing.join('; '), /emitted Worker target is absent or ambiguous/);
  const missingAuthority = deriveD11WorkerActivation({ ...input, invocationContract: undefined });
  assert.equal(missingAuthority.complete, false); assert.deepEqual(missingAuthority.excludedWorkers, []);
});

test('actual compiled feature graph retains shared costs, rejects unproved refinement, and replays from independent file identities', {
  skip: process.env.IE_CAMPAIGN_PRODUCT_INTEGRATION !== '1' && 'Requires selected IE_CAMPAIGN_PRODUCT_INTEGRATION=1.',
}, async () => {
  const cacheDirectory = process.env.IE_D11_NPM_CACHE;
  assert.equal(typeof cacheDirectory, 'string', 'Selected product integration requires explicit IE_D11_NPM_CACHE.');
  assert(cacheDirectory.length > 0, 'Selected product integration requires a nonempty IE_D11_NPM_CACHE.');
  const repo = await realpath(new URL('../../', import.meta.url));
  const build = await loadD11Build({ repo, cacheDirectory });
  const manifest = JSON.parse(build.retainedInputs.manifest), lock = JSON.parse(build.retainedInputs.lock);
  const parser = { name: 'rolldown', version: createRequire(import.meta.url)('rolldown/package.json').version, parseSync };
  const input = { ...build.roleInputs, manifest, parser, files: build.files, roleContext: build.roleContext,
    lock, dependencyInputs: build.dependencyInputs, compilation: build.compilation, sourceInputs: build.sourceInputs };
  const byFile = new Map(build.files.map(file => [file.file, file]));
  const named = name => {
    const entries = Object.values(manifest).filter(entry => entry.name === name);
    assert.equal(entries.length, 1, 'Actual emitted fixture entry changed: ' + name);
    return entries[0].file;
  };
  // Source attribution is independent of generated chunk names. This reviewed
  // declaration remains present while its shell-owned implementation is absent
  // from the importing chunk's emitted static dependencies.
  const sourcePath = 'src/protocol/validate.ts', targetSource = 'src/protocol/request-edits.ts';
  const attributedOutput = path => {
    const owners = build.files.filter(file => file.kind === 'js' && file.modules.includes(path));
    assert.equal(owners.length, 1, 'Exact emitted source attribution changed: ' + path);
    return owners[0].file;
  };
  const origin = attributedOutput(sourcePath), shell = attributedOutput(targetSource), featureEntry = named('export');
  assert.equal(shell, named('shell'));assert.notEqual(origin, shell);
  const source = input.sourceTextByPath[sourcePath];
  const expression = "import {validateRequestSourceCapture} from './request-edits.js';";
  assert.equal(source.slice(479, 543), expression);assert.equal(source.indexOf(expression), 479);
  assert.equal(source.indexOf(expression, 480), -1);
  const graph = build.roles.staticImportGraph;
  assert.equal(build.roles.complete, true, build.roles.missing.join('; '));
  assert.equal(graph?.kind, 'd11-emitted-static-graph-1');
  assert.equal(graph.policy, 'verified-compiled-chunk-dependencies');
  assert(!graph.edges.some(edge => edge.output === origin && edge.target === shell));
  const omitted = graph.omittedSourceAttributions.filter(edge => edge.source === sourcePath && edge.start === 479 && edge.end === 543 && edge.output === origin && edge.target === shell);
  assert.equal(omitted.length, 1);
  assert.equal(omitted[0].sourceSha256, 'sha256:' + hash(source));
  assert.equal(omitted[0].expressionSha256, 'sha256:' + hash(source.slice(omitted[0].start, omitted[0].end)));
  const feature = build.roles.lazyFeatures.find(row => row.id === 'src/ui/export.ts');
  const expectedFeature = ['export', 'browser', 'model-memory', 'lit', 'adapter-upload-hook', 'preload-helper', 'adapters', 'display-image', 'sha256'].map(named).sort();
  assert.deepEqual(feature.files, expectedFeature);
  assert.deepEqual(feature.closureFiles, expectedFeature);
  assert(expectedFeature.includes(origin), 'The refined source owner remains charged to the Export closure.');
  const shared = expectedFeature.filter(file => file !== featureEntry);
  assert(shared.every(file => build.roles.startupFiles.includes(file)), 'Shared startup dependencies must remain charged to the feature.');
  assert(!build.roles.startupFiles.includes(featureEntry));
  // Recompress the exact named files independently of the role reducer. Their
  // identities and membership stay strict as compiled product bytes evolve.
  const independentGzip = new Map();
  for (const file of expectedFeature) {
    const bytes = await readFile(join(repo, 'dist/app', file)), recorded = byFile.get(file);
    assert.equal(bytes.length, recorded.rawBytes, file);
    assert.equal('sha256:' + hash(bytes), recorded.sha256, file);
    independentGzip.set(file, gzipSync(bytes).length);
  }
  const expectedSharedGzip = shared.reduce((sum, file) => sum + independentGzip.get(file), 0);
  assert.equal(shared.reduce((sum, file) => sum + byFile.get(file).gzipBytes, 0), expectedSharedGzip);
  // Independently traverse the finalized manifest. These fixed source roots
  // are the reviewed main/shell/Open path plus the conservatively charged
  // adapter observer; the three proved private action features are not roots.
  // Worker/font asset URLs are separately proved and budgeted, not JS imports.
  const staticFiles = roots => {
    const found = new Set(), visited = new Set(), pending = [...roots];
    while (pending.length) {
      const key = pending.pop(); if (visited.has(key)) continue; visited.add(key);
      const entry = manifest[key]; assert(entry, 'Manifest fixture root/import missing: ' + key);
      found.add(entry.file); for (const css of entry.css ?? []) found.add(css);
      pending.push(...entry.imports ?? []);
    }
    return [...found].sort();
  };
  assert.deepEqual(staticFiles(['src/ui/export.ts']), expectedFeature, 'Independent manifest traversal must match all nine reviewed feature files.');
  const startupExpected = [...staticFiles(['index.html', 'src/ui/shell.ts', 'src/ui/editor-panels.ts', 'src/observability/adapter-upload.ts']), 'inline:bootstrap'].sort();
  assert.deepEqual(build.roles.startupFiles, startupExpected);
  const storageEntry = named('storage-library'), importEntry = named('image-import');
  assert.deepEqual(build.roles.excludedImports.map(item => item.target).sort(), [featureEntry, storageEntry, importEntry].sort());
  assert(build.roles.startupUpperBounds.some(item => item.target === named('adapter-upload')));
  assert(!build.roles.startupUpperBounds.some(item => item.target === storageEntry));
  assert.deepEqual(build.roles.lazyFeatures.find(row => row.id === 'src/ui/storage-library.ts').files, staticFiles(['src/ui/storage-library.ts']));
  assert(!build.roles.startupFiles.includes(importEntry));
  assert(!build.roles.startupUpperBounds.some(item => item.target === importEntry));
  const imageImport = build.roles.lazyFeatures.find(row => row.id === 'src/ui/image-import.ts');
  assert.deepEqual(imageImport.files, staticFiles(['src/ui/image-import.ts']));
  assert.deepEqual(imageImport.closureFiles, imageImport.files);
  const importWitness = build.roles.excludedImports.find(item => item.target === importEntry).witness;
  assert.equal(importWitness.activationGraph.kind, 'd11-runtime-private-event-graph-1');
  assert.deepEqual(importWitness.dependencyEffects, ['nativeFileUploadStartupChange']);
  assert.equal(Object.hasOwn(importWitness, 'publicAction'), false, 'Multiple import routes cannot claim one universal first-use action.');
  const gzipTotal = files => files.reduce((sum, file) => sum + byFile.get(file).gzipBytes, 0);
  const expectedStartupGzip = gzipTotal(startupExpected.filter(file => byFile.get(file).kind === 'js'));
  const expectedFeatureWithShellGzip = gzipTotal(staticFiles(['src/ui/export.ts', 'src/ui/shell.ts']));
  assert(expectedFeatureWithShellGzip > 307_200, 'The emitted-edge control must still exercise the unchanged feature ceiling.');
  const audit = observeD11Build(build);
  assert.equal(audit.status, 'PASS', JSON.stringify({ missing: audit.missing, budgets: audit.budgets, violations: audit.violations }));
  assert.equal(audit.features.find(row => row.id === feature.id).gzipBytes, expectedSharedGzip + independentGzip.get(featureEntry));
  assert.equal(audit.measurements.find(row => row.name === 'D11BuildStartupJsGzipBytes').value, expectedStartupGzip);

  const canonical = value => JSON.stringify(value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
  const seal = value => { const { sha256: _old, ...body } = value; return { ...body, sha256: 'sha256:' + hash(canonical(body)) }; };
  const changedOutput = text => {
    const bytes = Buffer.from(text), gzipBytes = gzipSync(bytes).length;
    return { ...input, outputTextByFile: { ...input.outputTextByFile, [origin]: text },
      files: build.files.map(file => file.file === origin ? { ...file, rawBytes: bytes.length,
        sha256: 'sha256:' + hash(bytes), gzipBytes, computedGzipBytes: gzipBytes } : file) };
  };
  // This is a synthetic role-analysis control, not a finalized build or an
  // authenticated receipt. Reintroducing a real emitted dependency must count
  // its full closure; a fresh canonical reducer seal does not authenticate it.
  const reintroduced = changedOutput(`import ${JSON.stringify('./' + shell.slice(shell.lastIndexOf('/') + 1))};\n` + input.outputTextByFile[origin]);
  const mutantRoles = deriveD11Roles(reintroduced);
  assert.equal(mutantRoles.complete, true, mutantRoles.missing.join('; '));
  assert(mutantRoles.staticImportGraph.edges.some(edge => edge.output === origin && edge.target === shell));
  assert(!mutantRoles.staticImportGraph.omittedSourceAttributions.some(edge => edge.output === origin && edge.target === shell));
  assert.deepEqual(mutantRoles.startupFiles, build.roles.startupFiles, 'The dependency was already startup-owned.');
  const delta = reintroduced.files.find(file => file.file === origin).gzipBytes - byFile.get(origin).gzipBytes;
  const mutantAudit = observeD11Build(seal({ ...build, files: reintroduced.files, roles: mutantRoles,
    roleInputs: { ...build.roleInputs, outputTextByFile: reintroduced.outputTextByFile } }));
  assert.equal(mutantAudit.status, 'FAIL');
  assert.equal(mutantAudit.features.find(row => row.id === feature.id).gzipBytes, expectedFeatureWithShellGzip + delta);
  assert.equal(mutantAudit.measurements.find(row => row.name === 'D11BuildStartupJsGzipBytes').value, expectedStartupGzip + delta);
  assert.equal(mutantAudit.budgets.find(row => row.name === 'D11BuildLazyFeatureGzipBytes').ceiling, 307_200);
  assert.equal(mutantAudit.budgets.find(row => row.name === 'D11BuildLazyFeatureGzipBytes').outcome, 'FAIL');

  // Every control below must lose graph-refinement authority. No source name,
  // source attribution, or caller-authored graph substitutes for the contract.
  for (const [label, change] of [
    ['null invocation', () => ({ ...input, invocationContract: null })],
    ['forged invocation', () => ({ ...input, invocationContract: { ...input.invocationContract, profile: 'unreviewed' } })],
    ['changed compiler', () => ({ ...input, compilation: { ...input.compilation, configFile: 'other.config.ts' } })],
    ['changed corpus', () => ({ ...input, sourceTextByPath: { ...input.sourceTextByPath, 'src/main.ts': input.sourceTextByPath['src/main.ts'] + '\n' } })],
    ['missing output', () => { const outputTextByFile = { ...input.outputTextByFile }; delete outputTextByFile[origin]; return { ...input, outputTextByFile }; }],
    ['stale output identity', () => ({ ...input, outputTextByFile: { ...input.outputTextByFile, [origin]: input.outputTextByFile[origin] + '\n' } })],
    ['unknown static target', () => changedOutput('import "./unrecorded.js";\n' + input.outputTextByFile[origin])],
    ['malformed emitted import', () => changedOutput('import ;\n' + input.outputTextByFile[origin])],
  ]) {
    const refused = deriveD11Roles(change());
    assert.equal(refused.complete, false, label);
    assert.equal(Object.hasOwn(refused, 'staticImportGraph'), false, label);
    assert(refused.missing.length > 0, label);
  }

  // Independently read actual files to form a test-local outer identity map.
  // These rows are neither copied hashes from the packet nor a campaign receipt.
  const registration = verifyD11RegistrationContract(input.registrationContract, { lock });
  const invocation = verifyD11InvocationContract(input.invocationContract, { ...input,
    emittedModules: [...new Set(build.files.flatMap(file => file.modules))] });
  const sourcePaths = new Set([...build.sourceInputs.map(row => row.path),
    ...Object.values(build.inputs).filter(row => !row.path.startsWith('dist/')).map(row => row.path),
    ...registration.inputs.map(row => row.path), ...invocation.localArchiveInputs.map(row => row.path)]);
  const buildPaths = new Set([...Object.values(build.inputs).filter(row => row.path.startsWith('dist/')).map(row => row.path),
    ...build.files.filter(row => row.file !== 'inline:bootstrap').map(row => 'dist/app/' + row.file)]);
  const independentRows = async (paths, prefix) => {
    const rows = [];
    for (const path of [...paths].sort()) { const bytes = await readFile(join(repo, path)); rows.push({ path, bytes: bytes.length, sha256: prefix + hash(bytes) }); }
    return rows;
  };
  const identities = { sourceFiles: await independentRows(sourcePaths, ''), buildFiles: await independentRows(buildPaths, 'sha256:') };
  const serialized = JSON.stringify(build), retained = JSON.parse(serialized);
  assert.deepEqual(verifyD11RetainedBuild(retained, identities), build);
  assert.equal(JSON.stringify(retained), serialized, 'Replay must not mutate the retained packet.');
  assert.deepEqual(verifyD11RetainedBuild(JSON.parse(serialized), identities), retained, 'Complete retained replay must be deterministic.');
  const forged = JSON.parse(serialized);
  forged.roles.staticImportGraph.omittedSourceAttributions[0].expressionSha256 = 'sha256:' + '0'.repeat(64);
  assert.throws(() => verifyD11RetainedBuild(seal(forged), identities), /D11 roles differ from retained source and output bytes/);
});

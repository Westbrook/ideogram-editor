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
import { D11_ROLE_CONTEXT, prepareD11RegistrationContract } from '../../tooling/qualification/campaigns/browser-d11-registration.mjs';
import { D11_INVOCATION_DEPENDENCY_PATHS } from '../../tooling/qualification/campaigns/browser-d11-invocation-contract.mjs';
import { measureD11StartupBuildBound } from '../../tooling/qualification/campaigns/browser-d11-startup-bound.mjs';
import { parseSync } from 'rolldown/utils';
import { deriveD11WorkerActivation, resolveD11EmittedWorkerTarget } from '../../tooling/qualification/campaigns/browser-d11-worker-activation.mjs';

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

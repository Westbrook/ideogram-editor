import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { measureD11StartupBuildBound, D11_STARTUP_BUILD_LIMITS } from '../../tooling/qualification/campaigns/browser-d11-startup-bound.mjs';
import { D11_ROLE_CONTEXT } from '../../tooling/qualification/campaigns/browser-d11-registration.mjs';

const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const seal = build => { delete build.sha256; build.sha256 = sha(canonical(build)); return build; };
// These unit specimens test reduction and refusal, not source classification,
// browser execution, archive provenance or a qualifying performance result.
function specimen() {
  const file = (name, kind, rawBytes, gzipBytes, authoringFont = false) => ({ file: name, kind, rawBytes, gzipBytes, computedGzipBytes: gzipBytes, sha256: sha(name), modules: [], sources: [], authoringFont });
  const files = [file('assets/main.js', 'js', 100, 70), file('assets/shared.js', 'js', 50, 30),
    file('inline:bootstrap', 'js', 20, 10), file('assets/feature.js', 'js', 2 * 1024 * 1024, 200 * 1024),
    file('assets/engine.wasm', 'wasm', 1000, 200), file('assets/style.css', 'css', 40, 30), file('assets/ui.woff2', 'font', 80, 70)];
  return seal({ kind: 'perf-d11-build-1', files, roleContext: structuredClone(D11_ROLE_CONTEXT),
    bootstrap: files.find(file => file.file === 'inline:bootstrap'), textWasmHash: files.find(file => file.kind === 'wasm').sha256,
    duplicateVersions: [{ package: 'example', versions: ['1.0.0', '2.0.0'] }],
    dynamicFeatures: [{ id: 'src/ui/feature.ts', entryFile: 'assets/feature.js', files: ['assets/feature.js', 'assets/shared.js'] }],
    roles: { complete: true, missing: [], startupFiles: ['assets/main.js', 'assets/shared.js', 'inline:bootstrap', 'assets/style.css', 'assets/ui.woff2'],
      lazyFeatures: [{ id: 'src/ui/feature.ts', files: ['assets/feature.js', 'assets/shared.js'] }], textEngineFiles: ['assets/engine.wasm'],
      uiCssFontFiles: ['assets/style.css', 'assets/ui.woff2'] } });
}

test('startup bound includes whole startup/shared/bootstrap and UI font artifacts without claiming evaluation', () => {
  const build = specimen(), value = measureD11StartupBuildBound(build);
  assert.equal(value.status, 'PASS'); assert.equal(value.qualification, false);
  assert.deepEqual(value.bounds, { jsRawBytes: 170, jsGzipBytes: 110, uiCssFontGzipBytes: 100,
    startupFiles: ['assets/main.js', 'assets/shared.js', 'inline:bootstrap'], uiCssFontFiles: ['assets/style.css', 'assets/ui.woff2'] });
  assert.deepEqual(value.duplicateVersions, build.duplicateVersions);
  assert.match(value.scope, /not an evaluated-module or transfer observation/);
  assert.equal(value.artifactBuildStatus, 'PASS');
  assert.equal(value.artifactBuildMeasurements.length, 5);
  assert(build.files.reduce((sum, file) => sum + file.rawBytes, 0) > D11_STARTUP_BUILD_LIMITS.jsRawBytes);
});

test('incomplete static roles cannot produce a narrowed startup bound', () => {
  const build = specimen(); build.roles.complete = false; build.roles.missing = ['unresolved constructor callback']; seal(build);
  const value = measureD11StartupBuildBound(build);
  assert.equal(value.status, 'INCONCLUSIVE'); assert.equal(value.bounds, null);
  assert(value.missing.some(reason => reason.includes('unresolved constructor callback')));
});

test('failure of any independent C feature budget blocks the startup-bound pass', () => {
  const build = specimen(), feature = build.files.find(file => file.file === 'assets/feature.js'); feature.gzipBytes = feature.computedGzipBytes = 400 * 1024; seal(build);
  const value = measureD11StartupBuildBound(build);
  assert.equal(value.artifactBuildStatus, 'FAIL'); assert.equal(value.status, 'FAIL'); assert.equal(value.bounds, null);
  assert(value.artifactBuildBudgets.some(budget => budget.outcome === 'FAIL'));
});

test('B01 remains strict at the exact raw ceiling, even when the C gzip audit passes', () => {
  const build = specimen(); build.files.find(file => file.file === 'assets/main.js').rawBytes = D11_STARTUP_BUILD_LIMITS.jsRawBytes - 70; seal(build);
  const value = measureD11StartupBuildBound(build);
  assert.equal(value.artifactBuildStatus, 'PASS'); assert.equal(value.bounds.jsRawBytes, D11_STARTUP_BUILD_LIMITS.jsRawBytes);
  assert.equal(value.status, 'FAIL'); assert.match(value.failures[0], /strict B01/);
});

test('B01 remains strict at the exact gzip and CSS/font ceilings', () => {
  for (const [path, field, limit, remainder] of [['assets/main.js', 'jsGzipBytes', 500 * 1024, 40], ['assets/style.css', 'uiCssFontGzipBytes', 200 * 1024, 70]]) {
    const build = specimen(), file = build.files.find(file => file.file === path); file.gzipBytes = file.computedGzipBytes = limit - remainder; seal(build);
    const value = measureD11StartupBuildBound(build);
    assert.equal(value.artifactBuildStatus, 'PASS'); assert.equal(value.bounds[field], limit); assert.equal(value.status, 'FAIL');
  }
});

test('distinct emitted paths with the same content hash are each charged', () => {
  const build = specimen(), shared = build.files.find(file => file.file === 'assets/shared.js');
  build.files.push({ ...shared, file: 'assets/duplicate-shared.js' }); build.roles.startupFiles.push('assets/duplicate-shared.js'); seal(build);
  const value = measureD11StartupBuildBound(build);
  assert.equal(value.bounds.jsRawBytes, 220); assert.equal(value.bounds.jsGzipBytes, 140);
});

test('missing bootstrap or a changed fixed viewport cannot authorize subtraction', () => {
  for (const mutate of [build => { build.roles.startupFiles = build.roles.startupFiles.filter(path => path !== 'inline:bootstrap'); }, build => { build.roleContext.viewport.width = 1280; }]) {
    const build = specimen(); mutate(build); seal(build);
    const value = measureD11StartupBuildBound(build); assert.equal(value.status, 'INCONCLUSIVE'); assert.equal(value.bounds, null);
  }
});

test('corrupted inventory seals and duplicate role paths are rejected', () => {
  const corrupted = specimen(); corrupted.files[0].rawBytes--;
  assert.throws(() => measureD11StartupBuildBound(corrupted), /seal/);
  const duplicate = specimen(); duplicate.roles.startupFiles.push('assets/main.js'); seal(duplicate);
  assert.throws(() => measureD11StartupBuildBound(duplicate), /duplicated/);
});

// Pure synthetic data contracts. These invented hashes cannot establish any
// actual compiler output, source review, native acceptance, or qualification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {canonical} from '../../tooling/raster/import-seals/pinned-canonical.mjs';
import {normalizeAlphaBaseline, assertAlphaBaselineTemplate, assertReleasedAlphaBaseline} from '../../tooling/raster/import-seals/webp-alpha-baseline-template.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const toolingPath = 'tooling/raster/import-seals/webp-alpha-authority.mjs';
const testPath = 'tests/raster/webp-alpha-baseline-template.test.mjs';
const observedCommonSourcePaths = [toolingPath, testPath];
const modules = ['server/raster/webp-import/tile-plan.ts', 'server/raster/webp-import/adapter.ts',
  'server/raster/import-profile.ts', 'server/raster/import-producers.ts', 'server/raster/profile-registry.ts',
  'server/raster/inspect-original.ts', 'server/storage/raster.ts', 'server/raster/import-inventory.ts'];
const pin = repositoryPath => ({repositoryPath, bytes: 12, hash: hash(repositoryPath)});
function refresh(value) {
  value.sourceAuthorityHash = hash({commonOverlay: value.commonOverlay, canonicalCorrection: value.canonicalCorrection,
    commonSourceTargets: value.commonSourceTargets});
  if (value.compiledCapture) value.compiledCapture.commonSourceAuthorityHash = value.sourceAuthorityHash;
  return value;
}
function pending() {
  const overlayHash = hash('reviewed predecessor overlay');
  return refresh({kind: 'webp-candidate-loader-reviewed-inputs-v1', status: 'pending-genuine-compiled-review',
    commonOverlay: {kind: 'oversized-import-capsule-source-overlay-v2', manifestPath: 'ancestry/common/manifest.json',
      manifestHash: overlayHash, manifestBytes: 17, requiredTargets: 17},
    canonicalCorrection: {kind: 'node26-pinned-canonical-correction-v1', manifestPath: 'ancestry/canonical/manifest.json',
      manifestHash: hash('reviewed correction'), manifestBytes: 23, dependsOnCommonManifestHash: overlayHash,
      selectedTargets: ['tooling/raster/import-seals/pinned-canonical.mjs'], excludedPngTargets: ['tooling/raster/import-issuance/png-contract.mjs']},
    commonSourceTargets: [pin(modules[2]), pin(toolingPath), pin(testPath)], requiredSharedTargets: 3,
    sourceAuthorityHash: null, compiledCapture: null,
    modules: modules.map((repositoryPath, index) => ({role: index === 7 ? 'guard-only' : 'transform', source: pin(repositoryPath),
      compiled: {repositoryPath: 'dist/local/' + repositoryPath.replace(/\.ts$/, '.js'), bytes: null, hash: null}})),
  });
}
function released() {
  const value = pending(); value.status = 'compiled-reviewed-unexecuted';
  for (const row of value.modules) row.compiled = pin(row.compiled.repositoryPath);
  value.compiledCapture = {kind: 'webp-candidate-compiled-review-v1', reviewed: true, node: '26.10.0',
    commonOverlayHash: value.commonOverlay.manifestHash, canonicalCorrectionHash: value.canonicalCorrection.manifestHash,
    sourceHash: hash('actual full source'), compiledHash: hash('actual full compiled'), runtimeDependenciesHash: hash('actual runtime'),
    commonSourceAuthorityHash: value.sourceAuthorityHash, buildProof: {path: '/captured/build/build-proof.json', bytes: 37, hash: hash('actual proof')},
    retainedModules: value.modules.map((row, index) => ({path: '/captured/modules/' + index + '.js', ...row.compiled})),
  };
  return value;
}
const optionsFor = value => ({observedCommonSourcePaths, expectedTemplate: normalizeAlphaBaseline(value, {observedCommonSourcePaths})});

test('pending source template preserves all eight null module pins and refuses release', () => {
  const value = pending(), original = structuredClone(value), options = optionsFor(value);
  const result = assertAlphaBaselineTemplate(value, options);
  assert.deepEqual(value, original); assert.deepEqual(result.baseline, value); assert.equal(result.capture, null);
  assert(Object.isFrozen(result) && Object.isFrozen(result.baseline.modules[0].compiled));
  assert.deepEqual(options.expectedTemplate.modules, value.modules);
  assert.equal(options.expectedTemplate.commonSourceTargets[0].hash, value.commonSourceTargets[0].hash);
  assert.equal(options.expectedTemplate.commonSourceTargets[1].hash, null);
  assert.throws(() => assertReleasedAlphaBaseline(value, options), /compiled review remains pending/);
});

test('explicit observed sources and capture records can change without changing code authority', () => {
  const value = released(), options = optionsFor(value), next = structuredClone(value);
  for (const row of next.commonSourceTargets.filter(row => observedCommonSourcePaths.includes(row.repositoryPath))) {
    row.bytes += 5; row.hash = hash('new final bytes ' + row.repositoryPath);
  }
  refresh(next);
  for (const key of ['sourceHash', 'compiledHash', 'runtimeDependenciesHash']) next.compiledCapture[key] = hash('recaptured ' + key);
  next.compiledCapture.buildProof = {path: '/final-build/build-proof.json', bytes: 99, hash: hash('final compiler proof')};
  for (const row of next.compiledCapture.retainedModules) row.path = '/final-build/modules/' + row.path.split('/').at(-1);
  const checked = assertReleasedAlphaBaseline(next, options);
  assert.deepEqual(checked.baseline, next); assert.deepEqual(checked.capture, next.compiledCapture);
  assert.notEqual(checked.capture.sourceHash, value.compiledCapture.sourceHash);
  assert.deepEqual(checked.baseline.modules, value.modules);
});

test('fixed ancestry metadata and unknown fields cannot be normalized away', () => {
  const value = released(), options = optionsFor(value);
  for (const mutate of [
    copy => { copy.commonOverlay.manifestPath = 'different/manifest.json'; },
    copy => { copy.commonOverlay.manifestBytes += 1; },
    copy => { copy.canonicalCorrection.selectedTargets = ['tooling/raster/import-seals/replacement.mjs']; },
    copy => { copy.canonicalCorrection.excludedPngTargets = ['different/png.mjs']; },
    copy => { copy.compiledCapture.extra = true; },
    copy => { copy.extra = true; },
  ]) {
    const copy = structuredClone(value); mutate(copy); refresh(copy);
    assert.throws(() => assertAlphaBaselineTemplate(copy, options));
  }
});

test('all source and compiled module pins remain exact outside observation slots', () => {
  const value = released(), options = optionsFor(value);
  for (const mutate of [
    copy => { copy.modules[0].source.hash = hash('different product source'); },
    copy => { copy.modules[0].compiled.hash = hash('different compiled bytes'); copy.compiledCapture.retainedModules[0].hash = copy.modules[0].compiled.hash; },
    copy => { copy.modules[0].compiled.bytes += 1; copy.compiledCapture.retainedModules[0].bytes += 1; },
    copy => { copy.modules[0].role = 'guard-only'; },
    copy => { copy.commonSourceTargets[0].hash = hash('unlisted product change'); copy.modules[2].source.hash = copy.commonSourceTargets[0].hash; },
  ]) {
    const copy = structuredClone(value); mutate(copy); refresh(copy);
    assert.throws(() => assertAlphaBaselineTemplate(copy, options));
  }
});

test('source membership and the reviewed observation whitelist cannot be widened by evidence', () => {
  const value = released(), options = optionsFor(value);
  for (const mutate of [
    copy => { copy.commonSourceTargets.push(pin('tooling/raster/import-seals/extra.mjs')); copy.requiredSharedTargets++; },
    copy => { copy.commonSourceTargets.shift(); copy.requiredSharedTargets--; },
    copy => { copy.commonSourceTargets.reverse(); },
    copy => { copy.commonSourceTargets.push(copy.commonSourceTargets[0]); copy.requiredSharedTargets++; },
  ]) {
    const copy = structuredClone(value); mutate(copy); refresh(copy);
    assert.throws(() => assertAlphaBaselineTemplate(copy, options));
  }
  for (const whitelist of [undefined, [toolingPath, toolingPath], ['tooling/raster/import-seals/missing.mjs'],
    [modules[2]], ['../escape'], [...observedCommonSourcePaths, modules[2]]])
    assert.throws(() => normalizeAlphaBaseline(value, {observedCommonSourcePaths: whitelist}));
});

test('derived source hashes and retained module identities are checked before normalization', () => {
  const value = released(), options = optionsFor(value);
  for (const mutate of [
    copy => { copy.sourceAuthorityHash = hash('forged source authority'); },
    copy => { copy.compiledCapture.commonSourceAuthorityHash = hash('different source authority'); },
    copy => { copy.compiledCapture.commonOverlayHash = hash('different ancestry'); },
    copy => { copy.compiledCapture.retainedModules[0].hash = hash('different retained bytes'); },
    copy => { copy.compiledCapture.retainedModules[1].path = copy.compiledCapture.retainedModules[0].path; },
    copy => { copy.compiledCapture.buildProof.path = '../external-proof.json'; },
    copy => { copy.compiledCapture.retainedModules.pop(); },
  ]) {
    const copy = structuredClone(value); mutate(copy);
    assert.throws(() => assertAlphaBaselineTemplate(copy, options));
  }
});

test('status, reviewed flag, and null pins cannot be supplied as release authority', () => {
  const pendingValue = pending(), pendingOptions = optionsFor(pendingValue), value = released(), options = optionsFor(value);
  assert.throws(() => assertReleasedAlphaBaseline(value, pendingOptions), /reviewed source template/);
  for (const mutate of [
    copy => { copy.status = 'captured-awaiting-compiled-review'; },
    copy => { copy.compiledCapture.reviewed = false; },
    copy => { copy.compiledCapture.node = 'future-node'; },
    copy => { copy.modules[0].compiled.hash = null; copy.modules[0].compiled.bytes = null; },
  ]) {
    const copy = structuredClone(value); mutate(copy);
    assert.throws(() => assertReleasedAlphaBaseline(copy, options));
  }
  const fakePending = pending(); fakePending.modules[0].compiled = pin(fakePending.modules[0].compiled.repositoryPath);
  assert.throws(() => assertAlphaBaselineTemplate(fakePending, pendingOptions), /Pending compiled/);
});

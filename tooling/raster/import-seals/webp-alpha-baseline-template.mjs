// Source-template selection is separate from evidence identity. Only the
// explicitly reviewed observation slots below lose their identity in the
// template; callers must still bind every actual capture field to held proof.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isAbsolute, resolve} from 'node:path';
import {canonical} from './pinned-canonical.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_FILES = 8192;
const MAX_BYTES = 2 ** 31;
const MODULES = Object.freeze([
  ['transform', 'server/raster/webp-import/tile-plan.ts', 'dist/local/server/raster/webp-import/tile-plan.js'],
  ['transform', 'server/raster/webp-import/adapter.ts', 'dist/local/server/raster/webp-import/adapter.js'],
  ['transform', 'server/raster/import-profile.ts', 'dist/local/server/raster/import-profile.js'],
  ['transform', 'server/raster/import-producers.ts', 'dist/local/server/raster/import-producers.js'],
  ['transform', 'server/raster/profile-registry.ts', 'dist/local/server/raster/profile-registry.js'],
  ['transform', 'server/raster/inspect-original.ts', 'dist/local/server/raster/inspect-original.js'],
  ['transform', 'server/storage/raster.ts', 'dist/local/server/storage/raster.js'],
  ['guard-only', 'server/raster/import-inventory.ts', 'dist/local/server/raster/import-inventory.js'],
]);
const hash = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
function keys(value, names, label) {
  assert(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), label + ' must be a record');
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...names].sort(), label + ' fields differ');
}
function count(value) { assert(Number.isSafeInteger(value) && value > 0 && value <= MAX_BYTES, 'Invalid bounded byte count'); }
function digest(value) { assert(typeof value === 'string' && HASH.test(value), 'Invalid digest'); }
function relative(path) {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !/[\\\0]/.test(path));
  assert(path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid repository path');
}
function absolute(path) {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/[\\\0]/.test(path));
  assert(isAbsolute(path) && resolve(path) === path, 'Invalid capture provenance path');
}
function pin(row, {pending = false} = {}) {
  keys(row, ['repositoryPath', 'bytes', 'hash'], 'Module/source pin'); relative(row.repositoryPath);
  if (pending) { assert.equal(row.bytes, null, 'Pending compiled bytes must remain null'); assert.equal(row.hash, null, 'Pending compiled hash must remain null'); }
  else { count(row.bytes); digest(row.hash); }
}
function paths(rows, label) {
  assert(Array.isArray(rows) && rows.length > 0 && rows.length <= MAX_FILES, label + ' membership bound exceeded');
  for (const path of rows) relative(path);
  assert.equal(new Set(rows).size, rows.length, label + ' contains duplicate paths');
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

function validate(baseline, observedCommonSourcePaths) {
  keys(baseline, ['kind', 'status', 'commonOverlay', 'commonSourceTargets', 'compiledCapture', 'modules',
    'canonicalCorrection', 'requiredSharedTargets', 'sourceAuthorityHash'], 'Baseline');
  assert.equal(baseline.kind, 'webp-candidate-loader-reviewed-inputs-v1');
  const pending = baseline.status === 'pending-genuine-compiled-review';
  assert(pending || baseline.status === 'compiled-reviewed-unexecuted', 'Baseline release status is not reviewed');
  const overlay = baseline.commonOverlay, correction = baseline.canonicalCorrection;
  keys(overlay, ['kind', 'manifestPath', 'manifestHash', 'manifestBytes', 'requiredTargets'], 'Common ancestry');
  assert.equal(overlay.kind, 'oversized-import-capsule-source-overlay-v2'); relative(overlay.manifestPath);
  digest(overlay.manifestHash); count(overlay.manifestBytes);
  assert(Number.isSafeInteger(overlay.requiredTargets) && overlay.requiredTargets > 0 && overlay.requiredTargets <= MAX_FILES);
  keys(correction, ['kind', 'manifestPath', 'manifestHash', 'manifestBytes', 'dependsOnCommonManifestHash',
    'selectedTargets', 'excludedPngTargets'], 'Canonical ancestry');
  assert.equal(correction.kind, 'node26-pinned-canonical-correction-v1'); relative(correction.manifestPath);
  digest(correction.manifestHash); count(correction.manifestBytes);
  assert.equal(correction.dependsOnCommonManifestHash, overlay.manifestHash);
  paths(correction.selectedTargets, 'Canonical selected targets'); paths(correction.excludedPngTargets, 'Canonical excluded targets');
  assert(!correction.selectedTargets.some(path => correction.excludedPngTargets.includes(path)), 'Canonical target sets overlap');

  assert(Array.isArray(baseline.commonSourceTargets) && baseline.commonSourceTargets.length > 0 && baseline.commonSourceTargets.length <= MAX_FILES);
  assert.equal(baseline.requiredSharedTargets, baseline.commonSourceTargets.length);
  for (const row of baseline.commonSourceTargets) pin(row);
  const sourcePaths = baseline.commonSourceTargets.map(row => row.repositoryPath);
  assert.equal(new Set(sourcePaths).size, sourcePaths.length, 'Duplicate common source target');
  assert(Array.isArray(observedCommonSourcePaths) && observedCommonSourcePaths.length <= MAX_FILES, 'Explicit observed-source whitelist required');
  assert.equal(new Set(observedCommonSourcePaths).size, observedCommonSourcePaths.length, 'Duplicate observed source path');
  for (const path of observedCommonSourcePaths) {
    relative(path);
    assert(path.startsWith('tooling/raster/import-seals/') || path.startsWith('tests/raster/'), 'Observed source path is outside the reviewed tooling/test seam');
    assert(sourcePaths.includes(path), 'Observed source path is absent from the fixed membership');
  }
  assert.equal(baseline.sourceAuthorityHash, hash({commonOverlay: overlay, canonicalCorrection: correction,
    commonSourceTargets: baseline.commonSourceTargets}), 'Derived common source authority differs');

  assert(Array.isArray(baseline.modules) && baseline.modules.length === MODULES.length);
  assert.deepEqual(baseline.modules.map(row => {
    keys(row, ['role', 'source', 'compiled'], 'Baseline module'); pin(row.source); pin(row.compiled, {pending});
    return [row.role, row.source.repositoryPath, row.compiled.repositoryPath];
  }), MODULES, 'Finite module membership differs');
  for (const row of baseline.modules) {
    const shared = baseline.commonSourceTargets.find(item => item.repositoryPath === row.source.repositoryPath);
    if (shared) assert.deepEqual(shared, row.source, 'Module source differs from common source');
  }
  const capture = baseline.compiledCapture;
  if (pending) assert.equal(capture, null, 'Pending baseline cannot supply capture authority');
  else {
    keys(capture, ['kind', 'reviewed', 'node', 'commonOverlayHash', 'sourceHash', 'compiledHash', 'canonicalCorrectionHash',
      'commonSourceAuthorityHash', 'runtimeDependenciesHash', 'buildProof', 'retainedModules'], 'Compiled capture');
    assert.equal(capture.kind, 'webp-candidate-compiled-review-v1'); assert.equal(capture.reviewed, true, 'Reviewed capture required');
    assert.equal(capture.node, '26.10.0'); assert.equal(capture.commonOverlayHash, overlay.manifestHash);
    assert.equal(capture.canonicalCorrectionHash, correction.manifestHash);
    assert.equal(capture.commonSourceAuthorityHash, baseline.sourceAuthorityHash);
    for (const key of ['sourceHash', 'compiledHash', 'runtimeDependenciesHash']) digest(capture[key]);
    keys(capture.buildProof, ['path', 'bytes', 'hash'], 'Compiler proof reference');
    absolute(capture.buildProof.path); count(capture.buildProof.bytes); digest(capture.buildProof.hash);
    assert(Array.isArray(capture.retainedModules) && capture.retainedModules.length === MODULES.length);
    const retainedPaths = new Set();
    assert.deepEqual(capture.retainedModules.map(row => {
      keys(row, ['path', 'repositoryPath', 'bytes', 'hash'], 'Retained module'); absolute(row.path);
      assert(!retainedPaths.has(row.path), 'Duplicate retained module path'); retainedPaths.add(row.path);
      const {path, ...entry} = row; pin(entry); return entry;
    }), baseline.modules.map(row => row.compiled), 'Retained compiler outputs differ from the exact module pins');
  }
}

/** The whitelist is trusted reviewed source, never copied from a capsule.
 * The returned normalized value selects code authority only. It is not proof
 * of source identity, compiler execution, capture review, or qualification. */
export function normalizeAlphaBaseline(baseline, {observedCommonSourcePaths} = {}) {
  validate(baseline, observedCommonSourcePaths);
  const normalized = structuredClone(baseline), observed = new Set(observedCommonSourcePaths);
  for (const row of normalized.commonSourceTargets) if (observed.has(row.repositoryPath)) { row.bytes = null; row.hash = null; }
  normalized.sourceAuthorityHash = null;
  if (normalized.compiledCapture) {
    for (const key of ['sourceHash', 'compiledHash', 'runtimeDependenciesHash', 'buildProof', 'retainedModules', 'commonSourceAuthorityHash'])
      normalized.compiledCapture[key] = null;
  }
  return freeze(normalized);
}

/** expectedTemplate and the observed-path whitelist must be selected by trusted
 * common source authority. Raw manifests still bind the unnormalized bytes. */
export function assertAlphaBaselineTemplate(baseline, {expectedTemplate, observedCommonSourcePaths} = {}) {
  assert(expectedTemplate && typeof expectedTemplate === 'object', 'Reviewed expected baseline template required');
  assert.deepEqual(normalizeAlphaBaseline(baseline, {observedCommonSourcePaths}), expectedTemplate, 'Baseline differs from the reviewed source template');
  const actual = freeze(structuredClone(baseline));
  return freeze({baseline: actual, capture: actual.compiledCapture});
}

/** Pending templates can be sealed as source while remaining unusable for a
 * campaign or capsule. Data fields and caller booleans cannot release them. */
export function assertReleasedAlphaBaseline(baseline, options) {
  const result = assertAlphaBaselineTemplate(baseline, options);
  assert.equal(result.baseline.status, 'compiled-reviewed-unexecuted', 'Genuine compiled review remains pending');
  assert(result.capture && result.capture.reviewed === true, 'Genuine compiled review remains pending');
  return result;
}

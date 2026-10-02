import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digestJSON } from '../core.mjs';
import { digest, exclusiveJSON } from './common.mjs';

const EVIDENCE_FILE = 'renderer-ownership.json';
const APP_EVIDENCE_FILE = 'renderer-ownership-v2.json';
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_PROOF_BYTES = 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const BARE_HASH = /^[a-f0-9]{64}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const json = value => JSON.stringify(value, null, 2) + '\n';
const same = (actual, expected, message) => { if (!isDeepStrictEqual(actual, expected)) throw Error(message); };
const frozen = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } return value; };
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}

export const CANVAS2D_RENDERER_CONTRACT = frozen({ contract: 'canvas2d-owned-rgba-v1', backend: 'main-thread-canvas-2d',
  appOwnedTextureAPIs: [], appOwnedTextureCount: 0, textureLimitApplicability: 'not-applicable' });
export const APP_OWNED_ALLOCATION_CONTRACT = frozen({ contract: 'application-owned-conservative-reservations-v1',
  scope: 'application-owned-conservative-reservations', resourceKeys: ['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'handles'],
  excluded: ['native-image-and-canvas-implementation-overhead', 'native-blob-residency', 'engine-and-dom-allocations'], globalCoverageComplete: false });

export const TEXT_RESOURCE_OWNERSHIP_CONTRACT = frozen({contract:'font-shaping-reservations-and-owned-glyphs-v1',
  scope:'font-shaping-conservative-owned-reservations', cpuKinds:['font','text','control','prompt','staging','scratch','copy'],
  textPool:'text-category-only', nativeCoverage:['font-parser','shaping-worker','bounded-wasm-heap','font-cache','prepared-output'],
  includesSharedBookkeeping:true, glyphGpu:'application-owned-software-renderer-zero', physicalAllocations:false});

/** Approval is an explicit review result, never discovered from live files.
 * Staged display code is deliberately absent. Add a review only after its
 * production source closure and sealed native renderer have been reviewed.
 *
 * Each entry is {id, sourceFiles:[{path,bytes,sha256,encoding}],
 * nativeFiles:[{role:'package'|'loader'|'wasm',path,bytes,sha256,encoding}],
 * nativeRenderer:{package,version,rasterProfile,js:{bytes,sha256},wasm:{bytes,sha256}}}.
 * All hashes use the sha256: prefix. Sources cover every src/ file and the
 * application build/entry inputs below; extra reviewed source inputs are fine.
 * An optional appAllocation is {contract:APP_OWNED_ALLOCATION_CONTRACT,
 * appBuildFiles:[{path,bytes,sha256}], runtimeInputs:[{role:'correctness-receipt',
 * path,bytes,sha256,encoding:'utf8'|'base64'}]}. These are independently reviewed
 * actual runtime receipts and the exact production build they exercised, not
 * caller declarations that tests passed. Runtime bytes are retained unchanged.
 * Review the application source/native/build closure before approving these
 * pins. Do not bind preapproval runtime to the full campaign sourceDigest:
 * adding this registry entry changes tooling, not the reviewed application.
 * The new proof still binds the full current parent executableIdentity.
 * No function accepts a caller-supplied review or replaces this registry. */
export const REVIEWED_RENDERER_OWNERSHIP = frozen([]);

const sourceRequirements = new Set(['index.html', 'vite.app.config.ts', 'tsconfig.json', 'tsconfig.app.json',
  'package.json', 'package-lock.json', '.progress-report/project.json', 'tooling/build-evidence.ts',
  'server/static.ts', 'vendor/text/manifest.json']);
const buildSourceRequirements = new Set([...sourceRequirements].filter(path => path !== 'server/static.ts'));
const sourceRequired = path => path.startsWith('src/') || path.startsWith('tooling/theme/') || sourceRequirements.has(path);
const buildSourceRequired = path => path.startsWith('src/') || path.startsWith('tooling/theme/') || buildSourceRequirements.has(path);
function relativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe renderer ownership input path');
  return path;
}
function identities(files, source = false) {
  if (!Array.isArray(files) || !files.length || files.length > 100_000) throw Error('Renderer ownership requires independent file identities');
  const result = new Map();
  for (const file of files) {
    relativePath(file?.path);
    if (result.has(file.path)) throw Error('Duplicate renderer ownership file identity');
    if (source && file.deleted === true) {
      if (!exactKeys(file, ['path', 'deleted'])) throw Error('Malformed deleted renderer source');
      result.set(file.path, null); continue;
    }
    if (!integer(file.bytes) || !(source ? BARE_HASH : HASH).test(file.sha256 ?? '')) throw Error('Malformed renderer ownership file identity');
    result.set(file.path, { path: file.path, bytes: file.bytes, sha256: source ? 'sha256:' + file.sha256 : file.sha256 });
  }
  return result;
}
function contextIdentity({ sourceFiles, buildFiles, executableIdentity }) {
  const sources = identities(sourceFiles, true), builds = identities(buildFiles);
  if (!exactKeys(executableIdentity, ['sourceDigest', 'buildDigest', 'toolsDigest']) || !BARE_HASH.test(executableIdentity.sourceDigest ?? '') ||
    !HASH.test(executableIdentity.buildDigest ?? '') || !HASH.test(executableIdentity.toolsDigest ?? '') ||
    digestJSON(sourceFiles) !== executableIdentity.sourceDigest || digest(buildFiles) !== executableIdentity.buildDigest) throw Error('Renderer ownership executable identity differs from its parent manifests');
  return { sources, builds, executableIdentity };
}
function pinIdentity(pin) {
  relativePath(pin?.path);
  if (!integer(pin.bytes) || pin.bytes > MAX_EVIDENCE_BYTES || !HASH.test(pin.sha256 ?? '') || !['utf8', 'base64'].includes(pin.encoding)) throw Error('Invalid reviewed renderer input');
  return { path: pin.path, bytes: pin.bytes, sha256: pin.sha256 };
}
const reviewDigests = new WeakMap();
function reviewIdentity(review) {
  // The registry is deeply frozen. Its potentially large source closure is
  // hashed once, never once per 100ms sampled metadata check.
  let identity = reviewDigests.get(review);
  if (!identity) { identity = digest(canonical({ ...review, contract: CANVAS2D_RENDERER_CONTRACT })); reviewDigests.set(review, identity); }
  return identity;
}
function reviewedSources(review, sources) {
  if (!review || typeof review.id !== 'string' || !review.id || !Array.isArray(review.sourceFiles) || !review.sourceFiles.length ||
    !Array.isArray(review.nativeFiles) || !review.nativeRenderer) throw Error('Incomplete renderer ownership review');
  const names = new Set();
  for (const pin of review.sourceFiles) {
    const identity = pinIdentity(pin);
    if (names.has(pin.path)) throw Error('Duplicate reviewed renderer source');
    names.add(pin.path); same(sources.get(pin.path), identity, 'Renderer source differs from the reviewed closure');
  }
  if ([...sourceRequirements].some(path => !names.has(path)) || [...sources].some(([path, value]) => value && sourceRequired(path) && !names.has(path))) throw Error('Renderer review omits an application source or entry input');
  same(review.nativeFiles.map(file => file.role).sort(), ['loader', 'package', 'wasm'], 'Renderer review lacks the exact native package/loader/WASM closure');
  for (const file of review.nativeFiles) {
    pinIdentity(file);
    if (!file.path.startsWith('node_modules/canvaskit-wasm/')) throw Error('Reviewed native renderer is outside its sealed package');
  }
}
const validatedAppReviews = new WeakSet();
function reviewedAppAllocation(review, context) {
  const app = review.appAllocation;
  if (!validatedAppReviews.has(review)) {
    if (!exactKeys(app, ['contract', 'appBuildFiles', 'runtimeInputs', ...(Object.hasOwn(app ?? {}, 'textResources') ? ['textResources'] : [])])) throw Error('Missing fixed application allocation review');
    same(app.contract, APP_OWNED_ALLOCATION_CONTRACT, 'Application allocation review has another scope');
    if (Object.hasOwn(app, 'textResources')) same(app.textResources, TEXT_RESOURCE_OWNERSHIP_CONTRACT, 'Text resource review has another scope');
    // Only the application subject is approved here. Campaign tooling changes
    // after the actual correctness run cannot introduce a self-referential seal.
    if (review.sourceFiles.some(pin => !sourceRequired(pin.path))) throw Error('Application approval includes nonapplication source inputs');
    if (!Array.isArray(app.appBuildFiles) || !app.appBuildFiles.length || app.appBuildFiles.length > 100_000) throw Error('Application allocation review lacks its actual build');
    const builds = new Set();
    for (const pin of app.appBuildFiles) {
      if (!exactKeys(pin, ['path', 'bytes', 'sha256']) || !integer(pin.bytes) || !HASH.test(pin.sha256 ?? '') || !relativePath(pin.path).startsWith('dist/app/') || builds.has(pin.path)) throw Error('Malformed reviewed application build identity');
      builds.add(pin.path);
    }
    if (!builds.has('dist/app/build-evidence.json')) throw Error('Reviewed application build lacks finalized evidence');
    if (!Array.isArray(app.runtimeInputs) || !app.runtimeInputs.length || app.runtimeInputs.length > 32) throw Error('Application allocation review lacks actual correctness evidence');
    const names = new Set(); let bytes = 0;
    for (const pin of app.runtimeInputs) {
      if (!exactKeys(pin, ['role', 'path', 'bytes', 'sha256', 'encoding']) || pin.role !== 'correctness-receipt' || pin.bytes === 0 || names.has(pin.path)) throw Error('Malformed reviewed application runtime receipt');
      pinIdentity(pin); names.add(pin.path); bytes += pin.bytes;
    }
    if (bytes > MAX_EVIDENCE_BYTES) throw Error('Reviewed runtime receipts exceed the retained evidence bound');
    // Registry entries are deeply frozen; sampling never rescans their closure.
    validatedAppReviews.add(review);
  }
  if (context) same([...app.appBuildFiles].sort((a, b) => a.path.localeCompare(b.path)), [...context.builds.values()].filter(pin => pin.path.startsWith('dist/app/')).sort((a, b) => a.path.localeCompare(b.path)), 'Application build differs from approved runtime subject');
  return app;
}
function selectedReview(context) {
  return REVIEWED_RENDERER_OWNERSHIP.find(review => {
    try { reviewedSources(review, context.sources); if (review.appAllocation) reviewedAppAllocation(review, context); return true; } catch { return false; }
  });
}
function proofReview(proof) {
  if (!exactKeys(proof, ['kind', 'reviewId', 'reviewSha256', 'contract', 'executableIdentity', 'artifact']) || !['renderer-ownership-proof-1', 'renderer-ownership-proof-2'].includes(proof.kind) ||
    proof.contract !== CANVAS2D_RENDERER_CONTRACT.contract || Buffer.byteLength(JSON.stringify(proof)) > MAX_PROOF_BYTES) throw Error('Malformed renderer ownership proof metadata');
  const review = REVIEWED_RENDERER_OWNERSHIP.find(value => value.id === proof.reviewId);
  if (!review || proof.reviewSha256 !== reviewIdentity(review)) throw Error('Renderer ownership has no exact approved source review');
  if (proof.kind === 'renderer-ownership-proof-2') reviewedAppAllocation(review);
  const evidenceFile = proof.kind === 'renderer-ownership-proof-2' ? APP_EVIDENCE_FILE : EVIDENCE_FILE;
  const identity = proof.executableIdentity, artifact = proof.artifact;
  if (!exactKeys(identity, ['sourceDigest', 'buildDigest', 'toolsDigest']) || !BARE_HASH.test(identity.sourceDigest ?? '') || !HASH.test(identity.buildDigest ?? '') || !HASH.test(identity.toolsDigest ?? '') ||
    !exactKeys(artifact, ['path', 'retainedPath', 'bytes', 'sha256']) || typeof artifact.path !== 'string' || !isAbsolute(artifact.path) || resolve(artifact.path) !== artifact.path ||
    artifact.retainedPath !== evidenceFile || !artifact.path.endsWith(sep + evidenceFile) || !integer(artifact.bytes) || artifact.bytes === 0 || artifact.bytes > MAX_EVIDENCE_BYTES || !HASH.test(artifact.sha256 ?? '')) throw Error('Malformed renderer ownership identity or retained artifact');
  return review;
}

/** This serialized predicate is only the metric gate. Receipt verification
 * must independently replay the retained artifact before accepting a verdict. */
export function isRendererTextureNotApplicable(rendererOwnership, proof, { gpuBytes } = {}) {
  try {
    proofReview(proof);
    if (!exactKeys(rendererOwnership, [...Object.keys(CANVAS2D_RENDERER_CONTRACT), 'rgbaBackingEstimateBytes']) || !integer(gpuBytes) || rendererOwnership.rgbaBackingEstimateBytes !== gpuBytes) return false;
    const { rgbaBackingEstimateBytes: _bytes, ...contract } = rendererOwnership;
    return isDeepStrictEqual(contract, CANVAS2D_RENDERER_CONTRACT);
  } catch { return false; }
}

const allocationKinds = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
const amountKeys = APP_OWNED_ALLOCATION_CONTRACT.resourceKeys;
const cpuMissing = ['app-payload-ownership-incomplete', ...APP_OWNED_ALLOCATION_CONTRACT.excluded, 'renderer-ownership-proof-required'];
const appFailures = ['counter-overflow', 'kind-reconciliation', 'sequence-reconciliation', 'cpu-window-binding', 'observer-incomplete'];
const cpuFailures = ['text-observer-unavailable', 'text-observer-rebound', 'text-observer-disconnected', 'text-sequence-discontinuity', 'text-observer-fault', 'text-observation-invalid', 'clock-invalid', 'observer-reentrant'];
const valid = (condition, message) => { if (!condition) throw Error('Invalid application ownership observation: ' + message); };
const finiteTime = value => Number.isFinite(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const exactObservation = (value, keys, label) => valid(exactKeys(value, keys), label + ' keys');
const unsigned = (value, label) => valid(integer(value), label);
const nullableUnsigned = (value, label) => valid(value === null || integer(value), label);
function failureList(values, allowed, label) {
  valid(Array.isArray(values) && values.length <= allowed.length && new Set(values).size === values.length && values.every(value => allowed.includes(value)), label);
}
function counts(value, withRecords, label) {
  exactObservation(value, [...(withRecords ? ['records'] : []), ...amountKeys], label);
  for (const [key, number] of Object.entries(value)) unsigned(number, label + '.' + key);
  valid(value.previewCacheBytes <= value.cpuBytes + value.gpuBytes, label + ' cache subset');
  valid(!withRecords || value.records > 0 || amountKeys.every(key => value[key] === 0), label + ' ownership without a record');
}
function sumKinds(rows, select) {
  const total = { records: 0, cpuBytes: 0, gpuBytes: 0, previewCacheBytes: 0, handles: 0 };
  for (const row of rows) for (const key of Object.keys(total)) { total[key] += select(row)[key] ?? 0; unsigned(total[key], 'kind sum ' + key); }
  return total;
}
function cpuObservation(value) {
  exactObservation(value, ['kind', 'schemaVersion', 'scope', 'ledgerInstanceId', 'sequence', 'currentBytes', 'observedPeakBytes', 'observationComplete', 'ownerCoverageComplete', 'missing', 'window'], 'CPU observation');
  valid(value.kind === 'combined-cpu-observation-1' && value.schemaVersion === 1 && value.scope === 'browser-ledger-plus-text-reservations' && identifier(value.ledgerInstanceId), 'CPU identity');
  for (const key of ['sequence', 'currentBytes', 'observedPeakBytes']) unsigned(value[key], 'CPU ' + key);
  valid(value.observedPeakBytes >= value.currentBytes && value.observationComplete === false && value.ownerCoverageComplete === false, 'CPU lifetime scope');
  same(value.missing, cpuMissing, 'CPU observation omits explicit ownership gaps');
  const window = value.window; if (window === null) return null;
  exactObservation(window, ['kind', 'schemaVersion', 'ledgerInstanceId', 'id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'endMs', 'peakAtMs', 'startSequence', 'endSequence', 'peakSequence', 'currentBytes', 'peakBytes', 'ledgerBytesAtPeak', 'textBytesAtPeak', 'textStartSequence', 'textEndSequence', 'sealed', 'observationComplete', 'ownerCoverageComplete', 'failures', 'missing'], 'CPU window');
  valid(window.kind === 'combined-cpu-window-1' && window.schemaVersion === 1 && window.ledgerInstanceId === value.ledgerInstanceId && typeof window.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(window.id), 'CPU window identity');
  valid(window.clock === 'browser-performance' && finiteTime(window.clockOriginMs) && finiteTime(window.startMs) && finiteTime(window.peakAtMs) && window.peakAtMs >= window.startMs, 'CPU window clock');
  for (const key of ['ordinal', 'startSequence', 'peakSequence', 'currentBytes', 'peakBytes', 'ledgerBytesAtPeak', 'textBytesAtPeak', 'textStartSequence']) unsigned(window[key], 'CPU window ' + key);
  valid(window.ordinal > 0 && window.peakSequence >= window.startSequence && window.peakSequence <= value.sequence && window.peakBytes >= window.currentBytes && window.peakBytes === window.ledgerBytesAtPeak + window.textBytesAtPeak && value.observedPeakBytes >= window.peakBytes, 'CPU window peak');
  valid(typeof window.sealed === 'boolean' && typeof window.observationComplete === 'boolean' && window.ownerCoverageComplete === false, 'CPU window flags');
  failureList(window.failures, cpuFailures, 'CPU failures'); same(window.missing, cpuMissing, 'CPU window omits explicit ownership gaps');
  valid(!window.observationComplete || window.failures.length === 0, 'complete CPU window has failures');
  if (window.sealed) {
    const textRebound = !window.observationComplete && window.failures.some(reason => ['text-observer-rebound', 'text-sequence-discontinuity'].includes(reason));
    valid(finiteTime(window.endMs) && window.endMs >= window.peakAtMs && integer(window.endSequence) && window.endSequence >= window.peakSequence && window.endSequence <= value.sequence && integer(window.textEndSequence) && (window.textEndSequence >= window.textStartSequence || textRebound), 'CPU sealed boundary');
  } else {
    valid(window.endMs === null && window.endSequence === null && window.textEndSequence === null && window.currentBytes === value.currentBytes, 'CPU open boundary');
  }
  return window;
}

/** Pure shape/arithmetic validation, never approval. Incomplete diagnostics are
 * valid evidence when their counters and failure classifications are coherent.
 * B0's initial numeric CPU join is separately checked against retained samples:
 * a final CPU v1 window intentionally has no invented initial-byte field. */
export function validateAppOwnershipObservation(appOwnership, combinedCpu) {
  const cpuWindow = cpuObservation(combinedCpu);
  exactObservation(appOwnership, ['kind', 'schemaVersion', 'ledgerInstanceId', 'transitionSequence', 'point', 'window'], 'application observation');
  valid(appOwnership.kind === 'app-ownership-observation-1' && appOwnership.schemaVersion === 1 && appOwnership.ledgerInstanceId === combinedCpu.ledgerInstanceId, 'application identity');
  unsigned(appOwnership.transitionSequence, 'application transition sequence');
  const point = appOwnership.point;
  exactObservation(point, ['kind', 'schemaVersion', 'ledgerInstanceId', 'transitionSequence', 'cpuSequence', 'clock', 'clockOriginMs', 'atMs', 'totals', 'centralCpuBytes', 'textBytes', 'textSequence', 'kinds', 'observationComplete', 'globalCoverageComplete'], 'application point');
  valid(point.kind === 'app-ownership-point-1' && point.schemaVersion === 1 && point.ledgerInstanceId === appOwnership.ledgerInstanceId && point.transitionSequence === appOwnership.transitionSequence && point.cpuSequence === combinedCpu.sequence, 'application point identity');
  valid(point.clock === 'browser-performance' && finiteTime(point.clockOriginMs) && (point.atMs === null || finiteTime(point.atMs)) && typeof point.observationComplete === 'boolean' && point.globalCoverageComplete === false, 'application point clock/flags');
  unsigned(point.centralCpuBytes, 'point central CPU'); nullableUnsigned(point.textBytes, 'point text bytes'); nullableUnsigned(point.textSequence, 'point text sequence');
  exactObservation(point.totals, amountKeys, 'point totals');
  for (const key of amountKeys) key === 'cpuBytes' ? nullableUnsigned(point.totals[key], 'point CPU total') : unsigned(point.totals[key], 'point ' + key);
  valid(Array.isArray(point.kinds) && point.kinds.length === allocationKinds.length, 'point kind inventory');
  for (let i = 0; i < allocationKinds.length; i++) {
    const row = point.kinds[i]; exactObservation(row, ['kind', 'records', ...amountKeys], 'point kind'); valid(row.kind === allocationKinds[i], 'point kind order');
    const { kind: _kind, ...amounts } = row; counts(amounts, true, 'point kind amounts');
  }
  const pointTotal = sumKinds(point.kinds, row => row);
  valid(pointTotal.cpuBytes === point.centralCpuBytes, 'point central CPU reconciliation');
  for (const key of amountKeys.filter(key => key !== 'cpuBytes')) valid(pointTotal[key] === point.totals[key], 'point reconciliation ' + key);
  valid(point.textBytes === null ? point.totals.cpuBytes === null : point.totals.cpuBytes === point.centralCpuBytes + point.textBytes, 'point text CPU reconciliation');
  if (point.observationComplete) valid(point.atMs !== null && point.textBytes !== null && point.textSequence !== null && point.totals.cpuBytes === combinedCpu.currentBytes, 'complete point CPU binding');
  const window = appOwnership.window;
  if (window === null) { valid(cpuWindow === null, 'one window absent'); return { point, window, cpuWindow }; }
  valid(cpuWindow !== null, 'CPU window absent');
  exactObservation(window, ['kind', 'schemaVersion', 'scope', 'ledgerInstanceId', 'id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'endMs', 'cpuStartSequence', 'cpuEndSequence', 'ledgerStartSequence', 'ledgerEndSequence', 'lastTransitionSequence', 'sealed', 'budgetRefusals', 'kinds', 'text', 'peaks', 'observationComplete', 'reconciled', 'failures', 'globalCoverageComplete'], 'application window');
  valid(window.kind === 'app-ownership-window-1' && window.schemaVersion === 1 && window.scope === APP_OWNED_ALLOCATION_CONTRACT.scope && window.ledgerInstanceId === appOwnership.ledgerInstanceId, 'application window identity');
  for (const key of ['id', 'ordinal', 'clock', 'clockOriginMs', 'startMs', 'endMs', 'sealed']) valid(window[key] === cpuWindow[key], 'application/CPU window ' + key);
  valid(window.clockOriginMs === point.clockOriginMs && (point.atMs === null || point.atMs >= (window.endMs ?? cpuWindow.peakAtMs)), 'point/window clock');
  valid(window.cpuStartSequence === cpuWindow.startSequence && window.cpuEndSequence === cpuWindow.endSequence, 'application/CPU boundary sequences');
  for (const key of ['ledgerStartSequence', 'lastTransitionSequence', 'budgetRefusals']) unsigned(window[key], 'application window ' + key);
  nullableUnsigned(window.ledgerEndSequence, 'application window end sequence');
  valid(window.lastTransitionSequence >= window.ledgerStartSequence && (window.sealed ? window.ledgerEndSequence === window.lastTransitionSequence && appOwnership.transitionSequence >= window.lastTransitionSequence : window.ledgerEndSequence === null && appOwnership.transitionSequence === window.lastTransitionSequence), 'application transition bounds');
  valid(typeof window.observationComplete === 'boolean' && typeof window.reconciled === 'boolean' && window.globalCoverageComplete === false, 'application window flags');
  failureList(window.failures, appFailures, 'application failures');
  valid(!window.observationComplete || window.reconciled && window.failures.length === 0 && cpuWindow.observationComplete, 'complete window has missing observation');
  valid(Array.isArray(window.kinds) && window.kinds.length === allocationKinds.length, 'window kind inventory');
  let transitions = 0, reconciled = true;
  for (let i = 0; i < allocationKinds.length; i++) {
    const row = window.kinds[i]; exactObservation(row, ['kind', 'initial', 'current', 'transitions', 'added', 'removed'], 'window kind'); valid(row.kind === allocationKinds[i], 'window kind order');
    counts(row.initial, true, 'initial kind amounts'); counts(row.current, true, 'current kind amounts');
    // Added/removed vectors describe independent component deltas, not owned
    // snapshots; their preview delta need not itself be a CPU/GPU subset.
    for (const name of ['added', 'removed']) { exactObservation(row[name], amountKeys, name); for (const key of amountKeys) unsigned(row[name][key], name + ' ' + key); }
    exactObservation(row.transitions, ['reserved', 'resized', 'released', 'observed'], 'kind transitions');
    let kindTransitions = 0;
    for (const [key, count] of Object.entries(row.transitions)) { unsigned(count, 'kind transition ' + key); kindTransitions += count; transitions += count; unsigned(transitions, 'total transitions'); }
    valid(kindTransitions > 0 || amountKeys.every(key => row.added[key] === 0 && row.removed[key] === 0), 'kind deltas without a transition');
    reconciled &&= BigInt(row.initial.records) + BigInt(row.transitions.reserved) - BigInt(row.transitions.released) === BigInt(row.current.records);
    for (const key of amountKeys) reconciled &&= BigInt(row.initial[key]) + BigInt(row.added[key]) - BigInt(row.removed[key]) === BigInt(row.current[key]);
  }
  const sequenceReconciled = transitions === window.lastTransitionSequence - window.ledgerStartSequence;
  valid(!window.reconciled || reconciled && sequenceReconciled, 'claimed reconciliation differs from counters');
  valid(reconciled || window.failures.includes('kind-reconciliation'), 'unclassified kind reconciliation failure');
  valid(sequenceReconciled || window.failures.includes('sequence-reconciliation'), 'unclassified sequence reconciliation failure');
  exactObservation(window.text, ['initialBytes', 'currentBytes', 'startSequence', 'endSequence', 'observationComplete'], 'window text');
  for (const key of ['initialBytes', 'currentBytes', 'startSequence', 'endSequence']) nullableUnsigned(window.text[key], 'window text ' + key);
  valid(typeof window.text.observationComplete === 'boolean' && window.text.startSequence === cpuWindow.textStartSequence && window.text.endSequence === cpuWindow.textEndSequence, 'window text source binding');
  const initial = sumKinds(window.kinds, row => row.initial), current = sumKinds(window.kinds, row => row.current);
  exactObservation(window.peaks, ['gpuBytes', 'previewCacheBytes', 'handles'], 'window peaks');
  for (const key of ['gpuBytes', 'previewCacheBytes', 'handles']) { unsigned(window.peaks[key], 'window peak ' + key); valid(window.peaks[key] >= initial[key] && window.peaks[key] >= current[key], 'window peak lower bound ' + key); }
  if (window.observationComplete) {
    valid(window.text.observationComplete && window.text.initialBytes !== null && window.text.currentBytes !== null && current.cpuBytes + window.text.currentBytes === cpuWindow.currentBytes && cpuWindow.peakBytes >= initial.cpuBytes + window.text.initialBytes, 'complete window CPU reconciliation');
  }
  // Sealed witnesses stay frozen while the live point advances. Equal owner
  // sequences still describe the same owned records, unless an incomplete
  // saturated counter can no longer attest continuity.
  if (!window.sealed || appOwnership.transitionSequence === window.lastTransitionSequence && (point.observationComplete || appOwnership.transitionSequence < Number.MAX_SAFE_INTEGER))
    same(window.kinds.map(row => ({ kind: row.kind, ...row.current })), point.kinds, 'Application window differs from its unchanged live ownership');
  if (!window.sealed) valid(window.text.currentBytes === point.textBytes, 'open text point');
  if (window.sealed && combinedCpu.sequence === cpuWindow.endSequence) {
    valid(combinedCpu.currentBytes === cpuWindow.currentBytes && (point.atMs === null || point.atMs === cpuWindow.endMs), 'sealed CPU point differs at the same sequence');
    if (point.observationComplete && window.text.observationComplete)
      valid(point.textBytes === window.text.currentBytes && point.textSequence === window.text.endSequence, 'sealed text point differs at the same sequence');
  }
  return { point, window, cpuWindow };
}

function approvedAppScope(proof, resourceKey) {
  const review = proofReview(proof);
  valid(proof.kind === 'renderer-ownership-proof-2' && amountKeys.includes(resourceKey), 'approved resource scope');
  return review;
}
/** The fixed review approves app-owned conservative coverage only. These
 * predicates do not certify RSS, physical GPU backing, or opaque engine bytes.
 * Receipt verification must independently replay the exact retained v2 proof. */
export function isAppOwnedAllocationPoint(proof, { appOwnership, combinedCpu, resourceKey } = {}) {
  try { approvedAppScope(proof, resourceKey); return validateAppOwnershipObservation(appOwnership, combinedCpu).point.observationComplete; } catch { return false; }
}
export function isAppOwnedAllocationScope(proof, { appOwnership, combinedCpu, resourceKey } = {}) {
  try { approvedAppScope(proof, resourceKey); const { window, cpuWindow } = validateAppOwnershipObservation(appOwnership, combinedCpu); return !!window?.sealed && window.observationComplete && window.reconciled && cpuWindow.observationComplete; } catch { return false; }
}

/** A generic renderer/allocation review cannot approve R35 by implication.
 * The fixed review must explicitly cover parser/worker/WASM and shared owners. */
export function isTextResourceOwnershipProof(proof) {
  try {const review=approvedAppScope(proof,'cpuBytes');return isDeepStrictEqual(review.appAllocation.textResources,TEXT_RESOURCE_OWNERSHIP_CONTRACT);} catch {return false;}
}

function decodeInput(input, pin) {
  if (!exactKeys(input, ['path', 'encoding', 'content']) || input.path !== pin.path || input.encoding !== pin.encoding || typeof input.content !== 'string') throw Error('Retained renderer input differs from its reviewed role');
  let bytes;
  if (input.encoding === 'utf8') bytes = Buffer.from(input.content, 'utf8');
  else {
    bytes = Buffer.from(input.content, 'base64');
    if (bytes.toString('base64') !== input.content) throw Error('Retained renderer binary encoding is not canonical');
  }
  if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) throw Error('Retained renderer input bytes differ from the reviewed pin');
  return bytes;
}
function parse(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function replay(payload, review, context) {
  const app = payload?.kind === 'renderer-ownership-evidence-2';
  if (!exactKeys(payload, ['kind', 'reviewId', 'reviewSha256', 'contract', 'executableIdentity', 'sourceClosure', 'nativeRenderer', 'retainedSources', 'retainedNativeInputs', 'buildEvidence', ...(app ? ['appAllocation', 'retainedRuntimeInputs'] : [])]) || !['renderer-ownership-evidence-1', 'renderer-ownership-evidence-2'].includes(payload.kind)) throw Error('Malformed retained renderer ownership evidence');
  same(payload.reviewId, review.id, 'Retained renderer review differs');
  same(payload.reviewSha256, reviewIdentity(review), 'Retained renderer review seal differs');
  same(payload.contract, CANVAS2D_RENDERER_CONTRACT, 'Retained renderer contract differs');
  same(payload.executableIdentity, context.executableIdentity, 'Retained renderer executable identity differs');
  reviewedSources(review, context.sources);
  same(payload.sourceClosure, review.sourceFiles, 'Retained renderer closure differs from the fixed review');
  same(payload.nativeRenderer, review.nativeRenderer, 'Retained native renderer differs from the fixed review');
  if (!Array.isArray(payload.retainedSources) || payload.retainedSources.length !== review.sourceFiles.length || !Array.isArray(payload.retainedNativeInputs) || payload.retainedNativeInputs.length !== review.nativeFiles.length) throw Error('Retained renderer source/native input inventory differs');
  const sourceBytes = new Map(review.sourceFiles.map((pin, index) => [pin.path, decodeInput(payload.retainedSources[index], pin)]));
  const nativeBytes = new Map(review.nativeFiles.map((pin, index) => [pin.role, decodeInput(payload.retainedNativeInputs[index], pin)]));
  if (app) {
    const approved = reviewedAppAllocation(review, context);
    same(payload.appAllocation, approved, 'Retained application approval differs from the fixed review');
    if (!Array.isArray(payload.retainedRuntimeInputs) || payload.retainedRuntimeInputs.length !== approved.runtimeInputs.length) throw Error('Retained application correctness receipts differ from the fixed review');
    for (let index = 0; index < approved.runtimeInputs.length; index++) decodeInput(payload.retainedRuntimeInputs[index], approved.runtimeInputs[index]);
  }
  const native = review.nativeRenderer;
  if (native.package !== 'canvaskit-wasm' || typeof native.version !== 'string' || typeof native.rasterProfile !== 'string' || !native.rasterProfile.includes('cpu-rgba8888')) throw Error('Reviewed native renderer is not the sealed CPU RGBA profile');
  const pkg = parse(nativeBytes.get('package'));
  if (pkg.name !== native.package || pkg.version !== native.version) throw Error('Retained native package identity differs');
  for (const path of ['src/text/profile.json', 'vendor/text/manifest.json']) {
    const profile = parse(sourceBytes.get(path));
    if (profile.rasterProfile !== native.rasterProfile || profile.engine?.package !== native.package || profile.engine?.version !== native.version) throw Error('Retained native text profile differs');
    for (const [role, name] of [['loader', 'js'], ['wasm', 'wasm']]) {
      const bytes = nativeBytes.get(role), declared = native[name];
      if (bytes.length !== declared?.bytes || digest(bytes) !== declared?.sha256 || profile.engine?.[name]?.bytes !== declared.bytes || 'sha256:' + profile.engine?.[name]?.sha256 !== declared.sha256) throw Error('Retained native renderer bytes differ from the exact profile');
    }
  }
  const build = payload.buildEvidence;
  if (!exactKeys(build, ['path', 'bytes', 'sha256', 'content']) || build.path !== 'dist/app/build-evidence.json' || typeof build.content !== 'string') throw Error('Renderer build evidence is absent');
  const bytes = Buffer.from(build.content, 'utf8');
  same(context.builds.get(build.path), { path: build.path, bytes: bytes.length, sha256: digest(bytes) }, 'Renderer build evidence differs from the actual parent build');
  if (build.bytes !== bytes.length || build.sha256 !== digest(bytes)) throw Error('Retained renderer build evidence seal differs');
  const evidence = parse(bytes);
  if (evidence.schema !== 1 || evidence.capture?.phase !== 'writeBundle' || evidence.capture?.finalized !== true || evidence.toolchain?.node !== '26.10.0' || evidence.toolchain?.npm !== '12.1.0' || !Array.isArray(evidence.sourceInputs) || !Array.isArray(evidence.outputs)) throw Error('Renderer requires finalized production build evidence');
  const expectedSources = [...context.sources.values()].filter(file => file && buildSourceRequired(file.path)).map(file => ({ ...file, sha256: file.sha256.slice(7) })).sort((a, b) => a.path.localeCompare(b.path));
  same([...evidence.sourceInputs].sort((a, b) => a.path.localeCompare(b.path)), expectedSources, 'Renderer build inputs differ from actual selected source');
  const outputs = new Map();
  for (const output of evidence.outputs) {
    relativePath(output.file);
    if (outputs.has(output.file) || !Array.isArray(output.modules)) throw Error('Duplicate or malformed renderer output');
    same(context.builds.get('dist/app/' + output.file), { path: 'dist/app/' + output.file, bytes: output.bytes, sha256: 'sha256:' + output.sha256 }, 'Renderer output differs from actual parent build');
    outputs.set(output.file, output);
  }
  for (const [path] of context.builds) if (path.startsWith('dist/app/') && !['dist/app/build-evidence.json', 'dist/app/.vite/manifest.json'].includes(path) && !outputs.has(path.slice('dist/app/'.length))) throw Error('Renderer build evidence omits a production output');
  const loader = review.nativeFiles.find(file => file.role === 'loader');
  if (![...outputs.values()].some(output => output.modules.includes(loader.path))) throw Error('Sealed native renderer loader is absent from the actual bundle');
  if (![...outputs.values()].some(output => output.file.endsWith('.wasm') && output.bytes === native.wasm.bytes && 'sha256:' + output.sha256 === native.wasm.sha256)) throw Error('Sealed native renderer WASM is absent from the actual build');
}

async function readInput(root, path, limit = MAX_EVIDENCE_BYTES) {
  relativePath(path); let current = root;
  for (const part of path.split('/')) {
    current = join(current, part); const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw Error('Renderer ownership inputs cannot contain symbolic links');
  }
  const file = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw Error('Renderer ownership input exceeds its ordinary-file bound');
    const bytes = await file.readFile(), after = await file.stat(), pathAfter = await lstat(current);
    if (bytes.length !== before.size || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      pathAfter.ino !== after.ino || pathAfter.dev !== after.dev || pathAfter.size !== after.size || pathAfter.mtimeMs !== after.mtimeMs || pathAfter.ctimeMs !== after.ctimeMs || await realpath(current) !== current) throw Error('Renderer ownership input changed during retention');
    return bytes;
  } finally { await file.close(); }
}

/** Prepare once before B0. Never run file hashing during a sampled observation. */
export async function captureRendererOwnershipProof({ repo, output, sourceFiles, buildFiles, executableIdentity }) {
  const context = contextIdentity({ sourceFiles, buildFiles, executableIdentity }), review = selectedReview(context);
  if (!review) return { proof: null, artifact: null, missing: ['No exact reviewed production renderer source closure is available'] };
  if (typeof repo !== 'string' || typeof output !== 'string' || !isAbsolute(repo) || !isAbsolute(output) || await realpath(repo) !== repo || await realpath(output) !== output) throw Error('Renderer ownership requires canonical existing source and evidence directories');
  const retain = async pin => {
    const bytes = await readInput(repo, pin.path);
    const input = { path: pin.path, encoding: pin.encoding, content: pin.encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('base64') };
    decodeInput(input, pin); return input;
  };
  const retainedSources = [], retainedNativeInputs = [], retainedRuntimeInputs = [];
  for (const pin of review.sourceFiles) retainedSources.push(await retain(pin));
  for (const pin of review.nativeFiles) retainedNativeInputs.push(await retain(pin));
  const app = review.appAllocation;
  if (app) for (const pin of app.runtimeInputs) retainedRuntimeInputs.push(await retain(pin));
  const buildBytes = await readInput(repo, 'dist/app/build-evidence.json');
  const payload = { kind: app ? 'renderer-ownership-evidence-2' : 'renderer-ownership-evidence-1', reviewId: review.id, reviewSha256: reviewIdentity(review), contract: CANVAS2D_RENDERER_CONTRACT,
    executableIdentity, sourceClosure: review.sourceFiles, nativeRenderer: review.nativeRenderer, retainedSources, retainedNativeInputs,
    buildEvidence: { path: 'dist/app/build-evidence.json', bytes: buildBytes.length, sha256: digest(buildBytes), content: new TextDecoder('utf-8', { fatal: true }).decode(buildBytes) },
    ...(app ? { appAllocation: app, retainedRuntimeInputs } : {}) };
  replay(payload, review, context);
  const bytes = Buffer.from(json(payload));
  if (bytes.length > MAX_EVIDENCE_BYTES) throw Error('Renderer ownership retained evidence exceeds its fixed bound');
  const evidenceFile = app ? APP_EVIDENCE_FILE : EVIDENCE_FILE;
  const artifact = { path: join(output, evidenceFile), retainedPath: evidenceFile, bytes: bytes.length, sha256: digest(bytes) };
  const proof = { kind: app ? 'renderer-ownership-proof-2' : 'renderer-ownership-proof-1', reviewId: review.id, reviewSha256: reviewIdentity(review), contract: CANVAS2D_RENDERER_CONTRACT.contract, executableIdentity: structuredClone(executableIdentity), artifact };
  proofReview(proof);
  await exclusiveJSON(artifact.path, payload);
  return { proof: frozen(proof), artifact: proof.artifact, missing: [] };
}

/** readRetained must read this group's file through its outer immutable seal.
 * The callback returns verified bytes, never a subject/build pathname. */
export async function verifyRendererOwnershipProof(proof, { output, sourceFiles, buildFiles, executableIdentity, readRetained } = {}) {
  const review = proofReview(proof), context = contextIdentity({ sourceFiles, buildFiles, executableIdentity });
  const evidenceFile = proof.kind === 'renderer-ownership-proof-2' ? APP_EVIDENCE_FILE : EVIDENCE_FILE;
  same(proof.executableIdentity, executableIdentity, 'Renderer proof belongs to another parent executable identity');
  if (typeof output !== 'string' || !isAbsolute(output) || resolve(output) !== output || proof.artifact.path !== join(output, evidenceFile) || typeof readRetained !== 'function') throw Error('Renderer proof does not belong to the exact retained group');
  const bytes = await readRetained(evidenceFile);
  if (!Buffer.isBuffer(bytes) || bytes.length !== proof.artifact.bytes || digest(bytes) !== proof.artifact.sha256) throw Error('Renderer retained artifact identity differs');
  const payload = parse(bytes);
  if (payload.kind !== (proof.kind === 'renderer-ownership-proof-2' ? 'renderer-ownership-evidence-2' : 'renderer-ownership-evidence-1')) throw Error('Renderer proof and retained evidence versions differ');
  replay(payload, review, context);
  return frozen(structuredClone(proof));
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const ADAPTER_LIFECYCLE_PHASES = Object.freeze(['import', 'select', 'unselect', 'close', 'release']);
export const ADAPTER_LIFECYCLE_ASSERTIONS = Object.freeze(['fixedArtifactsImported', 'selectionRestored', 'durableFixturePreserved', 'noBrowserTensorDecode', 'zeroUnexpectedFetches']);
const sha256 = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const artifact = value => {
  assert(value && /^sha256:[a-f0-9]{64}$/.test(value.hash) && /^[0-9]+$/.test(value.byteLength) && typeof value.mediaType === 'string');
  return { hash: value.hash, byteLength: value.byteLength, mediaType: value.mediaType };
};

/** Different immutable versions can share weights. Do not call their identical
 * weights hashes distinct, or replace real version IDs with invented weights. */
export function selectedAdapterIdentity(entry) {
  for (const key of ['versionId', 'adapterId', 'version']) assert(typeof entry[key] === 'string' && entry[key].length > 0);
  const value = { kind: 'selected-immutable-adapter-version-1', versionId: entry.versionId, adapterId: entry.adapterId, version: entry.version,
    weights: artifact(entry.weights), config: entry.config === null ? null : artifact(entry.config) };
  return { identity: sha256(value), value, method: 'SHA-256 of JSON with the displayed field order, exact immutable version ID/version and typed artifact references.' };
}

/** Wrap the real action. Never reconstruct parent clocks from renamed children
 * or add a phase for work that did not run. Detailed children remain intact. */
export async function measureAdapterAction(phases, childPhases, name, work) {
  assert(ADAPTER_LIFECYCLE_PHASES.includes(name));
  assert(!phases.some(phase => phase.name === name), 'A lifecycle parent occurs once');
  const firstChild = childPhases.length, span = { name, startMs: performance.now(), outcome: 'running', childPhases: [] }; phases.push(span);
  try { const value = await work(span); span.outcome = 'expected'; return value; }
  catch (error) { span.outcome = 'failed'; span.error = { message: String(error.message ?? error), code: error.code ?? null }; throw error; }
  finally { span.endMs = performance.now(); span.durationMs = span.endMs - span.startMs; span.childPhases = childPhases.slice(firstChild); }
}

/** An old release duration cannot witness the current close. This checks only
 * registered document consumers; global product handles remain separate. */
export function observedAdapterRelease(witness) {
  const before = witness?.beforeLifecycle, current = witness?.lifecycle;
  if (current?.failed === true) throw Error('Document resource release failed');
  let missingCounters = false;
  if (current?.consumers && typeof current.consumers === 'object') for (const counters of Object.values(current.consumers)) {
    if (!counters || typeof counters !== 'object' || !Object.keys(counters).length) { missingCounters = true; continue; }
    for (const value of Object.values(counters)) {
      if (value === true || typeof value === 'number' && value > 0) throw Error('Document consumer retains a resource after close');
      if (value !== 0 && value !== false) missingCounters = true;
    }
  }
  if (!before || !current || current.releasing !== false || current.failed !== false
    || !Number.isInteger(before.releases) || before.releases < 0 || !Number.isInteger(current.releases) || current.releases <= before.releases
    || !Number.isFinite(current.lastReleaseMilliseconds) || current.lastReleaseMilliseconds < 0
    || !current.consumers || typeof current.consumers !== 'object' || !Object.keys(current.consumers).length || missingCounters)
    return { releaseMs: null, missing: ['A fresh successful registered-consumer release generation was not observed.'] };
  return { releaseMs: current.lastReleaseMilliseconds, beforeGeneration: before.releases, releasedGeneration: current.releases,
    scope: 'registered-document-consumers', globalHandleCoverage: false, missing: [] };
}

export function adapterLifecycleResult({ phases, childPhases, assertions = {}, selectedEntries = [], weightsIdentity = null, configIdentity = null, observations = {}, evidence = [], missing = [], releaseMs = null, resourceSamples = [] }) {
  const semantic = Object.fromEntries(ADAPTER_LIFECYCLE_ASSERTIONS.map(key => [key, assertions[key] ?? null]));
  for (const value of Object.values(semantic)) assert(value === null || typeof value === 'boolean', 'Lifecycle assertions are observed true/false or unknown null');
  const selectedArtifacts = selectedEntries.map(selectedAdapterIdentity);
  assert.equal(new Set(selectedArtifacts.map(item => item.identity)).size, selectedArtifacts.length, 'Selection cannot duplicate an immutable version');
  const missingFacts = [...missing];
  let crossedImport = false;
  const imported = observations.importedBinding;
  if (selectedArtifacts.length && !imported) missingFacts.push('The actual imported immutable version binding is unavailable.');
  if (imported) for (const item of selectedArtifacts) {
    const selected = item.value;
    const sameRef = (left, right) => left === null && right === null || left && right && ['hash', 'byteLength', 'mediaType'].every(key => left[key] === right[key]);
    const same = selected.versionId === imported.versionId && selected.adapterId === imported.adapterId && selected.version === imported.version
      && sameRef(selected.weights, imported.weights) && sameRef(selected.config, imported.config)
      && (!/^sha256:[a-f0-9]{64}$/.test(weightsIdentity ?? '') || selected.weights.hash === weightsIdentity)
      && (!/^sha256:[a-f0-9]{64}$/.test(configIdentity ?? '') || selected.config?.hash === configIdentity);
    if (!same) { crossedImport = true; missingFacts.push('A selected immutable version differs from the actual fixed imported version.'); }
  }
  if (phases.length !== ADAPTER_LIFECYCLE_PHASES.length || !phases.every((phase, index) => phase.name === ADAPTER_LIFECYCLE_PHASES[index] && phase.outcome === 'expected'
    && Number.isFinite(phase.startMs) && Number.isFinite(phase.endMs) && phase.startMs >= 0 && phase.endMs >= phase.startMs && (!index || phase.startMs >= phases[index - 1].endMs))) missingFacts.push('The complete ordered WA parent action clocks are unavailable.');
  if (selectedArtifacts.length < 1 || selectedArtifacts.length > 3) missingFacts.push('One to three distinct immutable adapter selections were not observed.');
  if (![weightsIdentity, configIdentity].every(value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value))) missingFacts.push('Fixed weights/config identities are unavailable.');
  for (const [key, value] of Object.entries(semantic)) if (value === null) missingFacts.push('No complete observation for WA ' + key + '.');
  if (!Number.isFinite(releaseMs) || releaseMs < 0) missingFacts.push('Last-consumer release duration is unobserved.');
  return { status: crossedImport || Object.values(semantic).includes(false) || phases.some(phase => phase.outcome === 'failed') ? 'fail' : missingFacts.length ? 'inconclusive' : 'pass',
    phases, childPhases, assertions: semantic, selectedIdentities: selectedArtifacts.map(item => item.identity), selectedArtifacts,
    weightsIdentity, configIdentity, observations, evidence, missing: [...new Set(missingFacts)], releaseMs, resourceSamples };
}

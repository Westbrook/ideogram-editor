import { isRendererTextureNotApplicable } from './renderer-ownership.mjs';

export const RESOURCE_KEYS = Object.freeze(['browserRssBytes', 'backendRssBytes', 'settledBytes', 'cpuBytes', 'gpuBytes', 'previewCacheBytes', 'unusedHandles', 'textureSide', 'deviceTextureLimit']);
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** Evaluate each original texture pair. Independent maxima cannot prove that
 * every texture fit the device that actually owned it. */
export function resourceTextureObservation(sample) {
  if (sample?.rendererOwnership?.textureLimitApplicability === 'not-applicable') {
    const approved = sample.textureSide === null && sample.deviceTextureLimit === null && isRendererTextureNotApplicable(sample.rendererOwnership, sample.rendererOwnershipProof, { gpuBytes: sample.gpuBytes });
    return { known: approved, notApplicable: approved, violation: false };
  }
  const known = sample?.allocationCoverage?.textureLimits === true && integer(sample?.textureSide) && integer(sample?.deviceTextureLimit) && sample.deviceTextureLimit > 0;
  return { known, notApplicable: false, violation: known && sample.textureSide > Math.min(2048, sample.deviceTextureLimit) };
}

/** Retains only a bounded set of original observations. Samples are never
 * merged into an artificial observation of independently measured maxima. */
export function createResourceObservationSummary() {
  const peaks = Object.fromEntries(RESOURCE_KEYS.map(key => [key, null]));
  const peakSamples = Object.fromEntries(RESOURCE_KEYS.map(key => [key, null]));
  const textureLimits = { complete: true, observedSamples: 0, violations: 0, notApplicableSamples: 0 };
  let first = null, last = null, firstIncomplete = null, firstTextureViolation = null, count = 0, complete = true;
  function add(sample) {
    if (!integer(sample?.ordinal) || sample.ordinal < 1 || last && sample.ordinal !== last.ordinal + 1) throw Error('Resource summary requires consecutive original observations');
    const observationComplete = sample.allocationCoverage?.complete === true && ['cpu', 'gpu', 'previewCache', 'handles'].every(key => sample.allocationCoverage[key] === true) && RESOURCE_KEYS.filter(key => !['textureSide', 'deviceTextureLimit'].includes(key)).every(key => integer(sample[key])) && sample.settledBytes === sample.browserRssBytes + sample.backendRssBytes && sample.forcedGC === false && Array.isArray(sample.missing) && sample.missing.length === 0;
    if (!observationComplete) { complete = false; firstIncomplete ??= sample; }
    first ??= sample; last = sample; count++;
    for (const key of RESOURCE_KEYS) if (integer(sample[key]) && (peaks[key] === null || sample[key] > peaks[key])) { peaks[key] = sample[key]; peakSamples[key] = sample; }
    const texture = resourceTextureObservation(sample);
    textureLimits.observedSamples++;
    textureLimits.complete &&= texture.known;
    if (texture.notApplicable) textureLimits.notApplicableSamples++;
    if (texture.violation) { textureLimits.violations++; firstTextureViolation ??= sample; }
  }
  function snapshot() {
    const selected = [first, last, firstIncomplete, firstTextureViolation, ...Object.values(peakSamples)].filter(Boolean);
    const samples = [...new Map(selected.map(sample => [sample.ordinal, sample])).values()].sort((a, b) => a.ordinal - b.ordinal);
    return structuredClone({ sampleCount: count, firstOrdinal: first?.ordinal ?? null, lastOrdinal: last?.ordinal ?? null, complete: count > 0 && complete && textureLimits.complete,
      peaks, peakSamples, textureLimits: { ...textureLimits, complete: count > 0 && textureLimits.complete }, samples });
  }
  return { add, snapshot };
}

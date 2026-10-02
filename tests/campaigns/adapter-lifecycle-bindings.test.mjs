import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTER_LIFECYCLE_ASSERTIONS, ADAPTER_LIFECYCLE_PHASES, adapterLifecycleResult, measureAdapterAction, observedAdapterRelease } from '../../tooling/qualification/campaigns/adapter-lifecycle.mjs';

const reference = character => ({ hash: 'sha256:' + character.repeat(64), byteLength: '268435456', mediaType: 'application/octet-stream' });
const entry = () => ({ versionId: 'imported-version-1', adapterId: 'imported-adapter-1', version: '1', weights: reference('a'), config: { ...reference('b'), byteLength: '29', mediaType: 'text/plain' } });
async function completeBinding() {
  const importedBinding = entry(), phases = [], childPhases = [];
  for (const name of ADAPTER_LIFECYCLE_PHASES) await measureAdapterAction(phases, childPhases, name, async () => {});
  return { phases, childPhases, assertions: Object.fromEntries(ADAPTER_LIFECYCLE_ASSERTIONS.map(key => [key, true])),
    selectedEntries: [structuredClone(importedBinding)], weightsIdentity: importedBinding.weights.hash, configIdentity: importedBinding.config.hash,
    observations: { importedBinding }, releaseMs: 1, resourceSamples: [] };
}
function releaseWitness() {
  return { beforeLifecycle: { releases: 3 }, lifecycle: { releases: 4, failed: false, releasing: false, lastReleaseMilliseconds: 2,
    consumers: { 'editor-client': { uploads: 0, draftReads: 0 }, 'editor-shell': { nativeTextActive: false, decodedBitmaps: 0 } } } };
}

test('a lifecycle selection requires the actual imported immutable binding, not a success flag', async () => {
  const input = await completeBinding(); assert.equal(adapterLifecycleResult(input).status, 'pass');
  delete input.observations.importedBinding; input.observations.selectedImportedIdentity = true;
  const absent = adapterLifecycleResult(input);
  assert.equal(absent.status, 'inconclusive'); assert(absent.missing.some(reason => reason.includes('imported immutable version binding')));
});

test('crossed imported versions or any typed weights/config identity component fail the lifecycle', async () => {
  const complete = await completeBinding();
  for (const mutate of [
    binding => { binding.versionId = 'other-version'; }, binding => { binding.adapterId = 'other-adapter'; }, binding => { binding.version = '2'; },
    binding => { binding.weights.hash = reference('c').hash; }, binding => { binding.weights.byteLength = '268435455'; }, binding => { binding.weights.mediaType = 'text/plain'; },
    binding => { binding.config.hash = reference('c').hash; }, binding => { binding.config.byteLength = '30'; }, binding => { binding.config.mediaType = 'application/json'; },
    binding => { binding.config = null; },
  ]) {
    const input = structuredClone(complete); mutate(input.observations.importedBinding);
    const result = adapterLifecycleResult(input); assert.equal(result.status, 'fail');
    assert(result.missing.some(reason => reason.includes('differs from the actual fixed imported version')));
  }
  const wrongFixed = structuredClone(complete); wrongFixed.weightsIdentity = reference('d').hash;
  assert.equal(adapterLifecycleResult(wrongFixed).status, 'fail');
  const extraVersion = structuredClone(complete); extraVersion.selectedEntries.push({ ...entry(), versionId: 'another-version', version: '2' });
  assert.equal(adapterLifecycleResult(extraVersion).status, 'fail', 'Shared artifact bytes do not make an unimported immutable version the imported version');
});

test('identical typed imported references are independent of JSON property insertion order', async () => {
  const input = await completeBinding();
  for (const key of ['weights', 'config']) {
    const ref = input.observations.importedBinding[key]; input.observations.importedBinding[key] = { mediaType: ref.mediaType, byteLength: ref.byteLength, hash: ref.hash };
  }
  assert.equal(adapterLifecycleResult(input).status, 'pass');
});

test('only a fresh successful release yields its real nonnegative registered-consumer duration', () => {
  const witness = releaseWitness(), result = observedAdapterRelease(witness);
  assert.equal(result.releaseMs, 2); assert.equal(result.beforeGeneration, 3); assert.equal(result.releasedGeneration, 4);
  assert.equal(result.scope, 'registered-document-consumers'); assert.equal(result.globalHandleCoverage, false); assert.deepEqual(result.missing, []);
  witness.lifecycle.lastReleaseMilliseconds = 0;
  assert.equal(observedAdapterRelease(witness).releaseMs, 0, 'An actually measured zero is distinct from a missing duration');
});

test('stale release generations and missing release observations stay inconclusive', () => {
  for (const mutate of [
    value => { delete value.beforeLifecycle; }, value => { delete value.lifecycle; },
    value => { value.lifecycle.releases = 3; }, value => { value.lifecycle.releases = 2; },
    value => { value.beforeLifecycle.releases = -1; }, value => { value.lifecycle.releases = 4.5; },
    value => { value.lifecycle.releasing = true; }, value => { delete value.lifecycle.failed; },
    value => { value.lifecycle.lastReleaseMilliseconds = null; }, value => { value.lifecycle.lastReleaseMilliseconds = NaN; },
    value => { value.lifecycle.lastReleaseMilliseconds = Infinity; }, value => { value.lifecycle.lastReleaseMilliseconds = -1; },
    value => { value.lifecycle.consumers = {}; }, value => { value.lifecycle.consumers['editor-client'] = {}; },
    value => { value.lifecycle.consumers['editor-client'].uploads = null; },
  ]) {
    const witness = releaseWitness(); mutate(witness); const result = observedAdapterRelease(witness);
    assert.equal(result.releaseMs, null); assert(result.missing.length > 0);
  }
  assert.equal(observedAdapterRelease(undefined).releaseMs, null);
});

test('known release failures or retained consumer resources cannot be hidden by stale timing evidence', () => {
  const failed = releaseWitness(); failed.lifecycle.failed = true; delete failed.beforeLifecycle;
  assert.throws(() => observedAdapterRelease(failed), /release failed/);
  for (const value of [1, true]) {
    const witness = releaseWitness(); witness.lifecycle.consumers['editor-client'].uploads = value;
    assert.throws(() => observedAdapterRelease(witness), /retain|resource/i);
    witness.lifecycle.releases = witness.beforeLifecycle.releases;
    assert.throws(() => observedAdapterRelease(witness), /retain|resource/i);
  }
});

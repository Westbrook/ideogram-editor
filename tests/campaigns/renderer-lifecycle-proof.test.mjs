import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleRendererProof } from '../../tooling/qualification/campaigns/verification.mjs';

// These are association witnesses only. The renderer proof module independently
// validates the approved contract, source/build identities and retained bytes.
const proof = () => ({ kind: 'renderer-ownership-proof-1', reviewId: 'association-test-only', artifact: { sha256: 'sha256:' + 'a'.repeat(64) } });

test('absent renderer proofs preserve the ordinary measured-texture resource path', () => {
  assert.equal(lifecycleRendererProof({ B0: { resources: { textureSide: 512, deviceTextureLimit: 4096 } }, cycles: [{ resources: { textureSide: 512, deviceTextureLimit: 4096 } }] }), null);
});

test('a B0 proof remains available when the final sampler fails after observed cycles', () => {
  const expected = proof();
  assert.deepEqual(lifecycleRendererProof({ B0: { resources: { rendererOwnershipProof: expected } }, cycles: [], sampling: null, samplingError: { message: 'Late seal failure' } }), expected);
});

test('serialized copies across baseline, cycles, action samples and raw observations share one proof', () => {
  const expected = proof(), sample = () => ({ rendererOwnershipProof: structuredClone(expected) });
  const result = { B0: { resources: sample() }, cycles: [{ resources: sample(), resourceObservation: { resources: sample() }, resourceSamples: [sample()], action: { resourceSamples: [sample()] } }], sampling: { rendererOwnershipProof: expected } };
  assert.deepEqual(lifecycleRendererProof(result, [sample(), sample()]), expected);
});

test('raw or cycle proof substitutions cannot inherit the final sampler proof', () => {
  const expected = proof(), changed = proof(); changed.artifact.sha256 = 'sha256:' + 'b'.repeat(64);
  const result = { sampling: { rendererOwnershipProof: expected }, cycles: [] };
  assert.throws(() => lifecycleRendererProof(result, [{ rendererOwnershipProof: changed }]), /mixed renderer/);
  assert.throws(() => lifecycleRendererProof({ ...result, cycles: [{ resourceObservation: { resources: { rendererOwnershipProof: changed } } }] }), /mixed renderer/);
});

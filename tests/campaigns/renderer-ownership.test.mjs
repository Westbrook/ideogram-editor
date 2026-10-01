import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJSON } from '../../tooling/qualification/core.mjs';
import { digest } from '../../tooling/qualification/campaigns/common.mjs';
import { CANVAS2D_RENDERER_CONTRACT, REVIEWED_RENDERER_OWNERSHIP, captureRendererOwnershipProof,
  verifyRendererOwnershipProof, isRendererTextureNotApplicable } from '../../tooling/qualification/campaigns/renderer-ownership.mjs';

function context() {
  // Intentionally unreviewed in-memory inputs. A caller cannot approve these
  // by signing its own manifest, and this test must never read a live build.
  const sourceFiles = [{ path: 'src/unreviewed-renderer.ts', bytes: 1, sha256: digest('x').slice(7) }];
  const buildFiles = [{ path: 'dist/app/unreviewed.js', bytes: 1, sha256: digest('x') }];
  const executableIdentity = { sourceDigest: digestJSON(sourceFiles), buildDigest: digest(buildFiles), toolsDigest: digest('test tools') };
  return { sourceFiles, buildFiles, executableIdentity };
}
function unreviewedProof() {
  return { kind: 'renderer-ownership-proof-1', reviewId: 'unreviewed-test-renderer', reviewSha256: digest('self-declared review'),
    contract: 'canvas2d-owned-rgba-v1', executableIdentity: context().executableIdentity,
    artifact: { path: '/retained/renderer-ownership.json', retainedPath: 'renderer-ownership.json', bytes: 1, sha256: digest('x') } };
}
const claim = bytes => ({ ...CANVAS2D_RENDERER_CONTRACT, rgbaBackingEstimateBytes: bytes });

test('renderer contract records Canvas2D ownership without inventing a hardware texture limit', () => {
  assert.deepEqual(CANVAS2D_RENDERER_CONTRACT, { contract: 'canvas2d-owned-rgba-v1', backend: 'main-thread-canvas-2d',
    appOwnedTextureAPIs: [], appOwnedTextureCount: 0, textureLimitApplicability: 'not-applicable' });
  assert.equal(Object.hasOwn(CANVAS2D_RENDERER_CONTRACT, 'deviceTextureLimit'), false);
  assert.equal(Object.hasOwn(CANVAS2D_RENDERER_CONTRACT, 'rgbaBackingEstimateBytes'), false);
  assert(Object.isFrozen(CANVAS2D_RENDERER_CONTRACT));
  assert(Object.isFrozen(CANVAS2D_RENDERER_CONTRACT.appOwnedTextureAPIs));
  assert(Object.isFrozen(REVIEWED_RENDERER_OWNERSHIP));
});

test('unreviewed production bytes fail closed before any filesystem reads or evidence writes', async () => {
  const result = await captureRendererOwnershipProof({ repo: '/must-not-be-read', output: '/must-not-be-written', ...context() });
  assert.deepEqual(result, { proof: null, artifact: null, missing: ['No exact reviewed production renderer source closure is available'] });
});

test('renderer capture binds both independent parent manifests before considering a source approval', async () => {
  const changes = [
    value => { value.sourceFiles[0].bytes++; },
    value => { value.buildFiles[0].bytes++; },
    value => { value.executableIdentity.sourceDigest = digest('other source').slice(7); },
    value => { value.executableIdentity.buildDigest = digest('other build'); },
    value => { value.executableIdentity.toolsDigest = 'not a digest'; },
    value => { value.sourceFiles.push({ ...value.sourceFiles[0] }); value.executableIdentity.sourceDigest = digestJSON(value.sourceFiles); },
    value => { value.buildFiles[0].path = '../app/unreviewed.js'; value.executableIdentity.buildDigest = digest(value.buildFiles); },
  ];
  for (const change of changes) {
    const value = context(); change(value);
    await assert.rejects(captureRendererOwnershipProof({ repo: '/must-not-be-read', output: '/must-not-be-written', ...value }), Error);
  }
});

test('compact renderer metadata survives serialization but cannot approve its own review', async () => {
  const proof = unreviewedProof(), text = JSON.stringify(proof), parsed = JSON.parse(text);
  assert(Buffer.byteLength(text) < 1024);
  assert.deepEqual(parsed, proof);
  let reads = 0;
  await assert.rejects(verifyRendererOwnershipProof(parsed, { output: '/retained', ...context(), readRetained: async () => { reads++; return Buffer.from('x'); } }), /no exact approved source review/);
  assert.equal(reads, 0);
  assert.equal(isRendererTextureNotApplicable(claim(4096), parsed, { gpuBytes: 4096 }), false);
});

test('renderer proof replay rejects oversized or unknown metadata before reading retained input', async () => {
  const proof = unreviewedProof(); proof.artifact.path = '/' + 'x'.repeat(2048) + '/renderer-ownership.json';
  await assert.rejects(verifyRendererOwnershipProof(proof, { ...context(), readRetained: async () => { throw Error('must not read'); } }), /Malformed renderer ownership proof metadata/);
  const forged = { ...unreviewedProof(), status: 'PASS' };
  await assert.rejects(verifyRendererOwnershipProof(forged), /Malformed renderer ownership proof metadata/);
});

test('missing or caller-declared Canvas2D evidence never grants texture-limit N/A', () => {
  for (const proof of [null, {}, { status: 'PASS' }, { ...unreviewedProof(), reviewed: true }, unreviewedProof()]) {
    assert.equal(isRendererTextureNotApplicable(claim(4096), proof, { gpuBytes: 4096 }), false);
  }
  // The real reviewed registry intentionally has no synthetic test override.
  // A positive N/A regression requires actual reviewed production pins.
  for (const producer of [
    claim(0), claim(4096), claim(-1), claim(NaN), { ...claim(4096), appOwnedTextureAPIs: ['WebGLRenderingContext'] },
    { ...claim(4096), appOwnedTextureCount: 1 }, { ...claim(4096), textureLimitApplicability: 'applicable' },
    { ...claim(4096), backend: 'webgpu' }, { ...claim(4096), deviceTextureLimit: 16384 },
  ]) assert.equal(isRendererTextureNotApplicable(producer, unreviewedProof(), { gpuBytes: 4096 }), false);
});

test('changing a serialized review digest cannot introduce an approval', () => {
  const proof = unreviewedProof(); proof.reviewSha256 = digest({ review: 'new renderer declaration', contract: CANVAS2D_RENDERER_CONTRACT });
  assert.equal(isRendererTextureNotApplicable(claim(128), proof, { gpuBytes: 128 }), false);
  assert.equal(isRendererTextureNotApplicable(claim(128), proof, { gpuBytes: 0 }), false);
});

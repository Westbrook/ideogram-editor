import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { sourceIdentityAsync, digestJSON } from '../../tooling/qualification/core.mjs';
import { buildIdentity, toolIdentity } from '../../tooling/qualification/campaigns/identity.mjs';
import { digest } from '../../tooling/qualification/campaigns/common.mjs';
import {
  REVIEWED_RENDERER_OWNERSHIP, CANVAS2D_RENDERER_CONTRACT,
  APP_OWNED_ALLOCATION_CONTRACT, TEXT_RESOURCE_OWNERSHIP_CONTRACT,
  captureRendererOwnershipProof, verifyRendererOwnershipProof,
  isRendererTextureNotApplicable, isTextResourceOwnershipProof,
} from '../../tooling/qualification/campaigns/renderer-ownership.mjs';

// This whole-file integration must accompany an independently reviewed real
// registry entry. It never inserts test approval, changes product inputs, or
// treats its own PASS as the preapproval correctness evidence. Missing authority
// is a failure, not a skipped test. The shared runner owns builds and evidence.
let subject;
before(async () => {
  assert.equal(process.env.IE_CAMPAIGN_PRODUCT_INTEGRATION, '1', 'Use the registered whole-file shared-runner selection');
  assert(REVIEWED_RENDERER_OWNERSHIP.some(review => review.appAllocation?.textResources), 'A genuine reviewed production R35 entry is required; no synthetic approval is installed');
  const repo = await realpath(new URL('../../', import.meta.url));
  // The development runner supplies QUALIFICATION_OUTPUT; the isolated C/I
  // developer suite supplies EDITOR_RECEIPT within its retained gate directory.
  // Use only one of those explicit existing parents, never a guessed temp root.
  const editorReceipt = process.env.EDITOR_RECEIPT;
  const evidenceRoot = process.env.QUALIFICATION_OUTPUT ??
    (typeof editorReceipt === 'string' && isAbsolute(editorReceipt) ? dirname(editorReceipt) : null);
  assert(typeof evidenceRoot === 'string' && isAbsolute(evidenceRoot), 'An explicit runner evidence output is required');
  const canonicalEvidence = await realpath(evidenceRoot);
  assert.equal(canonicalEvidence, evidenceRoot);
  if (process.env.QUALIFICATION_OUTPUT !== undefined)
    assert(canonicalEvidence.startsWith(join(repo, 'artifacts') + sep), 'Development-runner evidence must remain inside the owned subject allocation');
  const source = await sourceIdentityAsync(repo), build = await buildIdentity(repo), tools = await toolIdentity(repo);
  assert.deepEqual(build.missing, [], 'Current server and finalized app builds are required');
  assert.deepEqual(tools.missing, [], 'Current installed tool identities are required');
  assert.equal(tools.node.version, '26.10.0');
  const context = { sourceFiles: source.files, buildFiles: build.files, executableIdentity: {
    sourceDigest: source.digest, buildDigest: build.digest, toolsDigest: digest(tools),
  } };
  const output = join(canonicalEvidence, 'renderer-ownership-approved-' + randomUUID());
  await mkdir(output, { mode: 0o700 });
  assert.equal(await realpath(output), output);
  const result = await captureRendererOwnershipProof({ repo, output, ...context });
  assert.deepEqual(result.missing, []);
  assert.equal(result.proof?.kind, 'renderer-ownership-proof-2');
  const review = REVIEWED_RENDERER_OWNERSHIP.find(value => value.id === result.proof.reviewId);
  assert(review);
  assert.deepEqual(review.appAllocation.contract, APP_OWNED_ALLOCATION_CONTRACT);
  assert.deepEqual(review.appAllocation.textResources, TEXT_RESOURCE_OWNERSHIP_CONTRACT);
  const raw = await readFile(result.artifact.path);
  assert.equal(raw.length, result.artifact.bytes);
  assert.equal(digest(raw), result.artifact.sha256);
  await writeFile(join(output, 'integration-context.json'), JSON.stringify({
    kind: 'renderer-ownership-approved-integration-inputs-1', qualification: false,
    context, proof: result.proof,
    scope: 'Genuine preapproved source/native/build/runtime-byte retention and replay; no browser resource measurement or physical qualification',
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  subject = { repo, source, build, tools, context, output, proof: result.proof, review, raw };
});

after(async () => {
  if (!subject) return;
  assert.deepEqual(await sourceIdentityAsync(subject.repo), subject.source, 'Tests must not mutate source');
  assert.deepEqual(await buildIdentity(subject.repo), subject.build, 'Tests must not mutate builds');
  assert.deepEqual(await toolIdentity(subject.repo), subject.tools, 'Tests must not mutate installed tools');
  assert.deepEqual(await readFile(subject.proof.artifact.path), subject.raw, 'Original retained proof bytes remain unchanged');
  // Keep all evidence in the runner-owned allocation, including failure output.
});

function reader(bytes = subject.raw) {
  return async name => {
    assert.equal(name, 'renderer-ownership-v2.json');
    return bytes;
  };
}
function contextWith(change) {
  const value = structuredClone(subject.context);
  change(value);
  value.executableIdentity.sourceDigest = digestJSON(value.sourceFiles);
  value.executableIdentity.buildDigest = digest(value.buildFiles);
  return value;
}
async function refusesChangedContext(context) {
  // All parent hashes are recalculated: refusal must come from the independent
  // approved source/build closure, before either sentinel directory is read.
  assert.deepEqual(await captureRendererOwnershipProof({ repo: '/must-not-be-read', output: '/must-not-be-written', ...context }), {
    proof: null, artifact: null, missing: ['No exact reviewed production renderer source closure is available'],
  });
}
async function refusesResealedPayload(change, expected) {
  const payload = JSON.parse(subject.raw.toString('utf8'));
  change(payload);
  const raw = Buffer.from(JSON.stringify(payload, null, 2) + '\n');
  const proof = structuredClone(subject.proof);
  proof.artifact.bytes = raw.length;
  proof.artifact.sha256 = digest(raw);
  // Reseal the outer artifact so the negative control reaches inner authority.
  await assert.rejects(verifyRendererOwnershipProof(proof, {
    output: subject.output, ...subject.context, readRetained: reader(raw),
  }), expected);
}
function alterRetainedInput(input) {
  assert(input && ['utf8', 'base64'].includes(input.encoding));
  input.content = input.encoding === 'utf8' ? input.content + '\n' :
    Buffer.concat([Buffer.from(input.content, 'base64'), Buffer.from([0])]).toString('base64');
}

test('actual approved production inputs capture and replay the exact v2 R35 authority', async () => {
  const proof = await verifyRendererOwnershipProof(JSON.parse(JSON.stringify(subject.proof)), {
    output: subject.output, ...subject.context, readRetained: reader(),
  });
  assert.deepEqual(proof, subject.proof);
  assert(Object.isFrozen(proof));
  assert.equal(isTextResourceOwnershipProof(proof), true);
  assert.equal(isRendererTextureNotApplicable({ ...CANVAS2D_RENDERER_CONTRACT, rgbaBackingEstimateBytes: 4096 }, proof, { gpuBytes: 4096 }), true);
  assert.equal(subject.review.appAllocation.contract.globalCoverageComplete, false);
  assert.equal(subject.review.appAllocation.textResources.physicalAllocations, false);
  assert(subject.review.appAllocation.runtimeInputs.length >= 1);
  assert(subject.review.appAllocation.runtimeInputs.every(pin => pin.role === 'correctness-receipt' && pin.bytes > 0));
  const evidence = JSON.parse(JSON.parse(subject.raw.toString('utf8')).buildEvidence.content);
  const loader = subject.review.nativeFiles.find(pin => pin.role === 'loader');
  assert(evidence.outputs.some(output => output.workerBundle?.modules.includes(loader.path)));
  assert.equal(evidence.nativeInputs.length, 3);
});

test('changed, omitted and additional application sources cannot reuse the approved row', async () => {
  const path = subject.review.sourceFiles.find(pin => pin.path.startsWith('src/')).path;
  for (const change of [
    value => { value.sourceFiles.find(pin => pin.path === path).sha256 = digest('changed application source').slice(7); },
    value => { value.sourceFiles = value.sourceFiles.filter(pin => pin.path !== path); },
    value => { value.sourceFiles.push({ path: 'src/unreviewed-extra-renderer-owner.ts', bytes: 1, sha256: digest('x').slice(7) }); },
  ]) await refusesChangedContext(contextWith(change));
});

test('changed, omitted and additional application outputs cannot reuse approved runtime evidence', async () => {
  const path = subject.review.appAllocation.appBuildFiles.find(pin => pin.path.endsWith('.js')).path;
  for (const change of [
    value => { value.buildFiles.find(pin => pin.path === path).sha256 = digest('changed application output'); },
    value => { value.buildFiles = value.buildFiles.filter(pin => pin.path !== path); },
    value => { value.buildFiles.push({ path: 'dist/app/unreviewed-extra-output.js', bytes: 1, sha256: digest('x') }); },
  ]) await refusesChangedContext(contextWith(change));
});

test('outer resealing cannot hide changed retained source or native package loader and WASM', async () => {
  await refusesResealedPayload(payload => alterRetainedInput(payload.retainedSources[0]), /Retained renderer input bytes differ/);
  for (const role of ['package', 'loader', 'wasm']) {
    const index = subject.review.nativeFiles.findIndex(pin => pin.role === role);
    assert(index >= 0);
    await refusesResealedPayload(payload => alterRetainedInput(payload.retainedNativeInputs[index]), /Retained renderer input bytes differ/);
  }
});

test('outer resealing cannot replace or omit the actual preapproval correctness receipts', async () => {
  await refusesResealedPayload(payload => alterRetainedInput(payload.retainedRuntimeInputs[0]), /Retained renderer input bytes differ/);
  await refusesResealedPayload(payload => { payload.retainedRuntimeInputs.pop(); }, /correctness receipts differ/);
  await refusesResealedPayload(payload => { payload.appAllocation.runtimeInputs[0].sha256 = digest('caller-declared PASS'); }, /application approval differs/);
});

test('outer resealing cannot alter finalized build evidence or enlarge the approved allocation scope', async () => {
  await refusesResealedPayload(payload => {
    const build = JSON.parse(payload.buildEvidence.content);
    build.capture.finalized = false;
    payload.buildEvidence.content = JSON.stringify(build);
    const raw = Buffer.from(payload.buildEvidence.content);
    payload.buildEvidence.bytes = raw.length;
    payload.buildEvidence.sha256 = digest(raw);
  }, /Renderer build evidence differs/);
  await refusesResealedPayload(payload => { payload.appAllocation.textResources.physicalAllocations = true; }, /application approval differs/);
  await refusesResealedPayload(payload => { payload.appAllocation.contract.globalCoverageComplete = true; }, /application approval differs/);
});

test('the real proof cannot be substituted across parent identities or evidence groups', async () => {
  const context = structuredClone(subject.context);
  context.executableIdentity.toolsDigest = digest('different actual tool identity');
  let reads = 0;
  await assert.rejects(verifyRendererOwnershipProof(subject.proof, {
    output: subject.output, ...context, readRetained: async () => { reads++; return subject.raw; },
  }), /another parent executable identity/);
  assert.equal(reads, 0);
  await assert.rejects(verifyRendererOwnershipProof(subject.proof, {
    output: subject.output + '-other-group', ...subject.context, readRetained: reader(),
  }), /exact retained group/);
  const changed = structuredClone(subject.proof);
  changed.reviewSha256 = digest('unreviewed approval replacement');
  assert.equal(isTextResourceOwnershipProof(changed), false);
  assert.equal(isTextResourceOwnershipProof({ ...subject.proof, kind: 'renderer-ownership-proof-1' }), false);
});

test('unreviewed GPU and texture claims remain rejected despite a valid approved software-renderer proof', () => {
  for (const declaration of [
    { ...CANVAS2D_RENDERER_CONTRACT, rgbaBackingEstimateBytes: 4096, appOwnedTextureAPIs: ['webgpu'] },
    { ...CANVAS2D_RENDERER_CONTRACT, rgbaBackingEstimateBytes: 4096, appOwnedTextureCount: 1 },
    { ...CANVAS2D_RENDERER_CONTRACT, rgbaBackingEstimateBytes: 4096, deviceTextureLimit: 16384 },
    { ...CANVAS2D_RENDERER_CONTRACT, rgbaBackingEstimateBytes: 0 },
  ]) assert.equal(isRendererTextureNotApplicable(declaration, subject.proof, { gpuBytes: 4096 }), false);
});

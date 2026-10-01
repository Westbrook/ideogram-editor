import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digestJSON } from '../core.mjs';
import { digest, exclusiveJSON } from './common.mjs';

const EVIDENCE_FILE = 'renderer-ownership.json';
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

/** Approval is an explicit review result, never discovered from live files.
 * Staged display code is deliberately absent. Add a review only after its
 * production source closure and sealed native renderer have been reviewed.
 *
 * Each entry is {id, sourceFiles:[{path,bytes,sha256,encoding}],
 * nativeFiles:[{role:'package'|'loader'|'wasm',path,bytes,sha256,encoding}],
 * nativeRenderer:{package,version,rasterProfile,js:{bytes,sha256},wasm:{bytes,sha256}}}.
 * All hashes use the sha256: prefix. Sources cover every src/ file and the
 * application build/entry inputs below; extra reviewed source inputs are fine.
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
function selectedReview(sources) {
  return REVIEWED_RENDERER_OWNERSHIP.find(review => {
    try { reviewedSources(review, sources); return true; } catch { return false; }
  });
}
function proofReview(proof) {
  if (!exactKeys(proof, ['kind', 'reviewId', 'reviewSha256', 'contract', 'executableIdentity', 'artifact']) || proof.kind !== 'renderer-ownership-proof-1' ||
    proof.contract !== CANVAS2D_RENDERER_CONTRACT.contract || Buffer.byteLength(JSON.stringify(proof)) > MAX_PROOF_BYTES) throw Error('Malformed renderer ownership proof metadata');
  const review = REVIEWED_RENDERER_OWNERSHIP.find(value => value.id === proof.reviewId);
  if (!review || proof.reviewSha256 !== reviewIdentity(review)) throw Error('Renderer ownership has no exact approved source review');
  const identity = proof.executableIdentity, artifact = proof.artifact;
  if (!exactKeys(identity, ['sourceDigest', 'buildDigest', 'toolsDigest']) || !BARE_HASH.test(identity.sourceDigest ?? '') || !HASH.test(identity.buildDigest ?? '') || !HASH.test(identity.toolsDigest ?? '') ||
    !exactKeys(artifact, ['path', 'retainedPath', 'bytes', 'sha256']) || typeof artifact.path !== 'string' || !isAbsolute(artifact.path) || resolve(artifact.path) !== artifact.path ||
    artifact.retainedPath !== EVIDENCE_FILE || !artifact.path.endsWith(sep + EVIDENCE_FILE) || !integer(artifact.bytes) || artifact.bytes === 0 || artifact.bytes > MAX_EVIDENCE_BYTES || !HASH.test(artifact.sha256 ?? '')) throw Error('Malformed renderer ownership identity or retained artifact');
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
  if (!exactKeys(payload, ['kind', 'reviewId', 'reviewSha256', 'contract', 'executableIdentity', 'sourceClosure', 'nativeRenderer', 'retainedSources', 'retainedNativeInputs', 'buildEvidence']) || payload.kind !== 'renderer-ownership-evidence-1') throw Error('Malformed retained renderer ownership evidence');
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
  const context = contextIdentity({ sourceFiles, buildFiles, executableIdentity }), review = selectedReview(context.sources);
  if (!review) return { proof: null, artifact: null, missing: ['No exact reviewed production renderer source closure is available'] };
  if (typeof repo !== 'string' || typeof output !== 'string' || !isAbsolute(repo) || !isAbsolute(output) || await realpath(repo) !== repo || await realpath(output) !== output) throw Error('Renderer ownership requires canonical existing source and evidence directories');
  const retain = async pin => {
    const bytes = await readInput(repo, pin.path);
    const input = { path: pin.path, encoding: pin.encoding, content: pin.encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('base64') };
    decodeInput(input, pin); return input;
  };
  const retainedSources = [], retainedNativeInputs = [];
  for (const pin of review.sourceFiles) retainedSources.push(await retain(pin));
  for (const pin of review.nativeFiles) retainedNativeInputs.push(await retain(pin));
  const buildBytes = await readInput(repo, 'dist/app/build-evidence.json');
  const payload = { kind: 'renderer-ownership-evidence-1', reviewId: review.id, reviewSha256: reviewIdentity(review), contract: CANVAS2D_RENDERER_CONTRACT,
    executableIdentity, sourceClosure: review.sourceFiles, nativeRenderer: review.nativeRenderer, retainedSources, retainedNativeInputs,
    buildEvidence: { path: 'dist/app/build-evidence.json', bytes: buildBytes.length, sha256: digest(buildBytes), content: new TextDecoder('utf-8', { fatal: true }).decode(buildBytes) } };
  replay(payload, review, context);
  const bytes = Buffer.from(json(payload));
  if (bytes.length > MAX_EVIDENCE_BYTES) throw Error('Renderer ownership retained evidence exceeds its fixed bound');
  const artifact = { path: join(output, EVIDENCE_FILE), retainedPath: EVIDENCE_FILE, bytes: bytes.length, sha256: digest(bytes) };
  const proof = { kind: 'renderer-ownership-proof-1', reviewId: review.id, reviewSha256: reviewIdentity(review), contract: CANVAS2D_RENDERER_CONTRACT.contract, executableIdentity: structuredClone(executableIdentity), artifact };
  proofReview(proof);
  await exclusiveJSON(artifact.path, payload);
  return { proof: frozen(proof), artifact: proof.artifact, missing: [] };
}

/** readRetained must read this group's file through its outer immutable seal.
 * The callback returns verified bytes, never a subject/build pathname. */
export async function verifyRendererOwnershipProof(proof, { output, sourceFiles, buildFiles, executableIdentity, readRetained } = {}) {
  const review = proofReview(proof), context = contextIdentity({ sourceFiles, buildFiles, executableIdentity });
  same(proof.executableIdentity, executableIdentity, 'Renderer proof belongs to another parent executable identity');
  if (typeof output !== 'string' || !isAbsolute(output) || resolve(output) !== output || proof.artifact.path !== join(output, EVIDENCE_FILE) || typeof readRetained !== 'function') throw Error('Renderer proof does not belong to the exact retained group');
  const bytes = await readRetained(EVIDENCE_FILE);
  if (!Buffer.isBuffer(bytes) || bytes.length !== proof.artifact.bytes || digest(bytes) !== proof.artifact.sha256) throw Error('Renderer retained artifact identity differs');
  replay(parse(bytes), review, context);
  return frozen(structuredClone(proof));
}

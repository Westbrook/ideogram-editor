// Trusted pure candidate algebra. Captured helper JavaScript is compared only
// as bytes; this module has no filesystem reads and never executes evidence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {dirname, isAbsolute, join, normalize, relative, sep} from 'node:path';
import {ALPHA_SELECTED, ALPHA_SOURCE} from './webp-alpha-authority.mjs';

function candidateProducerPolicy(candidate) {
  for (const key of ['producerDirectory', 'version', 'sourceFreezeHash', 'producerHash', 'platform', 'arch'])
    assert.equal(candidate[key], ALPHA_SELECTED[key], 'Loader requires the exact repaired alpha producer');
  assert.equal(candidate.recipeManifestHash, ALPHA_SELECTED.recipe.hash);
  assert.deepEqual(candidate.artifact, ALPHA_SELECTED.artifact);
  assert.equal(candidate.source.hash, ALPHA_SOURCE.hash);
}
export const HASH = /^sha256:[a-f0-9]{64}$/;
export const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const WEBP_SOURCE_HASH = 'sha256:e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564';
const scalarOrder = (a, b) => {
  const aa = Array.from(a, ch => ch.codePointAt(0)), bb = Array.from(b, ch => ch.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
};
export function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') { assert(Number.isFinite(value)); return JSON.stringify(value); }
  if (typeof value === 'string') {
    let text = '"';
    for (const ch of value) {
      const cp = ch.codePointAt(0); assert(cp < 0xd800 || cp > 0xdfff, 'Lone surrogate in canonical identity');
      text += cp < 32 ? '\\u' + cp.toString(16).padStart(4, '0') : ch === '"' || ch === '\\' ? '\\' + ch : ch;
    }
    return text + '"';
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  assert(typeof value === 'object' && value && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  return '{' + Object.keys(value).sort(scalarOrder).map(key => canonical(key) + ':' + canonical(value[key])).join(',') + '}';
}
export function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
export function repositoryPath(root, name) {
  assert(typeof name === 'string' && name && name.split('/').every(part => part && part !== '.' && part !== '..') &&
    !name.includes('\\') && !isAbsolute(name));
  const path = join(root, name); assert(path.startsWith(root + sep)); return path;
}
export function replaceExact(source, replacements) {
  const ids = new Set(), counts = []; let result = source;
  for (const {id, from, to, count = 1} of replacements) {
    assert(typeof id === 'string' && id && !ids.has(id), 'Replacement IDs must be unique'); ids.add(id);
    assert(typeof from === 'string' && from && typeof to === 'string' && Number.isSafeInteger(count) && count > 0);
    assert.equal(result.split(from).length - 1, count, `Candidate transform drift: ${id}`);
    result = result.split(from).join(to); counts.push({id, count});
  }
  return {source: result, replacements: counts};
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label} must be a record`);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort(), `${label} fields differ`);
}
function absolutePath(path) {
  assert(typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !path.includes('\\') && !path.includes('\0'),
    'Normalized absolute path required');
}
function evidenceReference(reference, root, label) {
  exactKeys(reference, ['path', 'bytes', 'hash'], label); absolutePath(reference.path);
  const name = relative(root, reference.path);
  assert(name && !isAbsolute(name) && name.split(sep).every(part => part && part !== '..' && part !== '.'), 'Evidence reference escaped evidenceRoot');
  assert(Number.isSafeInteger(reference.bytes) && reference.bytes > 0 && reference.bytes <= 8 * 1048576, 'Bounded evidence bytes required');
  assert.match(reference.hash, HASH);
  return {path: reference.path, bytes: reference.bytes, hash: reference.hash};
}
function haloBinding(authorization, {candidateHash, artifactHash, sourceHash}) {
  exactKeys(authorization, ['schemaVersion', 'kind', 'candidateHash', 'artifactHash', 'sourceHash', 'proof', 'rule', 'sourceAudit', 'nativeProbe', 'evidenceRoot'], 'Halo authorization');
  assert.equal(authorization.schemaVersion, 1); assert.equal(authorization.kind, 'webp-halo-authorization-v1');
  for (const value of [candidateHash, artifactHash, sourceHash]) assert.match(value, HASH);
  assert.equal(authorization.candidateHash, candidateHash); assert.equal(authorization.artifactHash, artifactHash);
  assert.equal(authorization.sourceHash, sourceHash); absolutePath(authorization.evidenceRoot);
  const refs = {};
  for (const role of ['proof', 'sourceAudit', 'nativeProbe']) refs[role] = evidenceReference(authorization[role], authorization.evidenceRoot, role);
  assert.equal(new Set(Object.values(refs).map(ref => ref.path)).size, 3, 'Halo evidence roles must be distinct files');
  const rule = authorization.rule;
  exactKeys(rule, ['kind', 'pixelProfile', 'left', 'top', 'right', 'bottom', 'originAlignment'], 'Halo rule');
  assert.equal(rule.kind, 'encoded-grid-expand-align-origin-clamp-trim-v1');
  assert.equal(rule.pixelProfile, 'libwebp-1.6.0-full-rgba8-v1');
  for (const side of ['left', 'top', 'right', 'bottom']) assert(Number.isSafeInteger(rule[side]) && rule[side] >= 0 && rule[side] <= 16384);
  assert(Number.isSafeInteger(rule.originAlignment) && rule.originAlignment >= 2 && rule.originAlignment <= 8192 &&
    (rule.originAlignment & (rule.originAlignment - 1)) === 0);
  return {schemaVersion: 1, kind: 'webp-halo-authorization-v1', candidateHash, artifactHash, sourceHash,
    proof: refs.proof, rule: {...rule}, sourceAudit: refs.sourceAudit, nativeProbe: refs.nativeProbe, evidenceRoot: authorization.evidenceRoot};
}

export function buildCandidateBindings({candidate, candidateHash, artifactPath, hostClosure, policyHash, baseCodec, pipelineBase, haloAuthorization, sourceHash}) {
  for (const value of [candidateHash, policyHash, baseCodec, sourceHash]) assert.match(value, HASH);
  assert.equal(candidate.schemaVersion, 1); assert.equal(candidate.status, 'built-unqualified');
  assert.equal(candidate.transport, 'webp-advanced-file-v1'); assert.equal(candidate.abiVersion, 1);
  assert.equal(candidate.decoderVersion, 0x010600);
  assert(candidate.platform === 'darwin' && candidate.arch === 'arm64' || candidate.platform === 'linux' && ['arm64', 'x64'].includes(candidate.arch));
  assert(!Object.hasOwn(candidate, 'qualificationHash') && !Object.hasOwn(candidate, 'halo'), 'Candidate cannot carry issued authority');
  assert(candidate.qualified === undefined || candidate.qualified === false, 'Candidate cannot be qualified');
  assert.deepEqual(candidate.qualification, {issued: false, nativeTests: false, halo: null, colorCP1: false, cleanup: false, rss: false});
  assert.equal(candidate.source.version, '1.6.0'); assert.equal(candidate.source.hash, sourceHash); assert.equal(sourceHash, WEBP_SOURCE_HASH);
  assert.equal(candidate.source.archiveHash, sourceHash);
  assert(Number.isSafeInteger(candidate.source.bytes) && candidate.source.bytes > 0);
  repositoryPath('/source-reference', candidate.source.archive);
  candidateProducerPolicy(candidate);
  for (const key of ['producerHash', 'sourceFreezeHash', 'recipeManifestHash']) assert.match(candidate[key], HASH);
  assert.match(candidate.artifact.hash, HASH); assert(Number.isSafeInteger(candidate.artifact.bytes) && candidate.artifact.bytes > 0);
  assert(Number.isSafeInteger(candidate.residentCodeBytes) && candidate.residentCodeBytes >= candidate.artifact.bytes);
  absolutePath(artifactPath);
  assert.equal(hostClosure.schemaVersion, 1); assert.equal(hostClosure.kind, 'webp-host-closure-v1');
  for (const key of ['identityHash', 'compiledHash', 'sourceHash']) assert.match(hostClosure[key], HASH);
  assert.match(hostClosure.runtimeDependencies.identityHash, HASH);
  assert.equal(hostClosure.runtimeDependenciesIdentityHash, hostClosure.runtimeDependencies.identityHash);
  assert.equal(candidate.baseCodecAuthority.codecId, baseCodec); assert.equal(candidate.baseCodecAuthority.platform, candidate.platform);
  assert.equal(candidate.baseCodecAuthority.arch, candidate.arch); assert.equal(pipelineBase, 'cp1-f64-triangle-area-v1');
  const halo = haloBinding(haloAuthorization, {candidateHash, artifactHash: candidate.artifact.hash, sourceHash});
  const artifact = {path: artifactPath, bytes: candidate.artifact.bytes, hash: candidate.artifact.hash};
  const authorization = {kind: 'webp-candidate-host-test-authorization-v1', candidateHash, qualified: false, loaderSeam: 'reviewed-candidate-only',
    namespace: 'webp-candidate-host-v1', platform: candidate.platform, arch: candidate.arch, artifact,
    abiVersion: candidate.abiVersion, decoderVersion: candidate.decoderVersion, residentCodeBytes: candidate.residentCodeBytes, loader: 'held-descriptor-v1',
    source: {path: join(dirname(artifactPath), 'libwebp-1.6.0.tar.gz'), repositoryPath: candidate.source.archive, bytes: candidate.source.bytes, hash: sourceHash}, sourceHash, producerHash: candidate.producerHash,
    producerDirectory: candidate.producerDirectory, sourceFreezeHash: candidate.sourceFreezeHash, recipeManifestHash: candidate.recipeManifestHash,
    haloAuthorization: halo, hostClosureIdentityHash: hostClosure.identityHash, originalCompiledHash: hostClosure.compiledHash,
    originalSourceHash: hostClosure.sourceHash, runtimeDependenciesHash: hostClosure.runtimeDependencies.identityHash, transformPolicyHash: policyHash};
  const candidateAuthorization = {...authorization, authorizationHash: hash(canonical(authorization))};
  const adapterSeal = {status: 'built-unqualified', qualified: false, kind: 'webp-advanced-file-v1', abiVersion: 1, decoderVersion: 0x010600,
    platform: candidate.platform, arch: candidate.arch, artifact: {...artifact}, sourceHash, producerHash: candidate.producerHash,
    candidateHash, authorizationHash: candidateAuthorization.authorizationHash, residentCodeBytes: candidate.residentCodeBytes,
    loader: 'held-descriptor-v1', halo: {...halo.rule, proofHash: halo.proof.hash}};
  const definition = {kind: 'webp-candidate-import-profile-v1', namespace: 'webp-candidate-host-v1', status: 'built-unqualified', qualified: false,
    candidateHash, candidateAuthorizationHash: candidateAuthorization.authorizationHash, baseCodec, platform: candidate.platform, arch: candidate.arch,
    producer: {transport: 'webp-advanced-file-v1', mediaType: 'image/webp', sourceHash, artifactHash: artifact.hash, abiVersion: 1},
    kernel: 'triangle-area-source-axis-row-norm-v1', color: 'fixed-srgb-p3-orientation-v1'};
  const codec = hash(canonical(definition)), profile = {...definition, codec, pipeline: pipelineBase + '/' + codec};
  return deepFreeze({adapterSeal, candidateAuthorization, profile});
}

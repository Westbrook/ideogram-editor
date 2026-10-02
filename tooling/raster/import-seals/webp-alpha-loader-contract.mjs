// Relocated alpha loader verification. Every retained byte is obtained through
// the managed proof map or a fixed reviewed driver input. Original paths are
// provenance labels only: this module never opens them or imports captured code.
import assert from 'node:assert/strict';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {ALPHA_SELECTED} from './webp-alpha-authority.mjs';
import {HASH, hash, canonical, buildCandidateBindings, repositoryPath} from './webp-alpha-loader-policy.mjs';
import {assertAlphaCompiledReview, transformAlphaCompiled} from './webp-alpha-loader-transforms.mjs';
import {renderCandidatePreload} from './webp-alpha-loader-preload.mjs';
import {validateAlphaRuntimeManifest} from './webp-alpha-loader-runtime-manifest.mjs';
import {assertReleasedAlphaBaseline} from './webp-alpha-baseline-template.mjs';
import {ALPHA_BASELINE_TEMPLATE, ALPHA_TEMPLATE_COMMON_OBSERVED_PATHS} from './webp-alpha-template-authority.mjs';

const HELPERS = Object.freeze(['baseline.json', 'candidate-policy.mjs', 'contract.mjs', 'transforms.mjs', 'runtime.mjs', 'dependencies.mjs']);
const SCOPE = 'transformed candidate-only compiled closure; ordinary issued-path integration remains required after issuance';
const NATIVE_OBSERVATION = 'Actual returned calls are recorded in the adapter isolate before unchanged validation, with residual-mapping quarantine preserved on observation failure. Direct adapter errors are drainable there; only successful writer metrics cross the existing worker protocol. No unobserved status or failed-writer metrics are supplied.';
const identity = row => ({bytes: row.bytes, hash: row.hash});
const MAX_FILES = 8192;
function exactKeys(value, names, label) {
  assert(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), label + ' must be a record');
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...names].sort(), label + ' fields differ');
}
function absolute(path) {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0') && !path.includes('\\'));
  assert(isAbsolute(path) && resolve(path) === path, 'Normalized absolute original path required');
  return path;
}
function within(root, path) {
  absolute(root); absolute(path);
  const name = relative(root, path);
  assert(name && !isAbsolute(name) && name.split(sep).every(part => part && part !== '.' && part !== '..'), 'Original evidence path escaped its root');
  return path;
}
function fileIdentity(row) {
  assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 2 ** 31, 'Bounded retained file required');
  assert.match(row.hash, HASH); return identity(row);
}
function heldIdentity(held, expected) {
  assert(held && Buffer.isBuffer(held.data), 'Held captured bytes are required');
  assert.deepEqual(identity(held), fileIdentity(expected));
  assert.equal(held.data.length, expected.bytes); assert.equal(hash(held.data), expected.hash);
  return held;
}
function text(held) {
  const value = held.data.toString('utf8');
  assert(Buffer.from(value, 'utf8').equals(held.data), 'Captured source must be lossless UTF-8'); return value;
}
function records(rows, label) {
  assert(Array.isArray(rows) && rows.length > 0 && rows.length <= MAX_FILES, label + ' inventory bound exceeded');
  const found = new Map();
  for (const row of rows) {
    exactKeys(row, ['repositoryPath', 'bytes', 'hash'], label);
    repositoryPath('/original-host', row.repositoryPath); fileIdentity(row);
    assert(!found.has(row.repositoryPath), 'Duplicate ' + label + ' path'); found.set(row.repositoryPath, row);
  }
  return found;
}

/**
 * Main verifies the fixed issuer/driver source authorities before calling this
 * function. readDriver(name) returns held bytes from the exact packaged
 * issuer-inputs/host-campaigns-v3/loader/name member, never an imported module.
 * proof resolves schema-2 edges and preserves their original parent path/hash.
 */
export function validateAlphaLoader({loader, candidate, candidateHash, hostClosure, campaign, campaignHash,
  campaignPath, haloAuthorization, buildProofRef, proof, driverFiles, readDriver}) {
  assert.equal(candidateHash, ALPHA_SELECTED.candidate.hash, 'Loader must bind the selected alpha candidate');
  assert.match(campaignHash, HASH); absolute(campaignPath);
  assert(proof && typeof proof.get === 'function' && typeof proof.readJSON === 'function', 'Managed relocated proof reader required');
  assert.equal(typeof readDriver, 'function');
  assert.deepEqual(loader, campaign.loader, 'Loader must be the exact inline campaign loader');
  assert.equal(campaign.candidateHash, candidateHash); assert.equal(campaign.artifactHash, candidate.artifact.hash);
  const repo = absolute(campaign.repo), evidenceRoot = absolute(campaign.evidenceRoot);
  within(evidenceRoot, campaignPath); assert.equal(haloAuthorization.evidenceRoot, evidenceRoot);
  const candidatePath = within(evidenceRoot, campaign.candidatePath), producerPacket = within(evidenceRoot, campaign.producerPacket);
  const artifactPath = within(evidenceRoot, join(dirname(candidatePath), candidate.artifact.path));
  assert.equal(candidatePath, join(dirname(artifactPath), 'build-candidate.json'));
  const sourceHash = candidate.source.hash;

  const drivers = records(driverFiles, 'Reviewed driver');
  const readReviewedDriver = name => {
    assert(HELPERS.includes(name) || name === 'index.mjs', 'Unknown loader driver input');
    const pin = drivers.get('host-campaigns-v3/loader/' + name); assert(pin, 'Loader input is absent from the fixed reviewed driver');
    return heldIdentity(readDriver(name), pin);
  };
  const driverInputs = new Map(HELPERS.map(name => [name, readReviewedDriver(name)]));
  const preparerBytes = readReviewedDriver('index.mjs');
  // The retained driver baseline is data under the fixed source manifest. It
  // cannot be replaced by evidence.compiledReview or a caller-provided baseline.
  const baseline = JSON.parse(text(driverInputs.get('baseline.json')));
  assertReleasedAlphaBaseline(baseline, {expectedTemplate: ALPHA_BASELINE_TEMPLATE, observedCommonSourcePaths: ALPHA_TEMPLATE_COMMON_OBSERVED_PATHS});
  const compiledReview = assertAlphaCompiledReview(baseline);
  const helperRecords = HELPERS.map(repositoryPath => ({repositoryPath, ...identity(driverInputs.get(repositoryPath))}));
  const preparer = identity(preparerBytes);
  const policyHash = hash(canonical({kind: 'webp-candidate-transform-policy-v1', helpers: helperRecords, preparer}));

  const readCampaign = reference => {
    within(evidenceRoot, resolve(dirname(campaignPath), reference.path));
    return heldIdentity(proof.get(campaignHash, reference, {parentPath: campaignPath}), reference);
  };
  const closureRead = proof.readJSON(campaignHash, campaign.hostClosure, {parentPath: campaignPath});
  heldIdentity(closureRead, campaign.hostClosure); within(evidenceRoot, closureRead.path);
  const closure = closureRead.value;
  assert.deepEqual(hostClosure, Object.hasOwn(hostClosure, 'manifestPath') ? {...closure, manifestPath: closureRead.path} : closure,
    'Host closure must come from the exact campaign proof edge');
  exactKeys(closure, ['schemaVersion', 'kind', 'repo', 'sourceFiles', 'compiledFiles', 'dependencyFiles',
    'runtimeDependenciesIdentityHash', 'runtimeDependencies', 'sourceHash', 'compiledHash', 'identityHash', 'retainedRoot', 'retainedFiles'], 'Host closure');
  assert.equal(closure.schemaVersion, 1); assert.equal(closure.kind, 'webp-host-closure-v1'); assert.equal(closure.repo, repo);
  assert.equal(closure.retainedRoot, join(dirname(closureRead.path), 'files'));
  const sources = records(closure.sourceFiles, 'Host source'), compiled = records(closure.compiledFiles, 'Host compiled');
  const dependencies = records(closure.dependencyFiles, 'Host dependency');
  for (const name of compiled.keys()) assert(name.startsWith('dist/local/'), 'Compiled module escaped dist/local');
  const retained = new Map();
  for (const rows of [sources, compiled, dependencies]) for (const [name, row] of rows) {
    if (retained.has(name)) assert.deepEqual(retained.get(name), row, 'Conflicting closure input identity');
    else retained.set(name, row);
  }
  assert(retained.size <= MAX_FILES, 'Retained host closure bound exceeded');
  const expectedRetained = [...retained.values()].map((row, index) => ({repositoryPath: row.repositoryPath,
    path: row.repositoryPath.endsWith('.json') ? join(dirname(closureRead.path), 'raw-json', String(index).padStart(5, '0') + '.data') :
      join(closure.retainedRoot, row.repositoryPath), ...identity(row)}));
  assert.deepEqual(closure.retainedFiles, expectedRetained, 'Retained files must cover exactly the full source, compiled and dependency union');
  const retainedByName = new Map(expectedRetained.map(row => [row.repositoryPath, row]));
  const readHost = name => {
    const reference = retainedByName.get(name); assert(reference, 'Missing retained host input: ' + name);
    within(evidenceRoot, reference.path);
    return heldIdentity(proof.get(closureRead.hash, reference, {parentPath: closureRead.path}), reference);
  };
  // Verify all original retained bytes, including untransformed modules and
  // dependencies. Only the small inputs needed for derivation stay in memory.
  for (const name of retainedByName.keys()) readHost(name);
  validateAlphaRuntimeManifest(closure.runtimeDependencies, {repo, platform: candidate.platform});
  assert.equal(closure.runtimeDependenciesIdentityHash, closure.runtimeDependencies.identityHash);
  assert.equal(closure.sourceHash, hash(canonical(closure.sourceFiles)));
  assert.equal(closure.compiledHash, hash(canonical(closure.compiledFiles)));
  assert.equal(closure.identityHash, hash(canonical({sourceFiles: closure.sourceFiles, compiledFiles: closure.compiledFiles,
    dependencyFiles: closure.dependencyFiles, runtimeDependenciesIdentityHash: closure.runtimeDependencies.identityHash})));
  assert.equal(compiledReview.sourceHash, closure.sourceHash); assert.equal(compiledReview.compiledHash, closure.compiledHash);
  assert.equal(compiledReview.runtimeDependenciesHash, closure.runtimeDependencies.identityHash);
  assert.deepEqual(buildProofRef, compiledReview.buildProof, 'Compiler proof differs from the exact reviewed capture');
  assert.deepEqual(campaign.hostBuildProof, buildProofRef);
  readCampaign(buildProofRef);
  for (const reference of compiledReview.retainedModules) readCampaign(reference);
  for (const pin of baseline.commonSourceTargets) assert.deepEqual(sources.get(pin.repositoryPath), pin, 'Shared source authority differs');
  for (const row of baseline.modules) {
    assert.deepEqual(sources.get(row.source.repositoryPath), row.source, 'Reviewed original source differs');
    assert.deepEqual(compiled.get(row.compiled.repositoryPath), row.compiled, 'Reviewed compiler output differs');
  }

  const evidence = loader.closureEvidence;
  const authorizationPath = within(evidenceRoot, evidence.authorization.path), directory = dirname(authorizationPath);
  assert.equal(authorizationPath, join(directory, 'authorization.json'));
  // The reviewed campaign creates a candidate-loader output directory and the
  // preparer creates its own candidate-loader child inside that output.
  assert.equal(directory, join(dirname(campaignPath), 'candidate-loader', 'candidate-loader'));
  const helperRoot = join(directory, 'helpers'), retainedPreparer = {path: join(directory, 'preparer.mjs'), ...preparer};
  assert.deepEqual(evidence.helpers, helperRecords); assert.deepEqual(evidence.preparer, preparer);
  assert.deepEqual(evidence.retainedPreparer, retainedPreparer); assert.equal(evidence.policyHash, policyHash);
  const retainedHelpers = helperRecords.map(row => ({path: join(helperRoot, row.repositoryPath), ...identity(row)}));
  assert.deepEqual(evidence.retainedHelpers, retainedHelpers);
  for (let i = 0; i < retainedHelpers.length; i++) {
    const held = readCampaign(retainedHelpers[i]);
    assert(held.data.equals(driverInputs.get(HELPERS[i]).data), 'Retained helper differs from the reviewed driver source');
    if (HELPERS[i] === 'baseline.json') {
      // This JSON contains its own compiler-proof references. Preserve those
      // exact edges too; the same bytes at another path are not a substitute.
      for (const reference of [compiledReview.buildProof, ...compiledReview.retainedModules])
        heldIdentity(proof.get(held.hash, reference, {parentPath: held.path}), reference);
    }
  }
  assert(readCampaign(retainedPreparer).data.equals(preparerBytes.data));
  const codecAuthority = candidate.baseCodecAuthority;
  assert.deepEqual(codecAuthority.inputs.map(row => row.path), ['server/raster/codec-platform.ts', 'server/raster/identity.ts']);
  for (const input of codecAuthority.inputs) {
    exactKeys(input, ['path', 'bytes', 'hash'], 'Candidate codec input');
    assert.deepEqual(sources.get(input.path), {repositoryPath: input.path, ...fileIdentity(input)},
      'Host codec authority differs from the candidate authority input');
  }
  const codecSource = text(readHost('server/raster/identity.ts'));
  const codecLiteral = codecSource.match(/export const CODECS = (\{[\s\S]*\}) as const;/);
  const codecId = codecSource.match(/export const CODEC_ID = ['"](sha256:[a-f0-9]{64})['"]/);
  assert(codecLiteral && codecId, 'Captured codec source has no recognized data-only definition');
  const codecs = JSON.parse(codecLiteral[1]);
  assert.equal(hash(JSON.stringify(codecs)), codecId[1]); assert.equal(codecId[1], codecAuthority.codecId);
  assert.equal(codecs.platform, candidate.platform); assert.equal(codecs.arch, candidate.arch);
  const core = text(readHost('src/raster/core.ts'));
  const pipelineBase = core.match(/export const PIXEL_PIPELINE = '([^']+)'/)?.[1];
  const bindings = buildCandidateBindings({candidate, candidateHash, artifactPath,
    hostClosure: {...closure, manifestPath: closureRead.path}, policyHash,
    baseCodec: candidate.baseCodecAuthority.codecId, pipelineBase, haloAuthorization, sourceHash});
  const modulePaths = baseline.modules.filter(row => row.role === 'transform').map(row => row.compiled.repositoryPath);
  const expectedTransforms = modulePaths.map((repositoryPath, index) => {
    const result = transformAlphaCompiled(baseline, repositoryPath, text(readHost(repositoryPath)), bindings);
    const retainedPath = join(directory, 'transformed', String(index).padStart(2, '0') + '.mjs');
    assert(readCampaign({path: retainedPath, ...result.transformed}).data.equals(Buffer.from(result.source, 'utf8')),
      'Retained transform differs from trusted finite source derivation');
    const {source, ...record} = result; return {...record, retainedPath};
  });
  const originalCompiledFiles = [...closure.compiledFiles].sort((a, b) => a.repositoryPath.localeCompare(b.repositoryPath));
  const transformedCompiledFiles = originalCompiledFiles.map(row => {
    const transformed = expectedTransforms.find(value => value.repositoryPath === row.repositoryPath);
    return transformed ? {repositoryPath: row.repositoryPath, ...transformed.transformed} : row;
  });
  const transformedIdentity = hash(canonical({kind: 'webp-candidate-transformed-closure-v1', originalHostClosure: closure.identityHash,
    candidateAuthorizationHash: bindings.candidateAuthorization.authorizationHash, compiledFiles: transformedCompiledFiles, transformPolicyHash: policyHash}));
  const descriptor = proof.readJSON(campaignHash, evidence.authorization, {parentPath: campaignPath});
  heldIdentity(descriptor, evidence.authorization); assert.equal(descriptor.path, authorizationPath);
  assert.deepEqual(descriptor.value, {kind: 'webp-candidate-loader-authorization-v1', qualified: false, repo, helperRoot,
    helpers: helperRecords, bindings, originalCompiledFiles, transformedCompiledFiles, transforms: expectedTransforms,
    transformedIdentity, originalHostClosure: closure.identityHash, runtimeDependencies: closure.runtimeDependencies,
    policyHash, preparer: retainedPreparer, compiledReview, haloAuthorization});
  for (const reference of [retainedPreparer, compiledReview.buildProof, ...compiledReview.retainedModules,
    haloAuthorization.proof, haloAuthorization.sourceAudit, haloAuthorization.nativeProbe,
    bindings.candidateAuthorization.artifact, bindings.candidateAuthorization.source])
    heldIdentity(proof.get(descriptor.hash, reference, {parentPath: descriptor.path}), reference);

  const preload = renderCandidatePreload({helperRecords, helperRoot, authorizationPath, authorizationHash: descriptor.hash});
  const preloadBytes = Buffer.from(preload, 'utf8'), preloadURL = 'data:text/javascript;base64,' + preloadBytes.toString('base64');
  const preloadPath = join(directory, 'preload.mjs'), preloadIdentity = {bytes: preloadBytes.length, hash: hash(preloadBytes)};
  assert(readCampaign({path: preloadPath, ...preloadIdentity}).data.equals(preloadBytes), 'Preload differs from exact trusted renderer');
  const closureEvidence = {kind: 'webp-candidate-loader-closure-evidence-v1', qualified: false, scope: SCOPE,
    original: {hostClosureIdentityHash: closure.identityHash, sourceHash: closure.sourceHash, compiledHash: closure.compiledHash,
      runtimeDependenciesHash: closure.runtimeDependencies.identityHash, manifestPath: closureRead.path, retainedRoot: closure.retainedRoot},
    transformed: {identityHash: transformedIdentity, compiledFiles: transformedCompiledFiles}, transforms: expectedTransforms, policyHash,
    authorization: {path: authorizationPath, ...identity(descriptor)},
    preload: {path: preloadPath, ...preloadIdentity, execution: 'embedded-data-url', argumentHash: hash(preloadURL)},
    retainedHelpers, retainedTransformed: expectedTransforms.map(row => ({path: row.retainedPath, ...row.transformed})), retainedPreparer,
    compiledReview, commonOverlay: baseline.commonOverlay, haloAuthorization, helpers: helperRecords, preparer, nativeObservation: NATIVE_OBSERVATION};
  const expectedLoader = {...bindings, candidatePath, producerPacket, haloProofPath: haloAuthorization.proof.path,
    haloNativePath: haloAuthorization.nativeProbe.path, evidenceRoot, sourceHash, haloAuthorization,
    writerClosure: {root: repo, identityHash: transformedIdentity, preloadPath, authorizationPath,
      nativeObservationsPath: join(directory, 'native-observations')}, candidateLoaderExecArgv: ['--import', preloadURL], closureEvidence};
  assert.deepEqual(loader, expectedLoader, 'Inline loader differs from the complete trusted derivation');
  return {policyHash, authorizationHash: bindings.candidateAuthorization.authorizationHash, transformedIdentity,
    preloadHash: preloadIdentity.hash, originalSourceHash: closure.sourceHash, originalCompiledHash: closure.compiledHash};
}

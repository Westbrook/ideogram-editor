// Pure data-contract tests only. These do not create a reviewed compiler
// capture, execute a loader/preload, or establish native qualification.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {ALPHA_SELECTED, ALPHA_SOURCE} from '../../tooling/raster/import-seals/webp-alpha-authority.mjs';
import {validateAlphaLoader} from '../../tooling/raster/import-seals/webp-alpha-loader-contract.mjs';
import {assertAlphaCompiledReview, transformAlphaCompiled} from '../../tooling/raster/import-seals/webp-alpha-loader-transforms.mjs';
import {validateAlphaRuntimeManifest} from '../../tooling/raster/import-seals/webp-alpha-loader-runtime-manifest.mjs';
import {renderCandidatePreload} from '../../tooling/raster/import-seals/webp-alpha-loader-preload.mjs';
import {canonical} from '../../tooling/raster/import-seals/webp-alpha-loader-policy.mjs';
import {ALPHA_BASELINE_TEMPLATE, ALPHA_TEMPLATE_COMMON_OBSERVED_PATHS} from '../../tooling/raster/import-seals/webp-alpha-template-authority.mjs';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const held = data => ({data, bytes: data.length, hash: hash(data)});
const pendingBaseline = () => ({kind: 'webp-candidate-loader-reviewed-inputs-v1', status: 'pending-genuine-compiled-review',
  commonOverlay: {}, commonSourceTargets: [], compiledCapture: null, modules: [], canonicalCorrection: {},
  requiredSharedTargets: 0, sourceAuthorityHash: null});
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const manifest = definition => ({...definition, identityHash: hash(JSON.stringify(sorted(definition)))});
const runtime = () => manifest({method: 'held-nofollow-path-snapshot-v1',
  files: [{repositoryPath: 'node_modules/pkg/empty', bytes: 0, hash: hash('')},
    {repositoryPath: 'node_modules/pkg/run.mjs', bytes: 2, hash: hash('42')}],
  links: [{repositoryPath: 'node_modules/.bin/run', target: '../pkg/run.mjs', resolvedRepositoryPath: 'node_modules/pkg/run.mjs'}],
  directories: [{repositoryPath: 'node_modules'}, {repositoryPath: 'node_modules/.bin'},
    {repositoryPath: 'node_modules/pkg'}, {repositoryPath: 'node_modules/pkg/empty-directory'}]});
const options = {repo: '/original/host', platform: 'darwin'};

test('unreviewed compiler metadata never authorizes source transformation', () => {
  const baseline = pendingBaseline();
  assert.throws(() => assertAlphaCompiledReview(baseline), /pending genuine compiled capture/);
  assert.throws(() => transformAlphaCompiled(baseline, 'dist/local/server/raster/import-profile.js', 'throw new Error("must not run");', {}),
    /pending genuine compiled capture/);
  baseline.status = 'compiled-reviewed-unexecuted';
  assert.throws(() => assertAlphaCompiledReview(baseline), /Reviewed fresh compiler evidence/);
});

test('pending reviewed-driver baseline refuses before any proof read or captured code execution', () => {
  const baseline = structuredClone(ALPHA_BASELINE_TEMPLATE);
  for (const row of baseline.commonSourceTargets) if (ALPHA_TEMPLATE_COMMON_OBSERVED_PATHS.includes(row.repositoryPath)) {
    row.bytes = 1; row.hash = hash('synthetic observed source only');
  }
  baseline.sourceAuthorityHash = hash(canonical({commonOverlay: baseline.commonOverlay, canonicalCorrection: baseline.canonicalCorrection, commonSourceTargets: baseline.commonSourceTargets}));
  const names = ['baseline.json', 'candidate-policy.mjs', 'contract.mjs', 'transforms.mjs', 'runtime.mjs', 'dependencies.mjs', 'index.mjs'];
  const inputs = new Map(names.map(name => [name, held(Buffer.from(name === 'baseline.json' ? JSON.stringify(baseline) :
    'throw new Error("captured source must remain data");\n'))]));
  const driverFiles = names.map(name => ({repositoryPath: 'host-campaigns-v3/loader/' + name,
    bytes: inputs.get(name).bytes, hash: inputs.get(name).hash}));
  let proofReads = 0;
  const proof = {get() { proofReads++; throw Error('Unexpected proof read'); }, readJSON() { proofReads++; throw Error('Unexpected proof read'); }};
  const candidate = {artifact: ALPHA_SELECTED.artifact, source: ALPHA_SOURCE};
  const loader = {}, campaignPath = '/original/evidence/campaign/qualification-inputs.json';
  const campaign = {loader, candidateHash: ALPHA_SELECTED.candidate.hash, artifactHash: candidate.artifact.hash,
    repo: '/original/host', evidenceRoot: '/original/evidence', candidatePath: '/original/evidence/packet/produced/alpha/build-candidate.json',
    producerPacket: '/original/evidence/packet'};
  assert.throws(() => validateAlphaLoader({loader, candidate, candidateHash: ALPHA_SELECTED.candidate.hash, hostClosure: {},
    campaign, campaignHash: hash(JSON.stringify(campaign)), campaignPath, haloAuthorization: {evidenceRoot: campaign.evidenceRoot},
    buildProofRef: {}, proof, driverFiles, readDriver: name => inputs.get(name)}), /Genuine compiled review remains pending/);
  assert.equal(proofReads, 0);
  inputs.set('index.mjs', held(Buffer.from('different captured bytes')));
  assert.throws(() => validateAlphaLoader({loader, candidate, candidateHash: ALPHA_SELECTED.candidate.hash, hostClosure: {},
    campaign, campaignHash: hash(JSON.stringify(campaign)), campaignPath, haloAuthorization: {evidenceRoot: campaign.evidenceRoot},
    buildProofRef: {}, proof, driverFiles, readDriver: name => inputs.get(name)}));
  assert.equal(proofReads, 0);
});

test('runtime metadata validates confined recorded membership without remeasuring an install', () => {
  const value = runtime(), result = validateAlphaRuntimeManifest(value, options);
  assert.deepEqual(result, {method: value.method, identityHash: value.identityHash, files: 2, links: 1, directories: 4});
  const absolute = structuredClone(value);
  absolute.links[0].target = '/original/host/node_modules/pkg/run.mjs';
  const {identityHash, ...definition} = absolute;
  assert.equal(validateAlphaRuntimeManifest(manifest(definition), options).links, 1);
});

test('runtime metadata rejects rehashed membership, escape, method and link lies', () => {
  const changes = [
    value => { value.files.reverse(); },
    value => { value.directories = value.directories.filter(row => row.repositoryPath !== 'node_modules/pkg'); },
    value => { value.links[0].resolvedRepositoryPath = 'node_modules/pkg/empty'; },
    value => { value.links[0].target = '../../outside'; },
    value => { value.links[0].target = '/another/host/node_modules/pkg/run.mjs'; },
    value => { value.links[0].target = 'run'; value.links[0].resolvedRepositoryPath = 'node_modules/.bin/run'; },
    value => { value.files[0].bytes = -1; },
    value => { value.method = 'directory-fd-anchored-v1'; },
    value => { value.links[0].unexpected = true; },
    value => { value.directories.push({repositoryPath: 'node_modules/pkg/run.mjs'}); },
  ];
  for (const change of changes) {
    const {identityHash, ...definition} = runtime(); change(definition);
    assert.throws(() => validateAlphaRuntimeManifest(manifest(definition), options));
  }
  const drift = runtime(); drift.files[0].hash = hash('different');
  assert.throws(() => validateAlphaRuntimeManifest(drift, options), /identity differs/);
});

test('dependency identity preserves its dedicated JSON dialect', () => {
  const value = runtime(), {identityHash, ...definition} = value;
  definition.directories.push({repositoryPath: 'node_modules/z\tname'});
  const recorded = manifest(definition);
  assert.notEqual(recorded.identityHash, hash(canonical(definition)), 'Control escapes distinguish this from protocol canonical JSON');
  assert.equal(validateAlphaRuntimeManifest(recorded, options).directories, 5);
});

test('preload rendering keeps original-path and descriptor identity in exact data bytes', () => {
  const helpers = [{repositoryPath: 'runtime.mjs', bytes: 1, hash: hash('x')}];
  const input = {helperRecords: helpers, helperRoot: '/original/evidence/candidate-loader/helpers',
    authorizationPath: '/original/evidence/candidate-loader/authorization.json', authorizationHash: hash('{}')};
  const first = renderCandidatePreload(input), second = renderCandidatePreload({...input, authorizationHash: hash('{"changed":true}')});
  assert.equal(typeof first, 'string'); assert.notEqual(first, second);
  assert(first.includes('capturedHelpers')); assert(first.includes('file:///original/evidence/candidate-loader/helpers/runtime.mjs'));
  assert(first.includes(JSON.stringify(input.authorizationHash)));
  const url = 'data:text/javascript;base64,' + Buffer.from(first).toString('base64');
  assert.equal(Buffer.from(url.slice('data:text/javascript;base64,'.length), 'base64').toString('utf8'), first);
});

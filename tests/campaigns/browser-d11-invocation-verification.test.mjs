import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'rolldown/utils';
import { D11_COMPILATION_INPUT_PATHS, D11_INVOCATION_DEPENDENCY_PATHS } from '../../tooling/qualification/campaigns/browser-d11-invocation-contract.mjs';
import { verifyD11RetainedBuild } from '../../tooling/qualification/campaigns/browser-d11-verification.mjs';
import { deriveD11Roles } from '../../tooling/qualification/campaigns/browser-d11-roles.mjs';
import { d11Hash as hash, d11Specimen as specimen, refreshD11Specimen as refresh, initializeD11Specimen } from './support/d11-specimen.mjs';

before(initializeD11Specimen);

const verify = state => verifyD11RetainedBuild(state.payload.build, state.options);

function retainEvidence(state, evidence, { updateReceipt = true } = {}) {
  const build = state.payload.build, text = JSON.stringify(evidence);
  build.retainedInputs.buildEvidence = text;
  build.inputs.buildEvidence = { ...build.inputs.buildEvidence, rawBytes: Buffer.byteLength(text), sha256: hash(text) };
  if (updateReceipt) {
    const row = state.options.buildFiles.find(input => input.path === build.inputs.buildEvidence.path);
    row.bytes = Buffer.byteLength(text); row.sha256 = hash(text);
  }
  refresh(state);
}

// These arbitrary captured identities exercise only the unavailable-contract
// branch. They are not reviewed dependency members or a qualifying contract.
function captured({ updateReceipt = true } = {}) {
  const state = specimen(), build = state.payload.build;
  const evidence = JSON.parse(build.retainedInputs.buildEvidence);
  evidence.dependencyInputs = D11_INVOCATION_DEPENDENCY_PATHS.map(path => {
    const text = 'unavailable invocation contract: ' + path;
    return { path, bytes: Buffer.byteLength(text), sha256: hash(text).slice(7) };
  });
  build.dependencyInputs = evidence.dependencyInputs.map(row => ({ path: row.path, rawBytes: row.bytes, sha256: 'sha256:' + row.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  build.roleInputs.invocationContract = null;
  // This specimen intentionally uses identical source and emitted index bytes;
  // new captures retain the original source index alongside the script corpus.
  build.roleInputs.sourceTextByPath['index.html'] = build.retainedInputs.index;
  evidence.compilation = { schema: 1, profile: 'reviewed-vite-app-1', configFile: 'vite.app.config.ts', configLoader: 'bundle',
    command: 'build', mode: 'production', env: { BASE_URL: '/', MODE: 'production', DEV: false, PROD: true },
    configInputs: D11_COMPILATION_INPUT_PATHS.map(path => {
      const text = build.roleInputs.sourceTextByPath[path];
      return { path, bytes: Buffer.byteLength(text), sha256: hash(text).slice(7) };
    }), inlineTransformOptions: 'none', userPlugins: ['consumer-build-evidence'] };
  build.compilation = structuredClone(evidence.compilation);
  build.roles = deriveD11Roles({ manifest: JSON.parse(build.retainedInputs.manifest), files: build.files,
    ...build.roleInputs, roleContext: build.roleContext, dependencyInputs: build.dependencyInputs,
    compilation: build.compilation, sourceInputs: build.sourceInputs, lock: JSON.parse(build.retainedInputs.lock), parser: { ...build.roleInputs.parser, parseSync } });
  retainEvidence(state, evidence, { updateReceipt });
  return state;
}

test('legacy retained evidence has exactly its previous role-input shape', () => {
  const state = specimen();
  assert.equal(Object.hasOwn(state.payload.build, 'dependencyInputs'), false);
  assert.equal(Object.hasOwn(state.payload.build.roleInputs, 'invocationContract'), false);
  assert.equal(verify(state), state.payload.build);
  state.payload.build.roleInputs.invocationContract = null; refresh(state);
  assert.throws(() => verify(state), /role input fields differ/);
});

test('new retained capture can record an unavailable contract without changing any roles', () => {
  const state = captured(), legacyRoles = specimen().payload.build.roles;
  const { excludedImports, excludedWorkers, startupUpperBounds, startupProof, ...roles } = state.payload.build.roles;
  const ordinary = { ...roles, lazyFeatures: roles.lazyFeatures.map(({ closureFiles, ...feature }) => feature) };
  assert.deepEqual(ordinary, legacyRoles);
  assert.deepEqual(excludedImports, []);
  assert.deepEqual(excludedWorkers, []);
  assert.equal(state.payload.build.roleInputs.invocationContract, null);
  assert.equal(verify(state), state.payload.build);
});

test('new dependency capture remains bound to independently retained finalized evidence', () => {
  const state = captured({ updateReceipt: false });
  assert.throws(() => verify(state), /differs from retained receipt/);
});

test('a legacy inventory cannot gain dependency provenance through its own new seal', () => {
  const state = specimen();
  state.payload.build.dependencyInputs = captured().payload.build.dependencyInputs;
  refresh(state);
  assert.throws(() => verify(state), /legacy build cannot acquire dependency provenance/);
});

test('new capture requires the exact invocation key, including explicit absence', () => {
  for (const change of [
    build => { delete build.roleInputs.invocationContract; },
    build => { build.roleInputs.additionalInvocationEvidence = {}; },
  ]) {
    const state = captured(); change(state.payload.build); refresh(state);
    assert.throws(() => verify(state), /role input fields differ/);
  }
  for (const value of [{}, false, 'reviewed']) {
    const state = captured(); state.payload.build.roleInputs.invocationContract = value; refresh(state);
    assert.throws(() => verify(state), /invocation contract/i);
  }
  const state = captured(); state.payload.build.roleInputs.invocationContract = undefined; refresh(state);
  assert.throws(() => verify(state), /only JSON values/);
});

test('retained dependency metadata rejects omitted, extra, repeated and noncanonical paths', () => {
  const changes = [
    rows => rows.pop(),
    rows => rows.push({ ...rows[0], path: 'node_modules/unreviewed/index.js' }),
    rows => { rows[1] = { ...rows[0] }; },
    rows => { rows[0].path = '../' + rows[0].path; },
    rows => { rows[0].path = '/' + rows[0].path; },
    rows => { rows[0].path += '?changed'; },
    rows => { rows[0].path = rows[0].path.replace('node_modules/', 'node_modules/other/node_modules/'); },
  ];
  for (const change of changes) {
    const state = captured(), evidence = JSON.parse(state.payload.build.retainedInputs.buildEvidence);
    change(evidence.dependencyInputs); retainEvidence(state, evidence);
    assert.throws(() => verify(state), Error);
  }
});

test('retained dependency metadata requires bounded integer bytes, bare hashes and exact fields', () => {
  const changes = [
    row => { row.bytes = -1; }, row => { row.bytes = 1.5; }, row => { row.bytes = 65537; },
    row => { row.bytes = '123'; }, row => { delete row.bytes; },
    row => { row.sha256 = 'sha256:' + row.sha256; }, row => { row.sha256 = 'f'.repeat(63); },
    row => { row.sha256 = 123; }, row => { row.installed = true; },
  ];
  for (const change of changes) {
    const state = captured(), evidence = JSON.parse(state.payload.build.retainedInputs.buildEvidence);
    change(evidence.dependencyInputs[0]); retainEvidence(state, evidence);
    assert.throws(() => verify(state), /dependency input/);
  }
});

test('top-level dependency identities must exactly replay the finalized recorded identities', () => {
  for (const change of [
    rows => { rows[0].rawBytes++; }, rows => { rows[0].sha256 = hash('altered'); },
    rows => { rows[0].path = rows[1].path; }, rows => { rows[0].extra = true; },
    rows => rows.reverse(), rows => rows.pop(),
  ]) {
    const state = captured(); change(state.payload.build.dependencyInputs); refresh(state);
    assert.throws(() => verify(state), /dependency inputs differ/);
  }
});

test('unavailable contract does not authorize changing the recorded startup role map', () => {
  const state = captured();
  state.payload.build.roles.startupFiles.push('assets/feature.js'); refresh(state);
  assert.throws(() => verify(state), /roles differ/);
});

test('new capture reproduces actual compilation metadata from finalized evidence and sealed sources', () => {
  for (const change of [
    evidence => { delete evidence.compilation; },
    evidence => { evidence.compilation.configFile = 'other.config.ts'; },
    evidence => { evidence.compilation.configInputs[0].bytes++; },
    evidence => { evidence.compilation.configInputs.reverse(); },
    evidence => { evidence.compilation.env.VITE_UNSEALED = 'present'; },
  ]) {
    const state = captured(), evidence = JSON.parse(state.payload.build.retainedInputs.buildEvidence);
    change(evidence);
    if (evidence.compilation === undefined) delete state.payload.build.compilation;
    else state.payload.build.compilation = structuredClone(evidence.compilation);
    retainEvidence(state, evidence);
    assert.throws(() => verify(state), /compilation capture/);
  }
  const state = captured(); state.payload.build.compilation.mode = 'development'; refresh(state);
  assert.throws(() => verify(state), /compilation capture differs from finalized/);
});

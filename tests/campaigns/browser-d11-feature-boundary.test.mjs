import test from 'node:test';
import assert from 'node:assert/strict';
import { selectD11FeatureBoundaryForAction, deriveD11FeatureBoundary, analyzeD11FeatureAbsence, analyzeD11FeatureFirstUse } from '../../tooling/qualification/campaigns/browser-d11-feature-boundary.mjs';

// Deliberately tiny invented metadata exercises only pure reduction. These are
// not captured builds, public-action observations or qualification receipts.
const hash = value => 'sha256:' + String(value).padStart(64, '0');
const featureId = 'src/tools/save-file.ts';
const exportAction = { commandId: 'export-image', commandLabel: 'Export image', event: 'click', element: 'en-button', buttonText: 'Export image' };
const storageAction = { commandId: 'storage', commandLabel: 'Storage', event: 'click', element: 'en-button', buttonText: 'Storage' };
const sessionId = '01234567-89ab-4cde-8fab-0123456789ab';
const file = (name, kind, identity, extra = {}) => ({ file: 'assets/' + name, kind, sha256: hash(identity), rawBytes: 1000 + identity,
  gzipBytes: 300 + identity, computedGzipBytes: 300 + identity, authoringFont: false, ...extra });
function specimen() {
  const files = [file('main.js', 'js', 1), file('shared.js', 'js', 2), file('save.js', 'js', 3), file('save-helper.js', 'js', 4),
    file('save.css', 'css', 5), file('imported.css', 'css', 6), file('conditional.woff2', 'font', 7),
    file('engine.js', 'js', 8), file('engine.wasm', 'wasm', 9), file('unrelated.js', 'js', 10)];
  // A second emitted path with identical bytes is still a distinct artifact.
  files.push({ ...files[3], file: 'assets/save-helper-copy.js' });
  const closure = files.filter(row => !['assets/main.js', 'assets/unrelated.js'].includes(row.file)).map(row => row.file);
  return { kind: 'perf-d11-build-1', sha256: hash(90), files,
    roleContext: { kind: 'd11-role-context-1', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
      boundary: 'document-ready-via-Open', workloads: ['W0', 'W1'], counting: 'union' },
    dynamicFeatures: [{ id: featureId, entryFile: 'assets/save.js', files: ['assets/save.js', 'assets/shared.js', 'assets/save-helper.js', 'assets/save-helper-copy.js', 'assets/save.css'] }],
    roles: { complete: true, missing: [], startupFiles: ['assets/main.js', 'assets/shared.js'], textEngineFiles: ['assets/engine.js', 'assets/engine.wasm'],
      lazyFeatures: [{ id: featureId, closureFiles: [...closure], files: closure.filter(name => !name.startsWith('assets/engine.')) }],
      excludedImports: [{ reason: 'verified-private-event-boundary', target: 'assets/save.js', outputs: ['assets/main.js'],
        witness: { kind: 'd11-private-event-import-1', featureSource: featureId, importStart: 100, source: 'src/tools/menu.ts', publicAction: { ...exportAction } } }] },
  };
}
function withStorageFeature(build = specimen()) {
  const storageId = 'src/tools/storage-panel.ts', entryFile = 'assets/storage.js';
  build.files.push(file('storage.js', 'js', 11));
  build.dynamicFeatures.push({ id: storageId, entryFile, files: [entryFile] });
  build.roles.lazyFeatures.push({ id: storageId, closureFiles: [entryFile], files: [entryFile] });
  build.roles.excludedImports.push({ reason: 'verified-private-event-boundary', target: entryFile, outputs: ['assets/main.js'],
    witness: { kind: 'd11-private-event-import-1', featureSource: storageId, importStart: 200, source: 'src/tools/menu.ts', publicAction: { ...storageAction } } });
  return build;
}
const execute = (build, name, extra = {}) => {
  const actual = build.files.find(row => row.file === name);
  return { file: name, owner: 'page', sha256: actual.sha256, rawBytes: actual.rawBytes, executedFunctions: 1, newlyEvaluated: true, ...extra };
};
function deliver(observation, build, name, { transfer = 2000, request = {}, resource = {} } = {}) {
  const actual = build.files.find(row => row.file === name), cached = transfer === 0;
  const row = { id: actual.sha256 + ':' + name, ...actual, role: actual.kind === 'font' ? 'ui-font' : actual.kind,
    owner: 'page', verified: true, status: 200, networkTransferBytes: transfer, servedFromCache: cached,
    fromDiskCache: cached, fromServiceWorker: false, timing: { transferSize: transfer, encodedBodySize: actual.rawBytes, decodedBodySize: actual.rawBytes }, ...resource };
  observation.resourceRequests.push({ resourceIndex: observation.resources.length, file: name, owner: 'page', sha256: actual.sha256, rawBytes: actual.rawBytes,
    method: 'GET', resourceType: actual.kind === 'js' ? 'Script' : actual.kind === 'css' ? 'Stylesheet' : 'Font', initiatorType: 'script',
    complete: true, failed: false, status: 200, servedFromCache: cached, fromDiskCache: cached, fromServiceWorker: false, ...request });
  observation.resources.push(row);
}
function startup(build, { workload = 'W1', cache = 'cold', transfer = 2000 } = {}) {
  const observation = { id: 'startup:1', buildSha256: build.sha256, fixtureSeal: hash(91), collectorSessionId: sessionId, documentNavigationId: 1,
    workload, cache, cachePolicy: { httpCacheDisabledByRouting: false }, instrumentation: 'precise-coverage-byte-audit', timingSamplesReusable: false,
    scope: 'startup', startedBeforeNavigation: true, featureBoundary: { featureId, phase: 'startup-absence' }, missing: [],
    browserProfile: { observed: true, viewport: { ...build.roleContext.viewport }, deviceScaleFactor: 2 },
    collection: { complete: true, closingStable: true, requestMethod: 'cdp-network-get-v1', evaluationMethod: 'cdp-precise-coverage-v1', realms: ['page'],
      realmStates: [{ owner: 'page', networkEnabled: true, preciseCoverageEnabled: true, openingCoverageReset: true, closingCoverageRead: true, detached: false }] },
    resources: [], resourceRequests: [], evaluated: [execute(build, 'assets/main.js'), execute(build, 'assets/shared.js')] };
  deliver(observation, build, 'assets/main.js', { transfer }); deliver(observation, build, 'assets/shared.js', { transfer });
  return observation;
}
function firstUse(build, before = startup(build)) {
  const baseline = { observation: before, artifact: { path: '/retained/startup.json', sha256: hash(92), byteLength: '1000' } };
  const observation = { ...structuredClone(before), id: 'feature:1', scope: 'lazy-feature', featureId, baselineComplete: true,
    featureBoundary: { featureId, phase: 'first-use' }, publicAction: { kind: 'export', completed: true },
    baselineReference: { observationId: before.id, artifactSha256: baseline.artifact.sha256, buildSha256: before.buildSha256,
      fixtureSeal: before.fixtureSeal, workload: before.workload, cache: before.cache, collectorSessionId: before.collectorSessionId, documentNavigationId: before.documentNavigationId },
    openingGap: { baselineArtifactSha256: baseline.artifact.sha256, inventoryUnchanged: true, priorMissing: [], evaluatedExclusiveFiles: [], complete: true },
    actionStart: { kind: 'export', boundary: 'before-public-click-dispatch', observationId: 'feature:1', baselineArtifactSha256: baseline.artifact.sha256,
      collectorSessionId: before.collectorSessionId, documentNavigationId: before.documentNavigationId, complete: true },
    resources: [], resourceRequests: [], evaluated: [execute(build, 'assets/shared.js', { newlyEvaluated: false })] };
  for (const name of ['assets/save.js', 'assets/save-helper.js', 'assets/save-helper-copy.js', 'assets/save.css', 'assets/imported.css']) {
    deliver(observation, build, name, { transfer: before.cache === 'warm' ? 0 : 2000 });
    if (name.endsWith('.js')) observation.evaluated.push(execute(build, name));
  }
  return { observation, baseline };
}
const absence = (observation, build) => analyzeD11FeatureAbsence(observation, build, featureId);
const used = (state, build) => analyzeD11FeatureFirstUse(state.observation, build, { featureId, baseline: state.baseline });

test('public-action selector chooses Export with a second Storage feature in either witness order', () => {
  for (const reverse of [false, true]) {
    const build = withStorageFeature();
    if (reverse) build.roles.excludedImports.reverse();
    const before = structuredClone(build), proof = selectD11FeatureBoundaryForAction(build, exportAction);
    assert.equal(proof.complete, true); assert.equal(proof.featureId, featureId);
    assert.deepEqual(proof, deriveD11FeatureBoundary(build, featureId));
    assert.deepEqual(build, before); assert.equal(Object.isFrozen(build), false);
    assert.equal(Object.isFrozen(proof), true);
    assert(!proof.closureFiles.includes('assets/storage.js'));
  }
});

test('public-action selection does not infer action identity from a source or method name', () => {
  const build = withStorageFeature(), renamed = 'features/arbitrary-name.mjs';
  build.dynamicFeatures[0].id = renamed; build.roles.lazyFeatures[0].id = renamed;
  build.roles.excludedImports[0].witness.featureSource = renamed;
  build.roles.excludedImports[0].witness.method = '#unrelatedName';
  assert.equal(selectD11FeatureBoundaryForAction(build, exportAction).featureId, renamed);
  delete build.roles.excludedImports[0].witness.publicAction;
  build.roles.excludedImports[0].witness.method = '#exportImage';
  assert.equal(selectD11FeatureBoundaryForAction(build, exportAction).complete, false);
  assert.equal(deriveD11FeatureBoundary(build, renamed).complete, true);
});

test('public-action selection rejects every tuple mismatch without falling back to the lone feature', () => {
  for (const key of Object.keys(exportAction)) {
    const build = specimen(); build.roles.excludedImports[0].witness.publicAction[key] += '-mismatch';
    const proof = selectD11FeatureBoundaryForAction(build, exportAction);
    assert.equal(proof.complete, false, key); assert(proof.missing.length);
  }
});

test('missing, malformed and extra public-action fields cannot select an import witness', () => {
  const missingKey = { ...exportAction }; delete missingKey.commandId;
  for (const action of [undefined, null, {}, [], missingKey, { ...exportAction, extra: true },
    { ...exportAction, buttonText: '' }, { ...exportAction, buttonText: 'x'.repeat(4097) }, Object.create(exportAction)]) {
    const build = withStorageFeature(); build.roles.excludedImports[0].witness.publicAction = action;
    assert.equal(selectD11FeatureBoundaryForAction(build, exportAction).complete, false);
    assert.equal(selectD11FeatureBoundaryForAction(specimen(), action).complete, false);
  }
});

test('duplicate matching witnesses fail even for the same feature or a second Storage feature', () => {
  for (const sameFeature of [true, false]) {
    const build = withStorageFeature();
    if (sameFeature) build.roles.excludedImports.push(structuredClone(build.roles.excludedImports[0]));
    else build.roles.excludedImports[1].witness.publicAction = { ...exportAction };
    assert.equal(selectD11FeatureBoundaryForAction(build, exportAction).complete, false);
  }
});

test('action metadata alone cannot bypass exact private-event reason, kind, feature and importer binding', () => {
  for (const change of [
    value => { value.roles.excludedImports[0].reason = 'lexically-deferred'; },
    value => { value.roles.excludedImports[0].witness.kind = 'unverified'; },
    value => { value.roles.excludedImports[0].witness.featureSource = 'src/missing.ts'; },
    value => { value.roles.excludedImports[0].target = 'assets/storage.js'; },
    value => { value.roles.excludedImports[0].outputs = ['assets/save.js']; },
    value => { value.roles.complete = false; },
    value => { value.roles.excludedImports = Array(20001).fill(value.roles.excludedImports[0]); },
  ]) {
    const build = withStorageFeature(); change(build);
    assert.equal(selectD11FeatureBoundaryForAction(build, exportAction).complete, false);
  }
});

test('supplemental reducers reject Storage evidence relabeled as the planned Export action', () => {
  const build = withStorageFeature(), storageId = build.dynamicFeatures[1].id;
  assert.equal(deriveD11FeatureBoundary(build, storageId).complete, true);
  assert.equal(selectD11FeatureBoundaryForAction(build, storageAction).featureId, storageId);
  const before = startup(build); before.featureBoundary.featureId = storageId;
  const absent = analyzeD11FeatureAbsence(before, build, storageId);
  assert.equal(absent.status, 'INCONCLUSIVE'); assert.deepEqual(absent.failures, []);
  assert.deepEqual(absent.missing, ['Supplemental Export evidence requires the unique replayed Export public-action feature']);
  const state = firstUse(build, before);
  state.observation.featureId = storageId; state.observation.featureBoundary.featureId = storageId;
  state.observation.resources = []; state.observation.resourceRequests = [];
  state.observation.evaluated = [execute(build, 'assets/storage.js')];
  deliver(state.observation, build, 'assets/storage.js');
  const result = analyzeD11FeatureFirstUse(state.observation, build, { featureId: storageId, baseline: state.baseline });
  assert.equal(result.status, 'INCONCLUSIVE'); assert.deepEqual(result.failures, []);
  assert.deepEqual(result.missing, ['A complete independently retained startup absence proof is required',
    'Supplemental Export evidence requires the unique replayed Export public-action feature']);
  assert.deepEqual(result.observed.absentRequiredFiles, []); assert.deepEqual(result.observed.unevaluatedRequiredFiles, []);
});

test('supplemental reducers require the full unique Export tuple even for a complete feature identity', () => {
  for (const change of [
    value => { delete value.roles.excludedImports[0].witness.publicAction; },
    value => { value.roles.excludedImports[0].witness.publicAction.buttonText = 'Storage'; },
    value => { value.roles.excludedImports[1].witness.publicAction = { ...exportAction }; },
  ]) {
    const build = withStorageFeature(); change(build);
    assert.equal(deriveD11FeatureBoundary(build, featureId).complete, true);
    assert.equal(absence(startup(build), build).status, 'INCONCLUSIVE');
    assert.equal(used(firstUse(build), build).status, 'INCONCLUSIVE');
  }
});

test('private-event proof selects the full CSS/font closure and keeps shared and engine sets explicit', () => {
  const build = specimen(), proof = deriveD11FeatureBoundary(build, featureId);
  assert.equal(proof.complete, true); assert.deepEqual(proof.missing, []);
  assert.deepEqual(proof.importerFiles, ['assets/main.js']); assert.deepEqual(proof.sharedFiles, ['assets/shared.js']);
  assert.deepEqual(proof.engineFiles, ['assets/engine.js', 'assets/engine.wasm']);
  assert(proof.closureFiles.includes('assets/imported.css')); assert(proof.closureFiles.includes('assets/conditional.woff2'));
  assert(proof.exclusiveFiles.includes('assets/engine.js')); assert(!proof.budgetedFeatureFiles.includes('assets/engine.js'));
  assert(proof.exclusiveFiles.includes('assets/save-helper.js')); assert(proof.exclusiveFiles.includes('assets/save-helper-copy.js'));
  assert.equal(proof.closureFiles.length, proof.sharedFiles.length + proof.exclusiveFiles.length);
});

test('selection uses a verified witness and exact manifest identity, without a source filename whitelist', () => {
  const build = specimen(), renamed = 'features/a-different-format.mjs';
  build.dynamicFeatures[0].id = renamed; build.roles.lazyFeatures[0].id = renamed; build.roles.excludedImports[0].witness.featureSource = renamed;
  assert.equal(deriveD11FeatureBoundary(build, renamed).complete, true);
  assert.equal(deriveD11FeatureBoundary(build, featureId).complete, false);
  for (const change of [
    value => { value.roles.excludedImports = []; },
    value => { value.roles.excludedImports[0].reason = 'lexically-deferred'; },
    value => { value.roles.excludedImports[0].witness.kind = 'unverified'; },
    value => { value.roles.excludedImports[0].witness.featureSource = 'src/not-this-feature.ts'; },
    value => { value.roles.excludedImports[0].target = 'assets/unrelated.js'; },
    value => { value.roles.excludedImports[0].outputs = ['assets/save.js']; },
    value => { value.roles.excludedImports[0].outputs = ['assets/missing.js']; },
  ]) { const input = specimen(); change(input); assert.equal(deriveD11FeatureBoundary(input, featureId).complete, false); }
});

test('partial manifest closure cannot substitute for the role closure or its exact engine subtraction', () => {
  for (const change of [
    value => { delete value.roles.lazyFeatures[0].closureFiles; },
    value => { value.roles.lazyFeatures[0].closureFiles = []; },
    value => { value.roles.lazyFeatures[0].closureFiles = value.dynamicFeatures[0].files; },
    value => { value.roles.lazyFeatures[0].files.push('assets/engine.js'); },
    value => { value.roles.lazyFeatures[0].files.pop(); },
    value => { value.roles.lazyFeatures[0].closureFiles.push('assets/missing.css'); },
  ]) { const build = specimen(); change(build); assert.equal(deriveD11FeatureBoundary(build, featureId).complete, false); }
});

test('duplicate, ambiguous, eager, unbounded and noncanonical role inputs cannot qualify', () => {
  for (const change of [
    value => { value.roles.complete = false; }, value => { value.roles.missing.push('Unresolved import'); },
    value => { value.roles.startupFiles.push('assets/save.js'); }, value => { value.roles.startupFiles.push('assets/engine.js'); },
    value => { value.roles.startupFiles.push(value.roles.startupFiles[0]); },
    value => { value.roles.lazyFeatures.push(structuredClone(value.roles.lazyFeatures[0])); },
    value => { value.dynamicFeatures.push(structuredClone(value.dynamicFeatures[0])); },
    value => { value.files.push(structuredClone(value.files[0])); },
    value => { value.files[0].file = '../escape.js'; },
    value => { value.roles.excludedImports = Array(20001).fill(null); },
    value => { value.roles.excludedImports[0].witness.loop = value.roles.excludedImports[0].witness; },
  ]) { const build = specimen(); change(build); assert.equal(deriveD11FeatureBoundary(build, featureId).complete, false); }
});

test('derived evidence is frozen without freezing or mutating its input build', () => {
  const build = specimen(), before = structuredClone(build), proof = deriveD11FeatureBoundary(build, featureId);
  assert.deepEqual(build, before); assert.equal(Object.isFrozen(build), false);
  assert(Object.isFrozen(proof)); assert(Object.isFrozen(proof.closureFiles)); assert(Object.isFrozen(proof.witnesses[0].witness));
  build.roles.excludedImports[0].witness.importStart = 999;
  assert.equal(proof.witnesses[0].witness.importStart, 100);
});

test('complete W0/W1 cold/warm startup can prove exclusive absence while sharing startup files', () => {
  const build = specimen();
  for (const workload of ['W0', 'W1']) for (const cache of ['cold', 'warm']) {
    const result = absence(startup(build, { workload, cache, transfer: cache === 'warm' ? 0 : 2000 }), build);
    assert.equal(result.status, 'PASS'); assert.deepEqual(result.missing, []); assert.deepEqual(result.failures, []);
    assert.deepEqual(result.observed.sharedRequestedFiles, ['assets/shared.js']); assert.deepEqual(result.observed.earlyRequestedFiles, []);
    assert.equal(result.timingSamplesReusable, false); assert.equal(result.documentNavigationId, 1);
    assert.equal(Object.hasOwn(result, 'measurements'), false);
  }
});

test('zero-transfer cache hits and preload GETs of any exclusive artifact fail absence', () => {
  for (const name of ['assets/save.js', 'assets/save-helper-copy.js', 'assets/imported.css', 'assets/conditional.woff2', 'assets/engine.wasm']) {
    const build = specimen(), observation = startup(build, { cache: 'warm', transfer: 0 });
    deliver(observation, build, name, { transfer: 0, request: { initiatorType: 'preload' } });
    const result = absence(observation, build); assert.equal(result.status, 'FAIL'); assert.deepEqual(result.observed.earlyRequestedFiles, [name]);
  }
});

test('pending and failed early GET attempts cannot masquerade as a deferred feature', () => {
  for (const failed of [false, true]) {
    const build = specimen(), observation = startup(build);
    deliver(observation, build, 'assets/save.js', { request: { complete: false, failed, status: null }, resource: { verified: false, status: undefined, timing: null } });
    const result = absence(observation, build); assert.equal(result.status, 'FAIL'); assert(result.missing.length);
    assert.deepEqual(result.observed.earlyRequestedFiles, ['assets/save.js']);
  }
});

test('actual early execution fails absence even without a separately delivered resource', () => {
  const build = specimen(), observation = startup(build); observation.evaluated.push(execute(build, 'assets/save.js'));
  const result = absence(observation, build); assert.equal(result.status, 'FAIL'); assert.deepEqual(result.observed.earlyEvaluatedFiles, ['assets/save.js']);
});

test('requests must align exactly once with all observed resource identities', () => {
  for (const change of [
    value => { value.resourceRequests.pop(); }, value => { value.resourceRequests[1].resourceIndex = 0; },
    value => { value.resourceRequests[0].resourceIndex = -1; }, value => { value.resourceRequests[0].resourceIndex = 100; },
    value => { value.resourceRequests[0].file = 'assets/shared.js'; }, value => { value.resourceRequests[0].sha256 = hash(99); },
    value => { value.resourceRequests[0].rawBytes++; }, value => { value.resourceRequests[0].owner = 'worker-unobserved'; },
    value => { value.resourceRequests[0].method = 'HEAD'; }, value => { value.resourceRequests[0].initiatorType = ''; },
    value => { value.resourceRequests[0].complete = false; }, value => { value.resourceRequests[0].failed = true; },
    value => { value.resourceRequests[0].servedFromCache = true; }, value => { value.resourceRequests[0].fromServiceWorker = true; },
    value => { value.resources[0].sha256 = hash(99); }, value => { value.resources[0].gzipBytes = 1; },
    value => { value.resources[0].verified = false; }, value => { value.resources[0].kind = 'other'; },
    value => { value.resources[0].timing = null; }, value => { value.resources[0].networkTransferBytes = undefined; },
  ]) { const build = specimen(), observation = startup(build); change(observation); assert.equal(absence(observation, build).status, 'INCONCLUSIVE'); }
});

test('incomplete, unstable or unobserved worker intervals cannot prove absence', () => {
  for (const change of [
    value => { value.collection.complete = false; }, value => { value.collection.closingStable = false; },
    value => { value.collection.requestMethod = 'resource-timing-only'; }, value => { value.collection.evaluationMethod = 'parsed-scripts'; },
    value => { value.collection.realmStates[0].networkEnabled = false; }, value => { value.collection.realmStates[0].preciseCoverageEnabled = false; },
    value => { value.collection.realmStates[0].openingCoverageReset = false; }, value => { value.collection.realmStates[0].closingCoverageRead = false; },
    value => { value.collection.realmStates[0].detached = true; }, value => { value.collection.realms.push('worker-missed'); },
    value => { value.collection.realmStates.push({ ...value.collection.realmStates[0] }); }, value => { value.missing.push('Unmapped resource'); },
    value => { value.cachePolicy.httpCacheDisabledByRouting = true; }, value => { delete value.cachePolicy; },
    value => { value.evaluated[0].executedFunctions = 0; }, value => { value.evaluated[0].owner = 'worker-missed'; },
  ]) { const build = specimen(), observation = startup(build); change(observation); assert.equal(absence(observation, build).status, 'INCONCLUSIVE'); }
});

test('absence binds actual navigation, display, workload, build, fixture and collector identity', () => {
  for (const change of [
    value => { value.buildSha256 = hash(99); }, value => { value.fixtureSeal = null; }, value => { value.collectorSessionId = 'unspecified'; },
    value => { value.documentNavigationId = 0; }, value => { value.workload = 'W2'; }, value => { value.cache = 'primed'; },
    value => { value.browserProfile.viewport.width = 100; }, value => { value.browserProfile.deviceScaleFactor = 1; },
    value => { value.startedBeforeNavigation = false; }, value => { value.scope = 'text-engine'; },
    value => { value.featureBoundary.featureId = 'src/unproved.ts'; }, value => { value.featureBoundary.phase = 'first-use'; },
    value => { value.publicAction = { kind: 'export', completed: true }; }, value => { value.timingSamplesReusable = true; },
    value => { value.resources = []; value.resourceRequests = []; value.evaluated = []; },
  ]) { const build = specimen(), observation = startup(build); change(observation); assert.equal(absence(observation, build).status, 'INCONCLUSIVE'); }
});

test('public first use binds the retained same-document startup and full required exclusive closure', () => {
  const build = specimen();
  for (const cache of ['cold', 'warm']) {
    const state = firstUse(build, startup(build, { cache })), result = used(state, build);
    assert.equal(result.status, 'PASS'); assert.equal(result.baselineStatus, 'PASS'); assert.deepEqual(result.missing, []);
    assert.equal(result.baselineArtifactSha256, hash(92)); assert.equal(result.documentNavigationId, state.baseline.observation.documentNavigationId);
    assert(result.observed.requiredAfterFiles.includes('assets/imported.css'));
    assert(result.observed.requiredAfterFiles.includes('assets/save-helper-copy.js'));
    assert(!result.observed.requiredAfterFiles.includes('assets/conditional.woff2')); assert(!result.observed.requiredAfterFiles.includes('assets/engine.js'));
    assert.deepEqual(result.observed.sharedEvaluatedFiles, ['assets/shared.js']); assert.equal(Object.hasOwn(result, 'measurements'), false);
  }
});

test('a same-process reload or any different baseline identity cannot qualify first use', () => {
  const changes = [
    state => { state.baseline = null; }, state => { state.baseline = state.baseline.observation; },
    state => { state.baseline.artifact.sha256 = hash(99); }, state => { state.observation.baselineReference.artifactSha256 = hash(99); },
    state => { state.observation.documentNavigationId++; }, state => { state.observation.baselineReference.documentNavigationId++; },
    state => { state.observation.collectorSessionId = '11234567-89ab-4cde-8fab-0123456789ab'; },
    state => { state.observation.cache = 'warm'; }, state => { state.observation.fixtureSeal = hash(99); },
    state => { state.observation.buildSha256 = hash(99); }, state => { state.observation.id = state.baseline.observation.id; },
    state => { state.observation.baselineReference.extra = true; }, state => { delete state.observation.baselineReference; },
    state => { state.baseline.observation.collection.complete = false; },
    state => { state.observation.workload = 'W0'; state.baseline.observation.workload = 'W0'; state.observation.baselineReference.workload = 'W0'; },
  ];
  for (const change of changes) { const build = specimen(), state = firstUse(build); change(state); assert.equal(used(state, build).status, 'INCONCLUSIVE'); }
});

test('first use needs a completed public action and positive new execution of every exclusive JS artifact', () => {
  for (const change of [
    state => { state.observation.publicAction.completed = false; }, state => { state.observation.publicAction.kind = 'programmatic-import'; },
    state => { delete state.observation.publicAction; }, state => { state.observation.baselineComplete = false; },
    state => { state.observation.evaluated.find(row => row.file === 'assets/save.js').newlyEvaluated = false; },
    state => { state.observation.evaluated = state.observation.evaluated.filter(row => row.file !== 'assets/save-helper-copy.js'); },
    state => { state.observation.resources.pop(); state.observation.resourceRequests.pop(); },
  ]) { const build = specimen(), state = firstUse(build); change(state); assert.equal(used(state, build).status, 'INCONCLUSIVE'); }
});

test('first-use interval cannot erase a preload, unsupported target or execution after the retained startup snapshot', () => {
  for (const change of [
    state => { delete state.observation.openingGap; },
    state => { state.observation.openingGap.complete = false; },
    state => { state.observation.openingGap.inventoryUnchanged = false; },
    state => { state.observation.openingGap.baselineArtifactSha256 = hash(99); },
    state => { state.observation.openingGap.priorMissing.push('Unexpected attached execution target'); },
    state => { state.observation.openingGap.evaluatedExclusiveFiles.push('assets/save.js'); },
    state => { state.observation.openingGap.evaluatedExclusiveFiles = null; },
    state => { state.observation.openingGap.extra = true; },
  ]) { const build = specimen(), state = firstUse(build); change(state); assert.equal(used(state, build).status, 'INCONCLUSIVE'); }
});

test('public dispatch interval requires an explicit same-observation opening witness without claiming a physical timestamp', () => {
  const build = specimen(), complete = used(firstUse(build), build);
  assert.equal(complete.actionInterval, 'before-public-click-dispatch-through-controls-ready');
  assert.match(complete.orderingScope, /no physical click timestamp or request causality proof/);
  for (const change of [
    state => { delete state.observation.actionStart; }, state => { state.observation.actionStart.complete = false; },
    state => { state.observation.actionStart.boundary = 'physical-click'; }, state => { state.observation.actionStart.observationId = 'another-observation'; },
    state => { state.observation.actionStart.baselineArtifactSha256 = hash(99); }, state => { state.observation.actionStart.documentNavigationId++; },
    state => { state.observation.actionStart.collectorSessionId = 'another-session'; }, state => { state.observation.actionStart.timestamp = 0; },
  ]) { const state = firstUse(build); change(state); assert.equal(used(state, build).status, 'INCONCLUSIVE'); }
});

test('escaped first-use code and a failed startup absence remain failures', () => {
  const build = specimen(), escaped = firstUse(build);
  deliver(escaped.observation, build, 'assets/unrelated.js'); escaped.observation.evaluated.push(execute(build, 'assets/unrelated.js'));
  const result = used(escaped, build); assert.equal(result.status, 'FAIL'); assert.deepEqual(result.observed.escapedRequestedFiles, ['assets/unrelated.js']);
  const early = firstUse(build); deliver(early.baseline.observation, build, 'assets/save.js', { transfer: 0 });
  assert.equal(used(early, build).status, 'FAIL');
});

test('missing or malformed ordinary JSON inputs return incomplete proof instead of throwing', () => {
  for (const value of [null, undefined, {}, [], { roles: { startupFiles: 7, textEngineFiles: 8 } }]) {
    assert.equal(deriveD11FeatureBoundary(value, featureId).complete, false);
    assert.equal(analyzeD11FeatureAbsence(null, value, featureId).status, 'INCONCLUSIVE');
    assert.equal(analyzeD11FeatureFirstUse(null, value, { featureId, baseline: null }).status, 'INCONCLUSIVE');
  }
});

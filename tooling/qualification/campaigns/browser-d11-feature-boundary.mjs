// Supplemental H evidence only. This module performs no I/O, imports, parsing,
// hashing, browser work or qualification scheduling. The caller must first
// reproduce the retained build and the ordinary D11 audit independently.
const LIMIT = 20_000;
const HASH = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EXPORT_PUBLIC_ACTION = Object.freeze({ commandId: 'export-image', commandLabel: 'Export image',
  event: 'click', element: 'en-button', buttonText: 'Export image' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sorted = values => [...new Set(values)].sort();
const validHash = value => typeof value === 'string' && HASH.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const path = value => text(value) && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
  && !/[\\\x00-\x1f\x7f?#]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
const filePath = value => value === 'inline:bootstrap' || path(value);
const list = value => Array.isArray(value) && value.length <= LIMIT;
const names = (value, accepts = filePath) => list(value) && value.every(accepts) && new Set(value).size === value.length;
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameNames = (left, right) => { const a = sorted(left), b = sorted(right); return left.length === right.length && a.length === b.length && a.every((value, index) => value === b[index]); };
const role = file => file.kind === 'font' ? file.authoringFont ? 'authoring-font' : 'ui-font' : file.kind;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function copyJSON(value, budget = { entries: 0 }, depth = 0) {
  if (++budget.entries > LIMIT || depth > 32) throw Error('Witness exceeds the finite retained JSON bound');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 8192) return value;
  if (list(value)) return value.map(item => copyJSON(item, budget, depth + 1));
  if (object(value) && Object.keys(value).length <= LIMIT) return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (key.length > 8192) throw Error('Witness key exceeds its bound');
    return [key, copyJSON(value[key], budget, depth + 1)];
  }));
  throw Error('Witness must contain bounded JSON values');
}

function inventory(build, missing) {
  const files = new Map();
  if (!object(build) || build.kind !== 'perf-d11-build-1' || !validHash(build.sha256) || !list(build.files) || !build.files.length) {
    missing.push('Exact independently verified D11 build inventory is required'); return files;
  }
  for (const file of build.files) {
    if (!object(file) || !filePath(file.file) || files.has(file.file) || !validHash(file.sha256)
      || !integer(file.rawBytes) || !integer(file.gzipBytes)
      || file.computedGzipBytes !== undefined && file.computedGzipBytes !== file.gzipBytes
      || !['js', 'css', 'font', 'wasm', 'other'].includes(file.kind)
      || file.kind === 'font' && typeof file.authoringFont !== 'boolean') {
      missing.push('D11 emitted file inventory is malformed or duplicated'); continue;
    }
    files.set(file.file, file);
  }
  return files;
}

/** Match one exact public action in an independently replayed build. This pure
 * selector does not authenticate caller-supplied metadata: the caller must
 * replay the complete source corpus in a fresh build-verification invocation.
 * Other private-event features are allowed, but two matching witnesses are
 * ambiguous even if they name the same feature. */
export function selectD11FeatureBoundaryForAction(build, publicAction) {
  const keys = ['commandId', 'commandLabel', 'event', 'element', 'buttonText'];
  const action = value => exactKeys(value, keys) && keys.every(key => text(value[key]));
  const incomplete = reason => freeze({ complete: false, missing: [reason] });
  if (!action(publicAction)) return incomplete('An exact bounded public-action tuple is required');
  if (!object(build?.roles) || !list(build.roles.excludedImports)) return incomplete('Replayed excluded import witnesses are required for public-action selection');
  const matches = build.roles.excludedImports.filter(row => object(row) && row.reason === 'verified-private-event-boundary'
    && object(row.witness) && row.witness.kind === 'd11-private-event-import-1' && action(row.witness.publicAction)
    && keys.every(key => row.witness.publicAction[key] === publicAction[key]));
  if (matches.length !== 1) return incomplete('Exactly one replayed private-event witness must match the complete public-action tuple');
  return deriveD11FeatureBoundary(build, matches[0].witness.featureSource);
}

/** Select a feature by its replayed private-event import witness, never by an
 * application filename allowlist. A bundler manifest alone omits transitive CSS
 * and font dependencies, so the full role closure is mandatory. */
export function deriveD11FeatureBoundary(build, featureId) {
  const missing = [], files = inventory(build, missing), roles = build?.roles;
  const result = { kind: 'd11-feature-boundary-1', buildSha256: validHash(build?.sha256) ? build.sha256 : null,
    featureId: path(featureId) ? featureId : null, entryFile: null, importerFiles: [], closureFiles: [],
    sharedFiles: [], exclusiveFiles: [], engineFiles: [], budgetedFeatureFiles: [], witnesses: [] };
  const finish = () => freeze({ ...result, complete: !missing.length, missing: sorted(missing) });
  if (!path(featureId)) missing.push('Exact dynamic feature source identity is required');
  if (!object(roles) || roles.complete !== true || !list(roles.missing) || roles.missing.length
    || !names(roles.startupFiles) || !names(roles.textEngineFiles) || !list(roles.lazyFeatures) || !list(roles.excludedImports)) {
    missing.push('Complete replayed role classification and excluded import witnesses are required'); return finish();
  }
  if ([...roles.startupFiles, ...roles.textEngineFiles].some(name => !files.has(name))) missing.push('Role classification refers to an unknown emitted file');
  if (roles.textEngineFiles.some(name => !['js', 'wasm'].includes(files.get(name)?.kind))) missing.push('Text-engine roles contain an incompatible emitted file');
  if (!list(build?.dynamicFeatures) || build.dynamicFeatures.some(feature => !object(feature) || !path(feature.id))
    || new Set(build.dynamicFeatures.map(feature => feature.id)).size !== build.dynamicFeatures.length) {
    missing.push('Exact unique dynamic feature inventory is required'); return finish();
  }
  if (roles.lazyFeatures.some(feature => !object(feature) || !path(feature.id))
    || new Set(roles.lazyFeatures.map(feature => feature.id)).size !== roles.lazyFeatures.length) {
    missing.push('Exact unique feature role inventory is required'); return finish();
  }
  const feature = build.dynamicFeatures.find(value => value.id === featureId), selected = roles.lazyFeatures.find(value => value.id === featureId);
  const selectedClosure = new Set(list(selected?.closureFiles) ? selected.closureFiles : []);
  if (!feature || !filePath(feature.entryFile) || files.get(feature.entryFile)?.kind !== 'js'
    || !names(feature.files) || !feature.files.includes(feature.entryFile) || feature.files.some(name => !files.has(name))) {
    missing.push('Feature entry and static manifest closure are absent or malformed'); return finish();
  }
  result.entryFile = feature.entryFile;
  if (!selected || !names(selected.closureFiles) || !selected.closureFiles.length || !names(selected.files)
    || selected.closureFiles.some(name => !files.has(name)) || !feature.files.every(name => selectedClosure.has(name))) {
    missing.push('Full verified feature closure including transitive CSS and fonts is required'); return finish();
  }
  const startup = new Set(roles.startupFiles), engine = new Set(roles.textEngineFiles);
  result.closureFiles = sorted(selected.closureFiles);
  result.sharedFiles = result.closureFiles.filter(name => startup.has(name));
  result.exclusiveFiles = result.closureFiles.filter(name => !startup.has(name));
  result.engineFiles = result.closureFiles.filter(name => engine.has(name));
  result.budgetedFeatureFiles = result.closureFiles.filter(name => !engine.has(name));
  if (!sameNames(selected.files, result.budgetedFeatureFiles)) missing.push('Feature budget files differ from its complete closure minus the separately budgeted engine');
  if (startup.has(feature.entryFile) || engine.has(feature.entryFile)) missing.push('Selected private-event feature entry is not an exclusive deferred feature');
  if (roles.textEngineFiles.some(name => startup.has(name))) missing.push('Text-engine closure overlaps the startup role classification');
  const matches = roles.excludedImports.filter(row => object(row) && (row.target === feature.entryFile || row.witness?.featureSource === featureId));
  if (!matches.length) missing.push('Exact replayed private-event import witness is unavailable');
  const witnessBudget = { entries: 0 };
  for (const row of matches) {
    if (row.reason !== 'verified-private-event-boundary' || row.target !== feature.entryFile
      || !object(row.witness) || row.witness.kind !== 'd11-private-event-import-1' || row.witness.featureSource !== featureId
      || !names(row.outputs) || !row.outputs.length || row.outputs.some(name => files.get(name)?.kind !== 'js' || name === feature.entryFile)) {
      missing.push('Private-event import witness does not bind this exact feature and its importer chunks'); continue;
    }
    try {
      result.witnesses.push(copyJSON({ target: row.target, outputs: sorted(row.outputs), reason: row.reason, witness: row.witness }, witnessBudget));
      result.importerFiles.push(...row.outputs);
    } catch { missing.push('Private-event import witness is not finite retained JSON'); }
  }
  result.importerFiles = sorted(result.importerFiles);
  result.witnesses.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return finish();
}

function observationEvidence(observation, build, phase, featureId) {
  const missing = [], files = inventory(build, missing), requested = new Set(), evaluated = new Set(), newlyEvaluated = new Set();
  const resources = object(observation) && list(observation.resources) ? observation.resources : [];
  const requests = object(observation) && list(observation.resourceRequests) ? observation.resourceRequests : [];
  const executions = object(observation) && list(observation.evaluated) ? observation.evaluated : [];
  const seenIndexes = new Set(), owners = new Set();
  const featureBoundary = observation?.featureBoundary, collection = observation?.collection;
  if (!object(observation) || !text(observation.id) || observation.buildSha256 !== build?.sha256 || !validHash(observation.fixtureSeal)
    || typeof observation.collectorSessionId !== 'string' || !UUID.test(observation.collectorSessionId)
    || !integer(observation.documentNavigationId) || observation.documentNavigationId < 1
    || !['W0', 'W1'].includes(observation.workload)) missing.push('Observation lacks exact build, fixture, workload, session, navigation or observation identity');
  if (!exactKeys(featureBoundary, ['featureId', 'phase']) || featureBoundary.featureId !== featureId || featureBoundary.phase !== phase) missing.push('Supplemental feature boundary differs from the declared phase and exact feature');
  if (!['cold', 'warm'].includes(observation?.cache) || observation?.cachePolicy?.httpCacheDisabledByRouting !== false) missing.push('Actual cold/warm browser cache policy is unavailable or disables HTTP caching');
  if (observation?.instrumentation !== 'precise-coverage-byte-audit' || observation.timingSamplesReusable !== false) missing.push('Separate unscored precise-coverage instrumentation is required');
  if (!object(collection) || collection.complete !== true || collection.closingStable !== true
    || collection.requestMethod !== 'cdp-network-get-v1' || collection.evaluationMethod !== 'cdp-precise-coverage-v1'
    || !list(observation?.missing) || observation.missing.length) missing.push('Complete stable GET request and precise-coverage collection is required');
  if (!object(collection) || !list(collection.realmStates) || !collection.realmStates.length) missing.push('Complete page and worker realm lifecycle evidence is required');
  else for (const realm of collection.realmStates) {
    if (!object(realm) || !text(realm.owner) || owners.has(realm.owner) || realm.networkEnabled !== true
      || realm.preciseCoverageEnabled !== true || realm.openingCoverageReset !== true || realm.closingCoverageRead !== true || realm.detached !== false) {
      missing.push('A page or worker realm lacks complete interval collection'); continue;
    }
    owners.add(realm.owner);
  }
  if (!owners.has('page') || !names(collection?.realms, text) || !sameNames([...owners], collection.realms)) missing.push('Observed realm list differs from the complete page and worker lifecycle set');
  const context = build?.roleContext, profile = observation?.browserProfile;
  if (!object(context) || !list(context.workloads) || !context.workloads.includes(observation?.workload)
    || !object(profile) || profile.observed !== true || profile.viewport?.width !== context.viewport?.width
    || profile.viewport?.height !== context.viewport?.height || profile.deviceScaleFactor !== context.deviceScaleFactor
    || !integer(context.viewport?.width) || context.viewport.width < 1 || !integer(context.viewport?.height) || context.viewport.height < 1
    || typeof context.deviceScaleFactor !== 'number' || !Number.isFinite(context.deviceScaleFactor) || context.deviceScaleFactor <= 0) missing.push('Observed browser does not bind the verified workload and display context');
  if (!list(observation?.resources) || !list(observation?.resourceRequests) || !list(observation?.evaluated)
    || requests.length !== resources.length) missing.push('Complete bounded resource, request and execution inventories are required');
  for (const row of executions) {
    const file = object(row) ? files.get(row.file) : null;
    if (!file || file.kind !== 'js' || row.sha256 !== file.sha256 || row.rawBytes !== file.rawBytes
      || !integer(row.executedFunctions) || row.executedFunctions < 1 || typeof row.newlyEvaluated !== 'boolean' || !owners.has(row.owner)) {
      missing.push('Executed module witness differs from its exact emitted identity or complete realm'); continue;
    }
    evaluated.add(row.file); if (row.newlyEvaluated) newlyEvaluated.add(row.file);
  }
  for (const request of requests) {
    if (!object(request) || !integer(request.resourceIndex) || request.resourceIndex >= resources.length || seenIndexes.has(request.resourceIndex)) {
      missing.push('Each GET request must bind one distinct resource index'); continue;
    }
    seenIndexes.add(request.resourceIndex);
    const resource = resources[request.resourceIndex], file = object(resource) ? files.get(resource.file) : null;
    const knownFile = file && resource.sha256 === file.sha256 && resource.rawBytes === file.rawBytes
      && resource.gzipBytes === file.gzipBytes && resource.kind === file.kind && resource.role === role(file);
    const document = object(resource) && resource.file === undefined && resource.role === 'document' && resource.kind === 'other'
      && object(build?.document) && resource.sha256 === build.document.sha256 && resource.rawBytes === build.document.rawBytes && resource.gzipBytes === build.document.gzipBytes;
    const font = object(resource) && resource.file === undefined && resource.role === 'authoring-font' && resource.kind === 'font'
      && validHash(resource.sha256) && integer(resource.rawBytes) && integer(resource.gzipBytes)
      && list(observation?.authoringFontIdentities) && observation.authoringFontIdentities.some(identity => object(identity) && identity.sha256 === resource.sha256 && identity.rawBytes === resource.rawBytes);
    if (!(knownFile || document || font) || request.file !== resource.file || request.sha256 !== resource.sha256
      || request.rawBytes !== resource.rawBytes || request.owner !== resource.owner || !owners.has(request.owner)
      || request.method !== 'GET' || !text(request.resourceType) || !text(request.initiatorType)
      || typeof request.complete !== 'boolean' || typeof request.failed !== 'boolean'
      || typeof request.servedFromCache !== 'boolean' || typeof request.fromDiskCache !== 'boolean' || typeof request.fromServiceWorker !== 'boolean'
      || !(request.status === null || integer(request.status) && request.status >= 100 && request.status <= 599)) {
      missing.push('GET request metadata differs from its exact resource identity or complete realm'); continue;
    }
    if (knownFile) requested.add(resource.file);
    if (request.complete !== true || request.failed !== false || ![200, 304].includes(request.status) || resource.verified !== true
      || request.fromServiceWorker || request.status !== (resource.status ?? null)
      || request.servedFromCache !== resource.servedFromCache || request.fromDiskCache !== resource.fromDiskCache || request.fromServiceWorker !== resource.fromServiceWorker
      || !integer(resource.networkTransferBytes) || !object(resource.timing)
      || !['transferSize', 'encodedBodySize', 'decodedBodySize'].every(key => integer(resource.timing[key]))) missing.push('A GET resource is pending, failed, unverified or lacks exact delivery and timing evidence');
  }
  if (seenIndexes.size !== resources.length) missing.push('Resource request inventory omits or duplicates an observed resource');
  if (!requested.size || !evaluated.size) missing.push('Actual application delivery and execution are absent from this interval');
  return { missing: sorted(missing), requested, evaluated, newlyEvaluated };
}

function resultBase(observation, boundary, kind) {
  return { kind, observationId: text(observation?.id) ? observation.id : null, buildSha256: boundary.buildSha256,
    fixtureSeal: validHash(observation?.fixtureSeal) ? observation.fixtureSeal : null, workload: text(observation?.workload) ? observation.workload : null,
    cache: text(observation?.cache) ? observation.cache : null, collectorSessionId: text(observation?.collectorSessionId) ? observation.collectorSessionId : null,
    documentNavigationId: integer(observation?.documentNavigationId) ? observation.documentNavigationId : null,
    timingSamplesReusable: false, supplemental: true, boundary };
}
function finish(base, missing, failures, observed) {
  return freeze({ ...base, status: failures.length ? 'FAIL' : missing.length ? 'INCONCLUSIVE' : 'PASS',
    missing: sorted(missing), failures: sorted(failures), observed });
}

/** Zero transfer, cache hits, preloads and unsuccessful GET attempts are all
 * observations of a file. None can establish that the feature stayed absent. */
export function analyzeD11FeatureAbsence(observation, build, featureId) {
  const boundary = deriveD11FeatureBoundary(build, featureId), evidence = observationEvidence(observation, build, 'startup-absence', featureId);
  const missing = [...boundary.missing, ...evidence.missing], failures = [];
  const selection = selectD11FeatureBoundaryForAction(build, EXPORT_PUBLIC_ACTION);
  if (!selection.complete || selection.featureId !== featureId) missing.push('Supplemental Export evidence requires the unique replayed Export public-action feature');
  if (observation?.scope !== 'startup' || observation.startedBeforeNavigation !== true) missing.push('Feature absence requires collection before the actual startup navigation');
  if (observation?.publicAction !== undefined) missing.push('Startup absence cannot include a public first-use action');
  const earlyRequestedFiles = boundary.exclusiveFiles.filter(name => evidence.requested.has(name));
  const earlyEvaluatedFiles = boundary.exclusiveFiles.filter(name => evidence.evaluated.has(name));
  if (boundary.complete && observation?.buildSha256 === build?.sha256 && (earlyRequestedFiles.length || earlyEvaluatedFiles.length)) failures.push('A feature-exclusive artifact was requested or evaluated before public first use');
  return finish(resultBase(observation, boundary, 'd11-feature-absence-1'), missing, failures, {
    requestedFiles: sorted(evidence.requested), evaluatedFiles: sorted(evidence.evaluated), earlyRequestedFiles, earlyEvaluatedFiles,
    sharedRequestedFiles: boundary.sharedFiles.filter(name => evidence.requested.has(name)),
    sharedEvaluatedFiles: boundary.sharedFiles.filter(name => evidence.evaluated.has(name)),
  });
}

/** baseline is {observation, artifact:{sha256,...}} for the independently
 * verified retained startup packet. The reference is not a replacement for
 * that packet, its digest verification, or the ordinary D11 analyzer result. */
export function analyzeD11FeatureFirstUse(observation, build, { featureId, baseline } = {}) {
  const boundary = deriveD11FeatureBoundary(build, featureId), evidence = observationEvidence(observation, build, 'first-use', featureId);
  const missing = [...boundary.missing, ...evidence.missing], failures = [];
  const selection = selectD11FeatureBoundaryForAction(build, EXPORT_PUBLIC_ACTION);
  if (!selection.complete || selection.featureId !== featureId) missing.push('Supplemental Export evidence requires the unique replayed Export public-action feature');
  const before = baseline?.observation, prior = analyzeD11FeatureAbsence(before, build, featureId), reference = observation?.baselineReference;
  if (prior.status !== 'PASS') missing.push('A complete independently retained startup absence proof is required');
  if (prior.status === 'FAIL') failures.push('The paired startup observation already requested or evaluated the deferred feature');
  if (observation?.scope !== 'lazy-feature' || observation.featureId !== featureId || observation.baselineComplete !== true) missing.push('First use requires the exact independently observed lazy-feature interval');
  if (observation?.workload !== 'W1' || before?.workload !== 'W1') missing.push('Public feature first use requires the declared paired W1 startup');
  if (!exactKeys(observation?.publicAction, ['kind', 'completed']) || observation.publicAction.kind !== 'export' || observation.publicAction.completed !== true) missing.push('Completed public Export action evidence is required');
  const referenceKeys = ['observationId', 'artifactSha256', 'buildSha256', 'fixtureSeal', 'workload', 'cache', 'collectorSessionId', 'documentNavigationId'];
  if (!object(baseline) || !validHash(baseline.artifact?.sha256) || !exactKeys(reference, referenceKeys)
    || reference.observationId !== before?.id || reference.artifactSha256 !== baseline.artifact.sha256
    || reference.buildSha256 !== build?.sha256 || reference.fixtureSeal !== before?.fixtureSeal
    || reference.workload !== before?.workload || reference.cache !== before?.cache || reference.collectorSessionId !== before?.collectorSessionId
    || reference.documentNavigationId !== before?.documentNavigationId
    || before?.id === observation?.id || ['buildSha256', 'fixtureSeal', 'workload', 'cache', 'collectorSessionId', 'documentNavigationId'].some(key => before?.[key] !== observation?.[key])) missing.push('First use does not bind the same retained startup artifact, build, fixture, workload, cache, collector session and document navigation');
  const gap = observation?.openingGap;
  if (!exactKeys(gap, ['baselineArtifactSha256', 'inventoryUnchanged', 'priorMissing', 'evaluatedExclusiveFiles', 'complete'])
    || gap.baselineArtifactSha256 !== baseline?.artifact?.sha256 || !validHash(gap.baselineArtifactSha256)
    || gap.inventoryUnchanged !== true || gap.complete !== true || !list(gap.priorMissing) || gap.priorMissing.length
    || !names(gap.evaluatedExclusiveFiles) || gap.evaluatedExclusiveFiles.length) missing.push('The retained startup-to-first-use gap lacks complete unchanged request, target and exclusive-execution evidence');
  const start = observation?.actionStart;
  if (!exactKeys(start, ['kind', 'boundary', 'observationId', 'baselineArtifactSha256', 'collectorSessionId', 'documentNavigationId', 'complete'])
    || start.kind !== 'export' || start.boundary !== 'before-public-click-dispatch' || start.complete !== true
    || start.observationId !== observation?.id || start.baselineArtifactSha256 !== baseline?.artifact?.sha256
    || start.collectorSessionId !== observation?.collectorSessionId || start.documentNavigationId !== observation?.documentNavigationId) missing.push('The public click dispatch interval lacks its exact complete opening boundary');
  if (!evidence.newlyEvaluated.has(boundary.entryFile) || !evidence.requested.has(boundary.entryFile)) missing.push('Exact feature entry was not both delivered and newly evaluated in the public click dispatch interval');
  const files = new Map(list(build?.files) ? build.files.map(file => [file?.file, file]) : []);
  const engine = new Set(names(build?.roles?.textEngineFiles) ? build.roles.textEngineFiles : []);
  // The whole static closure remains visible and separately budgeted. An unused
  // @font-face URL need not fetch on first use; require actual JS and CSS, never
  // invent a download for conditional font/image declarations.
  const requiredAfterFiles = boundary.exclusiveFiles.filter(name => !engine.has(name) && ['js', 'css'].includes(files.get(name)?.kind));
  const absentRequiredFiles = requiredAfterFiles.filter(name => !evidence.requested.has(name));
  const unevaluatedRequiredFiles = requiredAfterFiles.filter(name => files.get(name)?.kind === 'js' && !evidence.newlyEvaluated.has(name));
  if (absentRequiredFiles.length || unevaluatedRequiredFiles.length) missing.push('First use lacks actual delivery and execution of its required exclusive JavaScript/CSS closure');
  const allowed = new Set([...boundary.closureFiles, ...boundary.importerFiles, ...(names(build?.roles?.startupFiles) ? build.roles.startupFiles : []), ...engine]);
  const escapedRequestedFiles = sorted([...evidence.requested].filter(name => !allowed.has(name)));
  const escapedEvaluatedFiles = sorted([...evidence.newlyEvaluated].filter(name => !allowed.has(name)));
  if (boundary.complete && observation?.buildSha256 === build?.sha256 && (escapedRequestedFiles.length || escapedEvaluatedFiles.length)) failures.push('Public first use requested or newly evaluated artifacts outside its verified feature, startup and text-engine closures');
  return finish({ ...resultBase(observation, boundary, 'd11-feature-first-use-1'),
    actionInterval: 'before-public-click-dispatch-through-controls-ready',
    orderingScope: 'Recorded unscored dispatch interval; no physical click timestamp or request causality proof',
    baselineObservationId: text(before?.id) ? before.id : null, baselineArtifactSha256: validHash(baseline?.artifact?.sha256) ? baseline.artifact.sha256 : null,
    baselineStatus: prior.status }, missing, failures, {
    requestedFiles: sorted(evidence.requested), evaluatedFiles: sorted(evidence.evaluated), newlyEvaluatedFiles: sorted(evidence.newlyEvaluated),
    requiredAfterFiles, absentRequiredFiles, unevaluatedRequiredFiles, escapedRequestedFiles, escapedEvaluatedFiles,
    sharedRequestedFiles: boundary.sharedFiles.filter(name => evidence.requested.has(name)),
    sharedEvaluatedFiles: boundary.sharedFiles.filter(name => evidence.evaluated.has(name)),
    engineRequestedFiles: boundary.engineFiles.filter(name => evidence.requested.has(name)),
    engineEvaluatedFiles: boundary.engineFiles.filter(name => evidence.evaluated.has(name)),
  });
}

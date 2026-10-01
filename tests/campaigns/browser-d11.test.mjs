import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeD11Observation, d11FontAssets, identifyD11Resource } from '../../tooling/qualification/campaigns/browser-d11.mjs';
import { makeCampaignPlan, REQUIRED_MEASUREMENT_REGISTRY } from '../../tooling/qualification/campaigns/inventory.mjs';

const digest = n => 'sha256:' + String(n).repeat(64);
const artifact = (file, kind, n, rawBytes, gzipBytes, extra = {}) => ({ file, kind, sha256: digest(n), rawBytes, gzipBytes, computedGzipBytes: gzipBytes, modules: [], sources: [], authoringFont: false, ...extra });
const build = () => ({ kind: 'perf-d11-build-1', sha256: digest(9), textWasmHash: digest(4), duplicateVersions: [],
  files: [artifact('assets/main.js', 'js', 1, 2000, 600), artifact('assets/ui.css', 'css', 2, 1000, 300),
    artifact('assets/text-worker.js', 'js', 3, 3000, 700), artifact('assets/text.wasm', 'wasm', 4, 5000, 900),
    artifact('assets/authoring.ttf', 'font', 5, 2000, 1000, { authoringFont: true }), artifact('assets/feature.js', 'js', 6, 1000, 400),
    artifact('assets/ui.woff2', 'font', 7, 500, 520)],
  dynamicFeatures: [{ id: 'src/ui/feature.ts', entryFile: 'assets/feature.js', files: ['assets/feature.js', 'assets/main.js'] }],
  roles: { complete: true, missing: [], startupFiles: ['assets/main.js'], textEngineFiles: ['assets/text-worker.js', 'assets/text.wasm'], lazyFeatures: [{ id: 'src/ui/feature.ts', files: ['assets/feature.js', 'assets/main.js'] }] },
});
const resource = (file, owner = 'page', extra = {}) => ({ id: file.file, ...file, owner,
  role: file.kind === 'font' ? file.authoringFont ? 'authoring-font' : 'ui-font' : file.kind,
  verified: true, networkTransferBytes: file.rawBytes + 300,
  timing: { transferSize: file.rawBytes + 300, encodedBodySize: file.rawBytes, decodedBodySize: file.rawBytes }, ...extra });
const execution = (file, owner = 'page', extra = {}) => ({ file: file.file, sha256: file.sha256, rawBytes: file.rawBytes, owner, executedFunctions: 1, newlyEvaluated: true, ...extra });
const startup = (input = build()) => ({ id: 'cold:1', cache: 'cold', scope: 'startup', startedBeforeNavigation: true, buildSha256: input.sha256,
  collection: { complete: true }, cachePolicy: { httpCacheDisabledByRouting: false }, instrumentation: 'precise-coverage-byte-audit', timingSamplesReusable: false,
  evaluated: [execution(input.files[0])], resources: [resource(input.files[0]), resource(input.files[1]), resource(input.files[6])],
  fonts: { observed: true, status: 'loaded', faces: [] }, missing: [],
});
const value = (result, name) => result.measurements.find(item => item.name === name)?.value;

test('D11 counts actual fetched/evaluated artifacts once and separately keeps wire bytes', () => {
  const b = build(), observation = startup(b);
  observation.evaluated.push(execution(b.files[0]));
  observation.resources.push(resource(b.files[0], 'page', { networkTransferBytes: 0, timing: { transferSize: 0, encodedBodySize: 2000, decodedBodySize: 2000 } }));
  const result = analyzeD11Observation(observation, b);
  assert.equal(result.status, 'PASS');
  assert.equal(value(result, 'D11StartupJsGzipBytes'), 600);
  assert.equal(value(result, 'D11StartupEvaluatedJsBytes'), 2000);
  assert.equal(value(result, 'D11StartupUiCssAndFontsGzipBytes'), 820);
  assert.equal(result.transferred.networkBytes, 4400);
  assert.equal(result.timingSamplesReusable, false);
});

test('a warm refetch remains actual transfer rather than a fabricated zero', () => {
  const b = build(), observation = { ...startup(b), cache: 'warm' };
  observation.resources.forEach(row => { row.cacheControl = 'no-store'; });
  const result = analyzeD11Observation(observation, b);
  assert.equal(result.status, 'PASS'); assert.equal(result.transferred.networkBytes, 4400);
  observation.cachePolicy.httpCacheDisabledByRouting = true;
  assert.equal(analyzeD11Observation(observation, b).status, 'INCONCLUSIVE');
});

test('parsed or unverified resources never establish evaluated raw JS', () => {
  for (const change of [o => { o.evaluated = []; }, o => { o.evaluated[0].executedFunctions = 0; },
    o => { o.evaluated[0].sha256 = digest(8); }, o => { o.resources[0].verified = false; },
    o => { o.resources[0].timing = null; }, o => { o.resources[0].gzipBytes = 1; },
    o => { o.startedBeforeNavigation = false; }, o => { o.collection.complete = false; },
    o => { o.buildSha256 = digest(8); }, o => { o.resources[0].kind = 'other'; }]) {
    const b = build(), observation = startup(b); change(observation);
    assert.equal(analyzeD11Observation(observation, b).status, 'INCONCLUSIVE');
  }
});

test('authoring assets at startup cannot be hidden in a separate font budget', () => {
  const b = build(), observation = startup(b);
  observation.resources.push(resource(b.files[4]));
  const result = analyzeD11Observation(observation, b);
  assert.equal(result.status, 'FAIL'); assert.match(result.failures.join(' '), /eagerly/);
  assert.equal(value(result, 'D11StartupUiCssAndFontsGzipBytes'), 820);
  assert.equal(result.authoringFonts.length, 1);
});

test('text engine requires actual matching worker execution, WASM and authoring font resources', () => {
  const b = build(), observation = { ...startup(b), scope: 'text-engine', evaluated: [execution(b.files[2], 'worker-1')],
    resources: [resource(b.files[2]), resource(b.files[3], 'worker-1'), resource(b.files[4])] };
  const result = analyzeD11Observation(observation, b);
  assert.equal(result.status, 'PASS'); assert.equal(value(result, 'D11TextEngineRawBytes'), 8000);
  assert.equal(value(result, 'D11TextEngineGzipBytes'), 1600);
  observation.evaluated[0].owner = 'page';
  assert.equal(analyzeD11Observation(observation, b).status, 'INCONCLUSIVE');
});

test('lazy feature counts newly evaluated code while shared baseline stays counted once', () => {
  const b = build(), observation = { ...startup(b), scope: 'lazy-feature', featureId: 'src/ui/feature.ts', baselineComplete: true,
    evaluated: [execution(b.files[0], 'page', { newlyEvaluated: false }), execution(b.files[5])], resources: [resource(b.files[5])] };
  const result = analyzeD11Observation(observation, b);
  assert.equal(result.status, 'PASS'); assert.equal(value(result, 'D11LazyFeatureGzipBytes:src/ui/feature.ts'), 400);
  observation.evaluated[1].newlyEvaluated = false;
  assert.equal(analyzeD11Observation(observation, b).status, 'INCONCLUSIVE');
});

test('each emitted duplicate version counts its bytes and exact ceiling violations fail', () => {
  const b = build(), original = b.files[0]; original.rawBytes = 2 * 1048576; original.gzipBytes = original.computedGzipBytes = 600 * 1024;
  const result = analyzeD11Observation(startup(b), b);
  assert.equal(result.status, 'FAIL'); assert.equal(result.failures.length, 2);
});

test('static role ambiguity is exposed independently but cannot establish a lazy-feature pass', () => {
  const b = build(); b.roles = { complete: false, missing: ['Ambiguous startup call boundary'], lazyFeatures: [] };
  const observed = analyzeD11Observation(startup(b), b);
  assert.equal(observed.status, 'PASS'); assert.equal(observed.roleClassification.complete, false);
  assert.deepEqual(observed.roleClassification.missing, b.roles.missing);
  const lazy = { ...startup(b), scope: 'lazy-feature', featureId: 'src/ui/feature.ts', baselineComplete: true,
    evaluated: [execution(b.files[5])], resources: [resource(b.files[5])] };
  assert.equal(analyzeD11Observation(lazy, b).status, 'INCONCLUSIVE');
});

test('resource identities admit only exact same-origin sealed file or known authoring font', () => {
  const b = build(), origin = 'http://127.0.0.1:4000', config = { origin, build: b, fontAssets: { font_1: { sha256: digest(5), rawBytes: 2000 } } };
  assert.equal(identifyD11Resource(origin + '/assets/main.js', config).file, 'assets/main.js');
  assert.equal(identifyD11Resource(origin + '/api/v1/assets/font_1/content', config).role, 'authoring-font');
  for (const url of [origin + '/assets/main.js?secret=value', origin + '/assets/main.js#x', 'https://external.invalid/assets/main.js', origin + '/api/v1/assets/unrecognized/content']) assert.equal(identifyD11Resource(url, config), null);
});

test('native API fonts use actual retained font byte identities instead of extensions', () => {
  const actual = d11FontAssets({ native: { fontAssetIds: ['font_1'], fonts: [{ bytes: { hash: digest(5), byteLength: '2000' } }] } });
  assert.deepEqual({ ...actual }, { font_1: { sha256: digest(5), rawBytes: 2000 } });
  assert.deepEqual({ ...d11FontAssets({ native: { fontAssetIds: ['font_1'], fonts: [{ bytes: { hash: 'bad', byteLength: '2000' } }] } }) }, {});
});

test('the fixed inline server bootstrap counts as delivered and actually evaluated startup JavaScript', () => {
  const b = build(), bootstrap = artifact('inline:bootstrap', 'js', 8, 500, 220);
  b.bootstrap = bootstrap; b.files.push(bootstrap);
  b.roles.startupFiles.push(bootstrap.file);
  b.document = { sha256: digest(0), rawBytes: 1200, gzipBytes: 400 };
  const observation = startup(b); observation.evaluated.push(execution(bootstrap));
  observation.resources.push({ id: 'document:' + b.document.sha256, ...b.document, kind: 'other', role: 'document', owner: 'page', verified: true,
    networkTransferBytes: 1500, timing: { transferSize: 1500, encodedBodySize: 1200, decodedBodySize: 1200 } });
  const result = analyzeD11Observation(observation, b);
  assert.equal(result.status, 'PASS'); assert.equal(value(result, 'D11StartupJsGzipBytes'), 820);
  assert.equal(value(result, 'D11StartupEvaluatedJsBytes'), 2500);
  const identity = identifyD11Resource('http://127.0.0.1:4000/#pairing=' + 'x'.repeat(43), { origin: 'http://127.0.0.1:4000', build: b });
  assert.equal(identity.role, 'document'); assert.equal(JSON.stringify(identity).includes('pairing'), false);
});

test('actual browser profile and executed startup files corroborate the sealed role context', () => {
  const b = build(); b.roleContext = { kind: 'd11-role-context-1', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    boundary: 'document-ready-via-Open', workloads: ['W0', 'W1'], counting: 'union' };
  const observation = startup(b);
  assert.equal(analyzeD11Observation(observation, b).status, 'INCONCLUSIVE');
  observation.browserProfile = { observed: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
  assert.equal(analyzeD11Observation(observation, b).status, 'PASS');
  observation.browserProfile.viewport.width = 1000;
  assert.equal(analyzeD11Observation(observation, b).status, 'INCONCLUSIVE');
  observation.browserProfile.viewport.width = 1440;
  observation.evaluated.push(execution(b.files[5]));
  assert.equal(analyzeD11Observation(observation, b).status, 'FAIL');
});

test('D11 absolute requirements separate runtime audits from the C artifact builds', () => {
  assert.equal(REQUIRED_MEASUREMENT_REGISTRY.D11.length, 10);
  const plan = makeCampaignPlan({ campaign: 'P', features: 'core' });
  for (const cell of plan.cells) {
    const rules = cell.requiredMeasurements.filter(rule => rule.budgetId === 'D11');
    if (cell.host === 'H' && cell.operation === 'navigation.ready' && ['W0', 'W1'].includes(cell.workload)) assert.equal(rules.length, 3);
    else if (cell.host === 'H' && cell.operation === 'text.mixed-ready') assert.equal(rules.length, 2);
    else if (cell.id === 'C2/production-build') assert.equal(rules.length, 5);
    else assert.equal(rules.length, 0);
    assert(rules.every(rule => rule.source === (cell.host === 'H' ? 'separate-byte-audit' : 'artifact-build') && rule.unit === 'bytes'));
  }
});

test('W2 keeps its scored cold-ready starts without acquiring a W0/W1 startup byte requirement', () => {
  const plan = makeCampaignPlan({ campaign: 'Q3', features: 'core', jobs: ['I3'] });
  const cells = plan.cells.filter(cell => cell.operation === 'navigation.ready' && cell.workload === 'W2');
  assert(cells.length > 0);
  for (const cell of cells) {
    assert.equal(cell.cold, 30); assert.equal(cell.warm, 0);
    assert(cell.requiredMeasurements.some(rule => rule.budgetId === 'R05'));
    assert.equal(cell.budgets.includes('D11'), false);
    assert.equal(cell.requiredMeasurements.some(rule => rule.budgetId === 'D11'), false);
    assert.equal(plan.extraAuditCohorts.some(cohort => cohort.cellId === cell.id), false);
  }
});

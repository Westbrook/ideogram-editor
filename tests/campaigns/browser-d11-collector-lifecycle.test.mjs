import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Exercise the real collector's CDP interval state and retained bytes. Only the
// build-loader and supplemental reducer ports are stand-ins. These specimens
// are not browser evidence, role classification, or a qualification result.
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const data = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const origin = 'http://127.0.0.1:4381';
const sources = { 'assets/main.js': 'export const main = 1;', 'assets/feature.js': 'export const feature = 2;' };
const featureId = 'src/ui/fixture-feature.ts';
function build() {
  const files = Object.entries(sources).map(([file, source]) => ({ file, kind: 'js', sha256: sha(source),
    rawBytes: Buffer.byteLength(source), gzipBytes: gzipSync(source).length, computedGzipBytes: gzipSync(source).length,
    modules: [], sources: [], authoringFont: false }));
  return { sha256: sha('collector lifecycle specimen'), files, duplicateVersions: [],
    dynamicFeatures: [{ id: featureId, entryFile: 'assets/feature.js', files: ['assets/feature.js'] }],
    roles: { complete: true, missing: [], startupFiles: ['assets/main.js'], textEngineFiles: [],
      lazyFeatures: [{ id: featureId, files: ['assets/feature.js'], closureFiles: ['assets/feature.js'] }],
      excludedImports: [{ reason: 'verified-private-event-boundary', witness: { kind: 'd11-private-event-import-1', featureSource: featureId } }] } };
}
async function collectorModule() {
  let source = await readFile(new URL('../../tooling/qualification/campaigns/browser-d11.mjs', import.meta.url), 'utf8');
  const replacements = [
    ["import { loadD11Build } from './browser-d11-build.mjs';", `const loadD11Build = async () => (${JSON.stringify(build())});`],
    ["import { deriveD11FeatureBoundary, analyzeD11FeatureAbsence, analyzeD11FeatureFirstUse } from './browser-d11-feature-boundary.mjs';", `
      const deriveD11FeatureBoundary = (_build, featureId) => ({complete:true,missing:[],featureId,exclusiveFiles:['assets/feature.js']});
      const analyzeD11FeatureAbsence = observation => ({status:'PASS',phase:'startup-absence',observationId:observation.id});
      const analyzeD11FeatureFirstUse = (observation, _build, {baseline}) => ({status:baseline?'PASS':'INCONCLUSIVE',phase:'first-use',observationId:observation.id,baselineId:baseline?.observation.id??null});`],
  ];
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, 'replace exactly the declared test port');
    source = source.replace(from, to);
  }
  return import(data(source));
}
class CDP {
  listeners = new Map(); coverage = []; scripts = new Map(); timings = []; navigation = 0; detached = false;
  on(name, callback) { const list = this.listeners.get(name) ?? []; list.push(callback); this.listeners.set(name, list); }
  off(name, callback) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(value => value !== callback)); }
  emit(name, payload) { for (const callback of this.listeners.get(name) ?? []) callback(payload); }
  async send(name, params = {}) {
    if (name === 'Profiler.takePreciseCoverage') return { result: this.coverage.splice(0) };
    if (name === 'Debugger.getScriptSource') return { scriptSource: this.scripts.get(params.scriptId) };
    if (name === 'Network.getResponseBody') return { body: sources[this.requests.get(params.requestId)], base64Encoded: false };
    if (name === 'Runtime.evaluate') return { result: { value: { rows: this.timings, navigation: [],
      overflow: false, unsupported: false, timeOrigin: this.navigation + 1000,
      fonts: { status: 'loaded', faces: [] }, browserProfile: { observed: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } } } };
    return {};
  }
  async detach() { this.detached = true; }
  requests = new Map(); serial = 0;
  navigate() {
    this.navigation++; this.timings = [];
    this.emit('Page.frameNavigated', { frame: { id: 'main' } });
  }
  request(file, { complete = true, failed = false, cached = false, initiatorType = 'script', execute = true } = {}) {
    const requestId = 'request-' + (++this.serial), url = origin + '/' + file;
    this.requests.set(requestId, file);
    this.emit('Network.requestWillBeSent', { requestId, type: 'Script', request: { method: 'GET', url }, initiator: { type: initiatorType } });
    if (failed) this.emit('Network.loadingFailed', { requestId });
    if (complete && !failed) {
      this.emit('Network.responseReceived', { requestId, type: 'Script', response: { url, status: 200, headers: {}, fromDiskCache: cached } });
      if (cached) this.emit('Network.requestServedFromCache', { requestId });
      this.emit('Network.loadingFinished', { requestId, encodedDataLength: cached ? 0 : Buffer.byteLength(sources[file]) + 100 });
      this.timings.push({ name: url, startTime: this.serial, duration: 1, transferSize: cached ? 0 : Buffer.byteLength(sources[file]) + 100,
        encodedBodySize: Buffer.byteLength(sources[file]), decodedBodySize: Buffer.byteLength(sources[file]), responseStatus: 200, deliveryType: cached ? 'cache' : '' });
    }
    if (execute) {
      const scriptId = 'script-' + this.serial; this.scripts.set(scriptId, sources[file]);
      this.emit('Debugger.scriptParsed', { scriptId, url, scriptLanguage: 'JavaScript' });
      this.coverage.push({ scriptId, functions: [{ ranges: [{ count: 1 }] }] });
    }
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'd11-collector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'evidence'); await mkdir(output);
  const lane = new CDP(); let currentURL = 'about:blank';
  const { createBrowserD11Collector } = await collectorModule();
  const collector = await createBrowserD11Collector({ context: { addInitScript: async () => {}, newCDPSession: async () => lane },
    page: { url: () => currentURL }, repo: directory, output, origin, fixture: { seal: { sha256: sha('fixture') } },
    cachePolicy: { httpCacheDisabledByRouting: false } });
  t.after(() => collector.close());
  const navigate = () => { currentURL = origin + '/'; lane.navigate(); };
  const blank = () => { currentURL = 'about:blank'; lane.navigate(); };
  const payload = async result => JSON.parse(await readFile(result.artifact.path, 'utf8'));
  return { collector, lane, navigate, blank, payload };
}
const startupArgs = (id, cache) => ({ id, cache, workload: 'W1', scope: 'startup', byteAudit: true,
  featureBoundary: { featureId, phase: 'startup-absence' } });
const firstUseArgs = (id, cache) => ({ id, cache, workload: 'W1', scope: 'lazy-feature', featureId, byteAudit: true,
  featureBoundary: { featureId, phase: 'first-use' } });

test('collector preserves request starts, cache hits and independent startup/first-use artifact identities', async t => {
  const { collector, lane, navigate, payload } = await fixture(t);
  assert.equal(collector.resolveFeatureBoundary().featureId, featureId);
  await collector.begin(startupArgs('startup:cold:0', 'cold')); navigate();
  lane.request('assets/main.js');
  const before = await collector.snapshot(), rawBefore = await payload(before);
  assert.equal(before.status, 'PASS'); assert.equal(rawBefore.result.featureBoundary, undefined);
  assert.equal(rawBefore.observation.resourceRequests.length, 1);
  assert.deepEqual(rawBefore.observation.collection.realmStates, [{ owner: 'page', networkEnabled: true,
    preciseCoverageEnabled: true, openingCoverageReset: true, closingCoverageRead: true, detached: false }]);
  await collector.begin(firstUseArgs('first:cold:0', 'cold'));
  lane.request('assets/feature.js', { cached: true, initiatorType: 'preload' });
  const after = await collector.snapshot({ publicAction: { kind: 'export', completed: true } }), rawAfter = await payload(after);
  assert.equal(after.status, 'PASS'); assert.equal(after.featureBoundary.baselineId, rawBefore.observation.id);
  assert.equal(rawAfter.observation.baselineReference.artifactSha256, before.artifact.sha256);
  assert.equal(rawAfter.observation.documentNavigationId, rawBefore.observation.documentNavigationId);
  assert.equal(rawAfter.observation.collectorSessionId, rawBefore.observation.collectorSessionId);
  assert.equal(rawAfter.observation.openingGap.complete, true);
  assert.equal(rawAfter.observation.openingGap.baselineArtifactSha256, before.artifact.sha256);
  assert.deepEqual(rawAfter.observation.actionStart, { kind: 'export', boundary: 'before-public-click-dispatch', observationId: 'first:cold:0',
    baselineArtifactSha256: before.artifact.sha256, collectorSessionId: rawBefore.observation.collectorSessionId,
    documentNavigationId: rawBefore.observation.documentNavigationId, complete: true });
  assert.equal(rawAfter.observation.resources[0].networkTransferBytes, 0);
  assert.equal(rawAfter.observation.resourceRequests[0].servedFromCache, true);
  assert.equal(rawAfter.observation.resourceRequests[0].initiatorType, 'preload');
  assert.deepEqual(rawAfter.observation.publicAction, { kind: 'export', completed: true });
});

test('warm new document resets evaluation identity without clearing the shared HTTP cache policy', async t => {
  const { collector, lane, navigate, blank, payload } = await fixture(t);
  for (const [ordinal, cache] of [[0, 'cold'], [1, 'warm']]) {
    await collector.begin(startupArgs('startup:' + cache, cache)); navigate(); lane.request('assets/main.js', { cached: !!ordinal });
    const before = await collector.snapshot();
    await collector.begin(firstUseArgs('first:' + cache, cache)); lane.request('assets/feature.js', { cached: !!ordinal });
    const after = await collector.snapshot({ publicAction: { kind: 'export', completed: true } }), raw = await payload(after);
    assert.equal(raw.observation.evaluated.find(row => row.file === 'assets/feature.js').newlyEvaluated, true);
    assert.equal(raw.observation.baselineReference.artifactSha256, before.artifact.sha256);
    assert.equal(raw.observation.cachePolicy.httpCacheDisabledByRouting, false);
    blank();
  }
});

test('pending and failed known feature GETs remain retained instead of masquerading as absence', async t => {
  for (const failed of [false, true]) {
    const { collector, lane, navigate, payload } = await fixture(t);
    await collector.begin(startupArgs('startup:' + failed, 'cold')); navigate(); lane.request('assets/main.js');
    lane.request('assets/feature.js', { complete: false, failed, execute: false });
    const result = await collector.snapshot(), raw = await payload(result), request = raw.observation.resourceRequests.find(row => row.file === 'assets/feature.js');
    assert.equal(request.complete, false); assert.equal(request.failed, failed); assert.equal(request.status, null);
    assert.equal(raw.observation.collection.complete, false); assert.notEqual(result.status, 'PASS');
    assert.equal(raw.observation.resources.length, raw.observation.resourceRequests.length);
  }
});

test('unmapped pending executable requests and navigation during collection fail closed', async t => {
  const { collector, lane, navigate, payload } = await fixture(t);
  await collector.begin(startupArgs('startup:unknown', 'cold')); navigate(); lane.request('assets/main.js');
  lane.emit('Network.requestWillBeSent', { requestId: 'unmapped', type: 'Script', request: { method: 'GET', url: origin + '/assets/main.js?changed=1' }, initiator: { type: 'script' } });
  const result = await collector.snapshot(), raw = await payload(result);
  assert(raw.observation.missing.includes('Unmapped budgeted resource request started'));
  assert.equal(raw.observation.collection.complete, false);
  await collector.begin(startupArgs('startup:unstable', 'warm')); navigate(); lane.request('assets/main.js');
  const send = lane.send.bind(lane); let changed = false;
  lane.send = async (name, params) => { if (name === 'Debugger.getScriptSource' && !changed) { changed = true; lane.navigate(); } return send(name, params); };
  const unstable = await collector.snapshot(), unstableRaw = await payload(unstable);
  assert.equal(unstableRaw.observation.collection.closingStable, false);
  assert.equal(unstableRaw.observation.collection.complete, false);
});

test('supplemental action witness cannot be attached to a startup scope', async t => {
  const { collector, lane, navigate } = await fixture(t);
  await collector.begin(startupArgs('startup:scope', 'cold')); navigate(); lane.request('assets/main.js');
  await assert.rejects(collector.snapshot({ publicAction: { kind: 'export', completed: true } }), /only to its separate first-use audit/);
});

test('an intervening preload or unsupported target is retained when first-use resets interval counters', async t => {
  for (const gap of ['preload', 'target']) {
    const { collector, lane, navigate, payload } = await fixture(t);
    await collector.begin(startupArgs('startup:' + gap, 'cold')); navigate(); lane.request('assets/main.js');
    const before = await collector.snapshot();
    if (gap === 'preload') lane.request('assets/feature.js', { initiatorType: 'preload', execute: false });
    else lane.emit('Target.attachedToTarget', { sessionId: 'unexpected-target', waitingForDebugger: true, targetInfo: { type: 'iframe' } });
    await collector.begin(firstUseArgs('first:' + gap, 'cold'));
    lane.request('assets/feature.js', { cached: true });
    const after = await collector.snapshot({ publicAction: { kind: 'export', completed: true } }), raw = await payload(after);
    assert.equal(raw.observation.openingGap.complete, false);
    assert.equal(raw.observation.openingGap.baselineArtifactSha256, before.artifact.sha256);
    assert.notEqual(after.status, 'PASS');
    if (gap === 'preload') assert.equal(raw.observation.openingGap.inventoryUnchanged, false);
    else assert(raw.observation.openingGap.priorMissing.includes('Unexpected attached execution target'));
  }
});

test('opening precise coverage retains exclusive execution even when the script inventory was unchanged', async t => {
  const { collector, lane, navigate, payload } = await fixture(t);
  await collector.begin(startupArgs('startup:gap-execution', 'cold')); navigate(); lane.request('assets/main.js');
  // A parsed script alone is deliberately not an evaluation. This isolates the
  // opening coverage witness from request and script-inventory change checks.
  lane.scripts.set('parsed-only', sources['assets/feature.js']);
  lane.emit('Debugger.scriptParsed', { scriptId: 'parsed-only', url: origin + '/assets/feature.js', scriptLanguage: 'JavaScript' });
  await collector.snapshot();
  lane.coverage.push({ scriptId: 'parsed-only', functions: [{ ranges: [{ count: 1 }] }] });
  await collector.begin(firstUseArgs('first:gap-execution', 'cold'));
  lane.request('assets/feature.js', { cached: true });
  const after = await collector.snapshot({ publicAction: { kind: 'export', completed: true } }), raw = await payload(after);
  assert.equal(raw.observation.openingGap.inventoryUnchanged, true);
  assert.deepEqual(raw.observation.openingGap.evaluatedExclusiveFiles, ['assets/feature.js']);
  assert.equal(raw.observation.openingGap.complete, false);
  assert.equal(raw.observation.evaluated.find(row => row.file === 'assets/feature.js').newlyEvaluated, false);
  assert.notEqual(after.status, 'PASS');
});

test('incomplete startup still retains its exact artifact identity without becoming a qualifying baseline', async t => {
  const { collector, lane, navigate, payload } = await fixture(t);
  await collector.begin(startupArgs('startup:incomplete', 'cold')); navigate(); lane.request('assets/main.js', { complete: false });
  const before = await collector.snapshot();
  assert.notEqual(before.status, 'PASS');
  await collector.begin(firstUseArgs('first:incomplete', 'cold')); lane.request('assets/feature.js');
  const after = await collector.snapshot({ publicAction: { kind: 'export', completed: true } }), raw = await payload(after);
  assert.equal(raw.observation.baselineReference.observationId, 'startup:incomplete');
  assert.equal(raw.observation.baselineReference.artifactSha256, before.artifact.sha256);
  assert.equal(raw.observation.baselineComplete, false);
  assert.notEqual(after.status, 'PASS');
});

test('a feature preload arriving during async first-use opening cannot pass as a post-action request', async t => {
  const { collector, lane, navigate, payload } = await fixture(t);
  await collector.begin(startupArgs('startup:during-opening', 'cold')); navigate(); lane.request('assets/main.js');
  await collector.snapshot();
  const send = lane.send.bind(lane); let injected = false;
  lane.send = async (name, params) => {
    if (name === 'Runtime.evaluate' && !injected) {
      injected = true;
      lane.request('assets/feature.js', { cached: true, initiatorType: 'preload', execute: false });
    }
    return send(name, params);
  };
  await collector.begin(firstUseArgs('first:during-opening', 'cold'));
  lane.request('assets/feature.js', { cached: true });
  const after = await collector.snapshot({ publicAction: { kind: 'export', completed: true } }), raw = await payload(after);
  assert.equal(injected, true);
  assert.equal(raw.observation.openingGap.inventoryUnchanged, false);
  assert.equal(raw.observation.openingGap.complete, false);
  assert(raw.observation.missing.includes('Application inventory changed while first-use instrumentation opened'));
  assert.equal(raw.observation.actionStart.complete, false);
  assert.equal(raw.observation.resourceRequests.filter(row => row.file === 'assets/feature.js').length, 2);
  assert.notEqual(after.status, 'PASS');
});

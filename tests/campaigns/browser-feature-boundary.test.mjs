import test from 'node:test';
import assert from 'node:assert/strict';
import { runExportFeatureAudit, splitFeatureBoundarySnapshot } from '../../tooling/qualification/campaigns/browser.mjs';

// Orchestration-only doubles exercise public locator ordering and envelope
// separation. They are not substitutes for a browser or retained byte evidence.
function scenario({ disabled, snapshotFailure = false } = {}) {
  const events = [], core = { kind: 'd11-byte-observation-1', scope: 'lazy-feature', status: 'PASS', missing: [], failures: [], measurements: [{ name: 'feature bytes', value: 7 }], artifact: { path: '/first.json', sha256: 'sha256:' + 'b'.repeat(64), byteLength: '100' } };
  const proof = { kind: 'd11-feature-first-use-1', status: 'PASS', missing: [], failures: [] };
  const page = { getByRole(role, options) {
    assert.equal(options.exact, true); events.push(['locator', role, options.name]);
    return { async waitFor(value) { assert.deepEqual(value, { state: 'visible' }); events.push(['visible', options.name]); },
      async isEnabled() { events.push(['enabled', options.name]); return options.name !== disabled; },
      async click() { events.push(['click', options.name]); } };
  } };
  const collector = { async begin(options) { events.push(['begin', options]); }, async snapshot(options) {
    events.push(['snapshot', options]); if (snapshotFailure) throw Error('snapshot failed'); return { ...core, featureBoundary: proof };
  } };
  const startup = Object.freeze({ scope: 'startup', status: 'PASS', measurements: Object.freeze([{ name: 'startup bytes', value: 12 }]), artifact: Object.freeze({ path: '/startup.json', sha256: 'sha256:' + 'a'.repeat(64), byteLength: '90' }) });
  const input = { page, collector, startup, boundary: { complete: true, featureId: 'exact-source-witness' }, id: 'H1/W1/warm/prime/0', cache: 'warm', workload: 'W1' };
  return { input, events, core, proof };
}

test('public Export first use follows the startup snapshot in a separate same-page scope', async () => {
  const { input, events, core, proof } = scenario(), startupBefore = structuredClone(input.startup);
  const result = await runExportFeatureAudit(input);
  assert.deepEqual(events.slice(0, 3), [['locator', 'button', 'Export image'], ['visible', 'Export image'], ['enabled', 'Export image']]);
  assert.deepEqual(events[3], ['begin', { id: 'H1/W1/warm/prime/0/export-first-use', cache: 'warm', scope: 'lazy-feature', featureId: 'exact-source-witness', workload: 'W1', featureBoundary: { featureId: 'exact-source-witness', phase: 'first-use' }, byteAudit: true }]);
  assert.deepEqual(events[4], ['click', 'Export image'], 'public click immediately follows the collector dispatch boundary');
  assert.deepEqual(events.filter(event => event[0] === 'click'), [['click', 'Export image']]);
  assert.deepEqual(events.filter(event => event[0] === 'enabled').map(event => event[1]), ['Export image', 'Export scope', 'Export format', 'Export dimensions', 'Prepare export preview']);
  assert.deepEqual(events.at(-1), ['snapshot', { publicAction: { kind: 'export', completed: true } }]);
  assert.equal(result.status, 'PASS'); assert.equal(result.timingSamplesReusable, false);
  assert.deepEqual(result.d11, core); assert.deepEqual(result.evidence, proof);
  assert.deepEqual(result.baselineReference, { artifactPath: input.startup.artifact.path, artifactSha256: input.startup.artifact.sha256 });
  assert.deepEqual(input.startup, startupBefore, 'first-use bytes must never replace or mutate startup result');
});

test('W0 and an incomplete source witness cannot trigger positive Export work', async () => {
  for (const change of [value => { value.workload = 'W0'; }, value => { value.boundary.complete = false; }, value => { value.startup = { scope: 'startup' }; }]) {
    const { input, events } = scenario(); change(input);
    await assert.rejects(runExportFeatureAudit(input), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.deepEqual(events, []);
  }
});

test('disabled public controls retain an incomplete action and never claim Export ready', async () => {
  const { input, events } = scenario({ disabled: 'Export dimensions' });
  const result = await runExportFeatureAudit(input);
  assert.equal(result.status, 'FAIL'); assert.equal(result.action.completed, false);
  assert.deepEqual(events.at(-1), ['snapshot', {}]);
  assert(!events.some(event => event[1] === 'Prepare export preview'));
  assert.equal(result.d11.scope, 'lazy-feature');
  assert.equal(input.startup.scope, 'startup');
});

test('trigger eligibility is settled before first-use instrumentation starts', async () => {
  const { input, events } = scenario({ disabled: 'Export image' });
  const result = await runExportFeatureAudit(input);
  assert.equal(result.status, 'FAIL'); assert.equal(result.action.completed, false);
  assert(!events.some(event => ['begin', 'click', 'snapshot'].includes(event[0])));
  assert.equal(result.d11, null);
});

test('a missing positive snapshot leaves the original startup artifact available', async () => {
  const { input } = scenario({ snapshotFailure: true }), original = structuredClone(input.startup);
  const result = await runExportFeatureAudit(input);
  assert.equal(result.status, 'FAIL'); assert.equal(result.d11, null);
  assert.equal(result.baselineReference.artifactSha256, original.artifact.sha256);
  assert.deepEqual(input.startup, original);
});

test('primitive collection failures cannot be mistaken for a completed feature audit', async () => {
  for (const failure of [false, null, undefined, 0, '']) {
    const { input } = scenario();
    input.collector.snapshot = async () => { throw failure; };
    const result = await runExportFeatureAudit(input);
    assert.equal(result.status, 'FAIL'); assert.equal(result.d11, null);
    assert.equal(result.failureClassification.productFailureSeen, true);
  }
});

test('supplemental proofs are separated without changing the core D11 envelope', () => {
  const core = { kind: 'd11-byte-observation-1', measurements: [{ value: 12 }], artifact: { path: '/startup.json' }, evaluatedModuleCount: 2, resourceCount: 3 };
  const snapshot = { ...core, featureBoundary: { status: 'PASS' } }, before = structuredClone(snapshot);
  const split = splitFeatureBoundarySnapshot(snapshot);
  assert.deepEqual(split.d11, core); assert.deepEqual(split.evidence, { status: 'PASS' });
  assert.deepEqual(snapshot, before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_TOOL_NAMES, CAMPAIGN_TOOL_VERSIONS, CAMPAIGN_BROWSER_MANIFEST,
  CAMPAIGN_BROWSER_MANIFEST_IDENTITY, CAMPAIGN_VITALS_SOURCE,
  campaignToolRequirements, validToolIdentity,
} from '../../tooling/qualification/campaigns/identity.mjs';

const sealed = (path = undefined) => ({ ...(path ? { path } : {}), bytes: 256, sha256: `sha256:${'a'.repeat(64)}` });
const plan = (handler = 'backend', operation = 'raster.decode', browser = undefined) => ({ jobs: [{ cells: [{ handler, operation, ...(browser ? { parameters: { browser } } : {}) }] }] });
function completeIdentity() {
  return {
    node: { version: '26.10.0', executable: sealed('/pinned/node') }, lock: sealed(), missing: [],
    tools: CAMPAIGN_TOOL_NAMES.map(name => ({ name, packageName: name, version: CAMPAIGN_TOOL_VERSIONS[name], lockedVersion: CAMPAIGN_TOOL_VERSIONS[name], matchesLock: true, package: sealed(`node_modules/${name}/package.json`) })),
    browserPins: { ...structuredClone(CAMPAIGN_BROWSER_MANIFEST), identity: { ...CAMPAIGN_BROWSER_MANIFEST_IDENTITY } },
    canonicalVitals: {
      name: 'web-vitals', version: CAMPAIGN_VITALS_SOURCE.version, declaredVersion: CAMPAIGN_VITALS_SOURCE.version,
      lockedVersion: CAMPAIGN_VITALS_SOURCE.version, packageIntegrity: CAMPAIGN_VITALS_SOURCE.integrity,
      bytes: CAMPAIGN_VITALS_SOURCE.bytes, sha256: CAMPAIGN_VITALS_SOURCE.sha256.slice(7),
      package: sealed('node_modules/web-vitals/package.json'),
      bundle: { path: 'node_modules/web-vitals/dist/web-vitals.iife.js', bytes: CAMPAIGN_VITALS_SOURCE.bytes, sha256: CAMPAIGN_VITALS_SOURCE.sha256 },
    },
  };
}

test('all selected runtime cells require the exact distinct installed package inventory', () => {
  assert.equal(validToolIdentity(completeIdentity(), plan()), true);
  for (const change of [
    value => value.tools.pop(),
    value => value.tools.push(structuredClone(value.tools[0])),
    value => value.tools[7] = structuredClone(value.tools[0]),
    value => value.tools[7].name = 'different-package',
    value => value.tools = [],
    value => value.missing = ['sharp'],
    value => delete value.missing,
  ]) {
    const value = completeIdentity(); change(value);
    assert.equal(validToolIdentity(value, plan()), false);
  }
  const reordered = completeIdentity(); reordered.tools.reverse();
  assert.equal(validToolIdentity(reordered, plan()), true, 'package ordering is not an identity requirement');
});

test('a claimed empty missing list cannot override wrong package or lock identities', () => {
  for (const change of [
    value => value.tools[0].matchesLock = false,
    value => delete value.tools[0].matchesLock,
    value => value.tools[0].missing = true,
    value => value.tools[0].packageName = 'substitute',
    value => value.tools[0].version = '7.0.1',
    value => value.tools[0].lockedVersion = '7.0.1',
    value => { value.tools[0].version = '7.0.1'; value.tools[0].lockedVersion = '7.0.1'; },
    value => value.tools[0].package.path = 'other/node_modules/typescript/package.json',
    value => value.tools[0].package.sha256 = 'unsealed',
    value => value.tools[0].package.bytes = 0,
    value => value.tools[0].package.bytes = 1.5,
    value => delete value.tools[0].package,
    value => delete value.lock,
    value => value.lock.sha256 = 'sha256:abc',
    value => value.lock.bytes = -1,
  ]) {
    const value = completeIdentity(); change(value);
    assert.equal(validToolIdentity(value, plan()), false);
  }
});

test('developer preparation can start before installation with only the pinned Node identity', () => {
  const value = { node: completeIdentity().node };
  assert.equal(validToolIdentity(value, plan('developer', 'developer.install')), true);
  assert.equal(validToolIdentity(value, plan('backend')), false);
  const mixed = plan('developer'); mixed.jobs[0].cells.push({ handler: 'browser', operation: 'raster.decode' });
  assert.equal(validToolIdentity(value, mixed), false);
});

test('every campaign including preparation requires a sealed absolute pinned Node executable', () => {
  for (const change of [
    value => delete value.node,
    value => value.node.version = '26.9.0',
    value => value.node.executable.path = 'node',
    value => value.node.executable.path = 7,
    value => delete value.node.executable.path,
    value => value.node.executable.sha256 = 'a'.repeat(64),
    value => value.node.executable.bytes = 0,
    value => delete value.node.executable,
  ]) {
    const value = completeIdentity(); change(value);
    assert.equal(validToolIdentity(value, plan()), false);
    assert.equal(validToolIdentity(value, plan('developer')), false);
  }
});

test('browser cells require both exact pinned manifest content and verified artifact identity', () => {
  for (const browser of ['chromium', 'firefox', 'webkit']) assert.equal(validToolIdentity(completeIdentity(), plan('browser', 'raster.decode', browser)), true);
  for (const change of [
    value => delete value.browserPins,
    value => delete value.browserPins.identity,
    value => value.browserPins.identity.path = 'other/browsers.json',
    value => value.browserPins.identity.bytes++,
    value => value.browserPins.identity.sha256 = `sha256:${'b'.repeat(64)}`,
    value => value.browserPins.browsers[0].revision = '1242',
    value => value.browserPins.browsers[3].revisionOverrides.mac14 = '2250',
    value => value.browserPins.browsers.pop(),
    value => value.browserPins.browsers.push({ name: 'other', revision: '1' }),
  ]) {
    const value = completeIdentity(); change(value);
    assert.equal(validToolIdentity(value, plan('browser')), false);
    assert.equal(validToolIdentity(value, plan('backend')), true, 'backend-only execution does not claim a browser');
  }
});

test('canonical browser operations require the official exact observer bytes and package pin', () => {
  for (const operation of ['navigation.ready', 'interaction.brush', 'text.interaction']) {
    assert.equal(validToolIdentity(completeIdentity(), plan('browser', operation)), true);
    for (const change of [
      value => delete value.canonicalVitals,
      value => value.canonicalVitals.missing = true,
      value => value.canonicalVitals.name = 'custom-vitals',
      value => value.canonicalVitals.version = '6.2.1',
      value => value.canonicalVitals.declaredVersion = '^6.2.2',
      value => value.canonicalVitals.lockedVersion = '6.2.1',
      value => value.canonicalVitals.packageIntegrity = 'sha512-substitute',
      value => value.canonicalVitals.sha256 = 'b'.repeat(64),
      value => value.canonicalVitals.bytes++,
      value => value.canonicalVitals.package.path = 'other/package.json',
      value => value.canonicalVitals.package.sha256 = 'unsealed',
      value => value.canonicalVitals.bundle.path = 'node_modules/web-vitals/dist/web-vitals.attribution.iife.js',
      value => value.canonicalVitals.bundle.sha256 = `sha256:${'b'.repeat(64)}`,
      value => value.canonicalVitals.bundle.bytes++,
      value => delete value.canonicalVitals.bundle,
    ]) {
      const value = completeIdentity(); change(value);
      assert.equal(validToolIdentity(value, plan('browser', operation)), false);
      assert.equal(validToolIdentity(value, plan('browser', 'raster.decode')), true, 'unselected observers do not become a qualification prerequisite');
    }
  }
});

test('tool requirements reject empty or malformed plans and unknown execution engines', () => {
  for (const value of [null, {}, { jobs: [] }, { jobs: [null] }, { jobs: [{}] }, { jobs: [{ cells: [] }] }, { jobs: [{ cells: [null] }] }, plan('unknown'), plan('browser', 'raster.decode', 'safari')]) {
    assert.equal(campaignToolRequirements(value), null);
    assert.equal(validToolIdentity(completeIdentity(), value), false);
  }
  const selected = plan('browser', 'navigation.ready', 'webkit');
  selected.jobs.push({ cells: [{ handler: 'browser', operation: 'text.interaction', parameters: { browser: 'webkit' } }, { handler: 'backend', operation: 'text.shape' }] });
  assert.deepEqual(campaignToolRequirements(selected), { developerOnly: false, browsers: ['webkit'], canonicalVitals: true });
});

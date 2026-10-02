// Retained issuer/driver source is data. No capsule module is imported.
// Whole raw manifests remain integrity evidence; fixed finite source templates
// break their dependency on the managed implementation they certify.
import assert from 'node:assert/strict';
import {digest, relativePath} from './files.mjs';
import {heldAlphaSource} from './webp-alpha-producer.mjs';
import {ALPHA_SELECTED, ALPHA_ISSUER_SOURCE, ALPHA_HOST_DRIVER_SOURCE, ALPHA_HOST_PREDECESSOR,
 ALPHA_HOST_V2_PREDECESSOR, ALPHA_ISSUER_VERSION} from './webp-alpha-authority.mjs';
import {ALPHA_BASELINE_TEMPLATE, ALPHA_TEMPLATE_COMMON_OBSERVED_PATHS,
 ALPHA_DRIVER_TEMPLATE, ALPHA_ISSUER_TEMPLATE} from './webp-alpha-template-authority.mjs';
import {normalizeAlphaBaseline, assertAlphaBaselineTemplate} from './webp-alpha-baseline-template.mjs';
import {alphaTemplateIdentity, normalizeAlphaIssuerAuthority, normalizeAlphaSourceManifest} from './webp-alpha-source-template.mjs';

const identity = row => ({bytes: row.bytes, hash: row.hash});
const order = (a, b) => a.repositoryPath < b.repositoryPath ? -1 : a.repositoryPath > b.repositoryPath ? 1 : 0;
function sourceRows(value) {
 assert(Array.isArray(value) && value.length > 0 && value.length < 8192); const seen = new Set();
 for (const row of value) {
  assert.deepEqual(Object.keys(row).sort(), ['bytes', 'hash', 'path']); relativePath(row.path); digest(row.hash);
  assert(row.path !== 'source-manifest.json' && !seen.has(row.path)); seen.add(row.path);
  assert(Number.isSafeInteger(row.bytes) && row.bytes > 0);
 }
 // Exact predecessor/template hashes preserve the reviewed inventory order.
 return value;
}
function manifestReference(value, path) {
 assert.deepEqual(Object.keys(value).sort(), ['bytes', 'hash', 'path']); assert.equal(value.path, path);
 assert(Number.isSafeInteger(value.bytes) && value.bytes > 0); digest(value.hash); return value;
}
function templateIdentity(actual, fixed, label) {
 assert(fixed && Number.isSafeInteger(fixed.bytes) && fixed.bytes > 0 && typeof fixed.hash === 'string', label + ' source template remains pending');
 digest(fixed.hash); assert.deepEqual(identity(actual), identity(fixed), label + ' differs from the exact reviewed source template');
}

export function validateAlphaIssuerBundle({directory, manifest, files}) {
 assert.equal(manifest.issuerVersion, ALPHA_ISSUER_VERSION); assert.equal(manifest.capsuleCompletion, 'required-before-adoption');
 const read = (path, expected) => heldAlphaSource(directory, files, path, expected);
 const json = (path, expected) => { const ref = read(path, expected); return {...ref, value: JSON.parse(ref.data.toString('utf8'))}; };
 const issuer = json('issuer-source-manifest.json', manifestReference(manifest.issuerSource, 'issuer-source-manifest.json'));
 const driver = json('host-driver-source-manifest.json', manifestReference(manifest.hostDriverSource, 'host-driver-source-manifest.json'));
 assert.equal(issuer.value.schemaVersion, 1); assert.equal(issuer.value.kind, 'webp-alpha-issuer-source-v2');
 assert.equal(issuer.value.issuerVersion, ALPHA_ISSUER_VERSION); assert.deepEqual(issuer.value.selectedCandidate, ALPHA_SELECTED);
 assert.equal(driver.value.schemaVersion, 1); assert.equal(driver.value.kind, 'webp-host-campaign-source-v3');
 assert.deepEqual(driver.value.predecessor, ALPHA_HOST_V2_PREDECESSOR);
 const predecessor = json('issuer-inputs/' + ALPHA_HOST_PREDECESSOR.directory + '/source-manifest.json', ALPHA_HOST_PREDECESSOR);
 const priorV2 = json('issuer-inputs/' + ALPHA_HOST_V2_PREDECESSOR.directory + '/source-manifest.json', ALPHA_HOST_V2_PREDECESSOR);
 assert.equal(predecessor.value.schemaVersion, 1); assert.equal(predecessor.value.kind, 'webp-host-campaign-source-v1');
 assert.equal(priorV2.value.schemaVersion, 1); assert.equal(priorV2.value.kind, 'webp-host-campaign-source-v2');
 assert.deepEqual(priorV2.value.predecessor, ALPHA_HOST_PREDECESSOR);
 const groups = [{name: ALPHA_ISSUER_SOURCE.directory, record: issuer},
  {name: ALPHA_HOST_PREDECESSOR.directory, record: predecessor},
  {name: ALPHA_HOST_V2_PREDECESSOR.directory, record: priorV2},
  {name: ALPHA_HOST_DRIVER_SOURCE.directory, record: driver}];
 const expected = [], driverFiles = [], actualByDirectory = new Map();
 for (const {name, record} of groups) {
  const raw = new Map(); actualByDirectory.set(name, raw);
  const rows = [...sourceRows(record.value.files), {path: 'source-manifest.json', ...identity(record)}];
  for (const row of rows) {
   const path = 'issuer-inputs/' + name + '/' + row.path, held = read(path, row); expected.push(path);
   if (row.path !== 'source-manifest.json') raw.set(row.path, identity(held));
   if (name !== ALPHA_ISSUER_SOURCE.directory) driverFiles.push({repositoryPath: name + '/' + row.path, ...identity(held)});
  }
 }
 assert.deepEqual([...files].filter(path => path.startsWith('issuer-inputs/')).sort(), expected.sort(), 'Issuer or driver source membership differs');
 driverFiles.sort(order);
 const readDriver = name => {
  relativePath(name); const repositoryPath = ALPHA_HOST_DRIVER_SOURCE.directory + '/loader/' + name;
  const row = driverFiles.find(item => item.repositoryPath === repositoryPath); assert(row, 'Missing reviewed loader source');
  return read('issuer-inputs/' + repositoryPath, row);
 };
 const baselineHeld = readDriver('baseline.json'), baseline = JSON.parse(baselineHeld.data.toString('utf8'));
 const baselineOptions = {expectedTemplate: ALPHA_BASELINE_TEMPLATE, observedCommonSourcePaths: ALPHA_TEMPLATE_COMMON_OBSERVED_PATHS};
 assertAlphaBaselineTemplate(baseline, baselineOptions);
 const normalizedBaseline = alphaTemplateIdentity(normalizeAlphaBaseline(baseline, baselineOptions));
 const normalizedDriver = alphaTemplateIdentity(normalizeAlphaSourceManifest(driver.value, {
  directory: ALPHA_HOST_DRIVER_SOURCE.directory, rawFiles: actualByDirectory.get(ALPHA_HOST_DRIVER_SOURCE.directory),
  normalizedRows: new Map([['loader/baseline.json', normalizedBaseline]]),
 }));
 templateIdentity(normalizedDriver, ALPHA_DRIVER_TEMPLATE, 'Alpha host driver');
 const issuerRows = actualByDirectory.get(ALPHA_ISSUER_SOURCE.directory);
 const authority = read('issuer-inputs/' + ALPHA_ISSUER_SOURCE.directory + '/authority.mjs', issuerRows.get('authority.mjs'));
 const normalizedAuthority = normalizeAlphaIssuerAuthority(authority.data, driver);
 const normalizedIssuer = alphaTemplateIdentity(normalizeAlphaSourceManifest(issuer.value, {
  directory: ALPHA_ISSUER_SOURCE.directory, rawFiles: issuerRows,
  normalizedRows: new Map([['authority.mjs', normalizedAuthority]]), driverIdentity: driver, normalizedDriverIdentity: normalizedDriver,
 }));
 templateIdentity(normalizedIssuer, ALPHA_ISSUER_TEMPLATE, 'Alpha issuer');
 return {issuer, driver, predecessor, priorV2, driverFiles, readDriver};
}

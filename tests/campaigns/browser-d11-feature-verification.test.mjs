import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { verifyD11FeatureAuditAttempt } from '../../tooling/qualification/campaigns/browser-d11-feature-verification.mjs';
import { analyzeD11FeatureAbsence, analyzeD11FeatureFirstUse } from '../../tooling/qualification/campaigns/browser-d11-feature-boundary.mjs';
import { d11Hash as hash, d11Specimen as specimen, refreshD11Specimen as refresh, initializeD11Specimen } from './support/d11-specimen.mjs';

before(initializeD11Specimen);

// This is a retained-packet integrity specimen, not a private-event proof or a
// real browser visit. Its missing new role/collection evidence stays explicitly
// INCONCLUSIVE after all packet and cross-observation identities verify.
function fixture({ workload = 'W1', cache = 'cold', prime = false } = {}) {
  const cell = { id: 'H/navigation-' + workload, operation: 'navigation.ready', workload };
  const attempt = { id: `${cell.id}/${cache}/${prime ? 'prime' : 'scored'}/1`, ordinal: 1, cache, prime, status: 'INCONCLUSIVE', result: {} };
  const output = '/retained/d11-feature-group', files = new Map(), startup = specimen();
  const featureId = 'src/ui/feature.ts';
  Object.assign(startup.payload.observation, { id: attempt.id, cache, workload,
    collectorSessionId: '00000000-0000-4000-8000-000000000001', documentNavigationId: 1,
    featureBoundary: { featureId, phase: 'startup-absence' } });
  const retain = (state, path) => {
    refresh(state);
    const bytes = Buffer.from(JSON.stringify(state.payload)); files.set(path, bytes);
    const artifact = { path: output + '/' + path, sha256: hash(bytes), byteLength: String(bytes.length) };
    return { ...state.returnedD11, artifact };
  };
  attempt.result.d11 = retain(startup, 'startup.json');
  attempt.result.featureAbsence = analyzeD11FeatureAbsence(startup.payload.observation, startup.payload.build, featureId);
  attempt.result.featureAudits = [];
  let after;
  if (workload === 'W1') {
    after = structuredClone(startup);
    const beforeObservation = startup.payload.observation, artifact = attempt.result.d11.artifact;
    Object.assign(after.payload.observation, { id: attempt.id + '/export-first-use', scope: 'lazy-feature', featureId, baselineComplete: true,
      featureBoundary: { featureId, phase: 'first-use' }, publicAction: { kind: 'export', completed: true },
      baselineReference: { observationId: beforeObservation.id, artifactSha256: artifact.sha256,
        buildSha256: startup.payload.build.sha256, fixtureSeal: beforeObservation.fixtureSeal, workload, cache,
        collectorSessionId: beforeObservation.collectorSessionId, documentNavigationId: beforeObservation.documentNavigationId } });
    attempt.result.featureAudits.push({ action: { kind: 'export', completed: true },
      d11: retain(after, 'first-use.json'), evidence: analyzeD11FeatureFirstUse(after.payload.observation, after.payload.build,
        { featureId, baseline: { observation: beforeObservation, artifact } }),
      baselineReference: { artifactPath: artifact.path, artifactSha256: artifact.sha256 },
      status: 'INCONCLUSIVE', timingSamplesReusable: false, missing: ['Integrity specimen has no private-event witness'], error: null });
  }
  const options = { cell, attempt, output, actionsPerStart: ['navigation.ready', 'export.startup-absence', ...(workload === 'W1' ? ['export.first-use-ready'] : [])],
    ...startup.options, readBytes: async path => { assert(files.has(path), 'Unexpected artifact read'); return files.get(path); } };
  return { options, files, startup, after, retain };
}
const verify = value => verifyD11FeatureAuditAttempt(value.options);

test('supplemental replay retains complete original packets without promoting missing semantic proof', async () => {
  for (const workload of ['W0', 'W1']) {
    const value = fixture({ workload }), result = await verify(value);
    assert.equal(result.verified, true);
    assert.equal(result.absence.status, 'INCONCLUSIVE');
    assert.equal(result.firstUse.length, workload === 'W1' ? 1 : 0);
    if (workload === 'W1') assert.equal(result.firstUse[0].status, 'INCONCLUSIVE');
  }
});

test('warm primes and scored starts retain distinct exact raw observation identities', async () => {
  for (const prime of [true, false]) {
    const value = fixture({ cache: 'warm', prime });
    await verify(value);
    value.options.attempt.prime = !prime;
    await assert.rejects(verify(value), /immutable schedule/);
  }
});

test('declared supplemental actions cannot be omitted, reordered or attached to another cell', async () => {
  for (const change of [
    value => { value.options.actionsPerStart.pop(); },
    value => { value.options.actionsPerStart.reverse(); },
    value => { value.options.cell.operation = 'text.mixed-ready'; },
    value => { value.options.cell.workload = 'W2'; },
  ]) {
    const value = fixture(); change(value);
    await assert.rejects(verify(value), /immutable cell|declared startup cells/);
  }
});

test('each raw audit rehashes the original retained bytes before trusting its result', async () => {
  for (const path of ['startup.json', 'first-use.json']) {
    const value = fixture(); value.files.set(path, Buffer.concat([value.files.get(path), Buffer.from('\n')]));
    await assert.rejects(verify(value), /exact retained bytes/);
  }
  const value = fixture(); value.options.attempt.result.featureAudits[0].d11.resourceCount++;
  await assert.rejects(verify(value), /observation counts differ/);
});

test('original raw artifacts cannot escape their group or reuse the startup file', async () => {
  const escaped = fixture();
  escaped.options.attempt.result.featureAudits[0].d11.artifact.path = '/retained/another-group/first-use.json';
  await assert.rejects(verify(escaped), /remain in its original group/);
  const reused = fixture();
  reused.options.attempt.result.featureAudits[0].d11.artifact = { ...reused.options.attempt.result.d11.artifact };
  await assert.rejects(verify(reused), /paths are noncanonical or duplicated/);
});

test('each raw build and observation must still reproduce against independent receipts', async () => {
  const value = fixture();
  value.after.payload.build.roles.startupFiles.push('assets/feature.js');
  value.options.attempt.result.featureAudits[0].d11 = value.retain(value.after, 'first-use.json');
  await assert.rejects(verify(value), /roles differ/);
});

test('supplemental absence and first-use summaries cannot be self-promoted to PASS', async () => {
  for (const key of ['absence', 'first-use']) {
    const value = fixture();
    const evidence = key === 'absence' ? value.options.attempt.result.featureAbsence : value.options.attempt.result.featureAudits[0].evidence;
    const forged = { ...evidence, status: 'PASS', missing: [] };
    if (key === 'absence') value.options.attempt.result.featureAbsence = forged;
    else value.options.attempt.result.featureAudits[0].evidence = forged;
    await assert.rejects(verify(value), /differs from raw replay/);
  }
});

test('a separate first-use packet binds the original startup artifact hash and path', async () => {
  for (const change of [
    reference => { reference.artifactSha256 = hash('unrelated startup'); },
    reference => { reference.artifactPath += '.different'; },
  ]) {
    const value = fixture(); change(value.options.attempt.result.featureAudits[0].baselineReference);
    await assert.rejects(verify(value), /outer reference differs/);
  }
});

test('resealed first-use raw references cannot move to another startup or navigation', async () => {
  for (const key of ['artifactSha256', 'observationId', 'collectorSessionId', 'documentNavigationId']) {
    const value = fixture();
    value.after.payload.observation.baselineReference[key] = key === 'documentNavigationId' ? 2 : hash('another ' + key);
    value.options.attempt.result.featureAudits[0].d11 = value.retain(value.after, 'first-use.json');
    await assert.rejects(verify(value), /raw reference differs/);
  }
  const value = fixture(); value.after.payload.observation.documentNavigationId++;
  value.options.attempt.result.featureAudits[0].d11 = value.retain(value.after, 'first-use.json');
  await assert.rejects(verify(value), /changed its startup documentNavigationId/);
});

test('passing attempts require the declared supplements and forbid duplicate first-use packets', async () => {
  const absent = fixture(); absent.options.attempt.status = 'PASS'; absent.options.attempt.result.featureAbsence = null;
  await assert.rejects(verify(absent), /feature absence differs from raw replay/);
  const omitted = fixture(); omitted.options.attempt.status = 'PASS'; omitted.options.attempt.result.featureAudits = [];
  await assert.rejects(verify(omitted), /lacks its declared public feature first use/);
  const duplicated = fixture(); duplicated.options.attempt.result.featureAudits.push(duplicated.options.attempt.result.featureAudits[0]);
  await assert.rejects(verify(duplicated), /missing or duplicated/);
});

test('nonpassing attempts cannot suppress a raw supplemental result into missing evidence', async () => {
  const absent = fixture(); absent.options.attempt.result.featureAbsence = null;
  await assert.rejects(verify(absent), /feature absence differs from raw replay/);
  const missing = fixture(); missing.options.attempt.result.featureAudits[0].evidence = null;
  await assert.rejects(verify(missing), /feature first-use evidence differs from raw replay/);
});

test('failed capture can retain explicit unavailable evidence without claiming a raw snapshot', async () => {
  const value = fixture(), audit = value.options.attempt.result.featureAudits[0];
  Object.assign(audit, { d11: null, evidence: null, status: 'FAIL', missing: ['Snapshot failed'] });
  assert.deepEqual((await verify(value)).firstUse, [null]);
  audit.status = 'PASS';
  await assert.rejects(verify(value), /cannot claim completed byte evidence/);
});

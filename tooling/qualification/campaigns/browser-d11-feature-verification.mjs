import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { byteAuditFeatureActions } from './byte-audits.mjs';
import { verifyD11RetainedObservation } from './browser-d11-verification.mjs';
import { analyzeD11FeatureAbsence, analyzeD11FeatureFirstUse } from './browser-d11-feature-boundary.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (actual, expected, message) => { if (!isDeepStrictEqual(actual, expected)) throw Error(message); };
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** Replay supplemental H evidence from the original complete audit packets.
 * readBytes reads group-relative, independently sealed artifact bytes. No
 * mutable source, build, cache or browser path is opened by this verifier.
 * The ordinary cohort evaluator owns the immutable full schedule and counts;
 * this joins each planned startup with its own public first-use observation. */
export async function verifyD11FeatureAuditAttempt({ cell, attempt, actionsPerStart, output,
  buildFiles, sourceFiles, fixtureSeal, readBytes } = {}) {
  if (!object(cell) || !object(attempt) || !object(attempt.result) || typeof readBytes !== 'function'
    || typeof output !== 'string' || !isAbsolute(output) || resolve(output) !== output) throw Error('Invalid retained D11 feature audit context');
  const expectedActions = byteAuditFeatureActions(cell);
  equal(actionsPerStart, [cell.operation, ...expectedActions], 'D11 feature actions differ from the immutable cell');
  if (!expectedActions.length) throw Error('D11 feature evidence belongs only to the declared startup cells');
  if (!['cold', 'warm'].includes(attempt.cache) || typeof attempt.prime !== 'boolean'
    || !Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1) throw Error('Invalid retained D11 feature attempt identity');
  const expectedId = `${cell.id}/${attempt.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`;
  if (attempt.id !== expectedId) throw Error('D11 feature attempt differs from the immutable schedule');
  const options = { buildFiles, sourceFiles, fixtureSeal }, used = new Set();
  async function packet(returned, id, scope) {
    const artifact = returned?.artifact;
    if (!object(artifact) || typeof artifact.path !== 'string' || !isAbsolute(artifact.path)
      || resolve(artifact.path) !== artifact.path || !artifact.path.startsWith(output + sep)) throw Error('D11 feature artifact must remain in its original group');
    const path = relative(output, artifact.path).split(sep).join('/');
    if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || used.has(path)) throw Error('D11 feature artifact paths are noncanonical or duplicated');
    used.add(path);
    const bytes = await readBytes(path);
    if (!Buffer.isBuffer(bytes) || bytes.length > 256 * 1024 * 1024 || artifact.sha256 !== hash(bytes)
      || artifact.byteLength !== String(bytes.length)) throw Error('D11 feature artifact differs from its exact retained bytes');
    let payload;
    try {
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw Error('Invalid UTF-8');
      payload = JSON.parse(text);
    } catch { throw Error('D11 feature artifact is not retained UTF-8 JSON'); }
    verifyD11RetainedObservation(payload, returned, options);
    const observation = payload.observation;
    if (observation.id !== id || observation.scope !== scope || observation.workload !== cell.workload
      || observation.cache !== attempt.cache) throw Error('D11 raw feature observation differs from the immutable attempt');
    return { payload, artifact };
  }
  const startup = await packet(attempt.result.d11, expectedId, 'startup');
  const before = startup.payload.observation, build = startup.payload.build;
  const featureId = before.featureBoundary?.featureId;
  const absence = analyzeD11FeatureAbsence(before, build, featureId);
  equal(attempt.result.featureAbsence, absence, 'D11 retained feature absence differs from raw replay');
  const audits = attempt.result.featureAudits;
  if (!Array.isArray(audits) || audits.length > 1) throw Error('D11 first-use audit inventory is missing or duplicated');
  if (cell.workload === 'W0' && audits.length) throw Error('W0 has no declared public feature first-use action');
  if (cell.workload === 'W1' && attempt.status === 'PASS' && audits.length !== 1) throw Error('Passing W1 startup lacks its declared public feature first use');
  const firstUse = [];
  for (const audit of audits) {
    if (!object(audit) || audit.timingSamplesReusable !== false || !object(audit.action)
      || !isDeepStrictEqual(Object.keys(audit.action).sort(), ['completed', 'kind'])
      || audit.action.kind !== 'export' || typeof audit.action.completed !== 'boolean') throw Error('D11 first use lacks the declared public action');
    equal(audit.baselineReference, { artifactPath: startup.artifact.path, artifactSha256: startup.artifact.sha256 }, 'D11 first-use outer reference differs from its exact startup artifact');
    if (audit.d11 == null) {
      if (!['FAIL', 'INCONCLUSIVE'].includes(audit.status) || audit.evidence != null || !Array.isArray(audit.missing) || !audit.missing.length)
        throw Error('Unavailable D11 first-use snapshot cannot claim completed byte evidence');
      firstUse.push(null); continue;
    }
    const after = await packet(audit.d11, expectedId + '/export-first-use', 'lazy-feature');
    if (after.payload.build.sha256 !== build.sha256) throw Error('D11 first use uses a different finalized build or role witness');
    const observation = after.payload.observation;
    equal(observation.baselineReference, { observationId: before.id, artifactSha256: startup.artifact.sha256,
      buildSha256: build.sha256, fixtureSeal: before.fixtureSeal, workload: before.workload, cache: before.cache,
      collectorSessionId: before.collectorSessionId, documentNavigationId: before.documentNavigationId },
    'D11 first-use raw reference differs from its exact startup artifact and session');
    for (const key of ['buildSha256', 'fixtureSeal', 'workload', 'cache', 'collectorSessionId', 'documentNavigationId'])
      equal(observation[key], before[key], 'D11 first use changed its startup ' + key);
    if (observation.featureBoundary?.featureId !== featureId || observation.featureId !== featureId) throw Error('D11 first use changed its witnessed feature identity');
    if (audit.action.completed) equal(observation.publicAction, audit.action, 'D11 completed public action differs from retained observation');
    else if (observation.publicAction !== undefined) throw Error('Incomplete D11 public action cannot claim completed raw action evidence');
    const evidence = analyzeD11FeatureFirstUse(observation, build, { featureId,
      baseline: { observation: before, artifact: startup.artifact } });
    equal(audit.evidence, evidence, 'D11 retained feature first-use evidence differs from raw replay');
    firstUse.push(evidence);
  }
  return { verified: true, supplemental: true, buildSha256: build.sha256, absence, firstUse };
}

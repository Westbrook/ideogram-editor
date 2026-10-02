import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const validHash = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const equal = isDeepStrictEqual;

/** Counter rows carry retained comparison inputs and the actual immutable
 * lifecycle binding. Unknown browser/transport counters produce no row. */
export async function retainAdapterCycleMeasurements({ output, cell, cycle, processIdentity, fixtureIdentity, specimen, imported, closure, ownedLookup, browserWA, phases }) {
  const planned = cell?.operation === 'adapter.lifecycle' && cell?.workload === 'WA' && cell?.kind === 'lifecycle'
    && (cell.host === 'C' && cell.handler === 'adapters' && /^(AC2|I8C)\/WA-lifecycle$/.test(cell.id)
      || cell.host === 'H' && cell.handler === 'browser' && /^(AH2|I8H)\/WA-lifecycle$/.test(cell.id));
  if (!planned || !specimen || !imported?.binding?.eligible || !validHash(fixtureIdentity)
    || typeof processIdentity !== 'string' || !processIdentity
    || !Number.isInteger(cycle) || cycle < 1
    || !Array.isArray(phases) || phases.length !== 5 || !phases.every((phase, index) => phase.name === ['import', 'select', 'unselect', 'close', 'release'][index] && phase.outcome === 'expected'
      && Number.isFinite(phase.startMs) && phase.startMs >= 0 && Number.isFinite(phase.endMs) && phase.endMs >= phase.startMs && (!index || phase.startMs >= phases[index - 1].endMs))) return [];
  const binding = imported.binding.binding;
  const expected = { versionId: imported.asset.id, weights: { hash: specimen.weights.hash, byteLength: String(specimen.weights.bytes), mediaType: specimen.weights.mediaType },
    config: { hash: specimen.config.hash, byteLength: String(specimen.config.bytes), mediaType: specimen.config.mediaType } };
  assert.equal(binding.versionId, expected.versionId); assert.deepEqual(binding.weights, expected.weights); assert.deepEqual(binding.config, expected.config);
  assert.equal(imported.view.versionId, expected.versionId); assert.deepEqual(imported.view.weights, expected.weights); assert.deepEqual(imported.view.config, expected.config);
  const comparisons = { expected, observed: { versionId: imported.view.versionId, weights: imported.view.weights, config: imported.view.config },
    productionProfile: { id: binding.profileId, locallyEligible: binding.locallyEligible, runtimeVerified: binding.runtimeVerified }, descriptorIdentity: specimen.descriptorIdentity };
  const rows = [{ name: 'T05IncompleteOrUnverifiedIdentityAcceptanceCount', value: 0, unit: 'violations',
    method: 'Full sealed file hashes, exact returned production registration/view references, and supported-profile binding were compared for the actual import.' }];
  if (closure?.fixtureSha256 !== undefined && closure.fixtureSha256 !== null) assert.equal(closure.fixtureSha256, fixtureIdentity, 'Durability proof belongs to a different sealed fixture');
  const retainedImport = closure?.importedAssetBindings?.find(item => item.id === expected.versionId);
  const retainedRefsMatch = retainedImport && validHash(retainedImport.metadataSha256) && [expected.weights, expected.config].every(ref => retainedImport.refs?.some(item => item.hash === ref.hash && item.byteLength === ref.byteLength));
  if (retainedImport && closure.complete === true) assert(retainedRefsMatch, 'Retained import proof differs from the exact weights/config');
  if (closure?.fixtureSha256 === fixtureIdentity && closure?.complete === true && closure.assertions?.durableFixturePreserved === true
    && validHash(closure.importedBindingsSha256) && retainedRefsMatch && typeof closure.artifact?.path === 'string'
    && Number.isSafeInteger(closure.artifact.bytes) && closure.artifact.bytes > 0 && validHash(closure.artifact.sha256)) {
    rows.push({ name: 'T06ArtifactHashOrDurabilityMismatchCount', value: 0, unit: 'violations', method: 'The retained oracle rehashed every baseline object/corpus file and imported typed dependency, compared catalog/metadata identities, and retained its complete proof.' });
  }
  if (cell.host === 'C' && ownedLookup?.before && ownedLookup?.after && ownedLookup?.expected && ownedLookup?.observed) {
    assert.deepEqual(ownedLookup.expected, imported.view, 'Owned lookup baseline must be the actual imported immutable version');
    const keys = Object.keys(ownedLookup.before);
    const counterKeys = ['submit', 'upload', 'poll', 'cancel', 'fetch', 'socket', 'dns', 'datagram'].sort();
    const complete = equal([...keys].sort(), counterKeys) && equal(counterKeys, Object.keys(ownedLookup.after).sort())
      && keys.every(key => Number.isSafeInteger(ownedLookup.before[key]) && ownedLookup.before[key] >= 0 && Number.isSafeInteger(ownedLookup.after[key]) && ownedLookup.after[key] >= ownedLookup.before[key])
      && Number.isSafeInteger(keys.reduce((sum, key) => sum + ownedLookup.after[key] - ownedLookup.before[key], 0));
    if (complete) {
      // Guards count real attempted network effects, including the writer. Do
      // not label bytes or adapter metadata lookups as network transfer work.
      const delta = keys.reduce((sum, key) => sum + ownedLookup.after[key] - ownedLookup.before[key], 0);
      for (const name of ['T06UnchangedOwnedAssetFetches', 'R32UnchangedOwnedAssetFetches']) rows.push({ name, value: delta, unit: 'count', method: 'Attempted guarded network effects during a separate repeated exact-owned adapter metadata lookup; all eight shared main/worker deny counters are unchanged for a complete zero-fetch observation.' });
      rows.push({ name: 'R32CacheIdentityMismatchCount', value: equal(ownedLookup.expected, ownedLookup.observed) ? 0 : 1, unit: 'violations', method: 'Repeated actual owned metadata lookup compared the entire immutable library entry with the first returned version.' });
    }
  }
  if (cell.host === 'H' && browserWA?.kind === 'retained-wa-browser-observation-1') {
    for (const row of browserWA.analysis?.measurements ?? []) {
      if (!['T06UnchangedOwnedAssetFetches','R32UnchangedOwnedAssetFetches','R32CacheIdentityMismatchCount'].includes(row.name)
        || !Number.isSafeInteger(row.value) || row.value < 0 || row.complete !== true && row.value === 0) continue;
      rows.push({...row, method: 'Retained actual browser request/proxy/upload/guard observations around the exact owned-version metadata lookup; expected loopback control traffic is classified separately from asset payload requests.'});
    }
  }
  const packet = { kind: 'wa-cycle-measurement-proof-1', cellId: cell.id, cycleOrdinal: cycle, processIdentity, fixtureIdentity,
    comparisons, closure, ownedLookup: ownedLookup ?? null, measurements: rows, tensorDecodeObservation: browserWA ?? null };
  const bytes = Buffer.from(JSON.stringify(packet, null, 2) + '\n'), path = join(output, 'wa-cycle-' + cycle + '-measurement-proof.json');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  const evidence = { kind: 'lifecycle-measurement-evidence-1', cellId: cell.id, cycleOrdinal: cycle, processIdentity, fixtureIdentity,
    coverage: 'complete-cycle-actions', artifact: { path, bytes: bytes.length, sha256: hash(bytes) } };
  return rows.map(row => ({ ...row, complete: row.complete ?? true, evidence: {...evidence, ...(row.complete === false ? {coverage: 'observed-partial-cycle-actions'} : {})} }));
}

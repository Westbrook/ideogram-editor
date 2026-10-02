// Pure receipt validation. Used by issuance and focused refusal tests.
import assert from 'node:assert/strict';
export const COUNT_KEYS = ['completedCaseCount', 'completedDecodeCount', 'completedPixelComparisonCount', 'comparedPixelCount'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export function validateAllocatorGate(receipt, candidate) {
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.kind, 'webp-advanced-allocator-probe-v2');
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.completedHarnessCount, 1);
  assert.equal(receipt.exitCode, 0); assert.equal(receipt.signal, null); assert.equal(receipt.error, '');
  assert.equal(receipt.stdout.trim(), 'advanced WebP allocator and admission invariants passed');
  assert.equal(receipt.harnessHash, candidate.allocatorHarness.hash);
}
export function validateNativeGate(receipt, phase, candidateHash, candidate) {
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.kind, 'webp-advanced-native-probe-v2');
  assert.equal(receipt.status, 'passed-probe'); assert.equal(receipt.phase, phase);
  assert.equal(receipt.candidateHash, candidateHash); assert.equal(receipt.artifactHash, candidate.artifact.hash);
  assert.equal(receipt.oracleHash, candidate.oracle.hash);
  assert.equal(receipt.completedLoadOrderCount, 2);
  assert.deepEqual(receipt.loadOrders.map(row => row.order), ['oracle-first', 'advanced-first']);
  assert(positive(receipt.fixtureCount));
  const totals = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
  let firstCases;
  for (const row of receipt.loadOrders) {
    assert.equal(row.exitCode, 0); assert(hash(row.receiptHash));
    const child = row.summary;
    assert.equal(child.schemaVersion, 2); assert.equal(child.kind, 'webp-advanced-native-child-v2');
    assert.equal(child.status, 'passed-probe'); assert.equal(child.phase, phase); assert.equal(child.order, row.order);
    for (const key of ['candidateHash', 'artifactHash', 'oracleHash', 'fixtureManifestHash']) assert.equal(child[key], receipt[key]);
    assert.deepEqual(child.haloRule, receipt.haloRule);
    assert(Array.isArray(child.cases) && child.cases.length === receipt.fixtureCount);
    const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
    for (const item of child.cases) {
      assert(typeof item.path === 'string' && item.path.length > 0);
      assert.equal(item.status, 'passed-case'); assert(hash(item.encodedHash));
      assert(Array.isArray(item.dimensions) && item.dimensions.length === 2 && item.dimensions.every(positive));
      assert(positive(item.plannedRegionCount));
      if (phase === 'smoke') assert.equal(item.plannedRegionCount, 1);
      assert.equal(item.completedDecodeCount, item.plannedRegionCount);
      assert.equal(item.completedPixelComparisonCount, item.plannedRegionCount);
      assert(positive(item.comparedPixelCount) && item.comparedPixelCount >= item.completedPixelComparisonCount);
      counts.completedCaseCount++; counts.completedDecodeCount += item.completedDecodeCount;
      counts.completedPixelComparisonCount += item.completedPixelComparisonCount; counts.comparedPixelCount += item.comparedPixelCount;
    }
    assert.deepEqual(child.counts, counts); assert(COUNT_KEYS.every(key => positive(counts[key])));
    // Both load orders must complete the same fixture and planned-region set.
    if (firstCases) assert.deepEqual(child.cases, firstCases); else firstCases = child.cases;
    for (const key of COUNT_KEYS) totals[key] += counts[key];
  }
  assert.deepEqual(receipt.counts, totals); assert(COUNT_KEYS.every(key => positive(totals[key])));
  if (phase === 'smoke') assert.equal(receipt.haloRule, null);
  else { assert(receipt.haloRule && typeof receipt.haloRule === 'object'); assert(hash(receipt.fixtureManifestHash)); }
}

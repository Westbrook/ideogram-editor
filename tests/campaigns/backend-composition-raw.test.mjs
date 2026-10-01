import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawEnvelopeChunks, runCell } from '../../tooling/qualification/campaigns/backend-composition.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
for (const [id, bytes] of [['RAW16M', 16777216], ['RAW16M_PLUS1', 16777217]]) test(`${id} streamed candidate provenance is rooted and survives restart`, async t => {
  const output = await mkdtemp(join(tmpdir(), 'ideogram-raw-campaign-')); t.after(() => rm(output, { recursive: true, force: true }));
  const path = join(output, id + '.json'), file = await open(path, 'wx', 0o600), digest = createHash('sha256'); let byteLength = 0;
  try { for (const chunk of rawEnvelopeChunks(bytes)) { await file.write(chunk); digest.update(chunk); byteLength += chunk.length; } await file.sync(); } finally { await file.close(); }
  const result = await runCell({ repo, output, fixture: { corpus: { files: [{ id, path, sha256: 'sha256:' + digest.digest('hex'), byteLength }] } } }, { operation: id });
  assert.equal(result.status, 'pass', JSON.stringify(result)); assert.deepEqual(result.missing, []);
  assert(result.assertions.every(assertion => assertion.passed)); assert.equal(result.observations.promptBytes, bytes);
  assert.equal(result.observations.inspection, 'opaque'); assert.equal(result.observations.providerEffects, globalThis.__storeNetworkCounters ? 0 : null);
  assert.equal(result.observations.seededAcknowledgement, true); assert(result.phases.some(phase => phase.name === 'result.prompt-ingest-durable'));
  assert.equal(result.evidence[0].ownedRef.byteLength, String(bytes)); assert(result.evidence[0].jobId);
});

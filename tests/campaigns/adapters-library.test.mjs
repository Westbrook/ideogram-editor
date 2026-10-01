import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareAdapterLibrary } from '../../tooling/qualification/campaigns/adapters.mjs';

test('WA library setup creates 100 production registrations without inventing eligibility when the official fixture is absent', async t => {
  const output = await mkdtemp(join(tmpdir(), 'wa-library-unit-')); t.after(() => rm(output, { recursive: true, force: true }));
  const { openWriter } = await import('../../dist/local/server/storage/writer.js');
  const root = join(output, 'private'); let writer = await openWriter({ root }); t.after(async () => writer.close()); await writer.protocolDefaults();
  const library = await prepareAdapterLibrary(writer, { weights: [], config: null }, { repo: resolve('.'), output, root, officialPath: join(output, 'absent-official-fixture') });
  assert.equal(library.entries.length, 100); assert.equal(library.eligibleEntries.length, 0); assert.equal(library.official, null);
  assert.equal(new Set(library.entries.map(value => value.versionId)).size, 100);
  for (const entry of library.entries) { assert.equal(entry.locallyEligible, false); assert.equal(entry.runtimeVerified, false); assert.equal(entry.qualification, 'structurally-valid'); assert.equal(entry.weights.byteLength, '16384'); }
  await writer.close(); writer = await openWriter({ root }); const recovered = []; let after = '';
  do { const page = await writer.adapterList(after); recovered.push(...page.items); after = page.nextAfter; } while (after);
  assert.equal(recovered.length, 100); assert.deepEqual(new Set(recovered.map(item => item.versionId)), new Set(library.entries.map(item => item.versionId)));
});

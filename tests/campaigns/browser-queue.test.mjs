import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileIdentity } from '../../tooling/qualification/campaigns/common.mjs';
import { queueBrowserScenario, selectQueueResultFiles } from '../../tooling/qualification/campaigns/browser-queue.mjs';

test('Fast reconnect and WQ browser restart retain their distinct required workflows', () => {
  assert.equal(queueBrowserScenario({ operation: 'fast.workflow', parameters: { caseId: 'WF14' } }).scenario, 'reconnect');
  assert.equal(queueBrowserScenario({ operation: 'queue.fault', parameters: { scenario: 'browser-restart' } }).scenario, 'browser-restart');
  assert.deepEqual(queueBrowserScenario({ operation: 'fast.workflow', parameters: { caseId: 'WF06' } }).manifest, { caseId: 'WF06', speed: 'QUALITY', expansion: 'Medium', width: 2048, height: 2048, count: 4, format: 'jpeg' });
});

test('Fast image selection verifies every exact size-format-index identity before provider startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-fast-corpus-'));
  try {
    const files = [];
    for (let index = 0; index < 4; index++) {
      const path = join(root, 'sample-' + index), bytes = Buffer.from('already sealed image descriptor ' + index); await writeFile(path, bytes);
      const identity = await fileIdentity(path);
      files.push({ role: 'fast-candidate', path, width: 1024, height: 1024, format: 'jpeg', index, byteLength: String(identity.bytes), sha256: identity.sha256 });
    }
    const cell = { operation: 'fast.workflow', parameters: { caseId: 'WF02' } };
    assert.equal((await selectQueueResultFiles(cell, { corpus: { files } })).length, 4);
    await assert.rejects(selectQueueResultFiles(cell, { corpus: { files: files.slice(1) } }), error => error.code === 'CAMPAIGN_PREREQUISITE');
    await assert.rejects(selectQueueResultFiles(cell, { corpus: { files: [...files, files[0]] } }), error => error.code === 'CAMPAIGN_PREREQUISITE');
    await writeFile(files[2].path, 'changed bytes'); await assert.rejects(selectQueueResultFiles(cell, { corpus: { files } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('binary transport bytes never substitute for an actual fault image', async () => {
  for (const operation of ['queue.fault', 'fast.workflow']) {
    const cell = { operation, parameters: { caseId: 'WF13', scenario: 'lost-ack' } };
    await assert.rejects(selectQueueResultFiles(cell, { corpus: { files: [{ role: 'transfer', byteLength: String(8 * 1024 * 1024), image: false }] } }), error => error.code === 'CAMPAIGN_PREREQUISITE');
  }
});

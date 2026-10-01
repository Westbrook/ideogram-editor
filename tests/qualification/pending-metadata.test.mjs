import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';
import { allocationsURL, promptMemoryURL } from '../owned-preview-module.mjs';
const data = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
let code = (await transformWithOxc(await readFile('src/state/draft-persistence.ts', 'utf8'), 'src/state/draft-persistence.ts')).code;
for (const [name, url] of Object.entries({ '../observability/allocations.js': allocationsURL, '../observability/prompt-memory.js': promptMemoryURL })) code = code.replaceAll(JSON.stringify(name), JSON.stringify(url)).replaceAll("'" + name + "'", JSON.stringify(url));
const { DraftPersistence } = await import(data(code)), { allocationLedger, ALLOCATION_LIMITS } = await import(allocationsURL);
const saved = id => ({ request: { protocolVersion: 1, requestId: id, sessionId: 'ui', expectedUISeq: '1', body: { type: 'SetPreferences', preferences: { documentId: 'document' } } }, draftId: '', generation: '0' });
function fixture() {
  let rows = [saved('original')], seq = '1'; const posted = [], retained = new Map();
  const owner = new DraftPersistence('ui', async (_path, init) => {
    if (init?.method === 'POST') { posted.push(init.body); const value = JSON.parse(init.body); return Response.json({ protocolVersion: 1, requestId: value.requestId, status: 'accepted', uiSeq: '3' }); }
    return Response.json({ sessionId: 'ui', uiSeq: seq, preferences: { documentId: 'document' }, drafts: [] });
  }, () => '', { async scan(_prefix, visit) { for (const value of rows) if (visit(value) === false) break; }, async put(key, value) { retained.set(key, structuredClone(value)); } });
  return { owner, posted, retained, rows: value => { rows = value; }, seq: value => { seq = value; } };
}

test('historical terminal UI deliveries never become retained pending metadata', async () => {
  const before = allocationLedger.snapshot(), f = fixture();
  f.rows([...Array.from({ length: 2000 }, (_, i) => ({ ...saved('done-' + i), done: true })), saved('original')]);
  try { await f.owner.restore(); assert.deepEqual(f.owner.pendingRequests(), ['original']); assert.equal(allocationLedger.snapshot().cpuBytes - before.cpuBytes, 1024 * 1024); }
  finally { f.owner.dispose(); }
  assert.equal(allocationLedger.snapshot().cpuBytes, before.cpuBytes);
});

test('partial metadata admission failure preserves the prior checkpoint and exact original pending deliveries', async () => {
  const before = allocationLedger.snapshot(), f = fixture(); let pressure;
  try {
    await f.owner.restore(); const originalCheckpoint = f.owner.checkpoint;
    f.rows([saved('original'), saved('new-one'), saved('new-two')]); f.seq('2');
    pressure = allocationLedger.reserve({ owner: 'pending-metadata-test', kind: 'control', cpuBytes: ALLOCATION_LIMITS.cpuBytes - ALLOCATION_LIMITS.textPartitionBytes - allocationLedger.snapshot().cpuBytes - 1024 * 1024 });
    await assert.rejects(f.owner.restore(), /ALLOCATION_BUDGET/);
    assert.equal(f.owner.checkpoint, originalCheckpoint); assert.deepEqual(f.owner.pendingRequests(), ['original']);
    pressure.release(); pressure = undefined;
    await f.owner.restore(); assert.deepEqual(f.owner.pendingRequests(), ['original', 'new-one', 'new-two']);
    await f.owner.retry('new-two'); assert.equal(f.posted[0], JSON.stringify(saved('new-two').request));
    assert.equal(f.retained.get('ui-request:ui:new-two').done, true); assert.deepEqual(f.owner.pendingRequests(), ['original', 'new-one']);
  } finally { pressure?.release(); f.owner.dispose(); }
  assert.equal(allocationLedger.snapshot().cpuBytes, before.cpuBytes);
});

test('draft delivery admission failure clears pending feedback without discarding the editable generation', async () => {
  const before = allocationLedger.snapshot(), f = fixture(); let pressure;
  try {
    await f.owner.restore();
    f.owner.change({ id: 'draft', kind: 'prompt', documentId: 'document', targetLayerId: null, expectedDocumentRevision: '1', composing: false, text: 'unsaved exact input' });
    pressure = allocationLedger.reserve({ owner: 'pending-save-test', kind: 'control', cpuBytes: ALLOCATION_LIMITS.cpuBytes - ALLOCATION_LIMITS.textPartitionBytes - allocationLedger.snapshot().cpuBytes - 1024 });
    await assert.rejects(f.owner.save('draft', async () => 'durable-caption'), /ALLOCATION_BUDGET/);
    assert.equal(f.owner.drafts.get('draft').text, 'unsaved exact input'); assert.equal(f.owner.drafts.get('draft').pending, false);
    assert.throws(() => f.owner.assertDocumentSaved('document'), /Save the current drafts/);
    assert.deepEqual(f.owner.pendingRequests(), ['original']); assert.equal(f.posted.length, 0);
  } finally { pressure?.release(); f.owner.dispose(); }
  assert.equal(allocationLedger.snapshot().cpuBytes, before.cpuBytes);
});

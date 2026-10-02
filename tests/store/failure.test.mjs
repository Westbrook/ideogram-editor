import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rootFor, childFor, command, checkpoint, encode, putExpected, expectedBytes, refFor } from './helpers.mjs';

for (const phase of ['before-object-write', 'before-object-flush', 'after-object-flush', 'before-object-rename', 'after-object-rename', 'after-object-directory-sync']) {
  test(`SIGKILL at ${phase}: unfinished bytes never appear as an accepted document`, async t => {
    const root = await rootFor(t); const writer = await childFor(t, root, { phase });
    const pending = putExpected(writer).catch(error => error);
    assert.equal((await writer.wait('barrier')).phase, phase);
    await writer.assertNoEffects(); await writer.kill(); await pending;
    const next = await childFor(t, root); assert.equal(next.epoch, '2');
    assert.equal((await next.call('events')).highWater, '0'); assert.equal(await next.call('document', 'document_1'), null);
    if (['after-object-rename', 'after-object-directory-sync'].includes(phase)) assert.equal(await next.call('diagnosticScalar', 'inventory.orphanCount'), '1');
    else assert.equal(await next.call('diagnosticScalar', 'inventory.stagingCount'), '1');
    const ref = await putExpected(next); const result = await next.call('submit', encode(command(ref)));
    assert.equal(result.status, 'accepted'); assert.equal(result.fromSeq, '1');
    await next.assertNoEffects(); await next.close();
  });
}

for (const phase of ['before-event-insert', 'before-commit', 'after-commit']) {
  test(`SIGKILL at ${phase}: receipt, event, roots and projection recover together; same-ID retry resolves lost delivery`, async t => {
    const root = await rootFor(t); const writer = await childFor(t, root, { phase });
    const ref = await putExpected(writer); const c = command(ref);
    const delivery = writer.call('submit', encode(c)).catch(error => error);
    await writer.wait('barrier');
    // Parent stays responsive while the worker is paused in a real transaction.
    await writer.assertNoEffects(); await writer.kill(); await delivery;
    const next = await childFor(t, root); const record = await next.call('lookup', c.command.commandId);
    assert.equal(record !== null, phase === 'after-commit');
    assert.equal((await next.call('events')).highWater, phase === 'after-commit' ? '1' : '0');
    assert.equal((await next.call('document', 'document_1')) !== null, phase === 'after-commit');
    const result = await next.call('submit', encode(c)); assert.equal(result.status, 'accepted'); assert.equal(result.fromSeq, '1');
    if (record) assert.deepEqual(result, record.receipt);
    assert.equal((await next.call('events')).events.length, 1);
    const snapshot = await next.call('document', 'document_1'); await next.assertNoEffects(); await next.close();
    const reopened = await childFor(t, root);
    assert.deepEqual(await reopened.call('submit', encode(c)), result); assert.deepEqual(await reopened.call('document', 'document_1'), snapshot);
    await reopened.assertNoEffects(); await reopened.close();
  });
}

test('real SQLite SQLITE_FULL rolls back acceptance and rejection receipts, then exact retry succeeds after capacity returns', async t => {
  const root = await rootFor(t); const setup = await childFor(t, root); const ref = await putExpected(setup);
  await setup.call('submit', encode(command(ref))); const before = await setup.call('document', 'document_1');
  const pageCount = await setup.call('diagnosticScalar', 'settings.page_count'); await setup.close();
  const full = await childFor(t, root, { maxPageCount: pageCount });
  const large = checkpoint(ref, '1', 'Retained checkpoint '.repeat(400));
  await assert.rejects(full.call('submit', encode(large)), { code: 'STORAGE_FULL' });
  assert.equal((await full.wait('failure')).failure.sqliteCode, 13); // SQLITE_FULL
  assert.equal(await full.call('lookup', large.command.commandId), null); assert.equal((await full.call('events')).highWater, '1');
  assert.deepEqual(await full.call('document', 'document_1'), before);
  // Large immutable original envelope forces journal growth even for a semantic rejection.
  const rejected = checkpoint(ref, '0', 'Unchanged rejected draft '.repeat(400));
  await assert.rejects(full.call('submit', encode(rejected)), { code: 'STORAGE_FULL' });
  assert.equal(await full.call('lookup', rejected.command.commandId), null);
  await full.close();
  const restored = await childFor(t, root);
  assert.equal((await restored.call('submit', encode(large))).status, 'accepted');
  assert.equal((await restored.call('submit', encode(rejected))).code, 'STALE_REVISION');
  assert.equal((await restored.call('events')).highWater, '2'); await restored.assertNoEffects(); await restored.close();
});

test('real filesystem permission failure during rename leaves no accepted reference and can retry unchanged bytes', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root, { phase: 'after-object-flush' });
  const result = putExpected(writer).catch(error => error);
  await writer.wait('barrier'); await chmod(join(root, 'staging'), 0o500);
  await writer.call('release'); const failed = await result; assert.equal(failed.code, 'STORAGE_FAILURE');
  assert.equal((await writer.wait('failure')).failure.code, 'EACCES');
  await chmod(join(root, 'staging'), 0o700);
  assert.equal((await writer.call('events')).highWater, '0');
  assert.equal(await writer.call('diagnosticScalar', 'inventory.orphanCount'), '0');
  await writer.close(); const retry = await childFor(t, root);
  assert.deepEqual(await putExpected(retry), refFor(expectedBytes)); await retry.close();
});

test('SQLite busy timeout is bounded off the parent event loop; failed mutation has no durable receipt', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root); const ref = await putExpected(writer); const c = command(ref);
  // A deliberately nonconforming connection exercises SQLite's final serialization
  // independently of the app's OS ownership lock. Production never opens this path.
  const interferer = new DatabaseSync(join(root, 'metadata.sqlite'));
  try {
    interferer.exec('BEGIN IMMEDIATE');
    const start = performance.now(); const pending = writer.call('submit', encode(c)).catch(error => error);
    await writer.assertNoEffects(); const responsiveMs = performance.now() - start;
    const error = await pending; assert.equal(error.code, 'STORAGE_FAILURE');
    assert.equal((await writer.wait('failure')).failure.sqliteCode, 5); // SQLITE_BUSY
    const busyMs = performance.now() - start; assert.ok(busyMs >= 200 && busyMs < 2000); assert.ok(responsiveMs < busyMs);
    assert.equal(await writer.call('lookup', c.command.commandId), null);
    interferer.exec('ROLLBACK');
    assert.equal((await writer.call('submit', encode(c))).status, 'accepted');
    t.diagnostic(JSON.stringify({ busyTimeoutObservedMs: busyMs, parentResponseDuringWorkerBusyMs: responsiveMs, performanceQualification: false }));
  } finally { if (interferer.isTransaction) interferer.exec('ROLLBACK'); interferer.close(); }
  await writer.close();
});

test('all durable subfiles remain owner-only, including WAL, shared-memory file and abandoned staging', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root); const ref = await putExpected(writer);
  await writer.call('submit', encode(command(ref)));
  let files = 0;
  async function inspect(path) {
    const s = await stat(path); assert.equal(s.uid, process.getuid()); assert.equal(s.mode & 0o777, s.isDirectory() ? 0o700 : 0o600);
    if (s.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name)); else { assert.equal(s.nlink, 1); files++; }
  }
  await inspect(root); assert.ok(files >= 5); await writer.close();
});

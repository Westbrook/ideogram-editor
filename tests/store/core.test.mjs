import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from '../../dist/local/server/storage/canonical.js';
import { reduceDocument } from '../../dist/local/server/storage/reducer.js';
import { defaultStorageRoot } from '../../dist/local/tooling/launcher.js';
import { rootFor, childFor, command, checkpoint, encode, putExpected, expectedBytes, refFor } from './helpers.mjs';

test('OS ownership: competing processes and case aliases refuse; death releases ownership and fences old callbacks', async t => {
  const root = await rootFor(t); const first = await childFor(t, root);
  assert.equal(first.epoch, '1');
  const rival = await childFor(t, root); assert.equal(rival.startup.code, 'ROOT_BUSY');
  const alias = root.replace(/ideogram-store-/, 'IDEOGRAM-STORE-');
  if (await stat(alias).then(() => true, () => false)) {
    assert.equal((await childFor(t, alias)).startup.code, 'ROOT_BUSY');
    t.diagnostic('Host resolves case aliases; actual alias contention was exercised.');
  }
  await first.assertNoEffects(); await first.kill();
  const second = await childFor(t, root); assert.equal(second.epoch, '2');
  const ref = await putExpected(second); const c = command(ref);
  await assert.rejects(second.call('submit', encode(c), '1'), { code: 'STALE_EPOCH' });
  assert.equal(await second.call('lookup', c.command.commandId), null);
  assert.equal((await second.call('submit', encode(c))).status, 'accepted');
  await second.assertNoEffects(); await second.close();
});

test('NewDocument and named checkpoint persist exact facts, history and receipt; replay has no effects', async t => {
  const root = await rootFor(t); const first = await childFor(t, root);
  const ref = await putExpected(first); const c = command(ref);
  const receipt = await first.call('submit', encode(c));
  assert.deepEqual(receipt, { status: 'accepted', commandId: c.command.commandId, fromSeq: '1', toSeq: '1', documentRevision: '1', transactionId: c.command.transactionId });
  const initial = await first.call('document', 'document_1');
  assert.equal(initial.width, 1200); assert.equal(initial.height, 800); assert.deepEqual(initial.orderedLayerIds, []);
  const history = await first.call('history', initial.historyHead);
  assert.equal(history.parent, null); assert.deepEqual(history.forward.after, initial); assert.deepEqual(history.inverse.before, initial);
  const save = checkpoint(ref, '1', 'Café\n東京 😀');
  const saved = await first.call('submit', encode(save)); assert.equal(saved.documentRevision, '2');
  const document = await first.call('document', 'document_1');
  assert.equal(document.historyHead, initial.historyHead);
  const named = await first.call('checkpoint', document.checkpoint);
  assert.equal(named.name, 'Café\n東京 😀'); assert.equal(named.highWater, '1'); assert.equal(named.documentRevision, '1');
  const events = await first.call('events');
  assert.deepEqual(events.events.reduce(reduceDocument, null), document);
  assert.equal(events.highWater, '2');
  const before = await first.call('diagnosticScalar', 'projectionDigest'); await first.assertNoEffects(); await first.close();
  const second = await childFor(t, root);
  assert.deepEqual(await second.call('document', 'document_1'), document);
  assert.deepEqual(await second.call('events'), events);
  assert.deepEqual(await second.call('submit', encode(c)), receipt);
  assert.deepEqual(await second.call('submit', encode(save)), saved);
  assert.equal(await second.call('diagnosticScalar', 'projectionDigest'), before);
  assert.equal(await second.call('diagnosticScalar', 'settings.journal_mode'), 'wal'); assert.equal(await second.call('diagnosticScalar', 'settings.synchronous'), 2);
  assert.equal(await second.call('diagnosticScalar', 'settings.foreign_keys'), 1); assert.equal(await second.call('diagnosticScalar', 'settings.busy_timeout'), 250);
  t.diagnostic(await second.call('diagnosticJSON', 'core-log'));
  await second.assertNoEffects(); await second.close();
});

test('canonical delivery: whitespace/key order retry once; changed provenance or Unicode conflicts without replacement', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root); const ref = await putExpected(writer);
  const create = command(ref); await writer.call('submit', encode(create));
  const c = checkpoint(ref, '1', 'é\n東京'); const original = encode(c);
  const first = await writer.call('submit', original);
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ?
    Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
  assert.deepEqual(await writer.call('submit', Buffer.from(JSON.stringify(reorder(c), null, 3))), first);
  assert.equal((await writer.call('events')).events.length, 2);
  for (const change of [v => { v.command.sessionId = 'renewed'; }, v => { v.command.body.name = 'e\u0301\n東京'; }, v => { v.command.causationId = 'cause'; }]) {
    const v = structuredClone(c); change(v); await assert.rejects(writer.call('submit', encode(v)), { code: 'COMMAND_ID_REUSE' });
  }
  assert.deepEqual((await writer.call('lookup', c.command.commandId)).receipt, first);
  assert.notEqual(canonical({ a: null }), canonical({}));
  assert.equal(canonical({ '\u{10000}': '\n', '\ue000': -0, a: '\t\r\u0001"\\é' }), '{"a":"\\u0009\\u000d\\u0001\\"\\\\é","":0,"𐀀":"\\u000a"}');
  assert.equal((await writer.call('lookup', c.command.commandId)).hash, `sha256:${createHash('sha256').update(canonical(c)).digest('hex')}`);
  await writer.assertNoEffects(); await writer.close();
  // Inspect retained input only after closing the owner; no extra writable connection.
  const db = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT original FROM commands WHERE id=?').get(c.command.commandId).original, original.toString()); }
  finally { db.close(); }
});

test('public command boundary rejects duplicate keys, unknown fields/types, malformed UTF-8 and oversize without receipts', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root); const ref = await putExpected(writer); const c = command(ref);
  const cases = [
    [Buffer.from(JSON.stringify(c).replace('"protocolVersion":1', '"protocolVersion":1,"protocolVersion":1')), 'MALFORMED_REQUEST'],
    [Buffer.from(JSON.stringify(c).replace('"protocolVersion":1', '"protocolVersion":1,"\\u0070rotocolVersion":1')), 'MALFORMED_REQUEST'],
    [encode({ ...c, unknown: true }), 'MALFORMED_REQUEST'],
    [encode({ ...c, command: { ...c.command, body: { type: 'SetAnything', value: {} } } }), 'UNSUPPORTED_COMMAND'],
    [encode({ ...c, command: { ...c.command, body: { ...c.command.body, width: 1.1 } } }), 'MALFORMED_REQUEST'],
    [encode({ ...c, protocolVersion: 2 }), 'PROTOCOL_VERSION'],
    [Buffer.from(JSON.stringify(c).replace('1200', '1e999')), 'MALFORMED_REQUEST'],
    [Buffer.from(JSON.stringify(c).replace('sRGB', '\\ud800')), 'MALFORMED_REQUEST'],
    [Buffer.concat([encode(c), Buffer.from([0xff])]), 'MALFORMED_REQUEST'],
    [Buffer.alloc(65537, 32), 'PAYLOAD_TOO_LARGE'],
  ];
  const omitted = structuredClone(c); delete omitted.command.causationId; cases.push([encode(omitted), 'MALFORMED_REQUEST']);
  for (const [bytes, code] of cases) await assert.rejects(writer.call('submit', bytes), { code });
  assert.equal(await writer.call('lookup', c.command.commandId), null); assert.equal((await writer.call('events')).highWater, '0');
  await writer.close();
});

test('concurrent revision race accepts exactly one checkpoint and durably rejects the stale draft', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root); const ref = await putExpected(writer);
  await writer.call('submit', encode(command(ref)));
  const commands = [checkpoint(ref, '1', 'First'), checkpoint(ref, '1', 'Second')];
  const results = await Promise.all(commands.map(c => writer.call('submit', encode(c))));
  assert.equal(results.filter(r => r.status === 'accepted').length, 1);
  const index = results.findIndex(r => r.status === 'rejected'); const rejected = results[index];
  assert.equal(rejected.code, 'STALE_REVISION'); assert.equal(rejected.currentRevision, '2');
  const bytes = await writer.call('readMetadata', rejected.details);
  assert.equal(Buffer.from(bytes).toString(), '{"issues":[{"code":"REVISION_CHANGED","path":"command.expectedDocumentRevision"}],"kind":"fields"}');
  const before = await writer.call('document', 'document_1'); await writer.close();
  const again = await childFor(t, root);
  assert.deepEqual(await again.call('submit', encode(commands[index])), rejected);
  assert.deepEqual(await again.call('readMetadata', rejected.details), bytes);
  assert.equal((await again.call('lookup', commands[index].command.commandId)).command.body.name, commands[index].command.body.name);
  assert.deepEqual(await again.call('document', 'document_1'), before); assert.equal((await again.call('events')).highWater, '2');
  await again.assertNoEffects(); await again.close();
});

test('all five rejection codes retain exact details; no rejection advances document sequence', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root); const ref = await putExpected(writer);
  const missing = { ...ref, hash: `sha256:${'f'.repeat(64)}` };
  const cases = [
    [command(ref, {}, { width: 0 }), 'INVALID_INPUT'],
    [command(ref, {}, { width: 8193 }), 'CAPACITY'],
    [command(ref, {}, { color: 'DisplayP3' }), 'INCOMPATIBLE'],
    [command(missing), 'MISSING_ASSET'],
    [command(ref, { expectedDocumentRevision: '1' }), 'STALE_REVISION'],
  ];
  const receipts = [];
  for (const [c, code] of cases) {
    const receipt = await writer.call('submit', encode(c)); assert.equal(receipt.status, 'rejected'); assert.equal(receipt.code, code);
    const bytes = await writer.call('readMetadata', receipt.details); assert.deepEqual(refFor(Buffer.from(bytes)), receipt.details);
    assert.equal(canonical(JSON.parse(Buffer.from(bytes))), Buffer.from(bytes).toString()); receipts.push(receipt);
  }
  assert.equal((await writer.call('events')).highWater, '0'); assert.equal(await writer.call('document', 'document_1'), null);
  await writer.close(); const again = await childFor(t, root);
  for (let i = 0; i < cases.length; i++) assert.deepEqual(await again.call('submit', encode(cases[i][0])), receipts[i]);
  await again.close();
});

test('missing or corrupt immutable bytes cannot become accepted references and remain visible at restart', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root); const ref = await putExpected(writer);
  const object = join(root, 'objects/sha256', ref.hash.slice(7, 9), ref.hash.slice(7));
  await writeFile(object, Buffer.alloc(expectedBytes.length, 120), { mode: 0o600 });
  const rejected = await writer.call('submit', encode(command(ref))); assert.equal(rejected.code, 'MISSING_ASSET');
  assert.equal((await writer.call('events')).highWater, '0'); await unlink(object);
  assert.deepEqual(await putExpected(writer), ref);
  await writer.call('submit', encode(command(ref))); const before = await writer.call('document', 'document_1'); await writer.close();
  await unlink(object);
  const again = await childFor(t, root);
  assert.equal(await again.call('diagnosticScalar', 'missingCount'), 1); assert.equal(await again.call('diagnosticScalar', 'missing.0.code'), 'MISSING_OBJECT');
  assert.deepEqual(await again.call('document', 'document_1'), before);
  await assert.rejects(again.call('submit', encode(checkpoint(ref, '1'))), { code: 'CORRUPT_STORE' });
  await again.assertNoEffects(); await again.close();
});

test('streamed objects verify actual lengths/hashes, deduplicate bytes, retain orphans and obey admission reservations', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root);
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 27, 47); const ref = refFor(bytes);
  assert.deepEqual(await writer.call('put', bytes, ref), ref);
  assert.deepEqual(await writer.call('put', bytes, ref), ref);
  assert.deepEqual(await readFile(join(root, 'objects/sha256', ref.hash.slice(7, 9), ref.hash.slice(7))), bytes);
  await assert.rejects(writer.call('put', bytes, { ...ref, byteLength: String(bytes.length - 1) }), { code: 'MALFORMED_REQUEST' });
  await assert.rejects(writer.call('put', bytes, { ...ref, hash: `sha256:${'a'.repeat(64)}` }), { code: 'CORRUPT_OBJECT' });
  await assert.rejects(writer.call('put', Buffer.alloc(0), { ...ref, byteLength: '999999999999999999999' }), { code: 'CAPACITY' });
  assert.equal(await writer.call('diagnosticScalar', 'inventory.orphanCount'), '1'); assert.equal(await writer.call('diagnosticScalar', 'inventory.stagingCount'), '2');
  const inventory = await writer.call('diagnosticJSON', 'inventory');
  await writer.close(); const again = await childFor(t, root);
  assert.equal(await again.call('diagnosticJSON', 'inventory'), inventory); await again.close();
  const limited = await childFor(t, await rootFor(t), { quotaBytes: '67108865' });
  await assert.rejects(putExpected(limited), { code: 'CAPACITY' }); await limited.close();
});

test('root modes, hardlinks, symlink subfiles and replaced paths fail closed without touching targets', async t => {
  const root = await rootFor(t); const sentinel = join(root, 'sentinel'); await writeFile(sentinel, 'untouched', { mode: 0o600 });
  const cases = ['symlink', 'hardlink', 'public'];
  for (const kind of cases) {
    const target = join(root, kind); await mkdir(target, { mode: 0o700 });
    if (kind === 'symlink') await symlink(sentinel, join(target, 'metadata.sqlite'));
    if (kind === 'hardlink') await link(sentinel, join(target, 'metadata.sqlite'));
    if (kind === 'public') await chmod(target, 0o755);
    const failed = await childFor(t, target); assert.ok(failed.startup.code);
    if (kind === 'hardlink') await unlink(join(target, 'metadata.sqlite'));
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  const active = join(root, 'active'); const writer = await childFor(t, active); const ref = await putExpected(writer);
  await rename(active, join(root, 'moved')); await mkdir(active, { mode: 0o700 });
  await assert.rejects(writer.call('submit', encode(command(ref))), { code: 'ROOT_UNSAFE' }); await writer.close();
});

test('application-data defaults are explicit and refuse silent migration of the earlier root', async t => {
  const home = await rootFor(t);
  assert.equal(await defaultStorageRoot(home, 'darwin'), join(home, 'Library/Application Support/ideogram-edit'));
  assert.equal(await defaultStorageRoot(home, 'linux', ''), join(home, '.local/share/ideogram-edit'));
  assert.equal(await defaultStorageRoot(home, 'linux', '/opt/local-data'), '/opt/local-data/ideogram-edit');
  await assert.rejects(defaultStorageRoot(home, 'linux', 'relative'));
  await mkdir(join(home, '.ideogram-editor'), { mode: 0o700 });
  await assert.rejects(defaultStorageRoot(home, 'darwin'), /Select it deliberately with --root/);
});

test('large event content is rejected without truncation; real snapshots preserve history past 500 events', async t => {
  const root = await rootFor(t); const writer = await childFor(t, root); const ref = await putExpected(writer);
  await writer.call('submit', encode(command(ref)));
  const large = checkpoint(ref, '1', '東京'.repeat(3000));
  const rejected = await writer.call('submit', encode(large)); assert.equal(rejected.code, 'CAPACITY');
  assert.equal((await writer.call('lookup', large.command.commandId)).command.body.name, large.command.body.name);
  assert.equal((await writer.call('events')).highWater, '1');
  for (let revision = 1; revision < 500; revision++) assert.equal((await writer.call('submit', encode(checkpoint(ref, String(revision))))).status, 'accepted');
  const atLimit = await writer.call('submit', encode(checkpoint(ref, '500'))); assert.equal(atLimit.status, 'accepted');
  assert.equal(await writer.call('diagnosticScalar', 'observations.snapshot.latest'),'500'); assert.equal(await writer.call('diagnosticScalar', 'observations.snapshot.pressure'),false);
  const view = await writer.call('events', '0', 500); assert.equal(view.events.length, 500); assert.equal(view.highWater, '501');
  assert.equal((await writer.call('document', 'document_1')).revision, '501');
  await writer.close(); const again = await childFor(t, root);
  assert.equal((await again.call('document', 'document_1')).revision, '501'); await again.assertNoEffects(); await again.close();
});

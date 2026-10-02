import {ownTestRoot} from '../../tooling/qualification/owned-test-roots.mjs';
import {installSchema18Packet} from './schema18-packet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cp, lstat, mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {priorWriter} from '../text-state/prior-writer.mjs';
import {encode, rootFor} from '../store/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';

const priorCommit = '5650326b623d4aa2080772307708aa9f1854aa52';
const capability = 'p2-request-adoption-adapters-v1';
const retainedDirectories = ['objects', 'staging', 'uploads', 'portable', 'backend-transport', 'raster-work'];
const phasePrefix = 'p2-semantic-schema-';
// Exact permitted declarations at each activation boundary. Unknown indexes,
// triggers, tables, or changes to any original declaration remain failures.
const p2SchemaAdditions = [
  {type:'table',name:'candidate_adoption_evidence',tbl_name:'candidate_adoption_evidence',sql:'CREATE TABLE candidate_adoption_evidence (document_id TEXT NOT NULL, attempt_id TEXT NOT NULL, PRIMARY KEY(document_id,attempt_id)) STRICT'},
  {type:'index',name:'sqlite_autoindex_candidate_adoption_evidence_1',tbl_name:'candidate_adoption_evidence',sql:null},
  {type:'table',name:'candidate_asset_evidence',tbl_name:'candidate_asset_evidence',sql:'CREATE TABLE candidate_asset_evidence (asset_id TEXT NOT NULL, manifest_hash TEXT NOT NULL, attempt_id TEXT NOT NULL, PRIMARY KEY(asset_id,attempt_id)) STRICT'},
  {type:'index',name:'sqlite_autoindex_candidate_asset_evidence_1',tbl_name:'candidate_asset_evidence',sql:null},
  {type:'index',name:'roots_hash',tbl_name:'roots',sql:'CREATE INDEX roots_hash ON roots(hash)'},
  {type:'index',name:'assets_preservation_inputs',tbl_name:'assets',sql:`CREATE INDEX assets_preservation_inputs ON assets (
    json_extract(json,'$.raster.pipeline'),json_extract(json,'$.raster.sourceAssetIds'),id
  ) WHERE json_extract(json,'$.qualification')='canonical-raster'
    AND json_extract(json,'$.safety')='safe' AND json_extract(json,'$.availability')='available'
    AND json_extract(json,'$.raster.role')='composite'`},
];
const schema18Additions = [
  {type:'table',name:'raster_import_inspections',tbl_name:'raster_import_inspections',sql:'CREATE TABLE raster_import_inspections (id TEXT PRIMARY KEY,json TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL) STRICT'},
  {type:'index',name:'sqlite_autoindex_raster_import_inspections_1',tbl_name:'raster_import_inspections',sql:null},
  {type:'index',name:'queue_jobs_order_position',tbl_name:'queue_jobs',sql:"CREATE INDEX queue_jobs_order_position ON queue_jobs(length(json_extract(json,'$.order.position')),json_extract(json,'$.order.position'),id)"},
  {type:'index',name:'queue_journal_job_creation',tbl_name:'queue_journal',sql:"CREATE INDEX queue_journal_job_creation ON queue_journal(seq) WHERE json_extract(json,'$.family')='job' AND json_extract(json,'$.event')='JobQueued'"},
  {type:'index',name:'queue_journal_order_epoch',tbl_name:'queue_journal',sql:"CREATE INDEX queue_journal_order_epoch ON queue_journal(seq) WHERE json_extract(json,'$.event') IN ('QueueOrderInitialized','LocalQueueReordered')"},
  {type:'index',name:'queue_accepted_creation',tbl_name:'events_v2',sql:"CREATE INDEX queue_accepted_creation ON events_v2(length(seq),seq) WHERE json_extract(json,'$.type')='JobQueued'"},
  {type:'index',name:'queue_jobs_unordered',tbl_name:'queue_jobs',sql:"CREATE INDEX queue_jobs_unordered ON queue_jobs(id) WHERE json_type(json,'$.order') IS NULL"},
];
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const captionLookalike = '{"kind":"request-draft-1","requestMaskDraft":{"label":"ordinary caption JSON"}}';
let old, queue, TransportEvidenceStore, policy;

test.before(async t => {
  old = await priorWriter(t, priorCommit);
  const load = path => import(pathToFileURL(join(old.directory, path)).href);
  const modules = await Promise.all([
    load('tests/queue/helpers.mjs'),
    load('dist/local/server/provider/evidence.js'),
    load('dist/local/server/provider/policy.js'),
    load('tests/provider/emulator.mjs'),
  ]);
  [queue, {TransportEvidenceStore}] = modules;
  policy = modules[2].resolvePrivacy(modules[3].fixtureProfile(), 'ideogram/v4', 'fixture').applied;
});

function inspect(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    // Schema 16 includes one-column tables; ORDER BY 1,2 cannot inspect them.
    const tables = Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) => {
      const rows = db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all();
      rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return [name, rows];
    }));
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
      tables,
    };
  } finally { db.close(); }
}

const inspectRoot = root => inspect(join(root, 'metadata.sqlite'));

function assertOriginalRows(after, before) {
  assert.equal(after.integrity, 'ok');
  assert([16,17,18].includes(after.version), 'Only the original16 or exact17/18 activation states are supported');
  const additions = after.version === 16 ? [] : [...p2SchemaAdditions, ...(after.version === 18 ? schema18Additions : [])];
  const names = new Set(additions.map(row => row.name)), addedTables = additions.filter(row => row.type === 'table').map(row => row.name);
  const declarations = rows => rows.map(row => ({...row,sql:row.sql === null ? null : row.sql.replace(/\s+/g,' ').trim()})).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  assert.deepEqual(declarations(after.schema.filter(row => names.has(row.name))), declarations(additions), 'Only exact known migration declarations are added');
  assert.deepEqual(after.schema.filter(row => !names.has(row.name)), before.schema, 'Every original schema declaration is byte-exact');
  assert.deepEqual(Object.keys(after.tables).filter(name => !addedTables.includes(name)), Object.keys(before.tables));
  for (const table of addedTables) assert.deepEqual(after.tables[table], [], table);
  assert.deepEqual(after.tables.schema_migrations.filter(row => row.version > 16).map(row => row.version).sort((a,b) => a-b), after.version === 16 ? [] : after.version === 17 ? [17] : [17,18]);
  for (const [name, rows] of Object.entries(before.tables)) {
    if (name === 'schema_migrations') {
      assert.deepEqual(after.tables[name].filter(row => row.version <= 16), rows, name);
    } else if (name === 'deletion_backup_pins' || name === 'deletion_backup_files') {
      const retained = new Set(after.tables[name].map(row => JSON.stringify(row)));
      for (const row of rows) assert(retained.has(JSON.stringify(row)), name + ' original row');
    } else {
      assert.deepEqual(after.tables[name], rows, name);
    }
  }
}

async function inventory(root, paths = ['']) {
  const rows = [];
  async function visit(relative) {
    const path = join(root, relative), stat = await lstat(path);
    if (stat.isDirectory()) {
      rows.push({path: relative, kind: 'directory', mode: stat.mode & 0o777});
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    } else {
      assert(stat.isFile(), 'Fixture must contain only private files and directories: ' + relative);
      rows.push({path: relative, kind: 'file', mode: stat.mode & 0o777, bytes: stat.size, hash: digest(await readFile(path))});
    }
  }
  for (const path of paths) await visit(path);
  return rows;
}

async function assertPreserved(root, before) {
  for (const entry of before) {
    const path = join(root, entry.path), stat = await lstat(path);
    assert.equal(stat.mode & 0o777, entry.mode, entry.path + ' mode');
    if (entry.kind === 'directory') assert(stat.isDirectory(), entry.path);
    else {
      assert(stat.isFile(), entry.path);
      assert.equal(stat.size, entry.bytes, entry.path + ' length');
      assert.equal(digest(await readFile(path)), entry.hash, entry.path + ' bytes');
    }
  }
}

async function seed(t) {
  const root = await rootFor(t), writer = await old.openWriter({root});
  let queued, pendingCommand, partial, unlinkedCaption;
  try {
    await writer.protocolDefaults();
    await writer.rememberClient(queue.auth().sessionHash, 'client_1', Date.now() + 3600000);
    const created = await writer.submit(encode(queue.command(queue.EMPTY_EXPECTED_VERSIONS, {}, {width: 1, height: 1})), writer.epoch);
    assert.equal(created.status, 'accepted');
    queued = await queue.enqueue(writer, (await queue.prepare(writer)).body);
    unlinkedCaption = await queue.caption(writer, captionLookalike);

    // Retain a genuinely resumable upload, not an unreferenced marker file.
    const bytes = Buffer.from('Pending upload Café 東京 remains byte exact');
    partial = {protocolVersion: 1, stagingId: randomUUID(), purpose: 'caption', expectedBytes: String(bytes.length), sha256: digest(bytes), mediaType: 'text/plain'};
    await writer.assetCreate(partial, queue.auth());
    const token = await writer.assetBeginChunk(partial.stagingId, '0', 13, queue.auth());
    await writer.assetChunk(token, bytes.subarray(0, 13), queue.auth());
    partial.record = await writer.assetGet(partial.stagingId, queue.auth());
    partial.bytes = bytes;

    // The old implementation creates valid retained transport records locally;
    // this fixture neither dispatches the job nor calls a provider.
    const evidence = new TransportEvidenceStore(root);
    const sink = evidence.begin(queued.job.attempts[0].id, 'request', {
      purpose: 'provider-request', ensure() {}, committed() {}, release() {},
    }, policy);
    sink.append(Buffer.from('Retained request evidence Café 東京'));
    sink.finish(true);
    pendingCommand = queue.command(queue.EMPTY_EXPECTED_VERSIONS, {
      expectedDocumentRevision: await writer.documentRevision('document_1'), body: {type: 'SaveCopy'},
    });
  } finally { await writer.close(); }

  const child = await old.childFor(t, root, {phase: 'portable-preparation-after-commit'});
  const sent = child.call('portableCommand', encode(pendingCommand), queue.auth()).catch(() => {});
  try {
    assert.equal((await child.wait('barrier')).phase, 'portable-preparation-after-commit');
  } finally { await child.kill(); await sent; }
  const before = inspectRoot(root);
  assert.equal(before.version, 16);
  assert.equal(before.tables.portable_preparations.length, 1);
  assert.equal(before.tables.portable_preparations[0].id, pendingCommand.command.commandId);
  assert.equal(before.tables.queue_jobs.length, 1);
  const files = await inventory(root, retainedDirectories);
  for (const directory of ['uploads', 'portable', 'backend-transport']) {
    assert(files.some(entry => entry.kind === 'file' && entry.path.startsWith(directory + '/')), directory + ' fixture is nonempty');
  }
  return {root, before, files, queued, pendingCommand, partial, unlinkedCaption};
}

function pausedOpen(root, suffix) {
  const gate = new SharedArrayBuffer(4), phase = phasePrefix + suffix;
  let hit, timer, seen = false;
  const barrier = new Promise(resolve => { hit = resolve; });
  const opening = openWriter({root}, {phase, gate, onBarrier(actual) { seen = true; hit(actual); }});
  const reached = Promise.race([
    barrier.then(actual => assert.equal(actual, phase)),
    opening.then(async writer => { if (!seen) { await writer.close(); throw Error('Writer did not reach ' + phase); } }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out waiting for ' + phase)), 15000); }),
  ]).finally(() => clearTimeout(timer));
  // Some tests attach their expected-rejection assertion after mutating proof.
  opening.catch(() => {});
  return {opening, reached, release() { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); }};
}

async function closeCurrent(root) {
  const writer = await openWriter({root});
  await writer.close();
}

async function terminalRecord(writer, command, hash) {
  let state;
  for (let i = 0; i < 1000; i++) {
    state = await writer.commandState(command.command.commandId);
    if (state.record) break;
    assert.deepEqual(state.pending?.command, command.command);
    if (hash) assert.equal(state.pending.hash, hash);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.record?.receipt.status, 'accepted', JSON.stringify(state));
  assert.deepEqual(state.record.command, command.command);
  if (hash) assert.equal(state.record.hash, hash);
  return state.record;
}

async function resumeCurrent(fixture) {
  const writer = await openWriter({root: fixture.root});
  try {
    await terminalRecord(writer, fixture.pendingCommand, fixture.before.tables.portable_preparations[0].hash);
    // Activation barriers retain the legacy rows. The completed current writer
    // then records the single accepted job's durable order, without dispatching.
    assert.equal(fixture.queued.job.version, '1');
    assert.deepEqual((await writer.queueView()).jobs, [{...fixture.queued.job,
      version: '2', order: {position: '1', insertionOrdinal: '1', origin: 'accepted-event'},
      ownerClientId: fixture.queued.request.command.clientId,
    }]);
  } finally { await writer.close(); }
}

async function finishUpload(writer, partial) {
  const offset = partial.record.committedOffset, remaining = partial.bytes.subarray(Number(offset));
  const token = await writer.assetBeginChunk(partial.stagingId, offset, remaining.length, queue.auth());
  await writer.assetChunk(token, remaining, queue.auth());
  const command = queue.envelope({type: 'FinalizeStaging', stagingId: partial.stagingId, expectedSha256: partial.sha256});
  await writer.assetCommand(encode(command), queue.auth());
  await terminalRecord(writer, command);
  assert.equal((await writer.assetGet(partial.stagingId, queue.auth())).state, 'finalized');
}

async function assertBackupCopies(root, manifest, files) {
  assert.equal(manifest.originalRoot, root);
  assert.deepEqual(Object.keys(manifest.retainedDirectoryCopies).sort(), retainedDirectories.slice(1).sort());
  const expected = [];
  for (const directory of retainedDirectories.slice(1)) {
    const copy = manifest.retainedDirectoryCopies[directory];
    assert.equal(copy, manifest.backup + '.files/' + directory);
    const entries = files.filter(entry => entry.path === directory || entry.path.startsWith(directory + '/'))
      .map(entry => ({...entry, path: join(copy, entry.path.slice(directory.length + 1))}));
    await assertPreserved(root, entries);
    for (const entry of entries) if (entry.kind === 'file') expected.push({path: entry.path, bytes: String(entry.bytes), hash: entry.hash});
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  assert.deepEqual([...manifest.retainedFiles].sort(byPath), expected.sort(byPath), 'Recovery manifest seals every immutable retained copy');
}

async function restoreAtOriginalRoot(t, root, migration, manifest) {
  const archive = join(await rootFor(t), 'upgraded');
  await rename(root, archive);
  await mkdir(root, {mode: 0o700});
  // This deliberate original-path restore owns a new directory identity.
  ownTestRoot(root);
  await cp(join(archive, 'objects'), join(root, 'objects'), {recursive: true});
  for (const directory of retainedDirectories.slice(1)) {
    await cp(join(archive, manifest.retainedDirectoryCopies[directory]), join(root, directory), {recursive: true});
  }
  await writeFile(join(root, 'metadata.sqlite'), await readFile(join(archive, migration.backup)), {mode: 0o600});
  return archive;
}

function assertPins(root, state, before, files) {
  const pins = new Set(state.tables.deletion_backup_pins.map(row => row.hash));
  const present = new Set(files.filter(entry => entry.kind === 'file').map(entry => entry.path));
  for (const row of before.tables.objects) {
    const path = join('objects/sha256', row.hash.slice(7, 9), row.hash.slice(7));
    if (present.has(path)) assert(pins.has(row.hash), 'Backup object is pinned: ' + row.hash);
    else {
      assert(before.tables.deletion_objects.some(deletion => deletion.hash === row.hash && ['unlinking', 'freed'].includes(deletion.state)), 'Absent object has durable unlink authority');
      assert(!pins.has(row.hash), 'A missing object cannot acquire a fictitious backup pin: ' + row.hash);
    }
  }
  const paths = new Set(state.tables.deletion_backup_files.map(row => row.path));
  for (const entry of files) if (entry.kind === 'file' && !entry.path.startsWith('objects/')) {
    assert(paths.has(join(root, entry.path)), 'Backup file is pinned: ' + entry.path);
  }
}

test('schema17 fences actual accepted 5650326 without root writes and restores schema16 pending work with that executable', async t => {
  const fixture = await seed(t), {root, before, files, pendingCommand, queued, partial, unlinkedCaption} = fixture;
  await installSchema18Packet(root);
  const paused = pausedOpen(root, 'after-activation');
  let migration, manifest;
  try {
    await paused.reached;
    const after = inspectRoot(root);
    assert.equal(after.version, 18);
    assertOriginalRows(after, before);
    assertPins(root, after, before, files);
    migration = JSON.parse(after.tables.schema_migrations.find(row => row.version === 17).receipt);
    assert.equal(migration.from, 16);
    assert.equal(migration.to, 17);
    assert.equal(migration.capability, capability);
    assert.equal(migration.rollback.compatibleExecutable, priorCommit);
    assert.match(migration.backup, /^schema16-backup-[0-9a-f-]{36}\.sqlite$/);
    assert.equal(migration.backupHash, digest(await readFile(join(root, migration.backup))));
    manifest = JSON.parse(await readFile(join(root, migration.manifestFile), 'utf8'));
    assert.equal(manifest.storageVersion, 16);
    assert.equal(manifest.compatibleExecutable, priorCommit);
    assert.equal(manifest.backup, migration.backup);
    assert.equal(manifest.backupHash, migration.backupHash);
    assert.deepEqual(manifest.retainedDirectories, retainedDirectories);
    assert.deepEqual(inspect(join(root, migration.backup)), before, 'Verified backup preserves every schema16 table and schema declaration');
    await assertPreserved(root, files);
    await assertBackupCopies(root, manifest, files);
  } finally {
    paused.release();
    const writer = await paused.opening;
    try {
      await terminalRecord(writer, pendingCommand, before.tables.portable_preparations[0].hash);
      await finishUpload(writer, partial);
    } finally { await writer.close(); }
  }
  const staged = before.tables.staged_assets.find(row => row.id === partial.stagingId);
  await assert.rejects(lstat(join(root, 'uploads', staged.filename)), {code: 'ENOENT'});
  await assertBackupCopies(root, manifest, files);

  const refusalState = inspectRoot(root), refusalFiles = await inventory(root);
  const databaseBytes = await readFile(join(root, 'metadata.sqlite'));
  await assert.rejects(old.openWriter({root}), {code: 'UNSUPPORTED_STORAGE'});
  assert.deepEqual(await readFile(join(root, 'metadata.sqlite')), databaseBytes, 'Old-reader refusal leaves exact database bytes unchanged');
  assert.deepEqual(await inventory(root), refusalFiles, 'Old-reader refusal adds, removes, or changes no root file');
  assert.deepEqual(inspectRoot(root), refusalState, 'Old-reader refusal does not advance writerEpoch');

  const archive = await restoreAtOriginalRoot(t, root, migration, manifest);
  assert.deepEqual(inspectRoot(root), before);
  await assertPreserved(root, files);
  const prior = await old.openWriter({root});
  try {
    assert.deepEqual((await prior.queueView()).jobs, [queued.job], 'Pending job identity and exact reviewed request survive old-reader rollback');
    assert.equal(Buffer.from(await prior.readMetadata(queued.job.review.request.settings.prompt.text)).toString('utf8'), 'Queue exact Café 東京');
    assert.equal(Buffer.from(await prior.readMetadata(unlinkedCaption.blob)).toString('utf8'), captionLookalike, 'Ordinary caption JSON does not acquire request-draft semantics');
    assert.deepEqual(await prior.assetGet(partial.stagingId, queue.auth()), partial.record, 'Pending upload resumes from the recorded offset');
    const record = await terminalRecord(prior, pendingCommand, before.tables.portable_preparations[0].hash);
    assert.deepEqual(await prior.portableCommand(encode(pendingCommand), queue.auth()), record.receipt, 'Retry returns the original durable command receipt');
    await assertPreserved(root, files);
    await finishUpload(prior, partial);
    assert.equal(digest(await readFile(join(root, 'objects/sha256', partial.sha256.slice(7, 9), partial.sha256.slice(7)))), partial.sha256);
    assert.equal(digest(await readFile(join(archive, migration.backup))), migration.backupHash, 'Restore leaves the archived migration backup unchanged');
    t.diagnostic(JSON.stringify({migration, priorRefusal: 'UNSUPPORTED_STORAGE', rollbackCommand: pendingCommand.command.commandId, rollbackReceipt: record.receipt, pendingJob: queued.job.id, originalPathRestore: true, pendingUploadResumed: true, allOriginalTablesAndFilesPreserved: true}));
  } finally { await prior.close(); }
});

test('fresh schema17 root records its semantic capability without a fictitious rollback', async t => {
  const root = await rootFor(t);
  await closeCurrent(root);
  const state = inspectRoot(root), migration = JSON.parse(state.tables.schema_migrations.find(row => row.version === 17).receipt);
  assert.equal(state.version, 19);
  assert.equal(migration.capability, capability);
  for (const field of ['backup', 'backupHash', 'manifestFile', 'rollback']) assert.equal(migration[field], null, field);
  assert(!(await readdir(root)).some(name => name.startsWith('schema16-backup-')));
});

for (const interruption of ['deletion-work-unlink-intent', 'deletion-after-unlink']) {
test('schema17 preserves schema16 deletion at ' + interruption + ' and the actual old writer resumes an original-path restore', async t => {
  const root = await rootFor(t), writer = await old.openWriter({root});
  try {
    await writer.protocolDefaults();
    await writer.rememberClient(queue.auth().sessionHash, 'client_1', Date.now() + 3600000);
    assert.equal((await writer.submit(encode(queue.command(queue.EMPTY_EXPECTED_VERSIONS, {}, {width: 1, height: 1})), writer.epoch)).status, 'accepted');
    // The default empty map also has an independent protocol root. A distinct
    // accepted version map gives this document real exclusively owned bytes so
    // the object-unlink crash barrier is exercised, rather than skipped.
    const expected = Buffer.from(canonical({schemaVersion: 1, entities: [{entityType: 'document', entityId: 'document_1', version: '1'}]}));
    const ref = await writer.putObject([expected], {byteLength: String(expected.length), mediaType: 'application/json'}, writer.epoch);
    const checkpoint = queue.command(ref, {expectedDocumentRevision: '1', body: {type: 'SaveCheckpoint', name: 'Exclusive rollback bytes'}});
    assert.equal((await writer.submit(encode(checkpoint), writer.epoch)).status, 'accepted');
  } finally { await writer.close(); }

  // Model an abandoned raster spool using the same persisted cleanup ownership
  // record as a raster worker; deletion itself goes through the old command API.
  const work = join(root, 'raster-work', randomUUID()), file = join(work, 'retained-spool');
  const bytes = Buffer.from('Interrupted raster cleanup must retain its exact old bytes.');
  await mkdir(work, {mode: 0o700});
  await writeFile(file, bytes, {mode: 0o600});
  const db = new DatabaseSync(join(root, 'metadata.sqlite'));
  try { db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(work, 'document_1'); }
  finally { db.close(); }
  const deleting = await old.openWriter({root});
  try {
    const preview = queue.envelope({type: 'PreviewDocumentDeletion', documentId: 'document_1', expectedRevision: await deleting.documentRevision('document_1')});
    assert.equal((await deleting.queueCommand(encode(preview), queue.auth())).status, 'accepted');
    const {plan} = await deleting.deletionView('document_1', queue.auth());
    const command = queue.envelope({type: 'DeleteDocument', documentId: 'document_1', expectedRevision: plan.documentRevision,
      planId: plan.id, planHash: plan.planHash, rootGeneration: plan.rootGeneration, acknowledgeRunningAndUncertain: false});
    assert.equal((await deleting.queueCommand(encode(command), queue.auth())).status, 'accepted');
  } finally { await deleting.close(); }

  const collect = queue.envelope({type: 'CollectDocumentGarbage', documentId: 'document_1'});
  const child = await old.childFor(t, root, {phase: interruption});
  const sent = child.call('queueCommand', encode(collect), queue.auth()).catch(() => {});
  try { assert.equal((await child.wait('barrier')).phase, interruption); }
  finally { await child.kill(); await sent; }
  const before = inspectRoot(root), files = await inventory(root, retainedDirectories);
  assert.equal(before.version, 16);
  let absentObject;
  if (interruption === 'deletion-work-unlink-intent') {
    assert.equal(before.tables.deletion_files.find(row => row.path === file).state, 'unlinking');
  } else {
    absentObject = before.tables.deletion_objects.find(row => row.state === 'unlinking');
    assert(absentObject, 'An object unlink intent committed before the crash');
    await assert.rejects(lstat(join(root, 'objects/sha256', absentObject.hash.slice(7, 9), absentObject.hash.slice(7))), {code: 'ENOENT'});
  }
  assert.deepEqual(await readFile(file), bytes);

  await installSchema18Packet(root);
  const paused = pausedOpen(root, 'after-activation');
  let migration, manifest;
  try {
    await paused.reached;
    const after = inspectRoot(root);
    assertOriginalRows(after, before);
    assertPins(root, after, before, files);
    migration = JSON.parse(after.tables.schema_migrations.find(row => row.version === 17).receipt);
    manifest = JSON.parse(await readFile(join(root, migration.manifestFile), 'utf8'));
    assert.deepEqual(inspect(join(root, migration.backup)), before);
    await assertBackupCopies(root, manifest, files);
  } finally {
    paused.release();
    const current = await paused.opening;
    try {
      const receipt = (await current.deletionView('document_1', queue.auth())).receipt;
      const resumed = inspectRoot(root);
      assert.equal(receipt.pendingBytes, '0');
      const retainedObjects = resumed.tables.deletion_objects.filter(row => row.state === 'rescued').reduce((total, row) => total + BigInt(row.byte_length), 0n);
      assert.equal(receipt.retainedBytes, String(retainedObjects + BigInt(bytes.length)), 'Pinned work bytes count exactly once');
      if (interruption === 'deletion-work-unlink-intent') {
        assert.equal(resumed.tables.deletion_files.find(row => row.path === file).state, 'rescued');
      } else {
        assert.equal(resumed.tables.deletion_objects.find(row => row.hash === absentObject.hash).state, 'freed');
        assert(!resumed.tables.deletion_backup_pins.some(row => row.hash === absentObject.hash));
      }
      assert.deepEqual(await readFile(file), bytes);
    } finally { await current.close(); }
  }

  const archive = await restoreAtOriginalRoot(t, root, migration, manifest);
  assert.deepEqual(inspectRoot(root), before);
  await assertPreserved(root, files);
  if (absentObject) await assert.rejects(lstat(join(root, 'objects/sha256', absentObject.hash.slice(7, 9), absentObject.hash.slice(7))), {code: 'ENOENT'});
  const prior = await old.openWriter({root});
  try {
    assert.equal(await prior.document('document_1'), null);
    const receipt = (await prior.deletionView('document_1', queue.auth())).receipt;
    assert.equal(receipt.status, 'cleanup-complete');
    assert.equal(receipt.pendingBytes, '0');
    assert(BigInt(receipt.actualFreedBytes) >= BigInt(bytes.length));
    if (absentObject) {
      assert.equal(inspectRoot(root).tables.deletion_objects.find(row => row.hash === absentObject.hash).state, 'freed');
      await assert.rejects(lstat(join(root, 'objects/sha256', absentObject.hash.slice(7, 9), absentObject.hash.slice(7))), {code: 'ENOENT'});
    }
    await assert.rejects(lstat(file), {code: 'ENOENT'});
    const retried = await prior.queueCommand(encode(collect), queue.auth());
    assert.equal(retried.status, 'accepted');
    assert.deepEqual(await prior.queueCommand(encode(collect), queue.auth()), retried);
    const copied = join(archive, manifest.retainedDirectoryCopies['raster-work'], work.slice(join(root, 'raster-work').length + 1), 'retained-spool');
    assert.deepEqual(await readFile(copied), bytes, 'Old collection cannot consume the archived backup copy');
  } finally { await prior.close(); }
});
}

test('schema17 capacity refusal preserves schema16 pending requests and retained bytes', async t => {
  const fixture = await seed(t), {root, before, files} = fixture;
  await installSchema18Packet(root);
  await assert.rejects(openWriter({root, quotaBytes: '1'}), {code: 'CAPACITY'});
  assert.deepEqual(inspectRoot(root), before);
  await assertPreserved(root, files);
  assert(!(await readdir(root)).some(name => name.startsWith('schema16-backup-')));
  await resumeCurrent(fixture);
  assert.equal(inspectRoot(root).version, 19);
  await assertPreserved(root, files);
});

for (const marker of ['pending-command', 'adapter-staging', 'referenced-raster-plan', 'imported-raster-plan']) {
  test('unversioned schema16 development ' + marker + ' is refused without changing any root bytes', async t => {
    const fixture = await seed(t), {root, before, partial} = fixture;
    // These narrow fixtures inject individual persisted development markers.
    // They exercise the read-only semantic guard before ordinary replay runs.
    const db = new DatabaseSync(join(root, 'metadata.sqlite'));
    try {
      if (marker === 'pending-command') {
        const row = before.tables.portable_preparations[0], request = JSON.parse(row.canonical);
        request.command.body = {type: 'PrepareRequestSource', scope: 'visible-document', layerIds: []};
        const serialized = canonical(request);
        db.prepare('UPDATE portable_preparations SET hash=?,original=?,canonical=? WHERE id=?')
          .run(digest(Buffer.from(serialized)), JSON.stringify(request), serialized, row.id);
      } else if (marker === 'adapter-staging') {
        const row = before.tables.staged_assets.find(row => row.id === partial.stagingId), record = JSON.parse(row.json);
        record.purpose = 'adapter'; record.mediaType = 'application/octet-stream';
        db.prepare('UPDATE staged_assets SET json=? WHERE id=?').run(canonical(record), row.id);
      } else {
        const row = before.tables.assets[0], asset = JSON.parse(row.json);
        const bytes = Buffer.from(canonical({schemaVersion: 1, plan: {kind: 'request-source-capture-v1'}}));
        const ref = {hash: digest(bytes), byteLength: String(bytes.length), mediaType: 'application/json'};
        const directory = join(root, 'objects/sha256', ref.hash.slice(7, 9));
        await mkdir(directory, {recursive: true, mode: 0o700});
        await writeFile(join(directory, ref.hash.slice(7)), bytes, {mode: 0o600});
        db.prepare('INSERT INTO objects VALUES (?,?)').run(ref.hash, ref.byteLength);
        asset.raster = {manifest: ref};
        if (marker === 'imported-raster-plan') {
          asset.id = 'schema_guard_imported_asset';
          db.prepare('INSERT INTO portable_namespaces VALUES (?,?,?)').run('schema_guard_import', 'schema_guard_document', canonical(ref));
          db.prepare('INSERT INTO portable_rows VALUES (?,?,?,?)').run('schema_guard_import', 'asset', asset.id, canonical(asset));
        } else {
          db.prepare('UPDATE assets SET json=? WHERE id=?').run(canonical(asset), row.id);
        }
      }
    } finally { db.close(); }
    const unchanged = inspectRoot(root), rootFiles = await inventory(root);
    const databaseBytes = await readFile(join(root, 'metadata.sqlite'));
    await assert.rejects(openWriter({root}), error => {
      assert.equal(error.code, 'UNSUPPORTED_STORAGE');
      assert.equal(error.detail?.issues?.[0]?.code, 'P2_DEVELOPMENT_SCHEMA_REQUIRES_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP');
      return true;
    });
    assert.deepEqual(await readFile(join(root, 'metadata.sqlite')), databaseBytes);
    assert.deepEqual(await inventory(root), rootFiles);
    assert.deepEqual(inspectRoot(root), unchanged);
    assert.equal(unchanged.version, 16);
    assert(!(await readdir(root)).some(name => name.startsWith('schema16-backup-')));
  });
}

for (const target of ['backup-written', 'database', 'manifest', 'retained-file']) {
  test('schema17 refuses tampered ' + target + ' before activation and retains the failed proof', async t => {
    const fixture = await seed(t), {root, before, files} = fixture;
    await installSchema18Packet(root);
    const paused = pausedOpen(root, target === 'backup-written' ? 'backup-written' : 'before-activation');
    const rejected = assert.rejects(paused.opening, {code: 'CORRUPT_STORE'});
    let path, failure;
    try {
      await paused.reached;
      const name = (await readdir(root)).find(name => target === 'manifest' || target === 'retained-file'
        ? /^schema16-backup-.*\.manifest\.json$/.test(name)
        : /^schema16-backup-.*\.sqlite$/.test(name));
      assert(name, 'Migration exposed the expected backup proof');
      path = join(root, name);
      if (target === 'retained-file') {
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        path = join(root, manifest.retainedFiles.find(file => BigInt(file.bytes) > 0n).path);
        await writeFile(path, 'Changed immutable rollback file');
      } else if (target === 'manifest') await writeFile(path, '{}');
      else {
        const db = new DatabaseSync(path);
        try { db.prepare("UPDATE meta SET value='999' WHERE key='writerEpoch'").run(); }
        finally { db.close(); }
      }
    } catch (error) { failure = error; }
    finally {
      paused.release();
      try { await rejected; }
      finally { const writer = await paused.opening.catch(() => null); await writer?.close(); }
    }
    if (failure) throw failure;
    assert.deepEqual(inspectRoot(root), before);
    await assertPreserved(root, files);
    const changed = digest(await readFile(path));
    await resumeCurrent(fixture);
    assert.equal(inspectRoot(root).version, 19);
    assert.equal(digest(await readFile(path)), changed, 'A retry does not overwrite the rejected backup evidence');
    await assertPreserved(root, files);
  });
}

for (const phase of ['before-backup', 'backup-written', 'backup-verified', 'before-activation', 'after-activation']) {
  test('schema17 SIGKILL at ' + phase + ' preserves original pending identity and retained files', async t => {
    const fixture = await seed(t), {root, before, files} = fixture;
    await killAt(t, root, phasePrefix + phase);
    const after = inspectRoot(root);
    assert.equal(after.version, phase === 'after-activation' ? 18 : 16);
    assertOriginalRows(after, before);
    if (phase === 'after-activation') assertPins(root, after, before, files);
    await assertPreserved(root, files);
    await resumeCurrent(fixture);
    assert.equal(inspectRoot(root).version, 19);
    await assertPreserved(root, files);
  });
}

async function killAt(t, root, phase) {
  await installSchema18Packet(root);
  const directory = await rootFor(t), script = join(directory, 'p2-schema-kill.mjs');
  await writeFile(script, `import {openWriter} from ${JSON.stringify(new URL('../../dist/local/server/storage/writer.js', import.meta.url).href)};
await openWriter({root: process.argv[2]}, {phase: process.argv[3], gate: new SharedArrayBuffer(4), onBarrier: phase => process.send({phase})});
`);
  const child = fork(script, [root, phase], {
    execArgv: ['--import', resolve('tests/store/no-network.mjs')],
    env: {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR},
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ended = once(child, 'exit');
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('schema17 barrier timeout: ' + errors)), 15000);
      child.once('message', message => {
        clearTimeout(timer);
        if (message.phase !== phase) reject(Error('Unexpected schema17 barrier: ' + JSON.stringify(message)));
        else resolve();
      });
      child.once('exit', () => { clearTimeout(timer); reject(Error('schema17 early exit: ' + errors)); });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
  }
}

// Admission/identity tests only. These deliberately do not construct a WC
// workload and cannot be counted as C10 or I12C execution evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateSeal, safeRelative, fileIdentity, loadFixture, runCell, createPortableFixture, portableInputIdentity, PORTABLE_FAULTS } from '../../tooling/qualification/campaigns/backend-portable.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const identity = value => ({ sha256: sha(value), byteLength: String(Buffer.byteLength(value)) });
const features = Object.fromEntries(['originals', 'retainedCandidates', 'rawCaptions', 'derivedCaptions', 'editableText', 'licensedFonts', 'frozenLayouts', 'contributions', 'adapters'].map(name => [name, [sha(name)]]));
const base = () => ({ schemaVersion: 1, kind: 'ideogram-wc-fixture', workload: 'WC512', documentId: 'document_1',
  counts: { closureBytes: '536870912', events: 10000, assets: 1000, captionVersions: 1 }, features,
  archive: { path: 'fixture.zip', ...identity('zip') }, files: [{ path: 'metadata.sqlite', ...identity('db') }] });
const invalid = seal => assert.throws(() => validateSeal(seal, 'WC512'), { code: 'FIXTURE_REQUIRED' });
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'wc-contract-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('WC admission refuses byte, event, or asset count stand-ins', () => {
  for (const [key, value] of [['closureBytes', '1024'], ['events', 9999], ['assets', 999]]) {
    const seal = base(); seal.counts[key] = value; invalid(seal);
  }
  assert.equal(validateSeal(base(), 'WC512').counts.closureBytes, '536870912');
});

test('stress admission requires the independent 4GiB/100k/10k workload and caption history', () => {
  const seal = base(); seal.workload = 'WC4G'; seal.counts = { closureBytes: '4294967296', events: 100000, assets: 10000, captionVersions: 4095 };
  assert.throws(() => validateSeal(seal, 'WC4G'), /caption version closure/);
  seal.counts.captionVersions = 4096; assert.equal(validateSeal(seal, 'WC4G'), seal);
  seal.counts.captionVersions = 4097; assert.throws(() => validateSeal(seal, 'WC4G'), /exactly 4096/);
  assert.throws(() => validateSeal(seal, 'WC512'), /selected size/);
});

test('a portable seal cannot silently omit a required mixed closure category', () => {
  for (const name of Object.keys(features)) {
    const seal = base(); seal.features = { ...seal.features, [name]: [] }; invalid(seal);
  }
});

test('seal paths reject escape, duplicate identity, symlink-like syntax and live WAL', () => {
  for (const path of ['/tmp/outside', '../outside', 'a/../outside', 'a\\b', 'a//b', './metadata.sqlite', '']) assert.equal(safeRelative(path), false, path);
  assert.equal(safeRelative('objects/sha256/ab/abcdef'), true);
  const duplicate = base(); duplicate.files.push({ ...duplicate.files[0] }); invalid(duplicate);
  for (const name of ['metadata.sqlite-wal', 'metadata.sqlite-shm']) { const seal = base(); seal.files.push({ path: name, ...identity('wal') }); invalid(seal); }
  const traversal = base(); traversal.archive.path = '../fixture.zip'; invalid(traversal);
});

test('stream identity accepts exact ordinary bytes and refuses symlinks', async t => {
  const root = await directory(t), path = join(root, 'owned'); await writeFile(path, 'exact bytes');
  assert.deepEqual(await fileIdentity(path), identity('exact bytes'));
  const link = join(root, 'alias'); await symlink(path, link);
  await assert.rejects(fileIdentity(link), { code: 'FIXTURE_IDENTITY' });
});

test('fixture preliminary verification covers every sealed source file and archive', async t => {
  const root = await directory(t), store = join(root, 'store'); await mkdir(store);
  await writeFile(join(store, 'metadata.sqlite'), 'db'); await writeFile(join(root, 'fixture.zip'), 'zip');
  const sealBytes = JSON.stringify(base()), sealPath = join(root, 'seal.json'); await writeFile(sealPath, sealBytes);
  const fixture = { root: store, seal: { path: sealPath, sha256: sha(sealBytes) } };
  const loaded = await loadFixture(fixture, 'WC512'); assert.equal(loaded.sealIdentity, sha(sealBytes));
  await writeFile(join(root, 'fixture.zip'), 'bad'); await assert.rejects(loadFixture(fixture, 'WC512'), /SHA-256 mismatch/);
});

test('a new unsealed root file and a changed manifest both invalidate reset evidence', async t => {
  const root = await directory(t), store = join(root, 'store'); await mkdir(store);
  await writeFile(join(store, 'metadata.sqlite'), 'db'); await writeFile(join(root, 'fixture.zip'), 'zip');
  const sealBytes = JSON.stringify(base()), sealPath = join(root, 'seal.json'); await writeFile(sealPath, sealBytes);
  const fixture = { root: store, seal: { path: sealPath, sha256: sha(sealBytes) } };
  await writeFile(join(store, 'unsealed'), 'extra'); await assert.rejects(loadFixture(fixture, 'WC512'), /unsealed files/);
  await writeFile(sealPath, sealBytes + ' '); await assert.rejects(loadFixture(fixture, 'WC512'), /seal hash mismatch/);
});

test('unknown operations and absent qualified input return explicit inconclusive results', async t => {
  const output = await directory(t);
  const unknown = await runCell({ repo: process.cwd(), output }, { operation: 'invented', workload: 'WC512' });
  assert.equal(unknown.status, 'inconclusive'); assert.match(unknown.missing.join(' '), /direction/);
  const missing = await runCell({ repo: process.cwd(), output }, { operation: 'copy-out', workload: 'WC512' });
  assert.equal(missing.status, 'inconclusive'); assert(missing.missing.length); assert.equal(missing.evidence.length, 0);
});

test('failure inventory retains five independent mechanisms for both directions', () => {
  assert.deepEqual(PORTABLE_FAULTS, ['missing-closure', 'font-restriction', 'hash-mismatch', 'disk-pressure', 'interruption']);
  assert.equal(new Set(['copy', 'import'].flatMap(direction => PORTABLE_FAULTS.map(fault => direction + ':' + fault))).size, 10);
});

test('canonical inventory fields select copy/import/failure directions without inventing a smaller workload', async t => {
  const output = await directory(t), context = { repo: process.cwd(), output };
  for (const cell of [
    { operation: 'portable.copy', workload: 'WC', parameters: { closureBytes: 536870912 } },
    { operation: 'portable.import', workload: 'WC', parameters: { closureBytes: 4294967296 } },
    { operation: 'portable.failure', workload: 'WC', parameters: { direction: 'export', scenario: 'missing-closure' } },
    { operation: 'portable.failure', workload: 'WC', parameters: { direction: 'import', scenario: 'interruption' } },
  ]) {
    const result = await runCell(context, cell);
    assert.equal(result.status, 'inconclusive');
    assert.doesNotMatch(result.missing.join(' '), /Unknown portable direction|Unknown portable fault/);
  }
  const smaller = await runCell(context, { operation: 'portable.copy', workload: 'WC', parameters: { closureBytes: 1024 } });
  assert.match(smaller.missing.join(' '), /exactly 512MiB or 4GiB/);
});

test('retained portable factory does not invent writer startup when its sealed fixture is absent', async t => {
  const output = await directory(t), cell = { operation: 'portable.copy', workload: 'WC', parameters: { closureBytes: 536870912 } };
  const fixture = await createPortableFixture({ repo: process.cwd(), output }, cell);
  assert.equal(fixture.portable, true);
  const initial = await fixture.resetCell(cell, { ordinal: 0, prime: true });
  assert.equal(initial.status, 'pass'); assert.deepEqual(initial.phases, []);
  const result = await fixture.runCell({ output }, cell);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.evidence.some(item => item.kind === 'retained-writer-start'), false);
  await fixture.close(); await fixture.close();
});

test('one retained writer cannot change direction, workload size or fault scenario', async t => {
  const output = await directory(t), cell = { operation: 'portable.copy', workload: 'WC', parameters: { closureBytes: 536870912 } };
  const fixture = await createPortableFixture({ repo: process.cwd(), output }, cell);
  for (const changed of [
    { ...cell, operation: 'portable.import' },
    { ...cell, parameters: { closureBytes: 4294967296 } },
    { operation: 'portable.failure', workload: 'WC', parameters: { direction: 'export', scenario: 'interruption' } },
  ]) {
    await assert.rejects(fixture.resetCell(changed), { code: 'PORTABLE_COHORT_CHANGED' });
    await assert.rejects(fixture.runCell({}, changed), { code: 'PORTABLE_COHORT_CHANGED' });
  }
  await fixture.close();
});

test('retained portable owner rejects overlapping starts and use after close', async t => {
  const output = await directory(t), cell = { operation: 'portable.import', workload: 'WC', parameters: { closureBytes: 536870912 } };
  const fixture = await createPortableFixture({ repo: process.cwd(), output }, cell);
  const running = fixture.runCell({ output }, cell);
  await assert.rejects(fixture.runCell({ output }, cell), { code: 'PORTABLE_COHORT_BUSY' });
  await running; await fixture.close();
  await assert.rejects(fixture.runCell({}, cell), { code: 'CLOSED' });
  await assert.rejects(fixture.resetCell(cell), { code: 'CLOSED' });
});

test('retained cohort captures its cell identity before the caller mutates its manifest object', async t => {
  const output = await directory(t), cell = { operation: 'portable.copy', workload: 'WC', parameters: { closureBytes: 536870912 } };
  const fixture = await createPortableFixture({ repo: process.cwd(), output }, cell);
  cell.operation = 'portable.import'; cell.parameters.closureBytes = 4294967296;
  await assert.rejects(fixture.resetCell(cell), { code: 'PORTABLE_COHORT_CHANGED' });
  assert.equal((await fixture.resetCell()).status, 'pass');
  await fixture.close();
});

test('WC source digest includes transaction, record and root ancestry beyond equal payloads and counts', () => {
  // Real SQLite rows exercise the source-digest function. This small index is
  // not a valid WC archive and is never evidence of full workload execution.
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE entities(kind TEXT,id TEXT,json TEXT,record_hash TEXT,PRIMARY KEY(kind,id)) STRICT;
      CREATE TABLE events(seq TEXT PRIMARY KEY,tx TEXT,json TEXT) STRICT;
      CREATE TABLE refs(hash TEXT PRIMARY KEY,bytes TEXT,media TEXT) STRICT;
      CREATE TABLE transactions(archive TEXT,id TEXT,command_id TEXT,first_seq TEXT,last_seq TEXT,json TEXT,PRIMARY KEY(archive,id)) STRICT;
      CREATE TABLE records(hash TEXT PRIMARY KEY,kind TEXT,id TEXT,json TEXT) STRICT;
      CREATE TABLE portable_roots(kind TEXT,id TEXT,hash TEXT,PRIMARY KEY(kind,id)) STRICT;
      CREATE TABLE dependency_edges(owner TEXT,kind TEXT,id TEXT,hash TEXT,PRIMARY KEY(owner,kind,id,hash)) STRICT;
    `);
    const blobHash='sha256:'+sha('unchanged object bytes'),recordHash='sha256:'+sha('original entity record'),dependencyHash='sha256:'+sha('original dependency'),otherHash='sha256:'+sha('changed ancestry');
    db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('document','doc',JSON.stringify({id:'doc',revision:'1'}),recordHash);
    db.prepare('INSERT INTO events VALUES (?,?,?)').run('1','tx',JSON.stringify({eventId:'event',transactionId:'tx',workspaceSeq:'1'}));
    db.prepare('INSERT INTO refs VALUES (?,?,?)').run(blobHash,'22','application/octet-stream');
    const transaction={schemaVersion:1,kind:'transaction',sourceArchive:null,receipt:{status:'accepted',commandId:'command',fromSeq:'1',toSeq:'1',documentRevision:'1',transactionId:'tx'},eventCount:'1',eventsHash:'sha256:'+sha('event')};
    db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?)').run('','tx','command','1','1',JSON.stringify(transaction));
    db.prepare('INSERT INTO records VALUES (?,?,?,?)').run(recordHash,'document','doc',JSON.stringify({kind:'entity',logicalId:'doc',dependencies:[]}));
    db.prepare('INSERT INTO portable_roots VALUES (?,?,?)').run('document','doc',recordHash);
    db.prepare('INSERT INTO dependency_edges VALUES (?,?,?,?)').run(recordHash,'asset','original-asset',dependencyHash);
    const manifest={formatVersion:13,documentSchema:13,sourceNamespace:'source-namespace',complete:true,capturedHighWater:'1',segments:[{path:'records/0.jsonl'}]};
    const payloadRows=()=>({entities:db.prepare('SELECT kind,id,json FROM entities ORDER BY kind,id').all(),events:db.prepare('SELECT * FROM events ORDER BY seq').all(),refs:db.prepare('SELECT * FROM refs ORDER BY hash').all()});
    const originalRows=payloadRows(),originalDigest=portableInputIdentity(db,manifest);
    const mutations=[
      ['transaction provenance',()=>db.prepare('UPDATE transactions SET archive=?,json=?').run(otherHash,JSON.stringify({...transaction,sourceArchive:otherHash}))],
      ['entity record identity',()=>db.prepare('UPDATE entities SET record_hash=?').run(otherHash)],
      ['record dependency envelope',()=>db.prepare('UPDATE records SET json=?').run(JSON.stringify({kind:'entity',logicalId:'doc',dependencies:[{kind:'asset',logicalId:'original-asset',recordHash:dependencyHash}]}))],
      ['declared root identity',()=>db.prepare('UPDATE portable_roots SET hash=?').run(otherHash)],
      ['dependency ancestry',()=>db.prepare('UPDATE dependency_edges SET hash=?').run(otherHash)],
    ];
    for(const [name,mutate] of mutations){
      db.exec('SAVEPOINT changed_ancestry');
      try {
        mutate();
        assert.deepEqual(payloadRows(),originalRows,`${name}: entity payloads, events, references and their counts stayed equal`);
        assert.notEqual(portableInputIdentity(db,manifest),originalDigest,`${name} must change exact source identity`);
      } finally {db.exec('ROLLBACK TO changed_ancestry');db.exec('RELEASE changed_ancestry');}
      assert.equal(portableInputIdentity(db,manifest),originalDigest,'Rollback restores the exact baseline identity');
    }
    for(const field of ['formatVersion','documentSchema','sourceNamespace','complete']) {
      const changed={...manifest,[field]:field==='complete'?false:typeof manifest[field]==='number'?manifest[field]-1:'another-namespace'};
      assert.notEqual(portableInputIdentity(db,changed),originalDigest,`${field} is source identity`);
    }
    assert.equal(portableInputIdentity(db,{...manifest,capturedHighWater:'999',segments:[{path:'records/repacked.jsonl'}]}),originalDigest,
      'Declared global high-water and segment packaging exclusions do not erase source ancestry checks');
    const canceled=new Error('cancel source walk');let calls=0;
    assert.throws(()=>portableInputIdentity(db,manifest,()=>{calls++;throw canceled;}),error=>error===canceled);
    assert.equal(calls,1,'The actual row walk observes cancellation');
  } finally {db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chmod,readFile,writeFile,symlink,mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { startLocalServer } from '../../dist/local/server/http.js';
import { rootFor, command, checkpoint, encode, expectedBytes, refFor } from '../store/helpers.mjs';
import { pair,call,cookieFrom,readHeaders } from '../session/helpers.mjs';
import { largeTransaction } from './fixtures.mjs';
const storedPath=(root,ref)=>join(root,'objects/sha256',ref.hash.slice(7,9),ref.hash.slice(7));

test('PROTO04 large complete transaction uses immutable reference; interior cursor rejected and restart replay agrees',async t=>{
  const root=await rootFor(t);const fixture=await largeTransaction(root);const server=await startLocalServer({root});t.after(()=>server.close());const paired=await pair(server);
  const read=(path,headers={})=>call(server.origin,path,{headers:{...readHeaders(cookieFrom(paired)),...headers}});
  const first=(await read('/api/v1/events?after=0')).json;assert.equal(first.nextCursor,'1');assert.equal(first.more,true);
  const next=(await read('/api/v1/events?after=1&recoveryId='+first.recovery.recoveryId)).json;const ref=next.batches[0];
  assert.equal(ref.kind,'transaction-ref');assert.equal(ref.eventCount,String(fixture.count));assert.equal(ref.fromSeq,'2');assert.equal(ref.toSeq,'81');assert.ok(Number(ref.content.blob.byteLength)>65536);
  assert.ok(Buffer.byteLength(JSON.stringify(next))<=65536);const bytes=await read(ref.content.url);assert.equal(bytes.status,200);
  assert.equal('sha256:'+createHash('sha256').update(bytes.text).digest('hex'),ref.content.blob.hash);assert.equal(bytes.text.trim().split('\n').length,80);
  const middle=await read('/api/v1/events?after=2');assert.equal(middle.status,409);assert.deepEqual(middle.json.error.details.value,{kind:'cursor',requestedAfter:'2',transactionFrom:'2',transactionTo:'81'});
  const view=(await read('/api/v1/documents/document_1')).json;assert.equal(view.entityVersion,'81');
  await server.close();const reopened=await openWriter({root});t.after(()=>reopened.close());assert.deepEqual(await reopened.document('document_1'),view.projection.value);
});

test('R23 corrupt latest snapshot falls back to prior snapshot, then full log; failed snapshots backpressure only the 500-event tail',async t=>{
  const root=await rootFor(t);let writer=await openWriter({root});t.after(()=>writer.close());const ref=await writer.putObject([expectedBytes],refFor(expectedBytes),writer.epoch);
  await writer.submit(encode(command(ref)),writer.epoch);
  for(let i=1;i<501;i++)assert.equal((await writer.submit(encode(checkpoint(ref,String(i))),writer.epoch)).status,'accepted');
  const before=await writer.document('document_1');assert.equal((await writer.capture()).snapshot.seq,'500');await writer.close();
  let db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});const snapshots=db.prepare('SELECT descriptor FROM snapshots ORDER BY length(seq),seq').all().map(r=>JSON.parse(r.descriptor));db.close();
  await writeFile(storedPath(root,snapshots[1].content.blob),'corrupt',{mode:0o600});
  writer=await openWriter({root});assert.equal((await writer.capture()).snapshot.seq,'250');assert.deepEqual(await writer.document('document_1'),before);await writer.close();
  await writeFile(storedPath(root,snapshots[0].content.blob),'also corrupt',{mode:0o600});
  writer=await openWriter({root});assert.equal((await writer.capture()).snapshot,null);assert.deepEqual(await writer.document('document_1'),before);
  const next=await writer.submit(encode(checkpoint(ref,'501')),writer.epoch);assert.equal(next.status,'accepted');assert.equal((await writer.capture()).snapshot.seq,'501');await writer.close();
  const pressureRoot=await rootFor(t);writer=await openWriter({root:pressureRoot});await writer.putObject([expectedBytes],refFor(expectedBytes),writer.epoch);await writer.submit(encode(command(ref)),writer.epoch);await writer.close();
  db=new DatabaseSync(join(pressureRoot,'metadata.sqlite'));db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT,'injected snapshot storage failure'); END");db.close();
  writer=await openWriter({root:pressureRoot});for(let i=1;i<500;i++)assert.equal((await writer.submit(encode(checkpoint(ref,String(i))),writer.epoch)).status,'accepted');
  const rejected=await writer.submit(encode(checkpoint(ref,'500')),writer.epoch);assert.equal(rejected.code,'CAPACITY');assert.match(Buffer.from(await writer.readMetadata(rejected.details)).toString(),/SNAPSHOT_REQUIRED/);assert.equal((await writer.diagnostics()).observations.snapshot.pressure,true);await writer.close();
  db=new DatabaseSync(join(pressureRoot,'metadata.sqlite'));assert.equal(db.prepare('SELECT count(*) n FROM events_v2').get().n,500);db.exec('DROP TRIGGER fail_snapshot');db.close();
  writer=await openWriter({root:pressureRoot});assert.equal((await writer.submit(encode(checkpoint(ref,'500')),writer.epoch)).status,'accepted');assert.equal((await writer.capture()).snapshot.seq,'500');
});

test('schema2 migration opens a real e1a0092 fixture with verified backup, unchanged events/receipts/history and duplicate identity',async t=>{
  const root=await rootFor(t);const source=await rootFor(t);const archive=execFileSync('git',['archive','e1a0092eeb0022c445bb348d0602fa0a727c3aee','server','src','tooling','tsconfig.server.json']);
  await writeFile(join(source,'source.tar'),archive,{mode:0o600});execFileSync('tar',['-xf',join(source,'source.tar'),'-C',source]);await symlink(join(process.cwd(),'node_modules'),join(source,'node_modules'));
  await writeFile(join(source,'package.json'),'{"type":"module"}',{mode:0o600});execFileSync(join(process.cwd(),'node_modules/.bin/tsc'),['-p',join(source,'tsconfig.server.json')]);
  const script=`import {openWriter} from './dist/local/server/storage/writer.js';import {writeFile} from 'node:fs/promises';\nconst w=await openWriter({root:process.argv[2]});const bytes=Buffer.from('${expectedBytes.toString()}');const ref=await w.putObject([bytes],{byteLength:String(bytes.length),mediaType:'application/json'},w.epoch);const command=${JSON.stringify(command(refFor(expectedBytes)))};const receipt=await w.submit(Buffer.from(JSON.stringify(command)),w.epoch);const document=await w.document('document_1');const history=await w.history(document.historyHead);await writeFile(process.argv[3],JSON.stringify({command,receipt,document,history}),{mode:0o600});await w.close();`;
  await writeFile(join(source,'seed.mjs'),script,{mode:0o600});execFileSync(process.execPath,[join(source,'seed.mjs'),root,join(source,'fixture.json')],{env:{PATH:process.env.PATH}});
  const fixture=JSON.parse(await readFile(join(source,'fixture.json'),'utf8'));const writer=await openWriter({root});t.after(()=>writer.close());
  assert.deepEqual(await writer.document('document_1'),fixture.document);assert.deepEqual(await writer.history(fixture.document.historyHead),fixture.history);assert.deepEqual(await writer.submit(encode(fixture.command),writer.epoch),fixture.receipt);await writer.close();
  const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
  const migration=JSON.parse(db.prepare('SELECT receipt FROM schema_migrations WHERE version=2').get().receipt);assert.equal(migration.from,1);assert.equal(migration.manifest.events.count,'1');
  assert.deepEqual(db.prepare('SELECT * FROM events').all(),db.prepare('SELECT * FROM events_v2').all());const backup=new DatabaseSync(join(root,migration.backup),{readOnly:true});assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(backup.prepare('PRAGMA user_version').get().user_version,1);assert.deepEqual(backup.prepare('SELECT * FROM commands').all(),db.prepare('SELECT * FROM commands').all());backup.close();db.close();
});

test('I-P01 warm snapshot admission detects changed bytes and external root metadata; reads verify and recover pinned state',async t=>{
  const root=await rootFor(t);const w=await openWriter({root});t.after(()=>w.close());const ref=await w.putObject([expectedBytes],refFor(expectedBytes),w.epoch);
  await w.submit(encode(command(ref)),w.epoch);for(let i=1;i<250;i++)await w.submit(encode(checkpoint(ref,String(i),'n'.repeat(8000))),w.epoch);
  const first=(await w.capture()).snapshot;assert.equal(first.seq,'250');
  const bytes=await readFile(storedPath(root,first.content.blob));bytes[bytes.length-2]^=1;await writeFile(storedPath(root,first.content.blob),bytes);
  assert.equal((await w.submit(encode(checkpoint(ref,'250')),w.epoch)).status,'accepted');
  const second=(await w.capture()).snapshot;assert.equal(second.seq,'250');assert.notEqual(second.id,first.id);
  await assert.rejects(w.snapshotContent(first.id));
  const db=new DatabaseSync(join(root,'metadata.sqlite'));db.prepare('UPDATE snapshots SET roots_hash=? WHERE id=?').run('bad',second.id);db.close();
  assert.equal((await w.submit(encode(checkpoint(ref,'251')),w.epoch)).status,'accepted');
  const third=(await w.capture()).snapshot;assert.equal(third.seq,'251');assert.notEqual(third.id,second.id);await assert.rejects(w.snapshotContent(second.id));
  assert.equal((await w.document('document_1')).revision,'252');
  const diagnostics=await w.diagnostics();assert.equal(diagnostics.highWater,'252');assert.equal(diagnostics.observations.snapshot.pressure,false);
  assert.ok(diagnostics.observations.snapshot.buildMs>0);assert.ok(diagnostics.observations.snapshot.sliceMaxMs>0);
});

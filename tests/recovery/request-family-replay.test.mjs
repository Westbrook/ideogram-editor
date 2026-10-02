// Source-only staged regression. Run from tests/recovery only after reviewed
// source promotion and the coordinated server build; no runtime result is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fixture,prepare,enqueue,auth,caption,encode} from '../queue/helpers.mjs';
import {canonical} from '../../dist/local/server/storage/canonical.js';

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const file=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const inspect=root=>{
  const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});
  try{return {
    version:db.prepare('PRAGMA user_version').get().user_version,
    migration:JSON.parse(db.prepare('SELECT receipt FROM schema_migrations WHERE version=18').get().receipt),
    successor:JSON.parse(db.prepare('SELECT receipt FROM schema_migrations WHERE version=19').get().receipt),
    commands:db.prepare('SELECT id,hash,original,canonical,receipt FROM commands ORDER BY id').all(),
    reviews:db.prepare('SELECT client_id,id,hash,json FROM ui_receipts ORDER BY client_id,id').all(),
    journal:db.prepare('SELECT seq,json FROM queue_journal ORDER BY seq').all(),
  };}finally{db.close();}
};

test('fresh schema19 keeps exact18 authority and has no invented rollback and retains an exact V4 review, template, receipt and queued attempt after replay',async t=>{
  const f=await fixture(t,{width:512,height:512});
  const accepted=await prepare(f.writer,d=>{
    d.fields.size='custom';d.fields.width='512';d.fields.height='512';
    d.fields.seed='9007199254740993';d.fields.expansion='Large';
  });
  assert.equal(accepted.review.kind,'request-review-1');
  assert.equal(accepted.review.request.kind,'generate');
  assert.equal(accepted.review.endpoint,'ideogram/v4');
  assert.equal(Object.hasOwn(accepted.review,'providerReview'),false);
  const queued=await enqueue(f.writer,accepted.body);
  const saved=(await f.writer.uiRead('request_session',auth())).drafts.find(d=>d.id==='queue_draft');
  const draftAsset=await f.writer.assetProjection(saved.assetId),draftRef=draftAsset.asset.blob;
  const identities=[draftRef,accepted.review.prompt,accepted.review.template];
  const bytes=await Promise.all(identities.map(ref=>readFile(file(f.root,ref))));
  const draft=JSON.parse(bytes[0]);assert.equal(draft.kind,'request-draft-1');
  assert.notEqual(bytes[0].toString('utf8'),canonical(draft),'Authored JSON ordering is intentionally noncanonical');
  assert.match(bytes[2].toString('utf8'),/"seed":9007199254740993(?:,|})/,'Large seed token remains exact rather than a parsed JS number');
  const lookalike=await caption(f.writer,'{"kind":"request-draft-v45-1","operation":"generate-v45"}');
  const lookalikeBytes=await readFile(file(f.root,lookalike.blob));
  await f.close();const before=inspect(f.root);
  assert.equal(before.version,19);assert.equal(before.migration.capability,'editor-contracts-18-v1');
  assert.equal(before.successor.capability,'composition-text-contracts-19-v1');
  for(const receipt of [before.migration,before.successor])for(const key of ['backup','backupHash','manifestFile','rollback'])assert.equal(receipt[key],null,key);
  assert(!(await readdir(f.root)).some(name=>name.startsWith('schema17-backup-')||name.startsWith('schema18-backup-')));
  await f.reopen();
  const retained=(await f.writer.queueView()).jobs.find(job=>job.id===queued.job.id);
  assert.deepEqual(retained,queued.job,'Restart cannot relabel a V4 job or replace its attempt');
  assert.deepEqual(await f.writer.queueCommand(encode(queued.request),auth()),queued.receipt,'Exact retry returns its original V4 receipt');
  for(const [index,ref] of identities.entries()){
    const actual=await readFile(file(f.root,ref));assert.equal(hash(actual),ref.hash);assert.deepEqual(actual,bytes[index]);
  }
  assert.deepEqual(await readFile(file(f.root,lookalike.blob)),lookalikeBytes,'Unattached authored captions do not become V45 controls');
  const after=inspect(f.root);assert.equal(after.version,19);assert.deepEqual(after.migration,before.migration);assert.deepEqual(after.successor,before.successor);assert.deepEqual(after.commands,before.commands);assert.deepEqual(after.reviews,before.reviews);assert.deepEqual(after.journal,before.journal);
});

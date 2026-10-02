import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {rootFor,zeroEffects} from './helpers.mjs';

const ENVELOPE=134217728;
const realm='11111111-1111-4111-8111-111111111111';
const otherRealm='22222222-2222-4222-8222-222222222222';
const admission=(generation=1,owner=realm)=>owner+'_'+generation+'_70000000';
const owner=()=>({clientId:'client_1',sessionHash:'a'.repeat(64),now:Date.now(),expires:Date.now()+60000});

async function fixture(t){
  // Node runs after hooks in registration order. The fixture must finish its
  // final counter write before rootFor removes the private root.
  let writer;t.after(()=>writer?.close());
  const root=await rootFor(t),effects=globalThis.__storeNetworkCounters;
  assert.ok(effects,'Run with the existing tests/store/no-network.mjs preload');
  writer=await openWriter({root},{effectCounters:effects.shared,setupModule:new URL('./text-admission-once-fixture.mjs',import.meta.url).href});
  const f={writer,root,effects,expected:[]};await observe(f,[]);return f;
}
const ownedRow=(f,id,auth)=>({id,client_id:auth.clientId,session_hash:auth.sessionHash,epoch:f.writer.epoch});
async function observe(f,rows){
  // textAdmission replies before the buggy trailing dispatch. A subsequent
  // real worker roundtrip ensures all post-reply synchronous work has run.
  const diagnosticRead=await f.writer.readDiagnostics();
  try{void diagnosticRead.value;}finally{diagnosticRead.release();} // Message-order barrier only; no diagnostic graph escapes.
  const value=JSON.parse(await readFile(join(f.root,'text-admission-once.json'),'utf8'));
  assert.equal(value.closed,false);assert.deepEqual(value.calls,f.expected);
  assert.equal(value.externalBytes,rows.length*ENVELOPE);
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
  try{assert.deepEqual(db.prepare('SELECT id,client_id,session_hash,epoch FROM text_admissions ORDER BY id').all().map(row=>({...row})),rows);}finally{db.close();}
  assert.deepEqual(value.effects,zeroEffects);assert.deepEqual(f.effects.read(),zeroEffects);
}
async function step(f,id,auth,{release=false,error=null,rows=[]}={}){
  const result=f.writer.textAdmission(id,auth,release);
  if(error)await assert.rejects(result,{code:error});
  else assert.deepEqual(await result,release?undefined:{id,bytes:ENVELOPE});
  f.expected.push({method:release?'releaseAdmission':'admission',id,outcome:error??'accepted'});
  await observe(f,rows);
}
async function close(f){
  await f.writer.close();const value=JSON.parse(await readFile(join(f.root,'text-admission-once.json'),'utf8'));
  assert.equal(value.closed,true);assert.deepEqual(value.calls,f.expected);assert.equal(value.externalBytes,0);
  assert.deepEqual(value.effects,zeroEffects);assert.deepEqual(f.effects.read(),zeroEffects);
}

test('the writer invokes real text admission and release once per successful request and retry',async t=>{
  const f=await fixture(t),auth=owner(),id=admission(),rows=[ownedRow(f,id,auth)];
  await step(f,id,auth,{rows});
  await step(f,id,auth,{rows});
  await step(f,id,auth,{release:true});
  await step(f,id,auth,{release:true});
  await close(f);
});

test('rejected text admission ownership requests leave the active reservation intact',async t=>{
  const f=await fixture(t),auth=owner(),id=admission(),rows=[ownedRow(f,id,auth)],foreign={...auth,clientId:'client_2'},renewed={...auth,sessionHash:'b'.repeat(64)};
  await step(f,id,auth,{rows});
  await step(f,id,foreign,{error:'OWNER_REQUIRED',rows});
  await step(f,id,foreign,{release:true,error:'OWNER_REQUIRED',rows});
  await step(f,id,renewed,{release:true,error:'OWNER_REQUIRED',rows});
  const renewedRows=[ownedRow(f,id,renewed)];
  await step(f,id,renewed,{rows:renewedRows});
  await step(f,id,auth,{release:true,error:'OWNER_REQUIRED',rows:renewedRows});
  await step(f,id,renewed,{release:true});
  await close(f);
});

test('text admission owns one reservation until release or a newer generation supersedes it',async t=>{
  const f=await fixture(t),auth=owner(),first=admission(),second=admission(2),other=admission(1,otherRealm),firstRows=[ownedRow(f,first,auth)],secondRows=[ownedRow(f,second,auth)];
  await step(f,first,auth,{rows:firstRows});
  await step(f,other,auth,{error:'CAPACITY',rows:firstRows});
  await step(f,second,auth,{rows:secondRows});
  await step(f,first,auth,{error:'OWNER_REQUIRED',rows:secondRows});
  await step(f,first,auth,{release:true,rows:secondRows});
  await step(f,second,auth,{release:true});
  await step(f,other,auth,{rows:[ownedRow(f,other,auth)]});
  await step(f,other,auth,{release:true});
  await close(f);
});

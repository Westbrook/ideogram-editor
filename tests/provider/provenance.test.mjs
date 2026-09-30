import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFileSync,statSync,symlinkSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TransportEvidenceStore } from '../../dist/local/server/provider/evidence.js';
import { deriveProvenance,portableCopyRecord,redactedRecoveryRecord } from '../../dist/local/server/provider/provenance.js';
import { storage,capture,assertCode } from './support.mjs';
import { SENTINEL_KEY,SENTINEL_COOKIE } from './emulator.mjs';
function derive(s,bytes,secrets=[]){const source=capture(s.sink(),Buffer.from(bytes));return {source,result:deriveProvenance({store:s.store,source,promptSink:s.sink(),endpoint:'ideogram/v4',requestId:'r1',status:'completed',policy:s.policy,knownTransportSecrets:secrets})};}
test('exact protected bodies stay distinct from allowlisted portable records',t=>{
 const s=storage(t),raw=JSON.stringify({prompt:'line\nquote " / 😀 雨 https://user-authored.test/hello',seed:123,timings:{inference:1.25,bad:-1},
 images:[{url:'https://media.test/a?signature=secret-signature'}],error:SENTINEL_KEY,cookie:SENTINEL_COOKIE,unknown:{secret:'not portable'}});
 const {source,result}=derive(s,raw,[SENTINEL_KEY,SENTINEL_COOKIE]);
 assert.equal(Buffer.concat([...s.store.read(source.recordId)]).toString(),raw);
 assert.equal(source.export,'never');assert.equal(source.access,'backend-only');
 assert.equal(statSync(join(s.root,'backend-transport')).mode&0o777,0o700);
 assert.equal(statSync(join(s.root,'backend-transport',source.recordId+'.body')).mode&0o777,0o600);
 assert.equal(Buffer.concat([...s.store.read(result.prompt.recordId)]).toString(),JSON.parse(raw).prompt);
 const record=portableCopyRecord(result);assert.equal(record.seedText,'123');assert.deepEqual(record.safeTimings,{inference:1.25});
 for(const secret of ['secret-signature',SENTINEL_KEY,SENTINEL_COOKIE,'https://media.test','not portable'])assert.equal(JSON.stringify(record).includes(secret),false);
 assert.equal(record.derivation.sourceBodyHash,createHash('sha256').update(raw).digest('hex'));
});
test('escaped prompt and multibyte Unicode crossing IO pages retain exact decoded UTF-8',t=>{
 const s=storage(t),prompt='a'.repeat(32767)+'😀\n\t"\\雨'+'b'.repeat(32769),raw=JSON.stringify({prompt,seed:1});
 const {result}=derive(s,raw);assert.equal(Buffer.concat([...s.store.read(result.prompt.recordId)]).toString(),prompt);
 assert.equal(result.record.returnedPromptRef.byteLength,String(Buffer.byteLength(prompt)));
});
test('known credential and signed URL fragments quarantine prompt without altering original',t=>{
 const s=storage(t);
 for(const secret of [SENTINEL_KEY,SENTINEL_COOKIE,'signed-token']){
  const prompt='a'.repeat(32765)+secret+'z',raw=JSON.stringify({prompt,images:[{url:'https://media.test/a?sig=signed-token'}]});
  const {source,result}=derive(s,raw,[SENTINEL_KEY,SENTINEL_COOKIE]);
  assert.equal(result.quarantined,true);assertCode(()=>portableCopyRecord(result),'PROVENANCE');
  const recovery=redactedRecoveryRecord(result,'ack-recovery');assert.equal(recovery.complete,false);assert.equal(recovery.sanitized,true);assert.equal(recovery.record.returnedPromptRef,null);
  assert.equal(JSON.stringify(recovery).includes(secret),false);assert.equal(Buffer.concat([...s.store.read(source.recordId)]).toString(),raw);
 }
});
test('returned prompt larger than 16MiB is complete streamed opaque provenance',t=>{
 const s=storage(t),sink=s.sink(),chunk=Buffer.alloc(32768,120);sink.append(Buffer.from('{"prompt":"'));
 for(let i=0;i<513;i++)sink.append(chunk);sink.append(Buffer.from('","seed":123456789012345678901234567890}'));
 const source=sink.finish(true),result=deriveProvenance({store:s.store,source,promptSink:s.sink(),endpoint:'ideogram/v4',requestId:'large',status:'completed',policy:s.policy,knownTransportSecrets:[]});
 assert.equal(result.inspection,'opaque');assert.equal(result.record.returnedPromptRef.byteLength,String(513*32768));
 const hash=createHash('sha256');for(let i=0;i<513;i++)hash.update(chunk);assert.equal(result.prompt.sha256,hash.digest('hex'));
 assert.equal(portableCopyRecord(result).seedText,'123456789012345678901234567890');
});
for(const raw of ['{"prompt":"ok","prompt":"other"}','{"prompt":"\\ud800"}','{"prompt":"ok",bad}', '{"prompt":"abc"', '{"prompt":"abc","seed":1garbage}', '{"prompt":42}'])test('malformed or missing prompt never becomes exact portable closure '+raw,t=>{
 const s=storage(t),{result}=derive(s,raw);assert.equal(result.record.derivation.complete,false);assertCode(()=>portableCopyRecord(result),'PROVENANCE');
});
test('capacity failure preserves partial body, exact retained count and backend-only inventory',t=>{
 const s=storage(t),sink=s.sink(4n);sink.append(Buffer.from('abcd'));assertCode(()=>sink.append(Buffer.from('e')),'CAPACITY');
 const record=sink.finish(false,5n),metadata=s.store.inspect(record.recordId);assert.equal(metadata.receivedBytes,'5');assert.equal(metadata.retainedBytes,'4');assert.equal(metadata.completeness,'partial');
 assert.equal(Buffer.concat([...s.store.read(record.recordId)]).toString(),'abcd');
});
test('symlink roots and caller paths cannot enter protected evidence store',t=>{
 const s=storage(t);symlinkSync(s.root,join(s.root,'alias'));assert.throws(()=>new TransportEvidenceStore(join(s.root,'alias')));
 assertCode(()=>s.store.inspect('../file'),'IDENTITY');
});
test('R31 adapter uses real storage reservations, releases slots, and refuses low capacity',async t=>{
 const s=storage(t);const {Objects}=await import('../../dist/local/server/storage/objects.js');const {r31Reservation}=await import('../../dist/local/server/provider/evidence.js');
 const objects=new Objects(s.root,()=>{},()=>{});const r=r31Reservation(objects,'test-transfer','provider-media',()=>{});
 r.ensure(100n);assert.equal(objects.reservationInventory().reservedBytes,'125');r.committed(40n);assert.equal(objects.reservationInventory().reservedBytes,'75');r.release();r.release();assert.deepEqual(objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});
 const low=new Objects(s.root,()=>{},()=>{},'1');const denied=r31Reservation(low,'denied','provider-media',()=>{});assert.throws(()=>denied.ensure(1n),e=>e.code==='CAPACITY');denied.release();assert.equal(low.reservationInventory().activeTransfers,0);
});
test('saved resume identity survives reopening and cannot be changed by another URL or ETag',t=>{
 const s=storage(t),sink=s.sink();const identity={urlHash:'a'.repeat(64),etag:'"v1"',totalBytes:'10'};
 sink.bindIdentity(identity);sink.append(Buffer.from('abc'));const first=sink.finish(false);
 const reopened=new TransportEvidenceStore(s.root),resumed=reopened.resume(first.recordId,s.reservation());
 assert.deepEqual(resumed.identity,identity);assertCode(()=>resumed.bindIdentity({...identity,etag:'"v2"'}),'IDENTITY');resumed.finish(false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink,symlink} from 'node:fs/promises';
import {unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Objects} from '../../dist/local/server/storage/objects.js';
import {rootFor,refFor} from './helpers.mjs';

test('cooperative proofs distinguish missing and corrupt bytes while retaining unsafe-file refusal',async t=>{
 const root=await rootFor(t),objects=new Objects(root,()=>{},()=>{}),bytes=Buffer.alloc(2*1024*1024,41),ref=refFor(bytes),path=objects.path(ref);
 t.after(()=>objects.close());await mkdir(join(root,'objects','sha256',ref.hash.slice(7,9)),{mode:0o700});
 await assert.rejects(objects.prove(ref,()=>{}),{code:'MISSING_OBJECT'});
 await writeFile(path,Buffer.from('corrupt'),{mode:0o600});await assert.rejects(objects.prove(ref,()=>{}),{code:'CORRUPT_OBJECT'});await unlink(path);
 const outside=join(root,'retained-original');await writeFile(outside,bytes,{mode:0o600});await symlink(outside,path);await assert.rejects(objects.prove(ref,()=>{}),{code:'ROOT_UNSAFE'});await unlink(path);
 await writeFile(path,bytes,{mode:0o600});let checks=0;await assert.rejects(objects.prove(ref,()=>{if(++checks===2)unlinkSync(path);}),{code:'MISSING_OBJECT'});
 await writeFile(path,bytes,{mode:0o600});const proof=await objects.prove(ref,()=>{});objects.proven(ref,proof);objects.releaseProof(proof);
});

import {IO_CHUNK} from '../../dist/local/server/storage/objects.js';
import {adapterResources} from '../../dist/local/server/observability/adapter-resources.js';

// Observe actual verify() bookings while forwarding every real allocation
// observer call and release. These are requested scratch-byte assertions,
// not physical RSS, allocator-release, GC, or native-runtime claims.
function verifyOwnership(){
 const value=adapterResources.snapshot();
 return {backingBytes:value.backingBytes,backingStores:value.backingStores,reservedBytes:value.reservedBytes,activeLeases:value.activeLeases,returnedBuffers:value.returnedBuffers,droppedTransitions:value.droppedTransitions,unscopedReturnedBuffers:value.unscopedReturnedBuffers};
}
function observeVerify(t){
 const rows=[],original=adapterResources.buffer;
 t.mock.method(adapterResources,'buffer',function(owner,kind,value){
  const release=Reflect.apply(original,this,[owner,kind,value]);
  if(owner!=='objects'||!kind.startsWith('verify-'))return release;
  const row={kind,requestedBytes:value.byteLength,backingBytes:value.buffer.byteLength,releases:0};rows.push(row);
  return ()=>{row.releases++;return release();};
 });
 return rows;
}
async function verifyFixture(t){
 const root=await rootFor(t),objects=new Objects(root,()=>{},()=>{});t.after(()=>objects.close());
 return {objects,async put(bytes){const ref=refFor(bytes),path=objects.path(ref);await mkdir(join(root,'objects','sha256',ref.hash.slice(7,9)),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600,flag:'wx'});return {ref,path};}};
}
function assertVerifyScratch(rows,expectedBytes){
 const scratch=rows.filter(row=>row.kind==='verify-buffer');assert.equal(scratch.length,1);
 assert.equal(scratch[0].requestedBytes,Math.min(expectedBytes+1,IO_CHUNK));
 assert.equal(scratch[0].backingBytes,scratch[0].requestedBytes,'The actual dedicated scratch backing has the bounded size');assert.equal(scratch[0].releases,1);
}

for(const size of [0,3,65536,IO_CHUNK-1,IO_CHUNK,IO_CHUNK+1])test('synchronous verification bounds actual scratch for '+size+' bytes and drains it',async t=>{
 const f=await verifyFixture(t),{ref}=await f.put(Buffer.alloc(size,37)),rows=observeVerify(t),before=verifyOwnership();
 assert.equal(f.objects.verify(ref),undefined);assertVerifyScratch(rows,size);assert.equal(rows.length,1);assert.deepEqual(verifyOwnership(),before);assert.equal(f.objects.hasLeases(),false);
});

test('bounded verification scratch still rejects excess bytes at empty, small and chunk boundaries',async t=>{
 const f=await verifyFixture(t),rows=observeVerify(t);
 for(const size of [0,3,IO_CHUNK-1,IO_CHUNK,IO_CHUNK+1]){
  const bytes=Buffer.alloc(size,41),{ref,path}=await f.put(bytes);await writeFile(path,Buffer.concat([bytes,Buffer.from([99])]),{mode:0o600});
  const start=rows.length,before=verifyOwnership();assert.throws(()=>f.objects.verify(ref),{code:'CORRUPT_OBJECT'});
  assertVerifyScratch(rows.slice(start),size);assert.deepEqual(verifyOwnership(),before);assert.equal(f.objects.hasLeases(),false);
 }
});

test('bounded verification scratch preserves truncation and same-length hash corruption checks',async t=>{
 const f=await verifyFixture(t),rows=observeVerify(t);
 for(const size of [3,65536,IO_CHUNK+1]){
  const bytes=Buffer.alloc(size,43),{ref,path}=await f.put(bytes);
  for(const changed of [bytes.subarray(0,-1),Buffer.alloc(size,44)]){
   await writeFile(path,changed,{mode:0o600});
   for(const read of size<=65536?[false,true]:[false]){
    const start=rows.length,before=verifyOwnership();assert.throws(()=>f.objects.verify(ref,read),{code:'CORRUPT_OBJECT'});
    const acquired=rows.slice(start),parts=acquired.filter(row=>row.kind==='verify-part');assertVerifyScratch(acquired,size);
    if(read){assert(parts.length>0,'Failed metadata verification must exercise actual copied part ownership');assert.equal(parts.reduce((bytes,row)=>bytes+row.requestedBytes,0),changed.length);}else assert.equal(parts.length,0);
    assert.equal(acquired.some(row=>row.kind==='verify-result'),false,'A failed hash or length check must not retain a result');assert(acquired.every(row=>row.releases===1));assert.deepEqual(verifyOwnership(),before);
   }
  }
 }
});

test('read verification retains the exact existing 64KiB return cap before scratch allocation',async t=>{
 const f=await verifyFixture(t),{ref}=await f.put(Buffer.alloc(65537,47)),rows=observeVerify(t),before=verifyOwnership();
 assert.throws(()=>f.objects.verify(ref,true),{code:'PAYLOAD_TOO_LARGE'});assert.deepEqual(rows,[]);assert.deepEqual(verifyOwnership(),before);
});

for(const size of [0,3,65536])test('read verification keeps the '+size+'-byte result owned across awaits after scratch drains',async t=>{
 const f=await verifyFixture(t),bytes=Buffer.alloc(size,53),{ref}=await f.put(bytes),rows=observeVerify(t),before=verifyOwnership();
 let continueConsumer,entered;
 const gate=new Promise(resolve=>continueConsumer=resolve),ready=new Promise(resolve=>entered=resolve);
 t.after(()=>continueConsumer());
 const consuming=adapterResources.scope('verify-result-consumer',async()=>{
  let value;
  try{
   value=f.objects.verify(ref,true);
   assert.deepEqual(value,bytes);assertVerifyScratch(rows,size);
   for(const part of rows.filter(row=>row.kind==='verify-part'))assert.equal(part.releases,1);
   const result=rows.find(row=>row.kind==='verify-result');assert(result);assert.equal(result.requestedBytes,size);assert.equal(result.releases,0);
   entered();await gate;assert.deepEqual(value,bytes,'The retained result remains exact after the asynchronous consumer boundary');assert.equal(result.releases,0);
  }finally{value=undefined;entered();}
 });
 // An immediate handler prevents assertion failures in the consumer from
 // becoming unhandled while the fixture waits for its entry acknowledgement.
 void consuming.catch(()=>{});
 try{
  await ready;const result=rows.find(row=>row.kind==='verify-result');assert(result);assert.equal(result.releases,0);
  assert.equal(verifyOwnership().activeLeases,before.activeLeases+2,'Only the real scope handle and returned result remain');
 }finally{continueConsumer();await consuming;}
 assert.equal(rows.find(row=>row.kind==='verify-result').releases,1);assert(rows.every(row=>row.releases===1));assert.deepEqual(verifyOwnership(),before);
});

test('an asynchronous verification consumer failure still drains its exact returned result owner',async t=>{
 const f=await verifyFixture(t),bytes=Buffer.from('exact retained metadata'),{ref}=await f.put(bytes),rows=observeVerify(t),before=verifyOwnership(),failure=Error('Consumer refusal');
 await assert.rejects(adapterResources.scope('verify-failed-consumer',async()=>{
  let value=f.objects.verify(ref,true);
  try{await Promise.resolve();assert.deepEqual(value,bytes);assert.equal(rows.find(row=>row.kind==='verify-result').releases,0);throw failure;}finally{value=undefined;}
 }),error=>error===failure);
 assertVerifyScratch(rows,bytes.length);assert(rows.every(row=>row.releases===1));assert.deepEqual(verifyOwnership(),before);
});


// Explicit metadata owners use the genuine verifier and filesystem, including
// its existing private-path, hash, exact-length and return-cap refusals.
import {chmod as chmodOwnedVerify} from 'node:fs/promises';

for(const size of [0,3,65536])test('owned verification returns exact '+size+' bytes and releases independently of producer scope',async t=>{
 const f=await verifyFixture(t),bytes=Buffer.alloc(size,61),{ref}=await f.put(bytes),rows=observeVerify(t),before=verifyOwnership();let owner;
 try{
  owner=f.objects.verifyOwned(ref);assert.deepEqual(owner.bytes,bytes);assertVerifyScratch(rows,size);
  const result=rows.find(row=>row.kind==='verify-owned-result');assert(result);assert.equal(result.requestedBytes,size);assert.equal(result.releases,0);assert(rows.filter(row=>row.kind!=='verify-owned-result').every(row=>row.releases===1));
  assert.equal(verifyOwnership().activeLeases,before.activeLeases+1);assert.equal(verifyOwnership().unscopedReturnedBuffers,before.unscopedReturnedBuffers,'Explicit owners need no surrounding scope');
  await adapterResources.scope('unrelated-owned-verify-consumer',async()=>{await Promise.resolve();assert.deepEqual(owner.bytes,bytes);});
  assert.equal(result.releases,0);assert.equal(verifyOwnership().activeLeases,before.activeLeases+1);owner.release();assert.deepEqual(verifyOwnership(),before);
  owner.release();assert.deepEqual(verifyOwnership(),before);assert.equal(f.objects.hasLeases(),false);
 }finally{owner?.release();}
});

for(const kind of ['truncated','hash','excess'])test('owned verification rejects '+kind+' original object bytes and drains every temporary owner',async t=>{
 const f=await verifyFixture(t),bytes=Buffer.alloc(65536,67),{ref,path}=await f.put(bytes),rows=observeVerify(t),before=verifyOwnership();
 const changed=kind==='truncated'?bytes.subarray(0,-1):kind==='hash'?Buffer.alloc(bytes.length,68):Buffer.concat([bytes,Buffer.from([69])]);await writeFile(path,changed,{mode:0o600});
 assert.throws(()=>f.objects.verifyOwned(ref),{code:'CORRUPT_OBJECT'});assertVerifyScratch(rows,bytes.length);assert.equal(rows.some(row=>row.kind==='verify-owned-result'),false);assert(rows.every(row=>row.releases===1));assert.deepEqual(verifyOwnership(),before);
});

test('owned zero-length verification still rejects an unexpected byte',async t=>{
 const f=await verifyFixture(t),{ref,path}=await f.put(Buffer.alloc(0)),rows=observeVerify(t),before=verifyOwnership();await writeFile(path,Buffer.from([1]),{mode:0o600});
 assert.throws(()=>f.objects.verifyOwned(ref),{code:'CORRUPT_OBJECT'});assertVerifyScratch(rows,0);assert(rows.every(row=>row.releases===1));assert.deepEqual(verifyOwnership(),before);
});

for(const kind of ['missing','symlink','permissions'])test('owned verification retains '+kind+' private object refusal without an escaped result',async t=>{
 const f=await verifyFixture(t),bytes=Buffer.from('private retained metadata'),{ref,path}=await f.put(bytes),rows=observeVerify(t),before=verifyOwnership();
 if(kind==='missing')await unlink(path);
 if(kind==='symlink'){const outside=path+'-original';await writeFile(outside,bytes,{mode:0o600,flag:'wx'});await unlink(path);await symlink(outside,path);}
 if(kind==='permissions')await chmodOwnedVerify(path,0o644);
 assert.throws(()=>f.objects.verifyOwned(ref),{code:kind==='missing'?'MISSING_OBJECT':'ROOT_UNSAFE'});assert.equal(rows.some(row=>row.kind==='verify-owned-result'),false);assert(rows.every(row=>row.releases===1));assert.deepEqual(verifyOwnership(),before);
});

test('owned verification keeps the exact 65536-byte cap before any scratch or result booking',async t=>{
 const f=await verifyFixture(t),{ref}=await f.put(Buffer.alloc(65537,71)),rows=observeVerify(t),before=verifyOwnership();assert.throws(()=>f.objects.verifyOwned(ref),{code:'PAYLOAD_TOO_LARGE'});assert.deepEqual(rows,[]);assert.deepEqual(verifyOwnership(),before);
});

test('owned verification rechecks current file bytes and returns a fresh buffer after every successful read',async t=>{
 const f=await verifyFixture(t),bytes=Buffer.from('{"value":1}'),{ref,path}=await f.put(bytes),rows=observeVerify(t),before=verifyOwnership();let one,two,three;
 try{
  one=f.objects.verifyOwned(ref);one.bytes[0]=0;two=f.objects.verifyOwned(ref);assert.notEqual(two.bytes,one.bytes);assert.deepEqual(two.bytes,bytes,'Mutating caller bytes cannot poison a later file read');
  two.release();two=undefined;await writeFile(path,Buffer.from('{"value":2}'),{mode:0o600});assert.throws(()=>f.objects.verifyOwned(ref),{code:'CORRUPT_OBJECT'});
  await writeFile(path,bytes,{mode:0o600});three=f.objects.verifyOwned(ref);assert.deepEqual(three.bytes,bytes);assert.notEqual(three.bytes,one.bytes);
 }finally{one?.release();two?.release();three?.release();}
 assert.deepEqual(verifyOwnership(),before);assert.equal(rows.filter(row=>row.kind==='verify-owned-result').length,3);
});

test('explicit owner release on consumer failure preserves the original error and drains actual result backing',async t=>{
 const f=await verifyFixture(t),bytes=Buffer.from('owned consumer failure'),{ref}=await f.put(bytes),rows=observeVerify(t),before=verifyOwnership(),error=Error('consumer stopped');
 await assert.rejects((async()=>{const owner=f.objects.verifyOwned(ref);try{await Promise.resolve();assert.deepEqual(owner.bytes,bytes);throw error;}finally{owner.release();}})(),failure=>failure===error);
 assertVerifyScratch(rows,bytes.length);assert(rows.every(row=>row.releases===1));assert.deepEqual(verifyOwnership(),before);
});

test('legacy read verification still retains through its producer scope while an explicit owner releases earlier',async t=>{
 const f=await verifyFixture(t),bytes=Buffer.from('legacy scope lifetime'),{ref}=await f.put(bytes),rows=observeVerify(t),before=verifyOwnership();
 await adapterResources.scope('legacy-and-owned-verification',async()=>{
  const legacy=f.objects.verify(ref,true),owner=f.objects.verifyOwned(ref);try{assert.deepEqual(legacy,bytes);assert.deepEqual(owner.bytes,bytes);owner.release();
   const legacyRow=rows.find(row=>row.kind==='verify-result'),ownedRow=rows.find(row=>row.kind==='verify-owned-result');assert(legacyRow&&ownedRow);assert.equal(legacyRow.releases,0);assert.equal(ownedRow.releases,1);assert.equal(verifyOwnership().activeLeases,before.activeLeases+2,'Original scope handle and legacy result remain');
   await Promise.resolve();assert.deepEqual(legacy,bytes);assert.equal(legacyRow.releases,0);
  }finally{owner.release();}
 });
 assert.equal(rows.find(row=>row.kind==='verify-result').releases,1);assert.deepEqual(verifyOwnership(),before);
});

test('owned verification preserves caller check failure identity before filesystem allocation',async t=>{
 const root=await rootFor(t),error=Object.freeze({code:'CLOSED',private:true}),objects=new Objects(root,()=>{throw error;},()=>{}),rows=observeVerify(t),before=verifyOwnership();t.after(()=>objects.close());
 assert.throws(()=>objects.verifyOwned(refFor(Buffer.from('not installed'))),failure=>failure===error);assert.deepEqual(rows,[]);assert.deepEqual(verifyOwnership(),before);
});

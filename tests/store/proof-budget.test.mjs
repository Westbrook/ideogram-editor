import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Objects,IO_CHUNK,PROOF_METADATA_BYTES,PROOF_METADATA_BUDGET,PROOF_LIMIT,PROOF_HASH_READERS} from '../../dist/local/server/storage/objects.js';
import {rootFor,refFor} from './helpers.mjs';

async function fixture(t){const root=await rootFor(t),objects=new Objects(root,()=>{},()=>{});t.after(()=>objects.close());return objects;}
async function put(objects,bytes){const ref=refFor(bytes),path=objects.path(ref);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600,flag:'wx'});return ref;}
function inventory(objects){const value=objects.proofInventory();assert(value.pending>=0&&value.retained>=0);assert(value.pending+value.retained<=PROOF_LIMIT);assert(value.activeReaders>=0&&value.activeReaders<=PROOF_HASH_READERS);assert.equal(value.metadataBytes,(value.pending+value.retained)*PROOF_METADATA_BYTES);assert(value.metadataBytes<=PROOF_METADATA_BUDGET);return value;}
function empty(objects){assert.deepEqual(inventory(objects),{pending:0,retained:0,activeReaders:0,metadataBytes:0});assert.equal(objects.hasLeases(),false);assert.deepEqual(objects.leaseIdentity().proofs,[]);}
const cancelled=()=>Object.assign(new Error('Cancelled proof'),{code:'CLOSED'});

test('proof metadata is reserved before yielding and pending readers cannot bypass the capacity bound',async t=>{
 assert.equal(PROOF_METADATA_BYTES,2048);assert.equal(PROOF_METADATA_BUDGET,4*1024*1024);assert.equal(PROOF_LIMIT,2048);assert.equal(PROOF_HASH_READERS,2);
 const objects=await fixture(t),ref=await put(objects,Buffer.alloc(0));let cancel=false;
 // An empty object keeps this admission test cheap even if hashing stops yielding.
 const work=Array.from({length:PROOF_LIMIT},()=>objects.prove(ref,()=>{if(cancel)throw cancelled();})),settled=Promise.allSettled(work),before=inventory(objects);
 assert.equal(before.pending,PROOF_LIMIT);assert.equal(before.retained,0);assert.equal(before.activeReaders,PROOF_HASH_READERS);assert.equal(before.metadataBytes,PROOF_METADATA_BUDGET);assert.equal(objects.hasLeases(),true);
 const identity=objects.leaseIdentity();assert.equal(identity.proofs.length,PROOF_LIMIT);assert.equal(new Set(identity.proofs).size,PROOF_LIMIT);
 // Public proof release cannot discard an in-flight reservation and admit more readers.
 for(const token of identity.proofs)objects.releaseProof(token);assert.deepEqual(inventory(objects),before);assert.deepEqual(objects.leaseIdentity(),identity);
 const overflow=assert.rejects(objects.prove(ref,()=>{}),{code:'CAPACITY'});cancel=true;await overflow;
 const results=await settled;assert(results.every(result=>result.status==='rejected'&&result.reason.code==='CLOSED'));empty(objects);
 const proof=objects.prove(ref,()=>{}),reserved=objects.leaseIdentity().proofs;assert.equal(reserved.length,1);const token=await proof;assert.equal(token,reserved[0]);assert.deepEqual(objects.leaseIdentity().proofs,reserved);objects.proven(ref,token);objects.releaseProof(token);empty(objects);
});

test('703 distinct retained dependencies coexist with bounded queued proofs and release their exact budget',async t=>{
 const objects=await fixture(t),refs=[];
 for(let i=0;i<703;i++)refs.push(await put(objects,Buffer.from('retained-capture-dependency-'+i)));
 const tokens=[];for(const ref of refs)tokens.push(await objects.prove(ref,()=>{}));
 assert.equal(new Set(tokens).size,703);assert.deepEqual(inventory(objects),{pending:0,retained:703,activeReaders:0,metadataBytes:703*PROOF_METADATA_BYTES});assert.equal(objects.leaseIdentity().proofs.length,703);
 for(let i=0;i<refs.length;i++)objects.proven(refs[i],tokens[i]);
 let cancel=false;const work=Array.from({length:PROOF_LIMIT-tokens.length},()=>objects.prove(refs[0],()=>{if(cancel)throw cancelled();})),settled=Promise.allSettled(work);
 assert.equal(inventory(objects).pending,PROOF_LIMIT-703);assert.equal(inventory(objects).retained,703);assert.equal(inventory(objects).metadataBytes,PROOF_METADATA_BUDGET);
 const overflow=assert.rejects(objects.prove(refs[0],()=>{}),{code:'CAPACITY'});cancel=true;await overflow;const results=await settled;assert(results.every(result=>result.status==='rejected'&&result.reason.code==='CLOSED'));
 assert.deepEqual(inventory(objects),{pending:0,retained:703,activeReaders:0,metadataBytes:703*PROOF_METADATA_BYTES});
 for(let i=0;i<tokens.length;i++){objects.proven(refs[i],tokens[i]);objects.releaseProof(tokens[i]);objects.releaseProof(tokens[i]);assert.equal(inventory(objects).retained,tokens.length-i-1);}
 empty(objects);
});

test('missing, corrupt and cancelled proofs return their reservation and reader permit',async t=>{
 const objects=await fixture(t),ref=await put(objects,Buffer.alloc(IO_CHUNK+1,23));
 await assert.rejects(objects.prove(refFor(Buffer.from('never retained')),()=>{}),{code:'MISSING_OBJECT'});empty(objects);
 await assert.rejects(objects.prove({...ref,byteLength:String(Number(ref.byteLength)+1)},()=>{}),{code:'CORRUPT_OBJECT'});empty(objects);
 let checks=0;await assert.rejects(objects.prove(ref,()=>{if(++checks===4)throw cancelled();}),{code:'CLOSED'});assert.equal(checks,4);empty(objects);
 const token=await objects.prove(ref,()=>{});objects.proven(ref,token);objects.releaseProof(token);objects.releaseProof(token);assert.throws(()=>objects.proven(ref,token),{code:'CORRUPT_OBJECT'});empty(objects);
});

test('mutating a caller BlobRef during hashing cannot retarget retained proof authority',async t=>{
 const objects=await fixture(t),original=await put(objects,Buffer.alloc(IO_CHUNK+1,31)),other=await put(objects,Buffer.from('different retained object')),caller={...original};let mutated=false,checks=0;
 const token=await objects.prove(caller,()=>{if(++checks===4){mutated=true;Object.assign(caller,{...other,mediaType:'image/png'});}});
 assert.equal(mutated,true);assert.deepEqual(caller,{...other,mediaType:'image/png'});objects.proven(original,token);assert.throws(()=>objects.proven(caller,token),{code:'CORRUPT_OBJECT'});assert.throws(()=>objects.proven({...original,mediaType:'image/png'},token),{code:'CORRUPT_OBJECT'});
 caller.hash=original.hash;caller.byteLength=original.byteLength;objects.proven(original,token);assert.throws(()=>objects.proven(caller,token),{code:'CORRUPT_OBJECT'});objects.releaseProof(token);empty(objects);
});

test('closing the object store cancels queued hashing and releases pending and retained proof leases',async t=>{
 const objects=await fixture(t),ref=await put(objects,Buffer.alloc(IO_CHUNK+1,47)),retained=await objects.prove(ref,()=>{});
 const work=Array.from({length:PROOF_HASH_READERS+4},()=>objects.prove(ref,()=>{})),settled=Promise.allSettled(work),before=inventory(objects);assert.equal(before.pending,PROOF_HASH_READERS+4);assert.equal(before.activeReaders,PROOF_HASH_READERS);assert.equal(before.retained,1);
 objects.close();const results=await settled;assert(results.every(result=>result.status==='rejected'&&result.reason.code==='CLOSED'));empty(objects);objects.releaseProof(retained);empty(objects);await assert.rejects(objects.prove(ref,()=>{}),{code:'CLOSED'});empty(objects);
});

test('a cancelled queued proof releases its lease before either unrelated hash reader finishes',async t=>{
 const objects=await fixture(t),ref=await put(objects,Buffer.alloc(IO_CHUNK+1,59));t.mock.timers.enable({apis:['setTimeout']});let finished=0,cancel=false;
 const readers=Array.from({length:PROOF_HASH_READERS},()=>objects.prove(ref,()=>{}).then(token=>{finished++;return token;})),settled=Promise.allSettled(readers),readerLeases=objects.leaseIdentity().proofs;
 const queued=objects.prove(ref,()=>{if(cancel)throw cancelled();}),rejected=assert.rejects(queued,{code:'CLOSED'});assert.deepEqual(inventory(objects),{pending:3,retained:0,activeReaders:2,metadataBytes:3*PROOF_METADATA_BYTES});
 cancel=true;t.mock.timers.tick(25);await rejected;
 assert.equal(finished,0,'Queued cancellation does not wait for unrelated hashing');assert.deepEqual(inventory(objects),{pending:2,retained:0,activeReaders:2,metadataBytes:2*PROOF_METADATA_BYTES});assert.deepEqual(objects.leaseIdentity().proofs,readerLeases);assert.equal(objects.hasLeases(),true);
 t.mock.timers.reset();const results=await settled;assert.equal(finished,2);assert(results.every(result=>result.status==='fulfilled'));for(const result of results){objects.proven(ref,result.value);objects.releaseProof(result.value);}empty(objects);
});

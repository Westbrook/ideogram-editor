import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ZipIndex, spool, writeZip, crc32 } from '../../dist/local/server/portable/zip.js';
import { fileSource, generatedPayloadSource } from '../../dist/local/server/portable/format.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'portable-zip-'));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function archive(dir,entries){const db=spool(join(dir,'write.sqlite'));try{await writeZip(join(dir,'test.zip'),db,(async function*(){for(const [name,b] of entries)yield {name,bytes:BigInt(b.length),crc:(crc32(b)^0xffffffff)>>>0,sha256:sha(b),chunks:async function*(){for(let at=0;at<b.length;at+=1048576)yield b.subarray(at,at+1048576);}};})(),()=>{});}finally{db.close();}return readFile(join(dir,'test.zip'));}
async function validate(dir,bytes){await writeFile(join(dir,'input.zip'),bytes,{mode:0o600});const db=spool(join(dir,'read.sqlite')),zip=new ZipIndex(join(dir,'input.zip'),db);try{await zip.headers(()=>{});await zip.hashes(()=>{});return db.prepare('SELECT name,bytes,sha256 FROM zip_entries ORDER BY name').all().map(x=>({...x}));}finally{zip.close();db.close();}}
test('ZIP64 STORE roundtrip uses real content, exact CRC/hash and 64-bit fields',async t=>{const dir=await setup(t),payload=Buffer.alloc(3*1048576+97,37),name='objects/'+sha(payload);const bytes=await archive(dir,[['manifest.json',Buffer.from('{}')],[name,payload]]);const entries=await validate(dir,bytes);assert.deepEqual(entries,[{name:'manifest.json',bytes:'2',sha256:sha('{}')},{name,bytes:String(payload.length),sha256:sha(payload)}]);assert.equal(bytes.readUInt32LE(18),0xffffffff);});
const mutations={
 compression:b=>{b.writeUInt16LE(8,8);}, encryption:b=>{b.writeUInt16LE(1,6);}, descriptor:b=>{b.writeUInt16LE(8,6);},
 traversal:b=>{b.write('../ifest.json',30,'ascii');}, crc:b=>{b.writeUInt32LE(4,14);},
 payload:b=>{b[63]^=1;}, trailing:b=>Buffer.concat([b,Buffer.from('x')]),
 volume:b=>{b.writeUInt16LE(1,b.length-18);}, symlink:b=>{const at=b.indexOf(Buffer.from('504b0102','hex'));b.writeUInt32LE((0o120600*65536)>>>0,at+38);},
 executable:b=>{const at=b.indexOf(Buffer.from('504b0102','hex'));b.writeUInt32LE((0o100700*65536)>>>0,at+38);},
 directory:b=>{const at=b.indexOf(Buffer.from('504b0102','hex'));b.writeUInt32LE(16,at+38);},
 overlap:b=>{const at=b.indexOf(Buffer.from('504b0102','hex'));b.writeBigUInt64LE(1n,at+46+13+20);},
 zip64Offset:b=>{const at=b.indexOf(Buffer.from('504b0607','hex'));b.writeBigUInt64LE(2n**40n,at+8);},
};
for(const [label,mutate] of Object.entries(mutations))test('rejects '+label+' before accepting archive',async t=>{const dir=await setup(t),base=await archive(dir,[['manifest.json',Buffer.from('{}')]]),copy=Buffer.from(base),changed=mutate(copy);await assert.rejects(validate(dir,Buffer.isBuffer(changed)?changed:copy));assert.deepEqual(await readFile(join(dir,'test.zip')),base);});

const payloadRef=payload=>({hash:'sha256:'+sha(payload),byteLength:String(Buffer.byteLength(payload)),mediaType:'application/json'});
test('disk-backed generated payloads produce identical ZIP bytes without per-payload files, including the UTF-8 bound',async t=>{
 const dir=await setup(t),payloads=['{"text":"東京"}','"'+'é'.repeat(32767)+'"'];assert.equal(Buffer.byteLength(payloads[1]),65536);
 const archives=[];
 for(const generated of [false,true]){
  const root=join(dir,generated?'generated':'files');await mkdir(root,{mode:0o700});await writeFile(join(root,'manifest.json'),'{}',{mode:0o600});
  const db=spool(join(root,'write.sqlite'));db.exec('CREATE TABLE payloads(hash TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');
  try{
   for(const payload of payloads)db.prepare('INSERT INTO payloads VALUES (?,?)').run(sha(payload),payload);
   await writeZip(join(root,'test.zip'),db,(async function*(){
    yield await fileSource('manifest.json',join(root,'manifest.json'),()=>{});
    for(const row of db.prepare('SELECT * FROM payloads ORDER BY hash').iterate()){
     // Media belongs to each typed reference; shared bytes may already have a
     // non-JSON ref in the hash-deduplicated index. Do not tighten that contract.
     const ref={...payloadRef(row.json),mediaType:'application/octet-stream'};
     if(generated)yield generatedPayloadSource(ref,row.json,()=>{});
     else{const path=join(root,row.hash);await writeFile(path,row.json,{mode:0o600});yield await fileSource('objects/'+row.hash,path,()=>{});}
    }
   })(),()=>{});
  }finally{db.close();}
  archives.push(await readFile(join(root,'test.zip')));
  assert.equal((await readdir(root)).filter(name=>/^[a-f0-9]{64}$/.test(name)).length,generated?0:payloads.length);
 }
 assert.deepEqual(archives[1],archives[0]);
 const entries=await validate(dir,archives[1]);for(const payload of payloads){const entry=entries.find(row=>row.name==='objects/'+sha(payload));assert.equal(entry.bytes,String(Buffer.byteLength(payload)));assert.equal(entry.sha256,sha(payload));}
});
test('generated payloads reject wrong reference bytes/hash and enforce UTF-8 bytes rather than characters',()=>{
 const payload='"é"',ref=payloadRef(payload);
 assert.throws(()=>generatedPayloadSource({...ref,byteLength:String(Number(ref.byteLength)+1)},payload,()=>{}),{code:'CORRUPT_OBJECT'});
 assert.throws(()=>generatedPayloadSource({...ref,hash:'sha256:'+'0'.repeat(64)},payload,()=>{}),{code:'CORRUPT_OBJECT'});
 const oversized='é'.repeat(32769);assert(oversized.length<65536);assert.throws(()=>generatedPayloadSource(payloadRef(oversized),oversized,()=>{}),{code:'MALFORMED_REQUEST'});
});
test('generated payload cancellation is checked before snapshot creation and on both sides of emission',async()=>{
 const payload='{"text":"cancel me"}',ref=payloadRef(payload),reason=Error('owned cancellation');let cancelled=true;
 const check=()=>{if(cancelled)throw reason;};assert.throws(()=>generatedPayloadSource(ref,payload,check),error=>error===reason);
 cancelled=false;const before=generatedPayloadSource(ref,payload,check);cancelled=true;await assert.rejects(before.chunks()[Symbol.asyncIterator]().next(),error=>error===reason);
 cancelled=false;const iterator=generatedPayloadSource(ref,payload,check).chunks()[Symbol.asyncIterator]();assert.deepEqual((await iterator.next()).value,Buffer.from(payload));cancelled=true;await assert.rejects(iterator.next(),error=>error===reason);
});
for(const fault of ['length','crc','hash','chunk'])test('ZIP writer independently rejects generated payload '+fault+' drift',async t=>{
 const dir=await setup(t),payload='{"text":"retained exact bytes"}',source=generatedPayloadSource(payloadRef(payload),payload,()=>{});
 if(fault==='length')source.bytes++;
 if(fault==='crc')source.crc=(source.crc^1)>>>0;
 if(fault==='hash')source.sha256='0'.repeat(64);
 if(fault==='chunk'){const chunks=source.chunks;source.chunks=async function*(){for await(const bytes of chunks()){const changed=Buffer.from(bytes);changed[0]^=1;yield changed;}};}
 const db=spool(join(dir,'write.sqlite'));try{await assert.rejects(writeZip(join(dir,'partial.zip'),db,(async function*(){yield source;})(),()=>{}),{code:'CORRUPT_OBJECT'});}finally{db.close();}
});

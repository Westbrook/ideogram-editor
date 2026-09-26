import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ZipIndex, spool, writeZip, crc32 } from '../../dist/local/server/portable/zip.js';
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

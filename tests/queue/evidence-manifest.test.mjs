import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fstatSync} from 'node:fs';
import {mkdtemp,realpath,mkdir,writeFile,symlink,open,truncate,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {manifest} from './helpers.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,bytes){
 const root=await mkdtemp(join(await realpath(tmpdir()),'queue-evidence-hash-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'large.bin');await writeFile(file,bytes);
 const probe=await open(file,'r'),prototype=Object.getPrototypeOf(probe);await probe.close();
 return {root,file,prototype};
}
function observeReads(t,prototype,after=()=>{}){
 const original=prototype.read,descriptors=new Set(),buffers=new Set(),reads=[];
 t.mock.method(prototype,'read',async function(...args){
  descriptors.add(this.fd);buffers.add(args[0]);assert.equal(args[1],0);assert.equal(args[2],65536);assert.equal(args[3],null);
  const result=await Reflect.apply(original,this,args);reads.push(result.bytesRead);await after({count:reads.length,bytesRead:result.bytesRead});return result;
 });
 return {buffers,reads,closed(){for(const fd of descriptors)assert.throws(()=>fstatSync(fd),{code:'EBADF'});}};
}

test('evidence manifest hashes every byte with one reused bounded scratch and preserves links',async t=>{
 const bytes=Buffer.alloc(3*65536+17,97),f=await fixture(t,bytes);await mkdir(join(f.root,'nested'));await writeFile(join(f.root,'nested','small.bin'),'small');await writeFile(join(f.root,'empty.bin'),'');await symlink('large.bin',join(f.root,'link'));
 const observed=observeReads(t,f.prototype),result=await manifest(f.root);
 assert.deepEqual(result,[{path:'empty.bin',bytes:0,sha256:sha('')},{path:'large.bin',bytes:bytes.length,sha256:sha(bytes)},{path:'link',link:'large.bin'},{path:'nested/small.bin',bytes:5,sha256:sha('small')}]);
 assert.equal(observed.buffers.size,1);assert(observed.reads.filter(n=>n===65536).length>=3);assert(observed.reads.includes(17));assert(observed.reads.every(n=>n>=0&&n<=65536));observed.closed();
});
for(const change of ['grow','shrink'])test('evidence manifest refuses '+change+' during hashing and closes the actual descriptor',async t=>{
 const bytes=Buffer.alloc(2*65536+17,97),f=await fixture(t,bytes);const observed=observeReads(t,f.prototype,async({count})=>{if(count===1){if(change==='grow')await writeFile(f.file,'extra',{flag:'a'});else await truncate(f.file,65536);}});
 await assert.rejects(manifest(f.root),/Evidence file byte count changed while hashing/);assert.equal(observed.buffers.size,1);observed.closed();
});
test('evidence manifest closes the actual descriptor when reading fails',async t=>{
 const f=await fixture(t,Buffer.alloc(65537,97)),failure=Error('fixture read failed');const observed=observeReads(t,f.prototype,({count})=>{if(count===1)throw failure;});
 await assert.rejects(manifest(f.root),error=>error===failure);observed.closed();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const contracts=data((await transformWithOxc(await readFile('src/text/contracts.ts','utf8'),'contracts.ts')).code);
const memory=data('export const textMemory={reserve(bytes){return globalThis.__relinkAllocation.reserve(bytes)}};');
let code=(await transformWithOxc(await readFile('src/ui/font-relink.ts','utf8'),'font-relink.ts')).code;
for(const [path,url]of Object.entries({'../text/contracts.js':contracts,'../text/memory.js':memory}))code=code.replaceAll(JSON.stringify(path),JSON.stringify(url)).replaceAll("'"+path+"'",JSON.stringify(url));
const {hashRelinkInputs}=await import(data(code));
test.afterEach(()=>{delete globalThis.__relinkAllocation;});
test('oversized local font or license is rejected before hashing or booking memory',async()=>{
 globalThis.__relinkAllocation={reserve(){assert.fail('No read reservation for inadmissible input');}};
 for(const [fontSize,licenseSize]of [[16777217,1],[1,65537],[0,1],[1,0]]){
  const file=size=>({size,arrayBuffer(){assert.fail('Inadmissible file must not be materialized');}});
  await assert.rejects(hashRelinkInputs(file(fontSize),file(licenseSize)),/supported import limit/);
 }
});
test('both real sequential hashes hold one conservative lease and release it on success',async()=>{
 const font=new Blob(['font bytes']),license=new Blob(['license bytes']);let held=0,releases=0;
 globalThis.__relinkAllocation={reserve(bytes){assert.equal(bytes,3*(font.size+license.size));held=bytes;return {release(){held=0;releases++;}};}};
 const result=await hashRelinkInputs(font,license);assert.match(result.hash,/^sha256:[a-f0-9]{64}$/);assert.match(result.license,/^sha256:[a-f0-9]{64}$/);assert.equal(held,0);assert.equal(releases,1);
});
test('failed allocation precedes Blob materialization and failed hashing still releases its lease',async()=>{
 const font=new Blob(['font']),license=new Blob(['license']);let reads=0,released=0;
 font.arrayBuffer=async()=>{reads++;throw Error('READ_FAILED');};
 globalThis.__relinkAllocation={reserve(){throw Error('TEXT_MEMORY_BUDGET');}};await assert.rejects(hashRelinkInputs(font,license),/TEXT_MEMORY_BUDGET/);assert.equal(reads,0);
 globalThis.__relinkAllocation={reserve(){return {release(){released++;}};}};await assert.rejects(hashRelinkInputs(font,license),/READ_FAILED/);assert.equal(reads,1);assert.equal(released,1);
});

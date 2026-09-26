import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const sha=b=>createHash('sha256').update(b).digest('hex');
const raw=await readFile('src/text/profile.json','utf8'),profile=JSON.parse(raw),id=profile.id;
delete profile.id;assert.equal('sha256:'+sha(JSON.stringify(profile)),id,'profile identity');
assert.equal(await readFile('vendor/text/manifest.json','utf8'),raw);
for(const row of [...profile.adapterSources,...profile.sourceRecipe,...profile.notices,...JSON.parse(await readFile('vendor/text/FILES.json','utf8'))]){
  const b=await readFile(row.path);assert.equal(b.length,row.bytes,row.path+' bytes');assert.equal(sha(b),row.sha256,row.path+' hash');
}
for(const [part,path] of [['js','bin/canvaskit.js'],['wasm','bin/canvaskit.wasm']]){
  const b=await readFile('node_modules/canvaskit-wasm/'+path);assert.equal(b.length,profile.engine[part].bytes);assert.equal(sha(b),profile.engine[part].sha256);
}
const registry=JSON.parse(await readFile('tooling/text/canvaskit-registry.json','utf8'));
const tarball=await readFile('vendor/text/canvaskit-wasm-0.40.0.tgz');
assert.equal('sha512-'+createHash('sha512').update(tarball).digest('base64'),registry.dist.integrity);
const originalTypes=await readFile('node_modules/canvaskit-wasm/types/index.d.ts','utf8');
assert.equal(await readFile('vendor/text/canvaskit.d.ts','utf8'),originalTypes.replace('/// <reference types="@webgpu/types" />',
  '// App compatibility: TypeScript 7 lib.dom supplies WebGPU types; upstream reference removed.\n// All remaining declarations are the exact canvaskit-wasm 0.40.0 types.'));
const fontRecords=JSON.parse(await readFile('vendor/text/font-records.json','utf8'));
assert.equal(fontRecords.length,4);for(const f of fontRecords){assert.equal(f.fsType,0);assert.equal(f.weight,400);assert.equal(f.width,5);}
const wasm=await readFile('node_modules/canvaskit-wasm/bin/canvaskit.wasm');
let cursor=8;const leb=()=>{let n=0,s=0,b;do{b=wasm[cursor++];n+=(b&127)*2**s;s+=7;}while(b&128);return n;};
let memory;
while(cursor<wasm.length){const section=wasm[cursor++],length=leb(),end=cursor+length;
  if(section===5){assert.equal(leb(),1);assert.equal(leb(),1);memory={initial:leb()*65536,maximum:leb()*65536};break;}cursor=end;
}
assert.deepEqual(memory,{initial:16777216,maximum:33554432});
const module=new WebAssembly.Module(wasm);
assert.equal(WebAssembly.Module.exports(module).filter(e=>e.kind==='memory').length,1);
const custom=await readFile('vendor/text/canvaskit-wasm-'+profile.engine.version+'.tgz');
assert.equal(custom.length,profile.engine.tarball.bytes);assert.equal(sha(custom),profile.engine.tarball.sha256);
const glue=await readFile('node_modules/canvaskit-wasm/bin/canvaskit.js','utf8');
assert.ok(glue.includes('TEXT_NATIVE_ALLOCATION'));
const closure=JSON.parse(await readFile('tooling/text/source-closure.json','utf8'));
assert.equal(closure.icuData.sha256,profile.unicode.unicodeDataHash.slice(7));
console.log(JSON.stringify({ok:true,profile:id,fonts:fontRecords.length,memory,scope:'sealed inputs, source attribution and ABI; not resource/platform qualification'},null,2));

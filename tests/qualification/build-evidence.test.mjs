import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {transformWithOxc} from 'vite';

const source=readFileSync(new URL('../../tooling/build-evidence.ts',import.meta.url),'utf8');
const transformed=await transformWithOxc(source,'tooling/build-evidence.ts');
const {buildEvidence}=await import('data:text/javascript;base64,'+Buffer.from(transformed.code).toString('base64'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hook=(plugin,name,context,...args)=>Reflect.apply(typeof plugin[name]==='function'?plugin[name]:plugin[name].handler,context,args);

function fixture(run){
 const cwd=process.cwd(),root=mkdtempSync(join(tmpdir(),'ie-build-evidence-'));
 const put=(path,bytes)=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);};
 try{
  for(const path of ['src/main.ts','index.html','vite.app.config.ts','tsconfig.json','tsconfig.app.json','package.json','package-lock.json','.progress-report/project.json','tooling/build-evidence.ts','tooling/theme/input.css','vendor/text/manifest.json'])put(path,'fixture '+path);
  process.chdir(root);
  const plugin=buildEvidence(true),bundle={
   'assets/index-test.js':{type:'chunk',fileName:'assets/index-test.js',code:'const entry=1;',isEntry:true,imports:[],dynamicImports:['assets/lazy-test.js'],modules:{}},
   'assets/lazy-test.js':{type:'chunk',fileName:'assets/lazy-test.js',code:'const lazy=1;',isEntry:false,imports:[],dynamicImports:[],modules:{}},
   'assets/index-test.css':{type:'asset',fileName:'assets/index-test.css',source:'body{color:#000}'},
  };
  const context={error(message){throw Error(message);},emitFile(asset){bundle[asset.fileName]={...asset};return asset.fileName;}};
  const bytes=item=>Buffer.from(item.type==='chunk'?item.code:item.source);
  const write=()=>{for(const item of Object.values(bundle))put('dist/app/'+item.fileName,bytes(item));};
  hook(plugin,'buildStart',context);
  hook(plugin,'generateBundle',context,{dir:join(root,'dist/app')},bundle,true);
  return run({root,put,plugin,bundle,context,bytes,write,finish:()=>hook(plugin,'writeBundle',context,{dir:join(root,'dist/app')},bundle)});
 }finally{process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
}

test('application receipt captures final preload rewrite and final HTML/manifest bytes in writeBundle',()=>fixture(f=>{
 const provisional=JSON.parse(f.bundle['build-evidence.json'].source);assert.deepEqual(provisional.capture,{phase:'generateBundle',finalized:false});
 f.bundle['assets/index-test.js'].code+='const preload=["final","rewritten"];';
 f.bundle['assets/index-test.css'].source+='html{color:#111}';
 f.bundle['index.html']={type:'asset',fileName:'index.html',source:'<!doctype html><script src="/assets/index-test.js"></script>'};
 f.bundle['.vite/manifest.json']={type:'asset',fileName:'.vite/manifest.json',source:'{"index.html":{"file":"assets/index-test.js"}}'};
 f.write();f.finish();
 const receipt=JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json')));
 assert.deepEqual(receipt.capture,{phase:'writeBundle',finalized:true});assert.deepEqual(receipt.sourceInputs,provisional.sourceInputs);
 assert.equal(f.plugin.writeBundle.order,'post');assert.equal(f.plugin.writeBundle.sequential,true);
 assert(!receipt.outputs.some(output=>output.file==='build-evidence.json'));
 assert.equal(receipt.outputs.length,Object.keys(f.bundle).length-1);
 for(const output of receipt.outputs){const bytes=f.bytes(f.bundle[output.file]);assert.equal(output.bytes,bytes.length);assert.equal(output.sha256,hash(bytes));assert.equal(output.gzipBytes,gzipSync(bytes).length);}
 assert.equal(receipt.observations.D11.startupJsRawBytes,f.bytes(f.bundle['assets/index-test.js']).length+f.bytes(f.bundle['assets/lazy-test.js']).length);
 assert(receipt.observations.D11.startupJsRawBytes>provisional.observations.D11.startupJsRawBytes);
 assert.equal(f.bundle['build-evidence.json'].source,readFileSync(join(f.root,'dist/app/build-evidence.json'),'utf8'));
}));
test('application receipt rejects disk bytes that differ from the final owned bundle',()=>fixture(f=>{
 f.write();const changed=Buffer.from(f.bytes(f.bundle['assets/index-test.js']));changed[0]^=1;f.put('dist/app/assets/index-test.js',changed);
 assert.throws(f.finish,/Final bundle differs from emitted file/);assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).capture.finalized,false);
}));
test('application receipt rejects source changes made after generateBundle',()=>fixture(f=>{
 f.write();f.put('src/main.ts','late unbuilt source');assert.throws(f.finish,/Application inputs changed during the build/);
 assert.equal(JSON.parse(readFileSync(join(f.root,'dist/app/build-evidence.json'))).capture.finalized,false);
}));
test('application writeBundle requires its owned output directory and receipt',()=>fixture(f=>{
 f.write();assert.throws(()=>hook(f.plugin,'writeBundle',f.context,{},f.bundle),/requires an output directory/);
 delete f.bundle['build-evidence.json'];assert.throws(f.finish,/evidence asset is missing/);
}));

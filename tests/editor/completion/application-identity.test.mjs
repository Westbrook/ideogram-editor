import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadApplicationIdentity,validateApplicationIdentity,auditApplicationIdentity,createApplicationIdentity} from './application-identity.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const files=new Map(),put=(path,value)=>files.set(path,Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value)));
 const pin=path=>({path,bytes:files.get(path).length,sha256:hash(files.get(path))});
 const engine=JSON.parse(readFileSync(new URL('../../../vendor/text/manifest.json',import.meta.url))).engine;
 for(const path of ['package.json','package-lock.json','vite.app.config.ts','tooling/build-evidence.ts','src/text/worker.ts','src/text/client.ts','src/text/engine.ts','src/text/core.ts','src/text/contracts.ts'])put(path,'fixture source '+path);
 put('src/text/profile.json',{engine});put('vendor/text/manifest.json',{engine});
 const inputs=[...files.keys()].sort().map(pin),workerPath='/assets/worker-reviewed.js',wasmPath='/assets/canvaskit-sealed.wasm';
 put('dist/app'+workerPath,'const wasm="'+wasmPath+'";');put('dist/app'+wasmPath,readFileSync(new URL('../../../node_modules/canvaskit-wasm/bin/canvaskit.wasm',import.meta.url)));
 put('dist/app/index.html','<!doctype html><title>Isolated identity fixture</title>');
 put('dist/app/.vite/manifest.json',{'src/ui/shell.ts':{file:'assets/shell-test.js',assets:[workerPath.slice(1)]}});
 put('dist/app/assets/shell-test.js','const fixtureShell=1;');put('dist/app/assets/shell-test.css','body{color:#000}');
 const evidence={sourceInputs:inputs,capture:{phase:'writeBundle',finalized:true},toolchain:{node:'26.10.0',npm:'12.1.0'},outputs:[workerPath,wasmPath,'/assets/shell-test.js','/assets/shell-test.css'].map(path=>({file:path.slice(1),bytes:files.get('dist/app'+path).length,sha256:hash(files.get('dist/app'+path))}))};put('dist/app/build-evidence.json',evidence);
 const worker=pin('dist/app'+workerPath),wasm=pin('dist/app'+wasmPath);
 const identity={schema:1,kind:'REVIEWED-COMPLETION-APPLICATION-IDENTITY',expected:{workerPath,workerSHA256:worker.sha256,workerBytes:worker.bytes,wasmPath,wasmSHA256:wasm.sha256,wasmBytes:wasm.bytes},build:{command:'npm run build:app',toolchain:evidence.toolchain,inputs,outputs:['dist/app/index.html','dist/app/.vite/manifest.json','dist/app/build-evidence.json',worker.path,wasm.path].sort().map(pin)},sealedWasm:{manifest:pin('vendor/text/manifest.json'),engineVersion:engine.version,engineSourceRevision:engine.sourceRevision}};
 return {files,identity,evidence,put,pin,read:path=>{assert(files.has(path),'Missing isolated identity input '+path);return files.get(path);}};
}

test('adopted identity returns immutable exact expectations without inspecting live dist',()=>{const {identity}=fixture(),expected=validateApplicationIdentity(identity);assert.deepEqual(expected,identity.expected);assert(Object.isFrozen(expected));identity.expected.workerBytes++;assert.notEqual(expected.workerBytes,identity.expected.workerBytes);});
test('loader defaults only to the adopted identity when no explicit run identity is supplied',()=>{const {identity}=fixture(),calls=[];const loaded=loadApplicationIdentity({env:{},read:path=>{calls.push(String(path));return Buffer.from(JSON.stringify(identity));}});assert.deepEqual(loaded,identity);assert.deepEqual(calls,[String(new URL('./application-identity.json',import.meta.url))]);});
test('loader uses exact explicit run identity and never reads the default or dist',()=>{const {identity}=fixture(),path=join(tmpdir(),'explicit-completion-identity.json'),calls=[];const loaded=loadApplicationIdentity({env:{COMPLETION_APPLICATION_IDENTITY:path},read:selected=>{calls.push(selected);return Buffer.from(JSON.stringify(identity));}});assert.deepEqual(loaded,identity);assert.deepEqual(calls,[path]);});
for(const value of ['',undefined,'relative-identity.json'])test('loader rejects invalid explicit identity path '+String(value),()=>{let reads=0;assert.throws(()=>loadApplicationIdentity({env:{COMPLETION_APPLICATION_IDENTITY:value},read:()=>{reads++;}}),/explicit absolute file path/);assert.equal(reads,0);});
test('loader refuses missing explicit identity without falling back',()=>{const root=mkdtempSync(join(tmpdir(),'ie-identity-missing-'));try{assert.throws(()=>loadApplicationIdentity({env:{COMPLETION_APPLICATION_IDENTITY:join(root,'missing.json')}}),{code:'ENOENT'});}finally{rmSync(root,{recursive:true,force:true});}});
test('loader refuses malformed or unsealed explicit identity without falling back',()=>{const {identity}=fixture(),path=join(tmpdir(),'explicit-completion-identity.json');assert.throws(()=>loadApplicationIdentity({env:{COMPLETION_APPLICATION_IDENTITY:path},read:()=>Buffer.from('{')}),SyntaxError);identity.expected.wasmSHA256='a'.repeat(64);assert.throws(()=>loadApplicationIdentity({env:{COMPLETION_APPLICATION_IDENTITY:path},read:()=>Buffer.from(JSON.stringify(identity))}),/Sealed WASM identity/);});
test('audit checks source, receipt and all emitted bytes against the adopted identity',()=>{const f=fixture(),result=auditApplicationIdentity(f.identity,{read:f.read});assert.equal(result.worker.sha256,f.identity.expected.workerSHA256);assert.equal(result.sourceInputs,f.identity.build.inputs.length);assert.equal(result.emittedOutputs,f.evidence.outputs.length);});
for(const [label,mutate]of [['duplicate',evidence=>evidence.outputs.push(evidence.outputs[0])],['escaping',evidence=>evidence.outputs[0].file='../outside.js']])test('audit refuses '+label+' emitted output paths',()=>{const f=fixture();mutate(f.evidence);f.put('dist/app/build-evidence.json',f.evidence);f.identity.build.outputs=f.identity.build.outputs.map(record=>record.path==='dist/app/build-evidence.json'?f.pin(record.path):record);assert.throws(()=>auditApplicationIdentity(f.identity,{read:f.read}),label==='duplicate'?/Unique identity pins/:/Repository-relative emitted output path/);});
test('audit refuses a provisional generateBundle receipt',()=>{const f=fixture();f.evidence.capture={phase:'generateBundle',finalized:false};f.put('dist/app/build-evidence.json',f.evidence);f.identity.build.outputs=f.identity.build.outputs.map(record=>record.path==='dist/app/build-evidence.json'?f.pin(record.path):record);assert.throws(()=>auditApplicationIdentity(f.identity,{read:f.read}),/Final emitted build receipt required/);});
for(const [label,change] of [
 ['unsealed WASM',identity=>identity.expected.wasmSHA256='a'.repeat(64)],
 ['wrong toolchain',identity=>identity.build.toolchain.node='26.9.0'],
 ['duplicate source pin',identity=>identity.build.inputs.push(identity.build.inputs[0])],
 ['missing worker source',identity=>identity.build.inputs=identity.build.inputs.filter(pin=>pin.path!=='src/text/worker.ts')],
 ['escaping source path',identity=>identity.build.inputs[0].path='../outside'],
 ['worker mismatch',identity=>identity.expected.workerBytes++],
 ['missing build receipt',identity=>identity.build.outputs=identity.build.outputs.filter(pin=>pin.path!=='dist/app/build-evidence.json')],
 ['changed sealed manifest',identity=>identity.sealedWasm.manifest.sha256='a'.repeat(64)],
 ])test('identity refuses '+label,()=>{const {identity}=fixture();change(identity);assert.throws(()=>validateApplicationIdentity(identity));});
for(const path of ['src/text/worker.ts','dist/app/assets/worker-reviewed.js','dist/app/build-evidence.json'])test('audit refuses changed '+path,()=>{const f=fixture();f.put(path,Buffer.concat([f.read(path),Buffer.from(' changed')]));assert.throws(()=>auditApplicationIdentity(f.identity,{read:f.read}),/Application identity changed/);});
test('producer only adopts a receipt matching its build-start source closure',()=>{
 const f=fixture(),root=mkdtempSync(join(tmpdir(),'ie-identity-'));
 try{for(const [path,bytes]of f.files){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}const generated=createApplicationIdentity({root,buildEvidence:f.evidence});assert.deepEqual(generated.expected,f.identity.expected);writeFileSync(join(root,'src/text/worker.ts'),'unbuilt change');assert.throws(()=>createApplicationIdentity({root,buildEvidence:f.evidence}),/Build source changed before adoption/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('producer refuses a receipt borrowed from another build',()=>{
 const f=fixture(),root=mkdtempSync(join(tmpdir(),'ie-identity-'));
 try{for(const [path,bytes]of f.files){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}const borrowed=structuredClone(f.evidence);borrowed.outputs[0].bytes++;assert.throws(()=>createApplicationIdentity({root,buildEvidence:borrowed}),/Supplied evidence belongs to emitted build/);}finally{rmSync(root,{recursive:true,force:true});}
});
for(const asset of ['worker-reviewed.js','shell-test.js','shell-test.css'])test('producer refuses same-length '+asset+' replacement after build',()=>{
 const f=fixture(),root=mkdtempSync(join(tmpdir(),'ie-identity-'));
 try{for(const [path,bytes]of f.files){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}const path='dist/app/assets/'+asset,replaced=Buffer.from(f.read(path));replaced[0]^=1;writeFileSync(join(root,path),replaced);assert.throws(()=>createApplicationIdentity({root,buildEvidence:f.evidence}),/Build output changed dist\/app\/assets\//);}finally{rmSync(root,{recursive:true,force:true});}
});

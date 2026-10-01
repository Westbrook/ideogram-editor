import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const KIND='REVIEWED-COMPLETION-APPLICATION-IDENTITY';
const TOOLCHAIN=Object.freeze({node:'26.10.0',npm:'12.1.0'});
const SEALED_WASM=Object.freeze({engineVersion:'0.40.0-ideogram.3',engineSourceRevision:'5f262bd2cbb40f78659ec32547163fe83117a38d',bytes:4979358,sha256:'26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19'});
const REQUIRED_INPUTS=['package.json','package-lock.json','vite.app.config.ts','tooling/build-evidence.ts','src/text/worker.ts','src/text/client.ts','src/text/engine.ts','src/text/core.ts','src/text/contracts.ts','src/text/profile.json','vendor/text/manifest.json'];
const safePath=path=>typeof path==='string'&&path.length>0&&!path.startsWith('/')&&!path.includes('\\')&&!path.split('/').some(part=>part===''||part==='.'||part==='..')&&!path.includes('\0');
function pinShape(pin){assert(pin&&safePath(pin.path),'Repository-relative identity pin');assert(Number.isSafeInteger(pin.bytes)&&pin.bytes>0,'Positive pinned byte length');assert.match(pin.sha256,/^[a-f0-9]{64}$/,'Exact pinned SHA256');}
function pinsShape(pins){assert(Array.isArray(pins)&&pins.length>0,'Nonempty pinned closure');pins.forEach(pinShape);assert.equal(new Set(pins.map(pin=>pin.path)).size,pins.length,'Unique identity pins');}
const one=(rows,label)=>{assert.equal(rows.length,1,'Exactly one '+label);return rows[0];};
const pin=(path,read)=>{const bytes=read(path);return {path,bytes:bytes.length,sha256:digest(bytes)};};
function auditBuildOutputs(evidence,read){
 assert.deepEqual(evidence.capture,{phase:'writeBundle',finalized:true},'Final emitted build receipt required');
 assert(Array.isArray(evidence.outputs)&&evidence.outputs.length>0,'Nonempty emitted output closure');
 const outputs=evidence.outputs.map(output=>{assert(safePath(output.file),'Repository-relative emitted output path');return {path:'dist/app/'+output.file,bytes:output.bytes,sha256:output.sha256};});
 pinsShape(outputs);
 for(const output of outputs)assert.deepEqual(pin(output.path,read),output,'Build output changed '+output.path);
 return outputs.length;
}

/** Use an explicitly supplied run identity or the adopted repository identity, never live dist discovery. */
export function loadApplicationIdentity({env=process.env,read=readFileSync}={}){
 const supplied=Object.hasOwn(env,'COMPLETION_APPLICATION_IDENTITY');
 const path=supplied?env.COMPLETION_APPLICATION_IDENTITY:new URL('./application-identity.json',import.meta.url);
 if(supplied)assert(typeof path==='string'&&path.length>0&&isAbsolute(path),'COMPLETION_APPLICATION_IDENTITY must be an explicit absolute file path');
 const identity=JSON.parse(read(path));validateApplicationIdentity(identity);return identity;
}

/** Validate an explicitly adopted identity; never discover replacement bytes from dist. */
export function validateApplicationIdentity(identity){
 assert.equal(identity?.schema,1);assert.equal(identity.kind,KIND);
 const expected=identity.expected;assert(expected&&typeof expected==='object');
 assert.deepEqual(Object.keys(expected).sort(),['workerPath','workerSHA256','workerBytes','wasmPath','wasmSHA256','wasmBytes'].sort());
 assert.match(expected.workerPath,/^\/assets\/worker-[A-Za-z0-9_-]+\.js$/);assert.match(expected.wasmPath,/^\/assets\/canvaskit-[A-Za-z0-9_-]+\.wasm$/);
 pinShape({path:expected.workerPath.slice(1),bytes:expected.workerBytes,sha256:expected.workerSHA256});
 assert.equal(expected.wasmBytes,SEALED_WASM.bytes,'Sealed WASM byte length');assert.equal(expected.wasmSHA256,SEALED_WASM.sha256,'Sealed WASM identity');
 const build=identity.build;assert.equal(build?.command,'npm run build:app');assert.deepEqual(build.toolchain,TOOLCHAIN);pinsShape(build.inputs);pinsShape(build.outputs);
 for(const path of REQUIRED_INPUTS)one(build.inputs.filter(input=>input.path===path),'required source input '+path);
 const outputPaths=['dist/app/index.html','dist/app/.vite/manifest.json','dist/app/build-evidence.json','dist/app'+expected.workerPath,'dist/app'+expected.wasmPath].sort();
 assert.deepEqual(build.outputs.map(output=>output.path).sort(),outputPaths,'Closed build receipt and selected native artifacts');
 for(const [prefix,path]of [['worker',expected.workerPath],['wasm',expected.wasmPath]])assert.deepEqual(one(build.outputs.filter(output=>output.path==='dist/app'+path),'selected '+prefix),{path:'dist/app'+path,bytes:expected[prefix+'Bytes'],sha256:expected[prefix+'SHA256']});
 const sealed=identity.sealedWasm;assert(sealed);assert.equal(sealed.engineVersion,SEALED_WASM.engineVersion);assert.equal(sealed.engineSourceRevision,SEALED_WASM.engineSourceRevision);
 assert.deepEqual(sealed.manifest,one(build.inputs.filter(input=>input.path==='vendor/text/manifest.json'),'sealed text manifest'));
 return Object.freeze({...expected});
}

/** Check adopted bytes, receipt, source closure and sealed provenance without refreshing them. */
export function auditApplicationIdentity(identity,{read=path=>readFileSync(path)}={}){
 const expected=validateApplicationIdentity(identity);
 for(const record of [...identity.build.inputs,...identity.build.outputs])assert.deepEqual(pin(record.path,read),record,'Application identity changed '+record.path);
 const evidence=JSON.parse(read('dist/app/build-evidence.json'));assert.deepEqual(evidence.sourceInputs,identity.build.inputs,'Build-start source closure');assert.deepEqual(evidence.toolchain,identity.build.toolchain,'Recorded build toolchain');
 const emittedOutputs=auditBuildOutputs(evidence,read);
 const vite=JSON.parse(read('dist/app/.vite/manifest.json')),shell=vite['src/ui/shell.ts'];assert(shell,'Production shell manifest');
 assert.equal(one((shell.assets??[]).filter(path=>/^assets\/worker-[A-Za-z0-9_-]+\.js$/.test(path)),'shell native worker'),expected.workerPath.slice(1));
 for(const prefix of ['worker','wasm']){const output=one(evidence.outputs.filter(output=>output.file===expected[prefix+'Path'].slice(1)),'build '+prefix);assert.equal(output.bytes,expected[prefix+'Bytes'],'Build artifact byte length '+prefix);assert.equal(output.sha256,expected[prefix+'SHA256'],'Build artifact SHA256 '+prefix);}
 assert(read('dist/app'+expected.workerPath).toString().includes(expected.wasmPath),'Selected worker references sealed WASM');
 const manifest=JSON.parse(read(identity.sealedWasm.manifest.path)),profile=JSON.parse(read('src/text/profile.json'));
 for(const engine of [manifest.engine,profile.engine]){assert.equal(engine.version,SEALED_WASM.engineVersion);assert.equal(engine.sourceRevision,SEALED_WASM.engineSourceRevision);assert.equal(engine.wasm.bytes,expected.wasmBytes);assert.equal(engine.wasm.sha256,expected.wasmSHA256);}
 return {identitySHA256:digest(JSON.stringify(identity)),worker:{path:expected.workerPath,bytes:expected.workerBytes,sha256:expected.workerSHA256},wasm:{path:expected.wasmPath,bytes:expected.wasmBytes,sha256:expected.wasmSHA256},sourceInputs:identity.build.inputs.length,emittedOutputs,scope:'Exact adopted source/build identities; native execution still requires the completion campaign'};
}

/** Producer-only operation after the pinned build. The caller retains/reviews this candidate before adoption. */
export function createApplicationIdentity({root,buildEvidence}){
 assert(typeof root==='string'&&root.length>0,'Explicit repository root');const repository=resolve(root),read=path=>readFileSync(join(repository,path));
 const evidence=JSON.parse(read('dist/app/build-evidence.json'));if(buildEvidence!==undefined)assert.deepEqual(buildEvidence,evidence,'Supplied evidence belongs to emitted build');
 assert.deepEqual(evidence.toolchain,TOOLCHAIN);pinsShape(evidence.sourceInputs);
 for(const record of evidence.sourceInputs)assert.deepEqual(pin(record.path,read),record,'Build source changed before adoption '+record.path);
 const vite=JSON.parse(read('dist/app/.vite/manifest.json')),shell=vite['src/ui/shell.ts'];assert(shell,'Production shell manifest');
 const worker=one((shell.assets??[]).filter(path=>/^assets\/worker-[A-Za-z0-9_-]+\.js$/.test(path)),'manifest native worker');
 const wasm=one(evidence.outputs.filter(output=>/^assets\/canvaskit-[A-Za-z0-9_-]+\.wasm$/.test(output.file)),'sealed emitted WASM').file;
 const workerPin=pin('dist/app/'+worker,read),wasmPin=pin('dist/app/'+wasm,read);
 const identity={schema:1,kind:KIND,expected:{workerPath:'/'+worker,workerSHA256:workerPin.sha256,workerBytes:workerPin.bytes,wasmPath:'/'+wasm,wasmSHA256:wasmPin.sha256,wasmBytes:wasmPin.bytes},build:{command:'npm run build:app',toolchain:{...evidence.toolchain},inputs:structuredClone(evidence.sourceInputs),outputs:[pin('dist/app/index.html',read),pin('dist/app/.vite/manifest.json',read),pin('dist/app/build-evidence.json',read),workerPin,wasmPin].sort((a,b)=>a.path.localeCompare(b.path))},sealedWasm:{manifest:pin('vendor/text/manifest.json',read),engineVersion:SEALED_WASM.engineVersion,engineSourceRevision:SEALED_WASM.engineSourceRevision}};
 auditApplicationIdentity(identity,{read});return identity;
}

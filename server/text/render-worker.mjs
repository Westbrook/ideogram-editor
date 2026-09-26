// File-only host for the exact shared browser rendering algorithm. No network.
import {parentPort, workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {canonical} from '../../src/protocol/json.ts';
import {prepareText} from '../../src/text/core.ts';
import profile from '../../src/text/profile.json';
const require=createRequire(import.meta.url);
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const sealed=(path,entry)=>{const b=readFileSync(path);if(b.length!==entry.bytes||hash(b)!=='sha256:'+entry.sha256)throw Error('TEXT_ENGINE_HASH');return b;};
try {
 const js=require.resolve('canvaskit-wasm');sealed(js,profile.engine.js);
 const wasm=sealed(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'),profile.engine.wasm);
 const module=new WebAssembly.Module(wasm),memoryName=WebAssembly.Module.exports(module).find(e=>e.kind==='memory')?.name;
 if(!memoryName)throw Error('TEXT_ENGINE_ABI');
 const ck=await require('canvaskit-wasm')({instantiateWasm(imports,receive){const instance=new WebAssembly.Instance(module,imports);if(instance.exports[memoryName].buffer.byteLength!==16777216)throw Error('TEXT_HEAP_PROFILE');receive(instance);return instance.exports;}});
 if(ck.ParagraphBuilder.RequiresClientICU())throw Error('TEXT_UNICODE_PROFILE');
 // Startup input/compile ownership ends before font and output phase admission.
 parentPort.postMessage({type:'ready'});
 await new Promise(resolve=>parentPort.once('message',resolve));
 const fonts=workerData.fonts.map(f=>{const bytes=readFileSync(f.path);if(bytes.length!==f.length||hash(bytes)!==f.hash)throw Error('FONT_HASH');return {hash:f.hash,bytes:new Blob([bytes]),faceIndex:0,origin:f.origin,license:{hash:f.licenseHash,embedding:'permitted'}};});
 const p=await prepareText({...workerData.request,fonts},ck,workerData.profile??profile.id);
 if(workerData.expected){const layout=readFileSync(workerData.expected.layoutPath);if(hash(layout)!==workerData.expected.layoutHash||canonical(JSON.parse(layout))!==canonical(JSON.parse(await p.layout.text()))||p.rasterHash!==workerData.expected.pixelsHash||p.textHash!==workerData.expected.textHash||p.overflow!==workerData.expected.overflow)throw Error('TEXT_NATIVE_MISMATCH');}
 parentPort.postMessage(workerData.expected?{type:'result',verified:true}:{type:'result',layout:await p.layout.text(),layoutHash:p.layoutHash,rasterHash:p.rasterHash,textHash:p.textHash,width:p.width,height:p.height,overflow:p.overflow,heapBytes:ck.HEAPU8.byteLength});
} catch(e){parentPort.postMessage({type:'failure',code:e.code??e.message,details:e.details});}
finally{parentPort.close();}

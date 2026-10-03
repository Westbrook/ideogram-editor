// File-only host for the exact shared browser rendering algorithm. No network.
import {parentPort, workerData} from 'node:worker_threads';
import {createReadStream,readFileSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {canonical} from '../../src/protocol/json.ts';
import {prepareText} from '../../src/text/core.ts';
import profile from '../../src/text/profile.json';
import prior from '../../src/text/retained-profiles/c19791ae.json';
import rejected from '../../src/text/retained-profiles/b89503d3.json';
import maskPrior from '../../src/text/retained-profiles/6e8a481e.json';
import gridPrior from '../../src/text/retained-profiles/d047f5be.json';
import placementPrior from '../../src/text/retained-profiles/304528c9.json';
import compositionPrior from '../../src/text/retained-profiles/ff24a513.json';
import streamedPrior from '../../src/text/retained-profiles/f5e8bd34.json';
import frameOrderPrior from '../../src/text/retained-profiles/7a4dbc6c.json';
import ownershipPrior from '../../src/text/retained-profiles/4fd6f6a1.json';
import integrationPrior from '../../src/text/retained-profiles/68efa85f.json';
import combinedCPUPrior from '../../src/text/retained-profiles/6d77f925.json';
import adapterOwnershipPrior from '../../src/text/retained-profiles/c6ca02c2.json';
import httpFramingPrior from '../../src/text/retained-profiles/1c399d52.json';
import deferredManifestPrior from '../../src/text/retained-profiles/e648eede.json';
import startupProfilePrior from '../../src/text/retained-profiles/891a4688.json';
import textResourcesPrior from '../../src/text/retained-profiles/b96236b0.json';
import admissionSplitPrior from '../../src/text/retained-profiles/2e9362c1.json';
import paragraphBudgetPrior from '../../src/text/retained-profiles/6f7be5be.json';
import contentCodingPrior from '../../src/text/retained-profiles/95244362.json';
const require=createRequire(import.meta.url);
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const sealed=(path,entry)=>{const b=readFileSync(path);if(b.length!==entry.bytes||hash(b)!=='sha256:'+entry.sha256)throw Error('TEXT_ENGINE_HASH');return b;};
const layoutLimit=8388608;
const retainedProfiles=new Set([prior.id,rejected.id,maskPrior.id,gridPrior.id,placementPrior.id,compositionPrior.id,streamedPrior.id,frameOrderPrior.id,ownershipPrior.id,integrationPrior.id,combinedCPUPrior.id,adapterOwnershipPrior.id,httpFramingPrior.id,deferredManifestPrior.id,startupProfilePrior.id,textResourcesPrior.id,admissionSplitPrior.id,paragraphBudgetPrior.id,contentCodingPrior.id]);
export function restoreRetainedFrameOrder(expected,frame){
 if(!frame||typeof frame!=='object'||Object.keys(frame).length!==2||!Object.hasOwn(frame,'width')||!Object.hasOwn(frame,'height')||![frame.width,frame.height].every(value=>Number.isFinite(value)&&value>0&&value<=8192))throw Error('TEXT_NATIVE_MISMATCH');
 const fd=openSync(expected.layoutPath,'r');
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||stat.size>layoutLimit)throw Error('TEXT_NATIVE_MISMATCH');
  const prefix=Buffer.alloc(512);let length=0;
  while(length<prefix.length){const bytes=readSync(fd,prefix,length,prefix.length-length,length);if(!bytes)break;length+=bytes;}
  const header=prefix.subarray(0,length).toString('utf8'),start='{"version":"layout-1","policy":"text-layout-1","frame":';
  for(const ordered of [{width:frame.width,height:frame.height},{height:frame.height,width:frame.width}]){
   if(header.startsWith(start+JSON.stringify(ordered)+',"indexConvention":'))return ordered;
  }
  throw Error('TEXT_NATIVE_MISMATCH');
 }finally{closeSync(fd);}
}
export async function verifyPreparedLayout(expected,prepared,rendererProfile,text){
 if(rendererProfile!==profile.id&&!retainedProfiles.has(rendererProfile))throw Error('TEXT_NATIVE_MISMATCH');
 // The staged layout has already passed the schema/index proof. A current
 // candidate must reproduce its exact bytes: do not build two JSON graphs and
 // their canonical strings merely to compare the deterministic output again.
 const digest=createHash('sha256');let length=0;
 for await(const chunk of createReadStream(expected.layoutPath,{highWaterMark:65536})){
  length+=chunk.length;if(length>layoutLimit)throw Error('TEXT_NATIVE_MISMATCH');digest.update(chunk);
 }
 if('sha256:'+digest.digest('hex')!==expected.layoutHash)throw Error('TEXT_NATIVE_MISMATCH');
 if(rendererProfile===profile.id||rendererProfile===frameOrderPrior.id||rendererProfile===ownershipPrior.id||rendererProfile===integrationPrior.id||rendererProfile===combinedCPUPrior.id||rendererProfile===adapterOwnershipPrior.id||rendererProfile===httpFramingPrior.id||rendererProfile===deferredManifestPrior.id||rendererProfile===startupProfilePrior.id||rendererProfile===textResourcesPrior.id||rendererProfile===admissionSplitPrior.id||rendererProfile===paragraphBudgetPrior.id||rendererProfile===contentCodingPrior.id){if(prepared.layoutHash!==expected.layoutHash)throw Error('TEXT_NATIVE_MISMATCH');return;}
 // Retained profiles historically accepted canonical key reordering. Their
 // original preflight limited this path to at most480 scalars (and8MiB layout),
 // so new larger current-profile requests never enter the legacy graph path.
 let scalars=0,lines=1;for(const character of text){scalars++;if(character==='\n')lines++;}
 const glyphs=Math.max(64,8*scalars),legacyLayout=16384+1024*(glyphs+scalars+Math.max(lines,glyphs));
 if(legacyLayout>layoutLimit||prepared.layout.size>layoutLimit)throw Error('TEXT_NATIVE_MISMATCH');
 const retained=readFileSync(expected.layoutPath);
 if(hash(retained)!==expected.layoutHash||canonical(JSON.parse(retained))!==canonical(JSON.parse(await prepared.layout.text())))throw Error('TEXT_NATIVE_MISMATCH');
}
if(parentPort)try {
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
 const rendererProfile=workerData.profile??profile.id;
 const request=rendererProfile===frameOrderPrior.id&&workerData.expected?{...workerData.request,frame:restoreRetainedFrameOrder(workerData.expected,workerData.request.frame)}:workerData.request;
 const p=await prepareText({...request,fonts},ck,rendererProfile);
 if(workerData.expected){await verifyPreparedLayout(workerData.expected,p,workerData.profile??profile.id,workerData.request.text);if(p.rasterHash!==workerData.expected.pixelsHash||p.textHash!==workerData.expected.textHash||p.overflow!==workerData.expected.overflow)throw Error('TEXT_NATIVE_MISMATCH');}
 parentPort.postMessage(workerData.expected?{type:'result',verified:true}:{type:'result',layout:await p.layout.text(),layoutHash:p.layoutHash,rasterHash:p.rasterHash,textHash:p.textHash,width:p.width,height:p.height,overflow:p.overflow,heapBytes:ck.HEAPU8.byteLength});
} catch(e){parentPort.postMessage({type:'failure',code:e.code??e.message,details:e.details});}
finally{parentPort.close();}

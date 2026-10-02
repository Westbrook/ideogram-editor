import {ActiveCompute} from '../../dist/local/server/raster/active-compute.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {rootFor} from '../store/helpers.mjs';
import {runRaster,hash,PIPELINE} from '../../dist/local/server/raster/engine.js';
import {compositionResourcePlan} from '../../dist/local/server/raster/resource-plan.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {rasterManifest,contributionStack} from '../../dist/local/src/protocol/validate.js';

const identity=[1,0,0,1,0,0],rgba='application/x-ideogram-rgba8';
const ref=(bytes,mediaType)=>({hash:hash(bytes),byteLength:String(bytes.length),mediaType});
const pixelIdentity=(width,height,tiles)=>hash(canonical({pipeline:PIPELINE,width,height,tiles}));
async function input(root,id,width,height,values,coverage){
 const directory=await mkdtemp(join(root,id+'-')),path=join(directory,'pixels.rgba'),bytes=Buffer.from(values);
 assert.equal(bytes.length,width*height*4);await writeFile(path,bytes,{mode:0o600});
 const pixels=ref(bytes,rgba),manifest=ref(Buffer.from(canonical({id,width,height,pixels})),'application/json');
 const value={id,path,info:{schemaVersion:coverage?2:1,pipeline:PIPELINE,width,height,pixels,manifest,pixelIdentity:hash(bytes),role:coverage?'mask':'composite',sourceAssetIds:[],conversion:null}};
 if(coverage){const data=Buffer.alloc(width*height*2);coverage.forEach((n,i)=>data.writeUInt16LE(n,i*2));value.coveragePath=join(directory,'effective.r16');await writeFile(value.coveragePath,data,{mode:0o600});}
 return value;
}
const layer=(source,overrides={})=>({assetId:source.id,transform:identity,opacity:1,mask:null,...overrides});
async function compose(root,width,height,layers,inputs,capture=true){
 const directory=await mkdtemp(join(root,'compose-')),state=ref(Buffer.from('{"captured":"state"}'),'application/json');
 const requestSource={schemaVersion:1,documentId:'document_capture',documentRevision:'7',image:{state,semanticDigest:'sha256:'+'b'.repeat(64),compositeAssetId:null},scope:layers.length===1?'single-layer':'selected-layers',layerIds:layers.map((_,i)=>'layer_'+i)};
 let admission;
 const compute=new ActiveCompute();let activeRead;try{
 const result=await runRaster({type:'compose',directory,width,height,layers,inputs,dependencies:[...inputs.map(i=>i.info.manifest),...(capture?[state]:[])],...(capture?{requestSource}:{})},async p=>{admission=structuredClone(p);},()=>{},undefined,compute);
 assert.deepEqual(admission,compositionResourcePlan(width,height,layers,inputs,capture));assert.deepEqual(result.plan,admission);
 activeRead=compute.readSnapshot();const active=activeRead.value;assert.equal(active.kind,'raster-active-compute-1');assert.equal(active.complete,true);assert.equal(active.outcome,'completed');assert.equal(active.invalid,0);assert.ok(active.operations.contribution>0);assert.ok(active.unionMs>=0&&active.unionMs<=result.metrics.computeMs);assert.equal(active.totalMs,active.unionMs);assert.ok(active.intervals.length<=128);assert.equal(active.omittedIntervals,active.intervalCount-active.intervals.length);assert.equal(admission.allocations.activeKernelTelemetry,65536);
 let prior=-Infinity,sampled=0;for(const interval of active.intervals){assert.ok(interval.startMs>=prior&&interval.endMs>=interval.startMs);sampled+=interval.endMs-interval.startMs;prior=interval.endMs;}assert.ok(sampled<=active.unionMs+1e-7);
 rasterManifest(result.manifest);
 const files=new Map(result.files.map(f=>[f.ref.hash,join(directory,f.name)]));for(const i of inputs)files.set(i.info.pixels.hash,i.path);
 const read=async r=>{const path=files.get(r.hash);assert.ok(path,'retained bytes for '+r.hash);const bytes=await readFile(path);assert.equal(hash(bytes),r.hash);assert.equal(String(bytes.length),r.byteLength);return bytes;};
 const stack=capture?JSON.parse((await read(result.manifest.plan.contributions)).toString()):null;
 if(stack)contributionStack(stack);
 const contributions=[];for(const entry of stack?.contributions??[]){const manifest=JSON.parse((await read(entry.manifest)).toString());rasterManifest(manifest);assert.equal(entry.pixelIdentity,pixelIdentity(width,height,manifest.tiles));assert.deepEqual(entry.pixels,manifest.pixels);contributions.push({entry,manifest,bytes:await read(entry.pixels)});}
 return {directory,result,admission,stack,contributions,bytes:await read(result.info.pixels)};
 }finally{activeRead?.release();compute.dispose();}
}

test('captured ordered Ks retain the exact CP1 opacity boundary used by ordinary composition',async t=>{
 const root=await rootFor(t),black=await input(root,'opaque_black',1,1,[0,0,0,255]),white=await input(root,'white',1,1,[255,255,255,255]);
 const layers=[layer(black),layer(white,{opacity:.1})],inputs=[black,white];
 const captured=await compose(root,1,1,layers,inputs),ordinary=await compose(root,1,1,layers,inputs,false);
 assert.deepEqual([...captured.bytes],[90,90,90,255]);assert.deepEqual(captured.bytes,ordinary.bytes);
 assert.deepEqual([...captured.contributions[0].bytes],[0,0,0,255]);assert.deepEqual([...captured.contributions[1].bytes],[255,255,255,26]);
 assert.deepEqual(captured.contributions[0].entry.pixels,black.info.pixels);
 for(let i=0;i<2;i++){
  const k=captured.contributions[i],source=inputs[i];
  assert.deepEqual(k.manifest.plan,{kind:'cp1-layer-contribution-v1',layer:layers[i],source:source.info.manifest,mask:null,maskMapping:'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprint:{x:-1,y:-1,width:3,height:3}});
  assert.deepEqual(k.manifest.dependencies,[source.info.manifest]);
  assert.equal(k.entry.pixelIdentity,pixelIdentity(1,1,[{x:0,y:0,width:1,height:1,hash:hash(k.bytes)}]));
 }
 assert.deepEqual(captured.result.manifest.dependencies,[captured.result.manifest.plan.contributions,captured.result.manifest.plan.capture.image.state]);
 assert.equal(captured.result.files.filter(f=>f.name.endsWith('.png')).length,1);
 assert.equal(captured.result.files.filter(f=>f.name.startsWith('contribution-')&&f.name.endsWith('.rgba')).length,1);
 const singleton=await compose(root,1,1,[layers[1]],[white]);assert.equal(singleton.result.info.pixelIdentity,captured.contributions[1].entry.pixelIdentity);
});

test('a singleton captured K shares source pixels exactly after one transform, R16 mask and opacity pass',async t=>{
 const root=await rootFor(t),white=await input(root,'masked_white',2,1,[255,255,255,255,255,255,255,255]);
 const mask=await input(root,'appearance',4,1,Array(4).fill([0,0,0,255]).flat(),[65535,32768,65535,0]);
 const l=layer(white,{transform:[1,0,0,1,1,0],opacity:.5,mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}});
 const captured=await compose(root,4,1,[l],[white,mask]),k=captured.contributions[0];
 assert.deepEqual([...k.bytes],[0,0,0,0,255,255,255,64,255,255,255,128,0,0,0,0]);assert.deepEqual(k.bytes,captured.bytes);
 assert.deepEqual(k.entry.pixels,captured.result.info.pixels);assert.equal(k.entry.pixelIdentity,captured.result.info.pixelIdentity);
 assert.equal(k.manifest.schemaVersion,2);assert.deepEqual(k.manifest.plan.mask,mask.info.manifest);assert.deepEqual(k.manifest.dependencies,[white.info.manifest,mask.info.manifest]);
 assert.equal(captured.result.files.filter(f=>f.name.startsWith('contribution-')&&f.name.endsWith('.rgba')).length,0);
 const forged=structuredClone(k.manifest);forged.dependencies=forged.dependencies.filter(r=>r.hash!==mask.info.manifest.hash);assert.throws(()=>rasterManifest(forged));
});

test('retained K tile views cross 512 boundaries, share duplicate content, and reserve staging before work',async t=>{
 const root=await rootFor(t),width=513,height=2,white=await input(root,'wide_white',width,height,Array(width*height).fill([255,255,255,255]).flat());
 const l=layer(white,{opacity:.1}),captured=await compose(root,width,height,[l,l],[white]);
 const k=captured.contributions[0],expected=Buffer.from(Array(width*height).fill([255,255,255,26]).flat());assert.deepEqual(k.bytes,expected);
 assert.deepEqual(captured.stack.contributions[0],captured.stack.contributions[1]);
 const tile0=Buffer.from(Array(512*2).fill([255,255,255,26]).flat()),tile1=Buffer.from(Array(2).fill([255,255,255,26]).flat());
 assert.deepEqual(k.manifest.tiles,[{x:0,y:0,width:512,height:2,hash:hash(tile0)},{x:512,y:0,width:1,height:2,hash:hash(tile1)}]);
 assert.equal(k.entry.pixelIdentity,pixelIdentity(width,height,k.manifest.tiles));
 assert.equal(captured.result.files.filter(f=>f.name.startsWith('contribution-')&&f.name.endsWith('.rgba')).length,1);
 assert.equal(captured.result.files.filter(f=>f.name.startsWith('contribution-')&&f.name.endsWith('.json')).length,1);
 assert.equal((await readdir(captured.directory)).filter(name=>/^contribution-.*\.rgba$/.test(name)).length,1);
 assert.ok(captured.admission.diskBytes>=width*height*4*5+3*65536);assert.equal(captured.admission.allocations.contributionMetadata,3*65536);
 assert.equal(captured.result.files.filter(f=>f.name.endsWith('.png')).length,1);
 const sourceBefore=await readFile(white.path);assert.deepEqual(sourceBefore,Buffer.from(Array(width*height).fill([255,255,255,255]).flat()));
 const forged=structuredClone(captured.stack);forged.contributions[0].pixels.byteLength='4';assert.throws(()=>contributionStack(forged));
});

test('integer identity capture preserves hidden RGB and reuses the immutable native raw object',async t=>{
 const root=await rootFor(t),hidden=await input(root,'hidden_native',2,1,[17,99,231,0,20,40,60,128]);
 const captured=await compose(root,2,1,[layer(hidden)],[hidden]),k=captured.contributions[0];
 assert.deepEqual([...captured.bytes],[17,99,231,0,20,40,60,128]);assert.deepEqual(k.entry.pixels,hidden.info.pixels);assert.deepEqual(k.entry.pixels,captured.result.info.pixels);
 assert.equal(captured.result.files.filter(f=>f.name.startsWith('contribution-')&&f.name.endsWith('.rgba')).length,0);
 const legacy=structuredClone(captured.result.manifest);delete legacy.plan.contributions;legacy.dependencies=[legacy.plan.capture.image.state,hidden.info.manifest];assert.doesNotThrow(()=>rasterManifest(legacy));
});

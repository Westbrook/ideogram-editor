// Additive staged tests; run only after the coordinated overlay is promoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {rootFor} from '../store/helpers.mjs';
import {runRaster,hash,PIPELINE} from '../../dist/local/server/raster/engine.js';
import {rasterFailure} from '../../dist/local/server/raster/failure.js';
import {createIdentityRequestPlan,createRequestRasterPlan} from '../../dist/local/src/request/raster-plan.js';
import {rasterManifest} from '../../dist/local/src/protocol/validate.js';

const rgba='application/x-ideogram-rgba8',r16='application/x-ideogram-r16le';
const ref=(bytes,mediaType)=>({hash:hash(bytes),byteLength:String(bytes.length),mediaType});
const coverageBytes=values=>{const bytes=Buffer.alloc(values.length*2);values.forEach((value,index)=>bytes.writeUInt16LE(value,index*2));return bytes;};
async function fixture(root,values){
 const width=values.length,height=1,directory=await mkdtemp(join(root,'inputs-'));
 // A completely black preview deliberately conceals one-unit R16 support.
 const preview=Buffer.from(values.flatMap(()=>[0,0,0,255])),coverage=coverageBytes(values),pixels=ref(preview,rgba),effective=ref(coverage,r16);
 const path=join(directory,'mask.rgba'),coveragePath=join(directory,'effective.r16');await writeFile(path,preview,{mode:0o600});await writeFile(coveragePath,coverage,{mode:0o600});
 const maskManifest=ref(Buffer.from('{"fixture":"mask"}'),'application/json'),source=ref(Buffer.from('{"fixture":"source"}'),'application/json');
 const sourcePixels=ref(Buffer.from(values.flatMap(()=>[19,41,97,128])),rgba);
 const input={id:'mask_input',path,coveragePath,info:{schemaVersion:2,pipeline:PIPELINE,width,height,pixels,manifest:maskManifest,pixelIdentity:hash(preview),role:'mask',sourceAssetIds:[],conversion:null}};
 const common={document:{width,height},sourcePixels,authoredMask:effective,effectiveMask:effective,dependenciesHash:hash('reviewed-originals'),resolution:'already-contained',approvalId:'reviewed_mapping'};
 return {input,source,sourcePixels,effective,preview,coverage,common};
}
async function black(root,f,plan,sourcePixels=f.sourcePixels){
 const directory=await mkdtemp(join(root,'black-'));
 const dependencies=[f.source,f.input.info.manifest,sourcePixels,plan.sourcePixels,plan.authoredMask,plan.effectiveMask];
 const result=await runRaster({type:'v45-edit-mask',directory,input:f.input,source:f.source,sourceAssetId:'source_input',sourcePixels,plan,dependencies},async()=>{},()=>{});
 rasterManifest(result.manifest);return {directory,result,pixels:await readFile(join(directory,'pixels.rgba'))};
}
test('V45 black-edit PNG uses positive final R16 support, leaves V4 polarity and original bytes intact',async t=>{
 const root=await rootFor(t),f=await fixture(root,[0,1,32768,65535]),plan=createIdentityRequestPlan({...f.common,domain:{x:0,y:0,width:4,height:1}}),before=structuredClone(plan);
 const output=await black(root,f,plan),expected=Buffer.from([255,255,255,255,0,0,0,255,0,0,0,255,0,0,0,255]);
 assert.deepEqual(output.pixels,expected);assert.deepEqual((await sharp(join(output.directory,'output.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true})).data,expected);
 const p=output.result.manifest.plan;assert.equal(p.kind,'v45-edit-mask-v1');assert.equal(p.polarity,'black-edit');assert.deepEqual(p.statistics,{editPixels:3,keepPixels:1});assert.deepEqual(p.requestPlan,plan);assert.deepEqual(p.sourcePixels,f.sourcePixels);
 const directory=await mkdtemp(join(root,'v4-')),legacy=await runRaster({type:'request-mask',directory,input:f.input,plan,dependencies:[f.input.info.manifest,plan.sourcePixels,plan.authoredMask,plan.effectiveMask]},async()=>{},()=>{});
 assert.equal(legacy.manifest.plan.kind,'request-mask-binary-v1');assert.deepEqual(await readFile(join(directory,'pixels.rgba')),Buffer.from([0,0,0,255,255,255,255,255,255,255,255,255,255,255,255,255]));
 assert.deepEqual(await readFile(f.input.path),f.preview);assert.deepEqual(await readFile(f.input.coveragePath),f.coverage);assert.deepEqual(plan,before);
 for(const mutate of [m=>m.plan.polarity='white-edit',m=>m.plan.statistics.keepPixels=0,m=>m.plan.sourcePixels.byteLength='4',m=>m.dependencies=m.dependencies.filter(r=>r.hash!==f.source.hash)]){const changed=structuredClone(output.result.manifest);mutate(changed);assert.throws(()=>rasterManifest(changed));}
});

test('V45 binary output retains mapped one-unit support and binds the transported source grid',async t=>{
 const root=await rootFor(t),f=await fixture(root,[0,0,0,1,0,0,0,0]),plan=createRequestRasterPlan({...f.common,crop:{x:0,y:0,width:8,height:1},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:4,height:1}});
 const transportedSource=ref(Buffer.alloc(16),rgba),output=await black(root,f,plan,transportedSource);
 assert.deepEqual(output.pixels,Buffer.from([255,255,255,255,0,0,0,255,0,0,0,255,255,255,255,255]));
 assert.deepEqual(output.result.manifest.plan.statistics,{editPixels:2,keepPixels:2});assert.deepEqual(output.result.manifest.plan.sourcePixels,transportedSource);
 assert.deepEqual(await readFile(f.input.coveragePath),f.coverage);
 await assert.rejects(black(root,f,plan,f.sourcePixels),/RASTER_SOURCE_MAPPING/);
});

for(const values of [[0,0,0,0],[1,65535,32768,1]])test('V45 rejects homogeneous provider coverage with a terminal worker reason: '+values.join(','),async t=>{
 const root=await rootFor(t),f=await fixture(root,values),plan=createIdentityRequestPlan({...f.common,domain:{x:0,y:0,width:4,height:1}});
 await assert.rejects(black(root,f,plan),error=>{assert.equal(error.message,'RASTER_V45_EDIT_MASK_HOMOGENEOUS');assert.deepEqual(rasterFailure(error),{code:'RASTER_V45_EDIT_MASK_HOMOGENEOUS'});return true;});
 assert.deepEqual(await readFile(f.input.coveragePath),f.coverage);
});

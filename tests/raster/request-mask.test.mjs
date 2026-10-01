import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {rootFor} from '../store/helpers.mjs';
import {runRaster,hash,PIPELINE} from '../../dist/local/server/raster/engine.js';
import {createIdentityRequestPlan,createRequestRasterPlan,createActualOutputMapping} from '../../dist/local/src/request/raster-plan.js';
import {rasterManifest} from '../../dist/local/src/protocol/validate.js';

const rgbaType='application/x-ideogram-rgba8',coverageType='application/x-ideogram-r16le';
const ref=(bytes,mediaType)=>({hash:hash(bytes),byteLength:String(bytes.length),mediaType});
const r16=values=>{const bytes=Buffer.alloc(values.length*2);values.forEach((value,index)=>bytes.writeUInt16LE(value,index*2));return bytes;};
const identity=[1,0,0,1,0,0];
const black=[0,0,0,255],white=[255,255,255,255];
// These files stand for already-retained inputs. Expected results below are
// literal CP1 goldens, never values calculated by the implementation under test.
async function retained(root,id,width,height,values,coverage){
 const directory=await mkdtemp(join(root,id+'-')),path=join(directory,'pixels.rgba'),bytes=Buffer.from(values);
 assert.equal(bytes.length,width*height*4);await writeFile(path,bytes,{mode:0o600});
 const pixels=ref(bytes,rgbaType),manifest=ref(Buffer.from(JSON.stringify({id,width,height,pixels})),'application/json');
 const info={schemaVersion:coverage?2:1,pipeline:PIPELINE,width,height,manifest,pixels,pixelIdentity:hash(bytes),role:coverage?'mask':'composite',sourceAssetIds:[],conversion:null};
 const input={id,info,path};let effective;
 if(coverage){assert.equal(coverage.length,width*height);const bytes=r16(coverage);input.coveragePath=join(directory,'effective.r16');input.hardPath=join(directory,'hard.r16');await writeFile(input.coveragePath,bytes,{mode:0o600});await writeFile(input.hardPath,bytes,{mode:0o600});effective=ref(bytes,coverageType);}
 return {input,directory,effective,hard:effective};
}
async function raster(root,id,job){
 const directory=await mkdtemp(join(root,id+'-')),result=await runRaster({...job,directory},async()=>{},()=>{});
 if(job.type==='preserve-request'){const active=result.activeCompute;assert.equal(active.complete,true);assert.equal(active.invalid,0);assert.equal(active.operations.preserve,job.plan.document.height);assert.ok(active.intervalCount>=active.operations.preserve);assert.ok(active.intervals.length<=128);assert.equal(active.omittedIntervals,active.intervalCount-active.intervals.length);assert.equal(active.unionMs,active.totalMs);assert.ok(active.unionMs<=result.metrics.elapsedMs);}
 rasterManifest(result.manifest);
 return {result,directory,input:{id,info:result.info,path:join(directory,'pixels.rgba'),...(result.info.role==='mask'?{coveragePath:join(directory,'effective.r16'),hardPath:join(directory,'hard.r16')}:{})}};
}
const bytes=async fixture=>[...await readFile(join(fixture.directory,'pixels.rgba'))];
const common=(source,mask)=>({document:{width:source.input.info.width,height:source.input.info.height},sourcePixels:source.input.info.pixels,authoredMask:mask.hard,effectiveMask:mask.effective,dependenciesHash:'sha256:'+'a'.repeat(64),resolution:'already-contained',approvalId:'fixture-approval'});
const dependencies=(plan,...inputs)=>[...inputs.map(input=>input.info.manifest),plan.sourcePixels,plan.authoredMask,plan.effectiveMask];
const maskDependencies=source=>[source.input.info.manifest,source.input.info.pixels];
function missingDependencies(manifest,refs){for(const dependency of refs){const changed=structuredClone(manifest);changed.dependencies=changed.dependencies.filter(value=>value.hash!==dependency.hash);assert.throws(()=>rasterManifest(changed),dependency.hash);}}

test('binary request manifest retains exact plan dependencies and validates historical resize manifests',async t=>{
 const root=await rootFor(t),maskDirectory=await mkdtemp(join(root,'mask-'));
 const mask=await runRaster({type:'mask',directory:maskDirectory,plan:{width:3,height:2,feather:64,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:0,width:1,height:2},mode:'replace'}]},inputs:[],dependencies:[]},async()=>{},()=>{});
 const plan=createIdentityRequestPlan({document:{width:3,height:2},domain:{x:0,y:0,width:3,height:2},sourcePixels:mask.info.pixels,authoredMask:mask.manifest.plan.hard,effectiveMask:mask.manifest.plan.effective,dependenciesHash:'sha256:'+'a'.repeat(64),resolution:'already-contained',approvalId:'fixture-approval'});
 const directory=await mkdtemp(join(root,'transport-')),dependencies=[mask.info.manifest,plan.sourcePixels,plan.authoredMask,plan.effectiveMask];
 const transport=await runRaster({type:'request-mask',directory,plan,input:{id:'mask_fixture',info:mask.info,path:join(maskDirectory,'pixels.rgba'),coveragePath:join(maskDirectory,'effective.r16')},dependencies},async()=>{},()=>{});
 assert.deepEqual(transport.manifest.plan,{kind:'request-mask-binary-v1',source:mask.info.manifest,requestPlan:plan});assert.deepEqual(transport.manifest.dependencies,dependencies);rasterManifest(transport.manifest);
 assert.deepEqual([...await readFile(join(directory,'pixels.rgba'))],Array(24).fill(255));
 for(const dependency of dependencies){const changed=structuredClone(transport.manifest);changed.dependencies=changed.dependencies.filter(r=>r.hash!==dependency.hash);assert.throws(()=>rasterManifest(changed));}
 const changed=structuredClone(transport.manifest);changed.plan.requestPlan.sourceToRequest=[2,0,0,2,0,0];assert.throws(()=>rasterManifest(changed),/MASK_MAPPING_REVIEW_REQUIRED/);
 const old=structuredClone(transport.manifest);old.plan={kind:'request-mask-resize',source:mask.info.manifest,from:{width:3,height:2},mapping:'stretch',kernel:'triangle-area-r16-linear-v1'};assert.doesNotThrow(()=>rasterManifest(old));
});

test('request capture retains CP1 contribution once and source transport binds that exact capture',async t=>{
 const root=await rootFor(t),source=await retained(root,'capture_input',2,1,[...white,...white]);
 const appearanceMask=await retained(root,'appearance_mask',4,1,Array(4).fill(black).flat(),[65535,32768,65535,0]);
 const imageState=ref(Buffer.from('{"fixture":"captured-image-state"}'),'application/json');
 const capture={schemaVersion:1,documentId:'document_fixture',documentRevision:'7',image:{state:imageState,semanticDigest:'sha256:'+'b'.repeat(64),compositeAssetId:null},scope:'single-layer',layerIds:['layer_fixture']};
 const layer={assetId:source.input.id,transform:[1,0,0,1,1,0],opacity:.5,mask:{assetId:appearanceMask.input.id,mapping:'document-r16-v1',inverted:false}};
 const captured=await raster(root,'captured_source',{type:'compose',width:4,height:1,layers:[layer],inputs:[source.input,appearanceMask.input],dependencies:[imageState,source.input.info.manifest,appearanceMask.input.info.manifest,appearanceMask.effective],requestSource:capture});
 const expected=[0,0,0,0,255,255,255,64,255,255,255,128,0,0,0,0];
 assert.deepEqual(await bytes(captured),expected);
 assert.equal(captured.result.manifest.plan.kind,'request-source-capture-v1');
 assert.deepEqual(captured.result.manifest.plan.capture,capture);assert.deepEqual(captured.result.manifest.plan.layers,[layer]);
 missingDependencies(captured.result.manifest,[imageState]);
 const forgedCapture=structuredClone(captured.result.manifest);forgedCapture.plan.capture.image.state={...forgedCapture.plan.capture.image.state,byteLength:'1'};assert.throws(()=>rasterManifest(forgedCapture));
 const authored=await retained(root,'edit_mask',4,1,Array(4).fill(white).flat(),[65535,65535,65535,65535]);
 const plan=createIdentityRequestPlan({...common(captured,authored),domain:{x:0,y:0,width:4,height:1}}),deps=dependencies(plan,captured.input);
 const transport=await raster(root,'source_transport',{type:'request-source',input:captured.input,plan,dependencies:deps});
 assert.deepEqual(await bytes(transport),expected);assert.deepEqual(await bytes(captured),expected);
 assert.deepEqual(transport.result.manifest.plan,{kind:'request-source-transport-v1',source:captured.input.info.manifest,requestPlan:plan});
 assert.deepEqual(transport.result.manifest.dependencies,deps);missingDependencies(transport.result.manifest,deps);
 const forgedRef=structuredClone(transport.result.manifest);forgedRef.dependencies=forgedRef.dependencies.map(value=>value.hash===plan.sourcePixels.hash?{...value,mediaType:'application/octet-stream'}:value);assert.throws(()=>rasterManifest(forgedRef));
 const changedSource={...captured.input,info:{...captured.input.info,pixels:{...captured.input.info.pixels,hash:'sha256:'+'c'.repeat(64)}}};
 await assert.rejects(raster(root,'wrong_source',{type:'request-source',input:changedSource,plan,dependencies:deps}),/RASTER_SOURCE_MAPPING/);
});

test('request source and binary mask transports retain explicit transparent padding and sealed crop edges',async t=>{
 const root=await rootFor(t),source=await retained(root,'padding_source',2,1,[17,99,231,0,20,40,60,128]);
 const mask=await retained(root,'padding_mask',2,1,[...white,...black],[65535,1]);
 const plan=createRequestRasterPlan({...common(source,mask),crop:{x:0,y:0,width:2,height:1},padding:{left:1,top:0,right:1,bottom:0},requestGrid:{width:4,height:1}});
 const transported=await raster(root,'padded_source',{type:'request-source',input:source.input,plan,dependencies:dependencies(plan,source.input)});
 assert.deepEqual(await bytes(transported),[0,0,0,0,17,99,231,0,20,40,60,128,0,0,0,0]);
 const binary=await raster(root,'padded_mask',{type:'request-mask',input:mask.input,plan,dependencies:dependencies(plan,mask.input)});
 assert.deepEqual(await bytes(binary),[...black,...white,...white,...black]);
 const forgedGrid=structuredClone(binary.result.manifest);forgedGrid.plan.requestPlan.requestGrid.width=3;assert.throws(()=>rasterManifest(forgedGrid));
 const cropSource=await retained(root,'crop_source',8,1,[[255,0,0,255],[255,0,0,255],black,black,black,black,[255,0,0,255],[255,0,0,255]].flat());
 const cropMask=await retained(root,'crop_mask',8,1,Array(8).fill(black).flat(),[0,0,0,65535,65535,0,0,0]);
 const cropPlan=createRequestRasterPlan({...common(cropSource,cropMask),crop:{x:2,y:0,width:4,height:1},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:2,height:1}});
 const cropped=await raster(root,'cropped_source',{type:'request-source',input:cropSource.input,plan:cropPlan,dependencies:dependencies(cropPlan,cropSource.input)});
 assert.deepEqual(await bytes(cropped),[0,0,0,239,0,0,0,239]);
 assert.deepEqual(await bytes(cropSource),[[255,0,0,255],[255,0,0,255],black,black,black,black,[255,0,0,255],[255,0,0,255]].flat());
});

test('resized binary transport reads one-unit R16 coverage even when its entire preview is black',async t=>{
 const root=await rootFor(t),source=await retained(root,'thin_source',8,1,Array(8).fill(white).flat());
 const mask=await retained(root,'thin_mask',8,1,Array(8).fill(black).flat(),[0,0,0,1,0,0,0,0]);
 const plan=createRequestRasterPlan({...common(source,mask),crop:{x:0,y:0,width:8,height:1},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:4,height:1}});
 const binary=await raster(root,'thin_binary',{type:'request-mask',input:mask.input,plan,dependencies:dependencies(plan,mask.input)});
 assert.deepEqual(await bytes(binary),[...black,...white,...white,...black]);
 assert.deepEqual(await bytes(mask),Array(8).fill(black).flat());
 assert.deepEqual(await readFile(mask.input.coveragePath),r16([0,0,0,1,0,0,0,0]));
});

test('request mask clips only feathered coverage, retains hard samples and counts discarded support exactly',async t=>{
 const root=await rootFor(t),source=await retained(root,'clip_source',12,5,Array(60).fill(white).flat());
 const authoring={width:12,height:5,feather:2,operations:[{kind:'shape',shape:{kind:'rectangle',x:4,y:0,width:4,height:5},mode:'replace'}]};
 const unclipped=await raster(root,'unclipped_mask',{type:'mask',plan:authoring,inputs:[],dependencies:maskDependencies(source),request:{source:source.input,clip:null}});
 const clip={x:4,y:0,width:4,height:5};
 const clipped=await raster(root,'clipped_mask',{type:'mask',plan:authoring,inputs:[],dependencies:maskDependencies(source),request:{source:source.input,clip}});
 const hard=[0,0,0,0,65535,65535,65535,65535,0,0,0,0],middle=[0,0,0,0,49151,65535,65535,49151,0,0,0,0],edge=[0,0,0,0,36863,49151,49151,36863,0,0,0,0];
 assert.deepEqual(await readFile(clipped.input.hardPath),r16(Array(5).fill(hard).flat()));
 assert.deepEqual(await readFile(clipped.input.hardPath),await readFile(unclipped.input.hardPath));
 assert.deepEqual(await readFile(clipped.input.coveragePath),r16([edge,middle,middle,middle,edge].flat()));
 assert.deepEqual([...await readFile(unclipped.input.coveragePath)].slice(48,72),[...r16([0,0,0,16384,49151,65535,65535,49151,16384,0,0,0])]);
 const p=clipped.result.manifest.plan;
 assert.deepEqual(p,{kind:'authored-request-mask-v1',authoring,hard:unclipped.result.manifest.plan.hard,effective:ref(r16([edge,middle,middle,middle,edge].flat()),coverageType),statistics:{hardPixels:20,effectivePixels:20,support:clip},sourceAssetId:source.input.id,source:source.input.info.manifest,sourcePixels:source.input.info.pixels,clip,lostEffectivePixels:10});
 assert.equal(unclipped.result.manifest.plan.lostEffectivePixels,0);assert.equal(unclipped.result.manifest.plan.statistics.effectivePixels,30);
 missingDependencies(clipped.result.manifest,[source.input.info.manifest,source.input.info.pixels,p.hard,p.effective]);
 const forgedSource=structuredClone(clipped.result.manifest);forgedSource.plan.sourcePixels={...forgedSource.plan.sourcePixels,byteLength:'4'};assert.throws(()=>rasterManifest(forgedSource));
});

test('request preservation keeps captured half-alpha K and every M0 hidden source byte',async t=>{
 const root=await rootFor(t),sourceBytes=[[17,99,231,0],[20,30,40,128],[23,41,91,0],[255,255,255,128],[90,90,90,255],[11,22,33,255],[44,55,66,0],[77,88,99,128]].flat();
 const original=await retained(root,'original_source',8,1,sourceBytes),state=ref(Buffer.from('{"fixture":"half-alpha-capture"}'),'application/json');
 const capture={schemaVersion:1,documentId:'document_fixture',documentRevision:'8',image:{state,semanticDigest:'sha256:'+'d'.repeat(64),compositeAssetId:null},scope:'single-layer',layerIds:['layer_fixture']};
 const source=await raster(root,'half_alpha_capture',{type:'compose',width:8,height:1,layers:[{assetId:original.input.id,transform:identity,opacity:1,mask:null}],inputs:[original.input],dependencies:[state,original.input.info.manifest],requestSource:capture});
 assert.deepEqual(await bytes(source),sourceBytes);
 const mask=await retained(root,'preservation_mask',8,1,Array(8).fill(black).flat(),[0,0,0,32768,65535,0,0,0]);
 const candidate=await retained(root,'candidate',4,1,[...black,0,0,0,128,...black,...black]);
 const plan=createIdentityRequestPlan({...common(source,mask),domain:{x:2,y:0,width:4,height:1}}),deps=dependencies(plan,source.input,candidate.input,mask.input);
 const prepared=await raster(root,'prepared',{type:'preserve-request',source:source.input,candidate:candidate.input,mask:mask.input,plan,dependencies:deps});
 assert.deepEqual(await bytes(prepared),[[17,99,231,0],[20,30,40,128],[23,41,91,0],[188,188,188,128],black,[11,22,33,255],[44,55,66,0],[77,88,99,128]].flat());
 assert.deepEqual(await bytes(source),sourceBytes);assert.deepEqual([prepared.result.info.width,prepared.result.info.height],[8,1]);
 assert.deepEqual(prepared.result.manifest.plan,{kind:'request-preservation-v1',source:source.input.info.manifest,candidate:candidate.input.info.manifest,mask:mask.input.info.manifest,requestPlan:plan,outputMapping:null});
 missingDependencies(prepared.result.manifest,deps);
});

test('mapped request preservation reconstructs candidate colors into the full source grid',async t=>{
 const root=await rootFor(t),sourceBytes=Array.from({length:12},(_,x)=>[17+x,99,231,x%2?128:0]).flat();
 const source=await retained(root,'mapped_source',12,1,sourceBytes),mask=await retained(root,'mapped_mask',12,1,Array(12).fill(black).flat(),[0,0,0,0,0,65535,65535,0,0,0,0,0]);
 const candidate=await retained(root,'mapped_candidate',2,1,[255,0,0,255,0,0,255,255]);
 const plan=createRequestRasterPlan({...common(source,mask),crop:{x:4,y:0,width:4,height:1},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:2,height:1}});
 const prepared=await raster(root,'mapped_prepared',{type:'preserve-request',source:source.input,candidate:candidate.input,mask:mask.input,plan,dependencies:dependencies(plan,source.input,candidate.input,mask.input)});
 assert.deepEqual(await bytes(prepared),[[17,99,231,0],[18,99,231,128],[19,99,231,0],[20,99,231,128],[21,99,231,0],[225,0,137,255],[137,0,225,255],[24,99,231,128],[25,99,231,0],[26,99,231,128],[27,99,231,0],[28,99,231,128]].flat());
 assert.deepEqual(await bytes(source),sourceBytes);
});

test('changed actual output needs an exact approved successor and uses only its clipped effective coverage',async t=>{
 const root=await rootFor(t),sourceBytes=Array(12).fill([17,99,231,0]).flat();
 const source=await retained(root,'successor_source',12,1,sourceBytes),mask=await retained(root,'successor_mask',12,1,Array(12).fill(black).flat(),[0,0,0,1,65535,65535,65535,65535,1,0,0,0]);
 const candidate=await retained(root,'successor_candidate',2,1,[...black,...black]);
 const plan=createRequestRasterPlan({...common(source,mask),crop:{x:2,y:0,width:8,height:1},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:4,height:1}}),before=structuredClone(plan);
 const deps=dependencies(plan,source.input,candidate.input,mask.input),job={type:'preserve-request',source:source.input,candidate:candidate.input,mask:mask.input,plan,dependencies:deps};
 await assert.rejects(raster(root,'unreviewed_output',job),/OUTPUT_MAPPING_REVIEW_REQUIRED/);
 const clipped=await retained(root,'successor_clipped_mask',12,1,Array(12).fill(black).flat(),[0,0,0,0,65535,65535,65535,65535,0,0,0,0]);
 const mapping=createActualOutputMapping(plan,{actualOutput:{width:2,height:1},effectiveMask:clipped.effective,resolution:'clipped-and-approved',approvalId:'actual-output-approval'});
 await assert.rejects(raster(root,'unclipped_output',{...job,outputMapping:mapping,dependencies:[...deps,clipped.effective]}),/MASK_DOMAIN_REVIEW_REQUIRED/);
 // The approved successor changes the effective file while the retained mask
 // and original request provenance continue to identify the authored request.
 const successorJob={...job,mask:{...mask.input,coveragePath:clipped.input.coveragePath},outputMapping:mapping,dependencies:[...deps,clipped.effective]};
 const prepared=await raster(root,'successor_prepared',successorJob);
 assert.deepEqual(await bytes(prepared),[[17,99,231,0],[17,99,231,0],[17,99,231,0],[17,99,231,0],black,black,black,black,[17,99,231,0],[17,99,231,0],[17,99,231,0],[17,99,231,0]].flat());
 assert.deepEqual(prepared.result.manifest.plan.requestPlan,before);assert.deepEqual(prepared.result.manifest.plan.outputMapping,mapping);assert.deepEqual(prepared.result.manifest.plan.mask,mask.input.info.manifest);assert.deepEqual(plan,before);assert.deepEqual(await bytes(source),sourceBytes);
 missingDependencies(prepared.result.manifest,[plan.effectiveMask,clipped.effective]);
 for(const patch of [{approvalId:plan.approvalId},{outputToDocument:[1,0,0,1,2,0]},{reconstructionHalo:mapping.reconstructionHalo+1},{requestPlan:{...plan,approvalId:'different-plan-approval'}}]){
  await assert.rejects(raster(root,'forged_successor',{...successorJob,outputMapping:{...mapping,...patch}}),/REQUEST_RASTER_APPROVAL_REQUIRED|MASK_MAPPING_REVIEW_REQUIRED|OUTPUT_MAPPING_REVIEW_REQUIRED/);
 }
 const wrongCandidate=await retained(root,'wrong_successor_candidate',3,1,[...black,...black,...black]);
 await assert.rejects(raster(root,'wrong_actual_dimensions',{...successorJob,candidate:wrongCandidate.input}),/OUTPUT_MAPPING_REVIEW_REQUIRED/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityRequestPlan,createRequestRasterPlan,validateRequestRasterPlan,requirePlanDependencies,inspectRequestCoverage,inspectRequestCoverageRows,requireRequestCoverage,requireRequestCoverageRows,clipRequestCoverage,providerMaskRow,providerSourceRow,requestRasterGrid,requestSafeInterior,requireActualOutput,preserveRequestRow,preserveMappedRequestRow,createActualOutputMapping,requireOutputMapping,proposeRequestExpansion,proposeRequestExpansionBounds,proposeIntegerRequestCrop,sourceRequestFootprint} from '../../dist/local/src/request/raster-plan.js';
import {featherRows} from '../../dist/local/src/raster/mask.js';

const hash=n=>'sha256:'+String(n).repeat(64);
const ref=(n,width,height,bytes)=>({hash:hash(n),byteLength:String(width*height*bytes),mediaType:bytes===4?'application/x-ideogram-rgba8':'application/x-ideogram-r16le'});
function input(width=12,height=5,domain={x:4,y:0,width:4,height}){
 return {document:{width,height},domain,sourcePixels:ref(1,width,height,4),authoredMask:ref(2,width,height,2),effectiveMask:ref(3,width,height,2),dependenciesHash:hash(4),resolution:'already-contained',approvalId:'approval_1'};
}
const coverage=(rows)=>({width:rows[0].length,height:rows.length,get(x,y){return rows[y]?.[x]??0;}});
const code=expected=>error=>error.code===expected;
const literalFeather=[0,0,0,16384,49151,65535,65535,49151,16384,0,0,0];
const strips=height=>coverage(Array.from({length:height},()=>literalFeather));

test('identity request plan captures complete immutable grid/dependencies and the exact zero-halo mapping',()=>{
 const draft=input(),plan=createIdentityRequestPlan(draft);
 assert.deepEqual(plan.sourceToRequest,[1,0,0,1,-4,0]);
 assert.deepEqual(plan.expectedOutput,{width:4,height:5});
 assert.equal(plan.reconstructionHalo,0);
 draft.document.width=3;draft.domain.x=7;draft.sourcePixels.hash=hash(7);
 assert.equal(plan.document.width,12);assert.equal(plan.domain.x,4);assert.equal(plan.sourcePixels.hash,hash(1));
 const expected={document:plan.document,sourcePixels:plan.sourcePixels,authoredMask:plan.authoredMask,effectiveMask:plan.effectiveMask,dependenciesHash:plan.dependenciesHash};
 requirePlanDependencies(plan,expected);
 for(const key of ['sourcePixels','authoredMask','effectiveMask'])assert.throws(()=>requirePlanDependencies(plan,{...expected,[key]:{...expected[key],hash:hash(8)}}),code('REQUEST_RASTER_DEPENDENCIES_CHANGED'));
 assert.throws(()=>requirePlanDependencies(plan,{...expected,dependenciesHash:hash(9)}),code('REQUEST_RASTER_DEPENDENCIES_CHANGED'));
 assert.throws(()=>requirePlanDependencies(plan,{...expected,document:{width:11,height:5}}),code('REQUEST_RASTER_DEPENDENCIES_CHANGED'));
});

test('unsupported resize, padding, fractional crop, unknown kernels and forged halo are refused before use',()=>{
 const p=createIdentityRequestPlan(input());
 for(const patch of [{kernel:'triangle-unknown'},{reconstructionHalo:1},{sourceToRequest:[.5,0,0,1,-2,0]},{sourceToRequest:[1,0,0,1,-3,0]},{expectedOutput:{width:2,height:5}},{domain:{x:4.5,y:0,width:4,height:5}},{domain:{x:-1,y:0,width:4,height:5}},{domain:{x:11,y:0,width:4,height:5}}])assert.throws(()=>validateRequestRasterPlan({...p,...patch}),code('MASK_MAPPING_REVIEW_REQUIRED'));
 assert.throws(()=>validateRequestRasterPlan({...p,resolution:'unresolved'}),code('REQUEST_RASTER_APPROVAL_REQUIRED'));
 assert.throws(()=>validateRequestRasterPlan({...p,approvalId:''}),code('REQUEST_RASTER_APPROVAL_REQUIRED'));
 assert.throws(()=>validateRequestRasterPlan({...p,unreviewed:true}),code('REQUEST_RASTER_PLAN_INVALID'));
 assert.throws(()=>validateRequestRasterPlan({...p,effectiveMask:{...p.effectiveMask,mediaType:'image/png'}}),code('REQUEST_RASTER_IDENTITY'));
 assert.throws(()=>validateRequestRasterPlan({...p,effectiveMask:{...p.effectiveMask,byteLength:'1'}}),code('REQUEST_RASTER_IDENTITY'));
 assert.throws(()=>createIdentityRequestPlan(input(5001,5000,{x:0,y:0,width:5001,height:5000})),code('REQUEST_RASTER_EXTENT'));
});

test('F02 identity crop rejects feather support and explicit clip retains the original R16 samples without reblur',()=>{
 const plan=createIdentityRequestPlan(input()),full=strips(5),observed=inspectRequestCoverage(plan,full);
 assert.deepEqual(observed,{effectivePixels:30,lostPixels:10,fullDocument:false,fullDomain:true,contained:false});
 assert.throws(()=>requireRequestCoverage(plan,full),code('MASK_DOMAIN_REVIEW_REQUIRED'));
 // Independently frozen F02 row validates that this same R16 authoring output
 // reaches the request-domain check, rather than a display PNG reconstruction.
 const row=featherRows({width:12,height:5,get:(x,y)=>x>=4&&x<8&&y>=0&&y<5?65535:0},2);
 assert.deepEqual([...row(2)],literalFeather);
 const clipped=clipRequestCoverage({...plan,resolution:'clipped-and-approved'},full);
 assert.deepEqual(Array.from({length:12},(_,x)=>clipped.get(x,2)),[0,0,0,0,49151,65535,65535,49151,0,0,0,0]);
 assert.deepEqual(requireRequestCoverage(plan,clipped),{effectivePixels:20,lostPixels:0,fullDocument:false,fullDomain:true,contained:true});
 // The proposal helper never mutates the frozen feathered baseline.
 assert.equal(full.get(3,2),16384);assert.equal(full.get(8,2),16384);
 const expanded=createIdentityRequestPlan({...input(),domain:{x:3,y:0,width:6,height:5},resolution:'expanded-and-approved',approvalId:'approval_2'});
 assert.equal(requireRequestCoverage(expanded,full).effectivePixels,30);
 assert.deepEqual(providerMaskRow(expanded,full,2),Uint8Array.from(Array(6).fill([255,255,255,255]).flat()));
});

test('provider mask is opaque binary conservative support, including one-unit and fractional R16 edits',()=>{
 const p=createIdentityRequestPlan(input(5,1,{x:0,y:0,width:5,height:1})),m=coverage([[0,1,16384,32768,65535]]);
 assert.deepEqual(requireRequestCoverage(p,m),{effectivePixels:4,lostPixels:0,fullDocument:false,fullDomain:false,contained:true});
 assert.deepEqual([...providerMaskRow(p,m,0)],[0,0,0,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255]);
 assert.deepEqual([...providerMaskRow(p,coverage([[1,1,1,1,1]]),0)],Array(5).fill([255,255,255,255]).flat());
 assert.equal(requireRequestCoverage(p,coverage([[1,1,1,1,1]])).fullDocument,true);
 assert.throws(()=>providerMaskRow(p,m,1),code('REQUEST_MASK_ROW'));
 assert.throws(()=>providerMaskRow(p,coverage([[0]]),0),code('REQUEST_MASK_GRID_MISMATCH'));
 for(const value of [-1,65536,.5,NaN])assert.throws(()=>requireRequestCoverage(p,coverage([[0,0,value,0,0]])),code('REQUEST_MASK_COVERAGE_INVALID'));
 assert.throws(()=>requireRequestCoverage(p,coverage([[0,0,0,0,0]])),code('EMPTY_MASK'));
});

test('actual output mismatch requires a distinct mapping review and cannot rewrite the frozen plan',()=>{
 const p=createIdentityRequestPlan(input()),before=structuredClone(p);
 requireActualOutput(p,4,5);
 for(const [w,h] of [[1,5],[2,5],[4,4],[4.5,5],[NaN,5]])assert.throws(()=>requireActualOutput(p,w,h),code('OUTPUT_MAPPING_REVIEW_REQUIRED'));
 assert.deepEqual(p,before);
 // A claimed resize cannot rescue previously uncontained support.
 assert.throws(()=>requireRequestCoverage({...p,expectedOutput:{width:2,height:5}},strips(5)),code('MASK_MAPPING_REVIEW_REQUIRED'));
});

test('cropped prepared rows preserve every M=0 source byte, including hidden RGB and pixels outside the request',()=>{
 const p=createIdentityRequestPlan(input(8,1,{x:2,y:0,width:4,height:1})),m=coverage([[0,0,0,32768,65535,0,0,0]]);
 const source=Uint8Array.from([[17,99,231,0],[20,30,40,128],[23,41,91,0],[255,255,255,255],[90,90,90,255],[11,22,33,255],[44,55,66,0],[77,88,99,128]].flat());
 const candidate=Uint8Array.from(Array(4).fill([0,0,0,255]).flat()),before=source.slice();
 const actual=preserveRequestRow(p,source,candidate,m,0);
 const expected=before.slice();expected.set([188,188,188,255,0,0,0,255],3*4);
 assert.deepEqual(actual,expected);assert.deepEqual(source,before);
 assert.throws(()=>preserveRequestRow(p,source,candidate.subarray(4),m,0),code('OUTPUT_MAPPING_REVIEW_REQUIRED'));
 assert.throws(()=>preserveRequestRow(p,source,candidate,coverage([[1,0,0,0,0,0,0,0]]),0),code('MASK_DOMAIN_REVIEW_REQUIRED'));
});

test('rows above and below a crop remain the complete captured source with no invented candidate samples',()=>{
 const p=createIdentityRequestPlan(input(2,3,{x:0,y:1,width:2,height:1})),m=coverage([[0,0],[65535,0],[0,0]]),source=Uint8Array.from([17,99,231,0,255,0,0,128]);
 for(const y of [0,2])assert.deepEqual(preserveRequestRow(p,source,null,m,y),source);
 assert.throws(()=>preserveRequestRow(p,source,null,m,1),code('OUTPUT_MAPPING_REVIEW_REQUIRED'));
 const clipped=clipRequestCoverage(p,coverage([[1,0],[0,0],[0,1]]));
 assert.throws(()=>requireRequestCoverage(p,clipped),code('EMPTY_MASK'));
});

function mapped(width=12,height=5,crop={x:4,y:0,width:4,height},requestGrid={width:2,height},padding={left:0,top:0,right:0,bottom:0},extra={}){
 const {domain,...common}=input(width,height,crop);
 return createRequestRasterPlan({...common,crop,padding,requestGrid,...extra});
}
const pixels=(width,height,values)=>({width,height,get(x,y,out){out.set(values.slice((y*width+x)*4,(y*width+x+1)*4));}});
const flatPixels=(width,height,value)=>pixels(width,height,Array.from({length:width*height},()=>value).flat());
const values=(m,y)=>Array.from({length:m.width},(_,x)=>m.get(x,y));

test('CP14/CP15 pinned F02 resized mapping uses safe [5,7), expansion [2,10) to 4, and no second blur',()=>{
 const plan=mapped(),full=strips(5),before=structuredClone(plan);
 assert.deepEqual(plan.sourceToRequest,[.5,0,0,1,-2,0]);
 assert.deepEqual(plan.outputToDocument,[2,0,0,1,4,0]);
 assert.equal(plan.reconstructionHalo,1);
 assert.deepEqual(requestSafeInterior(plan),{x:5,y:0,width:2,height:5});
 assert.deepEqual(inspectRequestCoverage(plan,full),{effectivePixels:30,lostPixels:20,fullDocument:false,fullDomain:true,contained:false});
 assert.throws(()=>requireRequestCoverage(plan,full),code('MASK_DOMAIN_REVIEW_REQUIRED'));
 const clipped=clipRequestCoverage(plan,full);
 assert.deepEqual(values(clipped,2),[0,0,0,0,0,65535,65535,0,0,0,0,0]);
 assert.equal(requireRequestCoverage(plan,clipped).effectivePixels,10);
 const expanded=proposeRequestExpansion(plan,full);
 assert.deepEqual(expanded,{crop:{x:2,y:0,width:8,height:5},padding:{left:0,top:0,right:0,bottom:0},domain:{x:2,y:0,width:8,height:5},requestGrid:{width:4,height:5},expectedOutput:{width:4,height:5}});
 const accepted=mapped(12,5,expanded.crop,expanded.requestGrid,expanded.padding,{expectedOutput:expanded.expectedOutput,resolution:'expanded-and-approved',approvalId:'approval_2'});
 assert.deepEqual(requestSafeInterior(accepted),{x:3,y:0,width:6,height:5});
 assert.equal(requireRequestCoverage(accepted,full).effectivePixels,30);
 assert.deepEqual(plan,before);assert.deepEqual(values(full,2),literalFeather);
});

test('source forward support is validated independently when approved request and output grids differ',()=>{
 const p=mapped(12,1,{x:4,y:0,width:4,height:1},{width:2,height:1},undefined,{expectedOutput:{width:4,height:1}});
 // Output identity alone would accept 4..7; positive input influence on
 // hypothetical request samples -1/2 forbids the edge source cells 4 and 7.
 assert.deepEqual(requestSafeInterior(p),{x:5,y:0,width:2,height:1});
 assert.throws(()=>requireRequestCoverage(p,coverage([[0,0,0,0,1,0,0,0,0,0,0,0]])),code('MASK_DOMAIN_REVIEW_REQUIRED'));
 assert.equal(requireRequestCoverage(p,coverage([[0,0,0,0,0,1,0,0,0,0,0,0]])).contained,true);
});

test('conservative area-integrated provider masks keep a one-unit thin edit and remain opaque',()=>{
 const p=mapped(8,1,{x:0,y:0,width:8,height:1},{width:4,height:1}),m=coverage([[0,0,0,1,0,0,0,0]]);
 requireRequestCoverage(p,m);
 // Source x=3 influences request x=1 strongly and x=2 with weight 1/16.
 // A grayscale downsample followed by an 8-bit threshold would lose M=1.
 assert.deepEqual([...providerMaskRow(p,m,0)],[0,0,0,255,255,255,255,255,255,255,255,255,0,0,0,255]);
});

test('pure padding stays black, mixed footprints stay conservative, source padding is transparent, and full crop excludes padding',()=>{
 const p=mapped(2,1,{x:0,y:0,width:2,height:1},{width:4,height:1},{left:1,top:0,right:1,bottom:0}),m=coverage([[65535,1]]);
 assert.deepEqual(p.domain,{x:-1,y:0,width:4,height:1});
 assert.deepEqual(requestSafeInterior(p),{x:0,y:0,width:2,height:1});
 assert.deepEqual(inspectRequestCoverage(p,m),{effectivePixels:2,lostPixels:0,fullDocument:true,fullDomain:true,contained:true});
 assert.deepEqual([...providerMaskRow(p,m,0)],[0,0,0,255,255,255,255,255,255,255,255,255,0,0,0,255]);
 const source=pixels(2,1,[17,99,231,0,20,40,60,128]);
 assert.deepEqual([...providerSourceRow(p,source,0)],[0,0,0,0,17,99,231,0,20,40,60,128,0,0,0,0]);
 const resized=mapped(2,1,{x:0,y:0,width:2,height:1},{width:8,height:1},{left:1,top:0,right:1,bottom:0});
 const mask=providerMaskRow(resized,m,0);
 assert.deepEqual([...mask.slice(0,8)],[0,0,0,255,255,255,255,255]);
 assert.deepEqual([...mask.slice(-8)],[255,255,255,255,0,0,0,255]);
 const cropped=mapped(4,1,{x:0,y:0,width:2,height:1},{width:3,height:1},{left:1,top:0,right:0,bottom:0});
 assert.deepEqual(inspectRequestCoverage(cropped,coverage([[1,65535,0,0]])),{effectivePixels:2,lostPixels:0,fullDocument:false,fullDomain:true,contained:true});
 assert.throws(()=>mapped(4,1,{x:1,y:0,width:2,height:1},{width:4,height:1},{left:1,top:0,right:1,bottom:0}),code('MASK_MAPPING_REVIEW_REQUIRED'));
 // The sole request center is x=1, outside this one-pixel document, but its
 // finite inverse footprint includes M(0)=1. A center test loses the edit.
 const thin=mapped(1,1,{x:0,y:0,width:1,height:1},{width:1,height:1},{left:2,top:0,right:3,bottom:0},{expectedOutput:{width:6,height:1}});
 const one=coverage([[1]]);assert.equal(requireRequestCoverage(thin,one).contained,true);
 assert.deepEqual([...providerMaskRow(thin,one,0)],[255,255,255,255]);
});

test('provider source has a sealed triangle-area edge and never reads unapproved exterior context',()=>{
 const p=mapped(8,1,{x:2,y:0,width:4,height:1},{width:2,height:1});
 const source=pixels(8,1,[[255,0,0,255],[255,0,0,255],[0,0,0,255],[0,0,0,255],[0,0,0,255],[0,0,0,255],[255,0,0,255],[255,0,0,255]].flat());
 assert.deepEqual([...providerSourceRow(p,source,0)],[0,0,0,239,0,0,0,239]);
 assert.deepEqual(sourceRequestFootprint(p,{x:0,y:0,width:2,height:1}),{x:2,y:0,width:4,height:1});
 assert.deepEqual(requestRasterGrid(p),{width:2,height:1});
 assert.throws(()=>providerSourceRow(p,flatPixels(1,1,[0,0,0,0]),0),code('REQUEST_RASTER_SOURCE_GRID_MISMATCH'));
 const colorPlan=mapped(12,1,{x:4,y:0,width:4,height:1},{width:2,height:1});
 const colorRow=Array.from({length:12},()=>[255,0,255,255]);
 colorRow.splice(4,4,[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,255,255]);
 assert.deepEqual([...providerSourceRow(colorPlan,pixels(12,1,colorRow.flat()),0)],[182,182,73,239,182,193,247,239]);
});

test('mapped candidate reconstruction preserves the entire original source and literal bilinear RGB values',()=>{
 const p=mapped(12,1,{x:4,y:0,width:4,height:1},{width:2,height:1}),m=coverage([[0,0,0,0,0,65535,65535,0,0,0,0,0]]);
 const source=Uint8Array.from(Array.from({length:12},(_,x)=>[17+x,99,231,x%2?128:0]).flat()),before=source.slice();
 const candidate=pixels(2,1,[255,0,0,255,0,0,255,255]);
 const prepared=preserveMappedRequestRow(p,source,candidate,m,0),expected=source.slice();
 expected.set([225,0,137,255,137,0,225,255],5*4);
 assert.deepEqual(prepared,expected);assert.deepEqual(source,before);
 assert.throws(()=>preserveMappedRequestRow(p,source,flatPixels(1,1,[0,0,0,255]),m,0),code('OUTPUT_MAPPING_REVIEW_REQUIRED'));
 assert.throws(()=>preserveMappedRequestRow(p,source,candidate,coverage([[0,0,0,0,1,0,0,0,0,0,0,0]]),0),code('MASK_DOMAIN_REVIEW_REQUIRED'));
});

test('CP16 actual-output successor binds original immutable plan and rechecks missing reconstruction samples',()=>{
 const p=mapped(),before=structuredClone(p),m=clipRequestCoverage(p,strips(5));
 assert.throws(()=>requireActualOutput(p,1,5),code('OUTPUT_MAPPING_REVIEW_REQUIRED'));
 const mapping=createActualOutputMapping(p,{actualOutput:{width:1,height:5},effectiveMask:p.effectiveMask,resolution:'already-contained',approvalId:'actual_1'});
 assert.deepEqual(requestSafeInterior(p,mapping),{x:6,y:0,width:0,height:5});
 assert.throws(()=>requireRequestCoverage(p,m,mapping),code('MASK_DOMAIN_REVIEW_REQUIRED'));
 assert.throws(()=>requireRequestCoverage(p,clipRequestCoverage(p,m,mapping),mapping),code('EMPTY_MASK'));
 assert.throws(()=>requireOutputMapping(p,{...mapping,actualOutput:{width:2,height:5}},1,5),code('MASK_MAPPING_REVIEW_REQUIRED'));
 assert.throws(()=>requireOutputMapping(p,{...mapping,requestPlan:{...p,domain:{x:3,y:0,width:6,height:5}}},1,5),code('REQUEST_RASTER_APPROVAL_REQUIRED'));
 assert.throws(()=>createActualOutputMapping(p,{actualOutput:{width:1,height:5},effectiveMask:p.effectiveMask,resolution:'already-contained',approvalId:p.approvalId}),code('REQUEST_RASTER_APPROVAL_REQUIRED'));
 assert.deepEqual(p,before);
});

test('actual-output mapping may explicitly clip a changed mask and never changes the source grid',()=>{
 const p=mapped(12,1,{x:2,y:0,width:8,height:1},{width:4,height:1}),m=coverage([[0,0,0,1,65535,65535,65535,65535,1,0,0,0]]);
 requireRequestCoverage(p,m);
 const mapping=createActualOutputMapping(p,{actualOutput:{width:2,height:1},effectiveMask:ref(7,12,1,2),resolution:'clipped-and-approved',approvalId:'actual_clip_1'});
 assert.deepEqual(requestSafeInterior(p,mapping),{x:4,y:0,width:4,height:1});
 const clipped=clipRequestCoverage(p,m,mapping);
 assert.deepEqual(values(clipped,0),[0,0,0,0,65535,65535,65535,65535,0,0,0,0]);
 assert.equal(requireRequestCoverage(p,clipped,mapping).effectivePixels,4);
 const source=Uint8Array.from(Array(12).fill([17,99,231,0]).flat()),candidate=flatPixels(2,1,[0,0,0,255]);
 const actual=preserveMappedRequestRow(p,source,candidate,clipped,0,mapping),expected=source.slice();
 expected.set(Array(4).fill([0,0,0,255]).flat(),4*4);assert.deepEqual(actual,expected);
 assert.throws(()=>createActualOutputMapping(p,{actualOutput:{width:2,height:1},effectiveMask:ref(7,12,1,2),resolution:'already-contained',approvalId:'forged_1'}),code('REQUEST_RASTER_DEPENDENCIES_CHANGED'));
});

test('single-output odd aligned center is admissible while nonuniform floating footprints use the exact sealed inverse',()=>{
 const singleton=mapped(7,1,{x:0,y:0,width:3,height:1},{width:1,height:1});
 assert.deepEqual(requestSafeInterior(singleton),{x:1,y:0,width:1,height:1});
 assert.equal(requireRequestCoverage(singleton,coverage([[0,1,0,0,0,0,0]])).contained,true);
 const rounding=mapped(5,5,{x:1,y:1,width:3,height:3},{width:1,height:5});
 // The sealed 2-D affine inverse yields x=.5000000000000001 at doc x=2;
 // its positive 1e-16 outer weight must not be silently treated as zero.
 assert.equal(requestSafeInterior(rounding).width,0);
 const identityAxis=mapped(9,4,{x:3,y:0,width:4,height:4},{width:4,height:5});
 // Resizing Y disables the full identity passthrough; X must still use the
 // actual 2-D inverse instead of assuming x-scale=1 implies exact sampling.
 assert.equal(requestSafeInterior(identityAxis).x,4);
});

test('CP13 fractional bounds are proposed explicitly; malformed mapping/halo/padding cannot borrow approval',()=>{
 assert.deepEqual(proposeIntegerRequestCrop({x:3.2,y:1.8,width:4.1,height:2.1}),{x:3,y:1,width:5,height:3});
 const p=mapped();
 for(const patch of [{crop:{x:4.5,y:0,width:4,height:5}},{paddingPolicy:'edge-clamp'},{padding:{left:-1,top:0,right:0,bottom:0}},{reconstructionHalo:0},{footprint:'unknown'},{kernel:'unknown'},{sourceToRequest:[.5,0,0,1,-1,0]},{outputToDocument:[2,0,0,1,3,0]}])assert.throws(()=>validateRequestRasterPlan({...p,...patch}),code('MASK_MAPPING_REVIEW_REQUIRED'));
 const proposal=proposeRequestExpansionBounds(mapped(4,1,{x:0,y:0,width:4,height:1},{width:2,height:1}),{x:0,y:0,width:4,height:1});
 assert.deepEqual(proposal,{crop:{x:0,y:0,width:4,height:1},padding:{left:1,top:0,right:1,bottom:0},domain:{x:-1,y:0,width:6,height:1},requestGrid:{width:3,height:1},expectedOutput:{width:3,height:1}});
 assert.throws(()=>proposeRequestExpansion(p,coverage(Array.from({length:5},()=>Array(12).fill(0)))),code('EMPTY_MASK'));
 let rows=0;inspectRequestCoverage(p,strips(5),undefined,()=>rows++);assert.equal(rows,5);
});

test('expansion remains monotone when ceil-sized grids change the exact reconstruction halo',()=>{
 const p=mapped(24,1,{x:9,y:0,width:10,height:1},{width:14,height:1},undefined,{expectedOutput:{width:3,height:1}});
 const proposal=proposeRequestExpansionBounds(p,{x:4,y:0,width:4,height:1});
 assert.deepEqual(proposal.domain,{x:2,y:0,width:17,height:1});
 assert.deepEqual(proposal.requestGrid,{width:24,height:1});
 assert.deepEqual(proposal.expectedOutput,{width:6,height:1});
 const accepted=mapped(24,1,proposal.crop,proposal.requestGrid,proposal.padding,{expectedOutput:proposal.expectedOutput,resolution:'expanded-and-approved',approvalId:'expanded_2'});
 const m=coverage([Array.from({length:24},(_,x)=>x>=4&&x<8?65535:0)]);
 assert.equal(requireRequestCoverage(accepted,m).contained,true);
});

function collectCoverageRows(iterator){
 const yields=[];
 for(;;){const step=iterator.next();if(step.done)return {yields,result:step.value};yields.push(step.value);}
}

test('coverage row inspection yields only complete rows and preserves literal counts, row guards and synchronous order',()=>{
 const plan=createIdentityRequestPlan(input(3,3,{x:1,y:0,width:2,height:2})),before=structuredClone(plan),rows=[[0,1,65535],[32768,1,16384],[1,0,0]],trace=[];
 const measured={width:3,height:3,get(x,y){trace.push(['sample',x,y]);return rows[y][x];}},check=()=>trace.push(['check']);
 const iterator=inspectRequestCoverageRows(plan,measured,undefined,check);
 assert.deepEqual(trace,[],'Creating an iterator must not scan ahead');
 assert.deepEqual(iterator.next(),{value:undefined,done:false});
 assert.deepEqual(trace,[['check'],['sample',0,0],['sample',1,0],['sample',2,0]]);
 assert.deepEqual(iterator.next(),{value:undefined,done:false});
 assert.deepEqual(trace,[['check'],['sample',0,0],['sample',1,0],['sample',2,0],['check'],['sample',0,1],['sample',1,1],['sample',2,1]]);
 assert.deepEqual(iterator.next(),{value:undefined,done:false});
 const expected={effectivePixels:6,lostPixels:2,fullDocument:false,fullDomain:true,contained:false};
 assert.deepEqual(iterator.next(),{value:expected,done:true});
 assert.deepEqual(trace,[['check'],['sample',0,0],['sample',1,0],['sample',2,0],['check'],['sample',0,1],['sample',1,1],['sample',2,1],['check'],['sample',0,2],['sample',1,2],['sample',2,2]]);
 assert.deepEqual(iterator.next(),{value:undefined,done:true});assert.equal(trace.length,12,'Reading completion cannot rescan or invoke another guard');
 const iteratorOrder=structuredClone(trace);trace.length=0;
 assert.deepEqual(inspectRequestCoverage(plan,measured,undefined,check),expected);assert.deepEqual(trace,iteratorOrder);
 assert.throws(()=>requireRequestCoverage(plan,coverage(rows)),code('MASK_DOMAIN_REVIEW_REQUIRED'));assert.deepEqual(plan,before);assert.deepEqual(rows,[[0,1,65535],[32768,1,16384],[1,0,0]]);
});

test('coverage rows honor actual-output containment and explicit clipping without losing nonzero R16 samples',()=>{
 const plan=mapped(12,2,{x:2,y:0,width:8,height:2},{width:4,height:2}),mapping=createActualOutputMapping(plan,{actualOutput:{width:2,height:2},effectiveMask:ref(7,12,2,2),resolution:'clipped-and-approved',approvalId:'rows_actual_1'});
 const rows=[[0,0,0,1,65535,32768,16384,1,1,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0]],raw=coverage(rows),before=structuredClone(mapping);let checks=0,visits=0;
 const measured={width:12,height:2,get(x,y){visits++;return raw.get(x,y);}},expected={effectivePixels:6,lostPixels:2,fullDocument:false,fullDomain:false,contained:false};
 assert.deepEqual(requestSafeInterior(plan,mapping),{x:4,y:0,width:4,height:2});
 assert.deepEqual(collectCoverageRows(inspectRequestCoverageRows(plan,measured,mapping,()=>checks++)),{yields:[undefined,undefined],result:expected});assert.equal(checks,2);assert.equal(visits,24);
 checks=0;visits=0;assert.deepEqual(inspectRequestCoverage(plan,measured,mapping,()=>checks++),expected);assert.equal(checks,2);assert.equal(visits,24);
 assert.throws(()=>requireRequestCoverage(plan,raw,mapping),code('MASK_DOMAIN_REVIEW_REQUIRED'));
 const clipped=clipRequestCoverage(plan,raw,mapping),contained={effectivePixels:4,lostPixels:0,fullDocument:false,fullDomain:false,contained:true};
 assert.deepEqual(values(clipped,0),[0,0,0,0,65535,32768,16384,1,0,0,0,0]);assert.deepEqual(collectCoverageRows(inspectRequestCoverageRows(plan,clipped,mapping)),{yields:[undefined,undefined],result:contained});assert.deepEqual(collectCoverageRows(requireRequestCoverageRows(plan,clipped,mapping)),{yields:[undefined,undefined],result:contained});assert.deepEqual(requireRequestCoverage(plan,clipped,mapping),contained);assert.deepEqual(mapping,before);
});

test('coverage row totals use the real document and crop rather than transparent padding',()=>{
 const plan=mapped(2,2,{x:0,y:0,width:2,height:2},{width:4,height:2},{left:1,top:0,right:1,bottom:0}),mask=coverage([[1,65535],[32768,16384]]),expected={effectivePixels:4,lostPixels:0,fullDocument:true,fullDomain:true,contained:true};let checks=0;
 assert.deepEqual(collectCoverageRows(inspectRequestCoverageRows(plan,mask,undefined,()=>checks++)),{yields:[undefined,undefined],result:expected});assert.equal(checks,2);checks=0;assert.deepEqual(collectCoverageRows(requireRequestCoverageRows(plan,mask,undefined,()=>checks++)),{yields:[undefined,undefined],result:expected});assert.equal(checks,2);assert.deepEqual(inspectRequestCoverage(plan,mask),expected);assert.deepEqual(requireRequestCoverage(plan,mask),expected);
});

test('coverage rows preserve the distinction between uncontained support and an empty clipped successor',()=>{
 const plan=mapped(),mapping=createActualOutputMapping(plan,{actualOutput:{width:1,height:5},effectiveMask:ref(7,12,5,2),resolution:'clipped-and-approved',approvalId:'rows_empty_1'}),raw=clipRequestCoverage(plan,strips(5)),empty=clipRequestCoverage(plan,raw,mapping);
 assert.deepEqual(requestSafeInterior(plan,mapping),{x:6,y:0,width:0,height:5});
 const uncontained={effectivePixels:10,lostPixels:10,fullDocument:false,fullDomain:false,contained:false},zero={effectivePixels:0,lostPixels:0,fullDocument:false,fullDomain:false,contained:true};
 assert.deepEqual(collectCoverageRows(inspectRequestCoverageRows(plan,raw,mapping)),{yields:[undefined,undefined,undefined,undefined,undefined],result:uncontained});assert.deepEqual(inspectRequestCoverage(plan,raw,mapping),uncontained);assert.throws(()=>requireRequestCoverage(plan,raw,mapping),code('MASK_DOMAIN_REVIEW_REQUIRED'));
 assert.deepEqual(collectCoverageRows(inspectRequestCoverageRows(plan,empty,mapping)),{yields:[undefined,undefined,undefined,undefined,undefined],result:zero});assert.deepEqual(inspectRequestCoverage(plan,empty,mapping),zero);assert.throws(()=>requireRequestCoverage(plan,empty,mapping),code('EMPTY_MASK'));
 for(const [mask,error] of [[raw,'MASK_DOMAIN_REVIEW_REQUIRED'],[empty,'EMPTY_MASK']]){let checks=0,visits=0;const measured={width:12,height:5,get(x,y){visits++;return mask.get(x,y);}},iterator=requireRequestCoverageRows(plan,measured,mapping,()=>checks++);
  for(let row=0;row<5;row++){assert.deepEqual(iterator.next(),{value:undefined,done:false});assert.equal(checks,row+1);assert.equal(visits,(row+1)*12);}
  assert.throws(()=>iterator.next(),code(error));assert.equal(checks,5);assert.equal(visits,60);assert.deepEqual(iterator.next(),{value:undefined,done:true});
 }
});

test('coverage rows reject malformed plans, foreign mappings and wrong mask grids before guards or reads',()=>{
 const plan=createIdentityRequestPlan(input(3,2,{x:0,y:0,width:3,height:2})),mapping=createActualOutputMapping(plan,{actualOutput:{width:3,height:2},effectiveMask:plan.effectiveMask,resolution:'already-contained',approvalId:'rows_valid_1'});
 const cases=[
  {plan:{...plan,kernel:'unknown'},mapping:undefined,width:3,height:2,error:'MASK_MAPPING_REVIEW_REQUIRED'},
  {plan,mapping:{...mapping,requestPlan:{...plan,approvalId:'foreign_parent'}},width:3,height:2,error:'REQUEST_RASTER_APPROVAL_REQUIRED'},
  {plan,mapping:{...mapping,outputToDocument:[1,0,0,1,1,0]},width:3,height:2,error:'MASK_MAPPING_REVIEW_REQUIRED'},
  {plan,mapping:undefined,width:2,height:2,error:'REQUEST_MASK_GRID_MISMATCH'},
  {plan,mapping,width:3,height:1,error:'REQUEST_MASK_GRID_MISMATCH'},
 ];
 for(const value of cases){let checks=0,visits=0;const mask={width:value.width,height:value.height,get(){visits++;return 1;}},check=()=>checks++;
  for(const inspect of [inspectRequestCoverageRows,requireRequestCoverageRows]){assert.throws(()=>inspect(value.plan,mask,value.mapping,check).next(),code(value.error));assert.equal(checks,0);assert.equal(visits,0);}
  for(const inspect of [inspectRequestCoverage,requireRequestCoverage]){assert.throws(()=>inspect(value.plan,mask,value.mapping,check),code(value.error));assert.equal(checks,0);assert.equal(visits,0);}
 }
});

test('coverage rows reject an invalid R16 sample without yielding a partial row or reading later cells',()=>{
 const plan=createIdentityRequestPlan(input(3,2,{x:0,y:0,width:3,height:2}));
 for(const inspect of [inspectRequestCoverageRows,requireRequestCoverageRows])for(const invalid of [-1,65536,.5,NaN,Infinity,undefined,null,'1']){
  const rows=[[0,1,65535],[1,invalid,32768]],visits=[];let checks=0;
  const mask={width:3,height:2,get(x,y){visits.push([x,y]);return rows[y][x];}},check=()=>checks++,iterator=inspect(plan,mask,undefined,check);
  assert.deepEqual(iterator.next(),{value:undefined,done:false});assert.equal(checks,1);assert.deepEqual(visits,[[0,0],[1,0],[2,0]]);
  assert.throws(()=>iterator.next(),code('REQUEST_MASK_COVERAGE_INVALID'));assert.equal(checks,2);assert.deepEqual(visits,[[0,0],[1,0],[2,0],[0,1],[1,1]]);
  assert.deepEqual(iterator.next(),{value:undefined,done:true});assert.equal(visits.length,5);
  const sync=inspect===inspectRequestCoverageRows?inspectRequestCoverage:requireRequestCoverage;visits.length=0;checks=0;assert.throws(()=>sync(plan,mask,undefined,check),code('REQUEST_MASK_COVERAGE_INVALID'));assert.equal(checks,2);assert.deepEqual(visits,[[0,0],[1,0],[2,0],[0,1],[1,1]]);
 }
});

test('a stale owner between coverage yields rejects before the next row samples any mask bytes',()=>{
 for(const inspect of [inspectRequestCoverageRows,requireRequestCoverageRows]){
 const plan=createIdentityRequestPlan(input(2,3,{x:0,y:0,width:2,height:3})),staleError=new Error('source ownership changed'),trace=[];let stale=false;
 const mask={width:2,height:3,get(x,y){trace.push(['sample',x,y]);return 1;}},check=()=>{trace.push(['check']);if(stale)throw staleError;},iterator=inspect(plan,mask,undefined,check);
 assert.deepEqual(iterator.next(),{value:undefined,done:false});assert.deepEqual(trace,[['check'],['sample',0,0],['sample',1,0]]);
 // A real caller can await here and discover changed ownership before resuming.
 stale=true;assert.throws(()=>iterator.next(),error=>error===staleError);assert.deepEqual(trace,[['check'],['sample',0,0],['sample',1,0],['check']]);assert.deepEqual(iterator.next(),{value:undefined,done:true});assert.equal(trace.length,4);
 trace.length=0;assert.throws(()=>inspect(plan,mask,undefined,check).next(),error=>error===staleError);assert.deepEqual(trace,[['check']]);
 const sync=inspect===inspectRequestCoverageRows?inspectRequestCoverage:requireRequestCoverage;trace.length=0;assert.throws(()=>sync(plan,mask,undefined,check),error=>error===staleError);assert.deepEqual(trace,[['check']]);
 }
});

test('stopping coverage iteration after a completed row performs no later guard or mask read',()=>{
 for(const inspect of [inspectRequestCoverageRows,requireRequestCoverageRows]){
 const plan=createIdentityRequestPlan(input(2,3,{x:0,y:0,width:2,height:3}));let checks=0,visits=0;
 const iterator=inspect(plan,{width:2,height:3,get(){visits++;return 1;}},undefined,()=>checks++);
 assert.deepEqual(iterator.next(),{value:undefined,done:false});assert.equal(checks,1);assert.equal(visits,2);
 assert.deepEqual(iterator.return(),{value:undefined,done:true});assert.deepEqual(iterator.next(),{value:undefined,done:true});assert.equal(checks,1);assert.equal(visits,2);
 }
});

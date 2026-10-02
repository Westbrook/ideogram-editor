import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL} from '../owned-preview-module.mjs';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function module(path,replacements={}){let value=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))value=value.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(value);}
const promptURL=await module('src/observability/prompt-memory.ts',{'./allocations.js':allocationsURL});
const modelURL=await module('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptURL});
const displayControlURL=await module('src/observability/display-control.ts',{'./model-memory.js':modelURL});
const controlURL=await module('src/state/control-memory.ts',{'../observability/allocations.js':allocationsURL});
let code=(await transformWithOxc(await readFile('src/ui/authoring.ts','utf8'),'src/ui/authoring.ts')).code;
const replacements={
  '../observability/allocations.js':allocationsURL,
  '../observability/model-memory.js':modelURL,
  '../observability/prompt-memory.js':promptURL,
  '../state/control-memory.js':controlURL,
  './display-image.js':data('export const displayImage=value=>value;'),
  '../observability/display-preview.js':data(`import {ownDisplayControl,readOwnedDisplayControl,DISPLAY_SOURCE_CONTROL_BYTES} from ${JSON.stringify(displayControlURL)};
   export const createDisplayPreviewURL=()=>{},readDisplaySource=()=>{},sourceFromAsset=()=>{},validateDisplayImage=()=>{},revokeDisplayPreviewURL=url=>globalThis.__authoringPatternTestRevoke(url);
   export async function withDisplaySource(transport,id,options,consume){const owner=await readOwnedDisplayControl('fixture-display-source',DISPLAY_SOURCE_CONTROL_BYTES,()=>readDisplaySource(transport,id,options));try{return await consume(owner.value);}finally{owner.release();}}
   export async function withAssetDisplaySource(asset,basis,consume){const owner=ownDisplayControl('fixture-display-source',DISPLAY_SOURCE_CONTROL_BYTES,()=>sourceFromAsset(asset,basis));try{return await consume(owner.value);}finally{owner.release();}}`),
  '../raster/mapping.js':data('export const retainedMask=()=>false,r16Mask=()=>false;'),
  '../raster/mask.js':data('export const validateMaskPlan=()=>{},validateShape=()=>{},maskDraftValue=()=>{},maskBindings=()=>{},resolveMaskPlan=()=>{};'),
  './adapters.js':data('export class ControlAdapter{invalidate(){}}'),
  '../protocol/sha256.js':data('export class SHA256{}'),
  lit:data('export const html=()=>{},nothing=null;'),
};
for(const [name,url] of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
const {Authoring}=await import(data(code)),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
function fixture(){
  const previous=globalThis.document,previousRevoke=globalThis.__authoringPatternTestRevoke,surfaces=[],contexts=[],revoked=[];let failReset=false,failPattern=false,failURL=false;
  globalThis.__authoringPatternTestRevoke=url=>{revoked.push(url);if(failURL&&url==='blob:failed')throw Error('native URL revoke failed');};
  function context(){
    const ctx={depth:0,patterns:[],fills:[],save(){this.depth++;},restore(){this.depth--;},setLineDash(){},strokeRect(){},
      fillRect(...bounds){this.fills.push({bounds,style:this.fillStyle,alpha:this.globalAlpha});},
      createPattern(canvas,repeat){assert.equal(repeat,'repeat');if(failPattern)return null;const pattern={canvas,index:this.patterns.length};this.patterns.push(pattern);return pattern;}};
    contexts.push(ctx);return ctx;
  }
  globalThis.document={createElement(name){
    assert.equal(name,'canvas');assert(allocationLedger.snapshot().byKind.canvas.cpuBytes>=300*150*4);
    let width=300,height=150;const calls=[],tile={beginPath(){calls.push(['begin']);},moveTo(...p){calls.push(['move',...p]);},lineTo(...p){calls.push(['line',...p]);},stroke(){calls.push(['stroke',this.strokeStyle]);}};
    const canvas={get width(){return width;},set width(value){if(value===0&&failReset)throw Error('native reset failed');width=value;},get height(){return height;},set height(value){height=value;},getContext(name){assert.equal(name,'2d');return tile;},calls};
    surfaces.push(canvas);return canvas;
  }};
  const owner=new Authoring({},()=>{},()=>{},async()=>{}),preview=()=>{owner.preview={views:{},supportRect:{x:3,y:4,width:10,height:20}};};preview();
  return {owner,surfaces,contexts,context,preview,revoked,failReset:value=>{failReset=value;},failPattern:value=>{failPattern=value;},failURL:value=>{failURL=value;},async close(){failReset=false;failURL=false;try{await owner.dispose();}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;if(previousRevoke===undefined)delete globalThis.__authoringPatternTestRevoke;else globalThis.__authoringPatternTestRevoke=previousRevoke;}}};
}
function totals(){const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,gpu:s.gpuBytes,handles:s.handles,records:s.activeRecords};}

test('mask hatch frames reuse one owned pattern and preserve its diagonal pixels and alpha',async()=>{
  const before=totals(),f=fixture();
  try{
    const ctx=f.context();for(let frame=0;frame<20;frame++)f.owner.overlay(ctx);
    assert.equal(f.surfaces.length,1);assert.equal(ctx.patterns.length,1);assert.equal(ctx.depth,0);
    assert.equal(f.owner.lifecycle.overlayCanvases,1);assert.equal(f.owner.lifecycle.overlayPatterns,1);
    assert.deepEqual(f.surfaces[0].calls,[['begin'],['move',0,8],['line',8,0],['stroke','#c778ee']]);
    assert.deepEqual(ctx.fills[0],{bounds:[3,4,10,20],style:ctx.patterns[0],alpha:.25});
    assert.deepEqual(totals(),{cpu:before.cpu+512+14,gpu:before.gpu+512,handles:before.handles+2,records:before.records+1});
    f.owner.invalidate();assert.equal(f.surfaces[0].width,0);assert.equal(f.surfaces[0].height,0);assert.deepEqual(totals(),before);assert.equal(f.owner.lifecycle.overlayCanvases,0);assert.equal(f.owner.lifecycle.overlayPatterns,0);
    f.preview();f.owner.overlay(ctx);assert.equal(f.surfaces.length,2);
    await f.owner.releaseDocument();assert.deepEqual(totals(),before);assert.equal(f.surfaces[1].width,0);
  }finally{await f.close();}
  assert.deepEqual(totals(),before);
});

test('a new hatch color or target context replaces and releases the previous native pattern',async()=>{
  const before=totals(),f=fixture();
  try{
    const first=f.context();f.owner.overlay(first);f.owner.color='#123456';f.owner.overlay(first);
    assert.equal(f.surfaces.length,2);assert.equal(f.surfaces[0].width,0);assert.deepEqual(f.surfaces[1].calls.at(-1),['stroke','#123456']);
    const second=f.context();f.owner.overlay(second);assert.equal(f.surfaces.length,3);assert.equal(f.surfaces[1].width,0);
    f.owner.overlay(second);assert.equal(second.patterns.length,1);assert.equal(allocationLedger.snapshot().byKind.canvas.handles,2);assert.equal(totals().records,before.records+2);
  }finally{await f.close();}
  assert.deepEqual(totals(),before);
});

test('hatch admission fails before native canvas construction and restores both saved contexts',async()=>{
  const before=totals(),f=fixture();let pressure;
  try{
    pressure=allocationLedger.reserve({owner:'authoring-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes-90000});
    const ctx=f.context();assert.throws(()=>f.owner.overlay(ctx),/ALLOCATION_BUDGET/);assert.equal(f.surfaces.length,0);assert.equal(ctx.depth,0);
  }finally{pressure?.release();await f.close();}
  assert.deepEqual(totals(),before);
});

test('native pattern construction failure clears its admitted source and permits retry',async()=>{
  const before=totals(),f=fixture();
  try{
    const ctx=f.context();f.failPattern(true);assert.throws(()=>f.owner.overlay(ctx),/AUTHORING_PATTERN_CONTEXT/);
    assert.equal(ctx.depth,0);assert.equal(f.surfaces[0].width,0);assert.deepEqual(totals(),before);
    f.failPattern(false);f.owner.overlay(ctx);assert.equal(f.surfaces.length,2);assert.equal(ctx.patterns.length,1);
  }finally{await f.close();}
  assert.deepEqual(totals(),before);
});

test('failed native canvas reset retains its unusable booking until document release retries cleanup',async()=>{
  const before=totals(),unusedBefore=allocationLedger.snapshot().unusedHandles,f=fixture();
  try{
    const ctx=f.context();f.owner.overlay(ctx);f.failReset(true);f.failURL(true);
    f.owner.preview.views={first:'blob:first',second:'blob:failed'};f.owner.draft={};f.owner.gesture={};
    await assert.rejects(f.owner.releaseDocument(),error=>{
      assert.equal(error.message,'AUTHORING_DOCUMENT_CLEANUP');assert.equal(error.errors[0].message,'AUTHORING_PREVIEW_CLEANUP');
      assert.deepEqual(error.errors[0].errors.map(value=>value.message),['native reset failed','native URL revoke failed']);return true;
    });
    assert.equal(totals().records,before.records+1);assert.deepEqual(f.revoked,['blob:first','blob:failed','blob:failed']);
    assert.equal(f.owner.lifecycle.drafts,0);assert.equal(f.owner.lifecycle.gestures,0);assert.equal(f.owner.lifecycle.objectURLs,1);
    assert.equal(allocationLedger.snapshot().unusedHandles-unusedBefore,2);f.owner.overlay(ctx);
    assert.equal(f.surfaces.length,1);assert.equal(ctx.depth,0);
    f.failReset(false);f.failURL(false);await f.owner.releaseDocument();assert.deepEqual(f.revoked,['blob:first','blob:failed','blob:failed','blob:failed']);
    assert.equal(f.surfaces[0].width,0);assert.equal(f.surfaces[0].height,0);assert.deepEqual(totals(),before);assert.equal(f.owner.lifecycle.objectURLs,0);
  }finally{await f.close();}
  assert.deepEqual(totals(),before);
});

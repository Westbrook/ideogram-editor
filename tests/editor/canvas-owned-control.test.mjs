// Source-only authored regressions. Assemble the staged canvas/display sources
// and shared loaders before execution. No ownership class is substituted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';
import {allocationsURL,displayProtocolURL,displaySchedulerURL,displayModelMemoryURL,displayControlURL} from '../display-module.mjs';
import {assetProjectionURL,assetProjection,canonicalDisplayAsset} from '../asset-projection-module.mjs';
import {browserPhasesURL as browserURL} from '../owned-preview-module.mjs';
const root=(process.env.IE_CANVAS_SOURCE_ROOT??'.').replace(/\/$/,''),data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,replacements={}){let code=(await transformWithOxc(await readFile(root+'/'+path,'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const shaURL=await moduleURL('src/protocol/sha256.ts');
const tilesURL=await moduleURL('src/ui/display-tiles.ts',{'../observability/allocations.js':allocationsURL,'../observability/display-control.js':displayControlURL,'../observability/display-scheduler.js':displaySchedulerURL,'../protocol/display.js':displayProtocolURL,'../protocol/sha256.js':shaURL,'../protocol/asset-projection.js':assetProjectionURL});
const {CanvasView}=await import(await moduleURL('src/ui/canvas-view.ts',{'../observability/browser.js':browserURL,'../observability/allocations.js':allocationsURL,'../observability/display-control.js':displayControlURL,'../observability/model-memory.js':displayModelMemoryURL,'./display-tiles.js':tilesURL}));
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),{displayReadOwnership}=await import(displaySchedulerURL);
const {DISPLAY_TILE_SIZE}=await import(displayProtocolURL);
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const total=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,gpu:s.gpuBytes,handles:s.handles,records:s.activeRecords};};
const canvasTotal=()=>({...allocationLedger.snapshot().byKind.canvas});
const ownerLive=owner=>{const unpin=owner.pin();unpin();};
const instances=[]; // Keep persistent shell service/view owners genuinely reachable.
function fixture({initialWidth=300,initialHeight=150,width=20,height=20,sourceWidth=2,sourceHeight=2}={}){
 const prior={bitmap:globalThis.createImageBitmap,data:globalThis.ImageData,ratio:globalThis.devicePixelRatio},images=[],events=[],listeners=new Map();let actualWidth=initialWidth,actualHeight=initialHeight,failZero=false,failDetach=false,decode;
 globalThis.ImageData=class{constructor(data,width,height){Object.assign(this,{data,width,height});}};globalThis.devicePixelRatio=1;
 const bitmap=(w,h)=>{const image={width:w,height:h,closed:0,close(){this.closed++;}};images.push(image);return image;};
 globalThis.createImageBitmap=async input=>decode?decode(input):bitmap(input.width,input.height);
 const ctx=new Proxy({drawImage(image){assert.equal(image.closed,0);}},{get:(target,key)=>target[key]??(()=>{})});
 const canvas={dataset:{},get width(){return actualWidth;},set width(value){events.push({kind:'width',value,canvas:canvasTotal()});if(failZero&&value===0)throw Error('ZERO_REFUSED');actualWidth=value;},get height(){return actualHeight;},set height(value){events.push({kind:'height',value,canvas:canvasTotal()});if(failZero&&value===0)throw Error('ZERO_REFUSED');actualHeight=value;},addEventListener(name,listener){events.push({kind:'attach',name,canvas:canvasTotal()});listeners.set(name,listener);},removeEventListener(name,listener){events.push({kind:'detach',name,canvas:canvasTotal()});if(failDetach)throw Error('DETACH_REFUSED');if(listeners.get(name)===listener)listeners.delete(name);},getBoundingClientRect:()=>({width,height,left:0,top:0}),getContext:()=>ctx};
 function descriptor(id){return Response.json(assetProjection(canonicalDisplayAsset({id,width:sourceWidth,height:sourceHeight,pixelIdentity:hash(id)})));}
 function tile(path,body){const parsed=new URL(path,'http://127.0.0.1'),id=parsed.pathname.split('/')[4],lod=Number(parsed.searchParams.get('lod')),x=Number(parsed.searchParams.get('x')),y=Number(parsed.searchParams.get('y')),levelWidth=Math.ceil(sourceWidth/2**lod),levelHeight=Math.ceil(sourceHeight/2**lod),w=Math.min(DISPLAY_TILE_SIZE,levelWidth-x*DISPLAY_TILE_SIZE),h=Math.min(DISPLAY_TILE_SIZE,levelHeight-y*DISPLAY_TILE_SIZE),bytes=new Uint8Array(w*h*4).fill(91);return new Response(body??bytes,{headers:{'content-type':'application/x-ideogram-rgba8','content-length':String(bytes.length),etag:'"'+hash(bytes)+'"','X-Display-Profile':'cp1-display-v1','X-Display-Source':hash(id),'X-Display-Basis':'pixels','X-Display-Width':String(w),'X-Display-Height':String(h),'X-Display-Source-Width':String(sourceWidth),'X-Display-Source-Height':String(sourceHeight),'X-Display-LOD':String(lod)}});}
 const transport=async path=>path.includes('/display-tile?')?tile(path):descriptor(path.split('/').at(-1));
 return {canvas,events,listeners,images,sourceWidth,sourceHeight,bitmap,descriptor,tile,transport,setDecode:next=>decode=next,zeroRefusal:value=>failZero=value,detachRefusal:value=>failDetach=value,restore(){globalThis.createImageBitmap=prior.bitmap;globalThis.ImageData=prior.data;globalThis.devicePixelRatio=prior.ratio;}};
}
function create(f,transport=f.transport){const view=new CanvasView(f.canvas,transport);instances.push(view);return view;}
async function close(view,f){f.zeroRefusal(false);f.detachRefusal(false);try{await view.suspend();}finally{f.restore();}}

test('initial observed HTML default 300 by 150 backing is charged before listener attachment',async()=>{
 const f=fixture(),before=canvasTotal(),view=create(f);try{const after=canvasTotal();assert.equal(after.cpuBytes-before.cpuBytes,300*150*4);assert.equal(after.gpuBytes-before.gpuBytes,300*150*4);assert.equal(after.handles-before.handles,1);assert.equal(view.lifecycle.canvasBytes,180000);assert.equal(f.canvas.width,300);assert.equal(f.canvas.height,150);for(const event of f.events.filter(event=>event.kind==='attach'))assert.equal(event.canvas.cpuBytes-before.cpuBytes,180000);}finally{await close(view,f);}assert.deepEqual(canvasTotal(),before);
});

test('initial admission refusal zeroes the existing backing and releases new control owners',()=>{
 const f=fixture(),before=total(),pressure=allocationLedger.reserve({owner:'canvas-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-before.cpu-10000}),pressed=total();try{assert.throws(()=>new CanvasView(f.canvas,f.transport),/ALLOCATION_BUDGET/);assert.equal(f.canvas.width,0);assert.equal(f.canvas.height,0);assert.equal(f.listeners.size,0);assert.deepEqual(total(),pressed);}finally{pressure.release();f.restore();}assert.deepEqual(total(),before);
});

test('document close retains an exactly four-byte canvas baseline over repeated real tile lifecycles',async()=>{
 const f=fixture(),before=canvasTotal(),view=create(f);let baseline;try{for(let cycle=0;cycle<5;cycle++){await view.show('source',2,2);assert.equal(view.draw(1,0,0),true);assert.equal(view.decodedAssetId,'source');await view.releaseDocument();assert.equal(f.canvas.width,1);assert.equal(f.canvas.height,1);assert.equal(canvasTotal().cpuBytes-before.cpuBytes,4);assert.equal(canvasTotal().gpuBytes-before.gpuBytes,4);assert.equal(view.ownership.pendingReads,0);assert.equal(view.ownership.decodedBitmaps,0);if(baseline)assert.deepEqual(total(),baseline);else baseline=total();}assert(f.images.every(image=>image.closed===1));}finally{await close(view,f);}assert.deepEqual(canvasTotal(),before);
});

test('suspend zeroes both native dimensions before refund and resume admits one pixel before regrowth',async()=>{
 const f=fixture(),before=canvasTotal(),view=create(f);try{await view.releaseDocument();f.events.length=0;await view.suspend();const zero=f.events.filter(event=>(event.kind==='width'||event.kind==='height')&&event.value===0);assert.equal(zero.length,2);assert(zero.every(event=>event.canvas.cpuBytes-before.cpuBytes>=4&&event.canvas.gpuBytes-before.gpuBytes>=4));assert.deepEqual(canvasTotal(),before);assert.equal(f.listeners.size,0);assert.equal(view.ownership.suspended,true);view.dispose();await view.releaseDocument();assert.deepEqual(canvasTotal(),before);assert.equal(f.canvas.width,0);assert.equal(f.canvas.height,0);await assert.rejects(view.show('source',2,2),error=>error.name==='AbortError');f.events.length=0;await view.resume();const grow=f.events.filter(event=>(event.kind==='width'||event.kind==='height')&&event.value===1);assert.equal(grow.length,2);assert(grow.every(event=>event.canvas.cpuBytes-before.cpuBytes>=4&&event.canvas.gpuBytes-before.gpuBytes>=4));assert.equal(view.ownership.suspended,false);assert.equal(f.listeners.size,2);assert.equal(canvasTotal().cpuBytes-before.cpuBytes,4);}finally{await close(view,f);}assert.deepEqual(canvasTotal(),before);
});

for(const refusal of ['zero','detach'])test('failed '+refusal+' keeps the actual canvas lease until successful retry',async()=>{
 const f=fixture(),before=canvasTotal(),view=create(f);try{await view.releaseDocument();if(refusal==='zero')f.zeroRefusal(true);else f.detachRefusal(true);await assert.rejects(view.suspend(),new RegExp(refusal==='zero'?'ZERO_REFUSED':'DETACH_REFUSED'));assert.equal(view.ownership.suspended,true);assert.equal(canvasTotal().cpuBytes-before.cpuBytes,4);assert.equal(canvasTotal().gpuBytes-before.gpuBytes,4);assert.equal(canvasTotal().handles-before.handles,1);f.zeroRefusal(false);f.detachRefusal(false);await view.suspend();assert.deepEqual(canvasTotal(),before);assert.equal(f.canvas.width,0);assert.equal(f.canvas.height,0);}finally{await close(view,f);}
});

test('a superseding detach defeats a remount waiting for the old native decode drain',async()=>{
 const f=fixture(),entered=deferred(),decode=deferred(),view=create(f);f.setDecode(()=>{entered.resolve();return decode.promise;});const show=view.show('source',2,2);void show.catch(()=>{});let suspended,remount;try{await entered.promise;suspended=view.suspend();remount=view.resume();const superseding=view.suspend();assert.equal(superseding,suspended);await turn();assert.equal(view.ownership.suspended,true);assert.equal(f.canvas.width,1);assert.equal(f.canvas.height,1);const image=f.bitmap(2,2);decode.resolve(image);await Promise.all([show,suspended,remount]);assert.equal(image.closed,1);assert.equal(view.ownership.suspended,true);assert.equal(f.canvas.width,0);assert.equal(f.canvas.height,0);assert.equal(f.listeners.size,0);await view.resume();assert.equal(view.ownership.suspended,false);assert.equal(f.canvas.width,1);assert.equal(f.listeners.size,2);}finally{decode.resolve(f.bitmap(2,2));await Promise.allSettled([show,suspended,remount].filter(Boolean));await close(view,f);}
});

test('retired source, tile batch and key remain pinned until an actual delayed native decode settles',async()=>{
 const f=fixture(),entered=deferred(),decode=deferred(),view=create(f);f.setDecode(()=>{entered.resolve();return decode.promise;});const show=view.show('source',2,2);void show.catch(()=>{});let release;try{await entered.promise;const source=view.sourceOwner,batch=view.requiredOwner,key=view.keyOwner;assert(source&&batch&&key);let done=false;release=view.releaseDocument().then(()=>{done=true;});await turn();assert.equal(done,false);assert.equal(view.sourceOwner,undefined);assert.equal(view.requiredOwner,undefined);ownerLive(source);ownerLive(batch);ownerLive(key);assert.equal(displayReadOwnership().active,1);const image=f.bitmap(2,2);decode.resolve(image);await Promise.all([show,release]);assert.equal(image.closed,1);assert.throws(()=>source.pin(),/MODEL_MEMORY_RELEASED/);assert.throws(()=>batch.pin(),/MODEL_MEMORY_RELEASED/);assert.throws(()=>key.pin(),/MODEL_MEMORY_RELEASED/);assert.equal(displayReadOwnership().active,0);assert.equal(view.ownership.pendingReads,0);}finally{decode.resolve(f.bitmap(2,2));await Promise.allSettled([show,release].filter(Boolean));await close(view,f);}
});

test('superseded viewport metadata survives actual asynchronous response cancellation and document drain',async()=>{
 const f=fixture({sourceWidth:1536,sourceHeight:512}),reading=deferred(),cancelled=deferred(),cancelGate=deferred();let first=true;
 const view=create(f,async path=>{if(path.includes('/display-tile?')&&first){first=false;return f.tile(path,new ReadableStream({pull(){reading.resolve();},cancel(){cancelled.resolve();return cancelGate.promise;}}));}return f.transport(path);});
 const show=view.show('source',1536,512);void show.catch(()=>{});let release;try{await reading.promise;const source=view.sourceOwner,batch=view.requiredOwner,key=view.keyOwner;assert(source&&batch&&key);view.draw(1,-600,0);await cancelled.promise;assert.notEqual(view.requiredOwner,batch);ownerLive(batch);ownerLive(key);let done=false;release=view.releaseDocument().then(()=>{done=true;});await turn();assert.equal(done,false);ownerLive(source);ownerLive(batch);ownerLive(key);assert.equal(displayReadOwnership().active,1);cancelGate.resolve();await Promise.all([show,release]);assert.throws(()=>source.pin(),/MODEL_MEMORY_RELEASED/);assert.throws(()=>batch.pin(),/MODEL_MEMORY_RELEASED/);assert.throws(()=>key.pin(),/MODEL_MEMORY_RELEASED/);assert.equal(displayReadOwnership().active,0);assert.equal(view.ownership.pendingReads,0);assert.equal(view.ownership.pendingCleanup,0);}finally{cancelGate.resolve();await Promise.allSettled([show,release].filter(Boolean));await close(view,f);}
});


test('the last submitted draw keeps its derived key owned after a same-source viewport batch replacement',async()=>{
 const f=fixture(),view=create(f);try{await view.show('source',2,2);assert.equal(view.draw(1,0,0),true);const drawn=view.keyOwner;assert(drawn);await view.startVisible();assert.notEqual(view.keyOwner,drawn);ownerLive(drawn);assert.equal(view.decodedAssetId,'source');assert.equal(view.draw(1,0,0),true);assert.throws(()=>drawn.pin(),/MODEL_MEMORY_RELEASED/);}finally{await close(view,f);}
});

test('a failed actual tile request keeps its published failure key owned until the document clears it',async()=>{
 const f=fixture(),view=create(f,async path=>{if(path.includes('/display-tile?'))throw Error('TILE_TRANSPORT_FAILED');return f.transport(path);});try{await assert.rejects(view.show('source',2,2),/TILE_TRANSPORT_FAILED/);const failed=view.keyOwner;assert(failed);await assert.rejects(view.startVisible(),/TILE_TRANSPORT_FAILED/);assert.notEqual(view.keyOwner,failed);ownerLive(failed);await assert.rejects(view.releaseDocument(),/CANVAS_RELEASE_FAILED/);assert.throws(()=>failed.pin(),/MODEL_MEMORY_RELEASED/);await view.releaseDocument();}finally{await close(view,f);}
});


test('retiring an actually replaced canvas drains native work before releasing its persistent controls',async()=>{
 const f=fixture(),before=total(),view=create(f);try{await view.show('source',2,2);assert.equal(view.draw(1,0,0),true);await view.retire();assert.equal(f.canvas.width,0);assert.equal(f.canvas.height,0);assert.equal(f.listeners.size,0);assert.deepEqual(total(),before);await view.retire();await view.suspend();assert.deepEqual(total(),before);await assert.rejects(view.resume(),error=>error.name==='AbortError');assert.deepEqual(total(),before);}finally{await close(view,f);}
});

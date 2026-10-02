import {assetProjectionURL,assetProjection,canonicalDisplayAsset} from '../asset-projection-module.mjs';
import {allocationsURL as allocations,browserPhasesURL as browser,promptMemoryURL as prompt} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,replacements={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url] of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const protocol=await moduleURL('src/protocol/display.ts'),sha=await moduleURL('src/protocol/sha256.ts'),scheduler=await moduleURL('src/observability/display-scheduler.ts',{'./allocations.js':allocations});
const owned=await moduleURL('src/observability/owned-preview.ts',{'./allocations.js':allocations});
const memory=await moduleURL('src/observability/model-memory.ts',{'./allocations.js':allocations,'./prompt-memory.js':prompt}),control=await moduleURL('src/observability/display-control.ts',{'./model-memory.js':memory});
const tiles=await moduleURL('src/ui/display-tiles.ts',{'../observability/allocations.js':allocations,'../observability/owned-preview.js':owned,'../observability/display-control.js':control,'../observability/display-scheduler.js':scheduler,'../protocol/display.js':protocol,'../protocol/sha256.js':sha,'../protocol/asset-projection.js':assetProjectionURL});
const {CanvasView}=await import(await moduleURL('src/ui/canvas-view.ts',{'../observability/browser.js':browser,'../observability/allocations.js':allocations,'../observability/display-control.js':control,'../observability/model-memory.js':memory,'./display-tiles.js':tiles}));
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const metadata=(id,width=2,height=2)=>assetProjection(canonicalDisplayAsset({id,width,height,pixelIdentity:digest(id),pixelHash:digest(new Uint8Array(width*height*4).fill(id.charCodeAt(0)))}));
const meta=(id,width=2,height=2)=>Response.json(metadata(id,width,height));
function pixels(id,width=2,height=2,sourceWidth=width,sourceHeight=height){const bytes=new Uint8Array(width*height*4).fill(id.charCodeAt(0));return new Response(bytes,{headers:{'content-type':'application/x-ideogram-rgba8','content-length':String(bytes.length),etag:'"'+digest(bytes)+'"','X-Display-Profile':'cp1-display-v1','X-Display-Source':digest(id),'X-Display-Basis':'pixels','X-Display-Width':String(width),'X-Display-Height':String(height),'X-Display-Source-Width':String(sourceWidth),'X-Display-Source-Height':String(sourceHeight),'X-Display-LOD':'0'}});}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
// A real fixture Response has delivered headers; its original reader is held
// before body delivery, and cancellation retains ownership until drain resolves.
function heldResponse(bytes,headers={}){
 const entered=deferred(),cancelling=deferred(),drain=deferred();let controller,cancelCount=0,completed=false;
 const response=new Response(new ReadableStream({start(value){controller=value;},pull(){entered.resolve();},cancel(){cancelCount++;cancelling.resolve();return drain.promise;}},{highWaterMark:0}),{headers:new Headers(headers)});
 response.headers.set('content-length',String(bytes.length));
 return {response,entered:entered.promise,cancelling:cancelling.promise,get cancelCount(){return cancelCount;},complete(){if(!completed&&!cancelCount){completed=true;controller.enqueue(bytes);controller.close();}},drain(){drain.resolve();}};
}
function fixture(){
 const oldBitmap=globalThis.createImageBitmap,oldData=globalThis.ImageData,oldRatio=globalThis.devicePixelRatio,images=[],draws=[],listeners=new Map();
 globalThis.ImageData=class{constructor(data,width,height){Object.assign(this,{data,width,height});}};globalThis.devicePixelRatio=1;
 globalThis.createImageBitmap=async input=>{const image={id:input.data[0],width:input.width,height:input.height,closed:0,close(){this.closed++;}};images.push(image);return image;};
 const ctx=new Proxy({drawImage:image=>{assert.equal(image.closed,0);draws.push(image.id);}},{get:(target,key)=>target[key]??(()=>{})});
 const canvas={width:20,height:20,dataset:{},addEventListener:(name,fn)=>listeners.set(name,fn),getBoundingClientRect:()=>({width:20,height:20,left:0,top:0}),getContext:()=>ctx};
 const transport=async path=>{const id=path.split('/')[4];return path.includes('/display-tile?')?pixels(id):meta(id);};
 return {canvas,transport,images,draws,listeners,restore(){globalThis.createImageBitmap=oldBitmap;globalThis.ImageData=oldData;globalThis.devicePixelRatio=oldRatio;}};
}

test('canvas keeps retained tiles across late and failed metadata; clear and dispose drain late work',async()=>{
 const f=fixture(),late=deferred(),entered=deferred(),requests=[];let refuse=true;const view=new CanvasView(f.canvas,async path=>{requests.push(path);if(path.endsWith('/first')){entered.resolve();return late.promise;}if(path.endsWith('/retry')&&refuse)return new Response('busy',{status:503});return f.transport(path);});
 const draw=()=>{f.draws.length=0;view.draw(1,0,0);return {asset:f.canvas.dataset.asset,images:[...f.draws]};};
 try{
  const first=view.show('first',2,2);await entered.promise;const current=view.show('current',2,2);late.resolve(meta('first'));await first;await current;assert.deepEqual(draw(),{asset:'current',images:['c'.charCodeAt(0)]});assert.equal(f.images.length,1);
  await assert.rejects(view.show('retry',2,2),/DISPLAY_SOURCE_UNAVAILABLE/);assert.deepEqual(draw().images,['c'.charCodeAt(0)]);refuse=false;await view.show('retry',2,2);assert.equal(f.images[0].closed,1);assert.deepEqual(draw(),{asset:'retry',images:['r'.charCodeAt(0)]});
  await view.show(null,0,0);assert.deepEqual(draw(),{asset:'',images:[]});assert(f.images.every(image=>image.closed===1));await view.releaseDocument();assert.equal(view.lifecycle.pendingReads,0);
 }finally{view.dispose();f.restore();}
});

test('actual tile residency and owner retirement witness A/B reuse without ready flags',async()=>{
 const f=fixture(),view=new CanvasView(f.canvas,f.transport);
 try{
  await view.show('accepted',2,2);assert.equal(view.decodedAssetId,null,'Decode alone does not claim render submission');view.draw(1,0,0);const first=view.ownership;assert.equal(first.representation,'viewport-tiles');assert.equal(first.requiredTiles,1);assert.equal(first.residentRequiredTiles,1);
  await view.show('reviewed',2,2);view.draw(1,0,0);const resident=view.ownership;assert.equal(resident.bitmapSerial,first.bitmapSerial+1);assert.equal(resident.decodedAssetId,'reviewed');assert.equal(f.images[0].closed,1);
  await view.show('reviewed',2,2);view.draw(1,0,0);assert.equal(view.ownership.bitmapSerial,resident.bitmapSerial);assert.equal(view.ownership.decodeStarts,resident.decodeStarts);assert.equal(view.ownership.reusedBitmaps,resident.reusedBitmaps+1);
  await view.show('accepted',2,2);view.draw(1,0,0);assert.equal(f.images[1].closed,1);assert.equal(view.ownership.releasedBitmaps,resident.releasedBitmaps+1);assert.notEqual(view.ownership.bitmapSerial,resident.bitmapSerial);
  await view.releaseDocument();assert.equal(view.decodedAssetId,null);assert.equal(view.ownership.decodedBitmaps,0);assert(f.images.every(image=>image.closed===1));
 }finally{view.dispose();f.restore();}
});

test('untrusted context events cannot claim loss; restoration replays current source',async()=>{
 const f=fixture();let owner='accepted',restored=0,failed=0;
 const view=new CanvasView(f.canvas,f.transport,{changed(){},async restored(){restored++;await view.show(owner,2,2);},failed(){failed++;}});
 const settle=async()=>{for(let i=0;i<100&&view.ownership.contextRestoring;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(view.ownership.contextRestoring,false);};
 try{
  await view.show('accepted',2,2);f.listeners.get('contextlost')({isTrusted:false,timeStamp:1});assert.equal(view.ownership.contextLosses,0);assert.equal(f.images[0].closed,0);
  // Direct invocation exercises event handling only. This unit fixture is not
  // evidence that a browser actually lost and restored its native context.
  f.listeners.get('contextlost')({isTrusted:true,timeStamp:2});assert.equal(view.ownership.contextLosses,1);assert.equal(f.images[0].closed,1);assert.equal(view.draw(1,0,0),false);
  owner='newly-accepted';f.listeners.get('contextrestored')({isTrusted:true,timeStamp:3});await settle();view.draw(1,0,0);assert.equal(restored,1);assert.equal(view.decodedAssetId,'newly-accepted');assert.equal(view.ownership.contextRestorations,1);assert.equal(failed,0);
  f.listeners.get('contextrestored')({isTrusted:true,timeStamp:4});assert.equal(restored,1);await view.releaseDocument();assert.equal(view.lifecycle.pendingReads,0);
 }finally{view.dispose();f.restore();}
});

test('document release waits for an in-flight native tile decode and closes its result',async()=>{
 const f=fixture(),entered=deferred(),decoded=deferred();globalThis.createImageBitmap=async()=>{entered.resolve();return decoded.promise;};
 const view=new CanvasView(f.canvas,f.transport),pending=view.show('accepted',2,2);void pending.catch(()=>{});let closed=false;
 try{await entered.promise;const release=view.releaseDocument().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);const bitmap={width:2,height:2,closed:0,close(){this.closed++;}};decoded.resolve(bitmap);await pending;await release;assert.equal(bitmap.closed,1);assert.equal(view.ownership.decodedBitmaps,0);assert.equal(view.lifecycle.pendingReads,0);}finally{view.dispose();f.restore();}
});


test('invalid asset envelopes and changed dimensions retain the prior decoded canvas',async()=>{
 const f=fixture();let next;
 const view=new CanvasView(f.canvas,async path=>path.includes('/display-tile?')?f.transport(path):next?Response.json(next):f.transport(path));
 try{
  await view.show('accepted',2,2);view.draw(1,0,0);assert.equal(f.images.length,1);
  for(const [name,change,expected]of [
   ['missing-envelope',value=>({projection:value.projection}),/Invalid recovery data/],
   ['schema-1',value=>({...value,projectionSchema:1}),/Unsupported asset projection/],
   ['schema-3',value=>({...value,projectionSchema:3}),/Asset projection identity changed/],
   ['schema-99',value=>({...value,projectionSchema:99}),/Unsupported asset projection/],
   ['entity-version',value=>({...value,entityVersion:'2'}),/Asset projection identity changed/],
   ['dimensions',value=>assetProjection(canonicalDisplayAsset({id:value.projection.value.id,width:3,height:2,pixelIdentity:digest('other')})),/DISPLAY_SOURCE_CHANGED/]
  ]){
   const id='rejected-'+name;next=change(metadata(id));await assert.rejects(view.show(id,2,2),expected);
   f.draws.length=0;view.draw(1,0,0);assert.deepEqual(f.draws,['a'.charCodeAt(0)]);assert.equal(f.images.length,1);assert.equal(f.images[0].closed,0);
  }
  // A successful retry of the retained source clears the reported read error
  // without allocating another bitmap, then document release can complete.
  next=undefined;await view.show('accepted',2,2);view.draw(1,0,0);assert.equal(view.decodedAssetId,'accepted');assert.equal(f.images.length,1);
  await view.releaseDocument();assert.equal(f.images[0].closed,1);assert.equal(view.lifecycle.pendingReads,0);
 }finally{view.dispose();f.restore();}
});

test('same target joins held metadata and uses the latest viewport before its first tile',async()=>{
 const f=fixture(),held=heldResponse(new TextEncoder().encode(JSON.stringify(metadata('accepted',1024,2)))),requests=[],tasks=[];let settled=0;
 const view=new CanvasView(f.canvas,async(path,init)=>{requests.push({path,signal:init.signal});return path.includes('/display-tile?')?pixels('accepted',512,2,1024,2):held.response;});
 try{
  const first=view.show('accepted',1024,2,{zoom:1,x:256,y:0}).then(()=>{settled++;});tasks.push(first);await held.entered;
  const generation=view.ownership.generation,pending=view.lifecycle.pendingReads,signal=requests[0].signal;
  const joined=view.show('accepted',1024,2,{zoom:1,x:-256,y:0}).then(()=>{settled++;});tasks.push(joined);
  await Promise.resolve();assert.equal(view.ownership.generation,generation);assert.equal(view.lifecycle.pendingReads,pending);assert.equal(requests.length,1);assert.equal(signal.aborted,false);assert.equal(held.cancelCount,0);assert.equal(settled,0);
  held.complete();await Promise.all(tasks);assert.equal(settled,2);assert.equal(requests.filter(r=>!r.path.includes('/display-tile?')).length,1);
  const tiles=requests.filter(r=>r.path.includes('/display-tile?'));assert.equal(tiles.length,1);assert.equal(new URL(tiles[0].path,'http://127.0.0.1').searchParams.get('x'),'1');assert.equal(f.images.length,1);assert.equal(view.ownership.decodeStarts,1);
  assert.equal(view.draw(1,-256,0),true);assert.equal(view.decodedAssetId,'accepted');assert.equal(view.ownership.requiredTiles,1);assert.equal(view.ownership.residentRequiredTiles,1);
 }finally{view.dispose();held.drain();held.complete();await Promise.allSettled(tasks);await view.releaseDocument();f.restore();}
});

test('same target joins held tiles while a new viewport drains only the obsolete tile owner',async()=>{
 const f=fixture(),bytes=new Uint8Array(512*2*4).fill('a'.charCodeAt(0)),old=heldResponse(bytes,pixels('accepted',512,2,1024,2).headers),latest=heldResponse(bytes,pixels('accepted',512,2,1024,2).headers),requests=[],tasks=[];let settled=0,latestSettled=false;
 const view=new CanvasView(f.canvas,async(path,init)=>{requests.push({path,signal:init.signal});if(!path.includes('/display-tile?'))return meta('accepted',1024,2);return new URL(path,'http://127.0.0.1').searchParams.get('x')==='0'?old.response:latest.response;});
 try{
  tasks.push(view.show('accepted',1024,2,{zoom:1,x:256,y:0}).then(()=>{settled++;}));await old.entered;
  const generation=view.ownership.generation,pending=view.lifecycle.pendingReads,sourceSignal=requests[0].signal,tileSignal=requests[1].signal;
  tasks.push(view.show('accepted',1024,2,{zoom:1,x:256,y:0}).then(()=>{settled++;}));await Promise.resolve();
  assert.equal(requests.length,2);assert.equal(sourceSignal.aborted,false);assert.equal(tileSignal.aborted,false);assert.equal(old.cancelCount,0);assert.equal(view.ownership.generation,generation);assert.equal(view.lifecycle.pendingReads,pending);assert.equal(f.images.length,0);assert.equal(settled,0);
  tasks.push(view.show('accepted',1024,2,{zoom:1,x:-256,y:0}).then(()=>{settled++;latestSettled=true;}));await old.cancelling;
  assert.equal(tileSignal.aborted,true);assert.equal(sourceSignal.aborted,false);assert.equal(old.cancelCount,1);assert.equal(requests.length,2,'The replacement tile cannot fetch before the original reader drains');assert.equal(settled,0);
  old.drain();await latest.entered;await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,3);assert.equal(view.ownership.generation,generation);assert.equal(requests[2].signal.aborted,false);assert.equal(latestSettled,false,'The latest joined show still waits for its current required tile');
  latest.complete();await Promise.all(tasks);assert.equal(settled,3);assert.equal(requests.filter(r=>!r.path.includes('/display-tile?')).length,1);assert.equal(f.images.length,1);assert.equal(view.ownership.decodeStarts,1);
  assert.equal(view.draw(1,-256,0),true);assert.equal(view.decodedAssetId,'accepted');assert.equal(view.ownership.requiredTiles,1);assert.equal(view.ownership.residentRequiredTiles,1);
 }finally{view.dispose();old.drain();latest.drain();old.complete();latest.complete();await Promise.allSettled(tasks);await view.releaseDocument();f.restore();}
});

test('a different target aborts joined metadata and waits for its original reader to drain',async()=>{
 const f=fixture(),held=heldResponse(new TextEncoder().encode(JSON.stringify(metadata('first')))),requests=[],tasks=[];
 const view=new CanvasView(f.canvas,async(path,init)=>{requests.push({path,signal:init.signal});return path.endsWith('/first')?held.response:f.transport(path);});
 try{
  tasks.push(view.show('first',2,2));await held.entered;tasks.push(view.show('first',2,2));assert.equal(requests[0].signal.aborted,false);
  tasks.push(view.show('current',2,2));await held.cancelling;assert.equal(requests[0].signal.aborted,true);assert.equal(held.cancelCount,1);assert.equal(requests.length,1,'No successor metadata fetch while the retired reader owns cleanup');
  held.drain();await Promise.all(tasks);assert.equal(requests.filter(r=>r.path.endsWith('/first')).length,1);assert.equal(requests.filter(r=>r.path.endsWith('/current')).length,1);assert.equal(f.images.length,1);assert.equal(f.images[0].id,'c'.charCodeAt(0));assert.equal(view.draw(1,0,0),true);assert.equal(view.decodedAssetId,'current');assert.equal(view.lifecycle.pendingReads,0);
 }finally{view.dispose();held.drain();held.complete();await Promise.allSettled(tasks);await view.releaseDocument();f.restore();}
});

for(const boundary of ['release','context-loss'])test(boundary+' aborts and drains joined tiles before the same target can be shown freshly',async()=>{
 const f=fixture(),held=heldResponse(new Uint8Array(16).fill('a'.charCodeAt(0)),pixels('accepted').headers),requests=[],tasks=[];let heldOnce=false,released=false;
 const view=new CanvasView(f.canvas,async(path,init)=>{requests.push({path,signal:init.signal});if(path.includes('/display-tile?')&&!heldOnce){heldOnce=true;return held.response;}return f.transport(path);});
 try{
  tasks.push(view.show('accepted',2,2));await held.entered;tasks.push(view.show('accepted',2,2));const tileSignal=requests.find(r=>r.path.includes('/display-tile?')).signal;assert.equal(tileSignal.aborted,false);
  if(boundary==='release')tasks.push(view.releaseDocument().then(()=>{released=true;}));else f.listeners.get('contextlost')({isTrusted:true,timeStamp:10});
  await held.cancelling;assert.equal(tileSignal.aborted,true);assert.equal(held.cancelCount,1);assert.equal(released,false);assert.equal(view.lifecycle.pendingReads>0,true);assert.equal(f.images.length,0);assert.equal(requests.length,2);
  held.drain();await Promise.all(tasks);assert.equal(view.lifecycle.pendingReads,0);assert.equal(view.ownership.decodedBitmaps,0);if(boundary==='release')assert.equal(released,true);
  else {assert.equal(view.ownership.contextLost,true);f.listeners.get('contextrestored')({isTrusted:true,timeStamp:11});}
  await view.show('accepted',2,2);assert.equal(requests.filter(r=>r.path.endsWith('/accepted')).length,2);assert.equal(requests.filter(r=>r.path.includes('/display-tile?')).length,2);assert.equal(f.images.length,1);assert.equal(view.draw(1,0,0),true);assert.equal(view.decodedAssetId,'accepted');
 }finally{view.dispose();held.drain();held.complete();await Promise.allSettled(tasks);await view.releaseDocument();f.restore();}
});

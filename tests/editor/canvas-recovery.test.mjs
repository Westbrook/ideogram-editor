import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,replacements={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url] of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const allocations=await moduleURL('src/observability/allocations.ts'),protocol=await moduleURL('src/protocol/display.ts'),sha=await moduleURL('src/protocol/sha256.ts'),scheduler=await moduleURL('src/observability/display-scheduler.ts');
const owned=await moduleURL('src/observability/owned-preview.ts',{'./allocations.js':allocations});
const tiles=await moduleURL('src/ui/display-tiles.ts',{'../observability/allocations.js':allocations,'../observability/owned-preview.js':owned,'../observability/display-scheduler.js':scheduler,'../protocol/display.js':protocol,'../protocol/sha256.js':sha});
const phases=await moduleURL('src/observability/phases.ts'),workers=await moduleURL('src/observability/browser-worker-observations.ts',{'./phases.js':phases});
const browser=await moduleURL('src/observability/browser.ts',{'./phases.js':phases,'./browser-worker-observations.js':workers,'./allocations.js':allocations});
const {CanvasView}=await import(await moduleURL('src/ui/canvas-view.ts',{'../observability/browser.js':browser,'../observability/allocations.js':allocations,'./display-tiles.js':tiles}));
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const meta=id=>Response.json({projection:{value:{id,safety:'safe',availability:'available',raster:{width:2,height:2,pixelIdentity:digest(id)}}}});
function pixels(id){const bytes=new Uint8Array(16).fill(id.charCodeAt(0));return new Response(bytes,{headers:{'content-type':'application/x-ideogram-rgba8','content-length':'16',etag:'"'+digest(bytes)+'"','X-Display-Profile':'cp1-display-v1','X-Display-Source':digest(id),'X-Display-Basis':'pixels','X-Display-Width':'2','X-Display-Height':'2','X-Display-Source-Width':'2','X-Display-Source-Height':'2','X-Display-LOD':'0'}});}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,replacements={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url] of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const allocationsURL=await moduleURL('src/observability/allocations.ts'),protocolURL=await moduleURL('src/protocol/display.ts'),shaURL=await moduleURL('src/protocol/sha256.ts'),schedulerURL=await moduleURL('src/observability/display-scheduler.ts');
const ownedURL=await moduleURL('src/observability/owned-preview.ts',{'./allocations.js':allocationsURL});
const tilesURL=await moduleURL('src/ui/display-tiles.ts',{'../observability/allocations.js':allocationsURL,'../observability/owned-preview.js':ownedURL,'../observability/display-scheduler.js':schedulerURL,'../protocol/display.js':protocolURL,'../protocol/sha256.js':shaURL});
const {visibleTiles,viewportBacking,DisplayTileCache,readDisplaySource}=await import(tilesURL);
const {withDisplayRead,displayReadOwnership,waitForDisplayReads}=await import(schedulerURL);
const {allocationLedger}=await import(allocationsURL);
const identity='sha256:'+'a'.repeat(64),source=(width=5000,height=5000)=>({assetId:'retained',identity,width,height});
const view=(patch={})=>({width:800,height:600,zoom:1,x:0,y:0,ratio:1,...patch});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
function response(spec,bytes=new Uint8Array(spec.width*spec.height*4),patch={}){return new Response(bytes,{headers:{'content-type':'application/x-ideogram-rgba8','content-length':String(bytes.byteLength),etag:'"'+hash(bytes)+'"','X-Display-Profile':'cp1-display-v1','X-Display-Source':identity,'X-Display-Basis':'pixels','X-Display-Width':String(spec.width),'X-Display-Height':String(spec.height),'X-Display-Source-Width':'5000','X-Display-Source-Height':'5000','X-Display-LOD':String(spec.lod),...patch}});}
function bitmapFixture(){const oldBitmap=globalThis.createImageBitmap,oldData=globalThis.ImageData,images=[];globalThis.ImageData=class{constructor(data,width,height){Object.assign(this,{data,width,height});}};globalThis.createImageBitmap=async input=>{const bitmap={width:input.width,height:input.height,closed:0,close(){this.closed++;}};images.push(bitmap);return bitmap;};return {images,restore(){globalThis.createImageBitmap=oldBitmap;globalThis.ImageData=oldData;}};}

test('a maximum document decodes only its visible native tiles',()=>{
  const tiles=visibleTiles(source(),view({width:20,height:20}));assert.equal(tiles.length,1);assert.equal(tiles[0].lod,0);assert.equal(tiles[0].width,512);assert.equal(tiles[0].sourceX,2048);assert.equal(tiles.reduce((n,t)=>n+t.width*t.height*4,0),1024**2);
  assert.deepEqual(visibleTiles(source(),view({x:100000,y:100000})),[]);
});
test('zoom and DPI choose bounded detail with exact odd-dimension mapping',()=>{
  const tiles=visibleTiles(source(),view({zoom:.1,ratio:2}));assert.equal(tiles[0].lod,2);assert.equal(tiles.length,9);assert(tiles.every(t=>t.width<=512&&t.height<=512));
  const odd=visibleTiles(source(1025,1025),view({width:1025,height:1025,zoom:.5}));assert.equal(odd.length,4);assert.equal(odd[0].sourceX+odd[0].sourceWidth,odd[1].sourceX);assert.equal(odd[1].sourceX+odd[1].sourceWidth,1025);assert.equal(odd[3].sourceY+odd[3].sourceHeight,1025);
});
test('very large viewport backing and required cache remain bounded',()=>{
  const backing=viewportBacking(100000,100000,4);assert(backing.width*backing.height<=16*1024**2);assert(backing.width<=8192&&backing.height<=8192);
  const tiles=visibleTiles(source(),view({width:100000,height:100000,ratio:backing.ratio}));assert(tiles.reduce((n,t)=>n+t.width*t.height*4,0)<=64*1024**2);
  assert.throws(()=>visibleTiles(source(),view({zoom:Infinity})),/DISPLAY_VIEWPORT/);
});
test('source metadata must match immutable safe asset and declared dimensions',async()=>{
  const value={projection:{value:{id:'retained',safety:'safe',availability:'available',raster:{width:5000,height:5000,pixelIdentity:identity}}}},abort=new AbortController(),baseline=allocationLedger.snapshot().cpuBytes;
  assert.deepEqual(await readDisplaySource(async()=>Response.json(value),'retained',5000,5000,abort.signal),source());
  await assert.rejects(readDisplaySource(async()=>Response.json(value),'retained',4999,5000,abort.signal),/DISPLAY_SOURCE_CHANGED/);assert.equal(allocationLedger.snapshot().cpuBytes,baseline);
});
test('tile body identity is checked before bounded native allocation and reuse',async()=>{
  const fixture=bitmapFixture(),spec=visibleTiles(source(),view({width:20,height:20}))[0],paths=[],abort=new AbortController(),baseline=allocationLedger.snapshot();
  const cache=new DisplayTileCache(async path=>{paths.push(path);return response(spec);});cache.pin([spec]);
  try{await cache.load(source(),spec,abort.signal,()=>true);await cache.load(source(),spec,abort.signal,()=>true);assert.equal(paths.length,1);assert.match(paths[0],/display-tile/);assert.equal(cache.ownership.decodedBitmaps,1);assert.equal(cache.ownership.cacheBytes,spec.width*spec.height*4);assert.equal(cache.ownership.reusedBitmaps,1);assert.equal(fixture.images[0].width,512);cache.clear();assert.equal(fixture.images[0].closed,1);assert.equal(cache.ownership.decodedBitmaps,0);assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);assert.equal(allocationLedger.snapshot().gpuBytes,baseline.gpuBytes);}finally{cache.clear();fixture.restore();}
});
test('wrong tile hash never reaches createImageBitmap and refunds drained readers',async()=>{
  const fixture=bitmapFixture(),spec=visibleTiles(source(),view({width:20,height:20}))[0],abort=new AbortController(),baseline=allocationLedger.snapshot().cpuBytes;
  const cache=new DisplayTileCache(async()=>response(spec,undefined,{etag:'"sha256:'+'0'.repeat(64)+'"'}));
  try{await assert.rejects(cache.load(source(),spec,abort.signal,()=>true),/DISPLAY_TILE_HASH/);assert.equal(fixture.images.length,0);assert.equal(cache.ownership.decodedBitmaps,0);assert.equal(allocationLedger.snapshot().cpuBytes,baseline);}finally{cache.clear();fixture.restore();}
});
test('retired native decode closes its late result before releasing the shared slot',async()=>{
  const fixture=bitmapFixture(),spec=visibleTiles(source(),view({width:20,height:20}))[0],abort=new AbortController(),decode=deferred(),entered=deferred(),baseline=allocationLedger.snapshot().cpuBytes;
  globalThis.createImageBitmap=async()=>{entered.resolve();return decode.promise;};const cache=new DisplayTileCache(async()=>response(spec));let owns=true;
  const pending=cache.load(source(),spec,abort.signal,()=>owns);void pending.catch(()=>{});
  try{await entered.promise;owns=false;abort.abort();assert.equal(displayReadOwnership().active,1);const bitmap={width:512,height:512,closed:0,close(){this.closed++;}};decode.resolve(bitmap);await assert.rejects(pending,error=>error.name==='AbortError');await waitForDisplayReads();assert.equal(bitmap.closed,1);assert.equal(cache.ownership.decodedBitmaps,0);assert.equal(allocationLedger.snapshot().cpuBytes,baseline);}finally{cache.clear();fixture.restore();}
});
test('two display slots include full work lifetime and queued cancellation',async()=>{
  const first=deferred(),second=deferred(),abort=new AbortController();let thirdRan=false;
  const a=withDisplayRead(undefined,()=>first.promise),b=withDisplayRead(undefined,()=>second.promise),c=withDisplayRead(abort.signal,async()=>{thirdRan=true;});void c.catch(()=>{});
  assert.deepEqual(displayReadOwnership(),{active:2,queued:1,limit:2});abort.abort();await assert.rejects(c,error=>error.name==='AbortError');assert.equal(thirdRan,false);
  let drained=false;const drain=waitForDisplayReads().then(()=>{drained=true;});first.resolve();await a;await Promise.resolve();assert.equal(drained,false);second.resolve();await b;await drain;assert.equal(drained,true);assert.deepEqual(displayReadOwnership(),{active:0,queued:0,limit:2});
});
test('tile LOCAL_BUSY drains its bounded control body before a successful retry',async()=>{
  const fixture=bitmapFixture(),spec=visibleTiles(source(),view({width:20,height:20}))[0],abort=new AbortController(),baseline=allocationLedger.snapshot();let attempts=0,busy;
  const cache=new DisplayTileCache(async()=>{attempts++;if(attempts===1){busy=Response.json({error:{code:'LOCAL_BUSY',retry:'read-or-transfer'}},{status:429});return busy;}assert.equal(busy.body.locked,false);return response(spec);});
  try{await cache.load(source(),spec,abort.signal,()=>true);assert.equal(attempts,2);assert.equal(fixture.images.length,1);cache.clear();assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);assert.equal(allocationLedger.snapshot().handles,baseline.handles);}finally{cache.clear();fixture.restore();}
});
test('tile retry refuses permanent capacity and malformed busy responses',async()=>{
  const fixture=bitmapFixture(),spec=visibleTiles(source(),view({width:20,height:20}))[0],abort=new AbortController(),baseline=allocationLedger.snapshot();
  try{for(const [status,value]of [[507,{error:{code:'LOCAL_BUSY',retry:'read-or-transfer'}}],[429,{error:{code:'AUTHORIZATION_REQUIRED'}}]]){let attempts=0;const cache=new DisplayTileCache(async()=>{attempts++;return Response.json(value,{status});});await assert.rejects(cache.load(source(),spec,abort.signal,()=>true));assert.equal(attempts,1);assert.equal(cache.ownership.pendingCleanup,0);cache.clear();}assert.equal(fixture.images.length,0);assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);assert.equal(allocationLedger.snapshot().handles,baseline.handles);}finally{fixture.restore();}
});
test('tile cancellation during busy backoff prevents another transfer',async()=>{
  const fixture=bitmapFixture(),spec=visibleTiles(source(),view({width:20,height:20}))[0],abort=new AbortController(),drained=deferred(),baseline=allocationLedger.snapshot();let attempts=0;
  const cache=new DisplayTileCache(async()=>{attempts++;const busy=Response.json({error:{code:'LOCAL_BUSY',retry:'read-or-transfer'}},{status:429}),getReader=busy.body.getReader.bind(busy.body);busy.body.getReader=()=>{const reader=getReader(),release=reader.releaseLock.bind(reader);reader.releaseLock=()=>{release();drained.resolve();};return reader;};return busy;});
  const pending=cache.load(source(),spec,abort.signal,()=>true);void pending.catch(()=>{});
  try{await drained.promise;abort.abort();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(attempts,1);assert.equal(fixture.images.length,0);assert.equal(cache.ownership.pendingCleanup,0);assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);assert.equal(allocationLedger.snapshot().handles,baseline.handles);}finally{cache.clear();fixture.restore();}
});

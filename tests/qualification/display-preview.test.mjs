import {isolatedDiagnosticModules,allocationDeltaSnapshot} from '../owned-preview-module.mjs';
import {assetProjectionURL,assetProjection,canonicalDisplayAsset} from '../asset-projection-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {transformWithOxc} from 'vite';

const stage=process.env.IE_DISPLAY_SOURCE_ROOT?process.env.IE_DISPLAY_SOURCE_ROOT.replace(/\/$/,'')+'/':'',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
let serial=0;
async function module(path,replacements={},identity=''){
 let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
 for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code+'\n// '+identity);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const identity='sha256:'+'1'.repeat(64),encodedIdentity='sha256:'+'2'.repeat(64),pixelBlobHash='sha256:'+'3'.repeat(64);
const asset=(width=1,height=1)=>canonicalDisplayAsset({width,height,pixelIdentity:identity,pixelHash:pixelBlobHash,encodedHash:encodedIdentity,encodedBytes:'456',encodedType:'image/jpeg'});
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,payload){const name=Buffer.from(type),out=Buffer.alloc(payload.length+12);out.writeUInt32BE(payload.length);name.copy(out,4);payload.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([name,payload])),out.length-4);return out;}
function png(width,height,noise=false){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;const raw=Buffer.alloc((width*4+1)*height);if(noise){let state=42;for(let y=0;y<height;y++)for(let x=1;x<=width*4;x++){state^=state<<13;state^=state>>>17;state^=state<<5;raw[y*(width*4+1)+x]=state&255;}}return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
function response(source,edge=1024,patch={},bytes){const scale=Math.min(1,edge/Math.max(source.width,source.height)),width=Math.ceil(source.width*scale),height=Math.ceil(source.height*scale);bytes??=png(width,height);const headers={
 'content-type':'image/png','content-length':String(bytes.length),etag:'"'+hash(bytes)+'"',
 'x-display-profile':'cp1-display-v1','x-display-source':source.identity,'x-display-basis':source.basis,
 'x-display-width':String(width),'x-display-height':String(height),'x-display-source-width':String(source.width),'x-display-source-height':String(source.height),'x-display-lod':'0',...patch};return new Response(bytes,{headers});}
async function fixture(t,{allowRetained=false,bitmap}={}){
 const id=String(++serial),allocationsURL=(await isolatedDiagnosticModules()).allocationsURL,protocolURL=await module(stage+'src/protocol/display.ts',{},id),schedulerURL=await module(stage+'src/observability/display-scheduler.ts',{'./allocations.js':allocationsURL},id),shaURL=await module('src/protocol/sha256.ts',{},id);
 const promptURL=await module('src/observability/prompt-memory.ts',{'./allocations.js':allocationsURL},id),modelURL=await module('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptURL},id),controlURL=await module(stage+'src/observability/display-control.ts',{'./model-memory.js':modelURL},id);
 const helperURL=await module(stage+'src/observability/display-preview.ts',{'./allocations.js':allocationsURL,'./model-memory.js':modelURL,'./display-control.js':controlURL,'./display-scheduler.js':schedulerURL,'../protocol/display.js':protocolURL,'../protocol/sha256.js':shaURL,'../protocol/asset-projection.js':assetProjectionURL},id);
 const api=await import(helperURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),scheduler=await import(schedulerURL);
 const snapshot=allocationDeltaSnapshot(allocationLedger);
 const saved=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');let decoded=0,closed=0,created=0;const live=new Set();
 Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async blob=>{decoded++;if(bitmap)return bitmap(blob);const bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer);return {width:view.getUint32(16),height:view.getUint32(20),close(){closed++;}};}});
 t.mock.method(URL,'createObjectURL',()=>{const url='blob:test-display-'+id+'-'+(++created);live.add(url);return url;});t.mock.method(URL,'revokeObjectURL',url=>live.delete(url));
 t.after(async()=>{for(const url of live)api.revokeDisplayPreviewURL(url);api.cancelDisplayPreviewReads();if(!allowRetained){await api.waitForDisplayPreviewReads();assert.equal(snapshot().activeRecords,0);}if(saved)Object.defineProperty(globalThis,'createImageBitmap',saved);else delete globalThis.createImageBitmap;});
 return {...api,scheduler,snapshot,ledger:allocationLedger,limits:ALLOCATION_LIMITS,counts:()=>({decoded,closed,created}),options:{owner:'display-test',edge:1024}};
}
async function until(predicate){for(let n=0;n<100&&!predicate();n++)await new Promise(resolve=>setImmediate(resolve));assert.equal(predicate(),true,'The expected asynchronous boundary was reached');}

test('scoped source remains admitted through asynchronous validation and refunds callback failure',async t=>{
 const f=await fixture(t),gate=deferred(),entered=deferred();
 const pending=f.withDisplaySource(async()=>Response.json(assetProjection(asset())),'retained',{owner:'scoped-source-test'},async source=>{assert.equal(source.identity,identity);entered.resolve();await gate.promise;throw Error('validation refused');});void pending.catch(()=>{});
 await entered.promise;assert(f.snapshot().cpuBytes>4096);assert.equal(f.displayPreviewOwnership().activeReads,1);gate.resolve();await assert.rejects(pending,/validation refused/);assert.equal(f.snapshot().activeRecords,0);
});
test('asset descriptor is admitted before the scoped consumer and retained until it settles',async t=>{
 const f=await fixture(t),gate=deferred(),entered=deferred(),pending=f.withAssetDisplaySource(asset(),'pixels',async source=>{assert.equal(source.identity,identity);assert(f.snapshot().cpuBytes>0);entered.resolve();await gate.promise;return 'consumed';});
 await entered.promise;assert(f.snapshot().cpuBytes>0);gate.resolve();assert.equal(await pending,'consumed');assert.equal(f.snapshot().activeRecords,0);
});
test('preview source copying is refused before reading fields when control admission fails',async t=>{
 const f=await fixture(t),pressure=f.ledger.reserve({owner:'source-copy-pressure',kind:'scratch',cpuBytes:f.limits.cpuBytes-f.limits.textPartitionBytes-f.ledger.snapshot().cpuBytes-100});let read=false;
 try{const source={get assetId(){read=true;return 'retained';}};await assert.rejects(f.createDisplayPreviewURL(async()=>{throw Error('unexpected transport');},source,f.options),/ALLOCATION_BUDGET/);assert.equal(read,false);}finally{pressure.release();}
});
test('URL metadata remains charged until a failed revoke actually succeeds',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset()),url=await f.createDisplayPreviewURL(async()=>response(source),source,f.options),info=f.displayPreviewInfo(url),resident=f.snapshot().cpuBytes,revoke=URL.revokeObjectURL;let refuse=true;
 assert.equal(resident,Number(info.byteLength)+8192);t.mock.method(URL,'revokeObjectURL',value=>{if(refuse)throw Error('revoke unavailable');return revoke(value);});
 assert.throws(()=>f.revokeDisplayPreviewURL(url),/DISPLAY_URL_RELEASE_FAILED/);assert.equal(f.snapshot().cpuBytes,resident);assert.equal(f.displayPreviewInfo(url),info);refuse=false;await f.retryDisplayPreviewCleanup();assert.equal(f.snapshot().activeRecords,0);
});

test('source identity is canonical pixelIdentity, or the actual encoded blob hash for exports',async t=>{
 const f=await fixture(t),a=asset(4000,2000),pixels=f.sourceFromAsset(a),encoded=f.sourceFromAsset(a,'encoded');
 assert.equal(pixels.identity,identity);assert.notEqual(pixels.identity,pixelBlobHash);assert.equal(encoded.identity,encodedIdentity);assert.equal(encoded.basis,'encoded');
 for(const safety of ['unknown','withheld','quarantined'])assert.throws(()=>f.sourceFromAsset({...a,safety}),/DISPLAY_SOURCE/);
 assert.throws(()=>f.sourceFromAsset(asset(8192,8192)),/DISPLAY_REQUEST/);
});

test('a 1024-edge rendition validates natural dimensions while retaining original export geometry and identity',async t=>{
 const f=await fixture(t),a=asset(4000,2000),source=f.sourceFromAsset(a,'encoded');let path;
 const url=await f.createDisplayPreviewURL(async value=>{path=value;return response(source);},source,f.options);
 assert.equal(path,'/api/v1/assets/retained/display?identity='+encodeURIComponent(encodedIdentity)+'&basis=encoded&edge=1024');
 const info=f.displayPreviewInfo(url);assert.equal(info.width,1024);assert.equal(info.height,512);assert.equal(info.sourceWidth,4000);assert.equal(info.sourceHeight,2000);assert.equal(info.source,encodedIdentity);
 assert.equal(f.validateDisplayImage({naturalWidth:1024,naturalHeight:512},url),info);assert.throws(()=>f.validateDisplayImage({naturalWidth:4000,naturalHeight:2000},url),/DISPLAY_DECODE_DIMENSIONS/);
 const booked=f.snapshot();assert.equal(booked.byKind.bitmap.cpuBytes,0);assert.equal(booked.byKind.bitmap.gpuBytes,0);assert.equal(booked.previewCacheBytes,Number(info.byteLength));assert.deepEqual(f.counts(),{decoded:1,closed:1,created:1});
 f.revokeDisplayPreviewURL(url);f.revokeDisplayPreviewURL(url);assert.equal(f.displayPreviewInfo(url),undefined);assert.equal(f.snapshot().activeRecords,0);
});

test('thumbnail reads never request original content and native decode sees only 256-edge pixels',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset(4000,2000)),url=await f.createDisplayPreviewURL(async path=>{assert.match(path,/\/display\?/);assert.doesNotMatch(path,/\/content/);return response(source,256);},source,{...f.options,edge:256});
 assert.equal(f.displayPreviewInfo(url).width,256);assert.equal(f.displayPreviewInfo(url).height,128);f.revokeDisplayPreviewURL(url);
});

test('separate image elements reserve independent bounded surfaces and revoke detaches every alias',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset(4000,2000)),url=await f.createDisplayPreviewURL(async()=>response(source),source,f.options),rgba=1024*512*4,detached=[];
 const first=f.acquireDisplayPreviewConsumer(url,()=>detached.push('first')),second=f.acquireDisplayPreviewConsumer(url,()=>detached.push('second'));
 assert.equal(f.snapshot().byKind.bitmap.cpuBytes,2*(rgba+256));assert.equal(f.snapshot().byKind.bitmap.gpuBytes,2*rgba);assert.equal(f.displayPreviewOwnership().imageConsumers,2);
 first.release();first.release();assert.deepEqual(detached,['first']);assert.equal(f.snapshot().byKind.bitmap.gpuBytes,rgba);
 f.revokeDisplayPreviewURL(url);assert.deepEqual(detached,['first','second']);second.release();assert.equal(f.snapshot().activeRecords,0);assert.equal(f.displayPreviewOwnership().imageConsumers,0);
});

test('consumer admission happens before its resource attribute and failed detach remains owned',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset()),url=await f.createDisplayPreviewURL(async()=>response(source),source,f.options);let fail=true,detached=0;
 const consumer=f.acquireDisplayPreviewConsumer(url,()=>{if(fail)throw Error('detach failed');detached++;});
 assert.throws(()=>f.revokeDisplayPreviewURL(url),/DISPLAY_CONSUMER_RELEASE_FAILED/);assert.equal(f.displayPreviewOwnership().imageConsumers,1);assert(f.snapshot().unusedHandles>0);await assert.rejects(f.waitForDisplayPreviewReads(),/DISPLAY_RELEASE_UNCONFIRMED/);
 fail=false;consumer.release();f.revokeDisplayPreviewURL(url);await f.waitForDisplayPreviewReads();assert.equal(detached,1);assert.equal(f.snapshot().activeRecords,0);
});

test('metadata projection is bounded and binds the requested asset before any display read',async t=>{
 const f=await fixture(t),a=asset(1200,800);let seen;
 const source=await f.readDisplaySource(async(path,init)=>{seen=path;assert.ok(init.signal);return Response.json(assetProjection(a));},a.id,{owner:'metadata-test'});
 assert.equal(seen,'/api/v1/assets/retained');assert.equal(source.identity,identity);
 await assert.rejects(f.readDisplaySource(async()=>Response.json({...assetProjection(a),projectionSchema:99}),a.id,{owner:'metadata-test'}),/Unsupported asset projection/);
 await assert.rejects(f.readDisplaySource(async()=>Response.json(assetProjection({...a,id:'different'})),a.id,{owner:'metadata-test'}),/DISPLAY_SOURCE/);
 await assert.rejects(f.readDisplaySource(async()=>new Response(' '.repeat(65537)),a.id,{owner:'metadata-test'}),/DISPLAY_BODY_SIZE/);
});

test('mismatched source/basis/geometry/profile/length descriptors are rejected before native decode',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset());
 for(const patch of [{'x-display-source':encodedIdentity},{'x-display-basis':'encoded'},{'x-display-width':'2'},{'x-display-source-height':'2'},{'x-display-profile':'other'},{'x-display-lod':'1'},{'content-length':'9999999'},{'content-type':'image/jpeg'}])await assert.rejects(f.createDisplayPreviewURL(async()=>response(source,1024,patch),source,f.options),/DISPLAY_DESCRIPTOR/);
 assert.equal(f.counts().decoded,0);assert.equal(f.snapshot().activeRecords,0);
});

test('PNG byte identity and IHDR geometry are checked before native decoding',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset());
 await assert.rejects(f.createDisplayPreviewURL(async()=>response(source,1024,{etag:'"'+encodedIdentity+'"'}),source,f.options),/DISPLAY_CONTENT_IDENTITY/);
 await assert.rejects(f.createDisplayPreviewURL(async()=>response(source,1024,{},png(100,100)),source,f.options),/DISPLAY_PNG_DIMENSIONS/);
 assert.equal(f.counts().decoded,0);assert.equal(f.snapshot().activeRecords,0);
});

test('decoded admission refuses before fetching or invoking a browser decoder',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset(4000,2000)),pressure=f.ledger.reserve({owner:'display-pressure',kind:'scratch',cpuBytes:f.limits.cpuBytes-f.limits.textPartitionBytes-f.ledger.snapshot().cpuBytes-100});let fetched=0;
 try{await assert.rejects(f.createDisplayPreviewURL(async()=>{fetched++;return response(source);},source,f.options),/ALLOCATION_BUDGET/);assert.equal(fetched,0);assert.equal(f.counts().decoded,0);}finally{pressure.release();}
});

test('wire fragmentation does not allocate one retained handle per chunk',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset(128,64));const bytes=png(128,64,true),normal=response(source,1024,{},bytes);assert.ok(bytes.length>20000);let offset=0;
 const body=new ReadableStream({pull(controller){if(offset===bytes.length)controller.close();else controller.enqueue(bytes.subarray(offset,++offset));}});
 const url=await f.createDisplayPreviewURL(async()=>new Response(body,{headers:normal.headers}),source,f.options);assert.ok(f.snapshot().peaks.handles<20);f.revokeDisplayPreviewURL(url);
});

test('ownerless metadata reads are aborted by document close and keep leases until native cancellation settles',async t=>{
 const f=await fixture(t),cancel=deferred(),entered=deferred();let cancellations=0;
 const body=new ReadableStream({pull(){entered.resolve();},cancel(){cancellations++;return cancel.promise;}});
 const read=f.readDisplaySource(async()=>new Response(body),'retained',{owner:'metadata-test'});void read.catch(()=>{});await entered.promise;
 f.cancelDisplayPreviewReads();let drained=false;const drain=f.waitForDisplayPreviewReads().then(()=>{drained=true;});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cancellations,1);assert.equal(drained,false);assert.ok(f.snapshot().cpuBytes>0);assert.equal(f.displayPreviewOwnership().activeReads,1);
 cancel.resolve();await assert.rejects(read,error=>error.name==='AbortError');await drain;assert.equal(f.snapshot().activeRecords,0);
});

test('two global display slots remain owned through pending native cancellation; queued abort never fetches',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset()),cancel=deferred();let fetched=0,cancelling=0;
 const transport=async()=>{fetched++;const headers=response(source).headers;return new Response(new ReadableStream({pull(){},cancel(){cancelling++;return cancel.promise;}}),{headers});};
 const first=f.createDisplayPreviewURL(transport,source,f.options),second=f.createDisplayPreviewURL(transport,source,f.options),third=f.createDisplayPreviewURL(transport,source,f.options);void Promise.allSettled([first,second,third]);await until(()=>fetched===2);
 f.cancelDisplayPreviewReads();await until(()=>cancelling===2);assert.equal(fetched,2);assert.equal(f.scheduler.displayReadOwnership().active,2);assert.equal(f.scheduler.displayReadOwnership().queued,0);
 cancel.resolve();await Promise.allSettled([first,second,third]);await f.waitForDisplayPreviewReads();await f.scheduler.waitForDisplayReads();assert.equal(f.snapshot().activeRecords,0);
});

test('a stale owner after asynchronous decode closes the bitmap without publishing a URL',async t=>{
 const gate=deferred();let close=0,current=true;const f=await fixture(t,{bitmap:()=>gate.promise}),source=f.sourceFromAsset(asset());
 const work=f.createDisplayPreviewURL(async()=>response(source),source,{...f.options,owns:()=>current});void work.catch(()=>{});await until(()=>f.counts().decoded===1);current=false;gate.resolve({width:1,height:1,close(){close++;}});
 await assert.rejects(work,error=>error.name==='AbortError');assert.equal(close,1);assert.equal(f.counts().created,0);assert.equal(f.snapshot().activeRecords,0);
});

test('a failed native body cancellation stays charged and rejects document release',async t=>{
 const f=await fixture(t,{allowRetained:true}),source=f.sourceFromAsset(asset()),controller=new AbortController();let entered=false;
 const body=new ReadableStream({pull(){entered=true;},cancel(){return Promise.reject(Error('native cancellation failed'));}}),headers=response(source).headers;
 const work=f.createDisplayPreviewURL(async()=>new Response(body,{headers}),source,{...f.options,signal:controller.signal});void work.catch(()=>{});await until(()=>entered&&f.snapshot().byKind.blob.cpuBytes>0);controller.abort();
 await assert.rejects(work,/DISPLAY_BODY_RELEASE_FAILED/);assert.ok(f.snapshot().unusedHandles>0);assert.ok(f.snapshot().byKind.blob.cpuBytes>0);assert.equal(f.displayPreviewOwnership().failedNativeOwners,1);await assert.rejects(f.waitForDisplayPreviewReads(),/DISPLAY_RELEASE_UNCONFIRMED/);await assert.rejects(f.retryDisplayPreviewCleanup(),/DISPLAY_RELEASE_UNCONFIRMED/);assert.equal(f.displayPreviewOwnership().failedNativeOwners,1,'A failed native cancellation cannot be replaced by a later successful no-op');
});

test('explicit cleanup retry closes the same retained bitmap before releasing its lease',async t=>{
 let mayClose=false,closes=0;const bitmap={width:1,height:1,close(){closes++;if(!mayClose)throw Error('temporarily unavailable native close');}},f=await fixture(t,{bitmap:async()=>bitmap}),source=f.sourceFromAsset(asset());
 await assert.rejects(f.createDisplayPreviewURL(async()=>response(source),source,f.options),/DISPLAY_BITMAP_RELEASE_FAILED/);assert.equal(closes,2);assert.equal(f.displayPreviewOwnership().failedNativeOwners,1);assert.ok(f.snapshot().byKind.bitmap.cpuBytes>0);mayClose=true;await f.retryDisplayPreviewCleanup();assert.equal(closes,3);assert.equal(f.displayPreviewOwnership().failedNativeOwners,0);assert.equal(f.snapshot().activeRecords,0);
});

test('explicit cleanup retry unlocks the retained reader and preserves the original operation error',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset()),bytes=png(1,1);let mayUnlock=false,reads=0,unlocks=0;
 const reader={async read(){return reads++?{done:true}:{done:false,value:bytes};},async cancel(){},releaseLock(){unlocks++;if(!mayUnlock)throw Error('temporarily unavailable native unlock');}},normal=response(source),retained={ok:true,status:200,headers:normal.headers,body:{getReader:()=>reader}};
 await assert.rejects(f.createDisplayPreviewURL(async()=>retained,source,f.options),error=>{assert.match(error.message,/DISPLAY_READER_RELEASE_FAILED/);assert.ok(error.cause instanceof AggregateError);return true;});assert.equal(f.counts().decoded,0);assert.equal(f.displayPreviewOwnership().failedNativeOwners,1);mayUnlock=true;await f.retryDisplayPreviewCleanup();assert.equal(unlocks,3);assert.equal(f.snapshot().activeRecords,0);
});

test('failed bitmap close stays charged and rejects release; no URL claims ownership',async t=>{
 const f=await fixture(t,{allowRetained:true,bitmap:async()=>({width:1,height:1,close(){throw Error('native close failed');}})}),source=f.sourceFromAsset(asset());
 await assert.rejects(f.createDisplayPreviewURL(async()=>response(source),source,f.options),/DISPLAY_BITMAP_RELEASE_FAILED/);assert.ok(f.snapshot().byKind.bitmap.gpuBytes>0);assert.ok(f.snapshot().unusedHandles>0);assert.equal(f.counts().created,0);await assert.rejects(f.waitForDisplayPreviewReads(),/DISPLAY_RELEASE_UNCONFIRMED/);
});

test('URL revocation failure retains encoded and decoded ownership until an explicit successful retry',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset()),url=await f.createDisplayPreviewURL(async()=>response(source),source,f.options),before=f.snapshot().cpuBytes;
 const revoke=t.mock.method(URL,'revokeObjectURL',()=>{throw Error('native revoke failed');});assert.throws(()=>f.revokeDisplayPreviewURL(url),/DISPLAY_URL_RELEASE_FAILED/);assert.equal(f.snapshot().cpuBytes,before);await assert.rejects(f.waitForDisplayPreviewReads(),/DISPLAY_RELEASE_UNCONFIRMED/);
 revoke.mock.restore();f.revokeDisplayPreviewURL(url);await f.waitForDisplayPreviewReads();assert.equal(f.snapshot().activeRecords,0);
});

test('only read-or-transfer LOCAL_BUSY receives a bounded read-only retry',async t=>{
 const f=await fixture(t),source=f.sourceFromAsset(asset());let calls=0;
 const url=await f.createDisplayPreviewURL(async()=>++calls===1?Response.json({protocolVersion:1,error:{code:'LOCAL_BUSY',retry:'read-or-transfer'}},{status:429}):response(source),source,f.options);assert.equal(calls,2);f.revokeDisplayPreviewURL(url);
 for(const [status,code]of [[429,'SESSION_REQUIRED'],[507,'STORAGE_FULL']]){calls=0;await assert.rejects(f.createDisplayPreviewURL(async()=>{calls++;return Response.json({error:{code,retry:'read-or-transfer'}},{status});},source,f.options));assert.equal(calls,1);}
});

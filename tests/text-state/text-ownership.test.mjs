import {allocationsURL,diagnosticMemoryURL,workerPhasesURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const source=path=>(process.env.IE_TEXT_OWNERSHIP_STAGING?process.env.IE_TEXT_OWNERSHIP_STAGING+'/':'')+path;
async function module(path,replacements={}){let code=(await transformWithOxc(await readFile(source(path),'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const contractsURL=await module('src/text/contracts.ts'),{readTextAssetResponse,cancelTextAssetResponse,retainTextAssetCleanup,retryTextAssetCleanup}=await import(contractsURL);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const observe=promise=>promise.then(value=>({value}),error=>({error}));

test('single-byte fragmentation retains only bounded 64KiB assembly parts and preserves exact bytes',async()=>{
 const NativeBlob=globalThis.Blob,partCounts=[],bytes=Uint8Array.from({length:2*65536+7},(_,i)=>i%251);let offset=0,unlocked=0;
 globalThis.Blob=class extends NativeBlob{constructor(parts,options){partCounts.push(parts.length);super(parts,options);}};
 try{
  const response={ok:true,headers:new Headers({'Content-Length':String(bytes.length)}),body:{getReader:()=>({async read(){return offset<bytes.length?{done:false,value:bytes.subarray(offset,++offset)}:{done:true};},cancel(){assert.fail('Successful EOF needs no cancellation');},releaseLock(){unlocked++;}})}};
  const result=await readTextAssetResponse(response,bytes.length);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()),bytes);assert.deepEqual(partCounts,[1,1,1,3]);assert.equal(unlocked,1);
 }finally{globalThis.Blob=NativeBlob;}
});

for(const failure of ['overflow','short','read'])test('bounded font read releases its lock after '+failure+' even if cancellation rejects',async()=>{
 let reads=0,cancels=0,unlocks=0;
 const reader={async read(){reads++;if(failure==='read')throw Error('read failure');if(failure==='short')return {done:true};return {done:false,value:new Uint8Array(3)};},async cancel(){cancels++;throw Error('cancel failure');},releaseLock(){unlocks++;}};
 const response={ok:true,headers:new Headers(),body:{getReader:()=>reader}};
 await assert.rejects(readTextAssetResponse(response,2),error=>error.code===(failure==='short'?'TEXT_ASSET_SIZE':'TEXT_ASSET_CLEANUP'));
 assert.equal(reads,1);assert.equal(cancels,failure==='short'?0:1);assert.equal(unlocks,1);
});

test('abort cancels a pending reader exactly once and waits for cleanup before rejection',async()=>{
 const abort=new AbortController(),reading=deferred(),cancelled=deferred(),read=deferred();let cancels=0,unlocks=0;
 const reader={read(){reading.resolve();return read.promise;},cancel(){cancels++;read.resolve({done:true});return cancelled.promise;},releaseLock(){unlocks++;}};
 let done=false;const loading=observe(readTextAssetResponse({ok:true,headers:new Headers(),body:{getReader:()=>reader}},4,abort.signal)).then(value=>{done=true;return value;});
 await reading.promise;abort.abort();await Promise.resolve();assert.equal(cancels,1);assert.equal(unlocks,0);assert.equal(done,false);cancelled.resolve();assert.equal((await loading).error.code,'TEXT_CANCELLED');assert.equal(unlocks,1);
});

test('mismatched declared length owns and cancels the reader before any body read',async()=>{
 let cancelled=0,acquired=0,unlocked=0;await assert.rejects(readTextAssetResponse({ok:true,headers:new Headers({'Content-Length':'999'}),body:{getReader(){acquired++;return {closed:Promise.resolve(),read(){assert.fail('Unadmitted body must not be read');},cancel(){cancelled++;},releaseLock(){unlocked++;}};}}},2),/TEXT_ASSET_LOAD/);assert.equal(acquired,1);assert.equal(cancelled,1);assert.equal(unlocked,1);
});

test('failed reader unlock retains the exact cleanup owner for a later successful retry',async()=>{
 let unlocked=false,cancels=0,unlocks=0;const reader={async read(){return {done:true};},async cancel(){cancels++;},releaseLock(){unlocks++;if(!unlocked)throw Error('UNLOCK_FAILED');}};
 const response={ok:true,headers:new Headers(),body:{getReader:()=>reader,async cancel(){assert.fail('The locked reader still owns cleanup');}}};
 const result=await observe(readTextAssetResponse(response,0));assert.equal(result.error.code,'TEXT_ASSET_CLEANUP');assert.equal(unlocks,1);
 let releases=0;const lease={bytes:123,release(){releases++;}};
 assert.equal(retainTextAssetCleanup(result.error,lease),true);assert.equal(retainTextAssetCleanup(result.error,lease),true);
 assert.equal(retainTextAssetCleanup(new Error('unrelated'),lease),false);assert.equal(retainTextAssetCleanup({code:'TEXT_ASSET_CLEANUP'},lease),false);
 await assert.rejects(retryTextAssetCleanup(result.error),/UNLOCK_FAILED/);assert.equal(releases,0);assert.equal(cancels,0);unlocked=true;assert.equal(await retryTextAssetCleanup(result.error),true);assert.equal(releases,1);assert.equal(cancels,0);assert.equal(unlocks,3);assert.equal(await retryTextAssetCleanup(result.error),false);assert.equal(retainTextAssetCleanup(result.error,lease),false);assert.equal(releases,1);
});

for(const reason of [Error('stored network failure'),undefined])test('native stored read error remains primary without inventing a cancellation failure: '+String(reason),async()=>{
 const body=new ReadableStream({start(controller){controller.error(reason);}}),getReader=body.getReader.bind(body);let cancels=0,unlocks=0;
 body.getReader=()=>{const reader=getReader(),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);reader.cancel=()=>{cancels++;return cancel();};reader.releaseLock=()=>{unlocks++;unlock();};return reader;};
 const result=await observe(readTextAssetResponse({ok:true,headers:new Headers(),body},4));assert(Object.hasOwn(result,'error'));assert.equal(result.error,reason);assert.equal(cancels,1);assert.equal(unlocks,1);
});

for(const reason of [Error('underlying cancel rejected'),new DOMException('underlying cancellation rejected','AbortError'),undefined])test('actual underlying-source cancel rejection keeps caller leases: '+String(reason),async()=>{
 const abort=new AbortController(),started=deferred();let cancels=0;
 const body=new ReadableStream({pull(){started.resolve();},cancel(){cancels++;throw reason;}}),loading=observe(readTextAssetResponse(new Response(body),4,abort.signal));
 await started.promise;abort.abort();const result=await loading;assert.equal(result.error.code,'TEXT_ASSET_CLEANUP');assert.equal(cancels,1);assert.equal(body.locked,false);
 let releases=0;assert.equal(retainTextAssetCleanup(result.error,{bytes:321,release(){releases++;}}),true);
 assert.equal(await retryTextAssetCleanup(result.error),false);assert.equal(await retryTextAssetCleanup(result.error),false);assert.equal(releases,0);assert.equal(cancels,1);
});

for(const reason of [Error('stored error'),new DOMException('stored abort','AbortError'),undefined])for(const mode of ['pre-aborted','bad-header','cancel-only'])test('native already-errored '+mode+' preserves terminal error evidence: '+String(reason),async()=>{
 const body=new ReadableStream({start(controller){controller.error(reason);}}),nativeGet=body.getReader.bind(body);let cancels=0,reads=0,unlocks=0;
 body.getReader=()=>{const reader=nativeGet(),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);reader.read=()=>{reads++;return read();};reader.cancel=()=>{cancels++;return cancel();};reader.releaseLock=()=>{unlocks++;unlock();};return reader;};
 const abort=new AbortController();if(mode==='pre-aborted')abort.abort();
 const response=new Response(body,{headers:mode==='bad-header'?{'Content-Length':'999'}:{}});
 const result=await observe(mode==='cancel-only'?cancelTextAssetResponse(response):readTextAssetResponse(response,4,abort.signal));
 if(mode==='cancel-only')assert.equal(Object.hasOwn(result,'error'),false);else assert.equal(result.error.code,mode==='pre-aborted'?'TEXT_CANCELLED':'TEXT_ASSET_LOAD');
 assert.equal(cancels,1);assert.equal(reads,0);assert.equal(unlocks,1);assert.equal(body.locked,false);
 assert.equal(retainTextAssetCleanup(result.error,{bytes:4,release(){assert.fail('Unknown failure has no lease authority');}}),false);
});

test('original pending or differently rejected closed metadata cannot excuse a cancel rejection',{timeout:2000},async()=>{
 for(const makeClosed of [()=>deferred().promise,()=>Promise.reject(Error('different stored error'))]){
  const closed=makeClosed();
  let cancels=0,unlocks=0;const reason=new DOMException('source cancel rejected','AbortError'),reader={closed,cancel(){cancels++;return Promise.reject(reason);},releaseLock(){unlocks++;}};
  const result=await observe(cancelTextAssetResponse({body:{getReader:()=>reader}}));assert.equal(result.error.code,'TEXT_ASSET_CLEANUP');assert.equal(result.error.details,reason);assert.equal(cancels,1);assert.equal(unlocks,1);assert.equal(await retryTextAssetCleanup(result.error),false);
 }
});

test('a failed structural lease release keeps its booking handle without repeating released leases',async()=>{
 let unlockAllowed=false,firstReleases=0,secondReleases=0,releaseAllowed=false;
 const reader={closed:Promise.resolve(),async read(){return {done:true};},releaseLock(){if(!unlockAllowed)throw Error('unlock failed');}};
 const {error}=await observe(readTextAssetResponse({ok:true,headers:new Headers(),body:{getReader:()=>reader}},0));
 assert(retainTextAssetCleanup(error,{bytes:3,release(){firstReleases++;}}));assert(retainTextAssetCleanup(error,{bytes:5,release(){if(!releaseAllowed)throw Error('lease release failed');secondReleases++;}}));
 unlockAllowed=true;await assert.rejects(retryTextAssetCleanup(error),/lease release failed/);assert.equal(firstReleases,1);assert.equal(secondReleases,0);
 releaseAllowed=true;assert.equal(await retryTextAssetCleanup(error),true);assert.equal(firstReleases,1);assert.equal(secondReleases,1);assert.equal(await retryTextAssetCleanup(error),false);
});

test('a cancellation failure stays permanent after its exact reader unlock retry succeeds',async()=>{
 let unlockAllowed=false,unlocks=0,cancels=0,releases=0;
 const reader={closed:Promise.resolve(),cancel(){cancels++;return Promise.reject(Error('cancel source unresolved'));},releaseLock(){unlocks++;if(!unlockAllowed)throw Error('unlock failed');}};
 const result=await observe(cancelTextAssetResponse({body:{getReader:()=>reader}}));assert.equal(result.error.code,'TEXT_ASSET_CLEANUP');assert.equal(retainTextAssetCleanup(result.error,{bytes:7,release(){releases++;}}),true);
 await assert.rejects(retryTextAssetCleanup(result.error),/unlock failed/);unlockAllowed=true;assert.equal(await retryTextAssetCleanup(result.error),false);assert.equal(await retryTextAssetCleanup(result.error),false);
 assert.equal(unlocks,3);assert.equal(cancels,1);assert.equal(releases,0);
});

test('permanent cleanup owns the actual response and unlocked reader across garbage collection',()=>{
 const script=`import assert from 'node:assert/strict';
  const {cancelTextAssetResponse,retainTextAssetCleanup,retryTextAssetCleanup}=await import(${JSON.stringify(contractsURL)});
  let responseRef,readerRef,releases=0;
  await (async()=>{const body=new ReadableStream({cancel(){throw Error('unresolved source');}}),nativeGet=body.getReader.bind(body);
   body.getReader=()=>{const reader=nativeGet();readerRef=new WeakRef(reader);return reader;};
   const response=new Response(body);responseRef=new WeakRef(response);
   try{await cancelTextAssetResponse(response);assert.fail('cancellation must reject');}catch(error){assert.equal(error.code,'TEXT_ASSET_CLEANUP');globalThis.cleanupOwner=error;}
   assert.equal(body.locked,false);assert(retainTextAssetCleanup(globalThis.cleanupOwner,{bytes:4096,release(){releases++;}}));
  })();
  for(let i=0;i<16;i++){await new Promise(resolve=>setImmediate(resolve));globalThis.gc();}
  assert(responseRef.deref(),'actual response ownership was lost');assert(readerRef.deref(),'actual reader ownership was lost');
  assert.equal(await retryTextAssetCleanup(globalThis.cleanupOwner),false);assert.equal(releases,0);`;
 execFileSync(process.execPath,['--expose-gc','--import',resolve('tests/session/no-egress.mjs'),'--input-type=module','--eval',script],{stdio:'pipe',timeout:15000});
});

const memoryURL=data(`export const engineReservationBytes=100,engineResidentBytes=60;export const textMemory={check(){},reserve(bytes){const c=globalThis.__textOwnership;c.held+=bytes;let live=true;return {bytes,release(){if(live){live=false;c.held-=bytes;c.released.push(bytes);}}};}};export const planText=()=>({bytes:20,startup:10,raster:4,layout:100});export const unownedFontBytes=()=>0;export const retainPrepared=()=>{};export const releasePrepared=()=>{};`);
const clientURL=await module('src/text/client.ts',{'./contracts':contractsURL,'./memory':memoryURL,'../observability/browser-worker-observations.js':workerPhasesURL,'../observability/allocations.js':allocationsURL,'../observability/diagnostic-memory.js':diagnosticMemoryURL});
// The constructor URL is the only browser-only syntax this native Worker stand-in
// does not use; preserve the production constructor/handlers/termination logic.
const clientCode=Buffer.from(clientURL.split(',')[1],'base64').toString().replaceAll('import.meta.url',JSON.stringify('http://127.0.0.1/renderer.js'));
const {TextRenderer}=await import(data(clientCode));
const request={text:'a',frame:{width:1,height:1},token:{documentId:'d',documentRevision:'1',layerId:'l',layerVersion:'1',sessionId:'s',generation:1},style:{primaryFont:'font',explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},fonts:[]};

function workers(){const original=globalThis.Worker,context={held:0,released:[],workers:[],fail:true};globalThis.__textOwnership=context;globalThis.Worker=class{constructor(){this.attempts=0;this.posts=[];context.workers.push(this);}terminate(){this.attempts++;if(context.fail)throw Error('terminate failed');}postMessage(value){this.posts.push(value);}};return {context,restore(){globalThis.Worker=original;delete globalThis.__textOwnership;}};}

test('failed active termination retains the exact worker and leases across retry and then releases once',async()=>{
 const f=workers(),renderer=new TextRenderer();try{
  const result=observe(renderer.prepare(request));await Promise.resolve();const worker=f.context.workers[0],late=worker.onmessage;assert.equal(f.context.held,110);
  renderer.cancel();assert.equal((await result).error.code,'TEXT_TERMINATION_FAILED');assert.equal(worker.attempts,1);assert.equal(renderer.lifecycle.idleWorkers,1);assert.equal(renderer.lifecycle.uncertainBytes,110);assert.equal(f.context.held,110);
  late({data:{ready:true}});assert.equal(worker.posts.length,0);
  await assert.rejects(renderer.prepare(request),/TEXT_TERMINATION_FAILED/);assert.equal(worker.attempts,2);assert.equal(f.context.workers.length,1);assert.equal(renderer.lifecycle.uncertainBytes,110);assert.equal(f.context.held,110);
  assert.throws(()=>renderer.dispose(),/TEXT_TERMINATION_FAILED/);assert.equal(worker.attempts,3);assert.equal(f.context.held,110);
  f.context.fail=false;renderer.dispose();assert.equal(worker.attempts,4);assert.equal(renderer.lifecycle.uncertainBytes,0);assert.equal(renderer.lifecycle.idleWorkers,0);assert.equal(renderer.lifecycle.terminations,1);assert.equal(f.context.held,0);assert.deepEqual(f.context.released.sort((a,b)=>a-b),[10,100]);renderer.dispose();assert.equal(worker.attempts,4);
 }finally{f.context.fail=false;renderer.dispose();f.restore();}
});

for(const code of ['FONT_CACHE_CAPACITY','TEXT_NATIVE_CAPACITY','TEXT_FATAL'])test('failed '+code+' termination cannot publish or replace the owned worker',async()=>{
 const f=workers(),renderer=new TextRenderer();try{const result=observe(renderer.prepare(request));await Promise.resolve();const worker=f.context.workers[0];worker.onmessage({data:{ok:false,fatal:code==='TEXT_FATAL',code}});assert.equal((await result).error.code,'TEXT_TERMINATION_FAILED');assert.equal(renderer.lifecycle.uncertainBytes,110);assert.equal(f.context.workers.length,1);f.context.fail=false;renderer.dispose();assert.equal(f.context.held,0);assert.equal(renderer.lifecycle.terminations,1);}finally{f.context.fail=false;renderer.dispose();f.restore();}
});

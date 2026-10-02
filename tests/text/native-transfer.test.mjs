// Authored source-only; unexecuted. Run only after coordinated promotion.
// Real contracts/admission/budget/pool/client source; Worker and diagnostic
// boundaries are controlled doubles, not browser/WASM/native-memory evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
import {isolatedDiagnosticModules} from '../owned-preview-module.mjs';

const sourceRoot=resolve(process.env.IE_NATIVE_TRANSFER_ROOT??'.');
const baseRoot=resolve(process.env.IE_NATIVE_TRANSFER_BASE??'.');
const newSourceRoot=resolve(process.env.IE_NATIVE_TRANSFER_NEW_ROOT??sourceRoot);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
let serial=0;
async function moduleURL(path,imports={},id=''){
  let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
  for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
  // A data module has no relative URL base. Preserve the real source URL for
  // the client's documented Worker URL constructor without loading the worker.
  code=code.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(path).href));
  return data(code+'\n// isolated fixture '+id);
}
async function poolFixture(){
  const id=String(++serial),contractsURL=await moduleURL(resolve(baseRoot,'src/text/contracts.ts'),{},id);
  const admission=await moduleURL(resolve(baseRoot,'src/text/admission.ts'),{'./contracts':contractsURL},id);
  const budget=await moduleURL(resolve(baseRoot,'src/protocol/text-budget.ts'),{},id);
  const profile=JSON.parse(await readFile(resolve(baseRoot,'src/text/profile.json'),'utf8'));
  const {allocationsURL,diagnosticMemoryURL}=await isolatedDiagnosticModules();
  const memoryURL=await moduleURL(resolve(sourceRoot,'src/text/memory.ts'),{
    '../observability/diagnostic-memory.js':diagnosticMemoryURL,
    './contracts':contractsURL,'./admission':admission,'./profile.json':data('const profile='+JSON.stringify(profile)+';export default profile;export const engine=profile.engine;'),
    '../protocol/text-budget':budget,
  },id);
  const memory=await import(memoryURL),{allocationLedger}=await import(allocationsURL);
  // These transfer/observer-fault units own the real pool's sole observer slot.
  // Detach only the real automatic diagnostic subscription; no lease is freed
  // and no resource qualification is claimed by this isolated unit fixture.
  allocationLedger.observeTextReservations(()=>0);
  return {...memory,memoryURL,contractsURL,id,profile};
}
const transferError=error=>error?.code==='TEXT_RESERVATION_TRANSFER';
const ownershipError=error=>error?.code==='TEXT_PREPARED_OWNERSHIP';
const zero={cpuBytes:0,textBytes:0};
function unchanged(pool,work,error=transferError){
  const before=pool.snapshot,observation=pool.reservationObservation;
  assert.throws(work,error);
  assert.deepEqual(pool.snapshot,before);
  assert.deepEqual(pool.reservationObservation,observation);
}

test('split changes ownership once without changing either aggregate or its observer value',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(100),observed=[];
  const stop=pool.observeReservations((bytes,sequence,faults)=>observed.push({bytes,sequence,faults,remaining:source.bytes}));
  const before=pool.reservationObservation,child=pool.split(source,40);
  assert.equal(source.bytes,60);assert.equal(child.bytes,40);assert(Object.isFrozen(child));
  assert.deepEqual(pool.snapshot,{cpuBytes:100,textBytes:100});
  assert.deepEqual(observed,[{bytes:100,sequence:before.sequence,faults:0,remaining:100},{bytes:100,sequence:before.sequence+1,faults:0,remaining:60}]);
  source.release();assert.deepEqual(pool.snapshot,{cpuBytes:40,textBytes:40});
  child.release();assert.deepEqual(pool.snapshot,zero);stop();
});

test('source, child, and descendant releases are independent and idempotent',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(100),child=pool.split(source,40),descendant=pool.split(child,15);
  assert.deepEqual([source.bytes,child.bytes,descendant.bytes],[60,25,15]);
  child.release();child.release();assert.equal(child.bytes,25);assert.equal(pool.snapshot.textBytes,75);
  descendant.release();assert.equal(pool.snapshot.textBytes,60);
  source.release();source.release();assert.equal(source.bytes,60);assert.deepEqual(pool.snapshot,zero);
});

test('invalid amounts and oversplitting fail before changing an active source',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(32);
  for(const bytes of [0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,33]){
    unchanged(pool,()=>pool.split(source,bytes));assert.equal(source.bytes,32);
  }
  source.release();assert.deepEqual(pool.snapshot,zero);
});

test('foreign-pool, forged, and malformed reservations confer no transfer authority',async()=>{
  const first=await poolFixture(),second=await poolFixture(),source=first.textMemory.reserve(32),foreign=second.textMemory.reserve(32);
  for(const candidate of [foreign,{bytes:32,release(){}},null,undefined,1,'lease'])unchanged(first.textMemory,()=>first.textMemory.split(candidate,1));
  assert.equal(source.bytes,32);assert.equal(foreign.bytes,32);assert.equal(second.textMemory.snapshot.textBytes,32);
  source.release();foreign.release();assert.deepEqual(first.textMemory.snapshot,zero);assert.deepEqual(second.textMemory.snapshot,zero);
});

test('released and fully transferred reservations cannot be reused as a source',async()=>{
  const {textMemory:pool}=await poolFixture(),released=pool.reserve(8);released.release();
  unchanged(pool,()=>pool.split(released,1));
  const source=pool.reserve(8),child=pool.split(source,8);assert.equal(source.bytes,0);
  unchanged(pool,()=>pool.split(source,1));source.release();assert.equal(pool.snapshot.textBytes,8);
  unchanged(pool,()=>pool.split(source,1));child.release();assert.deepEqual(pool.snapshot,zero);
});

test('transfer preserves the authenticated text or other category',async()=>{
  const {textMemory:pool}=await poolFixture(),text=pool.reserve(20),other=pool.reserve(30,'other');
  unchanged(pool,()=>pool.split(other,10));unchanged(pool,()=>pool.split(text,10,'other'));
  const child=pool.split(other,10,'other');assert.deepEqual(pool.snapshot,{cpuBytes:50,textBytes:20});
  other.release();assert.deepEqual(pool.snapshot,{cpuBytes:30,textBytes:20});
  child.release();text.release();assert.deepEqual(pool.snapshot,zero);
});

test('a throwing observer cannot lose either side of a successful transfer',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(12);let throwNow=false;
  const stop=pool.observeReservations(()=>{if(throwNow)throw Error('observer failed');});throwNow=true;
  const child=pool.split(source,5);assert.equal(source.bytes,7);assert.equal(child.bytes,5);
  assert.equal(pool.reservationObservation.observerFaults,1);assert.equal(pool.snapshot.textBytes,12);
  stop();source.release();child.release();assert.deepEqual(pool.snapshot,zero);
});

test('an observer cannot reenter transfer and silently move additional ownership',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(12);let attempt=false,failure;
  const stop=pool.observeReservations(()=>{if(attempt)try{pool.split(source,1);}catch(error){failure=error;}});
  attempt=true;const child=pool.split(source,5);stop();
  assert.equal(failure?.code,'TEXT_RESERVATION_OBSERVER_REENTRANCY');assert.equal(pool.reservationObservation.observerFaults,1);
  assert.equal(source.bytes,7);assert.equal(child.bytes,5);assert.equal(pool.snapshot.textBytes,12);
  source.release();child.release();assert.deepEqual(pool.snapshot,zero);
});

test('replacement growth near capacity admits only the additional bytes and notifies once',async()=>{
  const {textMemory:pool}=await poolFixture(),capacity=128*1024**2,source=pool.reserve(64),pressure=pool.reserve(capacity-96),events=[];
  const before=pool.reservationObservation,stop=pool.observeReservations((bytes,sequence)=>events.push({bytes,sequence}));
  const replacement=pool.replace(source,96);stop();
  assert.equal(source.bytes,64);assert.equal(replacement.bytes,96);assert(Object.isFrozen(replacement));
  assert.deepEqual(events,[{bytes:capacity-32,sequence:before.sequence},{bytes:capacity,sequence:before.sequence+1}]);
  const after=pool.reservationObservation;source.release();assert.deepEqual(pool.reservationObservation,after);
  assert.equal(pool.snapshot.textBytes,capacity);pressure.release();replacement.release();assert.deepEqual(pool.snapshot,zero);
});

test('refused replacement growth preserves the source and allows a later retry',async()=>{
  const {textMemory:pool}=await poolFixture(),capacity=128*1024**2,source=pool.reserve(32),pressure=pool.reserve(capacity-32);
  unchanged(pool,()=>pool.replace(source,64),error=>error?.code==='TEXT_MEMORY_BUDGET');assert.equal(source.bytes,32);
  pressure.release();const replacement=pool.replace(source,64);assert.equal(pool.snapshot.textBytes,64);
  unchanged(pool,()=>pool.replace(source,1));source.release();assert.equal(pool.snapshot.textBytes,64);
  replacement.release();assert.deepEqual(pool.snapshot,zero);
});

test('shrinking replaces only the remaining source bytes after a prior split',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(100),child=pool.split(source,30),before=pool.reservationObservation;
  const replacement=pool.replace(source,20);assert.equal(source.bytes,70);assert.equal(replacement.bytes,20);
  assert.deepEqual(pool.snapshot,{cpuBytes:50,textBytes:50});assert.equal(pool.reservationObservation.sequence,before.sequence+1);
  source.release();assert.equal(pool.snapshot.textBytes,50);child.release();assert.equal(pool.snapshot.textBytes,20);
  replacement.release();replacement.release();assert.deepEqual(pool.snapshot,zero);
});

test('same-size replacement at full capacity transfers ownership with one unchanged observation',async()=>{
  const {textMemory:pool}=await poolFixture(),capacity=128*1024**2,source=pool.reserve(capacity),events=[];
  const before=pool.reservationObservation,stop=pool.observeReservations((bytes,sequence)=>events.push({bytes,sequence}));
  const replacement=pool.replace(source,capacity);stop();
  assert.deepEqual(events,[{bytes:capacity,sequence:before.sequence},{bytes:capacity,sequence:before.sequence+1}]);
  const after=pool.reservationObservation;source.release();source.release();assert.deepEqual(pool.reservationObservation,after);
  assert.equal(source.bytes,capacity);replacement.release();assert.deepEqual(pool.snapshot,zero);
});

test('invalid replacement amounts leave the live owner and its sequence unchanged',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(16);
  for(const bytes of [0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    unchanged(pool,()=>pool.replace(source,bytes));assert.equal(source.bytes,16);
  }
  source.release();assert.deepEqual(pool.snapshot,zero);
});

test('replacement rejects foreign, forged, released, and wrong-category owners',async()=>{
  const first=await poolFixture(),second=await poolFixture(),pool=first.textMemory,source=pool.reserve(16),other=pool.reserve(12,'other'),released=pool.reserve(4),foreign=second.textMemory.reserve(8);released.release();
  for(const candidate of [foreign,released,{bytes:16,release(){}},null,undefined,1])unchanged(pool,()=>pool.replace(candidate,8));
  unchanged(pool,()=>pool.replace(source,8,'other'));unchanged(pool,()=>pool.replace(other,8));
  const replacement=pool.replace(other,24,'other');assert.deepEqual(pool.snapshot,{cpuBytes:40,textBytes:16});
  assert.equal(other.bytes,12);other.release();assert.deepEqual(pool.snapshot,{cpuBytes:40,textBytes:16});
  source.release();replacement.release();foreign.release();assert.deepEqual(pool.snapshot,zero);assert.deepEqual(second.textMemory.snapshot,zero);
});

test('a throwing observer cannot lose the successful replacement or revive its old owner',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(16);let throwNow=false;
  const stop=pool.observeReservations(()=>{if(throwNow)throw Error('observer failed');});throwNow=true;
  const replacement=pool.replace(source,24);stop();assert.equal(pool.reservationObservation.observerFaults,1);
  source.release();assert.equal(pool.snapshot.textBytes,24);unchanged(pool,()=>pool.replace(source,1));
  replacement.release();assert.deepEqual(pool.snapshot,zero);
});

test('replacement notification rejects reentrant mutation without a second ownership change',async()=>{
  const {textMemory:pool}=await poolFixture(),source=pool.reserve(16);let attempt=false,failure;
  const stop=pool.observeReservations(()=>{if(attempt)try{pool.replace(source,1);}catch(error){failure=error;}});
  attempt=true;const replacement=pool.replace(source,24);stop();
  assert.equal(failure?.code,'TEXT_RESERVATION_OBSERVER_REENTRANCY');assert.equal(pool.reservationObservation.observerFaults,1);
  assert.equal(source.bytes,16);assert.equal(replacement.bytes,24);assert.equal(pool.snapshot.textBytes,24);
  source.release();replacement.release();assert.deepEqual(pool.snapshot,zero);
});

test('prepared output adopts the source booking and survives release of the remainder',async()=>{
  const f=await poolFixture(),source=f.textMemory.reserve(100),value=Object.freeze({kind:'output'}),before=f.textMemory.reservationObservation;
  f.retainPrepared(value,40,source);assert.equal(source.bytes,60);assert.equal(f.textMemory.snapshot.textBytes,100);
  assert.equal(f.textMemory.reservationObservation.sequence,before.sequence+1);
  source.release();assert.equal(f.textMemory.snapshot.textBytes,40);
  f.releasePrepared(value);f.releasePrepared(value);assert.deepEqual(f.textMemory.snapshot,zero);
});

test('prepared owners reject duplicates and invalid identities without replacing a live booking',async()=>{
  const f=await poolFixture(),source=f.textMemory.reserve(80),value={};f.retainPrepared(value,30,source);
  unchanged(f.textMemory,()=>f.retainPrepared(value,20,source),ownershipError);assert.equal(source.bytes,50);
  for(const invalid of [null,undefined,1,'output',()=>{}])unchanged(f.textMemory,()=>f.retainPrepared(invalid,1,source),ownershipError);
  source.release();assert.equal(f.textMemory.snapshot.textBytes,30);f.releasePrepared(value);
  // The existing no-source API still creates and releases a separate booking.
  f.retainPrepared(value,7);assert.equal(f.textMemory.snapshot.textBytes,7);f.releasePrepared(value);assert.deepEqual(f.textMemory.snapshot,zero);
});

test('failed prepared adoption leaves its identity available for a later valid transfer',async()=>{
  const f=await poolFixture(),source=f.textMemory.reserve(8),value={};
  unchanged(f.textMemory,()=>f.retainPrepared(value,9,source));unchanged(f.textMemory,()=>f.retainPrepared(value,1,null));
  f.retainPrepared(value,8,source);assert.equal(source.bytes,0);source.release();assert.equal(f.textMemory.snapshot.textBytes,8);
  f.releasePrepared(value);assert.deepEqual(f.textMemory.snapshot,zero);
});

function request(frame={width:12,height:8}){
  const hash='sha256:'+'a'.repeat(64);
  return {text:'A',token:{documentId:'document',documentRevision:'1',layerId:'layer',layerVersion:'1',sessionId:'session',generation:1},frame,
    style:{primaryFont:hash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1,fill:[0,0,0,255],align:'left',direction:'ltr'},
    fonts:[{hash,bytes:new Blob([new Uint8Array([1,2,3,4])]),faceIndex:0,origin:'bundled',license:{hash:'sha256:'+'b'.repeat(64),embedding:'permitted'}}]};
}
async function clientFixture(t){
  const f=await poolFixture(),workers=[],renderers=[],outputs=new Set();
  const boundary=data(`let active=0;export const diagnosticState=()=>active;export const TEXT_WORKER_DIAGNOSTIC_BYTES=1024;
    export const allocationLedger={reserve(){active++;let live=true;return {markUnused(){},release(){if(live){live=false;active--;}}};}};
    export function retainWorkerPhases(){}\n// ${f.id}`);
  const clientURL=await moduleURL(resolve(sourceRoot,'src/text/client.ts'),{
    './contracts':f.contractsURL,'./memory':f.memoryURL,'../observability/allocations.js':boundary,
    '../observability/diagnostic-memory.js':boundary,'../observability/browser-worker-observations.js':boundary,
  },f.id);
  const client=await import(clientURL),diagnostics=await import(boundary),previous=globalThis.Worker;
  class WorkerDouble{
    constructor(url,options){assert.equal(url.protocol,'file:');assert(url.pathname.endsWith('/src/text/worker.ts'));assert.equal(options.type,'module');this.requests=[];this.terminations=0;workers.push(this);}
    postMessage(value){this.requests.push(value);}
    terminate(){this.terminations++;if(this.terminateFailure)throw this.terminateFailure;}
    emit(value){assert.equal(typeof this.onmessage,'function');this.onmessage({data:value});}
  }
  globalThis.Worker=WorkerDouble;
  t.after(()=>{try{for(const renderer of renderers)renderer.dispose();for(const value of outputs)f.releasePrepared(value);}finally{if(previous===undefined)delete globalThis.Worker;else globalThis.Worker=previous;}});
  return {...f,diagnostics,workers,async start(input=request(),beforeReady){
    const renderer=new client.TextRenderer();renderers.push(renderer);
    const work=renderer.prepare(input);void work.then(value=>outputs.add(value),()=>{});
    await Promise.resolve();const worker=workers.at(-1),plan=f.planText(input);assert(worker);
    beforeReady?.({renderer,worker,plan});worker.emit({ready:true});assert.equal(worker.requests.length,1);
    return {renderer,worker,work,input:worker.requests[0],plan};
  }};
}
function resultFor(f,run){
  const input=run.input;
  return {kind:'prepared-text-1',token:structuredClone(input.token),rendererProfile:f.profile.id,dependencyHash:'sha256:'+'c'.repeat(64),
    dependencies:input.fonts.map(font=>({hash:font.hash,licenseHash:font.license.hash,faceIndex:0,format:'static-ttf',parserProfile:'font-parser-test',fsType:0,bytes:new Blob([font.bytes])})),
    textUtf8:new Blob([input.text]),textHash:'sha256:'+'d'.repeat(64),layout:new Blob(['{}']),layoutHash:'sha256:'+'e'.repeat(64),
    rgba:new Blob([new Uint8Array(run.plan.raster)]),rasterHash:'sha256:'+'f'.repeat(64),width:Math.ceil(input.frame.width),height:Math.ceil(input.frame.height),overflow:false,
    allocation:{wasmHeapBytes:0,uniqueFontBytes:input.fonts[0].bytes.size,rasterBytes:run.plan.raster,layoutBytes:2,gpuBytes:0}};
}
async function rejectedResult(f,run,result,code){
  run.worker.emit({ok:true,value:result});await assert.rejects(run.work,error=>error?.code===code);
  assert.equal(f.textMemory.snapshot.textBytes,f.engineResidentBytes);
  run.renderer.dispose();assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
}

test('worker ready retains engine and request ownership through their atomic transitions',async t=>{
  const f=await clientFixture(t),events=[];let before,stop;
  const run=await f.start(request(),({plan})=>{
    // Attach after startup engine admission and before the actual ready message.
    assert.equal(f.textMemory.snapshot.textBytes,f.engineReservationBytes+plan.startup);
    before=f.textMemory.reservationObservation;
    stop=f.textMemory.observeReservations((bytes,sequence)=>events.push({bytes,sequence}));
  });
  stop();
  assert.deepEqual(events,[
    {bytes:f.engineReservationBytes+run.plan.startup,sequence:before.sequence},
    {bytes:f.engineReservationBytes+run.plan.startup,sequence:before.sequence+1},
    {bytes:f.engineResidentBytes+run.plan.startup,sequence:before.sequence+2},
    {bytes:f.engineResidentBytes+run.plan.bytes,sequence:before.sequence+3},
  ]);
  assert(events.every(event=>event.bytes>=f.engineResidentBytes+Math.min(run.plan.startup,run.plan.bytes)));
  run.renderer.cancel();await assert.rejects(run.work,error=>error?.code==='TEXT_CANCELLED');
  assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
});

test('a warm worker replaces request startup ownership without a zero-request interval',async t=>{
  const f=await clientFixture(t),first=await f.start();first.worker.emit({ok:true,value:resultFor(f,first)});
  f.releasePrepared(await first.work);assert.equal(f.textMemory.snapshot.textBytes,f.engineResidentBytes);
  const input=request({width:64,height:2});input.token.generation=2;const plan=f.planText(input),work=first.renderer.prepare(input);void work.catch(()=>{});
  const events=[],before=f.textMemory.reservationObservation,stop=f.textMemory.observeReservations((bytes,sequence)=>events.push({bytes,sequence}));
  await Promise.resolve();stop();assert.equal(first.worker.requests.length,2);assert.equal(first.worker.terminations,0);
  assert.deepEqual(events,[{bytes:f.engineResidentBytes+plan.startup,sequence:before.sequence},{bytes:f.engineResidentBytes+plan.bytes,sequence:before.sequence+1}]);
  const warm={...first,input:first.worker.requests[1],plan};first.worker.emit({ok:true,value:resultFor(f,warm)});
  const value=await work;t.after(()=>f.releasePrepared(value));assert.equal(value.token.generation,2);
  first.renderer.dispose();f.releasePrepared(value);assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
});

test('warm replacement refusal releases only the startup request and permits reuse after pressure clears',async t=>{
  const f=await clientFixture(t),first=await f.start();first.worker.emit({ok:true,value:resultFor(f,first)});f.releasePrepared(await first.work);
  const input=request({width:64,height:2});input.token.generation=2;const plan=f.planText(input);assert(plan.bytes>plan.startup);
  const work=first.renderer.prepare(input);void work.catch(()=>{});
  // Another owner consumes capacity after prepare admitted startup but before
  // the queued warm start attempts to replace it with the full request plan.
  const pressure=f.textMemory.reserve(128*1024**2-f.textMemory.snapshot.textBytes);t.after(()=>pressure.release());
  await assert.rejects(work,error=>error?.code==='TEXT_MEMORY_BUDGET');
  assert.equal(first.worker.requests.length,1);assert.equal(first.worker.terminations,0);
  assert.equal(f.textMemory.snapshot.textBytes,f.engineResidentBytes+pressure.bytes);assert.equal(f.diagnostics.diagnosticState(),1);
  pressure.release();const retry=first.renderer.prepare(input);void retry.catch(()=>{});await Promise.resolve();
  assert.equal(first.worker.requests.length,2);assert.equal(f.textMemory.snapshot.textBytes,f.engineResidentBytes+plan.bytes);
  first.renderer.cancel();await assert.rejects(retry,error=>error?.code==='TEXT_CANCELLED');
  assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
});

test('successful client adoption at full capacity has neither a gap nor double admission',async t=>{
  const f=await clientFixture(t),run=await f.start(),result=resultFor(f,run),events=[];
  const pressure=f.textMemory.reserve(128*1024**2-f.textMemory.snapshot.textBytes);t.after(()=>pressure.release());
  const retained=result.rgba.size+result.layout.size+result.textUtf8.size+f.unownedFontBytes(run.input),before=f.textMemory.reservationObservation;
  // Observe only result adoption: engine-ready/startup transitions precede this
  // slice. The pool is full, so reserving a second output booking would fail.
  const stop=f.textMemory.observeReservations((bytes,sequence)=>events.push({bytes,sequence}));
  run.worker.emit({ok:true,value:result});const value=await run.work;stop();
  assert.deepEqual(events,[{bytes:128*1024**2,sequence:before.sequence},{bytes:128*1024**2,sequence:before.sequence+1},{bytes:pressure.bytes+f.engineResidentBytes+retained,sequence:before.sequence+2}]);
  assert(events.every(event=>event.bytes>=pressure.bytes+f.engineResidentBytes+retained));
  assert(Object.isFrozen(value));assert(Object.isFrozen(value.dependencies));assert.equal(value.dependencies[0].bytes,run.input.fonts[0].bytes);
  run.renderer.dispose();pressure.release();assert.equal(f.textMemory.snapshot.textBytes,retained);assert.equal(f.diagnostics.diagnosticState(),0);
  f.releasePrepared(value);assert.deepEqual(f.textMemory.snapshot,zero);
});

test('fractional short frames retain only the exact ceil(width) by ceil(height) raster',async t=>{
  const f=await clientFixture(t),run=await f.start(request({width:319.25,height:0.25})),result=resultFor(f,run);
  assert.equal(result.width,320);assert.equal(result.height,1);assert.equal(result.rgba.size,1280);
  run.worker.emit({ok:true,value:result});const value=await run.work;
  assert.equal(value.width,320);assert.equal(value.height,1);assert.equal(value.rgba.size,1280);
  run.renderer.dispose();assert.equal(f.textMemory.snapshot.textBytes,1280+2+1+4);f.releasePrepared(value);assert.deepEqual(f.textMemory.snapshot,zero);
});

test('same-sized raster with an incorrect width is rejected before prepared ownership escapes',async t=>{
  const f=await clientFixture(t),run=await f.start(),result=resultFor(f,run);result.width++;
  await rejectedResult(f,run,result,'TEXT_RESULT_BUDGET');
});

test('same-sized raster with an incorrect short-frame height is rejected before adoption',async t=>{
  const f=await clientFixture(t),run=await f.start(request({width:320,height:1})),result=resultFor(f,run);result.height=150;
  await rejectedResult(f,run,result,'TEXT_RESULT_BUDGET');
});

test('stale worker result releases its job while preserving the reusable resident engine',async t=>{
  const f=await clientFixture(t),run=await f.start(),result=resultFor(f,run);result.token.generation++;
  await rejectedResult(f,run,result,'TEXT_STALE');
});

test('invalid raster, layout, text, and dependency sizes never leave retained output bookings',async t=>{
  const f=await clientFixture(t);
  for(const mutate of [
    (result,run)=>{result.rgba=new Blob([new Uint8Array(run.plan.raster-1)]);},
    (result,run)=>{result.layout=new Blob([new Uint8Array(run.plan.layout+1)]);},
    result=>{result.textUtf8=new Blob([new Uint8Array(16385)]);},
    result=>{result.dependencies[0].bytes=new Blob([new Uint8Array(5)]);},
  ]){
    const run=await f.start(),result=resultFor(f,run);mutate(result,run);await rejectedResult(f,run,result,'TEXT_RESULT_BUDGET');
  }
});

test('capacity retry keeps request ownership and sends the same request to exactly one replacement worker',async t=>{
  const f=await clientFixture(t);
  for(const code of ['FONT_CACHE_CAPACITY','TEXT_NATIVE_CAPACITY']){
    const run=await f.start(),count=f.workers.length,events=[],before=f.textMemory.reservationObservation;
    const stop=f.textMemory.observeReservations((bytes,sequence)=>events.push({bytes,sequence}));
    run.worker.emit({ok:false,code});stop();
    assert.equal(run.worker.terminations,1);assert.equal(f.workers.length,count+1);
    assert.deepEqual(events,[
      {bytes:f.engineResidentBytes+run.plan.bytes,sequence:before.sequence},
      {bytes:run.plan.bytes,sequence:before.sequence+1},
      {bytes:run.plan.startup,sequence:before.sequence+2},
      {bytes:f.engineReservationBytes+run.plan.startup,sequence:before.sequence+3},
    ]);
    assert(events.every(event=>event.bytes>=Math.min(run.plan.startup,run.plan.bytes)));
    const replacement=f.workers.at(-1);assert.notEqual(replacement,run.worker);assert.equal(replacement.requests.length,0);
    replacement.emit({ready:true});assert.equal(replacement.requests.length,1);assert.equal(replacement.requests[0],run.input);
    replacement.emit({ok:true,value:resultFor(f,run)});const value=await run.work;
    run.renderer.dispose();f.releasePrepared(value);assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
  }
});

test('a second capacity failure rejects without constructing a third worker',async t=>{
  const f=await clientFixture(t),run=await f.start();run.worker.emit({ok:false,code:'FONT_CACHE_CAPACITY'});
  const replacement=f.workers.at(-1);replacement.emit({ready:true});assert.equal(replacement.requests[0],run.input);
  replacement.emit({ok:false,code:'FONT_CACHE_CAPACITY'});
  await assert.rejects(run.work,error=>error?.code==='FONT_CACHE_CAPACITY');
  assert.equal(f.workers.length,2);assert.equal(run.worker.terminations,1);assert.equal(replacement.terminations,0);
  assert.equal(f.textMemory.snapshot.textBytes,f.engineResidentBytes);assert.equal(f.diagnostics.diagnosticState(),1);
  run.renderer.dispose();assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
});

test('retry startup-engine admission can refuse after resident headroom succeeds without leaking the job',async t=>{
  const f=await clientFixture(t),run=await f.start(),capacity=128*1024**2;
  const pressure=f.textMemory.reserve(capacity-f.textMemory.snapshot.textBytes);t.after(()=>pressure.release());
  // Terminating the old engine makes the resident-only check exactly fit. The
  // larger startup engine is the reachable refusal, after request replacement.
  assert.equal(pressure.bytes+run.plan.bytes+f.engineResidentBytes,capacity);
  assert(pressure.bytes+run.plan.startup+f.engineReservationBytes>capacity);
  const events=[],before=f.textMemory.reservationObservation,stop=f.textMemory.observeReservations((bytes,sequence)=>events.push({bytes,sequence}));
  run.worker.emit({ok:false,code:'TEXT_NATIVE_CAPACITY'});
  await assert.rejects(run.work,error=>error?.code==='TEXT_MEMORY_BUDGET'&&error.details?.requested===f.engineReservationBytes);stop();
  assert.deepEqual(events,[
    {bytes:capacity,sequence:before.sequence},
    {bytes:pressure.bytes+run.plan.bytes,sequence:before.sequence+1},
    {bytes:pressure.bytes+run.plan.startup,sequence:before.sequence+2},
    {bytes:pressure.bytes,sequence:before.sequence+3},
  ]);
  assert.equal(f.workers.length,1);assert.equal(run.worker.terminations,1);assert.equal(f.diagnostics.diagnosticState(),0);
  assert.equal(f.textMemory.snapshot.textBytes,pressure.bytes);assert.equal(run.renderer.lifecycle.uncertainBytes,0);
  pressure.release();run.renderer.dispose();assert.deepEqual(f.textMemory.snapshot,zero);
});

test('capacity retry cannot replace a worker whose termination is still unconfirmed',async t=>{
  const f=await clientFixture(t),run=await f.start(),held=f.engineResidentBytes+run.plan.bytes;
  run.worker.terminateFailure=Error('native termination refused');run.worker.emit({ok:false,code:'FONT_CACHE_CAPACITY'});
  await assert.rejects(run.work,error=>error?.code==='TEXT_TERMINATION_FAILED');
  assert.equal(f.workers.length,1);assert.equal(f.textMemory.snapshot.textBytes,held);assert.equal(run.renderer.lifecycle.uncertainBytes,held);
  assert.equal(f.diagnostics.diagnosticState(),1);run.worker.terminateFailure=undefined;run.renderer.dispose();
  assert.equal(run.worker.terminations,2);assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
});

test('worker error releases the full job and engine after successful public termination',async t=>{
  const f=await clientFixture(t),run=await f.start();let prevented=0;
  assert.equal(f.textMemory.snapshot.textBytes,f.engineResidentBytes+run.plan.bytes);
  run.worker.onerror({preventDefault(){prevented++;}});
  await assert.rejects(run.work,error=>error?.code==='TEXT_WORKER_FAILURE');
  assert.equal(prevented,1);assert.equal(run.worker.terminations,1);assert.deepEqual(f.textMemory.snapshot,zero);
  assert.equal(f.diagnostics.diagnosticState(),0);assert.equal(run.renderer.lifecycle.uncertainBytes,0);
  run.renderer.dispose();assert.equal(run.worker.terminations,1);
});

test('fatal reply with a failed terminate retains full ownership until public dispose retries successfully',async t=>{
  const f=await clientFixture(t),run=await f.start(),held=f.engineResidentBytes+run.plan.bytes;
  run.worker.terminateFailure=Error('native termination refused');run.worker.emit({ok:false,fatal:true,code:'TEXT_WORKER_FAILURE'});
  await assert.rejects(run.work,error=>error?.code==='TEXT_TERMINATION_FAILED');
  assert.equal(run.worker.terminations,1);assert.equal(f.textMemory.snapshot.textBytes,held);
  assert.equal(run.renderer.lifecycle.uncertainBytes,held);assert.equal(f.diagnostics.diagnosticState(),1);
  run.worker.terminateFailure=undefined;run.renderer.dispose();
  assert.equal(run.worker.terminations,2);assert.equal(run.renderer.lifecycle.uncertainBytes,0);
  assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
});

test('synthetic Object.freeze failure before adoption releases the job without creating output ownership',async t=>{
  const f=await clientFixture(t),run=await f.start(),result=resultFor(f,run),failure=Error('injected freeze failure'),freeze=Object.freeze;
  // Explicit synchronous fault injection into the real freezing path. A worker
  // structured clone does not carry accessors; no such message is fabricated.
  // This checks cleanup only, not whether a browser naturally throws here.
  Object.freeze=value=>{if(value===result.token){assert.equal(f.textMemory.snapshot.textBytes,f.engineResidentBytes+run.plan.bytes);throw failure;}return freeze(value);};
  try{run.worker.emit({ok:true,value:result});}finally{Object.freeze=freeze;}
  await assert.rejects(run.work,error=>error===failure);assert.equal(f.textMemory.snapshot.textBytes,f.engineResidentBytes);
  run.renderer.dispose();assert.deepEqual(f.textMemory.snapshot,zero);assert.equal(f.diagnostics.diagnosticState(),0);
});

async function canvasFixture(t){
  const url=await moduleURL(resolve(newSourceRoot,'src/ui/native-text-preview.ts'),{},String(++serial));
  const {paintTextPreview}=await import(url),previous=globalThis.ImageData;let imageFailure;
  class ImageDataDouble{
    constructor(pixels,width,height){if(imageFailure)throw imageFailure;this.data=pixels;this.width=width;this.height=height;}
  }
  globalThis.ImageData=ImageDataDouble;
  t.after(()=>{if(previous===undefined)delete globalThis.ImageData;else globalThis.ImageData=previous;});
  return {paintTextPreview,set imageFailure(error){imageFailure=error;}};
}
function preview(width,height){return {width,height,pixels:new Uint8ClampedArray(width*height*4)};}
function canvasBoundary(width=0,height=0,failure){
  const assignments=[],extents=[],painted=[],calls=[],error=Error('canvas boundary failure');
  const canvas={
    get width(){return width;},set width(value){assignments.push(['width',value]);if(failure==='width-final'&&value!==0)throw error;width=value;extents.push({width,height,bytes:width*height*4});},
    get height(){return height;},set height(value){assignments.push(['height',value]);if(failure==='height')throw error;height=value;extents.push({width,height,bytes:width*height*4});},
    getContext(kind){calls.push(kind);if(failure==='context-throw')throw error;if(failure==='context-null')return null;return {putImageData(image,x,y){if(failure==='putImageData')throw error;painted.push({image,x,y});}};},
  };
  return {canvas,assignments,extents,painted,calls,error};
}

test('an initially empty preview passes the admitted pixel view directly for the smallest frame',async t=>{
  const f=await canvasFixture(t),boundary=canvasBoundary(),value=preview(1,1);f.paintTextPreview(boundary.canvas,value);
  assert.deepEqual(boundary.assignments,[['width',0],['height',1],['width',1]]);
  assert.deepEqual(boundary.extents.map(row=>row.bytes),[0,0,4]);assert.deepEqual(boundary.calls,['2d']);
  assert.equal(boundary.painted.length,1);assert.equal(boundary.painted[0].image.data,value.pixels);
  assert.deepEqual([boundary.painted[0].image.width,boundary.painted[0].image.height,boundary.painted[0].x,boundary.painted[0].y],[1,1,0,0]);
});

test('default 300 by 150 canvas backing cannot multiply a short preview into an oversized intermediate',async t=>{
  const f=await canvasFixture(t),boundary=canvasBoundary(300,150),value=preview(1200,1);f.paintTextPreview(boundary.canvas,value);
  assert.deepEqual(boundary.extents,[{width:0,height:150,bytes:0},{width:0,height:1,bytes:0},{width:1200,height:1,bytes:4800}]);
  assert(boundary.extents.every(row=>row.bytes<=value.pixels.byteLength));assert.equal(boundary.painted.length,1);
});

test('repainting a taller old surface keeps every new intermediate within the final extent',async t=>{
  const f=await canvasFixture(t),boundary=canvasBoundary(100,700);
  for(const value of [preview(800,2),preview(1,1)]){
    const from=boundary.extents.length;f.paintTextPreview(boundary.canvas,value);
    assert(boundary.extents.slice(from).every(row=>row.bytes<=value.pixels.byteLength));
    assert.deepEqual([boundary.canvas.width,boundary.canvas.height],[value.width,value.height]);
  }
  assert.equal(boundary.painted.length,2);
});

test('invalid preview dimensions or pixel lengths reject before touching the canvas',async t=>{
  const f=await canvasFixture(t);
  for(const value of [
    {width:0,height:1,pixels:new Uint8ClampedArray(0)},
    {width:1,height:-1,pixels:new Uint8ClampedArray(0)},
    {width:0.5,height:2,pixels:new Uint8ClampedArray(4)},
    {width:NaN,height:1,pixels:new Uint8ClampedArray(0)},
    {width:1,height:Infinity,pixels:new Uint8ClampedArray(0)},
    {width:Number.MAX_SAFE_INTEGER,height:2,pixels:new Uint8ClampedArray(0)},
    {width:2,height:1,pixels:new Uint8ClampedArray(7)},
    {width:2,height:1,pixels:new Uint8ClampedArray(9)},
  ]){
    const boundary=canvasBoundary(300,150);assert.throws(()=>f.paintTextPreview(boundary.canvas,value),/TEXT_PREVIEW_DIMENSIONS/);
    assert.deepEqual(boundary.assignments,[]);assert.deepEqual(boundary.calls,[]);assert.deepEqual([boundary.canvas.width,boundary.canvas.height],[300,150]);
  }
});

test('dimension setter failures propagate with zero extent and preserve the caller reservation',async t=>{
  const f=await canvasFixture(t),{textMemory:pool}=await poolFixture(),value=preview(800,1),lease=pool.reserve(value.pixels.byteLength);
  try{
    for(const failure of ['height','width-final']){
      const boundary=canvasBoundary(300,150,failure);assert.throws(()=>f.paintTextPreview(boundary.canvas,value),error=>error===boundary.error);
      assert.equal(boundary.canvas.width*boundary.canvas.height,0);assert(boundary.extents.every(row=>row.bytes===0));
      assert.equal(pool.snapshot.textBytes,value.pixels.byteLength);assert.deepEqual(boundary.calls,[]);
    }
  }finally{lease.release();}assert.deepEqual(pool.snapshot,zero);
});

test('context, ImageData, and paint failures preserve the final extent and external ownership',async t=>{
  const f=await canvasFixture(t),{textMemory:pool}=await poolFixture(),value=preview(800,1),lease=pool.reserve(value.pixels.byteLength),imageError=Error('ImageData refused');
  try{
    for(const failure of ['context-throw','context-null','image-data','putImageData']){
      const boundary=canvasBoundary(300,150,failure);f.imageFailure=failure==='image-data'?imageError:undefined;
      assert.throws(()=>f.paintTextPreview(boundary.canvas,value),error=>failure==='context-null'?error.message==='TEXT_PREVIEW_CONTEXT_UNAVAILABLE':error===(failure==='image-data'?imageError:boundary.error));
      assert.deepEqual([boundary.canvas.width,boundary.canvas.height],[800,1]);assert(boundary.extents.every(row=>row.bytes<=value.pixels.byteLength));
      assert.equal(pool.snapshot.textBytes,value.pixels.byteLength);assert.deepEqual(boundary.painted,[]);
    }
  }finally{lease.release();}assert.deepEqual(pool.snapshot,zero);
});

test('the product preview template explicitly starts with zero dimensions (source contract only)',async()=>{
  const source=await readFile(resolve(sourceRoot,'src/ui/native-text.ts'),'utf8');
  const tag=source.match(/<canvas\b[^>]*\bid="native-text-preview"[^>]*>/g);
  assert.equal(tag?.length,1);assert.match(tag[0],/\bwidth="0"/);assert.match(tag[0],/\bheight="0"/);
});

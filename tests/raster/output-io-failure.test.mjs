import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import{Worker}from'node:worker_threads';
import{createHash}from'node:crypto';
import{fileURLToPath}from'node:url';
import{join}from'node:path';
import{rootFor}from'../store/helpers.mjs';
import{rasterFailure}from'../../dist/local/server/raster/failure.js';
import{allocationLedger}from'../../dist/local/src/observability/allocations.js';
import{RASTER_DIAGNOSTIC_BYTES,RASTER_DIAGNOSTIC_HANDLES}from'../../dist/local/server/observability/diagnostic-memory.js';
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
test('real raster output open and delayed fsync failures remain resource failures after native decode',async t=>{
 const bytes=await readFile(new URL('./fixtures/white-lossy.webp',import.meta.url));
 for(const[code,boundary]of[['ENOSPC','open'],['EDQUOT','fsync'],['EIO','fsync']]){
  const root=await rootFor(t),input=join(root,'source.webp');await writeFile(input,bytes,{mode:0o600});
  const grant=allocationLedger.reserve({owner:'diagnostic-raster-fixture',kind:'control',cpuBytes:RASTER_DIAGNOSTIC_BYTES,handles:RASTER_DIAGNOSTIC_HANDLES});
  const messages=[];let worker,exited=false,exitPromise,workerError,cleanupPromise;
  const cleanup=()=>cleanupPromise??=(async()=>{
   // Cancellation, timeout and ordinary completion share one native drain.
   try{if(worker&&!exited)await worker.terminate();}
   finally{if(worker)await exitPromise;messages.length=0;grant.release();}
  })();
  t.after(cleanup);
  try{
   worker=new Worker(new URL('../../dist/local/server/raster/worker.js',import.meta.url),{workerData:{type:'decode',diagnosticBytes:RASTER_DIAGNOSTIC_BYTES,directory:root,path:input,mediaType:'image/webp',sourceAssetId:'fixture',original:{hash:digest(bytes),byteLength:String(bytes.length),mediaType:'image/webp'}},env:{IE_TEST_OUTPUT_CODE:code,IE_TEST_OUTPUT_BOUNDARY:boundary},execArgv:['--import',fileURLToPath(new URL('../session/no-egress.mjs',import.meta.url)),'--import',fileURLToPath(new URL('./output-io-fault.mjs',import.meta.url))]});
   exitPromise=new Promise(resolve=>{worker.once('exit',code=>{exited=true;resolve(code);});});
   worker.once('error',error=>{workerError=error;});
   worker.on('message',message=>{try{messages.push(message);if(message.type==='plan')worker.postMessage({type:'admit'});}catch(error){workerError??=error;void worker.terminate().catch(error=>{workerError??=error;});}});
   const exit=await exitPromise;
   if(workerError)throw workerError;
   assert.equal(exit,0);assert.equal(messages.filter(m=>m.type==='plan').length,1);assert.equal(messages.some(m=>m.type==='result'),false);assert.equal(messages.find(m=>m.type==='failure')?.code,'RASTER_RESOURCES',code+' '+boundary);assert.deepEqual(await readFile(input),bytes);
   if(boundary==='fsync')assert.equal((await readFile(join(root,'pixels.rgba'))).length,16*16*4,'native bytes reached durability boundary before injected failure');
  }finally{
   // A thrown constructor owns no native worker. After creation, neither an
   // error event nor a termination request proves the reservation can end.
   await cleanup();
  }
 }
});
test('resource failure classification preserves explicit decoder errors and retained mapping evidence',()=>{
 assert.deepEqual(rasterFailure(Error('RASTER_PROFILE')),{code:'RASTER_PROFILE'});
 assert.deepEqual(rasterFailure(Error('RASTER_INPUT_CHANGED')),{code:'RASTER_INPUT_CHANGED'});
 assert.deepEqual(rasterFailure(Object.assign(Error('RASTER_RESOURCES'),{rasterResourceFailure:{outputPeak:16384,outputRemaining:16384}})),{code:'RASTER_RESOURCES',resourceFailure:{outputPeak:16384,outputRemaining:16384}});
 assert.equal(rasterFailure(Object.assign(Error('RASTER_PROFILE'),{rasterResourceFailure:{outputPeak:Infinity,outputRemaining:1}})).code,'RASTER_PROFILE');
});

test('V45 homogeneous-mask reason crosses the worker boundary without widening numeric error codes',()=>{
 const code='RASTER_V45_EDIT_MASK_HOMOGENEOUS';
 assert.deepEqual(rasterFailure(Error(code)),{code});
 for(const message of ['RASTER_V45_EDIT_MASK_OTHER','RASTER_V46_EDIT_MASK_HOMOGENEOUS','RASTER_45','RASTER_V45_EDIT_MASK_HOMOGENEOUS: private detail','RASTER_V45_EDIT_MASK_HOMOGENEOUS\n'])assert.deepEqual(rasterFailure(Error(message)),{code:'RASTER_DECODE'},message);
 assert.deepEqual(rasterFailure({message:code}),{code:'RASTER_DECODE'});
 assert.deepEqual(rasterFailure(Object.assign(Error(code),{code:'ENOSPC'})),{code:'RASTER_RESOURCES'});
 assert.deepEqual(rasterFailure(Object.assign(Error(code),{rasterResourceFailure:{outputPeak:8192,outputRemaining:4096}})),{code:'RASTER_RESOURCES',resourceFailure:{outputPeak:8192,outputRemaining:4096}});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import{Worker}from'node:worker_threads';
import{createHash}from'node:crypto';
import{fileURLToPath}from'node:url';
import{join}from'node:path';
import{rootFor}from'../store/helpers.mjs';
import{rasterFailure}from'../../dist/local/server/raster/failure.js';
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
test('real raster output open and delayed fsync failures remain resource failures after native decode',async t=>{
 const bytes=await readFile(new URL('./fixtures/white-lossy.webp',import.meta.url));
 for(const[code,boundary]of[['ENOSPC','open'],['EDQUOT','fsync'],['EIO','fsync']]){
  const root=await rootFor(t),input=join(root,'source.webp');await writeFile(input,bytes,{mode:0o600});
  const messages=[],worker=new Worker(new URL('../../dist/local/server/raster/worker.js',import.meta.url),{workerData:{type:'decode',directory:root,path:input,mediaType:'image/webp',sourceAssetId:'fixture',original:{hash:digest(bytes),byteLength:String(bytes.length),mediaType:'image/webp'}},env:{IE_TEST_OUTPUT_CODE:code,IE_TEST_OUTPUT_BOUNDARY:boundary},execArgv:['--import',fileURLToPath(new URL('../session/no-egress.mjs',import.meta.url)),'--import',fileURLToPath(new URL('./output-io-fault.mjs',import.meta.url))]});
  t.after(()=>worker.terminate());
  const exit=await new Promise((resolve,reject)=>{worker.on('message',message=>{messages.push(message);if(message.type==='plan')worker.postMessage({type:'admit'});});worker.once('error',reject);worker.once('exit',resolve);});
  assert.equal(exit,0);assert.equal(messages.filter(m=>m.type==='plan').length,1);assert.equal(messages.some(m=>m.type==='result'),false);assert.equal(messages.find(m=>m.type==='failure')?.code,'RASTER_RESOURCES',code+' '+boundary);assert.deepEqual(await readFile(input),bytes);
  if(boundary==='fsync')assert.equal((await readFile(join(root,'pixels.rgba'))).length,16*16*4,'native bytes reached durability boundary before injected failure');
 }
});
test('resource failure classification preserves explicit decoder errors and retained mapping evidence',()=>{
 assert.deepEqual(rasterFailure(Error('RASTER_PROFILE')),{code:'RASTER_PROFILE'});
 assert.deepEqual(rasterFailure(Error('RASTER_INPUT_CHANGED')),{code:'RASTER_INPUT_CHANGED'});
 assert.deepEqual(rasterFailure(Object.assign(Error('RASTER_RESOURCES'),{rasterResourceFailure:{outputPeak:16384,outputRemaining:16384}})),{code:'RASTER_RESOURCES',resourceFailure:{outputPeak:16384,outputRemaining:16384}});
 assert.equal(rasterFailure(Object.assign(Error('RASTER_PROFILE'),{rasterResourceFailure:{outputPeak:Infinity,outputRemaining:1}})).code,'RASTER_PROFILE');
});

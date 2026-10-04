import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {rootFor,zeroEffects} from './helpers.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t,mode){
 const root=await rootFor(t),effects=globalThis.__storeNetworkCounters;assert(effects,'Use the existing store no-network preload');
 const gate=new Int32Array(new SharedArrayBuffer(4)),entered=deferred(),failures=[],setup=new URL('./fixture-close-phases.mjs',import.meta.url);setup.searchParams.set('mode',mode);
 const writer=await openWriter({root},{effectCounters:effects.shared,gate:gate.buffer,setupModule:setup.href,onBarrier:phase=>{assert.equal(phase,'fixture-after-drain');entered.resolve();},onFailure:value=>failures.push(value)});
 const release=()=>{Atomics.store(gate,0,1);Atomics.notify(gate,0);};
 t.after(async()=>{release();await writer.close();assert.deepEqual(effects.read(),zeroEffects);});
 return {writer,entered,release,failures,read:async()=>JSON.parse(await readFile(join(root,'fixture-close-phases.json'),'utf8'))};
}
const drained=['fixture-stop','histories:start','histories:end','rasters:start','rasters:end','assets:start','assets:end'];

test('actual writer waits for post-drain fixture verification before database close and native acknowledgement',async t=>{
 const f=await fixture(t,'hold');let settled=false;const closing=f.writer.close();void closing.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await Promise.race([f.entered.promise,closing.then(()=>{throw Error('Writer acknowledged without reaching the held verification');})]);
  const held=await f.read();assert.deepEqual(held.order,[...drained,'fixture-verify']);assert.equal(settled,false);
  assert.deepEqual(held.resources.objects,{reservedBytes:'0',activeTransfers:0});assert.equal(held.resources.raster.activeWorkers,0);assert.equal(held.resources.raster.reservedCPU,0);assert.equal(held.resources.raster.workerService.closed,true);assert.equal(held.resources.raster.workerService.workerCount,0);assert.deepEqual(held.effects,zeroEffects);
 }finally{f.release();await closing;}
 const final=await f.read();assert.deepEqual(final.order,[...drained,'fixture-verify','fixture-verified','database-close']);assert.deepEqual(f.failures,[]);
});

test('actual writer preserves the existing callable-only fixture close contract',async t=>{
 const f=await fixture(t,'legacy');await f.writer.close();const result=await f.read();assert.deepEqual(result.order,[...drained,'database-close']);assert.equal(result.resources,null);assert.deepEqual(f.failures,[]);assert.deepEqual(result.effects,zeroEffects);
});

for(const [mode,order]of [
 ['pre-failure',['fixture-stop']],
 ['drain-failure',['fixture-stop','histories:start','histories:end']],
 ['post-failure',[...drained,'fixture-verify']],
])test('actual writer preserves '+mode+' without successful close acknowledgement',async t=>{
 const f=await fixture(t,mode);await assert.rejects(f.writer.close(),{code:'STORAGE_FAILURE'});
 const result=await f.read();assert.deepEqual(result.order,order);assert.equal(result.order.includes('database-close'),false);assert.deepEqual(f.failures,[{code:'ERR_ASSERTION',sqliteCode:undefined}]);assert.deepEqual(result.effects,zeroEffects);
});

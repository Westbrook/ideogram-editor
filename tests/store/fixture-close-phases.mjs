// Internal worker fixture. Observe actual drains; never replace their work.
import assert from 'node:assert/strict';
import {writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {parentPort,workerData} from 'node:worker_threads';
import {fixtureClosureResources,assertFixtureClosure} from '../request-edits/fixture-closure.mjs';

export async function setup(store){
 const mode=new URL(import.meta.url).searchParams.get('mode');assert(['hold','legacy','pre-failure','post-failure','drain-failure'].includes(mode));
 const effects=globalThis.__storeNetworkCounters;assert(effects,'The store guard must reach the actual writer');
 const path=join(store.root,'fixture-close-phases.json'),order=[];let resources=null;
 const save=()=>{writeFileSync(path+'.tmp',JSON.stringify({mode,order,resources,effects:effects.read()}),{mode:0o600});renameSync(path+'.tmp',path);};
 for(const name of ['histories','rasters','assets']){
  const original=store[name].close.bind(store[name]);
  store[name].close=async()=>{order.push(name+':start');save();const value=await original();order.push(name+':end');save();if(mode==='drain-failure'&&name==='histories')assert.fail('Retained actual-drain failure');return value;};
 }
 const databaseClose=store.close.bind(store);store.close=()=>{order.push('database-close');save();return databaseClose();};
 const close=async()=>{order.push('fixture-stop');save();if(mode==='pre-failure')assert.fail('Retained fixture-stop failure');};
 if(mode!=='legacy')close.afterStoreDrain=async()=>{
  order.push('fixture-verify');resources=fixtureClosureResources(store,{listening:false,sockets:0,pending:false});save();
  assertFixtureClosure(resources,[],[]);assert.equal(resources.raster.workerService.closed,true);assert.equal(resources.raster.workerService.workerCount,0);
  if(mode==='post-failure')assert.fail('Retained post-drain verification failure');
  if(mode==='hold'){parentPort.postMessage({type:'barrier',phase:'fixture-after-drain'});await Atomics.waitAsync(new Int32Array(workerData.testing.gate),0,0).value;}
  order.push('fixture-verified');save();
 };
 save();return close;
}

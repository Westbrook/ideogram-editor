// Test-only scheduler. It never constructs a production provider capability.
// The browser drives all product mutations through public controls. The control
// file only admits explicit fixture jobs to the real dispatcher.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {emulator,fixtureProfile,SENTINEL_KEY,SENTINEL_COOKIE} from '../provider/emulator.mjs';
import {egressAttempts} from '../provider/no-egress.mjs';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {ResultObserver} from '../../dist/local/server/provider/observer.js';

export async function setup(store){
  const controlPath=join(store.root,'axe-populated-control.json');
  const initial=JSON.parse(readFileSync(controlPath,'utf8'));
  const origin=new URL(initial.origin);
  assert.equal(origin.hostname,'127.0.0.1');
  assert.equal(origin.protocol,'http:');
  assert.equal(origin.origin,initial.origin);
  const profile=fixtureProfile({id:'local-axe-populated-base-v1'});
  const provider=emulator({queueOrigin:origin.origin,mediaOrigin:origin.origin,profiles:[profile]});
  const dispatcher=new QueueDispatcher(store.queue,provider,{queueOrigin:origin.origin,profileId:profile.id});
  const observer=new ResultObserver(store.candidates,provider,dispatcher,profile.id,[SENTINEL_KEY,SENTINEL_COOKIE]);
  const errors=[];let closing=false,pending;
  const save=extra=>{
    const file=join(store.root,'axe-populated-observer.json');
    writeFileSync(file+'.tmp',JSON.stringify({errors,egressAttempts:egressAttempts(),...extra},null,2),{mode:0o600});
    renameSync(file+'.tmp',file);
  };
  const timer=setInterval(()=>{
    if(closing||pending)return;
    pending=(async()=>{
      const control=JSON.parse(readFileSync(controlPath,'utf8'));
      assert.equal(control.origin,origin.origin);
      assert(Array.isArray(control.dispatchJobs));
      for(const job of store.queue.view().jobs){
        if(closing)break;
        if(control.dispatchJobs.includes(job.id)&&job.review.endpoint==='ideogram/v4'&&job.attempts.at(-1).state==='not-started')await dispatcher.submit(job.id);
      }
      await observer.tick();
    })().catch(error=>{errors.push({name:error.name,message:error.message,stack:error.stack});closing=true;clearInterval(timer);save({closed:false});}).finally(()=>{pending=undefined;});
  },100);
  save({closed:false});
  return async()=>{
    closing=true;clearInterval(timer);observer.close();dispatcher.close();await pending;
    const rasterRead=store.rasters.readDiagnostics();try{const resources={objects:store.objects.reservationInventory(),raster:rasterRead.value,text:{reservedCPU:store.texts.reservedCPU,externalBytes:store.texts.externalBytes()}};
    save({closed:true,resources});
    assert.deepEqual(errors,[]);assert.deepEqual(egressAttempts(),[]);
    assert.equal(resources.objects.activeTransfers,0);assert.equal(resources.objects.reservedBytes,'0');
    assert.equal(resources.raster.activeWorkers,0);assert.equal(resources.raster.reservedCPU,0);
    }finally{rasterRead.release();}
  };
}

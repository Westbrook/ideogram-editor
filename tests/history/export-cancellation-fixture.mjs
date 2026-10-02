// Internal writer injection only. Pause real work without blocking the writer's
// message loop; the production cancellation RPC must settle the original command.
import { Worker } from 'node:worker_threads';
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';

export async function setup(store) {
  const config=JSON.parse(await readFile(join(store.root,'export-cancellation-control.json'),'utf8'));
  const reached=join(store.root,'export-cancellation-reached.json'),release=join(store.root,'export-cancellation-release');
  const prepare=store.rasters.prepareDocument.bind(store.rasters),postMessage=Worker.prototype.postMessage;
  let used=false,closed=false;
  const mark=async value=>{await writeFile(reached+'.tmp',JSON.stringify(value),{mode:0o600});await rename(reached+'.tmp',reached);};
  const released=async()=>{try{await access(release);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  async function wait(done=()=>false){const deadline=Date.now()+15000;while(!closed&&!done()&&!await released()){if(Date.now()>=deadline)throw Error('Export cancellation fixture release timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
  store.rasters.prepareDocument=async(...args)=>{
    const result=await prepare(...args);
    if(!used&&config.phase==='after-proofs'&&args[0].type==='ExportRaster'&&args[2]==='history:'+config.commandId){used=true;await mark({phase:'after-proofs',commandId:config.commandId,assetId:result.asset.id,proofCount:result.proofs.length});await wait();}
    return result;
  };
  Worker.prototype.postMessage=function(message,...args){
    if(!used&&config.phase==='worker-admission'&&message?.type==='admit'){
      // Bind the real admission to the current owner service; the old Rasters
      // worker/workerSlot fields no longer exist with persistent worker reuse.
      const state=store.rasters.rasterWorkerState();
      if(state.activeJobs===1&&state.slot==='history:'+config.commandId&&state.identity?.threadId===this.threadId&&state.identity?.generation===message.generation&&Number.isSafeInteger(message.jobId)&&message.jobId>0){
        used=true;const worker=this;let exited=false;worker.once('exit',()=>{exited=true;});
        void mark({phase:'worker-admission',commandId:config.commandId,slot:state.slot,generation:message.generation,jobId:message.jobId,threadId:worker.threadId}).then(()=>wait(()=>exited)).then(()=>{if(!closed&&!exited)postMessage.call(worker,message,...args);}).catch(()=>{if(!exited)void worker.terminate();});
        return;
      }
    }
    return postMessage.call(this,message,...args);
  };
  return async()=>{closed=true;store.rasters.prepareDocument=prepare;Worker.prototype.postMessage=postMessage;};
}

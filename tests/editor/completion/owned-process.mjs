import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// The same parent path is used by the real fixture and finite stub controls.
export async function ownServerProcess(child,{completion=false,timeout=15000}={}) {
  const messages=new Map(),waiters=new Map(),lifecycle={pid:child.pid,attempts:[],errors:[],messages:[],exit:null};
  let stderr='',disconnected=false,spawnError;
  child.stderr?.on('data',b=>stderr+=b);
  const rejectAll=error=>{for(const w of waiters.values())w.reject(error);waiters.clear();};
  child.on('message',m=>{lifecycle.messages.push(structuredClone(m));const w=waiters.get(m.type);if(w){waiters.delete(m.type);w.resolve(m);}else messages.set(m.type,m);});
  child.on('error',error=>{spawnError=error;lifecycle.errors.push({phase:'process-error',error:String(error)});rejectAll(error);});
  child.on('disconnect',()=>{disconnected=true;rejectAll(Error('Owned child IPC disconnected'));});
  child.on('exit',(code,signal)=>{lifecycle.exit={pid:child.pid,code,signal,at:new Date().toISOString()};rejectAll(Error('Owned child exited before reply'));});
  const wait=kind=>{if(messages.has(kind)){const m=messages.get(kind);messages.delete(kind);return Promise.resolve(m);}if(spawnError||disconnected||lifecycle.exit)return Promise.reject(spawnError??Error('Owned child is unavailable: '+kind));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(kind);reject(Error('Owned child response deadline: '+kind+' '+stderr));},timeout);waiters.set(kind,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});});};
  const send=async(message,kind)=>{const pending=wait(kind);try{child.send(message,error=>{if(error){const w=waiters.get(kind);waiters.delete(kind);w?.reject(error);}});}catch(error){const w=waiters.get(kind);waiters.delete(kind);w?.reject(error);}return pending;};
  const exit=async()=>{if(lifecycle.exit)return lifecycle.exit;return await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);child.off('exit',done);resolve(lifecycle.exit);};const timer=setTimeout(()=>{child.off('exit',done);reject(Error('Owned child exit deadline'));},timeout);child.once('exit',done);});};
  const alive=()=>!lifecycle.exit&&child.exitCode===null&&child.signalCode===null;
  const host=async(method,args={})=>{assert(completion);const reply='host-'+randomUUID(),r=await send({type:'host',method,args,reply},reply);if(r.error)throw Error(r.error.message+'\n'+r.error.stack);return r.value;};
  const attempt=async(phase,fn)=>{const row={phase,at:new Date().toISOString()};lifecycle.attempts.push(row);try{const value=await fn();row.passed=true;return value;}catch(error){row.error=String(error);lifecycle.errors.push({phase,error:String(error)});return undefined;}};
  let shutdown;
  async function close({cleanupOnly=false,mode='close'}={}) {
    assert(!shutdown,'Only one owned shutdown path');shutdown={mode,cleanupOnly,errors:lifecycle.errors,attempts:lifecycle.attempts,exit:null};
    // Correlation is distinct from the child's semantic close/refusal type.
    const completionRequest=async cleanup=>{
      const reply='close-'+randomUUID(),envelope=await send({type:'completion-close',reply,cleanupOnly:cleanup,mode:cleanup?'close':mode},reply),r=envelope.value;
      shutdown.reply=r;assert(r,'Owned close reply');assert.equal(r.type,'completion-closed','Normal refusal is not closure');assert.deepEqual(r.failures,[],'Child close failures retained');return r;
    };
    if(alive()) {
      if(completion){
        let primary;
        try{if(!cleanupOnly)await host('assertDrained');await completionRequest(cleanupOnly);}catch(error){primary=error;lifecycle.errors.push({phase:'primary-close',error:String(error)});}
        if(primary&&!cleanupOnly&&alive())await attempt('cleanup-only-close',()=>completionRequest(true));
      }else if(mode==='restart')await attempt('legacy-abrupt-restart',async()=>{assert(child.kill('SIGKILL'));});
      else await attempt('legacy-close',async()=>{child.send('close');});
      await attempt('bounded-exit',exit);
      if(alive())await attempt('owned-kill',async()=>{assert(Number.isInteger(child.pid)&&child.pid>0);const accepted=child.kill('SIGKILL');assert(accepted);await exit();});
    }
    shutdown.exit=lifecycle.exit;shutdown.stderr=stderr;
    if(!shutdown.exit)lifecycle.errors.push({phase:'missing-exit',error:'Owned child exit unobserved'});
    if(mode!=='restart'&&shutdown.exit&&(shutdown.exit.code!==0||shutdown.exit.signal!==null))lifecycle.errors.push({phase:'unsuccessful-exit',error:JSON.stringify(shutdown.exit)});
    if(mode==='restart'&&shutdown.exit?.signal!=='SIGKILL')lifecycle.errors.push({phase:'restart-exit',error:JSON.stringify(shutdown.exit)});
    if(lifecycle.errors.length)throw Object.assign(new AggregateError(lifecycle.errors.map(e=>Error(e.phase+': '+e.error)),'Owned process shutdown failures'),{lifecycle,shutdown});
  }
  let ready;
  try{ready=await wait('ready');assert.equal(typeof ready.origin,'string');}
  catch(error){const errors=[error];try{await close({cleanupOnly:true});}catch(cleanup){errors.push(cleanup);}throw Object.assign(new AggregateError(errors,'Owned server readiness and cleanup'),{lifecycle,shutdown});}
  return {origin:ready.origin,instance:ready.instance,pid:child.pid,host,lifecycle,get shutdown(){return shutdown;},
    pair:async()=>(await send('pair','pair')).url,
    recorder:async()=>(await send('recorder','recorder')).value,
    resources:async()=>(await send('resources','resources')).value,
    effects:async()=>(await send('effects','effects')).value,
    close,kill:()=>close({mode:'restart'}),
  };
}

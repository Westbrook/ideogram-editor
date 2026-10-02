import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The portable child helper intentionally forbids provider effects. These two
// authoring phases instead inherit the existing literal-loopback preload into
// the backend and its writer/workers, exactly as the history runner does.
export async function providerChild(root,ownClose,entryModuleURL=new URL('./candidate-copy-process-fixture.mjs',import.meta.url)){
  const child=fork(fileURLToPath(entryModuleURL),[root],{
    execArgv:['--import',fileURLToPath(new URL('../session/no-egress.mjs',import.meta.url))],
    env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc'],
  });
  const queued=new Map(),waiting=new Map();let stderr='',ended=null,failure=null,closing;
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-65536);});
  const rejectWaiting=error=>{for(const waiter of waiting.values())waiter.reject(error);waiting.clear();};
  const fail=error=>{failure??=error;rejectWaiting(failure);};
  const exit=new Promise(resolve=>{
    child.once('close',(code,signal)=>{ended={code,signal};rejectWaiting(new Error('Candidate-copy child exited: '+JSON.stringify(ended)+' '+stderr));resolve(ended);});
  });
  child.on('error',fail);
  child.on('message',message=>{
    if(message?.type==='failure'){fail(new Error('Candidate-copy child shutdown failed: '+message.message));return;}
    if(message?.type!=='ready'&&message?.type!=='closed'){fail(new Error('Unexpected candidate-copy child response'));return;}
    const waiter=waiting.get(message.type);
    if(waiter){waiting.delete(message.type);waiter.resolve(message);}else queued.set(message.type,message);
  });
  const wait=type=>{
    if(failure)return Promise.reject(failure);
    if(queued.has(type)){const value=queued.get(type);queued.delete(type);return Promise.resolve(value);}
    if(ended)return Promise.reject(new Error('Candidate-copy child exited before '+type+': '+JSON.stringify(ended)+' '+stderr));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiting.delete(type);reject(new Error('Candidate-copy child control timeout: '+type+' '+stderr));},10000);
      waiting.set(type,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    });
  };
  const close=()=>closing??=(async()=>{
    try{
      if(!ended){
        const closed=wait('closed');
        if(child.connected)child.send('close',error=>{if(error)fail(error);});
        else fail(new Error('Candidate-copy child disconnected before graceful close'));
        await closed;
        let timer;
        try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Candidate-copy child did not exit after close')),10000);})]);}
        finally{clearTimeout(timer);}
      }
      if(failure)throw failure;
      assert.equal(ended.code,0,stderr);assert.equal(ended.signal,null,stderr);
    }catch(error){
      // Failure cleanup only; normal lifecycle awaits the real server.close()
      // and provider diagnostics before observing a clean process exit.
      if(!ended){child.kill('SIGKILL');await exit;}
      throw error;
    }
  })();
  ownClose(close);
  const ready=await wait('ready');assert.notEqual(child.pid,process.pid);
  return {origin:ready.origin,issuePairingURL:()=>ready.pairingURL,close};
}

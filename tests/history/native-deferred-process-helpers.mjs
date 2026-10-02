import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Dedicated native fixture control preserves the ordinary providerChild's
// guarded fork/close/exit lifecycle; only fresh owner-issued pairing is added.
export async function nativeDeferredChild(root,ownClose){
  const entryModuleURL=new URL('./native-deferred-process-fixture.mjs',import.meta.url);
  const child=fork(fileURLToPath(entryModuleURL),[root],{
    execArgv:['--import',fileURLToPath(new URL('../session/no-egress.mjs',import.meta.url))],
    env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc'],
  });
  const queued=new Map(),waiting=new Map();let stderr='',ended=null,failure=null,closing,origin,pairingURL,pairingSerial=0,pendingPairing=0;
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-65536);});
  const rejectWaiting=error=>{for(const waiter of waiting.values())waiter.reject(error);waiting.clear();};
  const fail=error=>{failure??=error;rejectWaiting(failure);};
  const exit=new Promise(resolve=>{
    child.once('close',(code,signal)=>{ended={code,signal};rejectWaiting(new Error('Native-deferred child exited: '+JSON.stringify(ended)+' '+stderr));resolve(ended);});
  });
  child.on('error',fail);
  child.on('message',message=>{
    if(message?.type==='failure'){fail(new Error('Native-deferred child shutdown failed: '+message.message));return;}
    if(message?.type==='paired'){
      const prefix=origin+'/#pairing=';
      if(!pendingPairing||!waiting.has('paired')||message.serial!==pendingPairing||typeof message.pairingURL!=='string'||message.pairingURL===pairingURL||!message.pairingURL.startsWith(prefix)||!/^[A-Za-z0-9_-]{43}$/.test(message.pairingURL.slice(prefix.length))){fail(new Error('Invalid native-deferred pairing response'));return;}
    }else if(message?.type!=='ready'&&message?.type!=='closed'){fail(new Error('Unexpected native-deferred child response'));return;}
    const waiter=waiting.get(message.type);
    if(waiter){waiting.delete(message.type);waiter.resolve(message);}else queued.set(message.type,message);
  });
  const wait=type=>{
    if(failure)return Promise.reject(failure);
    if(queued.has(type)){const value=queued.get(type);queued.delete(type);return Promise.resolve(value);}
    if(ended)return Promise.reject(new Error('Native-deferred child exited before '+type+': '+JSON.stringify(ended)+' '+stderr));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiting.delete(type);reject(new Error('Native-deferred child control timeout: '+type+' '+stderr));},10000);
      waiting.set(type,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    });
  };
  const close=()=>closing??=(async()=>{
    try{
      if(!ended){
        const closed=wait('closed');
        if(child.connected)child.send('close',error=>{if(error)fail(error);});
        else fail(new Error('Native-deferred child disconnected before graceful close'));
        await closed;
        let timer;
        try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native-deferred child did not exit after close')),10000);})]);}
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
  origin=ready.origin;pairingURL=ready.pairingURL;
  const refreshPairing=async()=>{
    if(closing||ended||pendingPairing)throw Error('Native-deferred pairing control unavailable');
    pendingPairing=++pairingSerial;
    const response=wait('paired');
    try{
      if(child.connected){try{child.send({type:'pair',serial:pendingPairing},error=>{if(error)fail(error);});}catch(error){fail(error);}}
      else fail(new Error('Native-deferred child disconnected before pairing'));
      pairingURL=(await response).pairingURL;
    }finally{pendingPairing=0;}
  };
  return {origin,issuePairingURL:()=>pairingURL,refreshPairing,close};
}

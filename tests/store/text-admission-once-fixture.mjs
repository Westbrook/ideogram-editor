// Internal setupModule instrumentation inside the actual storage worker.
// Every admission/release delegates to the real Texts implementation.
import {writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

export async function setup(store){
  const effects=globalThis.__storeNetworkCounters;
  if(!effects)throw new Error('The store no-network preload must reach the writer worker');
  const path=join(store.root,'text-admission-once.json'),calls=[],originals=new Map();
  const save=closed=>{
    writeFileSync(path+'.tmp',JSON.stringify({closed,calls,externalBytes:store.texts.externalBytes(),effects:effects.read()}),{mode:0o600});
    renameSync(path+'.tmp',path);
  };
  for(const method of ['admission','releaseAdmission']){
    const original=store.texts[method].bind(store.texts);originals.set(method,original);
    store.texts[method]=(...args)=>{
      const call={method,id:args[0],outcome:'accepted'};calls.push(call);
      try{return original(...args);}
      catch(error){call.outcome=error.code??'UNKNOWN';throw error;}
      finally{save(false);}
    };
  }
  save(false);
  return async()=>{for(const [method,original] of originals)store.texts[method]=original;save(true);};
}

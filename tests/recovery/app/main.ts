import { DraftPersistence } from '../../../src/state/draft-persistence.js';
import { RecoveryCache } from '../../../src/state/recovery-cache.js';
import { RecoveryConsumer } from '../../../src/state/recovery-client.js';
const w=window as any;
const token=w.__IE_PAIRING__;delete w.__IE_PAIRING__;
const response=await fetch('/api/v1/session/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,pairingToken:token})});
if(!response.ok)throw new Error('Pairing failed');
const session=await response.json();
const cache=await RecoveryCache.open('lp1-browser-test');
const transport=(path:string,init?:RequestInit)=>fetch(path,{...init,credentials:'same-origin',headers:{'X-App-Client':'LP-1',...init?.headers}});
const client=new RecoveryConsumer(cache,transport,()=>session.csrfToken);
w.harness={client,cache,session,transport,DraftPersistence,
  async read(){return {view:await cache.published(),document:await cache.read('document','document_1')};},
  async seedFirst(){const page=await(await transport('/api/v1/events?after=0')).json();const old=await cache.published();const generation=crypto.randomUUID();await cache.apply(generation,page.batches[0].events[0]);await cache.publish({generation,cursor:'1',epoch:page.recovery.writerEpoch},old);},
  async send(command:unknown){const response=await transport('/api/v1/commands',{method:'POST',headers:{'Content-Type':'application/json','X-App-Csrf':session.csrfToken},body:JSON.stringify(command)});return {status:response.status,value:await response.json()};},
};
document.querySelector('#state')!.textContent='Recovery consumer ready';

import {chromium} from './source/node_modules/playwright/index.mjs';
import {startLocalServer} from './source/dist/local/server/http.js';
import {command} from './source/tests/store/helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from './source/dist/local/src/protocol/store.js';
import {mkdtemp,chmod,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const base=new URL('.',import.meta.url).pathname;const root=await mkdtemp(join(base,'roots/browser-'));await chmod(root,0o700);
const s=await startLocalServer({root,staticDirectory:join(base,'source/artifacts/p1b2/browser-app')});
const b=await chromium.launch({headless:true});const ctx=await b.newContext();const facts=[];let failed=0;
await ctx.route('**/*',r=>{if(new URL(r.request().url()).hostname!=='127.0.0.1')throw Error('Nonlocal request denied');return r.continue();});
try {
 const a=await ctx.newPage();await a.goto(s.issuePairingURL());await a.waitForFunction(()=>window.harness);
 const clientId=await a.evaluate(()=>window.harness.session.clientId);const c=command(EMPTY_EXPECTED_VERSIONS,{clientId});
 const accepted=await a.evaluate(c=>window.harness.send(c),c);if(accepted.value.receipt.status!=='accepted')throw Error('Seed failed');
 await a.evaluate(()=>window.harness.client.recover());
 const second=await ctx.newPage();await second.goto(s.issuePairingURL());await second.waitForFunction(()=>window.harness);
 const before=await a.evaluate(()=>window.harness.read());
 await a.evaluate(()=>{const h=window.harness;const original=h.cache.published.bind(h.cache);h.cache.published=async()=>{const old=await original();window.pointerRead=true;await new Promise(r=>window.releaseRead=r);return old;};window.readResult=h.cache.read('document','document_1');});
 await a.waitForFunction(()=>window.pointerRead===true);
 const cp=command(EMPTY_EXPECTED_VERSIONS,{clientId,expectedDocumentRevision:'1',body:{type:'SaveCheckpoint',name:'Independent concurrent publication'}});
 const committed=await second.evaluate(c=>window.harness.send(c),cp);if(committed.value.receipt.status!=='accepted')throw Error('Checkpoint failed');await second.evaluate(()=>window.harness.client.recover());
 const after=await second.evaluate(()=>window.harness.read());
 const readResult=await a.evaluate(async()=>{window.releaseRead();return (await window.readResult)??null;});
 const ok=readResult!==null&&(readResult.revision==='1'||readResult.revision==='2');if(!ok)failed++;
 facts.push({case:'I-C01',description:'An in-flight public cache.read across another tab atomic publication',before,after,readResult,expected:'complete old or new document, never absent',pass:ok});
 await a.close();
 // Independent malformed public control response: highWater changes midway, no publication.
 const prior=await second.evaluate(()=>window.harness.read());
 const cp2=command(EMPTY_EXPECTED_VERSIONS,{clientId,expectedDocumentRevision:'2',body:{type:'SaveCheckpoint',name:'Independent invalid recovery page'}});await second.evaluate(c=>window.harness.send(c),cp2);
 let intercepted=0;await second.route('**/api/v1/events?**',async r=>{const response=await r.fetch();const body=await response.json();if(++intercepted===2)body.recovery.writerEpoch=String(BigInt(body.recovery.writerEpoch)+1n);await r.fulfill({response,json:body});});
 const recovered=await second.evaluate(async()=>{try{await window.harness.client.recover();return 'accepted';}catch{return 'rejected';}});const retained=await second.evaluate(()=>window.harness.read());
 const intact=JSON.stringify(retained)===JSON.stringify(prior)&&recovered==='rejected';if(!intact)failed++;facts.push({case:'I-C02',description:'Changed epoch at final public recovery revalidation',result:recovered,oldStateRetained:intact,pass:intact});await second.unroute('**/api/v1/events?**');
 // Crash-like page close after staging but before pointer swap: reopen same persistent IndexedDB.
 await second.route('**/api/v1/events?**',async r=>{if(r.request().url().includes('recoveryId=')){await r.abort('failed');}else await r.continue();});
 await second.evaluate(async()=>{try{await window.harness.client.recover();}catch{}});await second.close();
 const third=await ctx.newPage();await third.goto(s.issuePairingURL());await third.waitForFunction(()=>window.harness);const reopened=await third.evaluate(()=>window.harness.read());const preserved=JSON.stringify(reopened)===JSON.stringify(prior);if(!preserved)failed++;facts.push({case:'I-C03',description:'Page close/reopen after failed final transfer',priorProjectionPreserved:preserved,pass:preserved});
 await third.evaluate(()=>window.harness.client.recover());facts.push({case:'I-C04',description:'Recovery after browser reopen',state:await third.evaluate(()=>window.harness.read())});
}finally{await writeFile(join(base,'browser-facts.json'),JSON.stringify({browser:b.version(),root,facts,failed},null,2)+'\n');await ctx.close();await b.close();await s.close();}
console.log(JSON.stringify({failed,facts},null,2));process.exitCode=failed?1:0;

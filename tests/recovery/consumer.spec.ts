import { test,expect } from '@playwright/test';
import { mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {startLocalServer}=await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
const {openWriter}=await import(pathToFileURL(resolve('dist/local/server/storage/writer.js')).href);
const {largeTransaction}=await import('../protocol/fixtures.mjs');
const {command,checkpoint,encode,expectedBytes,refFor}=await import('../store/helpers.mjs');
let server:any;let root:string;let now:number;
test.beforeEach(async({context})=>{
  root=await mkdtemp(join(await realpath(tmpdir()),'ie-recovery-browser-'));now=Date.now();
  await context.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1')throw new Error('Provider/nonlocal request denied');return route.continue();});
});
test.afterEach(async()=>{if(server)await server.close();server=undefined;await rm(root,{recursive:true,force:true});});
async function start(page:any){server=await startLocalServer({root,staticDirectory:resolve('artifacts/p1b2/browser-app'),now:()=>now});await page.goto(server.issuePairingURL());await expect(page.locator('#state')).toHaveText('Recovery consumer ready');}
async function snapshotFixture(){const w=await openWriter({root});const ref=await w.putObject([expectedBytes],refFor(expectedBytes),w.epoch);await w.submit(encode(command(ref)),w.epoch);for(let i=1;i<255;i++)await w.submit(encode(checkpoint(ref,String(i),'Snapshot '+i)),w.epoch);await w.close();return ref;}
const state=(page:any)=>page.evaluate(()=> (window as any).harness.read());
const recover=(page:any)=>page.evaluate(async()=>{try{return {cursor:await (window as any).harness.client.recover()};}catch(e){return {error:String(e)};}});

test('browser snapshot plus pinned tail publishes at H only and preserves prior view on download failure',async({page})=>{
  const ref=await snapshotFixture();await start(page);
  // A previous published view is deliberately distinct from the incoming snapshot.
  await page.evaluate(async()=>{const h=(window as any).harness;const old=await h.cache.published();await h.cache.put('old','document','sentinel',{label:'previous'});await h.cache.publish({generation:'old',cursor:'0',epoch:null},old);});
  const before=await state(page);let unblock:()=>void=()=>{};let entered:()=>void=()=>{};const hit=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>unblock=r);
  await page.route('**/api/v1/protocol-content/**',async route=>{entered();await gate;await route.continue();});
  const pending=recover(page);await hit;expect(await state(page)).toEqual(before);
  // Real later write while the server's recovery H is already pinned.
  const session=await page.evaluate(()=>({clientId:(window as any).harness.session.clientId}));
  const c=command(ref,{clientId:session.clientId,expectedDocumentRevision:'255',body:{type:'SaveCheckpoint',name:'after pinned H'}});
  const sent=await page.evaluate(c=>(window as any).harness.send(c),c);expect(sent.value.receipt.toSeq).toBe('256');unblock();
  expect(await pending).toEqual({cursor:'255'});expect((await state(page)).document.revision).toBe('255');await page.unroute('**/api/v1/protocol-content/**');
  expect(await recover(page)).toEqual({cursor:'256'});const good=await state(page);
  // Force a fresh snapshot recovery from a previously visible cursor0 view.
  await page.evaluate(async()=>{const h=(window as any).harness;const old=await h.cache.published();const generation=crypto.randomUUID();await h.cache.clone(old.generation,generation);await h.cache.publish({...old,generation,cursor:'0'},old);});
  const prior=await state(page);
  await page.route('**/api/v1/protocol-content/**',async route=>{const r=await route.fetch();const bytes=await r.body();bytes[bytes.length-2]^=1;await route.fulfill({response:r,body:bytes});});
  expect((await recover(page)).error).toBeTruthy();expect(await state(page)).toEqual(prior);
  await page.unroute('**/api/v1/protocol-content/**');expect(await recover(page)).toEqual({cursor:'256'});
  expect((await state(page)).document).toEqual(good.document);await page.screenshot({path:'artifacts/p1b2/browser-recovery.png'});
});

test('browser validates large transaction hash, length, count, sequence and pinned context before publication',async({page})=>{
  await largeTransaction(root);await start(page);await page.evaluate(()=>(window as any).harness.seedFirst());const before=await state(page);
  for(const fault of ['hash','length','count','sequence','context','partial']){
    await page.route('**/api/v1/events?**',async route=>{const r=await route.fetch();const body=await r.json();const batch=body.batches?.[0];
      if(batch?.kind==='transaction-ref'){
        if(fault==='hash')batch.content.blob.hash='sha256:'+'f'.repeat(64);
        if(fault==='length')batch.content.blob.byteLength=String(BigInt(batch.content.blob.byteLength)+1n);
        if(fault==='count'){batch.eventCount='79';batch.content.recordCount='79';}
        if(fault==='sequence')batch.fromSeq='3';
        if(fault==='context')batch.recovery={...batch.recovery,highWater:'82'};
      }await route.fulfill({response:r,json:body});});
    if(fault==='partial')await page.route('**/api/v1/protocol-content/**',async route=>{const r=await route.fetch();const bytes=await r.body();await route.fulfill({response:r,body:bytes.subarray(0,bytes.length-20)});});
    expect((await recover(page)).error,fault).toBeTruthy();expect(await state(page),fault).toEqual(before);
    await page.unroute('**/api/v1/events?**');await page.unroute('**/api/v1/protocol-content/**');
  }
  expect(await recover(page)).toEqual({cursor:'81'});expect((await state(page)).document.revision).toBe('81');
});

test('browser SSE reference is offered only; failed download keeps cursor and reconnect uses applied boundary',async({page})=>{
  await largeTransaction(root);await start(page);await page.evaluate(()=>(window as any).harness.seedFirst());const before=await state(page);
  let entered:()=>void=()=>{},unblock:()=>void=()=>{};const hit=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>unblock=r);
  await page.route('**/api/v1/protocol-content/**',async route=>{entered();await gate;await route.abort('failed');});
  const running=page.evaluate(async()=>{try{await(window as any).harness.client.consumeStream();return 'done';}catch{return 'failed';}});await hit;
  expect(await state(page)).toEqual(before);expect(await page.evaluate(()=>(window as any).harness.client.reconnectURL())).toBe('/api/v1/events/stream?after=1');
  unblock();expect(await running).toBe('failed');expect(await state(page)).toEqual(before);await page.unroute('**/api/v1/protocol-content/**');
  expect(await recover(page)).toEqual({cursor:'81'});
});

test('browser rejects partial and gapped SSE batches, ignores duplicate delivery, and never accepts a checkpoint cursor',async({page})=>{
  const w=await openWriter({root});const ref=await w.putObject([expectedBytes],refFor(expectedBytes),w.epoch);await w.submit(encode(command(ref)),w.epoch);await w.submit(encode(checkpoint(ref,'1')),w.epoch);await w.close();await start(page);
  await page.evaluate(()=>(window as any).harness.seedFirst());const initial=await state(page);
  const event=await page.evaluate(async()=>{const h=(window as any).harness;return(await(await h.transport('/api/v1/events?after=1')).json()).batches[0].events[0];});
  const part={protocolVersion:1,kind:'batch-part',transactionId:event.transactionId,fromSeq:'2',toSeq:'2',partIndex:0,partCount:2,events:[event]};
  const run=async(body:string)=>{await page.route('**/api/v1/events/stream?**',route=>route.fulfill({status:200,contentType:'text/event-stream',body}));const result=await page.evaluate(async()=>{try{await(window as any).harness.client.consumeStream();return 'done';}catch{return 'failed';}});await page.unroute('**/api/v1/events/stream?**');return result;};
  expect(await run('data: '+JSON.stringify(part)+'\n\n')).toBe('failed');expect(await state(page)).toEqual(initial);
  expect(await run('id: 3\ndata: '+JSON.stringify({...part,fromSeq:'3',toSeq:'3',partCount:1})+'\n\n')).toBe('failed');expect(await state(page)).toEqual(initial);
  expect(await run('data: '+JSON.stringify({protocolVersion:1,kind:'checkpoint',highWater:'9'})+'\n\n')).toBe('failed');expect(await state(page)).toEqual(initial);
  const complete='id: 2\ndata: '+JSON.stringify({...part,partCount:1})+'\n\n';expect(await run(complete+complete)).toBe('done');expect((await state(page)).view.cursor).toBe('2');expect((await state(page)).document.revision).toBe('2');
});

test('browser revoked recovery context and mid-download expiry preserve the previous published projection',async({page})=>{
  await snapshotFixture();await start(page);const before=await state(page);
  await page.route('**/api/v1/protocol-content/**',async route=>{now+=31*60*1000;await route.continue();});
  expect((await recover(page)).error).toBeTruthy();expect(await state(page)).toEqual(before);
});

test('browser live SSE applies a complete referenced transaction once and records the applied reconnect cursor',async({page})=>{
  await largeTransaction(root);await start(page);await page.evaluate(()=>(window as any).harness.seedFirst());
  await page.evaluate(()=>{const w=window as any;w.streamAbort=new AbortController();w.streamResult=w.harness.client.consumeStream(w.streamAbort.signal).catch(()=>{});});
  await expect.poll(async()=>(await state(page)).view.cursor).toBe('81');expect((await state(page)).document.revision).toBe('81');
  await page.evaluate(async()=>{const w=window as any;w.streamAbort.abort();await w.streamResult;});
  expect(await page.evaluate(()=>(window as any).harness.client.reconnectURL())).toBe('/api/v1/events/stream?after=81');
});

test('browser explicit session revocation during content retrieval preserves the previous view',async({page})=>{
  await snapshotFixture();await start(page);const before=await state(page);
  await page.route('**/api/v1/protocol-content/**',async route=>{
    await page.evaluate(async()=>{const h=(window as any).harness;await h.transport('/api/v1/session/revoke',{method:'POST',headers:{'Content-Type':'application/json','X-App-Csrf':h.session.csrfToken},body:'{"protocolVersion":1}'});});await route.continue();
  });expect((await recover(page)).error).toBeTruthy();expect(await state(page)).toEqual(before);
});

test('browser server shutdown during a pinned download leaves the previous view intact',async({page})=>{
  await snapshotFixture();await start(page);const before=await state(page);
  await page.route('**/api/v1/protocol-content/**',async route=>{await server.close();await route.abort('connectionrefused');});
  expect((await recover(page)).error).toBeTruthy();expect(await state(page)).toEqual(before);
});

test('two browser tabs race durable commands and converge through complete recovery with no browser writer authority',async({page,context})=>{
  const w=await openWriter({root});const ref=await w.putObject([expectedBytes],refFor(expectedBytes),w.epoch);await w.submit(encode(command(ref)),w.epoch);await w.close();await start(page);
  const second=await context.newPage();await second.goto(server.issuePairingURL());await expect(second.locator('#state')).toHaveText('Recovery consumer ready');
  await page.evaluate(async()=>{const h=(window as any).harness;Object.assign(h.session,await(await h.transport('/api/v1/session')).json());});
  const clientId=await second.evaluate(()=>(window as any).harness.session.clientId);
  const commands=['tab one','tab two'].map(name=>command(ref,{clientId,expectedDocumentRevision:'1',body:{type:'SaveCheckpoint',name}}));
  const receipts=await Promise.all([page.evaluate(c=>(window as any).harness.send(c),commands[0]),second.evaluate(c=>(window as any).harness.send(c),commands[1])]);
  expect(receipts.map(r=>r.value.receipt.status).sort()).toEqual(['accepted','rejected']);expect(receipts.find(r=>r.value.receipt.status==='rejected')!.value.receipt.code).toBe('STALE_REVISION');
  await Promise.all([recover(page),recover(second)]);await recover(page);await recover(second);
  expect((await state(page)).view.cursor).toBe('2');expect((await state(second)).document).toEqual((await state(page)).document);await second.close();
});

test('I-C01 a public cache read overlapping another tab publication retains a complete document',async({page,context})=>{
  await start(page);const second=await context.newPage();await second.goto(server.issuePairingURL());await expect(second.locator('#state')).toHaveText('Recovery consumer ready');
  await page.evaluate(async()=>{const h=(window as any).harness;const old=await h.cache.published();await h.cache.put('first','document','document_1',{id:'document_1',revision:'1'});await h.cache.publish({generation:'first',cursor:'1',epoch:'1'},old);
    // Gate the old split-read boundary if present. A consistent read can finish
    // without this boundary and must retain its selected row after publication.
    const original=h.cache.published.bind(h.cache);h.cache.published=async()=>{const view=await original();(window as any).pointerRead=true;await new Promise<void>(r=>(window as any).releaseRead=r);return view;};
    (window as any).readResult=h.cache.read('document','document_1').then((v:any)=>{(window as any).readDone=true;return v;});});
  await page.waitForFunction(()=>(window as any).pointerRead||(window as any).readDone);
  await second.evaluate(async()=>{const cache=(window as any).harness.cache;const old=await cache.published();await cache.put('second','document','document_1',{id:'document_1',revision:'2'});await cache.publish({generation:'second',cursor:'2',epoch:'1'},old);});
  const result=await page.evaluate(async()=>{(window as any).releaseRead?.();return await(window as any).readResult??null;});
  expect(result).toEqual({id:'document_1',revision:'1'});expect((await state(second)).document.revision).toBe('2');await second.close();
});

test('I-C01 IndexedDB read lifetime blocks cross-tab publication and deletion until row selection completes',async({page,context})=>{
  await start(page);const second=await context.newPage();await second.goto(server.issuePairingURL());await expect(second.locator('#state')).toHaveText('Recovery consumer ready');
  await page.evaluate(async()=>{const cache=(window as any).harness.cache;const old=await cache.published();await cache.put('first','document','document_1',{revision:'1'});await cache.put('second','document','document_1',{revision:'2'});await cache.publish({generation:'first',cursor:'1',epoch:'1'},old);
    const original=IDBObjectStore.prototype.get;let intercept=true;
    IDBObjectStore.prototype.get=function(key){const request=original.call(this,key);if(intercept&&this.name==='meta'&&key==='published'){
      intercept=false;const tx=this.transaction;let handler:any;
      Object.defineProperty(request,'onsuccess',{set(value){handler=value;}});
      request.addEventListener('success',()=>{(window as any).pointerRead=true;const pump=()=>{const keep=original.call(tx.objectStore('meta'),'read-lifetime-gate');keep.onsuccess=()=>{if(!(window as any).releaseRead)pump();else handler.call(request,new Event('success'));};};pump();});
    }return request;};
    (window as any).readResult=cache.read('document','document_1');});
  await page.waitForFunction(()=>(window as any).pointerRead===true);
  await second.evaluate(()=>{const w=window as any;w.publishResult=w.harness.cache.publish({generation:'second',cursor:'2',epoch:'1'},{generation:'first',cursor:'1',epoch:'1'}).then(()=>w.publishDone=true);w.publishStarted=true;});
  expect(await second.evaluate(()=>(window as any).publishDone??false)).toBe(false);
  const row=await page.evaluate(async()=>{(window as any).releaseRead=true;return await(window as any).readResult;});expect(row).toEqual({revision:'1'});
  await second.evaluate(()=>(window as any).publishResult);expect((await state(second)).document).toEqual({revision:'2'});await second.close();
});

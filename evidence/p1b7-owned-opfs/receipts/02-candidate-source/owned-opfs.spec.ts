import {test,expect,webkit,type BrowserContext,type Page} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ownedOPFS} from './owned-opfs.js';
const receipt=process.env.EDITOR_RECEIPT??'artifacts/p1b7/current';
async function server(){const s=createServer((_,r)=>r.end('<!doctype html><title>Owned native storage control</title>'));await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));return {origin:'http://127.0.0.1:'+(s.address() as {port:number}).port,close:()=>new Promise<void>(r=>s.close(()=>r()))};}
async function marker(page:Page,name:string,create=false){return page.evaluate(async({name,create})=>{const root=await navigator.storage.getDirectory();if(create){const f=await root.getFileHandle(name,{create:true}),w=await f.createWritable();await w.write(new Uint8Array([0,255,10,13,127,128]));await w.close();}const f=await root.getFileHandle(name);return [...new Uint8Array(await(await f.getFile()).arrayBuffer())];},{name,create});}
async function removeMarker(page:Page,name:string){expect(await marker(page,name)).toEqual([0,255,10,13,127,128]);await page.evaluate(async name=>{const root=await navigator.storage.getDirectory();await root.removeEntry(name);for await(const [n] of (root as any).entries())if(n===name)throw Error('CONTROL_MARKER_REMAINS');},name);}
async function persistent(profiles:string[]){const p=await mkdtemp(join(await realpath(tmpdir()),'ie-owned-opfs-'));profiles.push(p);return webkit.launchPersistentContext(p);}

test('native OPFS dirty admission refuses foreign entries; exact owned success and failure cleanup',async({browser,browserName})=>{
 const servers=await Promise.all([server(),server(),server()]),profiles:string[]=[],observations:any[]=[];let context:BrowserContext|undefined,foreignPage:Page|undefined,foreignCreated=false;
 const foreign='foreign-'+randomUUID();let store:Awaited<ReturnType<typeof ownedOPFS>>|undefined,page:Page|undefined;
 try{
  context=browserName==='webkit'?await persistent(profiles):await browser.newContext();
  // This controlled creator document predates the observer. It is the ONLY
  // actor allowed to read/remove its declared foreign marker after refusal.
  foreignPage=await context.newPage();await foreignPage.goto(servers[0].origin);
  const initial=await foreignPage.evaluate(async()=>{const r=await navigator.storage.getDirectory(),names=[];for await(const [n] of (r as any).entries())names.push(n);return names;});
  observations.push({phase:'creator-precondition',origin:servers[0].origin,profiles:[...profiles],initial});expect(initial).toEqual([]);
  expect(await marker(foreignPage,foreign,true)).toEqual([0,255,10,13,127,128]);foreignCreated=true;
  store=await ownedOPFS(context,profiles[0]??browserName+' ephemeral');page=await context.newPage();
  await expect(store.admit(page,servers[0].origin)).rejects.toThrow('OPFS_DIRTY_ORIGIN');
  expect(store.ledger.some(e=>e.phase==='admitted')).toBe(false);
  await store.cleanup(page); // Refused origins cannot authorize even cleanup.
  expect(await marker(foreignPage,foreign)).toEqual([0,255,10,13,127,128]);
  observations.push({phase:'foreign-preserved',name:foreign,bytes:[0,255,10,13,127,128]});
  await removeMarker(foreignPage,foreign);foreignCreated=false;observations.push({phase:'creator-cleaned',name:foreign,absent:true});
  await store.admit(page,servers[1].origin);
  expect(await marker(page,'owned-success-'+store.run,true)).toEqual([0,255,10,13,127,128]);await store.cleanup(page);store.verify();
  await store.admit(page,servers[2].origin);
  let failure='';try{await marker(page,'owned-failure-'+store.run,true);throw Error('CONTROL_WORKFLOW_FAILURE');}catch(e){failure=String(e);}finally{await store.cleanup(page);}
  expect(failure).toContain('CONTROL_WORKFLOW_FAILURE');store.verify();observations.push({phase:'workflow-failure-cleaned',failure});
 }finally{
  try{if(foreignCreated&&foreignPage)await removeMarker(foreignPage,foreign);}finally{
   await context?.close();for(const s of servers)await s.close();for(const p of profiles)await rm(p,{recursive:true,force:true});
   await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'owned-opfs-controls.json'),JSON.stringify({browserName,origins:servers.map(s=>s.origin),profiles,observations,ledger:store?.ledger},null,2));
  }
 }
});

test('WebKit native profile sharing is retained as an environment negative, not an isolation guarantee',async({browserName,browser})=>{
 test.skip(browserName!=='webkit','WebKit-specific persistent-profile boundary; common admission controls run on every engine');
 const one=await server(),two=await server(),profiles:string[]=[],observations:any[]=[],name='same-origin-'+randomUUID();let context:BrowserContext|undefined,created=false;
 try{
  const ephemeral=await browser.newContext();try{const p=await ephemeral.newPage();await p.goto(one.origin);const result=await p.evaluate(async()=>{try{await navigator.storage.getDirectory();return 'available';}catch(e){return (e as DOMException).name;}});observations.push({phase:'ephemeral',origin:one.origin,result});expect(result).toBe('UnknownError');}finally{await ephemeral.close();}
  context=await persistent(profiles);let page=await context.newPage();await page.goto(one.origin);
  const initial=await page.evaluate(async()=>{const r=await navigator.storage.getDirectory(),names=[];for await(const [n] of (r as any).entries())names.push(n);return names;});observations.push({phase:'first',origin:one.origin,profile:profiles[0],initial});expect(initial).toEqual([]);
  await marker(page,name,true);created=true;await context.close();context=await persistent(profiles);page=await context.newPage();
  const store=await ownedOPFS(context,profiles[1]);observations.push({phase:'second',origin:one.origin,profile:profiles[1]});
  await expect(store.admit(page,one.origin)).rejects.toThrow('OPFS_DIRTY_ORIGIN');expect(await marker(page,name)).toEqual([0,255,10,13,127,128]);
  observations.push({phase:'same-origin-shared-marker',name,bytes:[0,255,10,13,127,128],ledger:store.ledger});
  await removeMarker(page,name);created=false;
  await store.admit(page,two.origin);await store.cleanup(page);store.verify();observations.push({phase:'other-origin-clean',origin:two.origin});
 }finally{
  try{if(created){if(!context||context.pages().length===0)context=await persistent(profiles);const p=await context.newPage();await p.goto(one.origin);await removeMarker(p,name);observations.push({phase:'failure-owned-marker-cleanup',name,absent:true});}}finally{
   await context?.close();await one.close();await two.close();for(const p of profiles)await rm(p,{recursive:true,force:true});await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'native-profile-boundary.json'),JSON.stringify({origins:[one.origin,two.origin],profiles,observations},null,2));
  }
 }
});

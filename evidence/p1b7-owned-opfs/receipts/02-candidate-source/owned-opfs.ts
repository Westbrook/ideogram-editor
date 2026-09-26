import type {BrowserContext,Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';

// E1-only observation of real native OPFS. A fresh WebKit userDataDir does NOT
// isolate OPFS. Admission requires an observed empty root at each owned origin.
// No content of preexisting entries is read; only exact created handles may be
// removed. The external ledger survives navigation and catches lost cleanup.
export async function ownedOPFS(context:BrowserContext,profile:string){
 const run=randomUUID(),admitted=new Set<string>(),live=new Map<string,string>();
 const ledger:any[]=[{phase:'fixture',run,profile}],key=(origin:string,name:string)=>origin+'/'+name;
 await context.exposeBinding('recordOwnedOPFS',({page},event:any)=>{
  const origin=new URL(page.url()).origin;
  if(event.origin!==origin)throw Error('OPFS_ORIGIN_MISMATCH');
  ledger.push(event);
  if(event.phase==='creating'){
   if(!admitted.has(origin)||live.has(key(origin,event.name)))throw Error('OPFS_NOT_ADMITTED');
   live.set(key(origin,event.name),'creating');
  }else if(event.phase==='created')live.set(key(origin,event.name),'created');
  else if(event.phase==='removed')live.delete(key(origin,event.name));
 });
 await context.addInitScript(()=>{
  if(location.protocol!=='http:'||location.hostname!=='127.0.0.1')return;
  const native=FileSystemDirectoryHandle.prototype.getFileHandle;
  const owned=new Map<string,{root:FileSystemDirectoryHandle;file:FileSystemFileHandle}>();
  const record=(event:any)=>(window as any).recordOwnedOPFS({origin:location.origin,...event});
  FileSystemDirectoryHandle.prototype.getFileHandle=async function(name,options){
   if(!options?.create)return native.call(this,name,options);
   const root=await navigator.storage.getDirectory();
   if(!await root.isSameEntry(this))throw Error('OPFS_UNOWNED_DIRECTORY');
   // Refuse collisions, never inspect an existing file's content.
   let exists=false;
   try{await native.call(this,name);exists=true;}catch(e){if((e as DOMException).name!=='NotFoundError')throw e;}
   if(exists)throw Error('OPFS_PREEXISTING_CREATE');
   await record({phase:'creating',name});
   const file=await native.call(this,name,options);
   owned.set(name,{root,file});
   await record({phase:'created',name});
   return file;
  };
  (window as any).cleanupOwnedOPFS=async()=>{
   for(const [name,{root,file}] of owned){
    const current=await native.call(root,name);
    if(!await current.isSameEntry(file))throw Error('OPFS_HANDLE_REPLACED');
    await root.removeEntry(name);owned.delete(name);
    let absent=false;try{await native.call(root,name);}catch(e){if((e as DOMException).name==='NotFoundError')absent=true;else throw e;}
    if(!absent)throw Error('OPFS_CLEANUP_NOT_ABSENT');
    await record({phase:'removed',name,exactHandle:true,absent});
   }
   const root=await navigator.storage.getDirectory(),remaining=[];
   for await(const [name,entry] of (root as any).entries())remaining.push({name,kind:entry.kind});
   await record({phase:'cleanup',remaining});
   if(remaining.length)throw Error('OPFS_UNKNOWN_REMAINS');
  };
 });
 return {run,ledger,
  async admit(page:Page,origin:string){
   // Persist relationship before navigation/assertions; this is an inert test
   // document only. No product response or storage implementation is replaced.
   ledger.push({phase:'preflight-start',origin,profile});
   if(admitted.has(origin))throw Error('OPFS_ORIGIN_REUSED');
   const url=origin+'/__e1_opfs_preflight_'+run;
   await page.route(url,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>E1 native storage preflight</title>'}));
   try{
    await page.goto(url);
    const initial=await page.evaluate(async()=>{
     const root=await navigator.storage.getDirectory(),entries=[];
     for await(const [name,entry] of (root as any).entries())entries.push({name,kind:entry.kind});
     return {entries,localStorage:localStorage.length,cookies:document.cookie.length,indexedDB:(await indexedDB.databases()).map(d=>d.name)};
    });
    ledger.push({phase:'preflight',origin,...initial});
    // Cookies are host-scoped, not port-scoped. The first origin requires an
    // empty fresh context; restarts deliberately retain this run's session jar.
    // OPFS/localStorage/IDB must start empty at EVERY newly owned origin.
    if(initial.entries.length||initial.localStorage||(!admitted.size&&initial.cookies)||initial.indexedDB.length)throw Error('OPFS_DIRTY_ORIGIN');
    admitted.add(origin);ledger.push({phase:'admitted',origin});
   }catch(e){ledger.push({phase:'refused',origin,error:String(e)});throw e;}
   finally{await page.unroute(url);}
  },
  async cleanup(page:Page){
   const origin=new URL(page.url()).origin;
   if(!admitted.has(origin))return;
   try{await page.evaluate(()=>(window as any).cleanupOwnedOPFS());}
   catch(e){ledger.push({phase:'cleanup-incomplete',origin,error:String(e)});throw e;}
   if([...live.keys()].some(k=>k.startsWith(origin+'/')))throw Error('OPFS_LOST_OWNED_HANDLE');
  },
  verify(){if(live.size)throw Error('OPFS_CLEANUP_INCOMPLETE: '+JSON.stringify([...live]));}
 };
}

import {specReceipt} from './receipt-path.js';
import {test,expect,type BrowserContext,type BrowserType} from '@playwright/test';
import {createServer} from 'node:http';
import {transformSync} from 'rolldown/utils';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,mkdtemp,realpath,rm,mkdir,writeFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ownedOPFS} from './owned-opfs.js';
import {recordDOMErrors} from './error-monitor.js';
// @ts-ignore Reuse the campaign's strict, metadata-only OS process parsers.
import {parseResourceProcesses,parseResourceBirths,resourceProcessTree} from '../../tooling/qualification/campaigns/browser-resources.mjs';

const execute=promisify(execFile),MiB=1024*1024,largeBytes=33*MiB+17,smallBytes=2*MiB+17,chunkBytes=64*1024;
const fixedUUID='76f68d69-b5f8-447d-89c5-8e5bd8d7ac7a';
function payloadChunk(index:number,length:number){
 const bytes=Buffer.alloc(length);let state=(0x9e3779b9^index)>>>0;
 for(let at=0;at<length;at++){state^=state<<13;state^=state>>>17;state^=state<<5;bytes[at]=state&255;}
 return bytes;
}
function payloadHash(length:number){const hash=createHash('sha256');for(let at=0,index=0;at<length;at+=chunkBytes,index++)hash.update(payloadChunk(index,Math.min(chunkBytes,length-at)));return 'sha256:'+hash.digest('hex');}
async function fileHash(path:string){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return 'sha256:'+hash.digest('hex');}

// This isolated module fixture has no editor/backend allocation ledger. Reuse
// the real campaign's strict process parsers for a narrower browser-tree RSS
// observation, explicitly preserving unavailable identities and missed peaks.
async function browserRSS(executable:string,profile:string){
 const samples:any[]=[],missing:string[]=[];let root:number|undefined,birth:any,timer:ReturnType<typeof setInterval>|undefined,pending=Promise.resolve();
 const ps=async(args:string[])=>{const result=await execute('/bin/ps',args,{timeout:1000,maxBuffer:4*MiB,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});return result.stdout;};
 try{
  const rows=(await ps(['-axww','-o','pid=','-o','ppid=','-o','command='])).split('\n').map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(match=>({pid:Number(match![1]),ppid:Number(match![2]),command:match![3]}));
  const owned=rows.filter(row=>row.command.includes(executable)&&row.command.includes(profile)),roots=owned.filter(row=>!owned.some(parent=>parent.pid===row.ppid));
  if(roots.length!==1)throw Error('Unique browser root unavailable');root=roots[0].pid;
  birth=parseResourceBirths(await ps(['-p',String(root),'-o','pid=','-o','pgid=','-o','lstart=']))[0];if(!birth||birth.pid!==root)throw Error('Browser birth unavailable');
 }catch{missing.push('owned-browser-root-or-birth-unavailable');}
 const observe=async(label:string)=>{
  if(samples.length>=2048){if(!missing.includes('sample-bound'))missing.push('sample-bound');return;}
  const started=performance.now();
  if(!root){samples.push({label,started,rssBytes:null,missing:'owned-browser-root-unavailable'});return;}
  try{
   const discovery=resourceProcessTree(parseResourceProcesses(await ps(['-e','-o','pid=,ppid=,rss='])),root);if(!discovery.length)throw Error('Browser exited');
   const births=async(ids:number[])=>parseResourceBirths(await ps(['-p',ids.join(','),'-o','pid=','-o','pgid=','-o','lstart=']));
   const before=await births(discovery.map((row:any)=>row.pid)),rows=resourceProcessTree(parseResourceProcesses(await ps(['-e','-o','pid=,ppid=,rss='])),root),after=await births(rows.map((row:any)=>row.pid));
   const same=(a:any,b:any)=>a&&b&&a.pid===b.pid&&a.pgid===b.pgid&&a.startedAtIdentity===b.startedAtIdentity;
   if(!same(birth,after.find((row:any)=>row.pid===root))||!rows.length||rows.some((row:any)=>!same(before.find((item:any)=>item.pid===row.pid),after.find((item:any)=>item.pid===row.pid))))throw Error('Process identity changed during sample');
   samples.push({label,started,ended:performance.now(),rssBytes:rows.reduce((sum:number,row:any)=>sum+row.rssBytes,0),processes:rows.map((row:any)=>({...row,birth:after.find((item:any)=>item.pid===row.pid)}))});
  }catch{samples.push({label,started,ended:performance.now(),rssBytes:null,missing:'process-tree-or-birth-observation-unavailable'});}
 };
 const capture=(label:string)=>{pending=pending.then(()=>observe(label));return pending;};
 await capture('before');let scheduled=false;
 timer=setInterval(()=>{if(scheduled)return;scheduled=true;void capture('scheduled').finally(()=>{scheduled=false;});},250);
 return {capture,async stop(){clearInterval(timer);await pending;const values=samples.filter(sample=>sample.rssBytes!==null).map(sample=>sample.rssBytes);return {scope:'Browser process tree only; HTTP fixture and Playwright worker excluded.',intervalMs:250,browserRoot:birth??null,samples,peakSampledRSS:values.length?Math.max(...values):null,missing:[...missing,...(samples.some(sample=>sample.rssBytes===null)?['one-or-more-process-observations-unavailable']:[])],forcedGC:false,limits:'Sampled RSS is not an allocator ledger or a universal native Blob memory bound. Shared pages can be counted in multiple processes; between-sample peaks may be missed. The 33 MiB fixture does not qualify 4 GiB copies or the prescribed performance hosts.'};}};
}

async function fixture(browserType:BrowserType,browserName:string){
 const payloads=new Map([['/payload',{bytes:largeBytes,hash:payloadHash(largeBytes)}],['/small',{bytes:smallBytes,hash:payloadHash(smallBytes)}]]);
 const sources=await Promise.all(['state/destination','protocol/sha256','observability/allocations','observability/diagnostic-memory','observability/composition-observations'].map(async name=>({name,source:await readFile('src/'+name+'.ts','utf8')})));
 const modules=new Map(sources.map(({name,source})=>{const transformed=transformSync(name+'.ts',source);if(transformed.errors.length)throw Error(transformed.errors.map(error=>error.message).join('; '));return ['/src/'+name+'.js',transformed.code];}));
 const requests:any[]=[],server=createServer((request,response)=>{
  const path=request.url??'/',source=modules.get(path),payload=payloads.get(path);
  if(source){response.setHeader('Content-Type','text/javascript');response.end(source);return;}
  if(!payload){response.end('<!doctype html><title>Independent destination Blob</title><button>Download controlled copy</button>');return;}
  const event={path,bytes:payload.bytes,started:performance.now(),sent:0,completed:false};requests.push(event);
  response.writeHead(200,{'Content-Type':'application/octet-stream','ETag':'"'+payload.hash+'"','Content-Length':String(payload.bytes),'Cache-Control':'no-store'});
  void(async()=>{try{for(let at=0,index=0;at<payload.bytes;at+=chunkBytes,index++){if(response.destroyed)return;const bytes=payloadChunk(index,Math.min(chunkBytes,payload.bytes-at));await new Promise<void>((resolve,reject)=>response.write(bytes,error=>error?reject(error):resolve()));event.sent+=bytes.length;}event.completed=true;response.end();}catch{response.destroy();}})();
 });
 let context:BrowserContext|undefined,profile:string|undefined;
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  profile=await mkdtemp(join(await realpath(tmpdir()),'ie-destination-success-'+browserName+'-'));
  context=await browserType.launchPersistentContext(profile);await Promise.all(context.pages().map(page=>page.close()));
  const guard=await ownedOPFS(context,profile),domErrors=await recordDOMErrors(context),page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));await guard.admit(page,origin);await page.goto(origin);
  return {context,page,guard,domErrors,errors,origin,profile,payloads,requests,sourceHashes:sources.map(({name,source})=>({name,sha256:createHash('sha256').update(source).digest('hex')})),
   async close(){try{await guard.cleanup();guard.verify();}finally{await context!.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(profile!,{recursive:true});}}
  };
 }catch(error){await context?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));if(profile)await rm(profile,{recursive:true});throw error;}
}

for(const releaseAction of ['settle','settle-and-navigate'] as const)test('33 MiB fallback survives native cleanup and immediate '+releaseAction,async({playwright,browserName})=>{
 test.setTimeout(180000);const output=resolve(specReceipt(import.meta.url,'artifacts/p1b7/current'));await mkdir(output,{recursive:true});
 const f=await fixture(playwright[browserName],browserName),downloads:string[]=[],rss=await browserRSS(playwright[browserName].executablePath(),f.profile);let result:any,resources:any;f.page.on('download',download=>downloads.push(download.suggestedFilename()));
 try{
  const payload=f.payloads.get('/payload')!;
  await f.page.evaluate(async({payload,fixedUUID,releaseAction})=>{
   const modulePath='/src/state/destination.js',module=await import(modulePath),allocationPath='/src/observability/allocations.js',{allocationLedger}=await import(allocationPath),allocationsBefore=allocationLedger.snapshot(),events:any[]=[],storageBefore=await navigator.storage.estimate();let sequence=0;
   const note=(kind:string,fields:Record<string,unknown>={})=>events.push({sequence:++sequence,kind,...fields});
   const originalUUID=crypto.randomUUID,originalAdd=IDBObjectStore.prototype.add,originalGet=IDBObjectStore.prototype.get,originalDelete=IDBFactory.prototype.deleteDatabase,originalRemove=FileSystemDirectoryHandle.prototype.removeEntry,originalURL=URL.createObjectURL,originalRevoke=URL.revokeObjectURL,originalClick=HTMLAnchorElement.prototype.click,originalRead=Blob.prototype.arrayBuffer,urls=new Map<string,number>();
   Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=>fixedUUID});
   IDBObjectStore.prototype.add=function(value:any,key?:IDBValidKey){if(this.name==='chunks')note('chunk-add',{file:value instanceof File,blob:value instanceof Blob,bytes:value?.size,allocations:allocationLedger.snapshot()});return originalAdd.call(this,value,key);};
   IDBObjectStore.prototype.get=function(key:IDBValidKey|IDBKeyRange){if(this.name==='chunks')note('chunk-get');return originalGet.call(this,key);};
   IDBFactory.prototype.deleteDatabase=function(name:string){const request=originalDelete.call(this,name);request.addEventListener('success',()=>note('database-removed',{name}));return request;};
   FileSystemDirectoryHandle.prototype.removeEntry=async function(name:string,options?:FileSystemRemoveOptions){await originalRemove.call(this,name,options);note('entry-removed',{name});};
   Blob.prototype.arrayBuffer=async function(){note('copied-buffer',{bytes:this.size,allocations:allocationLedger.snapshot()});return originalRead.call(this);};
   URL.createObjectURL=function(value:Blob|MediaSource){const url=originalURL.call(this,value),blobId=urls.size+1;urls.set(url,blobId);note('object-url',{blobId,file:value instanceof File,blob:value instanceof Blob,bytes:value instanceof Blob?value.size:null});return url;};
   URL.revokeObjectURL=function(url:string){originalRevoke.call(this,url);note('object-url-revoked',{blobId:urls.get(url),at:performance.now()});};
   HTMLAnchorElement.prototype.click=function(){note('anchor-click',{blobId:urls.get(this.href),at:performance.now(),resources:module.destinationResources(),allocations:allocationLedger.snapshot()});return originalClick.call(this);};
   const restore=()=>{Object.defineProperty(crypto,'randomUUID',{configurable:true,value:originalUUID});IDBObjectStore.prototype.add=originalAdd;IDBObjectStore.prototype.get=originalGet;IDBFactory.prototype.deleteDatabase=originalDelete;FileSystemDirectoryHandle.prototype.removeEntry=originalRemove;URL.createObjectURL=originalURL;URL.revokeObjectURL=originalRevoke;HTMLAnchorElement.prototype.click=originalClick;Blob.prototype.arrayBuffer=originalRead;};
   const run=async()=>{try{
    const status=await module.writeDestination({path:'/payload',name:'controlled-33m-'+releaseAction+'.bin',hash:payload.hash,bytes:String(payload.bytes)},(path:string,init?:RequestInit)=>fetch(path,init),null);
    // Exercise the real document-consumer release barrier immediately. There
    // is no extra download read, timer replacement, or completion signal here.
    const releaseStarted=performance.now(),beforeRelease=module.destinationResources();await module.settleDestinationDownloads();const releaseEnded=performance.now(),afterRelease=module.destinationResources();
    const root=await navigator.storage.getDirectory(),entries=[];for await(const [name]of(root as any).entries())entries.push(name);
    return {status,events,entries,databases:await indexedDB.databases(),release:{started:releaseStarted,ended:releaseEnded,elapsedMs:releaseEnded-releaseStarted,before:beforeRelease,after:afterRelease},allocationsBefore,storageBefore,storageAfterRelease:await navigator.storage.estimate(),allocationsAfterRelease:allocationLedger.snapshot()};
   }finally{restore();}};
   (window as any).destinationSuccess={module,pending:null};document.querySelector('button')!.addEventListener('click',()=>{const pending=run();void pending.catch(()=>{});(window as any).destinationSuccess.pending=pending;},{once:true});
  },{payload,fixedUUID,releaseAction});
  await rss.capture('prepared');const downloaded=f.page.waitForEvent('download',{timeout:180000});void downloaded.catch(()=>{});await f.page.getByRole('button',{name:'Download controlled copy',exact:true}).click();
  result=await f.page.evaluate(()=>(window as any).destinationSuccess.pending);await rss.capture('app-released-before-save');
  // All Playwright completion reads and saveAs are deliberately after the
  // application's native revocation. The second case also destroys the
  // creating document first while preserving the browser download context.
  if(releaseAction==='settle-and-navigate'){await f.page.goto(f.origin+'/after-release');result.documentReplacedBeforeSave=true;}
  else result.documentReplacedBeforeSave=false;
  const download=await downloaded,path=join(output,'native-destination-'+browserName+'-33m-'+releaseAction+'.bin');await download.saveAs(path);expect(await download.failure()).toBeNull();await rss.capture('download-saved');
  expect(await fileHash(path)).toBe(payload.hash);expect((await stat(path)).size).toBe(payload.bytes);expect(result.status).toBe('unconfirmed');expect(result.entries).toEqual([]);expect(result.databases).toEqual([]);
  const click=result.events.find((event:any)=>event.kind==='anchor-click'),removed=result.events.filter((event:any)=>event.kind==='entry-removed'||event.kind==='database-removed'),added=result.events.filter((event:any)=>event.kind==='chunk-add'),copied=result.events.filter((event:any)=>event.kind==='copied-buffer');
  expect(click).toBeTruthy();expect(click.allocations.byKind.blob.handles).toBe(2);expect(result.allocationsAfterRelease.activeRecords).toBe(result.allocationsBefore.activeRecords);expect(result.allocationsAfterRelease.cpuBytes).toBe(result.allocationsBefore.cpuBytes);expect(result.allocationsAfterRelease.handles).toBe(result.allocationsBefore.handles);expect(added.every((event:any)=>event.allocations.byKind.copy.cpuBytes>=event.bytes*2)).toBe(true);expect(removed).toHaveLength(2);expect(removed.every((event:any)=>event.sequence<click.sequence)).toBe(true);expect(added).toHaveLength(Math.ceil(payload.bytes/MiB));expect(added.every((event:any)=>event.blob&&!event.file&&event.bytes>0&&event.bytes<=MiB)).toBe(true);expect(copied).toHaveLength(added.length*2);expect(copied.every((event:any)=>event.bytes<=MiB&&event.allocations.byKind.copy.cpuBytes>=event.bytes*2)).toBe(true);
  expect(result.events.filter((event:any)=>event.kind==='object-url')).toEqual([{sequence:expect.any(Number),kind:'object-url',blobId:1,file:false,blob:true,bytes:payload.bytes}]);expect(click.resources).toMatchObject({spoolDatabases:0,spoolBytes:0,downloadBlobs:1,downloadBlobBytes:payload.bytes});
  const revoked=result.events.filter((event:any)=>event.kind==='object-url-revoked');expect(revoked).toHaveLength(1);expect(revoked[0].blobId).toBe(click.blobId);expect(revoked[0].sequence).toBeGreaterThan(click.sequence);expect(revoked[0].at).toBeLessThanOrEqual(result.release.ended);expect(revoked[0].at-click.at).toBeLessThan(1000);expect(result.release.elapsedMs).toBeLessThan(1000);
  expect(result.release.before.downloadBlobs).toBe(1);expect(result.release.after).toEqual({spoolDatabases:0,spoolBytes:0,downloadBlobs:0,downloadBlobBytes:0,copyingFallbacks:0});
  for(let index=0;index<4;index++){await new Promise(resolve=>setTimeout(resolve,125));await rss.capture('settled-'+index);}
  expect(downloads).toEqual(['controlled-33m-'+releaseAction+'.bin']);expect(f.errors).toEqual([]);expect(f.domErrors).toEqual([]);
 }finally{
  try{resources=await rss.stop();await f.close();}finally{await writeFile(join(output,'native-destination-success-'+browserName+'-'+releaseAction+'.json'),JSON.stringify({browserName,releaseAction,result,resources,downloads,requests:f.requests,sourceHashes:f.sourceHashes,errors:f.errors,domErrors:f.domErrors,ledger:f.guard.ledger,limits:'Real native OPFS, IndexedDB, non-File Blob and browser download saveAs/hash after actual application URL revocation. One case replaces the creating document after its immediate release barrier and before saveAs. API observers forward native operations; no sleeps or mocked timers authorize revocation. Release latency uses one browser performance.now clock with an asserted <1 s target. No OS picker, full production editor close workflow, 100-cycle R19 growth, 4 GiB qualification or universal native memory-cap claim.'},null,2));}
 }
});

test('native IDB migration cancellation and cleanup refusal preserve ownership',async({playwright,browserName})=>{
 test.setTimeout(180000);const output=resolve(specReceipt(import.meta.url,'artifacts/p1b7/current'));await mkdir(output,{recursive:true});const f=await fixture(playwright[browserName],browserName),downloads:string[]=[];let result:any;f.page.on('download',download=>downloads.push(download.suggestedFilename()));
 try{
  result=await f.page.evaluate(async({payload,fixedUUID})=>{
   const modulePath='/src/state/destination.js',module=await import(modulePath),root=await navigator.storage.getDirectory(),outcomes:any[]=[];
   const names=async()=>{const entries=[];for await(const [name]of(root as any).entries())entries.push(name);return entries.sort();};
   const nativeOpen=IDBFactory.prototype.open,nativeDelete=IDBFactory.prototype.deleteDatabase,nativeAdd=IDBObjectStore.prototype.add,nativeGet=IDBObjectStore.prototype.get,nativeUUID=crypto.randomUUID;
   const removeDB=(name:string)=>new Promise<void>((resolve,reject)=>{const request=nativeDelete.call(indexedDB,name);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Fixture cleanup blocked'));});
   const spool='ie-download-spool-'+fixedUUID;
   for(const mode of ['cancel-add','cancel-get','collision','blocked-delete-cancel']){
    const controller=new AbortController(),reason=new DOMException('Controlled '+mode,'AbortError');let triggered=false,adds=0,gets=0,deletes=0,blocked=false,held:IDBDatabase|undefined,deleteDone:Promise<void>|undefined,caught:unknown,status:unknown;
    Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=>fixedUUID});
    if(mode==='collision')await new Promise<void>((resolve,reject)=>{const request=nativeOpen.call(indexedDB,spool,1);request.onupgradeneeded=()=>request.result.createObjectStore('sentinel');request.onsuccess=()=>{const db=request.result,tx=db.transaction('sentinel','readwrite');tx.objectStore('sentinel').put('foreign exact bytes','owned');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};request.onerror=()=>reject(request.error);});
    IDBObjectStore.prototype.add=function(value:any,key?:IDBValidKey){const request=nativeAdd.call(this,value,key);if(this.name==='chunks'){adds++;if(mode==='cancel-add'&&!triggered)request.addEventListener('success',()=>{if(!triggered){triggered=true;controller.abort(reason);}},{once:true});}return request;};
    IDBObjectStore.prototype.get=function(key:IDBValidKey|IDBKeyRange){const request=nativeGet.call(this,key);if(this.name==='chunks'){gets++;if(mode==='cancel-get'&&!triggered)request.addEventListener('success',()=>{if(!triggered){triggered=true;controller.abort(reason);}},{once:true});}return request;};
    IDBFactory.prototype.deleteDatabase=function(name:string){
     deletes++;
     if(mode==='blocked-delete-cancel'&&!triggered&&name===spool){
      triggered=true;const blocker=nativeOpen.call(this,name);blocker.onsuccess=()=>{held=blocker.result;};
      const request=nativeDelete.call(this,name);deleteDone=new Promise<void>((resolve,reject)=>{request.addEventListener('success',()=>resolve());request.addEventListener('error',()=>reject(request.error));});void deleteDone.catch(()=>{});
      request.addEventListener('blocked',()=>{blocked=true;controller.abort(reason);},{once:true});return request;
     }
     return nativeDelete.call(this,name);
    };
    try{status=await module.writeDestination({path:'/small',name:'must-not-download.bin',hash:payload.hash,bytes:String(payload.bytes)},(path:string,init?:RequestInit)=>fetch(path,init),null,controller.signal);}catch(error){caught=error;}
    finally{IDBObjectStore.prototype.add=nativeAdd;IDBObjectStore.prototype.get=nativeGet;IDBFactory.prototype.deleteDatabase=nativeDelete;Object.defineProperty(crypto,'randomUUID',{configurable:true,value:nativeUUID});}
    let sentinel:unknown;
    if(mode==='collision')sentinel=await new Promise((resolve,reject)=>{const request=nativeOpen.call(indexedDB,spool);request.onsuccess=()=>{const db=request.result,tx=db.transaction('sentinel'),get=tx.objectStore('sentinel').get('owned');get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);tx.oncomplete=()=>db.close();};request.onerror=()=>reject(request.error);});
    const beforeFixtureCleanup={entries:await names(),databases:(await indexedDB.databases()).map(db=>db.name).sort(),resources:module.destinationResources()};
    outcomes.push({mode,status:status??null,sameReason:caught===reason,errorName:(caught as Error)?.name,errorMessage:(caught as Error)?.message,aggregate:caught instanceof AggregateError,triggered,adds,gets,deletes,blocked,sentinel:sentinel??null,beforeFixtureCleanup});
    held?.close();if(deleteDone)await deleteDone;if(mode==='collision')await removeDB(spool);
    const afterFixtureCleanup={entries:await names(),databases:await indexedDB.databases(),resources:module.destinationResources()};outcomes[outcomes.length-1].afterFixtureCleanup=afterFixtureCleanup;
   }
   return outcomes;
  },{payload:f.payloads.get('/small')!,fixedUUID});
  for(const item of result){expect(item.status).toBeNull();expect(item.beforeFixtureCleanup.entries).toEqual([]);expect(item.afterFixtureCleanup.entries).toEqual([]);expect(item.afterFixtureCleanup.databases).toEqual([]);expect(item.afterFixtureCleanup.resources).toEqual({spoolDatabases:0,spoolBytes:0,downloadBlobs:0,downloadBlobBytes:0,copyingFallbacks:0});}
  for(const mode of ['cancel-add','cancel-get']){const item=result.find((entry:any)=>entry.mode===mode);expect(item.triggered).toBe(true);expect(item.sameReason).toBe(true);expect(item.aggregate).toBe(false);expect(item.beforeFixtureCleanup.databases).toEqual([]);expect(item.deletes).toBe(1);}
  const collision=result.find((entry:any)=>entry.mode==='collision');expect(collision.errorMessage).toBe('DOWNLOAD_SPOOL_COLLISION');expect(collision.sentinel).toBe('foreign exact bytes');expect(collision.deletes).toBe(0);expect(collision.beforeFixtureCleanup.databases).toEqual(['ie-download-spool-'+fixedUUID]);expect(collision.beforeFixtureCleanup.resources.spoolDatabases).toBe(0);
  const blocked=result.find((entry:any)=>entry.mode==='blocked-delete-cancel');expect(blocked.blocked).toBe(true);expect(blocked.aggregate).toBe(true);expect(blocked.errorMessage).toMatch(/cleanup incomplete/i);expect(blocked.beforeFixtureCleanup.databases).toEqual(['ie-download-spool-'+fixedUUID]);expect(blocked.beforeFixtureCleanup.resources.spoolDatabases).toBe(1);
  expect(downloads).toEqual([]);expect(f.errors).toEqual([]);expect(f.domErrors).toEqual([]);
 }finally{try{await f.close();}finally{await writeFile(join(output,'native-destination-spool-faults-'+browserName+'.json'),JSON.stringify({browserName,result,downloads,requests:f.requests,sourceHashes:f.sourceHashes,errors:f.errors,domErrors:f.domErrors,ledger:f.guard.ledger,limits:'Native IndexedDB/OPFS operations with forwarding event observers and an explicit second connection holding deletion. The test closes its own blocker after product reports cleanup failure; that later cleanup is not attributed to the product.'},null,2));}}
});

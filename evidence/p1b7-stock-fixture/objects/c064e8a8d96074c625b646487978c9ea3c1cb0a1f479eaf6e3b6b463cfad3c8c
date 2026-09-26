import type {BrowserContext,Frame,Page,Worker} from '@playwright/test';
import {randomUUID} from 'node:crypto';

// Controlled test origins, not a security boundary against an independent
// same-origin writer. Install on a newly created context before any navigation.
// A dirty/unexpected origin permanently forbids context-wide storage reset.
// Native file methods and the product's download lifetime are left untouched.
export async function ownedOPFS(context:BrowserContext,profile:string){
 const run=randomUUID(),admitted=new Set<string>(),visited=new Set<string>();
 const pages=new Set<Page>(),workers=new Set<Worker>(),probes=new Map<Page,string>();
 const cookieValues=new Set<string>(),cookieWork=new Set<Promise<void>>();
 const reasons:string[]=[],ledger:any[]=[{phase:'fixture',run,profile,contract:'controlled-origin-v2'}];
 let phase='active',completed=false,closed=false,resetCalls=0;
 const refuse=(reason:string)=>{if(!reasons.includes(reason)){reasons.push(reason);ledger.push({phase:'refused',reason});}};
 const stop=(page:Page|undefined)=>{if(page&&!page.isClosed())void page.close().catch(()=>{ledger.push({phase:'page-stop-incomplete'});refuse('PAGE_STOP_FAILED');});};
 const originOf=(url:string)=>{try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)?u.origin:null;}catch{return null;}};
 const observe=(url:string,page?:Page)=>{
  const origin=originOf(url);
  if(origin){visited.add(origin);if(!admitted.has(origin)&&(!page||probes.get(page)!==origin))refuse('UNADMITTED_ORIGIN: '+origin);}
  else if(url!=='about:blank'&&url!=='about:srcdoc'&&!(url.startsWith('blob:')&&admitted.has(new URL(url).origin)))refuse('UNEXPECTED_NON_HTTP_DOCUMENT');
 };
 const register=(page:Page)=>{
  if(pages.has(page))return;pages.add(page);ledger.push({phase:'page-registered'});
  if(phase==='closing'||phase==='complete')refuse('PAGE_CREATED_DURING_CLEANUP');
  observe(page.url(),page);
  page.on('framenavigated',(frame:Frame)=>observe(frame.url(),page));
  page.on('worker',worker=>{workers.add(worker);ledger.push({phase:'worker-registered'});worker.on('close',()=>workers.delete(worker));});
 };
 context.on('page',register);for(const page of context.pages())register(page);
 context.on('close',()=>{closed=true;});
 context.on('serviceworker',()=>refuse('UNOWNED_SERVICE_WORKER'));
 if(context.serviceWorkers().length)refuse('PREEXISTING_SERVICE_WORKER');
 const initialCookies=await context.cookies();ledger.push({phase:'initial-cookies',count:initialCookies.length});
 if(initialCookies.length)refuse('CONTEXT_NOT_FRESH');
 context.on('response',response=>{
  const work=(async()=>{
   const headers=await response.headersArray();
   for(const header of headers.filter(h=>h.name.toLowerCase()==='set-cookie')){
    const url=new URL(response.url()),parts=header.value.split(';').map(p=>p.trim()),pair=parts[0].split('=');
    if(!admitted.has(url.origin)||!['/api/v1/session/bootstrap','/api/v1/session/renew','/api/v1/session/revoke'].includes(url.pathname)||response.request().method()!=='POST'||pair[0]!=='ie_session'||!parts.includes('HttpOnly')||!parts.includes('SameSite=Strict')||!parts.includes('Path=/')||parts.some(p=>/^Domain=/i.test(p))){refuse('UNEXPECTED_COOKIE_RESPONSE');continue;}
    cookieValues.add(pair.slice(1).join('='));
    ledger.push({phase:'owned-cookie-response',origin:url.origin,path:url.pathname,name:'ie_session',httpOnly:true,sameSite:'Strict'});
   }
  })().catch(()=>refuse('COOKIE_RESPONSE_UNAVAILABLE'));
  cookieWork.add(work);void work.then(()=>cookieWork.delete(work));
 });
 async function auditCookies(){
  await Promise.all(cookieWork);
  const cookies=await context.cookies();
  ledger.push({phase:'cookie-audit',count:cookies.length,metadata:cookies.map(({name,domain,path,httpOnly,secure,sameSite})=>({name,domain,path,httpOnly,secure,sameSite}))});
  if(cookies.some(c=>c.name!=='ie_session'||c.domain!=='127.0.0.1'||c.path!=='/'||!c.httpOnly||c.sameSite!=='Strict'||!cookieValues.has(c.value)))refuse('UNEXPECTED_COOKIE_OWNERSHIP');
 }
 // Observe product traffic without enabling interception or disabling its cache.
 // Unexpected traffic fails acceptance and cleanup; this is not a firewall.
 context.on('request',request=>{
  const url=new URL(request.url());
  let page:Page|undefined;try{page=request.frame().page();}catch{refuse('UNOWNED_REQUEST');}
  if(url.protocol==='blob:'&&phase==='active'&&admitted.has(url.origin)&&page&&pages.has(page)){
   ledger.push({phase:'owned-blob',origin:url.origin,resourceType:request.resourceType()});return;
  }
  if(!['http:','https:'].includes(url.protocol)){ledger.push({phase:'unplanned-protocol',protocol:url.protocol,origin:url.origin});refuse('UNEXPECTED_NETWORK_PROTOCOL');stop(page);return;}
  visited.add(url.origin);
  if(page&&probes.get(page)===url.origin&&url.pathname==='/__e1_storage_'+run)return;
  if(phase==='active'&&admitted.has(url.origin)&&page&&pages.has(page))return;
  refuse('UNPLANNED_REQUEST: '+url.origin);stop(page);
 });
 async function nativeState(origin:string){
  const probe=await context.newPage();probes.set(probe,origin);
  try{
   const url=origin+'/__e1_storage_'+run;
   await probe.route(url,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Controlled storage observation</title>'}));
   await probe.goto(url);
   return await probe.evaluate(async()=>{
    const root=await navigator.storage.getDirectory(),entries:{name:string;kind:string}[]=[];
    for await(const [name,entry] of (root as any).entries())entries.push({name,kind:entry.kind});
    const registrations=await navigator.serviceWorker?.getRegistrations()??[];
    return {entries,localStorage:localStorage.length,indexedDB:(await indexedDB.databases()).map(d=>d.name),serviceWorkers:registrations.length};
   });
  }finally{await probe.close();probes.delete(probe);}
 }
 function assertEmpty(state:Awaited<ReturnType<typeof nativeState>>){
  if(state.entries.length||state.localStorage||state.indexedDB.length||state.serviceWorkers)throw Error('OPFS_DIRTY_ORIGIN');
 }
 return {run,ledger,
  async admit(_page:Page,origin:string){
   ledger.push({phase:'preflight-start',origin,profile});
   try{
    const u=new URL(origin);if(u.origin!==origin||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port)throw Error('ORIGIN_NOT_CONTROLLED');
    if(phase!=='active'||admitted.has(origin))throw Error('OPFS_ORIGIN_REUSED');
    await auditCookies();const state=await nativeState(origin);ledger.push({phase:'preflight',origin,...state,cookieCount:(await context.cookies()).length});assertEmpty(state);
    if(reasons.length)throw Error('CONTEXT_OWNERSHIP_UNCERTAIN');
    admitted.add(origin);ledger.push({phase:'admitted',origin});
   }catch(e){refuse('ADMISSION_FAILED: '+origin);ledger.push({phase:'admission-error',origin,error:String(e)});throw e;}
  },
  async cleanup(){
   if(completed)return;
   if(phase!=='active')throw Error('OPFS_CLEANUP_ALREADY_ATTEMPTED');
   ledger.push({phase:'cleanup-start',admitted:[...admitted],visited:[...visited],resetCalls});
   try{
    if(closed)throw Error('OPFS_CONTEXT_CLOSED');
    if(reasons.length||[...visited].some(o=>!admitted.has(o)))throw Error('OPFS_RESET_REFUSED');
    phase='closing';await Promise.all(context.pages().map(p=>p.close()));await auditCookies();
    if(reasons.length)throw Error('OPFS_RESET_REFUSED');
    if(context.pages().length||workers.size||context.serviceWorkers().length)throw Error('OPFS_WRITERS_NOT_QUIESCENT');
    phase='resetting';resetCalls++;ledger.push({phase:'public-reset',resetCalls});
    await context.setStorageState({cookies:[],origins:[]});
    phase='verifying';
    for(const origin of admitted){const state=await nativeState(origin);ledger.push({phase:'post-reset',origin,...state});assertEmpty(state);}
    const cookies=await context.cookies();ledger.push({phase:'post-reset-cookies',count:cookies.length});
    if(cookies.length||reasons.length)throw Error('OPFS_RESET_INCOMPLETE');
    phase='complete';completed=true;ledger.push({phase:'cleanup-complete',resetCalls});
   }catch(e){phase='incomplete';ledger.push({phase:'cleanup-incomplete',resetCalls,error:String(e),reasons:[...reasons]});throw e;}
  },
  verify(){if(!completed)throw Error('OPFS_CLEANUP_INCOMPLETE');}
 };
}

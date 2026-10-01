import {specReceipt} from './receipt-path.js';
import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ownedOPFS} from './owned-opfs.js';
import {recordDOMErrors} from './error-monitor.js';

// Exercise the actual adapter against native OPFS and HTTP, without a storage
// replacement or OS-picker claim. E1 separately covers real blob downloads.
test('destination failure cleanup preserves original errors, collisions and selected destinations',async({playwright,browserName})=>{
 const bytes=Buffer.from([0,255,10,13,127,128]),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
 const modules=new Map(await Promise.all(['state/destination','protocol/sha256','observability/allocations'].map(async name=>['/src/'+name+'.js',stripTypeScriptTypes(await readFile('src/'+name+'.ts','utf8'))] as const)));
 const server=createServer((request,response)=>{
  const path=request.url??'/';
  if(modules.has(path)){response.setHeader('Content-Type','text/javascript');response.end(modules.get(path));}
  else if(path.startsWith('/payload')){response.setHeader('ETag','"'+hash+'"');response.setHeader('Content-Length',String(bytes.length));response.end(path==='/payload-corrupt'?Buffer.alloc(bytes.length,1):bytes);}
  else response.end('<!doctype html><title>Native destination controls</title>');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'ie-destination-')):undefined;
 const browser=profile?undefined:await playwright[browserName].launch();
 const context=profile?await playwright.webkit.launchPersistentContext(profile):await browser!.newContext();
 await Promise.all(context.pages().map(p=>p.close()));const domErrors=await recordDOMErrors(context),guard=await ownedOPFS(context,profile??browserName+' ephemeral'),page=await context.newPage(),errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));let results:unknown;
 try{
  await guard.admit(page,origin);await page.goto(origin);
  results=await page.evaluate(async({hash,bytes,browserName})=>{
   const modulePath='/src/state/destination.js';const {writeDestination}=await import(modulePath),root=await navigator.storage.getDirectory();
   const names=async()=>{const out=[];for await(const [n] of (root as any).entries())out.push(n);return out.sort();};
   const download={path:'/payload',name:'controlled.bin',hash,bytes:String(bytes.length),kind:'copy',documentId:'controlled',revision:'1',status:'ready'};
   const outcomes:any[]=[];
   for(const kind of ['metadata','corrupt','network']){
    const primary=Error('CONTROLLED_NETWORK_CANCELLED');let caught:unknown;
    try{await writeDestination(download,async()=>{if(kind==='network')throw primary;return fetch(kind==='corrupt'?'/payload-corrupt':'/');},null);}catch(e){caught=e;}
    outcomes.push({kind,message:caught instanceof Error?caught.message:String(caught),samePrimary:kind==='network'?caught===primary:undefined,remaining:await names()});
   }
   const originalUUID=crypto.randomUUID;const fixed='00000000-0000-4000-8000-000000000000',collision='ie-download-'+fixed;
   const file=await root.getFileHandle(collision,{create:true}),writer=await file.createWritable();await writer.write(new Uint8Array(bytes));await writer.close();let collisionError='';
   Object.defineProperty(crypto,'randomUUID',{value:()=>fixed,configurable:true});
   try{await writeDestination(download,()=>fetch('/payload'),null);}catch(e){collisionError=(e as Error).message;}finally{Object.defineProperty(crypto,'randomUUID',{value:originalUUID,configurable:true});}
   outcomes.push({kind:'collision',message:collisionError,bytes:[...new Uint8Array(await(await file.getFile()).arrayBuffer())],remaining:await names()});await root.removeEntry(collision);
   let calls=0;const cancelled=new DOMException('Selection canceled','AbortError');let cancellation:unknown;
   try{await writeDestination(download,()=>{calls++;return fetch('/payload');},Promise.reject(cancelled));}catch(e){cancellation=e;}
   outcomes.push({kind:'cancel',samePrimary:cancellation===cancelled,calls,remaining:await names()});
   // A chosen native handle models the destination contract, not an OS dialog.
   const selected=await root.getFileHandle('selected-controlled',{create:true});const w=await selected.createWritable();await w.write(new Uint8Array(bytes));await w.close();
   const primary=Error('SELECTED_TRANSPORT_FAILED');let failure:unknown;
   try{await writeDestination(download,async()=>{throw primary;},Promise.resolve(selected));}catch(e){failure=e;}
   outcomes.push({kind:'selected-failure',samePrimary:failure===primary,bytes:[...new Uint8Array(await(await selected.getFile()).arrayBuffer())],remaining:await names()});
   const success=await writeDestination(download,()=>fetch('/payload'),Promise.resolve(selected));
   outcomes.push({kind:'selected-success',status:success,bytes:[...new Uint8Array(await(await selected.getFile()).arrayBuffer())],remaining:await names()});
   await root.removeEntry('selected-controlled');
   if(browserName==='chromium'){
    // Chromium's real second native writable holds a file lock after the
    // adapter aborts its own writer. Removal must report failure, not success.
    let held:FileSystemWritableFileStream|undefined,name:string|undefined,caught:unknown;const primary=Error('LOCKED_TRANSPORT_FAILED');
    try{await writeDestination(download,async()=>{[name]=await names();held=await(await root.getFileHandle(name!)).createWritable();throw primary;},null);}catch(e){caught=e;}
    try{const nativeEntries=await names();outcomes.push({kind:'cleanup-failure',message:(caught as Error)?.message,samePrimary:(caught as AggregateError)?.cause===primary,primaryRetained:(caught as AggregateError)?.errors?.[0]===primary,nativeCleanupError:(caught as AggregateError)?.errors?.[1] instanceof DOMException,attemptPresent:nativeEntries.includes(name!),nativeEntries});}
    finally{await held?.abort();if(name)await root.removeEntry(name);}
   }
   return outcomes;
  },{hash,bytes:[...bytes],browserName});
  expect(results).toEqual([
   {kind:'metadata',message:'DOWNLOAD_UNAVAILABLE',samePrimary:undefined,remaining:[]},
   {kind:'corrupt',message:'DOWNLOAD_CORRUPT',samePrimary:undefined,remaining:[]},
   {kind:'network',message:'CONTROLLED_NETWORK_CANCELLED',samePrimary:true,remaining:[]},
   {kind:'collision',message:'DOWNLOAD_TEMPORARY_COLLISION',bytes:[...bytes],remaining:['ie-download-00000000-0000-4000-8000-000000000000']},
   {kind:'cancel',samePrimary:true,calls:0,remaining:[]},
   {kind:'selected-failure',samePrimary:true,bytes:[...bytes],remaining:['selected-controlled']},
   {kind:'selected-success',status:'confirmed',bytes:[...bytes],remaining:['selected-controlled']},
   ...(browserName==='chromium'?[{kind:'cleanup-failure',message:'LOCKED_TRANSPORT_FAILED; download cleanup incomplete',samePrimary:true,primaryRetained:true,nativeCleanupError:true,attemptPresent:true,nativeEntries:expect.any(Array)}]:[])
  ]);
  expect(errors).toEqual([]);expect(domErrors).toEqual([]);
 }finally{
  try{await guard.cleanup();guard.verify();}finally{await context.close();await browser?.close();if(profile)await rm(profile,{recursive:true});await new Promise<void>(r=>server.close(()=>r()));const receipt=specReceipt(import.meta.url,'artifacts/p1b7/current');await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'native-destination.json'),JSON.stringify({browserName,results,errors,domErrors,ledger:guard.ledger},null,2));}
 }
});

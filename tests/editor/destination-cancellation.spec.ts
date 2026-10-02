import {specReceipt} from './receipt-path.js';
import {test,expect} from '@playwright/test';
import {createServer,type ServerResponse} from 'node:http';
import {transformSync} from 'rolldown/utils';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ownedOPFS} from './owned-opfs.js';
import {recordDOMErrors} from './error-monitor.js';

// The production adapter, native OPFS writers, and native ReadableStreams are
// exercised here. Picker selection is controlled; this is not OS-dialog proof.
test('destination cancellation stops writes and retains the prior committed file',async({playwright,browserName})=>{
 const bytes=Buffer.from([0,255,10,13,127,128]),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
 const sources=await Promise.all(['state/destination','protocol/sha256','observability/allocations','observability/diagnostic-memory','observability/composition-observations'].map(async name=>({name,source:await readFile('src/'+name+'.ts','utf8')})));
 const modules=new Map(sources.map(({name,source})=>{const transformed=transformSync(name+'.ts',source);if(transformed.errors.length)throw Error(transformed.errors.map(error=>error.message).join('; '));return ['/src/'+name+'.js',transformed.code];}));
 let pendingFetchStarted=false;const pendingFetchObservers:ServerResponse[]=[];
 const server=createServer((request,response)=>{
  const path=request.url??'/',source=modules.get(path);
  if(source){response.setHeader('Content-Type','text/javascript');response.end(source);}
  else if(path==='/pending'){pendingFetchStarted=true;for(const observer of pendingFetchObservers.splice(0))observer.end('started');}
  else if(path==='/pending-started'){if(pendingFetchStarted)response.end('started');else pendingFetchObservers.push(response);}
  else if(path==='/stream'){response.setHeader('ETag','"'+hash+'"');response.setHeader('Content-Length',String(bytes.length));response.write(bytes.subarray(0,3));}
  else response.end('<!doctype html><title>Destination cancellation</title>');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const profile=browserName==='webkit'?await mkdtemp(join(await realpath(tmpdir()),'ie-destination-cancel-')):undefined;
 const browser=profile?undefined:await playwright[browserName].launch();
 const context=profile?await playwright.webkit.launchPersistentContext(profile):await browser!.newContext();
 await Promise.all(context.pages().map(p=>p.close()));const domErrors=await recordDOMErrors(context),guard=await ownedOPFS(context,profile??browserName+' ephemeral'),page=await context.newPage(),errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));let results:unknown;
 try{
  await guard.admit(page,origin);await page.goto(origin);
  results=await page.evaluate(async({hash,bytes})=>{
   const modulePath='/src/state/destination.js';const {chooseDestination,writeDestination}=await import(modulePath),root=await navigator.storage.getDirectory();
   const names=async()=>{const out=[];for await(const [n] of (root as any).entries())out.push(n);return out.sort();};
   const download={path:'/payload',name:'controlled.bin',hash,bytes:String(bytes.length)},prior=[9,8,7],outcomes:any[]=[];
   const selected=await root.getFileHandle('selected',{create:true});
   const reset=async()=>{const writer=await selected.createWritable();await writer.write(new Uint8Array(prior));await writer.close();};
   const saved=async()=>[...new Uint8Array(await(await selected.getFile()).arrayBuffer())];
   const response=(body:ReadableStream<Uint8Array>|Uint8Array)=>new Response(body as BodyInit,{headers:{etag:'"'+hash+'"','content-length':String(bytes.length)}});
   await reset();
   {
    const controller=new AbortController(),reason=new DOMException('Canceled before picker','AbortError');controller.abort(reason);
    const original=Object.getOwnPropertyDescriptor(window,'showSaveFilePicker');let pickerCalls=0,transportCalls=0,caught:unknown;
    Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>{pickerCalls++;return selected;}});
    try{await writeDestination(download,async()=>{transportCalls++;return response(new Uint8Array(bytes));},chooseDestination('controlled.bin',controller.signal),controller.signal);}catch(error){caught=error;}
    finally{if(original)Object.defineProperty(window,'showSaveFilePicker',original);else delete (window as any).showSaveFilePicker;}
    outcomes.push({kind:'before-picker',sameReason:caught===reason,pickerCalls,transportCalls,bytes:await saved()});
   }
   {
    const controller=new AbortController(),reason=new DOMException('Canceled during picker','AbortError');let finish!:(value:any)=>void,creates=0,transportCalls=0;
    const chosen=new Promise(resolve=>{finish=resolve;}),pending=writeDestination(download,async()=>{transportCalls++;return response(new Uint8Array(bytes));},chosen,controller.signal).then((status:unknown)=>({status,error:undefined}), (error:unknown)=>({error,status:undefined}));
    controller.abort(reason);const result=await pending;
    finish({createWritable:async()=>{creates++;return selected.createWritable();}});await Promise.resolve();await Promise.resolve();
    outcomes.push({kind:'pending-picker',sameReason:result.error===reason,confirmed:result.status==='confirmed',creates,transportCalls,bytes:await saved()});
   }
   {
    const controller=new AbortController(),reason=new DOMException('Canceled pending fetch','AbortError');let signalPassed=false,writes=0,closes=0,aborts=0,caught:unknown,fetchSettled:Promise<boolean>|undefined;
    const chosen=Promise.resolve({createWritable:async()=>{const writer=await selected.createWritable();return {write:async(data:ArrayBuffer)=>{writes++;await writer.write(data);},close:async()=>{closes++;await writer.close();},abort:async()=>{aborts++;await writer.abort();}};}});
    try{await writeDestination(download,(_path:string,init?:RequestInit)=>{
     signalPassed=init?.signal===controller.signal;const fetching=fetch('/pending',init);fetchSettled=fetching.then(()=>false,error=>error===reason||error?.name==='AbortError');
     void fetch('/pending-started').then(()=>controller.abort(reason));return fetching;
    },chosen,controller.signal);}catch(error){caught=error;}
    outcomes.push({kind:'pending-fetch',sameReason:caught===reason,signalPassed,nativeFetchCanceled:await fetchSettled,writes,closes,aborts,bytes:await saved()});
   }
   {
    const controller=new AbortController(),reason=new DOMException('Canceled late transport','AbortError');let finish!:(value:Response)=>void,started!:()=>void,streamCancellations=0,signalPassed=false;
    const responseStarted=new Promise<void>(resolve=>{started=resolve;});
    const completion=writeDestination(download,(_path:string,init?:RequestInit)=>{signalPassed=init?.signal===controller.signal;started();return new Promise<Response>(resolve=>{finish=resolve;});},Promise.resolve(selected),controller.signal).then((status:unknown)=>({status,error:undefined}),(error:unknown)=>({status:undefined,error}));
    await responseStarted;controller.abort(reason);const result=await completion;
    finish(response(new ReadableStream<Uint8Array>({cancel(){streamCancellations++;}})));await Promise.resolve();await Promise.resolve();
    outcomes.push({kind:'late-response',sameReason:result.error===reason,confirmed:result.status==='confirmed',signalPassed,streamCancellations,bytes:await saved()});
   }
   {
    const controller=new AbortController(),reason=new DOMException('Canceled active fetch body','AbortError');let writes=0,closes=0,aborts=0,caught:unknown;
    const chosen=Promise.resolve({createWritable:async()=>{const writer=await selected.createWritable();return {write:async(data:ArrayBuffer)=>{await writer.write(data);writes++;controller.abort(reason);},close:async()=>{closes++;await writer.close();},abort:async()=>{aborts++;await writer.abort();}};}});
    try{await writeDestination(download,(_path:string,init?:RequestInit)=>fetch('/stream',init),chosen,controller.signal);}catch(error){caught=error;}
    outcomes.push({kind:'active-fetch-body',sameReason:caught===reason,cleanupIncomplete:caught instanceof AggregateError,writes,closes,aborts,bytes:await saved()});
   }
   for(const stage of ['mid-stream','pending-write','before-close','after-commit']){
    await reset();const controller=new AbortController(),reason=new DOMException('Canceled '+stage,'AbortError');let writes=0,closes=0,aborts=0,streamCancellations=0;const phases:string[]=[];
    const chosen=Promise.resolve({createWritable:async()=>{
     const writer=await selected.createWritable();return {
      write:async(data:ArrayBuffer)=>{writes++;const writing=writer.write(data);if(stage==='pending-write')controller.abort(reason);await writing;if(stage==='mid-stream'&&writes===1)controller.abort(reason);},
      close:async()=>{closes++;await writer.close();if(stage==='after-commit')controller.abort(reason);},
      abort:async()=>{aborts++;await writer.abort();}
     };
    }});
    const body=new ReadableStream<Uint8Array>({start(stream){if(stage==='mid-stream'){stream.enqueue(new Uint8Array(bytes.slice(0,3)));stream.enqueue(new Uint8Array(bytes.slice(3)));}else{stream.enqueue(new Uint8Array(bytes));stream.close();}},cancel(){streamCancellations++;}});
    let caught:unknown,status:unknown;try{status=await writeDestination(download,async()=>response(body),chosen,controller.signal,(phase:string)=>{phases.push(phase);if(stage==='before-close'&&phase==='committing')controller.abort(reason);});}catch(error){caught=error;}
    outcomes.push({kind:stage,sameReason:caught===reason,confirmed:status==='confirmed',writes,closes,aborts,streamCancellations,phases,bytes:await saved()});
   }
   {
    await reset();const controller=new AbortController(),reason=new DOMException('Canceled with reader cleanup failure','AbortError'),cleanupFailure=Error('CONTROLLED_READER_CLEANUP_FAILED');let closes=0,aborts=0,caught:unknown;
    const chosen=Promise.resolve({createWritable:async()=>{const writer=await selected.createWritable();return {write:async(data:ArrayBuffer)=>{await writer.write(data);controller.abort(reason);},close:async()=>{closes++;await writer.close();},abort:async()=>{aborts++;await writer.abort();}};}});
    const body=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new Uint8Array(bytes.slice(0,3)));},cancel(){throw cleanupFailure;}});
    try{await writeDestination(download,async()=>response(body),chosen,controller.signal);}catch(error){caught=error;}
    const aggregate=caught as AggregateError;outcomes.push({kind:'reader-cleanup-failure',aggregate:aggregate instanceof AggregateError,sameReason:aggregate.cause===reason,failuresRetained:aggregate.errors?.[0]===reason&&aggregate.errors?.[1]===cleanupFailure,closes,aborts,bytes:await saved()});
   }
   await root.removeEntry('selected');
   {
    const controller=new AbortController(),reason=new DOMException('Canceled temporary file','AbortError');let transportCalls=0,caught:unknown;const phases:string[]=[];
    try{await writeDestination(download,async()=>{transportCalls++;return response(new Uint8Array(bytes));},null,controller.signal,(phase:string)=>{phases.push(phase);if(phase==='committing')controller.abort(reason);});}catch(error){caught=error;}
    outcomes.push({kind:'temporary',sameReason:caught===reason,transportCalls,phases,remaining:await names()});
   }
   return outcomes;
  },{hash,bytes:[...bytes]});
  expect(results).toEqual([
   {kind:'before-picker',sameReason:true,pickerCalls:0,transportCalls:0,bytes:[9,8,7]},
   {kind:'pending-picker',sameReason:true,confirmed:false,creates:0,transportCalls:0,bytes:[9,8,7]},
   {kind:'pending-fetch',sameReason:true,signalPassed:true,nativeFetchCanceled:true,writes:0,closes:0,aborts:1,bytes:[9,8,7]},
   {kind:'late-response',sameReason:true,confirmed:false,signalPassed:true,streamCancellations:1,bytes:[9,8,7]},
   {kind:'active-fetch-body',sameReason:true,cleanupIncomplete:false,writes:1,closes:0,aborts:1,bytes:[9,8,7]},
   {kind:'mid-stream',sameReason:true,confirmed:false,writes:1,closes:0,aborts:1,streamCancellations:1,phases:['receiving'],bytes:[9,8,7]},
   {kind:'pending-write',sameReason:true,confirmed:false,writes:1,closes:0,aborts:expect.any(Number),streamCancellations:0,phases:['receiving'],bytes:[9,8,7]},
   {kind:'before-close',sameReason:true,confirmed:false,writes:1,closes:0,aborts:1,streamCancellations:0,phases:['receiving','committing'],bytes:[9,8,7]},
   {kind:'after-commit',sameReason:true,confirmed:false,writes:1,closes:1,aborts:1,streamCancellations:0,phases:['receiving','committing'],bytes:[...bytes]},
   {kind:'reader-cleanup-failure',aggregate:true,sameReason:true,failuresRetained:true,closes:0,aborts:1,bytes:[9,8,7]},
   {kind:'temporary',sameReason:true,transportCalls:1,phases:['receiving','committing'],remaining:[]}
  ]);
  expect(errors).toEqual([]);expect(domErrors).toEqual([]);
 }finally{
  try{await guard.cleanup();guard.verify();}finally{await context.close();await browser?.close();if(profile)await rm(profile,{recursive:true});await new Promise<void>(r=>server.close(()=>r()));const receipt=specReceipt(import.meta.url,'artifacts/p1b7/current');await mkdir(receipt,{recursive:true});await writeFile(join(receipt,'native-destination-cancellation.json'),JSON.stringify({browserName,results,errors,domErrors,ledger:guard.ledger,limits:'Actual native OPFS and stream APIs; controlled picker, no OS-dialog proof. Cancellation after native close begins cannot promise rollback and never reports confirmed success.'},null,2));}
 }
});

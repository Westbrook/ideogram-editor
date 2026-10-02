// Runs in the shared Node test runner, with one real pinned Chromium process.
// HTTP and module graphs are real: no Response/reader/controller replacement.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {transformWithOxc} from 'vite';

test('real Chromium HTTP 204 owned JSON drains its empty native body and releases the retained owner', {timeout:30_000}, async t=>{
 const sources=new Map(),identities={};
 for(const name of ['diagnostic-memory','composition-observations','allocations','prompt-memory','model-memory']){
  const path='src/observability/'+name+'.ts',source=await readFile(path,'utf8');
  identities[path]=createHash('sha256').update(source).digest('hex');
  sources.set('/'+name+'.js',(await transformWithOxc(source,path)).code);
 }
 const browserPins=JSON.parse(await readFile('node_modules/playwright-core/browsers.json','utf8'));
 const pin=browserPins.browsers.find(entry=>entry.name==='chromium');assert(pin?.browserVersion);
 const requests=[],external=[],consoleErrors=[],pageErrors=[];
 const server=createServer((request,response)=>{
  requests.push({method:request.method,path:request.url});
  response.setHeader('Cache-Control','no-store');
  if(request.method==='DELETE'&&request.url==='/empty'){
   // The actual browser response to this native HTTP 204 is the regression:
   // Content-Length is absent, yet Chromium exposes a non-null empty stream.
   response.writeHead(204);response.end();return;
  }
  if(request.method==='GET'&&request.url==='/'){
   response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
   response.end('<!doctype html><title>Owned JSON native 204</title><link rel="icon" href="data:,">');return;
  }
  const source=sources.get(request.url);
  if(request.method==='GET'&&source!==undefined){response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});response.end(source);return;}
  if(request.url==='/favicon.ico'){response.writeHead(204);response.end();return;}
  response.writeHead(404);response.end();
 });
 let browser,context;
 // Always finish all three independent closes, even if an earlier close fails.
 t.after(async()=>{
  const failures=[];
  try{await context?.close();}catch(error){failures.push(error);}
  try{await browser?.close();}catch(error){failures.push(error);}
  try{if(server.listening)await new Promise((accept,reject)=>server.close(error=>error?reject(error):accept()));}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Owned JSON browser fixture shutdown failed');
 });
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
 const address=server.address();assert(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
 const executable=resolve(chromium.executablePath());
 browser=await chromium.launch({executablePath:executable,timeout:10_000});assert.equal(browser.version(),pin.browserVersion,'Use the Chromium bundled with pinned Playwright');
 context=await browser.newContext();await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}return route.continue();});
 const page=await context.newPage();page.setDefaultTimeout(10_000);page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});page.on('pageerror',error=>pageErrors.push(error.message));
 await page.goto(origin);
 const observations=await page.evaluate(async()=>{
  const {readOwnedJSON}=await import('/model-memory.js'),{allocationLedger}=await import('/allocations.js');
  const totals=()=>{const snapshot=allocationLedger.snapshot();return {cpuBytes:snapshot.cpuBytes,gpuBytes:snapshot.gpuBytes,previewCacheBytes:snapshot.previewCacheBytes,promptBytes:snapshot.promptBytes,handles:snapshot.handles,activeRecords:snapshot.activeRecords,unusedHandles:snapshot.unusedHandles,byKind:snapshot.byKind};};
  const rows=[];
  for(let cycle=0;cycle<3;cycle++){
   const before=totals();let response;
   const owned=await readOwnedJSON(async(path,init)=>{response=await fetch(path,init);return response;},'/empty',{owner:'native-204-browser',init:{method:'DELETE'},maxBytes:0,owns:()=>true});
   try{
    const afterRead=totals(),body=response.body;
    const native={status:response.status,contentLength:response.headers.get('content-length'),bodyPresent:body!==null,bodyUsed:response.bodyUsed,locked:body?.locked??null};
    let terminal=null;
    if(body){const reader=body.getReader();try{const result=await reader.read();terminal={done:result.done,hasValue:result.value!==undefined};}finally{reader.releaseLock();}}
    rows.push({cycle,before,afterRead,valueIsUndefined:owned.value===undefined,native,terminal,unlockedAfterProbe:body!==null&&!body.locked});
   }finally{owned.release();}
   rows.at(-1).afterRelease=totals();
  }
  return rows;
 });
 assert.equal(observations.length,3);
 for(const observed of observations){
  assert.equal(observed.valueIsUndefined,true);
  assert.deepEqual(observed.native,{status:204,contentLength:null,bodyPresent:true,bodyUsed:true,locked:false});
  assert.deepEqual(observed.terminal,{done:true,hasValue:false});assert.equal(observed.unlockedAfterProbe,true);
  const expectedRetained=structuredClone(observed.before);expectedRetained.handles++;expectedRetained.activeRecords++;expectedRetained.byKind.control.handles++;
  assert.deepEqual(observed.afterRead,expectedRetained,'Only the explicitly retained zero-byte model owner may survive the read');
  assert.deepEqual(observed.afterRelease,observed.before,'Native stream and returned model must drain to their exact allocation baseline');
 }
 assert.equal(requests.filter(request=>request.method==='DELETE'&&request.path==='/empty').length,3);assert.deepEqual(external,[]);assert.deepEqual(consoleErrors,[]);assert.deepEqual(pageErrors,[]);
 t.diagnostic(JSON.stringify({browser:browser.version(),revision:pin.revision,executable,sources:identities,observations,externalRequests:external,scope:'Native 204 stream lifecycle regression; not product or memory qualification'}));
});

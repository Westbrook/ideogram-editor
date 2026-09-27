import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ownedOPFS} from './owned-opfs.ts';
import {expectedResponseCancellation as accepted} from './text-zoom-cancellations.mjs';
const out=resolve(process.env.CANCELLATION_RECEIPT??'artifacts/p1c4/cancellation-controls');await mkdir(out,{mode:0o700});
const bytes=await readFile('vendor/text/fonts/NotoSans-Regular.ttf'),hash=createHash('sha256').update(bytes).digest('hex');
const log={start:new Date().toISOString(),requests:[],events:[],checks:[],cleanupErrors:[]};
const server=createServer((q,r)=>{
 if(q.url.startsWith('/assets/')){const truncated=q.url==='/assets/truncated.ttf';log.requests.push({path:q.url,declared:bytes.length,sent:truncated?1:bytes.length});r.writeHead(200,{'content-type':'font/ttf','content-length':bytes.length});if(truncated){r.write(bytes.subarray(0,1));r.on('close',()=>log.truncatedClosedBeforeEOF=!r.writableEnded);}else r.end(bytes);}
 else{r.writeHead(200,{'content-type':'text/html'});r.end('<!doctype html><title>Same browser request controls</title>');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch(),context=await browser.newContext(),guard=await ownedOPFS(context,'same-request-font-controls'),page=await context.newPage();
const ids=new WeakMap(),responses=new Map();let next=0;const id=q=>{if(!ids.has(q))ids.set(q,++next);return ids.get(q);};
const event=(q,channel)=>({channel,requestId:id(q),url:q.url(),method:q.method(),resourceType:q.resourceType(),failure:q.failure(),response:responses.get(q)});
context.on('response',r=>{const q=r.request(),h=r.headers();responses.set(q,{requestId:id(q),url:q.url(),method:q.method(),status:r.status(),contentType:h['content-type'],contentLength:h['content-length']});});
context.on('requestfailed',q=>log.events.push(event(q,'requestfailed')));context.on('requestfinished',q=>log.events.push(event(q,'requestfinished')));
try{
 await guard.admit(page,origin);await page.goto(origin);
 const completeResponse=page.waitForResponse(r=>r.url()===origin+'/assets/complete.ttf');
 log.complete=await page.evaluate(async()=>{const c=new AbortController(),r=await fetch('/assets/complete.ttf',{signal:c.signal}),b=await r.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');c.abort();return {status:r.status,bytes:b.byteLength,hash,bodyCompleted:true,abortAfterEOF:true};});
 const response=await completeResponse;assert.equal(await response.finished(),null);const q=response.request();log.completeRequest=event(q,'requestfinished');assert.equal(q.failure(),null);assert.equal(log.complete.bytes,bytes.length);assert.equal(log.complete.hash,hash);assert.equal(accepted(log.completeRequest,origin),false);log.checks.push('Full same browser response body matches pinned font and finishes without failure; abort after EOF creates no exception');
 const failure=page.waitForEvent('requestfailed',q=>q.url()===origin+'/assets/truncated.ttf');
 log.truncated=await page.evaluate(async()=>{const c=new AbortController(),r=await fetch('/assets/truncated.ttf',{signal:c.signal}),reader=r.body.getReader(),first=await reader.read();c.abort();try{await reader.read();return {unexpectedCompletion:true};}catch(e){return {status:r.status,received:first.value.length,done:first.done,error:e.name,bodyCompleted:false};}});
 log.truncatedRequest=event(await failure,'requestfailed');assert.equal(log.truncated.received,1);assert.equal(log.truncated.bodyCompleted,false);assert.equal(log.truncated.error,'AbortError');assert.equal(accepted(log.truncatedRequest,origin),false);log.checks.push('Same browser request abort after one byte remains unmatched');
 for(const edit of [e=>e.response.requestId++,e=>e.response.status=503,e=>e.response.url+='/wrong',e=>e.response.method='HEAD',e=>e.url='http://127.0.0.1:1/assets/truncated.ttf']){const e=structuredClone(log.truncatedRequest);edit(e);assert.equal(accepted(e,origin),false);}
 log.checks.push('Wrong same-request identity/status/path/method/origin never qualifies');
}catch(e){log.error={message:e.message,stack:e.stack};}finally{try{for(const p of context.pages())await p.goto('about:blank');await guard.cleanup();guard.verify();}catch(e){log.cleanupErrors.push(String(e));}log.ownership=guard.ledger;await context.close();await browser.close();await new Promise(r=>server.close(r));log.end=new Date().toISOString();await writeFile(resolve(out,'result.json'),JSON.stringify(log,null,2));console.log(JSON.stringify({checks:log.checks,error:log.error,cleanupErrors:log.cleanupErrors}));}
if(log.error||log.cleanupErrors.length)process.exitCode=1;

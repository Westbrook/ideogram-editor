import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium,firefox,webkit} from 'playwright';
import {transformWithOxc} from 'vite';
import {originalFontReader} from './original-font-reader.ts';
import {originalFontCompletion} from './integration-network.mjs';
import {ownedOPFS} from './owned-opfs.ts';
const out=resolve(process.env.EDITOR_RECEIPT),engine=process.env.EDITOR_BROWSER??'chromium';await mkdir(out,{recursive:true});
assert(globalThis.__storeNetworkCounters,'Run with the no-effects preload');
const bytes=await readFile('vendor/text/fonts/NotoSans-Regular.ttf'),sha=b=>createHash('sha256').update(b).digest('hex'),source=await readFile('src/text/contracts.ts','utf8'),module=(await transformWithOxc(source,'contracts.ts')).code;
const names=['full','truncated','corrupt','early','validation','status','concurrent','other'],fonts=names.map(n=>({path:'/assets/'+n+'.ttf',bytes:bytes.length,sha256:sha(bytes)}));
const log={started:new Date().toISOString(),engine,sourceSHA256:sha(source),moduleSHA256:sha(module),events:[],outcomes:[],checks:[],errors:[],http:[]};
const server=createServer((q,r)=>{
 const name=q.url.match(/^\/assets\/([a-z]+)\.ttf$/)?.[1];
 if(name){const payload=name==='corrupt'?Buffer.from(bytes):bytes;if(name==='corrupt')payload[100]^=1;log.http.push({name,declared:bytes.length,payloadSHA256:sha(payload)});r.writeHead(name==='status'?503:200,{'Content-Type':'font/ttf','Content-Length':bytes.length,'Cache-Control':'no-store'});
  if(name==='early'){r.write(payload.subarray(0,1));r.on('close',()=>log.http.push({name,closedBeforeEOF:!r.writableEnded}));}
  else if(name==='truncated'){r.write(payload.subarray(0,1));setTimeout(()=>r.destroy(),25);}
  else if(name==='concurrent')setTimeout(()=>r.end(payload),50);
  else r.end(payload);
 }else if(q.url==='/contracts.js'){r.writeHead(200,{'Content-Type':'text/javascript'});r.end(module);}
 else{r.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});r.end('<!doctype html><title>Original font reader controls</title>');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browserType={chromium,firefox,webkit}[engine],context=await browserType.launchPersistentContext(resolve(process.env.TMPDIR,'font-controls-'+engine+'-'+Date.now()),{headless:true,executablePath:browserType.executablePath(),env:{...process.env,TMPDIR:process.env.TMPDIR}});log.browser={version:context.browser()?.version(),executable:browserType.executablePath(),executableSHA256:sha(await readFile(browserType.executablePath()))};
await Promise.all(context.pages().map(p=>p.close()));const page=await context.newPage();
let sequence=0;const ids=new WeakMap(),responses=new WeakMap(),id=r=>{if(!ids.has(r))ids.set(r,++sequence);return ids.get(r);};
const observer=await originalFontReader(context,out,fonts,id),guard=await ownedOPFS(context,'p1c6-font-controls-'+engine);
context.on('response',r=>{const q=r.request(),h=r.headers(),e={channel:'response',requestId:id(q),url:q.url(),method:q.method(),status:r.status(),contentType:h['content-type'],contentLength:h['content-length']};responses.set(q,e);log.events.push(e);});
context.on('requestfailed',q=>log.events.push({channel:'requestfailed',requestId:id(q),url:q.url(),method:q.method(),resourceType:q.resourceType(),failure:q.failure(),response:responses.get(q)}));
context.on('requestfinished',q=>log.events.push({channel:'requestfinished',requestId:id(q),url:q.url()}));
const instrument=p=>{p.on('pageerror',e=>log.errors.push({channel:'pageerror',message:e.message}));p.on('console',m=>{if(m.type()==='error')log.events.push({channel:'console',message:m.text(),url:m.location().url});});};context.on('page',instrument);for(const p of context.pages())instrument(p);context.on('request',r=>{if(new URL(r.url()).origin!==origin)log.errors.push({channel:'unexpected-origin',url:r.url()});});
const read=async(name,expected=bytes.length)=>page.evaluate(async({name,expected,hash})=>{
 const {readSealedAsset,hashBytes}=await import('/contracts.js');try{const b=await readSealedAsset(new URL('/assets/'+name+'.ttf',location.href),expected),actual=await hashBytes(b);if(actual!=='sha256:'+hash)throw Error('FONT_HASH');return {name,accepted:true,bytes:b.size,hash:actual};}catch(e){return {name,accepted:false,error:e.message,errorName:e.name};}
},{name,expected,hash:sha(bytes)});
try{
 await guard.admit(page,origin);await page.goto(origin);
 const full=await read('full');assert.equal(full.accepted,true);log.outcomes.push(full);
 for(const name of ['truncated','corrupt','validation','status']){const value=await read(name,name==='validation'?bytes.length+1:bytes.length);assert.equal(value.accepted,false);log.outcomes.push(value);}
 await page.evaluate(async({size,hash})=>{const {readSealedAsset,hashBytes}=await import('/contracts.js');window.controlAbort=new AbortController();window.controlRead=readSealedAsset(new URL('/assets/early.ttf',location.href),size,window.controlAbort.signal).then(async b=>({accepted:await hashBytes(b)==='sha256:'+hash}),e=>({accepted:false,error:e.message,errorName:e.name}));},{size:bytes.length,hash:sha(bytes)});
 const deadline=Date.now()+10000;while(!observer.events.some(e=>e.kind==='chunk'&&e.url===origin+'/assets/early.ttf'&&e.count===1)){assert(Date.now()<deadline,'Original one-byte consumption was not observed');await new Promise(r=>setTimeout(r,10));}
 await page.evaluate(()=>window.controlAbort.abort());const early=await page.evaluate(()=>window.controlRead);assert.equal(early.accepted,false);log.outcomes.push({name:'early',...early});
 // A new complete GET cannot repair the earlier incomplete original request.
 const separate=await read('other');assert.equal(separate.accepted,true);log.outcomes.push(separate);
 const concurrent=await Promise.all([read('concurrent'),read('concurrent')]);assert(concurrent.every(x=>x.accepted));log.outcomes.push(...concurrent);
 const second=await context.newPage();await second.goto(origin);await second.evaluate(async size=>{const {readSealedAsset}=await import('/contracts.js');await readSealedAsset(new URL('/assets/other.ttf',location.href),size);},bytes.length);
 await observer.flush();const proofs=await observer.seal(()=>null);log.proofs=proofs;
 const complete=proofs.find(p=>p.url.endsWith('/full.ttf'));assert(complete?.normalEOF);assert.equal(complete.sha256,sha(bytes));assert.equal(complete.bytes,bytes.length);
 assert.equal(complete.applicationValidated,false,'Direct reader control is not an application ImportFont receipt');
 const eventFor=p=>({requestId:p.requestId,url:p.url,method:'GET',response:{status:200,contentType:'font/ttf',contentLength:String(bytes.length)}});
 assert.equal(originalFontCompletion(complete,eventFor(complete)),false);
 // Predicate controls deliberately supply synthetic validation, labelled here;
 // real integrated runs require their actual durable ImportFont receipt.
 const validated={...complete,applicationValidated:true,validation:{commandId:'synthetic-control',sessionId:'control',clientId:'control',documentId:'control',source:{hash:'sha256:'+complete.sha256,byteLength:String(complete.bytes)},receipt:{status:'accepted',commandId:'synthetic-control'}}};assert.equal(originalFontCompletion(validated,eventFor(complete)),true);
 const bad=proofs.find(p=>p.url.endsWith('/corrupt.ttf'));assert(bad);assert.equal(originalFontCompletion({...bad,applicationValidated:true,validation:validated.validation},eventFor(bad)),false);
 assert(!proofs.some(p=>/\/(truncated|early|validation|status)\.ttf$/.test(p.url)));
 for(const p of proofs.filter(p=>p.url.endsWith('/concurrent.ttf'))){assert(p.concurrentOperations.length>0||p.eligibleRequests.length!==1);assert.equal(originalFontCompletion({...p,applicationValidated:true,validation:validated.validation},eventFor(p)),false);}
 const earlyEvent=log.events.find(e=>e.channel==='requestfailed'&&e.url.endsWith('/early.ttf'));assert(earlyEvent);assert.equal(originalFontCompletion(validated,earlyEvent),false);
 for(const mutate of [p=>p.requestId++,p=>p.eligibleRequests=[],p=>p.eligibleRequests.push(999),p=>p.concurrentOperations.push(999),p=>p.requestFrame++,p=>p.document='',p=>p.responseStatus=503,p=>p.status=503,p=>p.responseURL+='x',p=>p.browserResponseURL+='x',p=>p.redirected=true,p=>p.fromServiceWorker=true,p=>p.cacheControl='public',p=>p.normalEOF=false,p=>p.failed=true,p=>p.cancelledBeforeEOF=true,p=>p.truncatedObservation=true,p=>p.cloned=true,p=>p.teed=true,p=>p.readers++,p=>p.count--,p=>p.sha256='0'.repeat(64),p=>p.font.path+='/other',p=>p.requestStart=p.start-100,p=>p.applicationValidated=false]){const p=structuredClone(validated);mutate(p);assert.equal(originalFontCompletion(p,eventFor(complete)),false);}
 const otherFrame=proofs.find(p=>p.frameId!==complete.frameId);assert(otherFrame);assert.equal(originalFontCompletion({...validated,requestFrame:otherFrame.frameId},eventFor(complete)),false);
 log.checks.push('Exact original complete bytes and EOF observed; direct control does not claim application validation','Actual truncated, corrupt, early-cancel, header-validation and503 paths fail','Actual concurrent/context and missing/wrong body/request/status identities fail closed','Original one-byte abort plus separate complete GET remains rejected','Synthetic predicate validation is confined to negative-control testing');
}catch(e){log.errors.push({message:e.message,stack:e.stack});}finally{
 try{await observer.flush();for(const p of context.pages())await p.goto('about:blank');assert.equal(context.serviceWorkers().length,0);await guard.cleanup();guard.verify();}catch(e){log.errors.push({phase:'cleanup',message:String(e)});}
 for(const e of log.events.filter(e=>e.channel==='console')){const status=e.url===origin+'/assets/status.ttf'&&/^Failed to load resource: the server responded with a status of 503/.test(e.message);const truncated=engine==='chromium'&&e.url===origin+'/assets/truncated.ttf'&&e.message==='Failed to load resource: net::ERR_CONTENT_LENGTH_MISMATCH'&&log.events.some(r=>r.channel==='requestfailed'&&r.url===e.url&&r.failure?.errorText==='net::ERR_CONTENT_LENGTH_MISMATCH');if(!status&&!truncated)log.errors.push(e);}
 log.ownership=guard.ledger;log.effects=globalThis.__storeNetworkCounters.read();assert.equal(Object.keys(log.effects).length,8);assert(Object.values(log.effects).every(x=>x===0));await context.close();await new Promise(r=>server.close(r));log.ended=new Date().toISOString();await writeFile(out+'/result.json',JSON.stringify(log,null,2));console.log(JSON.stringify({checks:log.checks,error:log.errors}));
}
if(log.errors.length)process.exitCode=1;

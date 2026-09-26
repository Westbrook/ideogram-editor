import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
import {Worker} from 'node:worker_threads';
import {chromium} from '@playwright/test';
import {isolated} from './helpers.mjs';
const out=resolve(process.argv[2]);await mkdir(out);const profile=JSON.parse(await readFile('src/text/profile.json'));
const cases=[{name:'plain',text:'AB'},{name:'nfd',text:'e\u0301'},{name:'leading-bom',text:'\ufeffAB'},{name:'rtl',text:'مرحبا ABC 123',fonts:['NotoSans','NotoSansArabic']},{name:'combining-ligature',text:'office A\u0301'},{name:'supplementary',text:'🂡',fonts:['NotoSansSymbols2']},{name:'cjk',text:'中文',fonts:['NotoSansCJKsc']},{name:'mixed-cjk',text:'مرحبا ABC 123\n中文日本語',fonts:['NotoSans','NotoSansArabic','NotoSansCJKsc']},{name:'empty',text:''},{name:'clipped',text:'AB\nCD',frame:{width:35.5,height:20.5}},{name:'alpha',text:'AB',fill:[40,90,190,128]}];
const summary={profile:profile.id,cases:[],workers:0,closed:0,resets:0,backendWorkers:0,backendExited:0};const save=()=>writeFile(join(out,'results.json'),JSON.stringify(summary,null,2));
const after=[],f=await isolated({after:fn=>after.push(fn)}),browser=await chromium.launch();let context;
try{for(const item of cases){context=await browser.newContext();const page=await context.newPage(),closes=[];page.on('worker',w=>{summary.workers++;closes.push(new Promise(r=>w.once('close',()=>{summary.closed++;r();})));});await page.goto(f.server.origin);await page.waitForFunction(()=>!!window.textFixture);
 const observed=await page.evaluate(async item=>{const f=window.textFixture,q=await f.request(item.text,item.fonts??['NotoSans'],{frame:item.frame??{width:120,height:70}});if(item.fill)q.style={...q.style,fill:item.fill};const plan=f.planText(q),p=await f.renderer.prepare(q);window.proof={q,p};const total=q.fonts.reduce((n,f)=>n+f.bytes.size,0);const expected={layout:await p.layout.text(),layoutHash:p.layoutHash,rasterHash:p.rasterHash,textHash:p.textHash,width:p.width,height:p.height,overflow:p.overflow};f.renderer.dispose();return {request:{...q,fonts:undefined},expected,total,plan,remaining:f.textMemory.snapshot.textBytes,startup:f.engineReservationBytes,resident:f.engineResidentBytes};},item);
 await Promise.race([Promise.all(closes),new Promise((_,j)=>setTimeout(()=>j(Error('Worker close unobserved')),10000).unref())]);
 // Backend receives descriptors only; browser-owned font/output bytes stay
 // charged independently. The shared plan books every backend copy phase.
 const budget=verificationBudget(item.text,observed.request.frame.width,observed.request.frame.height,observed.total,profile.engine.wasm.bytes);
 const requestBytes=budget.request;
 const peak=observed.remaining+budget.bytes;
 const admission={remainingBrowser:observed.remaining,backendStartup:observed.startup,backendResident:observed.resident,requestBytes,comparisonScratch:2*observed.plan.layout+2*1024**2,peak,limit:128*1024**2};
 const guard=(browserBytes)=>{const combined=peak-observed.remaining+browserBytes;if(combined>admission.limit||process.memoryUsage().rss+combined>512*1024**2)throw Error('TEXT_VERIFICATION_CAPACITY');};
 const beforeWorkers=summary.backendWorkers;assert.throws(()=>guard(admission.limit),/TEXT_VERIFICATION_CAPACITY/);assert.equal(summary.backendWorkers,beforeWorkers);admission.excessOwnershipRefusedBeforeWorker=true;guard(observed.remaining);
 const fonts=(item.fonts??['NotoSans']).map(id=>{const f=profile.fonts.find(f=>f.id===id);return {path:resolve('vendor/text',f.file),hash:'sha256:'+f.sha256,length:f.bytes,licenseHash:f.licenseHash,origin:'bundled'};});
 let result,error;const worker=new Worker(new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url),{workerData:{request:observed.request,fonts,profile:profile.id},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});summary.backendWorkers++;
 await new Promise((res,rej)=>{const timer=setTimeout(()=>{error=Error('Verifier deadline');void worker.terminate();},20000);worker.on('message',m=>{if(m.type==='ready')worker.postMessage({type:'admit'});else if(m.type==='result')result=m;else error=Error(JSON.stringify(m));});worker.on('error',e=>error=e);worker.on('exit',()=>{clearTimeout(timer);summary.backendExited++;error?rej(error):res();});});
 const row={name:item.name,admission,browser:observed.expected,backend:result};summary.cases.push(row);await save();assert(result);
 for(const key of ['layout','layoutHash','rasterHash','textHash','width','height','overflow'])assert.deepEqual(result[key],observed.expected[key],item.name+' '+key);
 await page.evaluate(()=>{window.textFixture.releasePrepared(window.proof.p);delete window.proof;});await context.close();context=null;}
 summary.complete=true;assert.equal(summary.workers,summary.closed);assert.equal(summary.backendWorkers,summary.backendExited);
}catch(e){summary.failure={message:e.message,stack:e.stack};throw e;}finally{await save();if(context)await context.close();await browser.close();await f.server.close();for(const fn of after.reverse())await fn();}
console.log(JSON.stringify({...summary,cases:summary.cases.map(({name,admission})=>({name,admission}))},null,2));
